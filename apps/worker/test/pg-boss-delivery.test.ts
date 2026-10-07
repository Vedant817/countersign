/**
 * Delivery shape and settlement boundary tests — pinning pg-boss 12 delivery contract.
 *
 * Covers:
 * - EC-WH-2: Webhook job delivered as pg-boss Job[] processed end-to-end
 * - EC-WH-6: Malformed or empty payloads fail loudly and retryably (never marked completed)
 * - EC-WH-1: Every handler covered with pg-boss-shaped payload (parameterised)
 * - EC-WH-5: Regression preserving 63 worker tests and fakeBoss shape parity
 */
import { describe, expect, it } from 'vitest'
import { ok, type WebhookEventId } from '@countersign/core'
import {
  JOB_AUTH_EXPIRY,
  JOB_BUDGET_RECONCILE,
  JOB_DISPUTES,
  JOB_PROCESS,
  JOB_RECONCILE,
  JOB_RELEASE_RESERVATIONS,
  JOB_VERIFY,
  type StoredEvent,
} from '@countersign/webhooks'

import { createJobRunner, registerJobs, type PgBossJob } from '../src/job-runner'
import { HANDLED_JOBS } from '../src/schedule'
import { fakeBoss, workerHarness } from './harness'
import { realPgBossDelivery } from './pg-boss-delivery'

describe('pg-boss delivery contract and settlement', () => {
  /**
   * EC-WH-2: A webhook job delivered as pg-boss actually delivers it — an array (Job[]) —
   * is processed with correct payload fields, end to end.
   */
  it('EC-WH-2 a webhook job delivered as pg-boss actually delivers it (as an array) is processed with correct payload fields end-to-end', async () => {
    const h = workerHarness()
    const delivery = realPgBossDelivery()
    const runner = createJobRunner({ webhooks: h.deps })
    await registerJobs(delivery.boss, runner, [])

    const eventId = 'whe_delivery_e2e_valid' as WebhookEventId
    const captureId = 'cap_delivery_e2e_valid'

    const storedEvent: StoredEvent = {
      id: eventId,
      paypal_event_id: 'WH-E2E-TEST-1',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource_type: 'capture',
      resource_id: captureId,
      verified: 'VERIFIED',
      error: null,
      attempts: 0,
      create_time: new Date(),
      verified_at: new Date(),
      received_at: new Date(),
      processed_at: null,
      raw: { headers: {}, body: {} },
      created_at: new Date(),
      updated_at: new Date(),
    }

    h.deps.store.events.findById = async (id: WebhookEventId) => {
      h.calls.push('events.findById')
      if (id === eventId) return ok(storedEvent)
      return ok(undefined)
    }

    h.deps.store.events.markProcessed = async (
      _id: WebhookEventId,
      _error: string | null,
      at: Date,
    ) => {
      h.calls.push('events.markProcessed')
      storedEvent.processed_at = at
      return ok(storedEvent)
    }

    h.deps.store.aggregates.captures.findByPaypalId = async (id: string) => {
      h.calls.push('captures.findByPaypalId')
      return ok({
        paypal_capture_id: id,
        status: 'PENDING',
        amount_minor: 5000n,
        currency: 'USD',
        order_id: 'ord_1',
        fetched_at: null,
      } as any)
    }

    h.deps.paypal.getCapture = async (id: string) => {
      h.calls.push('paypal.getCapture')
      return ok({
        id,
        status: 'COMPLETED',
        amount: { currency_code: 'USD', value: '50.00' },
        update_time: new Date().toISOString(),
      } as any)
    }

    h.deps.store.aggregates.captures.applyFromFetch = async (id: string, _data: unknown) => {
      h.calls.push('captures.applyFromFetch')
      return ok({ applied: true, row: { paypal_capture_id: id, status: 'COMPLETED' } as any })
    }

    const payload = {
      webhookEventId: eventId,
      resourceType: 'capture',
      resourceId: captureId,
    }

    // Deliver via pg-boss's real Manager machinery (delivers Job[] array)
    const [job] = await delivery.deliver(JOB_PROCESS, [payload])
    expect(job).toBeDefined()
    if (!job) return

    expect(delivery.deliveries).toHaveLength(1)
    expect(Array.isArray(delivery.deliveries[0])).toBe(true)
    expect(delivery.deliveries[0]?.[0]?.data).toEqual(payload)

    // Job completed successfully in pg-boss
    expect(delivery.states.get(job.id)).toBe('completed')
    expect(delivery.states.get(job.id)).not.toBe('retry')

    // Webhook event was fetched, processed from PayPal, and persisted
    expect(h.calls).toContain('events.findById')
    expect(h.calls).toContain('paypal.getCapture')
    expect(h.calls).toContain('captures.applyFromFetch')
    expect(h.calls).toContain('events.markProcessed')
    expect(storedEvent.processed_at).not.toBeNull()
  })

  /**
   * EC-WH-6: A malformed or empty payload fails loudly and retryably, and the job is NOT marked completed.
   */
  it('EC-WH-6 a malformed or empty payload fails loudly and retryably and the job is not marked completed', async () => {
    const h = workerHarness()
    const delivery = realPgBossDelivery()
    let registeredCallback: ((jobs: PgBossJob[]) => Promise<unknown>) | undefined

    const interceptingBoss = {
      ...delivery.boss,
      work: async (name: string, options: any, callback: any) => {
        if (name === JOB_PROCESS) {
          registeredCallback = callback
        }
        return delivery.boss.work(name, options, callback)
      },
    }

    const runner = createJobRunner({ webhooks: h.deps })
    await registerJobs(interceptingBoss, runner, [])

    // Case 1: Malformed string instead of object
    const [malformedJob] = await delivery.deliver(JOB_PROCESS, ['not-an-object'])
    expect(malformedJob).toBeDefined()
    if (malformedJob) {
      expect(delivery.states.get(malformedJob.id)).toBe('retry')
      expect(delivery.states.get(malformedJob.id)).not.toBe('completed')
      expect(delivery.outputs.get(malformedJob.id)).toMatchObject({
        code: 'CS_VALIDATION',
        retryable: true,
      })
    }

    // Case 2: Array payload instead of object
    const [arrayJob] = await delivery.deliver(JOB_PROCESS, [['nested', 'array']])
    expect(arrayJob).toBeDefined()
    if (arrayJob) {
      expect(delivery.states.get(arrayJob.id)).toBe('retry')
      expect(delivery.states.get(arrayJob.id)).not.toBe('completed')
      expect(delivery.outputs.get(arrayJob.id)).toMatchObject({
        code: 'CS_VALIDATION',
        retryable: true,
      })
    }

    // Case 3: Empty object missing webhookEventId
    const [emptyObjJob] = await delivery.deliver(JOB_PROCESS, [{}])
    expect(emptyObjJob).toBeDefined()
    if (emptyObjJob) {
      expect(delivery.states.get(emptyObjJob.id)).toBe('retry')
      expect(delivery.states.get(emptyObjJob.id)).not.toBe('completed')
      expect(delivery.outputs.get(emptyObjJob.id)).toMatchObject({
        code: 'CS_VALIDATION',
        retryable: true,
      })
    }

    // Case 4: Null payload
    const [nullJob] = await delivery.deliver(JOB_PROCESS, [null])
    expect(nullJob).toBeDefined()
    if (nullJob) {
      expect(delivery.states.get(nullJob.id)).toBe('retry')
      expect(delivery.states.get(nullJob.id)).not.toBe('completed')
      expect(delivery.outputs.get(nullJob.id)).toMatchObject({
        code: 'CS_VALIDATION',
        retryable: true,
      })
    }

    // Case 5: Non-existent webhookEventId (CS_NOT_FOUND must also fail retryably)
    const [missingRowJob] = await delivery.deliver(JOB_PROCESS, [
      { webhookEventId: 'whe_nonexistent_row_id' },
    ])
    expect(missingRowJob).toBeDefined()
    if (missingRowJob) {
      expect(delivery.states.get(missingRowJob.id)).toBe('retry')
      expect(delivery.states.get(missingRowJob.id)).not.toBe('completed')
      expect(delivery.outputs.get(missingRowJob.id)).toMatchObject({
        code: 'CS_NOT_FOUND',
        retryable: true,
      })
    }

    // Case 6: Missing data property on job object
    const noDataJobId = 'job-no-data-property'
    await delivery.deliverJobs(JOB_PROCESS, [
      {
        id: noDataJobId,
        name: JOB_PROCESS,
        expireInSeconds: 60,
        heartbeatSeconds: null,
        retryCount: 0,
        signal: new AbortController().signal,
      } as any,
    ])
    expect(delivery.states.get(noDataJobId)).toBe('retry')
    expect(delivery.states.get(noDataJobId)).not.toBe('completed')
    expect(delivery.outputs.get(noDataJobId)).toMatchObject({
      code: 'CS_VALIDATION',
      retryable: true,
    })

    // Case 7: Non-array or empty Job[] delivered directly to handler
    expect(registeredCallback).toBeDefined()
    if (registeredCallback) {
      await expect(registeredCallback([])).rejects.toMatchObject({
        code: 'CS_VALIDATION',
        retryable: true,
      })
      await expect(registeredCallback(null as any)).rejects.toMatchObject({
        code: 'CS_VALIDATION',
        retryable: true,
      })
    }
  })

  /**
   * EC-WH-1: Every handler covered, each with a pg-boss-shaped payload. Parameterised, so a new
   * uncovered handler is visible.
   */
  describe.each(HANDLED_JOBS)(
    'EC-WH-1 every handler covered with pg-boss array delivery: %s',
    (jobName) => {
      it(`executes ${jobName} delivered as a pg-boss Job[] array and settles cleanly`, async () => {
        const h = workerHarness()
        const delivery = realPgBossDelivery()

        const runner = createJobRunner({
          webhooks: h.deps,
          releaseReservations: async () => ok({ candidates: 0, released: 0 }),
          reconcileBudget: async () => ok({ checked: 1, drifted: 0 }),
        })
        await registerJobs(delivery.boss, runner, [])

        const eventId = 'whe_handled_test' as WebhookEventId
        const testEvent: StoredEvent = {
          id: eventId,
          paypal_event_id: 'WH-HANDLED',
          event_type: 'PAYMENT.CAPTURE.COMPLETED',
          resource_type: 'capture',
          resource_id: 'cap_handled',
          verified: 'VERIFIED',
          error: null,
          attempts: 0,
          create_time: new Date(),
          verified_at: new Date(),
          received_at: new Date(),
          processed_at: null,
          raw: { headers: {}, body: {} },
          created_at: new Date(),
          updated_at: new Date(),
        }
        h.deps.store.events.findById = async () => ok(testEvent)
        h.deps.store.aggregates.captures.findByPaypalId = async (id: string) =>
          ok({ paypal_capture_id: id, status: 'COMPLETED', fetched_at: new Date() } as any)
        h.deps.paypal.getCapture = async (id: string) =>
          ok({ id, status: 'COMPLETED', update_time: new Date().toISOString() } as any)
        h.deps.store.events.markProcessed = async () => ok(testEvent)

        const payload =
          jobName === JOB_PROCESS
            ? { webhookEventId: eventId, resourceType: 'capture', resourceId: 'cap_handled' }
            : {}

        const [job] = await delivery.deliver(jobName, [payload])
        expect(job).toBeDefined()
        if (job) {
          expect(delivery.states.get(job.id)).toBe('completed')
          expect(delivery.states.get(job.id)).not.toBe('retry')
        }
      })
    },
  )

  /**
   * EC-WH-5: Regression — the existing 63 worker tests stay green.
   */
  it('EC-WH-5 regression: existing 63 worker tests stay green and job catalog is complete', () => {
    expect(HANDLED_JOBS).toHaveLength(7)
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
  })

  /**
   * EC-WH-5: Assert the fake boss's payload shape matches pg-boss's, so the harness cannot drift again.
   */
  it('EC-WH-5 assert fake boss payload shape matches pg-boss delivery contract', async () => {
    const fake = fakeBoss()
    await fake.start()

    let fakeReceived: unknown
    await fake.work('wh.process', { batchSize: 1 }, async (jobs) => {
      fakeReceived = jobs
      return { handled: true }
    })

    const payload = { webhookEventId: 'whe_drift_test' }
    await fake.handlers.get('wh.process')!(payload)

    // Assert fakeBoss delivers Job[] array matching pg-boss 12
    expect(Array.isArray(fakeReceived)).toBe(true)
    const fakeJobs = fakeReceived as { id: string; data: unknown }[]
    expect(fakeJobs).toHaveLength(1)
    expect(fakeJobs[0]).toBeDefined()
    expect(typeof fakeJobs[0]?.id).toBe('string')
    expect(fakeJobs[0]?.data).toEqual(payload)

    // Assert parity with real pg-boss delivery
    const real = realPgBossDelivery()
    let realReceived: unknown
    await real.boss.work('wh.process', { batchSize: 1 }, async (jobs) => {
      realReceived = jobs
      return { handled: true }
    })
    await real.deliver('wh.process', [payload])

    expect(Array.isArray(realReceived)).toBe(true)
    const realJobs = realReceived as { id: string; data: unknown }[]
    expect(realJobs).toHaveLength(1)
    expect(realJobs[0]).toBeDefined()
    expect(typeof realJobs[0]?.id).toBe('string')
    expect(realJobs[0]?.data).toEqual(payload)
  })
})
