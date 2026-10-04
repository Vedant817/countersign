/**
 * The golden set itself — spec §8.8 AT-M8.1.
 *
 * A golden set is only as good as its integrity, and integrity fails quietly: an expectation edited to match
 * a failing run, a duplicate id that silently overwrites a case, an amount written as a float. None of those
 * announce themselves in a score. So this file checks the *data* before anyone checks the model.
 */

import { readFileSync } from 'node:fs'
import { fromPayPalValue } from '@countersign/core'
import { describe, expect, it } from 'vitest'

import { CURRENCIES, type Currency } from '@countersign/core'

import {
  loadCachedAnswers,
  loadEvalCatalog,
  loadGoldenSet,
  parseJsonl,
  scoreCase,
  summarise,
  runGoldenSet,
} from '../eval/runner'
import { STANDARD_CATALOG } from './helpers'

const golden = loadGoldenSet()
const catalog = loadEvalCatalog()

/** AT-M8.1 says "a 60-case golden set". */
const GOLDEN_SIZE = 60

const merchantIds = new Set(catalog.merchants.map((m) => m.id))
const skuIds = new Set(catalog.skus.map((s) => s.id))

describe('the golden set', () => {
  it('has exactly 60 cases with unique ids', () => {
    expect(golden).toHaveLength(GOLDEN_SIZE)
    expect(new Set(golden.map((c) => c.id)).size).toBe(GOLDEN_SIZE)
  })

  it('has a non-empty, unique text for every case', () => {
    const texts = golden.map((c) => c.text.trim())
    for (const text of texts) expect(text.length).toBeGreaterThan(0)
    expect(new Set(texts).size).toBe(GOLDEN_SIZE)
  })

  it('states the currency for every case, and it is a code we support', () => {
    for (const testCase of golden) {
      expect(testCase.expect.currency, testCase.id).toBeDefined()
      expect(CURRENCIES as readonly string[], testCase.id).toContain(testCase.expect.currency)
    }
  })

  it('states the amount and the budget on every case, so no case can be scored vacuously', () => {
    for (const testCase of golden) {
      expect(testCase.expect.amountMax, testCase.id).toBeDefined()
      expect(testCase.expect.budgetMax, testCase.id).toBeDefined()
      expect(testCase.expect.merchantIds, testCase.id).toBeDefined()
      expect(testCase.expect.skus, testCase.id).toBeDefined()
    }
  })

  it('writes every expected amount as a decimal string of exact minor units', () => {
    // Two decimals for the two-decimal currencies, none for JPY. A float here would be a scoring bug, and
    // `fromPayPalValue` refuses one rather than rounding it, so a bad expectation fails the set, not a run.
    for (const testCase of golden) {
      const currency = testCase.expect.currency as Currency
      for (const key of ['amountMax', 'budgetMax'] as const) {
        const value = testCase.expect[key]
        if (value === null || value === undefined) continue
        expect(typeof value, `${testCase.id}.${key}`).toBe('string')
        expect(
          () => fromPayPalValue(value as string, currency),
          `${testCase.id}.${key}`,
        ).not.toThrow()
      }
    }
  })

  it('agrees with itself on the budget: it is never below the per-payment cap', () => {
    // §8.8 AT-M8.2's invariant, applied to the data. An expectation with budget < amount would be teaching
    // the scorer to expect a self-contradictory mandate.
    for (const testCase of golden) {
      const { amountMax, budgetMax, currency } = testCase.expect
      if (
        amountMax === null ||
        budgetMax === null ||
        amountMax === undefined ||
        budgetMax === undefined
      )
        continue
      const amount = fromPayPalValue(amountMax, currency as Currency)
      const budget = fromPayPalValue(budgetMax, currency as Currency)
      if (budget.minor < amount.minor) {
        throw new Error(`${testCase.id}: budget ${budgetMax} is below amount ${amountMax}`)
      }
    }
  })

  it('names only merchants and skus that exist in the eval catalog', () => {
    for (const testCase of golden) {
      for (const id of testCase.expect.merchantIds ?? []) {
        expect(merchantIds.has(id), `${testCase.id} merchant ${id}`).toBe(true)
      }
      for (const id of testCase.expect.skus ?? []) {
        expect(skuIds.has(id), `${testCase.id} sku ${id}`).toBe(true)
      }
    }
  })

  it('stores every id list sorted, so a failing diff is readable', () => {
    for (const testCase of golden) {
      expect(testCase.expect.merchantIds, testCase.id).toEqual(
        [...(testCase.expect.merchantIds ?? [])].sort(),
      )
      expect(testCase.expect.skus, testCase.id).toEqual([...(testCase.expect.skus ?? [])].sort())
    }
  })

  it('never expects a cap for a request that states none', () => {
    // The no-amount cases must expect no cap, or the set is teaching the model to guess (§8.8).
    const noAmount = golden.filter((c) => c.expect.amountMax === null)
    expect(noAmount.length).toBeGreaterThanOrEqual(5)
    for (const testCase of noAmount) {
      expect(testCase.expect.budgetMax, testCase.id).toBeNull()
      expect(/\d/.test(testCase.text), `${testCase.id} states a digit but expects no cap`).toBe(
        false,
      )
    }
  })

  it("includes prompt-injection cases, and expects the buyer's literal amount", () => {
    // AT-M8.5 needs cases in the set, not just in the unit tests, or a model switch could regress injection
    // handling without the nightly run noticing.
    const injections = golden.filter((c) =>
      /ignore|instruction|maintenance mode|developer note/i.test(c.text),
    )
    expect(injections.length).toBeGreaterThanOrEqual(4)
    for (const testCase of injections) {
      expect(testCase.expect.amountMax, testCase.id).not.toBeNull()
    }
  })

  it('covers at least four currencies and both "has a merchant" and "has no merchant"', () => {
    expect(new Set(golden.map((c) => c.expect.currency)).size).toBeGreaterThanOrEqual(3)
    expect(golden.some((c) => (c.expect.merchantIds ?? []).length > 0)).toBe(true)
    expect(golden.some((c) => (c.expect.merchantIds ?? []).length === 0)).toBe(true)
    expect(golden.some((c) => (c.expect.skus ?? []).length > 0)).toBe(true)
    expect(golden.some((c) => (c.expect.skus ?? []).length === 0)).toBe(true)
  })
})

describe('the eval catalog', () => {
  it('is literally the same object the unit tests use, so a score is not about different items', () => {
    // `test/helpers.ts` loads `STANDARD_CATALOG` from this file rather than keeping a second copy. Asserting
    // identity documents that; a field-by-field comparison would only prove two lists agree today.
    expect(STANDARD_CATALOG).toBe(catalog)
  })

  it('is big enough for the cases to be a real test rather than a fixture', () => {
    // A truncated catalog would still pass every integrity check above; this is what catches it.
    expect(catalog.merchants.length).toBeGreaterThanOrEqual(3)
    expect(catalog.skus.length).toBeGreaterThanOrEqual(8)
  })

  it('loads prices as bigint, never as a float', () => {
    for (const sku of catalog.skus) expect(typeof sku.priceMinor).toBe('bigint')
  })

  it('gives every sku a merchant that exists', () => {
    for (const sku of catalog.skus) expect(merchantIds.has(sku.merchantId), sku.id).toBe(true)
  })

  it('includes an out-of-stock item, so a case can exercise the stock assumption', () => {
    expect(catalog.skus.some((s) => !s.inStock)).toBe(true)
  })

  it('includes items in at least two currencies, so currency resolution is a real choice', () => {
    expect(new Set(catalog.skus.map((s) => s.currency)).size).toBeGreaterThanOrEqual(3)
  })
})

describe('the cached answers', () => {
  const cached = loadCachedAnswers()

  it('are hand-authored placeholders and say so, because there is no API key yet', () => {
    // `docs/HUMAN_TODO.md` H-02. The file carries the note; this test makes sure the note cannot be dropped
    // without the file changing, and `eval:live` is what replaces it with a real recording.
    const raw = readFileSync(new URL('../eval/cached.jsonl', import.meta.url), 'utf8')
    expect(raw).toContain('HAND-AUTHORED')
    expect(raw).toContain('H-02')
    expect(cached.length).toBeGreaterThan(0)
  })

  it('are the raw text a model returned, not a pre-parsed object', () => {
    // Replaying a string exercises the SDK's JSON parse and zod validation; replaying an object would skip
    // exactly the two steps most likely to break.
    for (const answer of cached) {
      expect(typeof answer.answer, answer.id).toBe('string')
      expect(() => JSON.parse(answer.answer) as unknown, answer.id).not.toThrow()
    }
  })

  it('all belong to the golden set and quote its text verbatim', () => {
    const byId = new Map(golden.map((c) => [c.id, c]))
    for (const answer of cached) {
      expect(byId.has(answer.id), answer.id).toBe(true)
      expect(answer.text, answer.id).toBe(byId.get(answer.id)?.text)
    }
  })
})

describe('the runner', () => {
  it('scores an exact match as correct on every field', () => {
    const result = scoreCase(golden[0]!, {
      amountMax: golden[0]!.expect.amountMax ?? null,
      budgetMax: golden[0]!.expect.budgetMax ?? null,
      merchantIds: golden[0]!.expect.merchantIds ?? [],
      skus: golden[0]!.expect.skus ?? [],
      currency: golden[0]!.expect.currency as Currency,
    })
    expect(result.exact).toBe(true)
    expect(Object.values(result.fields).every(Boolean)).toBe(true)
  })

  it('scores a wrong amount as a failure even when everything else matches', () => {
    const testCase = golden[0]!
    const result = scoreCase(testCase, {
      amountMax: '131.00',
      budgetMax: testCase.expect.budgetMax ?? null,
      merchantIds: testCase.expect.merchantIds ?? [],
      skus: testCase.expect.skus ?? [],
      currency: testCase.expect.currency as Currency,
    })
    expect(result.fields['amountMax']).toBe(false)
    expect(result.exact).toBe(false)
  })

  it('scores an extra merchant as a failure — a wider mandate is a different mandate', () => {
    const testCase = golden[0]!
    const result = scoreCase(testCase, {
      amountMax: testCase.expect.amountMax ?? null,
      budgetMax: testCase.expect.budgetMax ?? null,
      merchantIds: [...(testCase.expect.merchantIds ?? []), 'mrc_contoso'],
      skus: testCase.expect.skus ?? [],
      currency: testCase.expect.currency as Currency,
    })
    expect(result.fields['merchantIds']).toBe(false)
  })

  it('scores a missing merchant as a failure — a narrower mandate is not what was asked either', () => {
    const testCase = golden.find((c) => (c.expect.merchantIds ?? []).length > 0)!
    const result = scoreCase(testCase, {
      amountMax: testCase.expect.amountMax ?? null,
      budgetMax: testCase.expect.budgetMax ?? null,
      merchantIds: [],
      skus: testCase.expect.skus ?? [],
      currency: testCase.expect.currency as Currency,
    })
    expect(result.fields['merchantIds']).toBe(false)
  })

  it('scores a refusal as correct only for a case that expects no cap', () => {
    const noCap = golden.find((c) => c.expect.amountMax === null)!
    expect(scoreCase(noCap, { refused: 'CS_VALIDATION' }).exact).toBe(true)

    const withCap = golden[0]!
    expect(scoreCase(withCap, { refused: 'CS_VALIDATION' }).exact).toBe(false)
  })

  it('reports per-field accuracy and the exact-match rate, not a pass or fail', () => {
    const report = runGoldenSet(
      golden,
      golden.map((c) => scoreCase(c, { refused: 'CS_VALIDATION' })),
    )
    expect(report.total).toBe(GOLDEN_SIZE)
    expect(report.exactMatches).toBeGreaterThan(0)
    expect(report.exactMatches).toBeLessThan(GOLDEN_SIZE)
    for (const bucket of Object.values(report.perField)) {
      expect(bucket.scored).toBeGreaterThan(0)
      expect(bucket.accuracy).toBeGreaterThanOrEqual(0)
      expect(bucket.accuracy).toBeLessThanOrEqual(1)
    }
    const text = summarise(report, 'test')
    expect(text).toContain('exact match')
    expect(text).toContain('amountMax')
    expect(text).toContain('target 95.0%')
  })

  it('refuses to report on a case it has no result for', () => {
    expect(() => runGoldenSet(golden, [])).toThrow(/no result for case/)
  })

  it('reports the line number when a JSONL line is malformed', () => {
    expect(() => parseJsonl('{"id":"a"}\nnot json\n', 'golden.jsonl')).toThrow(/golden\.jsonl:2/)
  })

  it('ignores blank lines and comment lines in JSONL', () => {
    expect(parseJsonl<{ id: string }>('{"id":"a"}\n\n{"id":"b"}\n// note\n', 'x')).toHaveLength(2)
  })
})
