/**
 * The nightly report runner (P0-7 / §8.20 evidence for `sandbox-nightly.yml`).
 *
 * These tests exist because the workflow's numbers must be machine-produced and honest: the runner is
 * what writes `report.json` and `injection.json`, and a bug here would publish a number the compiler
 * never earned. They run the real corpus offline — no model, no network — into a temp directory, then
 * assert on the written bytes and the verdict, including the properties the workflow depends on
 * (`gate_bypass_rate` is the breach fraction, an empty corpus is not a clean 0, the floor is enforced).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { loadInjectionCorpus } from '../src/corpus.js'
import {
  COMPILER_FLOOR,
  DEFAULT_OUT_DIR,
  gateBypassRate,
  gitRoot,
  resolveOutDir,
  runNightlyReport,
  type NightlyReport,
} from '../src/nightly.js'

const created: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'countersign-nightly-'))
  created.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function readJson(report: NightlyReport, file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(report.outDir, file), 'utf8')) as Record<string, unknown>
}

describe('runNightlyReport (offline)', () => {
  it('writes the §14 report and the §8.20 summary, and passes on the real corpora', async () => {
    const report = await runNightlyReport({ outDir: tempDir() })

    expect(report.failures).toEqual([])
    expect(report.compiler.rate).not.toBeNull()
    expect(report.compiler.rate ?? 0).toBeGreaterThanOrEqual(COMPILER_FLOOR)
    expect(report.compiler.total).toBeGreaterThan(0)

    const written = readJson(report, 'report.json')
    expect(written['total']).toBe(report.compiler.total)
    expect(written['rate']).toBe(report.compiler.rate)

    const injection = readJson(report, 'injection.json')
    expect(injection['breaches']).toBe(0)
    expect(injection['gate_bypass_rate']).toBe(0)
    expect(injection['total']).toBe(loadInjectionCorpus().length)
  })

  it('gate_bypass_rate is the breach fraction, and an empty corpus is a full breach (1), never 0', () => {
    // The property the workflow asserts on: 0 only when nothing breached, and a run that tested nothing
    // must not be able to report a clean sweep.
    expect(gateBypassRate(0, 50)).toBe(0)
    expect(gateBypassRate(1, 50)).toBe(0.02)
    expect(gateBypassRate(50, 50)).toBe(1)
    expect(gateBypassRate(0, 0)).toBe(1)
  })

  it('gitRoot finds the nearest ancestor with a .git, from a package cwd', () => {
    // The nightly runs with cwd = packages/evals; the relative --out must land at the repo root, which
    // is the nearest ancestor of the package that contains .git. The walk-up is the property under
    // test; a directory with no .git anywhere above it falls back to the cwd (the filesystem-root
    // branch), which is a statSync-throws path exercised implicitly by every run in a real repo.
    const root = gitRoot(process.cwd())
    expect(existsSync(join(root, '.git'))).toBe(true)
    // The package cwd is at or below the root — resolveOutDir's contract depends on it.
    expect(root === process.cwd() || process.cwd().startsWith(root)).toBe(true)
  })

  it('resolveOutDir resolves a relative --out against the git root, EVAL_OUT_DIR and the default too', () => {
    const root = gitRoot(process.cwd())
    expect(resolveOutDir(['--out', 'reports/evals'], join(root, 'packages', 'evals'))).toBe(
      resolve(root, 'reports/evals'),
    )
    const previous = process.env['EVAL_OUT_DIR']
    process.env['EVAL_OUT_DIR'] = 'from-env'
    try {
      expect(resolveOutDir([], join(root, 'packages', 'evals'))).toBe(resolve(root, 'from-env'))
    } finally {
      if (previous === undefined) delete process.env['EVAL_OUT_DIR']
      else process.env['EVAL_OUT_DIR'] = previous
    }
    expect(resolveOutDir([], join(root, 'packages', 'evals'))).toBe(resolve(root, DEFAULT_OUT_DIR))
  })
})
