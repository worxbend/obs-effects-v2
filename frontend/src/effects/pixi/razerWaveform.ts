import * as PIXI from "pixi.js";

import type { EffectContext, ParamSpec } from "../types";
import { bool, colorInt, num } from "../paramUtils";
import {
  createEnvelopes,
  createPixiStage,
  onFrame,
  useAudio,
  type EffectHandle,
  type Scope,
} from "../sdk";

/**
 * The shared "Razer waveform" implementation: eight audio-reactive visualiser looks, one engine.
 *
 * ## What it draws
 *
 * A bank of 128 bands whose heights follow the audio, rendered eight different ways — as columns of
 * dots, as stacked cells, as woven zigzags, as a double helix, or as layered organic ribbons. The
 * old repository had these as eight pages backed by one 1,400-line class with a `variant` string,
 * and that structure is kept here for the same reason it existed there: the eight share their
 * entire audio pipeline and differ only in the last step.
 *
 * ## Where the audio comes from, and the one thing to understand about it
 *
 * The band heights are **not** a frequency analysis. OBS reports loudness, not a spectrum (see
 * `sdk/audio.ts`), and the original code was in exactly the same position: what it called `bass`,
 * `mid` and `high` were the same single level tracked with three different attack/release speeds.
 *
 * That trick is now `sdk/envelopes.ts`, and its fields are named `slow`, `mid` and `fast` to stop
 * anyone believing otherwise. The band *shape* across the screen comes from fixed Gaussian
 * envelopes — a bump around 22%, another at 52%, another at 78% — which is what makes the display
 * look like a spectrum analyser even though nothing here knows one frequency from another.
 *
 * It works because what an audience reads is *motion that matches the music*, and loudness with
 * three different lags delivers that. But an effect here should never be described to an operator
 * as showing them their frequencies.
 *
 * ## Why the values are updated separately from the drawing
 *
 * `updateBands` runs the same for every variant; only `draw` differs. Keeping them apart is what
 * makes eight looks cost one implementation, and it is why switching variant mid-stream would show
 * the same audio response in a different shape rather than restarting the animation.
 */

/** Segments along a ribbon or stroked wave. Higher is smoother and costs proportionally more. */
const SEGMENTS = 184;

/** How many bands the audio is spread across. The original's number; every look samples from it. */
const BARS = 128;

/** The Razer-adjacent palette the original used, as 0xRRGGBB. */
const RED = 0xff3a20;
const ORANGE = 0xff9b2f;
const YELLOW = 0xffec62;
const GREEN = 0x43ff75;
const TEAL = 0x29dccf;
const CYAN = 0x61eaff;
const BLUE = 0x1688ff;
const PURPLE = 0x7b35ff;
const MAGENTA = 0xff2fb8;
const PINK = 0xff6bd6;
const WHITE = 0xf0fff2;

const PALETTE = [RED, ORANGE, YELLOW, TEAL, CYAN, BLUE, PURPLE, MAGENTA, PINK, WHITE] as const;
const RIBBON_PALETTE = [MAGENTA, BLUE, GREEN, CYAN, PINK, YELLOW, WHITE] as const;

const TAU = Math.PI * 2;

/** Which of the eight looks to draw. */
export type WaveformVariant =
  "pulse" | "prism" | "spectrum" | "weave" | "helix" | "ribbons" | "ribbonBands" | "ribbonLattice";

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

/** Smooth 0→1 ramp between two edges — the GLSL function of the same name, in JavaScript. */
function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / Math.max(0.0001, edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Fades the first and last 8% of a span, so nothing ends with a hard vertical edge. */
function edgeAlpha(t: number): number {
  return smoothstep(0, 0.08, t) * (1 - smoothstep(0.92, 1, t));
}

/** A bell curve centred on `center`. The building block of every band shape here. */
function gauss(t: number, center: number, width: number): number {
  return Math.exp(-Math.pow((t - center) / width, 2));
}

/** Blends two 0xRRGGBB colours per channel, clamping the amount into 0..1. */
function mixColor(a: number, b: number, t: number): number {
  const amount = clamp(t);
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

/** Reads a colour out of a palette array by index, wrapping, with a safe fallback. */
function paletteEntry(palette: readonly number[], index: number): number {
  const length = palette.length;
  return palette[((index % length) + length) % length] ?? WHITE;
}

/** Samples the rainbow palette continuously, wrapping. */
function paletteAt(t: number, offset = 0): number {
  const range = PALETTE.length - 1;
  const scaled = (((t * range + offset) % range) + range) % range;
  const i = Math.floor(scaled);
  return mixColor(paletteEntry(PALETTE, i), paletteEntry(PALETTE, i + 1), scaled - i);
}

/** The defaults one variant starts from. */
export interface WaveformLook {
  variant: WaveformVariant;
  /** Overall vertical scale, as a multiplier on the variant's own amplitude. */
  amplitude: number;
  /** How much of the frame's width the display spans, 0..1. */
  width: number;
  /** Vertical centre as a fraction of the frame height. */
  centre: number;
  /** Master opacity. */
  opacity: number;
  /** Multiplier on how strongly audio moves the display. */
  reactivity: number;
}

/** Parameters shared by all eight looks, defaulted from one of them. */
export function waveformParams(look: WaveformLook): ParamSpec[] {
  return [
    {
      key: "amplitude",
      label: "Amplitude",
      kind: "number",
      default: look.amplitude,
      min: 0.1,
      max: 3,
      step: 0.05,
      description: "Overall vertical size of the display.",
    },
    {
      key: "width",
      label: "Width",
      kind: "number",
      default: look.width,
      min: 0.2,
      max: 1,
      step: 0.01,
      description: "How much of the frame's width the display spans. 1 reaches both edges.",
    },
    {
      key: "centre",
      label: "Vertical Position",
      kind: "number",
      default: look.centre,
      min: 0,
      max: 1,
      step: 0.01,
      description: "Where the display sits vertically. 0.5 is the middle of the frame.",
    },
    {
      key: "reactivity",
      label: "Reactivity",
      kind: "number",
      default: look.reactivity,
      min: 0,
      max: 3,
      step: 0.05,
      description:
        "How strongly the audio moves it. 0 leaves the idle animation only, which is a legitimate look for a background.",
    },
    {
      key: "opacity",
      label: "Opacity",
      kind: "number",
      default: look.opacity,
      min: 0.05,
      max: 1,
      step: 0.05,
      description: "Master opacity of everything drawn.",
    },
    {
      key: "background",
      label: "Background",
      kind: "boolean",
      default: false,
      description:
        "Fill the frame behind the display. Off by default — these are overlays meant to sit over a scene.",
    },
    {
      key: "backgroundColor",
      label: "Background Colour",
      kind: "color",
      default: "#000000",
      description: "Only used when Background is on.",
    },
  ];
}

/** Everything read from the parameters. */
interface Settings {
  amplitude: number;
  width: number;
  centre: number;
  reactivity: number;
  opacity: number;
  background: boolean;
  backgroundColor: number;
}

function readSettings(p: Record<string, unknown>, look: WaveformLook): Settings {
  return {
    amplitude: num(p, "amplitude", look.amplitude, 0.1, 3),
    width: num(p, "width", look.width, 0.2, 1),
    centre: num(p, "centre", look.centre, 0, 1),
    reactivity: num(p, "reactivity", look.reactivity, 0, 3),
    opacity: num(p, "opacity", look.opacity, 0.05, 1),
    background: bool(p, "background", false),
    backgroundColor: colorInt(p, "backgroundColor", "#000000"),
  };
}

/**
 * Builds the `setup` half of one waveform effect.
 *
 * Exported for the eight wrapper files; nothing else should call it.
 */
export function razerWaveformSetup(
  look: WaveformLook,
): (args: { ctx: EffectContext; scope: Scope }) => Promise<EffectHandle> {
  return async ({ ctx, scope }): Promise<EffectHandle> => {
    let settings = readSettings(ctx.params, look);

    const bus = await useAudio(scope);
    scope.checkpoint();

    const envelopes = createEnvelopes(bus);
    const stage = await createPixiStage(scope, ctx);
    const graphics = stage.stage.addChild(new PIXI.Graphics());

    const values = new Float32Array(BARS);
    const peaks = new Float32Array(BARS);
    const seeds = new Float32Array(BARS);

    for (let i = 0; i < BARS; i += 1) {
      // A repeatable pseudo-random seed per band, so each one jitters differently but identically
      // on every run. `Math.random()` here would make the idle animation look different every time
      // an effect is remounted, which on a route change is visible.
      const s = Math.sin(i * 91.171) * 43758.5453;
      seeds[i] = s - Math.floor(s);
      values[i] = 0.06;
      peaks[i] = 0.06;
    }

    let time = 0;
    let wavePhase = 0;
    let activity = 0;
    let beat = 0;

    const isRibbonFamily =
      look.variant === "ribbons" ||
      look.variant === "ribbonBands" ||
      look.variant === "ribbonLattice";

    /** Reads one band, interpolating between the two nearest. */
    const valueAt = (t: number): number => {
      const scaled = clamp(t) * (BARS - 1);
      const i = Math.floor(scaled);
      const a = values[i] ?? 0;
      const b = values[Math.min(BARS - 1, i + 1)] ?? a;
      return a + (b - a) * (scaled - i);
    };

    const peakAt = (t: number): number => {
      const scaled = clamp(t) * (BARS - 1);
      const i = Math.floor(scaled);
      const a = peaks[i] ?? 0;
      const b = peaks[Math.min(BARS - 1, i + 1)] ?? a;
      return a + (b - a) * (scaled - i);
    };

    /**
     * Advances every band towards its audio-driven target.
     *
     * The ribbon family uses a different formula from the rest — smoother, with neighbour blending
     * so adjacent bands stay coherent enough to form a continuous shape rather than a comb.
     */
    const updateBands = (dt: number): void => {
      const level = bus.level * settings.reactivity;
      const slow = envelopes.slow * settings.reactivity;
      const mid = envelopes.mid * settings.reactivity;
      const fast = envelopes.fast * settings.reactivity;

      if (isRibbonFamily) {
        const attack = 1 - Math.exp(-dt * 26);
        const release = 1 - Math.exp(-dt * 3.8);
        const peakFalloff = Math.exp(-dt * 2.05);
        const sweep = wavePhase * 0.6;
        const peakOffset = wavePhase * 0.12;

        for (let i = 0; i < BARS; i += 1) {
          const t = i / (BARS - 1);
          const centre = 1 - Math.abs(t - 0.5) * 2;
          const slowEnvelope =
            gauss(t, 0.22, 0.17) * (slow * 1.2 + level * 0.44) +
            gauss(t, 0.08, 0.09) * (slow * 0.34 + level * 0.22);
          const midEnvelope =
            gauss(t, 0.52, 0.22) * (mid * 1.06 + level * 0.36) +
            gauss(t, 0.34, 0.16) * (mid * 0.46 + level * 0.24);
          const fastEnvelope =
            gauss(t, 0.78, 0.16) * (fast * 0.92 + level * 0.27) +
            gauss(t, 0.92, 0.1) * (fast * 0.28 + level * 0.18);
          const lfo =
            0.55 +
            0.45 * Math.sin(sweep + t * TAU * 1.8 + i * 0.14 + (seeds[i] ?? 0) * 0.9 + wavePhase);
          const micro = 0.5 + 0.5 * Math.sin(t * TAU * 2.9 + i * 0.27 + peakOffset);
          const neighbour =
            (values[Math.max(0, i - 1)] ?? 0) * 0.12 +
            (values[Math.min(BARS - 1, i + 1)] ?? 0) * 0.12 +
            (peaks[i] ?? 0) * 0.22;
          const base = 0.006 + Math.pow(centre, 1.35) * (0.008 + activity * 0.024);
          const response =
            (slowEnvelope * 0.42 + midEnvelope * 0.4 + fastEnvelope * 0.34) *
            (0.9 + activity * 0.95);
          const target = clamp(
            base +
              response * (0.22 + activity * 0.9) +
              lfo * (0.02 + activity * 0.056) * (1 + activity * 0.42) +
              micro * activity * 0.036 +
              neighbour * 0.27 +
              (peaks[i] ?? 0) * 0.08 +
              beat * gauss(t, 0.5, 0.22) * 0.18,
            0.004,
            1,
          );
          const current = values[i] ?? 0;
          values[i] = current + (target - current) * (target > current ? attack : release);
          peaks[i] = Math.max((peaks[i] ?? 0) * peakFalloff, values[i] ?? 0);
        }
        return;
      }

      const attack = 1 - Math.exp(-dt * 25);
      const release = 1 - Math.exp(-dt * 7);

      for (let i = 0; i < BARS; i += 1) {
        const t = i / (BARS - 1);
        const centre = 1 - Math.abs(t - 0.5) * 2;
        const clusters =
          gauss(t, 0.22, 0.09) * (fast * 0.8 + level * 0.55) +
          gauss(t, 0.42, 0.13) * (mid * 1.1 + level * 0.35) +
          gauss(t, 0.62, 0.11) * (slow * 1.2 + level * 0.42) +
          gauss(t, 0.81, 0.1) * (fast * 0.75 + mid * 0.36);
        const grain = 0.5 + 0.5 * Math.sin(time * (7.5 + (seeds[i] ?? 0) * 13) + i * 0.73);
        const target =
          0.01 +
          Math.pow(centre, 0.55) * 0.024 +
          clusters * (0.06 + activity * 1.05) +
          grain * (fast * 0.22 + level * 0.1) * activity +
          beat * gauss(t, 0.5, 0.22) * 0.35;
        const current = values[i] ?? 0;
        values[i] = current + (target - current) * (target > current ? attack : release);
        peaks[i] = Math.max(peaks[i] ?? 0, values[i] ?? 0);
      }
    };

    /** A line drawn three times at decreasing width and increasing opacity, which reads as a glow. */
    const glowLine = (
      x0: number,
      y0: number,
      x1: number,
      y1: number,
      color: number,
      alpha: number,
      width: number,
      glow: number,
    ): void => {
      const a = alpha * settings.opacity;
      graphics
        .moveTo(x0, y0)
        .lineTo(x1, y1)
        .stroke({ color, alpha: a * 0.12, width: width + glow });
      graphics
        .moveTo(x0, y0)
        .lineTo(x1, y1)
        .stroke({ color, alpha: a * 0.24, width: width + glow * 0.42 });
      graphics.moveTo(x0, y0).lineTo(x1, y1).stroke({ color, alpha: a, width });
    };

    const waveAt = (t: number, amp: number, cycles: number, phase: number): number => {
      const envelope =
        0.18 +
        0.82 *
          (gauss(t, 0.23, 0.18) * 0.35 + gauss(t, 0.48, 0.21) * 0.48 + gauss(t, 0.74, 0.2) * 0.38);
      const energy = 0.18 + valueAt(t) * (0.55 + activity * 0.7);
      const drift = time * (0.08 + activity * 0.55 + envelopes.mid * activity * 0.55);
      const primary = Math.sin(t * TAU * cycles + phase + drift);
      const secondary =
        Math.sin(t * TAU * (cycles * 0.52 + 0.8) - drift * 1.3 + phase * 0.7) * 0.38;
      const tertiary =
        Math.sin(t * TAU * (cycles * 1.8 + 1.2) + drift * 0.35) * envelopes.fast * activity * 0.42;
      return (primary + secondary + tertiary) * amp * envelope * energy;
    };

    const strokeWave = (
      cy: number,
      left: number,
      span: number,
      amp: number,
      cycles: number,
      phase: number,
      color: number,
      alpha: number,
      width: number,
    ): void => {
      for (let i = 0; i < SEGMENTS; i += 1) {
        const t0 = i / SEGMENTS;
        const t1 = (i + 1) / SEGMENTS;
        const a = Math.min(edgeAlpha(t0), edgeAlpha(t1)) * alpha;
        if (a <= 0.01) continue;
        glowLine(
          left + span * t0,
          cy + waveAt(t0, amp, cycles, phase),
          left + span * t1,
          cy + waveAt(t1, amp, cycles, phase),
          color,
          a,
          width,
          10,
        );
      }
    };

    const dotColor = (
      mode: "rainbowVertical" | "cyanDepth" | "sunset",
      p: number,
      mirrored: boolean,
    ): number => {
      if (mode === "cyanDepth") return mixColor(BLUE, CYAN, 0.28 + p * 0.72);
      if (mode === "sunset") {
        return mirrored ? mixColor(MAGENTA, PURPLE, p) : mixColor(YELLOW, RED, p * 0.92);
      }
      if (mirrored) return mixColor(MAGENTA, PURPLE, p);
      return p < 0.42
        ? mixColor(YELLOW, ORANGE, p / 0.42)
        : mixColor(ORANGE, RED, (p - 0.42) / 0.58);
    };

    /** Columns of dots rising from a baseline, optionally mirrored below it. */
    const drawDotSkyline = (options: {
      base: number;
      left: number;
      span: number;
      maxHeight: number;
      columns: number;
      rows: number;
      mirror: boolean;
      dotRadius: number;
      colorMode: "rainbowVertical" | "cyanDepth" | "sunset";
      density: number;
      waveBias: number;
    }): void => {
      const colGap = options.span / Math.max(1, options.columns - 1);
      const rowGap = options.maxHeight / options.rows;

      for (let col = 0; col < options.columns; col += 1) {
        const t = col / Math.max(1, options.columns - 1);
        const envelope =
          gauss(t, 0.24, 0.1) * 0.55 +
          gauss(t, 0.42, 0.14) * 0.78 +
          gauss(t, 0.58, 0.08) * 1.05 +
          gauss(t, 0.76, 0.14) * 0.72;
        const jitter =
          0.5 + 0.5 * Math.sin(time * (1.4 + (seeds[col % BARS] ?? 0) * 1.8) + col * 0.54);
        const height =
          options.rows *
          clamp(
            envelope * options.density * (0.48 + activity * 0.52) +
              valueAt(t) * options.waveBias * (0.35 + activity * 0.9) +
              jitter * 0.1 * activity,
            0.06,
            1,
          );
        const x = options.left + colGap * col;

        for (let row = 0; row <= height; row += 1) {
          const p = row / options.rows;
          const alpha = (0.28 + p * 0.7) * edgeAlpha(t) * settings.opacity;
          graphics
            .circle(x, options.base - row * rowGap, options.dotRadius)
            .fill({ color: dotColor(options.colorMode, p, false), alpha });

          if (options.mirror && row > 1) {
            graphics
              .circle(x, options.base + row * rowGap, options.dotRadius)
              .fill({ color: dotColor(options.colorMode, p, true), alpha: alpha * 0.74 });
          }
        }
      }
    };

    /** How thick a ribbon is at one point: five overlapping bumps plus a centre mass. */
    const ribbonLobeAt = (t: number, row: number, layer: number): number => {
      const rowShift = (row % 2) * 0.055 - 0.025;
      const layerShift = ((layer % 3) - 1) * 0.035;
      const drift = Math.sin(time * 0.14 + row * 0.7 + layer) * 0.018;
      const centres = [
        0.17 + rowShift - layerShift * 0.35,
        0.33 - rowShift * 0.6 + layerShift,
        0.5 + rowShift * 0.3 - layerShift * 0.4,
        0.66 - rowShift + layerShift * 0.65,
        0.82 + rowShift * 0.35 - layerShift,
      ];
      const widths = [0.058, 0.085, 0.105, 0.088, 0.055];
      let lobe = 0;

      for (let i = 0; i < centres.length; i += 1) {
        const centre = centres[i] ?? 0.5;
        const width = widths[i] ?? 0.08;
        const weight =
          0.52 +
          0.24 * Math.sin(row * 1.9 + layer * 1.17 + i * 0.83) +
          valueAt(clamp(centre)) * 0.18;
        lobe += gauss(t, centre + drift, width) * weight;
      }

      return clamp(lobe + gauss(t, 0.5 + drift * 0.4, 0.22) * 0.26, 0, 1.35);
    };

    /**
     * One organic ribbon: a filled polygon whose upper and lower edges are traced separately.
     *
     * The lower edge is `unshift`ed rather than pushed, so the two runs join into a single closed
     * outline that goes out along the top and back along the bottom. Pushing both would produce a
     * bow-tie.
     */
    const drawBlobRibbon = (options: {
      cy: number;
      left: number;
      span: number;
      amp: number;
      thickness: number;
      row: number;
      layer: number;
      color: number;
      alpha: number;
      lobeScale: number;
    }): void => {
      const upper: number[] = [];
      const lower: number[] = [];
      const phase = options.row * 0.74 + options.layer * 1.31;
      const speed = 0.2 + activity * 0.8 + envelopes.fast * activity * 0.42;

      for (let i = 0; i <= SEGMENTS; i += 1) {
        const t = i / SEGMENTS;
        const edge = edgeAlpha(t);
        const lobes = ribbonLobeAt(t, options.row, options.layer) * options.lobeScale;
        const sampleT = clamp(t + options.layer * 0.014 - options.row * 0.01);
        const sample = valueAt(sampleT);
        const peak = peakAt(sampleT);
        const audio =
          0.32 +
          sample * (0.95 + activity * 0.45) +
          peak * 0.42 +
          activity * 0.28 +
          beat * gauss(t, 0.5, 0.3) * 0.34;
        const carrier =
          Math.sin(t * TAU * (1.38 + options.layer * 0.1) + phase + time * speed * 0.9) *
            (0.52 + sample * 0.18) +
          Math.sin(t * TAU * (2.95 + options.row * 0.18) - phase + wavePhase * 0.7 + i * 0.02) *
            0.2 +
          Math.sin(t * TAU * (0.82 + options.layer * 0.035) + wavePhase * 1.4 + i * 0.16) * 0.16;
        const lift =
          carrier * options.amp * edge * (0.21 + lobes * 0.64) * (0.76 + activity * 0.22);
        const half =
          options.thickness *
          edge *
          Math.max(0.02, lobes) *
          (0.86 + audio * 0.52) *
          (0.72 + 0.2 * Math.sin(wavePhase + t * TAU * 1.9 + phase));
        const x = options.left + options.span * t;

        upper.push(x, options.cy + lift - half);
        lower.unshift(x, options.cy + lift + half);
      }

      graphics.poly([...upper, ...lower]).fill({
        color: options.color,
        alpha: options.alpha * (0.72 + activity * 0.22) * settings.opacity,
      });
    };

    const zigzagAt = (i: number, t: number, amp: number): number => {
      const triangle = i % 2 === 0 ? -1 : 1;
      return (
        triangle *
        amp *
        (0.16 + gauss(t, 0.5, 0.25) * 0.92 + valueAt(t) * 0.35) *
        (0.9 + 0.1 * activity * Math.sin(time * 0.65 + t * TAU * 3))
      );
    };

    /** Draws whichever look this effect is. The only part that differs between the eight. */
    const draw = (): void => {
      const w = stage.width;
      const h = stage.height;
      const cy = h * settings.centre;
      const amp = settings.amplitude;
      const span = w * settings.width;
      const left = (w - span) * 0.5;

      graphics.clear();
      if (settings.background) {
        graphics.rect(0, 0, w, h).fill({ color: settings.backgroundColor });
      }

      switch (look.variant) {
        case "pulse":
          drawDotSkyline({
            base: cy,
            left,
            span,
            maxHeight: h * 0.22 * amp,
            columns: 72,
            rows: 28,
            mirror: true,
            dotRadius: 3.3,
            colorMode: "rainbowVertical",
            density: 0.86,
            waveBias: 0.4,
          });
          break;

        case "prism": {
          const columns = 68;
          const rows = 22;
          const colGap = span / Math.max(1, columns - 1);
          const rowGap = (h * 0.18 * amp) / rows;
          const calm = activity < 0.06;

          for (let col = 0; col < columns; col += 1) {
            const t = col / Math.max(1, columns - 1);
            const envelope =
              gauss(t, 0.24, 0.1) * 0.55 +
              gauss(t, 0.42, 0.14) * 0.78 +
              gauss(t, 0.58, 0.08) * 1.05 +
              gauss(t, 0.76, 0.14) * 0.72;
            const responsive =
              rows *
              clamp(
                (0.06 + envelope * 0.72 * (0.48 + activity * 0.52)) * (0.24 + activity * 1.1) +
                  valueAt(t) * 0.28 * (0.35 + activity * 0.9) +
                  (calm
                    ? 0
                    : 0.1 *
                      (0.5 +
                        0.5 *
                          Math.sin(time * (1.4 + (seeds[col % BARS] ?? 0) * 1.8) + col * 0.54)) *
                      activity),
                0.06,
                1,
              );
            const height = calm ? 1 : Math.ceil(responsive);
            const x = left + colGap * col;

            for (let row = 0; row < height; row += 1) {
              const p = row / rows;
              graphics.circle(x, cy - row * rowGap, 3).fill({
                color: dotColor("cyanDepth", p, false),
                alpha: (0.28 + p * 0.7) * edgeAlpha(t) * settings.opacity,
              });
            }
          }
          break;
        }

        case "spectrum": {
          const columns = 42;
          const rows = 18;
          const cellW = span / columns;
          const cellH = h * 0.018 * amp;
          const calm = activity < 0.06;
          const tone = clamp(0.2 + bus.level * 0.8);

          for (let i = 0; i < columns; i += 1) {
            const t = i / (columns - 1);
            const energy =
              valueAt(t) * (0.28 + activity * 0.72) +
              gauss(t, 0.48, 0.2) *
                (0.09 + envelopes.slow * activity * 0.42) *
                (0.4 + activity * 0.5);
            const noise = calm
              ? 0
              : 0.05 * activity * (0.5 + 0.5 * Math.sin(time * 0.42 + i * 0.65 + wavePhase * 0.8));
            const height = calm
              ? 1
              : Math.ceil(rows * clamp(0.06 + energy + noise + tone * 0.03, 0.08, 1));
            const x = left + span * t;

            for (let row = 0; row < height; row += 1) {
              graphics.rect(x, cy - row * cellH, cellW * 0.74, cellH * 0.56).fill({
                color: mixColor(BLUE, CYAN, row / rows),
                alpha:
                  (calm
                    ? 0.22
                    : 0.16 + (row / rows) * (0.5 + activity * 0.12) * (0.55 + energy * 0.75)) *
                  settings.opacity,
              });
            }
          }
          break;
        }

        case "weave": {
          const waveAmp = h * (0.045 + activity * 0.075 + bus.level * activity * 0.05) * amp;
          const steps = 58;
          for (let i = 0; i < steps; i += 1) {
            const t0 = i / steps;
            const t1 = (i + 1) / steps;
            glowLine(
              left + span * t0,
              cy + zigzagAt(i, t0, waveAmp),
              left + span * t1,
              cy + zigzagAt(i + 1, t1, waveAmp),
              paletteAt(t0, 0.25),
              edgeAlpha(t0) * 0.88,
              1.6,
              10,
            );
          }
          break;
        }

        case "helix": {
          const waveAmp = h * (0.032 + activity * 0.048 + envelopes.mid * activity * 0.06) * amp;
          for (let layer = 0; layer < 4; layer += 1) {
            strokeWave(
              cy,
              left,
              span,
              waveAmp * (0.6 + layer * 0.16),
              2.5 + layer * 0.36,
              layer * 0.62 + time * 0.58,
              layer % 2 === 0 ? CYAN : MAGENTA,
              0.66,
              1.1,
            );
          }
          glowLine(left, cy, left + span, cy, BLUE, 0.32, 1, 12);
          break;
        }

        case "ribbons": {
          const ribbonAmp = h * (0.055 + activity * 0.075 + bus.level * activity * 0.055) * amp;
          glowLine(left, cy, left + span, cy, WHITE, 0.22, 0.9, 12);
          for (let layer = 0; layer < 7; layer += 1) {
            drawBlobRibbon({
              cy,
              left,
              span,
              amp: ribbonAmp * (0.72 + layer * 0.07),
              thickness: h * (0.052 + layer * 0.004),
              row: 1,
              layer,
              color: paletteEntry(RIBBON_PALETTE, layer * 2),
              alpha: 0.4,
              lobeScale: 0.96,
            });
          }
          drawBlobRibbon({
            cy,
            left,
            span,
            amp: ribbonAmp * 0.28,
            thickness: h * 0.018,
            row: 1,
            layer: 8,
            color: WHITE,
            alpha: 0.76,
            lobeScale: 0.62,
          });
          break;
        }

        case "ribbonBands": {
          const ribbonAmp = h * (0.074 + activity * 0.11 + envelopes.slow * activity * 0.07) * amp;
          glowLine(left, cy, left + span, cy, CYAN, 0.2, 1, 14);
          for (let layer = 0; layer < 8; layer += 1) {
            drawBlobRibbon({
              cy,
              left,
              span,
              amp: ribbonAmp * (0.62 + layer * 0.075),
              thickness: h * (0.075 + layer * 0.005),
              row: 3,
              layer,
              color: paletteEntry(RIBBON_PALETTE, layer + 2),
              alpha: 0.34,
              lobeScale: 1.12,
            });
          }
          break;
        }

        case "ribbonLattice": {
          const ribbonAmp = h * (0.06 + activity * 0.105 + envelopes.mid * activity * 0.065) * amp;
          glowLine(left, cy, left + span, cy, WHITE, 0.22, 1, 14);
          for (let layer = 0; layer < 8; layer += 1) {
            drawBlobRibbon({
              cy,
              left,
              span,
              amp: ribbonAmp * (0.44 + layer * 0.065),
              thickness: h * (0.03 + layer * 0.0045),
              row: layer % 4,
              layer,
              color: paletteEntry(RIBBON_PALETTE, layer),
              alpha: 0.34,
              lobeScale: 0.9,
            });
          }
          for (let layer = 0; layer < 4; layer += 1) {
            strokeWave(
              cy,
              left,
              span,
              ribbonAmp * (0.32 + layer * 0.08),
              2.4 + layer * 0.55,
              time * 0.36 + layer * 1.7,
              paletteEntry(RIBBON_PALETTE, layer * 2 + 1),
              0.42,
              0.9,
            );
          }
          break;
        }
      }
    };

    onFrame(scope, ctx.fpsCap, ({ dt, now }) => {
      bus.sample(now);
      envelopes.update(dt);

      time += dt;

      /*
       * `activity` is how alive the display is overall, and it is smoothed separately from the
       * bands with a fast rise and a slow fall. It is what stops a quiet passage collapsing the
       * whole visualiser to a flat line and then snapping it back on the next syllable.
       *
       * The gate is lower when the audio is real than when it is simulated: a live signal spends
       * most of its time well below full scale, so a threshold tuned for the simulation would read
       * ordinary speech as silence.
       */
      const energy =
        bus.level + envelopes.slow * 0.45 + envelopes.mid * 0.28 + envelopes.fast * 0.12;
      const target = envelopes.live
        ? smoothstep(0.035, 0.42, energy * settings.reactivity)
        : smoothstep(0.32, 0.75, energy * settings.reactivity);
      activity += (target - activity) * Math.min(1, dt * (target > activity ? 14 : 4));

      const beatGate = envelopes.live ? 0.12 : 0.28;
      const beatTarget = envelopes.beat && activity > beatGate ? 1 : 0;
      beat += (beatTarget - beat) * Math.min(1, dt * 8);

      wavePhase += dt * (0.18 + activity * 0.25);

      updateBands(dt);
      draw();
      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        settings = readSettings(p, look);
      },
    };
  };
}
