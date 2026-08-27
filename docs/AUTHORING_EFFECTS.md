# Authoring effects — the contributor guide

**This document is the tutorial.** It is for someone who has written a shader before but has never
seen this repository. It walks one small effect from an empty file to an entry in the admin
dropdown, explains the conventions the parameters follow, states the definition of done every effect
has to meet, and ends with the traps this project has actually hit and how to recognise each one.

**The terse reference is [`EFFECT_SDK.md`](EFFECT_SDK.md).** Once you know the shape of an effect,
that is the document you look things up in: every export, every option, every guarantee. Where the
two overlap, this one explains and that one specifies. Neither contradicts the other, and a change
to the SDK should update both.

You will also want [`CONTRACT.md`](CONTRACT.md) eventually — it is the JSON model the frontend and
the Scala backend share — but you can write your first effect without it.

---

## 1. What you are actually building

The product is a set of animated overlays that a streamer points OBS at. OBS ("Open Broadcaster
Software") is what most people stream with; a **browser source** in OBS is a hidden Chromium that
loads a URL and composites the result into the scene, transparency included.

So: the streamer creates a **route** in this project's admin UI — a slug, an effect, some
parameter values, a canvas size, an optional frame-rate cap. OBS points a browser source at
`/e/<slug>`. That page fetches the route, looks the effect up by id, and mounts it.

Three consequences shape everything below.

1. **It runs for hours.** Not for the thirty seconds a demo runs. A leak that nobody would ever
   notice in a codepen ends a broadcast.
2. **It is live while it is being edited.** The admin's parameter form pushes values to the running
   page as the slider moves. A parameter change that rebuilds the scene is a visible black flash on
   somebody's stream.
3. **It composites.** The background is transparent, and something — a game, a webcam — is behind
   it. An effect that paints an opaque black rectangle is not "dark", it is broken.

The whole SDK exists to make those three things the default rather than something you have to
remember.

---

## 2. Getting the stack running

Everything runs through Docker Compose. Nothing is installed on the host.

```sh
make up            # mongo + backend + frontend (Vite dev server on :3000)
make logs          # follow all three
make down
```

Open `http://localhost:3000`, sign in, and you will find the admin. The **Inventory** page lists
every effect this build knows about; the **Routes** page is where you create one and get a preview
pane beside the parameter form.

The checks you must pass before opening a pull request:

```sh
make ci-frontend   # install, ESLint, Prettier check, tsc, production build
```

and the one that matters most for effects, which needs a real browser:

```sh
# from frontend/ — the supported invocation is Microsoft's Playwright image, which ships Chromium
docker run --rm -u $(id -u):$(id -g) -e HOME=/tmp --add-host backend:127.0.0.1 \
  -v "$PWD:/w" -w /w mcr.microsoft.com/playwright:v1.50.0-jammy \
  sh -c 'mkdir -p /tmp/bin && corepack enable --install-directory /tmp/bin && \
         export PATH=/tmp/bin:$PATH && pnpm install --frozen-lockfile && \
         pnpm build && pnpm verify --both'
```

`pnpm verify` is the regression net (`frontend/tools/verify/`). It drives the real application in
real Chromium and asserts things no compiler can see: that every effect paints non-transparent
pixels, that twenty mount/dispose cycles leave the live WebGL context count flat, that dispose runs
exactly once per cycle, that changing a parameter does **not** replace the canvas, and that every
effect holds a median frame interval inside the budget in `tools/verify/checks/perf.mjs`. Read
`tools/verify/run.mjs` for the flags (`--dev`, `--both`, `--slow`, `--only=<substring>`) — while
working on one effect, `--only=perf` and `--only=effects` are the two you will use most.

Take this seriously: `tsc`, ESLint and `vite build` all read your source without running it, and
every defect described in §7 passes all three.

### Start from a working file, not a blank one

There is a scaffold generator. It writes a complete, running, parameterised effect — not a stub full
of `TODO` — and registers it in `src/effects/index.ts` for you:

```sh
make new-effect ID=aurora-ribbon NAME="Aurora Ribbon" ENGINE=three
# or, with a Node available:  pnpm new:effect aurora-ribbon "Aurora Ribbon" three
```

Two files change and nothing else needs editing. The generated effect passes `pnpm verify` the
moment it is written, so you change the picture rather than the plumbing.

§4 below builds an effect by hand anyway. Read it once: it is the explanation of *what the
generator produced and why*, and you cannot review your own effect without it.

---

## 3. Where things live

```
frontend/src/effects/
  index.ts          the inventory — one array; adding a line here is how an effect ships
  registry.ts       lookup by id, the manifest posted to the backend, mergeParams, rebuildKey
  types.ts          EffectContext / EffectInstance / EffectModule
  paramUtils.ts     num, int, bool, str, colorHex, colorInt, rgb01, lerp, at
  sdk.ts            the barrel every effect imports: `import { ... } from "../sdk"`
  sdk/
    scope.ts        ownership and teardown
    clock.ts        onFrame — the page's single animation loop
    three.ts        createThreeStage
    pixi.ts         createPixiStage
    audio.ts        useAudio — OBS audio levels, shared by the whole page
    video.ts        useVideo — the shared camera
    palette.ts      the palette catalogue and samplers
    glsl/index.ts   the shared GLSL chunks and assembleFragment
    lease.ts        refcounting behind the shared inputs
    defineEffect.ts the adapter from `setup` to the renderer's lifecycle
  three/            effect files using three.js
  pixi/             effect files using pixi.js
```

The effects that ship today are worth reading before you write your own.
`three/plasma-shader.ts` is the shortest shader effect; `pixi/audio-bars.ts` is the shortest
audio-reactive one; `three/camera-frame-ring.ts` is the one that rebuilds geometry live rather than
remounting.

---

## 4. A worked example, from nothing to registered

We are going to write **Pulse Ring**: a soft glowing ring that breathes in and out, sized as a
fraction of the shorter side of the canvas so it stays circular at any aspect ratio, coloured from a
palette, and transparent everywhere except the ring itself. It is a fragment shader on a full-screen
quad — the shape most effects in this project take.

### 4.1 The file, and the two imports

Create `frontend/src/effects/three/pulse-ring.ts`.

```ts
import * as THREE from "three";

import { num } from "../paramUtils";
import {
  assembleFragment,
  createThreeStage,
  defineEffect,
  FULLSCREEN_VERTEX,
  onFrame,
  palette,
  paletteAt01,
  paletteParam,
} from "../sdk";
```

Two import paths and no others. `"../sdk"` is everything the SDK offers; `"../paramUtils"` is the
defensive parameter readers. If you find yourself importing from `"solid-js"`, stop — see §7.1.

### 4.2 The shader

`assembleFragment` takes the names of the GLSL chunks you want and pastes them, plus anything they
depend on, above your body — each exactly once. `sdCircle` is a *signed distance field*: it returns
how far a point is from a circle, negative inside, zero on the edge. `aaStep` turns a distance into
a smooth edge exactly one screen pixel wide, whatever the resolution, which is how you get a crisp
shape with no texture and no jaggies.

```ts
const FRAGMENT_SHADER = assembleFragment(
  ["sdCircle", "aaStep"],
  /* glsl */ `
  varying vec2 vUv;

  uniform float uTime;
  uniform float uRadius;
  uniform float uThickness;
  uniform float uPulse;
  uniform vec3  uInner;
  uniform vec3  uOuter;
  uniform vec2  uResolution;

  void main() {
    // Put the origin in the middle of the canvas and make one unit equal half of the SHORTER
    // side. Dividing by the shorter side is what keeps the ring circular: on a 1920x1080 source
    // the x axis then runs to about 1.78 and the y axis to 1.0, instead of both running to 1.0
    // and squashing the circle into an ellipse.
    vec2 pixels = vUv * uResolution - 0.5 * uResolution;
    vec2 p = pixels / (0.5 * min(uResolution.x, uResolution.y));

    // Breathe. uPulse is a depth, not a switch: at 0 the radius never moves.
    float radius = uRadius * (1.0 + 0.08 * uPulse * sin(uTime * 2.0));

    // Distance to the circle's edge, then to the BAND around it. abs() folds inside and outside
    // together, so subtracting half the thickness gives a value that is negative only within the
    // ring itself.
    float band = abs(sdCircle(p, radius)) - uThickness * 0.5;

    // aaStep(0.0, band) is 1 outside the band and 0 inside it, with one pixel of softness at the
    // boundary. We want the opposite, so subtract it from one.
    float mask = 1.0 - aaStep(0.0, band);

    // Colour across the ring's own width, so the inner edge and the outer edge differ.
    float across = clamp(0.5 + band / max(uThickness, 0.001), 0.0, 1.0);
    vec3 color = mix(uInner, uOuter, across);

    // Alpha is the mask, so everything that is not the ring is fully transparent and OBS
    // composites the game or the webcam through it untouched.
    gl_FragColor = vec4(color, mask);
  }
`,
);
```

Note what is **not** in that body: no `precision highp float;` — `assembleFragment` emits it, and it
has to come first — and no copy of `sdCircle`, which is the whole point of the chunk table.

### 4.3 The descriptor

The descriptor is what the admin UI renders and what gets posted to the backend inventory. Its
`params` array is the reason this project exists: a constant you hard-code is a constant nobody can
tune while their stream is live.

```ts
export default defineEffect({
  descriptor: {
    id: "pulse-ring",
    name: "Pulse Ring",
    description:
      "A soft glowing ring that breathes in and out, drawn as a signed-distance field so its edges stay crisp at any resolution.",
    engine: "three",
    category: "overlay",
    tags: ["shader", "sdf", "camera", "overlay", "three"],
    previewNotes:
      "Built to sit around a circular webcam mask: set Radius so the ring hugs the crop, then lower Pulse Depth to 0 for a static frame. Everything outside the ring is transparent, so it layers over Plasma Shader or a game capture without dimming them.",
    params: [
      {
        key: "radius",
        label: "Radius",
        kind: "number",
        default: 0.6,
        min: 0.1,
        max: 1.2,
        step: 0.01,
        description:
          "Ring radius as a fraction of half the shorter side. 1.0 touches the top and bottom edges.",
      },
      {
        key: "thickness",
        label: "Thickness",
        kind: "number",
        default: 0.06,
        min: 0.005,
        max: 0.4,
        step: 0.005,
        description: "Width of the ring, in the same units as Radius.",
      },
      {
        key: "pulseDepth",
        label: "Pulse Depth",
        kind: "number",
        default: 1,
        min: 0,
        max: 3,
        step: 0.05,
        description: "How far the radius breathes. 0 freezes the ring at its Radius.",
      },
      {
        key: "speed",
        label: "Speed",
        kind: "number",
        default: 1,
        min: 0,
        max: 4,
        step: 0.05,
        description: "Multiplier on the breathing rate. 0 stops it entirely.",
      },
      paletteParam(
        "palette",
        "Palette",
        "neon-dusk",
        "Colour ramp across the ring's width, from its inner edge to its outer edge.",
      ),
    ],
  },
```

`paletteParam` returns an ordinary `kind: "select"` spec whose options are the palette ids, so the
admin form, the backend validator and the Inventory page all handle it with no special case.

`previewNotes` is not decoration. The definition of done in §6 requires a written note on what the
effect is for and what it composes well with, and this field is where it goes — the Inventory page
renders it. Six months later it is the only thing that tells anyone what `plasma-shader` looked
like.

### 4.4 `setup` — build it once

```ts
  setup({ ctx, scope }) {
    // Values we need to keep reading after setup returns. Everything else goes straight into a
    // uniform, and a uniform IS the stored copy.
    let speed = num(ctx.params, "speed", 1, 0, 4);

    // Antialiasing off: a full-screen quad has no polygon edges to smooth, so multisampling costs
    // fill rate and buys nothing. The shader's own aaStep does the smoothing that matters.
    const stage = createThreeStage(scope, ctx, {
      antialias: false,
      camera: { kind: "fullscreen-quad" },
    });

    const ramp = palette(ctx.params, "palette", "neon-dusk");
    const [ir, ig, ib] = paletteAt01(ramp, 0.25);
    const [or_, og, ob] = paletteAt01(ramp, 0.95);

    const uniforms = {
      uTime: { value: 0 },
      uRadius: { value: num(ctx.params, "radius", 0.6, 0.1, 1.2) },
      uThickness: { value: num(ctx.params, "thickness", 0.06, 0.005, 0.4) },
      uPulse: { value: num(ctx.params, "pulseDepth", 1, 0, 3) },
      uInner: { value: new THREE.Vector3(ir, ig, ib) },
      uOuter: { value: new THREE.Vector3(or_, og, ob) },
      uResolution: { value: new THREE.Vector2(stage.width, stage.height) },
    };

    // Own each GPU object the moment it exists. The scope tears them down in reverse order of
    // construction — material, then geometry, then the renderer, which createThreeStage
    // registered before either of them. You write no dispose method at all.
    const geometry = scope.ownDisposable(new THREE.PlaneGeometry(2, 2));
    const material = scope.ownDisposable(
      new THREE.ShaderMaterial({
        vertexShader: FULLSCREEN_VERTEX,
        fragmentShader: FRAGMENT_SHADER,
        uniforms,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    );

    const quad = new THREE.Mesh(geometry, material);
    // The quad is always directly in front of the camera; skipping the culling test stops three.js
    // from deciding it is off-screen and drawing nothing.
    quad.frustumCulled = false;
    stage.scene.add(quad);

    // The one line that depends on the canvas size. The stage has already resized the renderer and
    // reprojected the camera by the time this runs, which is why this effect needs no `resize`
    // method of its own.
    stage.onResize((w, h) => uniforms.uResolution.value.set(w, h));

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      // Accumulate our own clock rather than reading the wall clock, so that changing Speed
      // changes the rate from here on instead of making the animation jump to a new phase.
      uniforms.uTime.value += dt * speed;
      stage.render();
    });
```

Four things are worth naming, because they are the ones people get wrong.

- **`onFrame`, never `requestAnimationFrame`.** One `requestAnimationFrame` drives the entire page.
  Passing `ctx.fpsCap` straight through is what makes the route's frame cap real; an effect that
  starts its own loop silently ignores it.
- **`dt` is seconds since *your* previous frame**, clamped to 0.1 so a tab that was backgrounded for
  a minute does not teleport the animation. Multiply every per-frame movement by it and the effect
  looks the same on a 60 Hz display, a 144 Hz display, and a route capped at 30.
- **`stage.render()` at the end.** Nothing reaches the canvas without it. This is true for Pixi too,
  where the engine's own ticker is deliberately switched off.
- **You never wrote `dispose`.** Everything registered on the scope is released in reverse order,
  each teardown inside its own `try`/`catch`, exactly once.

### 4.5 `setParams` — the half that is easy to get wrong

```ts
    return {
      setParams(p) {
        speed = num(p, "speed", 1, 0, 4);
        uniforms.uRadius.value = num(p, "radius", 0.6, 0.1, 1.2);
        uniforms.uThickness.value = num(p, "thickness", 0.06, 0.005, 0.4);
        uniforms.uPulse.value = num(p, "pulseDepth", 1, 0, 3);

        const next = palette(p, "palette", "neon-dusk");
        const [nir, nig, nib] = paletteAt01(next, 0.25);
        const [nor, nog, nob] = paletteAt01(next, 0.95);
        uniforms.uInner.value.set(nir, nig, nib);
        uniforms.uOuter.value.set(nor, nog, nob);
      },
    };
  },
});
```

`setParams` receives the **complete** merged parameter set — descriptor defaults with the route's
stored values on top — so there is never an `undefined` to handle and never a previous value to
remember. It is called with unchanged values often; that must be harmless. It must never throw,
which is what every `paramUtils` reader is for: a hand-edited route could hold a string where a
number belongs, and a throw here kills the animation layer of a live stream.

**Now compare the two functions line by line.** Every value `setup` read, `setParams` re-reads. That
duplication is the price of not having a declarative parameter layer (`EFFECT_SDK.md` §14 records
why there isn't one), and the forgotten line is the single most common defect in this codebase.
Nothing catches it — not `tsc`, not ESLint, not the harness. The symptom is a slider that silently
does nothing.

### 4.6 Register it

`frontend/src/effects/index.ts` holds one array, and that array is the single source of truth for
"which effects does this build know how to draw". Add three lines — an import, an entry, a
re-export:

```ts
import pulseRing from "./three/pulse-ring";

export const effects: EffectModule[] = [
  // ...the existing entries...
  pulseRing,
];

export { /* ...the existing names..., */ pulseRing };
```

(The generator in §2 writes exactly these three lines for you.)

That is the whole registration. On the next page load the frontend posts every descriptor to
`POST /api/effects/sync`, the backend replaces its stored inventory, and "Pulse Ring" appears in the
admin dropdown. Nothing else needs editing — no renderer change, no admin change, no Scala.

Because the sync is a full replacement, removing a line here removes the effect from the admin too.
Routes that referenced it are not deleted; the renderer reports that this build cannot draw them.

### 4.7 Look at it

Create a route in the admin, pick Pulse Ring, and drag the sliders with the preview pane open. Then
open `/e/<slug>` directly, which is what OBS will load, and check it against a coloured page
background — the transparency is not visible against the admin's own dark panel.

Finally run `pnpm verify` (§2). If your effect draws nothing, or leaks a context, this is where you
find out.

---

## 5. A Pixi effect, and the one difference that matters

`createPixiStage` is asynchronous, because Pixi v8's `Application.init` is. That makes `setup`
`async`, and it introduces the one rule you have to hold in your head:

```ts
  async setup({ ctx, scope }) {
    const bus = await useAudio(scope);
    scope.checkpoint();               // useAudio does NOT do this for you — see below
    const stage = await createPixiStage(scope, ctx);
    const graphics = stage.stage.addChild(new PIXI.Graphics());

    onFrame(scope, ctx.fpsCap, ({ dt, now }) => {
      bus.sample(now);
      // ...redraw graphics...
      stage.render();   // Pixi's own ticker is off. Nothing draws without this line.
    });

    return { setParams(p) { /* ... */ } };
  },
```

**Put `scope.checkpoint()` immediately after every `await`.** It throws `Cancelled` if the effect was
disposed while you were waiting, and `defineEffect` swallows exactly that one error and lets the
scope tear down whatever you had built.

**The SDK helpers are not consistent about this, and the difference has already caused one bug.**
`createPixiStage` checkpoints internally. `useAudio` and `useVideo` do **not** — they resolve
normally on a dead scope, having released the lease they registered, which is why the explicit
checkpoint is on the line after `useAudio` above and is not decoration. Without it, an effect
disposed while that promise was in flight would carry on to build an entire Pixi application, and
therefore a whole WebGL context, before anything stopped it.

The rule that is always safe: checkpoint after every `await`, yours or the SDK's. A redundant one
costs nothing.

The failure it prevents is real: the renderer can dispose an effect while `init` is still in flight,
and without the checkpoint discipline you get a second canvas appended to a host div that already
has one, plus a Pixi application nobody will ever destroy. `scope.attach` refuses to append to a
disposed scope, which is the structural half of the same defence.

`mount` still returns synchronously — `defineEffect` hands the renderer a pending instance that
records the last `resize` and `setParams` and replays them when your setup resolves. That is the
`ready` flag every Pixi effect used to carry by hand.

---

## 6. Definition of done

An effect is not finished until all of the following are true. This is roadmap item 3.2's bar and it
applies to every effect in the inventory.

**Parameters.** Its constants are exposed as a `ParamSpec[]` with sensible ranges and defaults.
"Sensible" means: the default alone looks good with no tuning; every value in `[min, max]` produces
something that is not broken (a `min` of 0 that renders a black screen is a bad `min`); `step` is
fine enough to tune with and coarse enough to drag; and every `description` says what the knob does
in the streamer's language, not the shader's. **An effect with two parameters deserves a second
look** — the whole reason this platform exists is that its overlays are tunable without editing
code.

**Teardown.** `dispose` fully releases GPU resources and passes the leak test. Using `defineEffect`
and owning everything on the `Scope` gets you there; the proof is `pnpm verify`, which mounts and
disposes each effect twenty times and asserts the live WebGL context count is flat afterwards and
that dispose ran exactly once per cycle.

**Rendering.** It renders correctly at 1920×1080 over a **transparent** background, and holds its
target frame rate on a mid-range GPU while a game is also running. Check the transparency against a
light page background, not only a dark one. Check the frame rate by watching
`window.__sdkDebug.subscribers()` in a development build: each subscriber reports its own `frames`
count and `fpsCap`.

**A written note.** `previewNotes` says what the effect is for and what it composes well with, and
the Inventory page surfaces it. Write it for the streamer choosing from a dropdown six months from
now, not for the reviewer reading the diff today.

**And the rules that keep it live:**

- [ ] `descriptor.id` is unique, lowercase-kebab, and matches `^[a-z0-9][a-z0-9-]{0,63}$`.
- [ ] Every `ParamSpec.default` is valid for its own `kind` (a `select` default is one of its
      `options`).
- [ ] Exactly one canvas is appended, to `ctx.canvasHost` only — which `createThreeStage` /
      `createPixiStage` handle for you.
- [ ] **Every value read in `setup` is re-read in `setParams`, or its `ParamSpec` declares
      `rebuild: true`.** See §4.5.
- [ ] `setParams` never throws on a bad value and never rebuilds the renderer or the canvas.
- [ ] Every `await` in an async `setup` is followed by `scope.checkpoint()`.
- [ ] The animation loop is `onFrame(scope, ctx.fpsCap, …)`, and a Pixi effect calls
      `stage.render()` from it.
- [ ] Nothing under `src/effects/**` imports `onCleanup`, `getOwner`, `onSettled`, `createEffect` or
      `createSignal` from `solid-js`.
- [ ] `make ci-frontend` is green, and `pnpm verify` is green.

---

## 7. Troubleshooting: the four traps this project has actually hit

### 7.1 "My cleanup never runs" — the Solid 2 unowned ref callback

**Symptom.** A listener, a timer or a texture is never released. Nothing throws. Contexts pile up
over hours until every browser source on the machine stops rendering, with at most a
`Too many active WebGL contexts` warning to explain it.

**Cause.** The frontend is SolidJS 2. In Solid 2 a **ref callback is unowned**: inside one,
`getOwner()` returns `null` and `onCleanup()` registers nothing at all. It does not throw and it
does not warn — the cleanup simply never runs. An SDK helper that tried to clean up through Solid's
reactive ownership would therefore leak silently, in production, on a machine you cannot inspect.

**Rule.** No file under `src/effects/**` may import `onCleanup`, `getOwner`, `onSettled`,
`createEffect` or `createSignal` from `solid-js`. `eslint.config.mjs` fails the build if one does —
this is the one defect class in this area a linter genuinely catches, which is exactly why the rule
exists rather than living in someone's memory.

**What to do instead.** Own the resource on your `Scope`:

```ts
scope.defer(() => window.removeEventListener("resize", onWindowResize));
const timer = scope.own(setInterval(tick, 1000), (t) => clearInterval(t));
const texture = scope.ownDisposable(new THREE.DataTexture(/* ... */));
```

`src/components/EffectStage.tsx` drives disposal and is the only place that does. In the component
layer — which is not effect code — cleanup for anything attached via a ref belongs in `onSettled` in
the component body, and that file's `INVARIANT` comment blocks explain the two hazards it navigates.

### 7.2 "Dispose ran twice"

**Symptom.** Either an exception on the second teardown (`Cannot read properties of null`), or the
quieter version: the renderer's `instance` pointer left aiming at a torn-down effect, and a black
OBS source after an ordinary parameter save, with nothing in the console.

**Cause, historically.** Somebody added a "defensive" second teardown — a `teardown()` call at the
top of the mount effect's `apply`, or an `onCleanup(...)` in the component body "to be safe".
`EffectStage` already disposes by returning the disposal from `apply`, and Solid pairs each `apply`
run with exactly one run of the cleanup it returned. Adding a second path makes disposal run two or
three times per swap.

**Rule.** Disposal happens in exactly one place: the cleanup value returned from `apply` in
`EffectStage.tsx`. Do not add another. That file says so in an `INVARIANT` block; read it before
editing it.

**On your side**, `dispose` must still be idempotent, and with `defineEffect` it is for free —
`Scope.dispose()` sets `disposed` before draining and a second call is a no-op. You do not write a
`disposed` flag, and you do not need a guard at the top of `setParams` or `resize`: `defineEffect`
returns early when the scope is dead. If you find yourself writing either, you have probably stopped
using the SDK somewhere.

**How to prove it.** `pnpm verify` counts `loseContext()` calls against mount/dispose cycles and
fails if any context is lost twice. That assertion is only meaningful because `forceContextLoss()`
has exactly one caller in the codebase, inside `createThreeStage`. Do not add a second one.

### 7.3 "It mounts, and paints zero pixels"

**Symptom.** No error anywhere. A canvas exists, has the right size, and every pixel is transparent.
`pnpm verify`'s `effects-draw` check fails, or worse, the streamer finds it.

Work down this list; the causes are ordered by how often they turn out to be the answer.

1. **You never called `render()`.** Both stages are explicit. `stage.render()` at the end of your
   `onFrame` callback is what puts pixels on the canvas. For Pixi this catches people out because
   the engine normally renders itself — `createPixiStage` sets `app.ticker.autoStart = false` and
   stops the ticker on purpose, so that the project has one animation loop rather than two.
2. **You never called `onFrame`.** No subscription, no frames. Check
   `window.__sdkDebug.clock().subscribers` in a development build.
3. **`fpsCap` is being ignored or misread.** `window.__sdkDebug.subscribers()` reports each
   subscriber's `frames` and `fpsCap`; if `frames` is climbing, the loop is running and the problem
   is downstream.
4. **Your `setup` threw, or was cancelled.** A real throw is logged as
   `[sdk] Effect "<id>" threw while setting up.` A `Cancelled` is swallowed deliberately and logs
   nothing, because being replaced mid-setup is ordinary — but if the effect is being *disposed*
   immediately after mounting for some other reason, you will see nothing at all. Check that the
   route is enabled and that its `effectId` matches.
5. **Alpha is zero everywhere.** Transparency is required, but `gl_FragColor.a` driven by a mask
   that is always 0, or a Pixi object with `alpha = 0`, is indistinguishable from a broken effect.
   Temporarily force `gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0)` and confirm you get a magenta screen;
   if you do, the geometry and the loop are fine and the bug is in your maths.
6. **A three.js mesh got frustum-culled.** A full-screen quad written directly in clip space has a
   bounding box three.js cannot reason about, so it may decide the mesh is off-screen. Set
   `mesh.frustumCulled = false`.
7. **You drew outside the canvas.** For `{ kind: "orthographic-pixels" }` the origin is the *centre*
   and +Y is up, so `(0, 0)` is the middle of the source and the top-left corner is
   `(-width / 2, height / 2)`. Placing something at `(0, 0)` expecting the top-left puts a quarter of
   it on screen at best.
8. **The stage is inert because the scope was already dead.** If an async `setup` resolved after a
   remount, `createThreeStage` does not attach its canvas — by design — and drawing into it paints
   into no document. That is correct behaviour, and it means the *outgoing* instance is the one you
   are looking at. Check whether a `rebuild: true` parameter is churning (§7.4).

### 7.4 "A parameter change remounted the effect"

**Symptom.** A black flash on air when a slider moves, or a run of
`Too many active WebGL contexts` warnings while dragging one, or `pnpm verify`'s
`params-vs-remount` check failing because the canvas element's identity changed.

**How the renderer separates the two paths.** `EffectStage.tsx` has two `createEffect`s. The mount
effect's `compute` reads only the host element and `props.module` — it never reads `props.params`,
so an ordinary parameter change *cannot* reach it. The parameter effect reads `props.params` in its
`compute`, which is what subscribes it, and calls `setParams` on the running instance. Under Solid 1
that separation was a convention a careless edit could break; here it is structural, and it is
guarded by `INVARIANT` comments that explain why.

**So there are exactly three ways to cause a remount.**

1. **You declared `rebuild: true`** on the parameter. That is the flag's entire job: the renderer
   disposes and remounts instead of calling `setParams`. `rebuildKey()` in `registry.ts` builds a
   string from the values of `rebuild: true` parameters and nothing else, and the mount effect's
   `compute` returns a cached `{ module, token }` pair so an unchanged token cannot re-run it.
   Changes are debounced by `REBUILD_DEBOUNCE_MS = 150`, because the admin preview receives a value
   on every input event and an undebounced slider would take a fresh WebGL context per event.
2. **The route's `effectId` changed**, or the route was disabled. Not a parameter change at all.
3. **You rebuilt the world inside your own `setParams`.** The canvas survives, so the harness will
   not catch this one, but on air it is the same black flash. Update the uniform, the tint, the
   speed. If something expensive genuinely depends on the value, rebuild **only that object** and
   keep the renderer and the canvas alive — `camera-frame-ring` swaps geometry that way,
   `audio-bars` resamples its bar heights into a new array so the shape morphs instead of collapsing
   for a frame, and `starfield-warp` and `digital-rain` resize their buffers in place.

**Should you use `rebuild: true`?** Almost certainly not. No effect in this build declares it, and
the three that look like obvious candidates deliberately do not. Reach for it only
when a value is baked into a fixed-size GPU buffer or a compiled shader constant and there is
genuinely no in-place path. A remount is a black frame on somebody's broadcast; that is the price
you are choosing to pay.

One ordering note, if you do use it: a `rebuild` remount keeps the same module, so the parameter
effect's `mountedModule !== next.module` guard does not fire and `setParams` runs once against the
*outgoing* instance moments before it is disposed. That is harmless — it is a `setParams` on a live
effect about to be replaced by one mounted with those very values — but it is written down here and
in `EffectStage.tsx` because the last time an ordering assumption in that file went unwritten, it
cost a real bug.

---

## 8. Things that are deliberately missing

Being honest about the edges, so you do not go looking for them:

- **There is no shader playground yet** — no route that hot-reloads GLSL against real parameter
  controls. It is roadmap item 3.3, alongside the scaffold generator that does now exist. Until it
  lands, the edit/reload loop is the Vite dev server and the admin preview pane.
- **There are no thumbnails in the Inventory page yet**, so `previewNotes` is doing the whole job of
  telling a streamer what an effect looks like. Write it accordingly.
- **The frame clock does not pause when the page is hidden**, on purpose: an OBS browser source in
  an inactive scene is not reliably "hidden", and a frozen source is a visible on-air failure. This
  policy has not yet been measured against a real OBS source over a long session.
- **Shared inputs linger for two seconds** after their last consumer lets go, so that a route change
  does not close and reopen the stream. During that window the resource is open with nobody
  listening and the browser's recording indicator stays lit. `pagehide` bypasses it.
- **Palette mixing is linear sRGB**, not Oklab. Changing it would change how existing effects look,
  which a refactor does not get to do.
- **Palette ids are append-only.** A route stores the id; renaming or removing one silently changes
  what is on air, with no error anywhere.
