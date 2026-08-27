package obseffects.domain

/** A tiny, library-independent description of "any JSON value".
  *
  * Why does this exist when circe already has a `Json` type? Because the domain layer of this project is deliberately
  * free of framework types: it must not know that JSON happens to be produced by circe or that documents happen to be
  * stored in MongoDB. Effect parameters really can hold any JSON value (a number, a colour string, a boolean, ...), so
  * the domain needs *some* way to talk about them. `JsonValue` is that way, and the infrastructure layer translates
  * between it and circe's `Json` (see `obseffects.infrastructure.json.JsonCodecs`).
  */
sealed trait JsonValue

object JsonValue {

  case object JsonNull extends JsonValue
  final case class JsonBool(value: Boolean) extends JsonValue

  /** JSON has a single numeric type; we keep it as a `Double`, which is what effect parameters (speeds, opacities,
    * sizes) actually need.
    */
  final case class JsonNumber(value: Double) extends JsonValue
  final case class JsonString(value: String) extends JsonValue
  final case class JsonArray(values: List[JsonValue]) extends JsonValue
  final case class JsonObject(fields: Map[String, JsonValue]) extends JsonValue

  /** Renders a value the way it would look in JSON. Used only for human-readable error messages, never for real
    * serialisation — the real serialisation lives in the infrastructure layer.
    */
  def describe(value: JsonValue): String = value match {
    case JsonNull          => "null"
    case JsonBool(b)       => b.toString
    case JsonNumber(n)     => if (n == n.floor && n.abs < 1e15) n.toLong.toString else n.toString
    case JsonString(s)     => s""""$s""""
    case JsonArray(items)  => items.map(describe).mkString("[", ", ", "]")
    case JsonObject(items) => items.map((k, v) => s""""$k": ${describe(v)}""").mkString("{", ", ", "}")
  }

  /** The name of the JSON type, for messages such as "expected number, got string". */
  def typeName(value: JsonValue): String = value match {
    case JsonNull      => "null"
    case _: JsonBool   => "boolean"
    case _: JsonNumber => "number"
    case _: JsonString => "string"
    case _: JsonArray  => "array"
    case _: JsonObject => "object"
  }
}
