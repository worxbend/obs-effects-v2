package obseffects

import com.softwaremill.macwire.wire
import obseffects.application.*
import obseffects.infrastructure.http.{AudioLevelStream, ChatStream, HttpApi, RouteEventStream}
import obseffects.infrastructure.mongo.{
  GridFsSoundRepository,
  MongoChatMessageRepository,
  MongoConnection,
  MongoEffectRepository,
  MongoPresetRepository,
  MongoRouteRepository,
  MongoSettingsRepository
}
import obseffects.infrastructure.obs.ObsAudioSupervisor
import obseffects.infrastructure.twitch.{TwitchChatSupervisor, TwitchHelixClient, TwitchOAuth}

import java.security.SecureRandom
import java.time.Clock

/** Builds the object graph: which concrete class plays which role, and in what order things are constructed.
  *
  * `wire[Foo]` is a macwire macro. At *compile time* it looks at `Foo`'s constructor parameters, finds a value of the
  * right type in this class, and expands into a plain `new Foo(a, b, c)`. If a dependency is missing or ambiguous the
  * build fails — there is no runtime reflection, no annotations, and no container to debug.
  *
  * Everything is a `lazy val` so nothing is created until it is first needed, which also means the MongoDB connection
  * is opened exactly once, when the first repository asks for it.
  */
class Wiring(config: AppConfig, val authMode: AuthMode) extends AutoCloseable {

  /** Constructed by hand rather than with `wire`, because both constructor parameters are `String`s and macwire would
    * have no way to tell which is which.
    */
  lazy val mongo: MongoConnection = new MongoConnection(config.mongoUri, config.mongoDatabase)

  /** Time is a dependency like any other: injecting the clock is what lets tests pin "now". */
  lazy val clock: Clock = Clock.systemUTC()

  /** One `SecureRandom` for the whole process, shared by every session token that is ever minted.
    *
    * It is created once rather than per token because seeding a `SecureRandom` is the expensive part and the instance
    * is safe to use from several threads at once. `SecureRandom` specifically, not `scala.util.Random`: an ordinary
    * random number generator's next output can be predicted from a handful of previous ones, which for a session token
    * means anyone who has seen a few can mint their own.
    */
  lazy val secureRandom: SecureRandom = new SecureRandom()

  /** Sessions live in a map inside this process, which is the whole implementation of the session store. See
    * `application/Sessions.scala` for why that is the right answer for a single-node admin tool, and what would have to
    * change to make it a different one.
    */
  lazy val sessionStore: SessionStore = new InMemorySessionStore

  lazy val sessionPolicy: SessionPolicy = SessionPolicy.default(config.sessionTtlHours)

  lazy val sessionService: SessionService = wire[SessionService]

  lazy val effectRepository: EffectRepository = wire[MongoEffectRepository]
  lazy val routeRepository: RouteRepository = wire[MongoRouteRepository]
  lazy val presetRepository: PresetRepository = wire[MongoPresetRepository]
  lazy val settingsRepository: SettingsRepository = wire[MongoSettingsRepository]
  lazy val soundRepository: SoundRepository = wire[GridFsSoundRepository]

  /** The registry of open event streams, and the thing route writes announce themselves through.
    *
    * There is one of these for the whole process and it holds its subscribers in memory, which is the same shape of
    * decision as the session store above and is made for the same reason: this is a single-node admin tool, and a
    * message broker would be a second thing to install, run and monitor. `RouteService` sees it only as a
    * `RouteEventPublisher`, so nothing in the application layer can reach into the registry.
    */
  lazy val routeEventBus: RouteEventBus = new RouteEventBus()

  /** The fan-out carrying OBS audio levels to every browser source, and the one connection that fills it.
    *
    * Same shape of decision as `routeEventBus` above, and made for the same reason: one process, one in-memory
    * registry, no broker. The supervisor is the only writer and the SSE endpoint the only reader.
    *
    * Note which way round these two are constructed. The supervisor needs the bus (it publishes into it), and
    * `SettingsService` needs the supervisor (it tells it when the settings changed) but sees it only as an
    * `ObsAudioConnection` — so nothing in the application layer knows a WebSocket exists.
    */
  lazy val audioLevelBus: AudioLevelBus = new AudioLevelBus()

  lazy val obsAudioSupervisor: ObsAudioSupervisor = wire[ObsAudioSupervisor]

  /** Constructed by hand rather than with `wire`: the supervisor is visible here under two types — its own, so
    * `close()` can shut it down, and `ObsAudioConnection`, which is all the application layer is allowed to see — and
    * macwire refuses to guess between two candidates of the same type.
    */
  lazy val settingsService: SettingsService =
    new SettingsService(settingsRepository, obsAudioSupervisor, audioLevelBus)

  lazy val audioLevelStream: AudioLevelStream = wire[AudioLevelStream]

  /** The Twitch chat pipeline, mirroring the OBS audio one piece for piece: one bus, one supervisor that is the only
    * writer, one stream handler that is the only reader, and the application layer seeing the supervisor only through
    * its connection trait.
    */
  lazy val chatBus: ChatBus = new ChatBus()

  lazy val chatMessageRepository: ChatMessageRepository = wire[MongoChatMessageRepository]

  lazy val twitchOAuth: TwitchTokenExchanger = new TwitchOAuth()

  lazy val twitchChatSupervisor: TwitchChatSupervisor = wire[TwitchChatSupervisor]

  /** Constructed by hand for the same reason as `settingsService`: the supervisor is visible here under two types — its
    * own, so `close()` can shut it down, and `TwitchChatConnection`, which is all the application layer sees.
    */
  lazy val twitchService: TwitchService =
    new TwitchService(settingsRepository, chatMessageRepository, twitchChatSupervisor, chatBus, twitchOAuth)

  lazy val chatStream: ChatStream = wire[ChatStream]

  /** Twitch's REST API, and the moderation use cases on top of it.
    *
    * Nothing here starts anything: no thread, no connection, no start-up call. That is part of how the moderation
    * dashboard stays optional — an installation with no Twitch credentials constructs these two objects, never calls
    * them, and behaves exactly as it did before the feature existed.
    *
    * Constructed by hand rather than with `wire` because of the last parameter: macwire matches by type, and a bare
    * `Long` is a type any future setting would share, so naming the value here keeps the wiring unambiguous.
    */
  lazy val twitchHelix: TwitchHelixApi = new TwitchHelixClient()

  lazy val twitchAdminService: TwitchAdminService =
    new TwitchAdminService(
      settingsRepository,
      twitchHelix,
      twitchOAuth,
      TwitchAdminService.RateLimitPauseMillis
    )

  lazy val effectService: EffectService = wire[EffectService]
  lazy val routeService: RouteService = wire[RouteService]
  lazy val presetService: PresetService = wire[PresetService]
  lazy val adminService: AdminService = wire[AdminService]
  lazy val soundService: SoundService = wire[SoundService]
  lazy val soundboardService: SoundboardService = wire[SoundboardService]

  lazy val routeEventStream: RouteEventStream = wire[RouteEventStream]

  /** Also constructed by hand: `MongoConnection` *is* the `DatastoreHealth` implementation, and offering the same
    * object under two names would make macwire's choice ambiguous.
    */
  lazy val healthService: HealthService = new HealthService(mongo, effectRepository, routeRepository)

  /** Constructed by hand because one of its parameters is a `Boolean`: macwire matches dependencies by type, and a bare
    * `Boolean` is a type any future flag would also have, so naming the value here keeps the wiring unambiguous.
    */
  lazy val httpApi: HttpApi =
    new HttpApi(
      effectService,
      routeService,
      presetService,
      adminService,
      healthService,
      sessionService,
      routeEventStream,
      audioLevelStream,
      settingsService,
      twitchService,
      twitchAdminService,
      chatStream,
      soundService,
      soundboardService,
      clock,
      config.sessionCookieSecure
    )

  /** Releases what this graph owns: both supervisors — OBS and Twitch — with their schedulers, then the MongoDB pool.
    *
    * In that order on purpose — a supervisor's scheduler thread can be mid-reconnect, and stopping it first means
    * nothing is left running that could outlive the connection pool it might one day want. The Twitch supervisor in
    * particular writes to the database when it rotates tokens, so it must be stopped before the pool closes.
    */
  override def close(): Unit = {
    obsAudioSupervisor.shutdown()
    twitchChatSupervisor.shutdown()
    mongo.close()
  }
}
