import * as PIXI from "pixi.js";

import { bool, colorInt, int, num } from "../paramUtils";
import { createPixiStage, defineEffect, onFrame, useChat } from "../sdk";
import type { ChatEventKind, ChatImagePart, ChatMessage } from "~/types/contract";

/**
 * Hacker Chat Cards
 * =================
 *
 * A terminal-styled chat feed: each message becomes a green-on-black "packet" card that types
 * itself out character by character with a blinking block cursor, stacked bottom-up over a
 * Matrix-style background of falling glyph columns, a faint grid and scanlines. New cards land
 * with a burst of horizontal data sparks; emotes are shown as a strip of framed chips under the
 * typed text; every user gets a procedural 7×7 identicon avatar seeded from their name.
 *
 * Ported from `scenes/hacker-chat` in the old twitch-vizer repository. What changed in the port:
 *
 *  - The old scene opened its own WebSocket (`OverlayEventSocket`) and had a keyboard/space-bar
 *    preview. Both are replaced by the shared chat SDK (`useChat`): the backend feed when Twitch
 *    is configured, an automatic simulated feed otherwise.
 *  - The old per-scene constants (card lifetime, card cap, background column spacing, the fixed
 *    palette) are parameters now.
 *  - The background used to create one `PIXI.Text` per glyph with no upper bound, which on a 4K
 *    canvas meant thousands of text objects. The glyph count is now capped (a parameter), and the
 *    column spacing widens automatically when the cap would be exceeded.
 *  - Avatars: the old scene could load a Twitch profile image over the identicon. The new wire
 *    model carries no avatar URL, so only the procedural identicon fallback survives.
 *  - Emotes load their **static** image URL only — this build has no GIF plugin — and fall back
 *    to the emote's name as text when the image fails to load.
 */

/** The character pool the background columns and glyph flicker draw from. */
const MATRIX_CHARS = "01#$%&*+-/<>{}[]ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** The terminal font stack the whole effect renders with. */
const FONT =
  '"Courier New", "Lucida Console", "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", monospace';

/** Vertical gap between stacked cards, in pixels. */
const CARD_GAP = 10;

/**
 * The old scene animated in Pixi-ticker frame units (one unit ≈ one frame at 60 fps). All its
 * tuned constants — lifetimes, blink periods, easing windows — are in those units, so rather than
 * re-derive every one of them the port keeps them and converts the SDK's `dt` (seconds) into
 * frame units once per tick.
 */
const FRAME_UNITS_PER_SECOND = 60;

/* ------------------------------------------------------------------ */
/* Small helpers ported from the old shared/overlay.ts                 */
/* ------------------------------------------------------------------ */

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** A tiny deterministic random generator (linear congruential), so identicons and card jitter
 * come out identical for the same seed on every mount. */
function seedRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/** FNV-1a string hash, used wherever a stable number is needed for a name. */
function hashSeed(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Parses "#rrggbb" (the wire format of a user's chat colour) into a 24-bit int. */
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

/** Pixi v8 fill/stroke style shorthand, so a colour-with-alpha reads as one expression. */
function rgba(color: number, alpha: number): { color: number; alpha: number } {
  return { color, alpha };
}

/* ------------------------------------------------------------------ */
/* Chat message → terminal content                                     */
/* ------------------------------------------------------------------ */

/** The header/prompt tag for an event: "MSG" for chat, "GIFT-SUB" and friends for channel events. */
function eventLabel(event: ChatEventKind): string {
  return event === "chat" ? "MSG" : event.replace("_", "-").toUpperCase();
}

/** The body text for a message: the chat line itself, or a synthesised system line for channel
 * events ("cheered 500 bits"), matching the old scene's `formatEventText`. */
function messageText(msg: ChatMessage): string {
  if (msg.event === "chat") return msg.text.trim() || "...";
  if (msg.text.trim() !== "") return msg.text.trim();
  const data = msg.data;
  if (msg.event === "sub") {
    const months = typeof data["months"] === "number" ? data["months"] : 0;
    return months > 0 ? `subscribed for ${months} months` : "subscribed";
  }
  if (msg.event === "gift_sub") {
    const total = typeof data["total"] === "number" ? data["total"] : 1;
    return `gifted ${total} subscription${total === 1 ? "" : "s"}`;
  }
  if (msg.event === "cheer") {
    const bits = typeof data["bits"] === "number" ? data["bits"] : 0;
    return `cheered ${bits} bits`;
  }
  const viewers = typeof data["viewers"] === "number" ? data["viewers"] : 0;
  return `raided with ${viewers} viewers`;
}

/**
 * Splits a message into the text the card types out and the emotes shown in the strip below it.
 * The old scene did the same: emote images are pulled *out* of the reading order and gathered
 * into one strip, because inline images inside a typewriter animation would jump around.
 */
function terminalParts(msg: ChatMessage): { text: string; emotes: ChatImagePart[] } {
  const emotes: ChatImagePart[] = [];
  let rendered = "";
  for (const part of msg.parts) {
    if (part.type === "image") emotes.push(part);
    else rendered += part.text;
  }
  return { text: rendered.trim() || messageText(msg), emotes };
}

/* ------------------------------------------------------------------ */
/* Live-tunable configuration, shared by every card                    */
/* ------------------------------------------------------------------ */

/** Everything `setParams` can change while cards are alive. Cards read it every frame, so a
 * palette or lifetime change applies to cards already on screen, not only to the next one. */
interface Config {
  maxCards: number;
  lifetimeFrames: number;
  typeSpeed: number;
  fontSize: number;
  showEmotes: boolean;
  sparks: boolean;
  colorText: number;
  colorGlow: number;
  colorGlyph: number;
  density: number;
  maxGlyphs: number;
}

function readConfig(p: Record<string, unknown>): Config {
  return {
    maxCards: int(p, "maxCards", 8, 1, 16),
    lifetimeFrames: num(p, "lifetime", 32, 4, 180) * FRAME_UNITS_PER_SECOND,
    typeSpeed: num(p, "typeSpeed", 1, 0.2, 5),
    fontSize: int(p, "fontSize", 16, 10, 32),
    showEmotes: bool(p, "showEmotes", true),
    sparks: bool(p, "sparks", true),
    colorText: colorInt(p, "colorText", "#c8ffd1"),
    colorGlow: colorInt(p, "colorGlow", "#26ff63"),
    colorGlyph: colorInt(p, "colorGlyph", "#2eff70"),
    density: num(p, "density", 1, 0.1, 2),
    maxGlyphs: int(p, "maxGlyphs", 1200, 100, 5000),
  };
}

/* ------------------------------------------------------------------ */
/* The Matrix background                                               */
/* ------------------------------------------------------------------ */

interface MatrixColumn {
  x: number;
  y: number;
  speed: number;
  chars: string[];
  length: number;
  phase: number;
}

/**
 * Falling glyph columns over a faint grid, under scanlines. Rebuilt on resize and on parameter
 * changes; `update` only moves what `layout` built.
 */
class TerminalBackground {
  readonly view = new PIXI.Container();
  private readonly scanlines = new PIXI.Graphics();
  private readonly grid = new PIXI.Graphics();
  private readonly glyphLayer = new PIXI.Container();
  private columns: MatrixColumn[] = [];
  private glyphs: PIXI.Text[] = [];
  private elapsed = 0;

  constructor(private readonly cfg: () => Config) {
    this.view.addChild(this.grid);
    this.view.addChild(this.glyphLayer);
    this.view.addChild(this.scanlines);
  }

  layout(width: number, height: number): void {
    const cfg = this.cfg();
    const rng = seedRng(0xdec0de);
    this.columns = [];
    this.glyphLayer.removeChildren().forEach((child) => child.destroy());
    this.glyphs = [];

    /*
     * The old scene used a fixed 22-pixel column gap and one Text object per glyph, unbounded —
     * a 4K canvas produced thousands of them. Here the gap scales with the density parameter,
     * and when the estimated glyph count would exceed the cap the gap is widened until it fits.
     * Widening (rather than truncating columns) keeps the fall pattern covering the full width.
     */
    let colGap = 22 / cfg.density;
    const averageColumnLength = 15.5; // midpoint of the 7..24 random column length below
    const estimated = Math.ceil((width + colGap) / colGap) * averageColumnLength;
    if (estimated > cfg.maxGlyphs) colGap *= estimated / cfg.maxGlyphs;

    const rows = Math.ceil(height / 16) + 8;
    for (let x = 0; x < width + colGap; x += colGap) {
      const length = 7 + Math.floor(rng() * 18);
      const chars = Array.from(
        { length: rows },
        () => MATRIX_CHARS[Math.floor(rng() * MATRIX_CHARS.length)] ?? "0",
      );
      this.columns.push({
        x,
        y: -rng() * height,
        speed: 0.35 + rng() * 1.25,
        chars,
        length,
        phase: rng() * 60,
      });
      for (let i = 0; i < length; i += 1) {
        const glyph = new PIXI.Text({
          text: chars[i % chars.length] ?? "0",
          style: {
            fontFamily: FONT,
            fontSize: 13,
            fontWeight: "900",
            fill: cfg.colorGlyph,
            letterSpacing: 0,
          },
        });
        glyph.alpha = 0.18;
        glyph.x = x;
        this.glyphLayer.addChild(glyph);
        this.glyphs.push(glyph);
      }
    }

    this.drawStatic(width, height);
  }

  update(delta: number, width: number, height: number): void {
    this.elapsed += delta;
    let glyphIndex = 0;
    for (const column of this.columns) {
      column.y += column.speed * delta;
      if (column.y > height + column.length * 18) {
        column.y = -column.length * 18;
      }

      for (let i = 0; i < column.length; i += 1) {
        const glyph = this.glyphs[glyphIndex];
        glyphIndex += 1;
        if (glyph === undefined) continue;
        const y = column.y - i * 16;
        glyph.x = column.x + Math.sin((this.elapsed + column.phase + i) * 0.04) * 2;
        glyph.y = y;
        glyph.alpha = clamp(0.07 + (1 - i / column.length) * 0.24, 0.04, 0.34);
        // Occasionally swap a glyph's character, so the columns shimmer instead of scrolling a
        // frozen string. The modulo keeps it cheap: only a sliver of glyphs change per frame.
        if (Math.floor(this.elapsed + column.phase + i * 3) % 40 === 0) {
          glyph.text = MATRIX_CHARS[Math.floor(Math.random() * MATRIX_CHARS.length)] ?? "0";
        }
      }
    }

    this.scanlines.alpha = 0.48 + Math.sin(this.elapsed * 0.1) * 0.08;
    this.grid.alpha = 0.22 + Math.sin(this.elapsed * 0.033) * 0.05;
    this.view.visible = width > 0 && height > 0;
  }

  private drawStatic(width: number, height: number): void {
    const glyph = this.cfg().colorGlyph;
    this.grid.clear();
    this.scanlines.clear();

    this.grid.rect(0, 0, width, height).fill(rgba(0x001207, 0.1));
    for (let x = 0; x < width; x += 48) {
      this.grid.rect(x, 0, 1, height).fill(rgba(glyph, 0.08));
    }
    for (let y = 0; y < height; y += 48) {
      this.grid.rect(0, y, width, 1).fill(rgba(glyph, 0.06));
    }

    for (let y = 0; y < height; y += 4) {
      this.scanlines.rect(0, y, width, 1).fill(rgba(0x001607, 0.42));
    }
    this.scanlines.rect(0, 0, width, 14).fill(rgba(0x8cff9d, 0.05));
  }
}

/* ------------------------------------------------------------------ */
/* One message card                                                    */
/* ------------------------------------------------------------------ */

/**
 * One terminal window per message: a `user@twitch:~/msg` header, a fake `recv` command line, the
 * message body typed out at a per-card speed, a blinking block cursor, an emote strip that fades
 * in as the typing nears its end, a pulsing frame with random noise streaks, and an identicon.
 */
class HackerCard {
  readonly view = new PIXI.Container();
  readonly height: number;
  private readonly frame = new PIXI.Graphics();
  private readonly typedText: PIXI.Text;
  private readonly emoteLayer = new PIXI.Container();
  private readonly cursor = new PIXI.Graphics();
  private readonly noise = new PIXI.Graphics();
  private readonly code: string;
  private readonly emoteCount: number;
  private readonly lifetime: number;
  private readonly userAccent: number;
  private age = 0;
  private targetY = 0;
  private positioned = false;
  private visibleChars = 0;
  private readonly charRate: number;
  private readonly width: number;
  private readonly seed: number;

  constructor(
    private readonly cfg: () => Config,
    texture: PIXI.Texture,
    msg: ChatMessage,
    width: number,
    userSeed: number,
    userAccent: number,
    cardSeed: number,
  ) {
    const config = cfg();
    this.width = width;
    this.seed = cardSeed;
    this.userAccent = userAccent;
    this.lifetime = config.lifetimeFrames;
    // Each card types at a slightly different speed (seeded), so simultaneous cards desync.
    this.charRate = (1.35 + (cardSeed % 100) / 120) * config.typeSpeed;
    const content = terminalParts(msg);
    const label = eventLabel(msg.event);
    const channel = ["stdin", "socket", "relay", "node", "daemon"][cardSeed % 5] ?? "stdin";
    this.code = `> recv --${channel} /${label.toLowerCase()}\n${content.text}`;
    const emotes = config.showEmotes ? content.emotes : [];
    this.emoteCount = emotes.length;
    this.view.label = `hacker-chat-cards:${msg.username}`;
    this.view.alpha = 0;

    const wrap = Math.max(210, width - 126);
    // A throwaway fully-typed Text measures the final body height, so the card is sized for the
    // complete message from the start instead of growing while it types.
    const fullText = new PIXI.Text({ text: this.code, style: this.messageStyle(wrap) });
    const emoteHeight =
      emotes.length > 0
        ? 34 * Math.ceil(emotes.length / Math.max(1, Math.floor(wrap / 34))) + 8
        : 0;
    this.height = Math.max(98, Math.ceil(fullText.height + 65 + emoteHeight));
    this.emoteLayer.x = 18;
    this.emoteLayer.y = 44 + fullText.height + 7;
    this.emoteLayer.alpha = 0;
    this.makeEmoteStrip(emotes, wrap);
    fullText.destroy();

    const header = this.makeHeader(msg, label, width);
    const avatar = this.makeAvatar(texture, userSeed, userAccent);
    this.typedText = new PIXI.Text({ text: "", style: this.messageStyle(wrap) });
    this.typedText.x = 18;
    this.typedText.y = 44;

    avatar.x = width - 48;
    avatar.y = 18;
    header.x = 18;
    header.y = 16;

    this.view.addChild(this.frame);
    this.view.addChild(this.noise);
    this.view.addChild(header);
    this.view.addChild(this.typedText);
    this.view.addChild(this.emoteLayer);
    this.view.addChild(this.cursor);
    this.view.addChild(avatar);
    this.drawFrame(0);
  }

  setTarget(x: number, y: number): void {
    this.targetY = y;
    this.view.x = x;
    if (!this.positioned) {
      // First placement starts a little low and small; `update` eases it into place.
      this.view.y = y + 24;
      this.view.scale.set(0.98);
      this.positioned = true;
    }
  }

  /** Advances the card one tick. Returns true when its lifetime is over and it should go. */
  update(delta: number, x: number): boolean {
    this.age += delta;
    const enter = clamp(this.age / 22, 0, 1);
    const leave = this.age > this.lifetime - 55 ? clamp((this.lifetime - this.age) / 55, 0, 1) : 1;
    const eased = 1 - Math.pow(1 - enter, 3);
    // While entering, the card judders sideways a few pixels — a CRT-sync wobble that settles.
    const jitter = (1 - enter) * Math.round(Math.sin(this.age * 3.7) * 5);

    this.visibleChars = Math.min(this.code.length, this.visibleChars + delta * this.charRate);
    this.typedText.text = this.code.slice(0, Math.floor(this.visibleChars));
    // The emote strip fades in over the last quarter of the typing, as if flushed after the text.
    const emoteReveal =
      this.emoteCount === 0
        ? 0
        : clamp(
            (this.visibleChars - this.code.length * 0.72) / Math.max(10, this.code.length * 0.22),
            0,
            1,
          );
    this.emoteLayer.alpha = emoteReveal;
    this.emoteLayer.scale.set(0.92 + emoteReveal * 0.08);

    this.view.x = x + jitter + Math.sin(this.age * 0.07 + this.seed) * 1.2;
    this.view.y += (this.targetY - this.view.y) * Math.min(1, 0.23 * delta);
    this.view.alpha = eased * leave;
    this.view.scale.set(0.98 + eased * 0.02 - (1 - leave) * 0.03);

    this.drawFrame(this.age);
    this.drawCursor();
    return this.age >= this.lifetime;
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }

  private messageStyle(wrap: number): Partial<PIXI.TextStyle> {
    const cfg = this.cfg();
    return {
      fontFamily: FONT,
      fontSize: cfg.fontSize,
      fontWeight: "900",
      fill: cfg.colorText,
      lineHeight: Math.round(cfg.fontSize * 1.44),
      letterSpacing: 0,
      wordWrap: true,
      wordWrapWidth: wrap,
      breakWords: true,
      stroke: { color: 0x001804, width: 3 },
      dropShadow: { color: cfg.colorGlow, alpha: 0.36, angle: 0, distance: 0, blur: 4 },
    };
  }

  private makeHeader(msg: ChatMessage, label: string, width: number): PIXI.Container {
    const view = new PIXI.Container();
    const terminalUser =
      (msg.username || "anonymous").trim().toLowerCase().replace(/\s+/g, "_") || "anonymous";
    const name = new PIXI.Text({
      text: `${terminalUser}@twitch:~/${label.toLowerCase()}`,
      style: { fontFamily: FONT, fontSize: 13, fontWeight: "900", fill: 0x77ff89 },
    });
    const tag = new PIXI.Text({
      text: `[${label}]`,
      style: { fontFamily: FONT, fontSize: 12, fontWeight: "900", fill: 0x2aff68 },
    });

    name.x = 0;
    name.y = 0;
    tag.x = Math.max(0, width - 164 - tag.width);
    tag.y = 0;
    view.addChild(name);
    view.addChild(tag);
    return view;
  }

  private makeEmoteStrip(emotes: ChatImagePart[], wrap: number): void {
    const chip = 28;
    const gap = 6;
    let x = 0;
    let y = 0;

    for (const emote of emotes) {
      if (x > 0 && x + chip > wrap) {
        x = 0;
        y += chip + gap;
      }

      const holder = new PIXI.Container();
      const frame = new PIXI.Graphics()
        .rect(0, 0, chip, chip)
        .fill(rgba(0x001804, 0.82))
        .rect(1, 1, chip - 2, chip - 2)
        .stroke({ color: 0x35ff6b, width: 1, alpha: 0.62 });
      holder.x = x;
      holder.y = y;
      holder.addChild(frame);
      this.loadEmoteImage(emote, holder, chip);
      this.emoteLayer.addChild(holder);
      x += chip + gap;
    }
  }

  /**
   * Loads the emote's static image (this build renders no animated GIF variant) and drops it into
   * its chip; on any failure the emote's name is drawn instead. Fire-and-forget: the card never
   * waits for the network, and a chip whose card has already been destroyed is left alone.
   */
  private loadEmoteImage(emote: ChatImagePart, holder: PIXI.Container, size: number): void {
    void (async (): Promise<void> => {
      try {
        const texture: PIXI.Texture = await PIXI.Assets.load(emote.url);
        if (holder.destroyed) return;
        const sprite = new PIXI.Sprite(texture);
        sprite.roundPixels = true;
        const scale = (size - 4) / Math.max(1, Math.max(texture.width, texture.height));
        sprite.scale.set(scale);
        sprite.x = 2 + (size - 4 - sprite.width) / 2;
        sprite.y = 2 + (size - 4 - sprite.height) / 2;
        holder.addChild(sprite);
      } catch {
        if (holder.destroyed) return;
        const fallback = new PIXI.Text({
          text: emote.name.slice(0, 2).toUpperCase(),
          style: {
            fontFamily: FONT,
            fontSize: 9,
            fontWeight: "900",
            fill: this.cfg().colorText,
          },
        });
        fallback.x = Math.round((size - fallback.width) / 2);
        fallback.y = Math.round((size - fallback.height) / 2);
        holder.addChild(fallback);
      }
    })();
  }

  /**
   * A 7×7 mirrored identicon built from tinted particles — the same procedural avatar the old
   * scene used as its fallback. The new wire model carries no avatar URL, so this is the avatar.
   */
  private makeAvatar(texture: PIXI.Texture, seed: number, userAccent: number): PIXI.Container {
    const view = new PIXI.Container();
    const mask = new PIXI.Graphics().circle(16, 16, 15).fill(0xffffff);
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
    const rng = seedRng(seed ^ 0x7091);
    const colors = [0x001804, 0x0bff51, 0x7eff99, userAccent, 0xd9ffe0];
    const particles: PIXI.Particle[] = [];
    fallback.x = 2;
    fallback.y = 2;
    fallback.mask = mask;
    for (let y = 0; y < 7; y += 1) {
      for (let x = 0; x < 7; x += 1) {
        // Mirroring the left half onto the right is what makes random dots read as a "face".
        const mirrorX = x > 3 ? 6 - x : x;
        const filled = rng() + mirrorX * 0.08 + y * 0.025 > 0.38;
        if (!filled) continue;
        particles.push(
          new PIXI.Particle({
            texture,
            x: x * 4,
            y: y * 4,
            scaleX: 4,
            scaleY: 4,
            tint: colors[Math.floor(rng() * colors.length)] ?? userAccent,
            alpha: 0.96,
          }),
        );
      }
    }
    fallback.addParticle(...particles);
    fallback.update();
    view.addChild(mask);
    view.addChild(fallback);
    view.addChild(
      new PIXI.Graphics()
        .circle(16, 16, 16)
        .stroke({ color: 0x001804, width: 5, alpha: 0.9 })
        .circle(16, 16, 13)
        .stroke({ color: mixColor(0x35ff6b, userAccent, 0.32), width: 3, alpha: 0.96 })
        .rect(3, 15, 26, 1)
        .fill(rgba(0xd3ffdb, 0.3)),
    );
    return view;
  }

  private drawFrame(time: number): void {
    const g = this.frame;
    const n = this.noise;
    const w = this.width;
    const h = this.height;
    const glow = mixColor(this.cfg().colorGlow, this.userAccent, 0.28);
    const pulse = 0.58 + Math.sin(time * 0.08 + this.seed) * 0.16;

    g.clear();
    g.rect(5, 5, w, h).fill(rgba(0x001104, 0.42));
    g.rect(0, 0, w, h).fill(rgba(0x000b03, 0.88));
    g.rect(2, 2, w - 4, h - 4).stroke({ color: glow, width: 2, alpha: pulse });
    g.rect(8, 8, w - 16, h - 16).stroke({ color: 0x0b6125, width: 1, alpha: 0.72 });
    g.rect(0, 0, 38, 3).fill(rgba(0xc4ffd0, 0.86));
    g.rect(44, 0, 74, 3).fill(rgba(glow, 0.64));
    g.rect(w - 92, h - 3, 88, 3).fill(rgba(glow, 0.58));
    g.rect(20, 39, w - 40, 1).fill(rgba(0x38ff6b, 0.36));
    // The bottom bar is a progress bar for the typewriter: full width means fully typed.
    g.rect(20, h - 14, Math.max(24, (w - 40) * clamp(this.visibleChars / this.code.length, 0, 1)), 2)
      .fill(rgba(0x9dffae, 0.62));

    // Random one-pixel streaks, reseeded every few frames — cheap static over the card body.
    n.clear();
    const rng = seedRng(this.seed ^ Math.floor(time * 13));
    for (let i = 0; i < 12; i += 1) {
      const y = Math.floor(rng() * h);
      const x = Math.floor(rng() * w);
      const len = 8 + rng() * 70;
      n.rect(x, y, len, 1).fill(rgba(i % 2 ? this.cfg().colorText : glow, 0.08 + rng() * 0.12));
    }
  }

  private drawCursor(): void {
    // Solid while typing, blinking once typed out — how a real terminal cursor behaves.
    const visible = Math.floor(this.age / 16) % 2 === 0 || this.visibleChars < this.code.length;
    const bounds = this.typedText.getLocalBounds();
    this.cursor.clear();
    if (!visible) return;

    // Pixi exposes no per-character positions, so the cursor's x is estimated from the last
    // line's length times an average monospace advance. Close enough for a chunky block cursor.
    const text = this.typedText.text;
    const lastLine = text.split("\n").pop() ?? "";
    const advance = this.cfg().fontSize * 0.5875;
    const estimatedX = this.typedText.x + Math.min(bounds.width, Math.max(0, lastLine.length * advance));
    const estimatedY = this.typedText.y + Math.max(0, this.typedText.height - 20);
    this.cursor.rect(estimatedX + 3, estimatedY + 2, 9, 16).fill(rgba(this.cfg().colorText, 0.82));
  }
}

/* ------------------------------------------------------------------ */
/* Data sparks                                                         */
/* ------------------------------------------------------------------ */

interface DataSpark {
  view: PIXI.Graphics;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
}

/** The 1×1 white texture the identicon particles are tinted from. */
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

/* ------------------------------------------------------------------ */
/* The effect                                                          */
/* ------------------------------------------------------------------ */

const hackerChatCards = defineEffect({
  descriptor: {
    id: "hacker-chat-cards",
    name: "Hacker Chat Cards",
    description:
      "Twitch chat as a stack of green terminal windows over a Matrix glyph rain: each message types itself out with a blinking cursor inside a pulsing card, with emote chips, identicon avatars and data-spark bursts.",
    engine: "pixi",
    category: "chat",
    tags: ["chat", "twitch", "terminal", "matrix", "hacker", "typewriter", "green"],
    previewNotes:
      "Needs chat to show anything: when Twitch is not configured (or unreachable) a simulated feed of canned messages appears automatically every few seconds, so previews always have cards to type. Transparent background — lay it over a scene. Emote images load from Twitch's CDN at runtime; a failed load draws the emote's name instead.",
    params: [
      {
        key: "maxCards",
        label: "Max Cards",
        kind: "number",
        default: 8,
        min: 1,
        max: 16,
        step: 1,
        description:
          "How many message cards can be on screen at once. The oldest card is removed when a new message would exceed this.",
      },
      {
        key: "lifetime",
        label: "Card Lifetime",
        kind: "number",
        default: 32,
        min: 4,
        max: 180,
        step: 1,
        description: "How long one card stays on screen before fading out, in seconds.",
      },
      {
        key: "typeSpeed",
        label: "Typing Speed",
        kind: "number",
        default: 1,
        min: 0.2,
        max: 5,
        step: 0.1,
        description:
          "Multiplier on how fast the typewriter reveals each message. 1 is roughly 80 characters per second; each card also varies a little on its own.",
      },
      {
        key: "fontSize",
        label: "Message Font Size",
        kind: "number",
        default: 16,
        min: 10,
        max: 32,
        step: 1,
        description: "Size of the typed message text, in pixels. Applies to newly spawned cards.",
      },
      {
        key: "density",
        label: "Background Density",
        kind: "number",
        default: 1,
        min: 0.1,
        max: 2,
        step: 0.05,
        description:
          "How tightly packed the falling glyph columns are. 1 matches the original scene; lower is sparser and cheaper to draw.",
      },
      {
        key: "maxGlyphs",
        label: "Background Glyph Cap",
        kind: "number",
        default: 1200,
        min: 100,
        max: 5000,
        step: 100,
        description:
          "Upper bound on how many background characters exist, whatever the canvas size or density asks for. Each one is a text object, so this caps the effect's draw cost; when the cap bites, the columns spread out instead of disappearing.",
      },
      {
        key: "showEmotes",
        label: "Show Emotes",
        kind: "boolean",
        default: true,
        description:
          "Whether cards show a strip of emote images under the message. Off means emote-only messages still show their text form.",
      },
      {
        key: "sparks",
        label: "Data Sparks",
        kind: "boolean",
        default: true,
        description: "Whether a new card fires a small burst of flying dash particles.",
      },
      {
        key: "colorText",
        label: "Text Colour",
        kind: "color",
        default: "#c8ffd1",
        description: "The typed message text and the cursor. Pale green in the original.",
      },
      {
        key: "colorGlow",
        label: "Glow Colour",
        kind: "color",
        default: "#26ff63",
        description:
          "The card frames' pulsing border and the text's glow, blended toward each user's own chat colour.",
      },
      {
        key: "colorGlyph",
        label: "Glyph Colour",
        kind: "color",
        default: "#2eff70",
        description: "The falling background characters and the faint grid lines.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    const stage = await createPixiStage(scope, ctx, { antialias: false });

    let config = readConfig(ctx.params);
    const cfg = (): Config => config;

    const pixelTexture = makePixelTexture(stage.app);
    scope.defer(() => pixelTexture.destroy(true));

    const background = new TerminalBackground(cfg);
    const sparkLayer = new PIXI.Container();
    stage.stage.addChild(background.view);
    stage.stage.addChild(sparkLayer);
    background.layout(stage.width, stage.height);

    const cards: HackerCard[] = [];
    const sparks: DataSpark[] = [];
    const userAccents = new Map<string, number>();
    let messageSerial = 0;

    const left = (): number => (stage.width < 720 ? 12 : 30);

    const cardWidth = (): number => {
      const maxWidth = Math.max(300, stage.width - 24);
      return Math.round(Math.min(clamp(stage.width * 0.4, 430, 680), maxWidth));
    };

    const layoutCards = (): void => {
      let y = stage.height - 24;
      const x = left();
      for (const card of cards) {
        y -= card.height;
        card.setTarget(x, y);
        y -= CARD_GAP;
      }
    };

    /** The per-user accent colour: their chat colour pulled toward the terminal green, cached so
     * one user's cards always match each other. */
    const userAccent = (msg: ChatMessage, userKey: string, userSeed: number): number => {
      const existing = userAccents.get(userKey);
      if (existing !== undefined) return existing;
      const fallbackColor = hslToRgb(118 + (userSeed % 42), 0.92, 0.55);
      const raw = colorFromString(msg.color, fallbackColor);
      const accent = mixColor(raw, config.colorGlow, 0.62);
      userAccents.set(userKey, accent);
      return accent;
    };

    const spawnSparks = (card: HackerCard, accent: number, seed: number): void => {
      if (!config.sparks) return;
      const rng = seedRng(seed ^ 0x5a5a);
      const x = left() + 18 + rng() * 120;
      const y = card.view.y + 16 + rng() * Math.max(30, card.height - 28);
      for (let i = 0; i < 20; i += 1) {
        const view = new PIXI.Graphics()
          .rect(0, 0, 3 + rng() * 16, 2)
          .fill(rgba(i % 2 ? config.colorText : accent, 0.78));
        // Mostly-upward fan: the burst reads as data escaping the card, not an explosion.
        const angle = -Math.PI * 0.86 + rng() * Math.PI * 1.05;
        const speed = 1.2 + rng() * 3.4;
        view.x = x;
        view.y = y;
        sparkLayer.addChild(view);
        sparks.push({
          view,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 0,
          maxLife: 28 + rng() * 34,
        });
      }
    };

    const spawn = (msg: ChatMessage): void => {
      const userKey = msg.username.trim().toLowerCase() || "anonymous";
      const userSeed = msg.seed || hashSeed(userKey);
      const accent = userAccent(msg, userKey, userSeed);
      messageSerial += 1;
      // Every card gets its own seed even for identical messages, so noise/jitter never sync up.
      const cardSeed = hashSeed(
        ["hacker", userKey, userSeed, msg.event, msg.text, messageSerial, Math.random()].join(":"),
      );
      const card = new HackerCard(cfg, pixelTexture, msg, cardWidth(), userSeed, accent, cardSeed);
      stage.stage.addChild(card.view);
      cards.unshift(card);

      while (cards.length > config.maxCards) {
        cards.pop()?.destroy();
      }

      layoutCards();
      spawnSparks(card, accent, cardSeed);
    };

    const updateSparks = (delta: number): void => {
      for (let i = sparks.length - 1; i >= 0; i -= 1) {
        const spark = sparks[i];
        if (spark === undefined) continue;
        spark.life += delta;
        spark.view.x += spark.vx * delta;
        spark.view.y += spark.vy * delta;
        spark.vy += 0.018 * delta;
        spark.view.alpha = clamp(1 - spark.life / spark.maxLife, 0, 1);
        if (spark.life >= spark.maxLife) {
          spark.view.destroy();
          sparks.splice(i, 1);
        }
      }
    };

    const chat = await useChat(scope);
    scope.checkpoint();
    // Seed the stack from history, oldest first — `spawn` unshifts, so the newest ends on top.
    for (const message of chat.recent().slice(-config.maxCards)) spawn(message);
    const off = chat.onMessage((message) => spawn(message));
    scope.defer(off);

    stage.onResize((w, h) => {
      background.layout(w, h);
      layoutCards();
    });

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      const delta = dt * FRAME_UNITS_PER_SECOND;
      background.update(delta, stage.width, stage.height);

      const x = left();
      for (let i = cards.length - 1; i >= 0; i -= 1) {
        const card = cards[i];
        if (card === undefined) continue;
        if (card.update(delta, x)) {
          card.destroy();
          cards.splice(i, 1);
          layoutCards();
        }
      }
      updateSparks(delta);

      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        const previous = config;
        config = readConfig(p);
        // The background bakes its colour and spacing into its Text objects, so those three
        // parameters need a rebuild; everything else the cards read live from `cfg()`.
        if (
          config.density !== previous.density ||
          config.maxGlyphs !== previous.maxGlyphs ||
          config.colorGlyph !== previous.colorGlyph
        ) {
          background.layout(stage.width, stage.height);
        }
        while (cards.length > config.maxCards) {
          cards.pop()?.destroy();
        }
        layoutCards();
      },
    };
  },
});

export default hackerChatCards;
