/**
 * The merchant's click — spec **§8.15**, **§8.16**, S-17.
 *
 * ## The one rule this module exists to enforce
 *
 * §8.15: *"Every action needs a merchant click and is logged in `dispute_actions`."* The click is the
 * only thing that separates a case file from a PayPal write, so everything here is about making the click
 * **informed**, **attributable** and **impossible to double-apply**:
 *
 * - **Informed** — the click is made on a page that shows the stored verdict, the rule, the facts, the
 *   rationale and the evidence PayPal will receive (`lib/dispute-detail.ts`).
 * - **Attributable** — the actor is the session's user id, the audit row is hash-chained into a per-case
 *   chain, and the `dispute_actions.actor` the filer writes is the same id.
 * - **Impossible to double-apply** — a second click on a case that has already moved past approval is
 *   answered without a PayPal call, and a click that races another one is answered by the filer's own
 *   idempotency key (`cs:{disputeId}:…`, a UNIQUE column) as `CS_CONFLICT`.
 *
 * ## What a decline does, and what it deliberately does not
 *
 * A decline records the decision and **changes nothing else**. There is no `DECLINED` member in §3.3's
 * `defense_state`, and inventing one would be a schema change this module has no business making: the case
 * stays `AWAITING_MERCHANT_APPROVAL`, the deadline keeps running, and the merchant can change their mind
 * and approve later. The audit row is the record that they said no, and when.
 *
 * ## Why the filer runs here rather than in the worker
 *
 * The click has to produce an answer the merchant can read. `fileDispute` is synchronous, idempotent by
 * construction, and every one of its exits writes a `dispute_actions` row — so the request that carries
 * the click returns the disposition, the refusal (if any) and the PayPal calls it made, in one round trip.
 * A queue would make the merchant come back and look.
 */
import { createHash } from 'node:crypto'

import {
  csError,
  err,
  ok,
  type AuditLogId,
  type CsError,
  type DisputeActionId,
  type DisputeId,
  type Result,
  type UserId,
} from '@countersign/core'
import { appendAudit, findDisputeBuyerUserId, findDisputeForMerchant } from '@countersign/db'
import { fileDispute } from '@countersign/defender'
import type { FileDeps, FileOutcome } from '@countersign/orchestrator'

import { defenderFileDeps } from './defender-runtime'

/** What the merchant said. Two values, because those are the two things §8.15 allows. */
export type DisputeDecision = 'approve' | 'decline'

/** The audit actions this module writes. Named constants so a test and the log cannot disagree. */
export const AUDIT_APPROVED = 'DISPUTE_APPROVED'
export const AUDIT_DECLINED = 'DISPUTE_DECLINED'
export const AUDIT_ALREADY_FILED = 'DISPUTE_APPROVAL_SUPERSEDED'

/**
 * States that mean "the click has already been acted on".
 *
 * `AWAITING_MERCHANT_APPROVAL` and `ANALYSED`/`NEW` are **not** in here: those are the states the surface
 * acts on. Everything past the click — `FILED`, `OFFERED`, `ACCEPTED` and the four `CLOSED_*` — is a
 * PayPal action that already happened, and a second one is a second PayPal action.
 */
const PAST_APPROVAL: ReadonlySet<string> = new Set([
  'FILED',
  'OFFERED',
  'ACCEPTED',
  'CLOSED_WON',
  'CLOSED_LOST',
  'CLOSED_REFUNDED',
])

/** What the merchant gets back. Every field is present, including the ones that are empty. */
export interface DecisionOutcome {
  readonly disputeId: string
  readonly paypalDisputeId: string
  readonly decision: DisputeDecision
  /** `false` when the case had already moved past approval and nothing was sent. */
  readonly applied: boolean
  /** `true` when the router's own answer was "a human decides" — no PayPal action was possible. */
  readonly awaitingApproval: boolean
  readonly awaitingHuman: boolean
  /** `dispute_actions.action` this run recorded, or `null` for a decline. */
  readonly disposition: string | null
  readonly filed: boolean
  /** The rule the router applied, read back off the outcome after the run. */
  readonly ruleId: string | null
  readonly refusal: { readonly code: string; readonly reason: string } | null
  /** Every PayPal method this run actually called. Empty is a claim, not a default. */
  readonly paypalCalls: readonly string[]
  readonly auditId: string
  readonly actionRowId: DisputeActionId | null
}

/** What {@link decideDispute} reaches beyond the database. Injected in tests. */
export interface DecisionDeps {
  /** The filer. Defaults to the real `fileDispute`; a test passes a recording stub. */
  readonly file?: typeof fileDispute
  /** The filer's dependencies. Defaults to `defenderFileDeps`, which is the real wiring. */
  readonly fileDeps?: () => Result<FileDeps, CsError>
  /** The clock for the audit row's `at`. Defaults to now. */
  readonly now?: () => Date
}

/**
 * Apply a merchant's decision to one dispute.
 *
 * @param input.disputeId our `dsp_…` id, never PayPal's — the URL carries ours and PayPal's is a column.
 * @param input.actorUserId the session's user, which is who the audit chain attributes the click to.
 * @param input.note the merchant's own words, when they typed any. Recorded verbatim, never parsed.
 */
export async function decideDispute(
  input: {
    readonly disputeId: string
    readonly merchantId: string
    readonly decision: DisputeDecision
    readonly actorUserId: UserId
    readonly note?: string
  },
  deps: DecisionDeps = {},
): Promise<Result<DecisionOutcome, CsError>> {
  const file = deps.file ?? fileDispute
  const at = (deps.now ?? (() => new Date()))()
  const auditId = decisionAuditId(input.disputeId, input.decision, at)

  // --- 1. the row ---------------------------------------------------------------------------------
  const found = await findDisputeForMerchant(input.disputeId, input.merchantId)
  if (!found.ok) return found
  const row = found.value
  if (row === undefined) {
    return err(
      csError(
        'CS_NOT_FOUND',
        `No disputes row for ${input.disputeId}.`,
        { dispute_id: input.disputeId },
        { userMessage: 'That dispute is not in this deployment’s records.' },
      ),
    )
  }

  // --- 2. the case is not already past the click ---------------------------------------------------
  if (PAST_APPROVAL.has(row.defense_state)) {
    return err(
      csError(
        'CS_CONFLICT',
        `Dispute ${row.id} is already ${row.defense_state}; a second approval would be a second PayPal action.`,
        { dispute_id: row.id, defense_state: row.defense_state },
        {
          userMessage:
            'This dispute has already been filed or settled, so there is nothing left to approve.',
          retryable: false,
        },
      ),
    )
  }

  // --- 3. separation of duty: the buyer cannot authorise the filing against themselves -------------
  const buyer = await findDisputeBuyerUserId(row.id as DisputeId)
  if (!buyer.ok) return buyer
  if (buyer.value !== undefined && buyer.value === (input.actorUserId as string)) {
    return err(
      csError(
        'CS_FORBIDDEN',
        'The buyer on this order cannot authorise the merchant’s filing, or a refund to themselves.',
        { dispute_id: row.id },
        {
          userMessage:
            'This action belongs to the merchant. A buyer cannot approve a dispute filed against them.',
        },
      ),
    )
  }

  const note = input.note === undefined || input.note === '' ? undefined : input.note

  // --- 4a. a decline is a record, not an action ----------------------------------------------------
  if (input.decision === 'decline') {
    const recorded = await appendAudit({
      id: auditId as AuditLogId,
      chainId: row.id,
      actor: input.actorUserId as string,
      action: AUDIT_DECLINED,
      subject: row.id,
      at,
      details: {
        message: 'The merchant declined the router’s recommendation. Nothing was sent to PayPal.',
        dispute_id: row.id,
        paypal_dispute_id: row.paypal_dispute_id,
        liability: row.liability,
        defense_state: row.defense_state,
        note: note ?? null,
        buyer_user_id: buyer.value ?? null,
      },
    })
    if (!recorded.ok) return recorded
    return ok({
      disputeId: row.id,
      paypalDisputeId: row.paypal_dispute_id,
      decision: 'decline',
      applied: false,
      awaitingApproval: true,
      awaitingHuman: false,
      disposition: null,
      filed: false,
      ruleId: null,
      refusal: null,
      paypalCalls: [],
      auditId: recorded.value.id,
      actionRowId: null,
    })
  }

  // --- 4b. an approval runs the real filer ---------------------------------------------------------
  const built = (deps.fileDeps ?? defenderFileDeps)()
  if (!built.ok) return built

  const outcome = await file(row.id, built.value, {
    approval: { by: input.actorUserId as string, ...(note === undefined ? {} : { note }) },
  })
  if (!outcome.ok) {
    // A `CS_CONFLICT` here is the filer's own idempotency key refusing a second record for one attempt —
    // which is the double-click case, not a fault. Say so plainly rather than as a bare 409.
    if (outcome.error.code === 'CS_CONFLICT') {
      return recordSuperseded(row.id, row.paypal_dispute_id, input.actorUserId, auditId, at)
    }
    return outcome
  }

  // --- 5. the case file records what the router decided, and what we did about it -------------------
  const recorded = await appendAudit({
    id: auditId as AuditLogId,
    chainId: row.id,
    actor: input.actorUserId as string,
    action: AUDIT_APPROVED,
    subject: row.id,
    at,
    details: {
      message: approvedMessage(outcome.value),
      dispute_id: row.id,
      paypal_dispute_id: row.paypal_dispute_id,
      rule_id: outcome.value.decision.ruleId,
      liability: outcome.value.decision.liability,
      posture: outcome.value.decision.posture,
      disposition: outcome.value.disposition,
      filed: outcome.value.filed,
      already_filed: outcome.value.alreadyFiled,
      awaiting_approval: outcome.value.awaitingApproval,
      awaiting_human: outcome.value.awaitingHuman,
      paypal_calls: outcome.value.paypalCalls,
      refusal: outcome.value.refusal ?? null,
      packet: outcome.value.packet ?? null,
      refund_id: outcome.value.refund?.refundId ?? null,
      action_row_id: outcome.value.actionRow?.id ?? null,
      note: note ?? null,
      buyer_user_id: buyer.value ?? null,
    },
  })
  if (!recorded.ok) return recorded

  return ok({
    disputeId: row.id,
    paypalDisputeId: row.paypal_dispute_id,
    decision: 'approve',
    applied: outcome.value.filed || outcome.value.paypalCalls.length > 0,
    awaitingApproval: outcome.value.awaitingApproval,
    awaitingHuman: outcome.value.awaitingHuman,
    disposition: outcome.value.disposition,
    filed: outcome.value.filed,
    ruleId: outcome.value.decision.ruleId,
    refusal:
      outcome.value.refusal === undefined
        ? null
        : { code: outcome.value.refusal.code, reason: outcome.value.refusal.reason },
    paypalCalls: outcome.value.paypalCalls,
    auditId: recorded.value.id,
    actionRowId: outcome.value.actionRow?.id ?? null,
  })
}

/** The `CS_CONFLICT` branch: one attempt, one record, and a row that says a second click arrived. */
async function recordSuperseded(
  disputeId: string,
  paypalDisputeId: string,
  actor: string,
  auditId: string,
  at: Date,
): Promise<Result<DecisionOutcome, CsError>> {
  const recorded = await appendAudit({
    id: auditId as AuditLogId,
    chainId: disputeId,
    actor,
    action: AUDIT_ALREADY_FILED,
    subject: disputeId,
    at,
    details: {
      message:
        'A second approval arrived for an attempt that was already recorded. Nothing was sent twice.',
      dispute_id: disputeId,
      paypal_dispute_id: paypalDisputeId,
    },
  })
  if (!recorded.ok) return recorded
  return ok({
    disputeId,
    paypalDisputeId,
    decision: 'approve',
    applied: false,
    awaitingApproval: false,
    awaitingHuman: false,
    disposition: null,
    filed: false,
    ruleId: null,
    refusal: null,
    paypalCalls: [],
    auditId: recorded.value.id,
    actionRowId: null,
  })
}

/** The one-line summary the audit row carries. Composed here so the log and the UI cannot disagree. */
export function approvedMessage(outcome: FileOutcome): string {
  if (outcome.refusal !== undefined) return `Approved, refused: ${outcome.refusal.reason}`
  if (outcome.filed) return `Approved and filed with PayPal (${outcome.paypalCalls.join(', ')}).`
  if (outcome.paypalCalls.length > 0) {
    return `Approved; PayPal called (${outcome.paypalCalls.join(', ')}).`
  }
  if (outcome.awaitingHuman) return 'Approved, but a human still has to decide; nothing was sent.'
  if (outcome.awaitingApproval) return 'Approved; recorded, and still waiting on a PayPal action.'
  return 'Approved; no PayPal action was required.'
}

/**
 * A stable audit id for one decision.
 *
 * The chain's position is the entry's identity (`audit_log.id` is a mint, not a fact), but a merchant who
 * clicks twice in ten seconds should produce two rows rather than one row that silently lost a click. So
 * the id is derived from the case, the decision and the click's own timestamp: two different clicks never
 * collide, and a replay of the *same* request does not write a second row.
 */
export function decisionAuditId(disputeId: string, decision: DisputeDecision, at: Date): string {
  const digest = createHash('sha256')
    .update(`${disputeId}:${decision}:${at.toISOString()}`, 'utf8')
    .digest('hex')
  return `aud_${digest.slice(0, 26)}`
}
