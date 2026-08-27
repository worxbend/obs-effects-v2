import * as PIXI from "pixi.js";

import { bool, colorHex, int, num } from "../paramUtils";
import { createEnvelopes, createPixiStage, defineEffect, onFrame, useAudio } from "../sdk";

/**
 * Razer Corner Accents
 * ====================
 *
 * Four bracket marks framing the corners of the frame, a scan line that sweeps down every few
 * seconds, and a scatter of drifting motes near each corner. The brackets swell on the beat.
 *
 * Ported from `razer-corner-accents.html` in the old `obs-effects` repository.
 *
 * What it is for
 * --------------
 * This is the one effect in the razer family designed to be laid over *everything else*. It draws
 * nothing in the middle of the frame, so it can sit on top of a camera, a game capture or another
 * effect and do the job a frame does: tell the eye where the edges of the picture are, and give the
 * scene a piece of motion that is not competing with its content.
 *
 * Three layers, drawn in order
 * ----------------------------
 * The sweep goes behind, the motes in the middle and the brackets in front, each with its own
 * `Graphics` object. They could all share one — but they redraw at different rates and the brackets
 * must never be dimmed by a mote passing over them, and keeping them separate makes both of those
 * true by construction rather than by ordering statements carefully.
 */

/** The four corners, as a fraction of the frame plus the direction the arms point. */
const CORNERS: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 1, 1],
  [1, 0, -1, 1],
  [0, 1, 1, -1],
  [1, 1, -1, -1],
];

const razerCornerAccents = defineEffect({
  descriptor: {
    id: "razer-corner-accents",
    name: "Razer Corner Accents",
    description:
      "Bracket marks framing the four corners with a periodic scan sweep and drifting motes, swelling on the beat.",
    engine: "pixi",
    category: "overlay",
    tags: ["razer", "overlay", "corners", "brackets", "hud", "reactive"],
    previewNotes:
      "Draws nothing in the middle of the frame, so it is meant to sit on top of everything else. Reacts to OBS audio — configure the connection under Settings, or set Reactivity to 0 for a still frame with just the sweep.",
    params: [
      {
        key: "armLength",
        label: "Arm Length",
        kind: "number",
        default: 0.05,
        min: 0.01,
        max: 0.25,
        step: 0.005,
        description: "Length of each bracket arm, as a fraction of the frame's shorter side.",
      },
      {
        key: "margin",
        label: "Margin",
        kind: "number",
        default: 0.018,
        min: 0,
        max: 0.1,
        step: 0.002,
        description:
          "How far the brackets sit in from the edges, as a fraction of the shorter side.",
      },
      {
        key: "thickness",
        label: "Thickness",
        kind: "number",
        default: 3,
        min: 1,
        max: 12,
        step: 0.5,
        description: "Bracket line width in pixels, before any audio swell.",
      },
      {
        key: "reactivity",
        label: "Reactivity",
        kind: "number",
        default: 1,
        min: 0,
        max: 3,
        step: 0.05,
        description:
          "How much the brackets swell and brighten with the audio. 0 holds them steady.",
      },
      {
        key: "sweep",
        label: "Scan Sweep",
        kind: "boolean",
        default: true,
        description: "The line that travels down the frame every few seconds.",
      },
      {
        key: "sweepPeriod",
        label: "Sweep Interval",
        kind: "number",
        default: 6.5,
        min: 1,
        max: 30,
        step: 0.5,
        description: "Seconds between sweeps. The sweep itself always takes 1.6 seconds to cross.",
      },
      {
        key: "moteCount",
        label: "Mote Count",
        kind: "number",
        default: 22,
        min: 0,
        max: 120,
        step: 1,
        description: "Drifting specks spread across the four corner regions. 0 removes them.",
      },
      {
        key: "colorPrimary",
        label: "Bracket Colour",
        kind: "color",
        default: "#b0ff00",
        description: "The bracket lines and the motes.",
      },
      {
        key: "colorGlow",
        label: "Glow Colour",
        kind: "color",
        default: "#36ff00",
        description: "The wider, softer line drawn behind each bracket.",
      },
      {
        key: "colorSweep",
        label: "Sweep Colour",
        kind: "color",
        default: "#00c243",
        description: "The broad band of the scan sweep.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    const bus = await useAudio(scope);
    scope.checkpoint();
    const envelopes = createEnvelopes(bus);

    const stage = await createPixiStage(scope, ctx);

    // Three layers so the draw order is structural rather than something to remember.
    const sweepLayer = stage.stage.addChild(new PIXI.Graphics());
    const moteLayer = stage.stage.addChild(new PIXI.Graphics());
    const bracketLayer = stage.stage.addChild(new PIXI.Graphics());

    let armFraction = num(ctx.params, "armLength", 0.05, 0.01, 0.25);
    let marginFraction = num(ctx.params, "margin", 0.018, 0, 0.1);
    let thickness = num(ctx.params, "thickness", 3, 1, 12);
    let reactivity = num(ctx.params, "reactivity", 1, 0, 3);
    let showSweep = bool(ctx.params, "sweep", true);
    let sweepPeriod = num(ctx.params, "sweepPeriod", 6.5, 1, 30);
    let moteCount = int(ctx.params, "moteCount", 22, 0, 120);
    let colorPrimary = colorHex(ctx.params, "colorPrimary", "#b0ff00");
    let colorGlow = colorHex(ctx.params, "colorGlow", "#36ff00");
    let colorSweep = colorHex(ctx.params, "colorSweep", "#00c243");

    /*
     * A fixed seed per mote, generated from its index rather than from `Math.random()`.
     *
     * The difference matters here: a route change remounts the effect, and with real randomness the
     * motes would jump to a completely different arrangement each time. Derived from the index, the
     * scatter is identical on every mount, so a remount is invisible.
     *
     * Generated up to the maximum rather than the current count, so changing Mote Count does not
     * reshuffle the ones that were already there.
     */
    const MAX_MOTES = 120;
    const moteSeeds = new Float32Array(MAX_MOTES);
    for (let i = 0; i < MAX_MOTES; i += 1) {
      const s = Math.sin(i * 61.51) * 43758.5453;
      moteSeeds[i] = s - Math.floor(s);
    }

    let time = 0;
    let pulse = 0;

    onFrame(scope, ctx.fpsCap, ({ dt, now }) => {
      bus.sample(now);
      envelopes.update(dt);
      time += dt;

      // A beat drives the pulse to full; otherwise it follows the level. Easing towards whichever
      // is larger is what makes a hit snap and a sustained passage glow.
      const target = (envelopes.beat ? 1 : bus.level) * reactivity;
      pulse += (target - pulse) * Math.min(1, dt * 6);

      const w = stage.width;
      const h = stage.height;
      const shortSide = Math.min(w, h);
      const margin = shortSide * marginFraction + 8;
      const armLength = shortSide * armFraction * (1 + pulse * 0.18);
      const width = thickness + pulse * 1.6;
      const alpha = 0.75 + pulse * 0.25;

      bracketLayer.clear();
      for (const [sx, sy, dx, dy] of CORNERS) {
        const x = sx * w + dx * margin;
        const y = sy * h + dy * margin;

        // The bright, thin bracket.
        bracketLayer
          .moveTo(x, y + dy * armLength)
          .lineTo(x, y)
          .lineTo(x + dx * armLength, y)
          .stroke({ color: colorPrimary, width, alpha });

        // A shorter, much wider, half-transparent copy behind it. Two strokes is all the "glow"
        // is — no blur filter, which would cost a render target per frame.
        bracketLayer
          .moveTo(x, y + dy * armLength * 0.42)
          .lineTo(x, y)
          .lineTo(x + dx * armLength * 0.42, y)
          .stroke({ color: colorGlow, width: width * 1.8, alpha: alpha * 0.5 });
      }

      sweepLayer.clear();
      if (showSweep) {
        const local = time % sweepPeriod;
        // The sweep occupies the first 1.6 seconds of each period and the rest is the gap, so the
        // interval control changes how often it happens without changing how fast it travels.
        if (local <= 1.6) {
          const y = (local / 1.6) * h;
          const fade = 1 - local / 1.6;
          sweepLayer.rect(0, y - 1.5, w, 3).fill({ color: colorSweep, alpha: 0.22 * fade });
          sweepLayer.rect(0, y - 0.5, w, 1).fill({ color: colorPrimary, alpha: 0.55 * fade });
        }
      }

      moteLayer.clear();
      const bandW = w * 0.14;
      const bandH = h * 0.14;
      for (let i = 0; i < moteCount; i += 1) {
        const seed = moteSeeds[i] ?? 0;
        const corner = CORNERS[i % 4];
        if (corner === undefined) continue;
        const [sx, sy] = corner;

        // Position wraps within the corner band via the modulo, so a mote drifting off the end of
        // its band reappears at the start rather than needing to be respawned.
        const localX = ((seed * 7.3 + time * (0.05 + seed * 0.1)) % 1) * bandW;
        const localY = ((seed * 4.1 + time * (0.04 + seed * 0.08)) % 1) * bandH;
        const x = sx * w + (sx === 0 ? 1 : -1) * localX;
        const y = sy * h + (sy === 0 ? 1 : -1) * localY;
        const twinkle = 0.4 + 0.6 * Math.sin(time * (2 + seed * 3) + seed * 20);

        moteLayer.circle(x, y, 1.2 + seed * 1.8).fill({
          color: colorPrimary,
          alpha: Math.max(0, twinkle) * (0.4 + pulse * 0.4),
        });
      }

      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        armFraction = num(p, "armLength", 0.05, 0.01, 0.25);
        marginFraction = num(p, "margin", 0.018, 0, 0.1);
        thickness = num(p, "thickness", 3, 1, 12);
        reactivity = num(p, "reactivity", 1, 0, 3);
        showSweep = bool(p, "sweep", true);
        sweepPeriod = num(p, "sweepPeriod", 6.5, 1, 30);
        moteCount = int(p, "moteCount", 22, 0, 120);
        colorPrimary = colorHex(p, "colorPrimary", "#b0ff00");
        colorGlow = colorHex(p, "colorGlow", "#36ff00");
        colorSweep = colorHex(p, "colorSweep", "#00c243");
      },
    };
  },
});

export default razerCornerAccents;
