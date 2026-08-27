/**
 * A stand-in for the Scala backend, written in plain Node, used only by the runtime harness.
 *
 * ## Why a stub rather than the real thing
 *
 * The checks in `tools/verify/checks/` are about the *frontend*: does an effect draw, is the old
 * one disposed, does the five-second poll really stop while the event stream is delivering, does
 * `/e/:slug` stay put when there is no session. Every one of those questions needs the backend to
 * do something a real backend will not do on command — drop an event stream mid-connection, answer
 * `401` on the next call, deliver an update at a chosen moment, or count how many requests arrived
 * in the last ten seconds.
 *
 * So this file implements the endpoints of `docs/CONTRACT.md` that the frontend calls, keeps
 * everything in memory, and exposes the levers the checks need as ordinary JavaScript functions
 * (`publish`, `killStreams`, `counts`). It runs **inside the same Node process** as the checks, so
 * there is no control API to build and no race between "the test changed something" and "the
 * server noticed".
 *
 * ## What it is not
 *
 * It is not a second implementation of the contract to be kept in step with the Scala one. It
 * validates almost nothing and stores whatever it is given. If a check depends on a validation
 * rule, that belongs in the backend's own test suite, not here.
 *
 * ## The two things it serves
 *
 *  - `/api/**` — the API, plus the Server-Sent Events stream at
 *    `/api/routes/by-slug/{slug}/events`.
 *  - everything else — static files from `dist/`, with the single-page-application fallback
 *    (an unknown path returns `index.html`, because the router resolves the path in the browser).
 *
 * Serving both from one port is deliberate: it is the same-origin shape the project ships, the one
 * where the session cookie is first-party. The Vite development server reaches this same process
 * through its own `/api` proxy, so both targets exercise one backend.
 */

import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat, readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

/** How often the stream sends a `heartbeat`, in milliseconds. The contract says 20 seconds. */
const HEARTBEAT_MS = 20_000;

/** How often the audio level stream repeats its measurement, in milliseconds.
 *
 * Roughly OBS's own volume-meter rate. It also has to stay well under the six seconds after which
 * the SDK's audio bus decides a stream is dead and switches to its simulated signal — a stream that
 * spoke once and went quiet would stop testing the real path partway through a long check, and
 * would still pass, because the simulated signal paints pixels too. */
const AUDIO_LEVEL_MS = 200;

/** Content types for the handful of extensions `dist/` actually contains. */
const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

let idCounter = 0;

/** A 24-character hexadecimal id, the shape the contract gives every stored object. */
function objectId() {
  idCounter += 1;
  return idCounter.toString(16).padStart(24, "0");
}

/** Now, as the ISO-8601 UTC string every timestamp in the contract uses. */
function nowIso() {
  return new Date().toISOString();
}

/**
 * Builds a complete `RouteConfig` from the parts a check cares about.
 *
 * Everything a check does not mention gets a valid default, so a check that is about the event
 * stream does not have to know what a canvas is.
 */
export function makeRoute(partial) {
  const at = nowIso();
  return {
    id: objectId(),
    slug: "main-camera",
    effectId: "plasma-shader",
    enabled: true,
    params: {},
    canvas: { width: 1920, height: 1080, fpsCap: null },
    createdAt: at,
    updatedAt: at,
    ...partial,
  };
}

/** Builds a complete `Preset`. Same idea as `makeRoute`. */
export function makePreset(partial) {
  const at = nowIso();
  return {
    id: objectId(),
    name: "Preset",
    effectId: "plasma-shader",
    params: {},
    createdAt: at,
    updatedAt: at,
    ...partial,
  };
}

/**
 * Starts the stub and resolves once it is listening.
 *
 * @param {object} options
 * @param {number} options.port      port to listen on.
 * @param {string} options.distDir   directory of built files to serve for non-API paths.
 * @returns the handle the checks drive the backend through.
 */
export async function startStub({ port, distDir }) {
  const state = {
    /** Answer given to `GET /api/auth/session`, and the gate every protected endpoint checks. */
    session: { authenticated: true, authRequired: true },
    /** Every stored route, by slug. */
    routes: new Map(),
    /** Every stored preset, by id. */
    presets: new Map(),
    /** The inventory as last published by `POST /api/effects/sync`. */
    effects: [],
    /**
     * How a new event-stream connection behaves. This is the lever the arbitration checks pull:
     *
     *  - `"normal"` — open it, send the opening snapshot, then heartbeats.
     *  - `"silent"` — open it and send nothing at all, ever. This is the reverse proxy that
     *    buffers the response: the browser sees a healthy connection and never retries, which is
     *    the failure the client's own 45-second watchdog exists to catch.
     *  - `"refused"` — close the socket immediately, so every reconnection attempt fails.
     */
    streamMode: "normal",
    /**
     * The measurement the audio level stream opens with, and keeps sending.
     *
     * The default is a **loud** one, which is deliberate and was chosen after getting it wrong. The
     * obvious default is silence, and silence is exactly what an audio-reactive effect must draw
     * nothing for: OBS connected and quiet means the bars are down, the same as a hardware meter.
     * With silence as the stub's default, `effects-draw` was asserting that a spectrum analyser
     * paints pixels while telling it there is no sound — a contradiction, and one that says nothing
     * about whether the effect works.
     *
     * So the resting state of the stub is "OBS is connected and something is playing", which is the
     * condition every other check here is implicitly about. A check that wants the silent case sets
     * this to a zero measurement, and a check that wants the *disconnected* case (where the SDK
     * falls back to a simulated signal) sets `audioStream` to "absent".
     */
    /**
     * Whether the audio level stream works at all.
     *
     *  - `"normal"` — serve it.
     *  - `"absent"` — close the socket immediately, so every reconnection attempt fails. This is
     *    OBS being closed or the backend going away, and it is the state in which the SDK's audio
     *    bus is supposed to fall back to its simulated signal rather than freeze.
     *
     * Kept separate from `streamMode`, which governs the *route* stream: an audio outage and a
     * configuration outage are unrelated failures and a check needs to produce one without the
     * other.
     */
    audioStream: "normal",
    audioLevels: {
      at: Date.now(),
      peak: 0.72,
      inputs: [
        { inputName: "Desktop Audio", peak: 0.72, channels: [0.72, 0.65] },
        { inputName: "Mic/Aux", peak: 0.31, channels: [0.31] },
      ],
    },
    /** Password `POST /api/auth/login` accepts. */
    password: "correct-horse",
  };

  /** Request counts by a coarse key, so a check can prove the poll stopped rather than slowed. */
  const counts = new Map();
  const bump = (key) => counts.set(key, (counts.get(key) ?? 0) + 1);

  /** Every open event-stream response, so they can be published to or destroyed as a group. */
  const subscribers = new Set();

  const root = resolve(distDir);

  /* ---------------------------------------------------------------- */
  /* Server-Sent Events                                                */
  /* ---------------------------------------------------------------- */

  /**
   * Writes one event in the SSE wire format: an optional `retry:` line, the event name, one
   * `data:` line, then the blank line that ends the event.
   */
  function writeEvent(subscriber, name, payload, withRetry = false) {
    const lines = [];
    if (withRetry) lines.push("retry: 3000");
    lines.push(`event: ${name}`);
    lines.push(`data: ${JSON.stringify(payload)}`);
    lines.push("", "");
    subscriber.res.write(lines.join("\n"));
    subscriber.sent += 1;
  }

  /** The event a subscriber to `slug` should receive right now: the route, or `absent`. */
  function currentEvent(slug) {
    const route = state.routes.get(slug);
    return route ? ["config", route] : ["absent", { slug }];
  }

  /**
   * Tells every subscriber watching `slug` what the current configuration is.
   *
   * Checks call this after changing `state.routes` — the real backend publishes from its route
   * service on write, and this is the same idea with the write being a test doing it by hand.
   */
  function publish(slug) {
    const [name, payload] = currentEvent(slug);
    for (const subscriber of subscribers) {
      if (subscriber.slug === slug) writeEvent(subscriber, name, payload);
    }
  }

  /**
   * Destroys every open stream without a clean close.
   *
   * That is what a backend restart or a dropped connection looks like to the browser: the
   * `EventSource` fires `error`, which is the client's first signal that it must fall back to
   * polling.
   */
  /*
   * Audio subscribers are kept apart from route subscribers on purpose.
   *
   * They were briefly in the same set, and that was a mistake worth recording: `openStreams()` and
   * `killStreams()` exist so a check can say "exactly one browser source is listening to this
   * slug", and an audio stream that happens to be open would silently be counted as one. A check
   * asserting `openStreams() === 1` then waits forever for a number that is now 2, and fails as a
   * timeout somewhere unrelated to audio.
   *
   * Two streams, two registries, no interference.
   */
  const audioSubscribers = new Set();

  function killAudioStreams() {
    for (const subscriber of audioSubscribers) {
      clearInterval(subscriber.heartbeat);
      subscriber.res.destroy();
    }
    audioSubscribers.clear();
  }

  function killStreams() {
    for (const subscriber of subscribers) {
      clearInterval(subscriber.heartbeat);
      subscriber.res.destroy();
    }
    subscribers.clear();
  }

  /** The audio level stream. Deliberately simpler than the route stream: no slug, no absent case. */
  function openAudioStream(req, res) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    if (state.audioStream === "absent") {
      res.destroy();
      return;
    }

    const subscriber = { res, sent: 0, heartbeat: undefined };
    audioSubscribers.add(subscriber);

    /*
     * Repeated on a timer rather than written once. The SDK's audio bus treats a measurement older
     * than six seconds as a dead stream and falls back to its simulated signal, so a stream that
     * spoke once would silently stop testing the real path partway through a long check — and would
     * still pass, because the simulated signal paints pixels too.
     */
    const send = () =>
      writeEvent(
        subscriber,
        "levels",
        { ...(state.audioLevels ?? { peak: 0, inputs: [] }), at: Date.now() },
        true,
      );

    send();
    subscriber.heartbeat = setInterval(send, AUDIO_LEVEL_MS);

    req.on("close", () => {
      clearInterval(subscriber.heartbeat);
      audioSubscribers.delete(subscriber);
    });
  }

  function openStream(req, res, slug) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    if (state.streamMode === "refused") {
      res.destroy();
      return;
    }

    const subscriber = { slug, res, sent: 0, heartbeat: undefined };
    subscribers.add(subscriber);

    // A stream in "silent" mode is deliberately left with the headers sent and nothing following:
    // no snapshot, no heartbeat. Nothing about it looks broken from the browser's side.
    if (state.streamMode === "normal") {
      const [name, payload] = currentEvent(slug);
      writeEvent(subscriber, name, payload, true);
      subscriber.heartbeat = setInterval(() => {
        writeEvent(subscriber, "heartbeat", { at: nowIso() });
      }, HEARTBEAT_MS);
    }

    const drop = () => {
      clearInterval(subscriber.heartbeat);
      subscribers.delete(subscriber);
    };
    req.on("close", drop);
    res.on("close", drop);
  }

  /* ---------------------------------------------------------------- */
  /* Plain JSON helpers                                                */
  /* ---------------------------------------------------------------- */

  function sendJson(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      // No charset parameter, matching the resolution recorded in the contract's §2.4.
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(text),
    });
    res.end(text);
  }

  function sendError(res, status, code, message, details) {
    sendJson(res, status, { error: details ? { code, message, details } : { code, message } });
  }

  function readBody(req) {
    return new Promise((resolvePromise, rejectPromise) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (text === "") {
          resolvePromise({});
          return;
        }
        try {
          resolvePromise(JSON.parse(text));
        } catch (error) {
          rejectPromise(error);
        }
      });
      req.on("error", rejectPromise);
    });
  }

  /**
   * True when this request may proceed.
   *
   * The stub does not issue real cookies — there is one browser and one session per check run, so
   * `state.session.authenticated` is the whole of the model. What matters for the frontend checks
   * is only *which* endpoints are gated, and that a gated one answers `401` in the contracted
   * envelope so the client's central handler fires.
   */
  function authorised() {
    return !state.session.authRequired || state.session.authenticated;
  }

  /* ---------------------------------------------------------------- */
  /* Static files                                                      */
  /* ---------------------------------------------------------------- */

  async function serveStatic(req, res, pathname) {
    // `normalize` collapses any "..", and the prefix test then refuses anything that still points
    // outside the built output. A verification harness is not a place to invent a path traversal.
    const candidate = resolve(join(root, normalize(pathname)));
    const inside = candidate === root || candidate.startsWith(root + sep);

    if (inside) {
      try {
        const info = await stat(candidate);
        if (info.isFile()) {
          res.writeHead(200, {
            "Content-Type": CONTENT_TYPES[extname(candidate)] ?? "application/octet-stream",
            "Content-Length": info.size,
          });
          createReadStream(candidate).pipe(res);
          return;
        }
      } catch {
        // Fall through to the single-page-application fallback below.
      }
    }

    // Any path that is not a file is handed to index.html, because the router resolves it in the
    // browser. This is what makes a deep link such as /admin/presets or /e/main-camera work.
    try {
      const html = await readFile(join(root, "index.html"));
      res.writeHead(200, { "Content-Type": CONTENT_TYPES[".html"], "Content-Length": html.length });
      res.end(html);
    } catch {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`The built frontend was not found in ${root}. Run \`pnpm build\` first.`);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Routing                                                           */
  /* ---------------------------------------------------------------- */

  async function handleApi(req, res, pathname, url) {
    const method = req.method ?? "GET";
    const key = `${method} ${pathname}`;
    bump(key);

    /* ---- public: the three auth endpoints ---- */

    if (key === "GET /api/auth/session") {
      sendJson(res, 200, sessionInfo());
      return;
    }

    if (key === "POST /api/auth/login") {
      const body = await readBody(req);
      if (typeof body.password !== "string" || body.password === "") {
        sendError(res, 400, "BAD_REQUEST", "The password must be 1 to 1024 characters.");
        return;
      }
      if (body.password !== state.password) {
        sendError(res, 401, "UNAUTHORIZED", "Incorrect password.");
        return;
      }
      state.session.authenticated = true;
      sendJson(res, 200, sessionInfo());
      return;
    }

    if (key === "POST /api/auth/logout") {
      state.session.authenticated = false;
      res.writeHead(204);
      res.end();
      return;
    }

    /* ---- public: health ---- */

    if (key === "GET /api/health") {
      sendJson(res, 200, {
        status: "ok",
        mongo: "up",
        effects: state.effects.length,
        routes: state.routes.size,
      });
      return;
    }

    /* ---- public: what an OBS browser source reads ---- */

    const bySlug = /^\/api\/routes\/by-slug\/([^/]+)(\/events)?$/.exec(pathname);
    if (bySlug && method === "GET") {
      const slug = decodeURIComponent(bySlug[1]);
      if (bySlug[2]) {
        bump(`SSE ${slug}`);
        openStream(req, res, slug);
        return;
      }
      bump(`POLL ${slug}`);
      const route = state.routes.get(slug);
      if (!route) {
        sendError(res, 404, "NOT_FOUND", `No route exists with the slug "${slug}".`);
        return;
      }
      sendJson(res, 200, route);
      return;
    }

    /*
     * The public audio level stream.
     *
     * Audio-reactive effects open this the moment they mount, so every check that loads `audio-bars`
     * reaches it. It is served as a stream that sends one measurement of silence and then a
     * heartbeat every few seconds: silence rather than a signal because the SDK's fallback is what
     * an unconfigured installation actually shows, and a check that only ever saw a lively stub
     * would never exercise it.
     *
     * `audioLevels` in `state` lets a check push a real measurement in and watch an effect react.
     */
    if (key === "GET /api/audio/levels/events") {
      bump("SSE audio-levels");
      openAudioStream(req, res);
      return;
    }

    /* ---- everything below needs a session ---- */

    if (!authorised()) {
      sendError(res, 401, "UNAUTHORIZED", "Sign in to use the admin API.");
      return;
    }

    if (key === "GET /api/effects") {
      sendJson(res, 200, state.effects);
      return;
    }

    if (key === "POST /api/effects/sync") {
      const body = await readBody(req);
      const before = state.effects.length;
      state.effects = Array.isArray(body.effects) ? body.effects : [];
      sendJson(res, 200, {
        upserted: state.effects.length,
        removed: Math.max(0, before - state.effects.length),
        total: state.effects.length,
      });
      return;
    }

    if (key === "GET /api/routes") {
      sendJson(
        res,
        200,
        [...state.routes.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
      );
      return;
    }

    const byId = /^\/api\/routes\/([^/]+)$/.exec(pathname);
    if (byId) {
      const id = decodeURIComponent(byId[1]);
      const existing = [...state.routes.values()].find((route) => route.id === id);
      if (method === "GET") {
        if (!existing) {
          sendError(res, 404, "NOT_FOUND", `No route exists with the id "${id}".`);
          return;
        }
        sendJson(res, 200, existing);
        return;
      }
      if (method === "PUT") {
        const body = await readBody(req);
        if (!existing) {
          sendError(res, 404, "NOT_FOUND", `No route exists with the id "${id}".`);
          return;
        }
        state.routes.delete(existing.slug);
        const updated = makeRoute({ ...existing, ...body, updatedAt: nowIso() });
        state.routes.set(updated.slug, updated);
        publish(updated.slug);
        sendJson(res, 200, updated);
        return;
      }
      if (method === "DELETE") {
        if (existing) {
          state.routes.delete(existing.slug);
          publish(existing.slug);
        }
        res.writeHead(204);
        res.end();
        return;
      }
    }

    if (key === "POST /api/routes") {
      const body = await readBody(req);
      if (state.routes.has(body.slug)) {
        sendError(res, 409, "SLUG_CONFLICT", `The slug "${body.slug}" is already in use.`);
        return;
      }
      const created = makeRoute(body);
      state.routes.set(created.slug, created);
      publish(created.slug);
      sendJson(res, 201, created);
      return;
    }

    if (key === "GET /api/presets") {
      const wanted = url.searchParams.get("effectId");
      const all = [...state.presets.values()];
      sendJson(res, 200, wanted ? all.filter((p) => p.effectId === wanted) : all);
      return;
    }

    if (key === "POST /api/presets") {
      const body = await readBody(req);
      const clash = [...state.presets.values()].some(
        (p) =>
          p.effectId === body.effectId && p.name.toLowerCase() === String(body.name).toLowerCase(),
      );
      if (clash) {
        sendError(res, 409, "NAME_CONFLICT", `A preset called "${body.name}" already exists.`);
        return;
      }
      const created = makePreset(body);
      state.presets.set(created.id, created);
      sendJson(res, 201, created);
      return;
    }

    const presetById = /^\/api\/presets\/([^/]+)$/.exec(pathname);
    if (presetById) {
      const id = decodeURIComponent(presetById[1]);
      const existing = state.presets.get(id);
      if (method === "PUT") {
        if (!existing) {
          sendError(res, 404, "NOT_FOUND", `No preset exists with the id "${id}".`);
          return;
        }
        const body = await readBody(req);
        const updated = { ...existing, ...body, updatedAt: nowIso() };
        state.presets.set(id, updated);
        sendJson(res, 200, updated);
        return;
      }
      if (method === "DELETE") {
        state.presets.delete(id);
        res.writeHead(204);
        res.end();
        return;
      }
      if (method === "GET") {
        if (!existing) {
          sendError(res, 404, "NOT_FOUND", `No preset exists with the id "${id}".`);
          return;
        }
        sendJson(res, 200, existing);
        return;
      }
    }

    if (key === "GET /api/admin/export") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Disposition": 'attachment; filename="obs-effects-backup.json"',
      });
      res.end(
        JSON.stringify({
          schemaVersion: 1,
          exportedAt: nowIso(),
          routes: [...state.routes.values()],
          presets: [...state.presets.values()],
        }),
      );
      return;
    }

    if (key === "POST /api/admin/import") {
      const body = await readBody(req);
      const routes = Array.isArray(body.routes) ? body.routes : [];
      const presets = Array.isArray(body.presets) ? body.presets : [];
      let routesDeleted = 0;
      let presetsDeleted = 0;
      if (body.mode === "replace") {
        routesDeleted = state.routes.size;
        presetsDeleted = state.presets.size;
        state.routes.clear();
        state.presets.clear();
      }
      let routesCreated = 0;
      let routesUpdated = 0;
      for (const route of routes) {
        if (state.routes.has(route.slug)) routesUpdated += 1;
        else routesCreated += 1;
        const stored = makeRoute(route);
        state.routes.set(stored.slug, stored);
        publish(stored.slug);
      }
      let presetsCreated = 0;
      for (const preset of presets) {
        const stored = makePreset(preset);
        state.presets.set(stored.id, stored);
        presetsCreated += 1;
      }
      sendJson(res, 200, {
        routesCreated,
        routesUpdated,
        routesDeleted,
        presetsCreated,
        presetsUpdated: 0,
        presetsDeleted,
      });
      return;
    }

    sendError(res, 404, "NOT_FOUND", `The stub backend does not implement ${key}.`);
  }

  function sessionInfo() {
    const info = {
      authenticated: state.session.authenticated,
      authRequired: state.session.authRequired,
    };
    if (info.authenticated) {
      info.expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    }
    return info;
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;

    // The browser asks for this on every page load; answering keeps a 404 out of the console the
    // checks are counting.
    if (pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname.startsWith("/api/")) {
      handleApi(req, res, pathname, url).catch((error) => {
        sendError(res, 500, "INTERNAL_ERROR", `The stub backend threw: ${String(error)}`);
      });
      return;
    }

    serveStatic(req, res, pathname).catch(() => {
      res.writeHead(500);
      res.end();
    });
  });

  await new Promise((done) => server.listen(port, "0.0.0.0", done));

  return {
    state,
    publish,
    killStreams,
    killAudioStreams,
    makeRoute,
    makePreset,

    /** Replaces a route and tells every open stream about it, the way a real save would. */
    saveRoute(route) {
      const stored = makeRoute({ ...route, updatedAt: nowIso() });
      state.routes.set(stored.slug, stored);
      publish(stored.slug);
      return stored;
    },

    /** How many times a counted request has arrived. Keys look like `POLL main-camera`. */
    count(key) {
      return counts.get(key) ?? 0;
    },

    /** Every non-zero counter, for printing when a check fails. */
    snapshot() {
      return Object.fromEntries([...counts.entries()].filter(([, n]) => n > 0));
    },

    /** Forgets every counter, so a check can measure one window rather than the whole run. */
    resetCounts() {
      counts.clear();
    },

    /** How many event streams are open right now. Proves a page really closed its connection. */
    openStreams() {
      return subscribers.size;
    },

    /** How many browser sources are reading audio levels. Counted separately from `openStreams`. */
    openAudioStreams() {
      return audioSubscribers.size;
    },

    async close() {
      killAudioStreams();
      killStreams();
      await new Promise((done) => server.close(done));
    },
  };
}
