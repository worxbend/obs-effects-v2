/**
 * `Scope` — the ownership primitive the whole SDK is built on.
 *
 * ## The problem it solves
 *
 * Before this file existed, every effect hand-rolled the same three things:
 *
 *  1. a `let disposed = false` flag,
 *  2. a `if (disposed) return;` guard at the top of `resize`, `setParams`, `dispose` and the
 *     animation loop,
 *  3. a teardown sequence — cancel the loop, dispose the geometry, dispose the material, dispose
 *     the renderer, remove the canvas — whose *order* had to be right by hand, in six files.
 *
 * Six copies of something that has to be exactly correct is six chances to get it wrong, and the
 * failure mode is a leaked WebGL context: a browser allows only a handful of them, so a stream that
 * changes route a few dozen times ends with an OBS source that draws nothing and no error anywhere.
 *
 * A `Scope` replaces all three. You register a teardown next to the thing that needs it, at the
 * moment you create it, and the scope runs every teardown once, in the right order, when the effect
 * is disposed.
 *
 * ## Why the order is LIFO (last in, first out)
 *
 * Registration order is construction order. A thing constructed later may depend on a thing
 * constructed earlier (a material needs its renderer's context; a mesh needs its geometry), never
 * the other way round. So *reverse* registration order is correct destruction order, for free, and
 * no effect author has to reason about it. That is the entire design.
 *
 * ## Why this file does not import from `solid-js`
 *
 * Solid 2 ref callbacks are **unowned**: `getOwner()` returns `null` inside one and `onCleanup`
 * cannot be registered there. An SDK helper that tried to clean up through Solid's ownership would
 * therefore register nothing at all, silently, and leak. So SDK teardown never depends on reactive
 * ownership — `src/components/EffectStage.tsx` drives disposal and is the only place that does.
 * An ESLint rule in `eslint.config.mjs` makes that mechanical rather than a rule someone has to
 * keep remembering.
 */

/**
 * Thrown by {@link Scope.checkpoint} when the scope was disposed while an `await` was pending.
 *
 * An effect's `setup` can be asynchronous — a Pixi application has to be `init`ed, a microphone has
 * to be granted — and the renderer is free to tear the effect down before that finishes. Every
 * `await` in an async setup is therefore followed by `scope.checkpoint()`, which throws this to
 * abandon the rest of the setup. `defineEffect` catches this one error type and stays quiet about
 * it, because it is not a failure: it is the ordinary "you were replaced before you finished"
 * path. Any *other* error is logged with the effect's id.
 */
export class Cancelled extends Error {
  constructor(label: string) {
    super(`[sdk] "${label}" was disposed while an async setup was still running.`);
    this.name = "Cancelled";
  }
}

/**
 * A bag of teardowns with a lifetime.
 *
 * An effect is handed one in `setup`, owns everything it creates on it, and never writes a
 * `dispose` method of its own.
 */
export interface Scope {
  /**
   * A short human name used in log messages — the effect's descriptor id, in practice.
   * `scope.child()` appends a suffix so a nested scope is still identifiable.
   */
  readonly label: string;

  /**
   * Whether this scope has been torn down. Readable **synchronously**, which is what makes it
   * usable from a callback that may fire after disposal (a resolved promise, a pending timer).
   */
  readonly disposed: boolean;

  /**
   * Registers a bare teardown function. Teardowns run in reverse registration order.
   *
   * Registering on an already-disposed scope runs `teardown` **immediately** rather than dropping
   * it. That is what stops a resource created by a late-arriving promise from leaking.
   */
  defer(teardown: () => void): void;

  /**
   * Registers a teardown for `value` and returns `value` unchanged, so it can wrap an expression
   * without needing a temporary variable:
   *
   * ```ts
   * const geometry = scope.own(new THREE.PlaneGeometry(2, 2), (g) => g.dispose());
   * ```
   */
  own<T>(value: T, teardown: (value: T) => void): T;

  /**
   * Shorthand for the very common case: a three.js or pixi.js object whose teardown is its own
   * `dispose()` method. Returns the resource, like {@link own} does.
   *
   * ```ts
   * const material = scope.ownDisposable(new THREE.ShaderMaterial({ ... }));
   * ```
   */
  ownDisposable<T extends { dispose(): void }>(resource: T): T;

  /**
   * Appends `canvas` to `host` and registers its removal.
   *
   * Returns `false` and appends **nothing** when the scope is already disposed. That refusal is
   * what keeps the renderer's host `<div>` holding at most one canvas when a remount lands while a
   * previous effect's asynchronous setup is still in flight — the case the verification harness
   * asserts with `canvasCountIn(".renderer-host") === 1`. Before this existed, every Pixi effect
   * open-coded an `if (disposed) { app.destroy(...); return; }` branch to cover it.
   */
  attach(host: HTMLElement, canvas: HTMLCanvasElement): boolean;

  /**
   * Throws {@link Cancelled} when the scope has been disposed, and does nothing otherwise.
   *
   * Call it immediately after every `await` in an asynchronous setup. This is the only thing an
   * effect author has to remember about asynchronous teardown.
   */
  checkpoint(): void;

  /**
   * Creates a child scope, torn down with its parent.
   *
   * For resources that are shorter-lived than the effect — a geometry rebuilt whenever the size
   * changes, say. Own the batch on a child, throw the child away, make a new one. Disposing the
   * parent disposes any child that is still alive.
   *
   * This is also the escape hatch for the rare case where plain LIFO is the wrong order: put the
   * group that needs its own ordering in a child and control when the child dies.
   */
  child(): Scope;
}

/** A scope plus the one method its *owner* — and nobody else — is allowed to call. */
export interface OwnedScope extends Scope {
  /**
   * Runs every registered teardown, in reverse registration order, exactly once.
   *
   * A second call is a no-op, which is what makes `EffectInstance.dispose` idempotent without any
   * effect writing a guard.
   */
  dispose(): void;
}

/**
 * Creates a scope.
 *
 * Effect authors never call this: `defineEffect` creates the scope and hands it to `setup`. It is
 * exported because the verification harness and future tooling construct scopes directly.
 *
 * @param label a short name for log messages — the effect's descriptor id, by convention.
 */
export function createScope(label: string): OwnedScope {
  /** Teardowns in registration order. Drained back to front. */
  const teardowns: Array<() => void> = [];
  let disposed = false;
  let childSeq = 0;

  const runOne = (teardown: () => void): void => {
    try {
      teardown();
    } catch (error) {
      /*
       * One throwing teardown must not strand the teardowns behind it. That is precisely the
       * failure the hand-written dispose sequences were exposed to: a geometry that threw took the
       * renderer teardown with it, and the renderer teardown is the one that releases the WebGL
       * context.
       */
      console.error(`[sdk] A teardown in scope "${label}" threw. Continuing with the rest.`, error);
    }
  };

  const scope: OwnedScope = {
    label,

    get disposed(): boolean {
      return disposed;
    },

    defer(teardown: () => void): void {
      if (disposed) {
        runOne(teardown);
        return;
      }
      teardowns.push(teardown);
    },

    own<T>(value: T, teardown: (value: T) => void): T {
      scope.defer(() => teardown(value));
      return value;
    },

    ownDisposable<T extends { dispose(): void }>(resource: T): T {
      scope.defer(() => resource.dispose());
      return resource;
    },

    attach(host: HTMLElement, canvas: HTMLCanvasElement): boolean {
      if (disposed) return false;
      host.appendChild(canvas);
      scope.defer(() => canvas.remove());
      return true;
    },

    checkpoint(): void {
      if (disposed) throw new Cancelled(label);
    },

    child(): Scope {
      childSeq += 1;
      const nested = createScope(`${label}#${childSeq}`);
      scope.defer(() => nested.dispose());
      return nested;
    },

    dispose(): void {
      if (disposed) return;
      /*
       * `disposed` is set BEFORE draining, not after. A teardown can trigger a callback of its own
       * (Pixi's `destroy` fires listeners; removing a canvas can fire a ResizeObserver), and every
       * one of those must see a scope that is already dead so it does no further work and registers
       * nothing new.
       */
      disposed = true;
      while (teardowns.length > 0) {
        const teardown = teardowns.pop();
        if (teardown) runOne(teardown);
      }
    },
  };

  return scope;
}

/*
 * ── Internal plumbing: how a stage's `resize` reaches it ────────────────────────────────────────
 *
 * `EffectHandle.resize` is optional, because an effect built on `createThreeStage` or
 * `createPixiStage` almost never has anything size-dependent of its own to do — the stage resizes
 * the renderer and reprojects the camera, and `stage.onResize(...)` covers the rest.
 *
 * For that to be true, something has to call `stage.resize(w, h)` when the renderer page tells the
 * effect its size changed, without the effect writing the call by hand. That is what this pair of
 * functions is: a stage registers itself against the scope it was created on, and `defineEffect`
 * looks the list up when a `resize` arrives.
 *
 * A `WeakMap` keyed on the scope means the list disappears with the scope and there is nothing to
 * clean up. Effect authors never touch either function; they are exported only because the stage
 * helpers live in different modules from `defineEffect`.
 */

const stageResizeRegistry = new WeakMap<Scope, Array<(w: number, h: number) => void>>();

/** Internal. Called by `createThreeStage` / `createPixiStage`; not part of the authoring API. */
export function registerStageResize(scope: Scope, resize: (w: number, h: number) => void): void {
  const list = stageResizeRegistry.get(scope);
  if (list) list.push(resize);
  else stageResizeRegistry.set(scope, [resize]);
}

/** Internal. Every stage resize registered against `scope`, in creation order. */
export function stageResizers(scope: Scope): ReadonlyArray<(w: number, h: number) => void> {
  return stageResizeRegistry.get(scope) ?? [];
}
