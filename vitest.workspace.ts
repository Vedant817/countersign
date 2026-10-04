/**
 * Root vitest configuration — the single entry point for the whole TypeScript suite.
 *
 * Why this exists when every package has its own `vitest.config.ts`: CI needs to run
 * `pnpm vitest --run --shard=N/3` **across all packages at once** to split a 12-minute suite into
 * three parallel jobs (`.github/workflows/ci.yml`). Vitest 5 calls a config with multiple projects a
 * "workspace", so this file is the workspace root and each package is one project.
 *
 * Two properties are enforced here rather than trusted per package:
 *  - nothing runs in a browser environment, because a DOM-passing test can fail in a real browser
 *    (the WebCrypto keystore in WP-05 is the case that matters);
 *  - live-sandbox suites (`*.sandbox.test.ts`) are excluded from the default run, so the PR gate never
 *    needs PayPal credentials and never silently skips them into a false green.
 */
import { defineConfig } from 'vitest/config'
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

function projectDirs(dir: string): { name: string; dir: string }[] {
  const root = join(import.meta.dirname, dir)
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .filter((e) => existsSync(join(root, e.name, 'vitest.config.ts')))
    .map((e) => ({ name: e.name, dir: join(dir, e.name) }))
}

export default defineConfig({
  test: {
    projects: [
      ...projectDirs('packages').map((p) => p.dir),
      ...projectDirs('apps').map((p) => p.dir),
    ],
    reporters: process.env['CI'] ? ['default', 'junit'] : ['default'],
    outputFile: { junit: 'reports/junit.xml' },
    passWithNoTests: false,
  },
})