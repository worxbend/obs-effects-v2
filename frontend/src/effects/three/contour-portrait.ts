import * as THREE from "three";

import { bool, colorHex, int, num, rgb01 } from "../paramUtils";
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
  useVideo,
  videoTextureThree,
} from "../sdk";

/**
 * Contour Portrait
 * ================
 *
 * Your webcam redrawn as a topographic map of itself. The frame contains no video at all — only
 * hairline strokes where the brightness of the camera image crosses from one level to the next, the
 * way the contour lines on a walking map mark where the ground crosses from one height to the next.
 * A face becomes a set of nested closed curves around the brow, the nose and the jaw; a shoulder
 * becomes two or three long parallel sweeps; a flat wall behind you, having no brightness gradient
 * to cross, draws nothing at all. That emptiness is the composition — it is what lets the drawing
 * sit over a full-frame game capture without reading as a picture-in-picture box.
 *
 * The whole image dissolves into nothing towards the edges of the frame, so there is no rectangle,
 * no border and no vignette shape anywhere. The drawing simply stops existing.
 *
 * How a contour is actually drawn, and why it is not a posterise
 * -------------------------------------------------------------
 * Reducing an image to N brightness bands is easy: multiply the brightness by N and take the whole
 * number part. Drawing the *boundaries* between those bands as an even-weight line is the part that
 * takes care, and it is the difference between this looking drawn and looking like a cheap poster
 * filter.
 *
 * The naive approach thresholds the fractional part directly — "draw a line wherever `fract(band)`
 * is close to zero". That fails in both directions at once. Across a cheek, where brightness
 * changes very gradually, "close to zero" covers a huge area of the screen and the line comes out
 * as a fat smear. Across the sharp edge of a jaw, where brightness changes by several whole bands
 * within a single pixel, "close to zero" is almost never sampled and the line disappears entirely.
 *
 * The fix is one division. `fwidth(x)` is a GPU built-in that reports how much a value changes
 * between one pixel and the next. Dividing the distance-to-the-nearest-band-boundary by
 * `fwidth(band)` converts that distance out of "brightness units" and into *screen pixels* — so the
 * shader can then ask for a stroke that is, say, 1.1 pixels wide and get exactly that, whether the
 * contour is crossing a gentle gradient or a hard edge. Steep places draw a crisp line, shallow
 * places draw the same crisp line, and genuinely flat places (`fwidth` near zero) draw nothing,
 * because the boundary is then further than 1.1 pixels away everywhere.
 *
 * The rest of the pipeline, in order
 * ----------------------------------
 * 1. **Cover-fit framing.** The camera's own shape almost never matches the OBS source's shape, so
 *    the picture is scaled to cover the frame and the excess is cropped, plus optional mirroring
 *    (a camera reads as a mirror to the person in front of it) and a zoom/offset crop.
 * 2. **A small blur.** Camera sensors are noisy, and noise is a brightness gradient like any other:
 *    without this every contour breaks into confetti. A fixed 3x3 tent blur, a few source pixels
 *    wide, is enough to settle it. The kernel is written out longhand because the shader language
 *    used here requires loop bounds to be compile-time constants.
 * 3. **Exposure.** Brightness is taken as the standard perceptual mix of the three colour channels,
 *    then a black point (Lift) is subtracted and a contrast multiplier (Gain) applied. These are
 *    first-class controls rather than polish: in a dark room the whole image sits inside two bands
 *    and almost nothing draws, and in a blown-out room the highlights clip flat and the face
 *    vanishes. Exposure is what makes this usable in a real room.
 * 4. **The contour test**, described above.
 * 5. **Optional band fill.** Each band can be flooded with a flat tint taken from the palette at
 *    that band's height, at a very low opacity — a risograph-style duotone under the linework that
 *    gives the drawing mass without giving it detail.
 * 6. **Focus falloff.** Coverage is multiplied by a wide radial ramp, crisp in the middle and gone
 *    by the time it reaches any edge of the frame. That last part is what keeps the promise made
 *    above, and it is arithmetic rather than taste: the ramp is measured in half-frame-heights, so
 *    Focus Radius plus Falloff must land at or under 1.0 for the drawing to have faded out before
 *    the top and bottom of the frame arrive and cut it off. The defaults (0.62 + 0.38) sum to
 *    exactly 1.0 for that reason.
 * 7. **Grain.** Those low-opacity fills are exactly where an 8-bit display, and then a video
 *    encoder, produce visible stepping. A little noise on the coverage breaks the steps up. It is
 *    the reason the grain control is not optional.
 *
 * What moves
 * ----------
 * Nothing of its own. The only motion in the frame is yours, translated into contours that flow and
 * re-nest as you lean. Turning Audio Reactivity up lets speaking open the focus radius by a few
 * percent — the drawing leans in while you talk and settles back in silence. One channel, one
 * target, deliberately: anything more would turn a drawing into a visualiser.
 *
 * With no camera
 * --------------
 * An OBS browser source usually has no camera permission, and `useVideo` answers that with a
 * slowly drifting gradient test pattern rather than an error. Fed through this shader that pattern
 * produces clean concentric contours, so the effect still looks deliberate rather than broken while
 * the operator sorts the permission out. There is no fallback branch here because there does not
 * need to be one.
 */
const FRAGMENT_SHADER = assembleFragment(
  ["hash12", "easing", "palette"],
  /* glsl */ `
  varying vec2 vUv;

  uniform sampler2D uVideo;
  uniform vec2 uVideoSize;   // the camera's real pixel size; gives both aspect and texel size
  uniform vec2 uResolution;  // the canvas size in pixels
  uniform float uTime;

  uniform float uMirror;     // 0 or 1
  uniform float uZoom;
  uniform vec2 uOffset;

  uniform float uSoften;     // pre-blur radius, in source pixels
  uniform float uLift;
  uniform float uGain;

  uniform float uLevels;
  uniform float uLineWidth;  // total stroke weight in screen pixels
  uniform vec3 uLineColor;
  uniform float uLineAlpha;

  uniform float uShowFill;   // 0 or 1
  uniform float uFillAlpha;
  uniform vec3 uPalette[8];
  uniform int uPaletteCount;

  uniform float uFocus;
  uniform float uFalloff;
  uniform float uGrain;
  uniform float uOpacity;

  // One tap of the camera image. Kept as a function so the nine taps below read as nine taps and
  // not as nine slightly different lines.
  vec3 tap(vec2 uv) {
    return texture2D(uVideo, uv).rgb;
  }

  // A 3x3 tent blur: weights 4 in the centre, 2 on the edges, 1 in the corners, summing to 16.
  // Written out rather than looped because GLSL ES 1.00 wants compile-time loop bounds, and a
  // radius that changes with a parameter cannot be one.
  vec3 soften(vec2 uv, vec2 r) {
    vec3 c = tap(uv) * 4.0;
    c += (tap(uv + vec2(r.x, 0.0)) + tap(uv - vec2(r.x, 0.0))) * 2.0;
    c += (tap(uv + vec2(0.0, r.y)) + tap(uv - vec2(0.0, r.y))) * 2.0;
    c += tap(uv + r) + tap(uv - r);
    c += tap(uv + vec2(r.x, -r.y)) + tap(uv + vec2(-r.x, r.y));
    return c / 16.0;
  }

  void main() {
    // ---- framing ------------------------------------------------------------------------------
    float canvasAspect = uResolution.x / max(uResolution.y, 1.0);
    float videoAspect = uVideoSize.x / max(uVideoSize.y, 1.0);

    // "Cover": scale the camera picture until it fills the frame in both directions and crop what
    // hangs over. Whichever way round the two shapes are, the sampled window shrinks along the
    // axis with the surplus, which is what a crop is.
    vec2 fit = vec2(1.0);
    if (videoAspect > canvasAspect) {
      fit.x = canvasAspect / videoAspect;
    } else {
      fit.y = videoAspect / canvasAspect;
    }

    vec2 uv = (vUv - 0.5) * fit / max(uZoom, 0.01) + uOffset + 0.5;
    // Mirroring last, so the picture flips the way a mirror does after the crop has been placed.
    uv.x = mix(uv.x, 1.0 - uv.x, uMirror);

    // Zooming out or offsetting far enough can walk the sampling window off the edge of the camera
    // picture, where the texture repeats its outermost row of pixels forever. That smear has a
    // brightness gradient and would therefore grow contours of its own, so anything outside the
    // real picture is faded out over a couple of source pixels.
    vec2 inside = smoothstep(vec2(0.0), vec2(0.004), uv)
                * (1.0 - smoothstep(vec2(0.996), vec2(1.0), uv));
    float inFrame = inside.x * inside.y;

    // ---- brightness ---------------------------------------------------------------------------
    vec3 rgb = soften(uv, uSoften / max(uVideoSize, vec2(1.0)));
    // The weights are the standard perceptual mix: the eye is far more sensitive to green than to
    // blue, so an equal average would make a blue shirt read as much brighter than it looks.
    float lum = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
    // Deliberately NOT clamped to 0..1. Clamping would flatten the crushed shadows and the blown
    // highlights into perfectly level plateaus, and a plateau that happened to sit exactly on a
    // band boundary would flood solid across the whole area. Left free, those areas are simply
    // flat, and a flat area is exactly what this shader draws nothing on.
    float exposed = (lum - uLift) * uGain;

    // ---- the contour test ---------------------------------------------------------------------
    float band = exposed * uLevels;
    float f = fract(band);
    // 0 exactly on a band boundary, rising to 0.5 in the middle of a band.
    float distToEdge = min(f, 1.0 - f);
    // How much 'band' changes between neighbouring pixels.
    float gradient = fwidth(band);
    // A genuinely flat area — a bare wall, a solid colour, a frame with no signal yet — has no
    // boundary anywhere near it, but arithmetically it divides zero by zero. This fades the stroke
    // out below a gradient so shallow that a single band would take ten thousand pixels to cross,
    // which no visible contour ever does.
    float alive = smoothstep(1.0e-5, 1.0e-4, gradient);
    // The whole trick: a distance measured in screen pixels rather than in brightness.
    float pixels = distToEdge / max(gradient, 1.0e-6);
    // Half the requested weight either side of the boundary, plus one pixel of soft edge.
    float halfWeight = uLineWidth * 0.5;
    float line = (1.0 - smoothstep(halfWeight, halfWeight + 1.0, pixels)) * alive;

    // ---- colour -------------------------------------------------------------------------------
    // Each band is tinted by its own height in the image, so the fill reads as a duotone print of
    // the brightness rather than as a copy of the camera's colours.
    //
    // The ramp lookup walks a seven-step loop over the palette uniform, and 'uShowFill' is a
    // uniform — every pixel of every frame takes the same side of this branch — so with Band Fill
    // off (the default) the whole loop is skipped rather than being computed and then multiplied
    // by a zero alpha.
    vec3 fillColor = vec3(0.0);
    if (uShowFill > 0.5) {
      fillColor = paletteRamp(uPalette, uPaletteCount, floor(band) / max(uLevels, 1.0));
    }

    float fillA = uShowFill * uFillAlpha;
    float lineA = line * uLineAlpha;

    // Straight-alpha "source over": the stroke sits on top of its own band's tint.
    float a = lineA + fillA * (1.0 - lineA);
    vec3 col = (uLineColor * lineA + fillColor * fillA * (1.0 - lineA)) / max(a, 1.0e-5);

    // ---- focus falloff ------------------------------------------------------------------------
    // Aspect-corrected and centred, so that a length of 1.0 is exactly half the frame height and
    // the falloff stays circular on a wide canvas.
    vec2 p = (vUv - 0.5) * vec2(canvasAspect, 1.0) * 2.0;
    float focus = remap(length(p), uFocus, uFocus + uFalloff, 1.0, 0.0);

    a *= focus * inFrame * uOpacity;

    // ---- grain --------------------------------------------------------------------------------
    // Scaled by the coverage already there, so it dithers the low-opacity fills — where 8-bit
    // stepping shows — and leaves the deliberately empty parts of the frame completely empty.
    float noise = hash12(gl_FragCoord.xy + fract(uTime) * 137.0) - 0.5;
    a = clamp(a * (1.0 + noise * uGrain * 4.0), 0.0, 1.0);

    // Premultiplied, to match the material's blending: see the note beside 'premultipliedAlpha'.
    gl_FragColor = vec4(col * a, a);
  }
`,
);

/** The palette this effect falls back to when a route stores an id this build does not have. */
const DEFAULT_PALETTE = "vapor";

const contourPortrait = defineEffect({
  descriptor: {
    id: "contour-portrait",
    name: "Contour Portrait",
    description:
      "Your webcam redrawn as a topographic map of itself: hairline iso-brightness contours at a constant one-pixel weight, dissolving to nothing at the edges so the drawing floats over the scene with no box around it.",
    engine: "three",
    category: "overlay",
    tags: ["camera", "webcam", "video", "contour", "line", "overlay", "shader", "three"],
    previewNotes:
      "Fully transparent apart from the linework, and it draws no border of any kind — put it over a full-frame game or desktop capture rather than in a camera box. With no camera permission it draws the SDK's test pattern as concentric rings, which is a useful sign that the effect is alive but the camera is not. Lift and Gain are the controls that matter: set them first, in the light you actually stream in.",
    params: [
      {
        key: "mirror",
        label: "Mirror",
        kind: "boolean",
        default: true,
        description:
          "Flip the picture horizontally so the camera reads as a mirror, which is how you see yourself and therefore how leaning left or right feels correct.",
      },
      {
        key: "levels",
        label: "Levels",
        kind: "number",
        default: 14,
        min: 3,
        max: 40,
        step: 1,
        description:
          "How many brightness bands the image is divided into, and therefore how many contour lines there are. Low values give a few bold curves; high values give a dense, finely drawn map.",
      },
      {
        key: "lineWidth",
        label: "Line Weight",
        kind: "number",
        default: 1.1,
        min: 0.25,
        max: 4,
        step: 0.05,
        description:
          "Stroke thickness in screen pixels. It stays this thick everywhere — across a soft cheek and across a hard jaw edge alike — which is what makes the result read as drawn.",
      },
      {
        key: "soften",
        label: "Soften",
        kind: "number",
        default: 1.2,
        min: 0,
        max: 4,
        step: 0.1,
        description:
          "Blur radius applied to the camera picture first, in camera pixels. Camera noise is a brightness change like any other, so without a little of this every contour breaks into speckle. Raise it in a dim room, where the sensor is noisiest.",
      },
      {
        key: "lift",
        label: "Lift (black point)",
        kind: "number",
        default: 0.04,
        min: 0,
        max: 0.6,
        step: 0.01,
        description:
          "How much brightness is subtracted before banding. Raise it until the shadows behind you stop drawing lines; lower it if the darker side of your face has gone empty.",
      },
      {
        key: "gain",
        label: "Gain (contrast)",
        kind: "number",
        default: 1.15,
        min: 0.2,
        max: 4,
        step: 0.01,
        description:
          "Contrast multiplier applied before banding, and the main exposure control. Raise it in a flat, dim room to get contours at all; lower it under a bright key light so the highlights stop clipping to blank.",
      },
      {
        key: "lineColor",
        label: "Line Colour",
        kind: "color",
        default: "#eef2f6",
        description:
          "Colour of the contour strokes. A near-white reads as ink on whatever is behind it; try a near-black over a bright scene.",
      },
      {
        key: "lineOpacity",
        label: "Line Opacity",
        kind: "number",
        default: 0.85,
        min: 0,
        max: 1,
        step: 0.01,
        description:
          "How solid the strokes are. Slightly under full opacity keeps the drawing sitting in the scene rather than on top of it.",
      },
      {
        key: "showFill",
        label: "Band Fill",
        kind: "boolean",
        default: false,
        description:
          "Flood each band with a flat tint from the palette, under the linework. A risograph-style duotone that gives the drawing mass without giving it detail.",
      },
      {
        key: "fillAlpha",
        label: "Fill Opacity",
        kind: "number",
        default: 0.08,
        min: 0,
        max: 0.5,
        step: 0.01,
        description:
          "How strong the band tints are when Band Fill is on. Keep it low: this is meant to be felt rather than seen.",
      },
      paletteParam(
        "palette",
        "Palette",
        DEFAULT_PALETTE,
        "Colour ramp the band tints are sampled from, dark bands taking the start of the ramp and bright bands the end. Only used when Band Fill is on.",
      ),
      {
        key: "focus",
        label: "Focus Radius",
        kind: "number",
        default: 0.62,
        min: 0.1,
        max: 1.5,
        step: 0.01,
        description:
          "How much of the middle of the frame stays fully drawn, measured as a fraction of half the frame height. 1.0 reaches the top and bottom edges.",
      },
      {
        key: "falloff",
        label: "Falloff",
        kind: "number",
        default: 0.38,
        min: 0.05,
        max: 1.5,
        step: 0.01,
        description:
          "How far beyond the focus radius the drawing takes to fade out completely, in the same units as Focus Radius. Wider is softer. Keep Focus Radius plus Falloff at or under 1.0 and the drawing is already gone by the time it reaches the top and bottom of the frame; push the pair past 1.0 and the frame edge cuts the fade off mid-way, which is the one setting that puts a visible straight line in the picture.",
      },
      {
        key: "grain",
        label: "Grain",
        kind: "number",
        default: 0.02,
        min: 0,
        max: 0.2,
        step: 0.005,
        description:
          "Dither on the coverage. Small amounts hide the stepping that low-opacity fills produce on an 8-bit display and that a video encoder then exaggerates.",
      },
      {
        key: "opacity",
        label: "Opacity",
        kind: "number",
        default: 1,
        min: 0,
        max: 1,
        step: 0.01,
        description: "Master opacity for the whole drawing.",
      },
      {
        key: "zoom",
        label: "Zoom",
        kind: "number",
        default: 1,
        min: 0.5,
        max: 3,
        step: 0.01,
        description:
          "Crop into the camera picture. Above 1 moves in closer; below 1 pulls back and leaves the camera picture smaller than the frame.",
      },
      {
        key: "offsetX",
        label: "Offset X",
        kind: "number",
        default: 0,
        min: -0.5,
        max: 0.5,
        step: 0.01,
        description:
          "Slides the crop sideways across the camera picture, as a fraction of its width. Use it to put your head off-centre.",
      },
      {
        key: "offsetY",
        label: "Offset Y",
        kind: "number",
        default: 0,
        min: -0.5,
        max: 0.5,
        step: 0.01,
        description:
          "Slides the crop up and down across the camera picture, as a fraction of its height.",
      },
      {
        key: "speed",
        label: "Grain Speed",
        kind: "number",
        default: 1,
        min: 0,
        max: 4,
        step: 0.05,
        description:
          "How fast the grain reseeds. 0 freezes it into a still film grain, which is calmer on a static shot.",
      },
      {
        key: "audioReactivity",
        label: "Audio Reactivity",
        kind: "number",
        default: 0,
        min: 0,
        max: 2,
        step: 0.05,
        description:
          "How much speaking opens the focus radius, so the drawing leans in while you talk and settles in silence. 0 keeps the radius fixed.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    /*
     * The two shared inputs are acquired before anything is built, so that a scope disposed during
     * the wait — a remount while the camera permission prompt is still open, say — tears down with
     * no WebGL context to release. Neither of these checkpoints for us; see their documentation.
     */
    const source = await useVideo(scope);
    scope.checkpoint();
    const bus = await useAudio(scope);
    scope.checkpoint();
    const envelopes = createEnvelopes(bus);

    // Antialiasing off: a full-screen quad has no polygon edges to smooth, so multisampling costs
    // fill rate and changes nothing.
    const stage = createThreeStage(scope, ctx, {
      antialias: false,
      camera: { kind: "fullscreen-quad" },
    });

    // Created after the stage so that the scope's reverse-order teardown releases the texture
    // before it releases the renderer, which is the order three.js expects. The helper owns it.
    const texture = videoTextureThree(scope, source);

    const colorVec = (p: Record<string, unknown>, key: string, fallback: string): THREE.Vector3 => {
      const [r, g, b] = rgb01(colorHex(p, key, fallback));
      return new THREE.Vector3(r, g, b);
    };

    // Values the frame loop needs every frame are kept as plain scalars rather than read back out
    // of the uniforms, because the loop composes them with the audio envelope before writing.
    let speed = num(ctx.params, "speed", 1, 0, 4);
    let focus = num(ctx.params, "focus", 0.62, 0.1, 1.5);
    let audioReactivity = num(ctx.params, "audioReactivity", 0, 0, 2);

    const initialPalette = paletteUniform(palette(ctx.params, "palette", DEFAULT_PALETTE), 8);

    const uniforms = {
      uVideo: { value: texture },
      uVideoSize: { value: new THREE.Vector2(source.width, source.height) },
      uResolution: { value: new THREE.Vector2(stage.width, stage.height) },
      uTime: { value: 0 },

      uMirror: { value: bool(ctx.params, "mirror", true) ? 1 : 0 },
      uZoom: { value: num(ctx.params, "zoom", 1, 0.5, 3) },
      uOffset: {
        value: new THREE.Vector2(
          num(ctx.params, "offsetX", 0, -0.5, 0.5),
          num(ctx.params, "offsetY", 0, -0.5, 0.5),
        ),
      },

      uSoften: { value: num(ctx.params, "soften", 1.2, 0, 4) },
      uLift: { value: num(ctx.params, "lift", 0.04, 0, 0.6) },
      uGain: { value: num(ctx.params, "gain", 1.15, 0.2, 4) },

      uLevels: { value: int(ctx.params, "levels", 14, 3, 40) },
      uLineWidth: { value: num(ctx.params, "lineWidth", 1.1, 0.25, 4) },
      uLineColor: { value: colorVec(ctx.params, "lineColor", "#eef2f6") },
      uLineAlpha: { value: num(ctx.params, "lineOpacity", 0.85, 0, 1) },

      uShowFill: { value: bool(ctx.params, "showFill", false) ? 1 : 0 },
      uFillAlpha: { value: num(ctx.params, "fillAlpha", 0.08, 0, 0.5) },
      uPalette: { value: initialPalette.colors },
      uPaletteCount: { value: initialPalette.count },

      uFocus: { value: focus },
      uFalloff: { value: num(ctx.params, "falloff", 0.38, 0.05, 1.5) },
      uGrain: { value: num(ctx.params, "grain", 0.02, 0, 0.2) },
      uOpacity: { value: num(ctx.params, "opacity", 1, 0, 1) },
    };

    const geometry = scope.ownDisposable(new THREE.PlaneGeometry(2, 2));
    const material = scope.ownDisposable(
      new THREE.ShaderMaterial({
        vertexShader: FULLSCREEN_VERTEX,
        fragmentShader: FRAGMENT_SHADER,
        uniforms,
        /*
         * Transparent with premultiplied alpha, because the shader writes `vec4(colour * a, a)`.
         * Blending premultiplied output with the default source-alpha factor would scale the colour
         * a second time, which leaves a dark halo along every soft edge — and on a near-white
         * hairline over a bright game capture that halo is the only thing anyone would notice.
         */
        transparent: true,
        premultipliedAlpha: true,
        depthTest: false,
        depthWrite: false,
      }),
    );

    const quad = new THREE.Mesh(geometry, material);
    quad.frustumCulled = false;
    stage.scene.add(quad);

    stage.onResize((w, h) => uniforms.uResolution.value.set(w, h));

    onFrame(scope, ctx.fpsCap, ({ dt, now }) => {
      bus.sample(now);
      envelopes.update(dt);

      /*
       * Accumulated rather than read from the wall clock, so changing Grain Speed alters the rate
       * from here on instead of jumping the noise to a different seed.
       *
       * Wrapped back into 0..1 on every step, because the shader only ever uses `fract(uTime)`:
       * wrapping here is invisible in the output but keeps the number small. A uniform is uploaded
       * as a 32-bit float, and after a broadcast long enough for the count to reach five figures a
       * 32-bit float can no longer represent the small steps between frames — the grain would
       * quietly stop moving. Doing the wrap in JavaScript, where the arithmetic is 64-bit, means
       * that never happens however long the source is left running.
       */
      uniforms.uTime.value = (uniforms.uTime.value + dt * speed) % 1;

      /*
       * The camera's real resolution is not known when this effect is built: a `<video>` element
       * reports 0 x 0 until its first frame has arrived, which is usually several frames after the
       * effect has started drawing. The SDK's VideoSource reports the placeholder size until then,
       * so reading it every frame is both correct from the first frame and correct after the camera
       * settles — or after the operator switches to a different one mid-broadcast.
       */
      uniforms.uVideoSize.value.set(source.width, source.height);

      // The one audio target: 'slow' is loudness tracked with a long time constant, so this is a
      // gentle open-and-settle over a sentence rather than a flicker on every syllable.
      uniforms.uFocus.value = focus * (1 + envelopes.slow * 0.12 * audioReactivity);

      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        speed = num(p, "speed", 1, 0, 4);
        focus = num(p, "focus", 0.62, 0.1, 1.5);
        audioReactivity = num(p, "audioReactivity", 0, 0, 2);

        uniforms.uMirror.value = bool(p, "mirror", true) ? 1 : 0;
        uniforms.uZoom.value = num(p, "zoom", 1, 0.5, 3);
        uniforms.uOffset.value.set(
          num(p, "offsetX", 0, -0.5, 0.5),
          num(p, "offsetY", 0, -0.5, 0.5),
        );

        uniforms.uSoften.value = num(p, "soften", 1.2, 0, 4);
        uniforms.uLift.value = num(p, "lift", 0.04, 0, 0.6);
        uniforms.uGain.value = num(p, "gain", 1.15, 0.2, 4);

        uniforms.uLevels.value = int(p, "levels", 14, 3, 40);
        uniforms.uLineWidth.value = num(p, "lineWidth", 1.1, 0.25, 4);
        uniforms.uLineColor.value.copy(colorVec(p, "lineColor", "#eef2f6"));
        uniforms.uLineAlpha.value = num(p, "lineOpacity", 0.85, 0, 1);

        uniforms.uShowFill.value = bool(p, "showFill", false) ? 1 : 0;
        uniforms.uFillAlpha.value = num(p, "fillAlpha", 0.08, 0, 0.5);

        // Re-baked in place: the array is replaced but its length never changes, so the compiled
        // material keeps the same uniform slots and nothing is rebuilt.
        const baked = paletteUniform(palette(p, "palette", DEFAULT_PALETTE), 8);
        uniforms.uPalette.value = baked.colors;
        uniforms.uPaletteCount.value = baked.count;

        uniforms.uFalloff.value = num(p, "falloff", 0.38, 0.05, 1.5);
        uniforms.uGrain.value = num(p, "grain", 0.02, 0, 0.2);
        uniforms.uOpacity.value = num(p, "opacity", 1, 0, 1);
      },
    };
  },
});

export default contourPortrait;
