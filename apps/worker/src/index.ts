/**
 * `@countersign/worker` - the process that runs `packages/webhooks`' jobs. Spec **§8.12**, **§8.10**, **§7.2**,
 * §15 **WP-12**.
 *
 * ## What this process is
 *
 * Three moving parts, and this file is only responsible for starting and stopping them:
 *
 * | Part | Where | What it is |
 * |---|---|---|
 * | The queue | `job-runner.ts` | `pg-boss`, behind a factory so **importing this file connects to nothing** |
 * | The crons | `schedule.ts` | Pure data: which job, how often, and which edge case asked for it |
 * | The handlers | `job-runner.ts` | `JobName` → the `packages/webhooks` function that does the work |
 *
 * ## The lazy-construction rule, and why it is a rule
 *
 * **Nothing in this file's module graph connects to Postgres or PayPal at import time.** `createPgBossQueue`
 * does its `await import('pg-boss')` inside itself, and every dependency here is either passed in or built
 * inside an async factory.
 *
 * That is not a style preference. `handleWebhook` needs a `WebhookQueue` too, and WP-17's Next route handler
 * lives in `apps/web`. If `@countersign/worker` connected on import, then importing the webhook route would
 * open a database pool in a process that only ever needs to acknowledge an HTTP request - and in a serverless
 * or test environment that pool is never closed. So:
 *
 * - `import '@countersign/worker'` is free. A test asserts it (`WORKER-3` in `test/worker.test.ts`).
 * - `startWorker()` is the only thing that connects, and it is the only thing that needs an argument.
 *
 * ## `main()` is guarded
 *
 * {@link main} runs only when this module is the process entry point, and it is written so that running it
 * with a missing `DATABASE_URL` fails **loudly and immediately** (spec §6) rather than starting a worker that
 * will 500 on its first tick an hour later.
 */
import { pathToFileURL } from 'node:url'

import {
  env,
  epochSecFrom,
  err,
  formatIst,
  logger as rootLogger,
  ok,
  systemClock,
  toCsError,
  type AttemptId,
  type Clock,
  type CsError,
  type Logger,
  type MandateId,
  type Result,
} from '@countersign/core'
import {
  drizzleStore,
  findDisputesNeedingAssessment,
  findJobHeartbeats,
  findStaleAttempts,
  listEntries,
  reconcileIn,
  type CheckoutAttemptRow,
} from '@countersign/db'
import { defineDefenderDeps, fileDispute, ingestDisputeToDefender } from '@countersign/defender'
import type { IngestAndDefendDeps } from '@countersign/orchestrator'
import {
  expireStaleReservations,
  RELEASE_REASONS,
  RESERVATION_TTL_SECONDS,
  reservationEntryId,
  type OpenReservation,
} from '@countersign/ledger'
import { PayPalClient } from '@countersign/paypal'
import {
  defaultThrottle,
  defineWebhookDeps,
  WEBHOOK_AUDIT_CHAIN,
  type CaptureOutcomeHooks,
  type JobHandler,
  type WebhookDeps,
  type WebhookQueue,
} from '@countersign/webhooks'

import { budgetAccountIds, dbWebhookAudit, dbWebhookStore, isReconcileCandidate } from './adapters'
import { defendDisputesJob, productionDefendDeps } from './defend'
import { dbDefenderStore, refundsRefusedLoudly } from './defender-store'
import {
  createJobRunner,
  createPgBossQueue,
  registerJobs,
  type PgBossLike,
  type RegistrationReport,
} from './job-runner'
import { buildJobHealths, startHealthServer, type HealthServer } from './health'
import {
  dbHeartbeatSink,
  withHeartbeats,
  workerId as workerIdFromEnv,
  type HeartbeatSink,
} from './heartbeat'
import { CRON_SPECS, isPlausibleCron, jobCadences, type CronSpec } from './schedule'

export { dbWebhookAudit, dbWebhookStore, isReconcileCandidate }

/** This process's logger. `module: 'worker'`, so a Render log line is attributable. */
function loggerChild(module: string): Logger {
  return rootLogger.child({ module })
}

export {
  classifyForQueue,
  createJobRunner,
  createPgBossQueue,
  registerJobs,
  settleForQueue,
  summarise,
  type JobSummary,
  type PgBossLike,
  type PgBossQueueOptions,
  type PgBossSendOptions,
  type PgBossWorkOptions,
  type QueueHandler,
  type RegisterPhase,
  type RunnerDeps,
} from './job-runner'

export {
  CRON_SPECS,
  EVENT_DRIVEN_JOBS,
  FIVE_MINUTES,
  HANDLED_JOBS,
  NIGHTLY_02_17_UTC,
  TWO_MINUTES,
  cronFor,
  isPlausibleCron,
  type CronSpec,
} from './schedule'

/* ------------------------------------------------------------------------------------------ */
/* The process                                                                                    */
/* ------------------------------------------------------------------------------------------ */

/** A started worker. `stop()` is idempotent, so a second `SIGTERM` is harmless. */
export interface Worker {
  readonly boss: PgBossLike
  /**
   * The identity written to `worker_job_runs.worker_id` — `WORKER_ID` or `hostname-pid`.
   *
   * On the started worker rather than kept internal because the health server's body names it: an operator
   * reading a heartbeat row and a `curl /health` has to be able to tell they are the same process.
   */
  readonly workerId: string
  /** Handlers and schedules that were registered, and the ones that failed. */
  readonly registration: Awaited<ReturnType<typeof registerJobs>>
  stop(): Promise<void>
}

/** What {@link startWorker} needs. Only `webhooks` is required; the rest have production defaults. */
export interface WorkerDeps {
  /** The whole `WebhookDeps`. Whoever composes the process decides the store, the clock and the queue. */
  readonly webhooks: WebhookDeps
  /**
   * §8.11's ledger movement, for a capture whose rank advances.
   *
   * Optional, and absent in production for now: `CaptureOutcomeHooks` is a port
   * (`job-runner.ts::RunnerDeps`) and `apps/web`'s capture path owns the decision about what a capture
   * outcome means. Forwarded here because {@link startWorker} builds the runner and would otherwise drop it.
   */
  readonly hooks?: CaptureOutcomeHooks
  /**
   * §8.10: release reservations whose 30 minutes ran out with no order.
   *
   * **This is the job that stops a buyer's signed budget being held for ever**, and it needs only
   * `DATABASE_URL`. It is wired in {@link productionDeps} and forwarded here.
   */
  readonly releaseReservations?: JobHandler
  /** §7.2: the nightly "balances must equal the sum of entries" check. */
  readonly reconcileBudget?: JobHandler
  /** §8.15/§10.2 rows 13–16: the defend step `wh.disputes` runs after its sweep. */
  readonly defend?: JobHandler
  readonly logger?: Logger
  /**
   * §8.19: where finished runs are recorded. Defaults to `worker_job_runs`.
   *
   * A port so `startWorker` can be tested without a database — and so the heartbeat wrapper can be asserted
   * to have recorded exactly what the handler did, including the case where it threw.
   */
  readonly heartbeats?: HeartbeatSink
  /** Overrides `WORKER_ID`. A test needs a stable, readable id. */
  readonly workerId?: string
  /** Overrides the schedule table. A test can run one cron; production uses {@link CRON_SPECS}. */
  readonly crons?: readonly CronSpec[]
  /** Overrides the pg-boss adapter, so a test never loads the module. */
  readonly boss?: PgBossLike
}

/**
 * Build the dependency graph and start consuming.
 *
 * Order, and it is the order that matters:
 *
 * 1. Validate the cron expressions. pg-boss reports a malformed expression on the **first tick**, which for a
 *    nightly job is up to a day away - so a typo is caught here instead of discovered by absence.
 * 2. Create the runner (pure; touches nothing global).
 * 3. `start()` the queue.
 * 4. Register every handler, then every schedule ({@link registerJobs} does both, in that order).
 *
 * ### Why `start()` comes first, and what it cost
 *
 * This used to register handlers and schedules *before* `start()`, on the reasoning that "pg-boss begins
 * polling on `start()`, so a handler registered afterwards races the first fetch." That reasoning does not
 * survive contact with pg-boss 12: **both** `work()` and `schedule()` need an open connection.
 *
 * - `boss.schedule()` inserts into `pgboss.schedule` and rejects with `Database connection is not opened`.
 * - `boss.work()` constructs a `Worker` and starts its fetch loop immediately, so `Worker.fetch` calls
 *   `assertDb` before the first poll — and it fails as an **unhandled `error` event** on the boss rather than
 *   rejecting the promise, so the surrounding `try`/`catch` cannot see it and the process dies with a stack
 *   trace instead of a `Result`.
 *
 * So registering before starting does not merely race; it cannot work, and it fails on *every* boot against a
 * real queue. That is why this process had never actually run: `productionDeps()` used to throw before it
 * got here, and once that was fixed the queue refused every registration and the worker exited 78.
 *
 * There is no fetch race in the ordering now used, because pg-boss fetches **per registered worker**: with no
 * `work()` registered, `start()` polls nothing. Registering after `start()` is how pg-boss is meant to be used.
 *
 * @returns `err` if `start()` fails or if any handler or schedule will not register. A partially-registered
 *   worker is worse than none: it looks alive, and the gaps are exactly the crons that quietly stop fixing
 *   lost webhooks.
 */
export async function startWorker(deps: WorkerDeps): Promise<Result<Worker, CsError>> {
  const logger = deps.logger ?? deps.webhooks.logger
  const crons = deps.crons ?? CRON_SPECS

  const malformed = crons.filter((c) => !isPlausibleCron(c.cron))
  if (malformed.length > 0) {
    return {
      ok: false,
      error: {
        code: 'CS_VALIDATION',
        message: `Malformed cron expression(s): ${malformed
          .map((c) => `${c.job}="${c.cron}"`)
          .join(', ')}`,
        userMessage: 'The server is misconfigured. Please tell the operator.',
        retryable: false,
        details: { malformed: malformed.map((c) => ({ job: c.job, cron: c.cron })) },
      },
    }
  }

  const instanceId = deps.workerId ?? workerIdFromEnv()

  const boss =
    deps.boss ?? (await createPgBossQueue({ connectionString: env().DATABASE_URL, logger }))
  // Every optional handler is forwarded explicitly. A `RunnerDeps` member the boot path silently dropped
  // would show up as a cron that logs "job has no handler wired" every five minutes, which is exactly the
  // quiet failure that let `release.reservations` go missing in the first place.
  const runner = createJobRunner({
    webhooks: deps.webhooks,
    logger,
    ...(deps.hooks ? { hooks: deps.hooks } : {}),
    ...(deps.releaseReservations ? { releaseReservations: deps.releaseReservations } : {}),
    ...(deps.reconcileBudget ? { reconcileBudget: deps.reconcileBudget } : {}),
    ...(deps.defend ? { defend: deps.defend } : {}),
  })

  /*
   * §8.19: every handler is wrapped so its run is recorded, before anything is registered.
   *
   * The wrapper is applied to the whole table rather than to one job because the failure it exists to catch is
   * "the reconciler stopped", and a heartbeat that only covers `wh.process` would go on reporting a healthy
   * worker while `wh.reconcile` was dead. It is also applied here rather than inside `createJobRunner` so the
   * handler table stays testable without a database — see `heartbeat.ts`.
   */
  const handlers = withHeartbeats(runner, deps.heartbeats ?? dbHeartbeatSink({ logger }), {
    workerId: instanceId,
    clock: deps.webhooks.clock,
    logger,
  })

  // The queue is opened first, because in pg-boss 12 both `work()` and `schedule()` need an open connection and
  // there is no fetch race in registering afterwards: pg-boss polls per registered worker, so `start()` with
  // nothing registered polls nothing.
  try {
    await boss.start()
  } catch (cause) {
    logger?.error('pg-boss failed to start', { cause: String(cause) })
    return {
      ok: false,
      error: {
        // `CS_INTERNAL` with `retryable` set explicitly. There is no `CS_UNAVAILABLE` in the §8.1 registry,
        // and `CS_RATE_LIMITED` would be a lie: nothing here was rate-limited, a database was unreachable.
        // §8.1's registry is append-only and only WP-01 may extend it, so the honest encoding is an
        // internal failure that a supervisor is told to retry.
        code: 'CS_INTERNAL',
        message: 'The job queue could not be reached.',
        userMessage: 'We are doing some maintenance. Please try again shortly.',
        retryable: true,
        cause,
      },
    }
  }

  const registration: RegistrationReport = await registerJobs(boss, handlers, crons)
  if (registration.errors.length > 0) {
    // Every refusal is reported by name. "The five-minute sweep is not running" is the whole diagnosis, and it
    // is invisible from the outside — state just stops being repaired.
    logger?.error('worker registration incomplete', {
      errors: registration.errors.map((e) => ({
        job: e.job,
        phase: e.phase,
        code: e.error.code,
        message: e.error.message,
      })),
      handlers: registration.handlers.length,
      schedules: registration.schedules.length,
    })
    // The queue is already open at this point, because it has to be for anything to register. A boot that then
    // fails must not leave it running: `main` returns a non-zero code and the process exits, but a caller that
    // does not exit — a test, or a supervisor that keeps the process alive to report — would otherwise leave a
    // started queue polling queues whose handlers were never registered.
    try {
      await boss.stop({ graceful: true })
      logger?.info('worker stopped', { because: 'registration failed' })
    } catch (cause) {
      logger?.error('could not close the queue after a failed registration', {
        cause: String(cause),
      })
    }
    return { ok: false, error: registration.errors[0]!.error }
  }

  logger?.info('worker started', {
    handlers: registration.handlers,
    schedules: registration.schedules,
  })

  let stopped = false
  return {
    ok: true,
    value: {
      boss,
      workerId: instanceId,
      registration,
      async stop(): Promise<void> {
        if (stopped) return
        stopped = true
        await boss.stop({ graceful: true })
        logger?.info('worker stopped')
      },
    },
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Composition                                                                                    */
/* ------------------------------------------------------------------------------------------ */

/**
 * The production {@link WebhookDeps}, minus the queue.
 *
 * Returned rather than used in place because the queue and the rest are built in a deliberate order: the
 * rest first, then the queue, then both handed to `defineWebhookDeps`. That way there is exactly **one**
 * place in this process that knows the full dependency list, and a hole in it is a `tsc` error rather than a
 * `undefined` three jobs later.
 *
 * `createWebhooksFromEnv` is exported so `apps/web`'s route handler can build the *same* deps for the ingest
 * path. Two processes sharing one definition of "what the webhook layer needs" is the point; two copies of it
 * is how the route handler and the worker drift apart.
 *
 * @param queue the `WebhookQueue`. Passed in rather than constructed here so this function has no side effect
 *   and stays testable with the in-memory double.
 */
export function createWebhooksFromEnv(
  queue: WebhookDeps['queue'],
  options: {
    readonly store: WebhookDeps['store']
    readonly audit: WebhookDeps['audit']
    readonly logger?: Logger
    readonly fetchImpl?: typeof fetch
    readonly clock?: WebhookDeps['clock']
    readonly throttle?: WebhookDeps['throttle']
    /**
     * A client the caller already built. The worker's dispute path shares it with the Defender
     * (`ingestAndDefend` re-fetches through `getDispute`), and one client means one token cache and
     * one throttle domain for every PayPal call this process makes.
     */
    readonly paypal?: PayPalClient
  },
): WebhookDeps {
  const clock = options.clock ?? systemClock
  const configured = env()
  const paypal =
    options.paypal ??
    new PayPalClient({
      baseUrl: configured.PAYPAL_API_BASE,
      clientId: configured.PAYPAL_CLIENT_ID,
      clientSecret: configured.PAYPAL_CLIENT_SECRET,
      clock,
      logger: options.logger,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    })
  return defineWebhookDeps({
    clock,
    paypal,
    store: options.store,
    queue,
    audit: options.audit,
    // EC-PP-2's 2 rps, in production. `packages/webhooks` owns the number; this only supplies the real sleep
    // and the real clock, so the tests can swap it for a counter and assert the limit without waiting.
    throttle: options.throttle ?? defaultThrottle(),
    webhookId: configured.PAYPAL_WEBHOOK_ID,
    ...(options.logger ? { logger: options.logger } : {}),
  })
}

/* ------------------------------------------------------------------------------------------ */
/* Entry point                                                                                    */
/* ------------------------------------------------------------------------------------------ */

/**
 * The process entry point.
 *
 * Called only from `package.json`'s `start`, and guarded so importing this module is inert. Exported so a
 * smoke test can call the wiring without a signal handler or a `process.exit`.
 *
 * The exit codes are deliberate and distinct: **78** is `EX_CONFIG` from `sysexits.h`, so a platform that
 * only reports exit codes distinguishes "this deployment is misconfigured" from "the queue is down" without
 * parsing our stderr.
 */
export async function main(): Promise<number> {
  let deps: WorkerDeps
  try {
    deps = await productionDeps()
  } catch (cause) {
    // Spec §6: refuse to start on a missing or invalid environment variable, and say which.
    //
    // `env()` throws a **`CsError`**, not an `Error`, so an `instanceof Error` check would print
    // `[object Object]` — which is precisely the failure mode this branch exists to prevent. Both shapes are
    // handled, and the code is printed when there is one, because "missing PAYPAL_CLIENT_ID" is the whole
    // diagnosis.
    const detail =
      typeof cause === 'object' && cause !== null && 'message' in cause && 'code' in cause
        ? `${(cause as { code: unknown }).code}: ${(cause as { message: unknown }).message}`
        : cause instanceof Error
          ? cause.message
          : String(cause)
    console.error('[worker] refusing to start:', detail)
    return 78
  }

  const started = await startWorker(deps)
  if (!started.ok) {
    console.error('[worker] failed to start:', started.error.code, started.error.message)
    return started.error.retryable ? 75 : 78
  }

  const worker = started.value

  /*
   * §8.19: an optional health listener, off unless `WORKER_HEALTH_PORT` is set.
   *
   * A Render `type: worker` has no port and therefore no health check, so this is not how the platform learns
   * the worker is alive — `worker_job_runs` read by `/status` is. It exists for the operator and the external
   * monitor: one `curl` that answers "which jobs ran, and when did each last succeed" without a psql session.
   *
   * It is opt-in because a listener nobody asked for is a liability, and because the bind is a side effect a
   * test would have to clean up. A bad value is exit 78 (`EX_CONFIG`): a deployment that asked for a health
   * endpoint and cannot have one should say so at boot rather than run without it.
   */
  let health: HealthServer | undefined
  const healthPort = process.env['WORKER_HEALTH_PORT']
  if (healthPort !== undefined && healthPort.trim() !== '') {
    const port = Number(healthPort)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      console.error(`[worker] WORKER_HEALTH_PORT is not a port number: ${healthPort}`)
      return 78
    }
    const expected = jobCadences(deps.crons ?? CRON_SPECS)
    try {
      health = await startHealthServer({
        port,
        workerId: worker.workerId,
        report: async () => {
          const rows = await findJobHeartbeats()
          // A `Result` thrown here becomes the 503 body's code, which is the honest answer: the endpoint
          // cannot say whether the worker is healthy if it cannot read the heartbeat table.
          if (!rows.ok) throw rows.error
          return buildJobHealths({
            heartbeats: rows.value,
            expected,
            nowSec: Math.floor(Date.now() / 1000),
          })
        },
        logger: loggerChild('worker-health'),
      })
      console.info(`[worker] health endpoint on ${health.url}`)
    } catch (cause) {
      console.error('[worker] could not start the health endpoint:', cause)
      return 78
    }
  }

  const shutdown = (signal: string): void => {
    console.info(`[worker] ${signal} received, draining`)
    void (async () => {
      try {
        await worker.stop()
        await health?.close()
        process.exit(0)
      } catch (cause) {
        console.error('[worker] shutdown failed:', cause)
        process.exit(1)
      }
    })()
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
  return 0
}

/**
 * The production dependency graph.
 *
 * Split out of {@link main} so the throwing is contained: `env()` throws on a missing variable (spec §6), and
 * `main` turns that into exit 78 rather than letting an unhandled rejection become a stack trace.
 *
 * ### What changed, and why it used to throw
 *
 * This used to end in `throw new Error('production wiring is incomplete: WebhookStore and WebhookAudit
 * adapters are not implemented.')`. That was a refusal to boot with exit 78 for a process whose entire job
 * is durable side effects, and the two adapters it named now exist in `adapters.ts`. A worker that boots and
 * does three of four jobs is strictly more useful than one that refuses to boot — and on Render this is the
 * difference between a running service and a crash-looping one.
 *
 * ### What still refuses, and what it refuses *not* to do
 *
 * {@link productionDeps} reads `env()` first and lets that throw, because spec §6 requires it and because a
 * misconfigured deployment must not look alive. Beyond that, **nothing refuses to boot.** Where a piece of
 * wiring cannot be built without a credential, the *specific job* that needs it is not registered, and the
 * reason names the missing variable — see {@link releaseReservationsJob}.
 *
 * The four things the crons need:
 *
 * | Job | Needs | Without it |
 * |---|---|---|
 * | `wh.process`, `wh.verify`, `wh.reconcile`, `wh.auth-expiry`, `wh.disputes` | PayPal credentials + `DATABASE_URL` | refuse to boot — these are the bulk of the process |
 * | `release.reservations` | `DATABASE_URL` only (§8.10's rule is a `budget_entries` release) | runs, via the composed job below |
 * | `budget.reconcile` | `DATABASE_URL` only | runs, via the composed job below |
 *
 * ### The two ledger jobs are composed here rather than imported
 *
 * `release.reservations` is §8.10's "reservations expire after 30 min without an order (a worker job releases
 * them)" — the job that stops a buyer's signed budget being held for ever. Its implementation is
 * `findStaleAttempts` (a query `packages/db` has) composed with `expireStaleReservations`
 * (`@countersign/ledger`'s arithmetic) and an already-released filter. `packages/orchestrator` implements
 * exactly that, with tests; **`apps/worker/package.json` does not declare that workspace dependency**, and
 * `package.json` is outside this work package's file list, so the composition is written here instead of
 * imported. It is ~30 lines of rename-and-forward and the duplication is deliberate and temporary — see the
 * README's "Contract issues" for the one-line change that removes it.
 */
export function productionDeps(): WorkerDeps {
  // Read the environment first, so a missing variable fails here rather than at the first job tick.
  const configured = env()
  const logger = loggerChild('worker')
  const clock = systemClock

  // One client for the whole process: the webhook half and the Defender share it, so one token cache
  // and one throttle domain cover every PayPal call. §8.15's `ingestAndDefend` re-fetches each
  // dispute through `getDispute` on this client — the only PayPal read the defend step makes.
  const paypal = new PayPalClient({
    baseUrl: configured.PAYPAL_API_BASE,
    clientId: configured.PAYPAL_CLIENT_ID,
    clientSecret: configured.PAYPAL_CLIENT_SECRET,
    clock,
    logger,
  })

  const webhooks = createWebhooksFromEnv(queueForWebhooks(), {
    store: dbWebhookStore({ logger }),
    audit: dbWebhookAudit(WEBHOOK_AUDIT_CHAIN),
    logger,
    paypal,
  })

  return {
    webhooks,
    logger,
    releaseReservations: releaseReservationsJob(clock, logger),
    reconcileBudget: budgetReconcileJob(logger),
    defend: defendDisputesJob(
      productionDefendDeps(defendDepsFor(paypal, clock, logger), (limit) =>
        findDisputesNeedingAssessment(limit),
      ),
    ),
  }
}

/**
 * §8.15's `ingestAndDefend` deps, over the real rows and the real client.
 *
 * **The options are `{}`** — see `productionDefendDeps`. The whole wiring passes no approval, which
 * is what keeps every PayPal write unreachable: the filer's §8.15 gate exits with
 * `awaitingApproval: true` before the posture dispatch, for every posture including REFUND.
 *
 * Two members are deliberately absent, and each absence is a real decision:
 *
 * - **no `drafter` / `llm`** — the packet notes come from the composed template (EC-LLM-1), and a
 *   model behind an absent credential must not stand between a dispute and its verdict.
 * - **no `renderPdf` / `artefacts`** — the packet persists with its bundle and hash, and filing
 *   awaits the approval that does not exist yet; the PDF renderer is wired when a merchant surface
 *   can attach it. `FileDeps` marks both optional for exactly this stage.
 */
function defendDepsFor(paypal: PayPalClient, clock: Clock, logger: Logger): IngestAndDefendDeps {
  const configured = env()
  const store = dbDefenderStore()
  const defenderDeps = defineDefenderDeps({
    clock,
    store,
    paypal,
    refunds: refundsRefusedLoudly(),
    // §6's only host a note or QR may name; validated https-or-localhost by `env()`.
    publicBaseUrl: configured.PUBLIC_BASE_URL,
    ...(logger ? { logger } : {}),
  })
  return {
    paypal,
    defender: { ingest: ingestDisputeToDefender, file: fileDispute, deps: defenderDeps },
    logger,
  }
}

/**
 * The queue handle {@link createWebhooksFromEnv} needs.
 *
 * A `WebhookQueue` built over the same `pg-boss` connection the worker starts, wrapped so this process's
 * queue operations report a `CsError` rather than throwing. The worker itself starts its own boss in
 * `startWorker`; this is only the **producer** side, which §8.12 step 4 calls for.
 *
 * It stays private on purpose. `apps/web`'s webhook route needs the same *port* (`WebhookQueue`) but composes
 * it from the packages `apps/web` already depends on, because importing across the `apps/worker` boundary would
 * pull the worker's job runner into the Next bundle (see `docs/contract-issues.md` item 9). Two call sites
 * satisfy the same port; the port is what `packages/webhooks` tests.
 */
function queueForWebhooks(): WebhookQueue {
  return {
    async send(name, data, opts) {
      const boss = await bossForProducer()
      const id = await boss.send(name, (data ?? {}) as object, opts ?? {})
      // pg-boss returns `null` for a singleton it deliberately suppressed. That is `WH_DUPLICATE`, not a
      // success, and collapsing it to a string would make a dropped duplicate look like an enqueue.
      return id === null
        ? {
            ok: false,
            error: {
              code: 'WH_DUPLICATE',
              message: `pg-boss suppressed a duplicate singleton for ${name}`,
              userMessage: 'That webhook was already queued.',
              retryable: false,
            },
          }
        : { ok: true, value: id }
    },
    async work() {
      // The worker registers its own handlers through `registerJobs`. This member exists only so
      // `WebhookQueue` is satisfied; reaching it from a producer would be a wiring mistake.
      return {
        ok: false,
        error: {
          code: 'CS_INTERNAL',
          message: 'work() is registered by startWorker, not by the webhook producer queue',
          userMessage: 'The server is misconfigured. Please tell the operator.',
          retryable: false,
        },
      }
    },
    async schedule() {
      return {
        ok: false,
        error: {
          code: 'CS_INTERNAL',
          message: 'schedules are registered by startWorker from CRON_SPECS',
          userMessage: 'The server is misconfigured. Please tell the operator.',
          retryable: false,
        },
      }
    },
    async start() {
      return { ok: true, value: undefined }
    },
    async stop() {
      // The producer queue shares the worker's boss, so stopping it here would stop job consumption.
      return { ok: true, value: undefined }
    },
  }
}

/** The lazily-created boss both `startWorker` and the webhook producer use. */
let producerBoss: Promise<PgBossLike> | null = null
function bossForProducer(): Promise<PgBossLike> {
  producerBoss ??= createPgBossQueue({ connectionString: env().DATABASE_URL })
  return producerBoss
}

/**
 * §8.10's 30-minute reservation release.
 *
 * Composed from `findStaleAttempts` and `expireStaleReservations`, with the **already-released filter**
 * in front of the write — because `releaseIn` inserts a `budget_entries` row whose primary key is the
 * derived `releaseEntryId(attemptId, mandateId)`, so a second run hits the primary key and comes back
 * `CS_CONFLICT`. Without the filter this cron would report an error every five minutes for ever, which is
 * how a working job looks broken to an operator.
 *
 * Requires only `DATABASE_URL`. That matters: it is the job that gives a buyer's budget back, so it must not
 * be the job that stops when a PayPal credential is absent.
 */
function releaseReservationsJob(clock: Clock, logger: Logger): JobHandler {
  // The whole body is wrapped, and that is not defensive padding: pg-boss decides whether to retry from
  // whether a handler **throws**, so a job that threw at an unreachable database would be retried for ever
  // with no diagnostic. A `Result` is what lets `settleForQueue` classify it and log it once.
  return async () => {
    try {
      return await sweepReservations(clock, logger)
    } catch (cause) {
      return err(toCsError(cause, 'CS_INTERNAL'))
    }
  }
}

async function sweepReservations(clock: Clock, logger: Logger): Promise<Result<unknown, CsError>> {
  const nowSec = clock.nowSec()
  const ttlSeconds = RESERVATION_TTL_SECONDS
  const store = drizzleStore()
  const candidates = await findStaleAttempts(new Date((nowSec - ttlSeconds) * 1000))
  if (!candidates.ok) return candidates

  const pending: OpenReservation[] = []
  let alreadyReleased = 0
  const byMandate = new Map<MandateId, CheckoutAttemptRow[]>()
  for (const attempt of candidates.value) {
    const mandateId = attempt.mandate_id as MandateId
    const list = byMandate.get(mandateId)
    if (list === undefined) byMandate.set(mandateId, [attempt])
    else list.push(attempt)
  }
  for (const [mandateId, group] of byMandate) {
    const entries = await listEntries(mandateId)
    if (!entries.ok) return entries
    const settled = new Set(
      entries.value
        .filter((e) => e.kind === 'RELEASE' && e.attempt_id !== null)
        .map((e) => e.attempt_id as string),
    )
    for (const attempt of group) {
      if (settled.has(attempt.id as AttemptId)) {
        alreadyReleased += 1
        continue
      }
      pending.push({
        attemptId: attempt.id as AttemptId,
        mandateId,
        amount: { minor: attempt.amount_minor, currency: attempt.currency },
        reservedAtSec: epochSecFrom(attempt.created_at),
        entryId: reservationEntryId(attempt.id as AttemptId, mandateId),
      })
    }
  }

  const outcome = await expireStaleReservations(store, {
    candidates: pending,
    nowSec,
    ttlSeconds,
    reason: RELEASE_REASONS.noOrder,
  })
  if (!outcome.ok) return outcome

  const swept = outcome.value.expired.length
  logger?.info('release.reservations finished', {
    module: 'worker',
    candidates: candidates.value.length,
    released: swept,
    already_released: alreadyReleased,
    still_held: outcome.value.stillHeld.length,
    failed: outcome.value.errors.length,
    now_utc: new Date(nowSec * 1000).toISOString(),
    now_ist: formatIst(nowSec),
  })
  return ok({
    candidates: candidates.value.length,
    released: swept,
    already_released: alreadyReleased,
    still_held: outcome.value.stillHeld.length,
    failed: outcome.value.errors.length,
  })
}

/**
 * §7.2's nightly "balances must equal the sum of entries".
 *
 * **Reports drift; never repairs it.** `packages/db`'s `reconcileIn` is the check, and a job that silently
 * rewrote `budget_accounts` would make the next drift report meaningless — the cache would always agree with
 * itself.
 */
function budgetReconcileJob(logger: Logger): JobHandler {
  // Same guard as the sweep above, for the same reason: a handler that throws is retried by pg-boss for ever.
  return async () => {
    try {
      return await runBudgetReconcile(logger)
    } catch (cause) {
      return err(toCsError(cause, 'CS_INTERNAL'))
    }
  }
}

async function runBudgetReconcile(logger: Logger): Promise<Result<unknown, CsError>> {
  const ids = await budgetAccountIds()
  if (!ids.ok) return ids
  const store = drizzleStore()
  const drifted: string[] = []
  for (const mandateId of ids.value) {
    const report = await reconcileIn(store, mandateId)
    // One unreadable account must not hide the rest, so a failure is counted rather than thrown; the whole
    // point of this job is to be the place where drift is *visible*.
    if (!report.ok) {
      logger?.error('budget.reconcile could not read an account', {
        module: 'worker',
        mandate_id: mandateId,
        code: report.error.code,
        message: report.error.message,
      })
      continue
    }
    if (!report.value.ok) drifted.push(mandateId)
  }
  logger?.info('budget.reconcile finished', {
    module: 'worker',
    accounts_checked: ids.value.length,
    drift: drifted.length,
    drifted_mandates: drifted.slice(0, 20),
    note: 'reported only; a repair is a human decision',
  })
  return ok({ accounts_checked: ids.value.length, drift: drifted.length, drifted })
}

/**
 * Run {@link main} and exit with its code. The only place `process.exit` is called from this file.
 *
 * ### `pathToFileURL`, and why the obvious version was silently wrong
 *
 * This used to read:
 *
 * ```ts
 * import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, '/')
 * ```
 *
 * which builds `file://C:/…` — two slashes and a bare drive letter. Node's `import.meta.url` is
 * `file:///C:/…` — three. The two strings can never be equal on Windows, so `isEntryPoint` was always
 * `false` there and `main()` never ran: `pnpm start` (which is `tsx src/index.ts`) exited **0 and did
 * nothing at all**, with no output, looking exactly like a clean shutdown. `import '@countersign/worker'`
 * stays inert, which is the property the WORKER-3 laziness rule wants — but the entry point has to be
 * recognised too, or the process that owns every webhook has never booted on a Windows developer machine.
 *
 * `pathToFileURL` is the function that exists to do this correctly, including the Windows drive letter and
 * UNC paths, so the comparison is now made in one canonical form on both sides.
 */
const entryPath = process.argv[1]
const isEntryPoint = entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href
if (isEntryPoint) {
  main().then(
    (code) => {
      if (code !== 0) process.exit(code)
    },
    (cause: unknown) => {
      console.error('[worker] fatal:', cause)
      process.exit(1)
    },
  )
}
