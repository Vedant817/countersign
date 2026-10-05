/**
 * `releaseExpiredReservations` — spec **§8.10** ("Reservations expire after 30 min without an order
 * (a worker job releases them)"), **§7.2**, §12.4 **EC-MDT-2**, AGENTS.md rule 6.
 *
 * ## Why this job is the one that was never running
 *
 * §8.10 check 8 takes a **reservation** against the buyer's signed budget, not against their money. Nothing
 * is charged until an order exists. But the reservation is a real claim on their *authority*: if it is never
 * given back, their budget shrinks by that amount for ever and every future cart under the same mandate is
 * smaller than it should be. `apps/worker`'s `release.reservations` cron is what returns it, and before this
 * package existed nothing was wired into that cron — so the claim would have outlived the attempt.
 *
 * ## The composition, in order
 *
 * ```
 *   store.staleAttempts(now - 30 min)                     repos/attempts.ts::findStaleAttempts
 *     ──▶ drop attempts whose RELEASE entry already exists  idempotency, before any write
 *     ──▶ expireStaleReservations(budget, {candidates, nowSec})   @countersign/ledger, once per candidate
 *     ──▶ setAttemptState(attemptId, 'AUTH_EXPIRED')        so the query stops returning it
 * ```
 *
 * Everything the third arrow does is `packages/ledger`'s: the TTL comparison, the deterministic entry id,
 * and the clamping release. This file adds the **candidate query**, the **already-released filter**, and the
 * **attempt marker**, and it deliberately re-implements none of the arithmetic.
 *
 * ## Why idempotency is a filter rather than a catch
 *
 * `releaseIn` inserts a `budget_entries` row whose primary key is `releaseEntryId(attemptId, mandateId)` —
 * derived, not random (AGENTS.md rule 6). A second sweep therefore *cannot* release the same reservation
 * twice: the insert hits the primary key and comes back `CS_CONFLICT`. That is the backstop, and it is
 * exactly the kind of backstop you do not want to be relying on, because a `CS_CONFLICT` from a sweep reads
 * like a real conflict at the call site.
 *
 * So the filter comes first: an attempt whose `budget_entries` already hold a `RELEASE` is reported under
 * {@link ReservationReleaseReport.alreadyReleased} and never reaches the write. A sweep that runs every five
 * minutes therefore reports `released: 0, alreadyReleased: 2` after the first one, which is a truthful
 * answer rather than a stream of errors.
 *
 * ## Why the ledger is called once per candidate rather than once for the batch
 *
 * `expireStaleReservations` returns `err` when **any** release failed, and on that path the report of the
 * ones that succeeded is lost. Calling it per candidate keeps every outcome: nine releases that succeeded and
 * one that failed are then reportable as nine plus one, which is the difference between an operator chasing
 * one broken mandate and an operator wondering whether nine buyers still have money held. The work done is
 * identical — the function loops over its candidates internally either way.
 *
 * ## Why failures are collected rather than thrown
 *
 * One mandate with a missing `budget_accounts` row must not strand every other buyer's reservation. Each
 * failure is collected into {@link ReservationReleaseReport.errors} and the call still returns `ok`, because
 * a sweep that released nine of ten reservations **has** succeeded at nine of them, and the report is where
 * the tenth is visible.
 */
import {
  csError,
  formatIst,
  ok,
  type AttemptId,
  type CsError,
  type MandateId,
  type Result,
} from '@countersign/core'
import type { BudgetEntryRow, CheckoutAttemptRow } from '@countersign/db'
import {
  expireStaleReservations,
  RELEASE_REASONS,
  RESERVATION_TTL_SECONDS,
  reservationEntryId,
  type OpenReservation,
} from '@countersign/ledger'

import type { OrchestratorDeps, ReservationReleaseReport } from './types'

/**
 * `ReservationReleaseReport` with the arrays writable.
 *
 * The public type is `readonly` because a *caller* must not be able to edit a report it was handed. The
 * sweep, which is the one thing that may, needs a mutable shape for the duration of the run and returns the
 * frozen one — so the read-only guarantee is preserved rather than dropped to make the function shorter.
 */
type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/**
 * §8.10's 30-minute sweep.
 *
 * @param deps the whole {@link OrchestratorDeps}. Only `store`, `budget`, `clock` and `logger` are read;
 *   the rest are present because the purchase and dispute paths share one closed dependency list.
 * @param now the instant to judge expiry against, **injected** rather than read. Two reasons: §12.5
 *   EC-TIME-4's one-instant discipline, and that a sweep is the one place where "when did we decide this was
 *   stale" must be a fact a test can pin rather than a race.
 * @param options.ttlSeconds defaults to {@link RESERVATION_TTL_SECONDS} (1800). Overridable so a test can
 *   prove the boundary without waiting half an hour; production never passes it.
 */
export async function releaseExpiredReservations(
  deps: OrchestratorDeps,
  now: Date,
  options: { readonly ttlSeconds?: number; readonly reason?: string } = {},
): Promise<Result<ReservationReleaseReport, CsError>> {
  const ttl = options.ttlSeconds ?? RESERVATION_TTL_SECONDS
  const nowSec = Math.floor(now.getTime() / 1000)
  const instant = {
    epochSec: nowSec,
    utc: now.toISOString(),
    // AGENTS.md rule 10: epoch seconds and UTC in the data, IST for a human reading a report.
    ist: formatIst(nowSec),
  }
  const report: Mutable<ReservationReleaseReport> = {
    candidates: 0,
    released: [],
    alreadyReleased: [],
    stillHeld: [],
    errors: [],
    nowSec,
    now: instant,
  }

  // --- 1. Candidates: §8.10's "reservations expire after 30 min without an order". ------------------
  //
  // `findStaleAttempts` filters on `state in ('GATED_ALLOW','CREATED')` and `created_at < olderThan`. A
  // reservation is therefore a candidate by construction — the Gate wrote it and left the attempt there —
  // and an attempt that reached `ORDER_CREATED` is not, which is the correct reading of "without an order".
  const candidates = await deps.store.staleAttempts(new Date(now.getTime() - ttl * 1000))
  if (!candidates.ok) return candidates
  report.candidates = candidates.value.length
  if (candidates.value.length === 0) return ok(report)

  // --- 2. The idempotency filter, before any write. ------------------------------------------------
  const settled = await partitionAlreadyReleased(candidates.value, deps)
  if (!settled.ok) return settled
  report.alreadyReleased = settled.value.alreadyReleased

  // --- 3. The release itself, one candidate at a time so no outcome is lost to a batch summary. -----
  for (const attempt of settled.value.pending) {
    const open = toOpenReservation(attempt)
    const outcome = await expireStaleReservations(deps.budget, {
      candidates: [open],
      nowSec,
      ttlSeconds: ttl,
      reason: options.reason ?? RELEASE_REASONS.noOrder,
    })
    if (!outcome.ok) {
      report.errors.push(outcome.error)
      continue
    }
    for (const entry of outcome.value.expired) {
      report.released.push({
        attemptId: entry.handle.attemptId,
        mandateId: entry.handle.mandateId,
        // The reservation's own amount, which is what the caller asked back. `releaseIn` **clamps** at the
        // current `reserved`, so the authoritative figure for a partial release is the ledger entry's
        // `amount_minor` — which is why this field is documented as "asked for" rather than "given".
        amountMinor: entry.handle.amount.minor,
        currency: entry.handle.amount.currency,
        balance: {
          // The balance **after** the release, which is what a report should state about the buyer.
          reservedMinor: entry.released.reserved.minor,
          availableMinor: entry.released.available.minor,
        },
      })
    }
    for (const handle of outcome.value.stillHeld) {
      report.stillHeld.push(handle.attemptId)
    }
  }

  // --- 4. Close each swept attempt, so the query stops returning it. --------------------------------
  //
  // `AUTH_EXPIRED` is the honest state: no authorization was ever created for this attempt, its 30-minute
  // window closed, and nothing was charged. It is set **after** the release, so a failure here leaves the
  // reservation already returned rather than the reverse.
  for (const released of report.released) {
    const marked = await markExpired(released.attemptId, deps, now)
    if (!marked.ok) report.errors.push(marked.error)
  }

  deps.logger?.info('orchestrator.sweep: reservations released', {
    now_utc: instant.utc,
    now_ist: instant.ist,
    candidates: report.candidates,
    released: report.released.length,
    already_released: report.alreadyReleased.length,
    still_held: report.stillHeld.length,
    failed: report.errors.length,
  })

  return ok(report)
}

/* ------------------------------------------------------------------------------------------ */
/* Steps                                                                                          */
/* ------------------------------------------------------------------------------------------ */

/**
 * A stale attempt as an {@link OpenReservation}.
 *
 * `entryId` is the **derived** RESERVE entry id (`reservationEntryId`), recomputed rather than read from
 * `budget_entries`. Recomputing is the point: it is the same function Gate check 8 used to write the row, so
 * a mismatch means the attempt was never reserved — and `releaseIn` clamping at the current `reserved` is
 * exactly right for that case, giving back nothing rather than inventing authority.
 */
function toOpenReservation(attempt: CheckoutAttemptRow): OpenReservation {
  const attemptId = attempt.id as AttemptId
  const mandateId = attempt.mandate_id as MandateId
  return {
    attemptId,
    mandateId,
    amount: { minor: attempt.amount_minor, currency: attempt.currency },
    reservedAtSec: Math.floor(attempt.created_at.getTime() / 1000),
    entryId: reservationEntryId(attemptId, mandateId),
  }
}

/**
 * Split the candidates into "already released" and "still to release".
 *
 * One `budget_entries` read per **distinct mandate**, not per attempt: `listEntries` is keyed by mandate and
 * every attempt on it is answered from that one result.
 */
async function partitionAlreadyReleased(
  attempts: readonly CheckoutAttemptRow[],
  deps: OrchestratorDeps,
): Promise<Result<{ pending: CheckoutAttemptRow[]; alreadyReleased: AttemptId[] }, CsError>> {
  const byMandate = new Map<MandateId, CheckoutAttemptRow[]>()
  for (const attempt of attempts) {
    const mandateId = attempt.mandate_id as MandateId
    const list = byMandate.get(mandateId)
    if (list === undefined) byMandate.set(mandateId, [attempt])
    else list.push(attempt)
  }

  const pending: CheckoutAttemptRow[] = []
  const alreadyReleased: AttemptId[] = []

  for (const [mandateId, group] of byMandate) {
    const entries = await deps.store.budgetEntries(mandateId)
    if (!entries.ok) return entries
    const settled = new Set(releasedAttemptIds(entries.value))
    for (const attempt of group) {
      if (settled.has(attempt.id as AttemptId)) alreadyReleased.push(attempt.id as AttemptId)
      else pending.push(attempt)
    }
  }

  return ok({ pending, alreadyReleased })
}

/**
 * Which attempts already have a `RELEASE` entry.
 *
 * Matched on `(attempt_id, kind)`, and **not** on the derived entry id. The id would be equivalent for an
 * entry this sweep wrote, but a `RELEASE` written by `packages/orders`' budget hook — a void, or an
 * EC-MDT-2 abort — carries the same `releaseEntryId` and the same `attempt_id`, so this predicate catches
 * both. A release that came from anywhere is a release.
 */
function releasedAttemptIds(entries: readonly BudgetEntryRow[]): string[] {
  const out: string[] = []
  for (const entry of entries) {
    if (entry.kind !== 'RELEASE') continue
    if (typeof entry.attempt_id === 'string' && entry.attempt_id !== '') out.push(entry.attempt_id)
  }
  return out
}

/**
 * Mark a swept attempt `AUTH_EXPIRED`.
 *
 * A no-op when `store.setAttemptState` is not wired, which is why it is optional on the port: the sweep is
 * correct without it — the ledger's entry id is the real idempotency key — it simply keeps re-reading the
 * same rows every five minutes. The absence is **logged**, because a silent degradation of a
 * leak-prevention job is exactly the kind of thing nobody notices until a buyer complains.
 */
async function markExpired(
  attemptId: AttemptId,
  deps: OrchestratorDeps,
  now: Date,
): Promise<Result<true, CsError>> {
  if (deps.store.setAttemptState === undefined) {
    deps.logger?.warn(
      'orchestrator.sweep: no setAttemptState wired, swept attempts will be re-read',
      {
        attempt_id: attemptId,
      },
    )
    return ok(true)
  }
  const marked = await deps.store.setAttemptState(attemptId, 'AUTH_EXPIRED', now)
  if (!marked.ok) return marked
  return ok(true)
}

/** The §8.10 window, re-exported so a caller naming it has one import. */
export { RESERVATION_TTL_SECONDS }
export { csError as sweepError }
