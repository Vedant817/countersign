/**
 * Generates the per-package `vitest.config.ts` and `tsconfig*.json` files from one template.
 *
 * These files are mechanically identical across 13 packages, and a single divergent copy is how you
 * end up with a package whose tests silently run in the wrong environment. Generating them keeps
 * them identical and makes the intent reviewable in one place.
 *
 * Run: node scripts/gen-workspace-configs.mjs
 */
import { writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

const pkgVitest = (name) => `import { defineConfig, mergeConfig } from 'vitest/config'
import { baseConfig } from '../../vitest.config.base'

/** ${name}: inherits every shared setting from vitest.config.base. */
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: { name: '${name}', root: import.meta.dirname },
  }),
)
`

const tsconfig = (depth) => `{
  "extends": "${'../'.repeat(depth)}tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023"],
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
`

/**
 * Declaration-only build.
 *
 * These packages are consumed as TypeScript *source* by whatever runs them (vitest, Next, tsx), so
 * emitting JavaScript would produce extensionless relative imports that Node cannot resolve at
 * runtime. The only artifact worth emitting is `.d.ts`, which is what `build` verifies.
 */
const tsconfigBuild = (depth) => `{
  "extends": "${'../'.repeat(depth)}tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023"],
    "types": ["node"],
    "outDir": "dist",
    "rootDir": "src",
    "emitDeclarationOnly": true
  },
  "include": ["src/**/*.ts"]
}
`

const packages = readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort()

for (const name of packages) {
  const dir = join(ROOT, 'packages', name)
  writeFileSync(join(dir, 'vitest.config.ts'), pkgVitest(name))
  writeFileSync(join(dir, 'tsconfig.json'), tsconfig(2))
  writeFileSync(join(dir, 'tsconfig.build.json'), tsconfigBuild(2))
}

for (const app of ['worker']) {
  const dir = join(ROOT, 'apps', app)
  writeFileSync(join(dir, 'vitest.config.ts'), pkgVitest(app).replaceAll("../../", "../../"))
  writeFileSync(join(dir, 'tsconfig.json'), tsconfig(2))
  writeFileSync(join(dir, 'tsconfig.build.json'), tsconfigBuild(2))
}

console.log(`generated vitest/tsconfig for ${packages.length} packages + apps/worker`)