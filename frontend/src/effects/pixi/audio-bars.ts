import * as PIXI from "pixi.js";
import { at, bool, colorHex, int, lerp, num, rgb01 } from "../paramUtils";
import { createPixiStage, defineEffect, onFrame, useAudio } from "../sdk";

/**
 * Audio Bars
 * ==========
 *
 * A spectrum analyser: a row of bars whose heights follow the audio OBS is broadcasting.
 *
 * Where the audio comes from
 * --------------------------
 * This effect opens nothing. It asks the SDK for the page's shared audio bus (`useAudio`, in
 * `src/effects/sdk/audio.ts`) and reads numbers out of it.
 *
 * That bus used to be the *browser's microphone*, and now it is OBS's own audio, arriving from the
 * backend over a Server-Sent Events stream. The change is invisible in this file — the same
 * `bus.bands(...)` call fills the same array — which is the whole argument for having put the shared
 * bus in the SDK in the first place: the source of the audio changed completely and no effect had to
 * be rewritten to follow it.
 *
 * It is a much better signal. A microphone hears the room, and in an OBS browser source it usually
 * has no permission at all, so what viewers actually saw was the simulated fallback. OBS's levels
 * are what the audience hears: the game, the music bed, the microphone after the noise gate.
 *
 * The bars are shaped, not measured, and that is worth knowing
 * -----------------------------------------------------------
 * obs-websocket reports **loudness, not a spectrum** — one peak per channel, about twenty times a
 * second, with no frequency information in it at all. So the per-band heights below come from the
 * SDK spreading one real loudness value across the bins with a fixed tilt and a slow wobble. The
 * bars move with the music and the overall height is real; which bar is tallest is not a
 * measurement. The full explanation is at the top of `sdk/audio.ts`.
 *
 * If you want a display driven only by measured numbers, `bus.level` and `bus.peak` are real, and
 * `bus.inputs` carries the per-input, per-channel peaks.
 *
 * The fallback is not a branch here
 * ---------------------------------
 * When no OBS connection is configured, when OBS is closed, or when the stream drops, the bus writes
 * a simulated signal into the same buffers. There is exactly one code path below and it cannot tell
 * the two apart.
 *
 * Smoothing, and why it is measured per second
 * -------------------------------------------
 * Bar heights jitter frame to frame, so every bar's displayed height is an exponential moving
 * average: `shown = shown * s + target * (1 - s)`, where `s` is the share of the old value that is
 * kept. Higher `s` means the bar remembers more of where it was and therefore moves more slowly.
 *
 * That formula applied once per *frame* means the bars glide at one speed on a 60 fps display and a
 * different one on a 144 fps display or under a route's frame-rate cap. The exponent below fixes
 * that: `s ** (dt * 60)` keeps `s` of the old value per sixtieth of a second regardless of how long
 * the frame actually took, so a route capped at 30 fps and an uncapped one settle at the same rate.
 * At 60 fps `dt * 60` is 1 and the expression is exactly the old `s` — which is the point: what
 * people already had saved keeps looking the way it looked.
 */

const audioBars = defineEffect({
  descriptor: {
    id: "audio-bars",
    name: "Audio Bars",
    description:
      "A spectrum analyser driven by OBS's own audio levels, with a colour gradient across the bars, falling back to a smooth simulated waveform when OBS is not connected.",
    engine: "pixi",
    category: "reactive",
    tags: ["audio", "reactive", "visualizer", "overlay", "pixi"],
    previewNotes:
      "Reacts to whatever OBS is playing once the OBS connection is configured under Settings. Until then, and whenever OBS is closed, it shows a simulated waveform. Bar heights are shaped from real loudness rather than measured per frequency \u2014 obs-websocket sends no spectrum.",
    params: [
      {
        key: "barCount",
        label: "Bar Count",
        kind: "number",
        default: 48,
        min: 4,
        max: 256,
        step: 1,
        description: "How many bars to draw across the width of the source.",
      },
      {
        key: "smoothing",
        label: "Smoothing",
        kind: "number",
        default: 0.75,
        min: 0,
        max: 0.98,
        step: 0.01,
        description:
          "How lazily a bar follows the sound. 0 snaps instantly, values near 1 glide slowly.",
      },
      {
        key: "gain",
        label: "Gain",
        kind: "number",
        default: 1.4,
        min: 0.1,
        max: 6,
        step: 0.1,
        description: "Multiplier on bar height. Raise it if quiet audio barely moves the bars.",
      },
      {
        key: "colorStart",
        label: "Start Color",
        kind: "color",
        default: "#00e5ff",
        description: "Colour of the leftmost bar.",
      },
      {
        key: "colorEnd",
        label: "End Color",
        kind: "color",
        default: "#ff2d95",
        description: "Colour of the rightmost bar. Bars in between blend from one to the other.",
      },
      {
        key: "mirrored",
        label: "Mirrored",
        kind: "boolean",
        default: false,
        description:
          "Grow bars from the vertical centre in both directions instead of upwards from the bottom.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    let barCount = int(ctx.params, "barCount", 48, 4, 256);
    let smoothing = num(ctx.params, "smoothing", 0.75, 0, 0.98);
    let gain = num(ctx.params, "gain", 1.4, 0.1, 6);
    let mirrored = bool(ctx.params, "mirrored", false);

    /*
     * The gradient ends, kept as 0..1 red/green/blue triples rather than as the hex strings the
     * parameters carry.
     *
     * The old `barColor` helper called `rgb01(colorStart)` and `rgb01(colorEnd)` inside itself, and
     * `barColor` is called once per bar per frame: with the default 48 bars that was 96 string
     * parses every frame, about 5,800 a second, to produce two values that only ever change when
     * somebody drags a colour picker. Parsing them here and again in `setParams` — the two places a
     * colour can actually change — removes all of that and changes nothing on screen.
     */
    let startRgb = rgb01(colorHex(ctx.params, "colorStart", "#00e5ff"));
    let endRgb = rgb01(colorHex(ctx.params, "colorEnd", "#ff2d95"));

    /** Current on-screen height of each bar, 0..1. Smoothed towards the analysed levels. */
    let shown = new Float32Array(barCount);

    /**
     * Scratch buffer for this frame's analysed levels. It is reused every frame — allocating a new
     * array 60 times a second would give the garbage collector needless work and cause stutters.
     */
    let target = new Float32Array(barCount);

    /*
     * Two awaits, and each one is a point at which the renderer may have disposed this effect
     * already.
     *
     * `createPixiStage` throws `Cancelled` by itself, from a `scope.checkpoint()` it makes
     * internally. `useAudio` does not: it resolves normally on a dead scope, having already
     * registered the release of its lease. So the checkpoint after it is written here by hand, and
     * it is not cosmetic — without it a disposed effect would go on to build a whole Pixi
     * application, and therefore a whole WebGL context, only to destroy it a moment later.
     *
     * `defineEffect` swallows `Cancelled` after the scope has torn down whatever already existed.
     * That is why there is no `disposed` flag, no `ready` flag and no `dispose` method in this file.
     */
    const bus = await useAudio(scope);
    scope.checkpoint();

    const stage = await createPixiStage(scope, ctx);

    // One Graphics object holds all the bars. Redrawing it each frame is a single geometry rebuild,
    // which is far cheaper than keeping hundreds of separate display objects in sync.
    const graphics = stage.stage.addChild(new PIXI.Graphics());

    /** Blends the start and end colours by position, returning a 24-bit colour for Pixi. */
    const barColor = (t: number): number => {
      const r = Math.round(lerp(startRgb[0], endRgb[0], t) * 255);
      const g = Math.round(lerp(startRgb[1], endRgb[1], t) * 255);
      const b = Math.round(lerp(startRgb[2], endRgb[2], t) * 255);
      return (r << 16) | (g << 8) | b;
    };

    onFrame(scope, ctx.fpsCap, ({ dt, now }) => {
      // `sample` refreshes the shared FFT at most once per frame no matter how many effects ask,
      // which is why it takes the tick's `now` rather than reading the clock itself.
      bus.sample(now);
      bus.bands(target);

      // Exponential moving average, in per-second terms. See the note at the top of the file for
      // why the exponent is there and why 60 is the number in it.
      const keep = smoothing <= 0 ? 0 : smoothing ** (dt * 60);
      for (let i = 0; i < barCount; i += 1) {
        shown[i] = at(shown, i) * keep + at(target, i) * (1 - keep);
      }

      const width = stage.width;
      const height = stage.height;
      const slot = width / barCount;
      const barWidth = Math.max(1, slot * 0.7); // 30% of each slot is left as a gap
      const padding = (slot - barWidth) / 2;

      graphics.clear();
      for (let i = 0; i < barCount; i += 1) {
        const value = Math.min(1, at(shown, i) * gain);
        const x = i * slot + padding;
        const color = barColor(barCount === 1 ? 0 : i / (barCount - 1));

        if (mirrored) {
          const half = (value * height) / 2;
          graphics.rect(x, height / 2 - half, barWidth, half * 2).fill({ color, alpha: 0.95 });
        } else {
          const barHeight = value * height;
          graphics.rect(x, height - barHeight, barWidth, barHeight).fill({ color, alpha: 0.95 });
        }
      }

      // Pixi's own ticker is switched off by `createPixiStage` so that this project has exactly one
      // animation loop — the one above, which honours the route's frame-rate cap. Nothing reaches
      // the canvas until this line.
      stage.render();
    });

    // No `resize` here on purpose: the bars are redrawn from scratch every frame from
    // `stage.width` / `stage.height`, and `defineEffect` forwards the renderer's resize to the
    // stage for us.
    return {
      setParams(p: Record<string, unknown>): void {
        smoothing = num(p, "smoothing", 0.75, 0, 0.98);
        gain = num(p, "gain", 1.4, 0.1, 6);
        startRgb = rgb01(colorHex(p, "colorStart", "#00e5ff"));
        endRgb = rgb01(colorHex(p, "colorEnd", "#ff2d95"));
        mirrored = bool(p, "mirrored", false);

        const nextCount = int(p, "barCount", 48, 4, 256);
        if (nextCount !== barCount) {
          // Resample the currently displayed heights into the new array so changing the bar count
          // morphs the shape instead of dropping every bar to zero for a frame.
          const next = new Float32Array(nextCount);
          for (let i = 0; i < nextCount; i += 1) {
            const source = Math.min(barCount - 1, Math.floor((i / nextCount) * barCount));
            next[i] = at(shown, source);
          }
          barCount = nextCount;
          shown = next;
          target = new Float32Array(nextCount);
        }
      },
    };
  },
});

export default audioBars;
