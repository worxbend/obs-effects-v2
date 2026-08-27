import * as PIXI from "pixi.js";

import { bool, colorHex, num, str } from "../paramUtils";
import { createPixiStage, defineEffect, onFrame } from "../sdk";

/**
 * Cat Mesh
 * ========
 *
 * A cat silhouette built from a triangulated mesh of dots, rippling as a wave travels through it —
 * points lifting, drifting sideways and brightening as the crest passes under them.
 *
 * Ported from `cat-mesh.html` in the old `obs-effects` repository, recoloured to the razer toxic
 * green palette as asked (the original was Catppuccin mauve; Dot Colour changes it back).
 *
 * ## The shape comes from an image, but nothing draws the image
 *
 * `public/effects/cat-shape.png` is a black cat silhouette on white. At setup it is drawn once into
 * an offscreen canvas, read back with `getImageData`, and every dark pixel on a 5-pixel grid becomes
 * a node. The picture is then thrown away: from that moment the effect is a few thousand points and
 * the edges between them, which is why the result stays sharp at any canvas size and why every node
 * can move independently.
 *
 * That also means **any silhouette works**. Point Shape Image at your own black-on-white PNG and the
 * effect becomes a mesh of that instead. It is the only parameter here that changes what the thing
 * *is* rather than how it looks.
 *
 * ## Reading pixels needs the image to be same-origin
 *
 * `getImageData` on a canvas that has had a cross-origin image drawn into it throws a security
 * error — the canvas is "tainted", because otherwise any page could read pixels from images it is
 * not allowed to see. So a Shape Image from another domain will fail, and the effect reports that
 * and draws nothing rather than throwing. Serve your own image from this application.
 *
 * ## Why the mesh is triangulated rather than a grid
 *
 * Each node links to its right, down and *both* diagonal neighbours. Linking only right and down
 * gives squares, and a square mesh folds visibly along its rows when a wave passes through it. The
 * diagonals brace it, so the surface reads as a continuous membrane.
 */

/** The image's design size. Everything is scaled from this, so a different image still fits. */
const IMG_SIZE = 800;

/** Pixels between samples. Smaller is a denser mesh and quadratically more work. */
const SAMPLE_STEP = 5;

interface MeshNode {
  gridCol: number;
  gridRow: number;
  baseX: number;
  baseY: number;
  phase: number;
  x: number;
  y: number;
  /** -1 to 1: how high this node currently sits in the wave. */
  elev: number;
  neighbors: number[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

const catMesh = defineEffect({
  descriptor: {
    id: "cat-mesh",
    name: "Cat Mesh",
    description:
      "A cat silhouette built from a triangulated mesh of dots, rippling in toxic green as a wave travels through it.",
    engine: "pixi",
    category: "background",
    tags: ["cat", "mesh", "wireframe", "wave", "razer", "green"],
    previewNotes:
      "Transparent behind the mesh, so it works over a scene or on its own. Point Shape Image at any black-on-white silhouette to get a mesh of that instead — it must be served from this application, because reading pixels from another domain is blocked by the browser.",
    params: [
      {
        key: "image",
        label: "Shape Image",
        kind: "text",
        default: "/effects/cat-shape.png",
        description:
          "A black-on-white silhouette. Dark pixels become mesh nodes. Must be served from this application; a URL on another domain cannot be read back.",
      },
      {
        key: "speed",
        label: "Speed",
        kind: "number",
        default: 1,
        min: 0,
        max: 4,
        step: 0.05,
        description: "How fast the wave travels through the mesh. 0 freezes it mid-ripple.",
      },
      {
        key: "size",
        label: "Size",
        kind: "number",
        default: 0.88,
        min: 0.2,
        max: 1.2,
        step: 0.02,
        description: "How much of the frame's shorter side the shape fills.",
      },
      {
        key: "lift",
        label: "Lift",
        kind: "number",
        default: 8,
        min: 0,
        max: 40,
        step: 0.5,
        description:
          "How far a node rises at the crest of the wave, in pixels. This is what gives the flat mesh depth.",
      },
      {
        key: "drift",
        label: "Drift",
        kind: "number",
        default: 3,
        min: 0,
        max: 20,
        step: 0.5,
        description: "Sideways wander as a node lifts, in pixels.",
      },
      {
        key: "dotSize",
        label: "Dot Size",
        kind: "number",
        default: 1,
        min: 0.2,
        max: 4,
        step: 0.05,
        description: "Multiplier on node radius.",
      },
      {
        key: "edges",
        label: "Edges",
        kind: "boolean",
        default: true,
        description:
          "Draw the lines between neighbouring nodes. Off leaves a field of loose dots, which is a legitimate and much cheaper look.",
      },
      {
        key: "glow",
        label: "Crest Glow",
        kind: "boolean",
        default: true,
        description: "A soft halo behind nodes near the top of the wave.",
      },
      {
        key: "dotColor",
        label: "Dot Colour",
        kind: "color",
        default: "#39ff14",
        description: "Nodes and edges. The original used Catppuccin mauve, #cba6f7.",
      },
      {
        key: "background",
        label: "Background",
        kind: "boolean",
        default: false,
        description: "Fill the frame behind the mesh. Off by default so it can sit over a scene.",
      },
      {
        key: "backgroundColor",
        label: "Background Colour",
        kind: "color",
        default: "#000700",
        description: "Only used when Background is on.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    const stage = await createPixiStage(scope, ctx);

    const backgroundLayer = stage.stage.addChild(new PIXI.Graphics());
    const meshLayer = stage.stage.addChild(new PIXI.Graphics());

    let imageSrc = str(ctx.params, "image", "/effects/cat-shape.png");
    let speed = num(ctx.params, "speed", 1, 0, 4);
    let sizeFraction = num(ctx.params, "size", 0.88, 0.2, 1.2);
    let liftAmount = num(ctx.params, "lift", 8, 0, 40);
    let driftAmount = num(ctx.params, "drift", 3, 0, 20);
    let dotSize = num(ctx.params, "dotSize", 1, 0.2, 4);
    let showEdges = bool(ctx.params, "edges", true);
    let showGlow = bool(ctx.params, "glow", true);
    let dotColor = colorHex(ctx.params, "dotColor", "#39ff14");
    let drawBackground = bool(ctx.params, "background", false);
    let backgroundColor = colorHex(ctx.params, "backgroundColor", "#000700");

    let nodes: MeshNode[] = [];
    let imageWidth = IMG_SIZE;
    let imageHeight = IMG_SIZE;
    let scaleFactor = 1;
    let originX = 0;
    let originY = 0;

    /** Loads an image, resolving to `null` rather than rejecting if it cannot be fetched. */
    const loadImage = (src: string): Promise<HTMLImageElement | null> =>
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = src;
      });

    const computeScale = (): void => {
      const longest = Math.max(imageWidth, imageHeight);
      scaleFactor = (Math.min(stage.width, stage.height) * sizeFraction) / longest;
      originX = (stage.width - imageWidth * scaleFactor) * 0.5;
      originY = (stage.height - imageHeight * scaleFactor) * 0.5;
    };

    /** Repositions existing nodes after a resize, without re-reading the image. */
    const rescale = (): void => {
      computeScale();
      for (const node of nodes) {
        node.baseX = originX + node.gridCol * SAMPLE_STEP * scaleFactor;
        node.baseY = originY + node.gridRow * SAMPLE_STEP * scaleFactor;
      }
    };

    /** Reads the silhouette and turns its dark pixels into a linked mesh. */
    const build = async (src: string): Promise<void> => {
      const img = await loadImage(src);
      if (img === null) {
        console.error(`[cat-mesh] Could not load the shape image "${src}"; nothing will be drawn.`);
        nodes = [];
        return;
      }

      imageWidth = img.naturalWidth;
      imageHeight = img.naturalHeight;

      // The offscreen canvas exists only for this read and is shrunk immediately afterwards: a
      // full-size one holds several megabytes of backing store until the collector gets to it.
      const canvas = document.createElement("canvas");
      canvas.width = imageWidth;
      canvas.height = imageHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (context === null) {
        console.error("[cat-mesh] No 2D context available; nothing will be drawn.");
        nodes = [];
        return;
      }
      context.drawImage(img, 0, 0);

      let pixels: Uint8ClampedArray;
      try {
        pixels = context.getImageData(0, 0, imageWidth, imageHeight).data;
      } catch {
        // A cross-origin image taints the canvas and makes this throw. Reported rather than left as
        // a mystery blank frame — this is the one failure an operator can actually fix.
        console.error(
          `[cat-mesh] Cannot read pixels from "${src}". The image must be served from this ` +
            "application; a cross-origin image cannot be sampled.",
        );
        nodes = [];
        return;
      } finally {
        canvas.width = 1;
        canvas.height = 1;
      }

      const cols = Math.ceil(imageWidth / SAMPLE_STEP);
      const rows = Math.ceil(imageHeight / SAMPLE_STEP);
      // A lookup from grid cell to node index, so edges can be found without searching.
      const grid: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(-1));

      computeScale();
      nodes = [];

      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
          const px = col * SAMPLE_STEP;
          const py = row * SAMPLE_STEP;
          if (px >= imageWidth || py >= imageHeight) continue;

          const i = (py * imageWidth + px) * 4;
          const r = pixels[i] ?? 0;
          const g = pixels[i + 1] ?? 0;
          const b = pixels[i + 2] ?? 0;
          const a = pixels[i + 3] ?? 0;

          // Opaque and dark: the silhouette is black on white, so the sum of the channels being
          // low is what identifies the body.
          if (a > 128 && r + g + b < 192) {
            const gridRow = grid[row];
            if (gridRow !== undefined) gridRow[col] = nodes.length;
            nodes.push({
              gridCol: col,
              gridRow: row,
              baseX: originX + px * scaleFactor,
              baseY: originY + py * scaleFactor,
              // A per-node phase offset derived from its position, so the wave has texture rather
              // than every node in a row moving in lockstep.
              phase: ((row * 0.37 + col * 0.19) % 1) * Math.PI * 2,
              x: 0,
              y: 0,
              elev: 0,
              neighbors: [],
            });
          }
        }
      }

      // Right, down and both diagonals — a triangulated mesh. See the header for why the diagonals
      // matter.
      for (const node of nodes) {
        const { gridCol: col, gridRow: row } = node;
        for (const [dr, dc] of [
          [0, 1],
          [1, 0],
          [1, 1],
          [1, -1],
        ] as const) {
          const neighbour = grid[row + dr]?.[col + dc] ?? -1;
          if (neighbour >= 0) node.neighbors.push(neighbour);
        }
      }
    };

    await build(imageSrc);
    scope.checkpoint();

    stage.onResize(rescale);

    let time = 0;

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      // The original folded a 0.55 wave-speed constant in before using the clock; kept so the
      // ripple travels at its original rate.
      time += Math.min(dt, 0.05) * speed * 0.55;

      backgroundLayer.clear();
      if (drawBackground) {
        backgroundLayer.rect(0, 0, stage.width, stage.height).fill({ color: backgroundColor });
      }

      // ── Advance the wave ────────────────────────────────────────────────
      for (const node of nodes) {
        const bx = node.baseX * 0.024;
        const by = node.baseY * 0.024;
        const ph = node.phase;

        // Three waves at unrelated rates: a large primary swell, a diagonal secondary, and a fast
        // micro ripple. Summed, they never repeat visibly.
        const primary = Math.sin(bx * 1.85 - time * 1.15 + ph) * Math.cos(by * 1.4 + time * 0.82);
        const secondary = Math.sin((bx + by) * 0.88 - time * 0.7 + ph * 0.65) * 0.55;
        const micro = Math.sin(bx * 3.7 + time * 2.1 + ph * 1.4) * 0.18;

        node.elev = clamp(primary * 0.6 + secondary * 0.3 + micro, -1, 1);
        // Only crests lift; troughs stay put. Letting nodes sink as well would make the silhouette
        // ripple like water rather than reading as a surface catching light.
        const lift = Math.max(0, node.elev);
        node.x = node.baseX + Math.cos(ph + time * 0.27) * lift * driftAmount;
        node.y = node.baseY - lift * liftAmount;
      }

      // ── Draw ────────────────────────────────────────────────────────────
      meshLayer.clear();

      if (showEdges) {
        for (const node of nodes) {
          for (const index of node.neighbors) {
            const other = nodes[index];
            if (other === undefined) continue;
            const average = (node.elev + other.elev) * 0.5;
            // Edges between nodes at different heights are brighter and thicker, which is what
            // picks out the slopes of the wave rather than lighting the whole mesh evenly.
            const relief = Math.abs(node.elev - other.elev);
            meshLayer
              .moveTo(node.x, node.y)
              .lineTo(other.x, other.y)
              .stroke({
                color: dotColor,
                width: 0.25 + relief * 0.5,
                alpha: clamp(0.08 + (average + 1) * 0.1 + relief * 0.25, 0, 0.45),
              });
          }
        }
      }

      for (const node of nodes) {
        const normalised = (node.elev + 1) * 0.5;
        const lift = Math.max(0, node.elev);
        const radius = (0.38 + normalised * 1.1 + lift * 1.2) * dotSize;
        const alpha = clamp(0.3 + normalised * 0.7, 0, 1);

        if (showGlow && lift > 0.4) {
          meshLayer
            .circle(node.x, node.y, radius * 2.6)
            .fill({ color: dotColor, alpha: alpha * 0.12 });
        }
        meshLayer.circle(node.x, node.y, radius).fill({ color: dotColor, alpha });
      }

      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        const previousImage = imageSrc;
        const previousSize = sizeFraction;

        imageSrc = str(p, "image", "/effects/cat-shape.png");
        speed = num(p, "speed", 1, 0, 4);
        sizeFraction = num(p, "size", 0.88, 0.2, 1.2);
        liftAmount = num(p, "lift", 8, 0, 40);
        driftAmount = num(p, "drift", 3, 0, 20);
        dotSize = num(p, "dotSize", 1, 0.2, 4);
        showEdges = bool(p, "edges", true);
        showGlow = bool(p, "glow", true);
        dotColor = colorHex(p, "dotColor", "#39ff14");
        drawBackground = bool(p, "background", false);
        backgroundColor = colorHex(p, "backgroundColor", "#000700");

        // A new image means re-reading pixels and rebuilding every node, which is asynchronous. The
        // promise is deliberately not awaited — `setParams` is synchronous by contract, and the mesh
        // simply appears when it is ready.
        if (imageSrc !== previousImage) {
          void build(imageSrc);
        } else if (sizeFraction !== previousSize) {
          rescale();
        }
      },
    };
  },
});

export default catMesh;
