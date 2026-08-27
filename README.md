# obs-effects-v2

<!--
  Continuous-integration badge.

  A badge is an image GitHub generates on the fly showing whether the last run of a workflow
  passed. The URL has a fixed shape:

      https://github.com/<owner>/<repository>/actions/workflows/<file>/badge.svg

  `OWNER/REPOSITORY` below is a placeholder because this repository has not been pushed anywhere
  yet, so nobody knows what its address will be. Replace both occurrences with the real path the
  first time you push — for example `alice/obs-effects-v2` — and the badge starts working. Until
  then it renders as a broken image, which is why it is left commented out rather than shown.

  [![CI](https://github.com/OWNER/REPOSITORY/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/REPOSITORY/actions/workflows/ci.yml)
-->

Configurable browser-source visual effects for [OBS Studio](https://obsproject.com/), managed from
a small web admin panel.

You point an OBS **browser source** (a web page used as a video layer in your scene) at a URL such
as `http://localhost:3000/e/main-camera` **once**. From then on you change which effect that source
shows, and every knob of that effect, from the admin UI in your browser. OBS itself never has to be
touched again — the page notices the change on its own within a few seconds.

Everything runs in Docker containers. You do **not** need Node.js, pnpm, Java, Scala, Mill or
MongoDB installed on your machine.

---

## Table of contents

- [What the pieces are](#what-the-pieces-are)
- [Architecture](#architecture)
- [Quickstart](#quickstart)
- [URLs](#urls)
- [The effects included](#the-effects-included)
- [Connecting to OBS audio](#connecting-to-obs-audio)
- [Using it: from empty database to a live OBS source](#using-it-from-empty-database-to-a-live-obs-source)
- [Adding a new effect](#adding-a-new-effect)
- [Running the tests](#running-the-tests)
- [Linting, formatting and CI](#linting-formatting-and-ci)
- [Everyday commands](#everyday-commands)
- [Versions this project is built on](#versions-this-project-is-built-on)
- [Where things live](#where-things-live)
- [Documentation](#documentation)

---

## What the pieces are

Three words are used throughout the code and the documentation. They are worth learning first.

- **Effect** — one visual effect *implementation*: a TypeScript file in the frontend that draws
  something with [three.js](https://threejs.org/) (3D) or [pixi.js](https://pixijs.com/) (2D).
  Every effect ships a **descriptor**: its id, its human-readable name, and the list of parameters
  ("knobs") it accepts. Six effects are included out of the box.
- **Route** — a mapping you create in the admin UI: a **slug** you choose (`main-camera`,
  `intro-screen`, …) pointing at one effect id plus the parameter values to run it with. The slug is
  the part of the OBS URL after `/e/`.
- **Inventory** — the backend's stored copy of every effect descriptor. The frontend is the
  authority on which effects exist, because the code lives there; on every page load it *pushes*
  its list to the backend so the admin UI can offer the effects this build actually contains.

A route survives forever. An effect is code. The admin UI is where the two are married.

---

## Architecture

```
                    your browser                            OBS Studio
                         │                                       │
              http://localhost:3000/admin            http://localhost:3000/e/main-camera
                         │                                       │
                         ▼                                       ▼
        ┌────────────────────────────────────────────────────────────────────┐
        │  frontend container — SolidJS + Vite dev server (port 3000)        │
        │                                                                    │
        │   /admin/*   admin UI: list routes, create, edit parameters        │
        │   /e/:slug   renderer: transparent page, mounts one effect         │
        │                                                                    │
        │   src/effects/  six effect modules (three.js / pixi.js)            │
        └───────────────────────────┬────────────────────────────────────────┘
                                    │  JSON over HTTP  (/api/...)
                                    ▼
        ┌────────────────────────────────────────────────────────────────────┐
        │  backend container — Scala 3, tapir + netty, direct style (8080)   │
        │                                                                    │
        │   GET  /api/effects            the inventory                       │
        │   POST /api/effects/sync       frontend publishes what it can draw │
        │   CRUD /api/routes             the slug → effect + params mappings │
        │   GET  /api/routes/by-slug/…   what the renderer polls             │
        │   GET  /docs                   interactive API documentation       │
        └───────────────────────────┬────────────────────────────────────────┘
                                    │  MongoDB wire protocol
                                    ▼
        ┌────────────────────────────────────────────────────────────────────┐
        │  mongo container — collections: effects, routes (port 27017)       │
        └────────────────────────────────────────────────────────────────────┘
```

Why it is split this way:

- **The effect code lives in the frontend** because that is the only place a WebGL canvas exists.
  The backend never knows what "plasma" means; it stores descriptors and values as opaque JSON.
- **The backend owns persistence and validation.** It refuses a route that points at an unknown
  effect, an unknown parameter key, or a value outside a parameter's declared range — so a broken
  configuration can never reach OBS.
- **The renderer polls instead of holding a socket open.** A browser source in OBS may be reloaded,
  suspended or recreated at any moment; a plain `GET` every five seconds is the shape that survives
  that without reconnection logic.

The exact JSON shapes, error codes and validation rules are written down once, in
[`docs/CONTRACT.md`](docs/CONTRACT.md). The Scala DTOs and the TypeScript interfaces in
`frontend/src/types/contract.ts` are both mirrors of that document.

---

## Quickstart

You need [Docker](https://docs.docker.com/get-docker/) with the Compose plugin (`docker compose
version` should print something). Nothing else.

```bash
cp .env.example .env
make up
```

`make up` is a shortcut for `docker compose up -d --build`: it builds the two images and starts
`mongo`, `backend` and `frontend` in the background.

The **first** run takes several minutes — Docker downloads a MongoDB image, a Java runtime, the
Scala compiler and every JavaScript dependency. Later runs start in seconds.

Watch it come up:

```bash
make logs        # Ctrl+C stops watching; it does not stop the containers
```

When the backend prints that it is listening, check it is healthy:

```bash
curl http://localhost:8080/api/health
# {"status":"ok","mongo":"up","effects":0,"routes":0}
```

`"effects":0` at this point is normal: the inventory is filled the first time you open the frontend
in a browser, because that is when the frontend publishes the effects it contains.

Stop everything with `make down` (your data is kept). `make clean` also deletes the database.

If a port is already taken on your machine, change it in `.env` — every port has an override there
— and run `make up` again.

---

## URLs

| What | URL |
|---|---|
| Admin UI (route list) | <http://localhost:3000/admin> |
| Effect inventory browser | <http://localhost:3000/admin/effects> |
| OBS browser source | `http://localhost:3000/e/<slug>` |
| API documentation (Swagger UI) | <http://localhost:8080/docs> |
| API health check | <http://localhost:8080/api/health> |
| Database browser (optional, `make tools`) | <http://localhost:8081> |

---

## The effects included

These are the effects this build can draw. The list is generated from
`frontend/src/effects/index.ts` — that file is the single source of truth, and the ids below are
exactly the `descriptor.id` values it exports. You pick one of them per route; the admin UI at
<http://localhost:3000/admin/effects> shows the same list with every parameter spelled out.

| Effect id | Name | Engine | What it draws |
|---|---|---|---|
| `starfield-warp` | Starfield Warp | three.js | Stars streaming towards the camera, stretched into hyperspace streaks. |
| `plasma-shader` | Plasma Shader | three.js | A full-screen fractal-noise plasma field computed in a GLSL fragment shader. |
| `camera-frame-ring` | Camera Frame Ring | three.js | A glowing ring with a transparent centre, sized to frame a circular webcam source. |
| `particle-drift` | Particle Drift | pixi.js | Soft bokeh dust particles drifting upwards with additive blending. |
| `digital-rain` | Digital Rain | pixi.js | Matrix-style columns of falling glyphs with a bright leading character. |
| `audio-bars` | Audio Bars | pixi.js | A spectrum analyser driven by OBS's own audio levels. |

### Ported from the original `obs-effects` repository

These came across from the previous HTML-page-per-effect project. Each one keeps its original look;
what is new is that every constant it hard-coded is now a parameter you can change from the admin.

**Backgrounds**

| Effect id | Name | Engine | What it draws |
|---|---|---|---|
| `razer-toxic-marble` | Razer Toxic Marble | three.js | Wide bands of acid green with thin black outlines, drifting like a topographic map. |
| `razer-aether-drift` | Razer Aether Drift | three.js | Folded silk-like sheets of indigo, teal and violet. The calmest thing here. |
| `razer-bg-gaming` | Razer BG Gaming | three.js | A retro perspective grid rushing at the camera under a starfield, with a bass strobe. |
| `razer-bg-talking` | Razer BG Talking | three.js | Near-black fog with a slow breathing glow that lifts with your voice. |
| `ink-dissolve-razer` | Ink Dissolve Razer | three.js | Ink blooming into water; the audio drives how fast it spreads. |
| `razer-diagonal-streaks` | Razer Diagonal Streaks | pixi.js | Endless speed lines on a diagonal, in layered depths, surging on the beat. |
| `toxic-marble-dots` | Toxic Marble Dots | pixi.js | A halftone grid of dots following a churning field underneath. |
| `razer-halftone-fade` | Razer Halftone Fade | pixi.js | A halftone gradient, dense at the top, fading to nothing at the bottom. |

**Terminals and glitch** — all five are the same implementation with different defaults, so any one
of them can be turned into any other from its parameters.

| Effect id | Name | Engine | What it draws |
|---|---|---|---|
| `toxic-dev-terminal` | Toxic Dev Terminal | pixi.js | Developer icons churning on a dark grid, centre kept clear for a camera. |
| `toxic-dev-corrupt` | Toxic Dev Corrupt | pixi.js | The same, denser and glitching three times as often. |
| `red-corrupt` | Red Corrupt | pixi.js | A wall of corrupted data in alarm red, with heavy block corruption. |
| `amber-terminal` | Amber Terminal | pixi.js | A calm amber CRT. The quietest of the family. |
| `glitch-terminal` | Glitch Terminal | pixi.js | The plain lime-on-black original, and a good base for your own look. |
| `razer-bg-coding` | Razer BG Coding | pixi.js | Dim icons drifting slowly — tuned to be ignored behind an editor. |

**Glitch and corruption** — every glitch page the old repository had.

| Effect id | Name | Engine | What it draws |
|---|---|---|---|
| `glitch-overlay` | Glitch Overlay | pixi.js | A VHS tape playing badly: scanlines, edge bleed, tearing bands, a sweeping tape head. |
| `glitch-veil` | Glitch Veil | pixi.js | Mostly invisible; short bursts of RGB tearing and static every few seconds. |
| `data-corruption` | Data Corruption | pixi.js | Nothing at all, then one burst of macroblocks or torn scanlines. Digital, not analogue. |
| `glitch-ape` | Glitch Ape | three.js | A gorilla face built from signed distance fields, tearing itself apart. |
| `hologram-glitch` | Hologram Glitch | three.js | A projected hologram that will not hold still — RGB sub-pixel grid and drifting scanlines. |

**Text, logos and scenes**

| Effect id | Name | Engine | What it draws |
|---|---|---|---|
| `star-field` | Star Field | pixi.js | Pastel stars streaming outward into streaks. Flat and radial, unlike the 3D Starfield Warp. |
| `cat-mesh` | Cat Mesh | pixi.js | A cat silhouette as a rippling triangulated mesh. Point it at your own silhouette. |
| `animated-lines` | Animated Lines | pixi.js | A pentagram sigil that draws itself, holds a title, then erases. A starting-soon screen. |
| `starting-soon-fluid` | Starting Soon Fluid | pixi.js | Words in particles suspended in liquid, pushed aside by a drifting cloud. |
| `logo` | Logo | pixi.js | Your logo pulsing to a real ECG heartbeat, with aura, orbiting dots and a LIVE badge. |
| `worxbend-3d-text` | Worxbend 3D Text | three.js | Extruded glossy lettering wobbling like set jelly under orbiting lights. |
| `worxbend-text` | Worxbend Text | pixi.js | A word in particles, pulled apart by comets that attract or repel, with a plexus of lines. |
| `procedural-logo` | Procedural Logo | pixi.js | A generated mark: ink stains with merged outlines, gyro rings and orbiting blobs on a heartbeat. |
| `ember-pentagram-overlay` | Ember Pentagram Overlay | pixi.js | A pentagram in thousands of embers, with waves travelling through the figure. |
| `main-web-cam-border` | Main Web Cam Border | pixi.js | A circular camera frame of eight rippling rings, with sparks and lightning. Audio-reactive. |

**Overlays**

| Effect id | Name | Engine | What it draws |
|---|---|---|---|
| `razer-cam-border-rect` | Razer Cam Border Rect | three.js | A rounded-rectangle camera frame with corner glints. |
| `razer-cam-border-rhombic` | Razer Cam Border Rhombic | three.js | The same idea, diamond-shaped. |
| `razer-cam-border-fluid` | Razer Cam Border Fluid | three.js | A camera frame whose edge ripples like liquid. |
| `razer-audio-cam-border` | Razer Audio Cam Border | three.js | A camera frame that doubles as a level meter. |
| `razer-screen-share-border` | Razer Screen Share Border | three.js | A wide frame sized for a capture window rather than a webcam. |
| `razer-corner-accents` | Razer Corner Accents | pixi.js | Corner brackets, a periodic scan sweep and drifting motes. |
| `razer-status-line` | Razer Status Line | pixi.js | A bottom status bar: live badge, label, level meter, uptime clock. |
| `razer-logo-mark` | Razer Logo Mark | pixi.js | A rotating hexagonal emblem with orbiting motes. |

**Audio visualisers** — eight looks sharing one engine, all driven by the OBS audio connection.

| Effect id | Name | What it draws |
|---|---|---|
| `audio-waveform-razer` | Audio Waveform Razer | Mirrored columns of dots, yellow-to-red above and magenta below. |
| `audio-waveform-razer-prism` | Audio Waveform Prism | Single-sided blue-to-cyan dot columns that flatten in silence. |
| `audio-waveform-razer-spectrum` | Audio Waveform Spectrum | Stacked cells — the closest to a classic bar analyser. |
| `audio-waveform-razer-weave` | Audio Waveform Weave | One glowing zigzag across the frame. The cheapest to draw. |
| `audio-waveform-razer-helix` | Audio Waveform Helix | Four braided sine waves in cyan and magenta. |
| `audio-waveform-razer-ribbons` | Audio Waveform Ribbons | Seven layered organic ribbons with a white core. The richest. |
| `audio-waveform-razer-ribbon-bands` | Audio Waveform Ribbon Bands | Eight broad ribbons stacked into one thick breathing band. |
| `audio-waveform-razer-ribbon-lattice` | Audio Waveform Ribbon Lattice | Thin crossing ribbons with stroked waves threaded through. |

> **A note on the audio visualisers, and on anything here that looks like a spectrum.** OBS reports
> **loudness, not frequencies** — there is no frequency analysis anywhere in the obs-websocket
> protocol. Band heights are shaped from one real loudness value, so the overall movement is real and
> which bar is tallest is not. See [Connecting to OBS audio](#connecting-to-obs-audio).

### Audio-reactive effects

`audio-bars` — and every audio-reactive effect added later — follows **the audio OBS is
broadcasting**, not a microphone. That needs one piece of setup, described in full under
[Connecting to OBS audio](#connecting-to-obs-audio) below. Until it is done, these effects draw a
simulated waveform rather than failing, so nothing is ever blank.

Two things are worth knowing before you build something around this:

- **It is the program audio.** The game, the music bed, your microphone *after* the noise gate and
  the compressor — what the audience hears. That is a completely different signal from what a
  microphone in the room hears, and it is the one you want.
- **OBS reports loudness, not a spectrum.** There is no frequency analysis anywhere in the
  obs-websocket protocol, so a "spectrum" display is shaped from the real loudness rather than
  measured per frequency. The overall movement is real; which bar is tallest is not. Effects that
  want only measured numbers use the level and per-input peaks.

---

## Connecting to OBS audio

Audio-reactive effects need to be told where OBS is. This is done once, in the admin panel.

**1. Switch on the OBS WebSocket server.** In OBS: **Tools → WebSocket Server Settings**. Tick
*Enable WebSocket server*. Note the **Server Port** (4455 unless you changed it), then open **Show
Connect Info** and copy the **Server Password**.

**2. Fill in the form.** Open <http://localhost:3000/admin/settings>, tick *Connect to OBS*, and
enter:

| Field | Value |
|---|---|
| WebSocket URL | `ws://host.docker.internal:4455` |
| Password | the one from Show Connect Info |
| Audio input | leave as *All inputs* to start with |

**Why `host.docker.internal` and not `localhost`.** This is the one thing that catches everybody.
The backend runs inside a Docker container, and inside a container `localhost` means *the container
itself*, so it would never find OBS. `host.docker.internal` is a name Docker resolves to the machine
Docker is running on — your desktop, where OBS is. Docker Desktop provides that name automatically;
on Linux `docker-compose.yml` adds it explicitly.

**3. Press Save and watch the page.** The status line turns green and says **Connected**, with the
OBS version next to it. Underneath, the *Live level* bar moves when sound plays in OBS. If it moves,
the whole path works and every audio-reactive effect will follow it — there is no need to open a
browser source to check.

If it does not connect, the status line says why in words rather than an error code. Pressing **Save
and reconnect** again is the "try again now" button. The three failures worth knowing in advance:

| What it says | What it means |
|---|---|
| *could not connect… is OBS running* | Something answered and said no. The WebSocket server is switched off in OBS, or the port is wrong. |
| *the host name could not be resolved* | The `localhost` trap above — use `host.docker.internal`. |
| *timed out with no response* | Nothing answered at all. Almost always a **host firewall**; see below. |

### If it times out — the firewall trap

This one is worth its own section, because the address you typed is usually correct and everything
you try by hand works.

A **timeout** and a **refusal** are different. A refusal means something answered; a timeout means
your packets vanished, which is what a firewall does when it drops rather than rejects.

The reason it catches people is that the backend connects **from inside a Docker container**, not
from your desktop. A firewall rule that allows port 4455 for the machine itself does not cover the
container, which arrives from Docker's private bridge network (typically `172.x.x.x`) and looks like
a completely different computer. So this happens:

- You test `ws://192.168.1.200:4455` from a WebSocket client on your desktop — **works**.
- The backend tries exactly the same address — **times out**.

On `ufw` (Ubuntu, Debian, and Arch derivatives that use it), open the port to local containers only:

```bash
sudo ufw allow from 172.16.0.0/12 to any port 4455 proto tcp comment 'obs-websocket from docker'
```

`172.16.0.0/12` is the private range Docker allocates its bridge networks from, so this opens the
port to containers on this machine and to nothing on the internet. On `firewalld` the equivalent is
`sudo firewall-cmd --permanent --zone=trusted --add-source=172.16.0.0/12 && sudo firewall-cmd
--reload`.

To confirm the diagnosis before changing any firewall rule, compare these two — the first should
succeed and the second is the one that matters:

```bash
# From your machine:
timeout 5 bash -c 'cat < /dev/null > /dev/tcp/192.168.1.200/4455' && echo OK || echo FAILED

# From inside the backend container, which is what actually connects:
docker compose exec backend sh -c \
  'timeout 5 bash -c "cat < /dev/null > /dev/tcp/192.168.1.200/4455" && echo OK || echo FAILED'
```

One succeeding while the other fails is the firewall, conclusively.

**Where the password goes.** It is stored in MongoDB and used by the backend to authenticate to OBS.
It is never sent back to the admin page and never reaches a browser source — the connection to OBS
is made by the server precisely so the credential does not have to travel to the pages an OBS
browser source loads, which cannot sign in and are therefore public.

**Choosing one input.** Once connected, the *Audio input* box becomes a dropdown listing the audio
inputs OBS has actually reported — `Desktop Audio`, `Mic/Aux` and so on. Pick one to have effects
follow only that source, which is what you want if you would rather your overlays react to the music
than to your voice.

---

## Using it: from empty database to a live OBS source

1. Open <http://localhost:3000/admin>. Opening any page of the app publishes the effect inventory to
   the backend, so the effect dropdown is populated from this moment on.
2. Click **New route**. Give it a slug — lowercase letters, digits and hyphens, for example
   `main-camera`. Pick an effect. Adjust the parameters; each input is generated from the effect's
   own parameter list, so there is no per-effect form to maintain.
3. Save. The route now exists at `http://localhost:3000/e/main-camera`.
4. In OBS: **Sources → + → Browser**. Set the URL to `http://localhost:3000/e/main-camera`, set the
   width and height to your canvas size (1920×1080 is typical), and leave "Shutdown source when not
   visible" unchecked so the effect keeps running.
5. The page's background is fully transparent, so OBS composites the effect over whatever is beneath
   it in your scene.
6. Go back to the admin UI and change a parameter. Within about five seconds the OBS source picks it
   up — no reload, no touching OBS. Toggling a route to **disabled** makes the source draw nothing,
   which is a clean way to switch an overlay off mid-stream.

---

## Adding a new effect

An effect is one TypeScript file plus one line in a list. Nothing in the backend, the admin UI or
the renderer needs to change — they all work from the descriptor you declare.

The step-by-step guide, with a complete worked example and a troubleshooting section, is in
[`docs/AUTHORING_EFFECTS.md`](docs/AUTHORING_EFFECTS.md); the reference for every SDK export is in
[`docs/EFFECT_SDK.md`](docs/EFFECT_SDK.md). What follows is the short version.

### Step 1 — generate the file

```bash
make new-effect ID=solid-color NAME="Solid Color" ENGINE=pixi
```

That writes a complete, running, parameterised effect into
`frontend/src/effects/pixi/solid-color.ts` (or `three/` for `ENGINE=three`) and registers it in
`frontend/src/effects/index.ts`. You then change the picture rather than the plumbing. Writing the
file by hand is fine too; here is the shape it takes.

```ts
import * as PIXI from "pixi.js";
import { colorHex, num } from "../paramUtils";
import { createPixiStage, defineEffect, onFrame } from "../sdk";

export default defineEffect({
  // The descriptor is metadata only. The admin UI builds its form from it, and the backend
  // stores a copy so it can validate the values a route tries to save.
  descriptor: {
    id: "solid-color",                    // unique, ^[a-z0-9][a-z0-9-]{0,63}$
    name: "Solid Color",
    description: "Fills the whole source with one colour.",
    engine: "pixi",                       // "pixi" or "three" — must match what you actually use
    category: "background",               // free-form grouping shown in the picker
    tags: ["simple", "background"],
    previewNotes: "Lower the opacity to tint whatever is underneath it in OBS.",
    params: [
      {
        key: "color",                     // the key used in RouteConfig.params
        label: "Colour",
        kind: "color",                    // number | color | boolean | select | text
        default: "#3355ff",               // must be valid for `kind`
        description: "The fill colour.",
      },
      {
        key: "opacity",
        label: "Opacity",
        kind: "number",
        default: 1,
        min: 0,
        max: 1,
        step: 0.05,
        description: "0 is invisible, 1 is fully solid.",
      },
    ],
  },

  // `setup` runs once per mount. Everything you create is owned by `scope`, which tears it all
  // down in reverse order — so there is no `dispose` method here, and no `disposed` flag.
  async setup({ ctx, scope }) {
    let color = colorHex(ctx.params, "color", "#3355ff");
    let opacity = num(ctx.params, "opacity", 1, 0, 1);

    const stage = await createPixiStage(scope, ctx);
    const rect = stage.stage.addChild(new PIXI.Graphics());

    // The page has ONE animation loop and this subscribes to it, which is what makes the route's
    // frame-rate cap real. Pixi's own ticker is switched off, so nothing reaches the canvas until
    // `stage.render()` is called.
    onFrame(scope, ctx.fpsCap, () => {
      rect.clear();
      rect.rect(0, 0, stage.width, stage.height).fill({ color });
      rect.alpha = opacity;
      stage.render();
    });

    return {
      // Called with the FULL merged parameter set whenever the admin saves a change.
      // Apply the values in place — never rebuild the scene here.
      setParams(p) {
        color = colorHex(p, "color", "#3355ff");
        opacity = num(p, "opacity", 1, 0, 1);
      },
    };
  },
});
```

Three rules that are easy to get wrong:

- `setParams` always receives the **complete** parameter set (descriptor defaults merged with the
  route's saved values), so you never have to handle a missing key — but you must never assume a
  value has the right type. The helpers in `frontend/src/effects/paramUtils.ts` (`num`, `int`,
  `bool`, `str`, `colorHex`, `colorInt`, `rgb01`, `lerp`, `at`) coerce and clamp for you. Every
  value you read in `setup` must be re-read in `setParams`, or the slider silently does nothing.
- Own every GPU object on the `scope` — `scope.ownDisposable(geometry)`, `scope.own(handle, free)`,
  `scope.defer(() => …)`. That is what replaces a hand-written `dispose`, and OBS creates and
  destroys browser sources far more often than you would expect.
- Nothing in `setup` or `setParams` may throw. A thrown error leaves a blank source on a live
  stream.

### Step 2 — register it

The generator already did this. By hand it is two lines in `frontend/src/effects/index.ts`: the
import, and an entry in the `effects` array.

```ts
import solidColor from "./pixi/solid-color";

export const effects: EffectModule[] = [
  // ...the existing entries...
  solidColor,
];
```

That array is the single source of truth for "what can this build draw". The registry indexes it by
`descriptor.id`, the admin UI lists it, and the app publishes it to the backend on the next page
load.

### Step 3 — see it

Vite hot-reloads the change. Reload the admin UI once so the new inventory is published, and the
effect appears in the picker. If you removed an effect instead, note that the publish is a **full
replacement**: the removed effect disappears from the inventory, while routes that pointed at it
stay in the database and show an "effect no longer available" message in the renderer.

If you added a new npm dependency for your effect, install it inside the container:

```bash
make frontend-install
```

### Step 4 — check it before you commit

```bash
make ci-frontend
```

That runs the same install, lint, format check, type check and build that CI will run, in a
throwaway container.

One thing worth knowing if you have seen this project before: effect modules import from `../sdk`
and `../paramUtils` and nothing else. They contain no SolidJS code at all, and an ESLint rule makes
that mechanical — a Solid 2 ref callback is unowned, so a cleanup registered through Solid's
ownership inside one would register nothing and leak, silently. Effects are plain three.js or
pixi.js behind the `mount` / `resize` / `setParams` / `dispose` contract that
`src/components/EffectStage.tsx` drives, so writing one requires knowing nothing about Solid.

---

## Running the tests

The backend has 54 unit tests (MUnit). They do not need a running MongoDB — the repositories are
replaced with in-memory ones — so they are fast and safe to run at any time.

```bash
make backend-test
```

That starts a short-lived container from the backend image and runs Mill's `test` task in it. It
works whether or not the stack is up, and it leaves nothing behind.

To run a single suite while you are iterating:

```bash
docker compose run --rm --no-deps -e MILL_OUTPUT_DIR=/mill-tasks backend \
  mill --no-daemon test.testOnly obseffects.domain.ValidationSuite
```

`test.testOnly` is the task that selects suites by class name. Watch out for the near-identical
`mill test obseffects.domain.ValidationSuite`: that form hands the name to MUnit as a *test-name*
filter rather than a suite selector, so every suite reports "ignored" and **zero tests run** while
the command still exits successfully. The pattern form `mill test 'obseffects.domain.*'` does work,
because the trailing `*` matches the individual test names inside the suite.

The frontend has no unit test suite yet — see [`docs/ROADMAP.md`](docs/ROADMAP.md) item 4.1. Its
safety net today is the TypeScript compiler in strict mode, plus ESLint and Prettier:

```bash
make frontend-typecheck
```

That one does need the stack to be running (`make up`), because it executes inside the frontend
container. `make ci-frontend` is the equivalent that does not.

---

## Linting, formatting and CI

Both halves of the project have a linter and a formatter, and every check below also runs on GitHub
Actions for each push — see [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

| Command | What it checks | Rewrites files? |
|---|---|---|
| `make frontend-lint` | ESLint over the TypeScript/TSX sources | no |
| `make frontend-format-check` | Prettier layout | no |
| `make frontend-format` | Prettier layout | **yes** |
| `make backend-lint` | scalafmt layout **and** the scalafix rules | no |
| `make backend-format` | scalafmt, then the scalafix rules | **yes** |

A warning fails the frontend lint exactly like an error does: the script passes `--max-warnings 0`,
because a warning nobody is obliged to fix is a warning that accumulates.

To run everything CI runs, before pushing:

```bash
make ci-backend     # compile, format check, lint, tests
make ci-frontend    # install, lint, format check, typecheck, build
make ci-compose     # is docker-compose.yml still valid?
```

These three go through Docker, so they need no Java, Node or pnpm on your machine. The workflow
itself installs those toolchains directly onto the throwaway machine GitHub rents out, which is
faster there and is the reason the command lines in the workflow file look slightly different from
these. The checks being run are the same ones.

The frontend lint and format targets run inside the frontend container, whose `node_modules` lives
in a named Docker volume that is not refreshed on its own. If one of them reports that `eslint` or
`prettier` cannot be found, your container is running with a package set from before those tools
were added: run `make frontend-install` once, or use `make ci-frontend`, which installs into a
throwaway container and so never has that problem.

---

## Everyday commands

`make` on its own prints this list from the Makefile.

| Command | What it does |
|---|---|
| `make up` | Build if needed, then start everything in the background |
| `make down` | Stop and remove the containers; the database is kept |
| `make logs` | Follow the live logs of every service |
| `make ps` | Show what is running and on which ports |
| `make rebuild` | Rebuild the images from scratch, ignoring the layer cache |
| `make backend-test` | Run the Scala test suite (MUnit) in a throwaway backend container |
| `make backend-lint` | Check Scala formatting and lint rules; changes nothing |
| `make backend-format` | Rewrite the Scala sources with scalafmt, then apply the scalafix rules |
| `make frontend-install` | Install/refresh npm packages in the frontend container |
| `make frontend-typecheck` | Type-check the frontend with `tsc` |
| `make frontend-lint` | Lint the frontend with ESLint |
| `make frontend-format` | Rewrite the frontend sources with Prettier |
| `make frontend-format-check` | Report what Prettier would rewrite; changes nothing |
| `make ci-backend` | Everything CI runs for the backend: compile, format check, lint, tests |
| `make ci-frontend` | Everything CI runs for the frontend: install, lint, format, typecheck, build |
| `make ci-compose` | Everything CI runs for Docker: is `docker-compose.yml` still valid? |
| `make shell-backend` | Open a shell inside the backend container |
| `make shell-frontend` | Open a shell inside the frontend container |
| `make tools` | Start mongo-express, a web database browser, on port 8081 |
| `make clean` | Stop everything **and delete all volumes** — this erases the database |

The three `ci-*` targets and `make backend-test` / `backend-lint` / `backend-format` use throwaway
containers and work whether or not the stack is up. The rest reach into the running containers and
need `make up` first.

Note that the Scala backend does not hot-reload: after editing a `.scala` file, restart it with
`docker compose restart backend`. The frontend does hot-reload; saving a `.ts`/`.tsx` file is enough.

---

## Versions this project is built on

Nothing here needs installing — the two Dockerfiles pin the runtimes and the two manifests pin the
libraries. The table is for when you want to look something up in the right version's own
documentation.

| | Version | Pinned in |
|---|---|---|
| Scala | 3.8.4 | `backend/build.mill` |
| Java runtime | 21 (Temurin) | `backend/Dockerfile`, `.github/workflows/ci.yml` |
| Mill (the build tool) | 1.1.8 | `backend/.mill-version` |
| Tapir (HTTP endpoints) | 1.13.31, `tapir-netty-server-sync` | `backend/build.mill` |
| Node | 24 (current LTS) | `frontend/Dockerfile`, `Makefile`, `.github/workflows/ci.yml` |
| pnpm | 9.12.3 | the `packageManager` field of `frontend/package.json` |
| SolidJS | 2.0.0-rc.1, with `@solidjs/web` 2.0.0-rc.1 | `frontend/package.json` |
| `@solidjs/router` | 2.0.0-next.17 | `frontend/package.json` |
| Vite | 8.2.2, via `@solidjs/vite-plugin` 3.0.0-next.32 | `frontend/package.json` |
| TypeScript | 6.0.3 | `frontend/package.json` |
| three.js | 0.185.1 | `frontend/package.json` |
| pixi.js | 8.20.0 | `frontend/package.json` |
| ESLint / Prettier | 10.9.0 / 3.9.6 | `frontend/package.json` |
| MongoDB | 8 | `docker-compose.yml` |

Four of the frontend pins are **prereleases** — `solid-js`, `@solidjs/web`, `@solidjs/router` and
`@solidjs/vite-plugin`. Two of those four are worth understanding rather than merely noting.

- **SolidJS 2 is at Release Candidate.** Its API is frozen, but it is not a final release, and no
  2.x version is published under npm's `latest` tag yet. The project is on it deliberately: Solid 2
  changed how reactive ownership and cleanup work, and every screen written against Solid 1 would
  have had to be rewritten later. Doing it while the app is small was the cheaper moment.
- **`@solidjs/router` 2.0.0-next.17 is a step *behind* that**, still on the `next` channel rather
  than an RC. It is the only router release compatible with Solid 2 — the stable 1.0.0 requires
  Solid 1 — and it is what resolves the `/e/:slug` delivery page. Its API can still change before
  2.0 final. This is the one genuinely risky pin in the project and it is tracked in
  [`docs/ROADMAP.md`](docs/ROADMAP.md).

All four prereleases are pinned as **exact** versions with no `^` in front, and
`frontend/pnpm-lock.yaml` is committed. A caret range would let a future install pick up a different
reactive core than the one this code was written and tested against — and these packages publish
often enough for that to be a real risk rather than a theoretical one.

---

## Where things live

```
.
├── docker-compose.yml     mongo + backend + frontend (+ optional mongo-express)
├── .env.example           every tunable port and URL, with comments
├── Makefile               the shortcuts listed above
├── .github/workflows/
│   └── ci.yml             the checks GitHub runs on every push
├── docker/README.md       a longer, beginner-oriented tour of the Docker setup
├── docs/
│   ├── CONTRACT.md        the API and data contract — the source of truth
│   ├── EFFECT_SDK.md      the effect SDK reference — every export and every guarantee
│   ├── AUTHORING_EFFECTS.md  the contributor guide: write an effect, start to finish
│   └── ROADMAP.md         what is built, what is not, and what comes next
├── backend/               Scala 3.8 · Mill · tapir + netty (direct style) · MongoDB
│   ├── build.mill         dependencies, compiler options, lint and format tasks
│   ├── .scalafmt.conf     layout rules for scalafmt
│   ├── .scalafix.conf     lint rules for scalafix
│   └── src/obseffects/
│       ├── domain/        pure model + validation, no framework imports
│       ├── application/   services and repository interfaces
│       └── infrastructure/  http (tapir), mongo, json — the outside world
└── frontend/              SolidJS 2 · Vite 8 · TypeScript 6
    ├── vite.config.ts     dev server on 0.0.0.0:3000, /api proxied to the backend
    ├── eslint.config.mjs  ESLint flat config
    ├── prettier.config.mjs  formatting rules
    └── src/
        ├── types/contract.ts  TypeScript mirror of docs/CONTRACT.md
        ├── api/client.ts      typed fetch wrapper, throws ApiError on non-2xx
        ├── effects/           the effect modules, their SDK types and the registry
        ├── components/        admin shell, parameter form, effect stage
        └── pages/             admin pages + the /e/:slug renderer
```

The backend is layered so that the innermost part (`domain/`) imports nothing from tapir, circe or
MongoDB. That is what makes it testable without a database and replaceable without touching the
business rules.

---

## Documentation

- [`docs/CONTRACT.md`](docs/CONTRACT.md) — every JSON shape, endpoint, error code and validation
  rule. If code and this document disagree, the document wins.
- [`docs/AUTHORING_EFFECTS.md`](docs/AUTHORING_EFFECTS.md) — the contributor guide. Start here to
  write an effect: a complete worked example, the parameter conventions, the definition of done and
  a troubleshooting section for the traps this project has actually hit.
- [`docs/EFFECT_SDK.md`](docs/EFFECT_SDK.md) — the terse SDK reference: the lifecycle contract and
  every export, with what each one promises.
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — an honest account of what is finished, what is known to be
  missing, and the order the rest is planned in. Read this before proposing a change.
- [`docker/README.md`](docker/README.md) — what each container does, what each volume holds, and a
  troubleshooting section.
- [`backend/README.md`](backend/README.md) — the backend's layering, its Mill commands and its
  code-style setup.
- [`frontend/README.md`](frontend/README.md) — the frontend's structure, its npm scripts, its lint
  and format setup, and a guide to what changed in SolidJS 2 for anyone who knew SolidJS 1.
