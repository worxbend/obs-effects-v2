package obseffects.application

import obseffects.domain.*

/** The use cases around the effect inventory: list it, and replace it wholesale when the frontend publishes the effects
  * it actually implements.
  */
class EffectService(effects: EffectRepository) {

  /** The whole inventory, sorted by name, ignoring upper/lower case so `Aurora` and `aurora` sort next to each other
    * rather than in two separate blocks.
    */
  def list(): List[EffectDescriptor] = effects.listAll().sortBy(_.name.toLowerCase)

  /** Handles `POST /api/effects/sync`: validate the manifest, then make it the complete inventory.
    *
    * The operation is idempotent — sending the same manifest twice leaves the database exactly as it was after the
    * first call.
    */
  def sync(manifest: List[RawEffectDescriptor]): Either[AppError, EffectSyncOutcome] =
    Validation.validateManifest(manifest) match {
      case Left(issues)       => Left(AppError.ValidationFailed(issues))
      case Right(descriptors) => Right(effects.replaceAll(descriptors))
    }
}
