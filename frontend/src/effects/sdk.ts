/**
 * The import path every effect module uses: `import { ... } from "../sdk"`.
 *
 * `docs/EFFECT_SDK.md` tells effect authors to import the SDK from `frontend/src/effects/sdk.ts`,
 * while the application shell keeps the lifecycle type definitions in `./types.ts`. Rather than have
 * two copies that can drift apart, the types below are re-exported: the single definition lives in
 * `types.ts`, and both import paths resolve to it.
 *
 * Since Phase 3.1 this file also re-exports the SDK *helpers* — the things that used to be written
 * by hand in every effect file, now living one per concern under `./sdk/`:
 *
 * | you want to… | use |
 * |---|---|
 * | write an effect at all | `defineEffect` |
 * | own something so it is torn down | `Scope` (`scope.own`, `scope.ownDisposable`, `scope.defer`) |
 * | animate | `onFrame` — honours the route's frame-rate cap |
 * | set up three.js | `createThreeStage` |
 * | set up Pixi | `createPixiStage` |
 * | react to sound | `useAudio` |
 * | react to Twitch chat | `useChat` |
 * | use the webcam | `useVideo`, `videoTextureThree`, `videoTexturePixi` |
 * | offer a colour theme | `paletteParam`, `palette`, `paletteAt`, `paletteAtInt`, `paletteAt01` |
 * | write a shader | `assembleFragment`, `GLSL`, `FULLSCREEN_VERTEX` |
 *
 * Parameter *readers* — `num`, `int`, `bool`, `str`, `colorHex`, `colorInt`, `rgb01`, `lerp`, `at` —
 * stay in `./paramUtils.ts` and are imported from there, unchanged.
 *
 * This is deliberately a **file**, not a `sdk/index.ts` directory barrel. Both resolve identically
 * for `import ... from "../sdk"`, and turning one into the other is a rename that Git records as a
 * delete plus an add in the middle of an already large diff, for no behavioural gain.
 *
 * ## The one rule about this directory
 *
 * Nothing under `src/effects/**` may import `onCleanup`, `getOwner`, `onSettled`, `createEffect` or
 * `createSignal` from `solid-js`, and `eslint.config.mjs` enforces it. Solid 2 ref callbacks are
 * unowned — `getOwner()` returns `null` inside one and `onCleanup` cannot be registered there — so
 * an SDK helper that cleaned up through Solid's ownership would register nothing and leak, silently.
 * Own resources on the effect's `Scope`; `src/components/EffectStage.tsx` drives disposal and is the
 * only place that does.
 */

export type {
  EffectContext,
  EffectDescriptor,
  EffectEngine,
  EffectInstance,
  EffectModule,
  ParamKind,
  ParamSpec,
} from "./types";

export * from "./sdk/scope";
export * from "./sdk/lease";
export * from "./sdk/clock";
export * from "./sdk/three";
export * from "./sdk/pixi";
export * from "./sdk/audio";
export * from "./sdk/chat";
export * from "./sdk/video";
export * from "./sdk/text";
export * from "./sdk/envelopes";
export * from "./sdk/palette";
export * from "./sdk/glsl/index";
export * from "./sdk/defineEffect";
export * from "./sdk/debug";
