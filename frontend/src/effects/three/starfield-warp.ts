import * as THREE from "three";
import { createThreeStage, defineEffect, onFrame } from "../sdk";
import { at, colorHex, int, num, rgb01 } from "../paramUtils";

/**
 * Starfield Warp
 * ==============
 *
 * A "flying through space" effect: thousands of stars stream past the camera and stretch into
 * streaks, the way stars look in the hyperspace shot of a science-fiction film.
 *
 * How it works, in plain terms
 * ----------------------------
 * We never draw stars one at a time with the CPU. Instead we upload one big array of numbers to the
 * graphics card (the GPU) and ask it to draw the whole lot in a single command. That array is called
 * a *buffer*, and the object that owns several such buffers is a `BufferGeometry`.
 *
 * Each star is drawn as a short line with two ends:
 *   - the *head*, at the star's current position,
 *   - the *tail*, a little further away from the camera.
 * Drawing a line instead of a dot is what produces the motion-blur streak. The longer the line, the
 * faster the ship appears to be moving. Two vertices per star, so a `THREE.LineSegments` object with
 * `2 * starCount` vertices is all we need.
 *
 * Coordinates: the camera sits at the origin looking down the negative Z axis (that is three.js's
 * default). A star at `z = -50` is far away; as `z` grows towards `0` the star approaches the
 * camera. When it passes the camera we "recycle" it: throw it back out to the far plane at a fresh
 * random X/Y. That recycling is why the field never runs out of stars and why we never allocate
 * memory once the animation is running.
 *
 * What Phase 3.1 changed, and what it deliberately did not
 * -------------------------------------------------------
 * This file used to create its own `THREE.WebGLRenderer`, its own `requestAnimationFrame` loop and
 * its own five-step teardown sequence, all of which were written out again in every other three.js
 * effect. They are now `createThreeStage`, `onFrame` and the effect's `Scope` — see
 * `docs/EFFECT_SDK.md` §6. Two consequences worth naming:
 *
 *  - the loop is the page's *one* shared loop, so the route's frame-rate cap (`ctx.fpsCap`) is
 *    honoured here for the first time; before, this effect drew as fast as the browser offered
 *    whatever the route said;
 *  - there is no `dispose` method any more. Everything that has to be released is registered next
 *    to the line that creates it, and the scope releases it all in reverse order. That order — the
 *    frame loop, then the geometry, then the material, then the renderer — is exactly the order the
 *    hand-written `dispose()` used to spell out.
 *
 * The maths, the parameters, their defaults and their ranges are untouched. A route saved before
 * this refactor renders identically after it.
 */

/** How far from the camera a star is respawned, in world units. */
const FAR_Z = 260;
/** How wide the star tunnel is. Stars are spawned inside a disc of this radius. */
const SPREAD = 90;

interface StarBuffers {
  geometry: THREE.BufferGeometry;
  /** Two vertices (head, tail) per star: [x, y, z] each, so 6 floats per star. */
  positions: Float32Array;
  /** Matching per-vertex colors, 3 floats per vertex. */
  colors: Float32Array;
  /** The "true" position of each star's head, one [x, y, z] triple per star. */
  seeds: Float32Array;
  /**
   * The three.js wrappers around `positions` and `colors`.
   *
   * They are kept here, rather than looked up as `geometry.attributes.position` each frame, for
   * two reasons: it is one fewer property lookup in the hot loop, and `geometry.attributes` is
   * typed as a dictionary that may or may not contain a given key, so reading it back would force
   * a needless "is it there?" check sixty times a second for something we just put there
   * ourselves.
   */
  positionAttribute: THREE.BufferAttribute;
  colorAttribute: THREE.BufferAttribute;
}

/** Allocates the GPU buffers for `count` stars and scatters them randomly through the tunnel. */
function createStars(count: number): StarBuffers {
  const positions = new Float32Array(count * 6);
  const colors = new Float32Array(count * 6);
  const seeds = new Float32Array(count * 3);

  for (let i = 0; i < count; i += 1) {
    respawn(seeds, i, Math.random() * FAR_Z);
  }

  const positionAttribute = new THREE.BufferAttribute(positions, 3);
  const colorAttribute = new THREE.BufferAttribute(colors, 3);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", positionAttribute);
  geometry.setAttribute("color", colorAttribute);
  // The stars move every frame, so three.js must not try to cull them against a stale bounding box.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), FAR_Z * 2);
  return { geometry, positions, colors, seeds, positionAttribute, colorAttribute };
}

/**
 * Places star `i` at a random point on a disc perpendicular to the view direction, `depth` units in
 * front of the camera. Using `sqrt(random)` for the radius spreads stars evenly over the disc's
 * *area*; using the raw random number would bunch them up in the middle.
 */
function respawn(seeds: Float32Array, i: number, depth: number): void {
  const angle = Math.random() * Math.PI * 2;
  const radius = Math.sqrt(Math.random()) * SPREAD;
  seeds[i * 3 + 0] = Math.cos(angle) * radius;
  seeds[i * 3 + 1] = Math.sin(angle) * radius;
  seeds[i * 3 + 2] = -depth;
}

export default defineEffect({
  descriptor: {
    id: "starfield-warp",
    name: "Starfield Warp",
    description:
      "A GPU point cloud of stars streaming towards the camera, stretched into motion-blur streaks for a hyperspace look.",
    engine: "three",
    category: "background",
    tags: ["space", "background", "motion", "three"],
    previewNotes:
      "Transparent background: put it under a webcam or over a dark scene in OBS. Raise Trail Length together with Speed for a stronger warp.",
    params: [
      {
        key: "starCount",
        label: "Star Count",
        kind: "number",
        default: 1200,
        min: 100,
        max: 8000,
        step: 100,
        description:
          "How many stars exist at once. Changing it reallocates the GPU buffers, so keep it steady during a stream if you are on weak hardware.",
      },
      {
        key: "speed",
        label: "Speed",
        kind: "number",
        default: 60,
        min: 1,
        max: 400,
        step: 1,
        description: "World units travelled per second. Higher means the stars rush past faster.",
      },
      {
        key: "colorA",
        label: "Trail Color",
        kind: "color",
        default: "#1b2a6b",
        description: "Color at the far end of each streak, where the star fades out.",
      },
      {
        key: "colorB",
        label: "Head Color",
        kind: "color",
        default: "#ffffff",
        description: "Color at the bright leading point of each star.",
      },
      {
        key: "trailLength",
        label: "Trail Length",
        kind: "number",
        default: 0.35,
        min: 0,
        max: 3,
        step: 0.05,
        description:
          "Streak length as a multiple of the distance a star covers in one second. 0 gives crisp dots.",
      },
      {
        key: "fov",
        label: "Field of View",
        kind: "number",
        default: 70,
        min: 20,
        max: 120,
        step: 1,
        description:
          "Camera lens angle in degrees. Wider values exaggerate the sense of speed at the screen edges.",
      },
    ],
  },

  setup({ ctx, scope }) {
    // Current parameter values. They are read fresh every frame by the animation loop.
    let starCount = int(ctx.params, "starCount", 1200, 100, 8000);
    let speed = num(ctx.params, "speed", 60, 1, 400);
    let colorA = colorHex(ctx.params, "colorA", "#1b2a6b");
    let colorB = colorHex(ctx.params, "colorB", "#ffffff");
    let trailLength = num(ctx.params, "trailLength", 0.35, 0, 3);
    let fov = num(ctx.params, "fov", 70, 20, 120);

    /*
     * The stage is the renderer, the scene and the camera in one object, with a transparent clear
     * colour so OBS composites the stars over your scene.
     *
     * `far` has to be pushed out past the spawn distance: a star is created at `z = -FAR_Z` and its
     * tail sits further back still, so the stage's default far plane of 2000 would be fine today
     * but the explicit `FAR_Z * 2` is what the hand-written camera used and what keeps the tail of a
     * freshly spawned star inside the view frustum whatever `FAR_Z` becomes later.
     */
    const stage = createThreeStage(scope, ctx, {
      antialias: true,
      camera: { kind: "perspective", fov, near: 0.1, far: FAR_Z * 2 },
    });

    // `vertexColors` tells the material to take each vertex's color from the geometry's color
    // buffer rather than from a single uniform, which is how one draw call gets a gradient per star.
    // Additive blending makes overlapping stars add their brightness together, like real light.
    const material = scope.ownDisposable(
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );

    let stars = createStars(starCount);
    let lines = new THREE.LineSegments(stars.geometry, material);
    stage.scene.add(lines);

    /*
     * The geometry is replaced whenever the star count changes, so it cannot be handed to
     * `scope.ownDisposable` at construction: that would register a teardown for the *first*
     * geometry and never for its replacements. One deferred teardown that reads `stars` when it
     * runs always disposes whichever geometry is current at that moment, and `rebuild` below
     * disposes the one it is throwing away. Between them every geometry this effect allocates is
     * released exactly once.
     */
    scope.defer(() => stars.geometry.dispose());

    /** Rebuilds the star buffers after the count changed, reusing stage and material. */
    const rebuild = (count: number): void => {
      stage.scene.remove(lines);
      stars.geometry.dispose();
      stars = createStars(count);
      lines = new THREE.LineSegments(stars.geometry, material);
      stage.scene.add(lines);
    };

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      const [ar, ag, ab] = rgb01(colorA);
      const [br, bg, bb] = rgb01(colorB);
      const trail = speed * trailLength;
      const { positions, colors, seeds } = stars;

      for (let i = 0; i < starCount; i += 1) {
        const s = i * 3;
        // Move the star towards the camera. z is negative in front of the camera, so adding
        // distance brings the star closer to z = 0, which is where the camera sits.
        seeds[s + 2] = at(seeds, s + 2) + speed * dt;
        if (at(seeds, s + 2) > -1) {
          respawn(seeds, i, FAR_Z);
        }

        const x = at(seeds, s + 0);
        const y = at(seeds, s + 1);
        const z = at(seeds, s + 2);

        // Fade a star in as it comes out of the far distance, so new stars never pop into view.
        const depthFade = Math.min(1, (FAR_Z + z) / (FAR_Z * 0.5));

        const p = i * 6;
        positions[p + 0] = x; // head
        positions[p + 1] = y;
        positions[p + 2] = z;
        positions[p + 3] = x; // tail, pushed back along the travel direction
        positions[p + 4] = y;
        positions[p + 5] = z - trail;

        colors[p + 0] = br * depthFade;
        colors[p + 1] = bg * depthFade;
        colors[p + 2] = bb * depthFade;
        colors[p + 3] = ar * depthFade;
        colors[p + 4] = ag * depthFade;
        colors[p + 5] = ab * depthFade;
      }

      // Telling three.js the buffers changed is what triggers the upload to the GPU this frame.
      stars.positionAttribute.needsUpdate = true;
      stars.colorAttribute.needsUpdate = true;
      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        speed = num(p, "speed", 60, 1, 400);
        colorA = colorHex(p, "colorA", "#1b2a6b");
        colorB = colorHex(p, "colorB", "#ffffff");
        trailLength = num(p, "trailLength", 0.35, 0, 3);

        const nextFov = num(p, "fov", 70, 20, 120);
        if (nextFov !== fov) {
          fov = nextFov;
          // The stage types its camera as the base `THREE.Camera` because it can build three
          // different shapes; this effect asked for a perspective one, so the cast is safe. The
          // projection matrix caches the field of view, so it must be recomputed after the change.
          const camera = stage.camera as THREE.PerspectiveCamera;
          camera.fov = fov;
          camera.updateProjectionMatrix();
        }

        const nextCount = int(p, "starCount", 1200, 100, 8000);
        if (nextCount !== starCount) {
          // Only the buffers depend on the count; the renderer and canvas stay alive, so the
          // viewer never sees a black frame. This is why `starCount` is not marked `rebuild: true`.
          starCount = nextCount;
          rebuild(starCount);
        }
      },
    };
  },
});
