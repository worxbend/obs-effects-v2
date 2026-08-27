package obseffects.infrastructure.mongo

import com.mongodb.MongoWriteException
import com.mongodb.client.model.{Filters, ReplaceOptions}
import obseffects.application.{PresetRepository, RepositoryFailure}
import obseffects.domain.{EffectId, Preset, PresetId, PresetInput}
import org.bson.types.ObjectId

import java.time.Instant

import scala.jdk.CollectionConverters.*

/** The MongoDB-backed preset store.
  *
  * It is the same shape as `MongoRouteRepository`, with one difference that matters: the unique index it relies on,
  * `presets_effect_name_uniq`, is on the *pair* `effectId` + `name` and carries a case-insensitive collation. That is
  * what makes "Neon" and "neon" collide for one effect while leaving two different effects free to own a preset called
  * "Default" each. MongoDB reports the collision as a `MongoWriteException` with error code 11000 ("duplicate key"),
  * which is caught here and turned into a plain `RepositoryFailure.NameTaken` so that nothing above this file has to
  * know MongoDB signals it with an exception.
  *
  * Every query that has to agree with that index — the name lookup below — repeats the collation. A query without it
  * would use a different comparison rule, miss "Neon" when asked for "neon", and then hand the insert to a unique index
  * that disagrees.
  */
class MongoPresetRepository(connection: MongoConnection) extends PresetRepository {

  private val DuplicateKeyErrorCode = 11000

  private val collection = connection.presets

  override def listAll(): List[Preset] =
    collection.find().iterator().asScala.map(BsonCodecs.presetFromDocument).toList

  override def findById(id: PresetId): Option[Preset] =
    objectId(id)
      .flatMap(oid => Option(collection.find(Filters.eq("_id", oid)).first()))
      .map(BsonCodecs.presetFromDocument)

  override def findByEffectAndName(effectId: EffectId, name: String): Option[Preset] =
    Option(
      collection
        .find(Filters.and(Filters.eq("effectId", effectId.value), Filters.eq("name", name)))
        .collation(MongoConnection.CaseInsensitive)
        .first()
    ).map(BsonCodecs.presetFromDocument)

  override def insert(input: PresetInput, createdAt: Instant, updatedAt: Instant): Either[RepositoryFailure, Preset] = {
    // The id is generated here rather than letting the driver fill it in, so the stored document
    // can be handed straight back to the caller without a second read.
    val id = new ObjectId()
    val document = BsonCodecs.presetInputToDocument(input, createdAt, updatedAt).append("_id", id)

    onDuplicateName {
      val _ = collection.insertOne(document)
      BsonCodecs.presetFromDocument(document)
    }
  }

  override def replace(id: PresetId, input: PresetInput, now: Instant): Either[RepositoryFailure, Option[Preset]] =
    (findById(id), objectId(id)) match {
      case (Some(existing), Some(oid)) =>
        val document = BsonCodecs
          .presetInputToDocument(input, createdAt = existing.createdAt, updatedAt = now)
          .append("_id", oid)

        onDuplicateName {
          val _ = collection.replaceOne(Filters.eq("_id", oid), document, new ReplaceOptions().upsert(false))
          Some(BsonCodecs.presetFromDocument(document))
        }

      // Nothing to replace. Reported as `None` rather than an error, because "which HTTP status is
      // that?" is a decision for the service, not the repository.
      case _ => Right(None)
    }

  override def delete(id: PresetId): Boolean =
    objectId(id).exists(oid => collection.deleteOne(Filters.eq("_id", oid)).getDeletedCount > 0)

  override def deleteAll(): Long = collection.deleteMany(Filters.empty()).getDeletedCount

  override def count(): Long = collection.countDocuments()

  // -------------------------------------------------------------------------------------------

  /** Runs a write and converts MongoDB's duplicate-key exception into a value. Every other failure keeps propagating:
    * an unreachable database is not something this method can meaningfully describe, and the HTTP layer already turns
    * it into a 500.
    */
  private def onDuplicateName[A](write: => A): Either[RepositoryFailure, A] =
    try Right(write)
    catch {
      case e: MongoWriteException if e.getError.getCode == DuplicateKeyErrorCode =>
        Left(RepositoryFailure.NameTaken)
    }

  /** A `PresetId` is always 24 hex characters, so this normally succeeds; the `Option` simply avoids an exception if a
    * malformed id ever reaches this layer.
    */
  private def objectId(id: PresetId): Option[ObjectId] =
    if (ObjectId.isValid(id.value)) Some(new ObjectId(id.value)) else None
}
