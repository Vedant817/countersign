/**
 * EC-FX-2 — *"Buyer's PayPal funds in another currency (PayPal converts)."*
 *
 * Detection: *"Capture `seller_receivable_breakdown` has an exchange rate."*
 * Handling: *"Out of our control. The mandate binds the merchant charge currency and amount; the receipt
 * notes that PayPal may convert."*
 *
 * Two claims are testable, and this file tests exactly those two:
 *
 *  1. **We can read what the buyer was charged.** The capture's `seller_receivable_breakdown`
 *     (gross, fee, net, exchange rate) parses, so a future receipt can say what happened in the
 *     buyer's own currency. The fixture is `packages/paypal/test/fixtures/transport-double.ts`, which
 *     is doc-derived and says so; nothing here asserts what PayPal *would* have done.
 *  2. **We never convert.** A breakdown in EUR comes back as EUR minor units. The signed mandate
 *     binds the merchant's charge currency, and a library that quietly turned €44.40 into $48.00
 *     would make the Gate's currency checks decorative (EC-FX-1).
 *
 * The receipt sentence itself ("Charged $48.00. PayPal may show this in ₹ at its rate") is **not**
 * implemented — there is no receipt renderer in the repository — and `docs/edge-cases.json` records
 * that half of the case as open rather than claiming this test covers it.
 */
import { describe, expect, it } from 'vitest'

import { captureSchema, ppResponseAmountToMoney } from '../src/types'

import { captureResponse } from './fixtures/transport-double'

describe('EC-FX-2: a capture states what the buyer was charged, and we convert nothing', () => {
  it('parses seller_receivable_breakdown — gross, fee, net and the exchange rate', () => {
    const parsed = captureSchema.safeParse(captureResponse({ value: '48.00' }).body)
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true)
    if (!parsed.success) return

    const breakdown = parsed.data.seller_receivable_breakdown
    expect(breakdown).toBeDefined()
    expect(breakdown?.gross_amount).toEqual({ currency_code: 'USD', value: '48.00' })
    expect(breakdown?.paypal_fee).toEqual({ currency_code: 'USD', value: '-1.62' })
    expect(breakdown?.net_amount).toEqual({ currency_code: 'USD', value: '46.38' })
    // The field the detection column names. It is a string because PayPal sends a fixed-point
    // decimal; parsing it as a number here would be the first float in the money path (§0 rule 9).
    expect(breakdown?.exchange_rate).toBe('1.00')
  })

  it('refuses a breakdown whose rate is a JSON number, so no float can enter through this door', () => {
    const body = captureResponse().body as Record<string, unknown>
    const spec = {
      ...body,
      seller_receivable_breakdown: {
        ...(body['seller_receivable_breakdown'] as object),
        exchange_rate: 1.0,
      },
    }
    const parsed = captureSchema.safeParse(spec)
    expect(parsed.success).toBe(false)
  })

  it('keeps the currency the buyer paid in — an EUR breakdown is EUR minor units, never a converted USD figure', () => {
    const converted = ppResponseAmountToMoney({ currency_code: 'EUR', value: '44.40' })
    expect(converted.ok).toBe(true)
    if (!converted.ok) return
    // Integer minor units plus the ISO-4217 code (§0 rule 9), and the code is the one PayPal sent.
    expect(converted.value).toEqual({ minor: 4440n, currency: 'EUR' })
  })
})
