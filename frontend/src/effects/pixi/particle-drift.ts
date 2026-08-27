import * as PIXI from "pixi.js";
import { createPixiStage, defineEffect, onFrame } from "../sdk";
import { colorHex, int, num } from "../paramUtils";

/**
 * Particle Drift
 * ==============
 *
 * Soft out-of-focus dots — "bokeh", the photographic word for the blurry highlights a lens produces
 * behind its focal plane — drifting slowly upwards. Good as a calm, non-distracting overlay.
 *
 * Two techniques carry this effect:
 *
 * 1. **One texture, many sprites.** Drawing a blurry circle is expensive; drawing the *same* blurry
 *    circle a thousand times is cheap, because the GPU can reuse a single image. So we paint one
 *    radial-gradient dot into an ordinary 2D `<canvas>` once, turn it into a GPU texture, and give
 *    every particle a `Sprite` that points at it. The `tint` property then recolours each sprite
 *    for free — tinting is a per-sprite multiply the GPU does while drawing.
 *
 * 2. **Additive blending.** With the normal blend mode an overlapping sprite hides what is beneath
 *    it. With `"add"` the colours are summed, so overlapping particles glow brighter, which is what
 *    real out-of-focus lights do.
 *
 * ## What changed in the Phase 3.1 SDK migration
 *
 * Pixi v8's `Application.init()` is asynchronous — it may have to pick and boot a WebGPU or WebGL
 * backend — while the renderer needs `mount()` to hand back a usable instance straight away. This
 * file used to bridge that gap by hand: it created the `Application` itself, kept a `disposed` flag
 * and a `ready` flag, guarded every method with them, and carried an `if (disposed) { app.destroy(…) }`
 * branch inside the `init().then(…)` for the case where the route changed while the renderer was
 * still booting.
 *
 * All of that is now the SDK's job. `defineEffect` lets `setup` be an ordinary `async` function and
 * takes care of the handshake — a `resize` or `setParams` that arrives before setup finishes is
 * recorded and replayed. `createPixiStage` builds the application, registers its destruction on the
 * `scope`, and throws `Cancelled` at its `scope.checkpoint()` if the effect was disposed mid-boot,
 * which unwinds through the same teardown path as an ordinary disposal. So there is no `disposed`
 * flag, no `ready` flag, no `dispose` method and no second cleanup branch left in this file: what
 * remains is the bokeh.
 *
 * The one deliberate behavioural change: the animation now runs on the SDK's shared frame loop
 * (`onFrame`), which means it finally honours the route's frame-rate cap. The motion maths was
 * already expressed in pixels *per second* and multiplied by a delta time, so the drift looks
 * exactly as it did before at any refresh rate — the numbers below are unchanged.
 *
 * Note on `particleCount`: it looks like the classic candidate for the SDK's new `rebuild: true`
 * flag, which tells the renderer to dispose and remount the effect instead of calling `setParams`.
 * It deliberately does **not** get it. `setCount` grows and shrinks the pool in place, reusing every
 * sprite that already exists, so changing the count costs a few object allocations rather than a
 * fresh WebGL context — and a remount is visible on air as a black frame. `rebuild: true` is for
 * parameters that genuinely cannot change in place; this is not one.
 */

/** Radius in pixels of the source texture. Sprites are scaled from this, so it only sets quality. */
const TEXTURE_RADIUS = 32;

/** Paints one soft white dot, fading from opaque in the middle to invisible at the rim. */
function createDotCanvas(): HTMLCanvasElement {
  const size = TEXTURE_RADIUS * 2;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext("2d");
  if (g) {
    // A radial gradient interpolates between colour stops along the radius of a circle.
    const gradient = g.createRadialGradient(
      TEXTURE_RADIUS,
      TEXTURE_RADIUS,
      0,
      TEXTURE_RADIUS,
      TEXTURE_RADIUS,
      TEXTURE_RADIUS,
    );
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.35, "rgba(255,255,255,0.55)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gradient;
    g.fillRect(0, 0, size, size);
  }
  return canvas;
}

/** Per-particle state the frame loop updates. Kept in plain objects next to the sprite for clarity. */
interface Particle {
  sprite: PIXI.Sprite;
  /** Horizontal and vertical velocity in pixels per second, before the speed multiplier. */
  vx: number;
  vy: number;
  /** Relative size, 0.4..1.4, so the field has depth instead of one uniform dot size. */
  scale: number;
  /** Phase offset so the particles do not all twinkle in lock step. */
  phase: number;
}

export default defineEffect({
  descriptor: {
    id: "particle-drift",
    name: "Particle Drift",
    description:
      "Soft bokeh dust particles drifting upwards with additive blending, for a calm ambient overlay.",
    engine: "pixi",
    category: "overlay",
    tags: ["particles", "bokeh", "ambient", "overlay", "pixi"],
    previewNotes:
      "Works best over a dark scene, since additive blending only ever brightens. Lower Opacity for a subtle dust look.",
    params: [
      {
        key: "particleCount",
        label: "Particle Count",
        kind: "number",
        default: 220,
        min: 10,
        max: 2000,
        step: 10,
        description: "How many dots exist at once. Changing it adds or removes sprites in place.",
      },
      {
        key: "size",
        label: "Size",
        kind: "number",
        default: 26,
        min: 2,
        max: 160,
        step: 1,
        description: "Diameter in pixels of an average particle. Individual dots vary around this.",
      },
      {
        key: "speed",
        label: "Speed",
        kind: "number",
        default: 1,
        min: 0,
        max: 6,
        step: 0.05,
        description: "Multiplier on drift velocity. 0 leaves the particles hanging still.",
      },
      {
        key: "tint",
        label: "Tint",
        kind: "color",
        default: "#ffd9a0",
        description: "Colour multiplied over every particle.",
      },
      {
        key: "opacity",
        label: "Opacity",
        kind: "number",
        default: 0.7,
        min: 0,
        max: 1,
        step: 0.01,
        description: "Overall transparency of the whole particle layer.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    let particleCount = int(ctx.params, "particleCount", 220, 10, 2000);
    let size = num(ctx.params, "size", 26, 2, 160);
    let speed = num(ctx.params, "speed", 1, 0, 6);
    let tint = colorHex(ctx.params, "tint", "#ffd9a0");
    let opacity = num(ctx.params, "opacity", 0.7, 0, 1);

    const stage = await createPixiStage(scope, ctx, { antialias: true });
    scope.checkpoint();

    /*
     * The texture is not registered on the scope. `createPixiStage` registered
     * `app.destroy(true, { children: true, texture: true, textureSource: true })`, and that
     * argument set is what frees this texture along with its GPU source when the sprites holding it
     * are destroyed. Owning it separately would destroy it *before* the application — the scope
     * tears down in reverse registration order — and Pixi would then be asked to free it twice.
     */
    const texture = PIXI.Texture.from(createDotCanvas());

    const layer = stage.stage.addChild(new PIXI.Container());
    const particles: Particle[] = [];

    /** Gives one particle a fresh random position and velocity. */
    const seed = (p: Particle, anywhere: boolean): void => {
      p.sprite.x = Math.random() * stage.width;
      // `anywhere` is true when filling the screen at startup; otherwise the particle re-enters
      // from just below the bottom edge so you never see it appear.
      p.sprite.y = anywhere ? Math.random() * stage.height : stage.height + size;
      p.vx = (Math.random() - 0.5) * 12;
      p.vy = -(8 + Math.random() * 26);
      p.scale = 0.4 + Math.random();
      p.phase = Math.random() * Math.PI * 2;
    };

    /** Grows or shrinks the pool to `count`, reusing the sprites that already exist. */
    const setCount = (count: number): void => {
      while (particles.length > count) {
        const removed = particles.pop();
        if (removed) {
          layer.removeChild(removed.sprite);
          // `false` because the shared texture must survive — only this sprite goes away.
          removed.sprite.destroy(false);
        }
      }
      while (particles.length < count) {
        const sprite = new PIXI.Sprite(texture);
        sprite.anchor.set(0.5); // position refers to the dot's centre, not its top-left corner
        sprite.blendMode = "add";
        const particle: Particle = { sprite, vx: 0, vy: 0, scale: 1, phase: 0 };
        seed(particle, true);
        layer.addChild(sprite);
        particles.push(particle);
      }
    };

    /** Pushes tint and opacity onto the container; both are single GPU-side values. */
    const applyAppearance = (): void => {
      layer.alpha = opacity;
      layer.tint = tint;
    };

    setCount(particleCount);
    applyAppearance();

    /*
     * `elapsed` — seconds since this effect's first frame — is handed over by the shared clock
     * rather than accumulated here. It is a sum of the same clamped deltas the movement uses, so
     * the two wobble terms below stay in step with the drift exactly as they did when this file
     * kept its own counter.
     */
    onFrame(scope, ctx.fpsCap, ({ dt, elapsed }) => {
      const baseScale = size / (TEXTURE_RADIUS * 2);

      for (const p of particles) {
        p.sprite.x += p.vx * speed * dt;
        p.sprite.y += p.vy * speed * dt;
        // A slow sine wobble on X makes the drift look like air movement rather than a straight line.
        p.sprite.x += Math.sin(elapsed * 0.6 + p.phase) * 6 * dt;
        p.sprite.scale.set(baseScale * p.scale);
        // Each particle breathes its own alpha slightly, which reads as gentle twinkling.
        p.sprite.alpha = 0.55 + 0.45 * Math.sin(elapsed * 0.9 + p.phase);

        if (p.sprite.y < -size || p.sprite.x < -size || p.sprite.x > stage.width + size) {
          seed(p, false);
        }
      }

      // Pixi's own render loop is switched off by `createPixiStage`, so nothing reaches the canvas
      // until this line runs.
      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        size = num(p, "size", 26, 2, 160);
        speed = num(p, "speed", 1, 0, 6);
        tint = colorHex(p, "tint", "#ffd9a0");
        opacity = num(p, "opacity", 0.7, 0, 1);
        particleCount = int(p, "particleCount", 220, 10, 2000);
        applyAppearance();
        if (particles.length !== particleCount) setCount(particleCount);
      },
    };
  },
});
