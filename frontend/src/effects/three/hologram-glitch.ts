import { assembleFragment, defineEffect } from "../sdk";
import { num } from "../paramUtils";
import { SPEED_PARAM, shaderQuadSetup } from "./shaderQuad";

/**
 * Hologram Glitch
 * ===============
 *
 * A projected hologram that will not hold still: an RGB sub-pixel grid, drifting scanlines at
 * several densities, horizontal bands that tear sideways, chromatic aberration and block corruption.
 *
 * Ported from `hologram-glitch.html` in the old `obs-effects` repository, where it was a hand-written
 * WebGL page rather than a Pixi or Three screen. The shader's arithmetic is carried over unchanged.
 *
 * Why it reads as a hologram rather than as a screen
 * --------------------------------------------------
 * Two details do most of the work, and both are easy to leave out.
 *
 * The first is the **RGB sub-pixel grid**: rather than tinting the whole image, the shader lights
 * separate red, green and blue cells and adds a highlight where all three align. That is how a real
 * emissive panel is built, and the eye recognises it immediately.
 *
 * The second is that the scanlines run at **several pitches at once**, drifting at different speeds.
 * One pitch reads as a texture laid over the picture; three interfere with each other and read as
 * something being *scanned out* line by line.
 *
 * Two things were deliberately dropped
 * ------------------------------------
 * **The mouse epicentre.** The original amplified the glitch near the cursor. There is no cursor over
 * an OBS browser source, so the uniform and the two places it scaled are gone rather than left
 * permanently at zero.
 *
 * **`gl_FragCoord`.** The original addressed pixels directly. Here the same values are reconstructed
 * from the quad's surface coordinate, which keeps the scanline pitch tied to the drawing buffer if it
 * is ever scaled relative to the canvas.
 */
const FRAGMENT_SHADER = assembleFragment(
  [],
  /* glsl */ `
  varying vec2 vUv;

  uniform float uTime;
  uniform vec2 uResolution;
  uniform float uGlitch;
  uniform float uScanSpeed;

  #define PI 3.14159265359

  // ── Hash helpers ──
  float hash(float n) {
    return fract(sin(n) * 43758.5453123);
  }

  float hash2(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  // ── Value noise ──
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash2(i), hash2(i + vec2(1.0, 0.0)), f.x),
      mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), f.x),
      f.y
    );
  }

  // ── FBM noise (4 octaves — balanced detail vs perf) ──
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    vec2 shift = vec2(100.0);
    mat2 rot = mat2(cos(0.5), sin(0.5), -sin(0.5), cos(0.5));
    for (int i = 0; i < 4; i++) {
      v += a * vnoise(p);
      p = rot * p * 2.0 + shift;
      a *= 0.5;
    }
    return v;
  }

  // ── Glitch timing — rhythmic bursts ──
  // Returns a glitch envelope that pulses in controlled bursts
  float glitchEnvelope(float t) {
    // Slow rhythm: bursts every ~3-4 seconds
    float slow = sin(t * 0.7) * sin(t * 1.1);
    // Medium rhythm: sub-pulses within bursts
    float med = sin(t * 3.3) * 0.5 + 0.5;
    // Fast crackle during bursts
    float fast = step(0.88, hash(floor(t * 12.0)));
    // Combine: active with frequent bursts
    float envelope = smoothstep(0.15, 0.5, slow) * (0.5 + 0.5 * med);
    // Add sharp spikes
    envelope += fast * 0.7;
    return clamp(envelope, 0.0, 1.0);
  }

  // ── Horizontal glitch band offset ──
  float glitchBand(float y, float t, float intensity) {
    float env = glitchEnvelope(t);
    if (env < 0.1) return 0.0;

    // Multiple glitch band layers at different scales
    float band1 = step(0.8, vnoise(vec2(y * 15.0, floor(t * 8.0)))) * 0.14;
    float band2 = step(0.85, vnoise(vec2(y * 40.0, floor(t * 15.0)))) * 0.07;
    float band3 = step(0.82, vnoise(vec2(y * 5.0, floor(t * 4.0)))) * 0.25;

    // Direction: some bands go left, some right
    float dir = sign(vnoise(vec2(y * 20.0, floor(t * 6.0))) - 0.5);

    return (band1 + band2 + band3) * dir * env * intensity;
  }

  // ── Noise burst rectangles ──
  float noiseBurst(vec2 uv, float t) {
    float env = glitchEnvelope(t + 1.5);
    if (env < 0.3) return 0.0;

    // Random rectangular region
    float blockT = floor(t * 6.0);
    float bx = hash(blockT * 7.3) * 0.8 - 0.4;
    float by = hash(blockT * 11.7) * 0.8 - 0.4;
    float bw = hash(blockT * 3.1) * 0.3 + 0.05;
    float bh = hash(blockT * 5.9) * 0.1 + 0.02;

    float inBlock = step(bx, uv.x) * step(uv.x, bx + bw) *
                    step(by, uv.y) * step(uv.y, by + bh);

    // High-frequency noise inside the block
    float n = hash2(floor(uv * 300.0) + blockT * 100.0);
    return inBlock * n * env * 1.0;
  }

  void main() {
    vec2 uv = vUv;
    vec2 centeredUV = (vUv * uResolution - uResolution * 0.5) / uResolution.y;
    float t = uTime;
    float glitchI = uGlitch;
    float scanS = uScanSpeed;

    /*
     * The original grew a glitch epicentre wherever the mouse was. An OBS browser source has no
     * cursor over it, so the uniform and this whole block are gone rather than left switched off.
     */

    // ── Layer 4: Horizontal glitch band displacement ──
    float bandOffset = glitchBand(uv.y, t, glitchI);

    // Apply band displacement to UV
    vec2 glitchedUV = uv;
    glitchedUV.x += bandOffset;

    // ── Layer 3: Chromatic aberration ──
    // Base offset pulses and occasionally jumps
    float chromBase = 0.008 + 0.006 * sin(t * 1.2);
    // Glitch spikes in chromatic aberration
    float chromSpike = glitchEnvelope(t) * 0.035 * glitchI;
    // Sharp jumps
    float chromJump = step(0.92, hash(floor(t * 5.0))) * 0.05 * glitchI;
    float chromAmount = chromBase + chromSpike + chromJump;
    // Mouse increases chromatic aberration near cursor

    // R shifts left, B shifts right
    vec2 uvR = glitchedUV + vec2(-chromAmount, 0.0);
    vec2 uvG = glitchedUV;
    vec2 uvB = glitchedUV + vec2(chromAmount, 0.0);

    // Also add slight vertical separation
    uvR.y += chromAmount * 0.5;
    uvB.y -= chromAmount * 0.5;

    // ── Layer 1: Base flowing abstract shapes ──
    // Organic holographic blobs using layered FBM noise
    float slowT = t * 0.15;

    // Sample base pattern at each channel offset
    // Pattern: morphing organic blobs
    float patR = fbm(uvR * 3.0 + vec2(slowT, slowT * 0.7));
    patR += fbm(uvR * 5.0 - vec2(slowT * 0.5, slowT * 1.2)) * 0.5;
    patR += fbm(uvR * 1.5 + vec2(slowT * 0.3, -slowT * 0.4)) * 0.7;
    patR += fbm(uvR * 10.0 + vec2(slowT * 1.5, -slowT * 0.8)) * 0.15;

    float patG = fbm(uvG * 3.0 + vec2(slowT, slowT * 0.7));
    patG += fbm(uvG * 5.0 - vec2(slowT * 0.5, slowT * 1.2)) * 0.5;
    patG += fbm(uvG * 1.5 + vec2(slowT * 0.3, -slowT * 0.4)) * 0.7;
    patG += fbm(uvG * 10.0 + vec2(slowT * 1.5, -slowT * 0.8)) * 0.15;

    float patB = fbm(uvB * 3.0 + vec2(slowT, slowT * 0.7));
    patB += fbm(uvB * 5.0 - vec2(slowT * 0.5, slowT * 1.2)) * 0.5;
    patB += fbm(uvB * 1.5 + vec2(slowT * 0.3, -slowT * 0.4)) * 0.7;
    patB += fbm(uvB * 10.0 + vec2(slowT * 1.5, -slowT * 0.8)) * 0.15;

    // Normalize patterns
    patR = patR / 2.45;
    patG = patG / 2.45;
    patB = patB / 2.45;

    // Shape the patterns into sharply defined blobs
    patR = smoothstep(0.35, 0.55, patR);
    patG = smoothstep(0.35, 0.55, patG);
    patB = smoothstep(0.35, 0.55, patB);

    // Push contrast further — darks darker, brights brighter
    patR = patR * patR * (3.0 - 2.0 * patR);
    patG = patG * patG * (3.0 - 2.0 * patG);
    patB = patB * patB * (3.0 - 2.0 * patB);

    // ── Layer 6: Holographic color shift ──
    // Cycle through cyan -> magenta -> yellow like a holographic sticker
    float hueShift = t * 0.2;
    float hue1 = sin(hueShift) * 0.5 + 0.5;
    float hue2 = sin(hueShift + 2.094) * 0.5 + 0.5;
    float hue3 = sin(hueShift + 4.189) * 0.5 + 0.5;

    // Spatial variation in hue (like light catching at different angles)
    float spatialHue = sin(centeredUV.x * 4.0 + centeredUV.y * 3.0 + t * 0.3) * 0.5 + 0.5;

    // Base holographic palette: vivid cyan/magenta/white
    vec3 col1 = vec3(0.0, 1.0, 1.2);  // electric cyan (HDR push)
    vec3 col2 = vec3(1.2, 0.1, 0.9);  // hot magenta (HDR push)
    vec3 col3 = vec3(1.2, 1.25, 1.3); // bright white (HDR push)
    vec3 col4 = vec3(1.0, 0.95, 0.2); // yellow

    // Mix palette based on time and position
    vec3 palette = mix(col1, col2, hue1 * spatialHue);
    palette = mix(palette, col3, hue2 * 0.3);
    palette = mix(palette, col4, hue3 * spatialHue * 0.4);

    // Apply palette with per-channel separation
    vec3 baseColor;
    baseColor.r = patR * palette.r;
    baseColor.g = patG * palette.g;
    baseColor.b = patB * palette.b;

    // Add bright spots where all channels align — near white highlights
    float alignment = patR * patG * patB;
    baseColor += vec3(0.9, 0.95, 1.0) * pow(alignment, 1.5) * 1.2;

    // ── Layer 2: Scanline overlay ──
    // Multiple scanline layers at different densities and speeds
    // Pixel row from the surface coordinate rather than gl_FragCoord, so the scanline
    // pitch stays tied to the drawing buffer if it is ever scaled.
    float scanY = vUv.y * uResolution.y;

    // Fine scanlines — every 2-3 pixels, sharp
    float fineScan = sin(scanY * PI * 0.8) * 0.5 + 0.5;
    fineScan = pow(fineScan, 1.5); // sharpen

    // Medium scanlines — scrolling upward, per-channel at different speeds
    float medScanR = sin((scanY + t * 60.0 * scanS) * 0.15) * 0.5 + 0.5;
    float medScanG = sin((scanY + t * 75.0 * scanS) * 0.15) * 0.5 + 0.5;
    float medScanB = sin((scanY + t * 55.0 * scanS) * 0.15) * 0.5 + 0.5;

    // Broad scan bands — slow sweep
    float broadScan = sin((scanY + t * 30.0 * scanS) * 0.03) * 0.5 + 0.5;
    broadScan = smoothstep(0.3, 0.7, broadScan);

    // Combine scanlines — deeper cuts for visible lines
    float scanR = mix(0.45, 1.0, fineScan) * mix(0.7, 1.0, medScanR) * mix(0.6, 1.0, broadScan);
    float scanG = mix(0.45, 1.0, fineScan) * mix(0.7, 1.0, medScanG) * mix(0.6, 1.0, broadScan);
    float scanB = mix(0.45, 1.0, fineScan) * mix(0.7, 1.0, medScanB) * mix(0.6, 1.0, broadScan);

    // Bright scan line — a single bright line that sweeps up periodically
    float brightScanPos = mod(t * 40.0 * scanS, uResolution.y);
    float brightScan = exp(-abs(scanY - brightScanPos) * 0.12) * 0.7;

    baseColor.r *= scanR;
    baseColor.g *= scanG;
    baseColor.b *= scanB;
    baseColor += vec3(0.3, 0.8, 1.0) * brightScan;

    // ── Layer 5: Interlace flicker ──
    float interlace = mod(scanY + floor(t * 30.0), 2.0);
    float interlaceFlicker = mix(0.78, 1.0, interlace);
    // Occasional full-line flicker
    float lineFlicker = 1.0 - step(0.95, hash(floor(scanY * 0.5) + floor(t * 20.0) * 100.0)) * 0.5;
    baseColor *= interlaceFlicker * lineFlicker;

    // ── Layer 7: Noise burst artifacts ──
    float burst = noiseBurst(centeredUV, t);
    vec3 burstColor = vec3(0.5, 0.9, 1.0) * burst;
    baseColor += burstColor * glitchI;

    // ── Layer 8: Edge glow ──
    // Where holographic "volume" meets dark background
    // Use the gradient of the base pattern as edge detection
    float patCenter = fbm(glitchedUV * 3.0 + vec2(slowT, slowT * 0.7));
    float patDx = fbm((glitchedUV + vec2(0.005, 0.0)) * 3.0 + vec2(slowT, slowT * 0.7));
    float patDy = fbm((glitchedUV + vec2(0.0, 0.005)) * 3.0 + vec2(slowT, slowT * 0.7));
    float edgeStrength = length(vec2(patDx - patCenter, patDy - patCenter)) * 20.0;
    edgeStrength = smoothstep(0.2, 0.8, edgeStrength);
    vec3 edgeColor = mix(vec3(0.2, 0.9, 1.2), vec3(1.2, 0.3, 1.0), spatialHue) * edgeStrength * 0.6;
    baseColor += edgeColor;

    // ── Holographic shimmer — position-dependent brightness ──
    float shimmer = sin(centeredUV.x * 20.0 + centeredUV.y * 15.0 + t * 2.0) * 0.15 + 0.85;
    shimmer *= sin(centeredUV.x * 8.0 - centeredUV.y * 12.0 + t * 1.3) * 0.1 + 0.9;
    baseColor *= shimmer;

    // ── Overall intensity modulation — moments of clarity ──
    float clarity = sin(t * 0.4) * 0.15 + 0.85;
    baseColor *= clarity;

    // ── Layer 9: Vignette — pull corners to deep blue-black ──
    float vDist = length(centeredUV * vec2(1.0, 0.85));
    float vignette = 1.0 - smoothstep(0.45, 1.1, vDist);
    vec3 vignetteColor = vec3(0.02, 0.03, 0.06);
    baseColor = mix(vignetteColor, baseColor, vignette);

    // ── Film grain for texture ──
    float grain = (hash2(vUv * uResolution + fract(t * 43.0) * 1000.0) - 0.5) * 0.06;
    baseColor += grain;

    // ── Tone mapping — S-curve with strong contrast ──
    baseColor = baseColor / (baseColor + vec3(0.65));
    baseColor = pow(baseColor, vec3(0.95));

    baseColor = max(baseColor, vec3(0.0));

    gl_FragColor = vec4(baseColor, 1.0);
  }
`,
);

const hologramGlitch = defineEffect({
  descriptor: {
    id: "hologram-glitch",
    name: "Hologram Glitch",
    description:
      "A projected hologram that will not hold still \u2014 RGB sub-pixel grid, drifting scanlines at several pitches, tearing bands and chromatic aberration.",
    engine: "three",
    category: "background",
    tags: ["glitch", "hologram", "scanlines", "shader", "sci-fi", "rgb"],
    previewNotes:
      "Fills the frame and is opaque, so use it as a background or a stinger rather than an overlay. Glitch Intensity at 0 leaves a clean hologram panel; turn it up for a failing projection.",
    params: [
      SPEED_PARAM,
      {
        key: "glitch",
        label: "Glitch Intensity",
        kind: "number",
        default: 1,
        min: 0,
        max: 3,
        step: 0.05,
        description:
          "How violently the image tears and splits. 0 leaves a clean, stable hologram; 3 is barely holding together.",
      },
      {
        key: "scanSpeed",
        label: "Scanline Speed",
        kind: "number",
        default: 1,
        min: 0,
        max: 5,
        step: 0.05,
        description:
          "How fast the scanlines drift down the frame. 0 freezes them into a static grid, which reads as a panel rather than a projection.",
      },
    ],
  },
  setup: shaderQuadSetup({
    fragment: FRAGMENT_SHADER,
    uniforms: (p) => ({
      uGlitch: num(p, "glitch", 1, 0, 3),
      uScanSpeed: num(p, "scanSpeed", 1, 0, 5),
    }),
  }),
});

export default hologramGlitch;
