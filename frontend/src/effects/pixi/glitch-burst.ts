import * as PIXI from "pixi.js";

import { int, num } from "../paramUtils";
import { createPixiStage, defineEffect, onFrame, useChat } from "../sdk";

/**
 * Glitch Burst
 * ============
 *
 * A transparent overlay that stays invisible until something happens in Twitch chat, then throws a
 * single VHS-style tear across the screen: a thin horizontal band of displaced neon segments that
 * flicker through a palette, plus one to three full-width scan lines that sweep away from the band
 * like a CRT losing sync. Everything fades within a second and the screen is empty again.
 *
 * Ported from `scenes/glitch-overlay/glitch-overlay.ts` in the old twitch-vizer repository. What
 * changed in the port:
 *
 *  - The old scene opened its own `OverlayEventSocket` WebSocket; this version reads the shared
 *    chat bus via `useChat`, so every chat message, sub, cheer and raid fires a burst. When Twitch
 *    is not configured the SDK's simulated feed fires them instead.
 *  - The old scene had a keyboard preview (space bar); the simulated feed replaces it.
 *  - The old per-file constants (pixel grid size, burst lifetime, sweep-line count, palette size)
 *    are parameters now. Lifetimes were counted in ticker frames at an assumed 60 fps; they are
 *    expressed in seconds here and converted, so the frame-rate cap does not change the timing.
 *  - The hard-coded 15-colour neon palette is kept verbatim — it is the look — but a burst still
 *    only samples a random handful of it per event, exactly as the original did.
 */

/** The neon palette the original scene shipped with, unchanged. Each burst shuffles this and
 * takes a slice, so no two bursts flicker through quite the same colours. */
const NEON_PALETTE: number[] = [
  0x00ff41, 0xff00ff, 0x00ffff, 0xffff00, 0xff6600, 0xff0066, 0x66ff00, 0x0066ff, 0xff3300,
  0x33ff00, 0xff00aa, 0xaaff00, 0x00aaff, 0xff5500, 0x55ff00,
];

/** The original's timing constants were in ticker frames with a 60 fps baseline. Multiplying the
 * per-frame `dt` (seconds) by this reproduces those speeds regardless of the route's fps cap. */
const BASE_FPS = 60;

interface PixelBlock {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Random offset into the colour cycle, so blocks in one band do not all flicker in step. */
  phase: number;
  /** How fast this block steps through the burst's colours, in palette entries per time unit. */
  speed: number;
}

interface Burst {
  view: PIXI.Graphics;
  blocks: PixelBlock[];
  colors: number[];
  life: number;
  maxLife: number;
}

interface SweepLine {
  view: PIXI.Graphics;
  y: number;
  speed: number;
  life: number;
  maxLife: number;
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickColors(count: number): number[] {
  return [...NEON_PALETTE].sort(() => Math.random() - 0.5).slice(0, count);
}

const glitchBurst = defineEffect({
  descriptor: {
    id: "glitch-burst",
    name: "Glitch Burst",
    description:
      "Invisible until Twitch chat moves, then one VHS tear band of flickering neon segments rips across the screen with CRT scan lines sweeping away from it.",
    engine: "pixi",
    category: "chat",
    tags: ["chat", "twitch", "glitch", "vhs", "crt", "overlay", "reactive"],
    previewNotes:
      "Fires once per chat event and draws nothing in between. When Twitch is not configured, the SDK's simulated chat feed fires a burst every few seconds, so the preview still shows the effect. Transparent: lay it over a camera or capture.",
    params: [
      {
        key: "pixelSize",
        label: "Pixel Grid",
        kind: "number",
        default: 4,
        min: 2,
        max: 16,
        step: 1,
        description:
          "Size of the pixel grid everything snaps to, in pixels. Larger values make the tear chunkier and more obviously 'pixel art'; 4 matches the original scene.",
      },
      {
        key: "rowsMin",
        label: "Band Rows (min)",
        kind: "number",
        default: 2,
        min: 1,
        max: 12,
        step: 1,
        description: "Fewest scanline rows one tear band can have.",
      },
      {
        key: "rowsMax",
        label: "Band Rows (max)",
        kind: "number",
        default: 6,
        min: 1,
        max: 20,
        step: 1,
        description:
          "Most scanline rows one tear band can have. More rows make a taller, heavier tear.",
      },
      {
        key: "burstLife",
        label: "Burst Lifetime",
        kind: "number",
        default: 0.8,
        min: 0.2,
        max: 3,
        step: 0.05,
        description:
          "Roughly how long one tear band stays on screen, in seconds. Each burst varies a little either side of this.",
      },
      {
        key: "sweepLinesMax",
        label: "Sweep Lines",
        kind: "number",
        default: 3,
        min: 0,
        max: 8,
        step: 1,
        description:
          "Most thin full-width scan lines launched per burst (each burst picks 1 up to this; 0 disables them). They sweep up or down away from the band like a CRT artifact.",
      },
      {
        key: "sweepSpeed",
        label: "Sweep Speed",
        kind: "number",
        default: 1,
        min: 0.1,
        max: 4,
        step: 0.05,
        description: "Scales how fast the sweep lines travel away from the tear band.",
      },
      {
        key: "intensity",
        label: "Intensity",
        kind: "number",
        default: 1,
        min: 0.1,
        max: 2,
        step: 0.05,
        description: "Scales the opacity of everything a burst draws.",
      },
      {
        key: "maxBursts",
        label: "Max Simultaneous Bursts",
        kind: "number",
        default: 6,
        min: 1,
        max: 20,
        step: 1,
        description:
          "Cap on tear bands alive at once. A busy chat fires an event per message; beyond this cap the oldest burst is dropped early rather than stacking into solid noise.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    // Antialiasing off: everything drawn is axis-aligned rectangles snapped to a pixel grid, and
    // smoothing their edges would soften exactly the chunkiness the effect is going for.
    const stage = await createPixiStage(scope, ctx, { antialias: false });

    let pixelSize = int(ctx.params, "pixelSize", 4, 2, 16);
    let rowsMin = int(ctx.params, "rowsMin", 2, 1, 12);
    let rowsMax = int(ctx.params, "rowsMax", 6, 1, 20);
    let burstLife = num(ctx.params, "burstLife", 0.8, 0.2, 3);
    let sweepLinesMax = int(ctx.params, "sweepLinesMax", 3, 0, 8);
    let sweepSpeed = num(ctx.params, "sweepSpeed", 1, 0.1, 4);
    let intensity = num(ctx.params, "intensity", 1, 0.1, 2);
    let maxBursts = int(ctx.params, "maxBursts", 6, 1, 20);

    const bursts: Burst[] = [];
    const lines: SweepLine[] = [];
    /** Running clock in the original's time unit (ticker frames at 60 fps), which the colour
     * cycling and flicker maths below were tuned in. */
    let elapsed = 0;

    const snap = (value: number): number => Math.round(value / pixelSize) * pixelSize;

    /** Builds one tear band plus its sweep lines. A direct port of the original `trigger()`. */
    const trigger = (): void => {
      const width = stage.width;
      const height = stage.height;
      const px = pixelSize;

      // Drop the oldest burst rather than exceed the cap — chat can be far busier than the old
      // scene's occasional events, and unbounded stacking would turn the overlay into noise.
      while (bursts.length >= maxBursts) {
        const oldest = bursts.shift();
        oldest?.view.destroy();
      }

      // Random Y position for the horizontal glitch band, kept off the very edges.
      const bandY = snap(randInt(40, Math.max(41, height - 40)));
      const lowRows = Math.min(rowsMin, rowsMax);
      const highRows = Math.max(rowsMin, rowsMax);
      const rowCount = randInt(lowRows, highRows);
      const colors = pickColors(randInt(5, 9));
      const blocks: PixelBlock[] = [];

      for (let row = 0; row < rowCount; row += 1) {
        const rowY = bandY + row * px;
        // Each row starts at a random horizontal displacement — the VHS tear look, where every
        // scanline of the band is shoved sideways by a different amount.
        let x = snap((Math.random() - 0.5) * 40);

        while (x < width) {
          // Segment widths vary: mostly narrow or medium, occasionally very wide. The mix is what
          // makes the band read as torn signal rather than as a dashed line.
          const segRoll = Math.random();
          const segW =
            segRoll < 0.4
              ? px * randInt(1, 3)
              : segRoll < 0.75
                ? px * randInt(4, 10)
                : px * randInt(11, 22);

          const clampedX = Math.max(0, snap(x));
          const clampedW = Math.min(segW, width - clampedX);
          // Heights weighted towards a single grid row, with rarer 2-, 3- and 4-row segments.
          const hRoll = Math.random();
          const segH = hRoll < 0.5 ? px : hRoll < 0.76 ? px * 2 : hRoll < 0.91 ? px * 3 : px * 4;
          if (clampedW > 0) {
            blocks.push({
              x: clampedX,
              y: rowY,
              w: clampedW,
              h: segH,
              phase: Math.random() * colors.length,
              speed: 1.8 + Math.random() * 4.0,
            });
          }

          x += segW;
          // Occasional small gap between segments, so rows are broken rather than continuous.
          if (Math.random() < 0.18) x += px;
        }
      }

      const view = stage.stage.addChild(new PIXI.Graphics());
      // The original's lifetime was 38–60 frames around a 49-frame centre; scale that spread to
      // whatever lifetime the parameter asks for.
      const lifeFrames = burstLife * BASE_FPS;
      bursts.push({
        view,
        blocks,
        colors,
        life: 0,
        maxLife: lifeFrames * (0.78 + Math.random() * 0.44),
      });

      // Thin full-width scan lines sweeping away from the band — the CRT-losing-sync artifact.
      if (sweepLinesMax > 0) {
        const lineCount = randInt(1, sweepLinesMax);
        for (let i = 0; i < lineCount; i += 1) {
          const dir = Math.random() < 0.5 ? -1 : 1;
          const startY = snap(bandY + dir * randInt(0, rowCount) * px);
          const lineView = stage.stage.addChild(new PIXI.Graphics());
          lines.push({
            view: lineView,
            y: startY,
            speed: dir * randInt(4, 10),
            life: 0,
            maxLife: randInt(14, 24),
          });
        }
      }
    };

    const chat = await useChat(scope);
    scope.checkpoint();
    // Every kind of chat event fires a burst — a message, a sub, a cheer, a raid. The old scene
    // did the same with its event socket; here the message stream is the event stream.
    const off = chat.onMessage(() => {
      trigger();
    });
    scope.defer(off);

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      const delta = dt * BASE_FPS;
      elapsed += delta;
      const width = stage.width;

      // Update tear bands, newest last so they draw on top of older ones.
      for (let i = bursts.length - 1; i >= 0; i -= 1) {
        const burst = bursts[i];
        if (burst === undefined) continue;
        burst.life += delta;

        if (burst.life >= burst.maxLife) {
          burst.view.destroy();
          bursts.splice(i, 1);
          continue;
        }

        // Full brightness until 14 frames from the end, then a linear fade-out — bursts arrive
        // abruptly and leave smoothly, which is what makes them read as a fault.
        const fadeStart = burst.maxLife - 14;
        const fadeFactor =
          burst.life >= fadeStart
            ? Math.min(1, Math.max(0, (burst.maxLife - burst.life) / 14))
            : 1;

        burst.view.clear();
        for (const block of burst.blocks) {
          const colorIndex =
            Math.floor(elapsed * block.speed + block.phase) % burst.colors.length;
          // Each block flickers on its own sine wave; the phase term stops the whole band
          // pulsing in unison.
          const alpha = Math.min(
            1,
            Math.max(
              0,
              (0.62 + Math.sin(elapsed * 1.6 + block.phase * 2.9) * 0.36) *
                fadeFactor *
                intensity,
            ),
          );
          burst.view
            .rect(block.x, block.y, block.w, block.h)
            .fill({ color: burst.colors[colorIndex] ?? NEON_PALETTE[0], alpha });
        }
      }

      // Update sweep lines.
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i];
        if (line === undefined) continue;
        line.life += delta;

        if (line.life >= line.maxLife) {
          line.view.destroy();
          lines.splice(i, 1);
          continue;
        }

        line.y += line.speed * sweepSpeed * delta;
        const fadeAlpha = Math.min(1, Math.max(0, 1 - line.life / line.maxLife));
        line.view.clear();
        line.view.rect(0, line.y, width, 2).fill({
          // The line cycles through the palette as it travels, exactly as the original did.
          color: NEON_PALETTE[Math.floor(line.life * 4) % NEON_PALETTE.length] ?? NEON_PALETTE[0],
          alpha: fadeAlpha * 0.75 * intensity,
        });
      }

      stage.render();
    });

    // Bursts are positioned against the size at trigger time and live under a second, so there is
    // nothing to rebuild on resize — the next burst measures the new size. No onResize needed.

    return {
      setParams(p: Record<string, unknown>): void {
        pixelSize = int(p, "pixelSize", 4, 2, 16);
        rowsMin = int(p, "rowsMin", 2, 1, 12);
        rowsMax = int(p, "rowsMax", 6, 1, 20);
        burstLife = num(p, "burstLife", 0.8, 0.2, 3);
        sweepLinesMax = int(p, "sweepLinesMax", 3, 0, 8);
        sweepSpeed = num(p, "sweepSpeed", 1, 0.1, 4);
        intensity = num(p, "intensity", 1, 0.1, 2);
        maxBursts = int(p, "maxBursts", 6, 1, 20);
      },
    };
  },
});

export default glitchBurst;
