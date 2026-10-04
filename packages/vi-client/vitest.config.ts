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
 * `exclude` is honoured when Vitest runs this package alone, but the root `vitest.workspace.ts` run does
 * file discovery with its own defaults (which match any `*.test.ts`) rather than each project's
 * `include`/`exclude` — `packages/paypal`'s `*.sandbox.test.ts` suites are caught by the same thing today.
 * Relying on `exclude` alone would leave the guarantee one config change away from breaking. `mergeConfig`
 * concatenates arrays, so this appends to the base exclusions rather than replacing them.
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
