package obseffects.infrastructure.http

import io.circe.syntax.*
import munit.FunSuite
import obseffects.application.AppError
import obseffects.domain.{Sound, SoundId}
import obseffects.infrastructure.http.Wire.given
import sttp.model.StatusCode

import java.time.Instant

/** Checks the exact JSON the sound endpoints produce, in the same spirit as `WireSuite`: the frontend and the effect
  * runtime are written against these bytes, not against the Scala types.
  */
class SoundWireSuite extends FunSuite {

  private val sound = Sound(
    id = SoundId.unsafe("66cf01a2e1a4c3d2b1a05555"),
    name = "ding",
    builtin = false,
    contentType = "audio/mpeg",
    sizeBytes = 1234L,
    uploadedAt = Instant.parse("2026-08-27T10:00:00.123Z")
  )

  test("a sound is serialised with the field names from the contract") {
    val json = Wire.toDto(sound).asJson
    assertEquals(json.hcursor.get[String]("id"), Right("66cf01a2e1a4c3d2b1a05555"))
    assertEquals(json.hcursor.get[String]("name"), Right("ding"))
    assertEquals(json.hcursor.get[Boolean]("builtin"), Right(false))
    assertEquals(json.hcursor.get[String]("contentType"), Right("audio/mpeg"))
    assertEquals(json.hcursor.get[Long]("sizeBytes"), Right(1234L))
    assertEquals(json.hcursor.get[String]("uploadedAt"), Right("2026-08-27T10:00:00.123Z"))
  }

  test("the sound list is an object with a `sounds` array, not a bare array") {
    val json = Wire.SoundListDto(List(Wire.toDto(sound))).asJson
    assertEquals(json.hcursor.downField("sounds").downArray.get[String]("name"), Right("ding"))
  }

  test("a sound name conflict becomes 409 NAME_CONFLICT with the name — and no effectId — in details") {
    val (status, envelope, _) = ErrorMapping.toWire(AppError.SoundNameConflict("ding"))
    assertEquals(status, StatusCode.Conflict)
    assertEquals(envelope.error.code, "NAME_CONFLICT")
    assertEquals(envelope.error.details.flatMap(_.hcursor.get[String]("name").toOption), Some("ding"))
    assertEquals(envelope.error.details.flatMap(_.hcursor.get[String]("effectId").toOption), None)
  }

  test("a NAME_CONFLICT without an effectId reads back as a sound conflict, one with it as a preset conflict") {
    val soundConflict = ErrorMapping.toWire(AppError.SoundNameConflict("ding"))
    assertEquals(ErrorMapping.fromWire(soundConflict), AppError.SoundNameConflict("ding"))
    val presetConflict = ErrorMapping.toWire(AppError.NameConflict("plasma-field", "Neon"))
    assertEquals(ErrorMapping.fromWire(presetConflict), AppError.NameConflict("plasma-field", "Neon"))
  }
}
