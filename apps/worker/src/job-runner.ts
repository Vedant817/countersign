/**
 * The `pg-boss` adapter and the handler table - spec **§8.12**, **§8.10**, **§7.2**, decisions **D12**, **D13**.
 *
 * ## Two jobs of work, deliberately separated
 *
 * | Export | What it is | Why it is separate |
 * |---|---|---|
 * | {@link PgBossLike} + {@link createPgBossQueue} | A **port** over pg-boss, behind a factory | The factory is async and does the `await import('pg-boss')` inside, so **importing this file opens no connection**. `handleWebhook` in `apps/web` and this module both need the queue, and neither may connect as a side effect of being imported. |
 * | {@link createJobRunner} | The handler table: `JobName` → the `packages/webhooks` function that does the work | It takes a {@link RunnerDeps} and touches nothing global, so a test can build a runner, feed it a payload and assert on the real code path without a database. |
 *
 * ## The rule this file exists to enforce
 *
 * Every handler **returns `Result` and never throws**. pg-boss decides whether to retry from whether the
 * handler throws, so a handler that throws on a *permanent* failure retries forever against a PayPal 404,
 * and a handler that swallows a *transient* one loses the work. Mapping is therefore explicit:
 *
 * - `ok` → pg-boss marks it complete. Includes `IGNORED`, `UNCHANGED`, `ALREADY_PROCESSED`,
 *   `REJECTED_FORGED` and `DEFERRED_UNVERIFIED`: those are correct conclusions, not failures.
 * - `err` with `retryable: true` (`PP_UNAVAILABLE`, `PP_RATE_LIMITED`, `CS_RATE_LIMITED`) → **re-thrown**, so
 *   pg-boss retries with its own backoff. Losing a job to a PayPal blip is the one outcome worse than a slow
 *   retry.
 * - `err` with `retryable: false` (`PP_NOT_FOUND`, `CS_NOT_FOUND`, `PP_UNPROCESSABLE`) → **returned**, so
 *   pg-boss completes it. Retrying will not change a 404.
 *
 * That is the whole retry policy in one paragraph, and it is why {@link classifyForQueue} is exported: it is
 * the piece worth testing on its own.
 *
 * ## Idempotency, and what would break it
 *
 * AGENTS.md rule 6 requires that re-running any job is safe, and these handlers are, because none of them
 * trusts its own payload. `wh.process` re-reads the `webhook_events` row and re-fetches from PayPal; the
 * sweeps re-fetch every candidate and write through the monotonic rank. Replaying a job therefore converges
 * on the same state rather than double-applying it.
 *
 * §8.12 step 4's `singletonKey = resource_id` is the other half: it makes pg-boss serialise work for one
 * resource across worker instances. EC-IDEM-4 says the loser gets `CS_CONFLICT` and no-ops, and that is a
 * `tsc`-checked statement - the rank write path returns `applied: false` rather than throwing, so the second
 * instance sees a normal `ok`.
 */
import { csError, ok, type CsError, type Logger, type Result } from '@countersign/core'
import {
  authorizationExpirySweep,
  processWebhookEvent,
  reconcileDisputes,
  reconcileResources,
  reprocessUnstoredWork,
  retryPendingVerifications,
  DEFAULT_LOOKBACK_DAYS,
  DEFAULT_RECONCILE_RPS,
  JOB_AUTH_EXPIRY,
  JOB_BUDGET_RECONCILE,
  JOB_DISPUTES,
  JOB_PROCESS,
  JOB_RECONCILE,
  JOB_RELEASE_RESERVATIONS,
  JOB_VERIFY,
  type CaptureOutcomeHooks,
  type JobHandler,
  type JobName,
  type SweepReport,
  type WebhookDeps,
} from '@countersign/webhooks'

/* ------------------------------------------------------------------------------------------ */
/* The pg-boss port                                                                              */
/* ------------------------------------------------------------------------------------------ */

/**
 * The four pg-boss methods this worker uses.
 *
 * A hand-written interface rather than `import type { PgBoss }` so that:
 *
 * 1. `pg-boss` is only ever reached through `await import()` inside {@link createPgBossQueue}, so the module
 *    graph of `apps/web`'s webhook route does not include it (and its `pg` dependency) at all.
 * 2. A test can substitute a recording double and assert *what the worker asked pg-boss for* - the
 *    singleton key, the cron expression, the retry budget - which is most of what is worth asserting about a
 *    queue adapter.
 *
 * The signatures mirror pg-boss 12.36 exactly. `send` returns `string | null` because pg-boss returns
 * `null` for a singleton it deliberately suppressed, and collapsing that to a plain `string` would make a
 * dropped duplicate look like a successful enqueue.
 */
export interface PgBossLike {
  start(): Promise<unknown>
  stop(options?: { graceful?: boolean; timeout?: number }): Promise<unknown>
  send(name: string, data?: object | null, options?: PgBossSendOptions): Promise<string | null>
  work(
    name: string,
    options: PgBossWorkOptions,
    handler: (job: { data?: unknown }) => Promise<unknown>,
  ): Promise<unknown>
  schedule(
    name: string,
    cron: string,
    data?: object | null,
    options?: PgBossSendOptions,
  ): Promise<unknown>
}

/** The subset of pg-boss's `SendOptions` this worker sets. */
export interface PgBossSendOptions {
  singletonKey?: string
  retryLimit?: number
  retryDelay?: number
  retryBackoff?: boolean
  startAfter?: number | string | Date
}

/** The subset of pg-boss's `WorkOptions` this worker sets. */
export interface PgBossWorkOptions {
  batchSize?: number
  includeMetadata?: boolean
}

/** What {@link createPgBossQueue} needs. Everything optional is injectable for the tests. */
export interface PgBossQueueOptions {
  /** The Postgres connection string. Secrets come from the environment (spec §6, AGENTS.md rule 4). */
  readonly connectionString: string
  /**
   * Overrides the module load. The default is `await import('pg-boss')`, which is why the adapter is behind
   * an async factory at all.
   */
  readonly load?: () => Promise<{ PgBoss: new (connectionString: string) => PgBossLike }>
}

/**
 * Build a {@link PgBossLike}-backed adapter.
 *
 * **Lazy, and the laziness is load-bearing.** Nothing here runs at import time: the `pg-boss` module is
 * loaded and constructed inside this function, so importing `apps/worker` from a test, or `apps/web`'s route
 * handler from anywhere, costs nothing and connects to nothing. The first *use* of the returned object
 * starts the connection.
 */
export async function createPgBossQueue(options: PgBossQueueOptions): Promise<PgBossLike> {
  const load =
    options.load ??
    (async () => {
      const mod = (await import('pg-boss')) as unknown as {
        PgBoss: new (connectionString: string) => PgBossLike
      }
      return { PgBoss: mod.PgBoss }
    })
  const { PgBoss } = await load()
  return new PgBoss(options.connectionString)
}

/* ------------------------------------------------------------------------------------------ */
/* Retry classification                                                                           */
/* ------------------------------------------------------------------------------------------ */

/**
 * Should this failure be retried by the queue?
 *
 * `CsError.retryable` is not a `pg-boss` concept, and this is the only place the two vocabularies meet. It
 * keys off the flag `@countersign/core` already sets, rather than re-deciding per code, so a new
 * `CsErrorCode` cannot be retryable here and non-retryable there.
 *
 * Exported because it is the part of this file worth testing exhaustively, and because "a 404 is not
 * retried" is a claim about money.
 */
export function classifyForQueue(error: CsError): 'RETRY' | 'COMPLETE' {
  return error.retryable ? 'RETRY' : 'COMPLETE'
}

/**
 * A handler, as pg-boss sees it.
 *
 * **Deliberately not `JobHandler`.** `packages/webhooks`'s `JobHandler` returns `Result<unknown, CsError>`,
 * which is right for a function called from another function in the same process and wrong for one called by
 * a queue: pg-boss reads the promise's resolution as success and a rejection as "retry me", so a resolved
 * `Result` that is `ok: false` would look like a success. This type is the seam where the two vocabularies
 * stop overlapping, and {@link settleForQueue} is the only thing allowed to cross it.
 */
export type QueueHandler = (data: unknown) => Promise<unknown>

/**
 * Turn a {@link Result} into what pg-boss should see.
 *
 * Re-throws a retryable failure so pg-boss's own retry/backoff machinery handles it, and returns anything
 * else - including a `Result` that is `ok` with an `IGNORED` conclusion - so the job completes.
 *
 * Accepts a promise or a value so a caller can hand over a call that is already in flight without an extra
 * `await`, which matters for `reconcileResources` in `wh.reconcile` where the first step's result decides
 * whether the second runs at all.
 */
export async function settleForQueue<T>(
  result: Promise<Result<T, CsError>> | Result<T, CsError>,
  context: { readonly job: JobName; readonly logger?: Logger },
): Promise<unknown> {
  const settled = await result
  if (settled.ok) return settled.value
  const verdict = classifyForQueue(settled.error)
  context.logger?.error('job failed', {
    job: context.job,
    verdict,
    code: settled.error.code,
    message: settled.error.message,
  })
  if (verdict === 'RETRY') throw settled.error
  return { ok: false, completed: true, code: settled.error.code, reason: settled.error.message }
}

/* ------------------------------------------------------------------------------------------ */
/* The handler table                                                                              */
/* ------------------------------------------------------------------------------------------ */

/**
 * What {@link createJobRunner} needs.
 *
 * `webhooks` is the whole {@link WebhookDeps}, supplied by whoever composes the process. The two ledger
 * sweeps are **ports, not `@countersign/ledger` calls**, for the reason `CaptureOutcomeHooks` is: this worker
 * must be able to run the webhook and reconciler half with no ledger wired at all, and the ledger half must
 * be substitutable in a test without a Postgres. `README.md` → "Contract issues" records what is missing on
 * the production side.
 */
export interface RunnerDeps {
  readonly webhooks: WebhookDeps
  /** §8.11's ledger movement, for a capture whose rank advances. */
  readonly hooks?: CaptureOutcomeHooks
  /** §8.10: release reservations whose 30 minutes ran out with no order. */
  readonly releaseReservations?: JobHandler
  /** §7.2: the nightly "balances must equal the sum of entries" check. */
  readonly reconcileBudget?: JobHandler
  /** Nightly lookback, in days. §8.12's "full 30-day sweep" is the default. */
  readonly lookbackDays?: number
  readonly logger?: Logger
}

/**
 * Every handler, keyed by {@link JobName}.
 *
 * Three of these are thin on purpose:
 *
 * - **`wh.reconcile` runs the expiry sweep first**, then the resource sweep. `reconcileResources` already does
 *   that internally; calling `authorizationExpirySweep` again from here would double every PayPal read.
 * - **`wh.reconcile` also calls `reprocessUnstoredWork`**, because §8.12's "200 even if processing fails" is
 *   only safe if something re-drives the rows that were stored and never enqueued (EC-WH-1/EC-WH-5's
 *   crash-window backstop). Folding it into the 5-minute cycle means the backstop shares the cron we already
 *   promised rather than needing its own.
 * - **`release.reservations` and `budget.reconcile` are caller-supplied**, and a missing one is a logged
 *   no-op rather than a crash. A worker that refuses to start because a ledger port was not wired would make
 *   the webhook half unavailable during a wiring mistake in the other half.
 */
export function createJobRunner(deps: RunnerDeps): Record<JobName, QueueHandler> {
  const lookbackDays = deps.lookbackDays ?? DEFAULT_LOOKBACK_DAYS
  const logger = deps.logger ?? deps.webhooks.logger

  const unconfigured = (job: JobName, needed: string): QueueHandler => {
    return async () => {
      logger?.warn('job has no handler wired', { job, needed })
      return { skipped: true, reason: `${job} is not wired in this process` }
    }
  }

  /** Adapts a caller-supplied `JobHandler` across the `Result` → pg-boss seam. */
  const adapt =
    (job: JobName, handler: JobHandler): QueueHandler =>
    async (data) =>
      settleForQueue(handler(data), { job, logger })

  return {
    /**
     * §8.12's `wh.process`. The payload is a pointer, never a source of state - `processWebhookEvent` re-reads
     * the row and re-fetches from PayPal.
     */
    [JOB_PROCESS]: async (data) => {
      const processed = await processWebhookEvent(data, deps.webhooks, deps.hooks)
      if (!processed.ok) return settleForQueue(processed, { job: JOB_PROCESS, logger })
      const { outcome, fixedWithoutWebhook } = processed.value
      logger?.info('webhook event processed', {
        webhook_event_id: processed.value.eventId,
        paypal_event_id: processed.value.paypalEventId,
        outcome: outcome.outcome,
        fixed_without_webhook: fixedWithoutWebhook,
      })
      return settleForQueue(ok({ outcome: outcome.outcome, fixedWithoutWebhook }), {
        job: JOB_PROCESS,
        logger,
      })
    },

    /** EC-WH-7: re-verify rows stored `PENDING`, and enqueue the ones that pass. */
    [JOB_VERIFY]: async () =>
      settleForQueue(retryPendingVerifications(deps.webhooks), { job: JOB_VERIFY, logger }),

    /** EC-WH-1/EC-WH-5: the 5-minute sweep, plus the stored-but-unenqueued backstop. */
    [JOB_RECONCILE]: async () => {
      const requeued = await reprocessUnstoredWork(deps.webhooks)
      if (!requeued.ok) return settleForQueue(requeued, { job: JOB_RECONCILE, logger })
      const report = await reconcileResources(deps.webhooks, {
        lookbackDays,
        hooks: deps.hooks,
      })
      if (!report.ok) return settleForQueue(report, { job: JOB_RECONCILE, logger })
      return settleForQueue(ok(summarise(report.value, { requeued: requeued.value.requeued })), {
        job: JOB_RECONCILE,
        logger,
      })
    },

    /** §8.12's 2-minute dispute sweep. */
    [JOB_DISPUTES]: async () =>
      settleForQueue(reconcileDisputes(deps.webhooks), { job: JOB_DISPUTES, logger }),

    /**
     * EC-TIME-5. Also runs as the first step of `wh.reconcile`, so a five-minute cycle and this cron overlap
     * on purpose - the candidate query is cheap and the work is idempotent, and the redundancy is what stops
     * a single missed tick from being a missed expiry.
     */
    [JOB_AUTH_EXPIRY]: async () =>
      settleForQueue(authorizationExpirySweep(deps.webhooks), { job: JOB_AUTH_EXPIRY, logger }),

    /** §8.10: "Reservations expire after 30 min without an order (a worker job releases them)". */
    [JOB_RELEASE_RESERVATIONS]:
      deps.releaseReservations === undefined
        ? unconfigured(JOB_RELEASE_RESERVATIONS, '@countersign/ledger')
        : adapt(JOB_RELEASE_RESERVATIONS, deps.releaseReservations),

    /** §7.2's nightly ledger check. Reports drift; never repairs it. */
    [JOB_BUDGET_RECONCILE]:
      deps.reconcileBudget === undefined
        ? unconfigured(JOB_BUDGET_RECONCILE, '@countersign/ledger')
        : adapt(JOB_BUDGET_RECONCILE, deps.reconcileBudget),
  }
}

/** A sweep's report, flattened for the log. `bigint` counts are kept as numbers. */
export interface JobSummary {
  readonly candidates: number
  readonly advanced: number
  readonly fixes: number
  readonly unchanged: number
  readonly ignored: number
  readonly failed: number
  readonly requeued?: number
  /** EC-PP-2, echoed so a log line states the limit it ran under rather than leaving it to be remembered. */
  readonly throttleRps: number
}

/**
 * The shape a completed sweep is logged and returned as.
 *
 * `reconciler_fixes_total` (EC-WH-1) is the number worth watching: it counts rows whose state we learned
 * from a `GET` with no webhook to tell us, and a metric that also counted confirmations would report a
 * healthy night as a recovery.
 */
export function summarise(
  report: SweepReport,
  extra: { readonly requeued?: number } = {},
): JobSummary {
  return {
    candidates: report.candidates,
    advanced: report.advanced,
    fixes: report.fixes,
    unchanged: report.unchanged,
    ignored: report.ignored,
    failed: report.failed,
    ...(extra.requeued === undefined ? {} : { requeued: extra.requeued }),
    throttleRps: DEFAULT_RECONCILE_RPS,
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Registration                                                                                   */
/* ------------------------------------------------------------------------------------------ */

/** What {@link registerJobs} did, and what it could not do. */
export interface RegistrationReport {
  readonly handlers: readonly JobName[]
  readonly schedules: readonly JobName[]
  /** Registration failures, by job. A handler with no schedule is not a failure. */
  readonly errors: readonly { readonly job: JobName; readonly error: CsError }[]
}

/**
 * Register every handler, then every cron.
 *
 * **Handlers first, schedules second, always.** A schedule that fires before its `work()` is registered
 * creates a job nobody will ever consume: pg-boss will keep producing `wh.reconcile` on the five-minute
 * cadence into a queue with no worker, and the backlog grows silently. Registering in this order makes that
 * state unreachable rather than merely unlikely.
 *
 * Nothing here starts the boss. `start()` is the caller's, so a test can register against a double and
 * assert the calls without a connection.
 */
export async function registerJobs(
  boss: PgBossLike,
  runner: Record<JobName, QueueHandler>,
  schedules: readonly { readonly job: JobName; readonly cron: string }[],
): Promise<RegistrationReport> {
  const errors: { job: JobName; error: CsError }[] = []

  for (const job of Object.keys(runner).sort() as JobName[]) {
    try {
      await boss.work(job, { batchSize: 10 }, async (job_) => runner[job](job_.data))
    } catch (cause) {
      errors.push({ job, error: queueError(`registering the ${job} handler failed`, cause) })
    }
  }

  const registered: JobName[] = []
  for (const spec of schedules) {
    try {
      await boss.schedule(spec.job, spec.cron)
      registered.push(spec.job)
    } catch (cause) {
      errors.push({
        job: spec.job,
        error: queueError(`registering the ${spec.job} schedule failed`, cause),
      })
    }
  }

  return {
    handlers: Object.keys(runner).sort() as JobName[],
    schedules: registered,
    errors,
  }
}

/**
 * Turn an escaped pg-boss throw into a `CsError`.
 *
 * pg-boss rejects rather than returning, so something has to catch. `CS_INTERNAL` is deliberate: the cause
 * is preserved on `cause`, and a queue failure is not one of the `CsErrorCode`s a user ever sees, so this
 * path belongs in a log rather than in buyer-facing copy.
 */
function queueError(message: string, cause: unknown): CsError {
  return csError('CS_INTERNAL', message, {}, { cause })
}
