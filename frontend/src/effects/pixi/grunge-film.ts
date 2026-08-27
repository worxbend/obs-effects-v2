import * as PIXI from "pixi.js";

import { colorInt, num } from "../paramUtils";
import { createPixiStage, defineEffect, onFrame, useChat } from "../sdk";

/**
 * Grunge Film
 * ===========
 *
 * A persistent film-damage layer in a cold industrial palette: a dark vignette hugging the frame
 * edges, a few drifting horizontal static lines, coarse regenerating grain, floating dust motes,
 * short-lived vertical scratches, occasional whole-frame flicker, and a high-contrast colour
 * grade over the lot. On every chat message it slams a burst of horizontal distortion bands and
 * extra scratches across the frame, with a white flash and a brief dark afterburn.
 *
 * Ported from `scenes/grunge/grunge.ts` in the twitch-vizer project. What changed in the port:
 *
 *  - The old scene listened on its own `OverlayEventSocket` and had a spacebar test trigger; both
 *    are replaced by the shared chat SDK (`useChat`) — any chat message fires the distortion, and
 *    the SDK's simulated feed stands in for the keyboard when Twitch is not configured.
 *  - The old scene owned a fullscreen `PIXI.Application` on `document.body`; here the stage comes
 *    from `createPixiStage` and lives in the route's canvas host, resized by the renderer.
 *  - The original ticker measured time in 60-fps frames (`deltaTime` is about 1 per frame at
 *    60 fps). Every constant below is kept verbatim in those units, and the SDK's seconds-based
 *    `dt` is converted once per frame — so the look survives the port unchanged.
 *  - Hard-coded scene constants (grain density, dust count, band counts, the acid accent colour,
 *    the grade strength) became parameters.
 *
 * The effect draws no message content at all — no text, no emotes. Chat is purely its trigger.
 */

// The cold industrial palette the original used. Deliberately no warmth, no sepia — the greys and
// the black stay fixed while the rare accent colour is the one thing an operator retunes.
const BLACK = 0x000000;
const GREY_DARK = 0x111111;
const GREY_MID = 0x4a4a4a;
const GREY_LITE = 0xb8b8b8;
const WHITE = 0xeeeeee;

/**
 * The original's colour grade: boosted diagonal (contrast per channel), negative off-diagonals
 * (channels pull away from each other, killing any colour cast) and negative offsets (punchy
 * blacks). Kept as the "full strength" endpoint; the Grade Strength parameter interpolates
 * between the identity matrix and this one.
 */
// prettier-ignore
const GRADE_FULL: number[] = [
  1.28, -0.14, -0.08, 0, -0.12,
 -0.10,  1.22, -0.10, 0, -0.10,
 -0.10, -0.14,  1.16, 0, -0.08,
  0,     0,     0,    1,  0,
];

// prettier-ignore
const GRADE_IDENTITY: number[] = [
  1, 0, 0, 0, 0,
  0, 1, 0, 0, 0,
  0, 0, 1, 0, 0,
  0, 0, 0, 1, 0,
];

interface DebrisMote {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  alpha: number;
  phase: number;
}

interface Scratch {
  x: number;
  y: number;
  length: number;
  width: number;
  color: number;
  alpha: number;
  life: number;
  maxLife: number;
}

interface DistortBand {
  y: number;
  h: number;
  shiftX: number;
  color: number;
  alpha: number;
  life: number;
  maxLife: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const grungeFilm = defineEffect({
  descriptor: {
    id: "grunge-film",
    name: "Grunge Film",
    description:
      "A persistent film-damage layer — vignette, drifting static lines, coarse grain, dust, scratches and a cold high-contrast grade — that throws distortion bands and a flash across the frame on every chat message.",
    engine: "pixi",
    category: "chat",
    tags: ["chat", "twitch", "film", "grunge", "grain", "distortion", "overlay"],
    previewNotes:
      "Transparent: lay it over a camera or a capture — the grade darkens and sharpens whatever sits underneath. The damage layer runs constantly; the distortion bursts fire on chat messages. When Twitch is not configured, a simulated chat feed fires them every few seconds instead, so the preview always shows the full behaviour.",
    params: [
      {
        key: "vignette",
        label: "Vignette Strength",
        kind: "number",
        default: 0.34,
        min: 0,
        max: 1,
        step: 0.02,
        description:
          "How dark the frame edges get. 0 removes the vignette entirely; 1 is a heavy tunnel.",
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
          "Scales how many grain squares each regeneration scatters. The grain redraws itself every few frames, which is what makes it shimmer like film stock.",
      },
      {
        key: "dustCount",
        label: "Dust Motes",
        kind: "number",
        default: 28,
        min: 0,
        max: 120,
        step: 1,
        description: "How many faint dust motes drift slowly up the frame.",
      },
      {
        key: "scratchGap",
        label: "Scratch Gap",
        kind: "number",
        default: 4,
        min: 0.5,
        max: 20,
        step: 0.5,
        description:
          "Average seconds between ambient vertical scratches. These are the constant background wear; chat events add their own burst on top.",
      },
      {
        key: "eventBands",
        label: "Event Bands",
        kind: "number",
        default: 6,
        min: 1,
        max: 24,
        step: 1,
        description:
          "Roughly how many horizontal distortion bands one chat message throws (each event varies a little either side of this).",
      },
      {
        key: "eventStrength",
        label: "Event Strength",
        kind: "number",
        default: 1,
        min: 0,
        max: 2.5,
        step: 0.05,
        description:
          "Scales the opacity of the event distortion bands, the extra scratches and the white flash. 0 leaves only the ambient damage running.",
      },
      {
        key: "gradeStrength",
        label: "Grade Strength",
        kind: "number",
        default: 1,
        min: 0,
        max: 1.5,
        step: 0.05,
        description:
          "How hard the cold high-contrast colour grade is applied to everything under the layer. 0 switches the grade off; 1 is the original look.",
      },
      {
        key: "colorAccent",
        label: "Accent Colour",
        kind: "color",
        default: "#88ff20",
        description:
          "The rare accent some distortion bands take instead of white — an acid industrial-warning green in the original.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    // The original disabled antialiasing: the grain and scratches are meant to be hard-edged.
    const stage = await createPixiStage(scope, ctx, { antialias: false });

    const chat = await useChat(scope);
    scope.checkpoint();

    let vignetteStrength = num(ctx.params, "vignette", 0.34, 0, 1);
    let grainDensity = num(ctx.params, "grainDensity", 1, 0, 3);
    let dustCount = num(ctx.params, "dustCount", 28, 0, 120);
    let scratchGap = num(ctx.params, "scratchGap", 4, 0.5, 20);
    let eventBands = num(ctx.params, "eventBands", 6, 1, 24);
    let eventStrength = num(ctx.params, "eventStrength", 1, 0, 2.5);
    let gradeStrength = num(ctx.params, "gradeStrength", 1, 0, 1.5);
    let colorAccent = colorInt(ctx.params, "colorAccent", "#88ff20");

    // Layer order matches the original: vignette at the bottom, flicker on top of everything.
    const vignetteGfx = stage.stage.addChild(new PIXI.Graphics());
    const staticGfx = stage.stage.addChild(new PIXI.Graphics());
    const grainGfx = stage.stage.addChild(new PIXI.Graphics());
    const dustGfx = stage.stage.addChild(new PIXI.Graphics());
    const scratchGfx = stage.stage.addChild(new PIXI.Graphics());
    const distortGfx = stage.stage.addChild(new PIXI.Graphics());
    const flickerGfx = stage.stage.addChild(new PIXI.Graphics());

    const grade = new PIXI.ColorMatrixFilter();
    const applyGrade = (): void => {
      // Interpolate every cell between the identity matrix and the full grade. At strength 0 the
      // filter passes pixels through unchanged, which is cheaper to leave in place than to swap
      // the filter array on the stage every time the parameter moves.
      const t = gradeStrength;
      grade.matrix = GRADE_IDENTITY.map(
        (cell, i) => cell + ((GRADE_FULL[i] ?? cell) - cell) * t,
      ) as PIXI.ColorMatrix;
    };
    applyGrade();
    stage.stage.filters = [grade];

    const buildVignette = (): void => {
      const w = stage.width;
      const h = stage.height;
      const dim = Math.min(w, h);
      vignetteGfx.clear();
      if (vignetteStrength <= 0) return;
      // 24 nested frame-shaped rectangles whose alpha falls off quadratically towards the centre.
      // Cheaper than a radial gradient texture, and the slightly square falloff suits film gates.
      for (let i = 0; i < 24; i += 1) {
        const t = i / 24;
        const alpha = Math.pow(1 - t, 2) * vignetteStrength;
        const inset = t * 0.34 * dim;
        vignetteGfx.rect(0, 0, w, inset).fill({ color: BLACK, alpha });
        vignetteGfx.rect(0, h - inset, w, inset).fill({ color: BLACK, alpha });
        vignetteGfx.rect(0, 0, inset, h).fill({ color: BLACK, alpha });
        vignetteGfx.rect(w - inset, 0, inset, h).fill({ color: BLACK, alpha });
      }
    };
    buildVignette();
    // The vignette is the one layer that is not redrawn every frame, so a size change must
    // rebuild it explicitly. Everything else redraws from the current stage size anyway.
    stage.onResize(() => buildVignette());

    const debris: DebrisMote[] = [];
    const spawnMote = (): DebrisMote => ({
      x: Math.random() * stage.width,
      y: Math.random() * stage.height,
      vx: (Math.random() - 0.5) * 0.18,
      vy: -(0.25 + Math.random() * 0.55),
      r: 0.6 + Math.random() * 1.4,
      alpha: 0.06 + Math.random() * 0.18,
      phase: Math.random() * Math.PI * 2,
    });

    const scratches: Scratch[] = [];
    const distortions: DistortBand[] = [];

    /*
     * Time bookkeeping stays in the original's 60-fps frame units (see the header). `elapsed` and
     * `grainClock` accumulate converted frames; the scratch timer counts down in frames too.
     */
    let elapsed = 0;
    let grainClock = 0;
    let scratchTimer = 160;
    let flashActive = false;
    let flashAge = 0;

    /** The chat-event distortion burst — a faithful copy of the original's `trigger()`. */
    const trigger = (): void => {
      if (eventStrength <= 0) return;
      const w = stage.width;
      const h = stage.height;

      // Aggressive horizontal distortion bands. The original used 4..8; the parameter shifts the
      // whole range while keeping the same +0..4 spread of randomness.
      const count = Math.max(1, Math.round(eventBands - 2)) + Math.floor(Math.random() * 5);
      for (let i = 0; i < count; i += 1) {
        distortions.push({
          y: Math.random() * h,
          h: 4 + Math.floor(Math.random() * 6) * 4,
          shiftX: (Math.random() - 0.5) * 130,
          // Mostly white; roughly one band in seven takes the acid accent, which is what makes
          // the burst read as an industrial fault rather than plain interference.
          color: Math.random() > 0.15 ? WHITE : colorAccent,
          alpha: (0.22 + Math.random() * 0.44) * eventStrength,
          life: 0,
          maxLife: 12 + Math.random() * 20,
        });
      }

      // Extra burst of vertical scratches, harder and brighter than the ambient ones.
      for (let i = 0; i < 3; i += 1) {
        scratches.push({
          x: Math.random() * w,
          y: 0,
          length: h * (0.5 + Math.random() * 0.5),
          width: 1,
          color: WHITE,
          alpha: (0.3 + Math.random() * 0.4) * eventStrength,
          life: 0,
          maxLife: 8 + Math.random() * 10,
        });
      }

      flashActive = true;
      flashAge = 0;
    };

    /*
     * Chat wiring. The backlog from `recent()` is deliberately collapsed to at most ONE trigger:
     * this effect renders no message content, so replaying fifty history messages would fire
     * fifty stacked distortion bursts at load. One burst proves the event path is alive without
     * whiting out the frame.
     */
    if (chat.recent().length > 0) trigger();
    const off = chat.onMessage(() => trigger());
    scope.defer(off);

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      // The one seconds→frames conversion. Everything below is verbatim original arithmetic.
      const delta = dt * 60;
      elapsed += delta;
      grainClock += delta;

      const w = stage.width;
      const h = stage.height;

      // Drifting horizontal static lines: four thin bars whose position, length and shimmer all
      // derive from `elapsed`, so they wander rather than loop.
      staticGfx.clear();
      for (let i = 0; i < 4; i += 1) {
        const y = (elapsed * (0.18 + i * 0.07) + i * h * 0.27) % h;
        const lw = w * (0.35 + Math.sin(elapsed * 0.012 + i) * 0.22);
        const lx = Math.sin(elapsed * 0.009 + i * 1.3) * (w - lw) * 0.5 + (w - lw) * 0.5;
        staticGfx
          .rect(lx, y, lw, 1)
          .fill({ color: GREY_LITE, alpha: 0.04 + Math.sin(elapsed * 0.03 + i) * 0.02 });
      }

      // Grain regenerates every ~3 frames rather than every frame: the brief persistence is what
      // reads as film grain instead of television static.
      if (grainClock >= 3) {
        grainClock = 0;
        grainGfx.clear();
        const count = Math.round(((w * h) / 720) * grainDensity);
        for (let i = 0; i < count; i += 1) {
          const r = Math.random();
          const size = r < 0.55 ? 2 : r < 0.82 ? 3 : 4;
          const color = Math.random() < 0.55 ? GREY_DARK : GREY_MID;
          grainGfx
            .rect(Math.random() * w, Math.random() * h, size, size)
            .fill({ color, alpha: 0.1 + Math.random() * 0.22 });
        }
      }

      // Dust motes drift upward with a sinusoidal sway, wrapping at the edges. The pool grows or
      // shrinks lazily towards the parameter so retuning it mid-run needs no reset.
      const wantMotes = Math.round(dustCount);
      while (debris.length < wantMotes) debris.push(spawnMote());
      if (debris.length > wantMotes) debris.length = wantMotes;
      dustGfx.clear();
      for (const d of debris) {
        d.x += d.vx * delta + Math.sin(elapsed * 0.018 + d.phase) * 0.12;
        d.y += d.vy * delta;
        if (d.y < -4) {
          d.y = h + 4;
          d.x = Math.random() * w;
        }
        if (d.x < -4) d.x = w + 4;
        if (d.x > w + 4) d.x = -4;
        const a = d.alpha * (0.65 + Math.sin(elapsed * 0.025 + d.phase) * 0.35);
        dustGfx.circle(d.x, d.y, d.r).fill({ color: GREY_LITE, alpha: clamp(a, 0, 1) });
      }

      // Ambient scratches on a randomised timer. The original waited 140..340 frames (about
      // 2.3..5.7 seconds); the Scratch Gap parameter recentres that window around its value.
      scratchTimer -= delta;
      if (scratchTimer <= 0) {
        scratches.push({
          x: Math.random() * w,
          y: Math.random() * h * 0.4,
          length: h * (0.18 + Math.random() * 0.55),
          width: Math.random() > 0.75 ? 2 : 1,
          color: Math.random() > 0.1 ? GREY_LITE : WHITE,
          alpha: 0.12 + Math.random() * 0.22,
          life: 0,
          maxLife: 7 + Math.random() * 14,
        });
        const gapFrames = scratchGap * 60;
        scratchTimer = gapFrames * 0.6 + Math.random() * gapFrames * 0.8;
      }

      scratchGfx.clear();
      for (let i = scratches.length - 1; i >= 0; i -= 1) {
        const s = scratches[i];
        if (s === undefined) continue;
        s.life += delta;
        if (s.life >= s.maxLife) {
          scratches.splice(i, 1);
          continue;
        }
        const fade = 1 - s.life / s.maxLife;
        scratchGfx
          .rect(s.x, s.y, s.width, s.length)
          .fill({ color: s.color, alpha: clamp(s.alpha * fade, 0, 1) });
      }

      // Event distortion bands: full-width bars shoved sideways, clipped so the shift shortens
      // the bar from one edge instead of running off both.
      distortGfx.clear();
      for (let i = distortions.length - 1; i >= 0; i -= 1) {
        const d = distortions[i];
        if (d === undefined) continue;
        d.life += delta;
        if (d.life >= d.maxLife) {
          distortions.splice(i, 1);
          continue;
        }
        const fade = 1 - d.life / d.maxLife;
        const bx = Math.max(0, d.shiftX);
        const bw = w - Math.abs(d.shiftX);
        distortGfx.rect(bx, d.y, bw, d.h).fill({ color: d.color, alpha: clamp(d.alpha * fade, 0, 1) });
      }

      // Flicker: a roughly one-in-ten chance per frame of a brief whole-frame darken, plus the
      // event flash (white on impact, then a longer dark afterburn).
      flickerGfx.clear();
      if (Math.random() < 0.1) {
        flickerGfx.rect(0, 0, w, h).fill({ color: BLACK, alpha: 0.04 + Math.random() * 0.07 });
      }
      if (flashActive) {
        flashAge += delta;
        if (flashAge <= 4) {
          const a = (1 - flashAge / 4) * 0.28 * eventStrength;
          flickerGfx.rect(0, 0, w, h).fill({ color: WHITE, alpha: clamp(a, 0, 1) });
        } else if (flashAge <= 16) {
          const a = clamp((1 - (flashAge - 4) / 12) * 0.1 * eventStrength, 0, 1);
          flickerGfx.rect(0, 0, w, h).fill({ color: BLACK, alpha: a });
        } else {
          flashActive = false;
        }
      }

      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        const previousVignette = vignetteStrength;
        vignetteStrength = num(p, "vignette", 0.34, 0, 1);
        grainDensity = num(p, "grainDensity", 1, 0, 3);
        dustCount = num(p, "dustCount", 28, 0, 120);
        scratchGap = num(p, "scratchGap", 4, 0.5, 20);
        eventBands = num(p, "eventBands", 6, 1, 24);
        eventStrength = num(p, "eventStrength", 1, 0, 2.5);
        gradeStrength = num(p, "gradeStrength", 1, 0, 1.5);
        colorAccent = colorInt(p, "colorAccent", "#88ff20");
        applyGrade();
        if (vignetteStrength !== previousVignette) buildVignette();
      },
    };
  },
});

export default grungeFilm;
