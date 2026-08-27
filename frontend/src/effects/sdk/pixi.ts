/**
 * `createPixiStage` — the Pixi v8 boilerplate, including the asynchronous-init dance that all three
 * Pixi effects wrote by hand.
 *
 * ## The problem this exists to delete
 *
 * Pixi v8 changed `Application` construction to be asynchronous: you `new PIXI.Application()` and
 * then `await app.init({...})`, because choosing between WebGPU and WebGL and compiling the first
 * shaders cannot be done synchronously. The renderer, meanwhile, is free to dispose an effect at
 * any moment — an operator saving a route change, a scene swap — and it does not wait for anything.
 *
 * So every Pixi effect carried this:
 *
 * ```ts
 * void app.init({ ... }).then(() => {
 *   if (disposed) {
 *     app.destroy(true, { children: true, texture: true, textureSource: true });
 *     return;
 *   }
 *   ctx.canvasHost.appendChild(app.canvas);
 *   ...
 *   ready = true;
 * });
 * ```
 *
 * plus a `ready` flag guarding `resize`, plus a matching `if (!ready) return;` in `dispose`. Three
 * copies of a race whose failure mode is *two canvases in the host div* — the second one drawing
 * over the live effect, on air, with nothing in the console.
 *
 * The `Scope` handles all of it structurally instead. `scope.attach` refuses to append when the
 * scope is already dead, and the `app.destroy` teardown is registered on the scope the moment the
 * application exists, so a cancelled setup destroys it through the ordinary teardown path rather
 * than through a bespoke branch.
 *
 * ## The ticker is switched off, on purpose
 *
 * `app.ticker.autoStart = false` and `app.ticker.stop()`. Pixi's own ticker is a second animation
 * loop, and this project has one: `onFrame` in `./clock.ts`, which is what honours the route's
 * frame-rate cap and what the verification harness counts. Two loops would mean the cap applies to
 * Three effects and silently does not apply to Pixi ones.
 *
 * The consequence is that **nothing draws until you call {@link PixiStage.render}**. Pixi normally
 * renders for you from its ticker; here you render from your `onFrame` callback, exactly as a Three
 * effect does. That symmetry is the point — one mental model for both engines.
 *
 * `autoStart = false` with explicit `app.render()` is a less-travelled path in Pixi 8.20. If it ever
 * misbehaves, the documented fallback is to hand the loop back to `app.ticker` and apply the cap
 * through `ticker.maxFPS`, accepting two loop implementations. Confirm the failure before taking it.
 */

import * as PIXI from "pixi.js";

import type { EffectContext } from "../types";
import { registerStageResize, type Scope } from "./scope";

/** Options for {@link createPixiStage}. */
export interface PixiStageOptions {
  /** Whether to ask for antialiasing. Defaults to `true`, which is what all three effects used. */
  antialias?: boolean;
}

/** A ready-to-draw Pixi setup, owned by a {@link Scope}. */
export interface PixiStage {
  /** The application. Use `stage` below for display objects; this is here for `app.renderer`. */
  readonly app: PIXI.Application;
  /** The root container. Add your `Graphics`, `Sprite` and `Container` objects to this. */
  readonly stage: PIXI.Container;
  /** Current drawing width in CSS pixels. */
  readonly width: number;
  /** Current drawing height in CSS pixels. */
  readonly height: number;
  /**
   * Resizes the renderer. Returns immediately when the size has not actually changed.
   *
   * An effect normally does not call this: `defineEffect` forwards the renderer's `resize` to every
   * stage the effect created.
   */
  resize(w: number, h: number): void;
  /**
   * Registers a callback that runs after a resize that actually changed the size, once the Pixi
   * renderer has already been resized.
   *
   * Most Pixi effects redraw their geometry from scratch every frame and therefore need nothing
   * here; it exists for the ones that cache something measured in pixels.
   */
  onResize(fn: (w: number, h: number) => void): void;
  /**
   * Draws one frame. Call it at the end of your `onFrame` callback.
   *
   * See the note on the ticker in this file's header: Pixi's own render loop is switched off, so
   * this is the only thing that puts pixels on the canvas.
   */
  render(): void;
}

/**
 * How many milliseconds to artificially delay `app.init`, in development only.
 *
 * The nastiest lifecycle bug this SDK is designed against — a remount landing *inside* an in-flight
 * Pixi init — is real and almost impossible to hit on purpose, because init normally resolves in a
 * few milliseconds. Adding `?slowInit=800` to the renderer or admin URL widens that window to
 * something a test can drive through, so the harness can prove that `scope.attach`'s refusal
 * really does keep the host div down to one canvas.
 *
 * Ignored entirely in a production build.
 */
function slowInitMs(): number {
  try {
    if (!import.meta.env.DEV || typeof location === "undefined") return 0;
    const raw = new URLSearchParams(location.search).get("slowInit");
    const value = raw === null ? 0 : Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.min(10_000, value) : 0;
  } catch {
    return 0;
  }
}

/**
 * Creates a Pixi application, attaches its canvas to the effect's host element, and registers every
 * piece of teardown on `scope`.
 *
 * ```ts
 * const stage = await createPixiStage(scope, ctx);
 * const graphics = stage.stage.addChild(new PIXI.Graphics());
 * onFrame(scope, ctx.fpsCap, ({ dt }) => { redraw(graphics, dt); stage.render(); });
 * ```
 *
 * **Throws `Cancelled`** (from `./scope`) when the effect was disposed while `init` was in flight. Do not catch
 * it: `defineEffect` catches that one error type, stays quiet about it, and lets the scope tear down
 * everything that was created — including this application. That is the whole point of the
 * `checkpoint` discipline, and it is why an effect using this helper writes no `disposed` flag.
 */
export async function createPixiStage(
  scope: Scope,
  ctx: EffectContext,
  options: PixiStageOptions = {},
): Promise<PixiStage> {
  let width = Math.max(1, Math.round(ctx.width));
  let height = Math.max(1, Math.round(ctx.height));

  const app = new PIXI.Application();

  const delay = slowInitMs();
  if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));

  await app.init({
    width,
    height,
    backgroundAlpha: 0,
    antialias: options.antialias ?? true,
    autoDensity: true,
  });

  /*
   * Registered BEFORE the checkpoint below, so that a scope which died during `init` destroys the
   * application through the ordinary teardown path. `Scope.defer` on a dead scope runs the teardown
   * at once, so this line is also the cleanup for the cancelled case — there is no second branch.
   */
  scope.defer(() => {
    app.destroy(true, { children: true, texture: true, textureSource: true });
  });

  scope.checkpoint();

  // The canvas goes in only after the checkpoint has confirmed we are still wanted, and `attach`
  // refuses a second time if the scope dies in between. Both together are what keep the host div
  // holding exactly one canvas.
  scope.attach(ctx.canvasHost, app.canvas);

  // See the header: this project has exactly one animation loop, and it is not this one.
  app.ticker.autoStart = false;
  app.ticker.stop();

  const resizeListeners: Array<(w: number, h: number) => void> = [];

  const stage: PixiStage = {
    app,
    stage: app.stage,

    get width(): number {
      return width;
    },
    get height(): number {
      return height;
    },

    resize(w: number, h: number): void {
      if (scope.disposed) return;
      const nextWidth = Math.max(1, Math.round(w));
      const nextHeight = Math.max(1, Math.round(h));
      if (nextWidth === width && nextHeight === height) return;
      width = nextWidth;
      height = nextHeight;
      app.renderer.resize(width, height);
      for (const listener of resizeListeners) {
        try {
          listener(width, height);
        } catch (error) {
          console.error(`[sdk] A resize listener in "${scope.label}" threw.`, error);
        }
      }
    },

    onResize(fn: (w: number, h: number) => void): void {
      resizeListeners.push(fn);
    },

    render(): void {
      if (scope.disposed) return;
      app.render();
    },
  };

  // So that the renderer page's `resize` reaches this stage without the effect writing a `resize`
  // method of its own. See the note beside `registerStageResize` in `./scope.ts`.
  registerStageResize(scope, (w, h) => stage.resize(w, h));

  return stage;
}
