/**
 * Retry backoff — spec §8.6 "Retries", [B15].
 *
 * ```
 * exponential backoff (base 500 ms, factor 2, full jitter, cap 20 s, max 4), honour Retry-After
 * ```
 *
 * Two decisions worth stating, because both are load-bearing:
 *
 *  - **Full jitter, not equal jitter.** The delay is `random() * min(cap, base * factor^(n-1))`, so
 *    N workers that all fail at once spread out uniformly over `[0, ceiling]` instead of retrying
 *    in lockstep. Equal jitter (`ceiling/2 + random()*ceiling/2`) still synchronises the first retry,
 *    which is the exact case that turns a PayPal blip into a self-inflicted thundering herd (EC-PP-2).
 *  - **`Retry-After` beats the formula.** When PayPal sends it we wait at least that long. The
 *    formula is what we fall back to when it does not. AT-M6.3 pins this: a 429 with
 *    `Retry-After: 2` must not retry before 2 s, no matter what the jitter said.
 *
 * Nothing here sleeps on its own: the client takes a {@link Sleep}, so a test can prove the wait
 * without spending it.
 */
import { csError } from '@countersign/core'
import type { CsError, CsErrorCode } from '@countersign/core'

/** Injected so tests never actually wait. Production passes {@link realSleep}. */
export type Sleep = (ms: number) => Promise<void>

/** The real thing. `setTimeout` for non-negative integers, resolved immediately otherwise. */
export const realSleep: Sleep = (ms) =>
  new Promise<void>((resolve) => {
    if (!Number.isFinite(ms) || ms <= 0) {
      resolve()
      return
    }
    const t = setTimeout(resolve, ms)
    // Do not hold the event loop open for a backoff timer.
    if (typeof t === 'object' && t !== null && 'unref' in t) t.unref()
  })

export interface BackoffConfig {
  /** First ceiling, before jitter. Spec: 500 ms. */
  readonly baseMs: number
  /** Growth per attempt. Spec: 2. */
  readonly factor: number
  /** Hard ceiling on any single delay, jittered or not. Spec: 20 s. */
  readonly capMs: number
  /** Total attempts, i.e. one initial call plus three retries. Spec: 4. */
  readonly maxAttempts: number
}

export const DEFAULT_BACKOFF: BackoffConfig = {
  baseMs: 500,
  factor: 2,
  capMs: 20_000,
  maxAttempts: 4,
}

/**
 * A `Retry-After` larger than this is treated as malformed rather than obeyed.
 *
 * A one-hour wait inside a request handler is indistinguishable from a hung worker, and the spec's
 * own answer for a long outage is the pg-boss queue (EC-PP-1), not a sleep. One hour is far above any
 * plausible rate-limit window.
 */
export const MAX_RETRY_AFTER_MS = 3_600_000

/**
 * The exponential ceiling for `attempt` (1-based, no delay after the last attempt), before jitter.
 *
 * `attempt 1 → 500 ms`, `2 → 1000`, `3 → 2000`, … clamped at `capMs`.
 */
export function backoffCeilingMs(attempt: number, cfg: BackoffConfig = DEFAULT_BACKOFF): number {
  if (attempt < 1) return 0
  const raw = cfg.baseMs * cfg.factor ** (attempt - 1)
  return Math.min(cfg.capMs, Number.isFinite(raw) ? raw : cfg.capMs)
}

/**
 * Full jitter: uniform in `[0, ceiling]`.
 *
 * @param attempt 1-based attempt number that just failed.
 * @param random injectable in `[0, 1)`; defaults to `Math.random`. Passed in by tests so the
 *   sequence of delays is deterministic.
 */
export function fullJitterDelayMs(
  attempt: number,
  cfg: BackoffConfig = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const ceiling = backoffCeilingMs(attempt, cfg)
  if (ceiling <= 0) return 0
  const r = Math.min(Math.max(random(), 0), 0.999_999_999)
  return Math.floor(r * ceiling)
}

/**
 * Parse `Retry-After` ([RFC 9110 §10.2.3](https://www.rfc-editor.org/rfc/rfc9110#field.retry-after)).
 *
 * Accepts `delay-seconds` and `http-date`. Returns `null` for absent or malformed values so the
 * caller falls back to {@link fullJitterDelayMs} — guessing a date we did not parse would be worse
 * than ignoring it.
 *
 * @param nowMs the injected clock's current time, used to turn an `http-date` into a duration.
 */
export function parseRetryAfter(value: string | null | undefined, nowMs: number): number | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  if (v === '') return null
  if (/^\d+$/.test(v)) {
    const ms = Number(v) * 1000
    if (!Number.isSafeInteger(ms) || ms > MAX_RETRY_AFTER_MS) return null
    return ms
  }
  // A signed or fractional number is malformed, not a date. `Date.parse('-5')` and `Date.parse('1.5')`
  // both succeed on some engines, which would turn a typo into an hour-long sleep.
  if (/^[+-]?[\d.]/.test(v)) return null
  const at = Date.parse(v)
  if (Number.isNaN(at)) return null
  const delta = at - nowMs
  if (delta <= 0) return 0 // already elapsed; retry immediately
  return delta > MAX_RETRY_AFTER_MS ? null : delta
}

/**
 * The delay to wait before `attempt + 1`.
 *
 * `retryAfterMs` wins when it is present, because it is PayPal telling us exactly how long it needs
 * — and AT-M6.3 requires it to be honoured as a *floor*, not a suggestion. The jittered value is
 * floored at `retryAfterMs` so a `Retry-After` of 2 s can never be shortened by a lucky `random()`.
 */
export function nextDelayMs(args: {
  attempt: number
  retryAfterMs?: number | null
  cfg?: BackoffConfig
  random?: () => number
}): number {
  const { attempt, retryAfterMs = null } = args
  const cfg = args.cfg ?? DEFAULT_BACKOFF
  const jittered = fullJitterDelayMs(attempt, cfg, args.random ?? Math.random)
  if (retryAfterMs === null) return jittered
  return Math.max(retryAfterMs, jittered)
}

/** A `CsError` for exhausting the retry budget, carrying what a human needs to act on it. */
export function retriesExhausted(args: {
  attempts: number
  lastCode: CsErrorCode
  lastMessage: string
  debugId?: string | undefined
  requestId?: string | undefined
  method: string
  path: string
}): CsError {
  return csError(
    args.lastCode,
    `${args.method} ${args.path} failed after ${args.attempts} attempts: ${args.lastMessage}`,
    {
      attempts: args.attempts,
      method: args.method,
      path: args.path,
      request_id: args.requestId,
      paypal_debug_id: args.debugId,
    },
    // The individual code keeps its own retryability, but the wrapped error must not claim to be
    // retryable-by-the-caller when we already spent the budget inside the client.
    { retryable: args.lastCode === 'PP_UNAVAILABLE' || args.lastCode === 'PP_RATE_LIMITED' },
  )
}