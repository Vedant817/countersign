/**
 * Sandbox-only test configuration — **opt-in, never part of the PR gate**.
 *
 * The shared base config excludes `**\/*.sandbox.test.ts` from the default run, so `test/filer.sandbox.test.ts`
 * and `test/strategist.sandbox.test.ts` are invisible to `pnpm test` and appear only here:
 *
 * ```
 * pnpm --filter @countersign/defender test:sandbox
 * ```
 *
 * They cover spec **AT-M15.4** and **AT-M16.3**, which cannot be asserted against a `fetchImpl` double at all —
 * the whole point of each item is that a *real* PayPal sandbox accepts (or rejects) the packet. They need real
 * credentials (`docs/HUMAN_TODO.md` H-01); without them each test skips with the reason **in its own name**, so a
 * green run against no sandbox can never be mistaken for a green run against one.
 */
import { defineConfig } from 'vitest/config'
import type { ViteUserConfig } from 'vitest/config'

import { baseConfig } from '../../vitest.config.base'

/**
 * Built by spreading rather than by `mergeConfig`, on purpose.
 *
 * `mergeConfig` **concatenates** arrays, so merging here would keep the base config's
 * `exclude: ['**\/*.sandbox.test.ts', …]` and these files would still be filtered out — the exact opposite of what
 * this config is for. Spreading the base test options and then overriding `include`/`exclude` makes the override
 * authoritative. (`packages/defender/vitest.config.ts` does use `mergeConfig`, correctly: it adds to the default
 * run rather than replacing it.)
 */
const config: ViteUserConfig = {
  test: {
    ...(baseConfig.test as Record<string, unknown>),
    name: 'defender-sandbox',
    root: import.meta.dirname,
    // Only the sandbox suites. `include` replaces the base one, so the 644 fast unit tests are not run twice.
    // Both globs are listed because `test/**/*.sandbox.test.ts` requires a directory level in some glob
    // implementations, and these files sit directly in `test/`.
    include: ['test/*.sandbox.test.ts', 'test/**/*.sandbox.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/e2e/**'],
    // Uploads are the slow part: `provide-evidence` and `appeal` are `multipart/form-data` and the packet PDF
    // is a couple of hundred kilobytes, so a generous ceiling is cheaper than a flaky red build.
    testTimeout: 180_000,
    hookTimeout: 60_000,
    // Sequential. Every test here posts to the **same** dispute in the same sandbox, and two of them are
    // deliberately about idempotency — running them concurrently would make the assertion meaningless.
    fileParallelism: false,
  },
}

export default defineConfig(config)
