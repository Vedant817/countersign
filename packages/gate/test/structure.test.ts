/**
 * Structural guards on time, money and the LLM boundary.
 *
 * These exist because the corresponding bugs are **intermittent or invisible**, which is the worst
 * combination: a flake with a 12-in-12 non-reproduction rate would have been discovered by a judge
 * rather than by CI, and a money bug with no test would not be discovered at all.
 *
 * Each guard reads source rather than behaviour on purpose. A behavioural test for "no wall clock"
 * is a test that passes when the clock happens to agree, which is the thing that went wrong.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

// Static, not `await import(...)`. A dynamic import made this test take 2.2 s on its own — the cost
// of lazily loading `jose` — and under the full-suite load of `pnpm test` that crossed the 5 s test
// timeout intermittently. That is precisely the failure mode this file exists to prevent: a test that
// is slow for no reason is a test that will flake, and a test that flakes is a test nobody trusts.
import { verifyDecisionRecord } from '../src/decision-record'

const SRC = join(import.meta.dirname, '..', 'src')

function sourceFiles(dir: string): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full))
    } else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
      out.push({ file: name, text: readFileSync(full, 'utf8') })
    }
  }
  return out
}

/** Strip comments, so prose about `Date.now()` is not mistaken for a call to it. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/(?:\/\/|\*).*$/, ''))
    .join('\n')
}

describe('EC-TIME-4 the Gate takes its time from the injected clock and nowhere else', () => {
  const files = sourceFiles(SRC)

  it('reads no wall clock anywhere in packages/gate/src', () => {
    const offenders: string[] = []
    for (const { file, text } of files) {
      const src = code(text)
      // `Date.now()` and a bare `new Date()` are the two ways a wall clock sneaks in. Neither is
      // needed here: the Gate captures `nowSec` once at entry and every comparison uses it (EC-TIME-4).
      if (/\bDate\.now\s*\(\s*\)/.test(src)) offenders.push(`${file}: Date.now()`)
      if (/\bnew\s+Date\s*\(\s*\)/.test(src)) offenders.push(`${file}: new Date()`)
    }
    expect(
      offenders,
      'A wall clock in the Gate makes its decisions depend on when they ran. Take the time from the ' +
        'injected Clock instead — see spec §12.5 EC-TIME-4.',
    ).toEqual([])
  })

  it('verifyDecisionRecord has no system-clock default for nowSec', async () => {
    // The structural guard above cannot see this one, because the fallback was an expression rather
    // than a call: `options.nowSec ?? Math.floor(Date.now() / 1000)`.
    const jwks = { keys: [] }

    const missing = (await verifyDecisionRecord('not.a.jws', {
      jwks,
    } as never)) as { valid: boolean; reason?: string }
    expect(missing.valid).toBe(false)
    expect(missing.reason).toContain('nowSec')

    // A finite number is accepted as "now" — the guard is about the *absence* of a default, not
    // about rejecting the option.
    const withNow = (await verifyDecisionRecord('not.a.jws', {
      jwks,
      nowSec: 1_760_000_000,
    })) as { valid: boolean; reason?: string }
    // Still invalid, but for the token's sake rather than the clock's.
    expect(withNow.reason ?? '').not.toContain('nowSec')
  })
})

describe('spec §8.10 the Gate has no LLM in its dependency graph', () => {
  it('no source file in packages/gate imports a model runtime', () => {
    const banned = /from\s+['"](ai|ai\/.+|@ai-sdk\/.+|openai|@anthropic-ai\/.+|ollama)['"]/
    const offenders: string[] = []
    for (const { file, text } of sourceFiles(SRC)) {
      if (banned.test(code(text))) offenders.push(file)
    }
    // The ESLint rule in eslint.config.mjs is the real gate; this is the belt to its braces, and it
    // runs even if someone tightens or removes the lint config. Spec §8.10: "No LLM anywhere in M10".
    expect(offenders).toEqual([])
  })
})

describe('spec §0 money never becomes a float', () => {
  it('no source file in packages/gate parses or formats money with a float primitive', () => {
    // `scripts/check-money-discipline.mjs` is the general guard and covers every scanned root. This is
    // the Gate-local statement of the same rule, because the Gate is where an overspend becomes
    // irreversible and where a reviewer will look hardest.
    const banned = [/\bparseFloat\s*\(/, /\.toFixed\s*\(/, /\bparseInt\s*\(\s*[\w$.]*[Aa]mount/]
    const offenders: string[] = []
    for (const { file, text } of sourceFiles(SRC)) {
      const src = code(text)
      for (const re of banned) if (re.test(src)) offenders.push(`${file}: ${re}`)
    }
    expect(offenders).toEqual([])
  })

  it('never reads a monetary column out of a JSON number', () => {
    // Money crosses a JSON boundary as a string or a bigint. A `Number(...)` around a value named
    // `minor`/`amount` means precision was already lost, which is EC-FX-5.
    const offenders: string[] = []
    for (const { file, text } of sourceFiles(SRC)) {
      const src = code(text)
      if (/\bNumber\s*\(\s*[\w$.]*(minor|amount|cap|price|total)[\w$.]*\s*\)/i.test(src)) {
        offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })
})
