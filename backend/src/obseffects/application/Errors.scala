package obseffects.application

import obseffects.domain.ValidationIssue

/** Everything that can go wrong while serving a request, as a closed set of cases.
  *
  * The services return `Either[AppError, A]` instead of throwing, so a caller cannot forget that a failure is possible
  * — the compiler makes them deal with it. The HTTP layer is the only place that knows how these map to status codes
  * and JSON (`infrastructure/http/ErrorMapping.scala`), which is why nothing here mentions HTTP.
  */
enum AppError {

  /** The request itself does not make sense: malformed JSON, or an id that is not an ObjectId. */
  case BadRequest(message: String)

  /** No usable session was presented to a protected endpoint, or `POST /api/auth/login` was given the wrong password.
    *
    * The two are one case on purpose. The contract sends no `details` with a 401 for exactly the same reason: with a
    * single operator, anything that distinguishes "your session expired" from "that password is wrong" from "no
    * password is configured" only helps somebody probing the server.
    */
  case Unauthorized(message: String)

  /** No route with that id or slug. */
  case NotFound(message: String)

  /** Another route already owns the requested slug. */
  case SlugConflict(slug: String)

  /** Another preset of the same effect already owns the requested name.
    *
    * It carries the effect id as well as the name because a preset name is only unique *within* one effect: "Default"
    * is a conflict for `plasma-field` and perfectly free for `starfield`, so a message naming only the name would read
    * as a rule the operator did not break.
    */
  case NameConflict(effectId: String, name: String)

  /** The `effectId` is not in the inventory the frontend published. */
  case UnknownEffect(effectId: String)

  /** The body was well-formed JSON but broke one or more rules from the contract. */
  case ValidationFailed(issues: List[ValidationIssue])

  /** Too many wrong passwords in a row: the server has stopped checking for a while.
    *
    * @param retryAfterSeconds
    *   how long the caller should wait. It travels twice — in `details` and in the standard `Retry-After` header —
    *   because the header is where an HTTP client looks and the body is where a person reading the response looks.
    */
  case TooManyAttempts(retryAfterSeconds: Int)

  /** Something unexpected. `message` is safe to show to a user and must never contain a stack trace. `details` carries
    * small machine-readable hints, e.g. `Map("mongo" -> "down")`.
    */
  case Internal(message: String, details: Map[String, String])
}

object AppError {

  /** Convenience for the common case of an internal error with no extra detail. */
  def internal(message: String): AppError = AppError.Internal(message, Map.empty)
}
