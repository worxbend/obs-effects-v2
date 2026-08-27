import { defineEffect } from "../sdk";
import {
  glitchTerminalParams,
  glitchTerminalSetup,
  type GlitchTerminalLook,
} from "./glitchTerminal";

/**
 * Red Corrupt
 * ===========
 *
 * A wall of corrupted data in alarm red \u2014 block characters and crosses churning at high frequency, with heavy rectangular corruption tearing through them.
 *
 * Ported from `red-corrupt.html` in the old `obs-effects` repository.
 *
 * This file is deliberately almost empty. The drawing lives in `glitchTerminal.ts`, which the old
 * repository also had as `GlitchTerminalBase` — five of its pages were that one class with a
 * different config object. Here that config is the **defaults** of a full parameter set, so this
 * entry is a starting point rather than a fixed look: change the colours and the glyphs and it
 * becomes any of its siblings, or something new.
 */
const LOOK: GlitchTerminalLook = {
  colorText: "#ff2200",
  colorTextDim: "#770000",
  colorBackground: "#080000",
  colorBlock: "#ff1100",
  colorSpark: "#ffb0a0",
  heavy: "\u2588\u2593\u2592\u2591\u00d7\u2297\u2715X\u25a0\u25aa",
  light: "\u2592\u2591x+-\u00b7\u25ab",
  cell: 14,
  fontSize: 14,
  fontFamily: "'Courier New', monospace",
  churnRate: 0.04,
  maxBlocks: 20,
  glitchMin: 15,
  glitchMax: 70,
  blockAlpha: 1,
  density: 0.72,
  centerFalloff: 0,
  verticalFade: 0,
  sparks: false,
};

const redCorrupt = defineEffect({
  descriptor: {
    id: "red-corrupt",
    name: "Red Corrupt",
    description:
      "A wall of corrupted data in alarm red \u2014 block characters and crosses churning at high frequency, with heavy rectangular corruption tearing through them.",
    engine: "pixi",
    category: "background",
    tags: ["corrupt", "glitch", "red", "error", "background", "terminal"],
    previewNotes:
      "The most aggressive of the terminal family: near-uniform coverage, fully opaque corruption blocks and a glitch every 15 to 70 frames. Reads as something going badly wrong, which is the point. Uses ordinary monospace glyphs, so it needs no special font.",
    params: glitchTerminalParams(LOOK),
  },
  setup: glitchTerminalSetup(LOOK),
});

export default redCorrupt;
