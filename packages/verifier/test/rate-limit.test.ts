/**
 * **AT-M18.2**: the 30/min/IP limit on `/v1/public/verify`, enforced at the Next route as well as in
 * `apps/vi`.
 *
 * ## Why a second limiter, when `apps/vi` already has one
 *
 * Because a limit behind the thing it protects can be bypassed by the thing in front of it. Without this,
 * "Verify now" is an unmetered Next route that forwards to a metered vi-service: the limiter still caps
 * vi-service's crypto work per IP, but *our* process absorbs every request in the meantime, and one reader
 * can pin a route handler for as long as they like. Spec §8.3's limit is on the public verifier as a whole,
 * and the public verifier is this page.
 *
 * ## Every test here uses an injected clock
 *
 * `nowMs` is a function, so a 60-second window is tested by moving a number rather than by sleeping. The
 * alternative — a real `setTimeout` — would make the suite take a minute and be flaky under CI load, which is
 * how rate-limit tests usually get skipped.
 */

import { describe, expect, it } from 'vitest'

import { formatError } from '@countersign/core'

import {
  clientIdFromHeaders,
  createPublicRateLimiter,
  PUBLIC_RATE_LIMIT_PER_MIN,
  PUBLIC_RATE_WINDOW_MS,
  rateLimitError,
} from '../src/verify-view'

/** A clock the test moves by hand. */
function clockAt(startMs = 1_000_000): { nowMs: () => number; advance: (ms: number) => void } {
  let at = startMs
  return { nowMs: () => at, advance: (ms: number) => void (at += ms) }
}

const MINUTE = PUBLIC_RATE_WINDOW_MS

// ---------------------------------------------------------------------------
// AT-M18.2
// ---------------------------------------------------------------------------

describe('AT-M18.2 the rate limit is enforced', () => {
  it('is 30 requests per 60 seconds per IP, which is spec §8.3', () => {
    expect(PUBLIC_RATE_LIMIT_PER_MIN).toBe(30)
    expect(PUBLIC_RATE_WINDOW_MS).toBe(60_000)
  })

  it('allows exactly 30 requests and refuses the 31st', () => {
    const clock = clockAt()
    const limiter = createPublicRateLimiter({ nowMs: clock.nowMs })

    for (let i = 1; i <= 30; i++) {
      const verdict = limiter.check('203.0.113.7')
      expect(verdict.allowed, `request ${i} should be allowed`).toBe(true)
      expect(verdict.remaining).toBe(30 - i)
    }

    const refused = limiter.check('203.0.113.7')
    expect(refused.allowed).toBe(false)
    expect(refused.remaining).toBe(0)
    // And the answer is well-formed enough to build a 429 from.
    expect(refused.retryAfterSec).toBeGreaterThan(0)
    expect(refused.resetAtSec).toBeGreaterThan(0)
  })

  it('slides rather than resetting on a boundary', () => {
    // The concrete attack a fixed window permits: 30 requests spread over the first half-minute and 30 more in
    // the second, which is sixty ES256 chain verifications against a budget of thirty.
    //
    // The requests are spread deliberately. Thirty hits at one instant would expire together, which would
    // make this test pass for the wrong reason — and would hide the property that matters, which is that the
    // budget returns **gradually**, in step with the oldest hit leaving, rather than all at once on a boundary.
    const clock = clockAt()
    const limiter = createPublicRateLimiter({ nowMs: clock.nowMs })

    // One request per second for 30 seconds, starting at t = 1 s.
    for (let i = 0; i < 30; i++) {
      clock.advance(1_000)
      expect(limiter.check('203.0.113.7').allowed, `hit ${i + 1}`).toBe(true)
    }

    // t = 30 s: over budget. The refusal says how long to wait — until the t=1 s hit leaves its window, at
    // t = 61 s. So 31 seconds, which is the whole point of a sliding window over a fixed one: the answer is
    // computed from the oldest live hit rather than from a boundary.
    const refused = limiter.check('203.0.113.7')
    expect(refused.allowed).toBe(false)
    expect(refused.retryAfterSec).toBe(31)
    expect(refused.resetAtSec).toBe(Math.ceil((1_001_000 + MINUTE) / 1000))

    // Still inside that wait: refused again, and the retry-after shrinks as the window slides.
    clock.advance(11_000) // t = 41 s
    const stillRefused = limiter.check('203.0.113.7')
    expect(stillRefused.allowed).toBe(false)
    expect(stillRefused.retryAfterSec).toBe(20)

    // t = 61 s: the t=1 s hit has expired, so exactly ONE slot came back — not thirty.
    clock.advance(20_000)
    expect(limiter.check('203.0.113.7').allowed).toBe(true)
    expect(limiter.check('203.0.113.7').allowed).toBe(false)
  })

  it('expires thirty simultaneous hits together, because they happened together', () => {
    // The complement of the test above, and worth pinning so the sliding behaviour is not mistaken for a bug:
    // hits recorded at the same instant share a window, so they leave together. A limiter that dribbled them
    // out one per call would be *stricter* than sliding and would throttle a client who behaved.
    const clock = clockAt()
    const limiter = createPublicRateLimiter({ nowMs: clock.nowMs })
    for (let i = 0; i < 30; i++) expect(limiter.check('203.0.113.7').allowed).toBe(true)
    expect(limiter.check('203.0.113.7').allowed).toBe(false)
    clock.advance(MINUTE + 1)
    expect(limiter.check('203.0.113.7').allowed).toBe(true)
    for (let i = 0; i < 29; i++) expect(limiter.check('203.0.113.7').allowed).toBe(true)
    expect(limiter.check('203.0.113.7').allowed).toBe(false)
  })

  it('does not record a refused request, so hammering does not push your own window out', () => {
    // A limiter that counted rejections would let an over-budget client stay over budget indefinitely, and
    // a burst of retries would then lock out a client who had behaved.
    const clock = clockAt()
    const limiter = createPublicRateLimiter({ limit: 3, nowMs: clock.nowMs })

    for (let i = 0; i < 3; i++) expect(limiter.check('203.0.113.7').allowed).toBe(true)
    for (let i = 0; i < 50; i++) expect(limiter.check('203.0.113.7').allowed).toBe(false)

    clock.advance(MINUTE + 1)
    // Exactly three, not thirty: the fifty refusals were never recorded, so the window opens with a full
    // budget rather than a negative one. A limiter that counted rejections would leave the client over
    // budget forever, which is how a rate limiter becomes a way to lock a reader out permanently.
    expect(limiter.check('203.0.113.7').allowed).toBe(true)
    expect(limiter.check('203.0.113.7').allowed).toBe(true)
    expect(limiter.check('203.0.113.7').allowed).toBe(true)
    expect(limiter.check('203.0.113.7').allowed).toBe(false)
  })

  it('bills each IP separately', () => {
    const clock = clockAt()
    const limiter = createPublicRateLimiter({ limit: 2, nowMs: clock.nowMs })

    expect(limiter.check('203.0.113.1').allowed).toBe(true)
    expect(limiter.check('203.0.113.1').allowed).toBe(true)
    expect(limiter.check('203.0.113.1').allowed).toBe(false)

    // A different reader is unaffected. This is the property that makes the limit defensible rather than a
    // denial of service we inflict on a shared address.
    expect(limiter.check('203.0.113.2').allowed).toBe(true)
    expect(limiter.check('203.0.113.2').allowed).toBe(true)
    expect(limiter.check('203.0.113.2').allowed).toBe(false)
    // And the first reader is still refused.
    expect(limiter.check('203.0.113.1').allowed).toBe(false)
  })

  it('reports a retry-after that actually clears the oldest hit', () => {
    const clock = clockAt()
    const limiter = createPublicRateLimiter({ limit: 1, nowMs: clock.nowMs })

    expect(limiter.check('203.0.113.7').allowed).toBe(true)
    clock.advance(10_000)
    const refused = limiter.check('203.0.113.7')
    expect(refused.allowed).toBe(false)
    expect(refused.retryAfterSec).toBe(50)

    // Waiting exactly that long clears it. One second short does not.
    clock.advance(49_000)
    expect(limiter.check('203.0.113.7').allowed).toBe(false)
    clock.advance(1_000)
    expect(limiter.check('203.0.113.7').allowed).toBe(true)
  })

  it('can be reset, so an operator is not stuck behind a burst', () => {
    const clock = clockAt()
    const limiter = createPublicRateLimiter({ limit: 1, nowMs: clock.nowMs })
    expect(limiter.check('203.0.113.7').allowed).toBe(true)
    expect(limiter.check('203.0.113.7').allowed).toBe(false)
    limiter.reset()
    expect(limiter.trackedClients()).toBe(0)
    expect(limiter.check('203.0.113.7').allowed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Injectability, which is what makes the above testable at all
// ---------------------------------------------------------------------------

describe('the limiter is injectable in both directions', () => {
  it('takes its limit, window and clock as arguments, so a test never waits', () => {
    const clock = clockAt()
    const limiter = createPublicRateLimiter({ limit: 5, windowMs: 1_000, nowMs: clock.nowMs })
    for (let i = 0; i < 5; i++) expect(limiter.check('a').allowed).toBe(true)
    expect(limiter.check('a').allowed).toBe(false)
    clock.advance(1_001)
    expect(limiter.check('a').allowed).toBe(true)
  })

  it('defaults to §8.3 when given nothing but a clock', () => {
    const clock = clockAt()
    const limiter = createPublicRateLimiter({ nowMs: clock.nowMs })
    const first = limiter.check('203.0.113.7')
    expect(first.limit).toBe(30)
    expect(first.remaining).toBe(29)
  })

  it('bounds how many clients it remembers, because the map is keyed by a spoofable header', () => {
    // An unbounded map keyed by `X-Forwarded-For` is a memory-exhaustion vector, which would be a worse
    // outcome than a slightly loose limit. `maxClients` is the cap; the eviction order only decides who is
    // remembered, never who is over budget.
    const clock = clockAt()
    const limiter = createPublicRateLimiter({ limit: 1, nowMs: clock.nowMs, maxClients: 10 })
    for (let i = 0; i < 500; i++) limiter.check(`10.0.0.${i % 256}`)
    expect(limiter.trackedClients()).toBeLessThanOrEqual(10)
  })
})

// ---------------------------------------------------------------------------
// Which IP is billed
// ---------------------------------------------------------------------------

describe('clientIdFromHeaders', () => {
  /**
   * A `Headers`-shaped stub.
   *
   * **Case-insensitive, like the real thing.** An earlier version lowercased the *lookup* name but not the
   * *map* keys, so `get('x-forwarded-for')` against `{'X-Forwarded-For': …}` returned `null` — and the
   * "case-insensitive" test passed for the wrong reason while a real deployment behind a proxy that spells
   * the header in mixed case would have billed every request to the shared `unknown` bucket. The failure is
   * silent and looks like a rate limit that applies to everyone.
   */
  const headers = (map: Record<string, string>) => {
    const normalised = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]))
    return { get: (name: string) => normalised.get(name.toLowerCase()) ?? null }
  }

  it('takes the FIRST X-Forwarded-For hop, so a forged suffix cannot mint a new budget', () => {
    // `apps/vi`'s `client_id_for` applies the same rule. Only the first hop is the original client; a
    // caller who appended hops would otherwise get a fresh budget per append.
    expect(
      clientIdFromHeaders(
        headers({ 'x-forwarded-for': '203.0.113.7, 70.41.3.18, 150.172.238.178' }),
      ),
    ).toBe('203.0.113.7')
  })

  it('skips an empty first hop, because some proxies prepend one', () => {
    expect(clientIdFromHeaders(headers({ 'x-forwarded-for': '  , 203.0.113.7' }))).toBe(
      '203.0.113.7',
    )
  })

  it('falls back to X-Real-IP, then to a shared bucket', () => {
    expect(clientIdFromHeaders(headers({ 'x-real-ip': '203.0.113.9' }))).toBe('203.0.113.9')
    // 'unknown' is a shared bucket rather than no bucket: we cannot attribute the request, so we cannot give
    // it a private budget, and pretending otherwise would be a limit we do not enforce.
    expect(clientIdFromHeaders(headers({}))).toBe('unknown')
    expect(clientIdFromHeaders(headers({ 'x-forwarded-for': '   ' }))).toBe('unknown')
  })

  it('is case-insensitive on the header name, because proxies are not consistent', () => {
    expect(clientIdFromHeaders(headers({ 'X-Forwarded-For': '203.0.113.7' }))).toBe('203.0.113.7')
  })
})

// ---------------------------------------------------------------------------
// The error
// ---------------------------------------------------------------------------

describe('the 429 body', () => {
  it('uses CS_RATE_LIMITED, not PP_RATE_LIMITED', () => {
    // D-007. `PP_RATE_LIMITED` means *PayPal* is throttling us and its buyer-facing copy says exactly that,
    // which would be a lie here: the constraint is ours.
    const limiter = createPublicRateLimiter({ limit: 1, nowMs: clockAt().nowMs })
    limiter.check('203.0.113.7')
    const error = rateLimitError(limiter.check('203.0.113.7'), 'POST /v1/public/verify')
    expect(error.code).toBe('CS_RATE_LIMITED')
    expect(error.retryable).toBe(true)
    expect(formatError(error)).toMatch(/^CS_RATE_LIMITED: /)
  })

  it('names the route, the budget and the wait, so a client can act without reading our source', () => {
    const limiter = createPublicRateLimiter({ limit: 1, nowMs: clockAt().nowMs })
    limiter.check('203.0.113.7')
    const error = rateLimitError(limiter.check('203.0.113.7'), 'POST /v1/public/verify')
    expect(error.message).toContain('POST /v1/public/verify')
    expect(error.message).toContain('1 requests per 60s per IP')
    expect(error.message).toMatch(/Try again in \d+s/)
    expect(error.details).toMatchObject({ limit: 1, window_seconds: 60 })
  })

  it('tells the reader to wait rather than blaming them, and says nothing internal', () => {
    const limiter = createPublicRateLimiter({ limit: 1, nowMs: clockAt().nowMs })
    limiter.check('203.0.113.7')
    const error = rateLimitError(limiter.check('203.0.113.7'), 'POST /v1/public/verify')
    expect(error.userMessage).toMatch(/wait a moment/i)
    expect(error.userMessage).not.toMatch(/203\.0\.113/)
  })
})
