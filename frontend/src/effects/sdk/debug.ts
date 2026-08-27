/**
 * `window.__sdkDebug` — the window the verification harness looks through.
 *
 * ## Why this file exists at all
 *
 * The roadmap is blunt about it: neither `tsc`, nor ESLint, nor the production build can catch the
 * defects an SDK refactor produces. The only net is `frontend/tools/verify/`, a real Chromium
 * driving the real application. But some of the things that must be asserted have no observable
 * footprint in the DOM at all:
 *
 *  - *"a route capped at 15 fps really draws about 15 frames a second"* — a canvas looks identical
 *    either way;
 *  - *"two audio effects share one level stream"* — nothing on the page says so;
 *  - *"the webcam track was stopped after the effects were disposed"* — the browser's recording
 *    indicator is not readable from script.
 *
 * So the SDK publishes a small read-only report object, and the harness reads it. It is not an
 * API: nothing in `src/` may call it, and the field is absent from a production build.
 *
 * ## When it is installed
 *
 * In the Vite development server (which is what `make up` serves and what `pnpm verify --dev`
 * drives), or in any build when the page URL carries `?sdkDebug` — which is how `pnpm verify` can
 * exercise the *production* bundle too, without leaving the hook switched on for an OBS source
 * that happens to load the same bundle.
 *
 * ## Shape
 *
 * `window.__sdkDebug` is a flat bag of zero-argument functions, one per publisher, each returning
 * plain JSON-safe values. The harness calls them by name:
 *
 * ```js
 * await page.evaluate(() => window.__sdkDebug.clock());
 * await page.evaluate(() => window.__sdkDebug.audio());
 * await page.evaluate(() => window.__sdkDebug.shutdownSharedInputs());
 * ```
 *
 * A publisher that never ran leaves its key absent, so the harness must check before calling —
 * `window.__sdkDebug?.audio?.()`.
 */

/** What a debug entry is: a function of no arguments returning something JSON-safe. */
export type DebugProbe = () => unknown;

declare global {
  interface Window {
    /** Present only in development builds or with `?sdkDebug` in the URL. See this file's header. */
    __sdkDebug?: Record<string, DebugProbe>;
  }
}

/** Whether the hook should exist on this page load. Evaluated once, at module load. */
const ENABLED: boolean = (() => {
  try {
    if (import.meta.env.DEV) return true;
    return typeof location !== "undefined" && location.search.includes("sdkDebug");
  } catch {
    // No `location` (a worker, a test runner). Debug hooks are a browser convenience; skip them.
    return false;
  }
})();

/** True when `window.__sdkDebug` exists on this page. Callers rarely need it; publishing is free. */
export function debugEnabled(): boolean {
  return ENABLED;
}

/**
 * Publishes one named probe on `window.__sdkDebug`, or does nothing in a production build.
 *
 * Call it once per module, at module load. `read` must be cheap and must not change anything —
 * the harness calls it repeatedly while animation is running.
 *
 * @param key  the property name the harness will call, e.g. `"clock"`.
 * @param read returns the current report. Keep it JSON-safe: numbers, strings, plain objects.
 */
export function publishDebug(key: string, read: DebugProbe): void {
  if (!ENABLED || typeof window === "undefined") return;
  const bag: Record<string, DebugProbe> = (window.__sdkDebug ??= {});
  bag[key] = read;
}

/**
 * Removes a probe published by {@link publishDebug}, or does nothing in a production build.
 *
 * A probe's `read` closure typically captures the whole object graph it reports on, so a module
 * that tears its state down must also unpublish — otherwise `window.__sdkDebug` keeps the dead
 * state reachable for the rest of the page's life, and the harness reads it as if live.
 */
export function unpublishDebug(key: string): void {
  if (!ENABLED || typeof window === "undefined") return;
  const bag = window.__sdkDebug;
  if (bag !== undefined) delete bag[key];
}
