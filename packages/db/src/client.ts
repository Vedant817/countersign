/**
 * The database connection — spec **§8.2 (M2)**, work package WP-02.
 *
 * Three properties this module exists to guarantee:
 *
 *  1. **Importing this file never connects.** Nothing is constructed at module scope, so a unit test
 *     (or `drizzle-kit generate`, or a CI job with no Postgres) can import the package, read the
 *     schema and mock a transaction handle without a `DATABASE_URL` and without a socket.
 *  2. **A missing `DATABASE_URL` fails with a `CsError`, not a Postgres error.** Spec §6 says the
 *     process "MUST refuse to start if any required variable is missing", and AGENTS.md rule 3 says
 *     a module boundary never throws a raw error. `db()` therefore throws a typed
 *     `CS_VALIDATION` whose `userMessage` says the server is misconfigured, not that a payment
 *     failed.
 *  3. **One connection pool per process, created on first use.** `postgres` in lazy mode does not
 *     open a socket until the first query, so even the first `db()` call is cheap and safe in a
 *     test that never actually queries.
 *
 * Every repository takes an optional executor. Pass the handle from {@link withTx} to compose
 * several repos in one transaction — spec §8.10 checks 8 and 9 (budget reserve + wallet cap) have
 * to be atomic, and §8.11 re-reads mandate status in the same transaction as order creation.
 */
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres, { type Sql } from 'postgres'

import { csError, toCsError, type CsError, type Result } from '@countersign/core'

import { schema } from './schema'

/** The Drizzle database handle for this package's schema. */
export type Db = ReturnType<typeof createDrizzle>

function createDrizzle(client: Sql) {
  return drizzle(client, { schema })
}

/**
 * A transaction handle. This is the `tx` every repository takes as its last parameter; it exposes
 * exactly the same query surface as {@link Db}, so a repo cannot tell (and must not care) which it
 * was handed.
 */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/**
 * Either the pool-backed handle or an open transaction. Repositories accept this rather than two
 * separate parameters, because "run this inside the caller's transaction" and "run this on its own"
 * are the same code with a different executor.
 */
export type Exec = Db | Tx

let client: Sql | null = null
let database: Db | null = null

/** The raw `postgres` client, for `close()` on shutdown. `null` until the first {@link db} call. */
function postgresClient(): Sql {
  if (client) return client
  const url = process.env['DATABASE_URL']
  if (url === undefined || url.trim() === '') {
    // No default, no fallback URL: connecting somewhere unintended is worse than not connecting.
    throw csError(
      'CS_VALIDATION',
      'DATABASE_URL is not set. packages/db cannot open a connection without it (spec §6).',
      { env: 'DATABASE_URL' },
      { userMessage: 'The server is misconfigured. Please tell the operator.' },
    )
  }
  // `prepare: false` is required on Render's connection pooler (it does not support the extended
  // query protocol) and is harmless elsewhere. `max: 5` keeps a web request plus a worker job from
  // opening more connections than the Starter Postgres plan allows.
  client = postgres(url, { prepare: false, max: 5, onnotice: () => {} })
  return client
}

/**
 * The process-wide Drizzle handle, created on first call.
 *
 * @throws `CsError` `CS_VALIDATION` when `DATABASE_URL` is unset. This is the only place in the
 * package that throws rather than returning a `Result`, because a missing environment variable is
 * a programmer/deployment error, not a business outcome — and it has to surface at boot
 * (spec §6), not at the first request a buyer is waiting on.
 */
export function db(): Db {
  if (database) return database
  database = createDrizzle(postgresClient())
  return database
}

/** `true` when a pool has been created. Lets a test assert it stayed lazy. */
export function isDbInitialised(): boolean {
  return database !== null
}

/**
 * Run `fn` inside a transaction and commit on success.
 *
 * The handle is passed in so callers can compose repositories atomically:
 *
 * ```ts
 * const r = await withTx(async (tx) => {
 *   const attempt = await attempts.create(input, tx)
 *   if (!attempt.ok) return attempt
 *   const budget = await budget.reserve(mandateId, attempt.value.id, amount, tx)
 *   if (!budget.ok) return budget
 *   return ok({ attempt: attempt.value, budget: budget.value })
 * })
 * ```
 *
 * Any throw inside `fn` rolls back and is converted to `CS_VALIDATION` via `toCsError`; a returned
 * `err(...)` is the caller's own decision and does **not** roll back on its own — call
 * {@link rollback} (or throw) when a partial result must not persist.
 *
 * @param fn receives the transaction handle; return a `Result` so a business failure is data, not
 * an exception.
 */
export async function withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<Result<T, CsError>> {
  try {
    const value = await db().transaction(async (tx) => fn(tx))
    return { ok: true, value }
  } catch (cause) {
    // Postgres raises `CsError`-shaped objects for nothing, so this is a plain unexpected failure.
    return { ok: false, error: toCsError(cause) }
  }
}

/**
 * Close the pool. Call it from a graceful-shutdown hook (`apps/worker`) so in-flight jobs finish and
 * the process does not hang on an open connection. Safe to call when nothing was ever opened.
 */
export async function closeDb(): Promise<void> {
  const c = client
  client = null
  database = null
  if (c) await c.end({ timeout: 5 })
}

/**
 * Drop the cached handle without closing the socket.
 *
 * Only for tests that swap `DATABASE_URL` between cases. Production code must use
 * {@link closeDb} — forgetting a pool leaks a connection per call.
 */
export function resetDbForTesting(): void {
  client = null
  database = null
}
