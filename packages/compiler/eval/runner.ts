/**
 * The compiler golden set and its runner — spec **§8.8 AT-M8.1**.
 *
 * ## What is scored, and why exactly these fields
 *
 * AT-M8.1: "A 60-case golden set scores ≥ 95% exact match on **amount, merchant and SKU** fields with
 * `gpt-6.1-sol`." Those three, plus the currency and the budget cap the spec's own AT-M8.2 depends on.
 *
 * The score is **exact match per field**, not a similarity. A run that returns the right *store* and the
 * wrong *number* is a failure, because the failure that matters in this product is a cap that is close
 * enough to look right and is not. Fields the case does not care about are omitted from `expect` and
 * excluded from the denominator, so a case about amounts cannot be failed by a merchant guess.
 *
 * ## Why amounts are compared as decimal strings
 *
 * `expect.amountMax` is `"130.00"`, not `13000`. Comparing a model's `"130.00"` against a stored integer
 * would put a unit conversion inside the scorer, and a unit conversion inside a metric is exactly how a
 * money bug becomes a passing eval. The compiler emits `toPayPalValue` strings (`proposal.ts`,
 * `scoredFieldsOf`), so the scorer compares strings and never does arithmetic.
 *
 * ## Two runners, because there is no API key yet (`docs/HUMAN_TODO.md` H-02)
 *
 * - {@link runGoldenSet} is pure: cases in, scores out. It knows nothing about models or files, so both
 *   runners share it and neither can drift from the other.
 * - **`eval:ci`** replays a committed cache of ten recorded model answers through the **real** `compile`
 *   pipeline — real `generateText`, real zod, real validation, no network. It gates the pipeline: a change
 *   that breaks localisation, the AT-M8.5 ceiling or the ambiguity rule fails the PR.
 * - **`eval:live`** calls `LLM_MAIN_MODEL` over all sixty cases and needs `OPENAI_API_KEY`. It gates the
 *   model: it is the number AT-M8.1 actually asks for.
 *
 * The cached subset does **not** measure the model, and the runner says so in its own output
 * (`source: 'cache'`). Claiming a cached score as a model score would be the dishonest kind of green.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { fromPayPalValue, isCurrency, type Currency } from '@countersign/core'

import type { CatalogProjection, ScoredFields } from '../src/index'

export type { ScoredFields }

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The fields AT-M8.1 scores. Every one is optional, so a case states only what it is about. */
export interface GoldenExpectation {
  /** Decimal string, e.g. `"130.00"`, or `null` for "the request states no cap". */
  readonly amountMax?: string | null
  /** Decimal string for the cumulative cap. Absent = not scored. */
  readonly budgetMax?: string | null
  /** Sorted merchant ids. */
  readonly merchantIds?: string[]
  /** Sorted sku ids. */
  readonly skus?: string[]
  /** ISO-4217 code. */
  readonly currency?: Currency
}

export interface GoldenCase {
  readonly id: string
  readonly text: string
  readonly expect: GoldenExpectation
}

/** One case's outcome. */
export interface CaseResult {
  readonly id: string
  readonly text: string
  /** The compiled mandate's scored fields, or the reason it could not be compiled. */
  readonly got: ScoredFields | { readonly refused: string }
  readonly fields: Readonly<Record<string, boolean>>
  readonly exact: boolean
}

export interface ScoreReport {
  readonly total: number
  readonly exactMatches: number
  /** Per-field accuracy over the cases that stated that field. */
  readonly perField: Readonly<Record<string, { correct: number; scored: number; accuracy: number }>>
  readonly cases: readonly CaseResult[]
}

/** The threshold AT-M8.1 sets, as a fraction. */
export const TARGET_EXACT_MATCH = 0.95

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Parse a JSONL file into `T[]`, skipping blank lines, with the line number in any error. */
export function parseJsonl<T>(text: string, label: string): T[] {
  const out: T[] = []
  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('//')) return
    try {
      out.push(JSON.parse(trimmed) as T)
    } catch (cause) {
      throw new Error(`${label}:${index + 1} is not valid JSON: ${(cause as Error).message}`)
    }
  })
  return out
}

const evalDir = fileURLToPath(new URL('.', import.meta.url))

/** The 60-case golden set. */
export function loadGoldenSet(): GoldenCase[] {
  return parseJsonl<GoldenCase>(readFileSync(`${evalDir}golden.jsonl`, 'utf8'), 'golden.jsonl')
}

/**
 * The committed cache of recorded model answers.
 *
 * Each entry keeps **the raw text a model returned**, verbatim, so the replay exercises the real
 * `generateText` → `Output.object` → zod path rather than a pre-parsed object. `text`, `currency` and
 * `merchantIds` are duplicated from the golden case so the recording can be checked for drift on its own:
 * if a golden case's text is edited and its recording is not, the eval is scoring a different question and
 * says so in a test instead of quietly reporting a number.
 *
 * A `_comment` line without an `id` is documentation and is skipped, so the honesty note above travels with
 * the data it qualifies.
 */
export interface CachedAnswer {
  readonly id: string
  readonly text: string
  readonly answer: string
  readonly currency?: Currency
  readonly merchantIds?: string[]
}

export function loadCachedAnswers(): CachedAnswer[] {
  const all = parseJsonl<Partial<CachedAnswer> & { _comment?: string }>(
    readFileSync(`${evalDir}cached.jsonl`, 'utf8'),
    'cached.jsonl',
  )
  const answers = all.filter(
    (a): a is CachedAnswer => typeof a.id === 'string' && typeof a.answer === 'string',
  )
  if (answers.length === 0) throw new Error('cached.jsonl has no usable answers')
  return answers
}

/**
 * Load the eval catalog, turning integer minor units into `bigint`.
 *
 * `BigInt(n)`, never `Number(n)`: the JSON number is the boundary, and a price that had lost precision on
 * the way in would be a wrong price in a catalog the compiler reasons about.
 *
 * Memoised. The file is committed and immutable within a process, and the unit tests and the eval must be
 * looking at the *same* catalog object — a deep-equal comparison would only prove the two parses agree
 * today, while identity proves they are one thing.
 */
let cachedCatalog: CatalogProjection | null = null

export function loadEvalCatalog(): CatalogProjection {
  if (cachedCatalog !== null) return cachedCatalog
  const raw = JSON.parse(readFileSync(`${evalDir}catalog.json`, 'utf8')) as {
    merchants: CatalogProjection['merchants']
    skus: Array<Omit<CatalogProjection['skus'][number], 'priceMinor'> & { priceMinor: number }>
  }
  cachedCatalog = {
    merchants: raw.merchants,
    skus: raw.skus.map((s) => {
      if (!isCurrency(s.currency))
        throw new Error(`catalog.json: ${s.id} has an unsupported currency`)
      return { ...s, priceMinor: BigInt(s.priceMinor) }
    }),
  }
  return cachedCatalog
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/** Sort a copy: the golden set stores ids sorted so a diff of a failure is readable. */
function sorted(values: readonly string[]): string[] {
  return [...values].sort()
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = sorted(a)
  const right = sorted(b)
  return left.length === right.length && left.every((v, i) => v === right[i])
}

/**
 * Compare one case.
 *
 * ### How a refusal is scored, and why
 *
 * A **refusal** is a legitimate outcome, and treating it as a miss would make the metric lie in the
 * compiler's favour: every time the pipeline correctly refused to invent a limit, the score would drop.
 * §8.8 makes refusing the *specified* behaviour for an unresolvable intent, and the AT-M8.5 ceiling makes it
 * the specified behaviour for a cap the buyer's words do not support.
 *
 * So a refusal is judged only on what a refusal can decide: **whether the case expected no cap at all.** A
 * case whose `amountMax` is `null` is satisfied by a refusal and every other field is left unscored rather
 * than counted as wrong — there is no mandate to read a currency or a merchant list from. A case that *does*
 * state an amount is failed by a refusal, and the report prints `refused` with the reason so the failure is
 * legible rather than a bare number.
 *
 * A case that states neither an amount nor a budget scores a refusal as a **failure**: with nothing to
 * check, "the compiler declined" cannot be called correct.
 */
export function scoreCase(
  testCase: GoldenCase,
  got: ScoredFields | { readonly refused: string },
): CaseResult {
  const fields: Record<string, boolean> = {}

  if ('refused' in got) {
    const checksCap =
      testCase.expect.amountMax !== undefined || testCase.expect.budgetMax !== undefined
    if (!checksCap) return { id: testCase.id, text: testCase.text, got, fields, exact: false }
    if (testCase.expect.amountMax !== undefined) {
      fields['amountMax'] = testCase.expect.amountMax === null
    }
    if (testCase.expect.budgetMax !== undefined) {
      fields['budgetMax'] = testCase.expect.budgetMax === null
    }
    return {
      id: testCase.id,
      text: testCase.text,
      got,
      fields,
      exact: Object.values(fields).every(Boolean),
    }
  }

  if (testCase.expect.amountMax !== undefined) {
    fields['amountMax'] =
      testCase.expect.amountMax === null
        ? got.amountMax === null
        : got.amountMax === testCase.expect.amountMax
  }
  if (testCase.expect.budgetMax !== undefined) {
    fields['budgetMax'] =
      testCase.expect.budgetMax === null
        ? got.budgetMax === null
        : got.budgetMax === testCase.expect.budgetMax
  }
  if (testCase.expect.merchantIds !== undefined) {
    fields['merchantIds'] = sameSet(got.merchantIds, testCase.expect.merchantIds)
  }
  if (testCase.expect.skus !== undefined) {
    fields['skus'] = sameSet(got.skus, testCase.expect.skus)
  }
  if (testCase.expect.currency !== undefined) {
    fields['currency'] = got.currency === testCase.expect.currency
  }

  return {
    id: testCase.id,
    text: testCase.text,
    got,
    fields,
    exact: Object.values(fields).every(Boolean),
  }
}

/** Score a whole run. `cases` and `results` are matched by `id`, not by position. */
export function runGoldenSet(
  cases: readonly GoldenCase[],
  results: readonly CaseResult[],
): ScoreReport {
  const byId = new Map(results.map((r) => [r.id, r]))
  const perField: Record<string, { correct: number; scored: number; accuracy: number }> = {}
  let exactMatches = 0
  let total = 0

  for (const testCase of cases) {
    const result = byId.get(testCase.id)
    if (result === undefined) throw new Error(`no result for case ${testCase.id}`)
    total += 1
    if (result.exact) exactMatches += 1
    for (const [field, ok] of Object.entries(result.fields)) {
      const bucket = perField[field] ?? { correct: 0, scored: 0, accuracy: 0 }
      bucket.scored += 1
      if (ok) bucket.correct += 1
      bucket.accuracy = bucket.correct / bucket.scored
      perField[field] = bucket
    }
  }

  return { total, exactMatches, perField, cases: [...byId.values()] }
}

/** A one-line summary, used by both runners and by the CI test's failure message. */
export function summarise(report: ScoreReport, source: string): string {
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`
  const lines = [
    `compiler golden set (${source}): ${report.exactMatches}/${report.total} exact match ` +
      `(${pct(report.total === 0 ? 0 : report.exactMatches / report.total)}), target ${pct(TARGET_EXACT_MATCH)}`,
  ]
  for (const field of Object.keys(report.perField).sort()) {
    const b = report.perField[field]!
    lines.push(
      `  ${field.padEnd(12)} ${String(b.correct).padStart(3)}/${String(b.scored).padEnd(3)} ${pct(b.accuracy)}`,
    )
  }
  const failures = report.cases.filter((c) => !c.exact)
  for (const f of failures) {
    lines.push(`  FAIL ${f.id} ${JSON.stringify(f.text)}`)
    lines.push(`       fields ${JSON.stringify(f.fields)}`)
    lines.push(
      `       got    ${'refused' in f.got ? JSON.stringify(f.got) : JSON.stringify(f.got)}`,
    )
  }
  return lines.join('\n')
}

/** Parse a decimal string into the exact minor units, for a golden set that states integers. */
export function minorOf(decimal: string, currency: Currency): bigint {
  return fromPayPalValue(decimal, currency).minor
}
