package obseffects.application

import munit.FunSuite
import obseffects.Fixtures
import obseffects.domain.JsonValue.JsonString

/** Tests for the inventory use cases: listing effects and replacing the inventory wholesale. */
class EffectServiceSuite extends FunSuite {

  private def service(): (EffectService, InMemoryEffectRepository) = {
    val repository = new InMemoryEffectRepository()
    (new EffectService(repository), repository)
  }

  test("syncing a manifest stores every descriptor in it") {
    val (effects, _) = service()
    assertEquals(
      effects.sync(List(Fixtures.rawPlasmaField)),
      Right(EffectSyncOutcome(upserted = 1, removed = 0, total = 1))
    )
    assertEquals(effects.list().map(_.id.value), List("plasma-field"))
  }

  test("syncing the same manifest twice changes nothing the second time") {
    val (effects, _) = service()
    val _ = effects.sync(List(Fixtures.rawPlasmaField))
    assertEquals(
      effects.sync(List(Fixtures.rawPlasmaField)),
      Right(EffectSyncOutcome(upserted = 0, removed = 0, total = 1))
    )
  }

  test("syncing a manifest without a previously known effect removes it") {
    val (effects, _) = service()
    val other = Fixtures.rawPlasmaField.copy(id = "aurora", name = "Aurora")
    val _ = effects.sync(List(Fixtures.rawPlasmaField, other))
    assertEquals(effects.sync(List(other)), Right(EffectSyncOutcome(upserted = 0, removed = 1, total = 1)))
  }

  test("an invalid manifest is rejected and leaves the inventory untouched") {
    val (effects, _) = service()
    val _ = effects.sync(List(Fixtures.rawPlasmaField))
    val broken = Fixtures.rawPlasmaField.copy(params = List(Fixtures.rawSpeed.copy(default = JsonString("fast"))))

    assert(effects.sync(List(broken)).swap.exists(_.isInstanceOf[AppError.ValidationFailed]))
    assertEquals(effects.list().map(_.id.value), List("plasma-field"))
  }

  test("effects are listed by name, ignoring case") {
    val (effects, _) = service()
    val aurora = Fixtures.rawPlasmaField.copy(id = "aurora", name = "aurora")
    val bokeh = Fixtures.rawPlasmaField.copy(id = "bokeh", name = "Bokeh")
    val _ = effects.sync(List(Fixtures.rawPlasmaField, bokeh, aurora))
    assertEquals(effects.list().map(_.name), List("aurora", "Bokeh", "Plasma Field"))
  }
}
