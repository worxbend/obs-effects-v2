import * as PIXI from "pixi.js";

import { bool, colorInt, lerp, num, str } from "../paramUtils";
import {
  createEnvelopes,
  createPixiStage,
  defineEffect,
  onFrame,
  palette,
  paletteAtInt,
  paletteParam,
  useAudio,
  useFont,
} from "../sdk";

/**
 * Meridian Countdown
 * ==================
 *
 * One line of large, thin numerals counting down, a small kicker above them ("STARTING SOON"), a
 * hairline rule underneath, and a single thin arc behind everything that empties as the time runs
 * out. Nothing else. The air between the kicker and the numerals is doing as much work as the
 * numerals are, which is why it is generous and why nothing is allowed to fill it.
 *
 * The point of the piece is that it is *still*. Between digit changes the only thing moving in the
 * whole frame is the arc, creeping round by a fraction of a degree. When a digit does change, only
 * the digits that actually changed move — the colons never move at all, and the tens-of-minutes
 * digit sits perfectly still for ten minutes at a time.
 *
 * Four things in here are worth explaining before you read the code.
 *
 * Wall-clock time, which the SDK deliberately does not provide
 * -----------------------------------------------------------
 * `onFrame` hands every effect a `FrameInfo` with `dt` (seconds since the previous frame),
 * `elapsed` (seconds since this effect mounted) and `now` (`performance.now()`, a monotonic
 * millisecond counter that starts at an arbitrary point when the page loaded). None of those is
 * the time of day: `performance.now()` deliberately has no relationship to a calendar. So this
 * effect reads `Date.now()` — the ordinary wall clock, in milliseconds since 1970 — inside the
 * frame callback. That is the only place a countdown can get a real deadline from, and it is why
 * this is the first effect in the project to reach outside `FrameInfo` for its timing.
 *
 * Everything that *animates* still runs off `dt`, so a roll takes the same 420 ms on a 60 Hz
 * display as it does on a 144 Hz one.
 *
 * Tabular figures, built by hand
 * ------------------------------
 * "Tabular" means every digit occupies the same width, so a `1` takes as much room as an `8` and a
 * clock does not shuffle sideways every time a digit changes. Monospaced fonts are tabular; the
 * elegant thin grotesques this effect is designed around are not — in most of them a `1` is
 * noticeably narrower than a `0`.
 *
 * So the grid is measured rather than assumed. At layout time the code renders each of the ten
 * digits once into a throwaway `PIXI.Text`, takes the widest of the ten, and uses that single
 * number as the *advance* — the horizontal step from one slot to the next. Every digit is then
 * centred in its own fixed-width cell. The line cannot jitter, whatever the typeface.
 *
 * Letter-spacing ("tracking", in typographic language) is applied to that measured grid rather
 * than to the text style, for a practical reason: changing a `PIXI.Text` style forces Pixi to
 * redraw the glyph into a new GPU texture, and the urgency animation eases the tracking on every
 * single frame. Moving a container costs nothing; re-rasterising ten glyphs sixty times a second
 * costs a great deal.
 *
 * One rasterisation per digit change, and not one more
 * ---------------------------------------------------
 * Each digit slot owns two `PIXI.Text` objects — the one on screen and the one rolling in — and
 * the row as a whole is clipped by a band mask exactly one glyph-box tall. Assigning `.text` is
 * what re-rasterises, so it happens exactly once, at the instant a roll starts. In between, the
 * two texts are slid upward through the mask: the outgoing glyph leaves through the top while the
 * incoming one arrives from the bottom, on an ease-out-expo curve that covers most of the distance
 * immediately and then settles.
 *
 * The rolls are staggered by *hierarchy*, not by screen position: seconds move first, minutes a
 * beat later, hours a beat after that. So the once-a-minute change reads as a small cascade
 * running leftward rather than as several digits flipping at once.
 *
 * Urgency without alarm
 * ---------------------
 * In the last few seconds nothing flashes and nothing turns red. The tracking tightens so the
 * numerals draw together, the arc brightens, and the rule pulls in by a few per cent. Those three
 * changes all come off one eased number, and the whole effect is tension rather than warning.
 *
 * Transparency
 * ------------
 * Nothing here paints a background. The canvas is transparent, so this composites straight over a
 * game capture, a webcam or a solid colour source underneath it in OBS.
 */

/**
 * Where the arc starts, in the angle convention Pixi's `arc` uses: 0 points right (3 o'clock) and
 * angles increase clockwise, so a quarter turn back from there is 12 o'clock.
 */
const ARC_START_ANGLE = -Math.PI / 2;

/**
 * Opacity of the numerals themselves. Slightly under full white so they read as ink laid on the
 * scene rather than as a blown-out overlay — the same reason printed body copy is rarely pure
 * black.
 */
const NUMERAL_ALPHA = 0.92;

/** Opacity of the hairline rule under the numerals. Quiet enough to be structure, not decoration. */
const RULE_ALPHA = 0.22;

/** How far the rule pulls in at full urgency, as a fraction of its width. */
const URGENCY_RULE_SHORTENING = 0.08;

/** How much opacity the arc gains at full urgency, added to the Arc Opacity parameter. */
const URGENCY_ARC_LIFT = 0.4;

/**
 * The kicker's size, and the air below it, both as fractions of the numeral size.
 *
 * Deriving them means the composition survives a change to Numeral Size: at the default 200 px the
 * kicker is 10 px with 46 px of space under it, and at 120 px everything shrinks in proportion
 * instead of the kicker suddenly looking enormous.
 */
const KICKER_SIZE_RATIO = 0.05;
const KICKER_GAP_RATIO = 0.23;

/** Distance from the bottom of the numeral cell down to the rule, as a fraction of numeral size. */
const RULE_GAP_RATIO = 0.12;

/** Letter-spacing of the kicker, in em. Wide tracking is what makes small capitals legible. */
const KICKER_TRACKING_EM = 0.28;

/** Seconds of delay added per slot, right to left, when the digits empty out at zero. */
const EXIT_STAGGER_S = 0.055;

/** Seconds the completed arc holds as a full circle before it starts fading back. */
const ZERO_ARC_HOLD_S = 0.3;

/** Seconds the arc takes to fade from its live opacity down to {@link ZERO_ARC_ALPHA}. */
const ZERO_ARC_FADE_S = 0.6;

/** What the arc settles at once the countdown is over: still present, but clearly finished. */
const ZERO_ARC_ALPHA = 0.12;

/** Opacity of the "we are live" kicker after the cross-fade. Quieter than the countdown kicker. */
const ZERO_KICKER_ALPHA = 0.55;

/** Seconds the kicker cross-fade takes at zero. */
const ZERO_KICKER_FADE_S = 0.6;

/**
 * Nothing in the display may grow a third digit, because the number of characters is the number of
 * slots and the row is only rebuilt when a parameter changes. Hours and minutes are both capped
 * here.
 */
const MAX_TWO_DIGITS = 99;

/** How far the rule breathes with loudness at full Audio Reactivity: two per cent either way. */
const AUDIO_RULE_SWING = 0.04;

/** Milliseconds in a minute, spelled out so the arithmetic below reads as time rather than maths. */
const MS_PER_MINUTE = 60_000;

/**
 * Ease-out-expo: covers most of the distance in the first fifth of the duration and then glides in.
 *
 * This is the curve that makes a digit roll feel mechanical rather than floaty — the glyph appears
 * to be *placed* rather than to drift into position.
 */
function easeOutExpo(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return 1 - Math.pow(2, -10 * t);
}

/** Clamps to 0..1, turning a `NaN` into 0 rather than letting it poison a position. */
function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** A gentle S-curve, so the urgency changes ease in and out rather than starting with a jerk. */
function smoothstep(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/**
 * Turns the Font parameter's stored id into a CSS font stack.
 *
 * A `select` is used rather than a free-text family so the four faces the effect was designed
 * around — two of which ship with the application — can be named in plain language in the admin.
 * Every stack ends in a generic family, so an OBS machine missing a font still draws numerals.
 */
function fontStack(id: string): string {
  switch (id) {
    case "monospace":
      return '"Share Tech Mono", "Consolas", monospace';
    case "silkscreen":
      return "Silkscreen, monospace";
    case "bangers":
      return "Bangers, cursive";
    case "grotesque":
    default:
      return '"Inter", "Helvetica Neue", "Segoe UI", Arial, sans-serif';
  }
}

/**
 * Turns the Weight parameter's stored id into the value Pixi's text style wants.
 *
 * Pixi accepts weights as strings from a fixed list, so this is a lookup rather than a cast: a
 * stored value that is not on the list falls back to the default weight instead of reaching the
 * renderer as something it does not understand.
 */
function fontWeightOf(id: string): PIXI.TextStyleFontWeight {
  switch (id) {
    case "200":
      return "200";
    case "400":
      return "400";
    case "600":
      return "600";
    case "300":
    default:
      return "300";
  }
}

/**
 * Formats a remaining duration as a fixed-length glyph string.
 *
 * Fixed length is the whole point: the layout builds one slot per character, so a string that
 * changed length mid-countdown would mean rebuilding the row on air. Minutes are therefore capped
 * at {@link MAX_TWO_DIGITS} when the hours slot is hidden — a two-hour countdown with no hours
 * shown counts down from `99:59` rather than growing a third digit.
 *
 * Seconds are rounded *up*, which is what every countdown does: with 9.4 seconds left the display
 * reads `10`, and it reaches `00` at the moment the deadline passes rather than a second early.
 */
function formatRemaining(remainingMs: number, showHours: boolean): string {
  const total = Math.max(0, Math.ceil(remainingMs / 1000));
  const seconds = String(total % 60).padStart(2, "0");
  if (showHours) {
    const hours = String(Math.min(MAX_TWO_DIGITS, Math.floor(total / 3600))).padStart(2, "0");
    const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
    return `${hours}:${minutes}:${seconds}`;
  }
  const minutes = String(Math.min(MAX_TWO_DIGITS, Math.floor(total / 60))).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

/** Formats the wall clock itself, in the same fixed-length shape the countdown uses. */
function formatTimeOfDay(at: number, withSeconds: boolean): string {
  const date = new Date(at);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  if (!withSeconds) return `${hours}:${minutes}`;
  return `${hours}:${minutes}:${String(date.getSeconds()).padStart(2, "0")}`;
}

/**
 * The next moment the local clock reads `HH:MM`, strictly after `from`.
 *
 * The day is advanced with `setDate(getDate() + 1)` rather than by adding 24 hours in
 * milliseconds. On the two days a year that daylight saving shifts, a calendar day is 23 or 25
 * hours long, and adding a flat 86,400,000 ms would land the countdown an hour off.
 *
 * An unparseable value falls back to 8 pm, in keeping with every other reader in the project: a
 * bad stored value degrades to something sensible instead of throwing inside the frame loop.
 */
function nextOccurrence(hhmm: string, from: number): number {
  const match = /^\s*(\d{1,2})\s*:\s*(\d{1,2})\s*$/.exec(hhmm);
  const rawHours = match === null ? Number.NaN : Number(match[1]);
  const rawMinutes = match === null ? Number.NaN : Number(match[2]);
  const hours = Number.isFinite(rawHours) ? Math.min(23, Math.max(0, rawHours)) : 20;
  const minutes = Number.isFinite(rawMinutes) ? Math.min(59, Math.max(0, rawMinutes)) : 0;

  const today = new Date(from);
  today.setHours(hours, minutes, 0, 0);
  if (today.getTime() > from) return today.getTime();

  const tomorrow = new Date(from);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(hours, minutes, 0, 0);
  return tomorrow.getTime();
}

/** Everything the effect reads out of its parameters, gathered so `setParams` is one call. */
interface Settings {
  mode: string;
  targetTime: string;
  durationMinutes: number;
  showHours: boolean;
  label: string;
  zeroLabel: string;
  fontFamily: string;
  fontWeight: string;
  fontSize: number;
  tracking: number;
  urgencySeconds: number;
  urgencyTightening: number;
  rollMs: number;
  rollStaggerMs: number;
  showArc: boolean;
  arcRadius: number;
  arcWidth: number;
  arcOpacity: number;
  numeralColor: number;
  accentColor: number;
  opacity: number;
  anchorX: number;
  anchorY: number;
  audioReactivity: number;
}

/**
 * One character of the display.
 *
 * A digit slot owns two texts and can roll; a colon slot owns one and never moves. `target` is the
 * glyph the slot is heading towards, which is not the same as the glyph currently on screen while
 * a roll is in flight — comparing against `target` rather than against what is visible is what
 * stops a roll from being restarted on every frame for its whole duration.
 */
interface Slot {
  container: PIXI.Container;
  front: PIXI.Text;
  back: PIXI.Text | null;
  target: string;
  isDigit: boolean;
  /** Seconds of hierarchy stagger before this slot's roll begins. */
  delay: number;
  rolling: boolean;
  /** Seconds since the roll was requested, including the wait through `delay`. */
  t: number;
}

/** The measured grid, rebuilt whenever the typography or the number of characters changes. */
interface Layout {
  slots: Slot[];
  /** Width of the widest digit, in pixels: the horizontal step between digit slots. */
  digitAdvance: number;
  /** Width of a colon, which is narrower and gets its own step. */
  colonAdvance: number;
  /** Height of a glyph box: the roll distance, and the height of the clipping band. */
  cellHeight: number;
}

const meridianCountdown = defineEffect({
  descriptor: {
    id: "meridian-countdown",
    name: "Meridian Countdown",
    description:
      "A large, thin countdown on a hairline arc: only the digits that change move, the tracking tightens in the last seconds instead of turning red, and the whole line empties upward when it reaches zero.",
    engine: "pixi",
    category: "overlay",
    tags: ["countdown", "clock", "typography", "overlay", "starting-soon", "pixi"],
    previewNotes:
      "Transparent everywhere except the type and the arc, so it layers straight over a game capture, a webcam or a plain colour source. Designed for a 1920x1080 canvas: at that size the default 340 px arc sits just inside the top edge, so reduce Arc Radius (or move Vertical Position down) on a smaller source. In Duration mode the clock starts when the browser source loads the page and restarts whenever Mode, Target Time or Duration is changed — every other knob can be adjusted on air without disturbing it. Use Clock mode for a deadline that survives a page reload.",
    params: [
      {
        key: "mode",
        label: "Mode",
        kind: "select",
        default: "duration",
        options: ["duration", "clock", "time-of-day"],
        description:
          "duration counts down the length set below, starting when the effect appears. clock counts down to a time of day. time-of-day is not a countdown at all — it shows the current time, with the arc emptying once a minute.",
      },
      {
        key: "targetTime",
        label: "Target Time",
        kind: "text",
        default: "20:00",
        description:
          "Used by clock mode only. A 24-hour local time written as HH:MM. If that time has already gone by today, the countdown runs to the same time tomorrow.",
      },
      {
        key: "durationMinutes",
        label: "Duration (minutes)",
        kind: "number",
        default: 10,
        min: 0.5,
        max: 720,
        step: 0.5,
        description:
          "Used by duration mode only. How long the countdown runs for, measured from the moment the effect appears on screen.",
      },
      {
        key: "showHours",
        label: "Show Hours",
        kind: "boolean",
        default: false,
        description:
          "Adds an hours pair, so the line reads HH:MM:SS instead of MM:SS. In time-of-day mode this is what adds seconds to the clock.",
      },
      {
        key: "label",
        label: "Kicker",
        kind: "text",
        default: "STARTING SOON",
        description:
          "The small line of spaced capitals above the numerals. Leave it empty to remove the row and let the numerals stand alone.",
      },
      {
        key: "zeroLabel",
        label: "Zero Kicker",
        kind: "text",
        default: "WE ARE LIVE",
        description: "What the kicker cross-fades to once the countdown reaches zero.",
      },
      {
        key: "fontFamily",
        label: "Font",
        kind: "select",
        default: "grotesque",
        options: ["grotesque", "monospace", "silkscreen", "bangers"],
        description:
          "grotesque uses whatever clean sans-serif the machine has and monospace whatever fixed-width face it has; silkscreen and bangers are faces that ship with the application, so they look the same on every machine. Digit widths are measured whichever you pick, so the line never jitters.",
      },
      {
        key: "fontWeight",
        label: "Weight",
        kind: "select",
        default: "300",
        options: ["200", "300", "400", "600"],
        description:
          "How heavy the numerals are. The thin weights are the expensive-looking ones; the heavier ones survive a busy scene behind them better.",
      },
      {
        key: "fontSize",
        label: "Numeral Size",
        kind: "number",
        default: 200,
        min: 40,
        max: 400,
        step: 2,
        description:
          "Height of the numerals in pixels. The kicker, the air above the numerals and the rule below them are all sized from this, so the composition holds together at any value.",
      },
      {
        key: "tracking",
        label: "Tracking",
        kind: "number",
        default: -0.015,
        min: -0.08,
        max: 0.1,
        step: 0.005,
        description:
          "Space between numerals, in em (a fraction of the numeral size). Slightly negative draws large type together, which is how large numerals are normally set.",
      },
      {
        key: "urgencySeconds",
        label: "Urgency Window",
        kind: "number",
        default: 10,
        min: 0,
        max: 120,
        step: 1,
        description:
          "How many seconds before zero the tracking starts tightening and the arc starts brightening. 0 turns the whole urgency behaviour off.",
      },
      {
        key: "urgencyTightening",
        label: "Urgency Tightening",
        kind: "number",
        default: 0.025,
        min: 0,
        max: 0.08,
        step: 0.005,
        description:
          "How much tighter the tracking gets by the time it reaches zero, in em. This is the whole urgency signal — nothing flashes and nothing turns red.",
      },
      {
        key: "rollMs",
        label: "Roll Duration",
        kind: "number",
        default: 420,
        min: 80,
        max: 1200,
        step: 10,
        description: "How long one digit takes to roll from the old value to the new, in ms.",
      },
      {
        key: "rollStaggerMs",
        label: "Roll Stagger",
        kind: "number",
        default: 45,
        min: 0,
        max: 300,
        step: 5,
        description:
          "Delay added per step up the hierarchy, in ms: seconds roll first, minutes this much later, hours later again. 0 makes every digit flip at once.",
      },
      {
        key: "showArc",
        label: "Show Arc",
        kind: "boolean",
        default: true,
        description:
          "The hairline ring behind the numerals that empties as the time runs out. It is the only thing in the frame that moves between digit changes.",
      },
      {
        key: "arcRadius",
        label: "Arc Radius",
        kind: "number",
        default: 340,
        min: 60,
        max: 1200,
        step: 10,
        description:
          "Radius of the ring in pixels, measured from the centre of the numerals. Reduce it on a canvas smaller than 1080p, or the top of the ring runs off the frame.",
      },
      {
        key: "arcWidth",
        label: "Arc Width",
        kind: "number",
        default: 1.5,
        min: 0.5,
        max: 12,
        step: 0.5,
        description: "Thickness of the ring in pixels. A hairline is the intent.",
      },
      {
        key: "arcOpacity",
        label: "Arc Opacity",
        kind: "number",
        default: 0.3,
        min: 0,
        max: 1,
        step: 0.02,
        description:
          "How visible the ring is for most of the countdown. It lifts on its own inside the urgency window.",
      },
      paletteParam(
        "palette",
        "Palette",
        "monochrome",
        "Colour ramp for the numerals and the rule, which take the very top of the ramp. Monochrome keeps them near-white, which is what the design assumes.",
      ),
      {
        key: "accentColor",
        label: "Accent Colour",
        kind: "color",
        default: "#8fb8c9",
        description:
          "The single accent, used on the kicker and the arc and nowhere else. Restraint is the point: two places, one colour.",
      },
      {
        key: "opacity",
        label: "Opacity",
        kind: "number",
        default: 1,
        min: 0,
        max: 1,
        step: 0.02,
        description: "Master opacity for the whole composition.",
      },
      {
        key: "anchorX",
        label: "Horizontal Position",
        kind: "number",
        default: 0.5,
        min: 0,
        max: 1,
        step: 0.01,
        description:
          "Where the centre of the numerals sits across the frame, as a fraction of its width. 0.5 is dead centre.",
      },
      {
        key: "anchorY",
        label: "Vertical Position",
        kind: "number",
        default: 0.33,
        min: 0,
        max: 1,
        step: 0.01,
        description:
          "Where the centre of the numerals sits down the frame, as a fraction of its height. 0.33 is the upper third line.",
      },
      {
        key: "audioReactivity",
        label: "Audio Reactivity",
        kind: "number",
        default: 0,
        min: 0,
        max: 1,
        step: 0.05,
        description:
          "How much the rule under the numerals breathes with the loudness of your audio — at most two per cent of its width, and nothing else in the frame responds. 0 leaves it completely still, which is the default.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    /*
     * Audio is acquired even though Audio Reactivity defaults to 0.
     *
     * The alternative — acquiring it only when the parameter is non-zero — would leave the slider
     * dead until the effect was remounted, because the connection cannot be opened from inside
     * `setParams`. The feed is a shared, page-wide resource that other effects are probably using
     * anyway, and reading a number off it costs nothing, so the honest slider wins. `useAudio`
     * never rejects: with no OBS connection it produces a simulated signal instead.
     */
    const bus = await useAudio(scope);
    scope.checkpoint();
    const envelopes = createEnvelopes(bus);

    const read = (p: Record<string, unknown>): Settings => ({
      mode: str(p, "mode", "duration"),
      targetTime: str(p, "targetTime", "20:00"),
      durationMinutes: num(p, "durationMinutes", 10, 0.5, 720),
      showHours: bool(p, "showHours", false),
      // The two kicker strings are read with a *space* as their fallback rather than with their
      // descriptor default, which looks wrong and is deliberate. `str` treats an empty string as a
      // missing value and substitutes the fallback, so passing the real default here would make an
      // emptied field spring back to "STARTING SOON" and the row could never be hidden. The
      // renderer always hands `setParams` the descriptor default when a route has stored nothing at
      // all, so this fallback can only be reached by a field the operator actually cleared — and
      // trimming a lone space back to "" is what then hides the row.
      label: str(p, "label", " ").trim(),
      zeroLabel: str(p, "zeroLabel", " ").trim(),
      fontFamily: str(p, "fontFamily", "grotesque"),
      fontWeight: str(p, "fontWeight", "300"),
      fontSize: num(p, "fontSize", 200, 40, 400),
      tracking: num(p, "tracking", -0.015, -0.08, 0.1),
      urgencySeconds: num(p, "urgencySeconds", 10, 0, 120),
      urgencyTightening: num(p, "urgencyTightening", 0.025, 0, 0.08),
      rollMs: num(p, "rollMs", 420, 80, 1200),
      rollStaggerMs: num(p, "rollStaggerMs", 45, 0, 300),
      showArc: bool(p, "showArc", true),
      arcRadius: num(p, "arcRadius", 340, 60, 1200),
      arcWidth: num(p, "arcWidth", 1.5, 0.5, 12),
      arcOpacity: num(p, "arcOpacity", 0.3, 0, 1),
      numeralColor: paletteAtInt(palette(p, "palette", "monochrome"), 1),
      accentColor: colorInt(p, "accentColor", "#8fb8c9"),
      opacity: num(p, "opacity", 1, 0, 1),
      anchorX: num(p, "anchorX", 0.5, 0, 1),
      anchorY: num(p, "anchorY", 0.33, 0, 1),
      audioReactivity: num(p, "audioReactivity", 0, 0, 1),
    });

    let settings = read(ctx.params);

    /**
     * The current numerals written as a CSS `font` shorthand, which is the only form
     * `document.fonts.load` accepts.
     *
     * The weight goes through {@link fontWeightOf} rather than being interpolated raw: a route with
     * a hand-edited `fontWeight` of, say, `"bold-ish"` would otherwise produce a malformed shorthand
     * that the font loading API rejects, and the wait for the face would be silently skipped.
     */
    const fontShorthand = (): string =>
      `${fontWeightOf(settings.fontWeight)} ${Math.round(settings.fontSize)}px ${fontStack(
        settings.fontFamily,
      )}`;

    /*
     * Wait for the face before anything is measured.
     *
     * The digit grid is built from measured glyph widths, so measuring against a substituted font
     * produces a grid at the wrong pitch which then visibly re-flows the moment the real font
     * arrives — on air, in the first second of a scene. `useFont` never rejects and gives up after
     * two seconds, and it does not checkpoint for us, hence the line after it.
     */
    await useFont(fontShorthand());
    scope.checkpoint();

    const stage = await createPixiStage(scope, ctx, { antialias: true });

    /*
     * The scene graph, in painting order.
     *
     * Everything hangs off one root container, so the Opacity parameter is a single number on a
     * single object rather than a value that has to be multiplied into every draw call.
     *
     * `numeralsMask` is a plain horizontal band. The design calls for a mask per digit cell; the
     * visible result is identical here because the cells differ only horizontally and no glyph
     * ever moves sideways, so one band across the row clips the rolling digits at exactly the top
     * and bottom edges per-cell masks would. One Graphics is also easier to keep in step than
     * eight. A mask has to be in the scene graph to take effect, which is why it is added as a
     * child rather than kept off to the side.
     */
    const root = stage.stage.addChild(new PIXI.Container());
    const chrome = root.addChild(new PIXI.Graphics());
    const numerals = root.addChild(new PIXI.Container());
    const numeralsMask = root.addChild(new PIXI.Graphics());
    numerals.mask = numeralsMask;
    numerals.alpha = NUMERAL_ALPHA;

    /** The size the kicker is drawn at, derived from the numeral size. See KICKER_SIZE_RATIO. */
    const kickerSize = (): number => Math.max(6, settings.fontSize * KICKER_SIZE_RATIO);

    /**
     * Pushes the current typography onto a kicker text.
     *
     * Styles are objects on the live display object, so they are changed in place: Pixi marks the
     * text dirty and redraws it on the next frame, which is one redraw rather than a new object
     * and a new texture.
     */
    const applyKickerStyle = (text: PIXI.Text): void => {
      const size = kickerSize();
      text.style.fontFamily = fontStack(settings.fontFamily);
      text.style.fontSize = size;
      text.style.fontWeight = "700";
      text.style.fill = settings.accentColor;
      text.style.letterSpacing = size * KICKER_TRACKING_EM;
    };

    /*
     * Two kicker texts rather than one, because zero is a cross-fade: the countdown kicker fades
     * out while the zero kicker fades in, in the same place. A single text swapped at the halfway
     * point would blink.
     *
     * A `PIXI.Text` is backed by a GPU texture of its rendered glyphs, so each one is registered on
     * the scope rather than left to chance. `destroy(true)` is Pixi 8's shorthand for "destroy the
     * text's `TextStyle` as well" — the glyph texture itself is handed back to the renderer's pool
     * by `destroy` either way. A `TextStyle` left behind is a small leak, and a small leak only
     * shows up after a few hundred remounts, which on a broadcast machine is a normal evening.
     */
    const kickerLabel = scope.own(root.addChild(new PIXI.Text({ text: settings.label })), (t) =>
      t.destroy(true),
    );
    const kickerZero = scope.own(root.addChild(new PIXI.Text({ text: settings.zeroLabel })), (t) =>
      t.destroy(true),
    );
    kickerLabel.anchor.set(0.5, 0.5);
    kickerZero.anchor.set(0.5, 0.5);
    kickerZero.alpha = 0;
    applyKickerStyle(kickerLabel);
    applyKickerStyle(kickerZero);

    /** The style every numeral is built with. Read fresh from `settings` on each layout. */
    const numeralStyle = (): PIXI.TextStyleOptions => ({
      fontFamily: fontStack(settings.fontFamily),
      fontSize: settings.fontSize,
      fontWeight: fontWeightOf(settings.fontWeight),
      fill: settings.numeralColor,
    });

    /**
     * The current grid.
     *
     * It is replaced rather than mutated whenever the typography or the character count changes,
     * so it cannot be handed to the scope at construction: that would register a teardown for the
     * *first* layout and never for its replacements. One deferred teardown that reads the live
     * variable always destroys whichever layout is current when the effect goes away, and
     * `buildLayout` destroys the one it is replacing.
     */
    let layout: Layout | null = null;

    const destroyLayout = (): void => {
      if (layout === null) return;
      for (const slot of layout.slots) {
        slot.front.destroy(true);
        slot.back?.destroy(true);
        slot.container.destroy();
      }
      numerals.removeChildren();
      layout = null;
    };

    scope.defer(destroyLayout);

    /**
     * Measures a glyph by rendering it once into a throwaway text and reading its bounds.
     *
     * This is the only way to learn how wide a `1` is in the chosen face. The probe is destroyed
     * immediately — it exists for the length of two property reads.
     */
    const measure = (glyph: string): { width: number; height: number } => {
      const probe = new PIXI.Text({ text: glyph, style: numeralStyle() });
      const size = { width: probe.width, height: probe.height };
      probe.destroy(true);
      return size;
    };

    /**
     * Counts the colons to the right of a position in the string.
     *
     * That count *is* the hierarchy step: nothing to the right of the seconds pair, one colon to
     * the right of the minutes pair, two to the right of the hours pair. Counting colons rather
     * than characters keeps it correct whether the string is `MM:SS` or `HH:MM:SS`.
     */
    const colonsAfter = (text: string, index: number): number => {
      let count = 0;
      for (let i = index + 1; i < text.length; i += 1) {
        if (text[i] === ":") count += 1;
      }
      return count;
    };

    /**
     * Measures the grid the current typography implies: the widest of the ten digits, the width of
     * a colon, and the height of a glyph box.
     *
     * Split out of {@link buildLayout} because it is also the cheap way to ask "has the face I am
     * drawing with actually changed?" without throwing away and rebuilding every glyph on screen.
     */
    const measureGrid = (): Omit<Layout, "slots"> => {
      let digitAdvance = 1;
      let cellHeight = 1;
      for (let digit = 0; digit <= 9; digit += 1) {
        const size = measure(String(digit));
        digitAdvance = Math.max(digitAdvance, size.width);
        cellHeight = Math.max(cellHeight, size.height);
      }
      return { digitAdvance, colonAdvance: Math.max(1, measure(":").width), cellHeight };
    };

    /**
     * Builds the row of slots for a glyph string and the current typography.
     *
     * The horizontal grid is the widest of the ten digits, so `11:11` and `88:88` occupy exactly
     * the same width and the line cannot shuffle sideways. Vertical and horizontal *placement* is
     * not computed here at all — it depends on the canvas size, which is read fresh every frame,
     * which is why a resize needs no rebuild.
     */
    const buildLayout = (text: string): void => {
      destroyLayout();

      const { digitAdvance, colonAdvance, cellHeight } = measureGrid();

      const slots: Slot[] = [];
      const staggerSeconds = settings.rollStaggerMs / 1000;

      for (let i = 0; i < text.length; i += 1) {
        const glyph = text[i] ?? "0";
        const isDigit = glyph !== ":";
        const container = numerals.addChild(new PIXI.Container());

        const front = container.addChild(new PIXI.Text({ text: glyph, style: numeralStyle() }));
        front.anchor.set(0.5, 0.5);

        // Only digits ever roll, so only digits need a second text. A colon with no spare text is
        // one less GPU texture to keep alive for the length of a broadcast.
        let back: PIXI.Text | null = null;
        if (isDigit) {
          back = container.addChild(new PIXI.Text({ text: glyph, style: numeralStyle() }));
          back.anchor.set(0.5, 0.5);
          back.visible = false;
        }

        slots.push({
          container,
          front,
          back,
          target: glyph,
          isDigit,
          delay: colonsAfter(text, i) * staggerSeconds,
          rolling: false,
          t: 0,
        });
      }

      layout = { slots, digitAdvance, colonAdvance, cellHeight };
    };

    /** Finishes a roll: the incoming glyph becomes the visible one, and the pair swaps roles. */
    const finishRoll = (slot: Slot): void => {
      if (!slot.rolling || slot.back === null) return;
      const outgoing = slot.front;
      slot.front = slot.back;
      slot.back = outgoing;
      slot.front.y = 0;
      slot.front.visible = true;
      slot.back.visible = false;
      slot.rolling = false;
    };

    /**
     * Puts every slot back to its resting state after an exit, so a restart starts from clean.
     *
     * Landing an in-flight roll first is not tidiness, it is a correctness fix. The countdown
     * reaches zero *while the seconds pair is still rolling* — that is the normal case, not a rare
     * one — so at that moment `front` is showing the old glyph and `target` already holds the new
     * one. Dropping the roll without landing it would leave the two disagreeing, and because every
     * later frame compares the wanted glyph against `target` rather than against what is on screen,
     * the stale glyph would never be corrected: a restarted countdown could sit there displaying a
     * `1` where a `0` belongs until that slot happened to change again.
     */
    const resetSlots = (): void => {
      if (layout === null) return;
      for (const slot of layout.slots) {
        finishRoll(slot);
        if (slot.front.text !== slot.target) slot.front.text = slot.target;
        slot.front.y = 0;
        slot.front.alpha = 1;
        slot.rolling = false;
        if (slot.back !== null) {
          slot.back.visible = false;
          slot.back.y = 0;
        }
      }
    };

    /**
     * Starts a roll to `glyph`.
     *
     * This is the only place `.text` is ever assigned, and it happens once per digit change. Each
     * assignment redraws the glyph into a new GPU texture; doing it per frame instead would mean
     * re-rasterising the whole line sixty times a second to show the same numbers.
     */
    const startRoll = (slot: Slot, glyph: string): void => {
      if (slot.back === null) {
        slot.front.text = glyph;
        slot.target = glyph;
        return;
      }
      // A change arriving mid-roll: land the roll in flight first, so the glyph it was carrying is
      // the one that leaves rather than being discarded halfway up the cell.
      if (slot.rolling) finishRoll(slot);

      slot.back.text = glyph;
      slot.back.visible = true;
      slot.front.y = 0;
      slot.target = glyph;
      slot.rolling = true;
      slot.t = 0;
    };

    /**
     * Seconds since the countdown hit zero, or -1 while it is still running.
     *
     * One number drives the whole exit: the digits emptying upward, the arc closing and fading,
     * and the kicker cross-fade all read their progress off it.
     */
    let exitT = -1;

    /**
     * The whole second the display was last built for, or `NaN` for "nothing has been built yet".
     *
     * The glyph string can only change on a second boundary, so it is formatted once a second
     * rather than once a frame. `NaN` compares unequal to everything including itself, which is
     * exactly the "rebuild on the next frame whatever the clock says" behaviour a restart wants.
     */
    let lastTick = Number.NaN;

    /*
     * The countdown's two fixed points, both in wall-clock milliseconds. They are recomputed only
     * when a parameter that defines them changes — never on an unrelated save, which would restart
     * the countdown while it was on air.
     */
    let startAt = Date.now();
    let targetAt = startAt + settings.durationMinutes * MS_PER_MINUTE;

    const restartTiming = (): void => {
      startAt = Date.now();
      targetAt =
        settings.mode === "clock"
          ? nextOccurrence(settings.targetTime, startAt)
          : startAt + settings.durationMinutes * MS_PER_MINUTE;
      exitT = -1;
      lastTick = Number.NaN;
      resetSlots();
    };

    /** The glyph string the display should show right now, for either kind of clock. */
    const wantedText = (at: number): string =>
      settings.mode === "time-of-day"
        ? formatTimeOfDay(at, settings.showHours)
        : formatRemaining(Math.max(0, targetAt - at), settings.showHours);

    const timingKey = (s: Settings): string => [s.mode, s.targetTime, s.durationMinutes].join("|");
    let lastTimingKey = timingKey(settings);

    const layoutKey = (s: Settings): string =>
      [s.fontFamily, s.fontWeight, s.fontSize, s.showHours, s.mode].join("|");
    let lastLayoutKey = layoutKey(settings);

    /**
     * Counts rebuilds, so a font that finishes loading late can tell whether its measurement is
     * still the one being waited for.
     */
    let layoutGeneration = 0;

    /**
     * Rebuilds the grid now, and — only if it turns out to have been measured against the wrong
     * face — a second time once the right one has loaded.
     *
     * `setup` can wait for the face before it measures anything, because it is allowed to be
     * asynchronous. `setParams` is not: it is a synchronous call on a running effect. So the first
     * time an operator picks Silkscreen or Bangers in the admin, the ten digit measurements may be
     * taken against whatever the browser substituted while the file was still downloading, giving
     * a grid at the wrong pitch that would stay wrong until the next remount.
     *
     * Waiting and re-measuring fixes that. The second rebuild is skipped when the widths did not
     * actually move, which is the ordinary case: a face that is already in the browser's cache
     * resolves immediately and measures identically, so nothing is thrown away.
     */
    const rebuildLayout = (): void => {
      layoutGeneration += 1;
      const generation = layoutGeneration;
      buildLayout(wantedText(Date.now()));
      lastTick = Number.NaN;

      void useFont(fontShorthand()).then(() => {
        // The effect is gone, or a newer rebuild has already superseded this one: either way this
        // measurement is stale and applying it would fight whatever is on screen now.
        if (scope.disposed || generation !== layoutGeneration || layout === null) return;
        // Half a pixel of tolerance: sub-pixel measurement noise is not a font change.
        if (Math.abs(measureGrid().digitAdvance - layout.digitAdvance) < 0.5) return;
        layoutGeneration += 1;
        buildLayout(wantedText(Date.now()));
        lastTick = Number.NaN;
      });
    };

    restartTiming();
    buildLayout(wantedText(Date.now()));

    /*
     * What the clipping band was last drawn for. `NaN` compares unequal to everything, so the first
     * frame always draws it. See the rebuild check in the frame callback.
     */
    let maskTop = Number.NaN;
    let maskHeight = Number.NaN;
    let maskWidth = Number.NaN;

    onFrame(scope, ctx.fpsCap, ({ dt, now }) => {
      // Sample first, then advance the envelopes: they smooth whatever the bus last read, so
      // updating them before sampling would leave them a frame behind.
      bus.sample(now);
      envelopes.update(dt);

      const grid = layout;
      if (grid === null) return;

      const wallNow = Date.now();
      const rollSeconds = Math.max(0.01, settings.rollMs / 1000);
      const isCountdown = settings.mode !== "time-of-day";
      const remainingMs = Math.max(0, targetAt - wallNow);

      // ── Urgency: one eased number driving three quiet changes ───────────
      const secondsLeft = remainingMs / 1000;
      const urgency =
        isCountdown && settings.urgencySeconds > 0
          ? smoothstep((settings.urgencySeconds - secondsLeft) / settings.urgencySeconds)
          : 0;

      // ── Roll any digit whose value has moved ────────────────────────────
      if (exitT < 0) {
        /*
         * The glyph string can only change on a whole-second boundary, so it is formatted once a
         * second rather than once a frame. `formatRemaining` builds four short-lived strings every
         * time it runs, and doing that sixty times a second to produce the very same characters is
         * pure garbage for the collector to sweep up — for no visible difference at all.
         */
        const tick = isCountdown ? Math.ceil(remainingMs / 1000) : Math.floor(wallNow / 1000);
        if (tick !== lastTick) {
          lastTick = tick;
          const wanted = wantedText(wallNow);
          for (let i = 0; i < grid.slots.length; i += 1) {
            const slot = grid.slots[i];
            if (slot === undefined) continue;
            const glyph = wanted[i] ?? slot.target;
            if (glyph !== slot.target) startRoll(slot, glyph);
          }
        }

        // Zero is a one-shot: the moment the deadline passes the exit takes over, and the digits
        // stop tracking the clock entirely.
        if (isCountdown && remainingMs <= 0) exitT = 0;
      } else {
        exitT += dt;
      }

      // ── Geometry, recomputed from the live canvas size ──────────────────
      const centreX = settings.anchorX * stage.width;
      const centreY = settings.anchorY * stage.height;

      // Tracking is applied to the measured grid, not to the text style, so the urgency easing
      // costs one container move per slot rather than re-rasterising every glyph.
      const trackingPx =
        (settings.tracking - settings.urgencyTightening * urgency) * settings.fontSize;
      const advanceOf = (slot: Slot): number =>
        Math.max(1, (slot.isDigit ? grid.digitAdvance : grid.colonAdvance) + trackingPx);

      let blockWidth = 0;
      for (const slot of grid.slots) blockWidth += advanceOf(slot);

      let penX = centreX - blockWidth / 2;
      for (const slot of grid.slots) {
        const advance = advanceOf(slot);
        slot.container.position.set(penX + advance / 2, centreY);
        penX += advance;
      }

      /*
       * The clipping band.
       *
       * Only the top and bottom edges do any work — nothing ever moves sideways out of a cell — so
       * the rectangle is drawn three canvases wide and offset one canvas to the left. That costs
       * nothing and means the band cannot clip the row from the side at an extreme Horizontal
       * Position, where the line reaches past the edge of the frame.
       *
       * It is rebuilt only when one of the three numbers that define it actually moves, rather than
       * every frame. Redrawing a `Graphics` re-uploads its geometry, and a mask's geometry is
       * re-uploaded into the stencil buffer as well, so this is the one shape in the effect worth
       * holding on to: it changes when the canvas is resized, when Numeral Size is changed, or when
       * Vertical Position is dragged, and at no other time.
       */
      const bandTop = centreY - grid.cellHeight / 2;
      if (bandTop !== maskTop || grid.cellHeight !== maskHeight || stage.width !== maskWidth) {
        maskTop = bandTop;
        maskHeight = grid.cellHeight;
        maskWidth = stage.width;
        numeralsMask.clear();
        numeralsMask
          .rect(-maskWidth, bandTop, maskWidth * 3, grid.cellHeight)
          .fill({ color: 0xffffff });
      }

      // ── Advance the rolls ───────────────────────────────────────────────
      for (const slot of grid.slots) {
        if (!slot.rolling || slot.back === null) continue;
        slot.t += dt;
        const progress = (slot.t - slot.delay) / rollSeconds;
        const eased = easeOutExpo(clamp01(progress));
        // The outgoing glyph leaves through the top of the band while the incoming one comes up
        // from below it, both clipped by the mask so only a cell's worth of each is ever seen.
        slot.front.y = -eased * grid.cellHeight;
        slot.back.y = (1 - eased) * grid.cellHeight;
        if (progress >= 1) finishRoll(slot);
      }

      // ── The exit, if the countdown is over ──────────────────────────────
      if (exitT >= 0) {
        const lastIndex = grid.slots.length - 1;
        for (let i = 0; i <= lastIndex; i += 1) {
          const slot = grid.slots[i];
          if (slot === undefined) continue;
          // Right to left, so the seconds empty first and the eye follows the cascade back to the
          // start of the line.
          const eased = easeOutExpo(
            clamp01((exitT - (lastIndex - i) * EXIT_STAGGER_S) / rollSeconds),
          );
          if (slot.isDigit) {
            slot.front.y = -eased * grid.cellHeight;
            if (slot.back !== null) slot.back.visible = false;
          } else {
            // Colons never move, so they leave by fading. A colon left hanging on its own once the
            // digits have gone reads as a mistake rather than as a design.
            slot.front.alpha = 1 - eased;
          }
        }

        const fade = clamp01(exitT / ZERO_KICKER_FADE_S);
        kickerLabel.alpha = 1 - fade;
        kickerZero.alpha = fade * ZERO_KICKER_ALPHA;
      } else {
        kickerLabel.alpha = 1;
        kickerZero.alpha = 0;
      }

      kickerLabel.visible = settings.label !== "";
      kickerZero.visible = settings.zeroLabel !== "";

      // ── Kicker placement ────────────────────────────────────────────────
      const kickerY =
        centreY -
        grid.cellHeight / 2 -
        settings.fontSize * KICKER_GAP_RATIO -
        kickerLabel.height / 2;
      kickerLabel.position.set(centreX, kickerY);
      kickerZero.position.set(centreX, kickerY);

      // ── The arc and the rule ────────────────────────────────────────────
      chrome.clear();

      /*
       * How full the arc is.
       *
       * A countdown empties over its whole span, so a ten-minute countdown's ring is a ten-minute
       * clock face. Time-of-day mode has no span to deplete, so its ring empties once per minute,
       * which gives the composition the same slow continuous motion.
       */
      let sweepFraction = isCountdown
        ? clamp01(remainingMs / Math.max(1, targetAt - startAt))
        : 1 - (wallNow % MS_PER_MINUTE) / MS_PER_MINUTE;

      let arcAlpha = lerp(
        settings.arcOpacity,
        Math.min(1, settings.arcOpacity + URGENCY_ARC_LIFT),
        urgency,
      );

      if (exitT >= 0) {
        // At zero the ring closes into a full circle rather than vanishing — the countdown finishes
        // its sentence — holds there, and then settles back to a faint complete ring.
        sweepFraction = easeOutExpo(clamp01(exitT / rollSeconds));
        const fade = clamp01((exitT - (rollSeconds + ZERO_ARC_HOLD_S)) / ZERO_ARC_FADE_S);
        arcAlpha = lerp(arcAlpha, ZERO_ARC_ALPHA, fade);
      }

      if (settings.showArc && sweepFraction > 0.001 && arcAlpha > 0.001) {
        chrome
          .arc(
            centreX,
            centreY,
            settings.arcRadius,
            ARC_START_ANGLE,
            ARC_START_ANGLE + sweepFraction * Math.PI * 2,
          )
          .stroke({
            color: settings.accentColor,
            width: settings.arcWidth,
            alpha: arcAlpha,
            cap: "round",
          });
      }

      /*
       * The rule spans the numerals' optical width. Two things move it: urgency pulls it in by a
       * few per cent, and — only if the operator asked for it — the slow loudness envelope breathes
       * it by at most two per cent either way. `envelopes.slow` sits near the middle of its range
       * on ordinary speech, so subtracting a half makes quiet pull the rule in and loud push it out.
       */
      const breathe = 1 + (envelopes.slow - 0.5) * AUDIO_RULE_SWING * settings.audioReactivity;
      const ruleWidth = blockWidth * (1 - URGENCY_RULE_SHORTENING * urgency) * breathe;
      const ruleY = centreY + grid.cellHeight / 2 + settings.fontSize * RULE_GAP_RATIO;
      chrome
        .moveTo(centreX - ruleWidth / 2, ruleY)
        .lineTo(centreX + ruleWidth / 2, ruleY)
        .stroke({ color: settings.numeralColor, width: 1, alpha: RULE_ALPHA });

      root.alpha = settings.opacity;

      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        settings = read(p);

        // Timing first: a change to the mode, the target or the duration means a different
        // deadline, so the countdown starts again from now. Everything else — a colour, the arc
        // width, the tracking — leaves the running clock alone, which matters because the operator
        // may be adjusting the look while the countdown is on air.
        const nextTiming = timingKey(settings);
        if (nextTiming !== lastTimingKey) {
          lastTimingKey = nextTiming;
          restartTiming();
        }

        // The kicker texts are anchored at their own centre, so changing the words needs no
        // re-measure and no relayout — only the one `.text` assignment that redraws them.
        kickerLabel.text = settings.label;
        kickerZero.text = settings.zeroLabel;
        applyKickerStyle(kickerLabel);
        applyKickerStyle(kickerZero);

        /*
         * The numeral grid is measured from the typeface, so only a typographic change or a change
         * in the number of characters can invalidate it. Rebuilding is expensive — ten throwaway
         * measurements plus a new GPU texture per glyph — and `setParams` fires with unchanged
         * values often, so it happens behind a dirty check.
         */
        const nextLayout = layoutKey(settings);
        if (nextLayout !== lastLayoutKey) {
          lastLayoutKey = nextLayout;
          rebuildLayout();
          return;
        }

        if (layout === null) return;

        // No rebuild, so push the colour straight onto the live texts. Changing a style marks the
        // text dirty and Pixi redraws it on the next frame, which is one redraw rather than a new
        // object.
        for (const slot of layout.slots) {
          slot.front.style.fill = settings.numeralColor;
          if (slot.back !== null) slot.back.style.fill = settings.numeralColor;
        }

        // The hierarchy stagger is stored per slot at layout time, so a change to it has to be
        // pushed out to the slots that already exist. Same rule as `colonsAfter`, walked from the
        // right: every colon passed is one step further up the hierarchy.
        const staggerSeconds = settings.rollStaggerMs / 1000;
        let colonsRight = 0;
        for (let i = layout.slots.length - 1; i >= 0; i -= 1) {
          const slot = layout.slots[i];
          if (slot === undefined) continue;
          slot.delay = colonsRight * staggerSeconds;
          if (!slot.isDigit) colonsRight += 1;
        }
      },
    };
  },
});

export default meridianCountdown;
