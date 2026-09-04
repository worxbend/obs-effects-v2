import * as THREE from "three";

import { num } from "../paramUtils";
import { assembleFragment, defineEffect, palette, paletteAt01, paletteParam } from "../sdk";
import { SPEED_PARAM, shaderQuadSetup } from "./shaderQuad";

/**
 * Iridescent Film
 * ===============
 *
 * A soap film drifting across the frame. Where it is thinnest the colours cycle through magenta,
 * gold and cyan; where two bands pinch together it goes pearlescent white, the way a real film does
 * moments before it pops. It is almost entirely transparent — a colourist's finishing pass over a
 * whole scene rather than an object sitting in front of one — and roughly half the frame is
 * untouched at any moment, so the sheen arrives and leaves instead of just being there.
 *
 * What thin-film interference actually is
 * ---------------------------------------
 * This is the physics behind a soap bubble and an oil slick on a wet road, and it is worth spelling
 * out because the shader below is a direct transcription of it.
 *
 * Light hitting a very thin transparent layer partly bounces off the front surface and partly
 * carries on, bounces off the back surface, and comes back out. The second ray travelled further —
 * twice the thickness of the film, adjusted for the angle it took inside — so it comes out *out of
 * step* with the first. When the two are back in step they reinforce each other and that colour is
 * bright; when they are exactly out of step they cancel and that colour vanishes.
 *
 * "In step" depends on the wavelength, and the wavelength is the colour. So one thickness makes red
 * bright and green dim, a slightly greater thickness makes green bright and red dim, and the result
 * is bands of colour that map the film's thickness. That is why the pattern reads as *wet* — it is
 * not a gradient painted on a surface, it is a contour map of a physical quantity.
 *
 * The shader models exactly that. A fractal-noise field gives every pixel a film thickness `d`,
 * measured in nanometres in the same units a real soap film is (a few hundred nanometres — thinner
 * than a wavelength of light, which is why the effect exists at all). For three representative
 * wavelengths — 610 nm red, 545 nm green, 465 nm blue — it computes how far out of step the two
 * reflections are and turns that into a brightness. Those three brightnesses become the red, green
 * and blue of the pixel.
 *
 * Why the film goes dark rather than white as it thins
 * ---------------------------------------------------
 * Reflecting off the front surface flips the wave upside down; reflecting off the back surface does
 * not. That built-in half-turn is why an extremely thin film is *black*, not white — the two
 * reflections cancel for every colour at once. The shader keeps that term (the reflectance is
 * `0.5 - 0.5·cos(phase)`, not `0.5 + 0.5·cos(phase)`), which is what makes the film fade out
 * honestly at its thin edge instead of turning into a bright rim.
 *
 * The bit that makes or breaks it: filtering the bands
 * ---------------------------------------------------
 * Wherever the thickness changes quickly, the interference bands get narrower — and once a band is
 * narrower than a pixel, sampling it once per pixel produces crawling moiré rather than colour.
 * That artefact only shows up in motion, so a screenshot will not reveal it.
 *
 * The fix is to widen the cosine by its own rate of change. `fwidth(phase)` reports how much the
 * phase moves between one pixel and its neighbour; feeding that through a Gaussian falloff blends
 * the cosine toward its own average (a flat 0.5) exactly where the band has shrunk below a pixel.
 * It is the shader equivalent of dropping to a coarser mip level, it costs three instructions, and
 * it is why this holds still at 1080p.
 *
 * Why the palette is not decoration here
 * --------------------------------------
 * A literal spectrum reads as a cheap holographic filter. The Saturation control blends the true
 * interference colours toward a *pearl* built from the chosen palette: the interference still
 * decides where the bands are and how bright they are, but it picks a position along a two- or
 * three-hue ramp rather than emitting a rainbow. At the shipped default of 0.35 the result is a
 * tinted sheen; push it to 1 for the full oil slick.
 *
 * That blend happens in linear light (the `srgb` chunk's `toLinear`/`toSrgb`) because reflectance
 * is a linear quantity and a palette colour is gamma-encoded; mixing the two without converting
 * would darken the midtones.
 *
 * Deliberate restraint in the defaults
 * ------------------------------------
 * Opacity is capped at 0.6 and ships at 0.18; saturation ships at 0.35; the thickness range is
 * narrow enough to give two or three broad washes rather than a dozen thin rainbow rings. Every
 * garish setting is reachable, but none of them is the starting point.
 *
 * Audio is a modifier, never the driver. The slow envelope swells the film — thickness rises, and
 * every band slides along with it, so the picture breathes. The fast envelope thins it briefly,
 * which flashes the white pinch, so a transient gets a legible physical response rather than a
 * brightness flicker. Both sit behind one Audio Response control that ships low on purpose.
 */
const FRAGMENT_SHADER = assembleFragment(
  ["hash12", "vnoise", "fbmRot", "srgb", "easing"],
  /* glsl */ `
  varying vec2 vUv;

  uniform float uTime;
  uniform vec2 uResolution;
  uniform vec4 uAudio; // level, slow, mid, fast — envelopes at three speeds, not frequency bands

  uniform float uThicknessMin; // nanometres at the thinnest part of the film
  uniform float uThicknessMax; // nanometres at the thickest
  uniform float uIndex;        // refractive index: soap ~1.33, oil ~1.5
  uniform float uScale;        // size of the thickness features
  uniform float uDrainAmount;  // how much the film thins along uDrainDir
  uniform vec2  uDrainDir;     // unit vector pointing the way the film thins
  uniform vec2  uViewCentre;   // 0..1 point the interference bands bow around
  uniform float uCurvature;    // how fast the viewing angle opens up away from that centre
  uniform float uFresnel;      // how sharply the sheen strengthens toward grazing angles
  uniform float uSaturation;   // 1 = literal spectrum, 0.2 = ghostly palette pearl
  uniform float uCoverage;     // how much of the frame carries any film at all
  uniform float uSoftness;     // how gradually the film's edges fade to nothing
  uniform float uOpacity;      // master alpha
  uniform float uReactivity;   // how much audio moves the bands
  uniform float uGrain;        // dither, to keep the broad washes from banding on an 8-bit display
  uniform vec3  uTintA;        // palette low  — the cool end of the pearl
  uniform vec3  uTintB;        // palette mid
  uniform vec3  uTintC;        // palette high — the warm end of the pearl

  // Wavelengths in nanometres standing in for red, green and blue. Real cone responses are broad
  // curves; three samples is the standard approximation and is what gives the familiar soap-bubble
  // sequence of magenta, gold and cyan.
  const vec3 WAVELENGTHS = vec3(610.0, 545.0, 465.0);

  // 4π, the constant in the optical path-difference phase term (two passes through the film, and a
  // full turn of phase is 2π).
  const float FOUR_PI = 12.56637061;

  void main() {
    // Guard against a zero-height drawing buffer: the stage clamps to at least one pixel, but the
    // division is written defensively so a transient 0 can never produce a NaN that poisons the
    // whole frame.
    float asp = uResolution.x / max(uResolution.y, 1.0);

    // Frame coordinates with the origin in the middle. |p.y| reaches 0.5 at the top and bottom
    // edges, so one unit of p is one frame height whatever the aspect ratio.
    vec2 p = (vUv - 0.5) * vec2(asp, 1.0);
    float t = uTime;

    // ---- 1. the thickness field ---------------------------------------------------------------
    // The film drifts as a whole. The rate is expressed in frame heights per second and the scale
    // is applied afterwards, so changing Feature Size resizes the ribbons without also changing how
    // long they take to cross the frame: about seventy seconds at Speed 1.
    vec2 drifted = p + vec2(t * 0.015, t * 0.0065 + 0.04 * sin(t * 0.019));
    vec2 q = drifted * uScale;

    // A slow warp of the sampling coordinate, with time inside the noise rather than added to the
    // result. Without this the film would only ever translate, which reads as a texture sliding
    // past; with it the ribbons genuinely reshape themselves as they go. Two cheap noise lookups
    // rather than another fractal sum, because this only needs to be smooth, not detailed.
    vec2 warp = vec2(
      vnoise(q * 0.6 + vec2(0.0, t * 0.030)),
      vnoise(q * 0.6 + vec2(5.7, -t * 0.024))
    );
    q += (warp - 0.5) * 0.9;

    // Fractal noise, then stretched so the useful middle of its range fills 0..1. Raw fractal noise
    // clusters tightly around its mean, and mapping that straight onto a thickness range would give
    // one flat wash instead of ribbons.
    float shaped = remap(fbmRot(q), 0.30, 0.72, 0.0, 1.0);

    // A real film hanging vertically drains: gravity pulls liquid down, so it is thinnest at the
    // top. That single linear term is what turns an even mottle into a horizontal hierarchy, with
    // the low-order colours and the white pinch collected along one edge.
    float along = clamp(0.5 + dot(p, uDrainDir), 0.0, 1.0);
    float film = clamp(shaped * mix(1.0, 1.0 - along, uDrainAmount), 0.0, 1.0);

    // Audio swells the whole film rather than adding brightness. Because the band positions are a
    // function of thickness, a swell slides every band at once — the film reads as breathing. The
    // fast envelope subtracts, thinning the film for a moment, which flashes the pearlescent pinch.
    float swell = 1.0 + uReactivity * (uAudio.y * 0.30 - uAudio.w * 0.22);
    float d = mix(uThicknessMin, uThicknessMax, film) * max(swell, 0.05);

    // ---- 2. viewing geometry ------------------------------------------------------------------
    // Bands on a real film bow because the angle you view it at changes across its surface. The
    // angle is modelled as opening up with distance from a chosen centre, which is why placing that
    // centre on a face makes the bands curve around the subject.
    vec2 viewCentre = (uViewCentre - 0.5) * vec2(asp, 1.0);
    float sinOut = clamp(length(p - viewCentre) * uCurvature, 0.0, 0.985);
    float cosOut = sqrt(1.0 - sinOut * sinOut);

    // Snell's law: light bends as it enters the film, so the path inside is at a shallower angle
    // than the path outside. This is the second place the refractive index earns its parameter —
    // it sets both how much the light slows down and how much it bends.
    float sinIn = sinOut / max(uIndex, 1.0);
    float cosIn = sqrt(max(1.0 - sinIn * sinIn, 0.0));

    // ---- 3. interference ----------------------------------------------------------------------
    // How far out of step the two reflections are, per wavelength. Everything above exists to
    // produce this one number.
    float pathPhase = FOUR_PI * uIndex * d * cosIn;
    vec3 phase = pathPhase / WAVELENGTHS;

    // Band filtering, described at length in the header. fwidth reports the phase change across one
    // screen pixel; the Gaussian pushes the cosine toward its own average wherever a whole band now
    // fits inside a pixel, so a region too fine to resolve becomes an even wash instead of moiré.
    vec3 pixelPhase = fwidth(phase);
    vec3 damp = exp(-0.125 * pixelPhase * pixelPhase);

    // The minus sign is the half-turn picked up reflecting off the front surface: it is why a film
    // thinner than a wavelength goes black rather than white.
    vec3 refl = clamp(0.5 - 0.5 * cos(phase) * damp, 0.0, 1.0);

    // Grazing angles reflect far more strongly than head-on ones, which is why an oil slick glows
    // brightest at its rim and why a bubble's colour concentrates around its silhouette.
    float fres = pow(1.0 - cosOut, uFresnel);

    // ---- 4. colour --------------------------------------------------------------------------
    // The pearl: rather than emitting the interference triple as literal RGB, use the red-versus-
    // blue balance to pick a position along the chosen palette. The bands stay exactly where the
    // physics put them; only their hue is borrowed.
    float hueT = clamp(0.5 + 0.9 * (refl.r - refl.b), 0.0, 1.0);
    vec3 pearl = mix(uTintA, uTintB, smoothstep(0.0, 0.58, hueT));
    pearl = mix(pearl, uTintC, smoothstep(0.55, 1.0, hueT));

    // Keep the band structure legible in pearl mode by carrying the interference brightness over.
    float lum = dot(refl, vec3(0.299, 0.587, 0.114));
    pearl *= 0.45 + 1.05 * lum;

    // Reflectance is linear light; a palette colour is gamma-encoded. Convert, mix, convert back.
    vec3 col = toSrgb(mix(toLinear(pearl), refl, clamp(uSaturation, 0.0, 1.0)));

    col *= 0.82 + 0.55 * fres;

    // The pinch. Where all three wavelengths are bright at once — which happens at the low orders,
    // meaning the thin edge of the film — a real soap film shows silvery white. Raising the product
    // to a power keeps it to the narrow ridge where the bands genuinely converge.
    float align = refl.r * refl.g * refl.b;
    col += vec3(1.0, 0.97, 0.94) * pow(align, 2.4) * (0.45 + 0.7 * fres);

    // Fine dither. Large areas of one slowly changing colour band visibly on an 8-bit display, and
    // a video encoder then makes those steps worse; a little noise breaks them up.
    col += (hash12(vUv * uResolution + fract(t) * 143.0) - 0.5) * uGrain;

    // ---- 5. coverage ------------------------------------------------------------------------
    // The film masks itself by its own thickness: below the coverage threshold there is simply no
    // film, so the scene behind shows through untouched. That is what makes the sheen arrive and
    // leave rather than sit permanently over the whole frame.
    //
    // The threshold sweeps a softness-width past *both* ends of the 0..1 thickness range so that
    // the control reaches its own extremes. A plain 1.0 - uCoverage does not: the fade is one
    // softness wide on each side of the threshold, so at Coverage 0 the threshold lands on 1.0 and
    // the thickest pixels still sit inside the upper half of that fade — a permanent half-lit haze
    // at the one setting an operator reaches for to turn the sheen off. Sweeping the threshold from
    // 1 + softness down to -softness puts every pixel below the fade at Coverage 0 and above it at
    // Coverage 1, and leaves the shipped default looking as it did (threshold 0.43 against 0.45).
    float threshold = mix(1.0 + uSoftness, -uSoftness, uCoverage);
    float mask = smoothstep(threshold - uSoftness, threshold + uSoftness, film);
    float alpha = clamp(mask * uOpacity * (0.8 + 0.55 * fres), 0.0, 1.0);

    // Premultiplied output — see shaderQuad.ts for why the material blends this way.
    gl_FragColor = vec4(clamp(col, 0.0, 1.0) * alpha, alpha);
  }
`,
);

const iridescentFilm = defineEffect({
  descriptor: {
    id: "iridescent-film",
    name: "Iridescent Film",
    description:
      "A soap film drifting across the frame, its colours cycling through magenta, gold and cyan exactly where it is thinnest — real thin-film interference, not a hue rotation, at an opacity low enough to finish a scene rather than cover it.",
    engine: "three",
    category: "overlay",
    tags: ["overlay", "iridescent", "interference", "sheen", "finishing", "shader", "reactive"],
    previewNotes:
      "Transparent by design: at the shipped Opacity of 0.18 roughly half the frame is untouched, so put it on the very top of the stack over an entire scene the way a colourist adds a filter. It is at its best over a webcam with the View Centre placed on the face, which makes the bands bow around the subject. Raise Opacity and Saturation together for a deliberate oil-slick look; leave both low for a sheen most viewers will feel rather than notice.",
    params: [
      SPEED_PARAM,
      paletteParam(
        "palette",
        "Palette",
        "vapor",
        "Biases the interference toward a two- or three-hue pearl instead of a literal spectrum. This is what keeps the effect out of holographic-sticker territory; it only matters below Saturation 1.",
      ),
      {
        key: "thicknessMin",
        label: "Thinnest (nm)",
        kind: "number",
        default: 300,
        min: 100,
        max: 800,
        step: 10,
        description:
          "How thin the film gets, in nanometres. Low values put you in the first order of colours, which are the wide, clean magenta-and-gold washes; higher values start in the busier upper orders.",
      },
      {
        key: "thicknessMax",
        label: "Thickest (nm)",
        kind: "number",
        default: 760,
        min: 200,
        max: 2000,
        step: 10,
        description:
          "How thick the film gets. A narrow range between this and Thinnest gives a few broad washes; a wide one packs in many thin bands and starts to look like a rainbow filter.",
      },
      {
        key: "refractiveIndex",
        label: "Refractive Index",
        kind: "number",
        default: 1.33,
        min: 1.2,
        max: 1.8,
        step: 0.01,
        description:
          "How much the film slows and bends light. Soapy water is about 1.33, oil about 1.5. Higher values pack the colour bands closer together and bow them more.",
      },
      {
        key: "scale",
        label: "Feature Size",
        kind: "number",
        default: 1.6,
        min: 0.3,
        max: 6,
        step: 0.05,
        description:
          "How large the thickness features are. Low values give a few sheets spanning the whole frame; high values give a fine mottle. Drift speed is unaffected.",
      },
      {
        key: "drainAmount",
        label: "Drain",
        kind: "number",
        default: 0.35,
        min: 0,
        max: 1,
        step: 0.02,
        description:
          "How strongly the film thins along the drain direction, the way gravity thins a real hanging film. Above 0 the ribbons sort themselves into a hierarchy instead of an even mottle.",
      },
      {
        key: "drainAngle",
        label: "Drain Direction",
        kind: "number",
        default: 90,
        min: 0,
        max: 360,
        step: 1,
        description:
          "Which way the film thins, in degrees. 90 is straight up, which is what a film hanging in gravity does. Ignored when Drain is 0.",
      },
      {
        key: "viewCentreX",
        label: "View Centre X",
        kind: "number",
        default: 0.5,
        min: 0,
        max: 1,
        step: 0.01,
        description:
          "Horizontal point the bands bow around, from 0 at the left edge to 1 at the right. Put it on the subject's face.",
      },
      {
        key: "viewCentreY",
        label: "View Centre Y",
        kind: "number",
        default: 0.45,
        min: 0,
        max: 1,
        step: 0.01,
        description:
          "Vertical point the bands bow around, from 0 at the bottom edge to 1 at the top.",
      },
      {
        key: "curvature",
        label: "Band Curvature",
        kind: "number",
        default: 0.9,
        min: 0,
        max: 2,
        step: 0.02,
        description:
          "How strongly the bands bow away from the view centre. 0 lays them flat, as if the film were seen dead-on everywhere; higher values wrap them around the centre and brighten the frame's edges.",
      },
      {
        key: "fresnelPower",
        label: "Grazing Sheen",
        kind: "number",
        default: 2.5,
        min: 1,
        max: 6,
        step: 0.1,
        description:
          "How sharply the sheen strengthens toward the edges of the frame, which is what makes an oil slick glow at its rim. Low values spread it evenly; high values keep it to a thin outer glow.",
      },
      {
        key: "saturation",
        label: "Saturation",
        kind: "number",
        default: 0.35,
        min: 0,
        max: 1,
        step: 0.02,
        description:
          "Blends between the palette's pearl at 0 and the literal spectrum at 1. Anything above about 0.6 starts to read as a holographic filter rather than a film.",
      },
      {
        key: "coverage",
        label: "Coverage",
        kind: "number",
        default: 0.55,
        min: 0,
        max: 1,
        step: 0.01,
        description:
          "How much of the frame carries any film at all. At the default roughly half the picture is untouched at any moment, so the sheen drifts in and out rather than sitting there.",
      },
      {
        key: "softness",
        label: "Edge Softness",
        kind: "number",
        default: 0.18,
        min: 0.01,
        max: 0.5,
        step: 0.01,
        description:
          "How gradually the film fades out where it ends. Low values give a torn, papery edge; high values let it dissolve into nothing.",
      },
      {
        key: "opacity",
        label: "Opacity",
        kind: "number",
        default: 0.18,
        min: 0,
        max: 0.6,
        step: 0.01,
        description:
          "Master transparency, capped low on purpose: this is a finishing pass over a whole scene, and the difference between a colourist's filter and a novelty overlay lives entirely in this slider.",
      },
      {
        key: "reactivity",
        label: "Audio Response",
        kind: "number",
        default: 0.25,
        min: 0,
        max: 1,
        step: 0.05,
        description:
          "How much the OBS audio level moves the film. It swells the thickness, which slides every colour band at once, and transients thin it briefly so the white pinch flashes. 0 disconnects the audio; the film still drifts on its own.",
      },
      {
        key: "grain",
        label: "Grain",
        kind: "number",
        default: 0.015,
        min: 0,
        max: 0.05,
        step: 0.005,
        description:
          "Fine dither over the broad washes. A little stops large flat areas from showing stepped bands on an 8-bit display, which a video encoder would otherwise exaggerate.",
      },
    ],
  },
  setup: shaderQuadSetup({
    fragment: FRAGMENT_SHADER,
    reactive: true,
    uniforms: (p) => {
      // Three fixed samples off the chosen ramp. The shader picks between them by the interference's
      // own red-versus-blue balance, so this is a bias applied to real physics rather than a
      // gradient painted over the top. Uniform arrays are not part of the shader-quad reader
      // contract, and three stops are all this pearl needs.
      const ramp = palette(p, "palette", "vapor");
      const [ar, ag, ab] = paletteAt01(ramp, 0.3);
      const [br, bg, bb] = paletteAt01(ramp, 0.62);
      const [cr, cg, cb] = paletteAt01(ramp, 0.95);

      // The drain direction arrives as an angle because that is what an operator can reason about;
      // the shader wants a unit vector. 90 degrees points straight up the frame, matching the way a
      // real film hanging in gravity thins at the top.
      const drainRadians = (num(p, "drainAngle", 90, 0, 360) * Math.PI) / 180;

      // Thinnest and Thickest are two independent sliders whose ranges overlap (100..800 and
      // 200..2000), so an operator can legitimately drag Thinnest above Thickest. Sorting the pair
      // here keeps "thin" meaning thin: the shader treats the low end of the thickness range as the
      // film's thin edge, and the drain term thins the film along one edge on that assumption. Left
      // unsorted, an inverted pair silently turns Drain into a *thickening* control and moves the
      // pearlescent pinch to the opposite side of the frame.
      const thicknessA = num(p, "thicknessMin", 300, 100, 800);
      const thicknessB = num(p, "thicknessMax", 760, 200, 2000);

      return {
        uThicknessMin: Math.min(thicknessA, thicknessB),
        uThicknessMax: Math.max(thicknessA, thicknessB),
        uIndex: num(p, "refractiveIndex", 1.33, 1.2, 1.8),
        uScale: num(p, "scale", 1.6, 0.3, 6),
        uDrainAmount: num(p, "drainAmount", 0.35, 0, 1),
        uDrainDir: new THREE.Vector2(Math.cos(drainRadians), Math.sin(drainRadians)),
        uViewCentre: new THREE.Vector2(
          num(p, "viewCentreX", 0.5, 0, 1),
          num(p, "viewCentreY", 0.45, 0, 1),
        ),
        uCurvature: num(p, "curvature", 0.9, 0, 2),
        uFresnel: num(p, "fresnelPower", 2.5, 1, 6),
        uSaturation: num(p, "saturation", 0.35, 0, 1),
        uCoverage: num(p, "coverage", 0.55, 0, 1),
        uSoftness: num(p, "softness", 0.18, 0.01, 0.5),
        uOpacity: num(p, "opacity", 0.18, 0, 0.6),
        uReactivity: num(p, "reactivity", 0.25, 0, 1),
        uGrain: num(p, "grain", 0.015, 0, 0.05),
        uTintA: new THREE.Vector3(ar, ag, ab),
        uTintB: new THREE.Vector3(br, bg, bb),
        uTintC: new THREE.Vector3(cr, cg, cb),
      };
    },
  }),
});

export default iridescentFilm;
