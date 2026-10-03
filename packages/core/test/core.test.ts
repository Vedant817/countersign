/**
 * AT-M1 — acceptance tests for `packages/core` (spec §8.1).
 *
 * The five spec'd acceptance tests are marked AT-M1.n; the rest cover the edge cases that spec §12
 * tags to M1 (EC-FX-3, EC-FX-4, EC-FX-5, EC-FX-6, EC-TIME-*) so `pnpm test:ec` can see them.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'

import {
  CURRENCIES,
  MINOR_DIGITS,
  add,
  allocate,
  allocateWithRemainderLast,
  compare,
  currency,
  exceedsCap,
  formatMoney,
  formatMoneyCode,
  fromPayPalValue,
  isCurrency,
  money,
  parseMoneyInput,
  sub,
  sum,
  toPayPalValue,
  withinRange,
} from '../src/money'
import {
  isCsErrorCode,
  csError,
  err,
  ok,
  attempt,
  mapResult,
  toBody,
  toCsError,
  unwrap,
  type CsError,
} from '../src/errors'
import { DEFAULT_CLOCK_SKEW_SECONDS, fixedClock, formatIst, formatIstHuman, withinValidity } from '../src/clock'
import {
  ID_PREFIXES,
  asId,
  byNewest,
  hasPrefix,
  idCreatedAtMs,
  idPrefix,
  newId,
  ulid,
} from '../src/ids'

/** Assert that `fn` throws a `CsError` with exactly this code. */
function expectCode(fn: () => unknown, code: string): CsError {
  let caught: unknown
  try {
    fn()
  } catch (e) {
    caught = e
  }
  expect(caught, `expected a throw with code ${code}`).toBeDefined()
  const e = caught as CsError
  expect(e.code, `message was: ${String((caught as Error)?.message)}`).toBe(code)
  expect(typeof e.userMessage).toBe('string')
  expect(e.userMessage.length).toBeGreaterThan(0)
  return e
}

// ---------------------------------------------------------------------------------------------
// AT-M1.1  round-trip for every currency and 10k random values (property test)
// ---------------------------------------------------------------------------------------------

describe('AT-M1.1 money round-trips through toPayPalValue/fromPayPalValue', () => {
  for (const cur of CURRENCIES) {
    it(`round-trips ${cur}`, () => {
      fc.assert(
        fc.property(fc.bigInt({ min: 0n, max: 10n ** 18n }), (minor) => {
          const m = { minor, currency: cur }
          const text = toPayPalValue(m)
          expect(fromPayPalValue(text, cur)).toEqual(m)
          // The rendered string must be plain decimal, never exponent or trailing junk.
          expect(text).toMatch(cur === 'JPY' ? /^\d+$/ : /^\d+\.\d{2}$/)
          return true
        }),
        { numRuns: 10_000, seed: 0x5eed1 },
      )
    })
  }

  it('formats to exactly the currency’s minor digits', () => {
    expect(toPayPalValue({ minor: 12345n, currency: 'USD' })).toBe('123.45')
    expect(toPayPalValue({ minor: 500n, currency: 'JPY' })).toBe('500')
    expect(toPayPalValue({ minor: 5n, currency: 'USD' })).toBe('0.05')
    expect(toPayPalValue({ minor: 0n, currency: 'USD' })).toBe('0.00')
    expect(toPayPalValue({ minor: 123n, currency: 'JPY' })).toBe('123')
  })
})

// ---------------------------------------------------------------------------------------------
// AT-M1.2  fromPayPalValue("1.005","USD") -> CS_ROUNDING
// ---------------------------------------------------------------------------------------------

describe('AT-M1.2 excess decimals are refused, never rounded', () => {
  it('EC-FX-5 fromPayPalValue("1.005","USD") -> CS_ROUNDING', () => {
    const e = expectCode(() => fromPayPalValue('1.005', 'USD'), 'CS_ROUNDING')
    expect(e.details?.value).toBe('1.005')
    expect(e.retryable).toBe(false)
  })

  it('rejects any sub-minor-unit precision for every 2-digit currency', () => {
    for (const cur of CURRENCIES.filter((c) => MINOR_DIGITS[c] === 2)) {
      expectCode(() => fromPayPalValue('0.001', cur), 'CS_ROUNDING')
    }
  })

  it('rejects decimals at all for JPY', () => {
    expectCode(() => fromPayPalValue('100.00', 'JPY'), 'CS_ROUNDING')
    expect(fromPayPalValue('100', 'JPY')).toEqual({ minor: 100n, currency: 'JPY' })
  })

  it('accepts exactly the currency’s decimal places and no more', () => {
    for (const cur of CURRENCIES.filter((c) => MINOR_DIGITS[c] === 2)) {
      expect(fromPayPalValue('10.10', cur)).toEqual({ minor: 1010n, currency: cur })
      expectCode(() => fromPayPalValue('10.101', cur), 'CS_ROUNDING')
    }
  })

  it('rejects exponent, plus, interior whitespace, empty, negative and junk forms', () => {
    for (const bad of ['1e3', '+1.00', '1 000.00', '-1.00', '', 'abc', '0x10', '1.2.3', '.5', 'NaN', '1,000.00']) {
      expectCode(() => fromPayPalValue(bad, 'USD'), 'CS_VALIDATION')
    }
  })

  it('trims outer whitespace but nothing else', () => {
    expect(fromPayPalValue(' 12.00 ', 'USD')).toEqual({ minor: 1200n, currency: 'USD' })
  })

  it('accepts the well-formed values PayPal actually sends', () => {
    expect(fromPayPalValue('48.00', 'USD')).toEqual({ minor: 4800n, currency: 'USD' })
    expect(fromPayPalValue('0', 'USD')).toEqual({ minor: 0n, currency: 'USD' })
    expect(fromPayPalValue('1234567.89', 'USD')).toEqual({ minor: 123456789n, currency: 'USD' })
  })
})

// ---------------------------------------------------------------------------------------------
// AT-M1.3  allocate(1000n USD, [1n,1n,1n]) -> [334,333,333]
// ---------------------------------------------------------------------------------------------

describe('AT-M1.3 largest-remainder allocation', () => {
  it('AT-M1.3 allocate(1000n USD,[1n,1n,1n]) is [334,333,333] and sums to the total', () => {
    const parts = allocate({ minor: 1000n, currency: 'USD' }, [1n, 1n, 1n])
    expect(parts.map((p) => p.minor)).toEqual([334n, 333n, 333n])
    expect(parts.reduce((a, b) => a + b.minor, 0n)).toBe(1000n)
  })

  it('EC-FX-4 property: the parts always sum exactly to the total', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.array(fc.bigInt({ min: 0n, max: 10n ** 6n }), { minLength: 1, maxLength: 12 }),
        (total, weights) => {
          const nonZero = weights.some((w) => w > 0n)
          if (!nonZero) return true
          const parts = allocate({ minor: total, currency: 'USD' }, weights)
          expect(parts.length).toBe(weights.length)
          expect(parts.reduce((a, b) => a + b.minor, 0n)).toBe(total)
          for (const p of parts) expect(p.minor >= 0n).toBe(true)
          return true
        },
      ),
      { numRuns: 2000, seed: 0xf4 },
    )
  })

  it('EC-FX-4 property: every part is within one minor unit of the exact share', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 9n }),
        fc.array(fc.bigInt({ min: 1n, max: 10n ** 4n }), { minLength: 1, maxLength: 8 }),
        (total, weights) => {
          const parts = allocate({ minor: total, currency: 'USD' }, weights)
          const W = weights.reduce((a, b) => a + b, 0n)
          const exact = weights.map((w) => (total * w) / W)
          parts.forEach((p, i) => {
            const diff = p.minor > exact[i]! ? p.minor - exact[i]! : exact[i]! - p.minor
            expect(diff).toBeLessThanOrEqual(1n)
          })
          return true
        },
      ),
      { numRuns: 1000, seed: 0xf44 },
    )
  })

  it('splitting a shipment order sums to the authorized amount (spec EC-CAP-1/2)', () => {
    // $100.00 authorization shipped as 3 lines of $48.00 / $32.50 / $19.50 must capture exactly.
    const parts = allocate({ minor: 10000n, currency: 'USD' }, [4800n, 3250n, 1950n])
    expect(parts.map((p) => p.minor)).toEqual([4800n, 3250n, 1950n])
  })

  it('allocateWithRemainderLast pins every leftover cent on the final part', () => {
    const parts = allocateWithRemainderLast({ minor: 1000n, currency: 'USD' }, [1n, 1n, 1n])
    expect(parts.map((p) => p.minor)).toEqual([333n, 333n, 334n])
    expect(parts.reduce((a, b) => a + b.minor, 0n)).toBe(1000n)
    // Even weights must still leave the remainder on the last part, not on the largest share.
    expect(
      allocateWithRemainderLast({ minor: 1001n, currency: 'USD' }, [2n, 2n, 1n]).map((p) => p.minor),
    ).toEqual([400n, 400n, 201n])
  })

  it('allocateWithRemainderLast handles the single-part and zero-weight cases', () => {
    expect(allocateWithRemainderLast({ minor: 100n, currency: 'USD' }, [1n])).toEqual([
      { minor: 100n, currency: 'USD' },
    ])
    // A zero-weight line legitimately receives nothing, and the last part still closes the total.
    expect(allocateWithRemainderLast({ minor: 100n, currency: 'USD' }, [0n, 5n]).map((p) => p.minor)).toEqual([
      0n, 100n,
    ])
    expectCode(() => allocateWithRemainderLast({ minor: 1n, currency: 'USD' }, [0n, 0n]), 'CS_VALIDATION')
  })

  it('refuses zero and negative weights', () => {
    expectCode(() => allocate({ minor: 100n, currency: 'USD' }, [0n, 0n]), 'CS_VALIDATION')
    expectCode(() => allocate({ minor: 100n, currency: 'USD' }, [-1n, 2n]), 'CS_VALIDATION')
    expectCode(() => allocate({ minor: 100n, currency: 'USD' }, []), 'CS_VALIDATION')
  })
})

// ---------------------------------------------------------------------------------------------
// AT-M1.4  add of USD and INR -> CS_CURRENCY_MISMATCH
// ---------------------------------------------------------------------------------------------

describe('AT-M1.4 currencies are never silently mixed or converted', () => {
  it('AT-M1.4 add of USD and INR -> CS_CURRENCY_MISMATCH', () => {
    expectCode(() => add({ minor: 100n, currency: 'USD' }, { minor: 100n, currency: 'INR' }), 'CS_CURRENCY_MISMATCH')
  })

  it('EC-FX-1 every arithmetic helper refuses a mixed pair', () => {
    const usd = { minor: 100n, currency: 'USD' } as const
    const inr = { minor: 100n, currency: 'INR' } as const
    expectCode(() => add(usd, inr), 'CS_CURRENCY_MISMATCH')
    expectCode(() => sub(usd, inr), 'CS_CURRENCY_MISMATCH')
    expectCode(() => compare(usd, inr), 'CS_CURRENCY_MISMATCH')
    expectCode(() => sum([usd, inr], 'USD'), 'CS_CURRENCY_MISMATCH')
  })

  it('EC-FX-1 withinRange reports CURRENCY instead of converting', () => {
    expect(withinRange({ minor: 100n, currency: 'INR' }, { currency: 'USD', max: 13000 })).toEqual({
      ok: false,
      reason: 'CURRENCY',
    })
  })

  it('EC-FX-1 exceedsCap names the code rather than converting', () => {
    const r = exceedsCap({ minor: 99900n, currency: 'USD' }, { minor: 13000n, currency: 'USD' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('GATE_BUDGET_EXCEEDED')
      expect(r.over).toEqual({ minor: 86900n, currency: 'USD' })
    }
  })
})

// ---------------------------------------------------------------------------------------------
// AT-M1.5  ID prefixes enforced by type tests (tsd)
// ---------------------------------------------------------------------------------------------

describe('AT-M1.5 identifiers are prefixed and typed', () => {
  it('newId mints the prefix from the registry', () => {
    for (const [key, prefix] of Object.entries(ID_PREFIXES)) {
      const id = newId(key as keyof typeof ID_PREFIXES)
      expect(id.startsWith(`${prefix}_`)).toBe(true)
      expect(idPrefix(id)).toBe(prefix)
      expect(id).toMatch(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`))
    }
  })

  it('asId narrows only the matching prefix', () => {
    const id = newId('mdt')
    expect(asId('mdt', id)).toBe(id)
    expect(asId('ord', id)).toBeNull()
    expect(hasPrefix('mdt', id)).toBe(true)
    expect(hasPrefix('ord', id)).toBe(false)
  })

  it('rejects a prefix that is not three lowercase letters', () => {
    expect(idPrefix('nope')).toBeNull()
    expect(idPrefix('AB_cd')).toBeNull()
    expect(idPrefix('abcd_xyz')).toBeNull()
  })

  it('the ULID body carries the creation time', () => {
    const t = 1_760_000_000_000
    const id = newId('ord', t)
    expect(idCreatedAtMs(id)).toBe(t)
  })

  it('ids minted a second apart sort newest-first', () => {
    const older = newId('ord', 1_000_000_000_000)
    const newer = newId('ord', 1_000_001_000_000)
    expect([older, newer].sort(byNewest)).toEqual([newer, older])
  })

  it('is collision-free over 20k ids', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 20_000; i++) seen.add(ulid())
    expect(seen.size).toBe(20_000)
  })

  it('idCreatedAtMs returns null rather than guessing on foreign ids', () => {
    expect(idCreatedAtMs('att_not-a-ulid')).toBeNull()
    expect(idCreatedAtMs('att_')).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
// error registry
// ---------------------------------------------------------------------------------------------

describe('error registry', () => {
  it('every code in the registry is a known code', () => {
    for (const code of [
      'CS_VALIDATION',
      'CS_NOT_FOUND',
      'CS_CONFLICT',
      'CS_UNAUTHENTICATED',
      'CS_FORBIDDEN',
      'CS_CURRENCY_MISMATCH',
      'CS_ROUNDING',
      'VI_CHAIN_INVALID',
      'VI_SIGNATURE_MISMATCH',
      'VI_EXPIRED',
      'VI_NOT_YET_VALID',
      'VI_CONSTRAINT_VIOLATION',
      'GATE_BLOCKED',
      'GATE_REPLAY',
      'GATE_BUDGET_EXCEEDED',
      'GATE_REVOKED',
      'GATE_PRICE_LOCK_EXPIRED',
      'GATE_OUT_OF_STOCK',
      'GATE_AGENT_SUSPENDED',
      'GATE_WALLET_CAP',
      'PP_AUTH',
      'PP_RATE_LIMITED',
      'PP_UNAVAILABLE',
      'PP_UNPROCESSABLE',
      'PP_DUPLICATE',
      'PP_NOT_FOUND',
      'PP_INSTRUMENT_DECLINED',
      'PP_PAYER_ACTION_REQUIRED',
      'PP_AUTH_EXPIRED',
      'WH_SIGNATURE_INVALID',
      'WH_DUPLICATE',
      'DEF_NO_CHAIN',
      'DEF_CITATION_FAILED',
      'DEF_DEADLINE_PASSED',
      'DEF_WRONG_STATE',
      'LLM_SCHEMA',
      'LLM_UNAVAILABLE',
      'PRIVACY_LEGAL_HOLD',
    ] as const) {
      expect(isCsErrorCode(code)).toBe(true)
    }
    expect(isCsErrorCode('CS_NOPE')).toBe(false)
    expect(isCsErrorCode(42)).toBe(false)
  })

  it('a code with no copy still gets a safe, non-empty userMessage', () => {
    const e = csError('CS_VALIDATION', 'internal detail with token sk_live_abc')
    expect(e.userMessage).not.toContain('sk_live_abc')
    expect(e.userMessage.length).toBeGreaterThan(10)
  })

  it('retryable is true only for codes a retry can fix', () => {
    expect(csError('PP_RATE_LIMITED', 'x').retryable).toBe(true)
    expect(csError('PP_UNAVAILABLE', 'x').retryable).toBe(true)
    expect(csError('LLM_UNAVAILABLE', 'x').retryable).toBe(true)
    expect(csError('GATE_BUDGET_EXCEEDED', 'x').retryable).toBe(false)
    expect(csError('VI_SIGNATURE_MISMATCH', 'x').retryable).toBe(false)
  })

  it('toBody serialises only the safe fields (matches the Python CsErrorBody)', () => {
    const body = toBody(
      csError('GATE_REPLAY', 'jti seen', { jti: 'abc' }, { cause: new Error('secret internals') }),
    )
    expect(Object.keys(body.error).sort()).toEqual(['code', 'details', 'message', 'retryable', 'userMessage'])
    expect(body.error.details).toEqual({ jti: 'abc' })
    expect(JSON.stringify(body)).not.toContain('secret internals')
  })

  it('toBody strips a cause or stack that a caller smuggled into details', () => {
    const body = toBody(
      csError('PP_UNAVAILABLE', 'down', {
        status: 503,
        cause: new Error('connect ECONNREFUSED 10.0.0.5:443'),
        stack: 'Error: connect ECONNREFUSED\n    at …',
        access_token: 'A21AA-live-should-never-appear',
      }),
    )
    const serialised = JSON.stringify(body)
    expect(serialised).not.toContain('ECONNREFUSED')
    expect(serialised).not.toContain('should-never-appear')
    expect(body.error.details).toEqual({ status: 503 })
  })

  it('toCsError passes an existing CsError through and wraps anything else', () => {
    const original = csError('PP_NOT_FOUND', 'gone')
    expect(toCsError(original)).toMatchObject({ code: 'PP_NOT_FOUND', message: 'gone' })
    expect(toCsError(new Error('boom'), 'PP_UNAVAILABLE').code).toBe('PP_UNAVAILABLE')
    expect(toCsError('a string').message).toBe('a string')
    expect(toCsError({ weird: true }).code).toBe('CS_VALIDATION')
  })

  it('Result helpers round-trip', () => {
    expect(unwrap(ok(41))).toBe(41)
    const e = csError('CS_NOT_FOUND', 'x')
    // `unwrap` rethrows the CsError itself (not a wrapped Error), so assert on the value.
    let thrown: unknown
    try {
      unwrap(err(e))
    } catch (caught) {
      thrown = caught
    }
    expect(thrown).toBe(e)
    expect(isCsErrorCode((thrown as CsError).code)).toBe(true)
  })

  it('mapResult maps success and passes errors through untouched', () => {
    expect(mapResult(ok(2), (n) => n * 21)).toEqual({ ok: true, value: 42 })
    const e = csError('CS_NOT_FOUND', 'x')
    expect(mapResult(err(e), (n: number) => n * 21)).toEqual({ ok: false, error: e })
  })

  it('attempt converts a throw into err() and leaves a success alone', async () => {
    expect(await attempt(async () => 7)).toEqual({ ok: true, value: 7 })
    const failed = await attempt(async () => {
      throw csError('PP_UNAVAILABLE', 'down')
    })
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.error.code).toBe('PP_UNAVAILABLE')
    const wrapped = await attempt(() => {
      throw new Error('kaboom')
    }, 'LLM_UNAVAILABLE')
    expect(wrapped.ok).toBe(false)
    if (!wrapped.ok) expect(wrapped.error.code).toBe('LLM_UNAVAILABLE')
  })
})

// ---------------------------------------------------------------------------------------------
// clock / time
// ---------------------------------------------------------------------------------------------

describe('clock and time validity', () => {
  it('a fixed clock is deterministic and advanceable', () => {
    const c = fixedClock(1_760_000_000)
    expect(c.nowSec()).toBe(1_760_000_000)
    expect(c.nowMs()).toBe(1_760_000_000_000)
    c.advance(90)
    expect(c.nowSec()).toBe(1_760_000_090)
  })

  it('EC-TIME-2 a token is valid up to the skew past exp and invalid beyond it', () => {
    const exp = 1_000_000
    expect(withinValidity(exp - 10, { exp }).valid).toBe(true)
    expect(withinValidity(exp + DEFAULT_CLOCK_SKEW_SECONDS, { exp }).valid).toBe(true)
    expect(withinValidity(exp + DEFAULT_CLOCK_SKEW_SECONDS + 1, { exp })).toEqual({
      valid: false,
      reason: 'EXPIRED',
    })
  })

  it('EC-MDT-1 a token issued in the future is NOT_YET_VALID past the skew', () => {
    const nbf = 1_000_000
    expect(withinValidity(nbf + 10, { nbf }).valid).toBe(true)
    expect(withinValidity(nbf - DEFAULT_CLOCK_SKEW_SECONDS - 1, { nbf })).toEqual({
      valid: false,
      reason: 'NOT_YET_VALID',
    })
  })

  it('EC-TIME-6 renders IST explicitly, with no timezone database needed', () => {
    // 2026-10-09T18:29:00Z is 2026-10-09T23:59:00+05:30.
    const sec = Date.parse('2026-10-09T18:29:00Z') / 1000
    expect(formatIst(sec)).toBe('2026-10-09T23:59:00+05:30')
    expect(formatIstHuman(sec)).toBe('Fri 9 Oct, 11:59 PM IST')
  })

  it('formats midnight and noon in 12-hour IST without an off-by-12', () => {
    const midnightIst = Date.parse('2026-10-09T18:30:00Z') / 1000
    expect(formatIstHuman(midnightIst)).toBe('Sat 10 Oct, 12:00 AM IST')
    const noonIst = Date.parse('2026-10-10T06:30:00Z') / 1000
    expect(formatIstHuman(noonIst)).toBe('Sat 10 Oct, 12:00 PM IST')
  })
})

// ---------------------------------------------------------------------------------------------
// formatting and parsing
// ---------------------------------------------------------------------------------------------

describe('display formatting', () => {
  it('EC-FX-3 formats zero-decimal JPY without a decimal point', () => {
    expect(formatMoney({ minor: 500n, currency: 'JPY' })).toBe('¥500')
    expect(formatMoney({ minor: 123456n, currency: 'JPY' })).toBe('¥123,456')
  })

  it('formats two-decimal currencies with grouping', () => {
    expect(formatMoney({ minor: 13000n, currency: 'USD' })).toBe('$130.00')
    expect(formatMoney({ minor: 123456789n, currency: 'INR' })).toBe('₹1,234,567.89')
    expect(formatMoney({ minor: 4800n, currency: 'GBP' }, { symbol: false })).toBe('48.00')
    expect(formatMoneyCode({ minor: 4800n, currency: 'USD' })).toBe('USD 48.00')
  })

  it('EC-FX-5 a model that emits sub-cent precision is refused, not rounded', () => {
    // The realistic failure: the compiler passes the model's literal "129.995" straight through.
    expectCode(() => parseMoneyInput('129.995', 'USD'), 'CS_ROUNDING')
    // …but a clean "129.99" becomes exactly 12999n, with no float anywhere on the path.
    expect(parseMoneyInput('129.99', 'USD')).toEqual({ minor: 12999n, currency: 'USD' })
  })

  it('EC-FX-5 the float round-trip that motivates all of this', () => {
    // Proof that we are not being precious: this is why money.ts has no `number` parameter.
    expect(0.1 + 0.2).not.toBe(0.3)
    expect(add({ minor: 10n, currency: 'USD' }, { minor: 20n, currency: 'USD' }).minor).toBe(30n)
  })

  it('parses human-entered amounts with symbols, grouping and stray characters', () => {
    expect(parseMoneyInput('$130.00', 'USD')).toEqual({ minor: 13000n, currency: 'USD' })
    expect(parseMoneyInput(' 1,299.50 ', 'USD')).toEqual({ minor: 129950n, currency: 'USD' })
    expect(parseMoneyInput('₹500', 'INR')).toEqual({ minor: 50000n, currency: 'INR' })
    expect(parseMoneyInput('130', 'USD')).toEqual({ minor: 13000n, currency: 'USD' })
  })

  it('currency() rejects anything outside the supported set', () => {
    expect(currency('USD')).toBe('USD')
    expectCode(() => currency('usd'), 'CS_VALIDATION')
    expectCode(() => currency('BTC'), 'CS_VALIDATION')
    expect(isCurrency('JPY')).toBe(true)
    expect(isCurrency('XXX')).toBe(false)
  })

  it('money() rejects negatives and accepts bigint or numeric strings', () => {
    expect(money(5, 'USD')).toEqual({ minor: 5n, currency: 'USD' })
    expect(money('5', 'USD')).toEqual({ minor: 5n, currency: 'USD' })
    expectCode(() => money(-1n, 'USD'), 'CS_VALIDATION')
  })

  it('withinRange checks both ends', () => {
    expect(withinRange({ minor: 5000n, currency: 'USD' }, { currency: 'USD', min: 1000, max: 13000 })).toEqual({
      ok: true,
    })
    expect(withinRange({ minor: 999n, currency: 'USD' }, { currency: 'USD', min: 1000 })).toEqual({
      ok: false,
      reason: 'BELOW_MIN',
    })
    expect(withinRange({ minor: 14000n, currency: 'USD' }, { currency: 'USD', max: 13000 })).toEqual({
      ok: false,
      reason: 'ABOVE_MAX',
    })
  })
})