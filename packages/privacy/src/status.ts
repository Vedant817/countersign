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

  const since =
    lastProcessedAtSec === null
      ? 'never processed anything'
      : `last processed ${Math.max(0, nowSec - lastProcessedAtSec)}s ago`

  return {
    state,
    lastWebhookAtSec: lastReceivedAtSec,
    reconcilerLagSec: lag,
    sloBreached: lag > RECONCILER_LAG_SLO_SEC,
    detail: `${pendingCount} unprocessed, oldest ${lag}s old (§14 target ${RECONCILER_LAG_SLO_SEC}s); ${since}.`,
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
