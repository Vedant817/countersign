/**
 * The retention sweep planner — spec §8.19, §12.13.
 *
 * The cases here are the clock faults, not the happy path. "Delete rows past their deadline" is
 * one line and obviously correct; what destroys a deployment is the clock being wrong, and the
 * interesting assertions are therefore about what the planner **refuses** to plan.
 */
import { describe, expect, it } from 'vitest'

import {
  EARLIEST_PLAUSIBLE_SEC,
  SECONDS_PER_DAY,
  WEBHOOK_RETENTION_DAYS,
  describeSweep,
  planSweep,
  sweepableClasses,
  type SweepCandidate,
} from '../src/index'

const NOW = Date.UTC(2027, 5, 1) / 1000

describe('planSweep', () => {
  it('purges past the deadline and keeps everything else', () => {
    const candidates: readonly SweepCandidate[] = [
      // 100 days old, webhook payloads are kept 90: overdue.
      { class: 'WEBHOOK_PAYLOADS', id: 'wh_old', processedAtSec: NOW - 100 * SECONDS_PER_DAY },
      // 10 days old: inside the window.
      { class: 'WEBHOOK_PAYLOADS', id: 'wh_new', processedAtSec: NOW - 10 * SECONDS_PER_DAY },
    ]

    const plan = planSweep(candidates, NOW)
    if (!plan.ok) throw new Error(`unexpected error: ${plan.error.code}`)

    expect(plan.value.purge.map((p) => p.id)).toEqual(['wh_old'])
    expect(plan.value.keep.map((k) => k.id)).toEqual(['wh_new'])
    expect(plan.value.byClass['WEBHOOK_PAYLOADS']).toEqual({ purge: 1, keep: 1 })
  })

  it('purges exactly on the deadline, not one second later', () => {
    // Off-by-one in the other direction keeps a row for ever; this pins the boundary.
    const processedAtSec = NOW - WEBHOOK_RETENTION_DAYS * SECONDS_PER_DAY
    const plan = planSweep([{ class: 'WEBHOOK_PAYLOADS', id: 'wh', processedAtSec }], NOW)
    if (!plan.ok) throw new Error(`unexpected error: ${plan.error.code}`)
    expect(plan.value.purge).toHaveLength(1)
    expect(plan.value.purge[0]?.deadlineSec).toBe(NOW)
  })

  it('refuses to plan a purge from before Countersign existed', () => {
    // The failure this prevents is unrecoverable: a container with no clock would purge every row in
    // the database, and no backup taken after the fact contains them.
    const plan = planSweep(
      [{ class: 'WEBHOOK_PAYLOADS', id: 'wh', processedAtSec: 0 }],
      EARLIEST_PLAUSIBLE_SEC - 1,
    )
    expect(plan.ok).toBe(false)
    if (plan.ok) throw new Error('unreachable')
    expect(plan.error.code).toBe('CS_VALIDATION')
    expect(plan.error.message).toContain('clock')
  })

  it('refuses a malformed clock rather than treating it as zero', () => {
    expect(planSweep([], 1.5).ok).toBe(false)
    expect(planSweep([], -1).ok).toBe(false)
    expect(planSweep([], Number.NaN).ok).toBe(false)
  })

  it('fails the whole plan for a class with no deadline, instead of skipping the row', () => {
    // Skipping would leave rows the privacy page says are purged, and nobody would notice.
    const plan = planSweep([{ class: 'ACCOUNT_AND_WALLET', id: 'usr_1', processedAtSec: 0 }], NOW)
    expect(plan.ok).toBe(false)
    if (plan.ok) throw new Error('unreachable')
    expect(plan.error.message).toContain('cannot be swept')
  })

  it('lists the five timed classes and excludes the account row', () => {
    const classes = sweepableClasses()
    expect(classes).toHaveLength(5)
    expect(classes).not.toContain('ACCOUNT_AND_WALLET')
    expect(classes).toContain('OPERATIONAL_LOGS')
  })

  it('is deterministic, so a dry run and the run that follows agree', () => {
    const candidates: readonly SweepCandidate[] = [
      { class: 'LLM_PROMPTS', id: 'p1', processedAtSec: NOW - 40 * SECONDS_PER_DAY },
      { class: 'OPERATIONAL_LOGS', id: 'l1', processedAtSec: NOW - 400 * SECONDS_PER_DAY },
      { class: 'EVIDENCE_PACKETS', id: 'e1', processedAtSec: NOW - 600 * SECONDS_PER_DAY },
      { class: 'MANDATES_AND_DECISIONS', id: 'm1', processedAtSec: NOW - 10 * SECONDS_PER_DAY },
    ]
    const first = planSweep(candidates, NOW)
    const second = planSweep(candidates, NOW)
    expect(first).toEqual(second)
    if (!first.ok) throw new Error('unexpected error')
    expect(first.value.purge.map((p) => p.id)).toEqual(['p1', 'l1', 'e1'])
  })

  it('summarises per class for a job log', () => {
    const plan = planSweep(
      [
        { class: 'WEBHOOK_PAYLOADS', id: 'a', processedAtSec: NOW - 100 * SECONDS_PER_DAY },
        { class: 'LLM_PROMPTS', id: 'b', processedAtSec: NOW - SECONDS_PER_DAY },
      ],
      NOW,
    )
    if (!plan.ok) throw new Error('unexpected error')
    expect(describeSweep(plan.value)).toBe(
      'LLM_PROMPTS: 0 purged, 1 kept · WEBHOOK_PAYLOADS: 1 purged, 0 kept',
    )
    expect(describeSweep({ nowSec: NOW, purge: [], keep: [], byClass: {} })).toBe(
      'nothing to sweep',
    )
  })
})
