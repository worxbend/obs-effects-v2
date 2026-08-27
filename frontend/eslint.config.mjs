/**
 * ESLint configuration for the frontend.
 *
 * ESLint is a *linter*: a program that reads the source without running it and reports patterns
 * that are legal TypeScript but are still very likely to be a mistake — an unused import, an
 * ignored promise, a Solid signal read in a place where it will never update again.
 *
 * ## Why this file is `.mjs` and not `.json`
 *
 * Since ESLint 9 the only supported configuration format is "flat config": a JavaScript file that
 * exports an **array of configuration objects**. Each object may narrow itself to certain files
 * with `files`, and later objects override earlier ones. There is no `extends` inheritance chain
 * to reason about any more — the array is read top to bottom, and the last thing that mentions a
 * rule wins. That last sentence is the single most important thing to know when editing this file.
 *
 * The `.mjs` extension asks Node to read the file as an ES module (`import` / `export default`)
 * regardless of what `package.json` says, so this file keeps working even if someone later removes
 * `"type": "module"` from `package.json`.
 *
 * ## What is switched on, and why
 *
 * 1. `@eslint/js` recommended — the language-level rules that apply to any JavaScript.
 * 2. `typescript-eslint` **type-checked** recommended — rules that need to know the *types*, not
 *    only the syntax. These are the ones worth having: they can see that a `Promise` is being
 *    dropped on the floor, or that a value interpolated into a template string is an object and
 *    will print as "[object Object]". They cost a slower lint run, because ESLint has to build the
 *    same type information `tsc` builds. On a project this size that is a couple of seconds.
 * 3. `eslint-plugin-solid`, `v2` preset — SolidJS-specific rules, told that this project is on
 *    Solid 2. See the note further down for what that changes.
 * 4. `eslint-config-prettier` — **last**, always. It does not add rules; it switches *off* every
 *    rule that has an opinion about whitespace, quotes, semicolons or line breaks, because those
 *    decisions belong to Prettier (see `prettier.config.mjs`). Being last is what makes it work:
 *    if anything came after it, that thing could switch a formatting rule back on and ESLint and
 *    Prettier would then disagree forever, each undoing the other's fix.
 *
 * Run it with `pnpm lint` (report) or `pnpm lint:fix` (report and auto-fix what is fixable).
 */

import js from "@eslint/js";
import prettier from "eslint-config-prettier/flat";
import solid from "eslint-plugin-solid/configs/v2";
import tseslint from "typescript-eslint";

/*
 * `tseslint.config(...)` is a helper that returns the plain array ESLint wants. It exists so that
 * `extends: [...]` can be written inside a config object — flat config has no `extends` of its own,
 * and the helper expands it into separate array entries that all inherit this object's `files`
 * filter. Without it, every preset below would have to repeat that filter by hand.
 */
export default tseslint.config(
  {
    /*
     * Paths ESLint must never look at.
     *
     * A bare `ignores` object (one with no `files` key) applies globally. `node_modules` is
     * ignored by ESLint out of the box, but naming it here means `pnpm lint` behaves the same way
     * if someone later adds an `ignores` entry of their own and accidentally replaces the default.
     */
    ignores: ["dist/**", "node_modules/**", ".pnpm-store/**"],
  },

  {
    // Everything in this object applies to the application source only.
    files: ["**/*.{ts,tsx}"],

    extends: [
      js.configs.recommended,
      // The "TypeChecked" variants are the type-aware ones; `tseslint.configs.recommended` (no
      // suffix) is the syntax-only version and would miss the promise and template-string checks
      // that catch real bugs in this codebase.
      tseslint.configs.recommendedTypeChecked,
      solid,
      prettier,
    ],

    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: {
        /*
         * How the type-aware rules get their type information.
         *
         * `projectService: true` asks typescript-eslint to start the same TypeScript "project
         * service" an editor uses, which finds the nearest `tsconfig.json` for each file on its
         * own. The older alternative was `project: "./tsconfig.json"`, which had to be kept in
         * sync by hand and reloaded the whole program for every file.
         *
         * `tsconfigRootDir` tells it where to start looking. `import.meta.dirname` is the
         * directory holding *this* file, so the lookup does not depend on which directory you
         * happened to run `pnpm lint` from.
         */
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },

    rules: {
      /*
       * A leading underscore means "I know this is unused and I meant it".
       *
       * The common case is a callback whose signature forces a parameter you do not need, or a
       * `catch (_error)` that deliberately ignores what went wrong. Writing `_error` is a signal to
       * the next reader; without this option the only way to express it would be a disable comment.
       */
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],

      /*
       * `solid/jsx-no-undef` looks for JSX tags naming a variable that nothing declared — `<Foo />`
       * with no `Foo` in scope. In a TypeScript project the compiler already reports that, with a
       * better message, and the rule's own `typescriptEnabled` option exists to hand the job over.
       * The plugin sets it in its `typescript` preset but not in the `v2` preset used here, so it
       * is set explicitly. This narrows what the rule checks; it does not switch anything off.
       */
      "solid/jsx-no-undef": ["error", { typescriptEnabled: true }],

      /*
       * `solid/imports` is switched OFF, and this is the one rule in the project that is.
       *
       * The rule checks that each Solid export is imported from the package that owns it, and it
       * keeps a hard-coded table of which package that is. In `eslint-plugin-solid@0.16.0` that
       * table says the `JSX` type namespace lives in "solid-js". It does not: in Solid 2 the
       * browser renderer, and the JSX types with it, moved into "@solidjs/web", and
       * `solid-js@2.0.0-rc.1` has no `JSX` export at all. Taking the rule's advice — including its
       * automatic fix, which rewrites the import for you — makes `tsc` fail with:
       *
       *     error TS2305: Module '"solid-js"' has no exported member 'JSX'.
       *
       * on all eleven files that import the type. The rule takes no options, so there is no way to
       * correct only that one table entry.
       *
       * Nothing else is lost by turning it off. Every other export the rule knows about is already
       * imported from the right package here, and `tsc` reports an import from a package that does
       * not export the name anyway — which is exactly how this disagreement was settled.
       *
       * Revisit this when eslint-plugin-solid fixes the table; the rule is worth having back.
       */
      "solid/imports": "off",
    },
  },

  {
    /*
     * The effect SDK and every effect built on it.
     *
     * ## The rule, and the silent bug it catches
     *
     * Nothing under `src/effects/` may import Solid's ownership or reactivity primitives.
     *
     * Solid 2 ref callbacks are **unowned**: `getOwner()` returns `null` inside one, and
     * `onCleanup` cannot be registered there. An SDK helper that tried to clean up something it had
     * attached through a ref would therefore register nothing at all — no error, no warning, just a
     * WebGL context or an open microphone that is never released. Phase 1 lost time to exactly this
     * class of defect twice, and the roadmap records that neither `tsc`, nor the production build,
     * nor any other lint rule can see it.
     *
     * So SDK teardown never depends on reactive ownership. Resources are owned by the effect's
     * `Scope` (see `src/effects/sdk/scope.ts`), and `src/components/EffectStage.tsx` drives
     * disposal and is the only place in the application that does.
     *
     * This is the one defect class in the Phase 3.1 refactor a linter genuinely catches, and a rule
     * that lives only in a roadmap bullet holds only as long as somebody keeps holding it.
     */
    files: ["src/effects/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "solid-js",
              importNames: ["onCleanup", "getOwner", "onSettled", "createEffect", "createSignal"],
              message:
                "Effect SDK teardown must not depend on Solid ownership. A ref callback is " +
                "unowned in Solid 2 — getOwner() returns null and onCleanup cannot be registered " +
                "there — so an SDK helper that registered a cleanup through one would leak " +
                "silently. Own the resource on the effect's Scope instead; EffectStage.tsx drives " +
                "disposal and is the only place that does.",
            },
          ],
        },
      ],
    },
  },

  {
    /*
     * The configuration files themselves — this one and `prettier.config.mjs`.
     *
     * They are deliberately *not* in `tsconfig.json`'s `include` list (they are not application
     * code and nothing imports them), so the type-aware rules above cannot run on them: those
     * rules need a TypeScript program, and these files are not part of one. They get the
     * language-level rules and nothing more.
     */
    files: ["**/*.mjs"],
    extends: [js.configs.recommended, prettier],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
  },

  {
    /*
     * The runtime verification harness in `tools/verify/`.
     *
     * It is plain JavaScript run by Node (see `pnpm verify`), not application source, so it is not
     * in `tsconfig.json`'s `include` list and the type-aware rules cannot see it — same situation
     * as the configuration files above. What it does need is a list of the names it uses that
     * nothing in the file declares, because `no-undef` has no idea what a runtime provides:
     *
     *  - the **Node** globals, because that is what runs this code;
     *  - `window` and `document`, which are **not** available to it. They appear only inside
     *    arrow functions handed to Playwright's `page.evaluate`, which serialises them and runs
     *    them in the browser. ESLint reads those functions as ordinary code in this file and would
     *    otherwise report every one of them as undefined.
     *
     * They are listed by hand rather than pulled from the `globals` package, so that the harness
     * adds no dependency of its own beyond the browser driver it cannot do without.
     */
    files: ["tools/**/*.mjs"],
    extends: [js.configs.recommended, prettier],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        Buffer: "readonly",
        clearInterval: "readonly",
        clearTimeout: "readonly",
        console: "readonly",
        document: "readonly",
        fetch: "readonly",
        process: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly",
        URL: "readonly",
        window: "readonly",
      },
    },
  },
);
