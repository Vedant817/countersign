/**
 * Reservation lifecycle — spec **§8.10** ("Reservations expire after 30 min without an order"), **D19**,
 * §12 **EC-MDT-2** (release on revoke), **EC-STOCK-3** (release on out-of-stock), §7.2.
 *
 * ## The three properties this file exists to guarantee
 *
 *  1. **The lock is never bypassed.** Every mutation here goes through `reserveIn` / `releaseIn` from
 *     `packages/db`, which `SELECT … FOR UPDATE`s the `budget_accounts` row before reading it. There is
 *     deliberately no `UPDATE … SET reserved = reserved + $1` in this file and no way to reach one, so
 *     the optimistic path this project names as its one budget hazard
 *     (`packages/db/repos/budget.ts`, "Why every mutation takes FOR UPDATE") cannot be reintroduced by
 *     writing new code here.
 *  2. **A retry cannot double-write.** Every entry id is *derived* from our own ids (§8.0 rule 6:
 *     "deterministic … id derived from our own IDs"), so re-running a reserve for the same attempt hits
 *     the `budget_entries` primary key instead of claiming the buyer's budget twice. The id is minted
 *     before the write, which is why `packages/db` requires one rather than defaulting it.
 *  3. **A failure after check 8 gives the money back.** {@link releaseReservation} is the compensation
 *     the Gate calls when any later check fails (AT-M10.4) and the orchestrator calls when no order is
 *     created. Its id is derived the same way, and `releaseIn` clamps at the current `reserved`, so
 *     neither a retry nor a sweep racing an explicit void can credit authority never reserved.
 */

import { createHash } from 'node:crypto'

import {
  csError,
  err,
  formatMoney,
  ok,
  type AttemptId,
  type CsError,
  type MandateId,
  type Money,
  type Result,
} from '@countersign/core'
import { canonicalJson, releaseIn, reserveIn } from '@countersign/db'

import {
  RELEASE_REASONS,
  RESERVATION_TTL_SECONDS,
  type BudgetBalance,
  type BudgetStore,
  type ExpiredReservation,
  type LedgerEntryKind,
  type OpenReservation,
  type ReleaseReason,
  type ReservationExpiryReport,
  type ReservationHandle,
  type ReservationStatus,
} from './types'

/* ------------------------------------------------------------------------------------------ */
/* Deterministic entry identity                                                                   */
/* ------------------------------------------------------------------------------------------ */

/** What an entry's identity is derived from. One entry per (kind, owner) is the invariant. */
export interface LedgerEntryScope {
  readonly kind: LedgerEntryKind
  readonly mandateId: MandateId
  /** Set for RESERVE/RELEASE; `null` for COMMIT/REVERSE, which are keyed by capture. */
  readonly attemptId?: AttemptId | null
  readonly captureId?: string | null
}

/**
 * `ben_` + 26 hex chars of SHA-256 over the canonical form of the scope.
 *
 * Derived rather than random, for the reason in rule 2 above. The 26-char body matches our other ids'
 * length so a log line is readable, and the preimage contains only ids we minted.
 */
export function ledgerEntryId(scope: LedgerEntryScope): string {
  const digest = createHash('sha256')
    .update(
      canonicalJson({
        captureId: scope.captureId ?? null,
        kind: scope.kind,
        mandateId: scope.mandateId,
        attemptId: scope.attemptId ?? null,
      }),
      'utf8',
    )
    .digest('hex')
  return `ben_${digest.slice(0, 26)}`
}

/** The RESERVE entry id for an attempt. */
export function reservationEntryId(attemptId: AttemptId, mandateId: MandateId): string {
  return ledgerEntryId({ kind: 'RESERVE', mandateId, attemptId })
}

/** The RELEASE entry id for an attempt. Stable, so a swept-then-voided pair writes one row, not two. */
export function releaseEntryId(attemptId: AttemptId, mandateId: MandateId): string {
  return ledgerEntryId({ kind: 'RELEASE', mandateId, attemptId })
}

/* ------------------------------------------------------------------------------------------ */
/* Status                                                                                        */
/* ------------------------------------------------------------------------------------------ */

/**
 * A reservation's status, derived from the two facts we have: whether an order took the money and
 * whether the 30 minutes ran out.
 *
 * `COMMITTED` beats `EXPIRED`: a reservation that reached a capture inside the window is settled
 * money, and a late sweep must never report it as expirable. That precedence is the whole reason
 * this is a function rather than a stored column.
 */
export function reservationStatus(input: {
  readonly committed: boolean
  readonly released: boolean
  readonly expiresAtSec: number
  readonly nowSec: number
}): ReservationStatus {
  if (input.committed) return 'COMMITTED'
  if (input.released) return 'RELEASED'
  return input.nowSec >= input.expiresAtSec ? 'EXPIRED' : 'HELD'
}

/**
 * Has this reservation outlived its window? Spec §8.10's 30 minutes.
 *
 * `>=`, not `>`: at exactly `createdAtSec + 1800` the window is over. A reservation that survived to
 * the exact second would depend on how the cron happened to be scheduled.
 */
export function reservationHasExpired(
  createdAtSec: number,
  nowSec: number,
  ttlSeconds: number = RESERVATION_TTL_SECONDS,
): boolean {
  return nowSec >= createdAtSec + ttlSeconds
}

/* ------------------------------------------------------------------------------------------ */
/* Reserve / release                                                                             */
/* ------------------------------------------------------------------------------------------ */

export interface ReserveForAttemptInput {
  readonly attemptId: AttemptId
  readonly mandateId: MandateId
  readonly amount: Money
  /**
   * Epoch seconds, supplied by the caller.
   *
   * Not read from a `Clock` here on purpose: spec §12.5 **EC-TIME-4** requires every expiry
   * comparison in one Gate decision to use the *single* `clock.nowSec()` captured at Gate start. A
   * reservation that read the clock itself would be stamped a second later than every other check,
   * and the price-lock boundary race the spec names would come back.
   */
  readonly nowSec: number
  readonly ttlSeconds?: number
}

/**
 * Gate check 8. Reserve `amount` against a mandate's cap and return the handle.
 *
 * The returned `budgetVersion` goes into `gate_decisions.budget_version`, so the decision record pins
 * the exact balance it was approved against rather than one that may since have moved — which is the
 * whole point of a locked read-modify-write being worth auditing at dispute time (§7.2, R2).
 *
 * @returns `err(GATE_BUDGET_EXCEEDED)` when the cap would be passed, with nothing written: the
 * `packages/db` implementation refuses *before* the insert, so "leaves no partial row" is structural.
 */
export async function reserveForAttempt(
  store: BudgetStore,
  input: ReserveForAttemptInput,
): Promise<Result<ReservationHandle, CsError>> {
  const ttl = input.ttlSeconds ?? RESERVATION_TTL_SECONDS
  const entryId = reservationEntryId(input.attemptId, input.mandateId)
  const reserved = await reserveIn(store, input.mandateId, {
    attemptId: input.attemptId,
    amount: input.amount,
    entryId,
    at: new Date(input.nowSec * 1000),
  })
  if (!reserved.ok) return reserved
  return ok({
    attemptId: input.attemptId,
    mandateId: input.mandateId,
    amount: input.amount,
    entryId,
    budgetVersion: reserved.value.balance.version,
    createdAtSec: input.nowSec,
    expiresAtSec: input.nowSec + ttl,
    balance: reserved.value.balance,
  })
}

export interface ReleaseReservationResult {
  readonly balance: BudgetBalance
}

/**
 * Give the reservation back. **AT-M10.4's assertion**: when a check after check 8 fails, the Gate
 * calls this and the buyer's `available` returns to what it was.
 */
export async function releaseReservation(
  store: BudgetStore,
  handle: ReservationHandle,
  reason: ReleaseReason | string,
  nowSec: number,
): Promise<Result<ReleaseReservationResult, CsError>> {
  const released = await releaseIn(store, handle.mandateId, {
    attemptId: handle.attemptId,
    amount: handle.amount,
    reason,
    entryId: releaseEntryId(handle.attemptId, handle.mandateId),
    at: new Date(nowSec * 1000),
  })
  if (!released.ok) return released
  return ok({ balance: released.value })
}

/* ------------------------------------------------------------------------------------------ */
/* The 30-minute sweep                                                                            */
/* ------------------------------------------------------------------------------------------ */

/**
 * Split candidates into expired and still-held. Pure.
 *
 * Pure on purpose: the *decision* of which reservations have outlived the window is the part worth
 * testing exhaustively, and it must not need a database to test. {@link expireStaleReservations} does
 * the writing.
 */
export function partitionExpired(
  candidates: readonly OpenReservation[],
  nowSec: number,
  ttlSeconds: number = RESERVATION_TTL_SECONDS,
): { expired: OpenReservation[]; stillHeld: OpenReservation[] } {
  const expired: OpenReservation[] = []
  const stillHeld: OpenReservation[] = []
  for (const c of candidates) {
    if (reservationHasExpired(c.reservedAtSec, nowSec, ttlSeconds)) expired.push(c)
    else stillHeld.push(c)
  }
  return { expired, stillHeld }
}

export interface ExpireStaleInput {
  readonly candidates: readonly OpenReservation[]
  readonly nowSec: number
  readonly ttlSeconds?: number
  readonly reason?: ReleaseReason | string
}

/** What the sweep did, per reservation, plus whatever it could not do. */
export interface ExpireStaleReport extends ReservationExpiryReport {
  readonly errors: readonly CsError[]
}

/**
 * Release every candidate whose 30 minutes ran out. The primitive WP-12's cron calls.
 *
 * Each release is reported individually: a sweep that released three of four reservations must say
 * which three, because "the buyer still has $60 held" is a bug somebody has to chase and a silent
 * partial success hides it. A candidate whose release fails is collected into `errors` rather than
 * aborting the sweep — one broken mandate must not strand every other reservation — and the overall
 * call is still `err`, because a sweep that only half worked has not succeeded.
 */
export async function expireStaleReservations(
  store: BudgetStore,
  input: ExpireStaleInput,
): Promise<Result<ExpireStaleReport, CsError>> {
  const ttl = input.ttlSeconds ?? RESERVATION_TTL_SECONDS
  const { expired, stillHeld } = partitionExpired(input.candidates, input.nowSec, ttl)
  const released: ExpiredReservation[] = []
  const errors: CsError[] = []

  for (const c of expired) {
    const handle = openReservationHandle(c, ttl)
    const outcome = await releaseReservation(
      store,
      handle,
      input.reason ?? RELEASE_REASONS.noOrder,
      input.nowSec,
    )
    if (outcome.ok) released.push({ handle, released: outcome.value.balance })
    else errors.push(outcome.error)
  }

  const report: ExpireStaleReport = {
    expired: released,
    stillHeld: stillHeld.map((c) => openReservationHandle(c, ttl)),
    errors,
  }
  if (errors.length === 0) return ok(report)
  return err(
    csError(
      'CS_INTERNAL',
      `Released ${released.length} of ${expired.length} expired reservation(s); ${errors.length} failed.`,
      {
        released: released.length,
        failed: errors.length,
        firstFailure: errors[0]?.message ?? null,
      },
    ),
  )
}

/**
 * An `OpenReservation` promoted to a full handle.
 *
 * `budgetVersion: 0` and a placeholder `balance` because the sweeper's job is the release, and
 * `releaseIn` returns the authoritative balance. This keeps WP-12's `findStaleAttempts` from having to
 * join `budget_accounts` for two numbers it does not use.
 */
export function openReservationHandle(
  c: OpenReservation,
  ttlSeconds = RESERVATION_TTL_SECONDS,
): ReservationHandle {
  const zero: Money = { minor: 0n, currency: c.amount.currency }
  return {
    attemptId: c.attemptId,
    mandateId: c.mandateId,
    amount: c.amount,
    entryId: c.entryId,
    budgetVersion: 0,
    createdAtSec: c.reservedAtSec,
    expiresAtSec: c.reservedAtSec + ttlSeconds,
    balance: {
      mandateId: c.mandateId,
      currency: c.amount.currency,
      cap: zero,
      reserved: c.amount,
      spent: zero,
      available: zero,
      version: 0,
    },
  }
}

/** A one-line description for logs and the mandate's spend-ledger UI. */
export function describeReservation(h: ReservationHandle): string {
  return `${h.mandateId}/${h.attemptId} ${formatMoney(h.amount)} (v${h.budgetVersion}, expires ${h.expiresAtSec})`
}

/* Re-exported so a caller never has to reach into two modules for the vocabulary. */
export { RELEASE_REASONS, RESERVATION_TTL_SECONDS } from './types'
export type { ReleaseReason, ReservationHandle, ReservationStatus }
