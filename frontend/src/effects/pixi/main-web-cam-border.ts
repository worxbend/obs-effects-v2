import * as PIXI from "pixi.js";

import { bool, colorHex, int, num } from "../paramUtils";
import { createEnvelopes, createPixiStage, defineEffect, onFrame, useAudio } from "../sdk";

/**
 * Main Web Cam Border
 * ===================
 *
 * A circular camera frame built from eight nested rings, each rippling at its own wave count, speed
 * and radius, glowing in Razer greens, toxic violets and Catppuccin pastels. Sparkles, sparks and
 * the occasional lightning arc fire around the rim, and the whole thing breathes and reacts to what
 * OBS is playing.
 *
 * Ported from `main-web-cam-border.html` in the old `obs-effects` repository, where it was
 * `CameraBorder.ts` — at 1,874 lines the largest single file in that project.
 *
 * ## The rings are the effect
 *
 * Each of the eight is a closed path whose radius varies as `sin(angle × waveCount + phase)`. What
 * makes them read as one living object rather than eight loops is that **no two share a divisor**:
 * wave counts of 2, 8, 12, 9, 7, 3, 5 and 4 at eight different speeds, two of them turning backwards.
 * The pattern where they cross therefore never repeats.
 *
 * On top of that each ring has two slow independent drifts of its own — one on its speed, one on its
 * amplitude — so even a single ring never settles into a steady rhythm.
 *
 * ## Glow without a blur filter
 *
 * Every ring is stroked **three times**: very wide and almost transparent, then medium, then a sharp
 * core. That is the whole glow. A real blur would mean a render target and a two-pass filter for each
 * of eight rings, every frame; three strokes cost three draw calls and look the same at these widths.
 *
 * The four `breatheMode` presets — calm, bass, electric, fluid — are just different width and alpha
 * ratios for those three passes, plus per-vertex jitter for `electric`, which is what makes that one
 * crackle rather than flow.
 *
 * ## The scope of this port
 *
 * The original had eighteen drawing subsystems. This port carries the ones that make the frame what
 * it is: the anchor ring, the eight wave rings with their glow modes and drift, sparkles, sparks,
 * lightning, orbiting particles and the audio reactivity.
 *
 * Left out are the layers that depended on the old project's asset bundle and sprite sheet — the
 * graffiti tags and marks stamped from `sprite.png`, the floating decorative symbols, the brush
 * strokes and the surface grime, plus the logo sprite. Those need a 900 kB sprite atlas and its cell
 * map to mean anything, and without it they would be blank rectangles. `logo` in this build covers
 * the logo-on-a-frame case.
 *
 * ## Audio
 *
 * The original called this "activity" and drove it from the OBS bridge. It does the same here
 * through the SDK's shared bus: louder audio widens the ring amplitudes, speeds up the spawn rate of
 * sparkles and sparks, and makes lightning more frequent. With nothing connected it settles to a
 * gentle idle rather than stopping.
 */

/** Points around one ring. Higher is smoother and costs proportionally more. */
const WAVE_STEPS = 220;

/** How a ring's three glow passes are weighted. */
type BreatheMode = "calm" | "bass" | "electric" | "fluid";

interface WaveConfig {
  color: string;
  waveCount: number;
  baseAmplitude: number;
  speed: number;
  radiusScale: number;
  phaseOffset: number;
  lineWidth: number;
  breatheMode: BreatheMode;
}

/**
 * The eight rings, carried over from the original's `razerPalette.ts` unchanged.
 *
 * The wave counts are deliberately co-prime-ish — 2, 8, 12, 9, 7, 3, 5, 4 — so the crossings never
 * line up into a repeating figure.
 */
const WAVE_CONFIGS: readonly WaveConfig[] = [
  {
    color: "#94e2d5",
    waveCount: 2,
    baseAmplitude: 4,
    speed: 0.02,
    radiusScale: 0.87,
    phaseOffset: 0,
    lineWidth: 8,
    breatheMode: "bass",
  },
  {
    color: "#f38ba8",
    waveCount: 8,
    baseAmplitude: 6,
    speed: -0.36,
    radiusScale: 0.9,
    phaseOffset: 1.6,
    lineWidth: 1.2,
    breatheMode: "electric",
  },
  {
    color: "#8b00ff",
    waveCount: 12,
    baseAmplitude: 3,
    speed: 0.74,
    radiusScale: 0.93,
    phaseOffset: 1.8,
    lineWidth: 2,
    breatheMode: "electric",
  },
  {
    color: "#c050ff",
    waveCount: 9,
    baseAmplitude: 5,
    speed: 0.18,
    radiusScale: 0.96,
    phaseOffset: 2.3,
    lineWidth: 1.5,
    breatheMode: "fluid",
  },
  {
    color: "#00ff41",
    waveCount: 7,
    baseAmplitude: 7,
    speed: 0.4,
    radiusScale: 0.99,
    phaseOffset: 0,
    lineWidth: 2.5,
    breatheMode: "bass",
  },
  {
    color: "#39ff14",
    waveCount: 3,
    baseAmplitude: 14,
    speed: -0.11,
    radiusScale: 1.02,
    phaseOffset: 0.7,
    lineWidth: 3,
    breatheMode: "bass",
  },
  {
    color: "#0bc4e3",
    waveCount: 5,
    baseAmplitude: 9,
    speed: -0.26,
    radiusScale: 1.05,
    phaseOffset: 1.1,
    lineWidth: 1.5,
    breatheMode: "calm",
  },
  {
    color: "#cba6f7",
    waveCount: 4,
    baseAmplitude: 11,
    speed: 0.22,
    radiusScale: 1.09,
    phaseOffset: 0.4,
    lineWidth: 2,
    breatheMode: "fluid",
  },
];

/** Width and alpha ratios for the three glow passes of each mode. */
const GLOW_PASSES: Record<BreatheMode, { width: number; alpha: number }[]> = {
  calm: [
    { width: 8, alpha: 0.04 },
    { width: 3, alpha: 0.18 },
    { width: 1, alpha: 0.88 },
  ],
  bass: [
    { width: 9, alpha: 0.05 },
    { width: 3.5, alpha: 0.22 },
    { width: 1, alpha: 0.92 },
  ],
  electric: [
    { width: 11, alpha: 0.08 },
    { width: 2.5, alpha: 0.35 },
    { width: 1, alpha: 0.95 },
  ],
  fluid: [
    { width: 12, alpha: 0.03 },
    { width: 5, alpha: 0.14 },
    { width: 1, alpha: 0.9 },
  ],
};

interface Sparkle {
  angle: number;
  radius: number;
  size: number;
  alpha: number;
  decay: number;
  color: string;
}

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  decay: number;
  color: string;
}

interface Bolt {
  points: number[];
  alpha: number;
  decay: number;
  color: string;
}

interface Particle {
  angle: number;
  speed: number;
  radiusOffset: number;
  size: number;
  driftPhase: number;
  driftSpeed: number;
  driftAmplitude: number;
  color: string;
  alpha: number;
}

const mainWebCamBorder = defineEffect({
  descriptor: {
    id: "main-web-cam-border",
    name: "Main Web Cam Border",
    description:
      "A circular camera frame of eight nested rippling rings in Razer greens and toxic violets, with sparkles, sparks and lightning around the rim, reacting to OBS audio.",
    engine: "pixi",
    category: "overlay",
    tags: ["camera", "border", "razer", "rings", "reactive", "overlay"],
    previewNotes:
      "Transparent inside the ring — put it over a circular webcam source. Reacts to OBS audio: louder widens the rings and speeds up the sparks. See the file header for which of the original's eighteen layers this port carries.",
    params: [
      {
        key: "radius",
        label: "Radius",
        kind: "number",
        default: 0.36,
        min: 0.1,
        max: 0.9,
        step: 0.01,
        description: "Ring radius as a fraction of the frame's shorter side.",
      },
      {
        key: "speed",
        label: "Speed",
        kind: "number",
        default: 1,
        min: 0,
        max: 4,
        step: 0.05,
        description: "How fast the rings turn. Each keeps its own rate and direction.",
      },
      {
        key: "amplitude",
        label: "Ripple",
        kind: "number",
        default: 1,
        min: 0,
        max: 3,
        step: 0.05,
        description: "How far the rings ripple. 0 leaves eight concentric circles.",
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
          "How much the audio widens the rings and speeds up the effects. 0 runs at a steady idle.",
      },
      {
        key: "anchorRing",
        label: "Anchor Ring",
        kind: "boolean",
        default: true,
        description:
          "The thick near-black circle the coloured rings sit on. It is what defines the edge.",
      },
      {
        key: "sparkles",
        label: "Sparkles",
        kind: "boolean",
        default: true,
        description: "Points of light appearing and fading on the rim.",
      },
      {
        key: "sparks",
        label: "Sparks",
        kind: "boolean",
        default: true,
        description: "Short-lived embers thrown outward from the rim.",
      },
      {
        key: "lightning",
        label: "Lightning",
        kind: "boolean",
        default: true,
        description: "Jagged arcs that occasionally leap across the ring.",
      },
      {
        key: "particles",
        label: "Orbiting Particles",
        kind: "number",
        default: 40,
        min: 0,
        max: 300,
        step: 5,
        description: "Motes circling the frame at varying radii.",
      },
      {
        key: "colorAnchor",
        label: "Anchor Colour",
        kind: "color",
        default: "#11111b",
        description: "The thick base ring.",
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
          "Width of the two soft passes behind each ring's sharp core. 0 leaves thin, hard lines.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    const bus = await useAudio(scope);
    scope.checkpoint();
    const envelopes = createEnvelopes(bus);

    const stage = await createPixiStage(scope, ctx);

    const anchorLayer = stage.stage.addChild(new PIXI.Graphics());
    const waveLayer = stage.stage.addChild(new PIXI.Graphics());
    const particleLayer = stage.stage.addChild(new PIXI.Graphics());
    const effectLayer = stage.stage.addChild(new PIXI.Graphics());

    let radiusFraction = num(ctx.params, "radius", 0.36, 0.1, 0.9);
    let speed = num(ctx.params, "speed", 1, 0, 4);
    let amplitudeScale = num(ctx.params, "amplitude", 1, 0, 3);
    let reactivity = num(ctx.params, "reactivity", 1, 0, 3);
    let showAnchor = bool(ctx.params, "anchorRing", true);
    let showSparkles = bool(ctx.params, "sparkles", true);
    let showSparks = bool(ctx.params, "sparks", true);
    let showLightning = bool(ctx.params, "lightning", true);
    let particleCount = int(ctx.params, "particles", 40, 0, 300);
    let colorAnchor = colorHex(ctx.params, "colorAnchor", "#11111b");
    let glowScale = num(ctx.params, "glow", 1, 0, 3);

    // Each ring drifts independently. Seeded from the index rather than randomly, so a remount
    // reproduces the same arrangement instead of scrambling the rings.
    const speedDrift = WAVE_CONFIGS.map((_, i) => (i * 2.399) % (Math.PI * 2));
    const ampDrift = WAVE_CONFIGS.map((_, i) => (i * 1.618) % (Math.PI * 2));

    let particles: Particle[] = [];
    const sparkles: Sparkle[] = [];
    const sparks: Spark[] = [];
    const bolts: Bolt[] = [];

    const seedParticles = (): void => {
      particles = [];
      for (let i = 0; i < particleCount; i += 1) {
        particles.push({
          angle: Math.random() * Math.PI * 2,
          speed: (0.1 + Math.random() * 0.35) * (Math.random() > 0.5 ? 1 : -1),
          radiusOffset: (Math.random() - 0.5) * 60,
          size: 1 + Math.random() * 2.5,
          driftPhase: Math.random() * Math.PI * 2,
          driftSpeed: 0.4 + Math.random() * 1.2,
          driftAmplitude: 4 + Math.random() * 14,
          color: WAVE_CONFIGS[Math.floor(Math.random() * WAVE_CONFIGS.length)]?.color ?? "#00ff41",
          alpha: 0.3 + Math.random() * 0.5,
        });
      }
    };
    seedParticles();

    let time = 0;
    let sparkleAccum = 0;
    let sparkAccum = 0;
    let lightningAccum = 0;

    /** Traces one ring's closed path into the wave layer. */
    const buildWavePath = (
      cx: number,
      cy: number,
      radius: number,
      waveCount: number,
      amplitude: number,
      phase: number,
      jitter: number,
    ): void => {
      for (let i = 0; i <= WAVE_STEPS; i += 1) {
        const angle = (i / WAVE_STEPS) * Math.PI * 2;
        const wobble = jitter > 0 ? (Math.random() - 0.5) * jitter : 0;
        const r = radius + Math.sin(angle * waveCount + phase) * amplitude + wobble;
        const x = cx + Math.cos(angle) * r;
        const y = cy + Math.sin(angle) * r;
        if (i === 0) waveLayer.moveTo(x, y);
        else waveLayer.lineTo(x, y);
      }
      waveLayer.closePath();
    };

    onFrame(scope, ctx.fpsCap, ({ dt, now }) => {
      bus.sample(now);
      envelopes.update(dt);
      time += dt * speed;

      const w = stage.width;
      const h = stage.height;
      const cx = w * 0.5;
      const cy = h * 0.5;
      const baseRadius = Math.min(w, h) * radiusFraction;

      // "Activity" in the original — how alive everything is. Everything below scales from it.
      const activity = Math.min(1, (bus.level + envelopes.slow * 0.5) * reactivity);
      // The whole frame breathes together, so the held moments are never static.
      const breathe = 1 + 0.03 * Math.sin(time * 0.7);

      // ── Anchor ring ─────────────────────────────────────────────────────
      anchorLayer.clear();
      if (showAnchor) {
        anchorLayer
          .circle(cx, cy, baseRadius * breathe)
          .stroke({ color: colorAnchor, width: 10, alpha: 1 });
      }

      // ── The eight wave rings ────────────────────────────────────────────
      waveLayer.clear();
      for (let i = 0; i < WAVE_CONFIGS.length; i += 1) {
        const config = WAVE_CONFIGS[i];
        if (config === undefined) continue;

        // Two slow independent drifts per ring, alternating direction, so no ring ever settles.
        speedDrift[i] = (speedDrift[i] ?? 0) + dt * (0.008 + i * 0.0005) * (i % 2 === 0 ? 1 : -1);
        ampDrift[i] = (ampDrift[i] ?? 0) + dt * (0.019 + i * 0.002);

        const speedMod = 1 + 0.28 * Math.sin(speedDrift[i] ?? 0);
        const ampEnvelope = 0.45 + 0.55 * Math.abs(Math.sin(ampDrift[i] ?? 0));
        const ambient = 0.55 + activity * 0.45;

        const phase = time * config.speed * speedMod + config.phaseOffset;
        const amplitude = config.baseAmplitude * ampEnvelope * ambient * amplitudeScale;
        const radius = baseRadius * breathe * config.radiusScale;

        const passes = GLOW_PASSES[config.breatheMode];
        const width = config.lineWidth * (0.92 + ambient * 0.1);
        // Only `electric` jitters its vertices — that is what makes it crackle where the others flow.
        const jitter = config.breatheMode === "electric" ? amplitude * 0.08 * ambient : 0;

        for (let p = 0; p < passes.length; p += 1) {
          const pass = passes[p];
          if (pass === undefined) continue;
          // The sharp core is always drawn; the two soft passes behind it scale with Glow.
          const isCore = p === passes.length - 1;
          const passWidth = isCore ? width : width * pass.width * glowScale;
          if (passWidth <= 0) continue;
          buildWavePath(cx, cy, radius, config.waveCount, amplitude, phase, jitter * (p + 1) * 0.3);
          waveLayer.stroke({ color: config.color, alpha: pass.alpha, width: passWidth });
        }
      }

      // ── Orbiting particles ──────────────────────────────────────────────
      particleLayer.clear();
      if (particles.length !== particleCount) seedParticles();
      for (const particle of particles) {
        particle.angle += particle.speed * dt * (1 + activity);
        const drift =
          Math.sin(time * particle.driftSpeed + particle.driftPhase) * particle.driftAmplitude;
        const r = (baseRadius + particle.radiusOffset + drift) * breathe;
        particleLayer
          .circle(
            cx + Math.cos(particle.angle) * r,
            cy + Math.sin(particle.angle) * r,
            particle.size,
          )
          .fill({ color: particle.color, alpha: particle.alpha });
      }

      // ── Sparkles, sparks, lightning ─────────────────────────────────────
      // Spawn intervals shorten as the audio gets louder, which is the main way the frame reacts.
      effectLayer.clear();

      if (showSparkles) {
        sparkleAccum += dt;
        if (sparkleAccum >= 0.28 / (0.3 + activity * 0.9)) {
          sparkleAccum = 0;
          sparkles.push({
            angle: Math.random() * Math.PI * 2,
            radius: baseRadius + (Math.random() - 0.5) * 40,
            size: 1.5 + Math.random() * 3,
            alpha: 1,
            decay: 1.2 + Math.random() * 1.4,
            color:
              WAVE_CONFIGS[Math.floor(Math.random() * WAVE_CONFIGS.length)]?.color ?? "#ffffff",
          });
          if (sparkles.length > 60) sparkles.shift();
        }
        for (let i = sparkles.length - 1; i >= 0; i -= 1) {
          const sparkle = sparkles[i];
          if (sparkle === undefined) continue;
          sparkle.alpha -= sparkle.decay * dt;
          if (sparkle.alpha <= 0) {
            sparkles.splice(i, 1);
            continue;
          }
          const r = sparkle.radius * breathe;
          const x = cx + Math.cos(sparkle.angle) * r;
          const y = cy + Math.sin(sparkle.angle) * r;
          effectLayer
            .circle(x, y, sparkle.size * 2.5)
            .fill({ color: sparkle.color, alpha: sparkle.alpha * 0.15 });
          effectLayer
            .circle(x, y, sparkle.size)
            .fill({ color: sparkle.color, alpha: sparkle.alpha });
        }
      }

      if (showSparks) {
        sparkAccum += dt;
        if (sparkAccum >= 0.15 / (0.4 + activity * 0.7)) {
          sparkAccum = 0;
          const angle = Math.random() * Math.PI * 2;
          const outward = 40 + Math.random() * 160;
          for (let i = 0; i < 3; i += 1) {
            const spread = angle + (Math.random() - 0.5) * 0.6;
            sparks.push({
              x: cx + Math.cos(angle) * baseRadius,
              y: cy + Math.sin(angle) * baseRadius,
              vx: Math.cos(spread) * outward,
              vy: Math.sin(spread) * outward,
              life: 1,
              decay: 1.5 + Math.random(),
              color:
                WAVE_CONFIGS[Math.floor(Math.random() * WAVE_CONFIGS.length)]?.color ?? "#ffffff",
            });
          }
          while (sparks.length > 120) sparks.shift();
        }
        for (let i = sparks.length - 1; i >= 0; i -= 1) {
          const spark = sparks[i];
          if (spark === undefined) continue;
          spark.x += spark.vx * dt;
          spark.y += spark.vy * dt;
          spark.life -= spark.decay * dt;
          if (spark.life <= 0) {
            sparks.splice(i, 1);
            continue;
          }
          effectLayer
            .circle(spark.x, spark.y, 1.5 * spark.life)
            .fill({ color: spark.color, alpha: spark.life });
        }
      }

      if (showLightning) {
        lightningAccum += dt;
        if (lightningAccum >= 5 * (1.5 - activity * 0.7) * (0.7 + Math.random() * 0.6)) {
          lightningAccum = 0;
          // A jagged chord across the ring: two random points on the rim, joined by a path that
          // wanders off the straight line between them.
          const a0 = Math.random() * Math.PI * 2;
          const a1 = a0 + Math.PI * (0.4 + Math.random() * 0.8);
          const x0 = cx + Math.cos(a0) * baseRadius;
          const y0 = cy + Math.sin(a0) * baseRadius;
          const x1 = cx + Math.cos(a1) * baseRadius;
          const y1 = cy + Math.sin(a1) * baseRadius;
          const points: number[] = [];
          const steps = 12;
          for (let i = 0; i <= steps; i += 1) {
            const t = i / steps;
            // The deviation is largest in the middle and zero at both ends, so the arc stays
            // anchored to the rim.
            const wander = Math.sin(t * Math.PI) * 40;
            points.push(
              x0 + (x1 - x0) * t + (Math.random() - 0.5) * wander,
              y0 + (y1 - y0) * t + (Math.random() - 0.5) * wander,
            );
          }
          bolts.push({
            points,
            alpha: 1,
            decay: 3 + Math.random() * 3,
            color:
              WAVE_CONFIGS[Math.floor(Math.random() * WAVE_CONFIGS.length)]?.color ?? "#ffffff",
          });
          while (bolts.length > 8) bolts.shift();
        }
        for (let i = bolts.length - 1; i >= 0; i -= 1) {
          const bolt = bolts[i];
          if (bolt === undefined) continue;
          bolt.alpha -= bolt.decay * dt;
          if (bolt.alpha <= 0) {
            bolts.splice(i, 1);
            continue;
          }
          // Two passes: a wide soft one and a sharp core, the same glow trick the rings use.
          effectLayer
            .poly(bolt.points, false)
            .stroke({ color: bolt.color, alpha: bolt.alpha * 0.2, width: 6 });
          effectLayer
            .poly(bolt.points, false)
            .stroke({ color: bolt.color, alpha: bolt.alpha, width: 1.5 });
        }
      }

      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        radiusFraction = num(p, "radius", 0.36, 0.1, 0.9);
        speed = num(p, "speed", 1, 0, 4);
        amplitudeScale = num(p, "amplitude", 1, 0, 3);
        reactivity = num(p, "reactivity", 1, 0, 3);
        showAnchor = bool(p, "anchorRing", true);
        showSparkles = bool(p, "sparkles", true);
        showSparks = bool(p, "sparks", true);
        showLightning = bool(p, "lightning", true);
        particleCount = int(p, "particles", 40, 0, 300);
        colorAnchor = colorHex(p, "colorAnchor", "#11111b");
        glowScale = num(p, "glow", 1, 0, 3);
      },
    };
  },
});

export default mainWebCamBorder;
