import * as PIXI from "pixi.js";

import { bool, colorHex, num } from "../paramUtils";
import { createPixiStage, defineEffect, onFrame } from "../sdk";

/**
 * Glitch Overlay
 * ==============
 *
 * A VHS tape playing badly. Permanent CRT scanlines and chromatic bleed at the top and bottom edges,
 * with four independent faults firing over the top of it: displaced bands with scan corruption, RGB
 * channel separation, clustered digital noise, and a bright tape-head line that sweeps down the
 * frame every ten seconds or so.
 *
 * Ported from `glitch-overlay.html` in the old `obs-effects` repository, where it was an inline Pixi
 * page rather than a screen class.
 *
 * Four independent timers, which is the whole trick
 * ------------------------------------------------
 * Each fault has its own schedule and none of them know about the others. Bands fire every 1 to 5.5
 * seconds, RGB splits every 1.5 to 6.5, noise every 1.5 to 5.5, the tape head every 5 to 14. Because
 * those periods share no common multiple, the *combination* never repeats: sometimes two land
 * together and it looks catastrophic, sometimes one lands alone.
 *
 * A single timer choosing randomly between four kinds of fault would produce the same shapes and
 * feel obviously mechanical, because only one thing could ever be wrong at a time.
 *
 * The one place they do talk to each other: the tape-head sweep and the band displacement share a
 * layer, so a sweep in progress suppresses bands rather than fighting them for the same pixels.
 *
 * Where it sits
 * -------------
 * Transparent, and busier than either `glitch-veil` or `data-corruption` — this one is always doing
 * something. Reach for it when the *look* is "bad tape" rather than "an occasional fault".
 */

/** The palette the original picked its fault colours from. */
const PALETTE = {
  cyan: "#00ffff",
  magenta: "#ff00ff",
  green: "#00ff41",
  red: "#ff1a1a",
  white: "#ffffff",
  yellow: "#ffff00",
} as const;

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randInt(min: number, max: number): number {
  return Math.floor(rand(min, max + 1));
}

function pick<T>(items: readonly T[], fallback: T): T {
  return items[Math.floor(Math.random() * items.length)] ?? fallback;
}

const glitchOverlay = defineEffect({
  descriptor: {
    id: "glitch-overlay",
    name: "Glitch Overlay",
    description:
      "A VHS tape playing badly: permanent scanlines and edge bleed, with displaced bands, RGB separation, digital noise and a sweeping tape-head line firing over the top.",
    engine: "pixi",
    category: "overlay",
    tags: ["glitch", "vhs", "overlay", "scanlines", "crt", "retro"],
    previewNotes:
      "Transparent — lay it over a camera or a capture. The busiest of the three glitch overlays: something is happening most of the time, where Glitch Veil and Data Corruption are mostly quiet. Drop Intensity to about 0.3 for a subtle tape feel.",
    params: [
      {
        key: "intensity",
        label: "Intensity",
        kind: "number",
        default: 1,
        min: 0,
        max: 3,
        step: 0.05,
        description:
          "Scales every fault at once — how many bands, how far they shift, how much noise. 0 leaves only the permanent scanlines and edge bleed.",
      },
      {
        key: "frequency",
        label: "Fault Frequency",
        kind: "number",
        default: 1,
        min: 0.1,
        max: 5,
        step: 0.05,
        description:
          "How often faults fire. Above 1 shortens every gap; below 1 stretches them out. The four faults keep their independent rhythms either way.",
      },
      {
        key: "scanlines",
        label: "Scanlines",
        kind: "number",
        default: 0.1,
        min: 0,
        max: 0.5,
        step: 0.01,
        description: "Opacity of the permanent horizontal CRT lines. 0 removes them.",
      },
      {
        key: "scanlineGap",
        label: "Scanline Pitch",
        kind: "number",
        default: 3,
        min: 2,
        max: 12,
        step: 1,
        description:
          "Pixels between scanlines. Small values are a fine CRT; large are a coarse one.",
      },
      {
        key: "edgeBleed",
        label: "Edge Bleed",
        kind: "number",
        default: 1,
        min: 0,
        max: 3,
        step: 0.05,
        description:
          "The permanent chromatic fringing along the top and bottom edges — the give-away of a worn tape.",
      },
      {
        key: "flicker",
        label: "Flicker",
        kind: "boolean",
        default: true,
        description:
          "The CRT brightness swell, high-frequency shimmer and occasional stray beam line across the whole frame.",
      },
      {
        key: "tapeHead",
        label: "Tape Head Sweep",
        kind: "boolean",
        default: true,
        description:
          "The bright line with a trailing smear that sweeps down the frame every ten seconds or so.",
      },
      {
        key: "colorA",
        label: "Fault Colour 1",
        kind: "color",
        default: "#00ffff",
        description: "Fault colours are picked at random from these three plus white.",
      },
      {
        key: "colorB",
        label: "Fault Colour 2",
        kind: "color",
        default: "#00ff41",
        description: "",
      },
      {
        key: "colorC",
        label: "Fault Colour 3",
        kind: "color",
        default: "#ff00ff",
        description: "",
      },
    ],
  },

  async setup({ ctx, scope }) {
    const stage = await createPixiStage(scope, ctx, { antialias: false });

    // Six layers, back to front. The permanent two are rebuilt only on resize; the rest are cleared
    // and redrawn as their faults come and go.
    const scanLayer = stage.stage.addChild(new PIXI.Graphics());
    const edgeLayer = stage.stage.addChild(new PIXI.Graphics());
    const bandLayer = stage.stage.addChild(new PIXI.Graphics());
    const rgbLayer = stage.stage.addChild(new PIXI.Graphics());
    const noiseLayer = stage.stage.addChild(new PIXI.Graphics());
    const flickerLayer = stage.stage.addChild(new PIXI.Graphics());

    let intensity = num(ctx.params, "intensity", 1, 0, 3);
    let frequency = num(ctx.params, "frequency", 1, 0.1, 5);
    let scanAlpha = num(ctx.params, "scanlines", 0.1, 0, 0.5);
    let scanGap = num(ctx.params, "scanlineGap", 3, 2, 12);
    let edgeBleed = num(ctx.params, "edgeBleed", 1, 0, 3);
    let showFlicker = bool(ctx.params, "flicker", true);
    let showTapeHead = bool(ctx.params, "tapeHead", true);
    let faultColors: string[] = [
      colorHex(ctx.params, "colorA", PALETTE.cyan),
      colorHex(ctx.params, "colorB", PALETTE.green),
      colorHex(ctx.params, "colorC", PALETTE.magenta),
      PALETTE.white,
    ];

    /** The two permanent layers. Rebuilt only when the size or their parameters change. */
    const buildStatic = (): void => {
      const w = stage.width;
      const h = stage.height;

      scanLayer.clear();
      if (scanAlpha > 0) {
        for (let y = 0; y < h; y += scanGap) {
          scanLayer.rect(0, y, w, 1).fill({ color: "#000000", alpha: scanAlpha });
        }
      }

      edgeLayer.clear();
      if (edgeBleed > 0) {
        // Five bands of decreasing opacity at each edge, with the colour pairs offset by a couple of
        // pixels — the same channel-misalignment trick the faults use, but permanent and only at the
        // edges, which is where a worn tape actually shows it.
        for (let i = 0; i < 5; i += 1) {
          const a = (5 - i) * 0.013 * edgeBleed;
          edgeLayer.rect(0, i * 2, w, 2).fill({ color: PALETTE.cyan, alpha: a });
          edgeLayer.rect(2, i * 2, w, 2).fill({ color: PALETTE.magenta, alpha: a * 0.5 });
          edgeLayer.rect(0, h - i * 2 - 2, w, 2).fill({ color: PALETTE.red, alpha: a * 0.9 });
          edgeLayer.rect(-2, h - i * 2 - 2, w, 2).fill({ color: PALETTE.cyan, alpha: a * 0.4 });
        }
      }
    };

    buildStatic();
    stage.onResize(buildStatic);

    let time = 0;

    // Four faults, four independent schedules. See the header for why that matters.
    let bandTimer = rand(1.5, 4);
    let bandActive = false;
    let bandEnd = 0;
    let bandStrength = 1;

    let rgbTimer = rand(2, 5.5);
    let rgbActive = false;
    let rgbEnd = 0;
    let rgbStrength = 1;

    let noiseTimer = rand(0.8, 2.5);
    let noiseActive = false;
    let noiseEnd = 0;

    let headTimer = rand(5, 12);
    let headActive = false;
    let headY = 0;

    const drawBands = (s: number): void => {
      const w = stage.width;
      const h = stage.height;
      bandLayer.clear();

      const bands = randInt(2, Math.ceil(8 * s));
      for (let i = 0; i < bands; i += 1) {
        const y = rand(0, h);
        const bh = rand(1, 10 + 22 * s);
        const xo = rand(-30, 30) * s;
        bandLayer
          .rect(xo, y, w, bh)
          .fill({ color: pick(faultColors, PALETTE.white), alpha: rand(0.03, 0.22 * s) });

        // Speckle inside the band, which is what makes it read as corrupted scan data rather than
        // as a translucent coloured bar.
        const speckles = Math.floor(bh * 5 * s);
        for (let p = 0; p < speckles; p += 1) {
          const ps = rand(1, 2.5);
          bandLayer.rect(rand(0, w), y + rand(0, bh), ps, ps).fill({
            color: pick([...faultColors, "#000000"], PALETTE.white),
            alpha: rand(0.4, 1),
          });
        }
      }

      // The head-switch artefact: a faint bright stripe near the very bottom, which on a real tape
      // is where the drum hands over. It appears about two times in five.
      if (Math.random() < 0.4) {
        bandLayer
          .rect(0, h * rand(0.86, 0.98), w, rand(1, 3))
          .fill({ color: PALETTE.white, alpha: rand(0.15, 0.5) });
      }
    };

    const drawRgbSplit = (s: number): void => {
      const w = stage.width;
      const h = stage.height;
      rgbLayer.clear();

      const bands = randInt(1, Math.ceil(5 * s));
      for (let i = 0; i < bands; i += 1) {
        const y = rand(0, h);
        const bh = rand(2, 32 * s);
        const shift = rand(3, 15 * s);
        // Red pushed one way, blue the other, green almost in place — the classic misregistration.
        rgbLayer.rect(shift, y, w, bh).fill({ color: "#ff0000", alpha: rand(0.05, 0.18) });
        rgbLayer.rect(-shift, y, w, bh).fill({ color: "#0000ff", alpha: rand(0.05, 0.18) });
        rgbLayer.rect(0, y - 1, w, bh).fill({ color: "#00ff41", alpha: rand(0.03, 0.1) });
      }
    };

    const drawNoise = (s: number): void => {
      const w = stage.width;
      const h = stage.height;
      noiseLayer.clear();

      // Clustered rather than spread evenly. Uniform speckle over the whole frame reads as film
      // grain; clusters read as data arriving corrupted in chunks.
      const clusters = randInt(2, 6);
      for (let c = 0; c < clusters; c += 1) {
        const cx = rand(0, w);
        const cy = rand(0, h);
        const rx = rand(20, 140);
        const ry = rand(4, 40);
        const count = Math.floor(randInt(80, 420) * s);
        for (let i = 0; i < count; i += 1) {
          const ps = rand(1, 3);
          noiseLayer.rect(cx + rand(-rx, rx), cy + rand(-ry, ry), ps, ps).fill({
            color: pick([...faultColors, PALETTE.red, PALETTE.yellow], PALETTE.white),
            alpha: rand(0.4, 1),
          });
        }
      }
    };

    const drawTapeHead = (y: number): void => {
      const w = stage.width;
      bandLayer.clear();
      bandLayer.rect(0, y, w, 2).fill({ color: PALETTE.white, alpha: 0.55 });
      // Trailing smear above the line — the tape has not caught up yet.
      for (let i = 1; i <= 10; i += 1) {
        bandLayer.rect(0, y - i, w, 1).fill({ color: PALETTE.cyan, alpha: 0.07 / i });
      }
    };

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      time += dt;
      const w = stage.width;
      const h = stage.height;
      const s = intensity;

      // ── Displaced bands ─────────────────────────────────────────────────
      bandTimer -= dt * frequency;
      if (!bandActive && bandTimer <= 0 && s > 0) {
        bandActive = true;
        bandStrength = rand(0.4, 2) * s;
        bandEnd = time + rand(0.03, 0.2);
        bandTimer = rand(1, 5.5);
      }
      if (bandActive) {
        if (time >= bandEnd) {
          bandActive = false;
          bandLayer.clear();
        } else if (!headActive) {
          // Suppressed while the tape head is sweeping: they share a layer, and two faults fighting
          // for the same pixels reads as a bug rather than as a fault.
          drawBands(bandStrength);
        }
      }

      // ── RGB separation ──────────────────────────────────────────────────
      rgbTimer -= dt * frequency;
      if (!rgbActive && rgbTimer <= 0 && s > 0) {
        rgbActive = true;
        rgbStrength = rand(0.5, 2) * s;
        rgbEnd = time + rand(0.04, 0.24);
        rgbTimer = rand(1.5, 6.5);
      }
      if (rgbActive) {
        if (time >= rgbEnd) {
          rgbActive = false;
          rgbLayer.clear();
        } else {
          drawRgbSplit(rgbStrength);
        }
      }

      // ── Noise ───────────────────────────────────────────────────────────
      noiseTimer -= dt * frequency;
      if (!noiseActive && noiseTimer <= 0 && s > 0) {
        noiseActive = true;
        noiseEnd = time + rand(0.06, 0.28);
        noiseTimer = rand(1.5, 5.5);
      }
      if (noiseActive) {
        if (time >= noiseEnd) {
          noiseActive = false;
          noiseLayer.clear();
        } else {
          drawNoise(s);
        }
      }

      // ── Tape head sweep ─────────────────────────────────────────────────
      if (showTapeHead) {
        headTimer -= dt * frequency;
        if (!headActive && headTimer <= 0) {
          headActive = true;
          headY = 0;
          headTimer = rand(5, 14);
        }
        if (headActive) {
          headY += dt * h * 1.3;
          if (headY > h) {
            headActive = false;
            bandLayer.clear();
          } else {
            drawTapeHead(headY);
          }
        }
      }

      // ── Flicker ─────────────────────────────────────────────────────────
      flickerLayer.clear();
      if (showFlicker) {
        // A slow swell and a fast shimmer summed, plus a rare hard spike. Two frequencies rather
        // than one is what keeps it from reading as a sine wave.
        const slow = Math.sin(time * 4.7) * 0.5 + 0.5;
        const fast = Math.sin(time * 53.1) * 0.5 + 0.5;
        const spike = Math.random() < 0.015 ? rand(0.08, 0.28) : 0;
        const a = slow * 0.025 + fast * 0.005 + spike;
        if (a > 0.003) flickerLayer.rect(0, 0, w, h).fill({ color: "#ffffff", alpha: a });

        // A stray electron-beam line, roughly once every fourteen frames.
        if (Math.random() < 0.07) {
          flickerLayer
            .rect(0, rand(0, h), w, 1)
            .fill({ color: PALETTE.white, alpha: rand(0.04, 0.18) });
        }
      }

      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        const previousScanAlpha = scanAlpha;
        const previousGap = scanGap;
        const previousBleed = edgeBleed;

        intensity = num(p, "intensity", 1, 0, 3);
        frequency = num(p, "frequency", 1, 0.1, 5);
        scanAlpha = num(p, "scanlines", 0.1, 0, 0.5);
        scanGap = num(p, "scanlineGap", 3, 2, 12);
        edgeBleed = num(p, "edgeBleed", 1, 0, 3);
        showFlicker = bool(p, "flicker", true);
        showTapeHead = bool(p, "tapeHead", true);
        faultColors = [
          colorHex(p, "colorA", PALETTE.cyan),
          colorHex(p, "colorB", PALETTE.green),
          colorHex(p, "colorC", PALETTE.magenta),
          PALETTE.white,
        ];

        // The permanent layers are drawn once, so they only need rebuilding when something that
        // defines them actually changed.
        if (
          scanAlpha !== previousScanAlpha ||
          scanGap !== previousGap ||
          edgeBleed !== previousBleed
        ) {
          buildStatic();
        }
      },
    };
  },
});

export default glitchOverlay;
