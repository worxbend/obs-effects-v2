package obseffects.infrastructure.json

// `JsonObject` exists in both circe and the domain, so circe's is renamed on import to keep the
// two apart at a glance.
import io.circe.{Decoder, Encoder, Json, JsonObject as CirceJsonObject}
import obseffects.domain.JsonValue
import obseffects.domain.JsonValue.*

/** Translation between circe's `Json` (the JSON library the HTTP layer uses) and the domain's own `JsonValue`.
  *
  * The domain models effect parameter values as `JsonValue` so it does not have to depend on circe; this object is the
  * one place where the two representations meet.
  */
object JsonValueCodec {

  /** circe `Json` -> domain `JsonValue`. Total: every JSON value has a representation. */
  def fromCirce(json: Json): JsonValue =
    json.fold(
      jsonNull = JsonNull,
      jsonBoolean = b => JsonBool(b),
      jsonNumber = n => JsonNumber(n.toDouble),
      jsonString = s => JsonString(s),
      jsonArray = values => JsonArray(values.map(fromCirce).toList),
      jsonObject = obj => JsonObject(obj.toMap.map((key, value) => key -> fromCirce(value)))
    )

  /** Domain `JsonValue` -> circe `Json`. */
  def toCirce(value: JsonValue): Json = value match {
    case JsonNull          => Json.Null
    case JsonBool(b)       => Json.fromBoolean(b)
    case JsonNumber(n)     => Json.fromDoubleOrNull(n)
    case JsonString(s)     => Json.fromString(s)
    case JsonArray(items)  => Json.fromValues(items.map(toCirce))
    case JsonObject(items) => Json.fromJsonObject(CirceJsonObject.fromMap(items.map((k, v) => k -> toCirce(v))))
  }

  given Decoder[JsonValue] = Decoder.decodeJson.map(fromCirce)
  given Encoder[JsonValue] = Encoder.instance(toCirce)
}
