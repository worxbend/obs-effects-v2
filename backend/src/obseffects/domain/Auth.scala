package obseffects.domain

import at.favre.lib.crypto.bcrypt.{BCrypt, LongPasswordStrategies, LongPasswordStrategy}

import java.nio.charset.StandardCharsets
import java.security.{MessageDigest, SecureRandom}
import java.util.{Arrays as JavaArrays, Base64}

import scala.util.matching.Regex

/** The two authentication primitives of the domain: checking a password against a stored hash, and minting the random
  * token that identifies a signed-in session.
  *
  * Both live here, next to the rest of the model, for the same reason `Slug` does: they are rules about values, they
  * hold no state, and they can be tested without an HTTP server, a database or a clock. The *policy* built on top of
  * them — how long a session lasts, how many failed logins are tolerated — is the application layer's business and
  * lives in `application/Sessions.scala`.
  *
  * The only third-party import in this file is the bcrypt implementation. A hashing algorithm is a piece of
  * mathematics, not a framework: nothing about it ties the domain to tapir, to MongoDB or to any particular way of
  * delivering the application.
  */

/** A bcrypt password hash in *modular crypt format* — the 60-character string that starts with `$2a$`, `$2b$`, `$2x$`
  * or `$2y$` and that tools like Apache's `htpasswd` print.
  *
  * The type exists so that "a string that has been checked to be a usable bcrypt hash" is a different thing from "some
  * string an operator put in an environment variable". Once a `PasswordHash` value exists, the server knows it can
  * verify passwords against it, which is what lets `Main` refuse to start on a typo instead of answering `500` to every
  * login attempt for the rest of the day.
  */
opaque type PasswordHash = String

object PasswordHash {

  /** The shape of a bcrypt hash, spelled out piece by piece:
    *
    *   - `$2a$`, `$2b$`, `$2x$` or `$2y$` — the algorithm version. All four are accepted because different tools emit
    *     different ones: `htpasswd` writes `$2y$`, most Python and Node libraries write `$2b$`.
    *   - two digits from `04` to `31` — the *cost factor*, the base-2 logarithm of how many rounds are run. 12 is what
    *     this project's documentation recommends.
    *   - 53 characters from bcrypt's own base-64 alphabet — the 22-character salt followed by the 31-character digest.
    *
    * Anything that matches this can be parsed by the bcrypt library; anything that does not is rejected at start-up
    * with a message naming the variable.
    */
  val Pattern: Regex = "^\\$2[abxy]\\$(0[4-9]|[12][0-9]|3[01])\\$[./A-Za-z0-9]{53}$".r

  def parse(raw: String): Either[String, PasswordHash] =
    if (Pattern.matches(raw)) Right(raw)
    else
      Left(
        "must be a bcrypt hash in modular crypt format: 60 characters beginning $2a$, $2b$, $2x$ or $2y$, " +
          "then a two-digit cost between 04 and 31, then 53 more characters"
      )

  /** Escape hatch for a value that is known to be a hash already, for example one written literally in a test. Never
    * call it on a string that came from outside the process.
    */
  def unsafe(raw: String): PasswordHash = raw

  extension (hash: PasswordHash) def value: String = hash
}

/** Checking a password against a hash. */
object Passwords {

  /** The longest password the API accepts, from `docs/CONTRACT.md` §5 rule 13. bcrypt itself only looks at the first 72
    * bytes, so the cap is not about the algorithm: it stops a caller pushing a multi-megabyte body through the hash
    * function over and over.
    */
  val MaxPasswordLength = 1024

  /** What to do with a password longer than the 72 bytes bcrypt can read: cut it to that length, which is what every
    * other bcrypt implementation does.
    *
    * This library's default is to refuse instead — it throws an `IllegalArgumentException` — on the reasonable ground
    * that silently ignoring the end of somebody's passphrase is surprising. That default is the wrong one *here*, for
    * two separate reasons, and both are worth writing down because the choice looks like a weakening and is not:
    *
    *   1. **A throw here is a `500` on the login endpoint.** An operator with a 90-character passphrase would get an
    *      unexplained server error instead of an answer, on every attempt.
    *   2. **The hash may not have been made by this project.** `htpasswd`, Python's `bcrypt` and Node's `bcrypt` all
    *      truncate at 72 bytes, so a hash generated with a long passphrase by any of them encodes only its first 72
    *      bytes. Refusing to truncate would lock that operator out of a hash that is perfectly valid everywhere else.
    *
    * Nothing about a password of 72 bytes or fewer changes, which is every password anyone is realistically typing.
    */
  private val LongPasswords: LongPasswordStrategy =
    LongPasswordStrategies.truncate(BCrypt.Version.VERSION_2A)

  /** True when `password` is the password that produced `hash`.
    *
    * bcrypt's verifier re-derives the hash using the salt and cost stored inside `hash` itself, then compares the two
    * digests in constant time. That comparison is the library's, not ours; there is nothing to hand-roll here.
    *
    * The version marker (`$2a$`, `$2b$`, `$2x$` or `$2y$`) is read out of the hash, so the `VERSION_2A` named below is
    * not a restriction on which hashes are accepted — it only tells the truncation rule above how many bytes fit. A
    * hash from `htpasswd` (`$2y$`) and one from a Python library (`$2b$`) are both verified correctly.
    *
    * The password is copied into a `char` array and that array is overwritten with zeros afterwards. The original
    * `String` still sits in memory until the garbage collector reclaims it — Java strings cannot be wiped — so this is
    * a small reduction in how long the secret is readable in a heap dump rather than a guarantee.
    *
    * It never throws. A hash that cannot be parsed at all comes back as "not verified" rather than as an exception,
    * which matters because an exception on this path would be a `500` where the contract promises a `401`.
    */
  def verify(password: String, hash: PasswordHash): Boolean = {
    val characters = password.toCharArray
    try BCrypt.verifyer(BCrypt.Version.VERSION_2A, LongPasswords).verify(characters, hash.value.toCharArray).verified
    finally JavaArrays.fill(characters, NullCharacter)
  }

  /** The bcrypt *cost factor* this project recommends.
    *
    * The cost is a base-2 logarithm: 12 means 2^12 = 4096 rounds, which takes roughly a quarter of a second on ordinary
    * hardware. That slowness is the whole point — enough that guessing passwords in bulk is impractical, little enough
    * that one person signing in does not notice. The lowest value bcrypt accepts is 4, which is useful only for tests
    * that would otherwise spend most of their time hashing.
    */
  val RecommendedCost = 12

  /** Produces a hash for a password: the value an operator puts in `ADMIN_PASSWORD_HASH`.
    *
    * The running server never calls this — verifying is all it ever needs to do. It exists for the command-line helper
    * in `tools/HashPassword.scala`, because without a way to make a hash nobody can sign in, and for the tests, which
    * would otherwise have to paste in an opaque 60-character literal that no reader could check.
    *
    * The salt comes from a `SecureRandom` inside the library and is stored inside the result, which is why hashing the
    * same password twice never produces the same string, and why verifying needs nothing but the hash itself.
    */
  def hash(password: String, cost: Int = RecommendedCost): PasswordHash = {
    val characters = password.toCharArray
    try PasswordHash.unsafe(BCrypt.`with`(BCrypt.Version.VERSION_2A, LongPasswords).hashToString(cost, characters))
    finally JavaArrays.fill(characters, NullCharacter)
  }

  /** The character an emptied buffer is filled with. It is named rather than written inline because a literal NUL
    * between two quotes is invisible in a diff and easy to mistake for a space.
    */
  private val NullCharacter: Char = '\u0000'
}

/** The value of the `obs_effects_session` cookie: 32 random bytes, Base64url-encoded without padding, which comes to
  * exactly 43 characters.
  *
  * The token carries no information at all — no operator name, no expiry, no signature. The server keeps the session
  * record and looking a token up is one map access, so there is nothing a token needs to say beyond "I am this
  * particular session". A value that says nothing also cannot be tampered with into saying something else.
  */
opaque type SessionToken = String

object SessionToken {

  /** How many random bytes go into a token. 32 bytes is 256 bits: far beyond anything guessable. */
  val ByteLength = 32

  /** 32 bytes in Base64 without padding is 43 characters. Every token has exactly this length, which matters for the
    * constant-time comparison below.
    */
  val EncodedLength = 43

  /** The Base64url alphabet: letters, digits, `-` and `_`. No `+`, `/` or `=`, so the value needs no escaping in a
    * cookie.
    */
  private val Pattern: Regex = s"^[A-Za-z0-9_-]{$EncodedLength}$$".r

  /** Mints a fresh token.
    *
    * @param random
    *   the source of randomness, passed in rather than created here so that the caller owns the (single, shared)
    *   `SecureRandom` instance. It must be a `SecureRandom`: `scala.util.Random` and `java.util.Random` are predictable
    *   from a handful of outputs, which for a session token means anyone can mint their own.
    */
  def generate(random: SecureRandom): SessionToken = {
    val bytes = new Array[Byte](ByteLength)
    random.nextBytes(bytes)
    Base64.getUrlEncoder.withoutPadding.encodeToString(bytes)
  }

  /** Reads a token out of a cookie header. Returns `None` for anything that is not the exact shape `generate` produces,
    * so a malformed or absurdly long cookie is discarded before it reaches any comparison.
    */
  def parse(raw: String): Option[SessionToken] = Option.when(Pattern.matches(raw))(raw)

  /** Escape hatch for a value known to be a token, e.g. one written literally in a test. */
  def unsafe(raw: String): SessionToken = raw

  extension (token: SessionToken) {

    def value: String = token

    /** Compares two tokens in *constant time*: the answer takes the same amount of time whether the tokens differ in
      * the first character or not at all.
      *
      * Why that matters. `==` on a `String` stops at the first character that differs. An attacker who can measure how
      * long the server took to answer therefore learns how many leading characters of their guess were right, and can
      * rebuild the token one character at a time instead of trying every one of them. Timing differences over a network
      * are noisy, but they are measurable with enough samples, and the fix costs nothing.
      *
      * `MessageDigest.isEqual` is the JDK's timing-safe byte-array comparison. It does return early when the two arrays
      * have different lengths, which would leak the length — that is not a problem here because every token produced by
      * [[generate]] is exactly [[EncodedLength]] characters and [[parse]] rejects anything else, so both sides are
      * always the same length by construction.
      */
    def matches(other: SessionToken): Boolean =
      MessageDigest.isEqual(
        token.getBytes(StandardCharsets.UTF_8),
        other.getBytes(StandardCharsets.UTF_8)
      )
  }
}
