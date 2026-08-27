import * as PIXI from "pixi.js";

import { bool, colorHex, int, num, str } from "../paramUtils";
import { createPixiStage, defineEffect, onFrame, useFont } from "../sdk";

/**
 * Starting Soon Fluid
 * ===================
 *
 * Words spelled out in particles that swell and shimmer as if suspended in liquid, while a cloud of
 * background particles drifts through and pushes them apart on contact.
 *
 * Ported from `starting-soon-fluid.html` in the old `obs-effects` repository.
 *
 * ## The text is not text
 *
 * The words are rendered once into an offscreen canvas, and every bright pixel on a 7-pixel grid
 * becomes a particle that remembers where it came from. After that there is no text — only points
 * tethered to home positions. That is what lets the letters be pushed around and spring back, and
 * why you can set Text to anything and it still works.
 *
 * The same technique as `cat-mesh`, which samples an image instead of a font.
 *
 * ## Two kinds of particle, two behaviours
 *
 * **Text particles** are tethered: every frame they are pulled back towards home, offset by a slow
 * swell across the whole field and a per-particle shimmer. They never wander, they hover.
 *
 * **Background particles** are free: pushed by a slow flow field and wrapped at the edges. They have
 * no home and are what makes the scene feel like a current rather than a still image.
 *
 * The two are pushed apart on contact, but *only across the groups* — text particles ignore each
 * other. Without that exception the letters would blow themselves apart, since neighbouring
 * particles in a stroke are by definition touching.
 *
 * ## Why there is a spatial hash
 *
 * Naively, mutual repulsion is every particle against every other: with a few thousand particles
 * that is millions of distance checks per frame and the effect would be unusable. The hash buckets
 * particles into a grid of cells and only compares against the nine cells around each one, which
 * turns the cost from quadratic into roughly linear.
 */

/** Grid step when sampling the rendered text. Smaller is denser and quadratically more work. */
const TEXT_STEP = 7;

/** How hard a text particle is pulled back to its home position, per frame at 60 fps. */
const RETURN_FORCE = 0.2;

/** Velocity retained each frame. Below 1 or the simulation never settles. */
const DAMPING = 0.85;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  homeX: number;
  homeY: number;
  radius: number;
  alpha: number;
  color: string;
  isText: boolean;
  /** A fixed per-particle offset, so the shimmer is not in lockstep. */
  seed: number;
}

/**
 * Buckets particles into grid cells so each one only has to be compared with its neighbours.
 *
 * Deliberately a plain `Map` keyed by a string rather than anything cleverer: at these particle
 * counts the hashing is not the bottleneck, and this is far easier to read than a packed array.
 */
class SpatialHash {
  private readonly cells = new Map<string, Particle[]>();

  constructor(private readonly cellSize: number) {}

  clear(): void {
    this.cells.clear();
  }

  insert(p: Particle): void {
    const key = this.keyFor(p.x, p.y);
    const bucket = this.cells.get(key);
    if (bucket === undefined) this.cells.set(key, [p]);
    else bucket.push(p);
  }

  /**
   * Calls `visit` for everything in the nine cells around `p`.
   *
   * A callback rather than a returned array, and that is a real difference rather than a style
   * preference. Collecting the neighbours into a list first means copying every particle reference
   * nine times over, every frame — at a few thousand particles that array churn measured as a third
   * of this effect's entire frame time. Walking the buckets in place copies nothing.
   */
  forEachNeighbour(p: Particle, visit: (other: Particle) => void): void {
    const cx = Math.floor(p.x / this.cellSize);
    const cy = Math.floor(p.y / this.cellSize);
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const bucket = this.cells.get(`${cx + dx},${cy + dy}`);
        if (bucket === undefined) continue;
        for (let i = 0; i < bucket.length; i += 1) {
          const other = bucket[i];
          if (other !== undefined) visit(other);
        }
      }
    }
  }

  private keyFor(x: number, y: number): string {
    return `${Math.floor(x / this.cellSize)},${Math.floor(y / this.cellSize)}`;
  }
}

const startingSoonFluid = defineEffect({
  descriptor: {
    id: "starting-soon-fluid",
    name: "Starting Soon Fluid",
    description:
      "Words spelled out in particles suspended in liquid — they swell, shimmer and are pushed aside by a drifting cloud of background particles, then spring back.",
    engine: "pixi",
    category: "background",
    tags: ["starting-soon", "particles", "fluid", "text", "background"],
    previewNotes:
      "A starting-soon screen. Set Text to your own wording — two lines, separated by a slash. The particle counts are the performance controls: Text Density especially, since halving it quadruples the particle count.",
    params: [
      {
        key: "text",
        label: "Text",
        kind: "text",
        default: "STARTING / SOON",
        description:
          "The words to spell out. A slash starts a new line. Anything the font can draw works, including a single long word.",
      },
      {
        key: "fontFamily",
        label: "Font",
        kind: "text",
        default: "Silkscreen, sans-serif",
        description: "A CSS font family. Silkscreen is bundled with the application.",
      },
      {
        key: "fontSize",
        label: "Font Size",
        kind: "number",
        default: 320,
        min: 40,
        max: 600,
        step: 10,
        description: "Height of the lettering in pixels, before particles are sampled from it.",
      },
      {
        key: "textDensity",
        label: "Text Density",
        kind: "number",
        default: 7,
        min: 3,
        max: 24,
        step: 1,
        description:
          "Pixels between text particles. This is the main performance control — 4 is roughly three times the particles of 7.",
      },
      {
        key: "backgroundParticles",
        label: "Background Particles",
        kind: "number",
        default: 1300,
        min: 0,
        max: 5000,
        step: 50,
        description: "The drifting cloud that pushes the letters around. 0 leaves the text still.",
      },
      {
        key: "swell",
        label: "Swell",
        kind: "number",
        default: 6,
        min: 0,
        max: 40,
        step: 0.5,
        description:
          "How far a slow wave moves the whole word, in pixels. This is the liquid-suspension feel.",
      },
      {
        key: "shimmer",
        label: "Shimmer",
        kind: "number",
        default: 1,
        min: 0,
        max: 10,
        step: 0.1,
        description: "Per-particle jitter on top of the swell, in pixels.",
      },
      {
        key: "repulsion",
        label: "Repulsion",
        kind: "number",
        default: 0.6,
        min: 0,
        max: 3,
        step: 0.05,
        description:
          "How hard background particles shove the letters aside. 0 lets them pass straight through.",
      },
      {
        key: "colorText",
        label: "Text Colour",
        kind: "color",
        default: "#ff4500",
        description: "The particles that form the words.",
      },
      {
        key: "colorFlow",
        label: "Flow Colour",
        kind: "color",
        default: "#0077ff",
        description: "Most of the drifting background particles.",
      },
      {
        key: "colorDeep",
        label: "Deep Colour",
        kind: "color",
        default: "#001a33",
        description: "The remaining third of the background particles, for depth.",
      },
      {
        key: "background",
        label: "Background",
        kind: "boolean",
        default: true,
        description: "Fill the frame behind the particles.",
      },
      {
        key: "backgroundColor",
        label: "Background Colour",
        kind: "color",
        default: "#000308",
        description: "Only used when Background is on.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    let fontFamily = str(ctx.params, "fontFamily", "Silkscreen, sans-serif");
    let fontSize = num(ctx.params, "fontSize", 320, 40, 600);

    // The text is measured and rasterised, so the font must be ready or the sampled shape is the
    // fallback font's and every particle lands in the wrong place.
    await useFont(`${fontSize}px ${fontFamily}`);
    scope.checkpoint();

    const stage = await createPixiStage(scope, ctx);

    const backgroundLayer = stage.stage.addChild(new PIXI.Graphics());
    const particleLayer = stage.stage.addChild(new PIXI.Graphics());

    let text = str(ctx.params, "text", "STARTING / SOON");
    let textStep = int(ctx.params, "textDensity", TEXT_STEP, 3, 24);
    let backgroundCount = int(ctx.params, "backgroundParticles", 1300, 0, 5000);
    let swell = num(ctx.params, "swell", 6, 0, 40);
    let shimmer = num(ctx.params, "shimmer", 1, 0, 10);
    let repulsion = num(ctx.params, "repulsion", 0.6, 0, 3);
    let colorText = colorHex(ctx.params, "colorText", "#ff4500");
    let colorFlow = colorHex(ctx.params, "colorFlow", "#0077ff");
    let colorDeep = colorHex(ctx.params, "colorDeep", "#001a33");
    let drawBackground = bool(ctx.params, "background", true);
    let backgroundColor = colorHex(ctx.params, "backgroundColor", "#000308");

    let particles: Particle[] = [];
    const hash = new SpatialHash(35);

    /** Rasterises the text and turns its bright pixels into tethered particles. */
    const build = (): void => {
      const w = Math.max(1, Math.round(stage.width));
      const h = Math.max(1, Math.round(stage.height));

      particles = [];

      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const context = canvas.getContext("2d", { willReadFrequently: true });

      if (context !== null) {
        const lines = text.split("/").map((line) => line.trim());
        context.font = `bold ${fontSize}px ${fontFamily}`;
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillStyle = "white";

        // Lines are stacked around the centre, so one line sits centred and two straddle it.
        const spacing = fontSize * 0.9;
        const top = h / 2 - ((lines.length - 1) * spacing) / 2;
        for (let i = 0; i < lines.length; i += 1) {
          context.fillText(lines[i] ?? "", w / 2, top + i * spacing);
        }

        const pixels = context.getImageData(0, 0, w, h).data;
        for (let y = 0; y < h; y += textStep) {
          for (let x = 0; x < w; x += textStep) {
            if ((pixels[(y * w + x) * 4] ?? 0) > 128) {
              particles.push({
                x,
                y,
                vx: 0,
                vy: 0,
                homeX: x,
                homeY: y,
                radius: 3.5 + Math.random() * 2.5,
                alpha: 0.95 + Math.random() * 0.05,
                color: colorText,
                isText: true,
                seed: Math.random() * 1000,
              });
            }
          }
        }

        // Shrink before releasing: a full-size canvas holds several megabytes until collected, and
        // this runs again on every resize.
        canvas.width = 1;
        canvas.height = 1;
      }

      for (let i = 0; i < backgroundCount; i += 1) {
        const x = Math.random() * w;
        const y = Math.random() * h;
        particles.push({
          x,
          y,
          vx: (Math.random() - 0.5) * 2,
          vy: (Math.random() - 0.5) * 2,
          homeX: x,
          homeY: y,
          radius: 1.2 + Math.random() * 1.8,
          alpha: 0.25 + Math.random() * 0.25,
          color: Math.random() > 0.3 ? colorFlow : colorDeep,
          isText: false,
          seed: Math.random() * 1000,
        });
      }
    };

    build();
    stage.onResize(build);

    let time = 0;

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      time += dt;
      // The original ran its forces per frame at 60 fps. Scaling by dt*60 keeps them the same at
      // that rate and correct at every other, rather than making the fluid faster on a fast display.
      const step = Math.min(dt * 60, 3);

      const w = stage.width;
      const h = stage.height;

      backgroundLayer.clear();
      if (drawBackground) backgroundLayer.rect(0, 0, w, h).fill({ color: backgroundColor });

      hash.clear();
      for (const p of particles) hash.insert(p);

      particleLayer.clear();

      for (const p of particles) {
        if (p.isText) {
          // A slow wave across the whole word, plus a per-particle shimmer, plus a spring home.
          const swellX = Math.sin(p.homeX * 0.01 + p.homeY * 0.01 + time * 0.3) * swell;
          const swellY = Math.cos(p.homeX * 0.01 - p.homeY * 0.01 + time * 0.24) * swell;
          const shimX = Math.sin(p.seed + time * 0.8) * shimmer;
          const shimY = Math.cos(p.seed * 0.7 + time * 0.88) * shimmer;
          p.vx += (p.homeX + swellX + shimX - p.x) * RETURN_FORCE * step;
          p.vy += (p.homeY + swellY + shimY - p.y) * RETURN_FORCE * step;
        } else {
          // A slow flow field, and wrapping at the edges so the cloud is endless.
          p.vx += Math.sin(time * 0.12 + p.y * 0.002) * 0.3 * step;
          p.vy += Math.cos(time * 0.12 + p.x * 0.002) * 0.3 * step;
          if (p.x < 0) p.x = w;
          if (p.x > w) p.x = 0;
          if (p.y < 0) p.y = h;
          if (p.y > h) p.y = 0;
        }

        if (repulsion > 0) {
          hash.forEachNeighbour(p, (other) => {
            // Text particles ignore each other: neighbouring particles in a stroke are touching by
            // definition, and letting them push would blow the letters apart.
            if (p === other || (p.isText && other.isText)) return;
            const dx = p.x - other.x;
            const dy = p.y - other.y;
            const distSq = dx * dx + dy * dy;
            // Text particles claim a wider berth, which is what carves the visible gap around the
            // letters as the cloud flows past.
            const buffer = p.isText || other.isText ? 24 : 0;
            const minDist = p.radius + other.radius + buffer;
            if (distSq < minDist * minDist) {
              const dist = Math.sqrt(distSq) || 0.001;
              const force = ((minDist - dist) / minDist) * repulsion;
              p.vx += (dx / dist) * force * step;
              p.vy += (dy / dist) * force * step;
            }
          });
        }

        // Damping applied per frame at 60 fps in the original; raised to the frame's share so the
        // fluid settles at the same rate whatever the frame rate.
        const damping = Math.pow(DAMPING, step);
        p.vx *= damping;
        p.vy *= damping;
        p.x += p.vx * step;
        p.y += p.vy * step;

        particleLayer.circle(p.x, p.y, p.radius).fill({ color: p.color, alpha: p.alpha });
      }

      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        const before = [text, fontFamily, fontSize, textStep, backgroundCount].join("|");

        text = str(p, "text", "STARTING / SOON");
        fontFamily = str(p, "fontFamily", "Silkscreen, sans-serif");
        fontSize = num(p, "fontSize", 320, 40, 600);
        textStep = int(p, "textDensity", TEXT_STEP, 3, 24);
        backgroundCount = int(p, "backgroundParticles", 1300, 0, 5000);
        swell = num(p, "swell", 6, 0, 40);
        shimmer = num(p, "shimmer", 1, 0, 10);
        repulsion = num(p, "repulsion", 0.6, 0, 3);
        colorText = colorHex(p, "colorText", "#ff4500");
        colorFlow = colorHex(p, "colorFlow", "#0077ff");
        colorDeep = colorHex(p, "colorDeep", "#001a33");
        drawBackground = bool(p, "background", true);
        backgroundColor = colorHex(p, "backgroundColor", "#000308");

        // Anything that changes where particles *are* needs a rebuild; colours and forces are read
        // each frame and do not.
        if ([text, fontFamily, fontSize, textStep, backgroundCount].join("|") !== before) build();
        else {
          for (const particle of particles) {
            if (particle.isText) particle.color = colorText;
          }
        }
      },
    };
  },
});

export default startingSoonFluid;
