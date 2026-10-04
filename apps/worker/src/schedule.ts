/**
 * The crons - spec **§8.12**'s three reconciler jobs, plus the two §8.10/§7.2 sweeps this worker owns.
 *
 * ## Pure data, on purpose
 *
 * This file has **no imports from `pg-boss`, no database handle, no clock and no logger**. It is the list
 * of what runs and how often, and nothing else. That is not tidiness for its own sake:
 *
 * - The interesting question about a cron is *"how often, and does that cadence match the edge case it
 *   covers?"* A table answers it in one screen. Logic scattered through a start-up function does not.
 * - Every entry names the **edge case or spec line** it exists for. A cadence with no stated reason is a
 *   cadence nobody will remember to change when the reason changes.
 * - It makes the table assertable. `test/schedule.test.ts` reads these constants directly, so "the dispute
 *   sweep is every 2 minutes" is a test rather than a comment that rots.
 *
 * ## Why the cadence is what it is
 *
 * | Job | Cadence | Why this interval |
 * |---|---|---|
 * | `wh.reconcile` | 5 min | §8.12 verbatim. The user-visible promise is "a lost webhook is fixed within
 *   5 minutes", so this number is a feature claim, not a tuning choice. |
 * | `wh.disputes` | 2 min | §8.12 verbatim. Faster than the resource sweep because a dispute has a
 *   **filing deadline** (§8.11: 3 days for `REQUIRED_ACTION`); a dispute stage we learn about late is a
 *   deadline we can lose. |
 * | `wh.auth-expiry` | 5 min | EC-TIME-5. The 29-day/3-day clocks are PayPal's, and **no
 *   `PAYMENT.AUTHORIZATION.EXPIRED` event exists** (report §26) - this poll is the only thing that will ever
 *   observe an expiry. Five minutes is cheap because the candidate query is indexed and the sweep re-fetches
 *   at 2 rps (EC-PP-2). |
 * | `release.reservations` | 5 min | §8.10: "Reservations expire after 30 min without an order". Five
 *   minutes against a 30-minute TTL means a buyer never waits more than 10% of their hold for it back. |
 * | `budget.reconcile` | nightly | §7.2: "`budget_accounts` is a cache; balances must equal the sum of
 *   entries (nightly check)". It is a **verification**, and it reports drift rather than repairing it. |
 * | `wh.verify` | 5 min | EC-WH-7's retry. Not on a tighter loop on purpose: `verifyDelivery` already has
 *   its own timeout and `verificationRetryAfterSeconds` backoff, so a hammering loop would just spend
 *   PayPal requests during an outage - the exact moment the endpoint is unavailable. |
 *
 * ## Timezone
 *
 * Every expression is UTC, because the crons are about **intervals** and "every five minutes" is the same
 * instant everywhere. The one place IST appears is `packages/core`'s formatting for humans, and this table
 * deliberately does not do that (AGENTS.md rule 10: IST only in the UI and in reports).
 *
 * The nightly ledger check runs at **02:17**, not 02:00. A build pipeline, a `pg_dump` or another scheduler
 * on the hour is the usual reason a scheduled job finds the database already busy, and 02:17 costs nothing
 * to be deliberate about. (The cron expressions themselves are written without a leading star where one
 * would read as a comment terminator - see {@link FIVE_MINUTES}.)
 */
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

/** One scheduled job. */
export interface CronSpec {
  /** The pg-boss queue name, which is the {@link JobName}. */
  readonly job: JobName
  /** A five-field cron expression, UTC. */
  readonly cron: string
  /** How often, in words. Kept beside the expression so the two cannot disagree unnoticed. */
  readonly every: string
  /** The spec line or edge-case id this exists for. */
  readonly because: string
}

/**
 * The five-minute interval, as a cron expression.
 *
 * Exported because three of the crons share it, and three copies of the expression is three places to fix the
 * cadence in.
 *
 * Note the leading `*` in the value. Writing it inside a doc comment needs care: a literal step expression
 * ends with `*` and so closes the comment it is quoted in, which is why the constants below carry the
 * expressions rather than this header repeating them.
 */
export const FIVE_MINUTES = '*/5 * * * *'

/** §8.12's 2-minute dispute cron. */
export const TWO_MINUTES = '*/2 * * * *'

/** 02:17 UTC. Off the hour on purpose - see this file's header. */
export const NIGHTLY_02_17_UTC = '17 2 * * *'

/**
 * Everything this worker schedules, in the order `startWorker` registers it.
 *
 * {@link JOB_PROCESS} is **absent on purpose**: it is event-driven, not cron-driven. `wh.process` is
 * enqueued by `handleWebhook` (§8.12 step 4), so giving it a cron would invent a second source of jobs for
 * the same queue name - and a sweep that processed "the last event" on a timer would be exactly the
 * never-trust-payload-state mistake in a different costume. {@link EVENT_DRIVEN_JOBS} lists it, and
 * {@link HANDLED_JOBS} is therefore the set of names that must always have a `work()` handler registered.
 *
 * {@link JOB_VERIFY} *is* a cron and it is not in tension with the above: it is a **sweep**, not a
 * per-event path. A row only reaches it by being stored `PENDING`, and only a sweep can notice that without
 * already having a reason to look at that row.
 */
export const CRON_SPECS: readonly CronSpec[] = Object.freeze([
  {
    job: JOB_RECONCILE,
    cron: FIVE_MINUTES,
    every: '5 minutes',
    because:
      '§8.12: "every 5 min: orders/authorizations/captures not terminal and updated in the last 30 days". ' +
      'EC-WH-1/EC-WH-5. This cadence is the user-visible promise of a lost webhook being fixed within 5 minutes.',
  },
  {
    job: JOB_DISPUTES,
    cron: TWO_MINUTES,
    every: '2 minutes',
    because:
      '§8.12: "every 2 min: listDisputes(start_time = last_seen - 1h)". Faster than the resource sweep because ' +
      'a dispute carries a §8.11 filing deadline.',
  },
  {
    job: JOB_AUTH_EXPIRY,
    cron: FIVE_MINUTES,
    every: '5 minutes',
    because:
      'EC-TIME-5. There is no PAYMENT.AUTHORIZATION.EXPIRED event (report §26), so polling is the only way an ' +
      'expiry is ever observed.',
  },
  {
    job: JOB_RELEASE_RESERVATIONS,
    cron: FIVE_MINUTES,
    every: '5 minutes',
    because:
      '§8.10: "Reservations expire after 30 min without an order (a worker job releases them)". 5 min against a ' +
      '30 min TTL.',
  },
  {
    job: JOB_BUDGET_RECONCILE,
    cron: NIGHTLY_02_17_UTC,
    every: 'nightly at 02:17 UTC',
    because:
      '§7.2: "`budget_accounts` is a cache; balances must equal the sum of entries (nightly check)". Reports ' +
      'drift; never repairs it.',
  },
  {
    job: JOB_VERIFY,
    cron: FIVE_MINUTES,
    every: '5 minutes',
    because:
      'EC-WH-7: rows stored PENDING because verify-webhook-signature was unavailable. Deliberately loose - the ' +
      'call already has a timeout and its own exponential backoff.',
  },
])

/** The job names that have no cron and are enqueued by other code instead. */
export const EVENT_DRIVEN_JOBS: readonly JobName[] = Object.freeze([JOB_PROCESS])

/** Every job this worker registers a handler for: the crons plus the event-driven ones. */
export const HANDLED_JOBS: readonly JobName[] = Object.freeze([
  ...CRON_SPECS.map((s) => s.job),
  ...EVENT_DRIVEN_JOBS,
])

/** The cadence for one job, or `undefined` when it is not on a cron. */
export function cronFor(job: JobName): string | undefined {
  return CRON_SPECS.find((s) => s.job === job)?.cron
}

/**
 * Every cron string, for validation.
 *
 * pg-boss reports a malformed expression on the **first tick**, not at `schedule()` time, which is the
 * worst possible time to learn that a step expression has a stray character. So the shape is checked here, at
 * registration, against a deliberately small grammar: five whitespace-separated fields, each of digits, a
 * wildcard, a step (`*` then `/n`) or a range (`n-m`).
 *
 * This is **not** a cron parser and does not claim to be. It catches typos and copy-paste damage, which is
 * the failure mode worth catching, and leaves semantic validity to pg-boss.
 */
export function isPlausibleCron(expression: string): boolean {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) return false
  return fields.every((field) => /^(\*|\*\/\d+|\d+(-\d+)?)(\/(\*|\d+))?$/.test(field))
}
