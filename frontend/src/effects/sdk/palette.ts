/**
 * Palettes — a named colour ramp an effect can offer as a single parameter.
 *
 * ## The problem
 *
 * Every effect currently invents its own colour parameters: `colorLow`/`colorHigh`,
 * `colorStart`/`colorEnd`, `colorA`/`colorB`, `glowColor`. Two consequences. An operator who wants
 * a scene themed consistently has to retype the same hex codes into five different forms and keep
 * them in step by hand. And an effect that wants seven colours has to ask for seven colour pickers,
 * which nobody will fill in.
 *
 * A palette is one dropdown. The effect samples as many colours out of it as it needs.
 *
 * ## Why the value is a *sampler* and not named slots
 *
 * A palette exposes `paletteAt(p, t)`: give it a position from 0 to 1 along the ramp and it gives
 * you a colour. That is what lets one palette serve a two-colour gradient and a seven-band spectrum
 * from the same route setting.
 *
 * The obvious alternative — named slots such as `accent`, `background`, `highlight` — is a trap:
 * every effect would then argue about which slot it means, and an operator switching between two
 * effects would find the same palette looking unrelated in each.
 *
 * ## Why a palette is an ordinary `select` parameter and not a new `ParamKind`
 *
 * `ParamSpec.kind` is part of the wire contract shared with the Scala backend. Adding a `"palette"`
 * kind would mean touching the kind enum, the validator, the HTTP DTOs, the BSON codecs, the
 * contract document and the admin's form renderer — six files across two languages — to get a
 * dropdown that a `kind: "select"` already renders today, validates today, and stores today.
 *
 * So {@link paletteParam} emits a plain `select` whose `options` are the palette ids. The admin
 * gets a dropdown of palette names, which is admittedly not as good as a row of swatches. If that
 * proves inadequate the next step is a swatch renderer in `ParamsForm` keyed on the options being
 * known palette ids — still no contract change.
 *
 * The capability given up is an operator defining a *custom* palette inline. That upgrade stays
 * available later and is purely additive: a route storing a preset id keeps working, because the id
 * is still a valid value for whatever kind replaces this one.
 *
 * ## The rule about ids, which matters more than it looks
 *
 * The catalogue below is code; a route's stored palette id is data, sitting in MongoDB. Renaming or
 * removing an id makes every route using it fall back to the effect's default — silently changing
 * what is on air, months later, with nothing in any log. **Palette ids are append-only.** Add new
 * ones freely; never rename or delete one that has shipped.
 *
 * ## Colour mixing is linear sRGB, on purpose
 *
 * Mixing two hex colours by averaging their channels is not perceptually correct — Oklab would be
 * the better default — but it is what the existing effects already do, and switching would change
 * how shipped effects *look* while the automated checks only assert that pixels were painted at
 * all. Changing the appearance of an effect is a separate change with a before/after screenshot
 * attached, not a side effect of a refactor.
 */

import * as THREE from "three";

import type { ParamSpec } from "../types";
import { str } from "../paramUtils";

/** A named colour ramp. */
export interface Palette {
  /** Stable id stored in a route's params. Append-only; see the file header. */
  readonly id: string;
  /** Human-readable name. Free to change — nothing stores it. */
  readonly name: string;
  /** At least two ordered `#rrggbb` stops, from position 0 to position 1 along the ramp. */
  readonly stops: readonly string[];
}

/**
 * The catalogue.
 *
 * Chosen to cover the four things a stream overlay actually needs — a neon look, a warm look, a
 * cool look and a near-monochrome look that does not fight with the game behind it — rather than to
 * be exhaustive. Add to the end.
 */
export const PALETTES: readonly Palette[] = [
  {
    id: "neon-dusk",
    name: "Neon Dusk",
    stops: ["#00e5ff", "#5b6bff", "#b14bff", "#ff2d95"],
  },
  {
    id: "ember",
    name: "Ember",
    stops: ["#2b0b00", "#8a1c00", "#ff6a00", "#ffd166"],
  },
  {
    id: "deep-sea",
    name: "Deep Sea",
    stops: ["#02111f", "#053b52", "#0e8a86", "#7ef0c0"],
  },
  {
    id: "aurora",
    name: "Aurora",
    stops: ["#08132b", "#1f6f5c", "#6ee7a8", "#c8f7ff"],
  },
  {
    id: "vapor",
    name: "Vapor",
    stops: ["#2b1055", "#7597de", "#ff8ad8", "#ffe1a8"],
  },
  {
    id: "monochrome",
    name: "Monochrome",
    stops: ["#000000", "#4a4a4a", "#b4b4b4", "#ffffff"],
  },
  {
    id: "signal",
    name: "Signal",
    stops: ["#0b0f14", "#1f8fff", "#ffffff"],
  },
];

/** The palette used when a stored id names something this build does not have. */
const FALLBACK: Palette = PALETTES[0] as Palette;

const byId = new Map<string, Palette>(PALETTES.map((p) => [p.id, p]));

/** Every palette id, in catalogue order. This is exactly what a `paletteParam` offers as options. */
export function paletteIds(): string[] {
  return PALETTES.map((p) => p.id);
}

/** Looks up a palette by id, or `undefined` when this build does not have it. */
export function paletteById(id: string): Palette | undefined {
  return byId.get(id);
}

/**
 * Builds the `ParamSpec` an effect puts in its descriptor to offer a palette.
 *
 * It is an ordinary `kind: "select"` spec — see the file header for why — so the admin form, the
 * backend validator and the inventory page all handle it with no change of any kind.
 *
 * ```ts
 * params: [paletteParam("palette", "Palette", "neon-dusk", "Colour ramp used across the bars.")]
 * ```
 *
 * @param defaultId must be an id that exists in {@link PALETTES}; a typo is reported in the console
 *                  at module load rather than becoming an unselectable default in the admin.
 */
export function paletteParam(
  key: string,
  label: string,
  defaultId: string,
  description: string,
): ParamSpec {
  if (!byId.has(defaultId)) {
    console.error(
      `[sdk] The palette parameter "${key}" defaults to "${defaultId}", which is not in the ` +
        `catalogue. Effects will fall back to "${FALLBACK.id}".`,
    );
  }
  return {
    key,
    label,
    kind: "select",
    default: byId.has(defaultId) ? defaultId : FALLBACK.id,
    options: paletteIds(),
    description,
  };
}

/**
 * Reads a palette parameter back out of a merged parameter set.
 *
 * Never throws and never returns `undefined`: an id that no longer exists degrades to
 * `fallbackId`, and a `fallbackId` that does not exist either degrades to the first catalogue
 * entry. That is the same defensive behaviour every reader in `paramUtils.ts` has, and for the
 * same reason — the value came out of a database and may be anything.
 */
export function palette(params: Record<string, unknown>, key: string, fallbackId: string): Palette {
  const id = str(params, key, fallbackId);
  return byId.get(id) ?? byId.get(fallbackId) ?? FALLBACK;
}

/** Clamps `t` into 0..1, turning a `NaN` into 0 rather than propagating it into a colour. */
function clamp01(t: number): number {
  return Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
}

/** Splits `#rrggbb` into three 0..255 channels. */
function channels(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/**
 * Samples the ramp at position `t`, returning three 0..255 channels.
 *
 * The stops are spread evenly across 0..1 and neighbouring pairs are mixed linearly. `t` outside
 * 0..1 is clamped, so `paletteAt(p, -3)` is the first stop and `paletteAt(p, 99)` is the last.
 */
function sample(p: Palette, t: number): [number, number, number] {
  const stops = p.stops;
  if (stops.length === 0) return [255, 255, 255];
  if (stops.length === 1) return channels(stops[0] as string);

  const scaled = clamp01(t) * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(scaled));
  const local = scaled - index;
  const [r1, g1, b1] = channels(stops[index] as string);
  const [r2, g2, b2] = channels(stops[index + 1] as string);
  return [
    Math.round(r1 + (r2 - r1) * local),
    Math.round(g1 + (g2 - g1) * local),
    Math.round(b1 + (b2 - b1) * local),
  ];
}

/** Samples the ramp as a `#rrggbb` string — the form a `color` parameter or CSS wants. */
export function paletteAt(p: Palette, t: number): string {
  const [r, g, b] = sample(p, t);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

/**
 * Samples the ramp as the 24-bit integer both three.js and pixi.js take directly.
 *
 * This is the one to use inside an animation loop: it allocates nothing and does no string work,
 * which matters when it is called once per bar per frame.
 */
export function paletteAtInt(p: Palette, t: number): number {
  const [r, g, b] = sample(p, t);
  return (r << 16) | (g << 8) | b;
}

/** Samples the ramp as three 0..1 channels — the form a GLSL `vec3` uniform wants. */
export function paletteAt01(p: Palette, t: number): [number, number, number] {
  const [r, g, b] = sample(p, t);
  return [r / 255, g / 255, b / 255];
}

/**
 * Bakes the ramp into a fixed-length array of `vec3`s for a shader uniform.
 *
 * GLSL array uniforms must have a compile-time length, so a shader declares
 * `uniform vec3 uPalette[8];` and is told how many entries are real via a second uniform. This
 * returns exactly that pair: `max` evenly spaced samples, and `count` — which is `max`, so the
 * unused-slot problem does not arise, but is returned anyway so a shader written against a variable
 * stop count does not need changing if this ever samples the stops directly.
 *
 * The vectors are freshly allocated, so the caller owns them; `THREE.ShaderMaterial` keeps its own
 * reference and there is nothing to dispose.
 */
export function paletteUniform(
  p: Palette,
  max: number,
): { colors: THREE.Vector3[]; count: number } {
  const count = Math.max(2, Math.min(64, Math.round(max)));
  const colors: THREE.Vector3[] = [];
  for (let i = 0; i < count; i += 1) {
    const [r, g, b] = paletteAt01(p, count === 1 ? 0 : i / (count - 1));
    colors.push(new THREE.Vector3(r, g, b));
  }
  return { colors, count };
}
