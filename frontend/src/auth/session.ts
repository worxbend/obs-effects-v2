/**
 * The admin UI's memory of whether it is signed in.
 *
 * There is one operator and one password (see `docs/CONTRACT.md` §4), so "the session" is a single
 * value shared by the whole admin, not something each page fetches for itself. This module holds
 * that value, asks the backend for it once per page load, and lets the login page and the admin
 * shell update it without either one importing the other.
 *
 * The session **token** is never here. It lives in an `HttpOnly` cookie the browser manages, which
 * JavaScript cannot read by design — so a script injected into an admin page, or into an effect,
 * cannot copy it out. What this module holds is only the *answer* the backend gave: signed in or
 * not, and until when.
 *
 * Nothing in `/e/:slug` imports this file, and nothing should: the renderer page has no session,
 * needs none, and must never behave differently depending on one.
 */

import { createSignal } from "solid-js";
import { getSession, NetworkError } from "~/api/client";
import type { SessionInfo } from "~/types/contract";

/**
 * What we currently believe about the session. Three distinguishable states, and the difference
 * between the last two is what keeps a backend outage from looking like a locked door:
 *
 *  - `undefined` — nobody has asked yet.
 *  - `null`      — we asked and could not reach the backend. **Unknown, not "signed out".**
 *  - `SessionInfo` — the backend answered.
 */
export type SessionState = SessionInfo | null | undefined;

const [state, setState] = createSignal<SessionState>(undefined);

/** Reads the current belief. Reactive: anything reading it re-runs when it changes. */
export const sessionState = state;

/**
 * Records an answer the backend just gave us — used by the login page, which gets a `SessionInfo`
 * straight back from `POST /api/auth/login` and so has no reason to ask a second time.
 */
export function rememberSession(info: SessionInfo): void {
  cached = Promise.resolve(info);
  setState(info);
}

/**
 * Records that the session is over: after `POST /api/auth/logout`, or after any protected call
 * came back `401`.
 *
 * `authRequired` stays `true` here, because a 401 can only happen on a server that requires
 * authentication — an `ADMIN_AUTH_DISABLED=true` backend never issues one.
 */
export function forgetSession(): void {
  const info: SessionInfo = { authenticated: false, authRequired: true };
  cached = Promise.resolve(info);
  setState(info);
}

/**
 * The one in-flight or finished `GET /api/auth/session` call.
 *
 * Caching the *promise* rather than the result is what makes several components calling
 * `loadSession()` during the same render produce one request instead of four.
 */
let cached: Promise<SessionState> | null = null;

/**
 * Asks the backend whether this browser is signed in, at most once per page load.
 *
 * This is called on app load rather than lazily, for two reasons the operator would otherwise feel:
 * a signed-in operator who presses F5 must not be bounced to the login screen while the answer is
 * still in flight, and a session that expired overnight should be discovered *before* somebody
 * fills in a long form and loses it on save.
 *
 * It never rejects. A backend that is down answers `null` — "unknown" — because sending somebody
 * to a login page that cannot possibly work is worse than letting them see each page's own
 * "backend unreachable" message.
 *
 * @param force re-ask even if the answer is already cached. Used by the "try again" button.
 */
export function loadSession(force = false): Promise<SessionState> {
  if (cached && !force) return cached;

  cached = getSession()
    .then<SessionState>((info) => {
      setState(info);
      return info;
    })
    .catch((error: unknown) => {
      if (error instanceof NetworkError) {
        console.warn(
          "[auth] Could not ask the backend about the session; assuming unknown.",
          error,
        );
      } else {
        console.error("[auth] GET /api/auth/session failed unexpectedly.", error);
      }
      setState(null);
      return null;
    });

  return cached;
}

/**
 * True when the admin shell should send this operator to the login page.
 *
 * Written as one function so that "unknown means let them through" is stated exactly once. The
 * three ways to be allowed in:
 *
 *  - the backend says we are authenticated,
 *  - the backend was started with `ADMIN_AUTH_DISABLED=true`, so `authRequired` is false and there
 *    is no door to knock on,
 *  - we could not reach the backend at all, so we do not know — and guessing "locked" would hide
 *    the real problem behind a form that cannot submit.
 */
export function needsSignIn(current: SessionState): boolean {
  if (current === undefined || current === null) return false;
  if (!current.authRequired) return false;
  return !current.authenticated;
}

/**
 * Builds the login URL, remembering where the operator was headed.
 *
 * The `next` parameter is read back by the login page, which returns there after a successful
 * sign-in instead of always dumping everyone on the route list.
 */
export function loginHref(returnTo?: string): string {
  if (!returnTo || returnTo === LOGIN_PATH) return LOGIN_PATH;
  return `${LOGIN_PATH}?next=${encodeURIComponent(returnTo)}`;
}

/** Where the sign-in form lives. One constant, so a rename cannot half-apply. */
export const LOGIN_PATH = "/admin/login";

/** Where the operator ends up after signing in when no `next` was remembered. */
export const AFTER_LOGIN_PATH = "/admin";

/**
 * Turns whatever arrived in `?next=` into a path this app is willing to navigate to.
 *
 * A redirect target that came out of a URL is attacker-controllable — somebody can send you a link
 * to `…/admin/login?next=https://example.com/` — so it is checked rather than trusted:
 *
 *  - it must start with a single `/`, which rules out absolute URLs (`https://…`) and
 *    protocol-relative ones (`//example.com`, which browsers treat as absolute),
 *  - it must not be the login page itself, which would sign you in and land you back on the form,
 *  - it must not be a renderer URL: `/e/:slug` is a transparent OBS page with no way back, and
 *    dropping an operator on one after signing in looks exactly like a blank screen.
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (typeof raw !== "string" || raw === "") return AFTER_LOGIN_PATH;
  if (!raw.startsWith("/") || raw.startsWith("//")) return AFTER_LOGIN_PATH;
  if (raw === LOGIN_PATH || raw.startsWith(`${LOGIN_PATH}?`)) return AFTER_LOGIN_PATH;
  if (raw === "/e" || raw.startsWith("/e/")) return AFTER_LOGIN_PATH;
  return raw;
}
