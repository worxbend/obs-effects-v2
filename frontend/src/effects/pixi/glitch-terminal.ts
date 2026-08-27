import { defineEffect } from "../sdk";
import {
  glitchTerminalParams,
  glitchTerminalSetup,
  type GlitchTerminalLook,
} from "./glitchTerminal";

/**
 * Glitch Terminal
 * ===============
 *
 * The original lime-on-black glitch terminal: circles, crosses and rings churning on a dark grid with periodic tearing.
 *
 * Ported from `glitch-terminal.html` in the old `obs-effects` repository.
 *
 * This file is deliberately almost empty. The drawing lives in `glitchTerminal.ts`, which the old
 * repository also had as `GlitchTerminalBase` — five of its pages were that one class with a
 * different config object. Here that config is the **defaults** of a full parameter set, so this
 * entry is a starting point rather than a fixed look: change the colours and the glyphs and it
 * becomes any of its siblings, or something new.
 */
const LOOK: GlitchTerminalLook = {
  colorText: "#aaff00",
  colorTextDim: "#558800",
  colorBackground: "#000000",
  colorBlock: "#aaff00",
  colorSpark: "#e8ffb0",
  heavy: "\u00a9\u25cb\u25a1\u00d7\u2295\u2297\u2299XO",
  light: "+\u00b7\\\\*\u00d7xo",
  cell: 14,
  fontSize: 14,
  fontFamily: "'Courier New', monospace",
  churnRate: 0.035,
  maxBlocks: 14,
  glitchMin: 30,
  glitchMax: 110,
  blockAlpha: 0.8,
  density: 0.55,
  centerFalloff: 0.2,
  verticalFade: 0.18,
  sparks: false,
};

const glitchTerminalEffect = defineEffect({
  descriptor: {
    id: "glitch-terminal",
    name: "Glitch Terminal",
    description:
      "The original lime-on-black glitch terminal: circles, crosses and rings churning on a dark grid with periodic tearing.",
    engine: "pixi",
    category: "background",
    tags: ["terminal", "glitch", "lime", "background", "retro"],
    previewNotes:
      "The plainest member of the family and a good starting point for your own look \u2014 every colour, glyph set and corruption setting is a parameter. Needs no special font.",
    params: glitchTerminalParams(LOOK),
  },
  setup: glitchTerminalSetup(LOOK),
});

export default glitchTerminalEffect;
