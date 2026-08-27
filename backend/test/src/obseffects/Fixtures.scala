package obseffects

import obseffects.domain.*
import obseffects.domain.JsonValue.*

/** Ready-made domain values the test suites share, so each test only has to spell out the part it actually cares about.
  */
object Fixtures {

  val speed: ParamSpec = ParamSpec(
    key = ParamKey.unsafe("speed"),
    label = "Speed",
    kind = ParamKind.Number,
    default = JsonNumber(1.0),
    min = Some(0.0),
    max = Some(10.0),
    step = Some(0.1),
    options = None,
    description = "How fast the animation runs"
  )

  val tint: ParamSpec = ParamSpec(
    key = ParamKey.unsafe("tint"),
    label = "Tint",
    kind = ParamKind.Color,
    default = JsonString("#ff00aa"),
    min = None,
    max = None,
    step = None,
    options = None,
    description = "Overall colour"
  )

  val blendMode: ParamSpec = ParamSpec(
    key = ParamKey.unsafe("blendMode"),
    label = "Blend mode",
    kind = ParamKind.Select,
    default = JsonString("add"),
    min = None,
    max = None,
    step = None,
    options = Some(List("add", "screen")),
    description = "How the layer is composited"
  )

  val plasmaField: EffectDescriptor = EffectDescriptor(
    id = EffectId.unsafe("plasma-field"),
    name = "Plasma Field",
    description = "Animated plasma background",
    engine = Engine.Pixi,
    category = "background",
    tags = List("animated", "loop"),
    previewNotes = "Looks best full-screen",
    params = List(speed, tint, blendMode)
  )

  /** A valid raw parameter spec, ready to be `copy`-ed into an invalid one. */
  val rawSpeed: RawParamSpec = RawParamSpec(
    key = "speed",
    label = "Speed",
    kind = "number",
    default = JsonNumber(1.0),
    min = Some(0.0),
    max = Some(10.0),
    step = Some(0.1),
    options = None,
    description = "How fast the animation runs"
  )

  /** A valid raw descriptor, ready to be `copy`-ed into an invalid one. */
  val rawPlasmaField: RawEffectDescriptor = RawEffectDescriptor(
    id = "plasma-field",
    name = "Plasma Field",
    description = "Animated plasma background",
    engine = "pixi",
    category = "background",
    tags = List("animated"),
    previewNotes = "",
    params = List(rawSpeed)
  )

  /** A valid raw route body, ready to be `copy`-ed or overridden field by field.
    *
    * `canvas` defaults to `None` — no `canvas` object in the request at all — because that is what most callers of this
    * fixture are testing around, and because the contract says a request without one is perfectly valid and takes the
    * defaults.
    */
  def rawRoute(
      slug: String = "main-camera",
      effectId: String = "plasma-field",
      enabled: Boolean = true,
      params: Map[String, JsonValue] = Map("speed" -> JsonNumber(2.0)),
      canvas: Option[RawCanvasSettings] = None
  ): RawRouteInput = RawRouteInput(slug, effectId, enabled, params, canvas)

  /** A valid raw preset body, ready to be `copy`-ed or overridden field by field. */
  def rawPreset(
      name: String = "Neon night",
      effectId: String = "plasma-field",
      params: Map[String, JsonValue] = Map("speed" -> JsonNumber(3.0))
  ): RawPresetInput = RawPresetInput(name, effectId, params)

  /** One route as it appears inside an import file. `createdAt` defaults to `None`, which is what a hand-written file
    * looks like; an exported file carries the timestamp the route was created at.
    */
  def importRoute(
      slug: String = "main-camera",
      effectId: String = "plasma-field",
      enabled: Boolean = true,
      params: Map[String, JsonValue] = Map("speed" -> JsonNumber(2.0)),
      canvas: Option[RawCanvasSettings] = None,
      createdAt: Option[String] = None
  ): RawImportRoute = RawImportRoute(RawRouteInput(slug, effectId, enabled, params, canvas), createdAt)

  /** One preset as it appears inside an import file. */
  def importPreset(
      name: String = "Neon night",
      effectId: String = "plasma-field",
      params: Map[String, JsonValue] = Map("speed" -> JsonNumber(3.0)),
      createdAt: Option[String] = None
  ): RawImportPreset = RawImportPreset(RawPresetInput(name, effectId, params), createdAt)

  /** A whole import file, valid by default. */
  def importFile(
      schemaVersion: Int = BackupEnvelope.CurrentSchemaVersion,
      mode: String = "merge",
      routes: List[RawImportRoute] = Nil,
      presets: List[RawImportPreset] = Nil
  ): RawImportRequest = RawImportRequest(schemaVersion, mode, routes, presets)

  /** One chat message with every field filled in, so a test only has to override the part it cares about. */
  def chatMessage(
      id: String = "abc-123",
      at: Long = 1724800000000L,
      username: String = "somelogin",
      event: ChatEventKind = ChatEventKind.Chat,
      text: String = "hello chat",
      parts: List[ChatPart] = List(ChatPart.Text("hello chat")),
      data: Map[String, JsonValue] = Map.empty
  ): ChatMessage =
    ChatMessage(
      id = id,
      at = at,
      channel = "worxbend",
      username = username,
      displayName = "SomeLogin",
      color = "#8a2be2",
      seed = 1234567,
      event = event,
      text = text,
      parts = parts,
      data = data
    )

  /** A raw canvas object with every key present, so a test only has to override the one it cares about. */
  def rawCanvas(
      width: Option[Double] = Some(1280.0),
      height: Option[Double] = Some(720.0),
      fpsCap: Option[Double] = Some(30.0)
  ): RawCanvasSettings = RawCanvasSettings(width, height, fpsCap)
}
