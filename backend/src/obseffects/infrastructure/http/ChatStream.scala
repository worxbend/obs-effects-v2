package obseffects.infrastructure.http

import io.circe.Json
import io.circe.syntax.*
import obseffects.application.ChatBus
import obseffects.domain.{ChatMessage, TwitchConnectionStatus}
import obseffects.infrastructure.http.Wire.given
import ox.flow.Flow
import sttp.tapir.server.netty.sync.OxStreams

import java.time.Clock

import scala.concurrent.duration.{DurationInt, FiniteDuration}

object ChatStream {

  /** How long the stream may stay silent before a heartbeat frame is sent. Five seconds, like the audio stream's, and
    * for the same reason: short enough that the frontend's staleness watchdog can tell "quiet chat" from "dead
    * connection" quickly.
    */
  val HeartbeatInterval: FiniteDuration = 5.seconds

  /** How long one wait on the subscriber queue lasts. Shorter than the heartbeat so the loop wakes often enough to
    * notice a status change within a second, even when no messages are flowing — status frames are how the settings
    * page's live preview shows "connected" flipping to "failed".
    */
  val PollInterval: FiniteDuration = 1.second

  /** The `type` values of the four frames, as the frontend matches on them. */
  val SnapshotFrameType = "snapshot"
  val MessageFrameType = "message"
  val HeartbeatFrameType = "heartbeat"
  val StatusFrameType = "status"

  /** Whether a status change deserves a status frame. `messagesReceived` is deliberately left out of the comparison:
    * the supervisor increments that counter for every delivered chat message, so comparing whole
    * `TwitchConnectionStatus` values would make every message-bearing wake-up look like a state change and send a
    * status frame alongside each message frame — doubling the WebSocket traffic to every connected overlay during busy
    * chat. Only the fields the frontend actually reacts to (state, error, channel) trigger a frame.
    */
  private[http] def statusChanged(last: TwitchConnectionStatus, current: TwitchConnectionStatus): Boolean =
    current.copy(messagesReceived = last.messagesReceived) != last
}

/** Turns the chat bus into the WebSocket stream every chat overlay reads: `GET /api/chat/ws`.
  *
  * ==Why a WebSocket here, when everything else in this API streams over Server-Sent Events==
  *
  * No deep reason forced it — chat is server-to-client like the other streams — but a WebSocket is what the design
  * calls for and it costs nothing extra: tapir's netty-sync backend serves one from an ordinary blocking pipe, and the
  * frontend SDK owns its own reconnect-with-backoff either way (unlike `EventSource`, a raw WebSocket does not
  * reconnect itself, which is the one practical difference worth knowing).
  *
  * ==The framing==
  *
  * Every frame is one JSON object with a `type` field:
  *
  *   - `snapshot` — first frame on every connection: the last 50 messages, oldest first, so an overlay draws a full
  *     conversation instantly instead of filling from silence.
  *   - `status` — the connection state, sent right after the snapshot and again whenever it changes.
  *   - `message` — one live chat event.
  *   - `heartbeat` — sent after five seconds with no other frame, carrying the server's clock, so the page can tell a
  *     quiet chat from a dead pipe.
  *
  * ==How the pipe runs==
  *
  * The handler is an `OxStreams.Pipe`: incoming frames in, outgoing frames out. The incoming flow is *drained* rather
  * than ignored — the client has nothing to say, but its frames still have to be consumed or WebSocket flow control
  * fills up — and merged with `propagateDoneLeft = true`, so the moment the client closes, the merged flow ends, the
  * emitting fork is cancelled, and the `finally` below deregisters the subscriber. That cancellation arrives as an
  * interrupt while the loop waits on the queue, exactly like the SSE streams.
  *
  * ==The non-failure guarantee==
  *
  * This endpoint never refuses a connection. Chat disabled, no channel, Twitch unreachable — the stream still opens and
  * serves an empty snapshot, a status frame saying why, and heartbeats. An overlay pointed at an unconfigured server
  * idles gracefully on its simulated feed instead of erroring, which is the contract every public stream in this API
  * keeps.
  */
final class ChatStream(bus: ChatBus, clock: Clock) {

  /** One connection's pipe. Everything stateful lives inside the flow, so the same `ChatStream` serves any number of
    * simultaneous connections.
    */
  def open(): OxStreams.Pipe[String, String] = incoming => incoming.drain().merge(outgoing(), propagateDoneLeft = true)

  // -------------------------------------------------------------------------------------------

  /** The server-to-client half: snapshot, then the live loop. Runs on a virtual thread for as long as the client is
    * connected.
    */
  private def outgoing(): Flow[String] = Flow.usingEmit { emit =>
    val subscription = bus.subscribe()

    try {
      emit(snapshotFrame(bus.recent))
      var lastStatus = bus.currentStatus
      emit(statusFrame(lastStatus))
      var lastFrameAt = clock.millis()

      while (true) {
        val message = subscription.next(ChatStream.PollInterval)

        // Status is checked on every wake-up, not only on idle ones, so a state change is reported within about a
        // second even while messages are flowing.
        val status = bus.currentStatus
        if (ChatStream.statusChanged(lastStatus, status)) {
          emit(statusFrame(status))
          lastStatus = status
          lastFrameAt = clock.millis()
        }

        message match {
          case Some(value) =>
            emit(messageFrame(value))
            lastFrameAt = clock.millis()
          case None =>
            if (clock.millis() - lastFrameAt >= ChatStream.HeartbeatInterval.toMillis) {
              emit(heartbeatFrame())
              lastFrameAt = clock.millis()
            }
        }
      }
    } catch {
      // The client went away and the merged flow's cancellation arrived as an interrupt. The normal end of a stream,
      // not a failure — same reasoning and same flag restoration as the SSE streams.
      case _: InterruptedException => Thread.currentThread().interrupt()
    } finally subscription.close()
  }

  private def snapshotFrame(messages: List[ChatMessage]): String =
    Json
      .obj(
        "type" -> ChatStream.SnapshotFrameType.asJson,
        "messages" -> messages.map(Wire.toDto).asJson
      )
      .noSpaces

  private def messageFrame(message: ChatMessage): String =
    Json
      .obj(
        "type" -> ChatStream.MessageFrameType.asJson,
        "message" -> Wire.toDto(message).asJson
      )
      .noSpaces

  private def statusFrame(status: TwitchConnectionStatus): String =
    Json
      .obj(
        "type" -> ChatStream.StatusFrameType.asJson,
        "status" -> Wire.toDto(status, bus.subscriberCount).asJson
      )
      .noSpaces

  /** A heartbeat carries the current time so a page can tell how stale its picture of the world is. */
  private def heartbeatFrame(): String =
    Json
      .obj(
        "type" -> ChatStream.HeartbeatFrameType.asJson,
        "at" -> clock.millis().asJson
      )
      .noSpaces
}
