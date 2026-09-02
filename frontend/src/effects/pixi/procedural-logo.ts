import * as PIXI from "pixi.js";

import { bool, colorHex, int, num } from "../paramUtils";
import { createPixiStage, defineEffect, onFrame } from "../sdk";

/**
 * Procedural Logo
 * ===============
 *
 * A logo mark with no logo in it: overlapping ink stains with hard black outlines, gyroscopic rings
 * tilting in perspective, wavy rings rippling around them, orbiting fluid blobs and a soft
 * under-glow of drifting clouds — all pulsing to the same simulated heartbeat as the `logo` effect.
 *
 * Ported from `procedural-logo.html` in the old `obs-effects` repository.
 *
 * ## What "procedural" means here
 *
 * Nothing in this effect is an image. The whole mark is assembled every frame from circles,
 * ellipses and polygons, which is why it is sharp at any canvas size and why every part of it can
 * react to the beat independently. Its sibling `logo` does the opposite and animates *your* artwork;
 * this one generates a mark that never existed.
 *
 * ## The stains are the interesting part
 *
 * Each ink stain is drawn **twice**: once slightly larger in near-black to lay down an outline, then
 * again in colour on top. Because every stain in the cluster draws its outline before any of them
 * draws its fill, the outlines merge into a single silhouette around the whole group rather than
 * each blob being ringed separately.
 *
 * That two-pass ordering is what makes the cluster read as one screen-printed shape instead of a
 * pile of circles. Each stain also grows three smaller lobes off its edge, so the outline is bulbous
 * rather than round.
 *
 * ## The scope of this port
 *
 * The original had **nineteen** separate drawing subsystems layered on top of each other. This port
 * carries the ones that define the mark: the under-glow clouds, the ink stains, the gyro rings, the
 * wavy rings, the orbiting blobs, the dot grid and the central aura, all on the shared heartbeat.
 *
 * Left out are the text subsystems — the original spelled a word across the mark in five overlapping
 * particle, matrix, mesh and atmosphere layers — along with the toxic ooze and bold pattern layers.
 * Those are a substantial effect in their own right, and `particle-text` in this build already does
 * the particle-lettering idea properly. This file says so rather than quietly shipping two-thirds of
 * something and calling it a port.
 */

/** The Catppuccin palette the rings and blobs are drawn from. */
const PALETTE = ["#cba6f7", "#89b4fa", "#94e2d5", "#89dceb", "#74c7ec", "#b4befe"];

/** The warmer palette used for the ink stains and the under-glow. */
const STAIN_PALETTE = ["#f38ba8", "#eba0ac", "#fab387", "#cba6f7"];

/**
 * How far through the cycle the quieter second beat fires.
 *
 * The interval itself comes from the Heart Rate parameter rather than a constant, so this is the
 * only part of the heartbeat that is fixed. 70 bpm — the `logo` effect's default — is 0.857 seconds.
 */
const DUB_PHASE_RATIO = 0.28;

/** Points around a wavy ring. */
const WAVY_STEPS = 100;

interface Blob {
  angle: number;
  orbitRadius: number;
  size: number;
  speed: number;
  offset: number;
  color: string;
  alpha: number;
}

interface WavyRing {
  r: number;
  amp: number;
  freq: number;
  speed: number;
  color: string;
  alpha: number;
  weight: number;
}

interface GyroRing {
  radius: number;
  color: string;
  speed: number;
  phase: number;
}

interface Cloud {
  x: number;
  y: number;
  radius: number;
  color: string;
  alpha: number;
  driftSpeed: number;
  offset: number;
}

interface Stain {
  x: number;
  y: number;
  radius: number;
  color: string;
}

const proceduralLogo = defineEffect({
  descriptor: {
    id: "procedural-logo",
    name: "Procedural Logo",
    description:
      "A generated logo mark — overlapping ink stains with hard outlines, tilting gyro rings, rippling wavy rings and orbiting blobs, all pulsing to a heartbeat.",
    engine: "pixi",
    category: "overlay",
    tags: ["logo", "procedural", "ink", "rings", "heartbeat", "catppuccin"],
    previewNotes:
      "Nothing here is an image — the whole mark is generated, so it is sharp at any size. Transparent by default. Its sibling Logo animates your own artwork instead. See the file header for which of the original's layers this port carries.",
    params: [
      {
        key: "size",
        label: "Size",
        kind: "number",
        default: 240,
        min: 60,
        max: 800,
        step: 10,
        description: "Radius of the mark in pixels. Everything else is proportioned from it.",
      },
      {
        key: "bpm",
        label: "Heart Rate",
        kind: "number",
        default: 70,
        min: 20,
        max: 200,
        step: 1,
        description: "Beats per minute. Every layer punches on the beat.",
      },
      {
        key: "punch",
        label: "Beat Punch",
        kind: "number",
        default: 1,
        min: 0,
        max: 4,
        step: 0.05,
        description: "How hard the mark reacts to each beat. 0 leaves it breathing but steady.",
      },
      {
        key: "speed",
        label: "Speed",
        kind: "number",
        default: 1,
        min: 0,
        max: 4,
        step: 0.05,
        description: "How fast the rings turn and the blobs orbit.",
      },
      {
        key: "stains",
        label: "Ink Stains",
        kind: "number",
        default: 24,
        min: 0,
        max: 80,
        step: 1,
        description:
          "Overlapping blobs at the centre, drawn with a merged black outline around the whole cluster.",
      },
      {
        key: "outline",
        label: "Outline Width",
        kind: "number",
        default: 4,
        min: 0,
        max: 16,
        step: 0.5,
        description:
          "Thickness of the black crust around the stain cluster. 0 removes it and the stains become soft shapes.",
      },
      {
        key: "blobs",
        label: "Orbiting Blobs",
        kind: "number",
        default: 12,
        min: 0,
        max: 60,
        step: 1,
        description: "Fluid blobs circling the mark, each with a highlight.",
      },
      {
        key: "clouds",
        label: "Under-glow",
        kind: "number",
        default: 6,
        min: 0,
        max: 30,
        step: 1,
        description: "Large soft clouds drifting behind everything.",
      },
      {
        key: "gyroRings",
        label: "Gyro Rings",
        kind: "boolean",
        default: true,
        description:
          "Rings that squash into ellipses as they turn, which reads as a 3D gyroscope without any 3D.",
      },
      {
        key: "wavyRings",
        label: "Wavy Rings",
        kind: "boolean",
        default: true,
        description: "Thick rippling rings at four radii, each at its own frequency and speed.",
      },
      {
        key: "grid",
        label: "Dot Grid",
        kind: "boolean",
        default: true,
        description: "A faint grid of dots behind the mark.",
      },
      {
        key: "colorOutline",
        label: "Outline Colour",
        kind: "color",
        default: "#11111b",
        description: "The crust around the stain cluster.",
      },
      {
        key: "colorAura",
        label: "Aura Colour",
        kind: "color",
        default: "#cba6f7",
        description: "The soft glow at the very centre.",
      },
      {
        key: "background",
        label: "Background",
        kind: "boolean",
        default: false,
        description: "Fill the frame. Off by default so the mark can sit over a scene.",
      },
      {
        key: "backgroundColor",
        label: "Background Colour",
        kind: "color",
        default: "#11111b",
        description: "Only used when Background is on.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    const stage = await createPixiStage(scope, ctx);

    // Back to front. The stain outlines and fills share a layer on purpose — see the header.
    const backdropLayer = stage.stage.addChild(new PIXI.Graphics());
    const gridLayer = stage.stage.addChild(new PIXI.Graphics());
    const cloudLayer = stage.stage.addChild(new PIXI.Graphics());
    const gyroLayer = stage.stage.addChild(new PIXI.Graphics());
    const wavyLayer = stage.stage.addChild(new PIXI.Graphics());
    const stainLayer = stage.stage.addChild(new PIXI.Graphics());
    const blobLayer = stage.stage.addChild(new PIXI.Graphics());
    const auraLayer = stage.stage.addChild(new PIXI.Graphics());

    let logoSize = num(ctx.params, "size", 240, 60, 800);
    let bpm = num(ctx.params, "bpm", 70, 20, 200);
    let punchAmount = num(ctx.params, "punch", 1, 0, 4);
    let speed = num(ctx.params, "speed", 1, 0, 4);
    let stainCount = int(ctx.params, "stains", 24, 0, 80);
    let outlineWidth = num(ctx.params, "outline", 4, 0, 16);
    let blobCount = int(ctx.params, "blobs", 12, 0, 60);
    let cloudCount = int(ctx.params, "clouds", 6, 0, 30);
    let showGyro = bool(ctx.params, "gyroRings", true);
    let showWavy = bool(ctx.params, "wavyRings", true);
    let showGrid = bool(ctx.params, "grid", true);
    let colorOutline = colorHex(ctx.params, "colorOutline", "#11111b");
    let colorAura = colorHex(ctx.params, "colorAura", "#cba6f7");
    let drawBackground = bool(ctx.params, "background", false);
    let backgroundColor = colorHex(ctx.params, "backgroundColor", "#11111b");

    let blobs: Blob[] = [];
    let clouds: Cloud[] = [];
    let stains: Stain[] = [];
    let gyroRings: GyroRing[] = [];
    let wavyRings: WavyRing[] = [];

    const pick = (list: readonly string[]): string =>
      list[Math.floor(Math.random() * list.length)] ?? "#ffffff";

    const seed = (): void => {
      blobs = [];
      for (let i = 0; i < blobCount; i += 1) {
        blobs.push({
          angle: Math.random() * Math.PI * 2,
          orbitRadius: logoSize * 0.7 + Math.random() * 40,
          size: 8 + Math.random() * 20,
          // Half orbit each way, so the ring of blobs never rotates as one body.
          speed: (Math.random() * 0.6 + 0.3) * (Math.random() > 0.5 ? 1 : -1),
          offset: Math.random() * 100,
          color: pick(PALETTE),
          alpha: 0.2 + Math.random() * 0.3,
        });
      }

      clouds = [];
      for (let i = 0; i < cloudCount; i += 1) {
        clouds.push({
          x: (Math.random() - 0.5) * logoSize * 1.2,
          y: (Math.random() - 0.5) * logoSize * 1.2,
          radius: 60 + Math.random() * 60,
          color: pick(STAIN_PALETTE),
          alpha: 0.03 + Math.random() * 0.05,
          driftSpeed: 0.02 + Math.random() * 0.05,
          offset: Math.random() * 100,
        });
      }

      stains = [];
      for (let i = 0; i < stainCount; i += 1) {
        // Squaring the random distance clusters them tightly towards the centre rather than
        // spreading them evenly over the disc — which is what makes it read as one mark.
        const dist = Math.pow(Math.random(), 2) * logoSize * 0.45;
        const angle = Math.random() * Math.PI * 2;
        stains.push({
          x: Math.cos(angle) * dist,
          y: Math.sin(angle) * dist,
          radius: 30 + Math.random() * 20,
          color: pick(STAIN_PALETTE),
        });
      }

      gyroRings = [
        { radius: logoSize * 0.9, color: "#cba6f7", speed: 0.8, phase: 0 },
        { radius: logoSize * 0.75, color: "#74c7ec", speed: -1.2, phase: Math.PI / 3 },
      ];

      wavyRings = [
        {
          r: logoSize * 0.65,
          amp: 8,
          freq: 5,
          speed: 1.0,
          color: "#89b4fa",
          alpha: 0.4,
          weight: 12,
        },
        {
          r: logoSize * 0.7,
          amp: 12,
          freq: 3,
          speed: -0.8,
          color: "#cba6f7",
          alpha: 0.3,
          weight: 8,
        },
        {
          r: logoSize * 0.75,
          amp: 15,
          freq: 7,
          speed: 1.2,
          color: "#94e2d5",
          alpha: 0.25,
          weight: 6,
        },
        {
          r: logoSize * 0.6,
          amp: 6,
          freq: 4,
          speed: -0.5,
          color: "#89dceb",
          alpha: 0.35,
          weight: 10,
        },
      ];
    };

    seed();

    // Reused across frames rather than allocated per ring per frame.
    const wavyPoints = new Float64Array((WAVY_STEPS + 1) * 2);

    let time = 0;
    let beatDecay = 0;

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      const interval = 60 / bpm;
      const previousPhase = time % interval;
      time += dt * speed;
      const phase = time % interval;

      // Lub on the wrap, dub partway through — the same heartbeat the `logo` effect uses.
      if (phase < previousPhase) beatDecay = 1;
      else if (previousPhase < interval * DUB_PHASE_RATIO && phase >= interval * DUB_PHASE_RATIO) {
        beatDecay = Math.max(beatDecay, 0.55);
      }
      beatDecay = Math.max(0, beatDecay - 5.5 * dt);
      const beat = beatDecay * punchAmount;

      const w = stage.width;
      const h = stage.height;
      const cx = w * 0.5;
      const cy = h * 0.5;
      const punch = 1 + beat * 0.2;
      // The whole mark floats and breathes, so the held moments between beats are never static.
      const float = Math.sin(time * 0.8) * 10;

      backdropLayer.clear();
      if (drawBackground) backdropLayer.rect(0, 0, w, h).fill({ color: backgroundColor });

      // ── Dot grid ────────────────────────────────────────────────────────
      gridLayer.clear();
      if (showGrid) {
        const spacing = 40;
        const offset = (time * 6) % spacing;
        for (let y = offset; y < h; y += spacing) {
          for (let x = offset; x < w; x += spacing) {
            gridLayer.circle(x, y, 1);
          }
        }
        gridLayer.fill({ color: "#b4befe", alpha: 0.06 });
      }

      // ── Under-glow ──────────────────────────────────────────────────────
      cloudLayer.clear();
      for (const cloud of clouds) {
        const x = cx + cloud.x + Math.sin(time * cloud.driftSpeed + cloud.offset) * 60;
        const y =
          cy + float + cloud.y + Math.cos(time * cloud.driftSpeed * 0.7 + cloud.offset) * 60;
        cloudLayer
          .circle(x, y, cloud.radius * punch)
          .fill({ color: cloud.color, alpha: cloud.alpha });
      }

      // ── Gyro rings ──────────────────────────────────────────────────────
      gyroLayer.clear();
      if (showGyro) {
        for (const ring of gyroRings) {
          const rotation = time * ring.speed + ring.phase;
          // The ellipse's vertical radius is driven by a cosine of the rotation, so the ring
          // flattens to a line and opens out again — a 3D tilt with no 3D anywhere.
          const aspect = Math.abs(Math.cos(rotation * 0.5));
          const radius = ring.radius * punch;

          gyroLayer.ellipse(cx, cy + float, radius, radius * aspect).stroke({
            color: ring.color,
            width: 4 + beat * 4,
            alpha: 0.4 + aspect * 0.4,
          });

          // Four nodes riding the ring, which is what gives it a mechanical read.
          for (let i = 0; i < 4; i += 1) {
            const angle = rotation + (i * Math.PI * 2) / 4;
            gyroLayer.circle(
              cx + Math.cos(angle) * radius,
              cy + float + Math.sin(angle) * radius * aspect,
              4 + beat * 2,
            );
          }
          gyroLayer.fill({ color: ring.color, alpha: 0.8 });
        }
      }

      // ── Wavy rings ──────────────────────────────────────────────────────
      wavyLayer.clear();
      if (showWavy) {
        const beatRadius = beat * 10;
        for (const ring of wavyRings) {
          const ringPhase = time * ring.speed;
          const amp = ring.amp * (1 + beat * 1.5);
          for (let i = 0; i <= WAVY_STEPS; i += 1) {
            const angle = (i / WAVY_STEPS) * Math.PI * 2;
            const r = ring.r + Math.sin(angle * ring.freq + ringPhase) * amp + beatRadius;
            wavyPoints[i * 2] = cx + Math.cos(angle) * r;
            wavyPoints[i * 2 + 1] = cy + float + Math.sin(angle) * r;
          }
          wavyLayer
            .poly(Array.from(wavyPoints))
            .stroke({ color: ring.color, width: ring.weight, alpha: ring.alpha, cap: "round" });
        }
      }

      // ── Ink stains, in two passes ───────────────────────────────────────
      stainLayer.clear();
      if (stains.length > 0) {
        // Positions are cached between the two passes so the drift trig is not repeated.
        const px: number[] = [];
        const py: number[] = [];
        const pr: number[] = [];

        // Pass 1: every outline first, so they merge into one silhouette around the cluster.
        if (outlineWidth > 0) {
          for (const stain of stains) {
            const x = cx + stain.x + Math.sin(time * 0.3 + stain.radius) * 12;
            const y = cy + float + stain.y + Math.cos(time * 0.25 + stain.x) * 12;
            const r = stain.radius * punch;
            px.push(x);
            py.push(y);
            pr.push(r);

            stainLayer.circle(x, y, r + outlineWidth);
            // Three lobes off the edge, which is what makes the outline bulbous rather than round.
            for (let j = 0; j < 3; j += 1) {
              const angle = (j * Math.PI * 2) / 3 + stain.radius;
              stainLayer.circle(
                x + Math.cos(angle) * (r * 0.5),
                y + Math.sin(angle) * (r * 0.5),
                r * 0.75 + outlineWidth,
              );
            }
          }
          stainLayer.fill({ color: colorOutline, alpha: 1 });
        } else {
          for (const stain of stains) {
            px.push(cx + stain.x + Math.sin(time * 0.3 + stain.radius) * 12);
            py.push(cy + float + stain.y + Math.cos(time * 0.25 + stain.x) * 12);
            pr.push(stain.radius * punch);
          }
        }

        // Pass 2: the colour, inside the silhouette laid down above.
        for (let i = 0; i < stains.length; i += 1) {
          const stain = stains[i];
          const x = px[i];
          const y = py[i];
          const r = pr[i];
          if (stain === undefined || x === undefined || y === undefined || r === undefined)
            continue;

          stainLayer.circle(x, y, r);
          for (let j = 0; j < 3; j += 1) {
            const angle = (j * Math.PI * 2) / 3 + stain.radius;
            stainLayer.circle(
              x + Math.cos(angle) * (r * 0.5),
              y + Math.sin(angle) * (r * 0.5),
              r * 0.75,
            );
          }
          stainLayer.fill({ color: stain.color, alpha: 1 });
        }
      }

      // ── Orbiting blobs ──────────────────────────────────────────────────
      blobLayer.clear();
      for (const blob of blobs) {
        blob.angle += blob.speed * (1 + beat * 0.5) * dt;
        const wobble = Math.sin(time * 2 + blob.offset) * 20;
        const r = blob.orbitRadius + wobble + beat * 30;
        const x = cx + Math.cos(blob.angle) * r;
        const y = cy + float + Math.sin(blob.angle) * r;
        const alpha = blob.alpha * (0.8 + 0.2 * Math.sin(time + blob.offset));
        const size = blob.size * (1 + beat * 0.2);

        blobLayer.circle(x, y, size).fill({ color: blob.color, alpha });
        // An off-centre white dot, which is the whole of the "fluid" read — it says the blob is a
        // sphere catching a light rather than a flat disc.
        blobLayer
          .circle(x - size * 0.3, y - size * 0.3, size * 0.2)
          .fill({ color: "#ffffff", alpha: alpha * 0.6 });
      }

      // ── Central aura ────────────────────────────────────────────────────
      auraLayer.clear();
      auraLayer
        .circle(cx, cy + float, logoSize * 0.4 * (1 + beat * 0.15))
        .fill({ color: colorAura, alpha: 0.05 * (1 + beat * 0.15) });

      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        const before = [logoSize, stainCount, blobCount, cloudCount].join("|");

        logoSize = num(p, "size", 240, 60, 800);
        bpm = num(p, "bpm", 70, 20, 200);
        punchAmount = num(p, "punch", 1, 0, 4);
        speed = num(p, "speed", 1, 0, 4);
        stainCount = int(p, "stains", 24, 0, 80);
        outlineWidth = num(p, "outline", 4, 0, 16);
        blobCount = int(p, "blobs", 12, 0, 60);
        cloudCount = int(p, "clouds", 6, 0, 30);
        showGyro = bool(p, "gyroRings", true);
        showWavy = bool(p, "wavyRings", true);
        showGrid = bool(p, "grid", true);
        colorOutline = colorHex(p, "colorOutline", "#11111b");
        colorAura = colorHex(p, "colorAura", "#cba6f7");
        drawBackground = bool(p, "background", false);
        backgroundColor = colorHex(p, "backgroundColor", "#11111b");

        // Size and the four counts define where things are; everything else is read each frame.
        if ([logoSize, stainCount, blobCount, cloudCount].join("|") !== before) seed();
      },
    };
  },
});

export default proceduralLogo;
