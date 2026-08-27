import * as PIXI from "pixi.js";

import { bool, colorHex, colorInt, int, num, str } from "../paramUtils";
import { createEnvelopes, createPixiStage, defineEffect, onFrame, useAudio, useFont } from "../sdk";

/**
 * Razer Status Line
 * =================
 *
 * A status bar across the bottom of the frame: a blinking live badge, a label, a small level meter
 * in the middle, and an uptime clock on the right.
 *
 * Ported from `razer-status-line.html` in the old `obs-effects` repository.
 *
 * The clock counts *this effect's* uptime, not the stream's
 * ---------------------------------------------------------
 * It starts at zero when the effect mounts and counts up from there. That is worth being explicit
 * about, because it looks like a stream timer and is not one: the renderer page remounts an effect
 * whenever its route changes, so saving a parameter resets the clock to `00:00:00` mid-broadcast.
 *
 * A real stream timer would have to come from OBS, which means a request this project's audio
 * connection does not make. Until it does, treat this as decoration that happens to be a clock — or
 * turn it off with the Clock parameter and use OBS's own timer source.
 *
 * The meter is loudness, not frequencies
 * --------------------------------------
 * Its 28 bars are driven by the three envelopes described in `sdk/envelopes.ts`, weighted so the
 * middle of the bar responds more than the ends. It reads as a spectrum analyser; it is not one.
 * OBS sends no spectrum.
 */

/** Bars in the level meter. The original's number. */
const BAR_COUNT = 28;

/** Pixels between bars. */
const BAR_GAP = 3;

const razerStatusLine = defineEffect({
  descriptor: {
    id: "razer-status-line",
    name: "Razer Status Line",
    description:
      "A status bar along the bottom of the frame: blinking live badge, label, a small audio level meter and an uptime clock.",
    engine: "pixi",
    category: "overlay",
    tags: ["razer", "overlay", "hud", "status", "lower-third", "reactive"],
    previewNotes:
      "An overlay for the bottom of the frame — everything above the band is transparent. The clock counts this effect's own uptime and resets whenever the route is saved, so do not rely on it as a stream timer. Uses a monospace font; no bundled font needed.",
    params: [
      {
        key: "label",
        label: "Label",
        kind: "text",
        default: "LIVE",
        description: "Text beside the badge. Leave it empty to show the badge alone.",
      },
      {
        key: "bandHeight",
        label: "Band Height",
        kind: "number",
        default: 56,
        min: 24,
        max: 160,
        step: 2,
        description: "Height of the bar in pixels.",
      },
      {
        key: "fontSize",
        label: "Font Size",
        kind: "number",
        default: 20,
        min: 8,
        max: 64,
        step: 1,
        description: "Size of the label and clock text.",
      },
      {
        key: "fontFamily",
        label: "Font",
        kind: "text",
        default: "'Share Tech Mono', 'Consolas', monospace",
        description:
          "A CSS font family. A monospace face keeps the clock from jittering as digits change.",
      },
      {
        key: "meter",
        label: "Level Meter",
        kind: "boolean",
        default: true,
        description: "The bank of bars in the middle of the band.",
      },
      {
        key: "clock",
        label: "Clock",
        kind: "boolean",
        default: true,
        description:
          "The uptime counter on the right. It counts from when this effect mounted, not from when the stream started.",
      },
      {
        key: "reactivity",
        label: "Reactivity",
        kind: "number",
        default: 1,
        min: 0,
        max: 3,
        step: 0.05,
        description: "How strongly the meter and badge respond to the audio.",
      },
      {
        key: "colorBand",
        label: "Band Colour",
        kind: "color",
        default: "#000a00",
        description: "The bar's background fill.",
      },
      {
        key: "bandOpacity",
        label: "Band Opacity",
        kind: "number",
        default: 0.72,
        min: 0,
        max: 1,
        step: 0.02,
        description: "How solid the bar is. 0 leaves only the top rule, the text and the meter.",
      },
      {
        key: "colorAccent",
        label: "Accent Colour",
        kind: "color",
        default: "#00c243",
        description: "The rule along the top of the band, and the quieter meter bars.",
      },
      {
        key: "colorBright",
        label: "Bright Colour",
        kind: "color",
        default: "#b0ff00",
        description: "The badge, and meter bars above 70%.",
      },
      {
        key: "colorLabel",
        label: "Label Colour",
        kind: "color",
        default: "#e8ffe0",
        description: "The label text.",
      },
      {
        key: "colorClock",
        label: "Clock Colour",
        kind: "color",
        default: "#36ff00",
        description: "The uptime text.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    const bus = await useAudio(scope);
    scope.checkpoint();
    const envelopes = createEnvelopes(bus);

    let fontSize = int(ctx.params, "fontSize", 20, 8, 64);
    let fontFamily = str(ctx.params, "fontFamily", "'Share Tech Mono', 'Consolas', monospace");

    // Wait for the face before any text is measured. Without this the first layout is computed from
    // a substituted font and the clock jumps sideways when the real one arrives.
    await useFont(`${fontSize}px ${fontFamily}`);
    scope.checkpoint();

    const stage = await createPixiStage(scope, ctx);

    const bandLayer = stage.stage.addChild(new PIXI.Graphics());
    const meterLayer = stage.stage.addChild(new PIXI.Graphics());
    const badgeLayer = stage.stage.addChild(new PIXI.Graphics());

    let labelText = str(ctx.params, "label", "LIVE");
    let bandHeight = num(ctx.params, "bandHeight", 56, 24, 160);
    let showMeter = bool(ctx.params, "meter", true);
    let showClock = bool(ctx.params, "clock", true);
    let reactivity = num(ctx.params, "reactivity", 1, 0, 3);
    let colorBand = colorInt(ctx.params, "colorBand", "#000a00");
    let bandOpacity = num(ctx.params, "bandOpacity", 0.72, 0, 1);
    let colorAccent = colorHex(ctx.params, "colorAccent", "#00c243");
    let colorBright = colorHex(ctx.params, "colorBright", "#b0ff00");
    let colorLabel = colorHex(ctx.params, "colorLabel", "#e8ffe0");
    let colorClock = colorHex(ctx.params, "colorClock", "#36ff00");

    /*
     * The two text objects, owned by the scope.
     *
     * `PIXI.Text` holds a texture of its rendered glyphs, so it must be destroyed rather than left
     * to the garbage collector. `destroy(true)` takes its texture with it — without the argument the
     * texture outlives the object, which is a leak that only shows up after a few hundred remounts.
     */
    const label = scope.own(
      new PIXI.Text({
        text: labelText,
        style: new PIXI.TextStyle({ fontFamily, fontSize, fill: colorLabel, letterSpacing: 2 }),
      }),
      (t) => t.destroy(true),
    );
    const clock = scope.own(
      new PIXI.Text({
        text: "00:00:00",
        style: new PIXI.TextStyle({ fontFamily, fontSize, fill: colorClock, letterSpacing: 2 }),
      }),
      (t) => t.destroy(true),
    );
    stage.stage.addChild(label);
    stage.stage.addChild(clock);

    const bars = new Float32Array(BAR_COUNT);
    const barSeeds = new Float32Array(BAR_COUNT);
    for (let i = 0; i < BAR_COUNT; i += 1) {
      const s = Math.sin(i * 71.13) * 43758.5453;
      barSeeds[i] = s - Math.floor(s);
    }

    let time = 0;
    let uptime = 0;
    let beatPulse = 0;
    let lastClockText = "";

    onFrame(scope, ctx.fpsCap, ({ dt, now }) => {
      bus.sample(now);
      envelopes.update(dt);
      time += dt;
      uptime += dt;

      const w = stage.width;
      const h = stage.height;
      const top = h - bandHeight;

      beatPulse += ((envelopes.beat ? 1 : 0) * reactivity - beatPulse) * Math.min(1, dt * 8);

      // ── The band ────────────────────────────────────────────────────────
      bandLayer.clear();
      if (bandOpacity > 0) {
        bandLayer.rect(0, top, w, bandHeight).fill({ color: colorBand, alpha: bandOpacity });
      }
      bandLayer.rect(0, top, w, 2).fill({ color: colorAccent, alpha: 0.9 });

      // ── The badge ───────────────────────────────────────────────────────
      const badgeX = 38;
      const badgeY = top + bandHeight / 2;
      const blink = 0.55 + 0.45 * Math.sin(time * 3.2);
      const radius = 8 + beatPulse * 3;

      badgeLayer.clear();
      badgeLayer
        .circle(badgeX, badgeY, radius + 6)
        .fill({ color: colorAccent, alpha: 0.18 * blink });
      badgeLayer.circle(badgeX, badgeY, radius).fill({ color: colorBright, alpha: blink });

      // ── Text placement ──────────────────────────────────────────────────
      label.x = 78;
      label.y = top + bandHeight / 2 - label.height / 2;
      label.visible = labelText !== "";

      clock.visible = showClock;
      if (showClock) {
        const total = Math.floor(uptime);
        const hh = String(Math.floor(total / 3600)).padStart(2, "0");
        const mm = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
        const ss = String(total % 60).padStart(2, "0");
        const next = `${hh}:${mm}:${ss}`;
        // Assigning `text` re-renders the glyph texture, so it is only done when the second
        // actually changes rather than sixty times a second.
        if (next !== lastClockText) {
          clock.text = next;
          lastClockText = next;
        }
        clock.x = w - clock.width - 28;
        clock.y = top + bandHeight / 2 - clock.height / 2;
      }

      // ── The meter ───────────────────────────────────────────────────────
      meterLayer.clear();
      if (showMeter) {
        const barWidth = Math.max(3, w * 0.012);
        const left = w * 0.5 - (BAR_COUNT * (barWidth + BAR_GAP)) / 2;
        const maxHeight = bandHeight * 0.62;
        const baseline = top + bandHeight - 10;

        const energy =
          (envelopes.slow * 0.5 + envelopes.mid * 0.35 + envelopes.fast * 0.2 + bus.level * 0.4) *
          reactivity;

        for (let i = 0; i < BAR_COUNT; i += 1) {
          // The middle of the meter responds more than the ends, which is what makes it read as a
          // spectrum rather than as a row of identical bars.
          const centreBias = 1 - Math.abs(i / (BAR_COUNT - 1) - 0.5) * 2;
          const wobble = 0.5 + 0.5 * Math.sin(time * (2.4 + (barSeeds[i] ?? 0) * 3) + i * 0.6);
          const target = Math.min(
            1,
            0.05 + energy * (0.5 + centreBias * 0.6) * (0.6 + wobble * 0.5),
          );

          // Eased per second rather than per frame, so the meter settles at the same rate whatever
          // the frame rate. The original used a fixed 1/60 here and moved faster on a 144 Hz display.
          const current = bars[i] ?? 0;
          bars[i] = current + (target - current) * Math.min(1, dt * 12);

          const value = bars[i] ?? 0;
          const height = Math.max(2, value * maxHeight);
          meterLayer
            .rect(left + i * (barWidth + BAR_GAP), baseline - height, barWidth, height)
            .fill({ color: value > 0.7 ? colorBright : colorAccent, alpha: 0.55 + value * 0.45 });
        }
      }

      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        labelText = str(p, "label", "LIVE");
        bandHeight = num(p, "bandHeight", 56, 24, 160);
        fontSize = int(p, "fontSize", 20, 8, 64);
        fontFamily = str(p, "fontFamily", "'Share Tech Mono', 'Consolas', monospace");
        showMeter = bool(p, "meter", true);
        showClock = bool(p, "clock", true);
        reactivity = num(p, "reactivity", 1, 0, 3);
        colorBand = colorInt(p, "colorBand", "#000a00");
        bandOpacity = num(p, "bandOpacity", 0.72, 0, 1);
        colorAccent = colorHex(p, "colorAccent", "#00c243");
        colorBright = colorHex(p, "colorBright", "#b0ff00");
        colorLabel = colorHex(p, "colorLabel", "#e8ffe0");
        colorClock = colorHex(p, "colorClock", "#36ff00");

        // Text styles are objects on the live display object, so they are updated in place. Only
        // `text` triggers a re-render of the glyph texture; changing the style marks it dirty and
        // Pixi re-renders on the next draw.
        label.text = labelText;
        label.style.fontFamily = fontFamily;
        label.style.fontSize = fontSize;
        label.style.fill = colorLabel;
        clock.style.fontFamily = fontFamily;
        clock.style.fontSize = fontSize;
        clock.style.fill = colorClock;
      },
    };
  },
});

export default razerStatusLine;
