# Implementation roadmap

This document picks up where the bootstrap left off. It lists what exists today, what is missing
compared to the original goal, and the order in which to build the rest.

Everything here assumes the workflow from the bootstrap: no Node, pnpm, Mill or JDK on the host
machine — every command runs through `docker compose`.

**Status: Phase 1, Phase 2 and Phase 3.1 are complete as of 2026-08-24, and Phase 3.3 is complete
apart from two items.** Section 1 below describes the project after that work. Each phase's section
records what its items actually delivered, including the parts that came out differently from how
they were planned. Phase 3.2 — authoring the inventory — has not started, and is now the next thing
to do.

---

## 1. Where the project stands today

Working and verified by actually running it:

- **Backend** — Scala 3.8.4, Mill 1.1.8, `tapir-netty-server-sync` on Java 21 virtual threads,
  MongoDB via the synchronous driver, macwire wiring, 220 MUnit tests across 12 suites passing.
  Layered domain / application / infrastructure, with the domain free of any Tapir or Mongo imports.
  scalafmt and scalafix both run and both pass (`make backend-lint`).
- **Frontend** — Vite 8 + TypeScript 6 + **SolidJS 2** admin UI (login page, route list, route
  editor with a parameter form generated from each effect's `ParamSpec[]`, live preview, presets,
  export/import, inventory page) and the OBS delivery page at `/e/:slug`. ESLint and Prettier both
  run and both pass (`make frontend-lint`, `make frontend-format-check`).
- **The core mechanism you asked for** — a route maps a slug such as `main-camera` to an effect id
  plus parameter values, a per-route canvas size and an optional FPS cap. OBS points at
  `http://localhost:3000/e/main-camera` once; the page holds a Server-Sent Events stream open and is
  pushed the new configuration the moment you save it — measured at 50 ms from save to redraw. The
  old five-second poll is still there as an automatic fallback for when the stream drops.
- **An administrator login** — the admin is no longer open to anyone who can reach the port. One
  operator, one password checked against a bcrypt hash you supply in `ADMIN_PASSWORD_HASH`, a
  HttpOnly session cookie, and every write endpoint behind it. The two endpoints an OBS browser
  source needs stay public, because a browser source cannot log in.
- **Audio comes from OBS** — audio-reactive effects follow the audio OBS is broadcasting, not a
  browser microphone. The backend keeps one `obs-websocket` connection open, configured and stored
  through the admin panel under Settings, and republishes the levels to every browser source over
  Server-Sent Events. See 3.4 for why the backend makes that connection rather than the page, and
  for the one real limitation: OBS reports loudness, not a spectrum.
- **Forty-seven effects** — the six originals plus forty-one ported from the previous
  `obs-effects` repository (see 3.5): every razer-named page it had, every glitch and
  data-corruption page, and most of a hand-picked list beyond those. The original six are:
  Three.js: `starfield-warp`, `plasma-shader`, `camera-frame-ring`.
  Pixi v8: `particle-drift`, `digital-rain`, `audio-bars`. All six were rewritten onto the SDK in
  3.1 and all six still paint, hot-swap parameters and dispose cleanly in headless Chromium.
- **An effect SDK** (`frontend/src/effects/sdk/`, Phase 3.1) — a `Scope` that owns teardown so no
  effect writes a `dispose` method, one page-wide frame clock that finally honours the per-route FPS
  cap, three.js and Pixi stage helpers, refcounted shared microphone and webcam inputs, a GLSL chunk
  library, a palette catalogue, and a `rebuild: true` parameter flag. Authored against
  `docs/EFFECT_SDK.md` (the reference) and `docs/AUTHORING_EFFECTS.md` (the tutorial).
- **A runtime verification harness** (`frontend/tools/verify/`, `pnpm verify`) — a real Chromium
  driving the real application against a stub backend: every effect paints measured pixels, twenty
  mount/dispose cycles leave live WebGL contexts flat, dispose runs exactly once per cycle, a
  parameter change does not remount, and each effect holds a frame-time budget at 1920×1080. It is
  the only check in this project that can see the defects a lifecycle refactor produces; `tsc`,
  ESLint and the production build cannot, which is why 3.1 was not attempted without it.
- **An effect scaffold generator** — `pnpm new:effect <id> "<Name>" <three|pixi>` (or
  `make new-effect`) writes a complete, running, parameterised effect and registers it.
- **Docker** — `docker-compose.yml` with mongo, backend, frontend and an optional mongo-express,
  plus a `Makefile` of one-line targets.
- **Continuous integration** — `.github/workflows/ci.yml` runs the backend gate, the frontend gate
  and a Compose validity check on every push, and `make ci-backend` / `ci-frontend` / `ci-compose`
  reproduce all three locally through Docker.

Known to be missing, and stated here rather than buried: there is **no frontend test suite and no
backend integration test against a real MongoDB**. The backend unit suites are real and green, but
everything that crosses a process boundary — the Mongo repository layer, the browser — was verified
by hand. See gap G6 and item 4.1. One behavioural defect is also still open and is written up under
2.2: an import that fails part-way through changes the database without telling the live delivery
pages about it.

## 2. Gaps between the brief and the code

The status column is what changed in Phase 1. A gap is only marked **closed** when the thing it
described is actually finished, not when work on it started.

| # | Gap | Status | Why it matters |
|---|-----|--------|----------------|
| **G1** | `package.json` pinned `solid-js@^1.9.15`, but the brief asked for **SolidJS 2** | **closed** (1.1) — on `solid-js@2.0.0-rc.1`; see the caveat in 1.1 about the router | Solid 2 is a different reactive core (explicit ownership, two-function effects, batched writes). Migrating later, once dozens of effects and admin screens exist, costs far more than migrating now. |
| **G2** | Library versions lagged the old repo | **closed** (1.2) — `three@0.185.1`, `pixi.js@8.20.0`, `vite@8.2.2`, `typescript@6.0.3`, Node 24 | New effects should be written against current APIs, not ones a year old. |
| **G3** | Six effects, which is a proof of concept rather than an inventory | **partly closed** (2.3, 3.1, 3.3) — the usability half shipped in 2.3; the *machinery* for growing the inventory shipped in 3.1 (the SDK) and 3.3 (scaffold generator, verification harness, authoring guide). The inventory itself is still six effects: 3.2 has not started, so the gap stays open | The inventory *is* the product. We grow it by authoring new effects on our own SDK — see the direction note in Phase 3 — not by porting the old repo. |
| **G4** | No authentication on the admin | **closed** (2.1) — bcrypt password, HttpOnly session cookie, all 14 admin endpoints behind it, the two OBS-facing endpoints deliberately left public; see the caveat in 2.1 about the cookie's `Secure` default | Anyone who can reach port 3000 can rewrite what your live stream displays. |
| **G5** | Delivery page polls every 5 s | **closed** (2.2) — Server-Sent Events push, measured at 50 ms from save to redraw; the poll survives only as a fallback that switches itself off while the stream is delivering | Up to a five-second lag between saving and seeing it on stream, and a needless request every five seconds per browser source, forever. |
| **G6** | No integration tests against a real Mongo, no frontend tests, no CI | **partly closed** (1.4) — CI exists and runs every check the project has. The tests those checks would run still do not exist: zero frontend tests, and no backend test that touches a real MongoDB | The Mongo repository layer — the part most likely to break on a driver upgrade — is still covered only by hand-run curl commands. Phase 1 found four real defects by hand that no automated check would have caught (see 1.1 and 1.5); the next few will be found the same way, or on air. |
| **G7** | No production deployment path | open — Phase 4.2 | Compose runs the Vite dev server. There is no built, static, cache-headered production image. |
| **G8** | No lint/format enforcement | **closed** (1.3) — scalafmt + scalafix on the backend, ESLint + Prettier on the frontend, all four wired to `make` targets and to CI | Both linters pass on the existing code with exactly one rule disabled, for a reason written down in `frontend/eslint.config.mjs`. |
| **G9** | `docs/CONTRACT.md` and the code disagree in two small places | **closed** (2.4) — the charset disagreement was settled in the code's favour and the document corrected; the CORS one was settled in the document's favour and the server corrected. Three smaller documentation inaccuracies were found while checking and are listed as a caveat under 2.4 | The contract says every response is `application/json; charset=utf-8` and that the CORS preflight allows `Content-Type`; the server sends `application/json` with no charset and `Access-Control-Allow-Headers: *`. Nothing breaks today — JSON is UTF-8 by specification and `*` is a superset — but the document is meant to be the source of truth, so one side or the other should be corrected. |

---

## Phase 1 — Correct the foundations ✅ *complete, 2026-08-24*

The reason for doing this first: everything written afterwards would have had to be migrated if it
had been written against the wrong base.

All four planned items landed, plus a fifth section recording fixes that were not planned. Each item
keeps its original plan, followed by a **Delivered** note saying what was actually built — and,
where the two differ, why.

### 1.1 Migrate to SolidJS 2 ✅ *(closes G1)*
- Move `solid-js` and `@solidjs/router` to their 2.x lines, and `vite-plugin-solid` to the matching
  major.
- Rework data loading in `src/pages/*.tsx` away from the `createResource` pattern, and audit every
  `createEffect` for the ownership rules Solid 2 tightened.
- The renderer page (`src/pages/RendererPage.tsx`) is the risky one: it drives imperative
  WebGL lifecycles (`mount` / `setParams` / `dispose`) from reactive state. Verify that an effect
  swap still disposes the old one exactly once.
- **Done when:** `pnpm typecheck && pnpm build` are green in Docker and all six effects mount,
  hot-swap parameters, and dispose cleanly in a browser.

**Delivered.** `solid-js` and `@solidjs/web` at `2.0.0-rc.1`, `@solidjs/router` at `2.0.0-next.17`,
`@solidjs/vite-plugin` at `3.0.0-next.32` (the package formerly called `vite-plugin-solid`, renamed
upstream). Typecheck and build are green; all six effects were confirmed drawing, hot-swapping and
disposing in headless Chromium, and a 20-cycle mount/dispose loop showed live WebGL contexts flat at
two with no leak.

Four things are worth recording because they are not what the item above assumed:

1. **This item's original wording was wrong and would have sent someone down a dead end.** It said
   to rework data loading onto Solid 2's `createAsync` + `Suspense`. Neither name exists in the
   shipped release: `createAsync` was a Solid-1-era router primitive, and `Suspense` was renamed to
   `Loading` (`ErrorBoundary` likewise became `Errored`). The code uses an async `createMemo` read
   inside a `<Loading>` boundary, which is what the RC actually offers. The wording above has been
   corrected so nobody reopens a gap that does not exist.
2. **The router rewrite was a rewrite, not a version bump.** `<Router>`, `<Route>`, `<A>` and
   `<Navigate>` were all deleted upstream and replaced by a `createRouter({ routes: [...] })`
   config object plus plain `<a href>` anchors that the router claims by click delegation. Active
   nav highlighting moved out of JavaScript and into CSS on `aria-current="page"`.
3. **One defect was found only by running it**, and both the typecheck and the production build were
   green on it: during an effect swap, `setParams` reached the *outgoing* instance carrying the
   *incoming* effect's parameters. The cause was an assumption that the apply halves of two effects
   run in creation order — in `2.0.0-rc.1` they do not. Fixed with an identity guard, and
   `EffectStage.tsx` now warns against that assumption in a comment.
4. **A second defect was visible only in the development build**, which is the build `make up`
   serves: two `[STRICT_READ_UNTRACKED]` warnings on every effect mount. Fixed by wrapping the two
   deliberately untracked reads in `untrack`, which is the library's own mechanism for saying "this
   read is on purpose".

> **Caveat, 2026-08-24 — the router is a prerelease and it serves the live path.**
> `solid-js` is a Release Candidate with a frozen API. `@solidjs/router@2.0.0-next.17` is a step
> behind that, still on the `next` channel, and it is the only router release compatible with
> Solid 2 — the stable 1.0.0 requires Solid 1. It resolves `/e/:slug`, the page a live broadcast
> points at. Its API can still change before 2.0 final.
>
> **What would clear this:** `@solidjs/router` reaching 2.0.0 final, or at least RC parity with the
> core. When it does, re-pin it, re-run `make ci-frontend`, and re-check the four router behaviours
> the migration relies on: client-side navigation in both directions, `aria-current` landing on the
> right nav link, the wildcard 404 route, and `useParams` on the renderer page.
>
> Until then, treat any `@solidjs/router` upgrade as a change that needs the delivery page tested in
> a real browser, not merely a green typecheck.

### 1.2 Bring dependencies up to date ✅ *(closes G2)*
- `three` → latest (plus matching `@types/three`), `pixi.js` → latest 8.x, `vite` → 8.x,
  `typescript` → 6.x, Node base image → the current LTS.
- Three.js renames things between minor versions; expect small edits in the three effects.
- **Done when:** clean install, typecheck and build pass, and the six effects still render.

**Delivered.** `three@0.185.1` + `@types/three@0.185.4`, `pixi.js@8.20.0`, `vite@8.2.2`,
`typescript@6.0.3`, `@types/node@24.13.0`, and the frontend base image moved from `node:22` to
`node:24-bookworm-slim` (the current LTS). Vite 8 was not optional: `@solidjs/vite-plugin@3`
peer-requires it, so 1.2 was a prerequisite of 1.1 rather than a parallel task.

Two notes:

- **The three effect files needed no edits at all.** Every release from r172 to r185 was read
  against what the files actually use; the only WebGL-affecting changes in that range touch
  blending modes, shadow maps, PBR energy conservation and background rotation, none of which
  these effects use. Same for pixi 8.6 → 8.20, which is purely additive over our surface. Nothing
  in `src/effects/` was modified in the whole of Phase 1. Do not let anyone "modernise" those files
  as part of a future bump either — the evidence is that they do not need it.
- **TypeScript 7 was deliberately not taken**, even though it is published and is npm's `latest`.
  `typescript-eslint@8.67.0` declares `peerDependencies.typescript: ">=4.8.4 <6.1.0"`, so taking
  TS 7 would put the linter outside its supported range on day one and contradict 1.3's "no rule
  disabled to get there". Revisit when `typescript-eslint` widens that range. Related: `baseUrl` in
  `tsconfig.json` is a hard error in TS 6 and was removed; `paths` resolves relative to the
  tsconfig without it. TS 7 removes what TS 6 merely deprecates, so expect more of this.

### 1.3 Wire up lint and format ✅ *(closes G8)*
- Frontend: ESLint (flat config) + `eslint-plugin-solid` + Prettier, with `pnpm lint` / `pnpm
  format` scripts and a `make frontend-lint` target.
- Backend: a scalafmt check task and a scalafix task, plus `make backend-lint`.
- **Done when:** both linters pass on the existing code with no rule disabled to get there.

**Delivered.** Frontend: `eslint.config.mjs` (flat config, `recommendedTypeChecked` +
`eslint-plugin-solid`'s v2 preset + `eslint-config-prettier` last), `prettier.config.mjs`,
`.prettierignore`, and the scripts `lint`, `lint:fix`, `format`, `format:check`. Backend:
`mill lint` (scalafmt check + scalafix check over `src/` and `test/src/`), plus `checkFormatAll`,
`reformatAll` and `fixAll`. Makefile targets: `frontend-lint`, `frontend-format`,
`frontend-format-check`, `backend-lint`, `backend-format`.

Seventeen frontend violations were reported and all seventeen were fixed rather than silenced.
Three of them were a latent bug rather than style: `SomeUnion | string`, which TypeScript collapses
to plain `string`, silently discarding the literals the author meant to keep.

Two honest deviations:

- **One ESLint rule is switched off: `solid/imports`.** It is factually wrong for this codebase —
  its internal table says the `JSX` type lives in `solid-js`, but in Solid 2 it moved to
  `@solidjs/web`, and the rule is autofixable, so `lint:fix` would have rewritten eleven imports
  into a package that does not export the name and broken the typecheck. The rule declares an empty
  schema, so the single wrong entry cannot be corrected in config. Nothing is lost: `tsc` reports a
  wrong import source anyway. The reasoning is written out in full in `frontend/eslint.config.mjs`.
  Re-enable it when upstream fixes the table.
- **`.scalafix.conf` contained a setting that had never done anything.** It said
  `DisableSyntax.noVar`; the real option is `noVars`, and scalafix silently ignores keys it does not
  recognise. It looked switched on and was not. Corrected, and proved live by flipping it on and
  watching it flag both `var`s. This is the argument for 1.3 in one line: a lint config nothing runs
  is not a lint config.

Also deviating from the original wording: it named `mill obseffects.checkFormat`. There is no
`obseffects` module — `build.mill` defines a single root module — so the task names are unprefixed.

### 1.4 Continuous integration ✅ *(part of G6)*
- A GitHub Actions workflow running, on every push: backend compile + test, frontend install +
  lint + typecheck + build, and `docker compose config`.
- **Done when:** a deliberately broken commit fails CI.

**Delivered.** `.github/workflows/ci.yml` — three jobs with no `needs:` between them, so they run in
parallel and the run is red if any is red:

| Job | Steps |
|---|---|
| `backend` | JDK 21, cached Coursier/Mill downloads, then `compile`, `checkFormatAll`, `lint`, `test` |
| `frontend` | Node 24, Corepack, cached pnpm store, then `install --frozen-lockfile`, `lint`, `format:check`, `typecheck`, `build` |
| `compose` | `docker compose config --quiet` |

`make ci-backend`, `make ci-frontend` and `make ci-compose` reproduce all three locally through
Docker, so a red build can be understood without pushing a commit and waiting.

> **The one part that is not finished, 2026-08-24.** This item's "done when" is *a deliberately
> broken commit fails CI*, and that cannot be demonstrated here: the repository has no commits and
> no remote, so the workflow has never actually run on GitHub. What was done instead: the file was
> validated with `actionlint` and against GitHub's own workflow schema (both clean, both checked
> against a deliberately broken control file to prove they were really inspecting it), every command
> in it was executed by hand in a matching container, and the gate was shown to gate — a
> deliberately misformatted file makes `make ci-frontend` exit non-zero at the Prettier step and
> never reach the build.
>
> **What would clear this:** push the repository, watch the first run go green, then push a commit
> that breaks one check on purpose and confirm the run goes red. Also replace `OWNER/REPOSITORY` in
> the badge URL at the top of the root `README.md` with the real path, and uncomment it.

### 1.5 Fixes made along the way, not planned in advance

Recorded because they change behaviour and someone will otherwise wonder where they came from.

- **`GET /api/health` returned an empty `503` instead of the contracted `500`** whenever MongoDB was
  unreachable. The MongoDB driver's default server-selection timeout is 30 seconds and
  `tapir-netty` abandons a request after 20, so Netty cut the connection before the health check
  could answer. `MongoConnection` now lowers the server-selection timeout to 3 seconds by default —
  and leaves an operator's own `serverSelectionTimeoutMS` in `MONGO_URI` alone if one is set. The
  documented start-up retry loop now also behaves as its comment describes, at about 3 seconds per
  attempt rather than 30. This was found by stopping MongoDB and looking, not by a test.
- **The one-off Mill commands could not run while the stack was up.** Mill permits one build at a
  time per output directory, and the backend service's own `mill run` holds that lock, so
  `make backend-test` — a command three README files told you to run — printed `Another Mill
  process ... is running 'run', waiting for it to be done` and waited forever. Those commands now
  use a throwaway container pointed at a second output volume (`backend-tasks`), so they work
  whether the stack is up or down and still recompile only what changed.
- **A documented command silently ran nothing.** The root README suggested
  `mill test obseffects.domain.ValidationSuite` for running one suite. That form hands the name to
  MUnit as a *test-name* filter rather than a suite selector, so every suite reports "ignored", zero
  tests run, and the command exits successfully. Replaced with `mill test.testOnly <SuiteClass>`,
  with the trap spelled out next to it.

---

## Phase 2 — Make the admin trustworthy ✅ *complete, 2026-08-24*

All four planned items landed. As in Phase 1, each item keeps its original plan, followed by a
**Delivered** note saying what was actually built — and, where the two differ, why. Two items carry
a caveat for something that is not finished.

**The gates, run at closeout.** All three passed, and all three really ran:

| Gate | Result |
|---|---|
| `make ci-backend` | **pass** — inside Docker: `compile` 55/55, `checkFormatAll` 13/13 (32 main + 14 test sources, scalafmt 3.11.5), `lint` 151/151 (scalafix, no violations), `test` 137/137 — 12 suites, 220 tests, 0 failed, 0 ignored |
| `make ci-frontend` | **pass** — inside Docker on `node:24-bookworm-slim`: `pnpm install --frozen-lockfile` (lockfile current, 204 packages), `lint` (`--max-warnings 0`, clean), `format:check`, `typecheck` (`tsc --noEmit`, clean), `build` (795 modules, 6.59 s). Only advisory output: Vite notes the main chunk is 939 kB (260 kB gzipped), over its 500 kB warning threshold. Nothing fails on that; it is worth remembering when 4.2 builds the production image |
| `make ci-compose` | **pass** — `docker compose config --quiet`, no output, no warnings |

No gate had to be skipped. What the gates do **not** cover is unchanged from Phase 1: there are
still no frontend tests and no backend test against a real MongoDB, so anything crossing a process
boundary was checked by hand. For 2.2 that hand-checking was unusually thorough and is described in
its Delivered note; for 2.1 it was reading the code rather than running it, and that is said plainly
below.

### 2.1 Authentication ✅ *(closes G4)*
- Single-operator model, since this is your own streaming rig: a bearer session cookie issued from
  a password checked against an argon2/bcrypt hash supplied via the `ADMIN_PASSWORD_HASH` env var.
  No user table, no registration, no OAuth — the complexity would not pay for itself.
- Protect the write endpoints (`POST`/`PUT`/`DELETE /api/routes`, `POST /api/effects/sync`).
  **Leave `GET /api/routes/by-slug/{slug}` unauthenticated** — the OBS browser source cannot log in,
  and it reads a slug you chose.
- In Tapir this is a `securityIn` on the endpoint descriptions plus a `ServerSecurityLogic`, so the
  split between public and protected endpoints stays visible in `Endpoints.scala`.
- Add a login page and a 401-triggered redirect to the frontend.

**Delivered.** Everything the plan asked for is present: a password checked against a bcrypt hash
from `ADMIN_PASSWORD_HASH`, a session cookie, `securityIn` plus server security logic so the
public/protected split is still readable in `Endpoints.scala`, `GET /api/routes/by-slug/{slug}` left
public, and a login page with a 401-triggered redirect on the frontend. All 14 admin endpoints —
including `admin/export` and `admin/import`, which did not exist when this item was written — go
through the same `requireOperator` check. The only two public endpoints beyond health and the three
authentication endpoints are the ones an OBS browser source needs: the by-slug read and its events
stream.

Five things were built that the plan does not mention, each because the plan's version would have
failed in a way that is hard to diagnose:

1. **The server refuses to start rather than failing at login time.** If neither
   `ADMIN_PASSWORD_HASH` nor the escape hatch below is set, `Main` prints why and exits with status
   1. The alternative — booting happily and returning a 500 the first time somebody tries to log in
   — hides a configuration mistake until the worst moment.
2. **There is a deliberate escape hatch, `ADMIN_AUTH_DISABLED`, and it is awkward on purpose.** It
   is honoured only when it is spelled exactly `true`, so a stray `1` or `yes` cannot switch
   authentication off by accident, and a boxed warning is printed at every boot while it is active.
   It exists so a local development stack does not need a password; the plan did not anticipate it,
   and it is recorded here because it is the one way to run this app with no login at all.
3. **The hash is validated at start-up, not at first use.** `ADMIN_PASSWORD_HASH` is parsed into a
   `PasswordHash` type that checks the bcrypt modular-crypt shape. A shell that ate the `$`
   characters out of the variable — a common and confusing failure — is caught in the first second
   of the process's life instead of looking like a wrong password forever.
4. **Repeated wrong passwords are throttled.** Five consecutive failures lock login for 60 seconds
   and the response carries a `Retry-After` header. During the lockout no hashing is attempted, so
   the lockout also protects the CPU.
5. **A `HashPassword` command-line helper**, because the alternative is telling the operator to find
   a bcrypt tool somewhere else, and an open-redirect guard on the login page's `?next=` parameter,
   so a crafted link cannot bounce a signed-in operator off to another site.

The security-relevant details, written down so a reviewer does not have to re-derive them: bcrypt
cost 12; the password character array is zeroed after use; session tokens are 32 bytes from
`SecureRandom`; token comparison uses `MessageDigest.isEqual`, which takes the same time whether the
first byte differs or the last, so it cannot be used to guess a token one byte at a time; expiry is
checked against the server-side session store on every request, so editing or replaying the cookie
past its lifetime does not work; and the cookie is `HttpOnly`, `SameSite=Lax`, `Path=/`, with a
`Max-Age` taken from the same value as the stored expiry so the two cannot drift apart. The token
never reaches JavaScript.

**Cross-site request forgery is not separately defended, and that is a decision rather than an
oversight.** CSRF is the attack where another website makes your browser send a request to this one
using your cookie. `SameSite=Lax` tells the browser not to attach the session cookie to a
cross-site `POST`, `PUT` or `DELETE`, which is exactly the shape such an attack needs, and the
default CORS mode refuses credentials outright. So there is nothing to close today. This assumption
dies the moment anyone sets `SameSite=None`; if that ever happens, a CSRF token becomes required.

> **What was not done, 2026-08-24: this item was audited by reading, not by running.** The three
> backend suites that cover it (`AuthSuite`, `SessionServiceSuite`, `ConfigSuite`) exist and are
> green in the `make ci-backend` gate above, but no one logged in through a browser as part of this
> closeout, so "the login page works end to end" is not claimed here.
>
> Three known limitations, none of them a hole in what the item asked for:
> - **The login lockout is global, not per-IP.** Five wrong guesses from anywhere lock login for
>   everyone for 60 seconds. For a single-operator rig that is the safe direction to fail, but it
>   does mean a stranger who can reach the port can keep you locked out.
> - **`SESSION_COOKIE_SECURE` defaults to `false`**, because the shipped stack is plain HTTP on
>   localhost and a `Secure` cookie would never be sent there. Anyone exposing this beyond localhost
>   must set it to `true`, or the session cookie will travel unencrypted.
> - **`/docs` is unauthenticated.** It publishes the API description, including the shape of the
>   admin endpoints. It reveals no data and no credentials, but it does hand a stranger a map.
>
> **What would clear this:** log in through a real browser once and confirm the redirect, the
> cookie and the logout; then decide each limitation deliberately — make the lockout per-IP or write
> down that global is intended, default `SESSION_COOKIE_SECURE` to `true` for anything but the
> local compose stack, and either put `/docs` behind the session or record that publishing it is
> intended.

### 2.2 Push updates instead of polling ✅ *(closes G5)*
- Add `GET /api/routes/by-slug/{slug}/events` as a Server-Sent Events stream that emits the new
  `RouteConfig` whenever it changes. SSE, not WebSockets: the traffic is one-directional, it
  survives proxies, and browsers reconnect on their own.
- Publish changes from `RouteService` on write through a small in-process listener registry — no
  message broker for a single-node admin tool.
- Keep the 5-second poll as an automatic fallback when the stream drops, so a proxy that buffers SSE
  degrades to today's behaviour instead of freezing.
- **Done when:** saving in the admin visibly changes the OBS source in well under a second.

**Delivered, and — unusually for this phase — verified by running it rather than by reading it.**
The done-when is met with room to spare: with a stream open, a `PUT` on a route delivered the new
configuration to the browser in **50 milliseconds**.

The shape is three layers, so that the part of the code that decides *what changed* never has to
know it is talking to HTTP. `application/RouteEvents.scala` defines the interface
(`RouteEventPublisher`) and the in-process implementation (`RouteEventBus`): a map from subscriber
to a small bounded queue, exactly the "small in-process listener registry" the plan asked for and no
message broker. `infrastructure/http/RouteEventStream.scala` turns one subscription into the stream
of events Tapir writes to the socket on a virtual thread. The endpoint is declared public on
purpose — an OBS browser source cannot log in — and carries `Cache-Control: no-cache` and
`X-Accel-Buffering: no` so an intervening nginx does not sit on the events.

Four decisions worth writing down:

- **A slow subscriber drops its oldest event, never blocks the writer.** Each subscriber gets a
  queue of eight. When it is full the oldest event is discarded to make room. That is the right end
  to drop from, because every configuration event supersedes the one before it: a browser source
  that stalls for eight saves and then recovers still ends up holding the current state, not a
  backlog of stale ones. A test publishes 500 events into a full queue in under a second to prove a
  writer is never held up.
- **Publishing happens in `RouteService` and `AdminService`, not in the HTTP layer**, so a future
  caller cannot forget to announce a change. Create, update, delete and import all publish; a rename
  publishes twice — "this slug no longer exists" on the old one, then the new configuration on the
  new one.
- **Presets deliberately publish nothing**, and this is not an oversight. There is no server-side
  "apply this preset to that route"; applying a preset is the admin UI copying values into the route
  form, which the operator then saves through the ordinary route endpoint — and that publishes like
  any other save.
- **A slug with no route answers `200` with an `absent` event, not `404`.** A browser's
  `EventSource` gives up permanently on an error status, so a 404 would leave an OBS source dead
  until somebody reloaded it from inside OBS. Answering 200 and saying "nothing here yet" means the
  source starts working by itself the moment the route is created. Deleting a route likewise sends
  `absent` and leaves the connection open, which was confirmed on the wire.

The fallback poll survives and arbitrates itself: any message at all — including the 20-second
heartbeat — switches the poll off, and an error or 45 seconds of total silence switches it back on
and schedules one reconnection attempt. "Healthy" deliberately means "something arrived recently",
not "the socket looks open", because a proxy that buffers the stream leaves the socket open while
delivering nothing. A poll response and a stream event arriving in the same instant cannot apply the
same configuration twice; the de-duplication is kept in a plain variable rather than reactive state,
because Solid 2 batches reactive writes to a later microtask and both sources would otherwise read
the pre-write value.

Checked live during this closeout, beyond the gate: 137/137 backend tests including 11 for the event
bus; the stream headers and the `absent`-on-unknown-slug behaviour by `curl`; rename and delete
event ordering; and a leak check — 25 simultaneous streams produced 25 forwarding threads in a JVM
thread dump, and killing the clients took that count back to 0, so nothing is left behind when a
browser source goes away.

> **One real defect is still open, 2026-08-24: a half-failed import changes the database silently.**
> `AdminService.write` publishes its events only after every write has succeeded. MongoDB is running
> standalone here, which means there are no multi-document transactions and nothing rolls back, so a
> failure part-way through leaves the database changed and no event sent. A live delivery page keeps
> drawing a route that was just deleted or overwritten — and because its stream is healthy, the
> five-second fallback poll is switched off, so nothing corrects it until some unrelated save
> happens.
>
> How reachable is it: not very. The whole file is validated before the first write, so a bad backup
> file is rejected without touching anything. What is left is a race — a second admin session
> writing at the same moment as an import — which on a single-operator rig is unlikely but not
> impossible.
>
> **What would clear this:** publish before returning the error, not after. Note that the obvious
> one-line fix is only half right: the "this slug is gone" events are computed by comparing the
> route list before and after, but the "here is the new configuration" events are computed from the
> per-record write outcomes, so hoisting both above the failure check would announce only the
> records that happened to succeed. The removals must be published from the before/after comparison
> **and** the records that did save republished, and only then the error returned. A test that makes
> one record fail and asserts both kinds of event still went out would lock the behaviour down.

> **A stale comment in the code, not a behaviour problem.** The class-level documentation at the top
> of `backend/src/obseffects/infrastructure/http/Endpoints.scala` still says there are "five" public
> endpoints and lists them; since 2.2 there are six, the extra one being the events stream itself.
> `docs/CONTRACT.md` already lists all six correctly, so only the comment is wrong.
>
> **What would clear this:** change "five" to "six" in that comment and add the events stream to the
> list. It is a documentation edit inside a source file, which is why it was not made as part of
> this closeout — this pass changed documentation only.

### 2.3 Admin features that the current UI lacks ✅ *(part of G3's usability story)*
- **Duplicate a route** — the fastest way to make "same effect, different colour" scenes.
- **Presets** — save a named parameter set for an effect and apply it to any route. New Mongo
  collection `presets`, new endpoints, reusing the existing `ParamSpec` validation.
- **Export / import** — download all routes as one JSON file and restore it. This is the backup
  story; right now a dropped Mongo volume loses every scene.
- **Decide what `enabled: false` means.** Today the contract says a disabled route still returns
  200 and renders. Either it should render nothing (a blank transparent page) or the flag should be
  removed. Leaving a flag that does nothing is worse than not having it.
- **Per-route canvas settings** — target resolution (default 1920×1080) and an FPS cap, since a
  background effect at 30 fps frees GPU headroom for the game being streamed.

**Delivered.** All five sub-items shipped. Taking them in the order above, with the decisions that
are not obvious from the plan:

- **Duplicate a route is deliberately client-side.** There is no `POST /api/routes/{id}/duplicate`.
  The "Duplicate" button is a link to the ordinary create form pre-filled from the source route,
  with a free slug suggested for you (`main-camera` becomes `main-camera-copy`, then `-copy-2`, and
  an existing `-copy` suffix is stripped rather than stacked). The reason is that a server-side
  duplicate endpoint would be a second way to create a route, with its own validation path to keep
  in step with the first; the copy is only a form pre-fill, so the ordinary create endpoint does all
  the work. `docs/CONTRACT.md` says the same thing, so the two agree.
- **Presets are full CRUD over a new `presets` collection**, with a uniqueness rule on
  (effect, name) that ignores letter case. So one effect cannot have both "Neon" and "neon", while
  two different effects may each have a "Default". The case-insensitivity is enforced by the
  database index itself, and the same collation is repeated on the lookup query so the query and the
  index agree — if they disagreed, a lookup could miss a row the index considers a duplicate.
  MongoDB's duplicate-key error is translated into a 409 rather than allowed to surface as a 500.
  There is deliberately no server-side "apply preset to route", for the reason given under 2.2.
- **Export / import round-trips faithfully, with two deliberate exceptions.** Record ids are always
  assigned by the server and never read from the file, so importing a backup into a different
  database cannot collide with ids already there. `updatedAt` is always the import time.
  `createdAt` is taken from the file for a record that is newly created, and a record that matched
  an existing one in merge mode keeps the `createdAt` already stored. **Import is not atomic and the
  code says so**: standalone MongoDB has no multi-document transactions, so a write cannot be rolled
  back. The mitigation chosen instead is that the entire file is validated before the first write,
  and re-running the same file changes nothing the second time. The residual risk is the caveat
  under 2.2.
- **`enabled: false` was decided, and the decision is written into `docs/CONTRACT.md`** rather than
  left in someone's head: the flag is a rendering rule, not an API rule. The API still returns 200
  and the full configuration. The delivery page draws a fully transparent page, and an
  already-running effect is **disposed rather than hidden** — freeing the GPU is the entire point of
  the toggle, and a hidden effect still costs frames. The admin preview ignores the flag, because
  you need to see what you are editing.
- **Per-route canvas settings** are bounded to 16–7680 by 16–4320 with an FPS cap that is either
  absent or 1–240, defaulting to 1920×1080 uncapped. Two details that took thought: canvas numbers
  are decoded as floating point so that `1920.5` produces a 422 that names the offending field,
  instead of a generic 400 from the JSON parser that tells the operator nothing; and `"fpsCap":
  null` is the one place in the whole API where an explicit `null` is meaningful, so the encoders
  for the affected objects deliberately do not strip nulls the way every other encoder does.
  Existing routes stored before the field existed load as the default and quietly acquire it on
  their next save — chosen over writing a one-shot migration script, which would be more code to
  review and to run than the problem deserves.

> **The FPS cap is stored and validated but nothing honours it yet, 2026-08-24.** The resolution
> half really works: the delivery page lays the effect out at exactly the canvas pixel size and
> scales it to the window with the aspect ratio preserved. The cap half is handed to each effect as
> part of its context, and no effect reads it, so a route capped at 30 fps still renders as fast as
> the browser will let it. This is deliberate rather than forgotten — enforcing a frame rate belongs
> in the shared frame-loop helper in 3.1, and implementing it six times now, once per effect, is
> work that 3.1 would immediately delete. It is recorded in `docs/CONTRACT.md` as decision 13.
>
> **What would clear this:** 3.1's frame-loop helper honouring the cap, with the six existing
> effects refactored onto it — at which point the setting starts doing what the admin form implies
> it already does.
>
> **Cleared, 2026-08-24, by 3.1.** `sdk/clock.ts` gives every subscriber its own cap and all six
> effects subscribe through it, so a route capped at 30 fps now draws at about 30 fps. The one thing
> still unproven is the *measurement*: no check reads the per-subscriber frame counts the clock
> publishes, so "about 30" is reasoned from the code rather than observed. See the first caveat
> under 3.1.

### 2.4 Make the contract and the code agree again ✅ *(closes G9, added 2026-08-24)*

Small, and worth doing while the endpoints are being touched for 2.1 anyway. Two places where
`docs/CONTRACT.md` and the running server disagree, both found by curling every endpoint during the
Phase 1 review:

- The contract says every response is `application/json; charset=utf-8`; the server sends
  `application/json` with no charset parameter.
- The contract says the CORS preflight allows `Content-Type`; the server answers
  `Access-Control-Allow-Headers: *`.

Neither breaks a client today. They matter because the contract is declared to be the source of
truth — "if code and this document disagree, the document wins" — and a document with two known
untruths in it stops being trusted for the rest. Decide which side is right in each case and change
the other.

**Delivered, and the two cases were decided in opposite directions.**

- **The charset: the code was right and the document was corrected.** The reason the server does not
  send `charset=utf-8` on JSON is not an omission — it is the HTTP library's rule that a charset
  parameter is attached only to `text/*` content types, and `application/json` is not one of those.
  That rule is correct: the JSON specification already requires UTF-8, so the parameter would be
  redundant. Trying to force it on would have meant fighting the library for no gain, so
  `docs/CONTRACT.md` now states what actually goes over the wire, and records that the server was
  right. The one endpoint that does carry a charset is the events stream from 2.2, which is
  `text/event-stream` and therefore genuinely text.
- **The CORS header: the document was right and the server was corrected.**
  `Access-Control-Allow-Headers` now names `Content-Type` literally instead of `*`. Naming the
  header rather than wildcarding it also matters for a second reason the original item did not
  mention: a browser ignores `*` entirely on a request that carries credentials, so the wildcard was
  a trap waiting for the day cross-origin credentials were switched on. While this was open, the two
  CORS modes were made internally consistent — a wildcard origin is paired with credentials refused,
  and an explicit origin list with credentials allowed — and built in such a way that the illegal
  combination of both fails at start-up rather than surfacing as an unexplained browser console
  error months later.

Beyond the two known cases, every path, method, status code, error body shape, header, environment
variable and authentication requirement in `docs/CONTRACT.md` was compared against the code
endpoint by endpoint. Everything documented exists, and nothing exists that is not documented.

> **Three small documentation inaccuracies found while checking, 2026-08-24.** None of them is
> wrong behaviour and none is in 2.4's original scope, but they are the same class of problem 2.4
> exists to prevent, so they are recorded rather than dropped:
> - **`docs/CONTRACT.md`'s status-code table has no row for 405.** Requesting an existing path with
>   the wrong HTTP method does return a properly shaped error body — the table simply does not list
>   that case.
> - **`docs/CONTRACT.md`'s import section overstates when `createdAt` comes from the file.** A
>   bullet says it is taken from the file whenever it parses; the bullet just above it, and the
>   code, both say that a record matched in merge mode keeps its stored `createdAt` instead. The
>   first bullet needs that exception added.
> - **The "five public endpoints" comment in `Endpoints.scala`** — the same stale comment recorded
>   under 2.2.
>
> **What would clear this:** add the 405 row, qualify the `createdAt` bullet, and fix the comment.
> All three are one- or two-line edits; the first two are in `docs/CONTRACT.md` and were left alone
> here only because this closeout was scoped to `docs/ROADMAP.md`, and the third is inside a source
> file, which this pass was not permitted to touch.

---

## Phase 3 — Build our own effect inventory *(closes G3)*

**Direction change (2026-08-24): we are not porting the old repo.** The ~254 effects in
`../obs-effects` are a reference and an idea bank, not a backlog. Mass-porting them would import
their constraints — hard-coded constants, no teardown, no parameters, no shared inputs — into a
platform designed around exactly the opposite. We author a smaller inventory of original effects,
built for this SDK from the first line, where every effect is parameterised, disposable, and worth
putting on a stream.

The measure of success is not effect count. It is: **every effect in the inventory is one you would
actually use on air.** Ten excellent effects beat two hundred mediocre ones, because the admin
dropdown is a thing a human reads.

The old repo stays useful in two ways: as a visual reference when we want a similar look, and as a
source of proven technique (its `obsAudio.ts` and `createThreeScene.ts` solved real problems). Copy
ideas and techniques freely; do not copy files wholesale.

### 3.1 Harden the effect SDK first ✅ *complete, 2026-08-24*

Everything below depends on this, so it comes first. The current SDK is `mount` / `resize` /
`setParams` / `dispose`. Before authoring effects in volume, add what they will all need — because
retrofitting a shared capability across twenty existing effects is far more work than designing it
in once:

- **Shared audio input.** `audio-bars` currently opens its own microphone. Several planned effects
  are audio-reactive, and they must share one `AudioContext` and one `AnalyserNode` provided by the
  SDK, or they will contend for the device. The SDK exposes a frequency/waveform buffer; effects
  never call `getUserMedia` themselves. Include the graceful fallback to a simulated signal, since
  an OBS browser source often has no microphone permission.

  > **Superseded, 2026-08-24, by 3.4 below — the source changed, the interface did not.** The shared
  > bus shipped as written and was then repointed from the browser's microphone to OBS's own audio.
  > The reasoning is in 3.4; the part worth noting *here* is that no effect file changed when it
  > happened. That is the clearest evidence the SDK abstraction was drawn in the right place: the
  > source of the audio was replaced wholesale and the effects did not notice.
- **Shared webcam input.** The same argument for camera-framing effects: one `MediaStream`, handed
  out as a texture.
- **A common Three.js scene helper** — renderer setup, transparent clear colour, camera, and the
  resize/render loop, so an effect file contains the interesting part and nothing else.
- **The equivalent Pixi v8 helper**, including the async-init handling that every Pixi effect
  currently repeats by hand.
- **A frame-loop helper** honouring the per-route FPS cap from 2.3, with delta-time passed to the
  effect so animation speed is independent of frame rate.
- **A parameter-change protocol for expensive parameters.** Some parameters (particle count, grid
  resolution) cannot change without rebuilding GPU buffers. Let a `ParamSpec` declare
  `rebuild: true` so the renderer remounts instead of calling `setParams`.
- **A shared GLSL utility library** — noise (simplex, fbm, curl), colour-space conversions, easing,
  signed-distance-field primitives. Most original effects are a shader plus a palette; a good
  utility library is what makes writing the next one an afternoon rather than a week.
- **A palette/theme concept.** Rather than every effect inventing five colour parameters, offer a
  reusable palette parameter kind so a route can be themed consistently across several effects.

Ship 3.1 as a single reviewed change, with the six existing effects refactored onto it. Those six
are the proof that the abstractions are the right ones — if refactoring them is awkward, the SDK is
wrong and it is cheap to fix now.

**Two things Phase 1 learned that constrain this work** (added 2026-08-24):

- **Do not start 3.1 without a regression net.** Phase 1 found two ownership/lifecycle defects in
  `EffectStage.tsx`, and *neither* was catchable by `tsc`, ESLint or the production build — one was
  a parameter routed to the wrong instance during a swap, the other showed up only in the
  development build. 3.1 refactors all six effects onto a new SDK, which is the same class of
  change. Pull the `EffectStage` mount/dispose assertion from 4.1 and the leak harness from 3.3
  forward so they sit *under* this work rather than after it. The shape that found the first bug is
  about sixty lines: fake effect modules whose `dispose` is deliberately unguarded, asserting that
  mounts equal disposes and that an outgoing instance is never handed another effect's parameters.
- **Ref callbacks are unowned in Solid 2.** `getOwner()` returns `null` inside one and `onCleanup`
  cannot be registered there. Any SDK helper that wants to clean up something attached through a
  ref has to do it in `onSettled` in the component body instead. This is easy to write, hard to
  notice, and silent when wrong.

**Delivered.** All eight capabilities exist, in `frontend/src/effects/sdk/`, and all six effects
were rewritten onto them in the same change. The lifecycle the renderer speaks — `mount` / `resize`
/ `setParams` / `dispose` — was deliberately **not** touched, because the harness proves "disposed
exactly once" against it; what changed is that no effect *implements* it any more.

| Capability | Where it lives | What it actually does |
|---|---|---|
| Shared audio | `sdk/audio.ts` + `sdk/lease.ts` | One `AudioContext`, one `AnalyserNode`, one microphone for the page, refcounted. `audio-bars` no longer calls `getUserMedia`. |
| Shared webcam | `sdk/video.ts` | One `MediaStream`, plus per-effect `THREE`/`PIXI` textures minted from it. |
| Three.js helper | `sdk/three.ts` | `createThreeStage` — renderer, transparent clear colour, capped pixel ratio, three camera shapes, `onResize`. |
| Pixi helper | `sdk/pixi.ts` | `createPixiStage` — the `await app.init()` race handled structurally, Pixi's own ticker switched off. |
| Frame loop | `sdk/clock.ts` | One `requestAnimationFrame` for the page, per-subscriber delta time and FPS cap, plus a watchdog that falls back to `setTimeout` rather than ever stopping. |
| Expensive parameters | `ParamSpec.rebuild` + `registry.rebuildKey` + `EffectStage` | A debounced dispose-and-remount path for parameters that cannot change in place. |
| GLSL library | `sdk/glsl/index.ts` | Named chunks (`hash`, `noise2`, `fbm`, …) assembled by `assembleFragment`, with dependency dedupe. |
| Palette | `sdk/palette.ts` | Seven named ramps sampled by position, exposed as an ordinary `select` parameter. |

Four things came out differently from the plan, and each is a deliberate answer to something the
plan did not know:

1. **The ownership primitive is not in the plan at all, and it is the part that matters.**
   `sdk/scope.ts` is what the other seven capabilities are built on: register a teardown next to the
   thing that needs it, and the scope runs every teardown once, in reverse construction order. It
   replaced six hand-written `dispose()` sequences and six `let disposed = false` flags. Idempotence
   is now a property of the scope rather than a discipline six files had to keep.
2. **The palette is not a new `ParamKind`, and `rebuild` costs the backend nothing.** A `"palette"`
   kind would have meant editing the kind enum, the validator, the HTTP DTOs, the BSON codecs and
   `docs/CONTRACT.md` — across two languages — to obtain a dropdown a `kind: "select"` already
   renders and validates. `rebuild?: boolean` is likewise frontend-only: `buildManifest()` strips it
   before `POST /api/effects/sync`, so the request stays byte-identical to `docs/CONTRACT.md`. **No
   Scala changed in this phase**, which is why `make ci-backend` was not run.
3. **The "ref callbacks are unowned" constraint became a lint rule.** Nothing under `src/effects/**`
   may import `onCleanup`, `getOwner`, `onSettled`, `createEffect` or `createSignal` from
   `solid-js`; `frontend/eslint.config.mjs` enforces it with a message explaining why. It is the one
   defect class in this refactor a linter genuinely catches.
4. **The plan's per-second delta-time conversion was mostly already done.** Five of the six effects
   already ran on measured delta time. The real behavioural change is that `ctx.fpsCap` — carried
   through every layer since Phase 2 and then ignored, because nothing enforced it — is honoured for
   the first time. The one visible change is in `audio-bars`, whose bar smoothing is now measured
   per second (`s ** (dt * 60)`) instead of per frame, so a capped route and an uncapped one settle
   at the same rate; at 60 fps the expression is exactly the old constant, so a saved route looks
   the way it looked.

No effect changed its descriptor id, its parameter keys, its defaults or its ranges, so every route
an operator has already saved keeps rendering what it rendered.

> **Caveat, 2026-08-24 — three of the eight capabilities have no consumer, and therefore no
> evidence.** `pnpm verify` passes 192 assertions on both the production and the development build,
> but a check can only exercise code something calls. Nothing in this build calls `useVideo`,
> `videoTextureThree`/`videoTexturePixi`, `paletteParam`, or six of the nine GLSL chunks, and
> `useAudio` has exactly one caller — so the shared-resource refcount is never observed with two
> holders, which is the case the whole `lease.ts` design exists for. `EffectStage`'s
> `rebuild: true` path has no consumer either, so its debounce has never run.
>
> Two specific unproven behaviours are worth naming rather than leaving to be rediscovered on air.
> First, the shared-lease refcount: `checkMountDisposeCycles` cycles only `starfield-warp` and
> `plasma-shader`, so the audio lease is acquired and released once in the whole suite and a
> refcount error would need repeated mounts to surface. Second, `rebuildToken` in `EffectStage.tsx`
> lags the module by one 150 ms debounce, so switching *away* from an effect whose rebuild key was
> non-empty looks capable of remounting the incoming effect a second time. Nothing can happen today
> — no effect declares the flag — but the first effect that does will meet it.
>
> `window.__sdkDebug` (`sdk/debug.ts`) was built to let the harness assert these things — an fps cap
> really capping, tracks really stopped, one analyser shared — and **no check reads it yet**. The
> `?slowInit=` hook in `sdk/pixi.ts`, which widens the dispose-during-`init` race so a test can
> drive through it, is likewise unused by any check.
>
> **What would clear this:** a development-only probe effect (or two) in the harness that (a)
> declares a `rebuild: true` parameter and asserts one remount per settled change and none on an
> effect switch, and (b) uses `useAudio`, so two audio effects can be mounted together and
> `window.__sdkDebug.shared()` asserted to show `refs: 2`, then `refs: 0` and the tracks stopped
> after both are disposed and the linger window has passed; plus one check that mounts a Pixi effect
> with `?slowInit=800` and disposes it mid-init, asserting the host `<div>` never holds two
> canvases; plus one that reads `window.__sdkDebug.subscribers()` on a route with `fpsCap: 15` and
> asserts roughly 15 frames a second rather than roughly 60.

> **Caveat, 2026-08-24 — local reasoning got worse, and that was the trade.** An effect file used to
> read end to end: the loop, the teardown and the ordering were all in front of you. The ordering
> guarantee now lives in `sdk/scope.ts` (last-in, first-out) and the `forceContextLoss()` call the
> harness counts lives in `sdk/three.ts`, two files away from the effect that depends on it. Six
> copies of a lifecycle becoming one is worth that, but it is a cost, not a free win, and it is why
> both SDK files carry long headers explaining themselves.
>
> One rough edge the six refactors found and the SDK did not fix: `scope.ownDisposable` is the wrong
> tool for a resource that is *replaced* during the effect's life. `starfield-warp` rebuilds its
> geometry when the star count changes and `camera-frame-ring` rebuilds its two tori on resize;
> owning each new one would register an unbounded list of teardowns for buffers that are already
> gone. Both use `scope.defer(() => current.dispose())` — a late-bound read of a mutable variable —
> and both wrote a paragraph explaining it. Nothing in the API's shape warns you, and getting it
> wrong leaks silently.
>
> **What would clear this:** a replaceable slot on `Scope` —
> `const slot = scope.slot<THREE.BufferGeometry>((g) => g.dispose())`, where `slot.set(next)`
> disposes the previous one — which is one registration, no mutable-variable trick, and would be
> used by two of the six effects on the day it lands.

### 3.4 Audio comes from OBS, not the browser ✅ *complete, 2026-08-24, unplanned*

Not in the original plan. It replaces the microphone half of 3.1, and it was raised because the
premise 3.1 was built on was wrong in practice.

**The problem with what 3.1 shipped.** The shared audio bus worked exactly as designed, and what it
was sharing was the wrong signal:

- An OBS browser source normally has no microphone permission, and `getUserMedia` needs a secure
  context even to be offered. On the machine this project exists for, the real path almost never
  ran — every audio-reactive overlay was showing the simulated fallback. Phase 3's own verification
  had to grant a *fake* microphone to exercise it.
- Even where permission existed, a microphone hears the room. An overlay should follow what the
  audience hears: the game, the music bed, the microphone after the noise gate and the compressor.
  OBS already has that signal.

**Delivered.** The backend holds one WebSocket connection to OBS's `obs-websocket` server and
republishes what it hears; the SDK's audio bus reads that stream. The connection is configured in
the admin panel and stored in MongoDB.

| Piece | Where |
|---|---|
| Settings model, validation, live status | `backend/src/obseffects/domain/ObsAudio.scala` |
| Protocol client — handshake, SHA-256 auth, meter parsing | `backend/src/obseffects/infrastructure/obs/ObsWebSocketClient.scala` |
| One connection kept alive, with backoff | `backend/src/obseffects/infrastructure/obs/ObsAudioSupervisor.scala` |
| Newest-wins fan-out to browser sources | `backend/src/obseffects/application/AudioLevelBus.scala` |
| `GET /api/audio/levels/events` (public), `GET`/`PUT /api/settings/obs-audio` (protected) | `Endpoints.scala`, `AudioLevelStream.scala` |
| The `settings` collection, one document | `MongoSettingsRepository.scala` |
| Admin form, connection badge and live meter | `frontend/src/pages/SettingsPage.tsx` |
| The audio bus, repointed | `frontend/src/effects/sdk/audio.ts` |

Four decisions are worth recording, because each had a losing alternative that looks reasonable.

1. **The backend is the WebSocket client, not the browser.** The browser is the obvious choice — the
   renderer page is already running inside OBS. It was rejected over the **password**: `/e/:slug` is
   deliberately unauthenticated, because an OBS browser source cannot sign in, so a page-side client
   would need the obs-websocket password served from a public endpoint to anyone who asked. Putting
   the client in the backend keeps the credential on the server, uses one connection no matter how
   many browser sources exist, and is what lets the admin show a connection status at all. The cost
   is one extra network hop on a local machine, against meter messages that arrive every 50 ms.
2. **No new dependency.** Java 21 has a WebSocket client in its standard library, and the handshake
   is two messages and one hash. A library would have been one more network-facing thing to keep
   patched.
3. **The bus keeps only the newest value per subscriber**, unlike the route event bus, which queues.
   For levels a queue is actively wrong: a browser source that stalls and recovers would replay a
   backlog and pulse to music that finished half a second ago, which looks worse than missing a
   beat. Nothing can grow, so a stalled source costs one reference.
4. **Settings live in MongoDB, not in environment variables.** The whole requirement is that an
   operator who mistypes a password fixes it in a form, not by editing `.env` and restarting the
   server mid-broadcast.

**The honest limitation, and it is a real one.** obs-websocket reports **loudness, not a spectrum** —
one peak per channel per input, about twenty times a second, with no Fast Fourier Transform anywhere
in the protocol. So `bus.level`, `bus.peak` and `bus.inputs` are measured, and `bus.frequency`,
`bus.waveform` and `bands()` are *derived*: one real loudness value spread across the bins with a
fixed tilt and a slow wobble. A spectrum display still moves with the music and its overall energy is
real, but which bin is loudest is not a measurement, and the SDK says so in the file and in
`docs/EFFECT_SDK.md` rather than quietly implying otherwise.

That is a deal, not an oversight: real program audio on every machine with no permission prompt, in
exchange for per-frequency detail that the overlays this platform draws — pulses, rings, bars, glows
— were not really using.

**A behaviour change worth knowing about.** OBS connected and silent now means an audio effect draws
*silence*, where before an absent microphone meant a simulated signal. That is correct — a meter at
rest is a meter at rest — but it means `audio-bars` with everything muted paints nothing at all. The
simulated fallback now means only "we do not know what the audio is": no connection configured, OBS
closed, or a dropped stream.

**How it is tested.** 37 new backend tests across four suites cover the settings rules (most of them
on the three-state password, because "editing the URL silently wiped my password" is the worst and
quietest failure available here), the fan-out's newest-wins behaviour, the level arithmetic, and the
protocol maths — `ObsWebSocketClientSuite` pins the authentication scheme against a value computed by
a separate implementation rather than by running the code, so a swapped hash order cannot move both
sides together.

The browser half is covered by two new checks in `frontend/tools/verify/checks/audio.mjs`, and they
exist because **every other check in that harness passes with this feature completely broken**. The
failure mode here is not a blank screen, it is a *plausible* one: a bus stuck on its simulated
fallback paints a full, lively spectrum whether or not a single real level ever arrives. So the new
checks never ask "did it draw" — they change what the server is sending and assert the pixels follow.
Measured on a real Chromium: 360,840 painted pixels with the stream reporting loud audio against
**zero** with it reporting silence, then 453,467 when the audio returns.

Finding those two checks also turned up a flaw in the harness worth recording, because it is the kind
that produces a failure nowhere near its cause: audio subscribers were briefly kept in the same
registry as route-stream subscribers, so `openStreams()` counted them and a check asserting "exactly
one browser source is listening to this slug" waited forever for a number that was now two. Two
streams, two registries.

> **What is still not covered, 2026-08-24.** The obs-websocket connection itself. The stub speaks
> this project's *level stream*, which is our own contract; nothing stands up an obs-websocket
> server, so the handshake and the reconnect path have never been proved end to end by anything
> except a person with OBS open.
>
> **What would clear this:** a fake obs-websocket server in the verification harness — a WebSocket
> that sends one Hello and then canned meter events, perhaps eighty lines — driving a real connection
> through `ObsAudioSupervisor` and asserting that levels arrive at the SSE endpoint. The same fixture
> would cover the backoff, which is currently reasoned about rather than run.

### 3.5 Ported effects from the original repository ✅ *complete, 2026-08-24, unplanned*

Not in the plan, and it contradicts the direction note at the top of Phase 3 — which said we would
*not* port the old repository. That note is still right about mass-porting 254 pages. What was
actually asked for and done is a hand-picked set, reimplemented on the SDK rather than transplanted,
which is what the same note calls "copy ideas and techniques freely; do not copy files wholesale".

**Delivered: 41 effects, from 47 of the old repository's pages.** Every one keeps its original look;
every constant it hard-coded is now a `ParamSpec`.

The count is lower than the page count on purpose. Five of the old pages were `GlitchTerminalBase`
with a different config object, eight were one 1,400-line class with a `variant` string, six were one
diagonal-streaks class with a different palette, and two were the same ink shader with a different
page background. Reproducing that as one dropdown entry each would have put five near-identical
"terminal" rows in front of an operator, which the Phase 3 direction note explicitly argues against.
Instead each family is **one implementation whose config became the parameter set**, with thin
wrapper files where the looks are genuinely distinct enough to be worth naming:

| Family | Old pages | Here |
|---|---|---|
| Glitch terminals | 5 + `razer-bg-coding` | one `glitchTerminal.ts`, six wrappers |
| Razer waveforms | 8 | one `razerWaveform.ts`, eight wrappers |
| Shader quads | 7 | one `shaderQuad.ts` helper, seven shaders |
| Diagonal streaks | 6 colour variants | one effect, colours as parameters |
| Ink dissolve | 2 | one effect; Reactivity 0 is the other |
| Halftone fade | 2 | one effect; Dot Colour is the difference |

Beyond the razer family, the same treatment covered every glitch and data-corruption page
(`glitch-veil`, `data-corruption`, `glitch-ape`, `glitch-overlay`, `hologram-glitch`, plus the three
terminals above), and a hand-picked set from the rest: `star-field`, `cat-mesh`, `animated-lines`,
`starting-soon-fluid`, `logo` and `worxbend-3d-text`.

**What the SDK gained, because these needed it:**

- `sdk/envelopes.ts` — the old repository's `bass`/`mid`/`high` were never frequency bands, they were
  one loudness tracked at three attack/release speeds. That is now a shared helper with the fields
  named `slow`/`mid`/`fast`, so no effect author can mistake them for a spectrum.
- `sdk/text.ts` (`useFont`) — a font that loads late does not fail, it silently lays out a grid at the
  wrong pitch and then re-flows. On air that is worse than a blank beat.
- `three/shaderQuad.ts` — the boilerplate seven of these shaders each carried.
- Four GLSL chunks: `hash12`, `vnoise`, `fbmRot`, `fbmVnoise`. The old repository's hash is
  sine-free, and it produces *different noise* — reusing our existing `hash` would have quietly
  changed how every ported razer effect looks.
- Five bundled fonts, with `font-display: block` and the reasoning written into `styles/fonts.css`.

**Two mechanical conversions applied to every ported shader**, neither of which changes a picture:
Pixi `Filter` → the SDK's Three fullscreen quad, and GLSL ES 3.0 `in`/`out` → `varying` and
`gl_FragColor`.

**Deliberate omissions, each recorded in the file that made them:**

- `ink-dissolve-razer` dropped its pointer-following bloom (no cursor over an OBS source) and its
  `prefers-reduced-motion` freeze (that setting belongs to the machine running OBS and would silently
  freeze a live overlay; Speed 0 does it deliberately instead).
- `razer-status-line`'s clock counts the *effect's* uptime, not the stream's, and resets on every
  route save. It looks like a stream timer and is not one; the file and the preview notes both say so.

**The four largest pages are ported, three of them partially, and each says so in its own header.**
`worxbend-text` (509 lines) is complete. `ember-pentagram-overlay` (1,249), `procedural-logo` (1,600)
and `main-web-cam-border` (1,874) carry the subsystems that define them and omit named ones:

| Effect | Carried | Omitted, and why |
|---|---|---|
| `ember-pentagram-overlay` | The banded node/segment mesh, the wave table, atmosphere, procedural background sigils | Asset-built background pentagrams and floating mesh clusters — far behind the figure at very low opacity |
| `procedural-logo` | Ink stains with merged outlines, gyro rings, wavy rings, orbiting blobs, under-glow, dot grid, heartbeat | Five text layers, toxic ooze, bold pattern — `worxbend-text` already does particle lettering properly |
| `main-web-cam-border` | Anchor ring, eight wave rings with glow modes and drift, sparkles, sparks, lightning, orbiting particles, audio reactivity | Everything that needed the 900 kB sprite atlas — graffiti tags and marks, floating symbols, brush strokes, surface grime, logo sprite |

That is a deliberate line, not an oversight. Each omitted layer either needs an asset pipeline that
would double the file for something barely visible, or duplicates an effect this build already has.
An operator reading the inventory sees exactly what each entry contains.

> **What is not covered, 2026-08-24.** Every ported effect is asserted to paint a non-blank canvas
> with no console errors, on both the production bundle and the dev server (`effects-draw`, now 141
> assertions). Nothing asserts that any of them **looks like the original** — no screenshot is
> compared against anything, because there is no reference to compare against.
>
> **What would clear this:** the screenshot harness half-built in 3.3. Capture each effect from the
> old repository once, store those as reference images, and diff. Until then "it looks right" rests
> on the shader arithmetic being carried over unchanged, which is checkable by reading, and on
> somebody looking at it.
>
> Also untested: the mount/dispose leak check still cycles only two of the thirty effects, so the
> ported ones' teardown is structural (`scope.own` with explicit destroys) rather than measured.

### 3.2 Author the inventory, in small themed releases *(open — next)*

> **Note, 2026-08-24 — what 3.1 and 3.3 now make possible.** This item is unchanged and unstarted,
> but it is cheaper than it was. A new effect starts from `pnpm new:effect <id> "<Name>" <engine>`,
> which writes a running, parameterised, registered file. It writes no `dispose`, no animation loop
> and no renderer setup: the `Scope`, the shared clock and the stage helpers cover those, and the
> route's FPS cap is honoured without the author doing anything. An audio-reactive effect asks for
> `useAudio(scope)` instead of opening a microphone, so theme 3 no longer has a device-contention
> problem waiting in it. A shader effect composes `assembleFragment(["fbm", …], body)` rather than
> pasting noise functions. `pnpm verify` then answers "does it paint, does it leak, does it hold its
> frame budget" without anyone opening a browser.
>
> Two things to carry into the first release, both from the 3.1 caveats above: the first effect that
> needs a `rebuild: true` parameter should add the harness probe for it in the same change, and the
> second audio-reactive effect is the one that first proves the shared lease. Theme 1 (camera
> framing) is also the first real consumer of `useVideo`, which no effect exercises today.

Work in releases of three to five effects. Each release: design, implement, screenshot, review as a
group, then merge. A themed batch keeps the visual language coherent, which a random walk through
254 ports never would.

Proposed themes, most useful for streaming first — this is a starting list, not a contract, and it
should be re-cut whenever a better idea turns up:

1. **Camera framing** — the pieces that surround a webcam: animated borders, soft masks, reactive
   rings, corner ornaments. Highest practical value, because every face-cam scene needs one.
2. **Ambient backgrounds** — slow, low-distraction, low-GPU fields meant to sit behind content for
   hours without drawing attention or stealing frames from the game.
3. **Audio-reactive** — built on the shared analyser from 3.1: spectrum forms, waveform ribbons,
   beat-driven bloom. Deliberately after 3.1, never before.
4. **Scene transitions and stingers** — starting soon / be right back / ending screens. The old repo
   barely covers this and it is what a stream actually needs between segments.
5. **Alerts and overlays** — follower/sub notifications, countdowns, now-playing strips: effects
   that take *content*, not only parameters. This theme will surface a real SDK requirement (text
   and data input), which is why it is placed late enough to be designed properly.

For every effect, before it is considered done:
- Its constants are exposed as a `ParamSpec[]` with sensible ranges and defaults — this is the whole
  reason the platform exists, so an effect with two parameters deserves a second look.
- `dispose` fully releases GPU resources and passes the leak test in 3.3.
- It renders correctly at 1920×1080 over a transparent background, and holds its target frame rate
  on a mid-range GPU while a game is also running.
- It has a written note on what it is for and what it composes well with, surfaced in the inventory
  page — otherwise nobody remembers what `plasma-shader` looked like six months later.

### 3.3 Tooling that makes authoring cheap ✅ *four of six items, 2026-08-24*

This is the leverage. Build it early; it pays for itself across every effect that follows.

- **An effect scaffold generator** — one command produces a new effect file with the descriptor,
  parameter boilerplate, SDK wiring and teardown already correct, plus its registration in
  `src/effects/index.ts`. New effects should start from a working file, not a blank one.
- **A shader playground route** in dev builds: edit GLSL with live reload against the real SDK
  context and real parameter controls. Most authoring time on shader-based effects is spent in the
  edit/compile/look loop, and this collapses it.
- **A screenshot harness** with Playwright: load every effect at 1920×1080, wait a few seconds,
  write a PNG. Two payoffs — thumbnails for the inventory page (an admin dropdown of names is a poor
  way to pick a visual), and a smoke test that catches an effect rendering an empty frame.
- **A leak test** that mounts and disposes an effect fifty times and asserts WebGL contexts and the
  JS heap return to baseline. This matters more than usual here: the delivery page remounts effects
  on configuration change, and a stream runs for hours.
- **A performance budget check** that records frame time per effect at 1920×1080 and fails an effect
  that cannot hold the target rate. Encode the budget as a number in CI rather than as a vibe.
- **A contributor guide** (`docs/AUTHORING_EFFECTS.md`) covering the SDK, the shader utilities, the
  parameter conventions and the definition of done above — written for someone who has written a
  shader before but has never seen this repository.

**Delivered.** Four of the six items, and the two that carried the most weight were built *before*
3.1 rather than after it, because the roadmap's own note says 3.1 must not start without a
regression net.

- **The scaffold generator** is `frontend/tools/new-effect.mjs`, run as `pnpm new:effect` or
  `make new-effect ID=… NAME=… ENGINE=three|pixi`. It emits a complete running effect — a drifting
  fractal-noise field for `three`, a ring of pulsing bokeh for `pixi` — already formatted the way
  Prettier prints, and edits `src/effects/index.ts` for you. It differs from the plan in emitting a
  finished effect rather than boilerplate with `TODO`s, on the argument that a file which only
  *looks* finished is the expensive kind of mistake here.
- **The leak test and the performance budget** are `pnpm verify`'s `mount-dispose-cycles` and
  `perf-frame-budget` checks. Both differ from the plan. The leak test does twenty cycles, not
  fifty, and asserts *live WebGL contexts* and `loseContext()` calls rather than the JS heap: heap
  size in a browser is a number the garbage collector is free to make up, so an assertion on it
  would either be flaky or so loose it proves nothing. The budget check runs under SwiftShader
  (software rendering) in CI, so it catches an order-of-magnitude regression rather than certifying
  a real GPU's frame rate.
- **The contributor guide** is `docs/AUTHORING_EFFECTS.md`, the tutorial, sitting beside
  `docs/EFFECT_SDK.md`, the reference. Both were rewritten for the 3.1 SDK.
- **The screenshot harness half-landed.** `pnpm verify` screenshots every effect and counts painted
  pixels — the smoke test half, which is the half that catches an effect rendering an empty frame.
  It writes no PNG to disk, so the inventory page still has no thumbnails.

Measured on the current build, both targets, all six effects painting: `plasma-shader` 99.6% of the
frame, `audio-bars` 31.6%, `camera-frame-ring` 12.7%, `digital-rain` 10.0%, `starfield-warp` 8.2%,
`particle-drift` 5.1%. Twenty mount/dispose cycles: live contexts 1 → 1, twenty `loseContext()`
calls, nothing released twice, never more than one canvas in the host.

> **Caveat, 2026-08-24 — two items are not done, and one number is worth staring at.**
> **The shader playground route does not exist.** Nothing hot-reloads GLSL against a real SDK
> context and real parameter controls, so shader authoring is still edit / rebuild / look. The GLSL
> library was written with it in mind (`sdk/glsl/index.ts` is plain exported strings precisely so a
> playground can concatenate them at runtime), but the route itself is unwritten.
> **The screenshot harness writes no files**, so there are still no inventory thumbnails and an
> admin picking an effect still reads a dropdown of names.
>
> The number: under SwiftShader at 1920×1080, `digital-rain` takes about 817 ms per frame (~1.2 fps)
> where the next slowest effect takes 67 ms. It passes the budget as configured, and software
> rendering is not a verdict on a GPU, but an order of magnitude between two effects in the same
> build is the shape of a real problem — one `PIXI.Text` object per glyph per column is the likely
> cause.
>
> **What would clear this:** a `/dev/shader` route behind `import.meta.env.DEV` that mounts a
> `fullscreen-quad` stage, compiles a textarea's GLSL through `assembleFragment` on every keystroke
> and shows the compile error instead of a black screen; a `--screenshots <dir>` flag on `pnpm
> verify` that writes the PNG it already captures, plus the inventory page reading them; and a
> profile of `digital-rain` against a real GPU before deciding whether it needs rewriting onto a
> single `BitmapText` or a shader.
---

## Phase 4 — Production readiness

### 4.1 Integration and end-to-end tests *(closes G6)*
- **Backend integration tests** against a real MongoDB using Testcontainers, covering the repository
  layer: the unique slug index, upsert semantics of `/api/effects/sync`, and ObjectId round-tripping.
  These are the tests the current suite deliberately skips.
- **Frontend unit tests** with Vitest for `src/api/client.ts` error mapping and the `ParamsForm`
  default-merging logic, **plus a mount/dispose assertion for `EffectStage`** — see the note in 3.1
  for why that one should be written before Phase 3 rather than here. There are currently zero
  frontend tests of any kind, so this is the first one, and the scaffolding it needs (Vitest, a DOM
  environment, a `test` script wired into `make ci-frontend` and the CI workflow) does not exist
  yet either.
- **One end-to-end test** with Playwright against the full compose stack: log in, create a route,
  open `/e/<slug>`, assert the canvas is drawing, change a parameter, assert the page picked it up.
  This single test covers the entire feature the project exists for.

### 4.2 Production deployment *(closes G7)*
- A multi-stage frontend Dockerfile: build with pnpm, serve the static output from nginx or Caddy
  with correct cache headers, and reverse-proxy `/api` to the backend so the browser sees one origin
  (which also removes the CORS wildcard).
- A `docker-compose.prod.yml` overlay: no bind mounts, no dev server, pinned image tags, a Mongo
  volume backup target in the Makefile, and restart policies.
- Health checks and a documented restore procedure.

### 4.3 Observability
- Structured JSON logging on the backend, replacing `slf4j-simple`.
- A browser-side error reporter: when an effect throws mid-stream, the delivery page should post the
  error to the backend and render a last-known-good fallback rather than a black rectangle. On a
  live broadcast, a silent failure is the worst outcome.
- An admin "status" panel listing which slugs have an active browser source connected, derived from
  the SSE connections in 2.2. This answers "is OBS actually pointed at this?" at a glance.

---

## Suggested order of work

*Rewritten 2026-08-24, now that Phase 1 and Phase 2 are both done.*

Phase 1 was the prerequisite for everything, and Phase 2 has since closed the two gaps that made the
app unsafe and slow to operate: the admin now requires a login, and the delivery page is pushed its
configuration instead of asking for it. What remains is Phase 3 (the effect inventory) and Phase 4
(production readiness), and Phase 4 is no longer blocked — the authentication it was waiting on has
landed, so the app can be exposed beyond localhost once `SESSION_COOKIE_SECURE` is turned on.

**The next slice, and it is not what this section used to say.** The original plan sent Phase 1
straight into 3.1. That is now the wrong move, for a reason Phase 1 produced evidence for rather
than a preference: two real defects were found in `EffectStage.tsx` by running the app in a browser,
and both were invisible to every automated check the project has. 3.1 refactors all six effects onto
a new SDK — the exact same class of change, at six times the surface area — and there is still no
frontend test of any kind.

So: **the frontend testing scaffolding from 4.1 first**, kept deliberately small (Vitest, a DOM
environment, a `test` script wired into `make ci-frontend` and the CI workflow, and the
`EffectStage` mount/dispose assertion described in 3.1), **then 3.1**. That is perhaps a day of work
to avoid discovering the third ownership bug on air.

Two smaller things worth picking up whenever they are convenient, because both are short and both
are already understood:

- **The loose ends Phase 2 left behind**, all of them small and all written up as caveats above:
  the half-failed import that publishes no events (2.2, the only behavioural one), the stale
  "five public endpoints" comment, the missing 405 row and the `createdAt` bullet in
  `docs/CONTRACT.md`, and the three 2.1 limitations — global rather than per-IP login lockout,
  `SESSION_COOKIE_SECURE` defaulting to `false`, and an unauthenticated `/docs`.
- **Finishing 1.4's acceptance check** — push the repository, confirm the first CI run is green,
  then break something on purpose and confirm it goes red. Also fill in the badge URL in the root
  `README.md`, which is a placeholder until the repository has an address.

One standing item with no scheduled slot: **`@solidjs/router` is a pre-RC dependency on the live
delivery path.** Watch for its 2.0.0 final, and see the caveat under 1.1 for what to re-test when it
lands.
