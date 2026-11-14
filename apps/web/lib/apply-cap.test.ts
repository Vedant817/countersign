import { describe, expect, it } from 'vitest'
import type { CompiledMandate, VIConstraint } from '@countersign/compiler'

import { applyCap, assertStoreCurrency } from './apply-cap'
import type { MerchantIdentity } from './merchant'

const MERCHANT: MerchantIdentity = {
  id: 'mer_northwind',
  name: 'Northwind Outfitters',
  website: 'https://shop.test',
}

describe('applyCap', () => {
  it('(i) compiled max $40 + cap $50 keeps $40', () => {
    const initial: VIConstraint[] = [
      { type: 'mandate.payment.amount_range', currency: 'USD', min: 1000n, max: 4000n },
      { type: 'mandate.payment.budget', currency: 'USD', max: 4000n },
    ]
    const result = applyCap(initial, 5000n, MERCHANT)

    const amountRange = result.find((c) => c.type === 'mandate.payment.amount_range')
    expect(amountRange).toMatchObject({
      type: 'mandate.payment.amount_range',
      currency: 'USD',
      min: 1000n,
      max: 4000n,
    })

    const budget = result.find((c) => c.type === 'mandate.payment.budget')
    expect(budget).toMatchObject({
      type: 'mandate.payment.budget',
      currency: 'USD',
      max: 4000n,
    })
  })

  it('(ii) compiled max $80 + cap $50 becomes $50', () => {
    const initial: VIConstraint[] = [
      { type: 'mandate.payment.amount_range', currency: 'USD', min: 500n, max: 8000n },
      { type: 'mandate.payment.budget', currency: 'USD', max: 8000n },
    ]
    const result = applyCap(initial, 5000n, MERCHANT)

    const amountRange = result.find((c) => c.type === 'mandate.payment.amount_range')
    expect(amountRange).toMatchObject({
      type: 'mandate.payment.amount_range',
      currency: 'USD',
      min: 500n,
      max: 5000n,
    })

    const budget = result.find((c) => c.type === 'mandate.payment.budget')
    expect(budget).toMatchObject({
      type: 'mandate.payment.budget',
      currency: 'USD',
      max: 5000n,
    })
  })

  it('(iii) no amount_range/budget adds both at the cap', () => {
    const initial: VIConstraint[] = []
    const result = applyCap(initial, 5000n, MERCHANT)

    const amountRange = result.find((c) => c.type === 'mandate.payment.amount_range')
    expect(amountRange).toEqual({
      type: 'mandate.payment.amount_range',
      currency: 'USD',
      max: 5000n,
    })

    const budget = result.find((c) => c.type === 'mandate.payment.budget')
    expect(budget).toEqual({
      type: 'mandate.payment.budget',
      currency: 'USD',
      max: 5000n,
    })
  })

  it('(iv) missing merchants/payees get added', () => {
    // 1. Missing entirely
    const emptyResult = applyCap([], 5000n, MERCHANT)
    const merchants = emptyResult.find((c) => c.type === 'mandate.checkout.allowed_merchants')
    expect(merchants).toEqual({
      type: 'mandate.checkout.allowed_merchants',
      allowed: [{ id: MERCHANT.id, name: MERCHANT.name, website: MERCHANT.website }],
    })

    const payees = emptyResult.find((c) => c.type === 'mandate.payment.allowed_payees')
    expect(payees).toEqual({
      type: 'mandate.payment.allowed_payees',
      allowed: [{ id: MERCHANT.id, name: MERCHANT.name, website: MERCHANT.website }],
    })

    // 2. Existing constraint with different merchant gets this merchant appended
    const otherMerchant = {
      id: 'mer_other',
      name: 'Other Store',
      website: 'https://other.example',
    }
    const withOther: VIConstraint[] = [
      { type: 'mandate.checkout.allowed_merchants', allowed: [otherMerchant] },
      { type: 'mandate.payment.allowed_payees', allowed: [otherMerchant] },
    ]
    const updated = applyCap(withOther, 5000n, MERCHANT)

    const updatedMerchants = updated.find((c) => c.type === 'mandate.checkout.allowed_merchants')
    expect(updatedMerchants?.allowed).toHaveLength(2)
    expect(updatedMerchants?.allowed[0]?.id).toBe('mer_other')
    expect(updatedMerchants?.allowed[1]?.id).toBe(MERCHANT.id)

    const updatedPayees = updated.find((c) => c.type === 'mandate.payment.allowed_payees')
    expect(updatedPayees?.allowed).toHaveLength(2)
    expect(updatedPayees?.allowed[0]?.id).toBe('mer_other')
    expect(updatedPayees?.allowed[1]?.id).toBe(MERCHANT.id)

    // 3. Existing constraint already containing merchant does not duplicate
    const alreadyPresent = applyCap(updated, 5000n, MERCHANT)
    const merchantsAfter = alreadyPresent.find(
      (c) => c.type === 'mandate.checkout.allowed_merchants',
    )
    expect(merchantsAfter?.allowed).toHaveLength(2)
  })

  it('(v) the input array is not mutated', () => {
    const originalAllowed = [{ id: 'mer_other', name: 'Other', website: 'https://other.example' }]
    const input: VIConstraint[] = [
      {
        type: 'mandate.checkout.allowed_merchants',
        allowed: originalAllowed,
      },
      {
        type: 'mandate.checkout.line_items',
        items: [{ id: 'req_1', acceptable_items: [{ id: 'sku_1', title: 'Shoes' }], quantity: 1 }],
        match_mode: 'minimum',
      },
      {
        type: 'mandate.payment.amount_range',
        currency: 'USD',
        min: 1000n,
        max: 8000n,
      },
    ]

    // Deep freeze input to guarantee immutability
    const snapshot = JSON.stringify(input, (_, v) => (typeof v === 'bigint' ? v.toString() : v))

    const result = applyCap(input, 5000n, MERCHANT)

    expect(result).not.toBe(input)
    const afterSnapshot = JSON.stringify(input, (_, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    )
    expect(afterSnapshot).toBe(snapshot)
    expect(input[0]?.type === 'mandate.checkout.allowed_merchants' && input[0].allowed).toBe(
      originalAllowed,
    )
    expect(originalAllowed).toHaveLength(1)
  })

  it('adds the merchant with its real website and no value contains .example', () => {
    const result = applyCap([], 5000n, MERCHANT)
    const merchants = result.find((c) => c.type === 'mandate.checkout.allowed_merchants')
    const payees = result.find((c) => c.type === 'mandate.payment.allowed_payees')

    expect(
      merchants?.type === 'mandate.checkout.allowed_merchants' && merchants.allowed[0]?.website,
    ).toBe(MERCHANT.website)
    expect(payees?.type === 'mandate.payment.allowed_payees' && payees.allowed[0]?.website).toBe(
      MERCHANT.website,
    )

    const serialized = JSON.stringify(result, (_, v) => (typeof v === 'bigint' ? v.toString() : v))
    expect(serialized).not.toContain('.example')
    expect(serialized).toContain(MERCHANT.website)
  })
})

function makeCompiledMandate(
  currency: 'USD' | 'INR' | string = 'USD',
  constraints: VIConstraint[] = [],
): CompiledMandate {
  return {
    currency: currency as never,
    constraints,
    ttlSeconds: 604800,
    expiresAtEpochSec: 1700000000,
    preferences: {},
    assumptions: [],
    ambiguities: [],
  }
}

describe('assertStoreCurrency', () => {
  it('ok for USD compiled mandate', () => {
    const compiled = makeCompiledMandate('USD', [
      { type: 'mandate.payment.amount_range', currency: 'USD', max: 5000n },
      { type: 'mandate.payment.budget', currency: 'USD', max: 5000n },
    ])
    const result = assertStoreCurrency(compiled)
    expect(result.ok).toBe(true)
  })

  it('err with code CS_VALIDATION when compiled currency is INR', () => {
    const compiled = makeCompiledMandate('INR', [
      { type: 'mandate.payment.amount_range', currency: 'INR', max: 5000n },
    ])
    const result = assertStoreCurrency(compiled)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('CS_VALIDATION')
      expect(result.error.message).toBe(
        'This store charges in USD. Please state your limit in dollars.',
      )
    }
  })

  it('err with code CS_VALIDATION when USD mandate has amount_range in INR', () => {
    const compiled = makeCompiledMandate('USD', [
      { type: 'mandate.payment.amount_range', currency: 'INR' as never, max: 5000n },
    ])
    const result = assertStoreCurrency(compiled)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('CS_VALIDATION')
      expect(result.error.message).toBe(
        'This store charges in USD. Please state your limit in dollars.',
      )
    }
  })

  it('err with code CS_VALIDATION when USD mandate has budget in INR', () => {
    const compiled = makeCompiledMandate('USD', [
      { type: 'mandate.payment.budget', currency: 'INR' as never, max: 5000n },
    ])
    const result = assertStoreCurrency(compiled)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('CS_VALIDATION')
      expect(result.error.message).toBe(
        'This store charges in USD. Please state your limit in dollars.',
      )
    }
  })
})
