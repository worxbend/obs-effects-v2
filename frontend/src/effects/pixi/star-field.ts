import * as PIXI from "pixi.js";

import { bool, colorHex, int, num } from "../paramUtils";
import { createPixiStage, defineEffect, onFrame } from "../sdk";

/**
 * Star Field
 * ==========
 *
 * Stars streaming outwards from the centre of the frame, stretching into streaks as they accelerate
 * away — the view from the front of something travelling very fast. Coloured from the Catppuccin
 * Mocha palette rather than plain white.
 *
 * Ported from `star-field.html` in the old `obs-effects` repository.
 *
 * How this differs from the built-in `starfield-warp`
 * ---------------------------------------------------
 * This build already has a starfield, and they are genuinely different things rather than
 * duplicates.
 *
 * `starfield-warp` is a three.js effect: real points in a 3D perspective, flying *past* a camera,
 * with an opaque black background. This one is 2D, drawn as strokes on a Pixi canvas, radiating
 * from a point — closer to a comic-book speed-line panel than to a space sim. It also has soft
 * pastel colours and can be made transparent, so it works as an overlay in a way the 3D one cannot.
 *
 * Reach for the three.js one for depth, and this one for graphic flatness or for laying over a scene.
 *
 * Streaks are drawn from the previous position
 * --------------------------------------------
 * Each star remembers where it was last frame and draws a line from there to where it is now. That
 * is why the streaks lengthen automatically as stars accelerate — the line *is* the distance
 * travelled in one frame — and why a lower frame-rate cap produces longer streaks rather than a
 * stuttering dot. It is the same trick a long camera exposure uses.
 */

/** The Catppuccin Mocha accent colours the original picked from. */
const DEFAULT_PALETTE = [
  "#cba6f7", // mauve
  "#89b4fa", // blue
  "#74c7ec", // sapphire
  "#89dceb", // sky
  "#94e2d5", // teal
  "#a6e3a1", // green
  "#b4befe", // lavender
  "#f5c2e7", // pink
];

/** Fraction of the way to the edge over which a star fades out. */
const FADE_MARGIN = 0.08;

interface Star {
  x: number;
  y: number;
  /** Where it was last frame — the other end of the streak. */
  px: number;
  py: number;
  /** Unit direction away from the centre. */
  vx: number;
  vy: number;
  speed: number;
  size: number;
  color: string;
  /** 0 at birth, 1 at death. */
  age: number;
  /** Total lifetime in seconds. */
  life: number;
}

const starField = defineEffect({
  descriptor: {
    id: "star-field",
    name: "Star Field",
    description:
      "Pastel stars streaming outward from the centre and stretching into streaks as they accelerate — a flat, graphic take on a warp field.",
    engine: "pixi",
    category: "background",
    tags: ["stars", "warp", "speed", "background", "catppuccin", "pastel"],
    previewNotes:
      "Turn Background off to lay it over a scene as a speed-line overlay. Different from the built-in Starfield Warp, which is a 3D perspective flight; this one is 2D and radial. A lower frame-rate cap makes the streaks longer, not choppier.",
    params: [
      {
        key: "count",
        label: "Star Count",
        kind: "number",
        default: 600,
        min: 20,
        max: 3000,
        step: 20,
        description: "How many stars are alive at once. This is the performance control.",
      },
      {
        key: "speed",
        label: "Speed",
        kind: "number",
        default: 1,
        min: 0,
        max: 5,
        step: 0.05,
        description: "Multiplier on how fast stars travel outward.",
      },
      {
        key: "acceleration",
        label: "Acceleration",
        kind: "number",
        default: 2.8,
        min: 0,
        max: 8,
        step: 0.1,
        description:
          "How much a star speeds up as it ages. This is what stretches the streaks — 0 gives even dots travelling at a constant rate.",
      },
      {
        key: "thickness",
        label: "Thickness",
        kind: "number",
        default: 1,
        min: 0.2,
        max: 5,
        step: 0.05,
        description: "Multiplier on streak width.",
      },
      {
        key: "lifetime",
        label: "Lifetime",
        kind: "number",
        default: 1,
        min: 0.2,
        max: 4,
        step: 0.05,
        description:
          "Multiplier on how long a star lives before respawning at the centre. Short lifetimes keep the action near the middle.",
      },
      {
        key: "background",
        label: "Background",
        kind: "boolean",
        default: true,
        description: "Fill the frame behind the stars. Turn it off to use this as an overlay.",
      },
      {
        key: "backgroundColor",
        label: "Background Colour",
        kind: "color",
        default: "#1e1e2e",
        description: "Only used when Background is on.",
      },
      {
        key: "color1",
        label: "Colour 1",
        kind: "color",
        default: "#cba6f7",
        description: "Each star takes one of these four colours at random.",
      },
      { key: "color2", label: "Colour 2", kind: "color", default: "#89b4fa", description: "" },
      { key: "color3", label: "Colour 3", kind: "color", default: "#94e2d5", description: "" },
      { key: "color4", label: "Colour 4", kind: "color", default: "#f5c2e7", description: "" },
    ],
  },

  async setup({ ctx, scope }) {
    const stage = await createPixiStage(scope, ctx);

    const backgroundLayer = stage.stage.addChild(new PIXI.Graphics());
    const starLayer = stage.stage.addChild(new PIXI.Graphics());

    let count = int(ctx.params, "count", 600, 20, 3000);
    let speedScale = num(ctx.params, "speed", 1, 0, 5);
    let acceleration = num(ctx.params, "acceleration", 2.8, 0, 8);
    let thickness = num(ctx.params, "thickness", 1, 0.2, 5);
    let lifetimeScale = num(ctx.params, "lifetime", 1, 0.2, 4);
    let drawBackground = bool(ctx.params, "background", true);
    let backgroundColor = colorHex(ctx.params, "backgroundColor", "#1e1e2e");

    const readColors = (p: Record<string, unknown>): string[] => [
      colorHex(p, "color1", DEFAULT_PALETTE[0] ?? "#cba6f7"),
      colorHex(p, "color2", DEFAULT_PALETTE[1] ?? "#89b4fa"),
      colorHex(p, "color3", DEFAULT_PALETTE[4] ?? "#94e2d5"),
      colorHex(p, "color4", DEFAULT_PALETTE[7] ?? "#f5c2e7"),
    ];
    let colors = readColors(ctx.params);

    let stars: Star[] = [];

    /** Creates one star heading in a random direction from just off the centre. */
    const newStar = (cx: number, cy: number, halfDiagonal: number): Star => {
      const angle = Math.random() * Math.PI * 2;
      const vx = Math.cos(angle);
      const vy = Math.sin(angle);
      // Born a little way out rather than exactly at the centre, so they do not all emerge from a
      // single pixel and produce a visible bright dot there.
      const spawn = Math.random() * halfDiagonal * 0.04;
      const x = cx + vx * spawn;
      const y = cy + vy * spawn;

      return {
        x,
        y,
        px: x,
        py: y,
        vx,
        vy,
        // Speed is a fraction of the half-diagonal per second, so the field crosses the frame in
        // the same time whatever its size.
        speed: (0.5 + Math.random() * 0.5) * 0.4,
        size: 0.5 + Math.random() * 1.5,
        color: colors[Math.floor(Math.random() * colors.length)] ?? "#ffffff",
        age: 0,
        life: (1.2 + Math.random() * 2) * lifetimeScale,
      };
    };

    /** Fills the field, spreading the ages so the first frame is not an empty screen. */
    const seed = (): void => {
      const cx = stage.width / 2;
      const cy = stage.height / 2;
      const halfDiagonal = Math.hypot(cx, cy);

      stars = [];
      for (let i = 0; i < count; i += 1) {
        const star = newStar(cx, cy, halfDiagonal);
        // Each star starts partway through its life and is placed where it would have got to.
        // Without this the effect opens on a blank frame and everything arrives at once.
        star.age = Math.random() * 0.9;
        star.x = cx + star.vx * star.age * star.life * star.speed * halfDiagonal;
        star.y = cy + star.vy * star.age * star.life * star.speed * halfDiagonal;
        star.px = star.x;
        star.py = star.y;
        stars.push(star);
      }
    };

    seed();
    stage.onResize(seed);

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      const w = stage.width;
      const h = stage.height;
      const cx = w / 2;
      const cy = h / 2;
      const halfDiagonal = Math.hypot(cx, cy);

      backgroundLayer.clear();
      if (drawBackground) backgroundLayer.rect(0, 0, w, h).fill({ color: backgroundColor });

      starLayer.clear();

      for (let i = 0; i < stars.length; i += 1) {
        const star = stars[i];
        if (star === undefined) continue;

        star.px = star.x;
        star.py = star.y;

        // Speed rises with age, which is what stretches the streak as it travels.
        const effective = star.speed * speedScale * (1 + star.age * acceleration);
        star.x += star.vx * effective * halfDiagonal * dt;
        star.y += star.vy * effective * halfDiagonal * dt;
        star.age += dt / star.life;

        if (star.age >= 1 || star.x < -8 || star.x > w + 8 || star.y < -8 || star.y > h + 8) {
          stars[i] = newStar(cx, cy, halfDiagonal);
          continue;
        }

        // Fade in over the first 5% of life and out over the last stretch towards the edge, so
        // nothing appears or vanishes abruptly.
        const distance = Math.hypot(star.x - cx, star.y - cy) / halfDiagonal;
        const edgeFade = 1 - Math.max(0, (distance - (1 - FADE_MARGIN)) / FADE_MARGIN);
        const alpha = Math.min(1, star.age / 0.05) * edgeFade;
        if (alpha <= 0) continue;

        const width = star.size * thickness * (1 + star.age * 3);

        starLayer
          .moveTo(star.px, star.py)
          .lineTo(star.x, star.y)
          .stroke({ width, color: star.color, alpha, cap: "round" });

        // A brighter dot at the leading end, which reads as the star itself with the streak behind.
        starLayer
          .circle(star.x, star.y, width * 0.7)
          .fill({ color: star.color, alpha: alpha * 0.9 });
      }

      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        const previousCount = count;
        const previousColors = colors.join();

        count = int(p, "count", 600, 20, 3000);
        speedScale = num(p, "speed", 1, 0, 5);
        acceleration = num(p, "acceleration", 2.8, 0, 8);
        thickness = num(p, "thickness", 1, 0.2, 5);
        lifetimeScale = num(p, "lifetime", 1, 0.2, 4);
        drawBackground = bool(p, "background", true);
        backgroundColor = colorHex(p, "backgroundColor", "#1e1e2e");
        colors = readColors(p);

        // Count and colours are baked into the star list, so those need a reseed. Speed,
        // acceleration, thickness and lifetime are read fresh each frame and do not.
        if (count !== previousCount || colors.join() !== previousColors) seed();
      },
    };
  },
});

export default starField;
