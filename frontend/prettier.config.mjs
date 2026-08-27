/**
 * Prettier configuration for the frontend.
 *
 * Prettier is a *formatter*: it throws away how the source is laid out and prints it again from
 * scratch using these settings. Nobody argues about where a line break goes, because nobody
 * decides — the tool does. ESLint is deliberately kept out of formatting entirely; see the note
 * about `eslint-config-prettier` in `eslint.config.mjs`.
 *
 * Run it with `pnpm format` (rewrite the files) or `pnpm format:check` (report and fail, which is
 * what continuous integration should run).
 *
 * ## Why these particular values
 *
 * They are not Prettier's defaults picked at random — they are what the code in `src/` was already
 * written in, and they match the repository's `.editorconfig` (2-space indent, 100-column lines,
 * LF endings). Choosing anything else would have made the very first `pnpm format` rewrite every
 * file in the project, which buries the next few months of real changes under formatting noise in
 * every diff and `git blame`.
 */

/** @type {import("prettier").Config} */
export default {
  // 100 columns, the same limit `.editorconfig` sets for everything except Scala. Wide enough for
  // a JSX line with two props, narrow enough to read two files side by side.
  printWidth: 100,

  // Two spaces per indentation level, never a tab character.
  tabWidth: 2,
  useTabs: false,

  // Semicolons at the end of statements. TypeScript does not require them, but leaving them out
  // relies on "automatic semicolon insertion", whose few surprising cases are not worth the
  // characters saved.
  semi: true,

  // Double quotes for strings, matching the imports throughout `src/`.
  singleQuote: false,
  jsxSingleQuote: false,

  // A trailing comma after the last item of a multi-line list. Adding the next item then touches
  // one line instead of two, so the diff shows only what actually changed.
  trailingComma: "all",

  // `(x) => x`, not `x => x`. One shape for every arrow function, whatever its parameter count.
  arrowParens: "always",

  // Spaces inside object braces: `{ a: 1 }`.
  bracketSpacing: true,

  // Line feeds only. Windows-style CRLF endings in a repository read as a whole-file change to
  // everyone else; `.editorconfig` says `lf` for the same reason.
  endOfLine: "lf",
};
