/**
 * `@countersign/agent`'s public vocabulary — spec **§8.13 (M13)**, WP-13.
 *
 * The shapes here are the ones §8.13 names (`ShopRequest`, `ShopEvent`, `runShoppingAgent`'s deps) plus
 * the two ports the agent needs and must not own:
 *
 *  - {@link MandatePort} — the buyer's signed mandate, read-only. There is deliberately **no** method to
 *    change it, and adding one would be the entire vulnerability: §8.13 defence 2 says "the agent cannot
 *    change the mandate. No tool exists for that, and mandate changes require the device key." A port
 *    with no mutator is how that sentence becomes a type error rather than a policy.
 *  - {@link L3Signer} — vi-service's `/v1/l3/create`, narrowed to one method. The signer refuses
 *    out-of-mandate requests (§8.13 defence 3) *and* the Gate re-checks everything (defence 4), so the
 *    agent is allowed to be wrong in both places and still not spend money.
 *
 * ## Money never crosses this boundary as a float
 *
 * Every amount here is `bigint` minor units plus an ISO-4217 code, per AGENTS.md rule 9. The merchant
 * MCP wire carries decimal **strings** (`jsonSafe` in the route's `toolResult`), so the first thing the
 * tool layer does is parse them back to `bigint` with `BigInt(...)` and refuse anything that is not
 * canonical — never `Number(...)`, which is where a `129.00` would quietly become `129`.
 */
import type { AgentId, Clock, CsError, MandateId, Money, Result, UserId } from '@countersign/core'
import type { LanguageModel, ToolSet } from 'ai'

/* ------------------------------------------------------------------------------------------ */
/* The request and the event stream                                                              */
/* ------------------------------------------------------------------------------------------ */

/** What the buyer asked for, and under which mandate. §8.13's `ShopRequest`. */
export interface ShopRequest {
  readonly userId: UserId
  readonly mandateId: MandateId
  readonly agentId: AgentId
  /** The buyer's own words. Untrusted input, but not *merchant* untrusted — no fencing applies to it. */
  readonly message: string
}

/**
 * One event of the agent's run, streamed to the UI.
 *
 * §8.13's five kinds are kept and four are added, because the UI (S-10) needs to render four things the
 * original union has nowhere to put: the "suspected injection" badge, the Gate verdict, a terminating
 * error, and the run's outcome. Folding any of them into `thought` or `final` would force the UI to
 * parse prose, which is how a demo screen becomes a parser.
 */
export const SHOP_EVENT_KINDS = [
  /** The agent's own reasoning, as text. Not authority — display only. */
  'thought',
  /** A tool was called. */
  'tool_call',
  /** A tool returned. */
  'tool_result',
  /** A deterministic detector flagged suspected injection in merchant text (§8.13 defence 5). */
  'injection',
  /** The Gate answered. This is the authoritative event of the run. */
  'gate',
  /** The run failed in a way with no useful tool result. */
  'error',
  /** The run is over. Exactly one of these per run, and it is the last event. */
  'final',
] as const

export type ShopEventKind = (typeof SHOP_EVENT_KINDS)[number]

export interface ShopEvent {
  readonly kind: ShopEventKind
  /** UTC epoch **milliseconds** for ordering the UI stream. Tokens use seconds; a stream is not a token. */
  readonly at: number
  readonly data: ShopEventData
}

/** The outcome of a run, as the UI needs it. `ALLOWED` is not the same fact as `ORDERED`. */
export type ShopOutcome =
  /** The Gate allowed and the merchant created an order. */
  | 'ORDERED'
  /** The Gate refused. The reasons are on the `gate` event that preceded this one. */
  | 'GATE_BLOCKED'
  /** The signer refused before an L3 existed (§8.13 defence 3). */
  | 'SIGNER_REFUSED'
  /** The agent finished without attempting a purchase. A legitimate answer for a hostile listing. */
  | 'NO_PURCHASE'
  /** The run could not complete: provider down, malformed tool result, and so on. */
  | 'ERROR'

export interface ShopEventData {
  readonly text?: string
  readonly toolCallId?: string
  readonly tool?: string
  readonly input?: unknown
  readonly output?: unknown
  readonly ok?: boolean
  readonly flags?: readonly unknown[]
  readonly gate?: GateOutcomeView
  readonly outcome?: ShopOutcome
  readonly error?: { readonly code: string; readonly message: string }
}

/* ------------------------------------------------------------------------------------------ */
/* The Gate's answer, as the UI and the agent both read it                                      */
/* ------------------------------------------------------------------------------------------ */

export interface GateReasonView {
  readonly code: string
  readonly message: string
  /** The buyer-facing sentence. S-10 renders this one, not `message`. */
  readonly userMessage: string
}

export interface GateCheckView {
  readonly code: string
  /** `false` when the check failed; `null` when it could not run. Never `true` for "did not run". */
  readonly passed: boolean | null
  readonly detail?: string
}

/**
 * What `submit_checkout` returned, normalised.
 *
 * `decisionId` is present whenever the Gate answered — including a `BLOCKED`, because a refusal that is
 * not recorded is a refusal nobody can audit. `orderId` is present only when a purchase exists; the
 * distinction between "allowed" and "bought" is the distinction the UI must not blur.
 */
export interface GateOutcomeView {
  readonly status: 'ALLOWED' | 'BLOCKED' | 'REVIEW'
  readonly decisionId: string | null
  readonly reasons: readonly GateReasonView[]
  readonly checks: readonly GateCheckView[]
  readonly orderId: string | null
  /** The amount the Gate decided about, in minor units, as a decimal string (JSON has no bigint). */
  readonly amountMinor: string | null
  readonly currency: string | null
  readonly payee: string | null
}

/* ------------------------------------------------------------------------------------------ */
/* The mandate: read-only, and nothing else                                                      */
/* ------------------------------------------------------------------------------------------ */

export interface MandateItemView {
  readonly id: string
  readonly title: string
}

/**
 * The buyer's signed mandate, as the agent may see it.
 *
 * `readback` is the same string the buyer signed (§8.5) — the agent shows it, and it is the reason
 * `read_my_mandate` exists at all: an agent that can quote the buyer's own limits back cannot claim it
 * "did not know".
 */
export interface MandateView {
  readonly mandateId: MandateId
  readonly agentId: AgentId
  readonly userId: UserId
  readonly status: string
  readonly currency: string
  readonly readback: string
  /** The per-purchase cap, or `null` when none was disclosed. Never defaulted to a number. */
  readonly maxAmountMinor: bigint | null
  /** The total budget across the mandate's life, or `null` when none was disclosed (spec D19). */
  readonly budgetMinor: bigint | null
  readonly allowedMerchantIds: readonly string[]
  readonly acceptableItems: readonly MandateItemView[]
  /** UTC epoch seconds. */
  readonly expiresAtEpochSec: number
}

/**
 * Read-only access to a mandate.
 *
 * Deliberately one method. §8.13 defence 2 is "the agent cannot change the mandate"; the way to keep
 * that true after this package grows is for the port to have no writer to call.
 */
export interface MandatePort {
  load(mandateId: MandateId): Promise<Result<MandateView | undefined, CsError>>
}

/* ------------------------------------------------------------------------------------------ */
/* The signer: vi-service's /v1/l3/create                                                        */
/* ------------------------------------------------------------------------------------------ */

/**
 * A merchant checkout the agent is considering, resolved from the merchant's own price lock.
 *
 * The agent never supplies an amount to the signer. It supplies a **checkout id** and the merchant's
 * stored session is what the signature covers — otherwise the agent could sign one amount and submit
 * another, which is exactly the class of bug Gate check 6 exists to catch.
 */
export interface CheckoutView {
  readonly checkoutId: string
  readonly merchantId: string
  readonly merchantName: string
  readonly totalMinor: Money
  readonly lines: readonly { readonly sku: string; readonly qty: number; readonly title: string }[]
  readonly priceLockExpiresAtMs: number
}

/** The result of a successful `sign_l3`. */
export interface SignedL3 {
  readonly l3a: string
  readonly l3b: string
  readonly jti: string
  readonly amountMinor: Money
  readonly payeeId: string
}

/**
 * Sign an L3 for a merchant checkout, or refuse.
 *
 * `refused` is a first-class outcome: §8.13 defence 3 makes the signer an enforcer, and a refusal there
 * is a *successful* run of the control, not an error. The `CsError.code` is `VI_CONSTRAINT_VIOLATION`
 * for an out-of-mandate cart.
 */
export type SignL3Result =
  | { readonly ok: true; readonly value: SignedL3 }
  | { readonly ok: false; readonly refused: true; readonly error: CsError }
  | { readonly ok: false; readonly refused: false; readonly error: CsError }

export interface L3Signer {
  /** Resolve the merchant checkout behind `checkoutId`, or `undefined` when the merchant does not know it. */
  loadCheckout(checkoutId: string): Promise<Result<CheckoutView | undefined, CsError>>
  signCheckout(checkout: CheckoutView): Promise<SignL3Result>
}

/* ------------------------------------------------------------------------------------------ */
/* The merchant MCP: the only commerce surface                                                   */
/* ------------------------------------------------------------------------------------------ */

/**
 * The merchant MCP client, structurally.
 *
 * `@ai-sdk/mcp`'s `MCPClient` satisfies this, and so does a test double with two methods — which is the
 * point. §8.13 says the agent uses **only** the merchant MCP for commerce operations; the narrowest
 * interface that can express "commerce" is `callTool`, and `close` for the run's cleanup.
 */
export interface MerchantMcp {
  callTool(args: { name: string; arguments?: Record<string, unknown> }): Promise<MerchantToolResult>
  close(): Promise<void>
}

/** The subset of MCP's `CallToolResult` this package reads. */
export interface MerchantToolResult {
  readonly isError?: boolean
  readonly content?: readonly { readonly type: string; readonly text?: string }[]
}

/* ------------------------------------------------------------------------------------------ */
/* The dependencies                                                                              */
/* ------------------------------------------------------------------------------------------ */

/** §8.13 defence 5: the advisory classifier. It may only add flags; it can never remove one. */
export type InjectionClassifier = (
  text: string,
) => Promise<readonly { readonly kind: string; readonly excerpt: string }[]>

export interface ShopDeps {
  /** The tool-calling model. Absent or failing means the caller should use {@link ScriptedShopper}. */
  readonly llm: LanguageModel
  readonly merchantMcp: MerchantMcp
  readonly mandate: MandatePort
  readonly signer: L3Signer
  readonly clock: Clock
  /** Optional advisory classifier. See {@link InjectionClassifier}. */
  readonly classifyInjection?: InjectionClassifier
  /** The tool set to expose. Defaults to the six §8.13 tools; a test may narrow it. */
  readonly tools?: ToolSet
}

/* ------------------------------------------------------------------------------------------ */
/* Refusal measurement (§8.20: "the agent's own refusal rate is reported, not gated")            */
/* ------------------------------------------------------------------------------------------ */

/** One case of the refusal corpus: an intent plus the merchant text the buyer's agent will read. */
export interface RefusalCase {
  readonly id: string
  readonly attack: string
  readonly intent: string
  readonly listingText: string
  readonly sku: string
  /** Minor units. The mandate the case runs under is built from this. */
  readonly mandateCapMinor: string
}

/** What happened when one case ran. */
export const REFUSAL_OUTCOMES = [
  /** The agent itself declined; no L3 was requested. */
  'AGENT_REFUSED',
  /** The run ended without a purchase and without asking for an authorisation. */
  'NO_PURCHASE',
  /** The signer refused the cart (vi `/v1/l3/create`, §8.13 defence 3). */
  'SIGNER_REFUSED',
  /** An L3 existed and the Gate refused it (§8.13 defence 4). */
  'GATE_BLOCKED',
  /** A purchase resulted. For an injection case this is a breach. */
  'ORDERED',
  /** The run failed for an unrelated reason; counted separately and never as a win. */
  'ERROR',
] as const

export type RefusalOutcome = (typeof REFUSAL_OUTCOMES)[number]

export interface RefusalCaseResult {
  readonly id: string
  readonly attack: string
  readonly outcome: RefusalOutcome
  readonly flags: readonly InjectionFlagName[]
  readonly reason: string
}

/** The flag kind names, restated here so `types.ts` does not import the detector. */
export type InjectionFlagName = string

export interface RefusalReport {
  readonly total: number
  readonly refused: number
  /** `refused / total`, in the range 0–1. `null` when the corpus was empty — never 0/0 as `NaN`. */
  readonly refusalRate: number | null
  /** Cases that resulted in a purchase. §8.13 calls this the attack-success rate and it must be 0. */
  readonly purchases: number
  readonly errors: number
  readonly byOutcome: Readonly<Record<RefusalOutcome, number>>
  readonly cases: readonly RefusalCaseResult[]
}

export type AgentToolSet = ToolSet
