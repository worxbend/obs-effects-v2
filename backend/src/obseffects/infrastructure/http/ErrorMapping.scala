package obseffects.infrastructure.http

import io.circe.Json
import io.circe.syntax.*
import obseffects.application.AppError
import obseffects.domain.ValidationIssue
import obseffects.infrastructure.http.Wire.{ApiErrorDto, ErrorEnvelopeDto}
import sttp.model.StatusCode

/** The only place that knows how an application error becomes an HTTP response.
  *
  * The mapping is written in both directions. Tapir uses endpoint descriptions for two things: to *serve* the API
  * (error value -> status code + body) and to *call* it from a generated client or a test (status code + body -> error
  * value). Providing both keeps `Endpoints.scala` usable for either purpose.
  */
object ErrorMapping {

  /** Application error -> the status code, JSON body and `Retry-After` header to send.
    *
    * `Retry-After` is `None` for every error except `TOO_MANY_ATTEMPTS`, and Tapir does not send a header whose value
    * is `None`, so the other responses are unaffected by its presence in the description.
    */
  def toWire(error: AppError): (StatusCode, ErrorEnvelopeDto, Option[String]) = {
    val (status, message, details) = error match {
      case AppError.BadRequest(message) =>
        (StatusCode.BadRequest, message, None)

      case AppError.Unauthorized(message) =>
        // No `details`, ever. A 401 must not report whether a password is configured, how long a
        // session lasts, or whether one recently expired: with a single operator there is nothing
        // a caller could do with that except probe.
        (StatusCode.Unauthorized, message, None)

      case AppError.NotFound(message) =>
        (StatusCode.NotFound, message, None)

      case AppError.SlugConflict(slug) =>
        (StatusCode.Conflict, s"Slug '$slug' is already used by another route", Some(Json.obj("slug" -> slug.asJson)))

      case AppError.NameConflict(effectId, name) =>
        (
          StatusCode.Conflict,
          s"Effect '$effectId' already has a preset called '$name'",
          Some(Json.obj("effectId" -> effectId.asJson, "name" -> name.asJson))
        )

      case AppError.UnknownEffect(effectId) =>
        (
          StatusCode.UnprocessableEntity,
          s"No effect with id '$effectId' is registered",
          Some(Json.obj("effectId" -> effectId.asJson))
        )

      case AppError.ValidationFailed(issues) =>
        (StatusCode.UnprocessableEntity, summarise(issues), Some(Json.obj("issues" -> issuesJson(issues))))

      case AppError.TooManyAttempts(retryAfterSeconds) =>
        (
          StatusCode.TooManyRequests,
          s"Too many failed sign-in attempts. Try again in $retryAfterSeconds seconds.",
          Some(Json.obj("retryAfterSeconds" -> retryAfterSeconds.asJson))
        )

      case AppError.Internal(message, extra) =>
        val details = Option.when(extra.nonEmpty)(Json.obj(extra.toList.map((k, v) => k -> v.asJson)*))
        (StatusCode.InternalServerError, message, details)
    }

    val retryAfter = error match {
      case AppError.TooManyAttempts(seconds) => Some(seconds.toString)
      case _                                 => None
    }

    (status, ErrorEnvelopeDto(ApiErrorDto(Wire.errorCode(error), message, details)), retryAfter)
  }

  /** Status code and JSON body -> application error. Used when this description is interpreted as a client (for example
    * in a test that calls the API in-process).
    */
  def fromWire(response: (StatusCode, ErrorEnvelopeDto, Option[String])): AppError = {
    val (_, envelope, retryAfter) = response
    val error = envelope.error
    error.code match {
      case "BAD_REQUEST"   => AppError.BadRequest(error.message)
      case "UNAUTHORIZED"  => AppError.Unauthorized(error.message)
      case "NOT_FOUND"     => AppError.NotFound(error.message)
      case "SLUG_CONFLICT" => AppError.SlugConflict(stringField(error.details, "slug"))
      case "NAME_CONFLICT" =>
        AppError.NameConflict(stringField(error.details, "effectId"), stringField(error.details, "name"))
      case "UNKNOWN_EFFECT"    => AppError.UnknownEffect(stringField(error.details, "effectId"))
      case "VALIDATION_FAILED" => AppError.ValidationFailed(issuesFrom(error.details))
      case "TOO_MANY_ATTEMPTS" =>
        // The header is the authority — it is the value an HTTP client acts on — with the body's
        // copy as the fallback for a response that lost the header on the way through a proxy.
        AppError.TooManyAttempts(
          retryAfter.flatMap(_.toIntOption).orElse(intField(error.details, "retryAfterSeconds")).getOrElse(0)
        )
      case _ => AppError.Internal(error.message, Map.empty)
    }
  }

  /** Builds the same envelope for failures that never reach the services — malformed JSON, an unmatched path, an
    * unexpected exception — so that *every* error response in the API has one shape.
    */
  def envelope(code: String, message: String): ErrorEnvelopeDto =
    ErrorEnvelopeDto(ApiErrorDto(code, message, None))

  private def summarise(issues: List[ValidationIssue]): String = issues match {
    case Nil          => "The request body is not valid"
    case head :: Nil  => s"${head.field}: ${head.message}"
    case head :: rest => s"${head.field}: ${head.message} (and ${rest.size} more problem(s))"
  }

  private def issuesJson(issues: List[ValidationIssue]): Json =
    Json.arr(issues.map(issue => Json.obj("field" -> issue.field.asJson, "message" -> issue.message.asJson))*)

  private def issuesFrom(details: Option[Json]): List[ValidationIssue] =
    details
      .flatMap(_.hcursor.downField("issues").as[List[Json]].toOption)
      .getOrElse(Nil)
      .map { json =>
        val cursor = json.hcursor
        ValidationIssue(
          cursor.get[String]("field").getOrElse(""),
          cursor.get[String]("message").getOrElse("")
        )
      }

  private def stringField(details: Option[Json], field: String): String =
    details.flatMap(_.hcursor.get[String](field).toOption).getOrElse("")

  private def intField(details: Option[Json], field: String): Option[Int] =
    details.flatMap(_.hcursor.get[Int](field).toOption)
}
