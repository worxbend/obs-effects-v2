import { assembleFragment, defineEffect } from "../sdk";
import { SPEED_PARAM, shaderQuadSetup } from "./shaderQuad";

/**
 * Razer Cam Border Rect
 * =====================
 *
 * A small centred rounded-rectangle frame in toxic green, with an audio-reactive pulsing edge and glints that travel around the corners.
 *
 * Ported from `razer-cam-border-rect.html` in the old `obs-effects` repository, where it was a `ShaderQuadScreen`
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


  float sdRoundBox(vec2 p, vec2 halfExtent, float radius) {
    vec2 q = abs(p) - halfExtent + radius;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
  }

  void main() {
    float asp = uResolution.x / uResolution.y;
    vec2 p = (vUv - 0.5) * vec2(asp, 1.0);
    float t = uTime;

    float level = uAudio.x;
    float bass = uAudio.y;

    vec2 wob = 0.006 * vec2(
      fbmVnoise(p * 6.0 + vec2(t * 0.1, 0.3)),
      fbmVnoise(p * 6.0 + vec2(0.7, t * 0.11))
    );

    vec2 halfExtent = vec2(0.205, 0.155) * (1.0 + level * 0.05);
    float radius = 0.03;
    float d = sdRoundBox(p - wob, halfExtent, radius);

    float thickness = 0.010 + bass * 0.012;
    float ring = smoothstep(thickness, thickness - 0.008, abs(d));

    vec2 cornerLocal = abs(p) - halfExtent + radius;
    float cornerProx = 1.0 - smoothstep(0.0, 0.05, length(max(cornerLocal, 0.0)));
    float cornerGlow = cornerProx * (0.6 + bass * 1.0);

    float ang = atan(p.y, p.x);
    float glint = pow(0.5 + 0.5 * sin(ang * 1.0 - t * 0.7), 30.0) * ring;

    vec3 base = vec3(0.000, 0.760, 0.260);
    vec3 lite = vec3(0.210, 1.000, 0.000);
    vec3 crest = vec3(0.690, 1.000, 0.000);

    vec3 col = base;
    col = mix(col, lite, cornerGlow * 0.6 + level * 0.2);
    col += crest * glint;

    float alpha = clamp(ring * (0.85 + level * 0.15) + glint * 0.5, 0.0, 1.0);
    gl_FragColor = vec4(col * alpha, alpha);
  }
`,
);

const razerCamBorderRect = defineEffect({
  descriptor: {
    id: "razer-cam-border-rect",
    name: "Razer Cam Border Rect",
    description:
      "A small centred rounded-rectangle frame in toxic green, with an audio-reactive pulsing edge and glints that travel around the corners.",
    engine: "three",
    category: "overlay",
    tags: ["razer", "overlay", "border", "camera", "reactive", "green"],
    previewNotes:
      "An overlay: transparent everywhere except the frame, so lay it over a webcam source. The frame is centred and sized for a small camera — use the route's canvas size to match your source.",
    params: [SPEED_PARAM],
  },
  setup: shaderQuadSetup({ fragment: FRAGMENT_SHADER, reactive: true }),
});

export default razerCamBorderRect;
