import { assembleFragment, defineEffect } from "../sdk";
import { SPEED_PARAM, shaderQuadSetup } from "./shaderQuad";

/**
 * Razer Audio Cam Border
 * ======================
 *
 * A camera frame that doubles as a level meter: the border itself swells, brightens and ripples with what OBS is playing.
 *
 * Ported from `razer-audio-cam-border.html` in the old `obs-effects` repository, where it was a `ShaderQuadScreen`
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

  const float PI  = 3.14159265358979;
  const float TAU = 6.28318530718;


  float angDist(float a, float b) {
    return abs(mod(a - b + PI, TAU) - PI);
  }

  float bump(float a, float centre, float hw, float h) {
    float d = angDist(a, centre);
    return h * exp(-(d * d) / (hw * hw));
  }

  float outerProfile(float a, float t, float bass) {
    float rot = t * 0.08;
    float w  = 0.012 * sin(a * 2.0 + t * 0.30 + rot * 2.1);
         w += 0.008 * sin(a * 3.0 - t * 0.24 + rot * 1.7 + 1.1);
         w += 0.005 * sin(a * 5.0 + t * 0.42 + 2.4);
    w = max(0.0, w);

    float boost = 0.6 + bass * 1.8;
    float s1 = bump(a, rot + 1.35, 0.40, 0.075 * boost * (0.7 + 0.3 * sin(t * 0.8)));
    float s2 = bump(a, rot + 2.95, 0.30, 0.066 * boost * (0.7 + 0.3 * sin(t * 0.65 + 1.4)));
    float s3 = bump(a, rot - 1.55, 0.34, 0.058 * boost * (0.7 + 0.3 * sin(t * 0.9 + 2.2)));
    float s4 = bump(a, rot - 0.30, 0.20, 0.048 * boost * (0.7 + 0.3 * sin(t * 0.75 + 0.7)));
    float s5 = bump(a, rot + 0.60, 0.13, 0.038 * boost * (0.7 + 0.3 * sin(t * 1.1 + 3.1)));

    return w + s1 + s2 + s3 + s4 + s5;
  }

  void main() {
    vec2 uvN = vUv;
    float asp = uResolution.x / uResolution.y;
    vec2 p = (uvN - 0.5) * vec2(asp, 1.0);
    float t = uTime;

    float level = uAudio.x;
    float bass = uAudio.y;

    vec2 wp = p + 0.014 * vec2(
      fbmVnoise(p * 3.6 + vec2(t * 0.08, 0.42)),
      fbmVnoise(p * 3.6 + vec2(0.91, t * 0.09))
    );

    float rC = length(p);
    float rW = length(wp);
    float aW = atan(wp.y, wp.x);

    const float RR  = 0.155;
    const float BHW = 0.020;
    float pulse = BHW * (1.0 + level * 0.9);

    float outer = RR + pulse + outerProfile(aW, t, bass);
    float inner = RR - pulse * 0.7;

    float maskI = smoothstep(inner - 0.005, inner, rC);
    float maskO = smoothstep(outer + 0.012, outer, rW);
    float ring = maskI * maskO;

    vec3 base = vec3(0.000, 0.760, 0.260);
    vec3 lite = vec3(0.210, 1.000, 0.000);

    vec3 ldir = normalize(vec3(-0.42, 0.65, 0.65));
    vec3 snorm = normalize(vec3(wp, 0.28));
    float spec = pow(max(0.0, dot(snorm, ldir)), 4.5);

    float outerFresnel = smoothstep(0.018, 0.0, outer - rW) * maskI;
    float innerRim = smoothstep(inner + 0.020, inner + 0.003, rC) * maskO;

    vec3 col = base;
    col = mix(col, lite, spec * 0.55 + level * 0.25);
    col = mix(col, lite, outerFresnel * (0.45 + bass * 0.4));
    col = mix(col, lite * 0.9, innerRim * 0.30);

    float alpha = clamp(ring, 0.0, 1.0);
    gl_FragColor = vec4(col * alpha, alpha);
  }
`,
);

const razerAudioCamBorder = defineEffect({
  descriptor: {
    id: "razer-audio-cam-border",
    name: "Razer Audio Cam Border",
    description:
      "A camera frame that doubles as a level meter: the border itself swells, brightens and ripples with what OBS is playing.",
    engine: "three",
    category: "reactive",
    tags: ["razer", "overlay", "border", "camera", "audio", "reactive"],
    previewNotes:
      "The most audio-driven of the border family — with no audio it is close to a plain ring, so configure the OBS connection under Settings to see what it does.",
    params: [SPEED_PARAM],
  },
  setup: shaderQuadSetup({ fragment: FRAGMENT_SHADER, reactive: true }),
});

export default razerAudioCamBorder;
