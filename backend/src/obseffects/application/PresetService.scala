package obseffects.application

import obseffects.domain.*

import java.time.Clock

/** The use cases around presets: named parameter sets the admin can start a route from.
  *
  * This class is deliberately the same shape as [[RouteService]], because a preset is the same kind of thing as a
  * route. What differs is only what "already taken" means — a slug for a route, a name within one effect for a preset —
  * and that a preset has nothing an OBS browser source reads, so nothing here publishes an event.
  *
  * **There is no "apply this preset to that route" method, and there is no endpoint for one either.** Applying a preset
  * is the admin UI copying `preset.params` into the route form, which the operator then reviews and saves through the
  * ordinary route endpoints. A server-side apply would be a second way to write a route — a second place for validation
  * and for the `updatedAt` bump to drift — and it would remove the moment of adjustment that is the reason to start
  * from a preset at all.
  *
  * @param clock
  *   the source of "now", injected so a test can pin `createdAt` and `updatedAt` exactly.
  */
class PresetService(presets: PresetRepository, effects: EffectRepository, clock: Clock) {

  /** Lists presets, optionally narrowed to one effect, sorted by effect id and then by name ignoring case.
    *
    * An `effectId` filter that names an effect nobody has heard of — or that is not even a well-formed effect id —
    * yields an **empty list**, not a `404`. A filter that matches nothing is a normal outcome; only a *lookup* of
    * something that ought to exist is a not-found. Answering `404` here would make the presets screen show an error the
    * first time an operator selected an effect that has no presets yet.
    */
  def list(effectIdFilter: Option[String]): List[Preset] = {
    val all = presets.listAll()
    val filtered = effectIdFilter match {
      case None      => all
      case Some(raw) => all.filter(_.effectId.value == raw)
    }
    filtered.sortBy(preset => (preset.effectId.value, preset.name.toLowerCase))
  }

  def getById(rawId: String): Either[AppError, Preset] =
    for {
      id <- parseId(rawId)
      preset <- presets.findById(id).toRight(notFoundById(rawId))
    } yield preset

  def create(raw: RawPresetInput): Either[AppError, Preset] = {
    val now = clock.instant()
    for {
      input <- validate(raw)
      saved <- presets.insert(input, createdAt = now, updatedAt = now).left.map(writeConflict(input))
    } yield saved
  }

  /** Replaces a preset completely. It may change `effectId`, in which case `params` is checked against the *new* effect
    * and any key that effect does not declare is a validation failure — the same rule a route update follows.
    */
  def update(rawId: String, raw: RawPresetInput): Either[AppError, Preset] =
    for {
      id <- parseId(rawId)
      input <- validate(raw)
      replaced <- presets.replace(id, input, clock.instant()).left.map(writeConflict(input))
      saved <- replaced.toRight(notFoundById(rawId))
    } yield saved

  def delete(rawId: String): Either[AppError, Unit] =
    for {
      id <- parseId(rawId)
      deleted <- Either.cond(presets.delete(id), (), notFoundById(rawId))
    } yield deleted

  def count(): Long = presets.count()

  // -------------------------------------------------------------------------------------------

  private def validate(raw: RawPresetInput): Either[AppError, PresetInput] =
    Validation.validatePresetInput(raw, findEffect).left.map {
      case InputError.UnknownEffect(effectId) => AppError.UnknownEffect(effectId)
      case InputError.Invalid(issues)         => AppError.ValidationFailed(issues)
    }

  private def findEffect(rawEffectId: String): Option[EffectDescriptor] =
    EffectId.parse(rawEffectId).toOption.flatMap(effects.findById)

  private def parseId(rawId: String): Either[AppError, PresetId] =
    PresetId.parse(rawId).left.map(message => AppError.BadRequest(s"Invalid preset id '$rawId': $message"))

  private def notFoundById(rawId: String): AppError = AppError.NotFound(s"No preset with id '$rawId'")

  /** The only storage failure a preset write can produce is a taken name; `SlugTaken` belongs to routes and cannot
    * reach here, so it becomes the internal error it would in fact be rather than a misleading 409.
    */
  private def writeConflict(input: PresetInput)(failure: RepositoryFailure): AppError = failure match {
    case RepositoryFailure.NameTaken => AppError.NameConflict(input.effectId.value, input.name)
    case RepositoryFailure.SlugTaken => AppError.internal("A preset write reported a route slug conflict")
  }
}
