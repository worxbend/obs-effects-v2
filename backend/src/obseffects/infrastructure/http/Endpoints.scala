package obseffects.infrastructure.http

import obseffects.application.AppError
import obseffects.infrastructure.http.Wire.*
import obseffects.infrastructure.http.Wire.given
import ox.flow.Flow
import sttp.capabilities.WebSockets
import sttp.model.StatusCode
import sttp.model.headers.CookieValueWithMeta
import sttp.model.sse.ServerSentEvent
import sttp.tapir.*
import sttp.tapir.json.circe.*
// A wildcard, where the rest of this file names what it imports. Two things are needed from this
// package — `serverSentEventsBody` and the `OxStreams` capability type — and a mixed-case selector
// list is the one case where scalafmt and scalafix sort in opposite directions, so each would
// undo the other's ordering forever. A wildcard is one selector and has no order to disagree about.
import sttp.tapir.server.netty.sync.*

/** The API as *descriptions*: what each endpoint's path, inputs, outputs and errors are — with no implementation
  * attached.
  *
  * Keeping the descriptions separate from the logic (which lives in `HttpApi.scala`) means the same values can be
  * reused to generate the OpenAPI documentation served at `/docs`, to build a type-safe client, or to drive tests,
  * without dragging the database along.
  *
  * ==Public and protected endpoints==
  *
  * Every endpoint below is built from one of two bases, and which one it is *is* the access rule:
  *
  *   - [[base]] — no session needed. Anyone who can reach the port may call it.
  *   - [[secureBase]] — the session cookie is a declared input, and the handler cannot run until the security logic in
  *     `HttpApi.scala` has turned that cookie into an [[obseffects.application.Operator]].
  *
  * The point of writing it this way, rather than checking a cookie inside each handler, is that the split is *visible*:
  * you can read this file top to bottom and count the public endpoints without opening another one. It also puts the
  * security scheme into the generated documentation at `/docs`.
  *
  * The rule for anyone adding an endpoint later, from `docs/CONTRACT.md` §4: **a new endpoint is protected by
  * default**. Making one public means adding a row to the table in that document with the reason it cannot be
  * protected. The public ones here are: the health check (monitoring calls it before anyone has signed in), the three
  * authentication endpoints (you cannot sign in if signing in requires being signed in), and the by-slug route read,
  * the event/audio/chat streams and the sound audio download — an OBS browser source opens one URL forever, unattended,
  * and cannot log in.
  */
object Endpoints {

  /** Errors are described once, here, and shared by every endpoint: a status code, the standard `{"error": {...}}`
    * envelope, and the `Retry-After` header that only the `429` response carries. All three are mapped to and from the
    * `AppError` type the services speak.
    *
    * `Retry-After` lives on *every* endpoint's error output rather than only on the login endpoint because the mapping
    * is written once and shared. On every response other than `TOO_MANY_ATTEMPTS` the value is `None`, and a header
    * whose value is `None` is not sent at all.
    */
  private val errorOutput: EndpointOutput[AppError] =
    statusCode
      .and(jsonBody[ErrorEnvelopeDto].description("Standard error envelope"))
      .and(
        header[Option[String]]("Retry-After")
          .description("Seconds to wait before trying again. Only sent with 429 TOO_MANY_ATTEMPTS.")
      )
      .map(ErrorMapping.fromWire)(ErrorMapping.toWire)

  /** Common prefix and error handling for every endpoint in the API. Endpoints built directly on this one are public.
    */
  private val base: PublicEndpoint[Unit, AppError, Unit, Any] =
    endpoint.in("api").errorOut(errorOutput)

  /** The same, plus the session cookie as a *security input*.
    *
    * `auth.apiKey` is Tapir's way of saying "this input is a credential". It changes nothing about how the cookie is
    * read — it is still the `obs_effects_session` cookie — but it marks the input as authentication, which is what
    * makes it appear as a security scheme in the OpenAPI document and what allows the `handleSecurity` step in
    * `HttpApi.scala` to run before the endpoint's own logic.
    *
    * The type is `Option[String]` rather than `String` because a missing cookie must reach our code as a `401` in the
    * contract's error envelope. If the cookie were a required input, Tapir would reject the request during decoding and
    * answer `400` instead.
    */
  private val secureBase: Endpoint[Option[String], Unit, AppError, Unit, Any] =
    base.securityIn(
      auth.apiKey(
        cookie[Option[String]](SessionCookie.Name)
          .description("Session cookie issued by POST /api/auth/login")
      )
    )

  // -------------------------------------------------------------------------------------------
  // Public endpoints
  // -------------------------------------------------------------------------------------------

  val health: PublicEndpoint[Unit, AppError, HealthResponseDto, Any] =
    base.get
      .in("health")
      .out(jsonBody[HealthResponseDto])
      .summary("Liveness check, including a MongoDB ping")
      .description("Public: monitoring and the compose health story call this before anyone has signed in.")

  /** Signing in. The response carries the session both ways a client might want it: as a `Set-Cookie` header the
    * browser stores on its own, and as a body describing the session for the admin UI to display.
    *
    * The cookie output is optional because there is one mode in which a successful login issues no session at all: a
    * server started with `ADMIN_AUTH_DISABLED=true` answers `200` with `authRequired: false` and nothing to store.
    */
  val login: PublicEndpoint[LoginRequestDto, AppError, (SessionInfoDto, Option[CookieValueWithMeta]), Any] =
    base.post
      .in("auth" / "login")
      .in(jsonBody[LoginRequestDto])
      .out(jsonBody[SessionInfoDto])
      .out(setCookieOpt(SessionCookie.Name))
      .summary("Sign in with the admin password")
      .description(
        "Public: you cannot sign in if signing in requires being signed in. Answers 401 for a wrong password and " +
          "429 after five wrong ones in a row."
      )

  /** Signing out. Takes the cookie as an ordinary input rather than a security input: the endpoint is public, and it
    * has to work when the session it is being asked to end has already expired.
    */
  val logout: PublicEndpoint[Option[String], AppError, CookieValueWithMeta, Any] =
    base.post
      .in("auth" / "logout")
      .in(cookie[Option[String]](SessionCookie.Name))
      .out(statusCode(StatusCode.NoContent))
      .out(setCookie(SessionCookie.Name))
      .summary("Sign out, clearing the session cookie")
      .description("Public and idempotent: 204 whether or not there was a session to end.")

  val session: PublicEndpoint[Option[String], AppError, SessionInfoDto, Any] =
    base.get
      .in("auth" / "session")
      .in(cookie[Option[String]](SessionCookie.Name))
      .out(jsonBody[SessionInfoDto])
      .summary("Whether this request carries a usable session")
      .description(
        "Public, and never answers 401: being signed out is the answer, not a failure. The login page would " +
          "otherwise have to treat its own status check as an error."
      )

  val getRouteBySlug: PublicEndpoint[String, AppError, RouteConfigDto, Any] =
    base.get
      .in("routes" / "by-slug" / path[String]("slug"))
      .out(jsonBody[RouteConfigDto])
      .summary("Fetch one route by slug — the call the OBS browser source makes")
      .description("Public: an OBS browser source opens one URL forever, unattended, and cannot log in.")

  /** The push half of the by-slug read: one HTTP response that stays open and carries every later change to that route.
    *
    * Public for exactly the same reason as the read above — an OBS browser source has no session and cannot get one.
    *
    * Three things about the description are worth pointing at:
    *
    *   - The body is `serverSentEventsBody`, which tapir's netty-sync backend ships. It takes an `ox.flow.Flow` of
    *     events and writes each one out in the `event:`/`data:` text format `EventSource` understands. No new
    *     dependency was needed: `ox` arrives with `tapir-netty-server-sync` already.
    *   - The two headers are fixed values rather than inputs. `Cache-Control: no-cache` stops anything on the way from
    *     serving a saved copy of a stream, and `X-Accel-Buffering: no` is nginx's switch for "do not buffer this
    *     response" — a proxy that buffers an event stream turns instant updates into no updates at all, and this header
    *     is the one-line way to tell the most common proxy not to.
    *   - The output type carries a capability, `OxStreams`, where every other endpoint in this file carries `Any`. That
    *     is tapir's way of recording that this response cannot be produced by just any server backend: it needs one
    *     that knows how to stream ox flows, which is the one this project runs.
    */
  val routeEvents: PublicEndpoint[String, AppError, Flow[ServerSentEvent], OxStreams] =
    base.get
      .in("routes" / "by-slug" / path[String]("slug") / "events")
      .out(serverSentEventsBody)
      .out(header("Cache-Control", "no-cache"))
      .out(header("X-Accel-Buffering", "no"))
      .summary("Live updates for one route, as a Server-Sent Events stream")
      .description(
        "Public, for the same reason as the by-slug read. Always answers 200, including for a slug that has no " +
          "route: EventSource gives up permanently on an HTTP error status, so a 404 would leave a browser source " +
          "pointed at a not-yet-created slug dead until somebody reloaded it inside OBS. Sends `config`, `absent` " +
          "and a `heartbeat` every 20 seconds, and never closes on its own."
      )

  /** The audio level stream every audio-reactive browser source reads.
    *
    * Public, and safe to be: it carries loudness numbers and OBS input names, never the obs-websocket URL and never the
    * password. Those never leave the server, which is the reason the WebSocket client lives in the backend rather than
    * in the page — see `domain/ObsAudio.scala`.
    *
    * There is no slug in the path. Audio is a property of the machine, not of one route: two browser sources running
    * two different effects want exactly the same numbers, so they share one stream shape and the server does one write
    * per measurement per connection.
    */
  val audioLevels: PublicEndpoint[Unit, AppError, Flow[ServerSentEvent], OxStreams] =
    base.get
      .in("audio" / "levels" / "events")
      .out(serverSentEventsBody)
      .out(header("Cache-Control", "no-cache"))
      .out(header("X-Accel-Buffering", "no"))
      .summary("Live OBS audio levels, as a Server-Sent Events stream")
      .description(
        "Public, for the same reason as the by-slug endpoints: an OBS browser source cannot sign in, and this " +
          "stream carries no credentials. Sends a `levels` event for every volume-meter message OBS delivers " +
          "(about twenty a second), and a `heartbeat` after five seconds of silence. Always answers 200, including " +
          "when no OBS connection is configured — in that case it reports silence, and the page falls back to a " +
          "simulated signal."
      )

  /** The chat stream every chat overlay reads: a WebSocket rather than SSE, because unlike the other streams it is the
    * one the design explicitly promises as a resilient WS proxy for OBS browser sources.
    *
    * Public for the standing reason — an OBS browser source cannot sign in — and safe to be: it carries public chat
    * content and connection-state words, never the channel's tokens or the client secret.
    *
    * The output is an `OxStreams.Pipe`: the handler receives the client's incoming text frames as a flow and answers
    * with a flow of outgoing ones. Both directions are plain JSON text frames; the framing is documented on
    * `ChatStream` and in `docs/CONTRACT.md`. The capability type names both `OxStreams` and `WebSockets` because this
    * response needs a server that can do both, which is the one this project runs.
    */
  val chatWs: PublicEndpoint[Unit, AppError, OxStreams.Pipe[String, String], OxStreams & WebSockets] =
    base.get
      .in("chat" / "ws")
      .out(webSocketBody[String, CodecFormat.TextPlain, String, CodecFormat.TextPlain](OxStreams))
      .summary("Live Twitch chat, as a WebSocket of JSON frames")
      .description(
        "Public, for the same reason as the other streams: an OBS browser source cannot sign in, and this stream " +
          "carries only public chat content. On connect the server sends a `snapshot` frame with the last 50 " +
          "messages and a `status` frame, then `message` frames as chat happens, a `status` frame on every " +
          "connection-state change, and a `heartbeat` frame after five seconds of silence. Always accepts the " +
          "connection, including when chat is not configured — the snapshot is then empty and the status says why."
      )

  /** The audio bytes of one stored sound, played by the chat overlay effect when a chat message arrives.
    *
    * Public, for the standing reason: the overlay runs in an OBS browser source, which cannot sign in, and a sound is
    * the least sensitive thing this server stores — a notification noise. See the table in `docs/CONTRACT.md` §4.
    *
    * The `{id}` slot accepts either the database id or the sound's *name*, so effect parameters can reference a sound
    * by its stable name rather than an id that changes on delete-and-reupload; the resolution rule is documented on
    * `SoundService.audio`. The `Cache-Control` value promises a year of caching because the content under one id never
    * changes — there is no "replace a sound" operation, only delete and upload, and an upload mints a fresh id.
    *
    * `Content-Type` is an output *value* rather than a fixed header, because each sound answers with the type it was
    * uploaded with.
    */
  val soundAudio: PublicEndpoint[String, AppError, (Array[Byte], String), Any] =
    base.get
      .in("sounds" / path[String]("id").description("The sound's database id, or its name") / "audio")
      .out(byteArrayBody)
      .out(header[String]("Content-Type"))
      .out(header("Cache-Control", "public, max-age=31536000, immutable"))
      .summary("Download one sound's audio — the call the chat overlay effect makes")
      .description(
        "Public: an OBS browser source cannot sign in. The `{id}` slot accepts the database id or the sound's name; " +
          "an id-shaped value is tried as an id first. The response carries the stored Content-Type and may be " +
          "cached forever, because the bytes under one id are immutable."
      )

  // -------------------------------------------------------------------------------------------
  // Protected endpoints — every one of these can also answer 401 UNAUTHORIZED
  // -------------------------------------------------------------------------------------------

  val listSounds: Endpoint[Option[String], Unit, AppError, SoundListDto, Any] =
    secureBase.get
      .in("sounds")
      .out(jsonBody[SoundListDto])
      .summary("All stored sounds, sorted by name")
      .description("Descriptions only — the audio bytes come from the public per-sound download endpoint.")

  /** The upload is a raw binary body rather than a multipart form, which is why the name arrives as a query parameter
    * and the format as the ordinary `Content-Type` header: `fetch(url + "?name=...", {body: file})` sends exactly this
    * shape with no form encoding anywhere. The header is an `Option` so that a request without one reaches the
    * validator and is reported as a 422 naming the accepted types, instead of failing to decode.
    */
  val uploadSound
      : Endpoint[Option[String], (String, Option[String], Array[Byte]), AppError, (SoundInfoDto, String), Any] =
    secureBase.post
      .in("sounds")
      .in(query[String]("name").description("The sound's unique name, 1 to 64 characters after trimming"))
      .in(header[Option[String]]("Content-Type").description("audio/mpeg, audio/ogg, audio/wav or audio/webm"))
      .in(byteArrayBody)
      .out(statusCode(StatusCode.Created))
      .out(jsonBody[SoundInfoDto])
      .out(header[String]("Location"))
      .summary("Upload a sound as a raw binary body")

  val deleteSound: Endpoint[Option[String], String, AppError, Unit, Any] =
    secureBase.delete
      .in("sounds" / path[String]("id").description("24-character hexadecimal ObjectId"))
      .out(statusCode(StatusCode.NoContent))
      .summary("Delete an uploaded sound")
      .description("A builtin sound cannot be deleted: start-up seeding would recreate it on the next restart anyway.")

  val chatHistory
      : Endpoint[Option[String], (Option[Int], Option[Long], Option[String]), AppError, List[ChatMessageDto], Any] =
    secureBase.get
      .in("chat" / "history")
      .in(query[Option[Int]]("limit").description("How many messages, 1 to 200. Defaults to 50."))
      .in(
        query[Option[Long]]("before")
          .description("Only messages older than this epoch-milliseconds timestamp — the paging cursor.")
      )
      .in(
        query[Option[String]]("beforeId")
          .description(
            "The id of the oldest message already shown — the cursor's tiebreaker. Timestamps are milliseconds and " +
              "not unique, so without it a page boundary inside a same-millisecond group skips the tied messages."
          )
      )
      .out(jsonBody[List[ChatMessageDto]])
      .summary("Recorded chat history, newest first")
      .description(
        "The messages the backend has written down, whether or not any overlay was open when they happened. " +
          "Page backwards by passing the `at` of the oldest message already shown as `before`, and its id as " +
          "`beforeId`."
      )

  val getTwitchSettings: Endpoint[Option[String], Unit, AppError, TwitchViewDto, Any] =
    secureBase.get
      .in("settings" / "twitch")
      .out(jsonBody[TwitchViewDto])
      .summary("The Twitch chat settings, and what that connection is currently doing")
      .description(
        "The stored client secret and tokens are never returned. `settings.clientSecretSet` and `settings.tokensSet` " +
          "say whether each is saved; the values themselves only ever travel towards the server."
      )

  val updateTwitchSettings: Endpoint[Option[String], TwitchSettingsRequestDto, AppError, TwitchViewDto, Any] =
    secureBase.put
      .in("settings" / "twitch")
      .in(jsonBody[TwitchSettingsRequestDto])
      .out(jsonBody[TwitchViewDto])
      .summary("Save the Twitch chat settings and reconnect")
      .description(
        "Saving always reconnects, for the same \"try again now\" reason as the OBS settings. Omit `clientSecret` " +
          "to keep the stored one, send `null` to clear it, send a string to replace it. Stored tokens are untouched " +
          "by this endpoint — they have their own two below."
      )

  val twitchTokens: Endpoint[Option[String], TwitchTokensRequestDto, AppError, TwitchViewDto, Any] =
    secureBase.post
      .in("settings" / "twitch" / "tokens")
      .in(jsonBody[TwitchTokensRequestDto])
      .out(jsonBody[TwitchViewDto])
      .summary("Store a Twitch token pair obtained elsewhere, and reconnect")
      .description(
        "The direct hand-off for an operator who authorized through another tool and has the token strings in hand. " +
          "`refreshToken` may be omitted; the access token then simply expires instead of rotating."
      )

  val twitchOAuthComplete: Endpoint[Option[String], TwitchOAuthCompleteRequestDto, AppError, TwitchViewDto, Any] =
    secureBase.post
      .in("settings" / "twitch" / "oauth" / "complete")
      .in(jsonBody[TwitchOAuthCompleteRequestDto])
      .out(jsonBody[TwitchViewDto])
      .summary("Finish the \"Connect with Twitch\" flow: exchange the code for tokens and store them")
      .description(
        "Called by the admin UI's OAuth callback page with the `code` Twitch redirected back with. Only works when " +
          "a client id and client secret are saved, because Twitch requires the secret for the exchange; answers " +
          "400 otherwise."
      )

  val getObsAudioSettings: Endpoint[Option[String], Unit, AppError, ObsAudioViewDto, Any] =
    secureBase.get
      .in("settings" / "obs-audio")
      .out(jsonBody[ObsAudioViewDto])
      .summary("The OBS WebSocket connection settings, and what that connection is currently doing")
      .description(
        "The stored password is never returned. `settings.passwordSet` says whether one is saved; the value itself " +
          "only ever travels towards the server."
      )

  val updateObsAudioSettings: Endpoint[Option[String], ObsAudioSettingsRequestDto, AppError, ObsAudioViewDto, Any] =
    secureBase.put
      .in("settings" / "obs-audio")
      .in(jsonBody[ObsAudioSettingsRequestDto])
      .out(jsonBody[ObsAudioViewDto])
      .summary("Save the OBS WebSocket connection settings and reconnect")
      .description(
        "Saving always reconnects, even when nothing changed: pressing Save is the operator's only \"try again now\" " +
          "button. Omit `password` to keep the stored one, send `null` to clear it, send a string to replace it."
      )

  val listEffects: Endpoint[Option[String], Unit, AppError, List[EffectDescriptorDto], Any] =
    secureBase.get
      .in("effects")
      .out(jsonBody[List[EffectDescriptorDto]])
      .summary("The effect inventory, sorted by name")

  val syncEffects: Endpoint[Option[String], EffectSyncRequestDto, AppError, EffectSyncResponseDto, Any] =
    secureBase.post
      .in("effects" / "sync")
      .in(jsonBody[EffectSyncRequestDto])
      .out(jsonBody[EffectSyncResponseDto])
      .summary("Replace the whole effect inventory with the frontend's manifest")

  val listRoutes: Endpoint[Option[String], Unit, AppError, List[RouteConfigDto], Any] =
    secureBase.get
      .in("routes")
      .out(jsonBody[List[RouteConfigDto]])
      .summary("All routes, sorted by slug")

  /** The response carries `201 Created`, the stored document, and a `Location` header pointing at the new resource, so
    * the output type is a pair of (document, location).
    */
  val createRoute: Endpoint[Option[String], RouteRequestDto, AppError, (RouteConfigDto, String), Any] =
    secureBase.post
      .in("routes")
      .in(jsonBody[RouteRequestDto])
      .out(statusCode(StatusCode.Created))
      .out(jsonBody[RouteConfigDto])
      .out(header[String]("Location"))
      .summary("Create a route")

  val getRoute: Endpoint[Option[String], String, AppError, RouteConfigDto, Any] =
    secureBase.get
      .in("routes" / path[String]("id").description("24-character hexadecimal ObjectId"))
      .out(jsonBody[RouteConfigDto])
      .summary("Fetch one route by its database id")

  val updateRoute: Endpoint[Option[String], (String, RouteRequestDto), AppError, RouteConfigDto, Any] =
    secureBase.put
      .in("routes" / path[String]("id"))
      .in(jsonBody[RouteRequestDto])
      .out(jsonBody[RouteConfigDto])
      .summary("Replace a route completely")

  val deleteRoute: Endpoint[Option[String], String, AppError, Unit, Any] =
    secureBase.delete
      .in("routes" / path[String]("id"))
      .out(statusCode(StatusCode.NoContent))
      .summary("Delete a route")

  val listPresets: Endpoint[Option[String], Option[String], AppError, List[PresetDto], Any] =
    secureBase.get
      .in("presets")
      .in(query[Option[String]]("effectId").description("Only presets of this effect"))
      .out(jsonBody[List[PresetDto]])
      .summary("Presets, sorted by effect and then by name")
      .description(
        "An effectId that is unknown or malformed yields an empty list rather than a 404: a filter that matches " +
          "nothing is a normal outcome, and only a lookup of something that ought to exist is a not-found."
      )

  val createPreset: Endpoint[Option[String], PresetRequestDto, AppError, (PresetDto, String), Any] =
    secureBase.post
      .in("presets")
      .in(jsonBody[PresetRequestDto])
      .out(statusCode(StatusCode.Created))
      .out(jsonBody[PresetDto])
      .out(header[String]("Location"))
      .summary("Create a preset")

  val getPreset: Endpoint[Option[String], String, AppError, PresetDto, Any] =
    secureBase.get
      .in("presets" / path[String]("id").description("24-character hexadecimal ObjectId"))
      .out(jsonBody[PresetDto])
      .summary("Fetch one preset by its database id")

  val updatePreset: Endpoint[Option[String], (String, PresetRequestDto), AppError, PresetDto, Any] =
    secureBase.put
      .in("presets" / path[String]("id"))
      .in(jsonBody[PresetRequestDto])
      .out(jsonBody[PresetDto])
      .summary("Replace a preset completely")

  val deletePreset: Endpoint[Option[String], String, AppError, Unit, Any] =
    secureBase.delete
      .in("presets" / path[String]("id"))
      .out(statusCode(StatusCode.NoContent))
      .summary("Delete a preset")

  /** The `Content-Disposition` header is what makes a browser save the response as a file instead of showing it, and
    * the filename it carries is built per request, so it is an output value rather than a fixed header.
    */
  val exportAll: Endpoint[Option[String], Unit, AppError, (BackupEnvelopeDto, String), Any] =
    secureBase.get
      .in("admin" / "export")
      .out(jsonBody[BackupEnvelopeDto])
      .out(header[String]("Content-Disposition"))
      .summary("Download every route and preset as one file")

  val importAll: Endpoint[Option[String], ImportRequestDto, AppError, ImportResultDto, Any] =
    secureBase.post
      .in("admin" / "import")
      .in(jsonBody[ImportRequestDto])
      .out(jsonBody[ImportResultDto])
      .summary("Restore routes and presets from an exported file")
      .description(
        "Validates every record before writing any of them: one problem anywhere rejects the whole file and all the " +
          "problems are reported together. `mode` is required and has no default — the two values differ by " +
          "'nothing is deleted' and 'everything is deleted first'."
      )

  /** Every endpoint, in the order they should appear in the documentation. */
  val all: List[AnyEndpoint] =
    List(
      health,
      login,
      logout,
      session,
      listEffects,
      syncEffects,
      listRoutes,
      createRoute,
      getRoute,
      getRouteBySlug,
      routeEvents,
      updateRoute,
      deleteRoute,
      listPresets,
      createPreset,
      getPreset,
      updatePreset,
      deletePreset,
      exportAll,
      importAll,
      chatWs,
      chatHistory,
      getTwitchSettings,
      updateTwitchSettings,
      twitchTokens,
      twitchOAuthComplete,
      listSounds,
      uploadSound,
      deleteSound,
      soundAudio
    )
}
