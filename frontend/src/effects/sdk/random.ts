/**
 * `random` — the one place effects get visual randomness from.
 *
 * ## Why this indirection exists
 *
 * Effects need cheap, non-deterministic jitter: particle spawn positions, glitch offsets,
 * flicker timing. `Math.random()` is exactly the right tool for that — the output is painted
 * on a canvas, never used for tokens, ids, or anything an attacker could care about.
 *
 * Static analysis cannot see that intent. Every `Math.random()` call site trips the
 * "PRNG in a security context" rule (SonarCloud typescript:S2245), which meant three hundred
 * open issues that all had the same answer. The call is therefore centralised here and
 * acknowledged once with NOSONAR, and effect code calls `random()` instead of `Math.random()`.
 *
 * If you ever need randomness for a *security* purpose — this is not the function, and the
 * effects package is not the place. Use `crypto.getRandomValues` in app code instead.
 */
export function random(): number {
  // Visual jitter only; see the file header for the rationale.
  return Math.random(); // NOSONAR typescript:S2245
}

/** Uniform float in `[min, max)`. Written once so effects stop re-spelling `min + random() * (max - min)`. */
export function randomBetween(min: number, max: number): number {
  return min + random() * (max - min);
}

/** Uniform integer in `[minInclusive, maxExclusive)`. */
export function randomInt(minInclusive: number, maxExclusive: number): number {
  return Math.floor(randomBetween(minInclusive, maxExclusive));
}
