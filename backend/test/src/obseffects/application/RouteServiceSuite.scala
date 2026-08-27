package obseffects.application

import munit.FunSuite
import obseffects.Fixtures
import obseffects.domain.JsonValue.*
import obseffects.domain.{ParamKey, ValidationIssue}

import java.time.{Clock, Instant, ZoneOffset}

/** Tests for the route use cases, run against the in-memory repositories. */
class RouteServiceSuite extends FunSuite {

  private val createdAt = Instant.parse("2026-08-23T14:05:09.123Z")
  private val laterOn = Instant.parse("2026-08-23T14:07:41.004Z")

  /** Builds a service whose "now" is fixed, so timestamps can be asserted exactly, together with the recorder that
    * captures whatever it announces to the event stream.
    */
  private def serviceAt(now: Instant): (RouteService, InMemoryRouteRepository, RecordingRouteEvents) = {
    val routes = new InMemoryRouteRepository
    val effects = new InMemoryEffectRepository(List(Fixtures.plasmaField))
    val events = new RecordingRouteEvents
    (new RouteService(routes, effects, events, Clock.fixed(now, ZoneOffset.UTC)), routes, events)
  }

  private def createdRoute() = {
    val (service, routes, events) = serviceAt(createdAt)
    val route = service.create(Fixtures.rawRoute()).getOrElse(fail("the fixture route should be valid"))
    (service, routes, events, route)
  }

  test("creating a route stores it with server-assigned id and timestamps") {
    val (_, _, _, route) = createdRoute()
    assertEquals(route.slug.value, "main-camera")
    assertEquals(route.createdAt, createdAt)
    assertEquals(route.updatedAt, createdAt)
    assertEquals(route.id.value.length, 24)
  }

  test("creating a route only stores the parameters that were sent") {
    val (_, _, _, route) = createdRoute()
    assertEquals(route.params, Map(ParamKey.unsafe("speed") -> JsonNumber(2.0)))
  }

  test("creating a second route with the same slug is a conflict") {
    val (service, _, _, _) = createdRoute()
    assertEquals(service.create(Fixtures.rawRoute()), Left(AppError.SlugConflict("main-camera")))
  }

  test("creating a route for an effect that is not in the inventory is an unknown-effect error") {
    val (service, _, _) = serviceAt(createdAt)
    assertEquals(
      service.create(Fixtures.rawRoute(effectId = "ghost-effect")),
      Left(AppError.UnknownEffect("ghost-effect"))
    )
  }

  test("creating a route with a bad parameter value fails validation") {
    val (service, _, _) = serviceAt(createdAt)
    service.create(Fixtures.rawRoute(params = Map("speed" -> JsonString("fast")))) match {
      case Left(AppError.ValidationFailed(issues)) =>
        assertEquals(issues, List(ValidationIssue("params.speed", "expected number, got string")))
      case other => fail(s"expected a validation failure, got $other")
    }
  }

  test("fetching a route by an id that is not an ObjectId is a bad request, not a not-found") {
    val (service, _, _) = serviceAt(createdAt)
    assert(service.getById("banana").swap.exists(_.isInstanceOf[AppError.BadRequest]))
  }

  test("fetching a route by an unused but well-formed id is a not-found") {
    val (service, _, _) = serviceAt(createdAt)
    assert(service.getById("66c9f0b2e1a4c3d2b1a09876").swap.exists(_.isInstanceOf[AppError.NotFound]))
  }

  test("fetching a route by a slug that breaks the slug pattern is a not-found, never a bad request") {
    val (service, _, _) = serviceAt(createdAt)
    assert(service.getBySlug("Main Camera").swap.exists(_.isInstanceOf[AppError.NotFound]))
  }

  test("a disabled route is still returned by slug, so the OBS source does not show an error") {
    val (service, _, _) = serviceAt(createdAt)
    val _ = service.create(Fixtures.rawRoute(enabled = false))
    assertEquals(service.getBySlug("main-camera").map(_.enabled), Right(false))
  }

  test("updating a route replaces its parameters completely and refreshes updatedAt") {
    val (_, routes, _, route) = createdRoute()
    val effects = new InMemoryEffectRepository(List(Fixtures.plasmaField))
    val later = new RouteService(routes, effects, NoRouteEvents, Clock.fixed(laterOn, ZoneOffset.UTC))

    val updated = later
      .update(route.id.value, Fixtures.rawRoute(params = Map("tint" -> JsonString("#00ff00"))))
      .getOrElse(fail("the update should be accepted"))

    assertEquals(updated.params, Map(ParamKey.unsafe("tint") -> JsonString("#00ff00")))
    assertEquals(updated.createdAt, createdAt)
    assertEquals(updated.updatedAt, laterOn)
  }

  test("updating a route to keep its own slug is not a conflict") {
    val (service, _, _, route) = createdRoute()
    assert(service.update(route.id.value, Fixtures.rawRoute(enabled = false)).isRight)
  }

  test("updating a route to a slug another route owns is a conflict") {
    val (service, _, _, route) = createdRoute()
    val _ = service.create(Fixtures.rawRoute(slug = "second-camera"))
    assertEquals(
      service.update(route.id.value, Fixtures.rawRoute(slug = "second-camera")),
      Left(AppError.SlugConflict("second-camera"))
    )
  }

  test("updating a route that does not exist is a not-found") {
    val (service, _, _) = serviceAt(createdAt)
    assert(
      service.update("66c9f0b2e1a4c3d2b1a09876", Fixtures.rawRoute()).swap.exists(_.isInstanceOf[AppError.NotFound])
    )
  }

  test("deleting a route removes it") {
    val (service, _, _, route) = createdRoute()
    assertEquals(service.delete(route.id.value), Right(()))
    assertEquals(service.list(), Nil)
  }

  test("deleting the same route twice is a not-found the second time") {
    val (service, _, _, route) = createdRoute()
    val _ = service.delete(route.id.value)
    assert(service.delete(route.id.value).swap.exists(_.isInstanceOf[AppError.NotFound]))
  }

  // -------------------------------------------------------------------------------------------
  // Announcing writes to the event stream
  //
  // These are what make `GET /api/routes/by-slug/{slug}/events` work. The rule the tests pin down
  // is "every successful write announces itself, and nothing else does" — an announcement for a
  // write that was rejected would tell a live OBS source to draw something the database does not
  // contain.
  // -------------------------------------------------------------------------------------------

  test("creating a route announces its configuration") {
    val (_, _, events, route) = createdRoute()
    assertEquals(events.summary, List("config main-camera"))
    assertEquals(events.published, List(RouteEvent.Configured(route)))
  }

  test("a rejected create announces nothing") {
    val (service, _, events) = serviceAt(createdAt)
    val _ = service.create(Fixtures.rawRoute(effectId = "ghost-effect"))
    assertEquals(events.summary, Nil)
  }

  test("a create rejected for a taken slug announces nothing beyond the first one") {
    val (service, _, events, _) = createdRoute()
    val _ = service.create(Fixtures.rawRoute())
    assertEquals(events.summary, List("config main-camera"))
  }

  test("updating a route announces the new configuration") {
    val (service, _, events, route) = createdRoute()
    val _ = service.update(route.id.value, Fixtures.rawRoute(enabled = false))
    assertEquals(events.summary, List("config main-camera", "config main-camera"))
  }

  test("renaming a route announces the old slug as absent before the new one as configured") {
    val (service, _, events, route) = createdRoute()
    val _ = service.update(route.id.value, Fixtures.rawRoute(slug = "second-camera"))
    assertEquals(events.summary, List("config main-camera", "absent main-camera", "config second-camera"))
  }

  test("deleting a route announces that its slug is absent") {
    val (service, _, events, route) = createdRoute()
    val _ = service.delete(route.id.value)
    assertEquals(events.summary, List("config main-camera", "absent main-camera"))
  }

  test("deleting a route that does not exist announces nothing") {
    val (service, _, events) = serviceAt(createdAt)
    val _ = service.delete("66c9f0b2e1a4c3d2b1a09876")
    assertEquals(events.summary, Nil)
  }

  test("findBySlug reports a missing slug as None rather than as an error") {
    val (service, _, _) = serviceAt(createdAt)
    assertEquals(service.findBySlug("nothing-here"), None)
    assertEquals(service.findBySlug("Not A Slug"), None)
  }

  test("routes are listed in slug order") {
    val (service, _, _) = serviceAt(createdAt)
    val _ = service.create(Fixtures.rawRoute(slug = "zoom-cam"))
    val _ = service.create(Fixtures.rawRoute(slug = "alpha-cam"))
    assertEquals(service.list().map(_.slug.value), List("alpha-cam", "zoom-cam"))
  }
}
