package obseffects.domain

import munit.FunSuite
import obseffects.Fixtures
import obseffects.domain.JsonValue.*

/** Tests for the rules in section 5 of the contract. These need nothing but the domain: no server, no database, no JSON
  * library.
  */
class ValidationSuite extends FunSuite {

  // ---------------------------------------------------------------------------------------------
  // Slug format
  // ---------------------------------------------------------------------------------------------

  test("a slug of lowercase letters, digits and hyphens is accepted") {
    assert(Slug.parse("main-camera-2").isRight)
  }

  test("a slug with uppercase letters is rejected") {
    assert(Slug.parse("Main-Camera").isLeft)
  }

  test("a slug starting with a hyphen is rejected") {
    assert(Slug.parse("-camera").isLeft)
  }

  test("an empty slug is rejected") {
    assert(Slug.parse("").isLeft)
  }

  test("a slug longer than 64 characters is rejected") {
    assert(Slug.parse("a" * 65).isLeft)
  }

  test("a parameter key may contain underscores but must not start with a digit") {
    assert(ParamKey.parse("blend_mode2").isRight)
    assert(ParamKey.parse("2fast").isLeft)
  }

  test("a route id must be 24 hexadecimal characters") {
    assert(RouteId.parse("66c9f0b2e1a4c3d2b1a09876").isRight)
    assert(RouteId.parse("not-an-object-id").isLeft)
  }

  // ---------------------------------------------------------------------------------------------
  // Parameter values
  // ---------------------------------------------------------------------------------------------

  test("a number parameter rejects a string value") {
    val issues = Validation.validateParamValue("params.speed", Fixtures.speed, JsonString("fast"))
    assertEquals(issues.map(_.field), List("params.speed"))
    assertEquals(issues.head.message, "expected number, got string")
  }

  test("a number parameter rejects a value above its maximum") {
    val issues = Validation.validateParamValue("params.speed", Fixtures.speed, JsonNumber(11.0))
    assertEquals(issues.size, 1)
    assert(issues.head.message.contains("must be <= 10.0"))
  }

  test("a number parameter accepts a value on the boundary of its range") {
    assertEquals(Validation.validateParamValue("params.speed", Fixtures.speed, JsonNumber(10.0)), Nil)
  }

  test("a colour parameter rejects a value that is not six hex digits") {
    val issues = Validation.validateParamValue("params.tint", Fixtures.tint, JsonString("red"))
    assertEquals(issues.size, 1)
  }

  test("a select parameter rejects a value outside its options") {
    val issues = Validation.validateParamValue("params.blendMode", Fixtures.blendMode, JsonString("multiply"))
    assertEquals(issues.size, 1)
    assert(issues.head.message.contains("add, screen"))
  }

  test("a text parameter rejects more than 1024 characters") {
    val text =
      ParamSpec(ParamKey.unsafe("caption"), "Caption", ParamKind.Text, JsonString(""), None, None, None, None, "")
    assertEquals(Validation.validateParamValue("params.caption", text, JsonString("x" * 1024)), Nil)
    assertEquals(Validation.validateParamValue("params.caption", text, JsonString("x" * 1025)).size, 1)
  }

  // ---------------------------------------------------------------------------------------------
  // Effect descriptors
  // ---------------------------------------------------------------------------------------------

  test("a well-formed descriptor is accepted") {
    assertEquals(
      Validation.validateManifest(List(Fixtures.rawPlasmaField)).map(_.map(_.id.value)),
      Right(List("plasma-field"))
    )
  }

  test("a descriptor with an unknown engine is rejected") {
    val manifest = List(Fixtures.rawPlasmaField.copy(engine = "webgpu"))
    val issues = Validation.validateManifest(manifest).left.getOrElse(Nil)
    assertEquals(issues.map(_.field), List("effects[0].engine"))
  }

  test("a select parameter without options is rejected") {
    val badSpec = Fixtures.rawSpeed.copy(key = "mode", kind = "select", default = JsonString("add"), options = None)
    val issues =
      Validation.validateManifest(List(Fixtures.rawPlasmaField.copy(params = List(badSpec)))).left.getOrElse(Nil)
    assertEquals(issues.map(_.field), List("effects[0].params[0].options"))
  }

  test("a default value that does not match its kind is rejected") {
    val badSpec = Fixtures.rawSpeed.copy(default = JsonString("fast"))
    val issues =
      Validation.validateManifest(List(Fixtures.rawPlasmaField.copy(params = List(badSpec)))).left.getOrElse(Nil)
    assertEquals(issues.map(_.field), List("effects[0].params[0].default"))
  }

  test("two descriptors with the same id are rejected") {
    val manifest = List(Fixtures.rawPlasmaField, Fixtures.rawPlasmaField)
    val issues = Validation.validateManifest(manifest).left.getOrElse(Nil)
    assertEquals(issues.map(_.field), List("effects"))
    assert(issues.head.message.contains("plasma-field"))
  }

  // ---------------------------------------------------------------------------------------------
  // Route input
  // ---------------------------------------------------------------------------------------------

  private def findEffect(id: String): Option[EffectDescriptor] =
    Option.when(id == "plasma-field")(Fixtures.plasmaField)

  test("a route with a valid slug and known parameters is accepted") {
    val result = Validation.validateRouteInput(Fixtures.rawRoute(), findEffect)
    assertEquals(result.map(_.slug.value), Right("main-camera"))
  }

  test("a route with an unknown parameter key is rejected rather than having the key dropped") {
    val raw = Fixtures.rawRoute(params = Map("speeed" -> JsonNumber(2.0)))
    Validation.validateRouteInput(raw, findEffect) match {
      case Left(InputError.Invalid(issues)) =>
        assertEquals(issues.map(_.field), List("params.speeed"))
        assert(issues.head.message.contains("has no parameter"))
      case other => fail(s"expected an Invalid result, got $other")
    }
  }

  test("a route whose effect does not exist is reported as an unknown effect") {
    val raw = Fixtures.rawRoute(effectId = "no-such-effect")
    assertEquals(
      Validation.validateRouteInput(raw, findEffect),
      Left(InputError.UnknownEffect("no-such-effect"))
    )
  }

  test("a route reports a bad slug and a bad parameter value together") {
    val raw = Fixtures.rawRoute(slug = "Main Camera", params = Map("speed" -> JsonString("fast")))
    Validation.validateRouteInput(raw, findEffect) match {
      case Left(InputError.Invalid(issues)) => assertEquals(issues.map(_.field), List("slug", "params.speed"))
      case other                            => fail(s"expected an Invalid result, got $other")
    }
  }

  test("a route with no parameters at all is accepted, because parameters are sparse") {
    val result = Validation.validateRouteInput(Fixtures.rawRoute(params = Map.empty), findEffect)
    assertEquals(result.map(_.params), Right(Map.empty[ParamKey, JsonValue]))
  }

  // ---------------------------------------------------------------------------------------------
  // Canvas settings
  //
  // Rules 7 and 8 of the contract. The boundaries are tested from both sides — 15 and 16, 7680 and
  // 7681 — because an off-by-one in a range check is the mistake that a test using only obviously
  // wrong values (0, 99999) never catches.
  // ---------------------------------------------------------------------------------------------

  test("no canvas object at all means 1920x1080, uncapped") {
    assertEquals(Validation.validateCanvas(None), Right(CanvasSettings(1920, 1080, None)))
  }

  test("each missing key of a present canvas object takes its own default") {
    assertEquals(
      Validation.validateCanvas(Some(RawCanvasSettings(width = Some(1280.0), height = None, fpsCap = None))),
      Right(CanvasSettings(1280, 1080, None))
    )
  }

  test("an explicit null fpsCap and an absent one both mean uncapped") {
    // A JSON `null` decodes into `None`, so by the time it reaches here the two are already the
    // same value. The test pins that they are also meant to be the same *answer*.
    assertEquals(Validation.validateCanvas(Some(Fixtures.rawCanvas(fpsCap = None))).map(_.fpsCap), Right(None))
  }

  test("a complete canvas object is accepted as written") {
    assertEquals(
      Validation.validateCanvas(Some(Fixtures.rawCanvas())),
      Right(CanvasSettings(1280, 720, Some(30)))
    )
  }

  test("width accepts 16 and 7680 and rejects 15 and 7681") {
    assertEquals(Validation.validateCanvas(Some(Fixtures.rawCanvas(width = Some(16.0)))).map(_.width), Right(16))
    assertEquals(Validation.validateCanvas(Some(Fixtures.rawCanvas(width = Some(7680.0)))).map(_.width), Right(7680))
    assertEquals(canvasIssues(Fixtures.rawCanvas(width = Some(15.0))).map(_.field), List("canvas.width"))
    assertEquals(canvasIssues(Fixtures.rawCanvas(width = Some(7681.0))).map(_.field), List("canvas.width"))
  }

  test("height accepts 16 and 4320 and rejects 15 and 4321") {
    assertEquals(Validation.validateCanvas(Some(Fixtures.rawCanvas(height = Some(16.0)))).map(_.height), Right(16))
    assertEquals(Validation.validateCanvas(Some(Fixtures.rawCanvas(height = Some(4320.0)))).map(_.height), Right(4320))
    assertEquals(canvasIssues(Fixtures.rawCanvas(height = Some(15.0))).map(_.field), List("canvas.height"))
    assertEquals(canvasIssues(Fixtures.rawCanvas(height = Some(4321.0))).map(_.field), List("canvas.height"))
  }

  test("fpsCap accepts 1 and 240 and rejects 0 and 241") {
    assertEquals(Validation.validateCanvas(Some(Fixtures.rawCanvas(fpsCap = Some(1.0)))).map(_.fpsCap), Right(Some(1)))
    assertEquals(
      Validation.validateCanvas(Some(Fixtures.rawCanvas(fpsCap = Some(240.0)))).map(_.fpsCap),
      Right(Some(240))
    )
    assertEquals(canvasIssues(Fixtures.rawCanvas(fpsCap = Some(0.0))).map(_.field), List("canvas.fpsCap"))
    assertEquals(canvasIssues(Fixtures.rawCanvas(fpsCap = Some(241.0))).map(_.field), List("canvas.fpsCap"))
  }

  test("a canvas number that is not whole is a validation issue, not a rounding") {
    // 1920.5 is well-formed JSON, so it is not a 400; it breaks a rule about the value, which is a
    // 422. Truncating it to 1920 would obey an admin approximately, which is worse than refusing.
    val issues = canvasIssues(Fixtures.rawCanvas(width = Some(1920.5)))
    assertEquals(issues.map(_.field), List("canvas.width"))
    assert(issues.head.message.contains("whole number"), issues.head.message)
  }

  test("every bad canvas value is reported at once rather than one per attempt") {
    val issues = canvasIssues(RawCanvasSettings(width = Some(0.0), height = Some(99999.0), fpsCap = Some(1000.0)))
    assertEquals(issues.map(_.field), List("canvas.width", "canvas.height", "canvas.fpsCap"))
  }

  test("a bad canvas value is reported alongside a bad slug, not instead of it") {
    val raw = Fixtures.rawRoute(slug = "Main Camera", canvas = Some(Fixtures.rawCanvas(width = Some(4.0))))
    Validation.validateRouteInput(raw, findEffect) match {
      case Left(InputError.Invalid(issues)) => assertEquals(issues.map(_.field), List("slug", "canvas.width"))
      case other                            => fail(s"expected an Invalid result, got $other")
    }
  }

  test("a route with no canvas in the request is stored with the defaults") {
    val result = Validation.validateRouteInput(Fixtures.rawRoute(), findEffect)
    assertEquals(result.map(_.canvas), Right(CanvasSettings.Default))
  }

  // ---------------------------------------------------------------------------------------------
  // Preset names and the shared parameter rules
  // ---------------------------------------------------------------------------------------------

  test("a preset name is trimmed, and the trimmed form is what is kept") {
    assertEquals(Validation.validatePresetName("name", "  Neon night\t"), Right("Neon night"))
  }

  test("a preset name of only whitespace is rejected") {
    assertEquals(
      Validation.validatePresetName("name", " \t\n "),
      Left(List(ValidationIssue("name", "must contain at least one non-space character")))
    )
  }

  test("a preset name is measured after trimming, so padding does not push it over the limit") {
    assert(Validation.validatePresetName("name", "  " + "n" * 64 + "  ").isRight)
    assert(Validation.validatePresetName("name", "n" * 65).isLeft)
  }

  test("a preset's parameters are checked by the very same function a route's are") {
    val bad = Map("speed" -> JsonString("fast"))
    val presetIssues = Validation.validatePresetInput(Fixtures.rawPreset(params = bad), findEffect) match {
      case Left(InputError.Invalid(issues)) => issues
      case other                            => fail(s"expected an Invalid result, got $other")
    }
    val routeIssues = Validation.validateRouteInput(Fixtures.rawRoute(params = bad), findEffect) match {
      case Left(InputError.Invalid(issues)) => issues
      case other                            => fail(s"expected an Invalid result, got $other")
    }
    assertEquals(presetIssues, routeIssues)
  }

  test("a preset for an effect nobody has heard of reports the unknown effect and nothing else") {
    assertEquals(
      Validation.validatePresetInput(Fixtures.rawPreset(effectId = "no-such-effect"), findEffect),
      Left(InputError.UnknownEffect("no-such-effect"))
    )
  }

  // ---------------------------------------------------------------------------------------------
  // Import files
  // ---------------------------------------------------------------------------------------------

  test("a valid import file validates to its contents") {
    val file = Fixtures.importFile(routes = List(Fixtures.importRoute()), presets = List(Fixtures.importPreset()))
    Validation.validateImport(file, findEffect) match {
      case Right(contents) =>
        assertEquals(contents.routes.map(_.input.slug.value), List("main-camera"))
        assertEquals(contents.presets.map(_.input.name), List("Neon night"))
      case other => fail(s"expected the file to validate, got $other")
    }
  }

  test("an import file's field paths point at the record inside it") {
    val file = Fixtures.importFile(
      routes = List(Fixtures.importRoute(), Fixtures.importRoute(slug = "Not A Slug")),
      presets = List(Fixtures.importPreset(name = ""))
    )
    assertEquals(
      importIssues(file).map(_.field),
      List("routes[1].slug", "presets[0].name")
    )
  }

  test("a wrong schema version is reported against the schemaVersion field") {
    assertEquals(importIssues(Fixtures.importFile(schemaVersion = 7)).map(_.field), List("schemaVersion"))
  }

  test("a readable createdAt is kept and an unreadable one becomes None") {
    val file = Fixtures.importFile(
      routes = List(
        Fixtures.importRoute(slug = "first-cam", createdAt = Some("2025-01-02T03:04:05Z")),
        Fixtures.importRoute(slug = "second-cam", createdAt = Some("last tuesday")),
        Fixtures.importRoute(slug = "third-cam", createdAt = None)
      )
    )
    Validation.validateImport(file, findEffect) match {
      case Right(contents) =>
        assertEquals(
          contents.routes.map(_.createdAt),
          List(Some(java.time.Instant.parse("2025-01-02T03:04:05Z")), None, None)
        )
      case other => fail(s"expected the file to validate, got $other")
    }
  }

  test("the same slug twice in one file is a problem in its own right") {
    val file = Fixtures.importFile(routes = List(Fixtures.importRoute(), Fixtures.importRoute()))
    assertEquals(importIssues(file).map(_.field), List("routes"))
  }

  test("two presets of one effect whose names differ only in case are a problem in one file") {
    val file = Fixtures.importFile(
      presets = List(Fixtures.importPreset(name = "Neon"), Fixtures.importPreset(name = "  neon  "))
    )
    assertEquals(importIssues(file).map(_.field), List("presets"))
  }

  test("an empty file is valid: restoring nothing is a thing somebody may mean") {
    assert(Validation.validateImport(Fixtures.importFile(), findEffect).isRight)
  }

  /** Runs the import validation and returns the issues, failing the test if the file was accepted. */
  private def importIssues(file: RawImportRequest): List[ValidationIssue] =
    Validation.validateImport(file, findEffect) match {
      case Left(issues) => issues
      case Right(value) => fail(s"expected the file to be rejected, but it validated as $value")
    }

  /** Runs the canvas validation and returns the issues, failing the test if the value was accepted. */
  private def canvasIssues(raw: RawCanvasSettings): List[ValidationIssue] =
    Validation.validateCanvas(Some(raw)) match {
      case Left(issues) => issues
      case Right(value) => fail(s"expected the canvas to be rejected, but it validated as $value")
    }
}
