/**
 * `SharedResource` — one process-wide thing, handed to many owners, released when the last one
 * lets go (after a short grace period).
 *
 * ## What needs this
 *
 * The microphone and the webcam. A browser gives a page one shot at each device, and two effects
 * that both call `getUserMedia` contend for it: at best you get two `AudioContext`s doing the same
 * FFT twice, at worst the second call fails and one effect silently falls back to a simulation.
 * `audio-bars` used to open the microphone itself, which was fine while it was the only
 * audio-reactive effect and stops being fine the moment there are two.
 *
 * So the SDK owns one `AudioContext` and one `MediaStream`, and effects *lease* them.
 *
 * ## The rules, stated exactly, because the failure modes are silent
 *
 * 1. `acquire(scope)` increments the reference count, cancels any pending shutdown, and registers
 *    the matching `release()` on the scope. A lease cannot exist without an owner — that is the
 *    single most important property here, and it is why `acquire` takes the scope rather than
 *    leaving the caller to remember.
 * 2. `create()` runs on the first acquire. A second acquire while it is still in flight joins the
 *    same promise; it does not start a second device.
 * 3. If the scope is disposed while `create()` is in flight, the lease is released the instant it
 *    resolves. The acquire still counted and the release still balances it, so the count never
 *    goes negative.
 * 4. `release()` is idempotent. A double decrement is the one bug nothing else in the system would
 *    notice, so it is guarded by a private flag rather than by discipline.
 * 5. Reaching zero references does **not** destroy the resource. It starts a linger timer of
 *    {@link LINGER_MS}. Acquiring again inside that window cancels the timer and hands back the
 *    same value.
 * 6. When the timer expires with the count still at zero, `destroy(value)` runs and the singleton
 *    is cleared. `pagehide` calls {@link shutdownAllSharedResources}, which destroys everything
 *    immediately with no linger.
 *
 * ## Why rule 5 exists, since it is a deliberate leak
 *
 * The obvious design is "destroy at zero, immediately". The reason it is wrong is what the
 * verification harness does to prove there are no leaks: it swaps the route twenty times, about a
 * second apart, and each swap is a *release then acquire, in that order*. Destroying at zero would
 * close and reopen the `AudioContext` twenty times, re-arm the browser's recording indicator
 * twenty times, and on some platforms re-prompt for permission. The same thing happens on a live
 * stream every time an operator saves a change.
 *
 * An open microphone with nobody listening is nevertheless the most user-visible leak there is,
 * which is why the window is short, why `pagehide` bypasses it entirely, and why the harness waits
 * past it and asserts every track really was stopped.
 */

import { publishDebug } from "./debug";
import type { Scope } from "./scope";

/**
 * How long a shared resource stays alive after its last consumer lets go, in milliseconds.
 *
 * Long enough to survive a route change (a release immediately followed by an acquire), short
 * enough that a microphone with no listener is not left open in any way a person would notice.
 * Two seconds is a judgement, not a measurement; see the file header for the argument.
 */
export const LINGER_MS = 2000;

/** One consumer's hold on a shared resource. */
export interface Lease<T> {
  /** The shared value. Do not hold a reference to it beyond the lease. */
  readonly value: T;
  /**
   * Lets go. Idempotent: a second call is a no-op, never a second decrement.
   *
   * You normally never call this — `acquire(scope)` already registered it on the scope.
   */
  release(): void;
}

/** What `stats()` reports, for the verification harness and for debugging a suspected leak. */
export interface SharedResourceStats {
  /** How many leases are outstanding. Must be 0 once every effect using it has been disposed. */
  refs: number;
  /** True while the grace period is running: the value is alive but nobody is holding it. */
  lingering: boolean;
  /** True while the value exists at all, whether or not anyone holds it. */
  alive: boolean;
}

/** The handle {@link createSharedResource} returns. One per kind of device. */
export interface SharedResource<T> {
  /**
   * Takes a lease and registers its release on `scope`, so the lease cannot outlive the effect.
   *
   * Rejects only if `create()` itself rejects — the audio and video helpers above this layer never
   * let that happen, because they fall back to a simulated source instead.
   */
  acquire(scope: Scope): Promise<Lease<T>>;
  /** A snapshot of the reference count and liveness. */
  stats(): SharedResourceStats;
  /**
   * Destroys the value right now, ignoring both the linger window and any outstanding leases.
   *
   * Wired to the page's `pagehide` event, and called by the verification harness. Nothing in the
   * application should call it: an effect that is still drawing would be left holding a lease on a
   * closed device.
   */
  shutdownNow(): void;
}

/** How to build and tear down one shared resource. */
export interface SharedResourceOptions<T> {
  /** Short name used in log messages and in the debug report, e.g. `"audio"`. */
  label: string;
  /**
   * Builds the value. Runs on the first acquire and never concurrently with itself — a second
   * acquire arriving while this is in flight joins the same promise.
   */
  create(): Promise<T> | T;
  /** Releases the value. Must tolerate being called after a partly failed `create`. */
  destroy(value: T): void;
  /** Grace period after the last release, in milliseconds. Defaults to {@link LINGER_MS}. */
  lingerMs?: number;
}

/** Every resource ever created, so `pagehide` can shut all of them down. */
const registry: Array<{ label: string; resource: SharedResource<unknown> }> = [];

/**
 * Destroys every shared resource immediately, ignoring linger windows and reference counts.
 *
 * Called on `pagehide`, which is the event that actually fires when a browser source is closed or
 * navigated away (`unload` does not, reliably, on modern browsers). Also exposed to the
 * verification harness as `window.__sdkDebug.shutdownSharedInputs()`.
 */
export function shutdownAllSharedResources(): void {
  for (const entry of registry) entry.resource.shutdownNow();
}

/** A report of every shared resource, for the harness. */
function allStats(): unknown {
  const out: Record<string, SharedResourceStats> = {};
  for (const entry of registry) out[entry.label] = entry.resource.stats();
  return out;
}

/**
 * Creates a refcounted, process-wide resource.
 *
 * There is exactly one call per device kind, at module scope in `audio.ts` and `video.ts`. Effects
 * do not call this; they call `useAudio(scope)` / `useVideo(scope)`.
 */
export function createSharedResource<T>(options: SharedResourceOptions<T>): SharedResource<T> {
  const lingerMs = options.lingerMs ?? LINGER_MS;

  /** The built value, once `create()` has resolved. */
  let value: T | null = null;
  /** The in-flight (or settled) build. Non-null from the first acquire until teardown. */
  let building: Promise<T> | null = null;
  let refs = 0;
  let lingerTimer: ReturnType<typeof setTimeout> | null = null;

  const cancelLinger = (): void => {
    if (lingerTimer !== null) {
      clearTimeout(lingerTimer);
      lingerTimer = null;
    }
  };

  const teardown = (): void => {
    cancelLinger();
    const doomed = value;
    value = null;
    building = null;
    if (doomed === null) return;
    try {
      options.destroy(doomed);
    } catch (error) {
      console.error(`[sdk] Destroying the shared "${options.label}" resource threw.`, error);
    }
  };

  const releaseOne = (): void => {
    refs -= 1;
    if (refs > 0) return;
    refs = 0;
    if (value === null && building === null) return;
    cancelLinger();
    lingerTimer = setTimeout(() => {
      lingerTimer = null;
      // Re-check: an acquire during the window cancels the timer, but belt and braces is cheap and
      // destroying a resource somebody is holding is not recoverable.
      if (refs === 0) teardown();
    }, lingerMs);
  };

  const resource: SharedResource<T> = {
    async acquire(scope: Scope): Promise<Lease<T>> {
      refs += 1;
      cancelLinger();

      if (building === null) {
        /*
         * `create()` is called inside a `then`, not directly, for one reason: it is typed
         * `Promise<T> | T`, so a synchronous creator is allowed to throw synchronously. Called
         * directly, that throw would escape `acquire` before the lease below existed — leaving the
         * reference count permanently one too high, which is the one state that stops a device
         * from ever being released. Deferring the call by a microtask turns any such throw into a
         * rejection, which the `catch` further down already balances.
         */
        building = Promise.resolve()
          .then(() => options.create())
          .then((built) => {
            value = built;
            return built;
          });
      }

      let released = false;
      const lease: Lease<T> = {
        get value(): T {
          // `building` has resolved by the time any caller can reach this getter.
          return value as T;
        },
        release(): void {
          if (released) return;
          released = true;
          releaseOne();
        },
      };

      /*
       * Register the release BEFORE awaiting. If the scope is already dead, `defer` runs the
       * teardown at once, so the lease is released the moment the build resolves and the count
       * balances even though nobody ever used the value.
       */
      scope.defer(() => lease.release());

      try {
        await building;
      } catch (error) {
        lease.release();
        // A failed build must not poison every later acquire with a rejected promise.
        building = null;
        throw error;
      }
      return lease;
    },

    stats(): SharedResourceStats {
      return { refs, lingering: lingerTimer !== null, alive: value !== null };
    },

    shutdownNow(): void {
      refs = 0;
      teardown();
    },
  };

  registry.push({ label: options.label, resource });
  return resource;
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", shutdownAllSharedResources);
}

publishDebug("shared", allStats);
publishDebug("shutdownSharedInputs", () => {
  shutdownAllSharedResources();
  return allStats();
});
