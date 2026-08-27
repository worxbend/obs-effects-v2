/**
 * Small helpers shared by every effect implementation.
 *
 * Why these exist: the renderer hands an effect a plain `Record<string, unknown>` of parameter
 * values. Those values come from a database, so an effect must never assume a value has the type it
 * expects — a hand-edited route could contain a string where a number belongs. Every helper below
 * therefore takes a fallback and returns it whenever the stored value is unusable, so a bad value
 * degrades to the descriptor default instead of throwing and killing the animation loop.
 */

/** Reads a numeric parameter, clamped into an optional [min, max] range. */
export function num(
  params: Record<string, unknown>,
  key: string,
  fallback: number,
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
): number {
  const raw = Number(params[key]);
  const value = Number.isFinite(raw) ? raw : fallback;
  return Math.min(max, Math.max(min, value));
}

/** Reads an integer parameter (rounded), clamped into an optional [min, max] range. */
export function int(
  params: Record<string, unknown>,
  key: string,
  fallback: number,
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
): number {
  return Math.round(num(params, key, fallback, min, max));
}

/** Reads a boolean parameter. Anything that is not exactly `true`/`"true"` counts as false. */
export function bool(params: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = params[key];
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

/** Reads a free-text parameter. */
export function str(params: Record<string, unknown>, key: string, fallback: string): string {
  const value = params[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Reads a `#rrggbb` color parameter as a literal string, validated against the contract's regex. */
export function colorHex(params: Record<string, unknown>, key: string, fallback: string): string {
  const value = params[key];
  return typeof value === "string" && HEX_COLOR.test(value) ? value : fallback;
}

/**
 * Reads a `#rrggbb` color parameter as the 24-bit integer that both three.js and pixi.js want.
 * `"#ff8800"` becomes `0xff8800`, which is just the same three bytes in a different notation.
 */
export function colorInt(params: Record<string, unknown>, key: string, fallback: string): number {
  return Number.parseInt(colorHex(params, key, fallback).slice(1), 16);
}

/** Splits a 24-bit color into its red, green and blue channels, each normalised to 0..1. */
export function rgb01(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255];
}

/** Linear interpolation: at `t = 0` returns `a`, at `t = 1` returns `b`, in between mixes them. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Reads one number out of a typed array (a `Float32Array`, a `Uint8Array`, ...).
 *
 * Why this exists: `tsconfig.json` switches on TypeScript's `noUncheckedIndexedAccess` option.
 * That option makes every indexed read — `buffer[i]` — have the type "a number **or**
 * `undefined`", because the compiler has no way to prove that `i` is inside the array. In the
 * animation loops below the index always *is* inside the array (it is derived from the loop
 * counter and the buffer's own length), but the compiler cannot see that, and arithmetic on a
 * possibly-`undefined` value is rejected.
 *
 * Rather than sprinkle assertions through the hot loops, every read goes through this one
 * function. It returns a plain `number`, and if a caller ever really does read past the end of a
 * buffer it yields `0` — a harmless value for a coordinate or a colour channel — instead of
 * producing `NaN`, which would silently corrupt every later frame.
 */
export function at(buffer: Float32Array | Uint8Array, index: number): number {
  return buffer[index] ?? 0;
}
