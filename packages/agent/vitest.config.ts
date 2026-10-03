import { defineConfig, mergeConfig } from 'vitest/config'
import { baseConfig } from '../../vitest.config.base'

/** agent: inherits every shared setting from vitest.config.base. */
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: { name: 'agent', root: import.meta.dirname },
  }),
)
