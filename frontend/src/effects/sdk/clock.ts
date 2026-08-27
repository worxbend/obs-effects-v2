/**
 * The shared frame clock: one `requestAnimationFrame` for the whole page, and the file that
 * finally makes the route's frame-rate cap mean something.
 *
 * ## What it replaces
 *
 * Every effect used to own its own animation loop: a `requestAnimationFrame` call, a `lastTime`
 * variable, a `dt` computed from it and clamped to 0.1 seconds, and a `cancelAnimationFrame` in
 * `dispose`. Six copies of the same eight lines. Worse, `EffectContext.fpsCap` — the per-route cap
 * the operator sets in the admin — was carried through every layer of the application and then
 * ignored, because nothing enforced it.
 *
 * Now there is one loop. Every effect subscribes to it with {@link onFrame}, gets its own delta
 * time and its own cap, and the subscription is owned by the effect's `Scope`, so nothing has to
 * remember to cancel anything.
 *
 * ## Why "one loop" is worth doing at all
 *
 * The admin preview pane and the renderer page both mount effects, and a future scene may composite
 * several at once. Ten `requestAnimationFrame` callbacks do not give you ten independent clocks —
 * the browser runs them all in the same frame anyway — they just cost ten callback dispatches and
 * ten chances to leak one. One loop also gives the harness a single number to assert against.
 *
 * ## Delta time, and why an effect must use it
 *
 * `dt` is *seconds since this subscriber's previous frame*. Multiplying movement by `dt` is what
 * makes an effect run at the same visual speed on a 30 fps machine and a 144 Hz one. It is clamped
 * to 0.1 s — the same clamp all six effects wrote by hand — because a tab that was backgrounded for
 * thirty seconds would otherwise deliver `dt = 30` and teleport every particle out of the frame.
 *
 * ## The visibility policy, which is deliberately not the obvious one
 *
 * This clock does **not** pause when `document.hidden` is true, even though almost every animation
 * library does.
 *
 * An OBS browser source sitting in an inactive scene is not "hidden" in a way we can trust, and the
 * consequence of guessing wrong is the worst outcome this project has: a frozen source, on air,
 * with nothing in the console. So instead:
 *
 *  - a `visibilitychange` resets each subscriber's timing, so the first frame after coming back is
 *    a normal small `dt` rather than a jump;
 *  - a watchdog notices when `requestAnimationFrame` has not fired for {@link RAF_WATCHDOG_MS} and
 *    pumps the loop from a `setTimeout` instead, at a modest rate, until rAF starts working again.
 *
 * The result of aggressive throttling is therefore a *lower frame rate*, never a stopped stream.
 *
 * This policy has not yet been measured against a real OBS source in an inactive scene; that is
 * recorded as an open item in the Phase 3.1 design and should be checked before the first live use.
 */

import { publishDebug } from "./debug";
import type { Scope } from "./scope";

/** How long `requestAnimationFrame` may go silent before the `setTimeout` pump takes over. */
const RAF_WATCHDOG_MS = 2000;

/** Frames per second the fallback pump runs at when no subscriber states a lower cap. */
const FALLBACK_FPS = 30;

/** Assumed display interval, in milliseconds, until real frames have been measured (60 Hz). */
const DEFAULT_DISPLAY_MS = 1000 / 60;

/** The largest `dt` any subscriber is ever given, in seconds. See the note in the file header. */
const MAX_DT_SECONDS = 0.1;

/** What a subscriber is handed on every frame it is due to draw. */
export interface FrameInfo {
  /**
   * Seconds since this subscriber's previous frame, clamped to {@link MAX_DT_SECONDS}.
   *
   * Zero on the very first frame, because there is no previous frame to measure from. Multiply
   * every per-frame movement by this so the effect looks the same at any refresh rate.
   */
  dt: number;
  /**
   * Seconds since this subscriber's first frame — the sum of every `dt` it has been given.
   *
   * It starts at 0 and is independent of every other subscriber and of how long the page has been
   * open, so an effect mounted an hour into a broadcast still starts its animation at the
   * beginning. Because it is a sum of clamped deltas it also never jumps.
   */
  elapsed: number;
  /**
   * `performance.now()` for this tick, in milliseconds — the same value for every subscriber that
   * draws in it. Use it when several things must agree on "now", such as
   * `AudioBus.sample(now)`; use `elapsed` for animation.
   */
  now: number;
}

/** The handle {@link onFrame} returns. Owned by the scope; you rarely need to touch it. */
export interface FrameSubscription {
  /**
   * Unsubscribes. Idempotent — a second call does nothing. Unsubscribing the last subscriber
   * cancels the page's `requestAnimationFrame` entirely, so an idle page costs nothing.
   */
  stop(): void;
}

/** Everything `clockStats()` reports. Also published to the harness as `window.__sdkDebug.clock()`. */
export interface ClockStats {
  /** How many live subscribers there are right now. */
  subscribers: number;
  /**
   * What is currently driving the loop: `"raf"` normally, `"timeout"` when the watchdog has taken
   * over because `requestAnimationFrame` went silent, `"idle"` when nothing is subscribed.
   */
  driver: "raf" | "timeout" | "idle";
  /** Total `draw` calls made since the page loaded, across every subscriber. */
  framesDrawn: number;
}

/** One live subscriber. Kept in a plain array because the list is tiny and iterated every frame. */
interface Subscriber {
  label: string;
  /** Frames per second this subscriber may draw at, or `null` for "as fast as the page offers". */
  fpsCap: number | null;
  draw: (frame: FrameInfo) => void;
  /** `performance.now()` of this subscriber's last drawn frame; -1 before its first. */
  lastDrawAt: number;
  elapsed: number;
  frames: number;
  live: boolean;
}

const subscribers: Subscriber[] = [];

let driver: ClockStats["driver"] = "idle";
let framesDrawn = 0;

/** Handle of the armed `requestAnimationFrame`, and of the watchdog/pump timer beside it. */
let rafHandle = 0;
let timerHandle: ReturnType<typeof setTimeout> | 0 = 0;
let armed = false;

/** Rolling estimate of the real display interval, used to make the cap comparison forgiving. */
let displayMs = DEFAULT_DISPLAY_MS;

/**
 * Normalises whatever arrives as an fps cap.
 *
 * The value comes from a database via `CanvasSettings.fpsCap`, so it may be anything at all. The
 * contract's range is 1..240; outside it, or not a finite number, means uncapped.
 */
function normaliseCap(fpsCap: number | null): number | null {
  if (fpsCap === null || !Number.isFinite(fpsCap)) return null;
  const rounded = Math.round(fpsCap);
  if (rounded < 1) return null;
  return Math.min(240, rounded);
}

/**
 * Subscribes `draw` to the page's frame loop, for as long as `scope` is alive.
 *
 * This is the only animation loop an effect should ever start. There is no matching "off" call to
 * remember: the subscription is registered on the scope, so it stops when the effect is disposed.
 *
 * ```ts
 * onFrame(scope, ctx.fpsCap, ({ dt }) => {
 *   uniforms.uTime.value += dt * speed;
 *   stage.render();
 * });
 * ```
 *
 * A `draw` that throws is logged once, with the scope's label, and then **unsubscribed**. One
 * broken effect must not stop every other effect on the page from drawing, and a callback that
 * throws sixty times a second would bury every other message in the console.
 *
 * @param scope  the effect's scope; owns the subscription.
 * @param fpsCap frames per second, or `null` for uncapped. Pass `ctx.fpsCap` straight through.
 * @param draw   called once per due frame with this subscriber's own timing.
 * @returns a handle whose `stop()` unsubscribes early. Ignoring it is the normal case.
 */
export function onFrame(
  scope: Scope,
  fpsCap: number | null,
  draw: (frame: FrameInfo) => void,
): FrameSubscription {
  const subscriber: Subscriber = {
    label: scope.label,
    fpsCap: normaliseCap(fpsCap),
    draw,
    lastDrawAt: -1,
    elapsed: 0,
    frames: 0,
    live: true,
  };

  const subscription: FrameSubscription = {
    stop(): void {
      if (!subscriber.live) return;
      subscriber.live = false;
      const index = subscribers.indexOf(subscriber);
      if (index !== -1) subscribers.splice(index, 1);
      if (subscribers.length === 0) disarm();
    },
  };

  /*
   * If the scope is already dead — which happens when an async setup resolved after a remount —
   * `defer` runs the teardown immediately, so this subscription never draws a frame. That is the
   * behaviour we want, and it is why nothing here checks `scope.disposed` itself.
   */
  subscribers.push(subscriber);
  scope.defer(() => subscription.stop());
  arm();
  return subscription;
}

/** A snapshot of what the clock is doing. Used by the verification harness and for debugging. */
export function clockStats(): ClockStats {
  return { subscribers: subscribers.length, driver, framesDrawn };
}

/**
 * Per-subscriber counters, published to the harness only.
 *
 * This is what proves a cap is honoured: a subscriber with `fpsCap: 15` observed over three seconds
 * must have drawn roughly 45 frames, not roughly 180.
 */
function subscriberStats(): unknown {
  return subscribers.map((s) => ({
    label: s.label,
    fpsCap: s.fpsCap,
    frames: s.frames,
    elapsed: Number(s.elapsed.toFixed(3)),
  }));
}

/** Milliseconds between pump ticks when the watchdog is driving, honouring the highest cap asked for. */
function pumpIntervalMs(): number {
  let fps = 0;
  for (const s of subscribers) fps = Math.max(fps, s.fpsCap ?? FALLBACK_FPS);
  return 1000 / Math.max(1, Math.min(FALLBACK_FPS, fps || FALLBACK_FPS));
}

/** Arms the next tick, unless one is already armed or there is nothing to draw. */
function arm(): void {
  if (armed || subscribers.length === 0 || typeof requestAnimationFrame !== "function") return;
  armed = true;
  rafHandle = requestAnimationFrame(onAnimationFrame);
  /*
   * The same timer is both the watchdog (while rAF is healthy) and the pump (once it is not).
   * Arming both every round is what lets the loop climb back to rAF the moment it starts firing
   * again — whichever of the two arrives first wins the round.
   */
  timerHandle = setTimeout(
    onFallbackTimer,
    driver === "timeout" ? pumpIntervalMs() : RAF_WATCHDOG_MS,
  );
}

/** Cancels whatever is armed. Called when the last subscriber leaves. */
function disarm(): void {
  if (rafHandle) cancelAnimationFrame(rafHandle);
  if (timerHandle) clearTimeout(timerHandle);
  rafHandle = 0;
  timerHandle = 0;
  armed = false;
  driver = "idle";
}

function onAnimationFrame(now: number): void {
  armed = false;
  if (timerHandle) clearTimeout(timerHandle);
  timerHandle = 0;
  if (driver === "raf" && lastTickAt >= 0) {
    // Exponential moving average of the real frame interval, used to make the cap test forgiving.
    const measured = now - lastTickAt;
    if (measured > 1 && measured < 100) displayMs = displayMs * 0.9 + measured * 0.1;
  }
  driver = "raf";
  tick(now);
  arm();
}

function onFallbackTimer(): void {
  armed = false;
  if (rafHandle) cancelAnimationFrame(rafHandle);
  rafHandle = 0;
  driver = "timeout";
  tick(performance.now());
  arm();
}

/** `performance.now()` of the previous tick, whichever driver produced it. -1 before the first. */
let lastTickAt = -1;

function tick(now: number): void {
  lastTickAt = now;
  /*
   * Iterate over a copy. A `draw` may dispose its own effect (an error path, or an effect that
   * decides it is finished), which splices the live array while we are walking it.
   */
  for (const subscriber of [...subscribers]) {
    if (!subscriber.live) continue;

    if (subscriber.fpsCap !== null && subscriber.lastDrawAt >= 0) {
      /*
       * Capping by skipping ticks, never by `setTimeout`.
       *
       * A `setTimeout` loop fights the compositor: it fires between frames, so the browser either
       * drops the work or presents it late, and the result stutters worse than the uncapped loop
       * it was meant to calm down. Skipping frames keeps every draw aligned to a real frame.
       *
       * Half a display interval is subtracted from the threshold because frames do not arrive on
       * exact multiples of anything. Without it, a 30 fps cap on a 60 Hz display lands a hair
       * under the threshold every other frame and yields 20 fps instead of 30.
       */
      const wanted = 1000 / subscriber.fpsCap;
      if (now - subscriber.lastDrawAt < wanted - displayMs / 2) continue;
    }

    const dt =
      subscriber.lastDrawAt < 0
        ? 0
        : Math.min((now - subscriber.lastDrawAt) / 1000, MAX_DT_SECONDS);
    subscriber.lastDrawAt = now;
    subscriber.elapsed += dt;
    subscriber.frames += 1;
    framesDrawn += 1;

    try {
      subscriber.draw({ dt, elapsed: subscriber.elapsed, now });
    } catch (error) {
      console.error(
        `[sdk] The frame callback of "${subscriber.label}" threw. Unsubscribing it so the rest of ` +
          `the page keeps drawing.`,
        error,
      );
      subscriber.live = false;
      const index = subscribers.indexOf(subscriber);
      if (index !== -1) subscribers.splice(index, 1);
      if (subscribers.length === 0) disarm();
    }
  }
}

if (typeof document !== "undefined") {
  /*
   * Coming back from a throttled or hidden state, `performance.now()` has moved on by however long
   * we were away. Forgetting each subscriber's last frame time makes the next frame's `dt` a 0
   * rather than a large clamped value, so animation resumes where it left off instead of lurching.
   */
  document.addEventListener("visibilitychange", () => {
    for (const subscriber of subscribers) subscriber.lastDrawAt = -1;
    lastTickAt = -1;
  });
}

publishDebug("clock", clockStats);
publishDebug("subscribers", subscriberStats);
