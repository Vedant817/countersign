/**
 * Refunds — spec **§8.11** (`refund`), §12.1 **EC-REF-1…5**, §10.2 row 11, **EC-SPLIT-2**, [B12].
 *
 * ## `PayPal-Request-Id` and the EC-REF-3 rule that shapes every id here
 *
 * §8.6 fixes the format: `cs:{captureId}:ref:{refundId}`, where `refundId` is **our** `ref_…` row id. That
 * one format carries three separate guarantees, and it is worth being explicit about each:
 *
 * | Id | Derived from | Guarantees |
 * |---|---|---|
 * | `cs:{capture}:ref:{refund}` | the refund **row** | a retried refund of the same request is the same refund (EC-IDEM-5's double-click) |
 * | a **new** `ref_…` per retry | the **failed** refund's id | EC-REF-3: *"retry once after 1 h with a **new** refund ID, never reuse a failed refund's request ID with a different body"* |
 * | `refundId` from a caller idempotency key | the caller's key | two identical partial refunds are both allowed (EC-IDEM-6) while a double-clicked button is one |
 *
 * The EC-REF-3 rule is the reason {@link deterministicIds.refundRetry} exists and why `refundId` is a
 * *parameter* here rather than a timestamp. A request id is a promise about a body; reusing one with a
 * different body is how a buyer gets two refunds when they asked for one, and PayPal deduplicating on the
 * id means the **second refund silently never happens** — which is the worse failure, because the money
 * looks like it is on its way.
 *
 * ## EC-REF-4: a refund behind an open dispute goes through the dispute
 *
 * A direct `POST /v2/payments/captures/{id}/refund` while a dispute is open pays the buyer **outside the
 * case**, so PayPal records the resolution as an unexplained merchant refund and the merchant still loses
 * the `SELLER_FAVOR` adjudication it had a chance at. §12.1's handling is to block and route through
 * `accept-claim` / `make-offer`, and that is what {@link refund} does: it returns `DEF_WRONG_STATE` with the
 * two endpoints named, and the WP-16 UI calls those instead.
 *
 * ## EC-REF-2 / AT-M11.4: the over-refund guard runs **before** any HTTP request
 *
 * §8.11 AT-M11.4: *"An over-refund is rejected locally (no PayPal call)."* Two independent guards do it:
 * the arithmetic here (so the user gets the exact "only $X remains refundable" message), and the guarded
 * `UPDATE` in `repos/orders.ts::applyRefundToCapture` (so a race between two refunds cannot both pass). The
 * second is the one that makes it structural.
 *
 * ## No budget hook. Read `budget-hooks.ts` before adding one.
 *
 * A refund changes no ledger balance, ever. §8.11's fourth sentence, and the reasoning is written out
 * there: `reserved`/`spent` model **authority**, not wealth, and a refund does not return authority.
 */

import {
  csError,
  err,
  ok,
  toPayPalValue,
  type AttemptId,
  type CsError,
  type Money,
  type OrderId,
  type RefundRowId,
  type Result,
} from '@countersign/core'
import type { CaptureRow, RefundRow } from '@countersign/db'
import { refundRequestId } from '@countersign/paypal'

import { deterministicIds, toJsonValue } from './deps'
import type { Actor, OrdersDeps, RefundReport, RefundReason } from './types'
import { reserveRefund } from './refund-reservation'

/**
 * `amount` is either an exact amount or `'FULL'`.
 *
 * `'FULL'` means **the exact remainder**, not "omit the field". PayPal would refund the whole capture, which
 * after a partial refund is an over-refund PayPal itself rejects (EC-REF-2 says it would). Sending the
 * computed remainder is what makes the third refund of AT-M11.3 land exactly on zero.
 */
export type RefundAmount = Money | 'FULL'

/**
 * The `PayPal-Request-Id` for one refund row. §8.6's format, verbatim.
 *
 * A named function rather than a call at each site, so the id is built in one place — and because a caller
 * that needs to **predict** the id of an idempotent refund (to answer a double-clicked button with no lookup,
 * EC-IDEM-5) can call this instead of re-deriving the string and getting `ref_` wrong.
 */
export function refundRequestIdFor(captureId: string, refundId: RefundRowId): string {
  return refundRequestId(captureId, refundId)
}

export interface RefundInput {
  /** PayPal's capture id — the thing being refunded. §8.11's first argument. */
  readonly captureId: string
  readonly amount: RefundAmount
  readonly reason: RefundReason
  readonly initiatedBy: Actor
  /**
   * The caller's idempotency key (EC-IDEM-5's form nonce).
   *
   * Two refunds of the same amount on the same capture are legitimate (EC-IDEM-6), so the amount cannot be
   * the key; but a double-clicked button must be one refund. Omit it only from a context that has its own
   * dedupe — a job keyed by `(capture, reason)` — and say so in the caller's comment.
   */
  readonly idempotencyKey?: string
  /** `note_to_payer`, 0–255 characters ([B12]). */
  readonly noteToPayer?: string
}

/**
 * Refund a capture, in full or in part. §8.11's `refund`.
 *
 * Sequence:
 *
 *  1. Read the capture. Refuse a capture that holds no money, or that was never completed — a refund against
 *    a `PENDING` or `DECLINED` capture is not a thing PayPal can do, and asking produces a support ticket.
 *  2. **EC-REF-4**: an open dispute on this capture blocks the direct refund and names the two dispute
 *    endpoints instead.
 *  3. **EC-REF-2 / AT-M11.4**: compute the refundable remainder and refuse an over-refund **here**, with no
 *    HTTP request made.
 *  4. Insert the `refunds` row (`PENDING`) **before** the call, so a crash between the two leaves a
 *    findable PENDING row rather than money moving with no record — the ordering `repos/orders.ts::
 *    createRefund` documents.
 *  5. `POST /v2/payments/captures/{id}/refund` with §8.6's `cs:{capture}:ref:{refund}` id.
 *  6. Apply the amount to the capture under the guarded `UPDATE`, and set the capture's status
 *    (`PARTIALLY_REFUNDED` or `REFUNDED`).
 *  7. **No budget hook.** Not an oversight — see the module header and `budget-hooks.ts`.
 */
export async function refund(
  captureId: string,
  amount: RefundAmount,
  reason: RefundReason,
  initiatedBy: Actor,
  deps: OrdersDeps,
  extra: { idempotencyKey?: string; noteToPayer?: string } = {},
): Promise<Result<RefundReport, CsError>> {
  return refundInternal({ captureId, amount, reason, initiatedBy, ...extra }, deps)
}

/**
 * The one implementation. Split out only so EC-REF-3's retry can reuse it with a different refund id —
 * a retry is the same operation with a different id, and duplicating seven steps to say so would be two
 * places to get wrong.
 */
async function refundInternal(
  input: RefundInput,
  deps: OrdersDeps,
): Promise<Result<RefundReport, CsError>> {
  const at = new Date(deps.clock.nowMs())

  const capture = await deps.store.captures.findByPaypalId(input.captureId)
  if (!capture.ok) return capture
  if (!capture.value) {
    return err(
      csError('CS_NOT_FOUND', `No captures row for PayPal capture ${input.captureId}`, {
        table: 'captures',
        paypalCaptureId: input.captureId,
      }),
    )
  }
  const row = capture.value

  if (row.status === 'PENDING') {
    return err(
      csError(
        'CS_VALIDATION',
        `Capture ${input.captureId} is PENDING; there is nothing to refund until it completes`,
        { table: 'captures', id: row.id, status: row.status, ec: 'EC-CAP-4' },
        { userMessage: 'That payment has not completed yet.' },
      ),
    )
  }
  if (row.status === 'DECLINED') {
    return err(
      csError('CS_VALIDATION', `Capture ${input.captureId} was DECLINED; nothing was charged`, {
        table: 'captures',
        id: row.id,
        status: row.status,
        ec: 'EC-CAP-5',
      }),
    )
  }

  // EC-REF-4. Checked before the arithmetic because a blocked refund should not also report a remainder the
  // caller cannot act on.
  const dispute = await deps.store.disputes.openForCapture(input.captureId)
  if (!dispute.ok) return dispute
  if (dispute.value) {
    return err(disputeBlocked(dispute.value.paypal_dispute_id, row))
  }

  const refundId = deterministicIds.refund(input.idempotencyKey, deps.clock.nowMs()) as RefundRowId
  const reserved = await reserveRefund(
    {
      captureId: input.captureId,
      refundId,
      amount: input.amount,
      reason: input.reason,
      actor: input.initiatedBy,
    },
    deps,
  )
  if (!reserved.ok) return reserved
  const requestId = refundRequestId(input.captureId, refundId)
  if (!reserved.value.created) {
    return ok({
      refund: reserved.value.refund,
      capture: reserved.value.capture,
      refundableAfter: refundableMinor(reserved.value.capture),
      requestId,
    })
  }
  const requested: Money = { minor: reserved.value.refund.amount_minor, currency: row.currency }

  const refunded = await deps.paypal.refundCapture(
    input.captureId,
    {
      amount: { currency_code: row.currency, value: toPayPalValue(requested) },
      ...(input.noteToPayer !== undefined ? { note_to_payer: input.noteToPayer } : {}),
    },
    { requestId },
  )

  if (!refunded.ok) {
    if (refunded.error.retryable) {
      // The request may still be in flight at PayPal. The row stays PENDING and the reconciler resolves it
      // (spec §8.12); EC-IDEM-3 says the caller must re-read rather than blindly retry.
      return refunded
    }
    // EC-REF-3: a definitive failure is recorded FAILED and **no** budget movement happens. The retry is
    // {@link retryFailedRefund}, which mints a new refund id.
    const failed = await deps.store.refunds.setStatus(refundId, 'FAILED', refundId, null)
    if (!failed.ok) return failed
    await deps.notify.notify({
      kind: 'REFUND_FAILED',
      orderId: row.order_id as OrderId,
      userId: await userIdOf(deps, row),
      captureId: row.id,
      refundId,
      amount: requested,
      at: Math.floor(at.getTime() / 1000),
      userMessage: 'We could not complete that refund. Our team has been alerted.',
      detail: { ec: 'EC-REF-3', code: refunded.error.code },
    })
    return refunded
  }

  const paypalRefund = refunded.value
  const status = refundStatusFor(paypalRefund.status)

  // The guarded `UPDATE`: `refunded_minor + amount <= amount_minor`. A second concurrent refund is refused
  // here even if it passed the arithmetic above.
  //
  // The adapter runs this inside its own transaction — `repos/orders.ts::applyRefundToCapture` requires an
  // executor, and its guarded `WHERE` clause is only meaningful under one.
  const applied = await deps.store.refunds.applyToCapture(row.id, requested, at)
  if (!applied.ok) return applied

  const stamped = await deps.store.refunds.setStatus(
    refundId,
    status,
    paypalRefund.id,
    toJsonValue({ ...paypalRefund, cs_capture_applied: true }),
  )
  if (!stamped.ok) return stamped

  // AT-M11.3 ends with the capture fully refunded, and the test asserts the status is exactly `REFUNDED`.
  // The comparison is `>=` rather than `===` so a rounding-free over-application cannot leave the row
  // sitting in `PARTIALLY_REFUNDED` forever.
  const fullyRefunded = applied.value.refunded_minor >= applied.value.amount_minor
  const captureStatus = fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED'
  const updated = await deps.store.captures.setStatus(
    row.id,
    captureStatus,
    at,
    toJsonValue(paypalRefund),
  )
  if (!updated.ok) return updated

  await deps.notify.notify({
    kind: 'REFUND_COMPLETED',
    orderId: row.order_id as OrderId,
    userId: await userIdOf(deps, row),
    captureId: row.id,
    refundId,
    amount: requested,
    at: Math.floor(at.getTime() / 1000),
    userMessage: 'Refund processing.',
    detail: { paypalRefundId: paypalRefund.id, captureStatus },
  })

  return ok({
    refund: stamped.value,
    capture: updated.value,
    refundableAfter: refundableMinor(updated.value),
    requestId,
  })
}

/** Prefix for the provisional `paypal_refund_id`. Cannot collide with a PayPal id (uppercase alnum). */
export const PENDING_REFUND_PREFIX = 'pending:'

/** How long EC-REF-3 says to wait before the one retry. */
export const REFUND_RETRY_DELAY_SECONDS = 3_600

/**
 * EC-REF-3: retry a FAILED refund **once**, after an hour, with a **new** refund id.
 *
 * The "new id" half is the load-bearing part and it is structural rather than conventional:
 * {@link deterministicIds.refundRetry} derives the new row's id from the **failed** refund's id, so
 *
 *  - the request id `cs:{capture}:ref:{newRefundId}` is necessarily different from the failed one, which is
 *    what stops PayPal deduplicating the retry against a body it already rejected; and
 *  - the retry is itself deterministic, so retrying *the retry* is still one retry rather than two.
 *
 * `hoursSinceFailure` is a **parameter**, not a clock read, because "has an hour passed" is the job's
 * decision (a cron decides it) and this function should not have its own opinion about the schedule. The
 * guard is here so a caller that ignores the schedule gets a refusal rather than a fast double refund.
 *
 * @returns the new refund's report. The FAILED row is left alone: it is the record of what happened, and
 * `refunds.status` has no `SUPERSEDED` value to mark it with.
 */
export async function retryFailedRefund(
  input: {
    readonly captureId: string
    readonly failedRefundId: string
    readonly reason: RefundReason
    readonly initiatedBy: Actor
    /** Epoch seconds when the original failed. */
    readonly failedAtSec: number
    /** Epoch seconds now, from the injected clock. */
    readonly nowSec: number
  },
  deps: OrdersDeps,
): Promise<Result<RefundReport, CsError>> {
  const waited = input.nowSec - input.failedAtSec
  if (waited < REFUND_RETRY_DELAY_SECONDS) {
    return err(
      csError(
        'CS_VALIDATION',
        `EC-REF-3 says retry after ${REFUND_RETRY_DELAY_SECONDS}s; only ${waited}s have passed`,
        {
          failedRefundId: input.failedRefundId,
          waitedSeconds: waited,
          requiredSeconds: REFUND_RETRY_DELAY_SECONDS,
          ec: 'EC-REF-3',
        },
      ),
    )
  }

  const capture = await deps.store.captures.findByPaypalId(input.captureId)
  if (!capture.ok) return capture
  if (!capture.value) {
    return err(
      csError('CS_NOT_FOUND', `No captures row for PayPal capture ${input.captureId}`, {
        table: 'captures',
        paypalCaptureId: input.captureId,
      }),
    )
  }
  const failedRow = await deps.store.refunds.findById(input.failedRefundId)
  if (!failedRow.ok) return failedRow
  const failed = failedRow.value
  if (!failed || failed.capture_id !== capture.value.id) {
    return err(
      csError('CS_NOT_FOUND', `No refunds row for ${input.failedRefundId}`, {
        table: 'refunds',
        id: input.failedRefundId,
      }),
    )
  }
  if (failed.status !== 'FAILED') {
    return err(
      csError(
        'CS_CONFLICT',
        `Refund ${failed.id} is ${failed.status}; only a FAILED refund is retried`,
        {
          table: 'refunds',
          id: failed.id,
          status: failed.status,
        },
      ),
    )
  }

  // The new row's id, and therefore the new request id. Same amount as the failed attempt, because the
  // reason it failed was not the amount.
  const retryId = deterministicIds.refundRetry(input.captureId, input.failedRefundId)
  return refundInternal(
    {
      captureId: input.captureId,
      // `idempotencyKey: undefined` would mint a *random* id and lose the retry's determinism, so the retry
      // id is passed through the same slot the caller would have used.
      amount: { minor: failed.amount_minor, currency: failed.currency },
      reason: input.reason,
      initiatedBy: {
        ...input.initiatedBy,
        note:
          input.initiatedBy.note ??
          `EC-REF-3 retry of ${failed.id} after ${waited}s (original request id is not reused)`,
      },
      idempotencyKey: retryId,
      // The failed attempt's `note` is our free-text justification, not PayPal's `note_to_payer`, so it is
      // deliberately **not** forwarded: the retry is a new request with its own body.
      noteToPayer: undefined,
    },
    deps,
  )
}

/** How much of a capture is still refundable. Mirrors `repos/orders.ts::refundableMinor`. */
export function refundableMinor(
  capture: Pick<CaptureRow, 'amount_minor' | 'refunded_minor'>,
): bigint {
  const remaining = capture.amount_minor - capture.refunded_minor
  return remaining < 0n ? 0n : remaining
}

/** EC-REF-4's refusal, naming the two endpoints that do work. */
function disputeBlocked(paypalDisputeId: string, capture: CaptureRow): CsError {
  const base = `/v1/customer/disputes/${paypalDisputeId}`
  return csError(
    'DEF_WRONG_STATE',
    `Dispute ${paypalDisputeId} is open on capture ${capture.id}; refund through the dispute so PayPal records the resolution`,
    {
      disputeId: paypalDisputeId,
      captureId: capture.id,
      ec: 'EC-REF-4',
      routes: [`POST ${base}/accept-claim`, `POST ${base}/make-offer`],
    },
    { userMessage: 'Refund via the dispute so it closes the case.' },
  )
}

function refundStatusFor(status: string | undefined): RefundRow['status'] {
  if (status === 'PENDING') return 'PENDING'
  if (status === 'FAILED') return 'FAILED'
  return 'COMPLETED'
}

/**
 * The buyer's user id, for a notification.
 *
 * `''` when the chain cannot be walked, deliberately: a notification with no address is dropped by the
 * transport, whereas an error here would fail a refund that has already succeeded at PayPal.
 */
async function userIdOf(deps: OrdersDeps, capture: CaptureRow): Promise<string> {
  const order = await deps.store.orders.findById(capture.order_id as OrderId)
  if (!order.ok || !order.value) return ''
  const attempt = await deps.store.attempt(order.value.attempt_id as AttemptId)
  if (!attempt.ok || !attempt.value) return ''
  const mandate = await deps.store.mandate(attempt.value.mandate_id as `mdt_${string}`)
  if (!mandate.ok || !mandate.value) return ''
  return mandate.value.user_id
}
