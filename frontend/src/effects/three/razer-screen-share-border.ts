import { assembleFragment, defineEffect } from "../sdk";
import { SPEED_PARAM, shaderQuadSetup } from "./shaderQuad";

/**
 * Razer Screen Share Border
 * =========================
 *
 * A wide frame sized for a shared screen or capture window rather than a webcam, with a travelling highlight around its edge.
 *
 * Ported from `razer-screen-share-border.html` in the old `obs-effects` repository, where it was a `ShaderQuadScreen`
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

    float margin = 0.028 + level * 0.008;
    float radius = 0.026;
    float thickness = 0.0032 + level * 0.0022;

    vec2 halfExtent = vec2(asp, 1.0) * 0.5 - vec2(margin);
    float d = sdRoundBox(p, halfExtent, radius);

    float frame = smoothstep(thickness, thickness - 0.0022, abs(d));

    // Faint inner glow just inside the frame line, fading out with depth.
    float innerGlow = clamp(-d / 0.038, 0.0, 1.0) * step(0.0, -d) * 0.10;

    // Corner bracket brightening — proximity to the four rounded-box corners.
    vec2 cornerLocal = abs(p) - halfExtent + radius;
    float cornerProx = 1.0 - smoothstep(0.0, 0.06, length(max(cornerLocal, 0.0)));
    float cornerGlow = cornerProx * (0.55 + bass * 0.9);

    // Rotating scan glint sweeping around the perimeter.
    float ang = atan(p.y, p.x);
    float glint = pow(0.5 + 0.5 * sin(ang - t * 0.6), 36.0) * frame;

    vec3 base = vec3(0.000, 0.760, 0.260);
    vec3 acid = vec3(0.210, 1.000, 0.000);
    vec3 crest = vec3(0.690, 1.000, 0.000);

    vec3 col = base;
    col = mix(col, acid, cornerGlow);
    col += crest * glint * 1.4;
    col += acid * innerGlow;

    float alpha = clamp(frame * (0.85 + level * 0.15) + innerGlow + glint * 0.6, 0.0, 1.0);
    gl_FragColor = vec4(col * alpha, alpha);
  }
`,
);

const razerScreenShareBorder = defineEffect({
  descriptor: {
    id: "razer-screen-share-border",
    name: "Razer Screen Share Border",
    description:
      "A wide frame sized for a shared screen or capture window rather than a webcam, with a travelling highlight around its edge.",
    engine: "three",
    category: "overlay",
    tags: ["razer", "overlay", "border", "screen-share", "green"],
    previewNotes:
      "Sized for a full 16:9 capture rather than a small camera. Transparent inside, so put it over a display or window capture to mark it as the shared area.",
    params: [SPEED_PARAM],
  },
  setup: shaderQuadSetup({ fragment: FRAGMENT_SHADER, reactive: true }),
});

export default razerScreenShareBorder;
