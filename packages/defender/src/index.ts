/**
 * `@countersign/defender` — spec **§8.15 (M15)**, **§8.16**, **§12.10**, **§12.11**, work packages
 * **WP-15a** and **WP-15b**.
 *
 * ## The two functions in this package, and the line between them
 *
 * ```ts
 * const decision = route(context)          // WP-15a - pure, deterministic, no model
 * const plan = planEvidence(context, decision)  // WP-15b - pure, deterministic, no model
 * ```
 *
 * `route()` decides **whether to contest**. `planEvidence()` decides **what to attach if we are contesting**.
 * WP-15c's drafter writes the prose; the strategist (WP-16) proposes the next action. Only the last two are
 * allowed a model, and neither can change a posture.
 *
 * ## Why this separation is the product's honesty claim
 *
 * Spec **§18 question 20** — "what stops the AI from filing a bogus dispute against a good customer?" — is
 * answered by the *absence* of a model in the first function, not by a prompt:
 *
 * | Question | Answered by | Where |
 * |---|---|---|
 * | May we contest at all? | A rule table, first match wins | {@link route} |
 * | Must we never contest without a mandate? | `R-NOCHAIN-1` / `R-CHAIN-BAD`, both non-contesting by construction | `rules.ts` |
 * | What may we claim? | `evidenceSourceAvailable` — is the document actually there? | `rules.ts` |
 * | Can we defend what we say? | Deterministic notes with a citable fact per claim | {@link planEvidence} |
 * | What does the human see? | `rationale`, `reasons`, `facts` — composed, never generated | `rationale.ts` |
 *
 * A `CONTEST` is unreachable without a verified chain **and** at least one evidence type whose source
 * exists. That is a property of the code, asserted as a property over generated contexts in
 * `test/router.test.ts`, not a hope about a prompt.
 *
 * ## Nothing here touches the outside world
 *
 * No LLM, no clock, no database, no network, no `Date.now()`, no randomness. `nowSec` is an input. That is
 * what makes the 40-case eval (`pnpm --filter @countersign/defender eval`) a real measurement: same input,
 * same decision, byte for byte, with no key and no credentials.
 *
 * ## WP-15c and WP-16 build on this surface
 *
 * - `decision.facts` is the entire citation vocabulary a drafted note may use.
 * - `decision.rationale` is the sentence a buyer reads in S-18 and a judge reads in the packet.
 * - `planEvidence(...).items` is PayPal's `evidences[]`, already inside every documented limit.
 * - `toProvideEvidenceInput(plan)` is the exact body `PayPalClient.provideEvidence` takes.
 */

// --- the router ------------------------------------------------------------------------------------
export { PREDICATE_FOR, deadlineState, route } from './router'

// --- the evidence planner ---------------------------------------------------------------------------
export {
  EVIDENCE_BY_REASON,
  clampNotes,
  evidenceInfoFor,
  packetNote,
  planEvidence,
  shipmentShares,
  toProvideEvidenceInput,
  validateEvidencePlan,
} from './planner'

// --- rationale ----------------------------------------------------------------------------------------
export {
  COMPROMISED_DEVICE_ALERT,
  NO_MANDATE_LINE,
  composeRationale,
  deadlineSentence,
  factsFor,
  reasonsFor,
  ruleSentence,
} from './rationale'

export type { ComposedRationale } from './rationale'

// --- the rules table ------------------------------------------------------------------------------
export {
  ATTRIBUTE_KEYS,
  DEADLINE_CRITICAL_SECONDS,
  DEADLINE_PRESSURE_SECONDS,
  EVIDENCE_BY_RULE,
  READBACK_LABELS,
  REASON_WORDS,
  RULE_ORDER,
  RULE_ORIGIN,
  UNASSIGNED_REASONS,
  agentAuthorityExceeded,
  allCaptureIds,
  attributeConflicts,
  autoAccepts,
  capturedTotal,
  chainInvalid,
  chainVerifiedNow,
  completedRefunds,
  disputedSkus,
  duplicateShipmentCaptures,
  evidenceFor,
  evidenceSourceAvailable,
  hasPaypalTracker,
  hasRefundProof,
  hasTracking,
  hasVerifiedMandate,
  inTransit,
  isTracked,
  lineKey,
  missingEvidence,
  readbackAttribute,
  reasonPhrase,
  refundedTotal,
  ruleAlreadyRefunded,
  ruleAmountCorrect,
  ruleAmountDuplicate,
  ruleAppealable,
  ruleChainBad,
  ruleCreditNotProcessedRefunded,
  ruleDeadlineForcesRefund,
  ruleInrInTransit,
  ruleInrTracked,
  ruleInrUntracked,
  ruleNoChain,
  ruleOtherReasonRefund,
  ruleSnadAgentFault,
  ruleInquiryStage,
  ruleSnadAuthorised,
  ruleSnadMerchantFault,
  ruleSnadThinQuality,
  ruleUnauthorisedAuthorised,
  ruleUnauthorisedLostDevice,
  ruleUnauthorisedWeak,
  shipmentLinesMatchCheckout,
  shipmentsCoveringDispute,
  trackedShipments,
  weakCaseAutoAccepts,
} from './rules'
export type { AttributeConflict, AttributeKey } from './rules'

// --- types ----------------------------------------------------------------------------------------
export { NOTES_MAX_CHARS, RULE_ALIASES } from './types'
export type {
  CaptureFacts,
  ChainFacts,
  DeadlineState,
  DeadlineState_,
  DisputeActionName,
  DisputeContext,
  DisputeFacts,
  EvidenceCorpus,
  EvidencePlan,
  EvidencePlanItem,
  EvidenceType,
  ItemAttributes,
  Liability,
  LiabilityDecision,
  LineFact,
  MerchantPolicy,
  OrderFacts,
  PlannedDocument,
  Posture,
  RefundFacts,
  RouterFact,
  RouterPreferences,
  RuleId,
  RuleOrigin,
  ShipmentFacts,
  SpecRuleId,
} from './types'

// --- WP-15e: the filer and ingest (signature list in README-FILER.md) -------------------------------------
export { fileDispute, narrowPlanToPermit, uploadPermitFor, withCheckedNotes } from './filer'
export { buildDisputeContext, ingestDisputeToDefender, joinDisputeToOrder } from './ingest'

// --- WP-16: the Strategist -----------------------------------------------------------------------------------
export { proposeStrategy, proposeStrategyDeterministic } from './strategist'
export { executeStrategy } from './strategist-actions'
