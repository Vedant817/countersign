/**
 * `wh.disputes`'s defend step — spec **§10.2 rows 13–16**, **§8.12**, **§8.15**, **§8.16**.
 *
 * ## The gap this closes
 *
 * The 2-minute dispute sweep (`reconcileDisputes`) stores and ranks real disputes, but nothing called
 * `orchestrator.ingestAndDefend`, so a stored dispute's `liability` stayed `null` for ever: the
 * router's answer existed only as an un-run function, and `/disputes` showed "not assessed yet" for
 * cases PayPal had been waiting on for weeks. This job is the caller §8.12 step 6 always implied:
 * after the sweep, take the rows the router has not spoken on and run the fetch → ingest → file
 * pipeline on them.
 *
 * ## The approval rule, and why no PayPal write happens here
 *
 * `ingestAndDefend` is invoked with **no `approval` option**, ever. §8.15 requires a merchant
 * approval click before any PayPal action; `fileDispute` enforces it at its approval gate — *before*
 * the posture dispatch — and returns `awaitingApproval: true` with **zero PayPal calls** when no
 * approval was passed. Every posture exits there, including REFUND: an approval-less call cannot
 * move money, cannot send a message, cannot upload evidence. What it does do is everything this job
 * wants: fetch the truth from PayPal, run the deterministic router, and record the verdict, the rule
 * that fired and the posture in `disputes.liability` / `disputes.router_trace`.
 *
 * Filing itself is therefore a merchant action (`AWAITING_MERCHANT_APPROVAL`), which is also the
 * honest state: the S-17 workspace that would approve a filing does not exist yet, and a worker that
 * approved its own refunds would be a money bug with a cron expression.
 *
 * ## The ports, and why this file is testable
 *
 * The job body takes {@link DefendDeps} — a candidate lister and a one-dispute defender — so a test
 * drives it with recordings and asserts boundedness and failure tolerance without a database or a
 * PayPal stub. The production wiring in `index.ts` binds them to `findDisputesNeedingAssessment`
 * and `ingestAndDefend`; the "no approval" fact lives there, in the one place a reviewer looks.
 */
import { csError, err, ok, type CsError, type Logger, type Result } from '@countersign/core'
import type { DisputeRow } from '@countersign/db'
import {
  ingestAndDefend,
  type DefendOutcome,
  type IngestAndDefendDeps,
} from '@countersign/orchestrator'

import type { JobHandler } from '@countersign/webhooks'

/** Disputes defended per tick. §8.12's sweep batch is 25; the defend step is bounded under it. */
export const DEFEND_BATCH = 10

/** What one defend tick did, in the counts an operator reads off the job log. */
export interface DefendReport {
  /** Rows the candidate query returned. */
  readonly candidates: number
  /** Rows whose pipeline ran to an outcome — a verdict, a refusal, or `awaitingApproval`. */
  readonly assessed: number
  /** Rows whose outcome was `awaitingApproval` (§8.15: a human click is next). */
  readonly awaitingApproval: number
  /** Rows whose outcome was a recorded refusal (a deadline, a withdrawal, `DEF_NO_CHAIN`, …). */
  readonly refused: number
  /** Rows whose pipeline could not reach a decision (`err`); they stay in the queue. */
  readonly failed: number
  /** PayPal dispute ids that failed, so the next cron tick's log names them. */
  readonly failures: readonly { paypalDisputeId: string; code: string; message: string }[]
}

/** The two things the job needs, named so a test can record them. */
export interface DefendDeps {
  /** `repos/disputes.ts::findDisputesNeedingAssessment` — the router's queue, most urgent first. */
  listCandidates(limit: number): Promise<Result<DisputeRow[], CsError>>
  /** `orchestrator.ingestAndDefend` — fetch, ingest, file. Never called with an approval. */
  defendOne(row: DisputeRow): Promise<Result<DefendOutcome, CsError>>
  readonly logger?: Logger
}

/**
 * The defend step as a `JobHandler`.
 *
 * One dispute's failure is that dispute's problem — it is logged, counted and left in the queue, and
 * the next tick (two minutes away) picks it up again. A PayPal outage fails **every** candidate, so
 * the report would always read `failed === candidates`; to keep the queue's retry semantics honest,
 * an all-failed tick returns `err` rather than a green report that hid the outage.
 */
export function defendDisputesJob(
  deps: DefendDeps,
  options: { readonly limit?: number } = {},
): JobHandler {
  const limit = options.limit ?? DEFEND_BATCH
  return async () => {
    const candidates = await deps.listCandidates(limit)
    if (!candidates.ok) return candidates

    let assessed = 0
    let awaitingApproval = 0
    let refused = 0
    const failures: { paypalDisputeId: string; code: string; message: string }[] = []

    for (const row of candidates.value) {
      const outcome = await deps.defendOne(row)
      if (!outcome.ok) {
        failures.push({
          paypalDisputeId: row.paypal_dispute_id,
          code: outcome.error.code,
          message: outcome.error.message,
        })
        deps.logger?.warn('defend step could not reach a decision', {
          module: 'worker.defend',
          dispute_id: row.id,
          paypal_dispute_id: row.paypal_dispute_id,
          code: outcome.error.code,
          message: outcome.error.message,
        })
        continue
      }
      assessed += 1
      if (outcome.value.file.awaitingApproval) awaitingApproval += 1
      if (outcome.value.file.refusal !== undefined && !outcome.value.file.awaitingApproval) {
        refused += 1
      }
      deps.logger?.info('defend step recorded an outcome', {
        module: 'worker.defend',
        dispute_id: outcome.value.disputeId,
        paypal_dispute_id: outcome.value.paypalDisputeId,
        linked: outcome.value.linked,
        posture: outcome.value.posture,
        liability: outcome.value.file.decision.liability,
        rule: outcome.value.file.decision.ruleId,
        awaiting_approval: outcome.value.file.awaitingApproval,
      })
    }

    const failed = failures.length
    deps.logger?.info('defend step finished', {
      module: 'worker.defend',
      candidates: candidates.value.length,
      assessed,
      awaiting_approval: awaitingApproval,
      refused,
      failed,
    })
    // A PayPal outage (or an unreachable store) fails *every* candidate. A green report would hide
    // that, so an all-failed tick is an `err`; the first failure's own code decides whether the
    // queue retries — `csError`'s registry keeps `retryable` derived, never hand-set.
    if (candidates.value.length > 0 && failed === candidates.value.length) {
      const first = failures[0]!
      return err(
        csError(first.code as CsError['code'], first.message, {
          paypal_dispute_ids: failures.map((f) => f.paypalDisputeId),
        }),
      )
    }
    return ok({
      candidates: candidates.value.length,
      assessed,
      awaitingApproval,
      refused,
      failed,
      failures,
    })
  }
}

/**
 * The production {@link DefendDeps}, bound here rather than in `defendDisputesJob` so the job body
 * stays a pure function of its ports.
 *
 * The one fact worth restating where a reviewer will see it: **`options` is `{}`** — no `approval`,
 * which is what makes the whole pipeline approval-gated (§8.15). Every PayPal call below `getDispute`
 * is unreachable from this wiring.
 */
export function productionDefendDeps(
  ingestDeps: IngestAndDefendDeps,
  listCandidates: DefendDeps['listCandidates'],
  logger?: Logger,
): DefendDeps {
  return {
    listCandidates,
    defendOne: (row) => ingestAndDefend({ paypalDisputeId: row.paypal_dispute_id }, ingestDeps, {}),
    ...(logger ? { logger } : {}),
  }
}
