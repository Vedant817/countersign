import 'server-only'

/**
 * The merchant's post-purchase money movements — spec **§8.11 (M11)**, **§8.15**, S-15.
 *
 * ## What this module is
 *
 * The three things a merchant does to an order after the buyer has paid: **capture** what was authorised
 * when the parcel leaves, **refund** a capture (whole or part), and **void** the authorisation that will
 * never ship. The arithmetic, the state machine, the `PayPal-Request-Id`s and every PayPal call live in
 * `packages/orders`; nothing here re-decides any of it. What this file owns is the part only the web tier
 * can own:
 *
 * 1. **Whose order is it?** `packages/orders` takes an order id and trusts it. A route on the open
 *    internet cannot: it resolves the order through {@link findOrderForMerchant}, so a merchant who
 *    guesses another merchant's `ord_…` gets one `CS_NOT_FOUND` — the same answer as an id that never
 *    existed, because "it exists but is not yours" is an existence oracle over someone else's takings.
 * 2. **Who did it, and when?** §8.15: every merchant action is attributable. Each successful movement
 *    appends one hash-chained `audit_log` row on a per-order chain, with the session's user as the actor.
 * 3. **What does the merchant read back?** A `CaptureReport` carries `bigint` money and full row objects;
 *    a JSON body can carry neither. The outcomes below are the same facts as a shape that serialises,
 *    with every amount as `{ minor: "<string>", currency }` — never a float, never a `bigint` that
 *    `JSON.stringify` would throw on.
 *
 * ## Why a refund resolves its capture here rather than in `packages/orders`
 *
 * `refund()` takes a **PayPal** capture id, because a webhook and a cron already know the money they are
 * refunding and the id is the only handle they have. A merchant has our own `cap_…` row id (it came off
 * the order page), and a PayPal capture id is guessable-shaped, so handing one straight to `refund()`
 * would let a merchant refund a capture they cannot see. {@link findCaptureForMerchant} is the missing
 * half: it joins `captures → orders` and answers only for this merchant's own money, and the route then
 * passes the row's `paypal_capture_id` down. The merchant check therefore happens **before** the refund's
 * own lookups, and a wrong-merchant capture costs no PayPal call.
 *
 * ## What this module deliberately does not do
 *
 * - It does not decide an amount. `refund` sends `'FULL'` or an exact amount; the refundable remainder is
 *   `packages/orders`' business, and an over-refund is refused there with no HTTP request (EC-REF-2).
 * - It does not decide an order status. `captureShipment` and `voidRemainder` write it, and both are
 *   idempotent: a second void of a settled order is `ok({ alreadySettled: true })`, not a 409.
 * - It does not notify anyone. `ordersRuntime` passes `nullNotifier`, and EC-CAP-5's "tell the buyer" is a
 *   separate work package's copy (contract issue, gap #2).
 */
import {
  csError,
  err,
  money,
  newId,
  ok,
  type AuditLogId,
  type CsError,
  type Currency,
  type Money,
  type OrderId,
  type Result,
  type UserId,
} from '@countersign/core'
import {
  appendAudit,
  findCaptureForMerchant,
  findOrderForMerchant,
  type CaptureRow,
  type OrderRow,
} from '@countersign/db'
import {
  captureShipment,
  refund,
  voidRemainder,
  type OrdersDeps,
  type RefundAmount,
  type RefundReason,
  type ShipmentInput,
  type VoidReason,
} from '@countersign/orders'

import { ordersRuntime, paypalClient } from './orders-runtime'

/** The audit actions this module writes. Named constants so a test and the log cannot disagree. */
export const AUDIT_ORDER_CAPTURED = 'ORDER_CAPTURED'
export const AUDIT_ORDER_VOIDED = 'ORDER_VOIDED'
export const AUDIT_ORDER_REFUNDED = 'ORDER_REFUNDED'

/**
 * `refunds.initiated_by` for a merchant-initiated refund. The enum lives in `@countersign/db`; the value
 * is spelled here because the route and the audit row must agree on it.
 */
const MERCHANT_INITIATED = 'MERCHANT' as const

/** A money value as it crosses the JSON boundary. `minor` is a string because `bigint` is not JSON. */
export interface AmountJson {
  /** Integer minor units, decimal, as a string — §0: money is never a float. */
  readonly minor: string
  readonly currency: Currency
}

/** The facts every one of the three outcomes shares. */
export interface OrderOpOutcomeBase {
  readonly orderId: string
  readonly merchantId: string
  /** The session user this is attributed to. */
  readonly actorUserId: string
  /** What actually reached PayPal. Empty is a claim, not a default. */
  readonly paypalCalls: readonly string[]
  readonly auditId: string
}

/** What {@link captureShipmentForMerchant} did. */
export interface CaptureOutcome extends OrderOpOutcomeBase {
  /** Our `cap_…` row, not PayPal's id. Null only on a tracking-only shipment. */
  readonly captureId: string | null
  readonly paypalCaptureId: string | null
  readonly captureStatus: string | null
  readonly amount: AmountJson
  /** `authorized − Σ captures` after this capture. */
  readonly remainingAfter: AmountJson
  readonly finalCapture: boolean
  /** EC-CAP-4: PayPal answered PENDING, so nothing may ship. */
  readonly pending: boolean
  /** EC-SPLIT-2: tracking against a capture that already existed (the `CAPTURE`-intent path). */
  readonly trackingOnly: boolean
  readonly shipmentId: string | null
  readonly requestId: string
}

/** What {@link voidOrderForMerchant} did. */
export interface VoidOutcome extends OrderOpOutcomeBase {
  readonly released: AmountJson
  readonly orderStatus: string
  /** `true` when PayPal's `/void` was used, rather than the remainder of a partly-captured auth. */
  readonly viaAuthorizationVoid: boolean
  /** `true` when there was nothing left to release, so no PayPal call was made. */
  readonly alreadySettled: boolean
}

/** What {@link refundForMerchant} did. */
export interface RefundOutcome extends OrderOpOutcomeBase {
  readonly refundId: string
  readonly captureId: string
  readonly paypalCaptureId: string
  readonly paypalRefundId: string
  readonly refundStatus: string
  readonly amount: AmountJson
  /** The refundable remainder **after** this refund. `0` ⇒ the capture is fully refunded. */
  readonly refundableAfter: AmountJson
  readonly reason: RefundReason
  readonly requestId: string
  /** EC-REF-4: an open dispute blocked a direct refund and named the dispute routes instead. */
  readonly blockedByDispute: {
    readonly disputeId: string
    readonly routes: readonly string[]
  } | null
}

/* ------------------------------------------------------------------------------------------ */
/* Wiring                                                                                      */
/* ------------------------------------------------------------------------------------------ */

/**
 * The real `OrdersDeps` for a request: one PayPal client and the `@countersign/db` repositories.
 *
 * Exported so a route and a test build the identical thing, and so a missing `PAYPAL_CLIENT_ID` is one
 * `CsError` naming the variable rather than an opaque 401 at the first capture (the D-040 defect class).
 */
export function orderOpsDeps(
  env: Record<string, string | undefined> = process.env,
): Result<OrdersDeps, CsError> {
  const client = paypalClient(env)
  if (!client.ok) return client
  return ok(ordersRuntime(client.value))
}

/* ------------------------------------------------------------------------------------------ */
/* Capture on shipment                                                                         */
/* ------------------------------------------------------------------------------------------ */

export interface CaptureInput {
  readonly orderId: string
  readonly merchantId: string
  readonly actorUserId: UserId
  /** §8.11's `shipment`: the lines on this parcel, the carrier and the tracking number. */
  readonly shipment: ShipmentInput
}

/**
 * Capture the money for one shipped parcel. §8.11's `captureShipment`, behind the merchant check.
 *
 * `packages/orders` owns the sequence — allocate, over-capture guard (EC-CAP-3), `POST
 * /v2/payments/authorizations/{id}/capture` with `cs:{authId}:cap:{shipmentId}`, persist, budget commit,
 * and `POST /v2/checkout/orders/{id}/track` only if the capture is `COMPLETED` (EC-CAP-4). This function
 * adds the two things that sequence cannot know: who is asking, and the audit row.
 */
export async function captureShipmentForMerchant(
  input: CaptureInput,
  deps: OrdersDeps,
): Promise<Result<CaptureOutcome, CsError>> {
  const order = await requireOwnOrder(input.orderId, input.merchantId)
  if (!order.ok) return order

  const report = await captureShipment(input.orderId as OrderId, input.shipment, deps)
  if (!report.ok) return report
  const value = report.value

  const auditId = newId('aud')
  const recorded = await appendAudit({
    id: auditId as AuditLogId,
    chainId: order.value.id,
    actor: input.actorUserId,
    action: AUDIT_ORDER_CAPTURED,
    subject: order.value.id,
    details: {
      message: captureMessage(value),
      order_id: order.value.id,
      paypal_order_id: order.value.paypal_order_id,
      capture_id: value.capture.id,
      paypal_capture_id: value.capture.paypal_capture_id,
      capture_status: value.capture.status,
      amount_minor: value.amount.minor.toString(),
      currency: value.amount.currency,
      remaining_after_minor: value.remainingAfter.toString(),
      final_capture: value.finalCapture,
      pending: value.pending,
      tracking_only: value.trackingOnly,
      shipment_id: value.shipment?.id ?? null,
      carrier: input.shipment.carrier,
      tracking: input.shipment.tracking,
      paypal_request_id: value.requestId,
    },
  })
  if (!recorded.ok) return recorded

  return ok({
    orderId: order.value.id,
    merchantId: input.merchantId,
    actorUserId: input.actorUserId,
    paypalCalls: paypalCallsForCapture(value),
    auditId: recorded.value.id,
    captureId: value.trackingOnly ? null : value.capture.id,
    paypalCaptureId: value.trackingOnly ? null : value.capture.paypal_capture_id,
    captureStatus: value.trackingOnly ? null : value.capture.status,
    amount: amountJson(value.amount),
    remainingAfter: { minor: value.remainingAfter.toString(), currency: value.amount.currency },
    finalCapture: value.finalCapture,
    pending: value.pending,
    trackingOnly: value.trackingOnly,
    shipmentId: value.shipment?.id ?? null,
    requestId: value.requestId,
  })
}

/* ------------------------------------------------------------------------------------------ */
/* Void                                                                                        */
/* ------------------------------------------------------------------------------------------ */

export interface VoidInput {
  readonly orderId: string
  readonly merchantId: string
  readonly actorUserId: UserId
  readonly reason: VoidReason
}

/**
 * Release whatever is still authorised on an order that will not ship. §8.11's `voidRemainder`.
 *
 * The reason is not cosmetic: `OUT_OF_STOCK` writes `VOIDED` and puts the unshipped lines back,
 * `REVOKED` writes `CANCELLED` (EC-MDT-3), `EXPIRED` writes `AUTH_EXPIRED` (EC-TIME-5). That mapping is
 * `packages/orders`'; this function only insists on the merchant check first.
 */
export async function voidOrderForMerchant(
  input: VoidInput,
  deps: OrdersDeps,
): Promise<Result<VoidOutcome, CsError>> {
  const order = await requireOwnOrder(input.orderId, input.merchantId)
  if (!order.ok) return order

  const report = await voidRemainder(input.orderId as OrderId, input.reason, deps)
  if (!report.ok) return report
  const value = report.value

  const auditId = newId('aud')
  const recorded = await appendAudit({
    id: auditId as AuditLogId,
    chainId: order.value.id,
    actor: input.actorUserId,
    action: AUDIT_ORDER_VOIDED,
    subject: order.value.id,
    details: {
      message: voidMessage(value),
      order_id: order.value.id,
      paypal_order_id: order.value.paypal_order_id,
      reason: input.reason,
      released_minor: value.released.minor.toString(),
      currency: value.released.currency,
      order_status: value.orderStatus,
      via_authorization_void: value.viaAuthorizationVoid,
      already_settled: value.alreadySettled,
    },
  })
  if (!recorded.ok) return recorded

  return ok({
    orderId: order.value.id,
    merchantId: input.merchantId,
    actorUserId: input.actorUserId,
    // An already-settled order is a retry of a void that already happened: PayPal was not called.
    paypalCalls: value.alreadySettled ? [] : ['void'],
    auditId: recorded.value.id,
    released: amountJson(value.released),
    orderStatus: value.orderStatus,
    viaAuthorizationVoid: value.viaAuthorizationVoid,
    alreadySettled: value.alreadySettled,
  })
}

/* ------------------------------------------------------------------------------------------ */
/* Refund                                                                                      */
/* ------------------------------------------------------------------------------------------ */

export interface RefundInput {
  readonly orderId: string
  readonly merchantId: string
  readonly actorUserId: UserId
  /** Our `cap_…` row id, resolved through {@link findCaptureForMerchant} before anything else. */
  readonly captureId: string
  /** `'FULL'` for the exact remainder, or an exact amount. EC-REF-2 refuses an over-refund locally. */
  readonly amount: Money | 'FULL'
  readonly reason: RefundReason
  /**
   * The form nonce — EC-IDEM-5's "a double-clicked button is one refund".
   *
   * Required rather than derived: `packages/orders` keys a refund by this string, so a merchant who sends
   * none would get one PayPal refund per click, and a second identical refund is a legitimate thing
   * (EC-IDEM-6) that only the caller can tell apart from a double click. The UI mints one per render.
   */
  readonly idempotencyKey: string
  /** `note_to_payer`, 0–255 characters ([B12]). The merchant's own words to the buyer. */
  readonly noteToPayer?: string
  /** Stored on the refund row as the justification (audit §15). */
  readonly note?: string
}

/**
 * Refund a capture, in full or in part. §8.11's `refund`, behind the merchant check.
 *
 * Order of operations, and why it is this order: the capture is resolved **for this merchant** first, so a
 * capture belonging to someone else never reaches `refund()`'s global `findCaptureByPaypalId` lookup. The
 * capture must also sit on the order named in the URL — a merchant may refund their own money, but not
 * through another order's page, which is how a mis-pointed UI button becomes a support ticket.
 */
export async function refundForMerchant(
  input: RefundInput,
  deps: OrdersDeps,
): Promise<Result<RefundOutcome, CsError>> {
  const order = await requireOwnOrder(input.orderId, input.merchantId)
  if (!order.ok) return order

  const found = await findCaptureForMerchant(input.captureId, input.merchantId)
  if (!found.ok) return found
  const capture = found.value
  if (capture === undefined) {
    return err(
      csError(
        'CS_NOT_FOUND',
        `No captures row for ${input.captureId} under merchant ${input.merchantId}.`,
        { table: 'captures', id: input.captureId },
        { userMessage: 'That payment is not on this order.' },
      ),
    )
  }
  if (capture.order_id !== order.value.id) {
    // Same merchant, wrong order: not an existence oracle across merchants, but still a refusal. Reporting
    // it as `CS_VALIDATION` rather than `CS_NOT_FOUND` is deliberate — the merchant can see this capture,
    // so the useful answer is "that payment belongs to a different order", not "no such payment".
    return err(
      csError(
        'CS_VALIDATION',
        `Capture ${capture.id} belongs to order ${capture.order_id}, not ${order.value.id}.`,
        {
          table: 'captures',
          id: capture.id,
          order_id: capture.order_id,
          url_order_id: order.value.id,
        },
        { userMessage: 'That payment belongs to a different order.' },
      ),
    )
  }

  // `'FULL'` means the exact remainder and never reaches the currency/positivity check — `packages/orders`
  // computes the remainder against the capture it just read, in that capture's currency, so there is nothing
  // here to compare it with. An exact amount is checked against the capture instead (EC-REF-2's local half).
  let amount: RefundAmount
  if (input.amount === 'FULL') {
    amount = 'FULL'
  } else {
    const checked = normaliseAmount(input.amount, capture)
    if (!checked.ok) return checked
    amount = checked.value
  }

  const report = await refund(
    capture.paypal_capture_id,
    amount,
    input.reason,
    actorFor(input),
    deps,
    {
      idempotencyKey: input.idempotencyKey,
      ...(input.noteToPayer === undefined ? {} : { noteToPayer: input.noteToPayer }),
    },
  )
  if (!report.ok) return report
  const value = report.value

  const auditId = newId('aud')
  const recorded = await appendAudit({
    id: auditId as AuditLogId,
    chainId: order.value.id,
    actor: input.actorUserId,
    action: AUDIT_ORDER_REFUNDED,
    subject: order.value.id,
    details: {
      message: refundMessage(value, input.amount === 'FULL'),
      order_id: order.value.id,
      paypal_order_id: order.value.paypal_order_id,
      capture_id: capture.id,
      paypal_capture_id: capture.paypal_capture_id,
      refund_id: value.refund.id,
      paypal_refund_id: value.refund.paypal_refund_id,
      refund_status: value.refund.status,
      amount_minor: value.refund.amount_minor.toString(),
      currency: value.refund.currency,
      refundable_after_minor: value.refundableAfter.toString(),
      reason: input.reason,
      note: input.note ?? null,
      note_to_payer: input.noteToPayer ?? null,
      idempotency_key: input.idempotencyKey,
      paypal_request_id: value.requestId,
      blocked_by_dispute: value.blockedByDispute?.disputeId ?? null,
    },
  })
  if (!recorded.ok) return recorded

  return ok({
    orderId: order.value.id,
    merchantId: input.merchantId,
    actorUserId: input.actorUserId,
    // `packages/orders` refunds in one call, or refuses before it (EC-REF-2's local guard, EC-REF-4's open
    // dispute), so a successful report is always exactly one PayPal refund.
    paypalCalls: ['refund'],
    auditId: recorded.value.id,
    refundId: value.refund.id,
    captureId: capture.id,
    paypalCaptureId: capture.paypal_capture_id,
    paypalRefundId: value.refund.paypal_refund_id,
    refundStatus: value.refund.status,
    amount: { minor: value.refund.amount_minor.toString(), currency: value.refund.currency },
    refundableAfter: { minor: value.refundableAfter.toString(), currency: value.refund.currency },
    reason: input.reason,
    requestId: value.requestId,
    blockedByDispute:
      value.blockedByDispute === undefined
        ? null
        : { disputeId: value.blockedByDispute.disputeId, routes: value.blockedByDispute.routes },
  })
}

/* ------------------------------------------------------------------------------------------ */
/* Internals                                                                                   */
/* ------------------------------------------------------------------------------------------ */

/**
 * The merchant check, once.
 *
 * One `CS_NOT_FOUND` for "no such order" and "not your order": a merchant surface that answered the second
 * differently would confirm the existence of every other merchant's order ids.
 */
async function requireOwnOrder(
  orderId: string,
  merchantId: string,
): Promise<Result<OrderRow, CsError>> {
  const found = await findOrderForMerchant(orderId, merchantId)
  if (!found.ok) return found
  const row = found.value
  if (row === undefined) {
    return err(
      csError(
        'CS_NOT_FOUND',
        `No orders row for ${orderId} under merchant ${merchantId}.`,
        { table: 'orders', id: orderId },
        { userMessage: 'We could not find that order.' },
      ),
    )
  }
  return ok(row)
}

/**
 * The requested amount, checked against the capture it will be taken from.
 *
 * Only reached for an exact amount. The amount must be positive (a zero refund is a no-op that would still
 * write a row and call PayPal) and in the capture's own currency — `packages/orders` compares against
 * `captures.refunded_minor`, and a currency mismatch there would be an arithmetic bug rather than a
 * refusal, so it is caught here as `CS_CURRENCY_MISMATCH`.
 */
function normaliseAmount(requested: Money, capture: CaptureRow): Result<Money, CsError> {
  if (requested.minor <= 0n) {
    return err(
      csError(
        'CS_VALIDATION',
        `A refund must be above zero; received ${requested.minor.toString()} ${requested.currency}.`,
        { minor: requested.minor.toString(), currency: requested.currency },
        { userMessage: 'Enter an amount above zero to refund.' },
      ),
    )
  }
  if (requested.currency !== capture.currency) {
    return err(
      csError(
        'CS_CURRENCY_MISMATCH',
        `Capture ${capture.id} is in ${capture.currency}; the refund was requested in ${requested.currency}.`,
        { capture_currency: capture.currency, requested_currency: requested.currency },
        { userMessage: 'That amount is in a different currency from the payment.' },
      ),
    )
  }
  return ok(money(requested.minor, capture.currency))
}

/** §8.11's `Actor`, from the session. `initiatedBy` is the enum; `actor` is who to blame. */
function actorFor(input: RefundInput): {
  readonly initiatedBy: typeof MERCHANT_INITIATED
  readonly actor: string
  readonly note?: string
} {
  return {
    initiatedBy: MERCHANT_INITIATED,
    actor: input.actorUserId,
    ...(input.note === undefined ? {} : { note: input.note }),
  }
}

function amountJson(value: Money): AmountJson {
  return { minor: value.minor.toString(), currency: value.currency }
}

/**
 * The PayPal endpoints one capture exercised.
 *
 * Derived from what `packages/orders` reports rather than assumed: a `PENDING` capture is not tracked at
 * all (EC-CAP-4 — nothing ships while the money is held), a tracking-only shipment moves no money so there
 * is no capture to report, and an already-known tracking number short-circuits `linkTracking`'s own
 * idempotency check inside the package. The field is therefore "the calls this operation was allowed to
 * make", which is what an operator reading the audit row needs; it is not a packet capture.
 */
function paypalCallsForCapture(report: {
  readonly pending: boolean
  readonly trackingOnly: boolean
}): readonly string[] {
  if (report.trackingOnly) return ['track']
  if (report.pending) return ['capture']
  return ['capture', 'track']
}

/** The one-line summary an audit row carries. Composed here so the log and the UI cannot disagree. */
export function captureMessage(report: {
  readonly capture: CaptureRow
  readonly amount: Money
  readonly pending: boolean
  readonly trackingOnly: boolean
}): string {
  if (report.trackingOnly)
    return 'Shipment tracked against the existing capture; no new money moved.'
  if (report.pending) return 'PayPal has the capture as PENDING, so nothing ships yet (EC-CAP-4).'
  return `Captured ${report.amount.minor.toString()} ${report.amount.currency} minor units on shipment.`
}

export function voidMessage(report: {
  readonly released: Money
  readonly alreadySettled: boolean
}): string {
  if (report.alreadySettled) return 'Nothing was left to release; the order was already settled.'
  return `Released ${report.released.minor.toString()} ${report.released.currency} minor units.`
}

export function refundMessage(
  report: { readonly refund: { amount_minor: bigint; currency: Currency } },
  full: boolean,
): string {
  const amount = `${report.refund.amount_minor.toString()} ${report.refund.currency} minor units`
  return full ? `Refunded the remainder: ${amount}.` : `Refunded ${amount}.`
}
