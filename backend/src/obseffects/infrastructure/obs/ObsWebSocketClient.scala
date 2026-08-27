package obseffects.infrastructure.obs

import io.circe.parser.parse
import io.circe.{Json, JsonObject}
import obseffects.domain.{AudioInputLevel, AudioLevels, ObsAudioSettings}
import org.slf4j.{Logger, LoggerFactory}

import java.net.URI
import java.net.http.{HttpClient, WebSocket}
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.{Clock, Duration as JDuration}
import java.util.Base64
import java.util.concurrent.CompletionStage
import java.util.concurrent.atomic.AtomicReference

/** A client for one OBS instance's `obs-websocket` server, speaking just enough of the protocol to read audio levels.
  *
  * ==Why there is no library here==
  *
  * Java 11 added a WebSocket client to the standard library (`java.net.http.WebSocket`), and Java 21 — which this
  * server already runs on for its virtual threads — has it. The obs-websocket handshake is two messages and one SHA-256
  * calculation. Adding a dependency to avoid writing sixty lines would mean one more library to keep patched, on a
  * network-facing code path, for no gain.
  *
  * ==The protocol, for anyone who has not met it==
  *
  * obs-websocket version 5 is JSON over a WebSocket. Every message is `{"op": <number>, "d": {...}}`, where `op` is the
  * *opcode* saying what kind of message it is. Only four matter here:
  *
  *   - **`op: 0` Hello** — the first thing the server says. It states its version and, if the operator switched
  *     authentication on, a one-time `challenge` and a `salt`.
  *   - **`op: 1` Identify** — our reply. It says which protocol version we speak, answers the challenge, and — the
  *     important part — carries `eventSubscriptions`, a *bitmask* choosing which categories of event we want.
  *   - **`op: 2` Identified** — the server accepting us. From here events flow.
  *   - **`op: 5` Event** — one thing that happened, e.g. `InputVolumeMeters`.
  *
  * A failed handshake does not arrive as an `op`; the server closes the WebSocket with a close code in the 4000s.
  * [[closeCodeExplanation]] turns the two that operators actually hit into a sentence rather than a number.
  *
  * ==The subscription bitmask, and why it is the whole performance story==
  *
  * `eventSubscriptions` is a set of bit flags. Sending `0` means "no events at all"; the default when the field is
  * omitted is a broad set including every scene change, every source rename and more. We ask for exactly one bit,
  * `InputVolumeMeters` — see [[EventSubscriptionInputVolumeMeters]] — so OBS sends us the roughly-twenty-per-second
  * meter messages and nothing else. Asking for the default set instead would deliver hundreds of messages this code
  * would parse and immediately discard.
  *
  * ==Threading==
  *
  * Everything below happens on the `HttpClient`'s own callback threads, never on a request thread. The only shared
  * mutable state is the `AtomicReference` holding the accumulating text of a fragmented message, and the callbacks
  * handed to the constructor, which must therefore be safe to call from an arbitrary thread. `AudioLevelBus` is.
  *
  * This class knows nothing about reconnecting: it opens one connection and reports when that connection ends.
  * Restarting is [[ObsAudioSupervisor]]'s job, which keeps the retry policy in one readable place instead of tangled up
  * with protocol parsing.
  */
final class ObsWebSocketClient(
    settings: ObsAudioSettings,
    clock: Clock,
    onLevels: AudioLevels => Unit,
    onInputsSeen: List[String] => Unit,
    onConnected: Option[String] => Unit,
    onClosed: Option[String] => Unit
) {

  import ObsWebSocketClient.*

  private val log: Logger = LoggerFactory.getLogger(classOf[ObsWebSocketClient])

  /** The live socket, once the TCP and WebSocket handshakes are done. `None` until then and after closing. */
  private val socket = new AtomicReference[Option[WebSocket]](None)

  /** Whether [[onClosed]] has already been called, so a failure during the handshake and the subsequent close callback
    * do not both report the connection as ended. The supervisor would otherwise start two reconnect timers.
    */
  private val ended = new AtomicReference(false)

  /** The OBS version string, which arrives in the Hello but is only worth reporting once the Identified that follows it
    * says we were actually let in. Stashed here to carry it across those two messages.
    */
  private val helloVersion = new AtomicReference[Option[String]](None)

  /** Opens the connection. Returns immediately; everything afterwards happens in callbacks.
    *
    * Failures during the initial connection — a refused port, an unresolvable host, a TLS problem — arrive as a failed
    * future rather than as a close callback, so they are funnelled into the same [[finish]] as everything else. That is
    * what lets the supervisor treat "OBS is not running" and "OBS hung up" identically, which is correct: both mean
    * "wait, then try again".
    */
  def connect(): Unit =
    scala.util.Try(URI.create(settings.url)) match {
      case scala.util.Failure(e)   => finish(Some(s"the URL is not usable: ${e.getMessage}"))
      case scala.util.Success(uri) => open(uri)
    }

  /** Opens the socket for a URL that has already been parsed. */
  private def open(uri: URI): Unit = {
    log.info("Connecting to obs-websocket at {}", settings.url)

    val _ = HttpClient
      .newBuilder()
      .connectTimeout(JDuration.ofMillis(ConnectTimeoutMillis))
      .build()
      .newWebSocketBuilder()
      .connectTimeout(JDuration.ofMillis(ConnectTimeoutMillis))
      .buildAsync(uri, new Listener)
      .whenComplete { (ws, error) =>
        if (error != null) finish(Some(describeConnectFailure(error)))
        else socket.set(Some(ws))
      }
  }

  /** Closes the connection, if there is one. Safe to call more than once and from any thread.
    *
    * The close is best-effort: a socket whose far end has already vanished will not complete the closing handshake, and
    * waiting for it would block a settings save behind a machine that is switched off. The supervisor has already
    * forgotten this client by the time this returns.
    */
  def close(): Unit = {
    socket.getAndSet(None).foreach { ws =>
      try {
        val _ = ws.sendClose(WebSocket.NORMAL_CLOSURE, "bye")
      } catch {
        case scala.util.control.NonFatal(e) => log.debug("Ignoring error while closing obs-websocket", e)
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

  /** Handles one complete message from OBS. */
  private def handle(ws: WebSocket, text: String): Unit =
    parse(text).toOption.flatMap(_.asObject) match {
      case None =>
        log.warn("Ignoring a message from obs-websocket that is not a JSON object")

      case Some(message) =>
        val payload = message("d").flatMap(_.asObject).getOrElse(JsonObject.empty)
        message("op").flatMap(_.asNumber).flatMap(_.toInt) match {
          case Some(OpHello) =>
            helloVersion.set(payload("obsVersion").flatMap(_.asString))
            identify(ws, payload)
          case Some(OpIdentified) => onConnected(helloVersion.get())
          case Some(OpEvent)      => event(payload)
          case _                  => () // Other opcodes exist; none of them concern a read-only levels client.
        }
    }

  /** Answers the Hello: agree the protocol version, answer the challenge if there is one, and ask for meters only. */
  private def identify(ws: WebSocket, hello: JsonObject): Unit = {
    val authentication: Either[String, Option[String]] =
      hello("authentication").flatMap(_.asObject) match {
        case None =>
          // OBS is not asking for a password. A password configured here is then simply unused; that is not an error
          // worth refusing to connect over, but it is worth saying, because "I set a password and it is being ignored"
          // is otherwise a mystery.
          if (settings.password.isDefined)
            log.info("obs-websocket is not requiring authentication, so the configured password is unused")
          Right(None)

        case Some(auth) =>
          val challenge = auth("challenge").flatMap(_.asString)
          val salt = auth("salt").flatMap(_.asString)
          (settings.password, challenge, salt) match {
            case (Some(password), Some(c), Some(s)) => Right(Some(authenticationString(password, s, c)))
            case (None, _, _)                       =>
              Left("this OBS requires a password and none is configured")
            case _ =>
              Left("the server asked for authentication but did not send a challenge")
          }
      }

    authentication match {
      case Left(reason) =>
        finish(Some(reason))
        close()

      case Right(auth) =>
        val fields = List(
          Some("rpcVersion" -> Json.fromInt(RpcVersion)),
          auth.map(value => "authentication" -> Json.fromString(value)),
          Some("eventSubscriptions" -> Json.fromInt(EventSubscriptionInputVolumeMeters))
        ).flatten

        val identifyMessage = Json.obj(
          "op" -> Json.fromInt(OpIdentify),
          "d" -> Json.fromFields(fields)
        )
        val _ = ws.sendText(identifyMessage.noSpaces, true)
    }
  }

  /** Turns an `op: 5` event into levels, ignoring every event that is not the one we subscribed to. */
  private def event(payload: JsonObject): Unit =
    if (payload("eventType").flatMap(_.asString).contains(VolumeMetersEvent)) {
      val data = payload("eventData").flatMap(_.asObject).getOrElse(JsonObject.empty)
      val inputs = data("inputs").flatMap(_.asArray).getOrElse(Vector.empty).toList.flatMap(parseInput)
      // Every name is reported, even when only one is published. The settings form offers this list as a dropdown,
      // and a list narrowed to the input already chosen would make changing that choice impossible — the one input
      // you cannot pick from a filtered list is any of the others.
      onInputsSeen(inputs.map(_.inputName))

      val wanted = settings.inputName match {
        case Some(name) => inputs.filter(_.inputName == name)
        case None       => inputs
      }
      onLevels(AudioLevels(clock.millis(), wanted, AudioLevels.peakOf(wanted)))
    }

  /** One entry of the event's `inputs` array.
    *
    * The shape is `{"inputName": "Desktop Audio", "inputLevelsMul": [[mag, peak, inputPeak], ...]}` — one inner array
    * per audio channel, each holding three multipliers. We take index 1, the channel's peak.
    *
    * `inputLevelsMul` is an **empty array** for a muted or inactive input rather than an array of zeros, which is why
    * an input with no channels maps to a peak of zero here instead of being dropped: an effect watching a specific
    * input needs to be told it has gone silent, and silence is a level, not an absence.
    */
  private def parseInput(entry: Json): Option[AudioInputLevel] =
    entry.asObject.flatMap { obj =>
      obj("inputName").flatMap(_.asString).map { name =>
        val channels = obj("inputLevelsMul")
          .flatMap(_.asArray)
          .getOrElse(Vector.empty)
          .toList
          .flatMap(_.asArray)
          .map { channel =>
            // Index 1 is the peak. Guard the index rather than assuming three entries: the protocol documents three,
            // and a malformed message must not take the connection down.
            val peak = channel.lift(PeakIndex).flatMap(_.asNumber).map(_.toDouble).getOrElse(0.0)
            clampLevel(peak)
          }
        AudioInputLevel(name, if (channels.isEmpty) 0.0 else channels.max, channels)
      }
    }

  /** The listener the Java WebSocket client calls back into.
    *
    * `onText` can deliver a message in **fragments**: `last` is false for every piece but the final one. A meter
    * message is small and will usually arrive whole, but "usually" is not a guarantee the API makes, and a half-parsed
    * JSON object would be logged as a protocol error forever after. So fragments accumulate here until the last one.
    */
  private final class Listener extends WebSocket.Listener {

    private val buffer = new AtomicReference(new StringBuilder)

    override def onOpen(ws: WebSocket): Unit = ws.request(1)

    override def onText(ws: WebSocket, data: CharSequence, last: Boolean): CompletionStage[?] = {
      val accumulated = buffer.get()
      val _ = accumulated.append(data)
      if (last) {
        val complete = accumulated.toString
        buffer.set(new StringBuilder)
        try handle(ws, complete)
        catch {
          case scala.util.control.NonFatal(e) =>
            // One unparseable message must never end the connection: OBS keeps sending meters, and dropping the
            // stream over a single bad frame would take the overlay down with it.
            log.warn("Failed to handle an obs-websocket message", e)
        }
      }
      // Ask for the next message. Without this the flow-control window stays closed and nothing more is delivered —
      // the connection appears to hang after exactly one message, which is a memorable afternoon.
      ws.request(1)
      null
    }

    override def onClose(ws: WebSocket, statusCode: Int, reason: String): CompletionStage[?] = {
      finish(closeCodeExplanation(statusCode, reason))
      null
    }

    override def onError(ws: WebSocket, error: Throwable): Unit =
      finish(Some(Option(error.getMessage).getOrElse(error.getClass.getSimpleName)))
  }
}

object ObsWebSocketClient {

  /** Opcodes of obs-websocket 5. */
  val OpHello = 0
  val OpIdentify = 1
  val OpIdentified = 2
  val OpEvent = 5

  /** The protocol version this client speaks. obs-websocket 5.x is RPC version 1. */
  val RpcVersion = 1

  /** The `InputVolumeMeters` bit of the `eventSubscriptions` mask: bit 16, so `1 << 16`.
    *
    * It is one of the "high volume" subscriptions, which is why it is not in the default set and has to be asked for by
    * name. Twenty messages a second is high volume for an event log; it is nothing at all for a level meter.
    */
  val EventSubscriptionInputVolumeMeters: Int = 1 << 16

  /** The only event type this client cares about. */
  val VolumeMetersEvent = "InputVolumeMeters"

  /** Which of the three numbers in a channel's array is the peak: `[magnitude, peak, inputPeak]`. */
  val PeakIndex = 1

  /** How long to wait for the socket to open before giving up and letting the supervisor retry. */
  val ConnectTimeoutMillis = 5000

  /** Keeps a level in the range the domain promises. OBS can report a hair above 1.0 on a clipping source, and an
    * effect that scales a radius by an unbounded number draws something alarming.
    */
  def clampLevel(value: Double): Double =
    if (value.isNaN) 0.0 else Math.max(0.0, Math.min(1.0, value))

  /** The obs-websocket authentication string.
    *
    * The scheme, from the protocol documentation: SHA-256 the password concatenated with the salt and Base64 the
    * result; concatenate *that* with the challenge, SHA-256 and Base64 again. The salt is fixed per server and the
    * challenge changes every connection, so the value sent over the wire is never the same twice and never contains the
    * password.
    */
  def authenticationString(password: String, salt: String, challenge: String): String = {
    val secret = base64Sha256(password + salt)
    base64Sha256(secret + challenge)
  }

  private def base64Sha256(value: String): String =
    Base64.getEncoder.encodeToString(
      MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))
    )

  /** Turns a WebSocket close code into something an operator can act on.
    *
    * `None` means "we closed it on purpose". The two codes below are the ones a misconfiguration actually produces;
    * anything else is passed through with its number, because inventing friendly text for codes nobody hits would just
    * be a longer way of hiding the number that would have identified the problem.
    */
  def closeCodeExplanation(statusCode: Int, reason: String): Option[String] = statusCode match {
    case WebSocket.NORMAL_CLOSURE => None
    case 4009                     => Some("authentication failed: the obs-websocket password is wrong")
    case 4008                     => Some("OBS rejected the connection: the wrong protocol version was offered")
    case other                    =>
      val detail = Option(reason).map(_.trim).filter(_.nonEmpty).fold("")(r => s": $r")
      Some(s"the connection was closed by OBS (code $other)$detail")
  }

  /** Explains why the socket never opened, in the operator's terms rather than Java's.
    *
    * The exception here is always wrapped in a `CompletionException`, and its message alone ("Connection refused") is
    * true but unhelpful without saying what was being connected to and what that usually means.
    */
  def describeConnectFailure(error: Throwable): String = {
    val cause = Option(error.getCause).getOrElse(error)
    val message = Option(cause.getMessage).getOrElse(cause.getClass.getSimpleName)
    cause match {
      /*
       * A timeout, as opposed to a refusal, means the packets went out and nothing came back at
       * all. That distinction is the whole diagnosis and it is worth spelling out, because the two
       * have completely different causes and the raw message ("HTTP connect timed out") points at
       * neither:
       *
       *   - "connection refused" — something answered and said no. OBS is not listening: the
       *     WebSocket server is switched off, or the port is wrong.
       *   - "timed out" — nothing answered. The packets are being dropped in transit, and on a
       *     Linux host the overwhelmingly common reason is a firewall that allows the port from
       *     the machine itself but not from Docker's bridge network, where this backend lives.
       *
       * Anyone hitting this has typed an address that works perfectly when they test it in a
       * browser or with a WebSocket client on their desktop, which is exactly why the firewall is
       * the last thing they would suspect.
       */
      case _: java.net.http.HttpTimeoutException | _: java.net.SocketTimeoutException =>
        s"timed out with no response ($message) — the address is reachable in principle but nothing answered. " +
          "If OBS is running and reachable from your desktop, the likely cause is a host firewall blocking " +
          "Docker's network: this backend connects from inside a container, so a rule that allows port 4455 " +
          "from the machine itself does not cover it. On ufw, `sudo ufw allow from 172.16.0.0/12 to any port " +
          "4455 proto tcp` opens it to local containers only."
      case _: java.net.ConnectException =>
        s"could not connect ($message) — is OBS running, and is its WebSocket server switched on in Tools > WebSocket Server Settings?"
      case _: java.net.UnknownHostException =>
        s"the host name could not be resolved ($message) — from inside a container, the machine running OBS is host.docker.internal, not localhost"
      case _ => message
    }
  }
}
