import * as PIXI from "pixi.js";

import { bool, colorHex, int, num } from "../paramUtils";
import { createPixiStage, defineEffect, onFrame, useChat } from "../sdk";
import type { ChatMessage } from "~/types/contract";

/**
 * Chat Typing
 * ===========
 *
 * A minimal typewriter chat overlay, written for this project rather than ported from anywhere.
 * Each Twitch chat message appears on its own monospace line and is typed out character by
 * character, with a blinking block cursor at the writing position — the way a terminal or an old
 * text adventure prints. Finished lines stack upward; when a line grows old, or the stack exceeds
 * the visible line count, it fades out and disappears.
 *
 * Where the messages come from
 * ----------------------------
 * `useChat` from the SDK. When the backend has a Twitch channel configured, these are real chat
 * lines; when it does not, the SDK feeds a gentle simulated chat so a preview always shows the
 * typing behaviour.
 *
 * How typing works here
 * ---------------------
 * A message is flattened up front into a list of *atoms*: one atom per text character, one atom
 * per emote image. Typing consumes atoms at a fixed rate (the Type Speed parameter, in characters
 * per second), so an emote costs the same beat as a letter — which is what a human typist pasting
 * an emote would look like. Only one line types at a time; messages that arrive faster than the
 * typist can keep up wait in a small queue, and when the queue overflows the oldest waiting
 * message is dropped (chat that scrolled past is stale news anyway).
 *
 * Emotes
 * ------
 * With Show Emotes on, image parts (Twitch emotes and Unicode emoji, both delivered as image
 * parts by the SDK) render as inline sprites sized to the font. Only the **static** emote image
 * is loaded — this app has no animated-GIF plugin for Pixi, so animated emotes show their static
 * frame. A failed image load falls back to drawing the emote's name as text inside the same box,
 * so the line never shows a hole. With Show Emotes off, emotes are typed literally as `:name:`.
 */

/** Line height as a multiple of the font size. 1.45 keeps monospace lines readable when stacked. */
const LINE_HEIGHT_FACTOR = 1.45;

/** Distance from the stage's left and bottom edges to the text, in font-size multiples. */
const EDGE_PADDING_FACTOR = 0.75;

/** Horizontal padding inside a line's background plate, in font-size multiples. */
const PLATE_PADDING_FACTOR = 0.4;

/** Cursor blink period in seconds — on for half of it, off for the other half. */
const CURSOR_BLINK_S = 1.0;

/** How many messages may wait for the typist before the oldest waiting one is dropped. */
const QUEUE_LIMIT = 8;

/** Monospace stack: whatever fixed-width font the OBS machine has, with a guaranteed fallback. */
const FONT_STACK = '"JetBrains Mono", "Cascadia Mono", Consolas, "Courier New", monospace';

/** One unit of typing: a single character (with the colour it should take) or one emote image. */
type Atom =
  | { kind: "char"; ch: string; role: "username" | "text" }
  | { kind: "emote"; name: string; url: string };

/** One rendered chat line, from first keystroke to faded out. */
interface Line {
  /** Holds the plate and the content; moved as a unit when the stack scrolls or fades. */
  container: PIXI.Container;
  /** The background plate, redrawn as the line grows while it is being typed. */
  plate: PIXI.Graphics;
  /** Where the text runs and emote sprites live, offset by the plate padding. */
  content: PIXI.Container;
  atoms: Atom[];
  /** Index of the next atom to type. Equal to `atoms.length` once the line is finished. */
  next: number;
  /** X position (inside `content`) where the next atom lands. */
  penX: number;
  /** The text run currently being appended to, or null when the last atom was an emote. */
  run: PIXI.Text | null;
  /** The role the current run is coloured for, so a colour change starts a new run. */
  runRole: "username" | "text" | null;
  /** Effect time at which typing finished, or null while still typing. */
  doneAt: number | null;
  /** Effect time at which the fade-out began, or null while fully visible. */
  fadeStartedAt: number | null;
}

const chatTyping = defineEffect({
  descriptor: {
    id: "chat-typing",
    name: "Chat Typing",
    description:
      "A minimal typewriter chat overlay: each message is typed out character by character in a monospace font with a blinking cursor, lines stack upward, and old lines fade away.",
    engine: "pixi",
    category: "chat",
    tags: ["chat", "twitch", "typewriter", "terminal", "text", "minimal"],
    previewNotes:
      "Transparent — lay it over anything. When Twitch is not configured the SDK feeds a simulated chat, so a preview types canned messages every few seconds; expect quiet gaps between them.",
    params: [
      {
        key: "fontSize",
        label: "Font Size",
        kind: "number",
        default: 22,
        min: 10,
        max: 72,
        step: 1,
        description: "Height of the monospace text in pixels. Emotes are sized to match it.",
      },
      {
        key: "lineCount",
        label: "Visible Lines",
        kind: "number",
        default: 6,
        min: 1,
        max: 20,
        step: 1,
        description:
          "How many chat lines may be on screen at once. When a new line starts beyond this, the oldest visible line fades out to make room.",
      },
      {
        key: "typeSpeed",
        label: "Type Speed",
        kind: "number",
        default: 28,
        min: 3,
        max: 120,
        step: 1,
        description:
          "Typing rate in characters per second. Around 25–35 reads as a fast human typist; higher values feel machine-printed.",
      },
      {
        key: "fadeAfter",
        label: "Line Lifetime",
        kind: "number",
        default: 24,
        min: 2,
        max: 300,
        step: 1,
        description:
          "How long a finished line stays fully visible, in seconds, before it fades out on its own. Lines pushed out by newer ones fade earlier regardless.",
      },
      {
        key: "fadeDuration",
        label: "Fade Duration",
        kind: "number",
        default: 1.2,
        min: 0.1,
        max: 10,
        step: 0.1,
        description: "How long the fade-out itself takes, in seconds.",
      },
      {
        key: "colorText",
        label: "Text Colour",
        kind: "color",
        default: "#e6e6e6",
        description: "Colour of the message text and the blinking cursor.",
      },
      {
        key: "colorUsername",
        label: "Username Colour",
        kind: "color",
        default: "#7fdbca",
        description:
          "Colour of the username prefix on every line. One fixed colour, not the per-user Twitch colour — uniformity is part of the terminal look.",
      },
      {
        key: "colorBg",
        label: "Background Colour",
        kind: "color",
        default: "#0c0f14",
        description: "Colour of the plate drawn behind each line so text stays readable over video.",
      },
      {
        key: "bgAlpha",
        label: "Background Opacity",
        kind: "number",
        default: 0.55,
        min: 0,
        max: 1,
        step: 0.05,
        description: "Opacity of the background plates. 0 leaves bare text on the transparent stage.",
      },
      {
        key: "showEmotes",
        label: "Show Emotes",
        kind: "boolean",
        default: true,
        description:
          "On: emotes and emoji render as inline images sized to the font (static image only — animated emotes show their first frame). Off: they are typed literally as :name: text.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    const stage = await createPixiStage(scope, ctx);
    const chat = await useChat(scope);
    scope.checkpoint();

    let fontSize = int(ctx.params, "fontSize", 22, 10, 72);
    let lineCount = int(ctx.params, "lineCount", 6, 1, 20);
    let typeSpeed = num(ctx.params, "typeSpeed", 28, 3, 120);
    let fadeAfter = num(ctx.params, "fadeAfter", 24, 2, 300);
    let fadeDuration = num(ctx.params, "fadeDuration", 1.2, 0.1, 10);
    let colorText = colorHex(ctx.params, "colorText", "#e6e6e6");
    let colorUsername = colorHex(ctx.params, "colorUsername", "#7fdbca");
    let colorBg = colorHex(ctx.params, "colorBg", "#0c0f14");
    let bgAlpha = num(ctx.params, "bgAlpha", 0.55, 0, 1);
    let showEmotes = bool(ctx.params, "showEmotes", true);

    /** Effect-local clock, advanced by the frame loop. All line timestamps are in this clock. */
    let time = 0;

    /** Oldest first. The last entry is the line currently being typed (when `typing` is true). */
    const lines: Line[] = [];
    let typing = false;

    /** Messages waiting for the typist. Oldest first; overflow drops from the front. */
    const queue: ChatMessage[] = [];

    /** Fractional atoms earned by elapsed time but not yet typed. Carries across frames so a low
     * type speed still advances — at 5 chars/s a 60 fps frame earns well under one atom. */
    let typeCarry = 0;

    const style = (role: "username" | "text"): PIXI.TextStyle =>
      new PIXI.TextStyle({
        fontFamily: FONT_STACK,
        fontSize,
        fill: role === "username" ? colorUsername : colorText,
      });

    /**
     * Flattens a message into typing atoms. The username prefix is typed too — the whole line is
     * one continuous act of typing, which is the effect's entire conceit.
     */
    const flatten = (message: ChatMessage): Atom[] => {
      const atoms: Atom[] = [];
      for (const ch of `${message.displayName}: `) {
        atoms.push({ kind: "char", ch, role: "username" });
      }
      for (const part of message.parts) {
        if (part.type === "text") {
          for (const ch of part.text) atoms.push({ kind: "char", ch, role: "text" });
        } else if (showEmotes) {
          atoms.push({ kind: "emote", name: part.name, url: part.url });
        } else {
          for (const ch of `:${part.name}:`) atoms.push({ kind: "char", ch, role: "text" });
        }
      }
      return atoms;
    };

    const startFade = (line: Line): void => {
      if (line.fadeStartedAt === null) line.fadeStartedAt = time;
    };

    const removeLine = (line: Line): void => {
      const index = lines.indexOf(line);
      if (index >= 0) lines.splice(index, 1);
      // Destroying children also destroys emote sprites whose Assets.load is still in flight;
      // the load callbacks below check `destroyed` before touching them.
      line.container.destroy({ children: true });
    };

    const beginLine = (message: ChatMessage): void => {
      const container = stage.stage.addChild(new PIXI.Container());
      const plate = container.addChild(new PIXI.Graphics());
      const content = container.addChild(new PIXI.Container());
      content.x = fontSize * PLATE_PADDING_FACTOR;

      lines.push({
        container,
        plate,
        content,
        atoms: flatten(message),
        next: 0,
        penX: 0,
        run: null,
        runRole: null,
        doneAt: null,
        fadeStartedAt: null,
      });
      typing = true;

      // A new line beyond the visible budget evicts from the top — the fade starts now, so the
      // stack never holds more than `lineCount` fully-opaque lines.
      const visible = lines.filter((l) => l.fadeStartedAt === null);
      for (let i = 0; i < visible.length - lineCount; i += 1) {
        const evicted = visible[i];
        if (evicted !== undefined) startFade(evicted);
      }
    };

    /** Adds one emote box to `line` at the pen: a sprite that gets its texture when the network
     * delivers it, or the emote's name squeezed into the same box when the load fails. */
    const typeEmote = (line: Line, name: string, url: string): void => {
      // The box is reserved at its final size immediately, so atoms typed after the emote do not
      // shift when the image arrives — the pen never has to move already-placed content.
      const box = fontSize * 1.15;
      const sprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
      sprite.x = line.penX;
      sprite.y = (fontSize * LINE_HEIGHT_FACTOR - box) / 2;
      sprite.width = box;
      sprite.height = box;
      line.content.addChild(sprite);
      line.penX += box;
      line.run = null;
      line.runRole = null;

      PIXI.Assets.load<PIXI.Texture>(url)
        .then((texture) => {
          if (sprite.destroyed) return;
          sprite.texture = texture;
          // Setting a texture resets the sprite's scale-derived size; reassert the box.
          sprite.width = box;
          sprite.height = box;
        })
        .catch(() => {
          // Network failure, dead CDN URL, whatever — draw the name where the image would be, so
          // the message still reads. Scaled down to fit the reserved box, because the box cannot
          // grow (later atoms are already placed after it).
          if (sprite.destroyed) return;
          const label = new PIXI.Text({ text: name, style: style("text") });
          const scale = Math.min(1, box / Math.max(1, label.width));
          label.scale.set(scale);
          label.x = sprite.x + (box - label.width * scale) / 2;
          label.y = sprite.y + (box - label.height * scale) / 2;
          line.content.addChild(label);
          sprite.destroy();
        });
    };

    /** Types one atom onto the current line. Returns false when the line has no atoms left. */
    const typeAtom = (line: Line): boolean => {
      const atom = line.atoms[line.next];
      if (atom === undefined) return false;
      line.next += 1;

      if (atom.kind === "emote") {
        typeEmote(line, atom.name, atom.url);
        return true;
      }

      // Consecutive same-coloured characters share one Text object; a colour change (username →
      // message) or an emote in between starts a fresh run. Appending to a run and reading its
      // width afterwards is what keeps the pen honest without any font-metric arithmetic.
      if (line.run === null || line.runRole !== atom.role) {
        const runStart = line.penX;
        const run = new PIXI.Text({ text: "", style: style(atom.role) });
        run.x = runStart;
        line.content.addChild(run);
        line.run = run;
        line.runRole = atom.role;
      }
      line.run.text += atom.ch;
      line.penX = line.run.x + line.run.width;
      return true;
    };

    /** Redraws the background plate of a line to hug its current content width. */
    const drawPlate = (line: Line): void => {
      const pad = fontSize * PLATE_PADDING_FACTOR;
      const lineHeight = fontSize * LINE_HEIGHT_FACTOR;
      // While typing, leave room for the cursor block at the pen.
      const cursorRoom = line.doneAt === null ? fontSize * 0.6 : 0;
      line.plate
        .clear()
        .roundRect(0, 0, line.penX + cursorRoom + pad * 2, lineHeight, fontSize * 0.25)
        .fill({ color: colorBg, alpha: bgAlpha });
    };

    const cursor = stage.stage.addChild(new PIXI.Graphics());

    const enqueue = (message: ChatMessage): void => {
      queue.push(message);
      if (queue.length > QUEUE_LIMIT) queue.splice(0, queue.length - QUEUE_LIMIT);
    };

    // Seed from history so the overlay is not blank at mount — but only with the last few
    // messages, because typing the full 50-message backlog one character at a time would take
    // minutes before live chat got a turn.
    for (const message of chat.recent().slice(-Math.min(3, lineCount))) enqueue(message);
    const off = chat.onMessage(enqueue);
    scope.defer(off);

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      time += dt;

      // Start the next line when the typist is free.
      if (!typing && queue.length > 0) {
        const message = queue.shift();
        if (message !== undefined) beginLine(message);
      }

      // Type. The carry accumulates fractional atoms; whole ones are spent.
      if (typing) {
        typeCarry += typeSpeed * dt;
        const current = lines[lines.length - 1];
        while (typeCarry >= 1 && current !== undefined) {
          typeCarry -= 1;
          if (!typeAtom(current)) {
            current.doneAt = time;
            typing = false;
            drawPlate(current);
            break;
          }
        }
        if (typing && current !== undefined) drawPlate(current);
      } else {
        // No line in progress: cap the carry so a long quiet spell does not bank enough credit
        // to print the next message instantly, which would break the typewriter illusion.
        typeCarry = Math.min(typeCarry, 1);
      }

      // Age out finished lines and advance fades. Iterated over a copy because a completed fade
      // removes its line from `lines`.
      for (const line of lines.slice()) {
        if (line.doneAt !== null && line.fadeStartedAt === null && time - line.doneAt > fadeAfter) {
          startFade(line);
        }
        if (line.fadeStartedAt !== null) {
          const progress = (time - line.fadeStartedAt) / fadeDuration;
          if (progress >= 1) {
            removeLine(line);
          } else {
            line.container.alpha = 1 - progress;
          }
        }
      }

      // Layout: stack from the bottom-left corner upward, newest at the bottom. Recomputed every
      // frame from the live stage size, which is also what makes resize handling automatic.
      const lineHeight = fontSize * LINE_HEIGHT_FACTOR;
      const edge = fontSize * EDGE_PADDING_FACTOR;
      let y = stage.height - edge - lineHeight;
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i];
        if (line === undefined) continue;
        line.container.x = edge;
        line.container.y = y;
        y -= lineHeight + fontSize * 0.25;
      }

      // The blinking cursor sits at the pen of the line being typed. Half the period on, half
      // off — visible only while typing, because a cursor with nothing to type is noise.
      cursor.clear();
      const current = lines[lines.length - 1];
      if (typing && current !== undefined) {
        const on = (time % CURSOR_BLINK_S) < CURSOR_BLINK_S / 2;
        if (on) {
          cursor
            .rect(
              current.container.x + current.content.x + current.penX + fontSize * 0.1,
              current.container.y + fontSize * (LINE_HEIGHT_FACTOR - 1) / 2,
              fontSize * 0.5,
              fontSize,
            )
            .fill({ color: colorText, alpha: 0.9 });
        }
      }

      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        const previousFontSize = fontSize;
        fontSize = int(p, "fontSize", 22, 10, 72);
        lineCount = int(p, "lineCount", 6, 1, 20);
        typeSpeed = num(p, "typeSpeed", 28, 3, 120);
        fadeAfter = num(p, "fadeAfter", 24, 2, 300);
        fadeDuration = num(p, "fadeDuration", 1.2, 0.1, 10);
        colorText = colorHex(p, "colorText", "#e6e6e6");
        colorUsername = colorHex(p, "colorUsername", "#7fdbca");
        colorBg = colorHex(p, "colorBg", "#0c0f14");
        bgAlpha = num(p, "bgAlpha", 0.55, 0, 1);
        showEmotes = bool(p, "showEmotes", true);

        // A font-size change would misalign every already-placed run and sprite (their positions
        // were measured at the old size), so existing lines are cleared and typing starts fresh.
        // Colour and speed changes apply in place: new plates pick up the colours on their next
        // redraw, and already-typed text keeping its old colour until it fades is acceptable for
        // a live-tuning control.
        if (fontSize !== previousFontSize) {
          for (const line of lines.slice()) removeLine(line);
          typing = false;
          typeCarry = 0;
        }
      },
    };
  },
});

export default chatTyping;
