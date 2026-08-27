import { defineEffect } from "../sdk";
import {
  glitchTerminalParams,
  glitchTerminalSetup,
  type GlitchTerminalLook,
} from "./glitchTerminal";

/**
 * Amber Terminal
 * ==============
 *
 * A calm amber CRT: geometric glyphs drifting on a warm near-black field, with occasional gentle tearing. The quietest member of the terminal family.
 *
 * Ported from `amber-terminal.html` in the old `obs-effects` repository.
 *
 * This file is deliberately almost empty. The drawing lives in `glitchTerminal.ts`, which the old
 * repository also had as `GlitchTerminalBase` — five of its pages were that one class with a
 * different config object. Here that config is the **defaults** of a full parameter set, so this
 * entry is a starting point rather than a fixed look: change the colours and the glyphs and it
 * becomes any of its siblings, or something new.
 */
const LOOK: GlitchTerminalLook = {
  colorText: "#ffb000",
  colorTextDim: "#7a4800",
  colorBackground: "#060300",
  colorBlock: "#ff8800",
  colorSpark: "#ffd890",
  heavy: "\u25c6\u25b2\u25bc\u25a0\u25cf\u25c9\u2295\u2297\u25cb\u25a1",
  light: "+\u00b7-*\u00d7xo'`",
  cell: 14,
  fontSize: 14,
  fontFamily: "'Courier New', monospace",
  churnRate: 0.025,
  maxBlocks: 10,
  glitchMin: 50,
  glitchMax: 160,
  blockAlpha: 0.85,
  density: 0.6,
  centerFalloff: 0.25,
  verticalFade: 0.1,
  sparks: false,
};

const amberTerminal = defineEffect({
  descriptor: {
    id: "amber-terminal",
    name: "Amber Terminal",
    description:
      "A calm amber CRT: geometric glyphs drifting on a warm near-black field, with occasional gentle tearing. The quietest member of the terminal family.",
    engine: "pixi",
    category: "background",
    tags: ["terminal", "amber", "retro", "crt", "background", "calm"],
    previewNotes:
      "Included because it is the same effect as the toxic and red terminals with different defaults, and it is the one to reach for when a background should not shout. Centre clearing and a vertical fade keep the middle and lower frame open. Needs no special font.",
    params: glitchTerminalParams(LOOK),
  },
  setup: glitchTerminalSetup(LOOK),
});

export default amberTerminal;
