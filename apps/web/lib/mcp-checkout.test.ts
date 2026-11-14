import { describe, expect, it, vi } from 'vitest'

import type { CsError } from '@countersign/core'
import type { OrderRow } from '@countersign/db'
import type { GateDecision } from '@countersign/gate'

import { orderForAllow, type PlaceOrder } from './mcp-checkout'

describe('orderForAllow', () => {
  const fakeDecision = {
    id: 'gdc_1',
    decision: 'ALLOW',
    reasons: [],
    checks: [],
  } as unknown as GateDecision

  it('(a) returns exact ids/status and note with PayPal order id and decision id when place resolves ok', async () => {
    const fakeRow = {
      id: 'ord_1',
      paypal_order_id: '5O190127TN364715T',
      status: 'CREATED',
    } as unknown as OrderRow

    const place = vi.fn<PlaceOrder>().mockResolvedValue({
      ok: true,
      value: fakeRow,
    })

    const result = await orderForAllow(fakeDecision, place)

    expect(place).toHaveBeenCalledTimes(1)
    expect(place).toHaveBeenCalledWith(fakeDecision)
    expect(result.orderId).toBe('ord_1')
    expect(result.paypalOrderId).toBe('5O190127TN364715T')
    expect(result.orderStatus).toBe('CREATED')
    expect(result.note).toContain('5O190127TN364715T')
    expect(result.note).toContain('gdc_1')
  })

  it('(b) returns null ids and note with userMessage when place resolves err with userMessage', async () => {
    const error: CsError = {
      code: 'PP_UNAVAILABLE',
      message: 'internal details',
      userMessage: 'PayPal is unavailable.',
      retryable: true,
    }

    const place = vi.fn<PlaceOrder>().mockResolvedValue({
      ok: false,
      error,
    })

    const result = await orderForAllow(fakeDecision, place)

    expect(result.orderId).toBeNull()
    expect(result.paypalOrderId).toBeNull()
    expect(result.orderStatus).toBeNull()
    expect(result.note).toContain('PayPal is unavailable.')
  })

  it('(c) returns null ids and note with message when place resolves err without userMessage', async () => {
    const error = {
      code: 'CS_INTERNAL',
      message: 'boom',
    } as unknown as CsError

    const place = vi.fn<PlaceOrder>().mockResolvedValue({
      ok: false,
      error,
    })

    const result = await orderForAllow(fakeDecision, place)

    expect(result.orderId).toBeNull()
    expect(result.paypalOrderId).toBeNull()
    expect(result.orderStatus).toBeNull()
    expect(result.note).toContain('boom')
  })

  it('(d) does not throw, returns null ids and note with error message when place throws', async () => {
    const place = vi.fn<PlaceOrder>().mockRejectedValue(new Error('network down'))

    const result = await orderForAllow(fakeDecision, place)

    expect(result.orderId).toBeNull()
    expect(result.paypalOrderId).toBeNull()
    expect(result.orderStatus).toBeNull()
    expect(result.note).toContain('network down')
  })
})
