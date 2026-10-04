/**
 * `route()` — spec **§8.15**, work package **WP-15a**.
 *
 * ```ts
 * const decision = route(context)
 * // decision.posture === 'CONTEST' | 'REFUND' | 'ACCEPT_CLAIM' | ...
 * ```
 *
 * ## The one thing to know about this function
 *
 * **It is pure.** No model, no clock, no database, no `Date.now()`, no randomness, no network. `nowSec`
 * arrives in the {@link DisputeContext} as data, so the same context always produces the same decision —
 * byte for byte — which is what makes the 40-case eval in `eval/router-cases.jsonl` a real measurement
 * rather than a vibe check, and what makes "re-run the router after gathering a document" a safe operation
 * for WP-15e.
 *
 * ## How a decision is reached
 *
 * 1. **Deadline first.** EC-DSP-7/8 are about the clock and are computed before any rule runs, so the
 *    rationale can name the clock whichever rule wins.
 * 2. **First matching rule wins.** {@link RULE_ORDER}, in the order `rules.ts` documents.
 * 3. **The clock can remove authority to file.** EC-DSP-7's downgrade and EC-DSP-12's `R-NO-EVIDENCE` both
 *    run *after* a rule is chosen, because both are statements about a posture rather than about the facts.
 * 4. **The rationale is composed, never generated.** `rationale.ts` builds the sentence and the citable
 *    facts from the same values the decision carries.
 *
 * ## What this function will never do
 *
 * - **Never return `CONTEST` with evidence we do not have.** `R-NO-EVIDENCE` exists for that, and the
 *   invariant is asserted as a property over generated contexts in `test/router.test.ts`.
 * - **Never set `blockingReason` for a deadline.** That is EC-DSP-8's `DEF_DEADLINE_PASSED`, raised by the
 *   filer. See `rationale.ts`.
 * - **Never reach the database or a model.** If it needs a fact, the caller supplies it in the context.
 */

import { formatCountdown } from '@countersign/core'

import { composeRationale } from './rationale'
import {
  DEADLINE_CRITICAL_SECONDS,
  DEADLINE_PRESSURE_SECONDS,
  RULE_ORDER,
  autoAccepts,
  missingEvidence,
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
  ruleSnadAuthorised,
  ruleSnadMerchantFault,
  ruleSnadThinQuality,
  ruleInquiryStage,
  ruleUnauthorisedAuthorised,
  ruleUnauthorisedLostDevice,
  ruleUnauthorisedWeak,
  weakCaseAutoAccepts,
} from './rules'
import type {
  DeadlineState_,
  DisputeActionName,
  DisputeContext,
  EvidenceType,
  Liability,
  LiabilityDecision,
  Posture,
  RuleId,
} from './types'

/**
 * The posture and liability each rule resolves to before any deadline or evidence adjustment.
 *
 * `REFUND`'s liability is not always the rule's: a refund is a money movement, and the liability records
 * *who is at fault*, so the two are kept apart deliberately. R-INR-1 is `MERCHANT_FAULT` because we did not
 * ship; R-SNAD-AGENT is `AGENT_FAULT` because our agent misread; R-DEFAULT is `UNPROVABLE` because nothing
 * in the record answers the claim.
 */
interface BaseDecision {
  readonly ruleId: RuleId
  readonly posture: Posture
  readonly liability: Liability
  readonly evidenceRequired: readonly EvidenceType[]
  readonly userAlert?: string
}

/** The PayPal dispute action each posture implies. `null` where there is no PayPal call. */
const ACTION_BY_POSTURE: Readonly<Record<Posture, DisputeActionName | null>> = {
  REFUND: null,
  ACCEPT_CLAIM: 'ACCEPT',
  CONTEST: 'FILE',
  OFFER: 'OFFER',
  MESSAGE_ONLY: 'MESSAGE',
  APPEAL: 'APPEAL',
  REVIEW: null,
}

/**
 * The order rules are evaluated in. **`R-CHAIN-BAD` sits before `R-NOCHAIN-1` on purpose** — the two are
 * different statements ("we have a mandate and it does not verify" vs "there is no mandate here") and the
 * second is false in the first case.
 *
 * `R-UNAUTH-2` and `R-UNAUTH-3` sit before `R-UNAUTH-1` for the reason in `rules.ts`: R-UNAUTH-1's stated
 * condition is also true when the device was stolen and the attacker produced a valid passkey assertion.
 */
const EVALUATION_ORDER: readonly BaseDecision[] = [
  {
    ruleId: 'R-REF-1',
    posture: 'ACCEPT_CLAIM',
    liability: 'ALREADY_REFUNDED',
    evidenceRequired: ['PROOF_OF_REFUND'],
  },
  {
    ruleId: 'R-APPEAL-1',
    posture: 'APPEAL',
    liability: 'USER_AUTHORISED',
    evidenceRequired: ['DETAILS_OF_PURCHASE', 'PROOF_OF_FULFILLMENT'],
  },
  // R-CHAIN-BAD is decided inside the R-NOCHAIN-1 branch, because both are "we have no proof" and only one
  // of them can be honestly stated. See `decideNoProof`.
  { ruleId: 'R-NOCHAIN-1', posture: 'REVIEW', liability: 'UNPROVABLE', evidenceRequired: [] },
  { ruleId: 'R-INR-1', posture: 'REFUND', liability: 'MERCHANT_FAULT', evidenceRequired: [] },
  {
    ruleId: 'R-INR-3',
    posture: 'MESSAGE_ONLY',
    liability: 'USER_AUTHORISED',
    evidenceRequired: [],
  },
  {
    ruleId: 'R-INR-2',
    posture: 'CONTEST',
    liability: 'USER_AUTHORISED',
    evidenceRequired: ['PROOF_OF_FULFILLMENT', 'ONLINE_TRACKING_INFORMATION'],
  },
  { ruleId: 'R-SNAD-AGENT', posture: 'REFUND', liability: 'AGENT_FAULT', evidenceRequired: [] },
  { ruleId: 'R-SNAD-MERCH', posture: 'REFUND', liability: 'MERCHANT_FAULT', evidenceRequired: [] },
  { ruleId: 'R-SNAD-THIN', posture: 'OFFER', liability: 'USER_AUTHORISED', evidenceRequired: [] },
  {
    ruleId: 'R-SNAD-OK',
    posture: 'CONTEST',
    liability: 'USER_AUTHORISED',
    evidenceRequired: ['ITEM_DESCRIPTION', 'ORDER_DETAILS'],
  },
  { ruleId: 'R-UNAUTH-2', posture: 'ACCEPT_CLAIM', liability: 'UNPROVABLE', evidenceRequired: [] },
  { ruleId: 'R-UNAUTH-3', posture: 'REVIEW', liability: 'UNPROVABLE', evidenceRequired: [] },
  {
    ruleId: 'R-UNAUTH-1',
    posture: 'CONTEST',
    liability: 'USER_AUTHORISED',
    evidenceRequired: ['DETAILS_OF_PURCHASE', 'ORDER_DETAILS'],
    userAlert:
      'Signed with your passkey and inside the mandate you approved. If you did not make this purchase, mark the device lost — that changes the answer next time.',
  },
  {
    ruleId: 'R-AMT-1',
    posture: 'CONTEST',
    liability: 'USER_AUTHORISED',
    evidenceRequired: ['PROOF_OF_RECEIPT_COPY'],
  },
  { ruleId: 'R-AMT-2', posture: 'REFUND', liability: 'MERCHANT_FAULT', evidenceRequired: [] },
  {
    ruleId: 'R-CNP-1',
    posture: 'ACCEPT_CLAIM',
    liability: 'ALREADY_REFUNDED',
    evidenceRequired: ['PROOF_OF_REFUND'],
  },
  {
    ruleId: 'R-OTHER-REFUND',
    posture: 'REFUND',
    liability: 'MERCHANT_FAULT',
    evidenceRequired: [],
  },
  { ruleId: 'R-DEFAULT', posture: 'REVIEW', liability: 'UNPROVABLE', evidenceRequired: [] },
]

/**
 * Which predicates belong to which rule, in the order they are tested.
 *
 * A rule is in this table if and only if its predicate exists in `rules.ts`; `test/rules.test.ts` asserts
 * the two agree, so a rule can never be added to the router without a named predicate behind it. That is the
 * structural half of "a deterministic rules table decides the posture before the model is asked for
 * anything": every branch in `route()` is a line of this table.
 */
export const PREDICATE_FOR: Readonly<Record<RuleId, (ctx: DisputeContext) => boolean>> = {
  'R-REF-1': ruleAlreadyRefunded,
  'R-APPEAL-1': ruleAppealable,
  'R-NOCHAIN-1': ruleNoChain,
  'R-CHAIN-BAD': ruleChainBad,
  'R-INR-1': ruleInrUntracked,
  'R-INR-3': ruleInrInTransit,
  'R-INR-2': ruleInrTracked,
  'R-SNAD-AGENT': ruleSnadAgentFault,
  'R-SNAD-MERCH': ruleSnadMerchantFault,
  'R-SNAD-THIN': ruleSnadThinQuality,
  'R-SNAD-OK': ruleSnadAuthorised,
  'R-UNAUTH-2': ruleUnauthorisedLostDevice,
  'R-UNAUTH-3': ruleUnauthorisedWeak,
  'R-UNAUTH-1': ruleUnauthorisedAuthorised,
  'R-AMT-1': ruleAmountCorrect,
  'R-AMT-2': ruleAmountDuplicate,
  'R-CNP-1': ruleCreditNotProcessedRefunded,
  'R-OTHER-REFUND': ruleOtherReasonRefund,
  'R-DEADLINE-1': () => false, // resolved after a posture exists; see `applyDeadline`
  'R-NO-EVIDENCE': () => false, // resolved after a posture exists; see `applyEvidenceGuard`
  'R-STAGE-INQUIRY': () => false, // resolved after a posture exists; see `applyStage`
  'R-DEFAULT': () => true, // the fall-through: it is reached only when nothing above matched
}

// ---------------------------------------------------------------------------
// The deadline
// ---------------------------------------------------------------------------

/**
 * EC-DSP-7 / EC-DSP-8 as one pure function of `(nowSec, sellerResponseDueSec)`.
 *
 * The bands are the spec's, not ours: `CRITICAL` is EC-DSP-7's 1-hour auto-file refusal, `PRESSURE` is the
 * 48-hour window where a downgrade can be justified, and `PASSED` is EC-DSP-8's
 * `DEF_DEADLINE_PASSED`. `UNKNOWN` is `INQUIRY`-stage reality — PayPal sends no deadline before a claim
 * becomes a chargeback, and treating that as "infinite time" would be an invented fact.
 */
export function deadlineState(nowSec: number, dueSec: number | null | undefined): DeadlineState_ {
  if (dueSec === null || dueSec === undefined) {
    return { state: 'UNKNOWN', secondsLeft: null, countdown: null }
  }
  const secondsLeft = dueSec - nowSec
  const countdown = formatCountdown(secondsLeft)
  if (secondsLeft <= 0) return { state: 'PASSED', secondsLeft, countdown }
  if (secondsLeft <= DEADLINE_CRITICAL_SECONDS) return { state: 'CRITICAL', secondsLeft, countdown }
  if (secondsLeft <= DEADLINE_PRESSURE_SECONDS) return { state: 'PRESSURE', secondsLeft, countdown }
  return { state: 'COMFORTABLE', secondsLeft, countdown }
}

/** Which postures file something at PayPal, and are therefore subject to the deadline downgrade. */
function filesAtPaypal(posture: Posture): boolean {
  return posture === 'CONTEST' || posture === 'OFFER' || posture === 'APPEAL'
}

// ---------------------------------------------------------------------------
// The two post-decision adjustments
// ---------------------------------------------------------------------------

/**
 * **R-DEADLINE-1** — EC-DSP-7. Inside 48 h, a posture that would file, and evidence that is not in hand.
 *
 * The downgrade is to `REFUND`, and the original rule id is kept in `supersedes` so the case file still
 * records what we would have argued. The merchant who gathers the document re-runs `route()` and gets a
 * different answer, because `route()` is pure.
 */
function applyDeadline(
  base: BaseDecision,
  ctx: DisputeContext,
  deadline: DeadlineState_,
): BaseDecision {
  if (!filesAtPaypal(base.posture)) return base
  if (!ruleDeadlineForcesRefund(deadline.secondsLeft)) return base
  const absent = missingEvidence(base.evidenceRequired, ctx)
  if (absent.length === 0) return base
  return {
    ruleId: 'R-DEADLINE-1',
    posture: 'REFUND',
    liability: base.liability,
    evidenceRequired: [],
  }
}

/**
 * **R-STAGE-INQUIRY** — spec EC-DSP-3.
 *
 * The stage outranks the reason: a fully evidenced `MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED` contest is
 * still not filed while the dispute is an `INQUIRY` and PayPal has not asked for a response. Posting it now
 * spends one of the merchant's response attempts on a claim that may still be withdrawn, and there is no
 * deadline to catch it — `INQUIRY` cases usually carry no `seller_response_due_date` at all.
 *
 * Applied **first**, before the deadline and evidence adjustments, because "there is no window open" is a
 * more basic fact than either. Being an adjustment means it only ever subtracts, and `supersedes` keeps the
 * rule the router would otherwise have used.
 */
function applyStage(base: BaseDecision, ctx: DisputeContext): BaseDecision {
  if (!filesAtPaypal(base.posture)) return base
  if (!ruleInquiryStage(ctx)) return base
  return {
    ruleId: 'R-STAGE-INQUIRY',
    posture: 'MESSAGE_ONLY',
    liability: base.liability,
    evidenceRequired: [],
  }
}

/**
 * **R-NO-EVIDENCE** — the invariant that keeps `CONTEST` honest.
 *
 * A `CONTEST` whose `evidenceRequired` contains a type we cannot source would produce a filing PayPal
 * rejects or ignores: one of the merchant's response attempts spent, and a rejected response can move the
 * dispute up a stage. So the authority to file is removed:
 *
 * - **at or below the merchant's auto-accept limit → `REFUND`.** Small by the merchant's own stated
 *   policy, and nobody is woken up for it.
 * - **above it → `REVIEW`,** with `blockingReason`, because "file nothing or absorb the loss" is a money
 *   decision with no honest default.
 *
 * The same guard covers `APPEAL` and `OFFER` for the same reason — both send something to PayPal. It can
 * only ever *reduce* what we file, never increase it.
 */
function applyEvidenceGuard(base: BaseDecision, ctx: DisputeContext): BaseDecision {
  if (!filesAtPaypal(base.posture)) return base
  const absent = missingEvidence(base.evidenceRequired, ctx)
  if (absent.length === 0) return base
  const settle = autoAccepts(ctx)
  return {
    ruleId: 'R-NO-EVIDENCE',
    posture: settle ? 'REFUND' : 'REVIEW',
    liability: base.liability,
    evidenceRequired: [],
  }
}

/**
 * **The no-proof branch**, which owns both R-CHAIN-BAD and R-NOCHAIN-1.
 *
 * They are handled together because they are the same decision with two different sentences, and picking the
 * right sentence is the whole content of §18 question 20:
 *
 * - A mandate exists and its chain does not verify → **R-CHAIN-BAD**, `ACCEPT_CLAIM`, flat. The spec's row
 *   says "never contest with a broken chain", and it does not consult the merchant's threshold: a broken
 *   chain means we cannot support *any* argument, so the case ends the moment an adjudicator finds the hole.
 * - No mandate, or no order, or no capture → **R-NOCHAIN-1**. `ACCEPT_CLAIM` when the merchant has
 *   configured an auto-accept limit the claim falls under, `REVIEW` otherwise — and `REVIEW` is the default,
 *   because an unconfigured merchant has not delegated a money decision to us.
 */
function decideNoProof(ctx: DisputeContext): BaseDecision {
  if (ruleChainBad(ctx)) {
    return {
      ruleId: 'R-CHAIN-BAD',
      posture: 'ACCEPT_CLAIM',
      liability: 'UNPROVABLE',
      evidenceRequired: [],
    }
  }
  return {
    ruleId: 'R-NOCHAIN-1',
    posture: autoAccepts(ctx) ? 'ACCEPT_CLAIM' : 'REVIEW',
    liability: 'UNPROVABLE',
    evidenceRequired: [],
  }
}

/** R-UNAUTH-3's threshold branch: EC-BUY-3's "ACCEPT above $50 (merchant setting)". */
function decideWeakUnauthorised(ctx: DisputeContext): BaseDecision {
  return {
    ruleId: 'R-UNAUTH-3',
    posture: weakCaseAutoAccepts(ctx) ? 'ACCEPT_CLAIM' : 'REVIEW',
    liability: 'UNPROVABLE',
    evidenceRequired: [],
  }
}

// ---------------------------------------------------------------------------
// route()
// ---------------------------------------------------------------------------

/**
 * Decide the liability posture for one dispute.
 *
 * ```ts
 * const d = route({ nowSec: 1_790_000_000, dispute, capture, order, chain, shipments, refunds })
 * ```
 *
 * @param ctx everything the decision may depend on. `nowSec` is the only clock, and it is data.
 * @returns a {@link LiabilityDecision} with every field set. `posture === 'CONTEST'` implies
 *   `evidenceRequired` is non-empty and every member is a PayPal `evidence_type`.
 */
export function route(ctx: DisputeContext): LiabilityDecision {
  const deadline = deadlineState(ctx.nowSec, ctx.dispute.sellerResponseDueSec)

  // --- 1. the rule table -------------------------------------------------------------------
  const base = selectRule(ctx)

  // --- 2. the stage, then the clock, then the evidence ----------------------------------------
  // Order matters, and it is by how basic each fact is. "There is no filing window open" (R-STAGE-INQUIRY)
  // outranks "can we still do this?" (R-DEADLINE-1), which outranks "do we have it?" (R-NO-EVIDENCE). Each
  // only ever subtracts authority to file, so the order changes which reason a merchant is given rather than
  // what we are allowed to do.
  const staged = applyStage(base, ctx)
  const withDeadline = applyDeadline(staged, ctx, deadline)
  const settled = applyEvidenceGuard(withDeadline, ctx)

  // --- 3. compose the sentence ---------------------------------------------------------------
  const ADJUSTMENTS = new Set<RuleId>(['R-NO-EVIDENCE', 'R-DEADLINE-1', 'R-STAGE-INQUIRY'])
  const supersedes = ADJUSTMENTS.has(settled.ruleId) ? base.ruleId : undefined
  const composed = composeRationale({
    ctx,
    ruleId: settled.ruleId,
    posture: settled.posture,
    liability: settled.liability,
    deadline,
    ...(supersedes === undefined ? {} : { supersedes }),
  })

  return {
    ruleId: settled.ruleId,
    liability: settled.liability,
    posture: settled.posture,
    rationale: composed.text,
    reasons: composed.reasons,
    facts: composed.facts,
    evidenceRequired: settled.evidenceRequired,
    ...(composed.blockingReason === undefined ? {} : { blockingReason: composed.blockingReason }),
    action: ACTION_BY_POSTURE[settled.posture],
    deadline,
    ...(supersedes === undefined ? {} : { supersedes }),
    // The R-UNAUTH-1 flag (§8.15: "flag 'possible compromised device' to the user"). It rides on the row
    // rather than on the rationale, so a deadline or evidence downgrade that replaces the rule also drops
    // the alert — the alert is a statement about a contested case, and there is no contest any more.
    ...(settled.userAlert === undefined ? {} : { userAlert: settled.userAlert }),
  }
}

/**
 * The rules table itself, as a loop over a fixed order.
 *
 * {@link RULE_ORDER} is the order; {@link EVALUATION_ORDER} carries the posture and liability each row
 * resolves to. Two rules need a sub-decision rather than a constant — the no-proof pair
 * ({@link decideNoProof}) and the weak-unauthorised threshold ({@link decideWeakUnauthorised}) — and two are
 * resolved after the table has produced a posture ({@link applyDeadline}, {@link applyEvidenceGuard}), so
 * their predicates here are the honest `() => false` and their rows are absent.
 *
 * Every other branch is "the predicate said yes → take that row", which is what makes this reviewable as a
 * table rather than as a pile of conditionals.
 */
function selectRule(ctx: DisputeContext): BaseDecision {
  for (const ruleId of RULE_ORDER) {
    if (ruleId === 'R-CHAIN-BAD' || ruleId === 'R-DEADLINE-1' || ruleId === 'R-NO-EVIDENCE')
      continue
    if (ruleId === 'R-NOCHAIN-1') {
      // The no-proof pair is decided as a unit; see `decideNoProof`.
      if (ruleNoChain(ctx) || ruleChainBad(ctx)) return decideNoProof(ctx)
      continue
    }
    if (ruleId === 'R-UNAUTH-3') {
      if (ruleUnauthorisedWeak(ctx)) return decideWeakUnauthorised(ctx)
      continue
    }
    if (!PREDICATE_FOR[ruleId](ctx)) continue
    const row = EVALUATION_ORDER.find((r) => r.ruleId === ruleId)
    if (row === undefined) {
      // Unreachable while `EVIDENCE_TABLE` and `EVALUATION_ORDER` agree, and `test/rules.test.ts` asserts
      // that they do. Throwing is the right answer anyway: a rule with no row would have no posture, and a
      // decision with no posture is the one failure mode this package exists to prevent.
      throw new Error(`defender: ${ruleId} matched but has no row in the evaluation table`)
    }
    return row
  }
  // `R-DEFAULT` is last in `RULE_ORDER` and its predicate is `() => true`, so this is unreachable unless
  // someone deletes that row — and if they do, we must not fall through to a contest.
  throw new Error('defender: no rule matched; R-DEFAULT must be the final fall-through')
}

export { RULE_ORDER }
