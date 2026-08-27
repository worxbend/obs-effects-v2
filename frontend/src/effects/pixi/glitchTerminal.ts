import * as PIXI from "pixi.js";

import type { EffectContext, ParamSpec } from "../types";
import { bool, colorHex, int, num, str } from "../paramUtils";
import { createPixiStage, onFrame, useFont, type EffectHandle, type Scope } from "../sdk";

/**
 * The shared "glitch terminal" implementation: a grid of glyphs that churns, tears and corrupts.
 *
 * ## What it is
 *
 * A field of characters on a fixed grid, each one chosen at random from a set weighted by an
 * invisible *density* map, so the screen has drifts of dense and sparse text rather than an even
 * wall of noise. On top of that, three kinds of corruption:
 *
 *   - **Churn** — a small share of cells are re-rolled every few frames, so the text is never still.
 *   - **Row tearing** — an occasional row is shoved sideways, the way a corrupted scanline looks.
 *   - **Corruption blocks** — solid rectangles that flash on and fade out, plus bursts that
 *     scramble a band of rows outright.
 *
 * ## Why one file draws five effects
 *
 * The old repository had `GlitchTerminalBase` and four subclasses — Toxic Dev Terminal, Toxic Dev
 * Corrupt, Red Corrupt, Amber Terminal — that differed only in a config object: colours, glyph set,
 * cell size, and how aggressive the corruption is. A fifth, Glitch Terminal, was a near-identical
 * copy of the same idea with its own hard-coded constants.
 *
 * Rather than five almost-identical effect files, there is one implementation here and five thin
 * wrappers that differ in their **defaults**. Every one of those config values is a parameter, so
 * the wrappers are starting points rather than fixed looks: the Red Corrupt entry is Glitch Terminal
 * with red defaults and heavier corruption, and an operator can drag it anywhere from there.
 *
 * ## Why a 2D canvas inside a Pixi sprite, rather than Pixi text objects
 *
 * A full-screen grid at the default cell size is around 10,000 glyphs. Ten thousand `PIXI.Text`
 * objects would each own a texture and a draw call, which is exactly the mistake that makes
 * `digital-rain` the most expensive effect in this build.
 *
 * Instead the whole grid is drawn once per frame into an offscreen 2D canvas — where drawing ten
 * thousand characters is one thing the browser's text engine is genuinely fast at — and that canvas
 * is uploaded as a single texture on a single sprite. One draw call, whatever the glyph count.
 */

/** A named look: the defaults one wrapper effect starts from. */
export interface GlitchTerminalLook {
  colorText: string;
  colorTextDim: string;
  colorBackground: string;
  colorBlock: string;
  colorSpark: string;
  /** Glyphs used where the density map is high. */
  heavy: string;
  /** Glyphs used where it is low. */
  light: string;
  cell: number;
  fontSize: number;
  fontFamily: string;
  churnRate: number;
  maxBlocks: number;
  glitchMin: number;
  glitchMax: number;
  blockAlpha: number;
  density: number;
  centerFalloff: number;
  verticalFade: number;
  sparks: boolean;
}

/**
 * The Nerd Font icon glyphs the "dev" looks use — code, git branch, terminal, rocket, bug and so
 * on. They are private-use code points, so they render as boxes in any font that is not the symbol
 * font; that is why `styles/fonts.css` ships `SymbolsNF` with the application rather than trusting
 * whatever the machine has.
 */
export const DEV_ICON_GLYPHS: string = [
  "\uF121", // code
  "\uF126", // git branch
  "\uF09B", // github
  "\uF120", // terminal
  "\uF013", // cog
  "\uF135", // rocket
  "\uF0E7", // bolt
  "\uF259", // atom
  "\uF292", // shield
  "\uF188", // bug
  "\uF1C0", // database
  "\uF233", // cloud
  "\uF109", // laptop
  "\uF11C", // file-code
  "\uF17C", // sitemap
  "\uF0AD", // wrench
  "\uF0C3", // folder
  "\uF1EB", // link
  "\uF108", // desktop
  "\uF200", // cube
  "\uF201", // cubes
  "\uF1B2", // tag
  "\uF1C9", // list
  "\uF023", // lock
  "\uF09C", // key
  "\uE0B0", // powerline right
  "\uE0B2", // powerline left
].join("");

/** The first fifteen of them, for the sparse parts of the field, as the original look used. */
export const DEV_ICON_GLYPHS_LIGHT: string = DEV_ICON_GLYPHS.slice(0, 15);

/**
 * Every parameter the implementation reads, built from one look's values as the defaults.
 *
 * Generated rather than written out five times, so a new control appears on all five effects at
 * once and cannot be added to four of them.
 */
export function glitchTerminalParams(look: GlitchTerminalLook): ParamSpec[] {
  return [
    {
      key: "colorText",
      label: "Text Colour",
      kind: "color",
      default: look.colorText,
      description: "Glyphs in the dense parts of the field.",
    },
    {
      key: "colorTextDim",
      label: "Dim Text Colour",
      kind: "color",
      default: look.colorTextDim,
      description:
        "Glyphs in the sparse parts. The gap between this and Text Colour is what gives the field depth — set them the same for a flat, uniform wall of text.",
    },
    {
      key: "colorBackground",
      label: "Background Colour",
      kind: "color",
      default: look.colorBackground,
      description:
        "Fills the whole frame. Use a near-black rather than pure black to keep some warmth.",
    },
    {
      key: "backgroundAlpha",
      label: "Background Opacity",
      kind: "number",
      default: 1,
      min: 0,
      max: 1,
      step: 0.05,
      description:
        "Drop below 1 to let a camera or another effect show through behind the text. At 0 the background is fully transparent and only the glyphs are drawn.",
    },
    {
      key: "colorBlock",
      label: "Corruption Colour",
      kind: "color",
      default: look.colorBlock,
      description: "The solid rectangles that flash over the text.",
    },
    {
      key: "colorSpark",
      label: "Spark Colour",
      kind: "color",
      default: look.colorSpark,
      description: "Colour of the scattered two-pixel sparks. Only used when Sparks is on.",
    },
    {
      key: "heavy",
      label: "Dense Glyphs",
      kind: "text",
      default: look.heavy,
      description:
        "Characters used where the field is dense — type any set you like. Every character counts as one option, so repeating one makes it more likely.",
    },
    {
      key: "light",
      label: "Sparse Glyphs",
      kind: "text",
      default: look.light,
      description:
        "Characters used where the field is thin. Usually lighter marks than the dense set.",
    },
    {
      key: "cell",
      label: "Cell Size",
      kind: "number",
      default: look.cell,
      min: 6,
      max: 48,
      step: 1,
      description:
        "Grid pitch in pixels. This is the performance control: halving it quadruples the glyph count.",
    },
    {
      key: "fontSize",
      label: "Font Size",
      kind: "number",
      default: look.fontSize,
      min: 6,
      max: 48,
      step: 1,
      description:
        "Usually a little under Cell Size. Larger than the cell makes glyphs collide, which is a legitimate look.",
    },
    {
      key: "fontFamily",
      label: "Font",
      kind: "text",
      default: look.fontFamily,
      description:
        "A CSS font family. `SymbolsNF` is the bundled Nerd Font that draws the developer icons; anything the machine has also works.",
    },
    {
      key: "density",
      label: "Density",
      kind: "number",
      default: look.density,
      min: 0.2,
      max: 1.2,
      step: 0.01,
      description:
        "How much of the grid is filled overall. Low values leave scattered islands of text; high values fill the frame.",
    },
    {
      key: "centerFalloff",
      label: "Centre Clearing",
      kind: "number",
      default: look.centerFalloff,
      min: 0,
      max: 0.6,
      step: 0.01,
      description:
        "Thins the text out towards the middle of the frame, leaving room for a camera or a title. 0 fills the centre like everywhere else.",
    },
    {
      key: "verticalFade",
      label: "Vertical Fade",
      kind: "number",
      default: look.verticalFade,
      min: -0.4,
      max: 0.4,
      step: 0.01,
      description:
        "Thins the text towards the bottom of the frame. Negative values thin it towards the top instead.",
    },
    {
      key: "churnRate",
      label: "Churn",
      kind: "number",
      default: look.churnRate,
      min: 0,
      max: 0.3,
      step: 0.005,
      description:
        "Share of cells re-rolled on each churn tick. 0 freezes the text; high values make it boil.",
    },
    {
      key: "glitchMin",
      label: "Glitch Gap (min)",
      kind: "number",
      default: look.glitchMin,
      min: 2,
      max: 300,
      step: 1,
      description: "Fewest frames between corruption events. Lower means more frequent.",
    },
    {
      key: "glitchMax",
      label: "Glitch Gap (max)",
      kind: "number",
      default: look.glitchMax,
      min: 4,
      max: 600,
      step: 1,
      description:
        "Most frames between corruption events. Set it close to the minimum for a metronomic glitch, far apart for an unpredictable one.",
    },
    {
      key: "maxBlocks",
      label: "Max Corruption Blocks",
      kind: "number",
      default: look.maxBlocks,
      min: 0,
      max: 60,
      step: 1,
      description: "How many solid rectangles may be on screen at once. 0 disables them entirely.",
    },
    {
      key: "blockAlpha",
      label: "Corruption Opacity",
      kind: "number",
      default: look.blockAlpha,
      min: 0,
      max: 1,
      step: 0.02,
      description: "How opaque those rectangles are at their peak.",
    },
    {
      key: "sparks",
      label: "Sparks",
      kind: "boolean",
      default: look.sparks,
      description: "Scatter bright two-pixel dots over the frame every other pair of frames.",
    },
  ];
}

/** One live corruption rectangle. */
interface Block {
  x: number;
  y: number;
  w: number;
  h: number;
  ttl: number;
  maxTtl: number;
}

/** Everything read from the parameters, resolved once per change rather than per frame. */
interface Settings {
  colorText: string;
  colorTextDim: string;
  colorBackground: string;
  backgroundAlpha: number;
  colorBlock: string;
  colorSpark: string;
  heavy: string[];
  light: string[];
  all: string[];
  cell: number;
  font: string;
  density: number;
  centerFalloff: number;
  verticalFade: number;
  churnRate: number;
  glitchMin: number;
  glitchMax: number;
  maxBlocks: number;
  blockAlpha: number;
  sparks: boolean;
}

/** Splits a glyph string into characters, never returning an empty set. */
function glyphs(value: string, fallback: string): string[] {
  // Spread rather than `split("")` so a character outside the Basic Multilingual Plane — an emoji,
  // say — stays one glyph instead of being cut into two broken halves.
  const chars = [...value].filter((c) => c !== " ");
  return chars.length > 0 ? chars : [...fallback];
}

function readSettings(p: Record<string, unknown>, look: GlitchTerminalLook): Settings {
  const heavy = glyphs(str(p, "heavy", look.heavy), look.heavy);
  const light = glyphs(str(p, "light", look.light), look.light);
  const glitchMin = int(p, "glitchMin", look.glitchMin, 2, 300);
  const glitchMax = int(p, "glitchMax", look.glitchMax, 4, 600);

  return {
    colorText: colorHex(p, "colorText", look.colorText),
    colorTextDim: colorHex(p, "colorTextDim", look.colorTextDim),
    colorBackground: colorHex(p, "colorBackground", look.colorBackground),
    backgroundAlpha: num(p, "backgroundAlpha", 1, 0, 1),
    colorBlock: colorHex(p, "colorBlock", look.colorBlock),
    colorSpark: colorHex(p, "colorSpark", look.colorSpark),
    heavy,
    light,
    all: [...heavy, ...light],
    cell: int(p, "cell", look.cell, 6, 48),
    font: `${int(p, "fontSize", look.fontSize, 6, 48)}px ${str(p, "fontFamily", look.fontFamily)}`,
    density: num(p, "density", look.density, 0.2, 1.2),
    centerFalloff: num(p, "centerFalloff", look.centerFalloff, 0, 0.6),
    verticalFade: num(p, "verticalFade", look.verticalFade, -0.4, 0.4),
    churnRate: num(p, "churnRate", look.churnRate, 0, 0.3),
    glitchMin,
    // Guard the order rather than trusting it: these are two independent sliders, and a maximum
    // below the minimum would make the random gap negative and fire a glitch every single frame.
    glitchMax: Math.max(glitchMax, glitchMin + 1),
    maxBlocks: int(p, "maxBlocks", look.maxBlocks, 0, 60),
    blockAlpha: num(p, "blockAlpha", look.blockAlpha, 0, 1),
    sparks: bool(p, "sparks", look.sparks),
  };
}

/**
 * Builds the effect's `mount` half for one look.
 *
 * Exported for the five wrapper files; nothing else should call it.
 */
export function glitchTerminalSetup(
  look: GlitchTerminalLook,
): (args: { ctx: EffectContext; scope: Scope }) => Promise<EffectHandle> {
  return async ({ ctx, scope }): Promise<EffectHandle> => {
    let settings = readSettings(ctx.params, look);

    // Wait for the glyph font before measuring or drawing anything. Without this the first second
    // is drawn in a substituted font — for the icon looks, a grid of "missing character" boxes.
    await useFont(settings.font);
    scope.checkpoint();

    const stage = await createPixiStage(scope, ctx, { antialias: false });

    /*
     * The offscreen canvas the grid is drawn into, and the Pixi texture wrapping it.
     *
     * `scope.own` rather than `ownDisposable`: a canvas element has no `dispose()`. Shrinking it to
     * 1×1 on teardown is not superstition — a detached 1920×1080 canvas holds about 8 MB of backing
     * store until the garbage collector gets to it, and this effect is remounted on every parameter
     * change that rebuilds the grid.
     */
    const canvas = scope.own(document.createElement("canvas"), (c) => {
      c.width = 1;
      c.height = 1;
    });
    canvas.width = Math.max(1, Math.round(ctx.width));
    canvas.height = Math.max(1, Math.round(ctx.height));

    const context = canvas.getContext("2d");
    if (context === null) {
      // No 2D context at all. Nothing sensible to draw; say so once and leave a blank sprite rather
      // than throwing, because a thrown effect takes the whole delivery page down.
      console.error(
        "[glitch-terminal] Could not get a 2D drawing context; the effect will be blank.",
      );
      return { setParams(): void {}, resize(): void {} };
    }

    /*
     * The texture is built from an explicit `CanvasSource` rather than `Texture.from(canvas)`.
     *
     * Both produce the same thing at runtime, but `Texture.from` is typed as returning a texture
     * whose `source` is the general base type, and the per-frame `source.update()` this effect
     * depends on is not on it — the old repository reached for `as any` and an eslint-disable at
     * exactly this line. Naming the source type keeps the upload call type-checked.
     */
    /*
     * `scope.own` with an explicit teardown, not `ownDisposable`: Pixi objects have `destroy()`,
     * not `dispose()`, so they do not fit that helper's constraint.
     *
     * Registration order matters, because the scope tears down in reverse. The source is registered
     * first and the texture second, so the texture is destroyed first — destroying a source out
     * from under a live texture is how you get a renderer holding a freed GPU handle.
     *
     * `texture.destroy(false)` leaves the source alone for exactly that reason: it is owned
     * separately, one line above.
     */
    const source = scope.own(new PIXI.CanvasSource({ resource: canvas }), (s) => s.destroy());
    const texture = scope.own(new PIXI.Texture({ source }), (t) => t.destroy(false));
    const sprite = stage.stage.addChild(new PIXI.Sprite(texture));

    let cols = 0;
    let rows = 0;
    let grid: string[] = [];
    let density = new Float32Array(0);

    const blocks: Block[] = [];
    const tornRows = new Map<number, { offset: number; ttl: number }>();

    let frame = 0;
    let nextGlitchAt = 60;

    /** Picks a glyph for one cell, or `""` for an empty one. */
    const pickGlyph = (value: number): string => {
      if (value < 0.12) return "";
      if (value < 0.3) return Math.random() < 0.4 ? (settings.light[0] ?? "·") : "";
      const set = value < 0.5 ? settings.light : settings.heavy;
      return set[Math.floor(Math.random() * set.length)] ?? "";
    };

    /**
     * Rebuilds the grid and its density map for the current size and settings.
     *
     * The density map is three sine waves at unrelated frequencies, minus two shaping terms: one
     * that clears the centre of the frame and one that fades towards the bottom. Those two are what
     * make the difference between a wall of text and a background you can put a camera in front of,
     * which is why they are parameters rather than constants.
     */
    const buildGrid = (): void => {
      const width = canvas.width;
      const height = canvas.height;
      cols = Math.ceil(width / settings.cell) + 1;
      rows = Math.ceil(height / settings.cell) + 1;

      const count = cols * rows;
      density = new Float32Array(count);
      grid = new Array<string>(count).fill("");

      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
          const xn = col / cols;
          const yn = row / rows;
          const centre = Math.pow(Math.abs(xn - 0.5) * 2, 1.35);
          const value =
            settings.density +
            0.24 * Math.sin(xn * 8.6 + yn * 5.7) +
            0.13 * Math.sin(xn * 19.1 - yn * 12.4) +
            0.08 * Math.cos(xn * 4.8 + yn * 3.9) -
            settings.centerFalloff * centre -
            settings.verticalFade * yn;

          const clamped = Math.max(0, Math.min(1, value));
          const index = row * cols + col;
          density[index] = clamped;
          grid[index] = pickGlyph(clamped);
        }
      }
    };

    buildGrid();

    stage.onResize((w, h) => {
      canvas.width = Math.max(1, Math.round(w));
      canvas.height = Math.max(1, Math.round(h));
      sprite.width = w;
      sprite.height = h;
      buildGrid();
    });
    sprite.width = stage.width;
    sprite.height = stage.height;

    /** Re-rolls a share of the cells, so the text is never still. */
    const churn = (): void => {
      const count = Math.floor(grid.length * settings.churnRate);
      for (let i = 0; i < count; i += 1) {
        const index = Math.floor(Math.random() * grid.length);
        grid[index] = pickGlyph(density[index] ?? 0);
      }
    };

    /** Ages the corruption rectangles and occasionally adds one. */
    const tickBlocks = (dt: number): void => {
      for (let i = blocks.length - 1; i >= 0; i -= 1) {
        const block = blocks[i];
        if (block === undefined) continue;
        block.ttl -= dt;
        if (block.ttl <= 0) blocks.splice(i, 1);
      }

      if (Math.random() < 0.015 && blocks.length < settings.maxBlocks) {
        const w = 40 + Math.floor(Math.random() * 220);
        const h = 20 + Math.floor(Math.random() * 140);
        blocks.push({
          x: Math.floor(Math.random() * Math.max(1, canvas.width - w)),
          y: Math.floor(Math.random() * Math.max(1, canvas.height - h)),
          w,
          h,
          ttl: 0.3 + Math.random() * 1.8,
          maxTtl: 2,
        });
      }
    };

    /** Fires a corruption event when the frame counter reaches the next scheduled one. */
    const tickGlitch = (): void => {
      for (const [row, torn] of tornRows) {
        torn.ttl -= 1;
        if (torn.ttl <= 0) tornRows.delete(row);
      }

      if (frame < nextGlitchAt) return;

      const kind = Math.floor(Math.random() * 3);
      if (kind === 0) {
        // Shove one row sideways — a torn scanline.
        tornRows.set(Math.floor(Math.random() * rows), {
          offset: (Math.random() < 0.5 ? 1 : -1) * (20 + Math.floor(Math.random() * 80)),
          ttl: 4 + Math.floor(Math.random() * 8),
        });
      } else if (kind === 1) {
        // Scramble a band of rows outright, ignoring their density.
        const start = Math.floor(Math.random() * rows);
        const height = 1 + Math.floor(Math.random() * 3);
        for (let row = start; row < Math.min(rows, start + height); row += 1) {
          for (let col = 0; col < cols; col += 1) {
            grid[row * cols + col] =
              settings.all[Math.floor(Math.random() * settings.all.length)] ?? "";
          }
        }
      } else if (blocks.length < settings.maxBlocks + 3 && settings.maxBlocks > 0) {
        // A bigger, shorter-lived rectangle than the ambient ones.
        const w = 80 + Math.floor(Math.random() * 300);
        const h = 30 + Math.floor(Math.random() * 120);
        blocks.push({
          x: Math.floor(Math.random() * Math.max(1, canvas.width - w)),
          y: Math.floor(Math.random() * Math.max(1, canvas.height - h)),
          w,
          h,
          ttl: 0.15 + Math.random() * 0.6,
          maxTtl: 0.8,
        });
      }

      nextGlitchAt =
        frame +
        settings.glitchMin +
        Math.floor(Math.random() * (settings.glitchMax - settings.glitchMin));
    };

    /** Draws the whole frame into the offscreen canvas. */
    const paint = (): void => {
      const width = canvas.width;
      const height = canvas.height;

      context.clearRect(0, 0, width, height);
      if (settings.backgroundAlpha > 0) {
        context.globalAlpha = settings.backgroundAlpha;
        context.fillStyle = settings.colorBackground;
        context.fillRect(0, 0, width, height);
        context.globalAlpha = 1;
      }

      for (const block of blocks) {
        // Fade in and out from both ends of the lifetime, so a rectangle never pops.
        const fade = Math.min(1, block.ttl * 6, (block.maxTtl - block.ttl + 0.001) * 6);
        context.globalAlpha = Math.min(settings.blockAlpha, fade);
        context.fillStyle = settings.colorBlock;
        context.fillRect(block.x, block.y, block.w, block.h);
      }
      context.globalAlpha = 1;

      context.font = settings.font;
      context.textBaseline = "top";

      for (let row = 0; row < rows; row += 1) {
        const offset = tornRows.get(row)?.offset ?? 0;
        for (let col = 0; col < cols; col += 1) {
          const index = row * cols + col;
          const glyph = grid[index];
          if (glyph === undefined || glyph === "") continue;
          context.fillStyle =
            (density[index] ?? 0) > 0.55 ? settings.colorText : settings.colorTextDim;
          context.fillText(glyph, col * settings.cell + offset, row * settings.cell);
        }
      }

      // Sparks appear for two frames out of every four, which reads as a flicker rather than a
      // steady dusting.
      if (settings.sparks && frame % 4 < 2) {
        context.fillStyle = settings.colorSpark;
        for (let i = 0; i < 30; i += 1) {
          context.fillRect(
            Math.floor(Math.random() * width),
            Math.floor(Math.random() * height),
            2,
            2,
          );
        }
      }

      // Tell Pixi the canvas behind the texture changed. Without this the sprite keeps showing the
      // very first frame for ever, which looks exactly like a frozen effect.
      source.update();
    };

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      frame += 1;
      tickBlocks(dt);
      tickGlitch();
      // Every third frame, as the original did: churning every frame makes the text illegible
      // static rather than a terminal.
      if (frame % 3 === 0) churn();
      paint();
      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        const previous = settings;
        settings = readSettings(p, look);

        // Only rebuild the grid when something that defines its shape changed. A colour or a churn
        // rate can be applied to the running grid; a different cell size or density map cannot,
        // because the arrays are the wrong length or hold glyphs drawn from the wrong distribution.
        if (
          settings.cell !== previous.cell ||
          settings.density !== previous.density ||
          settings.centerFalloff !== previous.centerFalloff ||
          settings.verticalFade !== previous.verticalFade ||
          settings.heavy.join("") !== previous.heavy.join("") ||
          settings.light.join("") !== previous.light.join("")
        ) {
          buildGrid();
        }
      },
    };
  };
}
