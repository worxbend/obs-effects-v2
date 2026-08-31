/**
 * Typed HTTP client for the backend described in `docs/CONTRACT.md`.
 *
 * Every function here does the same three things:
 *   1. build a request,
 *   2. if the response status is 2xx, parse the JSON body into the contract type,
 *   3. otherwise parse the error envelope and `throw` an `ApiError`.
 *
 * That means callers can write straight-line code and use `try { ... } catch (e) { ... }`
 * instead of checking a status code after every call.
 */

import type {
  ObsAudioSettingsRequest,
  ObsAudioView,
  EffectDescriptor,
  EffectSyncRequest,
  EffectSyncResponse,
  ExportEnvelope,
  HealthResponse,
  ApiErrorBody,
  ImportRequest,
  ImportResult,
  LoginRequest,
  Preset,
  PresetWriteRequest,
  SessionInfo,
  SoundInfo,
  SoundListResponse,
  Soundboard,
  SoundboardWriteRequest,
  WireErrorCode,
  RouteConfig,
  RouteWriteRequest,
  ValidationIssue,
  ChatMessage,
  BulkResult,
  TwitchAdminStatus,
  TwitchBanPage,
  TwitchBanRequest,
  TwitchModeratorPage,
  TwitchOAuthCompleteRequest,
  TwitchSettingsRequest,
  TwitchTokensRequest,
  TwitchUnbanRequest,
  TwitchView,
} from "~/types/contract";

/**
 * Works out the base URL of the API, once, when this module is first imported.
 *
 * `import.meta.env.VITE_API_BASE` is replaced by Vite at build time with the value of the
 * environment variable of the same name. When it is not set — which is now the default — we fall
 * back to the relative path "/api", which the Vite dev server proxies to the backend container
 * (see `vite.config.ts`). A relative path also keeps working when the app is served from the same
 * origin as the API, which is the shape a production reverse proxy takes.
 *
 * Same origin is not merely tidier: it is what makes the session cookie a **first-party** cookie,
 * so no credentialed CORS setup is needed for signing in to work.
 *
 * The `.trim()` and the falsy check matter more than they look. Docker Compose happily sets a
 * variable to the empty string, and an empty string is *not* nullish — so `?? "/api"` alone would
 * leave the base as `""` and every request would go to `/health` instead of `/api/health`, with a
 * 404 from the Vite dev server and no clue as to why.
 */
function resolveApiBase(): string {
  const configured = (import.meta.env.VITE_API_BASE as string | undefined)?.trim();
  if (!configured) return "/api";
  // Strip trailing slashes so that a configured "http://host:8080/api/" and the paths below
  // ("/routes") do not join into "http://host:8080/api//routes".
  return configured.replace(/\/+$/, "");
}

/** Base URL every request below is built on. */
export const API_BASE: string = resolveApiBase();

/**
 * An error thrown when the backend answered with a non-2xx status.
 *
 * It carries the parsed error envelope, so UI code can react to a specific `code`
 * (for example, highlighting the slug field when the code is "SLUG_CONFLICT") instead of
 * pattern-matching on English message text.
 */
export class ApiError extends Error {
  /** HTTP status code, e.g. 409. */
  readonly status: number;
  /** Machine-readable code from the contract, e.g. "SLUG_CONFLICT". */
  readonly code: WireErrorCode;
  /** Extra structured information, present on some codes. */
  readonly details?: Record<string, unknown>;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = "ApiError";
    this.status = status;
    this.code = body.code;
    this.details = body.details;
  }

  /** True when the resource simply does not exist — the common "empty state", not a real failure. */
  get isNotFound(): boolean {
    return this.status === 404;
  }

  /**
   * True when the backend refused the call because there is no usable session.
   *
   * There is no 403 in this contract — the service has one operator, so a request either may do
   * everything or may do nothing — which is why this single check is enough.
   */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  /**
   * Seconds to wait before trying to sign in again, from a 429 `TOO_MANY_ATTEMPTS`.
   *
   * The backend sends the number twice, in the `Retry-After` header and in `details`. This reads
   * the `details` copy, because a `fetch` response's headers are not carried on the thrown error.
   * Returns `null` for any other error, or when the field is missing or not a number.
   */
  get retryAfterSeconds(): number | null {
    const raw = this.details?.["retryAfterSeconds"];
    return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  }

  /**
   * Field-level issues carried by a `VALIDATION_FAILED` error, or an empty array for any other
   * error. Use this to attach messages to individual form inputs.
   */
  get issues(): ValidationIssue[] {
    const raw = this.details?.["issues"];
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (i): i is ValidationIssue =>
        typeof i === "object" && i !== null && typeof (i as ValidationIssue).field === "string",
    );
  }
}

/** Thrown when the backend could not be reached at all (container down, wrong port, offline). */
export class NetworkError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super("Could not reach the backend. Is the `backend` container running?");
    this.name = "NetworkError";
    this.cause = cause;
  }
}

/** Options accepted by the low-level `request` helper. */
interface RequestOptions {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  /** Parsed and sent as a JSON body. Omit for GET/DELETE. Mutually exclusive with `rawBody`. */
  body?: unknown;
  /**
   * Sent as-is, with the blob's own `type` as the `Content-Type` header. This exists for the one
   * endpoint that takes binary instead of JSON — the sound upload — where serialising through
   * `JSON.stringify` would destroy the bytes.
   */
  rawBody?: Blob;
  /** Lets a caller cancel an in-flight request, used by the renderer's polling loop. */
  signal?: AbortSignal;
  /**
   * Set on the one request where a `401` is an ordinary answer rather than a session that ended:
   * `POST /api/auth/login` with the wrong password. Every other `401` goes through the central
   * handler below, so no page has to check for one itself.
   */
  handlesUnauthorizedItself?: boolean;
}

/* ------------------------------------------------------------------ */
/* Central 401 handling                                                */
/* ------------------------------------------------------------------ */

/**
 * What to do when a protected call comes back `401`, or `null` when nobody is listening.
 *
 * This is one variable rather than a list on purpose: at most one part of the app is ever entitled
 * to react to an expired session, and "the last screen that registered wins" is easier to reason
 * about than a broadcast to several listeners that each try to navigate somewhere.
 */
let unauthorizedHandler: (() => void) | null = null;

/**
 * Registers the app's reaction to an expired or missing session, and returns the function that
 * unregisters it again.
 *
 * ## Why this is a registration rather than a redirect written into this file
 *
 * The client cannot navigate on its own: it is a plain module with no access to the router.
 * More importantly, **the reaction must not exist at all on the renderer page.** `/e/:slug` is
 * what an OBS browser source points at; a browser source that navigated itself to a login screen
 * would replace a live layer, on air, with an admin form — and nothing in OBS would say why.
 *
 * So the handler is registered by `AdminShell`, which is mounted only for `/admin/*` paths, and is
 * removed again when that shell unmounts. While the renderer page is on screen there is literally
 * no handler installed, which makes the exemption structural instead of a rule someone has to
 * remember. The renderer also calls only public endpoints, so it should never see a `401` in the
 * first place; this is the second of the two independent reasons it cannot be redirected.
 *
 * If you are refactoring routing and are tempted to move this call somewhere "more central" —
 * `index.tsx`, a root layout, a router guard that wraps every path — read the paragraph above
 * again. Anything that also covers `/e/:slug` breaks live streams.
 */
export function onUnauthorized(handler: () => void): () => void {
  unauthorizedHandler = handler;
  return () => {
    // Only clear it if nobody else has registered in the meantime, so an unmount that happens
    // after the next screen has already registered does not silently switch the handling off.
    if (unauthorizedHandler === handler) unauthorizedHandler = null;
  };
}

/**
 * Turns whatever the server sent into an `ApiErrorBody`.
 *
 * A well-behaved backend always sends the error envelope, but a crashed process or a proxy in
 * front of it may send HTML or nothing at all — so this never assumes the body is parseable.
 */
async function readErrorBody(response: Response): Promise<ApiErrorBody> {
  try {
    const parsed: unknown = await response.json();
    const envelope = parsed as { error?: Partial<ApiErrorBody> };
    if (envelope?.error && typeof envelope.error.message === "string") {
      return {
        code: typeof envelope.error.code === "string" ? envelope.error.code : "INTERNAL_ERROR",
        message: envelope.error.message,
        details: envelope.error.details,
      };
    }
  } catch {
    // Fall through to the generic message below.
  }
  return {
    code: "INTERNAL_ERROR",
    message: `The server answered ${response.status} ${response.statusText || ""}`.trim(),
  };
}

/** Sends one request and returns the raw `Response`, throwing `NetworkError` if it never arrived. */
async function send(options: RequestOptions): Promise<Response> {
  const init: RequestInit = {
    method: options.method,
    headers: { Accept: "application/json" },
    signal: options.signal,

    /*
     * Send the session cookie.
     *
     * This one word is the difference between a working sign-in and one that appears to succeed
     * and then forgets you on the next click, so it is worth spelling out what the three possible
     * values do:
     *
     *   - "omit"        — never send cookies.
     *   - "same-origin" — the DEFAULT. Cookies travel only when the request goes to the same
     *                     origin (scheme + host + port) as the page.
     *   - "include"     — cookies travel to any origin, subject to the server's CORS rules.
     *
     * The project's default configuration is same-origin (`VITE_API_BASE` is empty, so requests go
     * to the relative path `/api` and the Vite dev server proxies them), where the default would
     * already have been enough. "include" is set anyway so the admin also works when somebody
     * points `VITE_API_BASE` at an absolute URL such as `http://localhost:8080/api`.
     *
     * The catch, and it is worth knowing before you debug it: a cross-origin request with
     * "include" is only readable if the backend answers with `Access-Control-Allow-Credentials:
     * true` and names the exact origin in `Access-Control-Allow-Origin` — a `*` wildcard is
     * rejected by the browser for credentialed requests. That is what `CORS_ALLOWED_ORIGINS` on
     * the backend is for. If you set `VITE_API_BASE` to an absolute URL and every call starts
     * failing in the browser console with a CORS message, that variable is what is missing.
     */
    credentials: "include",
  };

  if (options.body !== undefined) {
    init.headers = { ...init.headers, "Content-Type": "application/json" };
    init.body = JSON.stringify(options.body);
  } else if (options.rawBody !== undefined) {
    // The blob carries its own MIME type ("audio/mpeg" for an .mp3 the operator picked), and the
    // backend validates that header — so it is forwarded rather than replaced with a JSON one.
    init.headers = { ...init.headers, "Content-Type": options.rawBody.type };
    init.body = options.rawBody;
  }

  try {
    return await fetch(`${API_BASE}${options.path}`, init);
  } catch (cause) {
    // An aborted request is a deliberate cancellation, not a failure worth wrapping.
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new NetworkError(cause);
  }
}

/**
 * Turns a non-2xx response into the `ApiError` every caller catches, and — for a `401` — tells the
 * rest of the app that the session is gone before the error is thrown.
 *
 * Doing it here, in the one place every request funnels through, is what keeps "you have been
 * signed out" from having to be handled again in each page.
 */
async function failure(response: Response, options: RequestOptions): Promise<ApiError> {
  const error = new ApiError(response.status, await readErrorBody(response));
  if (error.isUnauthorized && !options.handlesUnauthorizedItself) {
    unauthorizedHandler?.();
  }
  return error;
}

/** Sends a request and decodes a JSON response body of type `T`. */
async function requestJson<T>(options: RequestOptions): Promise<T> {
  const response = await send(options);
  if (!response.ok) throw await failure(response, options);
  return (await response.json()) as T;
}

/** Sends a request that is expected to answer 204 with no body. */
async function requestEmpty(options: RequestOptions): Promise<void> {
  const response = await send(options);
  if (!response.ok) throw await failure(response, options);
}

/* ------------------------------------------------------------------ */
/* Authentication                                                      */
/* ------------------------------------------------------------------ */

/**
 * `POST /api/auth/login` — exchange the admin password for a session cookie.
 *
 * On success the backend sets `obs_effects_session`, an opaque token, as an `HttpOnly` cookie.
 * `HttpOnly` means JavaScript cannot read it — including this function — so there is nothing to
 * store and nothing to attach to later requests by hand. The browser sends it back on its own; all
 * this code has to do is not switch that off, which is what the `credentials` setting above is.
 *
 * Throws `ApiError` with:
 *  - `status` 401 and code `UNAUTHORIZED` — the password is wrong. This is the one 401 in the app
 *    that must NOT bounce the operator to the login page: they are already on it.
 *  - `status` 429 and code `TOO_MANY_ATTEMPTS` — five consecutive failures; `retryAfterSeconds`
 *    says how long the backend will keep refusing.
 *  - `status` 400 — the password was empty or longer than 1024 characters.
 */
export function login(password: string, signal?: AbortSignal): Promise<SessionInfo> {
  const body: LoginRequest = { password };
  return requestJson<SessionInfo>({
    method: "POST",
    path: "/auth/login",
    body,
    signal,
    handlesUnauthorizedItself: true,
  });
}

/**
 * `POST /api/auth/logout` — end the session and clear the cookie.
 *
 * Always answers 204, even with no cookie or an expired one: the caller asked for a state that is
 * already true, which is not an error.
 */
export function logout(signal?: AbortSignal): Promise<void> {
  return requestEmpty({ method: "POST", path: "/auth/logout", signal });
}

/**
 * `GET /api/auth/session` — "am I signed in?".
 *
 * This endpoint never answers 401. Being signed out is the *answer* (`authenticated: false`), not
 * a failure — if it were a 401 the login page would have to treat its own status check as an error
 * and the redirect logic would chase its own tail.
 */
export function getSession(signal?: AbortSignal): Promise<SessionInfo> {
  return requestJson<SessionInfo>({ method: "GET", path: "/auth/session", signal });
}

/* ------------------------------------------------------------------ */
/* Health                                                              */
/* ------------------------------------------------------------------ */

/** `GET /api/health` — liveness plus a MongoDB ping and current collection counts. */
export function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return requestJson<HealthResponse>({ method: "GET", path: "/health", signal });
}

/* ------------------------------------------------------------------ */
/* Effects inventory                                                   */
/* ------------------------------------------------------------------ */

/** `GET /api/effects` — the inventory the backend has stored, sorted by name. */
export function listEffects(signal?: AbortSignal): Promise<EffectDescriptor[]> {
  return requestJson<EffectDescriptor[]>({ method: "GET", path: "/effects", signal });
}

/**
 * `POST /api/effects/sync` — publish the effects this frontend build actually implements.
 *
 * This is a **full replacement**: whatever is not in `effects` is deleted from the inventory.
 * The frontend is the authority here, because the frontend is where the code lives.
 *
 * **This endpoint needs a session.** It must therefore only ever be called from behind the admin
 * shell, after the session check — never from the renderer page, which would then log a 401 on
 * every OBS browser-source load. See the note on `publishManifest()` in `effects/registry.ts`.
 */
export function syncEffects(
  effects: EffectDescriptor[],
  signal?: AbortSignal,
): Promise<EffectSyncResponse> {
  const body: EffectSyncRequest = { effects };
  return requestJson<EffectSyncResponse>({ method: "POST", path: "/effects/sync", body, signal });
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

/** `GET /api/routes` — every configured route, sorted by slug. */
export function listRoutes(signal?: AbortSignal): Promise<RouteConfig[]> {
  return requestJson<RouteConfig[]>({ method: "GET", path: "/routes", signal });
}

/** `GET /api/routes/{id}` — one route by its ObjectId. Throws `ApiError` 404 if absent. */
export function getRoute(id: string, signal?: AbortSignal): Promise<RouteConfig> {
  return requestJson<RouteConfig>({
    method: "GET",
    path: `/routes/${encodeURIComponent(id)}`,
    signal,
  });
}

/**
 * `GET /api/routes/by-slug/{slug}` — the lookup the renderer page performs on every poll.
 *
 * Disabled routes are returned normally (status 200); it is the renderer that decides to draw
 * nothing. An unknown *or* malformed slug is a 404, never a 400.
 */
export function getRouteBySlug(slug: string, signal?: AbortSignal): Promise<RouteConfig> {
  return requestJson<RouteConfig>({
    method: "GET",
    path: `/routes/by-slug/${encodeURIComponent(slug)}`,
    signal,
  });
}

/** `POST /api/routes` — create a route. Throws `ApiError` with code "SLUG_CONFLICT" on 409. */
export function createRoute(body: RouteWriteRequest, signal?: AbortSignal): Promise<RouteConfig> {
  return requestJson<RouteConfig>({ method: "POST", path: "/routes", body, signal });
}

/**
 * `PUT /api/routes/{id}` — replace a route wholesale.
 *
 * This is a replacement, not a patch: any `params` key missing from `body.params` is deleted
 * from the stored document.
 */
export function updateRoute(
  id: string,
  body: RouteWriteRequest,
  signal?: AbortSignal,
): Promise<RouteConfig> {
  return requestJson<RouteConfig>({
    method: "PUT",
    path: `/routes/${encodeURIComponent(id)}`,
    body,
    signal,
  });
}

/** `DELETE /api/routes/{id}` — remove a route. Answers 204, so there is nothing to return. */
export function deleteRoute(id: string, signal?: AbortSignal): Promise<void> {
  return requestEmpty({ method: "DELETE", path: `/routes/${encodeURIComponent(id)}`, signal });
}

/**
 * The URL of the route's event stream, for `new EventSource(...)`.
 *
 * This is a *URL builder* rather than a request function, because `EventSource` opens the
 * connection itself: there is no `fetch` here to funnel through `send()`. It still belongs in this
 * file, because `API_BASE` — the one piece of knowledge it needs — belongs in this file, and a
 * page that assembled the path by hand would quietly stop working the day somebody sets
 * `VITE_API_BASE`.
 *
 * The endpoint is **public** (`docs/CONTRACT.md` §4), which is what makes it usable from an OBS
 * browser source. `EventSource`'s default `withCredentials: false` is therefore correct and this
 * URL needs no cookie.
 */
export function routeEventsUrl(slug: string): string {
  return `${API_BASE}/routes/by-slug/${encodeURIComponent(slug)}/events`;
}

/* ------------------------------------------------------------------ */
/* OBS audio                                                           */
/* ------------------------------------------------------------------ */

/**
 * `GET /api/settings/obs-audio` — the obs-websocket settings, plus what that connection is doing.
 *
 * Protected: this is the endpoint that would leak the shape of your OBS setup, so it is behind the
 * session cookie like every other admin read. The password is never in the response — see
 * `ObsAudioSettings.passwordSet`.
 */
export function getObsAudioSettings(signal?: AbortSignal): Promise<ObsAudioView> {
  return requestJson<ObsAudioView>({ method: "GET", path: "/settings/obs-audio", signal });
}

/**
 * `PUT /api/settings/obs-audio` — save the settings and reconnect.
 *
 * Saving *always* reconnects, even when nothing changed. That is deliberate: pressing Save is the
 * only "try again now" button an operator has, and making it mean that is worth more than the
 * milliseconds saved by comparing the two documents first.
 *
 * Omit `password` to keep the stored one, pass `null` to clear it, pass a string to replace it.
 */
export function updateObsAudioSettings(
  body: ObsAudioSettingsRequest,
  signal?: AbortSignal,
): Promise<ObsAudioView> {
  return requestJson<ObsAudioView>({
    method: "PUT",
    path: "/settings/obs-audio",
    body,
    signal,
  });
}

/**
 * The absolute URL of the audio level stream, for `new EventSource(...)`.
 *
 * **Public**, exactly like `routeEventsUrl` and for the same reason: an OBS browser source cannot
 * sign in. What makes that safe is what the stream does not carry — loudness numbers and input
 * names go down it, the obs-websocket URL and password never do.
 *
 * There is no slug in the path. Audio is a property of the machine, not of one route, so every
 * browser source reads the same stream.
 */
export function audioLevelsUrl(): string {
  return `${API_BASE}/audio/levels/events`;
}

/* ------------------------------------------------------------------ */
/* Twitch chat                                                         */
/* ------------------------------------------------------------------ */

/**
 * The URL of the chat WebSocket, for `new WebSocket(...)`.
 *
 * A URL builder rather than a request function, like `routeEventsUrl`: the browser's `WebSocket`
 * opens the connection itself, so there is no `fetch` to funnel through `send()`.
 *
 * A WebSocket URL must use the `ws:` or `wss:` scheme — the constructor throws on `http:`. When
 * `API_BASE` is the relative default `/api` it is first made absolute against the page's own
 * origin, and then the leading `http` becomes `ws`. That one substitution handles both cases:
 * `http:` → `ws:` and `https:` → `wss:`, so a page served over TLS gets the encrypted variant
 * without any branching here.
 *
 * The endpoint is **public**, exactly like `routeEventsUrl` and `audioLevelsUrl` and for the same
 * reason: an OBS browser source cannot sign in. What makes that safe is what the stream carries —
 * public chat messages and a connection status, never a token or a secret.
 */
export function chatWsUrl(): string {
  const absolute = /^https?:\/\//.test(API_BASE) ? API_BASE : `${location.origin}${API_BASE}`;
  return `${absolute.replace(/^http/, "ws")}/chat/ws`;
}

/**
 * `GET /api/settings/twitch` — the Twitch chat settings, plus what that connection is doing.
 *
 * Protected, like the OBS audio equivalent. The client secret and any stored tokens are never in
 * the response — see `TwitchSettingsView.clientSecretSet` / `tokensSet`.
 */
export function getTwitchSettings(signal?: AbortSignal): Promise<TwitchView> {
  return requestJson<TwitchView>({ method: "GET", path: "/settings/twitch", signal });
}

/**
 * `PUT /api/settings/twitch` — save the settings and reconnect.
 *
 * Saving always reconnects, even when nothing changed, for the same reason the OBS audio save
 * does: pressing Save is the only "try again now" button an operator has.
 *
 * Omit `clientSecret` to keep the stored one, pass `null` to clear it, a string to replace it.
 */
export function updateTwitchSettings(
  body: TwitchSettingsRequest,
  signal?: AbortSignal,
): Promise<TwitchView> {
  return requestJson<TwitchView>({ method: "PUT", path: "/settings/twitch", body, signal });
}

/**
 * `POST /api/settings/twitch/tokens` — hand the backend an access/refresh token pair directly.
 *
 * This is the escape hatch for an operator who authorized somewhere else (a token generator
 * website, the Twitch CLI) and has the strings in hand. The backend stores them, revalidates, and
 * reconnects; the answer is the same settings-plus-status view the GET returns, so the form can
 * show the outcome without a second request.
 */
export function submitTwitchTokens(
  body: TwitchTokensRequest,
  signal?: AbortSignal,
): Promise<TwitchView> {
  return requestJson<TwitchView>({ method: "POST", path: "/settings/twitch/tokens", body, signal });
}

/**
 * `POST /api/settings/twitch/oauth/complete` — finish the "Connect with Twitch" flow.
 *
 * After the operator approves the app on id.twitch.tv, Twitch redirects the browser back to
 * `/admin/twitch/callback?code=...`. That code is single-use and worthless on its own: only the
 * backend, which holds the client secret, can exchange it for tokens. This call performs that
 * exchange server-side and stores the result. `redirectUri` must be byte-identical to the one the
 * authorize URL used, because Twitch checks the two match before honouring the exchange.
 */
export function completeTwitchOAuth(
  body: TwitchOAuthCompleteRequest,
  signal?: AbortSignal,
): Promise<TwitchView> {
  return requestJson<TwitchView>({
    method: "POST",
    path: "/settings/twitch/oauth/complete",
    body,
    signal,
  });
}

/**
 * `GET /api/chat/history?limit&before` — stored chat messages, newest first.
 *
 * Protected: this is an admin diagnostic, not something an overlay reads — overlays get their
 * backlog from the WebSocket's snapshot frame instead. `before` is an epoch-milliseconds cursor
 * for paging further back: pass the `at` of the oldest message you already have.
 */
export function getChatHistory(
  options?: { limit?: number; before?: number },
  signal?: AbortSignal,
): Promise<ChatMessage[]> {
  const params = new URLSearchParams();
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  if (options?.before !== undefined) params.set("before", String(options.before));
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return requestJson<ChatMessage[]>({ method: "GET", path: `/chat/history${query}`, signal });
}

/* ------------------------------------------------------------------ */
/* Twitch moderation                                                   */
/* ------------------------------------------------------------------ */

/**
 * `GET /api/twitch/admin/status` — can this installation moderate the channel, and if not, why not?
 *
 * **This call always succeeds with a 200.** "Twitch is not configured" and "the stored token
 * predates the moderation permissions" are ordinary answers carried in the body, not errors, which
 * is what lets the dashboard open on a fresh install without a single failing request in the
 * network log. Only a genuinely broken backend makes this throw.
 *
 * Every other function below should be called *only* after this one answered `available: true`;
 * they answer 409 `TWITCH_UNAVAILABLE` otherwise.
 */
export function getTwitchAdminStatus(signal?: AbortSignal): Promise<TwitchAdminStatus> {
  return requestJson<TwitchAdminStatus>({ method: "GET", path: "/twitch/admin/status", signal });
}

/**
 * `GET /api/twitch/admin/bans` — one page of the channel's ban list.
 *
 * Paging is by opaque cursor rather than by page number, because that is all Twitch offers: pass
 * the `cursor` from the previous page to get the next one, and omit it for the first page. `limit`
 * is 1…100 and defaults to 100 on the backend.
 */
export function listTwitchBans(
  options?: { cursor?: string | null; limit?: number },
  signal?: AbortSignal,
): Promise<TwitchBanPage> {
  const params = new URLSearchParams();
  if (options?.cursor) params.set("cursor", options.cursor);
  if (options?.limit !== undefined) params.set("limit", String(options.limit));
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return requestJson<TwitchBanPage>({ method: "GET", path: `/twitch/admin/bans${query}`, signal });
}

/**
 * `POST /api/twitch/admin/bans` — ban or time out up to 100 accounts in one request.
 *
 * `durationSeconds` is what separates the two: absent or `null` bans permanently, a number of
 * seconds times the account out. A mixed result is normal and is *not* thrown — read `succeeded`,
 * `failed` and the per-user `outcomes` of the returned {@link BulkResult}.
 *
 * Throws `ApiError` with:
 *  - `status` 409 `TWITCH_UNAVAILABLE` — the feature is not configured; re-read the status.
 *  - `status` 422 `VALIDATION_FAILED` — no usable logins, more than 100, or a bad duration.
 */
export function banTwitchUsers(body: TwitchBanRequest, signal?: AbortSignal): Promise<BulkResult> {
  return requestJson<BulkResult>({ method: "POST", path: "/twitch/admin/bans", body, signal });
}

/**
 * `POST /api/twitch/admin/unbans` — lift the ban or timeout on up to 100 accounts.
 *
 * A POST rather than a `DELETE` carrying a list: this is one bulk action with one result, not N
 * resource deletions, and a request body on a `DELETE` is awkward for browsers and servers alike.
 *
 * The body names accounts in either of two ways, and may use both at once — see
 * {@link TwitchUnbanRequest}. Pass `targets` whenever the user id is already known (every row of
 * the ban list carries one), because a login can be renamed and re-registered by somebody else
 * between reading the list and pressing the button, and only the id is stable. `users` stays for
 * names that were typed by hand, where there is no id to send. The 100-per-request cap counts the
 * two lists together.
 */
export function unbanTwitchUsers(
  body: TwitchUnbanRequest,
  signal?: AbortSignal,
): Promise<BulkResult> {
  return requestJson<BulkResult>({ method: "POST", path: "/twitch/admin/unbans", body, signal });
}

/** `GET /api/twitch/admin/moderators` — one cursor-paged page of the channel's moderators. */
export function listTwitchModerators(
  cursor?: string | null,
  signal?: AbortSignal,
): Promise<TwitchModeratorPage> {
  const query = cursor ? `?${new URLSearchParams({ cursor }).toString()}` : "";
  return requestJson<TwitchModeratorPage>({
    method: "GET",
    path: `/twitch/admin/moderators${query}`,
    signal,
  });
}

/* ------------------------------------------------------------------ */
/* Sounds                                                              */
/* ------------------------------------------------------------------ */

/**
 * `GET /api/sounds` — every stored sound, builtins included.
 *
 * Protected, like every other admin read: the listing is for the settings page, not for overlays.
 * Overlays never need it — they fetch audio by a name they already know, via `soundAudioUrl`.
 */
export function listSounds(signal?: AbortSignal): Promise<SoundInfo[]> {
  return requestJson<SoundListResponse>({ method: "GET", path: "/sounds", signal }).then(
    (response) => response.sounds,
  );
}

/**
 * `POST /api/sounds?name=<name>` — upload one audio clip.
 *
 * The body is the raw file bytes, not JSON — which is why the name travels as a query parameter
 * instead of in a body field. The file's own MIME type goes up as the `Content-Type` header; the
 * backend accepts `audio/mpeg`, `audio/ogg`, `audio/wav` and `audio/webm`, up to 5 MB.
 *
 * Throws `ApiError` with:
 *  - `status` 422 `VALIDATION_FAILED` — bad name, unsupported content type, or the file is too big.
 *  - `status` 409 — a sound of that name already exists.
 */
export function uploadSound(name: string, file: Blob, signal?: AbortSignal): Promise<SoundInfo> {
  const query = new URLSearchParams({ name }).toString();
  return requestJson<SoundInfo>({ method: "POST", path: `/sounds?${query}`, rawBody: file, signal });
}

/**
 * `DELETE /api/sounds/{id}` — remove an uploaded sound. Answers 204, so there is nothing to return.
 *
 * Deleting a builtin sound is refused with a validation error: effects reference "discord" and
 * "slack-message" by name as their defaults, and a default that could vanish would leave every
 * route using it silently broken.
 */
export function deleteSound(id: string, signal?: AbortSignal): Promise<void> {
  return requestEmpty({ method: "DELETE", path: `/sounds/${encodeURIComponent(id)}`, signal });
}

/**
 * The URL of one sound's audio bytes, for an `<audio>` element or `new Audio(...)`.
 *
 * A URL builder rather than a request function, like `audioLevelsUrl` and for the same reason:
 * the audio element performs the fetch itself, so there is no `fetch` here to funnel through
 * `send()`. The endpoint is **public** — an OBS browser source cannot sign in — and takes either
 * the id or the stable sound name, which is what lets an effect default to `"discord"` without
 * ever calling the protected listing.
 */
export function soundAudioUrl(idOrName: string): string {
  return `${API_BASE}/sounds/${encodeURIComponent(idOrName)}/audio`;
}

/* ------------------------------------------------------------------ */
/* Soundboard                                                          */
/* ------------------------------------------------------------------ */

/**
 * `GET /api/soundboard` — the chat-triggered sound rules.
 *
 * **Public**, unlike the sound listing: the soundboard overlay effect reads it from an OBS browser
 * source, which cannot sign in — the same reason the audio bytes endpoint is public. It carries no
 * secrets, only rule labels, condition trees and sound names.
 */
export function getSoundboard(signal?: AbortSignal): Promise<Soundboard> {
  return requestJson<Soundboard>({ method: "GET", path: "/soundboard", signal });
}

/**
 * `PUT /api/soundboard` — replace the whole rule list.
 *
 * Protected, like every other admin write. This is a replacement, not a patch: any rule you leave
 * out is gone. Rules may omit their `id` — the server assigns fresh ones — and keeping a stored
 * rule's id keeps the overlay's per-rule cooldown state stable across edits.
 *
 * Throws `ApiError` 422 `VALIDATION_FAILED` with `details.issues[]` pointing at individual rules
 * (`rules[2].condition.children[0].value`), which `ApiError.issues` exposes for the form.
 */
export function updateSoundboard(
  body: SoundboardWriteRequest,
  signal?: AbortSignal,
): Promise<Soundboard> {
  return requestJson<Soundboard>({ method: "PUT", path: "/soundboard", body, signal });
}

/* ------------------------------------------------------------------ */
/* Presets                                                             */
/* ------------------------------------------------------------------ */

/**
 * `GET /api/presets` — every saved preset, optionally narrowed to one effect.
 *
 * An `effectId` that no effect owns produces an **empty list, not a 404**: a filter matching
 * nothing is a normal outcome, and only looking something up by its own id can be "not found".
 * That is what lets the route editor ask for the presets of a freshly picked effect without
 * having to know in advance whether any exist.
 */
export function listPresets(effectId?: string, signal?: AbortSignal): Promise<Preset[]> {
  // `URLSearchParams` does the percent-encoding, so an effect id with an unexpected character in
  // it cannot break out of the query string.
  const query = effectId ? `?${new URLSearchParams({ effectId }).toString()}` : "";
  return requestJson<Preset[]>({ method: "GET", path: `/presets${query}`, signal });
}

/**
 * `POST /api/presets` — save a named parameter set for one effect.
 *
 * Throws `ApiError` with code `NAME_CONFLICT` (409) when that effect already has a preset of the
 * same name, compared without regard to case. Names are unique *per effect*, so "Neon" may exist
 * once for the plasma shader and once for the starfield.
 */
export function createPreset(body: PresetWriteRequest, signal?: AbortSignal): Promise<Preset> {
  return requestJson<Preset>({ method: "POST", path: "/presets", body, signal });
}

/**
 * `PUT /api/presets/{id}` — replace a preset wholesale.
 *
 * As with a route, this is a replacement and not a patch: the `params` object you send becomes the
 * whole of the preset's parameters, and any key you leave out is gone.
 */
export function updatePreset(
  id: string,
  body: PresetWriteRequest,
  signal?: AbortSignal,
): Promise<Preset> {
  return requestJson<Preset>({
    method: "PUT",
    path: `/presets/${encodeURIComponent(id)}`,
    body,
    signal,
  });
}

/** `DELETE /api/presets/{id}` — remove a preset. Answers 204, so there is nothing to return. */
export function deletePreset(id: string, signal?: AbortSignal): Promise<void> {
  return requestEmpty({ method: "DELETE", path: `/presets/${encodeURIComponent(id)}`, signal });
}

/* ------------------------------------------------------------------ */
/* Backup: export and import                                           */
/* ------------------------------------------------------------------ */

/**
 * `GET /api/admin/export` — every route and every preset, in one envelope.
 *
 * Effects are deliberately absent from it: the inventory is code that lives in this bundle and is
 * republished on every admin page load, so a backup containing descriptors would only be a way for
 * a restore to contradict the running build.
 *
 * This reads the envelope as JSON rather than letting the browser download the response directly.
 * The server does send `Content-Disposition: attachment`, so a plain link would also produce a
 * file — but a link cannot report a failure: a `401` would open a tab containing an error envelope
 * instead of saving anything. Fetching it means the page can say what went wrong, and can tell the
 * operator how much was in the file it just saved.
 */
export function exportBackup(signal?: AbortSignal): Promise<ExportEnvelope> {
  return requestJson<ExportEnvelope>({ method: "GET", path: "/admin/export", signal });
}

/**
 * `POST /api/admin/import` — restore an export file.
 *
 * `body.mode` decides what happens to what is already stored: `"merge"` deletes nothing, and
 * `"replace"` deletes every route and every preset first. There is no default, on purpose, and
 * this function does not invent one either — the type makes the field required so a caller that
 * forgot it does not compile.
 *
 * The server validates the whole file before writing anything, so a `422 VALIDATION_FAILED` means
 * nothing was changed. Its `details.issues[]` point into the file (`routes[3].slug`), which
 * `ApiError.issues` exposes.
 */
export function importBackup(body: ImportRequest, signal?: AbortSignal): Promise<ImportResult> {
  return requestJson<ImportResult>({ method: "POST", path: "/admin/import", body, signal });
}

/**
 * Turns any thrown value into a sentence that is safe to show in the UI.
 *
 * Used by every page's error banner so that a network hiccup, a validation failure and an
 * unexpected JavaScript error all render the same way instead of crashing the page.
 */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    const issues = error.issues;
    if (issues.length > 0) {
      return `${error.message} (${issues.map((i) => `${i.field}: ${i.message}`).join("; ")})`;
    }
    return error.message;
  }
  if (error instanceof NetworkError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
