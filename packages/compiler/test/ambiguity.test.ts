/**
 * Ambiguities — spec §8.8: "An unresolvable intent (no amount cap) MUST produce an ambiguity, not a guess."
 *
 * The predicate is one line, so the tests here are about the two things that actually carry risk: that a
 * question is raised exactly when it should be, and that **the options a buyer can tap are numbers the
 * compiler would have signed anyway**. That second property is the whole reason `capOptions` is built from
 * the catalog rather than from the model — a prompt injection in a product description must not be able to
 * put a "$5,000" button under someone's thumb.
 */

import { describe, expect, it } from 'vitest'

import {
  AMOUNT_CAP_FIELD,
  CURRENCY_FIELD,
  amountCapAmbiguity,
  capCandidatesFor,
  capOptions,
  currencyAmbiguity,
  hasBlockingAmbiguities,
  mergeAmbiguities,
  type Ambiguity,
} from '../src/index'
import { NORTHWIND, STANDARD_CATALOG } from './helpers'

const question = (currency: Parameters<typeof amountCapAmbiguity>[0]['currency']): Ambiguity =>
  amountCapAmbiguity({ currency, candidates: [] })

describe('hasBlockingAmbiguities — the one predicate §8.8 hands the UI', () => {
  it('is false only when there is genuinely nothing to ask', () => {
    expect(hasBlockingAmbiguities({ ambiguities: [] })).toBe(false)
  })

  it('is true for one open question, however small', () => {
    expect(hasBlockingAmbiguities({ ambiguities: [question('USD')] })).toBe(true)
  })

  it('counts an empty option list as still open — a free-text answer is an answer', () => {
    expect(hasBlockingAmbiguities({ ambiguities: [question('USD')] })).toBe(true)
  })

  it('reads nothing but the array, so it cannot drift from the rule it gates', () => {
    const compiled = { ambiguities: [] as Ambiguity[] } as unknown as Parameters<typeof hasBlockingAmbiguities>[0]
    expect(hasBlockingAmbiguities(compiled)).toBe(false)
  })
})

describe('amountCapAmbiguity', () => {
  it('names the field the UI keys its form on', () => {
    expect(question('USD').field).toBe(AMOUNT_CAP_FIELD)
  })

  it('says what is missing in the second person, and names the currency', () => {
    const a = question('INR')
    expect(a.question).toContain('You did not say how much')
    expect(a.question).toContain('INR')
    expect(a.question.endsWith('?')).toBe(true)
  })

  it('offers no options when there is nothing honest to offer', () => {
    // There is no price to derive a number from, and inventing a round one would be the compiler guessing.
    expect(question('USD').options).toEqual([])
  })
})

describe('capOptions', () => {
  const usd = (minor: bigint) => ({ minor, currency: 'USD' as const })

  it('rounds UP to a whole unit, never down, so no offered cap makes an item unboughtable', () => {
    // $129.99 and $89.99 are the two real prices in the test catalog.
    expect(capOptions([usd(12999n)])).toEqual(['$130.00'])
    expect(capOptions([usd(8999n)])).toEqual(['$90.00'])
  })

  it('adds the next round number above, so a buyer has a comfortable choice', () => {
    // $18.50 sits between $19 and $20.
    expect(capOptions([usd(1850n)])).toEqual(['$19.00', '$20.00'])
  })

  it('is sorted ascending and deduplicated across candidates', () => {
    expect(capOptions([usd(12999n), usd(8999n), usd(12999n)])).toEqual(['$90.00', '$130.00'])
  })

  it('is empty for no candidates', () => {
    expect(capOptions([])).toEqual([])
  })

  it('handles a zero-decimal currency without inventing minor digits', () => {
    expect(capOptions([{ minor: 4200n, currency: 'JPY' }])).toEqual(['¥4,200'])
  })

  it('never offers "no limit"', () => {
    const options = capOptions([usd(12999n)]).join(' ').toLowerCase()
    expect(options).not.toContain('no limit')
    expect(options).not.toContain('unlimited')
  })

  it('is a pure function of its candidates', () => {
    const candidates = [usd(12999n), usd(8999n)]
    const first = capOptions(candidates)
    for (let i = 0; i < 20; i += 1) expect(capOptions(candidates)).toEqual(first)
  })

  it('ignores a candidate in another currency rather than mixing units', () => {
    expect(capOptions([usd(12999n), { minor: 34000n, currency: 'INR' }])).toEqual(['$130.00'])
  })
})

describe('capCandidatesFor', () => {
  it('uses the prices of the items the request actually named', () => {
    expect(capCandidatesFor(STANDARD_CATALOG, ['SKU-ALPINE-07'], 'USD')).toEqual([
      { minor: 8999n, currency: 'USD' },
    ])
  })

  it('excludes an out-of-stock item: offering a cap for something that cannot be bought is noise', () => {
    expect(capCandidatesFor(STANDARD_CATALOG, ['SKU-RAIN-11'], 'USD')).toEqual([])
  })

  it('excludes an item priced in another currency', () => {
    expect(capCandidatesFor(STANDARD_CATALOG, ['SKU-CHAI-9'], 'USD')).toEqual([])
    expect(capCandidatesFor(STANDARD_CATALOG, ['SKU-CHAI-9'], 'INR')).toEqual([
      { minor: 34000n, currency: 'INR' },
    ])
  })

  it('is empty for an item id that is not in the catalog', () => {
    expect(capCandidatesFor(STANDARD_CATALOG, ['SKU-GHOST'], 'USD')).toEqual([])
  })
})

describe('currencyAmbiguity', () => {
  it('is filed under its own field and lists exactly the currencies it found', () => {
    const a = currencyAmbiguity(['USD', 'EUR'])
    expect(a.field).toBe(CURRENCY_FIELD)
    expect(a.options).toEqual(['USD', 'EUR'])
    expect(a.question).toContain('USD and EUR')
  })
})

describe('mergeAmbiguities', () => {
  const modelOne: Ambiguity = { field: 'preferences.size', question: 'Which size?', options: ['S', 'M'] }
  const modelTwo: Ambiguity = { field: 'preferences.color', question: 'Which colour?', options: ['Slate'] }
  const required: Ambiguity = { field: AMOUNT_CAP_FIELD, question: 'How much?', options: [] }

  it('keeps both when the fields differ', () => {
    expect(mergeAmbiguities([required], [modelOne, modelTwo]).map((a) => a.field)).toEqual([
      'preferences.size',
      'preferences.color',
      'amount_range.max',
    ])
  })

  it('lets the compiler\'s own question win on a duplicate field', () => {
    // The attack this closes: a model-written question about `amount_range.max` carrying a "$1,000,000"
    // option. The required phrasing is the one whose options are known to be signable, so it must not be
    // displaced — while the field keeps the position the model gave it, so the order stays stable.
    const shadow: Ambiguity = {
      field: AMOUNT_CAP_FIELD,
      question: 'How much do you want to spend?',
      options: ['$1,000,000'],
    }
    const merged = mergeAmbiguities([required], [shadow, modelOne])
    expect(merged.map((a) => a.field)).toEqual([AMOUNT_CAP_FIELD, 'preferences.size'])
    expect(merged[0]?.question).toBe('How much?')
    expect(merged[0]?.options).toEqual([])
    expect(merged[1]?.question).toBe('Which size?')
  })

  it('deduplicates model questions about the same field', () => {
    const merged = mergeAmbiguities([], [modelOne, { ...modelOne, question: 'Size?' }])
    expect(merged).toHaveLength(1)
  })

  it('is a pure function, so a given request always produces the same question list', () => {
    const inputs = [[required], [modelOne]] as const
    const first = mergeAmbiguities([...inputs[0]], [...inputs[1]])
    expect(mergeAmbiguities([...inputs[0]], [...inputs[1]])).toEqual(first)
  })
})

describe('the question never leaks into the read-back', () => {
  it('the question text is not present in any compiled mandate', async () => {
    // A read-back that asks a question is an invitation to sign an incomplete mandate, so the two must stay
    // in separate channels. Asserted here as a property of the question builder rather than of `compile`.
    const a = amountCapAmbiguity({
      currency: 'USD',
      candidates: [{ minor: 12999n, currency: 'USD' }],
    })
    expect(a.question).not.toContain('$')
    expect(a.options).toEqual(['$130.00'])
  })

  it('the field name is stable, because the UI keys its form on it', () => {
    expect(AMOUNT_CAP_FIELD).toBe('amount_range.max')
    expect(CURRENCY_FIELD).toBe('currency')
  })

  it('the merchant ids the ambiguity is asked about come from the catalog projection', () => {
    expect(STANDARD_CATALOG.merchants.map((m) => m.id)).toContain(NORTHWIND.id)
  })
})
