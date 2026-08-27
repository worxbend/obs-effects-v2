package obseffects.application

import munit.FunSuite
import obseffects.Fixtures
import obseffects.domain.JsonValue.*
import obseffects.domain.{BackupEnvelope, EffectDescriptor, EffectId, ParamKey, RawCanvasSettings}

import java.time.{Clock, Instant, ZoneOffset}

/** Tests for export and import.
  *
  * The property that matters most is the one in the middle of the suite: **a file with one bad record changes
  * nothing**. Import is the one operation in this service that can destroy an evening's configuration, and it is not
  * transactional — the compose stack runs a standalone `mongod`, which has no multi-document transactions — so the only
  * protection is that every record is checked before the first one is written. A test that watches a half-applied
  * import would be watching the exact failure this design exists to prevent.
  */
class AdminServiceSuite extends FunSuite {

  private val exportedAt = Instant.parse("2026-08-24T10:11:12.000Z")
  private val importedAt = Instant.parse("2026-08-25T08:00:00.000Z")

  private val starfield: EffectDescriptor =
    Fixtures.plasmaField.copy(id = EffectId.unsafe("starfield"), name = "Starfield")

  /** Everything an admin operation needs, with "now" pinned so timestamps can be asserted exactly. */
  private final case class Harness(
      admin: AdminService,
      routes: RouteService,
      presets: PresetService,
      routeRepository: InMemoryRouteRepository,
      presetRepository: InMemoryPresetRepository,
      events: RecordingRouteEvents
  )

  private def harnessAt(now: Instant): Harness = {
    val routeRepository = new InMemoryRouteRepository
    val presetRepository = new InMemoryPresetRepository
    val effects = new InMemoryEffectRepository(List(Fixtures.plasmaField, starfield))
    val events = new RecordingRouteEvents
    val clock = Clock.fixed(now, ZoneOffset.UTC)

    Harness(
      admin = new AdminService(routeRepository, presetRepository, effects, events, clock),
      routes = new RouteService(routeRepository, effects, events, clock),
      presets = new PresetService(presetRepository, effects, clock),
      routeRepository = routeRepository,
      presetRepository = presetRepository,
      events = events
    )
  }

  /** A harness with one route and one preset already in it. */
  private def populated(): Harness = {
    val harness = harnessAt(exportedAt)
    val _ = harness.routes.create(Fixtures.rawRoute()).getOrElse(fail("the fixture route should be valid"))
    val _ = harness.presets.create(Fixtures.rawPreset()).getOrElse(fail("the fixture preset should be valid"))
    harness
  }

  // -------------------------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------------------------

  test("an export carries the schema version, the moment it was taken, and everything stored") {
    val envelope = populated().admin.exportAll()

    assertEquals(envelope.schemaVersion, BackupEnvelope.CurrentSchemaVersion)
    assertEquals(envelope.exportedAt, exportedAt)
    assertEquals(envelope.routes.map(_.slug.value), List("main-camera"))
    assertEquals(envelope.presets.map(_.name), List("Neon night"))
  }

  test("an export of an empty database is a valid, empty envelope rather than a failure") {
    val envelope = harnessAt(exportedAt).admin.exportAll()
    assertEquals(envelope.routes, Nil)
    assertEquals(envelope.presets, Nil)
  }

  test("exported routes are ordered by slug and presets by effect and name") {
    val harness = harnessAt(exportedAt)
    val _ = harness.routes.create(Fixtures.rawRoute(slug = "zoom-cam"))
    val _ = harness.routes.create(Fixtures.rawRoute(slug = "alpha-cam"))
    val _ = harness.presets.create(Fixtures.rawPreset(name = "zebra"))
    val _ = harness.presets.create(Fixtures.rawPreset(name = "Apple"))

    val envelope = harness.admin.exportAll()
    assertEquals(envelope.routes.map(_.slug.value), List("alpha-cam", "zoom-cam"))
    assertEquals(envelope.presets.map(_.name), List("Apple", "zebra"))
  }

  // -------------------------------------------------------------------------------------------
  // Import — the happy paths
  // -------------------------------------------------------------------------------------------

  test("a round trip through export and import restores exactly what was there") {
    val source = populated()
    val envelope = source.admin.exportAll()

    val restored = harnessAt(importedAt)
    val file = Fixtures.importFile(
      mode = "replace",
      routes = envelope.routes.map(route =>
        Fixtures.importRoute(
          slug = route.slug.value,
          effectId = route.effectId.value,
          enabled = route.enabled,
          params = route.params.map((key, value) => key.value -> value),
          canvas = Some(
            RawCanvasSettings(
              Some(route.canvas.width.toDouble),
              Some(route.canvas.height.toDouble),
              route.canvas.fpsCap.map(_.toDouble)
            )
          ),
          createdAt = Some(route.createdAt.toString)
        )
      ),
      presets = envelope.presets.map(preset =>
        Fixtures.importPreset(
          name = preset.name,
          effectId = preset.effectId.value,
          params = preset.params.map((key, value) => key.value -> value),
          createdAt = Some(preset.createdAt.toString)
        )
      )
    )

    assertEquals(
      restored.admin.importAll(file),
      Right(obseffects.domain.ImportResult(1, 0, 0, 1, 0, 0))
    )

    val after = restored.admin.exportAll()
    assertEquals(after.routes.map(_.slug.value), List("main-camera"))
    assertEquals(after.routes.head.params, Map(ParamKey.unsafe("speed") -> JsonNumber(2.0)))
    assertEquals(after.routes.head.canvas, envelope.routes.head.canvas)
    assertEquals(after.presets.map(_.name), List("Neon night"))
  }

  test("createdAt is taken from the file, while updatedAt is always the moment of the import") {
    val harness = harnessAt(importedAt)
    val fileCreatedAt = Instant.parse("2025-01-02T03:04:05.000Z")

    val _ = harness.admin.importAll(
      Fixtures.importFile(routes = List(Fixtures.importRoute(createdAt = Some(fileCreatedAt.toString))))
    )

    val restored = harness.admin.exportAll().routes.head
    assertEquals(restored.createdAt, fileCreatedAt)
    assertEquals(restored.updatedAt, importedAt)
  }

  test("a createdAt that is not a timestamp falls back to the import time rather than rejecting the file") {
    val harness = harnessAt(importedAt)

    val result = harness.admin.importAll(
      Fixtures.importFile(routes = List(Fixtures.importRoute(createdAt = Some("last tuesday"))))
    )

    assert(result.isRight, s"expected the file to be accepted, got $result")
    assertEquals(harness.admin.exportAll().routes.head.createdAt, importedAt)
  }

  test("ids in the file are ignored: the server assigns its own") {
    val harness = harnessAt(importedAt)
    val _ = harness.admin.importAll(Fixtures.importFile(routes = List(Fixtures.importRoute())))

    // `ImportRouteDto` has no `id` field at all, so there is nothing for a hand-edited file to
    // overwrite. What this checks is that a stored route came out with a usable id anyway.
    assertEquals(harness.admin.exportAll().routes.head.id.value.length, 24)
  }

  test("merge overwrites a route with the same slug and keeps the stored createdAt") {
    val harness = populated()
    val originalCreatedAt = harness.admin.exportAll().routes.head.createdAt

    val later = new AdminService(
      harness.routeRepository,
      harness.presetRepository,
      new InMemoryEffectRepository(List(Fixtures.plasmaField, starfield)),
      harness.events,
      Clock.fixed(importedAt, ZoneOffset.UTC)
    )

    assertEquals(
      later.importAll(
        Fixtures.importFile(
          mode = "merge",
          routes = List(Fixtures.importRoute(enabled = false, createdAt = Some("2020-01-01T00:00:00Z")))
        )
      ),
      Right(obseffects.domain.ImportResult(0, 1, 0, 0, 0, 0))
    )

    val stored = later.exportAll().routes.head
    assertEquals(stored.enabled, false)
    assertEquals(stored.createdAt, originalCreatedAt)
    assertEquals(stored.updatedAt, importedAt)
  }

  test("merge matches a preset by effect and name, ignoring case") {
    val harness = populated()

    assertEquals(
      harness.admin.importAll(
        Fixtures.importFile(mode = "merge", presets = List(Fixtures.importPreset(name = "NEON NIGHT")))
      ),
      Right(obseffects.domain.ImportResult(0, 0, 0, 0, 1, 0))
    )

    assertEquals(harness.admin.exportAll().presets.map(_.name), List("NEON NIGHT"))
  }

  test("a merge announces only what it wrote, and never calls an untouched route absent") {
    val harness = populated()

    val _ = harness.admin.importAll(
      Fixtures.importFile(mode = "merge", routes = List(Fixtures.importRoute(slug = "second-camera")))
    )

    // "main-camera" was created by the fixture and is not in the file. In merge mode it is still
    // there afterwards, so announcing it as absent would blank a live browser source that had
    // nothing to do with this restore.
    assertEquals(harness.events.summary, List("config main-camera", "config second-camera"))
  }

  test("merge deletes nothing that the file does not mention") {
    val harness = populated()
    val _ = harness.admin.importAll(
      Fixtures.importFile(mode = "merge", routes = List(Fixtures.importRoute(slug = "second-camera")))
    )
    assertEquals(harness.admin.exportAll().routes.map(_.slug.value), List("main-camera", "second-camera"))
  }

  test("replace empties both collections first and reports what it removed") {
    val harness = populated()

    assertEquals(
      harness.admin.importAll(
        Fixtures.importFile(mode = "replace", routes = List(Fixtures.importRoute(slug = "second-camera")))
      ),
      Right(obseffects.domain.ImportResult(1, 0, 1, 0, 0, 1))
    )

    assertEquals(harness.admin.exportAll().routes.map(_.slug.value), List("second-camera"))
    assertEquals(harness.admin.exportAll().presets, Nil)
  }

  test("importing the same file twice in merge mode changes nothing the second time") {
    val harness = harnessAt(importedAt)
    val file = Fixtures.importFile(routes = List(Fixtures.importRoute()), presets = List(Fixtures.importPreset()))

    assertEquals(harness.admin.importAll(file), Right(obseffects.domain.ImportResult(1, 0, 0, 1, 0, 0)))
    assertEquals(harness.admin.importAll(file), Right(obseffects.domain.ImportResult(0, 1, 0, 0, 1, 0)))
    assertEquals(harness.admin.exportAll().routes.size, 1)
    assertEquals(harness.admin.exportAll().presets.size, 1)
  }

  test("a replace announces every route it wrote, and announces a removed slug as absent") {
    val harness = populated()

    val _ = harness.admin.importAll(
      Fixtures.importFile(mode = "replace", routes = List(Fixtures.importRoute(slug = "second-camera")))
    )

    assertEquals(
      harness.events.summary,
      List("config main-camera", "absent main-camera", "config second-camera")
    )
  }

  // -------------------------------------------------------------------------------------------
  // Import — the refusals
  // -------------------------------------------------------------------------------------------

  test("a mode that names no operation is a bad request, and there is no default") {
    val harness = populated()
    assert(harness.admin.importAll(Fixtures.importFile(mode = "overwrite")).swap.exists {
      case AppError.BadRequest(_) => true
      case _                      => false
    })
  }

  test("a schema version this build does not read is a validation failure naming the field") {
    val harness = harnessAt(importedAt)
    harness.admin.importAll(Fixtures.importFile(schemaVersion = 2)) match {
      case Left(AppError.ValidationFailed(issues)) => assertEquals(issues.map(_.field), List("schemaVersion"))
      case other                                   => fail(s"expected a validation failure, got $other")
    }
  }

  test("one bad record rejects the whole file and writes nothing") {
    val harness = populated()
    val before = harness.admin.exportAll()

    val result = harness.admin.importAll(
      Fixtures.importFile(
        mode = "replace",
        routes = List(Fixtures.importRoute(slug = "fine-camera"), Fixtures.importRoute(slug = "Not A Slug"))
      )
    )

    assert(result.isLeft, s"expected the file to be refused, got $result")
    assertEquals(harness.admin.exportAll().routes.map(_.slug.value), before.routes.map(_.slug.value))
    assertEquals(harness.admin.exportAll().presets.map(_.name), before.presets.map(_.name))
  }

  test("a refused import announces nothing, so a live browser source is not told about a restore that did not happen") {
    val harness = harnessAt(importedAt)
    val _ = harness.admin.importAll(Fixtures.importFile(routes = List(Fixtures.importRoute(slug = "Not A Slug"))))
    assertEquals(harness.events.summary, Nil)
  }

  test("every problem in a file is reported at once, with paths that point into the file") {
    val harness = harnessAt(importedAt)

    harness.admin.importAll(
      Fixtures.importFile(
        routes = List(
          Fixtures.importRoute(slug = "fine-camera"),
          Fixtures.importRoute(slug = "Not A Slug"),
          Fixtures.importRoute(slug = "third-camera", params = Map("speed" -> JsonString("fast")))
        ),
        presets = List(Fixtures.importPreset(name = "  "))
      )
    ) match {
      case Left(AppError.ValidationFailed(issues)) =>
        assertEquals(issues.map(_.field), List("routes[1].slug", "routes[2].params.speed", "presets[0].name"))
      case other => fail(s"expected a validation failure, got $other")
    }
  }

  test("an unknown effect inside a file is a validation issue, not the 422 UNKNOWN_EFFECT a single create gets") {
    val harness = harnessAt(importedAt)

    harness.admin.importAll(
      Fixtures.importFile(routes = List(Fixtures.importRoute(effectId = "ghost-effect")))
    ) match {
      case Left(AppError.ValidationFailed(issues)) => assertEquals(issues.map(_.field), List("routes[0].effectId"))
      case other                                   => fail(s"expected a validation failure, got $other")
    }
  }

  test("the same slug twice in one file is refused, because merging a file against itself has no defined answer") {
    val harness = harnessAt(importedAt)

    harness.admin.importAll(
      Fixtures.importFile(routes = List(Fixtures.importRoute(), Fixtures.importRoute()))
    ) match {
      case Left(AppError.ValidationFailed(issues)) => assertEquals(issues.map(_.field), List("routes"))
      case other                                   => fail(s"expected a validation failure, got $other")
    }
  }

  test("the same effect and preset name twice in one file is refused, compared without regard to case") {
    val harness = harnessAt(importedAt)

    harness.admin.importAll(
      Fixtures.importFile(presets = List(Fixtures.importPreset(name = "Neon"), Fixtures.importPreset(name = "neon")))
    ) match {
      case Left(AppError.ValidationFailed(issues)) => assertEquals(issues.map(_.field), List("presets"))
      case other                                   => fail(s"expected a validation failure, got $other")
    }
  }

  test("two effects may each carry a preset of the same name in one file") {
    val harness = harnessAt(importedAt)

    assert(
      harness.admin
        .importAll(
          Fixtures.importFile(presets =
            List(
              Fixtures.importPreset(name = "Default", effectId = "plasma-field"),
              Fixtures.importPreset(name = "Default", effectId = "starfield")
            )
          )
        )
        .isRight
    )
  }

  test("a bad canvas value inside a file is reported with the record's path") {
    val harness = harnessAt(importedAt)

    harness.admin.importAll(
      Fixtures.importFile(routes =
        List(Fixtures.importRoute(canvas = Some(RawCanvasSettings(Some(19200.0), None, None))))
      )
    ) match {
      case Left(AppError.ValidationFailed(issues)) => assertEquals(issues.map(_.field), List("routes[0].canvas.width"))
      case other                                   => fail(s"expected a validation failure, got $other")
    }
  }
}
