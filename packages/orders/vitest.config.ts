import { defineConfig, mergeConfig } from 'vitest/config'
import { baseConfig } from '../../vitest.config.base'

/** orders: inherits every shared setting from vitest.config.base. */
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: { name: 'orders', root: import.meta.dirname },
  }),
)
