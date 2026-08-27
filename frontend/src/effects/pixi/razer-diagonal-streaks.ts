import * as PIXI from "pixi.js";

import { colorHex, colorInt, int, num } from "../paramUtils";
import { createEnvelopes, createPixiStage, defineEffect, onFrame, useAudio } from "../sdk";

/**
 * Razer Diagonal Streaks
 * ======================
 *
 * An endless field of rounded "speed line" capsules sliding along a fixed diagonal, in layered
 * depths so the near ones rush past while the far ones barely move. With audio connected the whole
 * field surges on the beat.
 *
 * Ported from `razer-diagonal-streaks.html` in the old `obs-effects` repository. That repository
 * had six colour variants of this one class — razer, cyan, magenta, amber, ultraviolet, whiteout —
 * and all six are reachable here by changing the five colour parameters, so only one entry is in
 * the dropdown.
 *
 * The trick that makes it seamless
 * --------------------------------
 * The obvious way to build this is to give each streak an x/y velocity and wrap it when it leaves
 * the screen. That produces a visible pop, because a rectangle's edges are not perpendicular to a
 * diagonal path: a streak leaving through the left edge has to reappear somewhere along the
 * *bottom*, and getting that mapping right for an arbitrary angle is fiddly.
 *
 * Instead every streak lives in an **oriented coordinate system**: `u` runs along the direction of
 * travel and `w` runs across it. Movement is then a single subtraction from `u`, and wrapping is
 * one comparison against a span computed by projecting the four screen corners onto those axes. The
 * field tiles perfectly at any angle and any canvas size, and nothing ever pops.
 *
 * Depth
 * -----
 * Each streak gets a random `depth` from 0 to 1, and its length, width, speed and opacity are all
 * derived from it. Near streaks are long, thick, fast and bright; far ones are short, thin, slow and
 * dim. Sorting by speed before drawing puts the near ones on top. That single number is what turns
 * a flat scatter of lines into something with distance in it.
 */

/** One capsule in the field. */
interface Streak {
  /** Position along the direction of travel. */
  u: number;
  /** Fixed offset across it — which "lane" this streak occupies. */
  w: number;
  len: number;
  width: number;
  color: string;
  alpha: number;
  /** Pixels per second along `u`, before any boost. */
  speed: number;
  twinklePhase: number;
  twinkleRate: number;
  /** 0 = far, 1 = near. Everything above is derived from this. */
  depth: number;
}

const razerDiagonalStreaks = defineEffect({
  descriptor: {
    id: "razer-diagonal-streaks",
    name: "Razer Diagonal Streaks",
    description:
      "An endless field of rounded speed lines sliding along a diagonal in layered depths, surging with the audio when OBS is connected.",
    engine: "pixi",
    category: "background",
    tags: ["razer", "background", "streaks", "speed", "reactive", "green"],
    previewNotes:
      "A full-frame background. The background fill is transparent by default, so it can also be laid over a scene. The old repository's cyan, magenta, amber, ultraviolet and whiteout variants are all reachable from the five colour parameters.",
    params: [
      {
        key: "count",
        label: "Streak Count",
        kind: "number",
        default: 320,
        min: 20,
        max: 1200,
        step: 10,
        description:
          "How many capsules are in the field. This is the performance control — each one is a stroked line every frame.",
      },
      {
        key: "angle",
        label: "Angle",
        kind: "number",
        default: -32,
        min: -90,
        max: 90,
        step: 1,
        description:
          "Direction of travel, in degrees. 0 is straight across; negative slopes up to the right, which is the original.",
      },
      {
        key: "speed",
        label: "Speed",
        kind: "number",
        default: 1,
        min: 0,
        max: 4,
        step: 0.05,
        description:
          "Multiplier on how fast the field moves. 0 leaves it still but still twinkling.",
      },
      {
        key: "widthScale",
        label: "Thickness",
        kind: "number",
        default: 1,
        min: 0.2,
        max: 4,
        step: 0.05,
        description: "Multiplier on capsule thickness.",
      },
      {
        key: "lengthScale",
        label: "Length",
        kind: "number",
        default: 1,
        min: 0.2,
        max: 3,
        step: 0.05,
        description:
          "Multiplier on capsule length. Long and thin reads as speed; short and fat reads as rain.",
      },
      {
        key: "opacity",
        label: "Opacity",
        kind: "number",
        default: 1,
        min: 0.05,
        max: 1,
        step: 0.05,
        description: "Master opacity of the streaks.",
      },
      {
        key: "reactivity",
        label: "Reactivity",
        kind: "number",
        default: 1,
        min: 0,
        max: 3,
        step: 0.05,
        description:
          "How strongly the audio surges the field. 0 ignores audio entirely and gives a steady drift.",
      },
      {
        key: "color1",
        label: "Colour 1",
        kind: "color",
        default: "#44ff00",
        description: "Streak colours are picked at random from these five.",
      },
      { key: "color2", label: "Colour 2", kind: "color", default: "#7cff2a", description: "" },
      { key: "color3", label: "Colour 3", kind: "color", default: "#00ff66", description: "" },
      { key: "color4", label: "Colour 4", kind: "color", default: "#b6ff00", description: "" },
      { key: "color5", label: "Colour 5", kind: "color", default: "#1eff00", description: "" },
      {
        key: "backgroundColor",
        label: "Background Colour",
        kind: "color",
        default: "#000800",
        description: "Only visible when Background Opacity is above 0.",
      },
      {
        key: "backgroundOpacity",
        label: "Background Opacity",
        kind: "number",
        default: 0.16,
        min: 0,
        max: 1,
        step: 0.02,
        description:
          "How solid the fill behind the streaks is. 0 makes the effect a pure overlay; 1 makes it an opaque background.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    const bus = await useAudio(scope);
    scope.checkpoint();
    const envelopes = createEnvelopes(bus);

    const stage = await createPixiStage(scope, ctx);
    const graphics = stage.stage.addChild(new PIXI.Graphics());

    let count = int(ctx.params, "count", 320, 20, 1200);
    let angleDegrees = num(ctx.params, "angle", -32, -90, 90);
    let speedScale = num(ctx.params, "speed", 1, 0, 4);
    let widthScale = num(ctx.params, "widthScale", 1, 0.2, 4);
    let lengthScale = num(ctx.params, "lengthScale", 1, 0.2, 3);
    let opacity = num(ctx.params, "opacity", 1, 0.05, 1);
    let reactivity = num(ctx.params, "reactivity", 1, 0, 3);
    let backgroundColor = colorInt(ctx.params, "backgroundColor", "#000800");
    let backgroundOpacity = num(ctx.params, "backgroundOpacity", 0.16, 0, 1);

    const readColors = (p: Record<string, unknown>): string[] => [
      colorHex(p, "color1", "#44ff00"),
      colorHex(p, "color2", "#7cff2a"),
      colorHex(p, "color3", "#00ff66"),
      colorHex(p, "color4", "#b6ff00"),
      colorHex(p, "color5", "#1eff00"),
    ];
    let colors = readColors(ctx.params);

    const streaks: Streak[] = [];

    // The oriented axes and the bounds of the field in them. Recomputed on resize and whenever the
    // angle changes, because both change where the corners project to.
    let ux = 1;
    let uy = 0;
    let wx = 0;
    let wy = 1;
    let uMin = 0;
    let uSpan = 1;
    let wMin = 0;
    let wSpan = 1;

    /** Projects the four screen corners onto the oriented axes to find the field's extent. */
    const measure = (): void => {
      const radians = (angleDegrees * Math.PI) / 180;
      ux = Math.cos(radians);
      uy = Math.sin(radians);
      wx = -uy;
      wy = ux;

      const width = stage.width;
      const height = stage.height;
      // Padding so a capsule is fully off-screen before it wraps; the longest one is a quarter of
      // the larger dimension plus its own length.
      const margin = Math.max(width, height) * 0.25;

      let lowU = Infinity;
      let highU = -Infinity;
      let lowW = Infinity;
      let highW = -Infinity;
      for (const [cx, cy] of [
        [0, 0],
        [width, 0],
        [0, height],
        [width, height],
      ] as const) {
        const u = cx * ux + cy * uy;
        const w = cx * wx + cy * wy;
        lowU = Math.min(lowU, u);
        highU = Math.max(highU, u);
        lowW = Math.min(lowW, w);
        highW = Math.max(highW, w);
      }

      uMin = lowU - margin;
      uSpan = highU - lowU + margin * 2;
      wMin = lowW - margin;
      wSpan = highW - lowW + margin * 2;
    };

    /** Fills the field from scratch. */
    const seed = (): void => {
      streaks.length = 0;
      for (let i = 0; i < count; i += 1) {
        // Depth drives everything, and it is squared for the length so the near band is
        // dramatically longer rather than evenly graded — which is what sells the parallax.
        const depth = Math.random();
        streaks.push({
          u: uMin + Math.random() * uSpan,
          w: wMin + Math.random() * wSpan,
          len: 60 + depth * depth * 520 + Math.random() * 80,
          width: 4 + depth * 18,
          color: colors[Math.floor(Math.random() * colors.length)] ?? "#44ff00",
          alpha: 0.28 + depth * 0.62,
          speed: 90 + depth * 360,
          twinklePhase: Math.random() * Math.PI * 2,
          twinkleRate: 0.4 + Math.random() * 1.4,
          depth,
        });
      }
      // Nearer (faster) streaks drawn last, so they pass in front of the slow ones.
      streaks.sort((a, b) => a.speed - b.speed);
    };

    measure();
    seed();

    stage.onResize(() => {
      measure();
      // Re-spread rather than re-seed, so a resize does not restart the animation: the field keeps
      // its depths and colours and only its positions are spread over the new extent.
      for (const streak of streaks) {
        streak.u = uMin + Math.random() * uSpan;
        streak.w = wMin + Math.random() * wSpan;
      }
    });

    let time = 0;
    let beatPulse = 0;

    onFrame(scope, ctx.fpsCap, ({ dt, now }) => {
      bus.sample(now);
      envelopes.update(dt);
      time += dt;

      const level = bus.level * reactivity;
      const slow = envelopes.slow * reactivity;
      const mid = envelopes.mid * reactivity;
      const fast = envelopes.fast * reactivity;

      if (envelopes.beat && reactivity > 0) beatPulse = 1;
      beatPulse = Math.max(0, beatPulse - dt * 4.8);

      const speedBoost = 1 + level * 1.4 + slow * 1.1 + beatPulse * 1.2;
      const widthBoost = 1 + slow * 0.75;
      const alphaBoost = 1 + mid * 0.75 + fast * 0.45;
      const laneJitter = Math.sin(time * (3.2 + fast * 4)) * fast * 18;

      graphics.clear();
      if (backgroundOpacity > 0) {
        graphics.rect(0, 0, stage.width, stage.height).fill({
          color: backgroundColor,
          alpha: Math.min(1, backgroundOpacity + level * 0.22),
        });
      }

      const uEnd = uMin + uSpan;

      for (const streak of streaks) {
        streak.u -= streak.speed * speedScale * speedBoost * dt;
        if (streak.u < uMin) streak.u += uSpan;
        else if (streak.u > uEnd) streak.u -= uSpan;

        streak.twinklePhase += streak.twinkleRate * (1 + fast * 2.2) * dt;

        // Only the near half of the field sways, so the background stays calm while the foreground
        // reacts. Everything moving together would read as the camera shaking.
        const sway =
          streak.depth > 0.42
            ? Math.sin(time * (2.2 + streak.depth * 4.5) + streak.twinklePhase) *
              laneJitter *
              streak.depth
            : 0;

        const cx = streak.u * ux + (streak.w + sway) * wx;
        const cy = streak.u * uy + (streak.w + sway) * wy;
        const half = streak.len * lengthScale * (0.5 + slow * 0.18 * streak.depth);

        const flicker = 0.82 + 0.18 * Math.sin(streak.twinklePhase) + fast * 0.22 + beatPulse * 0.2;

        graphics
          .moveTo(cx - ux * half, cy - uy * half)
          .lineTo(cx + ux * half, cy + uy * half)
          .stroke({
            width: streak.width * widthScale * widthBoost,
            color: streak.color,
            alpha: Math.min(1, streak.alpha * opacity * alphaBoost * flicker),
            cap: "round",
          });
      }

      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        const previousCount = count;
        const previousAngle = angleDegrees;
        const previousColors = colors.join();

        count = int(p, "count", 320, 20, 1200);
        angleDegrees = num(p, "angle", -32, -90, 90);
        speedScale = num(p, "speed", 1, 0, 4);
        widthScale = num(p, "widthScale", 1, 0.2, 4);
        lengthScale = num(p, "lengthScale", 1, 0.2, 3);
        opacity = num(p, "opacity", 1, 0.05, 1);
        reactivity = num(p, "reactivity", 1, 0, 3);
        backgroundColor = colorInt(p, "backgroundColor", "#000800");
        backgroundOpacity = num(p, "backgroundOpacity", 0.16, 0, 1);
        colors = readColors(p);

        // The angle changes where the field's bounds are, so it has to be re-measured; the count
        // and the colours are baked into the streak list, so those need a re-seed. Speed, width,
        // opacity and reactivity are read fresh every frame and need neither.
        if (angleDegrees !== previousAngle) measure();
        if (count !== previousCount || colors.join() !== previousColors) seed();
      },
    };
  },
});

export default razerDiagonalStreaks;
