import { defineEffect } from "../sdk";
import { razerWaveformSetup, waveformParams, type WaveformLook } from "./razerWaveform";

/**
 * Audio Waveform Prism
 * ====================
 *
 * A single-sided bank of blue-to-cyan dot columns that collapses to a flat line when the audio goes quiet.
 *
 * Ported from `audio-waveform-razer-prism.html` in the old `obs-effects` repository.
 *
 * The drawing lives in `razerWaveform.ts`. The old repository had eight pages backed by one class
 * with a `variant` string, and that structure is kept: the eight share their entire audio pipeline
 * and differ only in the final draw step. This file is the variant plus its default framing.
 *
 * **The band heights are shaped from loudness, not measured per frequency.** OBS sends no spectrum;
 * see the header of `razerWaveform.ts` for what is real here and what is not.
 */
const LOOK: WaveformLook = {
  variant: "prism",
  amplitude: 1,
  width: 0.68,
  centre: 0.58,
  opacity: 1,
  reactivity: 1,
};

const audioWaveformRazerPrism = defineEffect({
  descriptor: {
    id: "audio-waveform-razer-prism",
    name: "Audio Waveform Prism",
    description:
      "A single-sided bank of blue-to-cyan dot columns that collapses to a flat line when the audio goes quiet.",
    engine: "pixi",
    category: "reactive",
    tags: ["audio", "reactive", "waveform", "razer", "overlay", "cyan"],
    previewNotes:
      "Calmer than the mirrored variants and sits lower in the frame, which suits a lower third. Goes to a single row of dots in silence rather than disappearing.",
    params: waveformParams(LOOK),
  },
  setup: razerWaveformSetup(LOOK),
});

export default audioWaveformRazerPrism;
