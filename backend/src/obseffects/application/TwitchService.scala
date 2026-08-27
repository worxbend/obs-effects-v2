package obseffects.application

import obseffects.domain.{ChatMessage, TwitchConnectionStatus, TwitchSettings, ValidationIssue}
import org.slf4j.{Logger, LoggerFactory}

/** A fresh access token and, when Twitch sent one, the refresh token that rotates it. */
final case class TwitchTokenPair(accessToken: String, refreshToken: Option[String])

/** What the application needs from Twitch's OAuth endpoints, without knowing that HTTP is involved.
  *
  * A port in the same sense as `ObsAudioConnection`: the infrastructure implementation (`TwitchOAuth`) talks to
  * `id.twitch.tv`, and a test hands the service a stub. Every method returns `Either` with an operator-readable reason
  * on the left — a rejected code or an expired token is a normal outcome, not an exception.
  */
trait TwitchTokenExchanger {

  /** Trades an OAuth authorization code for tokens. Needs the client secret, so it is only callable when the operator
    * registered their own Twitch application.
    */
  def exchangeCode(
      clientId: String,
      clientSecret: String,
      code: String,
      redirectUri: String
  ): Either[String, TwitchTokenPair]

  /** Trades a refresh token for a fresh token pair. Twitch rotates the refresh token too, so the caller must store what
    * comes back.
    */
  def refreshTokens(clientId: String, clientSecret: String, refreshToken: String): Either[String, TwitchTokenPair]

  /** Asks Twitch whose token this is. The returned login is what an authenticated IRC connection uses as its NICK. */
  def validateToken(accessToken: String): Either[String, String]
}

/** A Twitch settings change as it arrives from the API, before validation.
  *
  * `clientSecret` is the same three-state option as the obs-websocket password, for the same reason: the secret is
  * write-only, so the form cannot send back a value it was never given, and "absent" has to mean "leave it alone".
  * Tokens are deliberately *not* here — they arrive through their own endpoints (`storeTokens`, `completeOAuth`), so a
  * settings save can never wipe them by accident.
  */
final case class TwitchSettingsUpdate(
    enabled: Boolean,
    channel: String,
    clientId: String,
    clientSecret: Option[Option[String]]
)

/** Reading and writing the Twitch chat configuration, storing tokens, and querying recorded chat history.
  *
  * The same shape as `SettingsService`: validate, store, then tell the connection to apply — with the connection seen
  * only through [[TwitchChatConnection]], so nothing here knows a socket exists.
  */
final class TwitchService(
    repository: SettingsRepository,
    history: ChatMessageRepository,
    connection: TwitchChatConnection,
    bus: ChatBus,
    exchanger: TwitchTokenExchanger
) {

  private val log: Logger = LoggerFactory.getLogger(classOf[TwitchService])

  /** The settings as stored, secret and tokens included. Only the connection and this service should ever see this. */
  def twitch(): TwitchSettings = repository.loadTwitch()

  /** The live connection status, for the admin panel and the stream's status frames. */
  def chatStatus(): TwitchConnectionStatus = bus.currentStatus

  /** How many overlays are currently reading chat. */
  def chatSubscribers(): Int = bus.subscriberCount

  /** Validates and stores new settings, then asks the connection to apply them.
    *
    * Tokens and the discovered bot login are carried over from the stored document untouched: this method is the
    * settings form's save, and the form never holds tokens.
    */
  def saveTwitch(update: TwitchSettingsUpdate): Either[AppError, TwitchSettings] = {
    val existing = repository.loadTwitch()

    val validated = for {
      channel <- TwitchSettings.parseChannel(update.channel).left.map(reason => ValidationIssue("channel", reason))
      clientId <- TwitchSettings.parseClientId(update.clientId).left.map(reason => ValidationIssue("clientId", reason))
    } yield existing.copy(
      enabled = update.enabled,
      channel = channel,
      clientId = clientId,
      clientSecret = update.clientSecret match {
        case None            => existing.clientSecret // untouched
        case Some(None)      => None // cleared
        case Some(Some(raw)) => Option(raw.trim).filter(_.nonEmpty)
      }
    )

    validated match {
      case Left(issue)     => Left(AppError.ValidationFailed(List(issue)))
      case Right(settings) => Right(applyAndSave(settings))
    }
  }

  /** Stores a token pair the operator obtained themselves — the direct hand-off for people who authorized through some
    * other tool and have the strings in hand. A blank refresh token is stored as none, so pasting only an access token
    * works; that token will simply expire instead of rotating.
    */
  def storeTokens(accessToken: String, refreshToken: Option[String]): Either[AppError, TwitchSettings] = {
    val access = accessToken.trim.stripPrefix("oauth:")
    if (access.isEmpty) Left(AppError.ValidationFailed(List(ValidationIssue("accessToken", "must not be empty"))))
    else {
      val settings = repository
        .loadTwitch()
        .copy(
          accessToken = Some(access),
          refreshToken = refreshToken.map(_.trim).filter(_.nonEmpty),
          // Whoever this token belongs to is not who the old one belonged to until proven otherwise. The connection
          // rediscovers the login from Twitch's validate endpoint on its next connect and stores it then.
          botLogin = None
        )
      Right(applyAndSave(settings))
    }
  }

  /** Completes the "Connect with Twitch" flow: trades the authorization code the browser was redirected back with for
    * tokens, stores them, and reconnects. Only possible when the operator has registered their own Twitch application,
    * because the exchange requires the client secret.
    */
  def completeOAuth(code: String, redirectUri: String): Either[AppError, TwitchSettings] = {
    val settings = repository.loadTwitch()
    (settings.clientId.trim, settings.clientSecret) match {
      case ("", _) | (_, None) =>
        Left(
          AppError.BadRequest(
            "The Twitch client id and client secret must be saved in the settings before the OAuth flow can complete"
          )
        )
      case (clientId, Some(secret)) =>
        if (code.trim.isEmpty)
          Left(AppError.ValidationFailed(List(ValidationIssue("code", "must not be empty"))))
        else if (redirectUri.trim.isEmpty)
          Left(AppError.ValidationFailed(List(ValidationIssue("redirectUri", "must not be empty"))))
        else
          exchanger.exchangeCode(clientId, secret, code.trim, redirectUri.trim) match {
            case Left(reason) => Left(AppError.BadRequest(s"Twitch rejected the code exchange: $reason"))
            case Right(pair)  => storeTokens(pair.accessToken, pair.refreshToken)
          }
    }
  }

  /** Recorded chat history, newest first. `before` pages backwards: pass the `at` of the oldest message already shown,
    * and its id as `beforeId` so a page boundary inside a group of messages sharing one millisecond does not skip the
    * tied messages. `beforeId` without `before` means nothing and is ignored.
    */
  def chatHistory(
      limit: Option[Int],
      before: Option[Long],
      beforeId: Option[String] = None
  ): Either[AppError, List[ChatMessage]] = {
    val requested = limit.getOrElse(TwitchService.DefaultHistoryLimit)
    if (requested < 1 || requested > TwitchService.MaxHistoryLimit)
      Left(
        AppError.ValidationFailed(
          List(ValidationIssue("limit", s"must be between 1 and ${TwitchService.MaxHistoryLimit}"))
        )
      )
    else
      Right(before match {
        case Some(at) => history.before(at, beforeId, requested)
        case None     => history.recent(requested)
      })
  }

  /** Applies whatever is stored, at start-up — and first seeds the snapshot ring from the recorded history, so an
    * overlay opened right after a restart shows the conversation instead of a void until somebody chats.
    */
  def startTwitchChat(): Unit = {
    bus.preload(history.recent(ChatBus.RecentCapacity).reverse)
    connection.reconfigure(repository.loadTwitch())
  }

  /** The shared tail of every successful write: store, log without secrets, reconnect. */
  private def applyAndSave(settings: TwitchSettings): TwitchSettings = {
    val saved = repository.saveTwitch(settings)
    log.info(
      "Twitch chat settings saved: enabled={}, channel={}, secretSet={}, tokensSet={}",
      saved.enabled,
      if (saved.channel.isEmpty) "(none)" else saved.channel,
      saved.clientSecret.isDefined,
      saved.accessToken.isDefined
    )
    connection.reconfigure(saved)
    saved
  }
}

object TwitchService {

  /** How many history entries a request gets when it does not say. Matches the snapshot ring, so "the default page" and
    * "what a fresh overlay shows" are the same thing.
    */
  val DefaultHistoryLimit: Int = ChatBus.RecentCapacity

  /** The largest page the history endpoint serves, so a stray `limit=1000000` cannot ask MongoDB to materialise the
    * whole collection into one response.
    */
  val MaxHistoryLimit = 200
}
