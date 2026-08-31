package obseffects.infrastructure.mongo

import obseffects.domain.*
import obseffects.domain.JsonValue.*
import org.bson.Document

import java.time.Instant
import java.util.Date

import scala.jdk.CollectionConverters.*

/** Conversions between the domain models and MongoDB's `Document` type.
  *
  * A `Document` is essentially a `Map[String, Any]` where the values are Java types (`String`, `java.lang.Double`,
  * `java.util.Date`, nested `Document`s, `java.util.List`s). Everything here is hand-written rather than derived, which
  * is verbose but keeps the stored shape explicit: if you want to know what is in the database, you read this file.
  *
  * Reading is deliberately strict. A document that does not match the expected shape means the database has been
  * corrupted or hand-edited; that is not something a request can recover from, so it throws and the HTTP layer turns it
  * into a 500.
  */
private[infrastructure] object BsonCodecs {

  // -------------------------------------------------------------------------------------------
  // JSON parameter values
  // -------------------------------------------------------------------------------------------

  /** Domain value -> the Java value MongoDB stores. `null` is intentional here: it is how BSON represents JSON's
    * `null`.
    */
  def jsonToBson(value: JsonValue): Any = value match {
    case JsonNull          => null
    case JsonBool(b)       => java.lang.Boolean.valueOf(b)
    case JsonNumber(n)     => java.lang.Double.valueOf(n)
    case JsonString(s)     => s
    case JsonArray(items)  => items.map(jsonToBson).asJava
    case JsonObject(items) => new Document(items.map((key, item) => key -> jsonToBson(item)).asJava)
  }

  /** The Java value MongoDB returns -> domain value. */
  def bsonToJson(value: Any): JsonValue = value match {
    case null                     => JsonNull
    case b: java.lang.Boolean     => JsonBool(b.booleanValue())
    case n: java.lang.Number      => JsonNumber(n.doubleValue())
    case s: String                => JsonString(s)
    case document: Document       => JsonObject(document.asScala.toMap.map((key, item) => key -> bsonToJson(item)))
    case items: java.util.List[?] => JsonArray(items.asScala.toList.map(bsonToJson))
    case other                    =>
      throw new IllegalStateException(s"Cannot read a ${other.getClass.getName} as a JSON value")
  }

  // -------------------------------------------------------------------------------------------
  // Effect descriptors — collection `effects`, `_id` is the effect id string
  // -------------------------------------------------------------------------------------------

  def paramSpecToDocument(spec: ParamSpec): Document = {
    val document = new Document()
      .append("key", spec.key.value)
      .append("label", spec.label)
      .append("kind", spec.kind.wireName)
      .append("default", jsonToBson(spec.default))
      .append("description", spec.description)

    // Optional fields are left out of the document entirely rather than stored as null, mirroring
    // how they are omitted from JSON.
    spec.min.foreach(min => document.append("min", java.lang.Double.valueOf(min)))
    spec.max.foreach(max => document.append("max", java.lang.Double.valueOf(max)))
    spec.step.foreach(step => document.append("step", java.lang.Double.valueOf(step)))
    spec.options.foreach(options => document.append("options", options.asJava))
    document
  }

  def paramSpecFromDocument(document: Document): ParamSpec =
    ParamSpec(
      key = ParamKey.unsafe(requireString(document, "key")),
      label = requireString(document, "label"),
      kind = ParamKind
        .fromWire(requireString(document, "kind"))
        .getOrElse(
          throw new IllegalStateException(s"Stored parameter kind '${document.getString("kind")}' is unknown")
        ),
      default = bsonToJson(document.get("default")),
      min = optionalDouble(document, "min"),
      max = optionalDouble(document, "max"),
      step = optionalDouble(document, "step"),
      options = Option(document.get("options")).map(readStringList),
      description = requireString(document, "description")
    )

  def descriptorToDocument(descriptor: EffectDescriptor): Document =
    new Document()
      .append("_id", descriptor.id.value)
      .append("name", descriptor.name)
      .append("description", descriptor.description)
      .append("engine", descriptor.engine.wireName)
      .append("category", descriptor.category)
      .append("tags", descriptor.tags.asJava)
      .append("previewNotes", descriptor.previewNotes)
      .append("params", descriptor.params.map(paramSpecToDocument).asJava)

  def descriptorFromDocument(document: Document): EffectDescriptor =
    EffectDescriptor(
      id = EffectId.unsafe(requireString(document, "_id")),
      name = requireString(document, "name"),
      description = requireString(document, "description"),
      engine = Engine
        .fromWire(requireString(document, "engine"))
        .getOrElse(throw new IllegalStateException(s"Stored engine '${document.getString("engine")}' is unknown")),
      category = requireString(document, "category"),
      tags = readStringList(document.get("tags")),
      previewNotes = requireString(document, "previewNotes"),
      params = readDocumentList(document.get("params")).map(paramSpecFromDocument)
    )

  // -------------------------------------------------------------------------------------------
  // Routes — collection `routes`, `_id` is a MongoDB ObjectId
  // -------------------------------------------------------------------------------------------

  /** The fields of a route that a client controls. The `_id` and `createdAt` are added by the repository, which owns
    * them.
    */
  def routeInputToDocument(input: RouteInput, createdAt: Instant, updatedAt: Instant): Document =
    new Document()
      .append("slug", input.slug.value)
      .append("effectId", input.effectId.value)
      .append("enabled", java.lang.Boolean.valueOf(input.enabled))
      .append("params", new Document(input.params.map((key, value) => key.value -> jsonToBson(value)).asJava))
      .append("canvas", canvasToDocument(input.canvas))
      .append("createdAt", Date.from(createdAt))
      .append("updatedAt", Date.from(updatedAt))

  /** The `canvas` sub-document.
    *
    * `fpsCap` is left out entirely when the route is uncapped, rather than stored as `null` — the same "optional fields
    * are omitted" style the rest of the stored shape uses. The JSON *response* does send `"fpsCap": null`, and the two
    * differ on purpose: JSON has to distinguish "uncapped" from "this field does not exist in your build", while a BSON
    * document is only ever read by the function below, which knows what a missing key means.
    *
    * The numbers are written as BSON 32-bit integers. Storing them as doubles would work, but it would leave the
    * database holding `1920.0` for a field the contract calls an integer, and anything reading the collection directly
    * — mongo-express, a future export script — would have to know to round.
    */
  def canvasToDocument(canvas: CanvasSettings): Document = {
    val document = new Document()
      .append("width", java.lang.Integer.valueOf(canvas.width))
      .append("height", java.lang.Integer.valueOf(canvas.height))
    canvas.fpsCap.foreach(cap => document.append("fpsCap", java.lang.Integer.valueOf(cap)))
    document
  }

  /** Reads the `canvas` sub-document, substituting a default for anything that is not there.
    *
    * **This is what makes documents written before the canvas existed keep working**, and it is a deliberate design
    * choice rather than a leftover. `docs/CONTRACT.md` §6 spells out the reasoning: defaulting on read is one branch in
    * one function, it is idempotent, and it keeps working forever — including for a database restored from a backup
    * taken before this field existed. A one-shot migration script would be a thing somebody has to run exactly once, on
    * a machine this project assumes has no MongoDB tooling installed. Stored documents converge on their own, because
    * the next save of a route rewrites the whole document.
    *
    * Nothing ever writes a partial `canvas`, so in practice this sees only "the whole thing is missing" and "it is
    * complete" — but it defaults key by key anyway, because a hand-edited document should load rather than crash.
    */
  def canvasFromDocument(document: Document): CanvasSettings =
    Option(document.get("canvas", classOf[Document])) match {
      case None         => CanvasSettings.Default
      case Some(canvas) =>
        CanvasSettings(
          width = optionalInt(canvas, "width").getOrElse(CanvasSettings.DefaultWidth),
          height = optionalInt(canvas, "height").getOrElse(CanvasSettings.DefaultHeight),
          fpsCap = optionalInt(canvas, "fpsCap")
        )
    }

  def routeFromDocument(document: Document): RouteConfig =
    RouteConfig(
      id = RouteId.unsafe(document.getObjectId("_id").toHexString),
      slug = Slug.unsafe(requireString(document, "slug")),
      effectId = EffectId.unsafe(requireString(document, "effectId")),
      enabled = document.getBoolean("enabled", false),
      params = Option(document.get("params", classOf[Document]))
        .map(_.asScala.toMap.map((key, value) => ParamKey.unsafe(key) -> bsonToJson(value)))
        .getOrElse(Map.empty),
      canvas = canvasFromDocument(document),
      createdAt = requireDate(document, "createdAt"),
      updatedAt = requireDate(document, "updatedAt")
    )

  // -------------------------------------------------------------------------------------------
  // Presets — collection `presets`, `_id` is a MongoDB ObjectId
  // -------------------------------------------------------------------------------------------

  /** The fields of a preset that a client controls; `_id` and `createdAt` belong to the repository.
    *
    * The stored `name` is the already-trimmed one that came out of validation. Nothing lower-cases it: the index that
    * makes the name unique carries a case-insensitive collation, so "Neon" and "neon" collide without a second copy of
    * the name being kept anywhere.
    */
  def presetInputToDocument(input: PresetInput, createdAt: Instant, updatedAt: Instant): Document =
    new Document()
      .append("name", input.name)
      .append("effectId", input.effectId.value)
      .append("params", new Document(input.params.map((key, value) => key.value -> jsonToBson(value)).asJava))
      .append("createdAt", Date.from(createdAt))
      .append("updatedAt", Date.from(updatedAt))

  def presetFromDocument(document: Document): Preset =
    Preset(
      id = PresetId.unsafe(document.getObjectId("_id").toHexString),
      name = requireString(document, "name"),
      effectId = EffectId.unsafe(requireString(document, "effectId")),
      params = Option(document.get("params", classOf[Document]))
        .map(_.asScala.toMap.map((key, value) => ParamKey.unsafe(key) -> bsonToJson(value)))
        .getOrElse(Map.empty),
      createdAt = requireDate(document, "createdAt"),
      updatedAt = requireDate(document, "updatedAt")
    )

  // -------------------------------------------------------------------------------------------

  private def requireString(document: Document, field: String): String =
    Option(document.getString(field))
      .getOrElse(throw new IllegalStateException(s"Stored document is missing the string field '$field'"))

  private def requireDate(document: Document, field: String): Instant =
    Option(document.getDate(field))
      .map(_.toInstant)
      .getOrElse(throw new IllegalStateException(s"Stored document is missing the date field '$field'"))

  private def optionalDouble(document: Document, field: String): Option[Double] =
    Option(document.get(field)).collect { case n: java.lang.Number => n.doubleValue() }

  /** Reads a number that is meant to be whole. It accepts any BSON number type, not only `int32`, so a document
    * hand-edited in mongo-express — which writes `1920` as a double — still loads.
    */
  private def optionalInt(document: Document, field: String): Option[Int] =
    Option(document.get(field)).collect { case n: java.lang.Number => n.intValue() }

  // -------------------------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------------------------

  /** The OBS audio settings document.
    *
    * The password is stored as it was typed. That deserves a sentence rather than a shrug: it cannot be hashed, because
    * unlike the admin password this one is not something we *check* — it is a credential we have to *present* to
    * obs-websocket, so a one-way hash would make it useless. Anyone who can read the database can therefore read it,
    * which is the same trust boundary as `MONGO_URI` itself and the reason the API never sends it back out.
    */
  def obsAudioSettingsToDocument(settings: ObsAudioSettings): Document = {
    val document = new Document()
      .append("enabled", java.lang.Boolean.valueOf(settings.enabled))
      .append("url", settings.url)

    settings.password.foreach(value => { val _ = document.append("password", value) })
    settings.inputName.foreach(value => { val _ = document.append("inputName", value) })
    document
  }

  /** Reads the settings back, treating every field as optional.
    *
    * A document written by an older build simply has fewer keys, and every one of them falls back to the shipped
    * default rather than throwing — the settings document is the last thing that should be able to stop the server
    * booting.
    */
  def obsAudioSettingsFromDocument(document: Document): ObsAudioSettings =
    ObsAudioSettings(
      enabled = document.getBoolean("enabled", false),
      url = Option(document.getString("url")).filter(_.nonEmpty).getOrElse(ObsAudioSettings.DefaultUrl),
      password = Option(document.getString("password")).filter(_.nonEmpty),
      inputName = Option(document.getString("inputName")).filter(_.nonEmpty)
    )

  /** The Twitch chat settings document.
    *
    * The client secret and both tokens are stored as they were received, for the same present-not-check reason as the
    * obs-websocket password above: every one of them is a credential this server has to *present* to Twitch, so hashing
    * would make them useless, and the defence is the same — they never leave the server.
    */
  def twitchSettingsToDocument(settings: TwitchSettings): Document = {
    val document = new Document()
      .append("enabled", java.lang.Boolean.valueOf(settings.enabled))
      .append("channel", settings.channel)
      .append("clientId", settings.clientId)

    settings.clientSecret.foreach(value => { val _ = document.append("clientSecret", value) })
    settings.accessToken.foreach(value => { val _ = document.append("accessToken", value) })
    settings.refreshToken.foreach(value => { val _ = document.append("refreshToken", value) })
    settings.botLogin.foreach(value => { val _ = document.append("botLogin", value) })
    document
  }

  /** Reads the Twitch settings back, treating every field as optional and falling back to the shipped default — the
    * same "a settings document must never stop the server booting" rule as the OBS audio document.
    */
  def twitchSettingsFromDocument(document: Document): TwitchSettings =
    TwitchSettings(
      enabled = document.getBoolean("enabled", false),
      channel = Option(document.getString("channel")).getOrElse(""),
      clientId = Option(document.getString("clientId")).getOrElse(""),
      clientSecret = Option(document.getString("clientSecret")).filter(_.nonEmpty),
      accessToken = Option(document.getString("accessToken")).filter(_.nonEmpty),
      refreshToken = Option(document.getString("refreshToken")).filter(_.nonEmpty),
      botLogin = Option(document.getString("botLogin")).filter(_.nonEmpty)
    )

  /** The soundboard document: the whole ordered rule list, stored beside the other settings documents.
    */
  def soundboardToDocument(soundboard: Soundboard): Document =
    new Document().append("rules", soundboard.rules.map(soundboardRuleToDocument).asJava)

  def soundboardRuleToDocument(rule: SoundboardRule): Document =
    new Document()
      .append("id", rule.id)
      .append("label", rule.label)
      .append("condition", soundboardConditionToDocument(rule.condition))
      .append("sound", rule.sound)
      .append("enabled", java.lang.Boolean.valueOf(rule.enabled))

  /** One node of a rule's condition tree, stored as a document mirroring the JSON wire shape exactly — a `type`
    * discriminator plus the fields that type has — so a stored board reads the same whether one looks at Mongo or at
    * `GET /api/soundboard`.
    */
  def soundboardConditionToDocument(condition: SoundboardCondition): Document = condition match {
    case SoundboardCondition.Group(op, negate, children) =>
      new Document()
        .append("type", "group")
        .append("op", op.wireName)
        .append("negate", java.lang.Boolean.valueOf(negate))
        .append("children", children.map(soundboardConditionToDocument).asJava)
    case SoundboardCondition.Command(value)  => leafConditionDocument("command", value)
    case SoundboardCondition.Contains(value) => leafConditionDocument("contains", value)
    case SoundboardCondition.Regex(value)    => leafConditionDocument("regex", value)
    case SoundboardCondition.Emote(value)    => leafConditionDocument("emote", value)
    case SoundboardCondition.Emoji(value)    => leafConditionDocument("emoji", value)
    case SoundboardCondition.Event(value)    => leafConditionDocument("event", value)
    case SoundboardCondition.User(value)     => leafConditionDocument("user", value)
  }

  private def leafConditionDocument(`type`: String, value: String): Document =
    new Document().append("type", `type`).append("value", value)

  /** Reads the soundboard back with the same "a settings document must never stop the server booting" leniency as the
    * OBS audio and Twitch documents: missing strings fall back to empty, and a rule whose condition cannot be
    * understood — a node `type` written by some future build, say — is dropped rather than guessed at, because firing a
    * sound on the wrong condition is worse than not firing it.
    */
  def soundboardFromDocument(document: Document): Soundboard =
    Soundboard(readDocumentList(document.get("rules")).flatMap(soundboardRuleFromDocument))

  def soundboardRuleFromDocument(document: Document): Option[SoundboardRule] =
    soundboardRuleCondition(document).map { condition =>
      SoundboardRule(
        id = Option(document.getString("id")).getOrElse(""),
        label = Option(document.getString("label")).getOrElse(""),
        condition = condition,
        sound = Option(document.getString("sound")).getOrElse(""),
        enabled = document.getBoolean("enabled", false)
      )
    }

  /** Where a stored rule's condition comes from: the v2 `condition` tree when present, and otherwise the v1 flat
    * `trigger`/`pattern` pair, migrated on read — a v1 `command` rule becomes a `Command` leaf and a v1 `regex` rule a
    * `Regex` leaf, which is exactly what those triggers meant. Writing always writes v2, so the first save after an
    * upgrade completes the migration; nothing rewrites documents behind the operator's back.
    */
  private def soundboardRuleCondition(document: Document): Option[SoundboardCondition] =
    document.get("condition") match {
      case condition: Document => soundboardConditionFromDocument(condition)
      case _                   =>
        (Option(document.getString("trigger")), Option(document.getString("pattern")).getOrElse("")) match {
          case (Some("command"), pattern) => Some(SoundboardCondition.Command(pattern))
          case (Some("regex"), pattern)   => Some(SoundboardCondition.Regex(pattern))
          case _                          => None
        }
    }

  def soundboardConditionFromDocument(document: Document): Option[SoundboardCondition] = {
    def value = Option(document.getString("value")).getOrElse("")
    Option(document.getString("type")).flatMap {
      case "group" =>
        // A group needs a recognisable op and at least one readable child to mean anything — and EVERY child must
        // read, all or nothing. Keeping only the readable children would silently weaken the group: an `and` missing
        // one condition fires on messages the stored rule never meant to match. So one unreadable child drops the
        // node (and with it the rule), the standing "dropped rather than guessed at" policy applied at every level.
        val children = readDocumentList(document.get("children")).map(soundboardConditionFromDocument)
        Option(document.getString("op"))
          .flatMap(GroupOp.fromWire)
          .filter(_ => children.nonEmpty && children.forall(_.isDefined))
          .map(op => SoundboardCondition.Group(op, document.getBoolean("negate", false), children.flatten))
      case "command"  => Some(SoundboardCondition.Command(value))
      case "contains" => Some(SoundboardCondition.Contains(value))
      case "regex"    => Some(SoundboardCondition.Regex(value))
      case "emote"    => Some(SoundboardCondition.Emote(value))
      case "emoji"    => Some(SoundboardCondition.Emoji(value))
      case "event"    => Some(SoundboardCondition.Event(value))
      case "user"     => Some(SoundboardCondition.User(value))
      case _          => None
    }
  }

  // -------------------------------------------------------------------------------------------
  // Chat messages — collection `chatMessages`, `_id` is the message id string (Twitch's, or ours)
  // -------------------------------------------------------------------------------------------

  /** One part of a chat message, discriminated by a `type` field the same way the JSON wire shape is. */
  def chatPartToDocument(part: ChatPart): Document = part match {
    case ChatPart.Text(text) =>
      new Document().append("type", "text").append("text", text)
    case ChatPart.Image(name, url, animatedUrl) =>
      val document = new Document().append("type", "image").append("name", name).append("url", url)
      animatedUrl.foreach(value => { val _ = document.append("animatedUrl", value) })
      document
  }

  /** Reads one part back. A part whose `type` is unrecognised — or an image missing its URL — degrades to a text part
    * so a history document written by some future build still renders as words rather than crashing a query.
    */
  def chatPartFromDocument(document: Document): ChatPart =
    (Option(document.getString("type")), Option(document.getString("url"))) match {
      case (Some("image"), Some(url)) =>
        ChatPart.Image(
          name = Option(document.getString("name")).getOrElse(""),
          url = url,
          animatedUrl = Option(document.getString("animatedUrl")).filter(_.nonEmpty)
        )
      case _ =>
        ChatPart.Text(Option(document.getString("text")).getOrElse(""))
    }

  def chatMessageToDocument(message: ChatMessage): Document =
    new Document()
      .append("_id", message.id)
      .append("at", java.lang.Long.valueOf(message.at))
      .append("channel", message.channel)
      .append("username", message.username)
      .append("displayName", message.displayName)
      .append("color", message.color)
      .append("seed", java.lang.Integer.valueOf(message.seed))
      .append("event", ChatEventKind.wireName(message.event))
      .append("text", message.text)
      .append("parts", message.parts.map(chatPartToDocument).asJava)
      .append("data", new Document(message.data.map((key, value) => key -> jsonToBson(value)).asJava))

  /** Reads a stored message back, leniently: every field falls back rather than throws, and an unknown event kind loads
    * as ordinary chat. History is display data — a single odd document must never break the history endpoint or the
    * snapshot that seeds the ring at start-up.
    */
  def chatMessageFromDocument(document: Document): ChatMessage = {
    val username = Option(document.getString("username")).getOrElse("")
    ChatMessage(
      id = Option(document.getString("_id")).getOrElse(""),
      at = Option(document.get("at")).collect { case n: java.lang.Number => n.longValue() }.getOrElse(0L),
      channel = Option(document.getString("channel")).getOrElse(""),
      username = username,
      displayName = Option(document.getString("displayName")).filter(_.nonEmpty).getOrElse(username),
      color = Option(document.getString("color")).filter(_.nonEmpty).getOrElse(ChatMessage.colorFor(username)),
      seed = optionalInt(document, "seed").getOrElse(ChatMessage.seedFor(username)),
      event = Option(document.getString("event")).flatMap(ChatEventKind.fromWire).getOrElse(ChatEventKind.Chat),
      text = Option(document.getString("text")).getOrElse(""),
      parts = readDocumentList(document.get("parts")).map(chatPartFromDocument),
      data = Option(document.get("data", classOf[Document]))
        .map(_.asScala.toMap.map((key, value) => key -> bsonToJson(value)))
        .getOrElse(Map.empty)
    )
  }

  private def readStringList(value: Any): List[String] = value match {
    case null                     => Nil
    case items: java.util.List[?] => items.asScala.toList.collect { case s: String => s }
    case other => throw new IllegalStateException(s"Expected a list of strings, found ${other.getClass.getName}")
  }

  private def readDocumentList(value: Any): List[Document] = value match {
    case null                     => Nil
    case items: java.util.List[?] => items.asScala.toList.collect { case document: Document => document }
    case other => throw new IllegalStateException(s"Expected a list of documents, found ${other.getClass.getName}")
  }
}
