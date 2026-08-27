/**
 * The performance budget check: how long one frame of each effect takes, as a number.
 *
 * ## What roadmap item 3.3 asked for, and what this actually delivers
 *
 * The roadmap wants *"frame time per effect at 1920×1080 recorded as a number in CI rather than as
 * a vibe, failing an effect that cannot hold the target rate."* This is that check, and the honest
 * version of the sentence is longer.
 *
 * **This number is a regression signal, not a statement about anybody's real hardware.** It is
 * measured inside a container, in a headless Chromium, on whatever the machine offers — which in
 * continuous integration is a rented virtual machine with no graphics card at all, so Chromium
 * falls back to SwiftShader and paints every pixel of a 1920×1080 canvas on the processor (see the
 * `--enable-unsafe-swiftshader` note in `harness.mjs`). A shader that a mid-range GPU finishes in
 * under a millisecond can take tens of milliseconds there. Comparing these figures against "60 fps
 * on a streamer's machine" would be meaningless.
 *
 * What the figure *is* good for is comparison against itself. An effect that used to cost 30 ms a
 * frame in this environment and now costs 300 ms has had something go badly wrong — an accidental
 * `O(n²)` loop, geometry rebuilt every frame, a texture uploaded per particle — and that is exactly
 * the class of mistake that no type checker, linter or build catches, that nobody notices while
 * authoring on a fast desktop, and that turns into dropped frames on a live stream while a game is
 * also running for the GPU's attention.
 *
 * ## What is measured
 *
 * Two numbers per effect, both taken over a fixed window after the effect has warmed up:
 *
 *  1. **Frame interval** — the wall-clock gap between consecutive animation frames, reported as a
 *     median and a 95th percentile. This is end-to-end throughput: everything the page does per
 *     frame, including the time Chromium spends compositing what the effect drew. It is the number
 *     the budget is enforced against, because it is the one an operator would feel.
 *  2. **Callback time** — how long the animation-frame callback itself takes. Every effect draws
 *     from the SDK's single shared clock (`src/effects/sdk/clock.ts`), which runs on one
 *     `requestAnimationFrame` callback, so timing that callback isolates the effect's own CPU work
 *     from browser overhead. It is reported but **not** enforced: with a software renderer much of
 *     the drawing cost lands outside the callback, so a small number here does not mean the effect
 *     is cheap.
 *
 * Both come from a small patch on `requestAnimationFrame` installed before any application code
 * runs. It is deliberately kept here rather than added to `probe.mjs`: `probe.mjs` is installed in
 * *every* page of the whole harness, and wrapping every animation frame of every check to serve one
 * check would slow the other fourteen down and cloud what they measure.
 *
 * The route the effects are loaded through uses the stub backend's default canvas — 1920×1080 with
 * **no frame-rate cap** — which is what makes this a measurement of the effect rather than of the
 * cap. The renderer page lays its host `<div>` out at exactly that pixel size and then scales the
 * whole block with CSS to fit the browser window, so the effect really does draw two million pixels
 * even though the viewport is smaller. See the comment beside `renderer-host` in
 * `src/pages/RendererPage.tsx`.
 *
 * ## The budget, and how to recalibrate it
 *
 * The budgets below are *cliff detectors*, not targets. Each is set to roughly three times what the
 * effect actually measures here, so that a busy or slower machine cannot produce a red build on its
 * own, while a tenfold regression — the kind an accidental per-frame allocation or rebuild causes —
 * still fails. They catch "this became ten times more expensive", not "this got 20% slower".
 *
 * To recalibrate after adding effects or changing the environment:
 *
 *  1. Run `pnpm verify --only=perf` three times on an idle machine and read the `median` figure
 *     printed for every effect — the run prints the whole table whether it passes or fails.
 *  2. Take each effect's worst median across those runs.
 *  3. Set its budget to roughly three times that, rounded to something memorable, and say in the
 *     commit message what the measured spread was. An effect that needs a budget of its own gets an
 *     entry in `BUDGET_MS`; everything else uses `DEFAULT_BUDGET_MS`.
 *
 * A single run can also be overridden without editing this file, which is what to do when you are
 * investigating rather than changing the budget — it replaces every budget, including the per-effect
 * ones:
 *
 *     VERIFY_FRAME_BUDGET_MS=2000 pnpm verify --only=perf
 */

import { sleep, waitFor } from "../harness.mjs";
import { EFFECT_IDS } from "./effects.mjs";

/**
 * The default budget, in milliseconds per frame, that an effect's **median** frame interval must
 * stay under.
 *
 * 200 ms is five frames per second: an absurd bar for real hardware, and a deliberately loose one
 * for a full 1920×1080 canvas painted by SwiftShader on a shared machine. Measured here on
 * 2026-08-24, four of the six effects sat at the 16.7 ms the browser's 60 Hz frame clock allows at
 * all (that is, they never became the bottleneck), and `plasma-shader` — a full-screen fractal-noise
 * shader, the most expensive thing a software rasteriser can be asked for — sat at 51 ms.
 */
const DEFAULT_BUDGET_MS = 200;

/**
 * Effects whose honest cost in *this* environment is far above the default, with the measurement
 * that justifies each exemption.
 *
 * An entry here is a statement about software rendering, not a licence to be slow. `digital-rain`
 * measured 636 ms per frame on 2026-08-24, and the callback timing says the cost is JavaScript and
 * rasterisation of many glyphs rather than anything asynchronous: it redraws a screenful of text
 * every frame, and text is the one thing a CPU rasteriser is worst at. On a real GPU it is an
 * ordinary overlay. Failing it at the default budget would be reporting the container's lack of a
 * graphics card as a defect in the effect, and a check that cries wolf is a check people switch off.
 *
 * If a *new* effect needs an entry here, that is worth a conversation before it is added: two or
 * three exemptions are a calibration, a dozen are a check that has stopped meaning anything.
 *
 * ## The list is now at three, which is the limit that sentence describes
 *
 * The two halftone effects added on 2026-08-24 are the same failure as `digital-rain` and not a new
 * kind: all three draw **thousands of small filled shapes on the CPU every frame**, which a software
 * rasteriser handles worst of anything. The callback timings say so directly — of
 * `toxic-marble-dots`' 300 ms, only 63 ms is its own JavaScript; the rest is Pixi rasterising 14,400
 * circles without a graphics card. On a real GPU each of these is one batched draw call.
 *
 * ## It is now at five, which is past that limit — read this before adding a sixth
 *
 * Two more were added on 2026-08-25 with the last of the ported effects, and the list has now grown
 * beyond the size the paragraph above warns about. That is worth stating plainly rather than
 * quietly appending to it.
 *
 * `starting-soon-fluid` was **optimised first**, exactly as the rule above demands: its spatial hash
 * was rebuilding a neighbour array for every particle every frame, and replacing that with in-place
 * iteration took its own JavaScript from 76.7 ms to 68.5 ms a frame. The frame time did not move,
 * because roughly 148 ms of its 216 ms is Pixi rasterising four thousand circles without a graphics
 * card. There was nothing else in our code to remove.
 *
 * `hologram-glitch` has a callback median of **0.3 ms**. Every millisecond of its 283 is the fragment
 * shader running on SwiftShader. There is no JavaScript to optimise at all.
 *
 * So all five entries are one failure — CPU rasterisation of work a GPU does trivially — and the
 * fix is structural rather than per-effect:
 *
 *  1. Run this check on a machine with a real GPU in CI, where none of the five would need an entry.
 *  2. Or draw dot fields as instanced sprites rather than thousands of filled paths.
 *
 * Until one of those happens, exempting them reports the truth — the container has no graphics card —
 * instead of blaming the effect. **A sixth entry should not be added without doing (1) or (2) first.**
 */
const BUDGET_MS = {
  // Measured 636 ms on 2026-08-24; a screenful of text redrawn every frame.
  "digital-rain": 2400,
  // Measured 300 ms median (p95 567 ms) on 2026-08-24: 14,400 circles per frame at the default
  // Spacing of 12, of which 63 ms is the effect's own field evaluation.
  "toxic-marble-dots": 900,
  // Measured 217 ms median (p95 233 ms) on 2026-08-24: about 10,600 circles per frame at the
  // default Spacing of 14, of which 43 ms is the effect's own JavaScript.
  "razer-halftone-fade": 700,
  // Measured 283 ms median (p95 283 ms) on 2026-08-25, with a callback median of 0.3 ms — the whole
  // cost is a large fragment shader on a software rasteriser. Nothing in JavaScript to optimise.
  "hologram-glitch": 900,
  // Measured 217 ms median (p95 233 ms) on 2026-08-25, callback median 68.5 ms after the spatial
  // hash was optimised (down from 76.7 ms). The remaining ~148 ms is rasterising ~4,000 circles.
  "starting-soon-fluid": 700,
};

/**
 * The budget one effect is held to.
 *
 * `VERIFY_FRAME_BUDGET_MS` overrides every effect at once, which is for investigating rather than
 * for changing what CI enforces — an override in the environment leaves no trace in the repository.
 */
function budgetFor(effectId) {
  const override = Number(process.env.VERIFY_FRAME_BUDGET_MS);
  if (Number.isFinite(override) && override > 0) return override;
  return BUDGET_MS[effectId] ?? DEFAULT_BUDGET_MS;
}

/**
 * How long each effect is given to settle before measuring.
 *
 * The first frames of an effect are not representative of any later frame: shaders are compiled and
 * linked, textures are uploaded, Pixi picks a backend, and Chromium is still laying the page out.
 * Measuring those would report the cost of starting rather than the cost of running.
 */
const WARMUP_MS = 2500;

/** How long the measurement window itself lasts. Long enough to hold dozens of frames. */
const MEASURE_MS = 5000;

/**
 * The fewest frames a window must contain before its numbers are treated as a measurement.
 *
 * A median over a handful of samples is coarse, and five is genuinely few. It is set this low
 * because the alternative is worse: `digital-rain` honestly draws only six or seven frames in five
 * seconds under software rendering, and demanding a dozen would fail it for being slow *in a way its
 * own budget already allows for* — which is the check contradicting itself rather than reporting
 * anything. Precision beyond a handful of samples buys nothing here anyway, since every budget is
 * three times the measured cost.
 *
 * Below five, the number is not a measurement at all: an effect drawing fewer than one frame a
 * second in this window has either stopped or never started, and that is reported as a failure with
 * the raw count attached rather than as a confident-looking statistic.
 */
const MIN_FRAMES = 5;

/**
 * The animation-frame timer, injected before the application's own scripts.
 *
 * It is a string for the same reason `probe.mjs` is one: it does not run in this Node process. It
 * wraps `requestAnimationFrame` so that each callback is timed, and it records nothing at all until
 * `start()` is called, so the warm-up costs nothing and cannot contaminate the window.
 *
 * ## Why every sample carries the frame's timestamp
 *
 * There is usually more than one animation-frame callback per frame. The SDK's shared clock is one;
 * Pixi and three.js schedule their own for internal bookkeeping, and so does anything else on the
 * page. Timing each callback and treating each as a frame gave a nonsense answer the first time this
 * check ran: two effects were reported at "1 ms per frame, ~1000 fps", because the gaps being
 * averaged were the sub-millisecond distances between two callbacks *inside* one frame rather than
 * the distance between frames.
 *
 * The fix is the argument the browser passes to every animation-frame callback: a timestamp that is
 * **identical for every callback of the same frame**. Recording it alongside each measurement lets
 * the samples be grouped back into real frames on this side — the gaps then come from distinct frame
 * timestamps, and each frame's callback cost is the sum of the callbacks that ran in it.
 *
 * The wrapper calls through unconditionally and returns what the original returned, so the page
 * behaves exactly as it would without it — apart from two `performance.now()` calls per callback,
 * which are tens of nanoseconds each.
 */
const SAMPLER_SOURCE = `
(() => {
  if (window.__perf) return;

  // One entry per callback: the frame timestamp it belongs to, and how long it took.
  const perf = { recording: false, samples: [] };
  window.__perf = perf;

  const original = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function (callback) {
    return original(function (now) {
      const startedAt = window.performance.now();
      try {
        return callback(now);
      } finally {
        if (perf.recording) {
          perf.samples.push({ frame: now, ms: window.performance.now() - startedAt });
        }
      }
    });
  };

  perf.start = () => {
    perf.samples.length = 0;
    perf.recording = true;
  };

  perf.stop = () => {
    perf.recording = false;
    return perf.samples.slice();
  };
})();
`;

/** The value below which `fraction` of the sorted samples lie. `quantile(xs, 0.5)` is the median. */
function quantile(sorted, fraction) {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((sorted.length - 1) * fraction)),
  );
  return sorted[index];
}

/**
 * Groups the raw per-callback samples back into frames.
 *
 * Returns the gap between consecutive frames, and the total callback time spent in each frame. See
 * the note above {@link SAMPLER_SOURCE} for why the grouping is necessary.
 */
function toFrames(samples) {
  const costPerFrame = new Map();
  for (const sample of samples) {
    costPerFrame.set(sample.frame, (costPerFrame.get(sample.frame) ?? 0) + sample.ms);
  }
  const stamps = [...costPerFrame.keys()].sort((a, b) => a - b);

  const gaps = [];
  for (let i = 1; i < stamps.length; i += 1) gaps.push(stamps[i] - stamps[i - 1]);

  return { count: stamps.length, gaps, callbackMs: stamps.map((at) => costPerFrame.get(at)) };
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : value;
}

/**
 * Measures every effect at the route's full canvas size and reports one assertion each.
 *
 * One page per effect, closed before the next opens, for the same reason `checkEveryEffectDraws`
 * does it: a leak or a runaway loop left by one effect would otherwise be charged to the next.
 */
export async function checkFrameBudget({ stub, baseUrl, browser, results, target }) {
  const slug = "perf-probe";
  /** Collected so the summary line can print every effect's cost next to every other's. */
  const measured = [];

  for (const effectId of EFFECT_IDS) {
    // `canvas` is spelled out rather than left to the stub's default so that this check states the
    // size it claims to measure at. `fpsCap: null` is the load-bearing part: a cap would make every
    // effect measure the cap instead of itself.
    stub.saveRoute({
      slug,
      effectId,
      enabled: true,
      params: {},
      canvas: { width: 1920, height: 1080, fpsCap: null },
    });

    const { context, page, recorder } = await browser.newPage({ initScript: SAMPLER_SOURCE });
    try {
      await page.goto(`${baseUrl}/e/${slug}`, { waitUntil: "domcontentloaded" });
      await waitFor(async () => page.evaluate(() => window.__probe.canvasIdIn(".renderer-host")), {
        timeout: 20_000,
        what: `a canvas for ${effectId}`,
      });

      await sleep(WARMUP_MS);
      await page.evaluate(() => window.__perf.start());
      await sleep(MEASURE_MS);
      const samples = await page.evaluate(() => window.__perf.stop());

      const frames = toFrames(samples);
      const gaps = frames.gaps.slice().sort((a, b) => a - b);
      const callbacks = frames.callbackMs.slice().sort((a, b) => a - b);
      const medianGap = quantile(gaps, 0.5);
      const worstGap = quantile(gaps, 0.95);
      const medianCallback = quantile(callbacks, 0.5);
      const fps = medianGap > 0 ? 1000 / medianGap : 0;
      const budget = budgetFor(effectId);

      const enough = frames.count >= MIN_FRAMES;
      const withinBudget = enough && medianGap <= budget;
      const detail =
        `median ${round(medianGap)} ms/frame (~${round(fps)} fps), ` +
        `p95 ${round(worstGap)} ms, callback median ${round(medianCallback)} ms, ` +
        `${frames.count} frames in ${MEASURE_MS} ms, budget ${budget} ms`;

      measured.push({ effectId, medianGap, fps });

      results.ok(
        withinBudget,
        `[${target}] ${effectId} holds its frame budget at 1920×1080`,
        enough ? detail : `only ${frames.count} frames drawn — ${detail}`,
      );
      results.ok(
        recorder.consoleErrors.length === 0 && recorder.pageErrors.length === 0,
        `[${target}] ${effectId} logs nothing while under measurement`,
        [...recorder.consoleErrors, ...recorder.pageErrors].join(" | ") || "none",
      );
    } catch (error) {
      results.broke(`[${target}] ${effectId} frame budget`, error);
    } finally {
      await context.close();
    }
  }

  /*
   * Printed rather than asserted. The whole point of writing the budget down as a number is that
   * somebody can read the numbers over time, and a table in the log is where they come from — the
   * pass/fail lines above only ever say whether the cliff was hit.
   */
  if (measured.length > 0) {
    const table = measured
      .slice()
      .sort((a, b) => b.medianGap - a.medianGap)
      .map(
        (row) =>
          `      ${row.effectId.padEnd(20)} ${round(row.medianGap)} ms  (~${round(row.fps)} fps)`,
      )
      .join("\n");
    console.log(
      `\n    frame cost at 1920×1080, most expensive first (software rendering):\n${table}`,
    );
  }
}
