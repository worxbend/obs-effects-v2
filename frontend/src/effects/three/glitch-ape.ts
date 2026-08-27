import { assembleFragment, defineEffect } from "../sdk";
import { SPEED_PARAM, shaderQuadSetup } from "./shaderQuad";

/**
 * Glitch Ape
 * ==========
 *
 * A gorilla face rendered entirely in mathematics — no image, no model, no texture — being torn
 * apart by chromatic aberration, scanline displacement and channel splitting.
 *
 * Ported from `glitch-ape.html` in the old `obs-effects` repository.
 *
 * The whole face is signed distance fields
 * ----------------------------------------
 * There is no artwork anywhere in this effect. `gorillaMask` describes the head as an ellipse that
 * narrows towards the chin, then carves the brow, muzzle, nostrils and eyes out of it with more
 * ellipses and boxes, each one a *signed distance field*: a function that returns how far the
 * current pixel is from a shape's edge, negative inside it. Combining those distances with `min`,
 * `max` and `smoothstep` is how the face is assembled, and it is why it stays perfectly sharp at any
 * resolution and why every part of it can be displaced independently by the glitch.
 *
 * A drawn image could not do the second part: tearing a bitmap gives you torn pixels, whereas
 * tearing the *coordinate* before the shape is evaluated gives you a face that is genuinely somewhere
 * else for those scanlines.
 *
 * It brings its own noise
 * -----------------------
 * This shader declares `hash1` and `hash2` itself, so no chunks are pulled in from the SDK's GLSL
 * library — including one would collide with these definitions. They are left exactly as the
 * original wrote them, because the pattern of the tearing depends on them.
 */
const FRAGMENT_SHADER = assembleFragment(
  [],
  /* glsl */ `
  varying vec2 vUv;
  uniform float uTime;
  uniform vec2 uResolution;

  // ── Utilities ─────────────────────────────────────────────────────────────
  float hash1(float n){ return fract(sin(n)*43758.5453); }
  float hash2(vec2 p){ vec3 q=fract(vec3(p.xyx)*0.1031); q+=dot(q,q.yzx+33.33); return fract((q.x+q.y)*q.z); }

  vec3 hsv2rgb(vec3 c){
    vec4 K=vec4(1.,2./3.,1./3.,3.);
    vec3 p=abs(fract(c.xxx+K.xyz)*6.-K.www);
    return c.z*mix(K.xxx,clamp(p-K.xxx,0.,1.),c.y);
  }

  float sdBox(vec2 p, vec2 b){ vec2 d=abs(p)-b; return length(max(d,0.))+min(max(d.x,d.y),0.); }

  // Ellipse SDF (approximate, good enough)
  float sdEll(vec2 p, vec2 r){ return length(p/r)-1.0; }

  // ── Gorilla face mask ──────────────────────────────────────────────────────
  // fp is in face-space: center=origin, ±1 = half face height
  // Returns: 0=background, 0..0.3=dark void/shadow, 0.6..1=bright face plate
  float gorillaMask(vec2 fp){
    // Head oval (wider at brow, narrows toward chin)
    float headW = 0.72 - fp.y * 0.10; // slightly narrower at chin
    float head = sdEll(fp, vec2(clamp(headW,0.50,0.73), 0.98));
    if(head > 0.06) return 0.0; // outside head → pure background
    float inHead = smoothstep(0.06,-0.01,head);

    // ── WHITE FACE PLATE REGIONS ────────────────────────────────────────────

    // Hair / crown spikes (topmost)
    float hair = smoothstep(0.03,-0.02, sdBox(fp-vec2(0,-0.80),vec2(0.36,0.16)));
    hair = max(hair, smoothstep(0.02,-0.01, sdBox(fp-vec2(-0.20,-0.73),vec2(0.09,0.07))));
    hair = max(hair, smoothstep(0.02,-0.01, sdBox(fp-vec2( 0.20,-0.73),vec2(0.09,0.07))));
    hair = max(hair, smoothstep(0.02,-0.01, sdBox(fp-vec2(-0.05,-0.90),vec2(0.04,0.05))));
    hair = max(hair, smoothstep(0.02,-0.01, sdBox(fp-vec2( 0.10,-0.88),vec2(0.03,0.04))));

    // Forehead
    float forehead = smoothstep(0.03,-0.02, sdBox(fp-vec2(0,-0.56),vec2(0.40,0.21)));

    // Brow ridge — the most iconic gorilla feature
    float brow = smoothstep(0.03,-0.02, sdBox(fp-vec2(0,-0.32),vec2(0.57,0.10)));
    // Left brow extension
    brow = max(brow, smoothstep(0.02,-0.01, sdBox(fp-vec2(-0.52,-0.26),vec2(0.08,0.06))));
    brow = max(brow, smoothstep(0.02,-0.01, sdBox(fp-vec2( 0.52,-0.26),vec2(0.08,0.06))));

    // Nose bridge (thin vertical strip between eye sockets)
    float noseBridge = smoothstep(0.02,-0.01, sdBox(fp-vec2(0,-0.08),vec2(0.065,0.18)));

    // Left and right cheek plates
    float lCheek = smoothstep(0.03,-0.02, sdEll(fp-vec2(-0.43,0.10),vec2(0.20,0.30)));
    float rCheek = smoothstep(0.03,-0.02, sdEll(fp-vec2( 0.43,0.10),vec2(0.20,0.30)));

    // Nose — rhombus/diamond
    vec2 noseP = abs(fp-vec2(0,0.20));
    float nose = smoothstep(0.03,-0.01, noseP.x*0.75+noseP.y-0.20);

    // Upper muzzle / lip plates
    float muzzle = smoothstep(0.03,-0.02, sdEll(fp-vec2(0,0.44),vec2(0.38,0.24)));
    // Chin
    float chin = smoothstep(0.03,-0.02, sdEll(fp-vec2(0,0.70),vec2(0.26,0.17)));

    // ── VOID REGIONS (black cutouts) ────────────────────────────────────────
    // Eye sockets
    float lEye = smoothstep(0.02,-0.01, sdEll(fp-vec2(-0.27,-0.18),vec2(0.18,0.13)));
    float rEye = smoothstep(0.02,-0.01, sdEll(fp-vec2( 0.27,-0.18),vec2(0.18,0.13)));
    float eyeVoid = max(lEye, rEye);

    // Central brow shadow (the dark vertical channel between brows)
    float browShadow = smoothstep(0.02,-0.01, sdBox(fp-vec2(0,-0.28),vec2(0.06,0.10)));

    // Mouth void
    float mouthVoid = smoothstep(0.02,-0.01, sdBox(fp-vec2(0,0.45),vec2(0.24,0.065)));

    // ── COMBINE ─────────────────────────────────────────────────────────────
    float plate = max(hair, max(forehead, max(brow, max(noseBridge,
                  max(lCheek, max(rCheek, max(nose, max(muzzle, chin))))))));

    plate *= (1.0 - eyeVoid) * (1.0 - browShadow) * (1.0 - mouthVoid);

    // Inside head but not plate = dark ambient (the black void areas)
    return inHead * 0.07 + plate * 0.93;
  }

  // ── Glitch helpers ─────────────────────────────────────────────────────────
  float glitchBurst(float t){
    // Periodic bursts every ~4s, each lasts ~0.35s
    float cycle = fract(t * 0.25);
    float burstOn = step(0.80, cycle);
    float intensity = hash1(floor(t*4.0)*7.3);
    return burstOn * intensity;
  }

  vec2 glitchDisplace(vec2 px, float t, float burst){
    vec2 out_ = px;

    // Horizontal scan-line displacement during burst
    if(burst > 0.05){
      float row = floor(px.y / 6.0);
      float rowHash = hash1(row + floor(t*12.0)*31.7);
      float displaceX = (rowHash - 0.5) * uResolution.x * 0.06 * burst;
      // Only displace selected rows (sparse)
      float rowActive = step(0.65, hash1(row * 7.3 + floor(t*8.0)));
      out_.x += displaceX * rowActive;

      // Occasional large block displacement
      float blockRow = floor(px.y / (uResolution.y * 0.10));
      float blockActive = step(0.78, hash1(blockRow * 11.1 + floor(t*5.0)));
      float blockX = (hash1(blockRow * 3.7) - 0.5) * uResolution.x * 0.12;
      out_.x += blockX * blockActive * burst;
    }

    return out_;
  }

  // ── Main ──────────────────────────────────────────────────────────────────
  void main(){
    vec2 uvN = vUv;
    vec2 px  = uvN * uResolution;
    float t  = uTime;

    float burst = glitchBurst(t);

    // ── TRIANGLE GRID ─────────────────────────────────────────────────────
    // Apply glitch displacement before cell assignment so whole triangles shift
    vec2 gPx   = glitchDisplace(px, t, burst);
    float CELL = 30.0;

    vec2 cell   = floor(gPx / CELL);
    vec2 local  = fract(gPx / CELL);           // [0,1] within cell
    bool triA   = (local.x + local.y < 1.0);  // upper-left triangle

    // Centroid of this triangle
    vec2 triCenter = triA
      ? (cell + vec2(1.0/3.0, 1.0/3.0)) * CELL
      : (cell + vec2(2.0/3.0, 2.0/3.0)) * CELL;

    // Map triCenter to face-space
    vec2 centUV = triCenter / uResolution;
    vec2 fp = (centUV - vec2(0.5, 0.478)) / 0.44; // ±1 = half face height

    float mask = gorillaMask(fp);

    // ── TRIANGLE EDGE DARKENING ──────────────────────────────────────────
    // Distance to nearest edge of the triangle (in pixels)
    float d1 = min(local.x, 1.0 - local.x) * CELL;
    float d2 = min(local.y, 1.0 - local.y) * CELL;
    float d3 = abs(local.x + local.y - 1.0) * CELL * 0.707;
    float edgePx = min(min(d1,d2),d3);
    float edgeMask = smoothstep(0.0, 1.8, edgePx); // 0=edge,1=interior

    // ── COLOR ─────────────────────────────────────────────────────────────
    vec3 col = vec3(0.0);

    if(mask > 0.04){
      // Per-triangle seed (unique per cell + triangle)
      float seed = hash2(cell + (triA ? vec2(0) : vec2(0.5)));

      // Distance from face center (in face-space) for wave propagation
      float dist = length(fp) * 0.6;

      // Main hue wave: ripples outward from the center of the face
      // Multiple overlapping waves give a complex shimmering pattern
      float wave1 = fract(t * 0.18 - dist * 1.10 + seed * 0.12);
      float wave2 = fract(t * 0.09 + dist * 0.60 + seed * 0.22 + 0.3);
      float hue   = mix(wave1, wave2, 0.35);

      // Saturation: full on bright plate, desaturated on dark/void triangles
      float sat = smoothstep(0.08, 0.65, mask) * 0.92;

      // Value: brighter on face plate, very dim on void/shadow areas
      float val = mix(0.12, 1.0, smoothstep(0.08, 0.70, mask));

      // Occasional bright flash on individual triangles (random sparkle)
      float flash = pow(max(0., sin(t*(2.5+seed*4.0)+seed*12.566)), 18.0);
      val = min(val + flash * 0.9, 1.0);
      sat = mix(sat, 0.0, flash * 0.6); // flash goes toward white

      col = hsv2rgb(vec3(hue, sat, val));

      // During glitch burst: some triangles snap to a vivid accent color
      if(burst > 0.3){
        float glitchTri = step(0.70, hash1(seed * 31.7 + floor(t*15.0)));
        vec3 glitchCol = hsv2rgb(vec3(hash1(floor(t*8.0)*7.3), 1.0, 1.0));
        col = mix(col, glitchCol, glitchTri * burst);
      }

      // Apply edge darkening (the wireframe mesh)
      col *= edgeMask;
    }

    // ── CHROMATIC ABERRATION ──────────────────────────────────────────────
    // Always present subtly; greatly amplified during glitch bursts
    float chromaStr = 0.003 + burst * 0.018;

    // R: sample face mask shifted left, B: shifted right
    vec2 rPx = glitchDisplace(px + vec2(-chromaStr * uResolution.x, 0), t, burst);
    vec2 bPx = glitchDisplace(px + vec2( chromaStr * uResolution.x, 0), t, burst);

    vec2 rCell = floor(rPx/CELL); vec2 rLocal = fract(rPx/CELL);
    bool rTriA = (rLocal.x + rLocal.y < 1.0);
    vec2 rCentroid = rTriA ? (rCell+vec2(1./3.,1./3.))*CELL : (rCell+vec2(2./3.,2./3.))*CELL;
    float rSeed = hash2(rCell+(rTriA?vec2(0):vec2(.5)));
    float rDist = length((rCentroid/uResolution - vec2(.5,.478))/0.44)*0.6;
    float rHue  = fract(t*0.18 - rDist*1.10 + rSeed*0.12);
    float rMask = gorillaMask((rCentroid/uResolution - vec2(.5,.478))/0.44);
    vec3  rCol  = hsv2rgb(vec3(rHue, smoothstep(.08,.65,rMask)*.92, mix(.12,1.,smoothstep(.08,.70,rMask))));
    float rEdge = smoothstep(0.,1.8, min(min(min(rLocal.x,1.-rLocal.x),min(rLocal.y,1.-rLocal.y))*CELL, abs(rLocal.x+rLocal.y-1.)*CELL*.707));

    vec2 bCell = floor(bPx/CELL); vec2 bLocal = fract(bPx/CELL);
    bool bTriA = (bLocal.x + bLocal.y < 1.0);
    vec2 bCentroid = bTriA ? (bCell+vec2(1./3.,1./3.))*CELL : (bCell+vec2(2./3.,2./3.))*CELL;
    float bSeed = hash2(bCell+(bTriA?vec2(0):vec2(.5)));
    float bDist = length((bCentroid/uResolution - vec2(.5,.478))/0.44)*0.6;
    float bHue  = fract(t*0.18 - bDist*1.10 + bSeed*0.12);
    float bMask = gorillaMask((bCentroid/uResolution - vec2(.5,.478))/0.44);
    vec3  bCol  = hsv2rgb(vec3(bHue, smoothstep(.08,.65,bMask)*.92, mix(.12,1.,smoothstep(.08,.70,bMask))));
    float bEdge = smoothstep(0.,1.8, min(min(min(bLocal.x,1.-bLocal.x),min(bLocal.y,1.-bLocal.y))*CELL, abs(bLocal.x+bLocal.y-1.)*CELL*.707));

    // Blend channels: R from shifted-left sample, G from center, B from shifted-right
    if(rMask > 0.04) col.r = max(col.r, rCol.r * rEdge * 1.1);
    if(bMask > 0.04) col.b = max(col.b, bCol.b * bEdge * 1.1);

    // ── SCANLINE NOISE (fine digital texture) ────────────────────────────
    float scanNoise = hash2(vec2(floor(px.y), floor(t * 30.0))) * 0.04;
    col += scanNoise * burst;

    // ── VIGNETTE ─────────────────────────────────────────────────────────
    vec2 vc = uvN - 0.5;
    col *= 1.0 - 1.10 * dot(vc,vc) * 2.5;
    col = max(col, vec3(0.0));

    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`,
);

const glitchApe = defineEffect({
  descriptor: {
    id: "glitch-ape",
    name: "Glitch Ape",
    description:
      "A gorilla face built entirely from signed distance fields, torn apart by chromatic aberration, scanline displacement and channel splitting.",
    engine: "three",
    category: "background",
    tags: ["glitch", "ape", "sdf", "shader", "corruption", "portrait"],
    previewNotes:
      "Fills the frame and is opaque \u2014 a centrepiece rather than an overlay. There is no image file behind it: the face is drawn from mathematics, which is why it is sharp at any canvas size. Speed changes how violently it tears.",
    params: [SPEED_PARAM],
  },
  setup: shaderQuadSetup({ fragment: FRAGMENT_SHADER }),
});

export default glitchApe;
