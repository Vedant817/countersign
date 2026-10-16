import {
  csError,
  err,
  ok,
  type CsError,
  type Money,
  type RefundRowId,
  type Result,
} from '@countersign/core'
import type { CaptureRow, RefundRow } from '@countersign/db'

import { withTxOrAbort } from './deps'
import type { OrdersDeps, Actor, RefundReason } from './types'

/** EC-REF-2 / EC-IDEM-4: reserve before HTTP, under SELECT FOR UPDATE on the capture. */
export async function reserveRefund(
  input: {
    captureId: string
    refundId: RefundRowId
    amount: Money | 'FULL'
    reason: RefundReason
    actor: Actor
    dispute?: { id: string; paypalId: string }
  },
  deps: OrdersDeps,
): Promise<Result<{ refund: RefundRow; capture: CaptureRow; created: boolean }, CsError>> {
  return withTxOrAbort<{ refund: RefundRow; capture: CaptureRow; created: boolean }>(
    deps.store,
    async (tx) => {
      const found = await deps.store.captures.findByPaypalId(input.captureId, tx)
      if (!found.ok) return found
      const capture = found.value
      if (!capture) return err(csError('CS_NOT_FOUND', `No capture ${input.captureId}`))
      if (capture.status === 'PENDING' || capture.status === 'DECLINED') {
        return err(csError('CS_VALIDATION', `Capture ${input.captureId} cannot be refunded`))
      }
      const rows = await deps.store.refunds.findByCapture(capture.id, tx)
      if (!rows.ok) return rows
      const existing = rows.value.find((r) => r.id === input.refundId)
      if (existing) {
        if (
          input.amount !== 'FULL' &&
          (existing.amount_minor !== input.amount.minor ||
            existing.currency !== input.amount.currency)
        ) {
          return err(
            csError(
              'CS_CONFLICT',
              'Refund identity is already bound to a different amount or currency',
            ),
          )
        }
        return ok({ refund: existing, capture, created: false })
      }
      const dispute = await deps.store.disputes.openForCapture(input.captureId, tx)
      if (!dispute.ok) return dispute
      if (
        dispute.value &&
        (!input.dispute ||
          dispute.value.id !== input.dispute.id ||
          dispute.value.paypal_dispute_id !== input.dispute.paypalId)
      ) {
        return err(
          csError(
            'DEF_WRONG_STATE',
            'Refund via the open dispute so PayPal records the resolution',
            { ec: 'EC-REF-4' },
          ),
        )
      }
      if (
        input.dispute &&
        (!dispute.value ||
          input.amount === 'FULL' ||
          dispute.value.amount_minor !== input.amount.minor ||
          dispute.value.currency !== input.amount.currency)
      ) {
        return err(
          csError('CS_CONFLICT', 'Dispute refund must match the open dispute and its exact claim'),
        )
      }
      const pending = rows.value
        .filter(
          (r) =>
            r.status === 'PENDING' &&
            !(
              r.raw &&
              typeof r.raw === 'object' &&
              !Array.isArray(r.raw) &&
              r.raw['cs_capture_applied'] === true
            ),
        )
        .reduce((sum, r) => sum + r.amount_minor, 0n)
      const remaining = capture.amount_minor - capture.refunded_minor - pending
      const amount =
        input.amount === 'FULL' ? { minor: remaining, currency: capture.currency } : input.amount
      if (amount.currency !== capture.currency || amount.minor <= 0n || amount.minor > remaining) {
        return err(
          csError(
            'CS_VALIDATION',
            'Refund exceeds the unreserved capture remainder',
            { ec: 'EC-REF-2' },
            { userMessage: `Only ${remaining} remains refundable.` },
          ),
        )
      }
      const at = new Date(deps.clock.nowMs())
      const inserted = await deps.store.refunds.insert(
        {
          id: input.refundId,
          capture_id: capture.id,
          paypal_refund_id: `pending:${input.refundId}`,
          amount_minor: amount.minor,
          currency: amount.currency,
          status: 'PENDING',
          reason_code: input.reason,
          initiated_by: input.actor.initiatedBy,
          ...(input.actor.actor === undefined ? {} : { actor: input.actor.actor }),
          ...(input.actor.note === undefined ? {} : { note: input.actor.note }),
          ...(input.dispute === undefined
            ? {}
            : {
                raw: {
                  cs_dispute_id: input.dispute.id,
                  cs_paypal_dispute_id: input.dispute.paypalId,
                },
              }),
          created_at: at,
          updated_at: at,
        },
        tx,
      )
      if (!inserted.ok) return inserted
      return ok({ refund: inserted.value, capture, created: true })
    },
  )
}
