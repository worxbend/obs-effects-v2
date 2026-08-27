import * as THREE from "three";

import { num } from "../paramUtils";
import {
  assembleFragment,
  createEnvelopes,
  createThreeStage,
  defineEffect,
  FULLSCREEN_VERTEX,
  onFrame,
  useAudio,
} from "../sdk";

/**
 * Ink Dissolve Razer
 * ==================
 *
 * Ink blooming into water: dark tendrils spreading, curling and dissolving through a toxic-green
 * field, with hot edges where the front is still advancing. Slow, organic and never repeating.
 *
 * Ported from `ink-dissolve-razer.html` in the old `obs-effects` repository — one of the few pages
 * there that was a hand-written WebGL program rather than a Pixi or Three screen. The shader's
 * arithmetic is carried over unchanged.
 *
 * The old repository also had `ink-dissolve-black-razer.html`, which was the same shader with a
 * black page background and the audio code removed. Set Reactivity to 0 and Base Colour to black
 * and this is that effect, so there is one entry rather than two.
 *
 * Two things were deliberately dropped
 * ------------------------------------
 * **The pointer.** The original grew an extra bloom wherever the mouse was. In an OBS browser source
 * there is no cursor over the page and never will be, so that uniform and its smoothing are gone
 * rather than left permanently switched off.
 *
 * **The `prefers-reduced-motion` freeze.** The original stopped its clock entirely when the viewing
 * machine asked for reduced motion. That is right for a web page and wrong here: the setting belongs
 * to whichever machine happens to be running OBS, and it would silently freeze an overlay on a live
 * broadcast for reasons the operator cannot see. Speed is a parameter instead — set it to 0 to get
 * the same result deliberately.
 *
 * What the audio does
 * -------------------
 * Loudness drives how fast the ink spreads and how fine its tendrils are, and a beat briefly spikes
 * the spread — so the ink surges on a hit and then keeps blooming. It is not a level meter; it is a
 * process whose *rate* the sound controls, which is why it still looks alive in silence.
 */
const FRAGMENT_SHADER = assembleFragment(
  [],
  /* glsl */ `
  varying vec2 vUv;

  uniform float uTime;
  uniform vec2 uResolution;
  uniform float uSpread;
  uniform float uDetail;

  vec3 mod289(vec3 x) { return x - floor(x * (1.0/289.0)) * 289.0; }
  vec2 mod289v2(vec2 x) { return x - floor(x * (1.0/289.0)) * 289.0; }
  vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }

  float snoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                       -0.577350269189626, 0.024390243902439);
    vec2 i = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod289v2(i);
    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
    m = m*m; m = m*m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
    vec3 g;
    g.x = a0.x * x0.x + h.x * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
  }

  float fbm4(vec2 p, float dm) {
    float v = 0.0; float a = 0.55;
    mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
    v += a * snoise(p); a *= 0.45; p = rot * p * 2.02;
    v += a * snoise(p); a *= 0.45; p = rot * p * 2.03;
    v += a * snoise(p) * dm; a *= 0.4; p = rot * p * 2.01;
    v += a * snoise(p) * dm * 0.6;
    return v;
  }

  float fbm3(vec2 p) {
    float v = 0.0;
    mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
    v += 0.5 * snoise(p); p = rot * p * 2.02;
    v += 0.25 * snoise(p); p = rot * p * 2.03;
    v += 0.125 * snoise(p);
    return v;
  }

  float inkField(vec2 p, float t, float dm) {
    vec2 q = vec2(
      fbm4(p + vec2(0.0, 0.0) + t * 0.04, dm),
      fbm4(p + vec2(5.2, 1.3) + t * 0.03, dm)
    );
    vec2 r = vec2(
      fbm4(p + 2.5 * q + vec2(1.7, 9.2) + t * 0.022, dm),
      fbm4(p + 2.5 * q + vec2(8.3, 2.8) + t * 0.032, dm)
    );
    return fbm4(p + 2.2 * r + t * 0.015, dm);
  }

  void main() {
    // The original read gl_FragCoord; vUv is the same information already normalised, and it stays
    // correct if the drawing buffer is ever scaled relative to the canvas.
    vec2 uv = (vUv * uResolution - uResolution * 0.5) / min(uResolution.x, uResolution.y);
    float t = uTime * uSpread;
    float dm = uDetail;

    float field = inkField(uv * 0.8, t, dm);

    float envelope = 0.0;
    float a1 = t * 0.05;
    envelope += smoothstep(0.95, 0.0, length(uv - vec2(cos(a1)*0.15, sin(a1*0.7)*0.12)));
    float a2 = t * 0.04 + 2.2;
    envelope += smoothstep(0.85, 0.0, length(uv - vec2(cos(a2)*0.25, sin(a2*0.6)*0.2)));
    float a3 = t * 0.048 + 4.7;
    envelope += smoothstep(0.75, 0.0, length(uv - vec2(cos(a3*0.8)*0.2, sin(a3)*0.16)));
    envelope += smoothstep(0.65, 0.0, length(uv)) * 0.6;

    envelope = clamp(envelope, 0.0, 1.0);

    float inkRaw = smoothstep(-0.2, 0.1, field);
    float ink = inkRaw * envelope;

    float fineField = fbm3(uv * 2.5 + vec2(t * 0.02, -t * 0.015));
    float fineTendril = smoothstep(-0.1, 0.12, fineField) * envelope;
    float combinedInk = max(ink, fineTendril * 0.35);

    float edgeRaw = combinedInk * (1.0 - combinedInk) * 4.0;
    float edgeSoft = smoothstep(0.05, 0.5, edgeRaw);
    float edgeMid = smoothstep(0.25, 0.8, edgeRaw);
    float edgeHot = smoothstep(0.6, 1.0, edgeRaw);

    float fineEdge = fineTendril * (1.0 - fineTendril) * 4.0;
    fineEdge = smoothstep(0.3, 0.9, fineEdge) * 0.4;

    // ── Color palette (Razer green & gun metal) ──
    vec3 inkDark    = vec3(0.015, 0.020, 0.015);
    vec3 amberDim   = vec3(0.040, 0.055, 0.040);
    vec3 amberDeep  = vec3(0.080, 0.100, 0.080);
    vec3 amberWarm  = vec3(0.120, 0.400, 0.070);
    vec3 amberGold  = vec3(0.267, 0.839, 0.173);
    vec3 amberBright= vec3(0.550, 0.970, 0.450);
    vec3 amberHot   = vec3(0.800, 1.000, 0.720);

    float liqVar = 0.5 + 0.5 * fbm3(uv * 2.0 + t * 0.03);
    vec3 liquid = mix(amberDim, amberDeep, liqVar * 0.7);

    float c1 = 0.5 + 0.5 * snoise(uv * 6.0 + vec2(t * 0.05, -t * 0.035));
    float c2 = 0.5 + 0.5 * snoise(uv * 10.0 + vec2(-t * 0.03, t * 0.04));
    liquid += amberWarm * c1 * c2 * 0.05 * (1.0 - combinedInk);

    vec3 col = mix(liquid, inkDark, combinedInk);

    col += amberDeep  * edgeSoft * 0.7;
    col += amberGold  * edgeMid  * 0.4;
    col += amberBright* edgeHot  * 0.45;
    col += amberHot   * edgeHot  * edgeHot * 0.25;

    col += amberWarm * fineEdge * 0.3;
    col += amberGold * fineEdge * fineEdge * 0.15;

    float inkTex = 0.5 + 0.5 * snoise(uv * 3.5 + t * 0.01);
    col += vec3(0.010, 0.018, 0.010) * inkTex * combinedInk;

    float thinInk = smoothstep(0.5, 0.1, combinedInk);
    col += amberDim * thinInk * edgeSoft * 0.3;

    float vertGlow = smoothstep(0.6, -0.3, uv.y);
    col += vec3(0.010, 0.025, 0.008) * vertGlow * (1.0 - combinedInk * 0.6);

    float vig = 1.0 - smoothstep(0.35, 1.2, length(uv));
    col *= 0.5 + 0.5 * vig;

    col = pow(max(col, 0.0), vec3(1.00, 0.92, 1.04));

    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`,
);

const inkDissolveRazer = defineEffect({
  descriptor: {
    id: "ink-dissolve-razer",
    name: "Ink Dissolve Razer",
    description:
      "Ink blooming into water \u2014 dark tendrils spreading and dissolving through a toxic-green field, with hot edges where the front is advancing.",
    engine: "three",
    category: "background",
    tags: ["razer", "background", "ink", "organic", "reactive", "green"],
    previewNotes:
      "An opaque full-frame background. Reacts to OBS audio by changing how fast the ink spreads rather than by pulsing, so it still looks alive in silence. Set Reactivity to 0 for the non-reactive black variant from the old repository.",
    params: [
      {
        key: "speed",
        label: "Speed",
        kind: "number",
        default: 0.4,
        min: 0,
        max: 3,
        step: 0.02,
        description:
          "How fast the ink spreads. The original's value is 0.4; 0 freezes the bloom exactly where it is.",
      },
      {
        key: "detail",
        label: "Tendril Detail",
        kind: "number",
        default: 1,
        min: 0.2,
        max: 3,
        step: 0.05,
        description:
          "How fine the tendrils are. Low values give broad smoky masses; high values give thin, feathery threads.",
      },
      {
        key: "reactivity",
        label: "Reactivity",
        kind: "number",
        default: 1,
        min: 0,
        max: 3,
        step: 0.05,
        description:
          "How much the audio accelerates the spread and sharpens the detail. 0 ignores audio entirely.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    const bus = await useAudio(scope);
    scope.checkpoint();
    const envelopes = createEnvelopes(bus);

    const stage = createThreeStage(scope, ctx, {
      antialias: false,
      camera: { kind: "fullscreen-quad" },
    });

    let speed = num(ctx.params, "speed", 0.4, 0, 3);
    let detail = num(ctx.params, "detail", 1, 0.2, 3);
    let reactivity = num(ctx.params, "reactivity", 1, 0, 3);

    const uniforms = {
      uTime: { value: 0 },
      uResolution: { value: new THREE.Vector2(stage.width, stage.height) },
      uSpread: { value: speed },
      uDetail: { value: detail },
    };

    const geometry = scope.ownDisposable(new THREE.PlaneGeometry(2, 2));
    const material = scope.ownDisposable(
      new THREE.ShaderMaterial({
        vertexShader: FULLSCREEN_VERTEX,
        fragmentShader: FRAGMENT_SHADER,
        uniforms,
        transparent: false,
        depthTest: false,
        depthWrite: false,
      }),
    );

    const quad = new THREE.Mesh(geometry, material);
    quad.frustumCulled = false;
    stage.scene.add(quad);

    stage.onResize((w, h) => uniforms.uResolution.value.set(w, h));

    let beatFlash = 0;

    onFrame(scope, ctx.fpsCap, ({ dt, now }) => {
      bus.sample(now);
      envelopes.update(dt);

      if (envelopes.beat && reactivity > 0) beatFlash = 1;
      // Decayed per second rather than per frame. The original multiplied by 0.85 every frame,
      // which made the flash fade twice as fast on a 120 Hz display as on a 60 Hz one.
      beatFlash *= Math.pow(0.85, dt * 60);

      const spread =
        speed * (1 + (bus.level * 1.8 + envelopes.slow * 0.8) * reactivity) +
        beatFlash * speed * 2 * reactivity;

      uniforms.uSpread.value = spread;
      uniforms.uDetail.value = detail * (1 + envelopes.fast * 0.6 * reactivity);

      /*
       * The shader multiplies uTime by uSpread internally, so the clock here is plain seconds and
       * the *rate* is carried by the uniform. That is why speeding the ink up does not make it jump:
       * the ink's position in its own life is `time * spread`, and only the multiplier moves.
       */
      uniforms.uTime.value += dt;

      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        speed = num(p, "speed", 0.4, 0, 3);
        detail = num(p, "detail", 1, 0.2, 3);
        reactivity = num(p, "reactivity", 1, 0, 3);
      },
    };
  },
});

export default inkDissolveRazer;
