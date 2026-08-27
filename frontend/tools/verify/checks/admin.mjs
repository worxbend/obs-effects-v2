/**
 * Checks about the admin panel: the session gate, what happens when a session ends mid-session,
 * and whether the pages open cleanly.
 *
 * The stub keeps one session flag for the whole process rather than issuing real cookies, so these
 * checks must not run alongside each other — `run.mjs` runs everything in sequence.
 */

import { sleep, waitFor } from "../harness.mjs";
import { summarisePng } from "../png.mjs";

/** Every admin page, so "does it open without complaining" is asked of all of them. */
const ADMIN_PAGES = ["/admin", "/admin/presets", "/admin/effects", "/admin/backup"];

/** Waits until the browser's address bar satisfies `predicate`. */
function waitForUrl(page, predicate, what) {
  return waitFor(() => (predicate(page.url()) ? page.url() : null), { timeout: 15_000, what });
}

/**
 * A signed-out operator is sent to the login page, and lands back where they were going.
 *
 * The `?next=` round trip is the part worth testing: it is the difference between signing in and
 * carrying on, and signing in and having to find your way back to the page you asked for.
 */
export async function checkSignInFlow({ stub, baseUrl, browser, results, target }) {
  stub.state.session.authRequired = true;
  stub.state.session.authenticated = false;

  const { context, page, recorder } = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/admin/presets`, { waitUntil: "domcontentloaded" });
    const redirected = await waitForUrl(
      page,
      (url) => url.includes("/admin/login"),
      "the redirect to the login page",
    );

    results.ok(
      redirected.includes("next=%2Fadmin%2Fpresets"),
      `[${target}] a signed-out visit to /admin/presets redirects to login, remembering the path`,
      redirected.replace(baseUrl, ""),
    );
    results.ok(
      recorder.matching("/api/effects/sync").length === 0,
      `[${target}] nothing publishes the effect manifest before sign-in`,
      recorder.matching("/api/effects/sync").join(" | ") || "none",
    );

    /* ---- the wrong password stays on the page ---- */

    await page.fill("#admin-password", "definitely-wrong");
    await page.click('button[type="submit"]');
    const message = await waitFor(
      async () => page.evaluate(() => document.querySelector(".banner")?.textContent ?? null),
      { timeout: 10_000, what: "the wrong-password message" },
    );
    results.ok(
      message.includes("Incorrect password") && page.url().includes("/admin/login"),
      `[${target}] a wrong password reports itself without navigating`,
      `${message.replace(/\s+/g, " ").trim()} — url ${page.url().replace(baseUrl, "")}`,
    );

    /* ---- the right password returns to the remembered page ---- */

    await page.fill("#admin-password", stub.state.password);
    await page.click('button[type="submit"]');
    await waitForUrl(
      page,
      (url) => url.endsWith("/admin/presets"),
      "the return to /admin/presets after signing in",
    );
    results.ok(
      true,
      `[${target}] signing in returns to the page that was asked for`,
      "/admin/presets",
    );

    // The manifest publish is the admin's job and happens only once it is signed in.
    await waitFor(() => recorder.matching("/api/effects/sync").length === 1, {
      timeout: 10_000,
      what: "the effect manifest to be published after signing in",
    });
    results.ok(
      recorder.matching("/api/effects/sync").length === 1,
      `[${target}] the effect manifest is published exactly once, after signing in`,
      `${recorder.matching("/api/effects/sync").length} calls`,
    );

    /*
     * One console error is *expected* here and must not be filtered away silently.
     *
     * Chromium itself logs "Failed to load resource: the server responded with a status of 401"
     * for every 401 response, before any application code sees it. This check deliberately submits
     * a wrong password, so exactly one of those must appear — one, because a second would mean the
     * page retried something — and nothing else may.
     */
    const expected401 = recorder.consoleErrors.filter((line) =>
      line.startsWith("Failed to load resource: the server responded with a status of 401"),
    );
    const unexpected = recorder.consoleErrors.filter((line) => !expected401.includes(line));

    results.ok(
      expected401.length === 1,
      `[${target}] the wrong password produces exactly one 401, logged by the browser itself`,
      `${expected401.length} such messages`,
    );
    results.ok(
      unexpected.length === 0 && recorder.pageErrors.length === 0,
      `[${target}] the sign-in flow logs nothing else`,
      [...unexpected, ...recorder.pageErrors].join(" | ") || "none",
    );
  } catch (error) {
    results.broke(`[${target}] sign-in flow`, error);
  } finally {
    stub.state.session.authenticated = true;
    await context.close();
  }
}

/**
 * A session that ends while the tab is open sends the operator to the login page, not to a wall of
 * error banners.
 *
 * The trigger is an ordinary protected call coming back `401` — here, the inventory page asking
 * for `GET /api/effects` after the backend has been told to stop accepting the session.
 */
export async function checkMidSessionExpiry({ stub, baseUrl, browser, results, target }) {
  stub.state.session.authRequired = true;
  stub.state.session.authenticated = true;

  const { context, page, recorder } = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/admin`, { waitUntil: "domcontentloaded" });
    /*
     * Wait for something that only exists *past* the session gate, not merely for the top bar.
     *
     * The shell draws its header before `GET /api/auth/session` has answered, so a check that
     * carried on at that point would switch the backend's session off while the first session
     * request was still in flight — and the answer would then arrive saying "signed out", which is
     * a different thing from the expiry this check is about. The "New route" button belongs to the
     * routes list, which only renders once the gate has let us through.
     */
    await page.waitForSelector('a[href="/admin/routes/new"]', { timeout: 30_000 });

    // The session ends: expired, signed out elsewhere, or the backend restarted.
    stub.state.session.authenticated = false;
    await page.click('a[href="/admin/effects"]');

    const redirected = await waitForUrl(
      page,
      (url) => url.includes("/admin/login"),
      "the 401 redirect to the login page",
    );
    results.ok(
      redirected.includes("next=%2Fadmin%2Feffects"),
      `[${target}] a 401 mid-session redirects to login, remembering the page`,
      redirected.replace(baseUrl, ""),
    );
    results.ok(
      recorder.pageErrors.length === 0,
      `[${target}] the mid-session expiry raises no uncaught page errors`,
      recorder.pageErrors.join(" | ") || "none",
    );
  } catch (error) {
    results.broke(`[${target}] mid-session expiry`, error);
  } finally {
    stub.state.session.authenticated = true;
    await context.close();
  }
}

/**
 * The admin's preview pane draws a route that `/e/:slug` deliberately leaves blank.
 *
 * This is the other half of the `enabled: false` decision. The renderer draws nothing; the editor
 * has to draw it anyway, because a route switched off is exactly the one you most need to look at
 * before switching it back on.
 */
export async function checkPreviewIgnoresDisabled({ stub, baseUrl, browser, results, target }) {
  stub.state.session.authRequired = true;
  stub.state.session.authenticated = true;

  const route = stub.saveRoute({
    slug: "preview-probe",
    effectId: "plasma-shader",
    enabled: false,
    params: {},
  });

  const { context, page, recorder } = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/admin/routes/${route.id}`, { waitUntil: "domcontentloaded" });
    await waitFor(async () => page.evaluate(() => window.__probe.canvasIdIn(".preview-host")), {
      timeout: 25_000,
      what: "the preview canvas to mount for a disabled route",
    });
    await sleep(2500);

    const host = await page.$(".preview-host");
    const shot = await host.screenshot();
    const painted = summarisePng(shot);
    const enabledBox = await page.evaluate(
      () => document.querySelector('.checkbox-row input[type="checkbox"]')?.checked ?? null,
    );

    results.ok(
      painted.distinctColours >= 3,
      `[${target}] the admin preview draws a disabled route`,
      `${painted.width}×${painted.height} preview, ${painted.distinctColours} distinct colours`,
    );
    results.ok(
      enabledBox === false,
      `[${target}] the route under preview really is the disabled one`,
      `enabled checkbox = ${enabledBox}`,
    );
    results.ok(
      recorder.consoleErrors.length === 0 && recorder.pageErrors.length === 0,
      `[${target}] the route editor logs no console or page errors`,
      [...recorder.consoleErrors, ...recorder.pageErrors].join(" | ") || "none",
    );
  } catch (error) {
    results.broke(`[${target}] admin preview of a disabled route`, error);
  } finally {
    await context.close();
  }
}

/**
 * Every admin page opens without logging anything.
 *
 * A blunt check, and the one most likely to catch a regression nobody was looking for — Phase 1's
 * `[STRICT_READ_UNTRACKED]` warnings appeared in exactly this way, and only in the development
 * build, which is the build `make up` serves.
 */
export async function checkAdminPagesAreQuiet({ stub, baseUrl, browser, results, target }) {
  stub.state.session.authRequired = true;
  stub.state.session.authenticated = true;
  stub.saveRoute({ slug: "quiet-probe", effectId: "digital-rain", enabled: true, params: {} });

  const { context, page, recorder } = await browser.newPage();
  try {
    for (const path of ADMIN_PAGES) {
      await page.goto(`${baseUrl}${path}`, { waitUntil: "domcontentloaded" });
      await sleep(2500);
      results.ok(
        !page.url().includes("/admin/login"),
        `[${target}] ${path} opens without being bounced to login`,
        `url ${page.url().replace(baseUrl, "")}`,
      );
    }

    await page.goto(`${baseUrl}/admin/routes/new`, { waitUntil: "domcontentloaded" });
    await sleep(2500);

    results.ok(
      recorder.consoleErrors.length === 0,
      `[${target}] no console errors across ${ADMIN_PAGES.length + 1} admin pages`,
      recorder.consoleErrors.join(" | ") || "none",
    );
    results.ok(
      recorder.pageErrors.length === 0,
      `[${target}] no uncaught page errors across the admin`,
      recorder.pageErrors.join(" | ") || "none",
    );
    results.ok(
      recorder.failedRequests.length === 0,
      `[${target}] no failed requests across the admin`,
      recorder.failedRequests.join(" | ") || "none",
    );
    results.ok(
      recorder.consoleWarnings.length === 0,
      `[${target}] no console warnings across the admin`,
      recorder.consoleWarnings.join(" | ") || "none",
    );
  } catch (error) {
    results.broke(`[${target}] admin pages are quiet`, error);
  } finally {
    await context.close();
  }
}
