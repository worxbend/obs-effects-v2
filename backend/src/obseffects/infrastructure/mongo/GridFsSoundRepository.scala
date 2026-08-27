package obseffects.infrastructure.mongo

import com.mongodb.client.gridfs.model.{GridFSFile, GridFSUploadOptions}
import com.mongodb.client.model.Filters
import com.mongodb.{MongoGridFSException, MongoWriteException}
import obseffects.application.{RepositoryFailure, SoundRepository}
import obseffects.domain.{Sound, SoundId, SoundInput}
import org.bson.Document
import org.bson.types.ObjectId

import java.time.Instant

import scala.jdk.CollectionConverters.*

/** The GridFS-backed sound store.
  *
  * GridFS splits each file into chunk documents (`sounds.chunks`) and writes one description document per file
  * (`sounds.files`). Everything this repository knows about a sound beyond its bytes — the name, whether it is builtin,
  * the content type, when it was uploaded — lives in that description document's `metadata` field, which is an ordinary
  * embedded document this class writes and reads by hand, in the same explicit style as `BsonCodecs`.
  *
  * The uniqueness of names rests on the `sounds_name_uniq` index (see `MongoConnection.createIndexes`), which sits on
  * `metadata.name` in `sounds.files`. MongoDB reports a collision as error code 11000, caught here and turned into a
  * plain `RepositoryFailure.NameTaken` so nothing above this file knows an exception was involved — the same pattern as
  * `MongoPresetRepository`.
  */
class GridFsSoundRepository(connection: MongoConnection) extends SoundRepository {

  private val DuplicateKeyErrorCode = 11000

  private val bucket = connection.sounds

  override def listAll(): List[Sound] =
    bucket.find().iterator().asScala.map(fromFile).toList

  override def findById(id: SoundId): Option[Sound] =
    objectId(id).flatMap(oid => Option(bucket.find(Filters.eq("_id", oid)).first())).map(fromFile)

  override def findByName(name: String): Option[Sound] =
    Option(bucket.find(Filters.eq("metadata.name", name)).first()).map(fromFile)

  override def insert(input: SoundInput, bytes: Array[Byte], uploadedAt: Instant): Either[RepositoryFailure, Sound] = {
    val metadata = new Document()
      .append("name", input.name)
      .append("builtin", java.lang.Boolean.valueOf(input.builtin))
      .append("contentType", input.contentType)
      // Stored in the metadata rather than read back from GridFS's own `uploadDate`, so that the caller-supplied
      // instant (pinnable in tests) is the one source of truth for `uploadedAt`.
      .append("uploadedAt", java.util.Date.from(uploadedAt))

    val stream = bucket.openUploadStream(input.name, new GridFSUploadOptions().metadata(metadata))
    val id = stream.getObjectId
    try {
      stream.write(bytes)
      stream.close()
      Right(
        Sound(
          id = SoundId.unsafe(id.toHexString),
          name = input.name,
          builtin = input.builtin,
          contentType = input.contentType,
          sizeBytes = bytes.length.toLong,
          uploadedAt = uploadedAt
        )
      )
    } catch {
      case e: MongoWriteException if e.getError.getCode == DuplicateKeyErrorCode =>
        // The chunks were written before the files document was refused by the unique index, so they are orphans now.
        // `bucket.delete` removes chunks even when the files document is already gone; the exception it then throws
        // for that absent document is the expected outcome here, not a failure.
        try bucket.delete(id)
        catch { case _: MongoGridFSException => () }
        Left(RepositoryFailure.NameTaken)
    }
  }

  override def delete(id: SoundId): Boolean =
    objectId(id).exists { oid =>
      // `GridFSBucket.delete` signals "nothing to delete" with an exception rather than a count, so the exception is
      // the value this method exists to return.
      try {
        bucket.delete(oid)
        true
      } catch {
        case _: MongoGridFSException => false
      }
    }

  override def download(id: SoundId): Option[Array[Byte]] =
    objectId(id).flatMap { oid =>
      try {
        val stream = bucket.openDownloadStream(oid)
        try Some(stream.readAllBytes())
        finally stream.close()
      } catch {
        case _: MongoGridFSException => None
      }
    }

  // -------------------------------------------------------------------------------------------

  /** Reads strictly, like `BsonCodecs`: a file without the expected metadata means the bucket was written by something
    * other than this repository, which is corruption a request cannot recover from.
    */
  private def fromFile(file: GridFSFile): Sound = {
    val metadata = Option(file.getMetadata)
      .getOrElse(throw new IllegalStateException(s"Stored sound '${file.getId}' has no metadata"))

    def required[A](key: String, read: Document => A): A =
      Option(read(metadata))
        .getOrElse(throw new IllegalStateException(s"Stored sound '${file.getId}' has no metadata field '$key'"))

    Sound(
      id = SoundId.unsafe(file.getObjectId.toHexString),
      name = required("name", _.getString("name")),
      builtin = required("builtin", _.getBoolean("builtin")),
      contentType = required("contentType", _.getString("contentType")),
      sizeBytes = file.getLength,
      uploadedAt = required("uploadedAt", _.getDate("uploadedAt")).toInstant
    )
  }

  /** A `SoundId` is always 24 hex characters, so this normally succeeds; the `Option` simply avoids an exception if a
    * malformed id ever reaches this layer.
    */
  private def objectId(id: SoundId): Option[ObjectId] =
    if (ObjectId.isValid(id.value)) Some(new ObjectId(id.value)) else None
}
