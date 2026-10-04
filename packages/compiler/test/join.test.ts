/**
 * List-joining in the strings a user is asked to sign.
 *
 * `joinWithOr` and `joinWithAnd` are trivial, which is exactly why they need pinning: both exist to
 * prevent a bare `Array#join(' and ')`, and a bare join is the kind of slip that survives review
 * because it type-checks, passes every test, and renders as "USD and INR and GBP".
 *
 * That particular string appears in the ambiguity question that **blocks a user from signing**, so it
 * is the last place in the product where a grammatical wobble is cheapest to avoid and most visible.
 */
import { describe, expect, it } from 'vitest'

import { joinWithAnd, joinWithOr } from '../src/readback'
import { currencyAmbiguity } from '../src/ambiguity'

describe('joinWithOr — a list the reader chooses between', () => {
  it('renders 0, 1, 2 and many items', () => {
    expect(joinWithOr([])).toBe('')
    expect(joinWithOr(['Trail Runner'])).toBe('Trail Runner')
    expect(joinWithOr(['Trail Runner', 'Alpine Boot'])).toBe('Trail Runner or Alpine Boot')
    expect(joinWithOr(['A', 'B', 'C'])).toBe('A, B or C')
    expect(joinWithOr(['A', 'B', 'C', 'D'])).toBe('A, B, C or D')
  })

  it('never produces a bare "X or Y or Z"', () => {
    for (const n of [2, 3, 4, 5, 6]) {
      const items = Array.from({ length: n }, (_, i) => `X${i}`)
      // Exactly one "or" — the last item is the alternative, everything before it is a list.
      expect(joinWithOr(items).split(' or ').length).toBe(2)
    }
    // A single item has no alternative to offer, so no "or" at all.
    expect(joinWithOr(['X0']).split(' or ').length).toBe(1)
  })
})

describe('joinWithAnd — a list the reader must take together', () => {
  it('renders 0, 1, 2 and many items', () => {
    expect(joinWithAnd([])).toBe('')
    expect(joinWithAnd(['USD'])).toBe('USD')
    expect(joinWithAnd(['USD', 'INR'])).toBe('USD and INR')
    // The bug this function exists for: a bare join gives "USD and INR and GBP".
    expect(joinWithAnd(['USD', 'INR', 'GBP'])).toBe('USD, INR and GBP')
    expect(joinWithAnd(['A', 'B', 'C', 'D'])).toBe('A, B, C and D')
  })

  it('uses exactly one "and" however long the list', () => {
    for (const n of [2, 3, 4, 5, 6, 7]) {
      const items = Array.from({ length: n }, (_, i) => `X${i}`)
      expect(joinWithAnd(items).split(' and ').length).toBe(2)
    }
    // A single item needs no conjunction.
    expect(joinWithAnd(['X0']).split(' and ').length).toBe(1)
  })

  it('appears in the currency ambiguity question, so the wobble is pinned where it shows', () => {
    const three = currencyAmbiguity(['USD', 'INR', 'GBP'])
    expect(three.question).toBe(
      'You mentioned more than one currency (USD, INR and GBP). Which one is the limit in?',
    )
    expect(three.question).not.toContain('and GBP and')
    expect(three.question).not.toMatch(/ and .* and /)

    const two = currencyAmbiguity(['USD', 'INR'])
    expect(two.question).toContain('(USD and INR)')

    const one = currencyAmbiguity(['USD'])
    expect(one.question).toContain('(USD)')
  })

  it('de-duplicates the options, because "USD and USD" is not a question', () => {
    const a = currencyAmbiguity(['USD', 'INR', 'USD'])
    expect(a.options).toEqual(['USD', 'INR'])
  })
})