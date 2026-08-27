/**
 * TypeScript mirror of the JSON models in `docs/CONTRACT.md`.
 *
 * These types are the *only* place the shape of the API is written down on the frontend.
 * If `docs/CONTRACT.md` changes, change this file first and let the compiler point at every
 * place that needs updating.
 *
 * A note on optional fields: the contract says optional fields are **omitted** from JSON, never
 * sent as `null`. That is why they are written `min?: number` and not `min: number | null`.
 *
 * There is exactly one documented exception, `CanvasSettings.fpsCap`, and the comment on it
 * explains why.
 */

/** Which rendering library an effect is built with. */
export type EffectEngine = "three" | "pixi";

/** The kind of input the admin UI must render for a parameter. */
export type ParamKind = "number" | "color" | "boolean" | "select" | "text";

/**
 * One configurable knob of an effect.
 *
 * The admin UI never hard-codes a form for a specific effect: it walks this list and renders a
 * slider, a color picker, a checkbox, a dropdown or a text box depending on `kind`.
 */
export interface ParamSpec {
  /** Identifier used as a key in `RouteConfig.params`. Matches `^[a-zA-Z][a-zA-Z0-9_]{0,63}$`. */
  key: string;
  /** Human-readable label shown next to the input. */
  label: string;
  kind: ParamKind;
  /** Value used when a route does not override this parameter. Must be valid for `kind`. */
  default: unknown;
  /** Lower bound, only meaningful when `kind` is "number". */
  min?: number;
  /** Upper bound, only meaningful when `kind` is "number". */
  max?: number;
  /** Slider granularity, only meaningful when `kind` is "number". */
  step?: number;
  /** Allowed values. Required and non-empty when `kind` is "select". */
  options?: string[];
  /** Help text shown under the input. May be an empty string, but is always present. */
  description: string;
  /**
   * When true, a change to this parameter makes the renderer **dispose and remount** the effect
   * instead of calling `setParams` on the running one.
   *
   * It is for the few knobs that genuinely cannot change in place: a particle count backed by a
   * fixed-size GPU buffer, a grid resolution baked into a shader's compile-time constants. A
   * remount is visible on air as a black frame, so prefer rebuilding in place — three of the six
   * effects in this build already resize their buffers live rather than declare this.
   *
   * **This field is frontend-only and never travels on the wire.** Every descriptor the frontend
   * renders or mounts comes from the bundled registry in `src/effects/registry.ts`, never from
   * `GET /api/effects` — the API response is used only for its ids, to report which stored effects
   * this build cannot render — so the flag has no round trip to survive. `buildManifest()` strips
   * it before `POST /api/effects/sync`, which keeps the request byte-identical to what
   * `docs/CONTRACT.md` documents and is why no Scala model, validator or codec knows about it.
   *
   * `docs/EFFECT_SDK.md` documents it for effect authors, with the same "not part of the wire
   * contract" note.
   */
  rebuild?: boolean;
}

/** Everything the system knows about one implemented effect. */
export interface EffectDescriptor {
  /** Stable unique id, matches `^[a-z0-9][a-z0-9-]{0,63}$`, e.g. "plasma-field". */
  id: string;
  name: string;
  description: string;
  engine: EffectEngine;
  /** Free-form grouping used to organise the picker, e.g. "background" or "overlay". */
  category: string;
  tags: string[];
  /** Advice shown to the admin, e.g. "looks best over a dark scene". */
  previewNotes: string;
  params: ParamSpec[];
}

/**
 * The **render resolution** of one route.
 *
 * This is not the size of the OBS browser source. It is the pixel size the effect is asked to
 * draw at; the renderer page then scales that block with CSS to fit whatever size the source
 * actually is, keeping the aspect ratio and centring what is left over. Asking a soft ambient
 * background for 1280×720 instead of 1920×1080 means it draws about 44% of the pixels, and the
 * frames it does not draw are frames the game being streamed keeps.
 */
export interface CanvasSettings {
  /** Integer, 16..7680. */
  width: number;
  /** Integer, 16..4320. */
  height: number;
  /**
   * Integer 1..240, or `null` meaning "no cap".
   *
   * This is the one field in the whole contract where an explicit `null` is meaningful rather
   * than omitted. "No cap" has to be distinguishable from "the operator has not chosen yet", and
   * because both readings mean the same thing (uncapped) the contract writes `null` out rather
   * than dropping the key.
   */
  fpsCap: number | null;
}

/** What a route with no stored canvas settings renders at. See `normaliseCanvas`. */
export const CANVAS_DEFAULTS: Readonly<CanvasSettings> = {
  width: 1920,
  height: 1080,
  fpsCap: null,
};

/**
 * The ranges the backend enforces, mirrored here so the admin form can refuse a bad value before
 * it costs a round trip. The upper bounds are 8K: no browser source needs more, and they stop a
 * mistyped `19200` from asking a GPU for 200 megapixels.
 */
export const CANVAS_LIMITS = {
  minWidth: 16,
  maxWidth: 7680,
  minHeight: 16,
  maxHeight: 4320,
  minFpsCap: 1,
  maxFpsCap: 240,
} as const;

/**
 * Fills in whatever a canvas object is missing.
 *
 * Every response is *supposed* to carry a complete `canvas` — the backend substitutes the defaults
 * when it reads a document saved before the field existed. This function exists for the two cases
 * where that promise can still be broken in practice: a backend that has not been upgraded yet,
 * and a hand-written import file. Applying the same defaults on this side turns either one into a
 * route that renders at 1920×1080 instead of a page that crashes on `undefined.width`.
 *
 * It is deliberately tolerant of a *partial* object as well as a missing one, because that is what
 * a hand-edited file produces.
 */
export function normaliseCanvas(raw: Partial<CanvasSettings> | null | undefined): CanvasSettings {
  return {
    width: typeof raw?.width === "number" ? raw.width : CANVAS_DEFAULTS.width,
    height: typeof raw?.height === "number" ? raw.height : CANVAS_DEFAULTS.height,
    fpsCap: typeof raw?.fpsCap === "number" ? raw.fpsCap : null,
  };
}

/**
 * A saved mapping from a URL slug to an effect plus its parameter values.
 *
 * `params` is **sparse**: it only holds the keys the admin actually set. Anything reading a route
 * must start from the descriptor defaults and overwrite them with these values — see
 * `mergeParams()` in `src/effects/registry.ts`.
 */
export interface RouteConfig {
  /** 24-character lowercase hex MongoDB ObjectId, assigned by the server. */
  id: string;
  /** The part that appears in the OBS URL: `/e/<slug>`. Matches `^[a-z0-9][a-z0-9-]{0,63}$`. */
  slug: string;
  effectId: string;
  enabled: boolean;
  params: Record<string, unknown>;
  /** Render resolution and frame cap. Always present in a response, never partial. */
  canvas: CanvasSettings;
  /** ISO-8601 UTC timestamp, e.g. "2026-08-23T14:05:09.123Z". */
  createdAt: string;
  /** ISO-8601 UTC timestamp. The renderer polls this to detect configuration changes. */
  updatedAt: string;
}

/**
 * Body of `POST /api/routes` and `PUT /api/routes/{id}`.
 *
 * It is a `RouteConfig` without the three server-assigned fields. `PUT` is a full replacement:
 * any `params` key you leave out is deleted.
 */
export interface RouteWriteRequest {
  slug: string;
  effectId: string;
  enabled: boolean;
  params: Record<string, unknown>;
  /**
   * Optional, and — unusually — individually partial: a missing key inside it takes its own
   * default rather than being deleted. That is a documented exception to the
   * "`PUT` replaces everything" rule, limited to this one object, because unlike `params` these
   * three fields have fixed defaults that no effect gets to redefine.
   *
   * The admin form always sends all three anyway, so nothing here depends on the exception.
   */
  canvas?: CanvasSettings;
}

/** Body of `POST /api/effects/sync`. A full replacement of the backend's inventory. */
export interface EffectSyncRequest {
  effects: EffectDescriptor[];
}

/** Result of `POST /api/effects/sync`. */
export interface EffectSyncResponse {
  /** How many descriptors were inserted or updated. */
  upserted: number;
  /** How many descriptors existed in the database but were absent from the manifest, so deleted. */
  removed: number;
  /** Inventory size after the sync — equals `effects.length` of the request. */
  total: number;
}

/** Result of `GET /api/health`. */
export interface HealthResponse {
  status: string;
  mongo: string;
  effects: number;
  routes: number;
}

/* ------------------------------------------------------------------ */
/* Authentication                                                      */
/* ------------------------------------------------------------------ */

/**
 * The answer to "am I signed in?".
 *
 * Both `POST /api/auth/login` and `GET /api/auth/session` return this exact shape, which is what
 * lets the admin UI have one code path for "the answer arrived" rather than two.
 */
export interface SessionInfo {
  /** Does the request that asked carry a usable session cookie? */
  authenticated: boolean;
  /**
   * False only when the operator started the backend with `ADMIN_AUTH_DISABLED=true`, which runs
   * the admin with no password at all. The UI hides its sign-out control in that case, because
   * there is nothing to sign out of.
   */
  authRequired: boolean;
  /** ISO-8601 UTC timestamp. Omitted when `authenticated` is false. */
  expiresAt?: string;
}

/** Body of `POST /api/auth/login`. The password is 1..1024 characters. */
export interface LoginRequest {
  password: string;
}

/* ------------------------------------------------------------------ */
/* Presets                                                             */
/* ------------------------------------------------------------------ */

/**
 * A named, reusable set of parameter values for one effect — "Neon night" for `plasma-field`.
 *
 * A preset belongs to no route. Applying one is the admin UI copying `params` into the route
 * editor's form, which the operator then reviews and saves through the ordinary route endpoints;
 * there is deliberately no server-side "apply" endpoint.
 */
export interface Preset {
  /** 24-character lowercase hex MongoDB ObjectId, assigned by the server. */
  id: string;
  /** 1..64 characters after trimming. Unique within one `effectId`, compared case-insensitively. */
  name: string;
  effectId: string;
  /** Sparse, exactly like `RouteConfig.params`. */
  params: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** Body of `POST /api/presets` and `PUT /api/presets/{id}`. */
export interface PresetWriteRequest {
  name: string;
  effectId: string;
  params: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Backup: export and import                                           */
/* ------------------------------------------------------------------ */

/**
 * The body of `GET /api/admin/export`: everything the operator configured, in one file.
 *
 * Effects are deliberately absent. The inventory is code that lives in this bundle and is
 * republished on every admin page load, so putting descriptors in a backup would only create a way
 * for a restore to contradict the running build.
 */
export interface ExportEnvelope {
  /** This build reads and writes version 1 only. */
  schemaVersion: number;
  /** ISO-8601 UTC timestamp. Present in an export, ignored on import. */
  exportedAt: string;
  routes: RouteConfig[];
  presets: Preset[];
}

/**
 * How an import treats what is already in the database.
 *
 * - `merge` — nothing is deleted; a route matching by slug (a preset by effect id plus name) is
 *   overwritten in place, and anything else is created.
 * - `replace` — every route and every preset is deleted first, then the file is inserted.
 */
export type ImportMode = "merge" | "replace";

/**
 * One route as it may appear inside an import file.
 *
 * The contract accepts "`RouteWriteRequest`-shaped **or** full `RouteConfig` objects" here, and
 * this type says exactly that: the four fields a write needs, plus the three server-assigned ones
 * as optional extras. A complete `RouteConfig` — what an export produces — satisfies it, and so
 * does a file somebody typed by hand that has no ids in it at all.
 *
 * Two of the three optional fields are ignored by the server and one is not. `id` is *always*
 * reassigned, so a hand-edited file with a duplicate id cannot corrupt anything, and `updatedAt`
 * always becomes the import time. `createdAt` **is** read when it parses as a timestamp, so that a
 * restore does not report every scene as having been created today.
 */
export type ImportRoute = RouteWriteRequest &
  Partial<Pick<RouteConfig, "id" | "createdAt" | "updatedAt">>;

/** One preset as it may appear inside an import file. Same rules as `ImportRoute`. */
export type ImportPreset = PresetWriteRequest &
  Partial<Pick<Preset, "id" | "createdAt" | "updatedAt">>;

/**
 * The body of `POST /api/admin/import`.
 *
 * `mode` has no default on purpose: the two values differ by "nothing is deleted" versus
 * "everything is deleted first", and guessing wrong destroys a scene collection.
 */
export interface ImportRequest {
  schemaVersion: number;
  mode: ImportMode;
  routes: ImportRoute[];
  presets: ImportPreset[];
}

/** The 200 response of `POST /api/admin/import`: what the file actually did. */
export interface ImportResult {
  routesCreated: number;
  routesUpdated: number;
  routesDeleted: number;
  presetsCreated: number;
  presetsUpdated: number;
  presetsDeleted: number;
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/** Stable machine-readable error codes from the contract's error table. */
export type ApiErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "SLUG_CONFLICT"
  | "NAME_CONFLICT"
  | "UNKNOWN_EFFECT"
  | "VALIDATION_FAILED"
  | "TOO_MANY_ATTEMPTS"
  | "INTERNAL_ERROR";

/**
 * An error code as it actually arrives over the wire.
 *
 * The backend is free to add a code this build of the frontend has never heard of, so the value
 * has to be accepted whatever it is — but the documented codes should still be offered by the
 * editor when you type `error.code === "…"`.
 *
 * `ApiErrorCode | string` looks like it does that, and does not: TypeScript collapses a union of
 * string literals with `string` down to plain `string`, throwing the literals away, and the
 * autocomplete goes with them. `string & {}` is the long-standing way round it. It describes the
 * same set of values as `string`, but because it is written as an intersection TypeScript keeps it
 * as a separate member of the union instead of absorbing the literals into it.
 *
 * This buys autocomplete and documentation, not safety: a misspelled code is still a legal value,
 * because the whole point is that unknown codes must be representable.
 */
export type WireErrorCode = ApiErrorCode | (string & {});

/** One field-level complaint inside a `VALIDATION_FAILED` error. */
export interface ValidationIssue {
  /** Dotted path of the offending field, e.g. "params.speed". */
  field: string;
  message: string;
}

/** The `error` object inside the error envelope every non-2xx response carries. */
export interface ApiErrorBody {
  code: WireErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/** The full error envelope: `{ "error": { ... } }`. */
export interface ApiErrorEnvelope {
  error: ApiErrorBody;
}

/* ------------------------------------------------------------------ */
/* OBS audio                                                           */
/* ------------------------------------------------------------------ */

/**
 * The obs-websocket connection settings, as the admin panel sees them.
 *
 * There is no password field, on purpose. The stored password is a credential the *server* presents
 * to OBS, so unlike the admin password it cannot be hashed — and the only way to keep a value that
 * must stay readable from leaking is never to send it anywhere. `passwordSet` carries the one fact
 * the form needs: whether to say "a password is saved" or "no password".
 */
export interface ObsAudioSettings {
  /** Whether to connect at all. `false` on a fresh install. */
  enabled: boolean;
  /** The WebSocket address, e.g. `ws://host.docker.internal:4455`. */
  url: string;
  /** Whether a password is stored. The value itself only ever travels towards the server. */
  passwordSet: boolean;
  /** Which OBS audio input to follow, or `null` for "sum every input". */
  inputName: string | null;
}

/** A settings save. See {@link ObsAudioSettingsRequest.password} for the three-state rule. */
export interface ObsAudioSettingsRequest {
  enabled: boolean;
  url: string;
  /**
   * Three states, because "leave it alone" and "clear it" are different instructions:
   *
   *   - **omitted** (`undefined`) — keep the stored password. This is what the form sends when the
   *     operator edited the URL and never touched the password box, which is the common case.
   *     Without this, saving any other setting would silently wipe the password, because the form
   *     cannot send back a value it was never given.
   *   - **`null`** — remove the stored password.
   *   - **a string** — replace it.
   */
  password?: string | null;
  inputName: string | null;
}

/** What the backend's OBS connection is doing, for the status badge. */
export type ObsConnectionState = "disabled" | "connecting" | "connected" | "failed";

/** The live connection status. Not stored — it is rebuilt every time the server starts. */
export interface ObsConnectionStatus {
  state: ObsConnectionState;
  /** Why the last attempt failed, in words meant for a human, or `null` if nothing has gone wrong. */
  lastError: string | null;
  /** Epoch milliseconds the current connection was established, or `null` when not connected. */
  connectedSince: number | null;
  /** The OBS version from the handshake — proof that the thing on the other end really is OBS. */
  obsVersion: string | null;
  /** Every audio input OBS has reported a level for, sorted. This is the settings dropdown. */
  inputs: string[];
  /**
   * How many volume-meter messages have arrived. `connected` with this stuck at zero means OBS is
   * reachable but is not sending meters, which is a different problem from a refused connection.
   */
  levelsReceived: number;
  /** How many browser sources are currently receiving levels. */
  subscribers: number;
}

/** Settings and status together: the page always wants both, and two requests could disagree. */
export interface ObsAudioView {
  settings: ObsAudioSettings;
  status: ObsConnectionStatus;
}

/** One audio input's loudness at one instant. */
export interface AudioInputLevel {
  inputName: string;
  /** The loudest channel, 0..1, where 1 is full scale. */
  peak: number;
  /** Per-channel peaks in the order OBS reported them. A stereo input has two. */
  channels: number[];
}

/**
 * One measurement, as carried by a `levels` server-sent event.
 *
 * **These are loudness numbers, not a spectrum.** obs-websocket has no Fast Fourier Transform in it,
 * so there is no way to know how much of a sound was bass and how much was cymbals. What the effect
 * SDK does about that is documented at the top of `src/effects/sdk/audio.ts`.
 */
export interface AudioLevels {
  /** Epoch milliseconds the measurement was taken, for spotting a stream that has gone stale. */
  at: number;
  /** The loudest single channel across every input — the number most effects actually want. */
  peak: number;
  inputs: AudioInputLevel[];
}

/* ------------------------------------------------------------------ */
/* Twitch chat                                                         */
/* ------------------------------------------------------------------ */

/**
 * What kind of thing happened in the channel.
 *
 * `"chat"` is an ordinary message. The other four are channel events the backend translates from
 * Twitch's IRC `USERNOTICE`/`PRIVMSG` tags: a subscription (new or renewed), a gifted
 * subscription, a cheer (a message that spends "bits", Twitch's tipping currency), and a raid
 * (another streamer sending their viewers over). Follows are not on this list on purpose — Twitch
 * only reports them over a different API (EventSub) that this backend does not speak.
 */
export type ChatEventKind = "chat" | "sub" | "gift_sub" | "cheer" | "raid";

/** A run of plain text inside a chat message. */
export interface ChatTextPart {
  type: "text";
  text: string;
}

/**
 * An inline image inside a chat message: a Twitch emote, or a Unicode emoji that the effect SDK
 * replaced with a Twemoji picture so every viewer sees the same artwork.
 */
export interface ChatImagePart {
  type: "image";
  /** The emote's name ("Kappa") or the emoji itself ("🎉"). Drawn as text if the image fails. */
  name: string;
  /** URL of the static image. */
  url: string;
  /** URL of the animated variant, when one exists. Omitted otherwise. */
  animatedUrl?: string;
}

/**
 * One renderable fragment of a chat message. A message's `parts` array is the message split into
 * text runs and inline images, in reading order, so an overlay can draw emotes as pictures without
 * parsing anything itself.
 */
export type ChatPart = ChatTextPart | ChatImagePart;

/** One chat message or channel event, as carried by the chat WebSocket and the history endpoint. */
export interface ChatMessage {
  /** Twitch's message id when it sent one, otherwise a UUID the backend made up. */
  id: string;
  /** Epoch milliseconds the message arrived. */
  at: number;
  /** The channel it was said in, e.g. "worxbend". */
  channel: string;
  /** The sender's login name, always lowercase. */
  username: string;
  /** The sender's name as they style it, e.g. "SomeLogin". Falls back to the login. */
  displayName: string;
  /** `#rrggbb`. The sender's chosen chat colour, or one derived from their username hash. */
  color: string;
  /** A deterministic per-user number (0..0xFFFFFF) for seeding procedural visuals. */
  seed: number;
  event: ChatEventKind;
  /** The message text with emote codes left in place, or the system message for channel events. */
  text: string;
  /** The message split into text and image fragments. May be empty for a bare channel event. */
  parts: ChatPart[];
  /**
   * Event-specific extras: `{tier, months?}` for "sub", `{total}` for "gift_sub", `{bits}` for
   * "cheer", `{viewers}` for "raid". Empty for ordinary chat.
   */
  data: Record<string, unknown>;
}

/**
 * The Twitch connection settings, as the admin panel sees them.
 *
 * The client secret and the OAuth tokens never appear here, for the same reason
 * {@link ObsAudioSettings} has no password field: they are credentials the *server* presents to
 * Twitch, so they cannot be hashed, and the only way to keep a readable secret from leaking is
 * never to send it anywhere. The two booleans carry the only facts the form needs.
 */
export interface TwitchSettingsView {
  /** Whether to connect to Twitch chat at all. `false` on a fresh install. */
  enabled: boolean;
  /** The channel to read, e.g. "worxbend". Empty until configured. */
  channel: string;
  /** The Twitch application's client id. Not secret — it appears in OAuth URLs by design. */
  clientId: string;
  /** Whether a client secret is stored. The value itself only ever travels towards the server. */
  clientSecretSet: boolean;
  /** Whether an OAuth access token is stored, so chat reads as the account instead of anonymously. */
  tokensSet: boolean;
  /** The login of the authorized account, learned from token validation, or `null` when unknown. */
  botLogin: string | null;
}

/** A settings save. See {@link TwitchSettingsRequest.clientSecret} for the three-state rule. */
export interface TwitchSettingsRequest {
  enabled: boolean;
  channel: string;
  clientId: string;
  /**
   * Three states, exactly like {@link ObsAudioSettingsRequest.password} and for the same reason:
   *
   *   - **omitted** (`undefined`) — keep the stored secret.
   *   - **`null`** — remove the stored secret.
   *   - **a string** — replace it.
   */
  clientSecret?: string | null;
}

/** Body of `POST /api/settings/twitch/tokens` — tokens the operator obtained elsewhere. */
export interface TwitchTokensRequest {
  accessToken: string;
  /** `null` when the operator only has an access token. Refresh then cannot happen server-side. */
  refreshToken: string | null;
}

/** Body of `POST /api/settings/twitch/oauth/complete` — finish the "Connect with Twitch" flow. */
export interface TwitchOAuthCompleteRequest {
  /** The `?code=` Twitch appended to the redirect back to `/admin/twitch/callback`. */
  code: string;
  /** The exact redirect URI the authorize step used. Twitch refuses the exchange if it differs. */
  redirectUri: string;
}

/**
 * What the backend's Twitch chat connection is doing.
 *
 * Two "connected" states exist because the IRC connection works with no token at all: Twitch
 * allows anonymous read-only connections. `connectedAnonymous` means chat is flowing but the
 * server is not signed in as anyone; `connectedAuthed` means the stored token worked.
 */
export type TwitchConnectionState =
  "disabled" | "connecting" | "connectedAnonymous" | "connectedAuthed" | "failed";

/** The live connection status. Not stored — it is rebuilt every time the server starts. */
export interface TwitchConnectionStatus {
  state: TwitchConnectionState;
  /** Why the last attempt failed, in words meant for a human, or `null` if nothing went wrong. */
  lastError: string | null;
  /** How many chat messages have arrived since the connection came up. */
  messagesReceived: number;
  /** The channel currently joined, or `null` when not connected. */
  channel: string | null;
}

/** Settings and status together: the page always wants both, and two requests could disagree. */
export interface TwitchView {
  settings: TwitchSettingsView;
  status: TwitchConnectionStatus;
}

/**
 * One frame of the chat WebSocket at `GET /api/chat/ws`, decoded from a JSON text message.
 *
 * On connect the server sends one `snapshot` (the last messages, oldest first), then `message`
 * frames as chat happens, `status` frames when the upstream connection changes state, and a
 * `heartbeat` every few seconds of silence so a client can tell a quiet stream from a dead one.
 */
export type ChatWsFrame =
  | { type: "snapshot"; messages: ChatMessage[] }
  | { type: "message"; message: ChatMessage }
  | { type: "heartbeat"; at: number }
  | { type: "status"; status: TwitchConnectionStatus };

/* ------------------------------------------------------------------ */
/* Sounds                                                              */
/* ------------------------------------------------------------------ */

/**
 * One stored audio clip, playable by chat-triggered effects.
 *
 * The bytes themselves are not in this object — they are large and binary, so they travel on
 * their own endpoint (`GET /api/sounds/{idOrName}/audio`), which is public for the same reason
 * the audio-levels and chat streams are: an OBS browser source cannot sign in.
 */
export interface SoundInfo {
  /** Stable unique id, usable in `/api/sounds/{id}/audio` and as the delete target. */
  id: string;
  /** Human-chosen name, unique, also accepted by the audio endpoint in place of the id. */
  name: string;
  /**
   * `true` for the sounds that ship with the server ("discord", "slack-message"). Builtin sounds
   * cannot be deleted — the backend refuses with a validation error — so the admin UI hides the
   * delete button for them rather than offering an action that can only fail.
   */
  builtin: boolean;
  /** The MIME type the clip was uploaded with, e.g. "audio/mpeg". */
  contentType: string;
  /** Size of the stored bytes, for the listing. */
  sizeBytes: number;
  /** Epoch milliseconds the clip was uploaded (or seeded, for builtins). */
  uploadedAt: number;
}

/** Response of `GET /api/sounds`. */
export interface SoundListResponse {
  sounds: SoundInfo[];
}

/** Regular expression a route slug and an effect id must match. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Regular expression a `ParamSpec.key` must match. */
export const PARAM_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

/** Regular expression a `color` parameter value must match. */
export const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
