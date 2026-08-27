import { defineEffect } from "../sdk";
import {
  DEV_ICON_GLYPHS,
  DEV_ICON_GLYPHS_LIGHT,
  glitchTerminalParams,
  glitchTerminalSetup,
  type GlitchTerminalLook,
} from "./glitchTerminal";

/**
 * Toxic Dev Terminal
 * ==================
 *
 * A field of developer icons churning on a dark grid, torn by occasional glitches. The centre is left clearer than the edges, so a camera or a title can sit in front of it.
 *
 * Ported from `toxic-dev-terminal.html` in the old `obs-effects` repository.
 *
 * This file is deliberately almost empty. The drawing lives in `glitchTerminal.ts`, which the old
 * repository also had as `GlitchTerminalBase` — five of its pages were that one class with a
 * different config object. Here that config is the **defaults** of a full parameter set, so this
 * entry is a starting point rather than a fixed look: change the colours and the glyphs and it
 * becomes any of its siblings, or something new.
 */
const LOOK: GlitchTerminalLook = {
  colorText: "#39ff14",
  colorTextDim: "#118c10",
  colorBackground: "#000700",
  colorBlock: "#24ff00",
  colorSpark: "#b7ff9d",
  heavy: DEV_ICON_GLYPHS,
  light: DEV_ICON_GLYPHS_LIGHT,
  cell: 18,
  fontSize: 16,
  fontFamily: "SymbolsNF, monospace",
  churnRate: 0.03,
  maxBlocks: 12,
  glitchMin: 42,
  glitchMax: 130,
  blockAlpha: 0.68,
  density: 0.66,
  centerFalloff: 0.22,
  verticalFade: 0.08,
  sparks: true,
};

const toxicDevTerminal = defineEffect({
  descriptor: {
    id: "toxic-dev-terminal",
    name: "Toxic Dev Terminal",
    description:
      "A field of developer icons churning on a dark grid, torn by occasional glitches. The centre is left clearer than the edges, so a camera or a title can sit in front of it.",
    engine: "pixi",
    category: "background",
    tags: ["toxic", "terminal", "glitch", "dev", "background", "green"],
    previewNotes:
      "Designed as a coding-scene background: Centre Clearing keeps the middle of the frame thin so a webcam can sit there. Needs the bundled SymbolsNF font for the icon glyphs \u2014 change Font and they become ordinary text. Shares its palette with the razer-* family.",
    params: glitchTerminalParams(LOOK),
  },
  setup: glitchTerminalSetup(LOOK),
});

export default toxicDevTerminal;
