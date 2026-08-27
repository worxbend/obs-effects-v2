package obseffects.application

import obseffects.domain.{AudioLevels, ObsAudioSettings, ObsConnectionStatus}

import java.util.concurrent.atomic.{AtomicBoolean, AtomicLong, AtomicReference}
import java.util.concurrent.{ConcurrentHashMap, SynchronousQueue, TimeUnit}

import scala.concurrent.duration.FiniteDuration
import scala.jdk.CollectionConverters.*

/** The in-process fan-out that carries audio levels from the one OBS connection to every browser source watching.
  *
  * ==How this differs from `RouteEventBus`, and why==
  *
  * The route bus queues events, because every route change matters: miss one and an OBS source keeps drawing last
  * week's configuration until something else happens.
  *
  * Audio levels are the exact opposite kind of data. They arrive about twenty times a second, each one completely
  * replaces the last, and one from 300 milliseconds ago is worse than useless — an overlay that pulses to a backlog is
  * visibly *behind the music*, which looks worse than one that misses a beat. So this bus keeps **only the newest
  * value** for each subscriber: a slow consumer loses the intervening frames and is always shown the present.
  *
  * That single decision is what makes the whole path safe under load. There is no queue to grow, so a browser source
  * whose connection stalls costs one reference and nothing else, and no amount of stalling can consume memory.
  */
final class AudioLevelSubscription private[application] (onClose: AudioLevelSubscription => Unit) {

  /** The latest measurement, or `null` when nothing has arrived since the last read.
    *
    * An `AtomicReference` and not a queue: [[offer]] overwrites unconditionally, so the writer never blocks and never
    * has to decide what to discard. The reader takes the value and leaves `null` behind.
    */
  private val latest = new AtomicReference[AudioLevels | Null](null)

  /** Parks the reading thread when there is nothing to read.
    *
    * A `SynchronousQueue` is used purely as a signal — the value passed through it is ignored, and the real payload is
    * always taken from [[latest]]. Its useful property is that `offer` on it returns immediately when nobody is
    * waiting, so a publisher is never delayed by a subscriber that happens not to be parked at that instant.
    */
  private val wakeup = new SynchronousQueue[AnyRef]()

  private val closed = new AtomicBoolean(false)
  private val skipped = new AtomicLong(0)

  /** Waits up to `timeout` for the next measurement.
    *
    * Returns the newest value available, which may be one that arrived *while* this call was waiting or one that was
    * already sitting there when it started. `None` means the timeout ran out with nothing new — the caller sends a
    * heartbeat and comes back.
    */
  def next(timeout: FiniteDuration): Option[AudioLevels] = {
    val immediate = latest.getAndSet(null)
    if (immediate != null) Some(immediate)
    else {
      val _ = wakeup.poll(timeout.toMillis, TimeUnit.MILLISECONDS)
      Option(latest.getAndSet(null))
    }
  }

  /** Ends the subscription and removes it from the bus. Idempotent, and called from a `finally`. */
  def close(): Unit = if (closed.compareAndSet(false, true)) onClose(this)

  def isClosed: Boolean = closed.get()

  /** How many measurements were overwritten before this subscriber read them.
    *
    * Not a fault: at twenty updates a second and sixty frames a second of drawing, some overwriting is the system
    * working as designed. It is exposed because a *huge* number here, next to a low delivered count, is the signature
    * of a browser source that has stopped reading its stream.
    */
  def skippedCount: Long = skipped.get()

  private[application] def offer(levels: AudioLevels): Unit =
    if (!closed.get()) {
      if (latest.getAndSet(levels) != null) {
        // There was an unread value, and it has just been replaced. That is the newest-wins policy doing its job.
        val _ = skipped.incrementAndGet()
      }
      // Wake a parked reader if there is one. `offer` without a timeout returns false immediately when there is not,
      // which is exactly what we want: publishing must never block on a subscriber.
      val _ = wakeup.offer(AudioLevelBus.Signal)
    }
}

object AudioLevelBus {

  /** The token pushed through the wake-up queue. Its value is never read; only its arrival matters. */
  private[application] val Signal: AnyRef = new AnyRef

  /** What a page is told when no OBS connection is configured or the connection is down.
    *
    * Deliberately still a valid measurement of silence rather than an error: the frontend's audio bus treats a stream
    * of silence and a missing stream identically, falling back to its simulated signal, so there is one code path in
    * the browser instead of two.
    */
  def offline(at: Long): AudioLevels = AudioLevels.silent(at)
}

/** The publish side: where the OBS connection puts levels, and where the admin reads connection status.
  *
  * Split from the subscription above so that the HTTP layer can be handed the read half and the OBS supervisor the
  * write half, and neither can do the other's job by accident.
  */
final class AudioLevelBus {

  private val subscribers = new ConcurrentHashMap[Long, AudioLevelSubscription]()
  private val nextId = new AtomicLong(0)

  /** The most recent measurement from OBS, whatever happened to it afterwards.
    *
    * Kept so a browser source that connects mid-stream is shown the current level immediately rather than sitting at
    * silence until the next meter message. At twenty messages a second that wait is only 50 milliseconds, but the same
    * value is also what the admin's connection panel displays, where it is the difference between a meter that reads
    * correctly on page load and one that appears dead.
    */
  private val lastLevels = new AtomicReference[Option[AudioLevels]](None)

  /** The live connection state, written by the supervisor and read by the admin API. */
  private val status = new AtomicReference[ObsConnectionStatus](ObsConnectionStatus.Disabled)

  /** Opens a subscription. The caller must `close()` it in a `finally`, exactly as with the route bus. */
  def subscribe(): AudioLevelSubscription = {
    val id = nextId.incrementAndGet()
    val subscription = new AudioLevelSubscription(remove)
    val _ = subscribers.put(id, subscription)
    subscription
  }

  /** Publishes one measurement to everyone currently listening. Called about twenty times a second. */
  def publish(levels: AudioLevels): Unit = {
    lastLevels.set(Some(levels))
    subscribers.values().asScala.foreach(_.offer(levels))
  }

  /** The newest measurement, if any has ever arrived. */
  def latest: Option[AudioLevels] = lastLevels.get()

  /** Replaces the reported connection status. */
  def updateStatus(next: ObsConnectionStatus): Unit = status.set(next)

  /** Transforms the current status in place, for the many places that change one field of it. */
  def modifyStatus(f: ObsConnectionStatus => ObsConnectionStatus): Unit = {
    val _ = status.updateAndGet(current => f(current))
  }

  def currentStatus: ObsConnectionStatus = status.get()

  /** How many browser sources are currently reading levels. Shown in the admin panel, and the number that answers "is
    * anything actually using this?" before an operator goes looking for a bug in an overlay that nobody has open.
    */
  def subscriberCount: Int = subscribers.size

  private def remove(subscription: AudioLevelSubscription): Unit = {
    val _ = subscribers.values().removeIf(_ eq subscription)
  }
}

/** What the settings layer needs from the OBS connection, without knowing that a WebSocket is involved.
  *
  * `SettingsService` depends on this trait rather than on the supervisor, for the same reason `RouteService` depends on
  * `RouteEventPublisher` rather than on the bus: a test can then save settings and assert that the connection was asked
  * to restart, with no network anywhere near it.
  */
trait ObsAudioConnection {

  /** Applies new settings: disconnect if the connection is no longer wanted, otherwise reconnect with the new ones.
    *
    * Called on every successful settings save, including saves that change nothing relevant. Implementations are
    * expected to be cheap and idempotent rather than clever about diffing — reconnecting a WebSocket costs
    * milliseconds, and an operator pressing Save is entitled to read it as "try again now".
    */
  def reconfigure(settings: ObsAudioSettings): Unit
}

/** The do-nothing connection, for tests and for a server that has audio switched off entirely. */
object NoOpObsAudioConnection extends ObsAudioConnection {
  override def reconfigure(settings: ObsAudioSettings): Unit = ()
}
