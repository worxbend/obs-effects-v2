/**
 * The runtime verification harness: drives the real application in a real browser and reports what
 * it actually did.
 *
 * ## What this is for
 *
 * `pnpm lint`, `pnpm format:check`, `tsc` and `pnpm build` all read the source without running it.
 * Everything this project can get badly wrong happens at runtime and passes all four: an effect
 * that mounts and paints nothing, a WebGL context that is never released, a five-second poll that
 * quietly keeps running alongside the event stream, a page that redirects an OBS browser source to
 * a login form. Phase 1 found two such defects by hand, one of which was visible **only in the
 * development build**. This runs those checks on demand instead.
 *
 * ## How to run it
 *
 *     pnpm verify              # the production bundle in dist/ (build it first)
 *     pnpm verify --dev        # the Vite development server, which is what `make up` serves
 *     pnpm verify --both       # both, in sequence
 *     pnpm verify --slow       # also run the checks that spend a minute waiting on a timeout
 *     pnpm verify --only=sse   # run only the checks whose name contains "sse"
 *
 * It needs a Chromium that Playwright can drive, which nothing on the host is expected to have.
 * The supported way to run it is inside Microsoft's Playwright image, which ships the browser:
 *
 *     docker run --rm -u $(id -u):$(id -g) -e HOME=/tmp --add-host backend:127.0.0.1 \
 *       -v "$PWD:/w" -w /w mcr.microsoft.com/playwright:v1.50.0-jammy \
 *       sh -c 'mkdir -p /tmp/bin && corepack enable --install-directory /tmp/bin && \
 *              export PATH=/tmp/bin:$PATH && pnpm install --frozen-lockfile && \
 *              pnpm build && pnpm verify --both'
 *
 * Two details of that command line are load-bearing:
 *
 *  - **`--add-host backend:127.0.0.1`.** `vite.config.ts` proxies `/api` to `http://backend:8080`,
 *    which is the Compose service name. Mapping that name to the loopback address inside the
 *    container points the proxy at the stub backend this harness starts, with no change to the
 *    application's own configuration. Without it the development target cannot reach an API at all.
 *  - **the image tag must match the `playwright-core` version in `package.json`.** The browsers
 *    live in the image; `playwright-core` only drives them, and it looks for the exact build
 *    revision its own version was released against.
 *
 * ## What it does not do
 *
 * It is not a unit-test suite and it does not replace one (roadmap item 4.1). Every check here
 * costs seconds because it waits for real animation frames and real timers.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { access } from "node:fs/promises";

import { launchBrowser, Results, sleep } from "./harness.mjs";
import { startStub } from "./stub-backend.mjs";
import {
  checkEveryEffectDraws,
  checkMountDisposeCycles,
  checkParamChangeDoesNotRemount,
} from "./checks/effects.mjs";
import { checkFrameBudget } from "./checks/perf.mjs";
import {
  checkEffectFollowsObsLevels,
  checkStaleStreamFallsBackToSimulation,
} from "./checks/audio.mjs";
import {
  checkAbsentSlug,
  checkDisabledRoute,
  checkNoEventSourceFallsBackToPolling,
  checkRendererNeverRedirects,
  checkSilentStreamWatchdog,
  checkStaleErrorIsReplaced,
  checkStreamSuppressesPoll,
  checkUpdatesAreAppliedOnce,
} from "./checks/renderer.mjs";
import {
  checkAdminPagesAreQuiet,
  checkMidSessionExpiry,
  checkPreviewIgnoresDisabled,
  checkSignInFlow,
} from "./checks/admin.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = resolve(HERE, "..", "..");

/** Port the stub listens on. 8080 is what `vite.config.ts` proxies `/api` to. */
const STUB_PORT = 8080;
/** Port the Vite development server listens on, from `vite.config.ts`. */
const DEV_PORT = 3000;

/**
 * The checks, in the order they run.
 *
 * They share one stub, so they must not run concurrently: several of them switch the backend's
 * session on and off, and one asks it to refuse every event stream.
 */
const CHECKS = [
  { name: "effects-draw", run: checkEveryEffectDraws },
  { name: "mount-dispose-cycles", run: checkMountDisposeCycles },
  { name: "params-vs-remount", run: checkParamChangeDoesNotRemount },
  /*
   * The frame-time budget. It costs about eight seconds per effect — a warm-up plus a measurement
   * window that cannot be shortened without the numbers becoming noise — so it is the most
   * expensive entry in this list by some way. It runs by default anyway: a performance regression
   * that only shows up when somebody remembers to pass an extra flag is a performance regression
   * nobody finds. Use `--only=perf` while working on one effect.
   */
  { name: "perf-frame-budget", run: checkFrameBudget },
  /*
   * The audio path. These are the only checks that would catch the audio feature being broken:
   * every other one is satisfied by the simulated fallback, which paints a full lively spectrum
   * whether or not a single real level ever arrives.
   */
  { name: "audio-follows-obs", run: checkEffectFollowsObsLevels },
  { name: "audio-stale-fallback", run: checkStaleStreamFallsBackToSimulation, slow: true },
  { name: "sse-suppresses-poll", run: checkStreamSuppressesPoll },
  { name: "sse-applied-once", run: checkUpdatesAreAppliedOnce },
  { name: "sse-silent-watchdog", run: checkSilentStreamWatchdog, slow: true },
  { name: "sse-absent-eventsource", run: checkNoEventSourceFallsBackToPolling },
  { name: "disabled-route", run: checkDisabledRoute },
  { name: "absent-slug", run: checkAbsentSlug },
  { name: "stale-error-replaced", run: checkStaleErrorIsReplaced },
  { name: "renderer-never-redirects", run: checkRendererNeverRedirects },
  { name: "admin-sign-in", run: checkSignInFlow },
  { name: "admin-session-expiry", run: checkMidSessionExpiry },
  { name: "admin-preview-disabled", run: checkPreviewIgnoresDisabled },
  { name: "admin-quiet", run: checkAdminPagesAreQuiet },
];

function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith("--") && !a.includes("=")));
  const only = argv.find((a) => a.startsWith("--only="))?.slice("--only=".length);
  const targets = flags.has("--both") ? ["prod", "dev"] : flags.has("--dev") ? ["dev"] : ["prod"];
  return { targets, slow: flags.has("--slow"), only };
}

/** Waits until an HTTP server answers on `url`, so nothing races the server's start-up. */
async function waitForServer(url, { timeout = 60_000 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`Nothing answered on ${url} within ${timeout}ms.`);
    await sleep(250);
  }
}

/**
 * Starts the Vite development server and resolves once it is serving.
 *
 * This is the target that matters most: `docker compose` runs the development server, so it is the
 * build a developer looks at — and Solid's development build prints warnings the production build
 * strips out, which is how Phase 1's `[STRICT_READ_UNTRACKED]` regression was found.
 */
async function startDevServer() {
  const vite = resolve(FRONTEND_ROOT, "node_modules", "vite", "bin", "vite.js");
  const child = spawn(process.execPath, [vite, "--host", "127.0.0.1", "--port", String(DEV_PORT)], {
    cwd: FRONTEND_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = [];
  child.stdout.on("data", (chunk) => log.push(String(chunk)));
  child.stderr.on("data", (chunk) => log.push(String(chunk)));

  try {
    await waitForServer(`http://127.0.0.1:${DEV_PORT}/`);
  } catch (error) {
    child.kill("SIGKILL");
    // `cause` keeps the original failure attached rather than flattening it into a string, which
    // is what the `preserve-caught-error` lint rule is there to insist on.
    throw new Error(`${error.message}\nVite said:\n${log.join("")}`, { cause: error });
  }

  return {
    baseUrl: `http://127.0.0.1:${DEV_PORT}`,
    log,
    async stop() {
      child.kill("SIGTERM");
      await sleep(500);
      child.kill("SIGKILL");
    },
  };
}

/** Runs every selected check against one target and returns the results. */
async function runTarget({ target, baseUrl, stub, browser, slow, only }) {
  const results = new Results();
  for (const check of CHECKS) {
    if (check.slow && !slow) continue;
    if (only && !check.name.includes(only)) continue;

    const startedAt = Date.now();
    process.stdout.write(`  · ${target}/${check.name} … `);
    const before = results.entries.length;
    try {
      await check.run({ stub, baseUrl, browser, results, target });
    } catch (error) {
      results.broke(`[${target}] ${check.name}`, error);
    }
    const added = results.entries.slice(before);
    const failed = added.filter((entry) => !entry.passed).length;
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    process.stdout.write(
      `${failed === 0 ? "ok" : `${failed} FAILED`} (${added.length} assertions, ${seconds}s)\n`,
    );
  }
  return results;
}

async function main() {
  const { targets, slow, only } = parseArgs(process.argv.slice(2));
  const distDir = resolve(FRONTEND_ROOT, "dist");

  try {
    await access(resolve(distDir, "index.html"));
  } catch {
    console.error(`No built frontend at ${distDir}. Run \`pnpm build\` first.`);
    process.exitCode = 1;
    return;
  }

  console.log(`Runtime verification — targets: ${targets.join(", ")}${slow ? " (+slow)" : ""}`);

  const stub = await startStub({ port: STUB_PORT, distDir });
  const browser = await launchBrowser();
  const all = new Results();
  let dev = null;

  try {
    for (const target of targets) {
      let baseUrl;
      if (target === "prod") {
        baseUrl = `http://127.0.0.1:${STUB_PORT}`;
      } else {
        dev ??= await startDevServer();
        baseUrl = dev.baseUrl;
        // A development target that cannot reach the API is a misconfigured container, not a
        // failing application. Say which it is before spending ten minutes on checks that will all
        // fail for the same reason.
        const probe = await fetch(`${baseUrl}/api/health`).catch(() => null);
        if (!probe?.ok) {
          throw new Error(
            `The Vite dev server at ${baseUrl} could not proxy /api to the stub backend. ` +
              "Run the container with `--add-host backend:127.0.0.1` — see the note at the top " +
              "of tools/verify/run.mjs.",
          );
        }
      }

      console.log(`\n${target === "prod" ? "Production bundle" : "Vite dev server"} — ${baseUrl}`);
      const results = await runTarget({ target, baseUrl, stub, browser, slow, only });
      all.entries.push(...results.entries);
    }
  } finally {
    await dev?.stop();
    await browser.close();
    await stub.close();
  }

  console.log("\n──────────────────────────────────────────────────────────────");
  for (const entry of all.entries) {
    console.log(
      `${entry.passed ? "PASS" : "FAIL"}  ${entry.label}${entry.detail ? `\n        ${entry.detail}` : ""}`,
    );
  }
  console.log("──────────────────────────────────────────────────────────────");
  console.log(`${all.passedCount}/${all.entries.length} assertions passed.`);

  if (all.failures.length > 0) {
    console.log(`\n${all.failures.length} FAILED:`);
    for (const entry of all.failures) console.log(`  ✗ ${entry.label} — ${entry.detail}`);
    process.exitCode = 1;
  }
}

await main();
