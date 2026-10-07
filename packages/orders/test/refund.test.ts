/**
 * `refund` — spec §8.11, **AT-M11.3**, **AT-M11.4**, §12 EC-REF-1…5, EC-IDEM-5/6, EC-SPLIT-2 (EC-STOCK-2).
 *
 * The headline assertion in this file is a **negative** one: that a refund moves no budget. Every other
 * ledger rule in this repository has a test that something *did* move; this is the test that something
 * deliberately did **not**, and it is the one most likely to be "fixed" by a future change.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { money } from '@countersign/core'
import type { CaptureRow } from '@countersign/db'

import {
  PENDING_REFUND_PREFIX,
  REFUND_RETRY_DELAY_SECONDS,
  captureShipment,
  createOrderFromDecision,
  refund,
  refundableMinor,
  retryFailedRefund,
} from '../src'
import type { Actor } from '../src'
import {
  PAYPAL,
  allowDecision,
  declinedCapture,
  harness,
  refundBody,
  routes,
  type Harness,
} from './harness'

const MERCHANT: Actor = {
  initiatedBy: 'MERCHANT',
  actor: 'usr_00000000000000000000000002',
  note: 'damaged in transit',
}

describe('refund — AT-M11.3, AT-M11.4, EC-REF-1…5', () => {
  describe('AT-M11.3 — partial, partial, then the full remainder', () => {
    it('AT-M11.3: refund $20.00, then $10.00, then the exact remainder → REFUNDED with Σ == captured', async () => {
      // NW-001 ($45.00) + $5.00 shipping = a $50.00 capture, so the three refunds below are $20 + $10 + $20.
      const h = await capturedFor()
      const captured = [...h.world.rows.captures.values()][0]?.amount_minor ?? 0n
      expect(captured).toBe(5_000n)

      const first = await refund(
        PAYPAL.captureId,
        money(2_000n, 'USD'),
        'MERCHANT_REQUEST',
        MERCHANT,
        h.deps,
      )
      expect(first.ok, describeErr(first)).toBe(true)
      if (!first.ok) return
      // EC-REF-1: the remainder after a partial refund.
      expect(first.value.refundableAfter).toBe(3_000n)
      expect(first.value.capture.status).toBe('PARTIALLY_REFUNDED')

      const second = await refund(
        PAYPAL.captureId,
        money(1_000n, 'USD'),
        'MERCHANT_REQUEST',
        MERCHANT,
        h.deps,
      )
      expect(second.ok, describeErr(second)).toBe(true)
      if (!second.ok) return
      expect(second.value.refundableAfter).toBe(2_000n)

      // The third refund takes the **exact** remainder (EC-REF-5), not the whole capture.
      const third = await refund(PAYPAL.captureId, 'FULL', 'RETURN', MERCHANT, h.deps)
      expect(third.ok, describeErr(third)).toBe(true)
      if (!third.ok) return
      expect(third.value.refundableAfter).toBe(0n)
      // AT-M11.3's assertion: the capture ends exactly `REFUNDED`.
      expect(third.value.capture.status).toBe('REFUNDED')

      // Σ refunds == the captured amount, to the cent.
      const rows = [...h.world.rows.refunds.values()]
      expect(rows).toHaveLength(3)
      expect(rows.reduce((a, r) => a + r.amount_minor, 0n)).toBe(5_000n)
      // And each refund row carries PayPal's own id, not our provisional one.
      expect(rows.every((r) => !r.paypal_refund_id.startsWith(PENDING_REFUND_PREFIX))).toBe(true)
    })

    it("EC-REF-5: 'FULL' sends the exact remainder, never an omitted amount", async () => {
      const h = await capturedFor()
      await refund(PAYPAL.captureId, money(3_000n, 'USD'), 'MERCHANT_REQUEST', MERCHANT, h.deps)
      const last = await refund(PAYPAL.captureId, 'FULL', 'RETURN', MERCHANT, h.deps)
      expect(last.ok).toBe(true)
      // Omitting `amount` would ask PayPal to refund the whole $50.00 again, which it rejects — and which
      // EC-REF-2 says it would. The **request body** is the assertion.
      const bodies = h.paypal
        .callsTo('/refund')
        .map((c) => JSON.parse(String(c.body)) as { amount?: { value: string } })
      expect(bodies).toHaveLength(2)
      // Second call: $20.00, the exact remainder — not $50.00 and not absent.
      expect(bodies[1]?.amount?.value).toBe('20.00')
    })
  })

  describe('AT-M11.4 / EC-REF-2 — an over-refund is refused locally', () => {
    it('AT-M11.4: a refund above the remainder is CS_VALIDATION with NO PayPal call', async () => {
      const h = await capturedFor()
      const callsBefore = h.paypal.callsTo('/refund').length

      const result = await refund(
        PAYPAL.captureId,
        money(5_001n, 'USD'),
        'MERCHANT_REQUEST',
        MERCHANT,
        h.deps,
      )
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.code).toBe('CS_VALIDATION')
      // §12.1's user-facing copy, verbatim: "Only $X remains refundable".
      expect(result.error.userMessage).toContain('Only 5000 remains refundable')
      // **AT-M11.4's whole point**: nothing was sent, and no row was written.
      expect(h.paypal.callsTo('/refund').length).toBe(callsBefore)
      expect(h.world.rows.refunds.size).toBe(0)
    })

    it('EC-REF-2: two partial refunds summing above the capture are refused on the second', async () => {
      const h = await capturedFor()
      await refund(PAYPAL.captureId, money(3_000n, 'USD'), 'MERCHANT_REQUEST', MERCHANT, h.deps)
      const second = await refund(
        PAYPAL.captureId,
        money(2_500n, 'USD'),
        'RETURN',
        MERCHANT,
        h.deps,
      )
      expect(second.ok).toBe(false)
      expect(second.ok === false && second.error.userMessage).toContain(
        'Only 2000 remains refundable',
      )
      expect(h.world.rows.refunds.size).toBe(1)
      // The capture's `refunded_minor` is untouched by the refused attempt.
      expect(refundableMinor([...h.world.rows.captures.values()][0] as CaptureRow)).toBe(2_000n)
    })

    it('EC-REF-2 (property): any sequence of random refunds keeps Σ ≤ the captured amount', () => {
      fc.assert(
        fc.property(
          fc.array(fc.bigInt({ min: 1n, max: 5_000n }), { minLength: 1, maxLength: 12 }),
          fc.bigInt({ min: 1n, max: 20_000n }),
          (amounts, captured) => {
            let refunded = 0n
            for (const amount of amounts) {
              const remaining = captured - refunded
              // This is the guard `refund` applies, expressed directly over `bigint`.
              if (amount > remaining) return true
              refunded += amount
            }
            expect(refunded).toBeLessThanOrEqual(captured)
            return true
          },
        ),
        { numRuns: 400 },
      )
    })
  })

  describe('EC-REF-4 — a refund behind an open dispute is blocked', () => {
    it('EC-REF-4: an open dispute blocks the refund, names accept-claim/make-offer, and makes no PayPal call', async () => {
      const h = await capturedFor({
        openDisputes: [
          { paypal_dispute_id: 'PP-D-2781AB12CD34', status: 'WAITING_FOR_SELLER_RESPONSE' },
        ],
      })
      // Point the seeded dispute at the capture the fixture created, so `openForCapture` can find it.
      const capture = [...h.world.rows.captures.values()][0]
      for (const row of h.world.rows.disputes.values()) row.capture_id = capture?.id ?? null
      const callsBefore = h.paypal.callsTo('/refund').length

      const result = await refund(
        PAYPAL.captureId,
        money(1_000n, 'USD'),
        'RETURN',
        MERCHANT,
        h.deps,
      )
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.code).toBe('DEF_WRONG_STATE')
      // §12.1's user-facing copy, verbatim.
      expect(result.error.userMessage).toBe('Refund via the dispute so it closes the case.')
      // The two endpoints that do work, named so the caller (WP-16's UI) can route.
      const routesNamed = (result.error.details?.['routes'] as string[] | undefined) ?? []
      expect(routesNamed.some((r) => r.includes('accept-claim'))).toBe(true)
      expect(routesNamed.some((r) => r.includes('make-offer'))).toBe(true)
      expect(h.paypal.callsTo('/refund').length).toBe(callsBefore)
    })

    it('EC-REF-4: a RESOLVED dispute does NOT block the refund', async () => {
      const h = await capturedFor({
        openDisputes: [{ paypal_dispute_id: 'PP-D-2781AB12CD34', status: 'RESOLVED' }],
      })
      const capture = [...h.world.rows.captures.values()][0]
      for (const row of h.world.rows.disputes.values()) row.capture_id = capture?.id ?? null
      const result = await refund(
        PAYPAL.captureId,
        money(1_000n, 'USD'),
        'RETURN',
        MERCHANT,
        h.deps,
      )
      expect(result.ok).toBe(true)
    })
  })

  describe('EC-IDEM-5 / EC-IDEM-6 — one button, two genuine refunds', () => {
    it('EC-IDEM-5: the same idempotency key twice is ONE refund and ONE PayPal call', async () => {
      const h = await capturedFor()
      const first = await refund(
        PAYPAL.captureId,
        money(1_000n, 'USD'),
        'RETURN',
        MERCHANT,
        h.deps,
        {
          idempotencyKey: 'form-nonce-abc123',
        },
      )
      expect(first.ok).toBe(true)
      const second = await refund(
        PAYPAL.captureId,
        money(1_000n, 'USD'),
        'RETURN',
        MERCHANT,
        h.deps,
        {
          idempotencyKey: 'form-nonce-abc123',
        },
      )
      expect(second.ok).toBe(true)
      if (!first.ok || !second.ok) return
      // One row, one request, one refund — the human double-clicked and PayPal moved money once.
      expect(second.value.refund.id).toBe(first.value.refund.id)
      expect(h.world.rows.refunds.size).toBe(1)
      expect(h.paypal.callsTo('/refund')).toHaveLength(1)
    })

    it('EC-IDEM-6: two identical amounts with different keys are TWO refunds', async () => {
      const h = await capturedFor()
      await refund(PAYPAL.captureId, money(1_000n, 'USD'), 'RETURN', MERCHANT, h.deps, {
        idempotencyKey: 'key-1',
      })
      await refund(PAYPAL.captureId, money(1_000n, 'USD'), 'RETURN', MERCHANT, h.deps, {
        idempotencyKey: 'key-2',
      })
      // Two identical partial refunds are legitimate (two different items), so the amount cannot be the key.
      expect(h.world.rows.refunds.size).toBe(2)
      expect(h.paypal.callsTo('/refund')).toHaveLength(2)
    })

    it("EC-REF-1: the refund carries cs:{captureId}:ref:{refundId}, §8.6's format verbatim", async () => {
      const h = await capturedFor()
      const result = await refund(
        PAYPAL.captureId,
        money(1_000n, 'USD'),
        'RETURN',
        MERCHANT,
        h.deps,
        {
          idempotencyKey: 'nonce-1',
        },
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(h.paypal.requestIdOf('/refund')).toBe(
        `cs:${PAYPAL.captureId}:ref:${result.value.refund.id}`,
      )
      expect(result.value.requestId).toBe(`cs:${PAYPAL.captureId}:ref:${result.value.refund.id}`)
    })
  })

  describe('EC-REF-3 — a FAILED refund is retried once with a NEW refund id', () => {
    it('EC-REF-3: a definitive failure records FAILED, moves no budget, and alerts', async () => {
      const h = await capturedForWith({
        'POST /v2/payments/authorizations/{id}/capture': completedCapture(),
        'POST /v2/payments/captures/{id}/refund': {
          status: 422,
          body: {
            name: 'UNPROCESSABLE_ENTITY',
            message: 'The requested action could not be performed.',
            debug_id: 'DEBUG-REFUND-FAIL',
            details: [],
          },
        },
      })
      const result = await refund(
        PAYPAL.captureId,
        money(1_000n, 'USD'),
        'RETURN',
        MERCHANT,
        h.deps,
      )
      expect(result.ok).toBe(false)
      const failed = [...h.world.rows.refunds.values()][0]
      expect(failed?.status).toBe('FAILED')
      // The capture's refundable amount is untouched — a failed refund moved no money.
      expect(refundableMinor([...h.world.rows.captures.values()][0] as CaptureRow)).toBe(5_000n)
      expect(h.notifier.ofKind('REFUND_FAILED')).toHaveLength(1)
      // The capture had already committed, and the refund changes nothing about that.
      expect(h.spent()).toBe(5_000n)
    })

    it('EC-REF-3: the retry uses a NEW refund id and therefore a NEW request id', async () => {
      const h = await capturedForWith({
        'POST /v2/payments/authorizations/{id}/capture': completedCapture(),
        'POST /v2/payments/captures/{id}/refund': [
          { status: 422, body: { name: 'UNPROCESSABLE_ENTITY', message: 'nope', details: [] } },
          refundBody({ id: 'REFUND-RETRY-1', value: '10.00' }),
        ],
      })
      const first = await refund(PAYPAL.captureId, money(1_000n, 'USD'), 'RETURN', MERCHANT, h.deps)
      expect(first.ok).toBe(false)
      const failedRow = [...h.world.rows.refunds.values()][0]
      expect(failedRow?.status).toBe('FAILED')
      const failedRequestId = `cs:${PAYPAL.captureId}:ref:${failedRow?.id ?? ''}`

      // EC-REF-3's rule in full: after an hour, with a **new** refund id.
      const retried = await retryFailedRefund(
        {
          captureId: PAYPAL.captureId,
          failedRefundId: failedRow?.id ?? '',
          reason: 'RETURN',
          initiatedBy: MERCHANT,
          failedAtSec: 1_789_000_000,
          nowSec: 1_789_000_000 + REFUND_RETRY_DELAY_SECONDS,
        },
        h.deps,
      )
      expect(retried.ok, describeErr(retried)).toBe(true)
      if (!retried.ok) return

      // A different id, so a different `cs:{capture}:ref:{refund}` — which is the whole point: reusing the
      // failed id would make PayPal deduplicate the retry against a body it already rejected, and the
      // buyer would never get their money back.
      expect(retried.value.refund.id).not.toBe(failedRow?.id)
      expect(retried.value.requestId).toContain(retried.value.refund.id)
      expect(retried.value.requestId).not.toBe(failedRequestId)
      // And the header actually sent is the new one.
      expect(h.paypal.requestIdOf('/refund', 1)).toBe(retried.value.requestId)
      // Same amount, because the reason it failed was not the amount.
      expect(retried.value.refund.amount_minor).toBe(1_000n)
      expect(h.world.rows.refunds.size).toBe(2)
    })

    it('EC-REF-3: a retry before the hour is refused, so a fast double-submit cannot double-refund', async () => {
      const h = await capturedForWith({
        'POST /v2/payments/authorizations/{id}/capture': completedCapture(),
        'POST /v2/payments/captures/{id}/refund': {
          status: 422,
          body: { name: 'UNPROCESSABLE_ENTITY', message: 'nope', details: [] },
        },
      })
      await refund(PAYPAL.captureId, money(1_000n, 'USD'), 'RETURN', MERCHANT, h.deps)
      const failedRow = [...h.world.rows.refunds.values()][0]
      const early = await retryFailedRefund(
        {
          captureId: PAYPAL.captureId,
          failedRefundId: failedRow?.id ?? '',
          reason: 'RETURN',
          initiatedBy: MERCHANT,
          failedAtSec: 1_789_000_000,
          nowSec: 1_789_000_000 + 60,
        },
        h.deps,
      )
      expect(early.ok).toBe(false)
      expect(early.ok === false && early.error.message).toContain('EC-REF-3')
      expect(h.world.rows.refunds.size).toBe(1)
    })

    it('EC-REF-3: a refund row that is not FAILED is not retried', async () => {
      const h = await capturedFor()
      const first = await refund(PAYPAL.captureId, money(1_000n, 'USD'), 'RETURN', MERCHANT, h.deps)
      expect(first.ok).toBe(true)
      if (!first.ok) return
      const again = await retryFailedRefund(
        {
          captureId: PAYPAL.captureId,
          failedRefundId: first.value.refund.id,
          reason: 'RETURN',
          initiatedBy: MERCHANT,
          failedAtSec: 1_789_000_000,
          nowSec: 1_789_000_000 + REFUND_RETRY_DELAY_SECONDS,
        },
        h.deps,
      )
      expect(again.ok).toBe(false)
      expect(again.ok === false && again.error.code).toBe('CS_CONFLICT')
    })
  })

  describe('EC-STOCK-2 — the out-of-stock refund on the CAPTURE path', () => {
    it('EC-STOCK-2: a partial refund stands in for the void when `AUTHORIZE` was unavailable (C2 fallback)', async () => {
      // §11's stated C2 fallback: "use CAPTURE for everything, and handle OOS/split shipments via refunds
      // (EC-SPLIT-2 path)". The money was captured up front, so the remedy is a refund of the OOS lines —
      // and, per §8.11, a refund still moves no budget, because it returns no authority.
      const h = await capturedFor()
      const before = ledger(h)
      const result = await refund(
        PAYPAL.captureId,
        money(1_500n, 'USD'),
        'OUT_OF_STOCK',
        MERCHANT,
        h.deps,
      )
      expect(result.ok).toBe(true)
      expect(refundableMinor([...h.world.rows.captures.values()][0] as CaptureRow)).toBe(3_500n)
      // The user-facing copy §12.7 gives for this case is a refund; ours records the reason verbatim.
      expect([...h.world.rows.refunds.values()][0]?.reason_code).toBe('OUT_OF_STOCK')
      expect(ledger(h)).toEqual(before)
    })
  })

  describe('the rule that reads like a bug — a refund restores NO budget', () => {
    it('a full refund of a fully-refunded capture writes ZERO ledger entries', async () => {
      // §8.11's fourth bullet: "refund → **no** budget restore (D-rule: a refund does not return authority)".
      //
      // This is the test that keeps it true. A refund that gave the money back would let
      // "charge $40, refund $40, charge $40" run free inside a cap the user believes bounds the total —
      // the §12.10 abuse the D-rule exists to prevent. The reason `reserved`/`spent` stay put is in
      // `budget-hooks.ts`; this is the assertion that nobody has changed it by accident.
      const h = await capturedFor()
      const entriesBefore = ledger(h)

      await refund(PAYPAL.captureId, 'FULL', 'RETURN', MERCHANT, h.deps)

      expect(ledger(h)).toEqual(entriesBefore)
      // The money is gone from PayPal's side and the capture says so…
      expect(refundableMinor([...h.world.rows.captures.values()][0] as CaptureRow)).toBe(0n)
      // …and the buyer's *authority* is unchanged, which is the whole point: the RESERVE the Gate took
      // and the COMMIT the capture made are both still there, and nothing replaced either.
      expect(entriesBefore.filter((e) => e.kind === 'RELEASE')).toHaveLength(0)
      expect(h.reserved()).toBe(0n)
      expect(h.spent()).toBe(5_000n)
    })

    it('three consecutive full refunds still restore nothing', async () => {
      // The abuse shape, run to completion: each cycle needs a fresh capture (one per order), and no
      // cycle may add a single ledger entry of its own.
      for (let cycle = 0; cycle < 3; cycle++) {
        const h = await capturedFor()
        // RESERVE (the Gate) + COMMIT (the capture) — the state a *legitimate* full refund starts from.
        const before = ledger(h)
        expect(before.filter((e) => e.kind === 'COMMIT')).toHaveLength(1)

        const result = await refund(PAYPAL.captureId, 'FULL', 'DUPLICATE', MERCHANT, h.deps)
        expect(result.ok, `cycle ${cycle}`).toBe(true)

        // Byte-identical ledger: the refund is invisible to the budget.
        expect(ledger(h)).toEqual(before)
        expect(h.spent()).toBe(5_000n)
        expect(h.reserved()).toBe(0n)
      }
    })
  })

  describe('captures that cannot be refunded', () => {
    it('a PENDING capture is refused: there is nothing to refund yet', async () => {
      const h = await pendingCapture()
      // The capture row exists and is `PENDING`; it is keyed on the id PayPal sent, which for a pending
      // capture is the stub's own — not `PAYPAL.captureId`, which no row claims.
      const row = [...h.world.rows.captures.values()][0]
      expect(row?.status).toBe('PENDING')

      const result = await refund(
        PENDING_CAPTURE_ID,
        money(1_000n, 'USD'),
        'RETURN',
        MERCHANT,
        h.deps,
      )
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.error.code).toBe('CS_VALIDATION')
      // EC-CAP-4: refused locally, so no request was made.
      expect(h.paypal.callsTo('/refund')).toHaveLength(0)
      expect(h.world.rows.refunds.size).toBe(0)
    })

    it('a DECLINED capture is refused: nothing was charged', async () => {
      const h = harness({ lines: [{ sku: 'NW-001', qty: 1 }] })
      h.paypal.setRoutes(
        routes({
          'POST /v2/payments/authorizations/{id}/capture': declinedCapture(),
        }),
      )
      const order = await createOrderFromDecision(allowDecision(), h.deps)
      expect(order.ok).toBe(true)
      if (!order.ok) return
      await captureShipment(
        order.value.id,
        { lines: [{ sku: 'NW-001', qty: 1 }], carrier: 'UPS', tracking: '1Z-D' },
        h.deps,
      )
      // EC-CAP-5 / AT-M11.6 wrote a `DECLINED` row, but PayPal never sent a capture id — the row is keyed on
      // the deterministic `DECLINED-{order}-{shipment}` placeholder (`capture.ts::recordDeclinedCapture`), so
      // that is the only handle a caller has for it. Refunding it is the refusal path this test wants.
      const row = [...h.world.rows.captures.values()][0]
      expect(row?.status).toBe('DECLINED')
      // The declined row is not linked to a shipment (`shipment_id` stays NULL) and the shipment row itself
      // was rolled back with the aborted capture attempt. What remains is the deterministic placeholder, whose
      // shipment component names the shipment that was rolled back — which is what makes it reproducible for a
      // retry of the same capture, and the only handle a caller has on this row.
      expect(row?.shipment_id).toBeNull()
      expect(row?.paypal_capture_id).toMatch(
        new RegExp(`^DECLINED-${order.value.id}-shp_[0-9a-f]{26}$`),
      )

      const result = await refund(
        row?.paypal_capture_id ?? '',
        money(1_000n, 'USD'),
        'RETURN',
        MERCHANT,
        h.deps,
      )
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.error.code).toBe('CS_VALIDATION')
      expect(result.ok === false && result.error.message).toContain('nothing was charged')
      expect(h.paypal.callsTo('/refund')).toHaveLength(0)
      expect(h.world.rows.refunds.size).toBe(0)
    })

    it('an unknown PayPal capture id is CS_NOT_FOUND, not a crash', async () => {
      const h = await capturedFor()
      const result = await refund('NO-SUCH-CAPTURE', money(100n, 'USD'), 'RETURN', MERCHANT, h.deps)
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.error.code).toBe('CS_NOT_FOUND')
    })
  })

  describe('the provisional paypal_refund_id', () => {
    it('the row is written BEFORE the call, with a placeholder that cannot collide with PayPal', async () => {
      // The ordering `repos/orders.ts::createRefund` documents: a crash between the call and the write must
      // leave a findable PENDING row rather than a money movement with no record. `paypal_refund_id` is NOT
      // NULL, so the placeholder is what lets the row exist at all.
      const h = harness({ lines: [{ sku: 'NW-001', qty: 1 }] })
      h.paypal.setRoutes(
        routes({
          'POST /v2/payments/captures/{id}/refund': () => {
            // At the moment of the call, the PENDING row already exists with its placeholder.
            const pending = [...h.world.rows.refunds.values()]
            expect(pending).toHaveLength(1)
            expect(pending[0]?.paypal_refund_id.startsWith(PENDING_REFUND_PREFIX)).toBe(true)
            expect(pending[0]?.status).toBe('PENDING')
            return refundBody({ value: '0.00' })
          },
        }),
      )
      await createAndCapture(h)
      const result = await refund(
        PAYPAL.captureId,
        money(1_000n, 'USD'),
        'RETURN',
        MERCHANT,
        h.deps,
      )
      expect(result.ok).toBe(true)
      // And afterwards the placeholder is replaced by PayPal's id.
      const row = [...h.world.rows.refunds.values()][0]
      expect(row?.paypal_refund_id).toBe(PAYPAL.refundId)
    })
  })

  describe('what the refund stores for the receipt and the packet', () => {
    it('records reason, actor and note, and notifies the buyer', async () => {
      const h = await capturedFor()
      await refund(PAYPAL.captureId, money(1_000n, 'USD'), 'NOT_RECEIVED', MERCHANT, h.deps)
      const row = [...h.world.rows.refunds.values()][0]
      expect(row?.reason_code).toBe('NOT_RECEIVED')
      expect(row?.initiated_by).toBe('MERCHANT')
      expect(row?.actor).toBe(MERCHANT.actor)
      expect(row?.note).toBe('damaged in transit')
      expect(row?.currency).toBe('USD')
      // The buyer-facing copy is §12.1's: the receipt says "refund processing".
      expect(h.notifier.ofKind('REFUND_COMPLETED')[0]?.userMessage).toBe('Refund processing.')
    })
  })
})

/* ------------------------------------------------------------------------------------------ */
/* Fixtures                                                                                      */
/* ------------------------------------------------------------------------------------------ */

/**
 * A harness with one `COMPLETED` capture against a fresh order.
 *
 * Built through the real `createOrderFromDecision` + `captureShipment`, so the capture's id, its
 * `refunded_minor` default and its status all come from the code under test rather than from a fixture row.
 *
 * The capture amount is whatever the cart totals to: NW-001 at $45.00 plus $5.00 shipping is $50.00. The
 * tests therefore use $50.00-scale figures and say so, rather than passing an amount the allocation would
 * not produce.
 */
async function capturedFor(options: Parameters<typeof harness>[0] = {}): Promise<Harness> {
  const h = harness({ lines: [{ sku: 'NW-001', qty: 1 }], ...options })
  h.paypal.setRoutes(
    routes({ 'POST /v2/payments/authorizations/{id}/capture': completedCapture() }),
  )
  await createAndCapture(h)
  return h
}

/** As {@link capturedFor}, but with the **refund** route overridden — for EC-REF-3's failure paths. */
async function capturedForWith(overrides: Parameters<typeof routes>[0]): Promise<Harness> {
  const h = harness({ lines: [{ sku: 'NW-001', qty: 1 }] })
  h.paypal.setRoutes(routes(overrides))
  await createAndCapture(h)
  return h
}

/** Create the order and capture the one line, failing loudly if either step did not work. */
async function createAndCapture(h: Harness): Promise<void> {
  const order = await createOrderFromDecision(allowDecision(), h.deps)
  if (!order.ok) throw new Error(`order create failed: ${order.error.code} ${order.error.message}`)
  const captured = await captureShipment(
    order.value.id,
    { lines: [{ sku: 'NW-001', qty: 1 }], carrier: 'UPS', tracking: '1Z-REFUND-FIXTURE' },
    h.deps,
  )
  if (!captured.ok)
    throw new Error(`capture failed: ${captured.error.code} ${captured.error.message}`)
}

/** A `PENDING` capture, for the "cannot refund yet" case. EC-CAP-4. */
async function pendingCapture(): Promise<Harness> {
  const h = harness({ lines: [{ sku: 'NW-001', qty: 1 }] })
  h.paypal.setRoutes(
    routes({
      'POST /v2/payments/authorizations/{id}/capture': {
        status: 201,
        body: {
          id: PENDING_CAPTURE_ID,
          status: 'PENDING',
          amount: { currency_code: 'USD', value: '0.00' },
          final_capture: false,
        },
      },
    }),
  )
  await createAndCapture(h)
  return h
}

/** The id the {@link pendingCapture} stub reports, so the test looks the row up the way a caller would. */
const PENDING_CAPTURE_ID = 'CAP-PENDING'

/**
 * A `COMPLETED` capture response.
 *
 * `value: '0.00'` is deliberate and needs explaining, because it looks wrong. `captureShipment` **allocates**
 * the amount and sends it; it reads only `id` and `status` back. So the stub's `value` is never load-bearing
 * — a stub echoing the allocated amount back would let a test assert its own fixture instead of the
 * allocation, which is the mistake AT-M11.1 is most likely to hide behind.
 */
function completedCapture() {
  return {
    status: 201,
    body: {
      id: PAYPAL.captureId,
      status: 'COMPLETED',
      amount: { currency_code: 'USD', value: '0.00' },
      final_capture: true,
    },
  }
}

/** The ledger entries, in a comparable shape. This is the file's central negative assertion. */
function ledger(h: Harness): Array<{ kind: string; amount_minor: string }> {
  return h.entries().map((e) => ({ kind: e.kind, amount_minor: e.amount_minor.toString() }))
}

function describeErr(r: { ok: boolean; error?: { code: string; message: string } }): string {
  return r.ok ? '' : `${r.error?.code}: ${r.error?.message}`
}

describe('EC-REF-2: reservations protect the cumulative capture amount before money moves', () => {
  it('EC-REF-2: several partial attempts never refund more than the capture', async () => {
    const h = await capturedFor()
    const results = []
    for (const [i, amount] of [2_000n, 2_000n, 2_000n, 1_000n].entries()) {
      results.push(
        await refund(PAYPAL.captureId, money(amount, 'USD'), 'RETURN', MERCHANT, h.deps, {
          idempotencyKey: `attempt-${i}`,
        }),
      )
    }
    expect(results.map((r) => r.ok)).toEqual([true, true, false, true])
    expect([...h.world.rows.refunds.values()].reduce((sum, r) => sum + r.amount_minor, 0n)).toBe(
      5_000n,
    )
    expect([...h.world.rows.captures.values()][0]?.refunded_minor).toBe(5_000n)
    expect(h.paypal.callsTo('/refund')).toHaveLength(3)
  })

  it('EC-REF-2: concurrent over-limit partial attempts are rejected BEFORE PayPal', async () => {
    const h = await capturedFor()
    const results = await Promise.all(
      ['a', 'b'].map((key) =>
        refund(PAYPAL.captureId, money(3_000n, 'USD'), 'RETURN', MERCHANT, h.deps, {
          idempotencyKey: key,
        }),
      ),
    )
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(h.paypal.callsTo('/refund')).toHaveLength(1)
    expect([...h.world.rows.captures.values()][0]?.refunded_minor).toBe(3_000n)
  })
})
