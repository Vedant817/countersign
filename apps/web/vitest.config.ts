import { defineConfig, mergeConfig } from 'vitest/config'
import { baseConfig } from '../../vitest.config.base'

/**
 * web: the Next.js app.
 *
 * Two differences from the shared base:
 *  - `environment: 'node'`. Route handlers and server components run on the server; the browser
 *    surface is covered by Playwright (spec §8.5) because jsdom would happily let a WebCrypto or
 *    IndexedDB test pass that a real browser would fail.
 *  - the `@/` path alias from apps/web/tsconfig.json, so tests import exactly what the app imports.
 */
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      name: 'web',
      root: import.meta.dirname,
      environment: 'node',
      include: [
        'test/**/*.{test,spec}.{ts,tsx}',
        'app/**/*.test.{ts,tsx}',
        'lib/**/*.test.{ts,tsx}',
      ],
    },
    resolve: {
      alias: {
        '@': new URL('.', import.meta.url).pathname.replace(/\\/g, '/'),
      },
    },
  }),
)
