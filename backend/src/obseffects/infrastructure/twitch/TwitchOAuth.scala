package obseffects.infrastructure.twitch

import io.circe.parser.parse
import obseffects.application.{TwitchTokenExchanger, TwitchTokenInfo, TwitchTokenPair}

import java.net.http.{HttpClient, HttpRequest, HttpResponse}
import java.net.{URI, URLEncoder}
import java.nio.charset.StandardCharsets
import java.time.Duration as JDuration

import scala.util.control.NonFatal

/** Talks to Twitch's OAuth endpoints with the JDK's own HTTP client — no library, for the same reason as the two
  * WebSocket clients in this codebase.
  *
  * ==What OAuth is doing here, in one paragraph==
  *
  * Reading public chat needs no token at all. A token buys two things: the connection identifies as the operator's
  * account (or a bot account), and future features can act as it. Twitch issues tokens in exchange for an
  * *authorization code* — a short-lived string its login page hands the browser after the operator clicks "Authorize" —
  * and that exchange requires the *client secret* of a Twitch application the operator registered. Access tokens expire
  * after a few hours; the *refresh token* issued alongside is traded for a fresh pair, which is what the chat
  * supervisor does when a connection starts failing authentication.
  *
  * All three calls are synchronous blocking HTTP, which on virtual threads is exactly what we want, and every failure —
  * network, non-2xx status, unparseable body — comes back as a `Left` with text an operator can read, because a
  * rejected code or an expired token is a normal outcome and not an exception.
  */
final class TwitchOAuth(baseUrl: String = TwitchOAuth.DefaultBaseUrl) extends TwitchTokenExchanger {

  private val http: HttpClient =
    HttpClient.newBuilder().connectTimeout(JDuration.ofMillis(TwitchOAuth.TimeoutMillis)).build()

  override def exchangeCode(
      clientId: String,
      clientSecret: String,
      code: String,
      redirectUri: String
  ): Either[String, TwitchTokenPair] =
    tokenRequest(
      Map(
        "client_id" -> clientId,
        "client_secret" -> clientSecret,
        "grant_type" -> "authorization_code",
        "code" -> code,
        // Twitch checks that this matches the redirect_uri the authorize request used — it is part of the proof that
        // the code was not intercepted — so the frontend sends the exact value it redirected through.
        "redirect_uri" -> redirectUri
      )
    )

  override def refreshTokens(
      clientId: String,
      clientSecret: String,
      refreshToken: String
  ): Either[String, TwitchTokenPair] =
    tokenRequest(
      Map(
        "client_id" -> clientId,
        "client_secret" -> clientSecret,
        "grant_type" -> "refresh_token",
        "refresh_token" -> refreshToken
      )
    )

  override def validateToken(accessToken: String): Either[String, TwitchTokenInfo] = {
    val request = HttpRequest
      .newBuilder(URI.create(s"$baseUrl/oauth2/validate"))
      // `OAuth`, not `Bearer`: the validate endpoint predates Twitch's move to standard schemes and still wants the
      // old spelling. Sending `Bearer` here answers 401 for a perfectly good token.
      .header("Authorization", s"OAuth $accessToken")
      .timeout(JDuration.ofMillis(TwitchOAuth.TimeoutMillis))
      .GET()
      .build()

    describe(request).flatMap { body =>
      // One response answers three questions the rest of the system needs: whose token this is (`login`), which
      // numeric account that is (`user_id`, the id every moderation call carries), and what the token may do
      // (`scopes`). The login is the only one that has to be there — a validate answer without it is not one — while
      // an older token that predates the scope list simply reports no scopes.
      val cursor = parse(body).toOption.map(_.hcursor)
      cursor.flatMap(_.get[String]("login").toOption) match {
        case None        => Left("Twitch's validate response did not carry a login")
        case Some(login) =>
          Right(
            TwitchTokenInfo(
              login = login,
              userId = cursor.flatMap(_.get[String]("user_id").toOption).getOrElse(""),
              scopes = cursor.flatMap(_.get[List[String]]("scopes").toOption).getOrElse(Nil)
            )
          )
      }
    }
  }

  // -------------------------------------------------------------------------------------------

  /** One `POST /oauth2/token` call, for either grant type, decoded into the token pair. */
  private def tokenRequest(fields: Map[String, String]): Either[String, TwitchTokenPair] = {
    val request = HttpRequest
      .newBuilder(URI.create(s"$baseUrl/oauth2/token"))
      .header("Content-Type", "application/x-www-form-urlencoded")
      .timeout(JDuration.ofMillis(TwitchOAuth.TimeoutMillis))
      .POST(HttpRequest.BodyPublishers.ofString(TwitchOAuth.formEncode(fields)))
      .build()

    describe(request).flatMap { body =>
      parse(body).toOption.flatMap(_.hcursor.get[String]("access_token").toOption) match {
        case None         => Left("Twitch's token response did not carry an access token")
        case Some(access) =>
          val refresh = parse(body).toOption.flatMap(_.hcursor.get[String]("refresh_token").toOption)
          Right(TwitchTokenPair(access, refresh.filter(_.nonEmpty)))
      }
    }
  }

  /** Sends one request and reduces the outcome to "the body" or "a sentence about what went wrong". Twitch's error
    * bodies are `{"status": ..., "message": "..."}`, and the message is the part worth showing.
    */
  private def describe(request: HttpRequest): Either[String, String] =
    try {
      val response = http.send(request, HttpResponse.BodyHandlers.ofString())
      if (response.statusCode() / 100 == 2) Right(response.body())
      else {
        val detail = parse(response.body()).toOption
          .flatMap(_.hcursor.get[String]("message").toOption)
          .filter(_.nonEmpty)
          .fold("")(message => s": $message")
        Left(s"Twitch answered ${response.statusCode()}$detail")
      }
    } catch {
      // The boundary to a foreign blocking API: an unreachable id.twitch.tv is a recoverable condition the caller
      // reports and retries, never a crash.
      case NonFatal(e) => Left(Option(e.getMessage).getOrElse(e.getClass.getSimpleName))
    }
}

object TwitchOAuth {

  /** Twitch's identity service. A constructor parameter only so a test could point the client elsewhere. */
  val DefaultBaseUrl = "https://id.twitch.tv"

  /** One timeout for connecting and for each whole request. Generous for an identity service, short enough that a
    * settings save waiting on a dead network fails while the operator is still looking at the button.
    */
  val TimeoutMillis = 10000

  /** `application/x-www-form-urlencoded` encoding, which is what the token endpoint takes — not JSON. */
  def formEncode(fields: Map[String, String]): String =
    fields
      .map((key, value) =>
        s"${URLEncoder.encode(key, StandardCharsets.UTF_8)}=${URLEncoder.encode(value, StandardCharsets.UTF_8)}"
      )
      .mkString("&")
}
