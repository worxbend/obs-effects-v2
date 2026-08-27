import { assembleFragment, defineEffect } from "../sdk";
import { SPEED_PARAM, shaderQuadSetup } from "./shaderQuad";

/**
 * Razer Aether Drift
 * ==================
 *
 * Folded, silk-like sheets of colour drifting through near-black — indigo through teal into violet,
 * with warm light catching the crests. Extremely slow: a background meant to be looked at for an
 * hour without ever repeating or demanding attention.
 *
 * Ported from `razer-aether-drift.html` in the old `obs-effects` repository. The shader's arithmetic
 * is carried over unchanged; only the mechanical GLSL 3.0 → 1.0 conversion described in
 * `shaderQuad.ts` was applied.
 *
 * Double domain warping, which is the whole effect
 * ------------------------------------------------
 * Fractal noise on its own looks like clouds. What makes this look like *folded fabric* is warping
 * the coordinate twice: the noise field is sampled to produce an offset, that offset displaces
 * where the next sample is taken, and the result displaces a third. Each round stretches the
 * structure along its own gradients, which is exactly what happens to a material when it creases.
 *
 * Its `aetherFbm` stays inline rather than using one of the SDK's shared chunks, because its
 * rotation matrix and per-octave offset differ from both of them, and those constants are what give
 * this shader its particular grain.
 */
const FRAGMENT_SHADER = assembleFragment(
  ["hash12", "vnoise"],
  /* glsl */ `
  varying vec2 vUv;

  uniform float uTime;
  uniform vec2 uResolution;



  const mat2 AETHER_ROT = mat2(0.80, 0.60, -0.60, 0.80);

  float aetherFbm(vec2 p) {
    float v = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 5; i++) {
      v += amp * vnoise(p);
      p = AETHER_ROT * p * 2.03 + vec2(11.7, 5.3);
      amp *= 0.5;
    }
    return v;
  }

  void main() {
    vec2 uvN = vUv;
    vec2 uv = (uvN - 0.5) * vec2(uResolution.x / uResolution.y, 1.0);

    float t = uTime;

    // Glacial camera drift with a slow breathing zoom
    float zoom = 1.0 + 0.06 * sin(t * 0.05);
    vec2 cam = vec2(0.015 * t, 0.012 * sin(t * 0.07));
    vec2 p = uv * 2.4 * zoom + cam;

    // Double domain warp — the folded silk structure
    vec2 q = vec2(aetherFbm(p), aetherFbm(p + vec2(5.2, 1.3)));
    vec2 w1 = p + 3.6 * q + vec2(1.7 + 0.09 * t, 9.2 - 0.06 * t);
    vec2 r = vec2(aetherFbm(w1), aetherFbm(w1 + vec2(8.3, 2.8)));
    float f = aetherFbm(p + 3.2 * r);

    // Base grade: near-black abyss through indigo, teal undercurrent,
    // violet folds, warm light catching the crests
    vec3 deep = vec3(0.010, 0.014, 0.032);
    vec3 abyss = vec3(0.043, 0.073, 0.150);
    vec3 teal = vec3(0.000, 0.430, 0.520);
    vec3 violet = vec3(0.470, 0.160, 0.640);
    vec3 ember = vec3(1.000, 0.690, 0.400);

    vec3 col = mix(deep, abyss, clamp(f * f * 2.4, 0.0, 1.0));
    col = mix(col, teal, 0.55 * clamp(length(q) * 0.85, 0.0, 1.0));
    col = mix(col, violet, 0.50 * clamp(r.x * r.x * 1.5, 0.0, 1.0));

    float crest = smoothstep(0.58, 0.92, f);
    col += ember * crest * 0.38;

    // Silk sheen: shade the relief with a slowly orbiting light,
    // tint the specular with a thin-film iridescence cycle
    float px = uResolution.y * 0.0125;
    vec3 nrm = normalize(vec3(-dFdx(f) * px, -dFdy(f) * px, 1.0));
    vec3 ldir = normalize(vec3(0.6 * cos(t * 0.06), 0.6 * sin(t * 0.047), 0.55));
    float diff = clamp(dot(nrm, ldir), 0.0, 1.0);
    float spec = pow(diff, 24.0);

    vec3 irid =
      0.5 + 0.5 * cos(6.28318 * (f * 1.6 + t * 0.012 + vec3(0.0, 0.33, 0.67)));
    col += irid * spec * 0.45;
    col += vec3(0.90, 0.95, 1.00) * pow(diff, 90.0) * 0.35;

    // Drifting ember dust — three parallax layers of twinkling glints
    float dust = 0.0;
    for (int i = 0; i < 3; i++) {
      float fi = float(i);
      float sc = 18.0 + fi * 14.0;
      vec2 sp = uv * sc + vec2(t * (0.25 + fi * 0.18), t * (0.05 + fi * 0.03)) +
        fi * 17.0;
      vec2 cell = floor(sp);
      float h = hash12(cell);
      if (h > 0.985) {
        vec2 fr = fract(sp) - 0.5;
        vec2 jitter = (vec2(hash12(cell + 3.1), hash12(cell + 7.7)) - 0.5) * 0.6;
        float d = length(fr + jitter);
        float tw = 0.5 + 0.5 * sin(t * (1.5 + h * 4.0) + h * 40.0);
        dust += smoothstep(0.10, 0.0, d) * tw * (1.0 - fi * 0.25);
      }
    }
    col += vec3(0.95, 0.85, 0.70) * dust * 0.5;

    // Soft wandering glow, like distant light behind the veil
    vec2 gpos = vec2(0.42 * sin(t * 0.031), -0.22 + 0.10 * cos(t * 0.023));
    col += vec3(0.10, 0.13, 0.22) * exp(-2.1 * length(uv - gpos));

    // Cinematic finish: filmic curve, vignette, fine grain
    col = 1.0 - exp(-col * 2.0);

    vec2 vc = uvN - 0.5;
    col *= 1.0 - 1.1 * dot(vc, vc);

    float grain = hash12(uvN * uResolution + fract(t) * 100.0) - 0.5;
    col += grain * 0.015;

    gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
  }
`,
);

const razerAetherDrift = defineEffect({
  descriptor: {
    id: "razer-aether-drift",
    name: "Razer Aether Drift",
    description:
      "Folded silk-like sheets of indigo, teal and violet drifting through near-black, with warm light on the crests. Very slow, and never repeats.",
    engine: "three",
    category: "background",
    tags: ["razer", "background", "aether", "silk", "calm", "shader"],
    previewNotes:
      "An opaque full-frame background and the calmest in the collection \u2014 designed to sit behind a scene for an hour. Raise Speed well above 1 if you want to see it move in a preview; at the default it takes a minute to change noticeably.",
    params: [SPEED_PARAM],
  },
  setup: shaderQuadSetup({ fragment: FRAGMENT_SHADER }),
});

export default razerAetherDrift;
