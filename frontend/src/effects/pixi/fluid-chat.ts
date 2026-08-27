import * as PIXI from "pixi.js";

import type { ChatMessage, ChatPart } from "~/types/contract";
import { bool, int, num } from "../paramUtils";
import { createPixiStage, defineEffect, onFrame, useChat } from "../sdk";

/**
 * Fluid Chat
 * ==========
 *
 * Chat messages rendered as liquid: each message is a card whose outline is a wobbling,
 * organically deforming blob drawn with smoothed bezier curves, filled with a deep liquid colour
 * and layered with drifting highlight ellipses, a foam streak and floating droplets. Every user
 * gets their own procedurally generated blob mascot — a soft-body creature with seeded eyes,
 * mouth, horns, limbs and spots — that jiggles beside their messages. A splash of blob particles
 * bursts out whenever a new card arrives, and cards stack from the bottom of the screen upwards
 * before melting away.
 *
 * Ported from `scenes/fluid-chat/fluid-chat.ts` in the old twitch-vizer repository. What changed
 * in the port:
 *
 *  - The old scene opened its own WebSocket (`OverlayEventSocket`) to a Python backend. This
 *    version reads the shared chat bus (`useChat`), which the effect SDK connects and reconnects
 *    for the whole page.
 *  - The old keyboard preview (spacebar spawned a fake message) is gone. The SDK's simulated feed
 *    replaces it: when Twitch is not configured, gentle canned messages arrive on their own.
 *  - The old scene could show a Twitch avatar image on the right of each card. The new backend
 *    does not deliver avatar URLs (that needs an authenticated Helix call), so the card always
 *    shows the procedural liquid-droplet avatar the old scene used as its fallback.
 *  - Emote images load through `PIXI.Assets.load` using the emote's **static** URL only — this
 *    project has no animated-GIF plugin for Pixi — and a load failure falls back to drawing the
 *    emote's name as text instead of a picture.
 *  - The scene's hard-coded constants (card count, lifetime, gap, text sizes, particle count)
 *    are parameters now.
 */

/** One card's colour scheme, derived per message so every card looks freshly mixed. */
interface FluidPalette {
  /** The dark liquid the card is filled with. */
  deep: number;
  /** First highlight tint, layered as translucent ellipses over the fill. */
  skin: number;
  /** Second highlight tint, alternated with the first. */
  skin2: number;
  /** The user's chat colour, lightened a touch, used in strokes and mascot accents. */
  accent: number;
  /** A warm droplet colour. */
  warm: number;
  /** A cool droplet colour. */
  cool: number;
  /** Text ink chosen for contrast against the highlight tint (unused directly here but kept from
   * the original palette so mascot mixing stays byte-identical). */
  ink: number;
  /** The near-white foam colour used for name text, streaks and eye whites. */
  foam: number;
}

/** One control point of a wobbling blob outline: a base ellipse position plus its own wave. */
interface BlobPoint {
  angle: number;
  rx: number;
  ry: number;
  phase: number;
  speed: number;
  amp: number;
}

/** One droplet of the splash burst that fires when a card arrives. */
interface BlobParticle {
  view: PIXI.Graphics;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  radius: number;
  color: number;
}

const TAU = Math.PI * 2;

/* ------------------------------------------------------------------ */
/* Small helpers carried over from the old shared/overlay.ts           */
/* ------------------------------------------------------------------ */

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** A tiny deterministic random generator (linear congruential), so the same seed always draws the
 * same blob shape and the same mascot. */
function seedRng(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/** FNV-1a string hash, used to turn usernames and message identity into stable seeds. */
function hashSeed(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Parses a `#rrggbb` string into a 24-bit integer, or returns the fallback if it is not one. */
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

/** Mixes two 24-bit colours channel by channel; `t = 0` gives `a`, `t = 1` gives `b`. */
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

/** Shorthand for Pixi v8's `{ color, alpha }` fill/stroke style objects. */
function rgba(color: number, alpha: number): { color: number; alpha: number } {
  return { color, alpha };
}

/** Perceptual brightness of a colour, used to pick dark-or-light ink against it. */
function luminance(color: number): number {
  const r = ((color >> 16) & 0xff) / 255;
  const g = ((color >> 8) & 0xff) / 255;
  const b = (color & 0xff) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Mixes a fresh palette for one card from the message's seed and the sender's chat colour. */
function makePalette(seed: number, userAccent: number): FluidPalette {
  const rng = seedRng(seed ^ 0xb10bd00d);
  const hue = Math.floor(rng() * 360);
  const accentHue = hue + 30 + rng() * 90;
  const coolHue = hue + 142 + rng() * 58;
  const warmHue = hue - 56 + rng() * 42;
  const skin = mixColor(userAccent, hslToRgb(accentHue, 0.86, 0.62), 0.35);
  const skin2 = hslToRgb(coolHue, 0.72, 0.58 + rng() * 0.12);
  const warm = hslToRgb(warmHue, 0.88, 0.62);
  const cool = hslToRgb(coolHue + 38, 0.78, 0.68);
  const deep = mixColor(hslToRgb(hue + 12, 0.52, 0.14), userAccent, 0.18);
  const ink = luminance(skin) > 0.58 ? 0x10131a : 0xf8fff4;
  return {
    deep,
    skin,
    skin2,
    accent: mixColor(userAccent, 0xffffff, 0.12),
    warm,
    cool,
    ink,
    foam: mixColor(0xffffff, cool, 0.18),
  };
}

/** The line shown for a message. Ordinary chat shows its text; channel events show the backend's
 * system message ("subscribed for 3 months"), which the backend puts in `text` too. */
function messageText(msg: ChatMessage): string {
  return msg.text.trim() || "...";
}

/** The renderable fragments of a message, falling back to one text part when the backend sent
 * none (bare channel events can arrive with an empty `parts` array). */
function renderParts(msg: ChatMessage): ChatPart[] {
  if (msg.parts.length > 0) return msg.parts;
  return [{ type: "text", text: messageText(msg) }];
}

/** The small uppercase tag on the card's right: "CHAT", "SUB", "GIFT SUB", "CHEER", "RAID". */
function eventLabel(event: ChatMessage["event"]): string {
  return event === "chat" ? "CHAT" : event.replace("_", " ").toUpperCase();
}

/**
 * Draws a closed shape through `points` using cubic beziers whose control points come from the
 * neighbouring points (a Catmull-Rom-style smoothing). This is what turns a ring of jittering
 * sample points into a soft liquid outline instead of a polygon.
 */
function smoothClosedBlob(
  g: PIXI.Graphics,
  points: { x: number; y: number }[],
  fill: number | { color: number; alpha: number },
  stroke?: { color: number; alpha: number; width: number },
): void {
  if (points.length < 3) return;
  const first = points[0];
  if (first === undefined) return;
  g.moveTo(first.x, first.y);
  for (let i = 0; i < points.length; i++) {
    const current = points[i] ?? first;
    const next = points[(i + 1) % points.length] ?? first;
    const previous = points[(i - 1 + points.length) % points.length] ?? first;
    const afterNext = points[(i + 2) % points.length] ?? first;
    const cp1x = current.x + (next.x - previous.x) / 6;
    const cp1y = current.y + (next.y - previous.y) / 6;
    const cp2x = next.x - (afterNext.x - current.x) / 6;
    const cp2y = next.y - (afterNext.y - current.y) / 6;
    g.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, next.x, next.y);
  }
  g.closePath().fill(fill);
  if (stroke) g.stroke(stroke);
}

/**
 * The card's liquid body: a seeded ring of 15-19 points, each riding two superimposed sine waves,
 * redrawn every frame. Layers, back to front: a dark halo, a drop shadow, the deep liquid fill
 * with a foam-tinted stroke, five drifting highlight ellipses, a foam streak, and two droplets.
 */
class WobblyBlob {
  readonly view = new PIXI.Graphics();
  private readonly points: BlobPoint[];
  private readonly seed: number;
  private elapsed = 0;

  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly palette: FluidPalette,
    seed: number,
  ) {
    this.seed = seed;
    const rng = seedRng(seed ^ 0x5f17b10b);
    const count = 15 + Math.floor(rng() * 5);
    this.points = Array.from({ length: count }, (_, index) => {
      const angle = (index / count) * TAU;
      return {
        angle,
        rx: 0.86 + rng() * 0.24,
        ry: 0.8 + rng() * 0.28,
        phase: rng() * TAU,
        speed: 0.01 + rng() * 0.018,
        amp: 6 + rng() * 11,
      };
    });
    this.draw(0);
  }

  update(delta: number): void {
    this.elapsed += delta;
    this.draw(this.elapsed);
  }

  private draw(time: number): void {
    const g = this.view;
    const w = this.width;
    const h = this.height;
    const cx = w * 0.52;
    const cy = h * 0.5;
    const rx = w * 0.48;
    const ry = h * 0.48;
    const liquid = this.points.map((point) => {
      const wobble =
        Math.sin(time * point.speed + point.phase) * point.amp +
        Math.sin(time * point.speed * 0.62 + point.phase * 1.7) * point.amp * 0.45;
      return {
        x: cx + Math.cos(point.angle) * (rx * point.rx + wobble),
        y: cy + Math.sin(point.angle) * (ry * point.ry + wobble * 0.72),
      };
    });
    // Reseeded every draw so the highlight ellipses keep the same base positions each frame and
    // only drift by their sine offsets, instead of teleporting.
    const rng = seedRng(this.seed ^ 0xca7d);

    g.clear();
    smoothClosedBlob(g, liquid, rgba(0x030409, 0.36));

    const shadow = liquid.map((p) => ({ x: p.x + 8, y: p.y + 10 }));
    smoothClosedBlob(g, shadow, rgba(0x000000, 0.2));
    smoothClosedBlob(g, liquid, rgba(this.palette.deep, 0.88), {
      color: mixColor(this.palette.foam, this.palette.accent, 0.2),
      alpha: 0.4,
      width: 2,
    });

    for (let i = 0; i < 5; i++) {
      const lx = w * (0.16 + rng() * 0.7) + Math.sin(time * 0.013 + i) * 9;
      const ly = h * (0.18 + rng() * 0.56) + Math.cos(time * 0.011 + i * 1.8) * 6;
      g.ellipse(lx, ly, 42 + rng() * 82, 10 + rng() * 28).fill(
        rgba(i % 2 ? this.palette.skin : this.palette.skin2, 0.17 + rng() * 0.18),
      );
    }

    g.ellipse(w * 0.3 + Math.sin(time * 0.018) * 8, h * 0.18, w * 0.24, 18).fill(
      rgba(this.palette.foam, 0.16),
    );
    g.circle(w * 0.86, h * 0.22 + Math.sin(time * 0.02) * 4, 8).fill(
      rgba(this.palette.warm, 0.5),
    );
    g.circle(w * 0.91, h * 0.58 + Math.cos(time * 0.016) * 4, 5).fill(
      rgba(this.palette.cool, 0.48),
    );
  }
}

/**
 * A user's blob creature. Everything about it — eye count and placement, mouth shape, horns or
 * antenna, limbs, spot pattern, body colour — is picked by arithmetic on the user's seed, so the
 * same user always gets the same creature across messages and sessions.
 */
class BlobMascot {
  readonly view = new PIXI.Container();
  private readonly body = new PIXI.Graphics();
  private readonly face = new PIXI.Graphics();
  private readonly points: BlobPoint[];
  private readonly profile: {
    eye: number;
    mouth: number;
    horns: number;
    limbs: number;
    spots: number;
    body: number;
    shade: number;
    accent: number;
  };
  private elapsed = 0;

  constructor(
    private readonly palette: FluidPalette,
    userColor: number,
    seed: number,
  ) {
    const rng = seedRng(seed ^ 0xa11faced);
    const bodyBases = [palette.skin, palette.skin2, palette.warm, palette.cool];
    const accents = [palette.warm, palette.cool, palette.foam, palette.accent];
    this.profile = {
      eye: seed % 6,
      mouth: Math.floor(seed / 17) % 5,
      horns: Math.floor(seed / 43) % 5,
      limbs: Math.floor(seed / 89) % 4,
      spots: Math.floor(seed / 131) % 7,
      body: mixColor(userColor, bodyBases[seed % 4] ?? palette.skin, 0.46),
      shade: mixColor(userColor, palette.deep, 0.45),
      accent: accents[Math.floor(seed / 7) % 4] ?? palette.warm,
    };
    const count = 12 + Math.floor(rng() * 4);
    this.points = Array.from({ length: count }, (_, index) => ({
      angle: (index / count) * TAU,
      rx: 0.78 + rng() * 0.3,
      ry: 0.78 + rng() * 0.32,
      phase: rng() * TAU,
      speed: 0.018 + rng() * 0.028,
      amp: 2.8 + rng() * 4.6,
    }));

    this.view.addChild(this.body);
    this.view.addChild(this.face);
    this.draw();
  }

  update(delta: number): void {
    this.elapsed += delta;
    this.view.rotation = Math.sin(this.elapsed * 0.022) * 0.04;
    this.view.y += Math.sin(this.elapsed * 0.035) * 0.016 * delta;
    this.draw();
  }

  private draw(): void {
    const g = this.body;
    const f = this.face;
    const time = this.elapsed;
    const cx = 29;
    const cy = 29;
    const rx = 25;
    const ry = 23;
    const points = this.points.map((point) => {
      const wobble = Math.sin(time * point.speed + point.phase) * point.amp;
      return {
        x: cx + Math.cos(point.angle) * (rx * point.rx + wobble),
        y: cy + Math.sin(point.angle) * (ry * point.ry + wobble * 0.75),
      };
    });

    g.clear();
    f.clear();
    g.ellipse(31, 55, 23, 5).fill(rgba(0x000000, 0.2));

    this.drawAppendages(g, time);
    smoothClosedBlob(g, points, rgba(this.profile.body, 0.98), {
      color: mixColor(this.profile.shade, 0x04040a, 0.24),
      alpha: 0.86,
      width: 4,
    });
    g.ellipse(19 + Math.sin(time * 0.025) * 2, 17, 12, 5).fill(
      rgba(mixColor(this.profile.body, 0xffffff, 0.42), 0.5),
    );

    for (let i = 0; i < this.profile.spots; i++) {
      const angle = i * 1.73 + this.profile.eye;
      const x = 30 + Math.cos(angle) * (8 + (i % 3) * 4);
      const y = 30 + Math.sin(angle * 1.2) * 10;
      g.circle(x, y, 2.4 + (i % 2) * 1.6).fill(rgba(this.profile.accent, 0.4));
    }

    this.drawFace(f, time);
  }

  private drawAppendages(g: PIXI.Graphics, time: number): void {
    if (this.profile.horns === 1 || this.profile.horns === 3) {
      g.moveTo(15, 13)
        .quadraticCurveTo(14, -2, 25, 10)
        .quadraticCurveTo(21, 13, 15, 13)
        .fill(rgba(this.profile.accent, 0.94));
      g.moveTo(40, 12)
        .quadraticCurveTo(45, -1, 49, 15)
        .quadraticCurveTo(45, 13, 40, 12)
        .fill(rgba(this.profile.accent, 0.94));
    } else if (this.profile.horns === 2) {
      g.circle(19, 9, 5).fill(rgba(this.profile.accent, 0.92));
      g.circle(42, 9, 5).fill(rgba(this.profile.accent, 0.92));
    } else if (this.profile.horns === 4) {
      g.moveTo(25, 8).quadraticCurveTo(31, -4, 36, 9).fill(rgba(this.profile.accent, 0.92));
    }

    if (this.profile.limbs > 0) {
      const sway = Math.sin(time * 0.04) * 3;
      g.ellipse(7, 33 + sway, 8, 4).fill(rgba(this.profile.shade, 0.96));
      g.ellipse(52, 34 - sway, 8, 4).fill(rgba(this.profile.shade, 0.96));
      if (this.profile.limbs > 1) {
        g.ellipse(22, 52, 5, 7).fill(rgba(this.profile.shade, 0.96));
        g.ellipse(39, 52, 5, 7).fill(rgba(this.profile.shade, 0.96));
      }
    }
  }

  private drawFace(g: PIXI.Graphics, time: number): void {
    // A slow sine crossing a high threshold: the eyes are open ~97% of the time and blink shut
    // for a few frames, phase-offset per creature so a row of mascots never blinks in unison.
    const blink = Math.sin(time * 0.035 + this.profile.eye) > 0.965;
    const eyeColor = this.profile.eye % 2 ? this.palette.foam : 0xffffff;
    const pupil = 0x080a11;
    const y = this.profile.eye === 4 ? 25 : 24;

    if (this.profile.eye === 2) {
      this.eye(g, 24, 22, blink, eyeColor, pupil, 5);
      this.eye(g, 35, 27, blink, eyeColor, pupil, 4);
    } else if (this.profile.eye === 3) {
      this.eye(g, 30, 22, blink, eyeColor, pupil, 7);
    } else if (this.profile.eye === 5) {
      this.eye(g, 21, 23, blink, eyeColor, pupil, 4);
      this.eye(g, 31, 21, blink, eyeColor, pupil, 4);
      this.eye(g, 41, 23, blink, eyeColor, pupil, 4);
    } else {
      this.eye(g, 22, y, blink, eyeColor, pupil, 5);
      this.eye(g, 38, y, blink, eyeColor, pupil, 5);
    }

    const mouthY = 36;
    if (this.profile.mouth === 0) {
      g.roundRect(24, mouthY, 15, 8, 4).fill(rgba(0x130910, 0.92));
      g.circle(29, mouthY + 6, 3).fill(rgba(0xff7695, 0.88));
    } else if (this.profile.mouth === 1) {
      g.moveTo(24, mouthY)
        .quadraticCurveTo(31, mouthY + 8, 39, mouthY)
        .stroke({ color: 0x130910, width: 3, alpha: 0.9 });
    } else if (this.profile.mouth === 2) {
      g.roundRect(24, mouthY, 15, 4, 2).fill(rgba(0x130910, 0.92));
      g.rect(28, mouthY, 3, 4).fill(rgba(0xfff4c8, 0.95));
      g.rect(34, mouthY, 3, 4).fill(rgba(0xfff4c8, 0.95));
    } else if (this.profile.mouth === 3) {
      g.circle(31, mouthY + 2, 5).fill(rgba(0x130910, 0.92));
    } else {
      g.moveTo(25, mouthY + 2)
        .quadraticCurveTo(31, mouthY - 2, 37, mouthY + 2)
        .stroke({ color: 0x130910, width: 3, alpha: 0.9 });
    }
  }

  private eye(
    g: PIXI.Graphics,
    x: number,
    y: number,
    blink: boolean,
    eyeColor: number,
    pupil: number,
    radius: number,
  ): void {
    if (blink) {
      g.roundRect(x - radius, y - 1, radius * 2, 3, 2).fill(rgba(pupil, 0.9));
      return;
    }
    g.circle(x, y, radius).fill(rgba(eyeColor, 0.98));
    g.circle(x + radius * 0.22, y + radius * 0.18, Math.max(2, radius * 0.42)).fill(pupil);
    g.circle(x - radius * 0.25, y - radius * 0.24, Math.max(1, radius * 0.18)).fill(
      rgba(0xffffff, 0.72),
    );
  }
}

/** Everything a card needs to know that comes from the effect's parameters, bundled so a card
 * keeps the settings it was born with (live cards do not reflow when parameters change). */
interface CardSettings {
  lifetime: number;
  nameFontSize: number;
  textFontSize: number;
  showEmotes: boolean;
}

/**
 * One message's card: the wobbling blob plate, the sender's mascot on the left, the name and
 * event tag, the wrapped message content (text runs and inline emote images), and the procedural
 * droplet avatar on the right.
 */
class ChatCard {
  readonly view = new PIXI.Container();
  readonly height: number;
  private readonly lifetime: number;
  private age = 0;
  private targetY = 0;
  private positioned = false;
  private readonly blob: WobblyBlob;
  private readonly mascot: BlobMascot;

  constructor(
    parent: PIXI.Container,
    msg: ChatMessage,
    width: number,
    palette: FluidPalette,
    userSeed: number,
    userAccent: number,
    mascotSeed: number,
    plateSeed: number,
    settings: CardSettings,
  ) {
    this.lifetime = settings.lifetime;
    this.view.label = `fluid-chat:${msg.username}`;
    this.view.alpha = 0;

    const avatarSize = 38;
    const avatarRightPad = 28;
    const avatarX = width - avatarRightPad - avatarSize;
    const mascotSlot = 74;
    const textX = mascotSlot + 18;
    const wrap = Math.max(190, avatarX - textX - 18);
    const content = this.makeMessageContent(msg, palette, wrap, settings);

    this.height = Math.max(94, Math.ceil(content.height + 68));
    this.blob = new WobblyBlob(width, this.height, palette, plateSeed);
    this.mascot = new BlobMascot(palette, userAccent, mascotSeed);
    this.mascot.view.x = 14;
    this.mascot.view.y = Math.max(22, this.height - 72);

    const name = new PIXI.Text({
      text: msg.displayName || msg.username || "anonymous",
      style: {
        fontFamily: '"Trebuchet MS", "Avenir Next", "Segoe UI", sans-serif',
        fontSize: settings.nameFontSize,
        fontWeight: "900",
        fill: palette.foam,
        letterSpacing: 0,
        stroke: { color: 0x05060b, width: 4 },
        dropShadow: { color: 0x000000, alpha: 0.45, distance: 2, blur: 4 },
      },
    });
    const tag = new PIXI.Text({
      text: eventLabel(msg.event),
      style: {
        fontFamily: '"Trebuchet MS", "Avenir Next", "Segoe UI", sans-serif',
        fontSize: 11,
        fontWeight: "900",
        fill: palette.warm,
        letterSpacing: 0,
        stroke: { color: 0x05060b, width: 2 },
      },
    });
    const avatar = this.makeAvatar(userSeed, palette, userAccent);

    name.x = textX;
    name.y = 18;
    tag.x = Math.max(textX, avatarX - tag.width - 12);
    tag.y = 24;
    content.x = textX;
    content.y = 47;
    avatar.x = avatarX;
    avatar.y = Math.round((this.height - avatarSize) / 2);

    this.view.addChild(this.blob.view);
    this.view.addChild(this.mascot.view);
    this.view.addChild(name);
    this.view.addChild(tag);
    this.view.addChild(content);
    this.view.addChild(avatar);

    parent.addChild(this.view);
  }

  setTarget(x: number, y: number): void {
    this.targetY = y;
    this.view.x = x;
    if (!this.positioned) {
      // A new card starts below its slot and slightly shrunk, so it rises and swells into place.
      this.view.y = y + 28;
      this.view.scale.set(0.96);
      this.positioned = true;
    }
  }

  /** Advances the card one tick. Returns true once its lifetime is over and it should be removed. */
  update(delta: number, x: number): boolean {
    this.age += delta;
    const enter = clamp(this.age / 26, 0, 1);
    const leave = this.age > this.lifetime - 70 ? clamp((this.lifetime - this.age) / 70, 0, 1) : 1;
    const eased = 1 - Math.pow(1 - enter, 3);
    const wobble = Math.sin(this.age * 0.032) * 2.5;

    this.view.x += (x + wobble - this.view.x) * Math.min(1, 0.22 * delta);
    this.view.y += (this.targetY - this.view.y) * Math.min(1, 0.18 * delta);
    this.view.alpha = eased * leave;
    this.view.scale.set(0.96 + eased * 0.04 - (1 - leave) * 0.05);
    this.blob.update(delta);
    this.mascot.update(delta);
    return this.age >= this.lifetime;
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }

  /** Lays the message out as word-wrapped text with inline emote images between the words. */
  private makeMessageContent(
    msg: ChatMessage,
    palette: FluidPalette,
    wrap: number,
    settings: CardSettings,
  ): PIXI.Container {
    const content = new PIXI.Container();
    const style = {
      fontFamily: '"Trebuchet MS", "Avenir Next", "Segoe UI", sans-serif',
      fontSize: settings.textFontSize,
      fontWeight: "800" as const,
      fill: 0xffffff,
      lineHeight: Math.round(settings.textFontSize * 1.4),
      letterSpacing: 0,
      stroke: { color: 0x04050b, width: 3 },
      dropShadow: { color: 0x000000, alpha: 0.28, distance: 1, blur: 3 },
    };
    const imageSize = Math.round(settings.textFontSize * 1.4);
    const gap = 5;
    const lineHeight = Math.round(settings.textFontSize * 1.45);
    let x = 0;
    let y = 0;
    let hasContent = false;

    const newline = (): void => {
      x = 0;
      y += lineHeight;
    };

    const place = (node: PIXI.Container | PIXI.Text, width: number, height = lineHeight): void => {
      if (x > 0 && x + width > wrap) newline();
      node.x = x;
      node.y = y + Math.max(0, Math.floor((lineHeight - height) / 2));
      content.addChild(node);
      x += width + gap;
      hasContent = true;
    };

    const addText = (text: string): void => {
      for (const chunk of text.match(/\S+\s*|\s+/g) ?? []) {
        if (!chunk.trim()) {
          x = Math.min(wrap, x + 8);
          continue;
        }
        const label = new PIXI.Text({ text: chunk, style });
        // A single word longer than the wrap width is squashed horizontally rather than clipped,
        // so pasted links stay (barely) readable instead of running off the card.
        if (label.width > wrap) label.scale.x = wrap / label.width;
        place(label, Math.min(label.width, wrap), label.height);
      }
    };

    const addImage = (part: ChatPart & { type: "image" }): void => {
      if (!settings.showEmotes || !part.url) {
        addText(part.name);
        return;
      }
      const holder = new PIXI.Container();
      const backing = new PIXI.Graphics()
        .circle(imageSize / 2, imageSize / 2, imageSize / 2)
        .fill(rgba(palette.foam, 0.18))
        .stroke({ color: palette.foam, width: 1.5, alpha: 0.42 });
      holder.addChild(backing);
      this.loadInlineImage(part, holder, imageSize);
      place(holder, imageSize, imageSize);
    };

    for (const part of renderParts(msg)) {
      if (part.type === "image") addImage(part);
      else addText(part.text);
    }

    if (!hasContent) addText(messageText(msg));
    return content;
  }

  /**
   * Loads an emote picture into its circular backing. Always the **static** URL: this project has
   * no GIF plugin for Pixi, so an animated emote shows its still frame. A failed load draws the
   * emote's name as small text inside the circle instead, so the message never loses a word.
   */
  private loadInlineImage(
    part: ChatPart & { type: "image" },
    holder: PIXI.Container,
    size: number,
  ): void {
    const showFallback = (): void => {
      if (holder.destroyed) return;
      const fallback = new PIXI.Text({
        text: part.name || "?",
        style: {
          fontFamily: '"Trebuchet MS", sans-serif',
          fontSize: 9,
          fontWeight: "900",
          fill: 0xffffff,
          letterSpacing: 0,
        },
      });
      if (fallback.width > size - 2) fallback.scale.set((size - 2) / fallback.width);
      fallback.x = Math.round((size - fallback.width) / 2);
      fallback.y = Math.round((size - fallback.height) / 2);
      holder.addChild(fallback);
    };

    void (async (): Promise<void> => {
      try {
        const texture = await PIXI.Assets.load<PIXI.Texture>(part.url);
        if (holder.destroyed) return;
        const sprite = new PIXI.Sprite(texture);
        const inner = size - 3;
        const scale = inner / Math.max(sprite.width, sprite.height, 1);
        sprite.scale.set(scale);
        sprite.x = 1 + Math.round((inner - sprite.width) / 2);
        sprite.y = 1 + Math.round((inner - sprite.height) / 2);
        holder.addChild(sprite);
      } catch {
        showFallback();
      }
    })();
  }

  /**
   * The round badge on the card's right. The old scene tried a Twitch profile picture first and
   * fell back to this seeded droplet composition; the new backend sends no avatar URLs, so the
   * droplet *is* the avatar now.
   */
  private makeAvatar(seed: number, palette: FluidPalette, userColor: number): PIXI.Container {
    const view = new PIXI.Container();
    const droplet = new PIXI.Graphics();
    const rng = seedRng(seed ^ 0xfaceb10b);
    droplet.circle(19, 19, 19).fill(rgba(mixColor(userColor, palette.deep, 0.24), 0.96));
    droplet.circle(16 + rng() * 6, 14 + rng() * 5, 8).fill(rgba(palette.foam, 0.3));
    droplet.circle(23, 23, 10).fill(rgba(palette.warm, 0.22));
    view.addChild(droplet);
    view.addChild(this.avatarRing(palette, userColor));
    return view;
  }

  private avatarRing(palette: FluidPalette, userColor: number): PIXI.Graphics {
    return new PIXI.Graphics()
      .circle(19, 19, 20)
      .stroke({ color: 0x05060b, width: 5, alpha: 0.58 })
      .circle(19, 19, 18)
      .stroke({ color: mixColor(palette.foam, userColor, 0.26), width: 2.5, alpha: 0.96 })
      .circle(13, 10, 3)
      .fill(rgba(0xffffff, 0.58));
  }
}

const fluidChat = defineEffect({
  descriptor: {
    id: "fluid-chat",
    name: "Fluid Chat",
    description:
      "Chat messages as liquid: wobbling blob cards with drifting highlights and foam, a seeded soft-body mascot creature per user, and a splash of droplets when a message lands.",
    engine: "pixi",
    category: "chat",
    tags: ["chat", "twitch", "blob", "liquid", "mascot", "organic"],
    previewNotes:
      "Reads the configured Twitch channel's chat. When Twitch is not configured (or the backend is unreachable) a simulated feed of gentle canned messages appears after a few seconds, so the preview always shows moving cards. Transparent background; cards stack up from the bottom-left.",
    params: [
      {
        key: "lifetime",
        label: "Card Lifetime",
        kind: "number",
        default: 30,
        min: 5,
        max: 300,
        step: 1,
        description:
          "How many seconds a card stays on screen before melting away. It also leaves early when newer messages push it past the card limit.",
      },
      {
        key: "maxCards",
        label: "Max Cards",
        kind: "number",
        default: 7,
        min: 1,
        max: 15,
        step: 1,
        description:
          "The most cards shown at once. When a new message arrives with the stack full, the oldest card is removed immediately.",
      },
      {
        key: "cardGap",
        label: "Card Gap",
        kind: "number",
        default: 13,
        min: 0,
        max: 60,
        step: 1,
        description: "Vertical space between stacked cards, in pixels.",
      },
      {
        key: "nameFontSize",
        label: "Name Size",
        kind: "number",
        default: 19,
        min: 10,
        max: 40,
        step: 1,
        description: "Font size of the sender's name at the top of each card, in pixels.",
      },
      {
        key: "textFontSize",
        label: "Text Size",
        kind: "number",
        default: 18,
        min: 10,
        max: 36,
        step: 1,
        description:
          "Font size of the message text, in pixels. Line height and inline emote size scale with it.",
      },
      {
        key: "burstCount",
        label: "Splash Droplets",
        kind: "number",
        default: 16,
        min: 0,
        max: 60,
        step: 1,
        description:
          "How many blob droplets splash out when a new card arrives. 0 turns the splash off.",
      },
      {
        key: "showEmotes",
        label: "Show Emotes",
        kind: "boolean",
        default: true,
        description:
          "Draw Twitch emotes and emoji as inline pictures. Off, their names appear as plain text instead. Animated emotes always show their still frame either way.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    const stage = await createPixiStage(scope, ctx);

    const chat = await useChat(scope);
    scope.checkpoint();

    let lifetimeSec = num(ctx.params, "lifetime", 30, 5, 300);
    let maxCards = int(ctx.params, "maxCards", 7, 1, 15);
    let cardGap = num(ctx.params, "cardGap", 13, 0, 60);
    let nameFontSize = int(ctx.params, "nameFontSize", 19, 10, 40);
    let textFontSize = int(ctx.params, "textFontSize", 18, 10, 36);
    let burstCount = int(ctx.params, "burstCount", 16, 0, 60);
    let showEmotes = bool(ctx.params, "showEmotes", true);

    /*
     * The port keeps the original's timing constants untouched by keeping its clock: the old
     * scene ran on Pixi's ticker `deltaTime`, which is ~1 per frame at 60fps. `onFrame` hands us
     * seconds, so every tick converts `dt` seconds into that frame unit. A "lifetime" of 30
     * seconds is therefore 30 * 60 ticks internally.
     */
    const FRAME_UNITS_PER_SECOND = 60;

    const cardLayer = stage.stage.addChild(new PIXI.Container());
    const burstLayer = stage.stage.addChild(new PIXI.Container());

    const cards: ChatCard[] = [];
    const burstParticles: BlobParticle[] = [];
    // Per-user caches, so a user's accent colour and mascot stay identical across their messages
    // even when a later message arrives with a different colour tag.
    const userAccents = new Map<string, number>();
    const userMascotSeeds = new Map<string, number>();
    let messageSerial = 0;

    const cardWidth = (): number => {
      const screenW = stage.width;
      const maxWidth = Math.max(280, screenW - 24);
      return Math.round(Math.min(clamp(screenW * 0.39, 430, 690), maxWidth));
    };

    const left = (): number => (stage.width < 720 ? 12 : 30);

    const layoutCards = (): void => {
      let y = stage.height - 24;
      const x = left();
      for (const card of cards) {
        y -= card.height;
        card.setTarget(x, y);
        y -= cardGap;
      }
    };

    const userKey = (username: string): string => username.trim().toLowerCase() || "anonymous";

    const userAccent = (msg: ChatMessage, key: string, userSeed: number): number => {
      const existing = userAccents.get(key);
      if (existing !== undefined) return existing;
      const fallback = hslToRgb(userSeed % 360, 0.72, 0.6);
      const accent = colorFromString(msg.color, fallback);
      userAccents.set(key, accent);
      return accent;
    };

    const mascotSeed = (key: string): number => {
      const existing = userMascotSeeds.get(key);
      if (existing !== undefined) return existing;
      const seed = hashSeed(`fluid-mascot:${key}`);
      userMascotSeeds.set(key, seed);
      return seed;
    };

    // Every card gets a fresh plate seed, mixing per-message identity with real randomness, so
    // two consecutive messages from the same user still get differently-shaped, differently-mixed
    // blobs — only the accent colour and the mascot are stable per user.
    const nextPlateSeed = (msg: ChatMessage, key: string, userSeed: number): number => {
      messageSerial += 1;
      const randomBits = Math.floor(Math.random() * 0xffffffff);
      return hashSeed(
        ["fluid", key, userSeed, msg.event, msg.text, messageSerial, randomBits].join(":"),
      );
    };

    const burst = (card: ChatCard, palette: FluidPalette, seed: number): void => {
      const rng = seedRng(seed ^ 0x57e11a);
      const x = left() + 44 + rng() * 128;
      const y = card.view.y + 20 + rng() * Math.max(38, card.height - 26);
      const colors = [palette.skin, palette.skin2, palette.warm, palette.cool, palette.foam];

      for (let i = 0; i < burstCount; i++) {
        const speed = 1.0 + rng() * 2.7;
        const angle = -Math.PI * 0.9 + rng() * Math.PI * 1.0;
        const radius = 3 + rng() * 10;
        const color = colors[Math.floor(rng() * colors.length)] ?? palette.foam;
        const view = new PIXI.Graphics().circle(0, 0, radius).fill(rgba(color, 0.58));
        view.x = x;
        view.y = y;
        burstLayer.addChild(view);
        burstParticles.push({
          view,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 0,
          maxLife: 48 + rng() * 44,
          radius,
          color,
        });
      }
    };

    const spawn = (msg: ChatMessage, withSplash: boolean): void => {
      const key = userKey(msg.username);
      const userSeed = msg.seed;
      const accent = userAccent(msg, key, userSeed);
      const creatureSeed = mascotSeed(key);
      const plateSeed = nextPlateSeed(msg, key, userSeed);
      const palette = makePalette(plateSeed, accent);
      const card = new ChatCard(cardLayer, msg, cardWidth(), palette, userSeed, accent, creatureSeed, plateSeed, {
        lifetime: lifetimeSec * FRAME_UNITS_PER_SECOND,
        nameFontSize,
        textFontSize,
        showEmotes,
      });
      cards.unshift(card);

      while (cards.length > maxCards) {
        cards.pop()?.destroy();
      }

      layoutCards();
      if (withSplash) burst(card, palette, plateSeed);
    };

    // Seed the stack from history so the overlay is not empty at startup. No splash for backlog:
    // a wall of simultaneous splashes on load would read as a malfunction, not a greeting.
    for (const msg of chat.recent().slice(-maxCards)) spawn(msg, false);
    const off = chat.onMessage((msg) => spawn(msg, true));
    scope.defer(off);

    stage.onResize(() => layoutCards());

    const updateBurst = (delta: number): void => {
      for (let i = burstParticles.length - 1; i >= 0; i--) {
        const item = burstParticles[i];
        if (item === undefined) continue;
        item.life += delta;
        item.view.x += item.vx * delta;
        item.view.y += item.vy * delta;
        // Gentle gravity: droplets arc up and out, then fall.
        item.vy += 0.03 * delta;
        const life = clamp(1 - item.life / item.maxLife, 0, 1);
        item.view.alpha = life;
        item.view.scale.set(0.7 + (1 - life) * 1.15);
        if (item.life >= item.maxLife) {
          item.view.destroy();
          burstParticles.splice(i, 1);
        }
      }
    };

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      // See FRAME_UNITS_PER_SECOND above. Capped so a background tab's huge catch-up dt cannot
      // make cards teleport or skip their fade.
      const delta = Math.min(dt, 0.25) * FRAME_UNITS_PER_SECOND;
      const x = left();
      for (let i = cards.length - 1; i >= 0; i--) {
        const card = cards[i];
        if (card === undefined) continue;
        if (card.update(delta, x)) {
          card.destroy();
          cards.splice(i, 1);
          layoutCards();
        }
      }
      updateBurst(delta);
      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        lifetimeSec = num(p, "lifetime", 30, 5, 300);
        maxCards = int(p, "maxCards", 7, 1, 15);
        cardGap = num(p, "cardGap", 13, 0, 60);
        nameFontSize = int(p, "nameFontSize", 19, 10, 40);
        textFontSize = int(p, "textFontSize", 18, 10, 36);
        burstCount = int(p, "burstCount", 16, 0, 60);
        showEmotes = bool(p, "showEmotes", true);
        // Existing cards keep the settings they were built with (their text is already laid
        // out); the new values apply to trimming, spacing and every card from here on.
        while (cards.length > maxCards) cards.pop()?.destroy();
        layoutCards();
      },
    };
  },
});

export default fluidChat;
