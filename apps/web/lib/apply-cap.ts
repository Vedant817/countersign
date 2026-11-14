import { csError, err, ok, type CsError, type Result } from '@countersign/core'
import type { CompiledMandate, VIConstraint } from '@countersign/compiler'
import type { MerchantIdentity } from './merchant'

/**
 * Reject any compiled mandate whose overall currency or constraint currency is not the store currency.
 */
export function assertStoreCurrency(
  compiled: CompiledMandate,
  storeCurrency: 'USD' = 'USD',
): Result<void, CsError> {
  if (compiled.currency !== storeCurrency) {
    return err(
      csError('CS_VALIDATION', 'This store charges in USD. Please state your limit in dollars.'),
    )
  }
  for (const c of compiled.constraints) {
    if (
      (c.type === 'mandate.payment.amount_range' || c.type === 'mandate.payment.budget') &&
      c.currency !== storeCurrency
    ) {
      return err(
        csError('CS_VALIDATION', 'This store charges in USD. Please state your limit in dollars.'),
      )
    }
  }
  return ok(undefined)
}

/**
 * Clamp a compiled mandate's constraints to the buyer's cap and the authorized merchant.
 *
 * Rules:
 *  1. For `mandate.payment.amount_range` and `mandate.payment.budget` (currency USD):
 *     - If present, set max = the SMALLER of its existing max and capMinor (the tighter
 *       limit always wins; never raise a buyer's own limit).
 *     - If absent, add it with max = capMinor.
 *     - Keep any existing min.
 *  2. Ensure `mandate.checkout.allowed_merchants` and `mandate.payment.allowed_payees`
 *     exist and contain the merchant; add them if missing.
 *  3. Return a NEW array; never mutate the input. Keep every other constraint unchanged.
 */
export function applyCap(
  constraints: readonly VIConstraint[],
  capMinor: bigint,
  merchant: MerchantIdentity,
): VIConstraint[] {
  let seenAllowedMerchants = false
  let seenAllowedPayees = false
  let seenAmountRange = false
  let seenBudget = false

  const result: VIConstraint[] = []

  for (const c of constraints) {
    if (c.type === 'mandate.checkout.allowed_merchants') {
      seenAllowedMerchants = true
      const hasMerchant = c.allowed.some((m) => m.id === merchant.id)
      result.push({
        ...c,
        allowed: hasMerchant ? [...c.allowed] : [...c.allowed, merchant],
      })
    } else if (c.type === 'mandate.payment.allowed_payees') {
      seenAllowedPayees = true
      const hasMerchant = c.allowed.some((m) => m.id === merchant.id)
      result.push({
        ...c,
        allowed: hasMerchant ? [...c.allowed] : [...c.allowed, merchant],
      })
    } else if (c.type === 'mandate.payment.amount_range') {
      seenAmountRange = true
      const max = c.max !== undefined ? (c.max < capMinor ? c.max : capMinor) : capMinor
      result.push({
        ...c,
        currency: c.currency,
        max,
        ...(c.min !== undefined ? { min: c.min } : {}),
      })
    } else if (c.type === 'mandate.payment.budget') {
      seenBudget = true
      const max = c.max < capMinor ? c.max : capMinor
      result.push({
        ...c,
        currency: c.currency,
        max,
        ...(c.min !== undefined ? { min: c.min } : {}),
      })
    } else {
      result.push({ ...c } as VIConstraint)
    }
  }

  if (!seenAllowedMerchants) {
    result.push({
      type: 'mandate.checkout.allowed_merchants',
      allowed: [merchant],
    })
  }

  if (!seenAllowedPayees) {
    result.push({
      type: 'mandate.payment.allowed_payees',
      allowed: [merchant],
    })
  }

  if (!seenAmountRange) {
    result.push({
      type: 'mandate.payment.amount_range',
      currency: 'USD',
      max: capMinor,
    })
  }

  if (!seenBudget) {
    result.push({
      type: 'mandate.payment.budget',
      currency: 'USD',
      max: capMinor,
    })
  }

  return result
}
