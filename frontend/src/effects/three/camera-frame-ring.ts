import * as THREE from "three";
import { createThreeStage, defineEffect, onFrame } from "../sdk";
import { colorHex, int, num } from "../paramUtils";

/**
 * Camera Frame Ring
 * =================
 *
 * A glowing ring that sits around a circular webcam cut-out in OBS. The middle of the ring is fully
 * transparent, so your camera (a *lower* source in the OBS scene) shows through it.
 *
 * Nothing here touches the webcam itself — the camera is a separate OBS source underneath this one,
 * and this effect only draws the ring around it. That is why it does not use the SDK's shared
 * webcam input (`useVideo`): there is no video for it to read.
 *
 * Two ideas make this simple:
 *
 * 1. **Pixel-space orthographic camera.** Instead of the usual perspective camera measured in
 *    abstract "world units", the stage is built with an orthographic camera whose frustum is
 *    exactly the canvas in pixels: left = -w/2, right = +w/2, and so on. One world unit is then one
 *    CSS pixel, so a ring radius of 200 really is 200 pixels on screen. No conversion maths anywhere
 *    else. That used to be eight hand-written lines here; it is now the SDK's
 *    `camera: { kind: "orthographic-pixels" }`, which builds the identical camera.
 *
 * 2. **A torus is just a circle swept around another circle.** `THREE.TorusGeometry(R, r, ...)`
 *    takes the big radius `R` (centre of the tube to the centre of the doughnut) and the tube radius
 *    `r` (how thick the ring is). Viewed straight-on it looks exactly like a stroked circle, but it
 *    has real 3D shading and can be tilted, which is what gives the slow "wobble" here.
 *
 * The glow is faked with two copies of the ring: a solid inner one and a larger, dimmer, blurred
 * one drawn with **additive blending** — a blend mode where the source colour is *added* to what is
 * already on screen rather than replacing it, which is how light behaves and why overlapping glows
 * get brighter instead of muddier.
 *
 * ## What the Phase 3.1 SDK migration changed here
 *
 * Nothing about how it looks. What went away is the plumbing: the renderer/camera setup, the
 * `requestAnimationFrame` loop with its own `lastTime` and delta-time clamp, the `disposed` flag
 * guarding every method, and the hand-ordered `dispose()`. The renderer and canvas now belong to
 * `createThreeStage`, the loop is the shared clock (`onFrame`), which also means this effect now
 * honours the route's frame-rate cap for the first time, and teardown is whatever was registered on
 * the `Scope` — run in reverse construction order, which is the same order the old `dispose()`
 * spelled out by hand.
 *
 * The animation was already written in per-second units (`rotationSpeed * 2π * dt`, and a wobble
 * driven by accumulated `elapsed`), so moving it onto the shared clock's `dt`/`elapsed` — which use
 * the same 0.1 s clamp the old loop did — changes no speed at all.
 */

interface RingGeometry {
  core: THREE.TorusGeometry;
  halo: THREE.TorusGeometry;
}

/**
 * Builds the two torus geometries.
 * `radius` is a fraction (0..1) of half the shorter screen side, so the ring keeps framing the
 * camera when the OBS source is resized. `thickness` is a fraction of that radius.
 */
function buildGeometries(
  width: number,
  height: number,
  radius: number,
  thickness: number,
  segments: number,
): RingGeometry {
  const half = Math.min(width, height) / 2;
  const bigRadius = Math.max(1, half * radius);
  const tube = Math.max(0.5, bigRadius * thickness);
  // 8 radial segments is plenty for the tube itself; `segments` controls smoothness around the ring,
  // which is the part you actually see.
  return {
    core: new THREE.TorusGeometry(bigRadius, tube, 8, segments),
    halo: new THREE.TorusGeometry(bigRadius, tube * 2.6, 8, segments),
  };
}

export default defineEffect({
  descriptor: {
    id: "camera-frame-ring",
    name: "Camera Frame Ring",
    description:
      "An animated glowing ring with a fully transparent centre, sized to frame a circular webcam source in OBS.",
    engine: "three",
    category: "overlay",
    tags: ["overlay", "webcam", "frame", "glow", "three"],
    previewNotes:
      "Place this above your camera source in OBS and crop the camera to a circle. The centre never draws anything, so the camera stays visible.",
    params: [
      {
        key: "radius",
        label: "Radius",
        kind: "number",
        default: 0.8,
        min: 0.1,
        max: 1,
        step: 0.01,
        description:
          "Ring size as a fraction of half the shorter side of the source. 1 makes the ring touch the edges.",
      },
      {
        key: "thickness",
        label: "Thickness",
        kind: "number",
        default: 0.05,
        min: 0.005,
        max: 0.4,
        step: 0.005,
        description: "Tube thickness as a fraction of the ring radius.",
      },
      {
        key: "glowColor",
        label: "Glow Color",
        kind: "color",
        default: "#39e6ff",
        description: "Colour of both the solid ring and its surrounding halo.",
      },
      {
        key: "rotationSpeed",
        label: "Rotation Speed",
        kind: "number",
        default: 0.4,
        min: -4,
        max: 4,
        step: 0.05,
        description:
          "Turns per second around the viewing axis. Negative values spin the other way; 0 holds it still.",
      },
      {
        key: "pulseAmount",
        label: "Pulse Amount",
        kind: "number",
        default: 0.15,
        min: 0,
        max: 1,
        step: 0.01,
        description:
          "How much the ring breathes in and out, as a fraction of its size. 0 disables the pulse.",
      },
      {
        key: "segments",
        label: "Segments",
        kind: "number",
        default: 96,
        min: 12,
        max: 256,
        step: 4,
        description:
          "Number of straight edges used to approximate the circle. Low values give a deliberate polygonal look.",
      },
    ],
  },

  setup({ ctx, scope }) {
    let radius = num(ctx.params, "radius", 0.8, 0.1, 1);
    let thickness = num(ctx.params, "thickness", 0.05, 0.005, 0.4);
    let segments = int(ctx.params, "segments", 96, 12, 256);
    let rotationSpeed = num(ctx.params, "rotationSpeed", 0.4, -4, 4);
    let pulseAmount = num(ctx.params, "pulseAmount", 0.15, 0, 1);
    let glowColor = colorHex(ctx.params, "glowColor", "#39e6ff");

    // Antialiasing on: the ring has curved silhouette edges everywhere, which is exactly the case
    // multisampling is for. The stage's other defaults — a transparent clear colour, a capped pixel
    // ratio, a drawing buffer sized without touching the canvas's CSS size — are the five lines this
    // file used to open with, unchanged in effect.
    const stage = createThreeStage(scope, ctx, {
      antialias: true,
      camera: { kind: "orthographic-pixels" },
    });

    // MeshBasicMaterial ignores lights and just paints its own colour — exactly what you want for a
    // self-luminous overlay, and it means no light objects to create or dispose.
    const coreMaterial = scope.ownDisposable(
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(glowColor),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    const haloMaterial = scope.ownDisposable(
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(glowColor),
        transparent: true,
        opacity: 0.18,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );

    let geometries = buildGeometries(stage.width, stage.height, radius, thickness, segments);
    /*
     * One registration that reads the `geometries` variable when it runs, rather than
     * `scope.ownDisposable` on each torus.
     *
     * The difference matters because `rebuildGeometry` below replaces both geometries whenever the
     * size or a shape parameter changes, and it disposes the outgoing pair itself. Owning each new
     * pair individually would add two teardowns to the scope on every slider drag — an unbounded
     * list of teardowns for buffers that are already gone. Deferring "dispose whichever pair is
     * current" is one registration for the whole lifetime of the effect, and it releases exactly the
     * two geometries that are still alive at teardown.
     */
    scope.defer(() => {
      geometries.core.dispose();
      geometries.halo.dispose();
    });

    const group = new THREE.Group();
    const core = new THREE.Mesh(geometries.core, coreMaterial);
    const halo = new THREE.Mesh(geometries.halo, haloMaterial);
    group.add(halo, core);
    stage.scene.add(group);

    /** Swaps in freshly sized geometry. Meshes, materials and the renderer all survive. */
    const rebuildGeometry = (): void => {
      const next = buildGeometries(stage.width, stage.height, radius, thickness, segments);
      geometries.core.dispose();
      geometries.halo.dispose();
      geometries = next;
      core.geometry = next.core;
      halo.geometry = next.halo;
    };

    // The stage has already resized the renderer and re-derived the pixel-space frustum by the time
    // this runs; the ring is measured in pixels, so it has to be rebuilt to keep its relative size.
    // This is the whole of what used to be this effect's `resize` method.
    stage.onResize(() => rebuildGeometry());

    onFrame(scope, ctx.fpsCap, ({ dt, elapsed }) => {
      // One "turn" is a full 2*PI radians, so turns-per-second times 2*PI is radians per second.
      group.rotation.z += rotationSpeed * Math.PI * 2 * dt;
      // A gentle tilt on the other two axes catches the torus's roundness and reads as a highlight
      // travelling around the ring.
      group.rotation.x = Math.sin(elapsed * 0.7) * 0.12;
      group.rotation.y = Math.cos(elapsed * 0.5) * 0.12;

      // sin() swings between -1 and +1, so multiplying by pulseAmount and adding 1 gives a scale
      // that breathes between (1 - pulseAmount) and (1 + pulseAmount).
      const pulse = 1 + Math.sin(elapsed * 2.2) * pulseAmount * 0.5;
      group.scale.setScalar(pulse);
      haloMaterial.opacity = 0.12 + 0.12 * (0.5 + 0.5 * Math.sin(elapsed * 2.2));

      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        rotationSpeed = num(p, "rotationSpeed", 0.4, -4, 4);
        pulseAmount = num(p, "pulseAmount", 0.15, 0, 1);

        const nextColor = colorHex(p, "glowColor", "#39e6ff");
        if (nextColor !== glowColor) {
          glowColor = nextColor;
          coreMaterial.color.set(glowColor);
          haloMaterial.color.set(glowColor);
        }

        const nextRadius = num(p, "radius", 0.8, 0.1, 1);
        const nextThickness = num(p, "thickness", 0.05, 0.005, 0.4);
        const nextSegments = int(p, "segments", 96, 12, 256);
        if (nextRadius !== radius || nextThickness !== thickness || nextSegments !== segments) {
          // Shape parameters are baked into the vertex buffer, so these three are the only ones
          // that need new geometry. Everything else is a live material or transform tweak. They are
          // deliberately NOT declared `rebuild: true`: rebuilding in place keeps the renderer, the
          // WebGL context and the canvas alive, and the verification harness drags `thickness` and
          // asserts the canvas identity does not change.
          radius = nextRadius;
          thickness = nextThickness;
          segments = nextSegments;
          rebuildGeometry();
        }
      },
    };
  },
});
