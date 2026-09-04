import * as PIXI from "pixi.js";

import { bool, colorHex, colorInt, int, num, str } from "../paramUtils";
import {
  createEnvelopes,
  createPixiStage,
  defineEffect,
  onFrame,
  useAudio,
  useChat,
  useFonts,
} from "../sdk";
import type { ChatMessage } from "~/types/contract";

/**
 * Arrival Seam
 * ============
 *
 * An alert overlay, written to be almost invisible. For the long stretches when nothing is
 * happening on the stream it is a single hairline of light lying across the frame — a seam in the
 * scene, not a piece of user interface. When someone subscribes, gifts subs, cheers or raids, that
 * seam **opens** like a slit in a curtain: it widens into a slab of light, the light spills onto the
 * scene above and below it, and the arriving viewer's name is wiped into existence inside the
 * opening one letter-width at a time. It holds for a couple of seconds while the streamer reacts,
 * then seals shut and goes back to being a hairline.
 *
 * This is the repository's first alert effect, so it is worth saying what an "alert" is: the little
 * animation a stream plays when a viewer does something that costs them money or attention. Twitch
 * calls those channel events, and the chat SDK delivers them on the same stream as ordinary chat
 * messages, tagged with an `event` field (`"sub"`, `"gift_sub"`, `"cheer"`, `"raid"`) and a small
 * bag of extras in `data` (how many months, how many bits, how many raiders).
 *
 * The choreography, which is the whole design
 * -------------------------------------------
 * Three deliberate decisions separate this from a tween:
 *
 *  1. **The opening and the name reveal do not start together.** The slab starts opening at t=0;
 *     the name's wipe starts a fraction of a second later (Reveal Delay, 0.14 s by default). That
 *     small stagger is what makes the name look like it is being *pulled out of* the light rather
 *     than switched on with it.
 *  2. **They do not share an easing curve.** "Easing" means how a movement distributes itself over
 *     its duration. The slab uses *ease-out-back*, which overshoots its target slightly and settles
 *     back — the motion of something sprung. The wipe uses *ease-out-quart*, which starts fast and
 *     glides to a stop with no overshoot at all. Two different curves running at two different times
 *     read as directed motion; one curve for both reads as a cheap slide.
 *  3. **Closing is faster than opening** (0.32 s against 0.48 s), and the name wipes out in the same
 *     direction it came in, so the exit is a continuation of the entrance rather than a rewind.
 *
 * The audio idea
 * --------------
 * While the seam is held open, the brightness of the spilled light follows `envelopes.mid` — a
 * medium-paced tracking of how loud the stream's own audio is. In practice that means the
 * streamer's "ohhh, thank you!" *is* the animation: the alert reacts to the reaction. Set Voice
 * Spill to 0 to keep the light perfectly constant instead. `envelopes.beat` gets one small job as
 * well: on the frame the seam finishes opening, the slab dips a couple of pixels and springs back,
 * a touch harder when the moment coincided with a transient in the audio.
 *
 * Queueing
 * --------
 * Only one event is ever on screen. Anything arriving during an alert waits in a short queue, and a
 * raid jumps to the front of it, because a raid is the loudest thing that happens on a stream and
 * should not be stuck behind three cheers. When the queue is full the *oldest* waiting event is
 * dropped — a sub from thirty seconds ago is stale news, the newest one is not.
 *
 * Why "Demo Pulse" is a real parameter and not a debug flag
 * --------------------------------------------------------
 * Real subs and raids are rare, and the SDK's simulated chat feed (what runs when Twitch is not
 * configured) emits ordinary chat messages almost exclusively. Without a way to fire a fake event,
 * this effect would be untunable in the preview and would show nothing but a hairline. So Demo
 * Pulse is on by default and synthesises an example event every few seconds, rotating through the
 * four kinds. **Turn it off before going live**, or the overlay will thank viewers who do not
 * exist.
 *
 * Drawing technique
 * -----------------
 * The seam and the slab are the same drawing at different heights: one `Graphics` cleared and
 * refilled each frame as a row of short rectangles whose opacity tapers to nothing at both ends, so
 * the light fades out sideways instead of stopping at a hard edge. The spilled light is a soft
 * gradient painted **once** into an ordinary 2D canvas at setup, turned into a texture, and then
 * only ever stretched and tinted by two sprites — re-baking a gradient every frame is the expensive
 * mistake this shape of effect invites. The wipe is a plain rectangle used as a *mask*: in Pixi a
 * mask is a shape that decides which parts of another object are visible, and it must itself be in
 * the display list to work, which is why the mask rectangle is added to the stage.
 */

/**
 * How many rectangles the seam is drawn from.
 *
 * The seam needs to fade out towards its two ends, and a `Graphics` fill has one opacity for the
 * whole shape. Drawing it as a row of narrow rectangles, each with its own opacity, gives the fade
 * for the cost of a few dozen rectangles a frame — which is nothing. Forty-eight is enough that the
 * steps between neighbouring opacities are invisible.
 */
const SEAM_SEGMENTS = 48;

/** Fraction of the seam's length, at each end, over which its opacity tapers away to zero. */
const SEAM_TAPER = 0.18;

/** How far the slab dips when it finishes opening, in pixels, before springing back. */
const SETTLE_PX = 2;

/** Opacity of the slab at full opening. Short of 1 so the scene behind still shows through it. */
const SLAB_ALPHA = 0.9;

/** Size of the baked spill gradient. Small on purpose: it is only ever stretched, never inspected. */
const SPILL_TEX_W = 256;
const SPILL_TEX_H = 160;

/** Gap between the bottom of the slab and the small-caps detail line, in detail-font-size units. */
const DETAIL_GAP_FACTOR = 1.7;

/** Widest the two text lines may be, as a fraction of the canvas width, before they are scaled down. */
const TEXT_MAX_WIDTH_FRACTION = 0.86;

/** How long after mount the first demonstration event fires, in seconds. Short so a freshly opened
 * preview shows the whole animation immediately rather than a hairline for six seconds. */
const FIRST_DEMO_DELAY_S = 1.2;

/** One queued or playing alert, already reduced to the two lines of text and a colour. */
interface Alert {
  /** The arriving viewer's display name, drawn large. */
  name: string;
  /** The small-caps line under it, e.g. "RAID · 212 VIEWERS". */
  detail: string;
  /** Tint for the slab and the spilled light, as a 24-bit colour. */
  tint: number;
  /** Whether this came from a raid, which is what lets it jump the queue. */
  raid: boolean;
}

/** The four states the seam moves through. `idle` is the hairline; everything else is one alert. */
type Phase = "idle" | "opening" | "holding" | "closing";

/** Clamps a value into 0..1, which every easing curve below assumes of its input. */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Ease-out-back: overshoots the target and settles back onto it.
 *
 * At t=0 it returns 0 and at t=1 it returns 1, but around t≈0.7 it passes 1.05 or so before coming
 * back down. That overshoot is what makes the seam look sprung open rather than pushed open.
 */
function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const p = t - 1;
  return 1 + c3 * p * p * p + c1 * p * p;
}

/** Ease-out-quart: leaves fast, arrives gently, never overshoots. The wipe's curve. */
function easeOutQuart(t: number): number {
  const p = 1 - t;
  return 1 - p * p * p * p;
}

/** Ease-in-cubic: leaves slowly, arrives fast. The closing curve — the seam snaps shut at the end. */
function easeInCubic(t: number): number {
  return t * t * t;
}

/** Smooth 0→1 ramp used for the seam's end taper, so the fade has no visible corner. */
function smoothstep(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/**
 * How far open the seam is right now: 0 is the resting hairline, 1 the full slab.
 *
 * Kept out of the frame loop so each state's curve sits on one line beside the others — the whole
 * choreography of the effect is these four cases plus the wipe's separate clock.
 */
function openFactorFor(
  phase: Phase,
  phaseTime: number,
  openSeconds: number,
  closeSeconds: number,
): number {
  switch (phase) {
    case "opening":
      // Divisors are floored at a hundredth of a second so a pathological stored duration can
      // never divide by zero and put NaN into every position on the stage.
      return easeOutBack(clamp01(phaseTime / Math.max(0.01, openSeconds)));
    case "holding":
      return 1;
    case "closing":
      return 1 - easeInCubic(clamp01(phaseTime / Math.max(0.01, closeSeconds)));
    case "idle":
    default:
      return 0;
  }
}

/** Opacity multiplier for a point `t` (0..1) along the seam, tapering to zero at both ends. */
function seamTaper(t: number): number {
  if (t < SEAM_TAPER) return smoothstep(t / SEAM_TAPER);
  if (t > 1 - SEAM_TAPER) return smoothstep((1 - t) / SEAM_TAPER);
  return 1;
}

/** Parses a `#rrggbb` string into the 24-bit integer Pixi wants, falling back when it is not one. */
function hexToInt(value: string, fallback: number): number {
  return /^#[0-9a-fA-F]{6}$/.test(value) ? Number.parseInt(value.slice(1), 16) : fallback;
}

/**
 * Reads a count out of a chat event's `data` bag, which is typed as unknown values.
 *
 * Every number this effect reads is a count of something — months, bits, gifted subs, raiders — so
 * the result is rounded and floored at zero. Twitch sends whole numbers, but the value has come
 * through JSON from a service this code does not control, and "CHEERED 1.5 BITS" is a worse thing
 * to put on a broadcast than a rounded one. Rounding also keeps {@link plural} honest: `1.4` is one
 * bit, and should read "1 BIT", not "1.4 BITS".
 */
function readNumber(data: Record<string, unknown>, key: string): number | null {
  const raw = Number(data[key]);
  return Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : null;
}

/** Reads a `data` value as display text, accepting the numbers Twitch sends for tiers. */
function readLabel(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** "1 SUB" / "5 SUBS" — the plural of a counted noun, so the detail line never reads "1 SUBS". */
function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Shortens a chat line so it cannot run off the frame, with an ellipsis when it was cut. */
function truncate(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}

/**
 * Turns one chat message into the two lines the seam displays.
 *
 * The detail line is built from the event's own extras — the months on a resub, the bits on a
 * cheer, the raiding party's size — and falls back to a bare verb when Twitch sent no extras, which
 * happens on anonymous gifts and on the simulated feed.
 */
function describe(message: ChatMessage): string {
  const data = message.data;
  switch (message.event) {
    case "sub": {
      const months = readNumber(data, "months");
      const tier = readLabel(data, "tier");
      if (months !== null && months > 1)
        return `RESUBSCRIBED · ${plural(months, "MONTH", "MONTHS")}`;
      return tier === null ? "SUBSCRIBED" : `SUBSCRIBED · TIER ${tier}`;
    }
    case "gift_sub": {
      const total = readNumber(data, "total");
      return total === null ? "GIFTED A SUB" : `GIFTED ${plural(total, "SUB", "SUBS")}`;
    }
    case "cheer": {
      const bits = readNumber(data, "bits");
      return bits === null ? "CHEERED" : `CHEERED ${plural(bits, "BIT", "BITS")}`;
    }
    case "raid": {
      const viewers = readNumber(data, "viewers");
      return viewers === null ? "RAID" : `RAID · ${plural(viewers, "VIEWER", "VIEWERS")}`;
    }
    case "chat":
    default: {
      // Only reachable in "every chat message" mode, where the message itself is the interesting
      // part — so it becomes the detail line rather than a generic verb.
      const text = truncate(message.text, 46);
      return text === "" ? "IN CHAT" : text.toUpperCase();
    }
  }
}

/** The demonstration events Demo Pulse cycles through, so every kind of copy can be checked. */
const DEMO_EVENTS: ReadonlyArray<{ name: string; detail: string; color: string; raid: boolean }> = [
  { name: "Pixel_Pal", detail: "RESUBSCRIBED · 14 MONTHS", color: "#7fdbca", raid: false },
  { name: "night_owl", detail: "RAID · 212 VIEWERS", color: "#c792ea", raid: true },
  { name: "GG_Marta", detail: "CHEERED 500 BITS", color: "#ffcb6b", raid: false },
  { name: "lurker_len", detail: "GIFTED 5 SUBS", color: "#82aaff", raid: false },
];

/**
 * Paints the soft light-spill gradient into a texture, once.
 *
 * The picture is white and fully opaque along its top edge, fading to nothing at the bottom, and
 * separately fading to nothing at its left and right edges. That second fade is applied with the
 * canvas compositing mode `destination-in`, which keeps only the parts of what is already drawn
 * that the new shape covers — painting a horizontal fade in that mode multiplies the existing
 * opacity by it. White is deliberate: a sprite's `tint` multiplies, so a white picture takes any
 * colour faithfully.
 */
function makeSpillTexture(): PIXI.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = SPILL_TEX_W;
  canvas.height = SPILL_TEX_H;
  const g = canvas.getContext("2d");
  if (g) {
    const vertical = g.createLinearGradient(0, 0, 0, SPILL_TEX_H);
    vertical.addColorStop(0, "rgba(255,255,255,1)");
    vertical.addColorStop(0.14, "rgba(255,255,255,0.5)");
    vertical.addColorStop(0.45, "rgba(255,255,255,0.14)");
    vertical.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = vertical;
    g.fillRect(0, 0, SPILL_TEX_W, SPILL_TEX_H);

    g.globalCompositeOperation = "destination-in";
    const horizontal = g.createLinearGradient(0, 0, SPILL_TEX_W, 0);
    horizontal.addColorStop(0, "rgba(255,255,255,0)");
    horizontal.addColorStop(0.24, "rgba(255,255,255,1)");
    horizontal.addColorStop(0.76, "rgba(255,255,255,1)");
    horizontal.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = horizontal;
    g.fillRect(0, 0, SPILL_TEX_W, SPILL_TEX_H);
  }
  return PIXI.Texture.from(canvas);
}

const arrivalSeam = defineEffect({
  descriptor: {
    id: "arrival-seam",
    name: "Arrival Seam",
    description:
      "A quiet alert overlay: a hairline of light across the frame that opens like a slit in a curtain when someone subscribes, cheers, gifts or raids, wipes the arriving viewer's name into being, holds while you react, and seals shut.",
    engine: "pixi",
    category: "chat",
    tags: ["alert", "chat", "twitch", "sub", "raid", "overlay", "minimal", "reactive"],
    previewNotes:
      "Transparent, and blank apart from a faint hairline until an event arrives — lay it over a camera or a game capture. Demo Pulse is on by default so the preview shows a fake event every few seconds; switch it off before going live or the overlay will announce viewers who do not exist. The spilled light brightens with your microphone while the seam is held open.",
    params: [
      {
        key: "triggerEvents",
        label: "Opens For",
        kind: "select",
        default: "subs and raids",
        options: ["subs and raids", "all channel events", "every chat message"],
        description:
          'Which Twitch activity opens the seam. "subs and raids" covers subscriptions, gifted subs and raids; "all channel events" adds cheers (bits); "every chat message" fires on ordinary chat too, which is only sensible on a very quiet channel.',
      },
      {
        key: "openSeconds",
        label: "Open Duration",
        kind: "number",
        default: 0.48,
        min: 0.1,
        max: 3,
        step: 0.01,
        description:
          "How long the seam takes to open, in seconds. It springs slightly past its full height and settles back, so short values read as snappier rather than merely faster.",
      },
      {
        key: "holdSeconds",
        label: "Hold Duration",
        kind: "number",
        default: 2.5,
        min: 0.5,
        max: 20,
        step: 0.1,
        description:
          "How long the name stays up once the seam is fully open, in seconds. Long enough to read the name out loud is about 2.5.",
      },
      {
        key: "closeSeconds",
        label: "Close Duration",
        kind: "number",
        default: 0.32,
        min: 0.1,
        max: 3,
        step: 0.01,
        description:
          "How long the seam takes to seal, in seconds. Keeping this shorter than Open Duration is what makes the exit feel decided rather than reluctant.",
      },
      {
        key: "revealDelay",
        label: "Reveal Delay",
        kind: "number",
        default: 0.14,
        min: 0,
        max: 1.5,
        step: 0.01,
        description:
          "How long after the seam starts opening the name begins to wipe in, in seconds. This offset is the difference between the name being pulled out of the light and the name simply appearing with it; 0 makes them simultaneous.",
      },
      {
        key: "revealSeconds",
        label: "Reveal Duration",
        kind: "number",
        default: 0.52,
        min: 0.05,
        max: 4,
        step: 0.01,
        description:
          "How long the name's left-to-right wipe takes, in seconds, once it has started.",
      },
      {
        key: "slabHeight",
        label: "Open Height",
        kind: "number",
        default: 96,
        min: 16,
        max: 400,
        step: 1,
        description:
          "How far the seam opens, in pixels. The name is drawn inside the opening, so keep this comfortably larger than the Name Size.",
      },
      {
        key: "seamWidth",
        label: "Seam Length",
        kind: "number",
        default: 0.4,
        min: 0.05,
        max: 1,
        step: 0.01,
        description:
          "Length of the seam as a fraction of the frame width. 0.4 keeps it clearly shorter than the frame, which is what makes it read as a seam in the scene rather than a band across it.",
      },
      {
        key: "seamY",
        label: "Seam Height",
        kind: "number",
        default: 0.42,
        min: 0,
        max: 1,
        step: 0.01,
        description:
          "Where the seam sits vertically, as a fraction of the frame height. 0 is the very top, 1 the very bottom, 0.5 dead centre.",
      },
      {
        key: "seamThickness",
        label: "Hairline Thickness",
        kind: "number",
        default: 2,
        min: 1,
        max: 12,
        step: 1,
        description:
          "Thickness of the resting hairline, in pixels, and of the bright core inside the opened slab.",
      },
      {
        key: "idleOpacity",
        label: "Hairline Opacity",
        kind: "number",
        default: 0.2,
        min: 0,
        max: 1,
        step: 0.01,
        description:
          "How visible the hairline is while nothing is happening. 0 hides it completely, so the overlay is entirely invisible between events.",
      },
      {
        key: "spillHeight",
        label: "Light Spill Reach",
        kind: "number",
        default: 220,
        min: 0,
        max: 800,
        step: 5,
        description:
          "How far the light from the opening reaches above and below the seam, in pixels. 0 removes the spill and leaves only the slab.",
      },
      {
        key: "spillStrength",
        label: "Light Spill Strength",
        kind: "number",
        default: 0.55,
        min: 0,
        max: 1,
        step: 0.01,
        description:
          "Peak opacity of the spilled light. The spill is drawn additively, so it brightens whatever is behind it rather than covering it.",
      },
      {
        key: "voiceSpill",
        label: "Voice Spill",
        kind: "number",
        default: 0.6,
        min: 0,
        max: 2,
        step: 0.05,
        description:
          "How much your own audio brightens the spilled light while the seam is held open — so reacting out loud animates the alert. 0 keeps the light perfectly constant.",
      },
      {
        key: "nameFontSize",
        label: "Name Size",
        kind: "number",
        default: 54,
        min: 12,
        max: 160,
        step: 1,
        description:
          "Height of the arriving viewer's name, in pixels. Long names are scaled down automatically so they always fit the frame.",
      },
      {
        key: "detailFontSize",
        label: "Detail Size",
        kind: "number",
        default: 15,
        min: 8,
        max: 60,
        step: 1,
        description: "Height of the small tracked-out line under the name, in pixels.",
      },
      {
        key: "fontFamily",
        label: "Font",
        kind: "text",
        default: '"Inter", "Helvetica Neue", Helvetica, Arial, sans-serif',
        description:
          "CSS font family list for both lines. Give a fallback after any specific name, so a machine without that font still draws readable text.",
      },
      {
        key: "textColor",
        label: "Text Colour",
        kind: "color",
        default: "#f4f7ff",
        description: "Colour of the name and the detail line.",
      },
      {
        key: "seamColor",
        label: "Seam Colour",
        kind: "color",
        default: "#dfe9ff",
        description:
          "Colour of the seam and of the light it spills. Used for every event when Use Viewer Colour is off.",
      },
      {
        key: "tintFromChat",
        label: "Use Viewer Colour",
        kind: "boolean",
        default: true,
        description:
          "Tint the seam and its light with the arriving viewer's own Twitch chat colour, so each person brings their colour into the frame. Off keeps every event in the Seam Colour.",
      },
      {
        key: "maxQueue",
        label: "Queue Length",
        kind: "number",
        default: 4,
        min: 1,
        max: 20,
        step: 1,
        description:
          "How many events may wait their turn while one is on screen. Beyond this the oldest waiting event is dropped, because a raid that happened a minute ago is no longer news.",
      },
      {
        key: "testPulse",
        label: "Demo Pulse",
        kind: "boolean",
        default: true,
        description:
          "Fire a demonstration event on a timer so the alert can be seen and tuned without waiting for a real subscriber. Turn this off before going live.",
      },
      {
        key: "testPulseSeconds",
        label: "Demo Pulse Interval",
        kind: "number",
        default: 6,
        min: 2,
        max: 120,
        step: 0.5,
        description: "Seconds between demonstration events while Demo Pulse is on.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    // Audio first, so a scope disposed during the wait tears down with nothing built. None of
    // these three helpers checkpoints on its own — see their documentation in the SDK.
    const bus = await useAudio(scope);
    scope.checkpoint();
    const envelopes = createEnvelopes(bus);

    const chat = await useChat(scope);
    scope.checkpoint();

    let nameFontSize = int(ctx.params, "nameFontSize", 54, 12, 160);
    let detailFontSize = int(ctx.params, "detailFontSize", 15, 8, 60);
    let fontFamily = str(
      ctx.params,
      "fontFamily",
      '"Inter", "Helvetica Neue", Helvetica, Arial, sans-serif',
    );

    // Wait for the faces before any text is measured. The wipe mask is sized from the measured
    // width of the name, so laying out against a substituted font would put the mask in the wrong
    // place for the first alert and never again — the hardest kind of glitch to catch.
    await useFonts([`${nameFontSize}px ${fontFamily}`, `${detailFontSize}px ${fontFamily}`]);
    scope.checkpoint();

    const stage = await createPixiStage(scope, ctx);

    let triggerEvents = str(ctx.params, "triggerEvents", "subs and raids");
    let openSeconds = num(ctx.params, "openSeconds", 0.48, 0.1, 3);
    let holdSeconds = num(ctx.params, "holdSeconds", 2.5, 0.5, 20);
    let closeSeconds = num(ctx.params, "closeSeconds", 0.32, 0.1, 3);
    let revealDelay = num(ctx.params, "revealDelay", 0.14, 0, 1.5);
    let revealSeconds = num(ctx.params, "revealSeconds", 0.52, 0.05, 4);
    let slabHeight = num(ctx.params, "slabHeight", 96, 16, 400);
    let seamWidth = num(ctx.params, "seamWidth", 0.4, 0.05, 1);
    let seamY = num(ctx.params, "seamY", 0.42, 0, 1);
    let seamThickness = num(ctx.params, "seamThickness", 2, 1, 12);
    let idleOpacity = num(ctx.params, "idleOpacity", 0.2, 0, 1);
    let spillHeight = num(ctx.params, "spillHeight", 220, 0, 800);
    let spillStrength = num(ctx.params, "spillStrength", 0.55, 0, 1);
    let voiceSpill = num(ctx.params, "voiceSpill", 0.6, 0, 2);
    let textColor = colorHex(ctx.params, "textColor", "#f4f7ff");
    let seamColor = colorInt(ctx.params, "seamColor", "#dfe9ff");
    let tintFromChat = bool(ctx.params, "tintFromChat", true);
    let maxQueue = int(ctx.params, "maxQueue", 4, 1, 20);
    let testPulse = bool(ctx.params, "testPulse", true);
    let testPulseSeconds = num(ctx.params, "testPulseSeconds", 6, 2, 120);

    /*
     * The display list, back to front:
     *
     *   spillLayer  the two soft gradient sprites, drawn additively so they read as light
     *   slab        the seam itself, redrawn every frame
     *   textLayer   the two Text objects of the current alert, clipped by the wipe mask
     *   wipeMask    the mask rectangle — never visible itself, but it has to be on the stage
     */
    const spillLayer = stage.stage.addChild(new PIXI.Container());
    spillLayer.blendMode = "add";
    const spillTexture = makeSpillTexture();
    const spillBelow = spillLayer.addChild(new PIXI.Sprite(spillTexture));
    const spillAbove = spillLayer.addChild(new PIXI.Sprite(spillTexture));
    // Anchored on the top-middle so the bright edge of the gradient sits exactly on the seam; the
    // upper copy is then flipped by giving it a negative vertical scale.
    spillBelow.anchor.set(0.5, 0);
    spillAbove.anchor.set(0.5, 0);

    const slab = stage.stage.addChild(new PIXI.Graphics());
    const textLayer = stage.stage.addChild(new PIXI.Container());
    const wipeMask = stage.stage.addChild(new PIXI.Graphics());
    textLayer.mask = wipeMask;

    /*
     * The spill texture is not registered on the scope. `createPixiStage` already registered
     * `app.destroy(true, { children: true, texture: true, textureSource: true })`, which frees the
     * textures of every child — and the two sprites holding this one are children. Owning it
     * separately would destroy it *before* the application, because a scope tears down in reverse
     * registration order, and Pixi would then be asked to free it twice.
     */

    /** The alert currently on screen, or null while the seam is a hairline. */
    let current: Alert | null = null;
    /** The two Text objects of the current alert. Never more than two exist at a time. */
    let nameText: PIXI.Text | null = null;
    let detailText: PIXI.Text | null = null;

    /** Events waiting their turn, oldest first. A raid is pushed onto the front instead. */
    const queue: Alert[] = [];

    let phase: Phase = "idle";
    /** Seconds spent in the current phase. */
    let phaseTime = 0;
    /** Seconds since the current alert started opening — the clock the name wipe runs on, because
     * the wipe deliberately outlives the opening. */
    let eventTime = 0;
    /** The settle bounce: 1 right after the seam finishes opening, decaying to 0. */
    let settle = 0;
    /** Countdown to the next demonstration event. */
    let demoTimer = Math.max(0, testPulseSeconds - FIRST_DEMO_DELAY_S);
    let demoIndex = 0;

    const nameStyle = (): PIXI.TextStyle =>
      new PIXI.TextStyle({
        fontFamily,
        fontSize: nameFontSize,
        fontWeight: "600",
        fill: textColor,
        letterSpacing: nameFontSize * 0.01,
        // A thin dark outline, not a heavy one: enough to hold the near-white type together over a
        // bright game capture, light enough not to turn it into a sticker.
        stroke: { color: 0x000000, width: Math.max(1, nameFontSize * 0.04), alpha: 0.55 },
      });

    const detailStyle = (): PIXI.TextStyle =>
      new PIXI.TextStyle({
        fontFamily,
        fontSize: detailFontSize,
        fontWeight: "600",
        fill: textColor,
        // Wide letter spacing is what gives a short uppercase line its "small caps" feel.
        letterSpacing: detailFontSize * 0.16,
        stroke: { color: 0x000000, width: Math.max(1, detailFontSize * 0.08), alpha: 0.5 },
      });

    /** Whether a message's event kind is one the operator asked the seam to open for. */
    const wanted = (event: ChatMessage["event"]): boolean => {
      if (triggerEvents === "every chat message") return true;
      if (event === "chat") return false;
      if (triggerEvents === "all channel events") return true;
      return event !== "cheer";
    };

    const enqueue = (alert: Alert): void => {
      // A raid is the loudest thing that happens on a stream, so it goes to the front rather than
      // waiting behind whatever else is queued.
      if (alert.raid) queue.unshift(alert);
      else queue.push(alert);

      const overflow = queue.length - maxQueue;
      if (overflow > 0) {
        /*
         * Overflow drops the oldest *waiting* events, because a sub from thirty seconds ago is
         * stale news and the newest one is not.
         *
         * The `alert.raid ? 1 : 0` is the part that is easy to get wrong. A raid was just placed at
         * index 0, so trimming from index 0 on a queue that was already full would delete the raid
         * with the very splice meant to make room for it — the event would jump the queue and then
         * immediately be thrown away, which is the exact opposite of what queue-jumping is for.
         * Starting the trim one place further along leaves the new arrival alone and drops from the
         * events behind it instead.
         */
        queue.splice(alert.raid ? 1 : 0, overflow);
      }
    };

    const off = chat.onMessage((message) => {
      if (!wanted(message.event)) return;
      // Twitch normally guarantees a display name, but the feed also carries anonymous gifts and
      // the simulated messages a preview runs on, so fall back rather than draw a blank line where
      // a person's name should be.
      const name = message.displayName.trim() || message.username.trim() || "Someone";
      enqueue({
        name,
        detail: describe(message),
        tint: tintFromChat ? hexToInt(message.color, seamColor) : seamColor,
        raid: message.event === "raid",
      });
    });
    scope.defer(off);

    /*
     * `chat.recent()` is deliberately not replayed. It holds up to fifty messages of backlog, and
     * an overlay that has just been mounted must not announce a subscription that happened an hour
     * ago as if it were happening now.
     */

    /** Creates the two Text objects for an alert and puts them on the stage. */
    const beginAlert = (alert: Alert): void => {
      current = alert;
      phase = "opening";
      phaseTime = 0;
      eventTime = 0;

      nameText = textLayer.addChild(new PIXI.Text({ text: alert.name, style: nameStyle() }));
      detailText = textLayer.addChild(new PIXI.Text({ text: alert.detail, style: detailStyle() }));
      nameText.anchor.set(0.5);
      detailText.anchor.set(0.5);
    };

    /** Tears the current alert down and returns the seam to its hairline. */
    const endAlert = (): void => {
      // `PIXI.Text` owns a texture of its rendered glyphs, so it has to be destroyed rather than
      // dropped for the garbage collector; over a multi-hour broadcast the leak would be real.
      nameText?.destroy({ children: true });
      detailText?.destroy({ children: true });
      nameText = null;
      detailText = null;
      current = null;
      phase = "idle";
      phaseTime = 0;
      eventTime = 0;
      // The wipe rectangle is only rebuilt while there is text to clip, so an alert that ends
      // leaves its last rectangle behind. Nothing draws through it while `textLayer` is empty, but
      // an emptied mask is the honest state, and it means the next alert cannot flash one frame of
      // the previous name's wipe before its own first rebuild lands.
      wipeMask.clear();
    };
    // The two texts are children of a container the application destroys on teardown, so there is
    // nothing further to register here — but an alert that is mid-flight when the effect is
    // disposed is torn down by that same `app.destroy`, not by this function.

    /**
     * The arguments of the last seam actually drawn, so an identical redraw can be skipped.
     *
     * They start as `NaN`, which compares unequal to everything including itself, so the first
     * frame always draws. See the note in {@link drawSeam}.
     */
    const drawn = { x: NaN, y: NaN, half: NaN, height: NaN, alpha: NaN, tint: NaN, core: NaN };

    /**
     * Redraws the seam at a given height and opacity.
     *
     * The hairline and the fully open slab are the same drawing: a row of narrow rectangles across
     * the seam's length, each faded by how close it is to an end, plus a brighter core rectangle
     * down the middle that keeps the line of light readable at any height.
     *
     * It returns early when nothing about the seam has changed since the last frame. That matters
     * because of what this effect *is*: an alert overlay spends almost all of its life idle, and an
     * idle seam is the same hundred-odd rectangles frame after frame. Rebuilding a Pixi `Graphics`
     * is not free — `clear()` throws the geometry away and every `rect().fill()` re-tessellates and
     * re-uploads it — so without this guard a stream would pay for ninety-six rectangles sixty
     * times a second to redraw a motionless hairline. Skipping is safe because nothing else in the
     * effect ever touches `slab`: what was drawn last frame is still there and still correct.
     */
    const drawSeam = (
      centreX: number,
      centreY: number,
      halfLength: number,
      height: number,
      alpha: number,
      tint: number,
    ): void => {
      const coreHeight = Math.min(height, seamThickness);
      if (
        drawn.x === centreX &&
        drawn.y === centreY &&
        drawn.half === halfLength &&
        drawn.height === height &&
        drawn.alpha === alpha &&
        drawn.tint === tint &&
        drawn.core === coreHeight
      ) {
        return;
      }
      drawn.x = centreX;
      drawn.y = centreY;
      drawn.half = halfLength;
      drawn.height = height;
      drawn.alpha = alpha;
      drawn.tint = tint;
      drawn.core = coreHeight;

      slab.clear();
      if (alpha <= 0.002 || halfLength <= 0) return;

      const segmentWidth = (halfLength * 2) / SEAM_SEGMENTS;
      for (let i = 0; i < SEAM_SEGMENTS; i += 1) {
        const t = (i + 0.5) / SEAM_SEGMENTS;
        const segmentAlpha = alpha * seamTaper(t);
        if (segmentAlpha <= 0.002) continue;
        const x = centreX - halfLength + i * segmentWidth;
        // The extra fraction of a pixel on the width overlaps neighbouring segments, so the row
        // reads as one continuous shape instead of showing hairline gaps between the rectangles.
        slab
          .rect(x, centreY - height / 2, segmentWidth + 0.75, height)
          .fill({ color: tint, alpha: segmentAlpha });
        slab
          .rect(x, centreY - coreHeight / 2, segmentWidth + 0.75, coreHeight)
          .fill({ color: 0xffffff, alpha: Math.min(1, segmentAlpha * 0.75) });
      }
    };

    /**
     * How much of the name has been wiped in, 0..1.
     *
     * It runs on `eventTime` — seconds since the alert began — and not on `phaseTime`, because the
     * wipe deliberately starts late (Reveal Delay) and outlives the opening. Defined here rather
     * than inside the frame callback so the closing wipe can consult the same number the opening
     * wipe draws with; see the use below.
     */
    const revealProgress = (): number =>
      easeOutQuart(clamp01((eventTime - revealDelay) / Math.max(0.01, revealSeconds)));

    onFrame(scope, ctx.fpsCap, ({ dt, now }) => {
      bus.sample(now);
      envelopes.update(dt);

      const width = Math.max(1, stage.width);
      const height = Math.max(1, stage.height);
      const centreX = width / 2;
      const centreY = height * seamY;

      // ── Demonstration events ────────────────────────────────────────────
      if (testPulse) {
        demoTimer += dt;
        if (demoTimer >= testPulseSeconds) {
          demoTimer = 0;
          const demo = DEMO_EVENTS[demoIndex % DEMO_EVENTS.length] ?? DEMO_EVENTS[0];
          demoIndex += 1;
          if (demo !== undefined) {
            enqueue({
              name: demo.name,
              detail: demo.detail,
              tint: tintFromChat ? hexToInt(demo.color, seamColor) : seamColor,
              raid: demo.raid,
            });
          }
        }
      }

      // ── The state machine ───────────────────────────────────────────────
      phaseTime += dt;
      if (phase !== "idle") eventTime += dt;
      settle *= Math.pow(0.0015, dt);

      switch (phase) {
        case "idle": {
          const next = queue.shift();
          if (next !== undefined) beginAlert(next);
          break;
        }
        case "opening":
          if (phaseTime >= openSeconds) {
            phase = "holding";
            phaseTime = 0;
            // The slab lands with a small dip and springs back. A transient in the audio at that
            // exact moment makes the landing a touch harder, which ties the alert to the room.
            settle = envelopes.beat ? 1 : 0.55;
          }
          break;
        case "holding":
          if (phaseTime >= holdSeconds) {
            phase = "closing";
            phaseTime = 0;
          }
          break;
        case "closing":
          if (phaseTime >= closeSeconds) endAlert();
          break;
      }

      // ── How far open the seam is, 0 (hairline) to 1 (full slab) ─────────
      const openFactor = openFactorFor(phase, phaseTime, openSeconds, closeSeconds);

      const tint = current?.tint ?? seamColor;
      const openedHeight = Math.max(
        seamThickness,
        seamThickness + (slabHeight - seamThickness) * openFactor - SETTLE_PX * settle,
      );
      // The seam also grows a little longer as it opens, which stops the opening reading as a
      // rectangle inflating in place.
      const halfLength = ((width * seamWidth) / 2) * (1 + 0.06 * clamp01(openFactor));
      const seamAlpha = idleOpacity + (SLAB_ALPHA - idleOpacity) * clamp01(openFactor);
      drawSeam(centreX, centreY, halfLength, openedHeight, seamAlpha, tint);

      // ── The spilled light ───────────────────────────────────────────────
      // Constant while opening and closing; during the hold it breathes with the streamer's own
      // audio, which is the point of the effect.
      const voice = phase === "holding" ? 1 + voiceSpill * envelopes.mid : 1;
      const spillAlpha = Math.min(1, spillStrength * clamp01(openFactor) * voice);
      spillLayer.visible = spillAlpha > 0.002 && spillHeight > 0;
      if (spillLayer.visible) {
        const spillWidth = halfLength * 2.4;
        spillBelow.position.set(centreX, centreY + openedHeight / 2);
        spillBelow.scale.set(spillWidth / SPILL_TEX_W, spillHeight / SPILL_TEX_H);
        spillAbove.position.set(centreX, centreY - openedHeight / 2);
        // A negative vertical scale flips the same picture, so one baked texture covers both sides.
        spillAbove.scale.set(spillWidth / SPILL_TEX_W, -spillHeight / SPILL_TEX_H);
        spillBelow.tint = tint;
        spillAbove.tint = tint;
        spillLayer.alpha = spillAlpha;
      }

      // ── The name and its wipe ───────────────────────────────────────────
      textLayer.visible = nameText !== null && detailText !== null;
      if (nameText !== null && detailText !== null) {
        // Measure at natural size first, then scale both lines down together if the name is wider
        // than the frame allows, so a fourteen-character name and a two-character one are laid out
        // by the same rule.
        nameText.scale.set(1);
        detailText.scale.set(1);
        const intrinsicWidth = Math.max(nameText.width, detailText.width, 1);
        const maxWidth = width * TEXT_MAX_WIDTH_FRACTION;
        const scale = Math.min(1, maxWidth / intrinsicWidth);
        nameText.scale.set(scale);
        detailText.scale.set(scale);

        const detailY = centreY + slabHeight / 2 + detailFontSize * DETAIL_GAP_FACTOR * scale;
        nameText.position.set(centreX, centreY);
        detailText.position.set(centreX, detailY);

        const blockWidth = intrinsicWidth * scale;
        const pad = nameFontSize * 0.4 * scale;
        const left = centreX - blockWidth / 2 - pad;
        const span = blockWidth + pad * 2;

        // The wipe. Opening and holding reveal from the left edge rightwards; closing keeps the
        // right edge still and sweeps the left edge across, so the name leaves the way it arrived
        // instead of rewinding.
        let maskX = left;
        let maskW = 0;
        if (phase === "closing") {
          /*
           * The mask's two edges are tracked separately: the left edge sweeps right on the closing
           * curve, while the right edge carries on revealing at its own pace. Their difference is
           * the visible width.
           *
           * Writing this as `span * (1 - gone)` — one edge moving under a rectangle assumed to be
           * full width — is the tempting version and it is wrong. It assumes the reveal had
           * finished, and the reveal is on a clock of its own: a long Reveal Delay or a long Reveal
           * Duration against a short Hold leaves it half done when closing starts, and the name
           * would then snap to full width on that frame before wiping out. Subtracting the real
           * progress collapses to exactly `span * (1 - gone)` once the reveal *has* finished, so
           * the ordinary case is unchanged.
           */
          const gone = easeInCubic(clamp01(phaseTime / Math.max(0.01, closeSeconds)));
          maskX = left + span * gone;
          maskW = Math.max(0, span * (revealProgress() - gone));
        } else if (phase !== "idle") {
          maskW = span * revealProgress();
        }

        const maskTop = centreY - slabHeight;
        const maskBottom = detailY + detailFontSize * 2 * scale;
        wipeMask.clear();
        if (maskW > 0.5) {
          wipeMask.rect(maskX, maskTop, maskW, maskBottom - maskTop).fill({ color: 0xffffff });
        }
      }

      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        triggerEvents = str(p, "triggerEvents", "subs and raids");
        openSeconds = num(p, "openSeconds", 0.48, 0.1, 3);
        holdSeconds = num(p, "holdSeconds", 2.5, 0.5, 20);
        closeSeconds = num(p, "closeSeconds", 0.32, 0.1, 3);
        revealDelay = num(p, "revealDelay", 0.14, 0, 1.5);
        revealSeconds = num(p, "revealSeconds", 0.52, 0.05, 4);
        slabHeight = num(p, "slabHeight", 96, 16, 400);
        seamWidth = num(p, "seamWidth", 0.4, 0.05, 1);
        seamY = num(p, "seamY", 0.42, 0, 1);
        seamThickness = num(p, "seamThickness", 2, 1, 12);
        idleOpacity = num(p, "idleOpacity", 0.2, 0, 1);
        spillHeight = num(p, "spillHeight", 220, 0, 800);
        spillStrength = num(p, "spillStrength", 0.55, 0, 1);
        voiceSpill = num(p, "voiceSpill", 0.6, 0, 2);
        textColor = colorHex(p, "textColor", "#f4f7ff");
        seamColor = colorInt(p, "seamColor", "#dfe9ff");
        tintFromChat = bool(p, "tintFromChat", true);
        maxQueue = int(p, "maxQueue", 4, 1, 20);
        testPulse = bool(p, "testPulse", true);
        testPulseSeconds = num(p, "testPulseSeconds", 6, 2, 120);
        nameFontSize = int(p, "nameFontSize", 54, 12, 160);
        detailFontSize = int(p, "detailFontSize", 15, 8, 60);
        fontFamily = str(
          p,
          "fontFamily",
          '"Inter", "Helvetica Neue", Helvetica, Arial, sans-serif',
        );

        // Type settings are re-applied to whatever is currently on screen rather than rebuilding
        // anything: the layout is recomputed from measured widths every frame, so a size change
        // during a live alert simply takes effect on the next one.
        if (nameText !== null) nameText.style = nameStyle();
        if (detailText !== null) detailText.style = detailStyle();

        // A shortened queue drops from the front, matching what enqueue does on overflow.
        if (queue.length > maxQueue) queue.splice(0, queue.length - maxQueue);
      },
    };
  },
});

export default arrivalSeam;
