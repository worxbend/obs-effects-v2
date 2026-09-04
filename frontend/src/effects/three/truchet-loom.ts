import * as THREE from "three";

import type { ChatMessage } from "~/types/contract";
import { bool, int, num, str } from "../paramUtils";
import type { Palette } from "../sdk";
import {
  assembleFragment,
  createEnvelopes,
  createThreeStage,
  defineEffect,
  FULLSCREEN_VERTEX,
  onFrame,
  palette,
  paletteAt01,
  paletteParam,
  useAudio,
  useChat,
} from "../sdk";

/**
 * Quiet Loom
 * ==========
 *
 * A blueprint lattice of interlocking arcs that holds perfectly still — until a ring-shaped wave
 * crosses the frame and every tile it passes turns behind it, leaving a pattern that did not exist
 * a moment earlier.
 *
 * ## What a Truchet tiling is, for anyone who has not met one
 *
 * Take a square tile and draw two quarter-circle arcs on it, each centred on one of a pair of
 * opposite corners, each with a radius of half the tile. Every arc then starts and ends exactly at
 * the midpoint of a tile edge. Now cover the screen with copies of that tile, each turned a random
 * quarter turn. Because every arc meets its neighbours at edge midpoints, the arcs *join up*, and
 * what you get is a single continuous woven line wandering all over the frame — from a tile set of
 * exactly one shape. That is a Truchet tiling, named after Sébastien Truchet, who wrote the idea
 * down in 1704.
 *
 * The interesting property, and the whole reason this effect exists, is what happens when you turn
 * one tile. The arcs still meet their neighbours — the joins are at edge midpoints either way — but
 * the *routing* changes. A long path that ran through that tile is cut in two, and two paths that
 * were separate somewhere else close up into one. Turning a whole band of tiles at once therefore
 * re-plumbs the drawing, and you can watch long threads break and re-form as the band goes past.
 *
 * ## The wave
 *
 * A wave is one point on screen and one start time. A tile begins its turn at the moment a
 * circle expanding from that point at `waveSpeed` screen-heights per second reaches the tile's
 * centre, and takes `flipDuration` seconds to finish, eased so it starts and ends gently. Because
 * every tile is on its own little delay, the turning tiles form a band that trails the expanding
 * front at a fixed width — the same thing a wave in a stadium crowd is.
 *
 * Between waves nothing moves at all. No drift, no breathing, no shimmer. The stillness is the
 * design: it is what makes one wave read as an event rather than as more animation.
 *
 * ## Why the tile grid is measured in pixels from the centre of the frame
 *
 * The obvious way to lay a grid over a shader is to divide the 0..1 surface coordinate into cells.
 * Do that and the tiles stretch and re-shuffle every time the OBS source is resized, because the
 * number of cells across is fixed while their shape is not. Here the grid is built from
 * `vUv * uResolution - uResolution * 0.5` — position in pixels, measured from the middle of the
 * frame — so a tile is always `cellSize` pixels square, a resize just reveals or hides tiles around
 * the edge, and the pattern in the middle of the frame does not move. That is the difference
 * between a stable overlay and one that silently redraws itself when somebody drags a corner.
 *
 * ## Why waves combine with `max`, and how a finished wave is retired
 *
 * Several waves can be in flight at once. Their per-tile turn amounts are combined with `max`, not
 * added: two waves that sweep the same tile within half a second would otherwise turn it a full
 * 180 degrees, which for a two-arc tile is the same picture it started with — the reshuffle would
 * cancel itself out and the effect would quietly lose its point.
 *
 * `max` on its own has the opposite problem: once a tile has finished turning it is pinned at "all
 * the way round" forever and no later wave can move it again. So the waves in flight are treated as
 * one *group*. When the last member of the group has finished crossing the frame, the group is
 * retired: `uGeneration` goes up by one, the turn amount every tile is showing drops back to zero,
 * and the lattice is drawn from the new generation instead. That swap is invisible, and the next
 * section is why.
 *
 * ## Why a fixed quarter turn per wave would not actually be enough
 *
 * There are only two distinct tiles in this set — the arcs are either on one diagonal pair of
 * corners or on the other — so turning a tile a quarter turn is exactly the same thing as swapping
 * which of the two it is, and turning it a half turn does nothing at all. Give every tile the same
 * quarter turn per wave and the whole lattice therefore has only *two* states: wave one swaps every
 * tile, wave two swaps them all back, and an hour later the drawing is alternating between the same
 * two pictures it started with. Nobody watching one wave would notice; anybody watching a broadcast
 * would.
 *
 * So the per-tile coin is re-thrown instead. `variantFor(tileId, …, generation)` hashes the
 * generation counter in alongside the tile id, so every retired group deals the lattice a brand new
 * random tiling, and each tile turns however far it needs to *become* its next value: a quarter turn
 * when its coin came up the other way, a half turn — which lands back on the picture it started
 * from — when it came up the same. Because a half turn is a no-op for these tiles, and a quarter
 * turn is exactly the swap, the frame drawn at the end of a turn and the frame drawn immediately
 * after the generation goes up are pixel-identical. Every tile still visibly turns as the wave
 * passes over it; roughly half of them are landing somewhere new.
 *
 * The generation wraps at `TILING_CYCLE` so it can never grow big enough to cost the hash its
 * precision. That does mean the sequence of tilings repeats, after 256 waves.
 *
 * ## What drives it
 *
 * Three sources, which is unusual here — most effects have one.
 *
 * - **Chat.** Every message fires a wave. Its origin is derived from the message's `seed`, a number
 *   the chat SDK derives from the sender's name, so the same viewer always reshuffles the lattice
 *   from the same spot on screen. `chatCooldown` is the important knob and it is art direction
 *   rather than a safety valve: without a real gap between waves, a busy chat leaves the lattice
 *   permanently churning, and permanent churn is the one thing this effect must not do.
 * - **Audio.** `mid` — a loudness envelope, not a frequency band; see `sdk/envelopes.ts` — raises
 *   the brightness of the lines and nothing else, so the still lattice glows faintly with the music
 *   without any part of it moving.
 * - **A timer.** When chat is quiet or simulated, `idleInterval` fires a wave from a rotating set of
 *   positions, so the effect is never dead on air.
 *
 * ## Antialiasing, and the one place this diverges from the house pattern
 *
 * Most shaders here draw an edge with the shared `aaStep` chunk, which sizes the soft band from
 * `fwidth` of the value being thresholded. That is wrong for a tiling: the tile-local coordinate
 * comes from a `fract`, so it jumps from 1 back to 0 at every tile border, `fwidth` reads that jump
 * as an enormous gradient, and the result is a blurred seam along every single tile edge. The line
 * distance here is already in screen pixels, so the soft band is taken from `fwidth` of the
 * *continuous* pixel coordinate instead — one device pixel wide, everywhere, seams included.
 */

/**
 * How many waves can be in flight at once. This is a compile-time array length in the shader, so it
 * is a constant here and the `maxWaves` parameter only chooses how many of the slots get used.
 */
const MAX_WAVES = 3;

/** The `arcStyle` dropdown, in the order the shader's numeric codes expect. */
const ARC_STYLES = ["arcs", "straights", "mixed", "cross"] as const;

/** The `chatOrigin` dropdown. */
const CHAT_ORIGINS = ["seeded", "random", "centre", "edge"] as const;

/**
 * Where the base lattice and the subdivided regions sit on the chosen palette ramp.
 *
 * Two samples, and only two: one hue for the lattice and one step brighter for the finer regions is
 * the entire colour scheme. Density carries the hierarchy, not colour, which is what makes the
 * result read as a technical drawing rather than as a texture.
 */
const BASE_TONE = 0.5;
const SUBDIVIDED_TONE = 0.8;

/**
 * Positions the idle timer cycles through, as fractions of half the frame in each direction, so
 * `(0, 0)` is the centre and `(1, 1)` is the bottom-right corner. Spread around the frame and in no
 * obvious order, so consecutive idle waves do not look like a metronome.
 */
const IDLE_POINTS: ReadonlyArray<readonly [number, number]> = [
  [-0.65, -0.45],
  [0.7, 0.5],
  [0.0, -0.8],
  [-0.75, 0.6],
  [0.55, -0.6],
  [0.0, 0.0],
];

/**
 * Seconds of running time after which the shader clock is rewound to zero.
 *
 * `uTime` is a 32-bit float on the GPU. After a few hours of broadcast its precision has decayed to
 * roughly a millisecond, which is not yet visible but is heading that way. Rewinding is only safe
 * while no wave is in flight — nothing then refers to the old zero point — so it happens on the
 * first quiet frame after this many seconds and the CPU-side timestamps are shifted by the same
 * amount, which makes it invisible.
 */
const CLOCK_REWIND_SECONDS = 3600;

/**
 * How many retired wave groups it takes before the sequence of tilings repeats.
 *
 * The generation counter is hashed into the per-tile coin, so it has to stay small enough that a
 * 32-bit float still separates neighbouring tiles inside `hash12` — an unbounded counter would
 * eventually flatten the hash and the lattice would go blotchy. 256 waves is over an hour at the
 * default cooldowns, which is long enough that the repeat is theoretical.
 */
const TILING_CYCLE = 256;

const FRAGMENT_SHADER = assembleFragment(
  ["hash12", "easing"],
  /* glsl */ `
  varying vec2 vUv;

  uniform vec2  uResolution;      // canvas size in CSS pixels
  uniform float uTime;            // seconds since mount (rewound while idle; see CLOCK_REWIND_SECONDS)
  uniform float uCellSize;        // tile side in CSS pixels
  uniform float uLineWidth;       // stroke width in CSS pixels
  uniform float uOpacity;         // master alpha of the lattice
  uniform float uArcStyle;        // 0 arcs, 1 straights, 2 mixed, 3 cross
  uniform float uSubdivide;       // 0..1 fraction of cells that split into a finer 2x2 block
  uniform float uSubBrightness;   // brightness multiplier for those finer blocks
  uniform float uGridAngle;       // rotation of the whole grid, in radians
  uniform float uWaveSpeed;       // screen heights per second
  uniform float uFlipDuration;    // seconds one tile takes to complete its turn
  uniform float uGeneration;      // retired wave groups so far, wrapped at TILING_CYCLE
  uniform float uGlow;            // audio brightness lift, 0..1
  uniform vec3  uBaseColor;
  uniform vec3  uSubColor;
  // Each wave is (origin x, origin y, start time, active). The origin is in -1..1 fractions of half
  // the frame, so it keeps meaning the same place when the source is resized.
  uniform vec4  uWaves[${MAX_WAVES}];

  const float QUARTER_TURN = 1.5707963267948966;
  const float TILING_CYCLE = ${TILING_CYCLE}.0;

  // Which of the two arc pairs a tile carries, in a given generation of the lattice.
  //
  // The generation is hashed in alongside the tile id, so every retired wave group deals the whole
  // lattice a fresh set of coins rather than flipping it between two fixed pictures. See the file
  // header for why a plain quarter turn per wave is not enough on its own.
  float variantFor(vec2 id, float seedShift, float generation) {
    return hash12(id + vec2(seedShift + generation * 19.73, 7.3 + generation * 11.31));
  }

  // Distance from a point inside the unit tile to the ink on that tile.
  //
  // The arcs are quarter circles of radius 0.5 centred on two opposite corners, so \`length(q)-0.5\`
  // is the signed distance to one of them and \`abs\` of that is the unsigned distance to the curve
  // itself rather than to the disc it bounds. \`variant\` picks which diagonal pair of corners is
  // used, and a straight is the line joining two opposite edge midpoints.
  float tileDistance(vec2 q, float variant, float style) {
    float arcs = variant < 0.5
      ? min(abs(length(q) - 0.5), abs(length(q - vec2(1.0, 1.0)) - 0.5))
      : min(abs(length(q - vec2(1.0, 0.0)) - 0.5), abs(length(q - vec2(0.0, 1.0)) - 0.5));
    float straight = variant < 0.5 ? abs(q.x - 0.5) : abs(q.y - 0.5);
    if (style < 0.5) return arcs;
    if (style < 1.5) return straight;
    return min(arcs, straight);
  }

  void main() {
    // Position in pixels from the centre of the frame. Everything below is anchored to this, which
    // is what stops a resize from reshuffling the pattern.
    vec2 pixels = vUv * uResolution - uResolution * 0.5;

    // Half the width of one device pixel, measured from a coordinate that is continuous everywhere.
    // See the file header for why this is not fwidth() of the line distance.
    float aa = max(0.5 * length(fwidth(pixels)), 0.0001);

    float ca = cos(uGridAngle);
    float sa = sin(uGridAngle);
    vec2 turned = vec2(pixels.x * ca - pixels.y * sa, pixels.x * sa + pixels.y * ca);

    float baseCell = max(uCellSize, 4.0);
    vec2 grid = turned / baseCell;
    vec2 coarseId = floor(grid);

    // Roughly \`uSubdivide\` of the cells split into a 2x2 block of finer tiles. The hash is on the
    // coarse tile id alone, so which cells split never changes — only a wave changes anything.
    float level = hash12(coarseId + vec2(11.7, 3.1)) < uSubdivide ? 2.0 : 1.0;

    vec2 fine = grid * level;
    vec2 tileId = floor(fine);
    vec2 f = fine - tileId;
    float cellPx = baseCell / level;

    // The tile's centre, back in unrotated screen pixels, so wave distances are measured on screen
    // rather than in the tilted grid.
    vec2 centreTurned = (tileId + 0.5) * cellPx;
    vec2 centre = vec2(
      centreTurned.x * ca + centreTurned.y * sa,
      -centreTurned.x * sa + centreTurned.y * ca
    );

    // The tile's coin for this generation, and the one it is about to be dealt. Mixing the
    // subdivision level into the seed keeps a fine tile's choice independent of the coarse tile it
    // sits inside.
    float seedShift = level * 37.0;
    float variant = variantFor(tileId, seedShift, uGeneration);
    float nextVariant = variantFor(tileId, seedShift, mod(uGeneration + 1.0, TILING_CYCLE));

    // How far this tile has to turn to *become* its next value. A quarter turn swaps the two arc
    // pairs; a half turn is a no-op for them. So a tile whose coin came up the other way turns a
    // quarter, and one whose coin came up the same turns a half and lands back where it started —
    // which is what makes the generation change invisible. See the file header.
    float turns = (variant < 0.5) == (nextVariant < 0.5) ? 2.0 : 1.0;

    // How far through that turn this tile is. Combined with max across the waves in flight,
    // never summed — see the file header.
    float speedPx = max(uWaveSpeed * uResolution.y, 1.0);
    float phase = 0.0;
    for (int i = 0; i < ${MAX_WAVES}; i++) {
      vec4 wave = uWaves[i];
      if (wave.w < 0.5) continue;
      vec2 origin = wave.xy * uResolution * 0.5;
      float arrival = wave.z + distance(centre, origin) / speedPx;
      float t = clamp((uTime - arrival) / max(uFlipDuration, 0.01), 0.0, 1.0);
      phase = max(phase, easeInOutCubic(t));
    }

    float angle = phase * turns * QUARTER_TURN;
    float cq = cos(angle);
    float sq = sin(angle);
    vec2 local = f - 0.5;
    vec2 q = vec2(local.x * cq - local.y * sq, local.x * sq + local.y * cq) + 0.5;

    float style = uArcStyle;
    if (style > 1.5 && style < 2.5) {
      // "Mixed": every tile privately decides whether it is an arc tile or a straight one.
      style = hash12(tileId + vec2(53.1, seedShift)) < 0.5 ? 0.0 : 1.0;
    }

    // tileDistance works in tile units; the grid rotation is rigid, so multiplying by the tile's
    // pixel size converts it to screen pixels with no other correction.
    float distancePx = tileDistance(q, variant, style) * cellPx;
    float halfWidth = max(uLineWidth, 0.1) * 0.5;
    float coverage = 1.0 - smoothstep(halfWidth - aa, halfWidth + aa, distancePx);

    vec3 col = level > 1.5 ? uSubColor * uSubBrightness : uBaseColor;
    col *= 1.0 + uGlow;

    // Premultiplied output: the colour is scaled by its own coverage and the material is told so,
    // which is what keeps soft line edges from picking up a dark fringe over the scene behind.
    // The colour is clamped to 1 *before* that multiply, because premultiplied data with a channel
    // above its own alpha is not representable and the brightness would be silently lost at the
    // edges rather than in the middle of a line.
    float alpha = coverage * clamp(uOpacity, 0.0, 1.0);
    gl_FragColor = vec4(clamp(col, 0.0, 1.0) * alpha, alpha);
  }
`,
);

/** One wave in flight. Origins are -1..1 fractions of half the frame; see the shader's comment. */
interface Wave {
  readonly nx: number;
  readonly ny: number;
  /** The value of the effect's clock when it was fired. */
  readonly start: number;
}

/** Everything the descriptor can change, read in one place so `setParams` cannot miss a value. */
interface Settings {
  ramp: Palette;
  cellSize: number;
  lineWidth: number;
  opacity: number;
  arcStyle: number;
  subdivideChance: number;
  subdivideBrightness: number;
  gridAngle: number;
  waveSpeed: number;
  flipDuration: number;
  maxWaves: number;
  chatCooldown: number;
  chatOrigin: string;
  idleInterval: number;
  audioGlow: number;
  flipOnBeat: boolean;
  beatCooldown: number;
}

function readSettings(p: Record<string, unknown>): Settings {
  const styleName = str(p, "arcStyle", "arcs");
  const styleIndex = ARC_STYLES.indexOf(styleName as (typeof ARC_STYLES)[number]);
  return {
    ramp: palette(p, "palette", "signal"),
    cellSize: num(p, "cellSize", 64, 24, 160),
    lineWidth: num(p, "lineWidthPx", 1.6, 0.5, 5),
    opacity: num(p, "lineOpacity", 0.85, 0, 1),
    arcStyle: styleIndex < 0 ? 0 : styleIndex,
    subdivideChance: num(p, "subdivideChance", 0.32, 0, 1),
    subdivideBrightness: num(p, "subdivideBrightness", 1.3, 0, 2),
    gridAngle: num(p, "gridAngle", 0, 0, 90),
    waveSpeed: num(p, "waveSpeed", 1.2, 0.2, 4),
    flipDuration: num(p, "flipDuration", 0.55, 0.15, 2),
    maxWaves: int(p, "maxWaves", MAX_WAVES, 1, MAX_WAVES),
    chatCooldown: num(p, "chatCooldown", 2.5, 0, 20),
    chatOrigin: str(p, "chatOrigin", "seeded"),
    idleInterval: num(p, "idleInterval", 18, 0, 120),
    audioGlow: num(p, "audioGlow", 0.25, 0, 1),
    flipOnBeat: bool(p, "flipOnBeat", false),
    beatCooldown: num(p, "beatCooldown", 6, 0.5, 30),
  };
}

/** A point somewhere on the border of the frame, from two 0..1 numbers. */
function edgePoint(a: number, b: number): readonly [number, number] {
  const side = Math.floor(a * 4) % 4;
  const along = b * 2 - 1;
  if (side === 0) return [along, -1];
  if (side === 1) return [1, along];
  if (side === 2) return [along, 1];
  return [-1, along];
}

/**
 * Where a chat message's wave should start.
 *
 * `seeded` is the interesting one. `ChatMessage.seed` is a number the chat SDK derives from the
 * sender, so it is the same every time that person types — which means their reshuffle always
 * starts from the same spot on screen. Regulars notice that within one broadcast, and it costs
 * nothing to provide.
 */
function originFor(message: ChatMessage, mode: string): readonly [number, number] {
  const seed = message.seed >>> 0;
  // Two independent 12-bit fields out of the seed, each mapped to -1..1.
  const seededX = ((seed & 0xfff) / 0xfff) * 2 - 1;
  const seededY = (((seed >> 12) & 0xfff) / 0xfff) * 2 - 1;

  switch (mode) {
    case "random":
      return [Math.random() * 2 - 1, Math.random() * 2 - 1];
    case "centre":
      return [0, 0];
    case "edge":
      return edgePoint((seed & 0xfff) / 0x1000, ((seed >> 12) & 0xfff) / 0x1000);
    case "seeded":
    default:
      return [seededX, seededY];
  }
}

const truchetLoom = defineEffect({
  descriptor: {
    id: "truchet-loom",
    name: "Quiet Loom",
    description:
      "A still blueprint lattice of interlocking arcs. Chat, the music and a slow timer send " +
      "ring-shaped waves across it, and every tile a wave passes turns behind it, " +
      "breaking and re-forming the woven paths.",
    engine: "three",
    category: "background",
    tags: ["background", "truchet", "tiling", "chat", "reactive", "blueprint", "three"],
    previewNotes:
      "Transparent, so it layers over a game capture, a desktop capture or a plain colour source. " +
      "Completely motionless between events on purpose — the stillness is what makes a wave read " +
      "as an acknowledgement of chat rather than as more animation. Raise Chat Cooldown if your " +
      "chat is busy; lower Line Opacity if it competes with what is behind it.",
    params: [
      paletteParam(
        "palette",
        "Palette",
        "signal",
        "Colour ramp for the lattice. One tone is taken for the base grid and a lighter one for " +
          "the subdivided regions; nothing else is coloured.",
      ),
      {
        key: "cellSize",
        label: "Tile Size",
        kind: "number",
        default: 64,
        min: 24,
        max: 160,
        step: 2,
        description:
          "Side of one tile in screen pixels. Small reads as a dense woven fabric; large reads as " +
          "architectural line work.",
      },
      {
        key: "lineWidthPx",
        label: "Line Width",
        kind: "number",
        default: 1.6,
        min: 0.5,
        max: 5,
        step: 0.1,
        description:
          "Stroke width in screen pixels, so it stays the same weight whatever size the source is.",
      },
      {
        key: "lineOpacity",
        label: "Line Opacity",
        kind: "number",
        default: 0.85,
        min: 0,
        max: 1,
        step: 0.01,
        description:
          "Master transparency of the whole lattice. Drop it to around 0.4 to sit the drawing " +
          "behind a webcam or a code editor without competing with it.",
      },
      {
        key: "arcStyle",
        label: "Tile Set",
        kind: "select",
        default: "arcs",
        options: [...ARC_STYLES],
        description:
          "Which shapes the tiles are drawn from. Arcs weave and curve; straights give a circuit " +
          "board; mixed picks one or the other per tile; cross draws both at once.",
      },
      {
        key: "subdivideChance",
        label: "Subdivision",
        kind: "number",
        default: 0.32,
        min: 0,
        max: 1,
        step: 0.02,
        description:
          "Fraction of cells that split into a finer 2x2 block. This is what gives the drawing " +
          "areas of different density without changing the line weight anywhere. 0 is a plain grid.",
      },
      {
        key: "subdivideBrightness",
        label: "Subdivision Brightness",
        kind: "number",
        default: 1.3,
        min: 0,
        max: 2,
        step: 0.05,
        description:
          "How much brighter the finer regions are than the base lattice. 1 makes them identical.",
      },
      {
        key: "gridAngle",
        label: "Grid Angle",
        kind: "number",
        default: 0,
        min: 0,
        max: 90,
        step: 1,
        description:
          "Rotation of the whole grid in degrees. 0 is architectural and square to the frame; " +
          "around 30 is decorative; 45 is a diamond lattice.",
      },
      {
        key: "waveSpeed",
        label: "Wave Speed",
        kind: "number",
        default: 1.2,
        min: 0.2,
        max: 4,
        step: 0.05,
        description:
          "How fast a reshuffle front crosses the frame, in screen heights per second. Low values " +
          "let you watch the paths re-plumb; high values read as a snap.",
      },
      {
        key: "flipDuration",
        label: "Turn Duration",
        kind: "number",
        default: 0.55,
        min: 0.15,
        max: 2,
        step: 0.05,
        description:
          "Seconds one tile takes to complete its turn. Together with Wave Speed this sets " +
          "how wide the band of turning tiles trailing the front is.",
      },
      {
        key: "maxWaves",
        label: "Concurrent Waves",
        kind: "number",
        default: 3,
        min: 1,
        max: 3,
        step: 1,
        description:
          "How many reshuffle waves may be crossing the frame at the same time. Extra messages " +
          "arriving while the limit is reached are ignored rather than queued.",
      },
      {
        key: "chatCooldown",
        label: "Chat Cooldown",
        kind: "number",
        default: 2.5,
        min: 0,
        max: 20,
        step: 0.5,
        description:
          "Minimum seconds between two chat-triggered waves. This is the knob that protects the " +
          "stillness: with a busy chat and no gap the lattice never stops moving, which is exactly " +
          "what this effect is trying not to do.",
      },
      {
        key: "chatOrigin",
        label: "Chat Wave Origin",
        kind: "select",
        default: "seeded",
        options: [...CHAT_ORIGINS],
        description:
          "Where a chat message's wave starts. Seeded derives the spot from the sender, so the " +
          "same viewer always reshuffles from the same place; random picks a new spot each time; " +
          "centre always uses the middle of the frame; edge starts from the border.",
      },
      {
        key: "idleInterval",
        label: "Idle Interval",
        kind: "number",
        default: 18,
        min: 0,
        max: 120,
        step: 1,
        description:
          "Seconds of quiet before a wave fires on its own, so the effect is never dead on air. " +
          "0 switches the timer off and lets only chat and the music move it.",
      },
      {
        key: "audioGlow",
        label: "Audio Glow",
        kind: "number",
        default: 0.25,
        min: 0,
        max: 1,
        step: 0.02,
        description:
          "How much the music brightens the lines. It changes brightness only — nothing moves — so " +
          "the lattice breathes with the sound while staying perfectly still. 0 ignores audio.",
      },
      {
        key: "flipOnBeat",
        label: "Wave On Beat",
        kind: "boolean",
        default: false,
        description:
          "Also fire a wave when the audio hits hard. Useful for a music-led scene; leave it off " +
          "for talking and coding, where chat should be the only thing that moves the lattice.",
      },
      {
        key: "beatCooldown",
        label: "Beat Cooldown",
        kind: "number",
        default: 6,
        min: 0.5,
        max: 30,
        step: 0.5,
        description:
          "Minimum seconds between two beat-triggered waves, so a loud track does not fire one " +
          "every bar. Only used when Wave On Beat is on.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    // Both feeds are acquired before the stage is built, so a scope disposed during either wait
    // tears down with no WebGL context to clean up. Neither helper checkpoints for us.
    const chat = await useChat(scope);
    scope.checkpoint();
    const bus = await useAudio(scope);
    scope.checkpoint();

    const envelopes = createEnvelopes(bus);

    const stage = createThreeStage(scope, ctx, {
      // A full-screen quad has no polygon edges to smooth, so multisampling costs fill rate and
      // changes nothing. The lines antialias themselves in the fragment shader.
      antialias: false,
      camera: { kind: "fullscreen-quad" },
    });

    let settings = readSettings(ctx.params);

    // A zero-sized canvas would make uResolution zero and divide the grid by nothing, so the size
    // is floored at one pixel here and in the resize handler.
    const uniforms = {
      uResolution: {
        value: new THREE.Vector2(Math.max(1, stage.width), Math.max(1, stage.height)),
      },
      uTime: { value: 0 },
      uCellSize: { value: settings.cellSize },
      uLineWidth: { value: settings.lineWidth },
      uOpacity: { value: settings.opacity },
      uArcStyle: { value: settings.arcStyle },
      uSubdivide: { value: settings.subdivideChance },
      uSubBrightness: { value: settings.subdivideBrightness },
      uGridAngle: { value: (settings.gridAngle * Math.PI) / 180 },
      uWaveSpeed: { value: settings.waveSpeed },
      uFlipDuration: { value: settings.flipDuration },
      uGeneration: { value: 0 },
      uGlow: { value: 0 },
      uBaseColor: { value: new THREE.Vector3(1, 1, 1) },
      uSubColor: { value: new THREE.Vector3(1, 1, 1) },
      uWaves: {
        value: Array.from({ length: MAX_WAVES }, () => new THREE.Vector4(0, 0, 0, 0)),
      },
    };

    /** Copies everything in `settings` into the uniforms. Called at setup and from `setParams`. */
    const applySettings = (): void => {
      uniforms.uCellSize.value = settings.cellSize;
      uniforms.uLineWidth.value = settings.lineWidth;
      uniforms.uOpacity.value = settings.opacity;
      uniforms.uArcStyle.value = settings.arcStyle;
      uniforms.uSubdivide.value = settings.subdivideChance;
      uniforms.uSubBrightness.value = settings.subdivideBrightness;
      uniforms.uGridAngle.value = (settings.gridAngle * Math.PI) / 180;
      uniforms.uWaveSpeed.value = settings.waveSpeed;
      uniforms.uFlipDuration.value = settings.flipDuration;
      uniforms.uBaseColor.value.set(...paletteAt01(settings.ramp, BASE_TONE));
      uniforms.uSubColor.value.set(...paletteAt01(settings.ramp, SUBDIVIDED_TONE));
    };

    applySettings();

    const geometry = scope.ownDisposable(new THREE.PlaneGeometry(2, 2));
    const material = scope.ownDisposable(
      new THREE.ShaderMaterial({
        vertexShader: FULLSCREEN_VERTEX,
        fragmentShader: FRAGMENT_SHADER,
        uniforms,
        transparent: true,
        // The shader writes colour already multiplied by its own alpha; saying so here stops the
        // blender from scaling it a second time, which would darken every soft line edge.
        premultipliedAlpha: true,
        depthTest: false,
        depthWrite: false,
      }),
    );

    const quad = new THREE.Mesh(geometry, material);
    // The quad is always directly in front of the camera, so frustum culling could only ever be
    // wrong about it.
    quad.frustumCulled = false;
    stage.scene.add(quad);

    stage.onResize((w, h) => uniforms.uResolution.value.set(Math.max(1, w), Math.max(1, h)));

    /** Seconds since mount, occasionally rewound while idle; see CLOCK_REWIND_SECONDS. */
    let clock = 0;
    /** The waves currently crossing the frame. Retired as a group; see the file header. */
    const waves: Wave[] = [];
    /** Which generation of the lattice is on screen. Bumped when a group of waves retires. */
    let generation = 0;

    let lastChatWaveAt = Number.NEGATIVE_INFINITY;
    let lastBeatWaveAt = Number.NEGATIVE_INFINITY;
    let lastIdleWaveAt = 0;
    let idleIndex = 0;

    /** Starts a wave, unless the concurrent-wave limit is already reached. */
    const fireWave = (nx: number, ny: number): boolean => {
      if (waves.length >= settings.maxWaves) return false;
      waves.push({ nx, ny, start: clock });
      return true;
    };

    // Every kind of chat event counts — a message, a sub, a cheer, a raid all arrive on this one
    // stream. The unsubscribe function is handed straight to the scope, so the subscription cannot
    // outlive the effect.
    scope.defer(
      chat.onMessage((message) => {
        if (clock - lastChatWaveAt < settings.chatCooldown) return;
        const [nx, ny] = originFor(message, settings.chatOrigin);
        if (!fireWave(nx, ny)) return;
        lastChatWaveAt = clock;
        // An idle wave right after a chat one would step on it, so the timer restarts here too.
        lastIdleWaveAt = clock;
      }),
    );

    onFrame(scope, ctx.fpsCap, ({ dt, now }) => {
      bus.sample(now);
      envelopes.update(dt);
      clock += dt;

      const frameHeight = Math.max(1, stage.height);
      const speedPx = Math.max(settings.waveSpeed * frameHeight, 1);
      // The farthest any tile centre can be from any origin inside the frame, plus the time the
      // last tile needs to finish turning: a wave older than this has swept everything.
      //
      // The extra cell matters. A tile that only half overlaps the frame still draws, and its
      // centre is outside the frame, so the frame's diagonal alone is short of the true reach —
      // and retiring the group even a frame early is visible, because those edge tiles would be
      // snapped to their finished position part-way through turning.
      const reachPx = Math.hypot(Math.max(1, stage.width), frameHeight) + settings.cellSize;
      const lifetime = reachPx / speedPx;

      if (waves.length > 0) {
        let allFinished = true;
        for (const wave of waves) {
          if (clock < wave.start + lifetime + settings.flipDuration) {
            allFinished = false;
            break;
          }
        }
        if (allFinished) {
          // Every tile has finished its turn, so the lattice moves on to the next generation and
          // the slots are freed. The picture does not change across this frame: every tile had
          // turned all the way into its next value, and that value is what the new generation
          // draws directly. See the file header.
          waves.length = 0;
          generation = (generation + 1) % TILING_CYCLE;
        }
      } else if (clock > CLOCK_REWIND_SECONDS) {
        // Nothing refers to the old zero point, so the clock and every timestamp measured against
        // it slide back together. Shifting rather than zeroing keeps the cooldowns exactly where
        // they were.
        const shift = clock;
        clock = 0;
        lastChatWaveAt -= shift;
        lastBeatWaveAt -= shift;
        lastIdleWaveAt -= shift;
      }

      if (settings.idleInterval > 0 && clock - lastIdleWaveAt >= settings.idleInterval) {
        const point = IDLE_POINTS[idleIndex % IDLE_POINTS.length] ?? ([0, 0] as const);
        idleIndex += 1;
        fireWave(point[0], point[1]);
        // The timestamp moves whether or not the wave was accepted, so a frame that hits the
        // concurrent-wave limit waits a full interval instead of retrying every frame.
        lastIdleWaveAt = clock;
      }

      if (
        settings.flipOnBeat &&
        envelopes.beat &&
        clock - lastBeatWaveAt >= settings.beatCooldown
      ) {
        if (fireWave(Math.random() * 2 - 1, Math.random() * 2 - 1)) {
          lastBeatWaveAt = clock;
          lastIdleWaveAt = clock;
        }
      }

      uniforms.uTime.value = clock;
      uniforms.uGeneration.value = generation;
      // `mid` is a loudness envelope at a middling tracking speed, not a frequency band. It only
      // ever changes brightness here, so the lattice stays perfectly still while it glows.
      //
      // The finiteness test is not paranoia about this file's own arithmetic. The envelope tracks
      // whatever loudness the audio feed reports, and a single malformed number arriving from that
      // feed would make it NaN from then on. A NaN in a uniform is not a wrong colour, it is an
      // undefined one, and the whole lattice can vanish — so it degrades to "no glow" instead.
      const glow = envelopes.mid;
      uniforms.uGlow.value = Number.isFinite(glow)
        ? Math.min(1, Math.max(0, glow)) * settings.audioGlow
        : 0;

      for (let i = 0; i < MAX_WAVES; i += 1) {
        const slot = uniforms.uWaves.value[i];
        if (slot === undefined) continue;
        const wave = waves[i];
        // The fourth component is the active flag the shader tests; an empty slot is skipped there.
        if (wave === undefined) slot.set(0, 0, 0, 0);
        else slot.set(wave.nx, wave.ny, wave.start, 1);
      }

      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        // Lowering Concurrent Waves does not cancel waves already crossing the frame; they finish
        // and the new limit applies to the next one. Cancelling mid-flight would snap tiles back.
        settings = readSettings(p);
        applySettings();
      },
    };
  },
});

export default truchetLoom;
