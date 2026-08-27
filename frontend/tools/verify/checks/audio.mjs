/**
 * Checks for the OBS audio path: does what the backend sends actually reach the pixels?
 *
 * ## Why this check exists
 *
 * Every other check here would pass with the audio feature completely broken. `effects-draw` asks
 * whether `audio-bars` paints *something*, and a bus stuck on its simulated fallback paints a great
 * deal of something — a full, lively spectrum. That is the trap this file is built around: the
 * failure mode of this feature is not a blank screen, it is a **plausible** screen showing invented
 * audio while the real levels go nowhere.
 *
 * So these checks never ask "did it draw". They change what the server is sending and assert that
 * what is drawn changes *with* it, in the direction it should.
 *
 * ## What is and is not covered
 *
 * Covered: the browser half, end to end — the Server-Sent Events stream, the SDK's audio bus, the
 * easing, the staleness watchdog, and an effect reacting to all of it.
 *
 * Not covered: the obs-websocket connection itself. The stub speaks the *level stream*, which is
 * this project's own contract, not OBS's protocol. Standing up a fake obs-websocket server is
 * written up as the open item under roadmap 3.4.
 */

import { sleep, waitFor } from "../harness.mjs";
import { summarisePng } from "../png.mjs";

/** How long an effect is given to settle onto a new audio level before it is photographed.
 *
 * Comfortably longer than the bus's 180 ms release, so a fall has finished falling. */
const SETTLE_MS = 1500;

/** A measurement loud enough that a spectrum fills a good part of the frame. */
function loud(peak = 0.85) {
  return {
    at: Date.now(),
    peak,
    inputs: [{ inputName: "Desktop Audio", peak, channels: [peak, peak * 0.9] }],
  };
}

/** A measurement of an input that exists and is making no sound. Not the same as no connection. */
function silent() {
  return {
    at: Date.now(),
    peak: 0,
    inputs: [{ inputName: "Desktop Audio", peak: 0, channels: [0] }],
  };
}

async function paintedPixels(page) {
  const shot = await page.screenshot({ omitBackground: true });
  return summarisePng(shot).painted;
}

async function openBars(browser, baseUrl, stub) {
  const slug = "audio-probe";
  stub.saveRoute({ slug, effectId: "audio-bars", enabled: true, params: {} });
  const opened = await browser.newPage();
  await opened.page.goto(`${baseUrl}/e/${slug}`, { waitUntil: "domcontentloaded" });
  await waitFor(
    async () => opened.page.evaluate(() => window.__probe.canvasIdIn(".renderer-host")),
    {
      timeout: 20_000,
      what: "a canvas inside .renderer-host",
    },
  );
  return opened;
}

/**
 * An audio-reactive effect follows the levels the server sends.
 *
 * Loud audio must paint substantially more than silent audio. The exact numbers are not asserted —
 * they depend on the effect's parameters and on the renderer — only the relationship, which is the
 * part that is true by design rather than by accident.
 */
export async function checkEffectFollowsObsLevels({ stub, baseUrl, browser, results, target }) {
  const previous = stub.state.audioLevels;
  stub.state.audioLevels = loud();

  const { context, page, recorder } = await openBars(browser, baseUrl, stub);
  try {
    await sleep(SETTLE_MS);
    const whenLoud = await paintedPixels(page);

    stub.state.audioLevels = silent();
    await sleep(SETTLE_MS);
    const whenSilent = await paintedPixels(page);

    stub.state.audioLevels = loud();
    await sleep(SETTLE_MS);
    const loudAgain = await paintedPixels(page);

    results.ok(
      whenLoud > 0,
      `[${target}] audio-bars paints while the stream reports loud audio`,
      `painted ${whenLoud}px`,
    );

    /*
     * The core assertion of this file. If the SSE path were broken and the bus had fallen back to
     * its simulation, this would fail: a simulated signal keeps moving regardless of what the
     * server says, so silence would paint just as much as noise.
     */
    results.ok(
      whenSilent < whenLoud / 2,
      `[${target}] silence from OBS visibly quietens the effect`,
      `loud ${whenLoud}px vs silent ${whenSilent}px`,
    );

    // And it comes back — a level that falls must not latch the effect off.
    results.ok(
      loudAgain > whenSilent * 2,
      `[${target}] the effect recovers when the audio returns`,
      `silent ${whenSilent}px then ${loudAgain}px`,
    );

    results.ok(
      recorder.consoleErrors.length === 0 && recorder.pageErrors.length === 0,
      `[${target}] no console or page errors while following audio`,
      [...recorder.consoleErrors, ...recorder.pageErrors].join(" | ") || "none",
    );
  } finally {
    stub.state.audioLevels = previous;
    await context.close();
  }
}

/**
 * A stream that stops delivering falls back to the simulated signal rather than freezing.
 *
 * This is the behaviour that keeps a live broadcast from showing a dead overlay when OBS is closed
 * mid-stream, and it is invisible in every other check. The bus gives up on a stream after six
 * seconds of nothing, so this check has to wait that long and is marked slow.
 *
 * Note what is being asserted: **not** that the picture is identical to a working one, but that the
 * effect is still moving. A frozen effect and a simulated one both paint pixels; only one of them
 * paints *different* pixels from one moment to the next.
 */
export async function checkStaleStreamFallsBackToSimulation({
  stub,
  baseUrl,
  browser,
  results,
  target,
}) {
  const previous = stub.state.audioLevels;
  stub.state.audioLevels = silent();

  const { context, page, recorder } = await openBars(browser, baseUrl, stub);
  try {
    await sleep(SETTLE_MS);
    const whileConnectedAndSilent = await paintedPixels(page);

    // Cut the stream. From the page's point of view this is OBS being closed, or the backend going
    // away: the connection drops and every reconnection `EventSource` attempts is refused too.
    //
    // Only the *audio* stream is cut. The route stream is deliberately left working, so this is a
    // check about audio and not about the renderer losing its configuration as well.
    stub.state.audioStream = "absent";
    stub.killAudioStreams();

    // Six seconds of staleness plus slack, then let the simulated signal rise.
    await sleep(9000);
    const firstShot = await paintedPixels(page);
    await sleep(1200);
    const secondShot = await paintedPixels(page);

    results.ok(
      firstShot > 0 && secondShot > 0,
      `[${target}] a dead stream still leaves the effect drawing`,
      `${firstShot}px then ${secondShot}px`,
    );

    results.ok(
      firstShot !== secondShot,
      `[${target}] the fallback signal is animating, not a frozen last frame`,
      `${firstShot}px then ${secondShot}px`,
    );

    results.ok(
      Math.max(firstShot, secondShot) > whileConnectedAndSilent,
      `[${target}] the fallback is livelier than the real silence it replaced`,
      `connected-silent ${whileConnectedAndSilent}px, stale ${Math.max(firstShot, secondShot)}px`,
    );

    /*
     * Page errors only, and the difference matters.
     *
     * A `pageError` is an uncaught exception in our own JavaScript — always a defect. A
     * `consoleError` here is the *browser* reporting the network failure this check deliberately
     * caused: destroying an in-flight event-stream socket produces
     * `net::ERR_INCOMPLETE_CHUNKED_ENCODING`, and each refused reconnection produces
     * `net::ERR_EMPTY_RESPONSE`. Those are Chromium describing reality accurately. Nothing in the
     * page can suppress them, and asserting they do not happen would be asserting that cutting a
     * connection does not cut it.
     *
     * What must hold is that our code survives it without throwing, which is what this asserts.
     */
    results.ok(
      recorder.pageErrors.length === 0,
      `[${target}] no uncaught exceptions while the stream is down`,
      recorder.pageErrors.join(" | ") || "none",
    );
  } finally {
    stub.state.audioStream = "normal";
    stub.state.audioLevels = previous;
    await context.close();
  }
}
