import { assembleFragment, defineEffect } from "../sdk";
import { SPEED_PARAM, shaderQuadSetup } from "./shaderQuad";

/**
 * Razer Cam Border Rhombic
 * ========================
 *
 * A diamond-shaped toxic-green camera frame that pulses with the audio.
 *
 * Ported from `razer-cam-border-rhombic.html` in the old `obs-effects` repository, where it was a `ShaderQuadScreen`
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
    float asp = uResolution.x / uResolution.y;
    vec2 p = (vUv - 0.5) * vec2(asp, 1.0);
    float t = uTime;

    float level = uAudio.x;
    float bass = uAudio.y;

    float rot = t * 0.05;
    vec2 pr = vec2(
      p.x * cos(rot) - p.y * sin(rot),
      p.x * sin(rot) + p.y * cos(rot)
    );

    float rx = 0.235 * (1.0 + level * 0.06);
    float ry = 0.175 * (1.0 + level * 0.06);

    // Taxicab (L1) distance normalized by axis extents — an isoline of this
    // forms a diamond/rhombus.
    float wob = 0.02 * fbmVnoise(vec2(atan(pr.y, pr.x) * 2.0 + t * 0.4, t * 0.2));
    float dNorm = abs(pr.x) / rx + abs(pr.y) / ry - 1.0 - wob;

    float thickness = 0.055 + bass * 0.05;
    float ring = smoothstep(thickness, thickness - 0.035, abs(dNorm));

    // Spike glow at the four rhombus points.
    float pointGlow =
      (smoothstep(0.92, 1.0, abs(pr.x) / rx) + smoothstep(0.92, 1.0, abs(pr.y) / ry)) *
      (0.5 + bass * 1.2) *
      ring;

    float ang = atan(pr.y, pr.x);
    float glint = pow(0.5 + 0.5 * sin(ang * 1.0 - t * 0.65), 28.0) * ring;

    vec3 base = vec3(0.000, 0.760, 0.260);
    vec3 lite = vec3(0.210, 1.000, 0.000);
    vec3 crest = vec3(0.690, 1.000, 0.000);

    vec3 col = base;
    col = mix(col, lite, clamp(pointGlow, 0.0, 1.0));
    col += crest * glint;

    float alpha = clamp(ring * (0.85 + level * 0.15) + pointGlow * 0.4 + glint * 0.5, 0.0, 1.0);
    gl_FragColor = vec4(col * alpha, alpha);
  }
`,
);

const razerCamBorderRhombic = defineEffect({
  descriptor: {
    id: "razer-cam-border-rhombic",
    name: "Razer Cam Border Rhombic",
    description: "A diamond-shaped toxic-green camera frame that pulses with the audio.",
    engine: "three",
    category: "overlay",
    tags: ["razer", "overlay", "border", "camera", "reactive", "green"],
    previewNotes:
      "The angular sibling of the rectangular border. Transparent outside the frame, so lay it over a camera source.",
    params: [SPEED_PARAM],
  },
  setup: shaderQuadSetup({ fragment: FRAGMENT_SHADER, reactive: true }),
});

export default razerCamBorderRhombic;
