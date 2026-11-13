/**
 * Live database tests for `login_attempts` repository.
 *
 * Verifies the atomic Postgres rate limiter against a real database:
 *  - 5 attempts allowed per window, 6th blocked
 *  - Blocked calls do not extend the window or increment count
 *  - Window expiry resets the bucket
 *  - Keys are independent
 *  - 20 concurrent calls yield exactly 5 allowed
 *  - Pruning removes only expired rows
 */
import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'

import { closeDb, db } from '../src/client'
import {
  consumeLoginAttempt,
  pruneExpiredLoginAttempts,
  resetLoginAttempts,
} from '../src/repos/login-attempts'
import { loginAttempts } from '../src/schema'

const hasDatabase = (process.env['DATABASE_URL'] ?? '').trim() !== ''

const TEST_KEY_PREFIX = 'rate-limit-live-test-'
const KEY_1 = `${TEST_KEY_PREFIX}1`
const KEY_2 = `${TEST_KEY_PREFIX}2`
const CONCURRENT_KEY = `${TEST_KEY_PREFIX}concurrent`
const PRUNE_EXPIRED_KEY = `${TEST_KEY_PREFIX}prune-expired`
const PRUNE_ACTIVE_KEY = `${TEST_KEY_PREFIX}prune-active`

const ALL_KEYS = [KEY_1, KEY_2, CONCURRENT_KEY, PRUNE_EXPIRED_KEY, PRUNE_ACTIVE_KEY]

afterAll(async () => {
  if (!hasDatabase) return
  for (const k of ALL_KEYS) {
    await resetLoginAttempts(db(), k)
  }
  await closeDb()
})

describe.skipIf(!hasDatabase)(
  'the login_attempts repository backs atomic rate limiting (live database)',
  () => {
    const LIMIT = 5
    const WINDOW_MS = 15 * 60 * 1000 // 15 minutes

    it('allows first 5 attempts then blocks the 6th with retryAfterSec > 0', async () => {
      await resetLoginAttempts(db(), KEY_1)
      const baseNow = 1_700_000_000_000

      for (let i = 1; i <= 5; i++) {
        const verdict = await consumeLoginAttempt(db(), KEY_1, baseNow + i * 1000, LIMIT, WINDOW_MS)
        expect(verdict.allowed, `attempt ${i} should be allowed`).toBe(true)
        expect(verdict.retryAfterSec).toBe(0)
      }

      const blocked = await consumeLoginAttempt(db(), KEY_1, baseNow + 6000, LIMIT, WINDOW_MS)
      expect(blocked.allowed).toBe(false)
      expect(blocked.retryAfterSec).toBeGreaterThan(0)
      expect(blocked.retryAfterSec).toBeLessThanOrEqual(15 * 60)
    })

    it('does not extend the window on blocked calls (count stays 5)', async () => {
      const baseNow = 1_700_000_000_000

      // Read current state from DB
      const rowsBefore = await db().select().from(loginAttempts).where(eq(loginAttempts.key, KEY_1))
      expect(rowsBefore[0]?.count).toBe(5)
      const originalResetAt = rowsBefore[0]?.reset_at.getTime()

      // Call again 30 seconds later (still inside window)
      const blocked = await consumeLoginAttempt(db(), KEY_1, baseNow + 30_000, LIMIT, WINDOW_MS)
      expect(blocked.allowed).toBe(false)
      expect(blocked.retryAfterSec).toBeGreaterThan(0)

      // Count must still be 5 and reset_at must not have moved
      const rowsAfter = await db().select().from(loginAttempts).where(eq(loginAttempts.key, KEY_1))
      expect(rowsAfter[0]?.count).toBe(5)
      expect(rowsAfter[0]?.reset_at.getTime()).toBe(originalResetAt)
    })

    it('resets to allowed when window expires (nowMs past reset)', async () => {
      const baseNow = 1_700_000_000_000
      const expiredNow = baseNow + WINDOW_MS + 2000 // 2 seconds past window expiry

      const verdict = await consumeLoginAttempt(db(), KEY_1, expiredNow, LIMIT, WINDOW_MS)
      expect(verdict.allowed).toBe(true)
      expect(verdict.retryAfterSec).toBe(0)

      const rows = await db().select().from(loginAttempts).where(eq(loginAttempts.key, KEY_1))
      expect(rows[0]?.count).toBe(1)
      expect(rows[0]?.reset_at.getTime()).toBe(expiredNow + WINDOW_MS)
    })

    it('treats two different keys independently', async () => {
      await resetLoginAttempts(db(), KEY_1)
      await resetLoginAttempts(db(), KEY_2)
      const baseNow = 1_700_000_000_000

      // Exhaust KEY_1
      for (let i = 1; i <= 5; i++) {
        await consumeLoginAttempt(db(), KEY_1, baseNow + i * 1000, LIMIT, WINDOW_MS)
      }
      const blocked1 = await consumeLoginAttempt(db(), KEY_1, baseNow + 6000, LIMIT, WINDOW_MS)
      expect(blocked1.allowed).toBe(false)

      // KEY_2 must still be allowed
      const verdict2 = await consumeLoginAttempt(db(), KEY_2, baseNow + 7000, LIMIT, WINDOW_MS)
      expect(verdict2.allowed).toBe(true)
      expect(verdict2.retryAfterSec).toBe(0)
    })

    it('yields exactly 5 allowed from 20 concurrent calls with Promise.all on one key', async () => {
      await resetLoginAttempts(db(), CONCURRENT_KEY)
      const baseNow = 1_700_000_000_000

      const promises = Array.from({ length: 20 }, () =>
        consumeLoginAttempt(db(), CONCURRENT_KEY, baseNow, LIMIT, WINDOW_MS),
      )
      const results = await Promise.all(promises)

      const allowedCount = results.filter((r) => r.allowed).length
      const blockedCount = results.filter((r) => !r.allowed).length

      expect(allowedCount).toBe(5)
      expect(blockedCount).toBe(15)

      // All blocked calls should have retryAfterSec > 0
      for (const res of results.filter((r) => !r.allowed)) {
        expect(res.retryAfterSec).toBeGreaterThan(0)
      }

      // Final count in DB must be exactly 5
      const rows = await db()
        .select()
        .from(loginAttempts)
        .where(eq(loginAttempts.key, CONCURRENT_KEY))
      expect(rows[0]?.count).toBe(5)
    })

    it('prunes only expired rows', async () => {
      await resetLoginAttempts(db(), PRUNE_EXPIRED_KEY)
      await resetLoginAttempts(db(), PRUNE_ACTIVE_KEY)
      const baseNow = 1_700_000_000_000

      // Insert an expired row (reset_at in the past)
      await consumeLoginAttempt(
        db(),
        PRUNE_EXPIRED_KEY,
        baseNow - WINDOW_MS - 5000,
        LIMIT,
        WINDOW_MS,
      )

      // Insert an active row (reset_at in the future)
      await consumeLoginAttempt(db(), PRUNE_ACTIVE_KEY, baseNow, LIMIT, WINDOW_MS)

      // Both exist before prune
      const rowsBefore = await db().select().from(loginAttempts)
      const keysBefore = rowsBefore.map((r) => r.key)
      expect(keysBefore).toContain(PRUNE_EXPIRED_KEY)
      expect(keysBefore).toContain(PRUNE_ACTIVE_KEY)

      // Prune at baseNow
      const prunedCount = await pruneExpiredLoginAttempts(db(), baseNow)
      expect(prunedCount).toBeGreaterThanOrEqual(1)

      // Expired row gone, active row remains
      const expiredRow = await db()
        .select()
        .from(loginAttempts)
        .where(eq(loginAttempts.key, PRUNE_EXPIRED_KEY))
      expect(expiredRow).toHaveLength(0)

      const activeRow = await db()
        .select()
        .from(loginAttempts)
        .where(eq(loginAttempts.key, PRUNE_ACTIVE_KEY))
      expect(activeRow).toHaveLength(1)
      expect(activeRow[0]?.key).toBe(PRUNE_ACTIVE_KEY)
    })
  },
)
