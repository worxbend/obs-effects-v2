import * as THREE from "three";

import { at, colorHex, num, rgb01, str } from "../paramUtils";
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
 * Pigment Mix
 * ===========
 *
 * A sheet of warm off-white paper on which a separate pool of watercolour blooms for each of the
 * audio inputs OBS is mixing: the microphone in ink blue, the desktop or game in burnt orange, the
 * music bed in moss green, and everything else in plum. A pool grows quickly when its input gets
 * loud and then dries *slowly* — over several seconds — so the frame stops being a meter and becomes
 * a short record of who has been making noise.
 *
 * It is deliberately the one background here that is not neon on black.
 *
 * Why the colours multiply instead of adding
 * ------------------------------------------
 * Almost every other reactive effect in this project adds light: two glows overlapping get
 * *brighter*, because that is what light does. Paint does the opposite. A pigment works by
 * *absorbing* part of the light passing through it, so laying blue over orange removes more of the
 * spectrum and the result goes muddy brown — darker than either one alone. That is called
 * subtractive mixing, and it is the single thing that makes a picture read as paint rather than as
 * coloured light.
 *
 * The shader models it literally. Each pool contributes a *transmission* colour: white where there
 * is no pigment, and the ink's own colour where the pigment is thick. Those transmissions are
 * multiplied together, and the paper is multiplied by the result:
 *
 * ```
 * transmission = 1 · mix(white, inkA, amountA) · mix(white, inkB, amountB) · …
 * pixel        = paper · transmission
 * ```
 *
 * Multiplying can only ever make a pixel darker, which is exactly the guarantee real paint gives.
 *
 * The multiply happens in **linear light** rather than in the gamma-encoded values a colour picker
 * hands you, because that is the space in which absorption actually behaves this way; the inks and
 * the paper are converted once on the processor and only the finished pixel is converted back. Mixing
 * in gamma space gives washed-out, slightly chalky overlaps — the classic giveaway of a blend done
 * in the wrong space.
 *
 * Why there is a dark ring at the edge of every pool
 * -------------------------------------------------
 * When a real puddle of watercolour dries, the water evaporates fastest at the rim and drags pigment
 * outwards with it, leaving a distinctly darker line where the puddle stopped. Painters call it a
 * hard edge or a bloom line. Without it, a soft blob of colour reads as an airbrush glow — which is
 * what every other overlay in this project already looks like. So each pool draws two things: a
 * light interior wash (the Density parameter) and a narrow, darker band sitting on its boundary (the
 * Rim parameter). The rim is what sells the whole effect, so it is the first slider to reach for.
 *
 * Why the paper grain never moves
 * -------------------------------
 * The fibre texture is computed from the pixel's own position and from nothing else — no clock is
 * involved anywhere in it. A texture that shimmers or scrolls is the immediate tell that a paper
 * background is fake, because paper does not move. The only thing that moves is the pigment, and the
 * shared warp field that gives each pool its irregular edge is likewise fixed to the sheet: a pool
 * drifting slowly across it changes shape organically, the way a stain spreading through real fibres
 * would, without the field itself ever appearing to animate.
 *
 * How the audio is read, and what happens when there is none
 * ----------------------------------------------------------
 * `bus.inputs` carries the loudness OBS measured for each named audio input separately — the real,
 * measured numbers, not the derived spectrum the rest of the SDK offers. Each input's name is
 * matched, case-insensitively and as a substring, against the three name fragments below ("Mic",
 * "Desktop", "Music" by default); the first fragment that matches wins, and anything that matches
 * none of them is collected into the fourth pool. That is the whole reason this effect exists: an
 * audience can read the frame at a glance and see *which* source is loud.
 *
 * When OBS is not connected — and on the simulated feed, which is what a preview shows — `bus.inputs`
 * is empty. There is then only one real number, `bus.level`, so the four pools are driven from it at
 * different weights with a slow individual swing on each, which keeps the overlaps visibly moving so
 * the subtractive mixing can still be judged in a preview. Both cases produce the same four target
 * numbers and then run through exactly the same attack/release trackers, so the path that runs on air
 * is the path that runs in preview.
 *
 * Attack, and why drying is so slow
 * ---------------------------------
 * Each pool eases towards its target with a fast rise (Attack, a sixth of a second by default) and a
 * very slow fall (Dry, six seconds). Both are expressed as time constants and applied with
 * `1 - e^(-dt/tau)`, which is the frame-rate-independent form: the stain takes the same six seconds
 * to fade at 30 frames per second and at 144. A per-frame multiplier would fade twice as fast on a
 * 120 Hz display, which is the bug this shape avoids.
 */

/** How many pigment pools exist. Fixed, because it is also the size of the shader's uniform arrays. */
const SLOT_COUNT = 4;

/**
 * Where each pool sits before it drifts.
 *
 * X is a fraction of the frame *width* (it is multiplied by the aspect ratio at draw time, so the
 * pools stay spread out on a wide source instead of bunching in the middle); Y is a fraction of the
 * frame height, positive being up. They are typed arrays so `at()` can read them without the
 * compiler's index checks needing a guard at every use.
 */
const BASE_X = new Float32Array([-0.26, 0.24, -0.07, 0.15]);
const BASE_Y = new Float32Array([0.13, -0.05, -0.24, 0.25]);

/** A fixed per-pool offset, so nothing anywhere in this effect moves in step with anything else. */
const PHASE = new Float32Array([0.0, 1.9, 3.7, 5.2]);

/**
 * Drift rates, in radians per second of drift clock.
 *
 * They are deliberately not multiples of one another. Rates that share a common factor would bring
 * the pools back into the same relative arrangement every so often, which the eye picks up as a loop.
 */
const DRIFT_RATE_X = new Float32Array([0.11, 0.087, 0.134, 0.071]);
const DRIFT_RATE_Y = new Float32Array([0.079, 0.121, 0.093, 0.113]);

/** How far a pool wanders from its base position, as a fraction of the frame. Small on purpose. */
const DRIFT_SPAN_X = 0.09;
const DRIFT_SPAN_Y = 0.07;

/** How much of the single broadband level each pool takes when OBS reports no named inputs. */
const FALLBACK_WEIGHT = new Float32Array([1.0, 0.62, 0.4, 0.24]);

/** How fast each pool's fallback swing breathes, in radians per second. */
const FALLBACK_RATE = new Float32Array([0.23, 0.31, 0.19, 0.27]);

const FRAGMENT_SHADER = assembleFragment(
  ["hash12", "vnoise", "fbmVnoise", "srgb"],
  /* glsl */ `
  varying vec2 vUv;

  uniform vec2 uResolution;
  // Paper and inks arrive already converted to linear light by the processor, so the per-pixel work
  // below is a plain multiply and only the finished colour has to be converted back.
  uniform vec3 uPaper;
  uniform vec3 uInk[4];
  // One pool per entry: x is how much pigment it currently holds (0..1), y is its fixed phase,
  // and zw is its centre in the same aspect-corrected space the pixel coordinate uses.
  uniform vec4 uPool[4];
  uniform float uGrain;
  uniform float uBloom;
  uniform float uSpread;
  uniform float uDensity;
  uniform float uRim;
  uniform float uShade;
  uniform float uOpacity;

  void main() {
    vec2 uvN = vUv;
    // Correct for the aspect ratio so a pool is round on a wide source rather than an ellipse.
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 p = (uvN - 0.5) * vec2(aspect, 1.0);

    // ── The sheet ──────────────────────────────────────────────────────────────────────────────
    // Two textures, and neither one takes a clock: paper does not move, and a grain that shimmers
    // is the first thing that gives away a fake one.
    //
    //   mottle — a soft cloudy variation at the scale of a few centimetres, which is what makes
    //            cold-pressed paper look handmade rather than printed.
    //   fibre  — the fine tooth of the surface. Its two axes are scaled differently on purpose, so
    //            the grain is stretched sideways the way milled paper fibres are. Both are measured
    //            against the sheet rather than against the pixel grid, so the tooth stays a few
    //            pixels wide instead of becoming per-pixel static, which reads as television snow
    //            and costs a video encoder a great deal of bitrate for nothing.
    float mottle = vnoise(p * 11.0);
    float fibre = vnoise(p * vec2(190.0, 340.0) + 17.0);
    vec3 paper = uPaper * (1.0 + uGrain * ((mottle - 0.5) * 0.85 + (fibre - 0.5) * 0.75));

    // A gentle shadow towards the edges of the sheet that deepens with overall loudness, so the
    // whole page responds to a peak even when no single pool has grown much.
    float vignette = smoothstep(0.20, 1.05, length(p));
    paper *= 1.0 - uShade * vignette;

    // ── One warp field, shared by every pool ───────────────────────────────────────────────────
    // Displacing the coordinate before measuring distance is what turns a circle into a ragged,
    // organic outline. It is computed once rather than per pool for two reasons: it costs a fifth
    // of the work, and it belongs to the paper, so two pools crossing the same patch of sheet
    // deform the same way — which is what makes them look like they are soaking into one surface.
    vec2 warp = vec2(
      fbmVnoise(p * 1.9 + vec2(11.3, 4.7)),
      fbmVnoise(p * 1.9 + vec2(2.8, 19.1))
    ) - 0.5;
    vec2 pw = p + warp * (uSpread * 0.40);

    // How wide the soft fall-off at a pool's boundary is.
    float soft = 0.30 + uSpread * 0.50;

    // ── The pools ──────────────────────────────────────────────────────────────────────────────
    // 'transmission' is the fraction of the paper's light that survives every layer of pigment.
    // It starts at white (nothing absorbed) and can only ever be reduced, which is precisely the
    // guarantee that makes overlaps go muddy instead of bright.
    vec3 transmission = vec3(1.0);

    // A fixed four iterations. The count is a literal so the compiler can unroll it, and the
    // energy test inside skips the noise lookup for a pool that has already dried away.
    for (int i = 0; i < 4; i++) {
      vec4 pool = uPool[i];
      float energy = pool.x;
      if (energy > 0.004) {
        // A second, much cheaper noise lookup keyed on this pool's own phase, so two pools sitting
        // on the same patch of paper still have edges of their own.
        float wobble = vnoise(pw * 3.4 + vec2(pool.y * 4.0, -pool.y * 2.6)) - 0.5;

        // Loudness grows the pool. It never shrinks to nothing: a dried stain keeps its size and
        // loses its colour, which is how a real one behaves.
        float radius = max(uBloom * (0.32 + 0.68 * energy), 0.001);
        float edge = (length(pw - pool.zw) + wobble * uSpread * 0.22) / radius;

        // The light interior wash.
        float body = 1.0 - smoothstep(1.0 - soft, 1.0, edge);
        // The dark deposit line at the drying edge: a narrow band centred just inside the boundary.
        // Written with an explicit multiply rather than pow(x, 2.0) because pow of a negative base
        // is undefined in GLSL, and this argument is negative everywhere inside the pool.
        float k = (edge - 0.88) * 7.0;
        float ring = exp(-k * k);

        float amount = clamp(body * uDensity + ring * uRim, 0.0, 1.0) * (0.30 + 0.70 * energy);
        transmission *= mix(vec3(1.0), uInk[i], amount);
      }
    }

    vec3 col = toSrgb(paper * transmission);

    // Straight (not premultiplied) alpha, so Opacity turns the whole sheet into a wash over
    // whatever is behind it. At Opacity 1 this is an ordinary opaque background.
    gl_FragColor = vec4(clamp(col, 0.0, 1.0), uOpacity);
  }
`,
);

/**
 * Clamps a measurement into 0..1 before it is trusted as a level.
 *
 * It takes `unknown` rather than `number` on purpose. The per-input peaks arrive as the output of
 * `JSON.parse` on the levels stream and are asserted to their contract type without being checked
 * (see `sdk/audio.ts`), so a truncated or hand-crafted frame really can deliver a string, a
 * `null`, or a missing field where a number is declared. Anything that is not a finite number is
 * read as silence.
 *
 * A `NaN` getting through here would not be cosmetic, it would be permanent: the smoothing below
 * is `current + (target - current) * alpha`, and once `current` is `NaN` every later frame is
 * `NaN` too, whatever the audio does. That value then reaches the shader as a uniform and blanks
 * the source for the rest of the broadcast, with nothing in the console to say why.
 */
function clamp01(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.min(1, Math.max(0, numeric)) : 0;
}

const pigmentMix = defineEffect({
  descriptor: {
    id: "pigment-mix",
    name: "Pigment Mix",
    description:
      "Warm paper on which a pool of watercolour blooms for each OBS audio input — voice in ink blue, game in burnt orange, music in moss — mixing subtractively and drying over several seconds, so the frame records who has been speaking.",
    engine: "three",
    category: "background",
    tags: ["background", "paper", "watercolour", "analogue", "audio", "reactive", "warm"],
    previewNotes:
      "A full-frame background. Opaque at Opacity 1; lower it to lay the wash over a game capture instead. Match the three name fragments to your own OBS input names — the effect only separates the pigments if it can recognise the inputs. With OBS disconnected the preview drives all four pools from one simulated level, so the pools breathe together rather than independently.",
    params: [
      {
        key: "inkA",
        label: "Pigment 1 (voice)",
        kind: "color",
        default: "#2b4a7d",
        description:
          "Colour of the pool for the first matched input. The default is an ink blue, for a microphone.",
      },
      {
        key: "inputA",
        label: "Input 1 Name Contains",
        kind: "text",
        default: "Mic",
        description:
          "Part of an OBS input's name, matched without regard to capitals. Any input whose name contains this gets the first pigment. Type a name no input has to leave this pigment unused.",
      },
      {
        key: "inkB",
        label: "Pigment 2 (game)",
        kind: "color",
        default: "#b8541f",
        description:
          "Colour of the pool for the second matched input. The default is a burnt orange, for desktop or game audio.",
      },
      {
        key: "inputB",
        label: "Input 2 Name Contains",
        kind: "text",
        default: "Desktop",
        description:
          "Part of an OBS input's name for the second pigment. Only inputs that did not already match the first fragment are considered.",
      },
      {
        key: "inkC",
        label: "Pigment 3 (music)",
        kind: "color",
        default: "#5f7a37",
        description:
          "Colour of the pool for the third matched input. The default is a moss green, for a music bed.",
      },
      {
        key: "inputC",
        label: "Input 3 Name Contains",
        kind: "text",
        default: "Music",
        description:
          "Part of an OBS input's name for the third pigment. Only inputs that matched neither of the first two fragments are considered.",
      },
      {
        key: "inkD",
        label: "Pigment 4 (everything else)",
        kind: "color",
        default: "#7a4a6b",
        description:
          "Colour of the pool that collects every input matching none of the three fragments above. Set it to the paper colour to hide it.",
      },
      {
        key: "paperColor",
        label: "Paper",
        kind: "color",
        default: "#f2ece0",
        description:
          "The sheet the pigment sits on. Warm off-white reads as paper; a cool grey reads as card.",
      },
      {
        key: "grain",
        label: "Paper Grain",
        kind: "number",
        default: 0.14,
        min: 0,
        max: 0.6,
        step: 0.01,
        description:
          "Strength of the fibre texture in the sheet. 0 is a perfectly flat surface; the texture never moves at any setting.",
      },
      {
        key: "bloomSize",
        label: "Pool Size",
        kind: "number",
        default: 0.34,
        min: 0.05,
        max: 0.9,
        step: 0.01,
        description:
          "How large a pool grows at full loudness, as a fraction of the frame height. Larger values make the pools overlap sooner, which is where the muddy mixing happens.",
      },
      {
        key: "spread",
        label: "Edge Spread",
        kind: "number",
        default: 0.55,
        min: 0,
        max: 1,
        step: 0.01,
        description:
          "How soft and how irregular a pool's outline is. Low is a tight, controlled puddle; high is a loose wash bleeding into the paper.",
      },
      {
        key: "density",
        label: "Wash Density",
        kind: "number",
        default: 0.45,
        min: 0,
        max: 1,
        step: 0.01,
        description:
          "How much pigment the flat interior of a pool carries. Keep it below the Rim, or the drying edge stops reading as a deposit line.",
      },
      {
        key: "rim",
        label: "Drying Edge",
        kind: "number",
        default: 0.55,
        min: 0,
        max: 1,
        step: 0.01,
        description:
          "How strongly pigment concentrates in the dark line at a pool's boundary. This is what makes it look like watercolour rather than an airbrush glow.",
      },
      {
        key: "attack",
        label: "Attack (seconds)",
        kind: "number",
        default: 0.15,
        min: 0.02,
        max: 2,
        step: 0.01,
        description:
          "How long a pool takes to grow when its input gets loud. Short, so speech lands on time.",
      },
      {
        key: "dry",
        label: "Dry (seconds)",
        kind: "number",
        default: 6,
        min: 0.5,
        max: 20,
        step: 0.5,
        description:
          "How long a pool takes to fade back once its input goes quiet. This is the memory of the frame: long values leave a stain behind a burst of speech instead of a pulse that vanishes.",
      },
      {
        key: "drift",
        label: "Drift",
        kind: "number",
        default: 0.5,
        min: 0,
        max: 3,
        step: 0.05,
        description:
          "How fast the pools wander around the sheet. Low values keep the frame alive without anything appearing to move; 0 pins each pool in place.",
      },
      {
        key: "shade",
        label: "Peak Shadow",
        kind: "number",
        default: 0.18,
        min: 0,
        max: 0.6,
        step: 0.01,
        description:
          "How much overall loudness darkens the edges of the sheet, so the whole page reacts to a peak. 0 keeps the paper evenly lit.",
      },
      {
        key: "opacity",
        label: "Opacity",
        kind: "number",
        default: 1,
        min: 0,
        max: 1,
        step: 0.01,
        description:
          "1 is a solid background sheet. Below 1 the whole thing becomes a wash over whatever is layered behind it in OBS.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    // Audio is acquired before the stage so that an effect disposed while this was in flight tears
    // down with no WebGL context ever having been built. `useAudio` never rejects and never
    // checkpoints for us, which is why the next line is not optional.
    const bus = await useAudio(scope);
    scope.checkpoint();
    const envelopes = createEnvelopes(bus);

    // Antialiasing off: a full-screen quad has no polygon edges to smooth, so multisampling costs
    // fill rate and changes nothing.
    const stage = createThreeStage(scope, ctx, {
      antialias: false,
      camera: { kind: "fullscreen-quad" },
    });

    /**
     * Reads a colour parameter and converts it to linear light.
     *
     * A `#rrggbb` value is gamma-encoded — that is what makes it look evenly spaced to the eye — and
     * absorption does not multiply correctly in that space. Raising each channel to the power 2.2 is
     * the standard approximation of the inverse of that encoding. Doing it here, once per parameter
     * change, keeps it out of the shader where it would run for every pixel of every frame.
     */
    const linearVec = (
      params: Record<string, unknown>,
      key: string,
      fallback: string,
    ): THREE.Vector3 => {
      const [r, g, b] = rgb01(colorHex(params, key, fallback));
      return new THREE.Vector3(Math.pow(r, 2.2), Math.pow(g, 2.2), Math.pow(b, 2.2));
    };

    /** Lower-cased once per parameter change, because the match runs for every input every frame. */
    const fragment = (params: Record<string, unknown>, key: string, fallback: string): string =>
      str(params, key, fallback).trim().toLowerCase();

    let matchA = fragment(ctx.params, "inputA", "Mic");
    let matchB = fragment(ctx.params, "inputB", "Desktop");
    let matchC = fragment(ctx.params, "inputC", "Music");
    let attack = num(ctx.params, "attack", 0.15, 0.02, 2);
    let dry = num(ctx.params, "dry", 6, 0.5, 20);
    let drift = num(ctx.params, "drift", 0.5, 0, 3);
    let shade = num(ctx.params, "shade", 0.18, 0, 0.6);

    // The four ink colours are held as named vectors rather than read out of the array, so that
    // `setParams` can copy into each one without an index the compiler has to be talked out of.
    const inkA = linearVec(ctx.params, "inkA", "#2b4a7d");
    const inkB = linearVec(ctx.params, "inkB", "#b8541f");
    const inkC = linearVec(ctx.params, "inkC", "#5f7a37");
    const inkD = linearVec(ctx.params, "inkD", "#7a4a6b");

    // One vec4 per pool, mutated in place every frame. three.js flattens this array into the
    // shader's `uniform vec4 uPool[4]` for us, so the objects must never be replaced — only written.
    const pools: THREE.Vector4[] = [
      new THREE.Vector4(),
      new THREE.Vector4(),
      new THREE.Vector4(),
      new THREE.Vector4(),
    ];

    const uniforms = {
      uResolution: { value: new THREE.Vector2(stage.width, stage.height) },
      uPaper: { value: linearVec(ctx.params, "paperColor", "#f2ece0") },
      uInk: { value: [inkA, inkB, inkC, inkD] },
      uPool: { value: pools },
      uGrain: { value: num(ctx.params, "grain", 0.14, 0, 0.6) },
      uBloom: { value: num(ctx.params, "bloomSize", 0.34, 0.05, 0.9) },
      uSpread: { value: num(ctx.params, "spread", 0.55, 0, 1) },
      uDensity: { value: num(ctx.params, "density", 0.45, 0, 1) },
      uRim: { value: num(ctx.params, "rim", 0.55, 0, 1) },
      uShade: { value: 0 },
      uOpacity: { value: num(ctx.params, "opacity", 1, 0, 1) },
    };

    const geometry = scope.ownDisposable(new THREE.PlaneGeometry(2, 2));
    const material = scope.ownDisposable(
      new THREE.ShaderMaterial({
        vertexShader: FULLSCREEN_VERTEX,
        fragmentShader: FRAGMENT_SHADER,
        uniforms,
        // Transparent with *straight* alpha rather than premultiplied, and left transparent even at
        // full Opacity. A blend of `src * 1 + dst * 0` is bit-for-bit the same as not blending at
        // all, so an opaque sheet costs nothing, and the Opacity slider can then be dragged live
        // without the material having to be rebuilt mid-broadcast.
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    );

    const quad = new THREE.Mesh(geometry, material);
    quad.frustumCulled = false;
    stage.scene.add(quad);

    /**
     * The width-to-height ratio of the canvas, used to spread the pool centres across a wide source.
     *
     * A source can legitimately report a zero height for a frame or two while OBS is resizing it, and
     * dividing by that would put a NaN into a uniform and blank the picture permanently — a NaN
     * poisons every value it touches and never recovers. The guard is cheap; the failure is not.
     */
    let aspect = stage.height > 0 ? stage.width / stage.height : 1;

    stage.onResize((w, h) => {
      uniforms.uResolution.value.set(w, h);
      aspect = h > 0 ? w / h : 1;
    });

    /** How much pigment each pool is currently holding, 0..1. This is the state that dries slowly. */
    const energies = new Float32Array(SLOT_COUNT);
    /** Where each pool is being pulled towards this frame. Rewritten every frame, never allocated. */
    const targets = new Float32Array(SLOT_COUNT);

    /** Seconds of drift, advanced at the Drift rate so changing it alters the speed, not the position. */
    let driftClock = 0;
    /** Plain seconds, used only by the no-inputs fallback swing so it keeps breathing at Drift 0. */
    let idleClock = 0;

    /** Which pool an OBS input belongs to. The first fragment that matches wins; 3 catches the rest. */
    const slotFor = (lowerCaseName: string): number => {
      if (matchA !== "" && lowerCaseName.includes(matchA)) return 0;
      if (matchB !== "" && lowerCaseName.includes(matchB)) return 1;
      if (matchC !== "" && lowerCaseName.includes(matchC)) return 2;
      return 3;
    };

    /**
     * Fills `targets` with where each pool should be heading.
     *
     * Both routes end in the same four numbers running through the same trackers below, which is the
     * point: the code that runs on air with OBS connected is the code that runs in a preview, so a
     * fault cannot hide in a branch that only the preview exercises.
     */
    const readTargets = (): void => {
      targets.fill(0);

      // Counted and indexed rather than walked with `for ... of`, and the count is checked rather
      // than trusted. Both are for the same reason as `clamp01` below: this list is the output of
      // an unchecked `JSON.parse` (see `sdk/audio.ts`), so a truncated frame can leave `inputs`
      // missing or holding something that is not a list at all. `for ... of` on such a value
      // throws, and a throw in a frame callback gets the effect unsubscribed from the shared clock
      // — a source frozen on air, which is the worst outcome this project has. A count of zero is
      // simply the no-inputs case, which already has a sensible branch.
      const inputs = bus.inputs;
      const inputCount = typeof inputs?.length === "number" ? inputs.length : 0;

      if (inputCount === 0) {
        // No named inputs: OBS is not connected, or the feed has gone stale and the bus is producing
        // its simulated signal. There is one honest number, so all four pools share it at different
        // weights, each with its own slow swing so they do not move as one rigid block.
        const level = clamp01(bus.level);
        for (let i = 0; i < SLOT_COUNT; i += 1) {
          const swing = 0.55 + 0.45 * Math.sin(idleClock * at(FALLBACK_RATE, i) + at(PHASE, i));
          targets[i] = level * at(FALLBACK_WEIGHT, i) * swing;
        }
      } else {
        // Real, measured per-input peaks. Several inputs can land in the same pool — two microphones
        // on a co-stream, say — in which case the loudest of them drives it.
        for (let i = 0; i < inputCount; i += 1) {
          const input = inputs[i];
          if (input === undefined) continue;
          // The name is declared as a string but, again, is not validated on the way in, and
          // `undefined.toLowerCase()` here would take the effect off the clock. An input with no
          // usable name matches no fragment and lands in the catch-all pool, which is right.
          const name = typeof input.inputName === "string" ? input.inputName.toLowerCase() : "";
          const slot = slotFor(name);
          targets[slot] = Math.max(at(targets, slot), clamp01(input.peak));
        }
      }

      // A square root, for the same reason `sdk/envelopes.ts` uses one: loudness as a plain
      // multiplier is a power measurement, and hearing is closer to logarithmic, so without this
      // curve everything below about a third of full scale barely stains the paper at all — which is
      // most ordinary speech.
      for (let i = 0; i < SLOT_COUNT; i += 1) {
        targets[i] = Math.sqrt(clamp01(at(targets, i)));
      }
    };

    onFrame(scope, ctx.fpsCap, ({ dt, now }) => {
      bus.sample(now);
      envelopes.update(dt);

      idleClock += dt;
      driftClock += dt * drift;

      readTargets();

      for (let i = 0; i < SLOT_COUNT; i += 1) {
        const target = at(targets, i);
        const current = at(energies, i);

        // Fast up, very slow down. `1 - e^(-dt/tau)` is the frame-rate-independent form of an eased
        // step: doubling the frame rate halves each step, so a stain takes the same number of
        // seconds to dry at 30 frames per second and at 144.
        const tau = target > current ? attack : dry;
        const alpha = dt <= 0 ? 0 : 1 - Math.exp(-dt / tau);
        const next = current + (target - current) * alpha;
        energies[i] = next;

        const pool = pools[i];
        if (pool === undefined) continue;

        // A slow wander. Two sines at unrelated rates trace a lazy figure that never repeats on any
        // timescale a viewer would notice, which is all this needs to be.
        const x =
          at(BASE_X, i) * aspect +
          Math.sin(driftClock * at(DRIFT_RATE_X, i) + at(PHASE, i)) * DRIFT_SPAN_X;
        const y =
          at(BASE_Y, i) +
          Math.sin(driftClock * at(DRIFT_RATE_Y, i) + at(PHASE, i) * 1.7) * DRIFT_SPAN_Y;

        pool.set(next, at(PHASE, i), x, y);
      }

      // The slow envelope rather than the raw level, so the page's shadow follows the body of the
      // sound and ignores individual hits — a flickering vignette would be unwatchable. Clamped
      // for the same reason the pool targets are: this multiplies the paper colour, so one
      // non-finite value here would turn the whole sheet into a permanently blank frame.
      uniforms.uShade.value = shade * clamp01(envelopes.slow);

      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        matchA = fragment(p, "inputA", "Mic");
        matchB = fragment(p, "inputB", "Desktop");
        matchC = fragment(p, "inputC", "Music");
        attack = num(p, "attack", 0.15, 0.02, 2);
        dry = num(p, "dry", 6, 0.5, 20);
        drift = num(p, "drift", 0.5, 0, 3);
        shade = num(p, "shade", 0.18, 0, 0.6);

        // Copied into the existing vectors rather than replaced, because the uniform array holds
        // references to these four objects and swapping one out would leave the shader reading the
        // old colour forever.
        inkA.copy(linearVec(p, "inkA", "#2b4a7d"));
        inkB.copy(linearVec(p, "inkB", "#b8541f"));
        inkC.copy(linearVec(p, "inkC", "#5f7a37"));
        inkD.copy(linearVec(p, "inkD", "#7a4a6b"));

        uniforms.uPaper.value.copy(linearVec(p, "paperColor", "#f2ece0"));
        uniforms.uGrain.value = num(p, "grain", 0.14, 0, 0.6);
        uniforms.uBloom.value = num(p, "bloomSize", 0.34, 0.05, 0.9);
        uniforms.uSpread.value = num(p, "spread", 0.55, 0, 1);
        uniforms.uDensity.value = num(p, "density", 0.45, 0, 1);
        uniforms.uRim.value = num(p, "rim", 0.55, 0, 1);
        uniforms.uOpacity.value = num(p, "opacity", 1, 0, 1);
      },
    };
  },
});

export default pigmentMix;
