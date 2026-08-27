import * as PIXI from "pixi.js";

import { bool, num } from "../paramUtils";
import { createPixiStage, defineEffect, onFrame, useChat } from "../sdk";

/**
 * Mr. Robot CRT
 * =============
 *
 * A cold, always-on CRT ambience in the palette of the show's title cards: dark scanlines, a heavy
 * corner vignette, a slow sweep line crawling down the screen, film grain that re-rolls a few times
 * a second, occasional single-scanline micro-static, and a subtle blue-leaning desaturation applied
 * to the whole stage with a `ColorMatrixFilter`. On any Twitch chat event the picture "loses hold"
 * for under a second: a stack of displaced horizontal bands with red/cyan chromatic-aberration
 * fringes and a brief cold-white flash.
 *
 * Ported from `scenes/mr-robot/mr-robot.ts` in the old twitch-vizer repository. What changed:
 *
 *  - The old scene opened its own `OverlayEventSocket`; this version reads the shared chat bus via
 *    `useChat`, so messages, subs, cheers and raids all trigger the glitch. The SDK's simulated
 *    feed triggers it when Twitch is not configured.
 *  - The keyboard preview (space bar) is gone; the simulated feed replaces it.
 *  - Timings were counted in ticker frames at an assumed 60 fps; they run on `dt` seconds here and
 *    are converted, so the route's frame-rate cap does not slow the ambience down.
 *  - The scanline and vignette layers, which the original built once for the initial window size,
 *    are rebuilt on resize.
 *  - The hard-coded strengths (scanline darkness, vignette depth, grain density, micro-static
 *    cadence, glitch size and duration) are parameters now.
 */

/* The show's palette, unchanged from the original scene. */
const COLD_BLUE = 0x4888b8;
const COLD_WHITE = 0xd8e4ec;
const BG_DARK = 0x050810;
const GLITCH_RED = 0xff2838;
const GLITCH_CYN = 0x00d8ff;
const AMBER = 0xc8a040;

/** The original's timings were in ticker frames with a 60 fps baseline; multiplying `dt` seconds
 * by this reproduces them under any fps cap. */
const BASE_FPS = 60;

interface GlitchBand {
  y: number;
  h: number;
  /** Horizontal displacement of the band — positive shoves right, negative left. */
  shiftX: number;
  color: number;
  alpha: number;
}

interface Glitch {
  active: boolean;
  age: number;
  bands: GlitchBand[];
}

interface MicroBurst {
  x: number;
  y: number;
  w: number;
  color: number;
  alpha: number;
  life: number;
  maxLife: number;
}

const mrRobotCrt = defineEffect({
  descriptor: {
    id: "mr-robot-crt",
    name: "Mr. Robot CRT",
    description:
      "Cold CRT ambience — scanlines, vignette, sweep line, film grain and a blue desaturation — that loses hold in a chromatic-aberration glitch whenever Twitch chat moves.",
    engine: "pixi",
    category: "chat",
    tags: ["chat", "twitch", "crt", "glitch", "scanlines", "ambience", "overlay"],
    previewNotes:
      "The ambience runs constantly; the glitch fires once per chat event. When Twitch is not configured, the SDK's simulated chat feed fires it every few seconds, so the preview shows both halves. Transparent apart from its own layers: lay it over a camera or capture.",
    params: [
      {
        key: "scanlineAlpha",
        label: "Scanline Darkness",
        kind: "number",
        default: 0.16,
        min: 0,
        max: 0.6,
        step: 0.01,
        description:
          "Opacity of the dark line drawn every third pixel row. 0 removes the scanlines entirely.",
      },
      {
        key: "vignetteStrength",
        label: "Vignette",
        kind: "number",
        default: 1,
        min: 0,
        max: 2,
        step: 0.05,
        description: "Scales how far the dark edges creep in. 0 removes the vignette.",
      },
      {
        key: "sweepSpeed",
        label: "Sweep Speed",
        kind: "number",
        default: 1,
        min: 0,
        max: 5,
        step: 0.05,
        description:
          "Speed of the faint line crawling down the screen. 1 crosses a 1080p frame in roughly 45 seconds, as the original did; 0 parks it.",
      },
      {
        key: "grainDensity",
        label: "Grain Density",
        kind: "number",
        default: 1,
        min: 0,
        max: 3,
        step: 0.05,
        description:
          "Scales how many grain specks are scattered per re-roll. 0 switches the grain off.",
      },
      {
        key: "grainRefresh",
        label: "Grain Refresh",
        kind: "number",
        default: 0.083,
        min: 0.02,
        max: 1,
        step: 0.001,
        description:
          "Seconds between grain re-rolls. The original re-rolled every 5 frames (about 0.083 s); slower values make the grain hang like dust instead of shimmering.",
      },
      {
        key: "staticRate",
        label: "Micro-Static Rate",
        kind: "number",
        default: 1,
        min: 0,
        max: 4,
        step: 0.05,
        description:
          "How often clusters of single-scanline static flicker somewhere on screen. 1 means every 3 to 8 seconds; 0 disables them.",
      },
      {
        key: "glitchDuration",
        label: "Glitch Length",
        kind: "number",
        default: 0.87,
        min: 0.2,
        max: 3,
        step: 0.01,
        description: "How long the chat-triggered glitch lasts, in seconds.",
      },
      {
        key: "glitchBands",
        label: "Glitch Bands",
        kind: "number",
        default: 1,
        min: 0.2,
        max: 3,
        step: 0.05,
        description:
          "Scales how many displaced bands one glitch throws. 1 gives the original's 10 to 21.",
      },
      {
        key: "glitchShift",
        label: "Glitch Displacement",
        kind: "number",
        default: 1,
        min: 0,
        max: 3,
        step: 0.05,
        description:
          "Scales how far the glitch bands are shoved sideways. 0 leaves them in place, so only the flicker and the red/cyan fringes show.",
      },
      {
        key: "coldTint",
        label: "Cold Tint",
        kind: "boolean",
        default: true,
        description:
          "Applies the blue-leaning desaturation filter over everything this effect draws. Turn it off if the tint fights the colours of whatever sits underneath.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    // Antialiasing off: every layer is 1-to-4-pixel-tall rectangles, and smoothing them would
    // blur the scanline structure the whole look depends on.
    const stage = await createPixiStage(scope, ctx, { antialias: false });

    let scanlineAlpha = num(ctx.params, "scanlineAlpha", 0.16, 0, 0.6);
    let vignetteStrength = num(ctx.params, "vignetteStrength", 1, 0, 2);
    let sweepSpeed = num(ctx.params, "sweepSpeed", 1, 0, 5);
    let grainDensity = num(ctx.params, "grainDensity", 1, 0, 3);
    let grainRefresh = num(ctx.params, "grainRefresh", 0.083, 0.02, 1);
    let staticRate = num(ctx.params, "staticRate", 1, 0, 4);
    let glitchDuration = num(ctx.params, "glitchDuration", 0.87, 0.2, 3);
    let glitchBands = num(ctx.params, "glitchBands", 1, 0.2, 3);
    let glitchShift = num(ctx.params, "glitchShift", 1, 0, 3);
    let coldTint = bool(ctx.params, "coldTint", true);

    /* Layer order bottom to top, as in the original: static scanlines, vignette, the animated
     * ambient layer (sweep + micro-static), grain, and the glitch on top of everything. */
    const scanlineGfx = stage.stage.addChild(new PIXI.Graphics());
    const vignetteGfx = stage.stage.addChild(new PIXI.Graphics());
    const ambientGfx = stage.stage.addChild(new PIXI.Graphics());
    const noiseGfx = stage.stage.addChild(new PIXI.Graphics());
    const glitchGfx = stage.stage.addChild(new PIXI.Graphics());

    /* The cool desaturation from the original: mostly-identity matrix that pulls red and green
     * down a touch, mixes a little of each channel into the others, and lifts blue. */
    const tint = new PIXI.ColorMatrixFilter();
    // prettier-ignore
    tint.matrix = [
      0.88, 0.02, 0.06, 0, -0.02,
      0,    0.88, 0.04, 0, -0.01,
      0.04, 0.04, 1.06, 0,  0.02,
      0,    0,    0,    1,  0,
    ];
    const applyTint = (): void => {
      stage.stage.filters = coldTint ? [tint] : [];
    };
    applyTint();

    /** Dark line every third row. Rebuilt only on resize or when the darkness param changes —
     * it is by far the most rectangles of any layer, so it must not be redrawn per frame. */
    const buildScanlines = (): void => {
      scanlineGfx.clear();
      if (scanlineAlpha <= 0) return;
      const w = stage.width;
      const h = stage.height;
      for (let y = 0; y < h; y += 3) {
        scanlineGfx.rect(0, y, w, 1).fill({ color: 0x000000, alpha: scanlineAlpha });
      }
    };

    /** Vignette as 22 concentric rectangle frames with quadratically falling opacity — cheap to
     * draw once and indistinguishable from a radial gradient at these alphas. */
    const buildVignette = (): void => {
      vignetteGfx.clear();
      if (vignetteStrength <= 0) return;
      const w = stage.width;
      const h = stage.height;
      const dim = Math.min(w, h);
      for (let i = 0; i < 22; i += 1) {
        const t = i / 22;
        const alpha = Math.min(1, Math.pow(1 - t, 2) * 0.32 * vignetteStrength);
        const inset = t * 0.32 * dim;
        vignetteGfx.rect(0, 0, w, inset).fill({ color: 0x000000, alpha });
        vignetteGfx.rect(0, h - inset, w, inset).fill({ color: 0x000000, alpha });
        vignetteGfx.rect(0, 0, inset, h).fill({ color: 0x000000, alpha });
        vignetteGfx.rect(w - inset, 0, inset, h).fill({ color: 0x000000, alpha });
      }
    };

    buildScanlines();
    buildVignette();
    stage.onResize(() => {
      buildScanlines();
      buildVignette();
    });

    let elapsed = 0;
    let noiseClock = Number.POSITIVE_INFINITY; // forces a grain roll on the first frame
    let microTimer = 180;
    const microBursts: MicroBurst[] = [];
    let glitch: Glitch = { active: false, age: 0, bands: [] };

    /** Fires the "signal loses hold" glitch. A direct port of the original `trigger()`. */
    const trigger = (): void => {
      const h = stage.height;
      // Black and the background navy are deliberately in the palette: bands that darken are
      // what sells the picture dropping out, not only bands that brighten.
      const palette = [COLD_BLUE, GLITCH_CYN, COLD_WHITE, GLITCH_RED, 0x000000, BG_DARK, AMBER];
      const bands: GlitchBand[] = [];
      const count = Math.round((10 + Math.floor(Math.random() * 12)) * glitchBands);

      for (let i = 0; i < count; i += 1) {
        bands.push({
          y: Math.random() * h,
          // Heights weighted towards 1 and 2 pixels, with the occasional 4-pixel slab.
          h: [1, 1, 1, 2, 2, 2, 4][Math.floor(Math.random() * 7)] ?? 1,
          shiftX: (Math.random() - 0.5) * 72 * glitchShift,
          color: palette[Math.floor(Math.random() * palette.length)] ?? COLD_BLUE,
          alpha: 0.14 + Math.random() * 0.58,
        });
      }

      // A new event replaces any glitch still playing rather than stacking on it — a busy chat
      // then reads as the signal being continuously unstable, not as an ever-brighter pile-up.
      glitch = { active: true, age: 0, bands };
    };

    const chat = await useChat(scope);
    scope.checkpoint();
    // Every chat event — message, sub, cheer, raid — knocks the signal, as the old scene's
    // event socket did.
    const off = chat.onMessage(() => {
      trigger();
    });
    scope.defer(off);

    /** Sweep line plus micro-static, redrawn every frame into the ambient layer. */
    const tickAmbient = (delta: number): void => {
      const w = stage.width;
      const h = stage.height;
      ambientGfx.clear();

      // Slow CRT sweep line, scrolling top to bottom with a fainter trailing row.
      const scanY = (elapsed * 0.38 * sweepSpeed) % h;
      ambientGfx.rect(0, scanY, w, 1).fill({ color: 0x607890, alpha: 0.07 });
      ambientGfx.rect(0, scanY + 1, w, 1).fill({ color: 0x607890, alpha: 0.03 });

      // Schedule random clusters of tiny one-scanline bursts.
      if (staticRate > 0) {
        microTimer -= delta * staticRate;
        if (microTimer <= 0) {
          const count = 2 + Math.floor(Math.random() * 4);
          for (let i = 0; i < count; i += 1) {
            const bw = 20 + Math.random() * 70;
            microBursts.push({
              x: Math.random() * Math.max(1, w - bw),
              y: Math.random() * h,
              w: bw,
              color: [COLD_BLUE, COLD_WHITE, AMBER, 0xffffff][Math.floor(Math.random() * 4)] ??
                COLD_WHITE,
              alpha: 0.06 + Math.random() * 0.14,
              life: 0,
              maxLife: 8 + Math.random() * 12,
            });
          }
          microTimer = 180 + Math.random() * 300; // every 3–8 s at the 60 fps baseline
        }
      }

      // Draw and age the micro bursts.
      for (let i = microBursts.length - 1; i >= 0; i -= 1) {
        const b = microBursts[i];
        if (b === undefined) continue;
        b.life += delta;
        if (b.life >= b.maxLife) {
          microBursts.splice(i, 1);
          continue;
        }
        const fade = 1 - b.life / b.maxLife;
        ambientGfx.rect(b.x, b.y, b.w, 1).fill({ color: b.color, alpha: b.alpha * fade });
      }
    };

    /** Re-scatters the film grain: 2×2 specks, 70% dark and 30% pale blue, one per ~3000 px². */
    const refreshNoise = (): void => {
      const w = stage.width;
      const h = stage.height;
      noiseGfx.clear();
      if (grainDensity <= 0) return;
      const count = Math.round(((w * h) / 3000) * grainDensity);
      for (let i = 0; i < count; i += 1) {
        const dark = Math.random() < 0.7;
        const color = dark ? 0x080c14 : 0x8aaac4;
        noiseGfx
          .rect(Math.random() * w, Math.random() * h, 2, 2)
          .fill({ color, alpha: 0.06 + Math.random() * 0.1 });
      }
    };

    /** Draws the active glitch, if any, into the top layer. */
    const renderGlitch = (delta: number): void => {
      glitchGfx.clear();
      if (!glitch.active) return;

      const duration = glitchDuration * BASE_FPS;
      glitch.age += delta;

      if (glitch.age >= duration) {
        glitch.active = false;
        return;
      }

      const sw = stage.width;
      const sh = stage.height;
      const progress = glitch.age / duration;
      // Full strength for the first 55% of the glitch, then a linear fade to nothing.
      const fade = progress > 0.55 ? 1 - (progress - 0.55) / 0.45 : 1;

      // Cold-white full-screen flash for the first six frames — the moment of impact.
      if (glitch.age < 6) {
        glitchGfx.rect(0, 0, sw, sh).fill({ color: 0xe0eeff, alpha: (1 - glitch.age / 6) * 0.14 });
      }

      for (const band of glitch.bands) {
        // In the back half, bands start randomly skipping frames — the signal re-locking in
        // stutters instead of fading smoothly away.
        if (progress > 0.5 && Math.random() < (progress - 0.5) * 2.4) continue;

        const bx = Math.max(0, band.shiftX);
        const bw = sw - Math.abs(band.shiftX);
        const a = band.alpha * fade * (0.48 + Math.sin(elapsed * 4.4 + band.y * 0.09) * 0.46);

        glitchGfx.rect(bx, band.y, bw, band.h).fill({ color: band.color, alpha: Math.max(0, a) });

        // The stronger bands get the chromatic aberration: a red ghost line offset up-left and a
        // cyan one down-right, like colour channels landing in the wrong place.
        if (band.alpha > 0.22) {
          glitchGfx
            .rect(bx - 4, band.y, bw, 1)
            .fill({ color: GLITCH_RED, alpha: 0.22 * fade });
          glitchGfx
            .rect(bx + 4, band.y + band.h, bw, 1)
            .fill({ color: GLITCH_CYN, alpha: 0.22 * fade });
        }
      }
    };

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      const delta = dt * BASE_FPS;
      elapsed += delta;
      noiseClock += dt;

      if (noiseClock >= grainRefresh) {
        noiseClock = 0;
        refreshNoise();
      }

      tickAmbient(delta);
      renderGlitch(delta);
      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        const previousScanline = scanlineAlpha;
        const previousVignette = vignetteStrength;
        scanlineAlpha = num(p, "scanlineAlpha", 0.16, 0, 0.6);
        vignetteStrength = num(p, "vignetteStrength", 1, 0, 2);
        sweepSpeed = num(p, "sweepSpeed", 1, 0, 5);
        grainDensity = num(p, "grainDensity", 1, 0, 3);
        grainRefresh = num(p, "grainRefresh", 0.083, 0.02, 1);
        staticRate = num(p, "staticRate", 1, 0, 4);
        glitchDuration = num(p, "glitchDuration", 0.87, 0.2, 3);
        glitchBands = num(p, "glitchBands", 1, 0.2, 3);
        glitchShift = num(p, "glitchShift", 1, 0, 3);
        coldTint = bool(p, "coldTint", true);
        applyTint();
        // The two cached layers only rebuild when their own knob moved — see buildScanlines.
        if (scanlineAlpha !== previousScanline) buildScanlines();
        if (vignetteStrength !== previousVignette) buildVignette();
      },
    };
  },
});

export default mrRobotCrt;
