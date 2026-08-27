import * as PIXI from "pixi.js";

import { colorHex, int, num } from "../paramUtils";
import { createPixiStage, defineEffect, onFrame } from "../sdk";

/**
 * Wave Simulation
 * ===============
 *
 * A calm, ocean-like interference pattern. Five invisible wave sources drift in slow orbits and
 * each radiates circular waves; where the waves overlap they add up (crests, drawn as glowing teal
 * dots) or cancel out (troughs, drawn as dimmer violet dots). A field of particles "surfs" the
 * pattern — each one is nudged toward rising wave amplitude — and nearby particles are joined by
 * thin lines whose brightness pulses with the wave underneath them. Every few seconds a ripple ring
 * expands outward from one of the sources, and a soft vignette darkens the corners.
 *
 * Ported from `WaveSimulationScreen.ts` / `wave-simulation.html` in the old `obs-effects`
 * repository. The old page created the screen over a `0x050a14` background, which is now the
 * effect's own painted background (and a parameter).
 *
 * What changed in the port
 * ------------------------
 * - The class-based Pixi "screen" (constructor / show / resize / update-on-ticker) became a single
 *   `defineEffect` module: the SDK's `onFrame` clock replaces the Pixi ticker, and the stage's
 *   `onResize` hook replaces the `resize()` method.
 * - Every hard-coded tuning constant — the palette, the particle count, connection distance,
 *   speeds, wave scale, ripple timing, grid density — is now a parameter with the original value
 *   as its default, so the original look is what you get out of the box.
 * - The five wave sources keep their original per-source tuples (position, orbit, frequency,
 *   wavelength, amplitude); parameters scale all five together rather than exposing 45 sliders.
 *
 * How the wave field works (the part worth understanding)
 * -------------------------------------------------------
 * Evaluating five sine waves per pixel would be far too slow, so the field is sampled once per
 * frame on a coarse grid (60 x 34 cells by default) into a pre-allocated `Float32Array`. The dot
 * grid draws straight from that buffer, particles read a finite-difference gradient from it to
 * steer, and connection lines look up the value under their midpoint to pick colour and
 * brightness. One buffer, three consumers, no per-particle trigonometry.
 */

// Wave source tuple: [bx, by, orbitAmp, orbitSpeed, orbitPhase, freq, wavelength, amplitude, paletteIndex]
// bx/by      = base position as a fraction of the canvas width/height
// orbitAmp   = orbital radius as a fraction of min(width, height)
// orbitSpeed = angular speed in radians per second
// freq       = temporal frequency (wave cycles per second)
// wavelength = spatial period in pixels
// amplitude  = contribution weight (normalised)
// paletteIndex = which of the five accent colour parameters this source uses (0..4)
type SrcDef = readonly [number, number, number, number, number, number, number, number, number];

const SRC_DEFS: SrcDef[] = [
  [0.5, 0.5, 0.18, 0.047, 0.0, 1.1, 220, 1.0, 0],
  [0.28, 0.38, 0.15, 0.063, 2.1, 0.9, 260, 0.9, 1],
  [0.72, 0.62, 0.2, 0.038, 4.3, 1.3, 190, 0.8, 2],
  [0.22, 0.68, 0.13, 0.072, 1.5, 0.7, 300, 0.7, 4],
  [0.78, 0.32, 0.16, 0.055, 3.2, 1.5, 175, 0.6, 3],
];

const MAX_RIPPLE = 10;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  phase: number;
  /** Index into the accent palette, fixed at spawn so recolouring is a lookup, not a respawn. */
  paletteIndex: number;
}

interface Ripple {
  cx: number;
  cy: number;
  r: number;
  maxR: number;
  speed: number;
  color: number;
  active: boolean;
}

interface WaveSrc {
  bx: number;
  by: number;
  oa: number;
  os: number;
  op: number;
  freq: number;
  wl: number;
  amp: number;
  paletteIndex: number;
  x: number;
  y: number;
}

const waveSimulation = defineEffect({
  descriptor: {
    id: "wave-simulation",
    name: "Wave Simulation",
    description:
      "Five drifting wave sources build a glowing interference pattern on a dot grid, with particles surfing the wave gradient, pulsing connection lines, and slow expanding ripple rings.",
    engine: "pixi",
    category: "background",
    tags: ["waves", "interference", "particles", "ocean", "ambient", "physics"],
    previewNotes:
      "Fully opaque background — use it as a scene backdrop, not an overlay. The motion is deliberately slow; give it ten seconds or so before judging the look. Raise Wave Speed to audition faster.",
    params: [
      {
        key: "bgColor",
        label: "Background",
        kind: "color",
        default: "#050a14",
        description: "The deep near-black blue behind everything. The old page used this exact colour.",
      },
      {
        key: "crestColor",
        label: "Crest Colour",
        kind: "color",
        default: "#94e2d5",
        description:
          "Colour of wave crests: the bright grid dots, the brighter connection lines, and source 1.",
      },
      {
        key: "troughColor",
        label: "Trough Colour",
        kind: "color",
        default: "#7287fd",
        description:
          "Colour of wave troughs: the dimmer grid dots, the darker connection lines, and source 4.",
      },
      {
        key: "accent2",
        label: "Accent 2",
        kind: "color",
        default: "#89dceb",
        description: "Second accent (sky blue): wave source 2 and a share of the particles.",
      },
      {
        key: "accent3",
        label: "Accent 3",
        kind: "color",
        default: "#74c7ec",
        description: "Third accent (sapphire): wave source 3 and a share of the particles.",
      },
      {
        key: "accent4",
        label: "Accent 4",
        kind: "color",
        default: "#89b4fa",
        description: "Fourth accent (soft blue): wave source 5 and a share of the particles.",
      },
      {
        key: "highlightColor",
        label: "Highlight",
        kind: "color",
        default: "#cdd6f4",
        description: "The near-white core drawn at the centre of every particle and wave source.",
      },
      {
        key: "particleCount",
        label: "Particles",
        kind: "number",
        default: 450,
        min: 0,
        max: 1200,
        step: 10,
        description:
          "How many surfing particles are on screen. More looks denser but costs CPU — the connection pass compares particles pairwise.",
      },
      {
        key: "connectDist",
        label: "Connection Distance",
        kind: "number",
        default: 130,
        min: 0,
        max: 400,
        step: 5,
        description:
          "Two particles closer than this many pixels get a line between them. 0 turns lines off entirely.",
      },
      {
        key: "baseSpeed",
        label: "Particle Speed",
        kind: "number",
        default: 55,
        min: 0,
        max: 300,
        step: 5,
        description:
          "Base particle drift speed in pixels per second. Also sets the speed cap (2.4x this value).",
      },
      {
        key: "waveInfluence",
        label: "Wave Push",
        kind: "number",
        default: 75,
        min: 0,
        max: 400,
        step: 5,
        description:
          "How hard the wave field steers particles, in pixels per second of acceleration per unit of gradient. 0 makes particles drift in straight lines, ignoring the waves.",
      },
      {
        key: "waveSpeed",
        label: "Wave Speed",
        kind: "number",
        default: 1,
        min: 0,
        max: 5,
        step: 0.05,
        description:
          "Multiplies how fast the waves oscillate and how fast the sources orbit. 1 is the original pace; 0 freezes the pattern.",
      },
      {
        key: "waveScale",
        label: "Wave Scale",
        kind: "number",
        default: 1,
        min: 0.25,
        max: 4,
        step: 0.05,
        description:
          "Multiplies every source's wavelength. Above 1 gives broad, lazy swells; below 1 gives tight, busy ripples.",
      },
      {
        key: "waveAmplitude",
        label: "Wave Strength",
        kind: "number",
        default: 1,
        min: 0,
        max: 3,
        step: 0.05,
        description:
          "Multiplies the wave field's amplitude everywhere: brighter grid dots, stronger particle steering, more contrast overall.",
      },
      {
        key: "gridCols",
        label: "Grid Columns",
        kind: "number",
        default: 60,
        min: 10,
        max: 160,
        step: 2,
        description:
          "Horizontal resolution of the dot grid the wave field is sampled on. Higher is finer but costs more per frame.",
      },
      {
        key: "gridRows",
        label: "Grid Rows",
        kind: "number",
        default: 34,
        min: 6,
        max: 90,
        step: 2,
        description: "Vertical resolution of the dot grid.",
      },
      {
        key: "rippleInterval",
        label: "Ripple Interval",
        kind: "number",
        default: 2.8,
        min: 0.5,
        max: 20,
        step: 0.1,
        description:
          "Average seconds between ripple rings. Each actual gap varies between 0.7x and 1.3x of this.",
      },
      {
        key: "rippleSpeed",
        label: "Ripple Speed",
        kind: "number",
        default: 240,
        min: 20,
        max: 1000,
        step: 10,
        description: "How fast ripple rings expand, in pixels per second.",
      },
      {
        key: "rippleSize",
        label: "Ripple Size",
        kind: "number",
        default: 0.6,
        min: 0.1,
        max: 1.5,
        step: 0.05,
        description:
          "How large a ripple grows before it fades, as a fraction of the shorter canvas side.",
      },
      {
        key: "gridBlur",
        label: "Grid Glow",
        kind: "number",
        default: 7,
        min: 0,
        max: 30,
        step: 1,
        description:
          "Blur applied to the dot grid. It is what melts the individual dots into a luminous wash; 0 shows the raw dots.",
      },
      {
        key: "vignette",
        label: "Vignette",
        kind: "number",
        default: 0.85,
        min: 0,
        max: 1,
        step: 0.05,
        description: "How strongly the corners are darkened. 0 removes the vignette entirely.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    const stage = await createPixiStage(scope, ctx);

    // ── Parameter state ─────────────────────────────────────────────────────
    let bgColor = colorHex(ctx.params, "bgColor", "#050a14");
    let crestColor = colorHex(ctx.params, "crestColor", "#94e2d5");
    let troughColor = colorHex(ctx.params, "troughColor", "#7287fd");
    let accent2 = colorHex(ctx.params, "accent2", "#89dceb");
    let accent3 = colorHex(ctx.params, "accent3", "#74c7ec");
    let accent4 = colorHex(ctx.params, "accent4", "#89b4fa");
    let highlightColor = colorHex(ctx.params, "highlightColor", "#cdd6f4");
    let particleCount = int(ctx.params, "particleCount", 450, 0, 1200);
    let connectDist = num(ctx.params, "connectDist", 130, 0, 400);
    let baseSpeed = num(ctx.params, "baseSpeed", 55, 0, 300);
    let waveInfluence = num(ctx.params, "waveInfluence", 75, 0, 400);
    let waveSpeed = num(ctx.params, "waveSpeed", 1, 0, 5);
    let waveScale = num(ctx.params, "waveScale", 1, 0.25, 4);
    let waveAmplitude = num(ctx.params, "waveAmplitude", 1, 0, 3);
    let gridCols = int(ctx.params, "gridCols", 60, 10, 160);
    let gridRows = int(ctx.params, "gridRows", 34, 6, 90);
    let rippleInterval = num(ctx.params, "rippleInterval", 2.8, 0.5, 20);
    let rippleSpeed = num(ctx.params, "rippleSpeed", 240, 20, 1000);
    let rippleSize = num(ctx.params, "rippleSize", 0.6, 0.1, 1.5);
    let gridBlur = int(ctx.params, "gridBlur", 7, 0, 30);
    let vignette = num(ctx.params, "vignette", 0.85, 0, 1);

    /** The five accent colours in source order, refreshed whenever colours change. */
    const paletteOf = (): number[] => [crestColor, accent2, accent3, accent4, troughColor].map(
      (c) => Number.parseInt(c.slice(1), 16),
    );
    let palette = paletteOf();
    // `noUncheckedIndexedAccess` makes every array read `number | undefined`; the palette always
    // has five entries, so a miss can only be a programming error — fall back to the crest teal.
    const colorAt = (i: number): number => palette[i] ?? 0x94e2d5;
    let bgInt = Number.parseInt(bgColor.slice(1), 16);
    let highlightInt = Number.parseInt(highlightColor.slice(1), 16);

    // ── Display objects ─────────────────────────────────────────────────────
    const bgGfx = new PIXI.Graphics();
    const gridGfx = new PIXI.Graphics();
    const connGfx = new PIXI.Graphics();
    const partGfx = new PIXI.Graphics();
    const rippleGfx = new PIXI.Graphics();
    const srcGfx = new PIXI.Graphics();
    const vigGfx = new PIXI.Graphics();

    // A light blur softens the dot grid into a luminous interference-pattern glow.
    const gridLayer = new PIXI.Container();
    gridLayer.addChild(gridGfx);
    const gridBlurFilter = new PIXI.BlurFilter({ strength: gridBlur, quality: 2 });
    gridLayer.filters = gridBlur > 0 ? [gridBlurFilter] : [];

    // Vignette: heavily blurred black circles in the corners darken the edges
    // without touching the centre.
    const vigBlurFilter = new PIXI.BlurFilter({ strength: 55, quality: 2 });
    vigGfx.filters = [vigBlurFilter];

    stage.stage.addChild(bgGfx, gridLayer, connGfx, partGfx, rippleGfx, srcGfx, vigGfx);

    // ── Simulation state ────────────────────────────────────────────────────
    const sources: WaveSrc[] = SRC_DEFS.map(([bx, by, oa, os, op, freq, wl, amp, pi]) => ({
      bx,
      by,
      oa,
      os,
      op,
      freq,
      wl,
      amp,
      paletteIndex: pi,
      x: bx * stage.width,
      y: by * stage.height,
    }));

    const particles: Particle[] = [];
    const spawnParticle = (): Particle => {
      const angle = Math.random() * Math.PI * 2;
      const spd = (0.4 + Math.random() * 0.6) * baseSpeed;
      return {
        x: Math.random() * stage.width,
        y: Math.random() * stage.height,
        vx: Math.cos(angle) * spd,
        vy: Math.sin(angle) * spd,
        phase: Math.random() * Math.PI * 2,
        paletteIndex: particles.length % SRC_DEFS.length,
      };
    };
    /**
     * Grows or shrinks the particle pool to the configured count without touching the survivors,
     * so dragging the slider does not make every particle jump.
     */
    const syncParticleCount = (): void => {
      while (particles.length < particleCount) particles.push(spawnParticle());
      if (particles.length > particleCount) particles.length = particleCount;
    };
    syncParticleCount();

    const ripples: Ripple[] = Array.from({ length: MAX_RIPPLE }, () => ({
      cx: 0,
      cy: 0,
      r: 0,
      maxR: 0,
      speed: rippleSpeed,
      color: colorAt(0),
      active: false,
    }));

    // Pre-allocated wave-field buffer, reallocated only when the grid density changes —
    // avoids garbage-collector pressure from a fresh Float32Array every frame.
    let waveField = new Float32Array(gridRows * gridCols);

    // `time` advances by dt * waveSpeed, so the speed slider stretches the whole simulation's
    // clock rather than making each formula check the multiplier separately.
    let time = 0;
    let nextRipple = rippleInterval;

    const drawVignette = (): void => {
      vigGfx.clear();
      if (vignette <= 0) return;
      const w = stage.width;
      const h = stage.height;
      const r = Math.min(w, h) * 0.72;
      const corners: ReadonlyArray<readonly [number, number]> = [
        [0, 0],
        [w, 0],
        [0, h],
        [w, h],
      ];
      for (const [cx, cy] of corners) {
        vigGfx.circle(cx, cy, r).fill({ color: 0x000000, alpha: vignette });
      }
    };
    drawVignette();
    // The corner circles are positioned from the canvas size, so they must be redrawn on resize.
    stage.onResize(drawVignette);

    // ── Per-frame passes (each mirrors one method of the original class) ────

    const updateSources = (): void => {
      const md = Math.min(stage.width, stage.height);
      for (const s of sources) {
        s.x = s.bx * stage.width + Math.cos(time * s.os + s.op) * s.oa * md;
        s.y = s.by * stage.height + Math.sin(time * s.os + s.op) * s.oa * md;
      }
    };

    // Evaluates the superposition of all wave sources on the coarse grid. Particles and
    // connections sample this buffer instead of paying per-particle square roots.
    const computeWaveField = (): void => {
      const cw = stage.width / gridCols;
      const ch = stage.height / gridRows;
      for (let row = 0; row < gridRows; row++) {
        const gy = (row + 0.5) * ch;
        for (let col = 0; col < gridCols; col++) {
          const gx = (col + 0.5) * cw;
          let v = 0;
          for (const s of sources) {
            const dx = gx - s.x;
            const dy = gy - s.y;
            const r = Math.sqrt(dx * dx + dy * dy) + 1;
            // The 1/(1 + 0.0015r) attenuation gives a natural radial falloff.
            v +=
              (s.amp * Math.sin((r / (s.wl * waveScale) - s.freq * time) * Math.PI * 2)) /
              (1 + r * 0.0015);
          }
          waveField[row * gridCols + col] = v * waveAmplitude;
        }
      }
    };

    const drawBackground = (): void => {
      const w = stage.width;
      const h = stage.height;
      bgGfx.clear().rect(0, 0, w, h).fill({ color: bgInt });
      const md = Math.min(w, h);
      // Two enormous drifting tinted circles give the flat background a slow depth wobble.
      bgGfx
        .circle(
          (0.5 + Math.sin(time * 0.019) * 0.12) * w,
          (0.5 + Math.cos(time * 0.014) * 0.1) * h,
          0.6 * md,
        )
        .fill({ color: 0x071525, alpha: 0.28 });
      bgGfx
        .circle(
          (0.32 + Math.cos(time * 0.023) * 0.1) * w,
          (0.62 + Math.sin(time * 0.017) * 0.08) * h,
          0.48 * md,
        )
        .fill({ color: 0x0a0820, alpha: 0.2 });
    };

    // Draws the interference pattern as a field of coloured dots — crests in the crest colour,
    // troughs in the trough colour, zero-crossings invisible.
    const drawGrid = (): void => {
      gridGfx.clear();
      const cw = stage.width / gridCols;
      const ch = stage.height / gridRows;
      const dotR = Math.min(cw, ch) * 0.28;

      for (let row = 0; row < gridRows; row++) {
        for (let col = 0; col < gridCols; col++) {
          const v = waveField[row * gridCols + col] ?? 0;
          if (Math.abs(v) < 0.06) continue;
          const gx = (col + 0.5) * cw;
          const gy = (row + 0.5) * ch;
          if (v > 0) {
            gridGfx.circle(gx, gy, dotR).fill({
              color: colorAt(0),
              alpha: Math.min(v * 0.5, 0.68),
            });
          } else {
            gridGfx.circle(gx, gy, dotR * 0.75).fill({
              color: colorAt(4),
              alpha: Math.min(-v * 0.28, 0.36),
            });
          }
        }
      }
    };

    // Particles surf the wave gradient: velocity is nudged toward rising amplitude, read as a
    // forward-difference on the pre-baked grid so no wave maths runs per particle.
    const updateParticles = (dt: number): void => {
      const w = stage.width;
      const h = stage.height;
      const cw = w / gridCols;
      const ch = h / gridRows;
      const maxSpd = baseSpeed * 2.4;

      for (const p of particles) {
        const col = Math.min(gridCols - 1, Math.max(0, Math.floor(p.x / cw)));
        const row = Math.min(gridRows - 1, Math.max(0, Math.floor(p.y / ch)));
        const col1 = Math.min(gridCols - 1, col + 1);
        const row1 = Math.min(gridRows - 1, row + 1);
        const v00 = waveField[row * gridCols + col] ?? 0;
        const v10 = waveField[row * gridCols + col1] ?? 0;
        const v01 = waveField[row1 * gridCols + col] ?? 0;

        p.vx += ((v10 - v00) / cw) * waveInfluence * dt;
        p.vy += ((v01 - v00) / ch) * waveInfluence * dt;

        const spd2 = p.vx * p.vx + p.vy * p.vy;
        if (maxSpd > 0 && spd2 > maxSpd * maxSpd) {
          const f = maxSpd / Math.sqrt(spd2);
          p.vx *= f;
          p.vy *= f;
        }

        p.x += p.vx * dt;
        p.y += p.vy * dt;

        // Toroidal wrap — avoids border forces and keeps the motion cyclic.
        if (p.x < 0) p.x += w;
        else if (p.x >= w) p.x -= w;
        if (p.y < 0) p.y += h;
        else if (p.y >= h) p.y -= h;
      }
    };

    // Lines between nearby particles; brightness and colour are read from the wave amplitude at
    // the line's midpoint, so the connections literally pulse with the field.
    const drawConnections = (): void => {
      connGfx.clear();
      if (connectDist <= 0) return;
      const cw = stage.width / gridCols;
      const ch = stage.height / gridRows;
      const connD2 = connectDist * connectDist;

      for (let i = 0; i < particles.length; i++) {
        const a = particles[i];
        if (a === undefined) continue;
        let connCount = 0;
        // Each particle keeps at most 5 lines, matching the original's cap; without it the pass
        // is O(n^2) in drawn lines and dense clusters become solid blobs.
        for (let j = i + 1; j < particles.length && connCount < 5; j++) {
          const b = particles[j];
          if (b === undefined) continue;
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > connD2) continue;

          const d = Math.sqrt(d2);
          const t = 1 - d / connectDist;
          const mcol = Math.min(gridCols - 1, Math.max(0, Math.floor(((a.x + b.x) * 0.5) / cw)));
          const mrow = Math.min(gridRows - 1, Math.max(0, Math.floor(((a.y + b.y) * 0.5) / ch)));
          const wAmp = waveField[mrow * gridCols + mcol] ?? 0;
          const wBr = 0.5 + 0.5 * Math.max(-1, Math.min(1, wAmp));
          const alpha = t * t * (0.09 + 0.2 * wBr);
          const color = wAmp >= 0 ? colorAt(0) : colorAt(4);

          connGfx.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ color, alpha, width: 0.5 + t });
          connCount++;
        }
      }
    };

    // Particle glow scales with local wave energy — dots brighten on wave crests.
    const drawParticles = (): void => {
      partGfx.clear();
      const cw = stage.width / gridCols;
      const ch = stage.height / gridRows;
      const pulse = 1 + 0.12 * Math.sin(time * 1.9);

      for (const p of particles) {
        const col = Math.min(gridCols - 1, Math.max(0, Math.floor(p.x / cw)));
        const row = Math.min(gridRows - 1, Math.max(0, Math.floor(p.y / ch)));
        const wAmp = waveField[row * gridCols + col] ?? 0;
        // Each particle carries its own phase so they never all pulse in sync.
        const energy =
          0.5 + 0.5 * Math.sin(time * 2.2 + p.phase) * (0.4 + 0.6 * Math.max(0, wAmp));
        const glowR = 9 * energy * pulse;
        const coreR = 2.5 * energy;
        const color = colorAt(p.paletteIndex);

        partGfx.circle(p.x, p.y, glowR).fill({ color, alpha: 0.04 + energy * 0.13 });
        partGfx.circle(p.x, p.y, coreR).fill({ color, alpha: 0.65 + energy * 0.25 });
        partGfx
          .circle(p.x, p.y, Math.max(0.8, coreR * 0.38))
          .fill({ color: highlightInt, alpha: 0.22 + energy * 0.55 });
      }
    };

    const spawnRipple = (): void => {
      const slot = ripples.find((r) => !r.active);
      if (!slot) return;
      // A ripple is anchored to a randomly chosen source, so rings always emanate from a place
      // that is visibly emitting waves.
      const src = sources[Math.floor(Math.random() * sources.length)];
      if (src === undefined) return;
      slot.cx = src.x;
      slot.cy = src.y;
      slot.r = 0;
      slot.maxR = rippleSize * Math.min(stage.width, stage.height);
      slot.speed = rippleSpeed * (0.8 + 0.4 * Math.random());
      slot.color = colorAt(src.paletteIndex);
      slot.active = true;
    };

    const updateRipples = (dt: number): void => {
      nextRipple -= dt;
      if (nextRipple <= 0) {
        nextRipple = rippleInterval * (0.7 + 0.6 * Math.random());
        spawnRipple();
      }
      for (const r of ripples) {
        if (!r.active) continue;
        r.r += r.speed * dt;
        if (r.r > r.maxR) r.active = false;
      }
    };

    const drawRipples = (): void => {
      rippleGfx.clear();
      for (const r of ripples) {
        if (!r.active || r.r < 1) continue;
        const tf = r.r / r.maxR;
        const fade = Math.sin(tf * Math.PI); // peaks at midlife, zero at birth and death
        rippleGfx.circle(r.cx, r.cy, r.r).stroke({
          color: r.color,
          alpha: fade * 0.55,
          width: (1 - tf) * 2.5 + 0.5,
        });
        if (r.r > 40) {
          // An inner secondary ring at 68% radius adds harmonic depth.
          rippleGfx.circle(r.cx, r.cy, r.r * 0.68).stroke({
            color: r.color,
            alpha: fade * 0.24,
            width: (1 - tf) * 1.5 + 0.4,
          });
        }
      }
    };

    // A small pulsing glow at each orbiting wave source marks the emission centre.
    const drawSources = (): void => {
      srcGfx.clear();
      for (const s of sources) {
        const pulse = 1 + 0.25 * Math.sin(time * s.freq * Math.PI * 2);
        const r = 16 * pulse;
        const color = colorAt(s.paletteIndex);
        srcGfx.circle(s.x, s.y, r * 2.8).fill({ color, alpha: 0.06 });
        srcGfx.circle(s.x, s.y, r).fill({ color, alpha: 0.2 });
        srcGfx.circle(s.x, s.y, r * 0.38).fill({ color: highlightInt, alpha: 0.6 });
      }
    };

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      // The original clamped its delta to 50 ms so a stalled tab cannot fling particles across
      // the screen; onFrame clamps to 100 ms, so the tighter clamp is kept here.
      const step = Math.min(dt, 0.05);
      time += step * waveSpeed;
      updateSources();
      computeWaveField();
      drawBackground();
      drawGrid();
      updateParticles(step);
      drawConnections();
      drawParticles();
      updateRipples(step);
      drawRipples();
      drawSources();
      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        bgColor = colorHex(p, "bgColor", "#050a14");
        crestColor = colorHex(p, "crestColor", "#94e2d5");
        troughColor = colorHex(p, "troughColor", "#7287fd");
        accent2 = colorHex(p, "accent2", "#89dceb");
        accent3 = colorHex(p, "accent3", "#74c7ec");
        accent4 = colorHex(p, "accent4", "#89b4fa");
        highlightColor = colorHex(p, "highlightColor", "#cdd6f4");
        particleCount = int(p, "particleCount", 450, 0, 1200);
        connectDist = num(p, "connectDist", 130, 0, 400);
        baseSpeed = num(p, "baseSpeed", 55, 0, 300);
        waveInfluence = num(p, "waveInfluence", 75, 0, 400);
        waveSpeed = num(p, "waveSpeed", 1, 0, 5);
        waveScale = num(p, "waveScale", 1, 0.25, 4);
        waveAmplitude = num(p, "waveAmplitude", 1, 0, 3);
        gridCols = int(p, "gridCols", 60, 10, 160);
        gridRows = int(p, "gridRows", 34, 6, 90);
        rippleInterval = num(p, "rippleInterval", 2.8, 0.5, 20);
        rippleSpeed = num(p, "rippleSpeed", 240, 20, 1000);
        rippleSize = num(p, "rippleSize", 0.6, 0.1, 1.5);
        gridBlur = int(p, "gridBlur", 7, 0, 30);
        vignette = num(p, "vignette", 0.85, 0, 1);

        // Everything below rebuilds the few derived structures in place — no remount, no black
        // frame — as the SDK requires of setParams.
        palette = paletteOf();
        bgInt = Number.parseInt(bgColor.slice(1), 16);
        highlightInt = Number.parseInt(highlightColor.slice(1), 16);
        syncParticleCount();
        if (waveField.length !== gridRows * gridCols) {
          waveField = new Float32Array(gridRows * gridCols);
        }
        gridBlurFilter.strength = gridBlur;
        gridLayer.filters = gridBlur > 0 ? [gridBlurFilter] : [];
        drawVignette();
      },
    };
  },
});

export default waveSimulation;
