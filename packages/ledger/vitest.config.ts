import { defineConfig, mergeConfig } from 'vitest/config'
import { baseConfig } from '../../vitest.config.base'

/** ledger: inherits every shared setting from vitest.config.base. */
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: { name: 'ledger', root: import.meta.dirname },
  }),
)
