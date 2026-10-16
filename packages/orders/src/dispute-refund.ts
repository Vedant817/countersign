import { createHash } from 'node:crypto'

import {
  csError,
  err,
  fromPayPalValue,
  ok,
  type CsError,
  type Money,
  type RefundRowId,
  type Result,
} from '@countersign/core'
import { disputeActionRequestId, type PayPalClient } from '@countersign/paypal'

import { deterministicIds, toJsonValue, withTxOrAbort } from './deps'
import { reserveRefund } from './refund-reservation'
import type { OrdersDeps } from './types'

export interface DisputeRefundInput {
  readonly captureId: string
  readonly disputeId: string
  readonly paypalDisputeId: string
  readonly amount: Money
  readonly idempotencyKey: string
  readonly actor: string
}

export interface DisputeRefundOutcome {
  readonly refundId: string
  readonly paypalRefundId?: string
  readonly amount: Money
  readonly status: 'PENDING' | 'COMPLETED'
  readonly requestId: string
  readonly paypalCall?: 'acceptClaim'
}

/** Identity includes the claim, never the job clock, actor, reason or raw webhook body. */
export function disputeRefundKey(disputeId: string, amount: Money): string {
  return `cs:${disputeId}:refund:${amount.minor}:${amount.currency}`
}

export function disputeRefundRequestId(disputeId: string, amount: Money): string {
  const digest = createHash('sha256')
    .update(disputeRefundKey(disputeId, amount))
    .digest('hex')
    .slice(0, 26)
  return disputeActionRequestId(disputeId as `dsp_${string}`, 'claim', digest)
}

function matchesAmount(value: unknown, expected: Money): boolean {
  if (
    value === null ||
    typeof value !== 'object' ||
    !('currency_code' in value) ||
    value.currency_code !== expected.currency ||
    !('value' in value) ||
    typeof value.value !== 'string'
  )
    return false
  try {
    return fromPayPalValue(value.value, expected.currency).minor === expected.minor
  } catch {
    return false // malformed provider money is never evidence of a completed refund
  }
}

/**
 * EC-REF-4: accept REFUND through the case, never through /captures/.../refund.
 * PayPal defines REFUND as the entire dispute amount (not the entire capture).
 * An immutable dispute-only row identity refuses changed claims even though the HTTP identity binds amount.
 * An uncertain POST consumes the reservation: reconcile manually, never replay a non-idempotent endpoint.
 */
export async function refundViaDispute(
  input: DisputeRefundInput,
  deps: OrdersDeps,
  paypal: Pick<PayPalClient, 'getDispute' | 'acceptClaim'>,
): Promise<Result<DisputeRefundOutcome, CsError>> {
  if (input.idempotencyKey !== disputeRefundKey(input.disputeId, input.amount)) {
    return err(csError('CS_VALIDATION', 'Dispute refund requires the stable claim idempotency key'))
  }
  const refundId = deterministicIds.refund(`dispute:${input.disputeId}`, 0) as RefundRowId
  const requestId = disputeRefundRequestId(input.disputeId, input.amount)
  const reserved = await reserveRefund(
    {
      captureId: input.captureId,
      refundId,
      amount: input.amount,
      reason: 'MERCHANT_REQUEST',
      actor: { initiatedBy: 'MERCHANT', actor: input.actor },
      dispute: { id: input.disputeId, paypalId: input.paypalDisputeId },
    },
    deps,
  )
  if (!reserved.ok) return reserved
  const { refund, capture, created } = reserved.value
  const outcome = (
    status: 'PENDING' | 'COMPLETED',
    paypalRefundId?: string,
  ): DisputeRefundOutcome => ({
    refundId,
    amount: input.amount,
    status,
    requestId,
    ...(paypalRefundId === undefined ? {} : { paypalRefundId }),
  })
  if (!created) {
    if (
      refund.raw &&
      typeof refund.raw === 'object' &&
      !Array.isArray(refund.raw) &&
      refund.raw['cs_paypal_dispute_id'] !== input.paypalDisputeId
    ) {
      return err(csError('CS_CONFLICT', 'Dispute refund is bound to another PayPal dispute'))
    }
    return ok(
      outcome(
        refund.status === 'COMPLETED' ? 'COMPLETED' : 'PENDING',
        refund.paypal_refund_id.startsWith('pending:') ? undefined : refund.paypal_refund_id,
      ),
    )
  }
  const fresh = await paypal.getDispute(input.paypalDisputeId)
  if (!fresh.ok) return fresh
  const d = fresh.value
  const transactions = d.disputed_transactions ?? []
  // A case spanning multiple captures is not safe to accept as a refund of one capture.
  if (
    d.dispute_id !== input.paypalDisputeId ||
    !matchesAmount(d.dispute_amount, input.amount) ||
    transactions.length !== 1 ||
    transactions[0]?.seller_transaction_id !== input.captureId ||
    !(d.links ?? []).some((l) => l.rel === 'accept-claim' && l.method === 'POST') ||
    !(d.allowed_response_options?.accept_claim?.accept_claim_types ?? []).includes('REFUND')
  ) {
    return err(
      csError(
        'DEF_WRONG_STATE',
        'Live dispute does not permit a REFUND of this exact claim; reservation retained for review',
      ),
    )
  }
  const order = await deps.store.orders.findById(capture.order_id as `ord_${string}`)
  if (!order.ok) return order
  if (!order.value) return err(csError('CS_NOT_FOUND', 'Dispute refund has no order'))
  const before = await deps.paypal.getOrder(order.value.paypal_order_id)
  if (!before.ok) return before
  const refundIds = (o: typeof before.value) =>
    (o.purchase_units ?? [])
      .flatMap((u) => u.payments?.refunds ?? [])
      .flatMap((r) => (r.id === undefined ? [] : [r.id]))
  const previousIds = new Set(refundIds(before.value))
  const sent = await paypal.acceptClaim(
    input.paypalDisputeId,
    { accept_claim_type: 'REFUND' },
    { requestId },
  )
  if (!sent.ok) return sent // no automated retry or released reservation on an uncertain money operation
  const resolved = await paypal.getDispute(input.paypalDisputeId)
  if (!resolved.ok) return ok({ ...outcome('PENDING'), paypalCall: 'acceptClaim' })
  const resolution = resolved.value['dispute_outcome']
  if (
    resolved.value.dispute_id !== input.paypalDisputeId ||
    resolved.value.status !== 'RESOLVED' ||
    resolution === null ||
    typeof resolution !== 'object' ||
    !('amount_refunded' in resolution) ||
    !matchesAmount(resolution.amount_refunded, input.amount)
  ) {
    return ok({ ...outcome('PENDING'), paypalCall: 'acceptClaim' })
  }
  const after = await deps.paypal.getOrder(order.value.paypal_order_id)
  if (!after.ok) return ok({ ...outcome('PENDING'), paypalCall: 'acceptClaim' })
  const candidates = [...new Set(refundIds(after.value))].filter((id) => !previousIds.has(id))
  if (candidates.length !== 1) return ok({ ...outcome('PENDING'), paypalCall: 'acceptClaim' })
  const actual = await deps.paypal.getRefund(candidates[0] ?? '')
  if (!actual.ok || !actual.value.amount || actual.value.status !== 'COMPLETED') {
    return ok({ ...outcome('PENDING'), paypalCall: 'acceptClaim' })
  }
  const links = actual.value['links']
  // Verify attribution through the refund's documented 'up' link, not just a matching amount.
  const attributed =
    Array.isArray(links) &&
    links.some(
      (l: unknown) =>
        l !== null &&
        typeof l === 'object' &&
        'rel' in l &&
        l.rel === 'up' &&
        'href' in l &&
        typeof l.href === 'string' &&
        l.href.endsWith(`/v2/payments/captures/${input.captureId}`),
    )
  if (
    actual.value.id !== candidates[0] ||
    !matchesAmount(actual.value.amount, input.amount) ||
    !attributed
  ) {
    return ok({ ...outcome('PENDING'), paypalCall: 'acceptClaim' })
  }
  const at = new Date(deps.clock.nowMs())
  const applied = await withTxOrAbort(deps.store, async (tx) => {
    const locked = await deps.store.captures.findByPaypalId(input.captureId, tx)
    if (!locked.ok) return locked
    const updated = await deps.store.refunds.applyToCapture(capture.id, input.amount, at, tx)
    if (!updated.ok) return updated
    const stamped = await deps.store.refunds.setStatus(
      refundId,
      'COMPLETED',
      actual.value.id,
      toJsonValue({
        ...actual.value,
        cs_dispute_id: input.disputeId,
        cs_paypal_dispute_id: input.paypalDisputeId,
        cs_capture_applied: true,
      }),
      tx,
    )
    if (!stamped.ok) return stamped
    return deps.store.captures.setStatus(
      capture.id,
      updated.value.refunded_minor === capture.amount_minor ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
      at,
      undefined,
      tx,
    )
  })
  if (!applied.ok) return applied
  return ok({ ...outcome('COMPLETED', actual.value.id), paypalCall: 'acceptClaim' })
}

/** Composition root adapter: Defender supplies our capture id; payments APIs need PayPal's id. */
export function defenderRefundsFromOrders(
  deps: OrdersDeps,
  paypal: Pick<PayPalClient, 'getDispute' | 'acceptClaim'>,
) {
  return {
    async refund(
      input: Omit<DisputeRefundInput, 'captureId'> & {
        captureId: string
        reason: string
        ruleId: string
      },
    ): Promise<Result<DisputeRefundOutcome, CsError>> {
      const capture = await deps.store.captures.findById(input.captureId)
      if (!capture.ok) return capture
      if (!capture.value) return err(csError('CS_NOT_FOUND', 'No capture for the dispute refund'))
      return refundViaDispute(
        { ...input, captureId: capture.value.paypal_capture_id },
        deps,
        paypal,
      )
    },
  }
}
