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
 * Razer Toxic Marble
 * ==================
 *
 * Wide, flat bands of acid green separated by thin black outlines, drifting slowly like a
 * topographic map of something you should not touch. A full-screen background for a coding or
 * gaming scene: it moves constantly but has no focal point, so it never competes with what is in
 * front of it.
 *
 * Ported from `razer-toxic-marble.html` in the old `obs-effects` repository. The fragment shader's
 * arithmetic is carried over unchanged — same noise, same warp depths, same band sharpening — so it
 * looks like the original. What is new is that every constant the original hard-coded is now a
 * parameter, which is the entire reason this platform exists.
 *
 * How the picture is built, from the inside out
 * ---------------------------------------------
 * 1. **Fractal noise.** `fbmRot` stacks six octaves of value noise, rotating the coordinate system
 *    between each one so no axis-aligned grid shows through. That gives a soft cloudy field.
 * 2. **Domain warping, twice.** Rather than colouring that field directly, its own output is used to
 *    *displace* where the next lookup happens (`p + 4.0 * q`, then `p + 3.5 * w`). Warping a
 *    coordinate by noise is what turns round blobs into the long stretched swirls that read as
 *    marble or as contour lines. Doing it twice is what makes them curl back on themselves.
 * 3. **Banding.** `sin(f * bandCount * 2π)` slices the smooth field into rings, and raising the
 *    result to a small power flattens each ring into a solid fill with a narrow transition — the
 *    difference between a soft gradient and a graphic, printed look.
 * 4. **The gradient map.** Band *brightness* comes from the noise; band *colour* comes from a
 *    separate slow gradient running down the screen. Keeping those two apart is why the whole image
 *    shifts hue together instead of each swirl carrying its own colour.
 * 5. **Black outlines.** Where the sine crosses zero the band is drawn black, which produces the
 *    hairline separators, and the background — the two are the same thing.
 *
 * Everything happens on the graphics card, once per pixel. The CPU writes a handful of uniforms per
 * frame and nothing else.
 */

const FRAGMENT_SHADER = assembleFragment(
  ["hash12", "vnoise", "fbmRot"],
  /* glsl */ `
  varying vec2 vUv;

  uniform float uTime;
  uniform vec2 uResolution;
  uniform float uScale;
  uniform float uBandCount;
  uniform float uSharpness;
  uniform float uOutline;
  uniform float uGlow;
  uniform float uGrain;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform vec3 uColorC;
  uniform vec3 uColorD;

  // Maps 0..1 onto the four configured colours in order. Three straight mixes rather than a
  // smooth curve, because the original's hard-edged look depends on the palette changing at a
  // constant rate rather than easing between stops.
  vec3 gradient(float t) {
    if (t < 0.33) return mix(uColorA, uColorB, t / 0.33);
    if (t < 0.66) return mix(uColorB, uColorC, (t - 0.33) / 0.33);
    return mix(uColorC, uColorD, (t - 0.66) / 0.34);
  }

  void main() {
    vec2 uvN = vUv;
    // Correct for the aspect ratio so the swirls stay round on a wide canvas instead of being
    // stretched horizontally.
    vec2 uv = (uvN - 0.5) * vec2(uResolution.x / uResolution.y, 1.0);

    float t = uTime * 0.10;
    vec2 p = uv * uScale + vec2(t * 0.05, t * 0.03);

    // First warp: two independent noise lookups become an offset vector.
    vec2 q = vec2(fbmRot(p), fbmRot(p + vec2(5.1, 1.4)));

    // Second warp, displaced by the first. The differing time offsets on each component are what
    // keep the pattern churning rather than sliding rigidly in one direction.
    vec2 w = vec2(
      fbmRot(p + 4.0 * q + vec2(2.1 + t * 0.09, 8.7 - t * 0.07)),
      fbmRot(p + 4.0 * q + vec2(6.8 + t * 0.04, 3.2 + t * 0.06))
    );

    float f = fbmRot(p + 3.5 * w + vec2(t * 0.04, -t * 0.03));

    // Slice the smooth field into bands, then flatten each one. A low exponent pushes values
    // towards ±1, so a band is a flat fill with a thin edge rather than a gradient.
    float raw = sin(f * uBandCount * 3.14159265 * 2.0);
    float sharp = sign(raw) * pow(abs(raw), uSharpness);
    float bandN = sharp * 0.5 + 0.5;

    // Colour comes from a slow gradient across the screen, not from the noise, so the whole image
    // shifts together. The sine on x stops it being a flat top-to-bottom wash.
    float gradPos = clamp(uvN.y + sin(uvN.x * 1.4 + t * 0.15) * 0.12 + t * 0.018, 0.0, 1.0);
    vec3 bandColor = gradient(gradPos);

    // Near a zero crossing the band is unlit, which is simultaneously the outline between bands and
    // the black background. They are the same mechanism, which is why there is only one control.
    float lit = smoothstep(uOutline, uOutline + 0.20, abs(raw));
    vec3 col = mix(vec3(0.0), bandColor, lit);

    // A second, thinner black line just inside the edge — the doubled-contour detail.
    float hairline = smoothstep(0.06, 0.0, abs(raw) - 0.01) * lit;
    col = mix(col, vec3(0.0), hairline * 0.8);

    // Faint bloom on the brightest bands, which is what makes the green read as emissive.
    col += bandColor * uGlow * lit * smoothstep(0.5, 1.0, bandN);

    // Grain breaks up the flat fills. Without it, large areas of one colour show banding artefacts
    // on an 8-bit display, which a video encoder then makes worse.
    float grain = hash12(uvN * uResolution + fract(uTime) * 83.0) - 0.5;
    col += grain * uGrain;

    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`,
);

const razerToxicMarble = defineEffect({
  descriptor: {
    id: "razer-toxic-marble",
    name: "Razer Toxic Marble",
    description:
      "Wide bands of acid green separated by thin black outlines, drifting like a topographic map. A full-screen background with no focal point, so it never competes with what is in front of it.",
    engine: "three",
    category: "background",
    tags: ["razer", "toxic", "marble", "shader", "background", "green"],
    previewNotes:
      "Fills the frame edge to edge and is opaque — put it behind everything, not over a camera. Pairs well with Toxic Dev Terminal and the razer-* family, which share this palette. Lower Band Count for a calmer, larger-scale look.",
    params: [
      {
        key: "speed",
        label: "Speed",
        kind: "number",
        default: 1,
        min: 0,
        max: 4,
        step: 0.05,
        description: "How fast the swirls churn. 0 freezes the pattern on whatever frame it is on.",
      },
      {
        key: "scale",
        label: "Scale",
        kind: "number",
        default: 2.6,
        min: 0.5,
        max: 8,
        step: 0.1,
        description:
          "How much of the pattern fits on screen. Lower means bigger, calmer shapes; higher means a denser, busier field.",
      },
      {
        key: "bandCount",
        label: "Band Count",
        kind: "number",
        default: 4.5,
        min: 1,
        max: 16,
        step: 0.5,
        description:
          "How many contour bands the field is sliced into. Low values give wide colour areas, high values a fine topographic map.",
      },
      {
        key: "sharpness",
        label: "Band Sharpness",
        kind: "number",
        default: 0.38,
        min: 0.05,
        max: 1,
        step: 0.01,
        description:
          "How flat each band is. Low is a hard printed look; 1 is a smooth gradient with no banding at all.",
      },
      {
        key: "outline",
        label: "Outline Width",
        kind: "number",
        default: 0.18,
        min: 0,
        max: 0.45,
        step: 0.01,
        description:
          "Thickness of the black separators between bands. This also sets how much black background shows through.",
      },
      {
        key: "glow",
        label: "Glow",
        kind: "number",
        default: 0.06,
        min: 0,
        max: 0.5,
        step: 0.01,
        description:
          "Bloom added to the brightest bands. A little is what makes the green look emissive.",
      },
      {
        key: "grain",
        label: "Grain",
        kind: "number",
        default: 0.008,
        min: 0,
        max: 0.06,
        step: 0.001,
        description:
          "Film grain over the flat fills. Small amounts hide the colour banding that video encoders exaggerate.",
      },
      {
        key: "colorA",
        label: "Colour 1 (deep)",
        kind: "color",
        default: "#44d62c",
        description: "First gradient stop — the Razer green the family is named after.",
      },
      {
        key: "colorB",
        label: "Colour 2",
        kind: "color",
        default: "#39ff14",
        description: "Second stop: toxic green.",
      },
      {
        key: "colorC",
        label: "Colour 3",
        kind: "color",
        default: "#adff2f",
        description: "Third stop: acid salad.",
      },
      {
        key: "colorD",
        label: "Colour 4 (light)",
        kind: "color",
        default: "#deff00",
        description: "Final stop: yellow-green. Set all four the same for a single-colour version.",
      },
    ],
  },

  setup({ ctx, scope }) {
    let speed = num(ctx.params, "speed", 1, 0, 4);

    // Antialiasing off: a full-screen quad has no polygon edges to smooth, so multisampling costs
    // fill rate and changes nothing.
    const stage = createThreeStage(scope, ctx, {
      antialias: false,
      camera: { kind: "fullscreen-quad" },
    });

    const colorVec = (p: Record<string, unknown>, key: string, fallback: string): THREE.Vector3 => {
      const [r, g, b] = rgb01(colorHex(p, key, fallback));
      return new THREE.Vector3(r, g, b);
    };

    const uniforms = {
      uTime: { value: 0 },
      uResolution: { value: new THREE.Vector2(stage.width, stage.height) },
      uScale: { value: num(ctx.params, "scale", 2.6, 0.5, 8) },
      uBandCount: { value: num(ctx.params, "bandCount", 4.5, 1, 16) },
      uSharpness: { value: num(ctx.params, "sharpness", 0.38, 0.05, 1) },
      uOutline: { value: num(ctx.params, "outline", 0.18, 0, 0.45) },
      uGlow: { value: num(ctx.params, "glow", 0.06, 0, 0.5) },
      uGrain: { value: num(ctx.params, "grain", 0.008, 0, 0.06) },
      uColorA: { value: colorVec(ctx.params, "colorA", "#44d62c") },
      uColorB: { value: colorVec(ctx.params, "colorB", "#39ff14") },
      uColorC: { value: colorVec(ctx.params, "colorC", "#adff2f") },
      uColorD: { value: colorVec(ctx.params, "colorD", "#deff00") },
    };

    const geometry = scope.ownDisposable(new THREE.PlaneGeometry(2, 2));
    const material = scope.ownDisposable(
      new THREE.ShaderMaterial({
        vertexShader: FULLSCREEN_VERTEX,
        fragmentShader: FRAGMENT_SHADER,
        uniforms,
        // Opaque on purpose: this is a background, and the shader writes a solid black where the
        // bands are not lit. Making it transparent would let the scene behind show through the
        // outlines, which is not what the original did.
        transparent: false,
        depthTest: false,
        depthWrite: false,
      }),
    );

    const quad = new THREE.Mesh(geometry, material);
    quad.frustumCulled = false;
    stage.scene.add(quad);

    stage.onResize((w, h) => uniforms.uResolution.value.set(w, h));

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      // An accumulated clock rather than the wall clock, so changing Speed alters the rate from
      // here on instead of making the pattern jump to a different point in its cycle.
      uniforms.uTime.value += dt * speed;
      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        speed = num(p, "speed", 1, 0, 4);
        uniforms.uScale.value = num(p, "scale", 2.6, 0.5, 8);
        uniforms.uBandCount.value = num(p, "bandCount", 4.5, 1, 16);
        uniforms.uSharpness.value = num(p, "sharpness", 0.38, 0.05, 1);
        uniforms.uOutline.value = num(p, "outline", 0.18, 0, 0.45);
        uniforms.uGlow.value = num(p, "glow", 0.06, 0, 0.5);
        uniforms.uGrain.value = num(p, "grain", 0.008, 0, 0.06);
        uniforms.uColorA.value.copy(colorVec(p, "colorA", "#44d62c"));
        uniforms.uColorB.value.copy(colorVec(p, "colorB", "#39ff14"));
        uniforms.uColorC.value.copy(colorVec(p, "colorC", "#adff2f"));
        uniforms.uColorD.value.copy(colorVec(p, "colorD", "#deff00"));
      },
    };
  },
});

export default razerToxicMarble;
