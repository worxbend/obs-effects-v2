package obseffects

import obseffects.application.AuthMode
import obseffects.domain.PasswordHash

/** Everything the service needs to know about its environment.
  *
  * Configuration comes from environment variables because that is what Docker Compose sets; each one has a default that
  * matches the compose file, so the service also starts with no configuration at all — with one deliberate exception,
  * `ADMIN_PASSWORD_HASH`, which has no safe default and is explained under [[AppConfig.authMode]].
  *
  * @param mongoUri
  *   MongoDB connection string, e.g. `mongodb://mongo:27017`.
  * @param mongoDatabase
  *   which database inside that server to use.
  * @param httpPort
  *   the port the tapir/netty server listens on.
  * @param adminPasswordHash
  *   the bcrypt hash the admin password is checked against, exactly as it was found in the environment. It is kept as a
  *   plain `String` here and parsed by [[AppConfig.authMode]], so that a typo produces one clear start-up message
  *   rather than an exception thrown while reading the environment.
  * @param adminAuthDisabled
  *   the explicit escape hatch: `true` runs with no authentication at all.
  * @param sessionTtlHours
  *   how long a session lasts, and the cookie's `Max-Age`.
  * @param sessionCookieSecure
  *   whether the session cookie carries the `Secure` attribute. Off by default because this is normally served over
  *   plain `http://localhost`; turn it on the moment the admin is reached over HTTPS.
  * @param corsAllowedOrigins
  *   exact origins allowed to send *credentialed* cross-origin requests. Empty keeps the wildcard, no-credentials mode.
  */
final case class AppConfig(
    mongoUri: String,
    mongoDatabase: String,
    httpPort: Int,
    adminPasswordHash: Option[String],
    adminAuthDisabled: Boolean,
    sessionTtlHours: Int,
    sessionCookieSecure: Boolean,
    corsAllowedOrigins: List[String]
) {

  /** Decides how this server authenticates, or explains why it cannot start.
    *
    * There are exactly three outcomes:
    *
    *   - `ADMIN_AUTH_DISABLED=true` — run with no authentication. This wins over everything else, including a hash that
    *     is also set, because it is the more explicit instruction of the two.
    *   - a readable `ADMIN_PASSWORD_HASH` — the normal mode.
    *   - anything else — a `Left` carrying the message `Main` prints before exiting with status 1.
    *
    * **Why a missing hash is fatal rather than a warning.** The alternative, starting unauthenticated and logging a
    * warning, was considered and rejected: `docker compose up -d` prints no logs at all, so the warning is read by
    * nobody, and what it guards is an admin panel that lets anyone who can reach the port rewrite what a live broadcast
    * is showing. That port is frequently forwarded so a co-host can drive the overlays. Failing closed is the only
    * default under which forgetting the variable cannot end in an unprotected admin.
    *
    * An unreadable hash is fatal for a smaller reason: it turns one clear start-up failure into what would otherwise be
    * an unexplained `500` on every login attempt.
    */
  def authMode: Either[String, AuthMode] =
    if (adminAuthDisabled) Right(AuthMode.Disabled)
    else
      adminPasswordHash match {
        case None =>
          Left(
            "ADMIN_PASSWORD_HASH is not set, so there is no password to check and the admin API would be open to " +
              "anyone who can reach this port.\n" +
              // The `| cut` runs INSIDE the container on purpose. `docker run -t` gives the container a
              // terminal and merges its output onto it, so a pipe placed outside — `docker run ... | cut` —
              // swallows the "New password:" prompt and leaves the operator typing at a blank screen.
              // Keeping the pipe inside leaves the prompt on stderr, where the terminal still shows it,
              // and sends only the hash through `cut`.
              "  Generate a hash:  docker run --rm -it httpd:2.4-alpine sh -c 'htpasswd -nBC 12 \"\" | cut -d: -f2'\n" +
              "  Put it in .env as ADMIN_PASSWORD_HASH, in single quotes (a bcrypt hash is full of '$').\n" +
              "  Running without any password is possible but must be asked for: set ADMIN_AUTH_DISABLED=true."
          )

        case Some(raw) =>
          PasswordHash
            .parse(raw)
            .left
            .map(problem =>
              s"ADMIN_PASSWORD_HASH is set but cannot be read as a bcrypt hash: it $problem.\n" +
                "  Check what actually arrived:  docker compose exec backend printenv ADMIN_PASSWORD_HASH\n" +
                "  A shell or a compose file that is not quoting the value will eat the '$' signs in it."
            )
            .map(AuthMode.Required.apply)
      }
}

object AppConfig {

  val DefaultMongoUri = "mongodb://mongo:27017"
  val DefaultMongoDatabase = "obs_effects"
  val DefaultHttpPort = 8080

  /** Seven days, matching `docs/CONTRACT.md` §7. */
  val DefaultSessionTtlHours = 168

  /** Reads the configuration from the process environment.
    *
    * @param env
    *   how to look a variable up. Passing it in (instead of calling `sys.env` inside) keeps this function pure and
    *   testable.
    */
  def load(env: String => Option[String] = sys.env.get): AppConfig =
    AppConfig(
      mongoUri = env("MONGO_URI").filter(_.nonEmpty).getOrElse(DefaultMongoUri),
      mongoDatabase = env("MONGO_DB").filter(_.nonEmpty).getOrElse(DefaultMongoDatabase),
      httpPort = env("HTTP_PORT").flatMap(_.toIntOption).getOrElse(DefaultHttpPort),
      // `.map(_.trim)` before the emptiness check because a value that arrives as a stray space is
      // a value nobody meant to set, and treating it as "set" would produce a confusing refusal.
      adminPasswordHash = env("ADMIN_PASSWORD_HASH").map(_.trim).filter(_.nonEmpty),
      adminAuthDisabled = flag(env("ADMIN_AUTH_DISABLED")),
      sessionTtlHours = env("SESSION_TTL_HOURS").flatMap(_.toIntOption).filter(_ > 0).getOrElse(DefaultSessionTtlHours),
      sessionCookieSecure = flag(env("SESSION_COOKIE_SECURE")),
      corsAllowedOrigins =
        env("CORS_ALLOWED_ORIGINS").toList.flatMap(_.split(",").toList.map(_.trim)).filter(_.nonEmpty)
    )

  /** Reads a boolean environment variable. Only the exact word `true`, in any capitalisation, switches something on: a
    * variable that says `yes`, `1` or `maybe` is a variable whose author has not read the documentation, and for a
    * setting that turns authentication off, guessing at their intention is the wrong instinct.
    */
  private def flag(raw: Option[String]): Boolean = raw.exists(_.trim.equalsIgnoreCase("true"))
}
