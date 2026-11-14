/**
 * The wallet query the buyer-ownership rule is built on, against a real Postgres — D-060.
 *
 * A buyer must NEVER see another buyer's wallets. A unit test with a double proves the rule;
 * it cannot prove the statement filters by `user_id`. This live test verifies buyer A cannot
 * see buyer B's wallets and vice versa.
 */
import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'

import { closeDb, db, withTx, type Tx } from '../src/client'
import { listWalletsForUser } from '../src/repos/wallets'
import { paypalWallets, users } from '../src/schema'

const hasDatabase = (process.env['DATABASE_URL'] ?? '').trim() !== ''

const P = 'e2e_wal_own_'
const id = (kind: string, n: number): string => `${kind}_${P}${String(n).padStart(30, '0')}`

const BUYER_A = id('usr', 1)
const BUYER_B = id('usr', 2)
const WALLET_A1 = id('wal', 1)
const WALLET_A2 = id('wal', 2)
const WALLET_B = id('wal', 3)

async function inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const outer = await withTx(fn)
  if (!outer.ok) throw new Error(`transaction failed: ${outer.error.code} ${outer.error.message}`)
  return outer.value
}

async function seed(tx: Tx): Promise<void> {
  await tx.delete(paypalWallets).where(eq(paypalWallets.user_id, BUYER_A))
  await tx.delete(paypalWallets).where(eq(paypalWallets.user_id, BUYER_B))
  await tx.delete(users).where(eq(users.id, BUYER_A))
  await tx.delete(users).where(eq(users.id, BUYER_B))

  await tx.insert(users).values([
    {
      id: BUYER_A,
      persona: 'BUYER',
      display_name: 'Buyer A',
      email: 'e2e-wal-a@example.test',
      country: 'US',
    },
    {
      id: BUYER_B,
      persona: 'BUYER',
      display_name: 'Buyer B',
      email: 'e2e-wal-b@example.test',
      country: 'US',
    },
  ])

  await tx.insert(paypalWallets).values([
    {
      id: WALLET_A1,
      user_id: BUYER_A,
      payment_token_id: `vault-${P}a1`,
      payer_id: `payer-${P}a1`,
      payer_email: 'a1@example.test',
      status: 'ACTIVE',
      created_at: new Date('2026-11-01T00:00:00Z'),
    },
    {
      id: WALLET_A2,
      user_id: BUYER_A,
      payment_token_id: `vault-${P}a2`,
      payer_id: `payer-${P}a2`,
      payer_email: 'a2@example.test',
      status: 'ACTIVE',
      created_at: new Date('2026-11-02T00:00:00Z'),
    },
    {
      id: WALLET_B,
      user_id: BUYER_B,
      payment_token_id: `vault-${P}b`,
      payer_id: `payer-${P}b`,
      payer_email: 'b@example.test',
      status: 'ACTIVE',
      created_at: new Date('2026-11-01T12:00:00Z'),
    },
  ])
}

async function cleanup(): Promise<void> {
  await db().delete(paypalWallets).where(eq(paypalWallets.user_id, BUYER_A))
  await db().delete(paypalWallets).where(eq(paypalWallets.user_id, BUYER_B))
  await db().delete(users).where(eq(users.id, BUYER_A))
  await db().delete(users).where(eq(users.id, BUYER_B))
}

afterAll(async () => {
  if (!hasDatabase) return
  await cleanup()
  await closeDb()
})

describe.skipIf(!hasDatabase)(
  'listWalletsForUser answers only for the buyer it was asked about (live database)',
  () => {
    it("returns buyer A's wallets and not buyer B's, so buyer A cannot see buyer B's wallets", async () => {
      await inTx(seed)

      const foundA = await listWalletsForUser(BUYER_A)
      expect(foundA.ok, foundA.ok ? '' : foundA.error.message).toBe(true)
      if (!foundA.ok) return
      const idsA = foundA.value.map((row) => row.id)
      expect(idsA).toContain(WALLET_A1)
      expect(idsA).toContain(WALLET_A2)
      expect(idsA).not.toContain(WALLET_B)

      const foundB = await listWalletsForUser(BUYER_B)
      expect(foundB.ok, foundB.ok ? '' : foundB.error.message).toBe(true)
      if (!foundB.ok) return
      const idsB = foundB.value.map((row) => row.id)
      expect(idsB).toContain(WALLET_B)
      expect(idsB).not.toContain(WALLET_A1)
      expect(idsB).not.toContain(WALLET_A2)
    })

    it('returns wallets ordered newest first', async () => {
      await inTx(seed)

      const foundA = await listWalletsForUser(BUYER_A)
      expect(foundA.ok).toBe(true)
      if (!foundA.ok) return
      expect(foundA.value.map((row) => row.id)).toEqual([WALLET_A2, WALLET_A1])
    })

    it('answers an empty array for a buyer with no wallets, not an error', async () => {
      await inTx(seed)
      const found = await listWalletsForUser(id('usr', 99))
      expect(found.ok).toBe(true)
      if (!found.ok) return
      expect(found.value).toEqual([])
    })

    it('never returns a wallet for another user, because the query filters by user_id', async () => {
      await inTx(seed)
      const found = await listWalletsForUser(BUYER_A)
      expect(found.ok).toBe(true)
      if (!found.ok) return
      for (const row of found.value) {
        expect(row.user_id).toBe(BUYER_A)
      }
    })
  },
)
