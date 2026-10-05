import { defineConfig, mergeConfig } from 'vitest/config'
import { baseConfig } from '../../vitest.config.base'

/** orchestrator: inherits every shared setting from vitest.config.base. */
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: { name: 'orchestrator', root: import.meta.dirname },
  }),
)
