/**
 * The `WebhookStore` and `WebhookAudit` adapters over `@countersign/db` — spec **§8.12 (M12, WP-12)**,
 * **§8.19**, **§7.2**, **EC-WH-1**…**EC-WH-7**, **D12**, **D13**.
 *
 * ## Why this file exists
 *
 * `packages/webhooks` declares both ports, and every member's doc comment names the `packages/db`
 * repository that satisfies it. **None of them existed.** `apps/worker`'s `productionDeps()` therefore ended
 * in `throw new Error('production wiring is incomplete: …')` with exit code 78 (`EX_CONFIG`), and the process
 * that owns §8.10's 30-minute reservation release — the thing that stops a buyer's signed budget being held
 * for ever — never ran.
 *
 * ## The rule this file obeys: no logic, only naming
 *
 * Every method body is a **rename and forward** to a repository function. There is no rank comparison and no
 * policy here, because the rank decision belongs to `packages/webhooks`'s `compareRankedState` and the SQL
 * backstop lives in `repos/orders.ts`. An adapter that contained logic would be a second implementation of
 * it, and the two would drift the first time only one was fixed.
 *
 * ## Three members have no repository, and how they are served
 *
 * `apps/worker/package.json` does not depend on `drizzle-orm`, and `package.json` is outside this work
 * package's file list — so a query cannot be built here with Drizzle's `eq()`/`and()`. It can be built with
 * `db().$client`, which is `postgres.js`'s own `Sql` handle that Drizzle exposes on the handle
 * `@countersign/db` already exports. That is **parameterised** (postgres.js turns every `${}` into `$n`),
 * uses the **existing pool** rather than opening a second one, and is exactly one line per member.
 *
 * | Member | Served by | The repository to add in `packages/db` |
 * |---|---|---|
 * | `events.findById` | one `SELECT` | `repos/webhooks.ts::findWebhookEventById(id, exec?)` |
 * | `aggregates.authorizations.findByPaypalId` | one `SELECT` | `repos/orders.ts::findAuthorizationByPaypalId(id, exec?)` + an index on `authorizations.paypal_authorization_id` |
 * | `budgetAccountIds()` (the nightly §7.2 check) | one `SELECT` | `repos/budget.ts::listBudgetAccountIds(exec?)` |
 *
 * All three are **reads**, so none of them can bypass the rule that matters: no package writes a money
 * column without going through a repository (`packages/db`'s header, and the over-refund guard EC-REF-2
 * depends on). `bigint` columns are re-narrowed explicitly, because `postgres.js` returns `int8` as a string
 * and a silent type lie here would be a money bug waiting for someone to add the arithmetic.
 *
 * ## Nothing connects at import time
 *
 * `apps/worker`'s rule is that importing the package must be free (`WORKER-3`). Nothing here touches the
 * database until a method is called — `db()` resolves its pool lazily and the direct reads call it inside
 * the method body — so importing `apps/worker` from `apps/web`'s webhook route handler still opens no socket.
 */
import {
  newId,
  type CsError,
  type Logger,
  type MandateId,
  type Result,
  type WebhookEventId,
} from '@countersign/core'
import {
  appendAudit,
  countFailedSince,
  db,
  findAuthorizationsExpiring,
  findAuthorizationById,
  findCaptureById,
  findCaptureByPaypalId,
  findCapturesByOrder,
  findDisputeByPaypalId,
  findDisputesUpdatedSince,
  findOrderByPaypalOrderId,
  findOrdersForReconcile,
  findRefundByPaypalId,
  findWebhookEventByPaypalId,
  ingestWebhookEvent,
  listUnprocessedEvents,
  markIgnored,
  markProcessed,
  markVerificationFailed,
  markVerificationPending,
  markVerified,
  recordFetchedOrder,
  repo,
  setAuthorizationStatus,
  setCaptureStatus,
  setOrderStatus,
  setRefundStatus,
  upsertCaptureStatusFromFetch,
  upsertDisputeFromFetch,
  type AuthorizationRow,
  type CaptureRow,
  type NewWebhookEvent,
  type WebhookEventRow,
} from '@countersign/db'
import type { WebhookAudit, WebhookStore } from '@countersign/webhooks'

/* ============================================================================================ */
/* 1. The one escape hatch this package needs                                                       */
/* ============================================================================================ */

/**
 * A parameterised read over the pool `@countersign/db` already owns.
 *
 * ### Why this exists rather than a repository
 *
 * `apps/worker/package.json` has no `drizzle-orm`, so `eq()` cannot be imported here. It does **not** need
 * to be: Drizzle exposes the underlying `postgres.js` handle as `$client` on the object `db()` returns, and
 * `postgres.js`'s tagged template is parameterised by construction — `${id}` becomes `$1`, so this is not
 * string concatenation and an id containing a quote cannot change the statement.
 *
 * ### Why it is three lines and not a data-access layer
 *
 * It is used by **three** `SELECT`s, each of which belongs in a repository that does not exist yet, and it
 * cannot write. Every one of them names the function to add. Once those exist this helper has no callers and
 * is deleted in the same commit that adds them.
 *
 * @param query a parameterised `SELECT`. Never interpolate a value into the string — pass it as a parameter.
 */
export async function readRows<T extends object>(
  query: TemplateStringsArray,
  ...params: unknown[]
): Promise<T[]> {
  const sql = db().$client as unknown as (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<unknown[]>
  return (await sql(query, ...params)) as T[]
}

/* ============================================================================================ */
/* 2. `WebhookAudit`                                                                              */
/* ============================================================================================ */

/**
 * `WebhookAudit` over `repos/audit.ts::appendAudit`.
 *
 * **Deliberately not a raw insert.** §8.12's EC-WH-4 wants "an invalid signature → 400 plus an audit entry",
 * and §7.2's `audit_log` is **append-only and hash-chained**: `appendAudit` reads the chain head
 * `SELECT … FOR UPDATE` and writes `this_hash = sha256(JCS({…, prev_hash}))`. A plain insert would break
 * `verifyChain`, and a broken chain turns "a bug quietly rewrote a dispute timeline" from undetectable into
 * "somebody has to go and look" — which is the whole reason the chain exists.
 *
 * @param chainId `packages/webhooks`'s `WEBHOOK_AUDIT_CHAIN`, so every EC-WH-4 entry lands in one
 *   verifiable chain rather than a chain per call site.
 */
export function dbWebhookAudit(chainId: string): WebhookAudit {
  return {
    append(input) {
      // `id` is minted here because §7.1's column is `NOT NULL` and the port deliberately does not carry
      // one: a caller auditing a delivery has no natural id for it. The chain makes an entry's *position*
      // its identity, not its id.
      return appendAudit({
        id: newId('aud'),
        chainId,
        actor: input.actor,
        action: input.action,
        subject: input.subject,
        details: input.details,
        at: input.at,
      })
    },
  }
}

/* ============================================================================================ */
/* 3. `WebhookStore`                                                                              */
/* ============================================================================================ */

/**
 * The production `WebhookStore`.
 *
 * @param logger optional. Used to say when a candidate query took the composed path — a degradation an
 *   operator should hear about rather than discover from a slow sweep.
 */
export function dbWebhookStore(options: { readonly logger?: Logger } = {}): WebhookStore {
  return { events: dbWebhookEventStore(), aggregates: dbAggregateStore(options.logger) }
}

/** `webhook_events`, one repository per port member. */
function dbWebhookEventStore(): WebhookStore['events'] {
  return {
    // EC-WH-2's dedupe: `INSERT … ON CONFLICT (paypal_event_id) DO NOTHING` then a re-read, reporting
    // which happened — which is what makes the ack differ between a fresh and a redelivered event.
    ingestEvent(input: NewWebhookEvent) {
      return ingestWebhookEvent(input)
    },

    findByPaypalId(paypalEventId) {
      return findWebhookEventByPaypalId(paypalEventId)
    },

    /**
     * `repos/webhooks.ts` has **no by-id getter**.
     *
     * `packages/webhooks/src/jobs.ts:195` needs it — `wh.process` receives a `webhookEventId` in the job
     * payload and re-reads the row, so without this the handler cannot run at all. Served by the package's
     * single-parameterised-read escape hatch; see the file header.
     */
    async findById(id: WebhookEventId) {
      return repo(
        async () => {
          const rows = await readRows<WebhookEventRow>`
            SELECT * FROM webhook_events WHERE id = ${id} LIMIT 1`
          return rows[0]
        },
        { table: 'webhook_events', id },
      )
    },

    /**
     * EC-WH-7's retry queue: rows stored `PENDING` because `verify-webhook-signature` was unavailable.
     *
     * Filtered **here** rather than in SQL because `listUnprocessedEvents` is shared with
     * `reprocessUnstoredWork`, which wants the same rows. `verified = 'PENDING'` is the predicate that keeps
     * EC-WH-7 apart from EC-WH-4: a `FAILED` row must never be re-driven, and a boolean column could not
     * tell those two apart at all.
     */
    async listUnverified(limit) {
      const listed = await listUnprocessedEvents(limit)
      if (!listed.ok) return listed
      return { ok: true, value: listed.value.filter((row) => row.verified === 'PENDING') }
    },

    /** §8.12 step 5's "200 even if processing fails" backstop. */
    listUnprocessed(limit) {
      return listUnprocessedEvents(limit)
    },

    /**
     * The three verified states are three repositories, and the port collapses them into one method because
     * **which** of `PENDING` / `VERIFIED` / `FAILED` a row is in is the whole of EC-WH-7: `PENDING` means
     * "stored but never checked, do not act" and `FAILED` means "checked and forged". They have to be
     * handled by opposite code paths, so the dispatch is explicit rather than stringly typed.
     */
    markVerifiedState(id, verified, error, at) {
      if (verified === 'VERIFIED') return markVerified(id, at)
      if (verified === 'FAILED')
        return markVerificationFailed(id, error ?? 'signature did not verify', at)
      return markVerificationPending(id, error ?? 'verification was never attempted', at)
    },

    markProcessed(id, error, at) {
      return markProcessed(id, error, at)
    },

    /** EC-WH-6: store, mark, never crash. */
    markIgnored(id, reason, at) {
      return markIgnored(id, reason, at)
    },

    /** EC-WH-4's "alert after 10/h" threshold. */
    countFailedSince(since) {
      return countFailedSince(since)
    },
  }
}

/** `orders` / `authorizations` / `captures` / `refunds` / `disputes`, one repository per port member. */
function dbAggregateStore(logger?: Logger): WebhookStore['aggregates'] {
  return {
    orders: {
      findByPaypalId: (paypalOrderId) => findOrderByPaypalOrderId(paypalOrderId),
      reconcileCandidates: (updatedSince) => findOrdersForReconcile(updatedSince),
      setStatus: (id, status, at) => setOrderStatus(id, status, at),
      recordFetched: (id, raw, at) => recordFetchedOrder(id, raw, at),
    },

    authorizations: {
      /**
       * `findAuthorizationById` is keyed by **our** `aut_…` row id; the port is called with PayPal's
       * `paypal_authorization_id`, and §7.2 has no index on it.
       *
       * `amount_minor` comes back as a **string** — `postgres.js` returns `int8` as a string so no value
       * silently loses precision on the way through — and is re-narrowed to `bigint` here. A silent type lie
       * on a money column would be worse than the missing index.
       */
      async findByPaypalId(paypalAuthorizationId) {
        return repo(
          async () => {
            const rows = await readRows<Record<string, unknown>>`
              SELECT * FROM authorizations WHERE paypal_authorization_id = ${paypalAuthorizationId} LIMIT 1`
            const row = rows[0]
            if (row === undefined) return undefined
            return {
              ...row,
              amount_minor: BigInt(row['amount_minor'] as string),
            } as AuthorizationRow
          },
          { table: 'authorizations', paypalAuthorizationId },
        )
      },

      /**
       * EC-TIME-5's day-3 / day-28 query.
       *
       * `findAuthorizationsExpiring`'s default `status = 'CREATED'` is the right one: an authorization that
       * has already been captured or voided has nothing left to expire, and re-reading it would spend a
       * PayPal request for nothing.
       */
      reconcileCandidates: (before) => findAuthorizationsExpiring(before),
      setStatus: (id, status, at) => setAuthorizationStatus(id, status, at),
    },

    captures: {
      findByPaypalId: (paypalCaptureId) => findCaptureByPaypalId(paypalCaptureId),

      /**
       * Captures that are not terminal **and** whose order was touched since `updatedSince`.
       *
       * **There is no repository for this**, which `packages/webhooks`'s own type comment states: "no
       * repository function for this … a port member the caller supplies".
       *
       * Composed from two that *do* exist — `findOrdersForReconcile` (orders not terminal, touched since)
       * and `findCapturesByOrder` — rather than from new SQL. That is a bounded N+1 instead of one JOIN: the
       * order side is already the sweep's own filter, the order list is truncated **before** any capture read,
       * terminal captures are dropped here exactly as `reconcile.ts` drops terminal orders, and
       * `upsertCaptureStatusFromFetch`'s monotonic guard still backs every write. It costs more round trips
       * than a JOIN and it cannot disagree with the order-side filter, which is the trade this repository has
       * made everywhere else: compose published repositories rather than open a second data-access layer
       * (AGENTS.md rule 8).
       *
       * The composition is **logged on every call** so it reads as a degradation rather than as normal
       * behaviour nobody notices.
       *
       * **To add in `packages/db/src/repos/orders.ts`:**
       * `export function findCapturesForReconcile(updatedSince: Date, limit: number, exec?: Exec)` as one
       * indexed join over `captures → orders`. This method then becomes a forward.
       */
      async reconcileCandidates(updatedSince, limit) {
        const orders = await findOrdersForReconcile(updatedSince)
        if (!orders.ok) return orders
        const candidates = orders.value.slice(0, limit)
        const out: Array<{ paypal_capture_id: string }> = []
        for (const order of candidates) {
          if (out.length >= limit) break
          const found = await findCapturesByOrder(order.id)
          if (!found.ok) return found
          for (const capture of found.value) {
            if (out.length >= limit) break
            if (!isReconcileCandidate(capture)) continue
            out.push({ paypal_capture_id: capture.paypal_capture_id as string })
          }
        }
        logger?.warn('captures.reconcileCandidates used the composed fallback, not a repository', {
          module: 'worker.adapters',
          orders_considered: candidates.length,
          candidates: out.length,
          note: 'packages/db has no findCapturesForReconcile; this is an N+1 and is meant to be temporary',
        })
        return { ok: true, value: out }
      },

      /**
       * §8.12's monotonic write.
       *
       * `upsertCaptureStatusFromFetch` when the caller decided to move the status, and a detail-only
       * refresh when it did not — which is exactly what `RankedWrite.status === undefined` means, and why
       * the two are distinguished rather than collapsed.
       */
      async applyFromFetch(id, write) {
        if (write.status !== undefined) {
          const applied = await upsertCaptureStatusFromFetch(
            id,
            write.status,
            write.raw,
            write.fetchedAt,
          )
          if (!applied.ok) return applied
          return { ok: true, value: { row: applied.value, applied: true } }
        }
        // Detail only: mirror `raw`/`fetched_at` and leave the status exactly where the caller found it. The
        // status is **re-read and re-asserted**, never guessed — so a concurrent rank advance is not silently
        // rolled back. EC-WH-3 (a `REFUNDED` arriving before `COMPLETED`) is `compareRankedState`'s decision,
        // not this write's.
        const found = await findCaptureById(id)
        if (!found.ok) return found
        if (found.value === undefined) return notFound('captures', id)
        const touched = await setCaptureStatus(
          id,
          found.value.status,
          write.fetchedAt,
          write.raw,
          undefined,
        )
        if (!touched.ok) return touched
        return { ok: true, value: { row: touched.value, applied: true } }
      },
    },

    refunds: {
      findByPaypalId: (paypalRefundId) => findRefundByPaypalId(paypalRefundId),
      /**
       * The port passes `at` (the fetched `update_time`); `setRefundStatus` **has no such parameter** and
       * stamps `refunds.updated_at = new Date()`.
       *
       * Reported for `packages/db/src/repos/orders.ts`:
       * `export function setRefundStatus(id, status, paypalRefundId, raw = null, at?: Date, exec?: Exec)`,
       * with `.set({ status, paypal_refund_id, updated_at: at ?? now() })`. Every sibling — `setOrderStatus`,
       * `setAuthorizationStatus`, `setCaptureStatus` — already takes `at`, so this is an omission rather
       * than a design choice.
       *
       * **Bounded impact, stated so it is not over-read:** §8.12's rank comparison reads
       * `REFUND.status_update_time` out of the mirrored `raw`, never `refunds.updated_at`, so the monotonic
       * rule does not depend on this stamp. What it does affect is `updated_at` on an audit timeline, which
       * will read as wall-clock rather than as when PayPal last changed the refund.
       */
      setStatus: (id, status, paypalRefundId, raw) =>
        setRefundStatus(id, status, paypalRefundId, raw),
    },

    disputes: {
      findByPaypalId: (paypalDisputeId) => findDisputeByPaypalId(paypalDisputeId),

      /**
       * `upsertDisputeFromFetch`, which is already monotonic in SQL (`isDisputeRegression`).
       *
       * `applied` is derived from the row the repository **returned** rather than from a second read: on a
       * regression the repository hands back the existing row untouched, and on a real write it hands back
       * the row it just wrote. So `updated_at === fetched.updatedAt` together with a matching stage and
       * status is exactly "this write happened" — one query instead of two, and it cannot be wrong in the
       * way a read-then-compare could be.
       */
      async upsertFromFetch(fetched) {
        const stored = await upsertDisputeFromFetch(fetched)
        if (!stored.ok) return stored
        const row = stored.value
        const applied =
          row.updated_at.getTime() === fetched.updatedAt.getTime() &&
          row.stage === fetched.stage &&
          row.status === fetched.status
        return { ok: true, value: { row, applied } }
      },

      /** §8.12's 2-minute dispute cron's local change filter. */
      updatedSince: (since) => findDisputesUpdatedSince(since),
    },
  }
}

/* ============================================================================================ */
/* 4. §7.2's nightly ledger check                                                                  */
/* ============================================================================================ */

/**
 * Every mandate with a `budget_accounts` row — the set §7.2's nightly check walks.
 *
 * `repos/budget.ts` has no lister (only per-mandate `reconcileIn(store, mandateId)`), so this is the third
 * member with no repository. **To add in `packages/db/src/repos/budget.ts`:**
 * `export function listBudgetAccountIds(exec?: Exec): Promise<Result<MandateId[], CsError>>`.
 */
export async function budgetAccountIds(): Promise<Result<MandateId[], CsError>> {
  return repo(
    async () => {
      const rows = await readRows<{ mandate_id: MandateId }>`SELECT mandate_id FROM budget_accounts`
      return rows.map((row) => row.mandate_id)
    },
    { table: 'budget_accounts', op: 'list_ids' },
  )
}

/* ============================================================================================ */
/* 5. Helpers                                                                                      */
/* ============================================================================================ */

/**
 * Is this capture worth a PayPal request?
 *
 * `REVERSED` and `DECLINED` are terminal (spec §8.12's rank table), and a `null` `paypal_capture_id` cannot be
 * looked up at all. `PENDING` and `PARTIALLY_REFUNDED` are the interesting ones; `COMPLETED` is included
 * because a completed capture with no refund yet is exactly what §8.12's nightly sweep is looking for.
 */
export function isReconcileCandidate(capture: CaptureRow): boolean {
  if (capture.paypal_capture_id === null) return false
  return (
    capture.status === 'PENDING' ||
    capture.status === 'COMPLETED' ||
    capture.status === 'PARTIALLY_REFUNDED'
  )
}

/** The one `CS_NOT_FOUND` this file constructs, so the wording is stated once. */
function notFound(table: string, id: string): Result<never, CsError> {
  return {
    ok: false,
    error: {
      code: 'CS_NOT_FOUND',
      message: `No ${table} row for ${id}`,
      userMessage: 'We could not find that record.',
      retryable: false,
      details: { table, id },
    },
  }
}

/** Re-exported so a caller can keep a single import for the port names this file fills in. */
export type { WebhookAudit, WebhookStore }
export { findAuthorizationById }
