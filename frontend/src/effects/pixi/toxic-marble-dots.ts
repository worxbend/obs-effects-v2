import * as PIXI from "pixi.js";

import { colorHex, num } from "../paramUtils";
import { createPixiStage, defineEffect, onFrame } from "../sdk";

/**
 * Toxic Marble Dots
 * =================
 *
 * A halftone print of a slowly churning field: a regular grid of dots whose size and colour follow
 * an invisible pattern underneath. Where the field is strong the dots swell and turn acid green;
 * where it is weak they shrink to dark specks and disappear. The result reads as a screen-printed
 * poster that will not sit still.
 *
 * Ported from `toxic-marble-dots.html` in the old `obs-effects` repository, with the field maths
 * carried over unchanged so it looks like the original.
 *
 * Why this one is on the processor rather than the graphics card
 * --------------------------------------------------------------
 * Its sibling `razer-toxic-marble` is a fragment shader: the GPU evaluates the pattern once per
 * *pixel*. This effect evaluates it once per *dot* — at the default spacing that is a few thousand
 * samples rather than two million — and then asks Pixi to draw circles. Below a certain dot count
 * that is genuinely cheaper, and it gives something a shader cannot: real geometry, so the dots
 * stay perfectly round and crisp at any canvas size instead of being resolved pixel by pixel.
 *
 * The cost is that it scales with dot count rather than with resolution. Halving **Spacing**
 * quadruples the number of circles, so that parameter is the one to watch if the frame budget
 * starts to bite — see the note on its description.
 *
 * The field
 * ---------
 * Three sine waves at unrelated frequencies, sampled through two rounds of *domain warping* — the
 * same trick the shader version uses, where the coordinate being looked up is itself displaced by
 * another wave. One round gives gentle bends; two gives the curling, marbled structure that never
 * repeats visibly. It is cheap: a dozen trigonometric calls per dot and no memory at all.
 */

/** Full circle in radians. Used the same way the original did, as the period of every wave below. */
const TAU = Math.PI * 2;

/**
 * One colour tier: dots whose field value clears `threshold` are drawn in `color`.
 *
 * `ceiling` is the threshold of the tier above (or 1 for the brightest), and `bucket` is that
 * tier's reusable list of circles to draw. Both are kept on the tier itself rather than looked up
 * by index in the hot loop — with `noUncheckedIndexedAccess` on, every such lookup would need a
 * guard, and the guards would outnumber the logic.
 */
interface Tier {
  threshold: number;
  ceiling: number;
  /** A `#rrggbb` string. Pixi accepts these directly in `fill({ color })`. */
  color: string;
  bucket: { x: number; y: number; r: number }[];
}

/**
 * Evaluates the underlying field at a normalised point, returning 0..1.
 *
 * `xn` and `yn` are 0..1 across the canvas rather than pixels, which is what makes the pattern
 * scale with the canvas instead of being cropped by it — the same shape appears at 1280×720 and at
 * 4K, just sampled more finely.
 */
function field(xn: number, yn: number, t: number): number {
  // First warp: displace each axis by a wave running along the other one.
  const w1x = xn + 0.22 * Math.sin(yn * TAU * 1.4 + t * 0.31);
  const w1y = yn + 0.22 * Math.cos(xn * TAU * 1.1 - t * 0.24);

  // Second warp, on the already-warped coordinate. This is what turns smooth bends into curls.
  const w2x = w1x + 0.11 * Math.sin(w1y * TAU * 2.9 + t * 0.18);
  const w2y = w1y + 0.11 * Math.cos(w1x * TAU * 2.4 - t * 0.14);

  // Three waves at frequencies with no common multiple, so the sum never visibly repeats.
  const f =
    Math.sin(w2x * TAU * 2.1 + w2y * TAU * 1.7 + t * 0.22) * 0.45 +
    Math.sin(w2x * TAU * 4.3 - w2y * TAU * 3.1 - t * 0.15) * 0.3 +
    Math.cos(w2x * TAU * 1.2 + w2y * TAU * 3.8 + t * 0.11) * 0.25;

  return (f + 1) * 0.5;
}

const toxicMarbleDots = defineEffect({
  descriptor: {
    id: "toxic-marble-dots",
    name: "Toxic Marble Dots",
    description:
      "A halftone grid of dots whose size and colour follow a slowly churning field underneath, like a screen-printed poster that will not sit still.",
    engine: "pixi",
    category: "background",
    tags: ["razer", "toxic", "halftone", "dots", "background", "green"],
    previewNotes:
      "A full-screen background, opaque by default — turn Background off to lay it over something else. Shares its palette with the razer-* family. Watch Spacing: halving it quadruples the number of circles drawn, which is this effect's entire cost.",
    params: [
      {
        key: "speed",
        label: "Speed",
        kind: "number",
        default: 1,
        min: 0,
        max: 4,
        step: 0.05,
        description: "How fast the field churns. 0 freezes it.",
      },
      {
        key: "spacing",
        label: "Spacing",
        kind: "number",
        default: 12,
        min: 4,
        max: 48,
        step: 1,
        description:
          "Pixels between dot centres — the halftone screen's coarseness. This is the performance control: 12 is about 14,000 dots at 1920×1080, and 6 would be 58,000. Raise it before anything else if frames get expensive.",
      },
      {
        key: "dotSize",
        label: "Dot Size",
        kind: "number",
        default: 0.44,
        min: 0.1,
        max: 0.75,
        step: 0.01,
        description:
          "Largest dot radius as a fraction of the spacing. Above about 0.5 the biggest dots touch their neighbours and the grid closes into solid areas.",
      },
      {
        key: "minDot",
        label: "Minimum Dot",
        kind: "number",
        default: 0.35,
        min: 0,
        max: 1,
        step: 0.01,
        description:
          "How big the smallest visible dot is, as a fraction of the largest. 0 lets dots vanish to nothing at the bottom of a tier; higher values keep the grid evenly visible.",
      },
      {
        key: "thresholdHigh",
        label: "Bright Threshold",
        kind: "number",
        default: 0.72,
        min: 0.3,
        max: 0.95,
        step: 0.01,
        description: "Field strength a dot must reach to be drawn in the brightest colour.",
      },
      {
        key: "thresholdMid",
        label: "Mid Threshold",
        kind: "number",
        default: 0.48,
        min: 0.15,
        max: 0.9,
        step: 0.01,
        description:
          "Field strength for the middle colour. Must be below the bright threshold to have any effect.",
      },
      {
        key: "thresholdLow",
        label: "Dark Threshold",
        kind: "number",
        default: 0.22,
        min: 0,
        max: 0.8,
        step: 0.01,
        description:
          "Field strength below which nothing is drawn at all. Raise it to thin the field out into scattered islands.",
      },
      {
        key: "colorHigh",
        label: "Bright Colour",
        kind: "color",
        default: "#39ff14",
        description: "Toxic green, for the strongest parts of the field.",
      },
      {
        key: "colorMid",
        label: "Mid Colour",
        kind: "color",
        default: "#9cff70",
        description: "Acid glow, for the middle band.",
      },
      {
        key: "colorLow",
        label: "Dark Colour",
        kind: "color",
        default: "#0b6410",
        description: "Deep green, for the faintest dots that are still drawn.",
      },
      {
        key: "background",
        label: "Background",
        kind: "boolean",
        default: true,
        description:
          "Fill the frame behind the dots. Turn this off to lay the halftone over a camera or another effect, leaving the gaps transparent.",
      },
      {
        key: "backgroundColor",
        label: "Background Colour",
        kind: "color",
        default: "#000000",
        description: "Only used when Background is on.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    const stage = await createPixiStage(scope, ctx);

    const graphics = stage.stage.addChild(new PIXI.Graphics());

    let speed = num(ctx.params, "speed", 1, 0, 4);
    let spacing = num(ctx.params, "spacing", 12, 4, 48);
    let dotSize = num(ctx.params, "dotSize", 0.44, 0.1, 0.75);
    let minDot = num(ctx.params, "minDot", 0.35, 0, 1);
    let tiers: Tier[] = [];
    let cutoff = 0.22;
    let drawBackground = true;
    let backgroundColor = "#000000";

    /**
     * Rebuilds the colour tiers from the parameters, brightest first.
     *
     * Sorting rather than trusting the order matters: the thresholds are three independent numbers
     * an operator can drag past each other, and a tier list that is not descending would classify
     * every dot into the first tier it happened to clear. Sorting makes any combination of the
     * three sliders produce something sensible instead of something broken.
     */
    const readTiers = (p: Record<string, unknown>): void => {
      const high = num(p, "thresholdHigh", 0.72, 0.3, 0.95);
      const mid = num(p, "thresholdMid", 0.48, 0.15, 0.9);
      const low = num(p, "thresholdLow", 0.22, 0, 0.8);

      const sorted = [
        { threshold: high, color: colorHex(p, "colorHigh", "#39ff14") },
        { threshold: mid, color: colorHex(p, "colorMid", "#9cff70") },
        { threshold: low, color: colorHex(p, "colorLow", "#0b6410") },
      ].sort((a, b) => b.threshold - a.threshold);

      // Each tier's ceiling is the threshold of the one above it, resolved here so the draw loop
      // never has to look at its neighbours.
      let ceiling = 1;
      tiers = sorted.map((entry) => {
        const tier: Tier = { ...entry, ceiling, bucket: [] };
        ceiling = entry.threshold;
        return tier;
      });
      cutoff = Math.min(high, mid, low);
    };

    readTiers(ctx.params);
    drawBackground = ctx.params["background"] !== false;
    backgroundColor = colorHex(ctx.params, "backgroundColor", "#000000");

    /*
     * Circles are collected per colour on each tier's own `bucket` and filled in one batch at the
     * end, rather than filling each one as it is found. Pixi turns a run of `circle()` calls
     * followed by a single `fill()` into one draw call; alternating circle/fill/circle/fill would
     * produce thousands. The buckets are emptied in place rather than reallocated, for the same
     * reason the audio bus writes into a caller's array — allocating per frame is work the garbage
     * collector has to undo sixty times a second.
     */

    let clock = 0;

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      // The original advanced its clock at a fifth of real time before using it, so the same 0.2
      // is folded in here to keep the churn rate identical.
      clock += dt * speed * 0.2;

      const width = stage.width;
      const height = stage.height;

      graphics.clear();
      if (drawBackground) graphics.rect(0, 0, width, height).fill({ color: backgroundColor });

      for (const tier of tiers) tier.bucket.length = 0;

      const cols = Math.ceil(width / spacing) + 1;
      const rows = Math.ceil(height / spacing) + 1;
      const maxRadius = spacing * dotSize;

      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
          const x = col * spacing;
          const y = row * spacing;
          const value = field(x / width, y / height, clock);
          if (value < cutoff) continue;

          // The brightest tier this dot clears. Three entries, so a scan is cheaper than anything
          // cleverer and much easier to read.
          let hit: Tier | undefined;
          for (const tier of tiers) {
            if (value >= tier.threshold) {
              hit = tier;
              break;
            }
          }
          if (hit === undefined) continue;

          // Size within the tier: a dot just over its threshold is small, one near the next tier up
          // is full size. Without this every dot in a tier would be identical and the field would
          // look like three flat stencils rather than a continuous gradient.
          const within = (value - hit.threshold) / Math.max(0.01, hit.ceiling - hit.threshold);
          const radius = maxRadius * (minDot + (1 - minDot) * within);

          hit.bucket.push({ x, y, r: radius });
        }
      }

      for (const tier of tiers) {
        if (tier.bucket.length === 0) continue;
        for (const dot of tier.bucket) graphics.circle(dot.x, dot.y, dot.r);
        graphics.fill({ color: tier.color });
      }

      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        speed = num(p, "speed", 1, 0, 4);
        spacing = num(p, "spacing", 12, 4, 48);
        dotSize = num(p, "dotSize", 0.44, 0.1, 0.75);
        minDot = num(p, "minDot", 0.35, 0, 1);
        drawBackground = p["background"] !== false;
        backgroundColor = colorHex(p, "backgroundColor", "#000000");
        readTiers(p);
      },
    };
  },
});

export default toxicMarbleDots;
