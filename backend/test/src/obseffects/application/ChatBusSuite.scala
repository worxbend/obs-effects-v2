package obseffects.application

import munit.FunSuite
import obseffects.Fixtures
import obseffects.domain.{TwitchConnectionState, TwitchConnectionStatus}

import scala.concurrent.duration.DurationInt

/** Tests for the fan-out that carries Twitch chat to every overlay.
  *
  * The property that matters most is the one that makes this bus different from the audio bus: it **queues**. A chat
  * message is discrete — nothing supersedes it — so a live subscriber must receive every one, in order, and only a
  * genuinely stalled subscriber loses any, oldest first. The second property is the snapshot ring: the last fifty
  * messages are what a freshly opened overlay is shown, so the ring has to cap, keep order, and be seedable from the
  * stored history exactly once.
  */
class ChatBusSuite extends FunSuite {

  private def message(id: Int) = Fixtures.chatMessage(id = s"m$id", at = 1000L + id)

  test("a subscriber receives every published message, in order") {
    val bus = new ChatBus
    val subscription = bus.subscribe()
    try {
      bus.publish(message(1))
      bus.publish(message(2))
      bus.publish(message(3))

      assertEquals(subscription.next(1.second).map(_.id), Some("m1"))
      assertEquals(subscription.next(1.second).map(_.id), Some("m2"))
      assertEquals(subscription.next(1.second).map(_.id), Some("m3"))
    } finally subscription.close()
  }

  test("a full queue drops its oldest message, not the newest, and counts the drop") {
    val bus = new ChatBus(queueCapacity = 2)
    val stalled = bus.subscribe()
    try {
      bus.publish(message(1))
      bus.publish(message(2))
      bus.publish(message(3))

      // m1 is gone; the survivor set is the two newest, still in order.
      assertEquals(stalled.next(1.second).map(_.id), Some("m2"))
      assertEquals(stalled.next(1.second).map(_.id), Some("m3"))
      assertEquals(stalled.dropped, 1L)
    } finally stalled.close()
  }

  test("waiting with nothing to read times out rather than blocking forever") {
    val bus = new ChatBus
    val subscription = bus.subscribe()
    try assertEquals(subscription.next(50.millis), None)
    finally subscription.close()
  }

  test("a closed subscriber is forgotten, so a reconnecting overlay cannot leak one per reconnection") {
    val bus = new ChatBus
    val first = bus.subscribe()
    val second = bus.subscribe()
    assertEquals(bus.subscriberCount, 2)

    first.close()
    first.close()
    assertEquals(bus.subscriberCount, 1)
    assert(first.isClosed)

    second.close()
    assertEquals(bus.subscriberCount, 0)
  }

  test("a message offered to an already-closed subscription is refused, not queued for nobody") {
    val bus = new ChatBus
    val subscription = bus.subscribe()
    subscription.close()

    // A publisher that snapshotted the registry just before the close would still call offer() on this subscription;
    // nothing may land in the queue, because nothing will ever drain it.
    bus.publish(message(1))
    subscription.offer(message(2))

    assertEquals(subscription.queued, 0)
    assertEquals(subscription.dropped, 0L)
  }

  test("the recent ring keeps the last fifty messages, oldest first") {
    val bus = new ChatBus
    (1 to 60).foreach(i => bus.publish(message(i)))

    val recent = bus.recent
    assertEquals(recent.size, ChatBus.RecentCapacity)
    assertEquals(recent.head.id, "m11")
    assertEquals(recent.last.id, "m60")
  }

  test("preload fills an empty ring but refuses to overwrite live messages") {
    val bus = new ChatBus
    bus.preload(List(message(1), message(2)))
    assertEquals(bus.recent.map(_.id), List("m1", "m2"))

    bus.publish(message(3))
    // A second preload — a start-up race, or a repeated call — must not throw away what arrived live.
    bus.preload(List(message(99)))
    assertEquals(bus.recent.map(_.id), List("m1", "m2", "m3"))
  }

  test("status starts Disabled and follows what the supervisor writes") {
    val bus = new ChatBus
    assertEquals(bus.currentStatus, TwitchConnectionStatus.Disabled)

    bus.modifyStatus(_.copy(state = TwitchConnectionState.ConnectedAnonymous, channel = Some("worxbend")))

    assertEquals(bus.currentStatus.state, TwitchConnectionState.ConnectedAnonymous)
    assertEquals(bus.currentStatus.channel, Some("worxbend"))
  }
}
