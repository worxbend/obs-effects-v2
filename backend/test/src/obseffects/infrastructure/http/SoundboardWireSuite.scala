package obseffects.infrastructure.http

import io.circe.parser.decode
import io.circe.syntax.*
import munit.FunSuite
import obseffects.domain.{GroupOp, Soundboard, SoundboardCondition, SoundboardRule}
import obseffects.infrastructure.http.Wire.given

/** Checks the exact JSON the soundboard endpoints speak, in the same spirit as `SoundWireSuite`: the admin UI and the
  * `soundboard` overlay effect are written against these bytes, not against the Scala types.
  */
class SoundboardWireSuite extends FunSuite {

  private val board = Soundboard(
    List(
      SoundboardRule(
        id = "0badcafe",
        label = "Drum",
        condition = SoundboardCondition.Command("!drum"),
        sound = "drum",
        enabled = true
      ),
      SoundboardRule(
        id = "12345678",
        label = "Hype",
        condition = SoundboardCondition.Group(
          op = GroupOp.Or,
          negate = true,
          children = List(SoundboardCondition.Regex("\\bhype\\b"), SoundboardCondition.Emote(""))
        ),
        sound = "airhorn",
        enabled = false
      )
    )
  )

  test("a soundboard is serialised with the field names and condition type words from the contract") {
    val json = Wire.toDto(board).asJson
    val first = json.hcursor.downField("rules").downArray
    assertEquals(first.get[String]("id"), Right("0badcafe"))
    assertEquals(first.get[String]("label"), Right("Drum"))
    assertEquals(first.downField("condition").get[String]("type"), Right("command"))
    assertEquals(first.downField("condition").get[String]("value"), Right("!drum"))
    assertEquals(first.get[String]("sound"), Right("drum"))
    assertEquals(first.get[Boolean]("enabled"), Right(true))
  }

  test("a group node carries op, negate and children, and its leaves recurse with the same tagged shape") {
    val condition = Wire.toDto(board).asJson.hcursor.downField("rules").downArray.right.downField("condition")
    assertEquals(condition.get[String]("type"), Right("group"))
    assertEquals(condition.get[String]("op"), Right("or"))
    assertEquals(condition.get[Boolean]("negate"), Right(true))
    val firstChild = condition.downField("children").downArray
    assertEquals(firstChild.get[String]("type"), Right("regex"))
    assertEquals(firstChild.get[String]("value"), Right("\\bhype\\b"))
    assertEquals(firstChild.right.get[String]("type"), Right("emote"))
    // The "any emote" leaf keeps its empty value on the wire — an empty string is data here, not an absence.
    assertEquals(firstChild.right.get[String]("value"), Right(""))
  }

  test("a leaf node serialises without group-only fields, and a group without a value") {
    val json = Wire.toDto(board).asJson
    val rules = json.hcursor.downField("rules")
    val leafKeys = rules.downArray.downField("condition").keys.map(_.toList)
    assertEquals(leafKeys, Some(List("type", "value")))
    val groupKeys = rules.downArray.right.downField("condition").keys.map(_.toList)
    assertEquals(groupKeys, Some(List("type", "op", "negate", "children")))
  }

  test("a serialised soundboard decodes back to an equal DTO, tree included") {
    val dto = Wire.toDto(board)
    assertEquals(decode[Wire.SoundboardDto](dto.asJson.noSpaces), Right(dto))
  }

  test("the soundboard is an object with a `rules` array, not a bare array") {
    val json = Wire.toDto(Soundboard(Nil)).asJson
    assertEquals(json.hcursor.downField("rules").as[List[Wire.SoundboardRuleDto]], Right(Nil))
  }

  test("a request rule without an id decodes with `id` absent, so a fresh rule needs no placeholder") {
    val decoded = decode[Wire.SoundboardRuleRequestDto](
      """{"label":"Drum","condition":{"type":"command","value":"!drum"},"sound":"drum","enabled":true}"""
    )
    assertEquals(decoded.map(_.id), Right(None))
  }

  test("a request round-trips to the raw model with type and op left as wire strings for the validator") {
    val decoded = decode[Wire.SoundboardRequestDto](
      """{"rules":[{"id":"0badcafe","label":"Drum","condition":
        {"type":"group","op":"xor","children":[{"type":"shout","value":"!drum"}]},
        "sound":"drum","enabled":true}]}"""
    ).getOrElse(fail("the request should decode"))
    val raw = Wire.toRaw(decoded)
    val condition = raw.rules.head.condition
    assertEquals(raw.rules.map(_.id), List(Some("0badcafe")))
    // Unknown type and op words must survive decoding so the validator can answer 422 naming the field, not 400.
    assertEquals(condition.op, Some("xor"))
    assertEquals(condition.children.map(_.map(_.`type`)), Some(List("shout")))
    // A group node sent without `negate` reads as an absence, which the validator treats as false.
    assertEquals(condition.negate, None)
  }

  test("a pathologically deep condition tree is refused by the decoder instead of overflowing the stack") {
    // 100 nested single-child groups — far past the validator's limit of 5, and past the decoder's own hard cap of
    // 32. The decoder recurses once per level, so without the cap this payload would throw StackOverflowError (a 500)
    // before validation ever ran; with it, decoding fails like any other malformed body.
    val depth = 100
    val condition =
      ("""{"type":"group","op":"and","children":[""" * depth) + """{"type":"command","value":"!drum"}""" +
        ("]}" * depth)
    val decoded = decode[Wire.SoundboardRuleRequestDto](
      s"""{"label":"Deep","condition":$condition,"sound":"drum","enabled":true}"""
    )
    assert(decoded.isLeft, "a 100-deep condition tree must fail to decode")
    assert(decoded.left.exists(_.getMessage.contains("nest at most")), s"unexpected error: $decoded")
  }
}
