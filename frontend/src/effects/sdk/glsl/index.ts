/**
 * The shared GLSL library.
 *
 * GLSL is the C-like language shaders are written in; it runs on the GPU, once per pixel. It has no
 * import system at all — a shader is one flat string of source text — so the only way to share a
 * function between two shaders is to paste it in. Which is what happened: `plasma-shader.ts`
 * carried its own hand-written `hash`, `noise` and `fbm`, and the next shader-based effect would
 * have carried a second copy.
 *
 * This file is the library those copies come from. Most original effects are *a shader plus a
 * palette*, so a good utility library is the difference between writing the next one in an
 * afternoon and writing it in a week.
 *
 * ## How it is put together, and why there is no build step
 *
 * Each chunk is a plain exported string. {@link assembleFragment} concatenates the ones you name,
 * plus anything they depend on, each exactly once, and puts your shader body underneath.
 *
 * ```ts
 * const fragment = assembleFragment(["hash", "noise2", "fbm"], `
 *   varying vec2 vUv;
 *   uniform float uTime;
 *   void main() {
 *     float v = fbm(vUv * 4.0 + uTime);
 *     gl_FragColor = vec4(vec3(v), 1.0);
 *   }
 * `);
 * ```
 *
 * There is deliberately no preprocessor, no `#include` substitution and no file loading. Everything
 * here is an ordinary JavaScript string that Vite can hot-reload, which is what the shader
 * playground planned for roadmap item 3.3 needs in order to be live.
 *
 * ## Naming
 *
 * Chunk-private helpers are prefixed (`s2_permute`, `s3_mod289`) so that two chunks in the same
 * shader can never collide on a name. Public functions are not prefixed — you call `fbm`,
 * `simplex3`, `sdRoundedBox`.
 */

/** Which other chunks each chunk needs. Resolved transitively by {@link assembleFragment}. */
const DEPENDENCIES: Record<string, readonly string[]> = {
  noise2: ["hash"],
  vnoise: ["hash12"],
  fbmRot: ["vnoise"],
  fbmVnoise: ["vnoise"],
  fbm: ["noise2"],
  domainWarp: ["fbm"],
  curl3: ["simplex3"],
  palette: [],
};

/**
 * The chunk table.
 *
 * | chunk | what it gives you |
 * |---|---|
 * | `hash` | `float hash(vec2)`, `float hash1(float)` — deterministic pseudo-random values |
 * | `noise2` | `float noise2(vec2)` — smooth value noise on a grid *(needs `hash`)* |
 * | `simplex2` | `float simplex2(vec2)` — gradient noise, -1..1, no grid artefacts |
 * | `simplex3` | `float simplex3(vec3)` — the same in three dimensions; use `z` as time |
 * | `fbm` | `float fbm(vec2)`, `float fbm(vec2, int)` — stacked octaves of `noise2` *(needs `noise2`)* |
 * | `curl3` | `vec3 curl3(vec3)` — a divergence-free flow field, for smoke-like motion *(needs `simplex3`)* |
 * | `domainWarp` | `float domainWarp(vec2, float)` — noise fed into the coordinates of more noise *(needs `fbm`)* |
 * | `hsv2rgb` | `vec3 hsv2rgb(vec3)` |
 * | `rgb2hsv` | `vec3 rgb2hsv(vec3)` |
 * | `srgb` | `vec3 toLinear(vec3)`, `vec3 toSrgb(vec3)` — gamma conversion |
 * | `palette` | `vec3 paletteRamp(vec3[8], int, float)` — samples a baked palette uniform |
 * | `easing` | `easeInOutCubic`, `easeOutBack`, `pulse`, `remap` |
 * | `sdCircle` | `float sdCircle(vec2, float)` |
 * | `sdBox` | `float sdBox(vec2, vec2)` |
 * | `sdRoundedBox` | `float sdRoundedBox(vec2, vec2, float)` |
 * | `sdSegment` | `float sdSegment(vec2, vec2, vec2)` |
 * | `aaStep` | `float aaStep(float, float)` — a resolution-independent antialiased edge |
 *
 * A *signed distance field* (SDF) function returns how far a point is from a shape: negative
 * inside, zero on the edge, positive outside. Feeding that through `aaStep` is how you draw a
 * crisp shape with smooth edges at any resolution, with no textures involved.
 */
export const GLSL = {
  hash: /* glsl */ `
    // Deterministic pseudo-random value in 0..1 for a 2D point. The large constants are arbitrary;
    // what matters is that sin() of a big number scrambles the bits so nearby points look unrelated.
    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }
    float hash1(float x) {
      return fract(sin(x * 78.233) * 43758.5453123);
    }
  `,

  noise2: /* glsl */ `
    // Value noise: random values on an integer grid, smoothly blended in between. The
    // t*t*(3-2t) curve ("smoothstep") eases the blend in and out so no grid lines are visible.
    float noise2(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      float a = hash(i);
      float b = hash(i + vec2(1.0, 0.0));
      float c = hash(i + vec2(0.0, 1.0));
      float d = hash(i + vec2(1.0, 1.0));
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    }
  `,

  hash12: /* glsl */ `
    // A second pseudo-random hash, and it is worth explaining why there are two.
    //
    // \`hash\` above multiplies by a large constant and takes sin() of it. That is the classic
    // one-liner, and it has a real weakness: sin() is implemented differently on different GPUs,
    // and at large arguments the results diverge, so the same shader can look subtly different on
    // an AMD card and an Intel one. It also degrades visibly at large coordinates.
    //
    // This one — Dave Hoskins' "hash without sine" — uses only fract() and dot(), so it is exact
    // and identical everywhere, and it stays clean far from the origin.
    //
    // Both are kept because they produce *different noise*, and noise is not an implementation
    // detail: an effect built to look right on one will not look the same on the other. Existing
    // effects keep \`hash\`; the ported razer-* family uses this one, which is what its shaders were
    // authored against.
    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
  `,

  vnoise: /* glsl */ `
    // Value noise on the unit grid, built on hash12. Identical in shape to \`noise2\`, but seeded by
    // the sine-free hash, so the two produce different — equally valid — patterns.
    float vnoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      float a = hash12(i);
      float b = hash12(i + vec2(1.0, 0.0));
      float c = hash12(i + vec2(0.0, 1.0));
      float d = hash12(i + vec2(1.0, 1.0));
      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    }
  `,

  fbmRot: /* glsl */ `
    // Five octaves of \`vnoise\` with a rotation between each one.
    //
    // The rotation is the point. Stacking octaves that are only scaled and offset leaves a faint
    // axis-aligned grid in the result; rotating by a fixed angle each time breaks that alignment up,
    // which is what lets these shaders warp their domain several times over without the structure
    // showing through.
    //
    // The constants — 2.02 lacunarity, 0.49 gain, and that particular matrix — are carried over
    // verbatim from the effects this was extracted from, because changing any of them changes how
    // every one of them looks.
    float fbmRot(vec2 p) {
      const mat2 ROT2 = mat2(0.74, 0.67, -0.67, 0.74);
      float v = 0.0;
      float amp = 0.5;
      for (int i = 0; i < 6; i++) {
        v += amp * vnoise(p);
        p = ROT2 * p * 2.02 + vec2(6.3, 4.1);
        amp *= 0.49;
      }
      return v;
    }
  `,

  fbmVnoise: /* glsl */ `
    // Five octaves of \`vnoise\`, offset rather than rotated between each one.
    //
    // The plainer sibling of \`fbmRot\`. Where that one rotates the coordinate system each octave to
    // break up axis alignment, this simply scales and shifts — which is cheaper, and enough when the
    // result is going to be warped or thresholded afterwards anyway.
    //
    // The constants (2.03 lacunarity, 0.5 gain, that offset) are carried over verbatim from the
    // razer-* shaders this was extracted from. Changing any of them changes how all of them look.
    float fbmVnoise(vec2 p) {
      float v = 0.0;
      float a = 0.5;
      for (int i = 0; i < 5; i++) {
        v += a * vnoise(p);
        p = p * 2.03 + vec2(3.71, 1.43);
        a *= 0.5;
      }
      return v;
    }
  `,

  simplex2: /* glsl */ `
    // 2D simplex noise, returning -1..1. Simplex noise interpolates between random *gradients*
    // rather than random values, which is why it has none of the axis-aligned streaking that value
    // noise shows when you stack many octaves of it. Based on Ashima Arts' public-domain version.
    vec2 s2_mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec3 s2_mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec3 s2_permute(vec3 x) { return s2_mod289(((x * 34.0) + 1.0) * x); }

    float simplex2(vec2 v) {
      const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                         -0.577350269189626, 0.024390243902439);
      vec2 i  = floor(v + dot(v, C.yy));
      vec2 x0 = v - i + dot(i, C.xx);
      vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
      vec4 x12 = x0.xyxy + C.xxzz;
      x12.xy -= i1;
      i = s2_mod289(i);
      vec3 p = s2_permute(s2_permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
      vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
      m = m * m;
      m = m * m;
      vec3 x = 2.0 * fract(p * C.www) - 1.0;
      vec3 h = abs(x) - 0.5;
      vec3 ox = floor(x + 0.5);
      vec3 a0 = x - ox;
      m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
      vec3 g;
      g.x  = a0.x  * x0.x   + h.x  * x0.y;
      g.yz = a0.yz * x12.xz + h.yz * x12.yw;
      return 130.0 * dot(m, g);
    }
  `,

  simplex3: /* glsl */ `
    // 3D simplex noise, returning -1..1. Pass time as the third coordinate to get a field that
    // evolves smoothly instead of scrolling. Based on Ashima Arts' public-domain version.
    vec3 s3_mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec4 s3_mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec4 s3_permute(vec4 x) { return s3_mod289(((x * 34.0) + 1.0) * x); }
    vec4 s3_taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

    float simplex3(vec3 v) {
      const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
      const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

      vec3 i  = floor(v + dot(v, C.yyy));
      vec3 x0 = v - i + dot(i, C.xxx);

      vec3 g = step(x0.yzx, x0.xyz);
      vec3 l = 1.0 - g;
      vec3 i1 = min(g.xyz, l.zxy);
      vec3 i2 = max(g.xyz, l.zxy);

      vec3 x1 = x0 - i1 + C.xxx;
      vec3 x2 = x0 - i2 + C.yyy;
      vec3 x3 = x0 - D.yyy;

      i = s3_mod289(i);
      vec4 p = s3_permute(s3_permute(s3_permute(
                 i.z + vec4(0.0, i1.z, i2.z, 1.0))
               + i.y + vec4(0.0, i1.y, i2.y, 1.0))
               + i.x + vec4(0.0, i1.x, i2.x, 1.0));

      float n_ = 0.142857142857;
      vec3 ns = n_ * D.wyz - D.xzx;

      vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

      vec4 x_ = floor(j * ns.z);
      vec4 y_ = floor(j - 7.0 * x_);

      vec4 x = x_ * ns.x + ns.yyyy;
      vec4 y = y_ * ns.x + ns.yyyy;
      vec4 h = 1.0 - abs(x) - abs(y);

      vec4 b0 = vec4(x.xy, y.xy);
      vec4 b1 = vec4(x.zw, y.zw);

      vec4 s0 = floor(b0) * 2.0 + 1.0;
      vec4 s1 = floor(b1) * 2.0 + 1.0;
      vec4 sh = -step(h, vec4(0.0));

      vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
      vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

      vec3 p0 = vec3(a0.xy, h.x);
      vec3 p1 = vec3(a0.zw, h.y);
      vec3 p2 = vec3(a1.xy, h.z);
      vec3 p3 = vec3(a1.zw, h.w);

      vec4 norm = s3_taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
      p0 *= norm.x;
      p1 *= norm.y;
      p2 *= norm.z;
      p3 *= norm.w;

      vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
      m = m * m;
      return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
    }
  `,

  fbm: /* glsl */ `
    // Fractal Brownian motion: several layers ("octaves") of noise added together, each twice as
    // fine and half as strong as the last. That self-similar stacking is what makes the result look
    // like cloud or smoke instead of blobs. The 2.02 rather than 2.0 avoids axis-aligned repeats.
    float fbm(vec2 p, int octaves) {
      float sum = 0.0;
      float amplitude = 0.5;
      for (int i = 0; i < 8; i++) {
        if (i >= octaves) break;
        sum += amplitude * noise2(p);
        p *= 2.02;
        amplitude *= 0.5;
      }
      return sum;
    }
    float fbm(vec2 p) { return fbm(p, 5); }
  `,

  curl3: /* glsl */ `
    // The curl of a noise field: a flow field with zero divergence, which means nothing ever piles
    // up or thins out. Advecting particles along it gives convincing smoke and fluid motion.
    // Computed by finite differences, because there is no analytic derivative of simplex noise.
    vec3 curl3(vec3 p) {
      const float e = 0.1;
      float x1 = simplex3(p + vec3(0.0, e, 0.0));
      float x2 = simplex3(p - vec3(0.0, e, 0.0));
      float y1 = simplex3(p + vec3(0.0, 0.0, e));
      float y2 = simplex3(p - vec3(0.0, 0.0, e));
      float z1 = simplex3(p + vec3(e, 0.0, 0.0));
      float z2 = simplex3(p - vec3(e, 0.0, 0.0));
      return normalize(vec3(x1 - x2, y1 - y2, z1 - z2) / (2.0 * e));
    }
  `,

  domainWarp: /* glsl */ `
    // Domain warping: feed noise into the *coordinates* of more noise. This is the standard trick
    // for turning bland clouds into swirling, liquid-looking plasma. 'amount' is how far the
    // coordinates are pushed; around 2.0 is a good starting point.
    float domainWarp(vec2 p, float amount) {
      vec2 warp = vec2(fbm(p), fbm(p + vec2(5.2, 1.3)));
      return fbm(p + warp * amount);
    }
  `,

  hsv2rgb: /* glsl */ `
    // Hue (0..1 around the colour wheel), saturation, value -> red, green, blue.
    vec3 hsv2rgb(vec3 c) {
      vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
      vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
      return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
    }
  `,

  rgb2hsv: /* glsl */ `
    vec3 rgb2hsv(vec3 c) {
      vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
      vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
      vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
      float d = q.x - min(q.w, q.y);
      float e = 1.0e-10;
      return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
    }
  `,

  srgb: /* glsl */ `
    // sRGB is the gamma-encoded space colour pickers and PNG files use; linear is the space light
    // actually adds up in. Blend and blur in linear, hand the result back as sRGB.
    vec3 toLinear(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }
    vec3 toSrgb(vec3 c)   { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }
  `,

  palette: /* glsl */ `
    // Samples a palette that was baked into a uniform on the CPU by paletteUniform(p, 8).
    // Declare the uniform yourself as: uniform vec3 uPalette[8]; uniform int uPaletteCount;
    vec3 paletteRamp(vec3 stops[8], int count, float t) {
      float clamped = clamp(t, 0.0, 1.0);
      float scaled = clamped * float(count - 1);
      int index = int(floor(scaled));
      if (index > count - 2) index = count - 2;
      if (index < 0) index = 0;
      float local = scaled - float(index);
      vec3 a = stops[0];
      vec3 b = stops[1];
      // The pair is picked with a loop rather than by indexing with 'index' directly: GLSL ES 1.00
      // only allows a uniform array to be indexed by a loop counter or a constant, and three.js
      // compiles a ShaderMaterial as GLSL ES 1.00 unless told otherwise.
      for (int i = 0; i < 7; i++) {
        if (i == index) { a = stops[i]; b = stops[i + 1]; }
      }
      return mix(a, b, local);
    }
  `,

  easing: /* glsl */ `
    float easeInOutCubic(float t) {
      return t < 0.5 ? 4.0 * t * t * t : 1.0 - pow(-2.0 * t + 2.0, 3.0) / 2.0;
    }
    float easeOutBack(float t) {
      float c1 = 1.70158;
      float c3 = c1 + 1.0;
      return 1.0 + c3 * pow(t - 1.0, 3.0) + c1 * pow(t - 1.0, 2.0);
    }
    // A soft bump centred on 'centre', 'width' wide, 0 outside and 1 at the peak.
    float pulse(float x, float centre, float width) {
      float d = abs(x - centre) / max(width, 1.0e-5);
      return 1.0 - smoothstep(0.0, 1.0, d);
    }
    // Rescales x from the range [a, b] to the range [c, d].
    float remap(float x, float a, float b, float c, float d) {
      return c + (d - c) * clamp((x - a) / max(b - a, 1.0e-5), 0.0, 1.0);
    }
  `,

  sdCircle: /* glsl */ `
    // Signed distance to a circle of radius r centred on the origin: negative inside, 0 on the
    // edge, positive outside.
    float sdCircle(vec2 p, float r) { return length(p) - r; }
  `,

  sdBox: /* glsl */ `
    // Signed distance to an axis-aligned box whose half-width and half-height are b.
    float sdBox(vec2 p, vec2 b) {
      vec2 d = abs(p) - b;
      return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
    }
  `,

  sdRoundedBox: /* glsl */ `
    // The same box with corners rounded by radius r. The workhorse for webcam frames and cards.
    float sdRoundedBox(vec2 p, vec2 b, float r) {
      vec2 d = abs(p) - b + r;
      return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
    }
  `,

  sdSegment: /* glsl */ `
    // Signed distance to the line segment from a to b. Add a radius to it to draw a thick line
    // with perfectly round caps.
    float sdSegment(vec2 p, vec2 a, vec2 b) {
      vec2 pa = p - a;
      vec2 ba = b - a;
      float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
      return length(pa - ba * h);
    }
  `,

  aaStep: /* glsl */ `
    // An antialiased edge whose softness is exactly one screen pixel, whatever the resolution.
    // fwidth() reports how much its argument changes between neighbouring pixels, which is what
    // makes this resolution-independent where a hard-coded smoothstep width is not.
    // Requires the GL_OES_standard_derivatives extension on WebGL 1; WebGL 2 has it built in,
    // and three.js targets WebGL 2, so nothing needs enabling.
    float aaStep(float threshold, float value) {
      float w = fwidth(value) * 0.70710678;
      return smoothstep(threshold - w, threshold + w, value);
    }
  `,
} as const;

/** The name of a chunk in {@link GLSL}. */
export type GlslChunk = keyof typeof GLSL;

/**
 * The passthrough vertex shader for a full-screen quad.
 *
 * `plasma-shader.ts` defined this inline, and every screen-space shader effect needs exactly the
 * same six lines: the quad's vertices are already in clip space (-1..1), so there is no camera
 * maths to do — the position is written straight out and the surface coordinate is handed to the
 * fragment stage as `vUv`.
 *
 * Pair it with `createThreeStage(scope, ctx, { camera: { kind: "fullscreen-quad" } })`.
 */
export const FULLSCREEN_VERTEX: string = /* glsl */ `
  varying vec2 vUv;
  void main() {
    // uv is the plane's built-in 0..1 surface coordinate; pass it to the fragment stage unchanged.
    vUv = uv;
    // The quad already lives in clip space, so no projection is needed.
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/** Adds `name` and everything it needs to `out`, dependencies first, each exactly once. */
function collect(name: string, out: string[], seen: Set<string>): void {
  if (seen.has(name)) return;
  seen.add(name);
  for (const dependency of DEPENDENCIES[name] ?? []) collect(dependency, out, seen);
  const source = (GLSL as Record<string, string>)[name];
  if (source === undefined) {
    console.error(`[sdk] Unknown GLSL chunk "${name}". It will be missing from the shader.`);
    return;
  }
  out.push(source);
}

/**
 * Builds a complete fragment shader: a precision declaration, the named chunks and their
 * dependencies, then your body.
 *
 * Naming a chunk that another chunk already pulled in is harmless — each one appears once, in
 * dependency order — so `["hash", "noise2", "fbm"]` and `["fbm"]` produce the same shader. Spelling
 * out the whole list anyway is worth it: it documents at the call site what the shader is made of.
 *
 * **Do not put `precision highp float;` in your body.** This function emits it first, because it
 * has to appear before any function that uses a `float`.
 *
 * @param chunks names from {@link GLSL}, in any order.
 * @param body   your `varying`/`uniform` declarations and `void main()`.
 */
export function assembleFragment(chunks: readonly GlslChunk[], body: string): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const name of chunks) collect(name, parts, seen);
  return `precision highp float;\n${parts.join("\n")}\n${body}\n`;
}
