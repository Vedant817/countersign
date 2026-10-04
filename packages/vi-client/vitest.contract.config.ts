import { defineConfig, mergeConfig } from 'vitest/config'
import { baseConfig } from '../../vitest.config.base'

/**
 * AT-M4.1 — the contract suite, split out of the default `pnpm test` run.
 *
 * Two reasons it is a separate config rather than a skip inside the main one:
 *
 *  1. **These tests need a service.** The default suite must pass with no network at all, so it cannot
 *     contain a test that fails when `VI_SERVICE_URL` is unset.
 *  2. **These tests are slow.** They sign real credentials — a real P-256 key, a real SD-JWT, a real
 *     checkout price lock — against a real HTTP service, which is milliseconds of crypto plus a handful of
 *     round trips. `testTimeout` is raised so a loaded CI runner does not fail a healthy service.
 *
 * The contract suite lives in **`contract/at-m4.contract.ts`**, and that filename is load-bearing.
 *
 * It deliberately does **not** end in `.test.ts`. The shared `include` is
 * `['test/**\/*.{test,spec}.{ts,tsx}', 'src/**\/*.{test,spec}.{ts,tsx}']`, so nothing under `contract/` can
 * match it; and because the root `vitest.workspace.ts` run does file discovery with its **own** defaults
 * (which match any `*.test.ts`) rather than each project's `include`/`exclude`, a `.test.ts` name anywhere
 * in this package is collected by `pnpm test` even though it is excluded here —
 * `packages/paypal`'s `*.sandbox.test.ts` suites are caught by the same thing today.
 *
 * So the separation is structural rather than configuration-dependent, which is the only version that
 * cannot regress: a filename no include pattern can match, plus an explicit `include` here that names it.
 *
 * `include` is set **after** merging, because `mergeConfig` concatenates arrays — putting it inside
 * `defineConfig` leaves the base patterns in place and this config collects the unit suite too.
 */
const merged = mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      name: 'vi-client-contract',
      root: import.meta.dirname,
      // Real signing plus several HTTP round trips. Generous, because a flaky timeout here would be
      // reported as a broken client.
      testTimeout: 60_000,
      hookTimeout: 60_000,
      // One service, one keystore: the chain builder mints keys and the tests are order-dependent within a
      // file, so parallelism buys nothing and risks confusion.
      fileParallelism: false,
    },
  }),
)

export default {
  ...merged,
  test: { ...merged.test, include: ['contract/**/*.contract.ts'] },
}
