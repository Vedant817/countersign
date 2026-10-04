/**
 * `@countersign/ledger` types — spec **D19**, **§8.10 checks 8, 9 and 11**, §5 (`packages/ledger/
 * # budget reservations`), §12.
 *
 * ## Why this package exists at all
 *
 * The reference Verifiable Intent library lists `budget`, `recurrence` and `agent_recurrence` as
 * *network-enforced* and **does not evaluate them** ([B3], spec **D19**). Countersign therefore has
 * to be the network: a cumulative ledger with row locks, owned by us, running inside the merchant's
 * trust boundary on the buyer-facing side of the PayPal wall.
 *
 * Two layers, and the split is deliberate:
 *
 * | Layer | Owner | Job |
 * |---|---|---|
 * | SQL statements + the `FOR UPDATE` lock | `packages/db/repos/budget.ts` (WP-02) | `SELECT … FOR UPDATE`, the cap arithmetic, the append-only entry insert |
 * | **this package** | `packages/ledger` | the *semantics* the Gate and the orchestrator need: a reservation with a lifetime, deterministic entry identity so a retry cannot double-write, and the recurrence-window arithmetic that check 11 has to apply |
 *
 * So this package owns **no SQL of its own** and defines **no second budget port**. It consumes the
 * `BudgetStore` that `packages/db` already exports and calls `reserveIn` / `releaseIn` /
 * `commitIn` / `walletCapCheckIn` — the same functions, with the same guarantees — through it.
 * Re-implementing the read-modify-write here is the one thing this file exists to make impossible:
 * a second `reserved += amount` without the lock is precisely the bug D19 warns about.
 */

import type { AttemptId, CsError, Currency, MandateId, Money, Result } from '@countersign/core'
import type { BudgetBalance, BudgetStore, WalletCapPeriod } from '@countersign/db'

export type { BudgetBalance, BudgetStore, WalletCapPeriod }

/** `budget_entries.kind`, re-declared here so this file needs one import for the vocabulary. */
export type LedgerEntryKind = 'RESERVE' | 'RELEASE' | 'COMMIT' | 'REVERSE'

/**
 * How long a reservation survives without an order. Spec §8.10: "Reservations expire after 30 min
 * without an order (a worker job releases them)."
 *
 * This is the window in which a buyer's signed authority is claimed but nothing has been spent. If a
 * reservation were never released, an agent that got as far as `GATED_ALLOW` and then went away
 * would hold the buyer's whole budget hostage until the mandate expired — which is a denial of the
 * user's own money, not a safety property.
 *
 * The cron that actually sweeps is WP-12. {@link expireStaleReservations} is the primitive it calls.
 */
export const RESERVATION_TTL_SECONDS = 30 * 60

/** Why a reservation was given back. Recorded verbatim in `budget_entries.reason`. */
export const RELEASE_REASONS = {
  /** The Gate decided BLOCK after check 8 reserved (AT-M10.4). */
  gateBlocked: 'GATE_BLOCKED',
  /** Stock ran out between check 10 and the order. EC-STOCK-3. */
  outOfStock: 'OUT_OF_STOCK',
  /** The mandate was revoked or suspended while the attempt was in flight. EC-MDT-2. */
  revoked: 'REVOKED',
  /** The buyer cancelled. */
  cancelled: 'CANCELLED',
  /** The mandate or the price lock expired. */
  expired: 'EXPIRED',
  /** The 30-minute sweep found no order. Spec §8.10. */
  noOrder: 'NO_ORDER',
  /** A human said so. */
  manual: 'MANUAL',
} as const
export type ReleaseReason = (typeof RELEASE_REASONS)[keyof typeof RELEASE_REASONS]

/** What a reservation is doing right now. Derived, never stored — see {@link reservationStatus}. */
export type ReservationStatus = 'HELD' | 'RELEASED' | 'COMMITTED' | 'EXPIRED'

/**
 * A claim on a buyer's budget, in memory.
 *
 * Deliberately **not** a table. `budget_entries` is the durable record and `budget_accounts` is its
 * cache; this is the handle the Gate carries between check 8 and the orchestrator so that a later
 * failure has something specific to release, and so that the exact `budget_version` a decision was
 * approved against travels with the decision (§7.2 `gate_decisions.budget_version`).
 */
export interface ReservationHandle {
  readonly attemptId: AttemptId
  readonly mandateId: MandateId
  readonly amount: Money
  /** `budget_entries.id` — deterministic, so a retry hits the primary key instead of writing twice. */
  readonly entryId: string
  /** The `budget_accounts.version` this reservation was approved against. */
  readonly budgetVersion: number
  /** Epoch seconds (AGENTS.md rule 10: epoch seconds, UTC). */
  readonly createdAtSec: number
  /** `createdAtSec + RESERVATION_TTL_SECONDS`. */
  readonly expiresAtSec: number
  readonly balance: BudgetBalance
}

/** What {@link expireStaleReservations} did, one line per reservation it touched. */
export interface ReservationExpiryReport {
  readonly expired: readonly ExpiredReservation[]
  readonly stillHeld: readonly ReservationHandle[]
}

export interface ExpiredReservation {
  readonly handle: ReservationHandle
  readonly released: BudgetBalance
}

/** One open reservation handed to the sweep by whoever found it (WP-12's `findStaleAttempts`). */
export interface OpenReservation {
  readonly attemptId: AttemptId
  readonly mandateId: MandateId
  readonly amount: Money
  readonly reservedAtSec: number
  readonly entryId: string
}

/* ------------------------------------------------------------------------------------------ */
/* The recurrence window — check 11                                                                 */
/* ------------------------------------------------------------------------------------------ */

/**
 * The VI frequency enum, verbatim from `verifiable_intent/models/constraints.py` at the pinned
 * commit (§8.8 "Exact field names"). Not an ISO-8601 duration and not our own invention — a
 * renamed value would silently widen or narrow a window the user signed.
 */
export const VI_FREQUENCIES = [
  'INDA',
  'DAIL',
  'WEEK',
  'TWOK',
  'TWMN',
  'MNTH',
  'TOMN',
  'QUTR',
  'FOMN',
  'SEMI',
  'YEAR',
  'TYEA',
] as const
export type ViFrequency = (typeof VI_FREQUENCIES)[number]

/**
 * `frequency` → the length of one occurrence, in seconds.
 *
 * Calendar frequencies use the shortest month (28 days) and the shortest year (365 days) on
 * purpose. A rolling window that assumed 31 days would *under*-count near a month end and could
 * allow one occurrence too many; a window is a limit, so erring towards the shorter period fails
 * closed. §12 has no rounding rule for this, and failing closed is the only safe default for a
 * constraint a human signed.
 *
 * `null` for the indefinite frequencies (`INDA`, `TWOK`, `TWMN`): there is no period to measure, so
 * check 11 has no window to enforce and says so rather than inventing one.
 */
export const FREQUENCY_SECONDS: Readonly<Record<ViFrequency, number | null>> = Object.freeze({
  INDA: null, // indefinite
  DAIL: 86_400,
  WEEK: 7 * 86_400,
  TWOK: null, // twice a week — not expressible as one window
  TWMN: null, // three times a month — idem
  MNTH: 28 * 86_400,
  TOMN: 28 * 86_400,
  QUTR: 28 * 86_400, // three occurrences per quarter ≈ one per month
  FOMN: 7 * 86_400, // four per month ≈ weekly
  SEMI: 14 * 86_400, // twice a month
  YEAR: 365 * 86_400,
  TYEA: 365 * 86_400,
})

/** `mandate.payment.recurrence` — §8.8's field names exactly. */
export interface RecurrenceConstraint {
  readonly type: 'mandate.payment.recurrence'
  readonly frequency: ViFrequency
  readonly start_date: string
  readonly end_date?: string | null
  readonly number?: number | null
}

/** `mandate.payment.agent_recurrence` — `end_date` is required by the library, so it is here. */
export interface AgentRecurrenceConstraint {
  readonly type: 'mandate.payment.agent_recurrence'
  readonly frequency: ViFrequency
  readonly start_date: string
  readonly end_date: string
  readonly max_occurrences?: number | null
}

export type NetworkEnforcedConstraint =
  | { type: 'mandate.payment.budget'; currency: Currency; max: number; min?: number | null }
  | RecurrenceConstraint
  | AgentRecurrenceConstraint

/**
 * The verdict check 11 needs: how many occurrences are already committed in the window, and whether
 * one more is allowed.
 *
 * `windowSeconds: null` means the frequency has no measurable window (`TWOK`, `TWMN`, `INDA`). The
 * Gate then reports the check as **not applicable** rather than as passed — "passed" would claim an
 * enforcement that did not happen, which is the same class of lie as reading `constraints.satisfied`
 * as covering a network-enforced constraint (D19).
 */
export interface RecurrenceVerdict {
  readonly constraintType: 'mandate.payment.recurrence' | 'mandate.payment.agent_recurrence'
  readonly frequency: ViFrequency
  readonly windowSeconds: number | null
  readonly windowStartSec: number
  /** Occurrences (COMMITs) already inside the window. */
  readonly used: number
  /** `null` when the user signed no numeric limit — the date window is the whole limit. */
  readonly limit: number | null
  readonly allowed: boolean
  /** Epoch seconds of the first date outside `[start_date, end_date]`, when a bound is present. */
  readonly outsideDateWindow: 'BEFORE_START' | 'AFTER_END' | null
}

/**
 * Count of committed occurrences inside a window.
 *
 * Not part of `BudgetStore`: the store exposes `sumEntriesByKind` for the whole history, and check
 * 11 needs a *time-bounded* count. `packages/db/repos/budget.ts::countCommitsSince` is the Drizzle
 * implementation of this port; {@link memoryCommitCounter} is the in-memory one the tests use, and
 * it is the same shape so neither can drift.
 */
export interface CommitCounter {
  /** COMMIT entries for `mandateId` with `at >= since`, oldest irrelevant — only the count matters. */
  countCommitsSince(mandateId: MandateId, since: Date): Promise<Result<number, CsError>>
}
