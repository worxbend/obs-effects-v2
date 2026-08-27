import { defineEffect } from "../sdk";
import { razerWaveformSetup, waveformParams, type WaveformLook } from "./razerWaveform";

/**
 * Audio Waveform Ribbons
 * ======================
 *
 * Seven layered organic ribbons that swell and thin along their length, with a bright white core running through the middle.
 *
 * Ported from `audio-waveform-razer-ribbons.html` in the old `obs-effects` repository.
 *
 * The drawing lives in `razerWaveform.ts`. The old repository had eight pages backed by one class
 * with a `variant` string, and that structure is kept: the eight share their entire audio pipeline
 * and differ only in the final draw step. This file is the variant plus its default framing.
 *
 * **The band heights are shaped from loudness, not measured per frequency.** OBS sends no spectrum;
 * see the header of `razerWaveform.ts` for what is real here and what is not.
 */
const LOOK: WaveformLook = {
  variant: "ribbons",
  amplitude: 1,
  width: 0.85,
  centre: 0.5,
  opacity: 1,
  reactivity: 1,
};

const audioWaveformRazerRibbons = defineEffect({
  descriptor: {
    id: "audio-waveform-razer-ribbons",
    name: "Audio Waveform Ribbons",
    description:
      "Seven layered organic ribbons that swell and thin along their length, with a bright white core running through the middle.",
    engine: "pixi",
    category: "reactive",
    tags: ["audio", "reactive", "waveform", "razer", "overlay", "ribbons"],
    previewNotes:
      "The richest look in the family and the most expensive: eight filled polygons of 184 segments each, every frame. Lower Width or Opacity before anything else if it costs too much.",
    params: waveformParams(LOOK),
  },
  setup: razerWaveformSetup(LOOK),
});

export default audioWaveformRazerRibbons;
