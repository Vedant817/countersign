import { defineConfig, mergeConfig } from 'vitest/config'
import { baseConfig } from '../../vitest.config.base'

/**
 * vi-client: inherits every shared setting from vitest.config.base.
 *
 * **The contract suite (AT-M4.1) is `contract/at-m4.contract.ts` — a filename that does not end in
 * `.test.ts`.** That is what keeps it out of the default run: the shared `include` only covers `test/` and
 * `src/`, so nothing under `contract/` can match it. The contract tests need a **running vi-service**, and
 * `pnpm test` must pass with no network anywhere.
 *
 * The `exclude` below is a second, belt-and-braces guard rather than the mechanism. A per-package
 * `exclude` is honoured when Vitest runs this package alone, and the root `pnpm test` now honours it too:
 * the root config used to be named `vitest.workspace.ts`, which Vitest 5 never reads, so the root run fell
 * back to default discovery and collected any `*.test.ts` regardless of this file. The root config is now
 * `vitest.config.ts` and its projects are consulted, but relying on `exclude` alone would still leave the
 * guarantee one config change away from breaking. `mergeConfig` concatenates arrays, so this appends to the
 * base exclusions rather than replacing them.
 *
 * Run the contract suite with `pnpm test:contract` (see `vitest.contract.config.ts`).
 */
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      name: 'vi-client',
      root: import.meta.dirname,
      exclude: [...(baseConfig.test?.exclude ?? []), '**/contract/**'],
    },
  }),
)
