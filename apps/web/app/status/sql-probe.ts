/**
 * `SELECT 1`, for `/status`'s Postgres probe.
 *
 * ## Why a file of its own
 *
 * Because `probe.ts` must not import `@countersign/db` at module scope: it takes its store reads as
 * arguments so a test can drive it with no database. A `SELECT 1` needs Drizzle's `sql` helper, which means
 * importing `drizzle-orm` from `apps/web` — so the import lives here and is **dynamic**, reached only when the
 * probe actually runs.
 *
 * It is deliberately its own module rather than a `db()` call inline: `db()` throws when `DATABASE_URL` is
 * unset, and `/status` has to be able to *report* an unset `DATABASE_URL` rather than crash on it. That is
 * why the configured-check lives in `probe.ts` and this function is only reached once it has passed.
 */
import { sql } from 'drizzle-orm'

import { db } from '@countersign/db'

/**
 * Run `SELECT 1` and return the row's single integer.
 *
 * @returns `1` when the connection, the credentials and the network path all work.
 * @throws the `CsError` `db()` raises when `DATABASE_URL` is unset, or the driver's error otherwise. Both are
 *   caught by `probe.ts`'s `timed`, which turns them into `down` plus one sentence.
 */
export async function sqlProbe(): Promise<number> {
  const rows = await db().execute<{ one: number }>(sql`select 1 as one`)
  const first = rows[0] as { one?: unknown } | undefined
  return Number(first?.one)
}
