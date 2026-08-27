package obseffects.infrastructure.http

import io.circe.syntax.*
import obseffects.application.{RouteEvent, RouteEventBus, RouteService, RouteSubscription}
import obseffects.domain.{RouteConfig, Slug}
import obseffects.infrastructure.http.Wire.given
import ox.flow.{Flow, FlowEmit}
import sttp.model.sse.ServerSentEvent

import java.time.Clock

import scala.concurrent.duration.{DurationInt, FiniteDuration}

object RouteEventStream {

  /** How long a healthy stream may stay silent, from `docs/CONTRACT.md` §4.
    *
    * Idle-connection timeouts in proxies are commonly 30 to 60 seconds, so twenty gives two chances to be wrong before
    * anything is cut. The renderer page's watchdog counts these: it gives up on the stream after 45 seconds of silence,
    * which is a little over two intervals, so one lost heartbeat is not enough to trip it.
    */
  val HeartbeatInterval: FiniteDuration = 20.seconds

  /** The `retry:` value sent with the first event: how long the browser waits before reconnecting after a dropped
    * connection. Sending it once is enough — `EventSource` remembers it for the life of the page.
    */
  val ReconnectDelayMillis = 3000

  /** The three event names of the contract. They are the strings the frontend listens for, so they are constants here
    * rather than literals sprinkled through the code below.
    */
  val ConfigEventName = "config"
  val AbsentEventName = "absent"
  val HeartbeatEventName = "heartbeat"
}

/** Turns "what is happening to this slug" into the stream of text an `EventSource` in a browser reads.
  *
  * ==What Server-Sent Events are, and why they are used here==
  *
  * A Server-Sent Events (SSE) response is one ordinary HTTP response that never ends: the server writes small blocks of
  * text down it as things happen, and the browser's built-in `EventSource` object hands each block to the page.
  * WebSockets would also work, but the traffic here only ever goes one way — the server tells the browser source what
  * to draw, and the browser source has nothing to say back — and SSE is plain HTTP, so proxies need no configuring and
  * the browser reconnects on its own.
  *
  * ==How this runs, given that every request is a virtual thread==
  *
  * Tapir's netty-sync backend takes an `ox.flow.Flow[ServerSentEvent]` as a response body and drains it on a Java 21
  * virtual thread. `Flow.usingEmit` lets that be written as an ordinary blocking loop: wait for the next event, write
  * it, repeat. Blocking is the right thing to do here rather than something to apologise for — a parked virtual thread
  * costs a few hundred bytes and no operating-system thread at all, so a hundred idle browser sources cost about as
  * much as a hundred idle map entries.
  *
  * The loop never decides to stop. It ends when the client disconnects: Tapir cancels the fork running the flow, which
  * interrupts this thread while it is waiting on the queue, and the `finally` below deregisters the subscriber. That is
  * the *only* way a subscriber is removed, which is why it is a `finally` and not a line at the end of the loop — a
  * browser source reconnects for hours, and one leaked queue per reconnection would eventually be every queue.
  *
  * ==The one race, and why it is resolved this way==
  *
  * Between reading the current route and starting to listen there is a moment where a change could be missed. The order
  * below is therefore: subscribe first, *then* read. That can deliver the same configuration twice — once as the
  * opening snapshot and once from the queue — and a duplicate is harmless, because each event carries the complete
  * configuration and the renderer redraws from whatever arrived last. The other order would lose an update instead,
  * which is not harmless: the OBS source would keep drawing the old thing until something else changed.
  *
  * @param clock
  *   the source of the heartbeat timestamps, injected for the same reason every other clock in this codebase is.
  */
class RouteEventStream(routes: RouteService, events: RouteEventBus, clock: Clock) {

  /** Opens a stream for one slug.
    *
    * The slug arrives as a raw `String` and may not even be a well-formed slug. That is not an error: the contract
    * answers `200` and an `absent` event for an unknown *or* unusable slug, because `EventSource` gives up permanently
    * on an HTTP error status, so a `404` would leave a browser source pointed at a not-yet-created slug blank until
    * somebody reloaded it by hand inside OBS. An unusable slug is simply one that no route can ever have, so this
    * registers no subscriber for it and sends heartbeats forever.
    */
  def open(rawSlug: String): Flow[ServerSentEvent] = Flow.usingEmit { emit =>
    val subscription: Option[RouteSubscription] = Slug.parse(rawSlug).toOption.map(events.subscribe)

    try {
      emit(opening(rawSlug))
      forward(emit, subscription)
    } catch {
      // The client went away and Tapir cancelled the fork this loop is running on, which arrives
      // as an interrupt. That is the normal end of an event stream, not a failure, so it is caught
      // here rather than left to travel up and be logged as one. The flag is restored because this
      // thread does not belong to us and something further up may still want to see it.
      case _: InterruptedException => Thread.currentThread().interrupt()
    } finally subscription.foreach(_.close())
  }

  // -------------------------------------------------------------------------------------------

  /** The first event on a new connection: the whole current state, plus the reconnection hint. */
  private def opening(rawSlug: String): ServerSentEvent = {
    val snapshot = routes.findBySlug(rawSlug) match {
      case Some(route) => configEvent(route)
      case None        => absentEvent(rawSlug)
    }
    snapshot.copy(retry = Some(RouteEventStream.ReconnectDelayMillis))
  }

  /** The loop: one queued event, or a heartbeat when the wait ran out. Runs until interrupted. */
  private def forward(emit: FlowEmit[ServerSentEvent], subscription: Option[RouteSubscription]): Unit =
    while (true) {
      subscription match {
        case Some(subscriber) =>
          emit(subscriber.next(RouteEventStream.HeartbeatInterval).map(toSse).getOrElse(heartbeatEvent()))

        // No subscriber, because the slug could never belong to a route. Nothing will ever arrive,
        // so the only thing left to do is keep the connection warm.
        case None =>
          Thread.sleep(RouteEventStream.HeartbeatInterval.toMillis)
          emit(heartbeatEvent())
      }
    }

  private def toSse(event: RouteEvent): ServerSentEvent = event match {
    case RouteEvent.Configured(route) => configEvent(route)
    case RouteEvent.Absent(slug)      => absentEvent(slug.value)
  }

  private def configEvent(route: RouteConfig): ServerSentEvent =
    named(RouteEventStream.ConfigEventName, Wire.toDto(route).asJson.noSpaces)

  private def absentEvent(slug: String): ServerSentEvent =
    named(RouteEventStream.AbsentEventName, io.circe.Json.obj("slug" -> slug.asJson).noSpaces)

  /** The keep-alive.
    *
    * It is a *named event with a payload* rather than an SSE comment (`: ping`), for two reasons that both come from
    * the libraries involved. `sttp.model.ServerSentEvent` can write `data:`, `event:`, `id:` and `retry:` lines and
    * nothing else, so a comment is not expressible; and the SSE specification says an event with no `data:` line is
    * never dispatched to the page, so a data-less event would keep the connection warm without the browser ever knowing
    * it arrived. A visible heartbeat is what the renderer's 45-second watchdog counts.
    */
  private def heartbeatEvent(): ServerSentEvent =
    named(
      RouteEventStream.HeartbeatEventName,
      io.circe.Json.obj("at" -> Wire.formatInstant(clock.instant()).asJson).noSpaces
    )

  /** `data` is written with `noSpaces`, so it is always one line. A newline inside a `data:` field would be read as the
    * start of a second data line by the browser, and the JSON would arrive split in half.
    */
  private def named(eventName: String, data: String): ServerSentEvent =
    ServerSentEvent(data = Some(data), eventType = Some(eventName), id = None, retry = None)
}
