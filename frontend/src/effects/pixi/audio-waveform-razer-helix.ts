import { defineEffect } from "../sdk";
import { razerWaveformSetup, waveformParams, type WaveformLook } from "./razerWaveform";

/**
 * Audio Waveform Helix
 * ====================
 *
 * Four interleaved sine waves in cyan and magenta, drifting past each other so they braid like a double helix.
 *
 * Ported from `audio-waveform-razer-helix.html` in the old `obs-effects` repository.
 *
 * The drawing lives in `razerWaveform.ts`. The old repository had eight pages backed by one class
 * with a `variant` string, and that structure is kept: the eight share their entire audio pipeline
 * and differ only in the final draw step. This file is the variant plus its default framing.
 *
 * **The band heights are shaped from loudness, not measured per frequency.** OBS sends no spectrum;
 * see the header of `razerWaveform.ts` for what is real here and what is not.
 */
const LOOK: WaveformLook = {
  variant: "helix",
  amplitude: 1,
  width: 0.8,
  centre: 0.5,
  opacity: 1,
  reactivity: 1,
};

const audioWaveformRazerHelix = defineEffect({
  descriptor: {
    id: "audio-waveform-razer-helix",
    name: "Audio Waveform Helix",
    description:
      "Four interleaved sine waves in cyan and magenta, drifting past each other so they braid like a double helix.",
    engine: "pixi",
    category: "reactive",
    tags: ["audio", "reactive", "waveform", "razer", "overlay", "helix"],
    previewNotes:
      "An overlay with a strong centre line. The braiding comes from the four layers running at slightly different frequencies, so it never quite repeats.",
    params: waveformParams(LOOK),
  },
  setup: razerWaveformSetup(LOOK),
});

export default audioWaveformRazerHelix;
