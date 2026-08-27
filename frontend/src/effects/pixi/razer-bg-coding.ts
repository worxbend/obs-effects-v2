import { defineEffect } from "../sdk";
import {
  DEV_ICON_GLYPHS,
  glitchTerminalParams,
  glitchTerminalSetup,
  type GlitchTerminalLook,
} from "./glitchTerminal";

/**
 * Razer BG Coding
 * ===============
 *
 * A calm, low-motion toxic-green terminal backdrop: dim developer icons drifting slowly behind an
 * editor or a terminal window, with corruption turned almost all the way down.
 *
 * Ported from `razer-bg-coding.html` in the old `obs-effects` repository, where it was another
 * config of the same `GlitchTerminalBase` the toxic and red terminals used — so it shares this
 * build's `glitchTerminal.ts` with them.
 *
 * It is the one member of the family tuned to be *ignored*. The churn is a fifth of Toxic Dev
 * Terminal's, corruption blocks are capped at three, and glitches are 90 to 220 frames apart rather
 * than 42 to 130. Behind a code editor for a three-hour stream, that difference is the whole point:
 * anything livelier pulls the eye off the thing the viewer is meant to be reading.
 */
const LOOK: GlitchTerminalLook = {
  colorText: "#2edb63",
  colorTextDim: "#0a3a1c",
  colorBackground: "#000502",
  colorBlock: "#17a83f",
  colorSpark: "#8bffb0",
  heavy: DEV_ICON_GLYPHS,
  light: DEV_ICON_GLYPHS.slice(0, 10),
  cell: 19,
  fontSize: 15,
  fontFamily: "SymbolsNF, monospace",
  churnRate: 0.018,
  maxBlocks: 3,
  glitchMin: 90,
  glitchMax: 220,
  blockAlpha: 0.34,
  density: 0.42,
  centerFalloff: 0,
  verticalFade: 0,
  sparks: true,
};

const razerBgCoding = defineEffect({
  descriptor: {
    id: "razer-bg-coding",
    name: "Razer BG Coding",
    description:
      "A calm toxic-green terminal backdrop of drifting developer icons, tuned to sit quietly behind an editor for hours without pulling focus.",
    engine: "pixi",
    category: "background",
    tags: ["razer", "background", "terminal", "coding", "calm", "green"],
    previewNotes:
      "The quietest member of the terminal family, on purpose \u2014 it is meant to be ignored. Needs the bundled SymbolsNF font for the icon glyphs. Raise Churn and lower Glitch Gap to turn it into Toxic Dev Terminal.",
    params: glitchTerminalParams(LOOK),
  },
  setup: glitchTerminalSetup(LOOK),
});

export default razerBgCoding;
