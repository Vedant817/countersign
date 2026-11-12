/**
 * The worker's own health endpoint, spec **§8.19**, `docs/PROD_AUDIT.md` §7.
 *
 * ## Why a worker needs a port at all, and why it is off by default
 *
 * Render's `type: worker` has no port and no health check, so out of the box the platform cannot tell a
 * running reconciler from a dead one — `/status` on the web process reads the heartbeat table and is the
 * primary surface. This server exists for the case that surface cannot cover: an external monitor, a
 * `curl` from an operator who suspects the worker, or a platform that *does* support a worker health check.
 *
 * It is **opt-in through `WORKER_HEALTH_PORT`** because a listener that is always on is a listener nobody
 * asked for, and because binding a port in a test process is a side effect that has to be cleaned up. Set the
 * variable and it binds; leave it unset and `startWorker` behaves exactly as before.
 *
 * ## What it reports
 *
 * The same `{ job, state, age }` list `/status` renders, derived from the same `@countersign/privacy`
 * function, against the same schedule table. Two surfaces that disagreed about whether the reconciler was
 * alive would be worse than one surface, so there is one implementation and two transports.
 *
 * The status code is **200 unless a job is `stalled` or `failing`**. A job that has never run yet is not a
 * failure: a freshly started worker legitimately has no samples, and an endpoint that returns 503 for the
 * first five minutes of every deploy teaches the reader to ignore it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { formatIst, formatIstHuman, type Logger } from '@countersign/core'
import type { JobHeartbeat } from '@countersign/db'
import {
  jobHealth,
  workerHealth,
  type JobHealth,
  type WorkerHealthState,
} from '@countersign/privacy'

/** One job the worker expects to run, and how often. Comes from `schedule.ts`. */
export interface JobExpectation {
  readonly job: string
  /** The cron's own interval in seconds — a nightly job is not judged against five minutes. */
  readonly cadenceSec: number
}

/**
 * Turn the heartbeat rows plus the schedule table into a per-job verdict list.
 *
 * Pure, and separate from the HTTP server, because this is the part with the logic: it is what decides that
 * a job in `CRON_SPECS` with no row is `never` while a job with a stale row is `stalled`, and that decision
 * is worth asserting without opening a socket.
 */
export function buildJobHealths(input: {
  readonly heartbeats: readonly JobHeartbeat[]
  readonly expected: readonly JobExpectation[]
  readonly nowSec: number
}): JobHealth[] {
  const byJob = new Map(input.heartbeats.map((row) => [row.job, row]))

  return input.expected.map(({ job, cadenceSec }) => {
    const row = byJob.get(job)
    if (row === undefined) {
      return jobHealth({
        job,
        cadenceSec,
        lastStartedAtSec: null,
        lastFinishedAtSec: null,
        lastSuccessAtSec: null,
        lastFailureAtSec: null,
        lastErrorCode: null,
        nowSec: input.nowSec,
      })
    }
    return jobHealth({
      job,
      cadenceSec,
      lastStartedAtSec: Math.floor(row.lastStartedAt.getTime() / 1000),
      lastFinishedAtSec: Math.floor(row.lastFinishedAt.getTime() / 1000),
      lastSuccessAtSec:
        row.lastSuccessAt === null ? null : Math.floor(row.lastSuccessAt.getTime() / 1000),
      lastFailureAtSec:
        row.lastFailureAt === null ? null : Math.floor(row.lastFailureAt.getTime() / 1000),
      lastErrorCode: row.lastErrorCode,
      nowSec: input.nowSec,
    })
  })
}

/** The JSON body of `GET /health`. */
export interface WorkerHealthReport {
  readonly workerId: string
  readonly checkedAt: {
    readonly epochSec: number
    readonly utc: string
    readonly ist: string
    readonly istHuman: string
  }
  /** `false` only when a job is stalled or failing — the two states that mean work is not being done. */
  readonly ok: boolean
  readonly state: WorkerHealthState
  readonly summary: string
  readonly jobs: readonly JobHealth[]
}

/** Assemble the report. Exported so a test can assert the body without a socket. */
export function buildHealthReport(input: {
  readonly workerId: string
  readonly jobs: readonly JobHealth[]
  readonly nowMs: number
}): WorkerHealthReport {
  const nowSec = Math.floor(input.nowMs / 1000)
  const rollup = workerHealth(input.jobs)
  return {
    workerId: input.workerId,
    checkedAt: {
      epochSec: nowSec,
      utc: new Date(input.nowMs).toISOString(),
      ist: formatIst(nowSec),
      istHuman: formatIstHuman(nowSec),
    },
    // `never` is not a failure of *this* endpoint: the worker answering is proof it is running, and the
    // table may simply not have been written yet. Stalled and failing are the states that mean work is
    // not being done, so those are the ones that fail the check.
    ok: rollup.state !== 'stalled',
    state: rollup.state,
    summary: rollup.detail,
    jobs: input.jobs,
  }
}

export interface HealthServer {
  /** The bound address. `127.0.0.1`, not `0.0.0.0`: a health endpoint is not a public API. */
  readonly url: string
  close(): Promise<void>
}

/**
 * Serve `GET /health` on `port`, bound to loopback.
 *
 * The handler catches everything: a health endpoint that 500s because the database is down is reporting the
 * failure as a stack trace instead of as an answer. A failed report is a 503 with `ok: false` and the
 * `CsError` code — the one case where the body *should* say what went wrong.
 *
 * Resolves only once the socket is listening, and rejects with the bind error (`EADDRINUSE` and friends)
 * rather than leaving a caller with a server that never accepted a connection.
 */
export async function startHealthServer(options: {
  readonly port: number
  readonly workerId: string
  readonly report: () => Promise<readonly JobHealth[]>
  readonly now?: () => number
  readonly logger?: Logger
}): Promise<HealthServer> {
  const now = options.now ?? Date.now

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void respond(request, response)
  })

  async function respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = (request.url ?? '/').split('?')[0]
    if (request.method !== 'GET' || path !== '/health') {
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      response.end(
        JSON.stringify({ ok: false, error: 'not found; the health endpoint is /health' }),
      )
      return
    }

    let report: WorkerHealthReport
    try {
      const jobs = await options.report()
      report = buildHealthReport({ workerId: options.workerId, jobs, nowMs: now() })
    } catch (cause) {
      options.logger?.error('worker health report failed', { code: codeOf(cause) })
      response.writeHead(503, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store, no-cache, must-revalidate',
      })
      response.end(
        JSON.stringify({
          ok: false,
          error: 'the health report could not be built; the database may be unreachable',
          code: codeOf(cause),
        }),
      )
      return
    }

    response.writeHead(report.ok ? 200 : 503, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate',
      'x-countersign-worker': report.state,
    })
    response.end(JSON.stringify(report, null, 2))
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (cause: Error): void => reject(cause)
    server.once('error', onError)
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', onError)
      resolve()
    })
  })

  /*
   * The port is read back from the bound socket rather than echoed from the request.
   *
   * `port: 0` means "any free port", which is how a test avoids colliding with a developer's shell, and the
   * caller can only be told where the server actually is by asking the socket. Echoing `options.port` would
   * have printed `:0` and sent the first `curl` to the wrong place.
   */
  const address = server.address()
  const boundPort = typeof address === 'object' && address !== null ? address.port : options.port

  return {
    url: `http://127.0.0.1:${boundPort}/health`,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    },
  }
}

function codeOf(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    const code = (cause as { code?: unknown }).code
    if (typeof code === 'string' && code !== '') return code
  }
  return 'CS_INTERNAL'
}
