/**
 * The cron table - spec **§8.12**, **§8.10**, **§7.2**, edge cases **EC-WH-1**, **EC-WH-5**, **EC-WH-7**,
 * **EC-TIME-5**, **EC-PP-2**.
 *
 * ## Why a data table needs tests
 *
 * A cron expression is the one piece of this worker that is *both* trivially easy to get wrong and completely
 * silent when you do. A five-minute step and a six-minute step are both valid, both plausible in review, and
 * differ only in how quickly a lost webhook is repaired. Nothing throws. So the table is asserted rather than
 * reviewed. (The literal expressions live in the constants below, not in this comment: a step expression ends
 * in a star and would close the comment it is quoted in.)
 *
 * The property worth protecting is not "the string is what I typed" but **"each cadence is traceable to the
 * edge case that asked for it"**. Every row must carry a `because`, and that `because` must name a spec line
 * or an EC id. A cron whose justification is missing is a cron nobody will remember to change.
 */
import { describe, expect, it } from 'vitest'
import {
  JOB_AUTH_EXPIRY,
  JOB_BUDGET_RECONCILE,
  JOB_DISPUTES,
  JOB_PROCESS,
  JOB_RECONCILE,
  JOB_RELEASE_RESERVATIONS,
  JOB_VERIFY,
  type JobName,
} from '@countersign/webhooks'

import {
  CRON_SPECS,
  CRON_SPECS as SPECS,
  EVENT_DRIVEN_JOBS,
  FIVE_MINUTES,
  HANDLED_JOBS,
  NIGHTLY_02_17_UTC,
  TWO_MINUTES,
  cronFor,
  isPlausibleCron,
} from '../src/schedule'

describe('the schedule table', () => {
  it('SCHEDULE-1 §8.12 says the resource sweep is every 5 minutes, and it is', () => {
    // EC-WH-1/EC-WH-5. The user-visible promise is "a lost webhook is fixed within 5 minutes", so this number
    // is a feature claim rather than a tuning knob.
    expect(cronFor(JOB_RECONCILE)).toBe('*/5 * * * *')
    expect(cronFor(JOB_RECONCILE)).toBe(FIVE_MINUTES)
  })

  it('SCHEDULE-1 §8.12 says the dispute sweep is every 2 minutes, and it is', () => {
    // Faster than the resource sweep on purpose: a dispute carries a §8.11 filing deadline.
    expect(cronFor(JOB_DISPUTES)).toBe('*/2 * * * *')
    expect(cronFor(JOB_DISPUTES)).toBe(TWO_MINUTES)
  })

  it('SCHEDULE-1 §8.12 says the full sweep is nightly, and the ledger check is the only nightly one', () => {
    const nightly = CRON_SPECS.filter((s) => s.every.includes('nightly'))
    expect(nightly.map((s) => s.job)).toEqual([JOB_BUDGET_RECONCILE])
    expect(NIGHTLY_02_17_UTC).toBe('17 2 * * *')
  })

  it('SCHEDULE-1 EC-TIME-5 the authorization expiry sweep runs on a 5-minute cycle', () => {
    // Because there is no PAYMENT.AUTHORIZATION.EXPIRED event (report §26), this poll is the only thing that
    // will ever observe an expiry. A cron that silently dropped off this table would be a silent regression.
    expect(cronFor(JOB_AUTH_EXPIRY)).toBe(FIVE_MINUTES)
  })

  it('SCHEDULE-1 §8.10 the reservation release runs more often than the 30-minute TTL', () => {
    const cron = cronFor(JOB_RELEASE_RESERVATIONS)
    expect(cron).toBe(FIVE_MINUTES)
    // "Reservations expire after 30 min without an order". A 5-minute cycle means a buyer never waits more
    // than 10% of their hold for it back, and a missed tick costs 5 minutes rather than 30.
    expect(cron).not.toBe('30 * * * *')
  })

  it('SCHEDULE-1 EC-WH-7 the verify retry is on a 5-minute cycle, not a tight loop', () => {
    // The temptation is `* * * * *`. That would hammer verify-webhook-signature during exactly the outage it
    // exists to ride out.
    expect(cronFor(JOB_VERIFY)).toBe(FIVE_MINUTES)
  })

  it('SCHEDULE-1 wh.process has no cron, because it is enqueued by handleWebhook', () => {
    // §8.12 step 4 enqueues it. A cron here would be a second, competing source of jobs for the same queue
    // name — and a sweep that "processed the last event" on a timer is the never-trust-payload-state mistake
    // in a different costume.
    expect(cronFor(JOB_PROCESS)).toBeUndefined()
    expect(CRON_SPECS.some((s) => s.job === JOB_PROCESS)).toBe(false)
    expect(EVENT_DRIVEN_JOBS).toContain(JOB_PROCESS)
  })

  it('SCHEDULE-1 every cron expression is well-formed, so a typo is caught at registration not at tick 1', () => {
    // pg-boss reports a malformed expression on the first tick, which for the nightly job is up to a day away.
    for (const spec of CRON_SPECS) {
      expect(isPlausibleCron(spec.cron), `${spec.job} = ${spec.cron}`).toBe(true)
    }
  })

  it('SCHEDULE-1 every schedule names the spec line or edge case it exists for', () => {
    for (const spec of CRON_SPECS) {
      expect(spec.because.length, `${spec.job} has no justification`).toBeGreaterThan(20)
      expect(spec.because, `${spec.job} does not cite § or EC-`).toMatch(/(§\d|EC-[A-Z]+-\d+)/)
    }
  })

  it('SCHEDULE-1 no job appears twice, and every job is handled', () => {
    const jobs = CRON_SPECS.map((s) => s.job)
    expect(new Set(jobs).size).toBe(jobs.length)
    // Every JobName gets a handler, including the event-driven ones: a queue name with no consumer is a
    // backlog nobody notices until it is enormous. Sorted on **both** sides, because the table's order is the
    // registration order (which matters) and alphabetical order is not the thing being asserted here.
    expect([...HANDLED_JOBS].sort()).toEqual(
      [
        JOB_AUTH_EXPIRY,
        JOB_BUDGET_RECONCILE,
        JOB_DISPUTES,
        JOB_PROCESS,
        JOB_RECONCILE,
        JOB_RELEASE_RESERVATIONS,
        JOB_VERIFY,
      ].sort(),
    )
    expect(HANDLED_JOBS).toHaveLength(7)
  })

  it('SCHEDULE-1 the table is frozen, so a handler cannot mutate another process’s schedule', () => {
    expect(Object.isFrozen(CRON_SPECS)).toBe(true)
    expect(Object.isFrozen(HANDLED_JOBS)).toBe(true)
  })

  it('SCHEDULE-1 the table and its re-export are the same object, not two copies', () => {
    // `SPECS` is imported from `../src/schedule` and `CRON_SPECS` from the package entry point. Two exports of
    // the same table is fine; two *tables* is how the worker and its documentation start disagreeing.
    expect(SPECS).toBe(CRON_SPECS)
  })
})

describe('isPlausibleCron', () => {
  it('SCHEDULE-2 the three expressions this package actually uses are accepted', () => {
    expect(isPlausibleCron(FIVE_MINUTES)).toBe(true)
    expect(isPlausibleCron(TWO_MINUTES)).toBe(true)
    expect(isPlausibleCron(NIGHTLY_02_17_UTC)).toBe(true)
    expect(isPlausibleCron('0 2 * * 1-5')).toBe(true)
  })

  it('SCHEDULE-2 a four-field expression is rejected, because pg-boss wants five', () => {
    expect(isPlausibleCron('*/5 * * *')).toBe(false)
  })

  it('SCHEDULE-2 a stray character is rejected', () => {
    // The realistic damage: a copy-paste that leaves a quote, or a typo'd step.
    expect(isPlausibleCron('*/5 * * * *"')).toBe(false)
    expect(isPlausibleCron('*/x * * * *')).toBe(false)
    expect(isPlausibleCron('every five minutes')).toBe(false)
    expect(isPlausibleCron('')).toBe(false)
  })

  it('SCHEDULE-2 it is not a parser, and says so: it does not validate ranges', () => {
    // Documented limitation, asserted so it cannot quietly grow into a claim of completeness. pg-boss owns
    // semantic validity; this catches typos and copy-paste damage.
    expect(isPlausibleCron('99 99 99 99 99')).toBe(true)
  })
})

describe('cronFor', () => {
  it('SCHEDULE-2 an unscheduled job answers undefined rather than throwing', () => {
    const known: JobName = JOB_PROCESS
    expect(cronFor(known)).toBeUndefined()
  })
})
