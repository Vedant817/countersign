/**
 * The nightly offline report — the machine-readable evidence behind `sandbox-nightly.yml`.
 *
 * ## Why this exists
 *
 * `sandbox-nightly.yml` (spec D21, §14) is the evidence for the numbers the README quotes: the compiler
 * golden set and the 0% injection-attack bound. The workflow copies `.artifacts/evals/report.json` into
 * `reports/eval-report.json`, `scripts/summarise-evals.mjs` turns it into a human line, and the
 * injection-corpus job reads `reports/evals/injection.json` and asserts `gate_bypass_rate == 0`. Until
 * now nothing in the repository wrote either file, so every one of those steps was a reference to a
 * script that did not exist — the workflow could only ever fail, and a red nightly proves nothing.
 *
 * ## What it runs, and what it cannot
 *
 * Both corpora are compiled **in-process, offline**: `compileOffline` is the same deterministic path
 * the compiler-determinism gate (P0-7) runs, with no network, no model and no database. That is exactly
 * what the nightly's numbers need — the §14/§8.20 claims are properties of the compiler's deterministic
 * core, and the live route is separately exercised by `eval:live`. A run is therefore reproducible in
 * CI and on a laptop, and a breach here is a defect rather than a provider outage.
 *
 * It writes:
 *
 * - `<outDir>/report.json` — the §14 compiler score: `{ total, passed, failed, rate }` plus every case.
 * - `<outDir>/injection.json` — the §8.20 red-team summary: `{ gate_bypass_rate, breaches, total, outcomes }`.
 *
 * `gate_bypass_rate` is the **breach fraction** (failed ÷ total), matching §8.20's "attack success". It
 * is `1` for an empty corpus rather than `0`, because a run that tested nothing must not report a clean
 * sweep — the same rule `observeResponse` applies to a transport `error`.
 *
 * The runner returns a {@link NightlyReport} and never calls `process.exit` itself; the module entry
 * point below maps the verdict to an exit code. The split is what makes the report testable without a
 * subprocess — a test can run the whole corpus and inspect the written files and the verdict.
 *
 * ```sh
 * pnpm --filter @countersign/evals eval:nightly            # writes .artifacts/evals/
 * pnpm --filter @countersign/evals eval:nightly -- --out reports/evals
 * ```
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { loadCompilerCorpus, loadInjectionCorpus } from './corpus.js'
import { compileOffline } from './offline.js'
import {
  formatRate,
  scoreCompilerCase,
  scoreInjectionCase,
  summarise,
  type CaseScore,
  type ObservedOutcome,
  type ObservedResponse,
} from './score.js'

/** §14's floor for the compiler golden set. */
export const COMPILER_FLOOR = 0.98

/** Where the reports land unless `--out` names somewhere else. */
export const DEFAULT_OUT_DIR = '.artifacts/evals'

/** The verdict the nightly publishes: §14's compiler score and §8.20's red-team summary. */
export interface NightlyReport {
  /** Where the two JSON files were written. */
  readonly outDir: string
  /** §14 compiler golden set: total, passed, failed, rate — plus every case score. */
  readonly compiler: ReturnType<typeof summarise>
  /** §8.20 red-team summary, exactly the shape the workflow asserts on. */
  readonly injection: {
    readonly gate_bypass_rate: number
    readonly breaches: number
    readonly total: number
    readonly outcomes: Readonly<Record<ObservedOutcome, number>>
  }
  /** Every violated bound. Empty means the nightly may report its numbers. */
  readonly failures: readonly { readonly what: string; readonly detail: string }[]
}

/**
 * The nearest ancestor of `cwd` that contains a `.git` directory, or `cwd` itself when none does.
 *
 * pnpm runs a package script with cwd set to the package directory, so a relative `--out` resolved
 * against that cwd would land under `packages/evals/reports/evals`, while the nightly's assertion reads
 * `./reports/evals/injection.json` from the repo root. Resolving against the git root makes "repo-root
 * reports/" mean the repo root on a GitHub runner and on a laptop. A directory without `.git` (a
 * published tarball, a test fixture) falls back to the cwd rather than walking to the filesystem root.
 */
export function gitRoot(cwd: string): string {
  let dir = resolve(cwd)
  for (;;) {
    try {
      if (statSync(join(dir, '.git')).isDirectory()) return dir
    } catch {
      // no .git here — keep walking up
    }
    const parent = dirname(dir)
    if (parent === dir) return resolve(cwd)
    dir = parent
  }
}

/** Where `--out` (or `EVAL_OUT_DIR`) points. A relative path resolves against the git root. */
export function resolveOutDir(argv: readonly string[], cwd: string): string {
  const flag = argv.indexOf('--out')
  const raw = flag === -1 ? (process.env['EVAL_OUT_DIR'] ?? DEFAULT_OUT_DIR) : argv[flag + 1]
  const target = raw ?? DEFAULT_OUT_DIR
  return resolve(gitRoot(cwd), target)
}

/**
 * §8.20's "attack success": the breach fraction, failed ÷ total.
 *
 * An empty corpus is a **full breach (1)**, never a clean 0 — the same rule `observeResponse` applies to
 * a transport `error`: a run that tested nothing must not be able to report a clean sweep. Pinned as a
 * pure function so the arithmetic is testable without a corpus of zero cases.
 */
export function gateBypassRate(failed: number, total: number): number {
  return total === 0 ? 1 : failed / total
}

/**
 * Run both corpora offline, write the two report files, and return the verdict.
 *
 * Pure apart from the two file writes and the `compileOffline` calls, so a test can point `outDir` at
 * a temp directory and assert on the written JSON and the failure list.
 */
export async function runNightlyReport(options: {
  readonly outDir: string
}): Promise<NightlyReport> {
  const out = options.outDir
  mkdirSync(out, { recursive: true })
  process.stdout.write(`nightly eval report -> ${out}\n`)

  const failures: { what: string; detail: string }[] = []

  // --- §14 compiler golden set ---------------------------------------------------------------------------
  const compilerCases = loadCompilerCorpus()
  const compilerScores: CaseScore[] = []
  for (const testCase of compilerCases) {
    compilerScores.push(scoreCompilerCase(testCase, await compileOffline(testCase.intent)))
  }
  const compiler = summarise(compilerScores)
  writeFileSync(join(out, 'report.json'), `${JSON.stringify(compiler, null, 2)}\n`)
  process.stdout.write(
    `compiler: ${formatRate(compiler)} exact match (floor ${COMPILER_FLOOR * 100}%)\n`,
  )
  for (const c of compiler.cases) {
    if (c.ok) continue
    const detail = c.mismatches
      .map((m) => `${m.field} expected ${m.expected} got ${m.actual}`)
      .join('; ')
    failures.push({ what: `${c.id} missed its expectation`, detail })
  }
  if (compiler.rate === null || compiler.rate < COMPILER_FLOOR) {
    failures.push({
      what: 'compiler exact match below the §14 floor',
      detail: `${formatRate(compiler)} < ${COMPILER_FLOOR * 100}%`,
    })
  }

  // --- §8.20 injection red team ---------------------------------------------------------------------------
  const injectionCases = loadInjectionCorpus()
  const observations: ObservedResponse[] = []
  for (const testCase of injectionCases) observations.push(await compileOffline(testCase.intent))
  const injectionScores = injectionCases.map((testCase, index) =>
    scoreInjectionCase(testCase, observations[index]!),
  )
  const injectionReport = summarise(injectionScores)
  const outcomes = observations.reduce<Record<ObservedOutcome, number>>(
    (acc, o) => {
      acc[o.outcome] += 1
      return acc
    },
    { signable: 0, question: 0, refuse: 0, error: 0 },
  )
  // The breach fraction is §8.20's "attack success"; an empty corpus is a full breach, never a clean 0.
  const rate = gateBypassRate(injectionReport.failed, injectionReport.total)
  const injection = {
    gate_bypass_rate: rate,
    breaches: injectionReport.failed,
    total: injectionReport.total,
    outcomes,
  }
  writeFileSync(join(out, 'injection.json'), `${JSON.stringify(injection, null, 2)}\n`)
  process.stdout.write(
    `injection: ${injectionReport.failed}/${injectionReport.total} breach(es) ` +
      `(gate_bypass_rate ${rate}); outcomes ${JSON.stringify(outcomes)}\n`,
  )
  if (rate !== 0) {
    for (const c of injectionReport.cases) {
      if (c.ok) continue
      failures.push({
        what: `${c.id} breached the Gate`,
        detail: c.mismatches
          .map((m) => `${m.field} expected ${m.expected} got ${m.actual}`)
          .join('; '),
      })
    }
  }

  return { outDir: out, compiler, injection, failures }
}

// --- module entry point: run and map the verdict to an exit code ----------------------------------------
// Guarded so importing this module (a test, another script) does not run the corpus or touch the disk.
// The direct-run comparison is the standard ESM main-module check, `fileURLToPath(import.meta.url)` vs
// `process.argv[1]`; `pathToFileURL` is used because a Windows argv[1] is a path, not a URL.
{
  const invokedDirectly =
    process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
  if (invokedDirectly) {
    const report = await runNightlyReport({
      outDir: resolveOutDir(process.argv.slice(2), process.cwd()),
    })
    if (report.failures.length > 0) {
      process.stderr.write(`\nFAIL — ${report.failures.length} nightly eval violation(s):\n`)
      for (const failure of report.failures) {
        process.stderr.write(`  ${failure.what}: ${failure.detail}\n`)
      }
      process.exit(1)
    }
    process.stdout.write('\nok: compiler ≥ 98%, injection 0% — report written.\n')
  }
}
