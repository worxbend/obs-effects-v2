# obs-effects-v2 — API and data contract

This document is the **single source of truth** shared by the Scala backend, the SolidJS admin UI,
and the effect renderer page. If code and this document disagree, this document wins; change it
first, then change the code.

The project has three moving parts:

- **backend** — Scala 3 service (tapir + netty, direct style) that stores data in MongoDB.
- **frontend** — one Vite app that serves both the admin UI and the effect renderer page.
- **OBS** — the streaming program. It opens a "browser source" (an embedded web page used as a
  video layer) that points at a URL like `http://localhost:3000/e/main-camera` and never changes.

The point of the whole system: you configure an effect once in the admin UI, and OBS picks up the
new configuration by reloading the page — you never have to edit anything inside OBS again.

---

## 1. Vocabulary

- **Effect** — a visual effect implemented in TypeScript on the frontend, drawn with either
  [three.js](https://threejs.org/) (3D) or [pixi.js](https://pixijs.com/) (2D). Each effect is
  described by an `EffectDescriptor`.
- **Inventory** — the backend's stored list of `EffectDescriptor`s. The frontend is the authority on
  which effects exist (it contains the code); it *pushes* its list to the backend on startup.
- **Route** — a `RouteConfig`: a user-chosen slug (`main-camera`) mapped to one effect id plus the
  parameter values to run it with.

---

## 2. JSON models

All JSON is UTF-8. Field names are `camelCase`. Timestamps are ISO-8601 strings in UTC with a
trailing `Z`, for example `2026-08-23T14:05:09.123Z`.

### 2.1 `ParamSpec`

Describes **one knob** of an effect so the admin UI can render an input for it without knowing
anything about the effect itself.

```jsonc
{
  "key": "speed",                 // string, required. Identifier used in RouteConfig.params.
                                  //   must match ^[a-zA-Z][a-zA-Z0-9_]{0,63}$
  "label": "Speed",               // string, required. Human-readable label for the admin form.
  "kind": "number",               // string, required. One of: "number" | "color" | "boolean"
                                  //   | "select" | "text"
  "default": 1.0,                 // required, any JSON value. Must be valid for `kind`.
  "min": 0.0,                     // number, optional. Only meaningful for kind = "number".
  "max": 10.0,                    // number, optional. Only meaningful for kind = "number".
  "step": 0.1,                    // number, optional. Only meaningful for kind = "number".
  "options": ["a", "b"],          // array of strings, optional. REQUIRED and non-empty when
                                  //   kind = "select"; ignored otherwise.
  "description": "How fast ..."   // string, required (may be an empty string).
}
```

Value rules per `kind` — these apply both to `default` here and to values in `RouteConfig.params`:

| `kind`    | Accepted JSON type | Extra rule                                                        |
|-----------|--------------------|-------------------------------------------------------------------|
| `number`  | number             | if `min`/`max` present, `min <= value <= max`                      |
| `color`   | string             | must match `^#[0-9a-fA-F]{6}$` (e.g. `#ff00aa`), lowercase preferred |
| `boolean` | boolean            | —                                                                  |
| `select`  | string             | must be one of `options`                                           |
| `text`    | string             | max length 1024                                                    |

Optional fields are **omitted** from JSON when absent — never sent as `null`.

### 2.2 `EffectDescriptor`

```jsonc
{
  "id": "plasma-field",           // string, required, unique. ^[a-z0-9][a-z0-9-]{0,63}$
  "name": "Plasma Field",         // string, required, 1..128 chars.
  "description": "Animated ...",  // string, required (may be empty).
  "engine": "pixi",               // string, required. "three" | "pixi"
  "category": "background",       // string, required. Free-form grouping for the admin UI,
                                  //   e.g. "background", "overlay", "transition".
  "tags": ["animated", "loop"],   // array of strings, required (may be empty).
  "previewNotes": "Looks best ...",// string, required (may be empty). Advice shown to the admin.
  "params": [ /* ParamSpec */ ]   // array, required (may be empty). Keys must be unique.
}
```

### 2.3 `RouteConfig`

```jsonc
{
  "id": "66c9f0b2e1a4c3d2b1a09876", // string, 24-char lowercase hex MongoDB ObjectId.
                                    //   Server-assigned; ignored in create requests.
  "slug": "main-camera",            // string, required, unique. ^[a-z0-9][a-z0-9-]{0,63}$
  "effectId": "plasma-field",       // string, required. Must exist in the effect inventory.
  "enabled": true,                  // boolean, required. See "What `enabled: false` means" below.
  "params": { "speed": 2.0 },       // object, required (may be empty). Keys must be a subset of
                                    //   the effect's ParamSpec keys; values validated per kind.
  "canvas": {                       // object, ALWAYS present in a response. See below.
    "width": 1920,                  // integer, 16..7680.  Default 1920.
    "height": 1080,                 // integer, 16..4320.  Default 1080.
    "fpsCap": null                  // integer 1..240, or null meaning "no cap". Default null.
  },
  "createdAt": "2026-08-23T14:05:09.123Z", // string, server-assigned.
  "updatedAt": "2026-08-23T14:07:41.004Z"  // string, server-assigned.
}
```

**Params are sparse.** A route only stores the values that differ from — or explicitly restate —
the descriptor defaults. Consumers (renderer, admin) must merge: start from every `ParamSpec.default`,
then overwrite with `RouteConfig.params`. The backend never fills in defaults on write.

#### The `canvas` object *(added in Phase 2)*

`canvas` is the route's **render resolution**: the pixel size the effect is asked to draw at, which
is not necessarily the size of the OBS browser source showing it.

- The renderer page sizes the effect's host `<div>` to exactly `canvas.width` × `canvas.height` CSS
  pixels, then scales that block with a CSS transform to fit the browser source, preserving the
  aspect ratio and centring what is left over. A route set to 1280×720 inside a 1920×1080 source
  therefore draws about 44% of the pixels and is scaled up by the browser. That is the point of the
  setting: a soft ambient background does not need native resolution, and the frames it does not
  draw are frames the game being streamed keeps.
- Because the host has a fixed size, `EffectInstance.resize(w, h)` now receives the *canvas* size,
  not the viewport size, and it fires when the canvas settings change rather than when OBS resizes
  the source. `docs/EFFECT_SDK.md` §3 says so too.
- `fpsCap` is the one place in this contract where an explicit `null` is meaningful. Everywhere else
  an absent value is omitted; here "no cap" has to be distinguishable from "the operator has not
  chosen yet", and both readings collapse to the same behaviour (uncapped), so `null` is written out
  rather than dropped. Encoders must not strip it — see §9.
- **What is enforced today, stated plainly.** `width` and `height` take effect as soon as Phase 2
  ships. `fpsCap` is validated, stored and handed to effects as `EffectContext.fpsCap`, but the six
  effects in this build own their own animation loops and ignore it; the shared frame loop that
  enforces a cap is roadmap item 3.1. Until that lands the admin UI must label the control with
  exactly that limitation, in words, next to the input. The roadmap's rule — a control that silently
  does nothing is worse than no control — applies here as much as it does to `enabled`, and this is
  the compromise: the field enters the model once, and the UI does not pretend.

**Every response that contains a `RouteConfig` contains a complete `canvas` object.** Documents
stored before Phase 2 have no `canvas` field; the repository substitutes the defaults when it reads
one. See §6 for why that is preferred to a migration script.

### 2.4 Request bodies

`RouteCreateRequest` and `RouteUpdateRequest` are `RouteConfig` **without** `id`, `createdAt`,
`updatedAt`:

```jsonc
{
  "slug": "main-camera",
  "effectId": "plasma-field",
  "enabled": true,
  "params": { "speed": 2.0 },
  "canvas": { "width": 1920, "height": 1080, "fpsCap": 30 } // optional, see below
}
```

If a client sends `id`/`createdAt`/`updatedAt` anyway, the server ignores those fields rather than
failing. An update replaces the whole document (`PUT` semantics): omitted `params` keys are removed.

`canvas` is optional in a request, and so is each of its three keys:

- the whole object absent → `{ "width": 1920, "height": 1080, "fpsCap": null }`,
- the object present with keys missing → each missing key takes its own default,
- `"fpsCap": null` and an absent `fpsCap` mean the same thing (uncapped).

This is a deliberate exception to the `PUT`-replaces-everything rule above, and it is limited to
this one object. The alternative — making every admin form send all three keys or lose them — buys
nothing, because unlike `params` these three fields have fixed, universal defaults that no effect
gets to redefine.

`EffectSyncRequest`:

```jsonc
{ "effects": [ /* EffectDescriptor, ... */ ] }
```

`EffectSyncResponse`:

```jsonc
{ "upserted": 12, "removed": 3, "total": 12 }
```

- `upserted` — descriptors inserted or updated.
- `removed` — descriptors that were in the database but absent from this manifest, and were deleted.
- `total` — inventory size after the sync (equals `effects.length`).

Sync is a **full replacement**: the manifest the frontend sends becomes the complete inventory.

### 2.5 `Preset` *(added in Phase 2)*

A **preset** is a named, reusable set of parameter values for one effect: "Neon night" for
`plasma-field`, say. It is not attached to any route. The admin picks a preset in the route editor,
the editor copies its values into the form, and the admin saves the route as usual.

```jsonc
{
  "id": "66ca1f39e1a4c3d2b1a01234", // string, 24-char lowercase hex ObjectId. Server-assigned.
  "name": "Neon night",             // string, required. 1..64 characters after trimming; must
                                    //   contain at least one non-space character. Unique within
                                    //   one effectId, compared case-insensitively.
  "effectId": "plasma-field",       // string, required. Must exist in the effect inventory.
  "params": { "speed": 2.0 },       // object, required (may be empty). Exactly the same rules as
                                    //   RouteConfig.params: sparse, keys must be ParamSpec keys,
                                    //   values validated per kind.
  "createdAt": "2026-08-24T09:00:00.000Z", // string, server-assigned.
  "updatedAt": "2026-08-24T09:00:00.000Z"  // string, server-assigned.
}
```

`PresetWriteRequest` is a `Preset` without `id`, `createdAt` and `updatedAt`; as with routes, those
three are ignored if a client sends them, and `PUT` replaces the whole document.

A preset stores no `enabled` flag and no `canvas`: those belong to a route, not to a look.

### 2.6 `SessionInfo` *(added in Phase 2)*

The answer to "am I signed in?", returned by both `POST /api/auth/login` and
`GET /api/auth/session`. One shape for both endpoints means the admin UI has one code path.

```jsonc
{
  "authenticated": true,         // boolean, required. Does this request carry a usable session?
  "authRequired": true,          // boolean, required. False only when the operator started the
                                 //   server with ADMIN_AUTH_DISABLED=true (see §4).
  "expiresAt": "2026-08-31T09:14:22.000Z" // string, OPTIONAL. Omitted when authenticated is false.
}
```

### 2.7 The export envelope *(added in Phase 2)*

The body of `GET /api/admin/export`, and — with two extra fields — the body accepted by
`POST /api/admin/import`.

```jsonc
{
  "schemaVersion": 1,            // integer, required. This build reads and writes version 1 only.
  "exportedAt": "2026-08-24T10:11:12.000Z", // string, present in an export, ignored on import.
  "routes": [ /* RouteConfig, complete, including id/createdAt/updatedAt */ ],
  "presets": [ /* Preset, complete */ ]
}
```

`ImportRequest` is that same object plus a required `mode`, and without `exportedAt`:

```jsonc
{
  "schemaVersion": 1,
  "mode": "merge",               // string, REQUIRED. "merge" | "replace". There is no default.
  "routes": [ /* RouteWriteRequest-shaped or full RouteConfig objects */ ],
  "presets": [ /* PresetWriteRequest-shaped or full Preset objects */ ]
}
```

`mode` has no default on purpose: the two values differ by "nothing is deleted" versus "everything
is deleted first", and a client that forgot the field is a client whose intention nobody knows.
Guessing wrong destroys a scene collection, so the server refuses to guess.

`ImportResult`, the 200 response:

```jsonc
{
  "routesCreated": 2, "routesUpdated": 1, "routesDeleted": 0,
  "presetsCreated": 4, "presetsUpdated": 0, "presetsDeleted": 0
}
```

**Effects are not exported.** The inventory is code that lives in the frontend bundle, and the
frontend republishes it on every admin page load (`POST /api/effects/sync`), so putting descriptors
in a backup file would only create a way for a restore to contradict the running build.

### 2.8 `ChatMessage` *(added in Phase 4)*

One Twitch chat event, exactly as every consumer receives it — in the WebSocket snapshot, in live
`message` frames, and from `GET /api/chat/history` — so the three sources are interchangeable.

```jsonc
{
  "id": "uuid-or-twitch-msg-id",   // stable; Twitch's message id when it sent one
  "at": 1724800000000,             // epoch ms the backend received it
  "channel": "worxbend",           // lowercase, no leading '#'
  "username": "somelogin",         // sender's login, lowercase
  "displayName": "SomeLogin",      // may differ in case and script
  "color": "#8a2be2",              // sender's chosen chat colour, or derived (see below)
  "seed": 1234567,                 // deterministic per-user number in 0..0xFFFFFF
  "event": "chat",                 // "chat" | "sub" | "gift_sub" | "cheer" | "raid"
  "text": "clean message text",
  "parts": [                       // `text` split for rendering, in reading order
    { "type": "text", "text": "hello " },
    { "type": "image", "name": "Kappa",
      "url": "https://static-cdn.jtvnw.net/emoticons/v2/25/static/dark/3.0",
      "animatedUrl": "https://static-cdn.jtvnw.net/emoticons/v2/25/animated/dark/3.0" }
  ],
  "data": {}                       // event-specific numbers, see the table
}
```

- **`color`** is the IRC `color` tag when the sender chose a chat colour, otherwise `#` followed by
  the first three bytes of SHA-256 of the username as hex — stable across sessions with no state
  kept anywhere.
- **`seed`** is the first four bytes of SHA-256 of the username, read big-endian, masked to 24 bits.
  Overlays use it for procedural avatars and motifs; the derivation is bit-for-bit the one the old
  twitch-vizer project used, so ported scenes draw the same identity for the same user.
- **`parts`** is built on the backend from the IRC `emotes` tag: each emote's position becomes an
  `image` part whose `name` is the text it replaced and whose URLs point at Twitch's CDN. The
  `animatedUrl` is always offered — Twitch serves the static image from that path for emotes that
  have no animation. Unicode-emoji splitting (Twemoji) is the frontend SDK's job, so the backend
  stays free of emoji tables.
- **`event` and `data`**, for the four system events. `text` is Twitch's user-visible system message
  ("SomeLogin subscribed at Tier 1...") when it sent one:

  | `event`    | Comes from                                     | `data`                                        |
  |------------|------------------------------------------------|-----------------------------------------------|
  | `sub`      | `USERNOTICE` with msg-id `sub` / `resub`       | `{ "tier": "1000"\|"2000"\|"3000"\|"prime", "months": 7? }` |
  | `gift_sub` | `USERNOTICE` msg-id `subgift` / `submysterygift` | `{ "total": 5 }` (1 for a single gift)      |
  | `cheer`    | `PRIVMSG` carrying a `bits` tag                | `{ "bits": 250 }`                             |
  | `raid`     | `USERNOTICE` msg-id `raid`                     | `{ "viewers": 42 }`                           |

  Follows are **not** an event: Twitch only reports them over EventSub, not over chat, and this
  integration reads chat. `data` is `{}` for ordinary chat.
- **There is no avatar field.** Avatars need the Helix API plus a token, which is deferred; overlays
  must tolerate the absence and use their procedural fallbacks (that is what `seed` is for).

### 2.9 `SoundInfo` *(added in Phase 5)*

One stored sound — an audio file the chat overlay effect plays when a chat message arrives. This is
the *description* of the file; the bytes themselves come from `GET /api/sounds/{id}/audio`.

```jsonc
{
  "id": "66cf01a2e1a4c3d2b1a05555",   // server-assigned ObjectId, hex string
  "name": "ding",                      // unique, 1–64 chars after trimming, compared exactly
  "builtin": false,                    // true for the two server-seeded sounds; not deletable
  "contentType": "audio/mpeg",         // one of audio/mpeg, audio/ogg, audio/wav, audio/webm
  "sizeBytes": 48231,                  // size of the stored bytes
  "uploadedAt": "2026-08-27T10:00:00.123Z"
}
```

- **`name` uniqueness is exact**, unlike a preset's case-insensitive rule, because a sound name is a
  lookup key: effect parameters reference a sound by name and the audio URL accepts the name
  verbatim, so "Discord" and "discord" would be two different keys, not two spellings of one name.
- **`builtin`** marks the two sounds the server seeds from its own resources at start-up, `discord`
  and `slack-message` (both `audio/mpeg`). Seeding is idempotent — a builtin whose name already
  exists is skipped — so restarts and multiple instances change nothing. A builtin cannot be
  deleted: effect parameters may reference it by name, and the seed would recreate it on the next
  restart anyway.

---

### 2.10 `Soundboard` *(added in Phase 5, condition trees in Phase 5.1)*

The soundboard: an admin-configurable, **ordered** list of rules, each mapping a *condition tree*
over chat messages to a stored sound (§2.9), read by the `soundboard` overlay effect. It is edited
and stored as one document — order is part of the data, because the first matching rule wins.

One rule:

```jsonc
{
  "id": "0badcafe",       // server-assigned, 8 hex chars, stable across edits when the client sends it back
  "label": "Drum roll",   // 1–64 chars, trimmed, display name
  "condition": { /* a condition tree, see below */ },
  "sound": "drum",        // sound NAME (§2.9), not id, 1–64 chars; existence NOT enforced
  "enabled": true
}
```

The whole board, as both endpoints below send and receive it:

```jsonc
{ "rules": [ /* rules as above; max 100, ordered; first match wins */ ] }
```

- **`sound` is a name, not an id**, for the same reason effect parameters reference sounds by name:
  a name survives a delete-and-reupload while an id does not. Whether a sound of that name exists is
  deliberately not enforced — rules may be written before the files they point at are uploaded, and
  the overlay treats a missing sound as silence, not as an error.
- **`id` is server-assigned.** A rule sent without one (or with a value that is not 8 lowercase hex
  characters) gets a fresh id, which the response reports; a rule sent with its stored id keeps it,
  so the overlay can key per-rule state (a cooldown, say) by an id that survives reordering and
  relabelling. Two rules claiming the same id in one request are a 422 (`rules[i].id`).

#### The condition tree

A rule's `condition` is a recursive tagged union, discriminated by `type`. A *group* combines child
conditions; every other type is a *leaf* testing one property of a chat message:

```jsonc
// A group: matches when its children combine truthily under `op`, inverted when `negate` is true.
{ "type": "group", "op": "and",     // "and" | "or"
  "negate": false,                  // NOT(the combined result); optional in requests, defaults to false
  "children": [ /* 1–20 conditions, groups included — this is the recursion */ ] }

// Leaves — each carries exactly one `value` string:
{ "type": "command",  "value": "!drum" }     // first whitespace-delimited token == value, case-insensitive
{ "type": "contains", "value": "hype" }      // case-insensitive substring of the full text
{ "type": "regex",    "value": "\\bhype\\b" } // JS `new RegExp(value, "iu")` tested against the full text
{ "type": "emote",    "value": "" }          // "" = message has ANY Twitch emote; else an emote NAMED value
{ "type": "emoji",    "value": "" }          // "" = message has ANY unicode emoji; else that exact emoji grapheme
{ "type": "event",    "value": "chat" }      // "chat" | "sub" | "gift_sub" | "cheer" | "raid"
{ "type": "user",     "value": "worxbend" }  // sender username OR displayName == value, case-insensitive
```

Bounds, enforced at save time: groups nest at most **5** levels deep (counting the root group as
level 1) and have **1–20** children — an empty group is forbidden, an empty `and` would vacuously
match everything and an empty `or` nothing; one rule's whole tree holds at most **50** nodes,
groups and leaves together. Leaf values: `command`, `contains` and `user` are 1–200 characters,
with no whitespace inside a `command` (it is a single first-word token); `regex` is 1–200
characters and must compile; `emote` and `emoji` are 0–200 characters, where the empty string is
meaningful ("any"); `event` must be one of the five words above. Leaves have no `negate` — to
negate one, wrap it in a one-child group. One negation mechanism, on groups only, keeps both the
model and the query-builder UI simple.

#### Matching semantics

The overlay effect and this document use identical wording on purpose — the effect is the thing
that actually evaluates these trees, in the browser, against the frontend `ChatMessage` (its full
`text`, `parts`, `event`, `username` and `displayName`). The backend never evaluates a condition;
it only stores and validates them:

- **command**: the message's first whitespace-delimited token, compared case-insensitively and
  exactly to `value` (stored as typed, recommend a leading `!`).
- **contains**: `value` is a case-insensitive substring of the full message text.
- **regex**: JavaScript `new RegExp(value, "iu")` tested against the full message text. The backend
  validates with `java.util.regex.Pattern.compile` at save time for early feedback only; a pattern
  that later fails to compile in the browser makes that leaf evaluate **false** (reported once via
  `console.warn`), never the whole rule crash.
- **emote** / **emoji**: tested against the message's image `parts` — an *emote* part originates
  from a Twitch emote, an *emoji* part from Twemoji (a unicode emoji). An empty `value` matches any
  part of that kind; a non-empty `value` compares the emote's name (case-sensitively — Twitch emote
  names are) or the emoji's original grapheme.
- **event**: the message's event kind equals `value`. A `chat` leaf matches ordinary messages;
  `sub`, `gift_sub`, `cheer` and `raid` match those Twitch events, whose `text` the other leaves
  still see.
- **user**: the sender's `username` *or* `displayName` equals `value`, case-insensitively.
- **group**: `and` requires every child to match, `or` at least one; `negate: true` inverts the
  combined result, after combining.
- Rules are evaluated in stored order over enabled rules only; the first rule whose tree matches
  wins.

#### `GET /api/soundboard` *(public)*

`200` with the stored board — `{ "rules": [] }` until someone saves one. Public for the standing
reason: the `soundboard` overlay effect runs in an OBS browser source, which cannot sign in, and
what this exposes is command words and sound names — the same sensitivity tier as the sounds
themselves. Listed in the table in §4.

#### `PUT /api/soundboard` *(protected)*

Replaces the whole board. Send every rule, in order, keeping the `id` of rules that already
existed and omitting it (or sending anything invalid) for new ones. `200` with the stored board,
fresh ids included. Validation failures are reported together in one **422** `VALIDATION_FAILED`
whose issue `field`s use dotted paths into the request — into the tree too:
`rules[3].condition.children[0].value` points at the first child of rule 3's root group. Reported
problems: more than 100 rules; a `label` or `sound` empty after trimming or over 64 characters; an
unknown condition `type` or group `op` (the message names the accepted words); a group without
children, with more than 20, or nested deeper than 5 levels; a tree of more than 50 nodes
(reported on `rules[i].condition`); a leaf `value` outside its bounds above, a `command` containing
whitespace, a `regex` failing to compile (the message carries the compiler's description), an
`event` outside the five words; a duplicated rule id. Nothing is written unless the whole request
is valid.

Stored in the `settings` collection as its own document, `_id: "soundboard"`, beside the OBS audio
and Twitch documents (§6) and for the same one-writer-per-document reason. A rule stored by the
flat Phase 5 shape — `trigger`/`pattern` fields instead of `condition` — is migrated on read: a
`command` trigger becomes a `{ "type": "command" }` leaf and a `regex` trigger a
`{ "type": "regex" }` leaf, which is exactly what those triggers meant. Writing always writes the
tree shape, so the first save after an upgrade completes the migration.

---

### 2.11 `TwitchAdminStatus`, bans and bulk results *(added in Phase 6)*

The models behind the Twitch moderation dashboard: seeing the channel's ban list and moderators,
and banning, timing out or unbanning people in bulk.

**The whole feature is optional, and that is a rule rather than a nicety.** An installation with no
Twitch application, no token, or a token that predates the moderation permissions must keep working
exactly as before — chat overlays included. So "not set up" is modelled as an ordinary answer:
`GET /api/twitch/admin/status` answers **200** in every case, and the four acting endpoints answer
**409** `TWITCH_UNAVAILABLE` (§3) with a sentence saying what to fix. None of these situations is a
`500`, and none of them stops the server starting.

#### `TwitchAdminStatus`

```jsonc
{
  "available": false,                   // can the dashboard act at all?
  "channel": "worxbend",                // the configured channel login; "" when none is set
  "broadcasterId": "123456",            // the channel's numeric Twitch id, or null until looked up
  "moderatorLogin": "botty",            // the account whose token would act, or null
  "grantedScopes": ["chat:read"],       // what the stored token carries; [] also means "never read back"
  "missingScopes": [                    // which of the three this feature uses are absent
    "moderator:read:banned_users",
    "moderator:manage:banned_users",
    "moderation:read"
  ],
  "reason": "No Twitch account is connected — connect one in Settings."  // null when available
}
```

**When it is unavailable**, in the order the reason names them: Twitch chat is switched off; no
channel is configured; the client id or client secret is not saved; no access token is stored; the
stored token cannot be validated; the token is missing `moderator:read:banned_users` or
`moderator:manage:banned_users`; or the channel login is one Twitch does not know.

`moderation:read` is listed in `missingScopes` but does **not** make the dashboard unavailable — it
is needed only by the moderator list, so its absence disables that one panel (which then answers
`409 TWITCH_UNAVAILABLE`) and leaves the ban list and the bulk actions working.

Ids and scope names are safe to expose: a scope name is a permission label, not a credential. The
access token, refresh token and client secret still never leave the server, exactly as in §2.8's
settings view.

#### `TwitchBan`

```jsonc
{
  "userId": "1234",                       // the banned account's numeric Twitch id
  "login": "someviewer",                  // lowercase login
  "displayName": "SomeViewer",            // may differ in case and script
  "reason": "spam",                       // null when the moderator gave none
  "moderatorLogin": "botty",              // who banned them, or null when Twitch did not say
  "createdAt": "2026-08-27T10:00:00.000Z",// when the ban was placed, or null
  "expiresAt": null                       // when a timeout lifts; null means a permanent ban
}
```

**`expiresAt` is `null` for a permanent ban.** Twitch itself sends an empty string there; the
backend normalises it to `null` so a client only ever has to check for one absent-value spelling.
Both timestamps are the contract's ISO-8601 instants, like every other time in this document.

#### `TwitchBanPage` and `TwitchModeratorPage`

```jsonc
{ "bans": [ TwitchBan, ... ], "cursor": "eyJiIjpudWxsL..." }        // cursor null on the last page
{ "moderators": [ { "userId": "1", "login": "mod", "displayName": "Mod" } ], "cursor": null }
```

Paging is **cursor-based, not page-numbered**, because Twitch's is: pass the `cursor` from one
response to get the page after it, and `null` means there is no page after this one. There is no
total count, because Twitch does not send one — a client must not invent page numbers from these.

#### `BulkResult`

```jsonc
{
  "succeeded": 98,
  "failed": 2,
  "outcomes": [
    { "login": "alice", "ok": true,  "message": null },
    { "login": "bob",   "ok": false, "message": "The user specified in the user_id field is already banned" },
    { "login": "ghost", "ok": false, "message": "no such Twitch account" }
  ]
}
```

**One failure never aborts a batch**, and that is the point of the feature: after a raid, ninety-
eight of a hundred bans landing is the useful outcome, not an aborted request. Every user is
attempted independently, every outcome is collected in the order the request listed them, and a
partial success is a **200** whose counts tell the story — never an error. `message` carries
Twitch's own words when Twitch refused (already banned, not currently banned), because that
sentence is the answer to "why did this one not work?". Two failures are decided before Twitch
is asked: a name Twitch does not know answers `no such Twitch account`, and a name that is not
a Twitch login at all (anything other than 1–25 letters, digits and underscores — a pasted URL,
say) answers `not a valid Twitch login`. Twitch would refuse the *whole* lookup over one such
entry, so the server keeps it out of the lookup and reports it on its own line instead.

#### `TwitchUnbanTarget` — unbanning an account that is already identified

```jsonc
{ "userId": "1234", "login": "someviewer" }
```

A row taken straight from `TwitchBan` (above): the numeric id the unban is issued against, plus the
login as it read when that row was loaded, which the server uses **only** to label the outcome so
the report still reads in names.

**Why an id and not a name.** A Twitch login can be renamed, and once the old name is freed anybody
else may register it. So a login is not a stable way of saying "this account": between the moment a
ban list is drawn on screen and the moment the operator presses Unban, `someviewer` can have become
a different person. Unbanning by login means looking the name up again and acting on whoever holds
it now — which can free an account nobody selected while leaving the intended ban in place. The
numeric id never moves between accounts, so a client that already has one must send it.

A client should therefore send `targets` for anything it read out of the ban list, and `users` only
for names a person typed or pasted, where there is no id to send and a lookup is the only option.

---

## 3. Error envelope

Every non-2xx response has exactly this body:

```jsonc
{
  "error": {
    "code": "SLUG_CONFLICT",              // string, stable machine-readable code (see table)
    "message": "Slug 'main-camera' ...",  // string, human-readable, safe to show in the UI
    "details": { "slug": "main-camera" }  // object, OPTIONAL. Omitted when there is nothing to add.
  }
}
```

| HTTP | `code`               | When                                                                    |
|------|----------------------|-------------------------------------------------------------------------|
| 400  | `BAD_REQUEST`        | Malformed JSON, wrong types, missing required field, bad ObjectId format |
| 401  | `UNAUTHORIZED`       | A protected endpoint was called without a usable session, or `POST /api/auth/login` was called with the wrong password |
| 404  | `NOT_FOUND`          | No route with that id or slug; no preset with that id; no effect with that id |
| 409  | `SLUG_CONFLICT`      | Creating/updating a route with a slug another route already owns         |
| 409  | `NAME_CONFLICT`      | Creating/updating a preset with a name another preset of the same effect already owns |
| 409  | `TWITCH_UNAVAILABLE` | A Twitch moderation endpoint (§2.11) was called while the feature cannot act: not configured, no connected account, or a missing permission |
| 422  | `UNKNOWN_EFFECT`     | `effectId` is not present in the inventory                               |
| 422  | `VALIDATION_FAILED`  | Slug pattern, unknown param key, wrong param type, out-of-range number, bad canvas value, anything wrong inside an import file |
| 429  | `TOO_MANY_ATTEMPTS`  | Too many failed logins in a row — see the login endpoint in §4          |
| 500  | `INTERNAL_ERROR`     | Anything unexpected. `message` must not leak stack traces                |

`details` conventions:

- `VALIDATION_FAILED` → `{ "issues": [ { "field": "params.speed", "message": "expected number" } ] }`
- `UNKNOWN_EFFECT` → `{ "effectId": "no-such-effect" }`
- `SLUG_CONFLICT` → `{ "slug": "main-camera" }`
- `NAME_CONFLICT` → `{ "effectId": "plasma-field", "name": "Neon night" }`
- `TWITCH_UNAVAILABLE` → **no `details`.** The `message` is the whole explanation: one plain
  sentence naming what is missing and where to fix it, written for a person to read
- `TOO_MANY_ATTEMPTS` → `{ "retryAfterSeconds": 60 }`, and the response also carries a
  `Retry-After: 60` header, which is the standard place a client looks for that number
- `UNAUTHORIZED` → **no `details` at all.** A 401 must not report whether a password is configured,
  how long a session lasts, or whether one recently expired. There is exactly one principal, so
  there is nothing a caller could do with that information except probe.

There is no `403`. This service has one operator: either a request carries a valid session and may
do everything, or it does not and may do nothing. A separate "authenticated but not allowed" status
would describe a state that cannot exist here.

---

## 4. REST API

Base path `/api`.

**Content type.** Every JSON request and response body is `application/json`, with **no `charset`
parameter**. JSON is UTF-8 by definition (RFC 8259 §8.1), `application/json` has no registered
`charset` parameter, and adding one is at best ignored and at worst flagged by strict tooling. Until
Phase 2 this document promised `application/json; charset=utf-8` while the server sent
`application/json`; the server was right and this sentence is the correction (roadmap item 2.4, gap
G9). The endpoints that do not send a JSON body are the two Server-Sent Events streams
(`GET /api/routes/by-slug/{slug}/events` and `GET /api/audio/levels/events`), which send
`text/event-stream; charset=utf-8` — for `text/*` types the charset parameter *is* meaningful, and
Tapir's SSE body sets it — the WebSocket at `GET /api/chat/ws`, whose text frames carry JSON
but which is not an HTTP response body at all, and the two sound transfers: `POST /api/sounds`
takes the raw audio bytes as its request body, and `GET /api/sounds/{id}/audio` answers with them
under the stored audio `Content-Type`.

**Authentication.** Write endpoints and admin reads require a session cookie; the handful of
endpoints an OBS browser source or a login screen has to reach are public. The rules are next.

### Authentication and the session cookie

The model is **one operator, one password**. There is no user table, no registration, no roles and
no OAuth: this is your own streaming rig, and every one of those would be complexity nobody pays
back. The operator supplies a password hash in an environment variable, signs in once from the admin
UI, and the browser holds a session cookie from then on.

#### Which endpoints need a session

**The rule, so nobody has to guess for an endpoint added later: every endpoint under `/api` requires
a valid session, except the ones on the list below. A new endpoint is protected by default; making
it public means adding a row here with the reason it cannot be protected.**

| Public endpoint | Why it must stay public |
|---|---|
| `GET /api/health` | Monitoring, `make` targets and the compose health story call it before anyone has signed in. It returns two counts and a liveness word, no configuration. |
| `POST /api/auth/login` | You cannot sign in if signing in requires being signed in. |
| `POST /api/auth/logout` | Idempotent, carries no data, and has to work when the session has already expired. |
| `GET /api/auth/session` | The login page asks it whether it needs to show a form at all. |
| `GET /api/routes/by-slug/{slug}` | **An OBS browser source cannot log in.** It opens one URL forever, unattended, and the slug is one you chose. |
| `GET /api/routes/by-slug/{slug}/events` | The push version of the same read, for the same reason. |
| `GET /api/audio/levels/events` | **An OBS browser source cannot log in**, and every audio-reactive effect reads this. It carries loudness numbers and OBS input names — never the obs-websocket URL, and never its password, which is exactly why the WebSocket client lives in the backend and not in the page. |
| `GET /api/chat/ws` | **An OBS browser source cannot log in**, and every chat overlay reads this. It carries public Twitch chat content and connection-state words — never the channel's tokens and never the client secret, which stay on the server for exactly the same reason as the obs-websocket password. |
| `GET /api/sounds/{id}/audio` | **An OBS browser source cannot log in**, and the chat overlay effect plays these. It carries a stored notification sound — the least sensitive thing this server holds — and never any credential. This mirrors the audio-levels precedent above. Only the *download* is public: listing, uploading and deleting sounds are protected. |
| `GET /api/soundboard` | **An OBS browser source cannot log in**, and the `soundboard` overlay effect reads the rules to know what to listen for. It carries command words and sound names — the same sensitivity tier as the sounds those names point at. Only the *read* is public: writing the board is protected. |
| `GET /docs`, `GET /docs/docs.yaml` | The generated API documentation. It describes shapes, not data, and it is outside `/api`. Mentioned here so the list is exhaustive. |

Everything else is protected: `GET /api/effects`, `POST /api/effects/sync`, all of
`GET`/`POST`/`PUT`/`DELETE /api/routes…`, all of `/api/presets…`, both `/api/admin/…` endpoints,
every `/api/settings/…` endpoint (the OBS pair and the four Twitch ones),
the five `/api/twitch/admin/…` moderation endpoints,
`GET /api/chat/history`, and the three sound management endpoints
(`GET`/`POST /api/sounds`, `DELETE /api/sounds/{id}`).

`GET /api/effects` is protected even though it only reads: it is an admin screen's data, and no
public consumer needs it — the renderer page resolves an `effectId` against the effect registry
compiled into its own bundle, never against the API.

> **A consequence that is easy to miss, and it breaks live streams if it is missed.**
> `POST /api/effects/sync` is called today at module scope in `frontend/src/index.tsx`, which means
> it runs on **every** page load, including `/e/:slug` inside OBS. The moment sync becomes
> protected, an OBS browser source starts receiving `401` on every load and logging it. The publish
> must move behind the admin shell, so that it happens after the session check and never from the
> renderer page. See §9.

#### The session cookie

| Attribute | Value | Why |
|---|---|---|
| Name | `obs_effects_session` | Prefixed with the app name so it cannot collide with another service on `localhost`, where cookies are shared across ports. |
| Value | 32 bytes from `java.security.SecureRandom`, Base64url-encoded without padding (43 characters) | Opaque and unguessable. It carries no data at all — no user name, no expiry, no signature — because the server holds the session record and looking it up is one map access. |
| `HttpOnly` | always | JavaScript cannot read the cookie, so a script injected into an admin page (or into an effect) cannot copy the session out. |
| `SameSite` | `Lax` | Blocks the cross-site `POST` that a CSRF attack needs, while still surviving an ordinary top-level navigation such as opening a bookmark. Note that "site" ignores port numbers, so `localhost:3000` → `localhost:8080` counts as same-site and the cookie travels in the dev setup too. |
| `Secure` | only when `SESSION_COOKIE_SECURE=true` (default `false`) | This is used over plain `http://localhost`. Chrome and Firefox do accept `Secure` cookies from `http://localhost`, but not every browser build agrees, and there is no eavesdropper on the loopback interface to defend against. Off by default so login works out of the box; turn it on the moment the admin is served over HTTPS or reached from another machine. |
| `Path` | `/` | One cookie for the whole origin, so a future endpoint outside `/api` is covered. |
| `Max-Age` | `SESSION_TTL_HOURS × 3600`, default `604800` (7 days) | Matches the server-side expiry exactly, so the browser and the server agree on when the session is over. |
| `Expires` | not sent | `Max-Age` alone is honoured by every browser this project targets, and sending both invites them to disagree. |
| `Domain` | not sent | Makes it a host-only cookie: it is offered back to exactly the host that set it and to no subdomain. |

Set on login:

```
Set-Cookie: obs_effects_session=<43 chars>; Path=/; Max-Age=604800; HttpOnly; SameSite=Lax
```

Cleared on logout — same name, same `Path`, empty value, `Max-Age=0`, which is how a browser is told
to delete a cookie:

```
Set-Cookie: obs_effects_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax
```

**Where sessions live.** In memory in the backend process: a map from token to expiry instant,
pruned lazily whenever a token is looked up or a new one is issued. Not in MongoDB. One node, one
operator, and a restart that signs you out is a reasonable price for a component with no schema, no
index and no cleanup job.

**A session ends when** any one of these happens: the operator calls `POST /api/auth/logout`; its
expiry passes; or the backend restarts. Changing `ADMIN_PASSWORD_HASH` does **not** end existing
sessions — the new hash applies to the next login — so a password change that is meant to lock
somebody out must be followed by a restart of the backend container.

**Why there is no CSRF token.** Cross-Site Request Forgery is an attack where another site makes
your browser send an authenticated request. Three properties together close it here: `SameSite=Lax`
withholds the cookie from cross-site `POST`s; every write takes a JSON body, which an HTML form
cannot produce (forms can only send three content types, and `application/json` is not one of
them); and a cross-origin `fetch` is stopped by the CORS rules at the end of §4. Adding a token
would guard against nothing that is still open.

#### Verifying the password

`ADMIN_PASSWORD_HASH` holds a **bcrypt** hash in the usual modular-crypt form — 60 characters
beginning `$2a$`, `$2b$`, `$2x$` or `$2y$`, for example
`$2y$12$Q0oO4S8k1zVJ2mVbW8dQmuO0G0X4mJ5t7Bl0Fq8Bq6bqk5f5UZ2K.`.

- **Library:** `at.favre.lib:bcrypt:0.10.2`, added to `backend/build.mill` as
  `mvn"at.favre.lib:bcrypt:0.10.2"`. It exists on Maven Central and pulls exactly one transitive
  dependency, `at.favre.lib:bytes:1.5.0`.
- **Verification:** `BCrypt.verifyer(Version.VERSION_2A, LongPasswordStrategies.truncate(...))
  .verify(password.toCharArray, hash.toCharArray).verified`. The verifier auto-detects all four
  `$2?$` variants from the hash itself — the version named in that call only selects how many bytes
  the truncation rule keeps — which is why a hash produced by Apache's `htpasswd` (it writes
  `$2y$`) is accepted alongside one produced by a Python or Node tool (usually `$2b$`).
- **Why the truncation strategy is named rather than left at its default.** bcrypt only ever reads
  the first 72 bytes of a password. This library's default is to refuse a longer one by throwing,
  which on the login endpoint would be a `500` where this document promises a `401`; and every
  other bcrypt implementation — `htpasswd` included — truncates instead, so a hash generated
  elsewhere from a long passphrase encodes only its first 72 bytes and would be unusable here.
  Nothing changes for a password of 72 bytes or fewer.
- **Why bcrypt and not argon2.** Argon2 is the better algorithm in the abstract and this document
  would pick it in a multi-user service. The deciding factor here is packaging: the argon2 binding
  for the JVM (`de.mkammerer:argon2-jvm`) loads a native library through JNA, which means
  per-architecture binaries and a second class of start-up failure inside a slim container, while
  at.favre's bcrypt is pure Java. Against a single local password, behind the login rate-limit
  below, bcrypt at cost 12 (roughly a quarter of a second per attempt) is ample.
- **Producing a hash**, with tools that are already around:
  `htpasswd -bnBC 12 "" 'your-password' | cut -d: -f2` (Apache utils), or any bcrypt library.
  Do not reuse a password from anywhere else.
- **The `$` trap.** A bcrypt hash is full of `$`, which shells and Docker Compose both treat as the
  start of a variable. Keep the value in `.env`, quoted with single quotes, and check what actually
  arrived with `docker compose exec backend printenv ADMIN_PASSWORD_HASH` before concluding that
  your password is wrong.

#### What the server does when `ADMIN_PASSWORD_HASH` is unset

**It refuses to start.** It prints a short explanation naming the variable and the way to generate a
value, and exits with status 1.

The alternative — start anyway, unauthenticated, with a loud warning — was rejected. A warning in a
container log is read by nobody, `docker compose up -d` shows no logs at all, and the failure it
guards is an admin panel that lets anyone who can reach port 3000 rewrite what a live broadcast is
displaying. That port is frequently forwarded so a co-host can drive the overlays. Failing closed is
the only default where forgetting the variable cannot end in an unprotected admin.

The escape hatch is explicit rather than implicit: setting `ADMIN_AUTH_DISABLED=true` starts the
server with no authentication at all. In that mode every protected endpoint behaves as though a
session were present, `GET /api/auth/session` answers
`{ "authenticated": true, "authRequired": false }`, `POST /api/auth/login` answers `200` with the
same body whatever password it is given, and the start-up banner says in capitals that the admin is
unprotected. The admin UI hides its sign-out control when `authRequired` is `false`.

The server also refuses to start when `ADMIN_PASSWORD_HASH` is set to something that is not a
readable bcrypt hash. Detecting that at boot turns one clear start-up failure into what would
otherwise be an unexplained `500` on every login attempt.

#### How this looks in the code

`Endpoints.scala` keeps two bases instead of one: the existing public `base`, and a `secureBase`
that adds the session cookie as a Tapir `securityIn` plus the `401` output. The split between public
and protected is then visible in the endpoint descriptions themselves — you can read the file and
count them — and the `ServerSecurityLogic` that turns a cookie into "yes, this is the operator" is
written once. That also puts the security scheme into the generated OpenAPI document at `/docs`.

### `POST /api/auth/login` *(public, added in Phase 2)*

Body:

```jsonc
{ "password": "…" }   // string, required, 1..1024 characters
```

- **200** `SessionInfo`, plus the `Set-Cookie` header shown above.
- **400** `BAD_REQUEST` — malformed body, missing field, or a password longer than 1024 characters.
  The length cap exists so a large body cannot be pushed through bcrypt over and over.
- **401** `UNAUTHORIZED` — wrong password. The body is
  `{ "error": { "code": "UNAUTHORIZED", "message": "Incorrect password." } }` with no `details`.
- **429** `TOO_MANY_ATTEMPTS` — see below.

**Rate limiting.** The server counts consecutive failed logins in memory. After **5** failures it
refuses further attempts for **60 seconds**, answering `429` with a `Retry-After: 60` header, and
does not check the password at all during that window. A successful login, or the window elapsing,
resets the counter. The counter is process-wide rather than per-IP: there is one operator, so
"somebody is guessing" is the only thing it can mean, and a per-IP table would be state to keep for
no gain. It is not persisted, so restarting the backend clears it.

### `POST /api/auth/logout` *(public, added in Phase 2)*

No body.

- **204** always, with the cookie-clearing `Set-Cookie` header. Calling it without a cookie, or with
  an expired one, is not an error: the caller asked for a state that is already true.

### `GET /api/auth/session` *(public, added in Phase 2)*

How the admin UI finds out, on page load, whether it is already signed in.

- **200** `SessionInfo`, always. This endpoint never answers `401` — being signed out is the answer,
  not a failure. If it answered `401` the login page would have to treat its own status check as an
  error and the redirect logic would loop.

### `GET /api/health`

Liveness plus a MongoDB ping.

- **200** `{ "status": "ok", "mongo": "up", "effects": 12, "routes": 3 }`
- **500** error envelope with `INTERNAL_ERROR` if MongoDB is unreachable
  (`"details": { "mongo": "down" }`).

### `GET /api/effects`

Returns the whole inventory, sorted by `name` ascending (case-insensitive).

- **200** `[ EffectDescriptor, ... ]`

### `POST /api/effects/sync`

Called by the frontend at startup to publish the effects it actually implements. Full replacement,
idempotent — calling it twice with the same manifest changes nothing the second time.

- Body: `EffectSyncRequest`
- **200** `EffectSyncResponse`
- **400** malformed body
- **422** `VALIDATION_FAILED` — duplicate `id`s in the manifest, bad `id` pattern, bad `engine`,
  bad `kind`, a `select` param without `options`, or a `default` invalid for its `kind`.

Note: sync does **not** delete routes that point at effects removed from the manifest. Those routes
stay in the database, and `GET /api/routes/by-slug/{slug}` will still return them; the renderer is
responsible for showing a clear "effect no longer available" message.

### `GET /api/routes`

- **200** `[ RouteConfig, ... ]`, sorted by `slug` ascending.

### `POST /api/routes`

- Body: `RouteCreateRequest`
- **201** `RouteConfig` (the stored document, with `id`/`createdAt`/`updatedAt` filled in).
  Response header `Location: /api/routes/{id}`.
- **400** malformed body
- **409** `SLUG_CONFLICT`
- **422** `UNKNOWN_EFFECT` or `VALIDATION_FAILED`

### `GET /api/routes/{id}`

`{id}` is a 24-char hex ObjectId.

- **200** `RouteConfig`
- **400** `BAD_REQUEST` if `{id}` is not a valid ObjectId
- **404** `NOT_FOUND`

### `GET /api/routes/by-slug/{slug}`

The endpoint the effect page calls at runtime, on every load.

- **200** `RouteConfig`
- **404** `NOT_FOUND` (also when the slug does not match the slug pattern — do not 400 here; from the
  browser source's point of view an unusable slug simply does not exist)

Disabled routes (`enabled: false`) are still returned with **200**, with their whole configuration,
so the admin can open, preview and edit a route that is switched off without the API pretending it
is gone.

#### What `enabled: false` means *(decided in Phase 2)*

The flag is a **rendering rule, not an API rule**, and this is the whole of it:

1. `/e/{slug}` draws **nothing** while `enabled` is false: no canvas, no error box, a fully
   transparent page. Switching a layer off mid-stream must look like the layer was never there.
2. If an effect is already mounted when the flag goes false, the renderer **disposes** it rather
   than hiding it. A hidden canvas keeps rendering, and freeing the GPU is the reason an operator
   reaches for the toggle in the first place. Re-enabling mounts a fresh instance — the lifecycle in
   `EFFECT_SDK.md` has no pause state, deliberately.
3. The admin's own preview pane **ignores** `enabled` and always draws, because you have to see what
   you are editing.

Rules 1–3 are why the behaviour lives in `frontend/src/pages/RendererPage.tsx`: not in
`EffectStage.tsx`, which the preview shares, and not in the API, which would take away the admin's
ability to edit a disabled route. Before Phase 2 this document said only that "the renderer decides
what to do", which is how a flag ends up meaning different things in different places.

### `GET /api/routes/by-slug/{slug}/events` *(public, added in Phase 2)*

A [Server-Sent Events](https://developer.mozilla.org/docs/Web/API/Server-sent_events) stream: one
long-lived HTTP response down which the server writes text as things change. SSE rather than
WebSockets because the traffic only ever goes one way, it is ordinary HTTP so proxies do not need
configuring, and the browser's `EventSource` reconnects on its own.

This is what replaces the five-second poll as the *primary* mechanism. The poll stays as the
fallback — see "the client's rule" below.

**Response headers:**

```
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache
X-Accel-Buffering: no
```

`X-Accel-Buffering: no` is nginx's switch for "do not buffer this response". A reverse proxy that
buffers an event stream turns instant updates into no updates at all, and this header is the
one-line way to tell the most common proxy not to.

**Status is always 200**, including for a slug that has no route. See "when the slug does not
exist".

**The events.** Three names; the JSON in each `data:` field is one line, and the order of the
`data:` / `event:` / `retry:` lines inside one event is not significant.

| `event:` | `data:` | Sent when |
|---|---|---|
| `config` | one complete `RouteConfig`, the same object `GET /api/routes/by-slug/{slug}` returns | on connect if the route exists, and on every change to it |
| `absent` | `{ "slug": "main-camera" }` | on connect if there is no such route, and when the route is deleted or renamed away from this slug |
| `heartbeat` | `{ "at": "2026-08-24T10:11:12.000Z" }` | every 20 seconds |

A first event on a live stream looks like this on the wire (the blank line is what terminates an
event, and is required):

```
data: {"id":"66c9f0b2e1a4c3d2b1a09876","slug":"main-camera","effectId":"plasma-field","enabled":true,"params":{"speed":2.0},"canvas":{"width":1920,"height":1080,"fpsCap":null},"createdAt":"2026-08-23T14:05:09.123Z","updatedAt":"2026-08-23T14:07:41.004Z"}
event: config
retry: 3000

```

**The rules, normatively:**

1. **On connect** the server sends exactly one `config` (route exists) or one `absent` (it does
   not), immediately, and that first event carries `retry: 3000` — the SSE directive telling the
   browser to wait 3 seconds before reconnecting after a dropped connection. Sending it once is
   enough; the browser remembers it for the life of the page.
2. **On update** — any successful `POST`/`PUT` to `/api/routes`, or an import — every subscriber to
   that route's slug receives a fresh `config`. A `PUT` that *renames* the slug sends `absent` to
   subscribers of the old slug and `config` to subscribers of the new one.
3. **On delete** subscribers receive `absent`, and the stream stays open.
4. **Heartbeat** every 20 seconds. Idle-connection timeouts in proxies are commonly 30 to 60
   seconds, so 20 gives two chances to be wrong before anything is cut. The timer may be reset by a
   real event; the guarantee is that a healthy stream is never silent for more than 20 seconds.
5. **The stream never ends on its own**, and a slug with no route is not an error. A browser source
   may legitimately be pointed at a slug you have not created yet, and `EventSource` reconnects
   after a *network* failure but gives up permanently on an HTTP error status — so answering `404`
   here would leave that source blank until somebody reloaded it inside OBS. `200` plus an `absent`
   event means that creating the route later starts it working with no further action.
6. **A slug that does not match the slug pattern** also gets `200` and `absent`, for the same reason
   the plain `by-slug` read answers `404` instead of `400`.
7. **Disabled routes stream like any other.** `enabled: false` is data, not an error, and pushing it
   is what makes the admin's toggle take effect on air within a second.
8. **No `id:` field is ever sent**, so `Last-Event-ID` never comes back and there is nothing to
   resume. Every connection starts with a full snapshot, which makes replay pointless.
9. **Slow consumers never block a writer.** Each subscriber has a queue of 8 events; when it is full
   the oldest queued event is dropped. Since each `config` supersedes the one before it, a client
   that stalls and recovers still ends up holding the newest state. A subscriber whose connection
   has closed is removed from the registry.
10. **In-process only.** `RouteService` publishes into a listener registry inside the same JVM. No
    message broker: this is a single-node admin tool and a broker would be a second thing to run.

**Implementation note (no new dependency).** Tapir's netty-sync backend already ships an SSE body:
`sttp.tapir.server.netty.sync.serverSentEventsBody`, a `Flow[ServerSentEvent]` from the ox library,
which arrives transitively with `tapir-netty-server-sync`. One detail decides the shape of the
heartbeat: `sttp.model.sse.ServerSentEvent` can emit `data:`, `event:`, `id:` and `retry:` lines and
nothing else, so an SSE *comment* (`: ping`) is not expressible — and per the SSE specification an
event with no `data:` line is never dispatched to the page. Hence a named `heartbeat` event with a
timestamp payload: it keeps the connection warm *and* the client can see it, which is what the
client-side watchdog (rule 4 below) counts.

**The client's rule — how the poll survives as a fallback.**

The renderer page must satisfy one invariant: **exactly one of "the stream is healthy" and "the
5-second poll is running" is true at any moment.** Both at once doubles the traffic for nothing;
neither means a frozen source.

1. On mount, issue one ordinary `GET /api/routes/by-slug/{slug}` so the first frame does not wait
   for a stream to open, then open the `EventSource`.
2. The stream counts as healthy from the first message of any kind that arrives on it.
3. While it is healthy the poll timer is not running.
4. It counts as unhealthy when `EventSource` fires `error`, or when nothing at all — heartbeats
   included — has arrived for 45 seconds. 45 is a little over two heartbeat intervals, so one lost
   heartbeat is not enough to trip it.
5. On going unhealthy: start the 5-second poll, and close and reopen the `EventSource`. Reopening
   matters because a proxy that buffers the stream holds the connection open forever while
   delivering nothing, which the browser has no reason to treat as an error.
6. When a message arrives on the stream again, stop the poll.
7. If `EventSource` does not exist in the runtime at all, poll only.

The stream is public, so `EventSource` needs no credentials and the default `withCredentials: false`
is correct.

### `PUT /api/routes/{id}`

- Body: `RouteUpdateRequest`
- **200** `RouteConfig` with a refreshed `updatedAt`
- **400** malformed body or bad ObjectId
- **404** `NOT_FOUND`
- **409** `SLUG_CONFLICT` (another route already uses the new slug; reusing the route's own slug is fine)
- **422** `UNKNOWN_EFFECT` or `VALIDATION_FAILED`

### `DELETE /api/routes/{id}`

- **204** empty body
- **400** bad ObjectId
- **404** `NOT_FOUND`

> Every endpoint in this section except the two `by-slug` reads requires a session, and every one of
> them can therefore also answer **401** `UNAUTHORIZED`. That status is not repeated in each list
> above; the rule in "Which endpoints need a session" is what governs.

### `GET /api/audio/levels/events` *(public, added in Phase 3)*

A Server-Sent Events stream carrying how loud OBS is, about twenty times a second. This is what
every audio-reactive effect reads.

**Where the numbers come from.** The backend holds one WebSocket connection to OBS's own
`obs-websocket` server (configured through `/api/settings/obs-audio`, below) and subscribes to its
`InputVolumeMeters` event. Each message that arrives is forwarded down every open stream.

**Why the backend is the WebSocket client and not the browser.** The renderer page is
unauthenticated, because an OBS browser source cannot sign in. If the page opened the WebSocket
itself, the obs-websocket password would have to be served from a public endpoint to anybody who
asked. With the backend as the client the password never leaves the server, one connection serves
any number of browser sources, and the admin panel can report a connection status that means
something.

**There is no slug in the path.** Audio is a property of the machine, not of one route: two browser
sources drawing two different effects want exactly the same numbers.

**Response headers:** the same three as the route event stream — `text/event-stream; charset=utf-8`,
`Cache-Control: no-cache`, `X-Accel-Buffering: no`.

**Events.**

`levels` — one measurement. Sent immediately on connect (carrying the newest known value, so a page
joining mid-stream is not left at silence), and then once per message from OBS.

```
event: levels
data: {"at":1756032000000,"peak":0.62,"inputs":[{"inputName":"Desktop Audio","peak":0.62,"channels":[0.62,0.58]}]}
```

| Field | Type | Meaning |
|---|---|---|
| `at` | number | Epoch milliseconds the measurement was taken, for spotting a stale stream. |
| `peak` | number | The loudest single channel across every input, 0..1 where 1 is full scale. The **maximum**, never a sum: two full-scale inputs are not twice as loud. |
| `inputs` | array | One entry per audio input. Empty when OBS is connected and everything is silent, *and* when nothing is connected at all — the two are told apart by the connection status, not by this stream. |
| `inputs[].inputName` | string | The input's name in OBS, e.g. `Desktop Audio`. |
| `inputs[].peak` | number | That input's loudest channel, 0..1. |
| `inputs[].channels` | number[] | Per-channel peaks in OBS's order. A stereo input has two. |

`heartbeat` — sent after five seconds with no measurement, so the connection has traffic on it even
while OBS is silent. Its `data` is the server's epoch milliseconds.

**It always answers `200`**, including when no OBS connection is configured, when OBS is closed, and
when the connection is failing. In every one of those cases it reports silence. That is deliberate:
`EventSource` gives up permanently on an HTTP error status, and a page that stopped asking would
never notice OBS coming back. A client that receives silence falls back to a simulated signal.

**What this stream is not.** obs-websocket reports **loudness, not a spectrum** — there is no Fast
Fourier Transform anywhere in its protocol, so nothing here says how much of a sound was bass and
how much was cymbals. Effects that draw a spectrum derive one from the loudness; see
`frontend/src/effects/sdk/audio.ts`, which explains exactly what is measured and what is shaped.

### `GET /api/chat/ws` *(public, added in Phase 4)*

A WebSocket carrying live Twitch chat. This is what every chat overlay reads.

**Where the messages come from.** The backend holds one IRC-over-WebSocket connection to Twitch
chat (configured through `/api/settings/twitch`, below), records every message in MongoDB, and fans
each one out to every open socket. One upstream connection serves any number of overlays, history
is recorded even when no browser is open, and tokens never leave the server — the same architecture,
for the same reasons, as the OBS audio pipeline.

**Why a WebSocket where the other streams are Server-Sent Events.** The traffic is still one-way,
but chat is the stream third-party overlay code consumes through the frontend SDK, and the design
commits to a resilient WS proxy for it. The practical consequence for clients: unlike
`EventSource`, a raw WebSocket does **not** reconnect itself, so the SDK owns reconnection with a
doubling backoff (1s up to 15s), mirroring the backend's own retry policy towards Twitch.

**Framing.** Text frames, each one a JSON object with a `type` field:

| Frame | When | Shape |
|---|---|---|
| `snapshot` | First frame on every connection | `{"type":"snapshot","messages":[ChatMessage, ...]}` — the last 50 messages, **oldest first**, so an overlay draws a full conversation instantly. Seeded from the recorded history at server start, so it is not empty right after a restart. |
| `status` | Right after the snapshot, and again on every connection-state change | `{"type":"status","status":{...}}` — the same status object as `GET /api/settings/twitch` (see below), including `state`, `lastError`, `messagesReceived`, `channel` and `subscribers`. |
| `message` | One live chat event | `{"type":"message","message":ChatMessage}` |
| `heartbeat` | After five seconds with no other frame | `{"type":"heartbeat","at":1724800000000}` — the server's epoch milliseconds, so a page can tell a quiet chat from a dead pipe. |

`ChatMessage` is §2.8. Frames the client sends are read and discarded; there is nothing to say.

**It always accepts the connection**, including when chat is disabled, no channel is configured, or
Twitch is unreachable. In those cases the snapshot is empty (or stale) and the `status` frame says
why, and the SDK falls back to its simulated feed — the same never-error contract as the audio
stream, and for the same reason: a client that gave up would never notice chat coming back.

**Delivery guarantees, honestly stated.** Each connection has its own bounded queue of 256
messages. A connection that stops reading long enough to fill it loses the *oldest* queued messages
(never blocking other connections or the publisher); when it catches up it resumes at the newest —
holes are possible for a stalled client, ordering is always preserved, and a live client loses
nothing.

### `GET /api/chat/history` *(protected, added in Phase 4)*

The recorded chat history, `[ ChatMessage, ... ]` **newest first**.

Query parameters:

| Parameter | Meaning |
|---|---|
| `limit` | How many messages, 1 to 200. Defaults to 50. Outside the range → `422 VALIDATION_FAILED`. |
| `before` | Only messages with `at` strictly older than this epoch-milliseconds value. This is the paging cursor: pass the `at` of the oldest message already shown to get the page before it. |

Protected rather than public on the standing rule — it is an admin screen's data. Overlays never
need it: their history is the WebSocket snapshot.

### `GET /api/settings/obs-audio` *(protected, added in Phase 3)*

The stored OBS connection settings, and what that connection is currently doing.

```json
{
  "settings": {
    "enabled": true,
    "url": "ws://host.docker.internal:4455",
    "passwordSet": true,
    "inputName": "Desktop Audio"
  },
  "status": {
    "state": "connected",
    "lastError": null,
    "connectedSince": 1756031000000,
    "obsVersion": "31.0.2",
    "inputs": ["Desktop Audio", "Mic/Aux"],
    "levelsReceived": 18422,
    "subscribers": 2
  }
}
```

**The password is never in the response.** Unlike the admin password, this one is a credential the
server *presents* to OBS rather than one it *checks*, so it cannot be hashed — and the only way to
keep a value that must stay readable from leaking is never to send it anywhere. `passwordSet`
carries the one fact a form needs.

`settings` is what was asked for; `status` is what is actually happening, and it is rebuilt from
nothing every time the server starts. They are returned together because two requests could show a
saved URL beside the status of the connection it replaced — which is precisely the moment an
operator is trying to work out whether their change took effect.

| `status.state` | Meaning |
|---|---|
| `disabled` | `enabled` is false. Nothing is being attempted. |
| `connecting` | Opening the WebSocket, or waiting out the backoff before the next attempt. |
| `connected` | Connected, authenticated and subscribed to volume meters. |
| `failed` | The last attempt failed. Retries continue; `lastError` says why. |

`status.levelsReceived` is worth a look when `state` is `connected`: stuck at zero means OBS is
reachable but is sending no meters, which usually means every audio source in the current scene
collection is muted or inactive. That is a completely different problem from a refused connection.

### `PUT /api/settings/obs-audio` *(protected, added in Phase 3)*

Saves the settings and reconnects.

```json
{
  "enabled": true,
  "url": "ws://host.docker.internal:4455",
  "password": "the-obs-websocket-password",
  "inputName": "Desktop Audio"
}
```

**`password` is three-state, and the three states are different instructions:**

| Sent | Meaning |
|---|---|
| the key **omitted** | Keep the stored password. This is what a form sends when the operator edited the URL and never touched the password box. Without this state, saving any other setting would silently wipe the password — the form cannot send back a value it was never given. |
| `"password": null` | Remove the stored password. |
| `"password": "…"` | Replace it. Trimmed; a value that is only whitespace is stored as no password. |

`inputName` is `null` or absent for "sum every input". It is trimmed, and a blank string means the
same as `null` — a trailing space is invisible in a form and would match no OBS input at all.

**Saving always reconnects**, even when nothing changed. That is deliberate rather than an
oversight: pressing Save is the operator's only "try again now" button for a failing connection, and
making it mean that is worth more than the milliseconds saved by comparing two documents first.

**Responses.** `200` with the same body as the `GET`. `422 VALIDATION_FAILED` for a `url` that is
not a `ws://` or `wss://` address with a host, or an `inputName` over 200 characters. `401` without
a session.

> **A note on `url` for anyone running this in Docker, which is everyone.** The default is
> `ws://host.docker.internal:4455`, not `ws://localhost:4455`, and the difference is the whole
> reason a first connection fails. The backend runs inside a container, where `localhost` is the
> container itself; `host.docker.internal` is the machine running Docker, which is where OBS is.
> Docker Desktop provides that name automatically and `docker-compose.yml` adds it on Linux with an
> `extra_hosts` entry. The port comes from OBS's **Tools → WebSocket Server Settings** dialog, which
> is also where the password lives, under **Show Connect Info**.

### `GET /api/settings/twitch` *(protected, added in Phase 4)*

The stored Twitch chat settings, and what that connection is currently doing.

```json
{
  "settings": {
    "enabled": true,
    "channel": "worxbend",
    "clientId": "abcd1234",
    "clientSecretSet": true,
    "tokensSet": true,
    "botLogin": "worxbend",
    "scopes": ["chat:read", "moderator:manage:banned_users"]
  },
  "status": {
    "state": "connected_authed",
    "lastError": null,
    "messagesReceived": 1234,
    "channel": "worxbend",
    "subscribers": 2
  }
}
```

**The client secret and the tokens are never in the response.** All three are credentials the
server *presents* to Twitch rather than values it checks, so — exactly like the obs-websocket
password — they cannot be hashed and must simply never be sent anywhere. `clientSecretSet` and
`tokensSet` carry the two facts a form needs. `botLogin` is which account the stored token turned
out to belong to, learned from Twitch's validate endpoint on connect; it is informational only.

| `status.state` | Meaning |
|---|---|
| `disabled` | `enabled` is false, or no channel is configured. Nothing is being attempted. |
| `connecting` | Opening the connection, or waiting out the backoff before the next attempt. |
| `connected_anonymous` | Reading public chat with no token. Everything an overlay needs works in this state. |
| `connected_authed` | Connected with a valid access token. |
| `failed` | The last attempt failed. Retries continue with a 1s→15s doubling backoff; `lastError` says why. |

Anonymous and authenticated are separate states because they answer the question the settings page
is really asking: "did my token work?" A token that expires or is revoked does **not** take chat
down — the backend refreshes it once per settings generation when it can (refresh token + client
secret present), and otherwise falls back to `connected_anonymous` with the reason in `lastError`.

`scopes` *(added in Phase 6)* lists what the stored token is allowed to do, as far as the server has
been able to read it back from Twitch; `[]` means "not known yet", which is not the same as "none".
It is safe to send for the same reason as `botLogin`: a scope name is a permission label, not a
credential. It is what lets the settings page say that a token connected before the moderation
feature existed still reads chat but cannot moderate until the account is reconnected.

### `PUT /api/settings/twitch` *(protected, added in Phase 4)*

Saves the settings and reconnects.

```json
{
  "enabled": true,
  "channel": "worxbend",
  "clientId": "abcd1234",
  "clientSecret": "the-app-client-secret"
}
```

- `channel` is forgiving about spelling: it is trimmed, a leading `#` is stripped, and it is
  lowercased — `#SomeChannel` and `somechannel` mean the same login. Empty is valid and means "not
  configured", which behaves like disabled. Anything that cannot be a Twitch login (characters
  outside letters/digits/underscore, or longer than 25) → `422 VALIDATION_FAILED`.
- `clientSecret` is **three-state**, exactly like the obs-audio `password`: key omitted → keep the
  stored secret; `null` → remove it; a string → replace it (trimmed; whitespace-only stores none).
- **Tokens are untouched by this endpoint.** They travel only through the two endpoints below, so a
  settings save can never wipe them by accident.
- **Saving always reconnects**, for the same "Save is the try-again-now button" reason as obs-audio.

**Responses.** `200` with the same body as the `GET`. `422 VALIDATION_FAILED` as above. `401`
without a session.

### `POST /api/settings/twitch/tokens` *(protected, added in Phase 4)*

Stores a token pair the operator obtained themselves, and reconnects: the direct hand-off for
someone who authorized through another tool and has the strings in hand.

```json
{ "accessToken": "abc...", "refreshToken": "def..." }
```

- `accessToken` is trimmed and a pasted `oauth:` prefix is stripped; blank → `422` on `accessToken`.
- `refreshToken` may be omitted or blank. The access token then simply expires (Twitch user tokens
  live a few hours) instead of rotating — the connection falls back to anonymous when that happens.
- The stored `botLogin` is cleared: the new token may belong to a different account, and the
  connection rediscovers whose it is on its next connect.

**Responses.** `200` with the same body as the `GET`. `422` / `401` as usual.

### `POST /api/settings/twitch/oauth/complete` *(protected, added in Phase 4)*

Finishes the "Connect with Twitch" flow: exchanges the authorization code for tokens server-side,
stores them, and reconnects.

```json
{ "code": "the-code-twitch-redirected-back-with", "redirectUri": "https://admin.example/admin/twitch/callback" }
```

The admin UI sends the operator to Twitch's authorize page
(`https://id.twitch.tv/oauth2/authorize?response_type=code&client_id=...&redirect_uri=...&scope=...`), asking for
`chat:read` plus the three moderation scopes the dashboard uses (§2.11), space-separated;
Twitch redirects the browser back to the admin's callback route with `?code=...`, and that page
POSTs the code here. `redirectUri` must be the exact value the authorize request used — Twitch
requires the exchange to repeat it as proof the code was not intercepted.

**Responses.** `200` with the same body as the `GET`. `400 BAD_REQUEST` when no client id and
client secret are saved (the exchange needs the secret, so the flow is only offered once they are),
and when Twitch rejects the code — the body's `message` carries Twitch's reason. `422` for a blank
`code` or `redirectUri`. `401` without a session.

### `GET /api/twitch/admin/status` *(protected, added in Phase 6)*

**Always 200**, with a `TwitchAdminStatus` (§2.11) — including on a brand new installation that has
never seen a Twitch credential. This is the endpoint the dashboard calls on mount to decide whether
to render its panels or an explanation, so it has no failure branch to render.

`401` without a session, like every protected endpoint.

### `GET /api/twitch/admin/bans` *(protected, added in Phase 6)*

| Query    | Meaning |
|----------|---------|
| `cursor` | Twitch's opaque next-page cursor from a previous response. Absent for the first page. |
| `limit`  | How many entries, 1 to 100. Defaults to 100. Outside the range → `422 VALIDATION_FAILED`. |

- **200** `TwitchBanPage` (§2.11), newest first.
- **409** `TWITCH_UNAVAILABLE` when the feature cannot act, or when Twitch itself refused (its
  message is carried through, rate limits included).
- **422** `VALIDATION_FAILED` for a `limit` outside 1..100.

### `POST /api/twitch/admin/bans` *(protected, added in Phase 6)*

Bans or times out up to 100 accounts in one request.

```jsonc
{
  "users": ["alice", "@Bob", "carol"],  // logins; a leading @ is stripped, blanks dropped,
                                        // duplicates removed without regard to case
  "durationSeconds": 600,               // OPTIONAL. Absent or null = permanent ban;
                                        // 1..1209600 (14 days) = a timeout
  "reason": "raid"                      // OPTIONAL, shown in the ban list
}
```

- **200** `BulkResult` (§2.11) — including for a partial success, and including when every user
  failed. The counts and the per-user `outcomes` are the result; the status code is not.
- **409** `TWITCH_UNAVAILABLE` when the feature cannot act, or when Twitch refused to resolve the
  names at all (nothing could be attempted).
- **422** `VALIDATION_FAILED` when `users` names nobody after cleaning, when it names more than 100
  accounts (100 is what a single Twitch lookup resolves), or when `durationSeconds` is outside
  1..1209600.

Requests are issued sequentially with a short pause between them, so a hundred-user batch stays
inside Twitch's rate limit for the channel.

### `POST /api/twitch/admin/unbans` *(protected, added in Phase 6)*

Lifts the ban or timeout on up to 100 accounts, named either by login or by id.

```jsonc
{
  "users": ["alice", "@Bob"],                     // OPTIONAL, default []. Logins, looked up before
                                                  // acting; same cleaning as the bulk ban above
  "targets": [{ "userId": "3", "login": "carol" }] // OPTIONAL, default []. TwitchUnbanTarget (§2.11)
                                                  // rows, acted on directly by id — no lookup
}
```

**Both fields are optional and default to an empty list**, so a client that sends only `users` — as
every client written before `targets` existed does — keeps working exactly as before. At least one
of the two must be non-empty after cleaning, and the **combined** count is what the 100-account
limit applies to: 60 rows plus 41 logins is 101 and is refused, 60 plus 40 is allowed.

**Prefer `targets` for anything read out of the ban list.** A `users` entry is resolved through
Twitch at request time, and a login can have been renamed and re-registered by somebody else since
the ban list was drawn — so a login-based unban can free an account the operator never selected.
A `targets` entry carries the account's numeric id, which never moves between accounts, and is
acted on with no lookup at all. Its `login` is used only to label the outcome. §2.11 spells the
race out in full.

**Ordering and duplicates.** Outcomes come back in a stable order: every `targets` outcome first,
in the order they were sent, then every `users` outcome, in the order they were sent. A repeated
`userId` counts once, and a repeated login counts once without regard to case, exactly as on the
bulk ban. A login that happens to name the same account as one of the `targets` is **not** detected
as a duplicate — spotting that would need the very lookup the id path exists to avoid — so such a
request issues both calls and the second comes back as Twitch's "not banned" refusal for that one
entry.

Same responses as the bulk ban above; a `422 VALIDATION_FAILED` for an empty or over-long request
names the field `users` in both cases, because that is the request's list of accounts as a whole.

**Why a `POST` and not a `DELETE` with a body:** a `DELETE` carrying a list is awkward for both
tapir and browsers — several HTTP stacks drop a `DELETE` body — and this is *one bulk action*
rather than N resource deletions, so there is no single resource path to delete.

### `GET /api/twitch/admin/moderators` *(protected, added in Phase 6)*

Optional query parameter `cursor`, exactly as on the ban list.

- **200** `TwitchModeratorPage` (§2.11).
- **409** `TWITCH_UNAVAILABLE` when the feature cannot act, **and** when the stored token does not
  carry `moderation:read` — the one scope that disables a single panel rather than the dashboard.

### `GET /api/presets` *(protected, added in Phase 2)*

Optional query parameter `effectId` filters to one effect's presets.

- **200** `[ Preset, ... ]`, sorted by `effectId` then `name` (case-insensitive).
- An `effectId` that is unknown or malformed yields an **empty list**, not an error. A filter that
  matches nothing is a normal outcome; only a *lookup* of something that should exist is a `404`.

### `POST /api/presets` *(protected, added in Phase 2)*

- Body: `PresetWriteRequest`
- **201** `Preset`, with `Location: /api/presets/{id}`
- **400** malformed body
- **409** `NAME_CONFLICT`
- **422** `UNKNOWN_EFFECT` or `VALIDATION_FAILED`

### `GET /api/presets/{id}` *(protected, added in Phase 2)*

- **200** `Preset` · **400** bad ObjectId · **404** `NOT_FOUND`

### `PUT /api/presets/{id}` *(protected, added in Phase 2)*

A full replacement, exactly like a route update. It may change `effectId`, in which case `params` is
validated against the new effect and any key that effect does not declare is a `422`.

- **200** `Preset` with a refreshed `updatedAt`
- **400** malformed body or bad ObjectId · **404** `NOT_FOUND` · **409** `NAME_CONFLICT`
- **422** `UNKNOWN_EFFECT` or `VALIDATION_FAILED`

### `DELETE /api/presets/{id}` *(protected, added in Phase 2)*

- **204** empty body · **400** bad ObjectId · **404** `NOT_FOUND`

**There is deliberately no "apply this preset to that route" endpoint.** Applying a preset is the
admin UI copying `preset.params` into the editor form, which the operator then reviews, adjusts and
saves through the ordinary route endpoints. A server-side apply would be a second way to write a
route — a second place for validation and for the `updatedAt` bump to drift — and it would take away
the moment of adjustment that is the reason to start from a preset at all. Saving a preset works the
same way round: the editor posts the effect id and parameter values currently in the form.

A preset whose effect has left the inventory is kept, exactly as a route is (see
`POST /api/effects/sync`). The admin UI marks it unavailable rather than hiding or deleting it.

### `GET /api/admin/export` *(protected, added in Phase 2)*

The backup half of the backup story: everything the operator configured, in one file. Losing the
Mongo volume currently loses every scene.

- **200** the export envelope from §2.7, with the header
  `Content-Disposition: attachment; filename="obs-effects-export-20260824-101112.json"` (the
  timestamp is UTC, `yyyyMMdd-HHmmss`).

Routes and presets are exported **complete**, including `id`, `createdAt` and `updatedAt`, so the
file is a faithful record. What import does with those fields is defined below. Effects are not
exported — see §2.7.

### `POST /api/admin/import` *(protected, added in Phase 2)*

- Body: `ImportRequest` (§2.7)
- **200** `ImportResult`
- **400** malformed body, or `mode` missing or not one of the two words
- **422** `VALIDATION_FAILED` — anything wrong with the contents; see below

**`mode: "merge"`** — nothing is deleted.

- A route is matched to an existing one **by `slug`**; a preset by **`effectId` + `name`**, compared
  case-insensitively.
- A match is overwritten in place: `effectId`, `enabled`, `params` and `canvas` (or, for a preset,
  `name` and `params`) take the file's values, while the stored `id` and `createdAt` are kept.
- No match is created.

**`mode: "replace"`** — every route and every preset is deleted first, then the file's contents are
inserted.

**In both modes:**

- `id` is **always** server-assigned and never taken from the file. A hand-edited file with a
  duplicate or malformed id therefore cannot corrupt the database.
- `createdAt` is taken from the file when it parses as an ISO-8601 instant, and is the import time
  otherwise. A restore that reports every scene as created today loses information for no reason.
- `updatedAt` is always the import time.
- Every write publishes the same SSE events an ordinary write does (rule 2 above), so live browser
  sources follow a restore without being reloaded.

**Validation is complete before the first write, and one problem rejects the whole file.** The
errors are reported together, in a single `VALIDATION_FAILED`, with `details.issues[]` whose `field`
paths point into the file — `routes[3].slug`, `presets[1].params.speed`, `schemaVersion`. That
includes unknown effect ids: a bulk operation reports every problem at once, so import never answers
`409` or `UNKNOWN_EFFECT` even though a single-item create would.

Two duplicates inside one file — the same slug twice, or the same `effectId` + `name` twice — are a
`422` as well. Merging a file against itself has no defined answer.

> **An honest limitation.** The compose stack runs a standalone `mongod`, and MongoDB's
> multi-document transactions require a replica set, so these writes are **not atomic**. A crash
> halfway through a `replace` can leave a partly restored database. Validating everything before
> writing anything is what shrinks that window to "the process died", rather than "one bad value in
> the file left half a restore behind". Re-running the same import repairs it: for a given file both
> modes are idempotent.

> **The inventory has to be populated for an import to succeed**, because every `effectId` is
> checked against it. In practice it always is: the admin UI publishes its manifest on load, and you
> have to load the admin UI to reach the import screen. Restoring into an empty database from a
> script, before any browser has opened the app, will report every route as an unknown effect —
> open `/admin` once first.

### `GET /api/sounds` *(protected, added in Phase 5)*

`200` with every stored sound, wrapped in an envelope object and sorted by `name` ignoring case:

```jsonc
{ "sounds": [ /* SoundInfo, §2.9 */ ] }
```

An envelope rather than a bare array, so a later addition — a total size, say — has somewhere to go
without changing the response's JSON type.

### `POST /api/sounds` *(protected, added in Phase 5)*

Uploads one sound. Unusually for this API the body is **not JSON**: it is the raw audio bytes, so
`fetch(url + "?name=ding", { method: "POST", body: file })` works with no multipart encoding
anywhere. The three pieces travel where raw-body uploads put them:

- the bytes are the request body;
- `name` is a **required query parameter** — the unique name, 1 to 64 characters after trimming;
- the format is the ordinary `Content-Type` header, one of `audio/mpeg`, `audio/ogg`, `audio/wav`
  or `audio/webm` (parameters such as `; codecs=opus` are allowed and ignored).

The body must be non-empty and at most **5 MB** (5 242 880 bytes). `201` with the stored
`SoundInfo` and a `Location: /api/sounds/{id}` header. A missing or unaccepted `Content-Type`, an
empty or oversized body, or a bad name is **422** `VALIDATION_FAILED` (rule 14); a taken name is
**409** `NAME_CONFLICT` (rule 15).

### `DELETE /api/sounds/{id}` *(protected, added in Phase 5)*

`204` on success. A malformed id is **400**; an unknown id is **404**. Deleting a **builtin** sound
is **422** `VALIDATION_FAILED` with field `builtin`: effect parameters may reference it by name,
and start-up seeding would recreate it on the next restart anyway.

There is no "replace a sound" operation, and that is what makes the download below cacheable
forever: the bytes under one id never change. To change a sound, delete it and upload again — the
upload mints a fresh id.

### `GET /api/sounds/{id}/audio` *(public, added in Phase 5)*

The audio bytes, with the stored `Content-Type` and
`Cache-Control: public, max-age=31536000, immutable` — a year of caching, safe because content
under one id is immutable (see the delete endpoint above).

**The `{id}` slot accepts either the database id or the sound's `name`.** Effect parameters
reference sounds by name, because a name survives a delete-and-reupload while an id does not, so
the chat overlay can build `/api/sounds/ding/audio` straight from its configuration. A value that
looks like an ObjectId (24 hex characters) is tried as an id first, then as a name, so a sound
whose name happens to be 24 hex characters is still reachable. Unknown id or name is **404**.

Public for the standing reason — the overlay runs in an OBS browser source, which cannot sign in —
and listed in the table in §4.

### CORS

Cross-Origin Resource Sharing is the browser rule that a page loaded from one origin may not read a
response from another origin unless that other origin allows it. An *origin* is scheme + host +
port, so `http://localhost:3000` and `http://localhost:8080` are two of them.

**The default mode — no credentials.** With no `CORS_ALLOWED_ORIGINS` set, the backend sends:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type
```

and answers `OPTIONS` preflight requests with **204**.

`Access-Control-Allow-Headers: Content-Type` is the second half of roadmap item 2.4 (gap G9), and
here **this document was right and the server has to change**: it currently answers `*`. The reason
is exactly the session cookie introduced in this phase. A wildcard is *ignored* on a credentialed
request — when a browser sends a request with `credentials: "include"` it requires the header to
name `Content-Type` literally, and treats `*` as the literal string. Naming the header works in both
modes, so there is no configuration in which `*` is the better answer. Add a header to this list on
the day the code starts sending one, and not before.

**The credentialed mode.** A wildcard origin and cookies are mutually exclusive by specification, so
signing in from a *different* origin than the API needs an explicit list. Setting
`CORS_ALLOWED_ORIGINS` to a comma-separated list of exact origins (for example
`http://localhost:3000`) switches the backend to:

```
Access-Control-Allow-Origin: http://localhost:3000     (echoed, only when the request's Origin is on the list)
Access-Control-Allow-Credentials: true
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type
Vary: Origin
```

`Vary: Origin` tells any cache that the response depends on which origin asked, so one origin's
response is never replayed to another.

Tapir's `CORSInterceptor` refuses to build a configuration that combines "allow all origins" with
"allow credentials", which means this rule is enforced when the server starts rather than discovered
in a browser console.

**The simplest configuration is to have no second origin at all**, and that is the default this
project now ships: the browser talks to `/api` on the same origin as the app, and the Vite dev
server proxies it to the backend container (`vite.config.ts` already does this). Same origin means
no preflight, no CORS headers in play and a plain first-party cookie. It is also the shape
production takes — one reverse proxy in front of both halves, roadmap item 4.2 — so the development
setup stops being a special case. See `VITE_API_BASE` in §7.

The Vite dev proxy passes an event stream through without buffering it, so the SSE endpoint works
through it unchanged. Any future proxy needs the same property: for nginx that is
`proxy_buffering off` for this path, which the `X-Accel-Buffering: no` response header already
requests.

---

## 5. Validation rules (normative)

1. `RouteConfig.slug` must match `^[a-z0-9][a-z0-9-]{0,63}$` — lowercase letters, digits and
   hyphens, starting with a letter or digit, 1 to 64 characters. Otherwise **422**
   `VALIDATION_FAILED`.
2. `RouteConfig.effectId` must be the `id` of a descriptor currently in the inventory. Otherwise
   **422** `UNKNOWN_EFFECT`.
3. Every key in `RouteConfig.params` must be the `key` of one of that effect's `ParamSpec`s. An
   unknown key is **422** `VALIDATION_FAILED` — silently dropping it would hide typos.
4. Every value in `RouteConfig.params` must satisfy the type/range table in §2.1. Otherwise **422**
   `VALIDATION_FAILED`.
5. `slug` uniqueness is enforced both by application check and by a unique MongoDB index, so a race
   between two simultaneous creates still ends in **409** rather than duplicate data.
6. `EffectDescriptor.id` must match `^[a-z0-9][a-z0-9-]{0,63}$`; `engine` ∈ {`three`, `pixi`};
   `ParamSpec.kind` ∈ {`number`, `color`, `boolean`, `select`, `text`}.

*Added in Phase 2:*

7. `RouteConfig.canvas.width` is an integer, 16 ≤ width ≤ 7680. `canvas.height` is an integer,
   16 ≤ height ≤ 4320. `canvas.fpsCap` is `null`, absent, or an integer with 1 ≤ fpsCap ≤ 240.
   Otherwise **422** `VALIDATION_FAILED`, with `field` paths `canvas.width`, `canvas.height`,
   `canvas.fpsCap`. The upper bounds are 8K, which no browser source needs and which stops a typed
   `19200` from asking a GPU for 200 megapixels.
8. A canvas number that is not whole — `1920.5` — is **422**, not 400. JSON has one number type, so
   "not an integer" is a rule about the value rather than about the shape, and the contract's line
   between the two statuses is exactly that (see the raw-model note in `domain/Models.scala`).
9. `Preset.name`, after trimming leading and trailing whitespace, is 1 to 64 characters and contains
   at least one non-space character. Otherwise **422** `VALIDATION_FAILED`. The trimmed form is what
   gets stored.
10. `Preset.name` is unique within one `effectId`, compared **case-insensitively**: "Neon" and
    "neon" collide. Otherwise **409** `NAME_CONFLICT`. Two different effects may each own a preset
    called "Default".
11. `Preset.effectId` and `Preset.params` obey rules 2, 3 and 4 exactly as a route's do — same
    lookup, same unknown-key rejection, same per-kind value table.
12. An import (`POST /api/admin/import`) accepts `schemaVersion` 1 only, requires `mode`, rejects
    duplicate slugs and duplicate `effectId` + `name` pairs *within the file*, and validates every
    route and every preset by all the rules above. Any failure rejects the entire file and nothing
    is written. All failures are reported together in one `VALIDATION_FAILED`.
13. `POST /api/auth/login` requires `password` to be a string of 1 to 1024 characters. Anything else
    is **400** `BAD_REQUEST` — never 401, because the shape of the request is wrong rather than the
    credential.

*Added in Phase 5:*

14. A sound upload (`POST /api/sounds`): `name`, after trimming, is 1 to 64 characters with at
    least one non-space character; the `Content-Type` media type is one of `audio/mpeg`,
    `audio/ogg`, `audio/wav`, `audio/webm`; the body is non-empty and at most 5 242 880 bytes
    (5 MB). Otherwise **422** `VALIDATION_FAILED` with `field` paths `name`, `contentType`, `body`,
    all problems reported together.
15. A sound `name` is unique, compared **exactly** (case matters — see §2.9 for why this differs
    from the preset rule). Otherwise **409** `NAME_CONFLICT`, whose `details` carry `{ "name" }`
    and — unlike a preset conflict — no `effectId`.
16. A builtin sound cannot be deleted: **422** `VALIDATION_FAILED` with `field` `builtin`.

---

## 6. MongoDB

Database name comes from `MONGO_DB` (default `obs_effects`).

### Collection `effects`

Document shape equals `EffectDescriptor` with the descriptor's `id` stored as the Mongo `_id`
(a string, not an ObjectId — the id is already a stable human-readable slug).

Indexes:

| Index                 | Definition                | Purpose                                  |
|-----------------------|---------------------------|------------------------------------------|
| `_id_`                | implicit on `_id`         | unique effect id                         |
| `effects_name_idx`    | `{ name: 1 }`             | supports the sorted `GET /api/effects`   |

### Collection `routes`

Document shape equals `RouteConfig` with `id` stored as the Mongo `_id` ObjectId, and `createdAt` /
`updatedAt` stored as BSON dates (converted to ISO-8601 strings on the way out).

Indexes:

| Index               | Definition                       | Purpose                        |
|---------------------|----------------------------------|--------------------------------|
| `_id_`              | implicit on `_id`                | lookup by id                   |
| `routes_slug_uniq`  | `{ slug: 1 }`, `unique: true`    | slug lookup + uniqueness (409) |
| `routes_effect_idx` | `{ effectId: 1 }`                | "which routes use this effect" |

The `canvas` sub-document *(added in Phase 2)* is stored as
`{ width: <int32>, height: <int32>, fpsCap: <int32> }`, with `fpsCap` **left out entirely** when the
route is uncapped — the same "optional fields are omitted, never null" style the rest of the stored
shape uses.

**Documents written before Phase 2 have no `canvas` field at all, and there is no migration
script.** The repository substitutes the defaults when it reads a document that lacks the field (or
lacks individual keys inside it). This is the intended design, not an oversight:

- Defaulting on read is one branch in one function (`routeFromDocument`), it is idempotent, and it
  keeps working forever — including for a database restored from an old backup file six months from
  now, which a one-shot migration would not.
- A migration script is a thing that has to be run exactly once, in the right order, by a person, on
  a machine that this project deliberately assumes has no MongoDB tooling installed.
- Documents converge on their own: the next save of a route writes the field, because `PUT` replaces
  the whole document.
- Nothing ever writes a partial `canvas` object, so the read path only has to handle "the whole
  thing is missing" and "it is complete", never a half-written one.

### Collection `presets` *(added in Phase 2)*

Document shape equals `Preset` with `id` stored as the Mongo `_id` ObjectId and the two timestamps
stored as BSON dates, exactly like `routes`.

Indexes:

| Index                       | Definition                                                             | Purpose                                 |
|-----------------------------|------------------------------------------------------------------------|-----------------------------------------|
| `_id_`                      | implicit on `_id`                                                       | lookup by id                            |
| `presets_effect_name_uniq`  | `{ effectId: 1, name: 1 }`, `unique: true`, collation `{ locale: "en", strength: 2 }` | name uniqueness per effect (409), and the `?effectId=` filter |

Collation *strength 2* means comparisons ignore case and accents, which is what makes "Neon" and
"neon" collide in the unique index without storing a second, lower-cased copy of the name.

There is no separate index on `effectId`: it is the leading field of the compound index above, and
MongoDB can use a compound index's leading fields on their own. One caveat worth knowing — a query
that does not specify the same collation will not use that index and will scan the collection
instead. With a preset list measured in dozens that costs nothing, and it is the reason the sorting
is done in the service rather than by the database.

Indexes for all collections are created at application startup, and creation is idempotent.

### Collection `settings` *(added in Phase 3; Twitch document added in Phase 4)*

One document per settings area, each found by a fixed string `_id`. The OBS audio document:

```json
{
  "_id": "obs-audio",
  "enabled": true,
  "url": "ws://host.docker.internal:4455",
  "password": "the-obs-websocket-password",
  "inputName": "Desktop Audio"
}
```

`password` and `inputName` are absent when not set, rather than stored as `null`. Every field is
optional on read and falls back to its default, so a document written by an older build still loads
— the settings document is the last thing that should be able to stop the server booting.

**The password is stored as it was typed**, and that deserves a sentence rather than a shrug. It
cannot be hashed: unlike the admin password, this is not a value the server *checks*, it is a
credential the server has to *present* to obs-websocket, so a one-way hash would make it useless.
Anyone who can read this database can read it — the same trust boundary as `MONGO_URI` itself. What
the design does control is that it never leaves the server: no API returns it, and no browser source
ever sees it.

**Why a collection with a handful of documents in it**, rather than environment variables:
environment variables cannot be changed from the admin panel, and that is the entire requirement.
An operator who mistypes their obs-websocket password should fix it in a form and press Save, not
edit a `.env` file and restart the server in the middle of a broadcast.

Each document is looked up by its fixed `_id` rather than "the first one in the collection", so a
stray document cannot appear and start winning at random.

The Twitch chat document *(added in Phase 4)* sits beside it under `_id: "twitch"`:

```json
{
  "_id": "twitch",
  "enabled": true,
  "channel": "worxbend",
  "clientId": "abcd1234",
  "clientSecret": "the-app-client-secret",
  "accessToken": "abc...",
  "refreshToken": "def...",
  "botLogin": "worxbend",
  "broadcasterId": "123456",
  "botUserId": "654321",
  "scopes": ["chat:read", "moderator:manage:banned_users"]
}
```

The last three were added in Phase 6 for the moderation dashboard (§2.11). `broadcasterId` is the
channel's numeric Twitch id, looked up once from `channel` and remembered — the moderation API
addresses a channel by id and never by name — and it is cleared whenever the channel changes, so a
renamed channel can never be moderated by the previous channel's id. `botUserId` and `scopes` are
what the stored token turned out to be and to allow, learned from Twitch's validate endpoint and
re-learned whenever a new token is stored. All three are absent when unknown, and a document
written before Phase 6 reads back with them absent rather than failing — the same boot-safety rule
as every other field here.

The optional fields (`clientSecret`, `accessToken`, `refreshToken`, `botLogin`) are absent when not
set, never `null`; every field is optional on read and falls back to its default, the same
boot-safety rule as the OBS document. The credentials are stored as received for the same
present-not-check reason as the obs-websocket password, with the same defence: no API ever returns
them.

**Why a separate document rather than more fields on `obs-audio`, and this is load-bearing:** the
backend itself rewrites this document from a background thread when it refreshes an expired access
token (Twitch rotates the refresh token too, so the new pair must be persisted immediately). If the
two settings areas shared one document, that background write could race an operator saving OBS
settings and silently undo one or the other. Separate documents make the two writes independent.

### Collection `chatMessages` *(added in Phase 4)*

One document per chat event, appended as it arrives from Twitch, whether or not any overlay is
open. Document shape equals `ChatMessage` (§2.8) with the message's own `id` stored as the Mongo
`_id` (a string — Twitch's message id when it sent one), `parts` as an array of sub-documents
discriminated by their `type` field, and `at` as an int64 of epoch milliseconds.

Using the message id as `_id` makes appends naturally idempotent: Twitch can replay a message
across a reconnect, and the duplicate-key rejection is the replay being deduplicated by the
database rather than an error.

Indexes:

| Index                 | Definition                     | Purpose                                        |
|-----------------------|--------------------------------|------------------------------------------------|
| `_id_`                | implicit on `_id`              | dedupe on replay                               |
| `chat_channel_at_idx` | `{ channel: 1, at: -1 }`       | a future per-channel history filter            |
| `chat_at_idx`         | `{ at: -1 }`                   | `GET /api/chat/history` — newest-first, paged with `before` (a sort on `at` alone cannot use the compound index, whose leading field is `channel`) |

Reads are deliberately lenient — every field falls back rather than throws, and an unrecognised
`event` or part `type` loads as plain chat text — because history is display data, and one odd
document written by a future build must not break the history endpoint or the snapshot that seeds
the WebSocket ring at start-up.

There is no retention cap in this phase. Chat volume for a single channel is small (a document per
message, a few hundred bytes each); if that ever matters, a TTL index on `at` is the one-line fix.

### GridFS bucket `sounds` *(added in Phase 5)*

Sounds are stored in **GridFS**, MongoDB's convention for files: the bytes live as chunk documents
in `sounds.chunks`, and one description document per file lives in `sounds.files`. The driver
already ships GridFS, so no new dependency was needed, and keeping the audio in the database means
a backup of the database is a backup of the sounds too.

Everything the API reports about a sound beyond its bytes lives in the files document's `metadata`
sub-document:

```jsonc
{
  "_id": ObjectId("..."),          // becomes SoundInfo.id
  "length": 48231,                  // becomes SoundInfo.sizeBytes
  "filename": "ding",               // GridFS's own name field; informational
  "metadata": {
    "name": "ding",                 // the unique name the API uses
    "builtin": false,
    "contentType": "audio/mpeg",
    "uploadedAt": ISODate("...")    // the authoritative upload time (not GridFS's own uploadDate,
                                    // so the application clock is the one source of truth)
  }
}
```

Indexes (on `sounds.files`, beyond the ones GridFS creates itself):

| Index              | Definition             | Purpose                                                  |
|--------------------|------------------------|----------------------------------------------------------|
| `sounds_name_uniq` | `{ metadata.name: 1 }` unique, **no collation** | name uniqueness, exact-match on purpose (§2.9) |

### Sessions are not in MongoDB

Login sessions live in a map inside the backend process (§4). There is no `sessions` collection and
nothing to look for in mongo-express. A restart signs the operator out.

---

## 7. Environment variables

| Variable        | Used by  | Default in docker compose      | Meaning                                    |
|-----------------|----------|--------------------------------|--------------------------------------------|
| `MONGO_URI`     | backend  | `mongodb://mongo:27017`        | MongoDB connection string                  |
| `MONGO_DB`      | backend  | `obs_effects`                  | Database name                              |
| `HTTP_PORT`     | backend  | `8080`                         | Port the tapir/netty server listens on     |
| `VITE_API_BASE` | frontend | *(empty — same origin)*        | Base URL the browser uses to reach the API |

*Added in Phase 2:*

| Variable                | Used by | Default in docker compose | Meaning                                                                 |
|-------------------------|---------|---------------------------|-------------------------------------------------------------------------|
| `ADMIN_PASSWORD_HASH`   | backend | *(unset)*                 | bcrypt hash of the admin password. Unset ⇒ the server refuses to start, unless `ADMIN_AUTH_DISABLED=true`. |
| `ADMIN_AUTH_DISABLED`   | backend | `false`                   | `true` runs with no authentication at all, and says so loudly at start-up. The deliberate escape hatch, never the default. |
| `SESSION_TTL_HOURS`     | backend | `168` (7 days)            | Session lifetime, and the cookie's `Max-Age`.                            |
| `SESSION_COOKIE_SECURE` | backend | `false`                   | `true` adds `Secure` to the session cookie. Turn it on when serving over HTTPS. |
| `CORS_ALLOWED_ORIGINS`  | backend | *(unset)*                 | Comma-separated exact origins allowed to send credentialed cross-origin requests. Unset keeps the wildcard, no-credentials mode. |

`VITE_API_BASE` is read **in the browser**, so it must be a URL reachable from the host machine (and
from OBS), not a Docker-internal hostname. It is inlined by Vite at build time; changing it requires
restarting the frontend container.

**Its default changed in Phase 2, and this matters for logging in.** It used to be
`http://localhost:8080/api`, which makes the admin UI a *cross-origin* client of the API. A session
cookie in that arrangement needs credentialed CORS on both sides, which in turn forbids the wildcard
origin — three moving parts, in a setup where the frontend container already proxies `/api` to the
backend. Leaving `VITE_API_BASE` empty makes the client fall back to the relative path `/api`, so
the browser talks to one origin, the cookie is first-party, and no preflight happens at all. Set it
to an absolute URL only if you deliberately want the browser to bypass the proxy, and then also set
`CORS_ALLOWED_ORIGINS` or the login will not stick.

Nothing is run on the host: `docker compose up` starts `mongo`, `backend` (dev mode) and `frontend`
(Vite dev server with hot module replacement) together.

---

## 8. Frontend routing

| Path              | What it renders                                                              |
|-------------------|------------------------------------------------------------------------------|
| `/`               | redirect to `/admin`                                                         |
| `/admin`          | route list — every `RouteConfig` with its effect name and enabled state       |
| `/admin/routes/new`   | create form                                                              |
| `/admin/routes/new?from=<id>` | the same create form, **pre-filled from route `<id>`** — this is "duplicate a route" *(Phase 2)* |
| `/admin/routes/:id`   | edit form (parameter inputs generated from the effect's `ParamSpec`s)     |
| `/admin/effects`      | read-only inventory browser                                              |
| `/admin/presets`      | preset list: create, rename, delete *(Phase 2)*                          |
| `/admin/backup`       | export and import *(Phase 2)*                                            |
| `/admin/login`        | the sign-in form *(Phase 2)*                                             |
| `/e/:slug`        | the renderer — what OBS points at                                            |
| anything else     | a plain 404 page inside the admin shell                                      |

### Duplicating a route is a client-side action *(decided in Phase 2)*

There is no `POST /api/routes/{id}/duplicate`. "Duplicate" opens the existing create form with every
field copied from the source route and the slug set to the first free `<slug>-copy`,
`<slug>-copy-2`, … and the operator saves it through the ordinary `POST /api/routes`.

Two reasons, and the second is the real one:

1. A server endpoint would have to invent the new slug on its own, which means teaching the backend
   a naming convention that exists to be looked at and edited.
2. Nobody duplicates a route in order to have two identical routes. They duplicate it to make "the
   same, but blue" — so the very next thing they want is the form, open, with the values in it.
   The endpoint would save one HTTP call and then land them on the same screen anyway.

### Sessions in the admin UI *(added in Phase 2)*

- The admin shell asks `GET /api/auth/session` before it renders anything that needs data. If the
  answer is `{ "authenticated": false, "authRequired": true }` it navigates to
  `/admin/login?next=<the path that was wanted>`, and the login page returns there afterwards.
- The API client sends `credentials: "include"` on every request, so the cookie travels in both the
  same-origin default and the cross-origin fallback.
- Any `401` from any call, at any time, means the session ended while the tab was open. The client
  raises it as an `ApiError` with `status === 401`; the shell reacts by sending the operator to the
  login page with `next` set to where they were, rather than showing a red banner they can do
  nothing about.
- When `authRequired` is `false` the shell hides the sign-out control, because there is nothing to
  sign out of.
- **The renderer page never does any of this.** It calls no protected endpoint, checks no session,
  and must never redirect: a browser source that navigated itself to a login page would replace a
  live layer with an admin screen.

### `/e/:slug` behaviour

1. Body background is fully transparent (`background: transparent`) and all scrollbars/margins are
   removed, so OBS composites the effect over the rest of the scene.
2. On load it calls `GET /api/routes/by-slug/{slug}` once, then opens the event stream
   `GET /api/routes/by-slug/{slug}/events` and follows the client's rule in §4 — the stream is the
   normal path and the 5-second poll is the fallback, with exactly one of the two active.
   - **404**, or an `absent` event → render nothing visible; show the "no route configured" message
     and log one clear line to the console.
   - `enabled: false` → render nothing visible, and dispose a running effect. No message: switching
     a layer off is a normal action, and an error box appearing in the scene is worse than the blank
     the operator asked for.
3. It resolves `effectId` against its local effect registry, merges `ParamSpec` defaults with
   `RouteConfig.params`, and mounts the effect (see `EFFECT_SDK.md`).
4. When a new `RouteConfig` arrives — from the stream or from the fallback poll — a changed
   `updatedAt` means it calls `setParams` with the merged parameters, with no page reload, and a
   changed `effectId` means it disposes the old effect and mounts the new one. This is what lets the
   admin tweak a live scene without touching OBS, now within about a second rather than five.
5. It sizes the effect's host element to `canvas.width` × `canvas.height` and scales that block to
   fit the browser source:
   `scale = min(viewportWidth / canvas.width, viewportHeight / canvas.height)`, centred, with the
   aspect ratio preserved. The page stays transparent, so whatever is left over at the
   edges shows the scene underneath rather than bars.
6. It calls `resize(width, height)` with the **canvas** size when the canvas settings change. It no
   longer passes the viewport size: a `ResizeObserver` on the page now drives the scale factor
   above, not the effect's own dimensions.
7. It passes `canvas.fpsCap` to the effect as `EffectContext.fpsCap` (`number | null`). Effects
   built on the shared frame loop from roadmap item 3.1 will honour it; the six effects in this
   build own their loops and ignore it, which the admin UI states next to the input.

---

## 9. Where a change to these models lands *(Phase 2)*

A field added to `RouteConfig` is never a one-file change: the Scala side describes it four times
(domain model, validation, JSON codec, BSON codec) and the TypeScript side twice (types, forms).
Missing one of them fails in a different way each time — a value that validates but is never stored,
a value that is stored but never returned, a form that sends a field the decoder drops in silence.

The lists below are exhaustive for the Phase 2 work. Anyone implementing one line of them should be
able to tick off the rest.

### 9.1 Adding `canvas` to `RouteConfig`

**Backend**

| File | What changes |
|---|---|
| `backend/src/obseffects/domain/Models.scala` | New `final case class CanvasSettings(width: Int, height: Int, fpsCap: Option[Int])`. `RouteConfig` and `RouteInput` each gain `canvas: CanvasSettings`. A raw counterpart — `RawCanvasSettings(width: Option[Double], height: Option[Double], fpsCap: Option[Double])` — and `RawRouteInput` gains `canvas: Option[RawCanvasSettings]`. The raw type keeps the numbers as `Double` for the same reason every other raw field is a `String`: a non-integer must reach the validator as a 422 rather than fail decoding as a 400. |
| `backend/src/obseffects/domain/Validation.scala` | Range and integrality checks, producing issues with the `canvas.*` field paths, and the defaulting of absent keys. |
| `backend/src/obseffects/infrastructure/http/Wire.scala` | `CanvasSettingsDto`; `RouteConfigDto` gains a required `canvas`, `RouteRequestDto` an optional one; `toDto` / `toRaw` for both directions; circe `Decoder`/`Encoder`; a Tapir `Schema`. |
| `backend/src/obseffects/infrastructure/mongo/BsonCodecs.scala` | `routeInputToDocument` writes the `canvas` sub-document (omitting `fpsCap` when uncapped); `routeFromDocument` reads it and substitutes defaults when it is absent. |
| `backend/test/src/obseffects/domain/ValidationSuite.scala`, `.../application/RouteServiceSuite.scala`, `.../application/InMemoryRepositories.scala` | Boundary cases (15/16/7680/7681, `1920.5`, `fpsCap` 0/1/240/241/null), plus every existing fixture that constructs a `RouteConfig` or `RouteInput` by hand. |

> **One codec detail that will otherwise be found the hard way.** `"fpsCap": null` must survive
> encoding. `Wire.scala` post-processes some encoders with `deepDropNullValues` so that optional
> fields are omitted rather than sent as `null`. `CanvasSettingsDto` must **not** be encoded that
> way, and must not be nested inside an encoder that is, or "uncapped" arrives at the frontend as a
> missing key. `RouteConfigDto`'s encoder is a plain `deriveEncoder` today; keep it that way.

**Frontend**

| File | What changes |
|---|---|
| `frontend/src/types/contract.ts` | `export interface CanvasSettings { width: number; height: number; fpsCap: number \| null }`. `RouteConfig.canvas` is **required**; `RouteWriteRequest.canvas` is optional. Note the `\| null`, which is the documented exception to "optional fields are omitted, never null". |
| `frontend/src/pages/RouteEditorPage.tsx` | Three inputs, the defaults for a new route, and the label stating what `fpsCap` does and does not do yet. |
| `frontend/src/pages/RendererPage.tsx` | Fixed-size host plus the scale transform (§8, steps 5–6). |
| `frontend/src/components/EffectStage.tsx` | Accepts the canvas size instead of measuring the viewport; passes `fpsCap` into `EffectContext`. |
| `frontend/src/effects/sdk.ts` and `frontend/src/effects/types.ts` | `EffectContext` gains `fpsCap: number \| null`. Additive — the six existing effect files need no edits. |
| `frontend/src/styles/app.css` | The `.renderer-host` rules become "fixed size, transformed", not `inset: 0`. |
| `docs/EFFECT_SDK.md` | The `EffectContext` listing, and one sentence in the lifecycle section saying `resize` now carries the canvas size. |

### 9.2 Adding authentication

**Backend:** `Config.scala` (four new variables and the refuse-to-start check), a new
`application/AuthService.scala` (verify, issue, look up, revoke, rate-limit), a new
`domain` value for a session token if one is wanted, `infrastructure/http/Endpoints.scala`
(`secureBase`, the three auth endpoints, the 401 output), `infrastructure/http/HttpApi.scala` (the
security logic and the three handlers), `infrastructure/http/Wire.scala` (`SessionInfoDto`,
`LoginRequestDto`, the `UNAUTHORIZED` and `TOO_MANY_ATTEMPTS` codes in `errorCode`),
`application/Errors.scala` (two new `AppError` cases), `infrastructure/http/ErrorMapping.scala`
(their status codes and `details`), `infrastructure/http/ServerSetup.scala` (the CORS change),
`Wiring.scala`, `Main.scala` (start-up refusal and banner), `build.mill` (the bcrypt dependency),
plus tests for the service.

**Frontend:** `src/api/client.ts` (`credentials: "include"`, `login`, `logout`, `getSession`, and
401 handling), `src/types/contract.ts` (`SessionInfo`, the two new error codes),
`src/pages/LoginPage.tsx` (new), `src/components/AdminShell.tsx` (the session gate and the sign-out
control), `src/index.tsx` (**move `publishManifest()` out of module scope** — see the warning in
§4), and the router table.

**Everything else:** `docker-compose.yml` and `.env.example` (the new variables, and the
`VITE_API_BASE` default), `README.md` (a "signing in" section and the changed first-run steps),
`docker/README.md`, `Makefile` if a hash-generating helper target is added.

### 9.3 Adding the event stream

**Backend:** a new `application/RouteEvents.scala` (the in-process listener registry),
`application/RouteService.scala` (publish on create, update, delete and import), `Endpoints.scala`
and `HttpApi.scala` (the streaming endpoint, using `serverSentEventsBody` — no new dependency),
`Wiring.scala`. No MongoDB change: nothing about a stream is persisted.

**Frontend:** `src/api/client.ts` (a function returning an `EventSource` for a slug, built from the
same `API_BASE`), `src/pages/RendererPage.tsx` (the stream, the watchdog, and the poll demoted to a
fallback). The admin's route list may subscribe too, but is not required to.

**Prose that becomes untrue the moment this lands**, and is part of the same change: the root
`README.md` says in three places that the page "notices the change on its own within a few seconds"
and that the renderer "polls instead of holding a socket open"; `docs/ROADMAP.md` gap **G5** is
closed by it. Both need editing, because a document nobody corrected is how the two disagreements in
gap G9 happened in the first place.

### 9.4 Adding presets, export and import

**Backend:** `domain/Models.scala` (`Preset`, `RawPreset`, and a `PresetId` in `Ids.scala` or the
reuse of `RouteId`'s shape), `domain/Validation.scala` (name rules, params reuse),
`application/Repositories.scala` (a `PresetRepository` port and a `NameTaken` case alongside
`SlugTaken` in `RepositoryFailure`), `application/PresetService.scala`,
`application/AdminService.scala` (export and import),
`infrastructure/mongo/MongoPresetRepository.scala` and its indexes in `MongoConnection.scala`,
`BsonCodecs.scala`, `Wire.scala`, `Endpoints.scala`, `HttpApi.scala`, `Wiring.scala`, plus tests
including an in-memory preset repository.

**Frontend:** `src/types/contract.ts` (`Preset`, `PresetWriteRequest`, the export envelope, the
import request and result), `src/api/client.ts` (six new functions), `src/pages/PresetsPage.tsx` and
`src/pages/BackupPage.tsx` (new), `src/pages/RouteEditorPage.tsx` ("apply preset" and "save as
preset", plus the `?from=` duplicate path), and the router table.

---

## 10. Phase 2 open questions

Everything below was decided by judgement rather than read off the roadmap. Each one is a real
decision the rest of the phase is built on, and each one is cheap to overrule *now* and expensive to
overrule after four agents have built against it. If you disagree with any of them, change this
document first.

1. **bcrypt, not argon2.** `at.favre.lib:bcrypt:0.10.2`, chosen for being pure Java against
   `de.mkammerer:argon2-jvm`'s native library. Overruling this changes one dependency line and one
   verification call.
2. **The server refuses to start without `ADMIN_PASSWORD_HASH`**, with `ADMIN_AUTH_DISABLED=true` as
   the explicit escape hatch. The alternative the roadmap offered — run unauthenticated with a loud
   warning — is rejected because nobody reads a container log.
3. **Sessions are in memory and last 7 days, with no sliding renewal.** A restart signs you out. A
   Mongo-backed session collection would survive restarts and cost an index, a cleanup story and a
   migration; a sliding window would mean writing on every request.
4. **`SameSite=Lax`, and `Secure` off by default.** Justified above for plain-HTTP localhost. If
   this project is ever put behind HTTPS by default, flip the default with it.
5. **A login lockout of 5 consecutive failures for 60 seconds, counted process-wide.** Not in the
   roadmap. It is roughly fifteen lines and it turns an unattended online password guess into a
   pointless exercise; if you would rather not have the extra state, delete the `TOO_MANY_ATTEMPTS`
   row from §3 as well.
6. **`VITE_API_BASE` now defaults to same-origin `/api`.** This is the largest change to an existing
   default in the phase, and it exists so the session cookie needs no credentialed CORS.
7. **SSE numbers: `retry: 3000`, a 20-second heartbeat, a 45-second client watchdog.** All three are
   judgement. They should be re-examined together if anyone puts this behind a proxy with an
   aggressive idle timeout.
8. **A missing slug gets `200` plus an `absent` event, not `404`.** This is the one SSE decision
   that would be genuinely disruptive to change later, because the client's state machine is built
   around "the stream is always there".
9. **Duplicate is client-side.** No endpoint.
10. **Preset names are unique per effect, case-insensitively, and there is no "apply" endpoint.**
    The uniqueness rule is what forces the collation on the index; dropping it removes that
    subtlety at the cost of two presets called "Neon".
11. **Import requires an explicit `mode`, and is validated all-or-nothing but is not
    transactional.** The honest limitation is written into §4 rather than hidden.
12. **Presets are included in export.** They are configuration the operator typed, and losing them
    with the Mongo volume is the thing export exists to prevent.
13. **`fpsCap` is stored and validated in Phase 2 but only enforced in 3.1.** This is the decision
    that sits closest to the roadmap's own rule about flags that do nothing. It is taken because
    adding the field later means touching both codecs, both models and both forms a second time, and
    it is made safe by requiring the admin UI to label the control with its current limitation. The
    alternative is to ship `canvas` with `width` and `height` only, and add `fpsCap` in 3.1.
14. **`canvas` is the render resolution, with a CSS downscale**, rather than a hint the effect may
    ignore. This is what makes the setting worth having, and it is why `resize` now receives the
    canvas size.
15. **Canvas defaults are applied on read, with no migration script**, and a partial `canvas` object
    is accepted on write. Both are conveniences that a stricter reading of "PUT replaces everything"
    would refuse.
16. **`GET /api/effects` is protected.** Nothing public needs it today. If a future public page
    does, it moves to the list in §4 with a reason.
17. **Unresolved: there is no size limit on the import body.** Netty's maximum content length is
    whatever Tapir defaults to, and a deliberate cap (with a `413` and a new error code) is left out
    of this phase. Worth adding the day anything other than the admin UI can reach that endpoint.
