import * as THREE from "three";

import { num } from "../paramUtils";
import { assembleFragment, defineEffect, palette, paletteAt01, paletteParam } from "../sdk";
import { SPEED_PARAM, shaderQuadSetup } from "./shaderQuad";

/**
 * Fluid Ring Cam
 * ==============
 *
 * A circular camera frame whose border behaves like a bead of liquid: an organic ring that
 * continuously deforms, with a colour gradient that flows around the circumference and small
 * droplets that pinch off the rim, orbit for a moment and merge back in. Everything inside and
 * outside the ring is fully transparent, so it sits over a circular webcam crop in OBS with the
 * camera showing through the middle.
 *
 * This is an original effect, not a port. It shares only its *placement* with
 * `razer-cam-border-fluid` — both draw a liquid circle where a round camera crop goes — and is
 * deliberately different in construction and look:
 *
 *  - **It is a metaball field, not two masked radii.** The ring and every droplet each deposit a
 *    Gaussian blob of "liquid density" into one scalar field, and the visible surface is a
 *    threshold on that field. That is what makes a droplet *merge*: as it drifts back toward the
 *    rim the two density bumps overlap, the threshold contour necks between them, and they fuse
 *    the way real liquid does. Two independent masks can only overlap, never neck.
 *  - **The deformation is gradient noise on the circle, not summed sinusoids.** The rim radius is
 *    displaced by `simplex3` sampled at `(cos a, sin a)` — sampling on the circle itself is what
 *    keeps the displacement seamless where the angle wraps — with time as the third axis, so the
 *    silhouette never repeats and never shows a seam.
 *  - **The palette flows along the circumference.** Colour is picked from a three-stop ramp by a
 *    coordinate that slides around the ring over time, so gradients visibly *travel* along the
 *    liquid instead of being painted on it. Default palette is Neon Dusk (cyan → violet → pink),
 *    nowhere near the Razer green family.
 *
 * Audio is a modifier, never the driver: with the gain at 0 (or with no OBS connection, where the
 * bus feeds a simulated signal) the ring still flows on its own clock, and loudness only adds a
 * gentle swell to thickness and glow on top of that idle motion.
 */
const FRAGMENT_SHADER = assembleFragment(
  ["simplex3"],
  /* glsl */ `
  varying vec2 vUv;

  uniform float uTime;
  uniform vec2 uResolution;
  uniform vec4 uAudio; // level, slow, mid, fast — envelopes at three speeds, not frequency bands

  uniform float uRadius;     // ring centreline, as a fraction of the half-height (0..1)
  uniform float uThickness;  // half-width of the liquid band, same units as uRadius
  uniform float uTurbulence; // 0 = a clean circle, 1 = default wobble, 2 = heavy churn
  uniform float uFlowSpeed;  // how fast the colour gradient travels around the ring
  uniform float uGlow;       // strength of the soft halo outside the liquid surface
  uniform float uAudioGain;  // 0 silences the audio's influence entirely
  uniform vec3 uColDeep;     // palette start — the body of the liquid
  uniform vec3 uColMid;      // palette middle — the travelling gradient
  uniform vec3 uColCrest;    // palette end — rim highlight and droplets

  const float TAU = 6.28318530718;

  // Rim displacement, sampled ON the unit circle so the value at angle 0 and angle 2π is the
  // same sample — no seam. Two octaves at different scales: one for the slow large swell, one
  // for finer surface ripple. Time is the third noise axis, so the shape evolves rather than
  // rotates.
  float rimWobble(float a, float t) {
    vec2 c = vec2(cos(a), sin(a));
    float big = simplex3(vec3(c * 1.4, t * 0.21));
    float fine = simplex3(vec3(c * 3.7 + 11.3, t * 0.34));
    return big * 0.7 + fine * 0.3;
  }

  void main() {
    float asp = uResolution.x / uResolution.y;
    // Centre the frame; |p| = 0.5 at the top and bottom edges, which is what the radius
    // parameter is expressed against (uRadius is a fraction of that half-height).
    vec2 p = (vUv - 0.5) * vec2(asp, 1.0);
    float t = uTime;

    float level = clamp(uAudio.x * uAudioGain, 0.0, 1.5);
    float slow = clamp(uAudio.y * uAudioGain, 0.0, 1.5);

    float R = uRadius * 0.5;
    // Audio widens the band slightly; turbulence scales the wobble against the thickness so the
    // slider stays meaningful at any ring size.
    float halfW = uThickness * 0.5 * (1.0 + level * 0.35);
    float wobbleAmp = uTurbulence * halfW * (0.9 + slow * 0.6);

    float r = length(p);
    float a = atan(p.y, p.x);

    // ---- the liquid density field -------------------------------------------------------------
    // The ring deposits a Gaussian band around its (wobbled) centreline. Density 1 on the
    // centreline falling off with radial distance; the threshold below cuts the visible surface.
    float rim = R + wobbleAmp * rimWobble(a, t);
    float dRing = r - rim;
    float field = exp(-(dRing * dRing) / max(halfW * halfW, 1e-6));

    // Droplets: eight blobs on eccentric orbits just outside the rim. Each spends part of its
    // cycle overlapping the ring's density (fused with it) and part clear of it (a separate
    // drop), so separation and rejoining fall out of the field threshold with no state at all.
    for (int i = 0; i < 8; i++) {
      float fi = float(i);
      // Golden-angle spacing keeps the drops from ever lining up into a visible pattern.
      float da = fi * 2.39996 + t * (0.11 + 0.013 * fi);
      // Orbit radius breathes in and out across the rim; turbulence pushes drops further out.
      float wander = sin(t * 0.5 + fi * 1.7) * (0.55 + 0.45 * sin(t * 0.23 + fi * 3.1));
      float dr = R + (halfW * 1.6 + wobbleAmp * 1.2) * wander;
      float ds = halfW * (0.38 + 0.22 * sin(t * 0.9 + fi * 2.3) + level * 0.25);
      vec2 dp = dr * vec2(cos(da), sin(da));
      vec2 dv = p - dp;
      field += 0.8 * exp(-dot(dv, dv) / max(ds * ds, 1e-6));
    }

    // The visible surface is a soft threshold on the density. Width scales with the pixel size
    // of the band so the edge stays about one pixel soft at any resolution or ring size.
    float edge = clamp(1.5 / (max(halfW, 1e-4) * uResolution.y), 0.02, 0.25);
    float body = smoothstep(0.42 - edge, 0.42 + edge, field);

    // ---- colour -------------------------------------------------------------------------------
    // A gradient coordinate that travels around the circumference and is stirred by the same
    // noise that shapes the rim, so colour bands bend with the liquid instead of crossing it.
    float flow = fract(a / TAU + t * uFlowSpeed * 0.05 + rimWobble(a + 2.1, t * 0.6) * 0.12);
    // Fold 0..1 into 0..1..0 so the ramp is continuous where the angle wraps.
    float ramp = 1.0 - abs(flow * 2.0 - 1.0);

    vec3 col = mix(uColDeep, uColMid, smoothstep(0.0, 0.65, ramp));
    col = mix(col, uColCrest, smoothstep(0.65, 1.0, ramp) * 0.85);

    // Highlight where the density is near the threshold — the "surface tension" skin of the
    // liquid — brightest on the outer side, which is where a light would catch a real bead.
    float skin = smoothstep(0.42, 0.55, field) * (1.0 - smoothstep(0.55, 0.95, field));
    col = mix(col, uColCrest, skin * (0.35 + level * 0.3) * step(0.0, dRing));

    // Deepen the core of the band a little so it reads as volume rather than a flat sticker.
    col *= 0.82 + 0.18 * (1.0 - smoothstep(0.7, 1.4, field));

    // ---- halo ---------------------------------------------------------------------------------
    // A soft additive glow hugging the outside of the surface. It uses the field itself (below
    // the threshold), so the halo follows droplets too, and it never bleeds into the camera hole:
    // inside the rim it is cut so the crop area stays clean.
    float outside = step(0.0, dRing);
    float halo = smoothstep(0.05, 0.42, field) * (1.0 - body) * outside;
    float glowAmt = uGlow * (0.6 + slow * 0.5);

    float alpha = clamp(body + halo * glowAmt * 0.55, 0.0, 1.0);
    vec3 rgb = col * body + uColMid * halo * glowAmt * 0.55;

    // Premultiplied output — see shaderQuad.ts for why the material blends this way.
    gl_FragColor = vec4(rgb, alpha);
  }
`,
);

const fluidRingCam = defineEffect({
  descriptor: {
    id: "fluid-ring-cam",
    name: "Fluid Ring Cam",
    description:
      "A circular camera frame that behaves like a bead of liquid — an organic, flowing ring with travelling colour gradients and droplets that pinch off and merge back in.",
    engine: "three",
    category: "overlay",
    tags: ["overlay", "border", "camera", "fluid", "metaball", "ring", "reactive"],
    previewNotes:
      "Transparent inside and outside the ring: place it over a circular webcam crop so the camera shows through the middle. Audio only adds a subtle swell — set Audio Swell to 0 for a purely ambient ring.",
    params: [
      {
        key: "radius",
        label: "Ring Radius",
        kind: "number",
        default: 0.62,
        min: 0.1,
        max: 0.95,
        step: 0.01,
        description:
          "Where the ring sits, as a fraction of the frame's half-height. 1.0 would touch the top and bottom edges; leave headroom for the wobble and droplets.",
      },
      {
        key: "thickness",
        label: "Band Thickness",
        kind: "number",
        default: 0.09,
        min: 0.02,
        max: 0.3,
        step: 0.005,
        description:
          "How wide the liquid band is, in the same units as the radius. Droplet size scales with it.",
      },
      {
        key: "turbulence",
        label: "Turbulence",
        kind: "number",
        default: 1,
        min: 0,
        max: 2,
        step: 0.05,
        description:
          "How much the rim deforms. 0 is a clean circle with orbiting droplets; 2 is a heavy churn where the ring barely holds its shape.",
      },
      {
        key: "flowSpeed",
        label: "Colour Flow",
        kind: "number",
        default: 1,
        min: 0,
        max: 4,
        step: 0.05,
        description:
          "How fast the colour gradient travels around the ring. 0 pins the gradient in place while the liquid keeps moving.",
      },
      paletteParam(
        "palette",
        "Palette",
        "neon-dusk",
        "Colour ramp for the liquid: the first stop is the body, the middle stops travel around the ring, the last is the rim highlight and droplets.",
      ),
      {
        key: "glow",
        label: "Glow",
        kind: "number",
        default: 0.6,
        min: 0,
        max: 2,
        step: 0.05,
        description:
          "Strength of the soft halo outside the liquid surface. It follows the droplets too, and never bleeds into the camera hole.",
      },
      {
        key: "audioGain",
        label: "Audio Swell",
        kind: "number",
        default: 0.6,
        min: 0,
        max: 2,
        step: 0.05,
        description:
          "How much the OBS audio level swells the band, wobble and glow. 0 disconnects the audio entirely; the ring still flows on its own.",
      },
      SPEED_PARAM,
    ],
  },
  setup: shaderQuadSetup({
    fragment: FRAGMENT_SHADER,
    reactive: true,
    uniforms: (p) => {
      // Three fixed samples off the selected ramp: body, travelling mid, rim crest. Sampled here
      // rather than in the shader because uniform arrays are not part of the reader contract, and
      // three stops are all this gradient design uses.
      const ramp = palette(p, "palette", "neon-dusk");
      const [dr, dg, db] = paletteAt01(ramp, 0.15);
      const [mr, mg, mb] = paletteAt01(ramp, 0.55);
      const [cr, cg, cb] = paletteAt01(ramp, 0.95);
      return {
        uRadius: num(p, "radius", 0.62, 0.1, 0.95),
        uThickness: num(p, "thickness", 0.09, 0.02, 0.3),
        uTurbulence: num(p, "turbulence", 1, 0, 2),
        uFlowSpeed: num(p, "flowSpeed", 1, 0, 4),
        uGlow: num(p, "glow", 0.6, 0, 2),
        uAudioGain: num(p, "audioGain", 0.6, 0, 2),
        uColDeep: new THREE.Vector3(dr, dg, db),
        uColMid: new THREE.Vector3(mr, mg, mb),
        uColCrest: new THREE.Vector3(cr, cg, cb),
      };
    },
  }),
});

export default fluidRingCam;
