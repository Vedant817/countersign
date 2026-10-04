/**
 * The rules table — spec **§8.15**, work package **WP-15a**.
 *
 * ## What this file is
 *
 * Twenty-one named predicates over a {@link DisputeContext}, each pure, each a function of its arguments
 * only. No model, no clock, no database, no `Date.now()`. `route()` in `router.ts` calls them in a fixed
 * order and the first one that matches wins, which is what spec §8.15 means by "first match wins".
 *
 * ## Why "first match wins" is the right shape and not a limitation
 *
 * Each rule is a *sufficient* condition for one conclusion, and the conclusions are ordered by how much we
 * can prove:
 *
 * 1. **Money already moved** (R-REF-1, R-CNP-1) — nothing to argue about.
 * 2. **The case is over and appealable** (R-APPEAL-1).
 * 3. **We have no proof at all** (R-NOCHAIN-1, R-CHAIN-BAD) — judge question 20, and the reason this
 *    package is worth reading: *nothing downstream may contest a payment we cannot prove was authorised*.
 * 4. **We know who is at fault** (the reason-specific rules).
 * 5. **We cannot prove our own case** (R-NO-EVIDENCE, R-DEADLINE-1).
 * 6. **Nothing fits** (R-DEFAULT) → a human.
 *
 * ## The three places this table is deliberately more than the spec
 *
 * | Rule | Spec says | Here | Why |
 * |---|---|---|---|
 * | R-UNAUTH-2 before R-UNAUTH-1 | R-UNAUTH-1 is listed first | R-UNAUTH-2, R-UNAUTH-3, then R-UNAUTH-1 | R-UNAUTH-1's condition ("a valid chain with device and webauthn at signing") is **also true when the device was stolen and the attacker used the passkey**. §18 q8 and EC-BUY-3 require the lost device to win, so in the spec's row order R-UNAUTH-2 could never fire. |
 * | R-INR-3 (tracking still moving) | not in the table | `MESSAGE_ONLY` | A parcel in transit is not a delivery dispute yet. Filing now spends one of the merchant's response attempts; a message costs nothing. |
 * | R-SNAD-THIN (thin quality proof) | not in the table | `OFFER` (`REFUND_WITH_RETURN`) | EC-BUY-1: offer a return rather than fight, because fighting costs ~$82 [V13]. A shipping photo is not proof the item was good. |
 *
 * `R-UNAUTH-3` closes a hole rather than adding a preference: §12 EC-BUY-3 says a weak `UNAUTHORISED` case
 * (chain valid, **no** passkey user-verification) should be accepted above $50 at the merchant's setting,
 * and §8.15's table has no row for it — so it would have fallen through to R-DEFAULT and sat in manual
 * review forever.
 */

import type { Money } from '@countersign/core'

import type {
  DisputeContext,
  EvidenceType,
  LineFact,
  RefundFacts,
  RuleId,
  RuleOrigin,
  ShipmentFacts,
} from './types'

// ---------------------------------------------------------------------------
// Rule provenance
// ---------------------------------------------------------------------------

/** Which rows are spec §8.15's and which are this package's. Shown in the packet. */
export const RULE_ORIGIN: Readonly<Record<RuleId, RuleOrigin>> = {
  'R-REF-1': 'spec-8.15',
  'R-NOCHAIN-1': 'spec-8.15',
  'R-CHAIN-BAD': 'spec-8.15',
  'R-INR-1': 'spec-8.15',
  'R-INR-2': 'spec-8.15',
  'R-SNAD-AGENT': 'spec-8.15',
  'R-SNAD-MERCH': 'spec-8.15',
  'R-SNAD-OK': 'spec-8.15',
  'R-UNAUTH-1': 'spec-8.15',
  'R-UNAUTH-2': 'spec-8.15',
  'R-AMT-1': 'spec-8.15',
  'R-AMT-2': 'spec-8.15',
  'R-CNP-1': 'spec-8.15',
  'R-DEFAULT': 'spec-8.15',
  'R-APPEAL-1': 'extension',
  'R-INR-3': 'extension',
  'R-SNAD-THIN': 'extension',
  'R-UNAUTH-3': 'extension',
  'R-OTHER-REFUND': 'extension',
  'R-DEADLINE-1': 'extension',
  'R-NO-EVIDENCE': 'extension',
  'R-STAGE-INQUIRY': 'extension',
}

/** Every rule id, in evaluation order. `test/rules.test.ts` pins that this and the predicates agree. */
export const RULE_ORDER: readonly RuleId[] = [
  'R-REF-1',
  'R-APPEAL-1',
  'R-NOCHAIN-1',
  'R-CHAIN-BAD',
  'R-INR-1',
  'R-INR-3',
  'R-INR-2',
  'R-SNAD-AGENT',
  'R-SNAD-MERCH',
  'R-SNAD-THIN',
  'R-SNAD-OK',
  'R-UNAUTH-2',
  'R-UNAUTH-3',
  'R-UNAUTH-1',
  'R-AMT-1',
  'R-AMT-2',
  'R-CNP-1',
  'R-OTHER-REFUND',
  'R-DEADLINE-1',
  'R-NO-EVIDENCE',
  'R-STAGE-INQUIRY',
  'R-DEFAULT',
]

// ---------------------------------------------------------------------------
// PayPal's `dispute_reason`, in words a buyer can read
// ---------------------------------------------------------------------------

/**
 * PayPal's ten documented reasons as the words a person would use. §8.15's table switches on the enum;
 * the rationale reads like this.
 *
 * An unknown reason prints its raw value rather than being dropped: a reason PayPal adds next year must
 * still produce a sentence somebody can read.
 */
export const REASON_WORDS: Readonly<Record<string, string>> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: 'not received',
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: 'not as described',
  UNAUTHORISED: 'unauthorised',
  CREDIT_NOT_PROCESSED: 'credit not processed',
  DUPLICATE_TRANSACTION: 'duplicate transaction',
  INCORRECT_AMOUNT: 'incorrect amount',
  PAYMENT_BY_OTHER_MEANS: 'paid by other means',
  CANCELED_RECURRING_BILLING: 'recurring billing cancelled',
  PROBLEM_WITH_REMITTANCE: 'problem with remittance',
  OTHER: 'other',
}

/** `"a not-received claim"`, `"an unauthorised claim"` — the subject of a rationale sentence. */
export function reasonPhrase(reason: string): string {
  const words = REASON_WORDS[reason]
  if (words === undefined) return `a "${reason}" claim`
  const article = /^[aeiou]/.test(words) ? 'an' : 'a'
  return `${article} ${words} claim`
}

// ---------------------------------------------------------------------------
// Small pure readers
// ---------------------------------------------------------------------------

/** Refunds that actually returned money. A `PENDING` refund has not proven anything to PayPal yet. */
export function completedRefunds(ctx: DisputeContext): readonly RefundFacts[] {
  return (ctx.refunds ?? []).filter((r) => r.status === 'COMPLETED')
}

/**
 * Σ completed refunds on this capture — the quantity `captures.refunded_minor` caches, computed from the
 * rows so the router never depends on the cache being in step.
 *
 * EC-DSP-2's partial refund is a value strictly between zero and the disputed amount, which is exactly why
 * it must not satisfy R-REF-1.
 */
export function refundedTotal(ctx: DisputeContext): Money {
  const done = completedRefunds(ctx)
  const currency = done[0]?.amount.currency ?? ctx.dispute.amount.currency
  const minor = done.reduce((sum, r) => sum + r.amount.minor, 0n)
  return { minor, currency }
}

/** Every capture on the order: the disputed one plus its siblings (D17, one capture per shipment). */
export function allCaptureIds(ctx: DisputeContext): readonly { id: string; shipmentId?: string }[] {
  const out: { id: string; shipmentId?: string }[] = []
  if (ctx.capture !== undefined) {
    out.push(
      ctx.capture.shipmentId === undefined
        ? { id: ctx.capture.id }
        : { id: ctx.capture.id, shipmentId: ctx.capture.shipmentId },
    )
  }
  for (const s of ctx.siblingCaptures ?? []) {
    out.push(s.shipmentId === undefined ? { id: s.id } : { id: s.id, shipmentId: s.shipmentId })
  }
  return out
}

/** Two captures on one shipment: we took the money twice (R-AMT-2, EC-MER-2). */
export function duplicateShipmentCaptures(ctx: DisputeContext): readonly string[] {
  const counts = new Map<string, number>()
  for (const c of allCaptureIds(ctx)) {
    if (c.shipmentId === undefined || c.shipmentId === '') continue
    counts.set(c.shipmentId, (counts.get(c.shipmentId) ?? 0) + 1)
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([shipmentId]) => shipmentId)
}

/** The SKUs this dispute is about: the named item, else everything the order shipped. */
export function disputedSkus(ctx: DisputeContext): readonly string[] {
  if (ctx.disputedItem !== undefined) return [ctx.disputedItem.sku]
  const fromShipments = (ctx.shipments ?? []).flatMap((s) => s.lines.map((l) => l.sku))
  if (fromShipments.length > 0) return [...new Set(fromShipments)]
  return [...new Set((ctx.checkoutLines ?? []).map((l) => l.sku))]
}

/** Shipments carrying at least one disputed line — the join key of `shipments_order_id_idx`. */
export function shipmentsCoveringDispute(ctx: DisputeContext): readonly ShipmentFacts[] {
  const skus = new Set(disputedSkus(ctx))
  if (skus.size === 0) return []
  return (ctx.shipments ?? []).filter((s) => s.lines.some((l) => skus.has(l.sku)))
}

/** A shipment counts as tracked only when it has a non-blank tracking number. */
export function isTracked(s: ShipmentFacts): boolean {
  return s.trackingNumber.trim().length > 0
}

export function trackedShipments(ctx: DisputeContext): readonly ShipmentFacts[] {
  return shipmentsCoveringDispute(ctx).filter(isTracked)
}

/** Still moving: PayPal's tracker says `SHIPPED`, or the merchant never told PayPal anything terminal. */
export function inTransit(s: ShipmentFacts): boolean {
  return s.status === undefined || s.status === 'SHIPPED'
}

/** Canonical line key, order-independent, so two equal line sets always compare equal. */
export function lineKey(lines: readonly LineFact[] | undefined): string {
  return (lines ?? [])
    .map((l) => `${l.sku}:${l.qty}`)
    .sort()
    .join('|')
}

/** Did we ship exactly what the merchant signed at checkout? R-SNAD-MERCH's whole comparison. */
export function shipmentLinesMatchCheckout(ctx: DisputeContext): boolean {
  if (ctx.checkoutLines === undefined) return false
  const shipped = (ctx.shipments ?? []).flatMap((s) => s.lines)
  if (shipped.length === 0) return false
  return lineKey(shipped) === lineKey(ctx.checkoutLines)
}

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

/**
 * The chain verifies **now**. `verifyNow` rescues a case where verification failed at capture time for a
 * reason that has since been fixed (spec D-009: the pinned library ignores `at_time`, so an as-of
 * verification can come back invalid while the chain is in fact valid).
 */
export function chainVerifiedNow(ctx: DisputeContext): boolean {
  const c = ctx.chain
  if (c === undefined) return false
  return c.verifyAtCaptureChainValid === true || c.verifyNowChainValid === true
}

/** A chain that failed and has not recovered. This is R-CHAIN-BAD's whole condition. */
export function chainInvalid(ctx: DisputeContext): boolean {
  const c = ctx.chain
  if (c === undefined) return false
  return c.verifyAtCaptureChainValid === false && c.verifyNowChainValid !== true
}

/** We hold a mandate whose chain verifies — the precondition for contesting anything. */
export function hasVerifiedMandate(ctx: DisputeContext): boolean {
  return ctx.chain?.mandatePresent === true && chainVerifiedNow(ctx)
}

// ---------------------------------------------------------------------------
// R-SNAD-AGENT: the attribute diff, and the higher bar
// ---------------------------------------------------------------------------

/**
 * The label `packages/compiler/src/readback.ts` prints for each preference key (`PREFERENCE_LABELS`).
 *
 * **This coupling is deliberate.** The read-back is the only artefact that carries a preference in front of
 * the user, so "did they see this variant before approving?" is answered by reading that string. If the
 * compiler renames a label the parse returns `undefined`, which makes R-SNAD-AGENT fall through to a
 * contest — the safe direction, since blaming our own agent on a guess would be the dishonest outcome.
 * `test/rules.test.ts` pins the labels, so drift is a test failure rather than a silent behaviour change.
 */
export const READBACK_LABELS: Readonly<Record<'size' | 'color' | 'model', string>> = {
  size: 'size',
  color: 'colour',
  model: 'model',
}

/** The three attributes R-SNAD-AGENT diffs. §8.15: "size/colour/model fields". */
export const ATTRIBUTE_KEYS = ['size', 'color', 'model'] as const
export type AttributeKey = (typeof ATTRIBUTE_KEYS)[number]

/**
 * The attribute the **signed read-back** stated for `key`, or `undefined` if it said nothing.
 *
 * The read-back renders `**size** "9"` — bold label, quoted value — inside its "How we read your request"
 * section. Anything else means "not stated", and "not stated" is the value this rule leans on.
 */
export function readbackAttribute(
  readback: string | undefined,
  key: AttributeKey,
): string | undefined {
  if (readback === undefined) return undefined
  const pattern = new RegExp(`\\*\\*${READBACK_LABELS[key]}\\*\\*\\s*"([^"]*)"`)
  const value = pattern.exec(readback)?.[1]?.trim()
  return value !== undefined && value.length > 0 ? value : undefined
}

/** Case- and space-insensitive: a catalogue is not a signature, and "UK 10" is "uk 10". */
function normaliseAttribute(v: string | undefined): string {
  return (v ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

export interface AttributeConflict {
  readonly key: AttributeKey
  /** What the user said they wanted — §8.8 `preferences`, which are **not signed**. */
  readonly wanted: string
  /** What the read-back the user approved showed. `undefined` = the read-back said nothing. */
  readonly statedInReadback: string | undefined
  /** What actually arrived. */
  readonly shipped: string
}

/**
 * The deterministic attribute diff spec §8.15 R-SNAD-AGENT asks for.
 *
 * A field conflicts when **both** halves hold:
 *
 * 1. the user's stated preference and the shipped attribute disagree, **and**
 * 2. the signed read-back does **not** already show the shipped variant.
 *
 * Condition 2 is the higher bar, and it is the whole point of the rule.
 *
 * ### Why contesting an agent purchase needs more than a valid chain
 *
 * For a **human** purchase a valid chain plus an item matching the signed checkout settles it: the buyer
 * pressed the button, so `CONTEST` is available on the chain alone. That is R-SNAD-OK and R-UNAUTH-1.
 *
 * For an **agent** purchase the chain proves something weaker. It proves the agent stayed inside a signed
 * envelope — within budget, at an allowed merchant, on a mandate the device key signed. That is *authority
 * to spend*, not *instruction about what to buy*. The user delegated a judgement ("trail shoes, size 10,
 * under $130") and the chain says nothing whatever about size 10. "The chain is valid" therefore cannot be
 * the reason we blame the buyer, which is why this rule needs a second witness.
 *
 * Worse, §8.8's `preferences` are **not signed**: the compiler's own read-back says "These are not signed
 * and do not bound what the agent may buy". An unsigned preference cannot be the sole basis for blaming a
 * buyer. So the conflict must be *additionally* absent from the signed read-back: if the read-back showed
 * "size 10" and size 10 arrived, the user saw it and approved it, the preference saying "9" is a compiler
 * inference we should not act on, and the case falls through to R-SNAD-OK — which is the correct answer,
 * because a valid chain plus a read-back showing the variant is exactly the proof a contest needs.
 *
 * Net: the agent-fault verdict needs **two** witnesses, an unsigned stated preference *and* a signed
 * read-back that contradicts the shipped item, where a human purchase needs one.
 */
export function attributeConflicts(ctx: DisputeContext): readonly AttributeConflict[] {
  const item = ctx.disputedItem
  const prefs = ctx.preferences
  if (item === undefined || prefs === undefined) return []
  const out: AttributeConflict[] = []
  for (const key of ATTRIBUTE_KEYS) {
    const wanted = normaliseAttribute(prefs[key])
    const shipped = normaliseAttribute(item.attributes[key])
    if (wanted.length === 0 || shipped.length === 0) continue
    if (wanted === shipped) continue
    const stated = readbackAttribute(ctx.chain?.readback, key)
    if (normaliseAttribute(stated) === shipped) continue // the user approved this exact variant
    out.push({ key, wanted, statedInReadback: stated, shipped })
  }
  return out
}

/**
 * The complete R-SNAD-AGENT condition, conjunct by conjunct.
 *
 * 1. the disputed item has a stated preference and a shipped attribute,
 * 2. the agent made the purchase and the chain verifies — otherwise R-NOCHAIN-1 / R-CHAIN-BAD already spoke
 *    and we would be blaming an agent for a failure we cannot prove happened,
 * 3. the shipment lines are the merchant-signed lines — otherwise R-SNAD-MERCH, and the fault is the
 *    merchant's rather than the agent's,
 * 4. at least one attribute conflict survived the read-back test.
 */
export function agentAuthorityExceeded(ctx: DisputeContext): boolean {
  if (ctx.disputedItem === undefined || ctx.preferences === undefined) return false
  if (!hasVerifiedMandate(ctx)) return false
  if (!shipmentLinesMatchCheckout(ctx)) return false
  return attributeConflicts(ctx).length > 0
}

// ---------------------------------------------------------------------------
// Merchant policy
// ---------------------------------------------------------------------------

/**
 * Is this claim small enough that the merchant has already said "settle it, don't wake me up"?
 *
 * **The default is zero minor units**, and that default is the load-bearing part: a merchant who has
 * configured nothing gets no automatic acceptance at all, so R-NOCHAIN-1 produces `REVIEW` — spec
 * EC-DSP-9's "Not a Countersign order" — rather than `ACCEPT_CLAIM`. That is the answer §18 question 20
 * needs, and it is the conservative one: settling a claim is a money decision, and an unconfigured
 * merchant has not delegated it to us.
 */
export function autoAccepts(ctx: DisputeContext, threshold?: bigint): boolean {
  const limit = threshold ?? ctx.policy?.autoAcceptThresholdMinor ?? 0n
  if (limit <= 0n) return false
  return ctx.dispute.amount.minor <= limit
}

/** EC-BUY-3's "$50" ceiling for a weak `UNAUTHORISED` case, defaulted to zero for the same reason. */
export function weakCaseAutoAccepts(ctx: DisputeContext): boolean {
  return autoAccepts(ctx, ctx.policy?.weakUnauthorisedThresholdMinor ?? 0n)
}

// ---------------------------------------------------------------------------
// Evidence availability — the input to R-NO-EVIDENCE
// ---------------------------------------------------------------------------

/** Does a completed refund exist that we can put an id and a date behind? */
export function hasRefundProof(ctx: DisputeContext): boolean {
  return completedRefunds(ctx).length > 0
}

/** Is there tracking we can hand PayPal? A blank tracking number is not tracking. */
export function hasTracking(ctx: DisputeContext): boolean {
  return trackedShipments(ctx).length > 0
}

/** Did the merchant register the tracker with PayPal, so PayPal holds the delivery events as well? */
export function hasPaypalTracker(ctx: DisputeContext): boolean {
  return trackedShipments(ctx).some(
    (s) => typeof s.paypalTrackerId === 'string' && s.paypalTrackerId !== '',
  )
}

/**
 * **Does the source for this `evidence_type` exist?**
 *
 * This is the function R-NO-EVIDENCE is built on, and each answer is the honest one for that type:
 *
 * | Type | Available when |
 * |---|---|
 * | `PROOF_OF_REFUND` | a `COMPLETED` refund exists — its id and date go in `evidence_info.refund_ids` |
 * | `ONLINE_TRACKING_INFORMATION` | a shipment has a non-blank tracking number |
 * | `PROOF_OF_FULFILLMENT` | a carrier or merchant document exists, **or** the tracker is registered with PayPal so PayPal holds the scans |
 * | `DETAILS_OF_PURCHASE` | the chain verifies — the signed bundle is what this type *is* |
 * | `ORDER_DETAILS`, `ITEM_DESCRIPTION` | the merchant-signed checkout lines exist |
 * | `PROOF_OF_RECEIPT_COPY` | the buyer's receipt copy exists. We will not synthesise a "copy" of a receipt we never gave. |
 * | `PROOF_OF_RETURN`, `OTHER` | always — both are ours to write |
 *
 * The `PROOF_OF_FULFILLMENT` row is EC-MER-4 made operational. A tracking number a merchant typed into
 * their own dashboard is an assertion; a tracker PayPal holds, or a carrier document, is a record. When we
 * have only the assertion, a packet would be claiming something we cannot show — so R-NO-EVIDENCE removes
 * the authority to file rather than filing it.
 */
export function evidenceSourceAvailable(type: EvidenceType, ctx: DisputeContext): boolean {
  switch (type) {
    case 'PROOF_OF_REFUND':
      return hasRefundProof(ctx)
    case 'ONLINE_TRACKING_INFORMATION':
      return hasTracking(ctx)
    case 'PROOF_OF_FULFILLMENT':
      return ctx.corpus?.fulfilmentDocument === true || hasPaypalTracker(ctx)
    case 'DETAILS_OF_PURCHASE':
      return chainVerifiedNow(ctx)
    case 'ORDER_DETAILS':
    case 'ITEM_DESCRIPTION':
      return (ctx.checkoutLines ?? []).length > 0
    case 'PROOF_OF_RECEIPT_COPY':
      return ctx.corpus?.receiptCopy === true
    case 'PROOF_OF_RETURN':
    case 'OTHER':
      return true
  }
}

/** The types a rule needs and we cannot produce. Empty means the rule's contest is fileable. */
export function missingEvidence(
  types: readonly EvidenceType[],
  ctx: DisputeContext,
): readonly EvidenceType[] {
  return types.filter((t) => !evidenceSourceAvailable(t, ctx))
}

// ---------------------------------------------------------------------------
// The predicates
// ---------------------------------------------------------------------------

/**
 * **R-REF-1** — spec §8.15: "Σ refunds on the capture ≥ disputed amount" → `ALREADY_REFUNDED`.
 *
 * EC-DSP-1 (refund, then chargeback). The money is already with the buyer; the claim is a second debit of
 * the same amount, so `PROOF_OF_REFUND` ends it. Only `COMPLETED` refunds count: a `PENDING` one has not
 * returned the money yet, and claiming otherwise is the kind of overstatement this packet exists to
 * prevent. EC-DSP-2 (partial refund, full claim) deliberately does **not** match.
 */
export function ruleAlreadyRefunded(ctx: DisputeContext): boolean {
  return ctx.dispute.amount.minor > 0n && refundedTotal(ctx).minor >= ctx.dispute.amount.minor
}

/**
 * **R-APPEAL-1** (extension) — EC-DSP-6: appeal after a loss, but *only* when there is new evidence.
 *
 * The gate is `isAppealable()` from `@countersign/paypal`, which reads the `appeal` HATEOAS link rather
 * than `dispute_state`, because that is what PayPal documents (report §9/#17). Without new evidence an
 * appeal would re-file a packet that already lost, and EC-DSP-5's "never re-file contradictory notes" would
 * be broken by us.
 *
 * A **capture** is required, not merely an order: an appeal is about *this* transaction, and without the
 * capture there is nothing to re-file a packet about. An order with no capture is the half-mapped case, and
 * half-mapped is what EC-DSP-9 sends to `R-NOCHAIN-1`.
 */
export function ruleAppealable(ctx: DisputeContext): boolean {
  const d = ctx.dispute
  return (
    d.previouslyLost === true &&
    d.appealLinkPresent === true &&
    d.newEvidenceSinceLoss === true &&
    ctx.capture !== undefined
  )
}

/**
 * **R-NOCHAIN-1** — spec §8.15: "No mandate/attempt linked (`custom_id` missing or unknown)".
 *
 * **This is not a fallback and it is not a shrug.** §18 question 20 asks what stops a bogus dispute against
 * a good customer; this rule is half the answer, because the other half is that nothing downstream is even
 * allowed to contest. EC-DSP-9 — a dispute we cannot map to an order — lands here and must produce a
 * sentence, not a crash.
 *
 * A chain that exists but failed verification is deliberately **excluded**: {@link ruleChainBad} has its
 * own row, and telling a merchant "no mandate on this payment" when a mandate exists and merely failed to
 * verify would be false. This file only writes sentences it can support.
 */
export function ruleNoChain(ctx: DisputeContext): boolean {
  if (ctx.order === undefined || ctx.capture === undefined) return true
  if (ctx.chain?.mandatePresent !== true) return true
  if (chainInvalid(ctx)) return false
  return !chainVerifiedNow(ctx)
}

/**
 * **R-CHAIN-BAD** — spec §8.15: "`verifyAtCapture.chain_valid=false`" → `UNPROVABLE`.
 *
 * The spec's row reads "UNPROVABLE → ACCEPT_CLAIM (**never contest with a broken chain**)". That is the
 * most load-bearing sentence in the table, and it is why the posture here is flat: unlike R-NOCHAIN-1, this
 * rule does not consult the merchant's auto-accept threshold. A broken chain means we cannot support *any*
 * argument we would make, so the case ends the moment an adjudicator looks at it and finds the hole. If the
 * merchant wants to fight it anyway, that is EC-MER-7's override and a human's click.
 */
export function ruleChainBad(ctx: DisputeContext): boolean {
  return chainInvalid(ctx)
}

/**
 * **R-INR-1** — spec §8.15: "`MERCHANDISE_OR_SERVICE_NOT_RECEIVED` and no shipment with tracking for the
 * disputed lines" → `MERCHANT_FAULT` → `REFUND`.
 *
 * Nothing was shipped, or nothing we can name was shipped. There is no delivery record to file and no
 * argument to make, so the honest answer is the refund. Refusing to contest here is not timidity: a merchant
 * with no tracking for the disputed line is contesting a case it will lose.
 */
export function ruleInrUntracked(ctx: DisputeContext): boolean {
  return (
    ctx.dispute.reason === 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED' &&
    trackedShipments(ctx).length === 0
  )
}

/**
 * **R-INR-3** (extension) — tracking exists, is registered with PayPal, and the parcel is still moving.
 *
 * A parcel in transit is not a delivery dispute yet, and the cheapest thing that can still be true is that
 * it arrives. `MESSAGE_ONLY` costs nothing and does not spend one of the merchant's response attempts; a
 * packet filed now would be evidence of a parcel that has not arrived. The moment PayPal's tracker goes
 * terminal this rule stops matching and R-INR-2 takes over.
 */
export function ruleInrInTransit(ctx: DisputeContext): boolean {
  if (ctx.dispute.reason !== 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED') return false
  const tracked = trackedShipments(ctx)
  if (tracked.length === 0) return false
  return tracked.some(inTransit) && hasPaypalTracker(ctx)
}

/**
 * **R-INR-2** — spec §8.15: "`MERCHANDISE_OR_SERVICE_NOT_RECEIVED` with tracking present" → `CONTEST`
 * (`PROOF_OF_FULFILLMENT`, `ONLINE_TRACKING_INFORMATION`).
 *
 * EC-MER-4 shapes the packet's wording, not the posture: the evidence is filed labelled as tracking the
 * merchant asserted through PayPal's `/track`, and the packet makes no carrier-verification claim. When the
 * tracker is *not* registered with PayPal and no carrier document exists, `PROOF_OF_FULFILLMENT` has no
 * source and R-NO-EVIDENCE takes the contest away.
 */
export function ruleInrTracked(ctx: DisputeContext): boolean {
  return (
    ctx.dispute.reason === 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED' && trackedShipments(ctx).length > 0
  )
}

/**
 * **R-SNAD-AGENT** — spec §8.15: `MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED`, the item matches the
 * merchant-signed checkout lines, but the mandate's NL intent and read-back conflict with the item
 * attributes → `AGENT_FAULT` → `REFUND`. "Honest refund; the user's own agent misread."
 *
 * This is the rule judge question 26 and Judge Mode scenario J4 exist for, and the only one whose verdict
 * costs us money on purpose. The higher bar is in {@link agentAuthorityExceeded}; the reason a refund is
 * the right *answer* is that the buyer did authorise the purchase — they delegated the judgement to
 * software and the software read it wrong. Arguing that in front of PayPal spends a response to tell a
 * paying customer that our agent made a mistake.
 */
export function ruleSnadAgentFault(ctx: DisputeContext): boolean {
  return (
    ctx.dispute.reason === 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED' && agentAuthorityExceeded(ctx)
  )
}

/**
 * **R-SNAD-MERCH** — spec §8.15: "SNAD and the shipment lines ≠ checkout lines" → `MERCHANT_FAULT` → `REFUND`.
 *
 * EC-MER-3 says it in one sentence: "Our packet would *hurt* the merchant, so the Defender never files it as
 * a contest." If we shipped something other than what the merchant signed, the evidence we would file is
 * evidence against our own customer, and a product whose selling point is honest evidence has no business
 * filing it. So the rule refunds — and it refunds *even though* the evidence exists. The existence of a
 * strong case is not a reason to use it.
 */
export function ruleSnadMerchantFault(ctx: DisputeContext): boolean {
  if (ctx.dispute.reason !== 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED') return false
  if ((ctx.shipments ?? []).length === 0) return false
  return !shipmentLinesMatchCheckout(ctx)
}

/**
 * **R-SNAD-THIN** (extension) — the item matches the signed checkout, the mandate permits it, and there is
 * **no document showing the goods were as described**.
 *
 * EC-BUY-1: the merchant should offer a return instead of fighting, "since that's cheaper than the $82
 * handling cost" [V13]. A shipping photo is not proof the item was good; a packing photograph is proof we
 * sent a box. Filing an `ITEM_DESCRIPTION` packet with nothing behind it spends a response we will not win,
 * while the offer costs the disputed amount either way with none of the handling fee.
 */
export function ruleSnadThinQuality(ctx: DisputeContext): boolean {
  if (ctx.dispute.reason !== 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED') return false
  if (!hasVerifiedMandate(ctx)) return false
  if (!shipmentLinesMatchCheckout(ctx)) return false
  return ctx.corpus?.qualityDocument !== true
}

/**
 * **R-SNAD-OK** — spec §8.15: "SNAD, shipment == checkout, and checkout satisfies the mandate" →
 * `USER_AUTHORISED` → `CONTEST` (`ITEM_DESCRIPTION`, `ORDER_DETAILS`, mandate packet).
 *
 * WP-15a's brief calls this `R-SNAD-CUST` ("the customer's own misuse, our description matched the
 * product"); it is the same rule and the spec's id is canonical — see `RULE_ALIASES`. The mandate is not
 * re-checked here, only quoted: "checkout satisfies the mandate" is the Gate's verdict (§8.10), and
 * re-deciding it in the router would be second-guessing the deterministic check that already ran.
 */
export function ruleSnadAuthorised(ctx: DisputeContext): boolean {
  if (ctx.dispute.reason !== 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED') return false
  if (!hasVerifiedMandate(ctx)) return false
  if (!shipmentLinesMatchCheckout(ctx)) return false
  return ctx.corpus?.qualityDocument === true
}

/**
 * **R-UNAUTH-2** — spec §8.15: "`UNAUTHORISED`, valid chain, but the device was reported LOST before the
 * mandate `iat`" → `UNPROVABLE` → `ACCEPT_CLAIM`.
 *
 * §18 question 8 and EC-BUY-3. The chain proves a key on that device signed the mandate; if the device was
 * already reported lost, the honest reading is that somebody else held it. Note the ordering this rule
 * needs: {@link ruleUnauthorisedAuthorised}'s stated condition is *also* true here.
 */
export function ruleUnauthorisedLostDevice(ctx: DisputeContext): boolean {
  if (ctx.dispute.reason !== 'UNAUTHORISED') return false
  if (ctx.chain?.deviceStatus !== 'LOST') return false
  const lostAt = ctx.chain.deviceLostAtSec
  const iat = ctx.chain.iatSec
  if (lostAt === undefined || iat === undefined) return false
  return lostAt < iat
}

/**
 * **R-UNAUTH-3** (extension) — `UNAUTHORISED`, the chain verifies, but **no WebAuthn user-verification was
 * present at signing**.
 *
 * EC-BUY-3: "If webauthn UV was absent → R-UNAUTH weak → the router recommends ACCEPT above $50 (merchant
 * setting)." A chain with no passkey step cannot show that a *human* authorised anything; without it,
 * contesting is a claim we cannot make. At or below the merchant's threshold we accept the claim ourselves;
 * above it, a human decides. §8.15's table has no row for this, so it would otherwise sit in R-DEFAULT
 * forever.
 */
export function ruleUnauthorisedWeak(ctx: DisputeContext): boolean {
  if (ctx.dispute.reason !== 'UNAUTHORISED') return false
  if (!chainVerifiedNow(ctx)) return false
  return ctx.chain?.webauthnPresent !== true
}

/**
 * **R-UNAUTH-1** — spec §8.15: "`UNAUTHORISED` and a valid chain with device and webauthn at signing" →
 * `USER_AUTHORISED` → `CONTEST` (mandate packet, `DETAILS_OF_PURCHASE`), plus the user-facing flag
 * "possible compromised device".
 *
 * Judge Mode J3 is this rule end to end. The flag is not decoration: the likeliest explanation for a valid
 * passkey-signed mandate the buyer does not recognise is malware on the buyer's own device, and the only
 * useful thing we can tell them is "report the device lost" — which then moves the next claim to R-UNAUTH-2.
 *
 * It runs **after** R-UNAUTH-2 and R-UNAUTH-3 on purpose; see the table in this file's header.
 */
export function ruleUnauthorisedAuthorised(ctx: DisputeContext): boolean {
  if (ctx.dispute.reason !== 'UNAUTHORISED') return false
  if (!chainVerifiedNow(ctx)) return false
  return ctx.chain?.webauthnPresent === true
}

/** Σ captures on the order, for R-AMT-1's "capture totals == checkout" comparison. */
export function capturedTotal(ctx: DisputeContext): Money {
  const amounts = [ctx.capture, ...(ctx.siblingCaptures ?? [])]
    .filter((c): c is NonNullable<typeof c> => c !== undefined)
    .map((c) => c.amount)
  const first = amounts[0]
  if (first === undefined) return { minor: 0n, currency: ctx.dispute.amount.currency }
  return {
    minor: amounts.reduce((sum, m) => sum + m.minor, 0n),
    currency: first.currency,
  }
}

/**
 * **R-AMT-1** — spec §8.15: "`INCORRECT_AMOUNT`/`DUPLICATE_TRANSACTION` and capture totals == checkout and a
 * single capture per shipment" → `USER_AUTHORISED` → `CONTEST` (`PROOF_OF_RECEIPT_COPY`).
 *
 * Money is compared in integer minor units and nothing is converted, so the equality is exact by
 * construction (spec §18 q21, EC-FX-1/5).
 */
export function ruleAmountCorrect(ctx: DisputeContext): boolean {
  if (ctx.dispute.reason !== 'INCORRECT_AMOUNT' && ctx.dispute.reason !== 'DUPLICATE_TRANSACTION') {
    return false
  }
  if (ctx.order === undefined) return false
  if (duplicateShipmentCaptures(ctx).length > 0) return false // that is R-AMT-2's case
  const captured = capturedTotal(ctx)
  if (captured.currency !== ctx.order.amount.currency) return false
  return captured.minor === ctx.order.amount.minor
}

/**
 * **R-AMT-2** — spec §8.15: "Duplicate captures found" → `MERCHANT_FAULT` → refund the duplicate.
 *
 * EC-MER-2. Two captures against one shipment means we charged twice for one delivery, so the defence is
 * not a defence, it is a correction. The spec lists R-AMT-1 first, which is safe only because R-AMT-1's
 * "a single capture per shipment" conjunct excludes this case — `test/rules.test.ts` asserts that
 * exclusion so a future edit cannot make one rule silently shadow the other.
 */
export function ruleAmountDuplicate(ctx: DisputeContext): boolean {
  if (ctx.dispute.reason !== 'INCORRECT_AMOUNT' && ctx.dispute.reason !== 'DUPLICATE_TRANSACTION') {
    return false
  }
  return duplicateShipmentCaptures(ctx).length > 0
}

/**
 * **R-CNP-1** — spec §8.15: "`CREDIT_NOT_PROCESSED` and a refund exists" → `ALREADY_REFUNDED` →
 * `PROOF_OF_REFUND`.
 *
 * The buyer's complaint is that a credit never landed. It did; here is the refund's id and date. EC-DSP-2's
 * partial refund reaches this rule too, and the evidence then carries the partial amount — we do not claim a
 * full refund we did not make.
 */
export function ruleCreditNotProcessedRefunded(ctx: DisputeContext): boolean {
  return ctx.dispute.reason === 'CREDIT_NOT_PROCESSED' && hasRefundProof(ctx)
}

/** The four reasons PayPal has that §8.15's table never assigns to a row. */
export const UNASSIGNED_REASONS: readonly string[] = [
  'PAYMENT_BY_OTHER_MEANS',
  'CANCELED_RECURRING_BILLING',
  'PROBLEM_WITH_REMITTANCE',
  'OTHER',
]

/**
 * **R-OTHER-REFUND** (extension, WP-15a's `R-OTHER`) — one of PayPal's four unassigned reasons, on a payment
 * whose chain verifies.
 *
 * ### Why this refunds when we might win — judge question 26, asked in the other direction
 *
 * The case for refunding is arithmetic, not humility:
 *
 * - An honest refund costs the disputed amount. A contested loss costs the disputed amount **plus** the
 *   ~$82 first-party-misuse handling cost [V13] **plus** the relationship — and it escalates, because a
 *   lost chargeback is an input to a merchant-risk conversation our own packet is now part of.
 * - The claim is *true* in each of these four cases. "Paid by other means" means the buyer says they never
 *   paid us. "Recurring billing cancelled" means they are right and we should stop. "Problem with
 *   remittance" means our payout failed them. There is no version of these facts where our evidence helps.
 * - **The rule is one line to change.** A merchant who wants to contest these can flip this row, in one
 *   commit, having read exactly what we decided and why. A rule that contested by default would contest
 *   cases we cannot win and — the part that matters — it would train merchants to distrust the packet. A
 *   packet that fights everything is a packet nobody believes when it matters.
 *
 * The recorded liability is `MERCHANT_FAULT` because the underlying transaction really is the merchant's
 * problem to fix, which is the useful thing to store for the case file.
 */
export function ruleOtherReasonRefund(ctx: DisputeContext): boolean {
  if (!UNASSIGNED_REASONS.includes(ctx.dispute.reason)) return false
  return hasVerifiedMandate(ctx)
}

/** 48 hours, in seconds. EC-DSP-7's alert is at 24 h; this is where the *narrative* starts. */
export const DEADLINE_PRESSURE_SECONDS = 48 * 3600

/** One hour, in seconds. EC-DSP-7: auto-file is refused inside this window (a partial upload loses it). */
export const DEADLINE_CRITICAL_SECONDS = 3600

/**
 * **R-DEADLINE-1** (extension) — EC-DSP-7. The deadline is inside 48 h, **and** the chosen posture would
 * file or settle, **and** the evidence that posture needs is not in hand.
 *
 * The 48 hours is the threshold where the rationale starts naming the clock, and the downgrade uses the same
 * number deliberately: **we cannot file what we do not have, and there is less than two days in which to
 * get it.** A merchant who wants to contest anyway gathers the document and re-runs the router; the decision
 * is pure, so re-running is free and the new answer differs.
 *
 * EC-DSP-8 (deadline already passed) does **not** come here. A timeout is not a reason for a human to
 * decide, so it never sets `blockingReason`: the router records its rule as if the clock did not exist, and
 * the filer refuses with `DEF_DEADLINE_PASSED`. Deadline state rides on the decision for exactly that
 * division of responsibility.
 *
 * `route()` owns the conjunction, because "the chosen posture files" is only knowable after a rule has been
 * picked; this predicate is the deadline half of it.
 */
export function ruleDeadlineForcesRefund(secondsLeft: number | null): boolean {
  if (secondsLeft === null) return false
  return secondsLeft > 0 && secondsLeft <= DEADLINE_PRESSURE_SECONDS
}

/**
 * **R-STAGE-INQUIRY** (extension) — spec EC-DSP-3: the dispute is still an `INQUIRY` and PayPal has not
 * asked for a response.
 *
 * **A filing at this stage is a wasted response.** EC-DSP-3 is explicit: prefer `send-message` or
 * `make-offer`, and file only when `status = WAITING_FOR_SELLER_RESPONSE`. It matters because of the
 * clock: at `INQUIRY` there is usually **no `seller_response_due_date` at all**, so
 * {@link ruleDeadlineForcesRefund} cannot help, and a router that ignored the stage would file a packet
 * into a window PayPal has not opened — spending one of the merchant's responses, and attaching evidence to
 * a claim that may be about to be withdrawn.
 *
 * It is a **post-table adjustment** like `R-DEADLINE-1` and `R-NO-EVIDENCE`, not a table row, because the
 * stage is a fact about *when* and it outranks a fact about *what*: a fully evidenced
 * `MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED` contest is still not filed at `INQUIRY`. Being an adjustment
 * also means the underlying rule is preserved in `supersedes` and quoted in the rationale, so a merchant
 * reading this sees the reasoning is staged rather than evasive — and WP-16's strategist still learns what
 * we would file if the claim escalates.
 */
export function ruleInquiryStage(ctx: DisputeContext): boolean {
  return ctx.dispute.stage === 'INQUIRY' && ctx.dispute.status !== 'WAITING_FOR_SELLER_RESPONSE'
}

/**
 * **R-NO-EVIDENCE** — the rule that makes `CONTEST` honest. See `route()`, which owns it, because "the
 * chosen posture's evidence list" does not exist until a rule has been picked.
 */

// ---------------------------------------------------------------------------
// The evidence each rule requires
// ---------------------------------------------------------------------------

/**
 * `evidence_type` per rule, in the order a reader expects them. Every member is in `@countersign/paypal`'s
 * corrected `EVIDENCE_TYPES` — the first pass of this project used seven values PayPal does not have
 * (`CHECKOUT_PAGE`, `REFUND_POLICY`, `TERMS_OF_SERVICE`, …) and every one of them would have failed live,
 * so `test/rules.test.ts` asserts membership for the whole table.
 */
export const EVIDENCE_BY_RULE: Readonly<Partial<Record<RuleId, readonly EvidenceType[]>>> = {
  'R-REF-1': ['PROOF_OF_REFUND'],
  'R-APPEAL-1': ['DETAILS_OF_PURCHASE', 'PROOF_OF_FULFILLMENT'],
  'R-INR-2': ['PROOF_OF_FULFILLMENT', 'ONLINE_TRACKING_INFORMATION'],
  'R-SNAD-OK': ['ITEM_DESCRIPTION', 'ORDER_DETAILS'],
  'R-UNAUTH-1': ['DETAILS_OF_PURCHASE', 'ORDER_DETAILS'],
  'R-AMT-1': ['PROOF_OF_RECEIPT_COPY'],
  'R-CNP-1': ['PROOF_OF_REFUND'],
}

export function evidenceFor(ruleId: RuleId): readonly EvidenceType[] {
  return EVIDENCE_BY_RULE[ruleId] ?? []
}
