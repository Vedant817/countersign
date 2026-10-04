/**
 * Per-host circuit breaker — spec §8.6 "Circuit breaker", EC-PP-1.
 *
 * ```
 * Per host: 5 consecutive PP_UNAVAILABLE errors open the breaker for 30 s.
 * While it is open, calls fail fast with retryable:true.
 * ```
 *
 * ## Why a breaker and not just the retry budget
 *
 * The retry budget alone already bounds one call's damage (4 attempts, ~20 s worst case). The breaker
 * bounds the *aggregate*: without it, a worker processing a queue of 200 queued orders during a
 * PayPal outage spends four attempts plus a ~20 s backoff on each one, holding a reservation and a
 * connection for the whole outage while every request is certain to fail. Failing fast turns that
 * into "reject immediately, retry from the queue" (EC-PP-1's "we'll retry for 15 min; nothing is
 * charged twice"), which is what makes the user-facing message honest.
 *
 * ## Mechanics
 *
 * - **Per host.** A PayPal base URL is one host today, but the breaker is keyed by hostname so a
 *   future second host (or a test hitting two) gets an independent budget rather than sharing
 *   failure history.
 * - **Consecutive, not cumulative.** Any outcome other than `PP_UNAVAILABLE` — including a 422 or a
 *   successful call — means the host is answering, so the counter resets. A cumulative counter would
 *   open the breaker on a healthy host after enough bad *requests* (our bug), which is exactly the
 *   failure mode that hides an incident behind a self-inflicted outage.
 * - **One probe at a time.** After 30 s the breaker goes half-open and lets exactly one request
 *   through. Twenty workers that all discover the window at once must not all become the probe.
 * - **Time comes from the injected {@link Clock}.** Never `Date.now()`: an open breaker with a
 *   30 s window is precisely the thing a test cannot check with a real clock.
 */
import { csError, ok, err } from '@countersign/core'
import type { Clock, CsError, Result } from '@countersign/core'

/** Consecutive `PP_UNAVAILABLE` results that open the breaker. Spec §8.6: 5. */
export const BREAKER_THRESHOLD = 5

/** How long the breaker stays open before allowing a probe. Spec §8.6: 30 s. */
export const BREAKER_OPEN_MS = 30_000

export type BreakerState = 'closed' | 'open' | 'half-open'

export interface CircuitBreakerOpts {
  readonly clock: Clock
  readonly threshold?: number
  readonly openMs?: number
}

interface HostState {
  state: BreakerState
  /** Consecutive `PP_UNAVAILABLE` results while closed. */
  consecutiveUnavailable: number
  /** Epoch ms at which an `open` breaker may move to `half-open`. */
  openUntilMs: number
  /** True while a half-open probe is in flight. */
  probeInFlight: boolean
}

export class CircuitBreaker {
  private readonly clock: Clock
  private readonly threshold: number
  private readonly openMs: number
  private readonly hosts = new Map<string, HostState>()

  constructor(opts: CircuitBreakerOpts) {
    this.clock = opts.clock
    this.threshold = opts.threshold ?? BREAKER_THRESHOLD
    this.openMs = opts.openMs ?? BREAKER_OPEN_MS
  }

  private host(hostname: string): HostState {
    let s = this.hosts.get(hostname)
    if (!s) {
      s = { state: 'closed', consecutiveUnavailable: 0, openUntilMs: 0, probeInFlight: false }
      this.hosts.set(hostname, s)
    }
    return s
  }

  /**
   * Allow the caller to make a request, or fail fast with a `retryable: true` error.
   *
   * Calling this *before* the request reserves a half-open probe slot; every matching call must then
   * report its outcome through {@link recordSuccess}, {@link recordUnavailable} or
   * {@link recordReachable}. A slot that is never reported simply times out into the next
   * `openUntilMs`, which is safe: the worst case is one probe lost.
   */
  preflight(hostname: string): Result<void, CsError> {
    const s = this.host(hostname)
    if (s.state === 'closed') return ok(undefined)

    const now = this.clock.nowMs()

    if (s.state === 'open') {
      if (now < s.openUntilMs) {
        return err(this.openError(hostname, s.openUntilMs - now, s.consecutiveUnavailable))
      }
      // The cool-off elapsed: let exactly one request through to find out whether PayPal is back.
      s.state = 'half-open'
      s.probeInFlight = true
      return ok(undefined)
    }

    // half-open
    if (s.probeInFlight) {
      return err(this.openError(hostname, Math.max(0, s.openUntilMs - now), s.consecutiveUnavailable))
    }
    s.probeInFlight = true
    return ok(undefined)
  }

  /** The host answered — a 2xx, a 4xx, or a mapped PayPal error. Any of those proves it is up. */
  recordSuccess(hostname: string): void {
    const s = this.host(hostname)
    s.state = 'closed'
    s.consecutiveUnavailable = 0
    s.openUntilMs = 0
    s.probeInFlight = false
  }

  /** Synonym for {@link recordSuccess}, for call sites that read better as "reachable". */
  recordReachable(hostname: string): void {
    this.recordSuccess(hostname)
  }

  /** This attempt hit a network error, a timeout or a 5xx: `PP_UNAVAILABLE`. */
  recordUnavailable(hostname: string): void {
    const s = this.host(hostname)
    if (s.state === 'half-open') {
      // The probe failed: straight back to open for another full window.
      s.state = 'open'
      s.probeInFlight = false
      s.consecutiveUnavailable = this.threshold
      s.openUntilMs = this.clock.nowMs() + this.openMs
      return
    }
    s.consecutiveUnavailable += 1
    if (s.consecutiveUnavailable >= this.threshold) {
      s.state = 'open'
      s.openUntilMs = this.clock.nowMs() + this.openMs
      s.probeInFlight = false
    }
  }

  private openError(hostname: string, retryInMs: number, consecutive: number): CsError {
    return csError(
      'PP_UNAVAILABLE',
      `Circuit breaker is open for ${hostname}; failing fast instead of calling PayPal`,
      {
        host: hostname,
        consecutive_unavailable: consecutive,
        opens_at_ms: this.clock.nowMs() + retryInMs,
      },
      // retryable:true is required by EC-PP-1 and is load-bearing: the queue retries these.
      { retryable: true },
    )
  }

  state(hostname: string): BreakerState {
    return this.host(hostname).state
  }

  /** Consecutive `PP_UNAVAILABLE` count. Exposed for the breaker test and the status page. */
  consecutiveUnavailable(hostname: string): number {
    return this.host(hostname).consecutiveUnavailable
  }

  /** Forget everything. Tests must call this; production never does. */
  reset(): void {
    this.hosts.clear()
  }
}

/**
 * Hostname of a base URL, or the raw string when it cannot be parsed.
 *
 * The breaker is keyed on the hostname rather than the whole base URL so that a trailing slash or a
 * path change is not a new circuit.
 */
export function breakerKey(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname
  } catch {
    return baseUrl
  }
}