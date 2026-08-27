package obseffects.domain

import munit.FunSuite

/** Tests for the rules an operator's OBS connection settings have to satisfy, and for the shape of one measurement.
  *
  * The URL rules carry more weight than they look like they should. The value goes straight into a WebSocket client
  * that runs on a background thread, so a URL that is wrong in an interesting way does not produce a neat error next to
  * the form — it produces a connection that quietly never comes up, and an operator staring at a status badge.
  */
class ObsAudioSuite extends FunSuite {

  test("a fresh installation is switched off, with the address most people need already filled in") {
    assertEquals(ObsAudioSettings.Default.enabled, false)
    assertEquals(ObsAudioSettings.Default.password, None)
    assertEquals(ObsAudioSettings.Default.inputName, None)
    // `host.docker.internal`, not localhost: the backend is in a container and localhost is the container itself.
    assert(ObsAudioSettings.Default.url.contains("host.docker.internal"))
  }

  test("both WebSocket schemes are accepted, and the value is trimmed") {
    assertEquals(ObsAudioSettings.parseUrl("ws://localhost:4455"), Right("ws://localhost:4455"))
    assertEquals(ObsAudioSettings.parseUrl("wss://obs.example.com:4455"), Right("wss://obs.example.com:4455"))
    assertEquals(ObsAudioSettings.parseUrl("  ws://localhost:4455  "), Right("ws://localhost:4455"))
  }

  test("a host and port with no scheme is rejected, rather than being read as a scheme") {
    // This is the case worth having a test for. `java.net.URI` parses "localhost:4455" quite happily, as a URI whose
    // *scheme* is "localhost" — so a check that only asked "does this parse?" would accept it and then fail to connect.
    val result = ObsAudioSettings.parseUrl("localhost:4455")
    assert(result.isLeft)
    assert(result.left.exists(_.contains("ws://")), s"the message should say what is wanted, got $result")
  }

  test("http, empty and host-less URLs are rejected with a reason") {
    assert(ObsAudioSettings.parseUrl("http://localhost:4455").isLeft)
    assert(ObsAudioSettings.parseUrl("").isLeft)
    assert(ObsAudioSettings.parseUrl("   ").isLeft)
    assert(ObsAudioSettings.parseUrl("ws://").isLeft)
  }

  test("an input name is trimmed, and blank means every input") {
    assertEquals(ObsAudioSettings.parseInputName(None), Right(None))
    assertEquals(ObsAudioSettings.parseInputName(Some("")), Right(None))
    assertEquals(ObsAudioSettings.parseInputName(Some("   ")), Right(None))
    // The trim matters: a trailing space is invisible in a form and would match no OBS input at all.
    assertEquals(ObsAudioSettings.parseInputName(Some("  Desktop Audio  ")), Right(Some("Desktop Audio")))
  }

  test("an absurdly long input name is rejected") {
    val tooLong = "x" * (ObsAudioSettings.MaxInputNameLength + 1)
    assert(ObsAudioSettings.parseInputName(Some(tooLong)).isLeft)
    assert(ObsAudioSettings.parseInputName(Some("x" * ObsAudioSettings.MaxInputNameLength)).isRight)
  }

  test("the peak of several inputs is the loudest one, not their sum") {
    // Summing would give 1.4 for two half-full-scale inputs, which is not a louder sound — it is a broken number that
    // an effect would scale a radius by.
    val inputs = List(
      AudioInputLevel("Desktop Audio", 0.7, List(0.7, 0.6)),
      AudioInputLevel("Mic/Aux", 0.7, List(0.7))
    )
    assertEquals(AudioLevels.peakOf(inputs), 0.7)
  }

  test("the peak of no inputs is silence") {
    assertEquals(AudioLevels.peakOf(Nil), 0.0)
    assertEquals(AudioLevels.silent(1000L).peak, 0.0)
    assertEquals(AudioLevels.silent(1000L).inputs, Nil)
  }
}
