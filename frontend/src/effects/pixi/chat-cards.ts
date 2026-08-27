import * as PIXI from "pixi.js";

import { int, num } from "../paramUtils";
import { createPixiStage, defineEffect, onFrame, useChat } from "../sdk";
import type { ChatMessage, ChatPart } from "~/types/contract";

/**
 * Chat Cards
 * ==========
 *
 * A pixel-art chat feed: each message becomes a chunky "trading card" stacked upward from the
 * bottom-left corner. Every card carries a seeded procedural background pattern (one of 42
 * motifs — rings, circuits, drips, sunbursts, ...), a per-user pixel mascot creature peeking over
 * the left edge, a 7×7 identicon avatar, and a confetti burst when it lands. Cards glitch in,
 * live for a while, glitch out.
 *
 * Ported from `scenes/chat/chat.ts` in the old `twitch-vizer` repository. What changed in the port:
 *
 *  - The old scene opened its own WebSocket (`OverlayEventSocket`) straight to the vizer backend
 *    and had a keyboard shortcut to spawn preview messages. Both are gone: chat now comes from the
 *    shared `useChat` bus, which delivers real Twitch messages when the backend is configured and
 *    a gentle simulated feed when it is not — so previews happen without any keyboard.
 *  - `VisualEventMsg` became the contract's `ChatMessage`. The wire model carries no avatar URL
 *    (that would need an authenticated Twitch API call the backend deliberately does not make), so
 *    the old "load the profile image, fall back to an identicon" path is now identicon-only —
 *    which the original already drew first anyway.
 *  - Emotes are loaded through `PIXI.Assets.load` using the **static** image URL only. The old
 *    repository had a GIF plugin for animated emotes; this application does not, and an animated
 *    emote shows its static frame instead. A failed load draws the emote's name as text.
 *  - The hard-coded constants (`PX`, `CARD_GAP`, `MAX_CARDS`, `CARD_LIFETIME`, the card width
 *    clamp) are parameters now. The card look itself — palettes, motifs, mascots, the glitch
 *    envelope — is untouched.
 *  - Card ages were counted in Pixi ticker frames (60 per second). The port keeps those internal
 *    units, deriving them from the SDK clock's `dt`, so every timing constant from the original
 *    still means what it meant.
 */

interface Palette {
  base: number;
  panel: number;
  ink: number;
  dim: number;
  accent: number;
  pop: number;
  glow: number;
}

interface MovingParticle {
  particle: PIXI.Particle;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
}

/**
 * The pixel grid every drawing routine snaps to, plus the live settings the cards share.
 *
 * The original kept these as module constants; here one object is threaded through the card
 * classes so that the admin's parameter values reach them. `lifetimeFrames` is read on every
 * update rather than copied into the card, so changing the lifetime affects cards already on
 * screen.
 */
interface CardConfig {
  /** Size of one logical pixel. Everything chunky about the look comes from this. */
  px: number;
  /** The coarser grid the background plates snap to — always twice `px`, as in the original. */
  plate: number;
  /** Vertical gap between stacked cards. */
  gap: number;
  /** How many cards may exist at once; the oldest is destroyed beyond this. */
  maxCards: number;
  /** Card lifetime in 60ths of a second (the original's ticker-frame unit). */
  lifetimeFrames: number;
  /** Bounds of the card width clamp (the original hard-coded 420..640 at 36% of screen width). */
  widthMin: number;
  widthMax: number;
}

/** How many distinct background motifs exist. A seed modulo this picks the card's motif. */
const MOTIF_COUNT = 42;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** A tiny deterministic random generator (LCG), so a seed always draws the same card. */
function seedRng(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/** FNV-1a string hash, used to derive stable per-user seeds from usernames. */
function hashSeed(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

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

function luminance(color: number): number {
  const r = ((color >> 16) & 0xff) / 255;
  const g = ((color >> 8) & 0xff) / 255;
  const b = (color & 0xff) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Builds a card's colour palette from its plate seed and the user's accent colour.
 *
 * Every card gets its own hue family; the accent is mixed with the user's chat colour so the same
 * person's cards feel related. The `ink` choice flips between near-black and near-white depending
 * on how light the plate came out, so text stays readable on any of the random palettes.
 */
function makePalette(seed: number, userAccent: number): Palette {
  const rng = seedRng(seed ^ 0x9e3779b9);
  const hue = Math.floor(rng() * 360);
  const scheme = seed % 7;
  const panel = hslToRgb(hue, 0.74 + rng() * 0.22, 0.5 + rng() * 0.2);
  const accentHue = hue + ([28, 58, 112, 154, 188, 226, 302][scheme] ?? 28);
  const popHue = hue + ([176, 214, 268, 318, 92, 136, 42][scheme] ?? 176);
  const accent = mixColor(userAccent, hslToRgb(accentHue, 0.94, 0.58), 0.38);
  const pop = hslToRgb(popHue, 0.84 + rng() * 0.14, 0.54 + rng() * 0.2);
  const darkTint = hslToRgb(hue + 18, 0.48 + rng() * 0.24, 0.12 + rng() * 0.12);
  const base = mixColor(darkTint, hslToRgb(hue + 40, 0.68, 0.34), 0.18 + rng() * 0.18);
  const glow = hslToRgb(accentHue + 24, 0.86 + rng() * 0.12, 0.68 + rng() * 0.14);
  const dim = hslToRgb(hue + 96 + rng() * 88, 0.56 + rng() * 0.22, 0.36 + rng() * 0.16);
  const plateLight = luminance(mixColor(panel, userAccent, 0.45));
  const ink = plateLight > 0.58 ? mixColor(base, 0x050505, 0.42) : 0xf8fff4;

  return { base, panel, ink, dim, accent, pop, glow };
}

function snapPixel(value: number, grid: number): number {
  return Math.round(value / grid) * grid;
}

function pixelSize(value: number, grid: number): number {
  return Math.max(grid, Math.ceil(value / grid) * grid);
}

/** Coerces a value out of a message's untyped `data` bag; channel events carry numbers there. */
function dataNum(msg: ChatMessage, key: string, fallback: number): number {
  const value = msg.data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** The user-visible line for a message: its text, or a description of the channel event. */
function messageText(msg: ChatMessage): string {
  if (msg.event === "chat") return msg.text.trim() || "...";
  if (msg.text.trim() !== "") return msg.text.trim();
  if (msg.event === "sub") {
    const months = dataNum(msg, "months", 0);
    return months > 0 ? `subscribed for ${months} months` : "subscribed";
  }
  if (msg.event === "gift_sub") {
    const total = dataNum(msg, "total", 1);
    return `gifted ${total} subscription${total === 1 ? "" : "s"}`;
  }
  if (msg.event === "cheer") return `cheered ${dataNum(msg, "bits", 0)} bits`;
  return `raided with ${dataNum(msg, "viewers", 0)} viewers`;
}

/** The little tag drawn in the card's top-right corner: "CHAT", "SUB", "GIFT SUB", ... */
function eventLabel(msg: ChatMessage): string {
  return msg.event === "chat" ? "CHAT" : msg.event.replace("_", " ").toUpperCase();
}

/** The message as drawable fragments, falling back to one text part for bare channel events. */
function renderParts(msg: ChatMessage): ChatPart[] {
  if (msg.parts.length > 0) return msg.parts;
  return [{ type: "text", text: messageText(msg) }];
}

/**
 * A 1×1 white texture that every particle tints and scales into a rectangle. One texture shared
 * by thousands of particles is what makes the `ParticleContainer` drawing cheap.
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

/**
 * The seeded background artwork of one card: a colour wash, a dot field, one to three of the 42
 * motifs, and scattered accent bits — all built once at construction as static particles.
 */
class PixelPattern {
  readonly view: PIXI.ParticleContainer;

  private readonly px: number;
  private readonly plate: number;

  constructor(
    cfg: CardConfig,
    texture: PIXI.Texture,
    width: number,
    height: number,
    palette: Palette,
    seed: number,
  ) {
    this.px = cfg.px;
    this.plate = cfg.plate;
    this.view = new PIXI.ParticleContainer({
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

    const rng = seedRng(seed);
    const particles: PIXI.Particle[] = [];
    const motif = seed % MOTIF_COUNT;
    const colors = this._plateColors(palette, seed);

    this._stainWash(particles, texture, width, height, palette, colors, rng);
    this._dotField(particles, texture, width, height, colors, rng);
    this._motif(motif, particles, texture, width, height, palette, rng);
    if (rng() > 0.28) {
      this._motif(
        (motif + 11 + Math.floor(rng() * 7)) % MOTIF_COUNT,
        particles,
        texture,
        width,
        height,
        palette,
        rng,
      );
    }
    if (rng() > 0.56) {
      this._motif(
        (motif + 23 + Math.floor(rng() * 11)) % MOTIF_COUNT,
        particles,
        texture,
        width,
        height,
        palette,
        rng,
      );
    }
    this._colorAccentBits(particles, texture, width, height, colors, rng);

    this.view.addParticle(...particles);
    this.view.update();
  }

  private _add(
    out: PIXI.Particle[],
    texture: PIXI.Texture,
    x: number,
    y: number,
    w: number,
    h: number,
    tint: number,
    alpha: number,
  ): void {
    out.push(
      new PIXI.Particle({
        texture,
        x: snapPixel(x, this.plate),
        y: snapPixel(y, this.plate),
        scaleX: pixelSize(w, this.plate),
        scaleY: pixelSize(h, this.plate),
        tint,
        alpha: clamp(alpha * 1.28, 0.12, 0.78),
      }),
    );
  }

  private _plateColors(palette: Palette, seed: number): number[] {
    const rng = seedRng(seed ^ 0x51edc0de);
    const hue = Math.floor(rng() * 360);
    return [
      palette.panel,
      palette.accent,
      palette.pop,
      palette.glow,
      palette.dim,
      hslToRgb(hue + 54, 0.92, 0.62),
      hslToRgb(hue + 126, 0.86, 0.54),
      hslToRgb(hue + 202, 0.88, 0.58),
      hslToRgb(hue + 284, 0.82, 0.64),
      mixColor(palette.pop, 0xffffff, 0.28),
    ];
  }

  private _pick(colors: number[], rng: () => number): number {
    return colors[Math.floor(rng() * colors.length)] ?? 0xffffff;
  }

  private _colorAccentBits(
    out: PIXI.Particle[],
    texture: PIXI.Texture,
    width: number,
    height: number,
    colors: number[],
    rng: () => number,
  ): void {
    const bits = 18 + Math.floor(rng() * 22);
    for (let i = 0; i < bits; i++) {
      const horizontal = rng() > 0.35;
      const size = this.plate * (1 + Math.floor(rng() * 3));
      this._add(
        out,
        texture,
        rng() * width,
        rng() * height,
        horizontal ? size * (1 + rng() * 3) : size,
        horizontal ? this.plate : size * (1 + rng() * 2),
        this._pick(colors, rng),
        0.24 + rng() * 0.28,
      );
    }
  }

  private _motif(
    motif: number,
    out: PIXI.Particle[],
    texture: PIXI.Texture,
    width: number,
    height: number,
    palette: Palette,
    rng: () => number,
  ): void {
    switch (motif) {
      case 0: this._diagonalBars(out, texture, width, height, palette, rng); break;
      case 1: this._rings(out, texture, width, height, palette, rng); break;
      case 2: this._pixelWaves(out, texture, width, height, palette, rng); break;
      case 3: this._blocks(out, texture, width, height, palette, rng); break;
      case 4: this._signalRunes(out, texture, width, height, palette, rng); break;
      case 5: this._edgeSpray(out, texture, width, height, palette, rng); break;
      case 6: this._bubbles(out, texture, width, height, palette, rng); break;
      case 7: this._chevrons(out, texture, width, height, palette, rng); break;
      case 8: this._circuit(out, texture, width, height, palette, rng); break;
      case 9: this._flameSweep(out, texture, width, height, palette, rng); break;
      case 10: this._slashStack(out, texture, width, height, palette, rng); break;
      case 11: this._scallops(out, texture, width, height, palette, rng); break;
      case 12: this._mountainPixels(out, texture, width, height, palette, rng); break;
      case 13: this._confettiLane(out, texture, width, height, palette, rng); break;
      case 14: this._zebraCuts(out, texture, width, height, palette, rng); break;
      case 15: this._sunbursts(out, texture, width, height, palette, rng); break;
      case 16: this._cloudBands(out, texture, width, height, palette, rng); break;
      case 17: this._leafBits(out, texture, width, height, palette, rng); break;
      case 18: this._equalizer(out, texture, width, height, palette, rng); break;
      case 19: this._checkerFade(out, texture, width, height, palette, rng); break;
      case 20: this._ribbonCut(out, texture, width, height, palette, rng); break;
      case 21: this._constellation(out, texture, width, height, palette, rng); break;
      case 22: this._stairSteps(out, texture, width, height, palette, rng); break;
      case 23: this._pixelSwirl(out, texture, width, height, palette, rng); break;
      case 24: this._xMarks(out, texture, width, height, palette, rng); break;
      case 25: this._honeycomb(out, texture, width, height, palette, rng); break;
      case 26: this._drips(out, texture, width, height, palette, rng); break;
      case 27: this._wideStripes(out, texture, width, height, palette, rng); break;
      case 28: this._barcode(out, texture, width, height, palette, rng); break;
      case 29: this._waveBlocks(out, texture, width, height, palette, rng); break;
      case 30: this._petalScatter(out, texture, width, height, palette, rng); break;
      case 31: this._glitch(out, texture, width, height, palette, rng); break;
      case 32: this._foam(out, texture, width, height, palette, rng); break;
      case 33: this._borderDots(out, texture, width, height, palette, rng); break;
      case 34: this._tileSlants(out, texture, width, height, palette, rng); break;
      case 35: this._paintScabs(out, texture, width, height, palette, rng); break;
      case 36: this._stainIslands(out, texture, width, height, palette, rng); break;
      case 37: this._inkPuddles(out, texture, width, height, palette, rng); break;
      case 38: this._offsetSwatches(out, texture, width, height, palette, rng); break;
      case 39: this._dryBrush(out, texture, width, height, palette, rng); break;
      case 40: this._splatterRail(out, texture, width, height, palette, rng); break;
      default: this._blockArrows(out, texture, width, height, palette, rng); break;
    }
  }

  private _stainWash(
    out: PIXI.Particle[],
    texture: PIXI.Texture,
    width: number,
    height: number,
    palette: Palette,
    colors: number[],
    rng: () => number,
  ): void {
    const washColors = [palette.base, ...colors];
    const mode = Math.floor(rng() * 7);

    if (mode === 0) {
      this._stackedStains(out, texture, width, height, washColors, rng);
      return;
    }
    if (mode === 1) {
      this._offsetStains(out, texture, width, height, washColors, rng);
      return;
    }
    if (mode === 2) {
      this._splitStains(out, texture, width, height, washColors, rng);
      return;
    }
    if (mode === 3) {
      this._brushStreaks(out, texture, width, height, washColors, rng);
      return;
    }
    if (mode === 4) {
      this._stainIslands(out, texture, width, height, palette, rng);
      return;
    }
    if (mode === 5) {
      this._inkPuddles(out, texture, width, height, palette, rng);
      return;
    }

    this._offsetSwatches(out, texture, width, height, palette, rng);
  }

  private _stainBlob(
    out: PIXI.Particle[],
    texture: PIXI.Texture,
    cx: number,
    cy: number,
    w: number,
    h: number,
    tint: number,
    alpha: number,
    rng: () => number,
  ): void {
    const step = this.plate;
    const left = cx - w / 2;
    const top = cy - h / 2;
    const wobble = 0.1 + rng() * 0.22;
    for (let y = top; y <= top + h; y += step) {
      const ny = (y - cy) / (h / 2);
      const rowNoise = Math.sin(y * 0.17 + cx * 0.03) * wobble + (rng() - 0.5) * wobble;
      for (let x = left; x <= left + w; x += step) {
        const nx = (x - cx) / (w / 2);
        const edge = nx * nx + ny * ny * (1.35 + rowNoise);
        if (edge < 1.0 + rowNoise && rng() > 0.08 + Math.max(0, edge - 0.62) * 0.42) {
          const cellW = step * (1 + Math.floor(rng() * 3));
          this._add(out, texture, x, y, cellW, step, tint, alpha * (0.78 + rng() * 0.28));
        }
      }
    }

    const specks = 4 + Math.floor(rng() * 8);
    for (let i = 0; i < specks; i++) {
      const angle = rng() * Math.PI * 2;
      const dist = 0.42 + rng() * 0.66;
      const x = cx + Math.cos(angle) * w * 0.5 * dist;
      const y = cy + Math.sin(angle) * h * 0.5 * dist;
      const size = rng() > 0.65 ? step * 2 : step;
      this._add(out, texture, x, y, size, size, tint, alpha * (0.52 + rng() * 0.28));
    }
  }

  private _stackedStains(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, colors: number[], rng: () => number): void {
    const bands = 3 + Math.floor(rng() * 3);
    for (let i = 0; i < bands; i++) {
      const bandH = height / (bands + 0.45);
      const cy = bandH * (i + 0.52) + (rng() - 0.5) * 10;
      const w = width * (0.62 + rng() * 0.34);
      const cx = width * (0.44 + rng() * 0.12);
      this._stainBlob(out, texture, cx, cy, w, bandH * (0.95 + rng() * 0.45), colors[i % colors.length] ?? 0xffffff, 0.22 + rng() * 0.2, rng);
    }
  }

  private _offsetStains(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, colors: number[], rng: () => number): void {
    const stains = 4 + Math.floor(rng() * 4);
    for (let i = 0; i < stains; i++) {
      const cy = height * (0.16 + (i / Math.max(1, stains - 1)) * 0.68) + (rng() - 0.5) * 12;
      const cx = width * (0.25 + rng() * 0.5);
      const w = width * (0.32 + rng() * 0.48);
      const h = 18 + rng() * Math.max(16, height * 0.24);
      this._stainBlob(out, texture, cx, cy, w, h, colors[(i + 1) % colors.length] ?? 0xffffff, 0.2 + rng() * 0.22, rng);
    }
  }

  private _splitStains(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, colors: number[], rng: () => number): void {
    for (let side = 0; side < 2; side++) {
      const cx = width * (side === 0 ? 0.28 : 0.72) + (rng() - 0.5) * 30;
      const cy = height * (0.38 + rng() * 0.24);
      this._stainBlob(out, texture, cx, cy, width * (0.34 + rng() * 0.22), height * (0.68 + rng() * 0.25), colors[(side * 2 + 1) % colors.length] ?? 0xffffff, 0.22 + rng() * 0.18, rng);
    }
    this._stainBlob(out, texture, width * 0.5, height * (0.48 + (rng() - 0.5) * 0.22), width * 0.48, height * 0.36, colors[3 % colors.length] ?? 0xffffff, 0.12 + rng() * 0.16, rng);
  }

  private _brushStreaks(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, colors: number[], rng: () => number): void {
    const lanes = 4 + Math.floor(rng() * 4);
    for (let i = 0; i < lanes; i++) {
      const y = height * (0.14 + rng() * 0.72);
      const x = -20 + rng() * width * 0.3;
      const w = width * (0.48 + rng() * 0.58);
      const h = 10 + rng() * 18;
      this._stainBlob(out, texture, x + w * 0.5, y, w, h, colors[i % colors.length] ?? 0xffffff, 0.22 + rng() * 0.2, rng);
    }
  }

  private _dotField(
    out: PIXI.Particle[],
    texture: PIXI.Texture,
    width: number,
    height: number,
    colors: number[],
    rng: () => number,
  ): void {
    const count = Math.floor(width / 18);
    for (let i = 0; i < count; i++) {
      const size = rng() > 0.7 ? this.px * 2 : this.px;
      this._add(
        out,
        texture,
        rng() * width,
        10 + rng() * (height - 20),
        size,
        size,
        this._pick(colors, rng),
        0.18 + rng() * 0.32,
      );
    }
  }

  private _diagonalBars(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    for (let x = -width * 0.15; x < width; x += 26 + rng() * 12) {
      for (let step = 0; step < 7; step++) {
        this._add(out, texture, x + step * 7, height - 12 - step * 5, 24, this.px, palette.accent, 0.24);
      }
    }
  }

  private _rings(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    const cx = width * (0.2 + rng() * 0.6);
    const cy = height * (0.35 + rng() * 0.35);
    for (let r = 12; r < height * 1.5; r += 13) {
      for (let a = 0; a < Math.PI * 2; a += 0.35) {
        if (rng() < 0.42) {
          this._add(out, texture, cx + Math.cos(a) * r, cy + Math.sin(a) * r, this.px, this.px, palette.pop, 0.24);
        }
      }
    }
  }

  private _pixelWaves(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    for (let lane = 0; lane < 4; lane++) {
      const y = 12 + lane * ((height - 24) / 4);
      const tint = lane % 2 === 0 ? palette.glow : palette.accent;
      for (let x = 0; x < width; x += this.px * 2) {
        const wave = Math.sin(x * 0.035 + lane + rng() * 0.1);
        if (wave > 0.15) this._add(out, texture, x, y + wave * 11, this.px, this.px, tint, 0.22);
      }
    }
  }

  private _blocks(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    const blockW = 30 + rng() * 48;
    for (let x = 0; x < width; x += blockW) {
      const tint = rng() > 0.5 ? palette.accent : palette.pop;
      this._add(out, texture, x, height - 18 - rng() * 12, blockW * (0.55 + rng() * 0.4), 14, tint, 0.18);
    }
  }

  private _signalRunes(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    for (let x = 12; x < width - 12; x += 24 + rng() * 20) {
      const y = 12 + rng() * (height - 24);
      this._add(out, texture, x, y, this.px * 3, this.px, palette.glow, 0.32);
      this._add(out, texture, x + this.px, y - this.px, this.px, this.px * 3, palette.glow, 0.24);
      if (rng() > 0.45) this._add(out, texture, x + this.px * 4, y + this.px, this.px, this.px, palette.pop, 0.32);
    }
  }

  private _edgeSpray(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    for (let i = 0; i < 42; i++) {
      const side = rng() > 0.5;
      const x = side ? rng() * width * 0.26 : width - rng() * width * 0.26;
      this._add(out, texture, x, rng() * height, this.px, this.px, rng() > 0.5 ? palette.accent : palette.glow, 0.35);
    }
  }

  private _bubbles(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    for (let i = 0; i < 18; i++) {
      const cx = rng() * width;
      const cy = rng() * height;
      const r = 6 + rng() * 18;
      for (let a = 0; a < Math.PI * 2; a += 0.55) {
        this._add(out, texture, cx + Math.cos(a) * r, cy + Math.sin(a) * r, this.px, this.px, rng() > 0.5 ? palette.glow : palette.accent, 0.22);
      }
    }
  }

  private _chevrons(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    for (let x = -20; x < width; x += 44) {
      const y = 8 + rng() * (height - 20);
      const tint = rng() > 0.5 ? palette.accent : palette.pop;
      for (let i = 0; i < 6; i++) {
        this._add(out, texture, x + i * this.px * 2, y + i * this.px, this.px * 3, this.px, tint, 0.38);
        this._add(out, texture, x + i * this.px * 2, y + (10 - i) * this.px, this.px * 3, this.px, tint, 0.38);
      }
    }
  }

  private _circuit(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    for (let y = 12; y < height; y += 16 + rng() * 10) {
      let x = rng() * 24;
      while (x < width - 20) {
        const len = 18 + rng() * 52;
        this._add(out, texture, x, y, len, this.px, palette.accent, 0.32);
        if (rng() > 0.45) this._add(out, texture, x + len, y - 8, this.px, 16, palette.glow, 0.28);
        if (rng() > 0.55) this._add(out, texture, x + len + 6, y - 2, this.px * 2, this.px * 2, palette.pop, 0.38);
        x += len + 18 + rng() * 22;
      }
    }
  }

  private _flameSweep(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    for (let x = 0; x < width; x += this.px * 2) {
      const flame = Math.sin(x * 0.035 + rng() * 0.3) * 0.5 + 0.5;
      const h = 14 + flame * (height - 18);
      const tint = rng() > 0.5 ? palette.pop : palette.accent;
      for (let y = height - h; y < height; y += this.px * 2) {
        if (rng() > 0.22) this._add(out, texture, x, y, this.px * 2, this.px * 2, tint, 0.21 + flame * 0.22);
      }
    }
  }

  private _slashStack(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    for (let x = -height; x < width; x += 18 + rng() * 18) {
      const tint = rng() > 0.5 ? palette.glow : palette.pop;
      for (let y = 0; y < height; y += this.px) {
        this._add(out, texture, x + y * 0.9, y, 10 + rng() * 18, this.px, tint, 0.2);
      }
    }
  }

  private _scallops(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    for (let cx = 0; cx < width + 30; cx += 28) {
      const cy = rng() > 0.5 ? 0 : height;
      for (let a = 0; a < Math.PI; a += 0.22) {
        const yDir = cy === 0 ? 1 : -1;
        this._add(out, texture, cx + Math.cos(a) * 18, cy + Math.sin(a) * 18 * yDir, this.px * 2, this.px, palette.glow, 0.25);
      }
    }
  }

  private _mountainPixels(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    for (let x = 0; x < width; x += this.px * 2) {
      const ridge = height * (0.34 + 0.28 * Math.sin(x * 0.024 + rng()));
      for (let y = ridge; y < height; y += this.px * 2) {
        if (rng() > 0.36) this._add(out, texture, x, y, this.px * 2, this.px * 2, rng() > 0.5 ? palette.dim : palette.accent, 0.24);
      }
    }
  }

  private _confettiLane(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    const colors = [palette.panel, palette.accent, palette.pop, palette.glow, palette.ink];
    for (let i = 0; i < 75; i++) {
      this._add(out, texture, rng() * width, rng() * height, this.px * (1 + Math.floor(rng() * 4)), this.px, this._pick(colors, rng), 0.26 + rng() * 0.28);
    }
  }

  private _zebraCuts(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    for (let y = -height; y < height * 2; y += 12 + rng() * 10) {
      const tint = rng() > 0.5 ? 0xffffff : palette.dim;
      for (let x = 0; x < width; x += this.px * 2) {
        this._add(out, texture, x, y + Math.sin(x * 0.04) * 10 + x * 0.14, this.px * 2, this.px * 2, tint, 0.18);
      }
    }
  }

  private _sunbursts(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    const cx = rng() * width;
    const cy = rng() * height;
    for (let a = 0; a < Math.PI * 2; a += 0.18) {
      const len = 18 + rng() * Math.max(width, height) * 0.38;
      for (let r = 8; r < len; r += this.px * 3) {
        this._add(out, texture, cx + Math.cos(a) * r, cy + Math.sin(a) * r, this.px * 2, this.px, rng() > 0.5 ? palette.glow : palette.accent, 0.18);
      }
    }
  }

  private _cloudBands(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    for (let x = -30; x < width; x += 22) {
      const cy = height * (0.28 + rng() * 0.44);
      const h = 16 + rng() * 28;
      this._add(out, texture, x, cy, 32 + rng() * 50, h, rng() > 0.5 ? palette.glow : palette.panel, 0.18);
      this._add(out, texture, x + 10, cy - h * 0.35, 22 + rng() * 35, h * 0.55, palette.accent, 0.16);
    }
  }

  private _leafBits(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    for (let i = 0; i < 34; i++) {
      const x = rng() * width;
      const y = rng() * height;
      const tint = rng() > 0.5 ? palette.accent : palette.glow;
      this._add(out, texture, x, y, this.px * 4, this.px, tint, 0.3);
      this._add(out, texture, x + this.px, y - this.px, this.px * 2, this.px * 3, tint, 0.22);
    }
  }

  private _equalizer(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    for (let x = 0; x < width; x += 10) {
      const h = 6 + rng() * (height - 12);
      this._add(out, texture, x, height - h, 5, h, rng() > 0.5 ? palette.pop : palette.glow, 0.32);
    }
  }

  private _checkerFade(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    const cell = 12 + Math.floor(rng() * 3) * 4;
    for (let y = 0; y < height; y += cell) {
      for (let x = 0; x < width; x += cell) {
        if (((x / cell + y / cell) | 0) % 2 === 0) this._add(out, texture, x, y, cell, cell, rng() > 0.5 ? palette.accent : palette.dim, 0.16 + (x / width) * 0.2);
      }
    }
  }

  private _ribbonCut(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    for (let i = 0; i < 5; i++) {
      const y = rng() * height;
      const h = 8 + rng() * 14;
      this._add(out, texture, 0, y, width, h, i % 2 ? palette.pop : palette.accent, 0.17);
      this._add(out, texture, width * (0.2 + rng() * 0.5), y - this.px, 18 + rng() * 30, h + this.px * 2, palette.glow, 0.26);
    }
  }

  private _constellation(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    let px = rng() * width;
    let py = rng() * height;
    for (let i = 0; i < 24; i++) {
      const x = rng() * width;
      const y = rng() * height;
      this._add(out, texture, x, y, this.px * 2, this.px * 2, palette.glow, 0.48);
      this._add(out, texture, Math.min(px, x), Math.min(py, y), Math.abs(x - px) + this.px, this.px, palette.accent, 0.12);
      px = x;
      py = y;
    }
  }

  private _stairSteps(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    for (let x = 0; x < width; x += 24) {
      const steps = 3 + Math.floor(rng() * 5);
      for (let s = 0; s < steps; s++) {
        this._add(out, texture, x + s * this.px * 2, height - (s + 2) * this.px * 2, 22, this.px * 2, rng() > 0.5 ? palette.pop : palette.panel, 0.22);
      }
    }
  }

  private _pixelSwirl(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    const cx = width * (0.35 + rng() * 0.3);
    const cy = height * (0.25 + rng() * 0.5);
    for (let t = 0; t < 42; t++) {
      const a = t * 0.42;
      const r = 2 + t * 1.8;
      this._add(out, texture, cx + Math.cos(a) * r, cy + Math.sin(a) * r, this.px * 3, this.px, t % 2 ? palette.accent : palette.glow, 0.34);
    }
  }

  private _xMarks(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    for (let i = 0; i < 18; i++) {
      const x = rng() * width;
      const y = rng() * height;
      const tint = rng() > 0.5 ? palette.pop : palette.accent;
      for (let s = 0; s < 5; s++) {
        this._add(out, texture, x + s * this.px, y + s * this.px, this.px, this.px, tint, 0.32);
        this._add(out, texture, x + (4 - s) * this.px, y + s * this.px, this.px, this.px, tint, 0.32);
      }
    }
  }

  private _honeycomb(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    for (let y = 0; y < height; y += 18) {
      for (let x = (Math.floor(y / 18) % 2) * 12; x < width; x += 26) {
        const tint = rng() > 0.5 ? palette.glow : palette.dim;
        this._add(out, texture, x, y, 12, this.px, tint, 0.2);
        this._add(out, texture, x - this.px, y + this.px, this.px, 10, tint, 0.2);
        this._add(out, texture, x + 12, y + this.px, this.px, 10, tint, 0.2);
      }
    }
  }

  private _drips(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    for (let x = 0; x < width; x += 12 + rng() * 24) {
      const h = 10 + rng() * (height * 0.7);
      this._add(out, texture, x, 0, 6 + rng() * 10, h, rng() > 0.5 ? palette.pop : palette.accent, 0.25);
      this._add(out, texture, x - this.px, h, this.px * 3, this.px * 3, palette.glow, 0.24);
    }
  }

  private _wideStripes(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    const colors = [palette.panel, palette.accent, palette.pop, palette.glow];
    for (let x = 0; x < width; x += 28 + rng() * 26) {
      this._add(out, texture, x, 0, 18 + rng() * 35, height, this._pick(colors, rng), 0.2);
    }
  }

  private _barcode(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    for (let x = 0; x < width; x += 5 + rng() * 9) {
      const w = 2 + rng() * 7;
      this._add(out, texture, x, 6 + rng() * 10, w, height - 12 - rng() * 20, rng() > 0.5 ? palette.ink : palette.glow, 0.25);
    }
  }

  private _waveBlocks(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    for (let x = 0; x < width; x += 10) {
      const y = height * 0.5 + Math.sin(x * 0.035) * height * 0.28;
      this._add(out, texture, x, y, 18, height - y, rng() > 0.5 ? palette.accent : palette.panel, 0.22);
    }
  }

  private _petalScatter(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    for (let i = 0; i < 36; i++) {
      const x = rng() * width;
      const y = rng() * height;
      const tint = rng() > 0.5 ? palette.pop : palette.glow;
      this._add(out, texture, x, y, this.px * 3, this.px, tint, 0.3);
      this._add(out, texture, x + this.px, y + this.px, this.px, this.px * 2, tint, 0.22);
    }
  }

  private _glitch(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    for (let i = 0; i < 26; i++) {
      this._add(out, texture, rng() * width, rng() * height, 18 + rng() * 88, this.px * (1 + Math.floor(rng() * 3)), rng() > 0.5 ? palette.accent : palette.pop, 0.28);
    }
  }

  private _foam(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    for (let i = 0; i < 45; i++) {
      const s = this.px * (1 + Math.floor(rng() * 3));
      this._add(out, texture, rng() * width, rng() * height, s, s, rng() > 0.5 ? palette.glow : 0xffffff, 0.2 + rng() * 0.28);
    }
  }

  private _paintScabs(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    const colors = [palette.accent, palette.pop, palette.glow, palette.panel];
    for (let i = 0; i < 9; i++) {
      this._stainBlob(
        out,
        texture,
        width * (0.12 + rng() * 0.76),
        height * (0.14 + rng() * 0.72),
        38 + rng() * 98,
        14 + rng() * 32,
        this._pick(colors, rng),
        0.2 + rng() * 0.24,
        rng,
      );
    }
  }

  private _stainIslands(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    const colors = [palette.panel, palette.accent, palette.dim, palette.pop, palette.glow];
    const islands = 5 + Math.floor(rng() * 5);
    for (let i = 0; i < islands; i++) {
      const w = width * (0.18 + rng() * 0.34);
      const h = height * (0.2 + rng() * 0.26);
      this._stainBlob(
        out,
        texture,
        rng() * width,
        height * (0.16 + rng() * 0.68),
        w,
        h,
        colors[i % colors.length] ?? 0xffffff,
        0.2 + rng() * 0.24,
        rng,
      );
    }
  }

  private _inkPuddles(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    const colors = [palette.ink, palette.dim, palette.accent, palette.panel];
    for (let i = 0; i < 4; i++) {
      this._stainBlob(
        out,
        texture,
        width * (0.18 + rng() * 0.64),
        height * (0.24 + rng() * 0.52),
        width * (0.28 + rng() * 0.36),
        height * (0.18 + rng() * 0.22),
        colors[i % colors.length] ?? 0xffffff,
        0.16 + rng() * 0.22,
        rng,
      );
    }
    this._dotField(out, texture, width, height, [palette.ink, palette.glow, palette.pop], rng);
  }

  private _offsetSwatches(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    const colors = [palette.accent, palette.panel, palette.pop, palette.glow, palette.dim];
    const rows = 3 + Math.floor(rng() * 3);
    for (let row = 0; row < rows; row++) {
      const y = height * ((row + 0.55) / rows) + (rng() - 0.5) * 10;
      const swatches = 2 + Math.floor(rng() * 3);
      for (let i = 0; i < swatches; i++) {
        const w = width * (0.18 + rng() * 0.24);
        const x = width * ((i + 0.5) / swatches) + (rng() - 0.5) * 42;
        this._stainBlob(out, texture, x, y, w, 18 + rng() * 22, colors[(row + i) % colors.length] ?? 0xffffff, 0.18 + rng() * 0.2, rng);
      }
    }
  }

  private _dryBrush(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    const colors = [palette.glow, palette.accent, palette.pop, palette.panel];
    for (let line = 0; line < 9; line++) {
      const y = height * (0.12 + rng() * 0.74);
      let x = -rng() * 30;
      while (x < width) {
        if (rng() > 0.28) {
          this._add(out, texture, x, y + (rng() - 0.5) * 10, 18 + rng() * 46, this.plate, colors[line % colors.length] ?? 0xffffff, 0.16 + rng() * 0.22);
        }
        x += 18 + rng() * 30;
      }
    }
  }

  private _splatterRail(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    const colors = [palette.accent, palette.pop, palette.glow, palette.ink];
    const rails = 2 + Math.floor(rng() * 3);
    for (let rail = 0; rail < rails; rail++) {
      const y = height * ((rail + 0.65) / (rails + 0.3));
      this._stainBlob(out, texture, width * 0.5, y, width * (0.64 + rng() * 0.22), 12 + rng() * 18, colors[rail % colors.length] ?? 0xffffff, 0.22 + rng() * 0.18, rng);
      for (let i = 0; i < 18; i++) {
        const size = rng() > 0.62 ? this.plate * 2 : this.plate;
        this._add(out, texture, rng() * width, y + (rng() - 0.5) * 42, size, size, this._pick(colors, rng), 0.22 + rng() * 0.28);
      }
    }
  }

  private _borderDots(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    for (let x = 4; x < width; x += 14) {
      this._add(out, texture, x, 4, this.px, this.px, palette.glow, 0.42);
      this._add(out, texture, x, height - 8, this.px, this.px, palette.pop, 0.34);
    }
    for (let y = 8; y < height; y += 14) {
      this._add(out, texture, 4, y, this.px, this.px, palette.accent, 0.34);
      this._add(out, texture, width - 8, y, this.px, this.px, palette.glow, 0.34);
    }
    if (rng() > 0.5) this._edgeSpray(out, texture, width, height, palette, rng);
  }

  private _tileSlants(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    for (let y = 0; y < height; y += 18) {
      for (let x = -20; x < width; x += 34) {
        this._add(out, texture, x + y * 0.6, y, 24, 8, rng() > 0.5 ? palette.panel : palette.accent, 0.22);
      }
    }
  }

  private _blockArrows(out: PIXI.Particle[], texture: PIXI.Texture, width: number, height: number, palette: Palette, rng: () => number): void {
    for (let x = 0; x < width; x += 48) {
      const y = height * (0.25 + rng() * 0.4);
      const tint = rng() > 0.5 ? palette.pop : palette.glow;
      this._add(out, texture, x, y, 28, 14, tint, 0.28);
      this._add(out, texture, x + 28, y - 8, 12, 30, tint, 0.28);
      this._add(out, texture, x + 40, y, 10, 14, palette.accent, 0.32);
    }
  }
}

/** All the choices that make one user's mascot theirs, decoded from the mascot seed. */
interface MascotProfile {
  shape: number;
  eyes: number;
  mouth: number;
  accessory: number;
  limbs: number;
  spots: number;
  bodyColor: number;
  shade: number;
  dark: number;
  highlight: number;
  spotColor: number;
}

/**
 * The little pixel creature that peeks over a card's left edge. Its seed is derived from the
 * username alone, so a returning chatter always brings the same mascot — that recognition is the
 * whole point of it.
 */
class PixelMascot {
  readonly view = new PIXI.Container();

  private readonly px: number;

  constructor(cfg: CardConfig, texture: PIXI.Texture, palette: Palette, userColor: number, seed: number) {
    this.px = cfg.px;
    const rng = seedRng(seed ^ 0x5ca1ab1e);
    const body = new PIXI.ParticleContainer({
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
    const profile = this._profile(seed, palette, userColor);

    this._monsterBody(particles, texture, rng, profile);
    this._monsterExtras(particles, texture, rng, profile, true);
    this._monsterFace(particles, texture, rng, profile);
    this._monsterExtras(particles, texture, rng, profile, false);

    body.addParticle(...particles);
    body.update();

    const shadow = new PIXI.Graphics()
      .rect(7, 43, 36, 8)
      .fill(rgba(0x000000, 0.28))
      .rect(12, 47, 22, 4)
      .fill(rgba(0x000000, 0.22));

    this.view.addChild(shadow);
    this.view.addChild(body);
    this.view.scale.set(0.96);
  }

  private _profile(seed: number, palette: Palette, userColor: number): MascotProfile {
    const hue = seed % 360;
    const colors = [
      userColor,
      palette.accent,
      palette.pop,
      palette.glow,
      palette.dim,
      hslToRgb(hue + 43, 0.84, 0.56),
      hslToRgb(hue + 137, 0.78, 0.5),
      hslToRgb(hue + 221, 0.82, 0.62),
    ];
    const bodyColor = colors[Math.floor(seed / 7) % colors.length] ?? userColor;
    const shade = mixColor(bodyColor, palette.base, 0.38);
    return {
      shape: seed % 14,
      eyes: Math.floor(seed / 13) % 10,
      mouth: Math.floor(seed / 37) % 8,
      accessory: Math.floor(seed / 73) % 14,
      limbs: Math.floor(seed / 131) % 8,
      spots: Math.floor(seed / 251) % 7,
      bodyColor,
      shade,
      dark: mixColor(shade, 0x05020a, 0.42),
      highlight: mixColor(bodyColor, 0xffffff, 0.42),
      spotColor: colors[Math.floor(seed / 409) % colors.length] ?? userColor,
    };
  }

  private _add(
    out: PIXI.Particle[],
    texture: PIXI.Texture,
    x: number,
    y: number,
    w: number,
    h: number,
    tint: number,
    alpha = 1,
  ): void {
    out.push(
      new PIXI.Particle({
        texture,
        x: Math.round(x),
        y: Math.round(y),
        scaleX: Math.max(this.px, Math.round(w)),
        scaleY: Math.max(this.px, Math.round(h)),
        tint,
        alpha,
      }),
    );
  }

  private _monsterBody(
    out: PIXI.Particle[],
    texture: PIXI.Texture,
    rng: () => number,
    profile: MascotProfile,
  ): void {
    const px = this.px;
    const cells: boolean[][] = [];
    const cx = 6;
    const cy = profile.shape === 6 ? 7.0 : profile.shape === 4 ? 6.0 : 6.5;
    const rx = [5.0, 3.8, 5.8, 4.6, 4.8, 4.2, 3.5, 5.2, 4.4, 5.6, 3.9, 4.7, 5.1, 4.1][profile.shape] ?? 4.6;
    const ry = [4.4, 5.4, 3.6, 4.7, 4.5, 5.0, 5.3, 3.9, 4.9, 3.4, 4.2, 5.6, 4.1, 4.7][profile.shape] ?? 4.5;

    for (let y = 0; y < 13; y++) {
      const row: boolean[] = [];
      cells[y] = row;
      for (let x = 0; x < 13; x++) {
        const nx = (x - cx) / rx;
        const ny = (y - cy) / ry;
        const fuzz = Math.sin(x * 1.3 + y * 0.7) * 0.08 + (rng() - 0.5) * 0.12;
        let inside = nx * nx + ny * ny < 1 + fuzz;

        if (profile.shape === 3) {
          const lowerBoost = y > cy ? 1.24 : 0.72;
          inside = nx * nx + (ny / lowerBoost) * (ny / lowerBoost) < 1 + fuzz;
        } else if (profile.shape === 4) {
          const bodyWidth = 1.0 - Math.abs(y - 7) / 7;
          inside = Math.abs(nx) < bodyWidth * 0.92 && y > 1 && y < 12;
        } else if (profile.shape === 6) {
          const cap = ((x - cx) / 5.2) ** 2 + ((y - 4) / 2.8) ** 2 < 1.05;
          const stem = Math.abs(x - cx) < 2.6 && y >= 5 && y < 12;
          inside = cap || stem;
        } else if (profile.shape === 9) {
          inside = Math.abs(ny) < 0.95 && Math.abs(nx) < 0.9 + Math.sin(y * 0.8) * 0.08;
        } else if (profile.shape === 10) {
          inside = nx * nx + ny * ny < 0.86 + fuzz || (x === 6 && y < 3);
        }

        row[x] = inside;
      }
    }

    for (let y = 0; y < 13; y++) {
      for (let x = 0; x < 13; x++) {
        if (!cells[y]?.[x]) continue;
        const edge =
          !cells[y - 1]?.[x] || !cells[y + 1]?.[x] || !cells[y]?.[x - 1] || !cells[y]?.[x + 1];
        const baseTint = y > cy + 1.3 ? profile.shade : profile.bodyColor;
        const tint = edge ? profile.dark : baseTint;
        this._add(out, texture, x * px, y * px, px, px, tint, 0.98);
      }
    }

    if (profile.spots > 0) {
      const count = 2 + profile.spots;
      for (let i = 0; i < count; i++) {
        const x = 2 + Math.floor(rng() * 9);
        const y = 3 + Math.floor(rng() * 7);
        if (cells[y]?.[x]) {
          const tint = i % 2 === 0 ? profile.highlight : mixColor(profile.spotColor, profile.dark, 0.2);
          this._add(out, texture, x * px, y * px, px, px, tint, 0.62);
        }
      }
    }
  }

  private _monsterFace(
    out: PIXI.Particle[],
    texture: PIXI.Texture,
    rng: () => number,
    profile: MascotProfile,
  ): void {
    const px = this.px;
    const eyeColor = profile.eyes % 3 === 0 ? 0xfaff77 : profile.eyes % 3 === 1 ? 0xafffff : 0xffffff;
    const pupil = 0x120715;
    const mouth = 0x13070c;
    const tooth = 0xfff0b5;

    if (profile.eyes === 0) {
      this._eye(out, texture, 3, 3, eyeColor, pupil);
      this._eye(out, texture, 7, 3, eyeColor, pupil);
    } else if (profile.eyes === 1) {
      this._eye(out, texture, 5, 3, eyeColor, pupil, 3);
      this._add(out, texture, 8 * px, 2 * px, px, px, profile.highlight, 0.78);
    } else if (profile.eyes === 2) {
      this._eye(out, texture, 2, 2, eyeColor, pupil);
      this._eye(out, texture, 8, 4, eyeColor, pupil);
    } else if (profile.eyes === 3) {
      this._add(out, texture, 3 * px, 4 * px, 3 * px, px, pupil, 0.92);
      this._add(out, texture, 7 * px, 4 * px, 3 * px, px, pupil, 0.92);
    } else if (profile.eyes === 4) {
      this._eye(out, texture, 2, 3, eyeColor, pupil);
      this._eye(out, texture, 5, 2, eyeColor, pupil);
      this._eye(out, texture, 8, 3, eyeColor, pupil);
    } else if (profile.eyes === 5) {
      this._eye(out, texture, 5, 2, eyeColor, pupil);
      this._add(out, texture, 3 * px, 4 * px, 2 * px, px, pupil, 0.9);
      this._add(out, texture, 8 * px, 4 * px, 2 * px, px, pupil, 0.9);
    } else if (profile.eyes === 6) {
      this._eye(out, texture, 4, 3, eyeColor, pupil);
      this._eye(out, texture, 8, 3, eyeColor, pupil);
      this._add(out, texture, 2 * px, 2 * px, 3 * px, px, profile.dark, 0.72);
      this._add(out, texture, 8 * px, 2 * px, 3 * px, px, profile.dark, 0.72);
    } else if (profile.eyes === 7) {
      this._eye(out, texture, 5, 2, eyeColor, pupil, 2);
      this._eye(out, texture, 5, 5, eyeColor, pupil, 2);
    } else {
      this._eye(out, texture, 3, 3, eyeColor, pupil);
      this._eye(out, texture, 8, 3, eyeColor, pupil);
      if (profile.eyes === 9) this._eye(out, texture, 6, 1, eyeColor, pupil);
    }

    const mouthY = profile.shape === 4 ? 8 : 7;
    if (profile.mouth === 0) {
      this._add(out, texture, 3 * px, mouthY * px, 6 * px, 2 * px, mouth, 0.96);
      this._add(out, texture, 4 * px, mouthY * px, px, px, tooth, 0.98);
      this._add(out, texture, 7 * px, mouthY * px, px, px, tooth, 0.98);
    } else if (profile.mouth === 1) {
      this._add(out, texture, 4 * px, mouthY * px, 4 * px, 3 * px, mouth, 0.96);
      this._add(out, texture, 5 * px, (mouthY + 2) * px, px, px, 0xff6b7d, 0.95);
    } else if (profile.mouth === 2) {
      this._add(out, texture, 4 * px, mouthY * px, 5 * px, px, mouth, 0.96);
    } else if (profile.mouth === 3) {
      this._add(out, texture, 3 * px, mouthY * px, 7 * px, px, mouth, 0.96);
      this._add(out, texture, 4 * px, (mouthY + 1) * px, px, px, tooth, 0.98);
      this._add(out, texture, 8 * px, (mouthY + 1) * px, px, px, tooth, 0.98);
    } else if (profile.mouth === 4) {
      this._add(out, texture, 5 * px, mouthY * px, 3 * px, px, mouth, 0.96);
      this._add(out, texture, 4 * px, (mouthY + 1) * px, px, px, mouth, 0.96);
      this._add(out, texture, 8 * px, (mouthY + 1) * px, px, px, mouth, 0.96);
    } else if (profile.mouth === 5) {
      this._add(out, texture, 4 * px, mouthY * px, 5 * px, 3 * px, mouth, 0.96);
      this._add(out, texture, 5 * px, mouthY * px, px, px, tooth, 0.98);
      this._add(out, texture, 7 * px, mouthY * px, px, px, tooth, 0.98);
    } else {
      this._add(out, texture, 4 * px, mouthY * px, 5 * px, 2 * px, mouth, 0.92);
      this._add(out, texture, 6 * px, mouthY * px, px, px, tooth, 0.98);
    }
    if (profile.mouth === 1 || profile.mouth === 5 || rng() > 0.82) {
      this._add(out, texture, 5 * px, (mouthY + 2) * px, 2 * px, px, 0xff6b7d, 0.95);
    }
  }

  private _eye(
    out: PIXI.Particle[],
    texture: PIXI.Texture,
    x: number,
    y: number,
    eyeColor: number,
    pupil: number,
    size = 2,
  ): void {
    const px = this.px;
    this._add(out, texture, x * px, y * px, size * px, size * px, eyeColor, 0.98);
    this._add(out, texture, (x + size - 1) * px, (y + size - 1) * px, px, px, pupil, 1);
  }

  private _monsterExtras(
    out: PIXI.Particle[],
    texture: PIXI.Texture,
    rng: () => number,
    profile: MascotProfile,
    behindBody: boolean,
  ): void {
    const px = this.px;
    if (behindBody) {
      if (profile.accessory === 4 || profile.accessory === 11) {
        this._add(out, texture, -2 * px, 5 * px, 4 * px, 3 * px, profile.shade, 0.84);
        this._add(out, texture, 11 * px, 5 * px, 4 * px, 3 * px, profile.shade, 0.84);
        this._add(out, texture, -px, 4 * px, 2 * px, px, profile.highlight, 0.5);
        this._add(out, texture, 12 * px, 4 * px, 2 * px, px, profile.highlight, 0.5);
      }
      if (profile.accessory === 5 || profile.accessory === 12) {
        this._add(out, texture, 11 * px, 8 * px, 4 * px, px, profile.dark, 0.9);
        this._add(out, texture, 14 * px, 7 * px, px, 2 * px, profile.shade, 0.9);
      }
      return;
    }

    if (profile.accessory === 0 || profile.accessory === 7) {
      this._add(out, texture, 2 * px, 0, px, 3 * px, profile.dark, 0.95);
      this._add(out, texture, 9 * px, 0, px, 3 * px, profile.dark, 0.95);
      this._add(out, texture, 2 * px, 0, 2 * px, px, profile.highlight, 0.8);
      this._add(out, texture, 8 * px, 0, 2 * px, px, profile.highlight, 0.8);
    } else if (profile.accessory === 1 || profile.accessory === 8) {
      for (let i = 0; i < 3; i++) {
        this._add(out, texture, (4 + i) * px, (1 - i) * px, px, 4 * px, profile.highlight, 0.86);
      }
    } else if (profile.accessory === 2) {
      for (let i = 0; i < 5; i++) {
        this._add(out, texture, (3 + i) * px, (i % 2) * px, px, 2 * px, profile.dark, 0.9);
      }
    } else if (profile.accessory === 3 || profile.accessory === 10) {
      this._add(out, texture, 0, 4 * px, 2 * px, 3 * px, profile.shade, 0.9);
      this._add(out, texture, 11 * px, 4 * px, 2 * px, 3 * px, profile.shade, 0.9);
    } else if (profile.accessory === 6) {
      this._add(out, texture, 4 * px, 0, 4 * px, px, profile.highlight, 0.8);
      this._add(out, texture, 5 * px, -px, 2 * px, px, profile.spotColor, 0.88);
    } else if (profile.accessory === 9) {
      this._add(out, texture, 4 * px, -px, 4 * px, 2 * px, 0xffb53d, 0.92);
      this._add(out, texture, 5 * px, -2 * px, 2 * px, px, 0xffef67, 0.92);
    } else if (profile.accessory === 13) {
      this._add(out, texture, 3 * px, 0, 6 * px, px, profile.dark, 0.82);
      this._add(out, texture, 5 * px, -px, 2 * px, px, profile.dark, 0.82);
    }

    if (profile.limbs === 1 || profile.limbs === 4) {
      this._add(out, texture, 0, 7 * px, 3 * px, px, profile.bodyColor, 0.95);
      this._add(out, texture, 10 * px, 7 * px, 3 * px, px, profile.bodyColor, 0.95);
      this._add(out, texture, 0, 8 * px, px, 2 * px, profile.shade, 0.95);
      this._add(out, texture, 12 * px, 8 * px, px, 2 * px, profile.shade, 0.95);
    } else if (profile.limbs === 2 || profile.limbs === 6) {
      this._add(out, texture, px, 8 * px, 2 * px, 2 * px, profile.shade, 0.95);
      this._add(out, texture, 10 * px, 8 * px, 2 * px, 2 * px, profile.shade, 0.95);
    } else if (profile.limbs === 3) {
      this._add(out, texture, 0, 6 * px, 2 * px, px, profile.dark, 0.9);
      this._add(out, texture, 11 * px, 6 * px, 2 * px, px, profile.dark, 0.9);
    }

    if (profile.limbs !== 0 || rng() > 0.58) {
      this._add(out, texture, 2 * px, 11 * px, 2 * px, px, profile.dark, 0.95);
      this._add(out, texture, 8 * px, 11 * px, 2 * px, px, profile.dark, 0.95);
    }
  }
}

/**
 * One message card: torn-edged frame, seeded pattern, mascot, identicon avatar, name, event tag,
 * wrapped message content, and a glitch overlay that flares on the way in and the way out.
 */
class ChatCard {
  readonly view = new PIXI.Container();
  readonly height: number;
  private age = 0;
  private targetY = 0;
  private positioned = false;
  private readonly cfg: CardConfig;
  private readonly width: number;
  private readonly bg = new PIXI.Graphics();
  private readonly glitch = new PIXI.Graphics();
  private readonly glitchSeed: number;
  private readonly glitchColors: number[];

  constructor(
    cfg: CardConfig,
    parent: PIXI.Container,
    texture: PIXI.Texture,
    msg: ChatMessage,
    width: number,
    palette: Palette,
    userSeed: number,
    userAccent: number,
    mascotSeed: number,
    plateSeed: number,
  ) {
    this.cfg = cfg;
    this.width = width;
    this.glitchSeed = plateSeed;
    this.glitchColors = [palette.glow, userAccent, palette.pop, 0xffffff];
    this.view.label = `chat:${msg.username}`;
    this.view.x = 0;
    this.view.alpha = 0;

    const avatarSize = 32;
    const avatarRightPad = 24;
    const avatarX = width - avatarRightPad - avatarSize;
    const textX = 74;
    const wrap = Math.max(180, avatarX - textX - 18);
    const name = new PIXI.Text({
      text: msg.displayName || msg.username || "anonymous",
      style: {
        fontFamily: '"Courier New", monospace',
        fontSize: 18,
        fontWeight: "900",
        fill: 0x08070b,
        letterSpacing: 0,
        stroke: {
          color: 0xffffff,
          width: 4,
        },
        dropShadow: {
          color: 0x000000,
          alpha: 0.55,
          distance: 2,
          blur: 0,
        },
      },
    });
    const tag = new PIXI.Text({
      text: eventLabel(msg),
      style: {
        fontFamily: '"Courier New", monospace',
        fontSize: 11,
        fontWeight: "900",
        fill: userAccent,
        letterSpacing: 0,
        stroke: {
          color: 0x0b0710,
          width: 2,
        },
      },
    });
    const content = this._makeMessageContent(msg, palette, wrap);

    name.x = textX;
    name.y = 15;
    tag.x = Math.max(textX, avatarX - tag.width - 14);
    tag.y = 19;
    content.x = textX;
    content.y = 39;

    this.height = Math.max(76, Math.ceil(content.height + 56));
    this._drawFrame(palette, userAccent, plateSeed);

    const pattern = new PixelPattern(cfg, texture, width - 16, this.height - 14, palette, plateSeed);
    pattern.view.x = 8;
    pattern.view.y = 7;
    pattern.view.alpha = 0.9;
    const patternMask = new PIXI.Graphics();
    this._stainShapeFill(patternMask, 8, 7, width - 16, this.height - 14, plateSeed, 0xffffff);
    patternMask.renderable = false;
    pattern.view.mask = patternMask;

    const avatar = this._makeAvatar(texture, userSeed, palette, userAccent);
    avatar.x = avatarX;
    avatar.y = Math.round((this.height - avatarSize) / 2);

    const mascot = new PixelMascot(cfg, texture, palette, userAccent, mascotSeed);
    mascot.view.x = -14;
    mascot.view.y = Math.max(30, this.height - 58);

    this.view.addChild(this.bg);
    this.view.addChild(patternMask);
    this.view.addChild(pattern.view);
    this.view.addChild(mascot.view);
    this.view.addChild(avatar);
    this.view.addChild(name);
    this.view.addChild(tag);
    this.view.addChild(content);
    this.view.addChild(this.glitch);

    parent.addChild(this.view);
  }

  private _makeMessageContent(msg: ChatMessage, palette: Palette, wrap: number): PIXI.Container {
    const content = new PIXI.Container();
    const style = {
      fontFamily: '"Courier New", monospace',
      fontSize: 17,
      fontWeight: "900" as const,
      fill: 0xffffff,
      lineHeight: 24,
      letterSpacing: 0,
      stroke: {
        color: 0x0b0710,
        width: 3,
      },
      dropShadow: {
        color: 0x000000,
        alpha: 0.35,
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

    const place = (node: PIXI.Container | PIXI.Text, nodeWidth: number, nodeHeight = lineHeight): void => {
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
        if (label.width > wrap) {
          label.scale.x = wrap / label.width;
        }
        place(label, Math.min(label.width, wrap), label.height);
      }
    };

    const addImage = (part: ChatPart & { type: "image" }): void => {
      const holder = new PIXI.Container();
      const backing = new PIXI.Graphics()
        .rect(0, 0, imageSize, imageSize)
        .fill(rgba(palette.base, 0.55))
        .rect(2, 2, imageSize - 4, imageSize - 4)
        .stroke({ color: palette.ink, width: 2, alpha: 0.38 });
      holder.addChild(backing);
      this._loadInlineImage(part, holder, imageSize);
      place(holder, imageSize, imageSize);
    };

    for (const part of renderParts(msg)) {
      if (part.type === "image") {
        addImage(part);
      } else {
        addText(part.text);
      }
    }

    if (!hasContent) addText(messageText(msg));
    return content;
  }

  /**
   * Loads an emote's static image into its backing box. Animated emotes show their static frame
   * (this application bundles no GIF plugin); a failed load falls back to the emote's name as
   * text, scaled to fit the box, so the message never has a hole in it.
   */
  private _loadInlineImage(part: ChatPart & { type: "image" }, holder: PIXI.Container, size: number): void {
    const fallbackText = (): void => {
      if (holder.destroyed) return;
      const fallback = new PIXI.Text({
        text: part.name || "?",
        style: {
          fontFamily: '"Courier New", monospace',
          fontSize: 14,
          fontWeight: "700",
          fill: 0xffffff,
          letterSpacing: 0,
        },
      });
      if (fallback.width > size - 2) fallback.scale.set((size - 2) / fallback.width);
      fallback.x = Math.round((size - fallback.width) / 2);
      fallback.y = Math.round((size - fallback.height) / 2);
      holder.addChild(fallback);
    };

    PIXI.Assets.load<PIXI.Texture>(part.url)
      .then((texture) => {
        if (holder.destroyed) return;
        const sprite = new PIXI.Sprite(texture);
        sprite.roundPixels = true;
        const inner = size - 2;
        const scale = inner / Math.max(texture.width, texture.height, 1);
        sprite.scale.set(scale);
        sprite.x = 1 + Math.round((inner - sprite.width) / 2);
        sprite.y = 1 + Math.round((inner - sprite.height) / 2);
        holder.addChild(sprite);
      })
      .catch(fallbackText);
  }

  setTarget(x: number, y: number): void {
    this.targetY = y;
    this.view.x = x;
    if (!this.positioned) {
      this.view.y = y;
      this.view.alpha = 0;
      this.view.scale.set(1);
      this.positioned = true;
    }
  }

  /**
   * Advances the card by `delta` (60ths of a second) and returns true when its lifetime is over.
   * The glitch envelope peaks while entering and leaving and stays quiet in the middle.
   */
  update(delta: number, x: number): boolean {
    const px = this.cfg.px;
    const lifetime = this.cfg.lifetimeFrames;
    this.age += delta;
    const enter = clamp(this.age / 24, 0, 1);
    const leave = this.age > lifetime - 55 ? clamp((lifetime - this.age) / 55, 0, 1) : 1;
    const entering = 1 - Math.pow(1 - enter, 3);
    const exitGlitch = leave < 1 ? 1 - leave : 0;
    const enterGlitch = 1 - enter;
    const glitchAmount = Math.max(exitGlitch, enterGlitch);
    const pulse = Math.sin((this.age + (this.glitchSeed % 41)) * 1.7);
    const snap = Math.sin((this.age + (this.glitchSeed % 67)) * 5.2);
    const jitter = Math.round(((pulse * 5 + snap * 2) * glitchAmount) / px) * px;

    this.view.x = x + jitter;
    this.view.y += (this.targetY - this.view.y) * 0.22 * delta;
    this.view.alpha =
      entering * leave * (0.72 + 0.28 * clamp(1 - glitchAmount + Math.abs(pulse) * glitchAmount, 0, 1));
    this.view.scale.set(1 + glitchAmount * 0.015 * (snap > 0 ? 1 : -1));
    this._drawGlitch(glitchAmount);

    return this.age >= lifetime;
  }

  private _drawGlitch(amount: number): void {
    const px = this.cfg.px;
    const g = this.glitch;
    g.clear();
    if (amount < 0.04) return;

    const rng = seedRng(this.glitchSeed ^ Math.floor(this.age * 13));
    const strips = 3 + Math.floor(amount * 9);
    for (let i = 0; i < strips; i++) {
      const y = snapPixel(rng() * this.height, px);
      const h = px * (1 + Math.floor(rng() * 2));
      const w = this.width * (0.12 + rng() * 0.46);
      const x = snapPixel((rng() - 0.08) * this.width, px);
      const color = this.glitchColors[Math.floor(rng() * this.glitchColors.length)] ?? 0xffffff;
      g.rect(x, y, w, h).fill(rgba(color, 0.18 + amount * 0.34));
      if (rng() > 0.45) {
        g.rect(x + px * (2 + Math.floor(rng() * 8)), y + h, w * (0.35 + rng() * 0.45), px).fill(
          rgba(0xffffff, 0.14 + amount * 0.24),
        );
      }
    }
  }

  private _drawFrame(palette: Palette, userColor: number, plateSeed: number): void {
    const px = this.cfg.px;
    const g = this.bg;
    const w = this.width;
    const h = this.height;
    g.clear();

    this._stainShapeFill(g, px, px, w, h, plateSeed ^ 0x3001, rgba(0x000000, 0.48));
    this._stainShapeFill(g, 0, 0, w, h, plateSeed ^ 0x100d13, 0x100d13);
    this._stainShapeFill(g, px, px, w - px * 2, h - px * 2, plateSeed, rgba(palette.base, 0.9));
    this._stainShapeFill(g, px * 2, px * 2, w - px * 4, h - px * 4, plateSeed ^ 0x517a, rgba(palette.panel, 0.38));
    this._stainShapeFill(g, px * 3, px * 3, w - px * 6, h - px * 6, plateSeed ^ 0xb10b, rgba(palette.base, 0.58));
    this._stainStripe(g, px * 4, px * 2, w - px * 8, 10, plateSeed ^ 0xa11, rgba(userColor, 0.94));
    this._stainStripe(g, px * 5, h - 12, w - px * 10, px * 2, plateSeed ^ 0x6100, rgba(palette.glow, 0.48));
    this._stainShapeFill(g, 10, 10, 44, h - 20, plateSeed ^ 0x44, rgba(0xffffff, 0.13));
    this._stainShapeFill(g, 14, 14, 36, h - 28, plateSeed ^ 0x22, rgba(userColor, 0.22));
  }

  private _stainStripe(
    g: PIXI.Graphics,
    x: number,
    y: number,
    w: number,
    h: number,
    seed: number,
    fill: number | { color: number; alpha: number },
  ): void {
    const rng = seedRng(seed);
    const step = this.cfg.px;
    for (let px = x; px < x + w; px += step * (1 + Math.floor(rng() * 3))) {
      const blockW = step * (2 + Math.floor(rng() * 6));
      const blockH = Math.max(step, h + (rng() - 0.5) * step * 2);
      g.rect(px, y + (rng() - 0.5) * step, blockW, blockH).fill(fill);
    }
  }

  private _stainShapeFill(
    g: PIXI.Graphics,
    x: number,
    y: number,
    w: number,
    h: number,
    seed: number,
    fill: number | { color: number; alpha: number },
  ): void {
    const rng = seedRng(seed);
    const px = this.cfg.px;
    const step = this.cfg.plate;
    const rows = Math.max(3, Math.ceil(h / step));
    const phaseA = rng() * Math.PI * 2;
    const phaseB = rng() * Math.PI * 2;
    const maxInset = Math.min(w * 0.16, 34 + rng() * 18);

    for (let row = 0; row < rows; row++) {
      const t = rows <= 1 ? 0.5 : row / (rows - 1);
      const edge = Math.abs(t - 0.5) * 2;
      const rowY = y + row * step;
      const rowH = Math.min(step, y + h - rowY);
      const leftWave = Math.sin(row * 0.88 + phaseA) * 9 + Math.sin(row * 0.37 + phaseB) * 7;
      const rightWave = Math.cos(row * 0.74 + phaseB) * 10 + Math.sin(row * 0.29 + phaseA) * 6;
      const taper = Math.pow(edge, 1.55) * maxInset;
      const left = snapPixel(Math.max(0, taper + leftWave + (rng() - 0.5) * 12), px);
      const right = snapPixel(Math.max(0, taper + rightWave + (rng() - 0.5) * 12), px);
      const rowW = Math.max(step * 4, w - left - right);
      g.rect(x + left, rowY, rowW, rowH).fill(fill);

      if (rng() > 0.5) {
        const blobW = step * (1 + Math.floor(rng() * 3));
        g.rect(x + left - blobW, rowY, blobW, rowH).fill(fill);
      }
      if (rng() > 0.5) {
        const blobW = step * (1 + Math.floor(rng() * 3));
        g.rect(x + left + rowW, rowY, blobW, rowH).fill(fill);
      }
    }

    const specks = 10 + Math.floor(rng() * 14);
    for (let i = 0; i < specks; i++) {
      const side = rng();
      const sx = side < 0.33 ? x + rng() * w : side < 0.66 ? x - step + rng() * step * 2 : x + w - rng() * step;
      const sy = side < 0.33 ? y + (rng() > 0.5 ? -step : h) + (rng() - 0.5) * step : y + rng() * h;
      const size = step * (rng() > 0.72 ? 2 : 1);
      g.rect(snapPixel(sx, px), snapPixel(sy, px), size, size).fill(fill);
    }
  }

  /**
   * The circular avatar. The wire model carries no profile-image URL (that needs an authenticated
   * Twitch API the backend does not call), so this is always the procedural identicon: a 7×7 grid
   * mirrored around its centre column, seeded from the username — the same fallback the original
   * drew while a profile image loaded.
   */
  private _makeAvatar(
    texture: PIXI.Texture,
    seed: number,
    palette: Palette,
    userColor: number,
  ): PIXI.Container {
    const px = this.cfg.px;
    const view = new PIXI.Container();
    const mask = new PIXI.Graphics().circle(16, 16, 14).fill(0xffffff);
    const fallback = new PIXI.ParticleContainer({
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
    const rng = seedRng(seed ^ 0xfeedbabe);
    const colors = [palette.ink, userColor, palette.glow, palette.pop, palette.base];
    const particles: PIXI.Particle[] = [];
    fallback.x = 2;
    fallback.y = 2;
    fallback.mask = mask;
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 7; x++) {
        const mirrorX = x > 3 ? 6 - x : x;
        const filled = rng() + mirrorX * 0.08 + y * 0.025 > 0.42;
        if (!filled) continue;
        particles.push(
          new PIXI.Particle({
            texture,
            x: x * px,
            y: y * px,
            scaleX: px,
            scaleY: px,
            tint: colors[Math.floor(rng() * colors.length)] ?? userColor,
            alpha: 0.92,
          }),
        );
      }
    }
    fallback.addParticle(...particles);
    fallback.update();
    view.addChild(mask);
    view.addChild(fallback);
    view.addChild(this._makeAvatarFrame(palette, userColor));
    return view;
  }

  private _makeAvatarFrame(palette: Palette, userColor: number): PIXI.Graphics {
    const frame = new PIXI.Graphics();
    frame.circle(16, 16, 16).stroke({ color: 0x07050b, width: 4, alpha: 0.74 });
    frame.circle(16, 16, 13).stroke({ color: mixColor(palette.glow, userColor, 0.42), width: 3, alpha: 0.92 });
    frame.rect(7, 5, 6, 3).fill(rgba(0xffffff, 0.55));
    frame.rect(11, 4, 3, 3).fill(rgba(0xffffff, 0.38));
    return frame;
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}

const chatCards = defineEffect({
  descriptor: {
    id: "chat-cards",
    name: "Chat Cards",
    description:
      "A pixel-art chat feed: every message becomes a chunky procedural card — seeded background motif, per-user pixel mascot, identicon avatar, confetti pop — stacked upward from the bottom-left corner.",
    engine: "pixi",
    category: "chat",
    tags: ["chat", "twitch", "pixel", "cards", "mascot", "retro"],
    previewNotes:
      "When Twitch is not configured (or the backend is down), a gentle simulated chat feed appears automatically, so the preview always shows cards within a few seconds. Transparent background — place it over your scene; cards stack from the bottom-left.",
    params: [
      {
        key: "px",
        label: "Pixel Size",
        kind: "number",
        default: 4,
        min: 2,
        max: 10,
        step: 1,
        description:
          "Size of one logical pixel in the card artwork — the mascots, patterns and torn edges are all built on this grid. Bigger is chunkier. Remounts the effect, because the grid is baked into every card.",
        rebuild: true,
      },
      {
        key: "cardGap",
        label: "Card Gap",
        kind: "number",
        default: 10,
        min: 0,
        max: 60,
        step: 1,
        description: "Vertical space between stacked cards, in pixels.",
      },
      {
        key: "maxCards",
        label: "Max Cards",
        kind: "number",
        default: 9,
        min: 1,
        max: 20,
        step: 1,
        description:
          "How many cards may be on screen at once. When a new message arrives beyond this, the oldest card is removed immediately.",
      },
      {
        key: "lifetime",
        label: "Card Lifetime",
        kind: "number",
        default: 30,
        min: 3,
        max: 600,
        step: 1,
        description:
          "How long a card stays on screen, in seconds, before it glitches out. Applies to cards already showing, too.",
      },
      {
        key: "widthMin",
        label: "Card Width (min)",
        kind: "number",
        default: 420,
        min: 160,
        max: 1200,
        step: 10,
        description:
          "Lower bound of the card width. Cards aim for about a third of the canvas width and are clamped between this and the maximum.",
      },
      {
        key: "widthMax",
        label: "Card Width (max)",
        kind: "number",
        default: 640,
        min: 200,
        max: 1600,
        step: 10,
        description: "Upper bound of the card width. Affects newly spawned cards.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    // No antialiasing: the whole look is hard-edged pixels, and the CSS hint below keeps them
    // hard when the browser scales the canvas.
    const stage = await createPixiStage(scope, ctx, { antialias: false });
    stage.app.canvas.style.imageRendering = "pixelated";

    const readPx = (p: Record<string, unknown>): number => int(p, "px", 4, 2, 10);
    const cfg: CardConfig = {
      px: readPx(ctx.params),
      plate: readPx(ctx.params) * 2,
      gap: int(ctx.params, "cardGap", 10, 0, 60),
      maxCards: int(ctx.params, "maxCards", 9, 1, 20),
      // Ages are counted in 60ths of a second — the original's Pixi-ticker frame unit — so the
      // seconds the admin types are converted once here.
      lifetimeFrames: num(ctx.params, "lifetime", 30, 3, 600) * 60,
      widthMin: int(ctx.params, "widthMin", 420, 160, 1200),
      widthMax: int(ctx.params, "widthMax", 640, 200, 1600),
    };

    const pixelTexture = makePixelTexture(stage.app);
    scope.defer(() => {
      pixelTexture.destroy(true);
    });

    // Cards live in their own container so the confetti layer can sit above all of them.
    const cardLayer = stage.stage.addChild(new PIXI.Container());
    const burstLayer = stage.stage.addChild(
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

    const cards: ChatCard[] = [];
    const burstParticles: MovingParticle[] = [];
    /**
     * First-seen accent colour per user, so one person's cards stay consistent for the session.
     * Both per-user maps are capped as LRU caches: an overlay left running for days on a busy
     * channel (or hit by a raid) would otherwise accumulate one entry per unique chatter forever.
     * Active chatters are re-touched on every message, so only long-silent users are evicted —
     * and an evicted user's mascot seed is a pure hash of the name, so it comes back identical;
     * only a rarely-returning user's accent may be re-derived.
     */
    const USER_CACHE_MAX = 200;
    const userAccents = new Map<string, number>();
    const userMascotSeeds = new Map<string, number>();
    let messageSerial = 0;

    /**
     * LRU bookkeeping on a Map, which iterates in insertion order: re-inserting on every read
     * keeps active users at the tail, so trimming from the head drops the least recently seen.
     */
    const touchLru = (cache: Map<string, number>, key: string, value: number): void => {
      cache.delete(key);
      cache.set(key, value);
      while (cache.size > USER_CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
    };

    const userKey = (username: string): string => username.trim().toLowerCase() || "anonymous";

    const userAccent = (msg: ChatMessage, key: string, userSeed: number): number => {
      const existing = userAccents.get(key);
      if (existing !== undefined) {
        touchLru(userAccents, key, existing);
        return existing;
      }

      const fallbackHue = userSeed % 360;
      const fallback = hslToRgb(fallbackHue, 0.78, 0.58);
      const accent = colorFromString(msg.color, fallback);
      touchLru(userAccents, key, accent);
      return accent;
    };

    const mascotSeedFor = (key: string): number => {
      const existing = userMascotSeeds.get(key);
      if (existing !== undefined) {
        touchLru(userMascotSeeds, key, existing);
        return existing;
      }

      const seed = hashSeed(`mascot:${key}`);
      touchLru(userMascotSeeds, key, seed);
      return seed;
    };

    /** A fresh seed per message, so the same user's consecutive cards never repeat a plate. */
    const nextPlateSeed = (msg: ChatMessage, key: string, userSeed: number): number => {
      messageSerial += 1;
      const randomBits = Math.floor(Math.random() * 0xffffffff);
      return hashSeed(
        [key, userSeed, msg.event, msg.text, messageSerial, performance.now().toFixed(3), randomBits].join(":"),
      );
    };

    const cardWidth = (): number =>
      Math.round(clamp(stage.width * 0.36, cfg.widthMin, cfg.widthMax) / cfg.px) * cfg.px;

    const left = (): number => (stage.width < 700 ? 12 : 28);

    const layoutCards = (): void => {
      let y = stage.height - 24;
      const x = left();
      for (const card of cards) {
        y -= card.height;
        card.setTarget(x, y);
        y -= cfg.gap;
      }
    };

    const burst = (card: ChatCard, palette: Palette, seed: number): void => {
      const rng = seedRng(seed ^ 0x4c415345);
      const x = left() + 28 + rng() * 120;
      const y = card.view.y + 14 + rng() * Math.max(42, card.height - 20);
      const colors = [palette.accent, palette.pop, palette.glow, palette.panel, palette.ink];

      for (let i = 0; i < 34; i++) {
        const speed = 1.4 + rng() * 3.2;
        const angle = -Math.PI * 0.85 + rng() * Math.PI * 0.95;
        const size = rng() > 0.75 ? cfg.px * 2 : cfg.px;
        const particle = new PIXI.Particle({
          texture: pixelTexture,
          x,
          y,
          scaleX: size,
          scaleY: size,
          tint: colors[Math.floor(rng() * colors.length)] ?? 0xffffff,
          alpha: 0.85,
        });
        burstLayer.addParticle(particle);
        burstParticles.push({
          particle,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 0,
          maxLife: 42 + rng() * 34,
        });
      }
    };

    const spawn = (msg: ChatMessage, withBurst: boolean): void => {
      const key = userKey(msg.username);
      const userSeed = msg.seed;
      const accent = userAccent(msg, key, userSeed);
      const mascotSeed = mascotSeedFor(key);
      const plateSeed = nextPlateSeed(msg, key, userSeed);
      const palette = makePalette(plateSeed, accent);
      const card = new ChatCard(
        cfg,
        cardLayer,
        pixelTexture,
        msg,
        cardWidth(),
        palette,
        userSeed,
        accent,
        mascotSeed,
        plateSeed,
      );
      cards.unshift(card);

      while (cards.length > cfg.maxCards) {
        cards.pop()?.destroy();
      }

      layoutCards();
      if (withBurst) burst(card, palette, plateSeed);
    };

    const chat = await useChat(scope);
    scope.checkpoint();

    // Seed the stack from history without confetti — these messages already happened, and a wall
    // of simultaneous bursts on mount would read as an event that did not.
    for (const message of chat.recent().slice(-cfg.maxCards)) {
      spawn(message, false);
    }
    const off = chat.onMessage((message) => {
      spawn(message, true);
    });
    scope.defer(off);

    stage.onResize(() => {
      layoutCards();
    });

    const updateBurst = (delta: number): void => {
      for (let i = burstParticles.length - 1; i >= 0; i--) {
        const item = burstParticles[i];
        if (!item) continue;
        item.life += delta;
        item.particle.x += item.vx * delta;
        item.particle.y += item.vy * delta;
        item.vy += 0.055 * delta;
        item.particle.alpha = clamp(1 - item.life / item.maxLife, 0, 1);
        if (item.life >= item.maxLife) {
          burstLayer.removeParticle(item.particle);
          burstParticles.splice(i, 1);
        }
      }
    };

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      // The original advanced ages by Pixi's ticker delta, where 1 unit = one 60fps frame. The
      // SDK clock hands seconds, so the conversion keeps every ported timing constant meaningful.
      const delta = dt * 60;
      const x = left();
      for (let i = cards.length - 1; i >= 0; i--) {
        if (cards[i]?.update(delta, x)) {
          cards[i]?.destroy();
          cards.splice(i, 1);
          layoutCards();
        }
      }
      updateBurst(delta);
      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        // `px` is declared rebuild:true, so a change remounts; it is still read here so the
        // config never disagrees with the stored value in the window before the remount lands.
        cfg.px = readPx(p);
        cfg.plate = cfg.px * 2;
        cfg.gap = int(p, "cardGap", 10, 0, 60);
        cfg.maxCards = int(p, "maxCards", 9, 1, 20);
        cfg.lifetimeFrames = num(p, "lifetime", 30, 3, 600) * 60;
        cfg.widthMin = int(p, "widthMin", 420, 160, 1200);
        cfg.widthMax = int(p, "widthMax", 640, 200, 1600);

        while (cards.length > cfg.maxCards) {
          cards.pop()?.destroy();
        }
        layoutCards();
      },
    };
  },
});

export default chatCards;
