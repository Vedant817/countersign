/**
 * The worker's heartbeat, spec **§8.19** (M19), **§14** (SLOs), `docs/PROD_AUDIT.md` §7.
 *
 * ## The problem, stated once
 *
 * Render runs `countersign-worker` as `type: worker`. A background worker has **no port and therefore no
 * health check**: if this process dies, or if the five-minute reconciler stops registering, the platform
 * does not notice and neither does any page. The web process keeps acknowledging webhooks (§8.12 step 5),
 * so the only symptom is that lost webhooks stop being repaired — which is indistinguishable from a quiet
 * week until someone reads a case file.
 *
 * `packages/db`'s `worker_job_runs` is the missing measurement, and this file is the only writer. It is a
 * **wrapper around the handler table rather than a change to any handler**, for two reasons:
 *
 * - `createJobRunner` is where the `Result` → pg-boss mapping lives, and it is tested without a database.
 *   Making every handler record a heartbeat would put a Postgres write inside those tests' path and inside
 *   the retry-classification logic that decides whether money-moving work is retried.
 * - The wrapper sees what pg-boss sees: a handler that returns, and a handler that **throws**. The throw is
 *   the retryable case, and it is exactly the one a "last run" column would otherwise miss.
 *
 * ## What the heartbeat never does
 *
 * **It never changes the outcome of the job it wraps.** A failed heartbeat write is logged and swallowed:
 * a status page is not worth failing a capture for, and a job that refused to run because its own
 * observability write failed would be a worse bug than the one the heartbeat exists to catch.
 */
import { hostname } from 'node:os'

import type { Clock, CsError, Logger, Result } from '@countersign/core'
import { recordJobRun, type JobRunInput } from '@countersign/db'
import type { JobName } from '@countersign/webhooks'

import type { QueueHandler } from './job-runner'

export type { JobRunInput }

/** Where a finished run is recorded. A port, so a test asserts the wrapper without a Postgres. */
export interface HeartbeatSink {
  record(event: JobRunInput): Promise<Result<unknown, CsError>>
}

/** The production sink: `worker_job_runs`, through the repository that owns its retention. */
export function dbHeartbeatSink(options: { readonly logger?: Logger } = {}): HeartbeatSink {
  return {
    async record(event) {
      const written = await recordJobRun(event)
      if (!written.ok) {
        options.logger?.error('could not record a job heartbeat', {
          job: event.job,
          workerId: event.workerId,
          outcome: event.outcome,
          code: written.error.code,
          message: written.error.message,
        })
      }
      return written
    },
  }
}

/**
 * This process's identity in `worker_job_runs.worker_id`.
 *
 * `WORKER_ID` when the operator sets it — a stable name is what makes "the same instance restarted" readable
 * — and `hostname-pid` otherwise. The pid is in the fallback because a container that is replaced gets a new
 * hostname but a recycled pid would otherwise let two different processes share an identity.
 */
export function workerId(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['WORKER_ID']
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return `${hostname()}-${process.pid}`
}

/** The `CsError.code` of anything a handler threw, or `CS_INTERNAL` when it was not a `CsError`. */
export function codeOf(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    const code = (cause as { code?: unknown }).code
    if (typeof code === 'string' && code !== '') return code
  }
  return 'CS_INTERNAL'
}

export interface HeartbeatOptions {
  readonly workerId: string
  readonly clock: Clock
  readonly logger?: Logger
}

/**
 * Wrap every handler so its run is recorded, and nothing else changes.
 *
 * The wrapper is synchronous about the return value and asynchronous about the write: `await` on the sink
 * means the row is durable before pg-boss is told the job finished, so a `SIGTERM` immediately after a run
 * cannot lose the sample that proves the worker was alive. That costs one round-trip per job tick, which at
 * eight jobs and a five-minute cadence is ~2,300 writes a day against a table that prunes itself.
 *
 * A thrown handler is recorded as `error` and **re-thrown unchanged**, because pg-boss reads a rejection as
 * "retry me" and swallowing it would turn a retryable failure into a completed one.
 */
export function withHeartbeats(
  handlers: Record<JobName, QueueHandler>,
  sink: HeartbeatSink,
  options: HeartbeatOptions,
): Record<JobName, QueueHandler> {
  const wrapped: Partial<Record<JobName, QueueHandler>> = {}

  for (const [job, handler] of Object.entries(handlers) as [JobName, QueueHandler][]) {
    wrapped[job] = async (data: unknown): Promise<unknown> => {
      const startedAt = new Date(options.clock.nowMs())
      const startedMs = startedAt.getTime()
      try {
        const value = await handler(data)
        await safeRecord(
          sink,
          {
            workerId: options.workerId,
            job,
            outcome: 'ok',
            startedAt,
            finishedAt: new Date(options.clock.nowMs()),
            errorCode: null,
          },
          options.logger,
          startedMs,
        )
        return value
      } catch (cause) {
        await safeRecord(
          sink,
          {
            workerId: options.workerId,
            job,
            outcome: 'error',
            startedAt,
            finishedAt: new Date(options.clock.nowMs()),
            errorCode: codeOf(cause),
          },
          options.logger,
          startedMs,
        )
        throw cause
      }
    }
  }

  return wrapped as Record<JobName, QueueHandler>
}

/**
 * Record one run, and never let the record itself break the job.
 *
 * Two layers of protection, deliberately: the sink returns a `Result` (so a failed write is a value), and
 * this function still catches, because a sink is a port and a third-party implementation may throw. The
 * logger is the only trace, which is the honest trade — a missing heartbeat row shows up on `/status`, and a
 * missing capture would show up everywhere.
 */
async function safeRecord(
  sink: HeartbeatSink,
  event: JobRunInput,
  logger: Logger | undefined,
  startedMs: number,
): Promise<void> {
  try {
    const result = await sink.record(event)
    if (!result.ok) return // `dbHeartbeatSink` has already logged it; a foreign sink's error is its own.
  } catch (cause) {
    logger?.error('heartbeat sink threw; the run is not recorded', {
      job: event.job,
      outcome: event.outcome,
      // The cause is logged as a code, not a message: a sink's message could carry anything.
      code: codeOf(cause),
      elapsedMs: Date.now() - startedMs,
    })
  }
}
