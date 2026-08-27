/**
 * Checks about the effects themselves: do all six draw, is each one torn down exactly once, and
 * does the renderer tell a parameter change from an effect change.
 *
 * These are the checks Phase 3 will run most often — every time an effect is rewritten — which is
 * why "does it draw" is measured in pixels rather than by looking for a `<canvas>` element. A
 * canvas that exists and paints nothing is precisely the failure that reaches a live stream.
 */

import { probeReport, sleep, waitFor } from "../harness.mjs";
import { summarisePng } from "../png.mjs";

/** Every effect this build ships, in the order `src/effects/index.ts` lists them. */
export const EFFECT_IDS = [
  "starfield-warp",
  "plasma-shader",
  "camera-frame-ring",
  "particle-drift",
  "digital-rain",
  "audio-bars",
  // Ported from the old obs-effects repository.
  "razer-toxic-marble",
  "toxic-marble-dots",
  "toxic-dev-terminal",
  "toxic-dev-corrupt",
  "red-corrupt",
  "amber-terminal",
  "glitch-terminal",
  "audio-waveform-razer",
  "audio-waveform-razer-prism",
  "audio-waveform-razer-spectrum",
  "audio-waveform-razer-weave",
  "audio-waveform-razer-helix",
  "audio-waveform-razer-ribbons",
  "audio-waveform-razer-ribbon-bands",
  "audio-waveform-razer-ribbon-lattice",
  "razer-bg-coding",
  "razer-bg-gaming",
  "razer-bg-talking",
  "razer-cam-border-rect",
  "razer-cam-border-rhombic",
  "razer-cam-border-fluid",
  "razer-audio-cam-border",
  "razer-screen-share-border",
  "razer-diagonal-streaks",
  "razer-halftone-fade",
  "razer-aether-drift",
  "razer-corner-accents",
  "razer-status-line",
  "razer-logo-mark",
  "ink-dissolve-razer",
  "glitch-veil",
  "data-corruption",
  "glitch-ape",
  "hologram-glitch",
  "glitch-overlay",
  "star-field",
  "animated-lines",
  "cat-mesh",
  "logo",
  "starting-soon-fluid",
  "worxbend-3d-text",
  "worxbend-text",
  "ember-pentagram-overlay",
  "procedural-logo",
  "main-web-cam-border",
];

/**
 * Parameters to load an effect with, for the few whose *default* behaviour is to be invisible most
 * of the time.
 *
 * `data-corruption` is the reason this exists. It is a deliberately intermittent overlay: between
 * events it draws literally nothing, and its default gap is 3 to 11 seconds. Photographing it at an
 * arbitrary moment and asserting it painted something would fail most of the time — not because the
 * effect is broken, but because it is working exactly as designed.
 *
 * The alternative was to poll for ten seconds waiting for a burst, which would make this check the
 * slowest in the suite for one effect. Driving it with parameters that make events continuous tests
 * the same drawing code and finishes immediately.
 *
 * What this does *not* test is the scheduling — that an event ends, that the gap is respected, that
 * clusters fire. That is worth being explicit about: this check proves the effect can draw, not that
 * it draws at the right times.
 */
const EFFECT_PARAMS = {
  "data-corruption": { gapMin: 0.1, gapMax: 0.2, duration: 1.5, intensity: 3 },
  /*
   * `glitch-veil` needs both halves of this.
   *
   * The burst settings keep it almost permanently mid-burst, because its default is 2 to 6 seconds
   * of quiet between short bursts and a screenshot would usually land in the quiet.
   *
   * The scanline opacity matters for a subtler reason. Between bursts the only thing drawn is the
   * scan band, whose four rows differ solely in alpha — and at the default 0.035 those alphas
   * quantise to the same 8-bit value, so the frame contains exactly one distinct colour and fails
   * the "at least two colours" half of the assertion. Raising it separates them. The effect is not
   * broken at its default; the measurement cannot resolve it.
   */
  "glitch-veil": {
    burstGapMin: 0.05,
    burstGapMax: 0.1,
    burstLength: 4,
    intensity: 3,
    scanlines: 0.3,
  },
  // A full loop is ~25 seconds and part of it is deliberately blank. Running it fast means the
  // screenshot lands somewhere mid-draw whenever it is taken, rather than in the blank phase.
  "animated-lines": { speed: 4 },
};

/** How long an effect is given to get past its first frame before it is photographed. */
const DRAW_SETTLE_MS = 2000;

/**
 * The share of the page an effect must paint to count as drawing something.
 *
 * It is deliberately tiny. `starfield-warp` at rest is a scattering of single-pixel points on a
 * fully transparent page, so a threshold chosen to look reasonable for a full-screen plasma field
 * would reject a perfectly healthy starfield. The check that carries the weight is the absolute
 * pixel count next to it: a page that drew nothing scores exactly zero, and there is a very wide
 * gap between zero and a thousand.
 */
const MIN_PAINTED_FRACTION = 0.0005;
const MIN_PAINTED_PIXELS = 500;

/**
 * Photographs the renderer page and says how much of it is painted.
 *
 * `omitBackground` is what makes this measurement simple: the renderer page is transparent by
 * design, so the screenshot comes back with an alpha channel in which every non-zero pixel is
 * something an effect put there. See the long note at the top of `png.mjs`.
 */
async function paintStats(page) {
  const shot = await page.screenshot({ omitBackground: true });
  return summarisePng(shot);
}

/** Waits until a canvas exists inside the renderer host and reports its probe identity. */
async function waitForCanvas(page, { timeout = 20_000 } = {}) {
  return waitFor(async () => page.evaluate(() => window.__probe.canvasIdIn(".renderer-host")), {
    timeout,
    what: "a canvas inside .renderer-host",
  });
}

/**
 * Every effect mounts and paints something.
 *
 * One page per effect, deliberately. Sharing a page would let a leak from one effect show up as a
 * failure in the next, and this check is supposed to answer one question per effect.
 */
export async function checkEveryEffectDraws({ stub, baseUrl, browser, results, target }) {
  for (const effectId of EFFECT_IDS) {
    const slug = "draw-probe";
    stub.saveRoute({ slug, effectId, enabled: true, params: EFFECT_PARAMS[effectId] ?? {} });

    const { context, page, recorder } = await browser.newPage();
    try {
      await page.goto(`${baseUrl}/e/${slug}`, { waitUntil: "domcontentloaded" });
      await waitForCanvas(page);
      await sleep(DRAW_SETTLE_MS);

      const stats = await paintStats(page);
      const canvases = await page.evaluate(() => window.__probe.canvasCountIn(".renderer-host"));
      const drew =
        stats.painted >= MIN_PAINTED_PIXELS &&
        stats.paintedFraction >= MIN_PAINTED_FRACTION &&
        stats.distinctColours >= 2;

      results.ok(
        drew,
        `[${target}] ${effectId} paints a non-blank canvas`,
        `${stats.painted}/${stats.pixels} px painted (${(stats.paintedFraction * 100).toFixed(2)}%), ` +
          `${stats.distinctColours} distinct colours, ${canvases} canvas in the host`,
      );
      results.ok(
        canvases === 1,
        `[${target}] ${effectId} leaves exactly one canvas in the host`,
        `found ${canvases}`,
      );
      results.ok(
        recorder.consoleErrors.length === 0 && recorder.pageErrors.length === 0,
        `[${target}] ${effectId} logs no console or page errors`,
        [...recorder.consoleErrors, ...recorder.pageErrors].join(" | ") || "none",
      );
    } catch (error) {
      results.broke(`[${target}] ${effectId} draws`, error);
    } finally {
      await context.close();
    }
  }
}

/**
 * Twenty mount/dispose cycles leave no WebGL context behind, and dispose runs exactly once each.
 *
 * The two numbers that matter are explained at the top of `probe.mjs`: **live** contexts (created
 * minus lost, which ignores the throwaway contexts Pixi creates to inspect the GPU) and the count
 * of `loseContext()` calls, which the Three.js effects make once each from `dispose()`.
 */
export async function checkMountDisposeCycles({ stub, baseUrl, browser, results, target }) {
  const slug = "cycle-probe";
  // Two Three.js effects, because their `dispose()` ends in `renderer.forceContextLoss()` — the
  // call the probe counts. A cycle between two Pixi effects would prove the contexts do not leak
  // but could not prove how many times each one was torn down.
  const pair = ["starfield-warp", "plasma-shader"];
  const cycles = 20;

  stub.saveRoute({ slug, effectId: pair[0], enabled: true, params: {} });

  const { context, page, recorder } = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/e/${slug}`, { waitUntil: "domcontentloaded" });
    await waitForCanvas(page);
    await sleep(1000);

    const before = await probeReport(page);
    let previousCanvasId = await page.evaluate(() => window.__probe.canvasIdIn(".renderer-host"));
    let mostCanvasesAtOnce = 1;

    for (let cycle = 0; cycle < cycles; cycle += 1) {
      const effectId = pair[(cycle + 1) % pair.length];
      stub.saveRoute({ slug, effectId, enabled: true, params: EFFECT_PARAMS[effectId] ?? {} });

      const settled = previousCanvasId;
      const nextCanvasId = await waitFor(
        async () => {
          const id = await page.evaluate(() => window.__probe.canvasIdIn(".renderer-host"));
          return id !== null && id !== settled ? id : null;
        },
        { timeout: 20_000, what: `cycle ${cycle + 1} to swap the canvas` },
      );
      previousCanvasId = nextCanvasId;

      const canvases = await page.evaluate(() => window.__probe.canvasCountIn(".renderer-host"));
      mostCanvasesAtOnce = Math.max(mostCanvasesAtOnce, canvases);
    }

    await sleep(1000);
    const after = await probeReport(page);

    const liveDelta = after.contextsLive - before.contextsLive;
    const loseDelta = after.loseCalls - before.loseCalls;

    results.ok(
      liveDelta === 0,
      `[${target}] ${cycles} mount/dispose cycles leave live WebGL contexts flat`,
      `live ${before.contextsLive} → ${after.contextsLive} (delta ${liveDelta}); ` +
        `raw contexts created ${before.contextsCreated} → ${after.contextsCreated}`,
    );
    results.ok(
      loseDelta === cycles,
      `[${target}] each of the ${cycles} disposals released its context exactly once`,
      `loseContext() calls during the cycles: ${loseDelta}`,
    );
    results.ok(
      after.contextsLosedTwice === 0,
      `[${target}] no WebGL context was released twice (no double dispose)`,
      `contexts with more than one loseContext() call: ${after.contextsLosedTwice}`,
    );
    results.ok(
      mostCanvasesAtOnce === 1,
      `[${target}] the host div never holds more than one canvas`,
      `highest observed: ${mostCanvasesAtOnce}`,
    );
    results.ok(
      recorder.consoleErrors.length === 0 && recorder.pageErrors.length === 0,
      `[${target}] the cycle run logs no console or page errors`,
      [...recorder.consoleErrors, ...recorder.pageErrors].join(" | ") || "none",
    );
  } catch (error) {
    results.broke(`[${target}] ${cycles} mount/dispose cycles`, error);
  } finally {
    await context.close();
  }
}

/**
 * A parameter change updates the running effect; an effect change replaces it.
 *
 * The observable difference is the identity of the `<canvas>` element and the number of WebGL
 * contexts that have ever been created. A `setParams` call changes neither. A remount changes
 * both. Nothing here has to reach inside the application to know which happened.
 */
export async function checkParamChangeDoesNotRemount({ stub, baseUrl, browser, results, target }) {
  const slug = "params-probe";
  /*
   * `camera-frame-ring` is chosen for a reason: its `thickness` parameter changes how much of the
   * page it paints, by a lot, so "the running effect received the new values" can be measured in
   * pixels rather than assumed from the absence of a remount. The two animated parameters are
   * turned off so that the only thing which can move the number is the parameter under test.
   */
  const still = { pulseAmount: 0, rotationSpeed: 0 };
  stub.saveRoute({
    slug,
    effectId: "camera-frame-ring",
    enabled: true,
    params: { ...still, thickness: 0.01 },
  });

  const { context, page, recorder } = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/e/${slug}`, { waitUntil: "domcontentloaded" });
    const firstCanvas = await waitForCanvas(page);
    await sleep(1500);
    const beforeParams = await probeReport(page);
    const thinRing = await paintStats(page);

    // A parameter-only save: same effect, different values, new `updatedAt`.
    stub.saveRoute({
      slug,
      effectId: "camera-frame-ring",
      enabled: true,
      params: { ...still, thickness: 0.35 },
    });
    await sleep(2500);

    const afterParams = await probeReport(page);
    const thickRing = await paintStats(page);
    const canvasAfterParams = await page.evaluate(() =>
      window.__probe.canvasIdIn(".renderer-host"),
    );

    results.ok(
      canvasAfterParams === firstCanvas,
      `[${target}] a parameter-only change keeps the same canvas (no remount)`,
      `canvas id ${firstCanvas} → ${canvasAfterParams}`,
    );
    results.ok(
      thickRing.painted > thinRing.painted * 2,
      `[${target}] a parameter-only change reaches the running effect (setParams, not a remount)`,
      `painted pixels ${thinRing.painted} → ${thickRing.painted} after thickness 0.01 → 0.35`,
    );
    results.ok(
      afterParams.contextsCreated === beforeParams.contextsCreated,
      `[${target}] a parameter-only change creates no new WebGL context`,
      `contexts created ${beforeParams.contextsCreated} → ${afterParams.contextsCreated}`,
    );
    results.ok(
      afterParams.loseCalls === beforeParams.loseCalls,
      `[${target}] a parameter-only change disposes nothing`,
      `loseContext() calls ${beforeParams.loseCalls} → ${afterParams.loseCalls}`,
    );

    // An effect change: the old instance must go and a new one must arrive.
    stub.saveRoute({ slug, effectId: "starfield-warp", enabled: true, params: {} });
    const secondCanvas = await waitFor(
      async () => {
        const id = await page.evaluate(() => window.__probe.canvasIdIn(".renderer-host"));
        return id !== null && id !== firstCanvas ? id : null;
      },
      { timeout: 20_000, what: "the effect swap to replace the canvas" },
    );
    await sleep(1000);
    const afterSwap = await probeReport(page);

    results.ok(
      secondCanvas !== firstCanvas,
      `[${target}] an effectId change replaces the canvas (remount)`,
      `canvas id ${firstCanvas} → ${secondCanvas}`,
    );
    results.ok(
      afterSwap.loseCalls === afterParams.loseCalls + 1,
      `[${target}] the outgoing effect was disposed exactly once on the swap`,
      `loseContext() calls ${afterParams.loseCalls} → ${afterSwap.loseCalls}`,
    );
    results.ok(
      (await page.evaluate(() => window.__probe.canvasCountIn(".renderer-host"))) === 1,
      `[${target}] exactly one canvas survives the swap`,
    );
    results.ok(
      recorder.consoleErrors.length === 0 && recorder.pageErrors.length === 0,
      `[${target}] the parameter/effect change run logs no console or page errors`,
      [...recorder.consoleErrors, ...recorder.pageErrors].join(" | ") || "none",
    );
  } catch (error) {
    results.broke(`[${target}] parameter change versus effect change`, error);
  } finally {
    await context.close();
  }
}
