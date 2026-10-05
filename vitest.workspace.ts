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
 *
 * ## The timeouts are declared HERE, and that is not a duplicate of `vitest.config.base.ts`
 *
 * This file was missing `testTimeout` and `hookTimeout`, and that was a real bug with a confusing
 * symptom. A workspace root does **not** inherit its projects' configs: each project reads its own
 * `vitest.config.ts`, and the root's `test` block only supplies what it states. So `pnpm test` (root,
 * 70 files, full parallelism) ran every test against **vitest's 5 s default**, while
 * `pnpm -r test` (per package, one file at a time) correctly used the 20 s from the base config.
 *
 * Eight tests then failed with `Test timed out in 5000ms` under the root run and passed under the
 * per-package run — all of them doing real work: 20,000 ULIDs, a 100-run property test with Ed25519
 * signing, PDF rendering with font subsetting, QR rasterising. Every one of them would have been
 * "fixed" by editing the test that happened to fail first, and each of those fixes would have been
 * wrong, because the cause was the configuration.
 *
 * The values are imported rather than copied, so the two files cannot drift again.
 *
 * ## And `maxWorkers` is capped, which is the actual fix
 *
 * Raising the timeout stopped the failures and **missed the cause**. With the timeouts out of the way
 * the next error was visible:
 *
 * > `[vitest-pool]: Failed to start forks worker for test files …/client.test.ts`
 *
 * On a 24-core machine, vitest defaults to about 23 fork workers for 70 test files. Each worker is a
 * separate Node process with its own module graph, and several of these suites are CPU-bound *and*
 * memory-heavy — 2,000 Ed25519 verifications, PDF rendering with font subsetting, a 515 KB TTF in the
 * graph, QR rasterising. Twenty-three of those at once oversubscribes the box, the workers thrash, and
 * every test that was actually working slowly gets reported as `Test timed out in 5000ms`.
 *
 * So the honest cause is **unbounded parallelism**, and a timeout increase only moved the symptom.
 *
 * **This is a CI-relevant finding, not a local quirk.** GitHub's standard runners are 2-core, so the
 * unsharded default would have failed there for the same reason.
 *
 * ## Why the settings live in the npm script and not here
 *
 * Declaring `testTimeout` and `maxWorkers` in *this* file does nothing. Verified: with both set here,
 * `vitest --run` still reported `Test timed out in 5000ms` in nine files and the pool still failed to
 * start workers. A Vitest workspace root's `test` block supplies project **discovery**; its per-project
 * options are read from each project's own config, and the root's run-wide knobs are not applied to
 * them. `pnpm --filter <pkg> test` — one config, no workspace — honours `vitest.config.base.ts` correctly,
 * which is exactly why the per-package run passed while the root run failed.
 *
 * So the numbers live in `package.json`'s `test` script, as CLI flags, because that is the one place
 * proven to reach the pool. They are duplicated from `vitest.config.base.ts` in the other direction:
 * the per-package run and the root run are now explicitly the same.
 *
 * The values are fixed rather than derived from the core count, on purpose. A machine-dependent
 * `maxWorkers` makes the suite behave differently on a laptop and on a runner, so a timeout that
 * passes locally can still fail in CI — and a reproducible run is worth more than four minutes saved.
 * Override locally with `pnpm test -- --maxWorkers=N` when profiling.
 */
import { defineConfig } from 'vitest/config'
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Workers for the root run.
 *
 * Six rather than the ~23 that 24 cores would allow. These suites are CPU-bound in crypto and font
 * work rather than I/O-bound, so they do not scale linearly, and past about six the pool is dominated by
 * contention rather than throughput. Exported so the comment above has something to point at; the value
 * the pool actually uses is the flag in `package.json`.
 */
export const rootRunMaxWorkers = 6

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
    // Deliberately no `testTimeout`, `hookTimeout` or `maxWorkers` here. The header explains why:
    // a workspace root's `test` block does not reach the pool, so declaring them in this file reads as
    // a control while doing nothing. They are CLI flags in `package.json`'s `test` script, which is the
    // only place verified to apply to the whole run.
  },
})
