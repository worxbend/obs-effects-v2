import { defineEffect } from "../sdk";
import { razerWaveformSetup, waveformParams, type WaveformLook } from "./razerWaveform";

/**
 * Audio Waveform Razer
 * ====================
 *
 * Mirrored columns of dots rising and falling with the audio, coloured yellow through red above the line and magenta through purple below.
 *
 * Ported from `audio-waveform-razer.html` in the old `obs-effects` repository.
 *
 * The drawing lives in `razerWaveform.ts`. The old repository had eight pages backed by one class
 * with a `variant` string, and that structure is kept: the eight share their entire audio pipeline
 * and differ only in the final draw step. This file is the variant plus its default framing.
 *
 * **The band heights are shaped from loudness, not measured per frequency.** OBS sends no spectrum;
 * see the header of `razerWaveform.ts` for what is real here and what is not.
 */
const LOOK: WaveformLook = {
  variant: "pulse",
  amplitude: 1,
  width: 0.78,
  centre: 0.5,
  opacity: 1,
  reactivity: 1,
};

const audioWaveformRazer = defineEffect({
  descriptor: {
    id: "audio-waveform-razer",
    name: "Audio Waveform Razer",
    description:
      "Mirrored columns of dots rising and falling with the audio, coloured yellow through red above the line and magenta through purple below.",
    engine: "pixi",
    category: "reactive",
    tags: ["audio", "reactive", "waveform", "razer", "overlay", "dots"],
    previewNotes:
      "The original of the family. An overlay: transparent by default, so put it over a scene or a lower third. Reacts to OBS audio \u2014 configure the connection under Settings, or it animates on a simulated signal instead.",
    params: waveformParams(LOOK),
  },
  setup: razerWaveformSetup(LOOK),
});

export default audioWaveformRazer;
