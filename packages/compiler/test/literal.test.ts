/**
 * `literal.ts` — reading the buyer's own bytes.
 *
 * This module is where AT-M8.5's control actually lives, so it is tested against the awkward inputs rather
 * than the tidy ones: magnitude suffixes, thousands separators, ISO dates that look like amounts, product
 * ids that look like amounts, and the currency phrases whose ordering decides whose money it is.
 */

import { describe, expect, it } from 'vitest'

import { currenciesNamedIn, literalCapIn, mentionsRecurrence, resolveCurrency } from '../src/index'

describe('currenciesNamedIn', () => {
  it('finds a currency by name, by code and by symbol', () => {
    expect(currenciesNamedIn('under 130 dollars')).toEqual(['USD'])
    expect(currenciesNamedIn('under 130 USD')).toEqual(['USD'])
    expect(currenciesNamedIn('under $130')).toEqual(['USD'])
    expect(currenciesNamedIn('under 100 rupees')).toEqual(['INR'])
    expect(currenciesNamedIn('under ₹100')).toEqual(['INR'])
    expect(currenciesNamedIn('under 100 euros')).toEqual(['EUR'])
    expect(currenciesNamedIn('under £100')).toEqual(['GBP'])
    expect(currenciesNamedIn('under 100 yen')).toEqual(['JPY'])
  })

  it('is case-insensitive, because people write "usd"', () => {
    expect(currenciesNamedIn('max 50 Usd')).toEqual(['USD'])
  })

  it('tests the specific phrase before the generic one, or every Australian gets a US mandate', () => {
    expect(currenciesNamedIn('200 australian dollars')).toEqual(['AUD'])
    expect(currenciesNamedIn('A$200')).toEqual(['AUD'])
    expect(currenciesNamedIn('200 canadian dollars')).toEqual(['CAD'])
    expect(currenciesNamedIn('C$200')).toEqual(['CAD'])
    expect(currenciesNamedIn('200 us dollars')).toEqual(['USD'])
    expect(currenciesNamedIn('US$200')).toEqual(['USD'])
  })

  it('reports two currencies as two, so resolveCurrency can refuse rather than pick', () => {
    expect(currenciesNamedIn('130 dollars or 100 euros').sort()).toEqual(['EUR', 'USD'])
  })

  it('reports none when none is named', () => {
    expect(currenciesNamedIn('buy some shoes')).toEqual([])
  })

  it('is stable across repeated calls, because the patterns are not stateful', () => {
    // A `g`-flagged RegExp used with `.test()` alternates between hits and misses. This would catch it.
    for (let i = 0; i < 5; i += 1) expect(currenciesNamedIn('under 130 dollars')).toEqual(['USD'])
  })
})

describe('resolveCurrency', () => {
  const args = (text: string, catalogCurrencies: string[] = []): Parameters<typeof resolveCurrency>[0] => ({
    text,
    defaultCurrency: 'USD',
    catalogCurrencies: catalogCurrencies as Parameters<typeof resolveCurrency>[0]['catalogCurrencies'],
  })

  it('what the buyer wrote beats the account default', () => {
    const r = resolveCurrency(args('under 500 rupees', ['USD']))
    expect(r).toEqual({ ok: true, currency: 'INR', assumptions: [] })
  })

  it('refuses two currencies rather than choosing one (EC-FX-1)', () => {
    const r = resolveCurrency(args('130 dollars or 100 euros'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.named.sort()).toEqual(['EUR', 'USD'])
  })

  it('assumes the catalog currency, and says so, when the buyer named none', () => {
    const r = resolveCurrency(args('buy some shoes', ['INR']))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.currency).toBe('INR')
    expect(r.assumptions[0]).toBe('Assumed INR because every item in the store you chose is priced in INR.')
  })

  it('falls back to the account default, and says so, when the catalog is multi-currency', () => {
    const r = resolveCurrency(args('buy some shoes', ['USD', 'INR']))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.currency).toBe('USD')
    expect(r.assumptions[0]).toContain('USD and INR')
  })

  it('falls back to the account default, and says so, when the catalog is empty', () => {
    const r = resolveCurrency(args('buy some shoes', []))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.currency).toBe('USD')
    expect(r.assumptions[0]).toBe('Assumed USD because you did not name a currency.')
  })
})

describe('literalCapIn — money the buyer actually wrote', () => {
  it('reads a plain decimal, in integer minor units', () => {
    expect(literalCapIn('Under 130 dollars', 'USD')).toBe(13_000n)
    expect(literalCapIn('no more than 129.99', 'USD')).toBe(12_999n)
    expect(literalCapIn('keep it to $45.50', 'USD')).toBe(4550n)
  })

  it('reads a magnitude suffix as a multiplier', () => {
    expect(literalCapIn('max $1M', 'USD')).toBe(100_000_000n)
    expect(literalCapIn('max $1.5M', 'USD')).toBe(150_000_000n)
    expect(literalCapIn('under 5k', 'USD')).toBe(500_000n)
    expect(literalCapIn('under 5K', 'USD')).toBe(500_000n)
    // Two billion dollars is two hundred billion cents. The arithmetic is exact, not rounded, which is the
    // only thing that matters here — the number is absurd as a spending cap and the ceiling still holds.
    expect(literalCapIn('up to 2B', 'USD')).toBe(200_000_000_000n)
  })

  it('does not read a unit that merely starts with a magnitude letter as a suffix', () => {
    // "2kg" is a weight, not a cap: `k` is refused as a suffix because `g` follows, and then `2` is refused
    // because it is glued to a word. Null is the honest answer, and it is what makes the no-cap refusal fire.
    expect(literalCapIn('the 2kg bag', 'USD')).toBeNull()
  })

  it('strips thousands separators', () => {
    expect(literalCapIn('under $1,000,000', 'USD')).toBe(100_000_000n)
    expect(literalCapIn('under 12,500 dollars', 'USD')).toBe(1_250_000n)
  })

  it('works in the mandate currency, not in the currency the symbol suggests', () => {
    // `$` resolves to USD, but the *value* is parsed in whatever currency the mandate is denominated in.
    // JPY has no minor unit, so "500" is five hundred yen and "$500" in a JPY mandate is five hundred yen.
    expect(literalCapIn('500', 'JPY')).toBe(500n)
    expect(literalCapIn('500', 'USD')).toBe(50_000n)
  })

  it('takes the largest money-denominated amount, not the first', () => {
    expect(literalCapIn('up to $80 a month, capped at $600 for the year', 'USD')).toBe(60_000n)
  })

  it('falls back to bare numbers when no currency is written anywhere', () => {
    expect(literalCapIn('buy 2 pairs, at most 40', 'USD')).toBe(4000n)
  })

  it('does not read an ISO date as an amount', () => {
    expect(literalCapIn('from 2026-10-01 to 2027-10-01', 'USD')).toBeNull()
  })

  it('does not read a year as an amount', () => {
    expect(literalCapIn('in 2027', 'USD')).toBeNull()
  })

  it('does not read a product id as an amount', () => {
    expect(literalCapIn('get SKU-TRAIL-42', 'USD')).toBeNull()
    expect(literalCapIn('the ISO-4217 table', 'USD')).toBeNull()
  })

  it('prefers money-denominated amounts, so a year cannot raise the ceiling', () => {
    expect(literalCapIn('in 2027, but under $130', 'USD')).toBe(13_000n)
    expect(literalCapIn('starting 2026-10-01, under 130 dollars', 'USD')).toBe(13_000n)
  })

  it('skips an amount it cannot read exactly rather than rounding it (EC-FX-5)', () => {
    // Three decimals in USD is CS_ROUNDING in core, so there is no honest minor-unit value to use as a cap.
    expect(literalCapIn('under 129.995 dollars', 'USD')).toBeNull()
    // Two decimals in JPY is one too many as well.
    expect(literalCapIn('under 129.99', 'JPY')).toBeNull()
  })

  it('is null when there is no amount at all — which is what makes the no-cap refusal fire', () => {
    expect(literalCapIn('Buy shoes', 'USD')).toBeNull()
    expect(literalCapIn('buy shoes for twenty dollars', 'USD')).toBeNull()
    expect(literalCapIn('', 'USD')).toBeNull()
  })

  it('ignores a negative amount, which is not a cap', () => {
    expect(literalCapIn('under -50 dollars', 'USD')).toBeNull()
  })

  it('is a pure function of its arguments', () => {
    const text = 'under $1M at Northwind, no more than 130 dollars per order'
    const first = literalCapIn(text, 'USD')
    for (let i = 0; i < 20; i += 1) expect(literalCapIn(text, 'USD')).toBe(first)
  })
})

describe('mentionsRecurrence', () => {
  it('recognises the words that justify a repeating mandate', () => {
    for (const text of [
      'every month',
      'monthly',
      'each week',
      'weekly subscription',
      'quarterly',
      'annually',
      'repeat every Friday',
      'subscribe to the coffee plan',
      'recurring',
    ]) {
      expect(mentionsRecurrence(text), text).toBe(true)
    }
  })

  it('says no to a one-off purchase', () => {
    for (const text of ['buy running shoes', 'a pair of boots under 130 dollars', 'gift someone a book']) {
      expect(mentionsRecurrence(text), text).toBe(false)
    }
  })

  it('is not fooled by the word "year" inside another word', () => {
    expect(mentionsRecurrence('buy a New Year card')).toBe(true)
  })
})
