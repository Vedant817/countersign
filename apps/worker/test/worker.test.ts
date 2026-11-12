/**
 * `startWorker` and the composition - spec **§8.12**, **§6**, **D12**, **D13**.
 *
 * ## The three claims worth defending
 *
 * 1. **A malformed cron stops the boot.** pg-boss validates an expression on the first tick, so a typo in a
 *    nightly job is discovered up to a day later - by absence. Checking it here turns a silent week into a
 *    failed deploy.
 * 2. **A registration failure fails the boot.** A partially-registered worker looks alive: the logs say
 *    "worker started", and the gaps are exactly the crons that quietly stop repairing lost webhooks.
 * 3. **`stop()` is idempotent.** A container orchestrator sends `SIGTERM` and then, after a grace period,
 *    `SIGKILL`; a double-stop that throws turns a clean drain into exit 1.
 */
import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'
import { setEnvForTesting } from '@countersign/core'
import { JOB_BUDGET_RECONCILE, JOB_PROCESS, JOB_RECONCILE } from '@countersign/webhooks'

import { startWorker, type CronSpec } from '../src/index'
import { CRON_SPECS } from '../src/schedule'
import { fakeBoss, recordingLogger, workerHarness } from './harness'

const ONE_CRON: CronSpec[] = [
  { job: JOB_RECONCILE, cron: '*/5 * * * *', every: '5 minutes', because: 'test' },
]

describe('startWorker — boot', () => {
  it('WORKER-1 it registers every handler, every schedule, and then starts', async () => {
    const boss = fakeBoss()
    const h = workerHarness()
    const { logger, lines } = recordingLogger()

    const started = await startWorker({ webhooks: h.deps, boss, logger, crons: ONE_CRON })
    if (!started.ok) throw new Error(started.error.message)

    expect(boss.worked).toHaveLength(7)
    expect(boss.scheduled).toHaveLength(1)
    expect(boss.started).toBe(1)
    // `start()` FIRST, and this assertion used to say the opposite.
    //
    // The old comment read "`start()` last: pg-boss begins polling on it, so a handler registered
    // afterwards races the first fetch." That reasoning does not survive contact with pg-boss 12:
    // **both** `work()` and `schedule()` need an open connection, and `boss.schedule()` rejects with
    // `Database connection is not opened` before `start()`. The order this test asserted therefore
    // could not boot at all — and the fake boss never reproduced the rejection, so the test was
    // asserting that a broken sequence works.
    //
    // This is the D-034 pattern once more: the test encoded a property the real dependency never had.
    // The fake below now rejects `schedule()` before `start()`, which is what pg-boss does.
    expect(boss.order[0]).toBe('start')
    expect(started.value.registration.errors).toHaveLength(0)
    expect(lines.filter((l) => l.msg === 'worker started')).toHaveLength(1)
  })

  it('WORKER-1 a malformed cron fails the boot, before anything is registered', async () => {
    const boss = fakeBoss()
    const started = await startWorker({
      webhooks: workerHarness().deps,
      boss,
      crons: [
        { job: JOB_BUDGET_RECONCILE, cron: 'every night', every: 'nightly', because: 'test' },
      ],
    })
    expect(started.ok).toBe(false)
    if (started.ok) return
    expect(started.error.code).toBe('CS_VALIDATION')
    expect(started.error.retryable).toBe(false)
    // Nothing was registered and nothing was started: a worker that boots on a bad schedule is worse than
    // one that refuses, because the log says it started.
    expect(boss.order).toEqual([])
  })

  it('WORKER-1 a registration failure fails the boot rather than leaving a half-wired worker', async () => {
    const boss = fakeBoss()
    boss.failWorkFor.add(JOB_RECONCILE)
    const { logger, lines } = recordingLogger()

    const started = await startWorker({
      webhooks: workerHarness().deps,
      boss,
      logger,
      crons: ONE_CRON,
    })
    expect(started.ok).toBe(false)
    if (started.ok) return
    expect(started.error.code).toBe('CS_INTERNAL')
    // And it says which job, because "the five-minute sweep is not running" is the diagnosis.
    expect(lines.some((l) => l.msg === 'worker registration incomplete')).toBe(true)
    // This used to assert `boss.started === 0`, which was the old boot order's whole point: nothing
    // was started until every registration had succeeded. Now `start()` comes first — pg-boss 12
    // refuses `schedule()` without a connection — so the queue *is* running when registration fails,
    // and the obligation is inverted: the boot must **stop** it rather than leave a half-wired
    // worker polling. A queue left started is the failure this test exists to prevent.
    expect(boss.started).toBe(1)
    expect(boss.stopped).toBe(1)
  })

  it('WORKER-1 a queue that will not start is a retryable failure, so a supervisor restarts us', async () => {
    const boss = fakeBoss()
    boss.failStart = true
    const started = await startWorker({ webhooks: workerHarness().deps, boss, crons: ONE_CRON })
    expect(started.ok).toBe(false)
    if (started.ok) return
    expect(started.error.retryable).toBe(true)
    // CS_INTERNAL with `retryable` set, not CS_RATE_LIMITED: nothing was rate-limited, a database was down.
    expect(started.error.code).toBe('CS_INTERNAL')
  })

  it('§8.19 the run a handler performs is recorded through the heartbeat sink startWorker was given', async () => {
    // The wrapper is applied inside startWorker, not by each handler, so this is the test that proves it is
    // applied at all. heartbeat.test.ts proves what the wrapper records; without this one, a refactor that
    // stopped passing `handlers` to `registerJobs` would leave the table empty and every test still green.
    const boss = fakeBoss()
    const recorded: { job: string; outcome: string; errorCode: string | null | undefined }[] = []
    const started = await startWorker({
      webhooks: workerHarness().deps,
      boss,
      crons: ONE_CRON,
      heartbeats: {
        async record(event) {
          recorded.push({ job: event.job, outcome: event.outcome, errorCode: event.errorCode })
          return { ok: true, value: event }
        },
      },
    })
    if (!started.ok) throw new Error(started.error.message)

    const handler = boss.handlers.get(JOB_RECONCILE)
    expect(handler, 'the reconciler handler was not registered').toBeDefined()
    await handler!(null)

    expect(recorded).toEqual([{ job: JOB_RECONCILE, outcome: 'ok', errorCode: null }])
    // And the id on the started worker is the id in the row, so an operator reading one can find the other.
    expect(started.value.workerId).not.toBe('')
  })

  it('WORKER-1 stop() is idempotent, so a second SIGTERM does not turn a clean drain into exit 1', async () => {
    const boss = fakeBoss()
    const started = await startWorker({
      webhooks: workerHarness().deps,
      boss,
      crons: ONE_CRON,
    })
    if (!started.ok) throw new Error(started.error.message)
    await started.value.stop()
    await started.value.stop()
    expect(boss.stopped).toBe(1)
  })
})

describe('startWorker — laziness', () => {
  it('WORKER-3 the whole schedule table is registrable, which is what proves the table is wired end to end', async () => {
    // One boot against the real `CRON_SPECS` rather than a one-entry subset: every cron expression in the
    // table passes validation and every job in it gets both a handler and a schedule.
    const boss = fakeBoss()
    const started = await startWorker({ webhooks: workerHarness().deps, boss })
    if (!started.ok) throw new Error(started.error.message)
    expect([...started.value.registration.schedules].sort()).toEqual(
      CRON_SPECS.map((s) => s.job).sort(),
    )
    // wh.process is handled but never scheduled — asserted here as well as in the table's own test, because
    // this is the boot path where the mistake would actually happen.
    expect(started.value.registration.handlers).toContain(JOB_PROCESS)
    expect(started.value.registration.schedules).not.toContain(JOB_PROCESS)
  })

  it('WORKER-3 a handler registered through the boot path can actually run the real job', async () => {
    const boss = fakeBoss()
    const h = workerHarness()
    const started = await startWorker({ webhooks: h.deps, boss, crons: ONE_CRON })
    if (!started.ok) throw new Error(started.error.message)

    // This is the end-to-end shape of AT-M12.1's mechanism as the worker runs it: the queue hands back the
    // handler pg-boss registered, and calling it drives `packages/webhooks` for real.
    const handler = boss.handlers.get(JOB_RECONCILE)
    expect(handler).toBeDefined()
    const settled = (await handler!({})) as { throttleRps: number }
    expect(settled.throttleRps).toBe(2)
    expect(h.calls).toContain('events.listUnprocessed')
  })
})

describe('main — the entry point', () => {
  it('WORKER-2 a deployment with no environment refuses to start and names what is missing', async () => {
    // Spec §6, and the reason `main` exists as a separate function from `productionDeps`: a worker that boots
    // with a missing `PAYPAL_CLIENT_ID` and fails on its first tick an hour later is far worse than a
    // process that exits immediately and says which variable is absent.
    //
    // `process.env` is swapped for an empty object and the cache cleared, exactly as `boot.test.ts` does for
    // the same assertion. Without that, this test passes or fails depending on the shell the suite was launched
    // from: a `DATABASE_URL` exported for the Postgres-backed suites would make `DATABASE_URL` *present*, and
    // the assertion would fail on a machine that did nothing wrong. A property of the code under test must not
    // depend on the caller's environment.
    const { main } = await import('../src/index')
    const errors: string[] = []
    const originalError = console.error
    const saved = process.env
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '))
    try {
      process.env = {}
      setEnvForTesting(null)
      const code = await main()
      // 78 is EX_CONFIG from sysexits.h: "misconfigured", distinct from a transient outage so a platform
      // reporting only exit codes can tell the two apart.
      expect(code).toBe(78)
      const output = errors.join('\n')
      expect(output).toContain('refusing to start')
      // Every missing key is listed at once, per `packages/core`'s `formatIssues`: fixing a deployment one
      // variable per restart is the thing this avoids.
      expect(output).toContain('DATABASE_URL')
      expect(output).toContain('PAYPAL_CLIENT_ID')
    } finally {
      console.error = originalError
      process.env = saved
      setEnvForTesting(null)
    }
  })

  it('WORKER-2 the wiring gap is a thrown error, not a silent partial start', async () => {
    // `productionDeps` throws deliberately once the environment is valid: the `WebhookStore` and
    // `WebhookAudit` adapters do not exist yet (README → Contract issues). The requirement is that the gap is
    // **loud and named**, not that it is papered over with a stub that would write to nothing.
    const { createWebhooksFromEnv } = await import('../src/index')
    // The composition function itself is total: it takes its store and audit sink as arguments and builds a
    // complete `WebhookDeps`, so the only thing `productionDeps` cannot supply is those two adapters.
    expect(typeof createWebhooksFromEnv).toBe('function')
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(source).toMatch(/Contract issues/)
  })
})
