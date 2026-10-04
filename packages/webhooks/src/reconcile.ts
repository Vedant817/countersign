/**
 * The reconciler — spec **§8.12**, **§12.3 EC-WH-1**, **§12.5 EC-TIME-5**, **EC-PP-2**, decision **D13**.
 *
 * ## Why this file is in the architecture at all
 *
 * §3.1 says webhooks "get lost, duplicated and reordered, so state comes from re-fetching PayPal, never from
 * the payload alone" [V14]. That sentence is only true if something re-fetches on a timer, and this is it.
 * Every sweep below does the same three things and differs only in **which candidates it looks at**:
 *
 * 1. read our own rows that are not in a terminal state,
 * 2. `GET` each one from PayPal through {@link Throttle},
 * 3. apply §8.12's monotonic rank and write only what moved forward.
 *
 * ## The four sweeps, and what each one is for
 *
 * | Cron | Cadence | Candidates | Covers |
 * |---|---|---|---|
 * | {@link reconcileResources} | 5 min | orders / authorizations / captures not terminal, touched in 30 d | EC-WH-1, EC-WH-5 |
 * | {@link reconcileDisputes} | 2 min | `listDisputes(start_time = last_seen − 1h)` | a lost dispute notification |
 * | {@link authorizationExpirySweep} | 5 min | authorizations past their honour window or past `expiration_time` | **EC-TIME-5** |
 * | {@link reconcileResources} (nightly) | nightly | the same set, no lookback | anything the 5-minute cadence missed |
 *
 * ## EC-TIME-5 cannot be webhook-driven, and that is a fact about PayPal
 *
 * **There is no `PAYMENT.AUTHORIZATION.EXPIRED` event** (report §26, and the comment on
 * `WEBHOOK_EVENT_NAMES` in `@countersign/paypal` records it). A subscription to it succeeds, the webhook is
 * created, and it silently never fires — nothing errors, nothing alerts, and the authorization sits
 * uncaptured until someone notices. So the 29-day expiry and the 3-day honour period are computed here by
 * polling `GET /v2/payments/authorizations/{id}`, and {@link authorizationExpirySweep} is the **only** thing
 * in this repository that will ever observe an expired authorization. `README.md` says so again, because it
 * is the kind of fact that gets "simplified" away by a later reader.
 *
 * ## EC-PP-2: 2 requests per second
 *
 * Every PayPal read goes through `deps.throttle`, which is a port so the tests can make it instant. The
 * default is {@link DEFAULT_RECONCILE_RPS}; it is applied **per sweep invocation**, not per candidate, so two
 * concurrent sweeps share one limiter and the aggregate rate is the limit.
 */
import { ok, type CsError, type Logger, type Result } from '@countersign/core'
import { realSleep, type Sleep } from '@countersign/paypal'

import { reconcileOne, type CaptureOutcomeHooks, type ProcessOutcome } from './jobs'
import { isTerminalStatus } from './status-rank'
import { JOB_PROCESS, type ReconcilerOptions, type Throttle, type WebhookDeps } from './types'

/** EC-PP-2: "the reconciler throttles itself to 2 rps". */
export const DEFAULT_RECONCILE_RPS = 2

/** §8.12's "updated in the last 30 days". */
export const DEFAULT_LOOKBACK_DAYS = 30

/** §8.12's `listDisputes(start_time = last_seen − 1h)` overlap. */
export const DEFAULT_DISPUTE_OVERLAP_SECONDS = 3_600

/** Batch size per sweep, so one cycle cannot hold the queue for the whole backlog. */
export const DEFAULT_SWEEP_BATCH = 100

/**
 * [V15]: an authorization is valid for **29 days**, and reauthorization is permitted only from **day four**
 * — the 3-day honour period ends there. Both numbers are PayPal's, not ours, and EC-TIME-5 exists because
 * PayPal never tells us which day we are on.
 */
export const AUTHORIZATION_VALIDITY_DAYS = 29
export const AUTHORIZATION_HONOUR_DAYS = 3

/**
 * How far ahead {@link authorizationExpirySweep} looks: **derived, not chosen**.
 *
 * `honor_expires_at = created + 3d` and `expiration_time = created + 29d` are both stamped at authorization
 * time, so a row's honour window is open exactly when `expiration_time <= now + (29 − 3)d`. Passing that as
 * the store's `before` therefore selects precisely the rows whose honour window has opened — and every row
 * already past `expiration_time` falls under the same inequality.
 *
 * A tighter horizon (five days is the obvious choice) would silently skip most of the honour window, and the
 * rows it skips are exactly the ones where reauthorization is still legal. The sweep would report nothing for
 * twenty days and then expire them.
 */
export const EXPIRY_SWEEP_HORIZON_DAYS = AUTHORIZATION_VALIDITY_DAYS - AUTHORIZATION_HONOUR_DAYS

/* ------------------------------------------------------------------------------------------ */
/* The throttle                                                                                  */
/* ------------------------------------------------------------------------------------------ */

/**
 * A token-bucket rate limiter over an injected clock and sleep.
 *
 * **A port, and the tests' `immediateThrottle` is why.** A real 2 rps makes a 20-resource sweep take ten
 * seconds; that is how a reconciler test gets `it.skip`'d and the reconciler stops being tested at all. The
 * test double still **counts** its calls, so "the sweep was throttled" is an assertion about the number of
 * limiter admissions rather than a comment.
 *
 * Implementation note: the limiter is a simple *spacing* rule — one admission every `1000 / rps` ms — rather
 * than a bucket that allows a burst. A burst is the wrong shape for EC-PP-2: PayPal's limit is on the
 * average rate, and a cron that fires 100 requests in the first 200 ms of a 5-minute window is more likely
 * to be sitting behind a shared rate limiter than one that paces itself.
 */
export function createThrottle(opts: {
  readonly rps: number
  readonly sleep: Sleep
  readonly nowMs: () => number
  readonly logger?: Logger
}): Throttle {
  const intervalMs = Math.max(0, 1000 / Math.max(0.0001, opts.rps))
  let nextAt = opts.nowMs()
  return {
    rps: opts.rps,
    async run<T>(task: () => Promise<T>): Promise<T> {
      const now = opts.nowMs()
      if (nextAt > now) await opts.sleep(nextAt - now)
      nextAt = Math.max(opts.nowMs(), nextAt) + intervalMs
      return task()
    },
  }
}

/** The production throttle: 2 rps, real sleep, the system clock. */
export function defaultThrottle(
  rps: number = DEFAULT_RECONCILE_RPS,
  sleep: Sleep = realSleep,
  nowMs: () => number = Date.now,
  logger?: Logger,
): Throttle {
  return createThrottle({ rps, sleep, nowMs, logger })
}

/* ------------------------------------------------------------------------------------------ */
/* The sweeps                                                                                    */
/* ------------------------------------------------------------------------------------------ */

/** What one sweep did, per resource kind, plus the failures that did not stop it. */
export interface SweepReport {
  readonly startedAt: Date
  /**
   * Rows the sweep actually did something about. A row the store offered that turned out not to be due yet
   * is not counted — `candidates` answers "how much did we look at", not "how much did the query return".
   */
  readonly candidates: number
  readonly advanced: number
  /** EC-WH-1's `reconciler_fixes_total`: first time we learned the state, i.e. no webhook told us. */
  readonly fixes: number
  readonly unchanged: number
  readonly ignored: number
  readonly failed: number
  /** Per-candidate errors, so a sweep that half-succeeded says which half. */
  readonly errors: readonly CsError[]
}

function emptyReport(startedAt: Date): SweepReport {
  return {
    startedAt,
    candidates: 0,
    advanced: 0,
    fixes: 0,
    unchanged: 0,
    ignored: 0,
    failed: 0,
    errors: [],
  }
}

function tally(report: SweepReport, outcome: ProcessOutcome, fixed: boolean): SweepReport {
  switch (outcome.outcome) {
    case 'ADVANCED':
      return {
        ...report,
        advanced: report.advanced + 1,
        fixes: report.fixes + (fixed ? 1 : 0),
      }
    case 'UNCHANGED':
      return { ...report, unchanged: report.unchanged + 1, fixes: report.fixes + (fixed ? 1 : 0) }
    case 'IGNORED':
      return { ...report, ignored: report.ignored + 1 }
    default:
      return report
  }
}

export interface ReconcileOptions extends Partial<ReconcilerOptions> {
  /** Stop after this many candidates, so one cycle cannot run for the whole backlog. */
  readonly limit?: number
  /** §8.11 ledger movement, if a capture's rank advances. */
  readonly hooks?: CaptureOutcomeHooks
}

/**
 * §8.12's 5-minute and nightly sweeps.
 *
 * One function for both because "not terminal" is the only difference between them, and `findOrdersForReconcile`
 * in `repos/orders.ts` says the same thing in its own docstring. The **nightly** run passes
 * `lookbackDays: 30` over the same window, which is what makes it a *full* sweep rather than a wider one:
 * a row that has been stuck in a non-terminal state for 30 days is precisely the row worth re-reading.
 *
 * Order of operations, and it matters: **the authorization expiry sweep runs first.** An authorization past
 * `expiration_time` has nothing left to re-fetch — PayPal has dropped it — so sweeping it first would fetch a
 * 404 and record EC-WH-6's "ignored" instead of EC-TIME-5's `AUTH_EXPIRED`.
 *
 * @returns `ok` even when individual resources failed. A sweep that returns `err` on the first 404 would
 *   never reach resource 20, and the report is how a human sees the failures.
 */
export async function reconcileResources(
  deps: WebhookDeps,
  options: ReconcileOptions = {},
): Promise<Result<SweepReport, CsError>> {
  const now = options.now ?? new Date(deps.clock.nowMs())
  const lookbackDays = options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS
  const limit = options.limit ?? DEFAULT_SWEEP_BATCH
  const since = new Date(now.getTime() - lookbackDays * 86_400_000)
  let report = emptyReport(now)

  const expiry = await authorizationExpirySweep(deps, { ...options, now })
  if (!expiry.ok) return expiry
  report = merge(report, expiry.value)

  // Each aggregate is swept through the **same** helper, and the helper is what decides which rows are
  // worth a request. §8.12 says "orders/authorizations/captures not terminal and updated in the last 30
  // days", and the two repository queries that exist for this (`findOrdersForReconcile`, and the port
  // member `captures.reconcileCandidates`) already exclude terminal rows — so a capture that is `REFUNDED`
  // costs no request. See `isReconcileCandidate`.
  const orders = await deps.store.aggregates.orders.reconcileCandidates(since)
  if (!orders.ok) return orders
  for (const order of orders.value.slice(0, limit)) {
    if (order.paypal_order_id === null) continue
    if (!isReconcileCandidate('order', order.status)) continue
    const step = await sweepOne(deps, 'order', order.paypal_order_id, options.hooks, now)
    if (!step.ok) {
      report = fail(report, step.error)
      continue
    }
    report = tally(
      { ...report, candidates: report.candidates + 1 },
      step.value.outcome,
      step.value.fixedWithoutWebhook,
    )
  }

  // The expiry sweep already visited every authorization it considered, and `reconcileCandidates(horizon)`
  // returns exactly that set. Re-sweeping them here would double the requests for the same rows and make the
  // throttle's job harder for no gain, so the general sweep reads them with `expiration_time <= now`
  // instead — which is what "not terminal and due" means for an authorization.
  const authorizations = await deps.store.aggregates.authorizations.reconcileCandidates(now)
  if (!authorizations.ok) return authorizations
  for (const authorization of authorizations.value.slice(0, limit)) {
    if (!isReconcileCandidate('authorization', authorization.status)) continue
    const step = await sweepOne(
      deps,
      'authorization',
      authorization.paypal_authorization_id,
      options.hooks,
      now,
    )
    if (!step.ok) {
      report = fail(report, step.error)
      continue
    }
    report = tally(
      { ...report, candidates: report.candidates + 1 },
      step.value.outcome,
      step.value.fixedWithoutWebhook,
    )
  }

  const captures = await collectNonTerminalCaptures(deps, since, limit)
  if (!captures.ok) return captures
  for (const capture of captures.value) {
    const step = await sweepOne(deps, 'capture', capture.paypal_capture_id, options.hooks, now)
    if (!step.ok) {
      report = fail(report, step.error)
      continue
    }
    report = tally(
      { ...report, candidates: report.candidates + 1 },
      step.value.outcome,
      step.value.fixedWithoutWebhook,
    )
  }

  deps.logger?.info('reconciler sweep complete', {
    candidates: report.candidates,
    advanced: report.advanced,
    fixes: report.fixes,
    unchanged: report.unchanged,
    ignored: report.ignored,
    failed: report.failed,
  })
  return ok(report)
}

/**
 * §8.12's 2-minute dispute cron: `listDisputes(start_time = last_seen − 1h)`.
 *
 * The one-hour overlap is not belt-and-braces. PayPal's `start_time` filter is on `update_time`, and a
 * dispute whose stage moved between two polls has an `update_time` inside the window — but a clock skew of a
 * few seconds between us and PayPal can put a genuinely-changed dispute just outside a window computed
 * from our last poll, and an hour of overlap costs nothing because the rank makes re-processing free.
 *
 * **Every item in the list is re-fetched** with `getDispute`, because the list is a hint and the item is
 * not: the list response carries `status` but the ordering that matters is `(stage, status, update_time)`,
 * and the list's `items` array is exactly where a partial shape would come from.
 */
export async function reconcileDisputes(
  deps: WebhookDeps,
  options: ReconcileOptions = {},
): Promise<Result<SweepReport, CsError>> {
  const now = options.now ?? new Date(deps.clock.nowMs())
  const overlap = options.disputeOverlapSeconds ?? DEFAULT_DISPUTE_OVERLAP_SECONDS
  const limit = options.limit ?? DEFAULT_SWEEP_BATCH
  let report = emptyReport(now)

  const lastSeen = await deps.store.aggregates.disputes.updatedSince(
    new Date(now.getTime() - overlap * 1000),
  )
  if (!lastSeen.ok) return lastSeen

  const listed = await deps.paypal.listDisputes({
    start_time: new Date(now.getTime() - overlap * 1000).toISOString(),
    // PayPal's `page_size` max is **50** (`SPEC-D`), so a larger batch is a 400 rather than a bigger page.
    page_size: Math.min(limit, 50),
  })
  if (!listed.ok) return listed

  for (const item of listed.value.items.slice(0, limit)) {
    const step = await sweepOne(deps, 'dispute', item.dispute_id, undefined, now)
    if (!step.ok) {
      report = fail(report, step.error)
      continue
    }
    report = tally(
      { ...report, candidates: report.candidates + 1 },
      step.value.outcome,
      step.value.fixedWithoutWebhook,
    )
  }

  deps.logger?.info('dispute sweep complete', {
    start_time: new Date(now.getTime() - overlap * 1000).toISOString(),
    items: listed.value.items.length,
    advanced: report.advanced,
    fixes: report.fixes,
  })
  return ok(report)
}

/**
 * EC-TIME-5. **The only sweep that can observe an expired authorization**, because no such event exists.
 *
 * Two answers per candidate, and the distinction is [V15]'s two clocks rather than ours:
 *
 * - `now >= expiration_time` → `EXPIRED`. The authorization is gone; the row is terminal and the uncaptured
 *   remainder is somebody else's problem to release (WP-11's `reauthorizeIfNeeded` does that when it is
 *   wired; this sweep records the state, which is the half this package owns).
 * - `honor_expires_at <= now < expiration_time` → the honour window is open. PayPal allows reauthorization
 *   **only** from day four [V15], so calling earlier is a 422 and not a harmless no-op. This sweep therefore
 *   *reports* the window rather than calling `reauthorize` — see `README.md` → "Contract issues" for why
 *   the call is not made here.
 *
 * `authorizations.reconcileCandidates(before)` is `findAuthorizationsExpiring`, which filters on
 * `expiration_time <= before` **and** `status = 'CREATED'`. That filter is why this is the *first* sweep in
 * {@link reconcileResources}: an expired authorization is not in the candidates of the general sweep, so
 * ordering only matters for the authorization loop below, which would otherwise re-read it and hit a 404.
 */
export async function authorizationExpirySweep(
  deps: WebhookDeps,
  options: ReconcileOptions = {},
): Promise<Result<SweepReport, CsError>> {
  const now = options.now ?? new Date(deps.clock.nowMs())
  const limit = options.limit ?? DEFAULT_SWEEP_BATCH
  let report = emptyReport(now)

  // A horizon rather than `now`: a row that expired an hour ago is still worth finding, and so is every row
  // whose honour window has already opened. See {@link EXPIRY_SWEEP_HORIZON_DAYS} for why that is 26 days.
  const horizon = new Date(now.getTime() + EXPIRY_SWEEP_HORIZON_DAYS * 86_400_000)
  const candidates = await deps.store.aggregates.authorizations.reconcileCandidates(horizon)
  if (!candidates.ok) return candidates

  for (const authorization of candidates.value.slice(0, limit)) {
    const expired = now.getTime() >= authorization.expiration_time.getTime()
    const honourOpen =
      now.getTime() >= authorization.honor_expires_at.getTime() &&
      now.getTime() < authorization.expiration_time.getTime()
    if (!expired && !honourOpen) continue

    const fetched = await deps.throttle.run(() =>
      deps.paypal.getAuthorization(authorization.paypal_authorization_id),
    )
    if (!fetched.ok) {
      // A 404 for an authorization we believe is `CREATED` means PayPal has already dropped it, which is
      // the same answer as an expiry as far as we are concerned.
      if (fetched.error.code !== 'PP_NOT_FOUND') {
        report = fail(report, fetched.error)
        continue
      }
      report = { ...report, candidates: report.candidates + 1, ignored: report.ignored + 1 }
      continue
    }

    // PayPal says nothing about expiry; `expiration_time` does. It is our 29-day clock (EC-TIME-5) and the
    // row's own copy is the one PayPal restamped at authorization time.
    // The re-fetch decides, in two stages, and the order is the whole point.
    //
    //  1. **PayPal first.** If PayPal says the authorization is `VOIDED`, `DENIED` or `CAPTURED`, that is
    //     the truth and we record it — even when our own clock says it has expired. A row that is `CREATED`
    //     locally and `VOIDED` at PayPal is a voided authorization, and writing `EXPIRED` would tell the
    //     buyer's ledger the wrong reason the money moved. `EXPIRED` is **ours**, from `expiration_time`,
    //     and it is the answer only when PayPal has not said otherwise.
    //
    //  2. **Our 29-day clock second.** `expiration_time` is the field [V15] documents and the only source of
    //     the expiry, because no `PAYMENT.AUTHORIZATION.EXPIRED` event exists (report §26).
    const paypalStatus = fetched.value.status
    const decided = paypalDecidedStatus(paypalStatus)
    const target = decided ?? (expired ? 'EXPIRED' : 'CREATED')

    if (target === authorization.status) {
      report = { ...report, candidates: report.candidates + 1, unchanged: report.unchanged + 1 }
      continue
    }
    const written = await deps.store.aggregates.authorizations.setStatus(
      authorization.id,
      target,
      now,
    )
    if (!written.ok) {
      report = fail(report, written.error)
      continue
    }
    report = {
      ...report,
      candidates: report.candidates + 1,
      advanced: report.advanced + 1,
      // A "fix" is a first learn. Re-stamping `CREATED` for a row that already says `CREATED` never
      // reaches here; this branch is a row whose status actually moved, and the only reason we were looking
      // is that our clock said it was due.
      fixes: report.fixes + (authorization.fetched_at === null ? 1 : 0),
    }
    deps.logger?.info('authorization expiry sweep moved a row', {
      authorization_id: authorization.id,
      from: authorization.status,
      to: target,
      paypalStatus,
      honorWindowOpen: honourOpen,
      expiredByOurClock: expired,
    })
  }

  return ok(report)
}

/**
 * What PayPal's own answer settles, or `null` when it settles nothing.
 *
 * Only the statuses that are **terminal on branch 1** — the ones where the resource has definitively
 * stopped existing for our purposes. A `CREATED` from PayPal is not an answer: it only tells us the row was
 * not voided, which is the absence of news, and our 29-day clock is what says it has expired.
 */
function paypalDecidedStatus(paypalStatus: string): 'VOIDED' | 'DENIED' | 'CAPTURED' | null {
  switch (paypalStatus) {
    case 'VOIDED':
    case 'DENIED':
    case 'CAPTURED':
      return paypalStatus
    default:
      return null
  }
}

/**
 * The unprocessed-queue sweep: EC-WH-1 and EC-WH-5's backstop for rows that were stored but never enqueued
 * (a queue that was down, a worker that crashed between the two writes).
 *
 * Cheap on purpose — it reads `webhook_events`, not PayPal — and it is what makes §8.12 step 5's "200 even
 * if processing fails" safe to say out loud.
 */
export async function reprocessUnstoredWork(
  deps: WebhookDeps,
  limit = DEFAULT_SWEEP_BATCH,
): Promise<Result<{ requeued: number }, CsError>> {
  const listed = await deps.store.events.listUnprocessed(limit)
  if (!listed.ok) return listed
  let requeued = 0
  for (const row of listed.value) {
    // Never re-drive an unverified or forged row: `wh.verify` owns `PENDING`, and `FAILED` is EC-WH-4.
    if (row.verified !== 'VERIFIED') continue
    const sent = await deps.queue.send(
      JOB_PROCESS,
      {
        webhookEventId: row.id,
        resourceId: row.resource_id,
        resourceType: row.resource_type,
        eventType: row.event_type,
      },
      { singletonKey: row.resource_id, retryLimit: 5, retryBackoff: true },
    )
    if (sent.ok) requeued += 1
  }
  return ok({ requeued })
}

/* ------------------------------------------------------------------------------------------ */
/* Internals                                                                                     */
/* ------------------------------------------------------------------------------------------ */

/**
 * One throttled re-fetch of one resource.
 *
 * Every PayPal read in this file goes through here, which is what makes "the reconciler is throttled to
 * 2 rps" a property of the file rather than a property of each loop remembering to be careful.
 */
async function sweepOne(
  deps: WebhookDeps,
  kind: 'order' | 'authorization' | 'capture' | 'dispute',
  resourceId: string,
  hooks: CaptureOutcomeHooks | undefined,
  now: Date,
): Promise<Result<{ outcome: ProcessOutcome; fixedWithoutWebhook: boolean }, CsError>> {
  return deps.throttle.run(() => reconcileOne(kind, resourceId, deps, hooks, now))
}

/**
 * Is this row worth a PayPal request?
 *
 * §8.12: "orders/authorizations/captures **not terminal** and updated in the last 30 days". The repository
 * queries filter on `updated_at` already, and this adds the "not terminal" half from the **same** rank
 * tables the write path uses — so a row the reconciler would refuse to change is never fetched in the first
 * place.
 *
 * Not merely an optimisation. A terminal capture that is re-fetched yields `SKIP_TERMINAL`: harmless, but it
 * still costs one of the 2 rps EC-PP-2 allows. On a busy day the terminal rows would crowd out the
 * non-terminal ones, and the non-terminal ones are the only ones that can still change.
 */
export function isReconcileCandidate(
  kind: 'order' | 'authorization' | 'capture',
  status: string,
): boolean {
  return !isTerminalStatus(kind, status)
}

async function collectNonTerminalCaptures(
  deps: WebhookDeps,
  since: Date,
  limit: number,
): Promise<Result<{ paypal_capture_id: string }[], CsError>> {
  const found = await deps.store.aggregates.captures.reconcileCandidates(since, limit)
  if (!found.ok) return found
  return ok(found.value)
}

function merge(a: SweepReport, b: SweepReport): SweepReport {
  return {
    startedAt: a.startedAt,
    candidates: a.candidates + b.candidates,
    advanced: a.advanced + b.advanced,
    fixes: a.fixes + b.fixes,
    unchanged: a.unchanged + b.unchanged,
    ignored: a.ignored + b.ignored,
    failed: a.failed + b.failed,
    errors: [...a.errors, ...b.errors],
  }
}

function fail(report: SweepReport, error: CsError): SweepReport {
  return {
    ...report,
    candidates: report.candidates + 1,
    failed: report.failed + 1,
    errors: [...report.errors, error],
  }
}
