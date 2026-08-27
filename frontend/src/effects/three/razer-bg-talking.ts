import { assembleFragment, defineEffect } from "../sdk";
import { SPEED_PARAM, shaderQuadSetup } from "./shaderQuad";

/**
 * Razer BG Talking
 * ================
 *
 * A near-black fog with a slow breathing radial glow, lifted gently by your voice. Deliberately calm — a background for a talking scene that never pulls focus.
 *
 * Ported from `razer-bg-talking.html` in the old `obs-effects` repository, where it was a `ShaderQuadScreen`
 * subclass — a fragment shader and one line of constructor. The shader below is that shader, with
 * only the three mechanical changes every port in this family needed: the GLSL 3.0 `in`/`out`
 * declarations became a `varying` and `gl_FragColor`, and the shared noise snippet became the
 * SDK's `hash12`/`vnoise`/`fbmVnoise` chunks. The arithmetic is untouched.
 *
 * See `shaderQuad.ts` for what drives `uTime`, `uResolution` and `uAudio`, and what `uAudio` honestly is.
 */
const FRAGMENT_SHADER = assembleFragment(
  ["hash12", "vnoise", "fbmVnoise"],
  /* glsl */ `
  varying vec2 vUv;

  uniform float uTime;
  uniform vec2 uResolution;
  uniform vec4 uAudio; // level, slow, mid, fast \u2014 see shaderQuad.ts: these are
                       // envelopes at three speeds, not frequency bands


  void main() {
    vec2 uvN = vUv;
    float asp = uResolution.x / uResolution.y;
    vec2 p = (uvN - 0.5) * vec2(asp, 1.0);
    float t = uTime;

    float level = uAudio.x;

    vec3 deep = vec3(0.000, 0.010, 0.000);
    vec3 abyss = vec3(0.000, 0.045, 0.012);
    vec3 glow = vec3(0.000, 0.560, 0.190);

    // Slow drifting fog, two octaves, barely moving.
    float fog = fbmVnoise(p * 1.4 + vec2(t * 0.015, -t * 0.011));
    fog += 0.4 * fbmVnoise(p * 3.1 - vec2(t * 0.02, t * 0.008));

    vec3 col = mix(deep, abyss, clamp(fog * 1.3, 0.0, 1.0));

    // Breathing radial glow, gently lifted by voice level.
    float breath = 0.5 + 0.5 * sin(t * 0.22);
    float dist = length(p);
    float radial = exp(-dist * dist * (2.6 - breath * 0.5 - level * 0.4));
    col += glow * radial * (0.35 + breath * 0.15 + level * 0.35);

    // Faint horizontal light band, like a studio backlight.
    float band = exp(-pow((p.y + 0.05) * 3.2, 2.0));
    col += glow * band * 0.10;

    // Very fine grain to avoid banding.
    float grain = hash12(uvN * uResolution + fract(t) * 30.0) - 0.5;
    col += grain * 0.008;

    vec2 vc = uvN - 0.5;
    col *= 1.0 - 0.5 * dot(vc, vc);

    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`,
);

const razerBgTalking = defineEffect({
  descriptor: {
    id: "razer-bg-talking",
    name: "Razer BG Talking",
    description:
      "A near-black fog with a slow breathing radial glow, lifted gently by your voice. Deliberately calm — a background for a talking scene that never pulls focus.",
    engine: "three",
    category: "background",
    tags: ["razer", "background", "calm", "fog", "talking", "reactive"],
    previewNotes:
      "The quietest background in the razer family. Opaque and very dark, designed to sit behind a webcam without competing with it. The glow breathes on its own and lifts a little with the audio level.",
    params: [SPEED_PARAM],
  },
  setup: shaderQuadSetup({ fragment: FRAGMENT_SHADER, reactive: true }),
});

export default razerBgTalking;
