/**
 * `@countersign/webhooks` — spec **§8.12 (M12, WP-12)**, **§12.3**, decisions **D12**, **D13**.
 *
 * ## The one doctrine
 *
 * > We never trust payload state. State comes from re-fetching PayPal, never from the body it sent us.
 * > — spec §8.12, §3.1
 *
 * Webhooks get lost, duplicated and reordered [V14], so a payload is a **hint about what to re-fetch** and
 * nothing more. Every status written anywhere in this package came out of a `GET`. §3.1 puts the reconciler
 * in the architecture for exactly this reason, and it is not decoration: a subscription to an event PayPal
 * does not have (`PAYMENT.REFUND.COMPLETED`) or does not have for a resource we care about
 * (`PAYMENT.AUTHORIZATION.EXPIRED`) **silently never fires**, and nothing else would ever notice.
 *
 * ## The surface, and who calls what
 *
 * | Export | Caller |
 * |---|---|
 * | {@link handleWebhook} | WP-17's `app/api/webhooks/paypal/route.ts` — a three-line adapter over a `Request` |
 * | {@link processWebhookEvent} | `apps/worker`'s `wh.process` handler, and Judge Mode |
 * | {@link ingestDispute} | **WP-15e** (Defender / evidence filer) |
 * | {@link retryPendingVerifications} / {@link verifyStored} | `wh.verify` — EC-WH-7 |
| {@link reconcileResources} / {@link reconcileDisputes} / {@link authorizationExpirySweep} / {@link reprocessUnstoredWork} | `apps/worker`'s crons |
 * | {@link compareRankedState} and the rank tables | anything that needs §8.12's ordering decision |
 * | {@link defineWebhookDeps} | `apps/worker`, so a hole in the dependency list is a `tsc` error |
 *
 * ## Files
 *
 * | File | Contents |
 * |---|---|
 * | `types.ts` | `WebhookDeps` and its ports: PayPal reads, the store, the queue, the audit sink, the throttle. |
 * | `status-rank.ts` | **The correctness core.** Pure rank tables and one comparator; no I/O, no clock. |
 * | `signature.ts` | Header extraction, the three verification outcomes, EC-WH-4's audit and alert, and the byte-exact storage EC-WH-7's retry needs. |
 * | `dedupe.ts` | EC-WH-2's `ON CONFLICT DO NOTHING` and the pure decision about what a redelivery does. |
 * | `ingest.ts` | {@link handleWebhook}: store → verify → enqueue → ack. Framework-agnostic. |
 * | `jobs.ts` | `wh.process`: the four gates, and one re-fetch per resource kind. |
 * | `reconcile.ts` | The sweeps, EC-PP-2's throttle, and **EC-TIME-5's authorization expiry sweep**. |
 *
 * ## Testing without credentials or a database
 *
 * Every test drives the **real** `PayPalClient` through an injected `fetchImpl`, so the request building,
 * the retry loop, the backoff, the circuit breaker and the zod validation all run for real (AGENTS.md rule 5
 * forbids faking PayPal's *behaviour*; replacing the socket is the same seam
 * `packages/paypal/test/fixtures/transport-double.ts` uses). Our own rows are backed by an in-memory
 * `WebhookStore` in `test/harness.test.ts`, which models the three things AT-M12.3 needs to be a real test —
 * see that file's header.
 */

// --- types and wiring ----------------------------------------------------------------------------
export {
  JOB_AUTH_EXPIRY,
  JOB_BUDGET_RECONCILE,
  JOB_DISPUTES,
  JOB_PROCESS,
  JOB_RECONCILE,
  JOB_RELEASE_RESERVATIONS,
  JOB_VERIFY,
  defineWebhookDeps,
  type AckOutcome,
  type AggregateStore,
  type EnqueueOptions,
  type JobHandler,
  type JobName,
  type ProcessEventJob,
  type RankedWrite,
  type ReconcilerOptions,
  type StoredEvent,
  type Throttle,
  type UpsertDisputeInput,
  type VerifyEventJob,
  type WebhookAck,
  type WebhookAudit,
  type WebhookDeps,
  type WebhookEventStore,
  type WebhookPayPal,
  type WebhookQueue,
  type WebhookStore,
  type WorkOptions,
} from './types'

// --- the correctness core ------------------------------------------------------------------------
export {
  AUTHORIZATION_RANK,
  CAPTURE_RANK,
  DISPUTE_STAGE_RANK,
  DISPUTE_STATUS_RANK,
  ORDER_RANK,
  REFUND_RANK,
  RESOURCE_KINDS,
  TERMINAL_STATUSES,
  compareRankedState,
  compareRanks,
  disputeStageOf,
  hookOwed,
  isTerminalStatus,
  parseUpdateTime,
  rankAuthorization,
  rankCapture,
  rankDispute,
  rankOrder,
  rankRefund,
  statusRankTable,
  type RankComparison,
  type RankVerdict,
  type RankedState,
  type ResourceKind,
} from './status-rank'

// --- signature and EC-WH-4 -----------------------------------------------------------------------
export {
  DEFAULT_VERIFY_TIMEOUT_MS,
  FORGED_ALERT_THRESHOLD_PER_HOUR,
  REQUIRED_SIGNATURE_HEADERS,
  VERIFICATION_RETRY_BASE_SECONDS,
  VERIFICATION_RETRY_MAX_SECONDS,
  WEBHOOK_AUDIT_CHAIN,
  auditForgedDelivery,
  decodeStoredRaw,
  encodeStoredRaw,
  readSignatureHeaders,
  shouldAlertForForged,
  storedEventBody,
  storedHeaders,
  storedRawBytes,
  verificationRetryAfterSeconds,
  verifyDelivery,
  type HeaderBag,
  type SignatureHeaderName,
  type StoredDelivery,
  type VerificationOutcome,
  type VerifyOptions,
} from './signature'

// --- dedupe --------------------------------------------------------------------------------------
export { dedupeDecision, processJobFor, type DedupeDecision } from './dedupe'

// --- ingest --------------------------------------------------------------------------------------
export {
  ACK_BUDGET_MS,
  handleWebhook,
  parseWebhookEvent,
  type ParseOutcome,
  type ParsedWebhookEvent,
} from './ingest'

// --- wh.process ----------------------------------------------------------------------------------
export {
  MAX_PROCESS_ATTEMPTS,
  captureHookOutcome,
  ingestDispute,
  kindFor,
  orderStatusFor,
  processWebhookEvent,
  reconcileOne,
  retryPendingVerifications,
  verifyStored,
  type CaptureOutcomeHooks,
  type CaptureHookOutcome,
  type ProcessOutcome,
  type ProcessResult,
  type ReconcileOutcome,
} from './jobs'

// --- the reconciler ------------------------------------------------------------------------------
export {
  AUTHORIZATION_HONOUR_DAYS,
  AUTHORIZATION_VALIDITY_DAYS,
  DEFAULT_DISPUTE_OVERLAP_SECONDS,
  DEFAULT_LOOKBACK_DAYS,
  DEFAULT_RECONCILE_RPS,
  DEFAULT_SWEEP_BATCH,
  EXPIRY_SWEEP_HORIZON_DAYS,
  authorizationExpirySweep,
  createThrottle,
  defaultThrottle,
  reconcileDisputes,
  reconcileResources,
  reprocessUnstoredWork,
  type ReconcileOptions,
  type SweepReport,
} from './reconcile'
