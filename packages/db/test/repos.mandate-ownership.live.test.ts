/**
 * The mandate query the buyer-ownership rule is built on, against a real Postgres — D-060.
 *
 * `apps/web/lib/session.ts::requireOwnedMandate` asks `findMandatesByUser(buyerId)` and then looks for the
 * named id in the answer, so the whole cross-buyer guarantee is one `WHERE user_id = $1` statement. A unit
 * test with a double proves the *rule*; it cannot prove the statement filters, and a select that returned
 * every row would make the rule pass while leaking every mandate in the table. That is why this is here.
 *
 * Two buyers, one mandate each, and a third id that exists nowhere: the three answers a run route can give.
 */
import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'

import { closeDb, db, withTx, type Tx } from '../src/client'
import { findMandatesByUser } from '../src/repos/mandates'
import { agents, devices, mandates, paypalWallets, users } from '../src/schema'

const hasDatabase = (process.env['DATABASE_URL'] ?? '').trim() !== ''

/** Every id here starts with this, so cleanup is one prefix and cannot touch the seeded personas. */
const P = 'e2e_own_'
const id = (kind: string, n: number): string => `${kind}_${P}${String(n).padStart(30, '0')}`

const BUYER_A = id('usr', 1)
const BUYER_B = id('usr', 2)
const DEVICE_A = id('dev', 1)
const DEVICE_B = id('dev', 2)
const WALLET_A = id('wal', 1)
const WALLET_B = id('wal', 2)
const AGENT_A = id('agt', 1)
const AGENT_B = id('agt', 2)
const MANDATE_A = id('mdt', 1)
const MANDATE_B = id('mdt', 2)

async function inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const outer = await withTx(fn)
  if (!outer.ok) throw new Error(`transaction failed: ${outer.error.code} ${outer.error.message}`)
  return outer.value
}

function mandateRow(
  mandateId: string,
  userId: string,
  deviceId: string,
  agentId: string,
  walletId: string,
): typeof mandates.$inferInsert {
  return {
    id: mandateId,
    user_id: userId,
    device_id: deviceId,
    agent_id: agentId,
    wallet_id: walletId,
    l2_serialized: 'l2.live',
    l2_payload: {},
    nl_intent: 'live ownership fixture',
    readback: '**What you are authorising**',
    constraints: {},
    nonce: `nonce-${mandateId}`,
    aud: 'mrc_e2e',
    iat: 1_700_000_000n,
    exp: 1_800_000_000n,
    status: 'ACTIVE',
    compiler_model: 'e2e',
  }
}

async function seed(tx: Tx): Promise<void> {
  await tx.delete(mandates).where(eq(mandates.user_id, BUYER_A))
  await tx.delete(mandates).where(eq(mandates.user_id, BUYER_B))
  await tx.delete(agents).where(eq(agents.user_id, BUYER_A))
  await tx.delete(agents).where(eq(agents.user_id, BUYER_B))
  await tx.delete(devices).where(eq(devices.user_id, BUYER_A))
  await tx.delete(devices).where(eq(devices.user_id, BUYER_B))
  await tx.delete(paypalWallets).where(eq(paypalWallets.user_id, BUYER_A))
  await tx.delete(paypalWallets).where(eq(paypalWallets.user_id, BUYER_B))
  await tx.delete(users).where(eq(users.id, BUYER_A))
  await tx.delete(users).where(eq(users.id, BUYER_B))

  await tx.insert(users).values([
    {
      id: BUYER_A,
      persona: 'BUYER',
      display_name: 'Buyer A',
      email: 'e2e-own-a@example.test',
      country: 'US',
    },
    {
      id: BUYER_B,
      persona: 'BUYER',
      display_name: 'Buyer B',
      email: 'e2e-own-b@example.test',
      country: 'US',
    },
  ])
  await tx.insert(devices).values([
    { id: DEVICE_A, user_id: BUYER_A, public_jwk: {}, jkt: `jkt-${P}a`, label: 'a' },
    { id: DEVICE_B, user_id: BUYER_B, public_jwk: {}, jkt: `jkt-${P}b`, label: 'b' },
  ])
  await tx.insert(paypalWallets).values([
    {
      id: WALLET_A,
      user_id: BUYER_A,
      payment_token_id: `vault-${P}a`,
      payer_id: `payer-${P}a`,
      payer_email: 'a@example.test',
    },
    {
      id: WALLET_B,
      user_id: BUYER_B,
      payment_token_id: `vault-${P}b`,
      payer_id: `payer-${P}b`,
      payer_email: 'b@example.test',
    },
  ])
  await tx.insert(agents).values([
    {
      id: AGENT_A,
      user_id: BUYER_A,
      name: 'buyer a agent',
      public_jwk: {},
      kid: `kid-${P}a`,
      enc_private_key: Buffer.from('ciphertext'),
    },
    {
      id: AGENT_B,
      user_id: BUYER_B,
      name: 'buyer b agent',
      public_jwk: {},
      kid: `kid-${P}b`,
      enc_private_key: Buffer.from('ciphertext'),
    },
  ])
  await tx
    .insert(mandates)
    .values([
      mandateRow(MANDATE_A, BUYER_A, DEVICE_A, AGENT_A, WALLET_A),
      mandateRow(MANDATE_B, BUYER_B, DEVICE_B, AGENT_B, WALLET_B),
    ])
}

async function cleanup(): Promise<void> {
  await db().delete(mandates).where(eq(mandates.user_id, BUYER_A))
  await db().delete(mandates).where(eq(mandates.user_id, BUYER_B))
  await db().delete(agents).where(eq(agents.user_id, BUYER_A))
  await db().delete(agents).where(eq(agents.user_id, BUYER_B))
  await db().delete(devices).where(eq(devices.user_id, BUYER_A))
  await db().delete(devices).where(eq(devices.user_id, BUYER_B))
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
  'findMandatesByUser answers only for the buyer it was asked about (live database)',
  () => {
    it("returns buyer A's mandate and not buyer B's, so the ownership rule cannot be fooled", async () => {
      await inTx(seed)

      const found = await findMandatesByUser(BUYER_A)
      expect(found.ok, found.ok ? '' : found.error.message).toBe(true)
      if (!found.ok) return
      const ids = found.value.map((row) => row.id)
      expect(ids).toContain(MANDATE_A)
      expect(ids).not.toContain(MANDATE_B)

      const other = await findMandatesByUser(BUYER_B)
      expect(other.ok, other.ok ? '' : other.error.message).toBe(true)
      if (!other.ok) return
      expect(other.value.map((row) => row.id)).toContain(MANDATE_B)
      expect(other.value.map((row) => row.id)).not.toContain(MANDATE_A)
    })

    it('answers an empty array for a buyer with no mandates, not an error', async () => {
      await inTx(seed)
      const found = await findMandatesByUser(id('usr', 99))
      expect(found.ok).toBe(true)
      if (!found.ok) return
      expect(found.value).toEqual([])
    })

    it('never returns a seeded persona row, because the predicate is the user id', async () => {
      await inTx(seed)
      const found = await findMandatesByUser(BUYER_A)
      expect(found.ok).toBe(true)
      if (!found.ok) return
      for (const row of found.value) {
        expect(row.user_id).toBe(BUYER_A)
      }
    })

    it('exposes the agent id on the row, which is what the agent-key check reads', async () => {
      await inTx(seed)
      const found = await findMandatesByUser(BUYER_A)
      expect(found.ok).toBe(true)
      if (!found.ok) return
      const row = found.value.find((candidate) => candidate.id === MANDATE_A)
      expect(row?.agent_id).toBe(AGENT_A)
    })
  },
)
