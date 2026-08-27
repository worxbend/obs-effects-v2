package obseffects.application

import munit.FunSuite
import obseffects.Fixtures
import obseffects.domain.JsonValue.*
import obseffects.domain.{EffectDescriptor, EffectId, ParamKey, ValidationIssue}

import java.time.{Clock, Instant, ZoneOffset}

/** Tests for the preset use cases, run against the in-memory repositories.
  *
  * The rules being pinned down come from `docs/CONTRACT.md` §5 rules 9 to 11: a name is trimmed and bounded, a name is
  * unique within one effect ignoring case, and `effectId` and `params` are checked by exactly the same code a route
  * goes through.
  */
class PresetServiceSuite extends FunSuite {

  private val createdAt = Instant.parse("2026-08-24T09:00:00.000Z")
  private val laterOn = Instant.parse("2026-08-24T09:30:00.000Z")

  /** A second effect, so the "two effects may each own a preset called Default" rule can be tested. */
  private val starfield: EffectDescriptor =
    Fixtures.plasmaField.copy(id = EffectId.unsafe("starfield"), name = "Starfield")

  private def serviceAt(now: Instant): (PresetService, InMemoryPresetRepository) = {
    val presets = new InMemoryPresetRepository
    val effects = new InMemoryEffectRepository(List(Fixtures.plasmaField, starfield))
    (new PresetService(presets, effects, Clock.fixed(now, ZoneOffset.UTC)), presets)
  }

  private def createdPreset() = {
    val (service, presets) = serviceAt(createdAt)
    val preset = service.create(Fixtures.rawPreset()).getOrElse(fail("the fixture preset should be valid"))
    (service, presets, preset)
  }

  test("creating a preset stores it with a server-assigned id and timestamps") {
    val (_, _, preset) = createdPreset()
    assertEquals(preset.name, "Neon night")
    assertEquals(preset.effectId.value, "plasma-field")
    assertEquals(preset.params, Map(ParamKey.unsafe("speed") -> JsonNumber(3.0)))
    assertEquals(preset.createdAt, createdAt)
    assertEquals(preset.updatedAt, createdAt)
    assertEquals(preset.id.value.length, 24)
  }

  test("a preset name is stored trimmed") {
    val (service, _) = serviceAt(createdAt)
    val preset = service.create(Fixtures.rawPreset(name = "  Neon night  ")).getOrElse(fail("should be valid"))
    assertEquals(preset.name, "Neon night")
  }

  test("a preset name of nothing but whitespace fails validation") {
    val (service, _) = serviceAt(createdAt)
    service.create(Fixtures.rawPreset(name = "   ")) match {
      case Left(AppError.ValidationFailed(issues)) =>
        assertEquals(issues, List(ValidationIssue("name", "must contain at least one non-space character")))
      case other => fail(s"expected a validation failure, got $other")
    }
  }

  test("a preset name longer than 64 characters fails validation") {
    val (service, _) = serviceAt(createdAt)
    assert(service.create(Fixtures.rawPreset(name = "n" * 65)).swap.exists {
      case AppError.ValidationFailed(_) => true
      case _                            => false
    })
  }

  test("a name of exactly 64 characters is accepted") {
    val (service, _) = serviceAt(createdAt)
    assert(service.create(Fixtures.rawPreset(name = "n" * 64)).isRight)
  }

  test("two presets of one effect may not have names differing only in case") {
    val (service, _, _) = createdPreset()
    assertEquals(
      service.create(Fixtures.rawPreset(name = "NEON NIGHT")),
      Left(AppError.NameConflict("plasma-field", "NEON NIGHT"))
    )
  }

  test("two different effects may each own a preset with the same name") {
    val (service, _, _) = createdPreset()
    assert(service.create(Fixtures.rawPreset(effectId = "starfield")).isRight)
  }

  test("creating a preset for an effect that is not in the inventory is an unknown-effect error") {
    val (service, _) = serviceAt(createdAt)
    assertEquals(
      service.create(Fixtures.rawPreset(effectId = "ghost-effect")),
      Left(AppError.UnknownEffect("ghost-effect"))
    )
  }

  test("a preset parameter is checked by the same rules a route's is") {
    val (service, _) = serviceAt(createdAt)
    service.create(Fixtures.rawPreset(params = Map("speed" -> JsonString("fast")))) match {
      case Left(AppError.ValidationFailed(issues)) =>
        assertEquals(issues, List(ValidationIssue("params.speed", "expected number, got string")))
      case other => fail(s"expected a validation failure, got $other")
    }
  }

  test("a preset parameter the effect does not declare is rejected rather than dropped") {
    val (service, _) = serviceAt(createdAt)
    service.create(Fixtures.rawPreset(params = Map("speeed" -> JsonNumber(1.0)))) match {
      case Left(AppError.ValidationFailed(issues)) => assertEquals(issues.map(_.field), List("params.speeed"))
      case other                                   => fail(s"expected a validation failure, got $other")
    }
  }

  test("fetching a preset by an id that is not an ObjectId is a bad request, not a not-found") {
    val (service, _) = serviceAt(createdAt)
    assert(service.getById("banana").swap.exists(_.isInstanceOf[AppError.BadRequest]))
  }

  test("fetching a preset by an unused but well-formed id is a not-found") {
    val (service, _) = serviceAt(createdAt)
    assert(service.getById("66ca1f39e1a4c3d2b1a01234").swap.exists(_.isInstanceOf[AppError.NotFound]))
  }

  test("updating a preset replaces its parameters completely and refreshes updatedAt") {
    val (_, presets, preset) = createdPreset()
    val effects = new InMemoryEffectRepository(List(Fixtures.plasmaField, starfield))
    val later = new PresetService(presets, effects, Clock.fixed(laterOn, ZoneOffset.UTC))

    val updated = later
      .update(preset.id.value, Fixtures.rawPreset(params = Map("tint" -> JsonString("#00ff00"))))
      .getOrElse(fail("the update should be accepted"))

    assertEquals(updated.params, Map(ParamKey.unsafe("tint") -> JsonString("#00ff00")))
    assertEquals(updated.createdAt, createdAt)
    assertEquals(updated.updatedAt, laterOn)
  }

  test("an update may move a preset to a different effect, and the parameters are checked against the new one") {
    val (service, _, preset) = createdPreset()
    assert(service.update(preset.id.value, Fixtures.rawPreset(effectId = "starfield")).isRight)
  }

  test("updating a preset to keep its own name is not a conflict") {
    val (service, _, preset) = createdPreset()
    assert(service.update(preset.id.value, Fixtures.rawPreset(params = Map.empty)).isRight)
  }

  test("updating a preset to a name another preset of that effect owns is a conflict") {
    val (service, _, preset) = createdPreset()
    val _ = service.create(Fixtures.rawPreset(name = "Cold morning"))
    assertEquals(
      service.update(preset.id.value, Fixtures.rawPreset(name = "cold morning")),
      Left(AppError.NameConflict("plasma-field", "cold morning"))
    )
  }

  test("updating a preset that does not exist is a not-found") {
    val (service, _) = serviceAt(createdAt)
    assert(
      service
        .update("66ca1f39e1a4c3d2b1a01234", Fixtures.rawPreset())
        .swap
        .exists(_.isInstanceOf[AppError.NotFound])
    )
  }

  test("deleting a preset removes it, and deleting it again is a not-found") {
    val (service, _, preset) = createdPreset()
    assertEquals(service.delete(preset.id.value), Right(()))
    assert(service.delete(preset.id.value).swap.exists(_.isInstanceOf[AppError.NotFound]))
  }

  test("presets are listed by effect id and then by name, ignoring case") {
    val (service, _) = serviceAt(createdAt)
    val _ = service.create(Fixtures.rawPreset(name = "zebra", effectId = "plasma-field"))
    val _ = service.create(Fixtures.rawPreset(name = "Apple", effectId = "plasma-field"))
    val _ = service.create(Fixtures.rawPreset(name = "Anything", effectId = "starfield"))

    assertEquals(
      service.list(None).map(preset => s"${preset.effectId.value}/${preset.name}"),
      List("plasma-field/Apple", "plasma-field/zebra", "starfield/Anything")
    )
  }

  test("the effectId filter narrows the list to one effect") {
    val (service, _) = serviceAt(createdAt)
    val _ = service.create(Fixtures.rawPreset(effectId = "plasma-field"))
    val _ = service.create(Fixtures.rawPreset(effectId = "starfield"))

    assertEquals(service.list(Some("starfield")).map(_.effectId.value), List("starfield"))
  }

  test("filtering by an effect nobody has heard of gives an empty list rather than an error") {
    val (service, _, _) = createdPreset()
    assertEquals(service.list(Some("ghost-effect")), Nil)
  }

  test("filtering by something that is not even a well-formed effect id gives an empty list") {
    val (service, _, _) = createdPreset()
    assertEquals(service.list(Some("Not An Id")), Nil)
  }
}
