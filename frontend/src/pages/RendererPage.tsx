import { createEffect, createMemo, createSignal, onSettled, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { useParams } from "@solidjs/router";
import { ApiError, getRouteBySlug, routeEventsUrl } from "~/api/client";
import { getEffect } from "~/effects/registry";
import { EffectStage } from "~/components/EffectStage";
import { normaliseCanvas, type CanvasSettings, type RouteConfig } from "~/types/contract";

/**
 * How often the fallback poll re-checks the backend, in milliseconds.
 *
 * This is the *fallback*. While the event stream is delivering, no poll runs at all — see the
 * long comment on `subscribe()` below.
 */
const POLL_INTERVAL_MS = 5000;

/**
 * How long the stream may stay completely silent before it is treated as broken.
 *
 * The server sends a `heartbeat` event every 20 seconds, so 45 is a little over two intervals:
 * one lost heartbeat is not enough to trip it, two in a row is. The number is the client half of
 * the contract's §4 rule 4 and only makes sense next to the server's 20.
 */
const STREAM_SILENCE_LIMIT_MS = 45_000;

/** How often to check the silence above. Cheap, and the granularity nobody can perceive. */
const STREAM_WATCHDOG_INTERVAL_MS = 5000;

/**
 * How long to wait before replacing a stream that failed.
 *
 * The same 3 seconds the server asks for with its `retry: 3000` directive. Waiting rather than
 * reopening at once matters: `error` fires on every failed connection attempt, so an immediate
 * reopen against a backend that is down would be a reconnection loop as fast as the network can
 * refuse it.
 */
const STREAM_REOPEN_DELAY_MS = 3000;

/**
 * What is currently on screen, as far as the update path is concerned.
 *
 * `undefined` — nothing has been applied yet; `null` — the slug has no route ("absent"); an object
 * — that route, identified the way the contract says to identify a change.
 */
type Applied = { effectId: string; updatedAt: string } | null | undefined;

/**
 * `/e/:slug` — the page an OBS browser source points at.
 *
 * This is the only page a viewer of the stream ever indirectly sees, so its priorities are
 * different from the admin UI's:
 *
 *  - **Transparent.** No background colour, no scrollbars, no chrome, so OBS composites the
 *    effect over whatever is underneath it in the scene.
 *  - **Self-updating.** The backend *pushes* changes down an event stream, so a save in the admin
 *    reaches a live source in well under a second. A five-second poll survives as the fallback for
 *    when the stream cannot be kept open. Either way, a changed `updatedAt` hands the new
 *    parameters to the running effect without a reload, and a changed `effectId` swaps the effect.
 *  - **Loud about failures.** A misspelled slug draws an error message on screen. A silent black
 *    source is the worst outcome while you are live, because nothing tells you why.
 *  - **Never signed in.** Every endpoint this page calls is public, it holds no session, and it
 *    must never redirect anywhere. See the note under "the `enabled` rule" below and the routing
 *    comment in `src/index.tsx`.
 */
export default function RendererPage(): JSX.Element {
  const params = useParams<{ slug: string }>();

  const [route, setRoute] = createSignal<RouteConfig | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  /** False until the first answer of any kind has arrived, so a slow backend does not flash an error. */
  const [loaded, setLoaded] = createSignal(false);
  /** Size of the page itself, in CSS pixels — the OBS browser source's dimensions. */
  const [viewport, setViewport] = createSignal<{ width: number; height: number } | null>(null);

  /*
   * ── Live configuration: one event stream, one fallback poll, never both ─────────────────────
   *
   * Everything to do with talking to the backend lives inside this one effect, and it is written
   * as a `createEffect(compute, apply)` rather than an `onSettled` for one reason: `compute` reads
   * `params.slug`, so if the URL ever changes while this component stays mounted, Solid runs the
   * cleanup for the old slug and then sets the new one up. Setup and teardown cannot drift apart,
   * because they are the same pair of functions.
   *
   * ### The arbitration rule, which is the whole point of this block
   *
   * `docs/CONTRACT.md` §4 states one invariant: **exactly one of "the stream is healthy" and "the
   * five-second poll is running" is true at any moment.** Both at once doubles the traffic for
   * nothing; neither means a source frozen on stale settings for the length of a broadcast.
   *
   * It is implemented as two rules and nothing else:
   *
   *  1. Any message on the stream — `config`, `absent` **or** `heartbeat` — calls
   *     `streamDelivered()`, which stops the poll. That is what "healthy" means here: not "the
   *     socket is open" (a proxy can hold a buffered stream open forever while delivering nothing)
   *     but "something arrived".
   *  2. Anything that says the stream is not delivering — an `error` event, or the watchdog seeing
   *     45 seconds of silence — calls `streamFailed()`, which starts the poll and schedules a
   *     replacement stream.
   *
   * Both `startPoll()` and `stopPoll()` are idempotent, so however often either rule fires there
   * is at most one interval, and switching modes is logged exactly once per transition.
   *
   * ### Why an update can never be applied twice
   *
   * Both sources of truth funnel into `applyConfig()`, and that function compares the incoming
   * route against `applied` — a plain variable, deliberately *not* a signal. Solid 2 batches
   * signal writes to a microtask, so a poll and a stream event landing in the same tick would both
   * read the pre-write value of `route()` and both apply. A plain variable is written the instant
   * `applyConfig` decides to go ahead, so the second caller sees it and stops.
   *
   * `applied` is also what makes a reconnect converge: the server opens every stream with a full
   * `config` snapshot, so a stream that missed an update while it was down delivers the current
   * state the moment it comes back — and if that state is what is already on screen, this
   * comparison drops it rather than making the effect re-read parameters it already has.
   */
  createEffect(
    () => params.slug,
    (slug) => subscribe(slug),
  );

  /**
   * Opens the stream and the fallback poll for one slug, and returns the function that shuts both
   * down again.
   *
   * INVARIANT: every timer started here is cleared by the returned cleanup, the stream is closed,
   * and the in-flight request is aborted. An OBS browser source is created and destroyed far more
   * often than you would expect; a timer that outlives its page keeps hitting the backend forever,
   * an un-aborted fetch can resolve into a component that no longer exists, and an `EventSource`
   * nobody closed keeps reconnecting for as long as the tab is open.
   *
   * Every piece of state below is declared *inside* this function on purpose. A second call (a
   * different slug) gets its own timers, its own `applied` value and its own `cancelled` flag, so
   * a late response belonging to the previous slug cannot write anything.
   */
  function subscribe(slug: string): () => void {
    let stream: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let watchdogTimer: ReturnType<typeof setInterval> | undefined;
    let reopenTimer: ReturnType<typeof setTimeout> | undefined;
    let inFlight: AbortController | undefined;
    /** Set by the cleanup. Every asynchronous continuation checks it before touching a signal. */
    let cancelled = false;
    /** When the stream last produced a message, or when it was last opened. */
    let lastStreamMessageAt = 0;
    let applied: Applied = undefined;

    /* ---------------- the single place a new configuration is applied ---------------- */

    /**
     * Folds one `RouteConfig` — from the stream or from the poll — into the page.
     *
     * Replacing the object on every arrival would make `EffectStage` re-run its parameter effect
     * for no reason, five times a second on the poll and on every heartbeat-adjacent event on the
     * stream. Only a changed `updatedAt` means real new data, and every write bumps it, so a
     * canvas resize and an `enabled` toggle arrive that way too. `effectId` is compared as well
     * because it decides between a hot `setParams` and a full remount.
     */
    const applyConfig = (next: RouteConfig): void => {
      if (cancelled) return;
      setLoaded(true);
      // A configuration that arrived is proof the backend is answering, whatever it said last
      // time. Clearing before the comparison below matters: an unchanged route must still clear a
      // stale error, or a recovered backend would leave its message on screen forever.
      setError(null);
      if (applied && applied.effectId === next.effectId && applied.updatedAt === next.updatedAt) {
        return;
      }
      applied = { effectId: next.effectId, updatedAt: next.updatedAt };
      setRoute(next);
    };

    /**
     * Records that this slug has no route: a `404` from the poll, or an `absent` event.
     *
     * The message stays on screen until a configuration arrives, which is what makes creating the
     * route in the admin fix the source with no reload — the stream sends `config` the moment it
     * exists, and `applyConfig` clears the error.
     */
    const applyAbsent = (): void => {
      if (cancelled) return;
      setLoaded(true);
      /*
       * The message is written *before* the "nothing changed" test below, and that order matters.
       *
       * `applied === null` only says the last thing we applied was "no route"; it says nothing
       * about what is on screen, because a failure in between can have replaced the message. The
       * sequence that goes wrong is: the slug is absent, then one request fails with a 500 and its
       * message takes over, then the slug is reported absent again — and an early return here
       * would leave the 500 on screen for the rest of the broadcast, describing a problem that has
       * gone away.
       *
       * Re-setting it costs nothing when it is already correct: a Solid signal compares with
       * `===`, and two runs of this template literal produce equal strings, so nothing re-renders.
       */
      setError(
        `No route is configured for the slug “${slug}”. Create one in the admin UI at /admin.`,
      );
      if (applied === null) return;
      applied = null;
      setRoute(null);
    };

    /* ---------------- the fallback poll ---------------- */

    /** Fetches the route once. Used for the very first paint and by the fallback timer. */
    const poll = async (): Promise<void> => {
      inFlight?.abort();
      const controller = new AbortController();
      inFlight = controller;

      try {
        applyConfig(await getRouteBySlug(slug, controller.signal));
      } catch (e) {
        if (cancelled) return;
        if (e instanceof DOMException && e.name === "AbortError") return;
        if (e instanceof ApiError && e.isNotFound) {
          applyAbsent();
        } else if (e instanceof ApiError) {
          setLoaded(true);
          setError(e.message);
        } else {
          // A transient network blip while OBS runs for hours is normal; keep drawing the effect
          // that is already on screen and try again on the next tick.
          setLoaded(true);
          console.warn("[renderer] Could not refresh the route configuration; will retry.", e);
        }
      }
    };

    const startPoll = (): void => {
      if (pollTimer !== undefined || cancelled) return;
      console.info(
        `[renderer] Falling back to polling every ${POLL_INTERVAL_MS / 1000}s for “${slug}”.`,
      );
      void poll();
      pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    };

    const stopPoll = (): void => {
      if (pollTimer === undefined) return;
      clearInterval(pollTimer);
      pollTimer = undefined;
      inFlight?.abort();
      inFlight = undefined;
      console.info(`[renderer] Live updates are flowing for “${slug}”; polling stopped.`);
    };

    /* ---------------- the event stream ---------------- */

    /**
     * Reads the `data:` line of a custom SSE event.
     *
     * `EventSource.addEventListener` is typed with a `MessageEvent` only for the three event names
     * the DOM declares (`open`, `message`, `error`). Every server-named event — which is all three
     * of ours — falls through to the plain `EventListener` overload, whose parameter is `Event`.
     * The value really is a `MessageEvent`, so the narrowing below is a statement of that fact
     * rather than a way round a type error; `MessageEvent<unknown>` keeps `data` at `unknown` so
     * nothing downstream is trusted without checking it.
     */
    const eventData = (event: Event): string | null => {
      const data: unknown = (event as MessageEvent<unknown>).data;
      return typeof data === "string" ? data : null;
    };

    /** Any message at all means the stream is doing its job, so the poll can stand down. */
    const streamDelivered = (): void => {
      lastStreamMessageAt = Date.now();
      stopPoll();
    };

    /**
     * The stream is not delivering: start the fallback and line up a replacement connection.
     *
     * Reopening rather than trusting `EventSource`'s own reconnection is the contract's §4 rule 5,
     * and the reason is the failure this page cannot otherwise detect: a reverse proxy that
     * buffers the response holds the connection open forever while delivering nothing, which the
     * browser has no reason to treat as an error and so never retries.
     */
    const streamFailed = (): void => {
      if (cancelled) return;
      startPoll();
      if (reopenTimer !== undefined) return;
      reopenTimer = setTimeout(() => {
        reopenTimer = undefined;
        if (cancelled) return;
        /*
         * The browser retries a dropped stream on its own, and it may well have succeeded during
         * these three seconds — in which case the server has already re-sent its opening snapshot
         * and `streamDelivered` has run. Tearing that down to build an identical one would drop a
         * working connection, so an open stream that has produced something recently is left
         * alone.
         */
        const recovered =
          stream?.readyState === EventSource.OPEN &&
          Date.now() - lastStreamMessageAt < STREAM_SILENCE_LIMIT_MS;
        if (!recovered) openStream();
      }, STREAM_REOPEN_DELAY_MS);
    };

    /** Closes the current stream, if any. Safe to call when there is none. */
    const closeStream = (): void => {
      if (!stream) return;
      /*
       * Nothing removes the listeners, and nothing needs to: they were added to *this*
       * `EventSource` object, which is closed and then dropped. A new connection is a new object
       * with its own listeners, so however many times this page reconnects, exactly one set of
       * handlers is ever live. This is the shape that keeps a reconnect from stacking listeners.
       */
      stream.close();
      stream = null;
    };

    /** Replaces the current stream with a fresh connection to this slug's events. */
    const openStream = (): void => {
      if (cancelled) return;
      closeStream();

      let opened: EventSource;
      try {
        opened = new EventSource(routeEventsUrl(slug));
      } catch (e) {
        // Constructing an EventSource only throws for a malformed URL, which would mean a
        // misconfigured VITE_API_BASE. The poll uses the same base and will report it properly.
        console.error("[renderer] Could not open the configuration event stream.", e);
        startPoll();
        return;
      }

      stream = opened;
      // The clock starts at the attempt, not at the first message, so a connection that never
      // says anything is caught by the watchdog rather than waiting forever.
      lastStreamMessageAt = Date.now();

      opened.addEventListener("config", (event) => {
        streamDelivered();
        const raw = eventData(event);
        if (raw === null) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (e) {
          console.warn("[renderer] Ignoring a config event whose payload is not JSON.", e);
          return;
        }
        // The stream is the primary source of what OBS draws, so a malformed payload must leave
        // the running effect alone rather than replacing a live scene with a broken one.
        if (!isRouteConfig(parsed)) {
          console.warn("[renderer] Ignoring a config event that is not a route configuration.");
          return;
        }
        applyConfig(parsed);
      });

      opened.addEventListener("absent", () => {
        streamDelivered();
        applyAbsent();
      });

      // The heartbeat carries a timestamp nothing here needs. Its only job is to prove the
      // connection is alive, which `streamDelivered` records — that is why the server sends a
      // named event with a payload rather than an SSE comment, which the browser would not
      // deliver to the page at all.
      opened.addEventListener("heartbeat", () => streamDelivered());

      opened.addEventListener("error", () => {
        // Fires for a dropped connection and for every failed retry. Guarding on identity keeps a
        // late error from a stream that has already been replaced from restarting the dance.
        if (stream !== opened) return;
        streamFailed();
      });
    };

    /* ---------------- start everything ---------------- */

    /*
     * The poll starts first and the stream immediately after, and that order is the invariant
     * rather than an exception to it: "healthy" is false until the stream has said something, so
     * until then the poll is the thing keeping the page correct. It also means the first frame
     * never waits for a stream to open — the ordinary `GET` inside `startPoll()` is already on its
     * way. The stream's opening `config` snapshot then stops the poll, normally within a few
     * hundred milliseconds of the page loading.
     */
    startPoll();

    if (typeof EventSource === "undefined") {
      // A runtime with no EventSource (a very old embedded browser) polls and nothing more. The
      // page is then exactly as good as it was before Phase 2, which is the point of keeping the
      // poll rather than replacing it.
      console.warn(
        "[renderer] This browser has no EventSource, so live updates are unavailable; polling only.",
      );
    } else {
      openStream();
      watchdogTimer = setInterval(() => {
        if (cancelled || !stream) return;
        if (Date.now() - lastStreamMessageAt < STREAM_SILENCE_LIMIT_MS) return;
        console.warn(
          `[renderer] No event for ${STREAM_SILENCE_LIMIT_MS / 1000}s on “${slug}”; ` +
            "treating the stream as broken and reconnecting.",
        );
        streamFailed();
      }, STREAM_WATCHDOG_INTERVAL_MS);
    }

    return () => {
      cancelled = true;
      if (pollTimer !== undefined) clearInterval(pollTimer);
      if (watchdogTimer !== undefined) clearInterval(watchdogTimer);
      if (reopenTimer !== undefined) clearTimeout(reopenTimer);
      inFlight?.abort();
      closeStream();
    };
  }

  /*
   * The page's own presentation, which has nothing to do with the backend.
   *
   * `onSettled` is Solid 2's replacement for `onMount`: it runs after the first render has settled
   * and, unlike `onMount`, the function it returns is the cleanup. Setup and teardown therefore sit
   * in one place instead of two, which is how they stay in step.
   */
  onSettled(() => {
    /*
     * `body.renderer` strips the page down to a transparent surface. It is applied here rather
     * than in the stylesheet so that navigating from /admin to /e/:slug and back in an ordinary
     * browser tab restores the dark admin theme.
     */
    document.body.classList.add("renderer");

    /*
     * ── Watching the size of the browser source ──────────────────────────────────────────────
     *
     * This drives the scale factor below, and nothing else. It is emphatically NOT what the effect
     * is told to draw at any more: that is the route's canvas size. An operator who drags the OBS
     * source wider gets the same pixels, scaled up — which is the point of a render resolution.
     *
     * The page element is observed rather than `window.resize` being listened for, because a
     * `ResizeObserver` also fires for the initial layout (so the first measurement needs no
     * separate call) and because disconnecting one is a single call rather than a `removeEventListener`
     * that has to be handed the identical function reference.
     */
    const viewportObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const box = entry.contentRect;
      setViewport({
        width: Math.max(1, Math.round(box.width)),
        height: Math.max(1, Math.round(box.height)),
      });
    });
    viewportObserver.observe(document.documentElement);

    return () => {
      document.body.classList.remove("renderer");
      viewportObserver.disconnect();
    };
  });

  /**
   * The route's render resolution, with the defaults filled in.
   *
   * `normaliseCanvas` is belt and braces: the backend promises a complete `canvas` on every
   * response, including for documents saved before the field existed. Filling in the same defaults
   * here means a backend that has not been upgraded yet renders at 1920×1080 rather than throwing
   * on `undefined.width` in the middle of a broadcast.
   */
  const canvas = createMemo<CanvasSettings>(() => normaliseCanvas(route()?.canvas));

  /**
   * How much to shrink (or grow) the fixed-size canvas block so that it fits the browser source.
   *
   * `min` of the two ratios preserves the aspect ratio and guarantees the whole canvas is visible;
   * whatever is left over at the edges stays transparent, so the OBS scene underneath shows there
   * rather than black bars. Before the first measurement there is nothing to scale to, so 1 is
   * used — one frame at the wrong size is invisible, and clamping to a lower bound avoids a
   * division producing 0 and collapsing the effect to nothing.
   */
  const scale = createMemo(() => {
    const size = viewport();
    if (!size) return 1;
    const c = canvas();
    return Math.min(size.width / c.width, size.height / c.height);
  });

  /**
   * The implementation to run, or `undefined` when the route is off, missing, or names an effect
   * this build does not contain.
   *
   * ── The `enabled: false` rule, which lives here and nowhere else ────────────────────────────
   *
   * A disabled route still answers `200` with its whole configuration, and still streams, so the
   * admin can open, preview and edit it. What the flag changes is only what *this page* draws:
   *
   *  1. Nothing visible. No canvas, no error box, a fully transparent page — switching a layer off
   *     mid-stream has to look like the layer was never there.
   *  2. A mounted effect is **disposed**, not hidden. That happens for free below: returning
   *     `undefined` makes the `<Show>` unmount `<EffectStage>`, whose cleanup calls `dispose()`.
   *     A hidden canvas would keep rendering, and freeing the GPU is the reason an operator
   *     reaches for the toggle in the first place. Re-enabling mounts a fresh instance; the effect
   *     lifecycle has no pause state, deliberately.
   *  3. The admin's preview pane ignores the flag entirely and always draws, because you have to
   *     see what you are editing. That is why this test is in this file and not in
   *     `EffectStage.tsx`, which the preview shares.
   *
   * INVARIANT: this returns the registry's own module object, whose identity is stable for a given
   * effect id. `EffectStage` treats a change of identity as "remount", so returning a fresh object
   * here — or looking the module up again on every parameter change — would remount the effect on
   * every save and make OBS flash.
   */
  const module = createMemo(() => {
    const config = route();
    if (!config || !config.enabled) return undefined;
    return getEffect(config.effectId);
  });

  /** The route's sparse parameter values; `EffectStage` merges the descriptor defaults in. */
  const values = createMemo<Record<string, unknown>>(() => route()?.params ?? {});

  /**
   * The message to draw on screen, or `null` to draw nothing.
   *
   * A *disabled* route deliberately produces no message: turning a layer off is a normal action,
   * and an error box appearing in the scene would be worse than the blank the admin asked for.
   */
  const visibleError = createMemo<string | null>(() => {
    if (!loaded()) return null;
    if (error()) return error();
    const config = route();
    if (!config) return null;
    if (!config.enabled) return null;
    if (!getEffect(config.effectId)) {
      return `The route “${config.slug}” uses the effect “${config.effectId}”, which this build does not implement. Pick a different effect in the admin UI.`;
    }
    return null;
  });

  return (
    <div class="renderer-root">
      <Show when={module()}>
        {(implementation) => (
          /*
           * The host is laid out at exactly the canvas size and then scaled as a whole. The
           * stylesheet centres it (`top: 50%; left: 50%` plus the `translate(-50%, -50%)` below);
           * the transform-origin is the element's own centre, so scaling keeps it centred.
           *
           * Everything the effect sees stays in canvas pixels: a route set to 1280×720 hands
           * `mount` and `resize` those numbers whatever size the OBS source happens to be.
           */
          <EffectStage
            class="renderer-host"
            module={implementation()}
            params={values()}
            width={canvas().width}
            height={canvas().height}
            fpsCap={canvas().fpsCap}
            style={{
              width: `${canvas().width}px`,
              height: `${canvas().height}px`,
              transform: `translate(-50%, -50%) scale(${scale()})`,
            }}
          />
        )}
      </Show>

      <Show when={visibleError()}>
        {(message) => (
          <div class="renderer-error">
            <strong>OBS Effects</strong>
            {message()}
          </div>
        )}
      </Show>
    </div>
  );
}

/**
 * Is this parsed JSON usable as a `RouteConfig`?
 *
 * The stream's payload is the one input to this page that is not produced by the typed API client,
 * so it is the one that has to be checked at runtime. The test is deliberately narrow: the four
 * fields this page actually reads before handing the object on. Anything else the server sends is
 * carried along untouched, and a payload missing one of these four is dropped with a warning
 * rather than replacing a live scene with `undefined`.
 */
function isRouteConfig(value: unknown): value is RouteConfig {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RouteConfig>;
  return (
    typeof candidate.slug === "string" &&
    typeof candidate.effectId === "string" &&
    typeof candidate.enabled === "boolean" &&
    typeof candidate.updatedAt === "string"
  );
}
