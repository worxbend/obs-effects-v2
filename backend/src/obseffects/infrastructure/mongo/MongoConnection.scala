package obseffects.infrastructure.mongo

import com.mongodb.client.model.{Collation, CollationStrength, IndexOptions, Indexes}
import com.mongodb.client.{MongoClient, MongoClients, MongoCollection, MongoDatabase}
import com.mongodb.{ConnectionString, MongoClientSettings}
import obseffects.application.DatastoreHealth
import org.bson.Document

import java.util.concurrent.TimeUnit

import scala.util.control.NonFatal

/** The values `MongoConnection` needs that do not belong to any one instance of it.
  *
  * In Scala, an `object` with the same name as a class is called its *companion*, and it is the usual home for
  * constants: there is exactly one of it, and the class below can read its private members.
  */
object MongoConnection {

  /** How long a MongoDB call waits for a usable server before giving up, in milliseconds.
    *
    * The driver's own default is 30 seconds. That is too long here for one specific reason: the HTTP server (Netty,
    * underneath Tapir) abandons a request that has not answered within 20 seconds and closes the connection with an
    * empty `503`. So with the driver default, `GET /api/health` with MongoDB switched off never got to send the `500`
    * error envelope that `docs/CONTRACT.md` promises — the connection was cut first, and the caller saw an empty
    * response instead of `{"error":{"code":"INTERNAL_ERROR", ... "details":{"mongo":"down"}}}`.
    *
    * Three seconds is comfortably under that 20-second limit while still leaving room for a slow local network or a
    * replica-set election. It also makes the start-up retry loop below behave the way its documentation describes: each
    * failed attempt now costs about three seconds rather than thirty.
    */
  private val ServerSelectionTimeoutMillis = 3000L

  /** The comparison rule the `presets` unique index uses.
    *
    * A MongoDB *collation* is a set of language rules for comparing strings. Strength 2 means "compare letters and
    * accents, ignore case", which is exactly the rule `docs/CONTRACT.md` §5 rule 10 asks for: a preset called "Neon"
    * and one called "neon" are the same name for one effect. Doing it in the index means the database enforces the
    * rule, so two simultaneous creates cannot both succeed — the alternative, storing a second lower-cased copy of
    * every name, would put the rule in the application where a race can slip past it.
    *
    * One consequence worth knowing: a *query* that does not repeat this collation will not use this index and will scan
    * the collection instead. With a preset list measured in dozens that costs nothing, and it is why the sorting and
    * the `?effectId=` filter are done in `PresetService` rather than by the database.
    */
  val CaseInsensitive: Collation =
    Collation.builder().locale("en").collationStrength(CollationStrength.SECONDARY).build()
}

/** Owns the connection to MongoDB and the two collections the application uses.
  *
  * The *synchronous* driver is used on purpose: its calls block the calling thread, and on Java 21 virtual threads a
  * blocked thread costs almost nothing. That is what lets the whole codebase stay in plain direct style instead of a
  * Future/IO world.
  *
  * @param uri
  *   a MongoDB connection string such as `mongodb://mongo:27017`.
  * @param databaseName
  *   which database inside the server to use, e.g. `obs_effects`.
  */
class MongoConnection(uri: String, databaseName: String) extends DatastoreHealth with AutoCloseable {

  /** The connection string is parsed once so we can ask whether the operator already chose a server-selection timeout
    * in the `MONGO_URI` (`...?serverSelectionTimeoutMS=1000`). If they did, their value is left alone; the default
    * below is only a default.
    */
  private val connectionString: ConnectionString = new ConnectionString(uri)

  private val settings: MongoClientSettings =
    MongoClientSettings
      .builder()
      .applyConnectionString(connectionString)
      .applyToClusterSettings { builder =>
        if (Option(connectionString.getServerSelectionTimeout).isEmpty) {
          val _ = builder.serverSelectionTimeout(MongoConnection.ServerSelectionTimeoutMillis, TimeUnit.MILLISECONDS)
        }
      }
      .build()

  private val client: MongoClient = MongoClients.create(settings)
  private val database: MongoDatabase = client.getDatabase(databaseName)

  val effects: MongoCollection[Document] = database.getCollection("effects")
  val routes: MongoCollection[Document] = database.getCollection("routes")
  val presets: MongoCollection[Document] = database.getCollection("presets")

  /** The one-document collection holding operator settings, such as the obs-websocket connection. See
    * `MongoSettingsRepository` for why a collection rather than environment variables.
    */
  val settingsCollection: MongoCollection[Document] = database.getCollection("settings")

  /** The recorded Twitch chat history: one document per chat event, appended as they arrive. This is what makes chat
    * survive a page reload and a server restart — the in-memory snapshot ring is seeded from here at start-up.
    */
  val chatMessages: MongoCollection[Document] = database.getCollection("chatMessages")

  /** Creates the indexes described in the contract.
    *
    * MongoDB's `createIndex` is idempotent — asking for an index that already exists with the same definition does
    * nothing — so this is safe to run on every startup, including when several backend instances start at once.
    *
    * The unique index on `slug` is the one that actually guarantees slug uniqueness: the check in `RouteService` gives
    * a friendly error, but only the index can stop two simultaneous creates from both succeeding.
    */
  def createIndexes(): Unit = {
    val _ = effects.createIndex(Indexes.ascending("name"), new IndexOptions().name("effects_name_idx"))
    val _ = routes.createIndex(
      Indexes.ascending("slug"),
      new IndexOptions().name("routes_slug_uniq").unique(true)
    )
    val _ = routes.createIndex(Indexes.ascending("effectId"), new IndexOptions().name("routes_effect_idx"))
    val _ = presets.createIndex(
      Indexes.ascending("effectId", "name"),
      new IndexOptions()
        .name("presets_effect_name_uniq")
        .unique(true)
        .collation(MongoConnection.CaseInsensitive)
    )
    // Descending on `at` because every history query is "the newest N" — the index matches the sort direction so
    // MongoDB walks it forward instead of scanning and sorting.
    val _ = chatMessages.createIndex(
      Indexes.compoundIndex(Indexes.ascending("channel"), Indexes.descending("at")),
      new IndexOptions().name("chat_channel_at_idx")
    )
    // The history queries today do not filter by channel (one installation watches one channel), and a sort on `at`
    // alone cannot use the compound index above, whose leading field is `channel`. Both exist so today's queries are
    // indexed and a future per-channel filter is too.
    val _ = chatMessages.createIndex(Indexes.descending("at"), new IndexOptions().name("chat_at_idx"))
  }

  /** Waits for MongoDB to accept connections, then creates the indexes.
    *
    * In Docker Compose the backend container often starts a second or two before MongoDB is ready to answer. Rather
    * than crashing (and being restarted by Docker in a loop), the service retries quietly for a while and only gives up
    * if the database really never appears.
    *
    * @param attempts
    *   how many times to try before giving up.
    * @param delayMillis
    *   how long to wait between attempts.
    * @return
    *   `true` when the indexes are in place, `false` when MongoDB never became reachable.
    */
  def waitForDatabaseAndCreateIndexes(attempts: Int = 30, delayMillis: Long = 2000): Boolean = {
    var remaining = attempts
    var ready = false
    while (!ready && remaining > 0) {
      if (reachable()) {
        createIndexes()
        ready = true
      } else {
        remaining -= 1
        println(s"MongoDB at $uri is not reachable yet; retrying in ${delayMillis}ms ($remaining attempts left)")
        Thread.sleep(delayMillis)
      }
    }
    ready
  }

  /** Pings the server. Any failure — server down, wrong credentials, network partition — is reported as "not reachable"
    * rather than thrown, because the caller is a health endpoint whose whole job is to answer that question.
    */
  override def reachable(): Boolean =
    try {
      val _ = database.runCommand(new Document("ping", 1))
      true
    } catch {
      case NonFatal(_) => false
    }

  override def close(): Unit = client.close()
}
