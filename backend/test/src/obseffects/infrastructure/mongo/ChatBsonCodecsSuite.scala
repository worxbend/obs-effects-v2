package obseffects.infrastructure.mongo

import munit.FunSuite
import obseffects.Fixtures
import obseffects.domain.JsonValue.JsonNumber
import obseffects.domain.{ChatEventKind, ChatPart, TwitchSettings}
import org.bson.Document

/** What the `settings` document for Twitch and the `chatMessages` collection hold, and — the part that earns the suite
  * — what happens when a stored document is older or stranger than the code reading it. Like `BsonCodecsSuite`, no
  * MongoDB server is involved: `org.bson.Document` is an in-memory map, so the conversions are exercised directly.
  */
class ChatBsonCodecsSuite extends FunSuite {

  private val settings = TwitchSettings(
    enabled = true,
    channel = "worxbend",
    clientId = "client-1",
    clientSecret = Some("shhh"),
    accessToken = Some("access-1"),
    refreshToken = Some("refresh-1"),
    botLogin = Some("botty")
  )

  test("twitch settings round-trip through a document unchanged") {
    val document = BsonCodecs.twitchSettingsToDocument(settings)
    assertEquals(BsonCodecs.twitchSettingsFromDocument(document), settings)
  }

  test("absent secrets are left out of the settings document entirely rather than stored as null") {
    val document = BsonCodecs.twitchSettingsToDocument(TwitchSettings.Default)

    assert(!document.containsKey("clientSecret"), s"clientSecret should be absent, but the document is $document")
    assert(!document.containsKey("accessToken"), s"accessToken should be absent, but the document is $document")
    assert(!document.containsKey("refreshToken"), s"refreshToken should be absent, but the document is $document")
  }

  test("an empty settings document loads as the defaults, so an older build's document cannot stop the server") {
    assertEquals(BsonCodecs.twitchSettingsFromDocument(new Document()), TwitchSettings.Default)
  }

  test("the moderation fields round-trip: the two ids and the scope list") {
    val moderating = settings.copy(
      broadcasterId = Some("12345"),
      botUserId = Some("67890"),
      scopes = List("chat:read", "moderator:manage:banned_users")
    )

    val document = BsonCodecs.twitchSettingsToDocument(moderating)

    assertEquals(BsonCodecs.twitchSettingsFromDocument(document), moderating)
  }

  test("a document written before the moderation fields existed still reads, with them absent") {
    // Exactly what the previous build wrote: no broadcasterId, no botUserId, no scopes. The moderation dashboard
    // treats all three as "not looked up yet" and asks Twitch, rather than the settings document failing to load and
    // taking the whole Twitch integration down with it.
    val older = BsonCodecs.twitchSettingsToDocument(settings)
    assert(!older.containsKey("broadcasterId"), s"the fixture should not carry one, but the document is $older")
    assert(!older.containsKey("botUserId"), s"the fixture should not carry one, but the document is $older")
    assert(!older.containsKey("scopes"), s"an empty scope list is stored as nothing at all, but got $older")

    val read = BsonCodecs.twitchSettingsFromDocument(older)

    assertEquals(read.broadcasterId, None)
    assertEquals(read.botUserId, None)
    assertEquals(read.scopes, Nil)
    assertEquals(read.channel, "worxbend")
  }

  test("a chat message round-trips through a document, parts and event data included") {
    val message = Fixtures.chatMessage(
      event = ChatEventKind.Cheer,
      parts = List(
        ChatPart.Text("nice "),
        ChatPart.Image("Kappa", "https://cdn/static", Some("https://cdn/animated"))
      ),
      data = Map("bits" -> JsonNumber(250.0))
    )

    val document = BsonCodecs.chatMessageToDocument(message)
    assertEquals(BsonCodecs.chatMessageFromDocument(document), message)
  }

  test("the message id is stored as the _id, so a replayed message cannot be stored twice") {
    val document = BsonCodecs.chatMessageToDocument(Fixtures.chatMessage(id = "twitch-id-1"))
    assertEquals(document.getString("_id"), "twitch-id-1")
  }

  test("an unknown stored event kind loads as ordinary chat rather than failing the whole history query") {
    val document = BsonCodecs.chatMessageToDocument(Fixtures.chatMessage()).append("event", "hype_train")
    assertEquals(BsonCodecs.chatMessageFromDocument(document).event, ChatEventKind.Chat)
  }

  test("a part with an unknown type degrades to text so future-build documents still render as words") {
    val part = BsonCodecs.chatPartFromDocument(new Document().append("type", "sticker").append("text", "hi"))
    assertEquals(part, ChatPart.Text("hi"))
  }
}
