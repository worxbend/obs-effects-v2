import * as PIXI from "pixi.js";

import { bool, colorHex, int, num, str } from "../paramUtils";
import { createPixiStage, defineEffect, onFrame, useFont } from "../sdk";

/**
 * Logo
 * ====
 *
 * Your logo, breathing and pulsing to a simulated heartbeat, with an ECG trace scrolling behind it,
 * concentric aura glows, three counter-rotating arcs, orbiting dots and a blinking LIVE badge.
 *
 * Ported from `logo.html` in the old `obs-effects` repository.
 *
 * ## The heartbeat is a real ECG waveform, and that is why it works
 *
 * The pulse is not a sine wave. `ecgSample` sums five Gaussian bumps at the positions a real
 * electrocardiogram has them — the small P wave, the sharp Q dip, the tall R spike, the S dip below
 * the line, and the broad T wave afterwards. That is what makes the trace read instantly as a
 * heartbeat rather than as a generic squiggle, and it is why the logo's punch has a "lub-dub": the
 * main beat fires when the cycle wraps and a smaller one at 28% through it.
 *
 * The interval is 0.857 seconds, which is 70 beats per minute.
 *
 * ## One deliberate change from the original
 *
 * The original ran on a **fixed 1/60-second step** regardless of the real frame time, with a comment
 * saying its motion was tuned to 60 fps. That is fine on a 60 Hz display and wrong everywhere else:
 * on a 144 Hz monitor the heart beats at 168 bpm, and under this platform's frame-rate cap it would
 * run in slow motion.
 *
 * Here every rate is expressed per second and driven by the real delta, so the beat is 70 bpm at any
 * frame rate. The constants were converted, not retuned — at 60 fps the motion is what it was.
 */

/** Seconds per heartbeat. 0.857 is 70 bpm. */
const BEAT_INTERVAL = 0.857;

/** How far through the cycle the quieter second beat fires. */
const DUB_PHASE_RATIO = 0.28;

/** Seconds of trace shown per horizontal pixel. */
const ECG_SCROLL = 0.007;

/** The Catppuccin palette the orbiting dots are drawn from. */
const ORBIT_PALETTE = [
  "#cba6f7",
  "#f38ba8",
  "#fab387",
  "#f9e2af",
  "#89dceb",
  "#74c7ec",
  "#b4befe",
  "#94e2d5",
];

interface OrbitDot {
  angle: number;
  speed: number;
  radius: number;
  size: number;
  color: string;
  alphaPhase: number;
  alphaSpeed: number;
}

/**
 * One sample of a simulated electrocardiogram, from about -0.18 to 1.0.
 *
 * Five Gaussian bumps at the positions a real trace has them. The numbers are the original's.
 */
function ecgSample(t: number): number {
  const phase = ((t % BEAT_INTERVAL) + BEAT_INTERVAL) % BEAT_INTERVAL;
  const n = phase / BEAT_INTERVAL;

  const p = 0.18 * Math.exp(-((n - 0.08) ** 2) / 0.004);
  const q = -0.08 * Math.exp(-((n - 0.148) ** 2) / 0.0008);
  const r = 1.0 * Math.exp(-((n - 0.175) ** 2) / 0.001);
  const s = -0.18 * Math.exp(-((n - 0.21) ** 2) / 0.001);
  const tw = 0.35 * Math.exp(-((n - 0.42) ** 2) / 0.008);

  return p + q + r + s + tw;
}

const logo = defineEffect({
  descriptor: {
    id: "logo",
    name: "Logo",
    description:
      "Your logo pulsing to a simulated heartbeat, with a scrolling ECG trace, aura glows, counter-rotating arcs, orbiting dots and a blinking LIVE badge.",
    engine: "pixi",
    category: "overlay",
    tags: ["logo", "heartbeat", "ecg", "overlay", "branding", "live"],
    previewNotes:
      "Point Logo Image at your own artwork — a transparent PNG works best. Transparent everywhere else, so it sits over a scene. The heartbeat is 70 bpm by default and is a real ECG waveform, not a sine wave.",
    params: [
      {
        key: "image",
        label: "Logo Image",
        kind: "text",
        default: "/effects/worxbend-logo.png",
        description:
          "URL of the logo. A transparent PNG is best. Unlike the mesh effects this one only draws the image, so it may be served from anywhere.",
      },
      {
        key: "size",
        label: "Logo Size",
        kind: "number",
        default: 200,
        min: 40,
        max: 800,
        step: 10,
        description: "Logo width in pixels. Everything else is proportioned from this.",
      },
      {
        key: "bpm",
        label: "Heart Rate",
        kind: "number",
        default: 70,
        min: 20,
        max: 200,
        step: 1,
        description: "Beats per minute. Drives both the logo's punch and the ECG trace.",
      },
      {
        key: "punch",
        label: "Beat Punch",
        kind: "number",
        default: 1,
        min: 0,
        max: 4,
        step: 0.05,
        description: "How much the logo swells on a beat. 0 leaves it breathing but not pulsing.",
      },
      {
        key: "ecg",
        label: "ECG Trace",
        kind: "boolean",
        default: true,
        description: "The scrolling heartbeat line behind the logo.",
      },
      {
        key: "ecgAmplitude",
        label: "ECG Height",
        kind: "number",
        default: 50,
        min: 5,
        max: 200,
        step: 5,
        description: "Peak height of the R spike, in pixels.",
      },
      {
        key: "aura",
        label: "Aura",
        kind: "boolean",
        default: true,
        description: "The concentric glows and the three counter-rotating arcs around the logo.",
      },
      {
        key: "orbitDots",
        label: "Orbiting Dots",
        kind: "number",
        default: 20,
        min: 0,
        max: 120,
        step: 1,
        description: "Dots circling the logo in three rings at different speeds.",
      },
      {
        key: "live",
        label: "LIVE Badge",
        kind: "boolean",
        default: true,
        description: "The blinking red dot and label beside the logo.",
      },
      {
        key: "liveText",
        label: "Badge Text",
        kind: "text",
        default: "LIVE",
        description: "Wording of the badge. Uses the bundled Silkscreen pixel font.",
      },
      {
        key: "colorPrimary",
        label: "Primary Colour",
        kind: "color",
        default: "#00ff41",
        description: "The main aura, the first arc and the ECG trace.",
      },
      {
        key: "colorSecondary",
        label: "Secondary Colour",
        kind: "color",
        default: "#c050ff",
        description: "The inner aura and the counter-rotating arc.",
      },
      {
        key: "colorTertiary",
        label: "Tertiary Colour",
        kind: "color",
        default: "#94e2d5",
        description: "The outermost arc.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    await useFont("24px Silkscreen");
    scope.checkpoint();

    const stage = await createPixiStage(scope, ctx);

    // Back to front: ECG, aura, orbit dots, the logo itself, then the badge.
    const ecgLayer = stage.stage.addChild(new PIXI.Graphics());
    const auraLayer = stage.stage.addChild(new PIXI.Graphics());
    const orbitLayer = stage.stage.addChild(new PIXI.Graphics());
    const logoLayer = stage.stage.addChild(new PIXI.Container());
    const badgeLayer = stage.stage.addChild(new PIXI.Graphics());

    let imageSrc = str(ctx.params, "image", "/effects/worxbend-logo.png");
    let logoSize = num(ctx.params, "size", 200, 40, 800);
    let bpm = num(ctx.params, "bpm", 70, 20, 200);
    let punch = num(ctx.params, "punch", 1, 0, 4);
    let showEcg = bool(ctx.params, "ecg", true);
    let ecgAmplitude = num(ctx.params, "ecgAmplitude", 50, 5, 200);
    let showAura = bool(ctx.params, "aura", true);
    let orbitCount = int(ctx.params, "orbitDots", 20, 0, 120);
    let showLive = bool(ctx.params, "live", true);
    let liveLabel = str(ctx.params, "liveText", "LIVE");
    let colorPrimary = colorHex(ctx.params, "colorPrimary", "#00ff41");
    let colorSecondary = colorHex(ctx.params, "colorSecondary", "#c050ff");
    let colorTertiary = colorHex(ctx.params, "colorTertiary", "#94e2d5");

    /*
     * The logo sprite.
     *
     * `Assets.load` is avoided in favour of a plain texture from a URL: this effect may be pointed
     * at any address, and Pixi's asset system caches by URL in a global registry that outlives the
     * effect — which is a leak across remounts when the URL keeps changing.
     */
    let sprite: PIXI.Sprite | null = null;

    const loadLogo = (src: string): void => {
      const previous = sprite;
      const texture = PIXI.Texture.from(src);
      const next = new PIXI.Sprite(texture);
      next.anchor.set(0.5);
      logoLayer.addChild(next);
      sprite = next;

      if (previous !== null) {
        previous.destroy({ texture: true });
      }
    };
    loadLogo(imageSrc);
    scope.defer(() => {
      sprite?.destroy({ texture: true });
      sprite = null;
    });

    const badgeText = scope.own(
      new PIXI.Text({
        text: liveLabel,
        style: new PIXI.TextStyle({
          fontFamily: "Silkscreen, monospace",
          fontSize: logoSize * 0.48,
          fill: "#39ff14",
        }),
      }),
      (t) => t.destroy(true),
    );
    badgeText.anchor.set(0, 0.5);
    stage.stage.addChild(badgeText);

    let orbitDots: OrbitDot[] = [];

    /** Three concentric rings of dots at different radii, speeds and directions. */
    const seedOrbit = (): void => {
      orbitDots = [];
      const rings = [
        { share: 0.4, radius: 0.62, speed: 0.55, dir: 1, size: 3.5 },
        { share: 0.35, radius: 0.82, speed: -0.38, dir: -1, size: 2.6 },
        { share: 0.25, radius: 1.05, speed: 0.24, dir: 1, size: 2 },
      ];
      for (const ring of rings) {
        const count = Math.round(orbitCount * ring.share);
        for (let i = 0; i < count; i += 1) {
          orbitDots.push({
            angle: (i / Math.max(1, count)) * Math.PI * 2 + Math.random() * 0.4,
            speed: ring.speed * ring.dir * (0.85 + Math.random() * 0.3),
            radius: logoSize * ring.radius,
            size: ring.size * (0.7 + Math.random() * 0.6),
            color: ORBIT_PALETTE[Math.floor(Math.random() * ORBIT_PALETTE.length)] ?? "#ffffff",
            alphaPhase: Math.random() * Math.PI * 2,
            alphaSpeed: 0.8 + Math.random() * 1.6,
          });
        }
      }
    };
    seedOrbit();

    let time = 0;
    let beatDecay = 0;

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      const interval = 60 / bpm;
      const previousPhase = time % interval;
      time += dt;
      const phase = time % interval;

      // A beat when the cycle wraps, and a quieter one partway through — the "lub-dub".
      if (phase < previousPhase) beatDecay = 1;
      else if (previousPhase < interval * DUB_PHASE_RATIO && phase >= interval * DUB_PHASE_RATIO) {
        beatDecay = Math.max(beatDecay, 0.55);
      }
      // Per second rather than per frame: the original's 5.5/60 each frame is 5.5 a second.
      beatDecay = Math.max(0, beatDecay - 5.5 * dt);

      const cx = stage.width * 0.5;
      const cy = stage.height * 0.5;
      const float = Math.sin(time * 0.5) * 9;

      // ── The logo ────────────────────────────────────────────────────────
      if (sprite !== null && sprite.texture.width > 0) {
        const base = logoSize / sprite.texture.width;
        const breathe = 1 + 0.06 * Math.sin(time * 0.6);
        // Three fast sines summed — a tremor, so the logo is never perfectly still.
        const tremor =
          1 +
          0.013 * Math.sin(time * 19.4) +
          0.009 * Math.sin(time * 27.1) +
          0.006 * Math.sin(time * 41.7);
        sprite.scale.set(base * breathe * tremor * (1 + 0.18 * beatDecay * punch));
        sprite.x = cx + Math.sin(time * 17.3) * 1.8 + Math.sin(time * 31.1) * 1.0;
        sprite.y = cy + float + Math.cos(time * 23.7) * 1.4 + Math.cos(time * 37.9) * 0.8;
        sprite.alpha = 0.9 + Math.sin(time * 0.75) * 0.1;
      }

      const logoX = sprite?.x ?? cx;
      const logoY = cy + float;

      // ── Aura and arcs ───────────────────────────────────────────────────
      auraLayer.clear();
      if (showAura) {
        const aura = logoSize * 0.36 + logoSize * 0.04 * Math.sin(time * 0.5);

        auraLayer.circle(cx, logoY, aura * 2.4).fill({ color: colorPrimary, alpha: 0.04 });
        auraLayer.circle(cx, logoY, aura * 1.6).fill({ color: colorPrimary, alpha: 0.08 });
        auraLayer.circle(cx, logoY, aura * 1.0).fill({ color: colorSecondary, alpha: 0.06 });

        // Three arcs at different radii, speeds and directions. Counter-rotation is what stops them
        // reading as one rigid ring.
        const arcs = [
          {
            r: aura + 8,
            from: time * 0.75,
            span: Math.PI * 1.4,
            color: colorPrimary,
            a: 0.9,
            w: 1.5,
          },
          {
            r: aura,
            from: -time * 0.48 + Math.PI * 0.5,
            span: Math.PI * 0.8,
            color: colorSecondary,
            a: 0.65,
            w: 1,
          },
          {
            r: aura + 22,
            from: time * 0.32 + Math.PI,
            span: Math.PI * 0.55,
            color: colorTertiary,
            a: 0.5,
            w: 1,
          },
        ];
        for (const arc of arcs) {
          auraLayer
            .moveTo(cx + Math.cos(arc.from) * arc.r, logoY + Math.sin(arc.from) * arc.r)
            .arc(cx, logoY, arc.r, arc.from, arc.from + arc.span)
            .stroke({ color: arc.color, alpha: arc.a, width: arc.w, cap: "round" });
        }
      }

      // ── Orbiting dots ───────────────────────────────────────────────────
      orbitLayer.clear();
      for (const dot of orbitDots) {
        dot.angle += dot.speed * dt;
        dot.alphaPhase += dot.alphaSpeed * dt;
        const alpha = 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(dot.alphaPhase));
        orbitLayer
          .circle(
            cx + Math.cos(dot.angle) * dot.radius,
            logoY + Math.sin(dot.angle) * dot.radius,
            dot.size,
          )
          .fill({ color: dot.color, alpha });
      }

      // ── ECG trace ───────────────────────────────────────────────────────
      ecgLayer.clear();
      if (showEcg) {
        const half = logoSize;
        const samples = Math.max(32, Math.round(half * 2));

        // Traced three times at decreasing width and increasing opacity — the same cheap glow the
        // waveform effects use, and much cheaper than a blur filter.
        for (const pass of [
          { width: 18, alpha: 0.08 },
          { width: 5, alpha: 0.22 },
          { width: 1.5, alpha: 0.88 },
        ]) {
          for (let i = 0; i <= samples; i += 1) {
            // Each sample is a moment further into the past, which is what makes the trace scroll.
            const t = time - (samples - i) * ECG_SCROLL;
            const value = ecgSample((t * BEAT_INTERVAL) / interval) * ecgAmplitude;
            const x = logoX - half + (i / samples) * half * 2;
            const y = logoY - value;
            if (i === 0) ecgLayer.moveTo(x, y);
            else ecgLayer.lineTo(x, y);
          }
          ecgLayer.stroke({ color: colorPrimary, alpha: pass.alpha, width: pass.width });
        }
      }

      // ── LIVE badge ──────────────────────────────────────────────────────
      badgeLayer.clear();
      badgeText.visible = showLive && liveLabel !== "";
      if (showLive) {
        const blink = 0.4 + 0.6 * Math.max(0, Math.sin(time * 2.4));
        const bx = cx - logoSize * 0.5;
        const by = cy + logoSize * 0.72;
        badgeLayer.circle(bx, by, logoSize * 0.05).fill({ color: "#ff2a2a", alpha: blink });
        badgeText.position.set(bx + logoSize * 0.12, by);
      }

      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        const previousImage = imageSrc;
        const previousOrbit = orbitCount;
        const previousSize = logoSize;

        imageSrc = str(p, "image", "/effects/worxbend-logo.png");
        logoSize = num(p, "size", 200, 40, 800);
        bpm = num(p, "bpm", 70, 20, 200);
        punch = num(p, "punch", 1, 0, 4);
        showEcg = bool(p, "ecg", true);
        ecgAmplitude = num(p, "ecgAmplitude", 50, 5, 200);
        showAura = bool(p, "aura", true);
        orbitCount = int(p, "orbitDots", 20, 0, 120);
        showLive = bool(p, "live", true);
        liveLabel = str(p, "liveText", "LIVE");
        colorPrimary = colorHex(p, "colorPrimary", "#00ff41");
        colorSecondary = colorHex(p, "colorSecondary", "#c050ff");
        colorTertiary = colorHex(p, "colorTertiary", "#94e2d5");

        badgeText.text = liveLabel;
        badgeText.style.fontSize = logoSize * 0.48;

        if (imageSrc !== previousImage) loadLogo(imageSrc);
        if (orbitCount !== previousOrbit || logoSize !== previousSize) seedOrbit();
      },
    };
  },
});

export default logo;
