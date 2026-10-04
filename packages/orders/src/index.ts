/**
 * `@countersign/orders` — spec **§8.11 (M11, WP-11)**, **D17**, **D18**, **D19**, §7.2, §10.2, §12.1.
 *
 * ## What this package is, in one paragraph
 *
 * The order orchestrator: the only place in the repository that turns a Gate `ALLOW` into a PayPal money
 * movement, and the only place that turns a PayPal money movement back into the buyer's ledger. It sits on
 * the **PayPal side** of §3.1's boundary — the Gate decides on the merchant side, so nothing here re-decides
 * whether a purchase is allowed; it only executes a decision that already exists, and it re-reads the two
 * facts that could have changed while the decision was in flight (the mandate's status, EC-MDT-2, and the
 * budget's balance).
 *
 * ## The five exported operations
 *
 * ```ts
 * createOrderFromDecision(d: GateDecision, deps): Promise<Result<OrderRow>>
 * captureShipment(orderId, shipment, deps):     Promise<Result<CaptureReport>>
 * voidRemainder(orderId, reason, deps):         Promise<Result<VoidReport>>
 * refund(captureId, amount, reason, actor, deps): Promise<Result<RefundReport>>
 * reauthorizeIfNeeded(authId, deps):            Promise<Result<ReauthorizeReport>>
 * ```
 *
 * All five take `deps: OrdersDeps` and return `Result` (AGENTS.md rule 3); none of them throws across the
 * boundary. Each has a `…Detailed` variant where the spec's return type is narrower than what an operator
 * or a test needs — see the note under each.
 *
 * ## The invariants this package exists to hold
 *
 * | # | Invariant | Where it is enforced | The test that proves it |
 * |---|---|---|---|
 * | 1 | `Σ captures == authorized` **exactly**, with no float | `capture.ts` → `allocate()` (largest-remainder over `bigint`) | `test/capture.test.ts` "AT-M11.1", plus the EC-FX-4 property test |
 * | 2 | `final_capture = (remaining == 0)`, forced only for EC-STOCK-1 | `capture.ts` → `allocateShipment` | `test/capture.test.ts` "EC-CAP-1/2" |
 * | 3 | An over-capture / over-refund is refused **before** any HTTP request | `capture.ts` (EC-CAP-3), `refund.ts` (EC-REF-2) + the guarded `UPDATE` in `repos/orders.ts` | `test/capture.test.ts` "AT-M11.4", `test/refund.test.ts` "AT-M11.4" |
 * | 4 | Budget hooks are asymmetric: commit / release / **nothing** / reverse-audit | `budget-hooks.ts` | `test/refund.test.ts` "a refund touches no ledger entry" |
 * | 5 | Every side-effecting call carries a deterministic `PayPal-Request-Id` | `@countersign/paypal`'s `idempotency.ts`, called with our derived ids | every request-body assertion in `test/` |
 * | 6 | A revoked mandate cannot produce an order, and leaks no reservation | `create.ts` (two reads, the second inside the insert transaction) | `test/create.test.ts` "EC-MDT-2" |
 * | 7 | `custom_id` is recomputable from the stored bundle by a third party | `create.ts` → `customIdForBundle` | `test/create.test.ts` "D18" |
 *
 * ## Files
 *
 * | File | Contents |
 * |---|---|
 * | `types.ts` | `OrdersDeps`, `OrderStore`, `BudgetHooks`, `Notifier`, and the vocabulary (§8.11's argument shapes). |
 * | `deps.ts` | the port→repository map, the budget-hook wiring, and the in-memory world. |
 * | `create.ts` | `createOrderFromDecision`, D18's hash, and the C2 inline/fallback decision. |
 * | `capture.ts` | `captureShipment`, the allocation, `final_capture`, EC-CAP-3/4/5, EC-SPLIT-1/2. |
 * | `tracking.ts` | `POST /v2/checkout/orders/{id}/track` and EC-CAP-4's "ship nothing while pending". |
 * | `void.ts` | `voidRemainder`, EC-STOCK-1's release, EC-MDT-3/4. |
 * | `refund.ts` | `refund`, EC-REF-1…5, EC-IDEM-5/6. |
 * | `reauthorize.ts` | `reauthorizeIfNeeded`, EC-TIME-5's two clocks. |
 * | `budget-hooks.ts` | the four §8.11 ledger sentences, and why three of them move money. |
 *
 * ## Testing without credentials
 *
 * Every test drives the **real** `PayPalClient` with an injected `fetchImpl` (`PayPalClientOpts.fetchImpl`
 * is the seam), so the request building, header assembly, retry loop, backoff and zod validation all run for
 * real. AGENTS.md rule 5 forbids faking PayPal's behaviour; what the tests replace is the socket, which is
 * the same seam `packages/paypal/test/fixtures/transport-double.ts` uses. Our own rows are backed by
 * `createInMemoryOrderWorld`, which models the unique indexes that *are* the idempotency defences and the
 * guarded `UPDATE` that is EC-REF-2's structural half.
 *
 * The live half of AT-M11 lives in `test/orchestrator.sandbox.test.ts` and is **skipped with a printed
 * reason** while `docs/HUMAN_TODO.md` H-01 is open. It never fails and never silently passes.
 */

// --- types and wiring ----------------------------------------------------------------------------
export {
  INTENT_RULE,
  REFUND_REASONS,
  defineOrderDeps,
  intentForLines,
  type Actor,
  type AttemptStateName,
  type AuthorizationPath,
  type AuthorizationStatus,
  type BudgetHookInput,
  type BudgetHookOutcome,
  type BudgetHooks,
  type BudgetReleaseInput,
  type CapturePath,
  type CaptureReport,
  type CaptureStatus,
  type CreateOrderReport,
  type DraftCartLine,
  type Notifier,
  type OrderDraft,
  type OrderNotification,
  type OrderPayPal,
  type OrdersDeps,
  type OrderStore,
  type OrderTx,
  type RefundInitiatedBy,
  type RefundReason,
  type RefundReport,
  type RefundStatus,
  type ReauthorizeOutcome,
  type ReauthorizeReport,
  type ShipmentInput,
  type ShipmentStatus,
  type VoidReason,
  type VoidReport,
} from './types'

export {
  budgetHooksFromStore,
  createInMemoryOrderWorld,
  deterministicIds,
  nullNotifier,
  orderStoreFromRepos,
  recordingNotifier,
  toJsonValue,
  withTxOrAbort,
  type InMemoryOrderWorld,
  type InMemoryOrderWorldSeed,
  type OrderRepoHandles,
  type RecordingNotifier,
} from './deps'

// --- the five operations -------------------------------------------------------------------------
export {
  EVIDENCE_BUNDLE_EXCLUDED_MEMBERS,
  EVIDENCE_BUNDLE_HASHED_MEMBERS,
  abortVoidRequestId,
  createOrderFromDecision,
  createOrderFromDecisionDetailed,
  createOrderRequestFor,
  customIdForBundle,
  evidenceBundleCore,
  evidenceCustomId,
  evidenceCustomIdResult,
  orderAuthorizeRequestId,
  orderCaptureRequestId,
  purchaseUnitFor,
  type EvidenceBundleCore,
} from './create'

export {
  allocateShipment,
  captureShipment,
  linesOf,
  moneyHolds,
  shippingShares,
  type PricedLine,
  type ShipmentAllocation,
} from './capture'

export {
  linkTracking,
  trackerIdFrom,
  trackingRequestId,
  type TrackingInput,
  type TrackingReport,
} from './tracking'

export { voidRemainder, voidRequestId } from './void'

export {
  PENDING_REFUND_PREFIX,
  REFUND_RETRY_DELAY_SECONDS,
  refund,
  refundableMinor,
  refundRequestIdFor,
  retryFailedRefund,
  type RefundAmount,
  type RefundInput,
} from './refund'

export { honourWindowOpen, reauthorizeIfNeeded, reauthorizeRequestId } from './reauthorize'

// --- the budget hooks ----------------------------------------------------------------------------
export {
  applyCaptureOutcome,
  attemptStateFor,
  capturedMinorForAuthorization,
  notifyDecline,
  notifyPending,
  notifyReleased,
  notifySettled,
  outcomeFor,
  remainingAuthorized,
  type CaptureOutcome,
  type CaptureOutcomeInput,
  type CaptureOutcomeReport,
} from './budget-hooks'
