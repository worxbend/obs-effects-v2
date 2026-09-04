import * as THREE from "three";

import type { ChatMessage } from "~/types/contract";
import { bool, colorHex, num, rgb01 } from "../paramUtils";
import {
  assembleFragment,
  createEnvelopes,
  createThreeStage,
  defineEffect,
  FULLSCREEN_VERTEX,
  onFrame,
  palette,
  paletteParam,
  paletteUniform,
  useAudio,
  useChat,
  useVideo,
  videoTextureThree,
} from "../sdk";

/**
 * Contour Chorus
 * ==============
 *
 * The camera picture is never shown. What is drawn is its *outline*: a single continuous line of
 * light that follows the streamer's silhouette, their jaw, their hairline, the edge of a headset —
 * on nothing but transparency, so in OBS it lays exactly over the real camera source underneath and
 * traces the person live, like a light pen following them around.
 *
 * Three live signals shape it at once, which is the point of the effect:
 *
 *  - **the camera** decides the shape,
 *  - **the voice** decides how heavy and how bright the line is, so the outline breathes while the
 *    streamer talks and thins to a whisper when they stop,
 *  - **chat** throws expanding rings across the frame, and where a ring crosses the outline the
 *    line flares toward white and is physically pushed aside, so the silhouette flinches as the
 *    wave goes through it.
 *
 * ## How the outline is found: the Sobel operator, explained from scratch
 *
 * An "edge" in a picture is a place where brightness changes quickly. To measure that, this shader
 * reads the video at the eight neighbours of the pixel it is drawing, converts each read to a
 * single brightness number, and combines them with the two little weighting patterns that Irwin
 * Sobel published in 1968 (the centre of both patterns is zero, which is why the pixel itself is
 * never read):
 *
 * ```text
 *   horizontal change (gx)      vertical change (gy)
 *      -1  0  +1                   -1  -2  -1
 *      -2  0  +2                    0   0   0
 *      -1  0  +1                   +1  +2  +1
 * ```
 *
 * `gx` comes out large where brightness changes left-to-right, `gy` where it changes top-to-bottom,
 * and the length of the vector `(gx, gy)` is how strong the edge is regardless of which way it
 * runs. Where that strength crosses a threshold, a line is drawn. Nothing about a face, a body or a
 * background is understood — it is pure local arithmetic, which is exactly why it costs nothing and
 * works on any camera.
 *
 * **The neighbour spacing *is* the line width.** The reads are taken `lineWidth` pixels apart,
 * so widening the spacing widens the band of pixels that see a strong change, and the stroke gets
 * heavier. That is why voice can thicken the line for free: the voice envelope is simply added to
 * the sampling radius before the reads happen, rather than a second pass being drawn on top.
 *
 * ## How a chat ring makes the outline flinch
 *
 * Each message puts a ring into an eight-slot buffer on the CPU: an origin on the frame edge picked
 * from `message.seed` — so a given viewer's rings always arrive from that viewer's own corner — a
 * radius that grows every frame, and a strength that fades out over its life. The shader walks all
 * eight slots and asks, for the pixel it is drawing, how close it is to each ring's current radius.
 *
 * Where a ring is passing, two things happen. The line brightens toward white. And, before the
 * Sobel reads are taken, the sampling point is nudged along the *gradient normal* — the direction
 * the brightness is changing in, which for an outline is the direction perpendicular to the line
 * itself. Moving where we look moves where the line appears to be, so the contour visibly bends
 * away from the passing wave and springs back after it. Finding that normal needs a cheap four-read
 * brightness measurement first, so a pixel under a ring costs twelve reads instead of eight.
 *
 * Subs, gifts, cheers and raids get a different ring: several times thicker, half the speed, and
 * tinted with the accent colour, so a raid reads as one slow swell travelling through the whole
 * body rather than as another ping.
 *
 * ## What happens with no camera
 *
 * `useVideo` never fails. With no camera permission — the normal state of an OBS browser source
 * until it is granted — the SDK hands over a drifting test pattern instead, and this effect traces
 * *that*: a soft circle and a moving gradient, which still reads as a deliberate ambient contour
 * even though it is plainly not a person. Worth knowing before it is put on air: this effect asks
 * the browser for the webcam, and on some machines that is the same physical device the OBS camera
 * source is already holding. Some drivers hand the camera to two openers, some do not.
 *
 * ## Why this is a hand-written setup rather than `shaderQuadSetup`
 *
 * The shared full-screen-quad helper only carries uniforms of type `number`, `Vector2`, `Vector3`
 * and `Vector4`. This shader needs a `sampler2D` for the video and two uniform *arrays* for the
 * rings, so it builds its own quad — which is the same fifteen lines the helper would have written.
 */

/** How many chat rings can be in flight at once. A ninth message overwrites the oldest slot. */
const RIPPLE_SLOTS = 8;

/** How many colours the palette is baked down to for the shader. Must match `uPalette[8]`. */
const PALETTE_STOPS = 8;

const TAU = Math.PI * 2;

const FRAGMENT_SHADER = assembleFragment(
  ["easing", "palette", "hash12"],
  /* glsl */ `
  varying vec2 vUv;

  uniform sampler2D uVideo;
  uniform vec2 uResolution;
  uniform float uTime;

  uniform float uThreshold;   // how strong an edge must be to become a line
  uniform float uSoftness;    // how far past the threshold the line fades in, as a fraction of it
  uniform float uLine;        // sampling radius in pixels — this is the stroke weight
  uniform float uBright;      // 0..1 overall opacity of the contour, lifted by the voice
  uniform float uTremor;      // sub-pixel jitter along the line during loud passages, in pixels

  uniform float uZoom;        // scale applied to the sampled camera image
  uniform vec2 uOffset;       // nudge of the sampled image, in fractions of the frame
  uniform float uMirror;      // 1 flips the sampled image horizontally, 0 leaves it alone

  uniform vec4 uRipples[8];      // x, y (aspect-corrected frame space), current radius, strength
  uniform vec2 uRippleStyle[8];  // band half-width, and 1 for an event ring / 0 for a chat ring
  uniform float uRippleDisplace; // how far a ring pushes the contour aside, in pixels
  uniform float uRippleFlare;    // how hard a ring drives the contour toward white

  uniform vec3 uPalette[8];
  uniform int uPaletteCount;
  uniform vec3 uAccent;

  // Where in the camera image a point on our canvas reads from. Zoom is applied about the centre so
  // that turning it up crops inward rather than sliding the picture off one corner.
  //
  // The offset is added *after* the mirror flip, and that order is the whole point. Flipping a
  // coordinate that already carries the offset flips the offset with it, so the Horizontal Offset
  // slider would push the contour left with Mirror off and right with Mirror on — one knob whose
  // meaning silently reverses because of another knob. Offsetting last keeps "positive moves the
  // contour left" true either way.
  vec2 sampleUv(vec2 p) {
    vec2 q = (p - 0.5) / max(uZoom, 0.05) + 0.5;
    q.x = mix(q.x, 1.0 - q.x, uMirror);
    return q + uOffset;
  }

  // One brightness number for a point, using the standard luminance weights: the eye is far more
  // sensitive to green than to blue, so a plain average of the channels would find edges in the
  // wrong places.
  float lum(vec2 p) {
    vec3 c = texture2D(uVideo, sampleUv(p)).rgb;
    return dot(c, vec3(0.299, 0.587, 0.114));
  }

  void main() {
    vec2 res = max(uResolution, vec2(1.0));
    float asp = res.x / res.y;
    // Frame space: (0,0) at the centre, y running -0.5..0.5 top to bottom, x widened by the aspect
    // ratio so a ring is a circle on screen rather than an ellipse.
    vec2 p = (vUv - 0.5) * vec2(asp, 1.0);

    // ---- chat rings ---------------------------------------------------------------------------
    // A constant-bounded loop is the only way GLSL ES 1.0 allows a uniform array to be indexed, so
    // all eight slots are always walked; a dormant slot simply carries strength 0 and adds nothing.
    float flare = 0.0;
    float accent = 0.0;
    for (int i = 0; i < 8; i++) {
      vec4 ring = uRipples[i];
      vec2 style = uRippleStyle[i];
      // pulse() is a soft bump: 1 exactly on the ring's radius, falling to 0 half-width away.
      float band = pulse(length(p - ring.xy), ring.z, max(style.x, 1.0e-4)) * ring.w;
      flare += band;
      accent = max(accent, band * style.y);
    }
    flare = clamp(flare, 0.0, 1.0);

    // ---- where to look ------------------------------------------------------------------------
    // A ring pushes the contour along its own normal, which means we need to know the normal before
    // the main reads happen. Four reads at the current stroke width give a good enough direction,
    // and they are skipped entirely when nothing is displacing this pixel.
    vec2 step1 = vec2(max(uLine, 0.5)) / res;
    vec2 shift = vec2(0.0);
    float wobble = flare * uRippleDisplace + uTremor;
    if (wobble > 0.001) {
      vec2 coarse = vec2(
        lum(vUv + vec2(step1.x, 0.0)) - lum(vUv - vec2(step1.x, 0.0)),
        lum(vUv + vec2(0.0, step1.y)) - lum(vUv - vec2(0.0, step1.y))
      );
      float mag = length(coarse);
      vec2 normal = mag > 1.0e-4 ? coarse / mag : vec2(0.0);
      // The tremor is signed noise that changes every frame, so during loud passages the line
      // shivers along its own thickness instead of drifting in one direction.
      float jitter = hash12(floor(vUv * res) + floor(uTime * 37.0)) * 2.0 - 1.0;
      shift = normal * (flare * uRippleDisplace + uTremor * jitter) / res;
    }

    vec2 c = vUv + shift;

    // ---- the Sobel operator -------------------------------------------------------------------
    // Eight reads, laid out as the ring of neighbours around c. The centre is not read because it
    // carries weight zero in both of the kernels below.
    float l00 = lum(c + vec2(-step1.x, -step1.y));
    float l10 = lum(c + vec2(0.0, -step1.y));
    float l20 = lum(c + vec2(step1.x, -step1.y));
    float l01 = lum(c + vec2(-step1.x, 0.0));
    float l21 = lum(c + vec2(step1.x, 0.0));
    float l02 = lum(c + vec2(-step1.x, step1.y));
    float l12 = lum(c + vec2(0.0, step1.y));
    float l22 = lum(c + vec2(step1.x, step1.y));

    float gx = (l20 + 2.0 * l21 + l22) - (l00 + 2.0 * l01 + l02);
    float gy = (l02 + 2.0 * l12 + l22) - (l00 + 2.0 * l10 + l20);
    vec2 grad = vec2(gx, gy);
    float mag = length(grad);

    // ---- turning the edge strength into a line ------------------------------------------------
    // fwidth() reports how much a value changes between neighbouring pixels, so using it as the
    // minimum fade width keeps the stroke exactly one pixel soft at any canvas resolution, however
    // low the softness parameter is set.
    // The final max() with a hair above zero is not decoration. At softness 0 on a perfectly flat
    // patch of image, fwidth() is exactly 0 too, and smoothstep() with two identical edges divides
    // by zero — the GLSL specification calls the result undefined, and in practice it can be a
    // not-a-number that then travels through the alpha and paints the whole pixel as garbage.
    float aa = fwidth(mag) * 0.70710678;
    float fade = max(max(uSoftness * uThreshold, aa), 1.0e-4);
    // The lower end of the fade is held at zero: a wide softness would otherwise put it below zero,
    // where even a perfectly flat patch of wall scores above it and the whole frame washes over.
    float edge = smoothstep(max(uThreshold - fade, 0.0), uThreshold + fade, mag);

    // With the image zoomed or nudged, part of the canvas reads past the edge of the camera frame.
    // The texture clamps there, which would otherwise draw a rectangle around the crop; this fades
    // the contour out over the last one per cent of the frame instead.
    vec2 q = sampleUv(vUv);
    vec2 inside = smoothstep(vec2(0.0), vec2(0.01), q) * smoothstep(vec2(0.0), vec2(0.01), 1.0 - q);
    edge *= inside.x * inside.y;

    // ---- colour -------------------------------------------------------------------------------
    // The palette is sampled by the direction the line runs in, so the colour travels around the
    // silhouette as it curves, and drifts slowly over time so a still pose is never a still image.
    // The 0..1 position is folded to 0..1..0 so the two ends of the ramp meet where the angle wraps
    // and there is no seam anywhere on the outline.
    // On a perfectly flat patch the gradient is exactly zero, and atan(0.0, 0.0) is undefined — it
    // can return a not-a-number that then poisons the colour even where the alpha is zero. Falling
    // back to a fixed direction there keeps every pixel finite.
    vec2 dir = mag > 1.0e-5 ? grad / mag : vec2(1.0, 0.0);
    float angle = fract(atan(dir.y, dir.x) / 6.28318530718 + 0.5 + uTime * 0.02);
    float ramp = 1.0 - abs(angle * 2.0 - 1.0);

    vec3 col = paletteRamp(uPalette, uPaletteCount, ramp);
    float eventMix = clamp(accent, 0.0, 1.0);
    col = mix(col, uAccent, eventMix);

    // What the flare drives the line toward. For an ordinary chat ring that is plain white. For an
    // event ring it is a brightened version of the event colour instead: at the default flare of
    // 0.9 a plain white target would wash the accent tint straight back out again, and a raid would
    // arrive looking exactly like every other message.
    float hot = clamp(flare * uRippleFlare, 0.0, 1.0);
    vec3 hotColour = mix(vec3(1.0), mix(uAccent, vec3(1.0), 0.35), eventMix);
    col = mix(col, hotColour, hot);

    // A passing ring lifts opacity as well as colour, so the flare still reads while the streamer
    // is silent and the contour is sitting at its idle weight.
    float a = clamp(edge * (uBright + (1.0 - uBright) * hot), 0.0, 1.0);

    // Premultiplied output, matching the material's premultipliedAlpha flag: the colour is already
    // scaled by its coverage, which is what keeps soft edges from picking up a dark fringe.
    gl_FragColor = vec4(col * a, a);
  }
`,
);

/** One chat ring travelling across the frame. Eight of these exist and are recycled in order. */
interface Ripple {
  /** Origin in aspect-corrected frame space, on the edge of the frame. */
  x: number;
  y: number;
  /** How far the ring has already travelled, in the same units. */
  radius: number;
  /** Seconds since it was launched. */
  age: number;
  /** Seconds it is allowed to live. */
  life: number;
  /** Travel speed in frame-widths per second. */
  speed: number;
  /** Half-width of the ring's band, in frame space. */
  width: number;
  /** 1 for a sub/cheer/raid ring, 0 for an ordinary chat message. */
  accent: number;
}

const contourChorus = defineEffect({
  descriptor: {
    id: "contour-chorus",
    name: "Contour Chorus",
    description:
      "Draws only the glowing edge of the live camera image — a light-pen tracing of the streamer's silhouette that thickens with their voice, while every chat message sends a ring across the frame that makes the outline flare and flinch.",
    engine: "three",
    category: "overlay",
    tags: ["overlay", "camera", "video", "contour", "edge", "reactive", "chat", "audio"],
    previewNotes:
      "Fully transparent except for the contour, so it is meant to sit directly on top of the real camera source in OBS at the same size and crop. It asks the browser for the webcam: if the OBS camera source already holds that device and the driver will not share it, the SDK falls back to its 640x360 test pattern and the effect traces that instead — still a deliberate ambient line, but not a person. Use Zoom, Horizontal/Vertical Offset and Mirror to line the contour up with the camera underneath.",
    params: [
      paletteParam(
        "palette",
        "Palette",
        "neon-dusk",
        "Colour ramp for the contour. The colour is picked by which way the line is running, so it travels around the silhouette as it curves.",
      ),
      {
        key: "accentColor",
        label: "Event Colour",
        kind: "color",
        default: "#ffd166",
        description:
          "Colour of the slow, thick rings launched by subs, gift subs, cheers and raids, so those read differently from an ordinary message.",
      },
      {
        key: "edgeThreshold",
        label: "Edge Threshold",
        kind: "number",
        default: 0.18,
        min: 0.02,
        max: 1.2,
        step: 0.01,
        description:
          "How strong a brightness change has to be before it becomes a line. Lower picks up more detail — folds in clothing, texture in the background; higher keeps only the strongest silhouette.",
      },
      {
        key: "edgeSoftness",
        label: "Edge Softness",
        kind: "number",
        default: 0.4,
        min: 0,
        max: 2,
        step: 0.05,
        description:
          "How sharply the line falls off, as a fraction of the threshold. 0 is a hard pen stroke; high values turn it into a soft glow.",
      },
      {
        key: "lineWidth",
        label: "Line Width",
        kind: "number",
        default: 1.2,
        min: 0.5,
        max: 6,
        step: 0.1,
        description:
          "Base thickness of the contour in pixels, before the voice adds to it. This is also the distance the edge detector looks across, so a wider line finds slightly softer edges too.",
      },
      {
        key: "voiceGain",
        label: "Voice Gain",
        kind: "number",
        default: 1,
        min: 0,
        max: 3,
        step: 0.05,
        description:
          "How much speech thickens and brightens the contour, and how much it shivers on loud passages. 0 holds the line perfectly steady and ignores audio entirely.",
      },
      {
        key: "idleOpacity",
        label: "Idle Opacity",
        kind: "number",
        default: 0.25,
        min: 0.02,
        max: 1,
        step: 0.01,
        description:
          "How visible the contour is in silence. The voice lifts it from here toward fully opaque, so a low value is what makes the outline breathe.",
      },
      {
        key: "zoom",
        label: "Zoom",
        kind: "number",
        default: 1,
        min: 0.4,
        max: 3,
        step: 0.01,
        description:
          "Scales the sampled camera image about the centre. Use it to match however the OBS camera source underneath is cropped — a contour that does not sit on the person is worse than none.",
      },
      {
        key: "offsetX",
        label: "Horizontal Offset",
        kind: "number",
        default: 0,
        min: -0.5,
        max: 0.5,
        step: 0.005,
        description:
          "Slides the sampled image sideways, in fractions of the frame width. Positive moves the contour left.",
      },
      {
        key: "offsetY",
        label: "Vertical Offset",
        kind: "number",
        default: 0,
        min: -0.5,
        max: 0.5,
        step: 0.005,
        description:
          "Slides the sampled image up and down, in fractions of the frame height. Positive moves the contour down.",
      },
      {
        key: "mirror",
        label: "Mirror",
        kind: "boolean",
        default: false,
        description:
          "Flips the sampled image horizontally. Turn this on when the camera source in OBS is mirrored and the contour comes out back to front.",
      },
      {
        key: "rippleSpeed",
        label: "Ripple Speed",
        kind: "number",
        default: 0.8,
        min: 0.1,
        max: 3,
        step: 0.05,
        description:
          "How fast a chat ring crosses the frame, in frame-widths per second. Rings from events travel at half this.",
      },
      {
        key: "rippleLife",
        label: "Ripple Life",
        kind: "number",
        default: 1.6,
        min: 0.4,
        max: 6,
        step: 0.1,
        description:
          "Seconds a chat ring stays alive before it has completely faded. Event rings live twice as long so they can cross the whole body.",
      },
      {
        key: "rippleWidth",
        label: "Ripple Width",
        kind: "number",
        default: 0.06,
        min: 0.01,
        max: 0.3,
        step: 0.005,
        description:
          "How thick the travelling ring is, as a fraction of the frame height. It is never drawn on its own — this is the width of the region where the contour reacts.",
      },
      {
        key: "rippleDisplace",
        label: "Ripple Displacement",
        kind: "number",
        default: 3.5,
        min: 0,
        max: 20,
        step: 0.5,
        description:
          "How far, in pixels, a passing ring pushes the contour aside along its own normal. This is the flinch; 0 leaves the outline still and only brightens it.",
      },
      {
        key: "rippleFlare",
        label: "Ripple Flare",
        kind: "number",
        default: 0.9,
        min: 0,
        max: 2,
        step: 0.05,
        description:
          "How hard a passing ring drives the contour toward white and lifts its opacity. 0 makes chat move the line without lighting it up.",
      },
      {
        key: "eventScale",
        label: "Event Ring Scale",
        kind: "number",
        default: 3,
        min: 1,
        max: 8,
        step: 0.1,
        description:
          "Thickness multiplier for rings from subs, gift subs, cheers and raids, so those arrive as a slow swell rather than another ping.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    /*
     * Every feed is acquired before anything GPU-side is built, and each await is followed by a
     * checkpoint. None of useAudio/useVideo/useChat checkpoints for us and none of them ever
     * rejects, so this is the only thing standing between a scope that died during the waits and an
     * effect that goes on to allocate a WebGL context nobody will ever tear down.
     */
    const bus = await useAudio(scope);
    scope.checkpoint();
    const source = await useVideo(scope);
    scope.checkpoint();
    const chat = await useChat(scope);
    scope.checkpoint();

    const envelopes = createEnvelopes(bus);

    const stage = createThreeStage(scope, ctx, {
      antialias: false,
      camera: { kind: "fullscreen-quad" },
    });

    // The texture belongs to this effect's WebGL context and is registered on the scope by the
    // helper. It refreshes itself from the shared <video> element, so there is no per-frame work.
    const videoTexture = videoTextureThree(scope, source);

    // ---- parameters -----------------------------------------------------------------------
    // Read once here and re-read in full in setParams, which is the rule that keeps every slider
    // live. The three that only matter at the moment a ring is launched are kept in variables;
    // everything else goes straight into a uniform.
    let lineWidth = num(ctx.params, "lineWidth", 1.2, 0.5, 6);
    let voiceGain = num(ctx.params, "voiceGain", 1, 0, 3);
    let idleOpacity = num(ctx.params, "idleOpacity", 0.25, 0.02, 1);
    let rippleSpeed = num(ctx.params, "rippleSpeed", 0.8, 0.1, 3);
    let rippleLife = num(ctx.params, "rippleLife", 1.6, 0.4, 6);
    let rippleWidth = num(ctx.params, "rippleWidth", 0.06, 0.01, 0.3);
    let eventScale = num(ctx.params, "eventScale", 3, 1, 8);

    // ---- chat rings, CPU side ---------------------------------------------------------------
    const ripples: Ripple[] = [];
    const rippleUniforms: THREE.Vector4[] = [];
    const rippleStyles: THREE.Vector2[] = [];
    for (let i = 0; i < RIPPLE_SLOTS; i += 1) {
      ripples.push({ x: 0, y: 0, radius: 0, age: 1, life: 1, speed: 1, width: 0.06, accent: 0 });
      rippleUniforms.push(new THREE.Vector4(0, 0, 0, 0));
      rippleStyles.push(new THREE.Vector2(0.06, 0));
    }
    let nextSlot = 0;

    // The aspect ratio is needed on the CPU to place a ring's origin on the frame edge and to
    // convert its speed from frame-widths into the shader's frame space.
    let aspect = stage.width / Math.max(1, stage.height);

    const paletteColors = paletteUniform(
      palette(ctx.params, "palette", "neon-dusk"),
      PALETTE_STOPS,
    ).colors;

    const uniforms = {
      uVideo: { value: videoTexture },
      uResolution: { value: new THREE.Vector2(stage.width, stage.height) },
      uTime: { value: 0 },
      uThreshold: { value: num(ctx.params, "edgeThreshold", 0.18, 0.02, 1.2) },
      uSoftness: { value: num(ctx.params, "edgeSoftness", 0.4, 0, 2) },
      uLine: { value: lineWidth },
      uBright: { value: idleOpacity },
      uTremor: { value: 0 },
      uZoom: { value: num(ctx.params, "zoom", 1, 0.4, 3) },
      uOffset: {
        value: new THREE.Vector2(
          num(ctx.params, "offsetX", 0, -0.5, 0.5),
          num(ctx.params, "offsetY", 0, -0.5, 0.5),
        ),
      },
      uMirror: { value: bool(ctx.params, "mirror", false) ? 1 : 0 },
      uRipples: { value: rippleUniforms },
      uRippleStyle: { value: rippleStyles },
      uRippleDisplace: { value: num(ctx.params, "rippleDisplace", 3.5, 0, 20) },
      uRippleFlare: { value: num(ctx.params, "rippleFlare", 0.9, 0, 2) },
      uPalette: { value: paletteColors },
      uPaletteCount: { value: PALETTE_STOPS },
      uAccent: {
        value: new THREE.Vector3(...rgb01(colorHex(ctx.params, "accentColor", "#ffd166"))),
      },
    };

    const geometry = scope.ownDisposable(new THREE.PlaneGeometry(2, 2));
    const material = scope.ownDisposable(
      new THREE.ShaderMaterial({
        vertexShader: FULLSCREEN_VERTEX,
        fragmentShader: FRAGMENT_SHADER,
        uniforms,
        transparent: true,
        premultipliedAlpha: true,
        depthTest: false,
        depthWrite: false,
      }),
    );

    const quad = new THREE.Mesh(geometry, material);
    // The quad is written straight into clip space by the shared vertex shader, so it has no real
    // position for the culler to test; leaving culling on would let it vanish entirely.
    quad.frustumCulled = false;
    stage.scene.add(quad);

    stage.onResize((w, h) => {
      uniforms.uResolution.value.set(w, h);
      aspect = w / Math.max(1, h);
    });

    /**
     * Launches a ring for one chat message.
     *
     * The origin is the point where a ray at the seeded angle leaves the frame, so every ring
     * starts on an edge and travels inward across the picture. Because the angle comes from
     * `message.seed`, which the backend derives from the sender's name, the same viewer's rings
     * always arrive from the same corner.
     */
    const launch = (message: ChatMessage): void => {
      const isEvent = message.event !== "chat";
      // The seed arrives over the network, so it is treated the same way a stored parameter is: a
      // value that is not a finite number degrades to 0 rather than being trusted. A NaN here would
      // reach the shader as a NaN ring centre, and every pixel that measured its distance to that
      // ring would come out not-a-number — one malformed message would blank the whole overlay.
      const seed = Number.isFinite(message.seed) ? Math.abs(message.seed) : 0;
      const angle = ((seed % 4096) / 4096) * TAU;
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      const halfWidth = aspect / 2;
      // How far along the ray each of the two frame edges is; whichever comes first is the one hit.
      const toSide = Math.abs(dx) < 1e-4 ? Number.POSITIVE_INFINITY : halfWidth / Math.abs(dx);
      const toTop = Math.abs(dy) < 1e-4 ? Number.POSITIVE_INFINITY : 0.5 / Math.abs(dy);
      const reach = Math.min(toSide, toTop);

      const slot = ripples[nextSlot];
      nextSlot = (nextSlot + 1) % RIPPLE_SLOTS;
      if (slot === undefined) return;

      slot.x = dx * reach;
      slot.y = dy * reach;
      slot.radius = 0;
      slot.age = 0;
      // An event ring is slower and lives longer, which together are what make it read as one swell
      // crossing the body rather than a ping going past.
      slot.life = rippleLife * (isEvent ? 2 : 1);
      slot.speed = rippleSpeed * (isEvent ? 0.5 : 1);
      slot.width = rippleWidth * (isEvent ? eventScale : 1);
      slot.accent = isEvent ? 1 : 0;
    };

    // The unsubscribe function is handed to the scope, so the listener cannot outlive the effect.
    scope.defer(chat.onMessage(launch));

    onFrame(scope, ctx.fpsCap, ({ dt, now }) => {
      bus.sample(now);
      envelopes.update(dt);

      uniforms.uTime.value += dt;

      /*
       * The three envelopes are the same loudness tracked at three different speeds, not frequency
       * bands. `mid` follows speech closely enough to carry line weight, `slow` ignores individual
       * syllables and so makes a steady brightness, and `fast` snaps to transients, which is what
       * the shiver wants.
       */
      uniforms.uLine.value = lineWidth + envelopes.mid * voiceGain * 1.8;
      uniforms.uBright.value =
        idleOpacity + (1 - idleOpacity) * Math.min(1, envelopes.slow * voiceGain);
      uniforms.uTremor.value = envelopes.fast * voiceGain * 0.6;

      for (let i = 0; i < RIPPLE_SLOTS; i += 1) {
        const ring = ripples[i];
        const out = rippleUniforms[i];
        const style = rippleStyles[i];
        if (ring === undefined || out === undefined || style === undefined) continue;

        if (ring.age >= ring.life) {
          // Strength 0 means the shader's loop still visits this slot and contributes nothing.
          out.set(0, 0, 0, 0);
          continue;
        }

        ring.age += dt;
        ring.radius += dt * ring.speed * aspect;
        // Ease out on the way down: the ring holds its brightness while it is still near the person
        // and then lets go quickly, rather than fading linearly the whole way across.
        const remaining = Math.max(0, 1 - ring.age / Math.max(ring.life, 1e-3));
        out.set(ring.x, ring.y, ring.radius, Math.pow(remaining, 1.8));
        style.set(ring.width, ring.accent);
      }

      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        lineWidth = num(p, "lineWidth", 1.2, 0.5, 6);
        voiceGain = num(p, "voiceGain", 1, 0, 3);
        idleOpacity = num(p, "idleOpacity", 0.25, 0.02, 1);
        rippleSpeed = num(p, "rippleSpeed", 0.8, 0.1, 3);
        rippleLife = num(p, "rippleLife", 1.6, 0.4, 6);
        rippleWidth = num(p, "rippleWidth", 0.06, 0.01, 0.3);
        eventScale = num(p, "eventScale", 3, 1, 8);

        uniforms.uThreshold.value = num(p, "edgeThreshold", 0.18, 0.02, 1.2);
        uniforms.uSoftness.value = num(p, "edgeSoftness", 0.4, 0, 2);
        uniforms.uZoom.value = num(p, "zoom", 1, 0.4, 3);
        uniforms.uOffset.value.set(
          num(p, "offsetX", 0, -0.5, 0.5),
          num(p, "offsetY", 0, -0.5, 0.5),
        );
        uniforms.uMirror.value = bool(p, "mirror", false) ? 1 : 0;
        uniforms.uRippleDisplace.value = num(p, "rippleDisplace", 3.5, 0, 20);
        uniforms.uRippleFlare.value = num(p, "rippleFlare", 0.9, 0, 2);
        uniforms.uAccent.value.set(...rgb01(colorHex(p, "accentColor", "#ffd166")));

        // The palette's colours are copied into the vectors the material already holds, rather than
        // the array being replaced: three.js uploads whatever is in those objects, and swapping the
        // array would leave the old ones behind on the next frame.
        const next = paletteUniform(palette(p, "palette", "neon-dusk"), PALETTE_STOPS).colors;
        for (let i = 0; i < PALETTE_STOPS; i += 1) {
          const target = paletteColors[i];
          const value = next[i];
          if (target !== undefined && value !== undefined) target.copy(value);
        }
      },
    };
  },
});

export default contourChorus;
