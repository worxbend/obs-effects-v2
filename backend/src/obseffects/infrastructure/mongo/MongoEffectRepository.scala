package obseffects.infrastructure.mongo

import com.mongodb.client.model.{Filters, ReplaceOptions}
import obseffects.application.{EffectRepository, EffectSyncOutcome}
import obseffects.domain.{EffectDescriptor, EffectId}

import scala.jdk.CollectionConverters.*

/** The MongoDB-backed effect inventory.
  *
  * Documents live in the `effects` collection, with the effect's own id as `_id` — the id is already a stable,
  * human-readable name, so there is no reason to invent a second key for it.
  */
class MongoEffectRepository(connection: MongoConnection) extends EffectRepository {

  private val collection = connection.effects

  override def listAll(): List[EffectDescriptor] =
    collection.find().iterator().asScala.map(BsonCodecs.descriptorFromDocument).toList

  override def findById(id: EffectId): Option[EffectDescriptor] =
    Option(collection.find(Filters.eq("_id", id.value)).first()).map(BsonCodecs.descriptorFromDocument)

  /** Makes `effects` the complete inventory: everything in the manifest is written, everything else is deleted.
    *
    * The counts reported back describe what actually changed, so running the same sync twice reports
    * `upserted = 0, removed = 0` the second time. That makes the response a useful signal ("did my manifest change
    * anything?") rather than a restatement of the request.
    */
  override def replaceAll(effects: List[EffectDescriptor]): EffectSyncOutcome = {
    val keepIds = effects.map(_.id.value)

    val removed = collection.deleteMany(Filters.nin("_id", keepIds.asJava)).getDeletedCount

    val upserted = effects.count { descriptor =>
      val result = collection.replaceOne(
        Filters.eq("_id", descriptor.id.value),
        BsonCodecs.descriptorToDocument(descriptor),
        new ReplaceOptions().upsert(true)
      )
      // `getUpsertedId` is non-null for a brand new document; `getModifiedCount` is 1 when an
      // existing document actually changed. A document that was already identical counts as
      // neither, which is exactly the "nothing happened" case.
      result.getUpsertedId != null || result.getModifiedCount > 0
    }

    EffectSyncOutcome(upserted = upserted, removed = removed.toInt, total = effects.size)
  }

  override def count(): Long = collection.countDocuments()
}
