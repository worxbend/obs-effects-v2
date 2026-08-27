/**
 * The effect scaffold generator: one command produces a new effect that already runs.
 *
 * ## Why this exists
 *
 * Roadmap item 3.3 puts it plainly: *"new effects should start from a working file, not a blank
 * one"*. Everything an effect has to get right — the descriptor the admin UI renders, the parameter
 * list, the SDK wiring, the frame loop, the teardown, the one line in `src/effects/index.ts` that
 * makes the effect exist at all — is the same in every effect and is the part that is easy to get
 * subtly wrong. A file that only *looks* finished is the expensive kind of mistake here: a missing
 * `stage.render()` paints nothing, and a parameter read in `setup` but not re-read in `setParams`
 * is a slider that silently does nothing.
 *
 * So this generator does not emit a stub full of `TODO`. It emits a complete, running, parameterised
 * effect — a drifting fractal-noise field for `three`, a ring of pulsing bokeh dots for `pixi` —
 * that passes `pnpm verify` the moment it is written. You then change the picture, not the plumbing.
 *
 * ## How to run it
 *
 *     pnpm new:effect <id> "<Human Name>" <three|pixi>
 *     pnpm new:effect aurora-ribbon "Aurora Ribbon" three
 *
 * or, without a Node on your machine — which is how every other command in this project is run:
 *
 *     make new-effect ID=aurora-ribbon NAME="Aurora Ribbon" ENGINE=three
 *
 * Two files change: a new `src/effects/<engine>/<id>.ts`, and `src/effects/index.ts`, which gains
 * an import, an array entry and a re-export. Nothing else in the codebase needs editing — the admin
 * dropdown, the backend inventory and the renderer all read that array. See the header comment of
 * `src/effects/index.ts` for why.
 *
 * ## Style notes for anyone editing this file
 *
 * It follows the conventions of `tools/verify/`: plain `.mjs` run directly by Node, no dependency
 * of its own, no build step, and comments written for someone who has never seen the project. The
 * generated source is emitted already formatted the way `prettier.config.mjs` would print it
 * (100 columns, double quotes, semicolons, trailing commas), so `pnpm format:check` passes on a
 * freshly generated file without anyone having to run `pnpm format` first. If you change a template
 * below, generate one effect and run `pnpm format:check` before committing — that is the only way to
 * find out that a line grew past 100 columns.
 */

import { readFile, writeFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = resolve(HERE, "..");
const EFFECTS_DIR = resolve(FRONTEND_ROOT, "src", "effects");
const INDEX_FILE = resolve(EFFECTS_DIR, "index.ts");

/**
 * The identifier rule from `docs/CONTRACT.md`, repeated here rather than imported.
 *
 * `src/types/contract.ts` holds the same regular expression, but that is TypeScript inside the
 * application bundle and this is a Node script that never goes through the compiler. Copying one
 * short line is better than making this tool depend on a build step; if the contract ever changes,
 * the mismatch shows up as a rejected id rather than as a corrupt file.
 */
const EFFECT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

const ENGINES = ["three", "pixi"];

/** Prints how to call this and exits with a failing status. */
function usage(problem) {
  console.error(
    [
      problem ? `${problem}\n` : "",
      'Usage: pnpm new:effect <id> "<Human Name>" <three|pixi>',
      "",
      "  <id>          lowercase letters, digits and hyphens, e.g. aurora-ribbon.",
      "                Becomes the file name, the URL-safe key stored on every route that uses",
      "                the effect, and the id the backend inventory is keyed by. It cannot be",
      "                changed later without orphaning routes, so choose it deliberately.",
      '  <Human Name>  what the admin dropdown shows, e.g. "Aurora Ribbon".',
      "  <engine>      three or pixi. three for anything shader-based or three-dimensional;",
      "                pixi for two-dimensional sprite and vector work.",
      "",
      'Example:  pnpm new:effect aurora-ribbon "Aurora Ribbon" three',
      'Or:       make new-effect ID=aurora-ribbon NAME="Aurora Ribbon" ENGINE=three',
    ].join("\n"),
  );
  process.exit(1);
}

/** True when a path exists. `access` throws when it does not, which is the whole test. */
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Turns `aurora-ribbon` into `auroraRibbon`.
 *
 * The id is hyphenated because it travels in JSON and in URLs; the JavaScript binding it is
 * imported under cannot contain a hyphen, so the two spellings have to be derived from each other
 * rather than asked for separately.
 */
function camelCase(id) {
  return id.replace(/-([a-z0-9])/g, (_, character) => character.toUpperCase());
}

/** Escapes a string for embedding in double-quoted generated TypeScript. */
function quoted(text) {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The `three` template: a drifting fractal-noise field, coloured by a palette parameter.
 *
 * Why this particular picture, and not something simpler: it exercises the four SDK pieces a
 * shader-based effect always needs — `createThreeStage` with the full-screen-quad camera,
 * `assembleFragment` pulling shared GLSL chunks in, `onFrame` for the animation, and a palette
 * parameter — while being short enough to read in one sitting and delete in one edit. Every
 * parameter it declares is re-read in `setParams`, which is the rule that has no compiler check.
 */
function threeTemplate({ id, name }) {
  return `import * as THREE from "three";

import { num } from "../paramUtils";
import {
  assembleFragment,
  createThreeStage,
  defineEffect,
  FULLSCREEN_VERTEX,
  onFrame,
  palette,
  paletteAt01,
  paletteParam,
} from "../sdk";

/**
 * ${name}
 * ${"=".repeat(name.length)}
 *
 * Generated by \`pnpm new:effect ${id} ${quoted(name)} three\`. It runs as it stands — a slow
 * fractal-noise field, coloured between two samples of the chosen palette, fading to transparent
 * where the noise is darkest so it layers over a webcam. Replace the shader body with the effect you
 * actually want; the wiring around it is already correct.
 *
 * ## What the SDK is doing for you here, so you know what not to write
 *
 * - \`createThreeStage\` builds the renderer, the scene and a camera, attaches the canvas to the
 *   host \`<div>\`, and registers every piece of teardown on the scope. There is no \`dispose\`
 *   method in this file and there must not be one: the scope tears everything down in reverse order
 *   of construction when the renderer disposes the effect.
 * - \`{ kind: "fullscreen-quad" }\` is the camera a shader wants. The vertex shader writes clip-space
 *   coordinates directly (see \`FULLSCREEN_VERTEX\`), so the camera never transforms anything — it
 *   exists because \`renderer.render\` requires one.
 * - \`assembleFragment\` pastes the named GLSL chunks, and anything they depend on, above your body
 *   exactly once. Shaders have no imports, so before the shared library existed these functions were
 *   copied between effect files by hand. Do not paste \`precision highp float;\` into the body —
 *   \`assembleFragment\` emits it first, where it has to be.
 * - \`onFrame\` is the only animation loop an effect may start. It honours the route's frame-rate
 *   cap, hands you a delta time in seconds so the motion is independent of refresh rate, and stops
 *   itself when the effect is disposed.
 *
 * ## The one rule with no compiler check
 *
 * **Every value read in \`setup\` is re-read in \`setParams\`.** A parameter read once at mount and
 * never again is a slider that silently does nothing, which is quieter than a crash and therefore
 * worse. The only exception is a value that genuinely cannot change in place — a fixed-size GPU
 * buffer's length, a compile-time shader constant — and that one declares \`rebuild: true\` on its
 * \`ParamSpec\` so the renderer remounts instead. A remount is a black frame on air, so prefer
 * changing things in place.
 */

const FRAGMENT_SHADER = assembleFragment(
  ["hash", "noise2", "fbm"],
  /* glsl */ \`
  varying vec2 vUv;

  uniform float uTime;
  uniform float uScale;
  uniform float uOpacity;
  uniform vec3  uColorLow;
  uniform vec3  uColorHigh;
  uniform vec2  uResolution;

  void main() {
    // Correct for the aspect ratio, or the pattern is stretched on a wide source.
    vec2 uv = vUv;
    uv.x *= uResolution.x / max(uResolution.y, 1.0);

    // fbm — fractal Brownian motion — stacks several octaves of smooth noise, each finer and
    // fainter than the last. That self-similarity is what makes it read as cloud rather than blob.
    float value = fbm(uv * uScale + vec2(0.0, uTime * 0.35));
    value = clamp(value, 0.0, 1.0);

    vec3 color = mix(uColorLow, uColorHigh, value);

    // Alpha follows the value, so the darkest areas stay see-through in OBS.
    gl_FragColor = vec4(color, value * uOpacity);
  }
\`,
);

/** The two palette samples the shader mixes between. Read at mount and again on every change. */
function ramp(params: Record<string, unknown>): {
  low: [number, number, number];
  high: [number, number, number];
} {
  const chosen = palette(params, "palette", "neon-dusk");
  return { low: paletteAt01(chosen, 0.15), high: paletteAt01(chosen, 0.9) };
}

export default defineEffect({
  descriptor: {
    id: ${quoted(id)},
    name: ${quoted(name)},
    description:
      "A slow fractal-noise field in the chosen palette, transparent where it is darkest.",
    engine: "three",
    category: "background",
    tags: ["shader", "noise", "background", "three"],
    previewNotes: "Generated scaffold — replace this note with what the effect is actually for.",
    params: [
      paletteParam("palette", "Palette", "neon-dusk", "Colour ramp the field is drawn in."),
      {
        key: "scale",
        label: "Scale",
        kind: "number",
        default: 2.5,
        min: 0.5,
        max: 20,
        step: 0.1,
        description: "How many noise cells fit across the screen. Higher means finer detail.",
      },
      {
        key: "speed",
        label: "Speed",
        kind: "number",
        default: 0.6,
        min: 0,
        max: 4,
        step: 0.05,
        description: "Multiplier on how fast the field drifts. 0 freezes it into a still image.",
      },
      {
        key: "opacity",
        label: "Opacity",
        kind: "number",
        default: 0.85,
        min: 0,
        max: 1,
        step: 0.01,
        description: "Overall transparency of the whole layer.",
      },
    ],
  },

  setup({ ctx, scope }) {
    // Held in a closure variable because the frame loop reads it every frame and \`setParams\` writes
    // it. Everything else this effect can change lives in a uniform, which is the same idea.
    let speed = num(ctx.params, "speed", 0.6, 0, 4);

    // Antialiasing off: a full-screen quad has no polygon edges to smooth, so multisampling costs
    // fill rate and buys nothing. Leave it on (the default) for geometry with visible edges.
    const stage = createThreeStage(scope, ctx, {
      antialias: false,
      camera: { kind: "fullscreen-quad" },
    });

    const start = ramp(ctx.params);

    const uniforms = {
      uTime: { value: 0 },
      uScale: { value: num(ctx.params, "scale", 2.5, 0.5, 20) },
      uOpacity: { value: num(ctx.params, "opacity", 0.85, 0, 1) },
      uColorLow: { value: new THREE.Vector3(...start.low) },
      uColorHigh: { value: new THREE.Vector3(...start.high) },
      uResolution: { value: new THREE.Vector2(stage.width, stage.height) },
    };

    // \`ownDisposable\` registers the object's own \`dispose()\` with the scope and hands the object
    // back, so construction and teardown cannot drift out of step with each other.
    const geometry = scope.ownDisposable(new THREE.PlaneGeometry(2, 2));
    const material = scope.ownDisposable(
      new THREE.ShaderMaterial({
        vertexShader: FULLSCREEN_VERTEX,
        fragmentShader: FRAGMENT_SHADER,
        uniforms,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    );

    const quad = new THREE.Mesh(geometry, material);
    // The quad is always directly in front of the camera; skipping the culling test stops three.js
    // deciding it is off-screen and dropping it.
    quad.frustumCulled = false;
    stage.scene.add(quad);

    // The renderer's drawing buffer and the camera are resized by the stage. This is the one
    // size-dependent value this effect owns, which is why it needs no \`resize\` method of its own.
    stage.onResize((w, h) => uniforms.uResolution.value.set(w, h));

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      // Accumulating our own clock rather than reading the wall clock means changing Speed alters
      // the rate from here on instead of making the pattern jump.
      uniforms.uTime.value += dt * speed;
      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        speed = num(p, "speed", 0.6, 0, 4);
        uniforms.uScale.value = num(p, "scale", 2.5, 0.5, 20);
        uniforms.uOpacity.value = num(p, "opacity", 0.85, 0, 1);
        const next = ramp(p);
        uniforms.uColorLow.value.set(...next.low);
        uniforms.uColorHigh.value.set(...next.high);
      },
    };
  },
});
`;
}

/**
 * The `pixi` template: a slowly rotating ring of pulsing dots, coloured by a palette parameter.
 *
 * The picture is deliberately drawn from scratch every frame with a single `Graphics` object. That
 * is the cheapest correct starting point for two-dimensional work and it sidesteps the question a
 * newcomer would otherwise have to answer on day one — which display objects to keep, and when to
 * destroy them. When you outgrow it, keep sprites in a pool and move them, the way
 * `pixi/particle-drift.ts` does.
 */
function pixiTemplate({ id, name }) {
  return `import * as PIXI from "pixi.js";

import { int, num } from "../paramUtils";
import {
  createPixiStage,
  defineEffect,
  onFrame,
  palette,
  paletteAtInt,
  paletteParam,
} from "../sdk";

/**
 * ${name}
 * ${"=".repeat(name.length)}
 *
 * Generated by \`pnpm new:effect ${id} ${quoted(name)} pixi\`. It runs as it stands — a ring of dots
 * that rotates slowly and breathes in and out, each dot taking its colour from a different point of
 * the chosen palette. Replace the drawing with the effect you actually want; the wiring around it is
 * already correct.
 *
 * ## What the SDK is doing for you here, so you know what not to write
 *
 * - \`createPixiStage\` is \`await\`ed because Pixi v8's \`Application.init()\` is asynchronous: it
 *   may have to pick and boot a WebGPU or WebGL backend. The renderer still needs \`mount()\` to
 *   return a usable handle immediately, and \`defineEffect\` bridges that gap — a \`resize\` or
 *   \`setParams\` that arrives before setup finishes is recorded and replayed. So this file has no
 *   \`ready\` flag, no \`disposed\` flag and no \`dispose\` method.
 * - \`scope.checkpoint()\` immediately after **every** \`await\` is the one thing you have to
 *   remember. It throws \`Cancelled\` when the effect was disposed while the await was in flight,
 *   which unwinds straight into the ordinary teardown path instead of leaving a half-built stage
 *   attached to a host div that has moved on.
 * - **Nothing appears until \`stage.render()\` is called.** Pixi's own render loop is switched off on
 *   purpose, so that drawing happens on the SDK's shared clock, which honours the route's frame-rate
 *   cap. Every \`onFrame\` callback in a Pixi effect ends with \`stage.render()\`.
 *
 * ## The one rule with no compiler check
 *
 * **Every value read in \`setup\` is re-read in \`setParams\`.** A parameter read once at mount and
 * never again is a slider that silently does nothing, which is quieter than a crash and therefore
 * worse. The only exception is a value that genuinely cannot change in place, and that one declares
 * \`rebuild: true\` on its \`ParamSpec\` so the renderer remounts instead — visible on air as a black
 * frame, so prefer changing things in place.
 */

export default defineEffect({
  descriptor: {
    id: ${quoted(id)},
    name: ${quoted(name)},
    description: "A slowly rotating ring of pulsing dots, coloured across the chosen palette.",
    engine: "pixi",
    category: "overlay",
    tags: ["ring", "ambient", "overlay", "pixi"],
    previewNotes: "Generated scaffold — replace this note with what the effect is actually for.",
    params: [
      paletteParam("palette", "Palette", "neon-dusk", "Colour ramp spread around the ring."),
      {
        key: "dotCount",
        label: "Dot Count",
        kind: "number",
        default: 48,
        min: 3,
        max: 400,
        step: 1,
        description: "How many dots go around the ring.",
      },
      {
        key: "radius",
        label: "Radius",
        kind: "number",
        default: 0.32,
        min: 0.05,
        max: 0.6,
        step: 0.01,
        description: "Ring radius as a fraction of the shorter edge, so it scales with the source.",
      },
      {
        key: "dotSize",
        label: "Dot Size",
        kind: "number",
        default: 10,
        min: 1,
        max: 80,
        step: 1,
        description: "Radius of one dot in pixels, before the pulse.",
      },
      {
        key: "speed",
        label: "Speed",
        kind: "number",
        default: 0.5,
        min: 0,
        max: 4,
        step: 0.05,
        description: "Multiplier on rotation and pulse. 0 leaves the ring perfectly still.",
      },
      {
        key: "opacity",
        label: "Opacity",
        kind: "number",
        default: 0.9,
        min: 0,
        max: 1,
        step: 0.01,
        description: "Overall transparency of the whole layer.",
      },
    ],
  },

  async setup({ ctx, scope }) {
    /*
     * Read every parameter into a plain object, so that \`setParams\` is one assignment and the
     * drawing code below has a single place to read from. \`num\` and \`int\` come from
     * \`paramUtils.ts\` and degrade a bad stored value to the default rather than throwing — the
     * values arrive from a database and may be anything at all.
     */
    const read = (p: Record<string, unknown>) => ({
      colors: palette(p, "palette", "neon-dusk"),
      dotCount: int(p, "dotCount", 48, 3, 400),
      radius: num(p, "radius", 0.32, 0.05, 0.6),
      dotSize: num(p, "dotSize", 10, 1, 80),
      speed: num(p, "speed", 0.5, 0, 4),
      opacity: num(p, "opacity", 0.9, 0, 1),
    });

    let settings = read(ctx.params);

    const stage = await createPixiStage(scope, ctx, { antialias: true });
    scope.checkpoint();

    // One \`Graphics\` object, cleared and redrawn each frame. It is added to the stage's root
    // container, which \`createPixiStage\` destroys with the application, so there is nothing here
    // for the scope to own separately.
    const graphics = stage.stage.addChild(new PIXI.Graphics());

    /** Seconds since the effect started, advanced by the speed multiplier rather than by the clock. */
    let phase = 0;

    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      phase += dt * settings.speed;

      const centreX = stage.width / 2;
      const centreY = stage.height / 2;
      const ringRadius = Math.min(stage.width, stage.height) * settings.radius;

      graphics.clear();
      graphics.alpha = settings.opacity;

      for (let i = 0; i < settings.dotCount; i += 1) {
        const t = i / settings.dotCount;
        const angle = t * Math.PI * 2 + phase * 0.6;
        // Each dot breathes slightly out of step with its neighbours, which is what stops the ring
        // reading as one rigid object.
        const pulse = 0.65 + 0.35 * Math.sin(phase * 2 + t * Math.PI * 4);

        graphics
          .circle(
            centreX + Math.cos(angle) * ringRadius,
            centreY + Math.sin(angle) * ringRadius,
            settings.dotSize * pulse,
          )
          .fill({ color: paletteAtInt(settings.colors, t) });
      }

      // Nothing above put a pixel on the canvas: this line does. See the header note on the ticker.
      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        settings = read(p);
      },
    };
  },
});
`;
}

/**
 * Adds the new effect to `src/effects/index.ts`.
 *
 * That file is the single source of truth for "which effects does this build know how to draw": the
 * renderer looks an effect up in it by id, and the app posts every descriptor in it to
 * `POST /api/effects/sync`, which is how the admin dropdown learns a new effect exists. Registering
 * by hand is one line in three places and forgetting one of them produces an effect that compiles,
 * lints, builds and never appears anywhere — so the generator does it.
 *
 * The edits are made with anchored string surgery rather than by parsing TypeScript, because a
 * parser would be a dependency and this file has none. Every anchor is checked, and a missing one
 * stops the run with an explanation instead of writing a damaged file. If someone restructures
 * `index.ts`, this is the function that needs teaching about the new shape.
 */
function registerInIndex(source, { camel, engine, id }) {
  if (source.includes(`"./${engine}/${id}"`)) {
    throw new Error(`src/effects/index.ts already imports "./${engine}/${id}".`);
  }

  const importLine = `import ${camel} from "./${engine}/${id}";\n`;
  const imports = [...source.matchAll(/^import .+ from "\.\/(three|pixi)\/.+";$/gm)];
  const lastImport = imports.at(-1);
  if (!lastImport || lastImport.index === undefined) {
    throw new Error(
      "Could not find the block of effect imports in src/effects/index.ts. It no longer looks " +
        'like a run of `import x from "./three/y";` lines, so this generator cannot place a new ' +
        "one. Add the three lines by hand, then fix `registerInIndex` in tools/new-effect.mjs.",
    );
  }
  const afterImports = lastImport.index + lastImport[0].length + 1;
  let updated = source.slice(0, afterImports) + importLine + source.slice(afterImports);

  // The array the renderer and the inventory sync both read. The entry goes last, so the admin
  // dropdown keeps its existing order and the newest effect is at the bottom.
  const arrayEnd = updated.indexOf("\n];", updated.indexOf("export const effects: EffectModule[]"));
  if (arrayEnd === -1) {
    throw new Error(
      "Could not find the end of the `export const effects: EffectModule[] = [ ... ];` array in " +
        "src/effects/index.ts.",
    );
  }
  updated = `${updated.slice(0, arrayEnd)}\n  ${camel},${updated.slice(arrayEnd)}`;

  /*
   * The named re-export list at the bottom. Adding a name can push Prettier past 100 columns and
   * make it reprint the statement across several lines, which would fail `pnpm format:check` on an
   * otherwise perfect generated file. So the width is checked here and the statement is written in
   * whichever of the two shapes Prettier would have chosen.
   */
  const exportMatch = updated.match(/export \{([\s\S]*?)\};\n?$/);
  if (!exportMatch) {
    throw new Error(
      "Could not find the trailing `export { ... };` statement in src/effects/index.ts.",
    );
  }
  const names = [
    ...exportMatch[1]
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
    camel,
  ];
  const oneLine = `export { ${names.join(", ")} };\n`;
  const rewritten =
    oneLine.length - 1 <= 100
      ? oneLine
      : `export {\n${names.map((name) => `  ${name},\n`).join("")}};\n`;

  return updated.slice(0, exportMatch.index) + rewritten;
}

async function main() {
  const [id, name, engine] = process.argv.slice(2);

  if (!id || !name || !engine) usage("Three arguments are required.");
  if (!EFFECT_ID.test(id)) {
    usage(
      `"${id}" is not a valid effect id. It must match ${EFFECT_ID.source} — lowercase letters, ` +
        "digits and hyphens, starting with a letter or digit, at most 64 characters.",
    );
  }
  if (!ENGINES.includes(engine)) usage(`"${engine}" is not an engine. Use three or pixi.`);
  if (name.trim().length === 0) usage("The human name cannot be blank.");

  const target = resolve(EFFECTS_DIR, engine, `${id}.ts`);
  if (await exists(target)) {
    console.error(`${relative(FRONTEND_ROOT, target)} already exists. Nothing was written.`);
    process.exit(1);
  }
  // The other engine's directory is checked too: two effects may not share an id, whichever
  // library they are built with, because the id is what a route stores.
  const otherEngine = ENGINES.find((candidate) => candidate !== engine);
  if (await exists(resolve(EFFECTS_DIR, otherEngine, `${id}.ts`))) {
    console.error(
      `An effect with the id "${id}" already exists under src/effects/${otherEngine}/. ` +
        "Effect ids are unique across both engines, because a route stores the id alone.",
    );
    process.exit(1);
  }

  const camel = camelCase(id);
  const template = engine === "three" ? threeTemplate : pixiTemplate;
  const file = template({ id, name });

  /*
   * Order matters. The effect file is written first and the registration second, because the two
   * possible half-finished states are not equally bad: an unregistered file is inert and harmless,
   * while a registration pointing at a file that does not exist stops the whole application from
   * compiling.
   */
  await writeFile(target, file, "utf8");

  const indexSource = await readFile(INDEX_FILE, "utf8");
  await writeFile(INDEX_FILE, registerInIndex(indexSource, { camel, engine, id }), "utf8");

  console.log(
    [
      `Created  ${relative(FRONTEND_ROOT, target)}`,
      `Updated  ${relative(FRONTEND_ROOT, INDEX_FILE)}  (import, effects[], re-export)`,
      "",
      "It already runs. To see it:",
      "  make up                                  # if the stack is not already running",
      `  open the admin, point a route at "${name}"`,
      "",
      "Before committing:",
      "  make ci-frontend                         # typecheck, lint, format check, build",
      "  pnpm verify                              # the browser harness: does it paint, does it",
      "                                           # dispose cleanly, does it hold its frame budget",
    ].join("\n"),
  );
}

main().catch((error) => {
  console.error(String(error?.stack ?? error));
  process.exit(1);
});
