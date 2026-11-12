/**
 * The worker's health endpoint — spec §8.19, `docs/PROD_AUDIT.md` §7.
 *
 * ## Why this is an HTTP test and not a pure one
 *
 * `buildJobHealths` (the logic) is asserted here too, but the endpoint has one property that only a real
 * socket can prove: **it answers when the database is down.** A handler that throws into a `500` with a stack
 * trace is a health check that has stopped being one, and the whole point of this route is to say "I cannot
 * tell you whether the worker is healthy, and here is why" in a body a monitor can read.
 *
 * Port `0` is used throughout: the server reports the port the kernel gave it, so these tests never collide
 * with a developer's shell or with each other.
 */
import { afterEach, describe, expect, it } from 'vitest'

import type { JobHeartbeat } from '@countersign/db'

import {
  buildHealthReport,
  buildJobHealths,
  startHealthServer,
  type HealthServer,
  type JobExpectation,
} from '../src/health'

const NOW_MS = 1_800_000_000_000
const NOW_SEC = Math.floor(NOW_MS / 1000)

const EXPECTED: readonly JobExpectation[] = [
  { job: 'wh.reconcile', cadenceSec: 300 },
  { job: 'wh.disputes', cadenceSec: 120 },
]

/** A heartbeat row that succeeded `ageSec` ago. */
function row(job: string, ageSec: number, overrides: Partial<JobHeartbeat> = {}): JobHeartbeat {
  const at = new Date((NOW_SEC - ageSec) * 1000)
  return {
    job,
    lastStartedAt: at,
    lastFinishedAt: at,
    lastSuccessAt: at,
    lastFailureAt: null,
    lastErrorCode: null,
    runs: 1,
    failures: 0,
    workers: 1,
    ...overrides,
  }
}

let open: HealthServer | undefined

afterEach(async () => {
  await open?.close()
  open = undefined
})

describe('§8.19 job heartbeat aggregation', () => {
  it('judges a job with no row as never, and a fresh job as ok', () => {
    const jobs = buildJobHealths({
      heartbeats: [row('wh.reconcile', 60)],
      expected: EXPECTED,
      nowSec: NOW_SEC,
    })

    const reconcile = jobs.find((j) => j.job === 'wh.reconcile')
    const disputes = jobs.find((j) => j.job === 'wh.disputes')
    expect(reconcile!.state).toBe('ok')
    // A missing row is not a quiet job: `wh.disputes` is on a 2-minute cron, so an absent row means the
    // schedule did not register, not that nothing happened.
    expect(disputes!.state).toBe('never')
  })

  it('judges a stale job against its own cadence, so a nightly job is not "lagging" all day', () => {
    const jobs = buildJobHealths({
      heartbeats: [row('wh.reconcile', 6 * 60 * 60)],
      expected: [{ job: 'wh.reconcile', cadenceSec: 24 * 60 * 60 }],
      nowSec: NOW_SEC,
    })
    expect(jobs[0]!.state).toBe('ok')
    expect(jobs[0]!.lagThresholdSec).toBe(24 * 60 * 60)
  })
})

describe('§8.19 health report body', () => {
  it('reports the job states, both clocks and the roll-up', () => {
    const report = buildHealthReport({
      workerId: 'worker-a',
      jobs: buildJobHealths({
        heartbeats: [row('wh.reconcile', 60), row('wh.disputes', 60)],
        expected: EXPECTED,
        nowSec: NOW_SEC,
      }),
      nowMs: NOW_MS,
    })

    expect(report.ok).toBe(true)
    expect(report.state).toBe('ok')
    expect(report.workerId).toBe('worker-a')
    expect(report.jobs).toHaveLength(2)
    expect(report.checkedAt.utc).toBe(new Date(NOW_MS).toISOString())
    // AGENTS.md rule 10: IST is for humans, and it is printed beside the UTC, never instead of it.
    expect(report.checkedAt.ist).toMatch(/\+05:30$/)
    expect(report.checkedAt.istHuman).not.toBe('')
  })

  it('is not ok when a job is stalled, and is ok when a job has simply never run', () => {
    const stalled = buildHealthReport({
      workerId: 'worker-a',
      jobs: buildJobHealths({
        heartbeats: [row('wh.reconcile', 3 * 60 * 60)],
        expected: EXPECTED,
        nowSec: NOW_SEC,
      }),
      nowMs: NOW_MS,
    })
    expect(stalled.ok).toBe(false)
    expect(stalled.state).toBe('stalled')

    // A freshly started worker legitimately has no samples. An endpoint that 503s for the first five
    // minutes of every deploy teaches the reader to ignore it.
    const fresh = buildHealthReport({
      workerId: 'worker-a',
      jobs: buildJobHealths({ heartbeats: [], expected: EXPECTED, nowSec: NOW_SEC }),
      nowMs: NOW_MS,
    })
    expect(fresh.state).toBe('never')
    expect(fresh.ok).toBe(true)
  })
})

describe('§8.19 health endpoint', () => {
  it('answers 200 with the report on GET /health', async () => {
    open = await startHealthServer({
      port: 0,
      workerId: 'worker-a',
      report: async () =>
        buildJobHealths({
          heartbeats: [row('wh.reconcile', 60), row('wh.disputes', 30)],
          expected: EXPECTED,
          nowSec: NOW_SEC,
        }),
      now: () => NOW_MS,
    })

    const response = await fetch(open.url)
    expect(response.status).toBe(200)
    expect(response.headers.get('x-countersign-worker')).toBe('ok')
    expect(response.headers.get('cache-control')).toContain('no-store')
    const body = (await response.json()) as { ok: boolean; workerId: string; jobs: unknown[] }
    expect(body.ok).toBe(true)
    expect(body.workerId).toBe('worker-a')
    expect(body.jobs).toHaveLength(2)
  })

  it('answers 503 when a job is stalled, and still says which one', async () => {
    open = await startHealthServer({
      port: 0,
      workerId: 'worker-a',
      report: async () =>
        buildJobHealths({
          heartbeats: [row('wh.reconcile', 60), row('wh.disputes', 4 * 60 * 60)],
          expected: EXPECTED,
          nowSec: NOW_SEC,
        }),
      now: () => NOW_MS,
    })

    const response = await fetch(open.url)
    expect(response.status).toBe(503)
    const body = (await response.json()) as {
      ok: boolean
      state: string
      jobs: { job: string; state: string }[]
    }
    expect(body.ok).toBe(false)
    expect(body.jobs.find((j) => j.job === 'wh.disputes')!.state).toBe('stalled')
  })

  it('answers 503 with a code when the heartbeat read fails, not a stack trace', async () => {
    open = await startHealthServer({
      port: 0,
      workerId: 'worker-a',
      report: async () => {
        throw {
          code: 'CS_INTERNAL',
          message: 'the database is unreachable',
          userMessage: 'The server is misconfigured.',
          retryable: true,
        }
      },
      now: () => NOW_MS,
    })

    const response = await fetch(open.url)
    expect(response.status).toBe(503)
    const body = (await response.json()) as { ok: boolean; code: string }
    expect(body.ok).toBe(false)
    expect(body.code).toBe('CS_INTERNAL')
  })

  it('404s every other path, so a scanner cannot mistake it for the app', async () => {
    open = await startHealthServer({
      port: 0,
      workerId: 'worker-a',
      report: async () => [],
      now: () => NOW_MS,
    })

    const response = await fetch(`${open.url.replace(/\/health$/, '')}/status`)
    expect(response.status).toBe(404)
  })

  it('is bound to loopback, never to every interface', async () => {
    open = await startHealthServer({
      port: 0,
      workerId: 'worker-a',
      report: async () => [],
      now: () => NOW_MS,
    })
    // The URL is the proof: a server on 0.0.0.0 would be reported as such, and a health endpoint is not a
    // public API.
    expect(open.url.startsWith('http://127.0.0.1:')).toBe(true)
  })
})
