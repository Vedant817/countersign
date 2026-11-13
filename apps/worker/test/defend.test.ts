/**
 * The defend step's own contract, driven with recording ports — no database, no PayPal.
 *
 * The production ports (`findDisputesNeedingAssessment`, `ingestAndDefend`) are covered elsewhere:
 * the candidate query in `packages/db/test/repos.defender-queue.live.test.ts`, and the pipeline in
 * `packages/defender` and `packages/orchestrator`'s own suites. What only this file can prove is the
 * *loop's* behaviour: boundedness, one defend per candidate, honest tallies, and the all-failed
 * branch that turns a PayPal outage into a queue retry instead of a green report.
 */
import { csError, err, ok, type CsError, type Result } from '@countersign/core'
import type { DisputeRow } from '@countersign/db'
import type { DefendOutcome } from '@countersign/orchestrator'
import type { JobHandler } from '@countersign/webhooks'
import { describe, expect, it } from 'vitest'

import { DEFEND_BATCH, defendDisputesJob, type DefendDeps } from '../src/defend'

/** A row as far as the loop reads it: only the id pair. */
function dispute(n: number): DisputeRow {
  return {
    id: `dsp_defend_${n}`,
    paypal_dispute_id: `PP-D-DEFEND-${n}`,
  } as DisputeRow
}

/**
 * A `DefendOutcome` as far as the loop reads it. The real one is the orchestrator's; the loop reads
 * `file.awaitingApproval`, `file.refusal`, `file.decision` — everything else is opaque.
 */
function outcome(fields: {
  awaitingApproval?: boolean
  refusal?: unknown
  liability?: string
}): Result<DefendOutcome, CsError> {
  return ok({
    paypalDisputeId: 'PP-D-DEFEND-0',
    disputeId: 'dsp_defend_0',
    linked: true,
    posture: 'CONTEST',
    file: {
      decision: { posture: 'CONTEST', liability: fields.liability ?? 'USER_AUTHORISED' },
      awaitingApproval: fields.awaitingApproval ?? false,
      ...(fields.refusal === undefined ? {} : { refusal: fields.refusal }),
    },
  } as unknown as DefendOutcome)
}

/** A pipeline fault, built by `csError` so `retryable` is derived rather than hand-written. */
function fault(): Result<never, CsError> {
  return err(csError('PP_UNAVAILABLE', 'PayPal is unreachable'))
}

/** The loop's report, with the shape `defendDisputesJob` actually returns. */
interface Report {
  candidates: number
  assessed: number
  awaitingApproval: number
  refused: number
  failed: number
  failures?: unknown[]
}

type RunResult = { ok: true; value: Report } | { ok: false; error: CsError }

/** Drive one handler and flatten the queue-facing `Result` so assertions read one layer deep. */
async function run(handler: JobHandler): Promise<RunResult> {
  const settled = await handler(undefined)
  return settled.ok
    ? { ok: true, value: settled.value as Report }
    : { ok: false, error: settled.error }
}

interface Ports {
  readonly listed: number[]
  readonly defended: string[]
  readonly deps: DefendDeps
}

/** Recording ports with per-row answers. */
function ports(
  rows: DisputeRow[],
  answers: (row: DisputeRow) => Result<DefendOutcome, CsError> | 'fail',
  options: { listFails?: Result<never, CsError> } = {},
): Ports {
  const listed: number[] = []
  const defended: string[] = []
  return {
    listed,
    defended,
    deps: {
      async listCandidates(limit) {
        listed.push(limit)
        if (options.listFails) return options.listFails
        return ok(rows)
      },
      async defendOne(row) {
        defended.push(row.paypal_dispute_id)
        const answer = answers(row)
        return answer === 'fail' ? fault() : answer
      },
    },
  }
}

describe('defendDisputesJob', () => {
  it('is bounded: the candidate query is asked for DEFEND_BATCH rows, not the whole queue', async () => {
    const p = ports([], () => outcome({}))
    await run(defendDisputesJob(p.deps))
    expect(p.listed).toEqual([DEFEND_BATCH])
    expect(DEFEND_BATCH).toBeLessThanOrEqual(10)
  })

  it("runs the pipeline once per candidate, most urgent first, on the row's PayPal id", async () => {
    const rows = [dispute(1), dispute(2), dispute(3)]
    const p = ports(rows, () => outcome({}))
    const result = await run(defendDisputesJob(p.deps))
    // The lister is the urgency order (the live test proves it); the loop must not reorder.
    expect(p.defended).toEqual(rows.map((r) => r.paypal_dispute_id))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({
      candidates: 3,
      assessed: 3,
      awaitingApproval: 0,
      refused: 0,
      failed: 0,
      failures: [],
    })
  })

  it('honours a smaller caller-supplied limit', async () => {
    const p = ports([], () => outcome({}))
    await run(defendDisputesJob(p.deps, { limit: 3 }))
    expect(p.listed).toEqual([3])
  })

  it('counts an approval-gated verdict as awaitingApproval, not as a refusal', async () => {
    // §8.15: without an approval the outcome is `awaitingApproval: true` — a recorded verdict plus a
    // "human click next", which is a different row in the operator's log from a refusal.
    const p = ports([dispute(1)], () => outcome({ awaitingApproval: true }))
    const result = await run(defendDisputesJob(p.deps))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.assessed).toBe(1)
    expect(result.value.awaitingApproval).toBe(1)
    expect(result.value.refused).toBe(0)
  })

  it('counts a recorded refusal as refused, and a failed pipeline as failed', async () => {
    // A refusal is `ok` — a deadline passed is an outcome the case file shows, not a fault. A fault
    // (the pipeline could not reach a decision) is the `err` branch and stays in the queue.
    const rows = [dispute(1), dispute(2), dispute(3)]
    const p = ports(rows, (row) =>
      row.id.endsWith('3') ? 'fail' : outcome({ refusal: { code: 'DEF_NO_CHAIN' } }),
    )
    const result = await run(defendDisputesJob(p.deps))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.assessed).toBe(2)
    expect(result.value.refused).toBe(2)
    expect(result.value.failed).toBe(1)
    expect(result.value.failures?.[0]).toMatchObject({ paypalDisputeId: 'PP-D-DEFEND-3' })
  })

  it('reports an err, not a green run, when every candidate failed', async () => {
    // A PayPal outage fails all ten. A green "0 assessed, 10 failed" would hide the outage from the
    // queue; an err lets pg-boss's retry policy own it.
    const rows = [dispute(1), dispute(2)]
    const p = ports(rows, () => 'fail')
    const result = await run(defendDisputesJob(p.deps))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('PP_UNAVAILABLE')
  })

  it("passes a candidate-listing failure through as the job's own err", async () => {
    const p = ports([], () => outcome({}), {
      listFails: err(csError('CS_INTERNAL', 'db down')),
    })
    const result = await run(defendDisputesJob(p.deps))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_INTERNAL')
    expect(p.defended).toEqual([])
  })
})
