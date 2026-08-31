package obseffects.infrastructure.http

import io.circe.parser.parse
import io.circe.syntax.*
import munit.FunSuite
import obseffects.Fixtures
import obseffects.application.{AppError, BulkOutcome, BulkResult, TwitchAdminStatus, TwitchBan, TwitchBanPage}
import obseffects.domain.JsonValue.JsonNumber
import obseffects.domain.{ChatEventKind, ChatPart, TwitchConnectionState, TwitchConnectionStatus, TwitchSettings}
import obseffects.infrastructure.http.Wire.given

import java.time.Instant

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
      Some(Set("enabled", "channel", "clientId", "clientSecretSet", "tokensSet", "botLogin", "scopes"))
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

  test("the moderation status carries the ids and scope names, which are labels rather than credentials") {
    val status = TwitchAdminStatus(
      available = false,
      channel = "worxbend",
      broadcasterId = Some("777"),
      moderatorLogin = Some("botty"),
      grantedScopes = List("chat:read"),
      missingScopes = List("moderator:manage:banned_users"),
      reason = Some("No Twitch account is connected — connect one in Settings.")
    )

    val json = Wire.toDto(status).asJson

    assertEquals(json.hcursor.get[Boolean]("available"), Right(false))
    assertEquals(json.hcursor.get[String]("broadcasterId"), Right("777"))
    assertEquals(json.hcursor.get[List[String]]("missingScopes"), Right(List("moderator:manage:banned_users")))
    assert(json.hcursor.get[String]("reason").exists(_.contains("connect one")), s"got $json")
  }

  test("a ban entry sends ISO-8601 instants, and a permanent ban's expiry as null rather than an empty string") {
    val permanent = TwitchBan(
      userId = "1",
      login = "alice",
      displayName = "Alice",
      reason = Some("spam"),
      moderatorLogin = Some("botty"),
      createdAt = Some(Instant.parse("2026-08-27T10:00:00Z")),
      expiresAt = None
    )

    val json = Wire.toDto(permanent).asJson

    assertEquals(json.hcursor.get[String]("createdAt"), Right("2026-08-27T10:00:00.000Z"))
    assertEquals(json.hcursor.get[Option[String]]("expiresAt"), Right(None))
    assertEquals(json.hcursor.get[String]("displayName"), Right("Alice"))
  }

  test("a ban page's cursor is null on the last page, so a client stops rather than looping") {
    val page = TwitchBanPage(Nil, None)
    assertEquals(Wire.toDto(page).asJson.hcursor.get[Option[String]]("cursor"), Right(None))

    val more = TwitchBanPage(Nil, Some("page-2"))
    assertEquals(Wire.toDto(more).asJson.hcursor.get[String]("cursor"), Right("page-2"))
  }

  test("a bulk result reports counts and every outcome, so a partial success reads as one") {
    val result = BulkResult(
      succeeded = 1,
      failed = 1,
      outcomes = List(
        BulkOutcome("alice", ok = true, None),
        BulkOutcome("bob", ok = false, Some("already banned"))
      )
    )

    val json = Wire.toDto(result).asJson

    assertEquals(json.hcursor.get[Int]("succeeded"), Right(1))
    assertEquals(json.hcursor.get[Int]("failed"), Right(1))
    assertEquals(json.hcursor.downField("outcomes").downN(1).get[String]("message"), Right("already banned"))
  }

  test("a bulk ban request decodes with an absent duration as a permanent ban") {
    val decoded = parse("""{"users":["alice","bob"]}""").flatMap(_.as[Wire.TwitchBanRequestDto])

    assertEquals(decoded.map(_.users), Right(List("alice", "bob")))
    assertEquals(decoded.map(_.durationSeconds), Right(None))
  }

  test("an unban request decodes rows and logins, and either list may be left out entirely") {
    val both = parse("""{"users":["alice"],"targets":[{"userId":"2","login":"bob"}]}""")
      .flatMap(_.as[Wire.TwitchUnbanRequestDto])
    // What a client written before the ban list sent ids looks like — it must keep working unchanged.
    val loginsOnly = parse("""{"users":["alice"]}""").flatMap(_.as[Wire.TwitchUnbanRequestDto])
    val rowsOnly = parse("""{"targets":[{"userId":"2","login":"bob"}]}""")
      .flatMap(_.as[Wire.TwitchUnbanRequestDto])

    assertEquals(both.map(_.targets), Right(List(Wire.TwitchUnbanTargetDto("2", "bob"))))
    assertEquals(loginsOnly.map(_.targets), Right(Nil))
    assertEquals(rowsOnly.map(_.users), Right(Nil))
    assertEquals(rowsOnly.map(_.targets.map(_.login)), Right(List("bob")))
  }

  test("TWITCH_UNAVAILABLE is a 409 whose message is the whole explanation, and it round-trips") {
    val error = AppError.TwitchUnavailable("No Twitch channel is configured — set one in Settings.")

    val (status, envelope, retryAfter) = ErrorMapping.toWire(error)

    assertEquals(status.code, 409)
    assertEquals(envelope.error.code, "TWITCH_UNAVAILABLE")
    assertEquals(envelope.error.details, None)
    assertEquals(retryAfter, None)
    assertEquals(ErrorMapping.fromWire(ErrorMapping.toWire(error)), error)
  }
}
