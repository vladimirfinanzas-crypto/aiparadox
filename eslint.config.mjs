import nextCoreWebVitals from "eslint-config-next/core-web-vitals"
import nextTypescript from "eslint-config-next/typescript"

/**
 * Flat ESLint config (ESLint 9, flat-config default) for the Next.js 16 App Router project.
 *
 * `eslint-config-next` already:
 *   - configures the TypeScript/JSX parser and language options,
 *   - sets lintable file globs (js/mjs/cjs/jsx/ts/tsx),
 *   - globally ignores `.next/**`, `out/**`, `build/**` and `next-env.d.ts`
 *     (plus `node_modules`/`.git` which ESLint ignores by default).
 *
 * We layer the Next.js core-web-vitals rules on top of the base config, then
 * the TypeScript-specific rules. Both are plain `Linter.Config[]` arrays, so
 * they spread directly into the exported array.
 */
const eslintConfig = [
  {
    // Build caches and generated artifacts. These are gitignored and
    // regenerated, and `.trigger/tmp` in particular holds bundled `.mjs`
    // chunks (hundreds of them) that otherwise dominate lint runtime.
    ignores: [
      ".trigger/**",
      ".wrangler/**",
      ".open-next/**",
      "freebuff-sites-build/**",
      "desktop/build/**",
      "desktop/dist/**",
      "desktop/out/**",
      "desktop/.venv/**",
      "public/downloads/**",
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,

  {
    rules: {
      // ---------------------------------------------------------------------------
      // React Compiler advisory rules (eslint-plugin-react-hooks, enabled by
      // eslint-config-next on Next.js 16). They enforce "pure"/compiler-friendly
      // React but are NOT correctness bugs — the patterns they flag are legal,
      // widely used idioms (latest-ref, mount-guard setState, etc).
      //
      // This codebase predates those rules and the flagged patterns are spread
      // across ~15 interactive/decorative components. We downgrade them to
      // "warn" so `npm run lint` stays green (CI-friendly) while the advice
      // remains visible for gradual, low-risk cleanup. Raise any of these back
      // to "error" once its call sites have been refactored.
      // ---------------------------------------------------------------------------
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/static-components": "warn",
    },
  },
]

export default eslintConfig
