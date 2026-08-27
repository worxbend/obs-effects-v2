import { defineEffect } from "../sdk";
import { razerWaveformSetup, waveformParams, type WaveformLook } from "./razerWaveform";

/**
 * Audio Waveform Ribbon Lattice
 * =============================
 *
 * Thin ribbons crossing at different phases with four stroked waves threaded through them, forming a loose woven lattice.
 *
 * Ported from `audio-waveform-razer-ribbon-lattice.html` in the old `obs-effects` repository.
 *
 * The drawing lives in `razerWaveform.ts`. The old repository had eight pages backed by one class
 * with a `variant` string, and that structure is kept: the eight share their entire audio pipeline
 * and differ only in the final draw step. This file is the variant plus its default framing.
 *
 * **The band heights are shaped from loudness, not measured per frequency.** OBS sends no spectrum;
 * see the header of `razerWaveform.ts` for what is real here and what is not.
 */
const LOOK: WaveformLook = {
  variant: "ribbonLattice",
  amplitude: 1,
  width: 0.84,
  centre: 0.5,
  opacity: 1,
  reactivity: 1,
};

const audioWaveformRazerRibbonLattice = defineEffect({
  descriptor: {
    id: "audio-waveform-razer-ribbon-lattice",
    name: "Audio Waveform Ribbon Lattice",
    description:
      "Thin ribbons crossing at different phases with four stroked waves threaded through them, forming a loose woven lattice.",
    engine: "pixi",
    category: "reactive",
    tags: ["audio", "reactive", "waveform", "razer", "overlay", "lattice"],
    previewNotes:
      "The busiest of the ribbon variants. The crossing comes from each layer using a different row offset, so the ribbons drift in and out of alignment rather than moving together.",
    params: waveformParams(LOOK),
  },
  setup: razerWaveformSetup(LOOK),
});

export default audioWaveformRazerRibbonLattice;
