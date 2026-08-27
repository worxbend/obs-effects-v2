package obseffects.application

import obseffects.domain.{ChatMessage, TwitchConnectionStatus, TwitchSettings}

import java.util.concurrent.atomic.{AtomicBoolean, AtomicLong, AtomicReference}
import java.util.concurrent.{ArrayBlockingQueue, ConcurrentHashMap, TimeUnit}

import scala.concurrent.duration.FiniteDuration
import scala.jdk.CollectionConverters.*

/** One connected chat consumer: the queue of messages waiting to be written down an open WebSocket.
  *
  * ==Why this queues, where the audio bus keeps only the newest value==
  *
  * Chat is the opposite kind of data from audio levels. A level from 300ms ago is worthless because the next one
  * replaces it; a chat message is *discrete* — nothing replaces it, and an overlay that missed one has shown its viewer
  * a conversation with a hole in it. So each subscriber gets a real queue, like the route event bus, and the newest-
  * wins trick of `AudioLevelSubscription` would be wrong here.
  *
  * The queue is still bounded, and overflow still drops the *oldest* entry: a subscriber that has stalled for long
  * enough to have 256 messages waiting has already lost the conversation, and when it recovers the recent messages are
  * worth more than the ancient ones. Dropping means one slow OBS source can never block the publisher or grow without
  * limit — the same guarantee every other bus in this process makes.
  */
final class ChatSubscription private[application] (capacity: Int, onClose: ChatSubscription => Unit) {

  private val queue = new ArrayBlockingQueue[ChatMessage](capacity)
  private val closed = new AtomicBoolean(false)
  private val droppedCount = new AtomicLong(0)

  /** Waits for the next message, giving up after `timeout` — which is exactly when the caller should consider a
    * heartbeat. Called from the thread writing the WebSocket, and from nowhere else. Blocking is fine there: it is a
    * virtual thread, and a parked one costs nothing.
    */
  def next(timeout: FiniteDuration): Option[ChatMessage] =
    Option(queue.poll(timeout.toMillis, TimeUnit.MILLISECONDS))

  /** Deregisters this subscriber. Idempotent, and called from a `finally`, for the same leak-prevention reason as every
    * other subscription in this codebase.
    */
  def close(): Unit = if (closed.compareAndSet(false, true)) onClose(this)

  def isClosed: Boolean = closed.get()

  /** How many messages this subscriber lost to overflow. Test-facing, and the number a diagnostics screen would show as
    * "this overlay is not keeping up".
    */
  def dropped: Long = droppedCount.get()

  /** How many messages are waiting to be sent. Test-facing. */
  def queued: Int = queue.size

  /** Adds a message, discarding the oldest queued one when the queue is already full.
    *
    * The `synchronized` block covers the "make room, then insert" pair — the same reasoning as
    * `RouteSubscription.offer`: the queue is thread-safe but the pair is two operations, and two publishers running it
    * at once could both free one slot and both try to fill it. There is only one publisher here (the IRC connection),
    * but that is a wiring fact, not a promise this class should depend on.
    */
  private[application] def offer(message: ChatMessage): Unit = synchronized {
    // A publisher iterating the registry can still hold this subscription after a concurrent close() removed it —
    // ConcurrentHashMap iteration is weakly consistent. Refusing the offer then keeps a message from landing in a
    // queue nobody will ever drain, and keeps the queued/dropped counters deterministic for anything reading them.
    if (!closed.get() && !queue.offer(message)) {
      val _ = queue.poll()
      val _ = droppedCount.incrementAndGet()
      val _ = queue.offer(message)
    }
  }
}

object ChatBus {

  /** Messages one subscriber may have waiting. Far larger than the route bus's eight, because chat events do not
    * supersede one another — every drop is a visible hole — and 256 short messages cost close to nothing.
    */
  val SubscriberQueueCapacity = 256

  /** How many recent messages are kept for the snapshot a new connection receives, from the design contract: enough to
    * fill any overlay's visible area, small enough to send in one frame.
    */
  val RecentCapacity = 50
}

/** The in-process fan-out carrying chat messages from the one Twitch connection to every overlay watching, plus the
  * ring of recent messages that makes a freshly opened overlay show a conversation instead of a void.
  *
  * The shape is `AudioLevelBus` with the subscription policy of `RouteEventBus`: a concurrent registry of subscribers,
  * a status the supervisor writes and the admin reads, and per-subscriber bounded queues (see [[ChatSubscription]] for
  * why queues). In-process only, single node, no broker — the same standing decision as the other two buses.
  */
final class ChatBus(queueCapacity: Int = ChatBus.SubscriberQueueCapacity) {

  private val subscribers = new ConcurrentHashMap[Long, ChatSubscription]()
  private val nextId = new AtomicLong(0)

  /** The last [[ChatBus.RecentCapacity]] messages, oldest first. An immutable `Vector` behind an `AtomicReference`,
    * because it is appended a few times a second at most and read whole on every new connection.
    */
  private val recentRing = new AtomicReference[Vector[ChatMessage]](Vector.empty)

  /** The live connection state, written by the supervisor and read by the admin API and the stream's status frames. */
  private val status = new AtomicReference[TwitchConnectionStatus](TwitchConnectionStatus.Disabled)

  /** Opens a subscription. The caller must `close()` it in a `finally`, exactly as with the other buses. */
  def subscribe(): ChatSubscription = {
    val id = nextId.incrementAndGet()
    // Removal is by the key this subscription was registered under — a direct map remove, where scanning values()
    // for an identity match would take the map's segment locks for every entry on every WebSocket disconnect.
    val subscription = new ChatSubscription(queueCapacity, _ => { val _ = subscribers.remove(id) })
    val _ = subscribers.put(id, subscription)
    subscription
  }

  /** Publishes one message: into the recent ring, then to everyone currently listening. */
  def publish(message: ChatMessage): Unit = {
    val _ = recentRing.updateAndGet(ring => (ring :+ message).takeRight(ChatBus.RecentCapacity))
    subscribers.values().asScala.foreach(_.offer(message))
  }

  /** The recent messages, oldest first — the snapshot a new WebSocket connection is sent before anything live. */
  def recent: List[ChatMessage] = recentRing.get().toList

  /** Fills the recent ring from stored history, once, at start-up.
    *
    * Without this the ring starts empty on every boot and an overlay opened just after a restart shows nothing until
    * somebody chats. It refuses to overwrite a ring that already has content, so a late or repeated call cannot throw
    * away messages that arrived live in the meantime.
    */
  def preload(messages: List[ChatMessage]): Unit = {
    val _ = recentRing.updateAndGet { ring =>
      if (ring.nonEmpty) ring else messages.takeRight(ChatBus.RecentCapacity).toVector
    }
  }

  /** Replaces the reported connection status. */
  def updateStatus(next: TwitchConnectionStatus): Unit = status.set(next)

  /** Transforms the current status in place, for the many places that change one field of it. */
  def modifyStatus(f: TwitchConnectionStatus => TwitchConnectionStatus): Unit = {
    val _ = status.updateAndGet(current => f(current))
  }

  def currentStatus: TwitchConnectionStatus = status.get()

  /** How many overlays are currently reading chat. Shown in the admin panel. */
  def subscriberCount: Int = subscribers.size
}

/** What the settings layer needs from the Twitch connection, without knowing that IRC or a WebSocket is involved. The
  * same seam, for the same testability reason, as `ObsAudioConnection`.
  */
trait TwitchChatConnection {

  /** Applies new settings: disconnect if the connection is no longer wanted, otherwise reconnect with the new ones.
    * Called on every successful settings save; implementations are expected to be cheap and idempotent rather than
    * clever about diffing, because pressing Save is the operator's "try again now" button.
    */
  def reconfigure(settings: TwitchSettings): Unit
}

/** The do-nothing connection, for tests and for a server with chat switched off entirely. */
object NoOpTwitchChatConnection extends TwitchChatConnection {
  override def reconfigure(settings: TwitchSettings): Unit = ()
}
