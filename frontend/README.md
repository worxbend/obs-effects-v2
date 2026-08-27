# Frontend — admin UI and effect renderer

This folder holds **one** web application that does two very different jobs:

1. **The admin UI** (`/admin`) — where you create "routes", pick an effect and tune its
   parameters. You look at this in an ordinary browser.
2. **The renderer** (`/e/<slug>`) — a bare, fully transparent page that draws one effect and
   nothing else. This is the URL you paste into an OBS **browser source**.

They live in the same application because they share the effect code: the admin's live preview
runs the exact same effect, through the exact same interface, that OBS ends up showing.

---

## Words you will meet

- **OBS** — Open Broadcaster Software, the program streamers use to compose a video scene out of
  layers. One of the layer types it offers is a **browser source**: an embedded web browser whose
  page becomes a video layer.
- **Effect** — a visual effect written in TypeScript and drawn with either
  [three.js](https://threejs.org/) (3D) or [pixi.js](https://pixijs.com/) (2D).
- **Route** — a saved mapping from a URL slug (`main-camera`) to an effect id plus the parameter
  values to run it with. The whole point: the OBS URL is set up once and never changes, while the
  configuration behind it can change as often as you like.
- **Slug** — the readable identifier in the URL. `main-camera` in `/e/main-camera`.
- **Vite** — the build tool and development server. It serves the app while you work and rebuilds
  the page in place when you save a file.
- **pnpm** — the package manager. Like `npm`, but it stores each package once on disk and links
  it into projects, which is faster and uses far less space.

---

## Running it

You never need Node, pnpm or Vite installed on your own machine. From the repository root:

```bash
docker compose up
```

Then open:

| URL                              | What it is                                           |
| -------------------------------- | ---------------------------------------------------- |
| `http://localhost:3000/admin`    | the admin UI                                         |
| `http://localhost:3000/e/<slug>` | the renderer — paste this into an OBS browser source |

Saving a file under `src/` updates the browser within about a second; there is no build step to
run by hand.

### Setting up the OBS browser source

1. In OBS, add a **Browser** source to your scene.
2. Set the URL to `http://localhost:3000/e/main-camera` (using your own slug).
3. Set the width and height to whatever the layer should be — the effect follows that size
   automatically, so there is no separate setting to keep in sync.
4. Leave **Shutdown source when not visible** off if you want the effect running continuously.

You never have to open this dialog again. Changing the effect or its parameters in the admin UI
reaches the live source in well under a second: the backend pushes the new configuration down an
event stream the page holds open. If that stream cannot be kept open — an old proxy in the way, for
example — the page falls back to asking every five seconds, which is what it always did before.

---

## npm scripts

Run these with `pnpm run <name>` — inside the container, e.g.
`docker compose exec frontend pnpm run typecheck`.

| Script         | What it does                                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `dev`          | Starts the Vite development server on port 3000 with hot module replacement. This is what the container runs by default.    |
| `build`        | Type-checks the project and then produces an optimised production bundle in `dist/`.                                        |
| `preview`      | Serves an already-built `dist/` on port 3000, to check the production bundle locally.                                       |
| `typecheck`    | Runs the TypeScript compiler in check-only mode. Nothing is emitted; it only reports type errors.                           |
| `lint`         | Runs ESLint over the whole folder and fails on the first problem, warnings included.                                        |
| `lint:fix`     | The same, but rewrites the problems ESLint knows how to fix by itself first.                                                |
| `format`       | Runs Prettier in write mode: reformats every file it owns, in place.                                                        |
| `format:check` | Runs Prettier in report mode: lists badly formatted files and fails. This is the one for CI.                                |
| `verify`       | Drives the built app in a real browser and checks what it actually does. See [Runtime verification](#runtime-verification). |

---

## Runtime verification

`lint`, `format:check`, `typecheck` and `build` all read the source without running it. Everything
this project can get badly wrong happens at runtime and passes all four:

- an effect that mounts, produces a `<canvas>`, and paints nothing;
- a WebGL context that is never released, so after enough route changes the browser refuses to give
  out another one and every effect on the machine stops drawing;
- the five-second fallback poll quietly continuing to run alongside the event stream, doubling the
  traffic from every browser source forever;
- `/e/:slug` following the admin's "you are signed out" redirect and replacing a live layer with a
  password form.

`pnpm verify` runs those checks. It starts a **stub backend** written in plain Node
(`tools/verify/stub-backend.mjs`), serves the built app next to it, drives the result with headless
Chromium, and reports what happened with numbers rather than adjectives — pixels painted per
effect, requests counted per second, WebGL contexts created and released.

### Running it

The harness needs a Chromium that Playwright can drive, which nothing on the host is expected to
have. Two containers, because they need different things: the Node image installs and builds, and
Microsoft's Playwright image ships the browser.

```bash
# 1. install and build, exactly as `make ci-frontend` does
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w \
  node:24-bookworm-slim \
  sh -c 'mkdir -p /tmp/bin && corepack enable --install-directory /tmp/bin \
         && export PATH=/tmp/bin:$PATH && pnpm install --frozen-lockfile && pnpm build'

# 2. run the checks
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp --add-host backend:127.0.0.1 \
  -v "$PWD:/w" -w /w mcr.microsoft.com/playwright:v1.50.0-jammy \
  node tools/verify/run.mjs --both
```

Two details of the second command are load-bearing:

- **`--add-host backend:127.0.0.1`.** `vite.config.ts` proxies `/api` to `http://backend:8080`,
  which is the Compose service name. Mapping that name to the loopback address inside the container
  points the proxy at the stub backend the harness starts, with no change to the application's own
  configuration. Without it the development target has no API at all.
- **the image tag must match the `playwright-core` version in `package.json`.** The browsers live
  in the image; `playwright-core` only drives them, and it looks for the exact build revision its
  own version was released against. Bump the two together or neither.

### Flags

| Flag            | Effect                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------- |
| _(none)_        | Checks the production bundle in `dist/`.                                                 |
| `--dev`         | Checks the Vite development server instead — the build `make up` serves.                 |
| `--both`        | Both, in sequence.                                                                       |
| `--slow`        | Also runs the checks that spend a minute waiting out a timeout on purpose.               |
| `--only=<text>` | Only the checks whose name contains `<text>`, e.g. `--only=sse`. Useful while iterating. |

**Check both builds.** Solid's development build prints warnings the production build strips out,
and Phase 1 shipped a defect that was visible only in development — with a green typecheck and a
green production build. `--both` is what a release should run.

### What is in `tools/verify/`

| File               | What it is                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| `run.mjs`          | The command line: starts the stub, starts Vite when asked, runs the checks in order, prints the report.  |
| `stub-backend.mjs` | The fake API. In-process, so a check can drop an event stream or expire a session by calling a function. |
| `probe.mjs`        | The instrumentation injected into every page: canvas identity, live WebGL contexts, `loseContext` calls. |
| `harness.mjs`      | Browser launch, per-check isolated pages, and the recorder that collects console and page errors.        |
| `png.mjs`          | A small PNG reader, so "did this effect draw anything?" is answered in pixels.                           |
| `checks/`          | The checks themselves, grouped into effects, renderer and admin.                                         |

Adding a check means writing one `async function ({ stub, baseUrl, browser, results, target })` in
`checks/` and adding it to the `CHECKS` list in `run.mjs`. Call `results.ok(condition, label,
detail)` for each thing you assert; a failure does not stop the run, because the point of a
verification pass is to come back with the whole list rather than with the first thing that broke.

---

## Linting and formatting

Two separate tools, with two separate jobs. Mixing them up is the usual source of confusion.

- **Prettier** decides how the code _looks_ — line breaks, indentation, quote characters. It has
  no opinion about whether the code is correct. Configured in `prettier.config.mjs`, with
  `.prettierignore` listing what it must not touch.
- **ESLint** decides whether the code is _likely to be wrong_ — an ignored promise, a Solid signal
  read where it will never update again, an unused import. Configured in `eslint.config.mjs`.

They are deliberately kept out of each other's way: the ESLint config ends with
`eslint-config-prettier`, which switches off every ESLint rule that has an opinion about layout.
Without it the two tools would each keep undoing the other's fixes.

```bash
docker compose exec frontend pnpm run lint          # report problems
docker compose exec frontend pnpm run lint:fix      # fix the fixable ones
docker compose exec frontend pnpm run format        # reformat everything
docker compose exec frontend pnpm run format:check  # report, do not rewrite
```

From the repository root there are shorthands for the three you will type most:
`make frontend-lint`, `make frontend-format` and `make frontend-format-check`. To run the whole
gate exactly as CI does — install, lint, format check, typecheck, build — use `make ci-frontend`,
which does it all in a throwaway container and so is not affected by the `node_modules` volume
described under [Troubleshooting](#troubleshooting).

`pnpm run lint` passes `--max-warnings 0`, so a rule set to "warn" fails the command just as an
"error" does. That is on purpose: several of the SolidJS rules ship as warnings, and a warning
nobody is forced to look at is a warning nobody looks at.

Three settings in the ESLint config are worth knowing about before you edit it:

- The `typescript-eslint` rules are the **type-aware** set (`recommendedTypeChecked`). They read
  the same type information `tsc` builds, which is what lets them see a dropped `Promise`. The
  stricter `strictTypeChecked` set is deliberately not used: it flags runtime guards such as
  `navigator.mediaDevices?.getUserMedia` as unnecessary, because the DOM type definitions claim
  those values are always present when in a real browser they are not.
- `solid/imports` is switched **off**, and it is the only rule that is. In
  `eslint-plugin-solid@0.16.0` it insists the `JSX` type comes from `solid-js`; in Solid 2 it comes
  from `@solidjs/web`, and following the rule's automatic fix makes the type-check fail. The
  reasoning is written out in full in `eslint.config.mjs`.
- The configuration files themselves (`*.mjs`) get the plain JavaScript rules only. They are not
  listed in `tsconfig.json`, so there is no TypeScript program for the type-aware rules to consult.

---

## How the pieces fit together

```
src/
├── index.tsx              Entry point: sets up the router. Nothing else — see the note below.
├── types/contract.ts      TypeScript mirror of docs/CONTRACT.md. The API's shape, in one file.
├── api/client.ts          One typed function per API endpoint, plus ApiError/NetworkError
│                          and the single place a 401 is turned into "you were signed out".
├── auth/session.ts        The admin's shared memory of whether it is signed in.
├── effects/
│   ├── types.ts           The Effect SDK interfaces (EffectModule / EffectContext / EffectInstance).
│   ├── sdk.ts             Re-export of types.ts, so effects can `import ... from "../sdk"`.
│   ├── registry.ts        Indexes the effects, merges parameters, publishes the manifest.
│   ├── index.ts           The list of implemented effects. Owned by the effects author.
│   ├── paramUtils.ts      Defensive readers effects use to coerce parameter values.
│   ├── three/             One file per three.js effect.
│   └── pixi/              One file per pixi.js effect.
├── components/
│   ├── AdminShell.tsx     Top bar, navigation, health indicator, session gate, sign-out.
│   ├── EffectStage.tsx    Mounts an effect into a div and drives its lifecycle.
│   ├── ParamsForm.tsx     Builds a form from a ParamSpec[] — no effect-specific code.
│   ├── EffectPicker.tsx   The grouped effect chooser.
│   ├── RoutePresets.tsx   The route editor's "save / apply a preset" card.
│   ├── Badges.tsx         Small coloured pills (engine, enabled/disabled).
│   └── Banner.tsx         Error / success / info message strips.
├── pages/
│   ├── RoutesListPage.tsx The table at /admin.
│   ├── RouteEditorPage.tsx  Create and edit, with the live preview pane.
│   ├── PresetsPage.tsx    Saved parameter sets at /admin/presets.
│   ├── BackupPage.tsx     Export and import at /admin/backup.
│   ├── InventoryPage.tsx  The read-only effect browser at /admin/effects.
│   ├── LoginPage.tsx      The sign-in form at /admin/login. Outside the admin shell.
│   ├── RendererPage.tsx   The OBS page at /e/:slug.
│   └── NotFoundPage.tsx   404.
└── styles/app.css         The whole stylesheet. No CSS framework.
```

### Where configuration comes from

When an admin page opens, `AdminShell` calls `publishManifest()`. That takes every effect compiled
into this build and `POST`s their descriptions to `POST /api/effects/sync`. The backend's inventory
is therefore always a copy of what the frontend can actually draw — which is why the route editor
can never offer you an effect that does not exist.

That call used to live at the top of `src/index.tsx`, where it ran on every page load. It had to
move: `POST /api/effects/sync` now requires a session, and left where it was, every OBS browser
source would have fired a request that comes back `401` on every single load. It now runs after the
session check and only from the admin.

The reverse direction is the renderer. `/e/:slug` reads `GET /api/routes/by-slug/<slug>` once so
the first frame does not wait for anything, and then holds open the event stream
`GET /api/routes/by-slug/<slug>/events`, down which the backend pushes a new configuration whenever
one is saved. Either way the arriving configuration goes through the same code: when the
`updatedAt` timestamp changes it hands the new parameters to the running effect (no reload, no
black frame), and when the `effectId` changes it disposes the old effect and mounts the new one.

The old five-second poll is still there as the fallback, and **exactly one of the two is ever
running.** The stream counts as healthy from the first message that arrives on it — including its
20-second heartbeat — and while it is healthy no poll timer exists. It counts as broken when the
browser reports an error on it, or when nothing at all has arrived for 45 seconds; either one
starts the poll again and replaces the connection. The 45-second watchdog is not belt and braces:
a proxy that buffers an event stream holds the connection open forever while delivering nothing,
and the browser has no reason to call that an error. Watch `[renderer]` lines in the browser
console to see which mode a page is in — it logs one line each time it switches.

One measured consequence, worth knowing before you time a restart: **through the Vite development
proxy, restarting the backend is a silence rather than an error.** The browser's connection is to
Vite, and Vite keeps it open after the upstream goes away, so the page falls back after its
45-second watchdog rather than within a second. Served directly — the production shape, and a
reverse proxy that does not buffer — the browser sees the drop and the poll resumes immediately.
Both paths were measured with `pnpm verify`; see [Runtime verification](#runtime-verification).

### Presets, and backing everything up

A **preset** is a named set of parameter values for one effect. Presets belong to an effect and not
to a route, and applying one is purely a client-side act: the route editor copies the preset's
values into the form, and you then adjust them and save the route as usual. There is deliberately
no "apply this preset to that route" endpoint, because the adjustment afterwards is the reason to
start from a preset at all. `/admin/presets` creates, renames, re-tunes and deletes them; the
editor's own **Presets** card saves and applies them without leaving the route you are editing.

Because presets belong to one effect, the editor's card is only ever handed the descriptor of the
effect currently selected in the form, and it asks the API only for that effect's presets. There is
no control in it that could name a different effect, so applying a preset built for another effect
is not something the UI can express — it is not merely refused by the server.

`/admin/backup` downloads every route and preset as one JSON file, and restores one. Importing has
a confirmation step that states, in numbers worked out against what is actually stored right now,
how many routes and presets would be overwritten, created or deleted. **`merge` and `replace` have
no default**: the button stays disabled until you pick one, because the two differ by "nothing is
deleted" versus "everything is deleted first". No `window.confirm` anywhere — a native dialog
cannot show those numbers, blocks the whole browser thread, and cannot be tested.

### Signing in, and the one page that must never be asked to

The admin is behind a single password (there is one operator; see `docs/CONTRACT.md` §4). Three
pieces make that work, and it is worth knowing which piece is which before changing any of them.

1. **The cookie travels because `src/api/client.ts` says `credentials: "include"`.** A session that
   appears to succeed and then forgets you on the next click is almost always this line, or a
   cross-origin setup without `CORS_ALLOWED_ORIGINS` on the backend. Leave `VITE_API_BASE` empty and
   the whole question goes away: the app and the API are then one origin, and the cookie is an
   ordinary first-party cookie.
2. **A `401` is handled once, not per page.** Any protected call that comes back `401` means the
   session ended while the tab was open. `client.ts` raises that through a handler registered by
   `AdminShell`, which sends the operator to `/admin/login?next=<where they were>`; the login page
   returns them there afterwards. No page checks for a `401` itself.
3. **`/e/:slug` is exempt, structurally.** The renderer page is a route of its own, outside
   `AdminShell`. It calls only public endpoints, holds no session, and — because the `401` handler
   is registered _by the shell_ — there is no handler installed at all while it is on screen. An
   OBS browser source cannot sign in: it opens one URL, unattended, for the length of a broadcast.
   A renderer that navigated itself to a login form would take a live layer off air with nothing in
   OBS to explain it.

If you are restructuring routing, keep all three properties of point 3: no shell around the
renderer, no protected call from it, no `401` handler while it is mounted. A "central" guard that
wraps every route is exactly the refactor this warning exists for.

### Canvas settings: render resolution, not source size

Each route carries a `canvas` of `width`, `height` and `fpsCap`. `width` and `height` are the
resolution the effect is asked to _draw_ at. `RendererPage` lays the effect's host element out at
exactly that size and then scales the whole block with a CSS transform to fit the OBS browser
source, keeping the aspect ratio and leaving the edges transparent. So a route set to 1280×720
inside a 1920×1080 source draws about 44% of the pixels, and the work the graphics card does not
spend on the overlay is work it keeps for the game being streamed.

Two consequences:

- `EffectInstance.resize(w, h)` receives the **canvas** size and fires when the canvas settings
  change — not when OBS resizes the source. The admin preview pane is the exception: it has no
  fixed resolution, so `EffectStage` measures and observes it as before. The two behaviours are
  chosen by whether the caller passes `width`/`height` to `EffectStage`.
- `fpsCap` reaches effects as `EffectContext.fpsCap` but **nothing enforces it yet**; the six
  effects run their own animation loops. The route editor states that next to the input rather than
  offering a control that quietly does nothing.

### Sparse parameters

A route stores only the values that **differ** from the effect's declared defaults. That way,
changing a default in the effect's code still reaches every route that never overrode it. The
merge happens in `mergeParams()` and the trim in `sparseParams()`, both in
`src/effects/registry.ts`.

---

## Environment variables

| Variable        | Default                  | Meaning                                        |
| --------------- | ------------------------ | ---------------------------------------------- |
| `VITE_API_BASE` | `/api` (proxied by Vite) | Base URL the **browser** uses to reach the API |

Two things about `VITE_API_BASE` are easy to get wrong:

- It is read **in the browser**, so it must be a URL your machine (and OBS) can open. A
  Docker-internal hostname like `http://backend:8080/api` will not work — your browser has no idea
  what `backend` means.
- Vite bakes it into the bundle. Changing it requires restarting the frontend container.

If you leave it unset, the app calls the relative path `/api`, and the Vite dev server forwards
those calls to the backend container (see the `proxy` section of `vite.config.ts`). That is the
simplest setup and the one to prefer during development.

---

## Adding an effect

See `docs/EFFECT_SDK.md` for the full contract. The short version:

1. Create `src/effects/three/my-effect.ts` (or `src/effects/pixi/my-effect.ts`, depending on the
   library you draw with) and default-export an `EffectModule`.
2. Import it in `src/effects/index.ts` and add it to the exported `effects` array.
3. Reload the admin UI. The manifest is republished automatically and your effect appears in the
   picker and in the Inventory page.

The three rules that matter most, because breaking them shows up live on stream:

- `setParams` receives the **full** merged parameter set and must apply changes in place. No
  rebuilding the scene, no flash.
- `dispose` must release every GPU object and be safe to call twice. Browsers allow only a
  handful of WebGL contexts, and OBS keeps a page alive for hours.
- `resize` may fire many times per second while an OBS source is being dragged. Return early when
  the size has not changed.

---

## Troubleshooting

**The admin UI says "backend unreachable".**
The `backend` container is not answering. Check `docker compose ps` and
`docker compose logs backend`.

**The OBS source is blank and there is no error message.**
That is what a _disabled_ route looks like on purpose. Open the route in the admin UI and turn
"Enabled" back on.

**The OBS source shows "this build does not implement …".**
The route points at an effect id that is not in `src/effects/index.ts` — usually a route saved by
an older build. Pick a different effect in the editor.

**Changes are not appearing in the browser while I edit.**
File-change events sometimes get lost across a bind mount. `vite.config.ts` already enables
polling for this reason; if it still happens, restart the container.

**After pulling a dependency change, the container fails with "cannot find module" or runs the old
library versions.**
`docker-compose.yml` keeps the container's `node_modules` in a **named volume** so that the source
bind mount does not hide it. That volume survives `docker compose down` and even a rebuild, so a
`package.json` change does not reach it on its own. Delete it and start again:

```bash
docker compose down
docker volume rm obs-effects-v2_frontend-node-modules
docker compose up --build
```

(If the volume name is not found, `docker volume ls | grep node-modules` shows what it is actually
called — Compose prefixes it with the project directory name.) `make clean` also removes it, but
note that it removes the MongoDB volume too, which erases every saved route.

---

## A note on versions

This app runs on **SolidJS 2**. Four of its packages are still prereleases, so they are pinned to
an **exact** version with no `^` in front — a caret would let a rebuild weeks from now silently
install a different reactive core than the code was written against:

| Package                | Version         | Why this exact one                                                                     |
| ---------------------- | --------------- | -------------------------------------------------------------------------------------- |
| `solid-js`             | `2.0.0-rc.1`    | Solid 2 itself. A release candidate: the API is frozen, but it is not a final release. |
| `@solidjs/web`         | `2.0.0-rc.1`    | New in Solid 2 — see below. Must be the _same_ build as `solid-js`.                    |
| `@solidjs/router`      | `2.0.0-next.17` | The only router that works with Solid 2. Still one channel behind the core.            |
| `@solidjs/vite-plugin` | `3.0.0-next.32` | The Solid JSX compiler for Vite. Formerly published as `vite-plugin-solid`.            |

`typescript` is deliberately **not** the newest release. TypeScript 7 exists, but
`typescript-eslint` — which this project's ESLint setup is built on — declares support for
TypeScript below 6.1 only, so 6.0.3 is the newest version that keeps everything in one supported
set. Revisit when that peer range widens. `@types/node` tracks the
Node line the Docker image actually runs (24), not the newest published.

**The known risk, stated plainly:** `@solidjs/router` is the weak link. The core has reached a
release candidate; the router has not, and its API can still change before 2.0 is final. That
matters more here than in most apps, because the router serves `/e/:slug` — the page a live
broadcast points at. Re-check it before this project is relied on for anything that must not break
mid-stream.

---

## Solid 2 for people who knew Solid 1

Five differences account for nearly everything in this codebase that will look unfamiliar.

**1. The DOM renderer moved to its own package.** `render` and the `JSX` types now come from
`@solidjs/web`, not `solid-js/web` (that subpath no longer exists). `tsconfig.json` sets
`"jsxImportSource": "@solidjs/web"` for the same reason.

**2. `createEffect` takes two functions instead of one.**

```ts
createEffect(
  // compute: the TRACKED half — reactive reads go here.
  () => userId(),
  // apply: the UNTRACKED half — imperative work goes here.
  (id) => {
    const controller = new AbortController();
    fetch(`/users/${id}`, { signal: controller.signal });
    // The RETURNED function is the cleanup.
    return () => controller.abort();
  },
);
```

The cleanup runs before the next `apply` and once on disposal — never at any other time. That is
why `src/components/EffectStage.tsx` has no `onCleanup` at all: returning the disposal from `apply`
is what makes "the old effect is disposed exactly once" true by construction rather than by
discipline. Read the invariant comments in that file before changing it.

One thing to know before you write your first two-function effect: if `apply` reads a signal, the
development build prints

```
[STRICT_READ_UNTRACKED] Reactive value read directly in an effect callback will not update.
Move it into a tracking scope (JSX, a memo, or an effect's compute function).
```

That warning is not saying you broke something. `apply` never subscribes to anything — that is its
whole job — so Solid is pointing out that the value you read there will not bring the effect back
when it changes, in case you expected it to. When you did expect it, move the read up into
`compute`. When you did not, wrap it in `untrack`:

```ts
const snapshot = untrack(() => somethingReactive());
```

`untrack` changes no behaviour at all here; the read was already untracked. It records that the
omission is deliberate, and it silences the warning. `EffectStage` uses it in exactly two places,
both marked with a comment saying why. Do not leave these warnings in place: `docker compose` runs
the development server, the delivery page mounts a fresh effect on every configuration change, and
a console full of warnings you have learned to scroll past is a console where you will miss the one
that matters.

**3. There is no `createResource`.** Asynchronous data is a `createMemo` whose function returns a
promise:

```ts
const routes = createMemo(() => listRoutes());
```

Reading `routes()` before it resolves does not give you `undefined` — it _suspends_, and the
nearest `<Loading>` shows its fallback. If the promise rejects, reading throws and the nearest
`<Errored>` catches it. So the old `resource.loading` and `resource.error` fields are gone, and
their jobs are done by those two components instead. `refetch()` is now `refresh(theMemo)`.

**4. `Suspense` is called `Loading`, `ErrorBoundary` is called `Errored`, and `onMount` is called
`onSettled`** (which, like the new `createEffect`, returns its own cleanup instead of needing a
separate `onCleanup`).

**5. Signal writes are batched.** A setter no longer takes effect synchronously, so
`setCount(1); count()` still reads the old value until the batch flushes. `batch()` was removed
because batching is now the default. Read before you write, not after.

The router changed as much: `<Router>`, `<Route>`, `<A>` and `<Navigate>` are all gone.
Routes are a configuration object passed to `createRouter()` at module scope (see
`src/index.tsx`), links are plain `<a href>` elements that the router intercepts, and the
"which tab am I on" highlight is CSS on the `aria-current="page"` attribute the router sets for
you — see `.nav a[aria-current="page"]` in `src/styles/app.css`.

---

## The lockfile

`pnpm-lock.yaml` is committed on purpose: it is what makes `pnpm install --frozen-lockfile` inside
the Docker image reproducible, and with four prerelease dependencies in play it is doing more work
than usual. If you change a dependency, commit the regenerated lockfile with it.
