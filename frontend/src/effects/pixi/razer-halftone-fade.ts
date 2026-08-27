import * as PIXI from "pixi.js";

import { bool, colorHex, num } from "../paramUtils";
import { createPixiStage, defineEffect, onFrame } from "../sdk";

/**
 * Razer Halftone Fade
 * ===================
 *
 * A halftone gradient: dense at the top, fading to nothing at the bottom, with the dots breathing
 * gently in and out. A quiet graphic backdrop with a clear direction to it — the kind of thing that
 * sits behind a title without arguing with it.
 *
 * Ported from `razer-halftone-fade.html` in the old `obs-effects` repository, which was the
 * monochrome `HalftoneFadeScreen` with its dot colour changed to toxic green. Both are reachable
 * here from the Dot Colour parameter, so there is one entry rather than two.
 *
 * True halftone, and why that matters
 * -----------------------------------
 * Every dot is the same colour. The image is made entirely by varying their **radius** — which is
 * what a real halftone screen does, and why the result reads as printed rather than as a blur. The
 * alternative, fading each dot's opacity, produces a soft gradient that looks like a photograph of
 * dots rather than a print of them.
 *
 * That also makes it cheap to draw: one fill for the whole field, because Pixi batches a run of
 * `circle()` calls with a single `fill()` into one draw call. Varying the colour per dot would cost
 * one draw call each.
 *
 * Its sibling `toxic-marble-dots` takes the other approach — several colour tiers, and a churning
 * field rather than a directional fade.
 */

const razerHalftoneFade = defineEffect({
  descriptor: {
    id: "razer-halftone-fade",
    name: "Razer Halftone Fade",
    description:
      "A halftone gradient of toxic-green dots, dense at the top and fading to nothing at the bottom, breathing gently.",
    engine: "pixi",
    category: "background",
    tags: ["razer", "background", "halftone", "dots", "gradient", "green"],
    previewNotes:
      "A calm graphic backdrop with a clear top-to-bottom direction. Turn Background off to lay the dots over a scene. Set Dot Colour to white for the original monochrome version.",
    params: [
      {
        key: "speed",
        label: "Speed",
        kind: "number",
        default: 1,
        min: 0,
        max: 4,
        step: 0.05,
        description: "How fast the field breathes. 0 freezes it into a still gradient.",
      },
      {
        key: "spacing",
        label: "Spacing",
        kind: "number",
        default: 14,
        min: 4,
        max: 48,
        step: 1,
        description:
          "Pixels between dot centres. This is the performance control: halving it quadruples the number of circles.",
      },
      {
        key: "dotSize",
        label: "Dot Size",
        kind: "number",
        default: 0.46,
        min: 0.1,
        max: 0.75,
        step: 0.01,
        description:
          "Largest dot radius as a fraction of the spacing. Above 0.5 the biggest dots touch and the dense end closes into a solid area.",
      },
      {
        key: "fade",
        label: "Fade Length",
        kind: "number",
        default: 1.15,
        min: 0.4,
        max: 3,
        step: 0.05,
        description:
          "How quickly the field thins out downwards. Low values keep dots most of the way down; high values crowd them all into the top.",
      },
      {
        key: "contrast",
        label: "Contrast",
        kind: "number",
        default: 1.3,
        min: 0.4,
        max: 3,
        step: 0.05,
        description:
          "Shapes the fade curve. Above 1 holds the dense end and drops away sharply; below 1 gives a more even gradient.",
      },
      {
        key: "sideBias",
        label: "Side Bias",
        kind: "number",
        default: 0.25,
        min: -0.6,
        max: 0.6,
        step: 0.01,
        description:
          "Thickens one side of the field. Positive favours the left, as the original did; negative favours the right; 0 is even.",
      },
      {
        key: "dotColor",
        label: "Dot Colour",
        kind: "color",
        default: "#44ff00",
        description: "Every dot is this colour — the image comes from their size, not their shade.",
      },
      {
        key: "background",
        label: "Background",
        kind: "boolean",
        default: true,
        description:
          "Fill the frame behind the dots. Turn it off to lay the halftone over a scene.",
      },
      {
        key: "backgroundColor",
        label: "Background Colour",
        kind: "color",
        default: "#000000",
        description: "Only used when Background is on.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    const stage = await createPixiStage(scope, ctx);
    const graphics = stage.stage.addChild(new PIXI.Graphics());

    let speed = num(ctx.params, "speed", 1, 0, 4);
    let spacing = num(ctx.params, "spacing", 14, 4, 48);
    let dotSize = num(ctx.params, "dotSize", 0.46, 0.1, 0.75);
    let fade = num(ctx.params, "fade", 1.15, 0.4, 3);
    let contrast = num(ctx.params, "contrast", 1.3, 0.4, 3);
    let sideBias = num(ctx.params, "sideBias", 0.25, -0.6, 0.6);
    let dotColor = colorHex(ctx.params, "dotColor", "#44ff00");
    let drawBackground = bool(ctx.params, "background", true);
    let backgroundColor = colorHex(ctx.params, "backgroundColor", "#000000");

    let clock = 0;

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      // The original advanced its clock at a quarter of real time before using it; folding the
      // same 0.25 in here keeps the breathing at its original rate.
      clock += dt * speed * 0.25;

      const width = stage.width;
      const height = stage.height;

      graphics.clear();
      if (drawBackground) graphics.rect(0, 0, width, height).fill({ color: backgroundColor });

      const cols = Math.ceil(width / spacing) + 1;
      const rows = Math.ceil(height / spacing) + 1;
      const maxRadius = spacing * dotSize;

      // A slow global pulse, so the whole field breathes together rather than rippling.
      const pulse = 1 + Math.sin(clock * 0.6) * 0.06;

      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
          const x = col * spacing;
          const y = row * spacing;
          const xn = x / width;
          const yn = y / height;

          const base = Math.pow(Math.max(0, 1 - yn * fade), contrast);

          // Three waves at unrelated frequencies. Without them the gradient is a mechanical ramp;
          // with them it has organic drifts of denser and sparser dots.
          const organic =
            Math.sin(xn * 5.1 + yn * 3.7 + clock * 0.4) * 0.09 +
            Math.sin(xn * 2.3 - yn * 7.1 + clock * 0.22) * 0.06 +
            Math.cos(xn * 9.4 + yn * 2.1 - clock * 0.31) * 0.04;

          const bias =
            sideBias >= 0
              ? Math.max(0, (0.35 - xn) * sideBias)
              : Math.max(0, (xn - 0.65) * -sideBias);

          const value = Math.max(0, Math.min(1, (base + organic + bias) * pulse));
          const radius = maxRadius * value;

          // Below about half a pixel a circle is invisible but still costs geometry, so it is
          // dropped rather than drawn.
          if (radius > 0.4) graphics.circle(x, y, radius);
        }
      }

      // One fill for the whole field — the reason every dot is the same colour.
      graphics.fill({ color: dotColor });

      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        speed = num(p, "speed", 1, 0, 4);
        spacing = num(p, "spacing", 14, 4, 48);
        dotSize = num(p, "dotSize", 0.46, 0.1, 0.75);
        fade = num(p, "fade", 1.15, 0.4, 3);
        contrast = num(p, "contrast", 1.3, 0.4, 3);
        sideBias = num(p, "sideBias", 0.25, -0.6, 0.6);
        dotColor = colorHex(p, "dotColor", "#44ff00");
        drawBackground = bool(p, "background", true);
        backgroundColor = colorHex(p, "backgroundColor", "#000000");
      },
    };
  },
});

export default razerHalftoneFade;
