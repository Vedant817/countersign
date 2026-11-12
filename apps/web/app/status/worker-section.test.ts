/**
 * The `worker` section of `/status` — spec §8.19, `docs/PROD_AUDIT.md` §7.
 *
 * ## Why this file exists
 *
 * The five probe rows answer "can this instance serve". The worker section answers "is the process that
 * repairs lost webhooks alive", and it is read from a table rather than a call — which makes its failure
 * modes its own: a missing row, a stale row, a job that fails on every tick, and a table that cannot be read
 * at all. Each of those is a different sentence on the page, and each is asserted here.
 */
import { describe, expect, it } from 'vitest'

import type { JobHeartbeat } from '@countersign/db'

import { buildWorkerSection } from './probe'

const NOW_SEC = 1_800_000_000
const at = (ageSec: number): Date => new Date((NOW_SEC - ageSec) * 1000)

function row(job: string, ageSec: number, overrides: Partial<JobHeartbeat> = {}): JobHeartbeat {
  return {
    job,
    lastStartedAt: at(ageSec),
    lastFinishedAt: at(ageSec),
    lastSuccessAt: at(ageSec),
    lastFailureAt: null,
    lastErrorCode: null,
    runs: 1,
    failures: 0,
    workers: 1,
    ...overrides,
  }
}

describe('§8.19 /status worker section', () => {
  it('lists every expected job, including the ones that have never run', () => {
    const section = buildWorkerSection({ heartbeats: [row('wh.reconcile', 60)], nowSec: NOW_SEC })

    // The whole point: a worker that stopped registering schedules still shows five healthy jobs, and the
    // missing one is the evidence. A section built only from the rows it was handed would show one job and
    // look perfect.
    const jobs = section.jobs.map((j) => j.job)
    expect(jobs).toContain('wh.reconcile')
    expect(jobs).toContain('wh.disputes')
    expect(jobs).toContain('budget.reconcile')
    expect(section.jobs.find((j) => j.job === 'wh.reconcile')!.state).toBe('ok')
    expect(section.jobs.find((j) => j.job === 'wh.disputes')!.state).toBe('never')
    expect(section.state).toBe('lagging')
  })

  it('says "never" only when no job has ever run, and never claims ok for that', () => {
    const section = buildWorkerSection({ heartbeats: [], nowSec: NOW_SEC })
    expect(section.state).toBe('never')
    expect(section.summary).toContain('not running')
    expect(section.lastRunAt).toBeNull()
    expect(section.secondsSinceLastRun).toBeNull()
  })

  it('reports a stalled reconciler as stalled, with the age of the last success', () => {
    const section = buildWorkerSection({
      heartbeats: [row('wh.reconcile', 3 * 60 * 60)],
      nowSec: NOW_SEC,
    })
    const reconcile = section.jobs.find((j) => j.job === 'wh.reconcile')!
    expect(reconcile.state).toBe('stalled')
    expect(reconcile.ageSec).toBe(3 * 60 * 60)
    expect(section.state).toBe('stalled')
  })

  it('judges the nightly job against a day, so a fresh nightly run is not "stalled"', () => {
    const section = buildWorkerSection({
      heartbeats: [
        row('wh.reconcile', 60),
        row('wh.disputes', 60),
        row('wh.auth-expiry', 60),
        row('wh.verify', 60),
        row('release.reservations', 60),
        row('budget.reconcile', 6 * 60 * 60),
      ],
      nowSec: NOW_SEC,
    })
    expect(section.jobs.find((j) => j.job === 'budget.reconcile')!.state).toBe('ok')
    expect(section.state).toBe('ok')
  })

  it('reports a failing job by its error code, not just as "behind"', () => {
    const section = buildWorkerSection({
      heartbeats: [
        row('wh.reconcile', 30, {
          lastFailureAt: at(30),
          lastErrorCode: 'PP_UNAVAILABLE',
          lastSuccessAt: at(600),
        }),
      ],
      nowSec: NOW_SEC,
    })
    const reconcile = section.jobs.find((j) => j.job === 'wh.reconcile')!
    expect(reconcile.state).toBe('failing')
    expect(reconcile.lastErrorCode).toBe('PP_UNAVAILABLE')
    expect(section.state).toBe('stalled')
  })

  it('says the table could not be read, rather than reporting a quiet worker', () => {
    const section = buildWorkerSection({
      heartbeats: [],
      nowSec: NOW_SEC,
      unreadable: true,
      unreadableCode: 'CS_INTERNAL',
    })
    expect(section.unreadable).toBe(true)
    expect(section.state).toBe('never')
    // Both faults produce `never`, and the sentence is the only thing that separates them — which is why it
    // is asserted rather than left to the reader.
    expect(section.summary).toContain('could not be read')
    expect(section.summary).toContain('CS_INTERNAL')
  })

  it('carries the newest finished run in both clocks (AGENTS.md rule 10)', () => {
    const section = buildWorkerSection({
      heartbeats: [row('wh.reconcile', 60), row('wh.disputes', 5)],
      nowSec: NOW_SEC,
    })
    expect(section.lastRunAt).not.toBeNull()
    expect(section.secondsSinceLastRun).toBe(5)
    expect(section.lastRunAt!.utc).toBe(new Date((NOW_SEC - 5) * 1000).toISOString())
    expect(section.lastRunAt!.ist).toMatch(/\+05:30$/)
  })

  it('keeps a cron from an older deploy visible instead of dropping it', () => {
    const section = buildWorkerSection({
      heartbeats: [row('wh.reconcile', 60), row('wh.legacy-sweep', 60)],
      nowSec: NOW_SEC,
    })
    expect(section.jobs.map((j) => j.job)).toContain('wh.legacy-sweep')
  })
})
