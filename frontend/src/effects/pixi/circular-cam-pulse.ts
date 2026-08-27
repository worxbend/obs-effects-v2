import * as PIXI from "pixi.js";

import { bool, int, num } from "../paramUtils";
import {
  createEnvelopes,
  createPixiStage,
  defineEffect,
  onFrame,
  palette,
  paletteAtInt,
  paletteParam,
  useAudio,
} from "../sdk";

/**
 * Circular Cam Pulse
 * ==================
 *
 * A circular camera frame built from four procedural layers, all drawn with plain strokes and
 * fills — no images, no sprite sheets, nothing loaded from disk. The middle of the ring and
 * everything outside it stay fully transparent, so in OBS it sits directly over a circular webcam
 * crop and frames it.
 *
 * It is deliberately a different visual language from `main-web-cam-border` (eight wavy rings with
 * sparks and lightning). This one is built on *rotation and measurement* rather than ripple:
 *
 * 1. **Twin base rings** — a thin inner ring and a thicker outer ring, concentric circles that
 *    breathe apart from each other. The gap between them is the frame's "VU meter": sustained
 *    loudness (the slow envelope) pushes the outer ring outward, silence lets it settle back.
 *
 * 2. **Counter-rotating arc trios** — two groups of three broken arcs riding between the base
 *    rings, one group turning clockwise and one counter-clockwise. Their gaps sweep past each
 *    other and never line up, because the two groups turn at speeds with no common divisor. Each
 *    arc's opacity fades along its length by being drawn as short chords of decreasing alpha,
 *    which gives every arc a comet tail without any blur filter or texture.
 *
 * 3. **Radial spectrum ticks** — short lines pointing outward from the outer ring, one per band
 *    of `bus.bands()`. Their lengths follow the derived spectrum, so the whole rim reads as a
 *    circular equaliser. (The spectrum is derived from loudness, not measured — see
 *    `sdk/audio.ts` — which is fine here: the ticks are a texture of motion, not a measurement.)
 *
 * 4. **Beat pulses** — on each detected transient a full circle spawns at the outer ring and
 *    expands outward while fading, like a ripple leaving the frame. With no audio connected the
 *    simulated signal still produces occasional pulses, so the frame idles gently rather than
 *    freezing.
 *
 * ## Glow without a filter
 *
 * Everything bright is stroked twice: once wide and nearly transparent, once thin and solid. Two
 * strokes cost two draw calls and read as a glow at these widths; a real blur filter would need a
 * render target per layer per frame. `main-web-cam-border` uses the same trick with three passes.
 *
 * ## Colour
 *
 * One palette parameter colours everything. The inner ring samples the start of the ramp, the
 * outer ring the end, arcs and ticks are spread across the middle — so switching the palette
 * re-themes the whole frame consistently instead of exposing six colour pickers.
 */

/** Ticks around the rim share one reusable band buffer; this is its maximum size. */
const MAX_TICKS = 128;

/** Arcs per rotating group. Three leaves gaps wide enough to read as motion, not as a dashed line. */
const ARCS_PER_GROUP = 3;

/** Chords per arc. Each chord steps down in alpha, which is what draws the comet tail. */
const ARC_CHORDS = 24;

/** One expanding beat ripple. */
interface Pulse {
  /** Current radius offset beyond the outer ring, in pixels. */
  offset: number;
  /** 1 at spawn, 0 at death. */
  life: number;
  /** Palette position sampled at spawn, so consecutive pulses vary in colour. */
  colorT: number;
}

const circularCamPulse = defineEffect({
  descriptor: {
    id: "circular-cam-pulse",
    name: "Circular Cam Pulse",
    description:
      "A circular camera frame of twin breathing rings, counter-rotating comet arcs, radial spectrum ticks and beat ripples, driven by OBS audio. Fully procedural — no assets.",
    engine: "pixi",
    category: "overlay",
    tags: ["camera", "border", "ring", "reactive", "overlay", "pulse"],
    previewNotes:
      "Transparent inside the ring and everywhere outside it — put it over a circular webcam crop. Reacts to OBS loudness: sustained energy widens the ring gap and speeds the arcs, transients fire expanding ripples. The radial ticks follow the SDK's derived spectrum, not a real FFT. Without audio it settles to a gentle idle on the simulated signal.",
    params: [
      {
        key: "radius",
        label: "Radius",
        kind: "number",
        default: 0.36,
        min: 0.1,
        max: 0.9,
        step: 0.01,
        description: "Inner ring radius as a fraction of the frame's shorter side.",
      },
      {
        key: "thickness",
        label: "Border Thickness",
        kind: "number",
        default: 26,
        min: 6,
        max: 120,
        step: 1,
        description:
          "Resting gap between the inner and outer ring, in pixels. Audio widens it from here.",
      },
      paletteParam(
        "palette",
        "Palette",
        "neon-dusk",
        "Colour ramp for the whole frame: inner ring at the start, outer ring at the end, arcs and ticks in between.",
      ),
      {
        key: "rotation",
        label: "Rotation Speed",
        kind: "number",
        default: 1,
        min: 0,
        max: 4,
        step: 0.05,
        description:
          "How fast the two arc groups turn. They always turn in opposite directions at slightly different rates.",
      },
      {
        key: "sensitivity",
        label: "Audio Sensitivity",
        kind: "number",
        default: 1,
        min: 0,
        max: 3,
        step: 0.05,
        description:
          "How strongly loudness widens the gap, speeds the arcs and lengthens the ticks. 0 runs at a steady idle.",
      },
      {
        key: "ticks",
        label: "Spectrum Ticks",
        kind: "number",
        default: 72,
        min: 0,
        max: 128,
        step: 4,
        description: "Radial lines around the rim acting as a circular equaliser. 0 hides them.",
      },
      {
        key: "dots",
        label: "Orbiting Dots",
        kind: "number",
        default: 24,
        min: 0,
        max: 120,
        step: 2,
        description: "Small motes circling between the rings at their own speeds. 0 hides them.",
      },
      {
        key: "pulses",
        label: "Beat Ripples",
        kind: "boolean",
        default: true,
        description: "Expanding circles fired outward from the frame when a transient is detected.",
      },
      {
        key: "glow",
        label: "Glow",
        kind: "number",
        default: 1,
        min: 0,
        max: 3,
        step: 0.05,
        description:
          "Width of the soft pass drawn behind each bright line. 0 leaves thin, hard lines.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    const bus = await useAudio(scope);
    // `useAudio` resolves even on a dead scope — see its docs — so bail out here if we were
    // disposed while awaiting, instead of building a stage nobody will see.
    scope.checkpoint();
    const envelopes = createEnvelopes(bus);

    const stage = await createPixiStage(scope, ctx);

    // Draw order back-to-front: ripples behind everything, then rings, then arcs, then ticks and
    // dots on top. Each layer is a Graphics cleared and redrawn every frame.
    const pulseLayer = stage.stage.addChild(new PIXI.Graphics());
    const ringLayer = stage.stage.addChild(new PIXI.Graphics());
    const arcLayer = stage.stage.addChild(new PIXI.Graphics());
    const detailLayer = stage.stage.addChild(new PIXI.Graphics());

    let radiusFraction = num(ctx.params, "radius", 0.36, 0.1, 0.9);
    let thickness = num(ctx.params, "thickness", 26, 6, 120);
    let ramp = palette(ctx.params, "palette", "neon-dusk");
    let rotationSpeed = num(ctx.params, "rotation", 1, 0, 4);
    let sensitivity = num(ctx.params, "sensitivity", 1, 0, 3);
    let tickCount = int(ctx.params, "ticks", 72, 0, MAX_TICKS);
    let dotCount = int(ctx.params, "dots", 24, 0, 120);
    let showPulses = bool(ctx.params, "pulses", true);
    let glowScale = num(ctx.params, "glow", 1, 0, 3);

    // Allocated once at the maximum size; only the first `tickCount` entries are read each frame.
    // Reallocating per frame or per param change would be needless garbage-collector work.
    const bands = new Float32Array(MAX_TICKS);

    // Orbiting dots are seeded deterministically from their index rather than from Math.random(),
    // so a remount reproduces the same constellation instead of scrambling it. The golden-angle
    // multiplier spreads the start angles evenly without any pair ever aligning.
    interface Dot {
      angle: number;
      speed: number;
      /** 0..1 position across the ring gap. */
      lane: number;
      size: number;
      colorT: number;
    }
    let dots: Dot[] = [];
    const seedDots = (): void => {
      dots = [];
      for (let i = 0; i < dotCount; i += 1) {
        const direction = i % 2 === 0 ? 1 : -1;
        dots.push({
          angle: i * 2.399963, // golden angle in radians
          speed: direction * (0.15 + ((i * 0.618034) % 1) * 0.35),
          lane: (i * 0.754877) % 1,
          size: 1.2 + ((i * 0.382) % 1) * 1.8,
          colorT: 0.2 + ((i * 0.618034) % 1) * 0.6,
        });
      }
    };
    seedDots();

    const pulses: Pulse[] = [];

    // The two arc groups' accumulated rotation, advanced by dt each frame so a speed change is a
    // smooth acceleration rather than a jump.
    let rotationA = 0;
    let rotationB = 0;
    let time = 0;
    // Cycles beat colours around the ramp so consecutive ripples differ.
    let pulseColorCursor = 0;

    /**
     * Strokes one arc as a chain of chords whose alpha steps down towards the tail, drawing a
     * comet without any blur. `headAngle` is the bright end; the tail trails against the direction
     * of travel, which is what `direction` flips.
     */
    const drawCometArc = (
      layer: PIXI.Graphics,
      cx: number,
      cy: number,
      radius: number,
      headAngle: number,
      span: number,
      direction: number,
      color: number,
      width: number,
      alpha: number,
    ): void => {
      for (let i = 0; i < ARC_CHORDS; i += 1) {
        const t0 = i / ARC_CHORDS;
        const t1 = (i + 1) / ARC_CHORDS;
        const a0 = headAngle - direction * span * t0;
        const a1 = headAngle - direction * span * t1;
        // Quadratic fade reads as a tail; a linear one reads as a gradient bar bent into a circle.
        const fade = (1 - t0) * (1 - t0);
        layer
          .moveTo(cx + Math.cos(a0) * radius, cy + Math.sin(a0) * radius)
          .lineTo(cx + Math.cos(a1) * radius, cy + Math.sin(a1) * radius)
          .stroke({ color, width, alpha: alpha * fade, cap: "round" });
      }
    };

    onFrame(scope, ctx.fpsCap, ({ dt, now }) => {
      bus.sample(now);
      envelopes.update(dt);
      time += dt;

      const w = stage.width;
      const h = stage.height;
      const cx = w * 0.5;
      const cy = h * 0.5;
      const innerRadius = Math.min(w, h) * radiusFraction;

      // How alive the frame is right now, 0..1. `slow` carries the body of the music, `fast` its
      // edge; blending them keeps sustained loudness and transients both visible.
      const energy = Math.min(1, (envelopes.slow * 0.6 + envelopes.fast * 0.4) * sensitivity);
      // A slow breath so the frame is never perfectly static even in total silence.
      const breathe = 1 + 0.012 * Math.sin(time * 0.6);

      // The gap widens with sustained energy — the frame's own VU meter.
      const gap = thickness * (1 + energy * 0.9) * breathe;
      const outerRadius = innerRadius + gap;
      const midRadius = innerRadius + gap * 0.5;

      // Opposite directions at 1.0 and ~0.63 relative rates: no common divisor, so the two
      // groups' gaps sweep past each other without ever locking into a repeating figure.
      const spin = rotationSpeed * (0.35 + energy * 0.9);
      rotationA += dt * spin;
      rotationB -= dt * spin * 0.63;

      const colorInner = paletteAtInt(ramp, 0);
      const colorOuter = paletteAtInt(ramp, 1);

      // ── Beat ripples ────────────────────────────────────────────────────
      pulseLayer.clear();
      if (showPulses) {
        if (envelopes.beat) {
          pulseColorCursor = (pulseColorCursor + 0.27) % 1;
          pulses.push({ offset: 0, life: 1, colorT: pulseColorCursor });
          // A hard cap so a pathological beat storm cannot grow the array without bound.
          while (pulses.length > 10) pulses.shift();
        }
        for (let i = pulses.length - 1; i >= 0; i -= 1) {
          const pulse = pulses[i];
          if (pulse === undefined) continue;
          pulse.offset += dt * (80 + energy * 160);
          pulse.life -= dt * 1.4;
          if (pulse.life <= 0) {
            pulses.splice(i, 1);
            continue;
          }
          const color = paletteAtInt(ramp, pulse.colorT);
          const r = outerRadius + pulse.offset;
          const alpha = pulse.life * pulse.life * 0.55;
          if (glowScale > 0) {
            pulseLayer
              .circle(cx, cy, r)
              .stroke({ color, width: 8 * glowScale, alpha: alpha * 0.3 });
          }
          pulseLayer.circle(cx, cy, r).stroke({ color, width: 2, alpha });
        }
      } else if (pulses.length > 0) {
        pulses.length = 0;
      }

      // ── Twin base rings ─────────────────────────────────────────────────
      // Each ring is two strokes: a wide faint one behind a thin solid one — the glow trick.
      ringLayer.clear();
      if (glowScale > 0) {
        ringLayer
          .circle(cx, cy, innerRadius)
          .stroke({ color: colorInner, width: 7 * glowScale, alpha: 0.16 });
        ringLayer
          .circle(cx, cy, outerRadius)
          .stroke({ color: colorOuter, width: 10 * glowScale, alpha: 0.14 + energy * 0.1 });
      }
      ringLayer.circle(cx, cy, innerRadius).stroke({ color: colorInner, width: 2.5, alpha: 0.95 });
      ringLayer
        .circle(cx, cy, outerRadius)
        .stroke({ color: colorOuter, width: 3.5, alpha: 0.8 + energy * 0.2 });

      // ── Counter-rotating arc trios ──────────────────────────────────────
      arcLayer.clear();
      const arcSpan = (Math.PI * 2) / ARCS_PER_GROUP * (0.45 + energy * 0.15);
      for (let i = 0; i < ARCS_PER_GROUP; i += 1) {
        const base = (i / ARCS_PER_GROUP) * Math.PI * 2;
        const colorA = paletteAtInt(ramp, 0.3);
        const colorB = paletteAtInt(ramp, 0.7);
        // Group A rides just inside the middle of the gap, group B just outside it, so the two
        // never overdraw each other exactly even where they cross.
        const radiusA = midRadius - gap * 0.12;
        const radiusB = midRadius + gap * 0.12;
        const widthCore = 2 + energy * 1.5;
        if (glowScale > 0) {
          drawCometArc(arcLayer, cx, cy, radiusA, base + rotationA, arcSpan, 1, colorA, widthCore * 3 * glowScale, 0.12);
          drawCometArc(arcLayer, cx, cy, radiusB, base + rotationB, arcSpan, -1, colorB, widthCore * 3 * glowScale, 0.12);
        }
        drawCometArc(arcLayer, cx, cy, radiusA, base + rotationA, arcSpan, 1, colorA, widthCore, 0.9);
        drawCometArc(arcLayer, cx, cy, radiusB, base + rotationB, arcSpan, -1, colorB, widthCore, 0.9);
      }

      // ── Radial spectrum ticks and orbiting dots ─────────────────────────
      detailLayer.clear();
      if (tickCount > 0) {
        // `bands` is MAX_TICKS long; slice a view of the first tickCount entries so the SDK
        // averages the spectrum into exactly the number of ticks shown. `subarray` shares the
        // buffer — no allocation per frame.
        const view = bands.subarray(0, tickCount);
        bus.bands(view);
        for (let i = 0; i < tickCount; i += 1) {
          const angle = (i / tickCount) * Math.PI * 2 - Math.PI / 2;
          const strength = (view[i] ?? 0) * sensitivity;
          // A small floor keeps the rim visibly ticked in silence — the idle look.
          const length = 3 + strength * gap * 1.4;
          const r0 = outerRadius + 4;
          const r1 = r0 + length;
          const color = paletteAtInt(ramp, 0.35 + (i / tickCount) * 0.5);
          detailLayer
            .moveTo(cx + Math.cos(angle) * r0, cy + Math.sin(angle) * r0)
            .lineTo(cx + Math.cos(angle) * r1, cy + Math.sin(angle) * r1)
            .stroke({ color, width: 2, alpha: 0.35 + strength * 0.6, cap: "round" });
        }
      }

      if (dots.length !== dotCount) seedDots();
      for (const dot of dots) {
        dot.angle += dot.speed * dt * (1 + energy * 1.5);
        const r = innerRadius + gap * (0.15 + dot.lane * 0.7);
        const x = cx + Math.cos(dot.angle) * r;
        const y = cy + Math.sin(dot.angle) * r;
        const color = paletteAtInt(ramp, dot.colorT);
        if (glowScale > 0) {
          detailLayer
            .circle(x, y, dot.size * 2.4)
            .fill({ color, alpha: 0.1 + energy * 0.08 });
        }
        detailLayer.circle(x, y, dot.size).fill({ color, alpha: 0.55 + energy * 0.35 });
      }

      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        radiusFraction = num(p, "radius", 0.36, 0.1, 0.9);
        thickness = num(p, "thickness", 26, 6, 120);
        ramp = palette(p, "palette", "neon-dusk");
        rotationSpeed = num(p, "rotation", 1, 0, 4);
        sensitivity = num(p, "sensitivity", 1, 0, 3);
        tickCount = int(p, "ticks", 72, 0, MAX_TICKS);
        dotCount = int(p, "dots", 24, 0, 120);
        showPulses = bool(p, "pulses", true);
        glowScale = num(p, "glow", 1, 0, 3);
      },
    };
  },
});

export default circularCamPulse;
