import { defineConfig, mergeConfig } from 'vitest/config'
import { baseConfig } from '../../vitest.config.base'

/** vi-client: inherits every shared setting from vitest.config.base. */
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: { name: 'vi-client', root: import.meta.dirname },
  }),
)
