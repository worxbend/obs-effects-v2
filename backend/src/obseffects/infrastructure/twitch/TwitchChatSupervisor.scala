package obseffects.infrastructure.twitch

import obseffects.application.{
  ChatBus,
  ChatMessageRepository,
  SettingsRepository,
  TwitchChatConnection,
  TwitchTokenExchanger
}
import obseffects.domain.{ChatMessage, TwitchConnectionState, TwitchConnectionStatus, TwitchSettings}
import org.slf4j.{Logger, LoggerFactory}

import java.time.Clock
import java.util.concurrent.atomic.{AtomicBoolean, AtomicLong, AtomicReference}
import java.util.concurrent.{Executors, ScheduledExecutorService, ThreadLocalRandom, TimeUnit}

import scala.concurrent.duration.{DurationInt, DurationLong, FiniteDuration}

/** Keeps exactly one Twitch chat connection alive, for as long as the settings say there should be one.
  *
  * A deliberate clone of [[obseffects.infrastructure.obs.ObsAudioSupervisor]] — same single scheduler thread owning
  * every state transition, same generation counter recognising callbacks from abandoned connections, same doubling
  * backoff capped low — because the problem is the same shape: a long-lived connection whose normal state includes
  * being broken (no internet, Twitch restarting an edge server), watched by an operator who wants it back the moment it
  * can be. Read that class's documentation for the full reasoning; this one only documents what differs.
  *
  * ==What differs: credentials can go stale mid-flight==
  *
  * OBS either accepts the password or it does not. A Twitch access token *expires*, typically within hours, so this
  * supervisor has a second recovery axis on top of retrying:
  *
  *   1. Before an authenticated connect, the token is validated against Twitch (which also yields the login the IRC
  *      handshake needs as its NICK).
  *   2. A token that fails validation — or is rejected mid-connection by a `NOTICE` — is refreshed **once per settings
  *      generation**, when a refresh token and the client secret are configured. The rotated pair is written back to
  *      the settings document so it survives a restart.
  *   3. If refreshing is impossible or fails, the connection falls back to **anonymous** — chat still works read-only,
  *      which is everything the overlays need — and the reason is recorded in the status so the settings page can say
  *      "reading anonymously because your token expired" instead of pretending nothing happened.
  */
final class TwitchChatSupervisor(
    bus: ChatBus,
    settingsRepository: SettingsRepository,
    chatMessages: ChatMessageRepository,
    oauth: TwitchTokenExchanger,
    clock: Clock
) extends TwitchChatConnection {

  import TwitchChatSupervisor.*

  private val log: Logger = LoggerFactory.getLogger(classOf[TwitchChatSupervisor])

  /** The single thread every state change runs on. A daemon thread, so it can never hold the JVM open at shutdown. */
  private val scheduler: ScheduledExecutorService =
    Executors.newSingleThreadScheduledExecutor { runnable =>
      val thread = new Thread(runnable, "twitch-chat-supervisor")
      thread.setDaemon(true)
      thread
    }

  /** Where history writes go, so a slow MongoDB can never stall the IRC read loop (see [[record]]). Its own thread
    * rather than the scheduler, because the scheduler blocks for seconds at a time in token HTTP during reconnects —
    * history would queue behind that. A daemon for the same reason as the scheduler.
    */
  private val historyWriter: java.util.concurrent.ExecutorService =
    Executors.newSingleThreadExecutor { runnable =>
      val thread = new Thread(runnable, "twitch-chat-history")
      thread.setDaemon(true)
      thread
    }

  /** The live client, if a connection is open or being opened. */
  private val client = new AtomicReference[Option[TwitchIrcClient]](None)

  /** How many consecutive attempts have failed, which is what [[backoffFor]] turns into a delay. */
  private val failures = new AtomicLong(0)

  /** Bumped every time the settings change — the same stale-callback guard as the OBS supervisor's, protecting against
    * a dying old connection scheduling a reconnect beside the new connection's own attempt.
    */
  private val generation = new AtomicLong(0)

  /** Whether a token refresh has been spent for the current settings generation. One per generation, because a refresh
    * that yields a token Twitch still rejects would otherwise be retried on every reconnect, hammering the token
    * endpoint forever for an account whose authorization was revoked.
    */
  private val refreshSpent = new AtomicBoolean(false)

  /** Set when authentication has definitively failed for the current settings generation, so every further attempt in
    * it connects anonymously instead of re-validating a token known to be dead on each retry.
    */
  private val anonymousFallback = new AtomicBoolean(false)

  /** Called once at start-up with whatever was loaded from the database, and again on every settings save.
    *
    * Only the generation bump happens here on the caller's thread — it must, because it is what tells any in-flight
    * scheduler work to stand down. Everything else (resetting the per-generation flags, dropping the old connection) is
    * deferred to [[restart]] on the scheduler thread, so an in-flight old-generation attempt — which can be blocked in
    * token-validation HTTP for seconds — cannot observe the flags half-reset and spend the new generation's refresh or
    * poison it with an anonymous fallback.
    */
  override def reconfigure(settings: TwitchSettings): Unit = {
    val era = generation.incrementAndGet()
    submit(() => restart(settings, era))
  }

  /** Stops everything, permanently. Called from the server's shutdown hook.
    *
    * `shutdown()` rather than `shutdownNow()`, because the disconnect submitted a line above has to actually run —
    * `shutdownNow` would drain the queue and abandon the IRC socket without a close frame. `shutdown()` lets already-
    * queued tasks finish (and drops pending *delayed* retries, which is exactly right), and the short wait gives the
    * disconnect time to complete before the caller proceeds with tearing everything else down.
    */
  def shutdown(): Unit = {
    val _ = generation.incrementAndGet()
    submit(() => disconnect())
    scheduler.shutdown()
    try { val _ = scheduler.awaitTermination(2, TimeUnit.SECONDS) }
    catch { case _: InterruptedException => Thread.currentThread().interrupt() }
    historyWriter.shutdown()
  }

  // -------------------------------------------------------------------------------------------

  /** Drops any existing connection and starts a new one if the settings ask for it. Runs on the scheduler thread.
    *
    * `era` is the generation the triggering `reconfigure` bumped to, captured *then* rather than read now: two saves in
    * quick succession queue two restarts, and if both read the counter at run time both would connect under the final
    * era — the first client's deliberate-close callback would then pass the era check and null out the second, live,
    * client. A superseded restart instead stands down entirely and leaves the work to the one that superseded it.
    */
  private def restart(settings: TwitchSettings, era: Long): Unit = if (era == generation.get()) {
    disconnect()
    failures.set(0)
    refreshSpent.set(false)
    anonymousFallback.set(false)
    if (!settings.enabled || settings.channel.isEmpty) {
      log.info("Twitch chat is switched off or has no channel configured; not connecting")
      bus.updateStatus(TwitchConnectionStatus.Disabled)
    } else {
      attempt(settings, era)
    }
  }

  /** One connection attempt. */
  private def attempt(settings: TwitchSettings, era: Long): Unit = if (era == generation.get()) {
    bus.modifyStatus(_.copy(state = TwitchConnectionState.Connecting, channel = Some(settings.channel)))

    val credentials = resolveCredentials(settings)
    val fresh = new TwitchIrcClient(
      channel = settings.channel,
      nick = credentials
        .map(_.login)
        // The digits only stop two anonymous readers colliding, so any number will do and nothing depends on it —
        // which is why plain ThreadLocalRandom is enough here where sessions demanded SecureRandom.
        .getOrElse(TwitchIrcClient.anonymousNick(ThreadLocalRandom.current().nextInt())),
      password = credentials.map(value => s"oauth:${value.token}"),
      clock = clock,
      onMessage = message => record(message),
      onConnected = () => submit(() => connected(era, authenticated = credentials.isDefined)),
      onAuthFailure = reason => submit(() => authFailed(settings, era, reason)),
      onClosed = reason => submit(() => ended(settings, era, reason))
    )
    client.set(Some(fresh))
    fresh.connect()
  }

  /** The login and token to connect with, or `None` for anonymous — deciding which is the recovery ladder described in
    * the class comment. Runs on the scheduler thread; the validate and refresh calls inside are blocking HTTP, which is
    * fine there because this thread has nothing else to do until a connection exists anyway.
    */
  private def resolveCredentials(settings: TwitchSettings): Option[Credentials] =
    if (anonymousFallback.get()) None
    else
      settings.accessToken match {
        case None        => None
        case Some(token) =>
          oauth.validateToken(token) match {
            case Right(login) =>
              rememberBotLogin(settings, login)
              Some(Credentials(login, token))
            case Left(reason) =>
              refreshOnce(settings) match {
                case Some(rotated) =>
                  oauth.validateToken(rotated) match {
                    case Right(login) => Some(Credentials(login, rotated))
                    case Left(again)  => fallBackToAnonymous(s"the refreshed token was rejected too ($again)")
                  }
                case None => fallBackToAnonymous(reason)
              }
          }
      }

  /** Spends this generation's one token refresh, storing the rotated pair. `None` when it was already spent, when the
    * settings lack what a refresh needs, or when Twitch refused.
    */
  private def refreshOnce(settings: TwitchSettings): Option[String] =
    if (!refreshSpent.compareAndSet(false, true)) None
    else
      (settings.refreshToken, settings.clientSecret) match {
        case (Some(refreshToken), Some(secret)) if settings.clientId.nonEmpty =>
          oauth.refreshTokens(settings.clientId, secret, refreshToken) match {
            case Right(pair) =>
              log.info("Refreshed the Twitch access token")
              // Twitch rotates the refresh token as well, so the stored pair must be replaced now — the old refresh
              // token may already be dead. A field-level patch rather than load-then-save, so a save the operator
              // makes concurrently from the settings page is not silently reverted wholesale; when Twitch sent no new
              // refresh token, the stored one is left untouched rather than rewritten.
              settingsRepository.updateTwitchAuth(
                accessToken = Some(pair.accessToken),
                refreshToken = pair.refreshToken
              )
              Some(pair.accessToken)
            case Left(reason) =>
              log.info("Refreshing the Twitch access token failed: {}", reason)
              None
          }
        case _ => None
      }

  /** Records why authentication is being given up on, and answers "no credentials". The connection that follows still
    * works — anonymous covers everything the overlays draw — which is exactly why this is a fallback and not a failure
    * state.
    */
  private def fallBackToAnonymous(reason: String): Option[Credentials] = {
    anonymousFallback.set(true)
    log.info("Twitch login is not usable ({}); reading chat anonymously", reason)
    bus.modifyStatus(_.copy(lastError = Some(s"Twitch login failed ($reason); reading chat anonymously")))
    None
  }

  /** Persists the login the token turned out to belong to, for the settings page's "connected as" line. Written only
    * when it changed, so the steady state does no writes per connect — and written as a field-level patch, so it can
    * never revert an operator save that raced this connect attempt.
    */
  private def rememberBotLogin(settings: TwitchSettings, login: String): Unit =
    if (!settings.botLogin.contains(login)) {
      settingsRepository.updateTwitchAuth(botLogin = Some(login))
    }

  /** Twitch accepted the login. */
  private def connected(era: Long, authenticated: Boolean): Unit = if (era == generation.get()) {
    failures.set(0)
    log.info("Connected to Twitch chat{}", if (authenticated) " (authenticated)" else " (anonymous)")
    bus.modifyStatus(status =>
      status.copy(
        state =
          if (authenticated) TwitchConnectionState.ConnectedAuthed else TwitchConnectionState.ConnectedAnonymous,
        // An anonymous connection that exists *because* the token failed keeps its explanation; a clean connect has
        // nothing to explain.
        lastError = if (anonymousFallback.get()) status.lastError else None
      )
    )
  }

  /** Twitch said, mid-connection, that the login is bad — the path a token takes when it expires between the validate
    * call and the handshake, or is revoked while connected. Spend the refresh if it is still available, otherwise drop
    * to anonymous; either way reconnect immediately rather than waiting out a backoff, because this is a decision, not
    * an outage.
    */
  private def authFailed(settings: TwitchSettings, era: Long, reason: String): Unit = if (era == generation.get()) {
    log.info("Twitch rejected the login: {}", reason)
    // Bump the generation before reconnecting, mirroring `reconfigure`: closing the rejected client queues its
    // `ended` callback behind this task, and if the reconnect happened under the *same* era that callback would pass
    // its staleness check and null out (or schedule a retry beside) the fresh, live client. The bump makes it stale.
    // The per-generation flags are deliberately *not* reset — the refresh already spent belongs to this recovery.
    // A compare-and-set rather than a plain increment, so a `reconfigure` that raced in since this task's era check
    // wins outright: its own restart is already queued, and stealing its era here would make that restart stand down.
    if (generation.compareAndSet(era, era + 1)) {
      disconnect()
      if (refreshOnce(settings).isEmpty) {
        val _ = fallBackToAnonymous(reason)
      }
      attempt(settingsRepository.loadTwitch(), era + 1)
    }
  }

  /** A connection ended, for any reason. Schedules the next attempt unless we asked for the close. */
  private def ended(settings: TwitchSettings, era: Long, reason: Option[String]): Unit = if (era == generation.get()) {
    client.set(None)

    reason match {
      case None =>
        // We closed it ourselves; `restart` has already set whatever status is correct.
        ()

      case Some(message) =>
        val consecutive = failures.incrementAndGet()
        if (consecutive == 1) log.info("Twitch chat connection lost or refused: {}", message)
        else log.debug("Twitch chat still unavailable after {} attempts: {}", consecutive, message)

        bus.modifyStatus(_.copy(state = TwitchConnectionState.Failed, lastError = Some(message)))

        val delay = backoffFor(consecutive)
        log.debug("Retrying Twitch chat in {}", delay)
        val _ = scheduler.schedule(
          (() => attempt(settings, era)): Runnable,
          delay.toMillis,
          TimeUnit.MILLISECONDS
        )
    }
  }

  /** One arrived chat event: fan it out live, count it, and write it down.
    *
    * Runs on the WebSocket's callback thread, not the scheduler — messages must not queue behind a reconnect timer.
    * Publishing to the bus happens first and the history write is handed off to [[historyWriter]], because MongoDB
    * being slow or briefly unreachable must degrade to "history has a gap", never to "chat stopped": a blocking insert
    * here would hold up the IRC read loop (and with it PING handling) for the driver's full server-selection timeout
    * per message.
    */
  private def record(message: ChatMessage): Unit = {
    bus.publish(message)
    bus.modifyStatus(status => status.copy(messagesReceived = status.messagesReceived + 1))
    try {
      val _ = historyWriter.execute(() =>
        try chatMessages.append(message)
        catch {
          case scala.util.control.NonFatal(e) => log.warn("Failed to store a chat message in the history", e)
        }
      )
    } catch {
      // Shutting down: losing the tail of the history is the documented degradation.
      case _: java.util.concurrent.RejectedExecutionException => ()
    }
  }

  /** Closes the live connection, if any, without scheduling a replacement. */
  private def disconnect(): Unit = client.getAndSet(None).foreach(_.close())

  /** Runs `work` on the scheduler thread, swallowing the rejection that arrives if we are shutting down. */
  private def submit(work: () => Unit): Unit =
    try {
      val _ = scheduler.execute(() =>
        try work()
        catch {
          case scala.util.control.NonFatal(e) => log.warn("Twitch chat supervisor task failed", e)
        }
      )
    } catch {
      case _: java.util.concurrent.RejectedExecutionException => ()
    }
}

object TwitchChatSupervisor {

  /** A validated login and the token that proved it, ready for the IRC handshake. */
  private final case class Credentials(login: String, token: String)

  /** The first retry delay, and the step the backoff doubles from. */
  val InitialBackoff: FiniteDuration = 1.second

  /** The longest this will ever wait between attempts — capped low for the same reason as the OBS supervisor's: an
    * operator watching an overlay should see chat come back within seconds of their network doing so.
    */
  val MaxBackoff: FiniteDuration = 15.seconds

  /** Doubling backoff, capped: 1s, 2s, 4s, 8s, 15s, 15s, ... The shift is bounded before it is applied for the same
    * Java shift-wrapping reason documented on `ObsAudioSupervisor.backoffFor`.
    */
  def backoffFor(consecutive: Long): FiniteDuration = {
    val steps = Math.min(Math.max(consecutive - 1, 0), 32L).toInt
    val millis = InitialBackoff.toMillis << steps
    if (millis <= 0 || millis > MaxBackoff.toMillis) MaxBackoff else millis.millis
  }
}
