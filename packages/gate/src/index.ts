/**
 * `@countersign/gate` — spec **§8.10** (M10), **§8.9** (M9, re-exported from `./merchant`), **D19**.
 *
 * ## One paragraph on why this package is the centre of the project
 *
 * §3.1 invariant **I-1**: *no PayPal money movement happens unless a Gate `ALLOW` decision record exists
 * for exactly that order, amount, currency and payee.* Every line of code here serves that sentence, and
 * two properties of the package as a whole are load-bearing:
 *
 *  1. **It is deterministic, and provably free of a model.** §8.10: "**No LLM** anywhere in M10,
 *     enforced by a lint rule banning imports from `ai`/`@ai-sdk/*` in `packages/gate`." `eslint.config.mjs`
 *     (`GATE_LLM_BAN`, D-018) enforces the ban, and `GateDeps` is a *closed* list of the capabilities
 *     the Gate has — so "no LLM" is a statement about a type, not a promise in a README.
 *  2. **Every check always runs.** §8.10: "all checks always run so every reason is reported; the
 *     decision is ALLOW only if all pass." Short-circuiting would be faster and would lose exactly the
 *     information a buyer needs to fix their agent's behaviour in one turn instead of six.
 *
 * ## The twelve checks, in order
 *
 * | # | Check | Data it reads | Fails with |
 * |---|---|---|---|
 * | 1 | Mandate ACTIVE, not revoked, `exp > now − skew` | `mandates` | `GATE_REVOKED` / `VI_EXPIRED` |
 * | 2 | Agent ACTIVE, L3 key == the L2-bound key | `agents` + the L3a `kid` | `GATE_AGENT_SUSPENDED` |
 * | 3 | Device ACTIVE | `devices` | `GATE_REVOKED` |
 * | 4 | vi `/v1/verify` **strict**: `chain_valid` and `constraints.satisfied` | `ViClient.verify` | `VI_CHAIN_INVALID` / `VI_CONSTRAINT_VIOLATION` |
 * | 5 | Checkout JWT hash == L3b `checkout_hash`, signed by a current-or-retired merchant kid | `checkout_sessions` + `jwks` | `VI_CHAIN_INVALID` |
 * | 6 | `price_lock_exp > now`, totals == L3a amount, currency equal | `checkout_sessions` + L3a claims | `GATE_PRICE_LOCK_EXPIRED` / `CS_CURRENCY_MISMATCH` |
 * | 7 | L3 `jti` unused | the `checkout_attempts` insert | `GATE_REPLAY` |
 * | 8 | Budget: `FOR UPDATE`, `reserved+spent+amount ≤ min(signed L2 budget, cap)`, insert RESERVE | `BudgetStore` + the verified chain's `disclosed.l2` | `GATE_BUDGET_EXCEEDED` (+ `VI_CONSTRAINT_VIOLATION`) |
 * | 9 | Wallet cap for the period, across all mandates | `wallet_caps` + `budget_entries` | `GATE_WALLET_CAP` |
 * | 10 | Stock for every line | `products` | `GATE_OUT_OF_STOCK` |
 * | 11 | Recurrence windows, if present | `budget_entries` + the verified chain's `disclosed.l2` + the `mandates.constraints` cache | `VI_CONSTRAINT_VIOLATION` |
 * | 12 | Velocity: >5 attempts / 10 min, or >3 BLOCKs in a row → `REVIEW` + `SUSPENDED` | `checkout_attempts` | `GATE_BLOCKED` |
 *
 * ## The D19 obligation, in one paragraph
 *
 * The pinned Verifiable Intent library lists `mandate.payment.budget`, `.recurrence` and
 * `.agent_recurrence` as **network-enforced and not evaluated** ([B3]). `apps/vi` therefore reports them
 * in `constraints.skipped` rather than `constraints.checked`, and **checks 8, 9 and 11 in this package are
 * the entire reason a buyer's budget and recurrence limits are real**. The Gate reads that obligation with
 * `pendingNetworkEnforcement(verify.constraints.skipped)` from `@countersign/vi-client` and treats a
 * non-empty result as an obligation. It never reads `constraints.satisfied` as covering a
 * network-enforced constraint, because it does not: `.includes()` on that array is a silent `false`
 * while a signed cap sits unevaluated, and a Gate written that way fails **open**, in favour of spending.
 * docs/DECISIONS.md **D-019** is the long version, and the type system enforces the short one.
 *
 * ## An obligation nobody can discharge is a BLOCK, not a note
 *
 * Recording an obligation is not discharging it. So the numbers themselves are read from the **verified
 * chain** — `VerifyResponse.disclosed.l2`, the payload vi decoded out of the `sd-jwt+kb` the buyer's
 * device key signed while verifying the very chain check 4 already asked about. There is no extra
 * network call: it is a field on the response in hand. `mandates.constraints` and
 * `budget_accounts.cap_minor` are still *read*, because each is a limit the buyer is bound by, but they
 * are caches: where they disagree with the signature the **smaller** number is enforced.
 *
 * And if a constraint vi named as network-enforced cannot be read at all, `obligationUnmet` returns a
 * `VI_CONSTRAINT_VIOLATION` and the decision is `BLOCK`. A `REVIEW` was considered and rejected: §8.10's
 * table gives no `REVIEW` for an unenforceable signed budget, and a check that can be waved through is a
 * check that eventually will be.
 *
 * ## What lives here
 *
 * - `evaluate.ts` — `evaluate(i, deps)`: one clock read, twelve checks, compensation, one signed record.
 * - `checks.ts` — checks 1–7 and 10–11, plus `CHECK_ORDER`, the one list of the twelve.
 * - `budget-guard.ts` — checks 8 and 9, in one transaction, and the reservation release.
 * - `signed-constraints.ts` — the buyer's **signed** budget and recurrence, read from the verified
 *   chain, and the `min`-of-every-limit rule that makes a cache unable to loosen a signature.
 * - `velocity.ts` — check 12's arithmetic and the `SUSPENDED` consequence.
 * - `decision-record.ts` — the nine-field JWS, `checks_hash`, the JWKS, and local verification.
 * - `deps.ts` — the `GateDeps` contract, an in-memory store that models `FOR UPDATE`, and the wiring
 *   helper that turns `packages/db`'s repositories into a `GateDeps`.
 * - `merchant/` — §8.9: catalog, cart, price lock, checkout session, stock, MCP tool schemas.
 *
 * No PayPal. Spec §3.1 puts the Gate on the merchant side of the boundary, before the orchestrator, so
 * nothing here opens a socket to PayPal and the whole package is testable with no credentials and no
 * network. `packages/ledger` owns the budget ledger's reservation lifetime and recurrence arithmetic;
 * `packages/db` owns the SQL. See each file's header for why that split is where it is.
 */

// --- the Gate --------------------------------------------------------------------------------
export { readSignedCheckout, CHECKOUT_SOURCE, type SignedCheckoutReading } from './signed-checkout'
export { deriveL3ReplayId } from './replay-id'

export {
  evaluate,
  describeDecision,
  hasEveryCheck,
  resolveOutcome,
  type EvaluateOptions,
} from './evaluate'

export {
  BUDGET_OBLIGATIONS,
  CHECK_ORDER,
  CHECK_FAILURE_CODES,
  RECURRENCE_OBLIGATIONS,
  cartLines,
  chainTokens,
  check1MandateActive,
  check10Stock,
  check11Recurrence,
  check2AgentActive,
  check3DeviceActive,
  check4ChainVerify,
  check5CheckoutBinding,
  check6PriceLock,
  check7Replay,
  checkSetHashInput,
  codeFor,
  decodeHeaderKid,
  decisionCurrency,
  l3aAmount,
  loadSession,
  obligationUnmet,
  pendingObligations,
  reasonCodes,
  recurrenceObligationsMet,
  type CheckContext,
  type CheckHooks,
  type CheckResult,
  type CheckState,
  type CheckStateMandate,
  type CheckStateReservation,
} from './checks'

export {
  check8Budget,
  check9WalletCap,
  compensateReservation,
  handleFor,
  GATE_BLOCK_RELEASE,
} from './budget-guard'

// --- the signed constraints D19 makes the Gate enforce ------------------------------------------
export {
  AGENT_RECURRENCE_CONSTRAINT_TYPE,
  BUDGET_CONSTRAINT_TYPE,
  CONSTRAINT_SOURCE,
  NO_DISCLOSED_CONSTRAINTS,
  RECURRENCE_CONSTRAINT_TYPE,
  capSourceLabel,
  checkCapCurrencies,
  describeSources,
  disclosedConstraints,
  effectiveBudgetCap,
  mergeRecurrenceConstraints,
  readSignedBudget,
  type BudgetCapCandidate,
  type BudgetCapSource,
  type BudgetReading,
  type ConstraintSource,
  type DisclosedConstraints,
  type EffectiveBudgetCap,
  type RecurrenceReading,
  type SignedBudget,
} from './signed-constraints'

export {
  assessVelocity,
  consecutiveBlocks,
  reviewReason,
  suspendForVelocity,
  velocityBlocked,
  type VelocityInput,
} from './velocity'

export {
  checksHash,
  decodeCheckoutJwt,
  decodeL3,
  GATE_RECORD_TYP,
  gateJwks,
  gateJwksMany,
  importGateSigningKey,
  merchantKeySetFromJwks,
  REQUIRED_FIELDS,
  recordMatches,
  recordSigner,
  sha256Hex,
  signDecisionRecord,
  verifyDecisionRecord,
  verifyWithMerchantKey,
  type CheckoutJwtClaims,
  type L3Claims,
  type RecordVerdict,
  type SignRecordInput,
  type VerifyRecordOptions,
} from './decision-record'

// --- types and wiring -------------------------------------------------------------------------
export {
  VELOCITY,
  type AttemptState,
  type DeviceIdLike,
  type GateCheck,
  type GateDecision,
  type GateDeps,
  type GateInput,
  type GateJwks,
  type GateOutcome,
  type GateReason,
  type GateRecordPayload,
  type MerchantKeySet,
  type NewAttemptForGate,
  type PublicJwk,
  type ReservationHandle,
  type RowOfAgents,
  type RowOfDevices,
  type RowOfL1,
  type VelocityVerdict,
} from './types'

export {
  createInMemoryGateWorld,
  createInMemoryBudgetStore,
  defineGateDeps,
  DEFAULT_GATE_DEPS,
  FOR_UPDATE_HELD_NOTE,
  gateDepsFromRepos,
  type GateRepoHandles,
  type InMemoryBudgetStore,
  type InMemoryGateWorld,
  type InMemoryGateWorldSeed,
  type MemoryBudgetStoreOptions,
} from './deps'

// --- M9: the merchant catalog, cart and price lock ------------------------------------------------
export {
  CHECKOUT_PRICE_LOCK_SECONDS,
  FLAT_SHIPPING_MINOR,
  TAX_MINOR,
  createCheckout,
  getOrderStatus,
  getProduct,
  listMcpTools,
  decrementStockForOrder,
  restoreStockOnVoid,
  searchProducts,
  submitCheckout,
  untrusted,
  type CartLineInput,
  type CreateCheckoutInput,
  type CreateCheckoutResult,
  type GetOrderStatusInput,
  type GetOrderStatusResult,
  type GetProductResult,
  type McpToolDefinition,
  type MerchantCatalogStore,
  type MerchantCheckoutStore,
  type MerchantDeps,
  type MerchantProduct,
  type PriceLock,
  type SearchProductsInput,
  type SearchProductsResult,
  type StockResult,
  type SubmitCheckoutInput,
  type SubmitCheckoutResult,
} from './merchant'
