package obseffects.application

import obseffects.domain.*

import java.time.Instant
import java.util.concurrent.atomic.AtomicReference

/** Stand-ins for the MongoDB repositories, holding everything in memory.
  *
  * These exist so the service tests can run anywhere — no database, no Docker, no network — while still exercising the
  * real service code. State is kept in an `AtomicReference` around an immutable `Map`, so a test can never observe a
  * half-updated collection.
  */
class InMemoryEffectRepository(initial: List[EffectDescriptor] = Nil) extends EffectRepository {

  private val state = new AtomicReference[Map[EffectId, EffectDescriptor]](
    initial.map(descriptor => descriptor.id -> descriptor).toMap
  )

  override def listAll(): List[EffectDescriptor] = state.get().values.toList

  override def findById(id: EffectId): Option[EffectDescriptor] = state.get().get(id)

  override def replaceAll(effects: List[EffectDescriptor]): EffectSyncOutcome = {
    val previous = state.get()
    val next = effects.map(descriptor => descriptor.id -> descriptor).toMap
    state.set(next)

    // "Upserted" counts descriptors that are new or actually different, so re-sending an unchanged
    // manifest reports zero — the same rule the MongoDB implementation follows.
    val upserted = next.count((id, descriptor) => !previous.get(id).contains(descriptor))
    val removed = previous.keySet.diff(next.keySet).size
    EffectSyncOutcome(upserted = upserted, removed = removed, total = next.size)
  }

  override def count(): Long = state.get().size.toLong
}

/** In-memory routes, including the slug uniqueness rule that MongoDB's unique index enforces in production.
  */
class InMemoryRouteRepository extends RouteRepository {

  private val state = new AtomicReference[Map[RouteId, RouteConfig]](Map.empty)

  /** Ids only have to look like ObjectIds (24 hex characters) and be unique within one test run. */
  private val nextId = new java.util.concurrent.atomic.AtomicInteger(1)

  private def freshId(): RouteId = RouteId.unsafe(f"${nextId.getAndIncrement()}%024x")

  override def listAll(): List[RouteConfig] = state.get().values.toList

  override def findById(id: RouteId): Option[RouteConfig] = state.get().get(id)

  override def findBySlug(slug: Slug): Option[RouteConfig] = state.get().values.find(_.slug == slug)

  override def insert(
      input: RouteInput,
      createdAt: Instant,
      updatedAt: Instant
  ): Either[RepositoryFailure, RouteConfig] =
    if (findBySlug(input.slug).isDefined) Left(RepositoryFailure.SlugTaken)
    else {
      val route = RouteConfig(
        freshId(),
        input.slug,
        input.effectId,
        input.enabled,
        input.params,
        input.canvas,
        createdAt,
        updatedAt
      )
      state.updateAndGet(_.updated(route.id, route))
      Right(route)
    }

  override def replace(id: RouteId, input: RouteInput, now: Instant): Either[RepositoryFailure, Option[RouteConfig]] =
    state.get().get(id) match {
      case None           => Right(None)
      case Some(existing) =>
        val slugOwner = findBySlug(input.slug)
        // Keeping your own slug is fine; taking someone else's is not.
        if (slugOwner.exists(_.id != id)) Left(RepositoryFailure.SlugTaken)
        else {
          val updated = existing.copy(
            slug = input.slug,
            effectId = input.effectId,
            enabled = input.enabled,
            params = input.params,
            canvas = input.canvas,
            updatedAt = now
          )
          state.updateAndGet(_.updated(id, updated))
          Right(Some(updated))
        }
    }

  override def delete(id: RouteId): Boolean = {
    val before = state.getAndUpdate(_.removed(id))
    before.contains(id)
  }

  override def deleteAll(): Long = state.getAndSet(Map.empty).size.toLong

  override def count(): Long = state.get().size.toLong
}

/** In-memory presets, including the "one effect may not own two presets whose names differ only in case" rule that
  * MongoDB's collated unique index enforces in production.
  */
class InMemoryPresetRepository extends PresetRepository {

  private val state = new AtomicReference[Map[PresetId, Preset]](Map.empty)

  private val nextId = new java.util.concurrent.atomic.AtomicInteger(1)

  private def freshId(): PresetId = PresetId.unsafe(f"${nextId.getAndIncrement()}%024x")

  override def listAll(): List[Preset] = state.get().values.toList

  override def findById(id: PresetId): Option[Preset] = state.get().get(id)

  override def findByEffectAndName(effectId: EffectId, name: String): Option[Preset] =
    state.get().values.find(preset => preset.effectId == effectId && preset.name.equalsIgnoreCase(name))

  override def insert(input: PresetInput, createdAt: Instant, updatedAt: Instant): Either[RepositoryFailure, Preset] =
    if (findByEffectAndName(input.effectId, input.name).isDefined) Left(RepositoryFailure.NameTaken)
    else {
      val preset = Preset(freshId(), input.name, input.effectId, input.params, createdAt, updatedAt)
      state.updateAndGet(_.updated(preset.id, preset))
      Right(preset)
    }

  override def replace(id: PresetId, input: PresetInput, now: Instant): Either[RepositoryFailure, Option[Preset]] =
    state.get().get(id) match {
      case None           => Right(None)
      case Some(existing) =>
        val nameOwner = findByEffectAndName(input.effectId, input.name)
        // Keeping your own name is fine; taking another preset's is not.
        if (nameOwner.exists(_.id != id)) Left(RepositoryFailure.NameTaken)
        else {
          val updated =
            existing.copy(name = input.name, effectId = input.effectId, params = input.params, updatedAt = now)
          state.updateAndGet(_.updated(id, updated))
          Right(Some(updated))
        }
    }

  override def delete(id: PresetId): Boolean = {
    val before = state.getAndUpdate(_.removed(id))
    before.contains(id)
  }

  override def deleteAll(): Long = state.getAndSet(Map.empty).size.toLong

  override def count(): Long = state.get().size.toLong
}

/** A [[RouteEventPublisher]] that keeps what it was told instead of sending it anywhere.
  *
  * This is what lets a test assert that a write announced itself — and, just as importantly, that a *failed* write
  * announced nothing — without opening a socket or waiting on a stream.
  */
class RecordingRouteEvents extends RouteEventPublisher {

  private val log = new AtomicReference[Vector[RouteEvent]](Vector.empty)

  override def routeChanged(route: RouteConfig): Unit = {
    val _ = log.updateAndGet(_ :+ RouteEvent.Configured(route))
  }

  override def routeRemoved(slug: Slug): Unit = {
    val _ = log.updateAndGet(_ :+ RouteEvent.Absent(slug))
  }

  /** Everything published so far, oldest first. */
  def published: List[RouteEvent] = log.get().toList

  /** The published events reduced to something short enough to assert on: `config main-camera`, `absent old-name`. */
  def summary: List[String] = published.map {
    case RouteEvent.Configured(route) => s"config ${route.slug.value}"
    case RouteEvent.Absent(slug)      => s"absent ${slug.value}"
  }
}

/** A datastore health probe whose answer the test decides. */
class StubDatastoreHealth(healthy: Boolean) extends DatastoreHealth {
  override def reachable(): Boolean = healthy
}

/** In-memory chat history, kept in arrival order like the real collection's `at` ordering. */
class InMemoryChatMessageRepository extends ChatMessageRepository {

  private val state = new AtomicReference[Vector[ChatMessage]](Vector.empty)

  override def append(message: ChatMessage): Unit = {
    val _ = state.updateAndGet(_ :+ message)
  }

  override def recent(limit: Int): List[ChatMessage] =
    state.get().sorted(PageOrder).take(limit).toList

  override def before(at: Long, id: Option[String], limit: Int): List[ChatMessage] =
    state
      .get()
      // Mirrors the Mongo `(at, _id)` compound cursor: strictly older, or same millisecond with a smaller id.
      .filter(m => m.at < at || id.exists(tiebreaker => m.at == at && m.id < tiebreaker))
      .sorted(PageOrder)
      .take(limit)
      .toList

  /** Newest first with the id as tiebreaker, like the real collection's `descending("at", "_id")` page order. */
  private val PageOrder: Ordering[ChatMessage] = Ordering.by((m: ChatMessage) => (m.at, m.id)).reverse

  override def count(): Long = state.get().size.toLong
}

/** Records what the Twitch connection was asked to do, without any network anywhere near it — the Twitch counterpart of
  * `RecordingObsConnection`.
  */
class RecordingTwitchConnection extends TwitchChatConnection {

  private val log = new AtomicReference[Vector[TwitchSettings]](Vector.empty)

  override def reconfigure(settings: TwitchSettings): Unit = {
    val _ = log.updateAndGet(_ :+ settings)
  }

  /** Every reconfiguration asked for so far, oldest first. */
  def applied: List[TwitchSettings] = log.get().toList
}

/** A token exchanger whose answers the test decides, recording what was asked of it. */
class StubTwitchTokenExchanger(
    exchange: Either[String, TwitchTokenPair] = Left("exchange not stubbed"),
    refresh: Either[String, TwitchTokenPair] = Left("refresh not stubbed"),
    validate: Either[String, TwitchTokenInfo] = Left("validate not stubbed"),
    // Answers keyed by the token presented, for the tests where a refresh must change what Twitch says: the old access
    // token is refused and the rotated one is accepted. Any token not named here gets `validate`.
    validatePerToken: Map[String, Either[String, TwitchTokenInfo]] = Map.empty
) extends TwitchTokenExchanger {

  private val log = new AtomicReference[Vector[String]](Vector.empty)

  override def exchangeCode(
      clientId: String,
      clientSecret: String,
      code: String,
      redirectUri: String
  ): Either[String, TwitchTokenPair] = {
    val _ = log.updateAndGet(_ :+ s"exchange $clientId $code $redirectUri")
    exchange
  }

  override def refreshTokens(
      clientId: String,
      clientSecret: String,
      refreshToken: String
  ): Either[String, TwitchTokenPair] = {
    val _ = log.updateAndGet(_ :+ s"refresh $refreshToken")
    refresh
  }

  override def validateToken(accessToken: String): Either[String, TwitchTokenInfo] = {
    val _ = log.updateAndGet(_ :+ s"validate $accessToken")
    validatePerToken.getOrElse(accessToken, validate)
  }

  /** Every call made so far, oldest first, reduced to one line each for easy assertion. */
  def calls: List[String] = log.get().toList
}

/** In-memory sounds, including the exact-match name uniqueness rule that the `sounds_name_uniq` index enforces in
  * production. The bytes are kept alongside the description, which is exactly what GridFS does at a larger scale.
  */
class InMemorySoundRepository extends SoundRepository {

  private val state = new AtomicReference[Map[SoundId, (Sound, Array[Byte])]](Map.empty)

  private val nextId = new java.util.concurrent.atomic.AtomicInteger(1)

  private def freshId(): SoundId = SoundId.unsafe(f"${nextId.getAndIncrement()}%024x")

  override def listAll(): List[Sound] = state.get().values.map(_._1).toList

  override def findById(id: SoundId): Option[Sound] = state.get().get(id).map(_._1)

  override def findByName(name: String): Option[Sound] =
    state.get().values.map(_._1).find(_.name == name)

  override def insert(input: SoundInput, bytes: Array[Byte], uploadedAt: Instant): Either[RepositoryFailure, Sound] =
    if (findByName(input.name).isDefined) Left(RepositoryFailure.NameTaken)
    else {
      val sound = Sound(freshId(), input.name, input.builtin, input.contentType, bytes.length.toLong, uploadedAt)
      state.updateAndGet(_.updated(sound.id, (sound, bytes)))
      Right(sound)
    }

  override def delete(id: SoundId): Boolean = {
    val before = state.getAndUpdate(_.removed(id))
    before.contains(id)
  }

  override def download(id: SoundId): Option[Array[Byte]] = state.get().get(id).map(_._2)
}

/** A Twitch Helix API whose answers the test decides, recording every call with the token it was made with.
  *
  * The token is recorded because two of the rules this feature is judged on are invisible without it: that a `401`
  * refreshes the token and retries the *same* call once, and that the rest of a batch then carries on with the new
  * token rather than the dead one.
  *
  * @param users
  *   the accounts this fake knows; a login absent from here resolves to nothing, exactly as Twitch does.
  * @param acceptedToken
  *   when set, any call presenting a different token answers `401`. That is how an expired token is simulated without a
  *   single string comparison inside the code under test.
  * @param banAnswers
  *   per-login answers for `ban`, defaulting to success — the way one bad user among good ones is set up.
  */
class FakeTwitchHelix(
    users: List[TwitchUser] = Nil,
    acceptedToken: Option[String] = None,
    banAnswers: Map[String, Either[HelixFailure, Unit]] = Map.empty,
    unbanAnswers: Map[String, Either[HelixFailure, Unit]] = Map.empty,
    banPages: Map[Option[String], Either[HelixFailure, TwitchBanPage]] = Map.empty,
    moderatorPages: Map[Option[String], Either[HelixFailure, TwitchModeratorPage]] = Map.empty,
    resolveAnswer: Option[Either[HelixFailure, List[TwitchUser]]] = None
) extends TwitchHelixApi {

  private val log = new AtomicReference[Vector[String]](Vector.empty)

  private def record(line: String): Unit = { val _ = log.updateAndGet(_ :+ line) }

  private def authorised[A](token: String)(answer: => Either[HelixFailure, A]): Either[HelixFailure, A] =
    if (acceptedToken.forall(_ == token)) answer else Left(HelixFailure.Unauthorized)

  private def byId(userId: String): String = users.find(_.id == userId).map(_.login).getOrElse(userId)

  override def resolveUsers(
      clientId: String,
      accessToken: String,
      logins: List[String]
  ): Either[HelixFailure, List[TwitchUser]] = {
    record(s"resolve[$accessToken] ${logins.mkString(",")}")
    authorised(accessToken) {
      resolveAnswer.getOrElse(Right(users.filter(user => logins.exists(_.equalsIgnoreCase(user.login)))))
    }
  }

  override def listBans(
      clientId: String,
      accessToken: String,
      broadcasterId: String,
      moderatorId: String,
      cursor: Option[String],
      limit: Int
  ): Either[HelixFailure, TwitchBanPage] = {
    record(s"bans[$accessToken] cursor=${cursor.getOrElse("-")} limit=$limit")
    authorised(accessToken)(banPages.getOrElse(cursor, Right(TwitchBanPage(Nil, None))))
  }

  override def ban(
      clientId: String,
      accessToken: String,
      broadcasterId: String,
      moderatorId: String,
      userId: String,
      durationSeconds: Option[Int],
      reason: Option[String]
  ): Either[HelixFailure, Unit] = {
    record(s"ban[$accessToken] ${byId(userId)} duration=${durationSeconds.getOrElse("-")}")
    authorised(accessToken)(banAnswers.getOrElse(byId(userId), Right(())))
  }

  override def unban(
      clientId: String,
      accessToken: String,
      broadcasterId: String,
      moderatorId: String,
      userId: String
  ): Either[HelixFailure, Unit] = {
    record(s"unban[$accessToken] ${byId(userId)}")
    authorised(accessToken)(unbanAnswers.getOrElse(byId(userId), Right(())))
  }

  override def listModerators(
      clientId: String,
      accessToken: String,
      broadcasterId: String,
      cursor: Option[String]
  ): Either[HelixFailure, TwitchModeratorPage] = {
    record(s"moderators[$accessToken] cursor=${cursor.getOrElse("-")}")
    authorised(accessToken)(moderatorPages.getOrElse(cursor, Right(TwitchModeratorPage(Nil, None))))
  }

  /** Every call made so far, oldest first, reduced to one line each for easy assertion. */
  def calls: List[String] = log.get().toList
}
