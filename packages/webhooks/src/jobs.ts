/**
 * `wh.process` — spec **§8.12**, **§12.3 EC-WH-1/3/5/6/7**, **§8.11** hooks, [V14].
 *
 * ## The doctrine, restated as code
 *
 * > We never trust payload state. State comes from re-fetching PayPal, never from the body it sent us.
 * > — spec §8.12, §3.1
 *
 * So this file reads exactly four things out of `webhook_events` — `resource_type`, `resource_id`,
 * `verified`, `processed_at` — and **not one of them is a status**. Everything about the payment's state
 * comes from `getCapture` / `getRefund` / `getAuthorization` / `getOrder` / `getDispute`. The payload's only
 * contribution is *which resource to ask about*.
 *
 * Worth naming the one place a status could have been read from the body: an event with an empty
 * `resource_id` (AT-M12.5 — a simulator event, or another app's delivery). It cannot be re-fetched, so it is
 * stored, marked `ignored`, and never guessed at. EC-WH-6's whole requirement is that this is not a crash.
 *
 * ## The four gates, in order, and why each exists
 *
 * | Gate | Why |
 * |---|---|
 * | `processed_at IS NOT NULL` | AT-M12.1 and EC-WH-2: the same event delivered three times is processed once. |
 * | `verified === 'FAILED'` | EC-WH-4: a forged event is never processed. Not even "just to look". |
 * | `verified !== 'VERIFIED'` | EC-WH-7: an unverified event is never processed; `wh.verify` owns it. |
 * | `attempts >= MAX_PROCESS_ATTEMPTS` | a poison event must not be re-driven forever. Left for a human. |
 *
 * ## Idempotency (AGENTS.md rule 6)
 *
 * Every side effect is either a rank-guarded write (§8.12's monotonic rule) or a §8.11 ledger movement
 * reached through a {@link CaptureOutcomeHooks} port whose entry ids are derived from the capture id — so a
 * re-run reports `alreadySettled` and moves nothing. Retrying this job is always safe, which is what makes
 * a `retryLimit` of 5 free.
 */
import { createHash } from 'node:crypto'

import {
  csError,
  err,
  fromPayPalValue,
  isCurrency,
  ok,
  type CsError,
  type DisputeId,
  type Money,
  type Result,
  type WebhookEventId,
} from '@countersign/core'
import {
  canonicalJson,
  type AuthorizationStatus,
  type CaptureRow,
  type CaptureStatus,
  type JsonValue,
  type OrderStatus,
  type RefundStatus,
} from '@countersign/db'
import type { WebhookHeaders } from '@countersign/paypal'

import { storedEventBody, storedHeaders, storedRawBytes, verifyDelivery } from './signature'
import {
  compareRankedState,
  rankAuthorization,
  rankCapture,
  rankDispute,
  rankOrder,
  rankRefund,
  typedStatus,
  type ResourceKind,
} from './status-rank'
import { JOB_PROCESS, type ProcessEventJob, type StoredEvent, type WebhookDeps } from './types'

/**
 * After this many attempts a row is left for a human.
 *
 * pg-boss's `retryLimit` bounds the *job's* retries; this bounds the row's `attempts` column, which the
 * reconciler's unprocessed sweep also increments. Without the second bound, a row that fails for a reason no
 * retry can fix — a resource id PayPal will never have — would be re-driven by every sweep forever, and the
 * sweep's logs would fill with one impossible id.
 */
export const MAX_PROCESS_ATTEMPTS = 8

/**
 * The four §8.11 ledger movements, as a vocabulary.
 *
 * A **duplicate of `packages/orders`' `CaptureOutcome`** and deliberately so. `packages/webhooks` may not
 * depend on `@countersign/orders` (its three dependencies are `core`, `db` and `paypal`, and pulling the
 * orchestrator into the webhook trust path would be worse than four duplicated lines), so the mapping is
 * restated here and pinned from the source: `test/jobs.test.ts` reads
 * `packages/orders/src/budget-hooks.ts` and asserts the two agree.
 *
 * `PARTIALLY_REFUNDED` and `REFUNDED` are absent, and their absence is the point: §8.11 gives a refund no
 * hook, so listing them would invite a mapping to `COMMIT` or `RELEASE`, both of which would be wrong.
 */
export type CaptureHookOutcome = 'COMPLETED' | 'PENDING' | 'DECLINED' | 'REVERSED'

/** Map a stored `captures.status` onto the §8.11 hook vocabulary, or `null` when it earns no hook. */
export function captureHookOutcome(status: string): CaptureHookOutcome | null {
  switch (status) {
    case 'COMPLETED':
      return 'COMPLETED'
    case 'PENDING':
      return 'PENDING'
    case 'DECLINED':
      return 'DECLINED'
    case 'REVERSED':
      return 'REVERSED'
    default:
      // PARTIALLY_REFUNDED, REFUNDED and anything unrecognised: no movement. A refund does not return
      // authority, so there is nothing to move.
      return null
  }
}

/**
 * The §8.11 hook, as a port.
 *
 * **A port and not a call into `@countersign/orders`**, because deciding *when* a capture outcome owes a
 * ledger movement is this package's job (it is the rank decision, and §8.12 owns the rank) while deciding
 * *what* the movement is, is WP-11's. Splitting it there means a deployment with no orchestrator wired still
 * reconciles state correctly and simply does not move money — and it means the webhook tests do not have to
 * construct an `OrdersDeps` to exercise the rank rule.
 */
export interface CaptureOutcomeHooks {
  onCaptureAdvanced(input: {
    readonly capture: CaptureRow
    readonly from: string
    readonly to: string
    readonly outcome: CaptureHookOutcome
    readonly at: Date
  }): Promise<Result<unknown, CsError>>
}

/** What processing one event concluded. Reported, never thrown. */
export type ProcessOutcome =
  /** Re-fetched, and the stored rank moved forward. */
  | {
      readonly outcome: 'ADVANCED'
      readonly kind: ResourceKind
      readonly from: string
      readonly to: string
      readonly verdict: string
    }
  /** Re-fetched; the rank did not move (regression, stale fetch, equal rank, or an unrankable status). */
  | { readonly outcome: 'UNCHANGED'; readonly kind: ResourceKind; readonly verdict: string }
  /** EC-WH-6: no local row, or PayPal does not know the resource. Stored, marked, no crash. */
  | { readonly outcome: 'IGNORED'; readonly reason: string }
  /** An earlier attempt already processed this event. AT-M12.1. */
  | { readonly outcome: 'ALREADY_PROCESSED' }
  /** EC-WH-4: forged. Never processed. */
  | { readonly outcome: 'REJECTED_FORGED' }
  /** EC-WH-7: stored but never verified. `wh.verify` owns it. */
  | { readonly outcome: 'DEFERRED_UNVERIFIED' }
  /** The attempts bound is reached. Left for a human. */
  | { readonly outcome: 'GAVE_UP'; readonly attempts: number }

/**
 * One aggregate, after one re-fetch.
 *
 * `fixedWithoutWebhook` is EC-WH-1's `reconciler_fixes_total`: `true` only when this is the **first** time we
 * have learned the state, i.e. the stored row had never been fetched. A sweep that re-reads a capture and
 * confirms `COMPLETED` is not a fix, and a metric that counted it would report a healthy night as a
 * recovery — which is the metric that gets ignored.
 */
export interface ReconcileOutcome {
  readonly outcome: ProcessOutcome
  readonly fixedWithoutWebhook: boolean
}

export interface ProcessResult {
  readonly eventId: WebhookEventId
  readonly paypalEventId: string
  readonly outcome: ProcessOutcome
  readonly fixedWithoutWebhook: boolean
}

/**
 * §8.12's `wh.process`.
 *
 * @param data the {@link ProcessEventJob} payload. Only `webhookEventId` is trusted as an identifier;
 *   `resourceId` on the payload is **not** used to fetch, because the row is the durable copy and a payload
 *   can be re-sent, hand-edited or written by an older worker. (It is still the queue's singleton key, which
 *   is a scheduling decision, not a source of truth.)
 * @param hooks optional §8.11 ledger movement, for capture rank advances only.
 */
export async function processWebhookEvent(
  data: unknown,
  deps: WebhookDeps,
  hooks?: CaptureOutcomeHooks,
): Promise<Result<ProcessResult, CsError>> {
  const job = readJob(data)
  if (!job.ok) return job

  const at = new Date(deps.clock.nowMs())
  const found = await deps.store.events.findById(job.value.webhookEventId)
  if (!found.ok) return found
  const row = found.value
  if (row === undefined) {
    return err(
      csError('CS_NOT_FOUND', `No webhook_events row for ${job.value.webhookEventId}`, {
        table: 'webhook_events',
        id: job.value.webhookEventId,
      }),
    )
  }

  // ---- gate 1: already done (AT-M12.1, EC-WH-2) --------------------------------------------------
  if (row.processed_at !== null) {
    return done(row, { outcome: 'ALREADY_PROCESSED' })
  }

  // ---- gate 2: forged (EC-WH-4) ------------------------------------------------------------------
  if (row.verified === 'FAILED') {
    return done(row, { outcome: 'REJECTED_FORGED' })
  }

  // ---- gate 3: never checked (EC-WH-7) ---------------------------------------------------------
  if (row.verified !== 'VERIFIED') {
    // Deliberately **not** marked processed and **not** an error. Marking it processed would bury it;
    // returning an error would make the queue retry a job that cannot succeed until the verify endpoint
    // does. `wh.verify` re-drives it, and the reconciler covers the state either way.
    deps.logger?.info('webhook event deferred pending verification', {
      webhook_event_id: row.id,
      paypal_event_id: row.paypal_event_id,
    })
    return done(row, { outcome: 'DEFERRED_UNVERIFIED' })
  }

  // ---- gate 4: the attempts bound ---------------------------------------------------------------
  if (row.attempts >= MAX_PROCESS_ATTEMPTS) {
    await deps.store.events.markProcessed(row.id, `gave up after ${row.attempts} attempts`, at)
    deps.logger?.error('webhook event exceeded the attempt budget', {
      webhook_event_id: row.id,
      paypal_event_id: row.paypal_event_id,
      attempts: row.attempts,
    })
    return done(row, { outcome: 'GAVE_UP', attempts: row.attempts })
  }

  // The empty-`resource_id` check comes **first**, and deliberately before the `kindFor` lookup.
  //
  // A body with no `resource` block at all has `resource_type` defaulted to `'UNKNOWN'`, so testing the type
  // first would report "unsubscribed resource type" for an event that was never ours to begin with — and
  // the reason recorded in the row would be the wrong one. "There was no resource to fetch" is the true
  // diagnosis, and it is the one EC-WH-6 and AT-M12.5 are about.
  if (row.resource_id === '') {
    // AT-M12.5 / EC-WH-6: a simulator event whose ids do not exist. Nothing to re-fetch, so nothing to
    // believe either.
    return ignored(deps, row, 'the event carried no resource.id to re-fetch', at)
  }
  const kind = kindFor(row.resource_type)
  if (kind === null) {
    // An event name we do not subscribe to, or another app's delivery. §8.12: never reject on an unknown
    // event name; store it and move on.
    return ignored(deps, row, `unsubscribed resource type "${row.resource_type}"`, at)
  }

  const result = await reconcileOne(kind, row.resource_id, deps, hooks, at)
  if (!result.ok) return result
  const applied = result.value
  const error = applied.outcome.outcome === 'IGNORED' ? `ignored: ${applied.outcome.reason}` : null
  await deps.store.events.markProcessed(row.id, error, at)
  return done(row, applied.outcome, applied.fixedWithoutWebhook)
}

/* ------------------------------------------------------------------------------------------ */
/* One resource, one re-fetch                                                                     */
/* ------------------------------------------------------------------------------------------ */

/**
 * PayPal's `resource.type` for each aggregate we mirror. Anything else is not ours.
 *
 * `checkout-order` is PayPal's spelling [V11]; `order` is accepted because a hand-written simulator event
 * in a test often uses the short form, and EC-WH-6 says an event we do not recognise must be stored and
 * ignored rather than crash — which is the same code path as recognising it and finding no row.
 */
export function kindFor(resourceType: string): ResourceKind | null {
  switch (resourceType) {
    case 'capture':
      return 'capture'
    case 'refund':
      return 'refund'
    case 'authorization':
      return 'authorization'
    case 'checkout-order':
    case 'order':
      return 'order'
    case 'dispute':
      return 'dispute'
    default:
      return null
  }
}

/**
 * Re-fetch one resource and apply §8.12's rank rule.
 *
 * Exported because the reconciler's sweeps call it directly for every candidate — a lost webhook (AT-M12.3)
 * produces no `webhook_events` row at all, so there is no job to run and this function is the whole path.
 */
export async function reconcileOne(
  kind: ResourceKind,
  resourceId: string,
  deps: WebhookDeps,
  hooks: CaptureOutcomeHooks | undefined,
  at: Date,
): Promise<Result<ReconcileOutcome, CsError>> {
  switch (kind) {
    case 'capture':
      return reconcileCapture(resourceId, deps, hooks, at)
    case 'refund':
      return reconcileRefund(resourceId, deps, at)
    case 'authorization':
      return reconcileAuthorization(resourceId, deps, at)
    case 'order':
      return reconcileOrder(resourceId, deps, at)
    case 'dispute':
      return ingestDispute(resourceId, deps, at)
  }
}

/**
 * AT-M12.2, EC-WH-3 (capture case).
 *
 * The order of the three things this does is the whole design:
 *
 *  1. find our row (no row → EC-WH-6, ignore),
 *  2. `getCapture` — **the only source of the status**,
 *  3. `compareRankedState` — never downgrade, and skip a fetch older than what we stored.
 *
 * Then, and only then, the §8.11 hook — and only if the rank actually **advanced to a status that has a
 * hook**, which is what stops the webhook that follows `captureShipment`'s own synchronous call from
 * committing the budget twice.
 */
async function reconcileCapture(
  paypalCaptureId: string,
  deps: WebhookDeps,
  hooks: CaptureOutcomeHooks | undefined,
  at: Date,
): Promise<Result<ReconcileOutcome, CsError>> {
  const local = await deps.store.aggregates.captures.findByPaypalId(paypalCaptureId)
  if (!local.ok) return local
  if (local.value === undefined) {
    return notOurs(`no captures row for PayPal capture ${paypalCaptureId}`)
  }
  const row = local.value

  const fetched = await deps.paypal.getCapture(paypalCaptureId)
  if (!fetched.ok) {
    if (fetched.error.code === 'PP_NOT_FOUND') {
      return notOurs(`PayPal has no capture ${paypalCaptureId} (${fetched.error.code})`)
    }
    return fetched
  }

  const before = rankCapture(row.status, mirroredUpdateTime(row.raw))
  const next = rankCapture(
    fetched.value.status,
    str(fetched.value.update_time),
    str(fetched.value.status_update_time),
  )
  const decision = compareRankedState(before, next)
  const fixedWithoutWebhook = row.fetched_at === null

  if (!decision.applyDetail) return unchanged('capture', decision.reason, fixedWithoutWebhook)

  // `nextStatus` is `typedStatus`-narrowed rather than cast. `compareRankedState` only sets it when
  // `known === true`, i.e. when the status is in `CAPTURE_RANK`, so `null` here would mean the rank table and
  // the write disagreed — and refusing is the right answer to that, not a cast to `CaptureStatus`.
  const status = typedStatus<CaptureStatus>('capture', decision.nextStatus)
  if (decision.verdict !== 'REFRESH' && status === null) {
    return unchanged('capture', `refusing to write an unranked capture status`, fixedWithoutWebhook)
  }
  const written = await deps.store.aggregates.captures.applyFromFetch(row.id, {
    status: status ?? undefined,
    raw: asRaw(fetched.value),
    fetchedAt: next.updateTimeMs === null ? at : new Date(next.updateTimeMs),
  })
  if (!written.ok) return written
  if (!written.value.applied) {
    return unchanged('capture', `the store refused: ${decision.reason}`, fixedWithoutWebhook)
  }

  // The hook is owed only for a rank that **advanced to a status §8.11 has a movement for**. Three conditions,
  // all load-bearing: the rank must have moved (`REFRESH` means `captureShipment`'s own synchronous call
  // already ran the hook), the status must be rankable, and it must be one of the four that earns a movement
  // (§8.11 gives a refund none).
  if (hooks !== undefined && decision.verdict === 'ADVANCE' && status !== null) {
    const hookOutcome = captureHookOutcome(status)
    if (hookOutcome !== null) {
      const applied = await hooks.onCaptureAdvanced({
        capture: written.value.row,
        from: row.status,
        to: status,
        outcome: hookOutcome,
        at,
      })
      if (!applied.ok) return applied
    }
  }

  return ok({
    outcome:
      decision.verdict === 'ADVANCE' && status !== null
        ? {
            outcome: 'ADVANCED',
            kind: 'capture',
            from: row.status,
            to: status,
            verdict: decision.reason,
          }
        : { outcome: 'UNCHANGED', kind: 'capture', verdict: decision.reason },
    fixedWithoutWebhook,
  })
}

/**
 * Refunds.
 *
 * **`PAYMENT.REFUND.COMPLETED` does not exist** (report §26, and `WEBHOOK_EVENT_NAMES` in
 * `@countersign/paypal` has it removed with the reason in a comment). Refund completion is
 * `PAYMENT.CAPTURE.REFUNDED`, and the only refund events are `PAYMENT.REFUND.{PENDING,FAILED}`. So a refund
 * row is completed by this re-fetch, which is also why a dropped refund notification is harmless — and why
 * this branch re-reads even for a `PENDING` event whose payload says `PENDING` (which would have told us
 * nothing new anyway).
 */
async function reconcileRefund(
  paypalRefundId: string,
  deps: WebhookDeps,
  at: Date,
): Promise<Result<ReconcileOutcome, CsError>> {
  const local = await deps.store.aggregates.refunds.findByPaypalId(paypalRefundId)
  if (!local.ok) return local
  if (local.value === undefined) {
    return notOurs(`no refunds row for PayPal refund ${paypalRefundId}`)
  }
  const row = local.value

  const fetched = await deps.paypal.getRefund(paypalRefundId)
  if (!fetched.ok) {
    if (fetched.error.code === 'PP_NOT_FOUND') {
      return notOurs(`PayPal has no refund ${paypalRefundId} (${fetched.error.code})`)
    }
    return fetched
  }

  const next = rankRefund(
    fetched.value.status,
    str(fetched.value.update_time),
    str(fetched.value.status_update_time),
  )
  const decision = compareRankedState(rankRefund(row.status), next)
  const fixedWithoutWebhook = row.fetched_at === null
  if (!decision.applyDetail) return unchanged('refund', decision.reason, fixedWithoutWebhook)
  const status = typedStatus<RefundStatus>('refund', decision.nextStatus)
  if (status === null) {
    return unchanged('refund', `refusing to write an unranked refund status`, fixedWithoutWebhook)
  }

  const written = await deps.store.aggregates.refunds.setStatus(
    row.id,
    status,
    paypalRefundId,
    asRaw(fetched.value),
    at,
  )
  if (!written.ok) return written
  return ok({
    outcome: {
      outcome: 'ADVANCED',
      kind: 'refund',
      from: row.status,
      to: status,
      verdict: decision.reason,
    },
    fixedWithoutWebhook,
  })
}

/**
 * Authorizations.
 *
 * The sweep is what will ever see an **expired** authorization: there is no
 * `PAYMENT.AUTHORIZATION.EXPIRED` event (report §26). See `reconcile.ts` → `authorizationExpirySweep`.
 */
async function reconcileAuthorization(
  paypalAuthorizationId: string,
  deps: WebhookDeps,
  at: Date,
): Promise<Result<ReconcileOutcome, CsError>> {
  const local = await deps.store.aggregates.authorizations.findByPaypalId(paypalAuthorizationId)
  if (!local.ok) return local
  if (local.value === undefined) {
    return notOurs(`no authorizations row for PayPal authorization ${paypalAuthorizationId}`)
  }
  const row = local.value

  const fetched = await deps.paypal.getAuthorization(paypalAuthorizationId)
  if (!fetched.ok) {
    if (fetched.error.code === 'PP_NOT_FOUND') {
      return notOurs(`PayPal has no authorization ${paypalAuthorizationId} (${fetched.error.code})`)
    }
    return fetched
  }

  const next = rankAuthorization(
    fetched.value.status,
    str(fetched.value.update_time),
    str(fetched.value.status_update_time),
  )
  const decision = compareRankedState(rankAuthorization(row.status), next)
  const fixedWithoutWebhook = row.fetched_at === null
  if (!decision.applyDetail) {
    return unchanged('authorization', decision.reason, fixedWithoutWebhook)
  }
  const status = typedStatus<AuthorizationStatus>('authorization', decision.nextStatus)
  if (status === null) {
    return unchanged(
      'authorization',
      `refusing to write an unranked authorization status`,
      fixedWithoutWebhook,
    )
  }

  const written = await deps.store.aggregates.authorizations.setStatus(row.id, status, at)
  if (!written.ok) return written
  return ok({
    outcome: {
      outcome: 'ADVANCED',
      kind: 'authorization',
      from: row.status,
      to: status,
      verdict: decision.reason,
    },
    fixedWithoutWebhook,
  })
}

/**
 * Orders.
 *
 * PayPal's `order.status` is **not** our `order_status`, so it is never written straight through.
 * {@link orderStatusFor} is the mapping and it is deliberately narrow — see that function for why
 * `APPROVED` must not mark an order `AUTHORIZED`.
 */
async function reconcileOrder(
  paypalOrderId: string,
  deps: WebhookDeps,
  at: Date,
): Promise<Result<ReconcileOutcome, CsError>> {
  const local = await deps.store.aggregates.orders.findByPaypalId(paypalOrderId)
  if (!local.ok) return local
  if (local.value === undefined) {
    return notOurs(`no orders row for PayPal order ${paypalOrderId}`)
  }
  const row = local.value

  const fetched = await deps.paypal.getOrder(paypalOrderId)
  if (!fetched.ok) {
    if (fetched.error.code === 'PP_NOT_FOUND') {
      return notOurs(`PayPal has no order ${paypalOrderId} (${fetched.error.code})`)
    }
    return fetched
  }

  const mapped = orderStatusFor(fetched.value.status)
  const detail = asRaw(fetched.value)
  if (mapped === null) {
    // No opinion on the status, but the body is still §7.1's mirror and worth refreshing.
    const mirrored = await deps.store.aggregates.orders.recordFetched(row.id, detail, at)
    if (!mirrored.ok) return mirrored
    return unchanged(
      'order',
      `PayPal order status "${fetched.value.status}" has no mapping; body mirrored only`,
      false,
    )
  }

  const decision = compareRankedState(rankOrder(row.status), rankOrder(mapped))
  const status = typedStatus<OrderStatus>('order', decision.nextStatus)
  if (status !== null) {
    const written = await deps.store.aggregates.orders.setStatus(row.id, status, at)
    if (!written.ok) return written
    return ok({
      outcome: {
        outcome: 'ADVANCED',
        kind: 'order',
        from: row.status,
        to: status,
        verdict: decision.reason,
      },
      fixedWithoutWebhook: row.fetched_at === null,
    })
  }

  const mirrored = await deps.store.aggregates.orders.recordFetched(row.id, detail, at)
  if (!mirrored.ok) return mirrored
  return unchanged('order', decision.reason, false)
}

/**
 * PayPal's `order.status` → our `order_status`, or `null` for "no opinion".
 *
 * Only two PayPal order statuses map, and the omissions are the interesting part:
 *
 * - `COMPLETED` → `CAPTURED`, `VOIDED` → `VOIDED`. Both unambiguous.
 * - `CREATED`, `SAVED`, `APPROVED`, `PAYER_ACTION_REQUIRED` → `null`. **Especially `APPROVED`**: our order
 *   status is driven by captures and the orchestrator, and `CHECKOUT.ORDER.APPROVED` means the *buyer*
 *   approved — no authorization exists yet. Mapping it to `AUTHORIZED` would mark an order as having money
 *   held against it before a single authorization has been created, which is the sort of false claim the
 *   evidence packet would then have to defend. `PAYER_ACTION_REQUIRED` is likewise a state for the buyer,
 *   not a failure of ours.
 */
export function orderStatusFor(paypalStatus: string): 'CAPTURED' | 'VOIDED' | null {
  if (paypalStatus === 'COMPLETED') return 'CAPTURED'
  if (paypalStatus === 'VOIDED') return 'VOIDED'
  return null
}

/* ------------------------------------------------------------------------------------------ */
/* Disputes — the ingest WP-15e will call                                                         */
/* ------------------------------------------------------------------------------------------ */

/**
 * Re-fetch one dispute and apply §8.12's `(stage order, status, update_time)` rule.
 *
 * **Exported as its own function, not only as a `reconcileOne` branch**, because WP-15e (the Defender, the
 * evidence planner and the filer) needs to say "reconcile this dispute now" without a `wh.process` job for
 * a notification that may never arrive — which is the *common* case for a dispute, since
 * `CUSTOMER.DISPUTE.CREATED` is easy to lose and impossible to re-request.
 *
 * EC-WH-3's dispute case (`CUSTOMER.DISPUTE.UPDATED` arriving before `CREATED`) is handled by the rank, not
 * by an ordering check on the event name: the fetch is the truth, and `CHARGEBACK` outranks `INQUIRY`
 * whatever the notification was called.
 */
export async function ingestDispute(
  paypalDisputeId: string,
  deps: WebhookDeps,
  at: Date = new Date(deps.clock.nowMs()),
): Promise<Result<ReconcileOutcome, CsError>> {
  const local = await deps.store.aggregates.disputes.findByPaypalId(paypalDisputeId)
  if (!local.ok) return local

  const fetched = await deps.paypal.getDispute(paypalDisputeId)
  if (!fetched.ok) {
    if (fetched.error.code === 'PP_NOT_FOUND') {
      return notOurs(`PayPal has no dispute ${paypalDisputeId} (${fetched.error.code})`)
    }
    return fetched
  }
  const dispute = fetched.value
  const next = rankDispute({
    stage: str(dispute.dispute_life_cycle_stage) ?? null,
    status: str(dispute.status) ?? null,
    updateTime: str(dispute.update_time) ?? null,
  })
  const fixedWithoutWebhook = local.value === undefined || local.value.fetched_at === null

  if (!next.known) {
    // Fail closed. A stage or status outside the table is not a value we can rank, and a value we cannot
    // rank is a value we must not write. The row keeps whatever it had; the reconciler will try again.
    return unchanged(
      'dispute',
      `PayPal sent stage="${String(dispute.dispute_life_cycle_stage ?? 'none')}" ` +
        `status="${String(dispute.status ?? 'none')}", which is not in the rank table; nothing written`,
      false,
    )
  }

  const current =
    local.value === undefined
      ? null
      : rankDispute({
          stage: local.value.stage,
          status: local.value.status,
          updateTime: mirroredUpdateTime(local.value.raw),
        })
  const decision = compareRankedState(current, next)
  if (!decision.applyDetail) {
    return unchanged('dispute', decision.reason, fixedWithoutWebhook)
  }

  const status = decision.nextStatus ?? local.value?.status ?? String(dispute.status)
  // §8.12's stale rule is decided against PayPal's clock, so `fetched_at` must be stamped with PayPal's
  // `update_time` and **not** with our `now`. Using `at` as a fallback is honest — the fetch genuinely
  // happened now — but it is only reached when PayPal sent no timestamp at all, and it must never be
  // `undefined`: the store compares against this value on every subsequent write, and an undefined date
  // there would throw rather than compare.
  const updatedAt = next.updateTimeMs === null ? at : new Date(next.updateTimeMs)
  if (!(updatedAt instanceof Date) || Number.isNaN(updatedAt.getTime())) {
    return unchanged(
      'dispute',
      'PayPal sent an unparseable update_time, so nothing was written',
      fixedWithoutWebhook,
    )
  }
  const written = await deps.store.aggregates.disputes.upsertFromFetch({
    paypalDisputeId,
    id: (local.value?.id ?? derivedDisputeId(paypalDisputeId)) as DisputeId,
    stage: String(dispute.dispute_life_cycle_stage ?? 'INQUIRY') as UpsertDisputeInputStage,
    status: status as UpsertDisputeInputStatus,
    reason: str(dispute.reason) ?? 'UNSPECIFIED',
    amount: disputeAmount(dispute),
    sellerResponseDueDate: dateOrNull(dispute.seller_response_due_date),
    buyerResponseDueDate: dateOrNull(dispute.buyer_response_due_date),
    raw: asRaw(dispute),
    updatedAt,
  })
  if (!written.ok) return written
  if (!written.value.applied) {
    return unchanged('dispute', `the store refused: ${decision.reason}`, fixedWithoutWebhook)
  }
  return ok({
    outcome:
      decision.verdict === 'ADVANCE'
        ? {
            outcome: 'ADVANCED',
            kind: 'dispute',
            from: local.value?.status ?? 'NONE',
            to: status,
            verdict: decision.reason,
          }
        : { outcome: 'UNCHANGED', kind: 'dispute', verdict: decision.reason },
    fixedWithoutWebhook,
  })
}

/** Local aliases so the casts read as "the enum this schema declares", not as noise. */
type UpsertDisputeInputStage = Parameters<
  WebhookDeps['store']['aggregates']['disputes']['upsertFromFetch']
>[0]['stage']
type UpsertDisputeInputStatus = Parameters<
  WebhookDeps['store']['aggregates']['disputes']['upsertFromFetch']
>[0]['status']

/**
 * A dispute's amount as integer minor units.
 *
 * PayPal sends `dispute_amount` as a `PPMoneyResponse` and the currency separately in
 * `dispute_currency`. Money crosses this boundary through `fromPayPalValue`, never `parseFloat` — the
 * `check-money-discipline` gate scans this directory and a float here would fail the build.
 *
 * A dispute with no usable amount becomes **`0 USD`**, deliberately: `disputes.amount_minor` is `notNull`
 * and a case with an unreadable amount still has to be stored so the Defender can see it and a human can
 * look. The alternative — refusing the upsert — would leave the buyer with no notice of a chargeback, which
 * is the far worse failure. `raw` still carries whatever PayPal sent.
 */
function disputeAmount(dispute: {
  dispute_amount?: { currency_code?: string; value?: string }
  dispute_currency?: string
}): Money {
  const value = str(dispute.dispute_amount?.value)
  const currency = str(dispute.dispute_currency) ?? str(dispute.dispute_amount?.currency_code)
  if (value === undefined || currency === undefined || !isCurrency(currency)) {
    return { minor: 0n, currency: 'USD' }
  }
  try {
    return fromPayPalValue(value, currency)
  } catch {
    return { minor: 0n, currency: 'USD' }
  }
}

/**
 * `dsp_…` for a PayPal dispute id that has no row yet.
 *
 * `sha256(canonicalJson(scope))` truncated to 26 characters — the same construction
 * `packages/orders`' `deterministicIds` uses, and for the same reason: **idempotency**. Two workers
 * reconciling the same newly-seen dispute derive the identical id, so the second hits the primary key
 * instead of writing a second case row. A random id would make every concurrent reconcile a duplicate
 * dispute, which is precisely the bug a chargeback defence must not have.
 */
function derivedDisputeId(paypalDisputeId: string): string {
  const digest = createHash('sha256')
    .update(canonicalJson({ kind: 'dispute', paypalDisputeId }), 'utf8')
    .digest('hex')
  return `dsp_${digest.slice(0, 26)}`
}

/* ------------------------------------------------------------------------------------------ */
/* EC-WH-7: retrying verification                                                                */
/* ------------------------------------------------------------------------------------------ */

/**
 * Re-verify every row still `PENDING`, and enqueue the ones that now pass.
 *
 * The row's own `attempts` column is the attempt counter, so the schedule survives a restart and is shared
 * across worker instances — two instances cannot both conclude "this row has waited 60 seconds".
 *
 * A row whose bytes or headers were not stored (a `PENDING` row written before `StoredDelivery` existed, or
 * one from a future writer) is counted as `unverifiable` rather than retried forever, and reported. That is
 * the honest outcome: the exact bytes cannot be reconstructed, and the redelivery path plus the reconciler
 * are what cover it.
 */
export async function retryPendingVerifications(
  deps: WebhookDeps,
  limit = 50,
): Promise<
  Result<
    {
      readonly checked: number
      readonly verified: number
      readonly unavailable: number
      readonly forged: number
      /** EC-WH-7's contract gap, made visible rather than retried silently. */
      readonly unverifiable: number
    },
    CsError
  >
> {
  const at = new Date(deps.clock.nowMs())
  const listed = await deps.store.events.listUnverified(limit)
  if (!listed.ok) return listed
  let verified = 0
  let unavailable = 0
  let forged = 0
  let unverifiable = 0
  for (const row of listed.value) {
    const answer = await verifyStored(row, deps, at)
    if (answer === 'VERIFIED') verified += 1
    else if (answer === 'FORGED') forged += 1
    else if (answer === 'UNAVAILABLE') unavailable += 1
    else unverifiable += 1
    if (answer === 'VERIFIED') {
      const job = {
        webhookEventId: row.id,
        resourceId: row.resource_id,
        resourceType: row.resource_type,
        eventType: row.event_type,
      }
      await deps.queue.send(JOB_PROCESS, job, {
        singletonKey: row.resource_id,
        retryLimit: 5,
        retryBackoff: true,
        retryDelaySeconds: 5,
      })
    }
  }
  return ok({ checked: listed.value.length, verified, unavailable, forged, unverifiable })
}

/**
 * Verify one stored row from what was stored, and record the answer.
 *
 * Exported because EC-WH-7's assertion is about this function's four outcomes, and because `wh.verify`
 * needs it for a single row when a redelivery has already narrowed the work to one.
 *
 * @returns `'VERIFIED' | 'FORGED' | 'UNAVAILABLE' | 'UNVERIFIABLE'`.
 */
export async function verifyStored(
  row: StoredEvent,
  deps: WebhookDeps,
  at: Date,
): Promise<'VERIFIED' | 'FORGED' | 'UNAVAILABLE' | 'UNVERIFIABLE'> {
  // A row with no stored bytes cannot be re-verified — but only a row that **never had** a delivery is
  // genuinely unverifiable. A row whose `raw` is absent because the ingest path failed to store it is the
  // same case, and both are reported rather than retried forever.
  const bytes = storedRawBytes(row.raw)
  const headers = storedHeaders(row.raw)
  if (bytes === null || headers === null) {
    await deps.store.events.markVerifiedState(
      row.id,
      'PENDING',
      'the delivery bytes were not stored, so this event cannot be re-verified',
      at,
    )
    return 'UNVERIFIABLE'
  }

  const outcome = await verifyDelivery({
    rawBody: bytes,
    headers: headers as unknown as WebhookHeaders,
    webhookId: deps.webhookId,
    clock: deps.clock,
    paypal: deps.paypal,
    timeoutMs: deps.verifyTimeoutMs,
    attempt: row.attempts,
  })
  if (outcome.outcome === 'VERIFIED') {
    await deps.store.events.markVerifiedState(row.id, 'VERIFIED', null, at)
    return 'VERIFIED'
  }
  if (outcome.outcome === 'FORGED') {
    await deps.store.events.markVerifiedState(row.id, 'FAILED', outcome.error.message, at)
    await deps.store.events.markProcessed(row.id, 'ignored: signature verification failed', at)
    return 'FORGED'
  }
  await deps.store.events.markVerifiedState(
    row.id,
    'PENDING',
    `verify unavailable: ${outcome.error.message}`,
    at,
  )
  return 'UNAVAILABLE'
}

/* ------------------------------------------------------------------------------------------ */
/* Helpers                                                                                       */
/* ------------------------------------------------------------------------------------------ */

function readJob(data: unknown): Result<ProcessEventJob, CsError> {
  if (typeof data !== 'object' || data === null) {
    return err(
      csError('CS_VALIDATION', 'wh.process needs a job payload object', { received: typeof data }),
    )
  }
  const obj = data as Record<string, unknown>
  const webhookEventId = obj['webhookEventId']
  if (typeof webhookEventId !== 'string' || !webhookEventId.startsWith('whe_')) {
    return err(
      csError('CS_VALIDATION', 'wh.process needs a webhookEventId beginning "whe_"', {
        webhookEventId,
      }),
    )
  }
  return ok({
    webhookEventId: webhookEventId as WebhookEventId,
    resourceId: typeof obj['resourceId'] === 'string' ? obj['resourceId'] : '',
    resourceType: typeof obj['resourceType'] === 'string' ? obj['resourceType'] : '',
    eventType: typeof obj['eventType'] === 'string' ? obj['eventType'] : '',
  })
}

function notOurs(reason: string): Result<ReconcileOutcome, CsError> {
  return ok({ outcome: { outcome: 'IGNORED', reason }, fixedWithoutWebhook: false })
}

function unchanged(kind: ResourceKind, verdict: string, fixedWithoutWebhook = false) {
  return ok<ReconcileOutcome>({
    outcome: { outcome: 'UNCHANGED', kind, verdict },
    fixedWithoutWebhook,
  })
}

function done(
  row: StoredEvent,
  outcome: ProcessOutcome,
  fixedWithoutWebhook = false,
): Result<ProcessResult, CsError> {
  return ok({
    eventId: row.id,
    paypalEventId: row.paypal_event_id,
    outcome,
    fixedWithoutWebhook,
  })
}

async function ignored(
  deps: WebhookDeps,
  row: StoredEvent,
  reason: string,
  at: Date,
): Promise<Result<ProcessResult, CsError>> {
  await deps.store.events.markIgnored(row.id, reason, at)
  deps.logger?.info('webhook event ignored', {
    webhook_event_id: row.id,
    paypal_event_id: row.paypal_event_id,
    reason,
  })
  return done(row, { outcome: 'IGNORED', reason })
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}

function dateOrNull(v: unknown): Date | null {
  const ms = Date.parse(str(v) ?? '')
  return Number.isNaN(ms) ? null : new Date(ms)
}

/**
 * The `update_time` we mirrored last time, read back out of the stored body.
 *
 * Read from the mirror rather than from `updated_at` on purpose: `updated_at` moves every time *we* write,
 * so it cannot answer "how old was PayPal's answer". §8.12's stale-fetch rule is about PayPal's clock.
 */
function mirroredUpdateTime(raw: unknown): string | null {
  const body = storedEventBody(raw)
  if (typeof body !== 'object' || body === null) return null
  const r = body as Record<string, unknown>
  return str(r['update_time']) ?? str(r['status_update_time']) ?? null
}

/**
 * A fetched PayPal body as a `jsonb` value.
 *
 * `JSON.parse(JSON.stringify(x))` is the honest conversion for a body that arrived as JSON, and it is also
 * the step that would fail loudly if PayPal ever sent something a `jsonb` column cannot hold.
 */
function asRaw(value: unknown): JsonValue | null {
  return value === null || value === undefined
    ? null
    : (JSON.parse(JSON.stringify(value)) as JsonValue)
}
