package obseffects.infrastructure.twitch

import obseffects.domain.JsonValue.{JsonNumber, JsonString}
import obseffects.domain.{ChatEventKind, ChatMessage, ChatPart, JsonValue}
import org.slf4j.{Logger, LoggerFactory}

import java.net.URI
import java.net.http.{HttpClient, WebSocket}
import java.time.{Clock, Duration as JDuration}
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.{CompletableFuture, CompletionStage}

import scala.annotation.tailrec

/** A client for one connection to Twitch chat, speaking just enough IRC to read messages.
  *
  * ==Why there is no library here==
  *
  * The same reasoning as `ObsWebSocketClient`, whose shape this class copies deliberately: Java's own WebSocket client
  * is already on the classpath, and Twitch's chat protocol — IRC with a small extension for message metadata — needs a
  * few hundred lines of string handling, not a dependency on a network-facing code path.
  *
  * ==The protocol, for anyone who has not met it==
  *
  * Twitch chat is IRC (Internet Relay Chat, a line-based text protocol from 1993) served over a WebSocket at
  * `wss://irc-ws.chat.twitch.tv`. Each WebSocket text message carries one or more lines separated by `\r\n`, and each
  * line has the shape:
  *
  * {{{
  * @tag1=value;tag2=value :nick!user@host COMMAND param1 param2 :trailing parameter with spaces
  * }}}
  *
  *   - The `@tags` block is IRCv3's metadata extension. Twitch puts everything interesting there: the sender's display
  *     name and colour, the message id, emote positions, bits, and the subscription details of a `USERNOTICE`. It only
  *     appears because we ask for it with `CAP REQ`.
  *   - The `:prefix` says who sent the line; for chat lines it starts with the sender's login.
  *   - Everything after the command is parameters; a parameter starting with `:` runs to the end of the line and is the
  *     only one that may contain spaces (for `PRIVMSG` it is the chat text itself).
  *
  * The commands this client reacts to: `001` (login accepted), `PING` (answered with `PONG`, or Twitch disconnects us
  * after a few minutes), `RECONNECT` (Twitch asking us to reconnect, reported as a normal connection end so the
  * supervisor retries), `NOTICE` (where authentication failures arrive, as human-readable text), `PRIVMSG` (a chat
  * line, a cheer when it carries a `bits` tag) and `USERNOTICE` (subs, gift subs, raids).
  *
  * ==Anonymous and authenticated login==
  *
  * Twitch allows reading chat with no account at all: `NICK justinfan` plus digits and no `PASS`. With a token the
  * login is `PASS oauth:<token>` then `NICK <login the token belongs to>`. Which one this client does is decided by the
  * caller — it just sends the `nick` and optional `password` it was given, so the fallback policy lives in the
  * supervisor with the rest of the retry logic.
  *
  * ==Threading==
  *
  * Identical to `ObsWebSocketClient`: everything happens on the `HttpClient`'s callback threads, the fragment buffer is
  * the only accumulating state, the `ended` flag makes the end-of-connection report exactly-once, and the callbacks
  * handed to the constructor must be safe to call from an arbitrary thread. This class knows nothing about
  * reconnecting; that is `TwitchChatSupervisor`'s job.
  */
final class TwitchIrcClient(
    channel: String,
    nick: String,
    password: Option[String],
    clock: Clock,
    onMessage: ChatMessage => Unit,
    onConnected: () => Unit,
    onAuthFailure: String => Unit,
    onClosed: Option[String] => Unit
) {

  import TwitchIrcClient.*

  private val log: Logger = LoggerFactory.getLogger(classOf[TwitchIrcClient])

  /** The live socket, once the handshake is done. `None` until then and after closing. */
  private val socket = new AtomicReference[Option[WebSocket]](None)

  /** Whether [[onClosed]] has already been called — same exactly-once guard as `ObsWebSocketClient.ended`, protecting
    * the supervisor from starting two reconnect timers for one connection.
    */
  private val ended = new AtomicReference(false)

  /** The tail of the outgoing send queue.
    *
    * The JDK WebSocket forbids starting a text send while the previous one is still in flight, and the login sequence
    * is four sends issued back to back. Each new send is therefore chained onto the completion of the last. The
    * `synchronized` in [[send]] is what keeps two threads (the opening handshake and a `PING` arriving mid-login) from
    * both chaining onto the same predecessor; the reference itself only publishes the tail between them.
    */
  private val sendChain = new AtomicReference[CompletionStage[?]](CompletableFuture.completedFuture(null))

  /** Opens the connection. Returns immediately; everything afterwards happens in callbacks. Connect failures arrive as
    * a failed future and are funnelled into the same [[finish]] as everything else, so the supervisor treats "no
    * network" and "Twitch hung up" identically: wait, then try again.
    */
  def connect(): Unit = {
    log.info("Connecting to Twitch chat for #{} as {}", channel, nick)

    val _ = HttpClient
      .newBuilder()
      .connectTimeout(JDuration.ofMillis(ConnectTimeoutMillis))
      .build()
      .newWebSocketBuilder()
      .connectTimeout(JDuration.ofMillis(ConnectTimeoutMillis))
      .buildAsync(URI.create(ServerUrl), new Listener)
      .whenComplete { (ws, error) =>
        if (error != null) finish(Some(describeConnectFailure(error)))
        else socket.set(Some(ws))
      }
  }

  /** Closes the connection, if there is one. Safe to call more than once and from any thread. Best-effort, exactly like
    * the OBS client's close, and for the same reason: waiting for a vanished peer to complete the closing handshake
    * would block a settings save.
    */
  def close(): Unit = {
    socket.getAndSet(None).foreach { ws =>
      try {
        val _ = ws.sendClose(WebSocket.NORMAL_CLOSURE, "bye")
      } catch {
        case scala.util.control.NonFatal(e) => log.debug("Ignoring error while closing the Twitch connection", e)
      }
    }
    finish(None)
  }

  // -------------------------------------------------------------------------------------------
  // Protocol
  // -------------------------------------------------------------------------------------------

  /** Reports the end of this connection exactly once. `reason` is `None` for a close we asked for. */
  private def finish(reason: Option[String]): Unit =
    if (ended.compareAndSet(false, true)) onClosed(reason)

  /** The login sequence, sent the moment the socket opens.
    *
    * Order matters and is Twitch's: capabilities first (or the tags never arrive), then `PASS` before `NICK` (IRC reads
    * them as a pair), then the `JOIN`. Twitch accepts the `JOIN` immediately after `NICK` — there is no need to wait
    * for the `001` welcome, and not waiting keeps this a fire-and-forget sequence.
    */
  private def login(ws: WebSocket): Unit = {
    send(ws, "CAP REQ :twitch.tv/tags twitch.tv/commands")
    password.foreach(secret => send(ws, s"PASS $secret"))
    send(ws, s"NICK $nick")
    send(ws, s"JOIN #$channel")
  }

  /** Queues one outgoing line. See [[sendChain]] for why sends are serialised. */
  private def send(ws: WebSocket, line: String): Unit = synchronized {
    val next = sendChain
      .get()
      // `handle` swallows a predecessor's failure: one lost PONG must not wedge the queue forever, and a send that
      // failed because the socket died is about to be followed by the close callback anyway.
      .handle((_, _) => null)
      .thenCompose(_ => ws.sendText(line, true))
    sendChain.set(next)
  }

  /** Handles one complete IRC line. */
  private def handleLine(ws: WebSocket, line: String): Unit =
    parseLine(line).foreach { message =>
      message.command match {
        case "PING" =>
          // Unanswered, Twitch closes the connection a few minutes later — quietly, which would look like random
          // disconnects every five minutes and nothing in any log to say why.
          send(ws, pongFor(message))

        case "001" =>
          onConnected()

        case "RECONNECT" =>
          // Twitch sends this before restarting an edge server. It is an instruction, not an error: drop the
          // connection and let the supervisor open a fresh one through its normal retry path.
          finish(Some("Twitch asked this connection to reconnect"))
          close()

        case "NOTICE" =>
          // Login failures arrive here as text rather than as a status code. The supervisor decides what to do —
          // refresh the token or fall back to anonymous — so this only recognises and forwards them.
          authFailureReason(message).foreach(onAuthFailure)

        case "PRIVMSG" | "USERNOTICE" =>
          // The fallback id is only used when Twitch did not send an `id` tag, which modern Twitch always does.
          chatMessage(message, clock.millis(), fallbackId = UUID.randomUUID().toString).foreach(onMessage)

        case _ =>
          // JOIN echoes, ROOMSTATE, USERSTATE, CLEARCHAT and friends: real commands, nothing an overlay draws.
          ()
      }
    }

  /** The listener the Java WebSocket client calls back into. Fragments accumulate exactly as in `ObsWebSocketClient`,
    * and additionally one WebSocket message can carry several IRC lines, so the complete text is split on line breaks
    * before handling.
    */
  private final class Listener extends WebSocket.Listener {

    private val buffer = new AtomicReference(new StringBuilder)

    override def onOpen(ws: WebSocket): Unit = {
      login(ws)
      ws.request(1)
    }

    override def onText(ws: WebSocket, data: CharSequence, last: Boolean): CompletionStage[?] = {
      val accumulated = buffer.get()
      val _ = accumulated.append(data)
      if (last) {
        val complete = accumulated.toString
        buffer.set(new StringBuilder)
        complete.split("\r\n").iterator.filter(_.nonEmpty).foreach { line =>
          try handleLine(ws, line)
          catch {
            case scala.util.control.NonFatal(e) =>
              // One unparseable line must never end the connection — chat keeps flowing, and dropping the stream
              // over a single odd message would take every overlay down with it.
              log.warn("Failed to handle a Twitch chat line", e)
          }
        }
      }
      ws.request(1)
      null
    }

    override def onClose(ws: WebSocket, statusCode: Int, reason: String): CompletionStage[?] = {
      finish(closeExplanation(statusCode, reason))
      null
    }

    override def onError(ws: WebSocket, error: Throwable): Unit =
      finish(Some(Option(error.getMessage).getOrElse(error.getClass.getSimpleName)))
  }
}

object TwitchIrcClient {

  /** Twitch's IRC-over-WebSocket endpoint. There is exactly one, so it is a constant rather than a setting. */
  val ServerUrl = "wss://irc-ws.chat.twitch.tv:443"

  /** How long to wait for the socket to open before giving up and letting the supervisor retry. */
  val ConnectTimeoutMillis = 5000

  /** The anonymous nickname for a read-only connection: `justinfan` plus digits, a magic name Twitch's chat servers
    * accept with no `PASS`. The digits only exist so two anonymous connections do not collide, hence the caller
    * supplies any number it likes and it is folded into a stable range.
    */
  def anonymousNick(discriminator: Int): String = s"justinfan${Math.floorMod(discriminator, 100000)}"

  /** One parsed IRC line: the IRCv3 tags (values already unescaped), the optional sender prefix, the command, and the
    * parameters with the trailing parameter — the only one that may contain spaces — as the last entry.
    */
  final case class IrcMessage(
      tags: Map[String, String],
      prefix: Option[String],
      command: String,
      params: List[String]
  )

  /** One emote occurrence from the `emotes` tag: which emote, and which slice of the message text it covers. `start`
    * and `end` are both inclusive, exactly as Twitch sends them, and they index Unicode code points of the message —
    * not UTF-16 units, which matters as soon as anyone puts an emoji (an astral character, two UTF-16 units) before an
    * emote. [[messageParts]] does the conversion.
    */
  final case class EmoteSpan(id: String, start: Int, end: Int)

  /** Parses one raw line into its four sections. `None` for a line too malformed to carry a command — which is dropped,
    * because a chat reader has nothing useful to do with it and must not die over it.
    */
  def parseLine(raw: String): Option[IrcMessage] = {
    val line = raw.stripSuffix("\r")
    val (tags, afterTags) = cutSection(line, marker = '@', parseTags)
    val (prefix, afterPrefix) = cutSection(afterTags, marker = ':', identity)
    parseParams(afterPrefix) match {
      case command :: params if command.nonEmpty => Some(IrcMessage(tags.getOrElse(Map.empty), prefix, command, params))
      case _                                     => None
    }
  }

  /** Splits off a space-terminated leading section introduced by `marker`, converting it with `read`. Shared by the
    * tags block and the prefix, which have the same shape apart from their marker character.
    */
  private def cutSection[A](line: String, marker: Char, read: String => A): (Option[A], String) =
    if (line.headOption.contains(marker)) {
      val space = line.indexOf(' ')
      if (space < 0) (None, "")
      else (Some(read(line.substring(1, space))), line.substring(space + 1).dropWhile(_ == ' '))
    } else (None, line)

  /** Splits `COMMAND a b :the rest` into `List("COMMAND", "a", "b", "the rest")`. The first parameter starting with `:`
    * is the *trailing* parameter: it runs to the end of the line, spaces included, and loses its colon.
    */
  private def parseParams(text: String): List[String] = {
    @tailrec
    def loop(rest: String, acc: List[String]): List[String] =
      if (rest.isEmpty) acc.reverse
      else if (rest.startsWith(":")) (rest.substring(1) :: acc).reverse
      else {
        val space = rest.indexOf(' ')
        if (space < 0) (rest :: acc).reverse
        else loop(rest.substring(space + 1).dropWhile(_ == ' '), rest.substring(0, space) :: acc)
      }
    loop(text, Nil)
  }

  /** The `key=value;key=value` tag block. A key with no `=` (or nothing after it) has the empty string as its value —
    * IRCv3 allows both spellings and means the same thing by them.
    */
  private def parseTags(block: String): Map[String, String] =
    block
      .split(';')
      .iterator
      .filter(_.nonEmpty)
      .map { entry =>
        val eq = entry.indexOf('=')
        if (eq < 0) entry -> ""
        else entry.substring(0, eq) -> unescapeTagValue(entry.substring(eq + 1))
      }
      .toMap

  /** Undoes IRCv3 tag-value escaping.
    *
    * Tag values may not contain the characters that structure the tag block, so the spec escapes them: `\:` is `;`,
    * `\s` is a space, `\\` a backslash, `\r` and `\n` the line-ending characters. An unknown escape keeps the escaped
    * character as itself and a lone trailing backslash is dropped — both exactly what the spec says clients must do,
    * and both reachable in the wild because `system-msg` values are written by Twitch's various backends.
    */
  def unescapeTagValue(value: String): String = {
    val out = new StringBuilder(value.length)
    @tailrec
    def loop(index: Int): Unit =
      if (index < value.length) {
        val current = value.charAt(index)
        if (current != '\\' || index == value.length - 1) {
          // A lone trailing backslash falls into this branch and is dropped rather than kept.
          if (current != '\\') { val _ = out.append(current) }
          loop(index + 1)
        } else {
          val escaped = value.charAt(index + 1) match {
            case ':'   => ';'
            case 's'   => ' '
            case '\\'  => '\\'
            case 'r'   => '\r'
            case 'n'   => '\n'
            case other => other
          }
          val _ = out.append(escaped)
          loop(index + 2)
        }
      }
    loop(0)
    out.toString
  }

  /** Parses the `emotes` tag: `25:0-4,12-16/1902:6-10` means emote 25 covers characters 0..4 and 12..16, emote 1902
    * covers 6..10. Malformed pieces are skipped rather than failing the message — a chat line with one odd emote is
    * still a chat line.
    */
  def parseEmotes(tag: String): List[EmoteSpan] =
    tag
      .split('/')
      .iterator
      .flatMap { group =>
        group.split(':') match {
          case Array(id, ranges) if id.nonEmpty =>
            ranges.split(',').iterator.flatMap { range =>
              range.split('-') match {
                case Array(start, end) =>
                  for {
                    from <- start.toIntOption
                    to <- end.toIntOption
                  } yield EmoteSpan(id, from, to)
                case _ => None
              }
            }
          case _ => Iterator.empty
        }
      }
      .toList
      .sortBy(_.start)

  /** Splits message text into text and emote-image parts using the spans from [[parseEmotes]].
    *
    * The emote's *name* is taken from the text slice the span covers rather than from any lookup table — that is the
    * whole trick of the `emotes` tag, and it is why no emote catalogue has to exist anywhere in this backend. Spans
    * that fall outside the text or overlap an earlier one are dropped: position data is client input, and a bad index
    * must degrade to plain text, not to an exception.
    *
    * Twitch's offsets count Unicode code points, while `String.substring` counts UTF-16 units — an emoji before an
    * emote makes the two disagree, so each span is converted with `offsetByCodePoints` before slicing.
    */
  def messageParts(text: String, spans: List[EmoteSpan]): List[ChatPart] = {
    val codePoints = text.codePointCount(0, text.length)
    val usable = spans
      .filter(span => span.start >= 0 && span.end >= span.start && span.end < codePoints)
      .map { span =>
        // The inclusive code-point end maps to an inclusive UTF-16 end by converting the *exclusive* bound and
        // stepping back one unit — stepping the start forward instead could land mid-surrogate-pair.
        span.copy(
          start = text.offsetByCodePoints(0, span.start),
          end = text.offsetByCodePoints(0, span.end + 1) - 1
        )
      }
    val (cursor, collected) = usable.foldLeft((0, List.empty[ChatPart])) { case ((from, acc), span) =>
      if (span.start < from) (from, acc) // overlaps the previous span; keep the earlier reading
      else {
        val before = text.substring(from, span.start)
        val name = text.substring(span.start, span.end + 1)
        val withText = if (before.isEmpty) acc else ChatPart.Text(before) :: acc
        (span.end + 1, ChatPart.Image(name, staticEmoteUrl(span.id), Some(animatedEmoteUrl(span.id))) :: withText)
      }
    }
    val tail = text.substring(cursor)
    val all = if (tail.isEmpty) collected else ChatPart.Text(tail) :: collected
    all.reverse
  }

  /** The static image for an emote id on Twitch's CDN, at the largest size (3.0) so overlays can scale down. */
  def staticEmoteUrl(id: String): String = s"https://static-cdn.jtvnw.net/emoticons/v2/$id/static/dark/3.0"

  /** The animated variant of the same path. Twitch serves the static image from it for emotes that have no animation,
    * so offering it unconditionally is safe.
    */
  def animatedEmoteUrl(id: String): String = s"https://static-cdn.jtvnw.net/emoticons/v2/$id/animated/dark/3.0"

  /** The reply to a `PING`: a `PONG` echoing the server's token, which is how it matches answer to question. */
  def pongFor(message: IrcMessage): String =
    s"PONG :${message.params.lastOption.getOrElse("tmi.twitch.tv")}"

  /** Recognises the `NOTICE` lines that mean the login was rejected.
    *
    * Twitch reports authentication failure as human-readable text rather than a code, so recognising it means knowing
    * the phrases. The three below are the ones its chat servers actually send; any other `NOTICE` (slow mode
    * announcements, host notifications) is not an error at all.
    */
  def authFailureReason(message: IrcMessage): Option[String] =
    message.params.lastOption.filter { text =>
      text.contains("Login authentication failed") ||
      text.contains("Login unsuccessful") ||
      text.contains("Improperly formatted auth")
    }

  /** Turns a `PRIVMSG` or `USERNOTICE` line into the [[ChatMessage]] every overlay receives, or `None` for any other
    * command. Pure: the timestamp and the id to use when Twitch sent none both come in as parameters, so tests can pin
    * them.
    */
  def chatMessage(message: IrcMessage, at: Long, fallbackId: String): Option[ChatMessage] =
    message.command match {
      case "PRIVMSG"    => privmsg(message, at, fallbackId)
      case "USERNOTICE" => usernotice(message, at, fallbackId)
      case _            => None
    }

  private def privmsg(message: IrcMessage, at: Long, fallbackId: String): Option[ChatMessage] =
    senderOf(message).map { username =>
      // A `/me` message arrives CTCP-wrapped as `\u0001ACTION <text>\u0001`. The wrapper must go before anything
      // else looks at the text: overlays should draw "waves", not "ACTION waves" — and Twitch's `emotes` offsets
      // are relative to the *inner* text, so stripping after computing parts would shift every emote by 8.
      val text = stripCtcpAction(trailingOf(message))
      val bits = message.tags.get("bits").flatMap(_.toLongOption)
      val spans = message.tags.get("emotes").map(parseEmotes).getOrElse(Nil)
      build(
        message = message,
        at = at,
        fallbackId = fallbackId,
        username = username,
        event = if (bits.isDefined) ChatEventKind.Cheer else ChatEventKind.Chat,
        text = text,
        parts = messageParts(text, spans),
        data = bits.fold(Map.empty[String, JsonValue])(value => Map("bits" -> JsonNumber(value.toDouble)))
      )
    }

  /** Unwraps a CTCP (Client-To-Client Protocol) `ACTION` — how IRC encodes `/me`: the text is framed as
    * `\u0001ACTION <text>\u0001` inside the ordinary trailing parameter. Anything else, including other CTCP commands
    * (which Twitch does not send), passes through untouched.
    */
  def stripCtcpAction(text: String): String =
    if (text.startsWith(CtcpActionPrefix)) text.substring(CtcpActionPrefix.length).stripSuffix("\u0001")
    else text

  private val CtcpActionPrefix = "\u0001ACTION "

  private def usernotice(message: IrcMessage, at: Long, fallbackId: String): Option[ChatMessage] =
    for {
      username <- senderOf(message)
      (event, data) <- message.tags.get("msg-id").flatMap {
        case "sub" | "resub"              => Some((ChatEventKind.Sub, subData(message)))
        case "subgift" | "submysterygift" => Some((ChatEventKind.GiftSub, giftData(message)))
        case "raid"                       => Some((ChatEventKind.Raid, raidData(message)))
        // Rituals, announcements, bits badge tiers and whatever Twitch invents next: none of them is an event the
        // overlays draw, and guessing a mapping would show viewers something wrong rather than nothing.
        case _ => None
      }
    } yield {
      // The system message ("SomeUser subscribed at Tier 1. They've...") is what a viewer should read; the trailing
      // parameter, when present, is the subscriber's own attached message and is the fallback when Twitch sent no
      // system text.
      val text = message.tags.get("system-msg").filter(_.nonEmpty).getOrElse(trailingOf(message))
      build(
        message = message,
        at = at,
        fallbackId = fallbackId,
        username = username,
        event = event,
        text = text,
        parts = if (text.isEmpty) Nil else List(ChatPart.Text(text)),
        data = data
      )
    }

  /** `{tier, months?}`: the plan tag is `1000`/`2000`/`3000` for the paid tiers and `Prime` for a Prime sub; it is
    * passed through lowercased rather than mapped to a number, so `prime` stays distinguishable from tier 1.
    */
  private def subData(message: IrcMessage): Map[String, JsonValue] = {
    val tier = message.tags.get("msg-param-sub-plan").filter(_.nonEmpty).getOrElse("1000").toLowerCase
    val months = message.tags.get("msg-param-cumulative-months").flatMap(_.toLongOption)
    Map[String, JsonValue]("tier" -> JsonString(tier)) ++
      months.map(value => "months" -> JsonNumber(value.toDouble))
  }

  /** `{total}`: the mass-gift count for `submysterygift`; a single `subgift` has no count tag and is one gift. */
  private def giftData(message: IrcMessage): Map[String, JsonValue] = {
    val total = message.tags.get("msg-param-mass-gift-count").flatMap(_.toLongOption).getOrElse(1L)
    Map("total" -> JsonNumber(total.toDouble))
  }

  /** `{viewers}`: how many people the raiding channel brought along. */
  private def raidData(message: IrcMessage): Map[String, JsonValue] = {
    val viewers = message.tags.get("msg-param-viewerCount").flatMap(_.toLongOption).getOrElse(0L)
    Map("viewers" -> JsonNumber(viewers.toDouble))
  }

  /** The shared tail of both message builders: identity fields that work the same for every event kind. */
  private def build(
      message: IrcMessage,
      at: Long,
      fallbackId: String,
      username: String,
      event: ChatEventKind,
      text: String,
      parts: List[ChatPart],
      data: Map[String, JsonValue]
  ): ChatMessage =
    ChatMessage(
      id = message.tags.get("id").filter(_.nonEmpty).getOrElse(fallbackId),
      at = at,
      channel = message.params.headOption.map(_.stripPrefix("#")).getOrElse(""),
      username = username,
      displayName = message.tags.get("display-name").filter(_.nonEmpty).getOrElse(username),
      color = message.tags.get("color").filter(_.nonEmpty).getOrElse(ChatMessage.colorFor(username)),
      seed = ChatMessage.seedFor(username),
      event = event,
      text = text,
      parts = parts,
      data = data
    )

  /** Who sent this line: the `login` tag when Twitch supplies one (`USERNOTICE` does), otherwise the nick half of the
    * prefix (`somelogin!somelogin@...`). `None` for a line with neither, which is not a chat event.
    */
  private def senderOf(message: IrcMessage): Option[String] =
    message.tags
      .get("login")
      .filter(_.nonEmpty)
      .orElse(message.prefix.map(_.takeWhile(_ != '!')).filter(_.nonEmpty))

  /** The trailing parameter — the chat text — or the empty string when the line has only the channel parameter, which
    * is how a `USERNOTICE` with no attached message arrives.
    */
  private def trailingOf(message: IrcMessage): String =
    if (message.params.sizeIs > 1) message.params.last else ""

  /** Explains why the socket closed, in the operator's terms. `None` means a close we asked for. */
  def closeExplanation(statusCode: Int, reason: String): Option[String] = statusCode match {
    case WebSocket.NORMAL_CLOSURE => None
    case other                    =>
      val detail = Option(reason).map(_.trim).filter(_.nonEmpty).fold("")(r => s": $r")
      Some(s"the connection was closed by Twitch (code $other)$detail")
  }

  /** Explains why the socket never opened. Twitch chat is a public internet service, so unlike the OBS client there is
    * no Docker-networking diagnosis to offer — a failure here is almost always "no internet right now", and the
    * underlying message says as much.
    */
  def describeConnectFailure(error: Throwable): String = {
    val cause = Option(error.getCause).getOrElse(error)
    Option(cause.getMessage).getOrElse(cause.getClass.getSimpleName)
  }
}
