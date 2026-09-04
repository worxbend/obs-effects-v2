import * as PIXI from "pixi.js";

import { bool, int, num, str } from "../paramUtils";
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
 * Show of Hands
 * =============
 *
 * A live chat poll where the tally is a *pile*. Viewers type `!1` or `!2` (whatever keywords you
 * configure) and every vote drops into the frame as a small rounded token, tinted with that
 * viewer's own chat colour, which falls, overshoots slightly and settles into a hexagonally-packed
 * heap at the base of its column. The height of the heap is the count. A number under the baseline
 * gives the exact figure for anyone who wants it, but the picture does the talking: a poll where
 * the audience can watch their own vote land.
 *
 * Why a heap and not a bar
 * ------------------------
 * A progress bar is a number wearing a costume — nothing about it says *people*. A heap is made of
 * individually visible counters, each carrying the colour of the person who cast it, so the
 * quantity and the crowd are the same object. That is also why the tokens are not perfectly
 * aligned: each one settles with a small random rotation of a few degrees, the way physical
 * counters land on a table rather than the way pixels line up in a grid.
 *
 * How a token moves
 * -----------------
 * Every token is pulled towards its slot by a **damped spring**. A spring is described by two
 * numbers: how stiff it is (`omega` below, derived from the Drop Time parameter — a shorter drop
 * means a stiffer spring) and how much friction it has (`zeta`, derived from Bounce). At a
 * friction value of exactly 1 the token glides to its slot and stops dead, which is called
 * *critically damped*; below 1 it sails past its target and comes back, which is the overshoot that
 * makes the landing read as physical. Because the spring starts far above the frame, the beginning
 * of the motion looks exactly like a fall under gravity.
 *
 * Springs are integrated with a step of at most 30 ms even when the browser hands over a longer
 * frame, because a spring integrated in one enormous step goes unstable and flings its token off
 * the screen — the classic way a physical overlay explodes after the machine hitches.
 *
 * One vote per chatter, and changing your mind
 * --------------------------------------------
 * With One Vote Per Viewer on, a `Map` remembers which token belongs to which login. Voting again
 * for the same column does nothing; voting for a different one **moves the existing token**: it
 * gets an upward kick and its spring target becomes a slot in the other pile, so it arcs across the
 * gap and drops in. The hole it left behind is filled by the token that was on top of that pile,
 * which slides down into the empty slot. That visible piece of bookkeeping — one token out, one
 * token collapsing to close the gap — is the whole charm of the effect, and it costs exactly one
 * re-springing token per vote change rather than a repack of the entire heap.
 *
 * How sound is used
 * -----------------
 * Sparingly, and physically. The fast loudness envelope gives settled piles a sub-pixel shiver, as
 * though the desk they sit on were being thumped, and a detected transient gives every settled
 * token one small upward nudge that its spring immediately absorbs. Turn Table Shiver to 0 and the
 * effect ignores audio completely. Nothing here is a level meter; the audio only ever disturbs a
 * pile that the votes built.
 *
 * What it deliberately does not do
 * ---------------------------------
 * There is no in-chat reset command. A `ChatMessage` carries no moderator or broadcaster flag, so
 * an effect cannot tell a moderator from anyone else, and a `!reset` that any viewer could type
 * would be a poll any viewer could wipe. Resetting is a parameter change from the admin panel:
 * editing the Vote Keywords field starts a fresh poll, which is the same gesture as asking a new
 * question.
 *
 * Sprites, not a ParticleContainer
 * --------------------------------
 * Every token is an ordinary `PIXI.Sprite` sharing one white rounded-square texture baked into a 2D
 * canvas at setup — the `makeSoftDot` idiom from `pixi/floating-dust.ts`. A `ParticleContainer`
 * would be faster, but only while its particles share rotation, tint and alpha; here every token
 * has its own rotation, its own voter colour and its own dimming, so switching those dynamic
 * properties back on would give up the single-draw-call advantage that is the entire reason to use
 * one. A few hundred plain sprites is a load Pixi does not notice.
 */

/** Edge length of the baked token bitmap. Tokens are scaled down from it, so it only sets quality. */
const TOKEN_TEXTURE_SIZE = 96;

/**
 * Fraction of the bitmap left empty around the rounded square, so its antialiased edge has room
 * inside the texture instead of being clipped by the bitmap border.
 */
const TOKEN_TEXTURE_INSET = 0.06;

/** Edge length of the drawn square inside the bitmap, in texture pixels. */
const TOKEN_VISIBLE_SIZE = TOKEN_TEXTURE_SIZE * (1 - TOKEN_TEXTURE_INSET * 2);

/** Gap between neighbouring tokens as a fraction of the token size, so a pile reads as counters. */
const SLOT_GAP = 0.16;

/**
 * Vertical distance between rows as a fraction of the horizontal pitch.
 *
 * In a hexagonal packing each row sits in the dips of the row below, which by Pythagoras puts the
 * rows √3/2 ≈ 0.866 of a pitch apart. That is what makes the heap interlock instead of stacking
 * into an obvious rectangular grid.
 */
const ROW_PITCH_FACTOR = 0.866;

/** Largest tilt a settled token may take, in degrees. Small on purpose: a heap, not a mess. */
const MAX_TILT_DEG = 4;

/** Widest columns may be laid out; more than this and the labels stop being readable. */
const MAX_COLUMNS = 5;

/** Stiffest the landing spring may get, in radians per second. Keeps the integrator stable. */
const MAX_OMEGA = 26;

/** Longest physics step taken in one go, in seconds. See the header on integrator stability. */
const MAX_PHYSICS_STEP = 0.03;

/** Upward kick a migrating token receives, as a multiple of the horizontal distance it must cover. */
const MIGRATION_LIFT = 0.9;

/** Upward nudge, in pixels per second, that a detected transient gives each settled token. */
const BEAT_KICK = 26;

/** How still a token must be to count as settled: pixels from its slot, and pixels per second. */
const SETTLED_DISTANCE = 0.6;
const SETTLED_SPEED = 3;

/** Votes a column must be ahead by — and hold — before Dim The Losers fades the others. */
const LEAD_MARGIN = 2;

/** Opacity a non-leading column falls to once one column is clearly ahead. */
const DIM_ALPHA = 0.35;

/** The grey a dimmed column's colours are pulled towards, so it desaturates as well as fades. */
const DIM_GREY = 0x8b9096;

/** Per-frame retention of the dimming animation at 60 fps, converted to per-second in the loop. */
const DIM_DECAY = 0.9;

/** Bounds of the random gap between synthetic votes in demo mode, in seconds. */
const DEMO_MIN_GAP_S = 0.45;
const DEMO_MAX_GAP_S = 1.6;

/** How many synthetic voters demo mode invents. Small enough that some of them change their vote. */
const DEMO_VOTERS = 36;

/** How many synthetic votes demo mode places at once when it starts, so a preview is not empty. */
const DEMO_SEED_VOTES = 16;

/** Twitch's own default chat colours, which is what demo votes are tinted with. */
const DEMO_COLORS = [
  0xff0000, 0x0000ff, 0x008000, 0xb22222, 0xff7f50, 0x9acd32, 0xff4500, 0x2e8b57, 0xdaa520,
  0xd2691e, 0x5f9ea0, 0x1e90ff, 0xff69b4, 0x8a2be2, 0x00ff7f,
] as const;

/** Sans stack for the column labels: whatever the OBS machine has, with a guaranteed fallback. */
const LABEL_FONT_STACK =
  '"Inter", "Segoe UI", "Helvetica Neue", Arial, "Noto Sans", system-ui, sans-serif';

/** Monospace stack for the counts, so a two-digit number is the same width as any other. */
const COUNT_FONT_STACK = '"JetBrains Mono", "Cascadia Mono", Consolas, "Courier New", monospace';

/** Default vote keywords, matching the two-way question the effect is named for. */
const DEFAULT_OPTIONS = "!1,!2";

/** Default column labels, one per keyword. */
const DEFAULT_LABELS = "KEEP GOING,WRAP UP";

/** Matches a `#rrggbb` colour, which is what a chat message promises but not what it can prove. */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** One counter in a pile, or one waiting unused in the pool. */
interface Token {
  sprite: PIXI.Sprite;
  /** False while the token sits in the free list with its sprite hidden. */
  active: boolean;
  /** Index of the column this token belongs to. */
  col: number;
  /** Index of the lattice slot inside that column. Always equals its position in `column.tokens`. */
  slot: number;
  /** Current position and velocity, in stage pixels and pixels per second. */
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** The fixed tilt this token landed with, in radians. */
  tilt: number;
  /** The voter's own chat colour, used when Tint From Chat is on. */
  chatTint: number;
  /** Last tint written to the sprite, so an unchanged tint is not rewritten every frame. */
  appliedTint: number;
  /** The login this token belongs to, or `""` for a token nobody owns (a raid burst). */
  voter: string;
  /**
   * True for a token demo mode invented.
   *
   * Without this there is no way to tell a synthetic vote from a real one after the fact — with One
   * Vote Per Viewer off every token is anonymous — and the synthetic ones have to be removable on
   * their own, so that turning Demo Votes off, or Twitch connecting, leaves a real poll behind
   * rather than a real poll sitting on top of a fake one.
   */
  demo: boolean;
  /** Phase offset so the audio shiver does not move every token in lock step. */
  phase: number;
}

/** One pile, its heading, and the votes currently in it. */
interface Column {
  /** The vote keyword, already lowercased and trimmed, e.g. `"!1"`. */
  keyword: string;
  /** The human label shown beside the keyword. */
  label: string;
  /** The heading container, holding the label and the count. Dimmed as a unit. */
  head: PIXI.Container;
  labelView: PIXI.Text;
  countView: PIXI.Text;
  /** Tokens in slot order: index 0 is the first slot of the bottom row. */
  tokens: Token[];
  /** Last count written to `countView`, so the text is only rebuilt when the tally changes. */
  shownCount: number;
  /** Last colour and size pushed into the two text styles. See `restyleHead` for why it matters. */
  styledColor: number;
  styledSize: number;
  /** Current dim factor, 1 while the column is live and easing towards DIM_ALPHA when it loses. */
  dim: number;
  /**
   * What the baseline rule was last *drawn* with: its dim factor, its stroke colour and its left
   * edge.
   *
   * The rules live in one `Graphics`, and re-recording a `Graphics` means rebuilding its path and
   * instruction list — cheap for five short lines, but not free, and completely wasted on the many
   * frames where nothing about them has changed. These three remember the last drawing so the
   * frame loop can skip the rebuild until one of them moves.
   */
  drawnDim: number;
  drawnShade: number;
  drawnLeft: number;
}

/** Everything about where the columns sit, recomputed from the stage size every frame. */
interface Layout {
  /** Left edge of each column, in stage pixels. */
  left: number[];
  /** Width of one column after the fit-to-frame squeeze. */
  width: number;
  /** Y of the baseline rule the piles stand on. */
  baseY: number;
  /** Edge length of a drawn token after the fit-to-frame squeeze. */
  token: number;
  /** Horizontal distance between neighbouring slot centres. */
  pitch: number;
  /** Vertical distance between rows. */
  rowPitch: number;
  /** How many slots fit in an even-numbered (unshifted) row. */
  perEvenRow: number;
  /** How many fit in an odd-numbered row, which is shifted half a pitch to interlock. */
  perOddRow: number;
}

/**
 * Bakes the shared token bitmap: one white rounded square with a gentle top-to-bottom shade.
 *
 * White is deliberate — Pixi's `tint` multiplies, so a white source takes any voter colour
 * faithfully, while the built-in shading survives the multiply and gives each token a hint of
 * three-dimensional bevel instead of reading as a flat rectangle of colour.
 *
 * The rounded corners are traced with `arcTo` rather than the newer `roundRect`, which keeps this
 * working on any 2D canvas implementation the OBS browser source might present.
 */
function makeTokenTexture(): PIXI.Texture {
  const size = TOKEN_TEXTURE_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext("2d");
  if (g) {
    const inset = size * TOKEN_TEXTURE_INSET;
    const side = TOKEN_VISIBLE_SIZE;
    const radius = side * 0.24;
    const right = inset + side;
    const bottom = inset + side;

    g.beginPath();
    g.moveTo(inset + radius, inset);
    g.arcTo(right, inset, right, bottom, radius);
    g.arcTo(right, bottom, inset, bottom, radius);
    g.arcTo(inset, bottom, inset, inset, radius);
    g.arcTo(inset, inset, right, inset, radius);
    g.closePath();

    const shade = g.createLinearGradient(0, inset, 0, bottom);
    shade.addColorStop(0, "rgb(255,255,255)");
    shade.addColorStop(0.55, "rgb(232,232,232)");
    shade.addColorStop(1, "rgb(190,190,190)");
    g.fillStyle = shade;
    g.fill();
  }
  return PIXI.Texture.from(canvas);
}

/** Splits a comma-separated parameter into trimmed, non-empty entries. */
function parseList(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Reads a chat message's colour as a 24-bit integer, falling back to its per-user seed.
 *
 * Both fields are typed as present, but the message came off a WebSocket as JSON and nothing
 * revalidates it, so a backend that ever sends a malformed frame must not be able to write `NaN`
 * into a sprite tint — a `NaN` tint is not a wrong colour, it is a sprite Pixi cannot draw.
 */
function chatColorInt(message: ChatMessage): number {
  if (typeof message.color === "string" && HEX_COLOR.test(message.color)) {
    return Number.parseInt(message.color.slice(1), 16);
  }
  // `seed` is documented as a deterministic 0..0xFFFFFF per user, which is already a valid colour.
  return Number.isFinite(message.seed) ? message.seed & 0xffffff : 0xffffff;
}

/** Mixes two 24-bit colours channel by channel; `t` of 0 gives `a`, 1 gives `b`. */
function mixColor(a: number, b: number, t: number): number {
  const k = Math.min(1, Math.max(0, t));
  const r = Math.round(((a >> 16) & 0xff) + (((b >> 16) & 0xff) - ((a >> 16) & 0xff)) * k);
  const g = Math.round(((a >> 8) & 0xff) + (((b >> 8) & 0xff) - ((a >> 8) & 0xff)) * k);
  const bl = Math.round((a & 0xff) + ((b & 0xff) - (a & 0xff)) * k);
  return (r << 16) | (g << 8) | bl;
}

const showOfHands = defineEffect({
  descriptor: {
    id: "show-of-hands",
    name: "Show of Hands",
    description:
      "A chat poll whose tally is a physical heap: each vote drops in as a small token tinted with the voter's chat colour, falls, bounces and settles into a hexagonally-packed pile at the base of its column.",
    engine: "pixi",
    category: "chat",
    tags: ["chat", "twitch", "poll", "vote", "physics", "interactive", "overlay", "pixi"],
    previewNotes:
      "Transparent — lay it over a game or a camera; it only occupies the strip above the baseline. Viewers vote by typing a keyword as the first word of a message. When Twitch is not configured the SDK feeds a simulated chat, which casts no real votes, so leave Demo Votes on while positioning the poll: the invented tally is cleared the moment you switch that off or the moment real chat connects, so it can never be mistaken for votes your audience cast.",
    params: [
      {
        key: "options",
        label: "Vote Keywords",
        kind: "text",
        default: DEFAULT_OPTIONS,
        description:
          "Comma-separated keywords, one per column, matched against the first word of a chat message and ignoring capitals. Editing this starts a fresh poll — it is how you reset the tally, since chat itself carries no way to tell a moderator from a viewer.",
      },
      {
        key: "labels",
        label: "Column Labels",
        kind: "text",
        default: DEFAULT_LABELS,
        description:
          "Comma-separated labels shown under each baseline beside its keyword. A missing label leaves the keyword standing on its own.",
      },
      {
        key: "maxTokens",
        label: "Maximum Tokens",
        kind: "number",
        default: 320,
        min: 20,
        max: 1200,
        step: 1,
        description:
          "How many tokens may exist across every pile at once. Beyond this, the oldest token is recycled into the newest vote, which keeps a runaway poll from growing without limit.",
      },
      {
        key: "tokenSize",
        label: "Token Size",
        kind: "number",
        default: 10,
        min: 4,
        max: 30,
        step: 1,
        description: "Edge length of one token in pixels, before any squeeze to fit the frame.",
      },
      {
        key: "columnWidth",
        label: "Column Width",
        kind: "number",
        default: 220,
        min: 40,
        max: 700,
        step: 5,
        description:
          "Width of one pile in pixels. Wider piles hold more tokens per row and therefore grow more slowly.",
      },
      {
        key: "columnGap",
        label: "Column Gap",
        kind: "number",
        default: 56,
        min: 0,
        max: 300,
        step: 2,
        description: "Empty space between neighbouring piles, in pixels.",
      },
      {
        key: "baselineY",
        label: "Baseline Position",
        kind: "number",
        default: 0.84,
        min: 0.2,
        max: 0.98,
        step: 0.01,
        description:
          "Where the baseline rule sits, as a fraction of the frame height. 0 is the top edge and 1 the bottom; the piles grow upward from it and the labels sit under it.",
      },
      {
        key: "oneVotePerUser",
        label: "One Vote Per Viewer",
        kind: "boolean",
        default: true,
        description:
          "On: each viewer owns exactly one token, so the piles count people. Off: every matching message drops another token, so the piles count messages and a determined viewer can stack them.",
      },
      {
        key: "allowChangeVote",
        label: "Allow Vote Changes",
        kind: "boolean",
        default: true,
        description:
          "On: voting for a different column lifts that viewer's token out of its pile and arcs it across into the other one. Off: the first vote is final and later ones are ignored. Has no effect unless One Vote Per Viewer is on.",
      },
      {
        key: "dropSeconds",
        label: "Drop Time",
        kind: "number",
        default: 0.62,
        min: 0.25,
        max: 2,
        step: 0.05,
        description:
          "Roughly how long a token takes to fall and settle. Shorter is a stiffer spring and a snappier landing.",
      },
      {
        key: "bounce",
        label: "Bounce",
        kind: "number",
        default: 0.45,
        min: 0,
        max: 1,
        step: 0.05,
        description:
          "How far a landing token overshoots its slot before settling back. 0 glides to a stop with no overshoot at all.",
      },
      {
        key: "jitter",
        label: "Table Shiver",
        kind: "number",
        default: 1,
        min: 0,
        max: 4,
        step: 0.1,
        description:
          "How much the settled piles shiver with the room's loudness, in pixels at full volume, plus a small nudge on each detected transient. 0 ignores audio entirely.",
      },
      {
        key: "tintFromChat",
        label: "Tint From Chat",
        kind: "boolean",
        default: true,
        description:
          "On: each token takes the voter's own Twitch chat colour, so a pile is literally made of the audience. Off: every token takes its column's palette colour, for a stricter look.",
      },
      paletteParam(
        "palette",
        "Palette",
        "signal",
        "Colour ramp for the labels, the baseline rules, and the tokens themselves when Tint From Chat is off.",
      ),
      {
        key: "showCounts",
        label: "Show Counts",
        kind: "boolean",
        default: true,
        description:
          "Print the exact tally under each baseline. Off leaves the pile heights to speak for themselves.",
      },
      {
        key: "labelFontSize",
        label: "Label Size",
        kind: "number",
        default: 15,
        min: 9,
        max: 40,
        step: 1,
        description: "Height of the column labels and counts in pixels.",
      },
      {
        key: "dimLosers",
        label: "Dim The Losers",
        kind: "boolean",
        default: true,
        description:
          "Once one column is at least two votes clear of the next, fade and grey the others so the result reads at a glance. They come back the moment the gap closes.",
      },
      {
        key: "demoVotes",
        label: "Demo Votes",
        kind: "boolean",
        default: true,
        description:
          "Cast synthetic votes while the chat feed is simulated, so the poll can be sized and positioned before Twitch is configured. Real chat always takes over the moment it connects.",
      },
      {
        key: "raidBurst",
        label: "Raid Burst",
        kind: "boolean",
        default: false,
        description:
          "Off by default because it is showmanship rather than counting: when on, a raid drops one token per ten raiders (at most forty) into whichever column is currently ahead, tinted with the raider's colour. Those tokens belong to nobody, so nobody can move or replace them — they only leave when Maximum Tokens recycles them along with everything else of their age.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    let optionsText = str(ctx.params, "options", DEFAULT_OPTIONS);
    let labelsText = str(ctx.params, "labels", DEFAULT_LABELS);
    let maxTokens = int(ctx.params, "maxTokens", 320, 20, 1200);
    let tokenSize = num(ctx.params, "tokenSize", 10, 4, 30);
    let columnWidth = num(ctx.params, "columnWidth", 220, 40, 700);
    let columnGap = num(ctx.params, "columnGap", 56, 0, 300);
    let baselineFraction = num(ctx.params, "baselineY", 0.84, 0.2, 0.98);
    let oneVotePerUser = bool(ctx.params, "oneVotePerUser", true);
    let allowChangeVote = bool(ctx.params, "allowChangeVote", true);
    let dropSeconds = num(ctx.params, "dropSeconds", 0.62, 0.25, 2);
    let bounce = num(ctx.params, "bounce", 0.45, 0, 1);
    let jitter = num(ctx.params, "jitter", 1, 0, 4);
    let tintFromChat = bool(ctx.params, "tintFromChat", true);
    let colors = palette(ctx.params, "palette", "signal");
    let showCounts = bool(ctx.params, "showCounts", true);
    let labelFontSize = int(ctx.params, "labelFontSize", 15, 9, 40);
    let dimLosers = bool(ctx.params, "dimLosers", true);
    let demoVotes = bool(ctx.params, "demoVotes", true);
    let raidBurst = bool(ctx.params, "raidBurst", false);

    /*
     * The label size is fixed before anything is measured. A web font that is still downloading
     * measures as the fallback, which would put the labels and counts at the wrong width for the
     * first second and then reflow them on air. `useFont` never rejects and never waits longer than
     * two seconds, and a family the machine already has installed resolves immediately, so this
     * costs nothing in the common case.
     */
    await useFont(`${labelFontSize}px Inter`);
    scope.checkpoint();

    const bus = await useAudio(scope);
    scope.checkpoint();

    const chat = await useChat(scope);
    scope.checkpoint();

    const stage = await createPixiStage(scope, ctx, { antialias: true });
    scope.checkpoint();

    const envelopes = createEnvelopes(bus);

    /*
     * The texture is not registered on the scope. `createPixiStage` already registered
     * `app.destroy(true, { children: true, texture: true, textureSource: true })`, which frees this
     * bitmap along with its GPU source. Owning it separately would free it a second time, because
     * the scope tears down in reverse registration order and would reach this before the
     * application.
     */
    const tokenTexture = makeTokenTexture();

    /* Draw order, back to front: the baseline rules, then the piles, then the headings. */
    const rules = stage.stage.addChild(new PIXI.Graphics());
    const tokenLayer = stage.stage.addChild(new PIXI.Container());
    const headLayer = stage.stage.addChild(new PIXI.Container());

    let columns: Column[] = [];

    /**
     * The palette colour of each column, indexed exactly like `columns`.
     *
     * Sampling a colour ramp allocates a small array for the three channels it mixes. That is
     * nothing at all a handful of times, and a real cost once per token per frame: with Tint From
     * Chat off, a pile of a thousand counters would sample the same two colours a thousand times
     * every frame and hand the garbage collector a thousand short-lived arrays with it. The sample
     * is therefore taken only when the palette or the column set actually changes, and both the
     * heading loop and the token loop read the answer out of here.
     */
    const baseColors: number[] = [];

    /** Every token ever created, active or not. Its length is what Maximum Tokens caps. */
    const pool: Token[] = [];
    /** Inactive tokens waiting to be reused, with their sprites hidden. */
    const free: Token[] = [];
    /** Active tokens, oldest first — which makes recycling under pressure a `shift`. */
    const order: Token[] = [];
    /** Which token belongs to which login, for one-vote-per-viewer and vote changes. */
    const votes = new Map<string, Token>();

    /** Reused every frame so the layout maths allocates nothing in the animation loop. */
    const layout: Layout = {
      left: [],
      width: 1,
      baseY: 1,
      token: 1,
      pitch: 1,
      rowPitch: 1,
      perEvenRow: 1,
      perOddRow: 1,
    };

    /**
     * The frame-wide half of the baseline-rule cache: the geometry the rules were last drawn at.
     * The per-column half lives in `Column.drawn*`. `NaN` forces the first frame to draw.
     */
    let rulesColumns = -1;
    let rulesBaseY = Number.NaN;
    let rulesWidth = Number.NaN;

    /** Seconds until the next synthetic vote in demo mode. */
    let demoTimer = 0.4;

    /** Whether demo mode has placed its opening handful of votes for the current question. */
    let demoSeeded = false;

    /** Whether any synthetic vote is currently on screen, so the sweep below is skipped when not. */
    let demoPlaced = false;

    /**
     * True only while `castDemoVote` is inside `castVote`, so `dropToken` knows to mark what it
     * creates as synthetic. A flag rather than an extra argument because a vote change reaches
     * `dropToken` through two other functions, and threading a parameter through all of them would
     * put a "this is a demo vote" argument on code paths that have nothing to do with demo mode.
     */
    let castingDemo = false;

    /** The colour a column's label, rule and (with Tint From Chat off) tokens take. */
    const columnColor = (index: number): number => {
      const span = columns.length > 1 ? index / (columns.length - 1) : 0.5;
      // The bottom of a ramp is usually its near-black end, which would be invisible as a label,
      // so the sample is kept to the upper two thirds of the ramp.
      return paletteAtInt(colors, 0.34 + span * 0.62);
    };

    /** Re-samples every column's palette colour. Call after the palette or the column set changes. */
    const refreshColumnColors = (): void => {
      baseColors.length = columns.length;
      for (let i = 0; i < columns.length; i += 1) baseColors[i] = columnColor(i);
    };

    const makeLabelText = (): PIXI.Text =>
      new PIXI.Text({
        text: "",
        style: {
          fontFamily: LABEL_FONT_STACK,
          fontSize: labelFontSize,
          fontWeight: "600",
          // Uppercase text with a little tracking is how a small-caps look is faked here; Pixi has
          // no font-variant control, and few installed families carry real small caps anyway.
          letterSpacing: labelFontSize * 0.12,
          fill: 0xffffff,
        },
      });

    const makeCountText = (): PIXI.Text =>
      new PIXI.Text({
        text: "0",
        style: {
          fontFamily: COUNT_FONT_STACK,
          fontSize: labelFontSize,
          fontWeight: "700",
          fill: 0xffffff,
        },
      });

    /**
     * Pushes the colour and size into a column's two text styles — but only when one of them has
     * actually changed.
     *
     * Writing to a `TextStyle` is not free: it marks the text dirty, which makes Pixi rasterise the
     * glyphs into a new texture on the next render. That is the right cost to pay when the palette
     * or the label size changes, and the wrong one to pay sixty times a second.
     */
    const restyleHead = (column: Column, color: number): void => {
      if (column.styledColor === color && column.styledSize === labelFontSize) return;
      column.styledColor = color;
      column.styledSize = labelFontSize;
      column.labelView.style.fontSize = labelFontSize;
      column.labelView.style.letterSpacing = labelFontSize * 0.12;
      column.labelView.style.fill = color;
      column.countView.style.fontSize = labelFontSize;
      column.countView.style.fill = color;
    };

    /** Hides a token and returns it to the free list, forgetting whose vote it was. */
    const retire = (token: Token): void => {
      token.active = false;
      token.sprite.visible = false;
      token.voter = "";
      free.push(token);
    };

    /**
     * Takes a token out of its column and closes the hole it leaves.
     *
     * The token that was on top of the pile drops into the vacated slot — one token re-springs, not
     * the whole heap. That bound is what keeps a busy poll cheap: a vote change can never cost more
     * than two moving tokens however tall the pile is.
     */
    const detachFromColumn = (token: Token): void => {
      const column = columns[token.col];
      if (column === undefined) return;

      /*
       * Trust, but verify.
       *
       * Everything here rests on one invariant: `column.tokens[token.slot]` is this very token. If
       * that ever came apart, popping the top and writing it to a stale `slot` would delete
       * somebody else's vote and leave a literal hole in the array — an `undefined` entry that the
       * count would still include and that `slotX` would place at the wrong end of the pile. The
       * check is one array read on the path that always holds, and the fallback scan costs one pass
       * over a single pile in a case that should never happen at all.
       */
      const index = column.tokens[token.slot] === token ? token.slot : column.tokens.indexOf(token);
      if (index < 0) return;

      const top = column.tokens.pop();
      if (top !== undefined && top !== token) {
        column.tokens[index] = top;
        top.slot = index;
      }
    };

    /**
     * Sends the oldest token on screen back to the pool: out of its pile, out of the vote map, out
     * of the active list.
     *
     * This is what "recycle the oldest" means when the pool is at its cap. Taking the oldest rather
     * than a random one is the least surprising choice for a viewer — the token that disappears is
     * the one that has been sitting there longest — and it costs a single `shift`.
     */
    const retireOldest = (): Token | null => {
      const oldest = order.shift();
      if (oldest === undefined) return null;
      detachFromColumn(oldest);
      if (oldest.voter.length > 0 && votes.get(oldest.voter) === oldest) {
        votes.delete(oldest.voter);
      }
      retire(oldest);
      return oldest;
    };

    /** Empties every pile back into the pool. Used when the question itself changes. */
    const releaseAll = (): void => {
      for (const token of order.slice()) retire(token);
      order.length = 0;
      votes.clear();
      demoPlaced = false;
      for (const column of columns) column.tokens.length = 0;
    };

    /**
     * Retires every synthetic vote and leaves the real ones standing.
     *
     * This is what makes "Real chat always takes over the moment it connects" true rather than a
     * hope: the seeded preview pile is removed the first frame demo mode stops applying, whether
     * that is because the operator switched Demo Votes off or because Twitch finally connected. A
     * poll that opened with sixteen invented votes would otherwise carry them for the whole stream.
     *
     * The scan walks `order` backwards so removing an entry cannot shift an index it has not
     * reached yet, and each removal goes through `detachFromColumn`, which closes the hole in the
     * pile exactly the way a vote change does.
     */
    const releaseDemoVotes = (): void => {
      for (let i = order.length - 1; i >= 0; i -= 1) {
        const token = order[i];
        if (token === undefined || !token.demo) continue;
        order.splice(i, 1);
        detachFromColumn(token);
        if (token.voter.length > 0 && votes.get(token.voter) === token) votes.delete(token.voter);
        retire(token);
      }
      demoPlaced = false;
      // If demo mode ever applies again — the operator switches it back on, or Twitch drops out —
      // it should open with a full preview pile rather than a slow trickle into an empty frame.
      demoSeeded = false;
    };

    /**
     * Finds a token to use for a new vote: a free one, a newly created one while the pool is under
     * its cap, or — as a last resort — the oldest token currently on screen.
     */
    const acquire = (): Token | null => {
      const reused = free.pop();
      if (reused !== undefined) return reused;

      if (pool.length < maxTokens) {
        const sprite = new PIXI.Sprite(tokenTexture);
        sprite.anchor.set(0.5); // so position and rotation are about the token's centre
        tokenLayer.addChild(sprite);
        const token: Token = {
          sprite,
          active: false,
          col: 0,
          slot: 0,
          x: 0,
          y: 0,
          vx: 0,
          vy: 0,
          tilt: 0,
          chatTint: 0xffffff,
          appliedTint: -1,
          voter: "",
          demo: false,
          phase: 0,
        };
        pool.push(token);
        return token;
      }

      if (retireOldest() === null) return null;
      return free.pop() ?? null;
    };

    /** Destroys free tokens until the pool fits inside a reduced Maximum Tokens. */
    const trimPool = (): void => {
      while (pool.length > maxTokens) {
        // Retire an active token first when there is nothing spare, so the loop always terminates.
        if (free.length === 0 && retireOldest() === null) break;
        const spare = free.pop();
        if (spare === undefined) break;
        const index = pool.indexOf(spare);
        if (index >= 0) pool.splice(index, 1);
        tokenLayer.removeChild(spare.sprite);
        // `false`, because the rounded-square texture is shared by every other token.
        spare.sprite.destroy(false);
      }
    };

    /**
     * The horizontal centre of one lattice slot.
     *
     * Slots are numbered from the bottom-left of the pile upwards, and the rows alternate between a
     * full row and a shorter one nudged half a token to the right, which is what makes the tokens
     * interlock. Rather than walk the rows to find which one a slot number lands in — which would
     * cost a loop per token per frame once a pile is tall — the two row lengths are added into a
     * "pair", and a division by that pair jumps straight to the answer.
     */
    const slotX = (columnIndex: number, slot: number): number => {
      const left = layout.left[columnIndex] ?? 0;
      const pair = layout.perEvenRow + layout.perOddRow;
      const remainder = slot % pair;
      const inEvenRow = remainder < layout.perEvenRow;
      const indexInRow = inEvenRow ? remainder : remainder - layout.perEvenRow;
      // Even rows are centred in the column; odd rows are shifted half a pitch so they interlock.
      // A column only one token wide skips the shift, or its odd rows would lean out of the column.
      const rowWidth = layout.perEvenRow * layout.pitch;
      const margin = (layout.width - rowWidth) / 2;
      const shift = inEvenRow || layout.perEvenRow < 2 ? 0 : layout.pitch / 2;
      return left + margin + layout.pitch / 2 + indexInRow * layout.pitch + shift;
    };

    /** The vertical centre of one lattice slot, counted upward from the baseline rule. */
    const slotY = (slot: number): number => {
      const pair = layout.perEvenRow + layout.perOddRow;
      const rowPairs = Math.floor(slot / pair);
      const remainder = slot % pair;
      const row = remainder < layout.perEvenRow ? rowPairs * 2 : rowPairs * 2 + 1;
      return layout.baseY - layout.token / 2 - row * layout.rowPitch;
    };

    /**
     * Recomputes the column geometry from the current stage size.
     *
     * Done every frame rather than only on resize: it is a dozen arithmetic operations, and doing
     * it unconditionally means a resize, a parameter change and the very first frame all take the
     * same path — there is no second, subtly different code path to get wrong.
     */
    const updateLayout = (): void => {
      const count = Math.max(1, columns.length);
      const width = Math.max(1, stage.width);
      const height = Math.max(1, stage.height);

      const wanted = count * columnWidth + (count - 1) * columnGap;
      // If the configured columns are wider than the frame, everything shrinks together rather
      // than spilling off the edges — including the tokens, so the packing stays honest.
      const squeeze = Math.min(1, (width * 0.94) / Math.max(1, wanted));

      layout.width = columnWidth * squeeze;
      layout.token = Math.max(2, tokenSize * squeeze);
      layout.pitch = layout.token * (1 + SLOT_GAP);
      layout.rowPitch = layout.pitch * ROW_PITCH_FACTOR;
      layout.perEvenRow = Math.max(1, Math.floor(layout.width / layout.pitch));
      layout.perOddRow = Math.max(1, layout.perEvenRow - 1);

      const total = count * layout.width + (count - 1) * columnGap * squeeze;
      const startX = (width - total) / 2;
      layout.left.length = count;
      for (let i = 0; i < count; i += 1) {
        layout.left[i] = startX + i * (layout.width + columnGap * squeeze);
      }

      /*
       * The baseline is held far enough off the bottom for the label and the count to fit under it,
       * and far enough off the top that a token has somewhere to land. On a canvas too short for
       * both — a sliver of a browser source — the second clamp wins and the labels run off the
       * bottom, which is the failure that still leaves the piles readable.
       */
      const headroom = labelFontSize * 2.4 + 10;
      layout.baseY = Math.max(layout.token, Math.min(height * baselineFraction, height - headroom));
    };

    /**
     * Builds the column set from the keyword and label parameters.
     *
     * Every existing vote is dropped, because a changed keyword list is a different question. That
     * is also the only reset this effect offers — see the file header on why chat cannot be trusted
     * with one.
     */
    const buildColumns = (): void => {
      releaseAll();
      // A new question deserves a fresh demo pile too, or the preview would stay empty after an
      // edit until the slow trickle of synthetic votes refilled it.
      demoSeeded = false;
      for (const column of columns) column.head.destroy({ children: true });
      columns = [];

      const keywords = parseList(optionsText.toLowerCase()).slice(0, MAX_COLUMNS);
      const labels = parseList(labelsText);
      const effective = keywords.length > 0 ? keywords : parseList(DEFAULT_OPTIONS);

      effective.forEach((keyword, index) => {
        const head = headLayer.addChild(new PIXI.Container());
        const labelView = head.addChild(makeLabelText());
        const countView = head.addChild(makeCountText());
        const label = labels[index] ?? "";
        labelView.text = label.length > 0 ? `${keyword} · ${label.toUpperCase()}` : keyword;
        columns.push({
          keyword,
          label,
          head,
          labelView,
          countView,
          tokens: [],
          shownCount: -1,
          styledColor: -1,
          styledSize: -1,
          dim: 1,
          drawnDim: Number.NaN,
          drawnShade: -1,
          drawnLeft: Number.NaN,
        });
      });

      refreshColumnColors();
      updateLayout();
    };

    /**
     * Drops one token into a column.
     *
     * `instant` places it directly in its slot with no animation, which is what seeding from the
     * chat backlog wants: reloading a scene should show the tally that already exists, not a shower
     * of two dozen tokens arriving at once.
     */
    const dropToken = (
      columnIndex: number,
      tint: number,
      voter: string,
      instant: boolean,
    ): void => {
      const column = columns[columnIndex];
      if (column === undefined) return;
      const token = acquire();
      if (token === null) return;

      token.active = true;
      token.sprite.visible = true;
      token.col = columnIndex;
      token.slot = column.tokens.length;
      token.chatTint = tint;
      token.voter = voter;
      token.demo = castingDemo;
      if (castingDemo) demoPlaced = true;
      token.tilt = ((Math.random() * 2 - 1) * MAX_TILT_DEG * Math.PI) / 180;
      token.phase = Math.random() * Math.PI * 2;

      column.tokens.push(token);
      order.push(token);
      if (voter.length > 0) votes.set(voter, token);

      const targetX = slotX(columnIndex, token.slot);
      const targetY = slotY(token.slot);
      if (instant) {
        token.x = targetX;
        token.y = targetY;
      } else {
        // A small horizontal scatter at the release point stops a run of votes falling down one
        // perfectly straight line, which would read as a machine feeding counters into a slot.
        token.x = targetX + (Math.random() * 2 - 1) * layout.pitch * 0.4;
        token.y = -layout.token * 2;
      }
      token.vx = 0;
      token.vy = 0;
    };

    /** Moves an existing token to another column, arcing it across the gap. */
    const migrateToken = (token: Token, columnIndex: number): void => {
      const target = columns[columnIndex];
      if (target === undefined) return;

      detachFromColumn(token);
      token.col = columnIndex;
      token.slot = target.tokens.length;
      target.tokens.push(token);

      // The upward kick is what turns a straight slide into an arc: the spring is still pulling the
      // token sideways and down, so a lift proportional to the distance travelled peaks about
      // halfway across, whatever the gap between the piles happens to be.
      const distance = Math.abs(slotX(columnIndex, token.slot) - token.x);
      token.vy -= (distance * MIGRATION_LIFT) / Math.max(0.1, dropSeconds);
    };

    /** Index of the column whose keyword the message begins with, or -1. */
    const matchColumn = (text: string): number => {
      // Typed as a string, but it arrived as JSON over a WebSocket and nothing revalidated it. A
      // missing field would make `.trim()` throw, and this runs inside a chat listener and inside
      // the setup's backlog loop — the second of which would take the whole effect down with it.
      if (typeof text !== "string") return -1;
      const first = text.trim().split(/\s+/)[0];
      if (first === undefined || first.length === 0) return -1;
      const word = first.toLowerCase();
      return columns.findIndex((column) => column.keyword === word);
    };

    /** Applies one vote from `voter`, honouring the one-vote and vote-change rules. */
    const castVote = (columnIndex: number, voter: string, tint: number, instant: boolean): void => {
      if (!oneVotePerUser) {
        // Counting messages rather than people: every token is anonymous, so none of them can be
        // moved later, and the vote map stays empty.
        dropToken(columnIndex, tint, "", instant);
        return;
      }

      const existing = votes.get(voter);
      if (existing === undefined || !existing.active) {
        dropToken(columnIndex, tint, voter, instant);
        return;
      }
      if (existing.col === columnIndex) return; // voting the same way twice changes nothing
      if (!allowChangeVote) return;

      existing.chatTint = tint;
      if (instant) {
        // Seeding from the backlog: the later message simply wins, with no animation. The target
        // is checked before anything is detached, so a bad index cannot orphan a live token.
        const target = columns[columnIndex];
        if (target === undefined) return;
        detachFromColumn(existing);
        existing.col = columnIndex;
        existing.slot = target.tokens.length;
        target.tokens.push(existing);
        existing.x = slotX(columnIndex, existing.slot);
        existing.y = slotY(existing.slot);
        existing.vx = 0;
        existing.vy = 0;
      } else {
        migrateToken(existing, columnIndex);
      }
    };

    /** Turns one chat message into whatever it is worth: a vote, a raid burst, or nothing. */
    const handleMessage = (message: ChatMessage, instant: boolean): void => {
      if (message.event === "raid" && raidBurst) {
        // A raid carries no opinion, so this is openly a piece of showmanship: the arriving crowd
        // piles onto whichever side the room is already on. One token per ten raiders keeps a big
        // raid from burying the votes that were actually cast.
        const viewers = Number(message.data["viewers"]);
        const burst = Number.isFinite(viewers) ? Math.floor(Math.min(40, viewers / 10)) : 0;
        if (burst <= 0) return;
        let leader = 0;
        for (let i = 1; i < columns.length; i += 1) {
          const column = columns[i];
          const best = columns[leader];
          if (
            column !== undefined &&
            best !== undefined &&
            column.tokens.length > best.tokens.length
          ) {
            leader = i;
          }
        }
        const tint = chatColorInt(message);
        for (let i = 0; i < burst; i += 1) dropToken(leader, tint, "", instant);
        return;
      }

      const columnIndex = matchColumn(message.text);
      if (columnIndex < 0) return;

      /*
       * A vote has to come from somebody.
       *
       * `votes` is keyed by login, so a message with no login would look up the same empty key
       * every time and always miss — which would quietly let anonymous messages drop an unlimited
       * number of tokens straight past One Vote Per Viewer, the one rule that makes the piles count
       * people. Ignoring them is the honest reading: an unattributable message is not a vote.
       */
      const voter = typeof message.username === "string" ? message.username : "";
      if (oneVotePerUser && voter.length === 0) return;
      castVote(columnIndex, voter, chatColorInt(message), instant);
    };

    buildColumns();

    /*
     * Seed from the history the chat bus already holds, so a scene that comes back up mid-poll
     * shows the tally rather than an empty frame. These are placed instantly for the same reason.
     */
    for (const message of chat.recent()) handleMessage(message, true);
    scope.defer(chat.onMessage((message) => handleMessage(message, false)));

    /**
     * Casts one synthetic vote, used only while the chat feed is simulated.
     *
     * Each invented viewer has a settled opinion, derived from their number, and votes against it
     * roughly one time in six. Purely random votes would keep every pile the same height, which
     * would show neither a lead nor the dimming that follows one; a stable preference with the
     * occasional change of heart produces the uneven split and the occasional migrating token that
     * a real poll produces.
     */
    const castDemoVote = (instant: boolean): void => {
      if (columns.length === 0) return;
      const number = Math.floor(Math.random() * DEMO_VOTERS);
      const preference = (number * 7 + 1) % columns.length;
      const contrary = Math.random() < 0.16;
      const columnIndex = contrary
        ? Math.floor(Math.random() * columns.length) % columns.length
        : preference;
      const tint = DEMO_COLORS[number % DEMO_COLORS.length] ?? 0xffffff;
      castingDemo = true;
      try {
        castVote(Math.min(columns.length - 1, columnIndex), `demo-${number}`, tint, instant);
      } finally {
        // `finally` rather than a plain assignment after the call: leaving this flag set would make
        // every subsequent real vote look synthetic and be swept away the moment demo mode stops.
        castingDemo = false;
      }
    };

    onFrame(scope, ctx.fpsCap, ({ dt, elapsed, now }) => {
      bus.sample(now);
      envelopes.update(dt);

      updateLayout();

      if (demoVotes && chat.source === "simulated") {
        /*
         * A poll with nothing in it is not a preview of anything, so demo mode opens with a handful
         * of votes already cast, placed instantly rather than rained in. After that the synthetic
         * votes arrive one at a time, which is what shows the drop and the migration.
         */
        if (!demoSeeded) {
          for (let i = 0; i < DEMO_SEED_VOTES; i += 1) castDemoVote(true);
          demoSeeded = true;
        }
        demoTimer -= dt;
        if (demoTimer <= 0) {
          castDemoVote(false);
          demoTimer = DEMO_MIN_GAP_S + Math.random() * (DEMO_MAX_GAP_S - DEMO_MIN_GAP_S);
        }
      } else {
        // Demo mode no longer applies — either the operator switched it off or real chat arrived —
        // so the invented votes go, leaving whatever real chat has cast standing on its own.
        if (demoPlaced) releaseDemoVotes();
        // Do not let a long spell of live chat bank enough credit to fire a burst of synthetic
        // votes the moment the feed happens to fall back to simulated.
        demoTimer = Math.max(demoTimer, DEMO_MIN_GAP_S);
      }

      /* Which column leads, and by how much, for the dimming decision. */
      let leader = -1;
      let bestCount = -1;
      let runnerUpCount = -1;
      for (let i = 0; i < columns.length; i += 1) {
        const count = columns[i]?.tokens.length ?? 0;
        if (count > bestCount) {
          runnerUpCount = bestCount;
          bestCount = count;
          leader = i;
        } else if (count > runnerUpCount) {
          runnerUpCount = count;
        }
      }
      const decided =
        dimLosers && bestCount >= LEAD_MARGIN && bestCount - runnerUpCount >= LEAD_MARGIN;

      // Per-frame decay converted to per-second, so the fade takes the same time at 30 fps as at
      // 144 fps rather than being three times faster on the quicker display.
      const dimRetention = Math.pow(DIM_DECAY, dt * 60);

      /*
       * The baseline rules are only re-recorded when something about them has moved. On a still
       * frame — no resize, no vote, the dimming already settled — the `Graphics` is left exactly as
       * it was and costs nothing but the draw call it would have cost anyway.
       */
      let rulesDirty =
        rulesColumns !== columns.length ||
        rulesBaseY !== layout.baseY ||
        rulesWidth !== layout.width;

      for (let i = 0; i < columns.length; i += 1) {
        const column = columns[i];
        if (column === undefined) continue;
        const target = decided && i !== leader ? DIM_ALPHA : 1;
        column.dim = target + (column.dim - target) * dimRetention;
        // An exponential ease approaches its target without ever arriving, which would leave the
        // rules a hair different on every frame forever and defeat the check above. Below a
        // fifth of a percent the difference is invisible, so it is snapped away.
        if (Math.abs(column.dim - target) < 0.002) column.dim = target;

        const base = baseColors[i] ?? 0xffffff;
        const shade = mixColor(base, DIM_GREY, 1 - column.dim);
        const left = layout.left[i] ?? 0;

        if (column.drawnDim !== column.dim || column.drawnShade !== shade) rulesDirty = true;
        if (column.drawnLeft !== left) rulesDirty = true;
        column.drawnDim = column.dim;
        column.drawnShade = shade;
        column.drawnLeft = left;

        restyleHead(column, base);

        /*
         * The dimming is applied as a tint and an alpha on the heading *container*, never by
         * rewriting the text style. Assigning to a `TextStyle` marks the text dirty and re-draws
         * its glyphs into a fresh texture; doing that every frame of a one-second fade, for every
         * column, would rasterise text sixty times a second for no visible gain. A container tint
         * is a single number the GPU multiplies while drawing.
         */
        column.head.alpha = column.dim;
        column.head.tint = mixColor(0xffffff, DIM_GREY, 1 - column.dim);

        const count = column.tokens.length;
        if (count !== column.shownCount) {
          column.countView.text = String(count);
          column.shownCount = count;
        }
        column.countView.visible = showCounts;

        column.labelView.x = left;
        column.labelView.y = layout.baseY + labelFontSize * 0.55;
        column.countView.x = left + layout.width - column.countView.width;
        column.countView.y = layout.baseY + labelFontSize * 0.55;
      }

      if (rulesDirty) {
        rulesColumns = columns.length;
        rulesBaseY = layout.baseY;
        rulesWidth = layout.width;
        rules.clear();
        for (const column of columns) {
          rules
            .moveTo(column.drawnLeft, layout.baseY)
            .lineTo(column.drawnLeft + layout.width, layout.baseY)
            .stroke({ color: column.drawnShade, alpha: 0.85 * column.drawnDim, width: 1 });
        }
      }

      /*
       * The spring. `omega` is stiffness — a shorter drop time means a stiffer spring — and `zeta`
       * is friction, where 1 settles without overshoot and lower values overshoot more. Both are
       * clamped: a spring stiffer than the integrator can follow would fling tokens off screen.
       */
      const omega = Math.min(MAX_OMEGA, (Math.PI * 2) / Math.max(0.1, dropSeconds));
      const zeta = 1 - bounce * 0.55;
      /*
       * A long frame is split into several short physics steps rather than simulated in one big
       * one. Simply clamping the step would be simpler, but it would run the fall in slow motion on
       * a 30 fps machine — the tokens would cover less ground per second than on a 60 fps one. The
       * shared clock already caps `dt` at 100 ms, so this is at most four steps.
       */
      const steps = Math.max(1, Math.ceil(dt / MAX_PHYSICS_STEP));
      const step = dt / steps;
      const shiver = jitter * envelopes.fast;
      const kick = envelopes.beat ? BEAT_KICK * Math.min(1, jitter) : 0;
      const scale = layout.token / TOKEN_VISIBLE_SIZE;

      for (const token of order) {
        const targetX = slotX(token.col, token.slot);
        const targetY = slotY(token.slot);

        for (let s = 0; s < steps; s += 1) {
          const ax = -omega * omega * (token.x - targetX) - 2 * zeta * omega * token.vx;
          const ay = -omega * omega * (token.y - targetY) - 2 * zeta * omega * token.vy;
          // The velocity is updated before the position — a semi-implicit integrator, which stays
          // stable for a stiff spring where the naive order would let the token gain energy and
          // eventually fly off the screen.
          token.vx += ax * step;
          token.vy += ay * step;
          token.x += token.vx * step;
          token.y += token.vy * step;
        }

        const dx = token.x - targetX;
        const dy = token.y - targetY;
        const settled =
          dx * dx + dy * dy < SETTLED_DISTANCE * SETTLED_DISTANCE &&
          token.vx * token.vx + token.vy * token.vy < SETTLED_SPEED * SETTLED_SPEED;

        if (settled && kick > 0) token.vy -= kick;

        // Only a settled pile shivers. A token still in the air is already moving, and adding the
        // audio wobble to it would read as a wind rather than as a thump on the desk.
        const wobble = settled ? shiver : 0;
        const sprite = token.sprite;
        sprite.x = token.x + Math.sin(elapsed * 37 + token.phase) * wobble;
        sprite.y = token.y + Math.cos(elapsed * 41 + token.phase) * wobble * 0.6;
        sprite.rotation = token.tilt;
        sprite.scale.set(scale);

        const column = columns[token.col];
        const dim = column?.dim ?? 1;
        const base = tintFromChat ? token.chatTint : (baseColors[token.col] ?? 0xffffff);
        const tint = mixColor(base, DIM_GREY, 1 - dim);
        if (tint !== token.appliedTint) {
          sprite.tint = tint;
          token.appliedTint = tint;
        }
        sprite.alpha = dim;
      }

      // Pixi's own render loop is switched off by `createPixiStage`, so nothing reaches the canvas
      // until this line runs.
      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        const previousOptions = optionsText;
        const previousLabels = labelsText;
        const previousFontSize = labelFontSize;

        optionsText = str(p, "options", DEFAULT_OPTIONS);
        labelsText = str(p, "labels", DEFAULT_LABELS);
        maxTokens = int(p, "maxTokens", 320, 20, 1200);
        tokenSize = num(p, "tokenSize", 10, 4, 30);
        columnWidth = num(p, "columnWidth", 220, 40, 700);
        columnGap = num(p, "columnGap", 56, 0, 300);
        baselineFraction = num(p, "baselineY", 0.84, 0.2, 0.98);
        oneVotePerUser = bool(p, "oneVotePerUser", true);
        allowChangeVote = bool(p, "allowChangeVote", true);
        dropSeconds = num(p, "dropSeconds", 0.62, 0.25, 2);
        bounce = num(p, "bounce", 0.45, 0, 1);
        jitter = num(p, "jitter", 1, 0, 4);
        tintFromChat = bool(p, "tintFromChat", true);
        colors = palette(p, "palette", "signal");
        showCounts = bool(p, "showCounts", true);
        labelFontSize = int(p, "labelFontSize", 15, 9, 40);
        dimLosers = bool(p, "dimLosers", true);
        demoVotes = bool(p, "demoVotes", true);
        raidBurst = bool(p, "raidBurst", false);

        /*
         * A changed keyword list is a new question, so the columns are rebuilt and the tally starts
         * again. A changed label list only relabels the piles that are already standing, and a
         * changed font size only restyles them — the votes survive both, because rebuilding for a
         * cosmetic edit would throw away a poll that is halfway through.
         */
        if (optionsText !== previousOptions) {
          buildColumns();
        } else if (labelsText !== previousLabels || labelFontSize !== previousFontSize) {
          const labels = parseList(labelsText);
          columns.forEach((column, index) => {
            const label = labels[index] ?? "";
            column.label = label;
            column.labelView.text =
              label.length > 0 ? `${column.keyword} · ${label.toUpperCase()}` : column.keyword;
          });
        }

        // The palette is sampled once per column rather than once per token per frame, so a change
        // to it has to be pushed rather than picked up by the loop. Harmless after `buildColumns`,
        // which has already done it, and the only thing that applies a palette change otherwise.
        refreshColumnColors();

        // Everything else applies in place on the next frame; only the pool has a size to police.
        if (pool.length > maxTokens) trimPool();
      },
    };
  },
});

export default showOfHands;
