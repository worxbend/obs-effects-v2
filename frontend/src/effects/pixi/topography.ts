import * as PIXI from "pixi.js";

import { bool, colorHex, colorInt, int, num, str } from "../paramUtils";
import { createPixiStage, defineEffect, onFrame, useFont } from "../sdk";

/**
 * Luminescent Topography
 * ======================
 *
 * A glowing 3D wire mesh seen from above, rolling with slow interference waves like a luminous
 * ocean. A word — "BREAK" by default — is not drawn as text at all: it is *raised out of the mesh*.
 * The word is rasterised once to an offscreen canvas, and every mesh point that lands on a bright
 * pixel of the lettering is lifted towards the camera, so the word reads as terrain pushed up
 * through the surface. Red particles cling to the raised lettering and ride the same waves, while a
 * loose field of blue drifting particles (some joined by faint lines) floats behind everything.
 *
 * Ported from `LuminescentTopographyScreen.ts` (`topography.html`) in the old `obs-effects`
 * repository.
 *
 * How the fake 3D works
 * ---------------------
 * There is no real 3D engine here. Each grid point gets a height `z` from two summed sine waves
 * plus the text lift, and is then projected with the classic one-line perspective formula
 * `scale = focalLength / (focalLength + z)`: points pushed up (negative-ish scale change) drift
 * towards the centre, points far away shrink. Colour and opacity also follow `z` — deep water is
 * near-black blue, crests are bright blue, and the raised lettering tips into red — which is what
 * sells the height without any lighting.
 *
 * What changed from the original
 * ------------------------------
 * - The original ran at a fixed 1920x1080 design size. This port rebuilds the mesh, the text
 *   raster and the particle field from the stage's real size, and rebuilds them again on resize.
 * - Waits for the bundled Silkscreen font before rasterising, where the old app relied on the page
 *   having loaded it already — without the wait the lift mask would be sampled from a fallback
 *   font's letter shapes.
 * - The old code advanced time in Pixi ticker milliseconds. The SDK clock hands out seconds, so the
 *   hard-coded `WAVE_SPEED = 0.0008` per millisecond became a Wave Speed parameter defaulting to
 *   `0.8` per second — the identical rate in different units.
 * - Every other hard-coded constant (grid size, wave shape, colours, counts) became a parameter
 *   with the original value as its default.
 */

/** Bits of a Cohen–Sutherland style outcode: which viewport edge a point is beyond. */
const CLIP_LEFT = 1;
const CLIP_RIGHT = 2;
const CLIP_TOP = 4;
const CLIP_BOTTOM = 8;

/**
 * The mesh is wider than the viewport so the perspective sway never exposes an edge. A point more
 * than this many pixels outside the frame draws nothing, so it is culled before it costs a
 * Graphics instruction.
 */
const CULL_MARGIN = 4;

/** Blends two 0xRRGGBB colours per channel, `t` clamped to [0, 1]. Copied from the old repo. */
function mixHex(a: number, b: number, t: number): number {
  const amount = Math.max(0, Math.min(1, t));
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  return (
    (Math.round(ar + (br - ar) * amount) << 16) |
    (Math.round(ag + (bg - ag) * amount) << 8) |
    Math.round(ab + (bb - ab) * amount)
  );
}

interface Point3D {
  x: number;
  y: number;
  z: number;
  screenX: number;
  screenY: number;
  /** 0..1 — how strongly the text mask lifts this point out of the surface. */
  lift: number;
}

interface BackgroundParticle {
  x: number;
  y: number;
  homeX: number;
  homeY: number;
  vx: number;
  vy: number;
  size: number;
  color: number;
  alpha: number;
  /** Indices of other particles this one draws faint lines to. */
  connected: number[];
  /** Text particles sit on the lettering and ride its lift instead of drifting. */
  isTextParticle: boolean;
  lift: number;
}

const topography = defineEffect({
  descriptor: {
    id: "topography",
    name: "Luminescent Topography",
    description:
      "A glowing wire-mesh ocean rolling with slow waves, with a word raised out of the surface as terrain and red particles clinging to the lettering.",
    engine: "pixi",
    category: "background",
    tags: ["mesh", "3d", "waves", "text", "terrain", "catppuccin", "break"],
    previewNotes:
      "The word is not drawn as text — it is height, pushed up out of the mesh — so it takes a moment to read. Uses the bundled Silkscreen font for the lettering mask. Turn Background off to lay the mesh over another source.",
    params: [
      {
        key: "text",
        label: "Text",
        kind: "text",
        default: "BREAK",
        description:
          "The word raised out of the mesh. Short words in capitals read best, because each letter needs many grid points to be legible as terrain.",
      },
      {
        key: "rows",
        label: "Grid Rows",
        kind: "number",
        default: 60,
        min: 10,
        max: 150,
        step: 5,
        description:
          "Vertical resolution of the mesh. More rows means finer terrain and more drawing work per frame.",
      },
      {
        key: "cols",
        label: "Grid Columns",
        kind: "number",
        default: 110,
        min: 10,
        max: 250,
        step: 5,
        description: "Horizontal resolution of the mesh. The main performance control.",
      },
      {
        key: "gridSpacing",
        label: "Grid Spacing",
        kind: "number",
        default: 22,
        min: 6,
        max: 60,
        step: 1,
        description:
          "Pixels between mesh points before perspective. Together with rows and columns this sets how far past the frame edges the mesh extends.",
      },
      {
        key: "waveSpeed",
        label: "Wave Speed",
        kind: "number",
        default: 0.8,
        min: 0,
        max: 5,
        step: 0.05,
        description: "How fast the swell rolls through the mesh. 0 freezes the ocean.",
      },
      {
        key: "waveFreq",
        label: "Wave Frequency",
        kind: "number",
        default: 0.018,
        min: 0.002,
        max: 0.1,
        step: 0.001,
        description:
          "Spatial frequency of the waves. Lower values make broad, majestic swells; higher values make choppy ripples.",
      },
      {
        key: "waveAmp",
        label: "Wave Height",
        kind: "number",
        default: 45,
        min: 0,
        max: 200,
        step: 5,
        description:
          "How tall the waves are. Height shows up as brightness and perspective shift, not literal pixels.",
      },
      {
        key: "textLift",
        label: "Text Lift",
        kind: "number",
        default: 160,
        min: 0,
        max: 600,
        step: 10,
        description:
          "How far the lettering is pushed up out of the surface. 0 hides the word entirely; large values tip it fully into the highlight colour.",
      },
      {
        key: "focalLength",
        label: "Focal Length",
        kind: "number",
        default: 2200,
        min: 400,
        max: 8000,
        step: 100,
        description:
          "Strength of the fake perspective. Lower values exaggerate depth and side-sway; the default is deliberately flat and calm.",
      },
      {
        key: "particleCount",
        label: "Drifting Particles",
        kind: "number",
        default: 80,
        min: 0,
        max: 400,
        step: 10,
        description:
          "How many loose particles drift behind the mesh. Some are randomly joined by faint constellation lines.",
      },
      {
        key: "colorDeep",
        label: "Deep Colour",
        kind: "color",
        default: "#001a33",
        description: "The colour of wave troughs — a near-black blue reads as deep water.",
      },
      {
        key: "colorCrest",
        label: "Crest Colour",
        kind: "color",
        default: "#89b4fa",
        description:
          "The colour of wave crests, and of half the drifting particles. Catppuccin Blue.",
      },
      {
        key: "colorPeak",
        label: "Peak Colour",
        kind: "color",
        default: "#f38ba8",
        description:
          "The colour the raised lettering tips into, and of the particles clinging to it. Catppuccin Red.",
      },
      {
        key: "colorAccent",
        label: "Accent Colour",
        kind: "color",
        default: "#74c7ec",
        description: "The other half of the drifting particles. Catppuccin Sapphire.",
      },
      {
        key: "showBackground",
        label: "Background",
        kind: "boolean",
        default: true,
        description:
          "Fill the frame behind the mesh. Turn it off to leave the page transparent and lay the mesh over another OBS source.",
      },
      {
        key: "backgroundColor",
        label: "Background Colour",
        kind: "color",
        default: "#07070a",
        description: "Only used when Background is on.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    // The word is rasterised to build the lift mask, so a substituted fallback font would raise
    // the wrong letter shapes out of the mesh. Silkscreen is bundled with the application.
    await useFont("bold 350px Silkscreen");
    scope.checkpoint();

    const stage = await createPixiStage(scope, ctx);

    // Everything is drawn in coordinates centred on (0, 0), matching the original, because the
    // perspective projection scales points towards the screen centre. One root container placed at
    // the frame's midpoint keeps every per-point calculation free of width/2 offsets.
    const root = stage.stage.addChild(new PIXI.Container());
    const bgGfx = root.addChild(new PIXI.Graphics());
    const particlesGfx = root.addChild(new PIXI.Graphics());
    const meshGfx = root.addChild(new PIXI.Graphics());

    let text = str(ctx.params, "text", "BREAK");
    let rows = int(ctx.params, "rows", 60, 10, 150);
    let cols = int(ctx.params, "cols", 110, 10, 250);
    let gridSpacing = num(ctx.params, "gridSpacing", 22, 6, 60);
    let waveSpeed = num(ctx.params, "waveSpeed", 0.8, 0, 5);
    let waveFreq = num(ctx.params, "waveFreq", 0.018, 0.002, 0.1);
    let waveAmp = num(ctx.params, "waveAmp", 45, 0, 200);
    let textLift = num(ctx.params, "textLift", 160, 0, 600);
    let focalLength = num(ctx.params, "focalLength", 2200, 400, 8000);
    let particleCount = int(ctx.params, "particleCount", 80, 0, 400);
    let colorDeep = colorInt(ctx.params, "colorDeep", "#001a33");
    let colorCrest = colorInt(ctx.params, "colorCrest", "#89b4fa");
    let colorPeak = colorInt(ctx.params, "colorPeak", "#f38ba8");
    let colorAccent = colorInt(ctx.params, "colorAccent", "#74c7ec");
    let showBackground = bool(ctx.params, "showBackground", true);
    let backgroundColor = colorHex(ctx.params, "backgroundColor", "#07070a");

    let points: Point3D[] = [];
    let particles: BackgroundParticle[] = [];

    // Pre-allocated per-frame scratch, rebuilt only when the grid dimensions change — nothing is
    // allocated inside the frame loop.
    //
    // The wave is separable: every point in a column shares the same x term and every point in a
    // row shares the same y term, so the four sin/cos values per point collapse to cols + rows
    // table entries per frame.
    let waveSinX = new Float64Array(cols);
    let waveSinX2 = new Float64Array(cols);
    let waveCosY = new Float64Array(rows);
    let waveSinY2 = new Float64Array(rows);
    // One outcode per mesh point (see CULL_MARGIN).
    let clipCodes = new Uint8Array(rows * cols);

    // Pixi copies these into its own style object on every fill()/stroke(), so one reusable
    // instance per kind replaces ~20k throwaway object literals per frame.
    const scratchFill = { color: 0, alpha: 1 };
    const scratchStroke = { color: 0, alpha: 1, width: 1 };

    const drawBackground = (): void => {
      bgGfx.clear();
      if (!showBackground) return;
      const w = stage.width;
      const h = stage.height;
      bgGfx.rect(-w / 2, -h / 2, w, h).fill({ color: backgroundColor });
    };

    /** Lays out the flat grid of mesh points, centred on the origin. */
    const buildMesh = (): void => {
      points = [];
      const startX = -(cols * gridSpacing) / 2;
      const startY = -(rows * gridSpacing) / 2;
      for (let r = 0; r < rows; r += 1) {
        for (let c = 0; c < cols; c += 1) {
          points.push({
            x: startX + c * gridSpacing,
            y: startY + r * gridSpacing,
            z: 0,
            screenX: 0,
            screenY: 0,
            lift: 0,
          });
        }
      }
      waveSinX = new Float64Array(cols);
      waveSinX2 = new Float64Array(cols);
      waveCosY = new Float64Array(rows);
      waveSinY2 = new Float64Array(rows);
      clipCodes = new Uint8Array(rows * cols);
    };

    /** Scatters the loose drifting particles, some randomly wired to others with faint lines. */
    const buildDriftParticles = (): void => {
      particles = [];
      const w = stage.width;
      const h = stage.height;
      for (let i = 0; i < particleCount; i += 1) {
        const px = (Math.random() - 0.5) * w;
        const py = (Math.random() - 0.5) * h;
        const p: BackgroundParticle = {
          x: px,
          y: py,
          homeX: px,
          homeY: py,
          vx: (Math.random() - 0.5) * 12,
          vy: (Math.random() - 0.5) * 12,
          size: 1 + Math.random() * 2,
          color: Math.random() > 0.5 ? colorCrest : colorAccent,
          alpha: 0.1 + Math.random() * 0.2,
          connected: [],
          isTextParticle: false,
          lift: 0,
        };
        // Roughly a third of particles connect to 2..4 random others, giving the sparse
        // constellation lines behind the mesh.
        if (Math.random() > 0.7) {
          const count = 2 + Math.floor(Math.random() * 3);
          for (let j = 0; j < count; j += 1) {
            p.connected.push(Math.floor(Math.random() * particleCount));
          }
        }
        particles.push(p);
      }
    };

    /**
     * Rasterises the word to an offscreen canvas and reads it back twice: once to give each mesh
     * point its lift value, and once to sprinkle red particles over the bright pixels so the
     * raised lettering sparkles.
     */
    const buildTextMask = (): void => {
      const w = Math.max(1, Math.round(stage.width));
      const h = Math.max(1, Math.round(stage.height));

      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (context === null) return;

      context.fillStyle = "black";
      context.fillRect(0, 0, w, h);
      context.fillStyle = "white";
      context.font = "bold 350px Silkscreen";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(text, w / 2, h / 2);

      const imageData = context.getImageData(0, 0, w, h).data;

      // Mesh points and the canvas use different origins: points are centred on (0, 0), the
      // canvas has (0, 0) top-left, hence the half-size shifts. Reading only the red channel is
      // enough — the raster is pure black and white.
      for (const p of points) {
        p.lift = 0;
        const tx = Math.floor(p.x + w / 2);
        const ty = Math.floor(p.y + h / 2);
        if (tx >= 0 && tx < w && ty >= 0 && ty < h) {
          p.lift = (imageData[(ty * w + tx) * 4] ?? 0) / 255;
        }
      }

      // Sample every 4th pixel and keep one in five of the bright ones, so the lettering gets a
      // dusting of particles rather than a solid fill.
      const step = 4;
      for (let y = 0; y < h; y += step) {
        for (let x = 0; x < w; x += step) {
          const liftValue = (imageData[(y * w + x) * 4] ?? 0) / 255;
          if (liftValue > 0.5 && Math.random() > 0.8) {
            const px = x - w / 2;
            const py = y - h / 2;
            particles.push({
              x: px,
              y: py,
              homeX: px,
              homeY: py,
              vx: 0,
              vy: 0,
              size: 1 + Math.random() * 1.5,
              color: colorPeak,
              alpha: 0.5 + Math.random() * 0.4,
              connected: [],
              isTextParticle: true,
              lift: liftValue,
            });
          }
        }
      }

      // Release the raster's memory now instead of waiting for garbage collection.
      canvas.width = 1;
      canvas.height = 1;
    };

    /** Full rebuild: mesh grid, drifting particles, then the text mask on top of both. */
    const build = (): void => {
      buildMesh();
      buildDriftParticles();
      buildTextMask();
      drawBackground();
    };

    root.x = stage.width / 2;
    root.y = stage.height / 2;
    build();

    stage.onResize((w, h) => {
      root.x = w / 2;
      root.y = h / 2;
      // The text raster and particle field were sized for the old frame, so both must be rebuilt
      // — the mesh keeps its own dimensions, but its lift mask depends on the frame size.
      build();
    });

    /** Maps a height to a colour: deep → crest over the lower half, crest → peak above. */
    const getColorForZ = (z: number): number => {
      const t = (z + waveAmp) / (waveAmp + textLift);
      if (t < 0.45) return mixHex(colorDeep, colorCrest, t * 2.2);
      return mixHex(colorCrest, colorPeak, (t - 0.45) * 1.8);
    };

    const drawEdge = (p1: Point3D, p2: Point3D): void => {
      const avgZ = (p1.z + p2.z) / 2;

      // A stretched edge (its points pulled apart by differing perspective) draws thinner, which
      // makes steep slopes look taut.
      const dx = p1.screenX - p2.screenX;
      const dy = p1.screenY - p2.screenY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const tension = Math.max(0.1, 1 - (dist - gridSpacing) / gridSpacing);

      scratchStroke.color = getColorForZ(avgZ);
      scratchStroke.alpha = 0.05 + ((avgZ + waveAmp) / (waveAmp + textLift)) * 0.35;
      scratchStroke.width = 0.4 * tension;
      meshGfx.moveTo(p1.screenX, p1.screenY).lineTo(p2.screenX, p2.screenY).stroke(scratchStroke);
    };

    let elapsed = 0;

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      elapsed += dt;
      const time = elapsed * waveSpeed;

      // A slow whole-surface heave on top of the travelling waves, so the centre visibly breathes.
      const globalSwell = Math.sin(time * 0.8) * 15;

      // ── Update the mesh ─────────────────────────────────────────────────
      // Row 0 carries every distinct x, column 0 every distinct y, so the trig tables cover the
      // whole grid.
      for (let c = 0; c < cols; c += 1) {
        const x = points[c]?.x ?? 0;
        waveSinX[c] = Math.sin(x * waveFreq + time);
        waveSinX2[c] = Math.sin(x * waveFreq * 0.6 - time * 0.4);
      }
      for (let r = 0; r < rows; r += 1) {
        const y = points[r * cols]?.y ?? 0;
        waveCosY[r] = Math.cos(y * waveFreq + time * 0.7);
        waveSinY2[r] = Math.sin(y * waveFreq * 0.5 + time * 0.2);
      }

      const clipX = stage.width / 2 + CULL_MARGIN;
      const clipY = stage.height / 2 + CULL_MARGIN;

      for (let r = 0; r < rows; r += 1) {
        const cosY = waveCosY[r] ?? 0;
        const sinY2 = waveSinY2[r] ?? 0;
        const rowStart = r * cols;

        for (let c = 0; c < cols; c += 1) {
          const i = rowStart + c;
          const p = points[i];
          if (p === undefined) continue;

          const noise = (waveSinX[c] ?? 0) * cosY;
          const noise2 = (waveSinX2[c] ?? 0) * sinY2;

          const baseZ = (noise + noise2 * 0.5) * waveAmp + globalSwell;
          p.z = baseZ + p.lift * textLift;

          const perspective = focalLength / (focalLength + p.z);
          const screenX = p.x * perspective;
          const screenY = p.y * perspective;
          p.screenX = screenX;
          p.screenY = screenY;

          let code = 0;
          if (screenX < -clipX) code = CLIP_LEFT;
          else if (screenX > clipX) code = CLIP_RIGHT;
          if (screenY < -clipY) code |= CLIP_TOP;
          else if (screenY > clipY) code |= CLIP_BOTTOM;
          clipCodes[i] = code;
        }
      }

      // ── Update the particles ────────────────────────────────────────────
      // Hoisted out of the loop: identical for every particle this frame.
      const timeY = time * 0.7;
      const time2X = time * 0.4;
      const time2Y = time * 0.2;
      const halfW = stage.width / 2;
      const halfH = stage.height / 2;

      for (const p of particles) {
        if (p.isTextParticle) {
          // Text particles ride the same wave arithmetic as the mesh, including their lift, so
          // they stay glued to the raised lettering.
          const noise =
            Math.sin(p.homeX * waveFreq + time) * Math.cos(p.homeY * waveFreq + timeY);
          const noise2 =
            Math.sin(p.homeX * waveFreq * 0.6 - time2X) *
            Math.sin(p.homeY * waveFreq * 0.5 + time2Y);
          const z = (noise + noise2 * 0.5) * waveAmp + globalSwell + p.lift * textLift;
          const perspective = focalLength / (focalLength + z);
          p.x = p.homeX * perspective;
          p.y = p.homeY * perspective;
        } else {
          // The original advanced positions by `vx * deltaMS * 0.01` per Pixi tick; the SDK clock
          // hands out seconds, so the factor becomes 10 for the identical drift rate.
          p.homeX += p.vx * dt * 10;
          p.homeY += p.vy * dt * 10;

          if (p.homeX > halfW) p.homeX = -halfW;
          if (p.homeX < -halfW) p.homeX = halfW;
          if (p.homeY > halfH) p.homeY = -halfH;
          if (p.homeY < -halfH) p.homeY = halfH;

          const noise =
            Math.sin(p.homeX * waveFreq + time) * Math.cos(p.homeY * waveFreq + timeY);
          const z = noise * waveAmp + globalSwell;
          const perspective = focalLength / (focalLength + z);
          p.x = p.homeX * perspective;
          p.y = p.homeY * perspective;
        }
      }

      // ── Draw the mesh ───────────────────────────────────────────────────
      meshGfx.clear();

      for (let r = 0; r < rows; r += 1) {
        const rowStart = r * cols;
        for (let c = 0; c < cols; c += 1) {
          const i = rowStart + c;
          const code = clipCodes[i] ?? 0;
          const p = points[i];
          if (p === undefined) continue;

          // Two points sharing an outside bit are both beyond the same viewport edge, so their
          // connecting segment can never contribute a pixel and is skipped.
          const right = points[i + 1];
          if (c < cols - 1 && right !== undefined && (code & (clipCodes[i + 1] ?? 0)) === 0) {
            drawEdge(p, right);
          }
          const below = points[i + cols];
          if (r < rows - 1 && below !== undefined && (code & (clipCodes[i + cols] ?? 0)) === 0) {
            drawEdge(p, below);
          }
        }
      }

      // A small dot at every visible vertex, brighter the higher it sits.
      for (let i = 0; i < points.length; i += 1) {
        if ((clipCodes[i] ?? 0) !== 0) continue;
        const p = points[i];
        if (p === undefined) continue;
        scratchFill.color = getColorForZ(p.z);
        scratchFill.alpha = 0.2 + ((p.z + waveAmp) / (waveAmp + textLift)) * 0.6;
        meshGfx.circle(p.screenX, p.screenY, 1.2).fill(scratchFill);
      }

      // ── Draw the particles ──────────────────────────────────────────────
      particlesGfx.clear();
      for (const p of particles) {
        scratchFill.color = p.color;
        scratchFill.alpha = p.alpha;
        particlesGfx.circle(p.x, p.y, p.size).fill(scratchFill);

        // Text particles are created without connections and never gain any.
        if (p.isTextParticle) continue;

        for (const targetIndex of p.connected) {
          const target = particles[targetIndex];
          if (target === undefined) continue;
          scratchStroke.color = p.color;
          scratchStroke.alpha = p.alpha * 0.3;
          scratchStroke.width = 0.5;
          particlesGfx.moveTo(p.x, p.y).lineTo(target.x, target.y).stroke(scratchStroke);
        }
      }

      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        // Everything the build functions bake into the mesh, mask or particle field. A change in
        // any of them rebuilds those structures in place — the stage and canvas stay alive, so
        // there is no black frame on air.
        const before = [text, rows, cols, gridSpacing, particleCount, colorPeak].join("|");
        const colorsBefore = [colorCrest, colorAccent, backgroundColor, showBackground].join("|");

        text = str(p, "text", "BREAK");
        rows = int(p, "rows", 60, 10, 150);
        cols = int(p, "cols", 110, 10, 250);
        gridSpacing = num(p, "gridSpacing", 22, 6, 60);
        waveSpeed = num(p, "waveSpeed", 0.8, 0, 5);
        waveFreq = num(p, "waveFreq", 0.018, 0.002, 0.1);
        waveAmp = num(p, "waveAmp", 45, 0, 200);
        textLift = num(p, "textLift", 160, 0, 600);
        focalLength = num(p, "focalLength", 2200, 400, 8000);
        particleCount = int(p, "particleCount", 80, 0, 400);
        colorDeep = colorInt(p, "colorDeep", "#001a33");
        colorCrest = colorInt(p, "colorCrest", "#89b4fa");
        colorPeak = colorInt(p, "colorPeak", "#f38ba8");
        colorAccent = colorInt(p, "colorAccent", "#74c7ec");
        showBackground = bool(p, "showBackground", true);
        backgroundColor = colorHex(p, "backgroundColor", "#07070a");

        if ([text, rows, cols, gridSpacing, particleCount, colorPeak].join("|") !== before) {
          build();
        } else if (
          [colorCrest, colorAccent, backgroundColor, showBackground].join("|") !== colorsBefore
        ) {
          // Drifting-particle colours are baked at spawn and the background is drawn once, so a
          // colour-only change redraws those without disturbing the mesh or the text mask.
          buildDriftParticles();
          drawBackground();
        }
      },
    };
  },
});

export default topography;
