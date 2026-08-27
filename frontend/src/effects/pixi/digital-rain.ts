import * as PIXI from "pixi.js";
import { createPixiStage, defineEffect, onFrame } from "../sdk";
import { colorHex, int, num } from "../paramUtils";

/**
 * Digital Rain
 * ============
 *
 * The falling-glyph curtain made famous by The Matrix: columns of characters stream down the
 * screen, the leading character bright, the ones behind it fading away.
 *
 * The performance problem, and the fix
 * ------------------------------------
 * Naively you would create a new `Text` object for every glyph that appears and destroy it when it
 * scrolls off. That is thousands of object allocations and, worse, thousands of *texture uploads*
 * per second — Pixi renders text by drawing it into a small texture on the CPU first, which is by
 * far the most expensive thing in this file.
 *
 * So we recycle instead. Each column owns a fixed pool of `Text` objects, one per visible row. When
 * the column scrolls, we do not create anything: we move the whole column container down, and when
 * it has fallen a full glyph height we shift the *characters* up by one slot and give the top one a
 * new random letter. The number of live `Text` objects therefore stays constant no matter how long
 * the effect runs, and a glyph's texture is only re-rendered when its character actually changes.
 *
 * Columns are rebuilt only when the layout genuinely changes (canvas size, column width, font size,
 * density). Colour, speed and head colour are applied live without touching the pool.
 *
 * What Phase 3.1 changed here
 * ---------------------------
 * The visible result is identical; what disappeared is the plumbing this file used to share with
 * every other Pixi effect:
 *
 *  - the `new PIXI.Application()` / `await app.init(...)` dance, the `if (disposed) destroy()`
 *    branch inside its `.then(...)`, and the `ready` flag that guarded `resize` and `dispose`, are
 *    all now `await createPixiStage(scope, ctx)`;
 *  - the `disposed` flag and the whole `dispose()` method are gone. Everything this effect creates
 *    is owned by its `Scope`, which tears it down in reverse construction order, exactly once;
 *  - the animation ran on Pixi's own ticker, which ignored the route's frame-rate cap. It now runs
 *    on the SDK's single shared clock via `onFrame`, which honours the cap. Nothing draws unless
 *    `stage.render()` is called, because that shared clock — not Pixi's ticker — is the one loop in
 *    this project.
 *
 * The motion itself needed no conversion: it was already expressed in pixels per *second* and
 * multiplied by a delta time, so feeding it the shared clock's `dt` keeps the speed it has today.
 */

/** The character set. Half-width katakana plus digits gives the classic look without a font file. */
const GLYPHS = "0123456789ABCDEFGHJKLMNPRSTUVWXYZｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ";

function randomGlyph(): string {
  // `Math.random()` returns a value in [0, 1) — it never reaches 1 — so `index` is always a valid
  // position in the string. TypeScript's `noUncheckedIndexedAccess` option cannot prove that, and
  // types the read as "a string or undefined"; the `?? "0"` is what satisfies it, and picks a
  // character that is already in the set so an impossible miss would still look right on screen.
  const index = Math.floor(Math.random() * GLYPHS.length);
  return GLYPHS[index] ?? "0";
}

/** One vertical stream of characters. */
interface Column {
  container: PIXI.Container;
  /** The recycled Text objects, index 0 at the top of the column. */
  cells: PIXI.Text[];
  /** How far the column has scrolled past its current slot, in pixels (0..fontSize). */
  offset: number;
  /** Pixels per second for this particular column, so columns do not fall in lock step. */
  speed: number;
  /** Vertical start position, letting columns be staggered instead of all starting at the top. */
  top: number;
}

export default defineEffect({
  descriptor: {
    id: "digital-rain",
    name: "Digital Rain",
    description:
      "Matrix-style columns of falling glyphs with a bright leading character and a fading tail, using recycled text objects for steady performance.",
    engine: "pixi",
    category: "background",
    tags: ["matrix", "text", "background", "retro", "pixi"],
    previewNotes:
      "Transparent background, so it layers over anything. Lower Density to leave gaps between columns for a lighter overlay.",
    params: [
      {
        key: "columnWidth",
        label: "Column Width",
        kind: "number",
        default: 20,
        min: 6,
        max: 120,
        step: 1,
        description: "Horizontal spacing in pixels between neighbouring columns.",
      },
      {
        key: "fallSpeed",
        label: "Fall Speed",
        kind: "number",
        default: 140,
        min: 10,
        max: 900,
        step: 10,
        description: "Average downward speed in pixels per second. Each column varies around this.",
      },
      {
        key: "glyphColor",
        label: "Glyph Color",
        kind: "color",
        default: "#22cc55",
        description: "Colour of the trailing characters.",
      },
      {
        key: "headColor",
        label: "Head Color",
        kind: "color",
        default: "#ccffdd",
        description: "Colour of the bright character at the front of each stream.",
      },
      {
        key: "density",
        label: "Density",
        kind: "number",
        default: 0.7,
        min: 0.05,
        max: 1,
        step: 0.05,
        description:
          "Fraction of the available column slots that actually contain a stream. 1 fills every slot.",
      },
      {
        key: "fontSize",
        label: "Font Size",
        kind: "number",
        default: 18,
        min: 6,
        max: 96,
        step: 1,
        description: "Character height in pixels. Also sets the vertical spacing inside a column.",
      },
      /*
       * None of the six parameters above declares `rebuild: true`, and the three that decide the
       * grid — Column Width, Density and Font Size — deliberately do not.
       *
       * `rebuild: true` asks the renderer to throw the whole effect away and mount it again, which
       * on air is a black frame and a fresh WebGL context. This effect already rebuilds its glyph
       * pools in place, in `buildColumns()`, keeping the canvas and the Pixi application alive; a
       * remount would cost more and look worse for exactly the same picture. The flag is for the
       * parameters that genuinely *cannot* change in place — a buffer whose size is baked into a
       * GPU pipeline — and none of these are.
       */
    ],
  },

  async setup({ ctx, scope }) {
    // Read once here, re-read in `setParams` below. Every value read at setup time must be re-read
    // there, or the slider that changes it silently does nothing.
    let columnWidth = num(ctx.params, "columnWidth", 20, 6, 120);
    let fallSpeed = num(ctx.params, "fallSpeed", 140, 10, 900);
    let glyphColor = colorHex(ctx.params, "glyphColor", "#22cc55");
    let headColor = colorHex(ctx.params, "headColor", "#ccffdd");
    let density = num(ctx.params, "density", 0.7, 0.05, 1);
    let fontSize = int(ctx.params, "fontSize", 18, 6, 96);

    // Creates the Pixi application, waits for it, attaches its canvas to the effect's host element
    // and registers every piece of teardown on `scope`. If the effect was disposed while this was
    // in flight it throws `Cancelled`, which `defineEffect` swallows after the scope has torn down
    // whatever had been created — which is why this file has no `disposed` flag and no `dispose`.
    const stage = await createPixiStage(scope, ctx);

    const layer = stage.stage.addChild(new PIXI.Container());
    let columns: Column[] = [];

    /** Frees every Text object in the current columns. Called before any rebuild and on dispose. */
    const clearColumns = (): void => {
      for (const column of columns) {
        layer.removeChild(column.container);
        // `true` destroys the little text texture too — that is the memory that actually matters.
        column.container.destroy({ children: true, texture: true, textureSource: true });
      }
      columns = [];
    };

    /*
     * Registered *after* `createPixiStage` registered its `app.destroy(...)`, so teardown — which
     * runs in reverse registration order — frees the glyph textures first and destroys the
     * application second. That is the same order the hand-written `dispose()` used to encode.
     */
    scope.defer(clearColumns);

    /** Builds the whole grid of columns and their recycled Text pools for the current layout. */
    const buildColumns = (): void => {
      clearColumns();
      const width = stage.width;
      const height = stage.height;
      const slots = Math.max(1, Math.ceil(width / columnWidth));
      // One extra row so a column can scroll a full glyph height before recycling without a gap.
      const rows = Math.max(2, Math.ceil(height / fontSize) + 2);

      const style = new PIXI.TextStyle({
        fontFamily: "monospace",
        fontSize,
        fill: glyphColor,
      });

      for (let s = 0; s < slots; s += 1) {
        if (Math.random() > density) continue; // this slot stays empty

        const container = new PIXI.Container();
        container.x = s * columnWidth;
        const cells: PIXI.Text[] = [];

        for (let r = 0; r < rows; r += 1) {
          // Every Text gets its own cloned style so per-cell colour changes cannot leak sideways.
          const text = new PIXI.Text({ text: randomGlyph(), style: style.clone() });
          text.y = r * fontSize;
          // Rows further from the head are dimmer; row 0 is the top (oldest), the last row is the
          // bright head, which is why the alpha ramp runs from faint at the top to full at the end.
          text.alpha = (r + 1) / rows;
          cells.push(text);
          container.addChild(text);
        }

        // Start each column at a random height so they do not all begin at the top together.
        const top = -Math.random() * height;
        container.y = top;
        layer.addChild(container);
        columns.push({
          container,
          cells,
          offset: 0,
          speed: 0.6 + Math.random() * 0.8, // relative multiplier, scaled by fallSpeed each frame
          top,
        });
      }
      style.destroy();
      applyColors();
    };

    /** Re-tints the pools. Cheap: changing `fill` only re-renders the glyph, not the layout. */
    function applyColors(): void {
      for (const column of columns) {
        const last = column.cells.length - 1;
        column.cells.forEach((cell, index) => {
          cell.style.fill = index === last ? headColor : glyphColor;
        });
      }
    }

    // The number of slots and rows is derived from the canvas size, so a real size change means the
    // pools have to be laid out again. The stage has already resized the Pixi renderer by the time
    // this runs, and it does not run at all when the size is unchanged.
    stage.onResize(() => buildColumns());

    buildColumns();

    /*
     * The shared clock replaces `app.ticker.add(update)`. `dt` is seconds since this effect's
     * previous frame, already clamped to 0.1 s by the clock — the same clamp this file used to
     * apply to `ticker.deltaMS` by hand — so the arithmetic below is untouched and the fall speed
     * is the same as before at any refresh rate. What is new is that `ctx.fpsCap` is now obeyed.
     */
    onFrame(scope, ctx.fpsCap, ({ dt }) => {
      const height = stage.height;

      for (const column of columns) {
        const step = fallSpeed * column.speed * dt;
        column.container.y += step;
        column.offset += step;

        // Once the column has travelled one whole glyph height, snap it back up by that height and
        // shift the characters instead. Visually identical, but nothing is ever created here.
        while (column.offset >= fontSize) {
          column.offset -= fontSize;
          column.container.y -= fontSize;
          // Shift every character one slot up the column. Reading the two cells into local
          // variables first is what lets the compiler see they exist: `cells[i]` on its own is
          // typed "a Text or undefined" under `noUncheckedIndexedAccess`.
          const cells = column.cells;
          for (let i = 0; i < cells.length - 1; i += 1) {
            const current = cells[i];
            const below = cells[i + 1];
            if (current && below) current.text = below.text;
          }
          const head = cells[cells.length - 1];
          if (head) head.text = randomGlyph();
        }

        // When the column has fallen entirely past the bottom, send it back above the top edge.
        if (column.container.y > height) {
          column.container.y = column.top - height;
        }
      }

      // Pixi's own ticker is switched off by `createPixiStage`, so this is the only thing that puts
      // pixels on the canvas.
      stage.render();
    });

    return {
      setParams(p: Record<string, unknown>): void {
        fallSpeed = num(p, "fallSpeed", 140, 10, 900);

        const nextGlyph = colorHex(p, "glyphColor", "#22cc55");
        const nextHead = colorHex(p, "headColor", "#ccffdd");
        const colorsChanged = nextGlyph !== glyphColor || nextHead !== headColor;
        glyphColor = nextGlyph;
        headColor = nextHead;

        const nextWidth = num(p, "columnWidth", 20, 6, 120);
        const nextDensity = num(p, "density", 0.7, 0.05, 1);
        const nextFont = int(p, "fontSize", 18, 6, 96);
        const layoutChanged =
          nextWidth !== columnWidth || nextDensity !== density || nextFont !== fontSize;
        columnWidth = nextWidth;
        density = nextDensity;
        fontSize = nextFont;

        // Layout parameters decide how many objects exist, so only they force a rebuild; colour and
        // speed are applied to the pools that are already on screen.
        if (layoutChanged) buildColumns();
        else if (colorsChanged) applyColors();
      },
    };
  },
});
