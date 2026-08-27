package obseffects.infrastructure.mongo

import com.mongodb.MongoWriteException
import com.mongodb.client.model.{Filters, Sorts}
import obseffects.application.ChatMessageRepository
import obseffects.domain.ChatMessage

import scala.jdk.CollectionConverters.*

/** The MongoDB-backed chat history.
  *
  * Append-only: nothing edits or deletes a message, so the whole implementation is one insert and two sorted reads. The
  * message's own id is the `_id`, which makes appends naturally idempotent — Twitch can replay a message across a
  * reconnect, and the duplicate-key rejection below is that replay being deduplicated by the database rather than an
  * error.
  */
final class MongoChatMessageRepository(connection: MongoConnection) extends ChatMessageRepository {

  private val DuplicateKeyErrorCode = 11000

  private val collection = connection.chatMessages

  /** Newest first, with `_id` as the tiebreaker so messages sharing one `at` millisecond keep a stable order between
    * requests — the order the `(at, _id)` paging cursor in `before` assumes.
    */
  private val PageOrder = Sorts.descending("at", "_id")

  override def append(message: ChatMessage): Unit =
    try {
      val _ = collection.insertOne(BsonCodecs.chatMessageToDocument(message))
    } catch {
      // A replayed message id: the message is already stored, which is exactly the state append promises.
      case e: MongoWriteException if e.getError.getCode == DuplicateKeyErrorCode => ()
    }

  override def recent(limit: Int): List[ChatMessage] =
    collection
      .find()
      .sort(PageOrder)
      .limit(limit)
      .iterator()
      .asScala
      .map(BsonCodecs.chatMessageFromDocument)
      .toList

  override def before(at: Long, id: Option[String], limit: Int): List[ChatMessage] = {
    // `at` is an epoch millisecond and not unique — busy chat writes several messages with the same `at`. The cursor
    // therefore compares `(at, _id)` lexicographically: strictly older, or same millisecond with a smaller id. A plain
    // `at < cursor` filter would permanently skip the tied messages that did not fit on the previous page. Without an
    // id (an old-style cursor) the strict `at` cut is the best that can be done.
    val filter = id match {
      case Some(tiebreaker) =>
        Filters.or(Filters.lt("at", at), Filters.and(Filters.eq("at", at), Filters.lt("_id", tiebreaker)))
      case None => Filters.lt("at", at)
    }
    collection
      .find(filter)
      .sort(PageOrder)
      .limit(limit)
      .iterator()
      .asScala
      .map(BsonCodecs.chatMessageFromDocument)
      .toList
  }

  override def count(): Long = collection.countDocuments()
}
