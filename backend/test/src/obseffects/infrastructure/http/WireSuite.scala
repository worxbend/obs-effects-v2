package obseffects.infrastructure.http

import io.circe.parser.parse
import io.circe.syntax.*
import munit.FunSuite
import obseffects.Fixtures
import obseffects.application.{AppError, SessionInfo}
import obseffects.domain.JsonValue.JsonNumber
import obseffects.domain.{
  BackupEnvelope,
  CanvasSettings,
  ImportResult,
  ParamKey,
  Preset,
  PresetId,
  RouteConfig,
  RouteId,
  SessionToken,
  Slug,
  ValidationIssue
}
import obseffects.infrastructure.http.Wire.given
import sttp.model.StatusCode
import sttp.model.headers.Cookie

import java.security.SecureRandom
import java.time.Instant

/** Checks the exact JSON the API produces, because the frontend is written against those bytes and not against the
  * Scala types.
  */
class WireSuite extends FunSuite {

  private val route = RouteConfig(
    id = RouteId.unsafe("66c9f0b2e1a4c3d2b1a09876"),
    slug = Slug.unsafe("main-camera"),
    effectId = Fixtures.plasmaField.id,
    enabled = true,
    params = Map(ParamKey.unsafe("speed") -> JsonNumber(2.0)),
    canvas = CanvasSettings.Default,
    createdAt = Instant.parse("2026-08-23T14:05:09.123Z"),
    updatedAt = Instant.parse("2026-08-23T14:07:41.004Z")
  )

  test("timestamps always carry exactly three fractional digits and a trailing Z") {
    assertEquals(Wire.formatInstant(Instant.parse("2026-08-23T14:05:09Z")), "2026-08-23T14:05:09.000Z")
  }

  test("a route is serialised with the field names from the contract") {
    val json = Wire.toDto(route).asJson
    assertEquals(json.hcursor.get[String]("id"), Right("66c9f0b2e1a4c3d2b1a09876"))
    assertEquals(json.hcursor.get[String]("slug"), Right("main-camera"))
    assertEquals(json.hcursor.get[String]("effectId"), Right("plasma-field"))
    assertEquals(json.hcursor.get[String]("updatedAt"), Right("2026-08-23T14:07:41.004Z"))
    assertEquals(json.hcursor.downField("params").get[Double]("speed"), Right(2.0))
  }

  test("absent optional parameter fields are omitted rather than sent as null") {
    val json = Wire.toDto(Fixtures.tint).asJson
    assertEquals(json.asObject.map(_.keys.toSet), Some(Set("key", "label", "kind", "default", "description")))
  }

  test("a request body may carry id and timestamps; they are ignored rather than rejected") {
    val body = """{"slug":"main-camera","effectId":"plasma-field","enabled":true,"params":{},
                 |"id":"66c9f0b2e1a4c3d2b1a09876","createdAt":"whenever"}""".stripMargin
    val decoded = parse(body).flatMap(_.as[Wire.RouteRequestDto])
    assertEquals(decoded.map(_.slug), Right("main-camera"))
  }

  test("a validation failure becomes 422 with the issue list in details") {
    val issues = List(ValidationIssue("params.speed", "expected number, got string"))
    val (status, envelope, _) = ErrorMapping.toWire(AppError.ValidationFailed(issues))

    assertEquals(status, StatusCode.UnprocessableEntity)
    assertEquals(envelope.error.code, "VALIDATION_FAILED")
    val fields = envelope.error.details.flatMap(_.hcursor.downField("issues").downArray.get[String]("field").toOption)
    assertEquals(fields, Some("params.speed"))
  }

  test("a slug conflict becomes 409 with the slug in details") {
    val (status, envelope, _) = ErrorMapping.toWire(AppError.SlugConflict("main-camera"))
    assertEquals(status, StatusCode.Conflict)
    assertEquals(envelope.error.details.flatMap(_.hcursor.get[String]("slug").toOption), Some("main-camera"))
  }

  test("an error with nothing to add omits details entirely") {
    val (_, envelope, _) = ErrorMapping.toWire(AppError.NotFound("No route with id 'x'"))
    assertEquals(envelope.error.details, None)
    assertEquals(envelope.asJson.hcursor.downField("error").keys.map(_.toSet), Some(Set("code", "message")))
  }

  test("error mapping round-trips, so the same description can drive a client") {
    val error = AppError.UnknownEffect("ghost")
    assertEquals(ErrorMapping.fromWire(ErrorMapping.toWire(error)), error)
  }

  // ---------------------------------------------------------------------------------------------
  // The canvas object
  // ---------------------------------------------------------------------------------------------

  test("an uncapped route sends fpsCap as null rather than leaving the key out") {
    // The one exception to "optional fields are omitted, never null", and the one that is easiest
    // to break: adding `deepDropNullValues` to RouteConfigDto's encoder, as several other encoders
    // in Wire.scala have, would turn "uncapped" into a key the frontend never sees.
    val json = Wire.toDto(route).asJson
    val canvas = json.hcursor.downField("canvas")

    assertEquals(canvas.keys.map(_.toSet), Some(Set("width", "height", "fpsCap")))
    assertEquals(canvas.get[Option[Int]]("fpsCap"), Right(None))
    assertEquals(canvas.get[Int]("width"), Right(1920))
    assertEquals(canvas.get[Int]("height"), Right(1080))
  }

  test("a capped route sends the number") {
    val capped = route.copy(canvas = CanvasSettings(1280, 720, Some(30)))
    val canvas = Wire.toDto(capped).asJson.hcursor.downField("canvas")

    assertEquals(canvas.get[Int]("fpsCap"), Right(30))
  }

  test("a request body may leave canvas out entirely, or leave keys out of it") {
    val withoutCanvas = """{"slug":"main-camera","effectId":"plasma-field","enabled":true,"params":{}}"""
    assertEquals(parse(withoutCanvas).flatMap(_.as[Wire.RouteRequestDto]).map(_.canvas), Right(None))

    val partial =
      """{"slug":"main-camera","effectId":"plasma-field","enabled":true,"params":{},"canvas":{"width":1280}}"""
    assertEquals(
      parse(partial).flatMap(_.as[Wire.RouteRequestDto]).map(_.canvas),
      Right(Some(Wire.CanvasSettingsRequestDto(Some(1280.0), None, None)))
    )
  }

  test("a non-integer canvas value decodes, so the validator can report it as 422 rather than 400") {
    // The whole reason the request DTO holds Doubles. If it held Ints, circe would refuse the body
    // and the caller would get a 400 with no field name in it.
    val body =
      """{"slug":"main-camera","effectId":"plasma-field","enabled":true,"params":{},"canvas":{"width":1920.5}}"""
    assertEquals(
      parse(body).flatMap(_.as[Wire.RouteRequestDto]).map(_.canvas.flatMap(_.width)),
      Right(Some(1920.5))
    )
  }

  test("a canvas value of the wrong JSON type is refused by the decoder, so the caller gets a 400") {
    // The other half of the rule the previous test covers. A number that breaks a rule is a 422 and
    // has to reach the validator; a value of the wrong *type* never had a chance of being valid, so
    // it is a 400 and the decoder is where it stops. The string case is the one worth pinning: this
    // decoder is written by hand precisely because circe's own Decoder[Double] would accept "1920"
    // and quietly create the route.
    def widthOf(json: String) =
      parse(s"""{"slug":"main-camera","effectId":"plasma-field","enabled":true,"params":{},"canvas":$json}""")
        .flatMap(_.as[Wire.RouteRequestDto])

    assert(widthOf("""{"width":"1920"}""").isLeft, "a numeric string must not be coerced to a number")
    assert(widthOf("""{"width":true}""").isLeft, "a boolean is not a canvas size")
    assert(widthOf("""{"width":[1920]}""").isLeft, "an array is not a canvas size")
    assert(widthOf("""{"fpsCap":"30"}""").isLeft, "fpsCap follows the same rule as width and height")
  }

  test("a canvas key that is absent and one spelled null both mean 'use the default'") {
    def canvasOf(json: String) =
      parse(s"""{"slug":"main-camera","effectId":"plasma-field","enabled":true,"params":{},"canvas":$json}""")
        .flatMap(_.as[Wire.RouteRequestDto])
        .map(_.canvas)

    val empty = Right(Some(Wire.CanvasSettingsRequestDto(None, None, None)))
    assertEquals(canvasOf("{}"), empty)
    assertEquals(canvasOf("""{"width":null,"height":null,"fpsCap":null}"""), empty)
  }

  // ---------------------------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------------------------

  test("a signed-in session reports its expiry; a signed-out one omits the field") {
    val signedIn = SessionInfo(authenticated = true, authRequired = true, Some(Instant.parse("2026-08-31T09:14:22Z")))
    val json = Wire.toDto(signedIn).asJson
    assertEquals(json.hcursor.get[String]("expiresAt"), Right("2026-08-31T09:14:22.000Z"))

    val signedOut = SessionInfo(authenticated = false, authRequired = true, expiresAt = None)
    assertEquals(
      Wire.toDto(signedOut).asJson.asObject.map(_.keys.toSet),
      Some(Set("authenticated", "authRequired"))
    )
  }

  test("a 401 carries no details at all") {
    // Deliberate: with one operator, anything that distinguishes "your session expired" from "that
    // password is wrong" only helps somebody probing the server.
    val (status, envelope, retryAfter) = ErrorMapping.toWire(AppError.Unauthorized("Incorrect password."))

    assertEquals(status, StatusCode.Unauthorized)
    assertEquals(envelope.error.code, "UNAUTHORIZED")
    assertEquals(envelope.error.details, None)
    assertEquals(retryAfter, None)
  }

  test("a lockout is a 429 carrying the wait both in the body and in the Retry-After header") {
    val (status, envelope, retryAfter) = ErrorMapping.toWire(AppError.TooManyAttempts(60))

    assertEquals(status, StatusCode.TooManyRequests)
    assertEquals(envelope.error.code, "TOO_MANY_ATTEMPTS")
    assertEquals(envelope.error.details.flatMap(_.hcursor.get[Int]("retryAfterSeconds").toOption), Some(60))
    assertEquals(retryAfter, Some("60"))
  }

  test("no error other than the lockout sends a Retry-After header") {
    val errors = List(
      AppError.BadRequest("nope"),
      AppError.Unauthorized("nope"),
      AppError.NotFound("nope"),
      AppError.SlugConflict("main-camera"),
      AppError.UnknownEffect("ghost"),
      AppError.ValidationFailed(Nil),
      AppError.internal("nope")
    )
    errors.foreach { error =>
      val (_, _, retryAfter) = ErrorMapping.toWire(error)
      assertEquals(retryAfter, None, s"$error should not send Retry-After")
    }
  }

  test("the two new errors round-trip like the rest, so the description can still drive a client") {
    List(AppError.Unauthorized("Incorrect password."), AppError.TooManyAttempts(42)).foreach { error =>
      assertEquals(ErrorMapping.fromWire(ErrorMapping.toWire(error)), error)
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Presets, export and import
  // ---------------------------------------------------------------------------------------------

  private val preset = Preset(
    id = PresetId.unsafe("66ca1f39e1a4c3d2b1a01234"),
    name = "Neon night",
    effectId = Fixtures.plasmaField.id,
    params = Map(ParamKey.unsafe("speed") -> JsonNumber(3.0)),
    createdAt = Instant.parse("2026-08-24T09:00:00.000Z"),
    updatedAt = Instant.parse("2026-08-24T09:00:00.000Z")
  )

  test("a preset is serialised with the field names from the contract and nothing else") {
    val json = Wire.toDto(preset).asJson
    assertEquals(
      json.asObject.map(_.keys.toSet),
      Some(Set("id", "name", "effectId", "params", "createdAt", "updatedAt"))
    )
    assertEquals(json.hcursor.get[String]("name"), Right("Neon night"))
    assertEquals(json.hcursor.downField("params").get[Double]("speed"), Right(3.0))
  }

  test("a preset carries no enabled flag and no canvas: those belong to a route, not to a look") {
    val keys = Wire.toDto(preset).asJson.asObject.map(_.keys.toSet).getOrElse(Set.empty)
    assert(!keys.contains("enabled"))
    assert(!keys.contains("canvas"))
  }

  test("a preset write request accepts a body that also carries the server-owned fields") {
    val body = """{"id":"ignored","name":"Neon night","effectId":"plasma-field","params":{},"createdAt":"whenever"}"""
    val decoded = parse(body).flatMap(_.as[Wire.PresetRequestDto])
    assertEquals(decoded.map(_.name), Right("Neon night"))
  }

  test("the export envelope keeps an uncapped fpsCap as an explicit null") {
    // The same trap `RouteConfigDto` has, one level deeper: an encoder that dropped nulls here
    // would take "fpsCap": null out of every canvas in a backup file, and a restore would then be
    // unable to tell "no cap" from "this build is too old to have one".
    val envelope = BackupEnvelope(
      schemaVersion = 1,
      exportedAt = Instant.parse("2026-08-24T10:11:12.000Z"),
      routes = List(route),
      presets = List(preset)
    )

    val json = Wire.toDto(envelope).asJson
    assertEquals(json.hcursor.get[Int]("schemaVersion"), Right(1))
    assertEquals(json.hcursor.get[String]("exportedAt"), Right("2026-08-24T10:11:12.000Z"))
    assertEquals(
      json.hcursor.downField("routes").downArray.downField("canvas").get[Option[Int]]("fpsCap"),
      Right(None)
    )
    assert(
      json.hcursor.downField("routes").downArray.downField("canvas").keys.exists(_.toSet.contains("fpsCap")),
      "fpsCap must be present as an explicit null, not dropped"
    )
  }

  test("an import file may hold either a write-shaped route or a whole exported one") {
    val exported =
      """{"id":"66c9f0b2e1a4c3d2b1a09876","slug":"main-camera","effectId":"plasma-field","enabled":true,""" +
        """"params":{"speed":2.0},"canvas":{"width":1280,"height":720,"fpsCap":null},""" +
        """"createdAt":"2026-08-23T14:05:09.123Z","updatedAt":"2026-08-23T14:07:41.004Z"}"""

    val decoded = parse(exported).flatMap(_.as[Wire.ImportRouteDto]).map(Wire.toRaw)
    assertEquals(decoded.map(_.route.slug), Right("main-camera"))
    assertEquals(decoded.map(_.createdAt), Right(Some("2026-08-23T14:05:09.123Z")))
    assertEquals(decoded.map(_.route.canvas.flatMap(_.width)), Right(Some(1280.0)))
  }

  test("an import result is serialised with all six counts") {
    val json = Wire.toDto(ImportResult(1, 2, 3, 4, 5, 6)).asJson
    assertEquals(
      json.asObject.map(_.keys.toSet),
      Some(
        Set("routesCreated", "routesUpdated", "routesDeleted", "presetsCreated", "presetsUpdated", "presetsDeleted")
      )
    )
    assertEquals(json.hcursor.get[Int]("presetsDeleted"), Right(6))
  }

  test("the name-conflict error carries both the effect and the name, because a name is only unique per effect") {
    val (status, envelope, retryAfter) = ErrorMapping.toWire(AppError.NameConflict("plasma-field", "Neon night"))
    assertEquals(status, StatusCode.Conflict)
    assertEquals(envelope.error.code, "NAME_CONFLICT")
    assertEquals(retryAfter, None)
    assertEquals(envelope.error.details.flatMap(_.hcursor.get[String]("effectId").toOption), Some("plasma-field"))
    assertEquals(envelope.error.details.flatMap(_.hcursor.get[String]("name").toOption), Some("Neon night"))
  }

  test("the name-conflict error survives a round trip through the wire form") {
    val error = AppError.NameConflict("plasma-field", "Neon night")
    assertEquals(ErrorMapping.fromWire(ErrorMapping.toWire(error)), error)
  }

  // ---------------------------------------------------------------------------------------------
  // The session cookie
  // ---------------------------------------------------------------------------------------------

  test("the cookie issued on login has exactly the attributes the contract lists") {
    val token = SessionToken.generate(new SecureRandom())
    val cookie = SessionCookie.issue(token, maxAgeSeconds = 604800, secure = false)

    assertEquals(cookie.value, token.value)
    assertEquals(cookie.path, Some("/"))
    assertEquals(cookie.maxAge, Some(604800L))
    assertEquals(cookie.httpOnly, true)
    assertEquals(cookie.secure, false)
    assertEquals(cookie.sameSite, Some(Cookie.SameSite.Lax))
    // No Domain, so the cookie is host-only; no Expires, because Max-Age alone is enough and
    // sending both invites a browser to disagree with itself.
    assertEquals(cookie.domain, None)
    assertEquals(cookie.expires, None)
  }

  test("Secure is added only when it is asked for") {
    val token = SessionToken.generate(new SecureRandom())
    assertEquals(SessionCookie.issue(token, 604800, secure = true).secure, true)
  }

  test("the cookie sent on logout is the same cookie, emptied, with Max-Age=0") {
    // That is the only way to delete a cookie: name, path and the other attributes have to match
    // the ones it was set with, or the browser treats it as a different cookie and keeps the
    // original.
    val cleared = SessionCookie.clear(secure = false)

    assertEquals(cleared.value, "")
    assertEquals(cleared.maxAge, Some(0L))
    assertEquals(cleared.path, Some("/"))
    assertEquals(cleared.httpOnly, true)
    assertEquals(cleared.sameSite, Some(Cookie.SameSite.Lax))
  }
}
