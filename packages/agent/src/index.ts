/**
 * `@countersign/agent` — spec **§8.13 (M13)**, WP-13. The shopping agent, and the four things that
 * stop it spending money it was not given.
 *
 * ## The four defences, and where each one lives
 *
 * | # | §8.13 says | In this package |
 * |---|---|---|
 * | 1 | Listings are wrapped as untrusted text and the prompt says to treat them as data | `fence.ts` — a delimiter that strips its own markers from the content, plus a deterministic flag table |
 * | 2 | The agent cannot change the mandate; no tool exists for that | `types.ts`'s `MandatePort` has exactly one method and it is a read |
 * | 3 | `sign_l3` pre-checks constraints | `tools.ts`'s `signL3` op — vi `/v1/l3/create` refuses an out-of-mandate cart |
 * | 4 | The Gate re-checks everything | `tools.ts`'s `submitCheckout` op — the merchant's Gate is the authority, and its `BLOCK` is reported verbatim |
 * | 5 | An advisory classifier flags suspected injection | `ShopDeps.classifyInjection` — additive only; it can raise a flag and never clear one |
 *
 * ## What the agent is allowed to be
 *
 * Wrong, confidently, and at length. Every authority in a run is a **tool result**: the signer's answer
 * and the Gate's answer. A model that has been argued out of its instructions can produce L3s, carts and
 * prose; it cannot produce a signature it does not have or a Gate verdict it does not like. The tests
 * that matter here (`test/agent.test.ts`, `test/scripted.test.ts`) drive the loop with a model that
 * *cooperates with the injection*, and assert the merchant is never told to capture.
 *
 * ## Running it
 *
 * ```ts
 * for await (const event of runShoppingAgent(request, deps)) {
 *   // S-10 renders these; the refusal measurement scores them.
 * }
 * ```
 *
 * `runScriptedShopper` walks the same tool surface deterministically, which is what makes the published
 * refusal rate reproducible without a provider key. See `refusal.ts`.
 *
 * See `README.md` for the tool table, the corpus commands and the AT-M13 acceptance map.
 */

// --- the agent loop ---------------------------------------------------------------------------
export {
  runShoppingAgent,
  MAX_AGENT_STEPS,
  SHOPPING_AGENT_SYSTEM_PROMPT,
  errorEventData,
  UNUSABLE_REQUEST,
} from './agent'

// --- the scripted shopper ----------------------------------------------------------------------
export { runScriptedShopper, chooseCandidate, contentWords, fabricateL3 } from './scripted'
export type { ScriptedBehaviour, ScriptedOptions } from './scripted'

// --- the tools and the merchant-MCP surface -----------------------------------------------------
export {
  AGENT_TOOL_NAMES,
  LOCAL_TOOL_NAMES,
  MERCHANT_TOOL_NAMES,
  UNTRUSTED_NOTE,
  buildAgentTools,
  createAgentOps,
  decodeToolResult,
  mandateToOutput,
  parseMinor,
  toGateOutcome,
} from './tools'
export type {
  AgentOps,
  CreateCheckoutOutput,
  GetProductOutput,
  MandateOutput,
  OpsContext,
  SearchItemView,
  SearchProductsOutput,
  SignL3Output,
  SubmitCheckoutOutput,
} from './tools'

// --- the fence and the detector ------------------------------------------------------------------
export {
  EXCERPT_MAX_CHARS,
  FENCE_CLOSE,
  FENCE_MARKER_REMOVED,
  FENCE_OPEN,
  INJECTION_FLAG_KINDS,
  escapeFenceMarkers,
  fenceAndInspect,
  fenceMerchantResult,
  fenceUntrustedText,
  inspectUntrustedText,
} from './fence'
export type { FencedValue, InjectionFlag, InjectionFlagKind } from './fence'

// --- the refusal measurement --------------------------------------------------------------------
export {
  REFUSAL_CORPUS_DIR,
  REFUSAL_CORPUS_SIZE,
  REFUSAL_CASE_SCHEMA,
  formatRefusalReport,
  loadRefusalCorpus,
  outcomeFromEvents,
  summariseRefusal,
} from './refusal'
export type { RunReading } from './refusal'

// --- the vocabulary ------------------------------------------------------------------------------
export { READBACK_SUMMARY_MAX_CHARS, readbackSummaryLine } from './readback-summary'

export { REFUSAL_OUTCOMES, SHOP_EVENT_KINDS } from './types'
export type {
  AgentToolSet,
  CheckoutView,
  GateCheckView,
  GateOutcomeView,
  GateReasonView,
  InjectionClassifier,
  L3Signer,
  MandateItemView,
  MandatePort,
  MandateView,
  MerchantMcp,
  MerchantToolResult,
  RefusalCase,
  RefusalCaseResult,
  RefusalOutcome,
  RefusalReport,
  ShopDeps,
  ShopEvent,
  ShopEventData,
  ShopEventKind,
  ShopOutcome,
  ShopRequest,
  SignedL3,
  SignL3Result,
} from './types'
