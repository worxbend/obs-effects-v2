package obseffects.infrastructure.twitch

import io.circe.parser.parse
import io.circe.{Json, ParsingFailure}
import obseffects.application.{
  HelixFailure,
  TwitchBan,
  TwitchBanPage,
  TwitchHelixApi,
  TwitchModerator,
  TwitchModeratorPage,
  TwitchUser
}

import java.net.http.{HttpClient, HttpRequest, HttpResponse}
import java.net.{URI, URLEncoder}
import java.nio.charset.StandardCharsets
import java.time.{Duration as JDuration, Instant}

import scala.util.control.NonFatal

/** Talks to Twitch's Helix API — the ordinary REST API at `api.twitch.tv` — with the JDK's own HTTP client, for the
  * same reason as `TwitchOAuth` next to it: one blocking call on a virtual thread needs no library.
  *
  * ==What a Helix request looks like==
  *
  * Every call carries two headers and would be rejected without either: `Client-Id`, naming the registered Twitch
  * application, and `Authorization: Bearer <token>`, naming the account acting. (Note the spelling — `TwitchOAuth`'s
  * validate call wants `OAuth <token>` instead, because that endpoint predates the standard scheme. Sending the wrong
  * one at either endpoint answers 401 for a perfectly good token.)
  *
  * Answers are shaped `{"data": [...], "pagination": {"cursor": "..."}}`, and errors are
  * `{"error": ..., "status": ..., "message": "..."}` — the same message-carrying shape `TwitchOAuth` reduces to a
  * sentence, so the reduction here reads the same way. The one difference that matters is that a `401` comes back as
  * its own [[HelixFailure.Unauthorized]] case instead of a sentence, because the caller can fix that one by refreshing
  * the token and has to be able to recognise it without reading English.
  */
final class TwitchHelixClient(baseUrl: String = TwitchHelixClient.DefaultBaseUrl) extends TwitchHelixApi {

  private val http: HttpClient =
    HttpClient.newBuilder().connectTimeout(JDuration.ofMillis(TwitchHelixClient.TimeoutMillis)).build()

  override def resolveUsers(
      clientId: String,
      accessToken: String,
      logins: List[String]
  ): Either[HelixFailure, List[TwitchUser]] = {
    // `login` is repeated once per account rather than sent as a comma-separated list — Twitch's own spelling — and
    // at most 100 of them fit in one request, which is the rule the bulk operations are capped by.
    val query = logins.take(TwitchHelixClient.MaxLoginsPerLookup).map(login => "login" -> login)
    get(clientId, accessToken, "/helix/users", query).map { json =>
      dataItems(json).map { item =>
        TwitchUser(
          id = string(item, "id"),
          login = string(item, "login"),
          displayName = string(item, "display_name")
        )
      }
    }
  }

  override def listBans(
      clientId: String,
      accessToken: String,
      broadcasterId: String,
      moderatorId: String,
      cursor: Option[String],
      limit: Int
  ): Either[HelixFailure, TwitchBanPage] = {
    val query = List(
      "broadcaster_id" -> broadcasterId,
      "moderator_id" -> moderatorId,
      "first" -> limit.toString
    ) ++ cursor.map("after" -> _)

    get(clientId, accessToken, "/helix/moderation/banned", query).map { json =>
      TwitchBanPage(
        bans = dataItems(json).map { item =>
          TwitchBan(
            userId = string(item, "user_id"),
            login = string(item, "user_login"),
            displayName = string(item, "user_name"),
            reason = optionalString(item, "reason"),
            moderatorLogin = optionalString(item, "moderator_login"),
            createdAt = instant(item, "created_at"),
            // Twitch sends an empty string, not a missing field, for a permanent ban. `optionalString` drops empties,
            // so "permanent" arrives here as an absent value and no consumer has to know about that quirk.
            expiresAt = instant(item, "expires_at")
          )
        },
        cursor = paginationCursor(json)
      )
    }
  }

  override def ban(
      clientId: String,
      accessToken: String,
      broadcasterId: String,
      moderatorId: String,
      userId: String,
      durationSeconds: Option[Int],
      reason: Option[String]
  ): Either[HelixFailure, Unit] = {
    // A ban and a timeout are the same Twitch call, and `duration` is the only difference: absent means permanent,
    // present means "lift it again after this many seconds".
    val fields = List(
      Some(s""""user_id":${jsonString(userId)}"""),
      durationSeconds.map(seconds => s""""duration":$seconds"""),
      reason.map(text => s""""reason":${jsonString(text)}""")
    ).flatten
    val body = s"""{"data":{${fields.mkString(",")}}}"""
    val query = List("broadcaster_id" -> broadcasterId, "moderator_id" -> moderatorId)
    post(clientId, accessToken, "/helix/moderation/bans", query, body).map(_ => ())
  }

  override def unban(
      clientId: String,
      accessToken: String,
      broadcasterId: String,
      moderatorId: String,
      userId: String
  ): Either[HelixFailure, Unit] = {
    val query = List("broadcaster_id" -> broadcasterId, "moderator_id" -> moderatorId, "user_id" -> userId)
    send(request(clientId, accessToken, "/helix/moderation/bans", query).DELETE().build()).map(_ => ())
  }

  override def listModerators(
      clientId: String,
      accessToken: String,
      broadcasterId: String,
      cursor: Option[String]
  ): Either[HelixFailure, TwitchModeratorPage] = {
    val query = List("broadcaster_id" -> broadcasterId) ++ cursor.map("after" -> _)
    get(clientId, accessToken, "/helix/moderation/moderators", query).map { json =>
      TwitchModeratorPage(
        moderators = dataItems(json).map { item =>
          TwitchModerator(
            userId = string(item, "user_id"),
            login = string(item, "user_login"),
            displayName = string(item, "user_name")
          )
        },
        cursor = paginationCursor(json)
      )
    }
  }

  // -------------------------------------------------------------------------------------------

  private def get(
      clientId: String,
      accessToken: String,
      path: String,
      query: List[(String, String)]
  ): Either[HelixFailure, Json] =
    send(request(clientId, accessToken, path, query).GET().build()).flatMap(decode)

  private def post(
      clientId: String,
      accessToken: String,
      path: String,
      query: List[(String, String)],
      body: String
  ): Either[HelixFailure, String] =
    send(
      request(clientId, accessToken, path, query)
        .header("Content-Type", "application/json")
        .POST(HttpRequest.BodyPublishers.ofString(body))
        .build()
    )

  private def request(
      clientId: String,
      accessToken: String,
      path: String,
      query: List[(String, String)]
  ): HttpRequest.Builder =
    HttpRequest
      .newBuilder(URI.create(s"$baseUrl$path${TwitchHelixClient.queryString(query)}"))
      .header("Client-Id", clientId)
      .header("Authorization", s"Bearer $accessToken")
      .timeout(JDuration.ofMillis(TwitchHelixClient.TimeoutMillis))

  /** Sends one request and reduces the outcome to the body, or to a failure the service can act on.
    *
    * The same shape as `TwitchOAuth.describe`, with the one addition this feature needs: `401` is its own case rather
    * than a sentence, so the caller can refresh the token and retry without matching words in a message.
    */
  private def send(built: HttpRequest): Either[HelixFailure, String] =
    try {
      val response = http.send(built, HttpResponse.BodyHandlers.ofString())
      val status = response.statusCode()
      if (status / 100 == 2) Right(response.body())
      else if (status == TwitchHelixClient.Unauthorized) Left(HelixFailure.Unauthorized)
      else {
        val detail = parse(response.body()).toOption
          .flatMap(_.hcursor.get[String]("message").toOption)
          .filter(_.nonEmpty)
          .fold("")(message => s": $message")
        // 429 is reported like any other refusal, naming the wait Twitch asked for when it named one. There is no
        // retry loop on purpose: a bulk operation that quietly kept retrying would take minutes with no sign of
        // progress, and the operator is better served by being told to send a smaller batch.
        val wait =
          if (status == TwitchHelixClient.TooManyRequests) {
            val reset = response.headers().firstValue("Ratelimit-Reset")
            if (reset.isPresent) s" (the rate limit resets at epoch second ${reset.get()})" else ""
          } else ""
        Left(HelixFailure.Message(s"Twitch answered $status$detail$wait"))
      }
    } catch {
      // The boundary to a foreign blocking API: an unreachable api.twitch.tv is a condition the caller reports and the
      // operator retries, never a crash — the same rule as the OAuth client next door.
      case NonFatal(e) => Left(HelixFailure.Message(Option(e.getMessage).getOrElse(e.getClass.getSimpleName)))
    }

  private def decode(body: String): Either[HelixFailure, Json] =
    parse(body).left.map((failure: ParsingFailure) =>
      HelixFailure.Message(s"Twitch's answer was not JSON: ${failure.message}")
    )

  private def dataItems(json: Json): List[Json] =
    json.hcursor.get[List[Json]]("data").getOrElse(Nil)

  private def paginationCursor(json: Json): Option[String] =
    json.hcursor.downField("pagination").get[String]("cursor").toOption.filter(_.nonEmpty)

  private def string(json: Json, field: String): String =
    json.hcursor.get[String](field).getOrElse("")

  private def optionalString(json: Json, field: String): Option[String] =
    json.hcursor.get[String](field).toOption.filter(_.nonEmpty)

  private def instant(json: Json, field: String): Option[Instant] =
    optionalString(json, field).flatMap(raw =>
      try Some(Instant.parse(raw))
      catch { case NonFatal(_) => None }
    )

  /** Quotes and escapes one string for the hand-built request bodies above. The bodies have two or three fields and
    * building them by hand keeps the dependency list unchanged; escaping is still mandatory, because a ban reason is
    * free text an operator typed and may contain quotes or newlines.
    */
  private def jsonString(value: String): String = Json.fromString(value).noSpaces
}

object TwitchHelixClient {

  /** Twitch's REST API. A constructor parameter only so a test could point the client elsewhere. */
  val DefaultBaseUrl = "https://api.twitch.tv"

  /** One timeout for connecting and for each whole request, matching the OAuth client's. */
  val TimeoutMillis = 10000

  /** How many logins Twitch resolves in one `GET /helix/users`. */
  val MaxLoginsPerLookup = 100

  private val Unauthorized = 401

  private val TooManyRequests = 429

  /** `?a=1&b=2`, percent-encoded, or the empty string when there is nothing to ask for. */
  def queryString(query: List[(String, String)]): String =
    if (query.isEmpty) ""
    else
      query
        .map((key, value) =>
          s"${URLEncoder.encode(key, StandardCharsets.UTF_8)}=${URLEncoder.encode(value, StandardCharsets.UTF_8)}"
        )
        .mkString("?", "&", "")
}
