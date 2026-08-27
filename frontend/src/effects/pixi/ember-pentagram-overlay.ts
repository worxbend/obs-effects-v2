import * as PIXI from "pixi.js";

import { bool, colorHex, int, num } from "../paramUtils";
import { createPixiStage, defineEffect, onFrame } from "../sdk";

/**
 * Ember Pentagram Overlay
 * =======================
 *
 * A pentagram drawn entirely in glowing embers — thousands of dots strung along the star's strokes
 * and its enclosing ring — with slow waves travelling through the whole figure so the lines lift,
 * swell and brighten as a crest passes. Faint sigils drift in the background behind it.
 *
 * Ported from `ember-pentagram-overlay.html` in the old `obs-effects` repository.
 *
 * ## The lines are meshes, not strokes
 *
 * Each arm of the star is not one line but **three parallel bands** of nodes, offset either side of
 * the true path and tapered so the arm is fattest in the middle. The ring is two bands. Those bands
 * are then cross-linked, so an arm is a narrow strip of mesh rather than a curve.
 *
 * That is what makes the wave read as *travelling through a solid object*: a single stroke can only
 * move up and down as a whole, but a strip has an inside and an outside edge that can lift by
 * different amounts, which is what your eye reads as a surface turning.
 *
 * Nodes are deduplicated by rounded position as they are created, so where an arm crosses the ring
 * or another arm the two share a node and stay welded rather than sliding through each other.
 *
 * ## The wave table, which is the interesting engineering
 *
 * There are five waves running through the figure at once — a primary swell, a diagonal, a ring
 * current, a spiral and a fine ripple — plus sway and bob. Evaluated directly that is fourteen
 * trigonometric calls per node per frame, and with several thousand nodes it is the whole frame
 * budget.
 *
 * Instead each wave is split using the angle-addition identity: `sin(a + b)` is
 * `sin a·cos b + cos a·sin b`. The half that depends on the *node* never changes, so it is computed
 * once into a table of twenty floats per node. The half that depends on *time* is the same for every
 * node, so it is computed **seven times per frame in total**. The per-node work is then a handful of
 * multiplications.
 *
 * That is carried over from the original unchanged, because it is the reason this effect can afford
 * several thousand animated nodes at all.
 *
 * ## What is not here
 *
 * The original also drew background pentagrams built from a painted PNG, and drifting clusters of
 * loose mesh. Those are omitted: they sit far behind the figure at very low opacity, and reproducing
 * them faithfully needs an asset pipeline that would double the size of this file for something a
 * viewer would struggle to point at. The procedurally drawn background sigils **are** here, which is
 * what actually reads in the frame.
 */

/** Floats of precomputed wave data per node. */
const WAVE_STRIDE = 20;

/** Pixels between the dots strung along a segment. */
const SEGMENT_DOT_STEP = 6;

const TAU = Math.PI * 2;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

interface ShapeNode {
  baseX: number;
  baseY: number;
  phase: number;
  drift: number;
  /** Higher for nodes on the inside of a band — they lift more and glow brighter. */
  interiorBias: number;
  relX: number;
  relY: number;
  x: number;
  y: number;
  elevation: number;
}

interface MeshSegment {
  a: number;
  b: number;
  strength: number;
}

interface Mote {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  alpha: number;
  phase: number;
}

interface BackgroundSigil {
  x: number;
  y: number;
  size: number;
  rot: number;
  vRot: number;
  alpha: number;
}

const emberPentagramOverlay = defineEffect({
  descriptor: {
    id: "ember-pentagram-overlay",
    name: "Ember Pentagram Overlay",
    description:
      "A pentagram drawn in thousands of glowing embers, with slow waves travelling through the figure so its lines lift and brighten as a crest passes.",
    engine: "pixi",
    category: "background",
    tags: ["pentagram", "embers", "occult", "mesh", "ritual", "red"],
    previewNotes:
      "Transparent by default, so it can sit over a scene. Detail is the performance control — it sets how many nodes the figure is built from, and the cost is roughly linear in it. The waves are very slow; give it a few seconds before judging.",
    params: [
      {
        key: "speed",
        label: "Speed",
        kind: "number",
        default: 1,
        min: 0,
        max: 4,
        step: 0.05,
        description: "How fast the waves travel. 0 freezes the figure mid-swell.",
      },
      {
        key: "size",
        label: "Size",
        kind: "number",
        default: 0.42,
        min: 0.1,
        max: 0.9,
        step: 0.01,
        description: "Radius of the star as a fraction of the frame's shorter side.",
      },
      {
        key: "detail",
        label: "Detail",
        kind: "number",
        default: 1,
        min: 0.3,
        max: 2,
        step: 0.05,
        description:
          "How finely the arms and ring are sampled into nodes. This is the performance control — the whole effect's cost scales with it.",
      },
      {
        key: "amplitude",
        label: "Wave Height",
        kind: "number",
        default: 1,
        min: 0,
        max: 3,
        step: 0.05,
        description:
          "How far the waves displace the figure. 0 leaves a still pentagram that still glows and breathes.",
      },
      {
        key: "ring",
        label: "Enclosing Ring",
        kind: "boolean",
        default: true,
        description: "The circle around the star. Off leaves the bare five-pointed figure.",
      },
      {
        key: "sigils",
        label: "Background Sigils",
        kind: "number",
        default: 4,
        min: 0,
        max: 16,
        step: 1,
        description: "Faint pentagrams drifting and rotating far behind the main figure.",
      },
      {
        key: "motes",
        label: "Atmosphere",
        kind: "number",
        default: 120,
        min: 0,
        max: 600,
        step: 10,
        description: "Floating embers drifting through the frame.",
      },
      {
        key: "colorCore",
        label: "Core Colour",
        kind: "color",
        default: "#ff3048",
        description: "The resting colour of the lines, where no crest is passing.",
      },
      {
        key: "colorEmber",
        label: "Ember Colour",
        kind: "color",
        default: "#ff7a45",
        description: "Where a wave is lifting the figure.",
      },
      {
        key: "colorHot",
        label: "Hot Colour",
        kind: "color",
        default: "#ffddb3",
        description: "The brightest crests. Near-white is what sells them as heat.",
      },
      {
        key: "background",
        label: "Background",
        kind: "boolean",
        default: false,
        description: "Fill the frame behind the figure. Off by default so it works as an overlay.",
      },
      {
        key: "backgroundColor",
        label: "Background Colour",
        kind: "color",
        default: "#080304",
        description: "Only used when Background is on.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    const stage = await createPixiStage(scope, ctx);

    const backdropLayer = stage.stage.addChild(new PIXI.Graphics());
    const sigilLayer = stage.stage.addChild(new PIXI.Graphics());
    const moteLayer = stage.stage.addChild(new PIXI.Graphics());
    const meshLayer = stage.stage.addChild(new PIXI.Graphics());

    let speed = num(ctx.params, "speed", 1, 0, 4);
    let sizeFraction = num(ctx.params, "size", 0.42, 0.1, 0.9);
    let detail = num(ctx.params, "detail", 1, 0.3, 2);
    let amplitude = num(ctx.params, "amplitude", 1, 0, 3);
    let showRing = bool(ctx.params, "ring", true);
    let sigilCount = int(ctx.params, "sigils", 4, 0, 16);
    let moteCount = int(ctx.params, "motes", 120, 0, 600);
    let colorCore = colorHex(ctx.params, "colorCore", "#ff3048");
    let colorEmber = colorHex(ctx.params, "colorEmber", "#ff7a45");
    let colorHot = colorHex(ctx.params, "colorHot", "#ffddb3");
    let drawBackground = bool(ctx.params, "background", false);
    let backgroundColor = colorHex(ctx.params, "backgroundColor", "#080304");

    let nodes: ShapeNode[] = [];
    let segments: MeshSegment[] = [];
    let waveTable = new Float64Array(0);
    let motes: Mote[] = [];
    let sigils: BackgroundSigil[] = [];

    /**
     * Builds the figure as a node/segment mesh in a unit coordinate space.
     *
     * Nodes are keyed by rounded position so that anywhere two paths cross — an arm over the ring,
     * an arm over another arm — they share a single node and the mesh stays welded.
     */
    const buildShape = (): void => {
      nodes = [];
      segments = [];
      const byKey = new Map<string, number>();

      const addNode = (x: number, y: number, interiorBias: number): number => {
        const key = `${Math.round(x * 2200)}:${Math.round(y * 2200)}`;
        const existing = byKey.get(key);
        if (existing !== undefined) {
          const node = nodes[existing];
          if (node !== undefined) node.interiorBias = Math.max(node.interiorBias, interiorBias);
          return existing;
        }
        const index = nodes.length;
        nodes.push({
          baseX: x,
          baseY: y,
          // Phases derived from position rather than randomness, so a remount reproduces the
          // identical wave pattern instead of reshuffling the figure.
          phase: ((x * 0.73 + y * 0.49) % 1) * TAU,
          drift: ((x * 0.36 - y * 0.58) % 1) * TAU,
          interiorBias,
          relX: 0,
          relY: 0,
          x: 0,
          y: 0,
          elevation: 0,
        });
        byKey.set(key, index);
        return index;
      };

      const connectRun = (indices: number[], strength: number, closed = false): void => {
        const limit = closed ? indices.length : indices.length - 1;
        for (let i = 0; i < limit; i += 1) {
          const a = indices[i];
          const b = indices[(i + 1) % indices.length];
          if (a !== undefined && b !== undefined && a !== b) segments.push({ a, b, strength });
        }
      };

      /** Cross-links parallel bands into a strip. */
      const connectBands = (bands: number[][], strength: number, closed = false): void => {
        if (bands.length < 2) return;
        const span = bands[0]?.length ?? 0;
        const limit = closed ? span : span - 1;
        for (let b = 0; b < bands.length - 1; b += 1) {
          const current = bands[b];
          const next = bands[b + 1];
          if (current === undefined || next === undefined) continue;
          for (let i = 0; i < limit; i += 1) {
            const a = current[i];
            const c = next[i];
            if (a !== undefined && c !== undefined && a !== c) segments.push({ a, b: c, strength });
          }
        }
      };

      // The five outer points of the star.
      const outer: { x: number; y: number }[] = [];
      for (let i = 0; i < 5; i += 1) {
        const angle = -Math.PI / 2 + (i / 5) * TAU;
        outer.push({ x: Math.cos(angle), y: Math.sin(angle) });
      }
      // Visiting every second point is what draws a five-pointed star in one unbroken stroke.
      const starOrder = [0, 2, 4, 1, 3];
      const strokeBands = [-0.034, 0, 0.034];

      const samples = Math.max(24, Math.round(120 * detail));
      for (let s = 0; s < starOrder.length; s += 1) {
        const start = outer[starOrder[s] ?? 0];
        const end = outer[starOrder[(s + 1) % starOrder.length] ?? 0];
        if (start === undefined || end === undefined) continue;

        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const length = Math.hypot(dx, dy) || 1;
        // The normal to the arm, so bands are offset sideways from it rather than diagonally.
        const nx = -dy / length;
        const ny = dx / length;

        const bands: number[][] = strokeBands.map(() => []);
        for (let i = 0; i <= samples; i += 1) {
          const t = i / samples;
          // Fattest in the middle of the arm, tapering towards each point.
          const taper = 0.74 + Math.sin(t * Math.PI) * 0.32;
          const bx = start.x + dx * t;
          const by = start.y + dy * t;

          for (let b = 0; b < strokeBands.length; b += 1) {
            const band = strokeBands[b] ?? 0;
            // A little wobble so the bands are not mechanically parallel.
            const jitter =
              Math.sin(t * TAU * 4 + s * 0.9 + b * 0.75) * 0.004 +
              Math.cos(t * TAU * 2.4 + b * 0.6) * 0.002;
            const offset = band * taper + jitter;
            const bias = clamp(0.56 + (1 - Math.abs(band) / 0.05) * 0.42, 0.42, 1);
            bands[b]?.push(addNode(bx + nx * offset, by + ny * offset, bias));
          }
        }

        for (const band of bands) connectRun(band, 0.88);
        connectBands(bands, 0.56);
      }

      if (showRing) {
        const ringSamples = Math.max(60, Math.round(260 * detail));
        const ringBands = [-0.014, 0.014];
        const traces: number[][] = ringBands.map(() => []);
        for (let i = 0; i < ringSamples; i += 1) {
          const angle = (i / ringSamples) * TAU - Math.PI / 2;
          for (let b = 0; b < ringBands.length; b += 1) {
            const radius = 1.1 + (ringBands[b] ?? 0);
            traces[b]?.push(addNode(Math.cos(angle) * radius, Math.sin(angle) * radius, 0.5));
          }
        }
        for (const trace of traces) connectRun(trace, 0.7, true);
        connectBands(traces, 0.44, true);
      }
    };

    /**
     * Precomputes the node-dependent half of every wave.
     *
     * See the header: this is what turns fourteen trig calls per node per frame into seven per
     * frame in total.
     */
    const rebuildWaveTable = (): void => {
      if (waveTable.length !== nodes.length * WAVE_STRIDE) {
        waveTable = new Float64Array(nodes.length * WAVE_STRIDE);
      }
      const half = Math.max(Math.min(stage.width, stage.height) * sizeFraction, 1);

      for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];
        if (node === undefined) continue;
        node.relX = node.baseX * half;
        node.relY = node.baseY * half;

        const nx = node.baseX;
        const ny = node.baseY;
        const radial = Math.hypot(nx, ny);
        const angle = Math.atan2(ny, nx);

        const primary = nx * 3.4 + node.phase;
        const diagonal = (nx * 0.9 + ny * 1.2) * 4.8 + node.drift;
        const ring = radial * 7.2 + Math.sin(angle * 3);
        const spiral = angle * 4 + radial * 3.8 + node.phase;
        const ripple = radial * 18 + node.phase * 1.4 + node.drift * 0.3;
        const sway = ny * 3.2 + node.phase;
        const bob = nx * 2.8 + node.drift;

        const base = index * WAVE_STRIDE;
        waveTable[base] = Math.sin(primary);
        waveTable[base + 1] = Math.cos(primary);
        waveTable[base + 2] = Math.sin(diagonal);
        waveTable[base + 3] = Math.cos(diagonal);
        waveTable[base + 4] = Math.sin(ring);
        waveTable[base + 5] = Math.cos(ring);
        waveTable[base + 6] = Math.sin(spiral);
        waveTable[base + 7] = Math.cos(spiral);
        waveTable[base + 8] = Math.sin(ripple);
        waveTable[base + 9] = Math.cos(ripple);
        waveTable[base + 10] = Math.sin(sway);
        waveTable[base + 11] = Math.cos(sway);
        waveTable[base + 12] = Math.sin(bob);
        waveTable[base + 13] = Math.cos(bob);
        // Unit vectors around and away from the centre, so flow can be expressed without trig.
        waveTable[base + 14] = radial > 0.0001 ? -ny / radial : 0;
        waveTable[base + 15] = radial > 0.0001 ? nx / radial : 0;
        waveTable[base + 16] = radial > 0.0001 ? nx / radial : 0;
        waveTable[base + 17] = radial > 0.0001 ? ny / radial : 0;
        waveTable[base + 18] = 0.2 + node.interiorBias * 0.8;
        waveTable[base + 19] = 3.4 + node.interiorBias * 4.2;
      }
    };

    const seedAtmosphere = (): void => {
      const w = stage.width;
      const h = stage.height;
      motes = [];
      for (let i = 0; i < moteCount; i += 1) {
        motes.push({
          x: Math.random() * w,
          y: Math.random() * h,
          vx: (Math.random() - 0.5) * 12,
          vy: -(6 + Math.random() * 22),
          radius: 0.6 + Math.random() * 1.8,
          alpha: 0.15 + Math.random() * 0.35,
          phase: Math.random() * TAU,
        });
      }

      sigils = [];
      for (let i = 0; i < sigilCount; i += 1) {
        sigils.push({
          x: Math.random() * w,
          y: Math.random() * h,
          size: Math.min(w, h) * (0.12 + Math.random() * 0.2),
          rot: Math.random() * TAU,
          vRot: (Math.random() - 0.5) * 0.06,
          alpha: 0.03 + Math.random() * 0.05,
        });
      }
    };

    const rebuild = (): void => {
      buildShape();
      rebuildWaveTable();
      seedAtmosphere();
    };

    rebuild();
    stage.onResize(() => {
      rebuildWaveTable();
      seedAtmosphere();
    });

    let time = 0;

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      time += Math.min(dt, 0.05) * speed;

      const w = stage.width;
      const h = stage.height;
      const cx = w * 0.5;
      const cy = h * 0.5;

      backdropLayer.clear();
      if (drawBackground) backdropLayer.rect(0, 0, w, h).fill({ color: backgroundColor });

      // ── Background sigils ───────────────────────────────────────────────
      sigilLayer.clear();
      for (const sigil of sigils) {
        sigil.rot += sigil.vRot * dt;
        const order = [0, 2, 4, 1, 3];
        for (let i = 0; i < order.length; i += 1) {
          const a = -Math.PI / 2 + ((order[i] ?? 0) / 5) * TAU + sigil.rot;
          const b = -Math.PI / 2 + ((order[(i + 1) % order.length] ?? 0) / 5) * TAU + sigil.rot;
          if (i === 0)
            sigilLayer.moveTo(
              sigil.x + Math.cos(a) * sigil.size,
              sigil.y + Math.sin(a) * sigil.size,
            );
          sigilLayer.lineTo(sigil.x + Math.cos(b) * sigil.size, sigil.y + Math.sin(b) * sigil.size);
        }
        sigilLayer.stroke({ color: colorCore, width: 1.5, alpha: sigil.alpha });
        sigilLayer
          .circle(sigil.x, sigil.y, sigil.size * 1.1)
          .stroke({ color: colorCore, width: 1, alpha: sigil.alpha * 0.7 });
      }

      // ── Atmosphere ──────────────────────────────────────────────────────
      moteLayer.clear();
      for (const mote of motes) {
        mote.phase += dt;
        mote.x += (mote.vx + Math.sin(mote.phase * 0.7) * 6) * dt;
        mote.y += mote.vy * dt;
        if (mote.y < -20) {
          mote.y = h + 20;
          mote.x = Math.random() * w;
        }
        if (mote.x < -20) mote.x = w + 20;
        if (mote.x > w + 20) mote.x = -20;
        moteLayer
          .circle(mote.x, mote.y, mote.radius)
          .fill({ color: colorEmber, alpha: mote.alpha * (0.6 + 0.4 * Math.sin(mote.phase * 2)) });
      }

      // ── Advance the waves ───────────────────────────────────────────────
      // Seven trig pairs for the entire figure, however many nodes it has.
      const pulse = 1 + Math.sin(time * 0.18) * 0.01;
      const shear = Math.sin(time * 0.16) * 0.014;
      const pT = -time * 0.42;
      const pS = Math.sin(pT);
      const pC = Math.cos(pT);
      const dT = -time * 0.34;
      const dS = Math.sin(dT);
      const dC = Math.cos(dT);
      const rT = -time * 0.56;
      const rS = Math.sin(rT);
      const rC = Math.cos(rT);
      const sT = -time * 0.28;
      const sS = Math.sin(sT);
      const sC = Math.cos(sT);
      const iT = -time * 0.92;
      const iS = Math.sin(iT);
      const iC = Math.cos(iT);
      const wT = time * 0.18;
      const wS = Math.sin(wT);
      const wC = Math.cos(wT);
      const bT = time * 0.2;
      const bS = Math.sin(bT);
      const bC = Math.cos(bT);

      for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];
        if (node === undefined) continue;
        const base = index * WAVE_STRIDE;

        // Each of these is `sin(nodePhase + timePhase)` reconstructed from the table.
        const primary = ((waveTable[base] ?? 0) * pC + (waveTable[base + 1] ?? 0) * pS) * 0.72;
        const diagonal = ((waveTable[base + 2] ?? 0) * dC + (waveTable[base + 3] ?? 0) * dS) * 0.44;
        const ring = ((waveTable[base + 5] ?? 0) * rC - (waveTable[base + 4] ?? 0) * rS) * 0.34;
        const spiral = ((waveTable[base + 6] ?? 0) * sC + (waveTable[base + 7] ?? 0) * sS) * 0.26;
        const ripple = ((waveTable[base + 8] ?? 0) * iC + (waveTable[base + 9] ?? 0) * iS) * 0.08;
        const sway = (waveTable[base + 11] ?? 0) * wC - (waveTable[base + 10] ?? 0) * wS;
        const bob = (waveTable[base + 12] ?? 0) * bC + (waveTable[base + 13] ?? 0) * bS;

        const swell = primary + diagonal + ring + spiral + ripple;
        // Squaring the crest is what makes the bright bands narrow: a broad swell barely lifts,
        // while a strong one lifts sharply.
        const crest = Math.max(0, primary * 0.64 + diagonal * 0.28 + ring * 0.38);
        const rise = Math.max(0, ring);
        const damping = waveTable[base + 18] ?? 1;

        node.elevation = (swell * 0.18 + crest * crest * 0.9 + rise * 0.12) * amplitude;

        const stretchedX = node.relX * pulse + node.relY * shear;
        const stretchedY = node.relY * (1 - pulse * 0.01);

        const flowX =
          ((waveTable[base + 14] ?? 0) * (4 + crest * 10 + rise * 6) * damping +
            (waveTable[base + 16] ?? 0) * node.elevation * 7 * damping +
            sway * 1.6 * damping) *
          amplitude;
        const flowY =
          ((waveTable[base + 15] ?? 0) * (4 + crest * 10 + rise * 6) * damping +
            (waveTable[base + 17] ?? 0) * node.elevation * 9 * damping -
            crest * (waveTable[base + 19] ?? 0) +
            bob * 1.8 * damping) *
          amplitude;

        node.x = cx + stretchedX + flowX;
        node.y = cy + stretchedY + flowY;
      }

      // ── Draw the figure ─────────────────────────────────────────────────
      meshLayer.clear();

      for (const segment of segments) {
        const a = nodes[segment.a];
        const b = nodes[segment.b];
        if (a === undefined || b === undefined) continue;

        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.hypot(dx, dy);
        const relief = Math.abs(a.elevation - b.elevation);
        const lift = Math.max(0, (a.elevation + b.elevation) * 0.5);
        const count = Math.max(2, Math.floor(distance / SEGMENT_DOT_STEP));

        const alpha = clamp(
          0.18 + segment.strength * 0.14 + lift * 0.32 + relief * 0.12,
          0.18,
          0.82,
        );
        const radius = 0.34 + segment.strength * 0.12 + lift * 0.22 + relief * 0.06;
        const color = lift > 0.82 ? colorHot : lift > 0.26 ? colorEmber : colorCore;

        // Every dot on a segment shares a colour, so they are collected into one run of circles and
        // filled once. Filling per dot would be thousands of draw calls a frame.
        for (let i = 0; i <= count; i += 1) {
          const t = i / count;
          meshLayer.circle(a.x + dx * t, a.y + dy * t, radius);
        }
        meshLayer.fill({ color, alpha });
      }

      for (const node of nodes) {
        const lift = Math.max(0, node.elevation);
        const color = lift > 0.9 ? colorHot : lift > 0.34 ? colorEmber : colorCore;
        // Only strongly-interior nodes at a crest get a halo, which keeps the glow on the ridges
        // rather than smearing it over the whole figure.
        if (node.interiorBias > 0.78 && lift > 0.1) {
          const glow = (1.9 + node.interiorBias * 1.2 + lift * 3) * 1.6;
          meshLayer
            .circle(node.x, node.y, glow)
            .fill({ color: colorCore, alpha: 0.02 + lift * 0.048 });
        }
        meshLayer
          .circle(node.x, node.y, 0.68 + node.interiorBias * 0.24 + lift * 0.58)
          .fill({ color, alpha: clamp(0.72 + node.interiorBias * 0.14 + lift * 0.22, 0.66, 1) });
      }

      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        const previousShape = [detail, showRing].join("|");
        const previousSize = sizeFraction;
        const previousAtmosphere = [moteCount, sigilCount].join("|");

        speed = num(p, "speed", 1, 0, 4);
        sizeFraction = num(p, "size", 0.42, 0.1, 0.9);
        detail = num(p, "detail", 1, 0.3, 2);
        amplitude = num(p, "amplitude", 1, 0, 3);
        showRing = bool(p, "ring", true);
        sigilCount = int(p, "sigils", 4, 0, 16);
        moteCount = int(p, "motes", 120, 0, 600);
        colorCore = colorHex(p, "colorCore", "#ff3048");
        colorEmber = colorHex(p, "colorEmber", "#ff7a45");
        colorHot = colorHex(p, "colorHot", "#ffddb3");
        drawBackground = bool(p, "background", false);
        backgroundColor = colorHex(p, "backgroundColor", "#080304");

        // Detail and the ring change which nodes exist, so the whole mesh is rebuilt. Size only
        // changes where they sit, which the wave table already recomputes.
        if ([detail, showRing].join("|") !== previousShape) rebuild();
        else if (sizeFraction !== previousSize) rebuildWaveTable();
        else if ([moteCount, sigilCount].join("|") !== previousAtmosphere) seedAtmosphere();
      },
    };
  },
});

export default emberPentagramOverlay;
