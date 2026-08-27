import { createEffect, createSignal, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { EffectInstance, EffectModule } from "~/effects/types";
import { mergeParams, rebuildKey } from "~/effects/registry";

/**
 * How long a `rebuild: true` parameter must hold still before the effect is actually remounted.
 *
 * The admin's preview pane receives values live from the form, on every keystroke and every pixel
 * of a slider drag, long before anything is saved. A `rebuild: true` number dragged as a slider
 * would otherwise remount once per input event — and each remount builds a fresh WebGL context,
 * of which a browser allows only a handful before it starts throwing the oldest ones away. Waiting
 * for the value to settle turns a drag into one remount instead of forty.
 *
 * 150 ms is below the threshold where a person reads it as lag, and well above the interval between
 * two input events from a dragged slider.
 */
const REBUILD_DEBOUNCE_MS = 150;

/**
 * Props for `<EffectStage>`.
 */
export interface EffectStageProps {
  /** The effect implementation to run, or `undefined` to render nothing. */
  module: EffectModule | undefined;
  /** The route's sparse parameter values. Defaults are merged in here, not by the caller. */
  params: Record<string, unknown>;
  /**
   * The render size, in CSS pixels, when the caller already knows it.
   *
   * Two callers, two needs, and this pair of props is the difference between them:
   *
   *  - The **renderer page** passes the route's `canvas.width` / `canvas.height`. Those numbers are
   *    the effect's render resolution, chosen by the operator, and they are *not* the size of the
   *    OBS browser source — the page scales the whole block with CSS to fit that. Measuring the
   *    element would give the scaled size and defeat the setting.
   *  - The **admin preview pane** passes neither, because it has no fixed resolution: it is a
   *    16:9 box that changes size with the browser window. It gets the measure-and-observe
   *    behaviour instead.
   *
   * Pass both or neither. Passing one alone falls back to measuring, because half a size is not a
   * size.
   */
  width?: number;
  height?: number;
  /**
   * The route's frame-rate cap, handed to the effect as `EffectContext.fpsCap`.
   *
   * `undefined` and `null` both mean "uncapped"; the distinction the contract draws between them
   * matters on the wire, not here. See the note on `EffectContext.fpsCap` for why a change to this
   * value reaches a running effect only at its next mount.
   */
  fpsCap?: number | null;
  /** Extra class applied to the host `<div>` the effect draws into. */
  class?: string;
  /** Inline styles for the host `<div>`. */
  style?: JSX.CSSProperties;
}

/**
 * Mounts one effect into a `<div>` and keeps it alive across parameter changes.
 *
 * This is the single place in the app that knows the effect lifecycle from `docs/EFFECT_SDK.md`,
 * and it is used by both consumers of that lifecycle: the admin's live preview pane and the
 * renderer page that OBS points at.
 *
 * The important behaviour, and the reason this is not merely a `<div>` with a `mount()` call:
 *
 *  - **Changing parameters never remounts.** It calls `setParams` with the full merged set, so a
 *    slider drag updates the running effect without a flash. That is a hard requirement: someone
 *    may be watching the stream while the admin edits.
 *  - **Changing the effect does remount.** The old instance is disposed (freeing its WebGL
 *    context) and a fresh one is mounted.
 *  - **Resizing calls `resize`.** Where the caller states the size (`width`/`height`), a change to
 *    those numbers is what fires it; where it does not, a `ResizeObserver` on the host element
 *    does, so the admin preview follows the browser window without a reload.
 *
 * ---
 *
 * ### How Solid 2 effects work, because everything below depends on it
 *
 * `createEffect` takes **two** functions rather than one:
 *
 *     createEffect(compute, apply)
 *
 *  - `compute()` is the *tracked* half. Every reactive value it reads becomes a dependency, and
 *    reading anything else — or reading something only inside `apply` — does not. Its return value
 *    is handed to `apply`.
 *  - `apply(value)` is the *untracked* half: the imperative work. Reads inside it subscribe to
 *    nothing, which is exactly what you want when the imperative work happens to touch reactive
 *    state.
 *  - Whatever `apply` **returns** is a cleanup function. Solid runs it in two situations, and only
 *    those two: immediately before the next `apply`, and once when the component is destroyed.
 *
 * That last rule is the whole reason this file is written the way it is; see the invariant notes
 * on each effect below.
 *
 * ### Why the reads inside `apply` are wrapped in `untrack`
 *
 * Reading a signal inside `apply` does not subscribe to it — that is the point of the two-function
 * shape. But "read something that will never update this code again" is far more often a mistake
 * than a decision, so Solid's **development** build prints a warning for every such read:
 *
 *     [STRICT_READ_UNTRACKED] Reactive value read directly in an effect callback will not update.
 *
 * `untrack(() => …)` is the switch Solid provides for saying "I meant this". It changes no
 * behaviour whatsoever — the read was already untracked — it only records the intent, for the
 * reader and for the warning.
 *
 * Leaving the warning in place would not have been harmless. `docker compose` serves the Vite
 * development server, so this is the build a developer looks at, and the delivery page mounts a
 * fresh effect every time the configuration changes. Two warnings per mount, on a page that runs
 * for the length of a broadcast, is a console nobody reads any more — on the one page where a real
 * warning is the only warning you will get before OBS shows a blank source.
 */
export function EffectStage(props: EffectStageProps): JSX.Element {
  // The <div> the effect owns. Solid fills this in via the `ref` attribute at the bottom.
  const [host, setHost] = createSignal<HTMLDivElement>();

  /*
   * The currently mounted effect, kept outside the reactive system: it is an imperative handle,
   * not a value the UI renders. Exactly one of the effects below writes these — the mount effect —
   * and the other two only read them.
   *
   * `mountedModule` records *which* module `instance` belongs to. It is what lets the parameter
   * effect below tell "the running effect is the one these parameters describe" from "the running
   * effect is about to be replaced"; see the note there for why that distinction matters.
   */
  let instance: EffectInstance | null = null;
  let mountedModule: EffectModule | null = null;

  /**
   * The size the effect should draw at, in whole CSS pixels.
   *
   * When the caller stated a size, that is the answer. Otherwise the host element is measured; an
   * element that has not been laid out yet reports 0×0, so the floor of 1 gives the effect
   * something sane to start from and the `ResizeObserver` below corrects it as soon as real
   * dimensions exist.
   *
   * This reads props but is never called from a tracked position — both callers below are in the
   * untracked half of an effect — so it adds no subscriptions of its own.
   */
  const measure = (element: HTMLDivElement): { width: number; height: number } => {
    const stated = statedSize();
    if (stated) return stated;
    const rect = element.getBoundingClientRect();
    return {
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
    };
  };

  /** The caller's stated size, or `null` when it did not state one (or stated only half of one). */
  const statedSize = (): { width: number; height: number } | null => {
    const w = props.width;
    const h = props.height;
    if (typeof w !== "number" || typeof h !== "number") return null;
    return { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) };
  };

  /*
   * ── Expensive parameters: the `rebuild: true` remount path ─────────────────────────────────
   *
   * Almost every parameter changes in place: `setParams` on the running effect, no flash, nothing
   * rebuilt. A very few cannot — a particle count backed by a fixed-size GPU buffer, a grid
   * resolution compiled into a shader — and their `ParamSpec` says so with `rebuild: true`.
   *
   * `rebuildKey` collapses the values of exactly those parameters into one string. When the string
   * changes, the effect must be disposed and mounted again; when it does not, nothing here does
   * anything at all. No effect in this build declares a rebuild parameter, so today this machinery
   * computes an empty string and never fires — it is here for the effects Phase 3.2 will author.
   *
   * NOT YET VERIFIED, and worth knowing before the first effect declares `rebuild: true`: nothing
   * in `frontend/tools/verify/` drives this path, because there is no effect for it to drive it
   * with. Two things are therefore unproven — that a settled rebuild value remounts exactly once,
   * and that switching *away* from an effect whose rebuild key was non-empty does not remount the
   * incoming effect a second time when this debounce fires 150 ms later with the new (empty) key.
   * The second one is a real ordering question, not a hypothetical: `rebuildToken` lags the module
   * by one debounce. Whoever authors that first effect should add a probe effect to the harness
   * along with it.
   *
   * INVARIANT: this effect owns the debounce timer and nothing else does.
   *
   * Same mechanism as every other effect in this file — the cleanup is the value `apply` returns —
   * so there is exactly one `clearTimeout` per `setTimeout`, and no `onCleanup` is needed. See
   * `REBUILD_DEBOUNCE_MS` for why a debounce is not optional here.
   */
  const [rebuildToken, setRebuildToken] = createSignal("");

  createEffect(
    () => {
      const module = props.module;
      return module
        ? rebuildKey(module.descriptor, mergeParams(module.descriptor, props.params))
        : "";
    },
    (key) => {
      if (key === untrack(rebuildToken)) return;
      const timer = setTimeout(() => setRebuildToken(key), REBUILD_DEBOUNCE_MS);
      return () => clearTimeout(timer);
    },
  );

  /*
   * The value the mount effect's `compute` returns.
   *
   * It has to be `===`-stable when nothing relevant changed, because that is what stops `apply`
   * from re-running and remounting the effect. Returning a fresh `{ module, token }` object every
   * time would remount on every parameter change — precisely the bug this file exists to prevent —
   * so the last pair is cached and handed back unchanged when both halves match.
   */
  let lastTarget: { module: EffectModule; token: string } | null = null;
  const mountTarget = (
    module: EffectModule,
    token: string,
  ): { module: EffectModule; token: string } => {
    if (lastTarget && lastTarget.module === module && lastTarget.token === token) return lastTarget;
    lastTarget = { module, token };
    return lastTarget;
  };

  /*
   * ── Mount / remount ────────────────────────────────────────────────────────────────────────
   *
   * INVARIANT: swapping the effect disposes the previous instance EXACTLY ONCE.
   *
   * That is guaranteed by returning the disposal from `apply` and by doing it nowhere else. Solid
   * pairs each `apply` run with exactly one run of the cleanup it returned, so mount and dispose
   * cannot get out of step no matter how fast the route changes.
   *
   * If you are tempted to add a `teardown()` call at the top of `apply`, or an `onCleanup(...)` in
   * the component body "to be safe": do not. Either one makes disposal run two or three times per
   * swap. The effect modules themselves survive that — the SDK requires `dispose` to be idempotent
   * and since Phase 3.1 every effect gets that for free, because `dispose()` is `Scope.dispose()`
   * and a second call to it is a no-op — but `instance` below would be left pointing at
   * a torn-down effect, and the symptom is a black OBS source after an ordinary parameter save,
   * with nothing in the console to explain it.
   *
   * INVARIANT: changing a parameter must NOT remount.
   *
   * `compute` reads only `host()` and `props.module`. `props.params` is read inside `apply`, which
   * tracks nothing — so a slider drag cannot possibly reach this effect. Under Solid 1 that
   * separation was a convention a careless edit could break; here it is structural.
   *
   * `compute` returns a cached `{ module, token }` pair rather than a fresh object, so re-running it
   * with an unchanged module and an unchanged rebuild token does not re-run `apply`. Before the
   * rebuild path existed it returned the module itself, which is the same trick with one field.
   *
   * The `token` half is the ONLY way a parameter can reach this effect, and it carries the values of
   * `rebuild: true` parameters and nothing else. An ordinary parameter change cannot move it.
   */
  createEffect(
    () => {
      if (!host()) return undefined;
      const module = props.module;
      const token = rebuildToken();
      return module ? mountTarget(module, token) : undefined;
    },
    (target) => {
      // Read once, deliberately untracked. `compute` above has already subscribed this effect to
      // `host()`, so re-reading it here must not add a second subscription — and does not.
      const element = untrack(() => host());
      const module = target?.module;
      if (!module || !element) return;

      /*
       * Everything below is read in the untracked half, deliberately, and each read has the same
       * reason: none of these values may cause a remount.
       *
       *  - `props.params` — a slider drag must reach the running effect through `setParams`, never
       *    through a dispose-and-mount. That is also why a freshly mounted effect needs no
       *    follow-up `setParams` call: it is handed the current values as part of its context.
       *  - the size — a canvas resize is `resize(w, h)` on the live instance, handled by the effect
       *    further down.
       *  - `props.fpsCap` — mount-time state by design; see `EffectContext.fpsCap`.
       *
       * The `untrack` wrapper changes no behaviour (reads in `apply` are untracked either way); it
       * records that the omission is on purpose, and silences Solid's development-build
       * `[STRICT_READ_UNTRACKED]` warning, which would otherwise fire twice per mount on the one
       * page where a real warning is the only warning you get before OBS shows a blank source.
       */
      const size = untrack(() => measure(element));

      try {
        instance = module.mount({
          canvasHost: element,
          width: size.width,
          height: size.height,
          params: untrack(() => mergeParams(module.descriptor, props.params)),
          fpsCap: untrack(() => props.fpsCap ?? null),
        });
        mountedModule = module;
      } catch (error) {
        console.error(`[stage] Effect "${module.descriptor.id}" threw while mounting.`, error);
        instance = null;
        mountedModule = null;
      }

      // The cleanup. Solid runs it before the next mount and once on unmount — never at any other
      // time — which is what makes "disposed exactly once" true.
      return () => {
        if (instance) {
          try {
            instance.dispose();
          } catch (error) {
            // A broken dispose must not take the page down with it, but it always deserves a log:
            // a leaked WebGL context will eventually stop every effect on the machine from drawing.
            console.error("[stage] An effect threw while being disposed.", error);
          }
          instance = null;
        }
        mountedModule = null;
        // Effects are asked to remove their own canvas, but a half-mounted one may not have, and
        // the next effect must be handed an empty div.
        element.replaceChildren();
      };
    },
  );

  /*
   * ── Hot parameter updates ──────────────────────────────────────────────────────────────────
   *
   * INVARIANT: a parameter change calls `setParams` on the RUNNING instance and never remounts.
   *
   * Reading `props.params` here, in `compute`, is what subscribes this effect — and only this
   * effect — to parameter changes.
   *
   * The `mountedModule !== next.module` guard is not defensive padding; it is load-bearing. Do not
   * assume this effect runs after the mount effect above merely because it is written after it —
   * measured against Solid 2.0.0-rc.1, when the module changes it actually runs *first*. Without
   * the guard, swapping effects hands the outgoing effect a parameter set belonging to a
   * completely different effect, moments before disposing it.
   *
   * Skipping in that case loses nothing: the mount that follows passes the current parameters to
   * `mount()` itself, so the new effect starts with the right values either way.
   *
   * A `rebuild: true` remount is a case that guard does NOT cover, and deliberately so. Such a
   * remount keeps the same module, so `mountedModule === next.module` stays true and this effect
   * runs normally — against the *outgoing* instance, moments before it is disposed. That is
   * harmless: it is a `setParams` on a live effect that is about to be replaced by one mounted with
   * those very values. It is called out here because it is a module-unchanged remount, an ordering
   * this file had never been exercised against before Phase 3.1, and because the last time an
   * ordering assumption in this file went unwritten it cost a real bug (see the note above).
   */
  createEffect(
    () => {
      const module = props.module;
      return module ? { module, merged: mergeParams(module.descriptor, props.params) } : null;
    },
    (next) => {
      if (!next || !instance || mountedModule !== next.module) return;
      try {
        instance.setParams(next.merged);
      } catch (error) {
        console.error(
          "[stage] An effect threw in setParams; the previous values stay active.",
          error,
        );
      }
    },
  );

  /*
   * ── Size tracking, case 1: the caller stated a size ─────────────────────────────────────────
   *
   * The renderer page owns the render resolution — it comes from the route's `canvas` settings —
   * so there is nothing to measure and nothing to observe. A change to those numbers is what calls
   * `resize`, which is the whole of what `docs/CONTRACT.md` §8 step 6 asks for.
   *
   * `compute` returns a fresh object, so `apply` runs whenever either number changes and not
   * otherwise. Running once immediately after a mount is harmless: `mount` was handed the same
   * size, and the SDK requires `resize` to return quickly when the size has not actually changed.
   * The ordering between this effect and the mount effect is deliberately not relied upon — if
   * this one runs first, `instance` is still null and it does nothing, and the mount that follows
   * carries the correct size anyway.
   */
  createEffect(
    () => statedSize(),
    (size) => {
      if (!size || !instance) return;
      try {
        instance.resize(size.width, size.height);
      } catch (error) {
        console.error("[stage] An effect threw in resize.", error);
      }
    },
  );

  /*
   * ── Size tracking, case 2: measure and observe ──────────────────────────────────────────────
   *
   * Used by the admin preview pane, whose box follows the browser window. `compute` returns
   * `undefined` when the caller stated a size, which switches the observer off entirely rather
   * than leaving two sources of truth fighting over `resize`.
   *
   * INVARIANT: the observer is disconnected whenever the host element changes and once on unmount.
   *
   * Same mechanism as the mount effect: the cleanup is the value `apply` returns, so there is
   * exactly one `disconnect()` per `observe()` and no `onCleanup` is needed.
   */
  createEffect(
    () => (statedSize() ? undefined : host()),
    (element) => {
      if (!element) return;

      const observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry || !instance) return;
        const box = entry.contentRect;
        const w = Math.max(1, Math.round(box.width));
        const h = Math.max(1, Math.round(box.height));
        try {
          instance.resize(w, h);
        } catch (error) {
          console.error("[stage] An effect threw in resize.", error);
        }
      });
      observer.observe(element);

      return () => observer.disconnect();
    },
  );

  return <div ref={setHost} class={props.class} style={props.style} />;
}
