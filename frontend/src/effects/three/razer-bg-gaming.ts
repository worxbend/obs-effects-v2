import { assembleFragment, defineEffect } from "../sdk";
import { SPEED_PARAM, shaderQuadSetup } from "./shaderQuad";

/**
 * Razer BG Gaming
 * ===============
 *
 * A retro perspective grid rushing toward the camera under a dark starfield, with a glowing horizon band and a bass-driven strobe wash.
 *
 * Ported from `razer-bg-gaming.html` in the old `obs-effects` repository, where it was a `ShaderQuadScreen`
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


  float gridLine(float coord, float freq, float width) {
    float g = abs(fract(coord * freq) - 0.5) * 2.0;
    return 1.0 - smoothstep(0.0, width, g);
  }

  void main() {
    vec2 uvN = vUv;
    float asp = uResolution.x / uResolution.y;
    vec2 p = (uvN - 0.5) * vec2(asp, 1.0);
    float t = uTime;

    float level = uAudio.x;
    float bass = uAudio.y;
    float high = uAudio.w;

    float horizon = -0.06;
    float depth = p.y - horizon;

    vec3 col = vec3(0.0);

    if (depth < 0.0) {
      // Floor: perspective-divided grid rushing toward camera.
      float persp = 1.0 / max(-depth, 0.02);
      float speed = 0.35 + level * 0.9;
      vec2 gp = vec2(p.x * persp, persp * 0.5 + t * speed * 3.0);

      float gx = gridLine(gp.x, 1.0, 0.06);
      float gy = gridLine(gp.y, 1.0, 0.06 + level * 0.03);
      float grid = max(gx, gy);

      float fade = smoothstep(0.0, 0.5, -depth) * smoothstep(6.0, 0.2, persp);
      vec3 floorBase = vec3(0.0, 0.05, 0.015);
      vec3 gridCol = mix(vec3(0.0, 0.76, 0.26), vec3(0.69, 1.0, 0.0), bass);

      col = mix(floorBase, gridCol, grid * fade);
      col += gridCol * grid * fade * high * 0.6;
    } else {
      // Sky: dark gradient with drifting scanlines and starfield motes.
      vec3 sky = mix(vec3(0.0, 0.02, 0.006), vec3(0.0, 0.008, 0.002), depth * 1.4);
      float scan = gridLine(p.y * 40.0 + t * 0.6, 1.0, 0.02) * 0.05;
      sky += vec3(0.0, 0.5, 0.15) * scan;

      vec2 sp = p * 6.0;
      float star = smoothstep(0.985, 1.0, hash12(floor(sp) + floor(t * 0.2)));
      sky += vec3(0.6, 1.0, 0.6) * star * 0.5;

      col = sky;
    }

    // Horizon glow band.
    float hz = exp(-pow((p.y - horizon) * 6.0, 2.0));
    col += mix(vec3(0.0, 0.9, 0.3), vec3(1.0, 0.0, 0.65), bass * 0.6) * hz * (0.35 + level * 0.5);

    // Bass strobe wash across the whole frame.
    float strobe = smoothstep(0.55, 1.0, bass) * (0.5 + 0.5 * sin(t * 40.0));
    col += vec3(0.55, 0.05, 0.85) * strobe * 0.22;

    // Vignette.
    vec2 vc = uvN - 0.5;
    col *= 1.0 - 0.55 * dot(vc, vc);

    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`,
);

const razerBgGaming = defineEffect({
  descriptor: {
    id: "razer-bg-gaming",
    name: "Razer BG Gaming",
    description:
      "A retro perspective grid rushing toward the camera under a dark starfield, with a glowing horizon band and a bass-driven strobe wash.",
    engine: "three",
    category: "background",
    tags: ["razer", "background", "grid", "retro", "gaming", "reactive"],
    previewNotes:
      "A full-frame background for a gaming scene. Opaque, so put it behind everything. Reacts to OBS audio — the horizon and the strobe follow it. Configure the OBS connection under Settings or it runs on a simulated signal.",
    params: [SPEED_PARAM],
  },
  setup: shaderQuadSetup({ fragment: FRAGMENT_SHADER, reactive: true }),
});

export default razerBgGaming;
