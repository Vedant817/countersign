/**
 * The login rate limit — D-059.
 *
 * The properties that matter are the ones an attacker can test: the fifth attempt in a window is allowed
 * and the sixth is not, a blocked caller cannot extend their own block, the window expires on its own, and
 * the same address with a different email is a different budget (so one victim cannot be used to lock out
 * another). Time is injected, because a test that sleeps fifteen minutes is a test nobody runs.
 */
import { afterAll, describe, expect, it } from 'vitest'

import { closeDb } from '@countersign/db'

import {
  LOGIN_ATTEMPTS_PER_WINDOW,
  LOGIN_WINDOW_MS,
  checkLoginRateLimit,
  loginRateLimitKey,
  resetLoginRateLimit,
} from './rate-limit'

const hasDatabase = (process.env['DATABASE_URL'] ?? '').trim() !== ''

const trackedKeys: string[] = []
const RUN_ID = Math.random().toString(36).slice(2, 8)

function uniqueKey(email: string, address: string): string {
  const key = loginRateLimitKey(`${RUN_ID}-${email}`, address)
  trackedKeys.push(key)
  return key
}

afterAll(async () => {
  if (!hasDatabase) return
  for (const key of trackedKeys) {
    await resetLoginRateLimit(key)
  }
  await closeDb()
})

describe('loginRateLimitKey', () => {
  it('treats an email case and surrounding space as one account', () => {
    expect(loginRateLimitKey('  Merchant@Example.test ', '1.2.3.4')).toBe(
      loginRateLimitKey('merchant@example.test', '1.2.3.4'),
    )
  })
})

describe.skipIf(!hasDatabase)('the login rate limit (live database)', () => {
  it('allows exactly the budget, then refuses', async () => {
    const key = uniqueKey('Merchant@Example.test', '203.0.113.7')
    const now = 1_000_000
    for (let attempt = 1; attempt <= LOGIN_ATTEMPTS_PER_WINDOW; attempt += 1) {
      const verdict = await checkLoginRateLimit(key, now)
      expect(verdict.allowed, `attempt ${attempt}`).toBe(true)
    }
    const blocked = await checkLoginRateLimit(key, now)
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterSec).toBeGreaterThan(0)
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(LOGIN_WINDOW_MS / 1000)
  })

  it('does not extend the block when a blocked caller keeps knocking', async () => {
    const key = uniqueKey('Merchant@Example.test', '203.0.113.8')
    const now = 2_000_000
    for (let attempt = 1; attempt <= LOGIN_ATTEMPTS_PER_WINDOW; attempt += 1) {
      await checkLoginRateLimit(key, now)
    }
    const first = await checkLoginRateLimit(key, now)
    const later = await checkLoginRateLimit(key, now + 60_000)
    expect(first.allowed).toBe(false)
    expect(later.allowed).toBe(false)
    // The reset instant is fixed by the first attempt in the window, not pushed back by the retries.
    expect(later.retryAfterSec).toBe(first.retryAfterSec - 60)
  })

  it('opens a new window once the old one has elapsed', async () => {
    const key = uniqueKey('Merchant@Example.test', '203.0.113.9')
    const now = 3_000_000
    for (let attempt = 1; attempt <= LOGIN_ATTEMPTS_PER_WINDOW; attempt += 1) {
      await checkLoginRateLimit(key, now)
    }
    const verdict = await checkLoginRateLimit(key, now + LOGIN_WINDOW_MS)
    expect(verdict.allowed).toBe(true)
  })

  it('keys on both the address and the email', async () => {
    const key = uniqueKey('Merchant@Example.test', '203.0.113.10')
    const otherEmailKey = uniqueKey('buyer@example.test', '203.0.113.10')
    const otherAddressKey = uniqueKey('Merchant@Example.test', '198.51.100.2')
    const now = 4_000_000
    for (let attempt = 1; attempt <= LOGIN_ATTEMPTS_PER_WINDOW; attempt += 1) {
      await checkLoginRateLimit(key, now)
    }
    const otherEmail = await checkLoginRateLimit(otherEmailKey, now)
    const otherAddress = await checkLoginRateLimit(otherAddressKey, now)
    expect(otherEmail.allowed).toBe(true)
    expect(otherAddress.allowed).toBe(true)
  })

  it('shares budget across different email casing (key is lower-cased)', async () => {
    const keyUpper = uniqueKey('CasedMerchant@Example.test', '203.0.113.11')
    const keyLower = uniqueKey('casedmerchant@example.test', '203.0.113.11')
    expect(keyUpper).toBe(keyLower)
    const now = 5_000_000
    for (let attempt = 1; attempt <= LOGIN_ATTEMPTS_PER_WINDOW; attempt += 1) {
      const verdict = await checkLoginRateLimit(keyUpper, now)
      expect(verdict.allowed, `attempt ${attempt}`).toBe(true)
    }
    const blocked = await checkLoginRateLimit(keyLower, now)
    expect(blocked.allowed).toBe(false)
  })
})
