package obseffects.application

import munit.FunSuite
import obseffects.Fixtures
import obseffects.domain.{CanvasSettings, RouteConfig, RouteId, Slug}

import java.time.Instant

import scala.concurrent.duration.DurationInt

/** Tests for the in-process listener registry behind `GET /api/routes/by-slug/{slug}/events`.
  *
  * Four things have to hold, and each one is a way the event stream goes wrong if it does not:
  *
  *   1. a subscriber receives what is published for its own slug, and nothing else;
  *   2. a subscriber that closes is forgotten, or a browser source reconnecting every few hours leaks one dead queue
  *      per reconnection until the process runs out of memory;
  *   3. a full queue drops its *oldest* event rather than refusing the newest, so a client that stalls and recovers
  *      ends up holding the current state rather than a stale one;
  *   4. none of that blocks the thread doing the publishing.
  */
class RouteEventsSuite extends FunSuite {

  private val now = Instant.parse("2026-08-24T10:00:00.000Z")

  /** Waiting time for an event that is expected to be there already. Long enough that a loaded machine does not fail
    * the test, short enough that a genuine failure does not hold the suite up.
    */
  private val Soon = 2.seconds

  private def route(slug: String, updatedAt: String): RouteConfig =
    RouteConfig(
      id = RouteId.unsafe("66c9f0b2e1a4c3d2b1a09876"),
      slug = Slug.unsafe(slug),
      effectId = Fixtures.plasmaField.id,
      enabled = true,
      params = Map.empty,
      canvas = CanvasSettings.Default,
      createdAt = now,
      updatedAt = Instant.parse(updatedAt)
    )

  test("a new subscriber is registered and an unsubscribed one is forgotten") {
    val bus = new RouteEventBus()
    assertEquals(bus.subscriberCount, 0)

    val subscription = bus.subscribe(Slug.unsafe("main-camera"))
    assertEquals(bus.subscriberCount, 1)

    subscription.close()
    assertEquals(bus.subscriberCount, 0)
  }

  test("closing a subscription twice removes it once and does not fail") {
    val bus = new RouteEventBus()
    val subscription = bus.subscribe(Slug.unsafe("main-camera"))

    subscription.close()
    subscription.close()

    assertEquals(bus.subscriberCount, 0)
    assert(subscription.isClosed)
  }

  test("a published change reaches a subscriber of that slug") {
    val bus = new RouteEventBus()
    val subscription = bus.subscribe(Slug.unsafe("main-camera"))

    bus.routeChanged(route("main-camera", "2026-08-24T10:01:00.000Z"))

    assertEquals(subscription.next(Soon), Some(RouteEvent.Configured(route("main-camera", "2026-08-24T10:01:00.000Z"))))
  }

  test("a deletion reaches a subscriber as an absent event") {
    val bus = new RouteEventBus()
    val subscription = bus.subscribe(Slug.unsafe("main-camera"))

    bus.routeRemoved(Slug.unsafe("main-camera"))

    assertEquals(subscription.next(Soon), Some(RouteEvent.Absent(Slug.unsafe("main-camera"))))
  }

  test("a subscriber hears nothing about another slug") {
    val bus = new RouteEventBus()
    val subscription = bus.subscribe(Slug.unsafe("main-camera"))

    bus.routeChanged(route("second-camera", "2026-08-24T10:01:00.000Z"))

    assertEquals(subscription.queued, 0)
    assertEquals(subscription.next(50.millis), None)
  }

  test("two subscribers of the same slug each get their own copy") {
    val bus = new RouteEventBus()
    val first = bus.subscribe(Slug.unsafe("main-camera"))
    val second = bus.subscribe(Slug.unsafe("main-camera"))

    bus.routeChanged(route("main-camera", "2026-08-24T10:01:00.000Z"))

    assert(first.next(Soon).isDefined)
    assert(second.next(Soon).isDefined)
  }

  test("a closed subscriber receives nothing further") {
    val bus = new RouteEventBus()
    val subscription = bus.subscribe(Slug.unsafe("main-camera"))
    subscription.close()

    bus.routeChanged(route("main-camera", "2026-08-24T10:01:00.000Z"))

    assertEquals(subscription.queued, 0)
  }

  test("a full queue drops its oldest event and keeps the newest") {
    val capacity = 4
    val bus = new RouteEventBus(queueCapacity = capacity)
    val subscription = bus.subscribe(Slug.unsafe("main-camera"))

    // Six updates into a queue of four: the first two are gone and the last four remain, newest last.
    val stamps = (1 to 6).map(minute => f"2026-08-24T10:0$minute:00.000Z").toList
    stamps.foreach(stamp => bus.routeChanged(route("main-camera", stamp)))

    assertEquals(subscription.queued, capacity)
    assertEquals(subscription.dropped, 2L)

    val received = List.fill(capacity)(subscription.next(Soon)).flatten.collect { case RouteEvent.Configured(config) =>
      config.updatedAt
    }
    assertEquals(received, stamps.drop(2).map(Instant.parse))
  }

  test("publishing into a full queue never blocks the publisher") {
    val bus = new RouteEventBus(queueCapacity = 2)
    val _ = bus.subscribe(Slug.unsafe("main-camera"))

    // Nothing is reading this subscriber's queue, so every publish after the second one has to
    // make room for itself. If `offer` ever waited for space this loop would never finish, and the
    // admin's Save would hang behind an OBS source somebody left paused.
    val startedAt = System.nanoTime()
    (1 to 500).foreach(_ => bus.routeChanged(route("main-camera", "2026-08-24T10:01:00.000Z")))
    val elapsedMillis = (System.nanoTime() - startedAt) / 1000000

    assert(elapsedMillis < 1000, s"500 publishes into a full queue took ${elapsedMillis}ms")
  }

  test("waiting on a quiet subscription gives up after the timeout, which is what produces a heartbeat") {
    val bus = new RouteEventBus()
    val subscription = bus.subscribe(Slug.unsafe("main-camera"))

    assertEquals(subscription.next(100.millis), None)
  }

  test("the do-nothing publisher accepts both kinds of event") {
    NoRouteEvents.routeChanged(route("main-camera", "2026-08-24T10:01:00.000Z"))
    NoRouteEvents.routeRemoved(Slug.unsafe("main-camera"))
  }
}
