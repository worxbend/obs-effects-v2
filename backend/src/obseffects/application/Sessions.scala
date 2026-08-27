package obseffects.application

import obseffects.domain.{PasswordHash, SessionToken}

import java.time.{Duration, Instant}
import java.util.concurrent.atomic.AtomicReference

/** One signed-in operator: the token their browser holds, and the moment that token stops working.
  *
  * There is no user name, no role and no "last seen": this service has exactly one operator, so a session is a lifetime
  * and nothing else.
  */
final case class Session(token: SessionToken, expiresAt: Instant) {

  /** Sessions have an *absolute* lifetime — there is no sliding renewal, so this answer only ever changes in one
    * direction.
    */
  def isLiveAt(now: Instant): Boolean = expiresAt.isAfter(now)
}

/** Where live sessions are kept.
  *
  * The one implementation this project ships holds them in memory (see [[InMemorySessionStore]]), which is the right
  * answer for a single-node admin tool: no schema, no index, no cleanup job, and a restart that signs you out. This
  * trait exists so that "the store is in memory" stays a decision somebody made rather than an assumption the rest of
  * the code has quietly grown into. Everything above it — issuing, expiring, revoking — is written against these four
  * methods, so swapping in a Mongo-backed or Redis-backed store would touch this file and no other.
  *
  * `now` is a parameter rather than something a store reads from a clock, for the same reason `RouteRepository` takes
  * one: a test that wants to watch a session expire should not have to wait seven days.
  */
trait SessionStore {

  /** Records a new session, and takes the opportunity to drop any that have expired. */
  def save(session: Session, now: Instant): Unit

  /** Looks a token up. Returns `None` when it is unknown *or* expired — from the caller's point of view those are the
    * same answer.
    */
  def find(token: SessionToken, now: Instant): Option[Session]

  /** Ends one session. Removing a token that is not there is not an error. */
  def remove(token: SessionToken): Unit

  /** How many sessions are currently held. Exists for tests and for a future diagnostics endpoint; nothing in the
    * request path uses it.
    */
  def size: Int
}

/** Sessions in a map inside this process, as `docs/CONTRACT.md` §4 describes.
  *
  * Two details are deliberate:
  *
  *   1. **Lookups compare tokens in constant time.** A plain `Map[SessionToken, Session]` would hash the token and
  *      compare candidates with `==`, which stops at the first differing character and so leaks, in the time the answer
  *      takes, how much of a guessed token was right. Scanning a handful of entries and comparing each with
  *      `SessionToken.matches` costs nothing at this size — one operator means a list with one or two entries in it —
  *      and closes that door without anybody having to remember it later.
  *   2. **Expired sessions are pruned lazily**, whenever a token is issued or looked up. There is no background thread
  *      to start, stop or leak, and the only thing an unpruned entry costs is a few dozen bytes until the next request.
  *
  * The state is one `AtomicReference` around an immutable `Vector`, so a reader can never see a half-updated
  * collection, and two simultaneous logins cannot lose one another's session.
  */
final class InMemorySessionStore extends SessionStore {

  private val sessions = new AtomicReference[Vector[Session]](Vector.empty)

  override def save(session: Session, now: Instant): Unit = {
    val _ = sessions.updateAndGet(current => current.filter(_.isLiveAt(now)) :+ session)
  }

  override def find(token: SessionToken, now: Instant): Option[Session] = {
    val live = sessions.updateAndGet(_.filter(_.isLiveAt(now)))
    live.find(_.token.matches(token))
  }

  override def remove(token: SessionToken): Unit = {
    val _ = sessions.updateAndGet(_.filterNot(_.token.matches(token)))
  }

  override def size: Int = sessions.get().size
}

/** Whether this server checks passwords at all, and what it checks them against.
  *
  * The two cases correspond exactly to the two ways `Main` is allowed to start: with an `ADMIN_PASSWORD_HASH` it can
  * parse, or with the explicit `ADMIN_AUTH_DISABLED=true` escape hatch. Anything else — a missing hash, an unreadable
  * one — is not a mode, it is a refusal to start, so it has no case here.
  */
enum AuthMode {

  /** The normal mode: a password is required, and it is checked against this hash. */
  case Required(hash: PasswordHash)

  /** The escape hatch: every protected endpoint behaves as though a session were present. */
  case Disabled
}

/** The numbers behind session handling, gathered in one place so that changing one is a one-line edit rather than a
  * search.
  *
  * @param ttl
  *   how long a session lasts from the moment it is issued. Absolute: using the admin does not extend it.
  * @param maxFailedAttempts
  *   how many wrong passwords in a row are answered with `401` before the server stops checking at all.
  * @param lockoutWindow
  *   how long that refusal lasts.
  */
final case class SessionPolicy(ttl: Duration, maxFailedAttempts: Int, lockoutWindow: Duration)

object SessionPolicy {

  /** The defaults from `docs/CONTRACT.md`: a seven-day session, and five wrong passwords buying a minute of silence. */
  val DefaultTtlHours = 168
  val DefaultMaxFailedAttempts = 5
  val DefaultLockoutSeconds = 60

  def default(ttlHours: Int = DefaultTtlHours): SessionPolicy =
    SessionPolicy(
      ttl = Duration.ofHours(ttlHours.toLong),
      maxFailedAttempts = DefaultMaxFailedAttempts,
      lockoutWindow = Duration.ofSeconds(DefaultLockoutSeconds.toLong)
    )
}

/** The answer to "am I signed in?", as `docs/CONTRACT.md` §2.6 defines it. Both `POST /api/auth/login` and
  * `GET /api/auth/session` return this shape so the admin UI has one code path.
  *
  * @param authenticated
  *   does this request carry a usable session (or is authentication switched off entirely)?
  * @param authRequired
  *   false only when the operator started the server with `ADMIN_AUTH_DISABLED=true`. The admin UI hides its sign-out
  *   control when it sees this.
  * @param expiresAt
  *   when the session ends. Absent when there is no session to describe.
  */
final case class SessionInfo(authenticated: Boolean, authRequired: Boolean, expiresAt: Option[Instant])

/** What a successful login produced: the body to send back, and the session whose token belongs in a `Set-Cookie`
  * header. There is no session to set when authentication is switched off, which is why this is an `Option` rather than
  * a plain `Session`.
  */
final case class LoginOutcome(info: SessionInfo, session: Option[Session])

/** Proof that the security check ran and passed.
  *
  * A protected endpoint's handler receives one of these instead of the raw cookie. It carries the session when there
  * was one and nothing when authentication is switched off, and it is deliberately not a `Boolean`: a handler cannot
  * accidentally receive `false` and carry on, because a failed check never produces this value at all.
  */
final case class Operator(session: Option[Session])
