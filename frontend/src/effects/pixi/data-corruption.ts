import * as PIXI from "pixi.js";

import { colorHex, int, num } from "../paramUtils";
import { createPixiStage, defineEffect, onFrame } from "../sdk";

/**
 * Data Corruption
 * ===============
 *
 * A transparent overlay that stays completely invisible for seconds at a time, then throws one short
 * corruption event across the frame: displaced tear bands with red and blue channel fringing, or a
 * rectangle of macroblocks like a video stream that has lost a keyframe. Occasionally several events
 * fire in quick succession, then it goes quiet for a long time.
 *
 * Ported from `data-corruption.html` in the old `obs-effects` repository.
 *
 * How it differs from `glitch-veil`
 * ---------------------------------
 * They are both quiet, occasional overlays, and it is worth knowing which to reach for.
 *
 * `glitch-veil` is *analogue*: RGB slices, static speckle, a drifting scan band — the failure of a
 * signal on a wire, and it always has the scan band running.
 *
 * This one is *digital*: 16-pixel macroblocks and torn scanlines with chromatic fringing — the
 * failure of a compressed video stream, and between events it draws literally nothing.
 *
 * The burst clustering, which is the part worth copying
 * ----------------------------------------------------
 * Events do not arrive at an even random rate. Most of the time the gap is 3 to 11 seconds, but
 * roughly one event in six starts a *cluster* of two to four more, 0.08 to 0.35 seconds apart, after
 * which the effect is forced quiet for 10 to 22 seconds.
 *
 * That structure is what makes it read as a fault rather than as decoration. Real corruption is
 * bursty: something goes wrong, it goes wrong several times in a second, and then it is fine for a
 * long while. An evenly-spaced glitch reads as an animation on a loop.
 *
 * Each event snaps in over about a fifteenth of its duration and eases out over the second half, so
 * it arrives abruptly and leaves smoothly — the opposite of a fade, and the reason it startles.
 */

/** Macroblock size in pixels, matching the 16×16 blocks a video codec works in. */
const BLOCK_SIZE = 16;

/** What one corruption event is made of. */
type EventKind = "tear" | "block" | "combined";

interface TearBand {
  y: number;
  h: number;
  shiftX: number;
  color: string;
  alpha: number;
  rgbShift: number;
}

interface Block {
  x: number;
  y: number;
  color: string;
  alpha: number;
}

interface CorruptEvent {
  startTime: number;
  duration: number;
  tears: TearBand[];
  blocks: Block[];
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

const dataCorruption = defineEffect({
  descriptor: {
    id: "data-corruption",
    name: "Data Corruption",
    description:
      "An invisible overlay that occasionally throws one short burst of digital corruption across the frame — torn scanlines with colour fringing, or a patch of macroblocks.",
    engine: "pixi",
    category: "overlay",
    tags: ["glitch", "corruption", "overlay", "digital", "macroblocks", "subtle"],
    previewNotes:
      "Draws nothing at all between events, so a preview may look broken until one fires — wait a few seconds, or lower Event Gap to see it. Transparent: lay it over a camera or a capture. Its analogue counterpart is Glitch Veil.",
    params: [
      {
        key: "gapMin",
        label: "Event Gap (min)",
        kind: "number",
        default: 3,
        min: 0.1,
        max: 60,
        step: 0.1,
        description: "Shortest quiet period between events, in seconds.",
      },
      {
        key: "gapMax",
        label: "Event Gap (max)",
        kind: "number",
        default: 11,
        min: 0.2,
        max: 120,
        step: 0.5,
        description: "Longest quiet period between events.",
      },
      {
        key: "duration",
        label: "Event Length",
        kind: "number",
        default: 0.28,
        min: 0.03,
        max: 2,
        step: 0.01,
        description:
          "Roughly how long one event lasts, in seconds. Each varies either side of this. Short is what makes it read as a fault.",
      },
      {
        key: "burstChance",
        label: "Cluster Chance",
        kind: "number",
        default: 0.18,
        min: 0,
        max: 1,
        step: 0.02,
        description:
          "Probability that an event starts a rapid cluster of several more. 0 gives evenly-spaced single events, which reads more like decoration than a fault.",
      },
      {
        key: "intensity",
        label: "Intensity",
        kind: "number",
        default: 1,
        min: 0.1,
        max: 3,
        step: 0.05,
        description: "Scales the opacity of everything an event draws.",
      },
      {
        key: "tearShift",
        label: "Tear Displacement",
        kind: "number",
        default: 1,
        min: 0,
        max: 4,
        step: 0.05,
        description:
          "How far torn bands are shoved sideways. 0 leaves them in place and only the colour fringing shows.",
      },
      {
        key: "blockSize",
        label: "Macroblock Size",
        kind: "number",
        default: 16,
        min: 4,
        max: 64,
        step: 2,
        description:
          "Size of the corrupted blocks in pixels. 16 is what a video codec actually uses, which is why it looks like a real decoding failure.",
      },
      {
        key: "colorTear",
        label: "Tear Colour",
        kind: "color",
        default: "#dde2ee",
        description: "The displaced band itself. A near-white reads as blown-out signal.",
      },
      {
        key: "colorFringeA",
        label: "Fringe Colour 1",
        kind: "color",
        default: "#ff1a1a",
        description: "Shifted one way from the tear, mimicking a channel that arrived early.",
      },
      {
        key: "colorFringeB",
        label: "Fringe Colour 2",
        kind: "color",
        default: "#1a4aff",
        description: "Shifted the other way — the channel that arrived late.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    const stage = await createPixiStage(scope, ctx);

    const blockLayer = stage.stage.addChild(new PIXI.Graphics());
    const tearLayer = stage.stage.addChild(new PIXI.Graphics());
    const fringeLayer = stage.stage.addChild(new PIXI.Graphics());

    let gapMin = num(ctx.params, "gapMin", 3, 0.1, 60);
    let gapMax = num(ctx.params, "gapMax", 11, 0.2, 120);
    let duration = num(ctx.params, "duration", 0.28, 0.03, 2);
    let burstChance = num(ctx.params, "burstChance", 0.18, 0, 1);
    let intensity = num(ctx.params, "intensity", 1, 0.1, 3);
    let tearShift = num(ctx.params, "tearShift", 1, 0, 4);
    let blockSize = int(ctx.params, "blockSize", BLOCK_SIZE, 4, 64);
    let colorTear = colorHex(ctx.params, "colorTear", "#dde2ee");
    let colorFringeA = colorHex(ctx.params, "colorFringeA", "#ff1a1a");
    let colorFringeB = colorHex(ctx.params, "colorFringeB", "#1a4aff");

    let time = 0;
    /*
     * The first event is scheduled from the *configured* gap rather than a fixed 2-to-6 seconds.
     *
     * The original hard-coded that initial delay, which meant an operator who set the gap to half a
     * second still waited several seconds for the first thing to happen and reasonably concluded the
     * effect was broken. A parameter should mean what it says from the first frame.
     */
    let nextEventTime = rand(
      Math.min(num(ctx.params, "gapMin", 3, 0.1, 60), num(ctx.params, "gapMax", 11, 0.2, 120)),
      Math.max(num(ctx.params, "gapMin", 3, 0.1, 60), num(ctx.params, "gapMax", 11, 0.2, 120)),
    );
    let burstsLeft = 0;
    let burstCooldownUntil = 0;
    let active: CorruptEvent | null = null;

    /** Decides when the next event happens, and whether this one starts a cluster. */
    const scheduleNext = (): void => {
      if (burstsLeft > 0) {
        burstsLeft -= 1;
        nextEventTime = time + rand(0.08, 0.35);
        // After a cluster, force a long quiet period. Without it, clusters would sometimes chain
        // into each other and the effect would read as continuous noise.
        if (burstsLeft === 0) burstCooldownUntil = time + rand(10, 22);
        return;
      }

      const low = Math.min(gapMin, gapMax);
      const high = Math.max(gapMin, gapMax);
      nextEventTime = time + rand(low, high);
      if (Math.random() < burstChance && time >= burstCooldownUntil) {
        burstsLeft = Math.floor(rand(2, 5));
      }
    };

    /** Builds one event's contents up front, so the shapes stay put while it plays out. */
    const createEvent = (): CorruptEvent => {
      const w = stage.width;
      const h = stage.height;
      const roll = Math.random();
      const kind: EventKind = roll < 0.42 ? "tear" : roll < 0.72 ? "block" : "combined";
      const tears: TearBand[] = [];
      const blocks: Block[] = [];

      if (kind !== "block") {
        const count = Math.floor(rand(1, 4));
        for (let i = 0; i < count; i += 1) {
          tears.push({
            y: rand(0, h),
            h: rand(1, 22),
            shiftX: (Math.random() < 0.5 ? 1 : -1) * rand(6, 90) * tearShift,
            // One tear in eight is pure white rather than the off-white, which reads as a harder hit.
            color: Math.random() < 0.12 ? "#ffffff" : colorTear,
            alpha: rand(0.25, 0.7),
            rgbShift: rand(4, 20),
          });
        }
      }

      if (kind !== "tear") {
        const cols = Math.floor(rand(3, 18));
        const rows = Math.floor(rand(2, 9));
        // Snapped to the block grid, so the patch aligns the way a codec's blocks would.
        const ox = Math.floor(rand(0, Math.max(1, w - cols * blockSize)) / blockSize) * blockSize;
        const oy = Math.floor(rand(0, Math.max(1, h - rows * blockSize)) / blockSize) * blockSize;

        for (let r = 0; r < rows; r += 1) {
          for (let c = 0; c < cols; c += 1) {
            // Only 70% of the patch is filled, so it has ragged edges rather than being a rectangle.
            if (Math.random() >= 0.7) continue;
            const luma = Math.floor(rand(55, 235));
            const grey = luma.toString(16).padStart(2, "0");
            const isChroma = Math.random() < 0.1;
            blocks.push({
              x: ox + c * blockSize,
              y: oy + r * blockSize,
              // A tenth of the blocks take a strong colour: that is what a corrupted chroma plane
              // looks like, and it is what stops the patch reading as plain grey noise.
              color: isChroma
                ? Math.random() < 0.5
                  ? "#1a3a8f"
                  : "#8f1a2a"
                : `#${grey}${grey}${grey}`,
              alpha: rand(0.1, 0.4),
            });
          }
        }
      }

      return { startTime: time, duration: rand(duration * 0.4, duration * 1.8), tears, blocks };
    };

    const clearAll = (): void => {
      blockLayer.clear();
      tearLayer.clear();
      fringeLayer.clear();
    };

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      time += dt;

      if (active === null && time >= nextEventTime) active = createEvent();

      if (active !== null) {
        const age = time - active.startTime;
        if (age >= active.duration) {
          active = null;
          clearAll();
          scheduleNext();
        } else {
          const p = age / active.duration;
          // Snap in over the first fifteenth, ease out over the second half. Arriving abruptly and
          // leaving smoothly is what makes it read as a fault rather than as a fade.
          const opacity =
            Math.min(p * 15, 1) * (p < 0.5 ? 1 : 1 - Math.pow((p - 0.5) * 2, 1.8)) * intensity;
          const w = stage.width;

          blockLayer.clear();
          for (const block of active.blocks) {
            blockLayer
              .rect(block.x, block.y, blockSize, blockSize)
              .fill({ color: block.color, alpha: block.alpha * opacity });
          }

          tearLayer.clear();
          fringeLayer.clear();
          for (const tear of active.tears) {
            const a = tear.alpha * opacity;
            if (a < 0.01) continue;
            const shift = tear.rgbShift;
            // One channel shoved left and one right, with the intact band drawn over the top. That
            // ordering is what leaves colour visible only at the band's edges.
            fringeLayer
              .rect(tear.shiftX - shift * 1.4, tear.y, w, tear.h)
              .fill({ color: colorFringeA, alpha: a * 0.45 });
            fringeLayer
              .rect(tear.shiftX + shift, tear.y, w, tear.h)
              .fill({ color: colorFringeB, alpha: a * 0.38 });
            tearLayer.rect(tear.shiftX, tear.y, w, tear.h).fill({ color: tear.color, alpha: a });
          }
        }
      }

      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        gapMin = num(p, "gapMin", 3, 0.1, 60);
        gapMax = num(p, "gapMax", 11, 0.2, 120);
        duration = num(p, "duration", 0.28, 0.03, 2);
        burstChance = num(p, "burstChance", 0.18, 0, 1);
        intensity = num(p, "intensity", 1, 0.1, 3);
        tearShift = num(p, "tearShift", 1, 0, 4);
        blockSize = int(p, "blockSize", BLOCK_SIZE, 4, 64);
        colorTear = colorHex(p, "colorTear", "#dde2ee");
        colorFringeA = colorHex(p, "colorFringeA", "#ff1a1a");
        colorFringeB = colorHex(p, "colorFringeB", "#1a4aff");
      },
    };
  },
});

export default dataCorruption;
