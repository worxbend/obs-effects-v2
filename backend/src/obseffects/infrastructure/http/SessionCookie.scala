package obseffects.infrastructure.http

import obseffects.domain.SessionToken
import sttp.model.headers.{Cookie, CookieValueWithMeta}

/** The one place that knows how a session becomes a `Set-Cookie` header.
  *
  * Every attribute below is spelled out in `docs/CONTRACT.md` §4 under "The session cookie", together with the reason
  * it has the value it has. The short version:
  *
  *   - **`HttpOnly`, always.** JavaScript cannot read the cookie, so a script injected into an admin page — or into an
  *     effect — cannot copy the session out.
  *   - **`SameSite=Lax`.** A cross-site `POST` does not carry the cookie, which is what closes cross-site request
  *     forgery. An ordinary top-level navigation, such as opening a bookmark, still does. Note that a "site" ignores
  *     port numbers, so `localhost:3000` and `localhost:8080` count as the same site and the cookie travels between
  *     them in the development setup.
  *   - **`Path=/` and no `Domain`.** One cookie for the whole origin, offered back to exactly the host that set it and
  *     to no subdomain.
  *   - **No `Expires`.** `Max-Age` alone is honoured by every browser this project targets, and sending both invites
  *     them to disagree.
  *   - **`Secure` only when asked for.** The admin is normally served over plain `http://localhost`, where there is no
  *     eavesdropper to defend against and where browsers do not all agree that a `Secure` cookie may be set at all.
  *     `SESSION_COOKIE_SECURE=true` turns it on for a deployment behind HTTPS.
  */
object SessionCookie {

  /** Prefixed with the application name because cookies are shared across ports on `localhost`: without the prefix,
    * another project you happen to be running would see — and could overwrite — a cookie called `session`.
    */
  val Name = "obs_effects_session"

  /** The header sent when a login succeeds.
    *
    * @param maxAgeSeconds
    *   how long the browser should keep it. It is the server-side session lifetime exactly, so the two cannot disagree
    *   about when the session is over.
    */
  def issue(token: SessionToken, maxAgeSeconds: Long, secure: Boolean): CookieValueWithMeta =
    build(value = token.value, maxAgeSeconds = maxAgeSeconds, secure = secure)

  /** The header sent on logout.
    *
    * Deleting a cookie is not an operation a browser offers: what it understands is being sent the same cookie again
    * with an empty value and `Max-Age=0`, which it reads as "this expired zero seconds ago". Name, `Path` and the other
    * attributes have to match the ones used to set it, or the browser treats it as a different cookie and leaves the
    * original in place.
    */
  def clear(secure: Boolean): CookieValueWithMeta =
    build(value = "", maxAgeSeconds = 0L, secure = secure)

  private def build(value: String, maxAgeSeconds: Long, secure: Boolean): CookieValueWithMeta =
    CookieValueWithMeta.unsafeApply(
      value = value,
      expires = None,
      maxAge = Some(maxAgeSeconds),
      domain = None,
      path = Some("/"),
      secure = secure,
      httpOnly = true,
      sameSite = Some(Cookie.SameSite.Lax),
      otherDirectives = Map.empty
    )
}
