package obseffects.application

import munit.FunSuite
import obseffects.domain.*
import obseffects.domain.JsonValue.*

import java.time.{Clock, Instant, ZoneOffset}

/** The start-up migration that follows an effect rename, run against the in-memory repositories. */
class LegacyEffectIdsSuite extends FunSuite {

  private val storedAt = Instant.parse("2026-08-23T14:05:09.123Z")
  private val startedAt = Instant.parse("2026-09-02T09:00:00.000Z")

  private val text = ParamKey.unsafe("text")
  private val density = ParamKey.unsafe("density")

  private def fixture() = {
    val routes = new InMemoryRouteRepository
    val presets = new InMemoryPresetRepository
    val migration = new LegacyEffectIds(routes, presets, Clock.fixed(startedAt, ZoneOffset.UTC))
    (migration, routes, presets)
  }

  private def routeInput(slug: String, effectId: String, params: Map[ParamKey, JsonValue]): RouteInput =
    RouteInput(Slug.unsafe(slug), EffectId.unsafe(effectId), enabled = true, params, CanvasSettings.Default)

  test("a route pointing at a renamed effect is moved to the new id and its old default text is pinned") {
    val (migration, routes, _) = fixture()
    val stored = routes
      .insert(routeInput("intro", "worxbend-text", Map(density -> JsonNumber(6))), storedAt, storedAt)
      .getOrElse(fail("insert should succeed"))

    assertEquals(migration.migrate(), 1)

    val migrated = routes.findById(stored.id).getOrElse(fail("the route should still exist"))
    assertEquals(migrated.effectId.value, "particle-text")
    assertEquals(migrated.params, Map(density -> JsonNumber(6), text -> JsonString("WORXBEND")))
    assertEquals(migrated.createdAt, storedAt)
    assertEquals(migrated.updatedAt, startedAt)
  }

  test("a route that had already chosen its own text keeps it") {
    val (migration, routes, _) = fixture()
    val stored = routes
      .insert(routeInput("intro", "worxbend-fluid", Map(text -> JsonString("BE RIGHT BACK"))), storedAt, storedAt)
      .getOrElse(fail("insert should succeed"))

    migration.migrate()

    val migrated = routes.findById(stored.id).getOrElse(fail("the route should still exist"))
    assertEquals(migrated.effectId.value, "fluid-text")
    assertEquals(migrated.params, Map(text -> JsonString("BE RIGHT BACK")))
  }

  test("presets are migrated the same way") {
    val (migration, _, presets) = fixture()
    val stored = presets
      .insert(PresetInput("Big red", EffectId.unsafe("worxbend-3d-text"), Map.empty), storedAt, storedAt)
      .getOrElse(fail("insert should succeed"))

    assertEquals(migration.migrate(), 1)

    val migrated = presets.findById(stored.id).getOrElse(fail("the preset should still exist"))
    assertEquals(migrated.effectId.value, "jelly-text-3d")
    assertEquals(migrated.params, Map(text -> JsonString("WORXBEND")))
  }

  test("routes on effects that were never renamed are left untouched, and a second run changes nothing") {
    val (migration, routes, _) = fixture()
    val stored = routes
      .insert(routeInput("cam", "plasma-field", Map.empty), storedAt, storedAt)
      .getOrElse(fail("insert should succeed"))
    val _ = routes.insert(routeInput("intro", "worxbend-molecular", Map.empty), storedAt, storedAt)

    assertEquals(migration.migrate(), 1)
    assertEquals(migration.migrate(), 0)

    val untouched = routes.findById(stored.id).getOrElse(fail("the route should still exist"))
    assertEquals(untouched.effectId.value, "plasma-field")
    assertEquals(untouched.updatedAt, storedAt)
  }
}
