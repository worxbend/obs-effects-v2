import { defineEffect } from "../sdk";
import {
  DEV_ICON_GLYPHS,
  DEV_ICON_GLYPHS_LIGHT,
  glitchTerminalParams,
  glitchTerminalSetup,
  type GlitchTerminalLook,
} from "./glitchTerminal";

/**
 * Toxic Dev Corrupt
 * =================
 *
 * Toxic Dev Terminal with the corruption turned up: a denser field of developer icons, glitching three times as often and with twice as many blocks tearing through it.
 *
 * Ported from `toxic-dev-corrupt.html` in the old `obs-effects` repository.
 *
 * This file is deliberately almost empty. The drawing lives in `glitchTerminal.ts`, which the old
 * repository also had as `GlitchTerminalBase` — five of its pages were that one class with a
 * different config object. Here that config is the **defaults** of a full parameter set, so this
 * entry is a starting point rather than a fixed look: change the colours and the glyphs and it
 * becomes any of its siblings, or something new.
 */
const LOOK: GlitchTerminalLook = {
  colorText: "#39ff14",
  colorTextDim: "#0f7f10",
  colorBackground: "#000500",
  colorBlock: "#1fff00",
  colorSpark: "#9cff70",
  heavy: DEV_ICON_GLYPHS,
  light: DEV_ICON_GLYPHS_LIGHT,
  cell: 17,
  fontSize: 16,
  fontFamily: "SymbolsNF, monospace",
  churnRate: 0.045,
  maxBlocks: 20,
  glitchMin: 15,
  glitchMax: 70,
  blockAlpha: 0.92,
  density: 0.76,
  centerFalloff: 0,
  verticalFade: 0,
  sparks: true,
};

const toxicDevCorrupt = defineEffect({
  descriptor: {
    id: "toxic-dev-corrupt",
    name: "Toxic Dev Corrupt",
    description:
      "Toxic Dev Terminal with the corruption turned up: a denser field of developer icons, glitching three times as often and with twice as many blocks tearing through it.",
    engine: "pixi",
    category: "background",
    tags: ["toxic", "corrupt", "glitch", "dev", "background", "green"],
    previewNotes:
      "The aggressive sibling of Toxic Dev Terminal. There is no centre clearing here, so it fills the frame \u2014 use it as a full background rather than behind a camera. Needs the bundled SymbolsNF font.",
    params: glitchTerminalParams(LOOK),
  },
  setup: glitchTerminalSetup(LOOK),
});

export default toxicDevCorrupt;
