package obseffects.application

import obseffects.domain.*

import java.time.{Clock, Instant}

/** The backup story: write everything the operator configured into one file, and read one back.
  *
  * Losing the MongoDB volume currently loses every scene, which is the whole reason this exists. Effects are not part
  * of it — the inventory is code that lives in the frontend bundle and is republished on every admin page load, so a
  * descriptor in a backup file could only ever contradict the running build.
  *
  * @param clock
  *   the source of "now": the `exportedAt` stamp, and the `updatedAt` every imported record gets.
  */
class AdminService(
    routes: RouteRepository,
    presets: PresetRepository,
    effects: EffectRepository,
    events: RouteEventPublisher,
    clock: Clock
) {

  /** Everything, complete — including each record's `id`, `createdAt` and `updatedAt`, so the file is a faithful record
    * of what was there. What an import does with those fields is [[importAll]]'s business.
    */
  def exportAll(): BackupEnvelope =
    BackupEnvelope(
      schemaVersion = BackupEnvelope.CurrentSchemaVersion,
      exportedAt = clock.instant(),
      routes = routes.listAll().sortBy(_.slug.value),
      presets = presets.listAll().sortBy(preset => (preset.effectId.value, preset.name.toLowerCase))
    )

  /** Restores a file.
    *
    * ==Why every record is checked before any record is written==
    *
    * The compose stack runs a standalone `mongod`, and MongoDB's multi-document transactions require a replica set, so
    * these writes are **not atomic**: nothing can roll them back once they have started. That leaves exactly one lever
    * — how much of the work happens before the first write — and this method pulls it all the way. `Validation` reads
    * the whole file, collects every problem in it, and only hands back an [[ImportContents]] when there is nothing
    * wrong anywhere. A file with one bad value is refused having changed nothing.
    *
    * What that does *not* protect against is the process dying halfway through the writes, which for a `replace` can
    * leave a partly restored database. Re-running the same import repairs it: for a given file both modes are
    * idempotent. Shrinking the window from "one bad value in the file left half a restore behind" to "the process died"
    * is the honest description of what is bought here, and `docs/CONTRACT.md` §4 says the same thing to the operator.
    *
    * ==What happens to ids and timestamps==
    *
    *   - `id` is always server-assigned and never taken from the file, so a hand-edited file with a duplicate or
    *     malformed id cannot corrupt the database.
    *   - `createdAt` comes from the file when it parses as an ISO-8601 instant, and is the import time otherwise. A
    *     restore that reports every scene as created today loses information for no reason. A record that *matched* an
    *     existing one in `merge` mode keeps the stored `createdAt` instead — it is the older and truer of the two.
    *   - `updatedAt` is always the import time.
    */
  def importAll(raw: RawImportRequest): Either[AppError, ImportResult] =
    for {
      mode <- parseMode(raw.mode)
      contents <- Validation.validateImport(raw, findEffect).left.map(AppError.ValidationFailed.apply)
      result <- write(mode, contents)
    } yield result

  // -------------------------------------------------------------------------------------------

  /** An unrecognised `mode` is a `400` rather than a `422`, and the contract is explicit about it: the field describes
    * *what operation to perform*, so a word that names no operation makes the request itself unreadable rather than
    * making its contents invalid. There is no default, because the two values differ by "nothing is deleted" versus
    * "everything is deleted first" and guessing wrong destroys a scene collection.
    */
  private def parseMode(raw: String): Either[AppError, ImportMode] =
    ImportMode
      .fromWire(raw)
      .toRight(AppError.BadRequest(s"'mode' must be one of: ${ImportMode.allNames.mkString(", ")}"))

  private def findEffect(rawEffectId: String): Option[EffectDescriptor] =
    EffectId.parse(rawEffectId).toOption.flatMap(effects.findById)

  private def write(mode: ImportMode, contents: ImportContents): Either[AppError, ImportResult] = {
    val now = clock.instant()

    // Captured before anything is deleted, so subscribers to a slug that the restore removes can
    // be told it is gone. After the delete there is nothing left to read the slug from.
    val slugsBefore = routes.listAll().map(_.slug).toSet

    val (routesDeleted, presetsDeleted) = mode match {
      case ImportMode.Merge   => (0L, 0L)
      case ImportMode.Replace => (routes.deleteAll(), presets.deleteAll())
    }

    val routeOutcomes = contents.routes.map(entry => writeRoute(mode, entry, now))
    val presetOutcomes = contents.presets.map(entry => writePreset(mode, entry, now))

    val firstFailure = (routeOutcomes ++ presetOutcomes).collectFirst { case Left(error) => error }

    firstFailure.toLeft {
      // Two announcements, and the difference between them matters. A slug that was there before
      // and is not there now has to be reported as gone, and it is found by comparing the two
      // listings rather than by looking at what this import wrote: in `merge` mode a route the
      // file never mentions is still there afterwards, so "everything the file did not write" is
      // the wrong set and would tell live browser sources to go blank.
      val slugsAfter = routes.listAll().map(_.slug).toSet
      slugsBefore.diff(slugsAfter).foreach(events.routeRemoved)

      val savedRoutes = routeOutcomes.collect { case Right((route, _)) => route }
      savedRoutes.foreach(events.routeChanged)

      ImportResult(
        routesCreated = routeOutcomes.count { case Right((_, created)) => created; case _ => false },
        routesUpdated = routeOutcomes.count { case Right((_, created)) => !created; case _ => false },
        routesDeleted = routesDeleted.toInt,
        presetsCreated = presetOutcomes.count { case Right(created) => created; case _ => false },
        presetsUpdated = presetOutcomes.count { case Right(created) => !created; case _ => false },
        presetsDeleted = presetsDeleted.toInt
      )
    }
  }

  /** Writes one route and says whether that was a create (`true`) or an overwrite (`false`).
    *
    * In `replace` mode the collection is already empty, so every record is a create. In `merge` mode a record is
    * matched to an existing route **by slug**, which is the only field an operator recognises a route by.
    *
    * A `SlugTaken` here would mean another writer created that slug between the lookup and the insert. The file itself
    * cannot cause it — duplicate slugs inside one file are rejected during validation — so it is reported as an
    * internal error rather than as a `409` blaming the operator for something a second admin session did.
    */
  private def writeRoute(
      mode: ImportMode,
      entry: ImportRouteEntry,
      now: Instant
  ): Either[AppError, (RouteConfig, Boolean)] = {
    val existing = if (mode == ImportMode.Merge) routes.findBySlug(entry.input.slug) else None

    existing match {
      case Some(stored) =>
        routes
          .replace(stored.id, entry.input, now)
          .left
          .map(conflict("route", entry.input.slug.value))
          .flatMap(_.toRight(AppError.internal(s"Route '${entry.input.slug.value}' disappeared during the import")))
          .map(route => (route, false))

      case None =>
        routes
          .insert(entry.input, createdAt = entry.createdAt.getOrElse(now), updatedAt = now)
          .left
          .map(conflict("route", entry.input.slug.value))
          .map(route => (route, true))
    }
  }

  /** Writes one preset and says whether that was a create. Matched in `merge` mode by `effectId` + `name`, compared
    * without regard to case — the same rule that makes the name unique in the first place.
    */
  private def writePreset(
      mode: ImportMode,
      entry: ImportPresetEntry,
      now: Instant
  ): Either[AppError, Boolean] = {
    val existing =
      if (mode == ImportMode.Merge) presets.findByEffectAndName(entry.input.effectId, entry.input.name) else None

    existing match {
      case Some(stored) =>
        presets
          .replace(stored.id, entry.input, now)
          .left
          .map(conflict("preset", entry.input.name))
          .flatMap(_.toRight(AppError.internal(s"Preset '${entry.input.name}' disappeared during the import")))
          .map(_ => false)

      case None =>
        presets
          .insert(entry.input, createdAt = entry.createdAt.getOrElse(now), updatedAt = now)
          .left
          .map(conflict("preset", entry.input.name))
          .map(_ => true)
    }
  }

  private def conflict(kind: String, name: String)(failure: RepositoryFailure): AppError = {
    val _ = failure
    AppError.internal(s"Another writer took the $kind '$name' while the import was running")
  }
}
