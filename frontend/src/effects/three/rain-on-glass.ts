import * as THREE from "three";

import { bool, int, num } from "../paramUtils";
import { createThreeStage, defineEffect, onFrame } from "../sdk";

/**
 * Rain on Glass
 * =============
 *
 * Raindrops rolling down a window pane in front of a blurred amber cityscape at night. Each drop is
 * a little lens: through it you see a *sharper* version of the city than the blurred glass around
 * it, upside-down-ish and distorted, exactly the way a real drop refracts the scene behind a window.
 *
 * Ported from `rain-on-glass.html` in the old `obs-effects` repository.
 *
 * How it works — two halves
 * -------------------------
 * 1. **A CPU raindrop simulation drawn with canvas 2D.** Drops spawn, gain momentum, slide down,
 *    leave trails of smaller droplets, merge when they collide, and shrink away when they stop.
 *    Each drop is stamped onto an off-screen canvas (the "water map") using one of 255 pre-rendered
 *    bitmaps. The stamp is not a picture of a drop: its red and green channels encode which
 *    direction light should bend at that pixel (a *normal map*), its blue channel encodes how deep
 *    into the drop the pixel is, and its alpha is the drop's shape mask. A second off-screen canvas
 *    accumulates thousands of static micro-droplets — the fine mist on the glass — which moving
 *    drops wipe clean as they roll through it.
 * 2. **A GPU fragment shader that reads that water map.** For every screen pixel it decodes the
 *    encoded bend direction and offsets its lookup into a *sharp* background texture by that amount;
 *    where there is no water it shows a *blurred* background instead. That offset lookup is the
 *    entire refraction illusion.
 *
 * The amber cityscape itself is procedurally painted once with a seeded random generator (building
 * silhouettes, lit windows, bokeh circles, point lights), at two resolutions: a small sharp one seen
 * through the drops and a larger heavily blurred one seen between them. The exact gradient colours
 * of the sky are part of the artwork and are kept verbatim from the original; the seed and the blur
 * amounts are exposed as parameters so the skyline can be re-rolled without editing code.
 *
 * What changed in the port
 * ------------------------
 * - The hand-rolled WebGL boilerplate (shader compile, quad buffer, texture setup) became a
 *   `createThreeStage` fullscreen quad with a `ShaderMaterial`; the fragment shader body is the
 *   original's, minus its shine and shadow branches, which the original permanently disabled
 *   (`u_renderShine = 0`, `u_renderShadow = 0`).
 * - The original listened for `postMessage` to tune `RAIN_AMOUNT` and `REFRACTION`; those are now
 *   ordinary parameters, alongside the constants that were hard-coded (drop radii, spawn rates,
 *   brightness, blur).
 * - `requestAnimationFrame` and the manual `timeScale` clock became `onFrame`, which honours the
 *   route's frame cap. The simulation still normalises to 60 ticks per second internally so all the
 *   original decay constants (`0.97^t`, `0.4^t`, ...) behave identically.
 * - Click-to-splash and drag-to-wipe survive behind an `interactive` toggle (on by default, as in
 *   the original). The original page defined a `.label` CSS class but never added a label element to
 *   the page, so there is no text overlay to reproduce.
 * - A resize rebuilds the simulation at the new size (the original did the same on window resize):
 *   drops on the glass do not survive a resize, which is invisible in practice because the delivery
 *   page renders at a fixed route resolution.
 */

/** Side length of the pre-rendered drop stamp bitmaps, in pixels. */
const DROP_SIZE = 64;

/** Aspect-ratio of the drawn drop: slightly taller than wide, like a drop being pulled down. */
const DROP_SCALE_X = 1;
const DROP_SCALE_Y = 1.5;

/** One simulated raindrop sitting on (or sliding down) the glass. */
interface Drop {
  x: number;
  y: number;
  r: number;
  /** How "smeared" the drop is horizontally/vertically; fresh drops start spread and settle. */
  spreadX: number;
  spreadY: number;
  /** Downward speed. Drops with momentum slide and leave trails; at 0 they sit still. */
  momentum: number;
  momentumX: number;
  lastSpawn: number;
  nextSpawn: number;
  parent: Drop | null;
  isNew: boolean;
  killed: boolean;
  shrink: number;
}

/** `random(a, b, curve)` — a random number in [a, b), optionally biased by a shaping function. */
function random(from: number, to: number, interp?: (n: number) => number): number {
  const shaped = interp ? interp(Math.random()) : Math.random();
  return from + shaped * (to - from);
}

function chance(c: number): boolean {
  return Math.random() <= c;
}

function createCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("rain-on-glass: could not create a 2D canvas context");
  return ctx;
}

/**
 * Drop shape mask: white pixels whose alpha falls off steeply from the centre. The shader later
 * remaps alpha with `a * 6 - 3`, so only the inner core of the stamp survives as a visible drop —
 * micro-droplets become specks and only large drops read clearly. Kept verbatim from the original.
 */
function generateDropAlpha(size: number): HTMLCanvasElement {
  const c = createCanvas(size, size);
  const ctx = ctx2d(c);
  const imgData = ctx.createImageData(size, size);
  const d = imgData.data;
  const cx = size / 2;
  const cy = size / 2;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      const dx = (px - cx) / cx;
      let dy = (py - cy) / cy;
      dy *= 1.0 + dy * 0.15; // pull the bottom half down: a drop hangs, it is not a circle
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 1.0) continue;

      const alpha = Math.max(0, 1.0 - Math.pow(dist / 0.35, 6)) * 255;
      const idx = (py * size + px) * 4;
      d[idx] = 255;
      d[idx + 1] = 255;
      d[idx + 2] = 255;
      d[idx + 3] = Math.round(Math.min(255, Math.max(0, alpha)));
    }
  }
  ctx.putImageData(imgData, 0, 0);
  return c;
}

/**
 * Refraction normal map. Red encodes the vertical light-bend at that pixel, green the horizontal
 * (128 = no bend), blue the depth into the drop. Alpha is always 255: the browser premultiplies
 * canvas RGB by alpha, and a varying alpha here would corrupt the encoded directions.
 */
function generateDropColor(size: number): HTMLCanvasElement {
  const c = createCanvas(size, size);
  const ctx = ctx2d(c);
  const imgData = ctx.createImageData(size, size);
  const d = imgData.data;
  const cx = size / 2;
  const cy = size / 2;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      const dx = (px - cx) / cx;
      let dy = (py - cy) / cy;
      dy *= 1.0 + dy * 0.15;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 1.0) continue;

      const nx = dist > 0.001 ? dx / dist : 0;
      const ny = dist > 0.001 ? dy / dist : 0;

      // Bend strength grows towards the edge, like a lens; 60 caps it so distortion stays soft.
      const strength = dist;
      const r = Math.round(ny * 60 * strength + 128);
      const g = Math.round(nx * 60 * strength + 128);
      const depth = Math.sqrt(Math.max(0, 1.0 - dist * dist)) * 255;

      const idx = (py * size + px) * 4;
      d[idx] = Math.max(0, Math.min(255, r));
      d[idx + 1] = Math.max(0, Math.min(255, g));
      d[idx + 2] = Math.round(depth);
      d[idx + 3] = 255;
    }
  }
  ctx.putImageData(imgData, 0, 0);
  return c;
}

/**
 * Paints the amber night cityscape. Uses its own linear-congruential random generator so the same
 * seed always paints the same skyline — that is what keeps the sharp (through-drop) and blurred
 * (between-drop) versions showing the *same* city, which the refraction illusion depends on.
 */
function generateCityBg(w: number, h: number, blurPx: number, seed: number): HTMLCanvasElement {
  let s = seed;
  const srand = (): number => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };

  const c = createCanvas(w, h);
  const ctx = ctx2d(c);

  // Sky gradient: deep indigo up top, warm amber city glow at the horizon.
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, "#0c0a1a");
  sky.addColorStop(0.15, "#1a1228");
  sky.addColorStop(0.35, "#2a1830");
  sky.addColorStop(0.55, "#4a2520");
  sky.addColorStop(0.75, "#6a3818");
  sky.addColorStop(1, "#8a4a10");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  const glow = ctx.createLinearGradient(0, h * 0.3, 0, h);
  glow.addColorStop(0, "rgba(200, 100, 30, 0)");
  glow.addColorStop(0.3, "rgba(200, 120, 40, 0.15)");
  glow.addColorStop(0.6, "rgba(210, 140, 50, 0.3)");
  glow.addColorStop(1, "rgba(220, 150, 60, 0.5)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  // Building silhouettes with randomly lit windows.
  const bColors = ["#08060e", "#0a0812", "#0c0a16", "#0e0c1a"];
  for (let b = 0; b < 35; b += 1) {
    const bx = srand() * w * 1.3 - w * 0.15;
    const bw = w * 0.02 + srand() * w * 0.12;
    const bh = h * 0.15 + srand() * h * 0.55;
    const by = h - bh + srand() * h * 0.05;
    ctx.fillStyle = bColors[b % bColors.length] ?? "#08060e";
    ctx.fillRect(bx, by, bw, bh);

    const wRows = Math.floor(bh / (h * 0.04));
    const wCols = Math.floor(bw / (w * 0.02));
    for (let wr = 0; wr < wRows; wr += 1) {
      for (let wc = 0; wc < wCols; wc += 1) {
        if (srand() > 0.45) {
          const wx = bx + w * 0.005 + wc * (w * 0.02);
          const wy = by + h * 0.01 + wr * (h * 0.04);
          const warmth = srand();
          if (warmth > 0.3) {
            ctx.fillStyle = `rgba(255, 200, 120, ${0.4 + srand() * 0.5})`;
          } else if (warmth > 0.1) {
            ctx.fillStyle = `rgba(255, 160, 80, ${0.3 + srand() * 0.4})`;
          } else {
            ctx.fillStyle = `rgba(180, 220, 255, ${0.2 + srand() * 0.3})`;
          }
          ctx.fillRect(wx, wy, w * 0.008, h * 0.02);
        }
      }
    }
  }

  // Soft bokeh circles in warm hues (with occasional blue and magenta accents).
  for (let i = 0; i < 80; i += 1) {
    const bkx = srand() * w;
    const bky = h * 0.1 + srand() * h * 0.85;
    const bkr = w * 0.02 + srand() * w * 0.15;
    const rndC = srand();
    let hue: number;
    let sat: number;
    let lit: number;
    if (rndC < 0.45) {
      hue = 25 + srand() * 20;
      sat = 80 + srand() * 20;
      lit = 55 + srand() * 35;
    } else if (rndC < 0.7) {
      hue = 10 + srand() * 15;
      sat = 85 + srand() * 15;
      lit = 50 + srand() * 30;
    } else if (rndC < 0.85) {
      hue = 40 + srand() * 15;
      sat = 75 + srand() * 25;
      lit = 60 + srand() * 30;
    } else if (rndC < 0.93) {
      hue = 200 + srand() * 30;
      sat = 60 + srand() * 30;
      lit = 50 + srand() * 30;
    } else {
      hue = 330 + srand() * 25;
      sat = 65 + srand() * 25;
      lit = 55 + srand() * 25;
    }
    const alpha = 0.08 + srand() * 0.25;
    const g = ctx.createRadialGradient(bkx, bky, 0, bkx, bky, bkr);
    g.addColorStop(0, `hsla(${hue},${sat}%,${lit}%,${alpha * 1.3})`);
    g.addColorStop(0.3, `hsla(${hue},${sat}%,${lit}%,${alpha * 0.6})`);
    g.addColorStop(0.6, `hsla(${hue},${sat}%,${lit}%,${alpha * 0.15})`);
    g.addColorStop(1, `hsla(${hue},${sat}%,${lit}%,0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(bkx, bky, bkr, 0, Math.PI * 2);
    ctx.fill();
  }

  // Bright point lights: street lamps and signs.
  for (let p = 0; p < 25; p += 1) {
    const px = srand() * w;
    const py = h * 0.35 + srand() * h * 0.6;
    const pr = w * 0.005 + srand() * w * 0.03;
    const pRnd = srand();
    const pH = pRnd > 0.3 ? 20 + srand() * 25 : 195 + srand() * 30;
    const pg = ctx.createRadialGradient(px, py, 0, px, py, pr);
    pg.addColorStop(0, `hsla(${pH},95%,90%,0.9)`);
    pg.addColorStop(0.2, `hsla(${pH},90%,75%,0.45)`);
    pg.addColorStop(0.5, `hsla(${pH},85%,60%,0.15)`);
    pg.addColorStop(1, `hsla(${pH},80%,55%,0)`);
    ctx.fillStyle = pg;
    ctx.beginPath();
    ctx.arc(px, py, pr, 0, Math.PI * 2);
    ctx.fill();
  }

  // Warm ambient wash over the lower half.
  const amb = ctx.createLinearGradient(0, h * 0.5, 0, h);
  amb.addColorStop(0, "rgba(200, 130, 50, 0)");
  amb.addColorStop(0.5, "rgba(200, 130, 50, 0.06)");
  amb.addColorStop(1, "rgba(220, 150, 60, 0.12)");
  ctx.fillStyle = amb;
  ctx.fillRect(0, 0, w, h);

  if (blurPx > 0) {
    const tmp = createCanvas(w, h);
    ctx2d(tmp).drawImage(c, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.filter = `blur(${blurPx}px)`;
    ctx.drawImage(tmp, 0, 0);
    ctx.filter = "none";
  }
  return c;
}

/*
 * The fragment shader — the original's, with its permanently-disabled shine and shadow branches
 * removed and the GLSL 1 boilerplate adapted to three.js (`vUv` from the shared fullscreen quad
 * replaces `gl_FragCoord / u_resolution`). It never uses the shared GLSL chunk library because the
 * original is a straight texture-lookup shader with no noise or SDF maths in it.
 *
 * Per pixel: sample the water map; where its alpha (remapped by alphaMultiply/alphaSubtract) says
 * "water here", decode the bend direction from red/green, offset the sharp-background lookup by
 * that many pixels scaled by depth (blue), and composite that over the blurred background.
 */
const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

varying vec2 vUv;

uniform sampler2D uWaterMap;
uniform sampler2D uTextureFg;
uniform sampler2D uTextureBg;

uniform vec2  uResolution;
uniform float uParallaxFg;
uniform float uTextureRatio;
uniform float uMinRefraction;
uniform float uRefractionDelta;
uniform float uBrightness;
uniform float uAlphaMultiply;
uniform float uAlphaSubtract;

vec4 blend(vec4 bg, vec4 fg) {
  vec3 bgm = bg.rgb * bg.a;
  vec3 fgm = fg.rgb * fg.a;
  float ia = 1.0 - fg.a;
  float a = fg.a + bg.a * ia;
  vec3 rgb = a != 0.0 ? (fgm + bgm * ia) / a : vec3(0.0);
  return vec4(rgb, a);
}

vec2 pixel() {
  return vec2(1.0) / uResolution;
}

// Screen coordinate with y running downwards, matching the canvas the water map was drawn on.
vec2 texCoord() {
  return vec2(vUv.x, 1.0 - vUv.y);
}

// Cover-fit the background texture: scale so it fills the screen whatever the aspect ratios are.
vec2 scaledTexCoord() {
  float ratio = uResolution.x / uResolution.y;
  vec2 scale = vec2(1.0);
  vec2 offset = vec2(0.0);
  float ratioDelta = ratio - uTextureRatio;
  if (ratioDelta >= 0.0) {
    scale.y = 1.0 + ratioDelta;
    offset.y = ratioDelta / 2.0;
  } else {
    scale.x = 1.0 - ratioDelta;
    offset.x = -ratioDelta / 2.0;
  }
  return (texCoord() + offset) / scale;
}

// Water-map sample, inset slightly (the original's parallax-foreground margin) so drops near the
// screen edge still refract something instead of clamping.
vec4 waterColor() {
  float p2 = uParallaxFg * 2.0;
  vec2 scale = vec2(
    (uResolution.x + p2) / uResolution.x,
    (uResolution.y + p2) / uResolution.y
  );
  vec2 scaledTC = texCoord() / scale;
  vec2 offset = vec2(
    (1.0 - (1.0 / scale.x)) / 2.0,
    (1.0 - (1.0 / scale.y)) / 2.0
  );
  return texture2D(uWaterMap, scaledTC + offset);
}

void main() {
  vec4 bg = texture2D(uTextureBg, scaledTexCoord());

  vec4 cur = waterColor();

  float d = cur.b;                                   // depth into the drop
  float x = cur.g;                                   // horizontal bend, 0.5 = none
  float y = cur.r;                                   // vertical bend, 0.5 = none

  // Steep alpha remap: most of the stamp's soft falloff becomes fully transparent, and only the
  // core of each drop survives. This is what turns soft blobs into crisp-edged water.
  float a = clamp(cur.a * uAlphaMultiply - uAlphaSubtract, 0.0, 1.0);

  vec2 refraction = (vec2(x, y) - 0.5) * 2.0;
  vec2 refractionPos = scaledTexCoord()
    + pixel() * refraction * (uMinRefraction + d * uRefractionDelta);

  vec4 tex = texture2D(uTextureFg, refractionPos);
  vec4 fg = vec4(tex.rgb * uBrightness, a);

  gl_FragColor = blend(bg, fg);
}
`;

/*
 * three.js's fullscreen-quad vertex shader. The SDK's shared FULLSCREEN_VERTEX is written for
 * assembleFragment pairs; this effect's fragment shader carries its own precision line (kept from
 * the original), so the matching two-line passthrough is stated here for symmetry and clarity.
 */
const VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 1.0);
}
`;

/** Simulation tunables, refreshed by setParams. Names kept from the original's `options` object. */
interface SimOptions {
  minR: number;
  maxR: number;
  maxDrops: number;
  rainChance: number;
  rainLimit: number;
  dropletsRate: number;
  dropletsSizeMin: number;
  dropletsSizeMax: number;
  dropletsCleaningRadiusMultiplier: number;
  globalTimeScale: number;
  trailRate: number;
  autoShrink: boolean;
  spawnAreaTop: number;
  spawnAreaBottom: number;
  trailScaleMin: number;
  trailScaleMax: number;
  collisionRadius: number;
  collisionRadiusIncrease: number;
  dropFallMultiplier: number;
  collisionBoostMultiplier: number;
  collisionBoost: number;
  rainAmount: number;
}

function readOptions(p: Record<string, unknown>): SimOptions {
  return {
    minR: num(p, "minRadius", 20, 5, 60),
    maxR: num(p, "maxRadius", 50, 10, 150),
    maxDrops: int(p, "maxDrops", 900, 50, 3000),
    rainChance: num(p, "rainChance", 0.35, 0, 1),
    rainLimit: num(p, "rainLimit", 6, 1, 30),
    dropletsRate: num(p, "dropletsRate", 120, 0, 600),
    dropletsSizeMin: num(p, "dropletsSizeMin", 2, 0.5, 10),
    dropletsSizeMax: num(p, "dropletsSizeMax", 5, 1, 20),
    dropletsCleaningRadiusMultiplier: num(p, "cleaningRadius", 0.28, 0, 1),
    globalTimeScale: num(p, "timeScale", 1, 0, 3),
    trailRate: num(p, "trailRate", 1, 0, 5),
    autoShrink: true,
    spawnAreaTop: -0.1,
    spawnAreaBottom: 0.95,
    trailScaleMin: 0.25,
    trailScaleMax: 0.35,
    collisionRadius: 0.45,
    collisionRadiusIncrease: 0.0002,
    dropFallMultiplier: 1,
    collisionBoostMultiplier: 0.05,
    collisionBoost: 1,
    rainAmount: num(p, "rainAmount", 1, 0, 3),
  };
}

export default defineEffect({
  descriptor: {
    id: "rain-on-glass",
    name: "Rain on Glass",
    description:
      "Raindrops sliding down a window in front of a blurred amber cityscape at night. Each drop refracts a sharper view of the city, drops merge on collision and leave droplet trails.",
    engine: "three",
    category: "background",
    tags: ["rain", "water", "refraction", "shader", "cityscape", "background", "ambient"],
    previewNotes:
      "Fully opaque: a background, not an overlay. Give it a few seconds for drops to accumulate. Reroll Skyline Seed for a different city. With Interactive on, click for a splash and drag to wipe the glass.",
    params: [
      {
        key: "rainAmount",
        label: "Rain Amount",
        kind: "number",
        default: 1,
        min: 0,
        max: 3,
        step: 0.05,
        description:
          "Overall intensity multiplier on both large drops and micro-droplet mist. 0 stops new rain (existing drops still play out); 3 is a downpour.",
      },
      {
        key: "refraction",
        label: "Refraction",
        kind: "number",
        default: 1,
        min: 0,
        max: 3,
        step: 0.05,
        description:
          "How strongly drops bend the background seen through them. 0 makes drops nearly invisible; high values give funhouse-mirror lensing.",
      },
      {
        key: "minRadius",
        label: "Min Drop Radius",
        kind: "number",
        default: 20,
        min: 5,
        max: 60,
        step: 1,
        description:
          "Smallest radius a spawned drop can have, in simulation pixels. Drops at or below this size slowly evaporate.",
      },
      {
        key: "maxRadius",
        label: "Max Drop Radius",
        kind: "number",
        default: 50,
        min: 10,
        max: 150,
        step: 1,
        description:
          "Largest radius a drop can reach, including growth from merging with other drops.",
      },
      {
        key: "maxDrops",
        label: "Max Drops",
        kind: "number",
        default: 900,
        min: 50,
        max: 3000,
        step: 10,
        description:
          "Upper bound on simulated drops (scaled by canvas area). Lower this if a large canvas gets slow.",
      },
      {
        key: "rainChance",
        label: "Spawn Chance",
        kind: "number",
        default: 0.35,
        min: 0,
        max: 1,
        step: 0.01,
        description:
          "Per-tick probability of spawning each new large drop. Higher means drops appear more often.",
      },
      {
        key: "rainLimit",
        label: "Spawn Limit",
        kind: "number",
        default: 6,
        min: 1,
        max: 30,
        step: 1,
        description: "Hard cap on how many large drops can spawn in a single simulation tick.",
      },
      {
        key: "dropletsRate",
        label: "Mist Rate",
        kind: "number",
        default: 120,
        min: 0,
        max: 600,
        step: 5,
        description:
          "How many static micro-droplets condense onto the glass per tick. 0 turns the mist layer off.",
      },
      {
        key: "dropletsSizeMin",
        label: "Mist Size (min)",
        kind: "number",
        default: 2,
        min: 0.5,
        max: 10,
        step: 0.5,
        description: "Smallest micro-droplet radius, in simulation pixels.",
      },
      {
        key: "dropletsSizeMax",
        label: "Mist Size (max)",
        kind: "number",
        default: 5,
        min: 1,
        max: 20,
        step: 0.5,
        description: "Largest micro-droplet radius.",
      },
      {
        key: "cleaningRadius",
        label: "Wipe Radius",
        kind: "number",
        default: 0.28,
        min: 0,
        max: 1,
        step: 0.02,
        description:
          "How wide a trail a sliding drop wipes through the mist, as a fraction of its own radius. 0 leaves the mist untouched.",
      },
      {
        key: "trailRate",
        label: "Trail Rate",
        kind: "number",
        default: 1,
        min: 0,
        max: 5,
        step: 0.05,
        description:
          "How often a sliding drop sheds small trailing drops behind it. 0 gives clean streak-free slides.",
      },
      {
        key: "timeScale",
        label: "Time Scale",
        kind: "number",
        default: 1,
        min: 0,
        max: 3,
        step: 0.05,
        description: "Speed multiplier on the whole simulation. 0 freezes the glass.",
      },
      {
        key: "brightness",
        label: "Drop Brightness",
        kind: "number",
        default: 1.04,
        min: 0.5,
        max: 2,
        step: 0.01,
        description:
          "Brightness of the background seen through drops. Slightly above 1 makes drops glint against the blurred glass.",
      },
      {
        key: "bgSeed",
        label: "Skyline Seed",
        kind: "number",
        default: 42,
        min: 1,
        max: 9999,
        step: 1,
        description:
          "Seed for the procedurally painted cityscape. Change it to reroll the buildings, windows and bokeh into a different city.",
      },
      {
        key: "bgBlur",
        label: "Glass Blur",
        kind: "number",
        default: 8,
        min: 0,
        max: 24,
        step: 1,
        description:
          "Blur of the background seen between drops, in pixels. The contrast between this and the sharp view inside each drop is what sells the wet-glass look.",
      },
      {
        key: "fgBlur",
        label: "Drop Blur",
        kind: "number",
        default: 1,
        min: 0,
        max: 8,
        step: 0.5,
        description:
          "Blur of the background seen through drops. Keep it well below Glass Blur or drops stop standing out.",
      },
      {
        key: "interactive",
        label: "Interactive",
        kind: "boolean",
        default: true,
        description:
          "When on, clicking the canvas splashes a drop and dragging wipes water off the glass. Harmless to leave on: an OBS browser source never sends clicks unless you interact with it.",
      },
    ],
  },

  setup({ ctx, scope }) {
    // Antialiasing is off: the whole picture is one textured quad with no polygon edges to smooth.
    const stage = createThreeStage(scope, ctx, {
      antialias: false,
      camera: { kind: "fullscreen-quad" },
    });

    let options = readOptions(ctx.params);
    let refraction = num(ctx.params, "refraction", 1, 0, 3);
    let interactive = bool(ctx.params, "interactive", true);
    let bgSeed = int(ctx.params, "bgSeed", 42, 1, 9999);
    let bgBlur = num(ctx.params, "bgBlur", 8, 0, 24);
    let fgBlur = num(ctx.params, "fgBlur", 1, 0, 8);

    // ── Drop stamp bitmaps ─────────────────────────────────────────────────
    // 255 variants of the drop stamp, one per possible blue-channel (depth) boost. Stamping a
    // pre-rendered bitmap per drop is far cheaper than per-pixel work per drop per frame.
    const dropAlphaTex = generateDropAlpha(DROP_SIZE);
    const dropColorTex = generateDropColor(DROP_SIZE);
    const dropsGfx: HTMLCanvasElement[] = [];
    {
      const buffer = createCanvas(DROP_SIZE, DROP_SIZE);
      const bufferCtx = ctx2d(buffer);
      for (let i = 0; i < 255; i += 1) {
        const drop = createCanvas(DROP_SIZE, DROP_SIZE);
        const dropCtx = ctx2d(drop);
        bufferCtx.clearRect(0, 0, DROP_SIZE, DROP_SIZE);

        bufferCtx.globalCompositeOperation = "source-over";
        bufferCtx.drawImage(dropColorTex, 0, 0, DROP_SIZE, DROP_SIZE);

        // Screen-blending pure blue raises only the depth channel, giving 255 depth variants
        // from one source bitmap.
        bufferCtx.globalCompositeOperation = "screen";
        bufferCtx.fillStyle = `rgba(0,0,${i},1)`;
        bufferCtx.fillRect(0, 0, DROP_SIZE, DROP_SIZE);

        // Clip the refraction colours to the drop's shape via the alpha mask.
        dropCtx.globalCompositeOperation = "source-over";
        dropCtx.drawImage(dropAlphaTex, 0, 0, DROP_SIZE, DROP_SIZE);
        dropCtx.globalCompositeOperation = "source-in";
        dropCtx.drawImage(buffer, 0, 0, DROP_SIZE, DROP_SIZE);

        dropsGfx.push(drop);
      }
    }
    // Black circle stamped with destination-out to erase mist under a sliding drop.
    const clearDropletsGfx = createCanvas(128, 128);
    {
      const clearCtx = ctx2d(clearDropletsGfx);
      clearCtx.fillStyle = "#000";
      clearCtx.beginPath();
      clearCtx.arc(64, 64, 64, 0, Math.PI * 2);
      clearCtx.fill();
    }

    // ── Simulation state ───────────────────────────────────────────────────
    // The simulation runs at the device-pixel resolution the original used (capped at 2×), with
    // drop positions in CSS pixels and a scale factor applied when stamping.
    const rdScale = Math.min(window.devicePixelRatio || 1, 2);
    let rdWidth = 0;
    let rdHeight = 0;
    // The water map every drop is stamped onto each frame — what the shader reads.
    const rdCanvas = createCanvas(1, 1);
    const rdCtx = ctx2d(rdCanvas);
    // The persistent mist layer, composited under the moving drops each frame.
    const dropletsCanvas = createCanvas(1, 1);
    const dropletsCtx = ctx2d(dropletsCanvas);
    let drops: Drop[] = [];
    let dropletsCounter = 0;

    const deltaR = (): number => options.maxR - options.minR;
    // Spawn rates were tuned on a 1024×768 window; this keeps drop density constant per area.
    const areaMultiplier = (): number =>
      Math.sqrt((rdWidth * rdHeight) / rdScale / (1024 * 768));

    const createDrop = (opts: Partial<Drop>): Drop | null => {
      if (drops.length >= options.maxDrops * areaMultiplier()) return null;
      return {
        x: 0,
        y: 0,
        r: 0,
        spreadX: 0,
        spreadY: 0,
        momentum: 0,
        momentumX: 0,
        lastSpawn: 0,
        nextSpawn: 0,
        parent: null,
        isNew: true,
        killed: false,
        shrink: 0,
        ...opts,
      };
    };

    const drawDrop = (
      target: CanvasRenderingContext2D,
      x: number,
      y: number,
      r: number,
      spreadX: number,
      spreadY: number,
    ): void => {
      // Pick the depth variant: bigger, more settled drops read as deeper water.
      let d = Math.max(0, Math.min(1, ((r - options.minR) / Math.max(1e-6, deltaR())) * 0.9));
      d *= 1 / ((spreadX + spreadY) * 0.5 + 1);
      const stamp = dropsGfx[Math.floor(d * (dropsGfx.length - 1))];
      if (!stamp) return;

      target.globalAlpha = 1;
      target.globalCompositeOperation = "source-over";
      target.drawImage(
        stamp,
        (x - r * DROP_SCALE_X * (spreadX + 1)) * rdScale,
        (y - r * DROP_SCALE_Y * (spreadY + 1)) * rdScale,
        r * 2 * DROP_SCALE_X * (spreadX + 1) * rdScale,
        r * 2 * DROP_SCALE_Y * (spreadY + 1) * rdScale,
      );
    };

    const drawDroplet = (x: number, y: number, r: number): void => {
      drawDrop(dropletsCtx, x, y, r, 0, 0);
    };

    const clearDroplets = (x: number, y: number, r: number): void => {
      dropletsCtx.globalCompositeOperation = "destination-out";
      dropletsCtx.drawImage(
        clearDropletsGfx,
        (x - r) * rdScale,
        (y - r) * rdScale,
        r * 2 * rdScale,
        r * 2 * rdScale * 1.5,
      );
    };

    const initSim = (): void => {
      rdWidth = Math.max(1, Math.round(stage.width * rdScale));
      rdHeight = Math.max(1, Math.round(stage.height * rdScale));
      rdCanvas.width = rdWidth;
      rdCanvas.height = rdHeight;
      dropletsCanvas.width = rdWidth;
      dropletsCanvas.height = rdHeight;
      drops = [];
      dropletsCounter = 0;
    };

    const spawnRain = (timeScale: number): Drop[] => {
      const spawned: Drop[] = [];
      const rainAmount = options.rainAmount;
      const limit = options.rainLimit * timeScale * areaMultiplier() * rainAmount;
      let count = 0;
      while (chance(options.rainChance * timeScale * areaMultiplier() * rainAmount) && count < limit) {
        count += 1;
        // Cubing the random value biases spawns towards small drops; big drops are rare events.
        const r = random(options.minR, options.maxR, (n) => Math.pow(n, 3));
        const drop = createDrop({
          x: random(0, rdWidth / rdScale),
          y: random(
            (rdHeight / rdScale) * options.spawnAreaTop,
            (rdHeight / rdScale) * options.spawnAreaBottom,
          ),
          r,
          momentum: 1 + (r - options.minR) * 0.1 + random(0, 2),
          spreadX: 1.5,
          spreadY: 1.5,
        });
        if (drop !== null) spawned.push(drop);
      }
      return spawned;
    };

    const updateDroplets = (timeScale: number): void => {
      dropletsCounter += options.dropletsRate * timeScale * areaMultiplier() * options.rainAmount;
      let toSpawn = Math.floor(dropletsCounter);
      dropletsCounter -= toSpawn;

      const w = rdWidth / rdScale;
      const h = rdHeight / rdScale;
      const dropletR = (): number =>
        random(options.dropletsSizeMin, options.dropletsSizeMax, (n) => n * n);

      // ~80% of the mist condenses in tight clusters of 4-8, the rest is scattered singles.
      // Clustering is what makes it read as condensation rather than uniform noise.
      while (toSpawn > 0) {
        if (chance(0.8) && toSpawn >= 4) {
          const clusterSize = Math.min(toSpawn, 4 + Math.floor(Math.random() * 5));
          const cx = random(0, w);
          const cy = random(0, h);
          const clusterSpread = 4 + Math.random() * 8;
          for (let ci = 0; ci < clusterSize; ci += 1) {
            const angle = Math.random() * Math.PI * 2;
            const dist = Math.random() * clusterSpread;
            drawDroplet(cx + Math.cos(angle) * dist, cy + Math.sin(angle) * dist, dropletR());
          }
          toSpawn -= clusterSize;
        } else {
          drawDroplet(random(0, w), random(0, h), dropletR());
          toSpawn -= 1;
        }
      }
      rdCtx.drawImage(dropletsCanvas, 0, 0, rdWidth, rdHeight);
    };

    const updateDrops = (timeScale: number): void => {
      updateDroplets(timeScale);
      const newDrops: Drop[] = spawnRain(timeScale);

      // Sorting top-to-bottom bounds the collision scan to the next 70 drops in reading order —
      // near neighbours — instead of comparing every pair.
      drops.sort((a, b) => a.y * (rdWidth / rdScale) + a.x - (b.y * (rdWidth / rdScale) + b.x));

      for (let i = 0; i < drops.length; i += 1) {
        const drop = drops[i];
        if (!drop || drop.killed) continue;

        // Occasional random momentum bursts: a stuck drop suddenly finding its way down.
        if (
          chance(
            (drop.r - options.minR * options.dropFallMultiplier) *
              (0.1 / Math.max(1e-6, deltaR())) *
              timeScale,
          )
        ) {
          drop.momentum += random(0, (drop.r / options.maxR) * 4);
        }
        // Small stationary drops evaporate.
        if (options.autoShrink && drop.r <= options.minR && chance(0.05 * timeScale)) {
          drop.shrink += 0.01;
        }
        drop.r -= drop.shrink * timeScale;
        if (drop.r <= 0) {
          drop.killed = true;
          continue;
        }

        // A moving drop periodically sheds a small trailing drop and loses a little mass to it.
        drop.lastSpawn += drop.momentum * timeScale * options.trailRate;
        if (drop.lastSpawn > drop.nextSpawn) {
          const trail = createDrop({
            x: drop.x + random(-drop.r, drop.r) * 0.1,
            y: drop.y - drop.r * 0.01,
            r: drop.r * random(options.trailScaleMin, options.trailScaleMax),
            spreadY: drop.momentum * 0.1,
            parent: drop,
          });
          if (trail !== null) {
            newDrops.push(trail);
            drop.r *= Math.pow(0.97, timeScale);
            drop.lastSpawn = 0;
            drop.nextSpawn =
              random(options.minR, options.maxR) -
              drop.momentum * 2 * options.trailRate +
              (options.maxR - drop.r);
          }
        }

        // The spread of a fresh (or just-merged) drop settles quickly.
        drop.spreadX *= Math.pow(0.4, timeScale);
        drop.spreadY *= Math.pow(0.7, timeScale);

        const moved = drop.momentum > 0;
        if (moved && !drop.killed) {
          drop.y += drop.momentum * options.globalTimeScale;
          drop.x += drop.momentumX * options.globalTimeScale;
          if (drop.y > rdHeight / rdScale + drop.r) drop.killed = true;
        }

        const checkCollision = (moved || drop.isNew) && !drop.killed;
        drop.isNew = false;

        if (checkCollision) {
          const end = Math.min(i + 70, drops.length);
          for (let j = i + 1; j < end; j += 1) {
            const other = drops[j];
            if (
              !other ||
              drop === other ||
              drop.r <= other.r ||
              drop.parent === other ||
              other.parent === drop ||
              other.killed
            ) {
              continue;
            }
            const dx = other.x - drop.x;
            const dy = other.y - drop.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (
              dist <
              (drop.r + other.r) *
                (options.collisionRadius +
                  drop.momentum * options.collisionRadiusIncrease * timeScale)
            ) {
              // Merge by area (the smaller drop only contributes 80% — some water is lost to the
              // glass) and give the survivor a burst of speed.
              const a1 = Math.PI * drop.r * drop.r;
              const a2 = Math.PI * other.r * other.r;
              const targetR = Math.min(options.maxR, Math.sqrt((a1 + a2 * 0.8) / Math.PI));
              drop.r = targetR;
              drop.momentumX += dx * 0.1;
              drop.spreadX = 0;
              drop.spreadY = 0;
              other.killed = true;
              drop.momentum = Math.max(
                other.momentum,
                Math.min(
                  40,
                  drop.momentum + targetR * options.collisionBoostMultiplier + options.collisionBoost,
                ),
              );
            }
          }
        }

        // Friction: momentum decays, faster for small drops, and sideways drift dies quickly.
        drop.momentum -= Math.max(1, options.minR * 0.5 - drop.momentum) * 0.1 * timeScale;
        if (drop.momentum < 0) drop.momentum = 0;
        drop.momentumX *= Math.pow(0.7, timeScale);

        if (!drop.killed) {
          newDrops.push(drop);
          if (moved && options.dropletsRate > 0) {
            clearDroplets(drop.x, drop.y, drop.r * options.dropletsCleaningRadiusMultiplier);
          }
          drawDrop(rdCtx, drop.x, drop.y, drop.r, drop.spreadX, drop.spreadY);
        }
      }

      drops = newDrops;
    };

    // ── Background + GPU side ──────────────────────────────────────────────
    const makeBgTextures = (): { fg: THREE.CanvasTexture; bg: THREE.CanvasTexture } => {
      // Sharp version seen through drops is tiny on purpose: linear magnification of a 96×64
      // canvas is itself a soft focus, matching the original exactly.
      const fgCanvas = generateCityBg(96, 64, fgBlur, bgSeed);
      const bgCanvas = generateCityBg(384, 256, bgBlur, bgSeed);
      const fg = new THREE.CanvasTexture(fgCanvas);
      const bg = new THREE.CanvasTexture(bgCanvas);
      for (const t of [fg, bg]) {
        t.wrapS = THREE.ClampToEdgeWrapping;
        t.wrapT = THREE.ClampToEdgeWrapping;
        t.minFilter = THREE.LinearFilter;
        t.magFilter = THREE.LinearFilter;
        // The shader does its own y-down mapping (texCoord flips vUv), exactly as the original
        // did against WebGL's unflipped upload. three.js flips canvas uploads by default, which
        // would double-flip everything — so switch that off.
        t.flipY = false;
        t.needsUpdate = true;
      }
      return { fg, bg };
    };

    let bgTextures = makeBgTextures();
    scope.defer(() => {
      bgTextures.fg.dispose();
      bgTextures.bg.dispose();
    });

    const waterTexture = scope.ownDisposable(new THREE.CanvasTexture(rdCanvas));
    waterTexture.wrapS = THREE.ClampToEdgeWrapping;
    waterTexture.wrapT = THREE.ClampToEdgeWrapping;
    waterTexture.minFilter = THREE.LinearFilter;
    waterTexture.magFilter = THREE.LinearFilter;
    // Same reason as the background textures: the shader already samples y-down.
    waterTexture.flipY = false;

    const uniforms = {
      uWaterMap: { value: waterTexture as THREE.Texture },
      uTextureFg: { value: bgTextures.fg as THREE.Texture },
      uTextureBg: { value: bgTextures.bg as THREE.Texture },
      uResolution: { value: new THREE.Vector2(1, 1) },
      // The inset margin (in pixels) the original derived from its unused parallax feature.
      uParallaxFg: { value: 20.0 },
      uTextureRatio: { value: 384 / 256 },
      uMinRefraction: { value: 256.0 * refraction },
      uRefractionDelta: { value: 256.0 * refraction },
      uBrightness: { value: num(ctx.params, "brightness", 1.04, 0.5, 2) },
      uAlphaMultiply: { value: 6.0 },
      uAlphaSubtract: { value: 3.0 },
    };

    const geometry = scope.ownDisposable(new THREE.PlaneGeometry(2, 2));
    const material = scope.ownDisposable(
      new THREE.ShaderMaterial({
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        uniforms,
        depthTest: false,
        depthWrite: false,
      }),
    );
    const quad = new THREE.Mesh(geometry, material);
    quad.frustumCulled = false;
    stage.scene.add(quad);

    initSim();
    uniforms.uResolution.value.set(rdWidth, rdHeight);

    stage.onResize(() => {
      // Same policy as the original's window-resize handler: rebuild the water surfaces at the
      // new size. Existing drops are lost, which the original accepted too.
      initSim();
      uniforms.uResolution.value.set(rdWidth, rdHeight);
    });

    // ── Interaction: click to splash, drag to wipe ─────────────────────────
    const canvas = stage.renderer.domElement;
    let pointerDown = false;

    const toSim = (e: PointerEvent): { x: number; y: number } => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: ((e.clientX - rect.left) / rect.width) * (rdWidth / rdScale),
        y: ((e.clientY - rect.top) / rect.height) * (rdHeight / rdScale),
      };
    };

    const createSplash = (x: number, y: number): void => {
      const main = createDrop({
        x,
        y,
        r: random(options.minR * 1.5, options.maxR),
        momentum: 1 + random(0, 3),
        spreadX: 2.0,
        spreadY: 2.0,
      });
      if (main !== null) drops.push(main);

      // Satellite drops flung out around the impact.
      for (let i = 0; i < 8; i += 1) {
        const angle = Math.random() * Math.PI * 2;
        const dist = 10 + Math.random() * 30;
        const sat = createDrop({
          x: x + Math.cos(angle) * dist,
          y: y + Math.sin(angle) * dist,
          r: random(options.minR * 0.5, options.minR * 1.2),
          momentum: 0.5 + Math.random() * 1.5,
          spreadX: 1.0,
          spreadY: 1.0,
        });
        if (sat !== null) drops.push(sat);
      }
      // A dusting of mist in the splash area.
      for (let j = 0; j < 20; j += 1) {
        const sa = Math.random() * Math.PI * 2;
        const sd = 5 + Math.random() * 25;
        drawDroplet(
          x + Math.cos(sa) * sd,
          y + Math.sin(sa) * sd,
          random(options.dropletsSizeMin, options.dropletsSizeMax),
        );
      }
    };

    const wipeAt = (x: number, y: number): void => {
      const wipeR = 60;
      const killR = wipeR * 0.5;
      const pushR = wipeR * 1.5;
      clearDroplets(x, y, wipeR);
      for (let i = drops.length - 1; i >= 0; i -= 1) {
        const d = drops[i];
        if (!d) continue;
        const dx = d.x - x;
        const dy = d.y - y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < killR) {
          drops.splice(i, 1);
        } else if (dist < pushR) {
          const push = (1 - (dist - killR) / (pushR - killR)) * 20;
          d.x += (dx / dist) * push;
          d.y += (dy / dist) * push * 0.6;
        }
      }
    };

    const onPointerDown = (e: PointerEvent): void => {
      if (!interactive) return;
      pointerDown = true;
      const p = toSim(e);
      createSplash(p.x, p.y);
    };
    const onPointerMove = (e: PointerEvent): void => {
      if (!interactive || !pointerDown) return;
      const p = toSim(e);
      wipeAt(p.x, p.y);
    };
    const onPointerUp = (): void => {
      pointerDown = false;
    };
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    scope.defer(() => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    });

    // ── Frame loop ─────────────────────────────────────────────────────────
    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      // The original normalised its clock to 60 ticks/second and clamped the step, so all its
      // decay constants are per-tick. Recreate exactly that tick from the SDK's dt (in seconds).
      let timeScale = (dt * 1000) / ((1 / 60) * 1000);
      if (timeScale > 1.1) timeScale = 1.1;
      timeScale *= options.globalTimeScale;

      rdCtx.clearRect(0, 0, rdWidth, rdHeight);
      updateDrops(timeScale);
      // The water map changed this frame; tell three.js to re-upload it to the GPU.
      waterTexture.needsUpdate = true;

      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        options = readOptions(p);
        interactive = bool(p, "interactive", true);
        refraction = num(p, "refraction", 1, 0, 3);
        uniforms.uMinRefraction.value = 256.0 * refraction;
        uniforms.uRefractionDelta.value = 256.0 * refraction;
        uniforms.uBrightness.value = num(p, "brightness", 1.04, 0.5, 2);

        // Repainting the cityscape is a few milliseconds of canvas work — cheap enough to do in
        // place, but only when one of its inputs actually changed.
        const newSeed = int(p, "bgSeed", 42, 1, 9999);
        const newBgBlur = num(p, "bgBlur", 8, 0, 24);
        const newFgBlur = num(p, "fgBlur", 1, 0, 8);
        if (newSeed !== bgSeed || newBgBlur !== bgBlur || newFgBlur !== fgBlur) {
          bgSeed = newSeed;
          bgBlur = newBgBlur;
          fgBlur = newFgBlur;
          const old = bgTextures;
          bgTextures = makeBgTextures();
          uniforms.uTextureFg.value = bgTextures.fg;
          uniforms.uTextureBg.value = bgTextures.bg;
          old.fg.dispose();
          old.bg.dispose();
        }
      },
    };
  },
});
