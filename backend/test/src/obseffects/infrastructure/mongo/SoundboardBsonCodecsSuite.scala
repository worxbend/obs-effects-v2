package obseffects.infrastructure.mongo

import munit.FunSuite
import obseffects.domain.{GroupOp, Soundboard, SoundboardCondition, SoundboardRule}
import org.bson.Document

/** The stored shape of the soundboard document, the leniency rules for reading one back, and the read migration from
  * the v1 flat `trigger`/`pattern` rule shape to the v2 condition tree.
  */
class SoundboardBsonCodecsSuite extends FunSuite {

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
          children = List(
            SoundboardCondition.Regex("\\bhype\\b"),
            SoundboardCondition.Group(
              op = GroupOp.And,
              negate = false,
              children = List(SoundboardCondition.Emote(""), SoundboardCondition.User("worxbend"))
            )
          )
        ),
        sound = "airhorn",
        enabled = false
      )
    )
  )

  test("a soundboard survives the round trip through a document, order and nested conditions included") {
    assertEquals(BsonCodecs.soundboardFromDocument(BsonCodecs.soundboardToDocument(board)), board)
  }

  test("a document without a rules field reads as an empty soundboard") {
    assertEquals(BsonCodecs.soundboardFromDocument(new Document()), Soundboard.Empty)
  }

  test("a stored condition document mirrors the JSON wire shape — type discriminator plus that type's fields") {
    val document = BsonCodecs.soundboardToDocument(board)
    val condition = document.getList("rules", classOf[Document]).get(1).get("condition", classOf[Document])
    assertEquals(condition.getString("type"), "group")
    assertEquals(condition.getString("op"), "or")
    assertEquals(condition.getBoolean("negate"), java.lang.Boolean.TRUE)
    val firstChild = condition.getList("children", classOf[Document]).get(0)
    assertEquals(firstChild.getString("type"), "regex")
    assertEquals(firstChild.getString("value"), "\\bhype\\b")
  }

  test("a stored rule with an unrecognised condition type is dropped rather than guessed at") {
    val document = BsonCodecs.soundboardToDocument(board)
    val rules = document.getList("rules", classOf[Document])
    val _ = rules.get(0).get("condition", classOf[Document]).append("type", "shout")
    assertEquals(BsonCodecs.soundboardFromDocument(document).rules.map(_.id), List("12345678"))
  }

  test("a v1 rule document — flat trigger and pattern, no condition — is migrated on read to a condition leaf") {
    val v1 = new Document().append(
      "rules",
      java.util.List.of(
        new Document()
          .append("id", "0badcafe")
          .append("label", "Drum")
          .append("trigger", "command")
          .append("pattern", "!drum")
          .append("sound", "drum")
          .append("enabled", java.lang.Boolean.TRUE),
        new Document()
          .append("id", "12345678")
          .append("label", "Hype")
          .append("trigger", "regex")
          .append("pattern", "\\bhype\\b")
          .append("sound", "airhorn")
          .append("enabled", java.lang.Boolean.FALSE)
      )
    )
    assertEquals(
      BsonCodecs.soundboardFromDocument(v1),
      Soundboard(
        List(
          SoundboardRule("0badcafe", "Drum", SoundboardCondition.Command("!drum"), "drum", enabled = true),
          SoundboardRule("12345678", "Hype", SoundboardCondition.Regex("\\bhype\\b"), "airhorn", enabled = false)
        )
      )
    )
  }

  test("a migrated board writes back in the v2 shape — the flat trigger and pattern fields are gone") {
    val v1 = new Document().append(
      "rules",
      java.util.List.of(
        new Document()
          .append("id", "0badcafe")
          .append("label", "Drum")
          .append("trigger", "command")
          .append("pattern", "!drum")
          .append("sound", "drum")
          .append("enabled", java.lang.Boolean.TRUE)
      )
    )
    val rewritten = BsonCodecs.soundboardToDocument(BsonCodecs.soundboardFromDocument(v1))
    val stored = rewritten.getList("rules", classOf[Document]).get(0)
    assertEquals(stored.getString("trigger"), null)
    assertEquals(stored.getString("pattern"), null)
    assertEquals(stored.get("condition", classOf[Document]).getString("type"), "command")
    assertEquals(stored.get("condition", classOf[Document]).getString("value"), "!drum")
  }

  test("a v1 rule with an unrecognised trigger is dropped rather than guessed at, same as an unknown condition type") {
    val v1 = new Document().append(
      "rules",
      java.util.List.of(
        new Document().append("id", "0badcafe").append("trigger", "shout").append("pattern", "!x")
      )
    )
    assertEquals(BsonCodecs.soundboardFromDocument(v1), Soundboard.Empty)
  }

  test("a group with ONE unreadable child drops the whole rule — the survivors must not weaken an `and`") {
    val document = BsonCodecs.soundboardToDocument(board)
    val group = document.getList("rules", classOf[Document]).get(1).get("condition", classOf[Document])
    val nested = group.getList("children", classOf[Document]).get(1)
    // Corrupt one leaf of the nested and-group; its sibling (`user`) still reads fine. Keeping the group with the
    // readable child alone would fire the sound on a broader condition than the one that was saved.
    val _ = nested.getList("children", classOf[Document]).get(0).append("type", "shout")
    assertEquals(BsonCodecs.soundboardFromDocument(document).rules.map(_.id), List("0badcafe"))
  }

  test("a group whose op is unrecognised or whose children all fail to read drops the rule") {
    val document = BsonCodecs.soundboardToDocument(board)
    val group = document.getList("rules", classOf[Document]).get(1).get("condition", classOf[Document])
    val _ = group.append("op", "xor")
    assertEquals(BsonCodecs.soundboardFromDocument(document).rules.map(_.id), List("0badcafe"))
  }
}
