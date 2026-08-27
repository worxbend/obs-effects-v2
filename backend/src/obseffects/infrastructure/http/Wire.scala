package obseffects.infrastructure.http

import io.circe.generic.semiauto.{deriveDecoder, deriveEncoder}
import io.circe.{Decoder, DecodingFailure, Encoder}
import obseffects.application.{
  AppError,
  EffectSyncOutcome,
  HealthStatus,
  ObsAudioUpdate,
  SessionInfo,
  TwitchSettingsUpdate
}
import obseffects.domain.*
import obseffects.infrastructure.json.JsonValueCodec.given
import sttp.tapir.{Schema, Validator}

import java.time.format.DateTimeFormatter
import java.time.{Instant, ZoneOffset}

/** The JSON shapes exactly as they appear on the wire, plus the translation to and from the domain models.
  *
  * Why not serialise the domain models directly? Two reasons:
  *
  *   1. The domain uses rich types (`Slug`, `Engine`, `Instant`); JSON uses plain strings. Keeping a separate set of
  *      "data transfer objects" (DTOs) means a rename inside the domain cannot silently change the public API, and vice
  *      versa.
  *   2. Requests must be decodable even when their *values* are invalid — a bad `engine` string has to reach the
  *      validator so it can be reported as 422, instead of failing to decode as 400. DTOs therefore keep every
  *      constrained field as a `String`.
  */
object Wire {

  /** The contract's timestamp format: UTC, always exactly three fractional digits, trailing `Z`. `Instant.toString`
    * would drop the milliseconds when they happen to be zero, which makes the frontend's "did updatedAt change?"
    * comparison harder to reason about.
    */
  private val Timestamps: DateTimeFormatter =
    DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

  def formatInstant(instant: Instant): String = Timestamps.format(instant)

  // -------------------------------------------------------------------------------------------
  // Effects
  // -------------------------------------------------------------------------------------------

  final case class ParamSpecDto(
      key: String,
      label: String,
      kind: String,
      default: JsonValue,
      min: Option[Double],
      max: Option[Double],
      step: Option[Double],
      options: Option[List[String]],
      description: String
  )

  final case class EffectDescriptorDto(
      id: String,
      name: String,
      description: String,
      engine: String,
      category: String,
      tags: List[String],
      previewNotes: String,
      params: List[ParamSpecDto]
  )

  final case class EffectSyncRequestDto(effects: List[EffectDescriptorDto])

  final case class EffectSyncResponseDto(upserted: Int, removed: Int, total: Int)

  // -------------------------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------------------------

  /** The route's render resolution and frame-rate cap.
    *
    * `fpsCap` is the single field in this whole file that is *sent* as `null` rather than omitted when it is absent.
    * "No cap" and "nobody has chosen yet" mean the same thing to the renderer, and writing the key out with a `null`
    * makes the frontend's `number | null` type honest. See the note on this class's encoder further down: it must not
    * be routed through `deepDropNullValues`, or "uncapped" reaches the browser as a missing key.
    */
  final case class CanvasSettingsDto(width: Int, height: Int, fpsCap: Option[Int])

  /** The same three fields as they arrive in a request, where each of them may be left out.
    *
    * The numbers are `Double` rather than `Int` so that `1920.5` reaches the validator instead of failing to decode:
    * the contract calls a non-integer canvas value a broken rule (422), not a broken request (400).
    */
  final case class CanvasSettingsRequestDto(
      width: Option[Double],
      height: Option[Double],
      fpsCap: Option[Double]
  )

  final case class RouteConfigDto(
      id: String,
      slug: String,
      effectId: String,
      enabled: Boolean,
      params: Map[String, JsonValue],
      canvas: CanvasSettingsDto,
      createdAt: String,
      updatedAt: String
  )

  /** The body of both `POST /api/routes` and `PUT /api/routes/{id}`.
    *
    * Any `id`, `createdAt` or `updatedAt` a client sends is ignored: circe's derived decoder simply skips fields that
    * are not part of this class, which is exactly the behaviour the contract asks for.
    *
    * `canvas` is optional here while it is mandatory in the response: a request that leaves it out gets the defaults,
    * and a response always describes the route completely.
    */
  final case class RouteRequestDto(
      slug: String,
      effectId: String,
      enabled: Boolean,
      params: Map[String, JsonValue],
      canvas: Option[CanvasSettingsRequestDto]
  )

  // -------------------------------------------------------------------------------------------
  // Presets
  // -------------------------------------------------------------------------------------------

  final case class PresetDto(
      id: String,
      name: String,
      effectId: String,
      params: Map[String, JsonValue],
      createdAt: String,
      updatedAt: String
  )

  /** The body of both `POST /api/presets` and `PUT /api/presets/{id}`. As with routes, any `id`, `createdAt` or
    * `updatedAt` a client sends is skipped by the derived decoder, which is exactly what the contract asks for.
    */
  final case class PresetRequestDto(name: String, effectId: String, params: Map[String, JsonValue])

  // -------------------------------------------------------------------------------------------
  // Export and import
  // -------------------------------------------------------------------------------------------

  final case class BackupEnvelopeDto(
      schemaVersion: Int,
      exportedAt: String,
      routes: List[RouteConfigDto],
      presets: List[PresetDto]
  )

  /** One route inside an import file.
    *
    * It is a flat class rather than a reuse of `RouteRequestDto` plus a wrapper because the contract lets a file hold
    * either shape — a write-request-shaped object, or a complete `RouteConfig` straight out of an export. Listing every
    * field this importer reads, and nothing else, makes both shapes decode: circe's derived decoder skips the fields
    * that are not named here, which is what turns `id` and `updatedAt` from "must be ignored" into "cannot be read by
    * accident".
    *
    * `createdAt` is a `String` rather than a parsed instant so that an unreadable timestamp falls back to the import
    * time instead of failing the whole file to decode.
    */
  final case class ImportRouteDto(
      slug: String,
      effectId: String,
      enabled: Boolean,
      params: Map[String, JsonValue],
      canvas: Option[CanvasSettingsRequestDto],
      createdAt: Option[String]
  )

  /** One preset inside an import file. Same reasoning as [[ImportRouteDto]]. */
  final case class ImportPresetDto(
      name: String,
      effectId: String,
      params: Map[String, JsonValue],
      createdAt: Option[String]
  )

  /** The body of `POST /api/admin/import`: the export envelope, minus `exportedAt`, plus a required `mode`.
    *
    * `mode` is a plain `String` here, and the service turns an unrecognised word into a `400` naming the two accepted
    * values. Decoding it into an enum instead would produce a `400` whose message talked about a Scala type.
    */
  final case class ImportRequestDto(
      schemaVersion: Int,
      mode: String,
      routes: List[ImportRouteDto],
      presets: List[ImportPresetDto]
  )

  final case class ImportResultDto(
      routesCreated: Int,
      routesUpdated: Int,
      routesDeleted: Int,
      presetsCreated: Int,
      presetsUpdated: Int,
      presetsDeleted: Int
  )

  // -------------------------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------------------------

  /** The body of `POST /api/auth/login`.
    *
    * The length limits are attached to the Tapir schema further down rather than checked by hand here, so that they
    * appear in the generated documentation at `/docs` and are rejected as a `400` before the password ever reaches
    * bcrypt.
    */
  final case class LoginRequestDto(password: String)

  /** The answer to "am I signed in?", returned by both `POST /api/auth/login` and `GET /api/auth/session`. */
  final case class SessionInfoDto(authenticated: Boolean, authRequired: Boolean, expiresAt: Option[String])

  // -------------------------------------------------------------------------------------------
  // Health and errors
  // -------------------------------------------------------------------------------------------

  final case class HealthResponseDto(status: String, mongo: String, effects: Long, routes: Long)

  final case class ApiErrorDto(code: String, message: String, details: Option[io.circe.Json])

  /** The single error shape every non-2xx response uses: `{"error": {...}}`. */
  final case class ErrorEnvelopeDto(error: ApiErrorDto)

  // -------------------------------------------------------------------------------------------
  // Domain -> DTO
  // -------------------------------------------------------------------------------------------

  def toDto(spec: ParamSpec): ParamSpecDto =
    ParamSpecDto(
      key = spec.key.value,
      label = spec.label,
      kind = spec.kind.wireName,
      default = spec.default,
      min = spec.min,
      max = spec.max,
      step = spec.step,
      options = spec.options,
      description = spec.description
    )

  def toDto(descriptor: EffectDescriptor): EffectDescriptorDto =
    EffectDescriptorDto(
      id = descriptor.id.value,
      name = descriptor.name,
      description = descriptor.description,
      engine = descriptor.engine.wireName,
      category = descriptor.category,
      tags = descriptor.tags,
      previewNotes = descriptor.previewNotes,
      params = descriptor.params.map(toDto)
    )

  def toDto(canvas: CanvasSettings): CanvasSettingsDto =
    CanvasSettingsDto(canvas.width, canvas.height, canvas.fpsCap)

  def toDto(route: RouteConfig): RouteConfigDto =
    RouteConfigDto(
      id = route.id.value,
      slug = route.slug.value,
      effectId = route.effectId.value,
      enabled = route.enabled,
      params = route.params.map((key, value) => key.value -> value),
      canvas = toDto(route.canvas),
      createdAt = formatInstant(route.createdAt),
      updatedAt = formatInstant(route.updatedAt)
    )

  def toDto(preset: Preset): PresetDto =
    PresetDto(
      id = preset.id.value,
      name = preset.name,
      effectId = preset.effectId.value,
      params = preset.params.map((key, value) => key.value -> value),
      createdAt = formatInstant(preset.createdAt),
      updatedAt = formatInstant(preset.updatedAt)
    )

  def toDto(envelope: BackupEnvelope): BackupEnvelopeDto =
    BackupEnvelopeDto(
      schemaVersion = envelope.schemaVersion,
      exportedAt = formatInstant(envelope.exportedAt),
      routes = envelope.routes.map(toDto),
      presets = envelope.presets.map(toDto)
    )

  def toDto(result: ImportResult): ImportResultDto =
    ImportResultDto(
      routesCreated = result.routesCreated,
      routesUpdated = result.routesUpdated,
      routesDeleted = result.routesDeleted,
      presetsCreated = result.presetsCreated,
      presetsUpdated = result.presetsUpdated,
      presetsDeleted = result.presetsDeleted
    )

  def toDto(info: SessionInfo): SessionInfoDto =
    SessionInfoDto(
      authenticated = info.authenticated,
      authRequired = info.authRequired,
      expiresAt = info.expiresAt.map(formatInstant)
    )

  def toDto(outcome: EffectSyncOutcome): EffectSyncResponseDto =
    EffectSyncResponseDto(outcome.upserted, outcome.removed, outcome.total)

  def toDto(status: HealthStatus): HealthResponseDto =
    HealthResponseDto(status = "ok", mongo = "up", effects = status.effects, routes = status.routes)

  // -------------------------------------------------------------------------------------------
  // DTO -> unvalidated domain input
  // -------------------------------------------------------------------------------------------

  def toRaw(dto: ParamSpecDto): RawParamSpec =
    RawParamSpec(dto.key, dto.label, dto.kind, dto.default, dto.min, dto.max, dto.step, dto.options, dto.description)

  def toRaw(dto: EffectDescriptorDto): RawEffectDescriptor =
    RawEffectDescriptor(
      dto.id,
      dto.name,
      dto.description,
      dto.engine,
      dto.category,
      dto.tags,
      dto.previewNotes,
      dto.params.map(toRaw)
    )

  def toRaw(dto: CanvasSettingsRequestDto): RawCanvasSettings =
    RawCanvasSettings(dto.width, dto.height, dto.fpsCap)

  def toRaw(dto: RouteRequestDto): RawRouteInput =
    RawRouteInput(dto.slug, dto.effectId, dto.enabled, dto.params, dto.canvas.map(toRaw))

  def toRaw(dto: PresetRequestDto): RawPresetInput =
    RawPresetInput(dto.name, dto.effectId, dto.params)

  def toRaw(dto: ImportRouteDto): RawImportRoute =
    RawImportRoute(
      RawRouteInput(dto.slug, dto.effectId, dto.enabled, dto.params, dto.canvas.map(toRaw)),
      dto.createdAt
    )

  def toRaw(dto: ImportPresetDto): RawImportPreset =
    RawImportPreset(RawPresetInput(dto.name, dto.effectId, dto.params), dto.createdAt)

  def toRaw(dto: ImportRequestDto): RawImportRequest =
    RawImportRequest(dto.schemaVersion, dto.mode, dto.routes.map(toRaw), dto.presets.map(toRaw))

  // -------------------------------------------------------------------------------------------
  // circe codecs
  //
  // `deriveEncoder`/`deriveDecoder` generate the field-by-field JSON mapping at compile time.
  // Encoders for classes with optional fields are post-processed with `deepDropNullValues` because
  // the contract says absent fields are *omitted*, never sent as `null`.
  // -------------------------------------------------------------------------------------------

  // -------------------------------------------------------------------------------------------
  // Settings and audio
  // -------------------------------------------------------------------------------------------

  /** The obs-websocket connection as the admin panel sees it.
    *
    * There is no `password` field, and that is the point. The stored password is a credential the server presents to
    * OBS, so it cannot be hashed, which means the only way to keep it from leaking is never to send it anywhere.
    * `passwordSet` carries the one fact the form actually needs: whether the field should say "a password is saved" or
    * "no password".
    */
  final case class ObsAudioSettingsDto(
      enabled: Boolean,
      url: String,
      passwordSet: Boolean,
      inputName: Option[String]
  )

  /** A settings save.
    *
    * `password` is three-state, and the decoder below is what makes that work over JSON:
    *   - the key absent — leave the stored password alone (the form sends this when it was not edited),
    *   - `"password": null` — remove the stored password,
    *   - `"password": "..."` — replace it.
    */
  final case class ObsAudioSettingsRequestDto(
      enabled: Boolean,
      url: String,
      password: Option[Option[String]],
      inputName: Option[String]
  )

  /** The live connection state, for the badge and the diagnostics line in the settings page. */
  final case class ObsConnectionStatusDto(
      state: String,
      lastError: Option[String],
      connectedSince: Option[Long],
      obsVersion: Option[String],
      inputs: List[String],
      levelsReceived: Long,
      subscribers: Int
  )

  /** Settings and status together, because the page always wants both and two requests would let them disagree. */
  final case class ObsAudioViewDto(settings: ObsAudioSettingsDto, status: ObsConnectionStatusDto)

  /** One input's loudness in an [[AudioLevelsDto]]. */
  final case class AudioInputLevelDto(inputName: String, peak: Double, channels: List[Double])

  /** One measurement, as it appears in a `levels` server-sent event. */
  final case class AudioLevelsDto(at: Long, peak: Double, inputs: List[AudioInputLevelDto])

  def toDto(settings: ObsAudioSettings): ObsAudioSettingsDto =
    ObsAudioSettingsDto(
      enabled = settings.enabled,
      url = settings.url,
      passwordSet = settings.password.isDefined,
      inputName = settings.inputName
    )

  def toDto(status: ObsConnectionStatus, subscribers: Int): ObsConnectionStatusDto =
    ObsConnectionStatusDto(
      // Lowercased so the JSON reads `"connected"` rather than `"Connected"`, matching every other enum on this wire.
      state = status.state.toString.toLowerCase,
      lastError = status.lastError,
      connectedSince = status.connectedSince,
      obsVersion = status.obsVersion,
      inputs = status.inputs,
      levelsReceived = status.levelsReceived,
      subscribers = subscribers
    )

  def toDto(levels: AudioLevels): AudioLevelsDto =
    AudioLevelsDto(
      at = levels.at,
      peak = levels.peak,
      inputs = levels.inputs.map(input => AudioInputLevelDto(input.inputName, input.peak, input.channels))
    )

  def toUpdate(dto: ObsAudioSettingsRequestDto): ObsAudioUpdate =
    ObsAudioUpdate(dto.enabled, dto.url, dto.password, dto.inputName)

  given Decoder[ParamSpecDto] = deriveDecoder
  given Encoder[ParamSpecDto] = deriveEncoder[ParamSpecDto].mapJson(_.deepDropNullValues)

  given Decoder[EffectDescriptorDto] = deriveDecoder
  given Encoder[EffectDescriptorDto] = deriveEncoder

  given Decoder[EffectSyncRequestDto] = deriveDecoder
  given Encoder[EffectSyncRequestDto] = deriveEncoder

  given Decoder[EffectSyncResponseDto] = deriveDecoder
  given Encoder[EffectSyncResponseDto] = deriveEncoder

  // The canvas is the one shape whose encoder must NOT drop nulls, and `RouteConfigDto`'s encoder
  // must stay a plain `deriveEncoder` so that it does not drop them on the canvas's behalf either.
  // `"fpsCap": null` is the contract's way of saying "uncapped"; turning it into a missing key
  // would leave the frontend unable to tell "no cap" from "this build is too old to send one".
  given Decoder[CanvasSettingsDto] = deriveDecoder
  given Encoder[CanvasSettingsDto] = deriveEncoder

  /** Reads the three canvas keys, and insists that each one arrives as a JSON *number*.
    *
    * This one is written by hand instead of being derived, and the reason is a piece of circe behaviour that is easy to
    * be surprised by: circe's own `Decoder[Double]` also accepts a JSON *string* that happens to spell a number, so a
    * derived decoder reads `{"width": "1920"}` as `1920` and the route is created. The contract puts the line between
    * the two failure statuses at exactly the JSON type — a value of the wrong type is a `400` because the request has
    * the wrong shape, while a number that breaks a rule (`1920.5`, `19200`) is a `422` because the shape was fine and
    * the value was not. See `docs/CONTRACT.md` §3 and §5 rule 8.
    *
    * Keeping the fields as `Double` still matters and is unchanged: `1920.5` decodes here and is reported by
    * `Validation` with a `canvas.width` field name, rather than being refused by circe with no field name at all.
    *
    * A key that is absent and a key that is explicitly `null` both read as `None`, which is what the contract asks for:
    * each missing key takes its own default, and `"fpsCap": null` means "uncapped".
    */
  given Decoder[CanvasSettingsRequestDto] = Decoder.instance { cursor =>
    def number(name: String): Decoder.Result[Option[Double]] = {
      val field = cursor.downField(name)
      field.focus match {
        case None                      => Right(None) // the key is not in the object at all
        case Some(json) if json.isNull => Right(None) // the key is there, spelled `null`
        case Some(json)                =>
          json.asNumber match {
            case Some(value) => Right(Some(value.toDouble))
            case None        => Left(DecodingFailure(s"$name must be a number", field.history))
          }
      }
    }

    for {
      width <- number("width")
      height <- number("height")
      fpsCap <- number("fpsCap")
    } yield CanvasSettingsRequestDto(width, height, fpsCap)
  }

  given Encoder[CanvasSettingsRequestDto] = deriveEncoder

  given Decoder[RouteConfigDto] = deriveDecoder
  given Encoder[RouteConfigDto] = deriveEncoder

  given Decoder[RouteRequestDto] = deriveDecoder
  given Encoder[RouteRequestDto] = deriveEncoder

  given Decoder[PresetDto] = deriveDecoder
  given Encoder[PresetDto] = deriveEncoder

  given Decoder[PresetRequestDto] = deriveDecoder
  given Encoder[PresetRequestDto] = deriveEncoder

  // Like `RouteConfigDto`, these stay plain `deriveEncoder`s: the envelope holds whole routes, and
  // an encoder that dropped nulls would take `"fpsCap": null` out of every canvas inside it, so a
  // backup file would come back saying "this build is too old to have an fps cap" rather than
  // "uncapped".
  given Decoder[BackupEnvelopeDto] = deriveDecoder
  given Encoder[BackupEnvelopeDto] = deriveEncoder

  given Decoder[ImportRouteDto] = deriveDecoder
  given Encoder[ImportRouteDto] = deriveEncoder

  given Decoder[ImportPresetDto] = deriveDecoder
  given Encoder[ImportPresetDto] = deriveEncoder

  given Decoder[ImportRequestDto] = deriveDecoder
  given Encoder[ImportRequestDto] = deriveEncoder

  given Decoder[ImportResultDto] = deriveDecoder
  given Encoder[ImportResultDto] = deriveEncoder

  given Decoder[LoginRequestDto] = deriveDecoder
  given Encoder[LoginRequestDto] = deriveEncoder

  given Decoder[SessionInfoDto] = deriveDecoder
  given Encoder[SessionInfoDto] = deriveEncoder[SessionInfoDto].mapJson(_.deepDropNullValues)

  given Decoder[HealthResponseDto] = deriveDecoder
  given Encoder[HealthResponseDto] = deriveEncoder

  given Decoder[ApiErrorDto] = deriveDecoder
  given Encoder[ApiErrorDto] = deriveEncoder[ApiErrorDto].mapJson(_.deepDropNullValues)

  given Decoder[ErrorEnvelopeDto] = deriveDecoder
  given Encoder[ErrorEnvelopeDto] = deriveEncoder

  // -------------------------------------------------------------------------------------------
  // Tapir schemas
  //
  // Tapir needs a `Schema` for every body type to generate the OpenAPI documentation served at
  // /docs. `sttp.tapir.generic.auto.*` derives them for plain case classes; the two types below
  // are not plain case classes, so they get hand-written schemas describing "any JSON value".
  // -------------------------------------------------------------------------------------------

  given Decoder[ObsAudioSettingsDto] = deriveDecoder
  given Encoder[ObsAudioSettingsDto] = deriveEncoder

  /** Hand-written for the same reason as `CanvasSettingsRequestDto`'s, but for the opposite distinction: here an absent
    * key and an explicit `null` must mean *different* things, so the two cases cannot be collapsed.
    */
  given Decoder[ObsAudioSettingsRequestDto] = Decoder.instance { cursor =>
    val passwordField = cursor.downField("password")
    val password: Decoder.Result[Option[Option[String]]] = passwordField.focus match {
      case None                      => Right(None) // key absent: leave the stored password alone
      case Some(json) if json.isNull => Right(Some(None)) // explicit null: clear it
      case Some(json)                =>
        json.asString match {
          case Some(value) => Right(Some(Some(value)))
          case None        => Left(DecodingFailure("password must be a string or null", passwordField.history))
        }
    }

    for {
      enabled <- cursor.downField("enabled").as[Boolean]
      url <- cursor.downField("url").as[String]
      pw <- password
      inputName <- cursor.downField("inputName").as[Option[String]]
    } yield ObsAudioSettingsRequestDto(enabled, url, pw, inputName)
  }

  given Encoder[ObsAudioSettingsRequestDto] = deriveEncoder

  given Decoder[ObsConnectionStatusDto] = deriveDecoder
  given Encoder[ObsConnectionStatusDto] = deriveEncoder

  given Decoder[ObsAudioViewDto] = deriveDecoder
  given Encoder[ObsAudioViewDto] = deriveEncoder

  given Decoder[AudioInputLevelDto] = deriveDecoder
  given Encoder[AudioInputLevelDto] = deriveEncoder

  given Decoder[AudioLevelsDto] = deriveDecoder
  given Encoder[AudioLevelsDto] = deriveEncoder

  // -------------------------------------------------------------------------------------------
  // Twitch chat
  // -------------------------------------------------------------------------------------------

  /** One piece of a chat message: literal text, or an inline emote image.
    *
    * A single class with optional fields rather than two classes, because JSON has no sum types — the `type` field is
    * the discriminator the frontend switches on, and the encoder below drops the fields the other variant would have
    * used, so a text part is `{"type":"text","text":...}` and nothing more.
    */
  final case class ChatPartDto(
      `type`: String,
      text: Option[String],
      name: Option[String],
      url: Option[String],
      animatedUrl: Option[String]
  )

  /** One chat event, as every overlay receives it — in the snapshot, in live `message` frames, and from the history
    * endpoint, so the three sources are interchangeable to a consumer.
    */
  final case class ChatMessageDto(
      id: String,
      at: Long,
      channel: String,
      username: String,
      displayName: String,
      color: String,
      seed: Int,
      event: String,
      text: String,
      parts: List[ChatPartDto],
      data: Map[String, JsonValue]
  )

  /** The Twitch settings as the admin panel sees them.
    *
    * No `clientSecret`, no `accessToken`, no `refreshToken` — the same never-send-a-credential-back rule as the
    * obs-websocket password. `clientSecretSet` and `tokensSet` carry the two facts the form needs: whether each is
    * saved.
    */
  final case class TwitchSettingsDto(
      enabled: Boolean,
      channel: String,
      clientId: String,
      clientSecretSet: Boolean,
      tokensSet: Boolean,
      botLogin: Option[String]
  )

  /** A Twitch settings save. `clientSecret` is the same three-state field as the obs-audio `password`: absent leaves
    * the stored secret alone, `null` clears it, a string replaces it. Tokens are deliberately not in this body — they
    * travel through their own endpoints, so a settings save can never wipe them by accident.
    */
  final case class TwitchSettingsRequestDto(
      enabled: Boolean,
      channel: String,
      clientId: String,
      clientSecret: Option[Option[String]]
  )

  /** The live chat connection state, for the settings page badge and the stream's `status` frames. */
  final case class TwitchStatusDto(
      state: String,
      lastError: Option[String],
      messagesReceived: Long,
      channel: Option[String],
      subscribers: Int
  )

  /** Settings and status together, for the same never-let-them-disagree reason as [[ObsAudioViewDto]]. */
  final case class TwitchViewDto(settings: TwitchSettingsDto, status: TwitchStatusDto)

  /** The body of `POST /api/settings/twitch/tokens`: a token pair the operator obtained themselves. */
  final case class TwitchTokensRequestDto(accessToken: String, refreshToken: Option[String])

  /** The body of `POST /api/settings/twitch/oauth/complete`: what the browser was redirected back with, plus the
    * redirect URI it used — Twitch requires the exchange to repeat it, as proof the code was not intercepted.
    */
  final case class TwitchOAuthCompleteRequestDto(code: String, redirectUri: String)

  def toDto(part: ChatPart): ChatPartDto = part match {
    case ChatPart.Text(text) =>
      ChatPartDto(`type` = "text", text = Some(text), name = None, url = None, animatedUrl = None)
    case ChatPart.Image(name, url, animatedUrl) =>
      ChatPartDto(`type` = "image", text = None, name = Some(name), url = Some(url), animatedUrl = animatedUrl)
  }

  def toDto(message: ChatMessage): ChatMessageDto =
    ChatMessageDto(
      id = message.id,
      at = message.at,
      channel = message.channel,
      username = message.username,
      displayName = message.displayName,
      color = message.color,
      seed = message.seed,
      event = ChatEventKind.wireName(message.event),
      text = message.text,
      parts = message.parts.map(toDto),
      data = message.data
    )

  def toDto(settings: TwitchSettings): TwitchSettingsDto =
    TwitchSettingsDto(
      enabled = settings.enabled,
      channel = settings.channel,
      clientId = settings.clientId,
      clientSecretSet = settings.clientSecret.isDefined,
      tokensSet = settings.accessToken.isDefined,
      botLogin = settings.botLogin
    )

  def toDto(status: TwitchConnectionStatus, subscribers: Int): TwitchStatusDto =
    TwitchStatusDto(
      state = TwitchConnectionState.wireName(status.state),
      lastError = status.lastError,
      messagesReceived = status.messagesReceived,
      channel = status.channel,
      subscribers = subscribers
    )

  def toUpdate(dto: TwitchSettingsRequestDto): TwitchSettingsUpdate =
    TwitchSettingsUpdate(dto.enabled, dto.channel, dto.clientId, dto.clientSecret)

  given Decoder[ChatPartDto] = deriveDecoder
  given Encoder[ChatPartDto] = deriveEncoder[ChatPartDto].mapJson(_.deepDropNullValues)

  given Decoder[ChatMessageDto] = deriveDecoder
  given Encoder[ChatMessageDto] = deriveEncoder

  given Decoder[TwitchSettingsDto] = deriveDecoder
  given Encoder[TwitchSettingsDto] = deriveEncoder

  /** Hand-written for the same three-state reason as `ObsAudioSettingsRequestDto`'s: an absent `clientSecret` and an
    * explicit `null` must mean different things, so the two cases cannot be collapsed by a derived decoder.
    */
  given Decoder[TwitchSettingsRequestDto] = Decoder.instance { cursor =>
    val secretField = cursor.downField("clientSecret")
    val clientSecret: Decoder.Result[Option[Option[String]]] = secretField.focus match {
      case None                      => Right(None) // key absent: leave the stored secret alone
      case Some(json) if json.isNull => Right(Some(None)) // explicit null: clear it
      case Some(json)                =>
        json.asString match {
          case Some(value) => Right(Some(Some(value)))
          case None        => Left(DecodingFailure("clientSecret must be a string or null", secretField.history))
        }
    }

    for {
      enabled <- cursor.downField("enabled").as[Boolean]
      channel <- cursor.downField("channel").as[String]
      clientId <- cursor.downField("clientId").as[String]
      secret <- clientSecret
    } yield TwitchSettingsRequestDto(enabled, channel, clientId, secret)
  }

  given Encoder[TwitchSettingsRequestDto] = deriveEncoder

  given Decoder[TwitchStatusDto] = deriveDecoder
  given Encoder[TwitchStatusDto] = deriveEncoder

  given Decoder[TwitchViewDto] = deriveDecoder
  given Encoder[TwitchViewDto] = deriveEncoder

  given Decoder[TwitchTokensRequestDto] = deriveDecoder
  given Encoder[TwitchTokensRequestDto] = deriveEncoder

  given Decoder[TwitchOAuthCompleteRequestDto] = deriveDecoder
  given Encoder[TwitchOAuthCompleteRequestDto] = deriveEncoder

  // -------------------------------------------------------------------------------------------
  // Sounds
  // -------------------------------------------------------------------------------------------

  /** One stored sound as the admin panel and the chat overlay effect see it. The bytes are not here — they travel
    * through `GET /api/sounds/{id}/audio` — so this stays small enough to list.
    */
  final case class SoundInfoDto(
      id: String,
      name: String,
      builtin: Boolean,
      contentType: String,
      sizeBytes: Long,
      uploadedAt: String
  )

  /** The response of `GET /api/sounds`. An envelope object rather than a bare array, so a later addition — a total
    * size, say — has somewhere to go without changing the response's JSON type.
    */
  final case class SoundListDto(sounds: List[SoundInfoDto])

  def toDto(sound: Sound): SoundInfoDto =
    SoundInfoDto(
      id = sound.id.value,
      name = sound.name,
      builtin = sound.builtin,
      contentType = sound.contentType,
      sizeBytes = sound.sizeBytes,
      uploadedAt = formatInstant(sound.uploadedAt)
    )

  given Decoder[SoundInfoDto] = deriveDecoder
  given Encoder[SoundInfoDto] = deriveEncoder

  given Decoder[SoundListDto] = deriveDecoder
  given Encoder[SoundListDto] = deriveEncoder

  given Schema[JsonValue] = Schema.any[JsonValue].description("any JSON value")
  given Schema[io.circe.Json] = Schema.any[io.circe.Json].description("any JSON value")

  given Schema[ObsAudioSettingsDto] = Schema.derived
  given Schema[ObsAudioSettingsRequestDto] = Schema.derived
  given Schema[ObsConnectionStatusDto] = Schema.derived
  given Schema[ObsAudioViewDto] = Schema.derived
  given Schema[AudioInputLevelDto] = Schema.derived
  given Schema[AudioLevelsDto] = Schema.derived

  given Schema[ChatPartDto] = Schema.derived
  given Schema[ChatMessageDto] = Schema.derived
  given Schema[TwitchSettingsDto] = Schema.derived
  given Schema[TwitchSettingsRequestDto] = Schema.derived
  given Schema[TwitchStatusDto] = Schema.derived
  given Schema[TwitchViewDto] = Schema.derived
  given Schema[TwitchTokensRequestDto] = Schema.derived
  given Schema[TwitchOAuthCompleteRequestDto] = Schema.derived

  given Schema[SoundInfoDto] = Schema.derived
  given Schema[SoundListDto] = Schema.derived

  given Schema[ParamSpecDto] = Schema.derived
  given Schema[EffectDescriptorDto] = Schema.derived
  given Schema[EffectSyncRequestDto] = Schema.derived
  given Schema[EffectSyncResponseDto] = Schema.derived
  given Schema[CanvasSettingsDto] = Schema.derived
  given Schema[CanvasSettingsRequestDto] = Schema.derived
  given Schema[RouteConfigDto] = Schema.derived
  given Schema[RouteRequestDto] = Schema.derived

  given Schema[PresetDto] = Schema.derived
  given Schema[PresetRequestDto] = Schema.derived
  given Schema[BackupEnvelopeDto] = Schema.derived
  given Schema[ImportRouteDto] = Schema.derived
  given Schema[ImportPresetDto] = Schema.derived
  given Schema[ImportRequestDto] = Schema.derived
  given Schema[ImportResultDto] = Schema.derived

  /** The password length limits from `docs/CONTRACT.md` §5 rule 13, expressed on the schema so that Tapir rejects a
    * too-long or empty password with a `400` before any hashing happens, and so that `/docs` shows the limits.
    */
  given Schema[LoginRequestDto] =
    Schema
      .derived[LoginRequestDto]
      .modify(_.password)(_.validate(Validator.minLength(1)).validate(Validator.maxLength(Passwords.MaxPasswordLength)))

  given Schema[SessionInfoDto] = Schema.derived
  given Schema[HealthResponseDto] = Schema.derived
  given Schema[ApiErrorDto] = Schema.derived
  given Schema[ErrorEnvelopeDto] = Schema.derived

  /** Maps from an `AppError` case to the stable machine-readable code in the contract. */
  def errorCode(error: AppError): String = error match {
    case _: AppError.BadRequest   => "BAD_REQUEST"
    case _: AppError.Unauthorized => "UNAUTHORIZED"
    case _: AppError.NotFound     => "NOT_FOUND"
    case _: AppError.SlugConflict => "SLUG_CONFLICT"
    case _: AppError.NameConflict => "NAME_CONFLICT"
    // Deliberately the same code as `NameConflict`: to a client both mean "pick another name", and the two cases only
    // exist separately so the server-side message does not have to invent an effect id for a sound.
    case _: AppError.SoundNameConflict => "NAME_CONFLICT"
    case _: AppError.UnknownEffect     => "UNKNOWN_EFFECT"
    case _: AppError.ValidationFailed  => "VALIDATION_FAILED"
    case _: AppError.TooManyAttempts   => "TOO_MANY_ATTEMPTS"
    case _: AppError.Internal          => "INTERNAL_ERROR"
  }
}
