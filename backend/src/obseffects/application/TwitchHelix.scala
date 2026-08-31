package obseffects.application

import java.time.Instant

/** What the application needs from Twitch's *Helix* API — the ordinary REST API at `api.twitch.tv`, as opposed to the
  * IRC interface the chat connection uses and the `id.twitch.tv` endpoints [[TwitchTokenExchanger]] covers.
  *
  * A port in the same sense as those two: the infrastructure implementation (`infrastructure/twitch/TwitchHelixClient`)
  * speaks HTTP, and a test hands the service a fake. Nothing in this file knows that HTTP exists, which is what makes
  * the moderation use cases testable without a network.
  *
  * Every method takes the caller's `clientId` and `accessToken` explicitly instead of holding them. The stored token
  * can be rotated in the middle of a batch of calls (see [[TwitchAdminService]]'s refresh-and-retry), and a client that
  * cached the old one would keep presenting a dead credential.
  */
trait TwitchHelixApi {

  /** Looks up accounts by login name. Twitch accepts at most 100 logins in one request, which is exactly why the bulk
    * operations cap a batch at 100: the whole batch resolves in a single call.
    *
    * A login Twitch does not know is simply absent from the answer rather than being an error, so the caller compares
    * what it asked for against what came back.
    */
  def resolveUsers(clientId: String, accessToken: String, logins: List[String]): Either[HelixFailure, List[TwitchUser]]

  /** One page of the channel's ban list, newest first, with the cursor for the page after it. */
  def listBans(
      clientId: String,
      accessToken: String,
      broadcasterId: String,
      moderatorId: String,
      cursor: Option[String],
      limit: Int
  ): Either[HelixFailure, TwitchBanPage]

  /** Bans a user, or times them out.
    *
    * Twitch models both as the same call, and the only difference is this parameter: `durationSeconds = None` is a
    * permanent ban, `Some(n)` with n in 1..1209600 (fourteen days, Twitch's maximum) is a timeout that lifts itself.
    * That is why there is no separate `timeout` method — inventing one would suggest a second Twitch endpoint that does
    * not exist.
    */
  def ban(
      clientId: String,
      accessToken: String,
      broadcasterId: String,
      moderatorId: String,
      userId: String,
      durationSeconds: Option[Int],
      reason: Option[String]
  ): Either[HelixFailure, Unit]

  /** Lifts a ban or a timeout. */
  def unban(
      clientId: String,
      accessToken: String,
      broadcasterId: String,
      moderatorId: String,
      userId: String
  ): Either[HelixFailure, Unit]

  /** One page of the channel's moderators, with the cursor for the page after it. */
  def listModerators(
      clientId: String,
      accessToken: String,
      broadcasterId: String,
      cursor: Option[String]
  ): Either[HelixFailure, TwitchModeratorPage]
}

/** Why a Helix call did not answer with data.
  *
  * Two cases rather than one string, and the split is load-bearing: an expired access token is the one failure the
  * caller can *fix* (refresh it and try again), and telling it apart from every other failure must not depend on
  * matching words inside an error message. Twitch is free to reword "Invalid OAuth token" tomorrow; it is not free to
  * stop answering 401.
  */
enum HelixFailure {

  /** Twitch answered `401`: the access token is expired, was revoked, or never carried the scope this call needs. */
  case Unauthorized

  /** Anything else, already reduced to one sentence an operator can read — a network problem, a `400` naming what was
    * wrong with the request, a `429` saying how long to wait.
    */
  case Message(text: String)
}

/** One Twitch account, as the users endpoint describes it. */
final case class TwitchUser(id: String, login: String, displayName: String)

/** One entry of a channel's ban list.
  *
  * @param expiresAt
  *   when a timeout lifts itself, or `None` for a permanent ban. Twitch sends an empty string for "permanent", which
  *   this model normalises to an absent value so no consumer has to know that quirk.
  */
final case class TwitchBan(
    userId: String,
    login: String,
    displayName: String,
    reason: Option[String],
    moderatorLogin: Option[String],
    createdAt: Option[Instant],
    expiresAt: Option[Instant]
)

/** A page of banned users plus the cursor that fetches the next one.
  *
  * Twitch's paging is cursor-based, not page-numbered: `cursor` is an opaque string meaning "carry on from here", and
  * `None` means this was the last page. There is deliberately no total count, because Twitch does not send one.
  */
final case class TwitchBanPage(bans: List[TwitchBan], cursor: Option[String])

/** One moderator of the channel. */
final case class TwitchModerator(userId: String, login: String, displayName: String)

/** A page of moderators plus the next cursor — same paging shape as [[TwitchBanPage]]. */
final case class TwitchModeratorPage(moderators: List[TwitchModerator], cursor: Option[String])
