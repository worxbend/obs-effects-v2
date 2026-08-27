package obseffects.infrastructure.mongo

import com.mongodb.MongoWriteException
import com.mongodb.client.model.{Filters, ReplaceOptions}
import obseffects.application.{RepositoryFailure, RouteRepository}
import obseffects.domain.{RouteConfig, RouteId, RouteInput, Slug}
import org.bson.types.ObjectId

import java.time.Instant

import scala.jdk.CollectionConverters.*

/** The MongoDB-backed route store.
  *
  * The one subtle part is slug uniqueness. The unique index `routes_slug_uniq` makes the database reject a duplicate
  * slug, which surfaces as a `MongoWriteException` with error code 11000 ("duplicate key"). That exception is caught
  * here and turned into a plain value — `RepositoryFailure.SlugTaken` — so the rest of the application never has to
  * know that MongoDB signals this with an exception.
  */
class MongoRouteRepository(connection: MongoConnection) extends RouteRepository {

  private val DuplicateKeyErrorCode = 11000

  private val collection = connection.routes

  override def listAll(): List[RouteConfig] =
    collection.find().iterator().asScala.map(BsonCodecs.routeFromDocument).toList

  override def findById(id: RouteId): Option[RouteConfig] =
    objectId(id)
      .flatMap(oid => Option(collection.find(Filters.eq("_id", oid)).first()))
      .map(BsonCodecs.routeFromDocument)

  override def findBySlug(slug: Slug): Option[RouteConfig] =
    Option(collection.find(Filters.eq("slug", slug.value)).first()).map(BsonCodecs.routeFromDocument)

  override def insert(
      input: RouteInput,
      createdAt: Instant,
      updatedAt: Instant
  ): Either[RepositoryFailure, RouteConfig] = {
    // The id is generated here rather than letting the driver fill it in, so the stored document
    // can be handed straight back to the caller without a second read.
    val id = new ObjectId()
    val document = BsonCodecs.routeInputToDocument(input, createdAt, updatedAt).append("_id", id)

    onDuplicateSlug {
      val _ = collection.insertOne(document)
      BsonCodecs.routeFromDocument(document)
    }
  }

  override def replace(
      id: RouteId,
      input: RouteInput,
      now: Instant
  ): Either[RepositoryFailure, Option[RouteConfig]] =
    (findById(id), objectId(id)) match {
      // Nothing to replace. Reported as `None` rather than an error, because "which HTTP status is
      // that?" is a decision for the service, not the repository.
      case (Some(existing), Some(oid)) =>
        val document = BsonCodecs
          .routeInputToDocument(input, createdAt = existing.createdAt, updatedAt = now)
          .append("_id", oid)

        onDuplicateSlug {
          val _ = collection.replaceOne(Filters.eq("_id", oid), document, new ReplaceOptions().upsert(false))
          Some(BsonCodecs.routeFromDocument(document))
        }

      case _ => Right(None)
    }

  override def delete(id: RouteId): Boolean =
    objectId(id).exists(oid => collection.deleteOne(Filters.eq("_id", oid)).getDeletedCount > 0)

  override def deleteAll(): Long = collection.deleteMany(Filters.empty()).getDeletedCount

  override def count(): Long = collection.countDocuments()

  // -------------------------------------------------------------------------------------------

  /** Runs a write and converts MongoDB's duplicate-key exception into a value. Every other failure keeps propagating:
    * an unreachable database is not something this method can meaningfully describe, and the HTTP layer already turns
    * it into a 500.
    */
  private def onDuplicateSlug[A](write: => A): Either[RepositoryFailure, A] =
    try Right(write)
    catch {
      case e: MongoWriteException if e.getError.getCode == DuplicateKeyErrorCode =>
        Left(RepositoryFailure.SlugTaken)
    }

  /** A `RouteId` is always 24 hex characters, so this normally succeeds; the `Option` simply avoids an exception if a
    * malformed id ever reaches this layer.
    */
  private def objectId(id: RouteId): Option[ObjectId] =
    if (ObjectId.isValid(id.value)) Some(new ObjectId(id.value)) else None
}
