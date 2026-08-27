import * as THREE from "three";
import { FontLoader, type Font, type FontData } from "three/examples/jsm/loaders/FontLoader.js";
import { TextGeometry } from "three/examples/jsm/geometries/TextGeometry.js";

import { colorHex, num, str } from "../paramUtils";
import { createThreeStage, defineEffect, onFrame } from "../sdk";

/**
 * Worxbend 3D Text
 * ================
 *
 * Extruded, bevelled 3D lettering in glossy blood red, hovering and rocking gently while a
 * spring-mass simulation ripples waves through the geometry — the letters wobble like set jelly.
 * Four coloured lights orbit it, sweeping specular highlights across the gloss.
 *
 * Ported from `worxbend-3d-text.html` in the old `obs-effects` repository.
 *
 * ## The jelly, which is the whole effect
 *
 * Every vertex of the text geometry is a mass on a spring. Each frame a *target* offset is computed
 * from a few travelling sine waves, and the vertex accelerates towards it, with damping. Because the
 * spring overshoots and rings back once or twice before settling, the surface keeps moving after the
 * wave has passed — which is what reads as jelly rather than as a texture scrolling over a solid.
 *
 * Two details make it work and are easy to get wrong:
 *
 * **The target depends only on the vertex's rest X and Y, never its Z.** A letter's front face,
 * bevel and side wall all share an XY footprint but sit at different depths. Keying the displacement
 * on XY alone means all three receive the identical offset, so the mesh stays welded. Include Z and
 * the faces slide apart and the letters split open along their bevels.
 *
 * **Normals are deliberately not recomputed.** `TextGeometry` bakes normals that give hard edges on
 * the front face and smooth shading around the bevel. Recomputing them each frame averages across
 * that boundary and turns every triangle edge into a visible shading seam.
 *
 * ## What changed from the original
 *
 * The original built its own renderer, scene and camera and appended a canvas to `document.body`.
 * Here the SDK's three.js stage provides those. It also used `RoomEnvironment` for image-based
 * lighting at 6% intensity — that is dropped, because generating an environment map costs a render
 * target at startup and at that intensity the four coloured lights were doing essentially all the
 * work.
 *
 * The font is loaded from `/effects/helvetiker_bold.typeface.json` at runtime rather than imported,
 * which keeps 60 kB of glyph outlines out of the main bundle.
 */

/** Where the typeface lives. Shipped with the application, not fetched from a CDN. */
const FONT_URL = "/effects/helvetiker_bold.typeface.json";

/** Spring stiffness. Lower is floppier and slower to respond. */
const STIFFNESS = 0.048;

/** Velocity retained per step. Higher is more viscous and less bouncy. */
const DAMPING = 0.905;

const worxbend3dText = defineEffect({
  descriptor: {
    id: "worxbend-3d-text",
    name: "Worxbend 3D Text",
    description:
      "Extruded, bevelled 3D lettering in glossy blood red, hovering and rocking while a spring simulation ripples waves through it like set jelly.",
    engine: "three",
    category: "overlay",
    tags: ["text", "3d", "jelly", "logo", "branding", "red"],
    previewNotes:
      "Transparent background, so it sits over a scene. Set Text to your own wording — keep it short, since the geometry is rebuilt from scratch and long strings are expensive. Wobble at 0 gives a still, glossy solid.",
    params: [
      {
        key: "text",
        label: "Text",
        kind: "text",
        default: "WORXBEND",
        description:
          "The lettering. Rebuilt as 3D geometry whenever it changes, so keep it to a word or two.",
      },
      {
        key: "size",
        label: "Size",
        kind: "number",
        default: 1.58,
        min: 0.3,
        max: 4,
        step: 0.02,
        description: "Letter height in scene units. The camera does not move, so this is the zoom.",
      },
      {
        key: "depth",
        label: "Depth",
        kind: "number",
        default: 0.55,
        min: 0.05,
        max: 2,
        step: 0.05,
        description: "How far the letters are extruded towards the viewer.",
      },
      {
        key: "wobble",
        label: "Wobble",
        kind: "number",
        default: 1,
        min: 0,
        max: 4,
        step: 0.05,
        description:
          "How far the jelly waves push the surface. 0 leaves a still, glossy solid — the springs stop entirely.",
      },
      {
        key: "speed",
        label: "Speed",
        kind: "number",
        default: 1,
        min: 0,
        max: 4,
        step: 0.05,
        description: "How fast the waves travel and the lights orbit.",
      },
      {
        key: "colorBase",
        label: "Base Colour",
        kind: "color",
        default: "#8b0000",
        description: "The material itself, under the lights.",
      },
      {
        key: "colorEmissive",
        label: "Glow Colour",
        kind: "color",
        default: "#4a0000",
        description: "Light the material emits on its own, so the letters never go fully black.",
      },
      {
        key: "colorKey",
        label: "Key Light",
        kind: "color",
        default: "#ff0000",
        description:
          "The brightest orbiting light — it drives the specular flash across the gloss.",
      },
      {
        key: "colorFill",
        label: "Fill Light",
        kind: "color",
        default: "#cc0000",
        description: "The opposing light, which keeps the shadow side from going flat.",
      },
      {
        key: "colorEmber",
        label: "Ember Light",
        kind: "color",
        default: "#ff3300",
        description: "A warm light from below.",
      },
      {
        key: "roughness",
        label: "Roughness",
        kind: "number",
        default: 0.04,
        min: 0,
        max: 1,
        step: 0.01,
        description:
          "How matte the surface is. Near 0 is wet-looking gloss with tight highlights; 1 is chalk.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    /*
     * The typeface, fetched once.
     *
     * `FontLoader.parse` is synchronous; only the fetch is not. Loaded rather than imported so the
     * 60 kB of glyph outlines stay out of the main bundle — this is the only effect that needs them.
     */
    let font: Font | null = null;
    try {
      const response = await fetch(FONT_URL);
      if (response.ok) {
        // `response.json()` is typed `any`, and `parse` wants the typeface's own shape. The cast is
        // the one place this file asserts something the type system cannot check — the file is ours
        // and ships with the application, so its shape is not in question.
        const data = (await response.json()) as FontData;
        font = new FontLoader().parse(data);
      }
    } catch {
      font = null;
    }
    scope.checkpoint();

    if (font === null) {
      console.error(
        `[worxbend-3d-text] Could not load the typeface from ${FONT_URL}; nothing will be drawn.`,
      );
      return { setParams(): void {} };
    }
    const loadedFont = font;

    const stage = createThreeStage(scope, ctx, {
      camera: { kind: "perspective", fov: 42 },
    });
    stage.camera.position.set(0, 0, 17);

    // Ambient is a dark red rather than grey, so shadowed areas stay blood-tinted instead of dead.
    stage.scene.add(new THREE.AmbientLight(0x2a0000, 5));

    const keyLight = new THREE.PointLight(0xff0000, 280, 44);
    const fillLight = new THREE.PointLight(0xcc0000, 160, 36);
    const rimLight = new THREE.PointLight(0x550000, 100, 28);
    const emberLight = new THREE.PointLight(0xff3300, 90, 26);
    rimLight.position.set(1, -7, -5);
    stage.scene.add(keyLight, fillLight, rimLight, emberLight);

    const material = scope.ownDisposable(
      new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(colorHex(ctx.params, "colorBase", "#8b0000")),
        roughness: num(ctx.params, "roughness", 0.04, 0, 1),
        metalness: 0.18,
        clearcoat: 1,
        clearcoatRoughness: 0.03,
        reflectivity: 0.95,
        emissive: new THREE.Color(colorHex(ctx.params, "colorEmissive", "#4a0000")),
        emissiveIntensity: 0.75,
        side: THREE.FrontSide,
      }),
    );

    let text = str(ctx.params, "text", "WORXBEND");
    let size = num(ctx.params, "size", 1.58, 0.3, 4);
    let depth = num(ctx.params, "depth", 0.55, 0.05, 2);
    let wobble = num(ctx.params, "wobble", 1, 0, 4);
    let speed = num(ctx.params, "speed", 1, 0, 4);

    let mesh: THREE.Mesh | null = null;
    let geometry: TextGeometry | null = null;
    let restPositions = new Float32Array(0);
    let velocity = new Float32Array(0);
    let current = new Float32Array(0);

    /** Builds the lettering and the spring state that goes with it. */
    const buildText = (): void => {
      if (mesh !== null) {
        stage.scene.remove(mesh);
        mesh = null;
      }
      geometry?.dispose();

      geometry = new TextGeometry(text === "" ? " " : text, {
        font: loadedFont,
        size,
        depth,
        curveSegments: 20,
        bevelEnabled: true,
        bevelThickness: 0.24,
        bevelSize: 0.13,
        bevelOffset: 0,
        bevelSegments: 14,
      });

      // TextGeometry starts at the origin and runs right; centre it so rotation is about the middle.
      geometry.computeBoundingBox();
      const box = geometry.boundingBox;
      if (box !== null) {
        geometry.translate(-(box.max.x - box.min.x) / 2, -(box.max.y - box.min.y) / 2, 0);
      }

      const position = geometry.attributes["position"];
      if (position !== undefined) {
        restPositions = new Float32Array(position.array as Float32Array);
        // Three arrays of three components each: the spring's velocity and current offset per vertex.
        velocity = new Float32Array(position.count * 3);
        current = new Float32Array(position.count * 3);
      }

      mesh = new THREE.Mesh(geometry, material);
      stage.scene.add(mesh);
    };

    buildText();
    scope.defer(() => {
      if (mesh !== null) stage.scene.remove(mesh);
      geometry?.dispose();
    });

    let clock = 0;

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      clock += dt * speed;
      const t = clock;

      if (mesh !== null) {
        mesh.position.y = Math.sin(t * 0.5) * 0.22;
        // Rocking rather than spinning, so the words stay readable.
        mesh.rotation.y = Math.sin(t * 0.26) * 0.17;
        mesh.rotation.x = Math.sin(t * 0.36) * 0.058;
        mesh.scale.setScalar(1 + Math.sin(t * 0.65) * 0.018);
      }

      // Orbiting lights. This is what makes the gloss read as gloss: a highlight that travels
      // across the surface says "reflective" far more strongly than a bright material does.
      const lp = t * 0.3;
      keyLight.position.set(Math.cos(lp) * 11, 4 + Math.sin(lp * 0.52) * 3, Math.sin(lp) * 7 + 6);
      fillLight.position.set(
        Math.cos(lp + Math.PI) * 9,
        -2 + Math.cos(lp * 0.43) * 3,
        Math.sin(lp + Math.PI) * 6 + 4,
      );
      emberLight.position.set(
        Math.sin(lp * 0.68) * 6,
        -5 + Math.cos(lp * 0.5) * 2,
        Math.cos(lp * 0.68) * 4,
      );

      // ── The jelly ───────────────────────────────────────────────────────
      const position = geometry?.attributes["position"];
      if (position !== undefined && restPositions.length > 0) {
        const ampZ = 0.14 * wobble;
        const ampXY = 0.042 * wobble;
        // Springs are stepped per frame the way the original did. `dt * 60` keeps the ring-down at
        // its tuned rate rather than making the jelly stiffer on a fast display.
        const step = Math.min(dt * 60, 3);

        for (let i = 0; i < position.count; i += 1) {
          const i3 = i * 3;
          const ox = restPositions[i3] ?? 0;
          const oy = restPositions[i3 + 1] ?? 0;
          const oz = restPositions[i3 + 2] ?? 0;

          // Four travelling waves. Keyed on rest X and Y only — see the header for why Z must not
          // appear here.
          const targetZ =
            ampZ * Math.sin(ox * 2.0 + t * 1.0) * Math.cos(oy * 1.7 + t * 0.72) +
            ampZ * 0.55 * Math.sin(oy * 2.8 + t * 1.45) * Math.cos(ox * 2.2 + t * 0.82) +
            ampZ * 0.32 * Math.sin((ox + oy) * 1.5 + t * 1.85) +
            ampZ * 0.2 * Math.cos(ox * 3.8 + t * 2.3) * Math.sin(oy * 2.5 + t * 0.55);

          const targetX = ampXY * Math.sin(oy * 1.6 + t * 1.1) * Math.cos(ox * 0.7 + t * 0.68);
          const targetY =
            ampXY * 0.7 * Math.sin(ox * 1.9 + t * 0.88) * Math.cos(oy * 0.85 + t * 1.05);

          const damping = Math.pow(DAMPING, step);
          for (let axis = 0; axis < 3; axis += 1) {
            const target = axis === 0 ? targetX : axis === 1 ? targetY : targetZ;
            const index = i3 + axis;
            const v =
              ((velocity[index] ?? 0) + (target - (current[index] ?? 0)) * STIFFNESS * step) *
              damping;
            velocity[index] = v;
            current[index] = (current[index] ?? 0) + v * step;
          }

          position.setXYZ(
            i,
            ox + (current[i3] ?? 0),
            oy + (current[i3 + 1] ?? 0),
            oz + (current[i3 + 2] ?? 0),
          );
        }
        position.needsUpdate = true;
        // Normals are deliberately left alone — see the header.
      }

      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        const before = [text, size, depth].join("|");

        text = str(p, "text", "WORXBEND");
        size = num(p, "size", 1.58, 0.3, 4);
        depth = num(p, "depth", 0.55, 0.05, 2);
        wobble = num(p, "wobble", 1, 0, 4);
        speed = num(p, "speed", 1, 0, 4);

        material.color.set(colorHex(p, "colorBase", "#8b0000"));
        material.emissive.set(colorHex(p, "colorEmissive", "#4a0000"));
        material.roughness = num(p, "roughness", 0.04, 0, 1);
        keyLight.color.set(colorHex(p, "colorKey", "#ff0000"));
        fillLight.color.set(colorHex(p, "colorFill", "#cc0000"));
        emberLight.color.set(colorHex(p, "colorEmber", "#ff3300"));

        // Only the three that define the geometry force a rebuild; the rest are live.
        if ([text, size, depth].join("|") !== before) buildText();
      },
    };
  },
});

export default worxbend3dText;
