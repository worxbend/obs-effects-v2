package obseffects.domain

import obseffects.domain.JsonValue.*

import java.time.Instant

import scala.util.Try
import scala.util.matching.Regex

/** All the rules of section 5 of `docs/CONTRACT.md`, in one place and with no dependency on HTTP or MongoDB.
  *
  * Every entry point takes a "raw" model (the JSON as it arrived) and returns either the validated domain model or the
  * complete list of everything that was wrong with it. Errors are *accumulated* rather than reported one at a time, so
  * the admin UI can highlight every bad field at once.
  */
object Validation {

  /** Six hexadecimal digits after a `#`, e.g. `#ff00aa`. */
  val ColorPattern: Regex = "^#[0-9a-fA-F]{6}$".r

  /** Longest string accepted for a `text` parameter. Keeps a runaway paste out of the database. */
  val MaxTextLength = 1024

  // -------------------------------------------------------------------------------------------
  // Parameter values
  // -------------------------------------------------------------------------------------------

  /** Checks one parameter value against the spec that describes it.
    *
    * @param field
    *   dotted path of the value inside the request body, used in the error message, e.g. `params.speed`.
    * @return
    *   an empty list when the value is acceptable, otherwise one issue explaining the problem.
    */
  def validateParamValue(field: String, spec: ParamSpec, value: JsonValue): List[ValidationIssue] = {
    def issue(message: String): List[ValidationIssue] = List(ValidationIssue(field, message))

    spec.kind match {
      case ParamKind.Number =>
        value match {
          case JsonNumber(n) => validateNumberRange(field, spec, n)
          case other         => issue(s"expected number, got ${typeName(other)}")
        }

      case ParamKind.Color =>
        value match {
          case JsonString(s) if ColorPattern.matches(s) => Nil
          case JsonString(s)                            => issue(s"expected a colour like #ff00aa, got \"$s\"")
          case other                                    => issue(s"expected string, got ${typeName(other)}")
        }

      case ParamKind.Bool =>
        value match {
          case JsonBool(_) => Nil
          case other       => issue(s"expected boolean, got ${typeName(other)}")
        }

      case ParamKind.Select =>
        val allowed = spec.options.getOrElse(Nil)
        value match {
          case JsonString(s) if allowed.contains(s) => Nil
          case JsonString(s)                        => issue(s"\"$s\" is not one of: ${allowed.mkString(", ")}")
          case other                                => issue(s"expected string, got ${typeName(other)}")
        }

      case ParamKind.Text =>
        value match {
          case JsonString(s) if s.length <= MaxTextLength => Nil
          case JsonString(s) => issue(s"text is ${s.length} characters, maximum is $MaxTextLength")
          case other         => issue(s"expected string, got ${typeName(other)}")
        }
    }
  }

  private def validateNumberRange(field: String, spec: ParamSpec, n: Double): List[ValidationIssue] = {
    val tooSmall = spec.min.filter(n < _).map(min => ValidationIssue(field, s"must be >= $min, got $n"))
    val tooLarge = spec.max.filter(n > _).map(max => ValidationIssue(field, s"must be <= $max, got $n"))
    tooSmall.toList ++ tooLarge.toList
  }

  // -------------------------------------------------------------------------------------------
  // Effect descriptors
  // -------------------------------------------------------------------------------------------

  /** Validates one parameter spec. `field` is the path of the spec itself, e.g. `effects[0].params[2]`; the issues it
    * produces extend that path with the field name.
    */
  def validateParamSpec(field: String, raw: RawParamSpec): Either[List[ValidationIssue], ParamSpec] = {
    val keyResult: Either[List[ValidationIssue], ParamKey] =
      ParamKey.parse(raw.key).left.map(msg => List(ValidationIssue(s"$field.key", msg)))

    val kindResult: Either[List[ValidationIssue], ParamKind] =
      ParamKind
        .fromWire(raw.kind)
        .toRight(List(ValidationIssue(s"$field.kind", s"must be one of: ${ParamKind.allNames.mkString(", ")}")))

    // `select` is the one kind whose extra field is mandatory: without options the admin UI would
    // render a dropdown with nothing in it.
    val optionsResult: Either[List[ValidationIssue], Option[List[String]]] =
      (kindResult, raw.options) match {
        case (Right(ParamKind.Select), Some(options)) if options.nonEmpty => Right(Some(options))
        case (Right(ParamKind.Select), _)                                 =>
          Left(List(ValidationIssue(s"$field.options", "a select parameter needs a non-empty options list")))
        case _ => Right(raw.options)
      }

    val structural = combine3(keyResult, kindResult, optionsResult)

    // The default value can only be checked once the kind is known, so it is a second pass over a
    // provisional spec built from the already validated pieces.
    structural.flatMap { (key, kind, options) =>
      val spec = ParamSpec(key, raw.label, kind, raw.default, raw.min, raw.max, raw.step, options, raw.description)
      validateParamValue(s"$field.default", spec, raw.default) match {
        case Nil    => Right(spec)
        case issues => Left(issues)
      }
    }
  }

  /** Validates one effect descriptor coming from the frontend's manifest. */
  def validateDescriptor(field: String, raw: RawEffectDescriptor): Either[List[ValidationIssue], EffectDescriptor] = {
    val idResult: Either[List[ValidationIssue], EffectId] =
      EffectId.parse(raw.id).left.map(msg => List(ValidationIssue(s"$field.id", msg)))

    val engineResult: Either[List[ValidationIssue], Engine] =
      Engine
        .fromWire(raw.engine)
        .toRight(List(ValidationIssue(s"$field.engine", s"must be one of: ${Engine.allNames.mkString(", ")}")))

    val nameResult: Either[List[ValidationIssue], String] =
      if (raw.name.nonEmpty && raw.name.length <= 128) Right(raw.name)
      else Left(List(ValidationIssue(s"$field.name", "must be between 1 and 128 characters")))

    val paramsResult: Either[List[ValidationIssue], List[ParamSpec]] =
      collect(raw.params.zipWithIndex.map { (rawSpec, index) =>
        validateParamSpec(s"$field.params[$index]", rawSpec)
      })

    val duplicateKeys: List[ValidationIssue] =
      duplicates(raw.params.map(_.key)).map(key => ValidationIssue(s"$field.params", s"duplicate parameter key '$key'"))

    combine4(idResult, engineResult, nameResult, paramsResult) match {
      case Left(issues)                       => Left(issues ++ duplicateKeys)
      case Right(_) if duplicateKeys.nonEmpty => Left(duplicateKeys)
      case Right((id, engine, name, params))  =>
        Right(
          EffectDescriptor(id, name, raw.description, engine, raw.category, raw.tags, raw.previewNotes, params)
        )
    }
  }

  /** Validates the whole manifest sent to `POST /api/effects/sync`, including the rule that no two descriptors may
    * share an id.
    */
  def validateManifest(raws: List[RawEffectDescriptor]): Either[List[ValidationIssue], List[EffectDescriptor]] = {
    val descriptors = collect(raws.zipWithIndex.map { (raw, index) => validateDescriptor(s"effects[$index]", raw) })
    val duplicateIds =
      duplicates(raws.map(_.id)).map(id => ValidationIssue("effects", s"duplicate effect id '$id'"))

    (descriptors, duplicateIds) match {
      case (Left(issues), extra)               => Left(issues ++ extra)
      case (Right(_), extra) if extra.nonEmpty => Left(extra)
      case (Right(valid), _)                   => Right(valid)
    }
  }

  // -------------------------------------------------------------------------------------------
  // Canvas settings
  // -------------------------------------------------------------------------------------------

  /** Turns the `canvas` object of a request into validated settings, filling in a default for every key that is not
    * there.
    *
    * Three levels of "absent" all end up as the same defaults, which is what the contract asks for: the whole object
    * missing, the object present with a key missing, and `"fpsCap": null`. This is a deliberate exception to the rule
    * that a `PUT` replaces everything, and it is limited to this one object — unlike `params`, these three fields have
    * fixed, universal defaults, so there is nothing an admin form could lose by not sending them.
    *
    * @param raw
    *   the object as it arrived, or `None` when the request had no `canvas` field at all.
    */
  def validateCanvas(
      raw: Option[RawCanvasSettings],
      prefix: String = ""
  ): Either[List[ValidationIssue], CanvasSettings] = {
    val settings = raw.getOrElse(RawCanvasSettings(None, None, None))

    val width =
      wholeNumber(path(prefix, "canvas.width"), settings.width, CanvasSettings.MinWidth, CanvasSettings.MaxWidth)
        .map(_.getOrElse(CanvasSettings.DefaultWidth))

    val height =
      wholeNumber(path(prefix, "canvas.height"), settings.height, CanvasSettings.MinHeight, CanvasSettings.MaxHeight)
        .map(_.getOrElse(CanvasSettings.DefaultHeight))

    // No `getOrElse` here: an absent cap stays absent, because "uncapped" is what None means.
    val fpsCap =
      wholeNumber(path(prefix, "canvas.fpsCap"), settings.fpsCap, CanvasSettings.MinFpsCap, CanvasSettings.MaxFpsCap)

    combine3(width, height, fpsCap).map { (validWidth, validHeight, validFpsCap) =>
      CanvasSettings(validWidth, validHeight, validFpsCap)
    }
  }

  /** Checks one optional canvas number: present or not, whole or not, in range or not.
    *
    * "Whole" is checked rather than assumed because JSON has one number type and the raw model therefore carries a
    * `Double`. `1920.5` has to come out of here as a validation issue (422), not as a decoding failure (400) and not as
    * a silent truncation to 1920 — an admin who typed a fraction deserves to be told, not obeyed approximately.
    */
  private def wholeNumber(
      field: String,
      value: Option[Double],
      min: Int,
      max: Int
  ): Either[List[ValidationIssue], Option[Int]] = {
    def issue(message: String): Either[List[ValidationIssue], Option[Int]] =
      Left(List(ValidationIssue(field, message)))

    value match {
      case None => Right(None)

      case Some(number) if number.isNaN || number.isInfinite =>
        issue("must be a whole number")

      case Some(number) if number != Math.rint(number) =>
        issue(s"must be a whole number, got $number")

      case Some(number) if number < min.toDouble || number > max.toDouble =>
        issue(s"must be between $min and $max, got ${withoutTrailingZero(number)}")

      case Some(number) => Right(Some(number.toInt))
    }
  }

  /** Prints a whole `Double` the way a person wrote it — `8000` rather than `8000.0` — so an error message repeats the
    * number the admin typed. Values too large for a `Long` keep their exponent form rather than being clamped to
    * something that never appeared in the request.
    */
  private def withoutTrailingZero(number: Double): String =
    if (number == Math.rint(number) && Math.abs(number) < 1e15) number.toLong.toString else number.toString

  // -------------------------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------------------------

  /** Checks a whole `params` object against the effect that owns it, and is the *only* place that rule is written.
    *
    * Routes and presets both carry a sparse `params` map with exactly the same meaning, so they share this function
    * rather than each keeping a copy that could drift. A second copy of this loop is how "the route editor rejects a
    * typo but the preset editor stores it" happens.
    *
    * Keys are sorted before checking so the issues come back in a stable order, which makes the error message and the
    * tests deterministic rather than dependent on how a `Map` happens to be laid out.
    *
    * @param prefix
    *   the dotted path of the object holding `params`. Empty for a create/update body, so the paths read
    *   `params.speed`; `routes[3]` inside an import file, so they read `routes[3].params.speed`.
    */
  def validateParams(
      prefix: String,
      descriptor: EffectDescriptor,
      params: Map[String, JsonValue]
  ): List[ValidationIssue] =
    params.toList.sortBy(_._1).flatMap { (key, value) =>
      val field = path(prefix, s"params.$key")
      descriptor.paramsByKey.get(ParamKey.unsafe(key)) match {
        case Some(spec) => validateParamValue(field, spec, value)
        // Unknown keys are rejected rather than dropped: a silently ignored typo would look
        // like "my setting does nothing" to the admin.
        case None => List(ValidationIssue(field, s"effect '${descriptor.id.value}' has no parameter '$key'"))
      }
    }

  /** Validates a route create/update body.
    *
    * @param prefix
    *   the dotted path this body sits at. Empty for `POST /api/routes`, where the contract's field paths are `slug` and
    *   `params.speed`; `routes[3]` for the fourth route of an import file.
    * @param findEffect
    *   how to look an effect up in the inventory. Passing this in as a function keeps the domain free of any repository
    *   or database type.
    */
  def validateRouteInput(
      raw: RawRouteInput,
      findEffect: String => Option[EffectDescriptor],
      prefix: String = ""
  ): Either[InputError, RouteInput] = {
    val slugResult: Either[List[ValidationIssue], Slug] =
      Slug.parse(raw.slug).left.map(msg => List(ValidationIssue(path(prefix, "slug"), msg)))

    val canvasResult: Either[List[ValidationIssue], CanvasSettings] = validateCanvas(raw.canvas, prefix)

    findEffect(raw.effectId) match {
      // The effect is unknown, so the parameters cannot be checked at all: report that alone,
      // which the HTTP layer turns into UNKNOWN_EFFECT.
      case None => Left(InputError.UnknownEffect(raw.effectId))

      case Some(descriptor) =>
        val paramIssues = validateParams(prefix, descriptor, raw.params)

        combine2(slugResult, canvasResult) match {
          case Left(issues)                     => Left(InputError.Invalid(issues ++ paramIssues))
          case Right(_) if paramIssues.nonEmpty => Left(InputError.Invalid(paramIssues))
          case Right((slug, canvas))            =>
            val params = raw.params.map((key, value) => ParamKey.unsafe(key) -> value)
            Right(RouteInput(slug, descriptor.id, raw.enabled, params, canvas))
        }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Presets
  // -------------------------------------------------------------------------------------------

  /** Longest preset name, measured after trimming. 64 characters is enough for "Warm ambient, low motion" twice over
    * and short enough to fit in a dropdown.
    */
  val MaxPresetNameLength = 64

  /** Validates a preset create/update body.
    *
    * The `effectId` and `params` rules are the route's rules, run by the same functions — `docs/CONTRACT.md` §5 rule 11
    * says so in as many words. The only rule of a preset's own is its name.
    *
    * @param prefix
    *   the dotted path this body sits at, empty outside an import file. See [[validateRouteInput]].
    */
  def validatePresetInput(
      raw: RawPresetInput,
      findEffect: String => Option[EffectDescriptor],
      prefix: String = ""
  ): Either[InputError, PresetInput] = {
    val nameResult = validatePresetName(path(prefix, "name"), raw.name)

    findEffect(raw.effectId) match {
      case None => Left(InputError.UnknownEffect(raw.effectId))

      case Some(descriptor) =>
        val paramIssues = validateParams(prefix, descriptor, raw.params)

        (nameResult, paramIssues) match {
          case (Left(issues), extra)               => Left(InputError.Invalid(issues ++ extra))
          case (Right(_), extra) if extra.nonEmpty => Left(InputError.Invalid(extra))
          case (Right(name), _)                    =>
            val params = raw.params.map((key, value) => ParamKey.unsafe(key) -> value)
            Right(PresetInput(name, descriptor.id, params))
        }
    }
  }

  /** The one rule a preset name has to obey, and the one place it is written.
    *
    * The name is trimmed first and the *trimmed* form is what gets stored, so " Neon night " and "Neon night" are the
    * same preset rather than two that look identical in a list. A name of nothing but whitespace trims to an empty
    * string and is therefore rejected by the same length check, which is why there is no separate "contains a non-space
    * character" test: `String.trim` removes every character up to and including the space, tabs and newlines included.
    */
  def validatePresetName(field: String, raw: String): Either[List[ValidationIssue], String] = {
    val trimmed = raw.trim
    if (trimmed.isEmpty) Left(List(ValidationIssue(field, "must contain at least one non-space character")))
    else if (trimmed.length > MaxPresetNameLength)
      Left(
        List(
          ValidationIssue(field, s"is ${trimmed.length} characters after trimming, maximum is $MaxPresetNameLength")
        )
      )
    else Right(trimmed)
  }

  // -------------------------------------------------------------------------------------------
  // Import files
  // -------------------------------------------------------------------------------------------

  /** Validates a whole import file: the schema version, every route, every preset, and the two "the file contradicts
    * itself" rules.
    *
    * **Nothing here writes anything, and that is the point.** The contract makes an import all-or-nothing: one problem
    * anywhere rejects the entire file and every problem is reported together, so an operator fixing a hand-edited
    * backup sees the whole list at once instead of discovering the next one on each retry. A `Right` from this function
    * is the only way to obtain the [[ImportContents]] the importer needs, so it is not possible to start writing a file
    * that has not been checked from end to end.
    *
    * An unknown `effectId` is reported here as an ordinary validation issue rather than as
    * [[InputError.UnknownEffect]]. A single create answers `422 UNKNOWN_EFFECT` because there is one effect id to talk
    * about; a bulk operation has to be able to say "records 3, 7 and 12 name effects that do not exist" in one
    * response, and the contract says so explicitly.
    *
    * @param findEffect
    *   how to look an effect up in the inventory, exactly as for a single route or preset.
    */
  def validateImport(
      raw: RawImportRequest,
      findEffect: String => Option[EffectDescriptor]
  ): Either[List[ValidationIssue], ImportContents] = {
    val versionIssues =
      if (raw.schemaVersion == BackupEnvelope.CurrentSchemaVersion) Nil
      else
        List(
          ValidationIssue(
            "schemaVersion",
            s"this build reads version ${BackupEnvelope.CurrentSchemaVersion} only, got ${raw.schemaVersion}"
          )
        )

    val routeResults = raw.routes.zipWithIndex.map { (entry, index) =>
      val field = s"routes[$index]"
      validateRouteInput(entry.route, findEffect, field) match {
        case Left(InputError.Invalid(issues))         => Left(issues)
        case Left(InputError.UnknownEffect(effectId)) =>
          Left(List(ValidationIssue(s"$field.effectId", s"no effect with id '$effectId' is registered")))
        case Right(input) => Right(ImportRouteEntry(input, parseInstant(entry.createdAt)))
      }
    }

    val presetResults = raw.presets.zipWithIndex.map { (entry, index) =>
      val field = s"presets[$index]"
      validatePresetInput(entry.preset, findEffect, field) match {
        case Left(InputError.Invalid(issues))         => Left(issues)
        case Left(InputError.UnknownEffect(effectId)) =>
          Left(List(ValidationIssue(s"$field.effectId", s"no effect with id '$effectId' is registered")))
        case Right(input) => Right(ImportPresetEntry(input, parseInstant(entry.createdAt)))
      }
    }

    // Two records in one file claiming the same natural key have no defined answer: in "merge"
    // mode both would match the same stored document and the second would silently win, and in
    // "replace" mode the unique index would reject the second insert halfway through the restore.
    // Saying so up front is the only honest option.
    val duplicateSlugs =
      duplicates(raw.routes.map(_.route.slug)).map(slug => ValidationIssue("routes", s"duplicate slug '$slug'"))

    val duplicateNames =
      duplicates(raw.presets.map(entry => s"${entry.preset.effectId}/${entry.preset.name.trim.toLowerCase}"))
        .map(key => ValidationIssue("presets", s"duplicate effect and preset name '$key'"))

    val issues =
      versionIssues ++
        routeResults.collect { case Left(is) => is }.flatten ++
        presetResults.collect { case Left(is) => is }.flatten ++
        duplicateSlugs ++
        duplicateNames

    if (issues.nonEmpty) Left(issues)
    else
      Right(
        ImportContents(
          routes = routeResults.collect { case Right(entry) => entry },
          presets = presetResults.collect { case Right(entry) => entry }
        )
      )
  }

  /** Reads a timestamp out of an import file. Anything that is not an ISO-8601 instant becomes `None`, and the importer
    * substitutes the import time — see [[ImportRouteEntry]] for why that is preferred to rejecting the file.
    */
  private def parseInstant(raw: Option[String]): Option[Instant] =
    raw.flatMap(value => Try(Instant.parse(value)).toOption)

  // -------------------------------------------------------------------------------------------
  // Small helpers for accumulating issues
  // -------------------------------------------------------------------------------------------

  /** Joins a path prefix to a field name: `("", "slug")` is `slug`, `("routes[3]", "slug")` is `routes[3].slug`.
    *
    * The prefix exists because the same body is validated in two contexts. A `POST /api/routes` reports a bad slug as
    * `slug`, while the same object as the fourth entry of an import file has to report it as `routes[3].slug` — the
    * contract asks for paths that point into the file so an operator can find the line to fix.
    */
  private def path(prefix: String, field: String): String = if (prefix.isEmpty) field else s"$prefix.$field"

  /** Turns a list of individually validated items into either every issue found, or every value. */
  private def collect[A](results: List[Either[List[ValidationIssue], A]]): Either[List[ValidationIssue], List[A]] = {
    val issues = results.collect { case Left(is) => is }.flatten
    if (issues.nonEmpty) Left(issues) else Right(results.collect { case Right(a) => a })
  }

  private def combine2[A, B](
      a: Either[List[ValidationIssue], A],
      b: Either[List[ValidationIssue], B]
  ): Either[List[ValidationIssue], (A, B)] = {
    val issues = List(a, b).collect { case Left(is) => is }.flatten
    if (issues.nonEmpty) Left(issues)
    else
      for { av <- a; bv <- b } yield (av, bv)
  }

  private def combine3[A, B, C](
      a: Either[List[ValidationIssue], A],
      b: Either[List[ValidationIssue], B],
      c: Either[List[ValidationIssue], C]
  ): Either[List[ValidationIssue], (A, B, C)] = {
    val issues = List(a, b, c).collect { case Left(is) => is }.flatten
    if (issues.nonEmpty) Left(issues)
    else
      for { av <- a; bv <- b; cv <- c } yield (av, bv, cv)
  }

  private def combine4[A, B, C, D](
      a: Either[List[ValidationIssue], A],
      b: Either[List[ValidationIssue], B],
      c: Either[List[ValidationIssue], C],
      d: Either[List[ValidationIssue], D]
  ): Either[List[ValidationIssue], (A, B, C, D)] = {
    val issues = List(a, b, c, d).collect { case Left(is) => is }.flatten
    if (issues.nonEmpty) Left(issues)
    else
      for { av <- a; bv <- b; cv <- c; dv <- d } yield (av, bv, cv, dv)
  }

  /** Every value that appears more than once, in first-seen order. */
  private def duplicates(values: List[String]): List[String] =
    values.groupBy(identity).collect { case (value, occurrences) if occurrences.size > 1 => value }.toList.sorted
}
