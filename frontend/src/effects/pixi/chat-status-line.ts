import * as PIXI from "pixi.js";

import { bool, colorInt, int, num } from "../paramUtils";
import { createPixiStage, defineEffect, onFrame, useChat } from "../sdk";
import type { ChatMessage, ChatPart } from "~/types/contract";

/**
 * Chat Status Line
 * ================
 *
 * A bar of toxic liquid along the bottom edge of the frame. Three layers of sine waves slosh over
 * each other in greens (with an occasional violet accent), a right-to-left ticker scrolls each chat
 * message as `username: message` — with the message's emotes drawn inline as small framed images —
 * and every message drops a burst of expanding ripple rings into the liquid. An "energy" envelope
 * rises on every message and drains while chat is quiet; once the configured idle time passes and
 * the last ticker item has scrolled off, the whole liquid sinks away to nothing.
 *
 * Ported from `scenes/status-line/status-line.ts` in the old twitch-vizer repository. What changed
 * in the port:
 *
 * - The old scene opened its own WebSocket (`OverlayEventSocket`) straight to the Python backend;
 *   this version reads the shared chat bus (`useChat`), which also provides the simulated preview
 *   feed — the old keyboard-driven preview is gone.
 * - The old `?height=` and `?idleMs=` URL knobs are now the `barHeight` and `idleMs` parameters,
 *   and the scene's other hard-coded constants (font size, scroll speeds, emote chip size, ripple
 *   counts, the four palette colours) became parameters too.
 * - Emotes render from their **static** image URL only. The old app pulled in `pixi.js/gif` to
 *   animate GIF emotes; this app does not ship it, so the animated variant is ignored.
 * - The old scene ran on Pixi's own ticker with `delta` measured in 60ths of a second. This one
 *   runs on the SDK clock, whose `dt` is in seconds, so every use multiplies by 60 first — the
 *   wave and easing arithmetic is otherwise byte-for-byte the original's.
 * - The `?debug=1` overlay text was dropped; the SDK's own debug probes cover that job.
 */

const TAU = Math.PI * 2;

/** How many of the backlog messages seed the ticker on mount, so a preview is not blank until the
 * next message arrives. More would stack into an unreadably long queue of stale lines. */
const SEED_MESSAGES = 3;

/** Horizontal distance between wave sample points, in pixels. The original's value; smaller is
 * smoother but costs more geometry per frame for no visible gain at this amplitude. */
const WAVE_STEP = 14;

/** One sine layer of the liquid. The three layers differ in height, frequency, drift speed and
 * colour, and drawing them back-to-front is what gives the bar its depth. */
interface WaveLayerSpec {
  yOffset: number;
  amplitudeScale: number;
  frequency: number;
  speed: number;
  phase: number;
  color: number;
  alpha: number;
}

interface Ripple {
  x: number;
  y: number;
  radius: number;
  life: number;
  maxLife: number;
  color: number;
}

interface TickerItem {
  view: PIXI.Container;
  speed: number;
  seed: number;
}

/* ------------------------------------------------------------------ */
/* Colour and randomness helpers, carried over from the old shared     */
/* overlay module so the ported arithmetic stays identical.            */
/* ------------------------------------------------------------------ */

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** A tiny deterministic random generator (a linear congruential generator). Seeded from the
 * message's per-user seed so the same user's ripples always scatter the same way. */
function seedRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/** Hue/saturation/lightness to a 24-bit RGB integer, for deriving a colour from a user's seed. */
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

/** Linear blend of two 24-bit colours, per channel. `t = 0` gives `a`, `t = 1` gives `b`. */
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

/** Shorthand for Pixi's `{color, alpha}` fill style objects, matching the old code's `rgba`. */
function rgba(color: number, alpha: number): { color: number; alpha: number } {
  return { color, alpha };
}

/** Parses the message's `#rrggbb` colour, falling back when it is somehow malformed. */
function colorFromString(value: string, fallback: number): number {
  const normalized = value.startsWith("#") ? value.slice(1) : value;
  const parsed = Number.parseInt(normalized, 16);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Frame-rate-independent exponential easing toward a target — the old scene's `ease`, with
 * `delta` measured in 60ths of a second exactly as before. */
function ease(current: number, target: number, rate: number, delta: number): number {
  return current + (target - current) * (1 - Math.exp((-rate * delta) / 60));
}

/* ------------------------------------------------------------------ */
/* Message text for channel events                                     */
/* ------------------------------------------------------------------ */

/** The human sentence for a channel event, ported from the old `formatEventText`. Ordinary chat
 * never reaches this — its parts are rendered directly. */
function eventText(msg: ChatMessage): string {
  if (msg.event === "sub") {
    const months = msg.data["months"];
    return typeof months === "number" && months > 0
      ? `subscribed for ${months} months`
      : "subscribed";
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

/** The "GIFT SUB | someuser gifted 3 subscriptions" line for non-chat events, matching the old
 * `messageText` (the label is the event name with its underscore opened up). */
function eventLine(msg: ChatMessage): string {
  const label = msg.event.replace("_", " ").toUpperCase();
  return `${label} | ${msg.username} ${eventText(msg)}`.trim();
}

const statusLine = defineEffect({
  descriptor: {
    id: "chat-status-line",
    name: "Chat Status Line",
    description:
      "A toxic-liquid bar along the bottom edge: three layers of sloshing sine waves, a right-to-left ticker of chat messages with inline emotes, and ripple rings on every message. The liquid drains away when chat goes quiet.",
    engine: "pixi",
    category: "chat",
    tags: ["chat", "twitch", "ticker", "liquid", "waves", "toxic", "status-bar"],
    previewNotes:
      "Reads the live Twitch chat when the backend is configured; otherwise a gentle simulated feed appears after a few seconds, so give the preview a moment. Transparent everywhere above the bar — lay it along the bottom of a scene. Emotes load from Twitch's CDN at runtime and fall back to their text name if that fails.",
    params: [
      {
        key: "barHeight",
        label: "Bar Height",
        kind: "number",
        default: 108,
        min: 64,
        max: 180,
        step: 2,
        description:
          "Height of the liquid bar in pixels, measured from the bottom edge. Was the old overlay's ?height= URL knob.",
      },
      {
        key: "idleMs",
        label: "Idle Timeout (ms)",
        kind: "number",
        default: 6200,
        min: 1800,
        max: 20000,
        step: 100,
        description:
          "How long chat must stay silent before the liquid starts draining away, in milliseconds. Was the old overlay's ?idleMs= URL knob.",
      },
      {
        key: "fontSize",
        label: "Ticker Font Size",
        kind: "number",
        default: 25,
        min: 12,
        max: 48,
        step: 1,
        description: "Size of the scrolling message text, in pixels.",
      },
      {
        key: "tickerSpeed",
        label: "Ticker Speed",
        kind: "number",
        default: 2.2,
        min: 0.5,
        max: 8,
        step: 0.1,
        description:
          "How fast chat messages scroll leftwards, in pixels per 60 Hz frame. Channel events (subs, raids) scroll a bit faster than this automatically.",
      },
      {
        key: "emoteSize",
        label: "Emote Size",
        kind: "number",
        default: 34,
        min: 16,
        max: 64,
        step: 2,
        description: "Side length of the inline emote chips in the ticker, in pixels.",
      },
      {
        key: "showEmotes",
        label: "Show Emotes",
        kind: "boolean",
        default: true,
        description:
          "Draw emotes as images. Off replaces each with its :name: as text — useful when the CDN is unreachable or the look should stay pure text.",
      },
      {
        key: "rippleStrength",
        label: "Ripple Amount",
        kind: "number",
        default: 1,
        min: 0,
        max: 3,
        step: 0.1,
        description:
          "Scales how many ripple rings each message drops into the liquid. 0 disables them entirely.",
      },
      {
        key: "colorBright",
        label: "Liquid Green (bright)",
        kind: "color",
        default: "#54f044",
        description: "The brightest green: the crest highlight and the glow above the surface.",
      },
      {
        key: "colorToxic",
        label: "Liquid Green (toxic)",
        kind: "color",
        default: "#38ff24",
        description: "The saturated mid green used through the body of the liquid.",
      },
      {
        key: "colorAcid",
        label: "Liquid Green (acid)",
        kind: "color",
        default: "#8cff68",
        description: "The pale acid green: the top wave layer and the emote chip borders.",
      },
      {
        key: "colorAccent",
        label: "Accent Violet",
        kind: "color",
        default: "#b000ff",
        description:
          "The off-palette accent mixed into roughly a third of users' ripple colours, so the bar is not monotonously green.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    /*
     * `antialias: false` and `roundPixels`, like the original: the bar is drawn in chunky
     * pixel-snapped steps on purpose, and antialiasing would soften the liquid's hard edges.
     */
    const stage = await createPixiStage(scope, ctx, { antialias: false });

    const chat = await useChat(scope);
    scope.checkpoint();

    let barHeight = int(ctx.params, "barHeight", 108, 64, 180);
    let idleMs = num(ctx.params, "idleMs", 6200, 1800, 20000);
    let fontSize = int(ctx.params, "fontSize", 25, 12, 48);
    let tickerSpeed = num(ctx.params, "tickerSpeed", 2.2, 0.5, 8);
    let emoteSize = int(ctx.params, "emoteSize", 34, 16, 64);
    let showEmotes = bool(ctx.params, "showEmotes", true);
    let rippleStrength = num(ctx.params, "rippleStrength", 1, 0, 3);
    let colorBright = colorInt(ctx.params, "colorBright", "#54f044");
    let colorToxic = colorInt(ctx.params, "colorToxic", "#38ff24");
    let colorAcid = colorInt(ctx.params, "colorAcid", "#8cff68");
    let colorAccent = colorInt(ctx.params, "colorAccent", "#b000ff");

    /* Fixed shades the palette params mix against. The deep green is nearly black on purpose —
     * it is the body of the liquid, and the layers above it supply all the colour. */
    const DEEP_GREEN = 0x020802;
    const LIQUID_BLACK = 0x000000;

    /* Draw order bottom-up: glow behind the liquid, liquid, ripples on it, then the masked text. */
    const glow = stage.stage.addChild(new PIXI.Graphics());
    const wave = stage.stage.addChild(new PIXI.Graphics());
    const ripplesLayer = stage.stage.addChild(new PIXI.Container());
    const textMask = stage.stage.addChild(new PIXI.Graphics());
    const textLayer = stage.stage.addChild(new PIXI.Container());
    textLayer.mask = textMask;
    textLayer.alpha = 0;

    /* The animation state, named as in the original. `elapsed` and `idleFor` advance in 60ths of
     * a second because every wave frequency below was tuned against Pixi's ticker delta. */
    let elapsed = 0;
    let idleFor = 999999;
    let level = 0;
    let targetLevel = 0;
    let energy = 0;
    let messageSeed = 1;
    const tickerItems: TickerItem[] = [];
    const ripples: Ripple[] = [];

    /** The user's colour pulled toward the toxic palette, ported from `readableAccent`: a raw
     * chat colour can be anything (including near-black), so only 22% of it survives the mix. */
    const readableAccent = (msg: ChatMessage): number => {
      const base = colorFromString(msg.color, hslToRgb(msg.seed % 360, 0.76, 0.58));
      const toxicBase =
        msg.seed % 3 === 0 ? colorAccent : msg.seed % 3 === 1 ? colorToxic : colorAcid;
      return mixColor(toxicBase, base, 0.22);
    };

    const makeTickerText = (text: string): PIXI.Text =>
      new PIXI.Text({
        text,
        style: {
          fontFamily:
            '"Courier New", "Lucida Console", "Apple Color Emoji", "Segoe UI Emoji", monospace',
          fontSize,
          fontWeight: "900",
          fill: 0xffffff,
          stroke: { color: 0x000000, width: 5 },
          letterSpacing: 0,
          dropShadow: { color: 0x000000, alpha: 0.55, blur: 4, distance: 0 },
        },
      });

    const appendTickerText = (container: PIXI.Container, text: string, x: number): number => {
      if (!text) return x;
      const view = makeTickerText(text);
      view.x = x;
      view.y = 0;
      container.addChild(view);
      return x + view.width + 8;
    };

    /** Adds one emote chip: a rounded frame drawn immediately, with the image loaded in behind it
     * asynchronously. The frame is the placeholder *and* the failure state — on a load error it is
     * redrawn brighter instead of leaving a hole, so the ticker never jumps as images arrive. */
    const appendTickerImage = (
      container: PIXI.Container,
      part: Extract<ChatPart, { type: "image" }>,
      x: number,
    ): number => {
      if (!showEmotes) {
        return appendTickerText(container, `:${part.name}:`, x);
      }

      const size = emoteSize;
      const frame = new PIXI.Graphics()
        .roundRect(x, -3, size, size, 5)
        .fill(rgba(DEEP_GREEN, 0.72))
        .stroke({ color: colorAcid, alpha: 0.65, width: 2 });
      container.addChild(frame);

      /*
       * Static URL only — no `pixi.js/gif` in this app, so `animatedUrl` is deliberately ignored.
       * `Assets.load` caches by URL, so the same emote spammed across many messages costs one
       * network fetch.
       */
      PIXI.Assets.load<PIXI.Texture>(part.url)
        .then((texture) => {
          // The message may have scrolled off and been destroyed while the image was in flight.
          if (frame.destroyed) return;
          const sprite = new PIXI.Sprite(texture);
          const scale = size / Math.max(texture.width, texture.height, 1);
          sprite.scale.set(scale);
          sprite.x = x + (size - texture.width * scale) / 2;
          sprite.y = -3 + (size - texture.height * scale) / 2;
          container.addChild(sprite);
          frame.alpha = 0.18;
        })
        .catch(() => {
          if (frame.destroyed) return;
          frame
            .clear()
            .roundRect(x, -3, size, size, 5)
            .fill(rgba(DEEP_GREEN, 0.86))
            .stroke({ color: colorToxic, alpha: 0.72, width: 2 });
        });

      return x + size + 10;
    };

    /** Builds one scrolling item: `username: ` then the message's parts for chat, or the single
     * "EVENT | user did thing" line for channel events. */
    const makeTickerItem = (msg: ChatMessage): PIXI.Container => {
      const container = new PIXI.Container();
      let cursor = 0;

      if (msg.event === "chat") {
        cursor = appendTickerText(container, `${msg.username}: `, cursor);
        const parts: ChatPart[] =
          msg.parts.length > 0 ? msg.parts : [{ type: "text", text: msg.text.trim() || "..." }];
        for (const part of parts) {
          cursor =
            part.type === "image"
              ? appendTickerImage(container, part, cursor)
              : appendTickerText(container, part.text, cursor);
        }
        return container;
      }

      appendTickerText(container, eventLine(msg), cursor);
      return container;
    };

    /** The vertical centre line the ticker rides on, a fixed fraction up the bar. */
    const tickerY = (): number => stage.height - Math.max(32, barHeight * 0.42);

    const addTickerItem = (msg: ChatMessage, seed: number, speed: number): void => {
      const view = makeTickerItem(msg);
      // Queue behind whatever is still on screen, so simultaneous messages do not overlap.
      const rightmost = tickerItems.reduce(
        (max, item) => Math.max(max, item.view.x + item.view.width),
        stage.width,
      );
      view.x = Math.max(stage.width + 18, rightmost + 80);
      view.y = Math.round(tickerY());
      view.alpha = 1;
      textLayer.addChild(view);
      tickerItems.push({ view, speed, seed });
    };

    /** The mask keeps the ticker text from poking out past the bar's side margins. Redrawn on
     * resize and whenever the bar height parameter changes. */
    const layoutMask = (): void => {
      textMask
        .clear()
        .rect(18, stage.height - barHeight + 8, stage.width - 36, barHeight - 18)
        .fill(0xffffff);
    };
    layoutMask();
    stage.onResize(() => {
      layoutMask();
      for (const item of tickerItems) item.view.y = Math.round(tickerY());
    });

    /** What one incoming message does: wake the liquid, spike the energy, retint the accent, add
     * a ticker item, and scatter ripples (more of them for channel events, as before). */
    const receive = (msg: ChatMessage): void => {
      idleFor = 0;
      targetLevel = 1;
      energy = clamp(energy + 0.46, 0, 1.35);
      messageSeed = msg.seed;
      const speed = msg.event === "chat" ? tickerSpeed : tickerSpeed * (2.8 / 2.2);

      addTickerItem(msg, msg.seed, speed);

      const accent = readableAccent(msg);
      const rng = seedRng(msg.seed ^ 0x57a7);
      const count = Math.round((msg.event === "chat" ? 3 : 7) * rippleStrength);
      for (let i = 0; i < count; i += 1) {
        ripples.push({
          x: rng() * stage.width,
          y: stage.height - barHeight * (0.22 + rng() * 0.56),
          radius: 4 + rng() * 14,
          life: 0,
          maxLife: 34 + rng() * 28,
          color: mixColor(accent, hslToRgb((msg.seed + i * 41) % 360, 0.84, 0.62), 0.35),
        });
      }
    };

    // Seed the ticker with the tail of the backlog, then follow the live feed.
    for (const msg of chat.recent().slice(-SEED_MESSAGES)) receive(msg);
    const off = chat.onMessage(receive);
    scope.defer(off);

    /** Draws the liquid: back-to-front sine layers, the main surface, the base strip, and three
     * stroked "lane" lines riding the crest. All arithmetic is the original's, with the fixed
     * palette constants swapped for the colour parameters. */
    const drawWave = (): void => {
      const width = stage.width;
      const height = stage.height;
      const active = clamp(level, 0, 1);
      const energyNow = clamp(energy, 0, 1.2);
      const baseY = height - 7 - active * (barHeight * 0.18);
      const crest = height - barHeight * (0.18 + active * 0.72);
      const amp = 2 + active * (7 + energyNow * 10);
      const time = elapsed;
      const deep = mixColor(LIQUID_BLACK, colorBright, 0.46 + active * 0.24);
      const bright = mixColor(colorAcid, colorToxic, 0.48);

      glow.clear();
      if (active > 0.015) {
        glow.rect(0, crest - 8, width, 7 + active * 8).fill(rgba(bright, 0.24 + active * 0.3));
      }

      wave.clear();
      if (active < 0.01 && textLayer.alpha < 0.02) return;

      const layers: WaveLayerSpec[] = [
        {
          yOffset: barHeight * 0.3,
          amplitudeScale: 0.32,
          frequency: 1.45,
          speed: 0.032,
          phase: 1.7,
          color: mixColor(LIQUID_BLACK, DEEP_GREEN, 0.62),
          alpha: 1,
        },
        {
          yOffset: barHeight * 0.2,
          amplitudeScale: 0.42,
          frequency: 1.9,
          speed: -0.04,
          phase: 4.2,
          color: mixColor(DEEP_GREEN, colorBright, 0.58),
          alpha: 0.96,
        },
        {
          yOffset: barHeight * 0.11,
          amplitudeScale: 0.55,
          frequency: 2.55,
          speed: 0.052,
          phase: 2.4,
          color: mixColor(colorToxic, colorAcid, 0.36),
          alpha: 0.9,
        },
      ];

      for (const layer of layers) {
        const layerBase = Math.min(height + 4, crest + layer.yOffset + active * 8);
        wave.moveTo(0, height + 4);
        wave.lineTo(0, layerBase);
        for (let x = 0; x <= width + WAVE_STEP; x += WAVE_STEP) {
          const normalized = x / Math.max(width, 1);
          const y =
            layerBase +
            Math.sin(normalized * TAU * layer.frequency + time * layer.speed + layer.phase) *
              amp *
              layer.amplitudeScale +
            Math.sin(
              normalized * TAU * (layer.frequency + 2.1) - time * layer.speed * 0.7 + messageSeed,
            ) *
              amp *
              layer.amplitudeScale *
              0.28;
          wave.lineTo(x, Math.round(y));
        }
        wave.lineTo(width, height + 4);
        wave.closePath();
        wave.fill(rgba(layer.color, active > 0.02 ? layer.alpha : active));
      }

      wave.moveTo(0, height + 4);
      wave.lineTo(0, baseY);
      for (let x = 0; x <= width + WAVE_STEP; x += WAVE_STEP) {
        const normalized = x / Math.max(width, 1);
        const y =
          crest +
          Math.sin(normalized * TAU * 2.2 + time * 0.06) * amp +
          Math.sin(normalized * TAU * 5.3 - time * 0.035 + messageSeed) * amp * 0.35;
        wave.lineTo(x, Math.round(y));
      }
      wave.lineTo(width, height + 4);
      wave.closePath();
      wave.fill(rgba(deep, active > 0.02 ? 1 : active));

      wave
        .rect(0, height - 10 - active * 4, width, 8 + active * 4)
        .fill(rgba(mixColor(colorToxic, colorAcid, 0.38), active > 0.02 ? 0.96 : active));

      for (let lane = 0; lane < 3; lane += 1) {
        const offset = lane * 13 + Math.sin(time * 0.035 + lane) * 4;
        const laneAlpha = (lane === 0 ? 0.28 : 0.16 + lane * 0.035) * active;
        wave.moveTo(0, crest + offset);
        for (let x = 0; x <= width + WAVE_STEP; x += WAVE_STEP) {
          const normalized = x / Math.max(width, 1);
          const y =
            crest +
            offset +
            Math.sin(normalized * TAU * (1.7 + lane * 0.8) + time * (0.04 + lane * 0.009)) *
              (amp * (0.26 + lane * 0.08));
          wave.lineTo(x, Math.round(y));
        }
        const laneColor =
          lane === 0
            ? bright
            : lane === 1
              ? mixColor(colorAcid, colorToxic, 0.52)
              : mixColor(colorBright, colorAcid, 0.42);
        wave.stroke({ color: laneColor, alpha: laneAlpha, width: lane === 0 ? 3 : 2 });
      }
    };

    /** Scrolls, bobs and retires the ticker items. `delta` is in 60ths of a second. */
    const updateText = (delta: number): void => {
      textLayer.alpha = tickerItems.length > 0 ? 1 : 0;
      if (tickerItems.length === 0) return;

      for (let i = tickerItems.length - 1; i >= 0; i -= 1) {
        const item = tickerItems[i];
        if (item === undefined) continue;
        const bob = Math.sin(elapsed * 0.075 + item.seed) * 1.2 * level;
        item.view.y = Math.round(tickerY() + bob);
        item.view.x -= item.speed * delta;

        if (item.view.x < -item.view.width - 48) {
          item.view.destroy({ children: true });
          tickerItems.splice(i, 1);
        }
      }
    };

    /** Redraws the ripple rings from scratch each frame, as the original did: each ring is a
     * short-lived expanding stroke whose alpha fades with age and with the liquid's level. */
    const updateRipples = (delta: number): void => {
      ripplesLayer.removeChildren().forEach((child) => child.destroy());
      for (let i = ripples.length - 1; i >= 0; i -= 1) {
        const ripple = ripples[i];
        if (ripple === undefined) continue;
        ripple.life += delta;
        if (ripple.life >= ripple.maxLife) {
          ripples.splice(i, 1);
          continue;
        }

        const t = ripple.life / ripple.maxLife;
        const g = new PIXI.Graphics();
        g.circle(ripple.x, ripple.y, ripple.radius + t * 46).stroke({
          color: ripple.color,
          alpha: (1 - t) * 0.42 * level,
          width: 2,
        });
        g.circle(ripple.x, ripple.y, 2 + t * 5).fill(
          rgba(mixColor(ripple.color, 0xffffff, 0.25), (1 - t) * 0.25 * level),
        );
        ripplesLayer.addChild(g);
      }
    };

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      // The SDK clock hands out seconds; the ported arithmetic wants Pixi-ticker frames (60ths).
      const delta = dt * 60;
      elapsed += delta;
      idleFor += dt * 1000;

      // Only drain once the timeout has passed AND the last message has scrolled off — a slow
      // ticker item should never sink into an already-emptied bar.
      if (idleFor > idleMs && tickerItems.length === 0) {
        targetLevel = 0;
      }

      // Two envelopes at different rates: energy (wave amplitude) moves faster than level (bar
      // fill), and both rise faster than they fall, so activity snaps in and quiet fades out.
      energy = ease(energy, targetLevel, targetLevel > 0 ? 0.09 : 0.045, delta);
      level = ease(level, targetLevel, targetLevel > 0 ? 0.15 : 0.055, delta);

      drawWave();
      updateText(delta);
      updateRipples(delta);
      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        barHeight = int(p, "barHeight", 108, 64, 180);
        idleMs = num(p, "idleMs", 6200, 1800, 20000);
        fontSize = int(p, "fontSize", 25, 12, 48);
        tickerSpeed = num(p, "tickerSpeed", 2.2, 0.5, 8);
        emoteSize = int(p, "emoteSize", 34, 16, 64);
        showEmotes = bool(p, "showEmotes", true);
        rippleStrength = num(p, "rippleStrength", 1, 0, 3);
        colorBright = colorInt(p, "colorBright", "#54f044");
        colorToxic = colorInt(p, "colorToxic", "#38ff24");
        colorAcid = colorInt(p, "colorAcid", "#8cff68");
        colorAccent = colorInt(p, "colorAccent", "#b000ff");
        // The mask depends on the bar height, so redo it; items already scrolling keep their
        // speed and font, which is fine — they are seconds from leaving the screen anyway.
        layoutMask();
        for (const item of tickerItems) item.view.y = Math.round(tickerY());
      },
    };
  },
});

export default statusLine;
