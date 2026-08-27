/**
 * `createThreeStage` — the three.js boilerplate every Three effect used to repeat verbatim.
 *
 * All three existing Three effects opened with the identical five lines:
 *
 * ```ts
 * const renderer = new THREE.WebGLRenderer({ alpha: true, antialias });
 * renderer.setClearColor(0x000000, 0);
 * renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
 * renderer.setSize(width, height, false);
 * ctx.canvasHost.appendChild(renderer.domElement);
 * ```
 *
 * and closed with the identical teardown. Each of those lines is load-bearing and none is obvious:
 *
 *  - `alpha: true` plus a clear colour with **zero alpha** is what makes the canvas transparent, so
 *    OBS composites the effect over the scene behind it rather than over a black rectangle. Getting
 *    this wrong is the single most common way an overlay effect is unusable.
 *  - `setPixelRatio(min(devicePixelRatio, 2))` draws at the display's real density so the result is
 *    not soft on a high-DPI monitor, while capping the cost: a 3x display would otherwise ask the
 *    GPU for nine times the pixels for a difference nobody can see.
 *  - the `false` in `setSize(w, h, false)` means "do not also set the canvas's CSS size". The
 *    renderer page owns the layout — it scales the whole block to fit the OBS source — so three.js
 *    must size the *drawing buffer* and leave the style alone.
 *
 * ## What you get, and what you no longer write
 *
 * A stage owns the renderer, the scene, the camera and the canvas, and registers all of their
 * teardown on your `Scope`. An effect using one does not write a `dispose` method at all, and
 * usually does not write a `resize` method either: the stage resizes the renderer and reprojects
 * the camera, and {@link ThreeStage.onResize} is where the one effect-specific line goes.
 *
 * ## The renderer teardown is a single registration, and that is deliberate
 *
 * `renderer.dispose()`, `renderer.forceContextLoss()` and removing the canvas are registered as
 * **one** thunk, and this file is the only place in the application that calls
 * `forceContextLoss()`. The verification harness proves "disposed exactly once" by counting
 * `loseContext()` calls against mount/dispose cycles — twenty cycles must produce exactly twenty
 * calls, on twenty different contexts. One caller, in one place, is what keeps that number
 * meaningful.
 */

import * as THREE from "three";

import type { EffectContext } from "../types";
import { registerStageResize, type Scope } from "./scope";

/** How the stage should set up its camera. */
export type ThreeCameraOptions =
  /**
   * A normal 3D perspective camera at the origin, looking down -Z, with the aspect ratio kept in
   * step with the canvas. `fov` is the vertical field of view in degrees.
   *
   * `near` and `far` are the clipping planes: nothing closer than `near` or further than `far` is
   * drawn. Leave them alone unless your scene is unusually deep — a starfield that lets stars fly
   * in from far away needs a `far` past its spawn distance, or they pop into existence.
   */
  | { kind: "perspective"; fov: number; near?: number; far?: number }
  /**
   * An orthographic (no perspective) camera scaled so that **one world unit is one CSS pixel**, with
   * the origin at the centre of the canvas. Positive Y is up, so the top-left corner is
   * `(-width / 2, height / 2)`.
   *
   * This is what a 2D overlay wants: you can position a ring or a border in pixels and it stays put
   * when the source is resized.
   */
  | { kind: "orthographic-pixels" }
  /**
   * The unit clip-space camera a full-screen shader quad needs.
   *
   * A shader effect writes clip-space coordinates directly from its vertex shader (see
   * {@link import("./glsl").FULLSCREEN_VERTEX}), so the camera never actually transforms anything —
   * `renderer.render` simply requires one to exist. This camera is that formality and it never
   * distorts.
   */
  | { kind: "fullscreen-quad" };

/** Options for {@link createThreeStage}. */
export interface ThreeStageOptions {
  /**
   * Whether to ask the GPU for multisample antialiasing. Defaults to `true`.
   *
   * Turn it **off** for a full-screen shader quad: there are no polygon edges to smooth, so it buys
   * nothing and costs fill rate. Leave it on for geometry with visible edges — rings, lines, particles.
   */
  antialias?: boolean;
  camera: ThreeCameraOptions;
}

/** A ready-to-draw three.js setup, owned by a {@link Scope}. */
export interface ThreeStage {
  /** The renderer. You should not need it, beyond reading `renderer.capabilities`. */
  readonly renderer: THREE.WebGLRenderer;
  /** Add your meshes to this. */
  readonly scene: THREE.Scene;
  /**
   * The camera the stage created, already positioned and projected.
   *
   * It is typed as the base `THREE.Camera` because the stage supports three shapes. When you need
   * the concrete type — to change a perspective camera's `fov` from `setParams`, say — cast it and
   * call `updateProjectionMatrix()` yourself:
   *
   * ```ts
   * const camera = stage.camera as THREE.PerspectiveCamera;
   * camera.fov = num(p, "fov", 70, 20, 120);
   * camera.updateProjectionMatrix();
   * ```
   */
  readonly camera: THREE.Camera;
  /** Current drawing width in CSS pixels. Updated by {@link resize}. */
  readonly width: number;
  /** Current drawing height in CSS pixels. */
  readonly height: number;
  /**
   * Resizes the renderer and reprojects the camera.
   *
   * Returns immediately when the size has not actually changed, which matters because a
   * `ResizeObserver` can fire many times a second while an OBS source is being dragged.
   *
   * An effect normally does not call this: `defineEffect` forwards the renderer's `resize` to every
   * stage the effect created.
   */
  resize(w: number, h: number): void;
  /**
   * Registers a callback that runs after a resize that *actually changed* the size, once the
   * renderer and camera have already been updated.
   *
   * This is where the one size-dependent line of an effect goes — writing a `uResolution` uniform,
   * rebuilding geometry that is measured in pixels — and it is why most effects need no `resize`
   * method of their own.
   *
   * It does **not** fire for the initial size. You are constructing at that size already.
   */
  onResize(fn: (w: number, h: number) => void): void;
  /** Draws one frame. Call it at the end of your `onFrame` callback. */
  render(): void;
}

/**
 * Builds a renderer, a scene and a camera, attaches the canvas to the effect's host element, and
 * registers every piece of teardown on `scope`.
 *
 * ```ts
 * const stage = createThreeStage(scope, ctx, { camera: { kind: "perspective", fov: 70 } });
 * stage.scene.add(mesh);
 * onFrame(scope, ctx.fpsCap, ({ dt }) => { mesh.rotation.y += dt; stage.render(); });
 * ```
 *
 * If `scope` is already disposed when this is called — which can happen when an effect's setup ran
 * after a remount — the canvas is not attached, and everything created here is torn down
 * immediately by the scope. The returned stage is inert rather than broken: drawing into it paints
 * nothing, because its canvas is in no document.
 */
export function createThreeStage(
  scope: Scope,
  ctx: EffectContext,
  options: ThreeStageOptions,
): ThreeStage {
  let width = Math.max(1, Math.round(ctx.width));
  let height = Math.max(1, Math.round(ctx.height));

  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: options.antialias ?? true,
  });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height, false);

  /*
   * One registration, not three, and registered FIRST so that LIFO drain runs it LAST — after every
   * geometry and material the effect owns has already been released, which is the order three.js
   * expects. See this file's header for why `forceContextLoss()` lives only here.
   */
  scope.defer(() => {
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
  });

  scope.attach(ctx.canvasHost, renderer.domElement);

  const scene = new THREE.Scene();

  const camera = buildCamera(options.camera, width, height);
  const reproject = (): void => projectCamera(options.camera, camera, width, height);

  const resizeListeners: Array<(w: number, h: number) => void> = [];

  const stage: ThreeStage = {
    renderer,
    scene,
    camera,

    get width(): number {
      return width;
    },
    get height(): number {
      return height;
    },

    resize(w: number, h: number): void {
      const nextWidth = Math.max(1, Math.round(w));
      const nextHeight = Math.max(1, Math.round(h));
      if (nextWidth === width && nextHeight === height) return;
      width = nextWidth;
      height = nextHeight;
      renderer.setSize(width, height, false);
      reproject();
      for (const listener of resizeListeners) {
        try {
          listener(width, height);
        } catch (error) {
          console.error(`[sdk] A resize listener in "${scope.label}" threw.`, error);
        }
      }
    },

    onResize(fn: (w: number, h: number) => void): void {
      resizeListeners.push(fn);
    },

    render(): void {
      renderer.render(scene, camera);
    },
  };

  // So that the renderer page's `resize` reaches this stage without the effect writing a `resize`
  // method of its own. See the note beside `registerStageResize` in `./scope.ts`.
  registerStageResize(scope, (w, h) => stage.resize(w, h));

  return stage;
}

function buildCamera(options: ThreeCameraOptions, width: number, height: number): THREE.Camera {
  switch (options.kind) {
    case "perspective": {
      const camera = new THREE.PerspectiveCamera(
        options.fov,
        width / height,
        options.near ?? 0.1,
        options.far ?? 2000,
      );
      return camera;
    }
    case "orthographic-pixels": {
      const camera = new THREE.OrthographicCamera(
        -width / 2,
        width / 2,
        height / 2,
        -height / 2,
        -1000,
        1000,
      );
      // Pulled back along +Z so that geometry sitting at z = 0 is comfortably inside the near/far
      // range whichever way an effect stacks its layers.
      camera.position.z = 100;
      return camera;
    }
    case "fullscreen-quad":
      return new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
}

/** Re-derives whatever the camera's projection depends on the canvas size for. */
function projectCamera(
  options: ThreeCameraOptions,
  camera: THREE.Camera,
  width: number,
  height: number,
): void {
  if (options.kind === "perspective" && camera instanceof THREE.PerspectiveCamera) {
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    return;
  }
  if (options.kind === "orthographic-pixels" && camera instanceof THREE.OrthographicCamera) {
    camera.left = -width / 2;
    camera.right = width / 2;
    camera.top = height / 2;
    camera.bottom = -height / 2;
    camera.updateProjectionMatrix();
  }
  // "fullscreen-quad" is a unit clip-space camera: it does not depend on the canvas size at all.
}
