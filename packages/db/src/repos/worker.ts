/**
 * `worker_job_runs` — the worker's heartbeat, spec **§8.19** (M19, observability) and **§14** (SLOs).
 *
 * ## The problem this solves
 *
 * Render runs `countersign-worker` as `type: worker`: **no port, no health check, no way for the platform to
 * notice it died.** And a dead worker is invisible from the outside in the worst possible way — the web
 * process keeps acknowledging webhooks (§8.12 step 5), so nothing errors, nothing 5xx's, and the only symptom
 * is that lost webhooks stop being repaired and reservations stop being released. `/status` already reports
 * *lag*, but lag is a symptom without an owner: it cannot say whether the reconciler ran four minutes ago and
 * is fine, or has not run since the last deploy.
 *
 * This repository is the missing measurement. `recordJobRun` is called by `apps/worker`'s handler wrapper for
 * every job tick; `findJobHeartbeats` is what `/status` reads. Between them, "is the worker alive" becomes a
 * fact with a timestamp instead of an inference from a quiet queue.
 *
 * ## Why these rows are pruned on write
 *
 * A heartbeat table with no retention is a table that eventually owns the database's I/O. `recordJobRun`
 * deletes this job's rows older than {@link WORKER_JOB_RUN_RETENTION_DAYS} in the same transaction as the
 * insert, so retention needs no separate cron — the write that grows the table is the write that trims it. A
 * week at the 5-minute cadence is ~2,000 rows per job, and the aggregate in {@link findJobHeartbeats} stays a
 * single index scan over `worker_job_runs_job_finished_idx`.
 */
import { and, asc, eq, lt, sql } from 'drizzle-orm'

import type { CsError, Result } from '@countersign/core'

import { db, withTx, type Exec } from '../client'
import {
  workerJobRuns,
  type JobRunOutcome,
  type NewWorkerJobRun,
  type WorkerJobRunRow,
} from '../schema'
import { repo } from './index'

/**
 * How long a job's runs are kept.
 *
 * Seven days because the question a heartbeat answers is *"is it running now, and did it fail recently?"* —
 * not *"what happened last month"*. The nightly job runs once a day, so a week still holds seven of its
 * samples: enough to see a skipped night.
 */
export const WORKER_JOB_RUN_RETENTION_DAYS = 7

/** One finished run, as `apps/worker`'s wrapper sees it. */
export interface JobRunInput {
  /** `WORKER_ID` — the instance that ran it. Two instances must not be indistinguishable. */
  readonly workerId: string
  /** `JobName` from `packages/webhooks` (`wh.reconcile`, `wh.disputes`, `release.reservations`, …). */
  readonly job: string
  readonly outcome: JobRunOutcome
  /** When the handler was entered. */
  readonly startedAt: Date
  /** When it returned or threw. */
  readonly finishedAt: Date
  /**
   * The `CsError.code` of a failed run, or `null`.
   *
   * The **code**, never the message: a message can carry PayPal's own text and an account identifier, and a
   * table read by `/status` is a table somebody will paste into a chat.
   */
  readonly errorCode?: string | null
}

/**
 * One job's history, aggregated across every worker instance.
 *
 * `lastFailureAt` and `lastSuccessAt` are kept apart rather than collapsed into "last run", because the
 * ordering between them *is* the diagnosis: "the most recent run failed" and "the most recent run succeeded"
 * are opposite conclusions drawn from the same two timestamps, and §14's promise is about the second one.
 */
export interface JobHeartbeat {
  readonly job: string
  readonly lastStartedAt: Date
  readonly lastFinishedAt: Date
  /** `null` when this job has **never** succeeded — a distinct state from "has not run recently". */
  readonly lastSuccessAt: Date | null
  readonly lastFailureAt: Date | null
  readonly lastErrorCode: string | null
  /** Runs inside the retention window. */
  readonly runs: number
  /** Failed runs inside the retention window. */
  readonly failures: number
  /** Distinct worker instances seen, so a single-instance deployment is not mistaken for a fleet. */
  readonly workers: number
}

/**
 * Record one finished run, and prune this job's history older than the retention window.
 *
 * The delete and the insert share a transaction on purpose: a crash between them would either grow the table
 * forever (delete first) or lose the sample that proves the worker was alive (insert first). Neither is
 * acceptable for the one table whose whole job is to be trustworthy.
 *
 * Accepts an optional executor so a caller that already holds a transaction can record a run atomically with
 * the work it is describing.
 */
export function recordJobRun(
  input: JobRunInput,
  exec?: Exec,
): Promise<Result<WorkerJobRunRow, CsError>> {
  return repo(
    async () => {
      const write = async (tx: Exec): Promise<WorkerJobRunRow> => {
        const cutoff = new Date(
          input.finishedAt.getTime() - WORKER_JOB_RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000,
        )
        await tx
          .delete(workerJobRuns)
          .where(and(eq(workerJobRuns.job, input.job), lt(workerJobRuns.finishedAt, cutoff)))

        const row: NewWorkerJobRun = {
          workerId: input.workerId,
          job: input.job,
          outcome: input.outcome,
          startedAt: input.startedAt,
          finishedAt: input.finishedAt,
          durationMs: Math.max(
            0,
            Math.round(input.finishedAt.getTime() - input.startedAt.getTime()),
          ),
          errorCode: input.outcome === 'error' ? (input.errorCode ?? 'CS_INTERNAL') : null,
        }
        const rows = await tx.insert(workerJobRuns).values(row).returning()
        const written = rows[0]
        if (!written) throw new Error('INSERT ... RETURNING produced no worker_job_runs row')
        return written as WorkerJobRunRow
      }

      if (exec) return write(exec)
      // A `Result` returned from inside `repo` flows through untouched (see `repo`'s contract), so the
      // transaction's own error keeps its code rather than being re-wrapped as a generic failure.
      return withTx(write)
    },
    { table: 'worker_job_runs', job: input.job, workerId: input.workerId, outcome: input.outcome },
  )
}

/**
 * The latest state of every job that has ever run, one row per job, ordered by name.
 *
 * Ordered by name rather than recency because the caller pairs this list with `CRON_SPECS` — a fixed table of
 * expected jobs — and a stable order makes "which expected job is missing" a readable diff rather than a
 * search.
 *
 * The aggregates are SQL rather than a read-then-reduce in TypeScript for one reason: the table is the only
 * record of worker liveness, so the read has to be cheap enough that `/status` can afford it on every Render
 * poll. `max(...) FILTER (WHERE ...)` answers "last success" and "last failure" in one pass over the index,
 * and `array_agg(...) [1]` carries the most recent error code without a second query.
 */
export function findJobHeartbeats(exec?: Exec): Promise<Result<JobHeartbeat[], CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select({
          job: workerJobRuns.job,
          lastStartedAt: sql<Date>`max(${workerJobRuns.startedAt})`.as('last_started_at'),
          lastFinishedAt: sql<Date>`max(${workerJobRuns.finishedAt})`.as('last_finished_at'),
          lastSuccessAt:
            sql<Date | null>`max(${workerJobRuns.finishedAt}) filter (where ${workerJobRuns.outcome} = 'ok')`.as(
              'last_success_at',
            ),
          lastFailureAt:
            sql<Date | null>`max(${workerJobRuns.finishedAt}) filter (where ${workerJobRuns.outcome} = 'error')`.as(
              'last_failure_at',
            ),
          lastErrorCode: sql<
            string | null
          >`(array_agg(${workerJobRuns.errorCode} order by ${workerJobRuns.finishedAt} desc) filter (where ${workerJobRuns.errorCode} is not null))[1]`.as(
            'last_error_code',
          ),
          runs: sql<number>`count(*)::int`.as('runs'),
          failures: sql<number>`count(*) filter (where ${workerJobRuns.outcome} = 'error')::int`.as(
            'failures',
          ),
          workers: sql<number>`count(distinct ${workerJobRuns.workerId})::int`.as('workers'),
        })
        .from(workerJobRuns)
        .groupBy(workerJobRuns.job)
        .orderBy(asc(workerJobRuns.job))

      return rows.map((row) => ({
        job: row.job,
        lastStartedAt: new Date(row.lastStartedAt),
        lastFinishedAt: new Date(row.lastFinishedAt),
        lastSuccessAt: row.lastSuccessAt === null ? null : new Date(row.lastSuccessAt),
        lastFailureAt: row.lastFailureAt === null ? null : new Date(row.lastFailureAt),
        lastErrorCode: row.lastErrorCode,
        runs: Number(row.runs),
        failures: Number(row.failures),
        workers: Number(row.workers),
      }))
    },
    { table: 'worker_job_runs' },
  )
}
