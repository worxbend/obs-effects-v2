/**
 * The Effect SDK interfaces — the contract every effect module implements.
 *
 * This is the whole vocabulary the renderer page knows. It has no idea what "plasma field" or
 * "rain" means; it only knows how to `mount`, `resize`, `setParams` and `dispose`. That is what
 * lets a new effect be added by dropping in one file, with no change to the renderer, the admin
 * UI or the backend.
 *
 * The metadata types (`EffectDescriptor`, `ParamSpec`, ...) are re-exported from
 * `~/types/contract` on purpose: the descriptor an effect declares in code and the descriptor the
 * backend stores are the *same* JSON model, so there must be exactly one definition of it.
 *
 * See `docs/EFFECT_SDK.md` for the rules an implementation must follow.
 */

export type { EffectDescriptor, EffectEngine, ParamKind, ParamSpec } from "~/types/contract";

import type { EffectDescriptor } from "~/types/contract";

/**
 * Everything an effect is handed when it is mounted.
 *
 * `params` is the descriptor defaults already merged with the route's stored values, so it is
 * never partial — an effect never has to deal with a missing key.
 */
export interface EffectContext {
  /** The empty `<div>` the effect owns. It must append its canvas here and nowhere else. */
  canvasHost: HTMLDivElement;
  /** Current width of `canvasHost`, in CSS pixels. */
  width: number;
  /** Current height of `canvasHost`, in CSS pixels. */
  height: number;
  /** Descriptor defaults merged with the route's values. Never partial. */
  params: Record<string, unknown>;
  /**
   * The route's frame-rate cap in frames per second, or `null` for "draw as fast as the browser
   * offers". Added in Phase 2.
   *
   * **Since Phase 3.1 this is enforced, and an effect gets it for free by using the SDK's frame
   * loop.** Pass the value straight through to `onFrame(scope, ctx.fpsCap, draw)` (see
   * `src/effects/sdk/clock.ts`) and the shared clock skips the ticks that would exceed the cap. An
   * effect that starts its own `requestAnimationFrame` still ignores the field, which is one of the
   * reasons no effect should.
   *
   * It is **mount-time state**, like `width` and `height` are at the moment of mounting: the value
   * is handed over once, in `mount(ctx)`, and a route whose cap changes reaches a running effect at
   * its next mount. `setParams` is the live channel, and it carries parameters only — a frame cap
   * is not a parameter of any effect, it is a property of the route.
   */
  fpsCap: number | null;
}

/**
 * The handle the renderer keeps after mounting an effect.
 *
 * All three methods may be called in any order, any number of times, and possibly before the
 * effect has drawn its first frame — so each one must tolerate being called "too early".
 */
export interface EffectInstance {
  /**
   * Called whenever `canvasHost` changes size — which can be many times per second while the
   * OBS source is being dragged. Must resize the renderer, the canvas and any camera, and should
   * return immediately when the size has not actually changed.
   */
  resize(w: number, h: number): void;

  /**
   * Called when the admin changes parameters. Always receives the **full** merged parameter set.
   * Must apply changes in place (update a uniform, a tint, a speed) rather than rebuilding the
   * scene, and must never throw on an unexpected value.
   */
  setParams(p: Record<string, unknown>): void;

  /**
   * Called when the effect is torn down. Must stop the animation loop, remove listeners and free
   * every GPU resource. Must be idempotent — calling it twice must not throw.
   */
  dispose(): void;
}

/** What each effect module default-exports. */
export interface EffectModule {
  /** Metadata used by the admin UI and pushed to the backend inventory. */
  descriptor: EffectDescriptor;
  /** Creates a running instance of the effect inside `ctx.canvasHost`. Called at most once. */
  mount(ctx: EffectContext): EffectInstance;
}
