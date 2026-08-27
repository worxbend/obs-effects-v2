/**
 * Checks about `/e/:slug`, the page an OBS browser source points at.
 *
 * The subtle one is the arbitration between the event stream and the fallback poll. The contract
 * states it as an invariant — *exactly one* of "the stream is healthy" and "the five-second poll is
 * running" is true at any moment — and both halves of that are failures nobody would notice by
 * looking at the screen: two sources running doubles the traffic forever, and neither running
 * freezes a live scene on settings that are no longer correct.
 *
 * So it is measured by counting requests at the backend rather than by reading the page.
 */

import { probeReport, sleep, waitFor } from "../harness.mjs";
import { summarisePng } from "../png.mjs";

/** The renderer's own poll interval, from `POLL_INTERVAL_MS` in `RendererPage.tsx`. */
const POLL_INTERVAL_MS = 5000;

/**
 * The stream is trusted, so the poll stops; when the stream dies, the poll comes back.
 *
 * The numbers to read in the output are the poll counts. A silent window of thirteen seconds is
 * two-and-a-half poll intervals, so a poll that was still running would have added at least two
 * requests to it.
 */
export async function checkStreamSuppressesPoll({ stub, baseUrl, browser, results, target }) {
  const slug = "sse-probe";
  stub.state.streamMode = "normal";
  stub.saveRoute({ slug, effectId: "plasma-shader", enabled: true, params: {} });

  const { context, page, recorder } = await browser.newPage();
  try {
    stub.resetCounts();
    await page.goto(`${baseUrl}/e/${slug}`, { waitUntil: "domcontentloaded" });
    await waitFor(
      async () => (await page.evaluate(() => window.__probe.canvasIdIn(".renderer-host"))) !== null,
      {
        timeout: 20_000,
        what: "the first effect to mount",
      },
    );
    await waitFor(() => stub.openStreams() === 1, {
      timeout: 10_000,
      what: "the event stream to open",
    });

    // Let the opening snapshot arrive and stop the poll, then measure a quiet window.
    await sleep(2000);
    const pollsAtStart = stub.count(`POLL ${slug}`);
    await sleep(13_000);
    const pollsWhileStreaming = stub.count(`POLL ${slug}`) - pollsAtStart;

    results.ok(
      pollsWhileStreaming === 0,
      `[${target}] the poll is dormant while the stream delivers`,
      `${pollsWhileStreaming} polls in 13s (${Math.floor(13_000 / POLL_INTERVAL_MS)} were due if it had kept running); ` +
        `${stub.count(`POLL ${slug}`)} polls in total since load, ${stub.count(`SSE ${slug}`)} stream connections`,
    );
    results.ok(
      stub.count(`POLL ${slug}`) === 1,
      `[${target}] exactly one ordinary GET is made, for the first frame`,
      `total polls: ${stub.count(`POLL ${slug}`)}`,
    );

    /* ---- kill the stream: the poll must come back ---- */

    stub.state.streamMode = "refused";
    stub.killStreams();
    const pollsBeforeKill = stub.count(`POLL ${slug}`);
    const killedAt = Date.now();
    /*
     * The timeout is generous because the *recovery route* legitimately differs between the two
     * targets, and both are correct behaviour:
     *
     *  - served directly (the production bundle here, and a reverse proxy in front of the real
     *    backend), the browser sees the connection drop, `EventSource` fires `error`, and the page
     *    falls back within a second;
     *  - through the Vite development proxy, the browser's own connection to Vite stays open after
     *    the upstream dies, so nothing looks broken and the page has to notice the *silence*
     *    instead — which its 45-second watchdog does.
     *
     * That second case is not an artefact of the harness. It is precisely the reverse-proxy
     * failure the watchdog was written for, and it is what `make up` serves, so it is worth seeing
     * measured rather than hidden behind a short timeout. The recovery time is reported either way.
     */
    await waitFor(() => stub.count(`POLL ${slug}`) > pollsBeforeKill, {
      timeout: 70_000,
      what: "the fallback poll to resume after the stream died",
    });
    const recoveredAfterMs = Date.now() - killedAt;
    await sleep(11_000);
    const pollsAfterKill = stub.count(`POLL ${slug}`) - pollsBeforeKill;

    results.ok(
      pollsAfterKill >= 2,
      `[${target}] the poll resumes when the stream dies`,
      `first poll ${(recoveredAfterMs / 1000).toFixed(1)}s after the stream was destroyed, ` +
        `then ${pollsAfterKill} polls in the ~11s that followed`,
    );

    /* ---- restore the stream: the poll must stop again ---- */

    stub.state.streamMode = "normal";
    await waitFor(() => stub.openStreams() === 1, {
      timeout: 30_000,
      what: "the client to reopen the stream",
    });
    await sleep(2000);
    const pollsBeforeQuiet = stub.count(`POLL ${slug}`);
    await sleep(12_000);
    const pollsWhileStreamingAgain = stub.count(`POLL ${slug}`) - pollsBeforeQuiet;

    results.ok(
      pollsWhileStreamingAgain === 0,
      `[${target}] the poll stops again once the stream recovers`,
      `${pollsWhileStreamingAgain} polls in 12s of restored streaming; total stream connections ${stub.count(`SSE ${slug}`)}`,
    );

    /* ---- leaving the page must close the stream ---- */

    await page.goto(`${baseUrl}/admin/login`, { waitUntil: "domcontentloaded" });
    await waitFor(() => stub.openStreams() === 0, {
      timeout: 10_000,
      what: "the event stream to close when the renderer unmounts",
    });
    const pollsAfterLeaving = stub.count(`POLL ${slug}`);
    await sleep(8000);

    results.ok(
      stub.count(`POLL ${slug}`) === pollsAfterLeaving,
      `[${target}] navigating away stops the poll and closes the stream`,
      `open streams: ${stub.openStreams()}; polls after leaving: ${stub.count(`POLL ${slug}`) - pollsAfterLeaving}`,
    );

    results.ok(
      recorder.pageErrors.length === 0,
      `[${target}] the arbitration run raises no uncaught page errors`,
      recorder.pageErrors.join(" | ") || "none",
    );
  } catch (error) {
    results.broke(`[${target}] stream versus poll arbitration`, error);
  } finally {
    stub.state.streamMode = "normal";
    await context.close();
  }
}

/**
 * The same configuration arriving several times is applied once, and a stream that missed an
 * update delivers it on reconnect.
 *
 * These are two halves of one design: the page keeps a note of what it has applied, which is what
 * makes a re-sent snapshot free — and a re-sent snapshot is exactly what makes a reconnect
 * correct, because the server opens every stream by describing the current state rather than by
 * replaying what was missed.
 */
export async function checkUpdatesAreAppliedOnce({ stub, baseUrl, browser, results, target }) {
  const slug = "apply-probe";
  stub.state.streamMode = "normal";
  stub.saveRoute({ slug, effectId: "plasma-shader", enabled: true, params: {} });

  const { context, page, recorder } = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/e/${slug}`, { waitUntil: "domcontentloaded" });
    const firstCanvas = await waitFor(
      async () => page.evaluate(() => window.__probe.canvasIdIn(".renderer-host")),
      { timeout: 20_000, what: "the first effect to mount" },
    );
    await sleep(1500);

    /* ---- the identical config, five times ---- */

    const beforeRepeat = await probeReport(page);
    for (let i = 0; i < 5; i += 1) {
      stub.publish(slug);
      await sleep(200);
    }
    await sleep(1500);
    const afterRepeat = await probeReport(page);
    const canvasAfterRepeat = await page.evaluate(() =>
      window.__probe.canvasIdIn(".renderer-host"),
    );

    results.ok(
      afterRepeat.contextsCreated === beforeRepeat.contextsCreated &&
        canvasAfterRepeat === firstCanvas,
      `[${target}] re-sending an unchanged config five times changes nothing on screen`,
      `contexts created ${beforeRepeat.contextsCreated} → ${afterRepeat.contextsCreated}, ` +
        `canvas id ${firstCanvas} → ${canvasAfterRepeat}`,
    );

    /* ---- one real change, announced twice, applies once ---- */

    const beforeChange = await probeReport(page);
    stub.saveRoute({ slug, effectId: "starfield-warp", enabled: true, params: {} });
    stub.publish(slug);
    stub.publish(slug);
    const swappedCanvas = await waitFor(
      async () => {
        const id = await page.evaluate(() => window.__probe.canvasIdIn(".renderer-host"));
        return id !== null && id !== firstCanvas ? id : null;
      },
      { timeout: 20_000, what: "the effect swap" },
    );
    await sleep(2000);
    const afterChange = await probeReport(page);

    results.ok(
      afterChange.contextsCreated === beforeChange.contextsCreated + 1,
      `[${target}] a change announced three times mounts exactly one new effect`,
      `contexts created ${beforeChange.contextsCreated} → ${afterChange.contextsCreated}, ` +
        `canvas id ${firstCanvas} → ${swappedCanvas}`,
    );

    /* ---- a reconnect converges on the current config ----
     *
     * The poll is neutralised for this part with a page-level intercept that keeps answering with
     * the *old* configuration, so that only the stream can possibly deliver the change. That is
     * what makes the result unambiguous: if the page ends up correct, it is because the reopened
     * stream described the current state.
     */
    const staleBody = JSON.stringify(stub.state.routes.get(slug));
    await page.route(
      (url) => url.pathname === `/api/routes/by-slug/${slug}`,
      (route) => route.fulfill({ status: 200, contentType: "application/json", body: staleBody }),
    );

    stub.state.streamMode = "refused";
    stub.killStreams();
    await sleep(1000);

    // The update the stream is going to miss: the route is switched off, which the page shows by
    // unmounting the effect entirely — an unmistakable observation from outside.
    stub.saveRoute({ slug, effectId: "starfield-warp", enabled: false, params: {} });
    await sleep(6000);

    const stillMountedWhileDown = await page.evaluate(
      () => document.querySelector(".renderer-host") !== null,
    );
    results.ok(
      stillMountedWhileDown,
      `[${target}] with the stream down and the poll answering staleness, the missed update is not seen`,
      `this is the control for the next check: .renderer-host present = ${stillMountedWhileDown}`,
    );

    stub.state.streamMode = "normal";
    const reopenedAt = Date.now();
    // Generous for the same reason as in `checkStreamSuppressesPoll`: through the development
    // proxy the page has to wait out its 45-second silence watchdog before it reopens at all.
    await waitFor(
      async () => page.evaluate(() => document.querySelector(".renderer-host") === null),
      { timeout: 90_000, what: "the reopened stream to deliver the missed update" },
    );

    results.ok(
      true,
      `[${target}] a reconnected stream converges on the current config (the missed update arrives)`,
      `arrived ${((Date.now() - reopenedAt) / 1000).toFixed(1)}s after the backend started ` +
        `accepting streams again; open streams: ${stub.openStreams()}`,
    );

    await page.unroute((url) => url.pathname === `/api/routes/by-slug/${slug}`);

    results.ok(
      recorder.pageErrors.length === 0,
      `[${target}] the apply-once run raises no uncaught page errors`,
      recorder.pageErrors.join(" | ") || "none",
    );
  } catch (error) {
    results.broke(`[${target}] updates applied exactly once, and reconnect convergence`, error);
  } finally {
    stub.state.streamMode = "normal";
    await context.close();
  }
}

/**
 * A stream that goes silent without erroring is caught by the client's own watchdog.
 *
 * This is the reverse-proxy failure: the connection is open, the browser is happy, and nothing is
 * being delivered. Nothing in the browser will ever report it, so the page has to notice the
 * silence itself. The contract puts the limit at 45 seconds — a little over two of the server's
 * 20-second heartbeats — and this check spends that time on purpose, which is why it is opt-in.
 */
export async function checkSilentStreamWatchdog({ stub, baseUrl, browser, results, target }) {
  const slug = "silent-probe";
  stub.state.streamMode = "silent";
  stub.saveRoute({ slug, effectId: "plasma-shader", enabled: true, params: {} });

  const { context, page } = await browser.newPage();
  try {
    stub.resetCounts();
    await page.goto(`${baseUrl}/e/${slug}`, { waitUntil: "domcontentloaded" });
    await waitFor(() => stub.openStreams() >= 1, {
      timeout: 15_000,
      what: "the silent stream to be opened",
    });

    // The page opened the stream and made its one first-frame request. Because the stream never
    // says anything, "healthy" was never true, so the poll should still be running — the contract's
    // definition of healthy is "something arrived", not "the socket is open".
    await sleep(20_000);
    const pollsAt20s = stub.count(`POLL ${slug}`);

    results.ok(
      pollsAt20s >= 3,
      `[${target}] a stream that never delivers is never treated as healthy`,
      `${pollsAt20s} polls in the first ~20s against a silent stream`,
    );

    await sleep(35_000);
    const connections = stub.count(`SSE ${slug}`);

    results.ok(
      connections >= 2,
      `[${target}] the 45s silence watchdog replaces the dead stream`,
      `${connections} stream connections opened in ~55s, ${stub.count(`POLL ${slug}`)} polls`,
    );
  } catch (error) {
    results.broke(`[${target}] silent-stream watchdog`, error);
  } finally {
    stub.state.streamMode = "normal";
    await context.close();
  }
}

/**
 * A disabled route draws nothing at all — no canvas, and deliberately no error box either.
 *
 * The second half matters as much as the first: switching a layer off mid-broadcast has to look
 * like the layer was never there, and a red diagnostic panel appearing in the scene would be worse
 * than the blank the operator asked for.
 */
export async function checkDisabledRoute({ stub, baseUrl, browser, results, target }) {
  const slug = "disabled-probe";
  stub.saveRoute({ slug, effectId: "plasma-shader", enabled: false, params: {} });

  const { context, page, recorder } = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/e/${slug}`, { waitUntil: "domcontentloaded" });
    await sleep(4000);

    const state = await page.evaluate(() => ({
      hosts: document.querySelectorAll(".renderer-host").length,
      canvases: document.querySelectorAll("canvas").length,
      errors: document.querySelectorAll(".renderer-error").length,
    }));
    const shot = await page.screenshot({ omitBackground: true });

    results.ok(
      state.hosts === 0 && state.canvases === 0,
      `[${target}] a disabled route mounts no effect`,
      `hosts ${state.hosts}, canvases ${state.canvases}`,
    );
    results.ok(
      state.errors === 0,
      `[${target}] a disabled route shows no error box`,
      `error boxes: ${state.errors}`,
    );
    results.ok(
      recorder.consoleErrors.length === 0 && recorder.pageErrors.length === 0,
      `[${target}] a disabled route logs nothing`,
      [...recorder.consoleErrors, ...recorder.pageErrors].join(" | ") || "none",
    );

    const painted = summarisePng(shot);
    results.ok(
      painted.painted === 0,
      `[${target}] a disabled route paints zero pixels`,
      `${painted.painted}/${painted.pixels} px painted`,
    );

    /* ---- and re-enabling it brings the effect back ---- */
    stub.saveRoute({ slug, effectId: "plasma-shader", enabled: true, params: {} });
    const canvasId = await waitFor(
      async () => page.evaluate(() => window.__probe.canvasIdIn(".renderer-host")),
      { timeout: 20_000, what: "the effect to remount when the route is re-enabled" },
    );
    results.ok(canvasId !== null, `[${target}] re-enabling the route mounts a fresh effect`);
  } catch (error) {
    results.broke(`[${target}] disabled route`, error);
  } finally {
    await context.close();
  }
}

/**
 * `/e/:slug` stays put when nobody is signed in.
 *
 * An OBS browser source cannot sign in. If the renderer ever followed the admin's 401 redirect, a
 * live layer would be replaced by a password form, on air, with nothing in OBS to say why. The
 * check therefore uses a context with no cookies at all, against a backend that is refusing
 * everything protected.
 */
export async function checkRendererNeverRedirects({ stub, baseUrl, browser, results, target }) {
  const slug = "public-probe";
  stub.saveRoute({ slug, effectId: "digital-rain", enabled: true, params: {} });
  const wasAuthenticated = stub.state.session.authenticated;
  stub.state.session.authenticated = false;

  const { context, page, recorder } = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/e/${slug}`, { waitUntil: "domcontentloaded" });
    await sleep(6000);

    const cookies = await context.cookies();
    const authCalls = recorder.matching("/api/auth/");
    const syncCalls = recorder.matching("/api/effects/sync");
    const canvasId = await page.evaluate(() => window.__probe.canvasIdIn(".renderer-host"));

    results.ok(
      page.url().endsWith(`/e/${slug}`),
      `[${target}] /e/:slug does not redirect when signed out`,
      `url is ${page.url()}`,
    );
    results.ok(
      canvasId !== null,
      `[${target}] /e/:slug still mounts its effect with no session`,
      `canvas id ${canvasId}`,
    );
    results.ok(
      authCalls.length === 0,
      `[${target}] /e/:slug makes no /api/auth call`,
      authCalls.join(" | ") || "none",
    );
    results.ok(
      syncCalls.length === 0,
      `[${target}] /e/:slug makes no /api/effects/sync call`,
      syncCalls.join(" | ") || "none",
    );
    results.ok(
      cookies.length === 0,
      `[${target}] /e/:slug is running with no cookies at all`,
      `${cookies.length} cookies`,
    );
    results.ok(
      recorder.consoleErrors.length === 0 && recorder.pageErrors.length === 0,
      `[${target}] /e/:slug logs no errors while signed out`,
      [...recorder.consoleErrors, ...recorder.pageErrors].join(" | ") || "none",
    );
  } catch (error) {
    results.broke(`[${target}] renderer never redirects`, error);
  } finally {
    stub.state.session.authenticated = wasAuthenticated;
    await context.close();
  }
}

/**
 * A backend failure that goes away leaves no trace on the page.
 *
 * The failure this guards against is a message that outlives the problem it described. A slug with
 * no route says so; then one request fails with a `500` and that message takes over; then the slug
 * is reported absent again. If the page only refreshed its message when the *state* changed, it
 * would keep showing the server error for the rest of the broadcast, telling the operator to fix
 * something that is already fixed.
 *
 * The stream is put in "silent" mode so that the poll is the only thing delivering, which is what
 * makes the sequence reproducible in a few seconds instead of waiting out a watchdog.
 */
export async function checkStaleErrorIsReplaced({ stub, baseUrl, browser, results, target }) {
  const slug = "stale-error-probe";
  stub.state.routes.delete(slug);
  stub.state.streamMode = "silent";

  const { context, page } = await browser.newPage();
  const isPoll = (url) => url.pathname === `/api/routes/by-slug/${slug}`;
  try {
    await page.route(isPoll, (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "INTERNAL_ERROR", message: "The database is on fire." },
        }),
      }),
    );

    await page.goto(`${baseUrl}/e/${slug}`, { waitUntil: "domcontentloaded" });
    const serverMessage = await waitFor(
      async () =>
        page.evaluate(() => {
          const box = document.querySelector(".renderer-error");
          return box && box.textContent.includes("on fire") ? box.textContent : null;
        }),
      { timeout: 20_000, what: "the server error to reach the screen" },
    );
    results.ok(
      serverMessage !== null,
      `[${target}] a backend failure is reported on screen`,
      serverMessage.replace(/\s+/g, " ").slice(0, 90),
    );

    // The failure goes away: the slug is simply not configured, which is what it was all along.
    await page.unroute(isPoll);
    const absentMessage = await waitFor(
      async () =>
        page.evaluate(() => {
          const box = document.querySelector(".renderer-error");
          return box && box.textContent.includes("No route is configured") ? box.textContent : null;
        }),
      { timeout: 20_000, what: "the message to go back to describing the real state" },
    );
    results.ok(
      absentMessage !== null,
      `[${target}] the message goes back to the truth once the failure passes`,
      absentMessage.replace(/\s+/g, " ").slice(0, 90),
    );
  } catch (error) {
    results.broke(`[${target}] a stale error message is replaced`, error);
  } finally {
    stub.state.streamMode = "normal";
    await context.close();
  }
}

/**
 * A browser with no `EventSource` at all polls, and says so once.
 *
 * This is the contract's §4 rule 7, and it is the reason the poll was kept rather than replaced: a
 * runtime without the streaming API — an old embedded browser inside some capture appliance — must
 * end up exactly as good as the page was before Phase 2, not broken. The API is removed from the
 * page before any application code runs, which is the only honest way to test the branch.
 */
export async function checkNoEventSourceFallsBackToPolling({
  stub,
  baseUrl,
  browser,
  results,
  target,
}) {
  const slug = "no-eventsource-probe";
  stub.saveRoute({ slug, effectId: "plasma-shader", enabled: true, params: {} });

  const { context, page, recorder } = await browser.newPage({
    initScript: "delete window.EventSource;",
  });
  try {
    stub.resetCounts();
    await page.goto(`${baseUrl}/e/${slug}`, { waitUntil: "domcontentloaded" });
    const canvasId = await waitFor(
      async () => page.evaluate(() => window.__probe.canvasIdIn(".renderer-host")),
      { timeout: 20_000, what: "the effect to mount without an event stream" },
    );
    await sleep(12_000);

    results.ok(
      canvasId !== null,
      `[${target}] the page still works with no EventSource in the runtime`,
    );
    results.ok(
      stub.count(`SSE ${slug}`) === 0,
      `[${target}] no stream is attempted when the runtime has no EventSource`,
      `${stub.count(`SSE ${slug}`)} stream connections`,
    );
    results.ok(
      stub.count(`POLL ${slug}`) >= 3,
      `[${target}] the poll carries the page on its own`,
      `${stub.count(`POLL ${slug}`)} polls in ~12s`,
    );
    results.ok(
      recorder.consoleWarnings.some((line) => line.includes("no EventSource")),
      `[${target}] the page says once, in the console, that live updates are unavailable`,
      recorder.consoleWarnings.join(" | ") || "none",
    );
    results.ok(
      recorder.consoleErrors.length === 0 && recorder.pageErrors.length === 0,
      `[${target}] the poll-only path logs no errors`,
      [...recorder.consoleErrors, ...recorder.pageErrors].join(" | ") || "none",
    );
  } catch (error) {
    results.broke(`[${target}] no-EventSource fallback`, error);
  } finally {
    await context.close();
  }
}

/** A slug with no route says so, rather than showing a blank page. */
export async function checkAbsentSlug({ stub, baseUrl, browser, results, target }) {
  const { context, page } = await browser.newPage();
  try {
    stub.state.routes.delete("nothing-here");
    await page.goto(`${baseUrl}/e/nothing-here`, { waitUntil: "domcontentloaded" });
    const message = await waitFor(
      async () =>
        page.evaluate(() => document.querySelector(".renderer-error")?.textContent ?? null),
      { timeout: 15_000, what: "the missing-route message" },
    );
    results.ok(
      message.includes("nothing-here"),
      `[${target}] an unknown slug explains itself on screen`,
      message.replace(/\s+/g, " ").slice(0, 120),
    );

    // And creating the route fixes the page with no reload — the event stream's job.
    stub.saveRoute({ slug: "nothing-here", effectId: "particle-drift", enabled: true, params: {} });
    const canvasId = await waitFor(
      async () => page.evaluate(() => window.__probe.canvasIdIn(".renderer-host")),
      { timeout: 20_000, what: "the effect to appear once the route exists" },
    );
    results.ok(
      canvasId !== null,
      `[${target}] creating the route makes the live page start drawing, with no reload`,
    );
  } catch (error) {
    results.broke(`[${target}] absent slug`, error);
  } finally {
    await context.close();
  }
}
