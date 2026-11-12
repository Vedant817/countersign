/**
 * Observability — spec §8.19 M19 and §14 (SLOs).
 *
 * `/status` has to answer one operational question honestly: *is anything stuck?* Two numbers do
 * that, and they are different numbers:
 *
 *  - **Last webhook time** says whether PayPal is still talking to us. A silent webhook channel looks
 *    exactly like a quiet day, which is why the age of the newest row is compared against the age of
 *    the oldest *unprocessed* row rather than shown on its own.
 *  - **Reconciler lag** says whether we are keeping up. §14 sets the target at under 5 minutes, so
 *    this module owns the threshold and the wording; a page that recomputes "is 5 minutes bad?" in
 *    its own template is how an SLA quietly becomes 15 minutes in the UI and stays 5 in the docs.
 *
 * The status values are deliberately four rather than two (`ok` / `lagging` / `stalled` / `idle`),
 * because "nothing has ever arrived" and "things arrived and stopped" are different states and the
 * second one is the emergency. Collapsing them to a red dot would hide the case the page exists for.
 */
import { SECONDS_PER_DAY } from './policy'

/** §14: "Reconciler lag < 5 min". */
export const RECONCILER_LAG_SLO_SEC = 5 * 60

/** When lag stops being "behind" and becomes "stuck". Three SLO windows, matching §14's nightly run. */
export const RECONCILER_STALLED_SEC = 15 * 60

export interface WebhookHealthInput {
  /** `max(received_at)` over `webhook_events`, or `null` if the table is empty. */
  readonly lastReceivedAtSec: number | null
  /** `max(processed_at)`, or `null` if nothing has ever been processed. */
  readonly lastProcessedAtSec: number | null
  readonly pendingCount: number
  /** `min(received_at)` over rows with `processed_at IS NULL`. */
  readonly oldestPendingReceivedAtSec: number | null
  readonly nowSec: number
}

export type WebhookHealthState = 'ok' | 'lagging' | 'stalled' | 'idle'

export interface WebhookHealth {
  readonly state: WebhookHealthState
  readonly lastWebhookAtSec: number | null
  /**
   * Age of the oldest unprocessed event, in seconds — **not** `now - lastProcessedAt`.
   *
   * Those two are equal only while the queue is empty, and it is precisely when the queue is not
   * empty that the page matters. Using the processed timestamp would report "0 s lag" on a system
   * that has processed nothing for an hour.
   */
  readonly reconcilerLagSec: number | null
  /** `true` when the lag exceeds §14's 5-minute target. */
  readonly sloBreached: boolean
  /** One line for the page. Never claims "healthy" for a system that has never received an event. */
  readonly detail: string
}

export function webhookHealth(input: WebhookHealthInput): WebhookHealth {
  const {
    lastReceivedAtSec,
    lastProcessedAtSec,
    pendingCount,
    oldestPendingReceivedAtSec,
    nowSec,
  } = input

  if (lastReceivedAtSec === null) {
    return {
      state: 'idle',
      lastWebhookAtSec: null,
      reconcilerLagSec: null,
      sloBreached: false,
      detail:
        'No webhook has ever been received. If PayPal is configured, this is a fault, not quiet.',
    }
  }

  if (pendingCount === 0 || oldestPendingReceivedAtSec === null) {
    return {
      state: 'ok',
      lastWebhookAtSec: lastReceivedAtSec,
      reconcilerLagSec: 0,
      sloBreached: false,
      detail: `Up to date; last event ${Math.max(0, nowSec - lastReceivedAtSec)}s ago.`,
    }
  }

  const lag = Math.max(0, nowSec - oldestPendingReceivedAtSec)
  const state: WebhookHealthState =
    lag >= RECONCILER_STALLED_SEC ? 'stalled' : lag > RECONCILER_LAG_SLO_SEC ? 'lagging' : 'ok'

  // `null` means "we did not read it", which is different from "nothing has ever been processed".
  // Claiming the latter when the caller simply did not supply the value is how a status page starts
  // reporting things it never measured, so the clause is omitted rather than guessed.
  const since =
    lastProcessedAtSec === null
      ? null
      : `last processed ${Math.max(0, nowSec - lastProcessedAtSec)}s ago`

  return {
    state,
    lastWebhookAtSec: lastReceivedAtSec,
    reconcilerLagSec: lag,
    sloBreached: lag > RECONCILER_LAG_SLO_SEC,
    detail: `${pendingCount} unprocessed, oldest ${lag}s old (§14 target ${RECONCILER_LAG_SLO_SEC}s)${since === null ? '.' : `; ${since}.`}`,
  }
}

/** One dependency row of `/status`. `configured` is about the environment, `ok` about a live probe. */
export interface DependencyStatus {
  readonly name: 'database' | 'vi' | 'paypal' | 'mcp' | 'openai'
  readonly configured: boolean
  readonly ok: boolean | null
  readonly detail: string
}

export type OverallStatus = 'ok' | 'degraded' | 'unconfigured' | 'down'

/**
 * Roll the dependencies into one HTTP-visible verdict.
 *
 * `unconfigured` and `down` are kept apart on purpose: a demo deployment with no PayPal credentials
 * is in a known state and must not page anyone, while a configured PayPal that is failing is an
 * incident. Collapsing them would make the honest "PayPal is not configured" message look like an
 * outage and train the reader to ignore both.
 */
export function overallStatus(deps: readonly DependencyStatus[]): {
  readonly status: OverallStatus
  readonly httpCode: number
} {
  const required = deps.filter((d) => d.name === 'database' || d.name === 'vi')
  if (required.some((d) => !d.configured)) return { status: 'unconfigured', httpCode: 503 }
  if (required.some((d) => d.ok === false)) return { status: 'down', httpCode: 503 }
  if (deps.some((d) => d.configured && d.ok === false)) return { status: 'degraded', httpCode: 200 }
  return { status: 'ok', httpCode: 200 }
}

/** `3d 4h` — how long a held retention class has left, for the privacy page. */
export function humaniseSeconds(seconds: number): string {
  if (seconds <= 0) return 'due now'
  const days = Math.floor(seconds / SECONDS_PER_DAY)
  const hours = Math.floor((seconds % SECONDS_PER_DAY) / 3_600)
  if (days > 0) return `${days}d ${hours}h`
  const minutes = Math.floor((seconds % 3_600) / 60)
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

/* ------------------------------------------------------------------------------------------ */
/* Job heartbeats — spec §8.19, §14                                                                */
/* ------------------------------------------------------------------------------------------ */

/**
 * What one job's heartbeat says, as `/status` reads it out of `worker_job_runs`.
 *
 * `cadenceSec` is the schedule's own interval (`wh.reconcile` 300, `wh.disputes` 120, the nightly 86400).
 * It is an input rather than a constant here because a **nightly** job that misses one run is not five
 * minutes late, and a threshold that ignores that would page every night at 00:05.
 */
export interface JobHealthInput {
  readonly job: string
  /** How often `schedule.ts` says this job should run, in seconds. */
  readonly cadenceSec: number
  /** `null` when this job has never been recorded at all. */
  readonly lastStartedAtSec: number | null
  readonly lastFinishedAtSec: number | null
  /** `null` when the job has never succeeded — a different state from "has not run recently". */
  readonly lastSuccessAtSec: number | null
  readonly lastFailureAtSec: number | null
  readonly lastErrorCode: string | null
  readonly nowSec: number
}

/**
 * `ok` / `lagging` / `stalled` are about **time**. `failing` is about the **last answer**, and it is kept
 * separate because a job can be perfectly punctual and completely broken: a cron that throws on every tick
 * produces a fresh heartbeat and no work, and "lagging" would describe it as merely behind.
 *
 * `never` is the state a brand-new deployment is in, and the one a dead worker is in too. They are told
 * apart by {@link workerHealth} across the whole job list rather than per job: one job that has never run
 * on a worker whose other jobs are fine is a missing schedule, while *every* job never having run is a
 * worker that is not there.
 */
export type JobHealthState = 'ok' | 'lagging' | 'stalled' | 'failing' | 'never'

export interface JobHealth {
  readonly job: string
  readonly state: JobHealthState
  /** Age of the last success. `null` when there has never been one. */
  readonly ageSec: number | null
  readonly lastSuccessAtSec: number | null
  readonly lastFailureAtSec: number | null
  readonly lastErrorCode: string | null
  /**
   * The two thresholds actually applied, so the page can print the number it judged against.
   *
   * §14 quotes 300 s and 900 s for the reconciler; those are floors, not absolutes — a job whose cadence
   * is longer than the floor is judged against its own cadence, and saying which number was used is the
   * difference between an SLO and a rumour.
   */
  readonly lagThresholdSec: number
  readonly stallThresholdSec: number
  /** One line for the page. */
  readonly detail: string
}

/**
 * Judge one job's heartbeat against its own cadence and §14's floors.
 *
 * Order matters, and it is the order of *severity*, not of the code:
 *
 *  1. **never** — no record at all.
 *  2. **failing** — the most recent run failed. Checked before any time comparison because a job that
 *     fails every five minutes is not "behind", it is broken, and the fix is a stack trace rather than a
 *     longer wait.
 *  3. **stalled / lagging** — the last success is older than the (cadence-aware) threshold.
 *
 * A job that started and has not finished is judged against `lastStartedAtSec`: that is the only reading
 * of "it is running right now", and after the stall threshold it is the reading of "it hung".
 */
export function jobHealth(input: JobHealthInput): JobHealth {
  const lagThresholdSec = Math.max(RECONCILER_LAG_SLO_SEC, input.cadenceSec)
  const stallThresholdSec = Math.max(RECONCILER_STALLED_SEC, input.cadenceSec * 2)
  const base = {
    job: input.job,
    lastSuccessAtSec: input.lastSuccessAtSec,
    lastFailureAtSec: input.lastFailureAtSec,
    lastErrorCode: input.lastErrorCode,
    lagThresholdSec,
    stallThresholdSec,
  }

  if (
    input.lastStartedAtSec === null &&
    input.lastSuccessAtSec === null &&
    input.lastFailureAtSec === null
  ) {
    return {
      ...base,
      state: 'never',
      ageSec: null,
      detail: 'has never run on this deployment.',
    }
  }

  const failedLast =
    input.lastFailureAtSec !== null &&
    (input.lastSuccessAtSec === null || input.lastFailureAtSec > input.lastSuccessAtSec)
  if (failedLast) {
    const code = input.lastErrorCode === null ? 'an unrecorded error' : input.lastErrorCode
    return {
      ...base,
      state: 'failing',
      ageSec:
        input.lastSuccessAtSec === null ? null : Math.max(0, input.nowSec - input.lastSuccessAtSec),
      detail: `the most recent run failed with ${code}.`,
    }
  }

  // No success yet and nothing failed yet: the only honest reading is "in flight", judged by when it
  // started. If it never finishes, the stall threshold turns it into `stalled`.
  const reference = input.lastSuccessAtSec ?? input.lastStartedAtSec
  if (reference === null) {
    return { ...base, state: 'never', ageSec: null, detail: 'has never run on this deployment.' }
  }

  const age = Math.max(0, input.nowSec - reference)
  const state: JobHealthState =
    age > stallThresholdSec ? 'stalled' : age > lagThresholdSec ? 'lagging' : 'ok'

  const since =
    input.lastSuccessAtSec === null ? 'no run has ever succeeded' : `last success ${age}s ago`

  return {
    ...base,
    state,
    ageSec: input.lastSuccessAtSec === null ? null : age,
    detail: `${since}; expected every ${input.cadenceSec}s (target ${lagThresholdSec}s).`,
  }
}

/** §14's roll-up over every job the worker is supposed to run. */
export type WorkerHealthState = 'ok' | 'lagging' | 'stalled' | 'never'

export interface WorkerHealth {
  readonly state: WorkerHealthState
  readonly jobs: number
  readonly never: number
  readonly failing: number
  /** One line for the page, and it never says "ok" about a worker that has never reported. */
  readonly detail: string
}

/**
 * Roll per-job heartbeats into one verdict about the **worker**.
 *
 * The distinction this exists for: a worker whose *every* job is `never` has not had a quiet hour, it is
 * not there — and that is the exact failure a `type: worker` service has on Render, where there is no port
 * for the platform to probe. One job that has never run while the others are healthy is a missing schedule
 * entry instead, which is a different fix and is reported as `lagging` rather than `never`.
 *
 * `failing` is promoted to `stalled` in the roll-up: from the page's point of view, a job that fails every
 * tick and a job that stopped ticking both mean "nothing is being repaired", and a reader should not have
 * to know which one it is to know that the deployment is not all right.
 */
export function workerHealth(jobs: readonly JobHealth[]): WorkerHealth {
  const never = jobs.filter((j) => j.state === 'never').length
  const failing = jobs.filter((j) => j.state === 'failing').length
  const stalled = jobs.filter((j) => j.state === 'stalled').length
  const lagging = jobs.filter((j) => j.state === 'lagging').length

  const state: WorkerHealthState =
    jobs.length === 0 || never === jobs.length
      ? 'never'
      : stalled > 0 || failing > 0
        ? 'stalled'
        : lagging > 0 || never > 0
          ? 'lagging'
          : 'ok'

  const detail =
    state === 'never'
      ? jobs.length === 0
        ? 'No job has ever reported a run.'
        : `None of the ${jobs.length} jobs has ever reported a run. The worker is not running.`
      : state === 'stalled'
        ? `${stalled} job(s) past the stall threshold, ${failing} failing on every run. Lost webhooks are not being repaired.`
        : state === 'lagging'
          ? `${lagging} job(s) past the §14 target, ${never} never run.`
          : `All ${jobs.length} jobs ran inside their target.`

  return { state, jobs: jobs.length, never, failing, detail }
}

/* ------------------------------------------------------------------------------------------ */
/* Expected cadences — the bridge between the worker's schedule and /status                      */
/* ------------------------------------------------------------------------------------------ */

/**
 * How often each cron job is expected to run, in seconds.
 *
 * **The owner of these numbers is `apps/worker/src/schedule.ts`**, which derives them from the cron
 * expressions pg-boss actually runs (`cadenceSeconds`). They are repeated here because `apps/web` must not
 * import the worker's module graph — that is what keeps `pg-boss` and its `pg` dependency out of the Next
 * bundle (see `apps/worker/src/index.ts`'s lazy-construction rule).
 *
 * A copy with no test is a copy that drifts, so `apps/worker/test/schedule.test.ts` asserts that this table
 * and `jobCadences()` agree. A changed cadence therefore fails a test in the package that owns it rather than
 * silently moving the web page's threshold.
 *
 * `wh.process` is absent on purpose: it is event-driven, not on a cron, so "every 5 minutes" would be a lie
 * about the one job that runs whenever PayPal calls.
 */
export const JOB_CADENCE_SEC: Readonly<Record<string, number>> = {
  'wh.reconcile': 5 * 60,
  'wh.disputes': 2 * 60,
  'wh.auth-expiry': 5 * 60,
  'wh.verify': 5 * 60,
  'release.reservations': 5 * 60,
  'budget.reconcile': 24 * 60 * 60,
}

/**
 * The cadence to judge one job against.
 *
 * Defaults to §8.12's five-minute promise rather than to "never": a job name nobody has a cadence for is a
 * job that was added without a decision, and reporting it as behind is the reading that gets the decision
 * made.
 */
export function expectedCadenceSec(job: string): number {
  return JOB_CADENCE_SEC[job] ?? 5 * 60
}
