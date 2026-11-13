/**
 * `ingestAndDefend` — spec **§10.2** rows 13–16, **§8.12**, **§8.15**, **§8.16**, §12.11, core invariant
 * **I-1** (§3.1).
 *
 * ## The order, and the rule underneath it
 *
 * ```
 *   paypal.getDispute(id) ──▶ ingestDisputeToDefender(raw) ──▶ fileDispute(disputeId, deps, options)
 *        §8.12 step 2              §8.12 rank + §8.15 join          §8.15 route → log → guard → act
 * ```
 *
 * **The fetch is not optional and the payload is not a substitute for it.** §3.3's rule is "never trust
 * payload state": a webhook body is a hint about *what to re-fetch*, and `getDispute` is the only thing
 * that establishes stage, status, reason and both deadlines. Ingesting a payload directly would produce a
 * case file built on the one copy of the dispute that is known to be lossy, duplicated and reordered.
 *
 * So this function's first argument is a **resource id**, not a dispute body. That is also what makes the
 * function usable from the 2-minute sweep (`listDisputes` → id → here) and from a webhook (body → id →
 * here) without either path being able to shortcut the fetch.
 *
 * ## What the caller gets back when the filing is refused
 *
 * `fileDispute` returns `ok` for a refusal — a deadline passed, a buyer withdrawal, a citation failure —
 * because a refusal is a recorded outcome the S-17 timeline shows, not a fault. So is this function's
 * return: `err` means *we could not get as far as a decision*, `ok` with `file.refusal` means the Defender
 * decided and recorded why it declined to act. Collapsing those two would lose every refusal from the
 * merchant's dispute history, which is the artefact the whole product exists to produce.
 */
import { csError, err, ok, type CsError, type Logger, type Result } from '@countersign/core'
import type { PayPalClient } from '@countersign/paypal'

import type { DefenderSeam, DefendOutcome } from './types'

/** Where the dispute id came from. Both callers converge on {@link ingestAndDefend}. */
export interface DisputeSource {
  /** PayPal's `dispute_id`. Never our `dsp_…`. */
  readonly paypalDisputeId: string
}

/** The PayPal reads this function makes — a `Pick`, so the real client satisfies it structurally. */
export type DisputePayPal = Pick<PayPalClient, 'getDispute'>

/**
 * The deps {@link ingestAndDefend} reaches — and exactly those.
 *
 * It used to `extends OrchestratorDeps`, which meant the worker process that runs §8.12's 2-minute
 * dispute sweep needed the entire purchase stack (`compiler`, `gate`, `orders`, `budget`,
 * `store`) wired just to satisfy members this function never reads. Narrowed to the Pick-style
 * members the body uses, the same way {@link DisputePayPal} is a `Pick` of the client rather than
 * the client. A caller that already has a full `OrchestratorDeps` still satisfies this
 * structurally — narrowing a type can only widen its accepted values.
 */
export interface IngestAndDefendDeps {
  /** §10.2 row 13. `PayPalClient.getDispute`, with an injected `fetchImpl` in tests. */
  readonly paypal: DisputePayPal
  /** §8.15. The two Defender calls, plus the whole `DefenderDeps` as `fileDispute` needs it. */
  readonly defender: DefenderSeam & {
    /** The whole `DefenderDeps`, which `fileDispute` extends with its optional model port. */
    readonly deps: Parameters<DefenderSeam['file']>[1]
  }
  /** Optional. Never for content — the Defender's composed copy still comes from the router. */
  readonly logger?: Logger
}

/**
 * §10.2's dispute path: fetch, ingest, then file.
 *
 * @param source which dispute to act on.
 * @param options forwarded to `fileDispute`. `approval` is what turns a `CONTEST` posture into a real
 *   `provide-evidence` call; with it absent the outcome is `awaitingApproval: true` and **no** PayPal write
 *   happened beyond the `disputes`/`dispute_actions` rows.
 */
export async function ingestAndDefend(
  source: DisputeSource,
  deps: IngestAndDefendDeps,
  options: Parameters<DefenderSeam['file']>[2] = {},
): Promise<Result<DefendOutcome, CsError>> {
  const paypalDisputeId = source.paypalDisputeId.trim()
  if (paypalDisputeId === '') {
    return err(
      csError(
        'CS_VALIDATION',
        'No PayPal dispute id was given, so there is nothing to re-fetch and nothing to file.',
        { field: 'paypalDisputeId' },
      ),
    )
  }

  // --- 1. Re-fetch. The only source of truth about the dispute's state. --------------------------
  const fetched = await deps.paypal.getDispute(paypalDisputeId)
  if (!fetched.ok) return fetched

  // --- 2. Ingest: validate, rank, join, store, link, build the context. ---------------------------
  const ingested = await deps.defender.ingest(fetched.value, deps.defender.deps)
  if (!ingested.ok) return ingested
  const { dispute, linked, warnings } = ingested.value

  deps.logger?.info('orchestrator.dispute: ingested', {
    paypal_dispute_id: paypalDisputeId,
    dispute_id: dispute.id,
    stage: dispute.stage,
    status: dispute.status,
    linked,
    warnings,
  })

  // --- 3. Route, log the rule, guard the clock, and only then act. -------------------------------
  const filed = await deps.defender.file(dispute.id, deps.defender.deps, options)
  if (!filed.ok) return filed

  deps.logger?.info('orchestrator.dispute: filed', {
    paypal_dispute_id: paypalDisputeId,
    dispute_id: dispute.id,
    disposition: filed.value.disposition,
    posture: filed.value.decision.posture,
    liability: filed.value.decision.liability,
    filed: filed.value.filed,
    already_filed: filed.value.alreadyFiled,
    awaiting_approval: filed.value.awaitingApproval,
    paypal_calls: filed.value.paypalCalls,
  })

  return ok({
    paypalDisputeId,
    disputeId: dispute.id,
    linked,
    file: filed.value,
    posture: filed.value.decision.posture,
  })
}
