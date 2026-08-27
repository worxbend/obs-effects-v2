import * as PIXI from "pixi.js";

import { colorInt, num, str } from "../paramUtils";
import { createPixiStage, defineEffect, onFrame } from "../sdk";

/**
 * Floating Dust
 * =============
 *
 * A warm, cinematic dust scene: three depth layers of soft particles drift through a Perlin-noise
 * flow field over a near-black night background, with slow-moving tinted fog blobs behind them and
 * a film-look post pass (vignette, a warm centre haze, a fog lift at the bottom of the frame, and
 * animated grain) over the top. It reads like dust motes caught in projector light.
 *
 * Ported from `floating-dust.html` in the old `obs-effects` repository.
 *
 * How the depth illusion works
 * ----------------------------
 * There is no 3D anywhere. Three flat layers fake it:
 *
 * - **Far** — many tiny, dim, slow particles in cool violet colours. Cool and dim reads as distant.
 * - **Mid** — fewer, larger, warmer particles at medium speed.
 * - **Near** — few large glowing particles in bright warm colours, drawn with *additive* blending
 *   (colours are summed with what is beneath, so overlaps glow brighter — what real out-of-focus
 *   lights do). Bright, warm and fast reads as close.
 *
 * Every particle follows the same flow field: a Perlin-noise function of its position and of time
 * turns into a heading angle, so neighbouring particles drift in similar directions and the whole
 * cloud moves like air currents instead of like independent random walkers. The noise field
 * evolves slowly with time, so the currents themselves change shape over minutes.
 *
 * What changed in the port
 * ------------------------
 * - The original ran on Pixi v7 from a CDN and used `PIXI.ParticleContainer`, whose v7 API
 *   (a per-property options object) no longer exists in the v8 this project pins. Plain
 *   `PIXI.Container`s hold the sprites instead; at these particle counts v8's batch renderer
 *   handles that comfortably.
 * - The v7 `PIXI.Filter(null, frag, uniforms)` post-processing filter is rewritten for v8's
 *   `GlProgram` API. The fragment logic itself is unchanged. It targets WebGL, which is the
 *   backend Pixi v8 picks by default; the shader is skipped rather than crashed on if the filter
 *   cannot be built.
 * - The animation runs on the SDK's shared `onFrame` clock instead of `app.ticker`, so the route's
 *   frame-rate cap is honoured. The motion maths was already in units per second multiplied by a
 *   delta time, so the look is identical at any refresh rate.
 * - Every hard-coded constant (counts, colours, background, post-pass strengths) is now a
 *   parameter defaulting to the original value. The three colour palettes are comma-separated hex
 *   lists in text parameters, because a palette of five or six swatches does not fit a single
 *   colour picker.
 *
 * Resize behaviour matches the original: the layers are rebuilt so particles and fog blobs cover
 * the new area, via `stage.onResize`.
 */

// ─── Perlin noise ────────────────────────────────────────────────────────────
//
// Classic 2D Perlin gradient noise, ported verbatim from the original page. Each integer grid
// point gets a pseudo-random gradient direction (via the shuffled permutation table below), and
// the value at any point is a smooth blend of the four surrounding corners' contributions. The
// result is smooth, band-limited "wandering" noise — exactly what a believable air current needs,
// and something `Math.random()` (which is discontinuous everywhere) cannot provide.

/** Shuffled permutation table, doubled to 512 entries so lookups never need a modulo. */
const PERM = new Uint8Array(512);
{
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    // The `?? 0` never fires — both indices are in range — but the project compiles with
    // `noUncheckedIndexedAccess`, under which every typed-array read is possibly `undefined`.
    const t = p[i] ?? 0;
    p[i] = p[j] ?? 0;
    p[j] = t;
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255] ?? 0;
}

/** Perlin's quintic fade curve — eases the blend so the noise has no visible grid seams. */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Dot product of the point offset with one of four diagonal gradient directions. */
function grad2(h: number, x: number, y: number): number {
  switch (h & 3) {
    case 0:
      return x + y;
    case 1:
      return -x + y;
    case 2:
      return x - y;
    default:
      return -x - y;
  }
}

/** 2D Perlin noise, roughly in −1..1. */
function perlin2(x: number, y: number): number {
  const xi = Math.floor(x) & 255;
  const yi = Math.floor(y) & 255;
  const xf = x - Math.floor(x);
  const yf = y - Math.floor(y);
  const u = fade(xf);
  const v = fade(yf);
  // The `?? 0` fallbacks satisfy `noUncheckedIndexedAccess`; every index here is in range by
  // construction (the `& 255` masks, and PERM being 512 entries long).
  const aa = PERM[(PERM[xi] ?? 0) + yi] ?? 0;
  const ab = PERM[(PERM[xi] ?? 0) + yi + 1] ?? 0;
  const ba = PERM[(PERM[xi + 1] ?? 0) + yi] ?? 0;
  const bb = PERM[(PERM[xi + 1] ?? 0) + yi + 1] ?? 0;
  const lp = (a: number, b: number, t: number): number => a + (b - a) * t;
  return lp(
    lp(grad2(aa, xf, yf), grad2(ba, xf - 1, yf), u),
    lp(grad2(ab, xf, yf - 1), grad2(bb, xf - 1, yf - 1), u),
    v,
  );
}

/**
 * Turns a position and a time into a drift heading, in radians.
 *
 * Two octaves of Perlin noise (the second at ~2× frequency and half weight, offset so the octaves
 * never line up) are summed and scaled to up to ±2.5 turns. Time slides the noise field sideways,
 * which is what makes the currents slowly change shape.
 */
function flowAngle(x: number, y: number, t: number): number {
  const s = 0.0016;
  const ts = t * 0.035;
  const n1 = perlin2(x * s + ts, y * s);
  const n2 = perlin2(x * s * 2.1 + ts + 7.3, y * s * 2.1 + 3.1) * 0.5;
  return (n1 + n2) * Math.PI * 2.5;
}

// ─── Textures ────────────────────────────────────────────────────────────────

/**
 * Paints one white dot with the given radial-gradient alpha stops into a 2D canvas.
 *
 * All particles of a layer share one texture and are recoloured per-sprite with `tint`, which the
 * GPU applies for free while drawing — drawing the gradient itself thousands of times would not
 * be free. White is deliberate: tint multiplies, so a white texture takes any tint faithfully.
 */
function makeSoftDot(radius: number, stops: ReadonlyArray<readonly [number, number]>): PIXI.Texture {
  const d = radius * 2 + 2;
  const canvas = document.createElement("canvas");
  canvas.width = d;
  canvas.height = d;
  const g = canvas.getContext("2d");
  if (g) {
    const rg = g.createRadialGradient(d / 2, d / 2, 0, d / 2, d / 2, radius);
    for (const [pos, a] of stops) rg.addColorStop(pos, `rgba(255,255,255,${a})`);
    g.fillStyle = rg;
    g.fillRect(0, 0, d, d);
  }
  return PIXI.Texture.from(canvas);
}

// ─── Original constants ──────────────────────────────────────────────────────

/** Default background — a near-black with a violet cast, so pure blacks in the post pass read. */
const BG_DEFAULT = "#060410";

/** Far layer: cool violets. Dim and cool is what makes the layer read as distant. */
const FAR_COLORS = [0x4a3a7a, 0x332866, 0x3a2f5a, 0x5a4a8a, 0x2a2050] as const;
/** Mid layer: dusty warm tones with the odd violet, bridging far and near. */
const MID_COLORS = [0xd4b89a, 0xc88850, 0x9a78bb, 0xd0a87a, 0xe4c8a8, 0xb87a40] as const;
/** Near layer: bright ambers and pinks that bloom under additive blending. */
const NEAR_COLORS = [0xf0a840, 0xffd080, 0xdd88ff, 0xffe0c0, 0xffbb66, 0xeec0ff] as const;

const FAR_COLORS_TEXT = "#4a3a7a, #332866, #3a2f5a, #5a4a8a, #2a2050";
const MID_COLORS_TEXT = "#d4b89a, #c88850, #9a78bb, #d0a87a, #e4c8a8, #b87a40";
const NEAR_COLORS_TEXT = "#f0a840, #ffd080, #dd88ff, #ffe0c0, #ffbb66, #eec0ff";

/**
 * The five fog blobs, positioned as fractions of the screen so they land sensibly at any size.
 * `sc` is sprite scale, `a` alpha, `spd` drift amplitude, `ph` a phase offset so the blobs do not
 * all sway in step. Alternating purple and brown tints give the haze some colour variety without
 * any of it standing out.
 */
const FOG_DEFS = [
  { fx: 0.25, fy: 0.4, tint: 0xa060a0, sc: 2.2, a: 0.18, spd: 8, ph: 0.0 },
  { fx: 0.72, fy: 0.55, tint: 0x806040, sc: 2.8, a: 0.14, spd: 10, ph: 2.1 },
  { fx: 0.5, fy: 0.22, tint: 0x604090, sc: 1.8, a: 0.11, spd: 6, ph: 4.4 },
  { fx: 0.15, fy: 0.68, tint: 0x805030, sc: 2.1, a: 0.1, spd: 7, ph: 1.3 },
  { fx: 0.85, fy: 0.3, tint: 0x705090, sc: 1.6, a: 0.09, spd: 5, ph: 3.7 },
] as const;

/** Per-layer tuning from the original: speed and scale ranges, and base alpha range. */
const LAYER_TUNING = {
  far: { spdLo: 8, spdHi: 20, scLo: 0.12, scHi: 0.45, aLo: 0.04, aHi: 0.22 },
  mid: { spdLo: 15, spdHi: 40, scLo: 0.1, scHi: 0.48, aLo: 0.14, aHi: 0.52 },
  near: { spdLo: 22, spdHi: 65, scLo: 0.1, scHi: 0.55, aLo: 0.28, aHi: 0.74 },
} as const;

/** Particles wrapping off one screen edge re-enter this many pixels beyond the opposite one. */
const WRAP_MARGIN = 22;

// ─── Post-processing shader ──────────────────────────────────────────────────

/**
 * The standard Pixi v8 filter vertex shader, from the Pixi custom-filter documentation. It maps
 * the filter quad into the output frame and hands the fragment stage a texture coordinate. Pixi
 * v8 no longer exports this as a string, so filters carry their own copy.
 */
const POST_VERT = `
in vec2 aPosition;
out vec2 vTextureCoord;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

vec4 filterVertexPosition( void )
{
    vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
    position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0*uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
    return vec4(position, 0.0, 1.0);
}

vec2 filterTextureCoord( void )
{
    return aPosition * (uOutputFrame.zw * uInputSize.zw);
}

void main(void)
{
    gl_Position = filterVertexPosition();
    vTextureCoord = filterTextureCoord();
}
`;

/**
 * The film-look pass, logic unchanged from the original: vignette (corners darkened by distance
 * from centre), a warm orange haze added around the centre, an orange fog lift over the bottom
 * half, and per-pixel animated grain. The three strength uniforms replace the original's
 * hard-coded 0.54 / 1.0 / 0.036 so they can be parameters; their defaults reproduce it exactly.
 */
const POST_FRAG = `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform float uTime;
uniform float uVignette;
uniform float uHaze;
uniform float uGrain;

float grain(vec2 uv, float t) {
  return fract(sin(dot(uv + fract(t * 0.017), vec2(127.1, 311.7))) * 43758.5453) - 0.5;
}

void main() {
  vec2 uv  = vTextureCoord;
  vec4 col = texture(uTexture, uv);

  // Vignette
  vec2 v = (uv - 0.5) * 1.9;
  col.rgb *= clamp(1.0 - dot(v, v) * uVignette, 0.0, 1.0);

  // Warm center haze
  float d = length(uv - 0.5);
  col.rgb += vec3(0.09, 0.045, 0.012) * max(0.0, 1.0 - d * 2.7) * uHaze;

  // Atmospheric fog lift at bottom
  float fog = smoothstep(0.55, 1.0, uv.y) * 0.06;
  col.rgb += vec3(0.06, 0.03, 0.01) * fog * uHaze;

  // Film grain
  col.rgb += grain(uv, uTime) * uGrain;

  finalColor = vec4(clamp(col.rgb, 0.0, 1.0), col.a);
}
`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function rnd(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo);
}

function pick(arr: readonly number[]): number {
  // White fallback for the empty-array case `noUncheckedIndexedAccess` insists on; callers never
  // pass an empty array (parsePalette guarantees at least one entry).
  return arr[(Math.random() * arr.length) | 0] ?? 0xffffff;
}

/**
 * Parses a comma-separated list of hex colours ("#rrggbb", the "#" optional) into tint integers.
 *
 * Unparseable pieces are skipped rather than erroring, and an entirely unusable value falls back
 * to the layer's original palette — the same degrade-to-default posture the `paramUtils` readers
 * have, so a typo in the admin form dims nothing and crashes nothing.
 */
function parsePalette(text: string, fallback: readonly number[]): number[] {
  const out: number[] = [];
  for (const piece of text.split(",")) {
    const hex = /^#?([0-9a-fA-F]{6})$/.exec(piece.trim())?.[1];
    if (hex !== undefined) out.push(parseInt(hex, 16));
  }
  return out.length > 0 ? out : [...fallback];
}

/** Per-particle state. Position is tracked here and copied to the sprite once per frame. */
interface DustParticle {
  sp: PIXI.Sprite;
  x: number;
  y: number;
  /** Drift speed in pixels per second, before the global speed multiplier. */
  spd: number;
  /** Base alpha; the twinkle oscillates around it. */
  ba: number;
  /** Phase offset so particles twinkle out of step with each other. */
  ph: number;
  /** Twinkle rate in radians per second — each particle breathes at its own pace. */
  br: number;
}

export default defineEffect({
  descriptor: {
    id: "floating-dust",
    name: "Floating Dust",
    description:
      "Warm cinematic dust motes in three depth layers drifting through a Perlin-noise flow field, over slow tinted fog and under a film-look pass of vignette, haze and grain.",
    engine: "pixi",
    category: "background",
    tags: ["particles", "dust", "ambient", "fog", "cinematic", "background", "pixi"],
    previewNotes:
      "Fully opaque — it paints its own background, so use it as a scene backdrop rather than an overlay. The motion is deliberately slow; give a preview ten seconds or raise Speed to see the flow currents. Palettes are comma-separated hex lists, e.g. \"#f0a840, #ffd080\".",
    params: [
      {
        key: "background",
        label: "Background",
        kind: "color",
        default: BG_DEFAULT,
        description:
          "Colour behind everything. The default near-black violet is what the warm particles are balanced against; a light background will wash them out.",
      },
      {
        key: "farCount",
        label: "Far Particles",
        kind: "number",
        default: 2000,
        min: 0,
        max: 4000,
        step: 50,
        description:
          "How many tiny dim background motes exist. This layer is what gives the scene its sense of depth.",
      },
      {
        key: "midCount",
        label: "Mid Particles",
        kind: "number",
        default: 1500,
        min: 0,
        max: 3000,
        step: 50,
        description: "How many medium warm-toned motes drift in the middle layer.",
      },
      {
        key: "nearCount",
        label: "Near Particles",
        kind: "number",
        default: 400,
        min: 0,
        max: 1500,
        step: 25,
        description:
          "How many large glowing foreground motes exist. These use additive blending, so more of them means visibly more glow.",
      },
      {
        key: "speed",
        label: "Speed",
        kind: "number",
        default: 1,
        min: 0,
        max: 5,
        step: 0.05,
        description:
          "Multiplier on all motion — particle drift, the evolving flow currents and the fog sway. 0 freezes the scene (the grain keeps animating).",
      },
      {
        key: "size",
        label: "Particle Size",
        kind: "number",
        default: 1,
        min: 0.2,
        max: 4,
        step: 0.05,
        description: "Multiplier on every particle's size. 1 is the original look.",
      },
      {
        key: "brightness",
        label: "Particle Brightness",
        kind: "number",
        default: 1,
        min: 0,
        max: 3,
        step: 0.05,
        description: "Multiplier on every particle's opacity. Lower for a fainter, subtler dust.",
      },
      {
        key: "farColors",
        label: "Far Palette",
        kind: "text",
        default: FAR_COLORS_TEXT,
        description:
          "Comma-separated hex colours for the far layer. Cool, dark tones keep it reading as distant.",
      },
      {
        key: "midColors",
        label: "Mid Palette",
        kind: "text",
        default: MID_COLORS_TEXT,
        description: "Comma-separated hex colours for the middle layer.",
      },
      {
        key: "nearColors",
        label: "Near Palette",
        kind: "text",
        default: NEAR_COLORS_TEXT,
        description:
          "Comma-separated hex colours for the glowing foreground layer. Bright warm tones bloom the most under the additive blending.",
      },
      {
        key: "fogOpacity",
        label: "Fog Opacity",
        kind: "number",
        default: 1,
        min: 0,
        max: 3,
        step: 0.05,
        description:
          "Multiplier on the five drifting fog blobs behind the particles. 0 removes the haze entirely.",
      },
      {
        key: "vignette",
        label: "Vignette",
        kind: "number",
        default: 0.54,
        min: 0,
        max: 1.5,
        step: 0.02,
        description:
          "How strongly the corners darken. 0 is flat; the 0.54 default is the original's gentle framing.",
      },
      {
        key: "haze",
        label: "Warm Haze",
        kind: "number",
        default: 1,
        min: 0,
        max: 3,
        step: 0.05,
        description:
          "Multiplier on the warm glow added around the centre and along the bottom of the frame — the \"projector light\" part of the look.",
      },
      {
        key: "grain",
        label: "Film Grain",
        kind: "number",
        default: 0.036,
        min: 0,
        max: 0.15,
        step: 0.002,
        description:
          "Amplitude of the animated per-pixel noise. A little breaks up flat gradients; a lot reads as damaged film.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    // Antialiasing off, as the original had it: everything drawn is a pre-blurred sprite or a
    // full-screen rectangle, so there are no polygon edges for antialiasing to improve.
    const stage = await createPixiStage(scope, ctx, { antialias: false });

    let background = colorInt(ctx.params, "background", BG_DEFAULT);
    let farCount = Math.round(num(ctx.params, "farCount", 2000, 0, 4000));
    let midCount = Math.round(num(ctx.params, "midCount", 1500, 0, 3000));
    let nearCount = Math.round(num(ctx.params, "nearCount", 400, 0, 1500));
    let speed = num(ctx.params, "speed", 1, 0, 5);
    let size = num(ctx.params, "size", 1, 0.2, 4);
    let brightness = num(ctx.params, "brightness", 1, 0, 3);
    let farPalette = parsePalette(str(ctx.params, "farColors", FAR_COLORS_TEXT), FAR_COLORS);
    let midPalette = parsePalette(str(ctx.params, "midColors", MID_COLORS_TEXT), MID_COLORS);
    let nearPalette = parsePalette(str(ctx.params, "nearColors", NEAR_COLORS_TEXT), NEAR_COLORS);
    let fogOpacity = num(ctx.params, "fogOpacity", 1, 0, 3);
    let vignette = num(ctx.params, "vignette", 0.54, 0, 1.5);
    let haze = num(ctx.params, "haze", 1, 0, 3);
    let grain = num(ctx.params, "grain", 0.036, 0, 0.15);

    /*
     * Like `particle-drift`, the textures are NOT registered on the scope: `createPixiStage`
     * registered `app.destroy(true, { texture: true, textureSource: true })`, which frees them
     * with the application. Owning them separately would free them first (teardown is LIFO) and
     * Pixi would be asked to free them twice.
     *
     * The four textures are the original's: three dot sizes with progressively brighter cores for
     * the three depth layers, and one huge very faint disc for the fog blobs.
     */
    const texTiny = makeSoftDot(4, [
      [0, 1.0],
      [0.4, 0.85],
      [0.8, 0.18],
      [1, 0],
    ]);
    const texMed = makeSoftDot(8, [
      [0, 1.0],
      [0.35, 0.9],
      [0.7, 0.28],
      [1, 0],
    ]);
    const texGlow = makeSoftDot(16, [
      [0, 1.0],
      [0.25, 0.95],
      [0.6, 0.38],
      [1, 0],
    ]);
    const texFog = makeSoftDot(180, [
      [0, 0.14],
      [0.45, 0.06],
      [1, 0],
    ]);

    // Draw order, back to front: opaque background, fog haze, then the three particle layers.
    const bgGfx = stage.stage.addChild(new PIXI.Graphics());
    const fogLayer = stage.stage.addChild(new PIXI.Container());
    const farLayer = stage.stage.addChild(new PIXI.Container());
    const midLayer = stage.stage.addChild(new PIXI.Container());
    const nearLayer = stage.stage.addChild(new PIXI.Container());
    // Additive blending on the foreground only: overlapping near motes brighten each other, which
    // is what sells them as glowing points of light rather than painted dots.
    nearLayer.blendMode = "add";

    /*
     * The post filter. Built defensively: `GlProgram` targets WebGL, which is the backend Pixi v8
     * chooses by default, but if construction ever fails (an exotic environment, a driver bug) the
     * scene must still render — losing the vignette is invisible next to losing the stream.
     */
    let postUniforms: PIXI.UniformGroup | null = null;
    try {
      const uniforms = new PIXI.UniformGroup({
        uTime: { value: 0, type: "f32" },
        uVignette: { value: vignette, type: "f32" },
        uHaze: { value: haze, type: "f32" },
        uGrain: { value: grain, type: "f32" },
      });
      const postFilter = new PIXI.Filter({
        glProgram: PIXI.GlProgram.from({ vertex: POST_VERT, fragment: POST_FRAG }),
        resources: { postUniforms: uniforms },
      });
      stage.stage.filters = [postFilter];
      postUniforms = uniforms;
    } catch (error) {
      console.error("[floating-dust] Post filter unavailable; rendering without it.", error);
    }

    interface FogBlob {
      sp: PIXI.Sprite;
      /** Anchor point the sway oscillates around. */
      ox: number;
      oy: number;
      spd: number;
      ph: number;
      /** The definition's alpha, kept so the fog opacity multiplier can be reapplied live. */
      baseAlpha: number;
    }

    let fogBlobs: FogBlob[] = [];
    let farParts: DustParticle[] = [];
    let midParts: DustParticle[] = [];
    let nearParts: DustParticle[] = [];

    /** Destroys a container's sprites. `false` keeps the shared texture alive for the next build. */
    const clearLayer = (layer: PIXI.Container): void => {
      for (const child of layer.removeChildren()) child.destroy(false);
    };

    /**
     * Populates one particle layer: random positions over the current screen, and per-particle
     * speed, scale, base alpha, twinkle phase and twinkle rate drawn from the layer's ranges.
     */
    const buildParticleLayer = (
      layer: PIXI.Container,
      tex: PIXI.Texture,
      count: number,
      colors: readonly number[],
      tuning: (typeof LAYER_TUNING)[keyof typeof LAYER_TUNING],
    ): DustParticle[] => {
      clearLayer(layer);
      const parts: DustParticle[] = [];
      for (let i = 0; i < count; i++) {
        const sp = new PIXI.Sprite(tex);
        sp.anchor.set(0.5);
        const x = rnd(0, stage.width);
        const y = rnd(0, stage.height);
        sp.position.set(x, y);
        sp.scale.set(rnd(tuning.scLo, tuning.scHi) * size);
        sp.tint = pick(colors);
        const ba = rnd(tuning.aLo, tuning.aHi);
        sp.alpha = ba * brightness;
        layer.addChild(sp);
        parts.push({ sp, x, y, spd: rnd(tuning.spdLo, tuning.spdHi), ba, ph: rnd(0, 6.283), br: rnd(0.22, 0.65) });
      }
      return parts;
    };

    const buildBackground = (): void => {
      bgGfx.clear().rect(0, 0, stage.width, stage.height).fill(background);
    };

    const buildFog = (): void => {
      clearLayer(fogLayer);
      fogBlobs = FOG_DEFS.map((def) => {
        const sp = new PIXI.Sprite(texFog);
        sp.anchor.set(0.5);
        sp.x = def.fx * stage.width;
        sp.y = def.fy * stage.height;
        sp.scale.set(def.sc);
        sp.alpha = def.a * fogOpacity;
        sp.tint = def.tint;
        fogLayer.addChild(sp);
        return { sp, ox: sp.x, oy: sp.y, spd: def.spd, ph: def.ph, baseAlpha: def.a };
      });
    };

    const buildAll = (): void => {
      buildBackground();
      buildFog();
      farParts = buildParticleLayer(farLayer, texTiny, farCount, farPalette, LAYER_TUNING.far);
      midParts = buildParticleLayer(midLayer, texMed, midCount, midPalette, LAYER_TUNING.mid);
      nearParts = buildParticleLayer(nearLayer, texGlow, nearCount, nearPalette, LAYER_TUNING.near);
    };

    buildAll();
    // The original re-seeded everything on window resize so the particles cover the new area;
    // `onResize` only fires when the size actually changed, so this stays cheap.
    stage.onResize(buildAll);

    /*
     * Two clocks. `flowT` drives everything that moves and accumulates dt scaled by the speed
     * multiplier, so changing Speed mid-stream slows the scene down rather than teleporting it to
     * a different point of the flow field. `grainT` drives only the film grain and ignores the
     * multiplier — grain is a property of the "film", not of the air, and freezing it at Speed 0
     * would read as a dropped frame.
     */
    let flowT = 0;
    let grainT = 0;

    /** Advances one layer: flow-field drift, screen-edge wraparound, and the alpha twinkle. */
    const step = (parts: DustParticle[], dt: number): void => {
      const w = stage.width;
      const h = stage.height;
      for (const p of parts) {
        const ang = flowAngle(p.x, p.y, flowT);
        p.x += Math.cos(ang) * p.spd * dt;
        p.y += Math.sin(ang) * p.spd * dt;
        if (p.x < -WRAP_MARGIN) p.x = w + WRAP_MARGIN;
        else if (p.x > w + WRAP_MARGIN) p.x = -WRAP_MARGIN;
        if (p.y < -WRAP_MARGIN) p.y = h + WRAP_MARGIN;
        else if (p.y > h + WRAP_MARGIN) p.y = -WRAP_MARGIN;
        p.sp.x = p.x;
        p.sp.y = p.y;
        // The twinkle: alpha breathes ±18% around the base at the particle's own rate and phase.
        p.sp.alpha = p.ba * brightness * (0.82 + 0.18 * Math.sin(flowT * p.br + p.ph));
      }
    };

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      // The original clamped its frame delta to 50 ms so a stall could not fling particles off
      // across the screen; the SDK clock clamps at 100 ms, so this keeps the original's bound.
      const clamped = Math.min(dt, 0.05);
      const scaledDt = clamped * speed;
      flowT += scaledDt;
      grainT += clamped;

      if (postUniforms) postUniforms.uniforms.uTime = grainT;

      // Fog: each blob sways on its own slow Lissajous path around its anchor. The X and Y
      // frequencies differ so the path never visibly repeats.
      for (const f of fogBlobs) {
        f.sp.x = f.ox + Math.cos(flowT * 0.055 + f.ph) * f.spd * 9;
        f.sp.y = f.oy + Math.sin(flowT * 0.038 + f.ph * 0.7) * f.spd * 6;
      }

      step(farParts, scaledDt);
      step(midParts, scaledDt);
      step(nearParts, scaledDt);

      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        const nextFarCount = Math.round(num(p, "farCount", 2000, 0, 4000));
        const nextMidCount = Math.round(num(p, "midCount", 1500, 0, 3000));
        const nextNearCount = Math.round(num(p, "nearCount", 400, 0, 1500));
        const nextFar = parsePalette(str(p, "farColors", FAR_COLORS_TEXT), FAR_COLORS);
        const nextMid = parsePalette(str(p, "midColors", MID_COLORS_TEXT), MID_COLORS);
        const nextNear = parsePalette(str(p, "nearColors", NEAR_COLORS_TEXT), NEAR_COLORS);
        const nextBackground = colorInt(p, "background", BG_DEFAULT);
        const nextSize = num(p, "size", 1, 0.2, 4);

        speed = num(p, "speed", 1, 0, 5);
        brightness = num(p, "brightness", 1, 0, 3);
        fogOpacity = num(p, "fogOpacity", 1, 0, 3);
        vignette = num(p, "vignette", 0.54, 0, 1.5);
        haze = num(p, "haze", 1, 0, 3);
        grain = num(p, "grain", 0.036, 0, 0.15);

        if (postUniforms) {
          postUniforms.uniforms.uVignette = vignette;
          postUniforms.uniforms.uHaze = haze;
          postUniforms.uniforms.uGrain = grain;
        }

        // Fog opacity applies in place; brightness applies through the twinkle line each frame.
        for (const f of fogBlobs) f.sp.alpha = f.baseAlpha * fogOpacity;

        if (nextBackground !== background) {
          background = nextBackground;
          buildBackground();
        }

        /*
         * The rebuild-worthy parameters. A count, palette or size change re-seeds only the layers
         * it touches, keeping the renderer and canvas alive — a full remount would be a black
         * frame on air. Size could scale sprites in place, but the per-particle random scale is
         * not stored, so a rebuild is what keeps repeated changes from compounding.
         */
        const sizeChanged = nextSize !== size;
        size = nextSize;

        const paletteChanged = (a: readonly number[], b: readonly number[]): boolean =>
          a.length !== b.length || a.some((c, i) => c !== b[i]);

        if (sizeChanged || nextFarCount !== farCount || paletteChanged(nextFar, farPalette)) {
          farCount = nextFarCount;
          farPalette = nextFar;
          farParts = buildParticleLayer(farLayer, texTiny, farCount, farPalette, LAYER_TUNING.far);
        }
        if (sizeChanged || nextMidCount !== midCount || paletteChanged(nextMid, midPalette)) {
          midCount = nextMidCount;
          midPalette = nextMid;
          midParts = buildParticleLayer(midLayer, texMed, midCount, midPalette, LAYER_TUNING.mid);
        }
        if (sizeChanged || nextNearCount !== nearCount || paletteChanged(nextNear, nearPalette)) {
          nearCount = nextNearCount;
          nearPalette = nextNear;
          nearParts = buildParticleLayer(nearLayer, texGlow, nearCount, nearPalette, LAYER_TUNING.near);
        }
      },
    };
  },
});
