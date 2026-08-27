package obseffects.infrastructure.mongo

import munit.FunSuite
import obseffects.Fixtures
import obseffects.domain.JsonValue.JsonNumber
import obseffects.domain.{CanvasSettings, EffectId, ParamKey, PresetInput, RouteInput, Slug}
import org.bson.Document
import org.bson.types.ObjectId

import java.time.Instant
import java.util.Date

/** What the `routes` collection holds, and — the reason this suite exists — what happens when it holds a document
  * written before the `canvas` field existed.
  *
  * No MongoDB server is involved. `org.bson.Document` is a plain in-memory map that the driver happens to ship, so the
  * two conversion functions can be exercised directly, which is both faster and a truer test than round-tripping
  * through a database that might be doing conversions of its own.
  */
class BsonCodecsSuite extends FunSuite {

  private val createdAt = Instant.parse("2026-08-23T14:05:09.123Z")
  private val updatedAt = Instant.parse("2026-08-23T14:07:41.004Z")

  private def routeInput(canvas: CanvasSettings): RouteInput =
    RouteInput(
      slug = Slug.unsafe("main-camera"),
      effectId = Fixtures.plasmaField.id,
      enabled = true,
      params = Map(ParamKey.unsafe("speed") -> JsonNumber(2.0)),
      canvas = canvas
    )

  /** A stored route exactly as it looked before Phase 2: every field the old code wrote, and no `canvas` key. */
  private def legacyDocument(): Document =
    new Document()
      .append("_id", new ObjectId())
      .append("slug", "main-camera")
      .append("effectId", "plasma-field")
      .append("enabled", java.lang.Boolean.TRUE)
      .append("params", new Document("speed", java.lang.Double.valueOf(2.0)))
      .append("createdAt", Date.from(createdAt))
      .append("updatedAt", Date.from(updatedAt))

  // -------------------------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------------------------

  test("a capped route stores width, height and fpsCap as whole numbers") {
    val document =
      BsonCodecs.routeInputToDocument(routeInput(CanvasSettings(1280, 720, Some(30))), createdAt, updatedAt)
    val canvas = document.get("canvas", classOf[Document])

    assertEquals(canvas.getInteger("width").intValue(), 1280)
    assertEquals(canvas.getInteger("height").intValue(), 720)
    assertEquals(canvas.getInteger("fpsCap").intValue(), 30)
  }

  test("an uncapped route leaves fpsCap out of the document entirely rather than storing null") {
    // The stored shape omits absent optional fields, the same way every other one in this file
    // does. The JSON *response* is the opposite — it sends `"fpsCap": null` — and the difference is
    // deliberate: a browser has to tell "uncapped" from "this field does not exist in your build",
    // while a BSON document is only ever read by the function tested below, which knows what a
    // missing key means.
    val document = BsonCodecs.routeInputToDocument(routeInput(CanvasSettings.Default), createdAt, updatedAt)
    val canvas = document.get("canvas", classOf[Document])

    assert(!canvas.containsKey("fpsCap"), s"fpsCap should not be stored, but the document is $canvas")
  }

  // -------------------------------------------------------------------------------------------
  // Reading, including documents written before this field existed
  // -------------------------------------------------------------------------------------------

  test("a document with no canvas field at all loads with the defaults") {
    // This is the case that decides whether every route created before Phase 2 keeps working. If
    // it ever fails, an upgrade turns a working scene collection into 500s.
    val route = BsonCodecs.routeFromDocument(legacyDocument())

    assertEquals(route.canvas, CanvasSettings(1920, 1080, None))
    assertEquals(route.slug.value, "main-camera")
    assertEquals(route.effectId, EffectId.unsafe("plasma-field"))
  }

  test("a canvas sub-document missing individual keys defaults them one by one") {
    // Nothing this project writes produces a half-filled canvas, so this is about a hand-edited
    // document loading rather than crashing.
    val document = legacyDocument().append("canvas", new Document("width", java.lang.Integer.valueOf(1280)))

    assertEquals(BsonCodecs.routeFromDocument(document).canvas, CanvasSettings(1280, 1080, None))
  }

  test("a canvas whose numbers were stored as doubles still reads as integers") {
    // mongo-express and mongosh both write a plain `1920` as a BSON double, so a document that has
    // been edited by hand comes back with a different numeric type than the one we wrote.
    val document = legacyDocument().append(
      "canvas",
      new Document("width", java.lang.Double.valueOf(1280.0))
        .append("height", java.lang.Double.valueOf(720.0))
        .append("fpsCap", java.lang.Double.valueOf(30.0))
    )

    assertEquals(BsonCodecs.routeFromDocument(document).canvas, CanvasSettings(1280, 720, Some(30)))
  }

  test("what is written comes back unchanged, capped and uncapped alike") {
    List(CanvasSettings(1280, 720, Some(30)), CanvasSettings(1920, 1080, None), CanvasSettings(16, 16, Some(1)))
      .foreach { canvas =>
        val document = BsonCodecs
          .routeInputToDocument(routeInput(canvas), createdAt, updatedAt)
          .append("_id", new ObjectId())

        assertEquals(BsonCodecs.routeFromDocument(document).canvas, canvas)
      }
  }

  test("the rest of a route still round-trips, so the canvas was added and nothing was displaced") {
    val document = BsonCodecs
      .routeInputToDocument(routeInput(CanvasSettings.Default), createdAt, updatedAt)
      .append("_id", new ObjectId())

    val route = BsonCodecs.routeFromDocument(document)

    assertEquals(route.slug.value, "main-camera")
    assertEquals(route.enabled, true)
    assertEquals(route.params, Map(ParamKey.unsafe("speed") -> JsonNumber(2.0)))
    assertEquals(route.createdAt, createdAt)
    assertEquals(route.updatedAt, updatedAt)
  }

  // ---------------------------------------------------------------------------------------------
  // Presets
  // ---------------------------------------------------------------------------------------------

  private val presetInput = PresetInput(
    name = "Neon night",
    effectId = Fixtures.plasmaField.id,
    params = Map(ParamKey.unsafe("speed") -> JsonNumber(3.0))
  )

  test("a preset round-trips through the stored shape") {
    val document = BsonCodecs.presetInputToDocument(presetInput, createdAt, updatedAt).append("_id", new ObjectId())
    val preset = BsonCodecs.presetFromDocument(document)

    assertEquals(preset.name, "Neon night")
    assertEquals(preset.effectId, Fixtures.plasmaField.id)
    assertEquals(preset.params, Map(ParamKey.unsafe("speed") -> JsonNumber(3.0)))
    assertEquals(preset.createdAt, createdAt)
    assertEquals(preset.updatedAt, updatedAt)
  }

  test("a preset's name is stored as it was given, because the index does the case-insensitive part") {
    val document = BsonCodecs.presetInputToDocument(presetInput.copy(name = "NEON night"), createdAt, updatedAt)
    assertEquals(document.getString("name"), "NEON night")
  }

  test("a preset with no parameters reads back as an empty map rather than failing") {
    val document = BsonCodecs
      .presetInputToDocument(presetInput.copy(params = Map.empty), createdAt, updatedAt)
      .append("_id", new ObjectId())

    assertEquals(BsonCodecs.presetFromDocument(document).params, Map.empty)
  }

  test("a preset document carries no enabled flag and no canvas") {
    val document = BsonCodecs.presetInputToDocument(presetInput, createdAt, updatedAt)
    assertEquals(document.containsKey("enabled"), false)
    assertEquals(document.containsKey("canvas"), false)
  }
}
