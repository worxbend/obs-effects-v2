package obseffects.application

import obseffects.domain.{ObsAudioSettings, ObsConnectionStatus, ValidationIssue}
import org.slf4j.{Logger, LoggerFactory}

/** Reading and writing the operator's settings, and telling the OBS connection when they changed.
  *
  * ==The one interesting rule in this file==
  *
  * The obs-websocket password is **write-only over the API**. It goes in, it never comes back out: the admin is told
  * whether a password is set, not what it is. That is why [[save]] takes an `Option[Option[String]]` for the password
  * rather than a plain `Option[String]`, and the double option is worth explaining because it looks like a mistake:
  *
  *   - `None` — "leave the stored password alone". This is what the admin form sends when the operator edited the URL
  *     and did not touch the password field, which is the common case. Without it, saving any other setting would
  *     silently wipe the password, because the form cannot send back a value it was never given.
  *   - `Some(None)` — "remove the password". The operator explicitly cleared it.
  *   - `Some(Some(value))` — "use this new password".
  *
  * Three states, three meanings, no way to express "clear it" and "don't touch it" with the same value.
  */
final class SettingsService(
    repository: SettingsRepository,
    connection: ObsAudioConnection,
    levels: AudioLevelBus
) {

  private val log: Logger = LoggerFactory.getLogger(classOf[SettingsService])

  /** The settings as stored, password included. Only the OBS connection and this service should ever see this. */
  def obsAudio(): ObsAudioSettings = repository.loadObsAudio()

  /** The live connection status, for the admin panel. */
  def obsStatus(): ObsConnectionStatus = levels.currentStatus

  /** How many browser sources are currently receiving levels. */
  def levelSubscribers(): Int = levels.subscriberCount

  /** Validates and stores new settings, then asks the OBS connection to apply them.
    *
    * The reconnect happens on every successful save, even one that changed nothing. That is deliberate and it is a
    * feature: pressing Save is the only "try again now" button an operator has, and making it mean that is worth more
    * than the milliseconds saved by diffing the two documents first.
    */
  def saveObsAudio(update: ObsAudioUpdate): Either[AppError, ObsAudioSettings] = {
    val existing = repository.loadObsAudio()

    val validated = for {
      url <- ObsAudioSettings.parseUrl(update.url).left.map(reason => ValidationIssue("url", reason))
      inputName <- ObsAudioSettings
        .parseInputName(update.inputName)
        .left
        .map(reason => ValidationIssue("inputName", reason))
    } yield ObsAudioSettings(
      enabled = update.enabled,
      url = url,
      password = update.password match {
        case None            => existing.password // untouched
        case Some(None)      => None // cleared
        case Some(Some(raw)) => Option(raw.trim).filter(_.nonEmpty)
      },
      inputName = inputName
    )

    validated match {
      case Left(issue)     => Left(AppError.ValidationFailed(List(issue)))
      case Right(settings) =>
        val saved = repository.saveObsAudio(settings)
        log.info(
          "OBS audio settings saved: enabled={}, url={}, input={}",
          saved.enabled,
          saved.url,
          saved.inputName.getOrElse("(all inputs)")
        )
        connection.reconfigure(saved)
        Right(saved)
    }
  }

  /** Applies whatever is stored, at start-up. Called once, from the wiring, after the database is reachable. */
  def startObsAudio(): Unit = connection.reconfigure(repository.loadObsAudio())
}

/** A settings change as it arrives from the API, before validation.
  *
  * `password` is the three-state option explained on [[SettingsService]]: absent means "unchanged".
  */
final case class ObsAudioUpdate(
    enabled: Boolean,
    url: String,
    password: Option[Option[String]],
    inputName: Option[String]
)
