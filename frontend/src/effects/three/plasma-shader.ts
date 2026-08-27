import * as THREE from "three";

import { colorHex, num, rgb01 } from "../paramUtils";
import {
  assembleFragment,
  createThreeStage,
  defineEffect,
  FULLSCREEN_VERTEX,
  onFrame,
} from "../sdk";

/**
 * Plasma Shader
 * =============
 *
 * A full-screen animated "plasma" — soft coloured clouds that boil and drift. Everything is computed
 * on the graphics card by a *fragment shader*: a tiny program written in GLSL that runs once for
 * every pixel and returns that pixel's colour. The CPU does almost nothing here, which is why this
 * effect stays cheap even at 4K.
 *
 * The geometry trick
 * ------------------
 * To make a shader cover the whole screen you need *something* to draw. We draw a single flat square
 * (a "quad") whose vertices are written straight out in clip space by the vertex shader. The camera
 * is therefore only the formality `renderer.render` requires — which is exactly what the SDK's
 * `{ kind: "fullscreen-quad" }` camera is, so the four lines that used to build an orthographic unit
 * camera by hand here now live in `sdk/three.ts` and are shared with every future shader effect.
 *
 * The maths inside the shader
 * ---------------------------
 * This effect used to carry its own copies of `hash`, `noise` and `fbm`. They are now the shared
 * `hash`, `noise2` and `fbm` chunks in `sdk/glsl/`, pulled in by {@link assembleFragment}, which
 * pastes each named chunk (and anything it depends on) above the body exactly once. The source text
 * of those three functions is character-for-character what this file used to hold — same constants,
 * same five octaves, same 2.02 lacunarity — so the picture is unchanged; only the copy is gone.
 *
 * - `hash` turns a 2D coordinate into a repeatable pseudo-random number. Shaders have no random
 *   number generator, so we fake one with a big multiplication and `fract` (keep the fractional
 *   part), which scrambles the bits.
 * - `noise2` smoothly blends the random values at the four corners of a grid cell, so the result has
 *   no visible grid lines.
 * - `fbm` — fractal Brownian motion — adds five layers ("octaves") of that noise together, each one
 *   twice as fine and half as strong as the last. That self-similar stacking is what makes the
 *   result look like clouds or smoke instead of blobs.
 * - Finally the noise value picks a colour between the two configured colours, and `contrast`
 *   pushes it towards the extremes.
 *
 * The domain warping below is deliberately *not* the shared `domainWarp` chunk. That chunk warps and
 * samples at one moment in time; this effect drifts its three noise lookups at three different
 * speeds (0.15, -0.12 and 0.05), which is what stops the pattern from sliding rigidly in one
 * direction. Adopting the shared function would change how the effect looks, and this is a refactor.
 */

const FRAGMENT_SHADER = assembleFragment(
  ["hash", "noise2", "fbm"],
  /* glsl */ `
  varying vec2 vUv;

  uniform float uTime;
  uniform float uScale;
  uniform float uContrast;
  uniform vec3  uColorLow;
  uniform vec3  uColorHigh;
  uniform vec2  uResolution;

  void main() {
    // Correct for the aspect ratio so the pattern is not stretched on a wide source.
    vec2 uv = vUv;
    uv.x *= uResolution.x / max(uResolution.y, 1.0);

    vec2 p = uv * uScale;

    // Domain warping: feed noise into the coordinates of more noise. This is the standard trick for
    // turning bland clouds into swirling, liquid-looking plasma.
    vec2 warp = vec2(fbm(p + uTime * 0.15), fbm(p + vec2(5.2, 1.3) - uTime * 0.12));
    float value = fbm(p + warp * 2.0 + uTime * 0.05);

    // Push the 0..1 value away from the middle to raise contrast, then clamp back into range.
    value = clamp((value - 0.5) * uContrast + 0.5, 0.0, 1.0);

    vec3 color = mix(uColorLow, uColorHigh, value);

    // Alpha follows the value too, so the darkest areas stay see-through in OBS.
    gl_FragColor = vec4(color, value);
  }
`,
);

export default defineEffect({
  descriptor: {
    id: "plasma-shader",
    name: "Plasma Shader",
    description:
      "A full-screen fractal-noise plasma field computed entirely in a GLSL fragment shader, with domain warping for a liquid, swirling look.",
    engine: "three",
    category: "background",
    tags: ["shader", "noise", "background", "three", "glsl"],
    previewNotes:
      "Darker areas are transparent, so this layers nicely under a webcam. Lower Scale for big slow blobs, raise it for fine smoke.",
    params: [
      {
        key: "scale",
        label: "Scale",
        kind: "number",
        default: 3,
        min: 0.5,
        max: 20,
        step: 0.1,
        description:
          "How many noise cells fit across the screen. Higher means smaller, busier detail.",
      },
      {
        key: "speed",
        label: "Speed",
        kind: "number",
        default: 1,
        min: 0,
        max: 5,
        step: 0.05,
        description: "Multiplier on how fast the plasma boils. 0 freezes it into a still image.",
      },
      {
        key: "colorLow",
        label: "Low Color",
        kind: "color",
        default: "#0b1e5e",
        description: "Colour used where the noise value is at its lowest.",
      },
      {
        key: "colorHigh",
        label: "High Color",
        kind: "color",
        default: "#ff3ca6",
        description: "Colour used where the noise value peaks.",
      },
      {
        key: "contrast",
        label: "Contrast",
        kind: "number",
        default: 1.6,
        min: 0.2,
        max: 5,
        step: 0.1,
        description:
          "Pushes values away from the mid-tone. 1 is the raw noise; higher gives harder, more separated bands.",
      },
    ],
  },

  setup({ ctx, scope }) {
    let speed = num(ctx.params, "speed", 1, 0, 5);

    // Antialiasing is off: a full-screen quad has no polygon edges to smooth, so multisampling buys
    // nothing here and costs fill rate. This matches what the effect asked for before the refactor.
    const stage = createThreeStage(scope, ctx, {
      antialias: false,
      camera: { kind: "fullscreen-quad" },
    });

    const [lowR, lowG, lowB] = rgb01(colorHex(ctx.params, "colorLow", "#0b1e5e"));
    const [highR, highG, highB] = rgb01(colorHex(ctx.params, "colorHigh", "#ff3ca6"));

    // Uniforms are the values the CPU passes into the shader. Updating one is a single number write
    // — that is what makes every parameter here hot-swappable with no rebuild at all.
    const uniforms = {
      uTime: { value: 0 },
      uScale: { value: num(ctx.params, "scale", 3, 0.5, 20) },
      uContrast: { value: num(ctx.params, "contrast", 1.6, 0.2, 5) },
      uColorLow: { value: new THREE.Vector3(lowR, lowG, lowB) },
      uColorHigh: { value: new THREE.Vector3(highR, highG, highB) },
      uResolution: { value: new THREE.Vector2(stage.width, stage.height) },
    };

    /*
     * The geometry and the material are handed to the scope the moment they are constructed, and
     * the scope tears everything down in reverse order of construction — material, then geometry,
     * then the renderer, which `createThreeStage` registered before either of them. That is
     * byte-for-byte the teardown order this file used to spell out by hand in its `dispose`, with
     * the difference that it can no longer drift out of step with the construction order above it.
     */
    const geometry = scope.ownDisposable(new THREE.PlaneGeometry(2, 2));
    const material = scope.ownDisposable(
      new THREE.ShaderMaterial({
        vertexShader: FULLSCREEN_VERTEX,
        fragmentShader: FRAGMENT_SHADER,
        uniforms,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    );

    const quad = new THREE.Mesh(geometry, material);
    // The quad is always in front of the camera; skipping the culling test avoids it vanishing.
    quad.frustumCulled = false;
    stage.scene.add(quad);

    // The one thing this effect needs to know about its own size. Everything else a resize touches
    // — the renderer's drawing buffer, the camera — the stage handles, which is why there is no
    // `resize` method on the returned handle any more.
    stage.onResize((w, h) => uniforms.uResolution.value.set(w, h));

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      // We accumulate our own clock rather than reading the wall clock directly, so changing Speed
      // does not make the pattern jump: only the rate of advance changes from here on. `dt` is in
      // seconds, exactly as the hand-written loop this replaces measured it, so the pattern boils at
      // the same rate as before — the difference is that the shared clock now honours the route's
      // frame-rate cap, which this effect previously ignored.
      uniforms.uTime.value += dt * speed;
      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        speed = num(p, "speed", 1, 0, 5);
        uniforms.uScale.value = num(p, "scale", 3, 0.5, 20);
        uniforms.uContrast.value = num(p, "contrast", 1.6, 0.2, 5);
        const [lr, lg, lb] = rgb01(colorHex(p, "colorLow", "#0b1e5e"));
        const [hr, hg, hb] = rgb01(colorHex(p, "colorHigh", "#ff3ca6"));
        uniforms.uColorLow.value.set(lr, lg, lb);
        uniforms.uColorHigh.value.set(hr, hg, hb);
      },
    };
  },
});
