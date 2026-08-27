package obseffects.application

import munit.FunSuite
import obseffects.domain.ValidationIssue

import java.time.{Clock, Instant, ZoneOffset}

/** Tests for the sound use cases, run against the in-memory repository.
  *
  * The rules being pinned down: a name is trimmed, non-empty, at most 64 characters and unique; only the four browser
  * audio formats are accepted; a body is non-empty and at most 5 MB; a builtin sound cannot be deleted; and the audio
  * lookup accepts either the id or the name.
  */
class SoundServiceSuite extends FunSuite {

  private val uploadedAt = Instant.parse("2026-08-27T10:00:00.000Z")

  private val mp3Bytes: Array[Byte] = Array[Byte](1, 2, 3, 4)

  private def service(): (SoundService, InMemorySoundRepository) = {
    val sounds = new InMemorySoundRepository
    (new SoundService(sounds, Clock.fixed(uploadedAt, ZoneOffset.UTC)), sounds)
  }

  private def uploaded() = {
    val (sut, sounds) = service()
    val sound = sut.upload("ding", Some("audio/mpeg"), mp3Bytes).getOrElse(fail("the upload should be accepted"))
    (sut, sounds, sound)
  }

  test("uploading a sound stores it with a server-assigned id, its size and the upload time") {
    val (_, _, sound) = uploaded()
    assertEquals(sound.name, "ding")
    assertEquals(sound.builtin, false)
    assertEquals(sound.contentType, "audio/mpeg")
    assertEquals(sound.sizeBytes, mp3Bytes.length.toLong)
    assertEquals(sound.uploadedAt, uploadedAt)
    assertEquals(sound.id.value.length, 24)
  }

  test("a sound name is stored trimmed") {
    val (sut, _) = service()
    val sound = sut.upload("  ding  ", Some("audio/mpeg"), mp3Bytes).getOrElse(fail("should be accepted"))
    assertEquals(sound.name, "ding")
  }

  test("a name of nothing but whitespace fails validation") {
    val (sut, _) = service()
    sut.upload("   ", Some("audio/mpeg"), mp3Bytes) match {
      case Left(AppError.ValidationFailed(issues)) =>
        assertEquals(issues, List(ValidationIssue("name", "must contain at least one non-space character")))
      case other => fail(s"expected a validation failure, got $other")
    }
  }

  test("a name longer than 64 characters fails validation, and one of exactly 64 is accepted") {
    val (sut, _) = service()
    assert(sut.upload("n" * 65, Some("audio/mpeg"), mp3Bytes).swap.exists {
      case AppError.ValidationFailed(_) => true
      case _                            => false
    })
    assert(sut.upload("n" * 64, Some("audio/mpeg"), mp3Bytes).isRight)
  }

  test("uploading a second sound with a taken name is a sound name conflict") {
    val (sut, _, _) = uploaded()
    assertEquals(sut.upload("ding", Some("audio/mpeg"), mp3Bytes), Left(AppError.SoundNameConflict("ding")))
  }

  test("a content type outside the four audio formats fails validation") {
    val (sut, _) = service()
    sut.upload("ding", Some("video/mp4"), mp3Bytes) match {
      case Left(AppError.ValidationFailed(issues)) => assertEquals(issues.map(_.field), List("contentType"))
      case other                                   => fail(s"expected a validation failure, got $other")
    }
  }

  test("a missing content type fails validation the same way as a wrong one") {
    val (sut, _) = service()
    assert(sut.upload("ding", None, mp3Bytes).swap.exists {
      case AppError.ValidationFailed(issues) => issues.map(_.field) == List("contentType")
      case _                                 => false
    })
  }

  test("a content type may carry parameters, which are ignored for the format check") {
    val (sut, _) = service()
    assert(sut.upload("ding", Some("audio/ogg; codecs=opus"), mp3Bytes).isRight)
  }

  test("an empty body fails validation") {
    val (sut, _) = service()
    assert(sut.upload("ding", Some("audio/mpeg"), Array.emptyByteArray).swap.exists {
      case AppError.ValidationFailed(issues) => issues.map(_.field) == List("body")
      case _                                 => false
    })
  }

  test("a body over 5 MB fails validation") {
    val (sut, _) = service()
    val oversized = new Array[Byte](5 * 1024 * 1024 + 1)
    assert(sut.upload("ding", Some("audio/mpeg"), oversized).swap.exists {
      case AppError.ValidationFailed(issues) => issues.map(_.field) == List("body")
      case _                                 => false
    })
  }

  test("sounds are listed sorted by name, ignoring case") {
    val (sut, _) = service()
    val _ = sut.upload("Zelda", Some("audio/mpeg"), mp3Bytes)
    val _ = sut.upload("apple", Some("audio/mpeg"), mp3Bytes)
    assertEquals(sut.list().map(_.name), List("apple", "Zelda"))
  }

  test("the audio lookup finds a sound by its id") {
    val (sut, _, sound) = uploaded()
    val (found, bytes) = sut.audio(sound.id.value).getOrElse(fail("the id lookup should succeed"))
    assertEquals(found.id, sound.id)
    assertEquals(bytes.toList, mp3Bytes.toList)
  }

  test("the audio lookup finds a sound by its name") {
    val (sut, _, sound) = uploaded()
    assertEquals(sut.audio("ding").map(_._1.id), Right(sound.id))
  }

  test("the audio lookup of an unknown id or name is a not-found") {
    val (sut, _, _) = uploaded()
    assert(sut.audio("dong").swap.exists(_.isInstanceOf[AppError.NotFound]))
  }

  test("deleting a sound removes it, and deleting it again is a not-found") {
    val (sut, _, sound) = uploaded()
    assertEquals(sut.delete(sound.id.value), Right(()))
    assert(sut.delete(sound.id.value).swap.exists(_.isInstanceOf[AppError.NotFound]))
  }

  test("deleting by an id that is not an ObjectId is a bad request, not a not-found") {
    val (sut, _) = service()
    assert(sut.delete("banana").swap.exists(_.isInstanceOf[AppError.BadRequest]))
  }

  test("a builtin sound cannot be deleted") {
    val (sut, sounds) = service()
    sut.seedBuiltins()
    val builtin = sounds.findByName("discord").getOrElse(fail("seeding should have stored 'discord'"))
    sut.delete(builtin.id.value) match {
      case Left(AppError.ValidationFailed(issues)) => assertEquals(issues.map(_.field), List("builtin"))
      case other                                   => fail(s"expected a validation failure, got $other")
    }
  }

  test("seeding stores the two builtin sounds with their bytes from the classpath") {
    val (sut, sounds) = service()
    sut.seedBuiltins()
    assertEquals(sut.list().map(_.name), List("discord", "slack-message"))
    assert(sut.list().forall(sound => sound.builtin && sound.contentType == "audio/mpeg"))
    assert(sounds.findByName("discord").flatMap(s => sounds.download(s.id)).exists(_.nonEmpty))
  }

  test("seeding a second time changes nothing") {
    val (sut, _) = service()
    sut.seedBuiltins()
    val first = sut.list()
    sut.seedBuiltins()
    assertEquals(sut.list(), first)
  }
}
