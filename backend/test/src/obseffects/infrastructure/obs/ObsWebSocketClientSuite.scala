package obseffects.infrastructure.obs

import munit.FunSuite

import java.net.http.WebSocket

/** Tests for the pure parts of the obs-websocket protocol: the authentication string, the level clamp, and the two
  * places a failure is turned into words an operator can act on.
  *
  * The connection itself is not tested here — that would mean standing up a WebSocket server, and what would be proved
  * is mostly that `java.net.http` works. What *is* worth pinning down is the handshake arithmetic, because it is the
  * one piece of this file that is silently wrong rather than loudly wrong: get the hashing order backwards and the
  * client connects, authenticates, is refused, and reports "the connection was closed by OBS", which sends whoever is
  * debugging it straight to the password field.
  */
class ObsWebSocketClientSuite extends FunSuite {

  test("the authentication string matches the scheme obs-websocket documents") {
    /*
     * The scheme: base64(sha256(password + salt)), then base64(sha256(that + challenge)).
     *
     * The expected value below was produced by a separate implementation of that scheme (a few lines of Python), not
     * by running this code and copying its output. That is what makes this a test rather than a restatement of the
     * implementation: if the two halves of the hash were swapped, or a base64 step dropped, both the code and a
     * self-generated expectation would move together and the test would still pass.
     */
    val result = ObsWebSocketClient.authenticationString(
      password = "supersecretpassword",
      salt = "lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=",
      challenge = "+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY="
    )
    assertEquals(result, "1Ct943GAT+6YQUUX47Ia/ncufilbe6+oD6lY+5kaCu4=")
  }

  test("the same password and salt with a different challenge produces a different answer") {
    // The challenge changes on every connection, which is the property that stops a captured value being replayed.
    val salt = "lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI="
    val first = ObsWebSocketClient.authenticationString("hunter2", salt, "AAAA")
    val second = ObsWebSocketClient.authenticationString("hunter2", salt, "BBBB")
    assertNotEquals(first, second)
  }

  test("levels are clamped into 0..1, and a NaN becomes silence") {
    assertEquals(ObsWebSocketClient.clampLevel(0.5), 0.5)
    assertEquals(ObsWebSocketClient.clampLevel(0.0), 0.0)
    assertEquals(ObsWebSocketClient.clampLevel(1.0), 1.0)
    // OBS can report a hair above full scale on a clipping source, and an effect that scales a radius by an unbounded
    // number draws something alarming.
    assertEquals(ObsWebSocketClient.clampLevel(1.4), 1.0)
    assertEquals(ObsWebSocketClient.clampLevel(-0.2), 0.0)
    assertEquals(ObsWebSocketClient.clampLevel(Double.NaN), 0.0)
  }

  test("the subscription mask asks for volume meters and nothing else") {
    // Bit 16. If this is ever widened by accident the client starts parsing every scene change in OBS and throwing it
    // away, which is invisible until somebody wonders why the container is busy.
    assertEquals(ObsWebSocketClient.EventSubscriptionInputVolumeMeters, 65536)
  }

  test("a normal close is not reported as a failure") {
    // `None` means "we asked for this", which is what stops the supervisor scheduling a reconnect after a deliberate
    // disconnect — for example the one that happens on every settings save.
    assertEquals(ObsWebSocketClient.closeCodeExplanation(WebSocket.NORMAL_CLOSURE, "bye"), None)
  }

  test("a wrong password is explained as a wrong password") {
    val message = ObsWebSocketClient.closeCodeExplanation(4009, "")
    assert(message.exists(_.contains("password")), s"got $message")
  }

  test("an unrecognised close code keeps its number rather than being hidden behind friendly text") {
    val message = ObsWebSocketClient.closeCodeExplanation(4999, "something odd")
    assert(message.exists(_.contains("4999")), s"got $message")
    assert(message.exists(_.contains("something odd")), s"got $message")
  }

  test("a refused connection suggests the thing that is actually wrong") {
    val message = ObsWebSocketClient.describeConnectFailure(
      new java.util.concurrent.CompletionException(new java.net.ConnectException("Connection refused"))
    )
    assert(message.contains("WebSocket Server Settings"), s"got $message")
  }

  test("a timeout blames the firewall rather than repeating 'timed out'") {
    /*
     * This is a real incident, kept as a test. An operator pointed the backend at their own LAN
     * address, which OBS was genuinely listening on and which worked from their desktop, and got
     * "HTTP connect timed out" — a message that is true and tells you nothing.
     *
     * The cause was ufw on the host allowing port 4455 from the machine itself but not from
     * Docker's bridge subnet, so the container's packets were dropped in silence. A refusal and a
     * timeout have opposite causes and the message has to separate them.
     */
    val message = ObsWebSocketClient.describeConnectFailure(
      new java.util.concurrent.CompletionException(
        new java.net.http.HttpConnectTimeoutException("HTTP connect timed out")
      )
    )
    assert(message.contains("firewall"), s"got $message")
    assert(message.contains("ufw"), s"got $message")
    // And it must not be confused with the refusal case, which points somewhere else entirely.
    assert(!message.contains("WebSocket Server Settings"), s"got $message")
  }

  test("an unresolvable host mentions the container/localhost trap") {
    // This is the single most common misconfiguration: `ws://localhost:4455` typed into a form served from a browser,
    // pointing at a backend inside a container, where localhost is the container.
    val message = ObsWebSocketClient.describeConnectFailure(
      new java.util.concurrent.CompletionException(new java.net.UnknownHostException("obs.local"))
    )
    assert(message.contains("host.docker.internal"), s"got $message")
  }
}
