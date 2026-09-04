import * as PIXI from "pixi.js";

import { bool, colorHex, int, lerp, num, str } from "../paramUtils";
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
import type { ChatMessage } from "~/types/contract";

/**
 * Emote Standings
 * ===============
 *
 * A live league table of the emotes chat is actually using. Every emote (and every Unicode emoji,
 * which the chat SDK turns into an image too) that goes past scores a point; the points fade with
 * time; the emotes with the most points right now are listed in order, biggest first. When one
 * emote overtakes another, the two rows slide past each other so the change of position reads as an
 * *event* rather than as a redraw. That overtake is the whole point of the effect — it is what turns
 * "chat said some things" into "chat has decided, together, to spam one emote".
 *
 * Every other chat effect in this repository draws individual messages. This one draws the *shape*
 * of the conversation instead, which is why it can sit in a corner for a whole broadcast without
 * ever repeating itself or demanding attention.
 *
 * How the scoring works, in plain terms
 * ------------------------------------
 * Each emote holds a `weight` — a score. Seeing the emote adds 1. Every frame, every weight is
 * multiplied by a number slightly less than one, chosen so that a weight halves over the
 * **Half-life** period: after one half-life a lone use is worth 0.5, after two it is worth 0.25, and
 * so on. That is a *soft* window. The obvious alternative — "count everything said in the last two
 * minutes" — has a hard edge: a message that ages past the boundary is deleted in one frame and the
 * table jumps. With a half-life the table drifts back towards quiet instead of snapping, which is
 * both calmer to watch and much cheaper, because nothing has to remember individual messages.
 *
 * The number printed on the right is a different quantity: a plain running tally that never decays,
 * so it only ever counts upward. Rank is "what chat is doing now"; the tally is "what chat has done
 * since this scene came up".
 *
 * Why the order does not thrash
 * -----------------------------
 * Two brakes. An emote must reach **Minimum Score** before it earns a row at all, so a single
 * one-off use cannot displace anything; and it must fall to a good deal *below* that before its row
 * closes again, so an emote hovering on the boundary does not flicker in and out. Between two rows
 * already on screen, a swap only happens when the challenger is ahead by a clear margin
 * ({@link SWAP_MARGIN}) and neither row is already moving — so overtakes happen one at a time,
 * deliberately, instead of the table reshuffling itself every frame.
 *
 * What is animated, and what deliberately is not
 * ---------------------------------------------
 * Rows open and close, rows swap, and the tally does a small scale pop when it ticks. Audio is used
 * twice and no more: the whole panel breathes by a percent or two with the slow loudness envelope,
 * and the *leader's* rule flashes white on a beat. Reserving that flash for first place is what
 * makes the leader feel like a leader; if every row flashed, none of them would mean anything.
 *
 * Memory, which matters over a six-hour broadcast
 * ----------------------------------------------
 * Two things could grow without limit here and both are capped. The score table drops entries whose
 * weight has decayed to nothing, and refuses to hold more than {@link MAX_TRACKED} emotes at once.
 * The emote images are fetched through `PIXI.Assets.load`, which caches them by URL — so the same
 * emote spammed a thousand times costs one download — and the oldest cached images are released
 * once more than {@link TEXTURE_CACHE_LIMIT} are held and nothing on screen still needs them.
 *
 * The row objects themselves are allocated once, at setup, and reassigned. No `PIXI.Text` and no
 * `PIXI.Sprite` is ever created inside the frame loop: text objects own a GPU texture of their
 * rendered glyphs, and creating them per frame is the classic leak that only becomes visible hours
 * into a stream.
 */

/**
 * How many row objects exist. This is the maximum the Rows parameter allows, so the pool is
 * allocated once at setup and the parameter only decides how many of them are in use.
 */
const POOL_SIZE = 12;

/** Horizontal gap between the columns of a row, in pixels. */
const COLUMN_GAP = 12;

/**
 * How far ahead a challenger must be before it is allowed to overtake, as a fraction.
 *
 * 0.06 means "six percent clear". Without a margin, two emotes with nearly equal scores would swap
 * back and forth every few frames as the decay nudges them past each other, which reads as jitter
 * rather than as competition.
 */
const SWAP_MARGIN = 0.06;

/**
 * How far below Minimum Score an emote must fall before its row closes, as a fraction of it.
 *
 * The gap between "0.6 of the minimum to leave" and "1.0 of the minimum to enter" is what stops a
 * row on the boundary from opening and closing repeatedly. Engineers call this hysteresis; a
 * thermostat uses the same trick so it does not click on and off once a second.
 */
const EXIT_FACTOR = 0.6;

/** A weight this small is indistinguishable from zero, so the entry is forgotten entirely. */
const PRUNE_EPSILON = 0.01;

/** Hard ceiling on how many distinct emotes are scored at once, whatever chat does. */
const MAX_TRACKED = 192;

/** Hard ceiling on how many emote images are kept in Pixi's asset cache. */
const TEXTURE_CACHE_LIMIT = 48;

/** Seconds the tally numeral stays enlarged after it ticks. */
const POP_SECONDS = 0.12;

/** Seconds the leader's rule takes to fade back down after a beat flash. */
const FLASH_SECONDS = 0.35;

/** How much bigger the tally numeral gets on a tick. 8% is noticeable without being cute. */
const POP_SCALE = 0.08;

/** How many messages of the backlog are counted on mount, so the table is not blank on a remount. */
const SEED_MESSAGES = 50;

/**
 * The standings shown when there is no chat connection at all.
 *
 * The simulated chat feed the SDK provides when the backend has no Twitch connection contains no
 * emotes by design, so without this the effect would be an empty rectangle in the admin preview and
 * an operator would have no way to see what they were configuring. These names are recognisably
 * placeholders and they only ever appear while `chat.source` reports "simulated".
 */
const PREVIEW_NAMES = [
  "Kappa",
  "PogChamp",
  "LUL",
  "KEKW",
  "monkaS",
  "BibleThump",
  "4Head",
  "residentSleeper",
  "Pog",
  "catJAM",
  "Sadge",
  "EZ",
] as const;

/** Seconds between two placeholder ticks, so the preview visibly reorders itself. */
const PREVIEW_TICK_SECONDS = 1.4;

/** One scored emote. `key` is the map key: the image URL, which is the image's real identity. */
interface Entry {
  key: string;
  /** The emote code ("Kappa") or the emoji itself ("🎉"), drawn beside the image. */
  name: string;
  /** Where the picture comes from. Empty for the placeholder standings, which have no picture. */
  url: string;
  /** The decaying score that decides rank. */
  weight: number;
  /** The running tally, which never decays. */
  count: number;
  /** Placeholder entries are held at a floor weight so the preview cannot empty itself. */
  preview: boolean;
}

/** One reusable row of the table. Allocated once at setup; `key` says which emote it is showing. */
interface Row {
  view: PIXI.Container;
  /** The hollow square where the emote sits, which is also the "image did not load" state. */
  slot: PIXI.Graphics;
  sprite: PIXI.Sprite;
  rule: PIXI.Graphics;
  name: PIXI.Text;
  count: PIXI.Text;
  /** The emote this row shows, or `null` when the row is parked in the pool. */
  key: string | null;
  /** True while the row is animating away. */
  closing: boolean;
  /** 0 = fully closed, 1 = fully open. Drives both the fade and the space the row takes up. */
  openPhase: number;
  /** Whether this row has ever been positioned, so the first frame can snap instead of sliding. */
  positioned: boolean;
  /** Current vertical position within the table, in pixels from the first row's top. */
  y: number;
  /** Where the current slide started and where it is going. */
  yFrom: number;
  yTo: number;
  /** Progress of the current slide, 0..1. At 1 the row is settled and may take part in a swap. */
  tween: number;
  /** Seconds left on the tally's scale pop. */
  pop: number;
  /** The tally last written into the text object, so the glyphs are only re-rendered on a change. */
  shownCount: number;
  /** The image URL this row asked for, so a slow download that arrives late can be discarded. */
  textureUrl: string | null;
}

/**
 * Reads the heading, and unlike every other text parameter allows it to be empty.
 *
 * `str` from `paramUtils` hands back the fallback whenever the stored value is an empty string.
 * That is the right rule almost everywhere — an empty label is a mistake, not a choice — but it is
 * the wrong rule here. Clearing this box is how an operator asks for the table with no heading, and
 * `str` would answer by putting "EMOTE STANDINGS" back. So the raw value is read directly, and only
 * a value that is not a string at all falls back to the default.
 */
function readTitle(params: Record<string, unknown>): string {
  const value = params["title"];
  return typeof value === "string" ? value : "EMOTE STANDINGS";
}

/** Keeps a value inside 0..1, turning a `NaN` into 0 rather than letting it poison the frame. */
function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/**
 * Starts fast and settles gently. Used for a row opening: it appears immediately and eases into
 * place, which reads as confident rather than sluggish.
 */
function easeOutCubic(t: number): number {
  const x = 1 - clamp01(t);
  return 1 - x * x * x;
}

/**
 * Slow at both ends, quick through the middle. Used for a rank swap: the two rows part company
 * gently, cross quickly, and arrive gently, which is what makes an overtake legible.
 */
function easeInOutCubic(t: number): number {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/** Blends two 24-bit colours channel by channel. `t = 0` gives `a`, `t = 1` gives `b`. */
function mixColor(a: number, b: number, t: number): number {
  const k = clamp01(t);
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  return (
    (Math.round(ar + (br - ar) * k) << 16) |
    (Math.round(ag + (bg - ag) * k) << 8) |
    Math.round(ab + (bb - ab) * k)
  );
}

const emoteStandings = defineEffect({
  descriptor: {
    id: "emote-standings",
    name: "Emote Standings",
    description:
      "A live league table of the emotes chat is using, ranked by a decaying score. Rows open and close as emotes come and go, and an overtake animates as a visible swap rather than a redraw.",
    engine: "pixi",
    category: "chat",
    tags: ["chat", "twitch", "emotes", "leaderboard", "ranking", "typography", "editorial"],
    previewNotes:
      "Transparent apart from the type and the hairline rules, so it sits in a corner of any scene. It counts every emote and every Unicode emoji chat sends. With no Twitch connection configured the SDK's simulated chat carries no emotes at all, so a set of clearly-named placeholder standings is shown instead — turn Preview When Quiet off to see the true empty state. Emote images come from Twitch's and Twemoji's CDNs at runtime; when one cannot be fetched the row keeps its name and draws an empty square where the picture would be.",
    params: [
      {
        key: "title",
        label: "Title",
        kind: "text",
        default: "EMOTE STANDINGS",
        description:
          "The small heading above the table. Leave it empty for the table on its own, with only its top rule.",
      },
      {
        key: "maxRows",
        label: "Rows",
        kind: "number",
        default: 8,
        min: 1,
        max: 12,
        step: 1,
        description: "How many emotes the table shows at once. Everything below this rank is off.",
      },
      {
        key: "halfLife",
        label: "Half-life (s)",
        kind: "number",
        default: 45,
        min: 5,
        max: 600,
        step: 1,
        description:
          "How many seconds it takes for an emote's score to halve — the table's memory. Short values follow the last few messages closely; long values reward emotes chat keeps coming back to.",
      },
      {
        key: "minWeight",
        label: "Minimum Score",
        kind: "number",
        default: 0.8,
        min: 0.2,
        max: 10,
        step: 0.1,
        description:
          "How much score an emote needs before it earns a row. One use is worth 1 point, so raise this to keep one-off emotes from disturbing the order.",
      },
      {
        key: "rowHeight",
        label: "Row Height",
        kind: "number",
        default: 44,
        min: 20,
        max: 96,
        step: 1,
        description: "Height of one row in pixels, which is also the spacing between rows.",
      },
      {
        key: "emoteSize",
        label: "Emote Size",
        kind: "number",
        default: 36,
        min: 12,
        max: 72,
        step: 1,
        description: "Side length of the emote picture in pixels. Keep it under the row height.",
      },
      {
        key: "fontSize",
        label: "Name Size",
        kind: "number",
        default: 13,
        min: 8,
        max: 32,
        step: 1,
        description: "Size of the emote name and of the heading, in pixels.",
      },
      {
        key: "countFontSize",
        label: "Tally Size",
        kind: "number",
        default: 13,
        min: 8,
        max: 32,
        step: 1,
        description: "Size of the running tally on the right of each row, in pixels.",
      },
      {
        key: "panelWidth",
        label: "Table Width",
        kind: "number",
        default: 420,
        min: 160,
        max: 960,
        step: 10,
        description:
          "Width of the whole table in pixels. The rule between the name and the tally takes up whatever is left over, so a wider table means a longer, more readable rule.",
      },
      {
        key: "margin",
        label: "Margin",
        kind: "number",
        default: 48,
        min: 0,
        max: 320,
        step: 2,
        description: "Distance from the top of the frame and from the anchored edge, in pixels.",
      },
      {
        key: "align",
        label: "Anchor",
        kind: "select",
        default: "left",
        options: ["left", "right"],
        description:
          "Which edge the table hangs from. Anchoring right also mirrors the columns, so the emote stays on the outside and the rule grows inward.",
      },
      {
        key: "showNames",
        label: "Show Names",
        kind: "boolean",
        default: true,
        description: "Print the emote's name beside its picture.",
      },
      {
        key: "showCounts",
        label: "Show Tally",
        kind: "boolean",
        default: true,
        description: "Print the running total of times each emote has been sent.",
      },
      {
        key: "showRules",
        label: "Show Rules",
        kind: "boolean",
        default: true,
        description:
          "Draw the hairline whose length shows each emote's score relative to the leader's. Off leaves a table of pure type.",
      },
      {
        key: "reorderSeconds",
        label: "Swap Time (s)",
        kind: "number",
        default: 0.42,
        min: 0.1,
        max: 2,
        step: 0.02,
        description:
          "How long one rank swap takes. Longer reads as more deliberate. Rows opening and closing are timed from this too, at roughly three quarters and one and a half times this value.",
      },
      {
        key: "tracking",
        label: "Letter Spacing",
        kind: "number",
        default: 1,
        min: 0,
        max: 6,
        step: 0.1,
        description:
          "Extra space between letters, in pixels. A little tracking is what makes small capitals read as a caption rather than as body text.",
      },
      {
        key: "textColor",
        label: "Text Colour",
        kind: "color",
        default: "#f2f4f7",
        description: "Colour of the heading, the names and the tallies.",
      },
      paletteParam(
        "palette",
        "Rule Palette",
        "monochrome",
        "Colour ramp for the rules. The leader takes the bright end of the ramp and each rank below is drawn a step darker.",
      ),
      {
        key: "audioBreath",
        label: "Audio Breath",
        kind: "number",
        default: 0.015,
        min: 0,
        max: 0.08,
        step: 0.005,
        description:
          "How much the whole table swells with the room's loudness, as a fraction of its size. 0.015 is a barely-conscious 1.5%; 0 holds it perfectly still.",
      },
      {
        key: "leaderFlash",
        label: "Leader Beat Flash",
        kind: "boolean",
        default: true,
        description:
          "Let the first-placed rule flash white on a beat. Only ever the leader's, which is what makes first place feel like first place.",
      },
      {
        key: "previewWhenQuiet",
        label: "Preview When Quiet",
        kind: "boolean",
        default: true,
        description:
          "Show placeholder standings while there is no Twitch connection, so the layout can be judged in the admin preview. They disappear the moment a real emote arrives.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    /*
     * Parameters are read into plain variables and re-read in `setParams` below. Every one of them
     * is consumed once per frame, so there is nothing to rebuild when one changes.
     */
    let title = readTitle(ctx.params);
    let maxRows = int(ctx.params, "maxRows", 8, 1, POOL_SIZE);
    let halfLife = num(ctx.params, "halfLife", 45, 5, 600);
    let minWeight = num(ctx.params, "minWeight", 0.8, 0.2, 10);
    let rowHeight = num(ctx.params, "rowHeight", 44, 20, 96);
    let emoteSize = num(ctx.params, "emoteSize", 36, 12, 72);
    let fontSize = int(ctx.params, "fontSize", 13, 8, 32);
    let countFontSize = int(ctx.params, "countFontSize", 13, 8, 32);
    let panelWidth = num(ctx.params, "panelWidth", 420, 160, 960);
    let margin = num(ctx.params, "margin", 48, 0, 320);
    let rightAligned = str(ctx.params, "align", "left") === "right";
    let showNames = bool(ctx.params, "showNames", true);
    let showCounts = bool(ctx.params, "showCounts", true);
    let showRules = bool(ctx.params, "showRules", true);
    let reorderSeconds = num(ctx.params, "reorderSeconds", 0.42, 0.1, 2);
    let tracking = num(ctx.params, "tracking", 1, 0, 6);
    let textColor = colorHex(ctx.params, "textColor", "#f2f4f7");
    let colors = palette(ctx.params, "palette", "monochrome");
    let audioBreath = num(ctx.params, "audioBreath", 0.015, 0, 0.08);
    let leaderFlash = bool(ctx.params, "leaderFlash", true);
    let previewWhenQuiet = bool(ctx.params, "previewWhenQuiet", true);

    /*
     * A monospaced face, because the tallies must not shuffle sideways as their digits change: in a
     * monospaced font every digit is the same width, so 99 becoming 100 pushes the column by exactly
     * one character instead of by some arbitrary fraction. The stack falls back through faces that
     * exist on Windows, macOS and Linux respectively before reaching the generic `monospace`.
     */
    const FONT_FAMILY = "'Share Tech Mono', 'Consolas', 'Menlo', 'DejaVu Sans Mono', monospace";

    /*
     * Wait for the face before anything is measured. A web font arrives after the page does, and
     * until it lands the browser measures a substituted one — so a layout computed now would be
     * plausible but wrong, and would visibly reflow a second later, on air. `useFont` never rejects
     * and gives up after two seconds, and it does not checkpoint for us.
     */
    await useFont(`${fontSize}px ${FONT_FAMILY}`);
    scope.checkpoint();

    const chat = await useChat(scope);
    scope.checkpoint();

    const bus = await useAudio(scope);
    scope.checkpoint();

    const stage = await createPixiStage(scope, ctx, { antialias: true });
    scope.checkpoint();

    const env = createEnvelopes(bus);

    /* ---------------------------------------------------------------- */
    /* Display objects, all allocated here and never in the frame loop.  */
    /* ---------------------------------------------------------------- */

    /*
     * `panel` is the thing that breathes with the audio: scaling one container is a single
     * transform, whereas scaling twelve rows individually would be twelve. Its pivot is put on the
     * anchored edge further down, so the swelling grows inward from that edge rather than pushing
     * the table off the side of the frame.
     */
    const panel = stage.stage.addChild(new PIXI.Container());
    const headerLayer = panel.addChild(new PIXI.Graphics());

    const titleStyle = new PIXI.TextStyle({
      fontFamily: FONT_FAMILY,
      fontSize,
      fill: textColor,
      letterSpacing: tracking,
    });
    const nameStyle = new PIXI.TextStyle({
      fontFamily: FONT_FAMILY,
      fontSize,
      fill: textColor,
      letterSpacing: tracking,
    });
    const countStyle = new PIXI.TextStyle({
      fontFamily: FONT_FAMILY,
      fontSize: countFontSize,
      fill: textColor,
      letterSpacing: tracking,
    });

    const titleText = panel.addChild(new PIXI.Text({ text: title, style: titleStyle }));
    titleText.alpha = 0.55;

    /*
     * `sortableChildren` lets a row that is sliding upward be drawn *in front of* the row it is
     * passing, by giving it a higher `zIndex` for the duration of the move. That crossing is what
     * makes an overtake read as one row going past another rather than as two rows blinking into
     * new positions.
     */
    const rowsLayer = panel.addChild(new PIXI.Container());
    rowsLayer.sortableChildren = true;

    const rows: Row[] = [];
    for (let i = 0; i < POOL_SIZE; i += 1) {
      const view = rowsLayer.addChild(new PIXI.Container());
      view.visible = false;
      const slot = view.addChild(new PIXI.Graphics());
      const sprite = view.addChild(new PIXI.Sprite());
      const rule = view.addChild(new PIXI.Graphics());
      const name = view.addChild(new PIXI.Text({ text: "", style: nameStyle }));
      const count = view.addChild(new PIXI.Text({ text: "", style: countStyle }));
      name.anchor.set(0, 0.5);
      count.anchor.set(1, 0.5);
      /*
       * The rule is drawn once, here, as a one-pixel square, and then stretched horizontally by
       * setting `scale.x` to the length it should have. Rebuilding a `Graphics` means throwing away
       * its geometry and building new geometry, and doing that for every rule of every row on every
       * frame is real work for a shape that never changes — only its length does, and a length is a
       * transform. The `y` offset of -0.5 puts the rule's own centre on the container's origin, so
       * positioning it is a single assignment rather than an assignment plus half a pixel.
       */
      rule.rect(0, -0.5, 1, 1).fill(0xffffff);
      rows.push({
        view,
        slot,
        sprite,
        rule,
        name,
        count,
        key: null,
        closing: false,
        openPhase: 0,
        positioned: false,
        y: 0,
        yFrom: 0,
        yTo: 0,
        tween: 1,
        pop: 0,
        shownCount: -1,
        textureUrl: null,
      });
    }

    /*
     * Hand every emote picture back before the stage is torn down.
     *
     * `createPixiStage` disposes with `app.destroy(true, { texture: true, textureSource: true })`,
     * which destroys the texture of every sprite it can still reach. The emote textures are not
     * ours to destroy: `PIXI.Assets` holds them in a cache shared by the whole page, so destroying
     * one leaves the cache handing a dead texture to whoever asks for that URL next — this effect
     * after a remount (every save of the route does one), or another chat effect on the same page,
     * either of which would then show a blank square forever with nothing in the console.
     *
     * Teardowns run in reverse registration order, and the stage registered its own before this
     * one, so this runs first: by the time `app.destroy` walks the tree every sprite is holding
     * `Texture.EMPTY`, whose `destroy` Pixi deliberately replaces with a no-op.
     *
     * The cached images themselves are left in place rather than unloaded here. They are shared —
     * a sibling chat effect may be drawing the very same emote from the very same cache entry —
     * and the growth is bounded by how many distinct emotes the channel has, not by how long the
     * broadcast runs. Trading a small bounded cache for the risk of blanking another overlay's
     * emotes is not a trade worth making. {@link trimTextureCache} still caps what one mount adds.
     */
    scope.defer(() => {
      for (const row of rows) {
        row.sprite.texture = PIXI.Texture.EMPTY;
        row.textureUrl = null;
      }
    });

    /* ---------------------------------------------------------------- */
    /* The scoring state                                                 */
    /* ---------------------------------------------------------------- */

    /** Every emote currently worth remembering, keyed by its image URL. */
    const scores = new Map<string, Entry>();
    /** The standings: keys in displayed order, including rows still animating away. */
    const order: string[] = [];
    /** Which row object is showing which emote. */
    const rowOf = new Map<string, Row>();
    /**
     * Image URLs handed to Pixi's asset cache, oldest first, so the oldest can be released.
     *
     * The matching `Set` exists because the same emote is loaded again every time it re-enters the
     * table, and `Assets.load` answers instantly from its cache each time. Without the membership
     * check the same URL would be appended over and over, the list would cross
     * {@link TEXTURE_CACHE_LIMIT} while holding only a handful of distinct images, and the trim
     * would then unload a picture that a second, still-present copy of the same URL claimed was
     * cached.
     */
    const cachedUrls: string[] = [];
    const cachedSet = new Set<string>();

    /** True once a genuine emote has been counted; the placeholders never come back after that. */
    let sawRealEmote = false;
    let previewActive = false;
    let previewSeconds = 0;
    let flash = 0;

    /*
     * What the two cached `Graphics` shapes were last drawn at. Both depend only on parameters, so
     * they are redrawn when a parameter actually changes them and left alone on every other frame —
     * which is all of them, on a table nobody is currently configuring.
     */
    let drawnSlotSize = -1;
    let drawnHeaderWidth = -1;
    let drawnHeaderRuleY = -1;
    let drawnHeaderColor = "";

    /** Reused by the frame loop so deciding "is this emote already listed?" allocates nothing. */
    const placed = new Set<string>();

    /** Releases cached emote images once too many are held, skipping any still in use. */
    const trimTextureCache = (): void => {
      while (cachedUrls.length > TEXTURE_CACHE_LIMIT) {
        const held = new Set<string>();
        for (const row of rows) if (row.textureUrl !== null) held.add(row.textureUrl);

        let victim = -1;
        for (let i = 0; i < cachedUrls.length; i += 1) {
          const url = cachedUrls[i];
          if (url !== undefined && !scores.has(url) && !held.has(url)) {
            victim = i;
            break;
          }
        }
        // Everything cached is still scored or still on screen. The cap is a target, not a promise;
        // giving up here is correct, because unloading a texture in use would blank a row.
        if (victim < 0) return;

        const [url] = cachedUrls.splice(victim, 1);
        if (url !== undefined) {
          cachedSet.delete(url);
          // Unloading destroys the texture, which is exactly why the checks above matter.
          PIXI.Assets.unload(url).catch(() => {});
        }
      }
    };

    /** Adds `amount` to an emote's score, creating its entry the first time it is seen. */
    const tally = (name: string, url: string, amount: number): void => {
      const key = url.length > 0 ? url : `preview:${name}`;
      const existing = scores.get(key);
      if (existing !== undefined) {
        existing.weight += amount;
        existing.count += 1;
        existing.name = name;
        return;
      }

      /*
       * The hard ceiling. Chats with hundreds of channel emotes exist, and without this a long
       * broadcast would grow this map for hours. When it is full, the weakest entry that is not on
       * screen makes way; if every entry is on screen the newcomer is simply ignored, which it would
       * have been anyway at its score of one.
       */
      if (scores.size >= MAX_TRACKED) {
        let weakestKey: string | null = null;
        let weakest = Number.POSITIVE_INFINITY;
        for (const [otherKey, entry] of scores) {
          if (rowOf.has(otherKey)) continue;
          if (entry.weight < weakest) {
            weakest = entry.weight;
            weakestKey = otherKey;
          }
        }
        if (weakestKey === null) return;
        scores.delete(weakestKey);
      }

      scores.set(key, { key, name, url, weight: amount, count: 1, preview: false });
    };

    /** Removes the placeholder standings; their rows then close through the ordinary path. */
    const retirePreview = (): void => {
      for (const [key, entry] of scores) if (entry.preview) scores.delete(key);
    };

    /**
     * Fills the table with recognisable placeholders while there is no Twitch connection.
     *
     * They are marked `preview: true`, which exempts them from decay pruning and from the running
     * tally's meaning — and which is how {@link retirePreview} finds them again.
     */
    const seedPreview = (): void => {
      for (let i = 0; i < PREVIEW_NAMES.length; i += 1) {
        const name = PREVIEW_NAMES[i];
        if (name === undefined) continue;
        const key = `preview:${name}`;
        if (scores.has(key)) continue;
        scores.set(key, {
          key,
          name,
          url: "",
          // A descending spread, so the placeholder table starts in a plausible order rather than
          // with every row the same length.
          weight: minWeight * (3.2 - i * 0.2),
          count: 24 - i * 2,
          preview: true,
        });
      }
    };

    /** Counts every image part of one message. Twitch emotes and Unicode emoji arrive alike. */
    const receive = (message: ChatMessage, amount: number): void => {
      for (const part of message.parts) {
        if (part.type !== "image") continue;
        if (!sawRealEmote) {
          sawRealEmote = true;
          retirePreview();
        }
        tally(part.name, part.url, amount);
      }
    };

    /*
     * Seed from the backlog so a remount — which happens every time the route is saved — does not
     * start from an empty table. Older messages are worth less, by exactly the decay curve they
     * would have suffered had the effect been running all along.
     */
    const nowMs = Date.now();
    for (const message of chat.recent().slice(-SEED_MESSAGES)) {
      const ageSeconds = Math.max(0, (nowMs - message.at) / 1000);
      receive(message, Math.pow(0.5, ageSeconds / halfLife));
    }
    scope.defer(chat.onMessage((message) => receive(message, 1)));

    /* ---------------------------------------------------------------- */
    /* Layout                                                            */
    /* ---------------------------------------------------------------- */

    /** The table's width, never wider than the canvas can hold between its two margins. */
    const effectiveWidth = (): number =>
      Math.max(80, Math.min(panelWidth, stage.width - margin * 2));

    /** Vertical distance from the top of the panel to the first row. */
    const headerHeight = (): number =>
      (title.length > 0 ? Math.round(fontSize * 1.9) : 0) + Math.round(rowHeight * 0.34);

    /**
     * Places one row's five pieces and draws its rule.
     *
     * `share` is the emote's score as a fraction of the leader's, so the leader's rule always runs
     * the full length available and everything else is measured against it. Measuring against the
     * *total* instead would make every rule short as soon as the table was busy, which is precisely
     * when it most needs to be readable.
     */
    const layoutRow = (row: Row, rank: number, share: number, openness: number): void => {
      const width = effectiveWidth();
      const centre = rowHeight / 2;
      const nameColumn = Math.round(fontSize * 7.2);
      const countColumn = Math.round(countFontSize * 3.4);
      const ruleStart = emoteSize + COLUMN_GAP + (showNames ? nameColumn + COLUMN_GAP : 0);
      const ruleRoom = Math.max(0, width - ruleStart - (showCounts ? countColumn + COLUMN_GAP : 0));
      const ruleLength = Math.max(showRules && share > 0 ? 1 : 0, ruleRoom * clamp01(share));

      // A row slides in from the anchored edge as it opens, which is a smaller, quieter gesture
      // than dropping it in from above and does not fight with the rows sliding down to make room.
      const entrance = (1 - openness) * 10;

      row.name.visible = showNames;
      row.count.visible = showCounts;
      // A rule of zero length is hidden outright rather than scaled to nothing: a zero scale is a
      // transform that cannot be inverted, which is the sort of thing that produces a `NaN`
      // somewhere far away from where it was created.
      row.rule.visible = showRules && ruleLength > 0;

      // The rule's geometry is the unit square drawn at setup; its length is a horizontal scale.
      row.rule.scale.set(Math.max(ruleLength, 0.001), 1);
      row.rule.y = centre;

      if (rightAligned) {
        // Mirrored: the picture hugs the outer edge and the rule grows inward, towards the frame.
        row.slot.x = width - emoteSize;
        row.slot.y = centre - emoteSize / 2;
        row.name.anchor.set(1, 0.5);
        row.name.x = width - emoteSize - COLUMN_GAP;
        row.count.anchor.set(0, 0.5);
        row.count.x = 0;
        row.rule.x = width - ruleStart - ruleLength;
        row.view.x = -entrance;
      } else {
        row.slot.x = 0;
        row.slot.y = centre - emoteSize / 2;
        row.name.anchor.set(0, 0.5);
        row.name.x = emoteSize + COLUMN_GAP;
        row.count.anchor.set(1, 0.5);
        row.count.x = width;
        row.rule.x = ruleStart;
        row.view.x = entrance;
      }

      row.name.y = centre;
      row.count.y = centre;

      /*
       * The rule carries the only colour in the design, and it is graded by rank: the leader takes
       * the bright end of the palette and each place below is a step darker. The ramp is sampled
       * from 0.45 rather than from 0 so that the darkest palettes still leave the last row visible.
       */
      const spread = Math.max(1, maxRows - 1);
      const shade = 1 - (Math.min(rank, spread) / spread) * 0.55;
      const base = paletteAtInt(colors, shade);
      const leading = rank === 0 && leaderFlash ? flash : 0;
      row.rule.tint = mixColor(base, 0xffffff, leading);
      // The row container's own alpha already carries the open/close fade, so this is only the
      // weight of the rule itself: longer rules sit slightly stronger, and the leader's flash lifts
      // it the rest of the way to solid.
      row.rule.alpha = Math.min(1, 0.32 + share * 0.48 + leading * 0.6);

      // The picture is scaled to fit its square without distorting it, which matters because Twitch
      // emotes are not all square — wide ones exist and would otherwise be stretched.
      const texture = row.sprite.texture;
      const tw = Math.max(1, texture.width);
      const th = Math.max(1, texture.height);
      const scale = emoteSize / Math.max(tw, th);
      row.sprite.visible = row.textureUrl !== null && texture !== PIXI.Texture.EMPTY;
      // The empty square is the placeholder *and* the failure state: it holds the picture's space
      // while the download is in flight, and stays if the download never arrives.
      row.slot.visible = !row.sprite.visible;
      row.sprite.scale.set(scale);
      row.sprite.x = row.slot.x + (emoteSize - tw * scale) / 2;
      row.sprite.y = row.slot.y + (emoteSize - th * scale) / 2;
    };

    /** Trims a name to the width its column allows, ending it with an ellipsis when it does not fit. */
    const fitName = (row: Row, name: string): void => {
      const column = Math.round(fontSize * 7.2);
      row.name.text = name;
      // Reassigning `text` re-renders the glyphs, so this loop runs only when a row changes emote —
      // never per frame — and is capped so a pathological name cannot stall a frame.
      for (
        let guard = 0;
        guard < 24 && row.name.width > column && row.name.text.length > 1;
        guard += 1
      ) {
        row.name.text = `${row.name.text.slice(0, -2)}…`;
      }
    };

    /** Points a row at an emote: its name, its tally and the download of its picture. */
    const dressRow = (row: Row, entry: Entry): void => {
      fitName(row, entry.name);
      row.shownCount = entry.count;
      row.count.text = String(entry.count);
      row.pop = 0;

      row.sprite.texture = PIXI.Texture.EMPTY;
      row.textureUrl = entry.url.length > 0 ? entry.url : null;
      if (row.textureUrl === null) return;

      const wanted = row.textureUrl;
      /*
       * `Assets.load` caches by URL, so an emote spammed across a hundred messages is fetched once.
       * That is legitimate here — unlike a user-typed image URL, these come from a fixed set of CDN
       * namespaces — and {@link trimTextureCache} keeps the cache from growing without limit.
       */
      PIXI.Assets.load<PIXI.Texture>(wanted)
        .then((texture) => {
          // The row may have been retired, or reassigned to another emote, while this was in flight.
          if (row.sprite.destroyed || row.textureUrl !== wanted) return;
          row.sprite.texture = texture;
          if (cachedSet.has(wanted)) return;
          cachedSet.add(wanted);
          cachedUrls.push(wanted);
          trimTextureCache();
        })
        .catch(() => {
          // Nothing to do: the empty square drawn behind the sprite is already the failure state,
          // and the row keeps its name, which is the part that carries the information.
        });
    };

    /** Takes a free row out of the pool, or `null` when every row is busy. */
    const takeRow = (): Row | null => {
      for (const row of rows) {
        if (row.key === null) {
          row.closing = false;
          row.openPhase = 0;
          row.positioned = false;
          row.tween = 1;
          row.view.visible = true;
          row.view.zIndex = 0;
          return row;
        }
      }
      return null;
    };

    /** Puts a row back in the pool and forgets everything it was showing. */
    const releaseRow = (row: Row): void => {
      row.key = null;
      row.closing = false;
      row.openPhase = 0;
      row.positioned = false;
      row.view.visible = false;
      row.view.zIndex = 0;
      row.sprite.texture = PIXI.Texture.EMPTY;
      row.sprite.visible = false;
      row.textureUrl = null;
      row.shownCount = -1;
    };

    /* ---------------------------------------------------------------- */
    /* The frame                                                         */
    /* ---------------------------------------------------------------- */

    onFrame(scope, ctx.fpsCap, ({ dt, now }) => {
      bus.sample(now);
      env.update(dt);

      // ── Cached geometry ─────────────────────────────────────────────
      // The empty square behind each emote is the same square on every row and changes only when
      // the Emote Size parameter does, so all twelve are redrawn together on the rare frame that
      // happens rather than each of them being rebuilt on every frame.
      if (drawnSlotSize !== emoteSize) {
        drawnSlotSize = emoteSize;
        for (const row of rows) {
          row.slot
            .clear()
            .rect(0, 0, emoteSize, emoteSize)
            .stroke({ color: 0xffffff, alpha: 0.14, width: 1 });
        }
      }

      // ── The placeholder standings ───────────────────────────────────
      const wantPreview = previewWhenQuiet && !sawRealEmote && chat.source === "simulated";
      if (wantPreview) {
        seedPreview();
        previewSeconds += dt;
        if (previewSeconds >= PREVIEW_TICK_SECONDS) {
          previewSeconds = 0;
          // Bump one placeholder at random so the preview visibly reorders itself, which is the one
          // behaviour an operator most needs to see before putting this on air.
          const pick = PREVIEW_NAMES[Math.floor(Math.random() * PREVIEW_NAMES.length)];
          const entry = pick === undefined ? undefined : scores.get(`preview:${pick}`);
          if (entry !== undefined) {
            entry.weight += minWeight * 0.9;
            entry.count += 1;
          }
        }
        previewActive = true;
      } else if (previewActive) {
        retirePreview();
        previewActive = false;
      }

      // ── Decay ───────────────────────────────────────────────────────
      /*
       * One multiplication per emote per frame. Raising a half to the power of "how much of a
       * half-life has elapsed" is what makes the decay frame-rate independent: at 30 fps each step
       * is twice as large as at 60 fps, and the score after a second is identical either way.
       */
      const decay = Math.pow(0.5, dt / halfLife);
      const previewFloor = minWeight * 1.1;
      for (const [key, entry] of scores) {
        entry.weight *= decay;
        if (entry.preview) {
          // Placeholders are held above the entry threshold so the preview cannot empty itself.
          entry.weight = Math.max(entry.weight, previewFloor);
        } else if (entry.weight < PRUNE_EPSILON && !rowOf.has(key)) {
          scores.delete(key);
        }
      }

      // ── The standings ───────────────────────────────────────────────
      placed.clear();
      for (const key of order) placed.add(key);

      // Anything that has earned the entry threshold and is not already listed takes the position
      // its score deserves. Entering is an insertion, not a swap, so it needs no margin.
      for (const [key, entry] of scores) {
        if (entry.weight < minWeight || placed.has(key)) continue;
        let index = order.length;
        for (let i = 0; i < order.length; i += 1) {
          const otherKey = order[i];
          const other = otherKey === undefined ? undefined : scores.get(otherKey);
          if (other === undefined || other.weight < entry.weight) {
            index = i;
            break;
          }
        }
        order.splice(index, 0, key);
        placed.add(key);
      }

      // One overtake at a time. Both rows must be on screen and settled, and the challenger must be
      // clearly ahead — see SWAP_MARGIN — or near-equal scores would trade places every frame.
      for (let i = 0; i + 1 < order.length; i += 1) {
        const upperKey = order[i];
        const lowerKey = order[i + 1];
        if (upperKey === undefined || lowerKey === undefined) continue;
        const upper = scores.get(upperKey);
        const lower = scores.get(lowerKey);
        if (upper === undefined || lower === undefined) continue;
        const upperRow = rowOf.get(upperKey);
        const lowerRow = rowOf.get(lowerKey);
        if (upperRow === undefined || lowerRow === undefined) continue;
        if (upperRow.closing || lowerRow.closing) continue;
        if (upperRow.tween < 1 || lowerRow.tween < 1) continue;
        if (lower.weight > upper.weight * (1 + SWAP_MARGIN)) {
          order[i] = lowerKey;
          order[i + 1] = upperKey;
          i += 1;
        }
      }

      // Hand out and take back rows. A listed emote that has dropped below the exit threshold, or
      // that has been pushed past the last visible place, closes rather than vanishing.
      const exitWeight = minWeight * EXIT_FACTOR;
      for (let i = 0; i < order.length; i += 1) {
        const key = order[i];
        if (key === undefined) continue;
        const entry = scores.get(key);
        const live = entry !== undefined && entry.weight >= exitWeight && i < maxRows;
        let row = rowOf.get(key);
        if (live && row === undefined) {
          const free = takeRow();
          if (free !== null && entry !== undefined) {
            free.key = key;
            rowOf.set(key, free);
            dressRow(free, entry);
            row = free;
          }
        }
        if (row !== undefined) row.closing = !live;
      }

      // ── Animation and drawing ───────────────────────────────────────
      const openSeconds = reorderSeconds * 0.72;
      const closeSeconds = reorderSeconds * 1.43;

      // The leader's score sets the length of every rule, so it is found before anything is drawn.
      let leaderWeight = 0;
      for (const key of order) {
        const entry = scores.get(key);
        if (entry !== undefined && entry.weight > leaderWeight) leaderWeight = entry.weight;
      }

      flash = Math.max(0, flash - dt / FLASH_SECONDS);
      if (env.beat && leaderFlash) flash = 1;

      let offset = 0;
      let rank = 0;
      for (let i = order.length - 1; i >= 0; i -= 1) {
        const key = order[i];
        if (key === undefined) {
          order.splice(i, 1);
          continue;
        }
        // A listed emote with no row is a contender waiting for a place. It stays listed only while
        // it is near enough the visible table to matter; the rest are dropped so the list is bounded.
        if (!rowOf.has(key)) {
          const entry = scores.get(key);
          if (entry === undefined || entry.weight < exitWeight || i >= maxRows + 4) {
            order.splice(i, 1);
          }
        }
      }

      const rowsTop = headerHeight();
      for (let i = 0; i < order.length; i += 1) {
        const key = order[i];
        if (key === undefined) continue;
        const row = rowOf.get(key);
        if (row === undefined) continue;

        // Opening eases out, so a new row arrives promptly and settles; closing runs the same curve
        // backwards over a longer time, so an emote going quiet leaves without drawing attention.
        row.openPhase = clamp01(
          row.openPhase + (row.closing ? -dt / closeSeconds : dt / openSeconds),
        );
        const openness = easeOutCubic(row.openPhase);

        if (row.closing && row.openPhase <= 0) {
          releaseRow(row);
          rowOf.delete(key);
          continue;
        }

        // Where this row should be: directly under everything above it. Because the offset grows by
        // each row's *animated* height, opening a row above pushes this one down smoothly.
        const target = offset;
        offset += rowHeight * openness;

        if (!row.positioned) {
          row.positioned = true;
          row.y = target;
          row.yFrom = target;
          row.yTo = target;
          row.tween = 1;
        } else if (Math.abs(target - row.yTo) > 0.5) {
          row.yFrom = row.y;
          row.yTo = target;
          row.tween = 0;
        }

        row.tween = clamp01(row.tween + dt / reorderSeconds);
        row.y = lerp(row.yFrom, row.yTo, easeInOutCubic(row.tween));
        row.view.y = rowsTop + row.y;
        row.view.alpha = openness;
        // While a row is moving it is lifted above its neighbours, and a row moving *upward* is
        // lifted highest, so an overtake is one row visibly crossing in front of another.
        row.view.zIndex = row.tween < 1 ? (row.yTo < row.yFrom ? 2 : 1) : 0;

        const entry = scores.get(key);
        const weight = entry === undefined ? 0 : entry.weight;
        const share = leaderWeight > 0 ? weight / leaderWeight : 0;

        if (entry !== undefined && entry.count !== row.shownCount) {
          row.shownCount = entry.count;
          row.count.text = String(entry.count);
          row.pop = POP_SECONDS;
        }
        row.pop = Math.max(0, row.pop - dt);
        // The pop is on the numeral alone — the row does not move, only the number swells and
        // settles, which is enough to catch the eye without disturbing the line of type.
        row.count.scale.set(1 + POP_SCALE * (row.pop / POP_SECONDS));

        layoutRow(row, rank, share, openness);
        rank += 1;
      }

      // ── The heading and the panel itself ────────────────────────────
      const width = effectiveWidth();
      const ruleY = title.length > 0 ? Math.round(fontSize * 1.9) : 0;

      titleText.visible = title.length > 0;
      titleText.text = title;
      titleText.anchor.set(rightAligned ? 1 : 0, 0);
      titleText.x = rightAligned ? width : 0;
      titleText.y = 0;

      // The table's top rule is always drawn, even with nothing to list. An empty table that still
      // shows its own edge reads as "nobody has said anything yet"; a blank frame reads as broken.
      // It depends only on parameters and the canvas width, so it is rebuilt when one of those
      // moves and skipped on every other frame.
      if (
        drawnHeaderWidth !== width ||
        drawnHeaderRuleY !== ruleY ||
        drawnHeaderColor !== textColor
      ) {
        drawnHeaderWidth = width;
        drawnHeaderRuleY = ruleY;
        drawnHeaderColor = textColor;
        headerLayer.clear().rect(0, ruleY, width, 1).fill({ color: textColor, alpha: 0.22 });
      }

      panel.pivot.set(rightAligned ? width : 0, 0);
      panel.x = rightAligned ? stage.width - margin : margin;
      panel.y = margin;
      // The only other place audio is allowed to touch this effect: a percent or two of swell on the
      // whole panel, anchored to the edge it hangs from so it never drifts off the frame.
      panel.scale.set(1 + env.slow * audioBreath);

      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        title = readTitle(p);
        maxRows = int(p, "maxRows", 8, 1, POOL_SIZE);
        halfLife = num(p, "halfLife", 45, 5, 600);
        minWeight = num(p, "minWeight", 0.8, 0.2, 10);
        rowHeight = num(p, "rowHeight", 44, 20, 96);
        emoteSize = num(p, "emoteSize", 36, 12, 72);
        fontSize = int(p, "fontSize", 13, 8, 32);
        countFontSize = int(p, "countFontSize", 13, 8, 32);
        panelWidth = num(p, "panelWidth", 420, 160, 960);
        margin = num(p, "margin", 48, 0, 320);
        rightAligned = str(p, "align", "left") === "right";
        showNames = bool(p, "showNames", true);
        showCounts = bool(p, "showCounts", true);
        showRules = bool(p, "showRules", true);
        reorderSeconds = num(p, "reorderSeconds", 0.42, 0.1, 2);
        tracking = num(p, "tracking", 1, 0, 6);
        textColor = colorHex(p, "textColor", "#f2f4f7");
        colors = palette(p, "palette", "monochrome");
        audioBreath = num(p, "audioBreath", 0.015, 0, 0.08);
        leaderFlash = bool(p, "leaderFlash", true);
        previewWhenQuiet = bool(p, "previewWhenQuiet", true);

        /*
         * The three text styles are shared by every text object, so changing one here restyles the
         * whole table at once. Nothing is rebuilt: the rows, their sprites and the canvas all
         * survive, which is what keeps a slider drag from flashing black on air.
         */
        titleStyle.fontSize = fontSize;
        titleStyle.fill = textColor;
        titleStyle.letterSpacing = tracking;
        nameStyle.fontSize = fontSize;
        nameStyle.fill = textColor;
        nameStyle.letterSpacing = tracking;
        countStyle.fontSize = countFontSize;
        countStyle.fill = textColor;
        countStyle.letterSpacing = tracking;

        // A narrower name column may have made a trimmed name too long or too short, so every
        // visible name is re-fitted once, here, rather than being re-measured every frame.
        for (const row of rows) {
          if (row.key === null) continue;
          const entry = scores.get(row.key);
          if (entry !== undefined) fitName(row, entry.name);
        }
      },
    };
  },
});

export default emoteStandings;
