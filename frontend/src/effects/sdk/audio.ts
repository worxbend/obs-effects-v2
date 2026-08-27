/**
 * The shared audio input: **the audio OBS is broadcasting**, delivered over one Server-Sent Events
 * stream for the whole page.
 *
 * ## What changed, and why it is a much better source
 *
 * This used to open the *browser's* microphone with `getUserMedia`. That was the wrong source, and
 * it barely worked where it mattered:
 *
 *   - An OBS browser source normally has no microphone permission, and `getUserMedia` needs a
 *     secure context even to be offered. So on the machine this project exists for, the real path
 *     almost never ran — every overlay danced to a simulated signal.
 *   - Even with permission, a microphone hears *the room*. What a stream overlay should react to is
 *     what the audience hears: the desktop audio, the game, the music bed, the microphone after the
 *     noise gate and the compressor. That is a completely different signal, and it is the one OBS
 *     already has.
 *
 * So the levels now come from OBS itself. The backend holds one `obs-websocket` connection and
 * republishes what it hears; this file reads that stream. Effects call {@link useAudio} exactly as
 * before and never touch `getUserMedia` — nothing in an effect file needs to know any of this
 * happened.
 *
 * ## The honest limitation, stated up front
 *
 * **obs-websocket reports loudness, not a spectrum.** Its volume-meter event carries a peak value
 * per channel per input, roughly twenty times a second, and nothing else. There is no Fast Fourier
 * Transform anywhere in the protocol, so there is no way to know how much of a sound was bass and
 * how much was cymbals.
 *
 * That matters because {@link AudioBus.frequency} and {@link AudioBus.bands} exist and effects draw
 * spectra with them. They are still there, they still move with the music, and they are **derived,
 * not measured**: {@link shapeSpectrum} spreads the one real loudness number across the bins using a
 * fixed spectral tilt plus slow per-bin wobble, so a bar display looks alive and plausible.
 *
 * Read that as the deal it is. You gain: real program audio, on every machine, with no permission
 * prompt, matching what the audience actually hears. You lose: true per-frequency detail. For the
 * overlays this platform draws — pulses, rings, bars, glows — the loudness is what was carrying the
 * effect anyway. If you want honesty in an effect, use {@link AudioBus.peak} and
 * {@link AudioBus.level}, which are measured, and say so in the effect's description.
 *
 * ## Why an interpolator sits between the stream and the frame loop
 *
 * OBS sends about twenty measurements a second; effects draw sixty frames a second. Feeding the raw
 * value straight through makes every third frame jump, which reads as a stutter rather than as a
 * beat. {@link sample} therefore eases towards the newest measurement rather than snapping to it,
 * with a fast attack and a slower release — the same asymmetry a hardware VU meter has, and for the
 * same reason: a transient should arrive instantly and decay smoothly.
 *
 * ## The fallback is not a branch, which is still the best part
 *
 * When no OBS connection is configured, when OBS is closed, or when the stream drops, the bus
 * **writes a simulated signal into the same buffers**. Consumers have exactly one code path and
 * cannot tell the difference; `bus.source` is there only so an effect can say so in a corner if it
 * wants to. That was true of the microphone version and it is true here.
 */

import { audioLevelsUrl } from "~/api/client";
import type { AudioLevels } from "~/types/contract";
import { at } from "../paramUtils";
import { publishDebug } from "./debug";
import { createSharedResource, type SharedResource } from "./lease";
import type { Scope } from "./scope";

/** How many frequency bins the derived spectrum has. Matches the old FFT's usable bin count, so any
 * effect that sized a buffer from `bus.frequency.length` is unaffected. */
const BIN_COUNT = 512;

/** Samples in the derived waveform. Same size as the old analyser's time-domain buffer. */
const WAVEFORM_SIZE = 1024;

/** How long the stream may deliver nothing before the simulated signal takes over.
 *
 * The backend sends a heartbeat every five seconds even when OBS is silent, so a stream that is
 * genuinely alive never trips this. Six seconds is one heartbeat plus a second of slack. */
const STALE_AFTER_MS = 6000;

/** Seconds for the level to rise towards a louder measurement. Small: a beat must land on time. */
const ATTACK_SECONDS = 0.02;

/** Seconds for the level to fall towards a quieter one. Larger, so a decay looks like a decay. */
const RELEASE_SECONDS = 0.18;

/** One audio input's measured loudness, re-exported so effects need not import from the contract. */
export interface AudioInput {
  readonly inputName: string;
  /** The loudest channel of this input, 0..1. Measured. */
  readonly peak: number;
  /** Per-channel peaks, in the order OBS reported them. A stereo input has two. Measured. */
  readonly channels: readonly number[];
}

/** The audio a consumer sees. One instance exists per page, whatever `source` says. */
export interface AudioBus {
  /**
   * A spectrum: one byte, 0..255, per bin, `BIN_COUNT` entries long, low frequencies first.
   *
   * **Derived, not measured** — see the note at the top of this file. Its overall energy follows the
   * real loudness; the distribution across bins is a plausible shape, not a measurement. Refreshed
   * at most once per animation frame by {@link sample}. Read it, never write it.
   *
   * The type is written `Uint8Array<ArrayBuffer>` rather than the shorter `Uint8Array` for the same
   * reason it always was: the plain name also allows memory shared with a worker thread, and being
   * explicit keeps this assignable everywhere the old FFT buffer was.
   */
  readonly frequency: Uint8Array<ArrayBuffer>;
  /**
   * A waveform: one byte per sample, 128 being silence.
   *
   * **Derived, not measured**, and more so than the spectrum: OBS sends no sample data at all, so
   * this is an oscillating shape whose amplitude follows the real level. Use it for a ribbon or an
   * oscilloscope line where the *motion* is the point.
   */
  readonly waveform: Uint8Array<ArrayBuffer>;
  /**
   * Broadband loudness, 0..1, smoothed with the attack/release curve described above.
   *
   * **Measured.** This is the number to drive a pulse, a bloom or a scale with, and the one to
   * prefer whenever you can — it is the real signal.
   */
  readonly level: number;
  /**
   * The newest measured peak, 0..1, with no smoothing at all.
   *
   * **Measured.** Use this when you want to detect a transient yourself rather than take the eased
   * value — beat detection, a gate, a threshold trigger.
   */
  readonly peak: number;
  /**
   * Every audio input OBS reported in the last measurement, with their own levels.
   *
   * **Measured.** Empty when the source is simulated. This is what a two-channel or per-source
   * effect needs — a stereo VU pair, a per-input meter strip — and it cannot be reconstructed from
   * the single summed number.
   */
  readonly inputs: readonly AudioInput[];
  /**
   * Where the numbers come from. `"obs"` when the stream is delivering real measurements;
   * `"simulated"` when there is no connection, OBS is closed, or the stream has gone stale.
   *
   * It can change at any time in either direction. Do not cache it.
   */
  readonly source: "obs" | "simulated";
  /**
   * Averages the spectrum down into `out.length` bands and writes them as 0..1 values.
   *
   * The slicing is on a **squared** curve rather than a linear one, because human hearing is roughly
   * logarithmic: a linear slice puts almost everything interesting into the first two bands and
   * leaves the rest nearly flat. This is the bin-slicing `audio-bars` did by hand, unchanged from
   * the microphone era, so effects that used it keep their exact look.
   *
   * `out` is written in place, so allocate it once and reuse it — allocating a `Float32Array` sixty
   * times a second is needless work for the garbage collector and shows up as stutter.
   */
  bands(out: Float32Array): void;
  /**
   * Refreshes everything if this frame has not been sampled yet, and does nothing if it has.
   *
   * Every consumer calls it, every frame, passing the `now` from its `FrameInfo`. Because `now` is
   * the same value for every subscriber in a tick, the work happens once per frame no matter how
   * many effects are listening. Calling it is the only thing you must remember to do.
   */
  sample(now: number): void;
}

/** Everything the page-wide audio connection owns, so `destroy` can take it all down. */
interface AudioFeed {
  bus: AudioBus;
  close(): void;
}

/**
 * Spreads one loudness value across the spectrum bins.
 *
 * Two ingredients, and neither is a measurement:
 *
 *   - a **tilt**, so low bins are louder than high ones. Real music has far more energy at the
 *     bottom, and a flat spectrum reads instantly as fake.
 *   - a slow **wobble** per bin, at a rate that is not a multiple of any other, so neighbouring bars
 *     do not move as one rigid block. Without it the display looks like a single shape being
 *     scaled, which is exactly what it would be.
 *
 * `energy` scales the whole thing, so silence is silent and a loud passage fills the display.
 */
function shapeSpectrum(out: Uint8Array<ArrayBuffer>, energy: number, clockSeconds: number): void {
  const bins = out.length;
  for (let i = 0; i < bins; i += 1) {
    const x = i / bins;
    // Falls to roughly a fifth of full amplitude at the top of the range.
    const tilt = 1 - x * 0.8;
    const wobble =
      0.72 +
      0.18 * Math.sin(clockSeconds * 2.1 + x * 9.0) +
      0.1 * Math.sin(clockSeconds * 3.7 - x * 15.0) +
      0.06 * Math.sin(clockSeconds * 6.3 + x * 26.0);
    const value = energy * tilt * wobble * 255;
    out[i] = Math.max(0, Math.min(255, Math.round(value)));
  }
}

/** Fills the waveform with an oscillation whose amplitude follows `energy`. */
function shapeWaveform(out: Uint8Array<ArrayBuffer>, energy: number, clockSeconds: number): void {
  const amplitude = 118 * energy;
  for (let i = 0; i < out.length; i += 1) {
    const t = clockSeconds * 6.0 + (i / out.length) * Math.PI * 6.0;
    const shape = Math.sin(t) * (0.65 + 0.35 * Math.sin(clockSeconds * 1.7));
    out[i] = Math.max(0, Math.min(255, Math.round(128 + amplitude * shape)));
  }
}

/**
 * A plausible loudness for when there is nothing real to show.
 *
 * Deliberately musical rather than random: a slow swell with a faster pulse on top, so an overlay
 * with no OBS connection still looks like it is reacting to something instead of twitching.
 */
function simulatedEnergy(clockSeconds: number): number {
  const swell = 0.35 + 0.25 * Math.sin(clockSeconds * 0.9);
  const pulse = 0.22 * Math.max(0, Math.sin(clockSeconds * 3.1));
  return Math.max(0, Math.min(1, swell + pulse));
}

/**
 * Opens the page's audio feed: one `EventSource` on the public levels endpoint.
 *
 * Never rejects. A stream that cannot be opened is indistinguishable, to every consumer, from one
 * that is open and reporting silence — both end in the simulated signal.
 */
function createFeed(): AudioFeed {
  const frequency = new Uint8Array(BIN_COUNT);
  const waveform = new Uint8Array(WAVEFORM_SIZE);

  /** The newest measurement from the stream, and when it arrived on our clock. */
  let latest: AudioLevels | null = null;
  let latestAt = -1;

  /** `performance.now()` of the last refresh, so several consumers share one update per frame. */
  let sampledAt = -1;
  /** Seconds of animation time. Advances always, because the derived shapes need it either way. */
  let clockSeconds = 0;
  /** The eased loudness that {@link AudioBus.level} reports. */
  let level = 0;
  let source: AudioBus["source"] = "simulated";
  let inputs: readonly AudioInput[] = [];
  let peak = 0;

  let stream: EventSource | null = null;
  try {
    stream = new EventSource(audioLevelsUrl());
    stream.addEventListener("levels", (event: MessageEvent<string>) => {
      try {
        latest = JSON.parse(event.data) as AudioLevels;
        latestAt = performance.now();
      } catch {
        // A malformed frame is not worth taking the stream down for: the next one is 50ms away.
      }
    });
    // `heartbeat` needs no handler. It exists so that this connection has traffic on it even while
    // OBS is silent, which is what keeps proxies from closing it and what stops the staleness
    // watchdog below from firing on a perfectly healthy quiet stream.
    //
    // `onerror` needs no handler either: EventSource reconnects on its own, and until it does, the
    // watchdog has already switched us to the simulated signal. There is nothing to add.
  } catch {
    // Constructing an EventSource can throw for a malformed URL. Nothing to do; simulation covers it.
    stream = null;
  }

  const bus: AudioBus = {
    frequency,
    waveform,

    get level(): number {
      return level;
    },
    get peak(): number {
      return peak;
    },
    get inputs(): readonly AudioInput[] {
      return inputs;
    },
    get source(): AudioBus["source"] {
      return source;
    },

    bands(out: Float32Array): void {
      const count = out.length;
      const bins = frequency.length;
      for (let i = 0; i < count; i += 1) {
        const from = Math.floor((i / count) ** 2 * bins);
        const to = Math.max(from + 1, Math.floor(((i + 1) / count) ** 2 * bins));
        let sum = 0;
        let taken = 0;
        for (let b = from; b < to && b < bins; b += 1) {
          sum += at(frequency, b);
          taken += 1;
        }
        out[i] = taken === 0 ? 0 : sum / taken / 255;
      }
    },

    sample(now: number): void {
      if (now === sampledAt) return;
      const dt = sampledAt < 0 ? 0 : Math.min((now - sampledAt) / 1000, 0.1);
      sampledAt = now;
      clockSeconds += dt;

      const fresh = latest !== null && now - latestAt < STALE_AFTER_MS;
      source = fresh ? "obs" : "simulated";

      let target: number;
      if (fresh && latest !== null) {
        target = Math.max(0, Math.min(1, latest.peak));
        peak = target;
        inputs = latest.inputs;
      } else {
        target = simulatedEnergy(clockSeconds);
        peak = target;
        inputs = [];
      }

      /*
       * Asymmetric easing, the way a hardware VU meter behaves: rise almost immediately, fall
       * slowly. `1 - e^(-dt/tau)` is the frame-rate-independent form — doubling the frame rate
       * halves each step, so the curve takes the same wall-clock time at 30 fps and at 144.
       */
      const tau = target > level ? ATTACK_SECONDS : RELEASE_SECONDS;
      const alpha = dt <= 0 ? 1 : 1 - Math.exp(-dt / tau);
      level += (target - level) * alpha;

      shapeSpectrum(frequency, level, clockSeconds);
      shapeWaveform(waveform, level, clockSeconds);
    },
  };

  /*
   * The harness cannot see any of this from the DOM. Whether the page is showing real OBS levels or
   * a convincing simulation is exactly the distinction that matters here and exactly the one a
   * screenshot cannot make on its own, so the state is published for a check to read.
   *
   * Absent from a production build unless the URL carries `?sdkDebug`; see `debug.ts`.
   */
  publishDebug("audio", () => ({
    source,
    level: Number(level.toFixed(4)),
    peak: Number(peak.toFixed(4)),
    inputs: inputs.map((input) => input.inputName),
    streamOpen: stream !== null,
    // `readyState` is 0 connecting, 1 open, 2 closed. Useful for telling "the stream dropped and is
    // reconnecting" from "the stream is fine and OBS is silent", which look identical in pixels.
    readyState: stream?.readyState ?? -1,
    millisSinceMeasurement: latestAt < 0 ? -1 : Math.round(performance.now() - latestAt),
  }));

  return {
    bus,
    close(): void {
      stream?.close();
      stream = null;
    },
  };
}

/**
 * The page's single audio feed, refcounted.
 *
 * Exported for the verification harness (`stats()`, `shutdownNow()`) and for the rare effect that
 * wants to inspect the reference count. Effects use {@link useAudio}.
 */
export const audioResource: SharedResource<AudioFeed> = createSharedResource<AudioFeed>({
  label: "audio",
  create: createFeed,
  destroy(feed: AudioFeed): void {
    feed.close();
  },
});

/**
 * Acquires the page's audio bus for as long as `scope` is alive.
 *
 * ```ts
 * const bus = await useAudio(scope);
 * scope.checkpoint();
 * const bands = new Float32Array(barCount);
 * onFrame(scope, ctx.fpsCap, ({ now }) => {
 *   bus.sample(now);
 *   bus.bands(bands);
 *   // ...draw...
 * });
 * ```
 *
 * **It never rejects.** No OBS connection, OBS closed, a dropped stream — all of them end with the
 * bus reporting `source: "simulated"` and producing a signal anyway, so an effect needs no error
 * handling and no fallback branch of its own.
 *
 * **It does not checkpoint for you.** Unlike `createPixiStage`, this resolves normally even when the
 * scope died while it was resolving. Put a `scope.checkpoint()` on the line after the `await`, or
 * the rest of your setup runs for an effect nobody is going to see.
 *
 * The release is registered on `scope`, so there is nothing to remember. Because the shared resource
 * lingers briefly after its last consumer lets go (see `lease.ts`), a route change does not close
 * and reopen the stream, which would cost a reconnect on every save.
 */
export async function useAudio(scope: Scope): Promise<AudioBus> {
  const lease = await audioResource.acquire(scope);
  return lease.value.bus;
}
