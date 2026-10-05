/**
 * `@countersign/defender` types — spec **§8.15 (M15)**, **§8.16**, **§12.10**, **§12.11**.
 *
 * ## Why this file exists separately from the router
 *
 * The router is the second-most important piece of code in the repository after the Gate, and spec
 * **§18 question 20** is the question it answers: *"what stops us filing a bogus dispute against a good
 * customer?"* Nothing about it is clever. The answer is a **table of pure predicates that run before any
 * model is asked for anything**:
 *
 * - `route()` decides the posture. It reads rows and returns a decision. No LLM, no clock, no I/O.
 * - `planEvidence()` proposes *which* documents to attach. Still pure, still no model.
 * - WP-15c's drafter may only write **prose**, and every sentence it writes must cite a fact key that
 *   {@link LiabilityDecision.facts} already contains. A sentence that cannot cite is not filed.
 *
 * If the router could be talked around, the honesty claim in the README would be false. So it is a pure
 * function over an explicit input type, and the 40-case eval in `eval/router-cases.jsonl` scores it on
 * exact match (spec §8.16 AT-M15.1, which asks for 100%).
 *
 * ## Three vocabularies, and which one is which
 *
 * | Vocabulary | Where it comes from | Why it exists |
 * |---|---|---|
 * | {@link Posture} — 7 values | WP-15a | What we **recommend doing**, in the merchant's language. |
 * | {@link Liability} — 5 values | spec §8.15, and `disputes.liability` in `packages/db` | Who is at fault. Persisted. |
 * | {@link RuleId} — 21 values | spec §8.15's table, plus 7 documented extensions | Which predicate fired. Shown in the UI and the packet. |
 *
 * A posture and a liability are different questions: R-CHAIN-BAD is `UNPROVABLE` (nobody's fault) and
 * `ACCEPT_CLAIM` (we do not fight it). The router never lets one imply the other — `acceptance` is what
 * the merchant sees, `liability` is what the packet records.
 *
 * ## Everything is optional except the dispute and the clock
 *
 * A router that throws because a row is missing is a router that takes a dispute down. Every input
 * except `dispute` and `nowSec` defaults, and a rule that needs a fact we do not have **does not fire** —
 * the truthfulness of a decision comes from what it can prove, never from what it assumes.
 */

import type { Money } from '@countersign/core'
// Both imports are type-only even though `EVIDENCE_TYPES` is a runtime const: it is read through a
// `typeof` query, which the compiler erases, and this package never needs the array itself. The *values*
// are asserted in `test/rules.test.ts` against the live array, so a value that PayPal drops fails there.
import type { AllowedEvidenceContentType, EVIDENCE_TYPES } from '@countersign/paypal'

// ---------------------------------------------------------------------------
// The three vocabularies
// ---------------------------------------------------------------------------

/**
 * What the router recommends, in the seven words the product uses. **Never** a PayPal enum.
 *
 * | Posture | Meaning | PayPal call (`{@link LiabilityDecision.action}`) |
 * |---|---|---|
 * | `CONTEST` | File an evidence packet and argue the case. | `FILE` (`provide-evidence`) |
 * | `REFUND` | Pay the buyer. No packet. | none — this is our own refund, not a dispute action |
 * | `ACCEPT_CLAIM` | Let the claim stand. We do not fight it. | `ACCEPT` (`accept-claim`), or `FILE` when a refund receipt is the proof |
 * | `OFFER` | Settle without a fight: refund against a return. | `OFFER` (`make-offer`, `REFUND_WITH_RETURN`) |
 * | `MESSAGE_ONLY` | Talk to the buyer; there is nothing to file yet. | `MESSAGE` (`send-message`) |
 * | `APPEAL` | We lost, PayPal still offers an appeal, and there is new evidence. | `APPEAL` |
 * | `REVIEW` | A human decides. **Not** a timeout. | none |
 *
 * `REVIEW` carries a {@link LiabilityDecision.blockingReason}. The other six never do: "a human must
 * decide" is a statement about the case, and a deadline is a statement about the clock (EC-DSP-8 is a
 * `DEF_DEADLINE_PASSED` error in the filer, not a reason to stop).
 */
export type Posture =
  | 'REFUND'
  | 'ACCEPT_CLAIM'
  | 'CONTEST'
  | 'OFFER'
  | 'MESSAGE_ONLY'
  | 'APPEAL'
  | 'REVIEW'

/** Spec §8.15 `Liability`, and the `disputes.liability` enum in `packages/db`. Five values, no more. */
export type Liability =
  | 'USER_AUTHORISED'
  | 'AGENT_FAULT'
  | 'MERCHANT_FAULT'
  | 'UNPROVABLE'
  | 'ALREADY_REFUNDED'

/** `evidence_type` — exactly the values `@countersign/paypal` confirmed against PayPal's OpenAPI. */
export type EvidenceType = (typeof EVIDENCE_TYPES)[number]

/**
 * The `dispute_actions.action` enum, or `null` for "no PayPal call".
 *
 * Typed from the database rather than re-declared, so a new action in WP-02 breaks this file instead of
 * silently becoming unreachable.
 */
export type DisputeActionName =
  | 'FILE'
  | 'OFFER'
  | 'ACCEPT'
  | 'MESSAGE'
  | 'APPEAL'
  | 'ACK_RETURN'
  | 'SUPPORTING_INFO'
  | 'ESCALATE'
  /**
   * A refund we issued against the capture.
   *
   * Beyond spec §7.2's eight values, added with migration `0002`. `ACCEPT` means *we conceded the
   * buyer's claim to PayPal*; a refund issued in settlement is a different act, and recording the most
   * common outcome in the product as something else makes the S-17 timeline and any audit of whether we
   * contested inaccurate. See docs/DECISIONS.md D-028.
   */
  | 'REFUND'

/**
 * The rule ids. **Fourteen come from spec §8.15's table verbatim; seven are extensions.**
 *
 * Every extension is marked `extension` in {@link RULE_ORIGIN} and carries a reason in its own comment.
 * An extension is never a rewrite of a spec rule: the spec's rule id still exists, still fires, and still
 * wins where the two overlap. The reason for having a separate id at all is in `router.ts`: **a rule id
 * shown in the packet must always explain the posture next to it**, so a deadline-driven downgrade gets
 * its own id rather than borrowing `R-INR-2` and then contradicting it.
 */
export type RuleId =
  // --- spec §8.15, verbatim -----------------------------------------------------------------
  | 'R-REF-1'
  | 'R-NOCHAIN-1'
  | 'R-CHAIN-BAD'
  | 'R-INR-1'
  | 'R-INR-2'
  | 'R-SNAD-AGENT'
  | 'R-SNAD-MERCH'
  | 'R-SNAD-OK'
  | 'R-UNAUTH-1'
  | 'R-UNAUTH-2'
  | 'R-AMT-1'
  | 'R-AMT-2'
  | 'R-CNP-1'
  | 'R-DEFAULT'
  // --- extensions, each with a documented reason --------------------------------------------
  | 'R-APPEAL-1'
  | 'R-INR-3'
  | 'R-SNAD-THIN'
  | 'R-UNAUTH-3'
  | 'R-OTHER-REFUND'
  | 'R-DEADLINE-1'
  | 'R-NO-EVIDENCE'
  | 'R-STAGE-INQUIRY'

/** The fourteen rows spec §8.15's table names, verbatim. */
export type SpecRuleId =
  | 'R-REF-1'
  | 'R-NOCHAIN-1'
  | 'R-CHAIN-BAD'
  | 'R-INR-1'
  | 'R-INR-2'
  | 'R-SNAD-AGENT'
  | 'R-SNAD-MERCH'
  | 'R-SNAD-OK'
  | 'R-UNAUTH-1'
  | 'R-UNAUTH-2'
  | 'R-AMT-1'
  | 'R-AMT-2'
  | 'R-CNP-1'
  | 'R-DEFAULT'

/** Where a rule id came from. Surfaced in the packet so nobody has to guess. */
export type RuleOrigin = 'spec-8.15' | 'extension'

/**
 * Ids that appear in the spec under a different name, or in WP-15a's brief under a name the spec never
 * used. Resolving an alias is a **read-only** lookup: the decision always reports the canonical id.
 *
 * - `R-SNAD-CUST` is WP-15a's name for the customer's-own-misuse case. That *is* spec `R-SNAD-OK`:
 *   the item matches the signed checkout, so the purchase was authorised.
 * - `R-DLNG`, `R-UNREC` and `R-QUAL` are three names for two PayPal reasons. PayPal's enum has
 *   `MERCHANDISE_OR_SERVICE_NOT_RECEIVED` (both delivery names) and
 *   `MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED` (quality), so they are the `R-INR-*` and `R-SNAD-*` rules.
 * - `R-OTHER` is the spec's `R-DEFAULT` shape with a different default. §8.15 says manual review; WP-15a
 *   says refund. Both exist, under different conditions: `R-OTHER-REFUND` (the four reasons PayPal has that
 *   §8.15 never assigns, with a valid chain) refunds, and `R-DEFAULT` (everything else) reviews.
 */
export const RULE_ALIASES: Readonly<Record<string, readonly RuleId[]>> = {
  'R-SNAD-CUST': ['R-SNAD-OK', 'R-SNAD-THIN'],
  'R-DLNG': ['R-INR-1', 'R-INR-2', 'R-INR-3'],
  'R-UNREC': ['R-INR-1', 'R-INR-2', 'R-INR-3'],
  'R-QUAL': ['R-SNAD-AGENT', 'R-SNAD-MERCH', 'R-SNAD-OK', 'R-SNAD-THIN'],
  'R-OTHER': ['R-OTHER-REFUND', 'R-DEFAULT'],
}

// ---------------------------------------------------------------------------
// Router input
// ---------------------------------------------------------------------------

/** A `{sku, qty}` line. `shipments.lines` and the merchant-signed checkout lines are both these. */
export interface LineFact {
  readonly sku: string
  readonly qty: number
}

/** The three attributes spec §8.15 R-SNAD-AGENT names for its deterministic attribute diff. */
export interface ItemAttributes {
  readonly size?: string
  readonly color?: string
  readonly model?: string
}

/**
 * §8.8's `preferences` — **router-only input, and NOT a VI constraint.**
 *
 * The signed L2 does not contain it. `packages/compiler`'s read-back prints it under "How we read your
 * request" and immediately says it "is not a limit … not signed and do[es] not bound what the agent may
 * buy". That sentence is why `R-SNAD-AGENT` needs a second, signed witness before it will blame our own
 * agent — see `agentAuthorityExceeded` in `rules.ts`.
 */
export interface RouterPreferences {
  readonly size?: string
  readonly color?: string
  readonly model?: string
  readonly notes?: string
}

/** The buyer stated a preference; the item that actually arrived has these attributes. */
export interface DisputedItem {
  readonly sku: string
  readonly attributes: ItemAttributes
}

/**
 * What documents we can actually put in the packet.
 *
 * This is the input that makes **`R-NO-EVIDENCE`** possible, and it is deliberately a list of booleans
 * rather than a list of files: the router must be answerable by a database query and a directory
 * listing, not by a model's opinion. EC-AGT-2's bounded worst case is enforced by the Gate, not here; what
 * reaches the Defender is what survived it.
 *
 * `qualityDocument` is the one that matters for `R-SNAD-THIN`. A photograph of a packed box is not
 * evidence that the item inside was good.
 */
export interface EvidenceCorpus {
  /** A carrier confirmation, delivery record or invoice: proof of what was shipped and when. */
  readonly fulfilmentDocument?: boolean
  /** Proof the goods were *as described* — QC report, specification sheet, test results. */
  readonly qualityDocument?: boolean
  /** The buyer-facing receipt copy PayPal asks for under `PROOF_OF_RECEIPT_COPY`. */
  readonly receiptCopy?: boolean
}

/** Merchant policy. Defaults are the conservative ones, so an unconfigured merchant is never surprised. */
export interface MerchantPolicy {
  /**
   * Claims at or below this amount are settled without a human. **Defaults to zero**, which means
   * "no automatic acceptance at all": `R-NOCHAIN-1` becomes `REVIEW` rather than `ACCEPT_CLAIM`, which is
   * the answer spec EC-DSP-9 wants ("Not a Countersign order") and the one §18 question 20 needs.
   */
  readonly autoAcceptThresholdMinor?: bigint
  /**
   * EC-BUY-3's "$50" ceiling for accepting a weak `UNAUTHORISED` case with no passkey user-verification.
   * Defaults to zero, so the weak case reviews rather than accepts.
   */
  readonly weakUnauthorisedThresholdMinor?: bigint
}

/** The dispute, as `disputes` holds it, plus the two facts the router needs that the row has no column for. */
export interface DisputeFacts {
  readonly id: string
  readonly paypalDisputeId: string
  /** PayPal's `dispute_reason`. The router switches on the documented enum, never on free text. */
  readonly reason: string
  readonly stage: string
  readonly status: string
  readonly amount: Money
  /** Our own lifecycle, never a PayPal value. `CLOSED_LOST` is what opens the appeal path. */
  readonly defenseState?: string
  /** The capture the buyer disputed, if the join on `seller_transaction_id` succeeded. */
  readonly captureId?: string
  readonly orderId?: string
  /** `seller_response_due_date` as **UTC epoch seconds** (spec §0 rule 10), or `null` if PayPal sent none. */
  readonly sellerResponseDueSec?: number | null
  /** The `appeal` HATEOAS link — per `isAppealable()` in `@countersign/paypal`, this is the appeal gate. */
  readonly appealLinkPresent?: boolean
  /** We filed, PayPal ruled against us, and `dispute_state` is past the first decision (EC-DSP-6). */
  readonly previouslyLost?: boolean
  /** Something material arrived after the loss: a late tracking update, a carrier response. */
  readonly newEvidenceSinceLoss?: boolean
}

/** One capture of the order under dispute. */
export interface CaptureFacts {
  readonly id: string
  readonly paypalCaptureId: string
  readonly amount: Money
  /** Running refund total, denormalised on `captures` so an over-refund is refused locally. */
  readonly refundedMinor?: bigint
  readonly shipmentId?: string
  readonly status?: string
}

/** The order the capture belongs to. Present only when `custom_id` resolved (R-NOCHAIN-1). */
export interface OrderFacts {
  readonly id: string
  /** `"cs1:" + base64url(sha256(JCS(bundle)))` — the only string tying a packet to a PayPal transaction. */
  readonly customId: string
  readonly invoiceId?: string
  readonly amount: Money
}

export interface RefundFacts {
  readonly id: string
  readonly paypalRefundId: string
  readonly amount: Money
  /** `COMPLETED` refunds count toward R-REF-1; `PENDING` does not yet prove the money went back. */
  readonly status: string
  readonly atSec: number
}

export interface ShipmentFacts {
  readonly id: string
  readonly carrier: string
  readonly trackingNumber: string
  /** Present only if the merchant registered the tracker with PayPal (`addTracking`). */
  readonly paypalTrackerId?: string | null
  /** `shipments.status`: SHIPPED | DELIVERED | NOT_SHIPPED | VOIDED | FAILURE. */
  readonly status?: string
  readonly lines: readonly LineFact[]
}

/**
 * The signed chain, as the four facts the router reads.
 *
 * `webauthnPresent` is parsed from `mandates.webauthn_assertion` by the caller (WP-15e); the router does
 * not decode assertions, because "is a WebAuthn assertion there" is a question about a row, and
 * "does this assertion prove user presence" is a question for `@countersign/vi-client`.
 */
export interface ChainFacts {
  /** The mandate exists and is signed (L2 by the device key, L3 by the key bound inside it). */
  readonly mandatePresent?: boolean
  /** The exact read-back the user approved. The router parses it — see `readbackAttribute`. */
  readonly readback?: string
  /** The plain-English sentence the user typed. Recorded in evidence; never parsed. */
  readonly nlIntent?: string
  /** `mandates.iat` — UTC epoch seconds, mirroring the JWT claim. */
  readonly iatSec?: number
  readonly mandateStatus?: string
  /** A WebAuthn assertion with user-verification was present at signing (spec D4). */
  readonly webauthnPresent?: boolean
  /** `verifyAtCapture.chain_valid` — the verdict recorded when the payment was made. */
  readonly verifyAtCaptureChainValid?: boolean
  /**
   * `verifyNow.chain_valid` — a re-verification at review time (spec §8.18 "Verify now").
   *
   * Distinct from `verifyAtCaptureChainValid` on purpose: spec **D-009** found the pinned library ignores
   * `at_time`, so a capture-time verdict can be `false` for a chain that is in fact valid now. When
   * `verifyNowChainValid === true` the router treats the chain as good and **never** reaches R-CHAIN-BAD,
   * because a broken chain we cannot demonstrate is not a broken chain we may refuse to contest.
   */
  readonly verifyNowChainValid?: boolean
  /** Why the chain did not verify, verbatim from vi. */
  readonly verifyErrors?: readonly string[]
  /** `gate_decisions.decision`, when the payment went through the merchant's Gate. */
  readonly gateDecision?: string
  /** `devices.status` for the device that signed the mandate. */
  readonly deviceStatus?: string
  /**
   * When that device was reported lost, UTC epoch seconds.
   *
   * **Read from the audit trail, not from `devices`** — that table has no `lost_at` column, which is a
   * gap §18 question 8 needs and this package cannot fix (see the README, "Contract gaps").
   */
  readonly deviceLostAtSec?: number
}

/**
 * Everything `route()` reads. Plain data in, {@link LiabilityDecision} out.
 *
 * The shape follows spec §8.15's `RouterInput` (`dispute`, `order`, `captures`, `refunds`, `shipments`,
 * `mandate`, `gate`, `verifyAtCapture`) with two deliberate differences, both of which make the 40-case
 * eval writable:
 *
 * 1. `captures` is `capture` — one capture per order is the normal case (D17: one capture per shipment,
 *    so a partial shipment has several; the disputed amount always resolves to exactly one capture, and
 *    `R-AMT-2` looks for the duplicate across `orderId`).
 * 2. Derived facts are named as facts (`evidenceCorpus`, `preferences`, `chain`), not as tables, so a
 *    caller never has to make the router guess what a JSON column meant.
 */
export interface DisputeContext {
  /** **UTC epoch seconds**, injected (spec §0 rule 10). The router never calls a clock. */
  readonly nowSec: number
  readonly dispute: DisputeFacts
  readonly capture?: CaptureFacts
  readonly order?: OrderFacts
  readonly refunds?: readonly RefundFacts[]
  readonly shipments?: readonly ShipmentFacts[]
  /**
   * The order's other captures. Spec §8.15's `RouterInput` has `captures: CaptureRow[]`; one capture per
   * disputed capture would make `R-AMT-2` ("duplicate captures found", EC-MER-2) undetectable, because the
   * duplicate is by definition not the one under dispute. D17's one-capture-per-shipment means a partially
   * shipped order has several, and the sum is what R-AMT-1 compares against the order total.
   */
  readonly siblingCaptures?: readonly CaptureFacts[]
  /** Merged `mandates` + `gate_decisions` + `devices` + the verify verdict. */
  readonly chain?: ChainFacts
  /** The merchant-signed checkout lines. Compared against `shipments.lines` by R-SNAD-MERCH. */
  readonly checkoutLines?: readonly LineFact[]
  /** What the buyer asked for and what arrived. Read only by R-SNAD-AGENT. */
  readonly disputedItem?: DisputedItem
  /** §8.8 `preferences`. Router-only; never a constraint, never signed. */
  readonly preferences?: RouterPreferences
  /** Which documents exist. Drives `R-NO-EVIDENCE`. */
  readonly corpus?: EvidenceCorpus
  readonly policy?: MerchantPolicy
}

// ---------------------------------------------------------------------------
// Router output
// ---------------------------------------------------------------------------

/**
 * One citable fact: `{key, value, source}` from spec §8.15's `RouterOutput`.
 *
 * WP-15c's `checkCitations` requires every number, date, id or claim in the notes to carry a `[F:key]`
 * tag whose **value appears verbatim in that sentence**. These keys are the whole vocabulary a note may
 * cite, and they are produced here — by pure string composition — so a drafted sentence can only ever
 * cite something the router actually decided.
 */
export interface RouterFact {
  readonly key: string
  readonly value: string
  /** Where the value came from: `disputes`, `refunds`, `shipments`, `mandates`, `verify`, `policy`. */
  readonly source: string
}

/** EC-DSP-7's three bands, plus the two the router cannot ignore. */
export type DeadlineState =
  /** PayPal sent no `seller_response_due_date` (usually `INQUIRY`). Nothing to be late for. */
  | 'UNKNOWN'
  /** Past the deadline. The filer returns `DEF_DEADLINE_PASSED`; the router still records its rule. */
  | 'PASSED'
  /** Inside 1 hour. Spec EC-DSP-7: auto-file is disabled here because a partial upload is a lost response. */
  | 'CRITICAL'
  /** Inside 48 hours. The rationale says so, and un-gathered evidence downgrades the posture. */
  | 'PRESSURE'
  /** More than 48 hours out. */
  | 'COMFORTABLE'

/** One line about the clock, as the router states it. `null` when the deadline is comfortable or unknown. */
export interface DeadlineState_ {
  readonly state: DeadlineState
  readonly secondsLeft: number | null
  /** "2d 14h" / "41m" / "0s" — `formatCountdown` from `@countersign/core`. */
  readonly countdown: string | null
}

/**
 * The decision. Every field is set on every call: there is no "unset" branch that a caller has to
 * remember to check, because a field that is sometimes missing is a field a judge cannot trust.
 */
export interface LiabilityDecision {
  /** The predicate that fired. Always the canonical id — never an alias. */
  readonly ruleId: RuleId
  /** Who is at fault. Persisted to `disputes.liability`. */
  readonly liability: Liability
  /** What we recommend. Seven values, in `Posture`. */
  readonly posture: Posture
  /**
   * The sentence a buyer reads in S-18 and a judge reads in the packet.
   *
   * Built by pure composition in `rationale.ts` — no model, ever. It always names the rule id, and it
   * always states the fact the rule compared rather than the conclusion alone, because "the router said
   * refund" is not reviewable and "the user asked for size 9 and size 10 arrived" is.
   */
  readonly rationale: string
  /** The same facts as prose sentences, one per line, for the UI's "why" list. */
  readonly reasons: readonly string[]
  /** The citation vocabulary for WP-15c's note checker. Keys are unique and stable. */
  readonly facts: readonly RouterFact[]
  /**
   * `evidence_type` values PayPal actually accepts, from `@countersign/paypal`'s corrected enum.
   *
   * **Invariant, and the one a judge is really asking about: if `posture === 'CONTEST'` this array is
   * non-empty and every member is in `EVIDENCE_TYPES`.** `R-NO-EVIDENCE` exists to keep it that way —
   * `test/router.test.ts` asserts it as a property over generated contexts, not over fixtures.
   */
  readonly evidenceRequired: readonly EvidenceType[]
  /** Set **only** on `REVIEW`, and only when a human is the thing that is missing. Never for a timeout. */
  readonly blockingReason?: string
  /** The PayPal dispute action this posture implies, or `null` when there is none. */
  readonly action: DisputeActionName | null
  /** The clock, as the router saw it. */
  readonly deadline: DeadlineState_
  /** Present only on `R-DEADLINE-1` / `R-NO-EVIDENCE`: the rule whose posture this one replaced. */
  readonly supersedes?: RuleId
  /** The user-facing flag spec §8.15 R-UNAUTH-1 requires ("possible compromised device"). */
  readonly userAlert?: string
}

// ---------------------------------------------------------------------------
// Evidence plan (WP-15b)
// ---------------------------------------------------------------------------

/**
 * PayPal's limit on `notes`, per `SPEC-D` `evidence.properties.notes` (`minLength: 1, maxLength: 2000`).
 * A **string**, not `string[]` — spec D-012 corrected this after the sandbox audit, and
 * `@countersign/paypal`'s `provideEvidenceInputSchema` enforces it.
 */
export const NOTES_MAX_CHARS = 2000

/** One document the merchant must produce. `required: false` means "helpful, do not block on it". */
export interface PlannedDocument {
  /** The filename PayPal will show, `file1`-style names live in `packages/paypal/src/multipart.ts`. */
  readonly name: string
  /** What it has to be, in words a merchant can act on. */
  readonly description: string
  /**
   * MIME type, typed as {@link AllowedEvidenceContentType}.
   *
   * Typed rather than `string` so an unaccepted type is a compile error at the point it is written, not a
   * 4xx from PayPal after a 50 MB upload (EC-DSP-12).
   */
  readonly contentType: AllowedEvidenceContentType
  /** Hard ceiling in bytes; `null` for "size depends on rendering". */
  readonly maxBytes: number | null
  readonly required: boolean
}

export interface EvidencePlanItem {
  readonly evidenceType: EvidenceType
  /**
   * `evidence_info` exactly as PayPal documents it: `tracking_info[{carrier_name, tracking_number}]` and
   * `refund_ids`. Both are omitted rather than sent empty — an empty array is not the same as absent to
   * a strict parser, and we have no way to test it (H-01).
   */
  readonly evidenceInfo: {
    readonly tracking_info?: readonly {
      readonly carrier_name: string
      readonly tracking_number: string
    }[]
    readonly refund_ids?: readonly string[]
  }
  /** ≤ {@link NOTES_MAX_CHARS} characters. Pure composition; WP-15c may replace it with cited prose. */
  readonly notes: string
  readonly documents: readonly PlannedDocument[]
}

export interface EvidencePlan {
  readonly items: readonly EvidencePlanItem[]
  /**
   * EC-REF-5: the disputed amount split across the shipments that cover it, by line quantity, with the
   * last line taking the exact remainder. Empty when the dispute is not split across shipments.
   */
  readonly shipmentShares: readonly {
    readonly shipmentId: string
    readonly sku: string
    readonly qty: number
    readonly share: Money
  }[]
  /**
   * Anything the caller must know before filing: a missing document, a size over PayPal's limit, a plan
   * that is empty because the posture files nothing. Never thrown — a proposal that cannot be sent is
   * still useful information.
   */
  readonly warnings: readonly string[]
}
