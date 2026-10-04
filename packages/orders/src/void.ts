/**
 * Voiding the remainder — spec **§8.11** (`voidRemainder`), **D17**, §12 **EC-STOCK-1/2**,
 * **EC-MDT-3/4**, §12.5 **EC-TIME-5**, [B12].
 *
 * ## What a void is for
 *
 * An `AUTHORIZE` order holds the buyer's money for up to 29 days. When the merchant will not ship the rest
 * of it — out of stock, cancelled, revoked, or simply abandoned — that hold has to end, and ending it is
 * this function. §8.11's own signature names the four reasons:
 *
 * ```ts
 * voidRemainder(orderId, 'OUT_OF_STOCK' | 'REVOKED' | 'CANCELLED' | 'EXPIRED', deps)
 * ```
 *
 * ## Void vs. final capture: two ways to release the same money
 *
 * This is the distinction that trips people up, so it is worth being precise:
 *
 * | | `captureShipment(…, {finalCapture: true})` | `voidRemainder(…)` |
 * |---|---|---|
 * | PayPal call | `POST /authorizations/{id}/capture` | `POST /authorizations/{id}/void` |
 * | Money released | whatever was **not** captured | **all** of it |
 * | Records | a capture row exists | no capture row; order → `VOIDED` |
 * | Use when | some goods are shipping and the rest will never | **nothing** more will ship |
 *
 * EC-STOCK-1's "1 item unavailable. You were charged only $60.00. $40.00 released" is the first: capture the
 * available line with `final_capture: true`. EC-STOCK-3's race loser, and an abandoned cart, are the second.
 *
 * ## EC-MDT-4: a capture that already happened is not undone by a later revocation
 *
 * §12.4: *"Capture time < `revoked_at` — the purchase stands (it was authorised when made)."* So this
 * function **only** voids what is still uncaptured, and it never touches a `COMPLETED` capture or the money
 * behind it. A buyer who wants that money back has to ask for a refund (§12.4's own user-facing behaviour),
 * because a revocation is a statement about the *future*, not a retraction of the past.
 *
 * ## The ledger, again, on the other side of "asymmetric on purpose"
 *
 * Void → **RELEASE** the uncaptured remainder. A void is exactly the case where authority genuinely ends:
 * the buyer can spend that amount again tomorrow under the same mandate. This is the one place a release is
 * obviously right, and it is the mirror of `budget-hooks.ts`'s refusal to release anything for a refund.
 */

import {
  csError,
  err,
  ok,
  type AttemptId,
  type CsError,
  type MandateId,
  type Money,
  type OrderId,
  type Result,
} from '@countersign/core'
import type { AuthorizationRow, CaptureRow, OrderRow, OrderStatus } from '@countersign/db'
import { RELEASE_REASONS } from '@countersign/ledger'

import { attemptStateFor, notifyReleased } from './budget-hooks'
import { linesOf, moneyHolds } from './capture'
import { toJsonValue } from './deps'
import type { OrdersDeps, VoidReason, VoidReport } from './types'

/**
 * `cs:{authId}:void` — §8.6 names no format for a void, so the same convention applies as for the
 * authorize fallback: **derived from our own ids**, `cs:`-prefixed, header-safe, and stable across retries.
 *
 * Stability is what matters here: a retried void must be the *same* void, or PayPal would be asked to void
 * an authorization twice and the second answer would be a `PP_NOT_FOUND` on an already-void authorization.
 */
export function voidRequestId(authorizationId: string): string {
  return `cs:${authorizationId}:void`
}

/**
 * Release everything still authorized on this order. §8.11's `voidRemainder`.
 *
 * Sequence, and why it is this order:
 *
 *  1. Read the order, its authorization and its captures.
 *  2. **Compute what is still authorized** (`authorized − Σ money-holding captures`) *before* the call. This
 *     is the amount the ledger must release, and computing it first means a failed void leaves the ledger
 *     untouched rather than releasing money PayPal still holds.
 *  3. `POST /v2/payments/authorizations/{id}/void`, with the deterministic request id.
 *  4. Only then: authorization `VOIDED`, order status per reason, attempt state, ledger `RELEASE`, and the
 *     buyer's notification.
 *
 * Step 4 is last on purpose. A void that fails must leave everything as it was — releasing the budget for
 * money PayPal still holds is exactly the "buyer can spend money that is also being spent" bug.
 */
export async function voidRemainder(
  orderId: OrderId,
  reason: VoidReason,
  deps: OrdersDeps,
): Promise<Result<VoidReport, CsError>> {
  const at = new Date(deps.clock.nowMs())

  const order = await deps.store.orders.findById(orderId)
  if (!order.ok) return order
  if (!order.value) {
    return err(
      csError('CS_NOT_FOUND', `No orders row for ${orderId}`, { table: 'orders', id: orderId }),
    )
  }
  const orderRow = order.value

  if (isSettled(orderRow.status)) {
    // Already in a terminal state. `ok` with `alreadySettled`, not an error: a webhook, a sweep and a
    // merchant action can all reach here, and a retry is not a failure.
    return ok({
      released: { minor: 0n, currency: orderRow.currency },
      orderStatus: orderRow.status,
      viaAuthorizationVoid: false,
      alreadySettled: true,
    })
  }

  const auths = await deps.store.authorizations.findByOrder(orderId)
  if (!auths.ok) return auths
  // `PARTIALLY_CAPTURED` counts as **live**: it means some money was captured and a remainder is still
  // authorized, which is exactly the state EC-STOCK-1 and AT-M11.2 void from. Only a *fully* captured,
  // voided or denied authorization has nothing left to release, and §12's [B12] prose agrees — you cannot
  // void a payment that has been fully captured.
  const VOIDABLE: ReadonlySet<AuthorizationRow['status']> = new Set<AuthorizationRow['status']>([
    'CREATED',
    'PENDING',
    'PARTIALLY_CAPTURED',
  ])
  const authorization = auths.value.find((a) => VOIDABLE.has(a.status))
  if (!authorization) {
    return ok({
      released: { minor: 0n, currency: orderRow.currency },
      orderStatus: orderRow.status,
      viaAuthorizationVoid: false,
      alreadySettled: true,
    })
  }

  const captures = await deps.store.captures.findByOrder(orderId)
  if (!captures.ok) return captures
  const authorized = authorization.amount_minor
  const captured = moneyHolds(captures.value)
  const remaining = authorized > captured ? authorized - captured : 0n

  if (remaining === 0n) {
    // Everything was captured. EC-MDT-4: the purchase stands; there is nothing to release.
    return ok({
      released: { minor: 0n, currency: orderRow.currency },
      orderStatus: orderRow.status,
      viaAuthorizationVoid: false,
      alreadySettled: true,
    })
  }

  const voided = await deps.paypal.voidAuthorization(authorization.paypal_authorization_id, {
    requestId: voidRequestId(authorization.paypal_authorization_id),
  })
  if (!voided.ok) return voided

  await deps.store.authorizations.setStatus(authorization.id, 'VOIDED', at)
  const orderStatus = orderStatusFor(reason)
  await deps.store.orders.setStatus(orderId, orderStatus, at)

  const subject = await subjectOf(deps, orderRow)
  if (!subject.ok) return subject

  await deps.store.attempts.setState(
    orderRow.attempt_id as AttemptId,
    attemptStateFor(orderStatus),
    at,
  )

  const released: Money = { minor: remaining, currency: orderRow.currency }
  const hook = await deps.budget.release({
    mandateId: subject.value.mandateId,
    attemptId: subject.value.attemptId,
    captureId: authorization.id,
    amount: released,
    at,
    reason: releaseReasonFor(reason),
  })
  if (!hook.ok) return hook

  // A line that will never ship means the stock must come back. EC-STOCK-3's mirror image: the Gate
  // decrements at `ORDER_CREATED`, and a void puts it back so the item is sellable again.
  const restored = await restoreStock(deps, orderRow, captures.value, at)
  if (!restored.ok) return restored

  await notifyReleased(deps, {
    order: orderRow,
    userId: subject.value.userId,
    amount: released,
    reason,
    at,
  })

  return ok({
    released,
    orderStatus,
    viaAuthorizationVoid: true,
    alreadySettled: false,
  })
}

/* ------------------------------------------------------------------------------------------ */
/* Helpers                                                                                        */
/* ------------------------------------------------------------------------------------------ */

/** Order states from which nothing more can be captured. */
function isSettled(status: OrderStatus): boolean {
  return (
    status === 'VOIDED' ||
    status === 'CANCELLED' ||
    status === 'AUTH_EXPIRED' ||
    status === 'PAYMENT_FAILED'
  )
}

/**
 * The order status a reason implies.
 *
 * `REVOKED` → `CANCELLED` rather than `VOIDED` because §12.4 EC-MDT-3 says so explicitly ("the order is
 * CANCELLED"), and the two are different stories to a buyer: `VOIDED` is a merchant/fulfilment event,
 * `CANCELLED` is "you stopped this". `EXPIRED` → `AUTH_EXPIRED` for EC-TIME-5's "on expiry: state
 * AUTH_EXPIRED, RELEASE".
 */
function orderStatusFor(reason: VoidReason): OrderStatus {
  switch (reason) {
    case 'REVOKED':
      return 'CANCELLED'
    case 'EXPIRED':
      return 'AUTH_EXPIRED'
    case 'OUT_OF_STOCK':
    case 'CANCELLED':
    default:
      return 'VOIDED'
  }
}

/**
 * The ledger's `reason` string.
 *
 * `RELEASE_REASONS` from `@countersign/ledger` covers the ones that have a constant there; `OUT_OF_STOCK` is
 * the spec's own `voidRemainder` reason and is written verbatim, because the ledger stores the reason
 * verbatim and an operator reading it later should see the spec's word rather than a re-invention of it.
 */
function releaseReasonFor(reason: VoidReason): string {
  switch (reason) {
    case 'OUT_OF_STOCK':
      return RELEASE_REASONS.outOfStock
    case 'REVOKED':
      return RELEASE_REASONS.revoked
    case 'CANCELLED':
      return RELEASE_REASONS.cancelled
    case 'EXPIRED':
      return RELEASE_REASONS.expired
    default:
      return RELEASE_REASONS.manual
  }
}

/** `mandates.id`, `user_id` and the attempt id behind an order. */
async function subjectOf(
  deps: OrdersDeps,
  order: OrderRow,
): Promise<Result<{ mandateId: MandateId; attemptId: AttemptId; userId: string }, CsError>> {
  const attempt = await deps.store.attempt(order.attempt_id as AttemptId)
  if (!attempt.ok) return attempt
  if (!attempt.value) {
    return err(
      csError('CS_NOT_FOUND', `No checkout_attempts row for ${order.attempt_id}`, {
        table: 'checkout_attempts',
        id: order.attempt_id,
      }),
    )
  }
  const mandateId = attempt.value.mandate_id as MandateId
  const mandate = await deps.store.mandate(mandateId)
  if (!mandate.ok) return mandate
  if (!mandate.value) {
    return err(
      csError('CS_NOT_FOUND', `No mandates row for ${mandateId}`, {
        table: 'mandates',
        id: mandateId,
      }),
    )
  }
  return ok({ mandateId, attemptId: attempt.value.id, userId: mandate.value.user_id })
}

/**
 * Put back the stock for the lines that were never captured. §8.9, EC-STOCK-1.
 *
 * The unshipped lines are the cart's lines **minus** the lines covered by a capture that holds money, so a
 * split shipment that shipped one of two items restores one of them rather than the whole cart. The
 * decrement happened at `ORDER_CREATED` (§8.9, the Gate's side), so the restore is what makes the item
 * sellable again — EC-STOCK-3's mirror image, where the race loser gets its unit back.
 *
 * The arithmetic is the reason this function needs the cart at all: the captures know *what shipped*, and
 * only the cart knows *what was bought*.
 *
 * **Best-effort, and deliberately so.** Stock is the merchant's operational state. Failing a
 * `voidRemainder` because a stock row was missing would leave the buyer's money released *and* the order
 * un-voided — strictly worse than a stale stock count, which the next catalog read reconciles. So a failure
 * is logged and the void stands.
 *
 * `deps.stock` is optional, so a deployment with no catalog wired in still voids correctly; it just does not
 * restock. That is a visible, loggable gap rather than a silent one.
 */
async function restoreStock(
  deps: OrdersDeps,
  order: OrderRow,
  captures: readonly CaptureRow[],
  at: Date,
): Promise<Result<void, CsError>> {
  const restock = deps.stock
  if (!restock) {
    deps.logger?.warn('no stock port configured; voided order will not restock', {
      orderId: order.id,
    })
    return ok(undefined)
  }

  const attempt = await deps.store.attempt(order.attempt_id as AttemptId)
  if (!attempt.ok) return attempt
  if (!attempt.value) return ok(undefined)
  const session = await deps.store.checkoutSession(
    attempt.value.checkout_session_id as `chk_${string}`,
  )
  if (!session.ok) return session
  if (!session.value) return ok(undefined)

  const shipped = new Map<string, number>()
  for (const capture of captures) {
    if (!holdsMoney(capture)) continue
    const rows = await deps.store.shipments.findByOrder(order.id)
    if (!rows.ok) return rows
    for (const shipment of rows.value) {
      if (shipment.id !== capture.shipment_id) continue
      for (const line of linesOf(shipment.lines)) {
        shipped.set(line.sku, (shipped.get(line.sku) ?? 0) + line.qty)
      }
    }
  }

  const outstanding = cartLinesOf(session.value.cart)
    .map((line) => ({ sku: line.sku, qty: line.qty - (shipped.get(line.sku) ?? 0) }))
    .filter((line) => line.qty > 0)
  if (outstanding.length === 0) return ok(undefined)

  const restored = await restock(outstanding, at)
  if (!restored.ok) {
    deps.logger?.error('could not restore stock for a voided order', {
      orderId: order.id,
      code: restored.error.code,
    })
    return ok(undefined)
  }
  return ok(undefined)
}

/** Whether a capture holds or took money — the same predicate `moneyHolds` uses, per row. */
function holdsMoney(capture: CaptureRow): boolean {
  return capture.status !== 'DECLINED' && capture.status !== 'REVERSED'
}

/** `{lines: [{sku, qty, unit_minor}]}` out of `checkout_sessions.cart`. */
function cartLinesOf(cart: unknown): { sku: string; qty: number; unitMinor: bigint }[] {
  const lines =
    typeof cart === 'object' && cart !== null && 'lines' in cart
      ? (cart as { lines?: unknown }).lines
      : undefined
  if (!Array.isArray(lines)) return []
  const out: { sku: string; qty: number; unitMinor: bigint }[] = []
  for (const raw of lines) {
    const line = raw as { sku?: unknown; qty?: unknown; unit_minor?: unknown }
    const unitMinor =
      typeof line.unit_minor === 'bigint'
        ? line.unit_minor
        : typeof line.unit_minor === 'string' && /^\d+$/.test(line.unit_minor)
          ? BigInt(line.unit_minor)
          : 0n
    if (typeof line.sku !== 'string' || typeof line.qty !== 'number') continue
    out.push({ sku: line.sku, qty: line.qty, unitMinor })
  }
  return out
}

export { toJsonValue, attemptStateFor }

/** Re-exported so a caller can classify a capture without importing `capture.ts`. */
export type { AuthorizationRow }
