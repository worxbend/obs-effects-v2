/**
 * The small amount of scaffolding every check needs: a browser, a place to record results, and a
 * recorder that notices anything the page complains about.
 *
 * Nothing project-specific lives here. The checks themselves are in `checks/`.
 */

import { chromium } from "playwright-core";
import { PROBE_SOURCE } from "./probe.mjs";

/**
 * Command-line arguments Chromium needs to draw WebGL without a graphics card.
 *
 * A container has no GPU, so Chromium falls back to SwiftShader, a software renderer that
 * implements the whole of OpenGL ES on the processor. Recent Chromium versions refuse that
 * fallback unless asked, because a silent software fallback on a real user's machine is a
 * performance cliff rather than a feature — hence `--enable-unsafe-swiftshader`, whose "unsafe"
 * means "slow and unaccelerated", not "insecure".
 */
const CHROMIUM_ARGS = [
  "--enable-unsafe-swiftshader",
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  // Camera effects ask for a webcam, and `useVideo` still goes through `getUserMedia`. Granting a
  // fake device keeps a permission prompt from blocking the page.
  //
  // Audio no longer needs either of these. Until Phase 3.4 `audio-bars` opened a microphone, and
  // these flags were what let it run here at all — which was itself a warning sign, because an OBS
  // browser source has no microphone and no way to grant one, so the checks were exercising a path
  // that essentially never ran in production. Audio now comes from OBS over a Server-Sent Events
  // stream, which the stub backend serves, so it is tested the same way it actually works.
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
];

/** Pauses for `ms` milliseconds. Used where the thing being measured is "nothing happened". */
export function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Polls `predicate` until it returns a truthy value, or gives up.
 *
 * Preferred over a fixed `sleep` wherever there is something to wait *for*, because it finishes as
 * soon as the condition holds instead of always costing the worst case.
 */
export async function waitFor(predicate, { timeout = 10_000, interval = 100, what = "" } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeout}ms waiting for ${what || "a condition"}.`);
    }
    await sleep(interval);
  }
}

/**
 * Collects the results of one group of checks.
 *
 * Every check calls `ok(...)` with a condition and a sentence describing what was true. A failed
 * check does not stop the run: the point of a verification pass is to come back with the whole
 * list, not with the first thing that broke.
 */
export class Results {
  constructor() {
    this.entries = [];
  }

  ok(passed, label, detail = "") {
    this.entries.push({ passed: Boolean(passed), label, detail });
    return Boolean(passed);
  }

  /** Records a check that could not run at all — a thrown error rather than a false condition. */
  broke(label, error) {
    this.entries.push({ passed: false, label, detail: `threw: ${String(error)}` });
  }

  get failures() {
    return this.entries.filter((entry) => !entry.passed);
  }

  get passedCount() {
    return this.entries.filter((entry) => entry.passed).length;
  }
}

/**
 * Watches one page for everything that should never happen: an error logged to the console, an
 * uncaught exception, and a request that failed outright.
 *
 * Console messages are kept in full rather than counted, because "there were three errors" is not
 * a report anybody can act on.
 */
export class PageRecorder {
  constructor(page) {
    this.consoleErrors = [];
    this.consoleWarnings = [];
    this.pageErrors = [];
    this.failedRequests = [];
    this.requests = [];

    page.on("console", (message) => {
      const line = `${message.text()}`;
      if (message.type() === "error") this.consoleErrors.push(line);
      else if (message.type() === "warning") this.consoleWarnings.push(line);
    });
    page.on("pageerror", (error) => this.pageErrors.push(String(error)));
    page.on("requestfailed", (request) => {
      // An aborted request is how the renderer cancels a poll it no longer needs, and how a page
      // being navigated away from ends its event stream. Neither is a failure.
      const failure = request.failure()?.errorText ?? "";
      if (failure.includes("ERR_ABORTED")) return;
      this.failedRequests.push(`${request.method()} ${request.url()} — ${failure}`);
    });
    page.on("request", (request) => this.requests.push(`${request.method()} ${request.url()}`));
  }

  /** Requests this page made whose URL contains `fragment`. */
  matching(fragment) {
    return this.requests.filter((line) => line.includes(fragment));
  }

  /** Throws away everything recorded so far, so a check can measure one window. */
  reset() {
    this.consoleErrors.length = 0;
    this.consoleWarnings.length = 0;
    this.pageErrors.length = 0;
    this.failedRequests.length = 0;
    this.requests.length = 0;
  }
}

/**
 * Launches Chromium and returns it together with a factory for instrumented pages.
 *
 * Every page is given a fresh browser context, so one check's cookies and storage cannot leak into
 * the next — which matters here more than usual, since several checks are specifically about
 * whether a session exists.
 */
export async function launchBrowser() {
  const browser = await chromium.launch({ args: CHROMIUM_ARGS });

  return {
    browser,

    /**
     * A new isolated context with the probe installed and a recorder attached.
     *
     * @param {object} options
     * @param {{width:number,height:number}} [options.viewport]
     * @param {string} [options.initScript] extra source to run before the page's own scripts,
     *   for a check that needs to alter the runtime the application finds — removing an API to
     *   see what the fallback does, for instance.
     */
    async newPage({ viewport = { width: 1280, height: 720 }, initScript } = {}) {
      const context = await browser.newContext({ viewport });
      await context.addInitScript(PROBE_SOURCE);
      if (initScript) await context.addInitScript(initScript);
      const page = await context.newPage();
      const recorder = new PageRecorder(page);
      return { context, page, recorder };
    },

    async close() {
      await browser.close();
    },
  };
}

/** Reads the probe's report out of a page. */
export function probeReport(page) {
  return page.evaluate(() => window.__probe.report());
}
