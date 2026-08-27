import * as PIXI from "pixi.js";

import { colorHex, int, lerp, num } from "../paramUtils";
import { createPixiStage, defineEffect, onFrame, useChat } from "../sdk";
import type { ChatMessage, ChatPart } from "~/types/contract";

/**
 * Chat Pixel Text
 * ===============
 *
 * Twitch chat rendered like an 8-bit console: every character is built out of filled squares on a
 * 5×7 grid, straight from a glyph table defined in this file. There is no font file, no browser
 * text rendering, no anti-aliasing — a "letter" here is literally up to 35 little rectangles, which
 * is what keeps the edges razor sharp at any pixel size and makes the whole overlay read as pixel
 * art rather than as text with a retro font applied.
 *
 * An original effect written for this project, not a port.
 *
 * How a message is drawn
 * ----------------------
 * Each message starts with a chunky *username plate*: a solid rectangle in the sender's chat
 * colour (Twitch provides one; users who never picked one get a colour derived from their name, so
 * it is stable per person) with the name punched into it in a dark ink. The message text follows in
 * the configured text colour, word-wrapped to the canvas width. New messages slide in at the
 * bottom; older ones scroll up, fade as they age, and disappear when their lifetime runs out.
 *
 * Twitch emotes and Unicode emoji arrive as image parts. Each one is drawn as a small sprite with
 * nearest-neighbour scaling — no smoothing — so the emote is downscaled into crunchy pixels that
 * sit comfortably next to the glyph text. The image loads over the network *after* the message is
 * laid out, so the layout reserves the emote's slot by first drawing its name in glyphs; when the
 * image arrives the glyphs are hidden and the sprite takes the same slot, and if the load fails the
 * name stays visible. Nothing ever reflows, and a dead CDN costs only prettiness. Only the static
 * emote URL is used — this app has no GIF renderer, so animated emotes show their first frame.
 *
 * The glyph table covers A–Z, 0–9 and common punctuation; lowercase letters reuse the uppercase
 * shapes, the classic 8-bit move. Anything outside the table renders as a hollow box, so a message
 * in an unsupported script degrades to visible placeholders instead of vanishing.
 */

/* ------------------------------------------------------------------ */
/* The glyph atlas                                                     */
/* ------------------------------------------------------------------ */

/**
 * Each glyph is 7 rows of 5 columns. The strings are the artwork itself — `X` is a filled square,
 * `.` is empty — kept as strings precisely so a reviewer can *see* every letter without decoding
 * bitmasks. They are compiled into row bitmasks once, below, so the per-frame cost is zero.
 */
const GLYPH_ART: Record<string, readonly string[]> = {
  A: [".XXX.", "X...X", "X...X", "XXXXX", "X...X", "X...X", "X...X"],
  B: ["XXXX.", "X...X", "X...X", "XXXX.", "X...X", "X...X", "XXXX."],
  C: [".XXX.", "X...X", "X....", "X....", "X....", "X...X", ".XXX."],
  D: ["XXXX.", "X...X", "X...X", "X...X", "X...X", "X...X", "XXXX."],
  E: ["XXXXX", "X....", "X....", "XXXX.", "X....", "X....", "XXXXX"],
  F: ["XXXXX", "X....", "X....", "XXXX.", "X....", "X....", "X...."],
  G: [".XXX.", "X...X", "X....", "X.XXX", "X...X", "X...X", ".XXX."],
  H: ["X...X", "X...X", "X...X", "XXXXX", "X...X", "X...X", "X...X"],
  I: ["XXXXX", "..X..", "..X..", "..X..", "..X..", "..X..", "XXXXX"],
  J: ["..XXX", "...X.", "...X.", "...X.", "...X.", "X..X.", ".XX.."],
  K: ["X...X", "X..X.", "X.X..", "XX...", "X.X..", "X..X.", "X...X"],
  L: ["X....", "X....", "X....", "X....", "X....", "X....", "XXXXX"],
  M: ["X...X", "XX.XX", "X.X.X", "X.X.X", "X...X", "X...X", "X...X"],
  N: ["X...X", "XX..X", "X.X.X", "X..XX", "X...X", "X...X", "X...X"],
  O: [".XXX.", "X...X", "X...X", "X...X", "X...X", "X...X", ".XXX."],
  P: ["XXXX.", "X...X", "X...X", "XXXX.", "X....", "X....", "X...."],
  Q: [".XXX.", "X...X", "X...X", "X...X", "X.X.X", "X..X.", ".XX.X"],
  R: ["XXXX.", "X...X", "X...X", "XXXX.", "X.X..", "X..X.", "X...X"],
  S: [".XXXX", "X....", "X....", ".XXX.", "....X", "....X", "XXXX."],
  T: ["XXXXX", "..X..", "..X..", "..X..", "..X..", "..X..", "..X.."],
  U: ["X...X", "X...X", "X...X", "X...X", "X...X", "X...X", ".XXX."],
  V: ["X...X", "X...X", "X...X", "X...X", "X...X", ".X.X.", "..X.."],
  W: ["X...X", "X...X", "X...X", "X.X.X", "X.X.X", "XX.XX", "X...X"],
  X: ["X...X", "X...X", ".X.X.", "..X..", ".X.X.", "X...X", "X...X"],
  Y: ["X...X", "X...X", ".X.X.", "..X..", "..X..", "..X..", "..X.."],
  Z: ["XXXXX", "....X", "...X.", "..X..", ".X...", "X....", "XXXXX"],
  "0": [".XXX.", "X...X", "X..XX", "X.X.X", "XX..X", "X...X", ".XXX."],
  "1": ["..X..", ".XX..", "..X..", "..X..", "..X..", "..X..", "XXXXX"],
  "2": [".XXX.", "X...X", "....X", "...X.", "..X..", ".X...", "XXXXX"],
  "3": [".XXX.", "X...X", "....X", "..XX.", "....X", "X...X", ".XXX."],
  "4": ["...X.", "..XX.", ".X.X.", "X..X.", "XXXXX", "...X.", "...X."],
  "5": ["XXXXX", "X....", "XXXX.", "....X", "....X", "X...X", ".XXX."],
  "6": [".XXX.", "X....", "X....", "XXXX.", "X...X", "X...X", ".XXX."],
  "7": ["XXXXX", "....X", "...X.", "..X..", ".X...", ".X...", ".X..."],
  "8": [".XXX.", "X...X", "X...X", ".XXX.", "X...X", "X...X", ".XXX."],
  "9": [".XXX.", "X...X", "X...X", ".XXXX", "....X", "....X", ".XXX."],
  ".": [".....", ".....", ".....", ".....", ".....", ".XX..", ".XX.."],
  ",": [".....", ".....", ".....", ".....", ".XX..", "..X..", ".X..."],
  "!": ["..X..", "..X..", "..X..", "..X..", "..X..", ".....", "..X.."],
  "?": [".XXX.", "X...X", "....X", "...X.", "..X..", ".....", "..X.."],
  ":": [".....", ".XX..", ".XX..", ".....", ".XX..", ".XX..", "....."],
  ";": [".....", ".XX..", ".XX..", ".....", ".XX..", "..X..", ".X..."],
  "'": ["..X..", "..X..", ".....", ".....", ".....", ".....", "....."],
  '"': [".X.X.", ".X.X.", ".....", ".....", ".....", ".....", "....."],
  "-": [".....", ".....", ".....", "XXXXX", ".....", ".....", "....."],
  _: [".....", ".....", ".....", ".....", ".....", ".....", "XXXXX"],
  "+": [".....", "..X..", "..X..", "XXXXX", "..X..", "..X..", "....."],
  "=": [".....", ".....", "XXXXX", ".....", "XXXXX", ".....", "....."],
  "/": ["....X", "....X", "...X.", "..X..", ".X...", "X....", "X...."],
  "\\": ["X....", "X....", ".X...", "..X..", "...X.", "....X", "....X"],
  "(": ["...X.", "..X..", ".X...", ".X...", ".X...", "..X..", "...X."],
  ")": [".X...", "..X..", "...X.", "...X.", "...X.", "..X..", ".X..."],
  "[": ["..XXX", "..X..", "..X..", "..X..", "..X..", "..X..", "..XXX"],
  "]": ["XXX..", "..X..", "..X..", "..X..", "..X..", "..X..", "XXX.."],
  "<": ["...X.", "..X..", ".X...", "X....", ".X...", "..X..", "...X."],
  ">": [".X...", "..X..", "...X.", "....X", "...X.", "..X..", ".X..."],
  "@": [".XXX.", "X...X", "X.XXX", "X.X.X", "X.XXX", "X....", ".XXX."],
  "#": [".X.X.", ".X.X.", "XXXXX", ".X.X.", "XXXXX", ".X.X.", ".X.X."],
  $: ["..X..", ".XXXX", "X.X..", ".XXX.", "..X.X", "XXXX.", "..X.."],
  "%": ["XX..X", "XX.X.", "..X..", "..X..", "..X..", ".X.XX", "X..XX"],
  "&": [".XX..", "X..X.", "X.X..", ".X...", "X.X.X", "X..X.", ".XX.X"],
  "*": [".....", "X.X.X", ".XXX.", "XXXXX", ".XXX.", "X.X.X", "....."],
  "~": [".....", ".....", ".X...", "X.X.X", "...X.", ".....", "....."],
  "^": ["..X..", ".X.X.", "X...X", ".....", ".....", ".....", "....."],
  "|": ["..X..", "..X..", "..X..", "..X..", "..X..", "..X..", "..X.."],
};

/** What an unsupported character renders as: a hollow box, the classic "missing glyph" mark. */
const UNKNOWN_ART: readonly string[] = [
  "XXXXX",
  "X...X",
  "X...X",
  "X...X",
  "X...X",
  "X...X",
  "XXXXX",
];

const GLYPH_COLS = 5;
const GLYPH_ROWS = 7;
/** One blank column between characters. In cell units, one character advances the cursor by 6. */
const GLYPH_ADVANCE = GLYPH_COLS + 1;
/** Line height in cell units: 7 glyph rows plus 2 of breathing room. */
const LINE_CELLS = GLYPH_ROWS + 2;

/** The art strings compiled into per-row bitmasks (bit 4 = leftmost column), plus the fallback. */
const GLYPHS: ReadonlyMap<string, readonly number[]> = (() => {
  const compile = (art: readonly string[]): number[] =>
    art.map((row) => {
      let bits = 0;
      for (let col = 0; col < GLYPH_COLS; col += 1) {
        if (row[col] === "X") bits |= 1 << (GLYPH_COLS - 1 - col);
      }
      return bits;
    });
  const map = new Map<string, readonly number[]>();
  for (const [char, art] of Object.entries(GLYPH_ART)) map.set(char, compile(art));
  map.set(" ", compile(UNKNOWN_ART));
  return map;
})();

/** The rows for one character: its own glyph, the uppercase shape for lowercase, else the box. */
function glyphFor(char: string): readonly number[] {
  const direct = GLYPHS.get(char) ?? GLYPHS.get(char.toUpperCase());
  return direct ?? GLYPHS.get(" ") ?? [];
}

/** Draws one string of glyphs into `g` at (`x`, `y`), in device pixels. Returns the width drawn. */
function drawGlyphText(
  g: PIXI.Graphics,
  text: string,
  x: number,
  y: number,
  px: number,
  color: string,
): number {
  let cursor = x;
  for (const char of text) {
    if (char !== " ") {
      const rows = glyphFor(char);
      for (let row = 0; row < GLYPH_ROWS; row += 1) {
        const bits = rows[row] ?? 0;
        for (let col = 0; col < GLYPH_COLS; col += 1) {
          if ((bits & (1 << (GLYPH_COLS - 1 - col))) !== 0) {
            g.rect(cursor + col * px, y + row * px, px, px);
          }
        }
      }
    }
    cursor += GLYPH_ADVANCE * px;
  }
  g.fill({ color });
  return cursor - x;
}

/* ------------------------------------------------------------------ */
/* Per-user colour                                                     */
/* ------------------------------------------------------------------ */

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * The colour a user's plate takes. Their Twitch chat colour when the message carries one, else a
 * colour spun out of their `seed` — which the backend derives from the username, so the same
 * person is the same colour every time. The seed's raw 24 bits can land on near-black, unusable as
 * a plate, so it picks a hue only and fixes saturation and lightness at readable values.
 */
function userColor(message: ChatMessage): string {
  if (HEX_COLOR.test(message.color)) return message.color;
  const hue = (message.seed % 360) / 360;
  // Minimal HSL→RGB with s=0.65, l=0.6 — bright enough for dark ink on top.
  const channel = (offset: number): number => {
    let t = hue + offset;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    const q = 0.86; // l + s * (1 - l) with s=0.65, l=0.6
    const p = 2 * 0.6 - q;
    let value: number;
    if (t < 1 / 6) value = p + (q - p) * 6 * t;
    else if (t < 1 / 2) value = q;
    else if (t < 2 / 3) value = p + (q - p) * (2 / 3 - t) * 6;
    else value = p;
    return Math.round(value * 255);
  };
  const toHex = (value: number): string => value.toString(16).padStart(2, "0");
  return `#${toHex(channel(1 / 3))}${toHex(channel(0))}${toHex(channel(-1 / 3))}`;
}

/* ------------------------------------------------------------------ */
/* The effect                                                          */
/* ------------------------------------------------------------------ */

/** One message on screen: its display object, when it appeared, and where it is drifting to. */
interface Entry {
  message: ChatMessage;
  container: PIXI.Container;
  /** Height of the laid-out message in device pixels, plate and wrapping included. */
  height: number;
  /** Seconds of effect time when the message appeared, for the lifetime fade. */
  shownAt: number;
  /** Current y, eased toward `targetY` each frame so the stack scrolls instead of snapping. */
  y: number;
  targetY: number;
}

const chatPixelText = defineEffect({
  descriptor: {
    id: "chat-pixel-text",
    name: "Chat Pixel Text",
    description:
      "Twitch chat as 8-bit pixel art: every character built from filled squares on a 5×7 grid, chunky username plates in each sender's colour, emotes downscaled into crunchy pixel sprites.",
    engine: "pixi",
    category: "chat",
    tags: ["chat", "twitch", "pixel", "retro", "8-bit", "text"],
    previewNotes:
      "When Twitch is not configured, a simulated feed posts a gentle canned message every few seconds — so expect a short wait before the first line appears. Transparent background; sits over any scene. Animated emotes render their static frame only.",
    params: [
      {
        key: "pixelSize",
        label: "Pixel Size",
        kind: "number",
        default: 3,
        min: 1,
        max: 10,
        step: 1,
        description:
          "The size of one square in the glyph grid, in screen pixels. Characters are 5×7 squares, so at 3 a character is 15×21 screen pixels. This is the master scale for everything.",
      },
      {
        key: "lineCount",
        label: "Messages Shown",
        kind: "number",
        default: 8,
        min: 1,
        max: 30,
        step: 1,
        description:
          "How many messages stay on screen at once. When a new one arrives beyond this, the oldest is dropped immediately, whatever its remaining lifetime.",
      },
      {
        key: "lifetime",
        label: "Message Lifetime",
        kind: "number",
        default: 45,
        min: 3,
        max: 600,
        step: 1,
        description:
          "Seconds a message stays before it disappears. The last few seconds of that fade it out, so nothing pops off screen abruptly.",
      },
      {
        key: "textColor",
        label: "Text Colour",
        kind: "color",
        default: "#e8f0e0",
        description: "The message body glyphs. A slightly warm off-white reads like an old monitor.",
      },
      {
        key: "plateInk",
        label: "Plate Ink",
        kind: "color",
        default: "#101418",
        description:
          "The username glyphs punched into the coloured plate. Dark, because the plate itself takes the sender's (usually bright) chat colour.",
      },
      {
        key: "shadowColor",
        label: "Shadow Colour",
        kind: "color",
        default: "#0a0c10",
        description:
          "The one-pixel drop shadow behind text and plates. It is what keeps the overlay readable over bright scenes; match it to the scene's darkest tone.",
      },
      {
        key: "eventColor",
        label: "Event Colour",
        kind: "color",
        default: "#ffd75e",
        description:
          "Body text colour for channel events — subs, gifted subs, cheers, raids — so they stand out from ordinary chat.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    // No antialiasing: the entire look is hard-edged rectangles, and smoothing would blur the one
    // thing the effect is about.
    const stage = await createPixiStage(scope, ctx, { antialias: false });

    const chat = await useChat(scope);
    scope.checkpoint();

    const feedLayer = stage.stage.addChild(new PIXI.Container());

    let pixelSize = int(ctx.params, "pixelSize", 3, 1, 10);
    let lineCount = int(ctx.params, "lineCount", 8, 1, 30);
    let lifetime = num(ctx.params, "lifetime", 45, 3, 600);
    let textColor = colorHex(ctx.params, "textColor", "#e8f0e0");
    let plateInk = colorHex(ctx.params, "plateInk", "#101418");
    let shadowColor = colorHex(ctx.params, "shadowColor", "#0a0c10");
    let eventColor = colorHex(ctx.params, "eventColor", "#ffd75e");

    let time = 0;
    const entries: Entry[] = [];

    /** Margin around the whole feed, scaled with the glyphs so it never looks mismatched. */
    const margin = (): number => 2 * LINE_CELLS * pixelSize * 0.25;

    /**
     * Turns a message's parts into word-sized tokens for wrapping. Text splits on spaces; an image
     * part is one token. Wrapping whole words (not characters) is what keeps lines readable.
     */
    type Token = { kind: "word"; text: string } | { kind: "image"; part: ChatPart & { type: "image" } };
    const tokenize = (parts: ChatPart[]): Token[] => {
      const tokens: Token[] = [];
      for (const part of parts) {
        if (part.type === "image") {
          tokens.push({ kind: "image", part });
          continue;
        }
        for (const word of part.text.split(" ")) {
          if (word !== "") tokens.push({ kind: "word", text: word });
        }
      }
      return tokens;
    };

    /**
     * Lays out one message into a fresh container: shadowed plate, shadowed glyph text, emote
     * slots. Everything is drawn twice, offset by one pixel-cell, because a transparent overlay
     * has no background of its own — the shadow is the only thing separating text from whatever
     * the scene shows behind it.
     */
    const buildEntry = (message: ChatMessage): Entry => {
      const px = pixelSize;
      const container = new PIXI.Container();
      const shadow = container.addChild(new PIXI.Graphics());
      const ink = container.addChild(new PIXI.Graphics());
      const spriteLayer = container.addChild(new PIXI.Container());

      const maxWidth = Math.max(GLYPH_ADVANCE * px * 4, stage.width - margin() * 2);
      const lineH = LINE_CELLS * px;
      const glyphH = GLYPH_ROWS * px;
      const bodyColor = message.event === "chat" ? textColor : eventColor;

      // --- The username plate. Padding of one glyph-column each side, one pixel-cell above and
      // below the glyph rows; the sender's colour fills it, the ink colour punches the name in.
      const name = message.displayName !== "" ? message.displayName : message.username;
      const plateColor = userColor(message);
      const padX = px * 2;
      const padY = px;
      const nameWidth = name.length * GLYPH_ADVANCE * px - px;
      const plateW = nameWidth + padX * 2;
      const plateH = glyphH + padY * 2;
      shadow.rect(px, padY + px, plateW, plateH).fill({ color: shadowColor });
      ink.rect(0, padY, plateW, plateH).fill({ color: plateColor });
      drawGlyphText(ink, name, padX, padY * 2, px, plateInk);

      // --- The message body, wrapped after the plate. First line starts beside the plate;
      // continuation lines return to the left edge.
      let x = plateW + GLYPH_ADVANCE * px;
      let y = padY * 2;
      const emoteW = GLYPH_ROWS * px + px; // emotes take a square slot one glyph tall, plus a gap

      const newline = (): void => {
        x = 0;
        y += lineH;
      };

      const tokens = tokenize(
        message.parts.length > 0
          ? message.parts
          : message.text !== ""
            ? [{ type: "text", text: message.text }]
            : [],
      );

      for (const token of tokens) {
        if (token.kind === "image") {
          if (x + emoteW > maxWidth && x > 0) newline();
          const slotX = x;
          const slotY = y;
          // The slot is reserved with the emote's *name* in glyphs, then the sprite covers it when
          // the image arrives — layout never depends on the network. See the header.
          const fallback = spriteLayer.addChild(new PIXI.Graphics());
          const shownName = token.part.name.slice(0, 8);
          const fallbackW = Math.max(emoteW, shownName.length * GLYPH_ADVANCE * px);
          drawGlyphText(fallback, shownName, slotX, slotY, px, bodyColor);
          x = slotX + fallbackW + px;

          const url = token.part.url;
          void PIXI.Assets.load<PIXI.Texture>(url)
            .then((texture) => {
              // The message may have aged out (or the effect been disposed) before the CDN
              // answered; a destroyed container throws on addChild.
              if (scope.disposed || container.destroyed) return;
              // Nearest-neighbour is the whole trick: downscaling with smoothing would produce a
              // blurry smudge that breaks the pixel-art illusion.
              texture.source.scaleMode = "nearest";
              const sprite = new PIXI.Sprite(texture);
              const scale = glyphH / Math.max(1, texture.height);
              sprite.scale.set(scale);
              sprite.x = slotX;
              sprite.y = slotY;
              fallback.visible = false;
              spriteLayer.addChild(sprite);
            })
            .catch(() => {
              // Load failed: the glyph name is already on screen, so there is nothing to do.
            });
          continue;
        }

        const wordW = token.text.length * GLYPH_ADVANCE * px;
        if (x + wordW > maxWidth && x > 0) newline();
        if (wordW <= maxWidth) {
          drawGlyphText(shadow, token.text, x + px, y + px, px, shadowColor);
          drawGlyphText(ink, token.text, x, y, px, bodyColor);
          x += wordW + px;
        } else {
          // A single "word" wider than the canvas (a long URL, a keyboard mash) is hard-broken
          // character by character — the only alternative is drawing off the edge.
          for (const char of token.text) {
            if (x + GLYPH_ADVANCE * px > maxWidth) newline();
            drawGlyphText(shadow, char, x + px, y + px, px, shadowColor);
            drawGlyphText(ink, char, x, y, px, bodyColor);
            x += GLYPH_ADVANCE * px;
          }
          x += px;
        }
      }

      const height = y + lineH + padY;
      return { message, container, height, shownAt: time, y: stage.height, targetY: stage.height };
    };

    const dropEntry = (entry: Entry): void => {
      feedLayer.removeChild(entry.container);
      entry.container.destroy({ children: true });
    };

    const addMessage = (message: ChatMessage): void => {
      const entry = buildEntry(message);
      feedLayer.addChild(entry.container);
      entries.push(entry);
      while (entries.length > lineCount) {
        const oldest = entries.shift();
        if (oldest !== undefined) dropEntry(oldest);
      }
    };

    /**
     * Throws away every laid-out message and lays them all out again from the raw `ChatMessage`s.
     * Layout bakes pixel size, colours and canvas width into the geometry, so a change to any of
     * those cannot be patched in — but messages are small and rebuilds are rare (a param edit, a
     * resize), so rebuilding wholesale is the version with no partial-update bugs.
     */
    const rebuildAll = (): void => {
      const kept = entries.splice(0, entries.length);
      for (const old of kept) {
        const rebuilt = buildEntry(old.message);
        rebuilt.shownAt = old.shownAt;
        rebuilt.y = old.y;
        feedLayer.addChild(rebuilt.container);
        entries.push(rebuilt);
        dropEntry(old);
      }
    };

    stage.onResize(() => {
      rebuildAll();
    });

    // Seed the display from history so the overlay is not blank on load, then follow the live feed.
    for (const message of chat.recent().slice(-lineCount)) addMessage(message);
    const off = chat.onMessage((message) => {
      addMessage(message);
    });
    scope.defer(off);

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      time += dt;

      // Expire messages past their lifetime. Newest live at the end, so scanning from the front
      // finds all the expired ones first.
      while (entries.length > 0) {
        const oldest = entries[0];
        if (oldest === undefined || time - oldest.shownAt < lifetime) break;
        entries.shift();
        dropEntry(oldest);
      }

      // Stack bottom-up: the newest message sits at the bottom margin, each older one directly
      // above the one below it.
      let bottom = stage.height - margin();
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry === undefined) continue;
        entry.targetY = bottom - entry.height;
        bottom = entry.targetY - pixelSize * 2;
      }

      for (const entry of entries) {
        // Ease toward the target: the stack scrolls up smoothly when a message arrives instead of
        // snapping. Frame-rate independent — the same fraction of the remaining distance per
        // second regardless of fps.
        entry.y = lerp(entry.y, entry.targetY, Math.min(1, dt * 10));
        entry.container.x = margin();
        entry.container.y = entry.y;

        const age = time - entry.shownAt;
        const fadeSeconds = Math.min(3, lifetime * 0.2);
        const fadeIn = Math.min(1, age * 4);
        const fadeOut = Math.min(1, Math.max(0, (lifetime - age) / fadeSeconds));
        entry.container.alpha = fadeIn * fadeOut;
      }

      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        const before = `${pixelSize}|${textColor}|${plateInk}|${shadowColor}|${eventColor}`;
        pixelSize = int(p, "pixelSize", 3, 1, 10);
        lineCount = int(p, "lineCount", 8, 1, 30);
        lifetime = num(p, "lifetime", 45, 3, 600);
        textColor = colorHex(p, "textColor", "#e8f0e0");
        plateInk = colorHex(p, "plateInk", "#101418");
        shadowColor = colorHex(p, "shadowColor", "#0a0c10");
        eventColor = colorHex(p, "eventColor", "#ffd75e");
        while (entries.length > lineCount) {
          const oldest = entries.shift();
          if (oldest !== undefined) dropEntry(oldest);
        }
        // Only the visual params bake into geometry; lineCount and lifetime act on the next frame
        // without a rebuild.
        if (`${pixelSize}|${textColor}|${plateInk}|${shadowColor}|${eventColor}` !== before) {
          rebuildAll();
        }
      },
    };
  },
});

export default chatPixelText;
