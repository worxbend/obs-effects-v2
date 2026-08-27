import * as PIXI from "pixi.js";

import { int, num } from "../paramUtils";
import { createPixiStage, defineEffect, onFrame, useChat, type ChatBus } from "../sdk";
import type { ChatMessage } from "~/types/contract";

/**
 * Emoji Chat
 * ==========
 *
 * Chat messages float up from the bottom of the frame as hand-drawn sticker pills: a wobbly
 * yellow speech bubble, a cartoon face on the left whose expression matches the *mood* of the
 * message, the message text beside it, and a small badge with the sender's name. Angry messages
 * turn the pill red, sad ones orange. The faces are animated — they blink, bob, shed tears and
 * throw hearts — and each pill drifts and wobbles on its own seeded rhythm before fading out.
 *
 * Ported from `scenes/emoji-chat` in the twitch-vizer project. What changed in the port:
 *
 *  - **The machine-learning sentiment path is gone.** The original could lazily download an ONNX
 *    sentiment model through transformers.js and reclassify a message after the fact. That pulled
 *    in a multi-megabyte dependency for a marginal win over its own fallback, so this port keeps
 *    only the fallback: the emoji fast path (an 😭 in the message settles it immediately) and the
 *    keyword dictionary (English + Ukrainian). No new dependencies were added. All 22 face
 *    expressions survive — the dictionary and emoji rules reach every one the classifier could.
 *  - The bespoke `OverlayEventSocket` became `useChat` from the effect SDK, which also replaces
 *    the old "press N for a fake message" keyboard preview: when Twitch is not configured the SDK
 *    feeds simulated messages on its own.
 *  - Twitch emotes and Twemoji images are drawn as their *names* ("Kappa", "🎉") inside the text,
 *    exactly as the original did — this effect renders one text label per pill, so it never loads
 *    emote images at all (and therefore has no animated-GIF concern).
 *  - The per-scene constants (lifetime, card count, spacing, font size) became parameters.
 */

/* ------------------------------------------------------------------ */
/* Sentiment: expression names, tone rules, and the two classifiers    */
/* ------------------------------------------------------------------ */

/** The 22 cartoon faces this effect knows how to draw. */
type Expression =
  | "happy"
  | "sad"
  | "kiss"
  | "cry"
  | "surprised"
  | "neutral"
  | "sleepy"
  | "awkward"
  | "laugh"
  | "wink"
  | "angry"
  | "relieved"
  | "cool"
  | "lovely"
  | "yikes"
  | "dead"
  | "unimpressed"
  | "grin"
  | "night"
  | "star"
  | "scared"
  | "down";

/** The emotion categories the rules speak in (the GoEmotions label set the original used). */
type Tone =
  | "amusement"
  | "caring"
  | "confusion"
  | "curiosity"
  | "desire"
  | "joy"
  | "love"
  | "optimism"
  | "pride"
  | "realization"
  | "relief"
  | "sadness"
  | "disappointment"
  | "disapproval"
  | "embarrassment"
  | "excitement"
  | "gratitude"
  | "grief"
  | "remorse"
  | "anger"
  | "fear"
  | "nervousness"
  | "surprise"
  | "neutral"
  | "approval"
  | "admiration"
  | "annoyance"
  | "disgust";

interface ToneResult {
  tone: Tone;
  expression: Expression;
  confidence: number;
  method: "emoji" | "dictionary";
}

/** Which face each emotion maps to. Several emotions share a face on purpose — there are more
 * nameable emotions than distinguishable cartoon expressions. */
const TONE_TO_EXPRESSION: Record<string, Expression> = {
  joy: "happy",
  amusement: "laugh",
  approval: "happy",
  admiration: "happy",
  gratitude: "happy",
  excitement: "star",
  optimism: "happy",
  pride: "happy",
  relief: "relieved",
  love: "lovely",
  caring: "lovely",
  desire: "star",
  sadness: "sad",
  disappointment: "sad",
  disapproval: "unimpressed",
  grief: "cry",
  remorse: "awkward",
  embarrassment: "awkward",
  anger: "angry",
  annoyance: "angry",
  disgust: "unimpressed",
  fear: "scared",
  nervousness: "scared",
  surprise: "surprised",
  confusion: "surprised",
  curiosity: "surprised",
  realization: "surprised",
  neutral: "neutral",
};

interface ToneRule {
  tone: Tone;
  expression?: Expression;
  confidence: number;
  terms: string[];
}

/** The fast path: a recognised emoji anywhere in the message settles the mood immediately. Rules
 * are ordered strongest-signal-first, so 😂 wins over a 👍 later in the same message. */
const EMOJI_RULES: ToneRule[] = [
  { tone: "amusement", expression: "laugh", confidence: 0.98, terms: ["😂", "🤣", "😆", "😹", "😝", "😜"] },
  { tone: "love", expression: "lovely", confidence: 0.98, terms: ["😍", "😘", "🥰", "😻", "❤️", "❤", "🫶", "🧡", "💛", "💚", "💙", "💜", "🤍", "🖤", "💖", "💕", "💗", "💓", "💞", "💘"] },
  { tone: "anger", expression: "angry", confidence: 0.98, terms: ["😡", "😠", "🤬", "😤", "💢", "👿"] },
  { tone: "sadness", expression: "cry", confidence: 0.98, terms: ["😭", "😢", "🥲", "😿"] },
  { tone: "sadness", expression: "sad", confidence: 0.96, terms: ["☹️", "☹", "🙁", "😞", "😔", "😟", "🥺", "😕", "😣", "😖", "😫", "😩", "💔"] },
  { tone: "fear", expression: "scared", confidence: 0.96, terms: ["😱", "😨", "😰", "😥", "😓", "🫣"] },
  { tone: "surprise", expression: "surprised", confidence: 0.96, terms: ["😮", "😯", "😲", "🤯", "😳", "🙀", "🫢", "👀"] },
  { tone: "disgust", expression: "unimpressed", confidence: 0.95, terms: ["🤢", "🤮", "😒", "🙄", "😑", "😐", "🫤", "👎"] },
  { tone: "joy", expression: "cool", confidence: 0.94, terms: ["😎", "🤙"] },
  { tone: "neutral", expression: "sleepy", confidence: 0.94, terms: ["😴", "🥱", "💤"] },
  { tone: "joy", expression: "wink", confidence: 0.94, terms: ["😉"] },
  { tone: "joy", expression: "happy", confidence: 0.93, terms: ["😀", "😃", "😄", "😁", "😊", "🙂", "☺️", "☺", "🤗", "😺", "😸", "👍", "👌"] },
  { tone: "excitement", expression: "star", confidence: 0.93, terms: ["🤩", "🥳", "🎉", "✨", "⭐", "🌟", "🔥"] },
  { tone: "embarrassment", expression: "awkward", confidence: 0.91, terms: ["😅", "😬", "🙃"] },
];

/** The keyword dictionary, English and Ukrainian. Single words match whole tokens only ("mad"
 * does not fire inside "nomad"); terms with spaces or apostrophes match as substrings. */
const DICTIONARY_RULES: ToneRule[] = [
  {
    tone: "anger",
    expression: "angry",
    confidence: 0.88,
    terms: ["mad", "angry", "rage", "furious", "hate", "annoyed", "pissed", "wtf", "terrible", "awful", "stupid", "idiot", "trash", "злий", "зла", "злюсь", "злюся", "злість", "лють", "лютий", "люта", "бісить", "дратує", "дратуюсь", "дратуюся", "ненавиджу", "задовбало", "задовбав", "дістало", "розлючений", "розлючена", "скажений", "скажена"],
  },
  {
    tone: "sadness",
    expression: "sad",
    confidence: 0.86,
    terms: ["sad", "miss", "down", "lonely", "sorry", "bad", "hurt", "depressed", "upset", "sorrow", "heartbroken", "unhappy", "miserable", "сумно", "сумний", "сумна", "сумую", "скучив", "скучила", "скучаю", "погано", "боляче", "самотньо", "журба", "прикро", "невесело", "депресія", "депресивно", "розбитий", "розбита"],
  },
  {
    tone: "grief",
    expression: "cry",
    confidence: 0.88,
    terms: ["cry", "crying", "tears", "sob", "weeping", "плачу", "плакати", "сльози", "сльоза", "ридаю", "ридати", "плак", "заплакав", "заплакала"],
  },
  {
    tone: "fear",
    expression: "scared",
    confidence: 0.84,
    terms: ["scared", "afraid", "fear", "yikes", "terrified", "panic", "nervous", "worried", "anxious", "oh no", "страшно", "боюсь", "боюся", "боїшся", "лячно", "жах", "жахливо", "паніка", "панікую", "тривожно", "тривога", "переживаю", "моторошно"],
  },
  {
    tone: "surprise",
    expression: "surprised",
    confidence: 0.83,
    terms: ["wow", "whoa", "really", "omg", "surprise", "shocked", "unexpected", "can't believe", "no way", "ого", "вау", "нічого собі", "серйозно", "шок", "шокований", "шокована", "не вірю", "офігів", "офігіла", "капец", "неочікувано"],
  },
  {
    tone: "amusement",
    expression: "laugh",
    confidence: 0.87,
    terms: ["haha", "ahah", "hehe", "lol", "lmao", "rofl", "hilarious", "funny", "joke", "смішно", "ахаха", "хаха", "хехе", "ор", "ору", "ржу", "угар", "жиза", "сміх", "сміюсь", "сміюся"],
  },
  {
    tone: "joy",
    expression: "happy",
    confidence: 0.84,
    terms: ["happy", "awesome", "great", "nice", "good", "hello", "yay", "glad", "wonderful", "perfect", "радість", "радію", "щасливий", "щаслива", "клас", "супер", "топ", "добре", "гарно", "чудово", "прекрасно", "привіт", "ура", "кайф"],
  },
  {
    tone: "love",
    expression: "lovely",
    confidence: 0.88,
    terms: ["love", "lovely", "cute", "sweet", "adorable", "beautiful", "люблю", "кохаю", "милий", "мила", "милота", "серденько", "серце", "обіймаю", "обійми", "гарнюня"],
  },
  {
    tone: "approval",
    expression: "happy",
    confidence: 0.78,
    terms: ["yes", "ok", "okay", "sure", "got it", "thanks", "thank you", "agree", "yep", "так", "ок", "окей", "гаразд", "дякую", "спасибі", "згоден", "згодна", "домовились", "підтримую", "плюсую"],
  },
  {
    tone: "disgust",
    expression: "unimpressed",
    confidence: 0.82,
    terms: ["disgust", "gross", "cringe", "meh", "boring", "not impressed", "ew", "фу", "бридко", "гидко", "крінж", "нудно", "байдуже", "таке собі", "мерзенно", "не вражає"],
  },
  {
    tone: "neutral",
    expression: "sleepy",
    confidence: 0.8,
    terms: ["sleep", "sleepy", "tired", "exhausted", "good night", "night", "спати", "сон", "сплю", "добраніч", "ніч", "втомився", "втомилась", "втома", "сонний", "сонна", "виснажений", "виснажена"],
  },
  {
    tone: "joy",
    expression: "cool",
    confidence: 0.8,
    terms: ["cool", "chill", "swag", "based", "круто", "чил", "чилю", "стильно", "імба"],
  },
  {
    tone: "amusement",
    expression: "wink",
    confidence: 0.78,
    terms: ["kidding", "joke", "just kidding", "jk", "teasing", "жарт", "жартую", "прикол", "рофл", "пожартував", "пожартувала"],
  },
  {
    tone: "embarrassment",
    expression: "awkward",
    confidence: 0.78,
    terms: ["oops", "my bad", "awkward", "embarrassing", "sorry", "вибач", "сорі", "перепрошую", "незручно", "ой", "моя помилка", "мій косяк"],
  },
];

function neutralTone(method: ToneResult["method"]): ToneResult {
  return { tone: "neutral", expression: "neutral", confidence: 0.56, method };
}

function emojiTone(text: string): ToneResult {
  for (const rule of EMOJI_RULES) {
    if (rule.terms.some((emoji) => text.includes(emoji))) {
      return {
        tone: rule.tone,
        expression: rule.expression ?? TONE_TO_EXPRESSION[rule.tone] ?? "neutral",
        confidence: rule.confidence,
        method: "emoji",
      };
    }
  }
  return neutralTone("emoji");
}

/** Lowercases with Ukrainian locale rules (so І → і, which plain `toLowerCase` also does, but the
 * locale form is explicit about the intent), normalises apostrophe variants, and tokenises. */
function normalizeDictionaryText(text: string): { lower: string; tokens: Set<string> } {
  const lower = text
    .toLocaleLowerCase("uk-UA")
    .replace(/[’`´]/g, "'")
    .replace(/ё/g, "е");
  const tokens = new Set(lower.split(/[^\p{L}\p{N}']+/u).filter(Boolean));
  return { lower, tokens };
}

function termMatches(term: string, lower: string, tokens: Set<string>): boolean {
  const normalized = term.toLocaleLowerCase("uk-UA");
  if (/[\s'-]/.test(normalized)) return lower.includes(normalized);
  return tokens.has(normalized);
}

function dictionaryTone(text: string): ToneResult {
  const { lower, tokens } = normalizeDictionaryText(text);
  for (const rule of DICTIONARY_RULES) {
    if (rule.terms.some((term) => termMatches(term, lower, tokens))) {
      return {
        tone: rule.tone,
        expression: rule.expression ?? TONE_TO_EXPRESSION[rule.tone] ?? "neutral",
        confidence: rule.confidence,
        method: "dictionary",
      };
    }
  }
  return neutralTone("dictionary");
}

/** Emoji first (they are near-certain signals), then the keyword dictionary. This was the
 * original's fallback classifier; in this port it is the only classifier. */
function localTone(text: string): ToneResult {
  const emoji = emojiTone(text);
  if (emoji.expression !== "neutral") return emoji;
  return dictionaryTone(text);
}

/* ------------------------------------------------------------------ */
/* Message → display text                                              */
/* ------------------------------------------------------------------ */

/** The system line for a channel event, mirroring the original's `formatEventText`. */
function eventText(msg: ChatMessage): string {
  if (msg.event === "sub") {
    const months = msg.data["months"];
    return typeof months === "number" && months > 0 ? `subscribed for ${months} months` : "subscribed";
  }
  if (msg.event === "gift_sub") {
    const raw = msg.data["total"];
    const total = typeof raw === "number" ? raw : 1;
    return `gifted ${total} subscription${total === 1 ? "" : "s"}`;
  }
  if (msg.event === "cheer") {
    const bits = msg.data["bits"];
    return `cheered ${typeof bits === "number" ? bits : 0} bits`;
  }
  if (msg.event === "raid") {
    const viewers = msg.data["viewers"];
    return `raided with ${typeof viewers === "number" ? viewers : 0} viewers`;
  }
  return msg.text.trim() || "...";
}

/** Flattens the message into one line for the pill: text parts as-is, image parts (emotes and
 * Twemoji-split emoji) as their name — an 🎉 image part contributes the literal "🎉", which is
 * also what the emoji classifier matches against. */
function visibleText(msg: ChatMessage): string {
  if (msg.event !== "chat") return eventText(msg);
  const joined = msg.parts
    .map((part) => (part.type === "text" ? part.text : part.name))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return joined || eventText(msg);
}

/* ------------------------------------------------------------------ */
/* Small drawing helpers                                               */
/* ------------------------------------------------------------------ */

const FONT = '"Trebuchet MS", "Avenir Next", "Segoe UI", sans-serif';
const INK = 0x1f1500;
const BROWN = 0x552400;
const TONGUE = 0xff5a78;
const BLUE = 0x39aef2;
const PINK = 0xff7d9d;
const YELLOW = 0xffd215;
const GOLD = 0xf7b700;
const LIGHT = 0xffea55;
const SAD_ORANGE = 0xffa631;
const SAD_EDGE = 0xf06024;
const SAD_LIGHT = 0xffcd63;
const ANGRY_RED = 0xff5a24;
const ANGRY_EDGE = 0xd9271c;
const ANGRY_LIGHT = 0xff8a35;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** FNV-1a, for turning a string into a stable 32-bit seed. */
function hashSeed(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** A tiny seeded random generator (a linear congruential generator), so a pill's wobbly outline
 * and drift are stable per message rather than reshuffling on every redraw. */
function seedRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = Math.imul(1664525, state) + 1013904223;
    return (state >>> 0) / 0x100000000;
  };
}

function rgba(color: number, alpha: number): { color: number; alpha: number } {
  return { color, alpha };
}

/**
 * Draws the pill shape with a hand-drawn feel: a rounded capsule whose top, bottom and sides are
 * each nudged a few seeded pixels off true, so no two stickers share exactly the same outline.
 */
function drawSoftPill(
  g: PIXI.Graphics,
  x: number,
  y: number,
  width: number,
  height: number,
  fill: number | { color: number; alpha: number },
  seed: number,
): void {
  const rng = seedRng(seed);
  const r = height / 2;
  const topLift = (rng() - 0.5) * 3.5;
  const bottomLift = (rng() - 0.5) * 4.5;
  const leftBump = (rng() - 0.5) * 4;
  const rightBump = (rng() - 0.5) * 4;
  // The magic constant that makes four cubic Béziers approximate a circle's quadrant.
  const c = 0.5522847498;

  g.moveTo(x + r * 0.98, y + topLift);
  g.bezierCurveTo(x + width * 0.32, y - 2 + topLift, x + width * 0.68, y + 2 - topLift, x + width - r * 0.98, y + topLift * 0.6);
  g.bezierCurveTo(x + width - r + r * c + rightBump, y, x + width + rightBump, y + r - r * c, x + width + rightBump, y + r);
  g.bezierCurveTo(x + width + rightBump, y + r + r * c, x + width - r + r * c, y + height, x + width - r, y + height + bottomLift);
  g.bezierCurveTo(x + width * 0.66, y + height + 2 + bottomLift, x + width * 0.32, y + height - 2 - bottomLift, x + r, y + height + bottomLift * 0.7);
  g.bezierCurveTo(x + r - r * c + leftBump, y + height, x + leftBump, y + r + r * c, x + leftBump, y + r);
  g.bezierCurveTo(x + leftBump, y + r - r * c, x + r - r * c, y, x + r, y + topLift);
  g.closePath();
  g.fill(fill);
}

function smile(g: PIXI.Graphics, x: number, y: number, w: number, depth: number, color = BROWN, stroke = 4): void {
  g.moveTo(x, y);
  g.quadraticCurveTo(x + w / 2, y + depth, x + w, y);
  g.stroke({ color, width: stroke, cap: "round" });
}

function frown(g: PIXI.Graphics, x: number, y: number, w: number, depth: number, color = BROWN, stroke = 4): void {
  g.moveTo(x, y);
  g.quadraticCurveTo(x + w / 2, y - depth, x + w, y);
  g.stroke({ color, width: stroke, cap: "round" });
}

function closedEye(g: PIXI.Graphics, x: number, y: number, flip = 1): void {
  g.moveTo(x - 8, y);
  g.quadraticCurveTo(x, y - 8 * flip, x + 8, y);
  g.stroke({ color: BROWN, width: 4, cap: "round" });
}

function xEye(g: PIXI.Graphics, x: number, y: number): void {
  g.moveTo(x - 7, y - 7).lineTo(x + 7, y + 7).stroke({ color: BROWN, width: 4, cap: "round" });
  g.moveTo(x + 7, y - 7).lineTo(x - 7, y + 7).stroke({ color: BROWN, width: 4, cap: "round" });
}

function tear(g: PIXI.Graphics, x: number, y: number, size = 12): void {
  g.moveTo(x, y - size);
  g.bezierCurveTo(x + size * 0.65, y - size * 0.1, x + size * 0.55, y + size * 0.75, x, y + size);
  g.bezierCurveTo(x - size * 0.55, y + size * 0.75, x - size * 0.65, y - size * 0.1, x, y - size);
  g.closePath();
  g.fill(BLUE);
  g.circle(x - size * 0.22, y - size * 0.1, size * 0.18).fill(rgba(0xffffff, 0.58));
}

function heart(g: PIXI.Graphics, x: number, y: number, size = 9, color = 0xf23a52): void {
  g.circle(x - size * 0.34, y - size * 0.18, size * 0.42).fill(color);
  g.circle(x + size * 0.34, y - size * 0.18, size * 0.42).fill(color);
  g.moveTo(x - size * 0.82, y - size * 0.08);
  g.lineTo(x + size * 0.82, y - size * 0.08);
  g.lineTo(x, y + size);
  g.closePath();
  g.fill(color);
}

/**
 * The bottom half of an ellipse — the open-mouth shape. Pixi v8's `Graphics.ellipse` only draws
 * full ellipses (the old rotation/arc arguments are gone), so this draws the half as one cubic
 * Bézier: from the left tip to the right tip, with both control points 4/3 of the half-height
 * below the baseline, which traces a half-ellipse exactly.
 */
function halfEllipseDown(
  g: PIXI.Graphics,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  color: number,
): void {
  const k = (4 / 3) * ry;
  g.moveTo(cx - rx, cy);
  g.bezierCurveTo(cx - rx, cy + k, cx + rx, cy + k, cx + rx, cy);
  g.closePath();
  g.fill(color);
}

function star(g: PIXI.Graphics, x: number, y: number, r: number): void {
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const radius = i % 2 === 0 ? r : r * 0.48;
    const px = x + Math.cos(a) * radius;
    const py = y + Math.sin(a) * radius;
    if (i === 0) g.moveTo(px, py);
    else g.lineTo(px, py);
  }
  g.closePath();
  g.fill(0xfff7b5);
}

/* ------------------------------------------------------------------ */
/* The sticker pill                                                    */
/* ------------------------------------------------------------------ */

/** The live-tunable numbers, shared by reference so `setParams` reaches existing pills too. */
interface Settings {
  /** Sticker lifetime in ticks (60ths of a second, the original's frame unit). */
  lifetime: number;
  maxCards: number;
  cardGap: number;
  bottomMargin: number;
  driftRange: number;
}

interface StickerData {
  text: string;
  expression: Expression;
  sender?: string;
}

class EmojiStickerChip {
  readonly view = new PIXI.Container();
  readonly width: number;
  readonly height: number;
  readonly layoutSeed: number;
  private readonly seed: number;
  private readonly body = new PIXI.Graphics();
  private readonly shine = new PIXI.Graphics();
  private readonly face = new PIXI.Graphics();
  private readonly senderBadge = new PIXI.Graphics();
  private readonly shadow = new PIXI.Graphics();
  private readonly label: PIXI.Text;
  private readonly senderLabel: PIXI.Text;
  private age = 0;
  private faceTime = 0;
  private baseX = 0;
  private baseY = 0;
  private targetX = 0;
  private targetY = 0;
  private positioned = false;

  constructor(
    private readonly data: StickerData,
    seed: number,
    fontSize: number,
    private readonly settings: Settings,
  ) {
    this.seed = seed;
    this.layoutSeed = seed;
    this.height = 64;
    const faceWidth = 74;
    this.label = new PIXI.Text({
      text: data.text,
      style: {
        fontFamily: FONT,
        fontSize,
        fontWeight: "900",
        fill: INK,
        letterSpacing: 0,
      },
    });
    // A very long message is squeezed horizontally rather than wrapped: one-line pills are the
    // look, and a squashed line still reads at overlay sizes.
    const maxLabelWidth = 420;
    if (this.label.width > maxLabelWidth) this.label.scale.x = maxLabelWidth / this.label.width;
    this.label.x = faceWidth + 12;
    this.label.y = Math.round((this.height - this.label.height) / 2) - 1;
    this.width = Math.ceil(clamp(faceWidth + 28 + this.label.width, 156, 540));
    this.senderLabel = new PIXI.Text({
      text: this.senderText(),
      style: {
        fontFamily: FONT,
        fontSize: 12,
        fontWeight: "900",
        fill: 0x5a3700,
        letterSpacing: 0,
      },
    });
    this.view.alpha = 0;
    this.view.scale.set(0.96);
    this.view.addChild(this.shadow, this.body, this.shine, this.face, this.label, this.senderBadge, this.senderLabel);
    this.redraw();
  }

  /** Where the layout wants this pill. The first call also places it 20px below its slot, so the
   * enter animation floats it up into position. */
  setTarget(x: number, y: number): void {
    this.targetX = x;
    this.targetY = y;
    if (!this.positioned) {
      this.baseX = x;
      this.baseY = y + 20;
      this.view.x = this.baseX;
      this.view.y = this.baseY;
      this.positioned = true;
    }
  }

  /** Advances the animation by `delta` ticks. Returns true once the pill has expired. */
  update(delta: number): boolean {
    this.age += delta;
    this.faceTime += delta;
    const lifetime = this.settings.lifetime;
    const enter = clamp(this.age / 22, 0, 1);
    const leave = this.age > lifetime - 54 ? clamp((lifetime - this.age) / 54, 0, 1) : 1;
    const ease = 1 - Math.pow(1 - enter, 3);
    const wobble = Math.sin(this.age * 0.035 + this.seed) * 1.8;
    const float = Math.sin(this.age * 0.027 + this.seed * 0.33) * 3.2;
    this.baseX += (this.targetX - this.baseX) * 0.22 * delta;
    this.baseY += (this.targetY - this.baseY) * 0.24 * delta;
    this.view.x = this.baseX + wobble;
    this.view.y = this.baseY + float;
    this.view.rotation = Math.sin(this.age * 0.018 + this.seed) * 0.01;
    this.view.alpha = ease * leave;
    const scale = 0.96 + ease * 0.04;
    this.view.scale.set(scale * (1 + Math.sin(this.age * 0.031 + this.seed) * 0.006), scale);
    // Only the face layer is cleared and redrawn per frame — the pill body is static geometry.
    this.face.clear();
    this.drawFace(this.face, this.data.expression, this.faceTime);
    return this.age >= lifetime;
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }

  private redraw(): void {
    // The pill colour follows the mood: red for anger, orange for the sad family, yellow else.
    const angry = this.data.expression === "angry";
    const sad = this.data.expression === "sad" || this.data.expression === "down" || this.data.expression === "cry";
    const base = angry ? ANGRY_RED : sad ? SAD_ORANGE : YELLOW;
    const edge = angry ? ANGRY_EDGE : sad ? SAD_EDGE : GOLD;
    const highlight = angry ? ANGRY_LIGHT : sad ? SAD_LIGHT : LIGHT;
    const rSeed = this.seed ^ this.width ^ (this.data.expression.length * 317);

    this.shadow.clear();
    drawSoftPill(this.shadow, 3, 9, this.width, this.height, rgba(0x3c2c00, 0.16), rSeed);

    this.body.clear();
    drawSoftPill(this.body, 0, 0, this.width, this.height, base, rSeed);
    drawSoftPill(this.body, 2, 3, this.width - 4, this.height * 0.48, rgba(highlight, 0.34), rSeed ^ 0xaaa);
    this.body.rect(18, this.height - 8, this.width - 42, 4).fill(rgba(edge, 0.18));

    this.shine.clear();
    this.shine.ellipse(this.width * 0.24, 13, this.width * 0.18, 7).fill(rgba(0xffffff, 0.2));
    this.shine.ellipse(this.width * 0.62, 11, this.width * 0.12, 5).fill(rgba(0xffffff, 0.1));

    this.face.clear();
    this.drawFace(this.face, this.data.expression, this.faceTime);
    this.drawSenderBadge();
  }

  private senderText(): string {
    const raw = this.data.sender?.trim() || "anonymous";
    return raw.length > 18 ? `${raw.slice(0, 16)}..` : raw;
  }

  private drawSenderBadge(): void {
    const text = this.senderText();
    this.senderLabel.text = text;
    this.senderLabel.scale.set(1);
    const maxTextWidth = 118;
    if (this.senderLabel.width > maxTextWidth) this.senderLabel.scale.x = maxTextWidth / this.senderLabel.width;

    const badgeW = Math.ceil(clamp(this.senderLabel.width + 22, 54, 142));
    const badgeH = 24;
    const x = this.width - badgeW - 16;
    const y = -11;
    const seed = this.seed ^ hashSeed(text) ^ 0x51a7e;

    this.senderBadge.clear();
    drawSoftPill(this.senderBadge, x + 2, y + 3, badgeW, badgeH, rgba(0x3c2c00, 0.14), seed);
    drawSoftPill(this.senderBadge, x, y, badgeW, badgeH, 0xffec7a, seed);
    drawSoftPill(this.senderBadge, x + 3, y + 2, badgeW - 6, badgeH * 0.46, rgba(0xffffff, 0.24), seed ^ 0x99);
    this.senderBadge.rect(x + 13, y + badgeH - 5, badgeW - 26, 3).fill(rgba(0xe3a600, 0.28));

    this.senderLabel.x = Math.round(x + (badgeW - this.senderLabel.width) / 2);
    this.senderLabel.y = Math.round(y + (badgeH - this.senderLabel.height) / 2) - 1;
  }

  /**
   * Draws one animated face. `time` drives every micro-animation — the bobbing mouths, the
   * blinking, the falling tears — and each pill offsets it by its seed so faces never move in
   * lockstep across the stack.
   */
  private drawFace(g: PIXI.Graphics, expression: Expression, time = 0): void {
    const cx = 38;
    const cy = 32;
    const eyeL = 24;
    const eyeR = 48;
    const t = time + (this.seed % 997) * 0.013;
    const bob = Math.sin(t * 0.12) * 2.2;
    const soft = Math.sin(t * 0.08) * 1.4;
    const quick = Math.sin(t * 0.32);
    const shake = Math.round(Math.sin(t * 0.72) * 1.8);
    const tearDrop = (t * 0.65) % 19;
    const pulse = 1 + Math.sin(t * 0.14) * 0.12;
    const blink = Math.sin(t * 0.055) > 0.965 ? 3 : 0;

    switch (expression) {
      case "happy":
        closedEye(g, eyeL, cy - 11 + bob * 0.25, 1);
        closedEye(g, eyeR, cy - 11 + bob * 0.25, 1);
        halfEllipseDown(g, cx, cy + 12 + bob * 0.45, 18, 11 + pulse, BROWN);
        halfEllipseDown(g, cx, cy + 13 + bob * 0.45, 13, 6 + pulse * 0.35, TONGUE);
        break;
      case "kiss":
        g.circle(eyeL, cy - 11 + soft * 0.3, 5 + Math.max(quick, 0) * 0.6).fill(BROWN);
        closedEye(g, eyeR, cy - 12 + soft * 0.3, 1);
        g.moveTo(cx - 1, cy + 4);
        g.quadraticCurveTo(cx + 8, cy + 8, cx - 1, cy + 14);
        g.quadraticCurveTo(cx - 10, cy + 8, cx - 1, cy + 4);
        g.stroke({ color: BROWN, width: 4, cap: "round" });
        heart(g, 62 + Math.sin(t * 0.1) * 1.8, cy + 11 - bob, 9 * pulse);
        break;
      case "cry":
        frown(g, eyeL - 10, cy - 15 + soft * 0.3, 18, 7);
        frown(g, eyeR - 8, cy - 15 + soft * 0.3, 18, 7);
        g.circle(eyeL, cy - 4, 4).fill(BROWN);
        g.circle(eyeR, cy - 4, 4).fill(BROWN);
        g.ellipse(cx, cy + 15 + soft * 0.5, 11, 15 + Math.max(quick, 0) * 2).fill(BROWN);
        g.rect(cx - 5, cy + 17, 10, 8).fill(TONGUE);
        tear(g, eyeL - 8, cy + 8 + tearDrop, 13);
        tear(g, eyeR + 8, cy + 13 + ((tearDrop + 8) % 19), 13);
        break;
      case "surprised":
      case "scared":
        g.circle(eyeL + (expression === "scared" ? shake : 0), cy - 10 + soft * 0.25, 10 + Math.max(quick, 0) * 1.2).fill(0xffffff);
        g.circle(eyeR + (expression === "scared" ? shake : 0), cy - 10 + soft * 0.25, 10 + Math.max(quick, 0) * 1.2).fill(0xffffff);
        g.circle(eyeL + (expression === "scared" ? shake : 0), cy - 10 + blink * 0.35, 4).fill(BROWN);
        g.circle(eyeR + (expression === "scared" ? shake : 0), cy - 10 + blink * 0.35, 4).fill(BROWN);
        g.ellipse(cx + (expression === "scared" ? shake * 0.4 : 0), cy + 15 + soft * 0.4, expression === "scared" ? 11 + pulse : 8 + pulse * 0.7, expression === "scared" ? 16 + pulse * 2 : 10 + pulse).fill(BROWN);
        if (expression === "scared") g.rect(cx - 5, cy + 18, 10, 6).fill(TONGUE);
        break;
      case "sleepy":
      case "night":
        closedEye(g, eyeL, cy - 9 + soft * 0.3, -1);
        closedEye(g, eyeR, cy - 9 + soft * 0.3, -1);
        g.rect(cx - 15, cy + 12 + soft * 0.45, 30, 4).fill(BROWN);
        if (expression === "sleepy") tear(g, eyeR + 16 + Math.sin(t * 0.08) * 1.5, cy + 13 + ((tearDrop + 5) % 13), 9);
        else {
          g.circle(cx + 21 + Math.sin(t * 0.08) * 2, cy - 24 - ((t * 0.18) % 7), 5).fill(0x2f8bf3);
          g.circle(cx + 30 + Math.sin(t * 0.07 + 1) * 2, cy - 35 - ((t * 0.15) % 7), 4).fill(0x2f8bf3);
          g.circle(cx + 39 + Math.sin(t * 0.06 + 2) * 2, cy - 45 - ((t * 0.12) % 7), 3).fill(0x2f8bf3);
        }
        break;
      case "awkward":
        frown(g, eyeL - 10, cy - 12 + soft * 0.4, 18, 7);
        g.circle(eyeL, cy - 3, 5).fill(BROWN);
        g.circle(eyeR, cy - 1, 5).fill(BROWN);
        frown(g, cx - 16, cy + 18 + soft * 0.4, 30, 11);
        tear(g, eyeR + 15, cy - 13 + ((tearDrop + 2) % 15), 8);
        break;
      case "laugh":
      case "relieved":
        closedEye(g, eyeL, cy - 10 + bob * 0.3, 1);
        closedEye(g, eyeR, cy - 10 + bob * 0.3, 1);
        halfEllipseDown(g, cx, cy + 10 + bob * 0.35, 22, 14 + Math.max(quick, 0) * 2, BROWN);
        g.rect(cx - 18, cy + 8 + bob * 0.35, 36, 6).fill(0xffffff);
        if (expression === "laugh") {
          tear(g, eyeL - 14, cy + 10 + ((tearDrop + 3) % 12), 8);
          tear(g, eyeR + 14, cy + 10 + ((tearDrop + 9) % 12), 8);
        } else {
          tear(g, eyeR + 15 + Math.sin(t * 0.1) * 1.4, cy - 18 + ((tearDrop + 5) % 10), 8);
        }
        break;
      case "grin":
        closedEye(g, eyeL, cy - 11 + bob * 0.25, 1);
        closedEye(g, eyeR, cy - 11 + bob * 0.25, 1);
        halfEllipseDown(g, cx, cy + 12 + bob * 0.3, 20, 12 + Math.max(quick, 0), BROWN);
        g.rect(cx - 16, cy + 10 + bob * 0.3, 32, 7).fill(0xffffff);
        break;
      case "wink":
        g.circle(eyeL, cy - 9, 5).fill(BROWN);
        g.moveTo(eyeR - 9, cy - 8 + quick * 0.7).lineTo(eyeR + 9, cy - 8 - quick * 0.7).stroke({ color: BROWN, width: 4, cap: "round" });
        smile(g, cx - 16, cy + 12 + soft * 0.4, 29, 10 + Math.max(quick, 0));
        break;
      case "angry":
        g.moveTo(eyeL - 11 + shake, cy - 18).lineTo(eyeL + 8 + shake, cy - 10 + quick).stroke({ color: BROWN, width: 5, cap: "round" });
        g.moveTo(eyeR + 11 + shake, cy - 18).lineTo(eyeR - 8 + shake, cy - 10 - quick).stroke({ color: BROWN, width: 5, cap: "round" });
        g.circle(eyeL + shake * 0.4, cy - 5, 5 + Math.max(quick, 0) * 0.5).fill(BROWN);
        g.circle(eyeR + shake * 0.4, cy - 5, 5 + Math.max(-quick, 0) * 0.5).fill(BROWN);
        frown(g, cx - 16 + shake * 0.35, cy + 20 + soft * 0.35, 32, 13 + Math.abs(quick), BROWN, 5);
        break;
      case "cool":
        g.roundRect(eyeL - 15, cy - 19, 25, 15, 4).fill(0x141414);
        g.roundRect(eyeR - 10, cy - 19, 25, 15, 4).fill(0x141414);
        g.rect(eyeL + 8, cy - 14, 15, 4).fill(0x141414);
        g.rect(eyeL - 13 + ((t * 0.18) % 15), cy - 17, 7, 3).fill(rgba(0xffffff, 0.32));
        g.rect(eyeR - 8 + ((t * 0.18) % 15), cy - 17, 7, 3).fill(rgba(0xffffff, 0.32));
        smile(g, cx - 16, cy + 15 + soft * 0.3, 32, 9);
        break;
      case "lovely":
        closedEye(g, eyeL, cy - 10 + bob * 0.25, 1);
        closedEye(g, eyeR, cy - 10 + bob * 0.25, 1);
        smile(g, cx - 14, cy + 8 + bob * 0.2, 28, 8 + pulse * 0.5);
        g.circle(eyeL - 10, cy + 8, 7 + Math.max(quick, 0) * 0.7).fill(rgba(PINK, 0.58));
        g.circle(eyeR + 10, cy + 8, 7 + Math.max(quick, 0) * 0.7).fill(rgba(PINK, 0.58));
        heart(g, eyeR + 22 + Math.sin(t * 0.11) * 1.5, cy - 25 - bob, 8 * pulse);
        heart(g, eyeR + 18 + Math.sin(t * 0.09 + 1) * 1.2, cy + 20 - bob * 0.6, 7 * (1 + Math.sin(t * 0.17 + 2) * 0.12));
        break;
      case "yikes":
        xEye(g, eyeL, cy - 10);
        xEye(g, eyeR, cy - 10);
        g.roundRect(cx - 10, cy + 7, 20, 15, 5).fill(BROWN);
        g.rect(cx - 7, cy + 16, 14, 16 + Math.max(quick, 0) * 4).fill(TONGUE);
        break;
      case "dead":
        xEye(g, eyeL + shake * 0.3, cy - 12 + soft * 0.3);
        xEye(g, eyeR + shake * 0.3, cy - 12 - soft * 0.3);
        g.ellipse(cx, cy + 14 + soft * 0.4, 11, 15).fill(BROWN);
        g.rect(cx - 5, cy + 16 + soft * 0.5, 10, 7 + Math.max(quick, 0) * 2).fill(TONGUE);
        break;
      case "unimpressed":
        g.rect(eyeL - 10, cy - 13 + soft * 0.2, 19, 5).fill(BROWN);
        g.rect(eyeR - 9, cy - 13 + soft * 0.2, 19, 5).fill(BROWN);
        g.circle(eyeL + Math.sin(t * 0.04) * 2.5, cy - 10, 4).fill(0xffffff);
        g.circle(eyeR + Math.sin(t * 0.04) * 2.5, cy - 10, 4).fill(0xffffff);
        frown(g, cx - 17, cy + 18 + soft * 0.2, 34, 10);
        break;
      case "star":
        star(g, eyeL, cy - 11, 12 * pulse);
        star(g, eyeR, cy - 11, 12 * (1 + Math.sin(t * 0.16 + 1.2) * 0.12));
        halfEllipseDown(g, cx, cy + 14 + bob * 0.25, 19, 12 + Math.max(quick, 0), BROWN);
        g.rect(cx - 14, cy + 12 + bob * 0.25, 28, 6).fill(0xffffff);
        break;
      case "sad":
        g.moveTo(eyeL - 10, cy - 15);
        g.quadraticCurveTo(eyeL - 1, cy - 21, eyeL + 9, cy - 14);
        g.stroke({ color: BROWN, width: 4, cap: "round" });
        g.moveTo(eyeR - 9, cy - 14);
        g.quadraticCurveTo(eyeR + 1, cy - 21, eyeR + 10, cy - 15);
        g.stroke({ color: BROWN, width: 4, cap: "round" });
        g.ellipse(eyeL, cy - 3 + soft * 0.25, 4, 6).fill(BROWN);
        g.ellipse(eyeR, cy - 3 + soft * 0.25, 4, 6).fill(BROWN);
        frown(g, cx - 15, cy + 18 + soft * 0.4, 30, 8 + Math.max(-quick, 0), BROWN, 4);
        tear(g, eyeR + 14, cy + 2 + ((tearDrop + 4) % 14), 7);
        break;
      case "down":
        g.moveTo(eyeL - 9, cy - 14);
        g.quadraticCurveTo(eyeL - 1, cy - 18, eyeL + 8, cy - 12);
        g.stroke({ color: BROWN, width: 4, cap: "round" });
        g.moveTo(eyeR - 8, cy - 12);
        g.quadraticCurveTo(eyeR + 1, cy - 18, eyeR + 9, cy - 14);
        g.stroke({ color: BROWN, width: 4, cap: "round" });
        g.circle(eyeL, cy - 3 + soft * 0.2, 4).fill(BROWN);
        g.circle(eyeR, cy - 3 + soft * 0.2, 4).fill(BROWN);
        frown(g, cx - 16, cy + 18 + soft * 0.4, 32, 10 + Math.max(-quick, 0), BROWN, 4);
        break;
      case "neutral":
        g.ellipse(eyeL, cy - 9, 5, Math.max(1.5, 5 - blink)).fill(BROWN);
        g.ellipse(eyeR, cy - 9, 5, Math.max(1.5, 5 - blink)).fill(BROWN);
        smile(g, cx - 16, cy + 10 + soft * 0.25, 32, 9 + Math.max(quick, 0) * 0.6, BROWN, 4);
        break;
    }
  }
}

/* ------------------------------------------------------------------ */
/* The effect                                                          */
/* ------------------------------------------------------------------ */

const emojiChat = defineEffect({
  descriptor: {
    id: "emoji-chat",
    name: "Emoji Chat",
    description:
      "Chat messages as wobbly hand-drawn sticker pills, each with an animated cartoon face whose expression matches the mood of the message — an emoji and keyword classifier picks between 22 faces.",
    engine: "pixi",
    category: "chat",
    tags: ["chat", "twitch", "sticker", "emoji", "sentiment", "cartoon"],
    previewNotes:
      "Reads the Twitch chat feed; when Twitch is not configured, a simulated chat feed appears after a few seconds, so an empty preview is normal at first. Transparent background — lay it over any scene. Try messages with emoji (😂, 😭, 😡) or mood words to see the faces change.",
    params: [
      {
        key: "lifetime",
        label: "Sticker Lifetime",
        kind: "number",
        default: 26,
        min: 4,
        max: 120,
        step: 1,
        description: "How long each sticker stays on screen, in seconds, including its fade-out.",
      },
      {
        key: "maxCards",
        label: "Max Stickers",
        kind: "number",
        default: 8,
        min: 1,
        max: 20,
        step: 1,
        description:
          "How many stickers can be on screen at once. When a new message arrives at the limit, the oldest sticker is removed immediately.",
      },
      {
        key: "cardGap",
        label: "Sticker Gap",
        kind: "number",
        default: 18,
        min: 0,
        max: 80,
        step: 1,
        description: "Vertical space between stacked stickers, in pixels.",
      },
      {
        key: "bottomMargin",
        label: "Bottom Margin",
        kind: "number",
        default: 34,
        min: 0,
        max: 300,
        step: 1,
        description: "Distance from the bottom edge to the newest sticker, in pixels.",
      },
      {
        key: "driftRange",
        label: "Horizontal Drift",
        kind: "number",
        default: 220,
        min: 0,
        max: 600,
        step: 5,
        description:
          "How far stickers may sit left or right of centre, in pixels. 0 stacks them dead centre.",
      },
      {
        key: "fontSize",
        label: "Font Size",
        kind: "number",
        default: 21,
        min: 12,
        max: 40,
        step: 1,
        description:
          "Message text size in pixels. Applies to stickers spawned after the change — already-visible ones keep their size.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    const stage = await createPixiStage(scope, ctx);
    scope.checkpoint();
    const chat: ChatBus = await useChat(scope);
    scope.checkpoint();

    const settings: Settings = {
      // Stored in ticks (60ths of a second) because every animation constant ported from the
      // original — enter over 22 ticks, fade over 54 — is in that unit.
      lifetime: num(ctx.params, "lifetime", 26, 4, 120) * 60,
      maxCards: int(ctx.params, "maxCards", 8, 1, 20),
      cardGap: int(ctx.params, "cardGap", 18, 0, 80),
      bottomMargin: int(ctx.params, "bottomMargin", 34, 0, 300),
      driftRange: int(ctx.params, "driftRange", 220, 0, 600),
    };
    let fontSize = int(ctx.params, "fontSize", 21, 12, 40);

    /** Newest first — index 0 sits at the bottom of the screen. */
    const cards: EmojiStickerChip[] = [];
    let serial = 0;

    const layoutCards = (): void => {
      const screenW = stage.width;
      const screenH = stage.height;
      // Tighter margin on narrow canvases, matching the original's small-screen behaviour.
      const margin = screenW < 720 ? 14 : Math.max(14, settings.bottomMargin);
      let y = screenH - (screenW < 720 ? 14 : settings.bottomMargin);
      cards.forEach((card, index) => {
        y -= card.height;
        const range = Math.max(0, screenW - card.width - margin * 2);
        const center = (screenW - card.width) / 2;
        // Drift is seeded per message, so a relayout (a resize, an expiry) keeps every surviving
        // sticker on its own horizontal line instead of reshuffling the whole stack.
        const rng = seedRng(card.layoutSeed ^ 0xfacefeed);
        const drift = range > 0 ? (rng() - 0.5) * Math.min(range, settings.driftRange) : 0;
        const stackDrift = Math.sin(index * 1.7 + card.layoutSeed) * Math.min(34, range * 0.14);
        const x = clamp(center + drift + stackDrift, margin, Math.max(margin, screenW - card.width - margin));
        card.setTarget(Math.round(x), Math.round(y));
        y -= settings.cardGap;
      });
    };

    /** A fresh seed per sticker: stable inputs (user, text) mixed with a serial and the clock, so
     * the same user saying the same thing twice still gets two different wobbles. */
    const nextSeed = (msg: ChatMessage, text: string): number => {
      serial += 1;
      return hashSeed(
        ["emoji-chat", msg.username, msg.event, text, msg.seed, serial, performance.now().toFixed(3)].join(":"),
      );
    };

    const spawn = (msg: ChatMessage): void => {
      const text = visibleText(msg);
      const tone = localTone(text);
      const card = new EmojiStickerChip(
        { text, sender: msg.displayName || msg.username, expression: tone.expression },
        nextSeed(msg, text),
        fontSize,
        settings,
      );
      cards.unshift(card);
      stage.stage.addChild(card.view);
      while (cards.length > settings.maxCards) {
        cards.pop()?.destroy();
      }
      layoutCards();
    };

    // Seed the screen from history so the overlay is not empty right after a (re)load. Only as
    // many as fit — older backlog would be destroyed again by the cap on the next line anyway.
    for (const msg of chat.recent().slice(-settings.maxCards)) spawn(msg);
    const off = chat.onMessage(spawn);
    scope.defer(off);

    stage.onResize(() => {
      layoutCards();
    });

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      // The ported animation runs on the original's frame unit (one tick = 1/60 s), so a lower
      // fps cap plays the same motion rather than a slower one.
      const delta = dt * 60;
      for (let i = cards.length - 1; i >= 0; i--) {
        const card = cards[i];
        if (card !== undefined && card.update(delta)) {
          card.destroy();
          cards.splice(i, 1);
          layoutCards();
        }
      }
      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        settings.lifetime = num(p, "lifetime", 26, 4, 120) * 60;
        settings.maxCards = int(p, "maxCards", 8, 1, 20);
        settings.cardGap = int(p, "cardGap", 18, 0, 80);
        settings.bottomMargin = int(p, "bottomMargin", 34, 0, 300);
        settings.driftRange = int(p, "driftRange", 220, 0, 600);
        fontSize = int(p, "fontSize", 21, 12, 40);
        while (cards.length > settings.maxCards) {
          cards.pop()?.destroy();
        }
        layoutCards();
      },
    };
  },
});

export default emojiChat;
