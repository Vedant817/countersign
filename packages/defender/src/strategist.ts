/**
 * The Dispute Strategist — spec **§8.16 (M16)**, **§12.11**, **§18 question 31**, work package **WP-16**.
 * Acceptance **AT-M16.1**.
 *
 * ```ts
 * const proposal = await proposeStrategy(ctx, decision, { priorOffers: [] })
 * // proposal.value.action, .amount, .cost, .reason, .copy
 * ```
 *
 * ## What it is for
 *
 * §8.16: *"The LLM proposes the **next action** for non-filing states: offer partial (`make-offer`), message
 * the buyer, acknowledge return, appeal (when `dispute_state=APPEALABLE` [B16]), or provide supporting
 * info."* Every proposal shows its expected cost, and every action needs a merchant click.
 *
 * ## Spec question 31's answer: it may only act within the posture it was given
 *
 * "Merchant games the evidence?" is answered in three parts across this package, and this file is the third:
 *
 * 1. The router's posture is a deterministic value produced by a rules table with no model in it.
 * 2. The filer's upload gate is a **type** ({@link EvidenceUploadPermit} in `filer.ts`), so nothing can widen
 *    what gets attached.
 * 3. **This file's PayPal vocabulary is bounded by the posture in two independent ways:**
 *
 *    - {@link STRATEGIST_ACTIONS_BY_POSTURE} — a frozen table, applied in {@link permittedActionsFor}.
 *    - {@link StrategistPayPalMethod} — **a union that does not contain `provideEvidence`.**
 *
 * That second point is the load-bearing one, and it is a *type* rather than a check. There is no value of
 * `StrategistProposal.paypal` that names `provideEvidence`, so **no proposal this module can produce — whatever
 * a model returns, however malformed — can reach an evidence upload.** A hostile answer saying "file evidence"
 * is dropped as an unknown action and reported in `warnings`; the surviving candidates are then re-ranked
 * deterministically.
 *
 * The converse is worth stating too: the strategist **cannot lower a posture either.** `REFUND`'s permitted list
 * is empty, so there is nothing for it to propose — the money movement is the filer's, and §8.15 already
 * decided it.
 *
 * ## Pure by construction, and exactly where the model goes
 *
 * {@link proposeStrategyDeterministic} is a pure function of `(ctx, decision, options)` — no clock, no I/O, no
 * randomness — and it is the **default and the fallback**. {@link proposeStrategy} adds one thing: an optional
 * `llm` may offer **ranked candidates**, and each candidate is then (a) validated with zod (AT-M16.1),
 * (b) filtered through the posture table, and (c) re-ranked deterministically. A model outage, a malformed
 * answer, and no key at all all leave the deterministic proposal standing, so `docs/HUMAN_TODO.md` H-02 cannot
 * affect a single test in this package.
 *
 * ## The offer arithmetic, and why it is `allocate()`
 *
 * §8.16's partial offer must be an **exact `Money`**, and `Σ offers + prior refunds` must not exceed the
 * capture. Both come from integer minor units and nothing else:
 *
 * - {@link offerBudget} subtracts `completedRefunds(ctx)` — the same reader R-REF-1 used, so the strategist
 *   and the router cannot disagree about what has already been returned — and every prior offer.
 * - {@link partialOfferAmount} expresses "a share of what is left" as **two integer weights**, never a float
 *   and never a percentage string: `allocate(remaining, [BigInt(numerator), BigInt(denominator − numerator)])[0]`.
 *   `allocate` is `@countersign/core`'s largest-remainder split over `bigint`, so the offer and its complement
 *   sum to `remaining` exactly.
 * - A `remaining` of zero, or a share that rounds to zero, is **refused rather than clamped**: a `$0.00` offer
 *   is a rejection, and a clamped amount is a number the merchant never agreed to.
 *
 * Returning the allocated share rather than computing `remaining * n / d` is what makes the sum exact: integer
 * division loses a minor unit on an odd amount, and the two sides then disagree by one cent — which is
 * precisely what EC-FX-4 and §18 q22 forbid.
 *
 * The brief calls core's constructor `toMoney()`. `@countersign/db` exports that name
 * (`toMoney(minor, currency)`) and `@countersign/core` exports `money(minor, currency)`; this file uses core's
 * `money` and records the naming difference rather than adding an alias to someone else's package.
 *
 * ## The cost, and the label that must travel with it
 *
 * §8.16: *"Every proposal shows its expected cost: the refund amount vs. MRC's $82 average handling cost [V13],
 * labelled as an industry average."* {@link CostBreakdown} carries the number **and** the label, and the label
 * is a **literal type** (`handlingCostIsIndustryAverage: true`), so it cannot be dropped in a refactor without
 * a `tsc` error. An $82 figure presented as Countersign's own measurement would be a fabricated statistic in a
 * product whose entire claim is that it does not fabricate.
 */

import { z } from 'zod'

import {
  allocate,
  csError,
  err,
  money,
  ok,
  type CsError,
  type Currency,
  type Money,
  type Result,
} from '@countersign/core'

import { completedRefunds } from './rules'
import type { DisputeContext, LiabilityDecision, Posture, RuleId } from './types'

// ---------------------------------------------------------------------------
// 1. The action vocabulary
// ---------------------------------------------------------------------------

/**
 * The seven next actions a strategist may propose.
 *
 * **No member of this union files evidence, accepts a claim, or moves money.** That is deliberate, and it is
 * §8.16's own list: `make-offer`, `send-message`, `acknowledge-return-item`, `appeal`,
 * `provide-supporting-info`, `escalate`, and "a human decides".
 *
 * Filing is `fileDispute`'s job on a `CONTEST` posture; a refund is the filer's on a `REFUND` posture;
 * `accept-claim` is the filer's on an `ACCEPT_CLAIM` posture. A strategist that could reach any of those would
 * be a second authority over the posture — the thing this package exists to prevent.
 */
export type StrategistAction =
  | 'MESSAGE_BUYER'
  | 'MAKE_OFFER'
  | 'ACKNOWLEDGE_RETURN'
  | 'ESCALATE'
  | 'APPEAL'
  | 'PROVIDE_SUPPORTING_INFO'
  | 'REVIEW_WITH_HUMAN'

/**
 * The PayPal method each action calls — **and `provideEvidence` is not in it.**
 *
 * This union *is* the type-level half of spec question 31's answer. Adding `provideEvidence` here would be a
 * one-word change that silently gave the strategist the evidence upload, so `test/strategist.test.ts` asserts
 * the closed set and the "no member names an upload" property.
 */
export type StrategistPayPalMethod =
  | 'sendMessage'
  | 'makeOffer'
  | 'acknowledgeReturnItem'
  | 'provideSupportingInfo'
  | 'appeal'
  | 'escalate'

/** `null` for the one action that makes no PayPal call. */
export const PAYPAL_METHOD_FOR_ACTION: Readonly<
  Record<StrategistAction, StrategistPayPalMethod | null>
> = Object.freeze({
  MESSAGE_BUYER: 'sendMessage',
  MAKE_OFFER: 'makeOffer',
  ACKNOWLEDGE_RETURN: 'acknowledgeReturnItem',
  ESCALATE: 'escalate',
  APPEAL: 'appeal',
  PROVIDE_SUPPORTING_INFO: 'provideSupportingInfo',
  REVIEW_WITH_HUMAN: null,
})

/**
 * The `PayPal-Request-Id` token for each action, from `@countersign/paypal`'s closed `DISPUTE_ACTIONS` set.
 *
 * Declared here so the mapping is one table a test can walk. `disputeActionRequestId` throws on an unknown
 * token, which is the backstop if a new action ever arrives without one.
 */
export const REQUEST_TOKEN_FOR_ACTION: Readonly<Record<StrategistAction, string>> = Object.freeze({
  MESSAGE_BUYER: 'msg',
  MAKE_OFFER: 'offer',
  ACKNOWLEDGE_RETURN: 'return',
  ESCALATE: 'escalate',
  APPEAL: 'appeal',
  PROVIDE_SUPPORTING_INFO: 'support',
  REVIEW_WITH_HUMAN: 'escalate',
})

/** The closed action set, in the order {@link permittedActionsFor} ranks it. */
export const STRATEGIST_ACTIONS: readonly StrategistAction[] = Object.freeze([
  'MAKE_OFFER',
  'MESSAGE_BUYER',
  'ACKNOWLEDGE_RETURN',
  'PROVIDE_SUPPORTING_INFO',
  'APPEAL',
  'ESCALATE',
  'REVIEW_WITH_HUMAN',
])

/**
 * Which actions a posture permits. **The bound on spec question 31.**
 *
 * | Posture | Permitted | Why these |
 * |---|---|---|
 * | `REFUND` | *none* | the money movement is decided; §8.15 settled it and the strategist must not relitigate it |
 * | `ACCEPT_CLAIM` | `MESSAGE_BUYER` | we conceded; the only thing left is to say so to the buyer |
 * | `CONTEST` | `PROVIDE_SUPPORTING_INFO`, `ESCALATE` | once filed we wait; these are the post-file moves (EC-DSP-5) |
 * | `OFFER` | `MAKE_OFFER`, `MESSAGE_BUYER` | the offer itself, and talking while the buyer decides |
 * | `MESSAGE_ONLY` | `MESSAGE_BUYER`, `MAKE_OFFER`, `ACKNOWLEDGE_RETURN` | EC-DSP-3: at `INQUIRY` these cost nothing and spend no response |
 * | `APPEAL` | `APPEAL`, `PROVIDE_SUPPORTING_INFO` | EC-DSP-6: the appeal, plus the supporting facts that go with it |
 * | `REVIEW` | `REVIEW_WITH_HUMAN` | a human decides; the strategist's only product is the summary |
 *
 * **Note what is absent from every row: nothing files evidence.** A `CONTEST` may escalate or supply supporting
 * info, never re-file — which is EC-DSP-5's "never re-file contradictory notes" as a property of a table rather
 * than a reviewer's job.
 */
export const STRATEGIST_ACTIONS_BY_POSTURE: Readonly<Record<Posture, readonly StrategistAction[]>> =
  Object.freeze({
    REFUND: Object.freeze([]) as readonly StrategistAction[],
    ACCEPT_CLAIM: Object.freeze(['MESSAGE_BUYER']) as readonly StrategistAction[],
    CONTEST: Object.freeze(['PROVIDE_SUPPORTING_INFO', 'ESCALATE']) as readonly StrategistAction[],
    OFFER: Object.freeze(['MAKE_OFFER', 'MESSAGE_BUYER']) as readonly StrategistAction[],
    MESSAGE_ONLY: Object.freeze([
      'MESSAGE_BUYER',
      'MAKE_OFFER',
      'ACKNOWLEDGE_RETURN',
    ]) as readonly StrategistAction[],
    APPEAL: Object.freeze(['APPEAL', 'PROVIDE_SUPPORTING_INFO']) as readonly StrategistAction[],
    REVIEW: Object.freeze(['REVIEW_WITH_HUMAN']) as readonly StrategistAction[],
  })

/**
 * The actions a posture permits, **filtered** by what this case can actually do.
 *
 * The table above says what a posture *may* do; this says what *this case* can do, and the difference is where
 * honesty lives:
 *
 * - `APPEAL` additionally requires `decision.posture === 'APPEAL'`, which `route()` reaches only via
 *   `R-APPEAL-1` — that is, only when PayPal offered the `appeal` HATEOAS link **and** something material
 *   arrived since the loss. EC-DSP-6's condition, re-checked here rather than trusted.
 * - `MAKE_OFFER` requires money left to offer ({@link offerBudget}), because a `$0.00` offer is a rejection.
 * - `ACKNOWLEDGE_RETURN` requires at least one shipment: with nothing shipped there is no parcel to acknowledge
 *   and PayPal would not have offered `acknowledge-return-item`.
 *
 * Returned in {@link STRATEGIST_ACTIONS} order, which is also the tie-break order, so the function is
 * deterministic.
 */
export function permittedActionsFor(
  ctx: DisputeContext,
  decision: LiabilityDecision,
  options: StrategyOptions = {},
): readonly StrategistAction[] {
  const permitted = new Set<StrategistAction>(STRATEGIST_ACTIONS_BY_POSTURE[decision.posture])
  const shipments = ctx.shipments ?? []
  const out: StrategistAction[] = []

  for (const action of STRATEGIST_ACTIONS) {
    if (!permitted.has(action)) continue
    if (action === 'APPEAL' && decision.posture !== 'APPEAL') continue
    if (action === 'MAKE_OFFER' && !hasOfferableMoney(ctx, options.priorOffers ?? [])) continue
    if (action === 'ACKNOWLEDGE_RETURN' && shipments.length === 0) continue
    out.push(action)
  }
  return out
}

/**
 * Is this action permitted by this posture? **The runtime restatement of the type-level guarantee.**
 *
 * `filer.ts` asserts that no strategist proposal can reach an evidence upload, because
 * {@link StrategistPayPalMethod} omits `provideEvidence`. This asserts the other half — that a proposal cannot
 * be *executed* outside its posture — and `strategist-actions.ts` calls it before every call, so a proposal that
 * arrived from outside (a stale row, a hand-built object, a future work package) is refused rather than sent.
 */
export function actionWithinPosture(
  action: StrategistAction,
  decision: LiabilityDecision,
): boolean {
  return STRATEGIST_ACTIONS_BY_POSTURE[decision.posture].includes(action)
}

// ---------------------------------------------------------------------------
// 2. The cost (AT-M16.1, and §8.16's $82)
// ---------------------------------------------------------------------------

/**
 * MRC's ~$82 average cost of handling a first-party-misuse dispute, **in USD minor units** [V13].
 *
 * Integer minor units because §0 rule 9: `USD 82.00` → `8_200n`. It is an **industry average from the 2023
 * Mastercard Economics Institute report**, not a measurement Countersign made — which is why
 * {@link CostBreakdown} carries the label as a literal type rather than as a string someone can drop.
 */
export const MRC_AVERAGE_HANDLING_COST_MINOR = 8_200n
export const MRC_AVERAGE_HANDLING_COST_CURRENCY: Currency = 'USD'

/** The verbatim label that must accompany the number wherever it is rendered. */
export const HANDLING_COST_LABEL =
  'MRC industry average cost of handling a first-party-misuse dispute [V13]'

export type CostVerdict = 'CHEAPER_TO_REFUND' | 'CHEAPER_TO_CONTEST' | 'INDISTINGUISHABLE'

export interface CostBreakdown {
  /** What the proposal costs the merchant in money at PayPal. `0n` for a proposal that moves no money. */
  readonly refundMinor: bigint
  readonly refundCurrency: Currency
  /** MRC's average handling cost: `8_200n`. Carries the label; see below. */
  readonly handlingCostMinor: bigint
  readonly handlingCostCurrency: Currency
  /**
   * **A literal `true`, not a `boolean`.** §8.16 says the $82 "is labelled as an industry average", and a
   * `boolean` here would be deletable in a refactor without a type error. As a literal, dropping it is a `tsc`
   * failure.
   */
  readonly handlingCostIsIndustryAverage: true
  /** The literal label, rendered verbatim wherever the number appears. */
  readonly handlingCostLabel: string
  /** `refundMinor − handlingCostMinor`. Negative means refunding is cheaper than fighting. */
  readonly deltaMinor: bigint
  readonly verdict: CostVerdict
  /** The citation, so a judge can check it. */
  readonly source: 'V13'
}

/** The cost comparison for an offer of `amount`, or for a proposal that moves no money. */
export function costFor(amount: Money | null): CostBreakdown {
  const refundMinor = amount?.minor ?? 0n
  const deltaMinor = refundMinor - MRC_AVERAGE_HANDLING_COST_MINOR
  const verdict: CostVerdict =
    deltaMinor < 0n
      ? 'CHEAPER_TO_REFUND'
      : deltaMinor > 0n
        ? 'CHEAPER_TO_CONTEST'
        : 'INDISTINGUISHABLE'
  return {
    refundMinor,
    refundCurrency: amount?.currency ?? MRC_AVERAGE_HANDLING_COST_CURRENCY,
    handlingCostMinor: MRC_AVERAGE_HANDLING_COST_MINOR,
    handlingCostCurrency: MRC_AVERAGE_HANDLING_COST_CURRENCY,
    handlingCostIsIndustryAverage: true,
    handlingCostLabel: HANDLING_COST_LABEL,
    deltaMinor,
    verdict,
    source: 'V13',
  }
}

// ---------------------------------------------------------------------------
// 3. The offer budget and its arithmetic
// ---------------------------------------------------------------------------

export interface OfferBudget {
  /** The capture's own amount. The ceiling nothing may exceed. */
  readonly captureAmount: Money
  /** Σ `COMPLETED` refunds — the same reader R-REF-1 used, so the two cannot disagree. */
  readonly alreadyRefunded: Money
  /** Offers already made that PayPal has not yet turned into refunds. */
  readonly alreadyOffered: Money
  /** `captureAmount − alreadyRefunded − alreadyOffered`, floored at zero. */
  readonly remaining: Money
  /** `alreadyRefunded + alreadyOffered`, for the invariant assertion. */
  readonly committed: Money
  /** `Σ offers + prior refunds ≤ capture`. Always `true`; asserted as a property in the tests. */
  readonly withinCapture: true
}

/**
 * How much is still offerable on this capture. **Integer minor units throughout.**
 *
 * Uses `completedRefunds(ctx)` rather than reading `captures.refunded_minor` directly, for two reasons: a
 * `PENDING` refund has not returned the money and must not shrink the budget, and the router reads the same
 * function — so the strategist's ceiling and R-REF-1's threshold cannot drift apart.
 *
 * A capture smaller than what is already refunded floors `remaining` at zero rather than going negative: a
 * negative offer is meaningless, and `remaining: 0` plus a refusal is the honest report.
 */
export function offerBudget(ctx: DisputeContext, priorOffers: readonly Money[] = []): OfferBudget {
  const currency = ctx.capture?.amount.currency ?? ctx.dispute.amount.currency
  const captureAmount = ctx.capture?.amount ?? { minor: 0n, currency }
  const refunded = completedRefunds(ctx).reduce((sum, r) => sum + r.amount.minor, 0n)
  const offered = priorOffers.reduce((sum, o) => sum + o.minor, 0n)
  const raw = captureAmount.minor - refunded - offered
  const remainingMinor = raw > 0n ? raw : 0n
  return {
    captureAmount,
    alreadyRefunded: money(refunded, currency),
    alreadyOffered: money(offered, currency),
    remaining: money(remainingMinor, currency),
    committed: money(refunded + offered, currency),
    withinCapture: true,
  }
}

/** Is there anything left to offer? {@link permittedActionsFor} uses this to drop `MAKE_OFFER`. */
export function hasOfferableMoney(
  ctx: DisputeContext,
  priorOffers: readonly Money[] = [],
): boolean {
  return offerBudget(ctx, priorOffers).remaining.minor > 0n
}

/**
 * A partial refund offer: **a share of what is left, as an exact `Money`.**
 *
 * `share` is `{ numerator, denominator }` in **integers** — never a float, never a percentage string. A
 * merchant asking for "75%" passes `{ numerator: 3, denominator: 4 }`; "half" is `{ numerator: 1, denominator: 2 }`.
 * The arithmetic is then `allocate(remaining, [BigInt(numerator), BigInt(denominator − numerator)])[0]`, i.e.
 * **the complement takes the exact remainder**, so the two parts sum to `remaining` with nothing invented or
 * lost (EC-FX-4, §18 q22).
 *
 * @returns `err(CS_VALIDATION)` when `denominator ≤ 0`, `numerator < 0`, `numerator ≥ denominator`, nothing is
 *   left, or the share rounds to zero. All refused rather than clamped: a clamped offer is a number the
 *   merchant did not agree to, and a `$0.00` offer is a rejection.
 */
export function partialOfferAmount(
  ctx: DisputeContext,
  share: { readonly numerator: number; readonly denominator: number },
  priorOffers: readonly Money[] = [],
): Result<Money, CsError> {
  if (!Number.isInteger(share.denominator) || share.denominator <= 0) {
    return err(
      csError(
        'CS_VALIDATION',
        `An offer share needs a positive integer denominator, got ${String(share.denominator)}`,
        { share: { ...share } },
      ),
    )
  }
  if (
    !Number.isInteger(share.numerator) ||
    share.numerator < 0 ||
    share.numerator >= share.denominator
  ) {
    return err(
      csError(
        'CS_VALIDATION',
        `An offer share needs an integer numerator in [0, denominator), got ${String(share.numerator)} of ${String(share.denominator)}`,
        { share: { ...share } },
      ),
    )
  }

  const budget = offerBudget(ctx, priorOffers)
  if (budget.remaining.minor <= 0n) {
    return err(
      csError(
        'CS_VALIDATION',
        'There is nothing left to offer on this capture: the refunded and already-offered amounts reach it. ' +
          'A zero offer is a rejection, not an offer.',
        {
          capture_minor: budget.captureAmount.minor.toString(),
          refunded_minor: budget.alreadyRefunded.minor.toString(),
          offered_minor: budget.alreadyOffered.minor.toString(),
        },
      ),
    )
  }

  const parts = allocate(budget.remaining, [
    BigInt(share.numerator),
    BigInt(share.denominator - share.numerator),
  ])
  const offer = parts[0] ?? money(0n, budget.remaining.currency)
  if (offer.minor <= 0n) {
    return err(
      csError(
        'CS_VALIDATION',
        `A ${share.numerator}/${share.denominator} share of the ${budget.remaining.minor.toString()} minor ` +
          'units left rounds to zero, which is not an offer.',
        { share: { ...share }, remaining_minor: budget.remaining.minor.toString() },
      ),
    )
  }
  return ok(offer)
}

/**
 * The default share for {@link proposeStrategyDeterministic}: **half of what is left.**
 *
 * Half because it is the one ratio with no judgement in it. EC-BUY-1's answer — offer a return rather than
 * fight, "since that's cheaper than the $82 handling cost" [V13] — needs an amount, and a half offer is the
 * amount a merchant can compute in their head, which is what makes the proposal reviewable at a glance. It is a
 * **default, not a recommendation**: {@link StrategyOptions.offerShare} overrides it.
 */
export const DEFAULT_OFFER_SHARE: { readonly numerator: number; readonly denominator: number } =
  Object.freeze({
    numerator: 1,
    denominator: 2,
  })

// ---------------------------------------------------------------------------
// 4. The proposal
// ---------------------------------------------------------------------------

/** One proposal. Every field is derived; the only model-influenced part is *which permitted action* was chosen. */
export interface StrategistProposal {
  /** Deterministic from `(disputeId, ruleId, posture, action, amount)`, so a re-proposal is a re-read. */
  readonly proposalId: string
  readonly disputeId: string
  /** **Which router rule produced the posture this proposal is bounded by.** §18 q31's traceability. */
  readonly ruleId: RuleId
  /** The posture, carried so `strategist-actions.ts` can re-check the bound without a second lookup. */
  readonly posture: Posture
  readonly action: StrategistAction
  /** The PayPal call, or `null` for the one action that makes none. **Never `provideEvidence`.** */
  readonly paypal: { readonly method: StrategistPayPalMethod; readonly token: string } | null
  /** The money this would move, when it moves any. An exact `Money`. */
  readonly amount: Money | null
  /** §8.16's required cost comparison, label included. */
  readonly cost: CostBreakdown
  /** One sentence a merchant can act on, quoting the rule. */
  readonly reason: string
  /** The text a merchant reads before clicking. Composed, clamped to PayPal's 2000 characters. */
  readonly copy: string | null
  /** EC-DSP-5: for `PROVIDE_SUPPORTING_INFO`, which facts the filed packet did not already contain. */
  readonly newFacts: readonly string[]
  /**
   * §8.16: "every action needs a merchant click". A **literal `true`**, so it cannot be dropped — the same
   * trick {@link CostBreakdown} uses for the industry-average label.
   */
  readonly requiresApproval: true
  /** Anything the caller should know: a dropped model candidate, a cost that crossed $82. */
  readonly warnings: readonly string[]
}

/** A minor-unit value: a `bigint` in memory, a decimal string after `JSON.stringify`. */
const minorSchema = z.union([z.bigint(), z.string().regex(/^-?\d+$/)])

/** AT-M16.1: *"The proposal JSON validates."* The schema is the contract; the interface satisfies it. */
export const strategistProposalSchema = z.looseObject({
  proposalId: z.string().min(1),
  disputeId: z.string().min(1),
  ruleId: z.string().min(1),
  posture: z.enum([
    'REFUND',
    'ACCEPT_CLAIM',
    'CONTEST',
    'OFFER',
    'MESSAGE_ONLY',
    'APPEAL',
    'REVIEW',
  ]),
  action: z.enum([
    'MESSAGE_BUYER',
    'MAKE_OFFER',
    'ACKNOWLEDGE_RETURN',
    'ESCALATE',
    'APPEAL',
    'PROVIDE_SUPPORTING_INFO',
    'REVIEW_WITH_HUMAN',
  ]),
  paypal: z.looseObject({ method: z.string().min(1), token: z.string().min(1) }).nullable(),
  amount: z.looseObject({ minor: minorSchema, currency: z.string().min(3) }).nullable(),
  cost: z.looseObject({
    refundMinor: minorSchema,
    refundCurrency: z.string().min(3),
    handlingCostMinor: minorSchema,
    handlingCostCurrency: z.string().min(3),
    handlingCostIsIndustryAverage: z.literal(true),
    handlingCostLabel: z.string().min(1),
    deltaMinor: minorSchema,
    verdict: z.enum(['CHEAPER_TO_REFUND', 'CHEAPER_TO_CONTEST', 'INDISTINGUISHABLE']),
    source: z.literal('V13'),
  }),
  reason: z.string().min(1),
  copy: z.string().nullable(),
  newFacts: z.array(z.string()),
  requiresApproval: z.literal(true),
  warnings: z.array(z.string()),
})

/**
 * Parse and **re-bind** a proposal that arrived as JSON — AT-M16.1's assertion, callable.
 *
 * The proposal travels: S-18 renders it, a merchant may edit the copy, and Judge Mode records it. A round trip
 * through `JSON.stringify` turns every `bigint` into a string, so this reader **coerces the minor-unit fields
 * back to `bigint`** and re-checks the two literal types (`handlingCostIsIndustryAverage`, `requiresApproval`).
 * Money never survives as a string: it comes back a `Money`.
 */
export function parseStrategistProposal(json: unknown): Result<StrategistProposal, CsError> {
  const parsed = strategistProposalSchema.safeParse(json)
  if (!parsed.success) {
    return err(
      csError(
        'LLM_SCHEMA',
        `The strategy proposal did not validate: ${parsed.error.issues
          .slice(0, 6)
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`,
        {
          issues: parsed.error.issues.slice(0, 8).map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        },
      ),
    )
  }
  const raw = parsed.data as unknown as Record<string, unknown>
  const amountRaw = raw['amount']
  const costRaw = asRecord(raw['cost'])
  const currency = asRecord(amountRaw)['currency']
  return ok({
    ...(raw as unknown as StrategistProposal),
    amount:
      amountRaw === null || currency === undefined
        ? null
        : money(toMinor(asRecord(amountRaw)['minor']), String(currency) as Currency),
    cost: {
      ...(costRaw as unknown as CostBreakdown),
      refundMinor: toMinor(costRaw['refundMinor']),
      handlingCostMinor: toMinor(costRaw['handlingCostMinor']),
      deltaMinor: toMinor(costRaw['deltaMinor']),
    } as CostBreakdown,
  })
}

/** What the model is asked for: **ranked candidate actions, nothing else.** */
export interface StrategistModel {
  readonly generateText: (request: {
    readonly system: string
    readonly prompt: string
  }) => Promise<{ readonly text: string }>
}

export interface StrategyOptions {
  /**
   * Offers already made and not yet refunded. **Read from the caller rather than inferred**, because the
   * strategist cannot see PayPal's `offers[]` (see `Dispute.offers` in `packages/paypal`), and guessing would
   * let `Σ offers` exceed the capture.
   */
  readonly priorOffers?: readonly Money[]
  /** Override {@link DEFAULT_OFFER_SHARE}. Integers only; see {@link partialOfferAmount}. */
  readonly offerShare?: { readonly numerator: number; readonly denominator: number }
  /**
   * An optional model that may offer **ranked candidates**.
   *
   * The port is one function returning text, for the same reason `drafter.ts` uses one: this file never imports
   * `ai`, so a caller can satisfy it with `generateText` and the package still does not know which SDK is behind
   * it. **Its output is a candidate list, never a decision.**
   */
  readonly llm?: StrategistModel
  /** Fact keys the previously filed packet already contained, so EC-DSP-5 can name what is new. */
  readonly filedFactKeys?: readonly string[]
  readonly onLog?: (line: string) => void
}

/** A model's parsed candidate list. Validated with zod before anything reads it. AT-M16.1. */
export const candidateListSchema = z.looseObject({
  candidates: z
    .array(
      z.looseObject({
        action: z.string().min(1),
        reason: z.string().min(1),
      }),
    )
    .min(1)
    .max(8),
})

// ---------------------------------------------------------------------------
// 5. proposeStrategyDeterministic
// ---------------------------------------------------------------------------

/**
 * The deterministic proposal. **Pure**: no clock, no I/O, no randomness, no model.
 *
 * Takes the first action {@link permittedActionsFor} allows, computes its money and its cost, and composes the
 * copy. Same `(ctx, decision, options)` in, same proposal out — which is what lets a test assert the whole thing
 * without a clock, and lets Judge Mode record a proposal it can replay.
 */
export function proposeStrategyDeterministic(
  ctx: DisputeContext,
  decision: LiabilityDecision,
  options: StrategyOptions = {},
): StrategistProposal {
  // **`options` is passed through whole** rather than re-assembled from its members, so a new option cannot be
  // silently dropped on the way down — which is how `priorOffers` would have become invisible here.
  const permitted = permittedActionsFor(ctx, decision, options)
  const action = permitted[0] ?? 'REVIEW_WITH_HUMAN'
  const warnings: string[] = []

  if (permitted.length === 0) {
    warnings.push(
      `Posture ${decision.posture} permits no strategist action at all, so the only product is the router's ` +
        'decision and its reasoning.',
    )
  }

  const amount = action === 'MAKE_OFFER' ? offerAmountOrNull(ctx, options) : null
  if (action === 'MAKE_OFFER' && amount === null) {
    warnings.push('There was nothing left to offer, so no amount could be computed.')
  }

  const cost = costFor(amount)
  if (amount !== null && cost.verdict === 'CHEAPER_TO_CONTEST') {
    warnings.push(
      `This offer is ${cost.refundMinor.toString()} minor units of ${cost.refundCurrency}, above MRC's ` +
        `${cost.handlingCostMinor.toString()}-unit industry-average handling cost [V13], so on that figure alone ` +
        'offering is the more expensive option.',
    )
  }

  const newFacts = newFactsSince(decision, options.filedFactKeys ?? [])
  return {
    proposalId: proposalIdFor(ctx, decision, action, amount),
    disputeId: ctx.dispute.id,
    ruleId: decision.ruleId,
    posture: decision.posture,
    action,
    paypal: paypalFor(action),
    amount,
    cost,
    reason: REASON_FOR_ACTION[action](decision, amount, newFacts),
    copy: COPY_FOR_ACTION[action](ctx, decision, amount),
    newFacts,
    requiresApproval: true,
    warnings,
  }
}

function paypalFor(action: StrategistAction): StrategistProposal['paypal'] {
  const method = PAYPAL_METHOD_FOR_ACTION[action]
  return method === null ? null : { method, token: REQUEST_TOKEN_FOR_ACTION[action] }
}

function offerAmountOrNull(ctx: DisputeContext, options: StrategyOptions): Money | null {
  const computed = partialOfferAmount(
    ctx,
    options.offerShare ?? DEFAULT_OFFER_SHARE,
    options.priorOffers ?? [],
  )
  return computed.ok ? computed.value : null
}

/**
 * EC-DSP-5: which of the router's facts the previously filed packet did not already contain.
 *
 * Keys, not values, because "we already said that" is a question about which artefact a packet cited, and
 * §8.18's section 4 lists exactly those ids.
 */
export function newFactsSince(
  decision: LiabilityDecision,
  filedFactKeys: readonly string[],
): readonly string[] {
  const filed = new Set(filedFactKeys)
  return decision.facts.filter((f) => !filed.has(f.key)).map((f) => f.key)
}

function proposalIdFor(
  ctx: DisputeContext,
  decision: LiabilityDecision,
  action: StrategistAction,
  amount: Money | null,
): string {
  return [
    'prop',
    ctx.dispute.id,
    decision.ruleId,
    decision.posture,
    action,
    amount === null ? 'nomoney' : `${amount.minor.toString()}${amount.currency}`,
  ].join(':')
}

// ---------------------------------------------------------------------------
// 6. The copy, composed and never generated
// ---------------------------------------------------------------------------

/**
 * The sentence explaining the proposal. Every one names the rule, because §8.16's proposals are the merchant's
 * evidence of *why*, and §18 q31 is about being able to check that.
 */
const REASON_FOR_ACTION: Readonly<
  Record<
    StrategistAction,
    (d: LiabilityDecision, amount: Money | null, newFacts: readonly string[]) => string
  >
> = Object.freeze({
  MAKE_OFFER: (d, amount) =>
    `Rule ${d.ruleId} found the case worth settling rather than fighting, so offer ` +
    `${amount === null ? 'the remaining balance' : `${amount.minor.toString()} minor units of ${amount.currency}`} ` +
    'against the buyer keeping or returning the item. Settling costs the disputed money once, with none of the ' +
    'handling cost of a contested dispute [V13].',
  MESSAGE_BUYER: (d) =>
    `Rule ${d.ruleId} found nothing worth filing yet, so write to the buyer. A message costs nothing and does ` +
    'not spend one of the response attempts a filing would.',
  ACKNOWLEDGE_RETURN: (d) =>
    `Rule ${d.ruleId} matched a return the buyer is sending, so acknowledge receipt of it. ` +
    'Acknowledge-return-item is a separate call from filing, and it tells PayPal the parcel is coming back ' +
    'before anyone asks.',
  ESCALATE: (d) =>
    `Rule ${d.ruleId} produced a packet we believe, so escalate to PayPal claim resolution rather than let the ` +
    'chargeback time out at our tier.',
  APPEAL: (d, _amount, newFacts) =>
    `Rule ${d.ruleId} matched an appealable dispute with new evidence` +
    `${newFacts.length === 0 ? '' : ` (${newFacts.join(', ')})`}, so appeal. Without something material since ` +
    'the loss, an appeal would only repeat a packet that already lost.',
  PROVIDE_SUPPORTING_INFO: (_d, _amount, newFacts) =>
    'The packet is already on file, so supply supporting information rather than re-file' +
    `${newFacts.length === 0 ? '' : `: ${newFacts.join(', ')}`}. EC-DSP-5 forbids re-filing notes that ` +
    'contradict the packet already submitted.',
  REVIEW_WITH_HUMAN: (d) =>
    `Rule ${d.ruleId} sent this to a person, and the strategist's only product is a summary of the decision ` +
    'and what it would cost.',
})

/**
 * The merchant-facing copy, **clamped to PayPal's 2000-character limit**.
 *
 * `make-offer`'s `note` is 1–2000 characters, `send-message`'s `message` has the same bound, and `escalate`'s
 * `note` does too — so one clamp serves all three. Composed from the decision and the money we already hold,
 * with **no claim about delivery, notification or carrier verification**, which is the discipline
 * `citation-check.ts` enforces in `notes` and which has to hold in free prose too.
 */
const COPY_FOR_ACTION: Readonly<
  Record<
    StrategistAction,
    (ctx: DisputeContext, d: LiabilityDecision, amount: Money | null) => string
  >
> = Object.freeze({
  MAKE_OFFER: (_ctx, d, amount) =>
    clampNote(
      [
        `Rule ${d.ruleId}.`,
        amount === null
          ? 'We are settling this rather than contesting it.'
          : `We are offering a partial refund of ${amount.minor.toString()} minor units of ${amount.currency}.`,
        'This ends the dispute without an adjudicated decision, at a cost stated in full on this screen.',
        'If you accept, the refund goes to the original payment method.',
      ].join(' '),
    ),
  MESSAGE_BUYER: (_ctx, d) =>
    clampNote(
      `${d.rationale} We have not filed anything with PayPal on this claim, and we are not going to spend one ` +
        'of our response attempts on it yet. If you have a carrier confirmation, or a conversation with us, reply ' +
        'here and we will read it.',
    ),
  ACKNOWLEDGE_RETURN: (_ctx, d) =>
    clampNote(`Rule ${d.ruleId}. We acknowledge that this item is on its way back to us.`),
  ESCALATE: (_ctx, d) =>
    clampNote(
      `Rule ${d.ruleId}. We are escalating this dispute to PayPal claim resolution. The signed purchase record is ` +
        'in the evidence packet we submitted.',
    ),
  APPEAL: (_ctx, d) =>
    clampNote(
      `Rule ${d.ruleId}. We lost the first decision and PayPal is still offering an appeal. We are appealing with ` +
        'the original evidence packet plus what has arrived since. The signed purchase record is unchanged.',
    ),
  PROVIDE_SUPPORTING_INFO: (_ctx, d) =>
    clampNote(
      `Rule ${d.ruleId}. We are adding supporting information to the evidence already on file, not replacing it. ` +
        'The signed purchase record is unchanged and re-verifies at the same address.',
    ),
  REVIEW_WITH_HUMAN: (_ctx, d) =>
    clampNote(`${d.rationale} No action has been taken with PayPal on this case.`),
})

/**
 * Clamp to PayPal's 2000-character cap by dropping whole trailing sentences.
 *
 * The same shape as `planner.ts`'s `clampNotes` and for the same reason: a note that ends mid-sentence reads as
 * a claim. The marker is a **fixed string with no digits**, because a digit in an uncited sentence is an
 * uncitable digit — the bug `citation-check.ts`'s `truncateNotes` documents.
 */
export function clampNote(text: string, maxChars = 2000): string {
  if (text.length <= maxChars) return text
  const marker = ' The full text is in the case file.'
  const budget = maxChars - marker.length
  const kept: string[] = []
  let used = 0
  for (const sentence of text.split(/(?<=\.)\s+/)) {
    if (used + sentence.length + 1 > budget) break
    kept.push(sentence)
    used += sentence.length + 1
  }
  if (kept.length === 0) return `This action needs a decision.${marker}`.slice(0, maxChars)
  return `${kept.join(' ')}${marker}`
}

// ---------------------------------------------------------------------------
// 7. proposeStrategy — the model's only power, which is a ranked candidate list
// ---------------------------------------------------------------------------

/**
 * Propose the next action. **Runs after the router and within its decision.**
 *
 * ```ts
 * const p = await proposeStrategy(ctx, decision, { priorOffers: [], llm })
 * ```
 *
 * Four steps, and the last three are what makes §18 q31 true:
 *
 * 1. **The deterministic proposal first.** {@link proposeStrategyDeterministic} always runs, so there is always
 *    a valid answer with no model and no key (EC-LLM-1, §18 q35).
 * 2. **Ask the model, if there is one**, for a ranked candidate list — validated with zod (AT-M16.1) before
 *    anything reads it.
 * 3. **Filter every candidate through {@link permittedActionsFor}.** A candidate outside the posture's list is
 *    dropped and named in `warnings`. This is where `"provideEvidence"`, `"FILE"`, `"REFUND"` and any other
 *    out-of-posture answer dies.
 * 4. **Re-rank deterministically.** The first surviving candidate *in `STRATEGIST_ACTIONS` order* wins, not the
 *    model's first choice — so two runs with the same inputs agree, and the model can only ever choose between
 *    options that were already permitted.
 *
 * **Never throws.** A model that is unavailable, returns garbage, or returns nothing leaves the deterministic
 * proposal standing with a warning naming why.
 */
export async function proposeStrategy(
  ctx: DisputeContext,
  decision: LiabilityDecision,
  options: StrategyOptions = {},
): Promise<Result<StrategistProposal, CsError>> {
  const base = proposeStrategyDeterministic(ctx, decision, options)
  if (options.llm === undefined) return ok(base)

  const log = options.onLog ?? ((): void => {})
  let text: string
  try {
    const answer = await options.llm.generateText({
      system: strategistSystemPrompt(ctx, decision),
      prompt: strategistPrompt(ctx, decision, base),
    })
    text = typeof answer.text === 'string' ? answer.text : ''
  } catch (cause) {
    log(
      'defender.strategist: the model could not be reached, so the deterministic proposal stands (EC-LLM-1). ' +
        `Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
    return ok(
      unchanged(
        base,
        'The model could not be reached, so the deterministic proposal stands unchanged.',
      ),
    )
  }

  const parsed = candidateListSchema.safeParse(readJson(text))
  if (!parsed.success) {
    log(
      'defender.strategist: the model answer did not validate, so the deterministic proposal stands.',
    )
    return ok(
      unchanged(
        base,
        'The model did not return a valid candidate list, so the deterministic proposal stands.',
      ),
    )
  }

  const permitted = permittedActionsFor(ctx, decision, options)
  const dropped: string[] = []
  const kept: string[] = []
  for (const candidate of parsed.data.candidates) {
    const action = candidate.action as StrategistAction
    if (!STRATEGIST_ACTIONS.includes(action) || !permitted.includes(action)) {
      if (!dropped.includes(candidate.action)) dropped.push(candidate.action)
      continue
    }
    if (!kept.includes(action)) kept.push(action)
  }

  if (dropped.length > 0) {
    log(
      `defender.strategist: dropped ${dropped.length} candidate(s) outside the ${decision.posture} posture: ${dropped.join(', ')}`,
    )
  }

  // Deterministic re-rank: the permitted action that comes first in `STRATEGIST_ACTIONS` order.
  const chosen = STRATEGIST_ACTIONS.find((a) => kept.includes(a))
  const dropNote =
    dropped.length === 0
      ? []
      : [
          `The model proposed ${dropped.join(', ')}, which this ${decision.posture} posture does not permit. ` +
            'Dropped: the strategist may only act within the posture the router gave it.',
        ]

  if (chosen === undefined || chosen === base.action) {
    return ok({ ...base, warnings: [...base.warnings, ...dropNote] })
  }
  const rebuilt = buildFor(base, chosen, ctx, decision, options)
  return ok({ ...rebuilt, warnings: [...rebuilt.warnings, ...dropNote] })
}

function unchanged(base: StrategistProposal, warning: string): StrategistProposal {
  return { ...base, warnings: [...base.warnings, warning] }
}

/** Rebuild a proposal for a different — but already permitted — action, reusing every derived field. */
function buildFor(
  base: StrategistProposal,
  action: StrategistAction,
  ctx: DisputeContext,
  decision: LiabilityDecision,
  options: StrategyOptions,
): StrategistProposal {
  const amount = action === 'MAKE_OFFER' ? offerAmountOrNull(ctx, options) : null
  return {
    proposalId: proposalIdFor(ctx, decision, action, amount),
    disputeId: base.disputeId,
    ruleId: decision.ruleId,
    posture: decision.posture,
    action,
    paypal: paypalFor(action),
    amount,
    cost: costFor(amount),
    reason: REASON_FOR_ACTION[action](decision, amount, base.newFacts),
    copy: COPY_FOR_ACTION[action](ctx, decision, amount),
    newFacts: base.newFacts,
    requiresApproval: true,
    warnings: base.warnings,
  }
}

/**
 * The system prompt. It **lists the permitted actions and nothing else**, and says the list is closed.
 *
 * Belt to braces: a model told "choose from A, B, C" and handed a seventh option in its answer still has that
 * option filtered out by step 3. Asking properly is cheaper than blocking.
 */
export function strategistSystemPrompt(ctx: DisputeContext, decision: LiabilityDecision): string {
  const permitted = permittedActionsFor(ctx, decision)
  return [
    'You are choosing the next action on one PayPal dispute. You are NOT deciding whether to contest, and you',
    'cannot contest: a deterministic rules table already decided that, and nothing you write can change it.',
    '',
    `The router decided: rule ${decision.ruleId}, posture ${decision.posture}, liability ${decision.liability}.`,
    decision.rationale,
    '',
    '## The actions you may choose from',
    'This list is CLOSED. Anything outside it is discarded without being executed.',
    ...(permitted.length === 0
      ? ['(none — this posture permits no action at all)']
      : permitted.map((a) => `- ${a}`)),
    '',
    '## Output contract',
    'Return JSON only. No prose, no markdown.',
    '{"candidates":[{"action":"<one from the list>","reason":"<one sentence>"}]}',
    'Rank them best first. You may return one candidate. Never return an evidence filing, a refund or an',
    'accept-claim: those belong to the deterministic path and are not yours to choose.',
    '',
    '## Hard rules',
    '1. Never assert the parcel was delivered, or that the buyer was notified. We hold no record of either.',
    '2. Money is an integer amount plus its ISO-4217 code. Never convert between currencies.',
    `3. The disputed amount is ${ctx.dispute.amount.currency}, ${ctx.dispute.amount.minor.toString()} minor units.`,
    '4. At most 8 candidates.',
  ].join('\n')
}

/** The user turn: the case, and the deterministic proposal the model is being asked to improve on. */
export function strategistPrompt(
  ctx: DisputeContext,
  decision: LiabilityDecision,
  base: StrategistProposal,
): string {
  return [
    `Buyer claim: ${ctx.dispute.reason}`,
    `Disputed amount: ${ctx.dispute.amount.currency} ${ctx.dispute.amount.minor.toString()} minor units`,
    `Deadline band: ${decision.deadline.state}`,
    `Our deterministic proposal was ${base.action}, because ${base.reason}`,
    'Return at most three candidates as JSON, best first.',
  ].join('\n')
}

/** Read a JSON object out of a model answer that may be fenced or wrapped in prose. Never throws. */
function readJson(text: string): unknown {
  const trimmed = text.trim()
  const unfenced = /^```[a-z]*\s*\n([\s\S]*?)\n?```$/.exec(trimmed)
  const body = unfenced?.[1] ?? trimmed
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(body.slice(start, end + 1)) as unknown
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 8. Two small readers
// ---------------------------------------------------------------------------

/** A jsonb-mirror reader. Takes `unknown`, never throws — the same discipline as `ingest.ts`. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * A minor-unit value that survived `JSON.stringify`: a `bigint` in memory, a decimal string in transit.
 *
 * The `throw` is unreachable after {@link strategistProposalSchema} has validated the input — `minorSchema`
 * admits only a `bigint` or a `-?\d+` string — and it is a plain `Error` rather than a `CsError` because this
 * is a **bug in the schema**, not a condition a caller can cause. Returning an error instead would mean
 * returning a `Result` from inside a function whose caller already has one.
 */
function toMinor(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value)
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value)
  throw new Error(
    `defender.strategist: ${JSON.stringify(value)} is not an integer minor-unit value; ` +
      'strategistProposalSchema.minorSchema should have refused it first.',
  )
}
