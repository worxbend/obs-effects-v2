package obseffects.application

import munit.FunSuite
import obseffects.domain.{ObsAudioSettings, ObsConnectionState, Soundboard, TwitchSettings}

import scala.collection.mutable

/** Records what the OBS connection was asked to do, without any network anywhere near it. */
final class RecordingObsConnection extends ObsAudioConnection {
  val applied: mutable.ListBuffer[ObsAudioSettings] = mutable.ListBuffer.empty
  override def reconfigure(settings: ObsAudioSettings): Unit = { val _ = applied.append(settings) }
}

/** An in-memory settings store, so these tests never touch MongoDB. Holds both settings documents, because the real
  * repository does — the Twitch half is exercised by `TwitchServiceSuite`.
  */
final class FakeSettingsRepository(
    initial: ObsAudioSettings = ObsAudioSettings.Default,
    initialTwitch: TwitchSettings = TwitchSettings.Default
) extends SettingsRepository {
  private var stored: ObsAudioSettings = initial
  private var storedTwitch: TwitchSettings = initialTwitch
  private var storedSoundboard: Soundboard = Soundboard.Empty
  override def loadObsAudio(): ObsAudioSettings = stored
  override def saveObsAudio(settings: ObsAudioSettings): ObsAudioSettings = { stored = settings; settings }
  override def loadTwitch(): TwitchSettings = storedTwitch
  override def saveTwitch(settings: TwitchSettings): TwitchSettings = { storedTwitch = settings; settings }
  override def updateTwitchAuth(
      accessToken: Option[String],
      refreshToken: Option[String],
      botLogin: Option[String]
  ): Unit =
    storedTwitch = storedTwitch.copy(
      accessToken = accessToken.orElse(storedTwitch.accessToken),
      refreshToken = refreshToken.orElse(storedTwitch.refreshToken),
      botLogin = botLogin.orElse(storedTwitch.botLogin)
    )
  override def loadSoundboard(): Soundboard = storedSoundboard
  override def saveSoundboard(soundboard: Soundboard): Soundboard = { storedSoundboard = soundboard; soundboard }
}

/** Tests for saving the OBS connection settings.
  *
  * Most of this file is about **one rule**: what happens to the stored password when a save does not mention it. That
  * gets a disproportionate share of the tests because it is the failure that would be worst in practice and quietest in
  * review — an operator edits the URL, presses Save, and their password is silently gone. The connection then fails
  * with "authentication failed", which points at the password field rather than at the save that erased it.
  */
class SettingsServiceSuite extends FunSuite {

  private def service(
      initial: ObsAudioSettings = ObsAudioSettings.Default
  ): (SettingsService, FakeSettingsRepository, RecordingObsConnection, AudioLevelBus) = {
    val repository = new FakeSettingsRepository(initial)
    val connection = new RecordingObsConnection
    val bus = new AudioLevelBus
    (new SettingsService(repository, connection, bus), repository, connection, bus)
  }

  private val configured =
    ObsAudioSettings(enabled = true, url = "ws://obs:4455", password = Some("hunter2"), inputName = Some("Mic/Aux"))

  test("a save that does not mention the password keeps the stored one") {
    val (settings, repository, _, _) = service(configured)

    val result = settings.saveObsAudio(
      ObsAudioUpdate(enabled = true, url = "ws://elsewhere:4455", password = None, inputName = Some("Mic/Aux"))
    )

    assert(result.isRight, s"expected the save to succeed, got $result")
    assertEquals(repository.loadObsAudio().password, Some("hunter2"))
    assertEquals(repository.loadObsAudio().url, "ws://elsewhere:4455")
  }

  test("an explicit null clears the stored password") {
    val (settings, repository, _, _) = service(configured)

    val _ = settings.saveObsAudio(
      ObsAudioUpdate(enabled = true, url = "ws://obs:4455", password = Some(None), inputName = None)
    )

    assertEquals(repository.loadObsAudio().password, None)
  }

  test("a new password replaces the old one, and is trimmed") {
    val (settings, repository, _, _) = service(configured)

    val _ = settings.saveObsAudio(
      ObsAudioUpdate(enabled = true, url = "ws://obs:4455", password = Some(Some("  swordfish  ")), inputName = None)
    )

    assertEquals(repository.loadObsAudio().password, Some("swordfish"))
  }

  test("a password of only whitespace is stored as no password rather than as a blank one") {
    // A blank string would be sent to OBS as a password, which fails in a way that reads as "wrong password" rather
    // than as "you did not type one".
    val (settings, repository, _, _) = service(configured)

    val _ = settings.saveObsAudio(
      ObsAudioUpdate(enabled = true, url = "ws://obs:4455", password = Some(Some("   ")), inputName = None)
    )

    assertEquals(repository.loadObsAudio().password, None)
  }

  test("every successful save reconnects, including one that changes nothing") {
    // Pressing Save is the operator's only "try again now" button, so it has to mean that.
    val (settings, _, connection, _) = service(configured)
    val unchanged =
      ObsAudioUpdate(enabled = true, url = "ws://obs:4455", password = None, inputName = Some("Mic/Aux"))

    val _ = settings.saveObsAudio(unchanged)
    val _ = settings.saveObsAudio(unchanged)

    assertEquals(connection.applied.size, 2)
    assertEquals(connection.applied.last.url, "ws://obs:4455")
  }

  test("a bad URL is rejected, nothing is stored, and no reconnect is attempted") {
    val (settings, repository, connection, _) = service(configured)

    val result = settings.saveObsAudio(
      ObsAudioUpdate(enabled = true, url = "localhost:4455", password = None, inputName = None)
    )

    result match {
      case Left(AppError.ValidationFailed(issues)) => assertEquals(issues.map(_.field), List("url"))
      case other                                   => fail(s"expected a validation failure on url, got $other")
    }
    // The old settings survive intact: a rejected save must not be a half-applied one.
    assertEquals(repository.loadObsAudio(), configured)
    assertEquals(connection.applied.size, 0)
  }

  test("an over-long input name is rejected and named as the offending field") {
    val (settings, _, _, _) = service(configured)

    val result = settings.saveObsAudio(
      ObsAudioUpdate(
        enabled = true,
        url = "ws://obs:4455",
        password = None,
        inputName = Some("x" * (ObsAudioSettings.MaxInputNameLength + 1))
      )
    )

    result match {
      case Left(AppError.ValidationFailed(issues)) => assertEquals(issues.map(_.field), List("inputName"))
      case other                                   => fail(s"expected a validation failure on inputName, got $other")
    }
  }

  test("a blank input name is stored as 'every input'") {
    val (settings, repository, _, _) = service(configured)

    val _ = settings.saveObsAudio(
      ObsAudioUpdate(enabled = true, url = "ws://obs:4455", password = None, inputName = Some("   "))
    )

    assertEquals(repository.loadObsAudio().inputName, None)
  }

  test("start-up applies whatever was stored, without a save") {
    val (settings, _, connection, _) = service(configured)

    settings.startObsAudio()

    assertEquals(connection.applied.toList, List(configured))
  }

  test("status and subscriber count are read from the level bus, not from the stored document") {
    // The two answer different questions: the document says what was asked for, the bus says what is actually
    // happening. Reading the second from the first is how a settings page ends up claiming a connection it does not
    // have.
    val (settings, _, _, bus) = service(configured)
    assertEquals(settings.obsStatus().state, ObsConnectionState.Disabled)
    assertEquals(settings.levelSubscribers(), 0)

    val subscription = bus.subscribe()
    bus.modifyStatus(_.copy(state = ObsConnectionState.Connected))

    assertEquals(settings.obsStatus().state, ObsConnectionState.Connected)
    assertEquals(settings.levelSubscribers(), 1)

    subscription.close()
    assertEquals(settings.levelSubscribers(), 0)
  }
}
