/**
 * AT-M6.3 and the retry arithmetic behind it — spec §8.6 "Retries", [B15], EC-PP-2.
 *
 * The `Retry-After: 2 → wait ≥ 2 s` assertion that belongs to the client lives in
 * `client.retry.test.ts`, because it needs a fake `fetch`. What is tested here is the formula itself,
 * with the randomness pinned so a delay is a number rather than a range.
 */
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_BACKOFF,
  MAX_RETRY_AFTER_MS,
  backoffCeilingMs,
  fullJitterDelayMs,
  nextDelayMs,
  parseRetryAfter,
  realSleep,
  retriesExhausted,
} from '../src/backoff'

const NOW_MS = 1_760_000_000_000

describe('backoffCeilingMs', () => {
  it('is the spec curve: base 500 ms, factor 2, capped at 20 s', () => {
    expect(DEFAULT_BACKOFF).toEqual({ baseMs: 500, factor: 2, capMs: 20_000, maxAttempts: 4 })
    expect(backoffCeilingMs(1)).toBe(500)
    expect(backoffCeilingMs(2)).toBe(1_000)
    expect(backoffCeilingMs(3)).toBe(2_000)
    expect(backoffCeilingMs(4)).toBe(4_000)
    // Beyond the cap: 8 000, 16 000, then clamped at 20 000.
    expect(backoffCeilingMs(5)).toBe(8_000)
    expect(backoffCeilingMs(6)).toBe(16_000)
    expect(backoffCeilingMs(7)).toBe(20_000)
    expect(backoffCeilingMs(50)).toBe(20_000)
  })

  it('returns 0 before the first attempt', () => {
    expect(backoffCeilingMs(0)).toBe(0)
    expect(backoffCeilingMs(-1)).toBe(0)
  })
})

describe('fullJitterDelayMs', () => {
  it('is uniform in [0, ceiling] — the full-jitter definition', () => {
    // Equal jitter would give `ceiling/2 + r*ceiling/2`, i.e. 250 here. Full jitter gives 0.
    expect(fullJitterDelayMs(1, DEFAULT_BACKOFF, () => 0)).toBe(0)
    // And it approaches the ceiling but never exceeds it.
    expect(fullJitterDelayMs(1, DEFAULT_BACKOFF, () => 0.999_999_999)).toBe(499)
    expect(fullJitterDelayMs(3, DEFAULT_BACKOFF, () => 0.5)).toBe(1_000)
  })

  it('spreads concurrent workers over the whole window (the reason for full jitter)', () => {
    const samples = Array.from({ length: 200 }, (_v, i) =>
      fullJitterDelayMs(1, DEFAULT_BACKOFF, () => (i * 37 % 100) / 100),
    )
    const distinct = new Set(samples)
    // 20 workers colliding on one retry is what turns a PayPal blip into a self-inflicted outage.
    expect(distinct.size).toBeGreaterThan(10)
    expect(Math.max(...samples)).toBeLessThanOrEqual(500)
  })

  it('clamps a misbehaving random()', () => {
    expect(fullJitterDelayMs(2, DEFAULT_BACKOFF, () => 5)).toBeLessThanOrEqual(1_000)
    expect(fullJitterDelayMs(2, DEFAULT_BACKOFF, () => -3)).toBe(0)
  })
})

describe('parseRetryAfter', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfter('2', NOW_MS)).toBe(2_000)
    expect(parseRetryAfter('0', NOW_MS)).toBe(0)
    expect(parseRetryAfter('  7  ', NOW_MS)).toBe(7_000)
  })

  it('reads an HTTP-date relative to the injected clock', () => {
    // 2026-10-04T12:00:00Z + 90 s. The date is parsed with Date.parse and differenced against the
    // clock we were handed — never Date.now().
    const later = new Date(NOW_MS + 90_000).toUTCString()
    expect(parseRetryAfter(later, NOW_MS)).toBe(90_000)
  })

  it('returns 0 for a date already in the past rather than a negative delay', () => {
    const earlier = new Date(NOW_MS - 5_000).toUTCString()
    expect(parseRetryAfter(earlier, NOW_MS)).toBe(0)
  })

  it('returns null for absent or malformed values so the caller falls back to jitter', () => {
    expect(parseRetryAfter(undefined, NOW_MS)).toBeNull()
    expect(parseRetryAfter(null, NOW_MS)).toBeNull()
    expect(parseRetryAfter('', NOW_MS)).toBeNull()
    expect(parseRetryAfter('soon', NOW_MS)).toBeNull()
    expect(parseRetryAfter('-5', NOW_MS)).toBeNull()
  })

  it('refuses an absurd value instead of hanging a worker for an hour', () => {
    expect(parseRetryAfter(String(MAX_RETRY_AFTER_MS / 1000 + 1), NOW_MS)).toBeNull()
    expect(parseRetryAfter(String(MAX_RETRY_AFTER_MS / 1000), NOW_MS)).toBe(MAX_RETRY_AFTER_MS)
  })
})

describe('nextDelayMs', () => {
  it('uses the jittered value when PayPal sent no Retry-After', () => {
    expect(nextDelayMs({ attempt: 1, retryAfterMs: null, random: () => 0.5 })).toBe(250)
  })

  it('treats Retry-After as a floor, never a suggestion (AT-M6.3)', () => {
    // The jitter drew 3 ms; `Retry-After: 2` must still win, because PayPal told us exactly how long
    // it needs and a lucky `random()` is not permission to ignore that.
    expect(nextDelayMs({ attempt: 1, retryAfterMs: 2_000, random: () => 0.006 })).toBe(2_000)
    // Same floor when the jitter draws close to its ceiling: 1 980 ms is still raised to 2 000.
    expect(nextDelayMs({ attempt: 1, retryAfterMs: 2_000, random: () => 0.99 })).toBe(2_000)
    // A jitter above the header is not shortened by it: attempt 6 has a 16 s ceiling.
    expect(nextDelayMs({ attempt: 6, retryAfterMs: 2_000, random: () => 0.9 })).toBe(14_400)
  })
})

describe('realSleep', () => {
  it('resolves immediately for a non-positive or non-finite delay', async () => {
    await expect(realSleep(0)).resolves.toBeUndefined()
    await expect(realSleep(-5)).resolves.toBeUndefined()
    await expect(realSleep(Number.NaN)).resolves.toBeUndefined()
  })
})

describe('retriesExhausted', () => {
  it('keeps the underlying code so the caller can still branch on it', () => {
    const e = retriesExhausted({
      attempts: 4,
      lastCode: 'PP_UNAVAILABLE',
      lastMessage: 'upstream is down',
      debugId: 'DEBUG-1',
      requestId: 'cs:att_1:create',
      method: 'POST',
      path: '/v2/checkout/orders',
    })
    expect(e.code).toBe('PP_UNAVAILABLE')
    expect(e.retryable).toBe(true)
    expect(e.details?.['attempts']).toBe(4)
    expect(e.details?.['paypal_debug_id']).toBe('DEBUG-1')
    expect(e.message).toContain('POST /v2/checkout/orders failed after 4 attempts')
  })

  it('does not claim retryability for a non-retryable code', () => {
    const e = retriesExhausted({
      attempts: 4,
      lastCode: 'PP_UNPROCESSABLE',
      lastMessage: 'bad amount',
      method: 'POST',
      path: '/v2/checkout/orders',
    })
    expect(e.retryable).toBe(false)
  })
})