package obseffects.application

import obseffects.domain.{Passwords, SessionToken}

import java.security.SecureRandom
import java.time.{Clock, Instant}
import java.util.concurrent.atomic.AtomicReference

/** Signing in, signing out, and deciding whether a request may proceed.
  *
  * This is the whole of the authentication *policy*: the domain knows how to check a password and how to mint a token
  * (`domain/Auth.scala`), the store knows where sessions are kept (`Sessions.scala`), and this class decides when each
  * of those happens. Nothing here mentions HTTP — no cookie, no status code, no header — which is what lets the login
  * rules be tested without starting a server.
  *
  * @param mode
  *   whether a password is required at all, and what to check it against.
  * @param store
  *   where live sessions are kept.
  * @param policy
  *   the session lifetime and the login lockout numbers.
  * @param clock
  *   the source of "now", injected so a test can move time forward by a week without waiting.
  * @param random
  *   the source of session tokens. One shared `SecureRandom` for the process.
  */
class SessionService(
    mode: AuthMode,
    store: SessionStore,
    policy: SessionPolicy,
    clock: Clock,
    random: SecureRandom
) {

  /** Consecutive failed logins, and the moment the server will start checking passwords again.
    *
    * The counter is process-wide rather than per-IP on purpose: there is one operator, so "somebody is guessing" is the
    * only thing a run of failures can mean, and a per-address table would be state to keep and expire for no gain. It
    * is not persisted either — restarting the backend clears it.
    */
  private final case class Attempts(consecutiveFailures: Int, lockedUntil: Option[Instant])

  private val attempts = new AtomicReference[Attempts](Attempts(0, None))

  /** False only when the server was started with `ADMIN_AUTH_DISABLED=true`. */
  val authRequired: Boolean = mode match {
    case AuthMode.Disabled    => false
    case AuthMode.Required(_) => true
  }

  /** Checks a password and, if it is right, issues a session.
    *
    * The order of the three checks matters. The length cap comes first so a caller cannot push a large body through
    * bcrypt; the lockout comes next so that during a lockout the password is not hashed *at all*, which is what makes
    * the lockout cheap for the server as well as useless for the guesser; verification comes last.
    */
  def login(password: String): Either[AppError, LoginOutcome] = {
    val now = clock.instant()

    mode match {
      case AuthMode.Disabled =>
        // With authentication switched off there is nothing to check and nothing to issue. Any
        // password is accepted, and the `authRequired: false` in the body is how the admin UI
        // learns not to show a sign-out control.
        Right(LoginOutcome(SessionInfo(authenticated = true, authRequired = false, expiresAt = None), None))

      case AuthMode.Required(hash) =>
        for {
          _ <- checkLength(password)
          _ <- checkNotLockedOut(now)
          outcome <-
            if (Passwords.verify(password, hash)) Right(succeed(now))
            else Left(fail(now))
        } yield outcome
    }
  }

  /** Ends the session a request carries, if it carries one that exists.
    *
    * Deliberately returns nothing and cannot fail: the contract makes logout answer `204` whatever happens, because a
    * caller with no session, an expired session or a nonsense cookie is asking for a state that is already true.
    */
  def logout(rawToken: Option[String]): Unit =
    rawToken.flatMap(SessionToken.parse).foreach(store.remove)

  /** The security check every protected endpoint runs. `Right` means the request may proceed.
    *
    * A missing cookie, a malformed one, an unknown token and an expired token all produce the same `401` with the same
    * message. Telling them apart would tell a caller whether they had guessed a real token, and there is exactly one
    * principal here, so there is nothing an honest caller could do with the difference.
    */
  def authorise(rawToken: Option[String]): Either[AppError, Operator] =
    mode match {
      case AuthMode.Disabled    => Right(Operator(None))
      case AuthMode.Required(_) =>
        lookUp(rawToken)
          .map(session => Operator(Some(session)))
          .toRight(AppError.Unauthorized("A valid session is required. Sign in first."))
    }

  /** Answers `GET /api/auth/session`: what the admin UI asks on page load. Never fails — being signed out is an answer,
    * not an error.
    */
  def describe(rawToken: Option[String]): SessionInfo =
    mode match {
      case AuthMode.Disabled =>
        SessionInfo(authenticated = true, authRequired = false, expiresAt = None)

      case AuthMode.Required(_) =>
        lookUp(rawToken) match {
          case Some(session) => SessionInfo(authenticated = true, authRequired = true, Some(session.expiresAt))
          case None          => SessionInfo(authenticated = false, authRequired = true, expiresAt = None)
        }
    }

  /** How long the browser should keep the session cookie, in seconds: exactly the server-side lifetime, so the two
    * cannot disagree about when the session is over.
    */
  def cookieMaxAgeSeconds: Long = policy.ttl.getSeconds

  // -------------------------------------------------------------------------------------------

  private def lookUp(rawToken: Option[String]): Option[Session] =
    rawToken.flatMap(SessionToken.parse).flatMap(token => store.find(token, clock.instant()))

  private def checkLength(password: String): Either[AppError, Unit] =
    if (password.isEmpty)
      Left(AppError.BadRequest("The password field must not be empty"))
    else if (password.length > Passwords.MaxPasswordLength)
      Left(AppError.BadRequest(s"The password field must be at most ${Passwords.MaxPasswordLength} characters"))
    else Right(())

  private def checkNotLockedOut(now: Instant): Either[AppError, Unit] =
    attempts.get().lockedUntil.filter(_.isAfter(now)) match {
      case None        => Right(())
      case Some(until) =>
        // Rounded up, so a client that waits exactly this long is past the window rather than one
        // millisecond short of it.
        val remaining = Math.max(1L, Math.ceil((until.toEpochMilli - now.toEpochMilli) / 1000.0).toLong)
        Left(AppError.TooManyAttempts(remaining.toInt))
    }

  /** A correct password: clear the failure counter and hand out a fresh session. */
  private def succeed(now: Instant): LoginOutcome = {
    attempts.set(Attempts(0, None))
    val session = Session(SessionToken.generate(random), now.plus(policy.ttl))
    store.save(session, now)
    LoginOutcome(SessionInfo(authenticated = true, authRequired = true, Some(session.expiresAt)), Some(session))
  }

  /** A wrong password: count it, and start the lockout window once the run reaches the limit.
    *
    * The attempt that *reaches* the limit still gets the ordinary `401` — it was checked, and it was wrong. The next
    * one is the first to be refused without being checked.
    */
  private def fail(now: Instant): AppError = {
    val _ = attempts.updateAndGet { current =>
      val failures = current.consecutiveFailures + 1
      if (failures >= policy.maxFailedAttempts) Attempts(0, Some(now.plus(policy.lockoutWindow)))
      else Attempts(failures, None)
    }
    AppError.Unauthorized("Incorrect password.")
  }
}
