/**
 * The budget ledger hooks — spec **§8.11** ("Budget ledger hooks"), **D19**, §12 **EC-CAP-4/5**,
 * **EC-MDT-3**, §12.5 **EC-TIME-5**.
 *
 * ## The four bullets, and why they are not symmetric
 *
 * §8.11 states the hooks as four sentences, and three of them are about *movement*:
 *
 * ```
 * capture COMPLETED → COMMIT;
 * void/decline/expiry → RELEASE;
 * refund → no budget restore (D-rule: a refund does not return authority);
 * chargeback reversal → REVERSE entry for the audit only.
 * ```
 *
 * Read as a table, the reason each one exists is **when the user's signed authority ends**:
 *
 * | Event | What happened to the authority | Movement |
 * |---|---|---|
 * | capture `COMPLETED` | money left under a valid mandate | `reserved → spent` |
 * | void | the rest of the money will never be captured | give the claim back |
 * | decline | it was never obtained | give the claim back |
 * | expiry | the authorization timed out | give the claim back |
 * | **refund** | **nothing** | **none** |
 * | chargeback reversed | nothing — the money was always spent | audit entry only |
 *
 * ## Why a refund restores nothing — read this before "fixing" it
 *
 * A buyer refunds $40 of a $60 order and their `available` does not move by $40. That looks like a bug,
 * and it is the spec's explicit decision, stated twice: §8.11's fourth sentence and the "D-rule" it
 * cites.
 *
 * The reason is that **`reserved`/`spent` model authority, not wealth.** `available` answers "how much
 * may this agent still spend under this mandate?", and a refund changes no one's answer to that:
 *
 *  - The buyer signed for up to $130 at Northwind. A $40 refund does not narrow that mandate; only the
 *    user revoking it, or the cap changing, does. Making a refund restore budget would let the
 *    **merchant** widen a signed limit by refunding, which turns a payment into a withdrawal primitive.
 *  - The alternative failure is worse, and is exactly the abuse §12.10 exists to prevent: if a refund
 *    restored budget then "charge $60, refund $60, charge $60" would be free, and a merchant or a
 *    compromised agent could move money in circles inside a cap the user believes bounds the *total*,
 *    not the *outstanding*.
 *  - What a refund *does* change is the reconciliation line — the buyer got $40 back, the merchant's net
 *    is lower — and that lives in `captures.refunded_minor` and the `refunds` rows, which is where the
 *    evidence packet reads it from.
 *
 * So: **no hook exists for a refund, and the `BudgetHooks` port has no method a refund could call.**
 * `refund.ts` says the same at the call site and `test/refund.test.ts` asserts the ledger is untouched
 * across a full refund — as a test, because "the absence of a call" is exactly the kind of rule that
 * gets refactored away by someone who read it as an oversight.
 *
 * ## Why `REVERSE` moves nothing either
 *
 * Same reasoning, and `packages/db/repos/budget.ts` states it for `reverseIn`: a chargeback is a dispute
 * outcome, not a return of permission. The entry exists so the packet and the nightly reconciliation can
 * both show that it happened. If a reversal restored budget, "charge → chargeback → repeat" would let a
 * merchant exceed a signed cap indefinitely, and the cap would stop being a cap.
 *
 * ## Why the notification builders live in this file
 *
 * Because every one of them describes a **ledger or settlement transition**, which is this file's
 * subject: a decline, a pending hold, a settled authorization, a released remainder. EC-CAP-5's "notify
 * the user" is not a separate concern from the hook — the notification is what the hook's outcome means
 * to a human.
 */

import {
  err,
  ok,
  type AttemptId,
  type CsError,
  type MandateId,
  type Money,
  type OrderId,
  type Result,
} from '@countersign/core'
import type {
  AuthorizationRow,
  CaptureRow,
  CaptureStatus,
  OrderRow,
  OrderStatus,
} from '@countersign/db'
import { RELEASE_REASONS } from '@countersign/ledger'

import type { BudgetHookOutcome, OrderNotification, OrdersDeps } from './types'

/**
 * The four capture states a ledger hook reacts to.
 *
 * `PARTIALLY_REFUNDED` and `REFUNDED` are **not** here, and their absence is the point: they are refund
 * states, and §8.11 gives a refund no hook. Listing them would invite a mapping to `COMMIT` or `RELEASE`,
 * both of which would be wrong.
 */
export type CaptureOutcome = 'COMPLETED' | 'PENDING' | 'DECLINED' | 'REVERSED'

/** Map a stored `captures.status` onto the hook vocabulary, or `undefined` when it is a refund state. */
export function outcomeFor(status: CaptureStatus): CaptureOutcome | undefined {
  switch (status) {
    case 'COMPLETED':
      return 'COMPLETED'
    case 'PENDING':
      return 'PENDING'
    case 'DECLINED':
      return 'DECLINED'
    case 'REVERSED':
      return 'REVERSED'
    case 'PARTIALLY_REFUNDED':
    case 'REFUNDED':
      return undefined
    default:
      return undefined
  }
}

/**
 * `Σ captures` for an authorization, counting **only the states that hold or took money**.
 *
 * `PENDING` counts: an eCheck or a review hold has PayPal's money earmarked (EC-CAP-4), so treating it
 * as uncaptured would let a second capture take the same dollars.
 *
 * `DECLINED` and `REVERSED` do not count: neither took money, and counting them would shrink the
 * remainder that the EC-CAP-3 over-capture check is allowed to spend.
 *
 * This is why the orchestrator sums the rows itself rather than calling
 * `repos/orders.ts::sumCapturedForAuthorization`, which sums every row including those two. Reported as
 * a contract issue in `README.md`.
 */
export async function capturedMinorForAuthorization(
  deps: OrdersDeps,
  authorization: AuthorizationRow,
  at?: Date,
): Promise<Result<bigint, CsError>> {
  const rows = await deps.store.captures.findByOrder(authorization.order_id as OrderId)
  if (!rows.ok) return rows
  let total = 0n
  for (const row of rows.value) {
    if (row.authorization_id !== authorization.id) continue
    if (row.status === 'DECLINED' || row.status === 'REVERSED') continue
    total += row.amount_minor
  }
  void at
  return ok(total)
}

/**
 * `authorized − Σ captures`: how much of the authorization is still uncaptured.
 *
 * "Remaining" here means *money-holding*, so it agrees with {@link capturedMinorForAuthorization} by
 * construction — the over-capture check and the release amount are computed from the same sum, and two
 * sums disagreeing is how an authorization ends up released twice or captured twice.
 *
 * Clamped at `0n`: a store that disagrees with itself should under-report the remainder and refuse a
 * capture, never report a negative one and then compute a refundable amount from it.
 */
export async function remainingAuthorized(
  deps: OrdersDeps,
  authorization: AuthorizationRow,
  at?: Date,
): Promise<Result<bigint, CsError>> {
  const captured = await capturedMinorForAuthorization(deps, authorization, at)
  if (!captured.ok) return captured
  const remaining = authorization.amount_minor - captured.value
  return ok(remaining < 0n ? 0n : remaining)
}

export interface CaptureOutcomeInput {
  readonly deps: OrdersDeps
  readonly order: OrderRow
  readonly authorization: AuthorizationRow | null
  readonly capture: CaptureRow
  readonly outcome: CaptureOutcome
  readonly at: Date
  /**
   * `authorized − Σ captures` **after** this capture, when the caller already knows it.
   *
   * `captureShipment` does know it (it computed the amount); a webhook or the reconciler does not, so
   * `undefined`/`null` means "read it from the store". The parameter exists so the common path does not
   * re-read the same rows.
   */
  readonly remainingAfter?: bigint | null
}

export interface CaptureOutcomeReport {
  readonly outcome: CaptureOutcome
  /** What the ledger did. `null` for `PENDING`, which moves nothing (EC-CAP-4). */
  readonly hook: BudgetHookOutcome | null
  /** The order status written, or `null` when the outcome leaves it alone (a reversal does). */
  readonly orderStatus: OrderStatus | null
  /** The authorization status written, or `null`. */
  readonly authorizationStatus: 'PARTIALLY_CAPTURED' | 'CAPTURED' | 'DENIED' | null
  /** The notification that was emitted, if any. */
  readonly notification: OrderNotification | null
}

/**
 * Apply the §8.11 hook for one capture outcome, and keep the order, attempt and authorization in step.
 *
 * Called from two places, which is why it is a separate function and not inlined into `captureShipment`:
 *
 *  - `captureShipment`, for a synchronous `COMPLETED` / `PENDING` / `DECLINED` answer;
 *  - **WP-12** (`packages/webhooks`) when `PAYMENT.CAPTURE.COMPLETED` / `.DECLINED` / `.REVERSED`
 *    arrives, and from its reconciler for the same states. EC-CAP-4's "ship nothing until
 *    `PAYMENT.CAPTURE.COMPLETED`" is only a rule if something downstream of the webhook performs the
 *    commit, and that something is here.
 *
 * **Idempotent by construction.** `captureShipment` already ran the `COMPLETED` hook and the webhook
 * that follows must not run it twice; the ledger entry ids are derived from the capture id, so the
 * second call reports `alreadySettled` and changes nothing.
 */
export async function applyCaptureOutcome(
  input: CaptureOutcomeInput,
): Promise<Result<CaptureOutcomeReport, CsError>> {
  const { deps, order, capture, outcome, at } = input
  const subject = await resolveSubject(deps, order)
  if (!subject.ok) return subject
  const { mandateId, attemptId, userId } = subject.value
  const authorization = input.authorization
  const amount: Money = { minor: capture.amount_minor, currency: capture.currency }

  const remaining =
    input.remainingAfter === undefined || input.remainingAfter === null
      ? authorization
        ? await remainingAuthorized(deps, authorization, at)
        : ok(0n)
      : ok(input.remainingAfter)

  if (outcome === 'PENDING') {
    // EC-CAP-4: money is neither spent nor released. The capture holds funds at PayPal, but nothing
    // ships and no ledger entry is written until `COMPLETED` or `DECLINED` arrives.
    await deps.store.orders.setStatus(order.id, 'PENDING_REVIEW', at)
    await deps.store.attempts.setState(attemptId, 'PENDING_REVIEW', at)
    const notification = await notifyPending(deps, { order, capture, userId, at })
    return ok({
      outcome,
      hook: null,
      orderStatus: 'PENDING_REVIEW',
      authorizationStatus: null,
      notification,
    })
  }

  if (outcome === 'COMPLETED') {
    // The one hook that spends the buyer's budget: `reserved → spent`, for exactly the amount captured.
    // Both legs move, so `reserved + spent` is unchanged and the cap stays satisfied.
    const committed = await deps.budget.commit({ mandateId, captureId: capture.id, amount, at })
    if (!committed.ok) return committed
    const closed = !remaining.ok ? false : remaining.value === 0n
    const orderStatus: OrderStatus = closed ? 'CAPTURED' : 'PARTIALLY_CAPTURED'
    const authorizationStatus = closed ? 'CAPTURED' : 'PARTIALLY_CAPTURED'
    await deps.store.orders.setStatus(order.id, orderStatus, at)
    await deps.store.attempts.setState(attemptId, attemptStateFor(orderStatus), at)
    if (authorization) {
      await deps.store.authorizations.setStatus(authorization.id, authorizationStatus, at)
    }
    // Only a *closed* authorization is news for the buyer. A partial capture is the receipt's
    // "charged $60.00 of $100.00, $40.00 still held" line, not a notification.
    const notification = closed ? await notifySettled(deps, { order, capture, userId, at }) : null
    return ok({ outcome, hook: committed.value, orderStatus, authorizationStatus, notification })
  }

  if (outcome === 'DECLINED') {
    // EC-CAP-5 + AT-M11.6: the reservation goes back, the order is `PAYMENT_FAILED`, the user is told,
    // and **nothing is retried**. The mandate binds one instrument, so an automatic retry could only
    // reach for a different one — a decision the user never delegated to an agent.
    const released = await deps.budget.release({
      mandateId,
      attemptId,
      captureId: capture.id,
      amount,
      at,
      // `DECLINED` is not one of `RELEASE_REASONS`' values, and it is not a Gate outcome: this is the
      // orchestrator's own release, recorded verbatim so the ledger says why the money came back.
      reason: 'DECLINED',
    })
    if (!released.ok) return released
    await deps.store.orders.setStatus(order.id, 'PAYMENT_FAILED', at)
    await deps.store.attempts.setState(attemptId, 'DECLINED', at)
    if (authorization) {
      await deps.store.authorizations.setStatus(authorization.id, 'DENIED', at)
    }
    const notification = await notifyDecline(deps, { order, capture, userId, at })
    return ok({
      outcome,
      hook: released.value,
      orderStatus: 'PAYMENT_FAILED',
      authorizationStatus: 'DENIED',
      notification,
    })
  }

  // `REVERSED`: audit only. The money was captured under a valid mandate, so it stays spent and the order
  // keeps its state; the entry is the record a dispute packet needs. See the module header for why this
  // must not restore anything.
  const reversed = await deps.budget.reverse({ mandateId, captureId: capture.id, amount, at })
  if (!reversed.ok) return reversed
  return ok({
    outcome: 'REVERSED',
    hook: reversed.value,
    orderStatus: null,
    authorizationStatus: null,
    notification: null,
  })
}

/** `mandates.id`, `user_id` and the attempt id for an order. One attempt read, one mandate read. */
async function resolveSubject(
  deps: OrdersDeps,
  order: OrderRow,
): Promise<Result<{ mandateId: MandateId; attemptId: AttemptId; userId: string }, CsError>> {
  const attempt = await deps.store.attempt(order.attempt_id as AttemptId)
  if (!attempt.ok) return attempt
  const row = attempt.value
  if (!row) {
    return err(
      internalError(`No checkout_attempts row for ${order.attempt_id}; the order has no mandate`),
    )
  }
  const mandateId = row.mandate_id as MandateId
  const mandate = await deps.store.mandate(mandateId)
  if (!mandate.ok) return mandate
  if (!mandate.value) {
    return err(internalError(`No mandates row for ${mandateId}`))
  }
  return ok({ mandateId, attemptId: row.id, userId: mandate.value.user_id })
}

/** The `checkout_attempts.state` that goes with an order status. §3.3's two state machines, kept in step. */
export function attemptStateFor(
  status: OrderStatus,
):
  | 'ORDER_CREATED'
  | 'AUTHORIZED'
  | 'PARTIALLY_CAPTURED'
  | 'CAPTURED'
  | 'VOIDED'
  | 'DECLINED'
  | 'PENDING_REVIEW'
  | 'AUTH_EXPIRED' {
  switch (status) {
    case 'ORDER_CREATED':
      return 'ORDER_CREATED'
    case 'AUTHORIZED':
      return 'AUTHORIZED'
    case 'PARTIALLY_CAPTURED':
      return 'PARTIALLY_CAPTURED'
    case 'CAPTURED':
      return 'CAPTURED'
    case 'VOIDED':
    case 'CANCELLED':
      return 'VOIDED'
    case 'DECLINED':
    case 'PAYMENT_FAILED':
      return 'DECLINED'
    case 'PENDING_REVIEW':
      return 'PENDING_REVIEW'
    case 'AUTH_EXPIRED':
      return 'AUTH_EXPIRED'
    default:
      return 'ORDER_CREATED'
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Notifications                                                                                  */
/* ------------------------------------------------------------------------------------------ */

interface NoticeInput {
  readonly order: OrderRow
  readonly capture: CaptureRow
  readonly userId: string
  readonly at: Date
}

/**
 * EC-CAP-5: "notify the user". The copy is the spec's own sentence for a decline, so a buyer sees exactly
 * what §12.1 promises: *"PayPal declined the payment. Nothing was charged. Update PayPal and retry."*
 *
 * Note what it does **not** say: no internal error, no debug id, no other instrument is offered. The
 * mandate binds one instrument (EC-CAP-5), so suggesting "try another card" would be suggesting the
 * agent do something the user never signed for.
 */
export async function notifyDecline(
  deps: OrdersDeps,
  input: NoticeInput,
): Promise<OrderNotification> {
  const event: OrderNotification = {
    kind: 'CAPTURE_DECLINED',
    orderId: input.order.id,
    userId: input.userId,
    captureId: input.capture.id,
    at: Math.floor(input.at.getTime() / 1000),
    userMessage:
      'PayPal declined the payment. Nothing was charged. Update your PayPal account and retry.',
    detail: {
      paypalCaptureId: input.capture.paypal_capture_id,
      attemptedMinor: input.capture.amount_minor.toString(),
      currency: input.capture.currency,
      retryWithAnotherInstrument: false,
    },
  }
  await deps.notify.notify(event)
  return event
}

/** EC-CAP-4's merchant-facing message: the money is held, and shipping must wait. */
export async function notifyPending(
  deps: OrdersDeps,
  input: NoticeInput,
): Promise<OrderNotification> {
  const event: OrderNotification = {
    kind: 'CAPTURE_PENDING',
    orderId: input.order.id,
    userId: input.userId,
    captureId: input.capture.id,
    amount: { minor: input.capture.amount_minor, currency: input.capture.currency },
    at: Math.floor(input.at.getTime() / 1000),
    userMessage: 'Payment pending at PayPal. Do not ship until it completes.',
    detail: { paypalCaptureId: input.capture.paypal_capture_id },
  }
  await deps.notify.notify(event)
  return event
}

/** "Order complete." Sent only when the authorization closed, so it is never premature. */
export async function notifySettled(
  deps: OrdersDeps,
  input: NoticeInput,
): Promise<OrderNotification> {
  const event: OrderNotification = {
    kind: 'ORDER_COMPLETED',
    orderId: input.order.id,
    userId: input.userId,
    captureId: input.capture.id,
    amount: { minor: input.capture.amount_minor, currency: input.capture.currency },
    at: Math.floor(input.at.getTime() / 1000),
    userMessage: 'Order complete. Thank you.',
    detail: { paypalCaptureId: input.capture.paypal_capture_id },
  }
  await deps.notify.notify(event)
  return event
}

/**
 * "Order cancelled: not shipped in time" / "$X released back to you" — EC-CAP-2's and EC-TIME-5's
 * user-facing behaviour, emitted by `voidRemainder` and by the expiry path.
 */
export async function notifyReleased(
  deps: OrdersDeps,
  input: {
    readonly order: OrderRow
    readonly userId: string
    readonly amount: Money
    readonly reason: string
    readonly at: Date
  },
): Promise<OrderNotification> {
  const event: OrderNotification = {
    kind: 'REMAINDER_RELEASED',
    orderId: input.order.id,
    userId: input.userId,
    amount: input.amount,
    at: Math.floor(input.at.getTime() / 1000),
    userMessage: 'Order cancelled: the remaining amount was released back to you.',
    detail: { reason: input.reason },
  }
  await deps.notify.notify(event)
  return event
}

/** A `CS_INTERNAL` with registry copy, so these call sites do not each invent one. */
function internalError(message: string): CsError {
  return {
    code: 'CS_INTERNAL',
    message,
    userMessage:
      'Something went wrong on our side. Nothing was charged. We have the details and will fix it.',
    retryable: false,
  }
}

export { RELEASE_REASONS }
