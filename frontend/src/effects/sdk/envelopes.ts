import type { AudioBus } from "./audio";

/**
 * Turning one loudness number into several differently-paced ones.
 *
 * ## Why this exists, and what it honestly is
 *
 * Audio-reactive effects usually want more than a single number: something slow and weighty for a
 * background pulse, something fast and twitchy for sparks, and a beat flag for anything that should
 * snap. The obvious way to get those is a frequency analysis — bass, mids, treble.
 *
 * **We cannot do that.** OBS reports loudness, not a spectrum; there is no Fast Fourier Transform
 * anywhere in the obs-websocket protocol. See the header of `sdk/audio.ts`.
 *
 * What this provides instead is the trick the old `obs-effects` repository used, carried over
 * deliberately: take the *same* level and track it with three different attack/release speeds. A
 * slowly-tracking envelope ignores transients and follows sustained energy, which behaves very much
 * like bass; a fast one snaps to every hit, which behaves like treble. They are not frequency
 * bands, they are **time constants**, and the fields are named `slow`, `mid` and `fast` rather than
 * bass/mid/high so that nobody reading an effect believes otherwise.
 *
 * In practice it does the job: an effect driven by `slow` reads as following the music's body and
 * one driven by `fast` reads as following its edge, which is what the effect author actually wanted
 * when they reached for a spectrum.
 *
 * ## Attack and release
 *
 * Every envelope rises faster than it falls. That asymmetry is what a hardware meter has and what
 * makes a level look musical rather than mechanical: a drum hit should arrive instantly and decay
 * over a moment, not fade in and snap out.
 */

/** The three envelopes plus the beat flag, refreshed by {@link AudioEnvelopes.update}. */
export interface AudioEnvelopes {
  /**
   * Slow attack, slower release. Follows sustained energy and ignores individual hits.
   *
   * The one to drive a background's brightness or a slow scale with.
   */
  readonly slow: number;
  /** Medium tracking — the general-purpose one. */
  readonly mid: number;
  /**
   * Fast attack, medium release. Snaps to transients.
   *
   * The one to drive sparks, flashes and anything that should feel percussive.
   */
  readonly fast: number;
  /**
   * True on the single frame a transient was detected, with a cooldown so it cannot fire on
   * consecutive frames.
   *
   * Read it as "something just hit", not as "a musical beat" — nothing here knows about tempo.
   */
  readonly beat: boolean;
  /** Whether the numbers are coming from OBS rather than the simulated fallback. */
  readonly live: boolean;
  /**
   * Advances all four from the bus. Call once per frame, **after** `bus.sample(now)`.
   *
   * @param dt seconds since the last frame, from the `FrameInfo` the frame loop hands you.
   */
  update(dt: number): void;
}

/** How much bass must exceed before a beat is declared. */
const BEAT_THRESHOLD = 0.25;

/** Seconds a beat suppresses the next one, so one hit is not reported as several. */
const BEAT_COOLDOWN = 0.22;

/**
 * Rise/fall rates, in "fraction of the remaining distance per second".
 *
 * These are the values the old repository used, kept exactly so the ported effects react the way
 * they always did. Higher means faster.
 */
const RATES = {
  slow: { up: 8, down: 3 },
  mid: { up: 14, down: 5 },
  fast: { up: 28, down: 8 },
} as const;

/** Moves `current` towards `target` at the appropriate rate for this frame. */
function track(current: number, target: number, dt: number, up: number, down: number): number {
  const rate = target > current ? up : down;
  return current + (target - current) * Math.min(1, dt * rate);
}

/**
 * Builds a set of envelopes reading from `bus`.
 *
 * ```ts
 * const bus = await useAudio(scope);
 * scope.checkpoint();
 * const env = createEnvelopes(bus);
 *
 * onFrame(scope, ctx.fpsCap, ({ dt, now }) => {
 *   bus.sample(now);
 *   env.update(dt);
 *   // env.slow, env.mid, env.fast, env.beat
 * });
 * ```
 *
 * There is nothing to dispose: this owns no resources, only four numbers.
 */
export function createEnvelopes(bus: AudioBus): AudioEnvelopes {
  let slow = 0;
  let mid = 0;
  let fast = 0;
  let beat = false;
  let cooldown = 0;

  return {
    get slow(): number {
      return slow;
    },
    get mid(): number {
      return mid;
    },
    get fast(): number {
      return fast;
    },
    get beat(): boolean {
      return beat;
    },
    get live(): boolean {
      return bus.source === "obs";
    },

    update(dt: number): void {
      beat = false;
      cooldown = Math.max(0, cooldown - dt);

      /*
       * Square root, not the raw level.
       *
       * Loudness as a linear multiplier is a *power* measurement, and human hearing is closer to
       * logarithmic: a sound at 0.25 does not sound a quarter as loud as one at 1.0, it sounds
       * about half as loud. Taking the square root is a cheap approximation of that curve, and
       * without it everything below about a third of full scale barely moves an effect at all —
       * which is most normal speech and music.
       */
      const perceived = Math.sqrt(Math.min(1, Math.max(0, bus.level)));

      slow = track(slow, perceived, dt, RATES.slow.up, RATES.slow.down);
      mid = track(mid, perceived, dt, RATES.mid.up, RATES.mid.down);
      fast = track(fast, perceived, dt, RATES.fast.up, RATES.fast.down);

      if (slow > BEAT_THRESHOLD && cooldown <= 0) {
        beat = true;
        cooldown = BEAT_COOLDOWN;
      }
    },
  };
}
