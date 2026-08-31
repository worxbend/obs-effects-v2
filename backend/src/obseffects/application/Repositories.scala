package obseffects.application

import obseffects.domain.*

import java.time.Instant

/** How many descriptors changed during a full inventory replacement. */
final case class EffectSyncOutcome(upserted: Int, removed: Int, total: Int)

/** Storage-level failures that the *application* has to react to.
  *
  * Both cases are the same shape of problem: two clients racing to create something whose name has to be unique.
  * MongoDB's unique indexes reject the loser, and the repositories report it as one of these values rather than letting
  * a driver exception escape into the services.
  */
enum RepositoryFailure {

  /** Another route already owns the requested slug. */
  case SlugTaken

  /** Another preset of the same effect already owns the requested name, compared without regard to case — or, for a
    * sound write, another sound already owns exactly that name. One case for both, because the reporting repository is
    * what tells the service which kind of name was taken.
    */
  case NameTaken
}

/** Reading and writing the effect inventory.
  *
  * This is a *port*: an interface the application defines and the infrastructure implements. The services depend on
  * this trait only, so the MongoDB implementation can be swapped for an in-memory one in tests without any service code
  * changing.
  */
trait EffectRepository {

  /** Every descriptor, in no particular order — sorting is the service's job. */
  def listAll(): List[EffectDescriptor]

  def findById(id: EffectId): Option[EffectDescriptor]

  /** Replaces the entire inventory with `effects` and reports what changed. */
  def replaceAll(effects: List[EffectDescriptor]): EffectSyncOutcome

  def count(): Long
}

/** Reading and writing routes. */
trait RouteRepository {

  def listAll(): List[RouteConfig]

  def findById(id: RouteId): Option[RouteConfig]

  def findBySlug(slug: Slug): Option[RouteConfig]

  /** Stores a brand new route.
    *
    * Both timestamps are parameters rather than something this method reads from a clock, for two reasons: a test can
    * pin them, and an import can restore a route with the `createdAt` its backup file recorded while stamping
    * `updatedAt` with the moment of the restore. Ordinary creates pass the same instant twice.
    */
  def insert(input: RouteInput, createdAt: Instant, updatedAt: Instant): Either[RepositoryFailure, RouteConfig]

  /** Replaces the whole stored document (PUT semantics), keeping the original `createdAt`.
    *
    * @return
    *   `Right(None)` when there is no route with that id, `Left(SlugTaken)` when the new slug belongs to a different
    *   route.
    */
  def replace(id: RouteId, input: RouteInput, now: Instant): Either[RepositoryFailure, Option[RouteConfig]]

  /** @return `true` if a route was deleted, `false` if there was nothing to delete. */
  def delete(id: RouteId): Boolean

  /** Empties the collection, and reports how many documents that removed.
    *
    * This exists for one caller: an import in `replace` mode, which the contract defines as "every route and every
    * preset is deleted first, then the file's contents are inserted". Nothing else may use it.
    */
  def deleteAll(): Long

  def count(): Long
}

/** Reading and writing presets.
  *
  * The shape mirrors [[RouteRepository]] deliberately: a preset is the same kind of thing as a route — a stored
  * document with a server-assigned id, two timestamps and one field that has to be unique — so anyone who has read one
  * of these two traits has read the other.
  */
trait PresetRepository {

  /** Every preset, in no particular order. Sorting and filtering are the service's job, for the reason given in
    * `docs/CONTRACT.md` §6: the unique index carries a case-insensitive collation, and a query that does not repeat
    * that collation would not use the index anyway.
    */
  def listAll(): List[Preset]

  def findById(id: PresetId): Option[Preset]

  /** Finds the preset one effect owns under this name, compared without regard to case. Used by an import in `merge`
    * mode, which matches a preset by `effectId` + `name` rather than by id.
    */
  def findByEffectAndName(effectId: EffectId, name: String): Option[Preset]

  /** Stores a brand new preset. Both timestamps are parameters, for the reason given on [[RouteRepository.insert]]. */
  def insert(input: PresetInput, createdAt: Instant, updatedAt: Instant): Either[RepositoryFailure, Preset]

  /** Replaces the whole stored document (PUT semantics), keeping the original `createdAt`.
    *
    * @return
    *   `Right(None)` when there is no preset with that id, `Left(NameTaken)` when the new name belongs to a different
    *   preset of the same effect.
    */
  def replace(id: PresetId, input: PresetInput, now: Instant): Either[RepositoryFailure, Option[Preset]]

  /** @return `true` if a preset was deleted, `false` if there was nothing to delete. */
  def delete(id: PresetId): Boolean

  /** Empties the collection. As with [[RouteRepository.deleteAll]], the only caller is an import in `replace` mode. */
  def deleteAll(): Long

  def count(): Long
}

/** A liveness probe for the datastore, used by `GET /api/health`. Kept separate from the two repositories because it is
  * about the connection, not about any particular collection.
  */
trait DatastoreHealth {

  /** @return `true` when the database answered a ping, `false` when it did not. Never throws. */
  def reachable(): Boolean
}

/** Where the one-and-only settings document lives.
  *
  * Unlike every other repository here there is no id and no list: there is exactly one OBS connection to configure, so
  * the whole interface is "read it" and "write it". A missing document is not an error — it is a fresh installation,
  * and [[SettingsRepository.load]] answers with the defaults rather than an empty option, so no caller has to invent
  * what "unconfigured" means.
  */
trait SettingsRepository {

  /** The stored OBS audio settings, or [[obseffects.domain.ObsAudioSettings.Default]] if nothing is stored yet. */
  def loadObsAudio(): ObsAudioSettings

  /** Writes the settings, creating the document if this is the first save. */
  def saveObsAudio(settings: ObsAudioSettings): ObsAudioSettings

  /** The stored Twitch chat settings, or [[obseffects.domain.TwitchSettings.Default]] if nothing is stored yet. */
  def loadTwitch(): TwitchSettings

  /** Writes the Twitch settings, creating the document if this is the first save.
    *
    * Stored as its *own* document, not folded into the OBS audio one, and that separation is load-bearing: a token
    * refresh rewrites this document from the supervisor's thread, and if the two shared a document that write could
    * race an operator saving OBS settings and silently undo one or the other.
    */
  def saveTwitch(settings: TwitchSettings): TwitchSettings

  /** Patches only the credential fields of the Twitch document, touching nothing else. `None` means "leave that field
    * as it is" — this method exists to *set* rotated tokens and a discovered login, never to clear them.
    *
    * This is a separate operation from [[saveTwitch]] because the supervisor calls it from its own thread while an
    * operator may be saving the same document from an HTTP request. A load-then-`saveTwitch` on the supervisor's side
    * would replace the *whole* document with a pre-save snapshot, silently reverting every field the operator just
    * changed; a field-level update cannot revert anything it does not mention.
    *
    * `scopes` is an `Option[List[String]]` rather than a plain list so that the outer "leave it alone" and an inner
    * "the token has no scopes at all" stay two different instructions — a caller that only learned a rotated token must
    * not blank the permission list as a side effect.
    */
  def updateTwitchAuth(
      accessToken: Option[String] = None,
      refreshToken: Option[String] = None,
      botLogin: Option[String] = None,
      botUserId: Option[String] = None,
      scopes: Option[List[String]] = None,
      broadcasterId: Option[String] = None
  ): Unit

  /** The stored soundboard, or [[obseffects.domain.Soundboard.Empty]] if nothing is stored yet — a fresh installation
    * has rules the moment someone writes some, and an empty list until then, so no caller has to invent what
    * "unconfigured" means.
    */
  def loadSoundboard(): Soundboard

  /** Writes the soundboard, creating the document if this is the first save. Stored as its own document beside the OBS
    * audio and Twitch ones, for the same one-writer-per-document reason those two are separate.
    */
  def saveSoundboard(soundboard: Soundboard): Soundboard
}

/** Reading and writing the recorded chat history.
  *
  * Append-only from the application's point of view: messages are written as they arrive and read back newest-first for
  * the admin's history view and for seeding the snapshot ring after a restart. Nothing edits or deletes one.
  */
trait ChatMessageRepository {

  /** Stores one message. Called from the chat connection's own thread for every event that arrives, so implementations
    * must be cheap and must not throw for a duplicate — reconnects can replay a message.
    */
  def append(message: ChatMessage): Unit

  /** The most recent messages, **newest first**, at most `limit` of them. */
  def recent(limit: Int): List[ChatMessage]

  /** Messages before the `(at, id)` cursor, **newest first**, at most `limit` of them. This is the paging cursor for
    * the history view: pass the `at` and the id of the oldest message already shown to get the page before it.
    *
    * The id is part of the cursor because `at` is an epoch-millisecond timestamp and busy chat produces several
    * messages in the same millisecond. Paging on `at` alone would drop every tied message that did not fit on the
    * previous page. With `id` absent (an old-style cursor) the cut is strictly `at`-older, which can still skip tied
    * messages — callers should always send the id.
    */
  def before(at: Long, id: Option[String], limit: Int): List[ChatMessage]

  def count(): Long
}

/** Reading and writing the stored sounds — audio files the chat overlay effect plays when a chat message arrives.
  *
  * The production implementation keeps the bytes in MongoDB's GridFS (a convention for storing files bigger than one
  * document), which is why the bytes travel separately from the descriptions: listing sounds must not drag five
  * megabytes per row out of the database.
  *
  * Name uniqueness is *exact*, unlike the case-insensitive preset rule. A sound name is a lookup key — effect
  * parameters reference a sound by name and the public audio URL accepts the name verbatim — so "Discord" and "discord"
  * would be two genuinely different keys, not two spellings of one.
  */
trait SoundRepository {

  /** Every sound's description, in no particular order — sorting is the service's job. */
  def listAll(): List[Sound]

  def findById(id: SoundId): Option[Sound]

  /** Finds the sound owning exactly this name — see the note above on why the comparison is case-sensitive. */
  def findByName(name: String): Option[Sound]

  /** Stores a brand new sound with its bytes. `uploadedAt` is a parameter rather than something this method reads from
    * a clock, for the same test-pinning reason as [[RouteRepository.insert]].
    */
  def insert(input: SoundInput, bytes: Array[Byte], uploadedAt: Instant): Either[RepositoryFailure, Sound]

  /** @return `true` if a sound was deleted, `false` if there was nothing to delete. */
  def delete(id: SoundId): Boolean

  /** The stored bytes of one sound, or `None` when no sound has that id. Materialising the whole file is fine here:
    * uploads are capped at five megabytes, so "streaming" would buy nothing but plumbing.
    */
  def download(id: SoundId): Option[Array[Byte]]
}
