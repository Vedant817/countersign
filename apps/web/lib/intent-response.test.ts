/**
 * Regression tests for the bug that made every *successful* compile return an empty `500`.
 *
 * The assertion that matters most is the plainest one: `JSON.stringify(intentResponseBody(...))` must
 * not throw. That is what `NextResponse.json` does, and it was throwing on a `bigint` — so the tests
 * here are written against `JSON.stringify` rather than against `toJsonSafe`, because the failure mode
 * belongs to the serialiser the route actually uses.
 */
import { describe, expect, it } from 'vitest'

import type { CompiledMandate } from '@countersign/compiler'

import { intentResponseBody } from './intent-response'

/**
 * A mandate carrying one amount cap of `minor` minor units.
 *
 * Cast because `CompiledMandate` is built by the compiler from a validated proposal, and rebuilding
 * that here would test the compiler rather than the serialiser. The field names are the real ones —
 * if they drift, this stops compiling, which is the check worth having.
 */
function mandateWithCap(minor: bigint): CompiledMandate {
  return {
    currency: 'USD',
    ttlSeconds: 900,
    constraints: [
      { type: 'mandate.payment.amount_range', max: minor },
      { type: 'mandate.payment.merchant', merchant_id: 'mrc_northwind' },
    ],
    assumptions: ['The limit was taken from the amount you wrote.'],
    ambiguities: [],
  } as unknown as CompiledMandate
}

describe('intentResponseBody', () => {
  it('serialises a mandate with an amount cap — the case that returned an empty 500', () => {
    // `$50.00` in minor units. Before the fix this threw
    // `TypeError: Do not know how to serialize a BigInt` inside the route, and Next answered with a
    // 500 whose body was zero bytes, so the caller saw nothing to debug.
    const body = intentResponseBody(mandateWithCap(5_000n), 'Spend at most $50.00 at Northwind.')

    expect(() => JSON.stringify(body)).not.toThrow()
    expect(body.constraints[0]).toEqual({ type: 'mandate.payment.amount_range', max: 5_000 })
    // The read-back is the artefact the buyer signs; it must survive the trip byte for byte.
    expect(body.read_back).toBe('Spend at most $50.00 at Northwind.')
  })

  it('carries the currency beside the amounts, because minor units are meaningless without it', () => {
    const body = intentResponseBody(mandateWithCap(1n), 'x')
    expect(body.currency).toBe('USD')
    expect(body.ttl_seconds).toBe(900)
  })

  it('refuses an amount it cannot represent, rather than rounding it', () => {
    // Past 2^53 a JSON number has already lost precision. Emitting it anyway would put an amount in
    // the response that differs from the amount in the mandate — the exact class of silent wrongness
    // this product exists to prevent, so it is an error instead.
    expect(() => intentResponseBody(mandateWithCap(2n ** 60n), 'x')).toThrow(/safe integer range/)
  })

  it('reaches a bigint nested inside a future constraint shape', () => {
    // `toJsonSafe` walks arrays and objects rather than naming the amount-bearing fields, so a new
    // constraint carries its amounts correctly without anyone remembering to update a list.
    const mandate = {
      currency: 'INR',
      ttlSeconds: 600,
      constraints: [
        {
          type: 'mandate.payment.budget',
          nested: { amount: 123_45n },
          tiers: [{ cap: 2n }, { cap: 3n }],
        },
      ],
      assumptions: [],
      ambiguities: [{ field: 'amount', options: [{ value: 7n }] }],
    } as unknown as CompiledMandate

    const body = intentResponseBody(mandate, 'x')
    expect(() => JSON.stringify(body)).not.toThrow()
    expect(body.constraints[0]).toEqual({
      type: 'mandate.payment.budget',
      nested: { amount: 12_345 },
      tiers: [{ cap: 2 }, { cap: 3 }],
    })
    expect(body.ambiguities[0]).toEqual({ field: 'amount', options: [{ value: 7 }] })
  })

  it('passes a no-amount mandate through unchanged', () => {
    // The cases that were *working* before the fix. Kept so the fix is pinned as "nothing else moved".
    const mandate = {
      currency: 'USD',
      ttlSeconds: 900,
      constraints: [{ type: 'mandate.payment.merchant', merchant_id: 'mrc_northwind' }],
      assumptions: ['No amount was given, so you will be asked for one.'],
      ambiguities: [{ field: 'amount', options: [] }],
    } as unknown as CompiledMandate

    const body = intentResponseBody(mandate, 'Buy shoes from Northwind.')
    expect(JSON.stringify(body)).toContain('mrc_northwind')
    expect(body.ambiguities).toHaveLength(1)
  })
})
