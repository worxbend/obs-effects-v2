package obseffects.application

import obseffects.domain.{TwitchSettings, ValidationIssue}
import org.slf4j.{Logger, LoggerFactory}

import scala.util.matching.Regex

/** Whether the Twitch moderation dashboard can do anything at all, and what it is looking at when it can.
  *
  * One object answers both halves on purpose. "Available" is never a bare `false` a page has to explain for itself:
  * whenever it is false, [[reason]] is one plain sentence naming what is missing and where to fix it, and
  * [[missingScopes]] lists the permissions a reconnection would grant.
  *
  * @param available
  *   whether the moderation endpoints will do work rather than refuse.
  * @param channel
  *   the configured channel login, or `""` when none is configured yet.
  * @param broadcasterId
  *   the channel's numeric id once it has been looked up.
  * @param moderatorLogin
  *   the account whose token would act — "banned by" from the channel's point of view.
  * @param grantedScopes
  *   the permissions the stored token actually carries, as far as they are known. Empty also means "never read back".
  * @param missingScopes
  *   which of the permissions this dashboard uses are absent from [[grantedScopes]].
  * @param reason
  *   `None` when available; one sentence for a person to act on when not.
  */
final case class TwitchAdminStatus(
    available: Boolean,
    channel: String,
    broadcasterId: Option[String],
    moderatorLogin: Option[String],
    grantedScopes: List[String],
    missingScopes: List[String],
    reason: Option[String]
)

/** What happened to one user in a bulk operation. `message` carries Twitch's own words when it refused — "The user
  * specified in the user_id field is already banned", say — because that sentence is the answer to "why did this one
  * not work?" and no paraphrase of ours would be better.
  */
final case class BulkOutcome(login: String, ok: Boolean, message: Option[String])

/** One account the ban list already knows, named by its id rather than by its login.
  *
  * A Twitch login can be renamed, and once it is freed anybody may take it. So a login read off the ban list a minute
  * ago is not a promise about which account it names now: unbanning by login means asking Twitch "who is `someviewer`
  * today?" and acting on whatever comes back, which can be a different person than the operator clicked on. The numeric
  * `userId` never moves between accounts, so acting on it is the only spelling of "unban this row" that cannot go to
  * the wrong account.
  *
  * @param userId
  *   the account's numeric Twitch id — what the unban is actually issued against.
  * @param login
  *   the login as it read when the row was loaded, used only to label the [[BulkOutcome]] so the report stays readable
  *   by a person.
  */
final case class TwitchUnbanTarget(userId: String, login: String)

/** The result of one bulk operation: the counts a page shows first, and every outcome in the order the request listed
  * them, so a person can scan down their own input.
  */
final case class BulkResult(succeeded: Int, failed: Int, outcomes: List[BulkOutcome])

/** Moderating the connected Twitch channel: reading the ban list and the moderator list, and banning, timing out or
  * unbanning people in bulk.
  *
  * ==This whole feature is optional, and that shapes every method==
  *
  * A fresh installation has no Twitch application, no token and no channel, and it must keep working exactly as before
  * — chat overlays included. So "not set up" is modelled as an ordinary answer rather than a failure: [[status]] always
  * returns a description (it has no error branch at all), and every acting method starts by asking the same question
  * and answers [[AppError.TwitchUnavailable]] when it cannot proceed. Nothing here throws, nothing here reaches the
  * client as a `500`, and nothing here runs at start-up — the feature only exists while a request is being served.
  *
  * ==One expired token does not lose the batch==
  *
  * Twitch access tokens last a few hours, so a dashboard left open overnight will meet a `401`. When one arrives, this
  * service refreshes the token once, stores the rotated pair, and retries that one call once. The `401` is recognised
  * structurally — [[HelixFailure.Unauthorized]] — and never by looking for words in a message, because Twitch may
  * reword its messages at any time and a rewording must not silently disable the recovery.
  */
final class TwitchAdminService(
    repository: SettingsRepository,
    helix: TwitchHelixApi,
    exchanger: TwitchTokenExchanger,
    pauseMillis: Long
) {

  private val log: Logger = LoggerFactory.getLogger(classOf[TwitchAdminService])

  /** Whether the dashboard can work, and everything it needs to explain itself when it cannot.
    *
    * Deliberately returns a value and not an `Either`: every "no" here is a normal state of an installation nobody has
    * finished configuring, so the endpoint behind this answers `200` in all of them.
    */
  def status(): TwitchAdminStatus =
    ready() match {
      case Right(session) =>
        val settings = session.settings
        TwitchAdminStatus(
          available = true,
          channel = settings.channel,
          broadcasterId = Some(session.broadcasterId),
          moderatorLogin = settings.botLogin,
          grantedScopes = settings.scopes,
          missingScopes = TwitchAdminService.missingScopes(settings.scopes),
          reason = None
        )
      case Left((settings, reason)) =>
        TwitchAdminStatus(
          available = false,
          channel = settings.channel,
          broadcasterId = settings.broadcasterId,
          moderatorLogin = settings.botLogin,
          grantedScopes = settings.scopes,
          missingScopes = TwitchAdminService.missingScopes(settings.scopes),
          reason = Some(reason)
        )
    }

  /** One page of the ban list, newest first. `limit` is 1..100 and defaults to 100. */
  def bans(cursor: Option[String], limit: Option[Int]): Either[AppError, TwitchBanPage] = {
    val requested = limit.getOrElse(TwitchAdminService.MaxPageSize)
    if (requested < 1 || requested > TwitchAdminService.MaxPageSize)
      Left(
        AppError.ValidationFailed(
          List(ValidationIssue("limit", s"must be between 1 and ${TwitchAdminService.MaxPageSize}"))
        )
      )
    else
      ready().left.map(unavailable).flatMap { session =>
        session
          .call(token =>
            helix.listBans(session.clientId, token, session.broadcasterId, session.moderatorId, cursor, requested)
          )
          .left
          .map(requestFailure)
      }
  }

  /** One page of the channel's moderator list.
    *
    * This is the one panel that needs a scope beyond the two the dashboard demands to be available at all, so a token
    * without `moderation:read` gets a refusal naming that scope rather than an unexplained empty table.
    */
  def moderators(cursor: Option[String]): Either[AppError, TwitchModeratorPage] =
    ready().left.map(unavailable).flatMap { session =>
      if (!session.settings.scopes.contains(TwitchAdminService.ScopeReadModerators))
        Left(
          AppError.TwitchUnavailable(
            s"The connected Twitch account's token does not carry the ${TwitchAdminService.ScopeReadModerators} " +
              "permission, which the moderator list needs — reconnect the account in Settings to grant it."
          )
        )
      else
        session
          .call(token => helix.listModerators(session.clientId, token, session.broadcasterId, cursor))
          .left
          .map(requestFailure)
    }

  /** Bans, or times out, everyone in `logins`.
    *
    * `durationSeconds` is what makes it one or the other, exactly as Twitch models it: absent is a permanent ban,
    * present (1..1209600, fourteen days) is a timeout that lifts itself.
    */
  def banMany(
      logins: List[String],
      durationSeconds: Option[Int],
      reason: Option[String]
  ): Either[AppError, BulkResult] = {
    val trimmedReason = reason.map(_.trim).filter(_.nonEmpty)
    val cleaned = cleanLogins(logins)
    for {
      duration <- validateDuration(durationSeconds)
      _ <- validateBulkSize(cleaned.size)
      result <- bulk(cleaned, Nil) { (session, token, userId) =>
        helix.ban(
          session.clientId,
          token,
          session.broadcasterId,
          session.moderatorId,
          userId,
          duration,
          trimmedReason
        )
      }
    } yield result
  }

  /** Lifts the ban or timeout on everyone named, whether by login or by id.
    *
    * The two lists exist because the two ways a person asks for an unban are not equally safe. `logins` is the
    * pasted-a-list-of-names path: the names have to be looked up, and a name can have moved to another account since
    * whenever it was written down. `targets` is the ban-list path: the row already carries the account's numeric id, so
    * the unban goes straight to that account with no lookup and therefore no chance of hitting a renamed login's new
    * owner. Both are optional and either may be empty; together they are capped at [[TwitchAdminService.MaxBulkUsers]].
    */
  def unbanMany(logins: List[String], targets: List[TwitchUnbanTarget]): Either[AppError, BulkResult] = {
    val cleaned = cleanLogins(logins)
    // Two rows naming the same account collapse to one, exactly as two spellings of one login do: a second unban of an
    // account the first one already freed would report a pointless failure. Note what is deliberately *not* done here:
    // a login in `logins` that happens to name the same account as one of `targets` is not detected, because finding
    // that out would need the very Helix lookup the id path exists to avoid. Such a request issues both calls, and the
    // second one comes back as Twitch's "not banned" refusal against that one entry.
    val distinctTargets = targets
      .foldLeft((Set.empty[String], Vector.empty[TwitchUnbanTarget])) { case ((seen, kept), target) =>
        if (seen.contains(target.userId)) (seen, kept) else (seen + target.userId, kept :+ target)
      }
      ._2
      .toList

    validateBulkSize(cleaned.size + distinctTargets.size).flatMap { _ =>
      bulk(cleaned, distinctTargets) { (session, token, userId) =>
        helix.unban(session.clientId, token, session.broadcasterId, session.moderatorId, userId)
      }
    }
  }

  // -------------------------------------------------------------------------------------------

  /** One entry of a batch as the loop below sees it: the name to put in the report, and the id to act on when there is
    * one. `userId` is `None` only for a login Twitch did not recognise.
    */
  private final case class BulkTarget(label: String, userId: Option[String], malformed: Boolean = false)

  /** The shared body of every bulk operation: work out each entry's (label, id) pair, then act on each one
    * independently.
    *
    * The two sources of that pair are the only difference between the paths. An entry of `targets` arrives with its id
    * already known and costs no lookup at all; every login in `logins` is resolved to an id in one Helix call before
    * the loop starts. Outcomes come back targets-first and then logins, each group in the order the request listed it,
    * so a client can line the report up against what it sent.
    *
    * The independence is the entire point of a bulk tool. A raid leaves a hundred accounts to ban, two of them are
    * already banned and one was deleted an hour ago, and the operator wants the other ninety-seven gone — so a refusal
    * on one user is recorded as that user's outcome and the loop carries on. The only failures that end the whole
    * request are the ones that make every remaining call pointless: not being configured, and Twitch refusing to
    * resolve the names at all.
    */
  private def bulk(
      logins: List[String],
      targets: List[TwitchUnbanTarget]
  )(
      action: (TwitchAdminService.Session, String, String) => Either[HelixFailure, Unit]
  ): Either[AppError, BulkResult] =
    ready().left.map(unavailable).flatMap { session =>
      resolveLogins(session, logins).map { resolved =>
        val entries = targets.map(target => BulkTarget(target.login, Some(target.userId))) ++ resolved
        // `foldLeft` rather than `map` only so that the pause below knows whether a request has already gone out;
        // the outcomes still come out in the order described above.
        val (outcomes, _) = entries.foldLeft((Vector.empty[BulkOutcome], false)) { case ((collected, issued), entry) =>
          entry.userId match {
            case None =>
              // Nothing was sent to Twitch for this one, so it is not an error of the request — it is this user's
              // outcome, and the batch continues.
              val why = if (entry.malformed) "not a valid Twitch login" else "no such Twitch account"
              (collected :+ BulkOutcome(entry.label, ok = false, Some(why)), issued)
            case Some(userId) =>
              // Twitch rate-limits moderation calls per channel. A short fixed pause between requests keeps a
              // hundred-user batch comfortably inside that limit; sending them as fast as the network allows would
              // earn a 429 partway through and turn a bulk tool into a coin flip.
              if (issued) pause()
              (collected :+ outcomeOf(entry.label, session.call(token => action(session, token, userId))), true)
          }
        }
        val results = outcomes.toList
        BulkResult(results.count(_.ok), results.count(!_.ok), results)
      }
    }

  /** Turns logins into batch entries with one Helix lookup, keeping the input order.
    *
    * An empty list skips the call entirely rather than asking Twitch about nobody: a request built only from ban-list
    * rows must not touch the users endpoint at all, which is what keeps it free of the rename race.
    */
  private def resolveLogins(
      session: TwitchAdminService.Session,
      logins: List[String]
  ): Either[AppError, List[BulkTarget]] = {
    // Only the well-formed names go to Twitch. The users endpoint answers 400 for the *whole* request when any one
    // `login` value is not a login at all (a pasted URL, `user.name`, a display name with a space or an emoji), and
    // that would turn one stray line in a hundred into "nothing was attempted". A malformed entry is instead recorded
    // as that entry's outcome, exactly as an unknown login is, and the rest of the batch goes ahead.
    val wellFormed = logins.filter(TwitchAdminService.isValidLogin)
    val resolved: Either[AppError, Map[String, TwitchUser]] =
      if (wellFormed.isEmpty) Right(Map.empty)
      else
        session.call(token => helix.resolveUsers(session.clientId, token, wellFormed)) match {
          case Left(failure) => Left(requestFailure(failure))
          case Right(users)  => Right(users.map(user => user.login.toLowerCase -> user).toMap)
        }
    resolved.map { byLogin =>
      logins.map { login =>
        if (TwitchAdminService.isValidLogin(login)) BulkTarget(login, byLogin.get(login.toLowerCase).map(_.id))
        else BulkTarget(login, None, malformed = true)
      }
    }
  }

  private def outcomeOf(login: String, result: Either[HelixFailure, Unit]): BulkOutcome = result match {
    case Right(_)                         => BulkOutcome(login, ok = true, None)
    case Left(HelixFailure.Message(text)) => BulkOutcome(login, ok = false, Some(text))
    case Left(HelixFailure.Unauthorized)  =>
      BulkOutcome(login, ok = false, Some("Twitch rejected the stored token — reconnect the account in Settings."))
  }

  private def pause(): Unit =
    if (pauseMillis > 0) Thread.sleep(pauseMillis)

  /** Cleans a list of logins: a leading `@` (people paste those out of chat) is dropped, blanks disappear, and two
    * spellings of one name count once, because banning `SomeUser` and `someuser` twice would report a pointless
    * "already banned" failure against a request that did nothing wrong.
    */
  private def cleanLogins(raw: List[String]): List[String] =
    raw
      .map(_.trim.stripPrefix("@").trim)
      .filter(_.nonEmpty)
      .foldLeft((Set.empty[String], Vector.empty[String])) { case ((seen, kept), login) =>
        val key = login.toLowerCase
        if (seen.contains(key)) (seen, kept) else (seen + key, kept :+ login)
      }
      ._2
      .toList

  /** Checks how many accounts a batch names, once every source of them has been cleaned and de-duplicated. The count is
    * the combined one: a request may name accounts by login and by id at the same time, and Twitch's limit does not
    * care which spelling they arrived in.
    */
  private def validateBulkSize(count: Int): Either[AppError, Unit] =
    if (count == 0)
      Left(AppError.ValidationFailed(List(ValidationIssue("users", "must name at least one Twitch account"))))
    else if (count > TwitchAdminService.MaxBulkUsers)
      Left(
        AppError.ValidationFailed(
          List(
            ValidationIssue(
              "users",
              s"must name at most ${TwitchAdminService.MaxBulkUsers} accounts, because Twitch resolves at most that " +
                "many names in one lookup"
            )
          )
        )
      )
    else Right(())

  private def validateDuration(durationSeconds: Option[Int]): Either[AppError, Option[Int]] =
    durationSeconds match {
      case Some(seconds)
          if seconds < TwitchAdminService.MinTimeoutSeconds || seconds > TwitchAdminService.MaxTimeoutSeconds =>
        Left(
          AppError.ValidationFailed(
            List(
              ValidationIssue(
                "durationSeconds",
                s"must be between ${TwitchAdminService.MinTimeoutSeconds} and " +
                  s"${TwitchAdminService.MaxTimeoutSeconds} seconds (fourteen days), or absent for a permanent ban"
              )
            )
          )
        )
      case other => Right(other)
    }

  /** Everything an acting method needs, or the settings plus one sentence saying what is missing.
    *
    * The ladder is ordered so that the first thing an operator has to fix is the first thing reported: a switched-off
    * integration is not worth complaining about a missing scope for.
    */
  private def ready(): Either[(TwitchSettings, String), TwitchAdminService.Session] = {
    val stored = repository.loadTwitch()
    if (!stored.enabled)
      Left((stored, "Twitch chat is switched off — turn it on in Settings."))
    else if (stored.channel.isEmpty)
      Left((stored, "No Twitch channel is configured — set one in Settings."))
    else if (stored.clientId.trim.isEmpty || stored.clientSecret.isEmpty)
      Left((stored, "The Twitch application's client id and client secret are not saved — add them in Settings."))
    else
      stored.accessToken match {
        case None        => Left((stored, "No Twitch account is connected — connect one in Settings."))
        case Some(token) =>
          identify(stored, token).flatMap { identified =>
            val missing = TwitchAdminService.missingRequiredScopes(identified.scopes)
            if (missing.nonEmpty)
              Left(
                (
                  identified,
                  s"The connected Twitch account's token does not carry ${missing.mkString(" or ")} — reconnect the " +
                    "account in Settings to grant the moderation permissions."
                )
              )
            else
              identified.botUserId match {
                case None =>
                  Left((identified, "Twitch did not say which account the stored token belongs to — reconnect it."))
                case Some(moderatorId) =>
                  // `identified` may carry a token this very request refreshed, so act with that one rather than the
                  // one read at the top: the refresh token that produced it has already been rotated away.
                  val session = new TwitchAdminService.Session(
                    identified,
                    identified.clientId.trim,
                    identified.accessToken.getOrElse(token),
                    moderatorId,
                    refresh
                  )
                  broadcasterId(identified, session).map { id =>
                    session.rememberBroadcaster(id)
                    session
                  }
              }
          }
      }
  }

  /** Fills in who the stored token belongs to and what it may do, asking Twitch only when that is not already known.
    *
    * Caching matters here: the status endpoint is asked on every visit to the dashboard, and validating each time would
    * spend a network round trip to learn something that changes only when the operator reconnects their account.
    *
    * The cache is keyed on `botUserId` alone, and deliberately not on the scope list as well. A token can legitimately
    * carry no scopes at all — an application token, or one from an implicit grant — and an empty scope list is
    * indistinguishable from "never read back", so a check that also demanded a non-empty list would re-validate such a
    * token forever. `botUserId` is written at the same moment as the scopes and by the same two places, so "the id is
    * known" already means "Twitch has been asked".
    *
    * A token that Twitch will not validate is not given up on straight away either: access tokens live about four
    * hours, so the usual reason for a refusal here is plain expiry, and one refresh recovers it. That retry has to live
    * in this method because it runs before a [[TwitchAdminService.Session]] exists, and the session is where the rest
    * of the request's single refresh-and-retry budget lives.
    */
  private def identify(stored: TwitchSettings, token: String): Either[(TwitchSettings, String), TwitchSettings] =
    if (stored.botUserId.isDefined) Right(stored)
    else
      exchanger.validateToken(token) match {
        case Right(info)  => Right(remember(stored, info))
        case Left(reason) =>
          refresh(stored) match {
            case Some(rotated) =>
              // Read the settings back: the refresh stored a new pair, and the rest of the request must act with it
              // rather than with the tokens loaded a moment ago, which Twitch has already retired.
              val refreshed = repository.loadTwitch()
              exchanger.validateToken(rotated) match {
                case Right(info)   => Right(remember(refreshed, info))
                case Left(refused) => Left((refreshed, uncheckable(refused)))
              }
            case None => Left((stored, uncheckable(reason)))
          }
      }

  /** Stores what Twitch said about the token and hands back the settings as they now read. */
  private def remember(settings: TwitchSettings, info: TwitchTokenInfo): TwitchSettings = {
    repository.updateTwitchAuth(
      botLogin = Some(info.login),
      botUserId = Some(info.userId),
      scopes = Some(info.scopes)
    )
    settings.copy(botLogin = Some(info.login), botUserId = Some(info.userId), scopes = info.scopes)
  }

  private def uncheckable(reason: String): String =
    s"The stored Twitch token could not be checked ($reason) — reconnect the account in Settings."

  /** The channel's numeric id, looked up from its login the first time and remembered afterwards. */
  private def broadcasterId(
      settings: TwitchSettings,
      session: TwitchAdminService.Session
  ): Either[(TwitchSettings, String), String] =
    settings.broadcasterId match {
      case Some(id) => Right(id)
      case None     =>
        session.call(token => helix.resolveUsers(settings.clientId.trim, token, List(settings.channel))) match {
          case Right(user :: _) =>
            repository.updateTwitchAuth(broadcasterId = Some(user.id))
            Right(user.id)
          case Right(Nil) =>
            Left((settings, s"Twitch does not know a channel called '${settings.channel}' — check it in Settings."))
          case Left(HelixFailure.Unauthorized) =>
            Left((settings, "Twitch rejected the stored token — reconnect the account in Settings."))
          case Left(HelixFailure.Message(text)) =>
            Left((settings, s"Twitch could not be asked about the channel: $text"))
        }
    }

  /** Spends one token refresh and stores the rotated pair. `None` when the settings lack what a refresh needs, or when
    * Twitch refused — both of which mean the caller should give up rather than retry.
    */
  private def refresh(settings: TwitchSettings): Option[String] =
    (settings.refreshToken, settings.clientSecret) match {
      case (Some(refreshToken), Some(secret)) if settings.clientId.trim.nonEmpty =>
        exchanger.refreshTokens(settings.clientId.trim, secret, refreshToken) match {
          case Right(pair) =>
            log.info("Refreshed the Twitch access token for a moderation call")
            // Twitch rotates the refresh token too, so the new pair has to be stored now — the old refresh token may
            // already be dead. A field-level patch, not a load-then-save, so an operator saving the settings form at
            // the same moment is not silently reverted.
            repository.updateTwitchAuth(accessToken = Some(pair.accessToken), refreshToken = pair.refreshToken)
            Some(pair.accessToken)
          case Left(reason) =>
            log.info("Refreshing the Twitch access token failed: {}", reason)
            None
        }
      case _ => None
    }

  private def unavailable(unready: (TwitchSettings, String)): AppError =
    AppError.TwitchUnavailable(unready._2)

  /** A Helix failure that ends the whole request, as opposed to one user's outcome inside a batch. */
  private def requestFailure(failure: HelixFailure): AppError = failure match {
    case HelixFailure.Unauthorized =>
      AppError.TwitchUnavailable("Twitch rejected the stored token — reconnect the account in Settings.")
    case HelixFailure.Message(text) => AppError.TwitchUnavailable(s"Twitch could not answer: $text")
  }
}

object TwitchAdminService {

  /** Reading the ban list. */
  val ScopeReadBans = "moderator:read:banned_users"

  /** Banning, timing out and unbanning. */
  val ScopeManageBans = "moderator:manage:banned_users"

  /** Reading the moderator list — needed by one panel only, so its absence does not make the dashboard unavailable. */
  val ScopeReadModerators = "moderation:read"

  /** Without these two there is no dashboard: one reads the list, the other changes it. */
  val RequiredScopes: List[String] = List(ScopeReadBans, ScopeManageBans)

  /** Every scope this feature ever uses, for the "reconnect to grant these" line in the admin UI. */
  val UsedScopes: List[String] = RequiredScopes :+ ScopeReadModerators

  /** Twitch's own page size limit for the moderation endpoints, and the default: a ban list is usually short, and one
    * request that returns all of it beats three that return a third each.
    */
  val MaxPageSize = 100

  /** How many accounts one bulk request may name. Twitch resolves at most 100 logins in a single lookup, so this is the
    * number that keeps a batch to exactly one resolution call.
    */
  val MaxBulkUsers = 100

  /** The shape of a Twitch login: letters, digits and underscores, up to 25 of them. Twitch's users endpoint refuses
    * the entire request when any one `login` value breaks this rule, so a bulk request checks each name here first.
    */
  private val LoginPattern: Regex = "[A-Za-z0-9_]{1,25}".r

  def isValidLogin(login: String): Boolean = LoginPattern.matches(login)

  val MinTimeoutSeconds = 1

  /** Fourteen days, Twitch's longest timeout. Anything longer has to be a permanent ban. */
  val MaxTimeoutSeconds = 1209600

  /** How long to wait between two moderation requests in a batch — see the comment at the call site. */
  val RateLimitPauseMillis = 60L

  def missingRequiredScopes(granted: List[String]): List[String] =
    RequiredScopes.filterNot(granted.contains)

  def missingScopes(granted: List[String]): List[String] =
    UsedScopes.filterNot(granted.contains)

  /** One request's worth of Helix access: the ids every call carries, and the token — which can change underneath, as
    * the retry below is the whole reason this is an object and not five loose parameters.
    *
    * `broadcasterId` starts empty because resolving it is itself a Helix call that must be able to refresh the token,
    * and [[withBroadcaster]] fills it in once that call has answered.
    */
  private final class Session(
      val settings: TwitchSettings,
      val clientId: String,
      initialToken: String,
      val moderatorId: String,
      refresh: TwitchSettings => Option[String]
  ) {

    private var token: String = initialToken
    private var refreshSpent: Boolean = false
    private var resolvedBroadcasterId: String = ""

    def broadcasterId: String = resolvedBroadcasterId

    /** Records the channel id once the lookup that needed this very session has answered. */
    def rememberBroadcaster(id: String): Unit = resolvedBroadcasterId = id

    /** Runs one Helix call, and on a `401` refreshes the token once and runs it exactly once more.
      *
      * "Once" is counted per request, not per call: a bulk operation that meets an expired token on its third user
      * refreshes once and the other ninety-seven carry on with the new token. A second `401` — a revoked token, a
      * missing scope — is returned as it is, because retrying it again would only be a slower way to fail.
      */
    def call[A](action: String => Either[HelixFailure, A]): Either[HelixFailure, A] =
      action(token) match {
        case Left(HelixFailure.Unauthorized) if !refreshSpent =>
          refreshSpent = true
          refresh(settings) match {
            case Some(rotated) =>
              token = rotated
              action(rotated)
            case None => Left(HelixFailure.Unauthorized)
          }
        case other => other
      }
  }
}
