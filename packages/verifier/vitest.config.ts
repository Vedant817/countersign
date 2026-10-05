import { defineConfig, mergeConfig } from 'vitest/config'
import { baseConfig } from '../../vitest.config.base'

/**
 * verifier: inherits every shared setting from vitest.config.base.
 *
 * The suites here are offline by construction: no test opens a socket, and the two that shell out to
 * Python (`test/verify-py.test.ts`) skip when `uv` or `apps/vi/.venv` is absent rather than failing, so
 * a machine without the pinned Verifiable Intent library still gets the rest of the coverage.
 */
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: { name: 'verifier', root: import.meta.dirname },
  }),
)
