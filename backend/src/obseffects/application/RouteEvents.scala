package obseffects.application

import obseffects.domain.{RouteConfig, Slug}

import java.util.concurrent.atomic.{AtomicBoolean, AtomicLong}
import java.util.concurrent.{ArrayBlockingQueue, ConcurrentHashMap, TimeUnit}

import scala.concurrent.duration.FiniteDuration
import scala.jdk.CollectionConverters.*

/** Something that happened to one route, phrased the way a browser source cares about it.
  *
  * There are only two cases because there are only two things a renderer can do: draw this configuration, or draw
  * nothing. A delete and a rename-away-from-this-slug are the same event, and so are a create and an edit.
  */
enum RouteEvent {

  /** The route with this slug now looks like this. Sent on every successful write and on connect. */
  case Configured(route: RouteConfig)

  /** There is no longer a route with this slug — it was deleted, or renamed to something else. */
  case Absent(slug: Slug)
}

/** How a service announces that a route changed.
  *
  * This is a *port*, in the same sense as `RouteRepository`: the application defines it, and something outside decides
  * what "announce" means. `RouteService` depends on this trait and not on [[RouteEventBus]], which is what lets a test
  * hand it a recorder and assert on what it published without opening a socket.
  *
  * Every method returns `Unit` and none of them may block or throw. A route write must not become slower, or fail,
  * because somebody left an OBS browser source paused on a laptop that went to sleep.
  */
trait RouteEventPublisher {

  /** Announces the current state of a route: it was just created, or edited, or restored by an import. */
  def routeChanged(route: RouteConfig): Unit

  /** Announces that nothing answers to this slug any more. */
  def routeRemoved(slug: Slug): Unit
}

/** A publisher that does nothing.
  *
  * Useful in a test that is about routes rather than about events, and as the honest answer to "what should this do if
  * nobody is listening?" — which is: nothing at all.
  */
object NoRouteEvents extends RouteEventPublisher {
  override def routeChanged(route: RouteConfig): Unit = ()
  override def routeRemoved(slug: Slug): Unit = ()
}

/** One connected event stream: the queue of events waiting to be written down an open HTTP response.
  *
  * Created by [[RouteEventBus.subscribe]] and closed by whoever created it — see [[RouteEventBus]] for how the two
  * halves fit together and which of them is safe to call from which thread.
  *
  * @param id
  *   unique within one process, and only used as the registry key. Nothing outside this file reads it.
  * @param slug
  *   the slug this subscriber asked about. Every other slug's events are dropped before they reach the queue.
  * @param capacity
  *   how many events may wait here before the oldest one is discarded.
  */
final class RouteSubscription private[application] (
    private[application] val id: Long,
    val slug: Slug,
    capacity: Int,
    onClose: RouteSubscription => Unit
) {

  private val queue = new ArrayBlockingQueue[RouteEvent](capacity)
  private val closed = new AtomicBoolean(false)
  private val droppedCount = new AtomicLong(0)

  /** Waits for the next event, giving up after `timeout`.
    *
    * Called from the thread that is writing the HTTP response, and from nowhere else. It blocks, which on a Java 21
    * virtual thread costs nothing: the carrier thread is handed back for the whole wait.
    *
    * @return
    *   the next event, or `None` when `timeout` elapsed with nothing to send — which is exactly when the caller should
    *   write a heartbeat.
    */
  def next(timeout: FiniteDuration): Option[RouteEvent] =
    Option(queue.poll(timeout.toMillis, TimeUnit.MILLISECONDS))

  /** Deregisters this subscriber. Idempotent, so the `finally` block that calls it does not have to know whether the
    * stream ended because the client went away or because the server is shutting down.
    */
  def close(): Unit = if (closed.compareAndSet(false, true)) onClose(this)

  def isClosed: Boolean = closed.get()

  /** How many events this subscriber missed because it was not reading fast enough. Exposed for tests and for a future
    * diagnostics endpoint; nothing in the request path reads it.
    */
  def dropped: Long = droppedCount.get()

  /** How many events are waiting to be sent. Test-facing, for the same reason as [[dropped]]. */
  def queued: Int = queue.size

  /** Adds an event, discarding the oldest queued one when the queue is already full.
    *
    * Called from whichever thread is handling the admin's write, so it must never block and never throw. Dropping the
    * *oldest* is the right end to drop because every `Configured` event supersedes the one before it: a client that
    * stalls for a minute and then catches up still ends up holding the newest state, which is the only state that
    * matters. Dropping the newest instead would leave it holding something stale for as long as nothing else changed.
    *
    * The `synchronized` block covers the "make room, then insert" pair. `ArrayBlockingQueue` is thread-safe on its own,
    * but this pair is two operations, and two publishers running it at once could both free one slot and then both try
    * to fill it, so one of them would silently lose its event. Publishers are rare — one per admin save — so
    * serialising them costs nothing. The reader is deliberately *not* covered: it only ever removes, which can never
    * make an insert fail.
    */
  private[application] def offer(event: RouteEvent): Unit = synchronized {
    if (!queue.offer(event)) {
      val _ = queue.poll()
      val _ = droppedCount.incrementAndGet()
      val _ = queue.offer(event)
    }
  }
}

object RouteEventBus {

  /** Events one subscriber may have waiting, from `docs/CONTRACT.md` §4. Eight is generous for a stream whose events
    * supersede one another: it takes eight saves during one stalled connection before anything is lost, and what is
    * lost is intermediate states the client would have redrawn and thrown away anyway.
    */
  val DefaultQueueCapacity = 8
}

/** The in-process registry of open event streams, and the thing `RouteService` publishes into.
  *
  * ==What is shared, and how==
  *
  * Exactly one piece of state is shared between threads: `subscribers`, a `ConcurrentHashMap` from a subscription id to
  * the subscription itself. It is a concurrent map rather than a plain one because the threads touching it are
  * genuinely simultaneous — every HTTP request runs on its own Java 21 virtual thread, so an OBS source connecting, a
  * different one disconnecting, and the admin saving a route can all happen in the same microsecond. A `mutable.Map`
  * behind a `var` would corrupt on that; an immutable map behind an `AtomicReference` would work, but the map is
  * written on every connect and disconnect and read on every publish, which is what a `ConcurrentHashMap` is for.
  *
  * Each subscription owns a second piece of shared state, its bounded queue: written by the publishing thread, read by
  * the streaming thread. That handover is the queue's whole job, and the drop-oldest rule around it is explained on
  * [[RouteSubscription.offer]].
  *
  * ==Why publishing scans every subscriber==
  *
  * A map from slug to a set of subscribers would let a publish go straight to the right ones, at the cost of having to
  * remove the set when its last subscriber leaves — and doing that without a race is the kind of code that looks right
  * and is not. The number of subscribers here is the number of OBS browser sources pointed at this server, which is
  * single digits, and a publish happens when a person clicks Save. Scanning a list of five entries a few times an hour
  * is not worth a bug.
  *
  * ==What this deliberately is not==
  *
  * It is in-process only. Two backend instances would each notify their own subscribers and neither would know about
  * the other's, so this design assumes the single node the rest of the project assumes. A message broker would fix that
  * and would be a second thing to install, run and monitor for an admin tool that one person uses.
  */
class RouteEventBus(queueCapacity: Int = RouteEventBus.DefaultQueueCapacity) extends RouteEventPublisher {

  private val subscribers = new ConcurrentHashMap[Long, RouteSubscription]()
  private val nextId = new AtomicLong(0)

  /** Opens a stream for one slug. The caller must [[RouteSubscription.close]] it when the HTTP response ends, however
    * it ends — a browser source that reconnects every few hours would otherwise leave one dead queue behind per
    * reconnection, forever.
    */
  def subscribe(slug: Slug): RouteSubscription = {
    val subscription =
      new RouteSubscription(nextId.incrementAndGet(), slug, queueCapacity, s => { val _ = subscribers.remove(s.id) })
    val _ = subscribers.put(subscription.id, subscription)
    subscription
  }

  override def routeChanged(route: RouteConfig): Unit = deliver(route.slug, RouteEvent.Configured(route))

  override def routeRemoved(slug: Slug): Unit = deliver(slug, RouteEvent.Absent(slug))

  /** How many streams are open. Test-facing, and the number a future diagnostics screen would show as "browser sources
    * currently connected".
    */
  def subscriberCount: Int = subscribers.size

  private def deliver(slug: Slug, event: RouteEvent): Unit =
    subscribers.values.asScala.foreach(subscription => if (subscription.slug == slug) subscription.offer(event))
}
