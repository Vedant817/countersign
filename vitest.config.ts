/**
 * Root vitest configuration — the single entry point for the whole TypeScript suite.
 *
 * Why this exists when every package has its own `vitest.config.ts`: CI needs to run
 * `pnpm vitest --run --shard=N/3` **across all packages at once** to split a 12-minute suite into
 * three parallel jobs (`.github/workflows/ci.yml`). Vitest 5 removed `vitest.workspace.ts`; a root
 * `vitest.config.ts` declaring `test.projects` is the supported form, and each package is one project.
 *
 * Two properties matter more than discovery itself:
 *  - nothing runs in a browser environment, because a DOM-passing test can fail in a real browser
 *    (the WebCrypto keystore in WP-05 is the case that matters);
 *  - live-sandbox suites (`*.sandbox.test.ts`) are excluded from the default run, so the PR gate never
 *    needs PayPal credentials and never silently skips them into a false green.
 *
 * Both live in `vitest.config.base.ts`, which every project config extends, so a package behaves
 * identically under this root run and under `pnpm -r test`.
 *
 * ## The filename is load-bearing
 *
 * This file used to be `vitest.workspace.ts`, and its `test.projects` body was correct — but Vitest
 * never read it. Workspace files were deprecated in 3.2 and removed in 4; Vitest 5 loads only
 * `vitest.config.ts` and otherwise falls back to its defaults for the working directory. The root run
 * therefore collected `apps/web/tests/e2e/device-sign.spec.ts` (a Playwright suite with no vitest
 * setup), and `vitest --run --project web` answered `No projects matched the filter "web"`.
 *
 * That also explains an earlier false diagnosis recorded here: settings added to this file appeared to
 * do nothing, and the blame was put on "a workspace root does not inherit its projects' configs". The
 * real cause was that no config was loaded at all — including the per-project excludes that should
 * have kept the e2e spec out. Renaming the file to `vitest.config.ts` was the whole fix.
 *
 * ## Why `maxWorkers` lives in the npm script
 *
 * Raising timeouts used to stop the timeout errors and expose the actual failure:
 *
 * > `[vitest-pool]: Failed to start forks worker for test files …/client.test.ts`
 *
 * On a 24-core machine, vitest defaults to about 23 fork workers for 70 test files. Each worker is a
 * separate Node process with its own module graph, and several of these suites are CPU-bound *and*
 * memory-heavy — 2,000 Ed25519 verifications, PDF rendering with font subsetting, a 515 KB TTF in the
 * graph, QR rasterising. Twenty-three of those at once oversubscribes the box, the workers thrash, and
 * tests that were merely slow get reported as timeouts.
 *
 * So the honest cause is **unbounded parallelism**, and a timeout increase only moves the symptom.
 *
 * **This is a CI-relevant finding, not a local quirk.** GitHub's standard runners are 2-core, so an
 * unsharded default run has little headroom there too.
 *
 * The cap is `--maxWorkers=6` in `package.json`'s `test` and `test:ci` scripts. It stays on the command
 * line rather than in this file because that is the form that was verified end to end, and because the
 * flags sit next to the command they modify. The value is fixed rather than derived from the core
 * count, on purpose: a machine-dependent `maxWorkers` makes the suite behave differently on a laptop
 * and on a runner, so a timeout that passes locally can still fail in CI — and a reproducible run is
 * worth more than four minutes saved. Override locally with `pnpm test -- --maxWorkers=N` when
 * profiling.
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
    // No testTimeout or hookTimeout here: every project inherits them from `vitest.config.base.ts`,
    // and a root copy would only be a second value to drift. `maxWorkers` is a CLI flag in
    // `package.json`'s test scripts, for the reason in the header.
  },
})
