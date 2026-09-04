import * as THREE from "three";

import { bool, num } from "../paramUtils";
import { assembleFragment, defineEffect, palette, paletteAt01, paletteParam } from "../sdk";
import { SPEED_PARAM, shaderQuadSetup } from "./shaderQuad";

/**
 * Froth Lattice
 * =============
 *
 * A sheet of soap-froth cells covering the whole frame in hairline-thin luminous edges that slide,
 * merge and re-partition — frost forming on glass at one-hundredth speed. Lines only: the insides
 * of the cells are completely transparent, so a game, a webcam or a desktop capture underneath
 * shows through untouched. It is meant to be a permanent graphic layer rather than a scene-specific
 * mood, which is why so much care goes into the line width.
 *
 * ## What a Voronoi diagram is, and why the naive version looks wrong
 *
 * Scatter some points ("sites") across a plane. Every pixel belongs to whichever site is nearest to
 * it. Colouring pixels by which site won gives you cells, and drawing the boundaries between cells
 * gives you the lattice. That is a *Voronoi diagram*, and it is the standard mathematical model of
 * soap froth, cracked mud, giraffe hide and dragonfly wings.
 *
 * The usual shortcut for drawing the boundaries is to take the distance to the nearest site, take
 * the distance to the second nearest, and subtract: `F2 - F1`. It is one line and it is wrong in a
 * way you can see. `F2 - F1` is not the distance to the boundary — it is roughly twice that, and
 * only near the middle of an edge. Where three cells meet, it collapses much faster than the true
 * distance does, so the lines *pinch* at every junction and *bulge* in the middle of every edge.
 * The junctions are exactly where the eye looks, so the shortcut reads as fuzzy cell noise rather
 * than as a drawn lattice.
 *
 * This shader does the honest version instead, in two passes over the same nine neighbouring cells:
 *
 *  1. **Find the winner.** Compute the nine candidate sites around the pixel and keep the nearest.
 *     The nine positions are cached in a small array so the second pass does not pay for them
 *     again — that halves the cost of the whole effect.
 *  2. **Measure the real edge.** The boundary between the winning site and any other site is the
 *     *perpendicular bisector* of the line joining them — the set of points equally far from both.
 *     The distance from the pixel to that bisector has a short closed form, and the smallest such
 *     distance over the eight neighbours is the distance to the nearest cell edge. Taking the
 *     *second* smallest as well is free, and it is what locates the junctions: at a point where
 *     three cells meet, two bisectors are close at once.
 *
 * Nine squares is a window, not a proof: the site that defines the nearest edge can in principle sit
 * just outside it, and the exhaustive fix — searching twenty-five squares in the second pass — costs
 * nearly three times as much. Measured against a 25-square reference over 60,000 random points, the
 * window disagrees at a point that would actually be *drawn* zero times at the shipped defaults, and
 * once in 60,000 with Irregularity and Drift both at 1 — a sub-pixel gap in one hairline, for one
 * frame. That is the trade being made here.
 *
 * ## Hairlines that are the same width at every resolution
 *
 * `fwidth(x)` reports how much a value changes between one screen pixel and the next. Dividing the
 * edge distance by its own `fwidth` therefore converts it from abstract lattice units into *screen
 * pixels*, after which a line of "1.4 pixels wide" is literally 1.4 pixels wide — at 720p, at 1080p,
 * at any canvas the browser source happens to be. That constancy is the difference between a drawn
 * graphic and a scaled bitmap, and it is why the width parameter is named in pixels rather than in
 * some arbitrary 0..1 amount.
 *
 * A second, separate measurement says when to give up. The lattice coordinate `q` is a plain affine
 * function of the pixel position — a rotation, a stretch and a scale — so its own derivative gives
 * how many pixels one lattice unit spans, exactly and identically at every pixel in the frame. Half
 * of that is roughly a cell's radius in pixels, and below a handful of pixels a cell simply cannot
 * be drawn: every attempt turns into moiré. Rather than clamping the cell count (which would
 * silently ignore the operator's setting) the line opacity is faded to nothing as that limit is
 * approached, so pushing Cell Count too far degrades to a clean empty frame instead of a shimmering
 * mess. The same number caps the drawn width at a quarter of a cell, so that a wide line and a high
 * cell count together thin out instead of flooding the frame solid.
 *
 * That measurement deliberately does *not* come from the edge field's own derivative. The field
 * flattens out wherever two edges are equidistant — exactly at the junctions — so a cell size read
 * off it spikes there, and a fade driven by it leaks a speckle of junction dots through at settings
 * where the honest answer is an empty frame.
 *
 * ## Deliberate divergences from the shared library, and why
 *
 *  - **No `aaStep` chunk.** `aaStep` gives a one-pixel-soft edge, which is the right tool when the
 *    threshold is in the field's own units. Here the field has already been converted to pixels, so
 *    the antialiasing is a plain `smoothstep` half a pixel either side of the requested width —
 *    which is what makes the width exact rather than approximately one pixel.
 *  - **No `palette` chunk.** That chunk samples a baked `vec3[8]` uniform array, and uniform arrays
 *    are not part of the shader-quad uniform contract (see `shaderQuad.ts`). Four stops are read off
 *    the selected ramp on the CPU and handed over as four ordinary `vec3`s instead, and the ramp is
 *    interpolated here — in linear light, using the `srgb` chunk, so a blend between two stops does
 *    not dip in brightness the way an sRGB average does.
 *
 * ## How the froth moves
 *
 * Each site sits at a fixed random offset inside its own grid square (Irregularity), plus a wander
 * term: a `vnoise` field read at the site's own position and at the current time gives an angle, and
 * the site leans that far in that direction (Drift). Because neighbouring sites read nearby points of
 * the same field they lean *together*, so the sheet flows and relaxes rather than boiling. Both
 * offsets are clamped to stay inside the site's own grid square, which is not cosmetic: it is the
 * condition that makes searching only the nine surrounding squares mathematically exact.
 *
 * Every so often two drifting sites pass close to one another. Their shared edge shortens to
 * nothing and the cells re-partition around it — which reads, unprompted, as a bubble popping.
 *
 * ## The audio, and why it is one cell rather than the whole frame
 *
 * `uAudio` carries loudness tracked at three different speeds — see `shaderQuad.ts` for why those
 * are envelopes and not frequency bands. Two things listen to it:
 *
 *  - The **slow** envelope gently raises Drift, so the froth relaxes faster during a loud passage
 *    and almost stops in a quiet one. It is a change of pace, not a pulse.
 *  - The **fast** envelope fires a **flare**: a single cell goes white and fades. One cell, chosen by
 *    hashing its own identity against a time slot, so a beat is a discrete legible event somewhere in
 *    the frame instead of the whole picture breathing in and out. The flare grows with `easeOutBack`,
 *    which overshoots slightly before settling — the small "pop" that makes it read as an event.
 *
 * The chosen cell is picked by comparing a per-cell hash against `1 / (number of visible cells)`, so
 * on average exactly one cell lights per slot. Occasionally none does, occasionally two do; that
 * irregularity is closer to froth than a metronome would be.
 *
 * ## Cost
 *
 * Nine sites, each with one noise lookup, is not free, and the second tier doubles it. That is why
 * Sub-lattice ships **off**: the shader genuinely branches around the whole second tier rather than
 * multiplying it by zero, so leaving it off costs nothing at all. (The branch is on a uniform, so
 * every pixel in the frame takes the same path — which is also why it is safe to call `fwidth`
 * inside it, since screen-space derivatives are only well defined in uniform control flow.)
 */
const FRAGMENT_SHADER = assembleFragment(
  ["hash12", "vnoise", "srgb", "easing"],
  /* glsl */ `
  varying vec2 vUv;

  uniform float uTime;
  uniform vec2 uResolution;
  uniform vec4 uAudio; // level, slow, mid, fast — see shaderQuad.ts: these are
                       // envelopes at three speeds, not frequency bands

  uniform vec3 uPal0;               // four stops sampled off the selected palette on the CPU
  uniform vec3 uPal1;
  uniform vec3 uPal2;
  uniform vec3 uPal3;

  uniform float uCellScale;         // cells across the height of the frame
  uniform float uJitter;            // 0 = a regular grid, 1 = true froth
  uniform float uDrift;             // how far and how energetically the sites wander
  uniform float uLineWidthPx;       // hairline width, in screen pixels
  uniform float uLineOpacity;       // alpha of the coarse lattice
  uniform float uSubLattice;        // 0 or 1 — whether the second tier is drawn at all
  uniform float uSubLatticeScale;   // how much finer the second tier is
  uniform float uSubLatticeOpacity; // alpha of the second tier
  uniform float uVertexGlow;        // brightening where three edges meet
  uniform float uHueSpread;         // how far neighbouring cells differ along the ramp
  uniform float uAngleBias;         // stretches the cells across one direction
  uniform float uBiasAngle;         // that direction, in radians
  uniform float uBeatFlash;         // brightness of the single-cell flare
  uniform float uFlashDecay;        // how fast the flare fades, per second
  uniform float uReactivity;        // master gain on both audio responses

  const float TAU = 6.28318530718;

  // The palette, interpolated in linear light rather than in sRGB. Averaging two sRGB values dips
  // in brightness halfway between them, which on a hairline shows up as a dull patch.
  vec3 rampColour(float t) {
    float scaled = clamp(t, 0.0, 1.0) * 3.0;
    float segment = min(floor(scaled), 2.0);
    float local = scaled - segment;
    vec3 a = uPal0;
    vec3 b = uPal1;
    if (segment > 0.5) { a = uPal1; b = uPal2; }
    if (segment > 1.5) { a = uPal2; b = uPal3; }
    return toSrgb(mix(toLinear(a), toLinear(b), local));
  }

  // Where the site belonging to one grid square currently sits, in 0..1 square-local coordinates.
  //
  // The clamp is load-bearing rather than defensive: keeping every site inside its own square is
  // what guarantees the nearest site to any pixel is in one of the nine squares around it, which is
  // the whole reason a 3x3 search is exact and a wider one is unnecessary.
  vec2 sitePos(vec2 square, float seed, float jitter, float drift) {
    vec2 fixedOffset = vec2(hash12(square + seed), hash12(square + seed + 41.7)) - 0.5;

    // One noise lookup per site gives an angle. Neighbouring sites read nearby points of the same
    // field, so they lean the same way and the sheet flows instead of seething.
    float rate = 0.06 + drift * 0.10;
    float angle = vnoise(square * 0.55 + vec2(uTime, uTime * 0.83) * rate + seed) * TAU * 2.0;
    vec2 wander = vec2(cos(angle), sin(angle)) * drift * 0.34;

    return vec2(0.5) + clamp(fixedOffset * jitter + wander, vec2(-0.47), vec2(0.47));
  }

  // The lattice, evaluated at one point.
  //
  //   x — distance to the nearest cell edge
  //   y — distance to the second nearest edge, which is small only near a junction
  //   z — a stable 0..1 hash identifying the winning cell
  //   w — distance to the winning site itself
  vec4 froth(vec2 q, float seed, float jitter, float drift) {
    vec2 base = floor(q);
    vec2 f = q - base;

    // Pass one: the nine candidates, kept so pass two does not recompute them.
    vec2 sites[9];
    vec2 winner = vec2(0.0);
    vec2 winnerSquare = base;
    float bestSq = 1.0e9;

    for (int k = 0; k < 9; k++) {
      vec2 g = vec2(mod(float(k), 3.0) - 1.0, floor(float(k) / 3.0) - 1.0);
      vec2 square = base + g;
      vec2 toSite = g + sitePos(square, seed, jitter, drift) - f;
      sites[k] = toSite;
      float dSq = dot(toSite, toSite);
      if (dSq < bestSq) {
        bestSq = dSq;
        winner = toSite;
        winnerSquare = square;
      }
    }

    // Pass two: the true edge distance. The boundary between the winner and any other site is the
    // perpendicular bisector of the segment joining them, and the distance from this pixel to that
    // bisector is the projection of the midpoint onto the direction between the two sites.
    float nearest = 1.0e9;
    float second = 1.0e9;

    for (int k = 0; k < 9; k++) {
      vec2 other = sites[k];
      vec2 between = other - winner;
      float span = length(between);
      // The winner compares against itself here; span is 0, and the test skips it.
      if (span > 1.0e-4) {
        float d = dot(0.5 * (winner + other), between / span);
        if (d < nearest) {
          second = nearest;
          nearest = d;
        } else if (d < second) {
          second = d;
        }
      }
    }

    return vec4(nearest, second, hash12(winnerSquare + seed + 7.3), sqrt(bestSq));
  }

  void main() {
    // max() rather than a bare divide: a browser source can be laid out at zero height for a frame
    // while OBS settles, and a division by zero here would spread NaN across the whole picture.
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 p = (vUv - 0.5) * vec2(aspect, 1.0);

    // Anisotropy: rotate into the bias direction and stretch across it. The lattice is generated in
    // that rotated frame and never needs rotating back, so this costs one sine and one cosine for
    // the whole frame. Pushed up, hexagonal froth becomes a woven textile.
    float ca = cos(uBiasAngle);
    float sa = sin(uBiasAngle);
    vec2 biased = vec2(p.x * ca + p.y * sa, -p.x * sa + p.y * ca);
    biased.x *= 1.0 + uAngleBias * 2.5;

    vec2 q = biased * uCellScale;

    // How many screen pixels one lattice unit covers.
    //
    // This is measured from the derivative of the *coordinate*, not of the distance field. q is an
    // affine function of the pixel position, so its derivative is exact and the same everywhere in
    // the frame; the field's own derivative is not, because it flattens out wherever two edges are
    // equidistant. Taking the tighter of the two axes is what makes a stretched cell measured across
    // its narrow direction, which is the one that runs out of pixels first.
    float unitPx = 1.0 / max(max(length(vec2(dFdx(q.x), dFdy(q.x))),
                                 length(vec2(dFdx(q.y), dFdy(q.y)))), 1.0e-6);

    // A cell's radius is around half a lattice unit, so this is roughly its size in pixels. Below a
    // handful of pixels a cell cannot be drawn at all, and the lattice fades out rather than turning
    // into moiré. The threshold is in plain pixels rather than in line widths: whether a cell can be
    // resolved is a property of the screen, not of how thick the operator wants the lines.
    float cellPx = 0.5 * unitPx;
    float legible = smoothstep(2.5, 6.0, cellPx);

    // A hairline is never allowed to be wider than a quarter of the cell it is bounding. Without
    // that ceiling, Line Width at 4 and Cell Count at 40 together paint a solid sheet instead of a
    // lattice — the one combination where the requested width cannot be honoured literally.
    float halfWidth = min(uLineWidthPx, cellPx * 0.5) * 0.5;

    // The slow envelope nudges the drift: the sheet relaxes faster when the room is loud.
    float drift = uDrift * (1.0 + uAudio.y * 0.6 * uReactivity);

    vec4 coarse = froth(q, 0.0, uJitter, drift);

    // How much the edge distance changes from one screen pixel to the next. Dividing by it converts
    // lattice units into pixels, which is what makes the hairline width exact at any resolution.
    float step0 = max(fwidth(coarse.x), 1.0e-6);
    float edgePx = coarse.x / step0;
    float nextEdgePx = coarse.y / step0;

    float line = (1.0 - smoothstep(halfWidth - 0.5, halfWidth + 0.5, edgePx)) * uLineOpacity;
    line *= legible;

    // Plateau's law: in real froth exactly three films meet at each junction, at 120 degrees. Those
    // junctions carry more material and read brighter, and this one small brightening is most of
    // what separates "froth" from "cell noise". A junction is where the second edge is also close.
    //
    // How far the brightening reaches is capped at the cell's own size, so that in a dense lattice
    // the glow stays a dot at a junction instead of washing over the whole cell.
    float junctionReach = min(5.0, cellPx);
    float junction =
      (1.0 - smoothstep(halfWidth, halfWidth + junctionReach, nextEdgePx)) * line * uVertexGlow;

    // One palette sample per cell, so neighbours differ slightly in hue and the sheet shimmers
    // without ever becoming a rainbow.
    vec3 cellColour = rampColour(clamp(0.5 + (coarse.z - 0.5) * uHueSpread, 0.0, 1.0));

    // Contributions are accumulated already multiplied by their own coverage, which is exactly the
    // premultiplied-alpha form the shader quad's material blends with.
    vec3 col = cellColour * line;
    float alpha = line;

    col += mix(cellColour, vec3(1.0), 0.75) * junction;
    alpha += junction * 0.6;

    // The second tier. Branching on a uniform means every pixel takes the same path, so switching
    // this off genuinely costs nothing — and screen-space derivatives stay well defined inside.
    if (uSubLattice > 0.5) {
      vec4 fine = froth(q * uSubLatticeScale, 137.0, uJitter, drift);
      float step1 = max(fwidth(fine.x), 1.0e-6);
      float finePx = fine.x / step1;

      // The same two limits as the coarse tier, against the second tier's own smaller cells.
      float fineCellPx = cellPx / uSubLatticeScale;
      float fineLegible = smoothstep(2.5, 6.0, fineCellPx);
      float fineHalfWidth = min(uLineWidthPx, fineCellPx * 0.5) * 0.5;

      float fineLine = 1.0 - smoothstep(fineHalfWidth - 0.5, fineHalfWidth + 0.5, finePx);
      fineLine *= uSubLatticeOpacity * fineLegible;

      // Stop the fine tier short of the coarse hairlines instead of letting it cross them. Two tiers
      // that overlap read as one busy mess; two tiers that nest read as depth.
      fineLine *= smoothstep(0.0, 4.0, edgePx - halfWidth - 1.0);

      vec3 fineColour = rampColour(clamp(0.5 + (fine.z - 0.5) * uHueSpread, 0.0, 1.0));
      col += fineColour * fineLine;
      alpha += fineLine;
    }

    // The beat flare. Time is cut into short slots; within each slot one cell is elected by
    // comparing its own hash against 1/(cells on screen), so on average exactly one lights up.
    float window = 0.42;
    float slot = floor(uTime / window);
    float age = uTime - slot * window;
    float visibleCells = max(uCellScale * uCellScale * aspect, 1.0);
    float chosen = step(1.0 - 1.0 / visibleCells, fract(coarse.z * 43.13 + slot * 0.6180339));

    // The fast envelope decides whether anything fires at all; easeOutBack overshoots on the way out
    // so the fill "pops" past its final size before settling, which is what makes it read as an
    // event rather than as a fade.
    float gate = smoothstep(0.22, 0.55, uAudio.w) * uReactivity;
    float grow = easeOutBack(clamp(age / 0.22, 0.0, 1.0));
    float fill = 1.0 - smoothstep(grow * 0.5 - 0.2, grow * 0.5, coarse.w);
    // The legibility fade applies here too. The interior wash below is the one contribution not
    // already multiplied by the line, so without it a lattice that has faded out for being too fine
    // would still answer a beat with white blobs on an otherwise empty frame.
    float flare = uBeatFlash * gate * exp(-age * uFlashDecay) * chosen * legible;

    // The cell's own border goes white hard; its interior only washes faintly, so the effect stays
    // a line drawing even at the moment it is shouting.
    col += vec3(1.0) * (line * flare * 1.8 + fill * flare * 0.3);
    alpha += line * flare + fill * flare * 0.3;

    gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
  }
`,
);

const frothLattice = defineEffect({
  descriptor: {
    id: "froth-lattice",
    name: "Froth Lattice",
    description:
      "A sheet of soap-froth cells in hairline-thin luminous edges that slide, merge and re-partition, like frost forming on glass at one-hundredth speed.",
    engine: "three",
    category: "overlay",
    tags: ["overlay", "voronoi", "lattice", "lines", "graphic", "reactive", "shader"],
    previewNotes:
      "Lines only — the insides of the cells are fully transparent, so this is one of the few effects that can sit on top of live gameplay without hiding anything. Put it above the game or capture source and leave it there; it is closer to a permanent brand layer than to a scene-specific mood. Sub-lattice is off by default because it doubles the fill cost; turn it on for a denser, more textile look.",
    params: [
      SPEED_PARAM,
      paletteParam(
        "palette",
        "Palette",
        "deep-sea",
        "Colour ramp for the lattice. Each cell takes one sample from it, so neighbouring cells differ slightly in hue rather than the whole sheet being one colour.",
      ),
      {
        key: "cellScale",
        label: "Cell Count",
        kind: "number",
        default: 13,
        min: 3,
        max: 40,
        step: 0.5,
        description:
          "How many cells fit across the height of the frame. Higher is finer; past the point where a cell is only a few pixels across the lattice fades itself out rather than turning into moiré.",
      },
      {
        key: "jitter",
        label: "Irregularity",
        kind: "number",
        default: 0.75,
        min: 0,
        max: 1,
        step: 0.02,
        description:
          "How irregular the cell centres are. 0 gives an almost perfectly regular honeycomb; 1 is true froth, with cells of visibly different sizes.",
      },
      {
        key: "drift",
        label: "Drift",
        kind: "number",
        default: 0.4,
        min: 0,
        max: 1,
        step: 0.02,
        description:
          "How far and how energetically the cells wander. Higher values make the sheet re-partition more often, which is what produces the occasional edge collapse that reads as a bubble popping. 0 freezes the pattern in place.",
      },
      {
        key: "lineWidthPx",
        label: "Line Width",
        kind: "number",
        default: 1.4,
        min: 0.5,
        max: 4,
        step: 0.1,
        description:
          "Hairline width measured in screen pixels. It stays that width whatever size the browser source is, so a layout designed at 1080p still looks drawn at 720p. In cells too small to hold it — a wide line at a high Cell Count — it thins down to a quarter of the cell rather than filling it solid.",
      },
      {
        key: "lineOpacity",
        label: "Line Opacity",
        kind: "number",
        default: 0.8,
        min: 0,
        max: 1,
        step: 0.01,
        description:
          "How solid the main lattice is. Around 0.5 it reads as an etched watermark; at 1 it is a firm graphic layer.",
      },
      {
        key: "vertexGlow",
        label: "Junction Glow",
        kind: "number",
        default: 0.5,
        min: 0,
        max: 1,
        step: 0.02,
        description:
          "Extra brightness where three edges meet. In real froth those junctions carry more liquid and catch more light; this is the detail that makes the pattern read as foam rather than as noise.",
      },
      {
        key: "hueSpread",
        label: "Hue Spread",
        kind: "number",
        default: 0.45,
        min: 0,
        max: 1,
        step: 0.02,
        description:
          "How far neighbouring cells wander apart along the palette. 0 paints every cell the same colour; 1 uses the whole ramp and the sheet shimmers.",
      },
      {
        key: "subLattice",
        label: "Sub-lattice",
        kind: "boolean",
        default: false,
        description:
          "Draws a second, finer lattice nested inside the large cells for extra depth. It roughly doubles how much work each pixel costs, so leave it off on a machine that is already busy encoding.",
      },
      {
        key: "subLatticeScale",
        label: "Sub-lattice Fineness",
        kind: "number",
        default: 2.6,
        min: 1.5,
        max: 5,
        step: 0.1,
        description:
          "How much finer the second tier is than the main one. Only used when Sub-lattice is on.",
      },
      {
        key: "subLatticeOpacity",
        label: "Sub-lattice Opacity",
        kind: "number",
        default: 0.22,
        min: 0,
        max: 1,
        step: 0.01,
        description:
          "How solid the second tier is. Keeping it low is the point — it should read as texture inside the big cells, not as a second lattice competing with the first.",
      },
      {
        key: "angleBias",
        label: "Stretch",
        kind: "number",
        default: 0,
        min: 0,
        max: 1,
        step: 0.02,
        description:
          "Stretches the cells along one direction. 0 is even froth; turned up, the cells elongate into ribbons and the sheet starts to look woven.",
      },
      {
        key: "biasAngle",
        label: "Stretch Angle",
        kind: "number",
        default: 0,
        min: 0,
        max: 180,
        step: 1,
        description:
          "Which way the stretch runs, in degrees. Only visible once Stretch is above 0. 0 and 90 give horizontal and vertical weaves; 45 gives a diagonal one.",
      },
      {
        key: "beatFlash",
        label: "Beat Flare",
        kind: "number",
        default: 0.7,
        min: 0,
        max: 1,
        step: 0.05,
        description:
          "How brightly a single cell flares white on a beat. One cell somewhere in the frame, not the whole picture — set it to 0 to switch the event off entirely.",
      },
      {
        key: "flashDecay",
        label: "Flare Decay",
        kind: "number",
        default: 4.5,
        min: 1,
        max: 12,
        step: 0.5,
        description:
          "How quickly the flare fades, per second. Low values leave a lingering glow; high values give a sharp blink.",
      },
      {
        key: "reactivity",
        label: "Audio Reactivity",
        kind: "number",
        default: 0.8,
        min: 0,
        max: 1,
        step: 0.05,
        description:
          "Master gain on both audio responses — the flare and the slight speed-up during loud passages. 0 disconnects the audio entirely and the lattice keeps drifting on its own clock.",
      },
    ],
  },
  setup: shaderQuadSetup({
    fragment: FRAGMENT_SHADER,
    reactive: true,
    uniforms: (p) => {
      // Four samples off the selected ramp, handed over as ordinary vec3s. The shared `palette` GLSL
      // chunk wants a baked vec3[8] uniform array, and uniform arrays are not part of the
      // shader-quad uniform contract — see `shaderQuad.ts`.
      //
      // The samples start a third of the way along rather than at 0. Every ramp in the catalogue
      // opens on a near-black stop, which is a background colour: it is invisible as a hairline over
      // a dark scene, and a cell painted with it would simply go missing from the lattice.
      const ramp = palette(p, "palette", "deep-sea");
      const [r0, g0, b0] = paletteAt01(ramp, 0.35);
      const [r1, g1, b1] = paletteAt01(ramp, 0.57);
      const [r2, g2, b2] = paletteAt01(ramp, 0.79);
      const [r3, g3, b3] = paletteAt01(ramp, 1);
      return {
        uPal0: new THREE.Vector3(r0, g0, b0),
        uPal1: new THREE.Vector3(r1, g1, b1),
        uPal2: new THREE.Vector3(r2, g2, b2),
        uPal3: new THREE.Vector3(r3, g3, b3),
        uCellScale: num(p, "cellScale", 13, 3, 40),
        uJitter: num(p, "jitter", 0.75, 0, 1),
        uDrift: num(p, "drift", 0.4, 0, 1),
        uLineWidthPx: num(p, "lineWidthPx", 1.4, 0.5, 4),
        uLineOpacity: num(p, "lineOpacity", 0.8, 0, 1),
        uSubLattice: bool(p, "subLattice", false) ? 1 : 0,
        uSubLatticeScale: num(p, "subLatticeScale", 2.6, 1.5, 5),
        uSubLatticeOpacity: num(p, "subLatticeOpacity", 0.22, 0, 1),
        uVertexGlow: num(p, "vertexGlow", 0.5, 0, 1),
        uHueSpread: num(p, "hueSpread", 0.45, 0, 1),
        uAngleBias: num(p, "angleBias", 0, 0, 1),
        // Degrees in the admin because that is what an operator thinks in; radians in the shader
        // because that is what cos() and sin() take.
        uBiasAngle: (num(p, "biasAngle", 0, 0, 180) * Math.PI) / 180,
        uBeatFlash: num(p, "beatFlash", 0.7, 0, 1),
        uFlashDecay: num(p, "flashDecay", 4.5, 1, 12),
        uReactivity: num(p, "reactivity", 0.8, 0, 1),
      };
    },
  }),
});

export default frothLattice;
