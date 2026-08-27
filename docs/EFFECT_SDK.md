# Effect SDK — the reference

**This document is the terse reference.** It states the contract the renderer and every effect
module hold each other to, and lists what the SDK exports and what each export promises. It is
written to be looked things up in, not read front to back.

**If you are writing your first effect, read [`AUTHORING_EFFECTS.md`](AUTHORING_EFFECTS.md)
instead.** That is the tutorial: it walks one small effect from an empty file to a registered entry
in the admin dropdown, explains the parameter conventions, states the definition of done, and
carries the troubleshooting section for the traps this project has actually hit. The two documents
are meant to be used together and must not contradict each other — where they overlap, the
tutorial explains and this one specifies.

Read [`CONTRACT.md`](CONTRACT.md) first if you have not: this document assumes you know what an
`EffectDescriptor` and a `ParamSpec` are, because those are the same JSON model the backend stores.

---

## 1. What an effect is

An **effect** is a single TypeScript module under `frontend/src/effects/three/` or
`frontend/src/effects/pixi/` that knows how to draw something with
[three.js](https://threejs.org/) or [pixi.js](https://pixijs.com/). The renderer page (`/e/:slug`)
knows nothing about any particular effect: it only knows the interface below. That is what lets you
add a new effect by dropping in one file, without touching the renderer, the admin UI, or the
backend.

Since Phase 3.1 an effect does not *implement* that interface by hand. It calls `defineEffect`,
which implements it, and supplies a `setup` function instead. Both halves are documented here: §2 is
what the renderer sees, §4 onwards is what an author writes.

---

## 2. The lifecycle interfaces

These live in `frontend/src/effects/types.ts` and are re-exported from
`frontend/src/effects/sdk.ts`, which is the single import path effects use.

```ts
/** Everything an effect is handed when it is mounted. */
export interface EffectContext {
  /** The empty <div> the effect owns. It must append its canvas here and nowhere else. */
  canvasHost: HTMLDivElement;
  /** Current size of canvasHost, in CSS pixels. */
  width: number;
  height: number;
  /** Descriptor defaults already merged with the route's stored values. Never partial. */
  params: Record<string, unknown>;
  /** The route's frame-rate cap, or null for uncapped. Enforced — see §6. */
  fpsCap: number | null;
}

/** The handle the renderer keeps after mounting an effect. */
export interface EffectInstance {
  /** Called whenever canvasHost changes size. Must resize renderer, canvas and camera. */
  resize(w: number, h: number): void;
  /** Called when the admin changes parameters. Always receives the FULL merged parameter set. */
  setParams(p: Record<string, unknown>): void;
  /** Called when the effect is torn down. Must release every GPU and timer resource. */
  dispose(): void;
}

/** What each effect module default-exports. */
export interface EffectModule {
  descriptor: EffectDescriptor;
  mount(ctx: EffectContext): EffectInstance;
}
```

`ParamSpec` and `EffectDescriptor` come from `frontend/src/types/contract.ts` and are shared with
the backend. `ParamSpec` has one frontend-only field, `rebuild?: boolean` — see §9.

---

## 3. Lifecycle phases

The renderer (`frontend/src/components/EffectStage.tsx`) drives an effect through exactly four
phases.

**1. Discovery (build time).** Every module listed in `frontend/src/effects/index.ts` is collected
into a registry keyed by `descriptor.id`. At app startup the frontend `POST`s all descriptors to
`/api/effects/sync` so the admin UI can offer them. Because the sync is a full replacement, an
effect removed from that list disappears from the admin UI too.

**2. Mount.** The renderer creates an empty `<div>`, works out its size, merges parameters, and
calls `mount(ctx)`. On the delivery page the size comes from the route's `canvas` settings; in the
admin preview it is measured from the element. `mount` is called at most once per instance and must
return **synchronously**. To restart an effect the renderer disposes the old instance and mounts a
fresh one.

**3. Running.** The renderer may call:

- `resize(w, h)` — with the **canvas size**, whenever the route's canvas settings change. Since
  Phase 2 the delivery page draws at the route's own render resolution (`RouteConfig.canvas`) and
  then scales that whole block with CSS to fit the OBS browser source, so dragging the source no
  longer resizes the effect — it scales the pixels the effect already drew. The admin's preview
  pane has no fixed resolution and still calls `resize` from a `ResizeObserver` as the browser
  window changes, which can be many times per second: the call must be cheap and must return early
  when the size has not actually changed.
- `setParams(p)` — whenever the route's `updatedAt` changes.

Both may be called in any order, any number of times, and possibly before the first frame is drawn.
`defineEffect` absorbs all of that: calls that arrive before an asynchronous `setup` has resolved
are recorded and replayed once it does.

**4. Dispose.** Called when the viewer navigates away, the route's `effectId` changes, the route
becomes disabled, or a `rebuild: true` parameter changes. After `dispose()` returns, the renderer
never calls the instance again, and it empties `canvasHost` itself.

**The renderer disposes exactly once per mount**, because disposal is the cleanup value returned
from its `createEffect` `apply` and is done nowhere else. `dispose()` must nonetheless be idempotent
— `Scope.dispose()` is, so an effect built on the SDK gets that for free.

---

## 4. The shape of an effect file

```ts
import * as THREE from "three";
import { num } from "../paramUtils";
import { createThreeStage, defineEffect, onFrame } from "../sdk";

export default defineEffect({
  descriptor: { id: "my-effect", /* ... */ params: [/* ... */] },

  setup({ ctx, scope }) {
    const stage = createThreeStage(scope, ctx, { camera: { kind: "perspective", fov: 70 } });
    const geometry = scope.ownDisposable(new THREE.SphereGeometry(1));
    const material = scope.ownDisposable(new THREE.MeshBasicMaterial({ color: 0xffffff }));
    stage.scene.add(new THREE.Mesh(geometry, material));

    let speed = num(ctx.params, "speed", 1, 0, 5);
    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      stage.scene.rotation.y += dt * speed;
      stage.render();
    });

    return {
      setParams(p) {
        speed = num(p, "speed", 1, 0, 5);
      },
    };
  },
});
```

Everything is imported from `frontend/src/effects/sdk.ts` (`"../sdk"`), which is one barrel over the
modules in `frontend/src/effects/sdk/`. Parameter *readers* — `num`, `int`, `bool`, `str`,
`colorHex`, `colorInt`, `rgb01`, `lerp`, `at` — live in `frontend/src/effects/paramUtils.ts` and are
imported from there.

### `defineEffect(definition): EffectModule`

`definition.descriptor` is the metadata. `definition.setup({ ctx, scope })` returns an
`EffectHandle`, synchronously or as a promise:

```ts
export interface EffectHandle {
  /** Optional. Every stage on the scope is resized for you; implement this only for something
   *  size-dependent that is not inside a stage. */
  resize?(w: number, h: number): void;
  /** Required. Always receives the full merged parameter set. Must never throw. */
  setParams(p: Record<string, unknown>): void;
}
```

`defineEffect` provides: a synchronous `mount` over an asynchronous `setup`, replay of the last
`resize` and `setParams` that arrived before `setup` resolved, an idempotent `dispose` that disposes
the scope, and silent swallowing of `Cancelled` (and only `Cancelled`; any other thrown error is
logged with the effect's id).

---

## 5. `Scope` — ownership and teardown

`frontend/src/effects/sdk/scope.ts`. An effect never writes a `dispose` method.

| member | meaning |
|---|---|
| `label` | Short name used in log messages — the descriptor id. |
| `disposed` | Synchronously readable. |
| `defer(teardown)` | Registers a bare thunk. On an already-disposed scope it runs **immediately**. |
| `own(value, teardown)` | Registers `teardown(value)` and returns `value`. |
| `ownDisposable(resource)` | Shorthand for anything with a `.dispose()` method. Returns it. |
| `attach(host, canvas)` | Appends and registers removal. Returns `false` and appends nothing when the scope is already disposed. |
| `checkpoint()` | Throws `Cancelled` when disposed. Call after **every** `await`. |
| `child()` | A nested scope torn down with its parent; the escape hatch when LIFO is the wrong order. |

`createScope(label): OwnedScope` adds `dispose()`. Effects never call it — `defineEffect` does.

**Teardowns run in reverse registration order (LIFO), each inside its own `try`/`catch`, exactly
once.** Registration order is construction order, and a thing constructed later may depend on one
constructed earlier but never the other way round, so reverse registration order is correct
destruction order for free. `dispose()` sets `disposed` *before* draining, so a teardown that
triggers a callback sees a dead scope.

---

## 6. `onFrame` — the shared clock

`frontend/src/effects/sdk/clock.ts`.

```ts
onFrame(scope, fpsCap, (frame: FrameInfo) => void): FrameSubscription
clockStats(): { subscribers: number; driver: "raf" | "timeout" | "idle"; framesDrawn: number }
```

One `requestAnimationFrame` drives every subscriber on the page. `FrameInfo` carries:

- `dt` — seconds since **this subscriber's** previous frame, clamped to `0.1`, and `0` on its first
  frame. Multiply per-frame movement by it.
- `elapsed` — the sum of this subscriber's own clamped deltas, starting at `0`. Independent of every
  other subscriber and of how long the page has been open, and it never jumps.
- `now` — `performance.now()` for the tick, the same value for every subscriber in it. Use it where
  several things must agree on "now", such as `bus.sample(now)`.

Rules and behaviour:

- Passing `ctx.fpsCap` through is what makes the route's frame cap real. A cap outside 1..240, or a
  non-finite value, means uncapped. Capping skips ticks; it never uses `setTimeout` to pace frames.
- A `draw` that throws is logged once with the scope's label and then **unsubscribed**, so one
  broken effect cannot stop the others or bury the console.
- The clock does **not** pause on `document.hidden`. An OBS browser source in an inactive scene is
  not reliably "hidden", and a frozen source is a visible on-air failure. `visibilitychange` resets
  the timing so the first frame back is not a jump, and a watchdog pumps with `setTimeout` if
  `requestAnimationFrame` goes silent for two seconds — degrading the frame rate rather than
  freezing the stream. **This policy has not yet been measured against a real OBS source in an
  inactive scene.**
- Never call `requestAnimationFrame` yourself and never use Pixi's ticker.

---

## 7. Stages

### `createThreeStage(scope, ctx, options): ThreeStage`

`frontend/src/effects/sdk/three.ts`. Synchronous. Builds the renderer
(`alpha: true`, clear colour `0x000000` at alpha 0, pixel ratio capped at 2), the scene and the
camera, attaches the canvas through `scope.attach`, and registers the whole teardown —
`renderer.dispose()`, `renderer.forceContextLoss()`, canvas removal — as **one** thunk.

> `forceContextLoss()` is called from this one place in the codebase and nowhere else. The
> verification harness proves "disposed exactly once per mount" by counting `loseContext()` calls
> against mount/dispose cycles, which is only meaningful while there is a single caller.

`options.antialias` defaults to `true`; turn it off for a full-screen shader quad, which has no
polygon edges to smooth. `options.camera` is one of:

| `kind` | what you get |
|---|---|
| `{ kind: "perspective", fov, near?, far? }` | A normal 3D camera at the origin looking down −Z, aspect kept in step with the canvas. Raise `far` past your spawn distance or distant objects pop into existence. |
| `{ kind: "orthographic-pixels" }` | One world unit per CSS pixel, origin centred, +Y up. What a 2D overlay wants. |
| `{ kind: "fullscreen-quad" }` | The unit clip-space formality a screen-quad shader needs; never distorts. |

`ThreeStage` exposes `renderer`, `scene`, `camera` (typed as the base `THREE.Camera` — cast it and
call `updateProjectionMatrix()` yourself when you change a `fov`), `width`, `height`,
`resize(w, h)`, `onResize(fn)` and `render()`.

### `createPixiStage(scope, ctx, options?): Promise<PixiStage>`

`frontend/src/effects/sdk/pixi.ts`. Awaits `app.init({ width, height, backgroundAlpha: 0,
antialias, autoDensity: true })`, calls `scope.checkpoint()`, attaches through `scope.attach`, sets
`app.ticker.autoStart = false` and stops the ticker, and registers
`app.destroy(true, { children: true, texture: true, textureSource: true })`.

**Nothing reaches the canvas until you call `stage.render()` from your `onFrame` callback.** Pixi's
own loop is switched off deliberately so that the project has one animation loop, the one that
honours the frame cap. This mirrors `ThreeStage` exactly.

`PixiStage` exposes `app`, `stage` (the root container — add display objects to this), `width`,
`height`, `resize(w, h)`, `onResize(fn)` and `render()`.

It **throws `Cancelled`** when the effect was disposed while `init` was in flight. Do not catch it.

### `onResize(fn)`, on both stages

Runs after a resize that actually changed the size, once the renderer and camera are already
updated. It does **not** fire for the initial size — you are constructing at that size already.
This is where the one size-dependent line of an effect goes, and it is why most effects implement no
`resize` method at all: `defineEffect` forwards the renderer's `resize` to every stage created on
the scope.

### `?slowInit=<ms>`

Development builds only. `createPixiStage` delays `app.init` by that many milliseconds, widening the
window in which a remount can land mid-init — otherwise nearly impossible to hit on purpose.

---

## 8. Shared inputs

`frontend/src/effects/sdk/audio.ts`, `video.ts`, `lease.ts`.

```ts
useAudio(scope): Promise<AudioBus>
useVideo(scope): Promise<VideoSource>
videoTextureThree(scope, source): THREE.VideoTexture
videoTexturePixi(scope, source): PIXI.Texture
```

**The audio is OBS's, not the browser's.** `useAudio` reads one Server-Sent Events stream carrying
the levels OBS is broadcasting, which the backend gets from a WebSocket connection to
`obs-websocket`. It replaced `getUserMedia` in Phase 3, for two reasons: an OBS browser source
normally has no microphone permission at all, so the real path almost never ran; and a microphone
hears *the room*, where what an overlay should follow is what the audience hears. **Never call
`getUserMedia` from an effect** — for audio there is now nothing to call it for, and one
`MediaStream` still serves every camera effect through `useVideo`. Both helpers register their
release on `scope`; there is nothing to remember and nothing to call.

**Measured, and derived — know which you are using.** obs-websocket reports *loudness, not a
spectrum*: a peak per channel per input, roughly twenty times a second, with no Fast Fourier
Transform anywhere in the protocol. So:

| Property | |
|---|---|
| `level` (0..1, smoothed), `peak` (0..1, raw), `inputs` | **Measured.** Real numbers from OBS. |
| `frequency`, `waveform`, and therefore `bands()` | **Derived.** One real loudness value spread across the bins with a fixed spectral tilt and a slow wobble. The overall energy is real; which bin is loudest is not. |

That is a deal, not an accident: you gain real program audio on every machine with no permission
prompt, and you lose true per-frequency detail. For pulses, rings, bars and glows the loudness was
carrying the effect anyway. Prefer `level` and `peak` when you can, and if an effect leans on the
shape of the spectrum, say so in its `previewNotes`.

**It never rejects.** With no OBS connection, with OBS closed, or with a dropped stream, the bus
writes a simulated signal into the same buffers — so an effect has exactly one code path and no
fallback branch. `bus.source` is `"obs"` or `"simulated"` and may change in either direction at any
time; do not cache it. The switch to `"simulated"` happens after six seconds with nothing from the
stream, which is one backend heartbeat plus slack.

**`level` is eased, on purpose.** OBS sends twenty measurements a second and effects draw sixty
frames a second, so a raw value would visibly step. `level` rises almost instantly (20 ms) and falls
slowly (180 ms), the asymmetry a hardware VU meter has: a transient lands on time, a decay looks
like a decay. Use `peak` if you want the unsmoothed value — for beat detection or your own gate.

`AudioBus`: `frequency` and `waveform` (`Uint8Array<ArrayBuffer>`, read-only), `level`, `peak`,
`inputs`, `source`, `bands(out: Float32Array)` (averages the bins into `out.length` bands on a
squared curve, because hearing is roughly logarithmic; allocate `out` once and reuse it), and
`sample(now)`. **Call `bus.sample(now)` once per frame before reading anything.** It refreshes at
most once per tick no matter how many effects ask, which is why it takes the tick's `now`.

**Neither `useAudio` nor `useVideo` checkpoints for you**, unlike `createPixiStage`. Both resolve
normally on a scope that died while they were resolving, having released the lease they registered —
so put `scope.checkpoint()` on the line after the `await`, or the rest of your setup runs for an
effect nobody is going to see.

**The operator has to configure the connection**, under **Settings** in the admin panel, or every
audio effect shows the simulated signal. That is the first thing to check when an effect looks like
it is ignoring the music.

**The stream is shared; the texture is not.** A `THREE.VideoTexture` belongs to one WebGL context
and a `PIXI.Texture` to one renderer, so mint your own with `videoTextureThree` /
`videoTexturePixi` — each is owned by your scope — and never pass one to another effect. Never
pause, re-`srcObject` or append the shared `<video>` element.

**Leases linger.** `createSharedResource` refcounts, and refs reaching zero does not destroy: it
starts a `LINGER_MS = 2000` timer, cancelled by any re-acquire inside the window. A route change is
release-then-acquire in that order, and without the window every swap would close and reopen the
device, re-arming the browser's recording indicator and on some platforms re-prompting. `pagehide`
calls `shutdownNow()` on every resource, bypassing the linger.

---

## 9. Parameters

### Reading them

Read every value through `paramUtils`, never directly. Values come out of a database and may be
anything; every helper takes a fallback and returns it when the stored value is unusable, so a bad
value degrades to the descriptor default instead of throwing and killing the animation loop.

```ts
num(p, key, fallback, min?, max?)   int(p, key, fallback, min?, max?)   bool(p, key, fallback)
str(p, key, fallback)               colorHex(p, key, fallback)          colorInt(p, key, fallback)
rgb01(hex)                          lerp(a, b, t)                        at(buffer, index)
```

### `setParams` must be hot-swappable

Someone is watching the stream while the admin drags a slider; there must be no black frame, no
flash, no reload.

- It always receives the **complete** merged set — defaults first, route values on top — so you
  never handle `undefined` and never remember previous values.
- Apply changes in place: a uniform, a tint, a speed multiplier. Do not tear down and rebuild the
  scene.
- If something expensive genuinely depends on the value (a particle buffer), compare against what
  you stored last time and rebuild **only that one object**, keeping the renderer and canvas alive.
- It must be safe to call with values identical to the current ones, which happens often, and should
  then do nothing.
- It must never throw.

### `rebuild: true`

For the rare parameter that genuinely cannot change in place, add `rebuild: true` to its `ParamSpec`
and the renderer disposes and remounts the effect instead of calling `setParams`.

- A remount is a **black frame on air**. Prefer rebuilding in place. No effect in this build
  declares the flag: `camera-frame-ring` swaps geometry live, `audio-bars` resamples its
  displayed heights into the new array, and `starfield-warp` and `digital-rain` rebuild their
  buffers in place.
- The renderer debounces the flag by `REBUILD_DEBOUNCE_MS = 150`. The admin preview receives values
  on every input event, before any save, so an undebounced slider would take a fresh WebGL context
  per event and browsers allow only a handful.
- `registry.rebuildKey(descriptor, merged)` builds the string the renderer compares: the values of
  `rebuild: true` parameters and nothing else, NUL-separated, empty when there are none.
- The field is **frontend-only**. `buildManifest()` strips it before `POST /api/effects/sync`, so it
  is not part of the wire contract in `CONTRACT.md` and no Scala code knows about it. Every
  descriptor the frontend renders or mounts comes from the bundled registry, never from
  `GET /api/effects`, so there is no round trip for it to survive.

---

## 10. Palettes

`frontend/src/effects/sdk/palette.ts`.

```ts
paletteParam(key, label, defaultId, description): ParamSpec
palette(params, key, fallbackId): Palette
paletteAt(p, t): string          // "#rrggbb"
paletteAtInt(p, t): number       // 0xrrggbb — the one to use inside a loop; allocates nothing
paletteAt01(p, t): [r, g, b]     // 0..1 channels, for a GLSL vec3
paletteUniform(p, max): { colors: THREE.Vector3[]; count: number }
PALETTES, paletteIds(), paletteById(id)
```

A palette is **not** a new `ParamKind`. `paletteParam` emits an ordinary `kind: "select"` spec whose
`options` are the palette ids, so the admin form renders it, the backend validates it and the
inventory page lists its options with no change anywhere. The trade is that the admin sees a
dropdown of names rather than swatches; inline custom palettes remain a possible additive upgrade
later, and a route storing a preset id would keep working.

The value is a **positional sampler**, `t` from 0 to 1 and clamped, rather than named slots like
`accent` / `background`. That is what lets one palette serve a two-colour effect and a
seven-colour one from the same route setting; named slots would have every effect arguing about
which slot it means.

**Palette ids are append-only.** A route stores the id, so renaming or removing one makes every
route holding it fall back silently — changing what is on air with no error anywhere.

Mixing is linear in sRGB. Oklab would be the better default in the abstract, but adopting it would
change how existing effects look, and the harness asserts painted pixels and distinct-colour counts,
not appearance — a human would have to notice. It is a follow-up with a before/after screenshot
attached.

---

## 11. The GLSL library

`frontend/src/effects/sdk/glsl/index.ts`.

```ts
assembleFragment(chunks: readonly GlslChunk[], body: string): string
FULLSCREEN_VERTEX: string
GLSL: Readonly<Record<GlslChunk, string>>
```

Each chunk is a plain exported string; `assembleFragment` emits `precision highp float;`, then the
named chunks and everything they depend on, each exactly once and dependencies first, then your
body. There is no preprocessor, no `#include` substitution and no file loading, which is what lets
Vite hot-reload shaders.

| chunk | gives you | needs |
|---|---|---|
| `hash` | `float hash(vec2)`, `float hash1(float)` | |
| `noise2` | `float noise2(vec2)` — value noise on a grid | `hash` |
| `simplex2` | `float simplex2(vec2)` — gradient noise, −1..1 | |
| `simplex3` | `float simplex3(vec3)` — use `z` as time | |
| `fbm` | `float fbm(vec2)`, `float fbm(vec2, int)` | `noise2` |
| `curl3` | `vec3 curl3(vec3)` — divergence-free flow field | `simplex3` |
| `domainWarp` | `float domainWarp(vec2, float)` | `fbm` |
| `hsv2rgb` / `rgb2hsv` | colour-space conversion | |
| `srgb` | `vec3 toLinear(vec3)`, `vec3 toSrgb(vec3)` | |
| `palette` | `vec3 paletteRamp(vec3[8], int, float)` | |
| `easing` | `easeInOutCubic`, `easeOutBack`, `pulse`, `remap` | |
| `sdCircle`, `sdBox`, `sdRoundedBox`, `sdSegment` | signed-distance primitives | |
| `aaStep` | `float aaStep(float threshold, float value)` — a one-pixel-soft edge at any resolution | |

Naming a chunk another chunk already pulled in is harmless — each appears once — so
`["hash", "noise2", "fbm"]` and `["fbm"]` produce the same shader. Spelling the whole list out
documents at the call site what the shader is made of.

**Do not put `precision highp float;` in your body.** Chunk-private helpers are prefixed
(`s2_permute`, `s3_mod289`) so two chunks can never collide; public functions are not.

`FULLSCREEN_VERTEX` is the passthrough vertex shader for a screen quad — it writes clip-space
positions straight out and hands `uv` to the fragment stage as `vUv`. Pair it with
`{ camera: { kind: "fullscreen-quad" } }`.

---

## 12. The import ban

No file under `src/effects/**` may import `onCleanup`, `getOwner`, `onSettled`, `createEffect` or
`createSignal` from `solid-js`. `eslint.config.mjs` fails the build if one does.

Solid 2 ref callbacks are **unowned** — `getOwner()` returns `null` inside one and `onCleanup`
cannot be registered there — so an SDK helper that cleaned up through Solid's ownership would
register nothing at all and leak, silently. Own resources on the `Scope`;
`src/components/EffectStage.tsx` drives disposal and is the only place that does.

---

## 13. Debug hooks

`frontend/src/effects/sdk/debug.ts` installs `window.__sdkDebug` in development builds, or in any
build when the URL contains `?sdkDebug`. Each entry is a cheap read-only probe:

| key | reports |
|---|---|
| `clock()` | `clockStats()` — subscriber count, driver, total frames drawn |
| `subscribers()` | per subscriber: label, `frames`, `fpsCap` — this is what proves a cap is honoured |
| `shared()` | refs, lingering and alive for each shared resource |
| `shutdownSharedInputs()` | immediate teardown of every shared resource, bypassing the linger |

---

## 14. What is deliberately not here

- **A declarative parameter builder** (`p.number(...)` with inferred types). Rejected: it would make
  `descriptor.params` a derived value, and the backend rejects a whole manifest on one malformed
  spec; the conditional types degrade badly on the pinned TypeScript; and its own worst failure mode
  — `const speed = params.speed` at setup time, a snapshot that silently stops being live — is
  quieter than the one it fixes. The accepted cost is that a hand-written `setParams` restates every
  coercion, which is where a forgotten parameter hides. The mitigation is the checklist item in
  `AUTHORING_EFFECTS.md`: **every value read in `setup` is re-read in `setParams`, or declares
  `rebuild: true`.**
- **A `"palette"` `ParamKind`** — see §10.
- **Effect-owned disposal.** `EffectStage` disposes, and only `EffectStage` disposes — see §3.
