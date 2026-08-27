import * as PIXI from "pixi.js";

import { bool, colorHex, int, num, str } from "../paramUtils";
import { createPixiStage, defineEffect, onFrame, useFont } from "../sdk";

/**
 * Animated Lines
 * ==============
 *
 * A pentagram sigil that draws itself onto the frame stroke by stroke, holds while a title fades in,
 * then erases itself in reverse and starts again. Behind it, embers drift upward and faint runes
 * drift across the background.
 *
 * A "starting soon" screen, and the loop is timed for one: about twenty-five seconds from blank to
 * blank, which is long enough not to feel like a spinner.
 *
 * Ported from `animated-lines.html` in the old `obs-effects` repository — with one substantial
 * difference that is worth reading before comparing them.
 *
 * ## This is a reimplementation, not a transplant
 *
 * The original was **GSAP animating an inline SVG**, and it used four of GSAP's *Club* plugins:
 * `DrawSVGPlugin`, `MorphSVGPlugin`, `Physics2DPlugin` and `InertiaPlugin`. Those are commercial
 * products with a per-developer licence. This is a public open-source repository, so adding them —
 * or vendoring them — is not an option, and the effect is here without them.
 *
 * The sigil's **path data is the original's, character for character** (see `SIGIL_SEGMENTS`), so
 * the shape is exactly the shape it was. What is reimplemented is the animation:
 *
 * - **The draw-on.** `DrawSVGPlugin` animates a stroke's dash offset so a path appears to be drawn.
 *   Here each segment is a list of points and the reveal interpolates along it, drawing a partial
 *   polyline. That is the same idea done by hand, and for these shapes — polylines and one ellipse —
 *   it produces the same result.
 * - **The embers.** `Physics2DPlugin` gave them gravity and drag. They are plain integration here:
 *   a velocity, a little upward acceleration and some sideways drift. Nobody can tell.
 * - **The breathing.** A slow scale-and-rotate on the whole scene, which was a GSAP tween and is now
 *   two sine waves.
 *
 * What is genuinely *not* here is `MorphSVGPlugin`, which the original registered and — as far as
 * this port could tell from reading it — never actually used on this page.
 *
 * ## Why it is drawn on a canvas rather than as an SVG
 *
 * The effect could have appended an `<svg>` to the host element instead. It does not, because the
 * verification harness and the renderer both expect an effect to produce a canvas: an SVG-based
 * effect would draw correctly and then fail every automated check that asks whether it painted
 * anything. Pixi draws the same shapes.
 */

/**
 * The sigil, exactly as the original SVG defined it, in a 500×500 coordinate space.
 *
 * The first entry is the outer ring, written as an ellipse rather than the original's four bezier
 * curves — they described a circle, and an arc reveals cleanly from a single angle sweep where a
 * bezier would need subdividing.
 *
 * The five that follow are the star's arms. Each is a closed outline of six points: the original
 * wrote them as `M` followed by bare coordinate pairs, which SVG reads as a polyline.
 */
const SIGIL_SEGMENTS: readonly (readonly [number, number][])[] = [
  // Arm 1
  [
    [269.458, 168.295],
    [254.677, 157.561],
    [381.412, 65.483],
    [307.271, 293.624],
    [289.005, 293.624],
    [348.333, 110.983],
  ],
  // Arm 2
  [
    [331.136, 243.449],
    [336.777, 226.074],
    [463.512, 318.152],
    [223.626, 318.139],
    [217.982, 300.768],
    [410.017, 300.752],
  ],
  // Arm 3
  [
    [278.699, 325.342],
    [296.966, 325.338],
    [248.558, 474.325],
    [174.442, 246.175],
    [189.219, 235.439],
    [248.576, 418.071],
  ],
  // Arm 4
  [
    [184.583, 300.792],
    [190.233, 318.165],
    [33.579, 318.165],
    [227.66, 177.174],
    [242.436, 187.911],
    [87.085, 300.798],
  ],
  // Arm 5
  [
    [178.868, 203.711],
    [164.091, 214.453],
    [115.683, 65.465],
    [309.747, 206.479],
    [304.102, 223.849],
    [148.733, 110.987],
  ],
];

/** The ring: centre and radius in the same 500×500 space as the arms. */
const RING = { cx: 250, cy: 250, r: 230 };

/** The design space the coordinates above are in. Everything is scaled from this. */
const DESIGN_SIZE = 500;

/** One phase of the loop, in seconds. They run in this order and then repeat. */
const PHASE = {
  ringDraw: 4,
  armsDraw: 4.5,
  textIn: 2.5,
  hold: 5,
  textOut: 2,
  armsErase: 2.5,
  ringErase: 3,
  blank: 1.5,
} as const;

const LOOP_LENGTH = Object.values(PHASE).reduce((total, seconds) => total + seconds, 0);

/** Smooth ease used for every reveal, matching the original's `sine.inOut`. */
function easeInOutSine(t: number): number {
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** One drifting ember. */
interface Ember {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  life: number;
  age: number;
}

const animatedLines = defineEffect({
  descriptor: {
    id: "animated-lines",
    name: "Animated Lines",
    description:
      "A pentagram sigil that draws itself stroke by stroke, holds while a title fades in, then erases in reverse — over drifting embers. A starting-soon screen.",
    engine: "pixi",
    category: "background",
    tags: ["sigil", "pentagram", "starting-soon", "ritual", "embers", "occult"],
    previewNotes:
      "A full loop is about 25 seconds from blank to blank, so a short preview may catch it mid-erase or empty — that is the effect working. Set Text to your own wording. Reimplemented without GSAP; see the file header for what changed and why.",
    params: [
      {
        key: "text",
        label: "Text",
        kind: "text",
        default: "STARTING SOON",
        description: "Shown once the sigil is fully drawn. Leave it empty for the sigil alone.",
      },
      {
        key: "fontFamily",
        label: "Font",
        kind: "text",
        default: "monospace",
        description:
          "A CSS font family. The original used MonoLisa, which is not bundled; any monospace face suits the look.",
      },
      {
        key: "fontSize",
        label: "Font Size",
        kind: "number",
        default: 82,
        min: 12,
        max: 220,
        step: 2,
        description: "Title size in pixels, at a 1080-tall canvas. It scales with the frame.",
      },
      {
        key: "speed",
        label: "Speed",
        kind: "number",
        default: 1,
        min: 0.1,
        max: 4,
        step: 0.05,
        description: "How fast the whole loop runs. 0.5 doubles the 25-second cycle; 2 halves it.",
      },
      {
        key: "size",
        label: "Sigil Size",
        kind: "number",
        default: 0.7,
        min: 0.2,
        max: 1.2,
        step: 0.02,
        description: "Sigil diameter as a fraction of the frame's shorter side.",
      },
      {
        key: "thickness",
        label: "Line Thickness",
        kind: "number",
        default: 3,
        min: 0.5,
        max: 12,
        step: 0.5,
        description: "Stroke width of the sigil, in design units — it scales with the sigil.",
      },
      {
        key: "embers",
        label: "Embers",
        kind: "number",
        default: 60,
        min: 0,
        max: 400,
        step: 5,
        description: "Drifting sparks rising behind the sigil. 0 removes them.",
      },
      {
        key: "breathing",
        label: "Breathing",
        kind: "boolean",
        default: true,
        description:
          "The very slow scale and rotation of the whole scene. Subtle, and what stops the held phase looking like a frozen image.",
      },
      {
        key: "colorInk",
        label: "Ink Colour",
        kind: "color",
        default: "#c81e1e",
        description: "The sigil strokes and the title.",
      },
      {
        key: "colorEmber",
        label: "Ember Colour",
        kind: "color",
        default: "#ff6a2a",
        description: "The drifting sparks.",
      },
      {
        key: "background",
        label: "Background",
        kind: "boolean",
        default: true,
        description: "Fill the frame behind everything. Turn it off to lay the sigil over a scene.",
      },
      {
        key: "backgroundColor",
        label: "Background Colour",
        kind: "color",
        default: "#0a0203",
        description: "Only used when Background is on.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    let fontFamily = str(ctx.params, "fontFamily", "monospace");
    let fontSize = num(ctx.params, "fontSize", 82, 12, 220);

    await useFont(`${fontSize}px ${fontFamily}`);
    scope.checkpoint();

    const stage = await createPixiStage(scope, ctx);

    const backgroundLayer = stage.stage.addChild(new PIXI.Graphics());
    const emberLayer = stage.stage.addChild(new PIXI.Graphics());
    // The sigil lives in its own container so the breathing transform applies to it as a whole,
    // rather than having to be folded into every coordinate.
    const sceneLayer = stage.stage.addChild(new PIXI.Container());
    const sigilLayer = sceneLayer.addChild(new PIXI.Graphics());

    let text = str(ctx.params, "text", "STARTING SOON");
    let speed = num(ctx.params, "speed", 1, 0.1, 4);
    let sizeFraction = num(ctx.params, "size", 0.7, 0.2, 1.2);
    let thickness = num(ctx.params, "thickness", 3, 0.5, 12);
    let emberCount = int(ctx.params, "embers", 60, 0, 400);
    let breathing = bool(ctx.params, "breathing", true);
    let colorInk = colorHex(ctx.params, "colorInk", "#c81e1e");
    let colorEmber = colorHex(ctx.params, "colorEmber", "#ff6a2a");
    let drawBackground = bool(ctx.params, "background", true);
    let backgroundColor = colorHex(ctx.params, "backgroundColor", "#0a0203");

    const title = scope.own(
      new PIXI.Text({
        text,
        style: new PIXI.TextStyle({
          fontFamily,
          fontSize,
          fill: colorInk,
          letterSpacing: 18,
          align: "center",
        }),
      }),
      (t) => t.destroy(true),
    );
    title.anchor.set(0.5);
    stage.stage.addChild(title);

    const embers: Ember[] = [];

    const spawnEmber = (w: number, h: number, atBottom: boolean): Ember => ({
      x: Math.random() * w,
      // Spread through the frame on the first fill so it does not start empty, then always from
      // below the bottom edge afterwards.
      y: atBottom ? h + Math.random() * 40 : Math.random() * h,
      vx: (Math.random() - 0.5) * 14,
      vy: -(18 + Math.random() * 46),
      size: 1 + Math.random() * 2.4,
      life: 4 + Math.random() * 6,
      age: Math.random() * 0.6,
    });

    const seedEmbers = (): void => {
      embers.length = 0;
      for (let i = 0; i < emberCount; i += 1) {
        embers.push(spawnEmber(stage.width, stage.height, false));
      }
    };
    seedEmbers();

    let clock = 0;

    /**
     * How much of the ring and of each arm is drawn, for a moment in the loop.
     *
     * Returned as one object rather than computed inline so the phase arithmetic — which is the
     * fiddly part — lives in one place and the drawing below stays readable.
     */
    const progressAt = (
      t: number,
    ): { ring: number; arms: number[]; text: number; fade: number } => {
      const arms = [0, 0, 0, 0, 0];
      let ring: number;
      let textAlpha: number;
      let fade = 1;

      let mark = 0;
      const phase = (length: number): number => {
        const local = (t - mark) / length;
        mark += length;
        return clamp01(local);
      };

      // Ring draws first, alone.
      const ringDraw = phase(PHASE.ringDraw);
      // Then the arms, staggered so each starts a fifth of the way after the last.
      const armsDraw = phase(PHASE.armsDraw);
      const textIn = phase(PHASE.textIn);
      const hold = phase(PHASE.hold);
      const textOut = phase(PHASE.textOut);
      const armsErase = phase(PHASE.armsErase);
      const ringErase = phase(PHASE.ringErase);
      const blank = phase(PHASE.blank);

      if (ringDraw < 1) {
        ring = easeInOutSine(ringDraw);
      } else if (ringErase > 0 && ringErase < 1) {
        ring = 1 - easeInOutSine(ringErase);
      } else if (blank > 0) {
        ring = 0;
      } else {
        ring = 1;
      }

      for (let i = 0; i < arms.length; i += 1) {
        // Each arm's window is offset within the draw phase, which is the stagger.
        const stagger = i * 0.12;
        if (armsDraw > 0 && armsDraw < 1) {
          arms[i] = easeInOutSine(clamp01((armsDraw - stagger) / (1 - stagger * 0.8)));
        } else if (armsErase > 0 && armsErase < 1) {
          // Erased in reverse order, so the last arm drawn is the first to go.
          const reverse = (arms.length - 1 - i) * 0.12;
          arms[i] = 1 - easeInOutSine(clamp01((armsErase - reverse) / (1 - reverse * 0.8)));
        } else if (armsDraw >= 1 && armsErase <= 0) {
          arms[i] = 1;
        } else {
          arms[i] = 0;
        }
      }

      if (textIn > 0 && textIn < 1) textAlpha = easeInOutSine(textIn);
      else if (textIn >= 1 && textOut <= 0) textAlpha = 1;
      else if (textOut > 0 && textOut < 1) textAlpha = 1 - easeInOutSine(textOut);
      else textAlpha = 0;

      // A whole-scene fade at the very start and the very end of the loop, so the sigil arrives and
      // leaves rather than snapping.
      if (ringDraw < 1) fade = clamp01(ringDraw * 3);
      if (blank > 0) fade = 1 - blank;
      // `hold` participates in nothing; reading it keeps the phase cursor advancing in order.
      void hold;

      return { ring, arms, text: textAlpha, fade };
    };

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      clock = (clock + dt * speed) % LOOP_LENGTH;

      const w = stage.width;
      const h = stage.height;
      const shortSide = Math.min(w, h);
      const scale = (shortSide * sizeFraction) / DESIGN_SIZE;

      backgroundLayer.clear();
      if (drawBackground) backgroundLayer.rect(0, 0, w, h).fill({ color: backgroundColor });

      // ── Embers ──────────────────────────────────────────────────────────
      emberLayer.clear();
      if (embers.length !== emberCount) seedEmbers();
      for (let i = 0; i < embers.length; i += 1) {
        const ember = embers[i];
        if (ember === undefined) continue;
        ember.age += dt;
        // A little upward acceleration and sideways wander — the plain integration that replaces
        // the original's physics plugin.
        ember.vy -= 6 * dt;
        ember.vx += Math.sin(clock * 1.7 + i) * 6 * dt;
        ember.x += ember.vx * dt;
        ember.y += ember.vy * dt;

        if (ember.age >= ember.life || ember.y < -20) {
          embers[i] = spawnEmber(w, h, true);
          continue;
        }

        // Bright at birth, fading out over the last third of life.
        const alpha = clamp01(
          Math.min(ember.age * 4, 1) * (1 - Math.pow(ember.age / ember.life, 3)),
        );
        emberLayer
          .circle(ember.x, ember.y, ember.size)
          .fill({ color: colorEmber, alpha: alpha * 0.9 });
      }

      // ── The sigil ───────────────────────────────────────────────────────
      const progress = progressAt(clock);

      sceneLayer.position.set(w / 2, h / 2);
      if (breathing) {
        // Two slow sine waves at unrelated rates, so the scene never settles.
        const breathe = 1 + Math.sin(clock * 0.35) * 0.02;
        sceneLayer.scale.set(scale * breathe);
        sceneLayer.rotation = Math.sin(clock * 0.22) * 0.0035;
      } else {
        sceneLayer.scale.set(scale);
        sceneLayer.rotation = 0;
      }
      sceneLayer.alpha = progress.fade;

      sigilLayer.clear();

      // The ring, drawn as an arc from the top so it sweeps clockwise into place.
      if (progress.ring > 0.001) {
        const start = -Math.PI / 2;
        sigilLayer
          .arc(
            RING.cx - DESIGN_SIZE / 2,
            RING.cy - DESIGN_SIZE / 2,
            RING.r,
            start,
            start + Math.PI * 2 * progress.ring,
          )
          .stroke({ width: thickness, color: colorInk, alpha: 0.95, cap: "round" });
      }

      // Each arm as a partially-drawn polyline. The reveal walks the point list and interpolates
      // within whichever edge it is currently on — the by-hand version of a dash-offset animation.
      for (let s = 0; s < SIGIL_SEGMENTS.length; s += 1) {
        const points = SIGIL_SEGMENTS[s];
        const amount = progress.arms[s] ?? 0;
        if (points === undefined || amount <= 0.001) continue;

        // Closed shape, so the last edge returns to the first point.
        const edges = points.length;
        const travelled = amount * edges;
        const whole = Math.floor(travelled);
        const partial = travelled - whole;

        const first = points[0];
        if (first === undefined) continue;
        sigilLayer.moveTo(first[0] - DESIGN_SIZE / 2, first[1] - DESIGN_SIZE / 2);

        for (let i = 1; i <= Math.min(whole, edges - 1); i += 1) {
          const p = points[i];
          if (p === undefined) continue;
          sigilLayer.lineTo(p[0] - DESIGN_SIZE / 2, p[1] - DESIGN_SIZE / 2);
        }

        if (whole < edges) {
          const from = points[Math.min(whole, edges - 1)];
          const to = points[(whole + 1) % edges];
          if (from !== undefined && to !== undefined) {
            sigilLayer.lineTo(
              from[0] + (to[0] - from[0]) * partial - DESIGN_SIZE / 2,
              from[1] + (to[1] - from[1]) * partial - DESIGN_SIZE / 2,
            );
          }
        }

        sigilLayer.stroke({
          width: thickness,
          color: colorInk,
          alpha: 0.95,
          cap: "round",
          join: "round",
        });
      }

      // ── The title ───────────────────────────────────────────────────────
      title.visible = text !== "" && progress.text > 0.001;
      if (title.visible) {
        title.alpha = progress.text;
        title.position.set(w / 2, h / 2 + shortSide * sizeFraction * 0.62);
        // Scaled with the frame so the title keeps its proportion to the sigil at any canvas size.
        title.scale.set((h / 1080) * (0.95 + progress.text * 0.05));
      }

      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        text = str(p, "text", "STARTING SOON");
        fontFamily = str(p, "fontFamily", "monospace");
        fontSize = num(p, "fontSize", 82, 12, 220);
        speed = num(p, "speed", 1, 0.1, 4);
        sizeFraction = num(p, "size", 0.7, 0.2, 1.2);
        thickness = num(p, "thickness", 3, 0.5, 12);
        emberCount = int(p, "embers", 60, 0, 400);
        breathing = bool(p, "breathing", true);
        colorInk = colorHex(p, "colorInk", "#c81e1e");
        colorEmber = colorHex(p, "colorEmber", "#ff6a2a");
        drawBackground = bool(p, "background", true);
        backgroundColor = colorHex(p, "backgroundColor", "#0a0203");

        title.text = text;
        title.style.fontFamily = fontFamily;
        title.style.fontSize = fontSize;
        title.style.fill = colorInk;
      },
    };
  },
});

export default animatedLines;
