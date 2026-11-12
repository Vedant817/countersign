/**
 * `worker_job_runs` against a real Postgres — spec §8.19, §14, `docs/PROD_AUDIT.md` §7.
 *
 * ## Why this one is executed rather than mocked
 *
 * The repo's value is a SQL claim: `max(...) FILTER (WHERE ...)` for last success and last failure in one
 * pass, `array_agg(...) [1]` for the most recent error code, and a `DELETE` that shares a transaction with
 * the `INSERT` so retention cannot race the sample it is keeping. A structural test can assert that
 * `findJobHeartbeats` exists; only Postgres can assert that it returns the right answer — and `max() FILTER`
 * is exactly the kind of SQL that drifts silently when a column is renamed.
 *
 * `describe.skipIf` rather than an exclusion, so the CI job that has a database runs these and a checkout
 * without one stays green.
 */
import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'

import { closeDb, withTx } from '../src/client'
import { findJobHeartbeats, recordJobRun, WORKER_JOB_RUN_RETENTION_DAYS } from '../src/repos'
import { workerJobRuns } from '../src/schema'

const hasDatabase = (process.env['DATABASE_URL'] ?? '').trim() !== ''

afterAll(async () => {
  if (hasDatabase) await closeDb()
})

const DAY_MS = 24 * 60 * 60 * 1000

/** One job name per test, so a failure cannot be attributed to another test's rows. */
function jobName(label: string): string {
  return `test.${label}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
}

async function deleteJob(job: string): Promise<void> {
  await withTx((tx) => tx.delete(workerJobRuns).where(eq(workerJobRuns.job, job)))
}

async function rowsFor(job: string): Promise<{ outcome: string; finishedAt: Date }[]> {
  const outer = await withTx((tx) =>
    tx
      .select({ outcome: workerJobRuns.outcome, finishedAt: workerJobRuns.finishedAt })
      .from(workerJobRuns)
      .where(eq(workerJobRuns.job, job)),
  )
  if (!outer.ok) throw new Error(`read failed: ${outer.error.message}`)
  return outer.value
}

describe.skipIf(!hasDatabase)('worker heartbeat repository (live database)', () => {
  it('records a successful run and reports it as the job last success', async () => {
    const job = jobName('ok')
    try {
      const finishedAt = new Date(Date.now() - 60_000)
      const written = await recordJobRun({
        workerId: 'worker-a',
        job,
        outcome: 'ok',
        startedAt: new Date(finishedAt.getTime() - 1_500),
        finishedAt,
      })
      expect(written.ok, written.ok ? '' : written.error.message).toBe(true)

      const all = await findJobHeartbeats()
      expect(all.ok).toBe(true)
      if (!all.ok) return
      const found = all.value.find((h) => h.job === job)
      expect(found, 'the job is missing from the aggregate').toBeDefined()
      expect(found!.lastSuccessAt?.getTime()).toBe(finishedAt.getTime())
      expect(found!.lastFailureAt).toBeNull()
      expect(found!.lastErrorCode).toBeNull()
      expect(found!.runs).toBe(1)
      expect(found!.failures).toBe(0)
      expect(found!.workers).toBe(1)
    } finally {
      await deleteJob(job)
    }
  })

  it('keeps the last failure apart from the last success, with the error code', async () => {
    const job = jobName('failing')
    try {
      const succeededAt = new Date(Date.now() - 120_000)
      const failedAt = new Date(Date.now() - 30_000)
      await recordJobRun({
        workerId: 'worker-a',
        job,
        outcome: 'ok',
        startedAt: new Date(succeededAt.getTime() - 10),
        finishedAt: succeededAt,
      })
      await recordJobRun({
        workerId: 'worker-a',
        job,
        outcome: 'error',
        startedAt: new Date(failedAt.getTime() - 10),
        finishedAt: failedAt,
        errorCode: 'PP_UNAVAILABLE',
      })

      const all = await findJobHeartbeats()
      expect(all.ok).toBe(true)
      if (!all.ok) return
      const found = all.value.find((h) => h.job === job)
      expect(found).toBeDefined()
      // The ordering of these two is the whole diagnosis: the most recent run failed.
      expect(found!.lastSuccessAt?.getTime()).toBe(succeededAt.getTime())
      expect(found!.lastFailureAt?.getTime()).toBe(failedAt.getTime())
      expect(found!.lastFailureAt!.getTime()).toBeGreaterThan(found!.lastSuccessAt!.getTime())
      expect(found!.lastErrorCode).toBe('PP_UNAVAILABLE')
      expect(found!.runs).toBe(2)
      expect(found!.failures).toBe(1)
    } finally {
      await deleteJob(job)
    }
  })

  it('reports a job that has never succeeded as having no last success at all', async () => {
    const job = jobName('never-ok')
    try {
      const finishedAt = new Date()
      await recordJobRun({
        workerId: 'worker-b',
        job,
        outcome: 'error',
        startedAt: new Date(finishedAt.getTime() - 5),
        finishedAt,
        errorCode: 'CS_INTERNAL',
      })

      const all = await findJobHeartbeats()
      expect(all.ok).toBe(true)
      if (!all.ok) return
      const found = all.value.find((h) => h.job === job)
      // `null` here and "has not run for a while" are different states, and `jobHealth` depends on the
      // difference: a job that has never succeeded is not a quiet job, it is a broken one.
      expect(found!.lastSuccessAt).toBeNull()
      expect(found!.lastFailureAt).not.toBeNull()
    } finally {
      await deleteJob(job)
    }
  })

  it('counts distinct workers, so two instances are not read as one', async () => {
    const job = jobName('workers')
    try {
      const finishedAt = new Date()
      await recordJobRun({
        workerId: 'worker-a',
        job,
        outcome: 'ok',
        startedAt: finishedAt,
        finishedAt,
      })
      await recordJobRun({
        workerId: 'worker-b',
        job,
        outcome: 'ok',
        startedAt: finishedAt,
        finishedAt,
      })

      const all = await findJobHeartbeats()
      expect(all.ok).toBe(true)
      if (!all.ok) return
      expect(all.value.find((h) => h.job === job)!.workers).toBe(2)
    } finally {
      await deleteJob(job)
    }
  })

  it('prunes rows past the retention window on write', async () => {
    const job = jobName('retention')
    try {
      const stale = new Date(Date.now() - (WORKER_JOB_RUN_RETENTION_DAYS + 1) * DAY_MS)
      // Written directly rather than through the repo: the point is that the *next* repo write removes it,
      // which is what keeps the table bounded without a separate cron.
      const inserted = await withTx((tx) =>
        tx
          .insert(workerJobRuns)
          .values({
            workerId: 'worker-old',
            job,
            outcome: 'ok',
            startedAt: stale,
            finishedAt: stale,
            durationMs: 1,
          })
          .returning({ id: workerJobRuns.id }),
      )
      expect(inserted.ok).toBe(true)
      expect(await rowsFor(job)).toHaveLength(1)

      await recordJobRun({
        workerId: 'worker-new',
        job,
        outcome: 'ok',
        startedAt: new Date(),
        finishedAt: new Date(),
      })

      const rows = await rowsFor(job)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.outcome).toBe('ok')
    } finally {
      await deleteJob(job)
    }
  })

  it('accepts the caller transaction, so a run can be recorded atomically with its work', async () => {
    const job = jobName('in-tx')
    try {
      const outer = await withTx((tx) =>
        recordJobRun(
          {
            workerId: 'worker-tx',
            job,
            outcome: 'ok',
            startedAt: new Date(),
            finishedAt: new Date(),
          },
          tx,
        ),
      )
      expect(outer.ok, outer.ok ? '' : outer.error.message).toBe(true)
      expect(await rowsFor(job)).toHaveLength(1)
    } finally {
      await deleteJob(job)
    }
  })
})
