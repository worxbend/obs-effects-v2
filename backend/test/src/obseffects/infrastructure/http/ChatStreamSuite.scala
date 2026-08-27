package obseffects.infrastructure.http

import munit.FunSuite
import obseffects.domain.{TwitchConnectionState, TwitchConnectionStatus}

/** Covers the status-diffing rule of the chat WebSocket loop: which status changes deserve a status frame. */
class ChatStreamSuite extends FunSuite {

  private val connected = TwitchConnectionStatus(TwitchConnectionState.ConnectedAuthed, None, 7L, Some("worxbend"))

  test("a bumped message counter alone is not a status change — otherwise every chat message would emit a frame") {
    assert(!ChatStream.statusChanged(connected, connected.copy(messagesReceived = connected.messagesReceived + 1)))
  }

  test("a state, error, or channel change is reported even when the counter moved too") {
    val failed = connected.copy(
      state = TwitchConnectionState.Failed,
      lastError = Some("auth expired"),
      messagesReceived = connected.messagesReceived + 1
    )
    assert(ChatStream.statusChanged(connected, failed), "state and error change")
    assert(ChatStream.statusChanged(connected, connected.copy(channel = Some("other"))), "channel change")
  }
}
