package obseffects.infrastructure.http

import io.circe.syntax.*
import obseffects.application.{AudioLevelBus, AudioLevelSubscription}
import obseffects.domain.AudioLevels
import obseffects.infrastructure.http.Wire.given
import ox.flow.{Flow, FlowEmit}
import sttp.model.sse.ServerSentEvent

import java.time.Clock

import scala.concurrent.duration.{DurationInt, FiniteDuration}

object AudioLevelStream {

  /** How long a silent stream may stay silent before a heartbeat is sent.
    *
    * Much shorter than the route stream's twenty seconds, because this stream has a very different resting state. A
    * route stream is normally silent — configuration rarely changes — whereas this one normally delivers twenty
    * messages a second, and only goes quiet when OBS is disconnected or paused. Five seconds is long enough that a
    * connected stream never sends a heartbeat at all (a level always arrives first), and short enough that a browser
    * source can tell "OBS is silent" from "this connection is dead" quickly.
    */
  val HeartbeatInterval: FiniteDuration = 5.seconds

  /** How long the browser waits before reconnecting a dropped stream, in milliseconds. */
  val ReconnectDelayMillis = 3000

  /** The event names. `levels` carries a measurement; `heartbeat` carries nothing but proves the pipe is open. */
  val LevelsEventName = "levels"
  val HeartbeatEventName = "heartbeat"
}

/** Turns the audio level bus into the Server-Sent Events stream that every audio-reactive browser source reads.
  *
  * ==Why this endpoint is public==
  *
  * It sits next to `GET /api/routes/by-slug/{slug}/events` in the contract and is public for exactly the same reason:
  * an OBS browser source cannot sign in. What makes that safe here is what the stream does *not* carry — it carries
  * loudness numbers and input names, never the obs-websocket URL and never the password. Those stay on the server,
  * which was the whole reason for putting the WebSocket client in the backend rather than in the page.
  *
  * ==Why it is one stream for the whole page rather than one per route==
  *
  * Audio is a property of the machine, not of a slug. Two browser sources showing two different effects want the same
  * numbers, so there is no slug in this path at all. That also means the backend does exactly one thing per measurement
  * — write it once to each open connection — regardless of how many scenes are configured.
  *
  * ==The pacing decision==
  *
  * OBS sends meters about twenty times a second, and every one of them is forwarded. It is worth being explicit that
  * this is *not* throttled, because the instinct is to throttle it: at twenty small JSON objects a second per browser
  * source, a busy scene collection with six audio-reactive sources costs about 120 writes a second of a few hundred
  * bytes each. That is nothing, and the alternative — coalescing on a timer — would add latency to the one signal in
  * the whole system where latency is visible as an overlay lagging behind a beat.
  *
  * A consumer that cannot keep up is not helped by throttling anyway: `AudioLevelBus` already keeps only the newest
  * value per subscriber, so a stalled browser source silently skips frames and resumes at the present.
  */
final class AudioLevelStream(bus: AudioLevelBus, clock: Clock) {

  /** Opens a stream. Runs on a virtual thread for as long as the browser source is connected. */
  def open(): Flow[ServerSentEvent] = Flow.usingEmit { emit =>
    val subscription = bus.subscribe()

    try {
      emit(opening())
      forward(emit, subscription)
    } catch {
      // The client went away and Tapir cancelled the fork running this flow. Normal, not a failure — the same
      // reasoning, and the same interrupt-flag restoration, as `RouteEventStream`.
      case _: InterruptedException => Thread.currentThread().interrupt()
    } finally subscription.close()
  }

  // -------------------------------------------------------------------------------------------

  /** The first event on a new connection.
    *
    * It sends the last measurement the bus saw rather than waiting for the next one. With OBS connected the wait would
    * only be 50 milliseconds, so this is not about speed — it is about the disconnected case, where waiting means an
    * effect sits at silence for five seconds until the first heartbeat tells it anything at all. Sending the known
    * state immediately means the browser's fallback to a simulated signal happens at once.
    */
  private def opening(): ServerSentEvent =
    levelsEvent(bus.latest.getOrElse(AudioLevels.silent(clock.millis())))
      .copy(retry = Some(AudioLevelStream.ReconnectDelayMillis))

  /** The loop: forward each measurement, or send a heartbeat when nothing arrived. Runs until interrupted. */
  private def forward(emit: FlowEmit[ServerSentEvent], subscription: AudioLevelSubscription): Unit =
    while (true) {
      emit(
        subscription
          .next(AudioLevelStream.HeartbeatInterval)
          .map(levelsEvent)
          .getOrElse(heartbeatEvent())
      )
    }

  private def levelsEvent(levels: AudioLevels): ServerSentEvent =
    ServerSentEvent(
      data = Some(Wire.toDto(levels).asJson.noSpaces),
      eventType = Some(AudioLevelStream.LevelsEventName)
    )

  /** A heartbeat carries the current time so a page can tell how stale its picture of the world is. */
  private def heartbeatEvent(): ServerSentEvent =
    ServerSentEvent(
      data = Some(clock.millis().toString),
      eventType = Some(AudioLevelStream.HeartbeatEventName)
    )
}
