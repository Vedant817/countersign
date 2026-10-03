/**
 * Shared vitest configuration (spec D21: vitest 5).
 *
 * Every package extends this so that a test behaves identically whether it runs from `pnpm -r test`,
 * from an IDE, or from one CI job. Two choices here matter beyond convenience:
 *
 *  1. **`environment: 'node'` is explicit.** The browser keystore (WP-05) and the Playwright suites
 *     override it; nothing should accidentally get a DOM and pass a test the real runtime would fail.
 *  2. **`isolate: true` and no shared globals.** Two suites that both install a fake clock or a
 *     `fetch` stub must not be able to see each other's state. Webhook ordering and budget-locking
 *     tests depend on that isolation.
 */
import { defineConfig, type ViteUserConfig } from 'vitest/config'

export const testTimeoutMs = 20_000
export const hookTimeoutMs = 30_000

export const baseConfig: ViteUserConfig = {
  test: {
    environment: 'node',
    globals: false,
    isolate: true,
    include: ['test/**/*.{test,spec}.{ts,tsx}', 'src/**/*.{test,spec}.{ts,tsx}'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/test-results/**',
      '**/playwright-report/**',
      // Live-sandbox suites are opt-in: they need real PayPal credentials and are run by
      // `sandbox-nightly.yml` or `pnpm --filter <pkg> test:sandbox`, never by the PR gate.
      '**/*.sandbox.test.ts',
      '**/e2e/**',
    ],
    reporters: process.env['CI'] ? ['default', 'junit'] : ['default'],
    outputFile: { junit: 'reports/junit.xml' },
    testTimeout: testTimeoutMs,
    hookTimeout: hookTimeoutMs,
    passWithNoTests: false,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/**/index.ts', 'src/**/migrations/**'],
    },
  },
}

export default defineConfig(baseConfig)