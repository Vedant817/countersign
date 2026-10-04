/**
 * Sandbox-only test configuration — **opt-in, never part of the PR gate**.
 *
 * Spec D21: "a sandbox E2E suite runs nightly". The shared base config excludes `**\/*.sandbox.test.ts`
 * from the default run, so those files are invisible to `pnpm test` and only appear here:
 *
 * ```
 * pnpm --filter @countersign/paypal test:sandbox
 * ```
 *
 * It needs real credentials (`docs/HUMAN_TODO.md` H-01). Without them every suite in there skips with
 * an explicit message rather than failing or silently passing — a green run against no sandbox must
 * never be mistaken for a green run against one.
 */
import { defineConfig } from 'vitest/config'
import type { ViteUserConfig } from 'vitest/config'

import { baseConfig } from '../../vitest.config.base'

/**
 * Built by spreading rather than by `mergeConfig`, on purpose.
 *
 * `mergeConfig` **concatenates** arrays, so merging here would keep the base config's
 * `exclude: ['**\/*.sandbox.test.ts', …]` and the sandbox suites would still be filtered out — the
 * exact opposite of what this file is for. Spreading the base test options and then overriding
 * `include`/`exclude` makes the override authoritative.
 */
const config: ViteUserConfig = {
  test: {
    ...(baseConfig.test as Record<string, unknown>),
    name: 'paypal-sandbox',
    root: import.meta.dirname,
    // Only the sandbox suites. `include` replaces the base one, so the fast unit tests are not
    // reported twice. Both globs are listed because `test/**/*.sandbox.test.ts` requires a directory
    // level in some glob implementations, and these files sit directly in `test/`.
    include: ['test/*.sandbox.test.ts', 'test/**/*.sandbox.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/e2e/**'],
    // Sandbox calls are slower than the PR gate and involve several round trips plus a polling loop
    // for the dispute to appear (§10.3 step 3).
    testTimeout: 180_000,
    hookTimeout: 60_000,
    // Sequential by default: two suites fighting over the same sandbox personas is a flaky test, not
    // a parallel speed-up.
    fileParallelism: false,
  },
}

export default defineConfig(config)
