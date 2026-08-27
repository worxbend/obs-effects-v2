package obseffects.application

import obseffects.domain.{Sound, SoundId, SoundInput, ValidationIssue}

import java.time.Clock

object SoundService {

  /** The audio formats every current browser's `<audio>` element can play, which is the whole reason to accept a format
    * at all: the consumer is the chat overlay effect running inside an OBS browser source. Anything else — video
    * containers, FLAC, raw octet-streams — is refused at upload time rather than discovered broken on air.
    */
  val AllowedContentTypes: Set[String] = Set("audio/mpeg", "audio/ogg", "audio/wav", "audio/webm")

  /** Five megabytes. A notification sound is a second or two of audio; this cap is generous for that while keeping a
    * single upload from filling the database, and it is what makes buffering whole files in memory safe everywhere else
    * in this feature.
    */
  val MaxSizeBytes: Long = 5L * 1024 * 1024

  /** The same 64-character bound preset names have (`docs/CONTRACT.md` §5 rule 9): long enough for any real name, short
    * enough to render anywhere.
    */
  val MaxNameLength: Int = 64

  /** The two sounds seeded at start-up, as (name, classpath resource) pairs. They ship inside the jar so a fresh
    * installation has something for the chat overlay to play before anyone has uploaded anything.
    */
  val Builtins: List[(String, String)] = List(
    "discord" -> "/sounds/discord.mp3",
    "slack-message" -> "/sounds/slack-message.mp3"
  )
}

/** The use cases around sounds: audio files the chat overlay effect plays when a chat message arrives.
  *
  * The same shape as [[PresetService]] where the two overlap — a stored document with a server-assigned id and a unique
  * name — with two differences: the stored thing carries a payload of bytes, and two of the sounds are seeded by the
  * server itself and therefore cannot be deleted.
  *
  * @param clock
  *   the source of "now", injected so a test can pin `uploadedAt` exactly.
  */
class SoundService(sounds: SoundRepository, clock: Clock) {

  import SoundService.*

  /** Every sound, sorted by name ignoring case — the order the admin's sound picker shows them in. */
  def list(): List[Sound] = sounds.listAll().sortBy(_.name.toLowerCase)

  /** Stores an uploaded sound.
    *
    * @param rawName
    *   the `name` query parameter; stored trimmed, like a preset name.
    * @param contentType
    *   the request's `Content-Type` header, absent when the client sent none.
    * @param bytes
    *   the raw request body.
    */
  def upload(rawName: String, contentType: Option[String], bytes: Array[Byte]): Either[AppError, Sound] = {
    val name = rawName.trim
    for {
      _ <- validateUpload(name, contentType, bytes)
      // `contentType` is present here or `validateUpload` would have failed, so `.getOrElse` never fires; it exists
      // only because the compiler cannot see that.
      input = SoundInput(name = name, builtin = false, contentType = contentType.getOrElse(""))
      saved <- sounds.insert(input, bytes, clock.instant()).left.map(nameTaken(name))
    } yield saved
  }

  /** Deletes an uploaded sound. A builtin one is refused: effect parameters may reference it by name, and the seed
    * would recreate it on the next restart anyway, so allowing the delete would only manufacture confusion.
    */
  def delete(rawId: String): Either[AppError, Unit] =
    for {
      id <- parseId(rawId)
      sound <- sounds.findById(id).toRight(notFound(rawId))
      _ <- Either.cond(
        !sound.builtin,
        (),
        AppError.ValidationFailed(List(ValidationIssue("builtin", "a builtin sound cannot be deleted")))
      )
      _ <- Either.cond(sounds.delete(id), (), notFound(rawId))
    } yield ()

  /** The sound and its bytes for the public audio endpoint.
    *
    * The `{id}` path slot accepts either the database id or the sound's *name*: effect parameters reference sounds by
    * name, because a name survives a delete-and-reupload while the id does not, and resolving both here means the
    * overlay never has to look one up first. An id-shaped string is tried as an id first and falls back to a name
    * lookup, so a sound whose name happens to be 24 hex characters is still reachable.
    */
  def audio(idOrName: String): Either[AppError, (Sound, Array[Byte])] =
    for {
      sound <- resolve(idOrName).toRight(notFound(idOrName))
      bytes <- sounds.download(sound.id).toRight(notFound(idOrName))
    } yield (sound, bytes)

  /** Inserts the builtin sounds that are not stored yet. Idempotent: a sound whose name already exists is skipped, so
    * running this on every start-up (and on several instances starting at once — the unique index breaks the tie) is
    * safe. Called from `Main` right after the indexes are known to exist, inside the same database-is-reachable phase.
    */
  def seedBuiltins(): Unit =
    Builtins.foreach { (name, resource) =>
      if (sounds.findByName(name).isEmpty) {
        val input = SoundInput(name = name, builtin = true, contentType = "audio/mpeg")
        // A lost race against another instance seeding the same sound reports NameTaken, which is exactly the
        // "already exists, skip" outcome the check above looks for — so a Left here is discarded on purpose.
        val _ = sounds.insert(input, readResource(resource), clock.instant())
      }
    }

  // -------------------------------------------------------------------------------------------

  private def validateUpload(name: String, contentType: Option[String], bytes: Array[Byte]): Either[AppError, Unit] = {
    val nameIssue =
      if (name.isEmpty) Some(ValidationIssue("name", "must contain at least one non-space character"))
      else if (name.length > MaxNameLength) Some(ValidationIssue("name", s"must be at most $MaxNameLength characters"))
      else None

    val contentTypeIssue = contentType match {
      case Some(value) if AllowedContentTypes.contains(mediaType(value)) => None
      case _                                                             =>
        Some(ValidationIssue("contentType", s"must be one of ${AllowedContentTypes.toList.sorted.mkString(", ")}"))
    }

    val bodyIssue =
      if (bytes.isEmpty) Some(ValidationIssue("body", "must not be empty"))
      else if (bytes.length > MaxSizeBytes) {
        Some(ValidationIssue("body", s"must be at most $MaxSizeBytes bytes (5 MB)"))
      } else None

    val issues = List(nameIssue, contentTypeIssue, bodyIssue).flatten
    Either.cond(issues.isEmpty, (), AppError.ValidationFailed(issues))
  }

  /** A `Content-Type` header may carry parameters (`audio/ogg; codecs=opus`); only the media type before the first
    * semicolon decides whether the format is accepted. Compared lowercased because header values are case-insensitive.
    */
  private def mediaType(headerValue: String): String =
    headerValue.split(';').head.trim.toLowerCase

  private def resolve(idOrName: String): Option[Sound] =
    SoundId.parse(idOrName).toOption.flatMap(sounds.findById).orElse(sounds.findByName(idOrName))

  private def parseId(rawId: String): Either[AppError, SoundId] =
    SoundId.parse(rawId).left.map(message => AppError.BadRequest(s"Invalid sound id '$rawId': $message"))

  private def notFound(idOrName: String): AppError = AppError.NotFound(s"No sound with id or name '$idOrName'")

  /** The only storage failure a sound write can produce is a taken name; `SlugTaken` belongs to routes and cannot reach
    * here, so it becomes the internal error it would in fact be — the same pattern as `PresetService`.
    */
  private def nameTaken(name: String)(failure: RepositoryFailure): AppError = failure match {
    case RepositoryFailure.NameTaken => AppError.SoundNameConflict(name)
    case RepositoryFailure.SlugTaken => AppError.internal("A sound write reported a route slug conflict")
  }

  /** Reads one classpath resource completely. A missing resource is a broken build — the files live in the jar this
    * class is loaded from — so it throws rather than returning an error a caller could not act on.
    */
  private def readResource(path: String): Array[Byte] = {
    val stream = Option(getClass.getResourceAsStream(path))
      .getOrElse(throw new IllegalStateException(s"Builtin sound resource '$path' is missing from the classpath"))
    try stream.readAllBytes()
    finally stream.close()
  }
}
