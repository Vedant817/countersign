/**
 * The merchant's post-purchase money movements, in isolation — spec §8.11, §8.15, S-15.
 *
 * `packages/orders` proves the arithmetic, the state machine and every `PayPal-Request-Id`;
 * `packages/db` proves the merchant-scoped finders against real Postgres. What neither can prove is the
 * **order of the guards** this module owns, which is the part that keeps one click from becoming money
 * moving twice or money moving for the wrong merchant:
 *
 *  1. the order belongs to this merchant, or nothing else happens;
 *  2. a refund's capture belongs to this merchant **and** to the order in the URL;
 *  3. only a successful movement writes an audit row — a refusal is not an event that happened;
 *  4. what the merchant reads back is JSON: every amount is a decimal string, never a `bigint`.
 *
 * Everything below is a double: the repositories, the audit log and the three `packages/orders` operations.
 * That is deliberate — this suite is about which of them runs, and in what order.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { csError, err, money, ok } from '@countersign/core'
import type * as DbModule from '@countersign/db'
import type { CaptureRow, OrderRow } from '@countersign/db'
import type * as OrdersModule from '@countersign/orders'
import type { OrdersDeps } from '@countersign/orders'

const db = vi.hoisted(() => ({
  findOrderForMerchant: vi.fn(),
  findCaptureForMerchant: vi.fn(),
  appendAudit: vi.fn(),
}))

vi.mock('@countersign/db', async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  ...db,
}))

const orders = vi.hoisted(() => ({
  captureShipment: vi.fn(),
  voidRemainder: vi.fn(),
  refund: vi.fn(),
}))

vi.mock('@countersign/orders', async (importOriginal) => ({
  ...(await importOriginal<typeof OrdersModule>()),
  ...orders,
}))

import {
  AUDIT_ORDER_CAPTURED,
  AUDIT_ORDER_REFUNDED,
  AUDIT_ORDER_VOIDED,
  captureShipmentForMerchant,
  refundForMerchant,
  voidOrderForMerchant,
} from './order-ops'

const ORDER_ID = 'ord_00000000000000000000000001'
const OTHER_ORDER_ID = 'ord_00000000000000000000000002'
const MERCHANT_ID = 'mer_00000000000000000000000001'
const OTHER_MERCHANT_ID = 'mer_00000000000000000000000002'
const CAPTURE_ID = 'cap_00000000000000000000000001'
const ACTOR = 'usr_merchant_000000000000000'
const AUDIT_ID = 'aud_000000000000000000000001'

/** A deps bag the mocked operations never read. The cast is the point: nothing here reaches PayPal. */
const DEPS = {} as unknown as OrdersDeps

function orderRow(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    id: ORDER_ID,
    merchant_id: MERCHANT_ID,
    paypal_order_id: 'PP-ORD-1',
    intent: 'AUTHORIZE',
    status: 'AUTHORIZED',
    amount_minor: 10_000n,
    currency: 'USD',
    ...overrides,
  } as OrderRow
}

function captureRow(overrides: Partial<CaptureRow> = {}): CaptureRow {
  return {
    id: CAPTURE_ID,
    order_id: ORDER_ID,
    paypal_capture_id: 'PP-CAP-1',
    amount_minor: 10_000n,
    currency: 'USD',
    refunded_minor: 0n,
    status: 'COMPLETED',
    ...overrides,
  } as CaptureRow
}

/** The audit row shape `appendAudit` returns; only `id` is read back. */
function auditRow(id = AUDIT_ID): { id: string } {
  return { id }
}

function lastAudit(): Record<string, unknown> {
  const call = db.appendAudit.mock.calls.at(-1)
  if (call === undefined) throw new Error('appendAudit was not called')
  const details = (call[0] as { details?: Record<string, unknown> }).details
  if (details === undefined) throw new Error('the audit row had no details')
  return details
}

beforeEach(() => {
  vi.clearAllMocks()
  db.findOrderForMerchant.mockResolvedValue(ok(orderRow()))
  db.findCaptureForMerchant.mockResolvedValue(ok(captureRow()))
  db.appendAudit.mockResolvedValue(ok(auditRow()))
})

describe('captureShipmentForMerchant', () => {
  it('captures against the merchant’s own order, then writes one audit row on that order’s chain', async () => {
    orders.captureShipment.mockResolvedValue(
      ok({
        capture: captureRow({ paypal_capture_id: 'PP-CAP-9', status: 'COMPLETED' }),
        shipment: { id: 'shp_1' },
        amount: money(4_000n, 'USD'),
        finalCapture: false,
        remainingAfter: 6_000n,
        pending: false,
        trackingOnly: false,
        requestId: 'cs:auth:cap:shp',
        authorizationId: 'auth_1',
      }),
    )

    const result = await captureShipmentForMerchant(
      {
        orderId: ORDER_ID,
        merchantId: MERCHANT_ID,
        actorUserId: ACTOR as never,
        shipment: { lines: [{ sku: 'NW-001', qty: 1 }], carrier: 'DHL', tracking: 'T1' },
      },
      DEPS,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.amount).toEqual({ minor: '4000', currency: 'USD' })
    expect(result.value.remainingAfter).toEqual({ minor: '6000', currency: 'USD' })
    expect(result.value.captureId).toBe(CAPTURE_ID)
    expect(result.value.paypalCaptureId).toBe('PP-CAP-9')
    expect(result.value.paypalCalls).toEqual(['capture', 'track'])
    // A money-adjacent response has to survive `JSON.stringify`, which a `bigint` does not.
    expect(() => JSON.stringify(result.value)).not.toThrow()

    expect(orders.captureShipment).toHaveBeenCalledWith(
      ORDER_ID,
      expect.objectContaining({
        carrier: 'DHL',
        tracking: 'T1',
      }),
      DEPS,
    )
    expect(db.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        chainId: ORDER_ID,
        actor: ACTOR,
        action: AUDIT_ORDER_CAPTURED,
        subject: ORDER_ID,
      }),
    )
    expect(lastAudit()['amount_minor']).toBe('4000')
    expect(lastAudit()['paypal_request_id']).toBe('cs:auth:cap:shp')
  })

  it('EC-CAP-4: a PENDING capture claims no tracker, because nothing shipped', async () => {
    orders.captureShipment.mockResolvedValue(
      ok({
        capture: captureRow({ status: 'PENDING' }),
        shipment: { id: 'shp_1' },
        amount: money(4_000n, 'USD'),
        finalCapture: false,
        remainingAfter: 6_000n,
        pending: true,
        trackingOnly: false,
        requestId: 'cs:auth:cap:shp',
        authorizationId: 'auth_1',
      }),
    )
    const result = await captureShipmentForMerchant(
      {
        orderId: ORDER_ID,
        merchantId: MERCHANT_ID,
        actorUserId: ACTOR as never,
        shipment: { lines: [{ sku: 'NW-001', qty: 1 }], carrier: 'DHL', tracking: 'T1' },
      },
      DEPS,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.pending).toBe(true)
    expect(result.value.paypalCalls).toEqual(['capture'])
  })

  it('EC-SPLIT-2: a tracking-only shipment moves no money and reports no capture', async () => {
    orders.captureShipment.mockResolvedValue(
      ok({
        capture: captureRow({ status: 'COMPLETED' }),
        shipment: { id: 'shp_2' },
        amount: money(0n, 'USD'),
        finalCapture: false,
        remainingAfter: 0n,
        pending: false,
        trackingOnly: true,
        requestId: 'cs:auth:cap:shp2',
        authorizationId: null,
      }),
    )
    const result = await captureShipmentForMerchant(
      {
        orderId: ORDER_ID,
        merchantId: MERCHANT_ID,
        actorUserId: ACTOR as never,
        shipment: { lines: [{ sku: 'NW-001', qty: 1 }], carrier: 'DHL', tracking: 'T2' },
      },
      DEPS,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.trackingOnly).toBe(true)
    expect(result.value.captureId).toBeNull()
    expect(result.value.paypalCalls).toEqual(['track'])
  })

  it('another merchant’s order is 404, and neither the capture nor the audit row is touched', async () => {
    db.findOrderForMerchant.mockResolvedValue(ok(undefined))
    const result = await captureShipmentForMerchant(
      {
        orderId: ORDER_ID,
        merchantId: OTHER_MERCHANT_ID,
        actorUserId: ACTOR as never,
        shipment: { lines: [{ sku: 'NW-001', qty: 1 }], carrier: 'DHL', tracking: 'T1' },
      },
      DEPS,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_NOT_FOUND')
    // The whole point: a guessed order id costs no PayPal call and leaves no trace in the audit chain.
    expect(orders.captureShipment).not.toHaveBeenCalled()
    expect(db.appendAudit).not.toHaveBeenCalled()
    expect(db.findOrderForMerchant).toHaveBeenCalledWith(ORDER_ID, OTHER_MERCHANT_ID)
  })

  it('a PayPal refusal is propagated and writes no audit row claiming a capture', async () => {
    orders.captureShipment.mockResolvedValue(
      err(csError('PP_INSTRUMENT_DECLINED', 'PayPal declined the capture')),
    )
    const result = await captureShipmentForMerchant(
      {
        orderId: ORDER_ID,
        merchantId: MERCHANT_ID,
        actorUserId: ACTOR as never,
        shipment: { lines: [{ sku: 'NW-001', qty: 1 }], carrier: 'DHL', tracking: 'T1' },
      },
      DEPS,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('PP_INSTRUMENT_DECLINED')
    expect(db.appendAudit).not.toHaveBeenCalled()
  })

  it('an audit failure fails the request, rather than reporting a capture that was not recorded', async () => {
    orders.captureShipment.mockResolvedValue(
      ok({
        capture: captureRow(),
        shipment: { id: 'shp_1' },
        amount: money(4_000n, 'USD'),
        finalCapture: true,
        remainingAfter: 0n,
        pending: false,
        trackingOnly: false,
        requestId: 'cs:auth:cap:shp',
        authorizationId: 'auth_1',
      }),
    )
    db.appendAudit.mockResolvedValue(err(csError('CS_INTERNAL', 'audit chain is down')))
    const result = await captureShipmentForMerchant(
      {
        orderId: ORDER_ID,
        merchantId: MERCHANT_ID,
        actorUserId: ACTOR as never,
        shipment: { lines: [{ sku: 'NW-001', qty: 1 }], carrier: 'DHL', tracking: 'T1' },
      },
      DEPS,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_INTERNAL')
  })
})

describe('voidOrderForMerchant', () => {
  it('releases the remainder, records the reason, and attributes the click', async () => {
    orders.voidRemainder.mockResolvedValue(
      ok({
        released: money(6_000n, 'USD'),
        orderStatus: 'VOIDED',
        viaAuthorizationVoid: false,
        alreadySettled: false,
      }),
    )
    const result = await voidOrderForMerchant(
      {
        orderId: ORDER_ID,
        merchantId: MERCHANT_ID,
        actorUserId: ACTOR as never,
        reason: 'OUT_OF_STOCK',
      },
      DEPS,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.released).toEqual({ minor: '6000', currency: 'USD' })
    expect(result.value.orderStatus).toBe('VOIDED')
    expect(result.value.paypalCalls).toEqual(['void'])
    expect(lastAudit()['reason']).toBe('OUT_OF_STOCK')
    expect(db.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: AUDIT_ORDER_VOIDED, chainId: ORDER_ID, actor: ACTOR }),
    )
  })

  it('a retry of a settled order is ok, makes no PayPal call, and says so in the audit row', async () => {
    orders.voidRemainder.mockResolvedValue(
      ok({
        released: money(0n, 'USD'),
        orderStatus: 'VOIDED',
        viaAuthorizationVoid: false,
        alreadySettled: true,
      }),
    )
    const result = await voidOrderForMerchant(
      {
        orderId: ORDER_ID,
        merchantId: MERCHANT_ID,
        actorUserId: ACTOR as never,
        reason: 'CANCELLED',
      },
      DEPS,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.alreadySettled).toBe(true)
    expect(result.value.paypalCalls).toEqual([])
    expect(lastAudit()['already_settled']).toBe(true)
  })

  it('another merchant’s order never reaches the void', async () => {
    db.findOrderForMerchant.mockResolvedValue(ok(undefined))
    const result = await voidOrderForMerchant(
      {
        orderId: ORDER_ID,
        merchantId: OTHER_MERCHANT_ID,
        actorUserId: ACTOR as never,
        reason: 'OUT_OF_STOCK',
      },
      DEPS,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_NOT_FOUND')
    expect(orders.voidRemainder).not.toHaveBeenCalled()
  })
})

describe('refundForMerchant', () => {
  it('refunds by PayPal capture id, keyed by the caller’s nonce, as the merchant', async () => {
    orders.refund.mockResolvedValue(
      ok({
        refund: {
          id: 'ref_1',
          paypal_refund_id: 'PP-REF-1',
          capture_id: CAPTURE_ID,
          amount_minor: 2_000n,
          currency: 'USD',
          status: 'PENDING',
        },
        capture: captureRow(),
        refundableAfter: 8_000n,
        requestId: 'cs:PP-CAP-1:ref:ref_1',
      }),
    )

    const result = await refundForMerchant(
      {
        orderId: ORDER_ID,
        merchantId: MERCHANT_ID,
        actorUserId: ACTOR as never,
        captureId: CAPTURE_ID,
        amount: money(2_000n, 'USD'),
        reason: 'RETURN',
        idempotencyKey: 'form-nonce-abc123',
        note: 'arrived damaged',
        noteToPayer: 'Sorry about that.',
      },
      DEPS,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.amount).toEqual({ minor: '2000', currency: 'USD' })
    expect(result.value.refundableAfter).toEqual({ minor: '8000', currency: 'USD' })
    expect(result.value.paypalCalls).toEqual(['refund'])

    // The two things this module exists to get right: PayPal is addressed by **its** capture id, and the
    // refund is keyed by the caller's nonce (EC-IDEM-5).
    expect(orders.refund).toHaveBeenCalledWith(
      'PP-CAP-1',
      money(2_000n, 'USD'),
      'RETURN',
      { initiatedBy: 'MERCHANT', actor: ACTOR, note: 'arrived damaged' },
      DEPS,
      { idempotencyKey: 'form-nonce-abc123', noteToPayer: 'Sorry about that.' },
    )
    expect(lastAudit()['refund_id']).toBe('ref_1')
    expect(lastAudit()['idempotency_key']).toBe('form-nonce-abc123')
    expect(db.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: AUDIT_ORDER_REFUNDED, chainId: ORDER_ID }),
    )
  })

  it("EC-REF-5: 'FULL' is passed through as the exact remainder, never as an amount", async () => {
    orders.refund.mockResolvedValue(
      ok({
        refund: {
          id: 'ref_2',
          paypal_refund_id: 'PP-REF-2',
          capture_id: CAPTURE_ID,
          amount_minor: 10_000n,
          currency: 'USD',
          status: 'COMPLETED',
        },
        capture: captureRow(),
        refundableAfter: 0n,
        requestId: 'cs:PP-CAP-1:ref:ref_2',
      }),
    )
    const result = await refundForMerchant(
      {
        orderId: ORDER_ID,
        merchantId: MERCHANT_ID,
        actorUserId: ACTOR as never,
        captureId: CAPTURE_ID,
        amount: 'FULL',
        reason: 'MERCHANT_REQUEST',
        idempotencyKey: 'form-nonce-def456',
      },
      DEPS,
    )
    expect(result.ok).toBe(true)
    expect(orders.refund.mock.calls[0]?.[1]).toBe('FULL')
  })

  it('a capture that is not this merchant’s is 404, and no refund is attempted', async () => {
    db.findCaptureForMerchant.mockResolvedValue(ok(undefined))
    const result = await refundForMerchant(
      {
        orderId: ORDER_ID,
        merchantId: MERCHANT_ID,
        actorUserId: ACTOR as never,
        captureId: CAPTURE_ID,
        amount: money(2_000n, 'USD'),
        reason: 'RETURN',
        idempotencyKey: 'form-nonce-abc123',
      },
      DEPS,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_NOT_FOUND')
    expect(orders.refund).not.toHaveBeenCalled()
    expect(db.findCaptureForMerchant).toHaveBeenCalledWith(CAPTURE_ID, MERCHANT_ID)
  })

  it('a capture on another of the merchant’s orders is refused without a PayPal call', async () => {
    db.findCaptureForMerchant.mockResolvedValue(ok(captureRow({ order_id: OTHER_ORDER_ID })))
    const result = await refundForMerchant(
      {
        orderId: ORDER_ID,
        merchantId: MERCHANT_ID,
        actorUserId: ACTOR as never,
        captureId: CAPTURE_ID,
        amount: money(2_000n, 'USD'),
        reason: 'RETURN',
        idempotencyKey: 'form-nonce-abc123',
      },
      DEPS,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_VALIDATION')
    expect(orders.refund).not.toHaveBeenCalled()
  })

  it('EC-REF-2’s local half: a currency that is not the capture’s is refused here, not at PayPal', async () => {
    const result = await refundForMerchant(
      {
        orderId: ORDER_ID,
        merchantId: MERCHANT_ID,
        actorUserId: ACTOR as never,
        captureId: CAPTURE_ID,
        amount: money(2_000n, 'EUR'),
        reason: 'RETURN',
        idempotencyKey: 'form-nonce-abc123',
      },
      DEPS,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_CURRENCY_MISMATCH')
    expect(orders.refund).not.toHaveBeenCalled()
  })

  it('a zero refund is refused here, rather than writing a row and calling PayPal for nothing', async () => {
    const result = await refundForMerchant(
      {
        orderId: ORDER_ID,
        merchantId: MERCHANT_ID,
        actorUserId: ACTOR as never,
        captureId: CAPTURE_ID,
        amount: money(0n, 'USD'),
        reason: 'RETURN',
        idempotencyKey: 'form-nonce-abc123',
      },
      DEPS,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_VALIDATION')
    expect(orders.refund).not.toHaveBeenCalled()
  })

  it('EC-REF-4: an open dispute is propagated as DEF_WRONG_STATE, with its routes', async () => {
    orders.refund.mockResolvedValue(
      err(
        csError('DEF_WRONG_STATE', 'Dispute PP-D-1 is open on this capture', {
          routes: ['POST /v1/customer/disputes/PP-D-1/accept-claim'],
        }),
      ),
    )
    const result = await refundForMerchant(
      {
        orderId: ORDER_ID,
        merchantId: MERCHANT_ID,
        actorUserId: ACTOR as never,
        captureId: CAPTURE_ID,
        amount: 'FULL',
        reason: 'DISPUTE_RESOLUTION',
        idempotencyKey: 'form-nonce-abc123',
      },
      DEPS,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('DEF_WRONG_STATE')
    expect(result.error.details?.['routes']).toEqual([
      'POST /v1/customer/disputes/PP-D-1/accept-claim',
    ])
    expect(db.appendAudit).not.toHaveBeenCalled()
  })

  it('another merchant’s order is 404 before the capture is even looked up', async () => {
    db.findOrderForMerchant.mockResolvedValue(ok(undefined))
    const result = await refundForMerchant(
      {
        orderId: ORDER_ID,
        merchantId: OTHER_MERCHANT_ID,
        actorUserId: ACTOR as never,
        captureId: CAPTURE_ID,
        amount: 'FULL',
        reason: 'RETURN',
        idempotencyKey: 'form-nonce-abc123',
      },
      DEPS,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_NOT_FOUND')
    expect(db.findCaptureForMerchant).not.toHaveBeenCalled()
    expect(orders.refund).not.toHaveBeenCalled()
  })
})
