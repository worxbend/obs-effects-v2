/**
 * The instrumentation injected into every page before any application code runs.
 *
 * It is exported as **source text** rather than as a function, because it does not run in this
 * Node process at all: Playwright ships it to the browser with `addInitScript`, where it patches
 * two browser APIs and records what happens. Writing it as a string keeps that boundary obvious —
 * nothing in here may reference anything from the harness.
 *
 * ## What it records, and why each one is hard to observe any other way
 *
 *  - **A number on every canvas.** The renderer must call `setParams` on the running effect when a
 *    parameter changes and must remount when the effect changes. From outside, the difference is
 *    whether the `<canvas>` in the host div is *the same element* before and after. An element has
 *    no identity that survives a round trip out of the browser, so one is stamped on it here, the
 *    first time anything asks it for a drawing context.
 *
 *  - **Every WebGL context ever created, and whether it is still alive.** A leaked context is the
 *    failure that eventually stops every effect on the machine from drawing, and it is invisible
 *    until it is far too late. Counting raw creations is not enough: Pixi creates throwaway
 *    contexts to find out what the GPU supports, and those inflate the total without ever being a
 *    leak. What matters is how many are *live* — created and not yet lost — which the harness
 *    compares before and after a batch of mount/dispose cycles.
 *
 *  - **Every call to `loseContext()`.** This is how "disposed exactly once" is proved rather than
 *    assumed. The three Three.js effects end their `dispose()` with `renderer.forceContextLoss()`,
 *    which calls `WEBGL_lose_context.loseContext()` on their own context — so twenty mount/dispose
 *    cycles must produce exactly twenty calls, on twenty different contexts, with none called
 *    twice. Two calls on one context would be a double dispose; fewer than twenty would be an
 *    effect that was never torn down.
 *
 * Nothing here changes behaviour: both patches call straight through to the original and return
 * what it returned.
 */

export const PROBE_SOURCE = `
(() => {
  if (window.__probe) return;

  const probe = {
    canvasSeq: 0,
    /** Every WebGL context seen, in creation order. */
    contexts: [],
    /** One entry per loseContext() call: which context, and how many calls it has had so far. */
    loseCalls: [],
  };
  window.__probe = probe;

  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const context = originalGetContext.call(this, type, ...rest);
    if (this.__probeCanvasId === undefined) {
      probe.canvasSeq += 1;
      this.__probeCanvasId = probe.canvasSeq;
    }
    if (context && String(type).toLowerCase().indexOf("webgl") !== -1) {
      const known = probe.contexts.some((entry) => entry.context === context);
      if (!known) {
        probe.contexts.push({
          id: probe.contexts.length + 1,
          canvasId: this.__probeCanvasId,
          type: String(type),
          context: context,
          attached: this.isConnected,
        });
      }
    }
    return context;
  };

  const patchGetExtension = (prototype) => {
    if (!prototype) return;
    const originalGetExtension = prototype.getExtension;
    prototype.getExtension = function (name) {
      const extension = originalGetExtension.call(this, name);
      if (extension && String(name) === "WEBGL_lose_context" && !extension.__probeWrapped) {
        const owner = this;
        const originalLose = extension.loseContext;
        extension.loseContext = function () {
          const entry = probe.contexts.find((candidate) => candidate.context === owner);
          probe.loseCalls.push({ contextId: entry ? entry.id : -1 });
          return originalLose.apply(extension, arguments);
        };
        extension.__probeWrapped = true;
      }
      return extension;
    };
  };
  patchGetExtension(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype);
  patchGetExtension(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype);

  /** Everything the harness reads, as plain JSON-safe values. */
  probe.report = () => {
    const live = probe.contexts.filter((entry) => !entry.context.isContextLost());
    const perContext = {};
    for (const call of probe.loseCalls) {
      perContext[call.contextId] = (perContext[call.contextId] || 0) + 1;
    }
    return {
      canvasesSeen: probe.canvasSeq,
      contextsCreated: probe.contexts.length,
      contextsLive: live.length,
      loseCalls: probe.loseCalls.length,
      loseCallsPerContext: perContext,
      contextsLosedTwice: Object.values(perContext).filter((n) => n > 1).length,
    };
  };

  /** The identity of the canvas inside a selector, or null when there is none. */
  probe.canvasIdIn = (selector) => {
    const host = document.querySelector(selector);
    if (!host) return null;
    const canvas = host.querySelector("canvas");
    return canvas ? canvas.__probeCanvasId ?? null : null;
  };

  /** How many canvases are inside a selector. More than one means a leak in the host div. */
  probe.canvasCountIn = (selector) => {
    const host = document.querySelector(selector);
    return host ? host.querySelectorAll("canvas").length : 0;
  };
})();
`;
