/**
 * `@countersign/webhooks` types — spec **§8.12 (M12, WP-12)**, **§12.3**, decisions **D12**, **D13**.
 *
 * ## What this package is
 *
 * Two halves of one idea. The **ingest** half is a framework-agnostic `handleWebhook(rawBody, headers)`:
 * read the bytes, store the event, verify, enqueue, acknowledge — and never read state out of the body.
 * The **reconciler** half is a set of sweeps that re-fetch PayPal on a timer, because §3.1 puts it in the
 * architecture precisely because the webhook channel loses, duplicates and reorders messages.
 *
 * Both halves are written against a closed list of ports ({@link WebhookDeps}) for the reason every other
 * package in this repository has one: the set of things this package can reach is then a question about an
 * interface instead of about the codebase. In particular **there is no port here that can move money** —
 * the only side effects are the §8.11 ledger movements, and those go through
 * `applyCaptureOutcome` from `@countersign/orders`, which is WP-11's decision about what a capture outcome
 * means.
 *
 * ## The two ports, and why the store is one
 *
 * - {@link WebhookStore} — our own rows. Every member names the `@countersign/db` repository that
 *   satisfies it in production, so adding a port member without a repo behind it is a `tsc` error rather
 *   than a runtime surprise. The naming convention is `BudgetStore`'s (AGENTS.md rule 3, rule 8).
 * - {@link WebhookQueue} — the `pg-boss` job queue, three methods wide. `apps/worker` supplies the real one
 *   lazily; the tests supply an in-memory one. Neither connects at import time.
 *
 * ## What is *not* here
 *
 * No HTTP framework. `handleWebhook` takes a `Uint8Array` and a header bag and returns a plain
 * {@link WebhookAck}, so WP-17's `app/api/webhooks/paypal/route.ts` is a three-line adapter and this
 * package never learns what Next is. No `zod` for the event body either — the event is a *hint about what
 * to re-fetch*, so an unparseable body is a 400 with an audit entry, not a schema failure to be defended
 * against in three places.
 */
import type {
  Clock,
  CsError,
  DisputeId,
  Logger,
  Money,
  OrderId,
  Result,
  WebhookEventId,
} from '@countersign/core'
import type {
  AuthorizationRow,
  AuthorizationStatus,
  CaptureRow,
  CaptureStatus,
  DisputeRow,
  DisputeStage,
  DisputeStatus,
  NewWebhookEvent,
  OrderRow,
  OrderStatus,
  RefundRow,
  RefundStatus,
  WebhookEventRow,
} from '@countersign/db'
import type { ListDisputesQuery, PayPalClient } from '@countersign/paypal'

/* ------------------------------------------------------------------------------------------ */
/* PayPal surface                                                                                */
/* ------------------------------------------------------------------------------------------ */

/**
 * The seven PayPal calls this package makes — all of them **reads**, plus signature verification.
 *
 * A `Pick<PayPalClient, …>` rather than a hand-written interface, for the reason `OrderPayPal` is: the real
 * client satisfies it structurally, so a test injects `fetchImpl` and drives the real request building,
 * retry loop, backoff and zod validation (AGENTS.md rule 5 forbids faking PayPal's behaviour).
 *
 * **`getRefund` is in this list and there is no refund-completed webhook.** `PAYMENT.REFUND.COMPLETED` does
 * not exist; refund completion is `PAYMENT.CAPTURE.REFUNDED`, and `PAYMENT.REFUND.{PENDING,FAILED}` are the
 * only refund events. A refund row is therefore written from `getRefund`, which is also what makes a
 * dropped refund event harmless.
 */
export type WebhookPayPal = Pick<
  PayPalClient,
  | 'getOrder'
  | 'getAuthorization'
  | 'getCapture'
  | 'getRefund'
  | 'getDispute'
  | 'listDisputes'
  | 'verifyWebhookSignature'
>

/* ------------------------------------------------------------------------------------------ */
/* The throttle (EC-PP-2)                                                                         */
/* ------------------------------------------------------------------------------------------ */

/**
 * A rate limiter the reconciler runs every fetch through.
 *
 * EC-PP-2 is explicit: *"the reconciler throttles itself to 2 rps"*. It is a **port** and not a constant
 * because a 2 rps limit makes a test that sweeps twenty resources take ten seconds, which is how a
 * reconciler test ends up skipped. `reconcile.ts` provides the real one; `test/harness.test.ts` provides an
 * instant one that still *counts* the calls, so "throttled to 2 rps" is an assertion rather than a comment.
 */
export interface Throttle {
  /** The configured rate, for logging. Tests assert on it rather than on elapsed time. */
  readonly rps: number
  /** Run `task` once the throttle admits it. */
  run<T>(task: () => Promise<T>): Promise<T>
}

/* ------------------------------------------------------------------------------------------ */
/* The queue                                                                                     */
/* ------------------------------------------------------------------------------------------ */

/** The job names this package and `apps/worker` agree on. `wh.process` is §8.12 step 4, verbatim. */
export const JOB_PROCESS = 'wh.process'
/** EC-WH-7's retry: re-run `verify-webhook-signature` on rows stored `PENDING`. */
export const JOB_VERIFY = 'wh.verify'
export const JOB_RECONCILE = 'wh.reconcile'
export const JOB_DISPUTES = 'wh.disputes'
export const JOB_AUTH_EXPIRY = 'wh.auth-expiry'
export const JOB_RELEASE_RESERVATIONS = 'release.reservations'
export const JOB_BUDGET_RECONCILE = 'budget.reconcile'

export type JobName =
  | typeof JOB_PROCESS
  | typeof JOB_VERIFY
  | typeof JOB_RECONCILE
  | typeof JOB_DISPUTES
  | typeof JOB_AUTH_EXPIRY
  | typeof JOB_RELEASE_RESERVATIONS
  | typeof JOB_BUDGET_RECONCILE

/** §8.12 step 4's payload. Small on purpose: the row is the source of truth, this is a pointer to it. */
export interface ProcessEventJob {
  readonly webhookEventId: WebhookEventId
  /** §8.12 step 4: the singleton key, so one resource is processed serially across worker instances. */
  readonly resourceId: string
  readonly resourceType: string
  readonly eventType: string
}

export interface VerifyEventJob {
  readonly webhookEventId: WebhookEventId
}

export interface EnqueueOptions {
  readonly singletonKey?: string
  /** pg-boss retry budget. §8.12's jobs are idempotent, so a retry is always safe (AGENTS.md rule 6). */
  readonly retryLimit?: number
  readonly retryDelaySeconds?: number
  readonly retryBackoff?: boolean
  /** Start no earlier than this. EC-WH-7's backoff is expressed here rather than with a `sleep`. */
  readonly startAfterSeconds?: number
}

/**
 * The queue, three methods wide.
 *
 * `apps/worker`'s pg-boss adapter is the production implementation and **constructs lazily** — importing
 * `@countersign/worker` must not open a database connection, which is why `PgBossQueue` is behind a
 * factory and every method is reached through the returned object.
 */
export interface WebhookQueue {
  send(name: JobName, data: unknown, opts?: EnqueueOptions): Promise<Result<string, CsError>>
  work(name: JobName, handler: JobHandler, opts?: WorkOptions): Promise<Result<void, CsError>>
  /** pg-boss cron: a named schedule registered at start-up. */
  schedule(name: JobName, cron: string): Promise<Result<void, CsError>>
  start(): Promise<Result<void, CsError>>
  stop(): Promise<Result<void, CsError>>
}

export interface WorkOptions {
  readonly concurrency?: number
  readonly batchSize?: number
}

export type JobHandler = (data: unknown) => Promise<Result<unknown, CsError>>

/* ------------------------------------------------------------------------------------------ */
/* The store                                                                                     */
/* ------------------------------------------------------------------------------------------ */

/** A webhook event as this package needs it. `WebhookEventRow` is the row; this is the slice. */
export type StoredEvent = WebhookEventRow

/**
 * `webhook_events` writes. EC-WH-2's dedupe is the **first** member and the rest are downstream of it.
 *
 * Each member names the repository in `packages/db/src/repos/webhooks.ts` that satisfies it in production.
 */
export interface WebhookEventStore {
  /**
   * `INSERT … ON CONFLICT (paypal_event_id) DO NOTHING`, then re-read on the conflict path.
   *
   * `repos/webhooks.ts::ingestWebhookEvent`. Two properties the ingest path depends on and therefore
   * states in the port rather than assumes:
   *
   *  - A conflict must leave the **first** copy untouched. PayPal retries an event up to 25 times over
   *    three days, and the first body is the one the case file should show; bumping `received_at` or
   *    overwriting `raw` on a retry would make the retained evidence the 24th delivery.
   *  - It reports which happened, because the ack differs: a duplicate returns 200 without re-verifying
   *    a row that is already `VERIFIED`, and without re-enqueueing work that is already queued.
   */
  ingestEvent(
    input: NewWebhookEvent,
  ): Promise<Result<{ row: StoredEvent; duplicate: boolean }, CsError>>
  findByPaypalId(paypalEventId: string): Promise<Result<StoredEvent | undefined, CsError>>
  findById(id: WebhookEventId): Promise<Result<StoredEvent | undefined, CsError>>
  /**
   * Write `verified`, and `error` beside it.
   *
   * `repos/webhooks.ts::markVerified` / `markVerificationFailed` / `markVerificationPending` — the three
   * are one function here because **which** of `VERIFIED`/`FAILED`/`PENDING` a row is in is the whole of
   * EC-WH-7: `PENDING` means "stored but never checked, do not act", `FAILED` means "checked and forged",
   * and the two must be handled by opposite code paths. An enum in the schema and a boolean in a port would
   * collapse them.
   */
  markVerifiedState(
    id: WebhookEventId,
    verified: 'PENDING' | 'VERIFIED' | 'FAILED',
    error: string | null,
    at: Date,
  ): Promise<Result<StoredEvent, CsError>>
  /**
   * Finish an event. `error === null` marks it done; a string records why it failed.
   * `repos/webhooks.ts::markProcessed` (which also increments `attempts`).
   */
  markProcessed(
    id: WebhookEventId,
    error: string | null,
    at: Date,
  ): Promise<Result<StoredEvent, CsError>>
  /** EC-WH-6: store, mark, never crash. `repos/webhooks.ts::markIgnored`. */
  markIgnored(id: WebhookEventId, reason: string, at: Date): Promise<Result<StoredEvent, CsError>>
  /** EC-WH-4's alert threshold: forged rows in the last hour. `repos/webhooks.ts::countFailedSince`. */
  countFailedSince(since: Date): Promise<Result<number, CsError>>
  /**
   * Rows still `PENDING` after their verification backoff — EC-WH-7's retry queue, read from the database
   * rather than from the queue, so a crash between "stored" and "enqueued" loses nothing.
   */
  listUnverified(limit: number): Promise<Result<readonly StoredEvent[], CsError>>
  /**
   * Rows that are `VERIFIED` but never processed. **The queue's own backstop.**
   *
   * §8.12 step 5 returns 200 "even if processing fails", and the insert and the enqueue are two writes, so
   * there is a window where a delivery is durably stored and nothing will ever process it. This is the read
   * that closes it, and it is why `reprocessUnstoredWork` exists. `repos/webhooks.ts::listUnprocessedEvents`.
   */
  listUnprocessed(limit: number): Promise<Result<readonly StoredEvent[], CsError>>
}

/**
 * A monotonic write. **The rank decision is made by the caller and passed in.**
 *
 * This is the shape that keeps the invariant structural: `decideRank` is the pure function in
 * `status-rank.ts`, and a store member cannot invent a different policy, because it is handed a decision
 * with no room to argue. The production adapter then hands the decision to
 * `repos/orders.ts::upsertCaptureStatusFromFetch`, whose own SQL guard is the backstop.
 */
export interface RankedWrite<TStatus extends string> {
  /**
   * The status to persist. `undefined` means **do not move the rank** — write the detail only.
   * Non-optional, so "we decided to do nothing" cannot be spelled by omission.
   */
  readonly status: TStatus | undefined
  /** The fetched body, mirrored into `raw` / `fetched_at`. */
  readonly raw: CaptureRow['raw'] | null
  /** The `fetched_at` stamp to record — PayPal's `update_time`, not our clock (AGENTS.md rule 10). */
  readonly fetchedAt: Date
}

/**
 * Our aggregates, as the reconciler reads and writes them.
 *
 * Split into sub-objects per aggregate because the join keys differ: `orders` is looked up by
 * `paypal_order_id`, `captures` by `paypal_capture_id`, and mixing them up is the bug EC-WH-6's tests are
 * written against.
 */
export interface AggregateStore {
  orders: {
    /** `repos/orders.ts::findOrderByPaypalOrderId`. */
    findByPaypalId(paypalOrderId: string): Promise<Result<OrderRow | undefined, CsError>>
    /**
     * §8.12's sweep query: "orders not terminal and updated in the last 30 days".
     * `repos/orders.ts::findOrdersForReconcile`. One function serves the 5-minute cron and the nightly
     * 30-day sweep, because "not terminal" is the only difference.
     */
    reconcileCandidates(updatedSince: Date): Promise<Result<OrderRow[], CsError>>
    /** `repos/orders.ts::setOrderStatus`. */
    setStatus(id: OrderId, status: OrderStatus, at: Date): Promise<Result<OrderRow, CsError>>
    /** `repos/orders.ts::recordFetchedOrder` — §7.1's `raw` mirror. */
    recordFetched(id: OrderId, raw: OrderRow['raw'], at: Date): Promise<Result<OrderRow, CsError>>
  }
  authorizations: {
    /** `repos/orders.ts::findAuthorizationByPaypalId` (via `findAuthorizationById`). */
    findByPaypalId(
      paypalAuthorizationId: string,
    ): Promise<Result<AuthorizationRow | undefined, CsError>>
    /** EC-TIME-5's day-3/day-28 query. `repos/orders.ts::findAuthorizationsExpiring`. */
    reconcileCandidates(before: Date): Promise<Result<AuthorizationRow[], CsError>>
    /** `repos/orders.ts::setAuthorizationStatus`. */
    setStatus(
      id: string,
      status: AuthorizationStatus,
      at: Date,
    ): Promise<Result<AuthorizationRow, CsError>>
  }
  captures: {
    /** `repos/orders.ts::findCaptureByPaypalId` — the webhook/reconciler's join. */
    findByPaypalId(paypalCaptureId: string): Promise<Result<CaptureRow | undefined, CsError>>
    /**
     * Captures that are **not** in a terminal state and whose order was touched since `updatedSince`.
     *
     * There is **no repository function** for this: `repos/orders.ts` has `findOrdersForReconcile` for
     * orders and `findAuthorizationsExpiring` for authorizations, but nothing that reaches a capture
     * through its order. Reaching past the repositories into Drizzle from here would be a second
     * data-access layer in the wrong package (AGENTS.md rule 8), so it is a port member the caller
     * supplies. Recorded in `README.md` → "Contract issues".
     */
    reconcileCandidates(
      updatedSince: Date,
      limit: number,
    ): Promise<Result<{ paypal_capture_id: string }[], CsError>>
    /**
     * Apply a {@link RankedWrite}. The production adapter is `repos/orders.ts::upsertCaptureStatusFromFetch`
     * when `status` is present and `repos/orders.ts::setCaptureStatus` for a detail-only refresh.
     *
     * @returns `applied: false` when the write was refused. A refusal is **not** an error: it is the
     *   monotonic rule working, and the caller reports it as such so the log distinguishes "PayPal said
     *   something older" from "our database is unhappy".
     */
    applyFromFetch(
      id: string,
      write: RankedWrite<CaptureStatus>,
    ): Promise<Result<{ row: CaptureRow; applied: boolean }, CsError>>
  }
  refunds: {
    /** `repos/orders.ts::findRefundByPaypalId`. */
    findByPaypalId(paypalRefundId: string): Promise<Result<RefundRow | undefined, CsError>>
    /** `repos/orders.ts::setRefundStatus` — the only writer of `paypal_refund_id`. */
    setStatus(
      id: string,
      status: RefundStatus,
      paypalRefundId: string,
      raw: RefundRow['raw'],
      at: Date,
    ): Promise<Result<RefundRow, CsError>>
  }
  disputes: {
    /** `repos/disputes.ts::findDisputeByPaypalId`. */
    findByPaypalId(paypalDisputeId: string): Promise<Result<DisputeRow | undefined, CsError>>
    /**
     * `repos/disputes.ts::upsertDisputeFromFetch`. It is already monotonic in SQL
     * (`isDisputeRegression`), and the caller has already applied {@link compareRankedState}, so the two
     * agree rather than one overriding the other.
     */
    upsertFromFetch(
      fetched: UpsertDisputeInput,
    ): Promise<Result<{ row: DisputeRow; applied: boolean }, CsError>>
    /** `repos/disputes.ts::findDisputesUpdatedSince` — the 2-minute cron's local change filter. */
    updatedSince(since: Date): Promise<Result<DisputeRow[], CsError>>
  }
}

/** What a fetched dispute becomes on the way into `disputes`. Mirrors `upsertDisputeFromFetch`. */
export interface UpsertDisputeInput {
  readonly paypalDisputeId: string
  readonly id: DisputeId
  readonly stage: DisputeStage
  readonly status: DisputeStatus
  readonly reason: string
  readonly amount: Money
  readonly sellerResponseDueDate: Date | null
  readonly buyerResponseDueDate: Date | null
  readonly raw: DisputeRow['raw']
  readonly updatedAt: Date
}

/** Everything this package can reach. */
export interface WebhookStore {
  readonly events: WebhookEventStore
  readonly aggregates: AggregateStore
}

/* ------------------------------------------------------------------------------------------ */
/* The audit sink (EC-WH-4)                                                                       */
/* ------------------------------------------------------------------------------------------ */

/**
 * The audit log, one method.
 *
 * §8.12: "an invalid signature → 400 plus an audit entry". `packages/db`'s `appendAudit` is
 * hash-chained and `SELECT … FOR UPDATE`s the chain head, so this is deliberately **not** a raw Drizzle
 * escape hatch — a plain insert would break `verifyChain`.
 */
export interface WebhookAudit {
  append(input: {
    readonly chainId: string
    readonly actor: string
    readonly action: string
    readonly subject: string
    readonly details: Record<string, unknown>
    readonly at: Date
  }): Promise<Result<unknown, CsError>>
}

/* ------------------------------------------------------------------------------------------ */
/* Dependencies                                                                                   */
/* ------------------------------------------------------------------------------------------ */

/** §8.12's acknowledgement. A transport adapter turns this into a `Response`; nothing here knows HTTP. */
export interface WebhookAck {
  /**
   * 200 for a stored event (fresh or duplicate), 400 for a forged or unusable one.
   *
   * **200 is returned even when processing will fail**, because processing is asynchronous and a PayPal
   * retry of a 5xx would only produce the same failure later (§8.12 step 5).
   */
  readonly status: number
  /** A machine reason, for logs and for the `/status` page. Never contains the raw body. */
  readonly outcome: AckOutcome
  /** `webhook_events.paypal_event_id` when one was stored. */
  readonly paypalEventId: string | null
  /** Set on 400. The registry copy from `WH_SIGNATURE_INVALID`, never an internal message. */
  readonly error: CsError | null
  /** Epoch ms the handler finished, from the injected clock. Lets a caller compute its own p95. */
  readonly atMs: number
}

export type AckOutcome =
  /** Stored, verified, enqueued for processing. */
  | 'ACCEPTED'
  /** EC-WH-2: already known. 200, no second row, no second enqueue. */
  | 'DUPLICATE'
  /** Stored, not yet verified (EC-WH-7). 200, **not** enqueued for processing. */
  | 'STORED_UNVERIFIED'
  /** EC-WH-4: the signature did not verify. 400, audited, never enqueued. */
  | 'REJECTED_SIGNATURE'
  /** The body was not JSON, or had no `id`/`event_type`. 400, audited, never stored. */
  | 'REJECTED_MALFORMED'

/** The reconciler's own knobs, all injectable so a test can pin them. */
export interface ReconcilerOptions {
  /** EC-PP-2's "2 rps". */
  readonly rps: number
  /** §8.12's "last 30 days". */
  readonly lookbackDays: number
  /** The 2-minute dispute cron's overlap: `start_time = last_seen − 1h`. */
  readonly disputeOverlapSeconds: number
  /** `now`, injected rather than read, so EC-TIME-4's one-instant discipline holds across a sweep. */
  readonly now: Date
}

export interface WebhookDeps {
  /** The only time source (AGENTS.md rule 10). */
  readonly clock: Clock
  /** The seven reads. The real `PayPalClient`, with an injected `fetchImpl` in tests. */
  readonly paypal: WebhookPayPal
  /** Our own rows. */
  readonly store: WebhookStore
  /** `pg-boss`, or a test's in-memory double. */
  readonly queue: WebhookQueue
  /** §8.12's EC-WH-4 audit entry. */
  readonly audit: WebhookAudit
  /** EC-PP-2. */
  readonly throttle: Throttle
  /** Our configured webhook id, for `verify-webhook-signature`. */
  readonly webhookId: string
  /** Optional, money-free context. */
  readonly logger?: Logger
  /**
   * How long to wait for `verify-webhook-signature` before giving up on the synchronous check.
   *
   * §8.12 step 5 says 200 within 2 s, and EC-PP-5 says the answer when verification is slow is "respond
   * 200 after storing; verify async". So this defaults to well under the ack budget and a timeout becomes
   * EC-WH-7 rather than a slow 200.
   */
  readonly verifyTimeoutMs?: number
}

/** Type-check a complete set of dependencies and refuse to build one with a hole in it. */
export function defineWebhookDeps(deps: WebhookDeps): WebhookDeps {
  return deps
}

/** Re-exported so a caller needs one import for the vocabulary. */
export type {
  AuthorizationRow,
  CaptureRow,
  CsError,
  DisputeRow,
  Logger,
  Money,
  OrderRow,
  RefundRow,
  Result,
  WebhookEventRow,
}
export type { ListDisputesQuery }
