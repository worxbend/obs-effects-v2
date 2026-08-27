import * as PIXI from "pixi.js";

import { colorInt, int, num } from "../paramUtils";
import { createPixiStage, defineEffect, onFrame } from "../sdk";

/**
 * Screen Capture Border
 * =====================
 *
 * A quiet, smoky frame for a screen or window capture. Seven thin bands hug each edge of the
 * canvas, each drifting in and out on its own slow sine waves, coloured in the dark greys and blues
 * of the Catppuccin Mocha palette. A faint pulsing haze sits behind them, tiny additive sparks
 * crawl along the edges, and each corner carries a small pulsing pool of concentric rings.
 *
 * Ported from `ScreenCaptureBorderScreen.ts` in the old `obs-effects` repository. The drawing is
 * carried over line for line — the same band depth/width/alpha ramps, the same two-sine drift with
 * its end taper, the same haze, corner pools and spark maths — with two structural changes:
 *
 * - The old class drew from Pixi's own ticker and a `resize()` method; here the SDK's shared
 *   `onFrame` clock drives it and the stage helper handles resizing. Everything is redrawn from
 *   `stage.width`/`stage.height` each frame, so a resize needs no extra work at all.
 * - Every number the original hard-coded — the seven band colours, the band and spark counts, the
 *   border depth — is now a parameter, defaulting to the original value.
 *
 * ## Why it reads as smoke rather than lines
 *
 * Each band's depth along an edge is the sum of two sine waves at unrelated frequencies, scaled by
 * `sin(t * PI)` so the drift dies away to nothing at the corners — the bands are pinned where they
 * meet, which is what keeps the frame reading as a closed rectangle. Deeper bands drift more, are
 * wider-glowed and fainter, so the stack fades inward like haze off a hot edge. Every band is
 * stroked three times (wide faint glow, medium halo, sharp core), which fakes a blur without a
 * filter pass.
 */

/** How many line segments approximate one edge of one band. Fixed, as in the original. */
const EDGE_STEPS = 150;

/** The original Catppuccin Mocha ramp, darkest to lightest — the parameter defaults. */
const DEFAULT_COLORS = [
  "#11111b", // crust
  "#181825", // mantle
  "#1e1e2e", // base
  "#313244", // surface0
  "#45475a", // surface1
  "#585b70", // surface2
  "#6c7086", // overlay0
] as const;

/** An edge of the canvas: 0 = top, 1 = right, 2 = bottom, 3 = left. */
type Side = 0 | 1 | 2 | 3;

interface BorderBand {
  depth: number;
  width: number;
  glowWidth: number;
  alpha: number;
  /** Index into the colour list, so a colour parameter change recolours live. */
  colorIndex: number;
  amplitude: number;
  frequency: number;
  speed: number;
  phase: number;
  sidePhase: number;
}

interface EdgeSpark {
  side: Side;
  t: number;
  speed: number;
  /** Stored as a 0..1 fraction of the border depth, so changing the depth keeps sparks inside it. */
  depthFrac: number;
  radius: number;
  alpha: number;
  phase: number;
  colorIndex: number;
}

const screenCaptureBorder = defineEffect({
  descriptor: {
    id: "screen-capture-border",
    name: "Screen Capture Border",
    description:
      "A quiet smoky frame of drifting Catppuccin-toned bands hugging the canvas edges, with a pulsing haze, crawling edge sparks and softly glowing corner pools.",
    engine: "pixi",
    category: "overlay",
    tags: ["border", "overlay", "screen-share", "catppuccin", "subtle", "ambient"],
    previewNotes:
      "Transparent everywhere except a thin strip at each edge, so the preview looks nearly empty — that is the point. Lay it over a display or window capture to give the shared area a soft edge. The default colours are dark; they show best over bright content.",
    params: [
      {
        key: "bandCount",
        label: "Band Count",
        kind: "number",
        default: 7,
        min: 1,
        max: 14,
        step: 1,
        description:
          "How many drifting bands stack along each edge. Each extra band sits deeper into the frame and is fainter than the one before it.",
      },
      {
        key: "borderDepth",
        label: "Border Depth",
        kind: "number",
        default: 24,
        min: 4,
        max: 120,
        step: 1,
        description:
          "How far, in pixels, the deepest band sits from the canvas edge. This is the overall thickness of the frame.",
      },
      {
        key: "sparkCount",
        label: "Spark Count",
        kind: "number",
        default: 120,
        min: 0,
        max: 400,
        step: 5,
        description:
          "How many tiny glowing dots crawl along the edges. 0 turns them off entirely.",
      },
      {
        key: "speed",
        label: "Speed",
        kind: "number",
        default: 1,
        min: 0,
        max: 5,
        step: 0.05,
        description:
          "Speeds up or slows down every motion at once — the band drift, the haze pulse, the spark crawl. 1 is the original pace; 0 freezes the frame in place.",
      },
      {
        key: "intensity",
        label: "Intensity",
        kind: "number",
        default: 1,
        min: 0.1,
        max: 3,
        step: 0.05,
        description:
          "Scales the opacity of everything drawn. The original look is deliberately faint; raise this to make the frame more obvious.",
      },
      {
        key: "color1",
        label: "Colour 1 (deepest)",
        kind: "color",
        default: DEFAULT_COLORS[0],
        description:
          "First of the seven colours the bands, sparks and corner pools cycle through. The defaults are the Catppuccin Mocha greys, darkest first.",
      },
      {
        key: "color2",
        label: "Colour 2",
        kind: "color",
        default: DEFAULT_COLORS[1],
        description: "Second colour in the cycle.",
      },
      {
        key: "color3",
        label: "Colour 3",
        kind: "color",
        default: DEFAULT_COLORS[2],
        description: "Third colour in the cycle.",
      },
      {
        key: "color4",
        label: "Colour 4",
        kind: "color",
        default: DEFAULT_COLORS[3],
        description: "Fourth colour in the cycle. Also tints half the haze lines.",
      },
      {
        key: "color5",
        label: "Colour 5",
        kind: "color",
        default: DEFAULT_COLORS[4],
        description: "Fifth colour in the cycle.",
      },
      {
        key: "color6",
        label: "Colour 6",
        kind: "color",
        default: DEFAULT_COLORS[5],
        description: "Sixth colour in the cycle.",
      },
      {
        key: "color7",
        label: "Colour 7 (lightest)",
        kind: "color",
        default: DEFAULT_COLORS[6],
        description:
          "Seventh and lightest colour in the cycle — the most visible band against dark content.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    const stage = await createPixiStage(scope, ctx);

    // Three layers, as in the original: additive haze underneath, crisp band lines in the middle,
    // additive sparks on top. Additive blending is what lets the dark palette glow instead of
    // muddying whatever the frame is laid over.
    const hazeGfx = stage.stage.addChild(new PIXI.Graphics());
    const lineGfx = stage.stage.addChild(new PIXI.Graphics());
    const sparkGfx = stage.stage.addChild(new PIXI.Graphics());
    hazeGfx.blendMode = "add";
    sparkGfx.blendMode = "add";

    const readColors = (p: Record<string, unknown>): number[] =>
      DEFAULT_COLORS.map((fallback, i) => colorInt(p, `color${i + 1}`, fallback));

    let bandCount = int(ctx.params, "bandCount", 7, 1, 14);
    let borderDepth = num(ctx.params, "borderDepth", 24, 4, 120);
    let sparkCount = int(ctx.params, "sparkCount", 120, 0, 400);
    let speed = num(ctx.params, "speed", 1, 0, 5);
    let intensity = num(ctx.params, "intensity", 1, 0.1, 3);
    let colors = readColors(ctx.params);

    let time = 0;
    const bands: BorderBand[] = [];
    const sparks: EdgeSpark[] = [];

    /**
     * The per-band ramps from the original: band `i` of `n` sits at fraction `t` of the border
     * depth, and everything else — width, alpha, drift amplitude — is a linear function of `t`, so
     * deeper bands are wider-glowed, fainter and wobblier.
     */
    const buildBands = (): void => {
      bands.length = 0;
      for (let i = 0; i < bandCount; i += 1) {
        const t = i / Math.max(1, bandCount - 1);
        bands.push({
          depth: t * borderDepth,
          width: 0.9 - t * 0.45,
          glowWidth: 1.8 - t * 0.6,
          alpha: 0.86 - t * 0.38,
          colorIndex: i % colors.length,
          amplitude: 0.2 + t * 4.5,
          frequency: 1.5 + (i % 3) * 0.9 + t * 1.2,
          // Alternate bands drift in opposite directions so the stack shimmers instead of sliding.
          speed: (i % 2 === 0 ? 1 : -1) * (0.12 + t * 0.08),
          phase: Math.random() * Math.PI * 2,
          sidePhase: Math.random() * Math.PI * 2,
        });
      }
    };

    const buildSparks = (): void => {
      sparks.length = 0;
      for (let i = 0; i < sparkCount; i += 1) {
        sparks.push({
          side: Math.floor(Math.random() * 4) as Side,
          t: Math.random(),
          speed: 0.015 + Math.random() * 0.045,
          // The 1.8 power biases sparks toward the very edge, matching the bands' fade-in.
          depthFrac: Math.random() ** 1.8,
          radius: 0.08 + Math.random() * 0.18,
          alpha: 0.14 + Math.random() * 0.34,
          phase: Math.random() * Math.PI * 2,
          colorIndex: Math.floor(Math.random() * colors.length),
        });
      }
    };

    buildBands();
    buildSparks();

    /** A point `depth` pixels inside edge `side`, at fraction `t` along it, going clockwise. */
    const edgePoint = (side: Side, t: number, depth: number): [number, number] => {
      const w = stage.width;
      const h = stage.height;
      switch (side) {
        case 0:
          return [w * t, depth];
        case 1:
          return [w - depth, h * t];
        case 2:
          return [w * (1 - t), h - depth];
        case 3:
          return [depth, h * (1 - t)];
      }
    };

    /** Four one-pixel lines inset from each edge, pulsing together — the background haze. */
    const drawEdgeHaze = (): void => {
      const w = stage.width;
      const h = stage.height;
      const pulse = 0.72 + 0.28 * Math.sin(time * 0.55);

      for (let i = 0; i < 4; i += 1) {
        const depth = i * 7;
        const alpha = (0.045 - i * 0.007) * pulse * intensity;
        // Alternating the darkest colour with the mid grey gives the haze a faint banding.
        const color = i % 2 === 0 ? colors[0] : colors[3];

        hazeGfx.rect(0, depth, w, 1).fill({ color, alpha });
        hazeGfx.rect(0, h - depth - 1, w, 1).fill({ color, alpha });
        hazeGfx.rect(depth, 0, 1, h).fill({ color, alpha });
        hazeGfx.rect(w - depth - 1, 0, 1, h).fill({ color, alpha });
      }
    };

    /** One band along one edge, as a polyline whose depth wobbles with two summed sines. */
    const buildEdgeBand = (side: Side, band: BorderBand): number[] => {
      const points: number[] = [];
      // Each side gets its own phase offset so the four edges never wobble in unison.
      const sideWavePhase = band.sidePhase + side * 1.37;
      // A band may never drift more than 42% of its own depth, which keeps it from crossing the
      // canvas edge or its neighbours.
      const maxWave = Math.min(band.amplitude, band.depth * 0.42);

      for (let i = 0; i <= EDGE_STEPS; i += 1) {
        const t = i / EDGE_STEPS;
        // Zero at both ends: the bands are pinned at the corners, so the frame stays closed.
        const endTaper = Math.sin(t * Math.PI);
        const longWave = Math.sin(
          t * Math.PI * 2 * band.frequency + time * band.speed + band.phase + sideWavePhase,
        );
        const softRelief = Math.sin(
          t * Math.PI * 2 * (band.frequency * 0.45 + 0.8) -
            time * band.speed * 0.7 +
            band.phase * 1.9,
        );
        const drift = (longWave * 0.72 + softRelief * 0.28) * maxWave * endTaper;
        const depth = Math.max(0, band.depth + drift);

        points.push(...edgePoint(side, t, depth));
      }

      return points;
    };

    /** Every band on every side, each stroked three times: glow, halo, core. */
    const drawBands = (): void => {
      for (const band of bands) {
        const color = colors[band.colorIndex % colors.length];
        for (const side of [0, 1, 2, 3] as const) {
          const points = buildEdgeBand(side, band);

          hazeGfx.poly(points).stroke({
            color,
            alpha: band.alpha * 0.2 * intensity,
            width: band.glowWidth,
            cap: "round",
            join: "round",
          });

          lineGfx.poly(points).stroke({
            color,
            alpha: band.alpha * 0.46 * intensity,
            width: band.width + 0.3,
            cap: "round",
            join: "round",
          });

          lineGfx.poly(points).stroke({
            color,
            alpha: band.alpha * intensity,
            width: band.width,
            cap: "round",
            join: "round",
          });
        }
      }
    };

    /** Four tiny concentric-ring pools, one per corner, pulsing slightly out of phase with the haze. */
    const drawCornerPools = (): void => {
      const w = stage.width;
      const h = stage.height;
      const radius = 0.8;
      const pulse = 0.68 + 0.32 * Math.sin(time * 0.8);
      const corners: readonly (readonly [number, number])[] = [
        [0, 0],
        [w, 0],
        [w, h],
        [0, h],
      ];

      for (const [i, [x, y]] of corners.entries()) {
        const color = colors[(i + 1) % colors.length];

        for (let r = 0; r < 4; r += 1) {
          hazeGfx.circle(x, y, radius + r * 0.5).stroke({
            color,
            alpha: (0.08 - r * 0.014) * pulse * intensity,
            width: 0.7 - r * 0.1,
          });
        }
      }
    };

    /** Each spark: a wide faint disc under a small pulsing core, both additive. */
    const drawSparks = (): void => {
      for (const spark of sparks) {
        const pulse = 0.62 + 0.38 * Math.sin(time * 1.6 + spark.phase);
        // Sparks also breathe in and out of the frame a little, on a slower rhythm than they pulse.
        const depthDrift = Math.sin(time * 0.7 + spark.phase) * 2.5;
        const depth = Math.max(
          0,
          Math.min(borderDepth, spark.depthFrac * borderDepth + depthDrift),
        );
        const [x, y] = edgePoint(spark.side, spark.t, depth);
        const radius = spark.radius * pulse;
        const color = colors[spark.colorIndex % colors.length];

        sparkGfx.circle(x, y, radius * 4).fill({
          color,
          alpha: spark.alpha * 0.08 * intensity,
        });
        sparkGfx.circle(x, y, radius).fill({
          color,
          alpha: spark.alpha * pulse * intensity,
        });
      }
    };

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      // The original clamped its step to 50 ms; the SDK clock clamps to 100 ms, so tighten it here
      // to keep a stall from teleporting the sparks.
      const step = Math.min(dt, 0.05) * speed;
      time += step;

      for (const spark of sparks) {
        // Wrap at 1 so a spark that walks off the end of an edge reappears at its start.
        spark.t = (spark.t + spark.speed * step) % 1;
      }

      hazeGfx.clear();
      lineGfx.clear();
      sparkGfx.clear();

      drawEdgeHaze();
      drawBands();
      drawCornerPools();
      drawSparks();

      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        const nextBandCount = int(p, "bandCount", 7, 1, 14);
        const nextBorderDepth = num(p, "borderDepth", 24, 4, 120);
        const nextSparkCount = int(p, "sparkCount", 120, 0, 400);
        speed = num(p, "speed", 1, 0, 5);
        intensity = num(p, "intensity", 1, 0.1, 3);
        colors = readColors(p);

        // Bands are cheap to derive, so a count or depth change rebuilds them in place; the random
        // phases re-roll, but with everything drifting anyway that is invisible.
        if (nextBandCount !== bandCount || nextBorderDepth !== borderDepth) {
          bandCount = nextBandCount;
          borderDepth = nextBorderDepth;
          buildBands();
        }

        // Sparks keep their positions across a count change: shrink by truncation, grow by
        // appending, so dragging the slider does not scatter the existing dots.
        if (nextSparkCount !== sparkCount) {
          sparkCount = nextSparkCount;
          if (sparks.length > sparkCount) {
            sparks.length = sparkCount;
          } else {
            while (sparks.length < sparkCount) {
              sparks.push({
                side: Math.floor(Math.random() * 4) as Side,
                t: Math.random(),
                speed: 0.015 + Math.random() * 0.045,
                depthFrac: Math.random() ** 1.8,
                radius: 0.08 + Math.random() * 0.18,
                alpha: 0.14 + Math.random() * 0.34,
                phase: Math.random() * Math.PI * 2,
                colorIndex: Math.floor(Math.random() * colors.length),
              });
            }
          }
        }
      },
    };
  },
});

export default screenCaptureBorder;
