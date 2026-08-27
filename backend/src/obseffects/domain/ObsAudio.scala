package obseffects.domain

import scala.util.matching.Regex

/** The domain of "where does audio come from, and how loud is it right now".
  *
  * ==Why this exists at all==
  *
  * Audio-reactive effects used to open the *browser's* microphone, with `getUserMedia`. That was always the wrong
  * source and it never really worked where it mattered:
  *
  *   - An OBS browser source normally has no microphone permission, so the effects fell back to a simulated signal and
  *     danced to music nobody was playing.
  *   - Even when permission was granted, a microphone hears the room. What a stream overlay should react to is the
  *     audio OBS is actually broadcasting — the desktop audio, the game, the music track, the microphone *after* the
  *     noise gate and the compressor.
  *
  * So the audio now comes from OBS itself, over its `obs-websocket` plugin, and this file describes the connection an
  * operator configures in the admin panel.
  *
  * ==Why the backend is the WebSocket client, and not the browser==
  *
  * The obvious design is for the renderer page to open the WebSocket, since it is running inside OBS already. It was
  * rejected for one decisive reason: **the obs-websocket password**. The renderer page at `/e/:slug` is deliberately
  * unauthenticated, because an OBS browser source cannot sign in. If the browser were the client, the password would
  * have to be handed out from a public endpoint to anyone who asked.
  *
  * With the backend as the client, the password never leaves the server, one connection serves any number of browser
  * sources, and the levels reach the pages over the same Server-Sent Events machinery that already delivers route
  * configuration. See `docs/CONTRACT.md` for the endpoints.
  */

/** How to reach an OBS instance's `obs-websocket` server.
  *
  * This is the whole of what an operator configures. It is stored as a single document in the `settings` collection —
  * there is exactly one of these, because there is one OBS.
  *
  * @param enabled
  *   whether to connect at all. `false` is the shipped default: a fresh install has no OBS credentials, and an effect
  *   that gets no levels falls back to a simulated signal rather than freezing, so nothing breaks while this sits
  *   switched off.
  * @param url
  *   the WebSocket address, e.g. `ws://host.docker.internal:4455`. See [[ObsAudioSettings.parseUrl]] for why the host
  *   is so often *not* `localhost`.
  * @param password
  *   the obs-websocket password, or `None` when the plugin has authentication switched off. Never leaves the server:
  *   the admin API returns [[ObsAudioSettings.passwordSet]] instead of the value.
  * @param inputName
  *   which OBS audio input to follow, or `None` for "sum every input OBS reports". A name here must match the input's
  *   name in OBS exactly, including case and spaces — `Desktop Audio`, `Mic/Aux`.
  */
final case class ObsAudioSettings(
    enabled: Boolean,
    url: String,
    password: Option[String],
    inputName: Option[String]
)

object ObsAudioSettings {

  /** The address a Compose-hosted backend most often needs.
    *
    * `host.docker.internal` is a name Docker resolves, from inside a container, to the machine the container is running
    * on. It is the right default here because OBS runs on the operator's desktop while this backend runs in a
    * container, so `localhost` inside the container is the container itself and would never find OBS.
    *
    * On Linux the name is not automatic — `docker-compose.yml` adds it with an `extra_hosts` entry.
    */
  val DefaultUrl = "ws://host.docker.internal:4455"

  /** What an installation has before anybody configures anything: switched off, with the address most people will want
    * already filled in, so enabling it is a password and one click rather than a research project.
    */
  val Default: ObsAudioSettings =
    ObsAudioSettings(enabled = false, url = DefaultUrl, password = None, inputName = None)

  /** Only `ws://` and `wss://` are WebSocket schemes. Checked with a regex first so the error message can say something
    * useful about a value like `localhost:4455`, which `java.net.URI` parses happily as a URI with the scheme
    * `localhost`.
    */
  private val SchemePattern: Regex = "^(ws|wss)://.+".r

  /** An input name is free text chosen by whoever set up the OBS scene, so almost anything is legal. The bounds exist
    * only to keep a stored document sane; the trim is because a trailing space in a name is invisible and would
    * silently match nothing.
    */
  val MaxInputNameLength = 200

  /** Validates and normalises a URL, returning the reason it is unusable rather than a boolean.
    *
    * The rules are deliberately shallow: the scheme has to be one of the two WebSocket schemes and the whole thing has
    * to parse as a URI with a host. Whether anything is *listening* there is not knowable here and is reported by the
    * connection status instead, which is a much more useful place for it — a URL can be perfectly well-formed and still
    * be pointing at a machine that is switched off.
    */
  def parseUrl(raw: String): Either[String, String] = {
    val trimmed = raw.trim
    if (trimmed.isEmpty) Left("must not be empty")
    else if (!SchemePattern.matches(trimmed)) Left("must start with ws:// or wss://")
    else
      scala.util
        .Try(java.net.URI.create(trimmed))
        .toEither
        .left
        .map(_ => "is not a valid URL")
        .flatMap { uri =>
          if (Option(uri.getHost).forall(_.isEmpty)) Left("must include a host, e.g. ws://host.docker.internal:4455")
          else Right(trimmed)
        }
  }

  /** Normalises an optional input name: blank and absent mean the same thing, which is "every input". */
  def parseInputName(raw: Option[String]): Either[String, Option[String]] =
    raw.map(_.trim).filter(_.nonEmpty) match {
      case None                                           => Right(None)
      case Some(name) if name.length > MaxInputNameLength => Left(s"must be at most $MaxInputNameLength characters")
      case Some(name)                                     => Right(Some(name))
    }
}

/** What the backend's OBS connection is doing right now, for the admin panel to display.
  *
  * This is *not* stored. It is the live state of the client, rebuilt on every start, and it exists because the single
  * most common question after typing a password into the settings form is "did that work?" — a question the settings
  * document itself can never answer.
  */
enum ObsConnectionState {

  /** Switched off in the settings. Nothing is being attempted. */
  case Disabled

  /** Trying to open the WebSocket, or waiting out the backoff before the next attempt. */
  case Connecting

  /** Connected, authenticated, and subscribed to volume meters. */
  case Connected

  /** The last attempt failed. Retries continue; [[ObsConnectionStatus.lastError]] says what went wrong. */
  case Failed
}

/** The live status of the OBS connection, plus enough detail to debug a wrong setting without reading the server log.
  *
  * @param state
  *   the coarse state a badge in the admin panel colours itself from.
  * @param lastError
  *   why the last attempt failed, in words meant for the operator ("authentication failed: wrong password"), or `None`
  *   when nothing has gone wrong yet.
  * @param connectedSince
  *   epoch milliseconds of the moment the current connection was established, or `None` when not connected. Shown as an
  *   uptime, which is the quickest way to spot a connection that is silently flapping.
  * @param obsVersion
  *   the OBS version string from the handshake, or `None`. Proof that the thing on the other end really is OBS.
  * @param inputs
  *   every audio input OBS has reported a level for since connecting, sorted. This is the list the settings form offers
  *   as a dropdown, so the operator picks a name that certainly exists instead of typing one that might not.
  * @param levelsReceived
  *   how many volume-meter messages have arrived. A connection that is `Connected` with this stuck at zero means OBS is
  *   reachable but is not sending meters, which is a completely different problem from a refused connection.
  */
final case class ObsConnectionStatus(
    state: ObsConnectionState,
    lastError: Option[String],
    connectedSince: Option[Long],
    obsVersion: Option[String],
    inputs: List[String],
    levelsReceived: Long
)

object ObsConnectionStatus {

  /** The status of a connection that has not been attempted. */
  val Disabled: ObsConnectionStatus =
    ObsConnectionStatus(ObsConnectionState.Disabled, None, None, None, Nil, 0L)
}

/** One measurement of how loud OBS is right now.
  *
  * ==The honest limitation, stated where nobody can miss it==
  *
  * `obs-websocket` reports **loudness, not a spectrum**. Its `InputVolumeMeters` event carries, roughly every 50
  * milliseconds, a peak value per channel per audio input — and nothing else. There is no Fast Fourier Transform in the
  * protocol, so there is no way to know how much of that loudness was bass and how much was cymbals.
  *
  * That is a real loss compared with the browser's `AnalyserNode`, and it is worth being clear about: an effect that
  * draws a *spectrum* can no longer draw a true one. What the frontend does instead is documented in
  * `frontend/src/effects/sdk/audio.ts` — it shapes a plausible spectrum whose overall energy follows this real level,
  * so a bar display still moves with the music, and it never claims the bands are measured.
  *
  * What is *gained* is much larger: this is the audio OBS is actually broadcasting, on every machine, with no
  * permission prompt and no microphone.
  *
  * @param inputName
  *   the OBS input this measurement came from.
  * @param peak
  *   the loudest channel of this input, as a linear multiplier in 0..1 where 1 is full scale. OBS sends multipliers
  *   directly rather than decibels — the protocol field is even named `inputLevelsMul` — so no conversion is involved,
  *   only clamping; see `ObsWebSocketClient`.
  * @param channels
  *   the per-channel peaks, in the order OBS reported them. A stereo input has two. Kept because a two-channel effect
  *   (a left/right ribbon, a stereo VU pair) cannot be built from a single summed number.
  */
final case class AudioInputLevel(inputName: String, peak: Double, channels: List[Double])

/** Every input's level at one instant: the payload the renderer pages are sent.
  *
  * @param at
  *   epoch milliseconds when this was measured, used by the browser to notice a stream that has gone stale.
  * @param inputs
  *   one entry per audio input OBS reported in this message.
  * @param peak
  *   the loudest single channel across every input — the "how loud is the stream right now" number, which is what most
  *   effects actually want and what saves every one of them from writing the same maximum loop.
  */
final case class AudioLevels(at: Long, inputs: List[AudioInputLevel], peak: Double)

object AudioLevels {

  /** Silence: what is sent when OBS is connected but has gone quiet, and the starting value of everything. */
  def silent(at: Long): AudioLevels = AudioLevels(at, Nil, 0.0)

  /** Reduces a set of per-input measurements to the single loudest channel in any of them.
    *
    * Maximum rather than sum on purpose: peaks are already normalised so that 1.0 is full scale, and adding two
    * full-scale inputs would give 2.0, which is not a louder sound, it is a broken number.
    */
  def peakOf(inputs: List[AudioInputLevel]): Double =
    if (inputs.isEmpty) 0.0 else inputs.map(_.peak).max
}
