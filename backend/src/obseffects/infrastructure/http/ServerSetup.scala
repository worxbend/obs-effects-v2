package obseffects.infrastructure.http

import obseffects.infrastructure.http.Wire.{ErrorEnvelopeDto, given}
import sttp.model.{Method, StatusCode}
import sttp.shared.Identity
import sttp.tapir.json.circe.*
import sttp.tapir.server.interceptor.cors.{CORSConfig, CORSInterceptor}
import sttp.tapir.server.interceptor.decodefailure.DefaultDecodeFailureHandler
import sttp.tapir.server.interceptor.exception.DefaultExceptionHandler
import sttp.tapir.server.interceptor.reject.DefaultRejectHandler
import sttp.tapir.server.model.ValuedEndpointOutput
import sttp.tapir.server.netty.sync.NettySyncServerOptions
import sttp.tapir.statusCode

/** Server-wide behaviour that is not tied to any single endpoint: cross-origin requests, and making sure that *every*
  * failure — even the ones that never reach our code — comes back in the contract's error envelope.
  */
object ServerSetup {

  /** Cross-Origin Resource Sharing (CORS) is the browser rule that a page served from one origin may not read a
    * response from another origin unless that other origin says it is allowed. An *origin* is scheme + host + port, so
    * `http://localhost:3000` and `http://localhost:8080` are two different ones.
    *
    * The setup this project ships has no second origin at all: the browser calls `/api` on the same origin as the app,
    * and the Vite dev server proxies it to this container. Same origin means no preflight, no CORS headers in play, and
    * a plain first-party session cookie. Everything below is for the deployments that do not look like that.
    *
    * ==Two modes==
    *
    * With `CORS_ALLOWED_ORIGINS` unset, any origin is allowed and credentials are not: a page from anywhere may call
    * this API, but the browser will not attach the session cookie, so nothing it reaches is protected data.
    *
    * Setting `CORS_ALLOWED_ORIGINS` to a comma-separated list of exact origins switches on the credentialed mode: the
    * request's `Origin` is echoed back when it is on the list, `Access-Control-Allow-Credentials: true` is added, and
    * Tapir adds `Vary: Origin` so no cache replays one origin's response to another. A wildcard origin and credentials
    * are mutually exclusive by specification, and Tapir's `customOrThrow` refuses to build a configuration that
    * combines them — which means that rule is enforced when the server starts rather than discovered in somebody's
    * browser console.
    *
    * ==Why `Content-Type` is named rather than `*`==
    *
    * This used to send `Access-Control-Allow-Headers: *`, and the contract used to say `Content-Type`; roadmap item 2.4
    * settled it in the contract's favour. On a *credentialed* request a browser treats `*` as the literal header name
    * `*` rather than as "anything", so a wildcard would silently break the admin UI's `Content-Type: application/json`
    * preflight in exactly the mode this phase introduces. Naming the header works in both modes, so there is no
    * configuration in which `*` is the better answer. Add a header to this list on the day the code starts sending one,
    * and not before.
    *
    * @param allowedOrigins
    *   exact origins allowed to send credentialed requests. Empty selects the wildcard, no-credentials mode.
    */
  private def corsConfig(allowedOrigins: List[String]): CORSConfig = {
    val withOrigins =
      if (allowedOrigins.isEmpty) CORSConfig.default.allowAllOrigins.denyCredentials
      else CORSConfig.default.allowMatchingOrigins(allowedOrigins.contains).allowCredentials

    withOrigins
      .allowMethods(Method.GET, Method.POST, Method.PUT, Method.DELETE, Method.OPTIONS)
      .allowHeaders("Content-Type")
      .preflightResponseStatusCode(StatusCode.NoContent)
  }

  /** Builds an error response body for a failure that happened outside the endpoint logic. */
  private def envelopeOutput(code: String, statusCodeValue: StatusCode, message: String) =
    ValuedEndpointOutput(
      statusCode.and(jsonBody[ErrorEnvelopeDto]),
      (statusCodeValue, ErrorMapping.envelope(code, message))
    )

  /** The options passed to the netty server.
    *
    * The three handlers below cover the failures Tapir deals with before or around our code:
    *
    *   - *decode failure* — the request did not fit the endpoint's description (malformed JSON, a missing field, a
    *     wrong type). That is the contract's `BAD_REQUEST`.
    *   - *reject* — no endpoint matched the path at all: `NOT_FOUND`.
    *   - *exception* — something threw. The message is deliberately generic so no stack trace or internal detail leaks
    *     to the client; the full exception still goes to the server log.
    */
  def options(corsAllowedOrigins: List[String]): NettySyncServerOptions =
    NettySyncServerOptions.customiseInterceptors
      .corsInterceptor(CORSInterceptor.customOrThrow[Identity](corsConfig(corsAllowedOrigins)))
      .decodeFailureHandler(
        DefaultDecodeFailureHandler[Identity].response(message =>
          envelopeOutput("BAD_REQUEST", StatusCode.BadRequest, message)
        )
      )
      .rejectHandler(
        DefaultRejectHandler[Identity](
          // A path that matched but with the wrong HTTP method comes back as 405; the contract
          // has no code of its own for that, and "you sent a request this API does not accept" is
          // closest to BAD_REQUEST.
          (status, message) =>
            envelopeOutput(if (status == StatusCode.NotFound) "NOT_FOUND" else "BAD_REQUEST", status, message),
          Some(DefaultRejectHandler.Responses.NotFound)
        )
      )
      .exceptionHandler(
        DefaultExceptionHandler[Identity]((status, _) =>
          envelopeOutput("INTERNAL_ERROR", status, "The server hit an unexpected error")
        )
      )
      .options
}
