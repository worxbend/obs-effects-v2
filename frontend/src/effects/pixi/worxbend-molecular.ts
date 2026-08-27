import * as PIXI from "pixi.js";

import { bool, colorHex, int, num, str } from "../paramUtils";
import { createPixiStage, defineEffect, onFrame, useFont } from "../sdk";

/**
 * Worxbend Molecular
 * ==================
 *
 * A word rendered as a molecular lattice: the lettering is rasterised into a grid of particles,
 * each one tethered to its home pixel by a spring, cohering with and repelling its neighbours the
 * way molecules in a droplet do. Faint lines between nearby particles draw the "membrane" of that
 * lattice, so the word looks like liquid metal held in shape by surface tension. Three overlapping
 * sine waves displace every home position, so the whole word ripples as if partially submerged.
 * Behind it, dimmer bokeh particles drift in a slow vortex around the centre of the frame — the
 * deeper half of them blurred, which is what sells the depth.
 *
 * Ported from `WorxbendMolecularScreen.ts` in the old `obs-effects` repository.
 *
 * ## What changed from the original
 *
 * - The old screen was driven by Pixi's own ticker; this build has exactly one animation loop
 *   (`onFrame`), which is what makes the route's frame cap real. The original's `deltaTime` was in
 *   60 fps frames while `onFrame` reports seconds, so every per-frame force is multiplied by
 *   `step = dt * 60` and friction is raised to that power — the physics settles at the same rate
 *   whatever the frame rate.
 * - The old page fixed the text at "WORXBEND" in 320px bold Silkscreen over a Catppuccin
 *   crust-to-mantle gradient. All of those are parameters now, with the originals as defaults, and
 *   the text auto-shrinks so a longer word still fits the frame.
 * - The original never waited for the Silkscreen font, which meant the very first rasterisation
 *   could sample a fallback typeface and place every particle wrongly. `useFont` closes that gap.
 *
 * ## The neighbour trick worth knowing about
 *
 * Cohesion and repulsion are only computed against the 15 particles either side of each one *in
 * array order*, not against all of them. The array is built in pixel-scan order, so near-in-index
 * means near-in-space, and the lattice forces reach almost every real neighbour at a tiny fraction
 * of the all-pairs cost. The same pass draws the membrane lines, so they come for free.
 */

/** Catppuccin Mocha, the palette the original hard-coded. */
const CRUST = "#11111b";
const MANTLE = "#181825";
const MAUVE = "#cba6f7";
const BLUE = "#89b4fa";
const SAPPHIRE = "#74c7ec";
const SKY = "#89dceb";

/**
 * The three overlapping ripples that displace the lettering's home positions. Kept as fixed
 * ratios — one broad slow swell, one medium, one fine fast shimmer — and scaled as a set by the
 * Wave Height and Wave Speed parameters, because the *relationship* between the layers is what
 * makes it read as water rather than as a wobble.
 */
const WAVE_LAYERS = [
  { freq: 0.004, amp: 10, speed: 0.8 },
  { freq: 0.008, amp: 5, speed: 1.5 },
  { freq: 0.012, amp: 3, speed: 2.5 },
] as const;

/** How many array neighbours either side each particle interacts with. See the header comment. */
const NEIGHBOUR_RANGE = 15;

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
}

interface BgParticle {
  x: number;
  y: number;
  radius: number;
  alpha: number;
  color: string;
  /** 0 (near) to 1 (deep). Deep particles are slower, dimmer, smaller and blurred. */
  depth: number;
}

const worxbendMolecular = defineEffect({
  descriptor: {
    id: "worxbend-molecular",
    name: "Worxbend Molecular",
    description:
      "A word as a rippling molecular lattice — particles tethered into the lettering, joined by a faint membrane, over a slow vortex of blurred bokeh particles.",
    engine: "pixi",
    category: "background",
    tags: ["text", "particles", "molecular", "membrane", "catppuccin", "branding"],
    previewNotes:
      "Set Text to your own wording. The membrane lines between neighbouring particles are what give it the liquid look — Cohesion Reach controls how far they connect. Uses the bundled Silkscreen font. Turn Background off for a transparent overlay.",
    params: [
      {
        key: "text",
        label: "Text",
        kind: "text",
        default: "WORXBEND",
        description:
          "The word to spell out. It is auto-shrunk to fit inside the frame width if it would overflow.",
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
        min: 60,
        max: 640,
        step: 10,
        description:
          "Height of the lettering in pixels, before any auto-shrink to fit the frame.",
      },
      {
        key: "density",
        label: "Particle Spacing",
        kind: "number",
        default: 10,
        min: 4,
        max: 30,
        step: 1,
        description:
          "Pixels between lattice particles. Lower is denser and prettier but costs more — the neighbour forces and membrane lines scale with it.",
      },
      {
        key: "returnForce",
        label: "Spring Strength",
        kind: "number",
        default: 0.05,
        min: 0,
        max: 0.3,
        step: 0.005,
        description:
          "How hard each particle is pulled back to its home pixel. 0 lets the word dissolve entirely.",
      },
      {
        key: "friction",
        label: "Viscosity",
        kind: "number",
        default: 0.93,
        min: 0.7,
        max: 0.99,
        step: 0.01,
        description:
          "Velocity kept per 60fps step. Lower is thicker fluid: motion dies quickly. Higher lets ripples ring on.",
      },
      {
        key: "jitter",
        label: "Thermal Jitter",
        kind: "number",
        default: 0.05,
        min: 0,
        max: 1,
        step: 0.01,
        description:
          "Constant random nudge on every lattice particle — the Brownian shimmer that keeps the word from freezing solid.",
      },
      {
        key: "cohesionDist",
        label: "Cohesion Reach",
        kind: "number",
        default: 18,
        min: 4,
        max: 60,
        step: 1,
        description:
          "How far apart two particles can be and still pull on each other. This is also how far the membrane lines reach.",
      },
      {
        key: "cohesionStrength",
        label: "Cohesion Force",
        kind: "number",
        default: 0.08,
        min: 0,
        max: 0.5,
        step: 0.01,
        description: "How strongly neighbouring particles pull together into the lattice.",
      },
      {
        key: "repulsionDist",
        label: "Repulsion Reach",
        kind: "number",
        default: 12,
        min: 2,
        max: 40,
        step: 1,
        description:
          "Particles closer than this shove each other apart, so the lattice never collapses into clumps.",
      },
      {
        key: "repulsionStrength",
        label: "Repulsion Force",
        kind: "number",
        default: 0.2,
        min: 0,
        max: 1,
        step: 0.05,
        description: "How hard too-close particles push apart.",
      },
      {
        key: "waveAmp",
        label: "Wave Height",
        kind: "number",
        default: 1,
        min: 0,
        max: 4,
        step: 0.05,
        description:
          "Scales the ripple that sways the whole word. 0 holds the lettering flat; the lattice forces still shimmer.",
      },
      {
        key: "waveSpeed",
        label: "Wave Speed",
        kind: "number",
        default: 1,
        min: 0,
        max: 4,
        step: 0.05,
        description: "How fast the ripples travel through the lettering.",
      },
      {
        key: "bgParticles",
        label: "Bokeh Particles",
        kind: "number",
        default: 120,
        min: 0,
        max: 500,
        step: 10,
        description:
          "How many drifting background particles circle the frame. 0 removes the vortex entirely.",
      },
      {
        key: "vortexStrength",
        label: "Vortex Strength",
        kind: "number",
        default: 0.02,
        min: 0,
        max: 0.2,
        step: 0.005,
        description:
          "How strongly the background particles curve around the centre of the frame.",
      },
      {
        key: "driftSpeed",
        label: "Drift Speed",
        kind: "number",
        default: 0.4,
        min: 0,
        max: 3,
        step: 0.05,
        description: "Sideways drift added to every background particle on top of the vortex.",
      },
      {
        key: "background",
        label: "Background",
        kind: "boolean",
        default: true,
        description:
          "Fill the frame with the gradient. Off leaves the canvas transparent for use as an overlay.",
      },
      {
        key: "bgColorTop",
        label: "Background Top",
        kind: "color",
        default: CRUST,
        description: "Top of the background gradient. Only used when Background is on.",
      },
      {
        key: "bgColorBottom",
        label: "Background Bottom",
        kind: "color",
        default: MANTLE,
        description: "Bottom of the background gradient. Only used when Background is on.",
      },
      {
        key: "colorPrimary",
        label: "Lattice Colour 1",
        kind: "color",
        default: SKY,
        description: "The colour of most lattice particles — about seven in ten.",
      },
      {
        key: "colorAccent",
        label: "Lattice Colour 2",
        kind: "color",
        default: MAUVE,
        description: "The accent colour scattered through the remaining lattice particles.",
      },
      {
        key: "colorBokehA",
        label: "Bokeh Colour 1",
        kind: "color",
        default: BLUE,
        description: "Half of the background particles take this colour.",
      },
      {
        key: "colorBokehB",
        label: "Bokeh Colour 2",
        kind: "color",
        default: SAPPHIRE,
        description: "The other half of the background particles.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    let fontFamily = str(ctx.params, "fontFamily", "Silkscreen, sans-serif");
    let fontSize = int(ctx.params, "fontSize", 320, 60, 640);

    // The lettering is rasterised to place particles, so a substituted font would put every
    // particle in the wrong place — wait for the real one before measuring anything.
    await useFont(`bold ${fontSize}px ${fontFamily}`);
    scope.checkpoint();

    const stage = await createPixiStage(scope, ctx);

    // Draw order, bottom to top: gradient + sharp bokeh, blurred bokeh, membrane lines, particles.
    // The membrane must sit under the particles so the dots read as nodes rather than as beads
    // threaded on the lines, and both must sit over the bokeh so the word is never occluded.
    const bgLayer = stage.stage.addChild(new PIXI.Graphics());
    const bgBlurLayer = stage.stage.addChild(new PIXI.Graphics());
    const membraneLayer = stage.stage.addChild(new PIXI.Graphics());
    const textLayer = stage.stage.addChild(new PIXI.Graphics());

    // The blur only touches the *deep* half of the bokeh particles — that difference in focus
    // between the two layers is the whole depth illusion.
    bgBlurLayer.filters = [new PIXI.BlurFilter({ strength: 4 })];

    let text = str(ctx.params, "text", "WORXBEND");
    let density = int(ctx.params, "density", 10, 4, 30);
    let returnForce = num(ctx.params, "returnForce", 0.05, 0, 0.3);
    let friction = num(ctx.params, "friction", 0.93, 0.7, 0.99);
    let jitter = num(ctx.params, "jitter", 0.05, 0, 1);
    let cohesionDist = num(ctx.params, "cohesionDist", 18, 4, 60);
    let cohesionStrength = num(ctx.params, "cohesionStrength", 0.08, 0, 0.5);
    let repulsionDist = num(ctx.params, "repulsionDist", 12, 2, 40);
    let repulsionStrength = num(ctx.params, "repulsionStrength", 0.2, 0, 1);
    let waveAmp = num(ctx.params, "waveAmp", 1, 0, 4);
    let waveSpeed = num(ctx.params, "waveSpeed", 1, 0, 4);
    let bgCount = int(ctx.params, "bgParticles", 120, 0, 500);
    let vortexStrength = num(ctx.params, "vortexStrength", 0.02, 0, 0.2);
    let driftSpeed = num(ctx.params, "driftSpeed", 0.4, 0, 3);
    let drawBackground = bool(ctx.params, "background", true);
    let bgColorTop = colorHex(ctx.params, "bgColorTop", CRUST);
    let bgColorBottom = colorHex(ctx.params, "bgColorBottom", MANTLE);
    let colorPrimary = colorHex(ctx.params, "colorPrimary", SKY);
    let colorAccent = colorHex(ctx.params, "colorAccent", MAUVE);
    let colorBokehA = colorHex(ctx.params, "colorBokehA", BLUE);
    let colorBokehB = colorHex(ctx.params, "colorBokehB", SAPPHIRE);

    let particles: Particle[] = [];
    let bgParticles: BgParticle[] = [];
    let bgGradient: PIXI.FillGradient | null = null;

    /** Rebuilds the vertical gradient for the current height and colours. */
    const buildGradient = (): void => {
      bgGradient = new PIXI.FillGradient(0, 0, 0, Math.max(1, stage.height));
      bgGradient.addColorStop(0, bgColorTop);
      bgGradient.addColorStop(1, bgColorBottom);
    };

    /** Scatters the drifting bokeh particles across the frame. */
    const buildBgParticles = (): void => {
      const w = stage.width;
      const h = stage.height;
      bgParticles = [];
      for (let i = 0; i < bgCount; i += 1) {
        bgParticles.push({
          x: Math.random() * w,
          y: Math.random() * h,
          radius: 1 + Math.random() * 3,
          alpha: 0.1 + Math.random() * 0.3,
          color: Math.random() > 0.5 ? colorBokehA : colorBokehB,
          depth: Math.random(),
        });
      }
    };

    /** Rasterises the word and turns its bright pixels into lattice particles. */
    const buildTextParticles = (): void => {
      const w = Math.max(1, Math.round(stage.width));
      const h = Math.max(1, Math.round(stage.height));

      particles = [];
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (context === null) return;

      // The original assumed a 1920px frame where 320px "WORXBEND" always fit. A smaller frame or
      // a longer word would run off the edges, so shrink to fit when the measurement says so.
      let size = fontSize;
      context.font = `bold ${size}px ${fontFamily}`;
      const measured = context.measureText(text).width;
      const maxWidth = w * 0.9;
      if (measured > maxWidth && measured > 0) {
        size = Math.max(8, Math.floor(size * (maxWidth / measured)));
        context.font = `bold ${size}px ${fontFamily}`;
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
              // Scattered up to 25px from home with a random kick, so the word visibly coalesces
              // over the first second rather than appearing fully formed.
              x: x + (Math.random() - 0.5) * 50,
              y: y + (Math.random() - 0.5) * 50,
              vx: (Math.random() - 0.5) * 5,
              vy: (Math.random() - 0.5) * 5,
              homeX: x,
              homeY: y,
              radius: 1.5 + Math.random() * 1.5,
              alpha: 0.8 + Math.random() * 0.2,
              color: Math.random() > 0.7 ? colorAccent : colorPrimary,
            });
          }
        }
      }
      // Release the rasterisation buffer promptly rather than waiting for garbage collection.
      canvas.width = 1;
      canvas.height = 1;
    };

    const build = (): void => {
      buildGradient();
      buildBgParticles();
      buildTextParticles();
    };

    build();
    stage.onResize(build);

    let time = 0;

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      time += dt;
      // The original applied its forces once per frame at 60 fps; `step` converts seconds back to
      // those frame units, clamped so a long stall does not fling the lattice apart.
      const step = Math.min(dt * 60, 3);
      const frictionStep = Math.pow(friction, step);
      const w = stage.width;
      const h = stage.height;

      bgLayer.clear();
      bgBlurLayer.clear();
      membraneLayer.clear();
      textLayer.clear();

      // ── Background fill ─────────────────────────────────────────────────
      if (drawBackground && bgGradient !== null) {
        bgLayer.rect(0, 0, w, h).fill(bgGradient);
      }

      // ── Bokeh vortex ────────────────────────────────────────────────────
      const centerX = w / 2;
      const centerY = h / 2;

      for (const p of bgParticles) {
        const dxCenter = p.x - centerX;
        const dyCenter = p.y - centerY;
        const distCenter = Math.sqrt(dxCenter * dxCenter + dyCenter * dyCenter) || 1;

        // Velocity perpendicular to the line to the centre: that is what makes an orbit rather
        // than a fall inward. Deeper particles move slower, which reinforces the depth cue.
        const tx = -dyCenter / distCenter;
        const ty = dxCenter / distCenter;
        const speedScale = 1.5 - p.depth;
        const vx = (tx * vortexStrength * distCenter * 0.1 + driftSpeed) * speedScale;
        const vy = ty * vortexStrength * distCenter * 0.1 * speedScale;

        p.x += vx * step;
        p.y += vy * step;

        // Wrap with a 100px margin so a particle never pops in or out at a visible edge.
        if (p.x < -100) p.x = w + 100;
        if (p.x > w + 100) p.x = -100;
        if (p.y < -100) p.y = h + 100;
        if (p.y > h + 100) p.y = -100;

        const bokehAlpha = p.alpha * (1 - p.depth * 0.5);
        const bokehRadius = p.radius * (1 - p.depth * 0.3);
        const layer = p.depth > 0.5 ? bgBlurLayer : bgLayer;
        layer.circle(p.x, p.y, bokehRadius).fill({ color: p.color, alpha: bokehAlpha });
      }

      // ── The lattice ─────────────────────────────────────────────────────
      for (let i = 0; i < particles.length; i += 1) {
        const p = particles[i];
        if (p === undefined) continue;

        // The home position itself sways with the three wave layers, so the spring is always
        // aiming at a moving target and the whole word ripples as one surface.
        let waveDx = 0;
        let waveDy = 0;
        for (const layer of WAVE_LAYERS) {
          const angle =
            time * layer.speed * waveSpeed + p.homeX * layer.freq + p.homeY * layer.freq * 0.5;
          waveDx += Math.cos(angle) * layer.amp * waveAmp;
          waveDy += Math.sin(angle) * layer.amp * waveAmp;
        }

        p.vx += (p.homeX + waveDx - p.x) * returnForce * step;
        p.vy += (p.homeY + waveDy - p.y) * returnForce * step;

        // Neighbour forces and membrane lines, against nearby array indices only — see the
        // header comment for why that is close enough and vastly cheaper than all pairs.
        const start = Math.max(0, i - NEIGHBOUR_RANGE);
        const end = Math.min(particles.length, i + NEIGHBOUR_RANGE);
        const cohesionSq = cohesionDist * cohesionDist;

        for (let j = start; j < end; j += 1) {
          if (i === j) continue;
          const other = particles[j];
          if (other === undefined) continue;
          const dx = other.x - p.x;
          const dy = other.y - p.y;
          const distSq = dx * dx + dy * dy;
          if (distSq >= cohesionSq) continue;

          const dist = Math.sqrt(distSq) || 0.1;

          // Cohesion is a spring towards 80% of the reach: closer pairs are pushed slightly
          // apart by it, further pairs pulled in, so the lattice finds an even spacing.
          const pull = (dist - cohesionDist * 0.8) * cohesionStrength;
          p.vx += (dx / dist) * pull * step;
          p.vy += (dy / dist) * pull * step;

          if (dist < repulsionDist) {
            const push = (repulsionDist - dist) * repulsionStrength;
            p.vx -= (dx / dist) * push * step;
            p.vy -= (dy / dist) * push * step;
          }

          // The membrane: a line whose opacity falls with distance, so links visibly stretch
          // thin and snap as the lattice deforms.
          const lineAlpha = (1 - dist / cohesionDist) * 0.2;
          membraneLayer
            .moveTo(p.x, p.y)
            .lineTo(other.x, other.y)
            .stroke({ color: p.color, width: 1, alpha: lineAlpha });
        }

        p.vx = p.vx * frictionStep + (Math.random() - 0.5) * jitter * step;
        p.vy = p.vy * frictionStep + (Math.random() - 0.5) * jitter * step;
        p.x += p.vx * step;
        p.y += p.vy * step;

        // Each particle flickers on its own phase; the second, smaller white pass is the hot
        // core that makes the dot read as glowing rather than flat.
        const flicker = Math.sin(time * 5 + i * 0.5) * 0.15;
        const glowAlpha = p.alpha * (0.8 + flicker);
        textLayer.circle(p.x, p.y, p.radius).fill({ color: p.color, alpha: glowAlpha });
        textLayer
          .circle(p.x, p.y, p.radius * 0.4)
          .fill({ color: 0xffffff, alpha: glowAlpha * 0.9 });
      }

      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        // Anything that changes what the rasteriser or the scatter passes produce forces a
        // rebuild of that data; everything else applies live to the running physics.
        const structuralBefore = [text, fontFamily, fontSize, density, bgCount].join("|");
        const colorsBefore = [colorPrimary, colorAccent, colorBokehA, colorBokehB].join("|");
        const gradientBefore = [bgColorTop, bgColorBottom].join("|");

        text = str(p, "text", "WORXBEND");
        fontFamily = str(p, "fontFamily", "Silkscreen, sans-serif");
        fontSize = int(p, "fontSize", 320, 60, 640);
        density = int(p, "density", 10, 4, 30);
        returnForce = num(p, "returnForce", 0.05, 0, 0.3);
        friction = num(p, "friction", 0.93, 0.7, 0.99);
        jitter = num(p, "jitter", 0.05, 0, 1);
        cohesionDist = num(p, "cohesionDist", 18, 4, 60);
        cohesionStrength = num(p, "cohesionStrength", 0.08, 0, 0.5);
        repulsionDist = num(p, "repulsionDist", 12, 2, 40);
        repulsionStrength = num(p, "repulsionStrength", 0.2, 0, 1);
        waveAmp = num(p, "waveAmp", 1, 0, 4);
        waveSpeed = num(p, "waveSpeed", 1, 0, 4);
        bgCount = int(p, "bgParticles", 120, 0, 500);
        vortexStrength = num(p, "vortexStrength", 0.02, 0, 0.2);
        driftSpeed = num(p, "driftSpeed", 0.4, 0, 3);
        drawBackground = bool(p, "background", true);
        bgColorTop = colorHex(p, "bgColorTop", CRUST);
        bgColorBottom = colorHex(p, "bgColorBottom", MANTLE);
        colorPrimary = colorHex(p, "colorPrimary", SKY);
        colorAccent = colorHex(p, "colorAccent", MAUVE);
        colorBokehA = colorHex(p, "colorBokehA", BLUE);
        colorBokehB = colorHex(p, "colorBokehB", SAPPHIRE);

        if ([text, fontFamily, fontSize, density, bgCount].join("|") !== structuralBefore) {
          buildBgParticles();
          buildTextParticles();
        } else if (
          [colorPrimary, colorAccent, colorBokehA, colorBokehB].join("|") !== colorsBefore
        ) {
          // A colour change alone re-rolls each particle's colour without disturbing positions,
          // so the word does not visibly re-assemble over a tint tweak.
          for (const particle of particles) {
            particle.color = Math.random() > 0.7 ? colorAccent : colorPrimary;
          }
          for (const particle of bgParticles) {
            particle.color = Math.random() > 0.5 ? colorBokehA : colorBokehB;
          }
        }

        if ([bgColorTop, bgColorBottom].join("|") !== gradientBefore) buildGradient();
      },
    };
  },
});

export default worxbendMolecular;
