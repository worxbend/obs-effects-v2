/**
 * Waiting for a font before drawing with it.
 *
 * ## The failure this exists to prevent
 *
 * A web font is loaded lazily: the browser fetches it the first time something actually needs it,
 * and until it arrives, `ctx.fillText` and `ctx.measureText` quietly use a fallback. Neither
 * throws, neither warns. So an effect that lays out a grid from measured glyph widths, or draws
 * icons from a symbol font, produces a *plausible but wrong* first second — a grid at the wrong
 * pitch, or a row of "missing character" boxes — and then silently re-flows when the real font
 * lands.
 *
 * On a web page that flicker is a blemish. On a live broadcast it is the first thing a viewer sees
 * when a scene comes up.
 *
 * `font-display: block` in `styles/fonts.css` stops the browser *painting* a substituted font, but
 * it does nothing about an effect *measuring* one. This is the other half.
 *
 * ## Why it never rejects
 *
 * The same rule the rest of the SDK follows: a missing font must degrade, not fail. If the file is
 * unreachable — an OBS machine with no network, a typo in a family name — this resolves anyway and
 * the effect draws in whatever the browser substitutes. A blank overlay is the one outcome worth
 * avoiding, and it is the only one this cannot produce.
 */

/**
 * How long to wait before giving up and drawing with whatever is available.
 *
 * Two seconds is far longer than a local file needs — these are served from the same origin as the
 * page — and short enough that a scene switch is not left blank while a font that will never arrive
 * is waited for.
 */
const FONT_TIMEOUT_MS = 2000;

/**
 * Waits until `font` can be drawn with, or until the timeout, whichever comes first.
 *
 * ```ts
 * await useFont(scope, "16px SymbolsNF");
 * scope.checkpoint();
 * ```
 *
 * `font` is a CSS `font` shorthand, exactly as `ctx.font` and `document.fonts.load` want it: a size
 * and a family, e.g. `"16px SymbolsNF"` or `"bold 48px Silkscreen"`. A size is **required** — the
 * font loading API rejects a bare family name, which is an easy hour to lose.
 *
 * **It does not checkpoint for you**, in line with `useAudio` and `useVideo`: it can resolve after
 * the effect it was loading for has been disposed. Put `scope.checkpoint()` on the next line.
 *
 * @returns `true` if the font is genuinely ready, `false` if the wait timed out or the family is
 *   unknown. Effects can ignore the result — it is there for the rare case where you want to draw
 *   something different rather than draw the same thing in the wrong typeface.
 */
export async function useFont(font: string): Promise<boolean> {
  // `document.fonts` is absent in some embedded contexts. Nothing to wait for, so say so and let
  // the caller draw.
  if (typeof document === "undefined" || !document.fonts) return false;

  try {
    const loaded = await Promise.race([
      document.fonts.load(font).then((faces) => faces.length > 0),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), FONT_TIMEOUT_MS)),
    ]);
    return loaded;
  } catch {
    // An unknown family, or a malformed shorthand. Either way there is nothing to wait for.
    return false;
  }
}

/**
 * Waits for several fonts at once, returning when all of them have settled.
 *
 * Concurrent rather than sequential: three fonts that each take 200 ms cost 200 ms, not 600. Like
 * {@link useFont} it never rejects and never blocks longer than the timeout.
 */
export async function useFonts(fonts: readonly string[]): Promise<void> {
  await Promise.all(fonts.map((font) => useFont(font)));
}
