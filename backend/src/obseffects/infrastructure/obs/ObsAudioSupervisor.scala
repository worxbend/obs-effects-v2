package obseffects.infrastructure.obs

import obseffects.application.{AudioLevelBus, ObsAudioConnection}
import obseffects.domain.{AudioLevels, ObsAudioSettings, ObsConnectionState, ObsConnectionStatus}
import org.slf4j.{Logger, LoggerFactory}

import java.time.Clock
import java.util.concurrent.atomic.{AtomicLong, AtomicReference}
import java.util.concurrent.{Executors, ScheduledExecutorService, TimeUnit}

import scala.concurrent.duration.{DurationInt, DurationLong, FiniteDuration}

/** Keeps exactly one OBS WebSocket connection alive, for as long as the settings say there should be one.
  *
  * ==Why the retry policy lives here and not in the client==
  *
  * [[ObsWebSocketClient]] opens one connection and tells us when it ended. This class is the only thing that decides
  * whether to open another. Keeping those two jobs apart means the protocol code has no timers in it and this file has
  * no JSON in it, and each can be read on its own.
  *
  * ==What it is actually defending against==
  *
  * The normal state of this connection is *broken*, and that is not a bug. OBS is a desktop application: it is closed
  * overnight, restarted when a plugin is installed, and started after this server on almost every boot. So a failure to
  * connect is not an incident to be logged loudly — it is the expected condition, and the only correct response is to
  * keep trying quietly and be ready the moment OBS appears.
  *
  * That shapes the backoff: it starts fast, because the common case is OBS starting up seconds later, and it tops out
  * low, because a stream operator who launches OBS should not wait several minutes for their overlays to come alive.
  * The log is at `info` for the first failure of a run and `debug` for the repeats, so a machine with OBS closed for a
  * week does not produce a week of identical warnings.
  *
  * ==Threading==
  *
  * One single-threaded scheduler owns every state transition. Connect attempts, the callbacks the client makes when a
  * connection ends, and settings changes arriving from an HTTP request all funnel onto it, so the "current client"
  * field is only ever touched by one thread and there is no lock anywhere in this file.
  */
final class ObsAudioSupervisor(bus: AudioLevelBus, clock: Clock) extends ObsAudioConnection {

  import ObsAudioSupervisor.*

  private val log: Logger = LoggerFactory.getLogger(classOf[ObsAudioSupervisor])

  /** The single thread every state change runs on. A daemon thread, so it can never hold the JVM open at shutdown. */
  private val scheduler: ScheduledExecutorService =
    Executors.newSingleThreadScheduledExecutor { runnable =>
      val thread = new Thread(runnable, "obs-audio-supervisor")
      thread.setDaemon(true)
      thread
    }

  /** The settings currently in force. `None` before the first `reconfigure`. */
  private val current = new AtomicReference[Option[ObsAudioSettings]](None)

  /** The live client, if a connection is open or being opened. */
  private val client = new AtomicReference[Option[ObsWebSocketClient]](None)

  /** How many consecutive attempts have failed, which is what [[backoffFor]] turns into a delay. */
  private val failures = new AtomicLong(0)

  /** Bumped every time the settings change, so a callback from a connection we have already abandoned can be recognised
    * and ignored.
    *
    * Without this there is a real race with a visible symptom: save new settings while the old connection is in the
    * middle of failing, and the old connection's "I have ended, please retry" callback schedules a reconnect using the
    * *new* settings a moment before the new connection's own attempt, giving two live sockets to the same OBS and two
    * copies of every level.
    */
  private val generation = new AtomicLong(0)

  /** Called once at start-up with whatever was loaded from the database, and again on every settings save. */
  override def reconfigure(settings: ObsAudioSettings): Unit = {
    val _ = generation.incrementAndGet()
    current.set(Some(settings))
    failures.set(0)
    submit(() => restart(settings))
  }

  /** Stops everything, permanently. Called from the server's shutdown hook. */
  def shutdown(): Unit = {
    val _ = generation.incrementAndGet()
    submit(() => disconnect())
    scheduler.shutdownNow()
    val _ = ()
  }

  // -------------------------------------------------------------------------------------------

  /** Drops any existing connection and starts a new one if the settings ask for it. Runs on the scheduler thread. */
  private def restart(settings: ObsAudioSettings): Unit = {
    disconnect()
    if (!settings.enabled) {
      log.info("OBS audio is switched off in the settings; not connecting")
      bus.updateStatus(ObsConnectionStatus.Disabled)
      bus.publish(AudioLevels.silent(clock.millis()))
    } else {
      attempt(settings, generation.get())
    }
  }

  /** One connection attempt. */
  private def attempt(settings: ObsAudioSettings, era: Long): Unit = if (era == generation.get()) {
    bus.modifyStatus(_.copy(state = ObsConnectionState.Connecting))

    val fresh = new ObsWebSocketClient(
      settings = settings,
      clock = clock,
      onLevels = levels => {
        bus.publish(levels)
        countLevels()
      },
      onInputsSeen = names => recordInputs(names),
      onConnected = version => submit(() => connected(era, version)),
      onClosed = reason => submit(() => ended(settings, era, reason))
    )
    client.set(Some(fresh))
    fresh.connect()
  }

  /** The handshake succeeded. */
  private def connected(era: Long, obsVersion: Option[String]): Unit = if (era == generation.get()) {
    failures.set(0)
    log.info("Connected to obs-websocket{}", obsVersion.fold("")(v => s" (OBS $v)"))
    bus.updateStatus(
      ObsConnectionStatus(
        state = ObsConnectionState.Connected,
        lastError = None,
        connectedSince = Some(clock.millis()),
        obsVersion = obsVersion,
        inputs = bus.currentStatus.inputs,
        levelsReceived = bus.currentStatus.levelsReceived
      )
    )
  }

  /** A connection ended, for any reason. Schedules the next attempt unless we asked for the close. */
  private def ended(settings: ObsAudioSettings, era: Long, reason: Option[String]): Unit = if (
    era == generation.get()
  ) {
    client.set(None)

    reason match {
      case None =>
        // We closed it ourselves; `restart` has already set whatever status is correct.
        ()

      case Some(message) =>
        val consecutive = failures.incrementAndGet()
        if (consecutive == 1) log.info("obs-websocket connection lost or refused: {}", message)
        else log.debug("obs-websocket still unavailable after {} attempts: {}", consecutive, message)

        bus.modifyStatus(
          _.copy(state = ObsConnectionState.Failed, lastError = Some(message), connectedSince = None)
        )
        // Levels stop arriving the instant the socket dies. Publishing one explicit silence means every browser source
        // is told so immediately, rather than holding the last level it saw — a frozen meter on a dead connection is
        // the single most confusing thing this feature could do.
        bus.publish(AudioLevels.silent(clock.millis()))

        val delay = backoffFor(consecutive)
        log.debug("Retrying obs-websocket in {}", delay)
        val _ = scheduler.schedule(
          (() => attempt(settings, era)): Runnable,
          delay.toMillis,
          TimeUnit.MILLISECONDS
        )
    }
  }

  /** Counts one delivered measurement. Runs about twenty times a second, so it is one increment and nothing else. */
  private def countLevels(): Unit =
    bus.modifyStatus(status => status.copy(levelsReceived = status.levelsReceived + 1))

  /** Remembers which audio inputs OBS has mentioned, for the settings form's dropdown.
    *
    * Called as often as the levels are, so the list is rebuilt **only when a name arrives that is not already in it** —
    * which after the first second or two is never. Sorting a list of strings twenty times a second for the benefit of a
    * form nobody has open would be a silly way to spend a core.
    */
  private def recordInputs(names: List[String]): Unit =
    bus.modifyStatus { status =>
      val fresh = names.filterNot(status.inputs.contains)
      if (fresh.isEmpty) status else status.copy(inputs = (status.inputs ++ fresh).distinct.sorted)
    }

  /** Closes the live connection, if any, without scheduling a replacement. */
  private def disconnect(): Unit = client.getAndSet(None).foreach(_.close())

  /** Runs `work` on the scheduler thread, swallowing the rejection that arrives if we are shutting down. */
  private def submit(work: () => Unit): Unit =
    try {
      val _ = scheduler.execute(() =>
        try work()
        catch {
          case scala.util.control.NonFatal(e) => log.warn("OBS audio supervisor task failed", e)
        }
      )
    } catch {
      case _: java.util.concurrent.RejectedExecutionException => ()
    }
}

object ObsAudioSupervisor {

  /** The first retry delay, and the step the backoff doubles from. */
  val InitialBackoff: FiniteDuration = 1.second

  /** The longest this will ever wait between attempts.
    *
    * Fifteen seconds rather than the minutes a typical exponential backoff climbs to. The thing on the other end is a
    * desktop application an operator has just launched, and they are watching an overlay, waiting for it to come alive.
    * A backoff that has crept up to five minutes turns "it works" into "it works eventually", which reads as broken.
    */
  val MaxBackoff: FiniteDuration = 15.seconds

  /** Doubling backoff, capped: 1s, 2s, 4s, 8s, 15s, 15s, ...
    *
    * `consecutive` is 1 for the first failure. The shift is bounded before it is applied because shifting a `Long` by
    * 64 or more is not an error in Java — it silently wraps the shift distance, so a connection that had failed 64
    * times would suddenly retry after one second again.
    */
  def backoffFor(consecutive: Long): FiniteDuration = {
    val steps = Math.min(Math.max(consecutive - 1, 0), 32L).toInt
    val millis = InitialBackoff.toMillis << steps
    if (millis <= 0 || millis > MaxBackoff.toMillis) MaxBackoff else millis.millis
  }
}
