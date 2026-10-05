/**
 * Strategy execution — spec **§8.16**, **§10.2 #16**, work package **WP-16**, acceptance **AT-M16.2**.
 *
 * ```ts
 * const out = await executeStrategy(proposal, decision, ctx, deps, {
 *   approvedBy: 'usr_merchant',
 *   returnShippingAddress: { country_code: 'US' },
 * })
 * ```
 *
 * ## What this file does and does not decide
 *
 * It **executes** a {@link StrategistProposal}. It decides nothing: the proposal already carries the rule id,
 * the posture, the action, the amount and the cost, all derived in `strategist.ts` under the posture bound.
 * What this file adds is the three things §8.16 requires of an *action* rather than of a *proposal*:
 *
 * | Requirement | Where |
 * |---|---|
 * | "every action needs a merchant click" | {@link ExecuteOptions.approvedBy} is a **required** option. There is no auto-send path in this file. |
 * | "each action calls the right endpoint with an idempotency key" | the one `switch` in {@link dispatch}, one endpoint per arm, `PayPal-Request-Id` from `disputeActionRequestId` |
 * | "logged in `dispute_actions`" | one row per execution, on success **and** on every refusal |
 *
 * ## The four re-checks, and why none of them is redundant
 *
 * `strategist.ts` already bounded the proposal by its posture. This file re-checks at the moment of sending,
 * because between proposing and clicking a proposal can be stale, edited, or come from somewhere else — a
 * stored row, a hand-built object, a future work package. Each is a cheap comparison against a value the
 * caller already holds, and each **refuses rather than repairs**:
 *
 * 1. **Approval.** Without `approvedBy`, nothing is sent. Not "sent with a default actor" — nothing.
 * 2. **Posture.** {@link actionWithinPosture} → `CS_FORBIDDEN`. The stale-proposal guard.
 * 3. **Money.** For `MAKE_OFFER`, the amount is re-checked against {@link offerBudget} built from the
 *    `ctx` threaded in, so `Σ offers + prior refunds ≤ capture` is enforced **at the boundary** rather than only
 *    at proposal time — the `priorOffers` a caller passes here may be newer than the one the proposal was
 *    computed from.
 * 4. **Bodies.** `offer_type` ∈ `OFFER_TYPES`, `acknowledgement_type` ∈ `ACKNOWLEDGEMENT_TYPES`, and an
 *    `APPEAL` carrying an input. These are `@countersign/paypal`'s own schemas and the client would validate
 *    them anyway; checking here means the refusal names the field instead of quoting a 400.
 *
 * ## Why this file has no `provideEvidence`
 *
 * {@link StrategistPayPalMethod} does not contain it, so there is no arm to write, and
 * {@link StrategistPayPal} has no such method to dispatch to. The **one** place evidence is uploaded is
 * `filer.ts`'s `dispatchUpload`, behind an {@link EvidenceUploadPermit}. That is spec question 31 in one
 * sentence: the strategist has no vocabulary for filing, so no proposal it can express has a path to an upload.
 *
 * ## The offer body, and why `offer_type` is derived rather than hard-coded
 *
 * `make-offer`'s `offer_type` is a real decision. EC-BUY-1 recommends `REFUND_WITH_RETURN` ("the merchant
 * offers a return"), and PayPal **requires `return_shipping_address` whenever `offer_type` is
 * `REFUND_WITH_RETURN`** (`SPEC-D`, report §4/#10). So {@link resolveOfferType} returns `REFUND_WITH_RETURN`
 * **only when a return address was supplied**, and `REFUND` (refund, buyer keeps the item) otherwise.
 * Hard-coding `REFUND_WITH_RETURN` would be a 400 on every offer from a merchant with no returns desk;
 * hard-coding `REFUND` would quietly drop the return that makes the offer attractive.
 */

import {
  csError,
  err,
  ok,
  toPayPalValue,
  type Clock,
  type CsError,
  type DisputeActionId,
  type DisputeId,
  type Logger,
  type Money,
  type Result,
} from '@countersign/core'
import type { DisputeActionRow, JsonValue, NewDisputeAction } from '@countersign/db'
import {
  ACKNOWLEDGEMENT_TYPES,
  OFFER_TYPES,
  disputeActionRequestId,
  type AcknowledgementType,
  type DisputeActionToken,
  type EvidenceFile,
  type OfferType,
  type PayPalClient,
  type ProvideEvidenceInput,
} from '@countersign/paypal'

import { derivedActionId } from './filer'
import { toJsonValue, type DefenderStore } from './ingest'
import {
  REQUEST_TOKEN_FOR_ACTION,
  actionWithinPosture,
  offerBudget,
  type StrategistAction,
  type StrategistPayPalMethod,
  type StrategistProposal,
} from './strategist'
import type { DisputeActionName, DisputeContext, LiabilityDecision } from './types'

/**
 * The PayPal calls an executed strategy may make. **`provideEvidence` is not in this `Pick`.**
 *
 * A second, independent statement of the same bound {@link StrategistPayPalMethod} makes at the type level:
 * even if a proposal somehow named `provideEvidence`, there is no method here to dispatch it to. Two
 * independent omissions, because one is a rename away from being undone.
 */
export type StrategistPayPal = Pick<
  PayPalClient,
  | 'sendMessage'
  | 'makeOffer'
  | 'acknowledgeReturnItem'
  | 'provideSupportingInfo'
  | 'appeal'
  | 'escalate'
>

export interface StrategistActionDeps {
  /** The only time source (AGENTS.md rule 10). */
  readonly clock: Clock
  readonly paypal: StrategistPayPal
  /** The rows this file reads and writes. The same {@link DefenderStore} the filer uses. */
  readonly store: DefenderStore
  readonly logger?: Logger
}

/**
 * `approvedBy` is **required**, and that *is* the enforcement of §8.16's "every action needs a merchant
 * click". A TypeScript caller cannot forget it, and there is no default actor anywhere in this file.
 */
export interface ExecuteOptions {
  /** Who clicked. `dispute_actions.actor`: `MERCHANT`, or a user id. */
  readonly approvedBy: string
  /** Why they clicked. Rendered in the S-17 timeline next to the action. */
  readonly approvalNote?: string
  /** The `packetVersion` slot of the request id. Defaults to `1`; raise it to re-issue a strategy. */
  readonly version?: number
  /**
   * Offers already made and not yet refunded **as of this click**.
   *
   * Threaded separately from the proposal because it can have changed in between, and
   * `Σ offers + prior refunds ≤ capture` has to hold at the moment money moves.
   */
  readonly priorOffers?: readonly Money[]
  /**
   * `make-offer`'s `offer_type`. **Derived when absent** — see {@link resolveOfferType}.
   */
  readonly offerType?: OfferType
  /** `make-offer`'s `return_shipping_address` (`address_portable`). Required for `REFUND_WITH_RETURN`. */
  readonly returnShippingAddress?: Record<string, unknown>
  /** `make-offer`'s `invoice_id`, 1–127 characters. `orders.invoice_id` is our own `ord_…`. */
  readonly invoiceId?: string
  /** `acknowledge-return-item`'s `acknowledgement_type`. Defaults to `ITEM_RECEIVED`. */
  readonly acknowledgementType?: AcknowledgementType
  /** `provide-supporting-info`'s files. Optional: the endpoint takes notes with no files, and EC-DSP-5's
   *  addition is usually text rather than another document. */
  readonly supportingFiles?: readonly EvidenceFile[]
  /**
   * `appeal`'s evidence body. **Required for `APPEAL`** — an appeal with no evidence would re-file nothing and
   * burn the appeal window, so `executeStrategy` refuses rather than posting an empty one.
   */
  readonly appealInput?: ProvideEvidenceInput
  /** `appeal`'s files, paired with {@link ExecuteOptions.appealInput}. */
  readonly appealFiles?: readonly EvidenceFile[]
}

export interface StrategyOutcome {
  readonly proposalId: string
  readonly disputeId: DisputeId
  readonly action: StrategistAction
  /** `true` only when PayPal accepted the call. */
  readonly sent: boolean
  /** The PayPal HATEOAS envelope, when there was one. */
  readonly links: unknown
  /** The `PayPal-Request-Id` sent, and the `dispute_actions.idempotency_key` written. */
  readonly requestId: string
  /** The amount sent, when the action moved money. */
  readonly amount: Money | null
  /**
   * The `dispute_actions` row. **Absent only for `REVIEW_WITH_HUMAN`**, which makes no PayPal call and has no
   * enum member — see {@link ACTION_ROW_NAME}.
   */
  readonly actionRow?: {
    readonly id: DisputeActionId
    readonly action: DisputeActionName
    readonly idempotencyKey: string
  }
  readonly paypalCalls: readonly string[]
  readonly warnings: readonly string[]
}

/**
 * `dispute_actions.action` for each strategist action — §7.2's enum, used verbatim.
 *
 * `REVIEW_WITH_HUMAN` maps to `null` and therefore **writes no row**: a person deciding is not a PayPal call,
 * and `dispute_actions` is documented as "every PayPal dispute API call we made". Inventing a member to log
 * "we did nothing" would put a false record in an audit table — the same reasoning as `REVIEW` in `filer.ts`.
 */
export const ACTION_ROW_NAME: Readonly<Record<StrategistAction, DisputeActionName | null>> =
  Object.freeze({
    MESSAGE_BUYER: 'MESSAGE',
    MAKE_OFFER: 'OFFER',
    ACKNOWLEDGE_RETURN: 'ACK_RETURN',
    ESCALATE: 'ESCALATE',
    APPEAL: 'APPEAL',
    PROVIDE_SUPPORTING_INFO: 'SUPPORTING_INFO',
    REVIEW_WITH_HUMAN: null,
  })

/**
 * Execute one strategy proposal, after the merchant clicked.
 *
 * @param proposal the proposal from `proposeStrategy`. Its `posture` and `ruleId` are re-checked against
 *   `decision`, so a proposal edited between screens is refused rather than sent.
 * @param decision the router's decision, re-supplied so the posture bound can be enforced at the boundary
 *   rather than trusted from the proposal's own copy of itself.
 * @param ctx the same context `proposeStrategy` was given, used for the money re-check.
 * @returns **A refused strategy is `ok` with `sent: false`** and a recorded row, for the same reason
 *   `fileDispute` refuses with `ok`: a refusal is a result a merchant and a judge need to see. The single
 *   `err` cases are a missing approval and a proposal outside its own posture — both mean the caller passed
 *   something this file must not act on at all.
 */
export async function executeStrategy(
  proposal: StrategistProposal,
  decision: LiabilityDecision,
  ctx: DisputeContext,
  deps: StrategistActionDeps,
  options: ExecuteOptions,
): Promise<Result<StrategyOutcome, CsError>> {
  const at = new Date(deps.clock.nowMs())
  const version = options.version ?? 1

  // --- 1. approval ------------------------------------------------------------------------------------
  if (typeof options.approvedBy !== 'string' || options.approvedBy.trim().length === 0) {
    return err(
      csError(
        'CS_VALIDATION',
        '§8.16 requires a merchant click before any dispute action is sent, and none was supplied. Nothing ' +
          'was sent to PayPal.',
        { proposal_id: proposal.proposalId, action: proposal.action },
        { userMessage: 'We need your approval before we send anything to PayPal.' },
      ),
    )
  }

  // --- 2. posture re-check -----------------------------------------------------------------------------
  if (!actionWithinPosture(proposal.action, decision)) {
    return err(
      csError(
        'CS_FORBIDDEN',
        `Proposal ${proposal.proposalId} asks for ${proposal.action}, which the ${decision.posture} posture does ` +
          'not permit. Nothing was sent. A strategist may only act within the posture the router gave it.',
        {
          proposal_id: proposal.proposalId,
          action: proposal.action,
          posture: decision.posture,
          rule_id: decision.ruleId,
        },
        { userMessage: 'That action is not available for this decision.' },
      ),
    )
  }

  // --- the deterministic request id (§0 rule 6) ----------------------------------------------------------
  const requestId = buildRequestId(proposal.disputeId as DisputeId, proposal.action, version)
  if (typeof requestId !== 'string') return requestId

  const paypalCalls: string[] = []
  const warnings: string[] = []
  const rowName = ACTION_ROW_NAME[proposal.action]

  // --- 5. idempotency, before anything is sent ------------------------------------------------------------
  const prior = await deps.store.actions.findByIdempotencyKey(requestId)
  if (!prior.ok) return prior
  if (prior.value !== undefined && responseSentPaypalCall(prior.value.response)) {
    warnings.push(
      `dispute_actions already records ${requestId} as sent. Nothing was sent again (EC-DSP-10).`,
    )
    return ok({
      proposalId: proposal.proposalId,
      disputeId: proposal.disputeId as DisputeId,
      action: proposal.action,
      sent: false,
      links: null,
      requestId,
      amount: proposal.amount,
      actionRow: {
        id: prior.value.id,
        action: prior.value.action,
        idempotencyKey: prior.value.idempotency_key,
      },
      paypalCalls: [],
      warnings,
    })
  }

  // --- 3/4. money, bodies, and the call -------------------------------------------------------------------
  //
  // **`ctx.dispute.paypalDisputeId`, never `proposal.disputeId`.** §0 rule 6 says a *request id* is derived from
  // our own ids, and it is: `requestId` above is `cs:{dsp_…}:{action}:{version}`. The **path** is the other way
  // round — `/v1/customer/disputes/{id}` takes *PayPal's* id. Passing `dsp_…` there produced a 404 on every
  // single strategy action, and because a refused action is `ok` with `sent: false` rather than an `err`, it
  // looked like a refusal policy rather than a wrong id. `ctx` is threaded in precisely so the boundary can read
  // the value it needs rather than trusting the proposal's own copy of itself.
  const paypalDisputeId = ctx.dispute.paypalDisputeId
  if (typeof paypalDisputeId !== 'string' || paypalDisputeId.trim().length === 0) {
    return err(
      csError(
        'CS_VALIDATION',
        'This dispute has no PayPal dispute id in its context, so there is no endpoint to call. Nothing was sent.',
        { dispute_id: proposal.disputeId, proposal_id: proposal.proposalId },
      ),
    )
  }
  const arm = await dispatch(proposal, decision, ctx, deps, options, {
    requestId,
    paypalCalls,
    paypalDisputeId,
  })

  // --- 6/7. the row, success or refusal --------------------------------------------------------------------
  return record(
    {
      proposal,
      deps,
      requestId,
      rowName,
      actor: options.approvedBy,
      options,
      at,
      paypalCalls,
      warnings,
    },
    arm.ok
      ? { sent: true, links: arm.links }
      : {
          sent: false,
          links: null,
          ...(arm.code === undefined ? {} : { code: arm.code }),
          refusal: arm.reason,
        },
  )
}

// ---------------------------------------------------------------------------
// dispatch: the one switch, one endpoint per arm (AT-M16.2)
// ---------------------------------------------------------------------------

interface ArmResult {
  readonly ok: boolean
  readonly links: unknown
  /** A local refusal's §8.1 code. Absent when `ok` is true. */
  readonly code?: CsError['code']
  /** A local refusal's sentence. Absent when `ok` is true. */
  readonly reason?: string
}

/**
 * AT-M16.2: **each action calls the right endpoint**, with the deterministic request id above.
 *
 * Every arm is one call, and the arm's `paypalCalls.push` happens **only on success** — so
 * `StrategyOutcome.paypalCalls` is a record of calls PayPal accepted, not of calls attempted, which is what
 * makes it comparable to `FileOutcome.paypalCalls`.
 */
async function dispatch(
  proposal: StrategistProposal,
  decision: LiabilityDecision,
  ctx: DisputeContext,
  deps: StrategistActionDeps,
  options: ExecuteOptions,
  state: {
    readonly requestId: string
    readonly paypalCalls: string[]
    readonly paypalDisputeId: string
  },
): Promise<ArmResult> {
  const { requestId, paypalCalls, paypalDisputeId } = state
  const copy = proposal.copy ?? proposal.reason

  switch (proposal.action) {
    case 'REVIEW_WITH_HUMAN':
      return refused(
        `Rule ${decision.ruleId} sent this to a person, so there is no PayPal call to make. The proposal is the ` +
          'record.',
      )

    case 'MESSAGE_BUYER': {
      const result = await deps.paypal.sendMessage(paypalDisputeId, copy, { requestId })
      if (result.ok) paypalCalls.push('sendMessage')
      return result.ok ? accepted(result.value) : fromError(result.error)
    }

    case 'MAKE_OFFER': {
      const amount = proposal.amount
      if (amount === null) {
        return refused(
          `Proposal ${proposal.proposalId} moves no money, so no offer was sent. Recompute the proposal.`,
        )
      }
      // **The `Σ offers + prior refunds ≤ capture` invariant, at the boundary.**
      const budget = offerBudget(ctx, options.priorOffers ?? [])
      if (amount.minor > budget.remaining.minor) {
        return refused(
          `The offer is ${amount.minor.toString()} minor units of ${amount.currency}, but only ` +
            `${budget.remaining.minor.toString()} remain on the capture after what is already refunded and ` +
            'offered. Nothing was sent.',
        )
      }
      const offerType = resolveOfferType(options)
      if (typeof offerType !== 'string') {
        return refused(
          `The offer could not be built: ${(offerType as { error: CsError }).error.message}`,
        )
      }
      const address = offerType === 'REFUND_WITH_RETURN' ? options.returnShippingAddress : undefined
      const result = await deps.paypal.makeOffer(
        paypalDisputeId,
        {
          note: copy,
          offer_type: offerType,
          offer_amount: { currency_code: amount.currency, value: toPayPalValue(amount) },
          ...(address === undefined ? {} : { return_shipping_address: address }),
          ...(options.invoiceId === undefined ? {} : { invoice_id: options.invoiceId }),
        },
        { requestId },
      )
      if (result.ok) paypalCalls.push('makeOffer')
      return result.ok ? accepted(result.value) : fromError(result.error)
    }

    case 'ACKNOWLEDGE_RETURN': {
      const type = options.acknowledgementType ?? 'ITEM_RECEIVED'
      if (!(ACKNOWLEDGEMENT_TYPES as readonly string[]).includes(type)) {
        return refused(
          `${type} is not one of PayPal's acknowledgement_type values (${ACKNOWLEDGEMENT_TYPES.join(', ')}). ` +
            'Nothing was sent.',
        )
      }
      const result = await deps.paypal.acknowledgeReturnItem(
        paypalDisputeId,
        { acknowledgement_type: type, note: copy },
        { requestId },
      )
      if (result.ok) paypalCalls.push('acknowledgeReturnItem')
      return result.ok ? accepted(result.value) : fromError(result.error)
    }

    case 'ESCALATE': {
      const result = await deps.paypal.escalate(paypalDisputeId, copy, { requestId })
      if (result.ok) paypalCalls.push('escalate')
      return result.ok ? accepted(result.value) : fromError(result.error)
    }

    case 'PROVIDE_SUPPORTING_INFO': {
      // EC-DSP-5: name what is new. "New since the filed packet: …" is the honest framing, because these
      // notes *add to* the packet rather than replace it.
      const notes =
        proposal.newFacts.length === 0
          ? copy
          : `${copy} New since the filed packet: ${proposal.newFacts.join(', ')}.`
      const result = await deps.paypal.provideSupportingInfo(
        paypalDisputeId,
        notes,
        [...(options.supportingFiles ?? [])],
        { requestId },
      )
      if (result.ok) paypalCalls.push('provideSupportingInfo')
      return result.ok ? accepted(result.value) : fromError(result.error)
    }

    case 'APPEAL': {
      if (options.appealInput === undefined) {
        return refused(
          'An appeal carries an evidence body, and none was supplied. Posting an empty appeal would spend the ' +
            'appeal window re-filing nothing, so nothing was sent.',
        )
      }
      const result = await deps.paypal.appeal(
        paypalDisputeId,
        options.appealInput,
        [...(options.appealFiles ?? [])],
        { requestId },
      )
      if (result.ok) paypalCalls.push('appeal')
      return result.ok ? accepted(result.value) : fromError(result.error)
    }

    default:
      return refused(
        `${String(proposal.action)} is not a strategy action this package can execute.`,
      )
  }
}

function accepted(links: unknown): ArmResult {
  return { ok: true, links }
}

function refused(reason: string): ArmResult {
  return { ok: false, links: null, code: 'CS_VALIDATION', reason }
}

function fromError(error: CsError): ArmResult {
  return { ok: false, links: null, code: error.code, reason: error.message }
}

/**
 * `offer_type` and its required companion travel together.
 *
 * PayPal requires `return_shipping_address` for `REFUND_WITH_RETURN` (`SPEC-D`), so a caller that supplies a
 * return address gets the EC-BUY-1 offer and a caller that does not gets `REFUND`. Passing the two
 * inconsistently is the 400 this function exists to prevent.
 *
 * @returns the `offer_type`, or `{ error }` when the pair is inconsistent — a `Result`-shaped return rather
 *   than a throw, so the caller records a refusal rather than an exception mid-execution.
 */
export function resolveOfferType(options: ExecuteOptions): OfferType | { readonly error: CsError } {
  if (options.offerType === undefined) {
    return options.returnShippingAddress === undefined ? 'REFUND' : 'REFUND_WITH_RETURN'
  }
  if (!(OFFER_TYPES as readonly string[]).includes(options.offerType)) {
    return {
      error: csError(
        'CS_VALIDATION',
        `${options.offerType} is not a PayPal offer_type (${OFFER_TYPES.join(', ')})`,
        { requested: options.offerType, allowed: [...OFFER_TYPES] },
      ),
    }
  }
  if (options.offerType === 'REFUND_WITH_RETURN' && options.returnShippingAddress === undefined) {
    return {
      error: csError(
        'CS_VALIDATION',
        'PayPal requires return_shipping_address when offer_type is REFUND_WITH_RETURN, and none was ' +
          'supplied. EC-BUY-1 recommends that offer, so pass a return address or ask for a plain refund.',
        { requested: options.offerType },
      ),
    }
  }
  return options.offerType
}

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

/** `disputeActionRequestId` can throw on a bad token; convert that into a `Result` rather than an exception. */
function buildRequestId(
  disputeId: DisputeId,
  action: StrategistAction,
  version: number,
): string | Result<never, CsError> {
  try {
    return disputeActionRequestId(
      disputeId,
      REQUEST_TOKEN_FOR_ACTION[action] as DisputeActionToken,
      version,
    )
  } catch (cause) {
    return err(
      csError(
        'CS_VALIDATION',
        `Could not build a deterministic request id for action token "${REQUEST_TOKEN_FOR_ACTION[action]}": ` +
          `${cause instanceof Error ? cause.message : String(cause)}. Nothing was sent.`,
        { action, token: REQUEST_TOKEN_FOR_ACTION[action] },
      ),
    )
  }
}

/** Did this row record a call that actually went out? EC-DSP-10's rule, applied to a strategy action. */
export function responseSentPaypalCall(response: unknown): boolean {
  return (
    response !== null &&
    typeof response === 'object' &&
    (response as Record<string, unknown>)['paypal_call'] === 'sent'
  )
}

interface RecordInput {
  readonly proposal: StrategistProposal
  readonly deps: StrategistActionDeps
  readonly requestId: string
  readonly rowName: DisputeActionName | null
  readonly actor: string
  readonly options: ExecuteOptions
  readonly at: Date
  readonly paypalCalls: string[]
  readonly warnings: string[]
}

/** Write the `dispute_actions` row and build the outcome. §8.16: "logged in `dispute_actions`". */
async function record(
  input: RecordInput,
  response: Record<string, unknown>,
): Promise<Result<StrategyOutcome, CsError>> {
  const { proposal, deps, requestId, rowName, actor, options, at, paypalCalls, warnings } = input
  const sent = response['sent'] === true

  const request = toJsonValue({
    disposition: proposal.action,
    rule_id: proposal.ruleId,
    posture: proposal.posture,
    proposal_id: proposal.proposalId,
    reason: proposal.reason,
    ...(proposal.amount === null
      ? {}
      : {
          amount_minor: proposal.amount.minor.toString(),
          currency: proposal.amount.currency,
          // The PayPal-side decimal string, so the case file shows exactly what went on the wire.
          paypal_value: toPayPalValue(proposal.amount),
        }),
    // §8.16's cost comparison, with the label. Both are stored so a UI can render them without recomputing.
    cost_refund_minor: proposal.cost.refundMinor.toString(),
    cost_handling_minor: proposal.cost.handlingCostMinor.toString(),
    cost_verdict: proposal.cost.verdict,
    cost_label: proposal.cost.handlingCostLabel,
    new_facts: proposal.newFacts,
    approved_by: actor,
    ...(options.approvalNote === undefined ? {} : { approval_note: options.approvalNote }),
  }) as JsonValue

  const key = sent ? requestId : `${requestId}:nofile`
  let actionRow: StrategyOutcome['actionRow']

  if (rowName === null) {
    // `REVIEW_WITH_HUMAN`: no PayPal call, therefore no `dispute_actions` row. Said out loud in `warnings` so
    // the absent `actionRow` is never a mystery to a reader.
    warnings.push(
      'REVIEW_WITH_HUMAN makes no PayPal call, and `dispute_actions.action` has no member for "a person ' +
        'decided", so no row was written. The proposal is the record.',
    )
  } else {
    const recorded = await deps.store.actions.record({
      id: derivedActionId(key),
      dispute_id: proposal.disputeId,
      action: rowName,
      request,
      response: toJsonValue({
        ...response,
        sent,
        // **`paypal_call`, not just `sent`.** {@link responseSentPaypalCall} — which is what EC-DSP-10's dedupe
        // reads — looks for `paypal_call === 'sent'`, and `filer.ts` writes the same key. Writing only `sent`
        // meant a second execution of the same proposal found nothing, tried to write the row again, and came
        // back `CS_CONFLICT` from the UNIQUE constraint: idempotent by accident, and *loudly* so.
        paypal_call: sent ? 'sent' : 'none',
        paypal_calls: paypalCalls,
      }) as JsonValue,
      actor,
      idempotency_key: key,
      at,
    } as NewDisputeAction)
    if (!recorded.ok) return recorded
    actionRow = {
      id: recorded.value.id,
      action: recorded.value.action,
      idempotencyKey: recorded.value.idempotency_key,
    }
  }

  deps.logger?.info(`defender.strategy: ${proposal.action} ${sent ? 'sent' : 'not sent'}`, {
    dispute_id: proposal.disputeId,
    rule_id: proposal.ruleId,
    posture: proposal.posture,
    request_id: requestId,
    paypal_calls: paypalCalls,
  })

  return ok({
    proposalId: proposal.proposalId,
    disputeId: proposal.disputeId as DisputeId,
    action: proposal.action,
    sent,
    links: response['links'] ?? null,
    requestId,
    amount: proposal.amount,
    ...(actionRow === undefined ? {} : { actionRow }),
    paypalCalls: [...paypalCalls],
    warnings: [...warnings],
  })
}

/** The row vocabulary, re-exported so a caller needs one import for the whole boundary. */
export type { DisputeActionRow, NewDisputeAction, JsonValue, StrategistPayPalMethod }
