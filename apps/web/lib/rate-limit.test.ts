/**
 * The login rate limit — D-059.
 *
 * The properties that matter are the ones an attacker can test: the fifth attempt in a window is allowed
 * and the sixth is not, a blocked caller cannot extend their own block, the window expires on its own, and
 * the same address with a different email is a different budget (so one victim cannot be used to lock out
 * another). Time is injected, because a test that sleeps fifteen minutes is a test nobody runs.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  LOGIN_ATTEMPTS_PER_WINDOW,
  LOGIN_WINDOW_MS,
  checkLoginRateLimit,
  loginRateLimitKey,
  resetLoginRateLimit,
} from './rate-limit'

const KEY = loginRateLimitKey('Merchant@Example.test', '203.0.113.7')

beforeEach(() => {
  resetLoginRateLimit()
})

describe('the login rate limit', () => {
  it('allows exactly the budget, then refuses', () => {
    const now = 1_000_000
    for (let attempt = 1; attempt <= LOGIN_ATTEMPTS_PER_WINDOW; attempt += 1) {
      expect(checkLoginRateLimit(KEY, now).allowed, `attempt ${attempt}`).toBe(true)
    }
    const blocked = checkLoginRateLimit(KEY, now)
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterSec).toBeGreaterThan(0)
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(LOGIN_WINDOW_MS / 1000)
  })

  it('does not extend the block when a blocked caller keeps knocking', () => {
    const now = 2_000_000
    for (let attempt = 1; attempt <= LOGIN_ATTEMPTS_PER_WINDOW; attempt += 1) {
      checkLoginRateLimit(KEY, now)
    }
    const first = checkLoginRateLimit(KEY, now)
    const later = checkLoginRateLimit(KEY, now + 60_000)
    expect(first.allowed).toBe(false)
    expect(later.allowed).toBe(false)
    // The reset instant is fixed by the first attempt in the window, not pushed back by the retries.
    expect(later.retryAfterSec).toBe(first.retryAfterSec - 60)
  })

  it('opens a new window once the old one has elapsed', () => {
    const now = 3_000_000
    for (let attempt = 1; attempt <= LOGIN_ATTEMPTS_PER_WINDOW; attempt += 1) {
      checkLoginRateLimit(KEY, now)
    }
    expect(checkLoginRateLimit(KEY, now + LOGIN_WINDOW_MS).allowed).toBe(true)
  })

  it('keys on both the address and the email', () => {
    const now = 4_000_000
    for (let attempt = 1; attempt <= LOGIN_ATTEMPTS_PER_WINDOW; attempt += 1) {
      checkLoginRateLimit(KEY, now)
    }
    const otherEmail = checkLoginRateLimit(
      loginRateLimitKey('buyer@example.test', '203.0.113.7'),
      now,
    )
    const otherAddress = checkLoginRateLimit(
      loginRateLimitKey('merchant@example.test', '198.51.100.2'),
      now,
    )
    expect(otherEmail.allowed).toBe(true)
    expect(otherAddress.allowed).toBe(true)
  })

  it('treats an email case and surrounding space as one account', () => {
    expect(loginRateLimitKey('  Merchant@Example.test ', '1.2.3.4')).toBe(
      loginRateLimitKey('merchant@example.test', '1.2.3.4'),
    )
  })
})
