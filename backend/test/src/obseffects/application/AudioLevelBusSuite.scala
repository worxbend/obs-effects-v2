package obseffects.application

import munit.FunSuite
import obseffects.domain.{AudioInputLevel, AudioLevels}

import scala.concurrent.duration.DurationInt

/** Tests for the fan-out that carries OBS audio levels to every browser source.
  *
  * The property that matters most here is the one that makes this bus *different* from the route event bus: it keeps
  * only the **newest** value per subscriber. That is not an optimisation, it is a correctness rule for this data. A
  * queue would make a stalled browser source replay a backlog of old levels when it recovered, so an overlay would
  * pulse to music that finished half a second ago — which looks worse than missing the beat entirely, and worse than
  * anything a queue was protecting against.
  */
class AudioLevelBusSuite extends FunSuite {

  private def levels(at: Long, peak: Double): AudioLevels =
    AudioLevels(at, List(AudioInputLevel("Desktop Audio", peak, List(peak))), peak)

  test("a subscriber receives what is published") {
    val bus = new AudioLevelBus
    val subscription = bus.subscribe()
    try {
      bus.publish(levels(1000L, 0.5))
      assertEquals(subscription.next(1.second).map(_.peak), Some(0.5))
    } finally subscription.close()
  }

  test("an unread measurement is replaced rather than queued") {
    val bus = new AudioLevelBus
    val subscription = bus.subscribe()
    try {
      bus.publish(levels(1000L, 0.1))
      bus.publish(levels(1050L, 0.2))
      bus.publish(levels(1100L, 0.9))

      // The newest, not the oldest — and then nothing, because the two it overtook are gone rather than waiting.
      assertEquals(subscription.next(1.second).map(_.peak), Some(0.9))
      assertEquals(subscription.next(50.millis), None)
      assertEquals(subscription.skippedCount, 2L)
    } finally subscription.close()
  }

  test("waiting with nothing to read times out rather than blocking forever") {
    val bus = new AudioLevelBus
    val subscription = bus.subscribe()
    try assertEquals(subscription.next(50.millis), None)
    finally subscription.close()
  }

  test("a closed subscriber is forgotten, so a reconnecting browser source cannot leak one per reconnection") {
    val bus = new AudioLevelBus
    val first = bus.subscribe()
    val second = bus.subscribe()
    assertEquals(bus.subscriberCount, 2)

    first.close()
    assertEquals(bus.subscriberCount, 1)
    assert(first.isClosed)

    second.close()
    assertEquals(bus.subscriberCount, 0)
  }

  test("closing twice is harmless") {
    val bus = new AudioLevelBus
    val subscription = bus.subscribe()
    subscription.close()
    subscription.close()
    assertEquals(bus.subscriberCount, 0)
  }

  test("publishing to a closed subscriber does nothing and does not throw") {
    val bus = new AudioLevelBus
    val subscription = bus.subscribe()
    subscription.close()
    bus.publish(levels(1000L, 0.5))
    assertEquals(subscription.next(50.millis), None)
  }

  test("every subscriber gets its own copy") {
    val bus = new AudioLevelBus
    val first = bus.subscribe()
    val second = bus.subscribe()
    try {
      bus.publish(levels(1000L, 0.4))
      assertEquals(first.next(1.second).map(_.peak), Some(0.4))
      assertEquals(second.next(1.second).map(_.peak), Some(0.4))
    } finally {
      first.close()
      second.close()
    }
  }

  test("the newest measurement is remembered, so a page connecting mid-stream is not left at silence") {
    val bus = new AudioLevelBus
    assertEquals(bus.latest, None)

    bus.publish(levels(1000L, 0.3))
    bus.publish(levels(1050L, 0.6))

    assertEquals(bus.latest.map(_.peak), Some(0.6))
  }

  test("publishing with nobody listening is not an error") {
    val bus = new AudioLevelBus
    bus.publish(levels(1000L, 0.5))
    assertEquals(bus.subscriberCount, 0)
    assertEquals(bus.latest.map(_.peak), Some(0.5))
  }

  test("publishing does not block on a subscriber that never reads") {
    // The real shape of this failure is a browser source whose TCP connection has stalled. If publishing waited for it,
    // one stuck overlay would freeze the levels for every other overlay on the machine.
    val bus = new AudioLevelBus
    val stalled = bus.subscribe()
    try {
      val start = System.nanoTime()
      for (i <- 1 to 1000) bus.publish(levels(i.toLong, 0.5))
      val elapsedMillis = (System.nanoTime() - start) / 1000000

      assert(elapsedMillis < 1000, s"1000 publishes to a subscriber that never reads took ${elapsedMillis}ms")
    } finally stalled.close()
  }
}
