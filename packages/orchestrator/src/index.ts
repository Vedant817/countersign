/**
 * `@countersign/orchestrator` — spec **§10.2**, **§8.8**, **§8.10**, **§8.11**, **§8.12**, **§8.15**,
 * core invariant **I-1** (§3.1), §12.2, §12.4, §12.11.
 *
 * ## What this package is
 *
 * **The seam.** Every package beneath it is correct and none of them calls the next: `packages/gate`
 * decides and returns a decision, `packages/orders` creates a PayPal order for an `ALLOW`, `packages/
 * defender` files a dispute, `packages/ledger` knows when a reservation expires. Each is heavily tested.
 * Before this package, no line of code anywhere in the repository asked any of them to run.
 *
 * So this is not a new implementation of anything. It is the **order** — four exported functions, each one
 * a sequence of already-tested calls, and each one stopping at the first failure.
 *
 * ## The exported surface
 *
 * | Export | Sequence it composes | §  |
 * |---|---|---|
 * | {@link createOrderFromIntent} | `compile` → `readBack` → `evaluate` → `createGateDecision`+`linkGateDecision` → **only if `ALLOW`** `createOrderFromDecisionDetailed` | §8.8, §8.10, §8.11 |
 * | {@link runGateEvaluation} | `findLatestDecisionForAttempt` → **else** `evaluate` → `createGateDecision`+`linkGateDecision` | §8.10 |
 * | {@link ingestAndDefend} | `getDispute` → `ingestDisputeToDefender` → `fileDispute` | §8.12, §8.15, §10.2 rows 13–16 |
 * | {@link releaseExpiredReservations} | `findStaleAttempts` → already-released filter → `expireStaleReservations` → `setAttemptState` | §8.10, §7.2 |
 *
 * ## I-1, and where it is proved
 *
 * §3.1 I-1: *no PayPal money movement happens unless a Gate `ALLOW` decision record exists for exactly that
 * order, amount, currency and payee.* Two independent guards, and the tests assert both:
 *
 * 1. `deps.orders.paypal.createOrder` is reachable from **one line** of `purchase.ts`, inside
 *    `if (decision.decision !== 'ALLOW') return …`.
 * 2. `packages/orders`' `createOrderFromDecision` refuses a non-`ALLOW` with `GATE_BLOCKED` before it
 *    touches anything.
 *
 * A second guard matters because this package is not the only possible caller: a future caller who reaches
 * `createOrderFromDecision` directly still cannot move money without an `ALLOW`.
 *
 * ## The properties that survive a retry
 *
 * | Property | Mechanism |
 * |---|---|
 * | A duplicate submission performs one PayPal call | `decisionForAttempt` recovers the recorded decision; `evaluate` (a replay **detector**, not an idempotent replay) is not re-run; `createOrderFromDecision` finds the order and returns it |
 * | A crash between the decision and the order resumes | the decision row is persisted first, so the retry re-enters `createOrderFromDecision` with the same `cs:{attemptId}:create` request id and PayPal collapses it onto the order it already made |
 * | A sweep run twice releases once | the derived `releaseEntryId` primary key, plus a filter that reports an already-released reservation instead of writing |
 * | A retried dispute ingest does not double-file | `ingestDisputeToDefender` upserts under a derived `dsp_…` id and `fileDispute` records `dispute_actions` under a derived idempotency key |
 *
 * ## What is *not* here, and is reported instead of worked around
 *
 * **`DefenderRefunds` cannot be satisfied without breaking a guarantee.** `fileDispute` reaches a `REFUND`
 * posture through a `DefenderRefunds` port, and its own documentation says to wire it to
 * `orders.refund(...)`. `orders.refund()` refuses while a dispute is open on the capture (EC-REF-4's
 * detection), so the `REFUND` posture is refused by construction. That is a real defect in the composition
 * and it is **not** worked around here: a workaround would either refund outside the over-refund guard or
 * refund twice, and QA-orders-2 is exactly that second outcome. See the README.
 *
 * **`pendingNetworkEnforcement` is not recoverable** from a stored decision (there is no column), so
 * {@link gateDecisionFromRow} reconstructs it as `[]`. Safe for the one caller, because
 * `createOrderFromDecision` never reads the field; recorded so it cannot be inherited silently.
 */
export type { CompiledMandate, CompileInput, ReadBackContext } from '@countersign/compiler'
export type { BudgetEntryRow, CheckoutAttemptRow, GateDecisionRow } from '@countersign/db'
export type { GateDecision, GateDeps, GateInput } from '@countersign/gate'
export type { BudgetStore } from '@countersign/ledger'
export type { OrdersDeps } from '@countersign/orders'
export type { CsError, Clock, Logger, Result } from '@countersign/core'

// --- the four compositions ----------------------------------------------------------------------
export { createOrderFromIntent, gateDecisionFromRow, runGateEvaluation } from './purchase'
export {
  ingestAndDefend,
  type DisputePayPal,
  type DisputeSource,
  type IngestAndDefendDeps,
} from './dispute'
export { releaseExpiredReservations, RESERVATION_TTL_SECONDS } from './reservations'

// --- the ports -----------------------------------------------------------------------------------
export {
  compilerFrom,
  type DefenderSeam,
  type DefendOutcome,
  type FileDeps,
  type FileOptions,
  type FileOutcome,
  type GateEvaluation,
  type IntentCompiler,
  type OrchestratorDeps,
  type OrchestratorStore,
  type OrderFromIntent,
  type PurchaseIntent,
  type PurchaseStage,
  type ReleasedReservation,
  type ReservationReleaseReport,
} from './types'
