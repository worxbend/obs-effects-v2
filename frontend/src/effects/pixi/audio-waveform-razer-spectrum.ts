import { defineEffect } from "../sdk";
import { razerWaveformSetup, waveformParams, type WaveformLook } from "./razerWaveform";

/**
 * Audio Waveform Spectrum
 * =======================
 *
 * Stacked rectangular cells in blue and cyan, the closest thing in the family to a classic bar-graph analyser.
 *
 * Ported from `audio-waveform-razer-spectrum.html` in the old `obs-effects` repository.
 *
 * The drawing lives in `razerWaveform.ts`. The old repository had eight pages backed by one class
 * with a `variant` string, and that structure is kept: the eight share their entire audio pipeline
 * and differ only in the final draw step. This file is the variant plus its default framing.
 *
 * **The band heights are shaped from loudness, not measured per frequency.** OBS sends no spectrum;
 * see the header of `razerWaveform.ts` for what is real here and what is not.
 */
const LOOK: WaveformLook = {
  variant: "spectrum",
  amplitude: 1,
  width: 0.76,
  centre: 0.66,
  opacity: 1,
  reactivity: 1,
};

const audioWaveformRazerSpectrum = defineEffect({
  descriptor: {
    id: "audio-waveform-razer-spectrum",
    name: "Audio Waveform Spectrum",
    description:
      "Stacked rectangular cells in blue and cyan, the closest thing in the family to a classic bar-graph analyser.",
    engine: "pixi",
    category: "reactive",
    tags: ["audio", "reactive", "waveform", "razer", "overlay", "bars"],
    previewNotes:
      "Reads as a spectrum analyser, but the band heights are shaped from loudness rather than measured per frequency \u2014 obs-websocket sends no spectrum. Do not label it as showing frequencies.",
    params: waveformParams(LOOK),
  },
  setup: razerWaveformSetup(LOOK),
});

export default audioWaveformRazerSpectrum;
