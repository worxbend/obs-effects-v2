import { defineEffect } from "../sdk";
import { razerWaveformSetup, waveformParams, type WaveformLook } from "./razerWaveform";

/**
 * Audio Waveform Ribbon Bands
 * ===========================
 *
 * Eight broad ribbons stacked into a single thick band that breathes with the audio, spanning almost the full width of the frame.
 *
 * Ported from `audio-waveform-razer-ribbon-bands.html` in the old `obs-effects` repository.
 *
 * The drawing lives in `razerWaveform.ts`. The old repository had eight pages backed by one class
 * with a `variant` string, and that structure is kept: the eight share their entire audio pipeline
 * and differ only in the final draw step. This file is the variant plus its default framing.
 *
 * **The band heights are shaped from loudness, not measured per frequency.** OBS sends no spectrum;
 * see the header of `razerWaveform.ts` for what is real here and what is not.
 */
const LOOK: WaveformLook = {
  variant: "ribbonBands",
  amplitude: 1,
  width: 0.89,
  centre: 0.5,
  opacity: 1,
  reactivity: 1,
};

const audioWaveformRazerRibbonBands = defineEffect({
  descriptor: {
    id: "audio-waveform-razer-ribbon-bands",
    name: "Audio Waveform Ribbon Bands",
    description:
      "Eight broad ribbons stacked into a single thick band that breathes with the audio, spanning almost the full width of the frame.",
    engine: "pixi",
    category: "reactive",
    tags: ["audio", "reactive", "waveform", "razer", "overlay", "ribbons"],
    previewNotes:
      "Heavier and wider than Ribbons, with no white core. Works as a full-width lower third or as a divider between scene areas.",
    params: waveformParams(LOOK),
  },
  setup: razerWaveformSetup(LOOK),
});

export default audioWaveformRazerRibbonBands;
