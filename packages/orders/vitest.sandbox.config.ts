/**
 * Sandbox-only test configuration — **opt-in, never part of the PR gate**.
 *
 * Spec D21: "a sandbox E2E suite runs nightly". The shared base config excludes `**\/*.sandbox.test.ts`
 * from the default run, so `test/orchestrator.sandbox.test.ts` is invisible to `pnpm test` and only appears
 * here:
 *
 * ```
 * pnpm --filter @countersign/orders test:sandbox
 * ```
 *
 * It needs real credentials (`docs/HUMAN_TODO.md` H-01). Without them the suite skips with an explicit
 * message rather than failing or silently passing — a green run against no sandbox must never be mistaken
 * for a green run against one.
 */
import { defineConfig } from 'vitest/config'
import type { ViteUserConfig } from 'vitest/config'

import { baseConfig } from '../../vitest.config.base'

/**
 * Built by spreading rather than by `mergeConfig`, on purpose.
 *
 * `mergeConfig` **concatenates** arrays, so merging here would keep the base config's
 * `exclude: ['**\/*.sandbox.test.ts', …]` and this file's only suite would still be filtered out — the exact
 * opposite of what it is for. Spreading the base test options and then overriding `include`/`exclude` makes
 * the override authoritative.
 */
const config: ViteUserConfig = {
  test: {
    ...(baseConfig.test as Record<string, unknown>),
    name: 'orders-sandbox',
    root: import.meta.dirname,
    // Only the sandbox suite. `include` replaces the base one, so the fast unit tests are not run twice.
    // Both globs are listed because `test/**/*.sandbox.test.ts` requires a directory level in some glob
    // implementations, and this file sits directly in `test/`.
    include: ['test/*.sandbox.test.ts', 'test/**/*.sandbox.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/e2e/**'],
    // Sandbox calls are slower than the PR gate, and the flow below makes a dozen round trips against a
    // real server: create, authorize, two captures, two captures' worth of refunds.
    testTimeout: 180_000,
    hookTimeout: 60_000,
    // Sequential: every test here moves real money in the same sandbox, and two suites doing that at once is
    // a flaky test rather than a parallel speed-up.
    fileParallelism: false,
  },
}

export default defineConfig(config)
