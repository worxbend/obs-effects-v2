import * as PIXI from "pixi.js";

import { colorHex, num } from "../paramUtils";
import { createPixiStage, defineEffect, onFrame } from "../sdk";

/**
 * Glitch Veil
 * ===========
 *
 * A transparent overlay that mostly does nothing: a faint scanline band drifting down the frame,
 * interrupted every few seconds by a short burst of RGB slice tearing, chromatic blocks and static.
 * Then it goes quiet again.
 *
 * Ported from `glitch-veil.html` in the old `obs-effects` repository.
 *
 * Restraint is the design
 * -----------------------
 * Most glitch overlays run continuously, and after ten seconds a viewer stops seeing them — or
 * worse, cannot read what is underneath. This one is built the other way round: the bursts are 0.18
 * to 0.55 seconds long with 2.2 to 6.5 seconds of near-silence between them, so the scene below
 * always reads clearly and the glitch keeps its ability to startle.
 *
 * That is why the defaults are so conservative, and why the burst parameters have a wide range: you
 * can turn this into a permanent wall of noise, but the effect is worth more when you do not.
 *
 * The stutter
 * -----------
 * During a burst the contents are re-rolled at 18 per second rather than every frame. A glitch that
 * changes 60 times a second averages out into an even shimmer; one that changes 18 times a second
 * reads as broken machinery. The frame rate is unchanged — only the rate at which new randomness is
 * drawn.
 */

/** The three channel colours the slices and blocks are split into. */
const DEFAULT_SPLIT = ["#ff2244", "#22ff88", "#2266ff"] as const;

/** How often the contents of a burst are re-rolled, in seconds. */
const MICRO_TICK = 1 / 18;

/** A random number between `min` and `max`. */
function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

const glitchVeil = defineEffect({
  descriptor: {
    id: "glitch-veil",
    name: "Glitch Veil",
    description:
      "A mostly-invisible overlay: a faint drifting scanline band, punctuated every few seconds by a short burst of RGB tearing, chromatic blocks and static.",
    engine: "pixi",
    category: "overlay",
    tags: ["glitch", "overlay", "corruption", "scanlines", "subtle"],
    previewNotes:
      "Transparent by design — lay it over a camera or a capture. It is quiet most of the time and you may have to wait several seconds to see a burst; that restraint is the point. Shorten Burst Gap if you want to see what it does.",
    params: [
      {
        key: "intensity",
        label: "Intensity",
        kind: "number",
        default: 1,
        min: 0.1,
        max: 3,
        step: 0.05,
        description:
          "Scales how much is drawn during a burst — slice count, block count and static density together.",
      },
      {
        key: "burstGapMin",
        label: "Burst Gap (min)",
        kind: "number",
        default: 2.2,
        min: 0.1,
        max: 30,
        step: 0.1,
        description: "Shortest quiet period between bursts, in seconds.",
      },
      {
        key: "burstGapMax",
        label: "Burst Gap (max)",
        kind: "number",
        default: 6.5,
        min: 0.2,
        max: 60,
        step: 0.1,
        description:
          "Longest quiet period. Set it close to the minimum for a metronomic glitch, far apart for an unpredictable one.",
      },
      {
        key: "burstLength",
        label: "Burst Length",
        kind: "number",
        default: 0.36,
        min: 0.05,
        max: 4,
        step: 0.01,
        description:
          "Roughly how long a burst lasts, in seconds. Each one varies by about half this either way.",
      },
      {
        key: "scanlines",
        label: "Scanline Opacity",
        kind: "number",
        default: 0.035,
        min: 0,
        max: 0.3,
        step: 0.005,
        description:
          "The always-on band drifting down the frame. 0 removes it and leaves only the bursts.",
      },
      {
        key: "scanColor",
        label: "Scanline Colour",
        kind: "color",
        default: "#aaccff",
        description: "Colour of the drifting band.",
      },
      {
        key: "colorR",
        label: "Split Colour 1",
        kind: "color",
        default: "#ff2244",
        description:
          "The three colours slices and blocks are split into, mimicking a mistimed RGB signal.",
      },
      {
        key: "colorG",
        label: "Split Colour 2",
        kind: "color",
        default: "#22ff88",
        description: "",
      },
      {
        key: "colorB",
        label: "Split Colour 3",
        kind: "color",
        default: "#2266ff",
        description: "",
      },
    ],
  },

  async setup({ ctx, scope }) {
    const stage = await createPixiStage(scope, ctx);

    const scanLayer = stage.stage.addChild(new PIXI.Graphics());
    const sliceLayer = stage.stage.addChild(new PIXI.Graphics());
    const blockLayer = stage.stage.addChild(new PIXI.Graphics());
    const staticLayer = stage.stage.addChild(new PIXI.Graphics());

    // Additive blending on the slices and blocks, so overlapping colours brighten towards white the
    // way a real signal artefact does, rather than the later one simply covering the earlier.
    sliceLayer.blendMode = "add";
    blockLayer.blendMode = "add";

    let intensity = num(ctx.params, "intensity", 1, 0.1, 3);
    let gapMin = num(ctx.params, "burstGapMin", 2.2, 0.1, 30);
    let gapMax = num(ctx.params, "burstGapMax", 6.5, 0.2, 60);
    let burstLength = num(ctx.params, "burstLength", 0.36, 0.05, 4);
    let scanAlpha = num(ctx.params, "scanlines", 0.035, 0, 0.3);
    let scanColor = colorHex(ctx.params, "scanColor", "#aaccff");
    let split: string[] = [
      colorHex(ctx.params, "colorR", DEFAULT_SPLIT[0]),
      colorHex(ctx.params, "colorG", DEFAULT_SPLIT[1]),
      colorHex(ctx.params, "colorB", DEFAULT_SPLIT[2]),
    ];

    let time = 0;
    let bursting = false;
    let burstEnd = 0;
    /*
     * The first burst is scheduled from the *configured* gap rather than a fixed 0.8-to-2.5 seconds,
     * for the same reason as its sibling `data-corruption`: an operator who shortens the gap should
     * see the change immediately rather than waiting out a hard-coded delay first.
     */
    let nextBurst = rand(Math.min(gapMin, gapMax), Math.max(gapMin, gapMax));
    let microTimer = 0;
    let burstStrength = 1;

    let scanY = 0;
    let scanSpeed = 46;

    stage.onResize((_w, h) => {
      scanY = rand(0, h);
    });

    /** Draws one stutter frame of a burst. Called 18 times a second while bursting, not every frame. */
    const drawBurst = (): void => {
      const w = stage.width;
      const h = stage.height;
      const s = burstStrength * intensity;

      // ── RGB slice bars ──────────────────────────────────────────────────
      sliceLayer.clear();
      const sliceCount = 2 + Math.floor(rand(0, 4) * s);
      for (let i = 0; i < sliceCount; i += 1) {
        const y = rand(0, h);
        const sliceHeight = rand(3, 26);
        const shift = rand(8, 60) * s * (Math.random() < 0.5 ? -1 : 1);
        // The three channels are drawn at different horizontal offsets, which is what produces the
        // colour fringing of a mistimed signal rather than a plain coloured bar.
        for (let c = 0; c < 3; c += 1) {
          sliceLayer
            .rect(shift * (c - 1) * 0.6, y, w, sliceHeight)
            .fill({ color: split[c] ?? "#ffffff", alpha: rand(0.04, 0.12) * s });
        }
        if (Math.random() < 0.5) {
          sliceLayer
            .rect(0, y + (Math.random() < 0.5 ? 0 : sliceHeight), w, 1)
            .fill({ color: "#ffffff", alpha: rand(0.08, 0.2) * s });
        }
      }

      // ── Chromatic blocks ────────────────────────────────────────────────
      blockLayer.clear();
      const blockCount = Math.floor(rand(2, 7) * s);
      for (let i = 0; i < blockCount; i += 1) {
        const bw = rand(40, 320);
        const bh = rand(8, 70);
        const x = rand(-20, Math.max(0, w - bw) + 20);
        const y = rand(0, Math.max(0, h - bh));
        const fringe = rand(2, 9) * s;
        blockLayer.rect(x, y, bw, bh).fill({
          color: split[Math.floor(rand(0, 3))] ?? "#ffffff",
          alpha: rand(0.05, 0.14) * s,
        });
        // A white copy offset by a few pixels, which reads as the block's own edge fringing.
        blockLayer
          .rect(x + fringe, y, bw, bh)
          .fill({ color: "#ffffff", alpha: rand(0.02, 0.05) * s });
      }

      // ── Static ──────────────────────────────────────────────────────────
      staticLayer.clear();
      // Confined to a couple of horizontal strips rather than the whole frame. Full-frame static
      // hides whatever is underneath, which is the one thing this overlay must not do.
      const strips = 1 + Math.floor(rand(0, 2));
      for (let st = 0; st < strips; st += 1) {
        const sy = rand(0, Math.max(0, h - 40));
        const sh = rand(14, 44);
        const dots = Math.floor(rand(60, 160) * s);
        for (let i = 0; i < dots; i += 1) {
          staticLayer.rect(rand(0, w), sy + rand(0, sh), rand(1, 3), 1).fill({
            color: Math.random() > 0.5 ? "#ffffff" : "#000000",
            alpha: rand(0.1, 0.4) * s,
          });
        }
      }
    };

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      time += dt;
      const w = stage.width;
      const h = stage.height;

      // ── The always-on scan band ─────────────────────────────────────────
      scanY += scanSpeed * dt;
      const bandHeight = 90;
      if (scanY > h + bandHeight) {
        scanY = -bandHeight;
        // A new speed each pass, so it never settles into a predictable rhythm.
        scanSpeed = rand(30, 70);
      }

      scanLayer.clear();
      if (scanAlpha > 0) {
        const flicker = 0.6 + 0.4 * Math.sin(time * 11);
        for (let i = 0; i < 4; i += 1) {
          scanLayer.rect(0, scanY + i * 5, w, 1.5).fill({
            color: scanColor,
            alpha: scanAlpha * flicker * (1 - i * 0.2),
          });
        }
      }

      // ── Burst scheduling ────────────────────────────────────────────────
      if (bursting) {
        microTimer -= dt;
        if (microTimer <= 0) {
          microTimer = MICRO_TICK;
          drawBurst();
        }
        if (time >= burstEnd) {
          bursting = false;
          // Guard the order: these are two independent sliders and a maximum below the minimum
          // would make the gap negative, firing a burst every frame.
          const low = Math.min(gapMin, gapMax);
          const high = Math.max(gapMin, gapMax);
          nextBurst = time + rand(low, high);
          sliceLayer.clear();
          blockLayer.clear();
          staticLayer.clear();
        }
      } else if (time >= nextBurst) {
        bursting = true;
        burstEnd = time + rand(burstLength * 0.5, burstLength * 1.5);
        burstStrength = rand(0.5, 1);
        microTimer = 0;
      }

      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        intensity = num(p, "intensity", 1, 0.1, 3);
        gapMin = num(p, "burstGapMin", 2.2, 0.1, 30);
        gapMax = num(p, "burstGapMax", 6.5, 0.2, 60);
        burstLength = num(p, "burstLength", 0.36, 0.05, 4);
        scanAlpha = num(p, "scanlines", 0.035, 0, 0.3);
        scanColor = colorHex(p, "scanColor", "#aaccff");
        split = [
          colorHex(p, "colorR", DEFAULT_SPLIT[0]),
          colorHex(p, "colorG", DEFAULT_SPLIT[1]),
          colorHex(p, "colorB", DEFAULT_SPLIT[2]),
        ];
      },
    };
  },
});

export default glitchVeil;
