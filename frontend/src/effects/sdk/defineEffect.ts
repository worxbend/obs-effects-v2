/**
 * `defineEffect` — the one thing an effect file default-exports after the Phase 3.1 refactor.
 *
 * ## What it does for you
 *
 * The renderer (`src/components/EffectStage.tsx`) speaks the lifecycle in `docs/EFFECT_SDK.md`:
 * `mount(ctx)` returns synchronously, and the handle it returns has `resize`, `setParams` and
 * `dispose`. That contract has not changed and is not going to — the verification harness proves
 * "disposed exactly once" against it.
 *
 * What has changed is that an effect no longer has to *implement* it. `defineEffect` sits between
 * the two and takes on the three parts that were being written by hand, wrongly, in six files:
 *
 *  1. **Making an asynchronous setup look synchronous.** `mount` must return a handle immediately,
 *     but a Pixi application has to be `init`ed and a microphone has to be granted. `mount`
 *     therefore returns a *pending* instance that records the last `resize` and the last
 *     `setParams` it was given and replays them the moment `setup` resolves. That is exactly the
 *     `ready` flag every Pixi effect used to carry, written once.
 *  2. **Teardown.** `dispose()` disposes the `Scope`, which runs everything the effect owned in
 *     reverse construction order. `Scope.dispose` is idempotent, so `dispose()` is too, with no
 *     `disposed` flag in the effect at all.
 *  3. **Cancellation.** Disposing a pending instance marks the scope dead *synchronously*. The
 *     in-flight `setup` then hits its next `scope.checkpoint()` and throws `Cancelled`, which this
 *     file swallows — and only that one error type; anything else is logged with the effect's id,
 *     matching what `EffectStage` does when `mount` itself throws.
 *
 * ## The cost, stated plainly
 *
 * The six effect files used to be readable end to end: the loop, the teardown and the ordering were
 * all right there. Now the ordering guarantees live in `./scope.ts` and you have to know that LIFO
 * is the rule. That is a real loss of local reasoning, traded for six copies of a lifecycle
 * becoming one. If plain LIFO is ever wrong for a particular effect, `scope.child()` is the escape
 * hatch.
 *
 * ## The one rule authors must not forget
 *
 * There is no compiler check for it and no runtime check either: **every value read in `setup` must
 * be re-read in `setParams`, or its `ParamSpec` must declare `rebuild: true`.** A parameter that is
 * read once at setup and never again is a slider that silently does nothing — which is quieter than
 * a crash and therefore worse. `docs/EFFECT_SDK.md` carries this as a checklist item.
 */

import type { EffectContext, EffectDescriptor, EffectInstance, EffectModule } from "../types";
import { Cancelled, createScope, stageResizers, type Scope } from "./scope";

/** What `setup` returns: the two things that can still change while the effect is running. */
export interface EffectHandle {
  /**
   * Optional, and usually omitted.
   *
   * Every stage created on the effect's scope is resized automatically, and
   * `stage.onResize(...)` covers the one size-dependent line most effects have. Implement this only
   * when something *outside* a stage depends on the size.
   */
  resize?(w: number, h: number): void;
  /**
   * Applies a new parameter set. Always receives the **full** merged set, never a partial one.
   *
   * Change values in place — a uniform, a tint, a speed. Do not rebuild the scene: someone may be
   * watching the stream while the admin drags a slider. For the rare parameter that genuinely
   * cannot change in place, declare `rebuild: true` on its `ParamSpec` and let the renderer remount.
   *
   * Must never throw on an unexpected value; read everything through `paramUtils`, which degrades a
   * bad stored value to the default.
   */
  setParams(p: Record<string, unknown>): void;
}

/** What an effect file hands to {@link defineEffect}. */
export interface EffectDefinition {
  /** The metadata the admin UI renders and the backend inventory stores. */
  descriptor: EffectDescriptor;
  /**
   * Builds the effect. Called once per mount.
   *
   * Own everything you create on `scope` — `scope.own(...)`, `scope.ownDisposable(...)`,
   * `createThreeStage(scope, ...)`, `onFrame(scope, ...)`, `useAudio(scope)` — and write no
   * teardown of your own.
   *
   * May be `async`. If it is, put `scope.checkpoint()` immediately after **every** `await`; that is
   * the only thing you have to remember about being disposed mid-setup.
   */
  setup(args: { ctx: EffectContext; scope: Scope }): Promise<EffectHandle> | EffectHandle;
}

/**
 * Turns a definition into the `EffectModule` the registry and the renderer expect.
 *
 * ```ts
 * export default defineEffect({
 *   descriptor: { id: "my-effect", ... },
 *   setup({ ctx, scope }) {
 *     const stage = createThreeStage(scope, ctx, { camera: { kind: "fullscreen-quad" } });
 *     const material = scope.ownDisposable(new THREE.ShaderMaterial({ ... }));
 *     onFrame(scope, ctx.fpsCap, ({ dt }) => { ...; stage.render(); });
 *     return {
 *       setParams(p) { ... },
 *     };
 *   },
 * });
 * ```
 */
export function defineEffect(definition: EffectDefinition): EffectModule {
  const id = definition.descriptor.id;

  return {
    descriptor: definition.descriptor,

    mount(ctx: EffectContext): EffectInstance {
      const scope = createScope(id);

      /** The handle, once `setup` has produced one. Null while a setup is still in flight. */
      let handle: EffectHandle | null = null;
      /** The last size given before the handle existed, replayed when it arrives. */
      let pendingSize: { width: number; height: number } | null = null;
      /** The last parameter set given before the handle existed, replayed when it arrives. */
      let pendingParams: Record<string, unknown> | null = null;

      /** Resizes every stage on this scope, then the effect's own optional `resize`. */
      const applyResize = (w: number, h: number): void => {
        for (const resize of stageResizers(scope)) resize(w, h);
        handle?.resize?.(w, h);
      };

      const ready = (produced: EffectHandle): void => {
        if (scope.disposed) return;
        handle = produced;
        if (pendingSize) {
          applyResize(pendingSize.width, pendingSize.height);
          pendingSize = null;
        }
        if (pendingParams) {
          handle.setParams(pendingParams);
          pendingParams = null;
        }
      };

      const failed = (error: unknown): void => {
        /*
         * `Cancelled` is not a failure. It is the ordinary "you were replaced before you finished"
         * path, thrown by `scope.checkpoint()`, and everything the setup had created by then is
         * already being torn down by the scope. Logging it would put a scary message in the console
         * of a page whose only real warning is the one you get before OBS shows a blank source.
         */
        if (!(error instanceof Cancelled)) {
          console.error(`[sdk] Effect "${id}" threw while setting up.`, error);
        }
        scope.dispose();
      };

      try {
        const produced = definition.setup({ ctx, scope });
        if (produced instanceof Promise) produced.then(ready, failed);
        else ready(produced);
      } catch (error) {
        failed(error);
      }

      return {
        resize(w: number, h: number): void {
          if (scope.disposed) return;
          if (handle) applyResize(w, h);
          else
            pendingSize = { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) };
        },

        setParams(p: Record<string, unknown>): void {
          if (scope.disposed) return;
          if (handle) handle.setParams(p);
          else pendingParams = p;
        },

        dispose(): void {
          // Synchronous, and idempotent because `Scope.dispose` is. Marking the scope dead here is
          // what makes the next `checkpoint()` in an in-flight setup throw.
          scope.dispose();
        },
      };
    },
  };
}
