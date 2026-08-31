package obseffects.infrastructure.mongo

import com.mongodb.client.model.{Filters, ReplaceOptions, UpdateOptions, Updates}
import obseffects.application.SettingsRepository
import obseffects.domain.{ObsAudioSettings, Soundboard, TwitchSettings}

import scala.jdk.CollectionConverters.*

/** The `settings` collection: one document, holding everything an operator configures that is not a route or a preset.
  *
  * ==Why a collection with one document in it==
  *
  * A single row in a table nobody else uses looks odd, and the alternative — environment variables — was seriously
  * considered and rejected. Environment variables cannot be changed from the admin panel, which is the whole
  * requirement here: an operator who mistypes their obs-websocket password should fix it in a form and press Save, not
  * edit a `.env` file and restart the server in the middle of a broadcast.
  *
  * The document is found by a fixed `_id` rather than "the first one", so a second document cannot appear and start
  * winning at random.
  */
final class MongoSettingsRepository(connection: MongoConnection) extends SettingsRepository {

  private val collection = connection.settingsCollection

  override def loadObsAudio(): ObsAudioSettings =
    Option(collection.find(Filters.eq("_id", MongoSettingsRepository.ObsAudioId)).first())
      .map(BsonCodecs.obsAudioSettingsFromDocument)
      .getOrElse(ObsAudioSettings.Default)

  override def saveObsAudio(settings: ObsAudioSettings): ObsAudioSettings = {
    val document = BsonCodecs
      .obsAudioSettingsToDocument(settings)
      .append("_id", MongoSettingsRepository.ObsAudioId)

    // `upsert(true)` is what makes the first save and every later one the same code path: replace the document if it
    // is there, insert it if it is not. Without it a fresh installation would need a separate "create" branch that
    // ran exactly once in the life of the system and was therefore never tested.
    val _ = collection.replaceOne(
      Filters.eq("_id", MongoSettingsRepository.ObsAudioId),
      document,
      new ReplaceOptions().upsert(true)
    )
    settings
  }

  override def loadTwitch(): TwitchSettings =
    Option(collection.find(Filters.eq("_id", MongoSettingsRepository.TwitchId)).first())
      .map(BsonCodecs.twitchSettingsFromDocument)
      .getOrElse(TwitchSettings.Default)

  override def saveTwitch(settings: TwitchSettings): TwitchSettings = {
    val document = BsonCodecs
      .twitchSettingsToDocument(settings)
      .append("_id", MongoSettingsRepository.TwitchId)

    // The same upsert-always shape as the OBS document, and a *separate* document on purpose: the supervisor rewrites
    // this one when it rotates tokens, and sharing a document with obs-audio would let that background write race an
    // operator's save and silently undo it.
    val _ = collection.replaceOne(
      Filters.eq("_id", MongoSettingsRepository.TwitchId),
      document,
      new ReplaceOptions().upsert(true)
    )
    settings
  }

  override def updateTwitchAuth(
      accessToken: Option[String],
      refreshToken: Option[String],
      botLogin: Option[String]
  ): Unit = {
    // A `$set` on exactly the fields provided, rather than a whole-document replace: this runs from the supervisor's
    // background thread while an operator may be saving the same document, and a field-level update is atomic on the
    // server side — it cannot revert fields it does not mention, no matter how the two writes interleave.
    val sets = List(
      accessToken.map(value => Updates.set("accessToken", value)),
      refreshToken.map(value => Updates.set("refreshToken", value)),
      botLogin.map(value => Updates.set("botLogin", value))
    ).flatten
    if (sets.nonEmpty) {
      val _ = collection.updateOne(
        Filters.eq("_id", MongoSettingsRepository.TwitchId),
        Updates.combine(sets.asJava),
        new UpdateOptions().upsert(true)
      )
    }
  }

  override def loadSoundboard(): Soundboard =
    Option(collection.find(Filters.eq("_id", MongoSettingsRepository.SoundboardId)).first())
      .map(BsonCodecs.soundboardFromDocument)
      .getOrElse(Soundboard.Empty)

  override def saveSoundboard(soundboard: Soundboard): Soundboard = {
    val document = BsonCodecs
      .soundboardToDocument(soundboard)
      .append("_id", MongoSettingsRepository.SoundboardId)

    // The same upsert-always shape as the two documents above, and again a document of its own: the soundboard is
    // written by exactly one form in the admin UI, and sharing a document with either neighbour would let their
    // writers race it.
    val _ = collection.replaceOne(
      Filters.eq("_id", MongoSettingsRepository.SoundboardId),
      document,
      new ReplaceOptions().upsert(true)
    )
    soundboard
  }
}

object MongoSettingsRepository {

  /** The fixed key of the OBS audio settings document.
    *
    * A readable string rather than a generated ObjectId, so that anyone looking at the database with `mongosh` or
    * mongo-express can see what they are looking at without cross-referencing anything.
    */
  val ObsAudioId = "obs-audio"

  /** The fixed key of the Twitch chat settings document, sitting beside the OBS one in the same collection. */
  val TwitchId = "twitch"

  /** The fixed key of the soundboard document, third in the same collection. */
  val SoundboardId = "soundboard"
}
