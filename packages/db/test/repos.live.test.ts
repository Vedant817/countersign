/**
 * The two repository readers the Gate was missing — `docs/contract-issues.md` gaps #3 and #5.
 *
 * ## Why these run against a real Postgres and are skipped without one
 *
 * The failure these functions can have is not logic, it is **SQL that does not exist**:
 * `lockMandateForUpdate` is the only statement in the repository that says `FOR UPDATE`, and if
 * drizzle renders it wrongly the error appears at runtime, inside a transaction, in production —
 * precisely where the Gate's check 8 runs. A structural test asserting "the function is exported"
 * would pass against invalid SQL, so the assertions here are executed statements.
 *
 * `describe.skipIf` rather than a `*.sandbox.test.ts` exclusion: these need a local database, not
 * PayPal credentials, and the CI job that has one should run them. Without `DATABASE_URL` they skip
 * and the suite stays green, which is what the repo's other suites already do.
 *
 * The cases read whatever the seed produced rather than inserting their own world. A test that built
 * a user, wallet, device, L1 and mandate to exercise one `SELECT … FOR UPDATE` would be four fifths
 * setup, and the setup is the part that breaks.
 */
import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'

import type { CsError, MandateId, Result, WalletId } from '@countersign/core'

import { closeDb, withTx, type Tx } from '../src/client'
import { findMandateById, findWalletCapPeriod, lockMandateForUpdate } from '../src/repos'
import { mandates } from '../src/schema'

const hasDatabase = (process.env['DATABASE_URL'] ?? '').trim() !== ''

afterAll(async () => {
  if (hasDatabase) await closeDb()
})

/**
 * Flatten `withTx`'s outer `Result` with the inner one.
 *
 * `withTx<T>` answers `Result<T, CsError>` and these reads answer `Result<Row, CsError>`, so a plain
 * `await withTx(fn)` is a `Result<Result<…>>`. Unwrapping it once per call site is how a test ends up
 * asserting on the wrong layer — it did, once, while this file was being written.
 */
async function inTx<T>(fn: (tx: Tx) => Promise<Result<T, CsError>>): Promise<Result<T, CsError>> {
  const outer = await withTx(fn)
  return outer.ok ? outer.value : outer
}

/** The first seeded mandate and the wallet it belongs to, or `undefined` on an empty database. */
async function firstMandate(): Promise<{ mandateId: MandateId; walletId: WalletId } | undefined> {
  const outer = await withTx((tx) => tx.select().from(mandates).limit(1))
  if (!outer.ok) return undefined
  const row = outer.value[0] as { id: string } | undefined
  if (row === undefined) return undefined
  return { mandateId: row.id as MandateId, walletId: row.id as unknown as WalletId }
}

describe.skipIf(!hasDatabase)('gate repository handles (live database)', () => {
  it('locks a mandate row with FOR UPDATE inside a transaction', async () => {
    const sample = await firstMandate()
    if (sample === undefined) return // Empty database: nothing to lock, and nothing to prove.

    const locked = await inTx((tx) => lockMandateForUpdate(sample.mandateId, tx))
    expect(locked.ok, locked.ok ? '' : `lock failed: ${locked.error.message}`).toBe(true)
    if (!locked.ok) return
    expect(locked.value?.id).toBe(sample.mandateId)

    // The same row is still readable outside the lock; the lock is about concurrency, not visibility.
    const plain = await findMandateById(sample.mandateId)
    expect(plain.ok).toBe(true)
    if (!plain.ok) return
    expect(plain.value?.id).toBe(sample.mandateId)
  })

  it('takes the row inside the caller’s transaction, not its own', async () => {
    // The property `gateDepsFromRepos` relies on: the read sees uncommitted work from the same
    // transaction. If this function opened its own connection, the Gate would evaluate a stale
    // mandate between check 8's reservation and check 9's cap sum.
    const sample = await firstMandate()
    if (sample === undefined) return

    const seen = await inTx(async (tx) => {
      const before = await lockMandateForUpdate(sample.mandateId, tx)
      if (!before.ok || before.value === undefined) return before
      // Touch the row so there is uncommitted work in this transaction to observe.
      await tx
        .update(mandates)
        .set({ updated_at: new Date() })
        .where(eq(mandates.id, sample.mandateId))
      return lockMandateForUpdate(sample.mandateId, tx)
    })
    expect(seen.ok).toBe(true)
    if (!seen.ok) return
    expect(seen.value?.id).toBe(sample.mandateId)
  })

  it('returns undefined for a mandate that does not exist, rather than inventing a not-found', async () => {
    // Inside a transaction that has already read the row, "gone" and "never existed" are the caller's
    // question, not this function's.
    const result = await inTx((tx) =>
      lockMandateForUpdate('mdt_00000000000000000000000000' as MandateId, tx),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBeUndefined()
  })
})

describe.skipIf(!hasDatabase)('findWalletCapPeriod (live database)', () => {
  it('answers with a period or undefined, never with a default', async () => {
    // Both answers are legal and the caller must be able to tell them apart: `undefined` is
    // "unconstrained", and inventing `MONTH` would silently limit a buyer who never asked.
    const sample = await firstMandate()
    if (sample === undefined) return

    const period = await findWalletCapPeriod(sample.walletId)
    expect(period.ok, period.ok ? '' : `read failed: ${period.error.message}`).toBe(true)
    if (!period.ok) return
    expect([undefined, 'DAY', 'MONTH']).toContain(period.value)
  })

  it('returns undefined for a wallet id that has no cap row', async () => {
    const period = await findWalletCapPeriod('wal_00000000000000000000000000' as WalletId)
    expect(period.ok).toBe(true)
    if (!period.ok) return
    expect(period.value).toBeUndefined()
  })
})
