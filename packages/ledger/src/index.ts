/**
 * `@countersign/ledger` — spec **§5** (`packages/ledger/  # budget reservations`), **D19**, **§8.10
 * checks 8, 9 and 11**, §7.2.
 *
 * ## What this package owns, in one paragraph
 *
 * Spec **D19**: the reference Verifiable Intent library lists `budget`, `recurrence` and
 * `agent_recurrence` as *network-enforced* and **does not evaluate them** ([B3]). Whoever plays the
 * network role has to enforce them. That is this package: the cumulative, row-locked budget ledger
 * behind Gate checks 8, 9 and 11, plus the reservation lifetime that stops a buyer's own money being
 * held hostage by an attempt that went nowhere.
 *
 * ## What this package does **not** own, and why that matters
 *
 * - **No SQL.** `SELECT … FOR UPDATE` lives in `packages/db/repos/budget.ts` (WP-02). This package
 *   consumes the `BudgetStore` port that file exports and calls `reserveIn` / `releaseIn` /
 *   `walletCapCheckIn` through it. A second `reserved += amount` anywhere is the bug this project
 *   names as its one budget hazard, so the arithmetic and the lock are imported, never re-derived.
 * - **No second budget port.** {@link BudgetStore} is re-exported from `@countersign/db`, not
 *   redefined. The Gate's tests inject a `BudgetStore`, and the app injects `drizzleStore(exec)`.
 * - **No clock, no network, no LLM.** Every function takes `nowSec` as a number so §12.5 **EC-TIME-4**
 *   can hold: one `clock.nowSec()`, captured once, used by every expiry comparison in a decision.
 *
 * See `README.md` for the 30-minute sweep, the recurrence arithmetic, and why `FOR UPDATE` cannot be
 * forgotten.
 */

// --- types -------------------------------------------------------------------------------
export {
  FREQUENCY_SECONDS,
  RELEASE_REASONS,
  RESERVATION_TTL_SECONDS,
  VI_FREQUENCIES,
  type AgentRecurrenceConstraint,
  type BudgetBalance,
  type BudgetStore,
  type CommitCounter,
  type ExpiredReservation,
  type LedgerEntryKind,
  type NetworkEnforcedConstraint,
  type OpenReservation,
  type RecurrenceConstraint,
  type RecurrenceVerdict,
  type ReleaseReason,
  type ReservationExpiryReport,
  type ReservationHandle,
  type ReservationStatus,
  type ViFrequency,
  type WalletCapPeriod,
} from './types'

// --- reservation lifecycle ----------------------------------------------------------------
export {
  describeReservation,
  expireStaleReservations,
  ledgerEntryId,
  openReservationHandle,
  partitionExpired,
  releaseEntryId,
  releaseReservation,
  reservationEntryId,
  reservationHasExpired,
  reservationStatus,
  reserveForAttempt,
  type ExpireStaleInput,
  type ExpireStaleReport,
  type LedgerEntryScope,
  type ReleaseReservationResult,
  type ReserveForAttemptInput,
} from './reservation'

// --- ledger: invariant, drift, recurrence ------------------------------------------------
export {
  WALLET_PERIOD_SECONDS,
  balancesFromEntries,
  commitsInRecurrenceWindow,
  emptyTotals,
  evaluateRecurrence,
  isoDateToEpochSec,
  ledgerInvariant,
  memoryCommitCounter,
  readRecurrenceConstraints,
  reconcileLedger,
  summariseBalance,
  walletPeriodStart,
  zeroMoney,
  type RecurrenceInput,
} from './ledger'
