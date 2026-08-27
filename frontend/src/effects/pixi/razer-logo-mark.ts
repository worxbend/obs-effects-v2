import * as PIXI from "pixi.js";

import { colorHex, int, num } from "../paramUtils";
import { createEnvelopes, createPixiStage, defineEffect, onFrame, useAudio } from "../sdk";

/**
 * Razer Logo Mark
 * ===============
 *
 * A rotating hexagonal emblem with an angular glyph inside it, a bright core, concentric glow rings
 * and a scatter of motes orbiting the whole thing. It breathes with the audio and swells on a beat.
 *
 * Ported from `razer-logo-mark.html` in the old `obs-effects` repository.
 *
 * A generated mark, not an image
 * ------------------------------
 * Everything here is drawn from geometry every frame, which is why it is crisp at any canvas size
 * and why every part of it can react to sound. Its sibling `logo` takes the other approach and
 * draws an actual image file; that one shows *your* logo, this one is a placeholder emblem that
 * happens to be alive.
 *
 * The consequence worth knowing: this is not your brand. It is a shape that reads as "a logo" in
 * the corner of a starting-soon screen. If you want your own artwork animated, use `logo`.
 *
 * Everything scales from one number
 * ---------------------------------
 * The radius is a fraction of the frame's *shorter* side, and every other measurement — the inner
 * glyph, the core dot, the glow rings, the orbit distance — is a multiple of that radius. So the
 * mark keeps its proportions at 720p and at 4K, in a square source or a wide one, with one control.
 */

/** Full circle in radians. */
const TAU = Math.PI * 2;

/** A point on a hexagon (or any 6-step ring) at index `i`, rotated by `rot`. */
function hexPoint(cx: number, cy: number, r: number, i: number, rot: number): [number, number] {
  const angle = rot + (i / 6) * TAU;
  return [cx + Math.cos(angle) * r, cy + Math.sin(angle) * r];
}

const razerLogoMark = defineEffect({
  descriptor: {
    id: "razer-logo-mark",
    name: "Razer Logo Mark",
    description:
      "A rotating hexagonal emblem with an angular inner glyph, glow rings and orbiting motes, breathing with the audio.",
    engine: "pixi",
    category: "overlay",
    tags: ["razer", "overlay", "logo", "emblem", "hexagon", "reactive"],
    previewNotes:
      "A generated emblem, not your artwork — use the `logo` effect if you want your own image animated. Centred and transparent everywhere else, so it works as a corner mark or on a starting-soon screen. Reacts to OBS audio.",
    params: [
      {
        key: "size",
        label: "Size",
        kind: "number",
        default: 0.11,
        min: 0.02,
        max: 0.4,
        step: 0.005,
        description:
          "Radius of the hexagon as a fraction of the frame's shorter side. Everything else is a multiple of this.",
      },
      {
        key: "spin",
        label: "Spin",
        kind: "number",
        default: 0.12,
        min: -2,
        max: 2,
        step: 0.01,
        description:
          "Rotation speed in turns-ish per second. Negative spins the other way; 0 holds it still.",
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
          "How much the mark swells and brightens with the audio. 0 gives a steady, silent emblem.",
      },
      {
        key: "glowRings",
        label: "Glow Rings",
        kind: "number",
        default: 3,
        min: 0,
        max: 8,
        step: 1,
        description: "Faint concentric circles around the mark. 0 removes the halo.",
      },
      {
        key: "orbitCount",
        label: "Orbiting Motes",
        kind: "number",
        default: 9,
        min: 0,
        max: 60,
        step: 1,
        description: "Specks circling the mark at different speeds and distances.",
      },
      {
        key: "colorFrame",
        label: "Frame Colour",
        kind: "color",
        default: "#b0ff00",
        description: "The hexagon outline and the orbiting motes.",
      },
      {
        key: "colorGlyph",
        label: "Glyph Colour",
        kind: "color",
        default: "#36ff00",
        description: "The angular shape inside the hexagon.",
      },
      {
        key: "colorGlow",
        label: "Glow Colour",
        kind: "color",
        default: "#00c243",
        description: "The concentric rings.",
      },
      {
        key: "colorCore",
        label: "Core Colour",
        kind: "color",
        default: "#f0fff2",
        description: "The bright dot at the very centre.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    const bus = await useAudio(scope);
    scope.checkpoint();
    const envelopes = createEnvelopes(bus);

    const stage = await createPixiStage(scope, ctx);

    // Back to front: glow, then the mark, then the motes over the top.
    const glowLayer = stage.stage.addChild(new PIXI.Graphics());
    const markLayer = stage.stage.addChild(new PIXI.Graphics());
    const orbitLayer = stage.stage.addChild(new PIXI.Graphics());

    let sizeFraction = num(ctx.params, "size", 0.11, 0.02, 0.4);
    let spin = num(ctx.params, "spin", 0.12, -2, 2);
    let reactivity = num(ctx.params, "reactivity", 1, 0, 3);
    let glowRings = int(ctx.params, "glowRings", 3, 0, 8);
    let orbitCount = int(ctx.params, "orbitCount", 9, 0, 60);
    let colorFrame = colorHex(ctx.params, "colorFrame", "#b0ff00");
    let colorGlyph = colorHex(ctx.params, "colorGlyph", "#36ff00");
    let colorGlow = colorHex(ctx.params, "colorGlow", "#00c243");
    let colorCore = colorHex(ctx.params, "colorCore", "#f0fff2");

    // Fixed seeds by index rather than random, so a remount reproduces the same orbit arrangement
    // instead of scattering the motes somewhere new mid-broadcast.
    const MAX_ORBITS = 60;
    const orbitSeeds = new Float32Array(MAX_ORBITS);
    for (let i = 0; i < MAX_ORBITS; i += 1) {
      const s = Math.sin(i * 53.71) * 43758.5453;
      orbitSeeds[i] = s - Math.floor(s);
    }

    let time = 0;
    let rotation = 0;
    let pulse = 0;

    onFrame(scope, ctx.fpsCap, ({ dt, now }) => {
      bus.sample(now);
      envelopes.update(dt);
      time += dt;
      // Rotation is accumulated separately from `time`, so changing Spin alters the rate from here
      // on rather than snapping the mark to a different angle.
      rotation += dt * spin;

      const target = (envelopes.beat ? 1 : bus.level) * reactivity;
      pulse += (target - pulse) * Math.min(1, dt * 6);

      const cx = stage.width * 0.5;
      const cy = stage.height * 0.5;
      const radius = Math.min(stage.width, stage.height) * sizeFraction * (1 + pulse * 0.08);

      // ── Glow rings ──────────────────────────────────────────────────────
      glowLayer.clear();
      for (let ring = glowRings; ring >= 1; ring -= 1) {
        glowLayer.circle(cx, cy, radius * (1 + ring * 0.22)).stroke({
          color: colorGlow,
          width: 1.4,
          // Divided by the ring index, so each one out is fainter than the last.
          alpha: (0.09 + pulse * 0.08) / ring,
        });
      }

      markLayer.clear();

      // ── Hexagon frame ───────────────────────────────────────────────────
      const hex: number[] = [];
      for (let i = 0; i < 6; i += 1) hex.push(...hexPoint(cx, cy, radius, i, rotation));
      markLayer.poly(hex).stroke({ color: colorFrame, width: 3, alpha: 0.85 + pulse * 0.15 });

      // ── Inner glyph ─────────────────────────────────────────────────────
      // Four points alternating between a large and a tiny radius, which produces the pinched
      // hourglass shape rather than a diamond.
      const innerR = radius * 0.56;
      const glyph = [
        ...hexPoint(cx, cy, innerR, 0, rotation + 0.5),
        ...hexPoint(cx, cy, innerR * 0.15, 1.5, rotation + 0.5),
        ...hexPoint(cx, cy, innerR, 3, rotation + 0.5),
        ...hexPoint(cx, cy, innerR * 0.15, 4.5, rotation + 0.5),
      ];
      markLayer
        .poly(glyph)
        .fill({ color: colorGlyph, alpha: 0.22 + pulse * 0.3 })
        .stroke({ color: colorGlyph, width: 2, alpha: 0.9 });

      // ── Core ────────────────────────────────────────────────────────────
      markLayer
        .circle(cx, cy, radius * 0.06 * (1 + pulse * 0.6))
        .fill({ color: colorCore, alpha: 0.9 });

      // ── Orbiting motes ──────────────────────────────────────────────────
      orbitLayer.clear();
      for (let i = 0; i < orbitCount; i += 1) {
        const seed = orbitSeeds[i] ?? 0;
        const angle = time * (0.25 + seed * 0.4) + seed * TAU;
        // The orbit radius breathes on its own slow cycle, so the ring of motes is never a fixed
        // circle — that is what stops it reading as a mechanical dial.
        const orbitR = radius * (1.55 + 0.25 * Math.sin(time * 0.4 + i));
        orbitLayer
          .circle(cx + Math.cos(angle) * orbitR, cy + Math.sin(angle) * orbitR, 1.6 + pulse * 1.6)
          .fill({ color: colorFrame, alpha: 0.5 + 0.4 * Math.sin(time * 2 + i) });
      }

      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        sizeFraction = num(p, "size", 0.11, 0.02, 0.4);
        spin = num(p, "spin", 0.12, -2, 2);
        reactivity = num(p, "reactivity", 1, 0, 3);
        glowRings = int(p, "glowRings", 3, 0, 8);
        orbitCount = int(p, "orbitCount", 9, 0, 60);
        colorFrame = colorHex(p, "colorFrame", "#b0ff00");
        colorGlyph = colorHex(p, "colorGlyph", "#36ff00");
        colorGlow = colorHex(p, "colorGlow", "#00c243");
        colorCore = colorHex(p, "colorCore", "#f0fff2");
      },
    };
  },
});

export default razerLogoMark;
