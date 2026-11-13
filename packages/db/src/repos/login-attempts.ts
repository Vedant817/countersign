/**
 * `login_attempts` repository — Postgres-backed login rate limiting (D-059).
 *
 * Coordinates login attempts across replicas and survives service restarts.
 * Fixed window: `limit` attempts per `windowMs` per key.
 */
import { eq, lte, sql } from 'drizzle-orm'

import type { Exec } from '../client'
import { loginAttempts } from '../schema'

export interface LoginAttemptVerdict {
  readonly allowed: boolean
  readonly retryAfterSec: number
}

/**
 * Spend one login attempt under an atomic fixed-window rate limiter.
 *
 * ONE atomic SQL statement (INSERT ... ON CONFLICT (key) DO UPDATE) that:
 *  - resets count to 1 and reset_at to now+window if the row's reset_at <= now
 *  - otherwise increments count only if count < limit
 *  - returns count and reset_at
 *
 * If the attempt was not counted (count already at limit and window still open),
 * returns allowed: false with retryAfterSec = max(1, ceil((reset_at - now)/1000)).
 * Otherwise returns allowed: true, retryAfterSec: 0.
 * A blocked call does NOT increment count or extend the window.
 */
export async function consumeLoginAttempt(
  db: Exec,
  key: string,
  nowMs: number,
  limit: number,
  windowMs: number,
): Promise<{ allowed: boolean; retryAfterSec: number }> {
  const nowIso = new Date(nowMs).toISOString()
  const resetAtIso = new Date(nowMs + windowMs).toISOString()

  const query = sql`
    WITH upsert AS (
      INSERT INTO ${loginAttempts} ("key", "count", "reset_at")
      VALUES (${key}, 1, ${resetAtIso}::timestamptz)
      ON CONFLICT ("key") DO UPDATE
      SET
        count = CASE
          WHEN ${loginAttempts.reset_at} <= ${nowIso}::timestamptz THEN 1
          ELSE ${loginAttempts.count} + 1
        END,
        reset_at = CASE
          WHEN ${loginAttempts.reset_at} <= ${nowIso}::timestamptz THEN EXCLUDED.reset_at
          ELSE ${loginAttempts.reset_at}
        END
      WHERE ${loginAttempts.reset_at} <= ${nowIso}::timestamptz OR ${loginAttempts.count} < ${limit}
      RETURNING ${loginAttempts.count} AS count, ${loginAttempts.reset_at} AS reset_at, true AS allowed
    )
    SELECT count, reset_at, allowed FROM upsert
    UNION ALL
    SELECT ${loginAttempts.count} AS count, ${loginAttempts.reset_at} AS reset_at, false AS allowed
    FROM ${loginAttempts}
    WHERE ${loginAttempts.key} = ${key} AND NOT EXISTS (SELECT 1 FROM upsert)
  `

  const rows = await db.execute<{ count: number; reset_at: Date | string; allowed: boolean }>(query)
  const row = (
    rows as unknown as Array<{ count: number; reset_at: Date | string; allowed: boolean }>
  )[0]
  if (!row) {
    throw new Error(`consumeLoginAttempt failed to return a row for key: ${key}`)
  }

  if (row.allowed) {
    return { allowed: true, retryAfterSec: 0 }
  }

  const resetAtMs =
    row.reset_at instanceof Date ? row.reset_at.getTime() : new Date(row.reset_at).getTime()
  const retryAfterSec = Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000))
  return { allowed: false, retryAfterSec }
}

/** Reset login attempts for one key, or every key when none is given. */
export async function resetLoginAttempts(db: Exec, key?: string): Promise<void> {
  if (key !== undefined) {
    await db.delete(loginAttempts).where(eq(loginAttempts.key, key))
  } else {
    await db.delete(loginAttempts)
  }
}

/** Prune rows whose window expired (reset_at <= now). Returns the number of pruned rows. */
export async function pruneExpiredLoginAttempts(db: Exec, nowMs: number): Promise<number> {
  const deleted = await db
    .delete(loginAttempts)
    .where(lte(loginAttempts.reset_at, new Date(nowMs)))
    .returning({ key: loginAttempts.key })
  return deleted.length
}
