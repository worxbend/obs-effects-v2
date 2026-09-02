import * as PIXI from "pixi.js";

import { bool, colorHex, int, num, str } from "../paramUtils";
import { createPixiStage, defineEffect, onFrame, useFont } from "../sdk";

/**
 * Particle Text
 * =============
 *
 * A word spelled out in particles that fly in from scattered positions, settle into the lettering,
 * and are then constantly disturbed — by comets crossing the frame that attract or repel them, and by
 * their own jitter. Short lines connect nearby particles into a shifting plexus. Behind it all, a
 * drifting grid, slow wireframe shapes and ambient motes.
 *
 * Ported from `worxbend-text.html` in the old `obs-effects` repository.
 *
 * ## Five layers, and why they are separate
 *
 * Background grid, wireframe shapes and comet trails go on one `Graphics`; the plexus lines on
 * another; the particles themselves on a third. The split is not decoration — the plexus has to sit
 * *behind* the particles so the dots read as nodes rather than as beads on a string, and comet trails
 * have to sit behind everything so they pass under the word rather than over it.
 *
 * ## The comets are the effect
 *
 * Two comets cross the frame at any time and each is randomly either an **attractor** or a
 * **repeller**, decided when it spawns. An attractor drags the lettering towards it as it passes and
 * the word stretches after it; a repeller shoves a hole through it. When the comet leaves, the spring
 * pulls everything home.
 *
 * That randomness is why the effect never settles into a loop: the same word is pulled apart
 * differently every twenty seconds or so, and you cannot predict which way.
 *
 * ## What changed from the original
 *
 * The original moved particles towards the **mouse pointer** as well. An OBS browser source has no
 * cursor over it, so that force is gone rather than left permanently pointing at (-9999, -9999) — the
 * comets do the same job and do it unattended.
 *
 * Everything else is the original's arithmetic, with the per-frame forces converted to per-second so
 * the word settles at the same rate whatever the frame rate.
 */

/** The Catppuccin palette the particles cycle through. */
const DEFAULT_COLORS = [
  "#cba6f7",
  "#74c7ec",
  "#94e2d5",
  "#fab387",
  "#f5c2e7",
  "#a6e3a1",
  "#89dceb",
  "#b4befe",
  "#f9e2af",
  "#f38ba8",
];

/** How hard a text particle is pulled home. */
const RETURN_FORCE = 0.04;

/** Velocity retained per 60fps step. */
const FRICTION = 0.94;

/** How far apart two particles can be and still be joined by a plexus line. */
const PLEXUS_DIST = 45;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  homeX: number;
  homeY: number;
  color: string;
  radius: number;
  alpha: number;
}

interface Mote {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  radius: number;
  alpha: number;
}

interface Shape {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  rot: number;
  vRot: number;
  sides: number;
  color: string;
  alpha: number;
}

interface Comet {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  size: number;
  history: { x: number; y: number }[];
  /** Decided at spawn: attractors pull the lettering, repellers push it. */
  isAttractor: boolean;
}

const particleText = defineEffect({
  descriptor: {
    id: "particle-text",
    name: "Particle Text",
    description:
      "A word in particles that settle into shape and are then pulled apart by comets crossing the frame, with a shifting plexus of connecting lines.",
    engine: "pixi",
    category: "background",
    tags: ["text", "particles", "plexus", "comets", "catppuccin"],
    previewNotes:
      "Set Text to your own wording. The comets are what make it interesting — each is randomly an attractor or a repeller, so the word is pulled apart differently every time one crosses. Uses the bundled Silkscreen font.",
    params: [
      {
        key: "text",
        label: "Text",
        kind: "text",
        default: "YOUR TEXT",
        description:
          "The word to spell out. It is auto-shrunk to fit three-quarters of the frame width.",
      },
      {
        key: "fontFamily",
        label: "Font",
        kind: "text",
        default: "Silkscreen, sans-serif",
        description: "A CSS font family. Silkscreen is bundled with the application.",
      },
      {
        key: "density",
        label: "Density",
        kind: "number",
        default: 8,
        min: 3,
        max: 24,
        step: 1,
        description:
          "Pixels between particles. The main performance control — the plexus cost grows with it too.",
      },
      {
        key: "comets",
        label: "Comets",
        kind: "number",
        default: 2,
        min: 0,
        max: 12,
        step: 1,
        description:
          "How many cross the frame at once. 0 leaves the word to settle and only jitter. Each is randomly an attractor or a repeller.",
      },
      {
        key: "cometStrength",
        label: "Comet Force",
        kind: "number",
        default: 0.8,
        min: 0,
        max: 4,
        step: 0.05,
        description: "How hard a comet pulls or pushes the lettering as it passes.",
      },
      {
        key: "jitter",
        label: "Jitter",
        kind: "number",
        default: 0.4,
        min: 0,
        max: 3,
        step: 0.05,
        description:
          "Constant random nudge on every particle, so the word is never perfectly still.",
      },
      {
        key: "plexus",
        label: "Plexus Lines",
        kind: "boolean",
        default: true,
        description:
          "Short lines joining nearby particles. Off is noticeably cheaper and leaves a cleaner dot field.",
      },
      {
        key: "grid",
        label: "Background Grid",
        kind: "boolean",
        default: true,
        description: "The slowly drifting grid behind everything.",
      },
      {
        key: "shapes",
        label: "Wireframe Shapes",
        kind: "number",
        default: 12,
        min: 0,
        max: 60,
        step: 1,
        description: "Slow rotating triangles and squares drifting in the background.",
      },
      {
        key: "motes",
        label: "Ambient Motes",
        kind: "number",
        default: 80,
        min: 0,
        max: 500,
        step: 10,
        description: "Loose specks drifting behind the word.",
      },
      {
        key: "colorCycle",
        label: "Colour Cycle",
        kind: "number",
        default: 0.4,
        min: 0,
        max: 3,
        step: 0.05,
        description:
          "How fast the palette sweeps across the lettering. 0 freezes each particle on its own colour.",
      },
      {
        key: "background",
        label: "Background",
        kind: "boolean",
        default: true,
        description: "Fill the frame behind everything.",
      },
      {
        key: "backgroundColor",
        label: "Background Colour",
        kind: "color",
        default: "#11111b",
        description: "Only used when Background is on.",
      },
      {
        key: "gridColor",
        label: "Grid Colour",
        kind: "color",
        default: "#313244",
        description: "The drifting background grid.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    let fontFamily = str(ctx.params, "fontFamily", "Silkscreen, sans-serif");

    // The text is measured to auto-fit and then rasterised, so a substituted font would both size
    // and place every particle wrongly.
    await useFont(`350px ${fontFamily}`);
    scope.checkpoint();

    const stage = await createPixiStage(scope, ctx);

    const backdropLayer = stage.stage.addChild(new PIXI.Graphics());
    const plexusLayer = stage.stage.addChild(new PIXI.Graphics());
    const particleLayer = stage.stage.addChild(new PIXI.Graphics());

    let text = str(ctx.params, "text", "YOUR TEXT");
    let density = int(ctx.params, "density", 8, 3, 24);
    let cometCount = int(ctx.params, "comets", 2, 0, 12);
    let cometStrength = num(ctx.params, "cometStrength", 0.8, 0, 4);
    let jitter = num(ctx.params, "jitter", 0.4, 0, 3);
    let showPlexus = bool(ctx.params, "plexus", true);
    let showGrid = bool(ctx.params, "grid", true);
    let shapeCount = int(ctx.params, "shapes", 12, 0, 60);
    let moteCount = int(ctx.params, "motes", 80, 0, 500);
    let colorCycle = num(ctx.params, "colorCycle", 0.4, 0, 3);
    let drawBackground = bool(ctx.params, "background", true);
    let backgroundColor = colorHex(ctx.params, "backgroundColor", "#11111b");
    let gridColor = colorHex(ctx.params, "gridColor", "#313244");

    const palette = DEFAULT_COLORS;
    const randomColor = (): string =>
      palette[Math.floor(Math.random() * palette.length)] ?? "#ffffff";

    let particles: Particle[] = [];
    let motes: Mote[] = [];
    let shapes: Shape[] = [];
    let comets: Comet[] = [];

    /** Blends two `#rrggbb` strings. */
    const mixHex = (a: string, b: string, t: number): string => {
      const parse = (hex: string): [number, number, number] => [
        parseInt(hex.slice(1, 3), 16),
        parseInt(hex.slice(3, 5), 16),
        parseInt(hex.slice(5, 7), 16),
      ];
      const [r1, g1, b1] = parse(a);
      const [r2, g2, b2] = parse(b);
      const to = (v: number): string => Math.round(v).toString(16).padStart(2, "0");
      return `#${to(r1 + (r2 - r1) * t)}${to(g1 + (g2 - g1) * t)}${to(b1 + (b2 - b1) * t)}`;
    };

    /** Samples the palette continuously, wrapping. */
    const paletteAt = (value: number): string => {
      const n = palette.length;
      const index = ((value % n) + n) % n;
      const i = Math.floor(index);
      return mixHex(palette[i] ?? "#ffffff", palette[(i + 1) % n] ?? "#ffffff", index - i);
    };

    /** A comet entering from a random edge, heading across. */
    const spawnComet = (): Comet => {
      const w = stage.width;
      const h = stage.height;
      const side = Math.floor(Math.random() * 4);
      const speed = 4 + Math.random() * 6;
      let x: number;
      let y: number;
      let vx: number;
      let vy: number;

      if (side === 0) {
        [x, y, vx, vy] = [Math.random() * w, -50, (Math.random() - 0.5) * 2, speed];
      } else if (side === 1) {
        [x, y, vx, vy] = [Math.random() * w, h + 50, (Math.random() - 0.5) * 2, -speed];
      } else if (side === 2) {
        [x, y, vx, vy] = [-50, Math.random() * h, speed, (Math.random() - 0.5) * 2];
      } else {
        [x, y, vx, vy] = [w + 50, Math.random() * h, -speed, (Math.random() - 0.5) * 2];
      }

      return {
        x,
        y,
        vx,
        vy,
        color: randomColor(),
        size: 2 + Math.random() * 3,
        history: [],
        // The coin flip that makes each pass different.
        isAttractor: Math.random() > 0.5,
      };
    };

    /** Rasterises the word and turns its bright pixels into tethered particles. */
    const build = (): void => {
      const w = Math.max(1, Math.round(stage.width));
      const h = Math.max(1, Math.round(stage.height));

      particles = [];
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const context = canvas.getContext("2d", { willReadFrequently: true });

      if (context !== null) {
        // Start large and shrink to fit, rather than guessing a size — the word can be any length.
        let fontSize = 350;
        context.font = `bold ${fontSize}px ${fontFamily}`;
        const measured = context.measureText(text).width;
        const maxWidth = w * 0.75;
        if (measured > maxWidth && measured > 0) {
          fontSize = Math.floor(fontSize * (maxWidth / measured));
          context.font = `bold ${fontSize}px ${fontFamily}`;
        }

        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillStyle = "white";
        context.fillText(text, w / 2, h / 2);

        const pixels = context.getImageData(0, 0, w, h).data;
        for (let y = 0; y < h; y += density) {
          for (let x = 0; x < w; x += density) {
            if ((pixels[(y * w + x) * 4] ?? 0) > 128) {
              particles.push({
                // Scattered up to 100px from home, so the word assembles itself on the first frames
                // rather than simply appearing.
                x: x + (Math.random() - 0.5) * 200,
                y: y + (Math.random() - 0.5) * 200,
                vx: 0,
                vy: 0,
                homeX: x,
                homeY: y,
                color: "#ffffff",
                radius: 0.5 + Math.random(),
                alpha: 0.7 + Math.random() * 0.3,
              });
            }
          }
        }
        canvas.width = 1;
        canvas.height = 1;
      }

      motes = [];
      for (let i = 0; i < moteCount; i += 1) {
        motes.push({
          x: Math.random() * w,
          y: Math.random() * h,
          vx: (Math.random() - 0.5) * 0.4,
          vy: (Math.random() - 0.5) * 0.4,
          color: randomColor(),
          radius: 0.5 + Math.random() * 1.5,
          alpha: 0.1 + Math.random() * 0.2,
        });
      }

      shapes = [];
      for (let i = 0; i < shapeCount; i += 1) {
        shapes.push({
          x: Math.random() * w,
          y: Math.random() * h,
          vx: (Math.random() - 0.5) * 0.3,
          vy: (Math.random() - 0.5) * 0.3,
          size: 20 + Math.random() * 40,
          rot: Math.random() * Math.PI * 2,
          vRot: (Math.random() - 0.5) * 0.02,
          sides: Math.random() > 0.5 ? 3 : 4,
          color: randomColor(),
          alpha: 0.03 + Math.random() * 0.05,
        });
      }

      comets = [];
      for (let i = 0; i < cometCount; i += 1) comets.push(spawnComet());
    };

    build();
    stage.onResize(build);

    let time = 0;

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      time += dt;
      // The original applied its forces once per frame at 60 fps.
      const step = Math.min(dt * 60, 3);
      const w = stage.width;
      const h = stage.height;

      backdropLayer.clear();
      plexusLayer.clear();
      particleLayer.clear();

      if (drawBackground) backdropLayer.rect(0, 0, w, h).fill({ color: backgroundColor });

      // ── Grid ────────────────────────────────────────────────────────────
      if (showGrid) {
        const spacing = 60;
        const offset = (time * 20) % spacing;
        for (let x = offset; x < w; x += spacing) backdropLayer.moveTo(x, 0).lineTo(x, h);
        for (let y = offset; y < h; y += spacing) backdropLayer.moveTo(0, y).lineTo(w, y);
        backdropLayer.stroke({ color: gridColor, width: 1, alpha: 0.15 });
      }

      // ── Wireframe shapes ────────────────────────────────────────────────
      for (const shape of shapes) {
        shape.x += shape.vx * step;
        shape.y += shape.vy * step;
        shape.rot += shape.vRot * step;
        if (shape.x < -shape.size) shape.x = w + shape.size;
        if (shape.x > w + shape.size) shape.x = -shape.size;
        if (shape.y < -shape.size) shape.y = h + shape.size;
        if (shape.y > h + shape.size) shape.y = -shape.size;

        // A square is rotated an eighth of a turn so it sits flat rather than on a corner.
        const twist = shape.sides === 4 ? Math.PI / 4 : 0;
        for (let i = 0; i < shape.sides; i += 1) {
          const angle = shape.rot + (i * Math.PI * 2) / shape.sides + twist;
          const px = shape.x + Math.cos(angle) * shape.size;
          const py = shape.y + Math.sin(angle) * shape.size;
          if (i === 0) backdropLayer.moveTo(px, py);
          else backdropLayer.lineTo(px, py);
        }
        backdropLayer.closePath().stroke({ color: shape.color, width: 2, alpha: shape.alpha });
      }

      // ── Comets ──────────────────────────────────────────────────────────
      for (let i = 0; i < comets.length; i += 1) {
        const comet = comets[i];
        if (comet === undefined) continue;
        comet.x += comet.vx * step;
        comet.y += comet.vy * step;

        comet.history.push({ x: comet.x, y: comet.y });
        if (comet.history.length > 20) comet.history.shift();

        // The trail: each segment thinner and fainter than the one in front of it.
        for (let j = 1; j < comet.history.length; j += 1) {
          const previous = comet.history[j - 1];
          const point = comet.history[j];
          if (previous === undefined || point === undefined) continue;
          const ratio = j / comet.history.length;
          backdropLayer
            .moveTo(previous.x, previous.y)
            .lineTo(point.x, point.y)
            .stroke({ color: comet.color, width: comet.size * ratio, alpha: ratio * 0.3 });
        }

        backdropLayer.circle(comet.x, comet.y, comet.size).fill({ color: comet.color, alpha: 0.9 });

        // Respawn once it is well clear of the frame.
        if (comet.x < -200 || comet.x > w + 200 || comet.y < -200 || comet.y > h + 200) {
          comets[i] = spawnComet();
        }
      }

      // ── Ambient motes ───────────────────────────────────────────────────
      for (const mote of motes) {
        mote.x += mote.vx * step;
        mote.y += mote.vy * step;
        if (mote.x < 0) mote.x = w;
        if (mote.x > w) mote.x = 0;
        if (mote.y < 0) mote.y = h;
        if (mote.y > h) mote.y = 0;
        particleLayer
          .circle(mote.x, mote.y, mote.radius)
          .fill({ color: mote.color, alpha: mote.alpha });
      }

      // ── The lettering ───────────────────────────────────────────────────
      const friction = Math.pow(FRICTION, step);

      for (let i = 0; i < particles.length; i += 1) {
        const p = particles[i];
        if (p === undefined) continue;

        // Spring home.
        p.vx += (p.homeX - p.x) * RETURN_FORCE * step;
        p.vy += (p.homeY - p.y) * RETURN_FORCE * step;

        for (const comet of comets) {
          const dx = p.x - comet.x;
          const dy = p.y - comet.y;
          const distSq = dx * dx + dy * dy;
          // An attractor reaches further than a repeller: a wide gentle pull reads as gravity, a
          // tight hard shove reads as an impact.
          const radius = comet.isAttractor ? 150 : 70;
          if (distSq < radius * radius && distSq > 0.001) {
            const dist = Math.sqrt(distSq);
            const force = (1 - dist / radius) * cometStrength * step * 5;
            const sign = comet.isAttractor ? -1 : 1;
            p.vx += (dx / dist) * force * sign;
            p.vy += (dy / dist) * force * sign;
          }
        }

        p.vx += (Math.random() - 0.5) * jitter * step;
        p.vy += (Math.random() - 0.5) * jitter * step;
        p.vx *= friction;
        p.vy *= friction;
        p.x += p.vx * step;
        p.y += p.vy * step;

        // Colour comes from the particle's *home* position, not where it currently is — so the
        // palette sweep stays fixed to the lettering while the particles move through it.
        p.color = paletteAt((p.homeX + p.homeY) * 0.0012 + time * colorCycle);

        particleLayer.circle(p.x, p.y, p.radius).fill({ color: p.color, alpha: p.alpha });

        // ── Plexus ────────────────────────────────────────────────────────
        // Only the next 25 particles are considered rather than all of them. Because the list is
        // built in scan order, near-in-index means near-in-space, so this catches almost every real
        // neighbour at a fraction of the cost of checking every pair.
        if (showPlexus) {
          const limit = Math.min(i + 25, particles.length);
          for (let j = i + 1; j < limit; j += 1) {
            const other = particles[j];
            if (other === undefined) continue;
            const dx = p.x - other.x;
            const dy = p.y - other.y;
            const distSq = dx * dx + dy * dy;
            if (distSq < PLEXUS_DIST * PLEXUS_DIST) {
              const alpha = (1 - Math.sqrt(distSq) / PLEXUS_DIST) * 0.15;
              plexusLayer
                .moveTo(p.x, p.y)
                .lineTo(other.x, other.y)
                .stroke({ color: p.color, width: 1, alpha });
            }
          }
        }
      }

      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        const before = [text, fontFamily, density, shapeCount, moteCount, cometCount].join("|");

        text = str(p, "text", "YOUR TEXT");
        fontFamily = str(p, "fontFamily", "Silkscreen, sans-serif");
        density = int(p, "density", 8, 3, 24);
        cometCount = int(p, "comets", 2, 0, 12);
        cometStrength = num(p, "cometStrength", 0.8, 0, 4);
        jitter = num(p, "jitter", 0.4, 0, 3);
        showPlexus = bool(p, "plexus", true);
        showGrid = bool(p, "grid", true);
        shapeCount = int(p, "shapes", 12, 0, 60);
        moteCount = int(p, "motes", 80, 0, 500);
        colorCycle = num(p, "colorCycle", 0.4, 0, 3);
        drawBackground = bool(p, "background", true);
        backgroundColor = colorHex(p, "backgroundColor", "#11111b");
        gridColor = colorHex(p, "gridColor", "#313244");

        if ([text, fontFamily, density, shapeCount, moteCount, cometCount].join("|") !== before) {
          build();
        }
      },
    };
  },
});

export default particleText;
