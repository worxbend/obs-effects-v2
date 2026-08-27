import * as PIXI from "pixi.js";

import { bool, int, num, str } from "../paramUtils";
import { createPixiStage, defineEffect, onFrame, useChat } from "../sdk";
import type { ChatEventKind, ChatMessage, ChatPart } from "~/types/contract";

/**
 * Pixel Chat
 * ==========
 *
 * A chat overlay drawn entirely out of chunky pixels: each message becomes a woven "textile plate"
 * card — a ribbon of colour bands decorated with one of nine procedural stitch motifs — carrying a
 * 7×7 identicon avatar, a little humanoid pixel companion, the sender's name and the message text.
 * Cards stack up from the bottom of the screen, hover and shimmer while they live, and burst into
 * pixel sparks when they arrive. Every colour, motif and companion is derived from the sender's
 * seed, so the same user always gets the same look.
 *
 * Ported from `scenes/pixel-chat` in the old twitch-vizer repository. What changed in the port:
 *
 * - The scene's own `OverlayEventSocket` is gone; messages come from the shared `useChat` bus,
 *   which falls back to a simulated feed when Twitch is not configured. The old spacebar preview
 *   is gone for the same reason — the simulated feed replaces it.
 * - The old `razer-pixel-chat` shim (a second HTML page that set `window.PIXEL_CHAT_THEME`) is
 *   replaced by a `theme` parameter with the same two looks: the seeded rainbow palettes, or the
 *   black-and-toxic-green Razer palettes.
 * - Avatars are always the procedural identicon. The old scene could load a profile image URL,
 *   but this feed carries none (fetching them needs an authenticated Twitch API), so the fallback
 *   is now the only path.
 * - Emotes load their **static** image only; this build has no `pixi.js/gif`, so animated emotes
 *   show their first-frame still. A failed load draws the emote's name as text instead.
 * - The old `TextilePlate` class carried a large body of private drawing helpers that nothing
 *   called (particle-panel and banner painters from an earlier iteration); only the reachable
 *   ribbon-and-motif path is ported.
 * - The hard-coded card lifetime, count, gap, width and font size are parameters now.
 */

/** The pixel grid unit. Every coordinate snaps to this, which is what makes it read as pixel art. */
const PX = 4;
/** Two grid units — the "tile" the plate shapes and companions are built from. */
const TILE = PX * 2;
/** Fallbacks for the tunable constants; the descriptor defaults below must match these. */
const DEFAULT_CARD_GAP = 12;
const DEFAULT_LIFETIME_SECONDS = 34;
const DEFAULT_MAX_CARDS = 7;
const DEFAULT_FONT_SIZE = 17;
const DEFAULT_BOTTOM_MARGIN = 24;
const DEFAULT_CARD_SCALE = 0.38;
const FONT =
  '"Courier New", "Lucida Console", "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", monospace';
const TEXT_WHITE = 0xffffff;
const TEXT_BLACK = 0x050507;
const RAZER_BLACK = 0x000000;
const RAZER_DEEP = 0x020802;
const RAZER_DARK = 0x061906;
const RAZER_GREEN = 0x54f044;
const RAZER_TOXIC = 0x38ff24;
const RAZER_ACID = 0x8cff68;

type Theme = "rainbow" | "razer";

/** The named colour roles one card draws with. Derived per card from its seed and theme. */
interface Palette {
  night: number;
  plate: number;
  plateDeep: number;
  ink: number;
  edge: number;
  line: number;
  flower: number;
  leaf: number;
  gold: number;
  blue: number;
  rose: number;
  violet: number;
}

interface Spark {
  particle: PIXI.Particle;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
}

/** The tunable values a card is built with. Snapshotted at spawn so live cards never jump. */
interface CardSettings {
  theme: Theme;
  lifetimeFrames: number;
  fontSize: number;
  showEmotes: boolean;
}

/* ------------------------------------------------------------------ */
/* Small helpers ported from the old shared/overlay.ts                 */
/* ------------------------------------------------------------------ */

/** A tiny deterministic random generator (linear congruential). Same seed, same sequence — that is
 * what keeps a user's card looking identical every time they chat. */
function seedRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/** FNV-1a string hash, used to derive stable numeric seeds from names and message content. */
function hashSeed(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Parses a `#rrggbb` string into the 24-bit integer Pixi wants, or the fallback on any garbage. */
function colorFromString(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const normalized = value.startsWith("#") ? value.slice(1) : value;
  const parsed = Number.parseInt(normalized, 16);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function hslToRgb(h: number, s: number, l: number): number {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let r: number;
  let g: number;
  let b: number;

  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];

  return (
    (Math.round((r + m) * 255) << 16) |
    (Math.round((g + m) * 255) << 8) |
    Math.round((b + m) * 255)
  );
}

function mixColor(a: number, b: number, t: number): number {
  const clamped = clamp(t, 0, 1);
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  return (
    (Math.round(ar + (br - ar) * clamped) << 16) |
    (Math.round(ag + (bg - ag) * clamped) << 8) |
    Math.round(ab + (bb - ab) * clamped)
  );
}

function rgba(color: number, alpha: number): { color: number; alpha: number } {
  return { color, alpha };
}

/**
 * Indexes into a non-empty list, wrapping the index. The compiler's `noUncheckedIndexedAccess`
 * option makes every plain `list[i]` possibly `undefined`; the card code indexes colour lists in
 * dozens of places, and every list it indexes is a non-empty literal, so one helper concentrates
 * the "cannot actually happen" fallback instead of scattering `?? 0` everywhere.
 */
function pick<T>(list: readonly T[], index: number): T {
  const item = list[((Math.floor(index) % list.length) + list.length) % list.length];
  if (item === undefined) throw new Error("pick() called with an empty list");
  return item;
}

function snap(value: number, grid = PX): number {
  return Math.round(value / grid) * grid;
}

/** What the card body says: the message text for chat, a system phrase for channel events. */
function messageText(msg: ChatMessage): string {
  if (msg.event === "chat") return msg.text.trim() || "...";
  if (msg.event === "sub") {
    const months = typeof msg.data["months"] === "number" ? msg.data["months"] : 0;
    return months ? `subscribed for ${months} months` : "subscribed";
  }
  if (msg.event === "gift_sub") {
    const total = typeof msg.data["total"] === "number" ? msg.data["total"] : 1;
    return `gifted ${total} subscription${total === 1 ? "" : "s"}`;
  }
  if (msg.event === "cheer") {
    const bits = typeof msg.data["bits"] === "number" ? msg.data["bits"] : 0;
    return `cheered ${bits} bits`;
  }
  const viewers = typeof msg.data["viewers"] === "number" ? msg.data["viewers"] : 0;
  return `raided with ${viewers} viewers`;
}

/** The little tag in the card's corner: "PIXEL" for chat, the event name for everything else. */
function eventLabel(event: ChatEventKind): string {
  return event === "chat" ? "PIXEL" : event.replace("_", " ").toUpperCase();
}

/** The renderable fragments of a message: its parts when it has any, the system text otherwise. */
function textParts(msg: ChatMessage): ChatPart[] {
  if (msg.parts.length > 0) return msg.parts;
  return [{ type: "text", text: messageText(msg) }];
}

/**
 * A 1×1 white texture. Every pixel of every particle in this effect is this texture, scaled and
 * tinted — one texture means every ParticleContainer stays a single draw call.
 */
function makePixelTexture(app: PIXI.Application): PIXI.Texture {
  const g = new PIXI.Graphics();
  g.rect(0, 0, 1, 1).fill(0xffffff);
  const texture = app.renderer.generateTexture({
    target: g,
    frame: new PIXI.Rectangle(0, 0, 1, 1),
    resolution: 1,
  });
  g.destroy();
  return texture;
}

function luminance(color: number): number {
  const r = ((color >> 16) & 0xff) / 255;
  const g = ((color >> 8) & 0xff) / 255;
  const b = (color & 0xff) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Builds one card's colour roles from its seed. The Razer theme swaps the whole derivation, not
 * a tint — black plates, toxic greens — which is why it branches at the top rather than mixing. */
function makePalette(seed: number, userAccent: number, theme: Theme): Palette {
  if (theme === "razer") {
    const rng = seedRng(seed ^ 0x0badbabe);
    const toxic = mixColor(RAZER_TOXIC, RAZER_GREEN, rng() * 0.24);
    const acid = mixColor(RAZER_ACID, RAZER_TOXIC, rng() * 0.32);
    const plate = mixColor(RAZER_DARK, toxic, 0.22 + rng() * 0.14);
    const plateDeep = mixColor(RAZER_BLACK, RAZER_DEEP, 0.68);
    return {
      night: RAZER_BLACK,
      plate,
      plateDeep,
      ink: 0xf7fff4,
      edge: acid,
      line: toxic,
      flower: mixColor(acid, RAZER_GREEN, 0.38),
      leaf: RAZER_GREEN,
      gold: mixColor(RAZER_TOXIC, RAZER_ACID, 0.44),
      blue: mixColor(RAZER_DARK, RAZER_GREEN, 0.44),
      rose: mixColor(RAZER_TOXIC, 0xffffff, 0.08),
      violet: mixColor(RAZER_BLACK, RAZER_TOXIC, 0.3),
    };
  }

  const rng = seedRng(seed ^ 0x87ab3d1);
  const hue = Math.floor(rng() * 360);
  const plateHue = hue + pick([0, 34, 96, 148, 203, 276], seed % 6);
  const plate = mixColor(hslToRgb(plateHue, 0.62, 0.34), userAccent, 0.3);
  const plateDeep = mixColor(plate, 0x080712, 0.52);
  const line = hslToRgb(hue + 172, 0.88, 0.58);
  const rose = hslToRgb(hue + 314, 0.9, 0.58);
  const gold = hslToRgb(hue + 52, 0.92, 0.62);
  const blue = hslToRgb(hue + 202, 0.9, 0.6);
  const violet = hslToRgb(hue + 266, 0.8, 0.66);
  const leaf = hslToRgb(hue + 116, 0.72, 0.48);
  const night = mixColor(hslToRgb(hue + 238, 0.6, 0.11), 0x05030a, 0.52);
  const edge = mixColor(line, 0xffffff, 0.12);
  const flower = mixColor(rose, userAccent, 0.24);
  // Dark ink on a light plate, cream ink on a dark one — computed, not chosen, so every random
  // palette stays readable.
  const ink = luminance(plate) > 0.45 ? 0x100915 : 0xfff7cf;

  return { night, plate, plateDeep, ink, edge, line, flower, leaf, gold, blue, rose, violet };
}

/* ------------------------------------------------------------------ */
/* The textile plate — one card's woven background                     */
/* ------------------------------------------------------------------ */

class TextilePlate {
  readonly view = new PIXI.Container();

  constructor(
    width: number,
    height: number,
    palette: Palette,
    userAccent: number,
    seed: number,
    theme: Theme,
  ) {
    const shadow = new PIXI.Graphics();
    const base = new PIXI.Graphics();
    const edge = new PIXI.Graphics();
    const innerX = TILE;
    const innerY = TILE;
    const innerW = width - TILE * 2;
    const innerH = height - TILE * 2;
    const pattern = this.makePattern(innerW, innerH, palette, userAccent, seed, theme);

    shadow.roundRect(PX, PX * 2, width, height, TILE).fill(rgba(0x000000, 0.44));
    base.roundRect(0, 0, width, height, TILE).fill(0x120c18);
    base.roundRect(PX, PX, width - PX * 2, height - PX * 2, TILE - PX).fill(rgba(0x2a2030, 0.96));
    base.roundRect(innerX, innerY, innerW, innerH, PX).fill(rgba(palette.plateDeep, 0.6));

    edge.roundRect(0, 0, width, height, TILE).stroke({ color: 0x070609, width: PX * 2, alpha: 0.95 });
    edge
      .roundRect(PX * 2, PX * 2, width - PX * 4, height - PX * 4, PX)
      .stroke({ color: mixColor(palette.edge, 0xffffff, 0.12), width: PX, alpha: 0.48 });
    edge.rect(TILE * 3, PX, width * 0.2, PX).fill(rgba(0xffffff, 0.22));
    edge.rect(width * 0.68, height - PX * 2, width * 0.18, PX).fill(rgba(0xffffff, 0.16));

    pattern.x = innerX;
    pattern.y = innerY;

    this.view.addChild(shadow, base, pattern, edge);
  }

  private makePattern(
    width: number,
    height: number,
    palette: Palette,
    userAccent: number,
    seed: number,
    theme: Theme,
  ): PIXI.Container {
    const layer = new PIXI.Container();
    const ribbon = new PIXI.Graphics();
    const motifs = new PIXI.Graphics();
    const rng = seedRng(seed ^ 0x706174);
    const schemes = this.ribbonSchemes(palette, userAccent, theme);
    const colors = pick(schemes, seed % schemes.length);

    this.drawRibbonBands(ribbon, width, height, colors, rng);
    this.drawRibbonMotifs(motifs, width, height, colors, Math.floor(rng() * 6), rng);

    layer.addChild(ribbon, motifs);
    return layer;
  }

  private ribbonSchemes(palette: Palette, userAccent: number, theme: Theme): number[][] {
    if (theme === "razer") {
      return [
        [RAZER_BLACK, RAZER_DEEP, RAZER_DARK, RAZER_GREEN, RAZER_TOXIC, RAZER_ACID],
        [0x000000, 0x031003, 0x0a2608, 0x1fd816, 0x38ff24, 0x8cff68],
        [0x010401, 0x071807, 0x103b0c, 0x44d62c, 0x54f044, 0x9cff86],
        [mixColor(RAZER_BLACK, RAZER_GREEN, 0.18), RAZER_BLACK, RAZER_TOXIC, RAZER_DEEP, RAZER_ACID],
        [palette.night, palette.plateDeep, palette.plate, palette.line, palette.edge, palette.ink],
      ];
    }

    return [
      [0xcac2c2, 0x3f2d44, 0xffc0d8, 0xee73c8, 0x755d94],
      [0xb9cbb6, 0xf4c2b7, 0xe9958d, 0xd86fac, 0x8a4961],
      [0xe0e4eb, 0xb7c7d8, 0x72c7cf, 0x3b4459, 0x202226],
      [0x4d1418, 0x7f2418, 0xc45513, 0xf4bd42, 0xfff171],
      [0x8d6b7b, 0xcf65bd, 0xee79cb, 0xf3b5cf, 0xf7dfc4],
      [0xffdfe4, 0xffefe1, 0xd9f1df, 0x69bda7, 0x246b63, 0x82516a],
      [0xe2e4ff, 0xb88bd5, 0x8e7f8e, 0x4f515b, 0x30323a, 0x181b22],
      [0x00a7a7, 0x78f7e3, 0xfff5a3, 0xc8dc7a, 0x587451, 0x005f66],
      [0xec2f79, 0xff7ba7, 0xffc38b, 0xfff5b8, 0xf5f2ea, 0xbd2a59],
      [0x1f1646, 0x5c35b1, 0xb95dde, 0xff66c8, 0xf6a2d5, 0x85d8ff],
      [0x0b4f5f, 0x2ec4b6, 0xf6f7d7, 0xffb703, 0xfb8500, 0xd62828],
      [0x283618, 0x606c38, 0xdda15e, 0xfefae0, 0xbc6c25, 0x6f1d1b],
      [0x102542, 0x2b59c3, 0x7de2d1, 0xf7f6c5, 0xf26430, 0xa62639],
      [
        mixColor(palette.plate, 0xffffff, 0.28),
        mixColor(userAccent, 0xffffff, 0.18),
        palette.rose,
        palette.line,
        palette.violet,
      ],
    ];
  }

  private drawRibbonBands(
    g: PIXI.Graphics,
    width: number,
    height: number,
    colors: number[],
    rng: () => number,
  ): void {
    const segments = 6 + Math.floor(rng() * 4);
    let x = 0;
    for (let i = 0; i < segments; i += 1) {
      const remaining = width - x;
      const segmentW =
        i === segments - 1
          ? remaining
          : Math.max(TILE * 4, Math.round(((width / segments) * (0.72 + rng() * 0.56)) / PX) * PX);
      const color = pick(colors, i);
      g.rect(x, 0, Math.min(segmentW, remaining), height).fill(color);
      if (i > 0) g.rect(x - PX, 0, PX, height).fill(rgba(mixColor(color, 0x000000, 0.25), 0.36));
      if (rng() > 0.42) {
        const accent = pick(colors, i + 2 + Math.floor(rng() * colors.length));
        g.rect(x + Math.min(segmentW, remaining) * 0.58, 0, PX * (1 + Math.floor(rng() * 2)), height)
          .fill(rgba(mixColor(accent, 0xffffff, 0.18), 0.72));
      }
      x += segmentW;
      if (x >= width) break;
    }

    g.rect(0, 0, width, PX).fill(rgba(0xffffff, 0.24));
    g.rect(0, height - PX, width, PX).fill(rgba(0x000000, 0.32));
  }

  /** Layers two to four of the nine stitch motifs over the bands, never the same one twice. */
  private drawRibbonMotifs(
    g: PIXI.Graphics,
    width: number,
    height: number,
    colors: number[],
    motif: number,
    rng: () => number,
  ): void {
    const used = new Set<number>();
    const layers = 2 + Math.floor(rng() * 3);
    for (let layer = 0; layer < layers; layer += 1) {
      let current = (motif + layer + Math.floor(rng() * 4)) % 9;
      while (used.has(current)) current = (current + 1) % 9;
      used.add(current);

      if (current === 0) this.drawVerticalScallops(g, width, height, colors, rng);
      else if (current === 1) this.drawCrescentColumns(g, width, height, colors, rng);
      else if (current === 2) this.drawBracketWaves(g, width, height, colors, rng);
      else if (current === 3) this.drawChevronRibbon(g, width, height, colors, rng);
      else if (current === 4) this.drawDotArcRibbon(g, width, height, colors, rng);
      else if (current === 5) this.drawSwirlColumns(g, width, height, colors, rng);
      else if (current === 6) this.drawFlowerRosettes(g, width, height, colors, rng);
      else if (current === 7) this.drawDiamondChain(g, width, height, colors, rng);
      else this.drawLeafVines(g, width, height, colors, rng);
    }
    this.drawColorSprinkles(g, width, height, colors, rng);
  }

  private motifColor(colors: number[], index: number, darken = 0.2): number {
    const base = pick(colors, index + 1);
    if (index % 3 === 0) return mixColor(base, 0xffffff, 0.22);
    return mixColor(base, 0x1c1620, darken);
  }

  private drawVerticalScallops(
    g: PIXI.Graphics,
    width: number,
    height: number,
    colors: number[],
    rng: () => number,
  ): void {
    const gap = width / (4 + Math.floor(rng() * 2));
    for (let x = gap * 0.9; x < width + gap; x += gap) {
      const color = this.motifColor(colors, Math.floor(x / gap), 0.12);
      for (let y = -height * 0.2; y < height * 1.1; y += height * 0.32) {
        g.moveTo(x, y);
        g.bezierCurveTo(x + gap * 0.18, y + height * 0.08, x + gap * 0.18, y + height * 0.24, x, y + height * 0.34);
        g.stroke({ color, width: PX, alpha: 0.74 });
        g.moveTo(x + PX * 3, y);
        g.bezierCurveTo(x + gap * 0.26, y + height * 0.1, x + gap * 0.26, y + height * 0.22, x + PX * 3, y + height * 0.34);
        g.stroke({ color: mixColor(color, 0xffffff, 0.28), width: PX, alpha: 0.42 });
      }
    }
  }

  private drawCrescentColumns(
    g: PIXI.Graphics,
    width: number,
    height: number,
    colors: number[],
    rng: () => number,
  ): void {
    const cols = 5 + Math.floor(rng() * 2);
    const step = width / cols;
    for (let col = 1; col < cols; col += 1) {
      const x = col * step;
      const color = this.motifColor(colors, col, 0.06);
      for (let repeat = 0; repeat < 2; repeat += 1) {
        const y = height * (0.24 + repeat * 0.38);
        g.moveTo(x - step * 0.22, y - height * 0.24);
        g.bezierCurveTo(x + step * 0.16, y - height * 0.18, x + step * 0.16, y + height * 0.18, x - step * 0.22, y + height * 0.24);
        g.stroke({ color, width: PX, alpha: 0.58 });
        g.moveTo(x - step * 0.1, y - height * 0.2);
        g.bezierCurveTo(x + step * 0.06, y - height * 0.1, x + step * 0.06, y + height * 0.1, x - step * 0.1, y + height * 0.2);
        g.stroke({ color: mixColor(color, 0xffffff, 0.24), width: PX, alpha: 0.42 });
      }
    }
  }

  private drawBracketWaves(
    g: PIXI.Graphics,
    width: number,
    height: number,
    colors: number[],
    rng: () => number,
  ): void {
    const step = width / (5 + Math.floor(rng() * 2));
    for (let x = step * 0.55; x < width + step; x += step) {
      const color = this.motifColor(colors, Math.floor(x / step), 0.18);
      g.moveTo(x, 0);
      g.bezierCurveTo(x - step * 0.3, height * 0.22, x - step * 0.3, height * 0.78, x, height);
      g.stroke({ color, width: PX, alpha: 0.66 });
      g.moveTo(x + PX * 4, 0);
      g.bezierCurveTo(x - step * 0.14, height * 0.24, x - step * 0.14, height * 0.76, x + PX * 4, height);
      g.stroke({ color: mixColor(color, 0xffffff, 0.26), width: PX, alpha: 0.44 });
    }
  }

  private drawChevronRibbon(
    g: PIXI.Graphics,
    width: number,
    height: number,
    colors: number[],
    rng: () => number,
  ): void {
    const step = width / (5 + Math.floor(rng() * 2));
    for (let x = width * 0.12; x < width + step; x += step) {
      const color = this.motifColor(colors, Math.floor(x / step), 0.1);
      g.moveTo(x + step * 0.3, 0);
      g.lineTo(x - step * 0.08, height * 0.5);
      g.lineTo(x + step * 0.3, height);
      g.stroke({ color, width: PX * 2, alpha: 0.48 });
      g.moveTo(x + step * 0.44, 0);
      g.lineTo(x + step * 0.06, height * 0.5);
      g.lineTo(x + step * 0.44, height);
      g.stroke({ color: mixColor(color, 0xffffff, 0.22), width: PX, alpha: 0.4 });
    }
  }

  private drawDotArcRibbon(
    g: PIXI.Graphics,
    width: number,
    height: number,
    colors: number[],
    rng: () => number,
  ): void {
    const step = width / (6 + Math.floor(rng() * 2));
    for (let x = step * 0.55; x < width; x += step) {
      const color = this.motifColor(colors, Math.floor(x / step), 0.06);
      for (let i = 0; i < 7; i += 1) {
        const t = i / 6;
        const px = x - Math.sin(t * Math.PI) * step * 0.3;
        const py = height * (0.16 + t * 0.68);
        g.circle(px, py, PX * 1.5).fill(rgba(color, 0.78));
      }
    }
  }

  private drawSwirlColumns(
    g: PIXI.Graphics,
    width: number,
    height: number,
    colors: number[],
    rng: () => number,
  ): void {
    const step = width / (5 + Math.floor(rng() * 2));
    for (let x = step * 0.8; x < width + step; x += step) {
      const color = this.motifColor(colors, Math.floor(x / step), 0.24);
      for (let y = height * 0.24; y < height; y += height * 0.42) {
        g.moveTo(x - step * 0.24, y - height * 0.18);
        g.bezierCurveTo(x + step * 0.18, y - height * 0.24, x + step * 0.2, y + height * 0.08, x - step * 0.02, y + height * 0.04);
        g.bezierCurveTo(x - step * 0.22, y, x - step * 0.18, y + height * 0.2, x + step * 0.18, y + height * 0.2);
        g.stroke({ color, width: PX, alpha: 0.58 });
      }
    }
  }

  private drawFlowerRosettes(
    g: PIXI.Graphics,
    width: number,
    height: number,
    colors: number[],
    rng: () => number,
  ): void {
    const step = width / (6 + Math.floor(rng() * 3));
    for (let x = step * 0.65; x < width; x += step) {
      const cy = height * (0.28 + rng() * 0.44);
      const petal = this.motifColor(colors, Math.floor(x / step), 0.05);
      const center = pick(colors, Math.floor(x / step) + 3);
      for (let i = 0; i < 6; i += 1) {
        const angle = (i * Math.PI) / 3;
        g.circle(x + Math.cos(angle) * PX * 2.4, cy + Math.sin(angle) * PX * 2.4, PX * 1.6).fill(rgba(petal, 0.58));
      }
      g.circle(x, cy, PX * 1.35).fill(rgba(mixColor(center, 0xffffff, 0.18), 0.82));
    }
  }

  private drawDiamondChain(
    g: PIXI.Graphics,
    width: number,
    height: number,
    colors: number[],
    rng: () => number,
  ): void {
    const step = width / (7 + Math.floor(rng() * 3));
    for (let x = step * 0.5; x < width + step; x += step) {
      const y = height * (0.3 + rng() * 0.4);
      const r = PX * (3 + Math.floor(rng() * 2));
      const color = this.motifColor(colors, Math.floor(x / step), 0.1);
      g.moveTo(x, y - r);
      g.lineTo(x + r, y);
      g.lineTo(x, y + r);
      g.lineTo(x - r, y);
      g.closePath();
      g.stroke({ color, width: PX, alpha: 0.68 });
      g.circle(x, y, PX).fill(rgba(pick(colors, Math.floor(x / step) + 2), 0.68));
    }
  }

  private drawLeafVines(
    g: PIXI.Graphics,
    width: number,
    height: number,
    colors: number[],
    rng: () => number,
  ): void {
    const lanes = 2 + Math.floor(rng() * 2);
    for (let lane = 0; lane < lanes; lane += 1) {
      const y = height * ((lane + 0.7) / (lanes + 0.35));
      const color = this.motifColor(colors, lane + Math.floor(rng() * colors.length), 0.16);
      g.moveTo(width * 0.06, y);
      for (let x = width * 0.06; x < width * 0.96; x += width * 0.16) {
        g.bezierCurveTo(x + width * 0.05, y - height * 0.2, x + width * 0.1, y + height * 0.2, x + width * 0.16, y);
      }
      g.stroke({ color, width: PX, alpha: 0.38 });

      for (let x = width * 0.12; x < width * 0.94; x += width * 0.14) {
        const side = rng() > 0.5 ? -1 : 1;
        g.ellipse(x, y + side * PX * 2.2, PX * 2.8, PX * 1.3).fill(rgba(mixColor(color, 0xffffff, 0.18), 0.48));
      }
    }
  }

  private drawColorSprinkles(
    g: PIXI.Graphics,
    width: number,
    height: number,
    colors: number[],
    rng: () => number,
  ): void {
    const count = 18 + Math.floor(rng() * 20);
    for (let i = 0; i < count; i += 1) {
      const color = pick(colors, Math.floor(rng() * colors.length));
      const x = rng() * width;
      const y = height * (0.12 + rng() * 0.76);
      if (rng() > 0.55) {
        g.circle(x, y, PX * (0.7 + rng() * 0.8)).fill(rgba(color, 0.56));
      } else {
        g.rect(x, y, PX * (1 + Math.floor(rng() * 3)), PX).fill(rgba(color, 0.48));
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* The identicon avatar                                                */
/* ------------------------------------------------------------------ */

/**
 * A 7×7 mirrored pixel identicon in a framed plate, seeded per user. The old scene could replace
 * it with a downloaded profile image; this feed carries no avatar URLs, so the identicon is
 * always what is drawn.
 */
class PixelAvatar {
  readonly view = new PIXI.Container();

  constructor(texture: PIXI.Texture, seed: number, palette: Palette, userAccent: number) {
    const fallback = this.makeIdenticon(texture, seed, palette, userAccent);
    const mask = new PIXI.Graphics().rect(3, 3, 30, 30).fill(0xffffff);
    const backplate = new PIXI.Graphics()
      .rect(0, 0, 36, 36)
      .fill(rgba(0x05030a, 0.76))
      .rect(3, 3, 30, 30)
      .fill(rgba(palette.plateDeep, 0.9));
    const frame = new PIXI.Graphics()
      .rect(0, 0, 36, PX)
      .fill(palette.edge)
      .rect(0, 32, 36, PX)
      .fill(palette.rose)
      .rect(0, 0, PX, 36)
      .fill(userAccent)
      .rect(32, 0, PX, 36)
      .fill(palette.gold)
      .rect(3, 3, 30, 30)
      .stroke({ color: palette.night, width: 2, alpha: 0.78 });

    fallback.x = 4;
    fallback.y = 4;
    fallback.mask = mask;
    this.view.addChild(backplate, mask, fallback, frame);
  }

  private makeIdenticon(
    texture: PIXI.Texture,
    seed: number,
    palette: Palette,
    userAccent: number,
  ): PIXI.ParticleContainer {
    const rng = seedRng(seed ^ 0xabba);
    const layer = new PIXI.ParticleContainer({
      texture,
      roundPixels: true,
      dynamicProperties: {
        position: false,
        vertex: false,
        rotation: false,
        uvs: false,
        color: false,
      },
    });
    const particles: PIXI.Particle[] = [];
    const colors = [palette.ink, userAccent, palette.line, palette.gold, palette.rose, palette.blue];
    for (let y = 0; y < 7; y += 1) {
      for (let x = 0; x < 7; x += 1) {
        // Mirror the right half onto the left, which is what makes it read as a face-like glyph.
        const mirror = x > 3 ? 6 - x : x;
        if (rng() + mirror * 0.08 + y * 0.03 < 0.43) continue;
        particles.push(
          new PIXI.Particle({
            texture,
            x: x * PX,
            y: y * PX,
            scaleX: PX,
            scaleY: PX,
            tint: pick(colors, Math.floor(rng() * colors.length)),
            alpha: 0.96,
          }),
        );
      }
    }
    layer.addParticle(...particles);
    layer.update();
    return layer;
  }
}

/* ------------------------------------------------------------------ */
/* The pixel companion — the little figure standing on each card       */
/* ------------------------------------------------------------------ */

interface CompanionProfile {
  type: number;
  eyes: number;
  mouth: number;
  hat: number;
  body: number;
  shirt: number;
  accent: number;
  hair: number;
  skin: number;
  dark: number;
  light: number;
}

type CellFn = (x: number, y: number, tint: number, alpha?: number) => void;
type BlockFn = (x: number, y: number, w: number, h: number, tint: number, alpha?: number) => void;

/**
 * A small procedural creature: blob, humanoid, robot or tall cyclops, with a face, hat and
 * accessories, all chosen deterministically from the seed. Same user, same companion.
 */
class PixelCompanion {
  readonly view = new PIXI.Container();

  constructor(texture: PIXI.Texture, palette: Palette, userAccent: number, seed: number) {
    const shadow = new PIXI.Graphics()
      .rect(14, 67, 38, PX)
      .fill(rgba(0x000000, 0.34))
      .rect(20, 70, 26, PX)
      .fill(rgba(0x000000, 0.22));
    const layer = new PIXI.ParticleContainer({
      texture,
      roundPixels: true,
      dynamicProperties: {
        position: false,
        vertex: false,
        rotation: false,
        uvs: false,
        color: false,
      },
    });
    const rng = seedRng(seed ^ 0xc0de);
    const particles: PIXI.Particle[] = [];
    const colors = this.makeColors(palette, userAccent, seed);
    const profile: CompanionProfile = {
      type: seed % 12,
      eyes: Math.floor(seed / 13) % 8,
      mouth: Math.floor(seed / 41) % 7,
      hat: Math.floor(seed / 89) % 9,
      body: pick(colors, Math.floor(seed / 7)),
      shirt: pick(colors, Math.floor(seed / 19)),
      accent: pick(colors, Math.floor(seed / 31)),
      hair: mixColor(pick(colors, Math.floor(seed / 53)), 0x120916, 0.48),
      skin: hslToRgb(22 + (seed % 32), 0.64, 0.62),
      dark: mixColor(palette.night, 0x000000, 0.42),
      light: mixColor(pick(colors, Math.floor(seed / 101)), 0xffffff, 0.36),
    };

    const add = (x: number, y: number, w: number, h: number, tint: number, alpha = 1): void => {
      let drawX = x;
      let drawY = y;
      let drawW = w;
      let drawH = h;
      if (drawW < 0) {
        drawX += drawW;
        drawW = Math.abs(drawW);
      }
      if (drawH < 0) {
        drawY += drawH;
        drawH = Math.abs(drawH);
      }
      particles.push(
        new PIXI.Particle({
          texture,
          x: snap(drawX),
          y: snap(drawY),
          scaleX: Math.max(PX, snap(drawW)),
          scaleY: Math.max(PX, snap(drawH)),
          tint,
          alpha,
        }),
      );
    };

    const cell: CellFn = (x, y, tint, alpha = 1) => add(x * PX, y * PX, PX, PX, tint, alpha);
    const block: BlockFn = (x, y, w, h, tint, alpha = 1) => add(x * PX, y * PX, w * PX, h * PX, tint, alpha);

    if (profile.type < 5) {
      this.blobBody(cell, profile, rng);
    } else if (profile.type < 8) {
      this.humanBody(cell, block, profile, rng);
    } else if (profile.type < 10) {
      this.robotBody(cell, block, profile, rng);
    } else {
      this.tallOneEyeBody(cell, block, profile, rng);
    }

    this.face(cell, block, profile);
    this.accessories(cell, block, profile, rng, palette);
    this.dither(cell, profile, rng);

    layer.addParticle(...particles);
    layer.update();
    this.view.addChild(shadow, layer);
  }

  private makeColors(palette: Palette, userAccent: number, seed: number): number[] {
    const rng = seedRng(seed ^ 0x51357);
    return [
      userAccent,
      palette.line,
      palette.rose,
      palette.gold,
      palette.blue,
      palette.violet,
      palette.leaf,
      hslToRgb(14 + rng() * 34, 0.88, 0.54),
      hslToRgb(102 + rng() * 45, 0.74, 0.48),
      hslToRgb(190 + rng() * 42, 0.88, 0.56),
    ];
  }

  private blobBody(cell: CellFn, profile: CompanionProfile, rng: () => number): void {
    const cx = profile.type === 1 ? 8 : profile.type === 3 ? 9 : 8;
    const cy = profile.type === 2 ? 8 : 9;
    const rx = [5.7, 4.4, 5.0, 4.8, 5.8][profile.type] ?? 5.2;
    const ry = [6.0, 6.4, 5.2, 6.7, 4.9][profile.type] ?? 5.6;
    const cells: boolean[][] = [];

    for (let y = 0; y < 17; y += 1) {
      const row: boolean[] = [];
      for (let x = 0; x < 17; x += 1) {
        const nx = (x - cx) / rx;
        const ny = (y - cy) / ry;
        let inside = nx * nx + ny * ny < 1.02 + Math.sin(x * 1.1 + y * 0.6) * 0.05;
        if (profile.type === 2) inside ||= Math.abs(x - cx) < 2.5 && y > 2 && y < 14;
        if (profile.type === 3) inside ||= x > 11 && x < 15 && y > 7 && y < 11;
        row.push(inside);
      }
      cells.push(row);
    }

    for (let y = 0; y < cells.length; y += 1) {
      const row = cells[y] ?? [];
      for (let x = 0; x < row.length; x += 1) {
        if (!row[x]) continue;
        const edge = !cells[y - 1]?.[x] || !cells[y + 1]?.[x] || !row[x - 1] || !row[x + 1];
        const tint = edge ? profile.dark : y < cy - 2 ? profile.light : profile.body;
        cell(x, y + 1, tint, 0.98);
      }
    }

    if (profile.type === 0 || profile.type === 4) {
      cell(3, 3, profile.dark);
      cell(4, 2, profile.light);
      cell(12, 3, profile.dark);
      cell(11, 2, profile.light);
    }
    if (profile.type === 3) {
      for (let t = 0; t < 4; t += 1) cell(14 + t, 8 - t, profile.accent, 0.9);
    }
    cell(5, 15, profile.dark);
    cell(10, 15, profile.dark);
    if (rng() > 0.45) {
      cell(1, 9, profile.dark);
      cell(15, 9, profile.dark);
    }
  }

  private humanBody(cell: CellFn, block: BlockFn, profile: CompanionProfile, rng: () => number): void {
    block(5, 3, 7, 7, profile.dark);
    block(6, 3, 5, 7, profile.skin);
    block(5, 2, 7, 3, profile.hair);
    if (profile.type === 5) {
      block(4, 1, 8, 2, profile.hair);
      cell(3, 3, profile.hair);
      cell(12, 3, profile.hair);
    } else if (profile.type === 6) {
      block(5, 1, 7, 2, profile.accent);
      cell(11, 0, profile.light);
    } else {
      block(4, 3, 3, 2, profile.hair);
      block(10, 3, 3, 2, profile.hair);
    }
    block(5, 10, 7, 5, profile.dark);
    block(6, 10, 5, 5, profile.shirt);
    block(3, 11, 2, 4, profile.skin);
    block(12, 11, 2, 4, profile.skin);
    block(6, 15, 2, 3, profile.dark);
    block(10, 15, 2, 3, profile.dark);
    if (rng() > 0.5) {
      block(5, 10, 7, 1, profile.light, 0.62);
      cell(8, 12, profile.accent, 0.78);
    }
  }

  private robotBody(cell: CellFn, block: BlockFn, profile: CompanionProfile, rng: () => number): void {
    block(4, 3, 10, 9, profile.dark);
    block(5, 4, 8, 7, profile.body);
    block(5, 12, 8, 4, profile.dark);
    block(6, 12, 6, 3, profile.shirt);
    block(2, 7, 2, 6, profile.dark);
    block(14, 7, 2, 6, profile.dark);
    block(2, 8, 1, 4, profile.accent);
    block(15, 8, 1, 4, profile.accent);
    block(6, 16, 2, 2, profile.dark);
    block(11, 16, 2, 2, profile.dark);
    if (rng() > 0.35) {
      block(6, 1, 6, 2, profile.accent);
      cell(5, 2, profile.light);
      cell(12, 2, profile.light);
    } else {
      block(8, 0, 1, 3, profile.light);
      cell(8, 0, profile.accent);
    }
  }

  private tallOneEyeBody(cell: CellFn, block: BlockFn, profile: CompanionProfile, rng: () => number): void {
    const cx = profile.type === 10 ? 8 : 7;
    for (let y = 1; y < 17; y += 1) {
      const taper = y < 5 ? 5 - y : y > 13 ? y - 13 : 0;
      const left = Math.max(4, cx - 4 + taper);
      const right = Math.min(13, cx + 4 - taper);
      for (let x = left; x <= right; x += 1) {
        const edge = x === left || x === right || y === 1 || y === 16;
        cell(x, y, edge ? profile.dark : y < 6 ? profile.light : profile.body, 0.98);
      }
    }
    block(2, 8, 3, 2, profile.dark);
    block(12, 8, 3, 2, profile.dark);
    if (rng() > 0.42) {
      block(7, 0, 2, 2, profile.accent);
      block(6, 1, 4, 1, profile.dark);
    }
  }

  private face(cell: CellFn, block: BlockFn, profile: CompanionProfile): void {
    const eye = profile.eyes % 3 === 0 ? 0xffffff : profile.eyes % 3 === 1 ? 0xfff07a : 0xbfffff;
    const pupil = 0x081018;
    if (profile.type === 1 || profile.type >= 10) {
      block(6, 6, 5, 4, profile.dark);
      block(7, 6, 3, 3, eye);
      cell(8, 7, pupil);
    } else if (profile.eyes === 3) {
      block(5, 7, 3, 1, pupil);
      block(10, 7, 3, 1, pupil);
    } else if (profile.eyes === 6) {
      block(5, 6, 3, 3, eye);
      block(10, 6, 3, 3, eye);
      cell(6, 7, pupil);
      cell(11, 7, pupil);
    } else {
      block(5, 6, 2, 2, eye);
      block(11, 6, 2, 2, eye);
      cell(6, 7, pupil);
      cell(11, 7, pupil);
    }

    if (profile.mouth === 0) block(6, 10, 6, 1, pupil);
    else if (profile.mouth === 1) {
      block(6, 10, 6, 2, pupil);
      cell(7, 10, 0xfff0c0);
      cell(10, 10, 0xfff0c0);
    } else if (profile.mouth === 2) {
      block(7, 10, 4, 1, pupil);
      cell(6, 9, pupil);
      cell(11, 9, pupil);
    } else if (profile.mouth === 3) block(7, 10, 4, 2, profile.accent);
    else block(7, 10, 5, 1, pupil);
  }

  private accessories(
    cell: CellFn,
    block: BlockFn,
    profile: CompanionProfile,
    rng: () => number,
    palette: Palette,
  ): void {
    if (profile.hat === 0) {
      block(4, 1, 10, 1, profile.accent);
      block(6, 0, 6, 1, profile.accent);
    } else if (profile.hat === 1) {
      block(5, 0, 8, 2, profile.dark);
      block(6, -1, 6, 1, profile.light);
    } else if (profile.hat === 2) {
      block(4, 2, 10, 1, palette.gold);
      block(6, 0, 6, 2, profile.accent);
    } else if (profile.hat === 3) {
      block(6, 0, 2, 3, profile.dark);
      block(11, 0, 2, 3, profile.dark);
      cell(6, 0, profile.light);
      cell(12, 0, profile.light);
    } else if (profile.hat === 4) {
      block(4, 6, 10, 1, 0xffffff, 0.86);
      cell(6, 7, palette.blue);
      cell(11, 7, palette.blue);
    } else if (profile.hat === 5) {
      block(12, 5, 4, 1, profile.accent);
      cell(15, 4, profile.light);
    }

    if (rng() > 0.55) {
      block(3, 13, 2, 1, profile.accent, 0.82);
      block(13, 13, 2, 1, profile.accent, 0.82);
    }
    if (rng() > 0.72) {
      block(7, 12, 4, 1, profile.light, 0.74);
      cell(9, 13, profile.shirt, 0.84);
    }
  }

  private dither(cell: CellFn, profile: CompanionProfile, rng: () => number): void {
    const colors = [profile.body, profile.light, profile.accent];
    for (let i = 0; i < 10; i += 1) {
      const x = 4 + Math.floor(rng() * 9);
      const y = 5 + Math.floor(rng() * 10);
      cell(x, y, pick(colors, Math.floor(rng() * colors.length)), 0.28 + rng() * 0.32);
    }
  }
}

/* ------------------------------------------------------------------ */
/* One card                                                            */
/* ------------------------------------------------------------------ */

class PixelChatCard {
  readonly view = new PIXI.Container();
  readonly height: number;
  readonly width: number;
  readonly layoutSeed: number;
  private readonly fx = new PIXI.Graphics();
  private readonly noise = new PIXI.Graphics();
  private readonly lifetime: number;
  private readonly seed: number;
  private readonly fxColors: number[];
  private readonly companion: PIXI.Container;
  private readonly companionBaseY: number;
  private age = 0;
  private assignedX = 0;
  private targetX = 0;
  private targetY = 0;
  private positioned = false;

  constructor(
    parent: PIXI.Container,
    texture: PIXI.Texture,
    msg: ChatMessage,
    width: number,
    palette: Palette,
    userSeed: number,
    userAccent: number,
    seed: number,
    settings: CardSettings,
  ) {
    this.width = width;
    this.seed = seed;
    this.layoutSeed = seed;
    this.lifetime = settings.lifetimeFrames;
    this.fxColors = [
      TEXT_WHITE,
      userAccent,
      palette.line,
      palette.rose,
      palette.gold,
      palette.blue,
      palette.violet,
      palette.leaf,
    ];
    this.view.label = `pixel-chat:${msg.username}`;
    this.view.alpha = 0;

    const avatarSize = 36;
    const textX = 112;
    const avatarX = width - avatarSize - 22;
    const wrap = Math.max(210, avatarX - textX - 20);
    const content = this.makeContent(msg, palette, wrap, settings);
    const name = new PIXI.Text({
      text: msg.displayName || msg.username || "anonymous",
      style: {
        fontFamily: FONT,
        fontSize: settings.fontSize + 1,
        fontWeight: "900",
        fill: TEXT_BLACK,
        letterSpacing: 0,
        stroke: { color: TEXT_WHITE, width: 3 },
      },
    });
    const tag = new PIXI.Text({
      text: eventLabel(msg.event),
      style: {
        fontFamily: FONT,
        fontSize: 11,
        fontWeight: "900",
        fill: TEXT_BLACK,
        letterSpacing: 0,
        stroke: { color: TEXT_WHITE, width: 2 },
      },
    });

    this.height = Math.max(92, Math.ceil(content.height + 62));
    const plate = new TextilePlate(width, this.height, palette, userAccent, seed, settings.theme);
    const avatar = new PixelAvatar(texture, userSeed, palette, userAccent);
    const companion = new PixelCompanion(texture, palette, userAccent, userSeed ^ seed);

    name.x = textX;
    name.y = 16;
    tag.x = Math.max(textX, avatarX - tag.width - 12);
    tag.y = 20;
    content.x = textX;
    content.y = 43;
    avatar.view.x = avatarX;
    avatar.view.y = Math.round((this.height - avatarSize) / 2);
    companion.view.x = 24;
    companion.view.y = Math.max(0, Math.round((this.height - 76) / 2));
    this.companion = companion.view;
    this.companionBaseY = companion.view.y;

    this.view.addChild(plate.view, this.fx, companion.view, name, tag, content, avatar.view, this.noise);
    parent.addChild(this.view);
  }

  setInitialX(x: number): void {
    this.assignedX = x;
    this.targetX = this.assignedX;
    if (!this.positioned) {
      this.view.x = this.assignedX;
    }
  }

  setTargetY(y: number): void {
    this.targetX = this.assignedX;
    this.targetY = y;
    if (!this.positioned) {
      this.view.x = this.assignedX;
      this.view.y = y + 16;
      this.positioned = true;
    }
  }

  /** Advances the card by `delta` (in 60ths of a second). Returns true when its life is over. */
  update(delta: number): boolean {
    this.age += delta;
    const enter = clamp(this.age / 20, 0, 1);
    const leave = this.age > this.lifetime - 60 ? clamp((this.lifetime - this.age) / 60, 0, 1) : 1;
    const ease = 1 - Math.pow(1 - enter, 3);
    const shimmer = Math.sin((this.age + (this.seed % 53)) * 0.22) * 0.04;
    const glitch = Math.max(1 - enter, 1 - leave);
    const jitter = snap((Math.sin(this.age * 3.8 + this.seed) + Math.cos(this.age * 1.7)) * glitch * PX, PX);
    const hoverX = snap(Math.sin((this.age + (this.seed % 101)) * 0.032) * PX, PX);
    const hoverY = snap(Math.sin((this.age + (this.seed % 89)) * 0.045) * PX * 1.5, PX);

    this.view.x += (this.targetX + hoverX + jitter - this.view.x) * 0.22 * delta;
    this.view.y += (this.targetY + hoverY - this.view.y) * 0.24 * delta;
    this.view.alpha = ease * leave * (0.94 + shimmer);
    this.view.scale.x = 1 + glitch * 0.012 + Math.sin(this.age * 0.035 + this.seed) * 0.003;
    this.view.scale.y = 1 - glitch * 0.008 + Math.cos(this.age * 0.031 + this.seed) * 0.003;
    this.companion.y = this.companionBaseY + snap(Math.sin((this.age + (this.seed % 37)) * 0.12) * 2, PX);
    this.companion.x = 24 + snap(Math.sin((this.age + (this.seed % 71)) * 0.07) * 1.5, PX);
    this.drawEffects(enter, leave);
    this.drawNoise(glitch);

    return this.age >= this.lifetime;
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }

  /** Lays out the message body: word-wrapped text runs with inline emote images between them. */
  private makeContent(msg: ChatMessage, palette: Palette, wrap: number, settings: CardSettings): PIXI.Container {
    const content = new PIXI.Container();
    const style = {
      fontFamily: FONT,
      fontSize: settings.fontSize,
      fontWeight: "900" as const,
      fill: TEXT_WHITE,
      lineHeight: 24,
      letterSpacing: 0,
      stroke: { color: TEXT_BLACK, width: 3 },
      dropShadow: {
        color: 0x000000,
        alpha: 0.42,
        distance: 2,
        blur: 0,
      },
    };
    const imageSize = 24;
    const gap = 4;
    const lineHeight = 24;
    let x = 0;
    let y = 0;
    let hasContent = false;

    const newline = (): void => {
      x = 0;
      y += lineHeight;
    };
    const place = (node: PIXI.Container, nodeWidth: number, nodeHeight = lineHeight): void => {
      if (x > 0 && x + nodeWidth > wrap) newline();
      node.x = x;
      node.y = y + Math.max(0, Math.floor((lineHeight - nodeHeight) / 2));
      content.addChild(node);
      x += nodeWidth + gap;
      hasContent = true;
    };
    const addText = (text: string): void => {
      for (const chunk of text.match(/\S+\s*|\s+/g) ?? []) {
        if (!chunk.trim()) {
          x = Math.min(wrap, x + 8);
          continue;
        }
        const label = new PIXI.Text({ text: chunk, style });
        if (label.width > wrap) label.scale.x = wrap / label.width;
        place(label, Math.min(label.width, wrap), label.height);
      }
    };
    const addImage = (part: ChatPart & { type: "image" }): void => {
      if (!settings.showEmotes || !part.url) {
        addText(part.name || "?");
        return;
      }
      const holder = new PIXI.Container();
      holder.addChild(
        new PIXI.Graphics()
          .rect(0, 0, imageSize, imageSize)
          .fill(rgba(palette.night, 0.7))
          .rect(PX, PX, imageSize - PX * 2, imageSize - PX * 2)
          .stroke({ color: palette.gold, width: 2, alpha: 0.78 }),
      );
      this.loadInlineImage(part, holder, imageSize);
      place(holder, imageSize, imageSize);
    };

    for (const part of textParts(msg)) {
      if (part.type === "image") addImage(part);
      else addText(part.text);
    }

    if (!hasContent) addText(messageText(msg));
    return content;
  }

  /**
   * Loads an emote's static image into its bordered holder. Always the static URL — this build
   * ships no GIF decoder, so animated emotes show a still. A failed load (a dead CDN URL, a
   * blocked network) draws the emote's name as text: an emote that renders as its code is still
   * readable, a broken image box is not.
   */
  private loadInlineImage(part: ChatPart & { type: "image" }, holder: PIXI.Container, size: number): void {
    PIXI.Assets.load<PIXI.Texture>({ src: part.url, parser: "texture" })
      .then((texture) => {
        if (holder.destroyed) return;
        const sprite = new PIXI.Sprite(texture);
        sprite.roundPixels = true;
        const inner = size - 4;
        const scale = inner / Math.max(sprite.width, sprite.height, 1);
        sprite.scale.set(scale);
        sprite.x = 2 + Math.round((inner - sprite.width) / 2);
        sprite.y = 2 + Math.round((inner - sprite.height) / 2);
        holder.addChild(sprite);
      })
      .catch(() => {
        if (holder.destroyed) return;
        const name = part.name.trim() || "?";
        const fallback = new PIXI.Text({
          text: name,
          style: {
            fontFamily: FONT,
            fontSize: name.length <= 2 ? 18 : 10,
            fontWeight: "900",
            fill: 0xffffff,
            letterSpacing: 0,
          },
        });
        if (fallback.width > size - 4) fallback.scale.x = (size - 4) / fallback.width;
        fallback.x = Math.round((size - fallback.width) / 2);
        fallback.y = Math.round((size - fallback.height) / 2);
        holder.addChild(fallback);
      });
  }

  private drawNoise(amount: number): void {
    this.noise.clear();
    if (amount < 0.04) return;
    const rng = seedRng(this.seed ^ Math.floor(this.age * 19));
    for (let i = 0; i < 8 + amount * 12; i += 1) {
      const y = snap(rng() * this.height);
      const x = snap(rng() * this.width);
      const w = TILE * (1 + Math.floor(rng() * 6));
      this.noise.rect(x, y, w, PX).fill(rgba(rng() > 0.5 ? 0xffffff : 0x000000, 0.12 + amount * 0.18));
    }
  }

  private drawEffects(enter: number, leave: number): void {
    this.fx.clear();
    const rng = seedRng(this.seed ^ 0xeffec7);
    this.drawSparkles(rng, enter, leave);
    this.drawSparks(rng, enter, leave);
    this.drawSplashes(rng, enter);
    this.drawBleeding(rng, enter, leave);
    this.drawEvaporation(rng, leave);
  }

  private drawSparkles(rng: () => number, enter: number, leave: number): void {
    const count = 12;
    for (let i = 0; i < count; i += 1) {
      const edge = rng();
      const x = edge < 0.5 ? rng() * this.width : rng() > 0.5 ? -PX * 2 : this.width + PX;
      const y = edge < 0.5 ? (rng() > 0.5 ? -PX : this.height + PX) : rng() * this.height;
      const pulse = Math.max(0, Math.sin(this.age * 0.12 + i * 1.7 + this.seed));
      const alpha = pulse * 0.82 * enter * leave;
      if (alpha < 0.08) continue;
      const color = pick(this.fxColors, i);
      this.fx.rect(snap(x), snap(y), PX, PX * 3).fill(rgba(color, alpha));
      this.fx.rect(snap(x - PX), snap(y + PX), PX * 3, PX).fill(rgba(color, alpha));
    }
  }

  private drawSparks(rng: () => number, enter: number, leave: number): void {
    for (let i = 0; i < 14; i += 1) {
      const phase = (this.age * (0.018 + rng() * 0.018) + rng() * 80) % 1;
      const side = rng() > 0.5 ? 1 : -1;
      const originX = side > 0 ? this.width - PX * 4 : PX * 4;
      const originY = this.height * (0.18 + rng() * 0.64);
      const x = originX + side * phase * (PX * (8 + rng() * 13));
      const y = originY - phase * (PX * (3 + rng() * 11)) + Math.sin(phase * Math.PI * 2) * PX;
      const alpha = (1 - phase) * enter * leave * 0.72;
      const color = pick(this.fxColors, i + 2);
      this.fx.rect(snap(x), snap(y), PX * (rng() > 0.72 ? 2 : 1), PX).fill(rgba(color, alpha));
    }
  }

  private drawSplashes(rng: () => number, enter: number): void {
    const splash = clamp(1 - this.age / 54, 0, 1) * enter;
    if (splash <= 0.02) return;
    for (let cluster = 0; cluster < 4; cluster += 1) {
      const cx = cluster % 2 === 0 ? PX * (6 + rng() * 12) : this.width - PX * (6 + rng() * 12);
      const cy = this.height * (0.22 + rng() * 0.58);
      const color = pick(this.fxColors, cluster + 3);
      for (let i = 0; i < 8; i += 1) {
        const angle = rng() * Math.PI * 2;
        const dist = (1 - splash) * PX * (6 + rng() * 14);
        this.fx
          .rect(
            snap(cx + Math.cos(angle) * dist),
            snap(cy + Math.sin(angle) * dist),
            PX * (rng() > 0.62 ? 2 : 1),
            PX * (rng() > 0.78 ? 2 : 1),
          )
          .fill(rgba(color, splash * (0.38 + rng() * 0.42)));
      }
    }
  }

  private drawBleeding(rng: () => number, enter: number, leave: number): void {
    const count = 9;
    for (let i = 0; i < count; i += 1) {
      const x = this.width * (0.08 + (i / Math.max(1, count - 1)) * 0.84) + (rng() - 0.5) * PX * 4;
      const pulse = 0.5 + 0.5 * Math.sin(this.age * (0.025 + rng() * 0.035) + i * 1.9);
      const length = snap(PX * (2 + pulse * 5 + rng() * 3), PX);
      const color = pick(this.fxColors, i + 1);
      const alpha = enter * leave * (0.2 + pulse * 0.32);
      this.fx.rect(snap(x), this.height - PX, PX * (rng() > 0.72 ? 2 : 1), length).fill(rgba(color, alpha));
      if (pulse > 0.72) this.fx.rect(snap(x), this.height + length + PX, PX, PX).fill(rgba(color, alpha * 0.8));
    }
  }

  private drawEvaporation(rng: () => number, leave: number): void {
    const evaporate = Math.max(0.18, 1 - leave);
    for (let i = 0; i < 12; i += 1) {
      const phase = (this.age * (0.006 + rng() * 0.01) + rng() * 30) % 1;
      const x = this.width * (0.08 + rng() * 0.84) + Math.sin(phase * Math.PI * 2 + i) * PX * 3;
      const y = -PX - phase * PX * (7 + rng() * 13);
      const alpha = (1 - phase) * evaporate * 0.42;
      const color = pick(this.fxColors, i + 5);
      this.fx.rect(snap(x), snap(y), PX * (rng() > 0.68 ? 2 : 1), PX).fill(rgba(color, alpha));
      if (rng() > 0.64) this.fx.rect(snap(x + PX * 2), snap(y - PX * 2), PX, PX).fill(rgba(TEXT_WHITE, alpha * 0.62));
    }
  }
}

/* ------------------------------------------------------------------ */
/* The effect                                                          */
/* ------------------------------------------------------------------ */

const pixelChat = defineEffect({
  descriptor: {
    id: "pixel-chat",
    name: "Pixel Chat",
    description:
      "Twitch chat as procedural pixel-art cards: woven textile plates with seeded colour palettes, identicon avatars, little pixel companions and spark bursts, stacking up from the bottom of the screen.",
    engine: "pixi",
    category: "chat",
    tags: ["chat", "twitch", "pixel", "retro", "cards", "razer"],
    previewNotes:
      "When Twitch is not configured (or unreachable), a simulated chat feed sends a gentle canned message every few seconds, so cards appear on their own — the first one may take a moment. Transparent background; sized for a full-screen browser source. The Razer theme swaps every palette for black and toxic green.",
    params: [
      {
        key: "theme",
        label: "Theme",
        kind: "select",
        default: "rainbow",
        options: ["rainbow", "razer"],
        description:
          "Colour scheme. \"rainbow\" derives a fresh colourful palette from each message's seed; \"razer\" locks everything to black plates and toxic greens. Applies to cards spawned after the change.",
      },
      {
        key: "maxCards",
        label: "Max Cards",
        kind: "number",
        default: DEFAULT_MAX_CARDS,
        min: 1,
        max: 15,
        step: 1,
        description: "How many message cards can be on screen at once. The oldest is dropped when a new one arrives.",
      },
      {
        key: "lifetime",
        label: "Card Lifetime",
        kind: "number",
        default: DEFAULT_LIFETIME_SECONDS,
        min: 5,
        max: 180,
        step: 1,
        description: "How long one card stays on screen, in seconds, including its fade-out. Applies to new cards.",
      },
      {
        key: "cardGap",
        label: "Card Gap",
        kind: "number",
        default: DEFAULT_CARD_GAP,
        min: 0,
        max: 64,
        step: 1,
        description: "Vertical space between stacked cards, in pixels.",
      },
      {
        key: "cardScale",
        label: "Card Width",
        kind: "number",
        default: DEFAULT_CARD_SCALE,
        min: 0.2,
        max: 0.8,
        step: 0.01,
        description:
          "Card width as a fraction of the screen width (still clamped between 430 and 690 pixels, so cards stay readable on any resolution). Applies to new cards.",
      },
      {
        key: "fontSize",
        label: "Font Size",
        kind: "number",
        default: DEFAULT_FONT_SIZE,
        min: 12,
        max: 28,
        step: 1,
        description: "Message text size in pixels. The username is drawn one pixel larger. Applies to new cards.",
      },
      {
        key: "bottomMargin",
        label: "Bottom Margin",
        kind: "number",
        default: DEFAULT_BOTTOM_MARGIN,
        min: 0,
        max: 200,
        step: 2,
        description: "Space kept clear between the lowest card and the bottom edge of the screen, in pixels.",
      },
      {
        key: "showEmotes",
        label: "Show Emotes",
        kind: "boolean",
        default: true,
        description:
          "Draw Twitch emotes and emoji as inline images. Off, their names are drawn as plain text instead — useful when the CDN is unreachable.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    // Pixel art wants hard edges: antialiasing would soften every square this effect draws.
    const stage = await createPixiStage(scope, ctx, { antialias: false });
    stage.app.canvas.style.imageRendering = "pixelated";

    const readTheme = (p: Record<string, unknown>): Theme =>
      str(p, "theme", "rainbow") === "razer" ? "razer" : "rainbow";

    let theme = readTheme(ctx.params);
    let maxCards = int(ctx.params, "maxCards", DEFAULT_MAX_CARDS, 1, 15);
    // Card ages tick in 60ths of a second (the unit the old scene's Pixi ticker used), so every
    // ported timing constant keeps its original value; the lifetime converts seconds to that unit.
    let lifetimeFrames = num(ctx.params, "lifetime", DEFAULT_LIFETIME_SECONDS, 5, 180) * 60;
    let cardGap = int(ctx.params, "cardGap", DEFAULT_CARD_GAP, 0, 64);
    let cardScale = num(ctx.params, "cardScale", DEFAULT_CARD_SCALE, 0.2, 0.8);
    let fontSize = int(ctx.params, "fontSize", DEFAULT_FONT_SIZE, 12, 28);
    let bottomMargin = int(ctx.params, "bottomMargin", DEFAULT_BOTTOM_MARGIN, 0, 200);
    let showEmotes = bool(ctx.params, "showEmotes", true);

    const pixelTexture = makePixelTexture(stage.app);
    // Belt and braces: app.destroy(texture: true) in the stage teardown also reaches it, but the
    // explicit destroy keeps this texture's lifetime visible in the one file that made it.
    scope.defer(() => {
      if (!pixelTexture.destroyed) pixelTexture.destroy(true);
    });

    // Added before any card, so burst sparks render underneath the cards, as in the original.
    const sparkLayer = stage.stage.addChild(
      new PIXI.ParticleContainer({
        texture: pixelTexture,
        roundPixels: true,
        dynamicProperties: {
          position: true,
          vertex: false,
          rotation: false,
          uvs: false,
          color: true,
        },
      }),
    );

    let cards: PixelChatCard[] = [];
    const sparks: Spark[] = [];
    /** One accent colour per user, fixed on first sight, so a user's cards never change hue. */
    const userAccents = new Map<string, number>();
    let serial = 0;

    const cardWidth = (): number => snap(clamp(stage.width * cardScale, 430, 690), PX);

    const layoutCards = (): void => {
      let y = stage.height - bottomMargin;
      for (const card of cards) {
        y -= card.height;
        card.setTargetY(y);
        y -= cardGap;
      }
    };

    const randomCardLeft = (card: PixelChatCard): number => {
      const screenW = stage.width;
      const margin = screenW < 720 ? 10 : 24;
      const maxLeft = Math.max(margin, screenW - card.width - margin);
      const range = Math.max(0, maxLeft - margin);
      if (range <= 0) return margin;

      const rng = seedRng(card.layoutSeed ^ (card.width * 17) ^ Math.floor(card.height * 31));
      const lanes = Math.max(1, Math.floor(range / Math.max(140, card.width * 0.28)));
      const lane = lanes <= 1 ? 0 : Math.floor(rng() * lanes);
      const laneWidth = range / lanes;
      const laneJitter = Math.max(0, laneWidth - card.width * 0.12);
      return snap(margin + lane * laneWidth + rng() * laneJitter, PX);
    };

    const userKey = (username: string): string => username.trim().toLowerCase() || "anonymous";

    const userAccent = (msg: ChatMessage, key: string, userSeed: number): number => {
      const existing = userAccents.get(key);
      if (existing !== undefined) return existing;
      let color: number;
      if (theme === "razer") {
        const rng = seedRng(userSeed ^ 0x44d62c);
        color = mixColor(rng() > 0.5 ? RAZER_TOXIC : RAZER_GREEN, RAZER_ACID, 0.18 + rng() * 0.32);
      } else {
        const fallback = hslToRgb(userSeed % 360, 0.82, 0.58);
        color = colorFromString(msg.color, fallback);
      }
      userAccents.set(key, color);
      return color;
    };

    /** A fresh seed per card: stable inputs plus a serial and randomness, so the same user's
     * consecutive messages still get different plates while their accent colour stays fixed. */
    const nextSeed = (msg: ChatMessage, key: string, userSeed: number): number => {
      serial += 1;
      return hashSeed(
        [
          "pixel-chat",
          key,
          userSeed,
          msg.event,
          msg.text,
          serial,
          performance.now().toFixed(3),
          Math.floor(Math.random() * 0xffffffff),
        ].join(":"),
      );
    };

    const burst = (card: PixelChatCard, palette: Palette, seed: number): void => {
      const rng = seedRng(seed ^ 0x5f1ce);
      const colors = [palette.line, palette.rose, palette.gold, palette.blue, palette.violet, palette.leaf];
      const x = card.view.x + 44 + rng() * 110;
      const y = card.view.y + 18 + rng() * Math.max(36, card.height - 24);

      for (let i = 0; i < 38; i += 1) {
        const speed = 1.3 + rng() * 3.4;
        const angle = -Math.PI * 0.88 + rng() * Math.PI * 0.95;
        const size = rng() > 0.76 ? TILE : PX;
        const particle = new PIXI.Particle({
          texture: pixelTexture,
          x,
          y,
          scaleX: size,
          scaleY: size,
          tint: pick(colors, Math.floor(rng() * colors.length)),
          alpha: 0.92,
        });
        sparkLayer.addParticle(particle);
        sparks.push({
          particle,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 0,
          maxLife: 42 + rng() * 36,
        });
      }
    };

    const spawn = (msg: ChatMessage, withBurst: boolean): void => {
      const key = userKey(msg.username);
      const userSeed = msg.seed || hashSeed(key);
      const accent = userAccent(msg, key, userSeed);
      const seed = nextSeed(msg, key, userSeed);
      const palette = makePalette(seed, accent, theme);
      const card = new PixelChatCard(stage.stage, pixelTexture, msg, cardWidth(), palette, userSeed, accent, seed, {
        theme,
        lifetimeFrames,
        fontSize,
        showEmotes,
      });
      card.setInitialX(randomCardLeft(card));

      cards.unshift(card);
      while (cards.length > maxCards) {
        cards.pop()?.destroy();
      }
      layoutCards();
      if (withBurst) burst(card, palette, seed);
    };

    const updateSparks = (delta: number): void => {
      for (let i = sparks.length - 1; i >= 0; i -= 1) {
        const spark = sparks[i];
        if (spark === undefined) continue;
        spark.life += delta;
        spark.particle.x += spark.vx * delta;
        spark.particle.y += spark.vy * delta;
        spark.vy += 0.052 * delta;
        spark.particle.alpha = clamp(1 - spark.life / spark.maxLife, 0, 1);
        if (spark.life >= spark.maxLife) {
          sparkLayer.removeParticle(spark.particle);
          sparks.splice(i, 1);
        }
      }
    };

    const chat = await useChat(scope);
    scope.checkpoint();

    // Seed the stack from history so the overlay is not empty on mount — only as many messages as
    // fit, and without the arrival burst, which would fire a firework per backlog message.
    for (const message of chat.recent().slice(-maxCards)) spawn(message, false);
    const off = chat.onMessage((message) => spawn(message, true));
    scope.defer(off);

    stage.onResize(() => layoutCards());

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      // The old scene ran on Pixi's ticker, whose delta is "one" at 60 frames per second. Feeding
      // the same unit keeps every ported constant (lifetimes, easing rates, spark speeds) exact.
      const delta = dt * 60;

      let removed = false;
      for (let i = cards.length - 1; i >= 0; i -= 1) {
        const card = cards[i];
        if (card === undefined) continue;
        if (card.update(delta)) {
          card.destroy();
          cards.splice(i, 1);
          removed = true;
        }
      }
      if (removed) layoutCards();
      updateSparks(delta);

      stage.render();
    });

    scope.defer(() => {
      for (const card of cards) card.destroy();
      cards = [];
    });

    return {
      setParams(p: Record<string, unknown>): void {
        theme = readTheme(p);
        maxCards = int(p, "maxCards", DEFAULT_MAX_CARDS, 1, 15);
        lifetimeFrames = num(p, "lifetime", DEFAULT_LIFETIME_SECONDS, 5, 180) * 60;
        cardGap = int(p, "cardGap", DEFAULT_CARD_GAP, 0, 64);
        cardScale = num(p, "cardScale", DEFAULT_CARD_SCALE, 0.2, 0.8);
        fontSize = int(p, "fontSize", DEFAULT_FONT_SIZE, 12, 28);
        bottomMargin = int(p, "bottomMargin", DEFAULT_BOTTOM_MARGIN, 0, 200);
        showEmotes = bool(p, "showEmotes", true);

        // A lowered card count takes effect at once rather than waiting for the next message.
        while (cards.length > maxCards) {
          cards.pop()?.destroy();
        }
        layoutCards();
      },
    };
  },
});

export default pixelChat;
