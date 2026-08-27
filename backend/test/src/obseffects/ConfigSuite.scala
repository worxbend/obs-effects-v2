package obseffects

import munit.FunSuite
import obseffects.application.AuthMode
import obseffects.domain.Passwords

/** How the environment turns into a decision about whether the admin is protected.
  *
  * `AppConfig.load` takes the environment as a function, so a test supplies a `Map` instead of touching the real
  * process environment — which is what makes the fail-closed rule testable at all.
  */
class ConfigSuite extends FunSuite {

  private val TestCost = 4

  private val hash = Passwords.hash("overlay-password", TestCost).value

  private def configFrom(entries: (String, String)*): AppConfig =
    AppConfig.load(entries.toMap.get)

  // -------------------------------------------------------------------------------------------
  // Defaults
  // -------------------------------------------------------------------------------------------

  test("an empty environment produces the documented defaults") {
    val config = configFrom()

    assertEquals(config.mongoUri, AppConfig.DefaultMongoUri)
    assertEquals(config.httpPort, AppConfig.DefaultHttpPort)
    assertEquals(config.sessionTtlHours, 168)
    assertEquals(config.sessionCookieSecure, false)
    assertEquals(config.adminAuthDisabled, false)
    assertEquals(config.corsAllowedOrigins, Nil)
  }

  test("CORS origins are a comma-separated list, trimmed, with blanks dropped") {
    val config = configFrom("CORS_ALLOWED_ORIGINS" -> " http://localhost:3000 , https://overlays.example , ")
    assertEquals(config.corsAllowedOrigins, List("http://localhost:3000", "https://overlays.example"))
  }

  test("only the exact word true switches a flag on") {
    // A setting that turns authentication off is the wrong place to guess what somebody meant by
    // "yes" or "1".
    assertEquals(configFrom("ADMIN_AUTH_DISABLED" -> "TRUE").adminAuthDisabled, true)
    assertEquals(configFrom("ADMIN_AUTH_DISABLED" -> "true").adminAuthDisabled, true)
    assertEquals(configFrom("ADMIN_AUTH_DISABLED" -> "yes").adminAuthDisabled, false)
    assertEquals(configFrom("ADMIN_AUTH_DISABLED" -> "1").adminAuthDisabled, false)
    assertEquals(configFrom("ADMIN_AUTH_DISABLED" -> "").adminAuthDisabled, false)
  }

  // -------------------------------------------------------------------------------------------
  // Whether the server is allowed to start
  // -------------------------------------------------------------------------------------------

  test("a readable hash produces the normal mode") {
    configFrom("ADMIN_PASSWORD_HASH" -> hash).authMode match {
      case Right(AuthMode.Required(parsed)) => assertEquals(parsed.value, hash)
      case other                            => fail(s"expected the normal mode, got $other")
    }
  }

  test("a hash surrounded by whitespace still works, because .env files collect trailing spaces") {
    assert(configFrom("ADMIN_PASSWORD_HASH" -> s"  $hash  ").authMode.isRight)
  }

  test("no hash at all refuses to start, and says which variable is missing") {
    // The heart of the fail-closed rule. Starting unauthenticated with a warning was rejected:
    // `docker compose up -d` shows no logs, so the warning would be read by nobody, and what it
    // guards is an admin panel that can rewrite a live broadcast.
    configFrom().authMode match {
      case Left(message) =>
        assert(message.contains("ADMIN_PASSWORD_HASH"), message)
        assert(message.contains("ADMIN_AUTH_DISABLED"), s"the escape hatch should be named too: $message")
      case Right(mode) => fail(s"an unset password hash must not produce a working mode, got $mode")
    }
  }

  test("a hash set to an empty string counts as unset rather than as an empty password") {
    assert(configFrom("ADMIN_PASSWORD_HASH" -> "   ").authMode.isLeft)
  }

  test("an unreadable hash refuses to start rather than failing on every login attempt") {
    // Detecting this at boot turns one clear start-up failure into what would otherwise be an
    // unexplained 500 the first time somebody tries to sign in.
    configFrom("ADMIN_PASSWORD_HASH" -> "hunter2").authMode match {
      case Left(message) => assert(message.contains("bcrypt"), message)
      case Right(mode)   => fail(s"an unreadable hash must not produce a working mode, got $mode")
    }
  }

  test("the escape hatch starts without a password, and wins over a hash that is also set") {
    // Two explicit instructions that disagree; the one that says "no authentication" is the more
    // specific of the two, and reading it any other way would mean ADMIN_AUTH_DISABLED silently
    // did nothing.
    assertEquals(configFrom("ADMIN_AUTH_DISABLED" -> "true").authMode, Right(AuthMode.Disabled))
    assertEquals(
      configFrom("ADMIN_AUTH_DISABLED" -> "true", "ADMIN_PASSWORD_HASH" -> hash).authMode,
      Right(AuthMode.Disabled)
    )
  }

  // -------------------------------------------------------------------------------------------
  // Session settings
  // -------------------------------------------------------------------------------------------

  test("the session lifetime is read from the environment, and nonsense falls back to the default") {
    assertEquals(configFrom("SESSION_TTL_HOURS" -> "24").sessionTtlHours, 24)
    assertEquals(configFrom("SESSION_TTL_HOURS" -> "0").sessionTtlHours, 168)
    assertEquals(configFrom("SESSION_TTL_HOURS" -> "-5").sessionTtlHours, 168)
    assertEquals(configFrom("SESSION_TTL_HOURS" -> "a week").sessionTtlHours, 168)
  }

  test("the Secure cookie attribute is off unless it is asked for") {
    assertEquals(configFrom().sessionCookieSecure, false)
    assertEquals(configFrom("SESSION_COOKIE_SECURE" -> "true").sessionCookieSecure, true)
  }
}
