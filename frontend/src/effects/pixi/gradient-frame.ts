import * as PIXI from "pixi.js";

import { bool, colorHex, int, num } from "../paramUtils";
import { createPixiStage, defineEffect, onFrame } from "../sdk";

/**
 * Gradient Frame
 * ==============
 *
 * A clean rectangular border for framing a camera or a window capture: one rounded-rectangle
 * stroke whose colour is a gradient sweeping across the frame, transparent everywhere else. It is
 * deliberately the quiet one among this repository's borders — no particles, no pulsing, no audio.
 * The only motion is an optional slow rotation of the gradient itself, and at speed 0 it is a
 * completely static picture frame.
 *
 * The aspect-ratio fitting, which is the point of this effect
 * -----------------------------------------------------------
 * An OBS canvas is whatever size the route says it is, but the thing being framed — a camera at
 * 16:9, a vertical phone capture at 9:16 — has a fixed shape. So the frame does not follow the
 * canvas edges by default: the operator sets a ratio as two numbers (Ratio Width : Ratio Height),
 * and every frame the effect fits the largest rectangle of that ratio inside the canvas (minus the
 * margin), centred — the same letterboxing a video player does. Resize the canvas and the frame
 * recomputes; it never stretches. Ticking "Fill Canvas" switches the ratio off and hugs the canvas
 * edges instead, for when the frame should outline the whole browser source.
 *
 * How the gradient rotates without being rebuilt
 * ----------------------------------------------
 * A Pixi `FillGradient` bakes its stops into a texture, so rebuilding one every frame to animate
 * the angle would churn textures for no reason. Instead the gradient is painted once onto a square
 * layer big enough to cover the canvas at any rotation (side = the canvas diagonal), that layer is
 * *masked* by the border stroke, and animating the angle only spins the layer — a transform
 * change, which costs nothing. The gradient texture is rebuilt only when the colours, the canvas
 * size, or the geometry actually change.
 *
 * The optional inner glow is a second copy of the same construction: the same gradient layer,
 * masked by a wider stroke aligned to the inside of the border, drawn underneath at low alpha. It
 * reads as light spilling from the frame onto whatever sits inside it.
 */

/** The glow stroke is this many times wider than the border it spills from. */
const GLOW_WIDTH_FACTOR = 3;
/** Peak opacity of the inner glow layer. Low on purpose — it is spill, not a second border. */
const GLOW_ALPHA = 0.35;

const gradientFrame = defineEffect({
  descriptor: {
    id: "gradient-frame",
    name: "Gradient Frame",
    description:
      "A minimal rounded-rectangle border with a gradient stroke, transparent inside and out. Keeps a configurable aspect ratio centred in the canvas, or fills the canvas edges.",
    engine: "pixi",
    category: "overlay",
    tags: ["border", "frame", "gradient", "overlay", "minimal", "webcam"],
    previewNotes:
      "Transparent inside and outside the stroke — lay it over a camera or a capture sized to the same ratio. Set Rotation Speed to 0 for a completely static frame. Fill Canvas ignores the ratio and follows the canvas edges.",
    params: [
      {
        key: "ratioW",
        label: "Ratio Width",
        kind: "number",
        default: 16,
        min: 1,
        max: 64,
        step: 1,
        description:
          "First half of the frame's aspect ratio. 16:9 for a camera, 4:3 for older sources, 1:1 for a square. Only the proportion matters, not the numbers themselves.",
      },
      {
        key: "ratioH",
        label: "Ratio Height",
        kind: "number",
        default: 9,
        min: 1,
        max: 64,
        step: 1,
        description: "Second half of the aspect ratio. 9 with a Ratio Width of 16 gives 16:9.",
      },
      {
        key: "fill",
        label: "Fill Canvas",
        kind: "boolean",
        default: false,
        description:
          "Ignore the ratio and run the frame along the canvas edges instead (still inset by the margin). Use this to outline the whole browser source.",
      },
      {
        key: "thickness",
        label: "Border Thickness",
        kind: "number",
        default: 6,
        min: 1,
        max: 60,
        step: 1,
        description: "Width of the border stroke, in pixels.",
      },
      {
        key: "cornerRadius",
        label: "Corner Radius",
        kind: "number",
        default: 24,
        min: 0,
        max: 200,
        step: 1,
        description:
          "How rounded the corners are, in pixels. 0 is a sharp rectangle. Large values are clamped so opposite corners never overlap.",
      },
      {
        key: "margin",
        label: "Margin",
        kind: "number",
        default: 24,
        min: 0,
        max: 300,
        step: 1,
        description:
          "Empty space kept between the frame and the canvas edges, in pixels. Applies in both modes.",
      },
      {
        key: "colorCount",
        label: "Gradient Colours",
        kind: "number",
        default: 3,
        min: 2,
        max: 4,
        step: 1,
        description: "How many of the colours below the gradient uses, in order, evenly spaced.",
      },
      {
        key: "color1",
        label: "Colour 1",
        kind: "color",
        default: "#00e5ff",
        description: "First gradient stop.",
      },
      {
        key: "color2",
        label: "Colour 2",
        kind: "color",
        default: "#7c4dff",
        description: "Second gradient stop.",
      },
      {
        key: "color3",
        label: "Colour 3",
        kind: "color",
        default: "#ff4d9e",
        description: "Third gradient stop. Used when Gradient Colours is 3 or more.",
      },
      {
        key: "color4",
        label: "Colour 4",
        kind: "color",
        default: "#ffb300",
        description: "Fourth gradient stop. Used when Gradient Colours is 4.",
      },
      {
        key: "angle",
        label: "Gradient Angle",
        kind: "number",
        default: 35,
        min: 0,
        max: 360,
        step: 1,
        description:
          "Direction the gradient runs across the frame, in degrees. 0 is left-to-right, 90 is top-to-bottom. The starting direction when rotation is on.",
      },
      {
        key: "rotationSpeed",
        label: "Rotation Speed",
        kind: "number",
        default: 8,
        min: -90,
        max: 90,
        step: 1,
        description:
          "How fast the gradient direction turns, in degrees per second. 0 keeps it perfectly still; negative turns the other way. Small values (5–15) read as a slow shimmer.",
      },
      {
        key: "glow",
        label: "Inner Glow",
        kind: "boolean",
        default: true,
        description:
          "Adds a faint wash of the gradient spilling from the border toward the inside of the frame, like light falling on the framed content.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    const stage = await createPixiStage(scope, ctx);

    let ratioW = num(ctx.params, "ratioW", 16, 1, 64);
    let ratioH = num(ctx.params, "ratioH", 9, 1, 64);
    let fillCanvas = bool(ctx.params, "fill", false);
    let thickness = num(ctx.params, "thickness", 6, 1, 60);
    let cornerRadius = num(ctx.params, "cornerRadius", 24, 0, 200);
    let margin = num(ctx.params, "margin", 24, 0, 300);
    let colorCount = int(ctx.params, "colorCount", 3, 2, 4);
    let color1 = colorHex(ctx.params, "color1", "#00e5ff");
    let color2 = colorHex(ctx.params, "color2", "#7c4dff");
    let color3 = colorHex(ctx.params, "color3", "#ff4d9e");
    let color4 = colorHex(ctx.params, "color4", "#ffb300");
    let angle = num(ctx.params, "angle", 35, 0, 360);
    let rotationSpeed = num(ctx.params, "rotationSpeed", 8, -90, 90);
    let glow = bool(ctx.params, "glow", true);

    // Two gradient-painted layers, glow underneath, each clipped by its own stroke-shaped mask.
    // A mask must itself be on the stage to take effect, which is why the mask Graphics are added
    // as children rather than kept off to the side.
    const glowLayer = stage.stage.addChild(new PIXI.Graphics());
    const glowMask = stage.stage.addChild(new PIXI.Graphics());
    const borderLayer = stage.stage.addChild(new PIXI.Graphics());
    const borderMask = stage.stage.addChild(new PIXI.Graphics());
    glowLayer.mask = glowMask;
    glowLayer.alpha = GLOW_ALPHA;
    borderLayer.mask = borderMask;

    /** Extra rotation accumulated by the animation, added on top of the Gradient Angle param. */
    let spin = 0;

    /** The frame rectangle for the current canvas size and parameters. */
    const frameRect = (): { x: number; y: number; w: number; h: number } => {
      // The area the frame is allowed to occupy: the canvas minus the margin on every side,
      // never collapsing below one pixel however large the margin is set.
      const availW = Math.max(1, stage.width - margin * 2);
      const availH = Math.max(1, stage.height - margin * 2);

      if (fillCanvas) {
        return { x: margin, y: margin, w: availW, h: availH };
      }

      // Letterbox fit: scale the ratio rectangle by whichever axis runs out of room first, so the
      // result is the largest ratioW:ratioH rectangle that fits, then centre it. The frame never
      // stretches — a canvas wider than the ratio leaves side gaps, a taller one leaves gaps
      // above and below.
      const scale = Math.min(availW / ratioW, availH / ratioH);
      const w = ratioW * scale;
      const h = ratioH * scale;
      return { x: (stage.width - w) / 2, y: (stage.height - h) / 2, w, h };
    };

    /**
     * Redraws everything size- or colour-dependent: the two stroke masks and the gradient square.
     * Called on mount, on resize, and from `setParams` when a relevant value changed — never per
     * frame, because per-frame the only thing that moves is the layers' rotation.
     */
    const rebuild = (): void => {
      const rect = frameRect();

      // The stroke is inset by half its own width so the whole border stays inside the frame
      // rectangle — the framed content underneath lines up with the *outer* edge of the stroke.
      const inset = thickness / 2;
      const x = rect.x + inset;
      const y = rect.y + inset;
      const w = Math.max(1, rect.w - thickness);
      const h = Math.max(1, rect.h - thickness);
      // Clamp the radius so opposite rounded corners cannot overlap, which Pixi would render as a
      // self-intersecting shape.
      const radius = Math.min(cornerRadius, w / 2, h / 2);

      borderMask.clear();
      borderMask.roundRect(x, y, w, h, radius).stroke({ width: thickness, color: 0xffffff });

      glowMask.clear();
      if (glow) {
        // The glow stroke hangs inward from the border's inner edge: it is centred on a rectangle
        // inset by half the glow width past the border, so none of it pokes outside the frame.
        const glowWidth = thickness * GLOW_WIDTH_FACTOR;
        const gInset = inset + thickness / 2 + glowWidth / 2;
        const gw = Math.max(1, rect.w - gInset * 2);
        const gh = Math.max(1, rect.h - gInset * 2);
        glowMask
          .roundRect(rect.x + gInset, rect.y + gInset, gw, gh, Math.max(0, radius - glowWidth / 2))
          .stroke({ width: glowWidth, color: 0xffffff });
      }

      // The gradient square: side = the canvas diagonal, so it still covers the whole canvas when
      // rotated to any angle. Pivoted at its centre and parked at the canvas centre; the per-frame
      // animation only touches `.rotation`.
      const diag = Math.ceil(Math.hypot(stage.width, stage.height));
      const colors = [color1, color2, color3, color4].slice(0, colorCount);
      const gradient = new PIXI.FillGradient({
        start: { x: 0, y: 0 },
        end: { x: diag, y: 0 },
        colorStops: colors.map((color, i) => ({ offset: i / (colors.length - 1), color })),
        textureSpace: "global",
      });

      for (const layer of [glowLayer, borderLayer]) {
        layer.clear();
        layer.rect(0, 0, diag, diag).fill(gradient);
        layer.pivot.set(diag / 2, diag / 2);
        layer.position.set(stage.width / 2, stage.height / 2);
      }
      glowLayer.visible = glow;
    };

    rebuild();
    stage.onResize(rebuild);

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      spin += (rotationSpeed * Math.PI) / 180 * dt;
      const rotation = (angle * Math.PI) / 180 + spin;
      glowLayer.rotation = rotation;
      borderLayer.rotation = rotation;
      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        const next = {
          ratioW: num(p, "ratioW", 16, 1, 64),
          ratioH: num(p, "ratioH", 9, 1, 64),
          fillCanvas: bool(p, "fill", false),
          thickness: num(p, "thickness", 6, 1, 60),
          cornerRadius: num(p, "cornerRadius", 24, 0, 200),
          margin: num(p, "margin", 24, 0, 300),
          colorCount: int(p, "colorCount", 3, 2, 4),
          color1: colorHex(p, "color1", "#00e5ff"),
          color2: colorHex(p, "color2", "#7c4dff"),
          color3: colorHex(p, "color3", "#ff4d9e"),
          color4: colorHex(p, "color4", "#ffb300"),
          glow: bool(p, "glow", true),
        };

        // Angle and speed feed straight into the per-frame rotation — no rebuild needed.
        angle = num(p, "angle", 35, 0, 360);
        rotationSpeed = num(p, "rotationSpeed", 8, -90, 90);

        // Everything else changes the masks or the gradient texture. Rebuild only when a value
        // actually moved: setParams fires with unchanged values often, and rebuilding then would
        // recreate the gradient texture for nothing.
        const changed =
          next.ratioW !== ratioW ||
          next.ratioH !== ratioH ||
          next.fillCanvas !== fillCanvas ||
          next.thickness !== thickness ||
          next.cornerRadius !== cornerRadius ||
          next.margin !== margin ||
          next.colorCount !== colorCount ||
          next.color1 !== color1 ||
          next.color2 !== color2 ||
          next.color3 !== color3 ||
          next.color4 !== color4 ||
          next.glow !== glow;
        if (!changed) return;

        ratioW = next.ratioW;
        ratioH = next.ratioH;
        fillCanvas = next.fillCanvas;
        thickness = next.thickness;
        cornerRadius = next.cornerRadius;
        margin = next.margin;
        colorCount = next.colorCount;
        color1 = next.color1;
        color2 = next.color2;
        color3 = next.color3;
        color4 = next.color4;
        glow = next.glow;
        rebuild();
      },
    };
  },
});

export default gradientFrame;
