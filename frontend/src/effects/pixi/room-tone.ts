import * as PIXI from "pixi.js";

import { at, bool, colorHex, colorInt, int, num, rgb01, str } from "../paramUtils";
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
  useFont,
} from "../sdk";

/**
 * Room Tone
 * =========
 *
 * A small instrument in the corner of the frame: a hairline curve showing the last couple of
 * minutes of "how awake the room is", scrolling continuously to the left, with a soft gradient
 * underneath it and one lit point at the leading edge.
 *
 * It is the only effect in this library that *charts* anything. Everything else draws the present
 * moment; this draws a short history, so a streamer who has been concentrating on a game can
 * glance at it and see whether chat woke up while they were not looking.
 *
 * What the line actually plots
 * ----------------------------
 * Two live signals are folded into one number between 0 and 1:
 *
 *  - **loudness** — the smoothed, perceptual audio envelope the SDK derives from OBS's own output
 *    levels (see `sdk/envelopes.ts`; `mid` is the general-purpose one);
 *  - **chat activity** — not "how many messages are on screen" but a *rate*. Every arriving message
 *    adds one to a small accumulator that continuously decays, so a burst of five messages lifts it
 *    sharply and it sinks back over the following seconds. Dividing by the Chat Full Scale
 *    parameter turns that into a 0..1 reading.
 *
 * Chat Weight blends them: 0 plots pure loudness, 1 plots pure chat rate, and the default sits in
 * between. When Audio Series is on, a second, much fainter line plots the loudness on its own, so a
 * spike you can see but not hear (chat reacting to something) looks different from a spike you can
 * hear but chat ignored.
 *
 * Why the plotted value is a *sampled signal*, not a per-bucket average
 * --------------------------------------------------------------------
 * The obvious way to build a chart like this is to total up each second of history into a bucket
 * and plot the totals. That has one fatal property for this design: the newest bucket is still
 * filling, so its value jumps every time a bucket closes and a fresh, empty one opens. The chart
 * then twitches once a second, which is exactly the look this effect exists to avoid.
 *
 * So the history stores a *snapshot* of the continuous signal taken at the moment each bucket
 * closes, and the newest point on the chart is the live signal itself. At the instant of a
 * changeover the value being written into history and the new live value are the same number, so
 * the curve passes through the join without a step.
 *
 * The sub-pixel scroll, which is the whole design
 * -----------------------------------------------
 * Each sample sits one "bucket width" further left than the one after it, and the entire path is
 * additionally offset left by *how far through the current bucket we are* — a fraction between 0
 * and 1 recomputed every frame. So the picture slides smoothly rather than stepping sideways once
 * per bucket.
 *
 * Two consequences follow, and both are load-bearing:
 *
 *  - the oldest sample is dragged up to one bucket width past the left edge of the panel, so the
 *    chart is drawn one bucket wider than the panel and a rectangular mask clips the overhang. With
 *    no mask the oldest point would visibly poke out and snap back;
 *  - the leading point is pinned at the right-hand end at the start of a bucket and drifts left as
 *    the bucket fills, arriving exactly where the *next* sample begins. That is what makes the
 *    changeover invisible.
 *
 * Why the curve is a spline and not a polyline
 * --------------------------------------------
 * Joining the samples with straight lines produces visible corners at every sample, and those
 * corners are most of what makes a hand-rolled chart look cheap. Instead each pair of neighbouring
 * samples becomes one cubic Bézier curve whose two control points are derived from the *four*
 * samples around it — the Catmull-Rom construction, which is the standard way to run a smooth curve
 * exactly through a set of points. The Smoothing parameter scales those control points: at 1 it is
 * the textbook spline, and at 0 the control points collapse onto the endpoints and the result is
 * once again a plain polyline, which is there for anyone who prefers the sharper look.
 *
 * Everything is drawn into a single `Graphics` that is cleared and rebuilt each frame — grid,
 * baseline, area fill, both curves, the leading dot. Nothing is allocated per frame: the history
 * lives in fixed-length `Float32Array` ring buffers that are only replaced when the operator
 * changes how many samples are kept.
 */

/** Slack kept at the right-hand end of the panel so the expanding leading ring is not clipped. */
const LEAD_PAD = 12;

/**
 * The largest the leading ring can ever get, in pixels: the maximum Lead Dot Size (8), plus the
 * one-pixel gap the ring is drawn outside the dot, plus the maximum Lead Ring Gain (20).
 *
 * The mask is grown by this much on the top, the bottom and the right, so the ring is never sliced
 * off when an operator winds those two parameters up. It is deliberately *not* grown on the left:
 * that hard edge is the entire reason the mask exists, because the oldest sample is dragged up to
 * one bucket width past it by the sub-pixel scroll. Keep this in step with the two parameters'
 * `max` values below if either ever changes.
 */
const MAX_LEAD_RADIUS = 8 + 1 + 20;

/** Smallest panel the layout will produce, so a tiny browser source still draws something. */
const MIN_PANEL_WIDTH = 64;
const MIN_PANEL_HEIGHT = 40;

/*
 * The panel's visual register, in one place.
 *
 * These are the opacities that make the thing read as a quiet instrument rather than as an
 * overlay competing for attention: the primary curve is the only nearly-solid mark, the audio
 * series is a whisper under it, and the grid is barely there — present enough to give the scroll a
 * visible cadence, faint enough that it never reads as a box. They are deliberately *not*
 * parameters: the master Opacity slider scales the whole panel and preserves the relationships,
 * which is what an operator actually wants. Individually tunable alphas would mostly be a way to
 * break the design.
 */
const CURVE_ALPHA = 0.8;
const AUDIO_CURVE_ALPHA = 0.28;
const BASELINE_ALPHA = 0.14;
const GRID_ALPHA = 0.06;
const LABEL_ALPHA = 0.45;
const LEAD_RING_ALPHA = 0.42;

/** How often the two text objects may be re-rendered, in seconds. See the note where it is used. */
const READOUT_INTERVAL = 0.25;

/** Letter spacing of the caption and readout, as a fraction of the font size. */
const TRACKING_EM = 0.18;

/** Clamps a value into 0..1, turning a `NaN` into 0 rather than letting it poison a coordinate. */
function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/**
 * Reads the caption exactly as it is stored, an empty string included.
 *
 * `str()` from `paramUtils` treats `""` as "not set" and hands back the fallback instead, which is
 * the right call for something like a font family — an empty family list would render nothing at
 * all. It is the wrong call here: the Caption parameter documents an empty box as the way to hide
 * the caption, and going through `str()` would quietly put "ROOM TONE" back every time, so the
 * only way to get rid of the label would be to type a space.
 */
function readLabel(params: Record<string, unknown>): string {
  const value = params["label"];
  return typeof value === "string" ? value : "ROOM TONE";
}

const roomTone = defineEffect({
  descriptor: {
    id: "room-tone",
    name: "Room Tone",
    description:
      "A hairline chart of the last two minutes of the room — chat rate and loudness folded into one signal — scrolling continuously in a corner of the frame, with a soft gradient beneath it and a lit point at the leading edge.",
    engine: "pixi",
    category: "overlay",
    tags: ["chat", "audio", "reactive", "overlay", "chart", "hud", "minimal", "pixi"],
    previewNotes:
      "Fully transparent apart from the small panel, so it can sit on top of every scene at once. Chat and audio both fall back to the SDK's simulated feeds when Twitch or OBS is not connected — the simulated chat is very sparse, so during setup the loudness half of the signal is what you will see moving.",
    params: [
      {
        key: "label",
        label: "Caption",
        kind: "text",
        default: "ROOM TONE",
        description: "The small tracked caption above the chart. Leave it empty to hide it.",
      },
      {
        key: "readout",
        label: "Readout",
        kind: "select",
        default: "index",
        options: ["none", "index", "messages"],
        description:
          "The number at the top right. 'index' is the current combined signal as 0-100; 'messages' is the chat rate in messages per minute measured over the whole window.",
      },
      {
        key: "slots",
        label: "Samples",
        kind: "number",
        default: 96,
        min: 12,
        max: 240,
        step: 1,
        description:
          "How many samples of history are plotted. Samples multiplied by Sample Length is the length of the window — 96 at 1250 ms is two minutes.",
      },
      {
        key: "bucketMs",
        label: "Sample Length",
        kind: "number",
        default: 1250,
        min: 200,
        max: 5000,
        step: 50,
        description:
          "How much time one sample covers, in milliseconds. Longer samples mean a longer window at the same level of detail, and a slower scroll.",
      },
      {
        key: "chatWeight",
        label: "Chat Weight",
        kind: "number",
        default: 0.45,
        min: 0,
        max: 1,
        step: 0.01,
        description:
          "The blend between chat rate and loudness in the plotted signal. 0 is pure audio, 1 is pure chat.",
      },
      {
        key: "msgsFullScale",
        label: "Chat Full Scale",
        kind: "number",
        default: 5,
        min: 1,
        max: 60,
        step: 1,
        description:
          "Roughly how many messages arriving inside one sample counts as a full-height reading. Lower it for a quiet channel, raise it for a busy one.",
      },
      {
        key: "showAudioSeries",
        label: "Audio Series",
        kind: "boolean",
        default: true,
        description:
          "Plot a second, much fainter curve showing loudness on its own, so you can tell a chat spike from a sound spike.",
      },
      {
        key: "smoothing",
        label: "Smoothing",
        kind: "number",
        default: 1,
        min: 0,
        max: 1,
        step: 0.05,
        description:
          "How strongly the curve is rounded through the samples. 1 is a full spline; 0 draws straight lines from point to point.",
      },
      {
        key: "showFill",
        label: "Area Fill",
        kind: "boolean",
        default: true,
        description: "Draw the soft gradient between the primary curve and the baseline.",
      },
      {
        key: "fillAlpha",
        label: "Fill Opacity",
        kind: "number",
        default: 0.1,
        min: 0,
        max: 0.6,
        step: 0.01,
        description:
          "How solid the area fill is where it meets the curve. It always fades to nothing at the baseline.",
      },
      {
        key: "showGrid",
        label: "Grid",
        kind: "boolean",
        default: true,
        description:
          "Draw the baseline and the faint vertical time markers. The markers scroll with the chart, which is what gives the motion a readable cadence.",
      },
      {
        key: "gridEverySeconds",
        label: "Grid Spacing",
        kind: "number",
        default: 30,
        min: 2,
        max: 120,
        step: 1,
        description: "Seconds between the vertical time markers.",
      },
      {
        key: "curveWidth",
        label: "Curve Width",
        kind: "number",
        default: 1,
        min: 0.5,
        max: 6,
        step: 0.5,
        description: "Stroke width of the primary curve, in pixels.",
      },
      {
        key: "leadDotSize",
        label: "Lead Dot Size",
        kind: "number",
        default: 3,
        min: 0,
        max: 8,
        step: 0.5,
        description:
          "Radius of the filled dot at the newest sample, in pixels. 0 hides the dot and its ring.",
      },
      {
        key: "leadRingGain",
        label: "Lead Ring Gain",
        kind: "number",
        default: 5,
        min: 0,
        max: 20,
        step: 0.5,
        description:
          "How far the ring around the leading dot expands on a sharp sound, in pixels. 0 keeps the ring a fixed size.",
      },
      {
        key: "fontSize",
        label: "Text Size",
        kind: "number",
        default: 10,
        min: 6,
        max: 24,
        step: 1,
        description:
          "Size of the caption and the readout, in pixels. The chart area shrinks to make room for them.",
      },
      {
        key: "fontFamily",
        label: "Font",
        kind: "text",
        default: "'Helvetica Neue', Helvetica, Arial, sans-serif",
        description:
          "A CSS font family list for the caption and readout. The default uses fonts every machine already has, so nothing is downloaded.",
      },
      paletteParam(
        "palette",
        "Palette",
        "monochrome",
        "Colour ramp for the two curves. The top of the ramp draws the primary curve, a little below it draws the audio series.",
      ),
      {
        key: "accentColor",
        label: "Accent Colour",
        kind: "color",
        default: "#ffc46b",
        description: "The colour of the area fill and of the ring around the leading dot.",
      },
      {
        key: "panelWidth",
        label: "Panel Width",
        kind: "number",
        default: 420,
        min: 80,
        max: 1600,
        step: 10,
        description:
          "Width of the panel in pixels. It is reduced automatically if the browser source is too narrow to hold it beside the margins.",
      },
      {
        key: "panelHeight",
        label: "Panel Height",
        kind: "number",
        default: 92,
        min: 40,
        max: 600,
        step: 4,
        description: "Height of the panel in pixels, caption included.",
      },
      {
        key: "anchor",
        label: "Corner",
        kind: "select",
        default: "bottom-left",
        options: ["bottom-left", "bottom-right", "top-left", "top-right"],
        description: "Which corner of the browser source the panel sits in.",
      },
      {
        key: "marginX",
        label: "Margin X",
        kind: "number",
        default: 64,
        min: 0,
        max: 600,
        step: 2,
        description: "Distance from the left or right edge, in pixels.",
      },
      {
        key: "marginY",
        label: "Margin Y",
        kind: "number",
        default: 64,
        min: 0,
        max: 600,
        step: 2,
        description: "Distance from the top or bottom edge, in pixels.",
      },
      {
        key: "opacity",
        label: "Opacity",
        kind: "number",
        default: 1,
        min: 0,
        max: 1,
        step: 0.02,
        description: "Master opacity for the whole panel.",
      },
      {
        key: "introMs",
        label: "Intro Length",
        kind: "number",
        default: 700,
        min: 0,
        max: 4000,
        step: 50,
        description:
          "How long the chart takes to wipe itself in from the left when the effect mounts, in milliseconds. 0 shows it immediately.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    /*
     * Three awaits before anything is built, and each one is a point at which the renderer may
     * already have disposed this effect.
     *
     * `useAudio`, `useChat` and `useFont` all resolve normally on a dead scope — they have no way to
     * refuse — so the `scope.checkpoint()` after each of them is written by hand and is not
     * decoration: without it a disposed effect would carry on and build a whole Pixi application,
     * and therefore a whole WebGL context, only to destroy it a moment later. `createPixiStage`
     * checkpoints internally, which is why the last one needs nothing after it.
     *
     * The feeds are acquired before the stage on purpose: a scope that dies during the wait then
     * tears down with no renderer ever having existed.
     */
    const bus = await useAudio(scope);
    scope.checkpoint();
    const chat = await useChat(scope);
    scope.checkpoint();

    const envelopes = createEnvelopes(bus);

    /* ── Parameters ───────────────────────────────────────────────────────────────────────── */

    let labelText = readLabel(ctx.params);
    let readoutMode = str(ctx.params, "readout", "index");
    let slots = int(ctx.params, "slots", 96, 12, 240);
    let bucketMs = num(ctx.params, "bucketMs", 1250, 200, 5000);
    let chatWeight = num(ctx.params, "chatWeight", 0.45, 0, 1);
    let msgsFullScale = num(ctx.params, "msgsFullScale", 5, 1, 60);
    let showAudioSeries = bool(ctx.params, "showAudioSeries", true);
    let smoothing = num(ctx.params, "smoothing", 1, 0, 1);
    let showFill = bool(ctx.params, "showFill", true);
    let fillAlpha = num(ctx.params, "fillAlpha", 0.1, 0, 0.6);
    let showGrid = bool(ctx.params, "showGrid", true);
    let gridEverySeconds = num(ctx.params, "gridEverySeconds", 30, 2, 120);
    let curveWidth = num(ctx.params, "curveWidth", 1, 0.5, 6);
    let leadDotSize = num(ctx.params, "leadDotSize", 3, 0, 8);
    let leadRingGain = num(ctx.params, "leadRingGain", 5, 0, 20);
    let fontSize = int(ctx.params, "fontSize", 10, 6, 24);
    let fontFamily = str(
      ctx.params,
      "fontFamily",
      "'Helvetica Neue', Helvetica, Arial, sans-serif",
    );
    let curveColor = paletteAtInt(palette(ctx.params, "palette", "monochrome"), 1);
    let audioColor = paletteAtInt(palette(ctx.params, "palette", "monochrome"), 0.72);
    let accentHex = colorHex(ctx.params, "accentColor", "#ffc46b");
    let accentColor = colorInt(ctx.params, "accentColor", "#ffc46b");
    let panelWidthParam = num(ctx.params, "panelWidth", 420, 80, 1600);
    let panelHeightParam = num(ctx.params, "panelHeight", 92, 40, 600);
    let anchor = str(ctx.params, "anchor", "bottom-left");
    let marginX = num(ctx.params, "marginX", 64, 0, 600);
    let marginY = num(ctx.params, "marginY", 64, 0, 600);
    let opacity = num(ctx.params, "opacity", 1, 0, 1);
    let introMs = num(ctx.params, "introMs", 700, 0, 4000);

    // The caption and readout may be set to a downloadable family, and a font that is still loading
    // is silently substituted — so the readout would be laid out at the wrong width and then jump
    // when the real face arrived. Waiting here costs at most two seconds and never fails.
    await useFont(`${fontSize}px ${fontFamily}`);
    scope.checkpoint();

    const stage = await createPixiStage(scope, ctx, { antialias: true });

    /* ── History ──────────────────────────────────────────────────────────────────────────── */

    /*
     * The history, as three fixed-length ring buffers.
     *
     * A ring buffer is an array plus a moving "newest" index: instead of shifting every element
     * along when a sample is added — which would be a copy of the whole array every bucket — the
     * index moves forward one place and overwrites the oldest entry. `head` is the position of the
     * most recently *closed* sample, so a point `age` samples behind the leading edge lives at
     * `ringIndex(age)`.
     *
     * Nothing here is allocated per frame. These arrays are only ever replaced when the operator
     * changes the Samples parameter, and even then the old contents are copied across.
     */
    let histCombined = new Float32Array(slots);
    let histAudio = new Float32Array(slots);
    let histMsgs = new Float32Array(slots);
    let head = 0;

    /** Where the sample `age` places behind the leading edge lives. `age` is 1 or more. */
    const ringIndex = (age: number): number => {
      const index = (head - (age - 1)) % slots;
      return index < 0 ? index + slots : index;
    };

    /** Milliseconds accumulated inside the sample currently being filled. */
    let bucketElapsed = 0;
    /** Messages counted inside that same sample. Rolled into `histMsgs` when it closes. */
    let bucketMsgs = 0;

    /**
     * The decaying chat-activity accumulator described in the header.
     *
     * Each message adds one; every frame it is multiplied down so that it halves over the length of
     * one sample. The result is a continuous number rather than a count, which is what lets the
     * chart move smoothly between messages instead of stepping on each arrival.
     */
    let chatEnergy = 0;

    /** The two live signals, in 0..1. These are the values plotted at the leading edge. */
    let liveCombined = 0;
    let liveAudio = 0;

    /** Seconds since the effect mounted, used for the intro wipe and the grid's scroll phase. */
    let elapsedSeconds = 0;

    /**
     * How much history the seeding below actually recovers, in seconds.
     *
     * The messages-per-minute readout divides a message total by the time that total was observed
     * over. Without this the seeded messages would be counted in the total but the time they
     * arrived over would not be counted in the divisor, so a channel that had said fifty things in
     * the last two minutes would read as fifty messages in the five seconds since the effect
     * mounted — about six hundred messages a minute, which is nonsense, and it is at its worst in
     * exactly the first moments an operator looks at the panel.
     */
    let seededMs = 0;

    /*
     * Seed the history from the messages the chat bus already holds.
     *
     * Without this the panel would be flat for its first two minutes after every scene switch,
     * which is precisely when an operator is most likely to look at it. `chat.recent()` returns up
     * to fifty messages with wall-clock timestamps, so each one can be dropped into the sample its
     * age falls in.
     *
     * The reconstructed curve is the chat half only — there is no record of what the audio was
     * doing before the effect existed, and inventing one would be a lie. It is marked as such by
     * being scaled by Chat Weight, exactly as a live reading with no sound would be.
     */
    const seedNow = Date.now();
    for (const message of chat.recent()) {
      const ageMs = seedNow - message.at;
      if (!Number.isFinite(ageMs)) continue;
      const age = Math.floor(ageMs / bucketMs);
      if (age <= 0) {
        bucketMsgs += 1;
      } else if (age < slots) {
        const index = ringIndex(age);
        histMsgs[index] = at(histMsgs, index) + 1;
        // Only a message that really landed in the history extends the observed window; one older
        // than the window was dropped above and must not stretch the divisor it is not counted in.
        seededMs = Math.max(seededMs, ageMs);
      }
    }
    const seededSeconds = seededMs / 1000;
    for (let age = 1; age < slots; age += 1) {
      const index = ringIndex(age);
      histCombined[index] = clamp01(chatWeight * clamp01(at(histMsgs, index) / msgsFullScale));
    }

    // Counting arrivals is the entire chat listener: this effect never displays a message, it only
    // measures how often they come. The unsubscribe function is handed straight to the scope, so
    // the subscription cannot outlive the effect.
    scope.defer(
      chat.onMessage(() => {
        bucketMsgs += 1;
        chatEnergy += 1;
      }),
    );

    /* ── Display objects ──────────────────────────────────────────────────────────────────── */

    /*
     * Everything lives inside one container positioned at the panel's top-left corner, so the whole
     * chart is drawn in comfortable local coordinates (0,0 to panelW,panelH) and moving the panel to
     * another corner is a single position change rather than an offset threaded through every
     * drawing call. The master Opacity parameter is the container's alpha — one GPU-side value
     * rather than an alpha multiplied into every fill.
     */
    const panel = stage.stage.addChild(new PIXI.Container());
    const chart = panel.addChild(new PIXI.Graphics());
    const chartMask = panel.addChild(new PIXI.Graphics());
    chart.mask = chartMask;

    const textStyle = (): PIXI.TextStyle =>
      new PIXI.TextStyle({
        fontFamily,
        fontSize,
        fontWeight: "700",
        fill: 0xffffff,
        letterSpacing: fontSize * TRACKING_EM,
      });

    /*
     * `PIXI.Text` owns a texture of its rendered glyphs, so it has to be destroyed rather than left
     * to the garbage collector. `destroy(true)` takes the texture with it; without the argument the
     * texture outlives the object, which is a leak that only becomes visible after a few hundred
     * remounts of a long broadcast.
     */
    const caption = scope.own(new PIXI.Text({ text: labelText, style: textStyle() }), (t) =>
      t.destroy(true),
    );
    const readout = scope.own(new PIXI.Text({ text: "", style: textStyle() }), (t) =>
      t.destroy(true),
    );
    panel.addChild(caption);
    panel.addChild(readout);

    /* ── Layout ───────────────────────────────────────────────────────────────────────────── */

    let panelW = MIN_PANEL_WIDTH;
    let panelH = MIN_PANEL_HEIGHT;
    let plotRight = MIN_PANEL_WIDTH;
    let plotWidth = 1;
    let plotTop = 0;
    let baseline = MIN_PANEL_HEIGHT;
    let plotHeight = 1;

    /**
     * The vertical gradient used for the area fill: the accent colour at the top of the plot,
     * fading to fully transparent at the baseline.
     *
     * A gradient is baked into a texture, so this is built in `layout` below and rebuilt only when
     * the panel geometry or the accent colour changes — never per frame. The colour has to be baked
     * in rather than applied as a tint at fill time, because Pixi overwrites a fill style's `color`
     * with white whenever the fill is a gradient (see `convertFillInputToFillStyle`); only the
     * style's `alpha` survives, which is what the Fill Opacity parameter uses.
     */
    let areaGradient: PIXI.FillGradient | null = null;

    /**
     * Recomputes every pixel measurement that depends on the canvas size or on a layout parameter,
     * and rebuilds the mask and the gradient. Called on mount, on resize, and from `setParams` when
     * a layout value actually moved — never per frame.
     */
    const layout = (): void => {
      // Never let the panel grow wider than the space between its margins, so a small browser
      // source still shows a whole chart instead of one running off the edge. A canvas narrower
      // than the minimum simply gets the minimum and overflows, which is more useful than nothing.
      panelW = Math.max(MIN_PANEL_WIDTH, Math.min(panelWidthParam, stage.width - marginX * 2));
      panelH = Math.max(MIN_PANEL_HEIGHT, Math.min(panelHeightParam, stage.height - marginY * 2));

      const left = anchor === "bottom-left" || anchor === "top-left";
      const top = anchor === "top-left" || anchor === "top-right";
      const originX = left ? marginX : stage.width - marginX - panelW;
      const originY = top ? marginY : stage.height - marginY - panelH;

      // Rounded to whole pixels because every mark in this panel is a hairline: half a pixel of
      // offset turns a crisp 1px line into two grey ones.
      panel.position.set(Math.round(Math.max(0, originX)), Math.round(Math.max(0, originY)));

      // The caption band is reserved whether or not there is text in it, so switching the readout
      // off does not reflow the chart under a viewer's eyes.
      plotTop = fontSize + 8;
      baseline = panelH;
      plotHeight = Math.max(1, baseline - plotTop);
      plotRight = Math.max(1, panelW - LEAD_PAD);
      plotWidth = plotRight;

      caption.position.set(0, 0);
      readout.y = 0;

      /*
       * The mask. It is drawn once at full size and the intro wipe only animates its horizontal
       * scale, which is a transform change and costs nothing — redrawing a rectangle sixty times a
       * second to animate its width would be pure waste.
       *
       * It extends past the panel on the top, the bottom and the right by the widest the leading
       * ring can ever get, so that ring is never sliced off, and stops dead on x = 0, which is what
       * hides the oldest sample's overhang past the left edge. Only the left edge has to cut.
       */
      chartMask.clear();
      chartMask
        .rect(0, -MAX_LEAD_RADIUS, panelW + MAX_LEAD_RADIUS, panelH + MAX_LEAD_RADIUS * 2)
        .fill({ color: 0xffffff });

      /*
       * The outgoing gradient is destroyed here because a superseded one would otherwise keep its
       * texture until the effect unmounted. The *current* one is freed by the `scope.defer` below.
       *
       * Clearing the chart immediately afterwards matters: until it is cleared its geometry still
       * points at the gradient that was just destroyed, and the next frame would draw with it.
       */
      areaGradient?.destroy();
      chart.clear();
      const [red, green, blue] = rgb01(accentHex);
      areaGradient = new PIXI.FillGradient({
        type: "linear",
        start: { x: 0, y: plotTop },
        end: { x: 0, y: baseline },
        colorStops: [
          { offset: 0, color: [red, green, blue, 1] },
          { offset: 1, color: [red, green, blue, 0] },
        ],
        textureSpace: "global",
      });
    };

    layout();
    stage.onResize(layout);

    /*
     * Free the gradient that is live at teardown.
     *
     * It is tempting to assume `app.destroy(true, { texture: true, textureSource: true })` covers
     * this, the way it covers a sprite's texture — it does not. Pixi frees only the texture of a
     * `GraphicsContext`'s *current* fill and stroke style (see `GraphicsContext.destroy`), not of
     * every style referenced by the instructions it recorded, and the last fill of a normal frame
     * here is the leading dot's flat colour. So the gradient's canvas-backed texture would survive
     * every unmount: one leaked texture per scene switch, for the length of a broadcast.
     *
     * Registered *after* `createPixiStage`, so LIFO teardown runs it *before* the application is
     * destroyed. In the one configuration where Pixi would also free it — Lead Dot Size at 0, which
     * leaves the area fill as the context's current style — the second destroy is a no-op rather
     * than an error, because `Texture.destroy` drops its source reference on the first call.
     */
    scope.defer(() => {
      areaGradient?.destroy();
      areaGradient = null;
    });

    /* ── Drawing ──────────────────────────────────────────────────────────────────────────── */

    /** How far through the current sample we are, 0..1. Recomputed every frame; see the header. */
    let fraction = 0;

    /** Horizontal position of the sample `age` places behind the leading edge, including the
     * sub-sample offset that makes the whole chart glide. */
    const sampleX = (age: number, bucketWidth: number): number =>
      plotRight - (age + fraction) * bucketWidth;

    /** Vertical position of a 0..1 reading: 0 sits on the baseline, 1 at the top of the plot. */
    const sampleY = (value: number): number => baseline - clamp01(value) * plotHeight;

    const readCombined = (age: number): number =>
      age === 0 ? liveCombined : at(histCombined, ringIndex(age));
    const readAudio = (age: number): number =>
      age === 0 ? liveAudio : at(histAudio, ringIndex(age));

    /**
     * Emits one series as a chain of cubic Bézier curves through every sample.
     *
     * `k` counts left to right across the chart, so the sample it refers to is `last - k` places
     * behind the leading edge. Indices outside the range are clamped to the ends, which duplicates
     * the first and last samples — the usual way to give the two end segments the four neighbours
     * the spline construction needs.
     *
     * With `asArea` set, the path starts and finishes on the baseline and is closed, producing the
     * shape under the curve rather than the curve itself.
     */
    const emitSeries = (read: (age: number) => number, asArea: boolean): void => {
      const last = slots - 1;
      const bucketWidth = plotWidth / Math.max(1, last);
      const clampK = (k: number): number => (k < 0 ? 0 : k > last ? last : k);
      const kx = (k: number): number => sampleX(last - clampK(k), bucketWidth);
      const ky = (k: number): number => sampleY(read(last - clampK(k)));

      // Catmull-Rom control points sit one sixth of the way along the vector between a point's two
      // neighbours. Scaling that sixth by Smoothing is what lets the curve relax back into a
      // polyline at 0.
      const tension = smoothing / 6;

      if (asArea) {
        chart.moveTo(kx(0), baseline);
        chart.lineTo(kx(0), ky(0));
      } else {
        chart.moveTo(kx(0), ky(0));
      }

      for (let k = 0; k < last; k += 1) {
        const x0 = kx(k - 1);
        const y0 = ky(k - 1);
        const x1 = kx(k);
        const y1 = ky(k);
        const x2 = kx(k + 1);
        const y2 = ky(k + 1);
        const x3 = kx(k + 2);
        const y3 = ky(k + 2);
        chart.bezierCurveTo(
          x1 + (x2 - x0) * tension,
          y1 + (y2 - y0) * tension,
          x2 - (x3 - x1) * tension,
          y2 - (y3 - y1) * tension,
          x2,
          y2,
        );
      }

      if (asArea) {
        chart.lineTo(kx(last), baseline);
        chart.closePath();
      }
    };

    /* ── The readout text, throttled ──────────────────────────────────────────────────────── */

    /*
     * Assigning `.text` re-renders a glyph texture, so the two labels are updated four times a
     * second at most. That is fast enough that the number never looks stale and slow enough that a
     * jittering last digit does not make the panel look nervous — which is the real reason for the
     * throttle, quite apart from the cost.
     */
    let readoutTimer = READOUT_INTERVAL;
    let lastReadout = "";
    let lastCaption = labelText;

    const formatReadout = (): string => {
      if (readoutMode === "index") return String(Math.round(liveCombined * 100));
      if (readoutMode === "messages") {
        let total = bucketMsgs;
        for (let i = 0; i < slots; i += 1) total += at(histMsgs, i);
        // Divide by the time actually observed rather than by the nominal window, so the rate is
        // not quartered simply because the effect mounted twenty seconds ago. "Observed" includes
        // the stretch of backlog the seeding recovered, because those messages are in the total.
        const windowSeconds = (slots * bucketMs) / 1000;
        const observed = Math.max(5, Math.min(windowSeconds, elapsedSeconds + seededSeconds));
        return `${Math.round((total / observed) * 60)} MPM`;
      }
      return "";
    };

    /* ── The frame loop ───────────────────────────────────────────────────────────────────── */

    onFrame(scope, ctx.fpsCap, ({ dt, now }) => {
      // `sample` refreshes the shared analysis at most once per tick however many effects ask for
      // it, which is why it takes the tick's timestamp rather than reading the clock itself.
      bus.sample(now);
      envelopes.update(dt);
      elapsedSeconds += dt;

      /*
       * Chat activity decays by half over one sample length. Written as a power of `dt` rather than
       * a fixed multiplier per frame so that the decay takes the same amount of *time* on a 30 fps
       * capped route and on an uncapped 144 Hz display.
       */
      chatEnergy *= Math.pow(0.5, (dt * 1000) / bucketMs);

      liveAudio = clamp01(envelopes.mid);
      const liveChat = clamp01(chatEnergy / msgsFullScale);
      liveCombined = clamp01(chatWeight * liveChat + (1 - chatWeight) * liveAudio);

      /*
       * Advance the ring. The elapsed time is accumulated from `dt`, which the frame clock clamps
       * to a tenth of a second, rather than measured against the wall clock: a browser source that
       * was throttled in the background then wakes up with an enormous gap, and reading the wall
       * clock would make the chart lurch through dozens of empty samples. The loop is bounded by
       * the buffer length for the same reason.
       */
      bucketElapsed += dt * 1000;
      let advanced = 0;
      while (bucketElapsed >= bucketMs && advanced < slots) {
        bucketElapsed -= bucketMs;
        head = (head + 1) % slots;
        histCombined[head] = liveCombined;
        histAudio[head] = liveAudio;
        histMsgs[head] = bucketMsgs;
        bucketMsgs = 0;
        advanced += 1;
      }
      if (bucketElapsed >= bucketMs) bucketElapsed = 0;
      fraction = clamp01(bucketElapsed / bucketMs);

      // The intro wipe. Ease-out expo starts fast and settles gently, which reads as the chart
      // arriving rather than sliding. `introMs` of 0 skips it entirely.
      const introProgress = introMs <= 0 ? 1 : clamp01((elapsedSeconds * 1000) / introMs);
      const intro = introProgress >= 1 ? 1 : 1 - Math.pow(2, -10 * introProgress);
      chartMask.scale.x = Math.max(0.0001, intro);

      panel.alpha = opacity;
      caption.alpha = LABEL_ALPHA * intro;
      readout.alpha = LABEL_ALPHA * intro;
      caption.visible = labelText !== "";
      readout.visible = readoutMode !== "none";

      /* ── One Graphics, cleared and rebuilt ───────────────────────────────────────────── */

      chart.clear();

      const bucketWidth = plotWidth / Math.max(1, slots - 1);

      if (showGrid) {
        /*
         * The vertical markers are anchored to elapsed time rather than to sample indices, so they
         * travel at exactly the same speed as the data and never drift against it. `phase` is how
         * far past the last whole interval we are; each marker is then that much plus a whole
         * number of intervals into the past.
         */
        const intervalMs = gridEverySeconds * 1000;
        const phase = (elapsedSeconds * 1000) % intervalMs;
        const windowMs = slots * bucketMs;
        // Every marker goes into one path and is stroked once, because they all share a style.
        // Stroking each line on its own would be one draw call per marker for an identical result.
        let markers = 0;
        for (let ageMs = phase; ageMs <= windowMs; ageMs += intervalMs) {
          const x = Math.round(plotRight - (ageMs / bucketMs) * bucketWidth) + 0.5;
          if (x < -bucketWidth) break;
          chart.moveTo(x, plotTop);
          chart.lineTo(x, baseline);
          markers += 1;
        }
        if (markers > 0) chart.stroke({ width: 1, color: curveColor, alpha: GRID_ALPHA });

        const baseY = Math.round(baseline) - 0.5;
        chart.moveTo(-bucketWidth, baseY);
        chart.lineTo(plotRight, baseY);
        chart.stroke({ width: 1, color: curveColor, alpha: BASELINE_ALPHA });
      }

      if (showFill && fillAlpha > 0 && areaGradient !== null) {
        emitSeries(readCombined, true);
        // Only `alpha` is honoured here; the accent colour is already inside the gradient texture.
        chart.fill({ fill: areaGradient, alpha: fillAlpha });
      }

      if (showAudioSeries) {
        emitSeries(readAudio, false);
        chart.stroke({
          width: 1,
          color: audioColor,
          alpha: AUDIO_CURVE_ALPHA,
          cap: "round",
          join: "round",
        });
      }

      emitSeries(readCombined, false);
      chart.stroke({
        width: curveWidth,
        color: curveColor,
        alpha: CURVE_ALPHA,
        cap: "round",
        join: "round",
      });

      if (leadDotSize > 0) {
        const leadX = sampleX(0, bucketWidth);
        const leadY = sampleY(liveCombined);
        // The ring is the one thing in the panel that moves faster than the scroll: it follows the
        // fast envelope, which snaps to transients, so a sudden sound registers instantly even
        // though the curve itself takes a second to show it.
        const ringRadius = leadDotSize + 1 + envelopes.fast * leadRingGain;
        chart.circle(leadX, leadY, ringRadius).stroke({
          width: 1,
          color: accentColor,
          alpha: LEAD_RING_ALPHA,
        });
        chart.circle(leadX, leadY, leadDotSize).fill({ color: curveColor, alpha: 0.95 });
      }

      /* ── Text ────────────────────────────────────────────────────────────────────────── */

      readoutTimer += dt;
      if (readoutTimer >= READOUT_INTERVAL) {
        readoutTimer = 0;
        if (labelText !== lastCaption) {
          caption.text = labelText;
          lastCaption = labelText;
        }
        const next = formatReadout();
        if (next !== lastReadout) {
          readout.text = next;
          lastReadout = next;
        }
      }
      // Kept outside the throttle: it is a property assignment with no glyph work behind it, and
      // doing it every frame means the readout is never left hanging in the wrong place for a
      // quarter of a second after the panel is resized.
      readout.x = Math.round(plotRight - readout.width);

      // Pixi's own ticker is switched off by `createPixiStage` so that this project has exactly one
      // animation loop. Nothing reaches the canvas until this line.
      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        labelText = readLabel(p);
        readoutMode = str(p, "readout", "index");
        bucketMs = num(p, "bucketMs", 1250, 200, 5000);
        chatWeight = num(p, "chatWeight", 0.45, 0, 1);
        msgsFullScale = num(p, "msgsFullScale", 5, 1, 60);
        showAudioSeries = bool(p, "showAudioSeries", true);
        smoothing = num(p, "smoothing", 1, 0, 1);
        showFill = bool(p, "showFill", true);
        fillAlpha = num(p, "fillAlpha", 0.1, 0, 0.6);
        showGrid = bool(p, "showGrid", true);
        gridEverySeconds = num(p, "gridEverySeconds", 30, 2, 120);
        curveWidth = num(p, "curveWidth", 1, 0.5, 6);
        leadDotSize = num(p, "leadDotSize", 3, 0, 8);
        leadRingGain = num(p, "leadRingGain", 5, 0, 20);
        opacity = num(p, "opacity", 1, 0, 1);
        introMs = num(p, "introMs", 700, 0, 4000);

        const chosen = palette(p, "palette", "monochrome");
        curveColor = paletteAtInt(chosen, 1);
        audioColor = paletteAtInt(chosen, 0.72);
        accentColor = colorInt(p, "accentColor", "#ffc46b");

        /*
         * Changing how many samples are kept resamples the history rather than clearing it. An
         * operator dragging this slider is watching a live broadcast, and two minutes of history
         * blinking out of existence is a far worse outcome than a slightly approximate redraw.
         *
         * Because each sample covers the same amount of time before and after, a sample keeps its
         * age: the entry three places behind the leading edge stays three places behind it. Growing
         * the buffer leaves the extra, older entries at zero — that history genuinely was never
         * recorded — and shrinking it drops the oldest entries, which is what the operator asked
         * for.
         */
        const nextSlots = int(p, "slots", 96, 12, 240);
        if (nextSlots !== slots) {
          const nextCombined = new Float32Array(nextSlots);
          const nextAudio = new Float32Array(nextSlots);
          const nextMsgs = new Float32Array(nextSlots);
          const kept = Math.min(nextSlots, slots);
          for (let age = 1; age < kept; age += 1) {
            const source = ringIndex(age);
            // The new buffer's head is index 0, so the sample `age` places back lands at
            // `nextSlots - (age - 1)`, wrapped.
            const target = (nextSlots - (age - 1)) % nextSlots;
            nextCombined[target] = at(histCombined, source);
            nextAudio[target] = at(histAudio, source);
            nextMsgs[target] = at(histMsgs, source);
          }
          histCombined = nextCombined;
          histAudio = nextAudio;
          histMsgs = nextMsgs;
          slots = nextSlots;
          head = 0;
        }

        /*
         * The layout is rebuilt only when a value it actually depends on moved. `setParams` fires
         * with unchanged values often — every save of the route, whatever was edited — and
         * rebuilding the gradient texture each time would be work for nothing.
         */
        const nextFontSize = int(p, "fontSize", 10, 6, 24);
        const nextFontFamily = str(
          p,
          "fontFamily",
          "'Helvetica Neue', Helvetica, Arial, sans-serif",
        );
        const nextPanelWidth = num(p, "panelWidth", 420, 80, 1600);
        const nextPanelHeight = num(p, "panelHeight", 92, 40, 600);
        const nextAnchor = str(p, "anchor", "bottom-left");
        const nextMarginX = num(p, "marginX", 64, 0, 600);
        const nextMarginY = num(p, "marginY", 64, 0, 600);
        const nextAccentHex = colorHex(p, "accentColor", "#ffc46b");

        const typeChanged = nextFontSize !== fontSize || nextFontFamily !== fontFamily;
        const layoutChanged =
          typeChanged ||
          nextPanelWidth !== panelWidthParam ||
          nextPanelHeight !== panelHeightParam ||
          nextAnchor !== anchor ||
          nextMarginX !== marginX ||
          nextMarginY !== marginY ||
          // The accent is baked into the gradient texture, so a new colour means a new gradient —
          // which `layout` is the one place that builds.
          nextAccentHex !== accentHex;

        fontSize = nextFontSize;
        fontFamily = nextFontFamily;
        panelWidthParam = nextPanelWidth;
        panelHeightParam = nextPanelHeight;
        anchor = nextAnchor;
        marginX = nextMarginX;
        marginY = nextMarginY;
        accentHex = nextAccentHex;

        if (typeChanged) {
          // Text styles are live objects on the display object, so they are edited in place; Pixi
          // marks the glyph texture dirty and re-renders it on the next draw.
          for (const text of [caption, readout]) {
            text.style.fontFamily = fontFamily;
            text.style.fontSize = fontSize;
            text.style.letterSpacing = fontSize * TRACKING_EM;
          }
        }
        if (layoutChanged) layout();
      },
    };
  },
});

export default roomTone;
