/**
 * Self-test for scripts/check-money-discipline.mjs.
 *
 * A guard that never fires is worse than no guard, because it appears in CI and reassures a judge.
 * This writes a temporary file containing every float-money idiom the checker claims to catch,
 * plus the legitimate bigint/clock code it must *not* flag, and asserts the exact rule set.
 *
 * Run: pnpm --filter @countersign/core exec vitest run test/money-discipline.test.ts
 *       (also runs as part of `pnpm test` in packages/core)
 */
import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const REPO = join(import.meta.dirname, '../../..')
const CHECKER = join(REPO, 'scripts/check-money-discipline.mjs')

/** Run the checker over a throwaway tree and return its combined output. */
function runChecker(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cs-money-'))
  try {
    const src = join(dir, 'packages/core/src')
    mkdirSync(src, { recursive: true })
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(src, name), body, 'utf8')
    }
    try {
      return execFileSync(process.execPath, [CHECKER, '--root', dir], { encoding: 'utf8', stdio: 'pipe' })
    } catch (e) {
      // The checker exits 1 on violations and prints the report to stderr.
      return `${(e as { stdout?: string }).stdout ?? ''}${(e as { stderr?: string }).stderr ?? ''}`
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const BAD = `
export function bad(v: string, totalMinor: bigint) {
  const a = parseFloat(v)
  const b = Math.round(Number(totalMinor) / 100)
  const c = (Number(totalMinor) / 100).toFixed(2)
  const d = Number(totalMinor)
  const e = +totalMinor
  return [a, b, c, d, e]
}
`

const GOOD = `
export function good(totalMinor: bigint, other: bigint) {
  const sum = totalMinor + other
  const half = sum / 2n
  const asText = half.toString()
  const seconds = Math.floor(1.5)
  const roundedRetry = Math.round(Math.random() * 10)
  const delay = Math.round(200 * 1.5)
  // A comment mentioning parseFloat and totalMinor must not be flagged.
  // parseFloat is banned; use fromPayPalValue(totalMinorString)
  return { sum, asText, seconds, roundedRetry, delay }
}
`

describe('check-money-discipline.mjs', () => {
  afterAll(() => {
    /* nothing to clean: each run uses its own temp dir */
  })

  it('catches every float-money idiom it claims to catch', () => {
    const out = runChecker({ 'bad.ts': BAD })
    expect(out).toContain('no-parseFloat')
    expect(out).toContain('no-float-math-on-money')
    expect(out).toContain('no-toFixed-on-money')
    expect(out).toContain('no-number-coercion-of-money')
  })

  it('does not flag correct bigint arithmetic, clock rounding or comments', () => {
    const out = runChecker({ 'good.ts': GOOD })
    expect(out).toContain('clean')
    expect(out).not.toContain('no-parseFloat')
    expect(out).not.toContain('no-number-coercion-of-money')
  })

  it('exempts tests and scripts, where writing 129.99 is the point', () => {
    const out = runChecker({
      'money.test.ts': 'it("rejects 1.005", () => { expect(fromPayPalValue("1.005","USD")).toThrow() })',
    })
    expect(out).toContain('clean')
  })

  it('passes on the real repository right now', () => {
    const out = execFileSync(process.execPath, [CHECKER], { encoding: 'utf8' })
    expect(out).toContain('clean')
  })
})