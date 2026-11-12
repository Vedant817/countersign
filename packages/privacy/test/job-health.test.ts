/**
 * Job heartbeats — spec §8.19, §14, `docs/PROD_AUDIT.md` §7.
 *
 * ## What these tests are for
 *
 * A Render `type: worker` service has no port and therefore no health check, so the only way anyone learns
 * that the reconciler died is a heartbeat row and a page that reads it. That makes the *state names* the
 * product: "lagging" and "failing" have to mean different things, and "never" must not be quietly reported
 * as "ok" for a deployment whose worker was never started. Each test pins one of those distinctions, because
 * a green dot on a dead worker is exactly the failure this module exists to remove.
 */
import { describe, expect, it } from 'vitest'

import {
  RECONCILER_LAG_SLO_SEC,
  RECONCILER_STALLED_SEC,
  jobHealth,
  workerHealth,
  type JobHealth,
  type JobHealthInput,
} from '../src'

const NOW = 1_800_000_000

/** A heartbeat that last succeeded `ageSec` ago and has never failed. */
function healthy(overrides: Partial<JobHealthInput> = {}): JobHealthInput {
  return {
    job: 'wh.reconcile',
    cadenceSec: 300,
    lastStartedAtSec: NOW - 60,
    lastFinishedAtSec: NOW - 60,
    lastSuccessAtSec: NOW - 60,
    lastFailureAtSec: null,
    lastErrorCode: null,
    nowSec: NOW,
    ...overrides,
  }
}

describe('§8.19 job heartbeat', () => {
  it('says "never" for a job with no record at all, not "ok"', () => {
    const health = jobHealth({
      job: 'wh.disputes',
      cadenceSec: 120,
      lastStartedAtSec: null,
      lastFinishedAtSec: null,
      lastSuccessAtSec: null,
      lastFailureAtSec: null,
      lastErrorCode: null,
      nowSec: NOW,
    })
    expect(health.state).toBe('never')
    expect(health.ageSec).toBeNull()
    expect(health.detail).toContain('never run')
  })

  it('reports ok while the last success is inside the target', () => {
    const health = jobHealth(healthy({ lastSuccessAtSec: NOW - 120 }))
    expect(health.state).toBe('ok')
    expect(health.ageSec).toBe(120)
    expect(health.detail).toContain('target 300s')
  })

  it("reports lagging past §14's five-minute floor, and says which threshold it used", () => {
    const health = jobHealth(healthy({ lastSuccessAtSec: NOW - (RECONCILER_LAG_SLO_SEC + 1) }))
    expect(health.state).toBe('lagging')
    expect(health.lagThresholdSec).toBe(RECONCILER_LAG_SLO_SEC)
  })

  it('escalates to stalled past the stall threshold', () => {
    const health = jobHealth(healthy({ lastSuccessAtSec: NOW - (RECONCILER_STALLED_SEC + 1) }))
    expect(health.state).toBe('stalled')
    expect(health.stallThresholdSec).toBe(RECONCILER_STALLED_SEC)
  })

  it('judges a nightly job against its own cadence, not against five minutes', () => {
    // The bug a flat 300 s threshold would introduce: the 02:17 UTC job runs once a day, so it is
    // "lagging" for 23 hours of every day and the page's red state means nothing.
    const nightly = jobHealth(
      healthy({
        job: 'budget.reconcile',
        cadenceSec: 24 * 60 * 60,
        lastSuccessAtSec: NOW - 6 * 60 * 60,
        lastStartedAtSec: NOW - 6 * 60 * 60,
        lastFinishedAtSec: NOW - 6 * 60 * 60,
      }),
    )
    expect(nightly.state).toBe('ok')
    expect(nightly.lagThresholdSec).toBe(24 * 60 * 60)
  })

  it('reports failing when the most recent run failed, even though the heartbeat is fresh', () => {
    // The case a purely time-based reading gets wrong: a cron that throws on every tick looks perfectly
    // punctual. It is not behind, it is broken.
    const health = jobHealth(
      healthy({
        lastStartedAtSec: NOW - 10,
        lastFinishedAtSec: NOW - 10,
        lastSuccessAtSec: NOW - 3_600,
        lastFailureAtSec: NOW - 10,
        lastErrorCode: 'PP_UNAVAILABLE',
      }),
    )
    expect(health.state).toBe('failing')
    expect(health.lastErrorCode).toBe('PP_UNAVAILABLE')
    expect(health.detail).toContain('PP_UNAVAILABLE')
  })

  it('recovers to ok once a later run succeeds', () => {
    const health = jobHealth(
      healthy({
        lastSuccessAtSec: NOW - 30,
        lastFailureAtSec: NOW - 600,
        lastErrorCode: 'PP_UNAVAILABLE',
      }),
    )
    expect(health.state).toBe('ok')
  })

  it('judges a run that started and never finished by when it started', () => {
    const recent = jobHealth(
      healthy({ lastSuccessAtSec: null, lastFinishedAtSec: null, lastStartedAtSec: NOW - 5 }),
    )
    expect(recent.state).toBe('ok')

    const hung = jobHealth(
      healthy({
        lastSuccessAtSec: null,
        lastFinishedAtSec: null,
        lastStartedAtSec: NOW - (RECONCILER_STALLED_SEC + 1),
      }),
    )
    expect(hung.state).toBe('stalled')
  })

  it('keeps "never succeeded" apart from "succeeded long ago"', () => {
    const never = jobHealth(
      healthy({
        lastSuccessAtSec: null,
        lastFailureAtSec: NOW - 100,
        lastErrorCode: 'CS_INTERNAL',
      }),
    )
    expect(never.state).toBe('failing')
    expect(never.ageSec).toBeNull()
  })
})

describe('§8.19 worker roll-up', () => {
  const at = (state: JobHealth['state'], job: string): JobHealth =>
    jobHealth(
      healthy({
        job,
        lastSuccessAtSec: state === 'never' ? null : NOW - 60,
        lastStartedAtSec: state === 'never' ? null : NOW - 60,
        lastFinishedAtSec: state === 'never' ? null : NOW - 60,
      }),
    )

  it('says the worker is not running when every job has never reported', () => {
    const health = workerHealth([at('never', 'wh.reconcile'), at('never', 'wh.disputes')])
    expect(health.state).toBe('never')
    expect(health.jobs).toBe(2)
    expect(health.detail).toContain('not running')
  })

  it('says never for an empty list, rather than reporting a healthy nothing', () => {
    expect(workerHealth([]).state).toBe('never')
  })

  it('calls one never-run job "lagging" when the rest of the worker is fine', () => {
    // A missing schedule entry is a different fix from a missing worker, and the page has to say which.
    const health = workerHealth([at('ok', 'wh.reconcile'), at('never', 'release.reservations')])
    expect(health.state).toBe('lagging')
    expect(health.never).toBe(1)
  })

  it('promotes a failing job to stalled: nothing is being repaired either way', () => {
    const failing = jobHealth(
      healthy({ job: 'wh.reconcile', lastSuccessAtSec: NOW - 60, lastFailureAtSec: NOW - 5 }),
    )
    expect(workerHealth([failing]).state).toBe('stalled')
  })

  it('is ok only when every job is ok', () => {
    expect(workerHealth([at('ok', 'wh.reconcile'), at('ok', 'wh.disputes')]).state).toBe('ok')
  })
})
