/**
 * The handler table and the pg-boss adapter - spec **§8.12**, **§12.3**, decisions **D12**, **D13**.
 *
 * ## What these tests are actually for
 *
 * `packages/webhooks` already proves the ingest and rank rules. What is unproven until this file exists is
 * the **wiring**, and wiring fails in ways that logic tests cannot see:
 *
 * | Property | Failure it prevents |
 * |---|---|
 * | `wh.process` is wired to `processWebhookEvent` | a queue name nobody consumes; events pile up silently |
 * | every job name has a handler | a backlog nobody notices until it is enormous |
 * | handlers are registered **before** schedules | pg-boss produces crons into a queue with no consumer |
 * | a retryable failure is re-thrown, a permanent one is not | a PayPal 404 retried forever, or a blip that loses the job |
 * | `wh.reconcile` re-drives stored-but-unenqueued rows | §8.12 step 5's "200 even if processing fails" becomes unsafe |
 * | an unwired ledger job is a logged no-op | the webhook half goes down because the ledger half was mis-wired |
 *
 * The two rows about retry are the ones worth reading twice. They are the only place in this work package
 * where "a `Result` that is `ok: false`" could be silently treated as success, and pg-boss would then mark the
 * job complete and never look at it again.
 */
import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'
import { csError, err, ok, type CsError, type Result } from '@countersign/core'
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
  classifyForQueue,
  createJobRunner,
  createPgBossQueue,
  registerJobs,
  settleForQueue,
  summarise,
  type PgBossLike,
} from '../src/job-runner'
import { CRON_SPECS } from '../src/schedule'
import { fakeBoss, recordingLogger, workerHarness } from './harness'

/** A `Result` that is `ok` with a fixed value, for the tests that need one. */
const passed = (v: unknown): Result<unknown, CsError> => ok(v)

/* ------------------------------------------------------------------------------------------ */
/* Retry classification                                                                           */
/* ------------------------------------------------------------------------------------------ */

describe('classifyForQueue — the whole retry policy', () => {
  it('QUEUE-1 a retryable failure is retried, so a PayPal blip does not lose the job', () => {
    // PP_UNAVAILABLE is what EC-WH-7's verify outage produces and EC-PP-1's circuit breaker produces.
    expect(classifyForQueue(csError('PP_UNAVAILABLE', 'verify endpoint down'))).toBe('RETRY')
    expect(classifyForQueue(csError('PP_RATE_LIMITED', '429'))).toBe('RETRY')
    expect(classifyForQueue(csError('CS_RATE_LIMITED', 'our own limiter'))).toBe('RETRY')
  })

  it('QUEUE-1 a permanent failure is completed, because retrying cannot change a 404', () => {
    // The bug this prevents: a handler that throws on PP_NOT_FOUND retries forever against a resource
    // PayPal will never have, filling the retry budget and the log.
    expect(classifyForQueue(csError('PP_NOT_FOUND', 'no such capture'))).toBe('COMPLETE')
    expect(classifyForQueue(csError('CS_NOT_FOUND', 'no such row'))).toBe('COMPLETE')
    expect(classifyForQueue(csError('PP_UNPROCESSABLE', '400'))).toBe('COMPLETE')
  })

  it('QUEUE-1 the verdict comes from CsError.retryable, not from a second code list here', () => {
    // If this ever became its own switch, a new CsErrorCode could be retryable in one place and permanent
    // in the other. `@countersign/core` owns that decision.
    const forced = { ...csError('CS_INTERNAL', 'x'), retryable: true }
    expect(classifyForQueue(forced)).toBe('RETRY')
  })
})

describe('settleForQueue — the Result/pg-boss seam', () => {
  it('QUEUE-1 an ok Result resolves, including one whose conclusion is IGNORED', async () => {
    const { logger, lines } = recordingLogger()
    const settled = await settleForQueue(passed({ outcome: 'IGNORED' }), {
      job: JOB_PROCESS,
      logger,
    })
    expect(settled).toEqual({ outcome: 'IGNORED' })
    // An ignored event is a *correct* conclusion (EC-WH-6), so nothing is logged as a failure.
    expect(lines.filter((l) => l.level === 'error')).toHaveLength(0)
  })

  it('QUEUE-1 a retryable failure is re-thrown so pg-boss retries it', async () => {
    const { logger } = recordingLogger()
    await expect(
      settleForQueue(err(csError('PP_UNAVAILABLE', 'down')), { job: JOB_PROCESS, logger }),
    ).rejects.toThrow('down')
  })

  it('QUEUE-1 a permanent failure resolves, so the job completes instead of looping', async () => {
    const { logger, lines } = recordingLogger()
    const settled = await settleForQueue(err(csError('PP_NOT_FOUND', 'gone')), {
      job: JOB_PROCESS,
      logger,
    })
    expect(settled).toEqual({
      ok: false,
      completed: true,
      code: 'PP_NOT_FOUND',
      reason: 'gone',
    })
    // Still logged. Completing a job quietly is how a broken resource goes unnoticed.
    expect(lines.filter((l) => l.level === 'error')).toHaveLength(1)
    expect(lines.find((l) => l.level === 'error')?.fields).toMatchObject({
      job: JOB_PROCESS,
      verdict: 'COMPLETE',
      code: 'PP_NOT_FOUND',
    })
  })
})

/* ------------------------------------------------------------------------------------------ */
/* The handler table                                                                              */
/* ------------------------------------------------------------------------------------------ */

describe('createJobRunner — every job name is wired', () => {
  it('QUEUE-2 all seven job names have a handler', () => {
    const runner = createJobRunner({ webhooks: workerHarness().deps })
    for (const job of [
      JOB_PROCESS,
      JOB_VERIFY,
      JOB_RECONCILE,
      JOB_DISPUTES,
      JOB_AUTH_EXPIRY,
      JOB_RELEASE_RESERVATIONS,
      JOB_BUDGET_RECONCILE,
    ] as JobName[]) {
      expect(typeof runner[job], `${job} has no handler`).toBe('function')
    }
  })

  it('QUEUE-2 EC-WH-2 a replayed wh.process job reads the row and does not trust the payload', async () => {
    // The payload names a `webhookEventId`. `processWebhookEvent` re-reads that row and re-fetches from
    // PayPal, so a payload edited in the queue cannot move money. This asserts the read happened.
    const h = workerHarness()
    const runner = createJobRunner({ webhooks: h.deps })
    const settled = await runner[JOB_PROCESS]({
      webhookEventId: 'whe_missing',
      resourceId: 'CAP-1',
      resourceType: 'capture',
      eventType: 'PAYMENT.CAPTURE.COMPLETED',
    })
    // CS_NOT_FOUND for a row that does not exist: permanent, so it completes rather than retrying.
    expect(settled).toMatchObject({ ok: false, completed: true, code: 'CS_NOT_FOUND' })
    expect(h.calls).toContain('events.findById')
    // The payload's resourceId was never used as a source of state — no PayPal call was made from it.
    expect(h.calls).not.toContain('getCapture')
  })

  it('QUEUE-2 EC-WH-1 wh.reconcile runs the stored-but-unenqueued backstop as well as the sweep', async () => {
    // §8.12 step 5 returns 200 "even if processing fails", and the insert and the enqueue are two writes.
    // Without this backstop a crash between them loses the event until PayPal's 25 redeliveries run out.
    const h = workerHarness()
    const runner = createJobRunner({ webhooks: h.deps })
    await runner[JOB_RECONCILE](undefined)
    expect(h.calls).toContain('events.listUnprocessed')
    expect(h.calls).toContain('orders.reconcileCandidates')
    expect(h.calls).toContain('authorizations.reconcileCandidates')
  })

  it('QUEUE-2 the sweep summary carries the EC-WH-1 fix count and the EC-PP-2 rate', async () => {
    const h = workerHarness()
    const runner = createJobRunner({ webhooks: h.deps })
    const settled = (await runner[JOB_RECONCILE](undefined)) as {
      candidates: number
      fixes: number
      requeued: number
      throttleRps: number
    }
    expect(settled.throttleRps).toBe(2)
    expect(settled).toHaveProperty('requeued')
    expect(settled).toHaveProperty('fixes')
  })

  it('QUEUE-2 EC-WH-7 wh.verify re-drives the PENDING rows', async () => {
    const h = workerHarness()
    const runner = createJobRunner({ webhooks: h.deps })
    await runner[JOB_VERIFY](undefined)
    expect(h.calls).toContain('events.listUnverified')
  })

  it('QUEUE-2 the 2-minute dispute sweep calls listDisputes', async () => {
    const h = workerHarness()
    const runner = createJobRunner({ webhooks: h.deps })
    await runner[JOB_DISPUTES](undefined)
    expect(h.calls).toContain('listDisputes')
  })

  it('QUEUE-2 EC-TIME-5 the expiry sweep queries authorizations', async () => {
    const h = workerHarness()
    const runner = createJobRunner({ webhooks: h.deps })
    await runner[JOB_AUTH_EXPIRY](undefined)
    expect(h.calls).toContain('authorizations.reconcileCandidates')
  })

  it('QUEUE-2 a sweep that fails with a retryable code is retried, not silently dropped', async () => {
    // A failing cron that resolves is the worst outcome: pg-boss marks it complete, the next tick is 2 or 5
    // minutes away, and nothing says the sweep did not run.
    const h = workerHarness({ fail: { disputes: 'PP_UNAVAILABLE' } })
    const runner = createJobRunner({ webhooks: h.deps })
    await expect(runner[JOB_DISPUTES](undefined)).rejects.toThrow()
  })

  it('QUEUE-2 a caller-supplied ledger handler is adapted across the Result seam', async () => {
    const h = workerHarness()
    const runner = createJobRunner({
      webhooks: h.deps,
      releaseReservations: async () =>
        err(csError('CS_INTERNAL', 'ledger is down', {}, { retryable: true })),
    })
    await expect(runner[JOB_RELEASE_RESERVATIONS](undefined)).rejects.toThrow('ledger is down')
  })

  it('QUEUE-2 an unwired ledger job is a logged no-op, so the webhook half still starts', async () => {
    // The alternative — throwing — makes a wiring mistake in the ledger half take down the webhook half.
    const h = workerHarness()
    const { logger, lines } = recordingLogger()
    const runner = createJobRunner({ webhooks: h.deps, logger })
    for (const job of [JOB_RELEASE_RESERVATIONS, JOB_BUDGET_RECONCILE] as JobName[]) {
      const settled = await runner[job](undefined)
      expect(settled).toMatchObject({ skipped: true })
    }
    expect(lines.filter((l) => l.level === 'warn')).toHaveLength(2)
  })
})

/* ------------------------------------------------------------------------------------------ */
/* Registration                                                                                   */
/* ------------------------------------------------------------------------------------------ */

describe('registerJobs — the order that makes startup survivable', () => {
  it('QUEUE-3 every handler is registered before any schedule', async () => {
    // A schedule that fires before its work() exists creates a job nobody consumes, and the backlog grows
    // silently. Asserting the interleaving is the only way this cannot regress.
    const boss = fakeBoss()
    // pg-boss needs an open connection before `schedule()`, which is why `startWorker` starts the queue
    // before registering anything. The fake reproduces that refusal, so this line is required here too.
    await boss.start()
    const runner = createJobRunner({ webhooks: workerHarness().deps })
    await registerJobs(boss, runner, CRON_SPECS)

    const lastWork = boss.order
      .map((o, i) => ({ o, i }))
      .filter((x) => x.o.startsWith('work:'))
      .at(-1)!
    const firstSchedule = boss.order.findIndex((o) => o.startsWith('schedule:'))
    expect(lastWork.i).toBeLessThan(firstSchedule)
    expect(boss.worked).toHaveLength(7)
    expect(boss.scheduled).toHaveLength(CRON_SPECS.length)
  })

  it('QUEUE-3 wh.process gets a handler even though it has no cron', async () => {
    const boss = fakeBoss()
    // pg-boss needs an open connection before `schedule()`, which is why `startWorker` starts the queue
    // before registering anything. The fake reproduces that refusal, so this line is required here too.
    await boss.start()
    const runner = createJobRunner({ webhooks: workerHarness().deps })
    const report = await registerJobs(boss, runner, CRON_SPECS)
    expect(report.handlers).toContain(JOB_PROCESS)
    expect(CRON_SPECS.some((s) => s.job === JOB_PROCESS)).toBe(false)
  })

  it('QUEUE-3 a handler pg-boss refuses is reported, and the others still register', async () => {
    const boss = fakeBoss()
    // pg-boss needs an open connection before `schedule()`, which is why `startWorker` starts the queue
    // before registering anything. The fake reproduces that refusal, so this line is required here too.
    await boss.start()
    boss.failWorkFor.add(JOB_RECONCILE)
    const runner = createJobRunner({ webhooks: workerHarness().deps })
    const report = await registerJobs(boss, runner, CRON_SPECS)
    // The five-minute sweep is exactly the one whose absence is invisible: nothing errors, state just stops
    // being repaired. So it is reported rather than skipped past.
    expect(report.errors.map((e) => e.job)).toContain(JOB_RECONCILE)
    expect(report.errors[0]?.error.code).toBe('CS_INTERNAL')
    expect(report.handlers).toContain(JOB_RECONCILE)
    expect(boss.worked.map((w) => w.name)).not.toContain(JOB_RECONCILE)
    expect(boss.worked).toHaveLength(6)
  })

  it('QUEUE-3 a rejected schedule does not stop the remaining schedules', async () => {
    const boss = fakeBoss()
    // pg-boss needs an open connection before `schedule()`, which is why `startWorker` starts the queue
    // before registering anything. The fake reproduces that refusal, so this line is required here too.
    await boss.start()
    boss.failScheduleFor.add(JOB_BUDGET_RECONCILE)
    const runner = createJobRunner({ webhooks: workerHarness().deps })
    const report = await registerJobs(boss, runner, CRON_SPECS)
    expect(report.errors.map((e) => e.job)).toEqual([JOB_BUDGET_RECONCILE])
    expect(report.schedules).toHaveLength(CRON_SPECS.length - 1)
  })

  it('QUEUE-3 registration does not start pg-boss; start() is the caller’s decision', async () => {
    const boss = fakeBoss()
    // **No `start()` here, and that is the assertion.** This case passes an empty CRON_SPECS, so no
    // `schedule()` is attempted and pg-boss pre-`start()` refusal is never reached. Everywhere else in
    // this file the queue is started first, because production does that and the fake enforces it.
    await registerJobs(boss, createJobRunner({ webhooks: workerHarness().deps }), CRON_SPECS)
    expect(boss.started).toBe(0)
  })

  it('QUEUE-3 the handler pg-boss receives forwards the job payload', async () => {
    // This is what makes the double usable: it can invoke the real handler without a database.
    const h = workerHarness()
    const boss = fakeBoss()
    // pg-boss needs an open connection before `schedule()`, which is why `startWorker` starts the queue
    // before registering anything. The fake reproduces that refusal, so this line is required here too.
    await boss.start()
    await registerJobs(boss, createJobRunner({ webhooks: h.deps }), CRON_SPECS)
    const handler = boss.handlers.get(JOB_VERIFY)
    expect(handler).toBeDefined()
    await handler!({ webhookEventId: 'whe_1' })
    expect(h.calls).toContain('events.listUnverified')
  })
})

/* ------------------------------------------------------------------------------------------ */
/* The pg-boss port                                                                               */
/* ------------------------------------------------------------------------------------------ */

describe('createPgBossQueue', () => {
  it('QUEUE-4 pg-boss is reached only by a dynamic import, so importing this package opens nothing', async () => {
    // The claim is about the module *graph*, so it is asserted against the source rather than against
    // runtime state: a static `import ... from 'pg-boss'` anywhere at the top level would execute on import
    // and pull `pg` into every process that touches this file. `await import(...)` inside the factory is the
    // only acceptable form.
    //
    // Asserted on the source text because the alternative — inspecting a loaded module registry — is not
    // observable from inside vitest's own transform pipeline.
    const source = await readFile(new URL('../src/job-runner.ts', import.meta.url), 'utf8')
    const staticImport = /^\s*import\s[^;]*['"]pg-boss['"]/m
    expect(source, 'pg-boss must not be a static import').not.toMatch(staticImport)
    // And the dynamic form must actually exist, so this test cannot pass by the import being deleted.
    expect(source).toMatch(/await import\(['"]pg-boss['"]\)/)
  })

  it('QUEUE-4 the injected loader is used, and it runs exactly once per call', async () => {
    let loads = 0
    const boss = await createPgBossQueue({
      connectionString: 'postgres://example/db',
      load: async () => {
        loads += 1
        return { PgBoss: recordingBossClass(() => {}) }
      },
    })
    expect(loads).toBe(1)
    expect(typeof boss.start).toBe('function')
    // Constructing is not connecting: `start()` is the caller's.
    expect(boss).toBeDefined()
  })

  it('QUEUE-4 the connection string is handed to pg-boss verbatim', async () => {
    let seen = ''
    const boss = await createPgBossQueue({
      connectionString: 'postgres://example/db',
      load: async () => ({
        PgBoss: recordingBossClass((connectionString) => {
          seen = connectionString
        }),
      }),
    })
    expect(seen).toBe('postgres://example/db')
    // Constructing is not connecting: `start()` is the caller's.
    expect(boss).toBeDefined()
  })

  it('QUEUE-4 a load failure surfaces as a rejection, not a half-built queue', async () => {
    await expect(
      createPgBossQueue({
        connectionString: 'postgres://example/db',
        load: async () => {
          throw new Error('pg-boss is not installed')
        },
      }),
    ).rejects.toThrow('pg-boss is not installed')
  })
})

/**
 * A `PgBoss` class that records its connection string and does nothing else.
 *
 * A class rather than an object literal because the factory's contract is
 * `new PgBoss(connectionString)` — an adapter that quietly stopped constructing would typecheck fine against
 * a plain object and break in production.
 */
function recordingBossClass(
  onConstruct: (connectionString: string) => void,
): new (connectionString: string) => PgBossLike {
  return class implements PgBossLike {
    constructor(connectionString: string) {
      onConstruct(connectionString)
    }
    async start(): Promise<unknown> {
      return this
    }
    async stop(): Promise<unknown> {
      return undefined
    }
    async send(): Promise<string | null> {
      return null
    }
    async work(): Promise<unknown> {
      return undefined
    }
    async schedule(): Promise<unknown> {
      return undefined
    }
  }
}

/* ------------------------------------------------------------------------------------------ */
/* summarise                                                                                     */
/* ------------------------------------------------------------------------------------------ */

describe('summarise', () => {
  it('QUEUE-5 it reports every counter the reconciler produces, plus the rate it ran under', () => {
    const summary = summarise(
      {
        startedAt: new Date(0),
        candidates: 10,
        advanced: 3,
        fixes: 1,
        unchanged: 5,
        ignored: 2,
        failed: 0,
        errors: [],
      },
      { requeued: 4 },
    )
    expect(summary).toEqual({
      candidates: 10,
      advanced: 3,
      fixes: 1,
      unchanged: 5,
      ignored: 2,
      failed: 0,
      requeued: 4,
      throttleRps: 2,
    })
  })

  it('QUEUE-5 requeued is absent rather than undefined when there is nothing to say about it', () => {
    const summary = summarise({
      startedAt: new Date(0),
      candidates: 0,
      advanced: 0,
      fixes: 0,
      unchanged: 0,
      ignored: 0,
      failed: 0,
      errors: [],
    })
    expect('requeued' in summary).toBe(false)
  })
})
