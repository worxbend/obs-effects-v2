package obseffects.infrastructure.http

import io.circe.parser.parse
import io.circe.syntax.*
import munit.FunSuite
import obseffects.Fixtures
import obseffects.domain.JsonValue.JsonNumber
import obseffects.domain.{ChatEventKind, ChatPart, TwitchConnectionState, TwitchConnectionStatus, TwitchSettings}
import obseffects.infrastructure.http.Wire.given

/** Checks the exact chat and Twitch-settings JSON the API produces, because the frontend SDK and every ported overlay
  * are written against those bytes — the wire model in the design contract — and not against the Scala types.
  */
class TwitchWireSuite extends FunSuite {

  test("a chat message is serialised with the field names and event spelling from the contract") {
    val message = Fixtures.chatMessage(event = ChatEventKind.GiftSub, data = Map("total" -> JsonNumber(3.0)))
    val json = Wire.toDto(message).asJson

    assertEquals(json.hcursor.get[String]("id"), Right("abc-123"))
    assertEquals(json.hcursor.get[Long]("at"), Right(1724800000000L))
    assertEquals(json.hcursor.get[String]("username"), Right("somelogin"))
    assertEquals(json.hcursor.get[String]("displayName"), Right("SomeLogin"))
    assertEquals(json.hcursor.get[Int]("seed"), Right(1234567))
    assertEquals(json.hcursor.get[String]("event"), Right("gift_sub"))
    assertEquals(json.hcursor.downField("data").get[Double]("total"), Right(3.0))
  }

  test("a text part carries only its type and text; an image part omits an absent animatedUrl") {
    val text = Wire.toDto(ChatPart.Text("hello ")).asJson
    assertEquals(text.asObject.map(_.keys.toSet), Some(Set("type", "text")))

    val image = Wire.toDto(ChatPart.Image("Kappa", "https://cdn/static", None)).asJson
    assertEquals(image.asObject.map(_.keys.toSet), Some(Set("type", "name", "url")))

    val animated = Wire.toDto(ChatPart.Image("Kappa", "https://cdn/static", Some("https://cdn/animated"))).asJson
    assertEquals(animated.hcursor.get[String]("animatedUrl"), Right("https://cdn/animated"))
  }

  test("the settings view carries the two set-flags and never the secret or the tokens themselves") {
    val settings = TwitchSettings(
      enabled = true,
      channel = "worxbend",
      clientId = "client-1",
      clientSecret = Some("shhh"),
      accessToken = Some("access-1"),
      refreshToken = Some("refresh-1"),
      botLogin = Some("botty")
    )
    val json = Wire.toDto(settings).asJson

    assertEquals(json.hcursor.get[Boolean]("clientSecretSet"), Right(true))
    assertEquals(json.hcursor.get[Boolean]("tokensSet"), Right(true))
    assertEquals(
      json.asObject.map(_.keys.toSet),
      Some(Set("enabled", "channel", "clientId", "clientSecretSet", "tokensSet", "botLogin"))
    )
    assert(!json.noSpaces.contains("shhh"), "the client secret must never appear in a response")
    assert(!json.noSpaces.contains("access-1"), "the access token must never appear in a response")
  }

  test("the connection state uses the snake_case wire spellings") {
    val status = TwitchConnectionStatus(TwitchConnectionState.ConnectedAnonymous, None, 7L, Some("worxbend"))
    val json = Wire.toDto(status, subscribers = 2).asJson

    assertEquals(json.hcursor.get[String]("state"), Right("connected_anonymous"))
    assertEquals(json.hcursor.get[Long]("messagesReceived"), Right(7L))
    assertEquals(json.hcursor.get[Int]("subscribers"), Right(2))
  }

  test("a settings request without the clientSecret key leaves the stored secret alone") {
    val body = """{"enabled":true,"channel":"worxbend","clientId":"client-1"}"""
    val decoded = parse(body).flatMap(_.as[Wire.TwitchSettingsRequestDto])
    assertEquals(decoded.map(_.clientSecret), Right(None))
  }

  test("a settings request with clientSecret null asks for it to be cleared, and a string replaces it") {
    val cleared = parse("""{"enabled":true,"channel":"c","clientId":"i","clientSecret":null}""")
      .flatMap(_.as[Wire.TwitchSettingsRequestDto])
    assertEquals(cleared.map(_.clientSecret), Right(Some(None)))

    val replaced = parse("""{"enabled":true,"channel":"c","clientId":"i","clientSecret":"new"}""")
      .flatMap(_.as[Wire.TwitchSettingsRequestDto])
    assertEquals(replaced.map(_.clientSecret), Right(Some(Some("new"))))
  }

  test("a clientSecret of the wrong JSON type is a decode failure, not a silent coercion") {
    val decoded = parse("""{"enabled":true,"channel":"c","clientId":"i","clientSecret":42}""")
      .flatMap(_.as[Wire.TwitchSettingsRequestDto])
    assert(decoded.isLeft, s"expected a decode failure, got $decoded")
  }
}
