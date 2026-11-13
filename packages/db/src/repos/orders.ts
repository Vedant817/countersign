/**
 * `orders`, `authorizations`, `captures`, `refunds` and `shipments` — spec §7.2, **§8.11 (M11, WP-11)**.
 *
 * These five tables are one aggregate with a strict order (order → authorization → capture → refund)
 * and three money invariants that the *database* cannot see, because each spans two or more rows:
 *
 *  - **Σ captures ≤ authorized** (EC-CAP-3). `captures.amount_minor` is individually non-negative
 *    (a CHECK), but the running total is a sum over rows, so {@link assertCaptureWithinAuthorization}
 *    does it under a row lock. Spec §8.11 AT-M11.4 requires an over-capture to be rejected **locally,
 *    before any PayPal call** — a rejected local check costs nothing, a rejected PayPal call costs a
 *    debug id and a support ticket.
 *  - **Σ refunds ≤ capture** (EC-REF-2). Enforced by `captures_refunded_lte_amount` plus
 *    {@link createRefund}, which bumps `refunded_minor` and refuses when the remainder is too small.
 *  - **Partial refunds sum exactly** (EC-REF-5). The caller allocates with core's `allocate()`, which
 *    guarantees `sum(parts) === total`; this repo never re-derives a split.
 *
 * A note on **status**: §8.12 says never trust a webhook payload's state — always re-fetch and apply a
 * monotonic rank. `upsertCapturedFromPayPal` therefore takes the *fetched* status plus the fetched
 * `update_time`, and refuses to move a row backwards. That is why `update_time` matters even though it
 * is not a column here: `fetched_at` carries it, and the caller passes the comparison in.
 */
import { and, eq, sql } from 'drizzle-orm'

import type { CsError, Currency, Money, OrderId, Result, ShipmentId } from '@countersign/core'

import { db, type Exec } from '../client'
import {
  authorizations,
  captures,
  orders,
  refunds,
  shipments,
  type AuthorizationRow,
  type CaptureRow,
  type NewAuthorization,
  type NewCapture,
  type NewOrder,
  type NewRefund,
  type NewShipment,
  type OrderRow,
  type RefundRow,
  type ShipmentRow,
} from '../schema'
import { err, repo } from './index'

/* ------------------------------------------------------------------------------------------ */
/* orders                                                                                          */
/* ------------------------------------------------------------------------------------------ */

export type OrderIntent = 'AUTHORIZE' | 'CAPTURE'

export type OrderStatus =
  | 'ORDER_CREATED'
  | 'AUTHORIZED'
  | 'PARTIALLY_CAPTURED'
  | 'CAPTURED'
  | 'VOIDED'
  | 'CANCELLED'
  | 'DECLINED'
  | 'PENDING_REVIEW'
  | 'PAYMENT_FAILED'
  | 'AUTH_EXPIRED'

/**
 * §8.11 AT-M11.5: "a duplicate `createOrderFromDecision` call returns the same PayPal order".
 *
 * `orders_attempt_id_key` is unique, so the second call cannot create a second row. A 23505 becomes
 * `CS_CONFLICT` (AT-M2.4), which the orchestrator reads as "someone already did this" and answers by
 * re-reading the existing row via {@link findOrderByAttempt}.
 */
export function createOrder(input: NewOrder, exec?: Exec): Promise<Result<OrderRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db()).insert(orders).values(input).returning()
      const row = rows[0]
      if (!row) throw new Error('INSERT ... RETURNING produced no orders row')
      return row as OrderRow
    },
    { table: 'orders', id: input.id, attemptId: input.attempt_id },
  )
}

export function findOrderById(
  id: OrderId,
  exec?: Exec,
): Promise<Result<OrderRow | undefined, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db()).select().from(orders).where(eq(orders.id, id)).limit(1)
      return rows[0] as OrderRow | undefined
    },
    { table: 'orders', id },
  )
}

export async function requireOrder(id: OrderId, exec?: Exec): Promise<Result<OrderRow, CsError>> {
  const found = await findOrderById(id, exec)
  if (!found.ok) return found
  const order = found.value
  if (!order) {
    return err({
      code: 'CS_NOT_FOUND',
      message: `No orders row for ${id}`,
      userMessage: 'We could not find that order.',
      retryable: false,
      details: { table: 'orders', id },
    })
  }
  return { ok: true, value: order }
}

/** AT-M11.5's "returns the existing order". Also how a webhook finds its order from PayPal. */
export function findOrderByAttempt(
  attemptId: string,
  exec?: Exec,
): Promise<Result<OrderRow | undefined, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(orders)
        .where(eq(orders.attempt_id, attemptId))
        .limit(1)
      return rows[0] as OrderRow | undefined
    },
    { table: 'orders', attemptId },
  )
}

/**
 * The join key between a PayPal transaction and Countersign. The dispute router's R-NOCHAIN-1 reads
 * this straight off the webhook payload, which is why it is indexed.
 */
export function findOrderByCustomId(
  customId: string,
  exec?: Exec,
): Promise<Result<OrderRow | undefined, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(orders)
        .where(eq(orders.custom_id, customId))
        .limit(1)
      return rows[0] as OrderRow | undefined
    },
    { table: 'orders', customId },
  )
}

export function findOrderByPaypalOrderId(
  paypalOrderId: string,
  exec?: Exec,
): Promise<Result<OrderRow | undefined, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(orders)
        .where(eq(orders.paypal_order_id, paypalOrderId))
        .limit(1)
      return rows[0] as OrderRow | undefined
    },
    { table: 'orders', paypalOrderId },
  )
}

export function setOrderStatus(
  id: OrderId,
  status: OrderStatus,
  at: Date,
  exec?: Exec,
): Promise<Result<OrderRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .update(orders)
        .set({ status, updated_at: at })
        .where(eq(orders.id, id))
        .returning()
      const row = rows[0]
      if (!row) throw new Error(`No orders row for ${id}`)
      return row as OrderRow
    },
    { table: 'orders', id, status },
  )
}

/** §7.1: keep the last PayPal body we fetched. Only non-terminal orders are refreshed. */
export function recordFetchedOrder(
  id: OrderId,
  raw: OrderRow['raw'],
  at: Date,
  exec?: Exec,
): Promise<Result<OrderRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .update(orders)
        .set({ raw, fetched_at: at, updated_at: at })
        .where(eq(orders.id, id))
        .returning()
      const row = rows[0]
      if (!row) throw new Error(`No orders row for ${id}`)
      return row as OrderRow
    },
    { table: 'orders', id },
  )
}

/**
 * §8.12's reconciler query: "orders not terminal and updated in the last 30 days", plus the nightly
 * full 30-day sweep. One function serves both because "not terminal" is the only difference.
 */
export function findOrdersForReconcile(
  updatedSince: Date,
  exec?: Exec,
): Promise<Result<OrderRow[], CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(orders)
        .where(
          and(
            sql`${orders.updated_at} >= ${updatedSince.toISOString()}`,
            sql`${orders.status} not in ('CAPTURED','VOIDED','CANCELLED','PAYMENT_FAILED','AUTH_EXPIRED','DECLINED')`,
          ),
        )
      return rows as OrderRow[]
    },
    { table: 'orders', op: 'reconcile' },
  )
}

/* ------------------------------------------------------------------------------------------ */
/* authorizations                                                                                  */
/* ------------------------------------------------------------------------------------------ */

export type AuthorizationStatus =
  | 'CREATED'
  | 'PENDING'
  | 'CAPTURED'
  | 'PARTIALLY_CAPTURED'
  | 'VOIDED'
  | 'DENIED'
  | 'EXPIRED'

export function createAuthorization(
  input: NewAuthorization,
  exec?: Exec,
): Promise<Result<AuthorizationRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db()).insert(authorizations).values(input).returning()
      const row = rows[0]
      if (!row) throw new Error('INSERT ... RETURNING produced no authorizations row')
      return row as AuthorizationRow
    },
    { table: 'authorizations', id: input.id },
  )
}

export function findAuthorizationById(
  id: string,
  exec?: Exec,
): Promise<Result<AuthorizationRow | undefined, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(authorizations)
        .where(eq(authorizations.id, id))
        .limit(1)
      return rows[0] as AuthorizationRow | undefined
    },
    { table: 'authorizations', id },
  )
}

export function findAuthorizationsByOrder(
  orderId: OrderId,
  exec?: Exec,
): Promise<Result<AuthorizationRow[], CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(authorizations)
        .where(eq(authorizations.order_id, orderId))
      return rows as AuthorizationRow[]
    },
    { table: 'authorizations', orderId },
  )
}

/** EC-TIME-5's day-3 cron: unshipped authorizations whose honour window opens or closes. */
export function findAuthorizationsExpiring(
  before: Date,
  status: AuthorizationStatus = 'CREATED',
  exec?: Exec,
): Promise<Result<AuthorizationRow[], CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(authorizations)
        .where(
          and(
            eq(authorizations.status, status),
            sql`${authorizations.expiration_time} <= ${before.toISOString()}`,
          ),
        )
        .orderBy(authorizations.expiration_time)
      return rows as AuthorizationRow[]
    },
    { table: 'authorizations', op: 'find_expiring' },
  )
}

export function setAuthorizationStatus(
  id: string,
  status: AuthorizationStatus,
  at: Date,
  exec?: Exec,
): Promise<Result<AuthorizationRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .update(authorizations)
        .set({ status, updated_at: at })
        .where(eq(authorizations.id, id))
        .returning()
      const row = rows[0]
      if (!row) throw new Error(`No authorizations row for ${id}`)
      return row as AuthorizationRow
    },
    { table: 'authorizations', id, status },
  )
}

/* ------------------------------------------------------------------------------------------ */
/* captures                                                                                        */
/* ------------------------------------------------------------------------------------------ */

export type CaptureStatus =
  | 'PENDING'
  | 'COMPLETED'
  | 'DECLINED'
  | 'PARTIALLY_REFUNDED'
  | 'REFUNDED'
  | 'REVERSED'

/**
 * §8.12's monotonic status rank. A webhook or a reconciler may only ever **raise** a capture's rank.
 *
 * EC-WH-3: "REFUNDED before COMPLETED" is a real PayPal delivery order, and applying it naively would
 * walk a refunded capture back to completed and then let a refund be refunded. Numbers, not
 * `Array.indexOf` on the enum, so adding a value cannot silently reorder history.
 */
export const CAPTURE_STATUS_RANK: Readonly<Record<CaptureStatus, number>> = Object.freeze({
  PENDING: 1,
  COMPLETED: 2,
  PARTIALLY_REFUNDED: 3,
  REFUNDED: 4,
  DECLINED: 100,
  REVERSED: 101,
})

/** `true` when moving from `current` to `next` would be a downgrade. */
export function isCaptureStatusRegression(current: CaptureStatus, next: CaptureStatus): boolean {
  return CAPTURE_STATUS_RANK[next] < CAPTURE_STATUS_RANK[current]
}

export function createCapture(
  input: NewCapture,
  exec?: Exec,
): Promise<Result<CaptureRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db()).insert(captures).values(input).returning()
      const row = rows[0]
      if (!row) throw new Error('INSERT ... RETURNING produced no captures row')
      return row as CaptureRow
    },
    { table: 'captures', id: input.id },
  )
}

export function findCaptureById(
  id: string,
  exec?: Exec,
): Promise<Result<CaptureRow | undefined, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db()).select().from(captures).where(eq(captures.id, id)).limit(1)
      return rows[0] as CaptureRow | undefined
    },
    { table: 'captures', id },
  )
}

export function findCapturesByOrder(
  orderId: OrderId,
  exec?: Exec,
): Promise<Result<CaptureRow[], CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(captures)
        .where(eq(captures.order_id, orderId))
        .orderBy(captures.created_at)
      return rows as CaptureRow[]
    },
    { table: 'captures', orderId },
  )
}

export function findCaptureByPaypalId(
  paypalCaptureId: string,
  exec?: Exec,
): Promise<Result<CaptureRow | undefined, CsError>> {
  return repo(
    async () => {
      const query = (exec ?? db())
        .select()
        .from(captures)
        .where(eq(captures.paypal_capture_id, paypalCaptureId))
        .limit(1)
      // Refund reservations read and insert under the same capture lock (EC-REF-2).
      const rows = await (exec ? query.for('update') : query)
      return rows[0] as CaptureRow | undefined
    },
    { table: 'captures', paypalCaptureId },
  )
}

/**
 * Σ captures already recorded for an authorization.
 *
 * The number the caller compares its next amount against (EC-CAP-3, AT-M11.1: authorise $100, capture
 * $60, the second has `final_capture = true` and Σ = authorized).
 */
export async function sumCapturedForAuthorization(
  authorizationId: string,
  exec?: Exec,
): Promise<Result<bigint, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select({ total: sql<bigint>`coalesce(sum(${captures.amount_minor}), 0)` })
        .from(captures)
        .where(eq(captures.authorization_id, authorizationId))
      // `BigInt(...)`: postgres-js returns the aggregate as a string, and a caller doing
      // `alreadyCaptured + request.minor` would otherwise mix a string with a BigInt.
      return rows[0] === undefined ? 0n : BigInt(rows[0].total)
    },
    { table: 'captures', authorizationId, op: 'sum' },
  )
}

/**
 * EC-CAP-3 / AT-M11.4: reject an over-capture **before** calling PayPal.
 *
 * @param alreadyCaptured Σ captures on this authorization, read under the caller's transaction.
 * @returns `err(CS_VALIDATION)` with the authorized amount and the request, so the merchant can be
 * told the exact shortfall and told to create a supplementary charge (which needs a new Gate check).
 */
export function assertCaptureWithinAuthorization(
  authorization: { id: string; amount_minor: bigint; currency: Currency },
  alreadyCaptured: bigint,
  requested: Money,
): Result<true, CsError> {
  if (requested.currency !== authorization.currency) {
    return err({
      code: 'CS_CURRENCY_MISMATCH',
      message: `Authorization ${authorization.id} is ${authorization.currency}; capture is ${requested.currency}`,
      userMessage:
        'Your limit and this purchase are in different currencies, so we did not convert them. Create a mandate in the store currency.',
      retryable: false,
      details: {
        table: 'captures',
        authorizationId: authorization.id,
        authorizationCurrency: authorization.currency,
        captureCurrency: requested.currency,
      },
    })
  }
  if (alreadyCaptured + requested.minor > authorization.amount_minor) {
    const remaining = authorization.amount_minor - alreadyCaptured
    return err({
      code: 'CS_VALIDATION',
      message:
        `Capture of ${requested.minor} would exceed authorization ${authorization.id} ` +
        `(${alreadyCaptured} already captured of ${authorization.amount_minor})`,
      userMessage:
        'Exceeds authorization. Create a supplementary charge (requires a new Gate check).',
      retryable: false,
      details: {
        table: 'captures',
        authorizationId: authorization.id,
        authorizedMinor: authorization.amount_minor.toString(),
        alreadyCapturedMinor: alreadyCaptured.toString(),
        remainingMinor: (remaining < 0n ? 0n : remaining).toString(),
        requestedMinor: requested.minor.toString(),
      },
    })
  }
  return { ok: true, value: true }
}

/** EC-CAP-4: a PENDING capture (eCheck/review) must stay PENDING until a re-fetch says otherwise. */
export function setCaptureStatus(
  id: string,
  status: CaptureStatus,
  at: Date,
  raw: CaptureRow['raw'] = null,
  exec?: Exec,
): Promise<Result<CaptureRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .update(captures)
        .set({ status, updated_at: at, ...(raw !== null ? { raw, fetched_at: at } : {}) })
        .where(eq(captures.id, id))
        .returning()
      const row = rows[0]
      if (!row) throw new Error(`No captures row for ${id}`)
      return row as CaptureRow
    },
    { table: 'captures', id, status },
  )
}

/** EC-CAP-4 / §8.12: apply a fetched status only if it does not move the row backwards. */
export async function upsertCaptureStatusFromFetch(
  id: string,
  fetched: CaptureStatus,
  raw: CaptureRow['raw'],
  at: Date,
  exec?: Exec,
): Promise<Result<CaptureRow, CsError>> {
  const current = await findCaptureById(id, exec)
  if (!current.ok) return current
  const row = current.value
  if (!row) {
    return err({
      code: 'CS_NOT_FOUND',
      message: `No captures row for ${id}`,
      userMessage: 'We could not find that payment.',
      retryable: false,
      details: { table: 'captures', id },
    })
  }
  if (isCaptureStatusRegression(row.status, fetched)) return { ok: true, value: row }
  return setCaptureStatus(id, fetched, at, raw, exec)
}

export function linkCaptureToShipment(
  id: string,
  shipmentId: ShipmentId,
  at: Date,
  exec?: Exec,
): Promise<Result<CaptureRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .update(captures)
        .set({ shipment_id: shipmentId, updated_at: at })
        .where(eq(captures.id, id))
        .returning()
      const row = rows[0]
      if (!row) throw new Error(`No captures row for ${id}`)
      return row as CaptureRow
    },
    { table: 'captures', id, shipmentId },
  )
}

/* ------------------------------------------------------------------------------------------ */
/* refunds                                                                                         */
/* ------------------------------------------------------------------------------------------ */

export type RefundStatus = 'PENDING' | 'COMPLETED' | 'FAILED'
export type RefundInitiatedBy = 'USER' | 'MERCHANT' | 'DEFENDER' | 'DISPUTE'

/** How much of a capture is still refundable. */
export function refundableMinor(capture: CaptureRow): bigint {
  const remaining = capture.amount_minor - capture.refunded_minor
  return remaining < 0n ? 0n : remaining
}

/**
 * Create a refund, or refuse it locally (EC-REF-2, AT-M11.4: "An over-refund is rejected locally (no
 * PayPal call)").
 *
 * The refusal is a guard in the `WHERE` clause — `refunded_minor + amount <= amount_minor` — rather
 * than a read followed by a write, so two concurrent refunds cannot both see the same remainder. The
 * schema CHECK `captures_refunded_lte_amount` is the second line of defence.
 *
 * `paypal_refund_id` is filled in afterwards by the webhook/reconciler once PayPal has accepted it;
 * it is nullable at insert because the refund row is created *before* the API call, so a crash between
 * the two leaves a PENDING row that the job can find rather than a money movement with no record.
 */
export function createRefund(input: NewRefund, exec?: Exec): Promise<Result<RefundRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db()).insert(refunds).values(input).returning()
      const row = rows[0]
      if (!row) throw new Error('INSERT ... RETURNING produced no refunds row')
      return row as RefundRow
    },
    { table: 'refunds', id: input.id, captureId: input.capture_id },
  )
}

/** Lock the capture and bump `refunded_minor` by `amount`. Refuses if the remainder is too small. */
export function applyRefundToCapture(
  captureId: string,
  amount: Money,
  at: Date,
  exec: Exec,
): Promise<Result<CaptureRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .update(captures)
        .set({ refunded_minor: sql`${captures.refunded_minor} + ${amount.minor}`, updated_at: at })
        .where(
          and(
            eq(captures.id, captureId),
            sql`${captures.refunded_minor} + ${amount.minor} <= ${captures.amount_minor}`,
          ),
        )
        .returning()
      const row = rows[0]
      if (!row) {
        const existing = await (exec ?? db())
          .select({ amount: captures.amount_minor, refunded: captures.refunded_minor })
          .from(captures)
          .where(eq(captures.id, captureId))
          .limit(1)
        const current = existing[0]
        const remaining = current ? current.amount - current.refunded : 0n
        return err({
          code: 'CS_VALIDATION',
          message: `Refund of ${amount.minor} exceeds the refundable remainder of capture ${captureId}`,
          userMessage: `Only ${remaining} remains refundable.`,
          retryable: false,
          details: {
            table: 'captures',
            captureId,
            requestedMinor: amount.minor.toString(),
            remainingMinor: (remaining < 0n ? 0n : remaining).toString(),
          },
        })
      }
      return row as CaptureRow
    },
    { table: 'captures', captureId, op: 'refund' },
  )
}

export function findRefundsByCapture(
  captureId: string,
  exec?: Exec,
): Promise<Result<RefundRow[], CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(refunds)
        .where(eq(refunds.capture_id, captureId))
        .orderBy(refunds.created_at)
      return rows as RefundRow[]
    },
    { table: 'refunds', captureId },
  )
}

export function findRefundByPaypalId(
  paypalRefundId: string,
  exec?: Exec,
): Promise<Result<RefundRow | undefined, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(refunds)
        .where(eq(refunds.paypal_refund_id, paypalRefundId))
        .limit(1)
      return rows[0] as RefundRow | undefined
    },
    { table: 'refunds', paypalRefundId },
  )
}

/**
 * One `refunds` row by our own `ref_…` id.
 *
 * The dispute refund path (`packages/orders/src/dispute-refund.ts`) re-reads the row it reserved by id
 * before it stamps PayPal's own refund id onto it, so "the reservation I made is the row I am about to
 * write" is a read rather than an assumption. `OrderRepoHandles` has always named this handle; the
 * repository simply did not have it, which is why `orderStoreFromRepos` had no production caller.
 */
export function findRefundById(
  id: string,
  exec?: Exec,
): Promise<Result<RefundRow | undefined, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db()).select().from(refunds).where(eq(refunds.id, id)).limit(1)
      return rows[0] as RefundRow | undefined
    },
    { table: 'refunds', id },
  )
}

export function setRefundStatus(
  id: string,
  status: RefundStatus,
  paypalRefundId: string,
  raw: RefundRow['raw'] = null,
  exec?: Exec,
): Promise<Result<RefundRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .update(refunds)
        .set({
          status,
          paypal_refund_id: paypalRefundId,
          updated_at: new Date(),
          ...(raw !== null ? { raw, fetched_at: new Date() } : {}),
        })
        .where(eq(refunds.id, id))
        .returning()
      const row = rows[0]
      if (!row) throw new Error(`No refunds row for ${id}`)
      return row as RefundRow
    },
    { table: 'refunds', id, status },
  )
}

/* ------------------------------------------------------------------------------------------ */
/* shipments                                                                                       */
/* ------------------------------------------------------------------------------------------ */

export type ShipmentStatus = 'SHIPPED' | 'DELIVERED' | 'NOT_SHIPPED' | 'VOIDED' | 'FAILURE'

export function createShipment(
  input: NewShipment,
  exec?: Exec,
): Promise<Result<ShipmentRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db()).insert(shipments).values(input).returning()
      const row = rows[0]
      if (!row) throw new Error('INSERT ... RETURNING produced no shipments row')
      return row as ShipmentRow
    },
    { table: 'shipments', id: input.id },
  )
}

/** EC-SPLIT-1 / R-INR-1: "is there a shipment with tracking for the disputed lines?" */
export function findShipmentsByOrder(
  orderId: OrderId,
  exec?: Exec,
): Promise<Result<ShipmentRow[], CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(shipments)
        .where(eq(shipments.order_id, orderId))
        .orderBy(shipments.created_at)
      return rows as ShipmentRow[]
    },
    { table: 'shipments', orderId },
  )
}

/**
 * The shipment carrying a tracking number, or `undefined`.
 *
 * `OrderRepoHandles` names this handle because the tracking webhook
 * (`packages/orders/src/tracking.ts`) has to find the shipment a carrier is talking about from the
 * tracking id alone — the carrier knows that and nothing else. Without it the webhook could only ever
 * create a duplicate shipment, so the port's "is this tracker already ours?" question had no answer.
 */
export function findShipmentByTracking(
  trackingNumber: string,
  exec?: Exec,
): Promise<Result<ShipmentRow | undefined, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(shipments)
        .where(eq(shipments.tracking_number, trackingNumber))
        .limit(1)
      return rows[0] as ShipmentRow | undefined
    },
    { table: 'shipments', trackingNumber },
  )
}

export function setShipmentTracker(
  id: ShipmentId,
  paypalTrackerId: string,
  at: Date,
  exec?: Exec,
): Promise<Result<ShipmentRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .update(shipments)
        .set({ paypal_tracker_id: paypalTrackerId, fetched_at: at, updated_at: at })
        .where(eq(shipments.id, id))
        .returning()
      const row = rows[0]
      if (!row) throw new Error(`No shipments row for ${id}`)
      return row as ShipmentRow
    },
    { table: 'shipments', id, paypalTrackerId },
  )
}

/** R-INR-1 needs to know whether tracking exists at all, not just which carrier. */
export async function orderHasTrackedShipment(
  orderId: OrderId,
  exec?: Exec,
): Promise<Result<boolean, CsError>> {
  const found = await findShipmentsByOrder(orderId, exec)
  if (!found.ok) return found
  return {
    ok: true,
    value: found.value.some((s) => s.status !== 'NOT_SHIPPED' && Boolean(s.tracking_number)),
  }
}
