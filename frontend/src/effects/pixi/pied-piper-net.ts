import * as PIXI from "pixi.js";

import { colorInt, int, num } from "../paramUtils";
import { createPixiStage, defineEffect, onFrame, useChat } from "../sdk";

/**
 * Pied Piper Net
 * ==============
 *
 * A deep-red "network" ambience: a couple of dozen dots drift and bounce around the frame, joined
 * by hairline links whose opacity fades with distance — the classic connected-particles motif, in
 * the red of a certain fictional compression company's logo. On every chat message a radial burst
 * of particles fires from a random point, the particles themselves growing links to each other as
 * they fly, under a brief red screen flash.
 *
 * Ported from `scenes/silicon-valley/silicon-valley.ts` in the twitch-vizer project. What changed
 * in the port:
 *
 *  - The old scene listened on its own `OverlayEventSocket` and had a spacebar test trigger; both
 *    are replaced by the shared chat SDK (`useChat`) — any chat message fires a burst, and the
 *    SDK's simulated feed stands in for the keyboard when Twitch is not configured.
 *  - The old scene owned a fullscreen `PIXI.Application` on `document.body`; here the stage comes
 *    from `createPixiStage` and lives in the route's canvas host, resized by the renderer.
 *  - The original ticker measured time in 60-fps frames (`deltaTime` is about 1 per frame at
 *    60 fps). Every constant below is kept verbatim in those units, and the SDK's seconds-based
 *    `dt` is converted once per frame — so the motion survives the port unchanged.
 *  - Hard-coded scene constants (node count, link distance, burst size, the palette) became
 *    parameters.
 *
 * The effect draws no message content at all — no text, no emotes. Chat is purely its trigger.
 */

const WHITE = 0xf5f5f5;

interface NetworkNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  color: number;
  life: number;
  maxLife: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const piedPiperNet = defineEffect({
  descriptor: {
    id: "pied-piper-net",
    name: "Pied Piper Net",
    description:
      "A red network graph of drifting, bouncing dots with distance-faded links; every chat message fires a radial particle burst — the burst particles linking to each other as they fly — under a brief red screen flash.",
    engine: "pixi",
    category: "chat",
    tags: ["chat", "twitch", "network", "particles", "burst", "red", "overlay"],
    previewNotes:
      "Transparent: lay it over anything dark for the links to read. The network drifts constantly; the bursts fire on chat messages. When Twitch is not configured, a simulated chat feed fires them every few seconds instead, so the preview always shows the full behaviour.",
    params: [
      {
        key: "nodeCount",
        label: "Node Count",
        kind: "number",
        default: 18,
        min: 2,
        max: 80,
        step: 1,
        description:
          "How many dots make up the background network. More dots means more links, since links appear between every pair that comes close enough.",
      },
      {
        key: "linkDistance",
        label: "Link Distance",
        kind: "number",
        default: 170,
        min: 40,
        max: 500,
        step: 5,
        description:
          "How close two network dots must be, in pixels, before a link is drawn between them. Links fade to nothing as the pair approaches this distance.",
      },
      {
        key: "nodeSpeed",
        label: "Node Speed",
        kind: "number",
        default: 1,
        min: 0,
        max: 4,
        step: 0.05,
        description: "Scales how fast the background dots drift. 0 freezes the network in place.",
      },
      {
        key: "burstSize",
        label: "Burst Size",
        kind: "number",
        default: 36,
        min: 4,
        max: 120,
        step: 1,
        description:
          "Roughly how many particles one chat message throws (each burst varies a little either side of this).",
      },
      {
        key: "burstSpeed",
        label: "Burst Speed",
        kind: "number",
        default: 1,
        min: 0.1,
        max: 4,
        step: 0.05,
        description:
          "Scales how fast burst particles fly out. They decelerate as they go, so higher values also spread the burst wider.",
      },
      {
        key: "flashStrength",
        label: "Flash Strength",
        kind: "number",
        default: 1,
        min: 0,
        max: 3,
        step: 0.05,
        description:
          "Scales the brief whole-frame red flash on each burst. 0 removes the flash and keeps only the particles.",
      },
      {
        key: "colorPrimary",
        label: "Network Colour",
        kind: "color",
        default: "#cc2229",
        description:
          "The network dots and links, and most of the burst particles. The original's Pied Piper logo red.",
      },
      {
        key: "colorGlow",
        label: "Glow Colour",
        kind: "color",
        default: "#e8473f",
        description: "A hotter red used for some burst particles and for the screen flash.",
      },
      {
        key: "colorAccent",
        label: "Accent Colour",
        kind: "color",
        default: "#22d3ee",
        description:
          "The rare cool accent mixed into bursts — a fifth of the particles — so they are not a wall of red.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    const stage = await createPixiStage(scope, ctx);

    const chat = await useChat(scope);
    scope.checkpoint();

    let nodeCount = int(ctx.params, "nodeCount", 18, 2, 80);
    let linkDistance = num(ctx.params, "linkDistance", 170, 40, 500);
    let nodeSpeed = num(ctx.params, "nodeSpeed", 1, 0, 4);
    let burstSize = num(ctx.params, "burstSize", 36, 4, 120);
    let burstSpeed = num(ctx.params, "burstSpeed", 1, 0.1, 4);
    let flashStrength = num(ctx.params, "flashStrength", 1, 0, 3);
    let colorPrimary = colorInt(ctx.params, "colorPrimary", "#cc2229");
    let colorGlow = colorInt(ctx.params, "colorGlow", "#e8473f");
    let colorAccent = colorInt(ctx.params, "colorAccent", "#22d3ee");

    // Layer order matches the original: network at the bottom, flash on top.
    const networkGfx = stage.stage.addChild(new PIXI.Graphics());
    const burstGfx = stage.stage.addChild(new PIXI.Graphics());
    const flashGfx = stage.stage.addChild(new PIXI.Graphics());

    const nodes: NetworkNode[] = [];
    const spawnNode = (): NetworkNode => ({
      x: Math.random() * stage.width,
      y: Math.random() * stage.height,
      vx: (Math.random() < 0.5 ? -1 : 1) * (0.15 + Math.random() * 0.25),
      vy: (Math.random() < 0.5 ? -1 : 1) * (0.15 + Math.random() * 0.25),
      r: 1.5 + Math.random() * 1.5,
    });

    const particles: Particle[] = [];
    let flashActive = false;
    let flashAge = 0;

    /** The chat-event burst — a faithful copy of the original's `trigger()`. */
    const trigger = (): void => {
      const w = stage.width;
      const h = stage.height;

      // Random origin, kept away from the edges so bursts favour a spread across the screen. The
      // margin shrinks on small previews so the range never goes negative.
      const marginX = Math.min(80, w * 0.2);
      const marginY = Math.min(80, h * 0.2);
      const ox = marginX + Math.random() * (w - marginX * 2);
      const oy = marginY + Math.random() * (h - marginY * 2);

      // The primary red appears twice, so the colour odds match the original's five-entry
      // palette: 2/5 red, 1/5 glow red, 1/5 accent, 1/5 white.
      const palette = [colorPrimary, colorGlow, colorAccent, WHITE, colorPrimary];
      // The original threw 28..45; the parameter shifts the range, keeping the +0..17 spread.
      const count = Math.max(1, Math.round(burstSize - 8)) + Math.floor(Math.random() * 18);

      for (let i = 0; i < count; i += 1) {
        // Angles distributed evenly around the circle with a little jitter, so the burst is
        // clearly radial without being a perfect geometric ring.
        const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
        const speed = (1.8 + Math.random() * 5.5) * burstSpeed;
        particles.push({
          x: ox,
          y: oy,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          r: 1.2 + Math.random() * 3.2,
          color: palette[Math.floor(Math.random() * palette.length)] ?? colorPrimary,
          life: 0,
          maxLife: 38 + Math.random() * 36,
        });
      }

      // A handful of near-stationary white particles at the origin: they linger where the burst
      // began, giving the connection lines something to anchor to — a short "connection flash".
      for (let i = 0; i < 6; i += 1) {
        const angle = Math.random() * Math.PI * 2;
        particles.push({
          x: ox,
          y: oy,
          vx: Math.cos(angle) * 0.4,
          vy: Math.sin(angle) * 0.4,
          r: 0.8,
          color: WHITE,
          life: 0,
          maxLife: 18 + Math.random() * 12,
        });
      }

      flashAge = 0;
      flashActive = true;
    };

    /*
     * Chat wiring. The backlog from `recent()` is deliberately collapsed to at most ONE trigger:
     * this effect renders no message content, so replaying fifty history messages would stack
     * fifty bursts at load. One burst proves the event path is alive without flooding the frame.
     */
    if (chat.recent().length > 0) trigger();
    const off = chat.onMessage(() => trigger());
    scope.defer(off);

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      // The one seconds→frames conversion. Everything below is verbatim original arithmetic.
      const delta = dt * 60;
      const w = stage.width;
      const h = stage.height;

      // The pool grows or shrinks lazily towards the parameter, so retuning it mid-run needs no
      // reset; a shrink drops the newest nodes, which nothing on screen distinguishes anyway.
      while (nodes.length < nodeCount) nodes.push(spawnNode());
      if (nodes.length > nodeCount) nodes.length = nodeCount;

      networkGfx.clear();

      // Bounce the nodes off the frame edges. Clamping before the bounce test also folds a
      // resize in for free: a node stranded outside a shrunken frame snaps back to the edge.
      for (const n of nodes) {
        n.x = clamp(n.x + n.vx * nodeSpeed * delta, 0, w);
        n.y = clamp(n.y + n.vy * nodeSpeed * delta, 0, h);
        if (n.x <= 0 || n.x >= w) n.vx *= -1;
        if (n.y <= 0 || n.y >= h) n.vy *= -1;
      }

      // Links between every close-enough pair, fading linearly with distance. O(n²), which is
      // why the node-count parameter caps at 80 — 3160 distance checks is still nothing.
      for (let i = 0; i < nodes.length; i += 1) {
        for (let j = i + 1; j < nodes.length; j += 1) {
          const a = nodes[i];
          const b = nodes[j];
          if (a === undefined || b === undefined) continue;
          const dist = Math.hypot(b.x - a.x, b.y - a.y);
          if (dist < linkDistance) {
            networkGfx
              .moveTo(a.x, a.y)
              .lineTo(b.x, b.y)
              .stroke({ color: colorPrimary, width: 1, alpha: (1 - dist / linkDistance) * 0.1 });
          }
        }
      }

      for (const n of nodes) {
        networkGfx.circle(n.x, n.y, n.r).fill({ color: colorPrimary, alpha: 0.22 });
      }

      // Burst particles: decelerate exponentially, fade in fast over the first 15% of life and
      // fade out linearly over the rest.
      burstGfx.clear();
      for (let i = particles.length - 1; i >= 0; i -= 1) {
        const p = particles[i];
        if (p === undefined) continue;
        p.life += delta;
        if (p.life >= p.maxLife) {
          particles.splice(i, 1);
          continue;
        }

        // pow(0.92, delta) rather than *0.92 keeps the drag frame-rate independent: two frames
        // at half rate decelerate exactly as much as one frame at full rate.
        p.vx *= Math.pow(0.92, delta);
        p.vy *= Math.pow(0.92, delta);
        p.x += p.vx * delta;
        p.y += p.vy * delta;

        const t = p.life / p.maxLife;
        const alpha = clamp((1 - t) * (t < 0.15 ? t / 0.15 : 1), 0, 1);
        burstGfx.circle(p.x, p.y, p.r).fill({ color: p.color, alpha });
      }

      // Faint links between nearby burst particles — the same motif as the background network,
      // which is what makes a burst read as the network momentarily densifying rather than as
      // unrelated fireworks. Fades with the older particle's age so lines die with their dots.
      for (let i = 0; i < particles.length; i += 1) {
        for (let j = i + 1; j < particles.length; j += 1) {
          const a = particles[i];
          const b = particles[j];
          if (a === undefined || b === undefined) continue;
          const dist = Math.hypot(b.x - a.x, b.y - a.y);
          if (dist < 80) {
            const lt = Math.max(a.life / a.maxLife, b.life / b.maxLife);
            burstGfx
              .moveTo(a.x, a.y)
              .lineTo(b.x, b.y)
              .stroke({ color: colorPrimary, width: 0.8, alpha: (1 - dist / 80) * (1 - lt) * 0.35 });
          }
        }
      }

      // The screen flash: eight frames of hot red across the whole frame, fading linearly.
      flashGfx.clear();
      if (flashActive) {
        flashAge += delta;
        if (flashAge < 8) {
          flashGfx
            .rect(0, 0, w, h)
            .fill({ color: colorGlow, alpha: clamp((1 - flashAge / 8) * 0.09 * flashStrength, 0, 1) });
        } else {
          flashActive = false;
        }
      }

      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        nodeCount = int(p, "nodeCount", 18, 2, 80);
        linkDistance = num(p, "linkDistance", 170, 40, 500);
        nodeSpeed = num(p, "nodeSpeed", 1, 0, 4);
        burstSize = num(p, "burstSize", 36, 4, 120);
        burstSpeed = num(p, "burstSpeed", 1, 0.1, 4);
        flashStrength = num(p, "flashStrength", 1, 0, 3);
        colorPrimary = colorInt(p, "colorPrimary", "#cc2229");
        colorGlow = colorInt(p, "colorGlow", "#e8473f");
        colorAccent = colorInt(p, "colorAccent", "#22d3ee");
      },
    };
  },
});

export default piedPiperNet;
