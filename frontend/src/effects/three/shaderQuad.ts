import * as THREE from "three";

import type { EffectContext, ParamSpec } from "../types";
import { num } from "../paramUtils";
import {
  createEnvelopes,
  createThreeStage,
  FULLSCREEN_VERTEX,
  onFrame,
  useAudio,
  type EffectHandle,
  type Scope,
} from "../sdk";

/**
 * The boilerplate every full-screen fragment-shader effect needs, written once.
 *
 * ## What it does
 *
 * Builds a quad that covers the frame, compiles a fragment shader onto it, and drives the three
 * uniforms that almost every screen-space shader wants:
 *
 * | Uniform | |
 * |---|---|
 * | `uTime` | seconds, accumulated at the effect's Speed |
 * | `uResolution` | canvas size in pixels, kept correct across resizes |
 * | `uAudio` | `vec4(level, slow, mid, fast)` — only when `reactive` is set |
 *
 * Anything else a shader needs is declared per effect and handed over as `uniforms`.
 *
 * ## Where this came from
 *
 * The old `obs-effects` repository had a `ShaderQuadScreen` base class doing exactly this, and
 * seven of the razer-* pages were a fragment shader and one line of constructor. Those shaders port
 * across essentially unchanged; this is the base they land on.
 *
 * Two mechanical differences from the original, neither of which changes a picture:
 *
 *  - **Three.js rather than a Pixi filter.** The original wrapped its shader in a `PIXI.Filter` on
 *    a white sprite, because its page harness was Pixi. Our SDK already has a full-screen quad on
 *    Three, so that is what these use. A fragment shader does not care which library set up its
 *    quad.
 *  - **GLSL ES 1.0 rather than 3.0.** Pixi filters compile as `#version 300 es`, with `in`/`out`
 *    declarations; Three's default is the older dialect, where the surface coordinate arrives as a
 *    `varying` and the result is written to `gl_FragColor`. Porting a shader means changing those
 *    three lines and nothing else.
 *
 * ## The audio, and what it honestly is
 *
 * `uAudio.y`, `.z` and `.w` were called `bass`, `mid` and `high` in the original. They were never
 * frequency bands — they are the same loudness tracked at three different speeds, which is all OBS
 * can give us. They are named `slow`/`mid`/`fast` in `sdk/envelopes.ts` for that reason, and the
 * shaders that use them are unchanged: a shader asking for "bass" was really asking for "the part
 * of the signal that moves slowly", and that is exactly what it gets.
 */

/** A uniform value this helper knows how to create and update. */
export type UniformValue = number | THREE.Vector2 | THREE.Vector3 | THREE.Vector4;

/** Reads the effect's parameters into the shader's own uniforms. */
export type UniformReader = (params: Record<string, unknown>) => Record<string, UniformValue>;

export interface ShaderQuadConfig {
  /** The complete fragment shader, normally built with `assembleFragment`. */
  fragment: string;
  /** Whether to declare and drive `uAudio`. Set it only if the shader reads it. */
  reactive?: boolean;
  /**
   * Builds the shader's own uniforms from the parameters.
   *
   * Called once at setup and again on every parameter change. Return the same keys every time —
   * a key that appears later will not have been compiled into the material.
   */
  uniforms?: UniformReader;
}

/**
 * The Speed control, which every shader quad has.
 *
 * Provided as a spec rather than baked in, so an effect lists it wherever it wants in its own
 * parameter order rather than always first.
 */
export const SPEED_PARAM: ParamSpec = {
  key: "speed",
  label: "Speed",
  kind: "number",
  default: 1,
  min: 0,
  max: 4,
  step: 0.05,
  description: "How fast the animation runs. 0 freezes it on the current frame.",
};

/** Applies a flat uniform map onto live three.js uniform objects, in place. */
function applyUniforms(
  target: Record<string, { value: UniformValue }>,
  next: Record<string, UniformValue>,
): void {
  for (const [key, value] of Object.entries(next)) {
    const slot = target[key];
    if (slot === undefined) continue;

    // Vectors are mutated rather than replaced. Three.js reads the object each frame, so assigning
    // a new instance also works — but mutating avoids allocating two vectors per parameter change,
    // and keeps the identity stable for anything holding a reference.
    if (typeof value === "number") {
      slot.value = value;
    } else if (value instanceof THREE.Vector2 && slot.value instanceof THREE.Vector2) {
      slot.value.copy(value);
    } else if (value instanceof THREE.Vector3 && slot.value instanceof THREE.Vector3) {
      slot.value.copy(value);
    } else {
      slot.value = value;
    }
  }
}

/**
 * Builds the `setup` half of a full-screen shader effect.
 *
 * ```ts
 * const myEffect = defineEffect({
 *   descriptor: { ..., params: [SPEED_PARAM, ...myParams] },
 *   setup: shaderQuadSetup({
 *     fragment: MY_SHADER,
 *     reactive: true,
 *     uniforms: (p) => ({ uGlow: num(p, "glow", 0.5, 0, 2) }),
 *   }),
 * });
 * ```
 */
export function shaderQuadSetup(
  config: ShaderQuadConfig,
): (args: { ctx: EffectContext; scope: Scope }) => Promise<EffectHandle> {
  return async ({ ctx, scope }): Promise<EffectHandle> => {
    let speed = num(ctx.params, "speed", 1, 0, 4);

    // Audio is acquired before the stage so that a scope disposed during the wait tears down with
    // nothing built. `useAudio` does not checkpoint for us — see its documentation.
    const bus = config.reactive === true ? await useAudio(scope) : null;
    if (bus !== null) scope.checkpoint();
    const envelopes = bus === null ? null : createEnvelopes(bus);

    // Antialiasing off: a full-screen quad has no polygon edges to smooth, so multisampling costs
    // fill rate and changes nothing.
    const stage = createThreeStage(scope, ctx, {
      antialias: false,
      camera: { kind: "fullscreen-quad" },
    });

    const custom = config.uniforms?.(ctx.params) ?? {};
    const uniforms: Record<string, { value: UniformValue }> = {
      uTime: { value: 0 },
      uResolution: { value: new THREE.Vector2(stage.width, stage.height) },
    };
    if (config.reactive === true) uniforms["uAudio"] = { value: new THREE.Vector4(0, 0, 0, 0) };
    for (const [key, value] of Object.entries(custom)) uniforms[key] = { value };

    const geometry = scope.ownDisposable(new THREE.PlaneGeometry(2, 2));
    const material = scope.ownDisposable(
      new THREE.ShaderMaterial({
        vertexShader: FULLSCREEN_VERTEX,
        fragmentShader: config.fragment,
        uniforms,
        /*
         * Transparent, with premultiplied alpha.
         *
         * These shaders are overlays: they write `vec4(colour * alpha, alpha)`, which is
         * premultiplied — the colour has already been scaled by the coverage. Blending that with
         * the default `SrcAlpha` factor would scale it a second time and leave dark fringes around
         * every soft edge, which on a glowing green border is exactly where it shows.
         */
        transparent: true,
        premultipliedAlpha: true,
        depthTest: false,
        depthWrite: false,
      }),
    );

    const quad = new THREE.Mesh(geometry, material);
    quad.frustumCulled = false;
    stage.scene.add(quad);

    stage.onResize((w, h) => {
      const slot = uniforms["uResolution"];
      if (slot !== undefined && slot.value instanceof THREE.Vector2) slot.value.set(w, h);
    });

    onFrame(scope, ctx.fpsCap, ({ dt, now }) => {
      const time = uniforms["uTime"];
      // Accumulated rather than read from the wall clock, so changing Speed alters the rate from
      // here on instead of jumping the animation to a different point in its cycle.
      if (time !== undefined && typeof time.value === "number") time.value += dt * speed;

      if (bus !== null && envelopes !== null) {
        bus.sample(now);
        envelopes.update(dt);
        const audio = uniforms["uAudio"];
        if (audio !== undefined && audio.value instanceof THREE.Vector4) {
          audio.value.set(bus.level, envelopes.slow, envelopes.mid, envelopes.fast);
        }
      }

      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        speed = num(p, "speed", 1, 0, 4);
        if (config.uniforms !== undefined) applyUniforms(uniforms, config.uniforms(p));
      },
    };
  };
}
