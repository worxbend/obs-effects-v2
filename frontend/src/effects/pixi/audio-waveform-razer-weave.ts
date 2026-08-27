import { defineEffect } from "../sdk";
import { razerWaveformSetup, waveformParams, type WaveformLook } from "./razerWaveform";

/**
 * Audio Waveform Weave
 * ====================
 *
 * A single glowing zigzag running the width of the frame, its teeth growing towards the centre and with the music.
 *
 * Ported from `audio-waveform-razer-weave.html` in the old `obs-effects` repository.
 *
 * The drawing lives in `razerWaveform.ts`. The old repository had eight pages backed by one class
 * with a `variant` string, and that structure is kept: the eight share their entire audio pipeline
 * and differ only in the final draw step. This file is the variant plus its default framing.
 *
 * **The band heights are shaped from loudness, not measured per frequency.** OBS sends no spectrum;
 * see the header of `razerWaveform.ts` for what is real here and what is not.
 */
const LOOK: WaveformLook = {
  variant: "weave",
  amplitude: 1,
  width: 0.76,
  centre: 0.5,
  opacity: 1,
  reactivity: 1,
};

const audioWaveformRazerWeave = defineEffect({
  descriptor: {
    id: "audio-waveform-razer-weave",
    name: "Audio Waveform Weave",
    description:
      "A single glowing zigzag running the width of the frame, its teeth growing towards the centre and with the music.",
    engine: "pixi",
    category: "reactive",
    tags: ["audio", "reactive", "waveform", "razer", "overlay", "line"],
    previewNotes:
      "The lightest member of the family and the cheapest to draw \u2014 one stroked path rather than thousands of dots. Good over busy footage where a solid bank of bars would be too much.",
    params: waveformParams(LOOK),
  },
  setup: razerWaveformSetup(LOOK),
});

export default audioWaveformRazerWeave;
