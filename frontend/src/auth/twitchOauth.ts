/**
 * The browser's half of the "Connect with Twitch" flow.
 *
 * Two pages take part in it — the Settings page sends the operator to Twitch, and
 * `/admin/twitch/callback` receives them back — and both have to agree on two things: the redirect
 * URI, and a one-time random value called the **state**. This module owns both so the two pages
 * cannot drift apart.
 *
 * ## What the `state` is for
 *
 * Without it, the callback page will exchange *any* `?code=` that appears in its address bar. An
 * attacker can obtain an authorization code for **their own** Twitch account and send a signed-in
 * operator a link to `https://<this server>/admin/twitch/callback?code=<their code>`. The page
 * would exchange it and the backend would store the attacker's tokens, silently rebinding the
 * installation to the attacker's account — a "login CSRF" (cross-site request forgery: the
 * victim's own browser, with the victim's own session, is made to perform an action the victim
 * never asked for). Since the stored token can now ban and unban viewers, that is worth more than
 * it used to be.
 *
 * The defence is the standard one from the OAuth specification. Before redirecting, this module
 * makes a random value, remembers it in `sessionStorage`, and appends it to the authorize URL as
 * `state`. Twitch echoes the value back unchanged alongside the code. The callback page then asks
 * for it once: a code that arrives with the wrong state, or with none, was not requested by this
 * browser and is never exchanged. An attacker cannot guess the value and cannot read it — it is
 * stored under this site's own origin, which their page has no access to.
 *
 * `sessionStorage` (not `localStorage`) because the value belongs to this one browser tab's
 * attempt: it dies with the tab, and a stale one from a flow abandoned last week can never make a
 * later code look legitimate.
 */

/** Where `sessionStorage` keeps the pending flow's state value. */
const STATE_KEY = "twitch.oauth.state";

/** The redirect URI both halves of the OAuth flow must agree on, byte for byte. */
export function twitchRedirectUri(): string {
  return `${location.origin}/admin/twitch/callback`;
}

/**
 * Makes a fresh state value for an authorize URL.
 *
 * `crypto.getRandomValues` is the browser's cryptographically strong generator — unlike
 * `Math.random`, its output cannot be predicted from earlier output, which is the whole point of a
 * value an attacker must not be able to guess.
 */
export function newTwitchOauthState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Remembers the state value of the flow that is about to start.
 *
 * Called as the operator leaves for Twitch rather than while the link is being drawn, so that a
 * second attempt in the same tab stores its value again instead of relying on one written long
 * before — the callback consumes the value, so an un-refreshed page would otherwise have nothing
 * left to match against.
 *
 * If storage is unavailable (a browser configured to block it) nothing is remembered, the callback
 * finds no pending flow, and the exchange is refused — the safe direction to fail in.
 */
export function rememberTwitchOauthState(state: string): void {
  try {
    sessionStorage.setItem(STATE_KEY, state);
  } catch {
    // Nothing to do about it here; the callback's check is what decides, and it will say no.
  }
}

/**
 * Reads back the pending state value and forgets it in the same breath.
 *
 * Forgetting it immediately is deliberate: the state, like the code beside it, is good for exactly
 * one exchange, so reloading the callback page cannot replay it.
 *
 * Returns `null` when there is nothing pending — which is what an unsolicited callback looks like.
 */
export function consumeTwitchOauthState(): string | null {
  try {
    const state = sessionStorage.getItem(STATE_KEY);
    sessionStorage.removeItem(STATE_KEY);
    return state;
  } catch {
    return null;
  }
}
