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
 * - `import '@countersign/worker'` is free. A test asserts it (`WORKER-3` in `test/lazy.test.ts`).
 * - `startWorker()` is the only thing that connects, and it is the only thing that needs an argument.
 *
 * ## `main()` is guarded
 *
 * {@link main} runs only when this module is the process entry point, and it is written so that running it
 * with a missing `DATABASE_URL` fails **loudly and immediately** (spec §6) rather than starting a worker that
 * will 500 on its first tick an hour later.
 */
import { env, systemClock, type CsError, type Logger, type Result } from '@countersign/core'
import { PayPalClient } from '@countersign/paypal'
import { defaultThrottle, defineWebhookDeps, type WebhookDeps } from '@countersign/webhooks'

import { createJobRunner, createPgBossQueue, registerJobs, type PgBossLike } from './job-runner'
import { CRON_SPECS, isPlausibleCron, type CronSpec } from './schedule'

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
  type RegistrationReport,
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
  /** Handlers and schedules that were registered, and the ones that failed. */
  readonly registration: Awaited<ReturnType<typeof registerJobs>>
  stop(): Promise<void>
}

/** What {@link startWorker} needs. Only `webhooks` is required; the rest have production defaults. */
export interface WorkerDeps {
  /** The whole `WebhookDeps`. Whoever composes the process decides the store, the clock and the queue. */
  readonly webhooks: WebhookDeps
  readonly logger?: Logger
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
 * 3. Register every handler, then every schedule ({@link registerJobs} does both, in that order).
 * 4. `start()` **last**. pg-boss starts polling on `start()`, so a handler registered after that point races
 *    the first fetch of a job it was going to consume anyway.
 *
 * @returns `err` if registration failed for any job. A partially-registered worker is worse than none: it
 *   looks alive, and the gaps are exactly the crons that quietly stop fixing lost webhooks.
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

  const boss = deps.boss ?? (await createPgBossQueue({ connectionString: env().DATABASE_URL }))
  const runner = createJobRunner({ webhooks: deps.webhooks, logger })

  const registration = await registerJobs(boss, runner, crons)
  if (registration.errors.length > 0) {
    logger?.error('worker registration incomplete', {
      errors: registration.errors.map((e) => ({
        job: e.job,
        code: e.error.code,
        message: e.error.message,
      })),
      handlers: registration.handlers.length,
      schedules: registration.schedules.length,
    })
    return { ok: false, error: registration.errors[0]!.error }
  }

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

  logger?.info('worker started', {
    handlers: registration.handlers,
    schedules: registration.schedules,
  })

  let stopped = false
  return {
    ok: true,
    value: {
      boss,
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
  },
): WebhookDeps {
  const clock = options.clock ?? systemClock
  const configured = env()
  const paypal = new PayPalClient({
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
  const shutdown = (signal: string): void => {
    console.info(`[worker] ${signal} received, draining`)
    void worker.stop().then(
      () => process.exit(0),
      (cause: unknown) => {
        console.error('[worker] shutdown failed:', cause)
        process.exit(1)
      },
    )
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
 * The store and the audit sink are **not** constructed here. `packages/db` exports the repository functions
 * but no `WebhookStore` adapter, and `WebhookAudit` has no production implementation yet - both are recorded
 * in `README.md` → "Contract issues". That is a real gap, not a stub to paper over: it is the one thing
 * between this process and running against a live database.
 */
async function productionDeps(): Promise<WorkerDeps> {
  // Read the environment first, so a missing variable fails here rather than at the first job tick.
  env()
  throw new Error(
    'production wiring is incomplete: WebhookStore and WebhookAudit adapters are not implemented. ' +
      'See apps/worker/README.md -> Contract issues.',
  )
}

/** Run {@link main} and exit with its code. The only place `process.exit` is called from this file. */
const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, '/')
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
