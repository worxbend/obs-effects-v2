package obseffects.application

import munit.FunSuite
import obseffects.domain.{PasswordHash, Passwords, SessionToken}

import java.security.SecureRandom
import java.time.{Clock, Duration, Instant, ZoneOffset}
import java.util.concurrent.atomic.AtomicReference

/** The whole login/logout/expiry story, with no HTTP and no database involved.
  *
  * Time is the interesting dependency here. A session that lasts seven days cannot be watched expiring in a test that
  * waits, so the clock is a value the test moves by hand — which is the reason `SessionService` takes one instead of
  * calling `Instant.now()` inside itself.
  */
class SessionServiceSuite extends FunSuite {

  /** Cheap on purpose: bcrypt at its lowest cost. Every hash in this suite is checked several times, and the
    * recommended cost of 12 would turn a millisecond suite into a several-second one without testing anything extra.
    */
  private val TestCost = 4

  private val Password = "the-correct-password"

  private val hash: PasswordHash = Passwords.hash(Password, TestCost)

  /** A clock whose "now" the test sets. `Clock` is abstract with three methods; only `instant` is ever called by the
    * code under test, but the other two have to be answered anyway for it to be a real `Clock`.
    */
  private final class MovableClock(start: Instant) extends Clock {
    private val current = new AtomicReference[Instant](start)

    def advanceBy(amount: Duration): Unit = {
      val _ = current.updateAndGet(_.plus(amount))
    }

    override def instant(): Instant = current.get()
    override def getZone: ZoneOffset = ZoneOffset.UTC
    override def withZone(zone: java.time.ZoneId): Clock = this
  }

  private val startOfTest = Instant.parse("2026-08-24T09:00:00Z")

  /** Builds a service and hands back the clock and store alongside it, so a test can move time and look at what is
    * stored without reaching through the service.
    */
  private def newService(
      mode: AuthMode = AuthMode.Required(hash),
      policy: SessionPolicy = SessionPolicy.default()
  ): (SessionService, MovableClock, SessionStore) = {
    val clock = new MovableClock(startOfTest)
    val store = new InMemorySessionStore
    (new SessionService(mode, store, policy, clock, new SecureRandom()), clock, store)
  }

  /** Signs in and returns the raw cookie value the browser would be sent. */
  private def signIn(service: SessionService, password: String = Password): String =
    service.login(password) match {
      case Right(LoginOutcome(_, Some(session))) => session.token.value
      case other                                 => fail(s"expected a session to be issued, got $other")
    }

  // -------------------------------------------------------------------------------------------
  // Issuing a session
  // -------------------------------------------------------------------------------------------

  test("the right password issues a session that expires exactly one lifetime from now") {
    val (service, _, store) = newService()

    service.login(Password) match {
      case Right(LoginOutcome(info, Some(session))) =>
        assert(info.authenticated)
        assert(info.authRequired)
        assertEquals(info.expiresAt, Some(startOfTest.plus(Duration.ofHours(168))))
        assertEquals(session.expiresAt, startOfTest.plus(Duration.ofHours(168)))
        assertEquals(store.size, 1)

      case other => fail(s"expected a successful login, got $other")
    }
  }

  test("the cookie's Max-Age is the session lifetime in seconds, so browser and server agree") {
    val (service, _, _) = newService(policy = SessionPolicy.default(ttlHours = 24))
    assertEquals(service.cookieMaxAgeSeconds, 24L * 60 * 60)
  }

  test("the wrong password issues nothing and says only that it was wrong") {
    val (service, _, store) = newService()
    assertEquals(service.login("not-the-password"), Left(AppError.Unauthorized("Incorrect password.")))
    assertEquals(store.size, 0)
  }

  test("an empty or over-long password is a bad request rather than a failed sign-in") {
    // The shape of the request is wrong, not the credential, which is why the contract asks for a
    // 400 here. It also means bcrypt is never asked to hash a megabyte.
    val (service, _, _) = newService()
    assert(service.login("").swap.exists(_.isInstanceOf[AppError.BadRequest]))
    assert(service.login("x" * (Passwords.MaxPasswordLength + 1)).swap.exists(_.isInstanceOf[AppError.BadRequest]))
    assert(service.login("x" * Passwords.MaxPasswordLength).isLeft) // wrong password, but accepted as a request
  }

  // -------------------------------------------------------------------------------------------
  // Using a session
  // -------------------------------------------------------------------------------------------

  test("a freshly issued session authorises requests") {
    val (service, _, _) = newService()
    val token = signIn(service)
    assert(service.authorise(Some(token)).isRight)
  }

  test("no cookie, a nonsense cookie and an unknown token are all the same 401") {
    val (service, _, _) = newService()
    val unknown = SessionToken.generate(new SecureRandom()).value

    List(None, Some(""), Some("not-a-token"), Some(unknown)).foreach { candidate =>
      assert(
        service.authorise(candidate).swap.exists(_.isInstanceOf[AppError.Unauthorized]),
        s"$candidate should not authorise"
      )
    }
  }

  test("GET /api/auth/session reports the truth in both directions and never fails") {
    val (service, _, _) = newService()

    assertEquals(service.describe(None), SessionInfo(authenticated = false, authRequired = true, expiresAt = None))

    val token = signIn(service)
    assertEquals(
      service.describe(Some(token)),
      SessionInfo(authenticated = true, authRequired = true, Some(startOfTest.plus(Duration.ofHours(168))))
    )
  }

  // -------------------------------------------------------------------------------------------
  // Ending a session
  // -------------------------------------------------------------------------------------------

  test("logging out invalidates the session on the server, not only in the browser") {
    // The cookie-clearing header is what stops the browser sending the token again. This is the
    // other half: a token copied out of the browser before logging out must stop working too.
    val (service, _, store) = newService()
    val token = signIn(service)

    service.logout(Some(token))

    assertEquals(store.size, 0)
    assert(service.authorise(Some(token)).isLeft)
    assertEquals(service.describe(Some(token)).authenticated, false)
  }

  test("logging out with no cookie, or one that was never valid, is not an error") {
    val (service, _, _) = newService()
    service.logout(None)
    service.logout(Some("garbage"))
  }

  test("logging out ends one session and leaves the others alone") {
    val (service, _, store) = newService()
    val first = signIn(service)
    val second = signIn(service)

    service.logout(Some(first))

    assertEquals(store.size, 1)
    assert(service.authorise(Some(first)).isLeft)
    assert(service.authorise(Some(second)).isRight)
  }

  // -------------------------------------------------------------------------------------------
  // Expiry
  // -------------------------------------------------------------------------------------------

  test("a session stops working the moment its lifetime is up") {
    val (service, clock, _) = newService(policy = SessionPolicy.default(ttlHours = 1))
    val token = signIn(service)

    clock.advanceBy(Duration.ofMinutes(59))
    assert(service.authorise(Some(token)).isRight, "still inside the hour")

    clock.advanceBy(Duration.ofMinutes(2))
    assert(service.authorise(Some(token)).isLeft, "past the hour")
    assertEquals(service.describe(Some(token)).authenticated, false)
  }

  test("expiry is absolute: using the session does not extend it") {
    // Deliberate, and the reason there is no sliding renewal: a sliding window means writing to the
    // store on every single request, which is a lot of machinery to buy an admin tool nothing.
    val (service, clock, _) = newService(policy = SessionPolicy.default(ttlHours = 1))
    val token = signIn(service)

    (1 to 5).foreach { _ =>
      clock.advanceBy(Duration.ofMinutes(11))
      val _ = service.authorise(Some(token))
    }

    // 55 minutes of steady use, then five more: the original hour is what runs out.
    clock.advanceBy(Duration.ofMinutes(6))
    assert(service.authorise(Some(token)).isLeft)
  }

  test("an expired session is dropped from the store rather than kept for ever") {
    val (service, clock, store) = newService(policy = SessionPolicy.default(ttlHours = 1))
    val token = signIn(service)
    clock.advanceBy(Duration.ofHours(2))

    val _ = service.authorise(Some(token))

    assertEquals(store.size, 0)
  }

  // -------------------------------------------------------------------------------------------
  // The login lockout
  // -------------------------------------------------------------------------------------------

  test("five wrong passwords in a row buy a lockout, and the sixth attempt is refused unchecked") {
    val (service, _, _) = newService()

    (1 to 5).foreach { attempt =>
      assert(
        service.login("wrong").swap.exists(_.isInstanceOf[AppError.Unauthorized]),
        s"attempt $attempt should be answered as a wrong password"
      )
    }

    service.login(Password) match {
      case Left(AppError.TooManyAttempts(seconds)) => assertEquals(seconds, 60)
      case other => fail(s"the sixth attempt should be refused without checking, got $other")
    }
  }

  test("the lockout ends by itself when the window elapses") {
    val (service, clock, _) = newService()
    (1 to 5).foreach(_ => { val _ = service.login("wrong") })

    clock.advanceBy(Duration.ofSeconds(61))

    assert(service.login(Password).isRight, "the window has passed, so the password should be checked again")
  }

  test("a correct password clears the failure count") {
    val (service, _, _) = newService()
    (1 to 4).foreach(_ => { val _ = service.login("wrong") })

    assert(service.login(Password).isRight)

    // Back to a full budget: four more failures must not trip the lockout.
    (1 to 4).foreach { attempt =>
      assert(
        service.login("wrong").swap.exists(_.isInstanceOf[AppError.Unauthorized]),
        s"attempt $attempt after a success should still be answered as a wrong password"
      )
    }
  }

  // -------------------------------------------------------------------------------------------
  // The ADMIN_AUTH_DISABLED escape hatch
  // -------------------------------------------------------------------------------------------

  test("with authentication switched off, every request is authorised and nothing is issued") {
    val (service, _, store) = newService(mode = AuthMode.Disabled)

    assertEquals(service.authRequired, false)
    assert(service.authorise(None).isRight)
    assertEquals(
      service.describe(None),
      SessionInfo(authenticated = true, authRequired = false, expiresAt = None)
    )

    service.login("any password at all") match {
      case Right(LoginOutcome(info, None)) =>
        assertEquals(info, SessionInfo(authenticated = true, authRequired = false, expiresAt = None))
        assertEquals(store.size, 0)

      case other => fail(s"login should succeed and issue no cookie, got $other")
    }
  }
}
