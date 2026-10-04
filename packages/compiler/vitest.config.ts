import { defineConfig, mergeConfig } from 'vitest/config'
import { baseConfig } from '../../vitest.config.base'

/**
 * compiler: inherits every shared setting from vitest.config.base.
 *
 * `exclude` lists `**/eval/**`, which keeps `pnpm --filter @countersign/compiler test` away from the live
 * golden-set suite. **It is the second of three guards, not the first**, and it is worth being precise about
 * why, because the obvious version of this file does not work:
 *
 * The root `vitest.workspace.ts` does its own file discovery with its own defaults — which match any
 * `*.test.ts` — rather than each project's `include`/`exclude`. A live suite named
 * `eval/golden.eval.live.test.ts` was therefore **collected by `pnpm test` at the root even with this exclude
 * in place**. That was measured, not assumed.
 *
 * (The glob below is the double-star/eval/double-star pattern; it is spelled out in prose rather than written
 * inline because the literal sequence closes a block comment.)
 *
 * So the guard that actually holds is the **filename**: `eval/golden.eval.live.contract.ts` cannot be matched
 * by any discovery rule in this repository. The same trick `packages/vi-client` uses for
 * `contract/at-m4.contract.ts`. This exclude stays as a second layer, and the suite's own `describe.skipIf`
 * without `OPENAI_API_KEY` is the third — three because the failure mode of losing one is a bill rather than a
 * broken build.
 *
 * Run the live suite with `pnpm --filter @countersign/compiler test:eval:live` (`vitest.eval.config.ts`) or
 * with the CLI, `pnpm --filter @countersign/compiler eval:live`.
 */
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      name: 'compiler',
      root: import.meta.dirname,
      exclude: [...(baseConfig.test?.exclude ?? []), '**/eval/**'],
    },
  }),
)
