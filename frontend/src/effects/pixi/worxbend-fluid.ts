import * as PIXI from "pixi.js";

import { bool, colorHex, int, num, str } from "../paramUtils";
import { createPixiStage, defineEffect, onFrame, useFont } from "../sdk";

/**
 * Worxbend Fluid
 * ==============
 *
 * A word rendered as a dense field of particles submerged in liquid. Interfering sine waves roll
 * across the lettering, swelling and displacing the particles; where the waves cross, the particles
 * brighten, jitter and briefly flash a highlight colour — the shimmer of light on water. Nearby
 * particles are bonded to each other and drawn with faint connecting lines, so the word deforms as
 * one cohesive body rather than as loose dots. Behind it, a slow gradient and a cloud of drifting
 * particles are stirred by four fixed invisible vortices into an endless spiral current.
 *
 * Ported from `WorxbendFluidScreen.ts` in the old `obs-effects` repository.
 *
 * ## How it differs from `starting-soon-fluid`
 *
 * Both spell a word out of particles hovering in liquid, but the physics is different. That effect
 * pushes text and background particles apart on contact — the letters are carved out by a passing
 * cloud. This one never collides anything: the text is deformed by a *displacement field* (three
 * sine waves at different scales, added together), and neighbouring text particles are *bonded* —
 * pulled towards a preferred spacing — so the surface behaves like something with tension. The
 * background cloud here follows four vortices instead of a plain flow field.
 *
 * ## The shimmer, which is the part worth understanding
 *
 * Three waves cross the lettering: a large slow swell, a medium cross-ripple and a small sharp
 * ripple. Their sum displaces the particles; the *product* of the first two — squared, so it is
 * only large where both peak together — is the "shimmer" value. Where shimmer is high, particles
 * swell, brighten, get an extra spring kick and a random jitter, and above a threshold they flash
 * the highlight colour. That is what makes the surface glitter in moving patches rather than
 * pulsing uniformly.
 *
 * ## What changed from the original
 *
 * - The word, font, size and every physics constant are parameters; the originals are the defaults.
 * - The old screen hard-coded "WORXBEND"; here the text is configurable like the other text ports.
 * - Per-frame forces were written for Pixi's `ticker.deltaTime` (≈1 at 60 fps); they are scaled by
 *   the frame's share of a 60 fps step so the fluid moves at the same rate on any display.
 * - The font is awaited before the text is rasterised, so the particles sample the real glyphs
 *   rather than a fallback face (`useFont` — see `sdk/text.ts` for why).
 */

/** Grid step when sampling the rendered text. The original's "denser for more liquid feel". */
const TEXT_PARTICLE_STEP = 10;

/** Spring pull towards the displaced target position, per 60 fps step. */
const RETURN_STRENGTH = 0.04;

/** Velocity retained per 60 fps step — the "viscous friction" of the original. */
const DAMPING = 0.94;

/** Extra spring kick applied where the shimmer is strong, causing overshoot and bounce. */
const SPRING_OVERSHOOT = 0.08;

/** Preferred spacing between bonded neighbours, in pixels. */
const BOND_DIST = 12;

/** How hard bonded neighbours are pulled towards that spacing. */
const BOND_STRENGTH = 0.03;

/** Neighbours further apart than this are not bonded at all. */
const MAX_BOND_RANGE = 20;

/** Neighbours closer than this get a faint connecting line drawn between them. */
const COHESION_DIST = 15;

/** How many particles drift in the background cloud. */
const BG_PARTICLE_N = 120;

/** Largest background particle radius; depth (`z`) scales each one between 0.5 and this + 0.5. */
const BG_MAX_RADIUS = 3.5;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  homeX: number;
  homeY: number;
  radius: number;
  baseRadius: number;
  alpha: number;
  /** True for the minority of particles drawn in the accent colour. */
  accent: boolean;
}

interface BgParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  alpha: number;
  /** True for the minority drawn in the alternate flow colour. */
  alt: boolean;
  /** Depth, 0 = far, 1 = near. Near particles are larger, brighter and carried faster. */
  z: number;
}

interface Vortex {
  x: number;
  y: number;
  strength: number;
  radius: number;
}

const worxbendFluid = defineEffect({
  descriptor: {
    id: "worxbend-fluid",
    name: "Worxbend Fluid",
    description:
      "A word in particles submerged in liquid — interfering waves roll across the lettering, shimmering where they cross, while vortices stir a drifting background cloud.",
    engine: "pixi",
    category: "background",
    tags: ["text", "particles", "fluid", "waves", "catppuccin", "branding", "background"],
    previewNotes:
      "Set Text to your own wording. The shimmer patches sweeping across the lettering are wave interference — Overshoot and Shimmer Colour control how hard they hit. Text Density is the main performance control. Uses the bundled Silkscreen font.",
    params: [
      {
        key: "text",
        label: "Text",
        kind: "text",
        default: "WORXBEND",
        description: "The word to spell out in particles.",
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
        default: 10,
        min: 3,
        max: 24,
        step: 1,
        description:
          "Pixels between text particles. The main performance control — halving it roughly quadruples the particle count, and the bond lines get denser too.",
      },
      {
        key: "returnStrength",
        label: "Spring Strength",
        kind: "number",
        default: 0.04,
        min: 0.005,
        max: 0.2,
        step: 0.005,
        description:
          "How hard each particle is pulled towards its wave-displaced position. Low is sluggish and syrupy; high snaps the word taut.",
      },
      {
        key: "damping",
        label: "Viscosity",
        kind: "number",
        default: 0.94,
        min: 0.8,
        max: 0.99,
        step: 0.005,
        description:
          "Fraction of velocity kept each step. Lower is thicker liquid — motion dies quickly. Near 1 the particles ring and wobble for a long time.",
      },
      {
        key: "overshoot",
        label: "Overshoot",
        kind: "number",
        default: 0.08,
        min: 0,
        max: 0.4,
        step: 0.01,
        description:
          "Extra spring kick where the waves interfere, making the surface bounce. 0 leaves a calm swell with no glitter in the motion.",
      },
      {
        key: "bondStrength",
        label: "Bond Strength",
        kind: "number",
        default: 0.03,
        min: 0,
        max: 0.2,
        step: 0.005,
        description:
          "How strongly neighbouring text particles hold their spacing. This is the surface tension — 0 lets the lettering deform as independent dots.",
      },
      {
        key: "backgroundParticles",
        label: "Background Particles",
        kind: "number",
        default: 120,
        min: 0,
        max: 600,
        step: 10,
        description: "The drifting cloud stirred by the vortices. 0 leaves only the lettering.",
      },
      {
        key: "vortexStrength",
        label: "Vortex Strength",
        kind: "number",
        default: 1,
        min: 0,
        max: 4,
        step: 0.05,
        description:
          "Scales the four fixed vortices that spiral the background cloud. 0 leaves the cloud drifting slowly in one direction.",
      },
      {
        key: "colorText",
        label: "Text Colour",
        kind: "color",
        default: "#89b4fa",
        description: "Most of the lettering particles, and their bond lines.",
      },
      {
        key: "colorAccent",
        label: "Accent Colour",
        kind: "color",
        default: "#cba6f7",
        description: "Roughly one lettering particle in seven, for variation.",
      },
      {
        key: "colorShimmer",
        label: "Shimmer Colour",
        kind: "color",
        default: "#89dceb",
        description: "Flashed by particles caught in strong wave interference.",
      },
      {
        key: "colorFlow",
        label: "Flow Colour",
        kind: "color",
        default: "#89b4fa",
        description: "Most of the background cloud.",
      },
      {
        key: "colorFlowAlt",
        label: "Flow Accent",
        kind: "color",
        default: "#74c7ec",
        description: "The rest of the background cloud, for depth.",
      },
      {
        key: "background",
        label: "Background",
        kind: "boolean",
        default: true,
        description: "Fill the frame with a vertical gradient behind the particles.",
      },
      {
        key: "backgroundTop",
        label: "Background Top",
        kind: "color",
        default: "#11111b",
        description: "Top of the background gradient. Only used when Background is on.",
      },
      {
        key: "backgroundBottom",
        label: "Background Bottom",
        kind: "color",
        default: "#181825",
        description: "Bottom of the background gradient. Only used when Background is on.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    let fontFamily = str(ctx.params, "fontFamily", "Silkscreen, sans-serif");
    let fontSize = num(ctx.params, "fontSize", 320, 40, 600);

    // The text is rasterised and sampled, so the real font must be loaded first or every particle
    // lands on the shape of the fallback face instead.
    await useFont(`bold ${fontSize}px ${fontFamily}`);
    scope.checkpoint();

    const stage = await createPixiStage(scope, ctx);

    // Draw order matters: gradient and cloud at the back, bond lines behind the particles so the
    // dots read as nodes on the lines rather than beads threaded onto them.
    const bgLayer = stage.stage.addChild(new PIXI.Graphics());
    const cohesionLayer = stage.stage.addChild(new PIXI.Graphics());
    const textLayer = stage.stage.addChild(new PIXI.Graphics());

    let text = str(ctx.params, "text", "WORXBEND");
    let textStep = int(ctx.params, "textDensity", TEXT_PARTICLE_STEP, 3, 24);
    let returnStrength = num(ctx.params, "returnStrength", RETURN_STRENGTH, 0.005, 0.2);
    let damping = num(ctx.params, "damping", DAMPING, 0.8, 0.99);
    let overshoot = num(ctx.params, "overshoot", SPRING_OVERSHOOT, 0, 0.4);
    let bondStrength = num(ctx.params, "bondStrength", BOND_STRENGTH, 0, 0.2);
    let bgCount = int(ctx.params, "backgroundParticles", BG_PARTICLE_N, 0, 600);
    let vortexStrength = num(ctx.params, "vortexStrength", 1, 0, 4);
    let colorText = colorHex(ctx.params, "colorText", "#89b4fa");
    let colorAccent = colorHex(ctx.params, "colorAccent", "#cba6f7");
    let colorShimmer = colorHex(ctx.params, "colorShimmer", "#89dceb");
    let colorFlow = colorHex(ctx.params, "colorFlow", "#89b4fa");
    let colorFlowAlt = colorHex(ctx.params, "colorFlowAlt", "#74c7ec");
    let drawBackground = bool(ctx.params, "background", true);
    let backgroundTop = colorHex(ctx.params, "backgroundTop", "#11111b");
    let backgroundBottom = colorHex(ctx.params, "backgroundBottom", "#181825");

    let textParticles: Particle[] = [];
    let bgParticles: BgParticle[] = [];
    let vortices: Vortex[] = [];
    let bgGradient: PIXI.FillGradient | null = null;

    /**
     * Four fixed vortices, placed relative to the frame: two large side-by-side rollers spinning in
     * opposite directions, and a smaller counter-rotating pair above and below the centre. Their
     * opposition is what keeps the cloud circulating instead of all draining one way.
     */
    const buildVortices = (): void => {
      const w = stage.width;
      const h = stage.height;
      vortices = [
        { x: w * 0.25, y: h * 0.5, strength: 0.5, radius: 400 },
        { x: w * 0.75, y: h * 0.5, strength: -0.4, radius: 500 },
        { x: w * 0.5, y: h * 0.2, strength: 0.3, radius: 300 },
        { x: w * 0.5, y: h * 0.8, strength: -0.3, radius: 300 },
      ];
    };

    const buildGradient = (): void => {
      // FillGradient coordinates are in pixels here, so the gradient is rebuilt whenever the
      // height changes rather than created once.
      bgGradient = new PIXI.FillGradient({
        start: { x: 0, y: 0 },
        end: { x: 0, y: stage.height },
        colorStops: [
          { offset: 0, color: backgroundTop },
          { offset: 1, color: backgroundBottom },
        ],
        textureSpace: "global",
      });
    };

    const buildBgParticles = (): void => {
      const w = stage.width;
      const h = stage.height;
      bgParticles = [];
      for (let i = 0; i < bgCount; i += 1) {
        const z = Math.random(); // 0 = far, 1 = near
        bgParticles.push({
          x: Math.random() * w,
          y: Math.random() * h,
          vx: 0,
          vy: 0,
          // Near particles are bigger and brighter — a cheap bokeh-style depth cue.
          radius: 0.5 + z * BG_MAX_RADIUS,
          alpha: 0.05 + z * 0.15,
          alt: Math.random() > 0.6,
          z,
        });
      }
    };

    /** Rasterises the word and turns its bright pixels into tethered particles. */
    const buildTextParticles = (): void => {
      const w = Math.max(1, Math.round(stage.width));
      const h = Math.max(1, Math.round(stage.height));

      textParticles = [];
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const context = canvas.getContext("2d", { willReadFrequently: true });

      if (context !== null) {
        context.font = `bold ${fontSize}px ${fontFamily}`;
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillStyle = "white";
        context.fillText(text, w / 2, h / 2);

        const pixels = context.getImageData(0, 0, w, h).data;
        for (let y = 0; y < h; y += textStep) {
          for (let x = 0; x < w; x += textStep) {
            if ((pixels[(y * w + x) * 4] ?? 0) > 128) {
              textParticles.push({
                // Scattered up to 15px from home, so the word visibly congeals on the first frames.
                x: x + (Math.random() - 0.5) * 30,
                y: y + (Math.random() - 0.5) * 30,
                vx: 0,
                vy: 0,
                homeX: x,
                homeY: y,
                radius: 1.5,
                baseRadius: 1.5 + Math.random() * 1.5,
                alpha: 0.7 + Math.random() * 0.3,
                accent: Math.random() > 0.85,
              });
            }
          }
        }

        // Shrink before releasing: a full-size canvas holds several megabytes until collected, and
        // this runs again on every resize.
        canvas.width = 1;
        canvas.height = 1;
      }
    };

    const build = (): void => {
      buildVortices();
      buildGradient();
      buildBgParticles();
      buildTextParticles();
    };

    build();
    stage.onResize(build);

    /**
     * The displacement field: three sine waves at different spatial scales and speeds, summed for
     * the height and offset, and multiplied for the shimmer. The shimmer is the *product* of the
     * two larger waves, squared — near zero almost everywhere, large only where both peak at once —
     * which is why the glitter arrives in moving patches instead of everywhere at once.
     */
    const getDisplacement = (
      x: number,
      y: number,
      time: number,
    ): { height: number; shimmer: number; dx: number; dy: number } => {
      // Large slow swell.
      const w1 = Math.sin(x * 0.0015 + y * 0.001 + time * 0.4);
      // Medium cross-ripple, travelling diagonally the other way.
      const w2 = Math.sin(x * 0.004 - y * 0.003 + time * 1.1 + 2.0);
      // Small sharp interference ripple.
      const w3 = Math.sin(x * 0.012 + y * 0.015 + time * 2.3 + 4.5);

      const combined = w1 * 0.6 + w2 * 0.3 + w3 * 0.1;
      const shimmer = Math.pow(Math.abs(w1 * w2), 2) * 2.0 + Math.abs(w3) * 0.5;

      return {
        height: combined, // -1 to 1
        shimmer,
        dx: w1 * 12 + w2 * 5,
        dy: w1 * 8 + w3 * 4,
      };
    };

    let time = 0;

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      // The original applied its forces per Pixi tick (deltaTime ≈ 1 at 60 fps) and advanced its
      // clock by deltaTime * 0.016. `step` reproduces that tick so every constant keeps its
      // original meaning, clamped so a stall does not explode the springs.
      const step = Math.min(dt * 60, 3);
      time += step * 0.016;

      const w = stage.width;
      const h = stage.height;

      bgLayer.clear();
      cohesionLayer.clear();
      textLayer.clear();

      if (drawBackground && bgGradient !== null) {
        bgLayer.rect(0, 0, w, h).fill(bgGradient);
      }

      // ── Background cloud: vortex flow ───────────────────────────────────
      const flowColor = colorFlow;
      const flowAltColor = colorFlowAlt;
      for (const p of bgParticles) {
        // A gentle constant drift, faster for near particles — parallax.
        let flowX = 0.2 * (1 + p.z);
        let flowY = 0.1 * (1 + p.z);

        for (const v of vortices) {
          const dx = p.x - v.x;
          const dy = p.y - v.y;
          const distSq = dx * dx + dy * dy;
          if (distSq < v.radius * v.radius && distSq > 0) {
            const dist = Math.sqrt(distSq);
            const force = (1 - dist / v.radius) * v.strength * vortexStrength;
            // Velocity perpendicular to the offset from the centre — a spiral, not a drain.
            flowX += (-dy / dist) * force * 2;
            flowY += (dx / dist) * force * 2;
          }
        }

        // Ease towards the flow rather than adopting it, so direction changes look inertial.
        p.vx += (flowX - p.vx) * 0.05 * step;
        p.vy += (flowY - p.vy) * 0.05 * step;
        p.x += p.vx * step;
        p.y += p.vy * step;

        // Wrap with a 50px margin, so a particle leaves fully before reappearing on the far side.
        if (p.x < -50) p.x = w + 50;
        if (p.x > w + 50) p.x = -50;
        if (p.y < -50) p.y = h + 50;
        if (p.y > h + 50) p.y = -50;

        bgLayer
          .circle(p.x, p.y, p.radius)
          .fill({ color: p.alt ? flowAltColor : flowColor, alpha: p.alpha });
      }

      // ── The lettering: submerged displacement ───────────────────────────
      // A slow whole-word drift on top of the waves, so the word itself floats.
      const driftX = Math.sin(time * 0.1) * 10;
      const driftY = Math.cos(time * 0.08) * 15;
      const frameDamping = Math.pow(damping, step);

      for (let i = 0; i < textParticles.length; i += 1) {
        const p = textParticles[i];
        if (p === undefined) continue;

        // The field is sampled at the *home* position, not the current one: the wave pattern stays
        // pinned to the lettering however far the particles are flung.
        const disp = getDisplacement(p.homeX, p.homeY, time);

        // Swell with the wave, eased so the size change lags like something underwater.
        const targetRadius = p.baseRadius * (1 + disp.height * 0.4 + disp.shimmer * 0.2);
        p.radius += (targetRadius - p.radius) * 0.1 * step;

        const targetX = p.homeX + disp.dx + driftX;
        const targetY = p.homeY + disp.dy + driftY;

        // The viscous spring towards the displaced target.
        p.vx += (targetX - p.x) * returnStrength * step;
        p.vy += (targetY - p.y) * returnStrength * step;

        // Extra kick where the shimmer is strong, producing overshoot and bounce.
        p.vx += (targetX - p.x) * overshoot * disp.shimmer * 0.1;
        p.vy += (targetY - p.y) * overshoot * disp.shimmer * 0.1;

        // Micro-turbulence: only inside strong interference patches.
        if (disp.shimmer > 1.0) {
          p.vx += (Math.random() - 0.5) * disp.shimmer * 0.5;
          p.vy += (Math.random() - 0.5) * disp.shimmer * 0.5;
        }

        const ownColor = p.accent ? colorAccent : colorText;

        // ── Bonds ─────────────────────────────────────────────────────────
        // Only a small index window is checked rather than every pair. The list is built in scan
        // order, so near-in-index means near-in-space, and the window catches the real neighbours
        // at a fraction of the cost of the full quadratic comparison.
        const windowSize = 8;
        const start = Math.max(0, i - windowSize);
        const end = Math.min(textParticles.length, i + windowSize);
        for (let j = start; j < end; j += 1) {
          if (i === j) continue;
          const p2 = textParticles[j];
          if (p2 === undefined) continue;
          const dx = p2.x - p.x;
          const dy = p2.y - p.y;
          const distSq = dx * dx + dy * dy;

          if (distSq < MAX_BOND_RANGE * MAX_BOND_RANGE && distSq > 0) {
            const dist = Math.sqrt(distSq);
            // A spring towards the preferred spacing: attracts when stretched past BOND_DIST,
            // repels when compressed under it. This is the surface tension.
            const diff = dist - BOND_DIST;
            p.vx += (dx / dist) * diff * bondStrength * step;
            p.vy += (dy / dist) * diff * bondStrength * step;

            if (dist < COHESION_DIST) {
              // The connecting line brightens with the shimmer, so the mesh glints with the waves.
              const alpha = (1 - dist / COHESION_DIST) * 0.15 * (0.5 + disp.shimmer * 0.5);
              cohesionLayer
                .moveTo(p.x, p.y)
                .lineTo(p2.x, p2.y)
                .stroke({ color: ownColor, width: 1, alpha });
            }
          }
        }

        p.vx *= frameDamping;
        p.vy *= frameDamping;
        p.x += p.vx * step;
        p.y += p.vy * step;

        // Shimmer brightens the particle, and past a threshold flips it to the highlight colour —
        // the flash of light catching a wave crest.
        const finalAlpha = Math.min(1.0, p.alpha * (1 + disp.shimmer * 0.3));
        const color = disp.shimmer > 1.5 ? colorShimmer : ownColor;

        textLayer.circle(p.x, p.y, p.radius).fill({ color, alpha: finalAlpha });
      }

      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        const rebuildBefore = [text, fontFamily, fontSize, textStep, bgCount].join("|");
        const gradientBefore = [backgroundTop, backgroundBottom].join("|");

        text = str(p, "text", "WORXBEND");
        fontFamily = str(p, "fontFamily", "Silkscreen, sans-serif");
        fontSize = num(p, "fontSize", 320, 40, 600);
        textStep = int(p, "textDensity", TEXT_PARTICLE_STEP, 3, 24);
        returnStrength = num(p, "returnStrength", RETURN_STRENGTH, 0.005, 0.2);
        damping = num(p, "damping", DAMPING, 0.8, 0.99);
        overshoot = num(p, "overshoot", SPRING_OVERSHOOT, 0, 0.4);
        bondStrength = num(p, "bondStrength", BOND_STRENGTH, 0, 0.2);
        bgCount = int(p, "backgroundParticles", BG_PARTICLE_N, 0, 600);
        vortexStrength = num(p, "vortexStrength", 1, 0, 4);
        colorText = colorHex(p, "colorText", "#89b4fa");
        colorAccent = colorHex(p, "colorAccent", "#cba6f7");
        colorShimmer = colorHex(p, "colorShimmer", "#89dceb");
        colorFlow = colorHex(p, "colorFlow", "#89b4fa");
        colorFlowAlt = colorHex(p, "colorFlowAlt", "#74c7ec");
        drawBackground = bool(p, "background", true);
        backgroundTop = colorHex(p, "backgroundTop", "#11111b");
        backgroundBottom = colorHex(p, "backgroundBottom", "#181825");

        // Only what changes where particles *exist* forces a rebuild; forces and colours are read
        // every frame and swap live.
        if ([text, fontFamily, fontSize, textStep, bgCount].join("|") !== rebuildBefore) {
          buildBgParticles();
          buildTextParticles();
        }
        if ([backgroundTop, backgroundBottom].join("|") !== gradientBefore) buildGradient();
      },
    };
  },
});

export default worxbendFluid;
