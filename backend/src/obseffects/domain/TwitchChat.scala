package obseffects.domain

import java.nio.charset.StandardCharsets
import java.security.MessageDigest

import scala.util.matching.Regex

/** The domain of "what is happening in the stream's Twitch chat".
  *
  * ==Why the backend is the chat client, and not the browser==
  *
  * The same reasoning as OBS audio (see `ObsAudio.scala`), with one addition. An OBS browser source cannot sign in, so
  * if the page connected to Twitch itself, any token would have to be handed out from a public endpoint. Keeping the
  * connection in the backend means: tokens never leave the server, one upstream connection serves every overlay,
  * history is recorded even when no browser is open, and every overlay sees the same stream of messages.
  *
  * ==Anonymous first==
  *
  * Twitch's IRC interface allows *anonymous* reads: connect with a nickname of `justinfan` plus digits and no password
  * at all, and public chat is readable. That is what makes this feature degrade gracefully — a channel name alone is
  * enough to show chat, and a stored token only upgrades the connection (and unlocks a future bot identity), it is
  * never required.
  */

/** What kind of chat event a [[ChatMessage]] describes.
  *
  * Five kinds and no more, because five is what the overlays draw differently: an ordinary line, a subscription, a
  * gifted subscription, a cheer (a message carrying bits), and a raid. Follows are absent on purpose — Twitch only
  * reports them over EventSub, not over chat, and this integration reads chat.
  */
enum ChatEventKind {

  /** An ordinary chat line. */
  case Chat

  /** A new subscription or a resubscription. `data` carries `tier` and, when Twitch reported it, `months`. */
  case Sub

  /** One or more subscriptions gifted to others. `data` carries `total`. */
  case GiftSub

  /** A chat line that spent bits. `data` carries `bits`. */
  case Cheer

  /** Another channel sent its viewers here. `data` carries `viewers`. */
  case Raid
}

object ChatEventKind {

  /** The wire spelling, shared by the JSON API and the stored documents. Snake case because `gift_sub` is two words and
    * the frontend reads these as plain strings.
    */
  def wireName(kind: ChatEventKind): String = kind match {
    case ChatEventKind.Chat    => "chat"
    case ChatEventKind.Sub     => "sub"
    case ChatEventKind.GiftSub => "gift_sub"
    case ChatEventKind.Cheer   => "cheer"
    case ChatEventKind.Raid    => "raid"
  }

  def fromWire(raw: String): Option[ChatEventKind] = raw match {
    case "chat"     => Some(ChatEventKind.Chat)
    case "sub"      => Some(ChatEventKind.Sub)
    case "gift_sub" => Some(ChatEventKind.GiftSub)
    case "cheer"    => Some(ChatEventKind.Cheer)
    case "raid"     => Some(ChatEventKind.Raid)
    case _          => None
  }
}

/** One piece of a chat message: either literal text or an inline image (a Twitch emote).
  *
  * A message is a *list* of these rather than a string plus a lookup table, so an overlay renders it left to right
  * without knowing anything about emote syntax. The split is computed on the backend from the position data Twitch
  * sends with every message.
  */
enum ChatPart {

  /** Literal text, exactly as typed (minus the emotes that were cut out around it). */
  case Text(text: String)

  /** An inline image.
    *
    * @param name
    *   the emote's code, e.g. `Kappa` — what an overlay draws if the image fails to load.
    * @param url
    *   the static image on Twitch's CDN.
    * @param animatedUrl
    *   the animated variant of the same CDN path. Twitch serves it for animated emotes and falls back to the static
    *   image for the rest, so it is always offered and an overlay chooses which to load.
    */
  case Image(name: String, url: String, animatedUrl: Option[String])
}

/** One chat event, exactly as every overlay receives it.
  *
  * @param id
  *   Twitch's message id when it sent one, otherwise a server-generated one. Stable, so an overlay can deduplicate a
  *   message it sees both in a snapshot and live.
  * @param at
  *   epoch milliseconds when the backend received it.
  * @param channel
  *   the channel it happened in, lowercase, without the `#`.
  * @param username
  *   the sender's login, lowercase.
  * @param displayName
  *   the sender's display name, which may differ from the login in capitalisation and in non-Latin scripts.
  * @param color
  *   a `#rrggbb` colour for the sender: their chosen chat colour when Twitch sent one, otherwise derived from the
  *   username hash so it is stable across sessions — see [[ChatMessage.colorFor]].
  * @param seed
  *   a deterministic per-user number in 0..0xFFFFFF, for overlays that draw procedural avatars or motifs. Same
  *   derivation as the old twitch-vizer project, so ported scenes look identical for the same user.
  * @param event
  *   what kind of event this is.
  * @param text
  *   the plain text: the typed message for chat and cheers, Twitch's system message ("X subscribed at Tier 1...") for
  *   the rest.
  * @param parts
  *   [[text]] split into text and emote-image pieces, in reading order.
  * @param data
  *   the event-specific numbers: `tier`/`months` for subs, `total` for gift subs, `bits` for cheers, `viewers` for
  *   raids. Empty for ordinary chat.
  */
final case class ChatMessage(
    id: String,
    at: Long,
    channel: String,
    username: String,
    displayName: String,
    color: String,
    seed: Int,
    event: ChatEventKind,
    text: String,
    parts: List[ChatPart],
    data: Map[String, JsonValue]
)

object ChatMessage {

  /** A stable colour for a user who never chose one.
    *
    * `#` plus the first three bytes of SHA-256 of the username, as hex. Hashing rather than randomising means the same
    * user gets the same colour in every session and on every overlay, with no state kept anywhere.
    */
  def colorFor(username: String): String = {
    val digest = sha256(username)
    f"#${digest(0) & 0xff}%02x${digest(1) & 0xff}%02x${digest(2) & 0xff}%02x"
  }

  /** A stable per-user number for procedural visuals: the first four bytes of SHA-256 of the username, read big-endian,
    * masked to 24 bits. The exact derivation twitch-vizer used, kept bit-for-bit so ported scenes draw the same avatar
    * for the same user.
    */
  def seedFor(username: String): Int = {
    val digest = sha256(username)
    val value =
      ((digest(0) & 0xff) << 24) | ((digest(1) & 0xff) << 16) | ((digest(2) & 0xff) << 8) | (digest(3) & 0xff)
    value & 0xffffff
  }

  private def sha256(value: String): Array[Byte] =
    MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))
}

/** How to reach Twitch chat, as the operator configures it. Stored as a single document in the `settings` collection,
  * beside (not inside) the OBS audio document, so a token refresh rewriting this one can never race a save of that one.
  *
  * @param enabled
  *   whether to connect at all. `false` is the shipped default; overlays fall back to a simulated feed.
  * @param channel
  *   the channel to join, lowercase, without the `#`. Empty means "not configured yet", which behaves like disabled.
  * @param clientId
  *   the Twitch application's client id, needed only for the OAuth flows. Empty when not configured.
  * @param clientSecret
  *   the application's client secret. Write-only over the API, exactly like the obs-websocket password: the admin is
  *   told whether one is set, never what it is.
  * @param accessToken
  *   a user access token. `None` means connect anonymously, which still reads public chat.
  * @param refreshToken
  *   the refresh token issued alongside the access token, used to rotate it when it expires. Refreshing needs the
  *   client secret too, so a manually pasted token without one simply expires instead of rotating.
  * @param botLogin
  *   the login the access token belongs to, learned from Twitch's validate endpoint. Purely informational for the admin
  *   panel ("connected as ..."); rediscovered on every authenticated connect.
  * @param broadcasterId
  *   the channel's numeric Twitch user id, looked up once from [[channel]] and remembered. Twitch's moderation API
  *   addresses a channel by id and never by name, so without this every moderation call would need a lookup first.
  *   `None` means "not looked up yet", which is also what a channel change resets it to.
  * @param botUserId
  *   the numeric user id of the account the access token belongs to — the *moderator id* every moderation call carries,
  *   because Twitch wants to know which moderator is acting, not only in which channel.
  * @param scopes
  *   the permissions the stored access token actually carries, learned from Twitch's validate endpoint. Empty means
  *   "not known yet", which is not the same as "none": a token issued before this field existed still has its scopes,
  *   they have simply never been read back. Safe to show in the admin panel — a scope name is a permission label, not a
  *   credential.
  */
final case class TwitchSettings(
    enabled: Boolean,
    channel: String,
    clientId: String,
    clientSecret: Option[String],
    accessToken: Option[String],
    refreshToken: Option[String],
    botLogin: Option[String],
    broadcasterId: Option[String] = None,
    botUserId: Option[String] = None,
    scopes: List[String] = Nil
)

object TwitchSettings {

  /** What an installation has before anybody configures anything: switched off and empty, because unlike the OBS URL
    * there is no channel name that most people will want.
    */
  val Default: TwitchSettings =
    TwitchSettings(
      enabled = false,
      channel = "",
      clientId = "",
      clientSecret = None,
      accessToken = None,
      refreshToken = None,
      botLogin = None,
      broadcasterId = None,
      botUserId = None,
      scopes = Nil
    )

  /** A Twitch login: letters, digits and underscores, at most 25 of them. The rule Twitch itself applies to account
    * names, so anything else can be rejected before a connection attempt fails on it.
    */
  private val ChannelPattern: Regex = "[A-Za-z0-9_]{1,25}".r

  val MaxClientIdLength = 200

  /** Validates and normalises a channel name.
    *
    * Deliberately forgiving about spelling: people paste `#SomeChannel` or `SomeChannel` from various places, and both
    * mean the lowercase login `somechannel` — IRC channel names are the login with a `#` in front, and Twitch logins
    * are lowercase. An empty result is valid and means "not configured", so a form can be saved half-filled.
    */
  def parseChannel(raw: String): Either[String, String] = {
    val trimmed = raw.trim.stripPrefix("#")
    if (trimmed.isEmpty) Right("")
    else if (!ChannelPattern.matches(trimmed))
      Left("must be a Twitch channel name: letters, digits and underscores, at most 25 characters")
    else Right(trimmed.toLowerCase)
  }

  /** Normalises a client id: trimmed, empty allowed (the OAuth flows are optional), bounded to keep the stored document
    * sane.
    */
  def parseClientId(raw: String): Either[String, String] = {
    val trimmed = raw.trim
    if (trimmed.length > MaxClientIdLength) Left(s"must be at most $MaxClientIdLength characters")
    else Right(trimmed)
  }
}

/** What the backend's Twitch chat connection is doing right now, for the admin panel. Not stored; rebuilt from nothing
  * on every start, for the same reason as [[ObsConnectionStatus]].
  */
enum TwitchConnectionState {

  /** Switched off in the settings, or no channel is configured. Nothing is being attempted. */
  case Disabled

  /** Opening the connection, or waiting out the backoff before the next attempt. */
  case Connecting

  /** Reading public chat without a token. Everything an overlay needs works in this state. */
  case ConnectedAnonymous

  /** Connected with a valid access token. */
  case ConnectedAuthed

  /** The last attempt failed. Retries continue; [[TwitchConnectionStatus.lastError]] says why. */
  case Failed
}

object TwitchConnectionState {

  /** The wire spelling. Snake case rather than the enum case's `toLowerCase`, because `connectedanonymous` is not a
    * word anyone should have to read in a JSON payload.
    */
  def wireName(state: TwitchConnectionState): String = state match {
    case TwitchConnectionState.Disabled           => "disabled"
    case TwitchConnectionState.Connecting         => "connecting"
    case TwitchConnectionState.ConnectedAnonymous => "connected_anonymous"
    case TwitchConnectionState.ConnectedAuthed    => "connected_authed"
    case TwitchConnectionState.Failed             => "failed"
  }
}

/** The live status of the Twitch chat connection.
  *
  * @param state
  *   the coarse state a badge colours itself from. Anonymous and authenticated are separate states because they answer
  *   the question the settings page is really asking: "did my token work?"
  * @param lastError
  *   why the last attempt failed — or, while connected anonymously with a token configured, why the token was not
  *   usable. `None` when nothing has gone wrong.
  * @param messagesReceived
  *   how many chat events have arrived since the current settings were applied. A connected state with this moving is
  *   the fastest proof the whole pipeline works.
  * @param channel
  *   the channel the connection is for, so the admin panel shows what is actually joined rather than what the unsaved
  *   form says.
  */
final case class TwitchConnectionStatus(
    state: TwitchConnectionState,
    lastError: Option[String],
    messagesReceived: Long,
    channel: Option[String]
)

object TwitchConnectionStatus {

  /** The status of a connection that has not been attempted. */
  val Disabled: TwitchConnectionStatus =
    TwitchConnectionStatus(TwitchConnectionState.Disabled, None, 0L, None)
}
