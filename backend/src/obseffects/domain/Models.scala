package obseffects.domain

import java.time.Instant

/** Which rendering library draws an effect in the browser. */
enum Engine(val wireName: String) {
  case Three extends Engine("three")
  case Pixi extends Engine("pixi")
}

object Engine {

  /** Parses the string that appears in JSON. Returns `None` for anything else, which the caller turns into a validation
    * issue.
    */
  def fromWire(raw: String): Option[Engine] = Engine.values.find(_.wireName == raw)

  val allNames: List[String] = Engine.values.map(_.wireName).toList
}

/** The kind of a single effect parameter. It decides which input widget the admin UI renders and which JSON values are
  * accepted for that parameter.
  */
enum ParamKind(val wireName: String) {
  case Number extends ParamKind("number")
  case Color extends ParamKind("color")
  case Bool extends ParamKind("boolean")
  case Select extends ParamKind("select")
  case Text extends ParamKind("text")
}

object ParamKind {

  def fromWire(raw: String): Option[ParamKind] = ParamKind.values.find(_.wireName == raw)

  val allNames: List[String] = ParamKind.values.map(_.wireName).toList
}

/** One knob of an effect: enough information for the admin UI to render an input for it without knowing anything about
  * the effect's implementation.
  *
  * `min`, `max` and `step` only mean anything for `Number`; `options` is required for `Select` and ignored otherwise.
  * Those rules are enforced in [[Validation]], so a `ParamSpec` value that exists is always internally consistent.
  */
final case class ParamSpec(
    key: ParamKey,
    label: String,
    kind: ParamKind,
    default: JsonValue,
    min: Option[Double],
    max: Option[Double],
    step: Option[Double],
    options: Option[List[String]],
    description: String
)

/** The description of one effect implementation that lives in the frontend. The backend only ever stores and serves
  * these; the frontend is the authority on which effects exist.
  */
final case class EffectDescriptor(
    id: EffectId,
    name: String,
    description: String,
    engine: Engine,
    category: String,
    tags: List[String],
    previewNotes: String,
    params: List[ParamSpec]
) {

  /** Index of the parameter specs by key, used when validating a route's parameter values. */
  lazy val paramsByKey: Map[ParamKey, ParamSpec] = params.map(spec => spec.key -> spec).toMap
}

/** The resolution a route asks its effect to draw at, and an optional frame-rate cap.
  *
  * This is the *render* size, not the size of the OBS browser source showing it: the renderer page sizes the effect's
  * host element to exactly these pixels and then scales that block with CSS to fit the source, keeping the aspect
  * ratio. Asking for 1280×720 inside a 1920×1080 source therefore draws about 44% of the pixels, which is the point of
  * the setting — an ambient background does not need native resolution, and the frames it does not draw are frames the
  * game being streamed keeps.
  *
  * `fpsCap` is `None` when the route is uncapped. It is the one place in the whole contract where an explicit JSON
  * `null` is meaningful rather than omitted; see `docs/CONTRACT.md` §2.3.
  */
final case class CanvasSettings(width: Int, height: Int, fpsCap: Option[Int])

object CanvasSettings {

  /** 1920×1080 is the canvas size almost every OBS scene collection uses, so it is what a route gets when nobody says
    * otherwise.
    */
  val DefaultWidth = 1920
  val DefaultHeight = 1080

  /** The accepted ranges, from `docs/CONTRACT.md` §5 rule 7. The lower bound keeps a zero or negative size — which
    * would make a canvas no browser can allocate — out of the database; the upper bound is 8K, which no browser source
    * needs and which stops a mistyped `19200` from asking a GPU for 200 megapixels.
    */
  val MinWidth = 16
  val MaxWidth = 7680
  val MinHeight = 16
  val MaxHeight = 4320

  /** 240 frames per second is above every display this could plausibly run on; 1 is the slowest cap that still draws.
    */
  val MinFpsCap = 1
  val MaxFpsCap = 240

  /** What a route gets when the request left `canvas` out entirely, and what a document stored before this field
    * existed is read back as.
    */
  val Default: CanvasSettings = CanvasSettings(DefaultWidth, DefaultHeight, None)
}

/** A stored route: the thing an OBS browser source points at.
  *
  * `params` is *sparse* — it holds only the values the admin set. Consumers merge the descriptor's defaults with these
  * values; the backend never fills defaults in. `canvas`, by contrast, is always complete: it has universal defaults
  * that no effect gets to redefine, so there is nothing to merge and every response carries all three values.
  */
final case class RouteConfig(
    id: RouteId,
    slug: Slug,
    effectId: EffectId,
    enabled: Boolean,
    params: Map[ParamKey, JsonValue],
    canvas: CanvasSettings,
    createdAt: Instant,
    updatedAt: Instant
)

/** The validated content of a create/update request: a `RouteConfig` without the fields the server owns (`id`,
  * `createdAt`, `updatedAt`).
  */
final case class RouteInput(
    slug: Slug,
    effectId: EffectId,
    enabled: Boolean,
    params: Map[ParamKey, JsonValue],
    canvas: CanvasSettings
)

/** One thing that was wrong with a request body. `field` uses dotted paths that point at the offending piece of JSON,
  * e.g. `params.speed` or `effects[2].id`.
  */
final case class ValidationIssue(field: String, message: String)

/** A named, reusable set of parameter values for one effect — "Neon night" for `plasma-field`, say.
  *
  * A preset is not attached to any route. The admin picks one in the route editor, the editor copies its values into
  * the form, and the operator saves the route through the ordinary route endpoints. That is why a preset stores no
  * `enabled` flag and no `canvas`: those describe how one OBS layer behaves, while a preset describes a *look*.
  *
  * `name` is stored already trimmed, is 1 to 64 characters long, and is unique within one `effectId` compared without
  * regard to case — "Neon" and "neon" are the same preset name for one effect, while two different effects may each own
  * a preset called "Default".
  */
final case class Preset(
    id: PresetId,
    name: String,
    effectId: EffectId,
    params: Map[ParamKey, JsonValue],
    createdAt: Instant,
    updatedAt: Instant
)

/** The validated content of a preset create/update request: a [[Preset]] without the fields the server owns. */
final case class PresetInput(
    name: String,
    effectId: EffectId,
    params: Map[ParamKey, JsonValue]
)

/** Everything `GET /api/admin/export` hands back, and everything `POST /api/admin/import` reads back in.
  *
  * `schemaVersion` is written as well as read so that a file taken today can be recognised — or refused — by a build
  * that has moved on. This build writes and accepts version 1 only.
  *
  * Effects are deliberately absent: the inventory is code that lives in the frontend bundle and is republished on every
  * admin page load, so a descriptor in a backup file could only ever contradict the running build.
  */
final case class BackupEnvelope(
    schemaVersion: Int,
    exportedAt: Instant,
    routes: List[RouteConfig],
    presets: List[Preset]
)

object BackupEnvelope {

  /** The only schema version this build reads or writes. */
  val CurrentSchemaVersion = 1
}

/** What an import should do with whatever is already in the database.
  *
  * There is no default, and the contract says so in capitals: the two values differ by "nothing is deleted" versus
  * "everything is deleted first". A client that forgot the field is a client whose intention nobody knows, and guessing
  * wrong destroys a scene collection.
  */
enum ImportMode(val wireName: String) {

  /** Match by natural key, overwrite what matches, create what does not, delete nothing. */
  case Merge extends ImportMode("merge")

  /** Delete every route and every preset, then insert the file's contents. */
  case Replace extends ImportMode("replace")
}

object ImportMode {

  def fromWire(raw: String): Option[ImportMode] = ImportMode.values.find(_.wireName == raw)

  val allNames: List[String] = ImportMode.values.map(_.wireName).toList
}

/** One validated route from an import file, with the `createdAt` the file asked for.
  *
  * `createdAt` is `None` when the file left it out or wrote something that is not an ISO-8601 instant; the importer
  * then uses the import time. An unreadable timestamp is deliberately not an error — the worst it can do is make one
  * route look newer than it is, and rejecting a whole restore over it would be out of proportion.
  */
final case class ImportRouteEntry(input: RouteInput, createdAt: Option[Instant])

/** One validated preset from an import file. Same reasoning as [[ImportRouteEntry]]. */
final case class ImportPresetEntry(input: PresetInput, createdAt: Option[Instant])

/** Everything an import file contains, once every record in it has been validated.
  *
  * A value of this type exists only when the *whole* file is acceptable, which is what makes "validate everything
  * before writing anything" a property of the types rather than a rule somebody has to remember.
  */
final case class ImportContents(routes: List[ImportRouteEntry], presets: List[ImportPresetEntry])

/** How many documents an import touched, per collection. Every number is a count of documents actually written or
  * removed, so a file imported twice in `merge` mode reports updates the second time rather than creations.
  */
final case class ImportResult(
    routesCreated: Int,
    routesUpdated: Int,
    routesDeleted: Int,
    presetsCreated: Int,
    presetsUpdated: Int,
    presetsDeleted: Int
)

// ---------------------------------------------------------------------------------------------
// "Raw" models: request data before validation.
//
// These mirror the JSON shapes exactly, with every constrained field left as a plain String. They
// exist because the contract distinguishes "this JSON is malformed" (400) from "this JSON is
// well-formed but the values break a rule" (422). If the JSON decoder itself rejected a bad slug
// or a bad engine name we could only ever produce 400, so decoding stops at the raw shape and
// [[Validation]] takes it from there.
// ---------------------------------------------------------------------------------------------

final case class RawParamSpec(
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

final case class RawEffectDescriptor(
    id: String,
    name: String,
    description: String,
    engine: String,
    category: String,
    tags: List[String],
    previewNotes: String,
    params: List[RawParamSpec]
)

/** The canvas settings as they arrive, before validation.
  *
  * Every field is optional because each key of `canvas` may be left out of a request and take its own default, and the
  * numbers are `Double` rather than `Int` for the same reason every other raw field is a `String`: JSON has a single
  * number type, so `1920.5` is a well-formed number that breaks a rule. Decoding it into an `Int` would fail in the
  * JSON decoder and produce a `400`, while the contract (§5 rule 8) asks for a `422` naming the field.
  */
final case class RawCanvasSettings(
    width: Option[Double],
    height: Option[Double],
    fpsCap: Option[Double]
)

final case class RawRouteInput(
    slug: String,
    effectId: String,
    enabled: Boolean,
    params: Map[String, JsonValue],
    canvas: Option[RawCanvasSettings]
)

/** A preset create/update body before validation. `name` is not trimmed here — trimming is part of the rule, and rules
  * live in [[Validation]].
  */
final case class RawPresetInput(
    name: String,
    effectId: String,
    params: Map[String, JsonValue]
)

/** One route inside an import file.
  *
  * The file may hold either a write-request-shaped object or a complete `RouteConfig` straight out of an export, so
  * every server-owned field is optional. `id` and `updatedAt` are not even read: the contract says an id is always
  * server-assigned, so a hand-edited file with a duplicate or malformed id cannot corrupt the database, and `updatedAt`
  * is always the import time. `createdAt` *is* read, because a restore that reports every scene as created today loses
  * information for no reason; it is a `String` so that an unparseable value falls back to the import time instead of
  * failing to decode.
  */
final case class RawImportRoute(route: RawRouteInput, createdAt: Option[String])

/** One preset inside an import file. Same reasoning as [[RawImportRoute]]. */
final case class RawImportPreset(preset: RawPresetInput, createdAt: Option[String])

/** A whole import file before validation.
  *
  * `mode` is a `String` rather than an [[ImportMode]] because an unrecognised word is a `400` that names the two
  * accepted values, and a decoder that refused it would produce a `400` with a message about a Scala enum instead.
  */
final case class RawImportRequest(
    schemaVersion: Int,
    mode: String,
    routes: List[RawImportRoute],
    presets: List[RawImportPreset]
)

/** Why a create/update request could not be accepted. Shared by routes and presets, which are validated by exactly the
  * same rules once you get past their own two or three fields.
  *
  * These two cases exist separately because the contract maps them to different error codes: `UNKNOWN_EFFECT` versus
  * `VALIDATION_FAILED`, both with status 422.
  */
enum InputError {
  case Invalid(issues: List[ValidationIssue])
  case UnknownEffect(effectId: String)
}
