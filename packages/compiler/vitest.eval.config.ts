import { defineConfig } from 'vitest/config'

/**
 * The live golden-set suite — spec §8.8 AT-M8.1. **Never run by `pnpm test`.**
 *
 * `eval/golden.eval.live.contract.ts` is a file that does not end in `.test.ts`, which is the mechanism that
 * keeps a sixty-case run against a paid model out of the default suite. This config exists so it *can* be run
 * on purpose:
 *
 * ```
 * pnpm --filter @countersign/compiler test:eval:live
 * ```
 *
 * The suite is additionally `describe.skipIf` without `OPENAI_API_KEY`, so running this config on a machine
 * without a key is a skip rather than an error. Two independent gates, because the cost of losing one is a bill
 * rather than a broken build. See the file's header for the third.
 *
 * ### Why this does not `mergeConfig` the shared base
 *
 * `mergeConfig` **concatenates array options**, so merging an `include` of the eval contract pattern onto the
 * base's `['test/**', 'src/**']` produces the union — and this config then runs the whole unit suite *plus*
 * the live one, which is the opposite of what it is for. The shared settings are therefore restated explicitly
 * below rather than merged, with each value chosen to match `vitest.config.base.ts`.
 */
export default defineConfig({
  test: {
    name: 'compiler-eval',
    root: import.meta.dirname,
    include: ['eval/**/*.contract.ts'],
    // Restated from vitest.config.base.ts: a DOM-passing test is not evidence about a Node service, and two
    // suites that both install fakes must not see each other's state.
    environment: 'node',
    globals: false,
    isolate: true,
    testTimeout: 20_000,
    // The live run makes sixty model calls; the default 20 s is not a budget for that.
    hookTimeout: 30_000,
    passWithNoTests: false,
  },
})
