package obseffects.domain

import scala.util.matching.Regex

/** The identifier types of the domain.
  *
  * These are *opaque types*: at compile time `Slug` and `EffectId` are different types, so you cannot accidentally pass
  * a route slug where an effect id is expected, but at runtime they are plain `String`s with no wrapper object and no
  * cost.
  *
  * Every identifier is built through `parse`, which is the only place the format rules live. If a value of type `Slug`
  * exists, it is a valid slug — invalid ones never get past the front door.
  */

/** A user-chosen name for a route, used in the OBS browser-source URL: `/e/main-camera`. */
opaque type Slug = String

object Slug {

  /** Lowercase letters, digits and hyphens; must start with a letter or digit; 1 to 64 characters. */
  val Pattern: Regex = "^[a-z0-9][a-z0-9-]{0,63}$".r

  def parse(raw: String): Either[String, Slug] =
    if (Pattern.matches(raw)) Right(raw)
    else Left(s"must match ${Pattern.regex}")

  /** Escape hatch for values that are known-good, e.g. read back out of the database or written literally in a test.
    * Never call this on data that came straight from an HTTP request.
    */
  def unsafe(raw: String): Slug = raw

  extension (slug: Slug) def value: String = slug

  given Ordering[Slug] = Ordering.String
}

/** The id of an effect implementation, e.g. `plasma-field`. Chosen by the frontend, not the server. */
opaque type EffectId = String

object EffectId {

  /** Deliberately the same shape as a slug: both are human-readable url-safe names. */
  val Pattern: Regex = "^[a-z0-9][a-z0-9-]{0,63}$".r

  def parse(raw: String): Either[String, EffectId] =
    if (Pattern.matches(raw)) Right(raw)
    else Left(s"must match ${Pattern.regex}")

  def unsafe(raw: String): EffectId = raw

  extension (id: EffectId) def value: String = id

  given Ordering[EffectId] = Ordering.String
}

/** The database id of a stored route: the 24-character hexadecimal string form of a MongoDB ObjectId (MongoDB's
  * automatically generated primary key).
  */
opaque type RouteId = String

object RouteId {

  val Pattern: Regex = "^[0-9a-fA-F]{24}$".r

  def parse(raw: String): Either[String, RouteId] =
    if (Pattern.matches(raw)) Right(raw.toLowerCase)
    else Left("must be a 24-character hexadecimal ObjectId")

  def unsafe(raw: String): RouteId = raw

  extension (id: RouteId) def value: String = id
}

/** The name of one knob of an effect, e.g. `speed`. It ends up as a JavaScript object key, hence the identifier-like
  * format rather than the hyphenated slug format.
  */
opaque type ParamKey = String

object ParamKey {

  val Pattern: Regex = "^[a-zA-Z][a-zA-Z0-9_]{0,63}$".r

  def parse(raw: String): Either[String, ParamKey] =
    if (Pattern.matches(raw)) Right(raw)
    else Left(s"must match ${Pattern.regex}")

  def unsafe(raw: String): ParamKey = raw

  extension (key: ParamKey) def value: String = key

  given Ordering[ParamKey] = Ordering.String
}

/** The database id of a stored preset: the same 24-character hexadecimal ObjectId shape as [[RouteId]].
  *
  * It is a *separate* type rather than a reuse of `RouteId`, even though the two hold the same characters, because the
  * only thing an id type buys is the compiler refusing to let you pass one where the other belongs. Merging them would
  * throw that away to save a dozen lines.
  */
opaque type PresetId = String

object PresetId {

  val Pattern: Regex = "^[0-9a-fA-F]{24}$".r

  def parse(raw: String): Either[String, PresetId] =
    if (Pattern.matches(raw)) Right(raw.toLowerCase)
    else Left("must be a 24-character hexadecimal ObjectId")

  def unsafe(raw: String): PresetId = raw

  extension (id: PresetId) def value: String = id
}

/** The database id of a stored sound: the same 24-character hexadecimal ObjectId shape as [[RouteId]], separate for the
  * same reason [[PresetId]] is — the compiler refusing to let a sound id go where a route id belongs is the whole
  * point.
  */
opaque type SoundId = String

object SoundId {

  val Pattern: Regex = "^[0-9a-fA-F]{24}$".r

  def parse(raw: String): Either[String, SoundId] =
    if (Pattern.matches(raw)) Right(raw.toLowerCase)
    else Left("must be a 24-character hexadecimal ObjectId")

  def unsafe(raw: String): SoundId = raw

  extension (id: SoundId) def value: String = id
}
