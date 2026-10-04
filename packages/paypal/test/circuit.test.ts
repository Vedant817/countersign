/**
 * Circuit breaker — spec §8.6 "Circuit breaker", EC-PP-1, AT-M6 family.
 *
 * Every timing assertion uses the injected clock, never `Date.now()`: an open breaker with a 30 s
 * window is exactly the thing a real clock cannot test deterministically.
 */
import { describe, expect, it } from 'vitest'

import { BREAKER_OPEN_MS, BREAKER_THRESHOLD, CircuitBreaker, breakerKey } from '../src/circuit'
import { testClock } from './fixtures/transport-double'

function makeBreaker(overrides: { threshold?: number; openMs?: number } = {}) {
  const clock = testClock()
  const breaker = new CircuitBreaker({
    clock,
    ...(overrides.threshold !== undefined ? { threshold: overrides.threshold } : {}),
    ...(overrides.openMs !== undefined ? { openMs: overrides.openMs } : {}),
  })
  return { breaker, clock }
}

describe('CircuitBreaker (EC-PP-1)', () => {
  it('uses the spec thresholds: 5 consecutive unavailable, 30 s open', () => {
    expect(BREAKER_THRESHOLD).toBe(5)
    expect(BREAKER_OPEN_MS).toBe(30_000)
  })

  it('stays closed until the fifth consecutive PP_UNAVAILABLE', () => {
    const { breaker } = makeBreaker()
    for (let i = 0; i < 4; i++) {
      expect(breaker.preflight('api-m.sandbox.paypal.com').ok).toBe(true)
      breaker.recordUnavailable('api-m.sandbox.paypal.com')
      expect(breaker.state('api-m.sandbox.paypal.com')).toBe('closed')
    }
    expect(breaker.consecutiveUnavailable('api-m.sandbox.paypal.com')).toBe(4)

    expect(breaker.preflight('api-m.sandbox.paypal.com').ok).toBe(true)
    breaker.recordUnavailable('api-m.sandbox.paypal.com')
    expect(breaker.state('api-m.sandbox.paypal.com')).toBe('open')
  })

  it('fails fast with retryable:true while open', () => {
    const { breaker } = makeBreaker()
    for (let i = 0; i < 5; i++) breaker.recordUnavailable('api-m.sandbox.paypal.com')

    const gate = breaker.preflight('api-m.sandbox.paypal.com')
    expect(gate.ok).toBe(false)
    if (gate.ok) throw new Error('unreachable')
    // retryable:true is what makes the pg-boss queue retry these (EC-PP-1's "we'll retry for 15 min").
    expect(gate.error.code).toBe('PP_UNAVAILABLE')
    expect(gate.error.retryable).toBe(true)
    expect(gate.error.details?.['host']).toBe('api-m.sandbox.paypal.com')
    expect(gate.error.details?.['opens_at_ms']).toBeGreaterThan(0)
  })

  it('does not reset the counter on repeated fast-fails', () => {
    const { breaker } = makeBreaker()
    for (let i = 0; i < 5; i++) breaker.recordUnavailable('api-m.sandbox.paypal.com')
    for (let i = 0; i < 10; i++)
      expect(breaker.preflight('api-m.sandbox.paypal.com').ok).toBe(false)
  })

  it('resets the counter on any reachable outcome — consecutive, not cumulative', () => {
    const { breaker } = makeBreaker()
    for (let i = 0; i < 4; i++) breaker.recordUnavailable('host')
    // A 422 proves the host is answering, so the next outage starts from zero. A cumulative counter
    // would open on a healthy host after enough bad *requests* — our bug, not PayPal's.
    breaker.recordReachable('host')
    expect(breaker.consecutiveUnavailable('host')).toBe(0)
    for (let i = 0; i < 4; i++) breaker.recordUnavailable('host')
    expect(breaker.state('host')).toBe('closed')
  })

  it('treats a success as reachable', () => {
    const { breaker } = makeBreaker()
    for (let i = 0; i < 4; i++) breaker.recordUnavailable('host')
    breaker.recordSuccess('host')
    expect(breaker.state('host')).toBe('closed')
    expect(breaker.consecutiveUnavailable('host')).toBe(0)
  })

  it('opens for exactly 30 s, then goes half-open', () => {
    const { breaker, clock } = makeBreaker()
    for (let i = 0; i < 5; i++) breaker.recordUnavailable('host')

    // `advance` takes seconds; 29 s in, the breaker is still open.
    clock.advance(29)
    expect(breaker.preflight('host').ok).toBe(false)

    clock.advance(1)
    expect(breaker.state('host')).toBe('open')
    // The preflight at the boundary is what promotes it; that call is the probe.
    expect(breaker.preflight('host').ok).toBe(true)
    expect(breaker.state('host')).toBe('half-open')
  })

  it('admits exactly one probe in half-open — twenty workers must not all become the probe', () => {
    const { breaker, clock } = makeBreaker()
    for (let i = 0; i < 5; i++) breaker.recordUnavailable('host')
    clock.advance(BREAKER_OPEN_MS / 1000)

    expect(breaker.preflight('host').ok).toBe(true)
    for (let i = 0; i < 19; i++) expect(breaker.preflight('host').ok).toBe(false)
  })

  it('closes when the probe succeeds', () => {
    const { breaker, clock } = makeBreaker()
    for (let i = 0; i < 5; i++) breaker.recordUnavailable('host')
    clock.advance(BREAKER_OPEN_MS / 1000)
    expect(breaker.preflight('host').ok).toBe(true)

    breaker.recordReachable('host')
    expect(breaker.state('host')).toBe('closed')
    expect(breaker.preflight('host').ok).toBe(true)
  })

  it('re-opens for another full window when the probe fails', () => {
    const { breaker, clock } = makeBreaker()
    for (let i = 0; i < 5; i++) breaker.recordUnavailable('host')
    clock.advance(BREAKER_OPEN_MS / 1000)
    expect(breaker.preflight('host').ok).toBe(true)

    breaker.recordUnavailable('host')
    expect(breaker.state('host')).toBe('open')
    clock.advance(BREAKER_OPEN_MS / 1000 - 1)
    expect(breaker.preflight('host').ok).toBe(false)
    clock.advance(1)
    expect(breaker.preflight('host').ok).toBe(true)
  })

  it('keys on the hostname, so two hosts have independent budgets', () => {
    const { breaker } = makeBreaker()
    for (let i = 0; i < 5; i++) breaker.recordUnavailable('api-m.sandbox.paypal.com')
    expect(breaker.state('api-m.sandbox.paypal.com')).toBe('open')
    expect(breaker.state('api.paypal.com')).toBe('closed')
    expect(breaker.preflight('api.paypal.com').ok).toBe(true)
  })

  it('is resettable — tests and an operator need a way out', () => {
    const { breaker } = makeBreaker()
    for (let i = 0; i < 5; i++) breaker.recordUnavailable('host')
    expect(breaker.state('host')).toBe('open')
    breaker.reset()
    expect(breaker.state('host')).toBe('closed')
    expect(breaker.consecutiveUnavailable('host')).toBe(0)
  })

  it('honours a custom threshold for a fast test without changing the default', () => {
    const { breaker } = makeBreaker({ threshold: 2, openMs: 5_000 })
    breaker.recordUnavailable('host')
    expect(breaker.state('host')).toBe('closed')
    breaker.recordUnavailable('host')
    expect(breaker.state('host')).toBe('open')
  })
})

describe('breakerKey', () => {
  it('reduces a base URL to its hostname so a trailing slash is not a new circuit', () => {
    expect(breakerKey('https://api-m.sandbox.paypal.com')).toBe('api-m.sandbox.paypal.com')
    expect(breakerKey('https://api-m.sandbox.paypal.com/')).toBe('api-m.sandbox.paypal.com')
    expect(breakerKey('http://127.0.0.1:8787/paypal/')).toBe('127.0.0.1')
  })

  it('falls back to the raw string when the URL will not parse', () => {
    expect(breakerKey('not a url')).toBe('not a url')
  })
})
