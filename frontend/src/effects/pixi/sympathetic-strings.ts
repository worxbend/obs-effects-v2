import * as PIXI from "pixi.js";

import { at, bool, colorInt, int, lerp, num, str } from "../paramUtils";
import {
  createEnvelopes,
  createPixiStage,
  defineEffect,
  onFrame,
  palette,
  paletteAtInt,
  paletteParam,
  useAudio,
  useChat,
} from "../sdk";
import type { ChatMessage } from "~/types/contract";

/**
 * Sympathetic Strings
 * ===================
 *
 * A row of taut hairlines lies across the frame doing nothing at all, until a chat message plucks
 * one. A real travelling wave then races out from the pluck point to both ends, flips upside down
 * as it bounces off the bridges, and crosses back through itself — the shape a guitar string
 * actually makes — while the streamer's voice sets every *other* string humming faintly in
 * sympathy, the way an open piano rings when you sing into it.
 *
 * What is on screen
 * -----------------
 * Nine ivory hairlines, spaced evenly down the middle of the frame, ending in two small bridge
 * blocks inset from each edge so the eye reads them as *strung* rather than merely drawn. At rest
 * they are barely visible. A chat message picks one string from the sender's `seed`, so the same
 * chatter always rings the same note, and the string is tinted with that person's chat colour for
 * as long as it keeps sounding. Subs, cheers and raids strum every string at once.
 *
 * The physics, for someone who has not met a wave equation
 * -------------------------------------------------------
 * Each string is stored as two lists of numbers, one per sample point along its length: how far
 * that point is pushed off the line (`u`, in pixels) and how fast it is moving (`v`, in pixels per
 * second). Every simulation step asks one question of each point: *am I above or below the average
 * of my two neighbours?* A point sitting below its neighbours is being stretched upward by the
 * string on either side, so it accelerates up; a point above them accelerates down. Written out,
 * that is
 *
 * ```
 * acceleration = c² · (u[i-1] − 2·u[i] + u[i+1]) / dx²  −  damping · v[i]
 * ```
 *
 * and nothing else. There is no library, no `sin`, and no keyframe. Pull a point aside and let go,
 * and that one rule produces the whole plucked-string signature by itself: the triangular bump
 * splits into two half-height triangles that run in opposite directions, invert when they reach a
 * pinned end, and pass straight through each other on the way back. That travelling-and-reflecting
 * behaviour is the reason this reads as an instrument rather than as an animated sine wave, and it
 * is why the simulation is worth having instead of a formula.
 *
 * Why the time step is fixed, and why the speed is clamped
 * -------------------------------------------------------
 * A finite-difference solver like this one is only stable while a wave crosses **less than one
 * sample spacing per step** — the Courant condition. Break it and the numbers do not merely look
 * wrong, they double every step and reach infinity in about a second, which on air is a string that
 * explodes into static and never recovers.
 *
 * Two things keep that from happening. The simulation runs on its own fixed 1/240 s clock rather
 * than on the frame's `dt`, with the number of catch-up steps per frame capped, so a stutter, a
 * dragged window or a browser tab waking up cannot hand it a huge step. And the Wave Speed
 * parameter is clamped against the current Resolution before it is used, so no combination of
 * slider positions can produce an unstable pair. Raising Resolution therefore lowers the maximum
 * usable speed — finer sample spacing means a stricter limit — which is a real trade and is called
 * out in both parameter descriptions.
 *
 * The sympathetic hum is not simulated
 * ------------------------------------
 * The voice-driven shimmer is added at drawing time as an ordinary standing wave —
 * `sin(π · harmonic · x) · amplitude · sin(ω · t)`, with string *i* vibrating in *i+1* lobes at its
 * own natural frequency. It is never fed into the solver. That is deliberate: because it never
 * touches `u` or `v`, it cannot destabilise the integrator no matter how loud the streamer gets. It
 * costs two sine calls per drawn point on the frames where it is audible at all, and is skipped
 * outright on the frames where it is not — which, on a just-chatting scene, is most of them.
 * Loudness comes from the SDK's audio envelopes —
 * `slow` for the body of the hum, `fast` for a fine grain over the top. They are envelopes at
 * different speeds, not frequency bands; obs-websocket sends loudness only, never a spectrum.
 *
 * Composition
 * -----------
 * The canvas is transparent, so this layers over a game, a camera or a plain colour. It is built
 * for a talking or just-chatting scene: silent and nearly invisible while nothing happens, and it
 * turns every individual chatter into a note instead of another card sliding in.
 */

/**
 * The simulation's own clock, in seconds. Chosen as a multiple of the common display rates so a
 * 60 fps route spends exactly four steps per frame and a 30 fps one exactly eight.
 */
const FIXED_STEP = 1 / 240;

/**
 * The most simulation steps one frame may run.
 *
 * Eight covers a 30 fps route, which is a normal setting for an OBS browser source, so the usual
 * case never falls behind. When a frame is slower still — a hitch, a backgrounded tab — the leftover
 * time is dropped rather than repaid, and the strings ring out very slightly slowly for that instant
 * instead of the solver being handed a step large enough to blow it up.
 */
const MAX_SUBSTEPS = 8;

/**
 * The largest Courant number the solver is allowed to run at: how far a wave may travel in one step,
 * measured in sample spacings. The theoretical limit is 1; staying under it leaves room for the
 * damping term, which nudges the real limit down a little.
 */
const COURANT_LIMIT = 0.9;

/** Half-width of the triangular pluck, as a fraction of the string's sample count. */
const PLUCK_WIDTH_FRACTION = 0.05;

/**
 * The furthest a string may swing from its rest line, as a multiple of the tallest single pluck the
 * current parameters can produce.
 *
 * A pluck *adds* to whatever shape is already on the string, which is what lets a second message
 * during a ring-out brighten a note instead of restarting it. Nothing about that addition is
 * bounded, though: a spam burst, or a raid landing on a chat that is already busy, drives energy in
 * faster than Ring-Out takes it out, and a string can end up swinging a thousand pixels — far
 * outside the frame, and dragging every other string's spacing into nonsense.
 *
 * Three pluck heights is well above anything one message produces, so ordinary chat never reaches
 * it. See `limitSwing` for how the ceiling is applied, which turns out to matter more than the
 * number does.
 */
const MAX_SWING_STACK = 3;

/**
 * Below this, in pixels, the sympathetic hum is treated as silence and skipped entirely.
 *
 * The hum costs two `sin` calls per drawn point, and it is exactly zero whenever Resonance is 0 or
 * the streamer is not making a sound — which, on a just-chatting scene, is most frames.
 */
const HUM_SILENCE_PX = 0.0005;

/** How far from each bridge a pluck may land, as a fraction of the string. Ends make no sound. */
const PLUCK_INSET = 0.15;

/** Seconds a detected beat holds the damper open for, when Beat Sustain is on. */
const BEAT_SUSTAIN_S = 0.6;

/** What the damping is multiplied by while the damper is open. Below 1 means "rings for longer". */
const SUSTAIN_DAMP_SCALE = 0.45;

/**
 * Turns the Ring-Out parameter (a duration a human can picture) into the damping coefficient the
 * acceleration rule wants. A damped oscillator's amplitude follows `exp(-damping · t / 2)`, so
 * `damping = 8 / seconds` leaves about 2% of the original swing after `seconds` have passed.
 */
const DAMP_SHAPE = 8;

/** The same idea for the brightness envelope: a plucked string fades to ~2% lit over its ring-out. */
const RING_SHAPE = 4;

/**
 * Draw every second sample point rather than all of them. At the default resolution that is a
 * 97-point polyline per string, which is smooth well past the point the eye can tell, for half the
 * geometry.
 */
const SAMPLE_STRIDE = 2;

/** The two ways the harp can be laid out. Stored in a route, so these strings are append-only. */
const ORIENTATIONS = ["horizontal", "vertical"];

/** One string: where every point along it is, how fast it is moving, and how lit it currently is. */
interface StringState {
  /** Displacement of each sample point away from the rest line, in pixels. Ends stay pinned at 0. */
  u: Float32Array;
  /** Speed of each sample point, in pixels per second. */
  v: Float32Array;
  /** 0 when still, 1 the instant it is plucked. Drives colour and brightness, not the physics. */
  ring: number;
  /** The 24-bit colour this string wears while it sounds — usually the plucker's chat colour. */
  tint: number;
}

/**
 * Reads a `#rrggbb` string that came from chat rather than from a parameter.
 *
 * `colorInt` in `paramUtils` reads out of the merged parameter record; a chat message's colour is a
 * bare string off the wire, so it gets its own validated parse with the same never-throw promise.
 *
 * The parameter is typed `unknown` rather than `string` on purpose. `ChatMessage.color` is declared
 * as a string, but the value arrives over a WebSocket from a backend that could be a version ahead
 * or behind, and a missing field would make `value.startsWith` throw *inside a chat listener* —
 * which the chat bus catches and logs once per message, silently dropping that message's pluck.
 * Checking the type here costs one comparison and removes the whole failure mode.
 */
function colorFromHex(value: unknown, fallback: number): number {
  if (typeof value !== "string") return fallback;
  const digits = value.startsWith("#") ? value.slice(1) : value;
  if (!/^[0-9a-fA-F]{6}$/.test(digits)) return fallback;
  return Number.parseInt(digits, 16);
}

/** Blends two 24-bit colours channel by channel. `t = 0` gives `a`, `t = 1` gives `b`. */
function mixColor(a: number, b: number, t: number): number {
  const k = Math.min(1, Math.max(0, t));
  const r = Math.round(lerp((a >> 16) & 0xff, (b >> 16) & 0xff, k));
  const g = Math.round(lerp((a >> 8) & 0xff, (b >> 8) & 0xff, k));
  const bl = Math.round(lerp(a & 0xff, b & 0xff, k));
  return (r << 16) | (g << 8) | bl;
}

/**
 * Copies a string's state into a differently-sized pair of buffers.
 *
 * Used when the Resolution parameter changes while something is ringing: nearest-neighbour
 * resampling keeps the shape that is currently on screen instead of silencing every string for a
 * frame, which is what allocating empty buffers would look like.
 */
function resample(source: Float32Array, nodes: number): Float32Array {
  const out = new Float32Array(nodes);
  const from = source.length;
  if (from < 2 || nodes < 2) return out;
  // The first and last entries stay at zero: those are the bridges, and they never move.
  for (let i = 1; i < nodes - 1; i += 1) {
    const t = i / (nodes - 1);
    out[i] = at(source, Math.min(from - 1, Math.round(t * (from - 1))));
  }
  return out;
}

/**
 * Keeps one string's swing inside `ceiling`, by scaling the *whole* string rather than trimming it.
 *
 * ## Why the obvious version is wrong
 *
 * The first thing anyone writes here is a per-point clamp — `u[i] = min(ceiling, max(-ceiling,
 * u[i]))` — and it makes the effect *worse*, in a way that only a numerical experiment shows. A
 * clamp flattens the top of the wave and leaves a corner where the flat part meets the curve. A
 * corner is not a shape a string can hold: it is made of every spatial frequency at once, including
 * the very shortest one the sample grid can represent, one sample up and the next one down. The
 * finite-difference rule at the top of this file reads exactly that neighbour-to-neighbour
 * difference, so the sharpest possible zig-zag gets the largest possible acceleration, and the
 * clamp keeps re-cutting a fresh corner every time the wave pushes past the ceiling. Simulated at
 * the default settings, a sustained burst of plucks with a per-point clamp reaches infinity in
 * about five seconds and the string is then dead for good — `Infinity` never damps back down. The
 * *same* burst with no limiter at all stays finite; it merely gets embarrassingly large.
 *
 * ## What this does instead
 *
 * It measures the string's widest swing and, if that is over the ceiling, multiplies every
 * displacement *and* every velocity by one number. Scaling adds no new spatial frequencies at all —
 * the shape is untouched, only its size — and because the wave equation is linear, the result is
 * bit-for-bit the state the string would have been in had every pluck so far been proportionally
 * gentler. So it cannot destabilise anything, and on screen it reads as the harp quietly refusing
 * to be shouted at rather than as a clipped waveform.
 *
 * The scan doubles as the effect's only guard against a non-finite value ever reaching the
 * geometry. Nothing in the current arithmetic can produce one — the Courant clamp in `safeSpeed`
 * is what makes that true — but if a later change did, `NaN` would spread across the string in one
 * step, survive every subsequent frame, and show up as an invisible or garbage string with nothing
 * in the console. Silencing that one string costs a comparison per sample and turns a permanent
 * failure into a momentary one.
 */
function limitSwing(state: StringState, ceiling: number): void {
  const { u, v } = state;
  let peak = 0;
  for (let i = 0; i < u.length; i += 1) {
    const value = at(u, i);
    if (!Number.isFinite(value)) {
      u.fill(0);
      v.fill(0);
      state.ring = 0;
      return;
    }
    const swing = value < 0 ? -value : value;
    if (swing > peak) peak = swing;
  }
  if (peak <= ceiling) return;
  const scale = ceiling / peak;
  for (let i = 0; i < u.length; i += 1) {
    u[i] = at(u, i) * scale;
    v[i] = at(v, i) * scale;
  }
}

const sympatheticStrings = defineEffect({
  descriptor: {
    id: "sympathetic-strings",
    name: "Sympathetic Strings",
    description:
      "A row of taut hairlines that a chat message plucks into a real travelling wave, reflecting off two bridges, while the streamer's voice sets every string humming faintly in sympathy.",
    engine: "pixi",
    category: "chat",
    tags: ["chat", "twitch", "audio", "reactive", "minimal", "physics", "ambient", "pixi"],
    previewNotes:
      "Transparent and deliberately quiet: at rest it is a set of faint ivory hairlines, so lay it straight over a game, a camera or a plain colour. Chat messages pluck it and the streamer's voice makes it hum, which means an idle preview with no Twitch channel configured only rings every few seconds when the simulated chat speaks.",
    params: [
      {
        key: "stringCount",
        label: "Strings",
        kind: "number",
        default: 9,
        min: 3,
        max: 16,
        step: 1,
        description:
          "How many strings the harp has. Each chatter is assigned one of them permanently, so more strings means more distinct voices in the picture.",
      },
      {
        key: "nodeCount",
        label: "Resolution",
        kind: "number",
        default: 192,
        min: 64,
        max: 384,
        step: 32,
        description:
          "How many points each string is simulated at. Higher is smoother and slightly costlier, and it also lowers the highest usable Wave Speed — finer spacing makes the solver stricter about how far a wave may move per step.",
      },
      {
        key: "tension",
        label: "Wave Speed",
        kind: "number",
        default: 1,
        min: 0.15,
        max: 2.5,
        step: 0.05,
        description:
          "How fast a pluck races to the ends, in string-lengths per second, which is also the apparent pitch. Around 1 lets the eye follow one wave out and back. High values are quietly capped when Resolution is high, so the simulation stays stable.",
      },
      {
        key: "damping",
        label: "Ring-Out",
        kind: "number",
        default: 2.4,
        min: 0.3,
        max: 8,
        step: 0.1,
        description:
          "How long a plucked string keeps sounding before it stills, in seconds. Short values give a dry, muted pluck; long ones let the frame stay alive between messages.",
      },
      {
        key: "pluckStrength",
        label: "Pluck Height",
        kind: "number",
        default: 14,
        min: 2,
        max: 60,
        step: 1,
        description:
          "How far an ordinary chat message pulls its string aside, in pixels, before letting go.",
      },
      {
        key: "eventBoost",
        label: "Event Boost",
        kind: "number",
        default: 2.5,
        min: 1,
        max: 6,
        step: 0.1,
        description:
          "Multiplier on the pluck height for subs, gifted subs, cheers and raids. Those also strum every string at once instead of one, so the harp answers with a chord.",
      },
      {
        key: "resonance",
        label: "Resonance",
        kind: "number",
        default: 1,
        min: 0,
        max: 3,
        step: 0.05,
        description:
          "How strongly the streamer's voice sets the strings humming in sympathy. 0 makes the effect answer to chat alone and sit perfectly still in between.",
      },
      {
        key: "beatSustain",
        label: "Beat Sustain",
        kind: "boolean",
        default: true,
        description:
          "Whether a detected beat briefly lifts the damper, so plucks ring out for longer while music is playing.",
      },
      {
        key: "lineWidth",
        label: "Line Width",
        kind: "number",
        default: 1.1,
        min: 0.5,
        max: 6,
        step: 0.1,
        description:
          "Thickness of a string in pixels. Hairline values read as wire rather than rope.",
      },
      {
        key: "glow",
        label: "Bloom",
        kind: "number",
        default: 0.12,
        min: 0,
        max: 1,
        step: 0.01,
        description:
          "Opacity of the soft additive halo drawn behind each string, so a hard pluck glows. 0 removes the halo entirely and leaves a pure hairline.",
      },
      {
        key: "idleOpacity",
        label: "Idle Opacity",
        kind: "number",
        default: 0.1,
        min: 0.01,
        max: 1,
        step: 0.01,
        description:
          "How visible a still, unplucked string is. Low values keep the harp almost invisible until chat moves it; it never reaches zero so the instrument is always findable on screen.",
      },
      {
        key: "tintFromChat",
        label: "Tint From Chat",
        kind: "boolean",
        default: true,
        description:
          "Colour a sounding string with the sender's own Twitch chat colour. Turn it off to keep every string on the chosen palette instead.",
      },
      paletteParam(
        "palette",
        "Palette",
        "ember",
        "Colour ramp a sounding string takes. Ember is the warm bone-and-brass default this effect was designed around.",
      ),
      {
        key: "stringColor",
        label: "Rest Colour",
        kind: "color",
        default: "#efe6d5",
        description: "Colour of a still string and of the bridge blocks at each end.",
      },
      {
        key: "orientation",
        label: "Orientation",
        kind: "select",
        default: "horizontal",
        options: ORIENTATIONS,
        description:
          "Run the strings across the frame, or turn the harp on its side to make a narrow side rail.",
      },
      {
        key: "margin",
        label: "Bridge Inset",
        kind: "number",
        default: 48,
        min: 0,
        max: 400,
        step: 2,
        description:
          "How far in from the edges the two bridge blocks sit, in pixels. The strings are pinned there, so this also sets their length.",
      },
      {
        key: "spread",
        label: "Spread",
        kind: "number",
        default: 0.62,
        min: 0.1,
        max: 1,
        step: 0.01,
        description:
          "How much of the frame the whole bank of strings covers, across the strings rather than along them. The bank always stays centred.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    let stringCount = int(ctx.params, "stringCount", 9, 3, 16);
    let nodeCount = int(ctx.params, "nodeCount", 192, 64, 384);
    let tension = num(ctx.params, "tension", 1, 0.15, 2.5);
    let ringOut = num(ctx.params, "damping", 2.4, 0.3, 8);
    let pluckStrength = num(ctx.params, "pluckStrength", 14, 2, 60);
    let eventBoost = num(ctx.params, "eventBoost", 2.5, 1, 6);
    let resonance = num(ctx.params, "resonance", 1, 0, 3);
    let beatSustain = bool(ctx.params, "beatSustain", true);
    let lineWidth = num(ctx.params, "lineWidth", 1.1, 0.5, 6);
    let glow = num(ctx.params, "glow", 0.12, 0, 1);
    let idleOpacity = num(ctx.params, "idleOpacity", 0.1, 0.01, 1);
    let tintFromChat = bool(ctx.params, "tintFromChat", true);
    let restColor = colorInt(ctx.params, "stringColor", "#efe6d5");
    let horizontal = str(ctx.params, "orientation", "horizontal") !== "vertical";
    let margin = num(ctx.params, "margin", 48, 0, 400);
    let spread = num(ctx.params, "spread", 0.62, 0.1, 1);

    /*
     * The two colours sampled out of the palette, parsed here rather than per string per frame.
     * `voiceColor` is what an ordinary pluck wears when chat tinting is off; `eventColor` is the
     * brighter end of the ramp, reserved for subs, cheers and raids so a chord is visibly different
     * from a message.
     */
    let ramp = palette(ctx.params, "palette", "ember");
    let voiceColor = paletteAtInt(ramp, 0.62);
    let eventColor = paletteAtInt(ramp, 1);

    /*
     * Two awaits, and the renderer may have disposed this effect during either of them. Neither
     * `useAudio` nor `useChat` checkpoints on its own — both resolve normally on a dead scope,
     * having already registered the release of their lease — so the checkpoints below are written by
     * hand. Without them a disposed effect would carry on and build a whole WebGL context.
     */
    const bus = await useAudio(scope);
    scope.checkpoint();
    const chat = await useChat(scope);
    scope.checkpoint();

    const stage = await createPixiStage(scope, ctx);

    const envelopes = createEnvelopes(bus);

    /*
     * Two layers, both rebuilt from scratch every frame. The bloom sits underneath and is drawn in
     * additive blending — colours add to whatever is behind instead of covering it, which is what a
     * light source does — so a bright pluck spills a halo without ever darkening the scene.
     */
    const bloom = stage.stage.addChild(new PIXI.Graphics());
    bloom.blendMode = "add";
    const core = stage.stage.addChild(new PIXI.Graphics());

    /** Builds one string's buffers. The two end points are the bridges and are never written. */
    const makeString = (nodes: number): StringState => ({
      u: new Float32Array(nodes),
      v: new Float32Array(nodes),
      ring: 0,
      tint: restColor,
    });

    const strings: StringState[] = [];
    for (let i = 0; i < stringCount; i += 1) strings.push(makeString(nodeCount));

    /*
     * Scratch space for the polyline currently being drawn. One string's points are computed once
     * into these arrays and then stroked twice — once for the bloom, once for the core — so the
     * sine calls behind the sympathetic hum are paid for once rather than twice.
     */
    let maxSamples = Math.ceil(nodeCount / SAMPLE_STRIDE) + 2;
    let pathX = new Float32Array(maxSamples);
    let pathY = new Float32Array(maxSamples);

    /** Left-over simulation time carried from the previous frame, in seconds. */
    let accumulator = 0;

    /**
     * The sympathetic hum's own phase, in half-cycles of a unit-length string's fundamental.
     *
     * It is advanced by `dt · speed` each frame rather than computed from `elapsed · speed`, and
     * the difference matters the moment an operator drags the Wave Speed slider: with the second
     * form, every string's hum would jump instantly to wherever the *new* speed says it should have
     * been after all the seconds so far, which reads on air as a visible snap. Integrating the
     * speed instead means the pitch changes and the shape stays continuous, like a tuning peg.
     *
     * Every term below is `sin(π · integer · humClock)`, whose period in `humClock` is exactly 2,
     * so wrapping at 2 is bit-for-bit invisible and keeps the value small enough that `Math.sin`
     * loses no precision over a broadcast measured in days.
     */
    let humClock = 0;

    /** Seconds of held-open damper remaining, set by a beat when Beat Sustain is on. */
    let sustainLeft = 0;

    /**
     * The wave speed actually used, in string-lengths per second.
     *
     * A wave must not cross more than one sample spacing per simulation step. With a spacing of
     * `1 / (nodes - 1)` and a step of `FIXED_STEP`, that caps the speed at
     * `COURANT_LIMIT / (FIXED_STEP · (nodes - 1))`. Clamping here — once, where both values are
     * known — is what makes it impossible for any pair of slider positions to produce a string that
     * explodes into noise.
     */
    const safeSpeed = (): number => {
      const limit = COURANT_LIMIT / (FIXED_STEP * Math.max(1, nodeCount - 1));
      return Math.min(tension, limit);
    };

    /**
     * Advances every string by one fixed step.
     *
     * `damping` arrives already scaled for the open-damper state, so the integrator itself has no
     * idea beats exist.
     */
    const stepPhysics = (h: number, damping: number): void => {
      const speed = safeSpeed();
      // dx is 1 / (nodes - 1) in string-length units, so c² / dx² is c² · (nodes - 1)².
      const spacing = Math.max(1, nodeCount - 1);
      const stiffness = speed * speed * spacing * spacing;

      for (const state of strings) {
        const { u, v } = state;
        const last = u.length - 1;
        if (last < 2) continue;

        /*
         * Two passes, and the order matters. The first reads `u` everywhere and writes only `v`, so
         * every point's acceleration is computed from the *same* snapshot of the string; folding
         * them into one loop would let a point feel its neighbour's new position and quietly bias
         * the wave in the direction of the loop.
         */
        for (let i = 1; i < last; i += 1) {
          const curvature = at(u, i - 1) - 2 * at(u, i) + at(u, i + 1);
          v[i] = at(v, i) + (stiffness * curvature - damping * at(v, i)) * h;
        }
        for (let i = 1; i < last; i += 1) {
          u[i] = at(u, i) + at(v, i) * h;
        }
      }
    };

    /**
     * Pulls one string aside in a narrow triangle and lets go.
     *
     * Only the displacement is touched; the velocity is deliberately left alone, because that is
     * what a pluck is — a shape held still and then released. The wave equation takes it from
     * there, splitting the triangle into two half-height copies that run for the bridges.
     */
    const pluck = (state: StringState, positionT: number, height: number, tint: number): void => {
      const nodes = state.u.length;
      if (nodes < 4) return;
      const centre = Math.round(positionT * (nodes - 1));
      const half = Math.max(2, Math.round(nodes * PLUCK_WIDTH_FRACTION));
      for (let i = centre - half + 1; i < centre + half; i += 1) {
        if (i <= 0 || i >= nodes - 1) continue;
        const falloff = 1 - Math.abs(i - centre) / half;
        state.u[i] = at(state.u, i) + height * falloff;
      }
      // Adding rather than assigning means a second message during a ring-out brightens the string
      // instead of restarting it, which is what the ear expects from a re-plucked note.
      state.ring = Math.min(1, state.ring + 0.85);
      state.tint = tint;
    };

    /**
     * Where along the string a given sender's pluck lands: deterministic from their seed, and kept
     * away from both bridges because a string pinned at a point cannot move there.
     */
    const positionFor = (seed: number, salt: number): number => {
      const spread01 = ((seed >> salt) & 0x3ff) / 0x3ff;
      return PLUCK_INSET + spread01 * (1 - PLUCK_INSET * 2);
    };

    const onMessage = (message: ChatMessage): void => {
      if (strings.length === 0) return;
      const isEvent = message.event !== "chat";
      const fallbackTint = isEvent ? eventColor : voiceColor;
      const tint = tintFromChat ? colorFromHex(message.color, fallbackTint) : fallbackTint;
      const height = pluckStrength * (isEvent ? eventBoost : 1);

      if (isEvent) {
        // A sub, cheer or raid strums the whole harp. Each string is plucked at its own point so
        // the chord arrives as a spray of travelling waves rather than as one synchronised bar.
        for (let i = 0; i < strings.length; i += 1) {
          const state = strings[i];
          if (state === undefined) continue;
          pluck(state, positionFor(message.seed + i * 7919, i % 12), height, tint);
        }
        return;
      }

      // An ordinary message rings one string, chosen from the sender's seed, so a regular always
      // plays the same note and the harp becomes recognisable over a broadcast.
      const state = strings[message.seed % strings.length];
      if (state === undefined) return;
      pluck(state, positionFor(message.seed, 8), height, tint);
    };

    /*
     * Live messages only. The backlog from `chat.recent()` is deliberately not plucked: firing
     * fifty historical messages the instant a scene loads would open the effect with a burst that
     * says nothing about what is happening now.
     */
    scope.defer(chat.onMessage(onMessage));

    /** Strokes the polyline currently sitting in the scratch arrays. */
    const strokePath = (
      g: PIXI.Graphics,
      count: number,
      color: number,
      width: number,
      alpha: number,
    ): void => {
      if (count < 2 || alpha <= 0.004 || width <= 0) return;
      g.moveTo(at(pathX, 0), at(pathY, 0));
      for (let i = 1; i < count; i += 1) g.lineTo(at(pathX, i), at(pathY, i));
      g.stroke({ color, width, alpha });
    };

    onFrame(scope, ctx.fpsCap, ({ dt, now }) => {
      // `sample` refreshes the shared analysis at most once per tick however many effects ask for
      // it, which is why it takes the frame's `now` instead of reading the clock itself.
      bus.sample(now);
      envelopes.update(dt);

      if (beatSustain && envelopes.beat) sustainLeft = BEAT_SUSTAIN_S;
      sustainLeft = Math.max(0, sustainLeft - dt);
      const damperOpen = sustainLeft > 0;
      const ringSeconds = ringOut * (damperOpen ? 1 / SUSTAIN_DAMP_SCALE : 1);
      const damping = DAMP_SHAPE / ringSeconds;

      /*
       * The simulation runs on its own clock. Whole fixed steps are spent from the accumulator, and
       * anything left over after the cap is discarded rather than repaid — see MAX_SUBSTEPS.
       *
       * The debt is capped *before* the loop rather than trimmed after it, which is what makes
       * "discarded rather than repaid" literally true: whatever the frame loop hands over, at most
       * MAX_SUBSTEPS steps of time is ever owed, so a long frame cannot leave a surplus that the
       * next frame has to work off on top of its own.
       */
      accumulator = Math.min(accumulator + dt, FIXED_STEP * MAX_SUBSTEPS);
      while (accumulator >= FIXED_STEP) {
        stepPhysics(FIXED_STEP, damping);
        accumulator -= FIXED_STEP;
      }

      // The brightness envelope is separate from the physics: it is what fades a string's colour
      // back to ivory, and it is decayed per second so a capped route fades at the same rate.
      const ringKeep = Math.exp((-dt * RING_SHAPE) / ringSeconds);
      for (const state of strings) state.ring *= ringKeep;

      /*
       * Geometry, recomputed every frame from the live canvas size. Nothing here is cached, so the
       * effect needs no resize hook: a stage resize simply produces different numbers next frame.
       */
      const width = Math.max(1, stage.width);
      const height = Math.max(1, stage.height);
      const alongLength = horizontal ? width : height;
      const crossLength = horizontal ? height : width;
      // Never let the two bridges meet, however large the inset is on a small source.
      const inset = Math.min(margin, alongLength * 0.45);
      const span = Math.max(1, alongLength - inset * 2);
      const band = crossLength * spread;
      const gap = strings.length > 1 ? band / (strings.length - 1) : crossLength * 0.1;
      const firstCross = crossLength / 2 - band / 2;

      // The bridge blocks are sized from the two things the operator already controls — the gap
      // between strings and the line width — so they always look proportionate to the harp.
      const bridgeThick = Math.max(3, Math.min(18, gap * 0.42));
      const bridgeLong = Math.max(3, lineWidth * 5);

      /*
       * The swing ceiling — see MAX_SWING_STACK and `limitSwing`. It is the smaller of two limits:
       * a few times the tallest pluck the current settings can throw (so the harp keeps its own
       * sense of scale), and half the short side of the frame (so no combination of a 60-pixel
       * pluck and a 6× event boost can drive a string clean out of a small browser source).
       */
      const swingCeiling = Math.min(
        pluckStrength * eventBoost * MAX_SWING_STACK,
        crossLength * 0.5,
      );

      /*
       * Sympathetic drive, in pixels. `slow` follows the body of the voice and `fast` its edge.
       * Both are tied to the gap between strings so the hum scales with the harp, and both are
       * capped against the pluck height as well: the shimmer has to stay clearly smaller than a
       * pluck, or the whole thing stops reading as a plucked instrument and starts reading as a
       * bank of audio waveforms, which is the one thing this effect is not.
       */
      const humRoom = Math.min(gap * 0.07, pluckStrength * 0.5);
      const humAmplitude = resonance * humRoom * envelopes.slow;
      const grainAmplitude = resonance * humRoom * 0.3 * envelopes.fast;
      const speed = safeSpeed();

      // Silence — Resonance at 0, or nobody talking — skips the two sines per drawn point entirely.
      const humAudible = humAmplitude > HUM_SILENCE_PX || grainAmplitude > HUM_SILENCE_PX;

      // See `humClock`: the phase integrates the speed instead of being recomputed from `elapsed`,
      // and wraps at 2 because every term below has an integer number of half-cycles per unit.
      humClock += dt * speed;
      if (humClock >= 2) humClock %= 2;

      core.clear();
      bloom.clear();

      for (let s = 0; s < strings.length; s += 1) {
        const state = strings[s];
        if (state === undefined) continue;
        const nodes = state.u.length;
        if (nodes < 2) continue;

        // Done here, in the pass that is already walking this string's samples, rather than as a
        // separate loop over every string.
        limitSwing(state, swingCeiling);

        const baseCross = strings.length > 1 ? firstCross + s * gap : crossLength / 2;
        const harmonic = s + 1;
        /*
         * A string of unit length carrying waves at `speed` has a fundamental of `speed / 2` cycles
         * per second, and its nth harmonic is n times that. Multiplying by 2π turns cycles per
         * second into radians per second, which is what `sin` wants — so each string hums at its
         * own true pitch and the bank reads as a chord rather than as a single tone.
         */
        const humPhase = Math.sin(Math.PI * harmonic * humClock);
        const grainPhase = Math.sin(Math.PI * harmonic * 3 * humClock + harmonic);
        const humNow = humAmplitude * humPhase;
        const grainNow = grainAmplitude * grainPhase;

        let count = 0;
        for (let n = 0; n < nodes; n += SAMPLE_STRIDE) {
          const index = Math.min(n, nodes - 1);
          const t = index / (nodes - 1);
          const hum = humAudible
            ? Math.sin(Math.PI * harmonic * t) * humNow +
              Math.sin(Math.PI * harmonic * 3 * t) * grainNow
            : 0;
          const along = inset + t * span;
          const cross = baseCross + at(state.u, index) + hum;
          pathX[count] = horizontal ? along : cross;
          pathY[count] = horizontal ? cross : along;
          count += 1;
        }
        // Always finish exactly on the far bridge, whatever the stride left over.
        if ((nodes - 1) % SAMPLE_STRIDE !== 0) {
          const cross = baseCross + at(state.u, nodes - 1);
          pathX[count] = horizontal ? inset + span : cross;
          pathY[count] = horizontal ? cross : inset + span;
          count += 1;
        }

        const lit = Math.min(1, state.ring);
        const color = mixColor(restColor, state.tint, lit);
        const alpha = Math.min(1, idleOpacity + (1 - idleOpacity) * lit);

        strokePath(bloom, count, color, lineWidth * 3, glow * (0.15 + 0.85 * lit));
        strokePath(core, count, color, lineWidth, alpha);

        // The bridges. Two small blocks per string, drawn a little more solidly than the string
        // itself so the harp reads as terminated rather than as lines running off the edge.
        const blockAlpha = Math.min(1, idleOpacity * 2.2 + lit * 0.4);
        const blockW = horizontal ? bridgeLong : bridgeThick;
        const blockH = horizontal ? bridgeThick : bridgeLong;
        for (let e = 0; e < 2; e += 1) {
          const end = e === 0 ? inset : inset + span;
          const cx = horizontal ? end : baseCross;
          const cy = horizontal ? baseCross : end;
          core
            .rect(cx - blockW / 2, cy - blockH / 2, blockW, blockH)
            .fill({ color: restColor, alpha: blockAlpha });
        }
      }

      // Pixi's own ticker is switched off by `createPixiStage` so the project has exactly one
      // animation loop. Nothing reaches the canvas until this line.
      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        tension = num(p, "tension", 1, 0.15, 2.5);
        ringOut = num(p, "damping", 2.4, 0.3, 8);
        pluckStrength = num(p, "pluckStrength", 14, 2, 60);
        eventBoost = num(p, "eventBoost", 2.5, 1, 6);
        resonance = num(p, "resonance", 1, 0, 3);
        beatSustain = bool(p, "beatSustain", true);
        lineWidth = num(p, "lineWidth", 1.1, 0.5, 6);
        glow = num(p, "glow", 0.12, 0, 1);
        idleOpacity = num(p, "idleOpacity", 0.1, 0.01, 1);
        tintFromChat = bool(p, "tintFromChat", true);
        restColor = colorInt(p, "stringColor", "#efe6d5");
        horizontal = str(p, "orientation", "horizontal") !== "vertical";
        margin = num(p, "margin", 48, 0, 400);
        spread = num(p, "spread", 0.62, 0.1, 1);

        ramp = palette(p, "palette", "ember");
        voiceColor = paletteAtInt(ramp, 0.62);
        eventColor = paletteAtInt(ramp, 1);

        // The two structural values are changed in place rather than by rebuilding the scene: the
        // renderer, the canvas and the WebGL context all stay exactly as they are, and whatever is
        // ringing at the moment keeps ringing.
        const nextNodes = int(p, "nodeCount", 192, 64, 384);
        if (nextNodes !== nodeCount) {
          for (const state of strings) {
            state.u = resample(state.u, nextNodes);
            state.v = resample(state.v, nextNodes);
          }
          nodeCount = nextNodes;
          maxSamples = Math.ceil(nodeCount / SAMPLE_STRIDE) + 2;
          pathX = new Float32Array(maxSamples);
          pathY = new Float32Array(maxSamples);
        }

        const nextCount = int(p, "stringCount", 9, 3, 16);
        if (nextCount !== stringCount) {
          while (strings.length > nextCount) strings.pop();
          while (strings.length < nextCount) strings.push(makeString(nodeCount));
          stringCount = nextCount;
        }
      },
    };
  },
});

export default sympatheticStrings;
