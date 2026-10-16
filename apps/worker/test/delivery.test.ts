import { describe, expect, it } from 'vitest'
import { csError, err, ok, type WebhookEventId } from '@countersign/core'
import {
  JOB_AUTH_EXPIRY,
  JOB_BUDGET_RECONCILE,
  JOB_DISPUTES,
  JOB_PROCESS,
  JOB_RECONCILE,
  JOB_RELEASE_RESERVATIONS,
  JOB_VERIFY,
  type JobName,
  type StoredEvent,
} from '@countersign/webhooks'

import { createJobRunner, registerJobs, type PgBossJob } from '../src/job-runner'
import { fakeBoss, NOW, recordingLogger, workerHarness } from './harness'
import { realPgBossDelivery } from './pg-boss-delivery'

const payload = {
  webhookEventId: 'whe_delivery',
  resourceId: 'local-capture',
  resourceType: 'capture',
  eventType: 'PAYMENT.CAPTURE.COMPLETED',
}

/** A local durable event, not a simulated PayPal response. No PayPal call is needed for EC-WH-6. */
function storedEvent(): StoredEvent {
  return {
    id: payload.webhookEventId as WebhookEventId,
    paypal_event_id: 'local-delivery-event',
    event_type: payload.eventType,
    resource_type: payload.resourceType,
    resource_id: payload.resourceId,
    create_time: NOW,
    verified: 'VERIFIED',
    verified_at: NOW,
    raw: {},
    received_at: NOW,
    processed_at: null,
    attempts: 0,
    error: null,
    created_at: NOW,
    updated_at: NOW,
  }
}

/** The public job vocabulary is exhaustively checked against the runner below. */
const cases: { job: JobName; calls: string[] }[] = [
  {
    job: JOB_PROCESS,
    calls: ['events.findById', 'captures.findByPaypalId', 'events.markProcessed'],
  },
  { job: JOB_VERIFY, calls: ['events.listUnverified'] },
  { job: JOB_RECONCILE, calls: ['events.listUnprocessed', 'orders.reconcileCandidates'] },
  { job: JOB_DISPUTES, calls: ['listDisputes'] },
  { job: JOB_AUTH_EXPIRY, calls: ['authorizations.reconcileCandidates'] },
  { job: JOB_RELEASE_RESERVATIONS, calls: [JOB_RELEASE_RESERVATIONS] },
  { job: JOB_BUDGET_RECONCILE, calls: [JOB_BUDGET_RECONCILE] },
]

function deliveryHarness() {
  const h = workerHarness()
  const row = storedEvent()
  h.deps.store.events.findById = async (id) => {
    h.calls.push('events.findById')
    expect(id).toBe(row.id)
    return ok(row)
  }
  h.deps.store.aggregates.captures.findByPaypalId = async (id) => {
    h.calls.push('captures.findByPaypalId')
    expect(id).toBe(row.resource_id)
    return ok(undefined)
  }
  h.deps.store.events.markProcessed = async (id, error, at) => {
    h.calls.push('events.markProcessed')
    expect(id).toBe(row.id)
    row.processed_at = at
    row.error = error
    row.attempts += 1
    return ok(row)
  }
  const { logger, lines } = recordingLogger()
  const runner = createJobRunner({
    webhooks: h.deps,
    logger,
    releaseReservations: async (data) => {
      h.calls.push(JOB_RELEASE_RESERVATIONS)
      expect(data).toEqual(payload)
      return ok({ released: 0 })
    },
    reconcileBudget: async (data) => {
      h.calls.push(JOB_BUDGET_RECONCILE)
      expect(data).toEqual(payload)
      return ok({ drift: 0 })
    },
  })
  return { h, row, runner, lines }
}

describe('pg-boss delivery regression', () => {
  it('EC-WH-6 real pg-boss Job[] processes the correct durable webhook end to end', async () => {
    const { h, row, runner, lines } = deliveryHarness()
    const queue = realPgBossDelivery()
    await registerJobs(queue.boss, runner, [])
    const jobs = await queue.deliver(JOB_PROCESS, [payload])
    expect(queue.deliveries[0]?.[0]?.data).toEqual(payload)
    expect(queue.states.get(jobs[0]!.id)).toBe('completed')
    expect(queue.outputs.get(jobs[0]!.id)).toMatchObject({ outcome: 'IGNORED' })
    expect(row.processed_at).toEqual(NOW)
    expect(row.attempts).toBe(1)
    expect(h.calls).toEqual(cases[0]!.calls)
    expect(lines).toContainEqual(
      expect.objectContaining({
        msg: 'webhook event processed',
        fields: expect.objectContaining({
          webhook_event_id: row.id,
          paypal_event_id: row.paypal_event_id,
        }),
      }),
    )
  })

  it.each([undefined, null, {}, [], '', 1, { webhookEventId: 1 }, { webhookEventId: 'wrong' }])(
    'EC-WH-5 malformed webhook payload %j retries and is never completed',
    async (data) => {
      const h = workerHarness()
      const queue = realPgBossDelivery()
      await registerJobs(queue.boss, createJobRunner({ webhooks: h.deps }), [])
      const jobs = await queue.deliver(JOB_PROCESS, [data])
      expect(queue.states.get(jobs[0]!.id)).toBe('retry')
      expect(queue.outputs.get(jobs[0]!.id)).toMatchObject({
        code: 'CS_VALIDATION',
        retryable: true,
      })
      expect(h.calls).toEqual([])
      // Both doubles must record the same failure disposition, not just a thrown promise.
      const fake = fakeBoss()
      await registerJobs(fake, createJobRunner({ webhooks: h.deps }), [])
      await expect(fake.handlers.get(JOB_PROCESS)!(data)).rejects.toMatchObject({
        code: 'CS_VALIDATION',
        retryable: true,
      })
      expect([...fake.jobs.values()].map((job) => job.state)).toEqual(['retry'])
    },
  )

  it.each(cases)(
    'EC-WH-5 every registered handler receives pg-boss delivery: $job',
    async ({ job, calls }) => {
      const { h, runner } = deliveryHarness()
      expect(Object.keys(runner).sort()).toEqual(cases.map((entry) => entry.job).sort())
      const queue = realPgBossDelivery()
      await registerJobs(queue.boss, runner, [])
      const jobs = await queue.deliver(job, [payload])
      expect(queue.states.get(jobs[0]!.id)).toBe('completed')
      expect(h.calls).toEqual(expect.arrayContaining(calls))
    },
  )

  it.each(cases)('EC-WH-5 malformed non-object payload retries for $job', async ({ job }) => {
    const { h, runner } = deliveryHarness()
    const queue = realPgBossDelivery()
    await registerJobs(queue.boss, runner, [])
    const jobs = await queue.deliver(job, ['not-an-object'])
    expect(queue.states.get(jobs[0]!.id)).toBe('retry')
    expect(queue.outputs.get(jobs[0]!.id)).toMatchObject({ code: 'CS_VALIDATION', retryable: true })
    expect(h.calls).toEqual([])
  })

  it.each(cases)('EC-WH-5 unavailable required storage retries for $job', async ({ job }) => {
    const failure = err(csError('CS_INTERNAL', 'required storage unavailable'))
    const h = workerHarness({
      fail: { unverified: 'CS_INTERNAL', events: 'CS_INTERNAL', disputes: 'CS_INTERNAL' },
    })
    h.deps.store.events.findById = async () => failure
    h.deps.store.aggregates.authorizations.reconcileCandidates = async () => failure
    const runner = createJobRunner({
      webhooks: h.deps,
      releaseReservations: async () => failure,
      reconcileBudget: async () => failure,
    })
    const queue = realPgBossDelivery()
    await registerJobs(queue.boss, runner, [])
    const jobs = await queue.deliver(job, [payload])
    expect(queue.states.get(jobs[0]!.id)).toBe('retry')
    expect(queue.outputs.get(jobs[0]!.id)).toMatchObject({ code: 'CS_INTERNAL', retryable: true })
  })

  it('EC-WH-5 fake boss delivery matches the installed pg-boss callback shape', async () => {
    const real = realPgBossDelivery()
    const fake = fakeBoss()
    const seen: unknown[] = []
    for (const boss of [real.boss, fake]) {
      await boss.work(JOB_PROCESS, { batchSize: 1 }, async (jobs) => {
        seen.push(jobs)
        return 'observed'
      })
    }
    await real.deliver(JOB_PROCESS, [payload])
    await fake.handlers.get(JOB_PROCESS)!(payload)
    const shape = (batch: unknown) => {
      expect(Array.isArray(batch)).toBe(true)
      const jobs = batch as PgBossJob[]
      return {
        length: jobs.length,
        data: jobs.map((job) => job.data),
        ids: jobs.every((job) => typeof job.id === 'string'),
      }
    }
    expect(shape(seen[1])).toEqual(shape(seen[0]))
    expect(shape(seen[0])).toEqual({ length: 1, data: [payload], ids: true })
    expect([...real.states.values()]).toEqual(['completed'])
    expect([...fake.jobs.values()].map((job) => job.state)).toEqual(['completed'])
  })

  it('EC-WH-5 missing durable webhook subjects retry instead of asserting processing succeeded', async () => {
    const h = workerHarness()
    const queue = realPgBossDelivery()
    await registerJobs(queue.boss, createJobRunner({ webhooks: h.deps }), [])
    const jobs = await queue.deliver(JOB_PROCESS, [payload])
    expect(queue.states.get(jobs[0]!.id)).toBe('retry')
    expect(queue.outputs.get(jobs[0]!.id)).toMatchObject({ code: 'CS_NOT_FOUND', retryable: true })
    expect(h.calls).toEqual(['events.findById'])
  })

  it.each([JOB_RELEASE_RESERVATIONS, JOB_BUDGET_RECONCILE])(
    'EC-WH-5 unwired $0 rejects instead of completing a skipped job',
    async (job) => {
      const queue = realPgBossDelivery()
      await registerJobs(queue.boss, createJobRunner({ webhooks: workerHarness().deps }), [])
      const jobs = await queue.deliver(job, [null])
      expect(queue.states.get(jobs[0]!.id)).toBe('retry')
      expect(queue.outputs.get(jobs[0]!.id)).toMatchObject({ code: 'CS_INTERNAL', retryable: true })
    },
  )

  it.each(cases.filter(({ job }) => job !== JOB_PROCESS))(
    'EC-WH-5 payload-free scheduled $job accepts pg-boss null data',
    async ({ job }) => {
      const queue = realPgBossDelivery()
      const runner = createJobRunner({
        webhooks: workerHarness().deps,
        releaseReservations: async (data) => {
          expect(data).toBeNull()
          return ok({})
        },
        reconcileBudget: async (data) => {
          expect(data).toBeNull()
          return ok({})
        },
      })
      await registerJobs(queue.boss, runner, [])
      const jobs = await queue.deliver(job, [null])
      expect(queue.states.get(jobs[0]!.id)).toBe('completed')
    },
  )

  it('EC-WH-5 every member of an unexpected larger Job[] is delivered', async () => {
    const queue = realPgBossDelivery()
    const received: unknown[] = []
    const runner = createJobRunner({
      webhooks: workerHarness().deps,
      releaseReservations: async (data) => {
        received.push(data)
        return ok({})
      },
    })
    await registerJobs(queue.boss, runner, [])
    const payloads = [{ attemptId: 'first' }, { attemptId: 'second' }]
    const jobs = await queue.deliver(JOB_RELEASE_RESERVATIONS, payloads)
    expect(received).toEqual(payloads)
    expect(jobs.map((job) => queue.states.get(job.id))).toEqual(['completed', 'completed'])
  })

  it('EC-WH-5 malformed callback envelopes reject retryably', async () => {
    const fake = fakeBoss()
    await registerJobs(fake, createJobRunner({ webhooks: workerHarness().deps }), [])
    expect(
      fake.worked.every(
        ({ options }) => options.batchSize === 1 && options.localConcurrency === 10,
      ),
    ).toBe(true)
    const callback = fake.callbacks.get(JOB_PROCESS)!
    for (const envelope of [[], {}, [{ id: 'no-data' }], [null]]) {
      await expect(callback(envelope as PgBossJob[])).rejects.toMatchObject({
        code: 'CS_VALIDATION',
        retryable: true,
      })
    }
  })
})
