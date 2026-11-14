/**
 * Three §12 cases whose handling lives in SQL, so they are asserted with executed statements against a
 * real Postgres: **EC-BUY-6** (serial disputer, count per wallet), **EC-AGT-4** (agent key rotation),
 * and the money readers the Gate depends on.
 *
 * ## Why they are here and not in `repos.live.test.ts`
 *
 * That file reads the seed. This file **builds its own world**, because neither edge case has seed
 * data: `seed/run.ts` inserts users, devices, wallets and products, and deliberately no mandates,
 * agents, disputes, orders or budget entries. The fixtures below are the smallest world these
 * statements need.
 *
 * ## Why they skip without `DATABASE_URL`
 *
 * Same rule as the rest of this package: the PR gate has no database, and a test that cannot run must
 * say so rather than pass. `db-migrations` in `.github/workflows/ci.yml` has Postgres 17, migrates,
 * seeds, and then runs this package's suite with `DATABASE_URL` set — so these cases execute in CI, in
 * the job that owns the schema.
 *
 * ## What this file found
 *
 * Postgres-js refuses a `Date` embedded in a raw `sql` fragment, and it returns `int8`/`numeric` as
 * **strings**. Four readers here did one or the other, and nothing exercised them against a database:
 * `countDisputesForWalletSince`, `findDisputesUpdatedSince`, `walletSpendInPeriod` (Gate check 9) and
 * `countCommitsSince` (check 11) all threw at runtime; `sumEntriesByKind` fed strings into
 * `computeFromEntries`, which then mixed a number with `0n`. Each is now asserted below.
 */
import { like } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'

import type { AgentId, CsError, MandateId, Result, WalletId } from '@countersign/core'

import { closeDb, withTx, type Tx } from '../src/client'
import {
  computeFromEntries,
  countCommitsSince,
  countDisputesForWalletSince,
  createAgent,
  drizzleStore,
  findAgentById,
  findAgentByKid,
  findDisputesUpdatedSince,
  rotateAgentKey,
  sumCapturedForAuthorization,
} from '../src/repos'
import {
  agents,
  budgetEntries,
  checkoutAttempts,
  checkoutSessions,
  devices,
  disputes,
  mandates,
  merchants,
  orders,
  paypalWallets,
  users,
} from '../src/schema'

const hasDatabase = (process.env['DATABASE_URL'] ?? '').trim() !== ''

/** Every id this file inserts starts with this, so cleanup is one prefix and cannot touch seed rows. */
const P = 'e2e_edg_'
const id = (kind: string, n: number): string => `${kind}_${P}${String(n).padStart(30, '0')}`

const NOW = new Date('2026-10-25T00:00:00Z')
const DAY_MS = 86_400_000
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * DAY_MS)
const epochSec = (d: Date): bigint => BigInt(Math.floor(d.getTime() / 1000))

const USER = id('usr', 1)
const USER_B = id('usr', 2)
const MERCHANT_USER = id('usr', 3)
const MERCHANT = id('mer', 1)
const DEVICE = id('dev', 1)
const DEVICE_B = id('dev', 2)
const WALLET = id('wal', 1)
const WALLET_B = id('wal', 2)
const AGENT = id('agt', 1)
const AGENT_B = id('agt', 2)
const MANDATE = id('mdt', 1)
const MANDATE_B = id('mdt', 2)
const SESSION = id('chk', 1)

/** Flatten `withTx`'s outer `Result`, so a failed statement is one readable failure. */
async function inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const outer = await withTx(fn)
  if (!outer.ok) throw new Error(`transaction failed: ${outer.error.code} ${outer.error.message}`)
  return outer.value
}

/** Unwrap a repo `Result`, so a failed statement names itself and its underlying cause. */
function unwrap<T>(r: Result<T, CsError>, what: string): T {
  if (!r.ok) {
    throw new Error(`${what}: ${r.error.code} ${r.error.message}\n${describeCause(r.error)}`)
  }
  return r.value
}

/** Walk the `cause` chain, because drizzle wraps postgres-js's error one level down. */
function describeCause(e: unknown): string {
  const parts: string[] = []
  let cur: unknown = e
  for (let i = 0; i < 5 && cur !== undefined && cur !== null; i++) {
    const c = cur as { name?: string; message?: string; cause?: unknown; code?: string }
    parts.push(`${c.name ?? 'Error'}${c.code ? `(${c.code})` : ''}: ${c.message ?? String(cur)}`)
    cur = c.cause
  }
  return parts.join('\n  ← ')
}

async function cleanup(tx: Tx): Promise<void> {
  // Child tables first: every FK points at the row inserted before it.
  await tx.delete(disputes).where(like(disputes.id, `%${P}%`))
  await tx.delete(budgetEntries).where(like(budgetEntries.id, `%${P}%`))
  await tx.delete(orders).where(like(orders.id, `%${P}%`))
  await tx.delete(checkoutAttempts).where(like(checkoutAttempts.id, `%${P}%`))
  await tx.delete(checkoutSessions).where(like(checkoutSessions.id, `%${P}%`))
  await tx.delete(mandates).where(like(mandates.id, `%${P}%`))
  await tx.delete(agents).where(like(agents.id, `%${P}%`))
  await tx.delete(paypalWallets).where(like(paypalWallets.id, `%${P}%`))
  await tx.delete(devices).where(like(devices.id, `%${P}%`))
  await tx.delete(merchants).where(like(merchants.id, `%${P}%`))
  await tx.delete(users).where(like(users.id, `%${P}%`))
}

/** The `mandates` row both worlds need; kept flat so the inserts above stay readable. */
function mandateValues(
  mandateId: string,
  suffix: string,
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
    l2_serialized: 'l2.e2e',
    l2_payload: {},
    nl_intent: 'e2e fixture mandate',
    readback: '**What you are authorising**',
    constraints: {},
    nonce: `nonce-${P}${suffix}`,
    aud: 'mrc_e2e',
    iat: epochSec(daysAgo(1)),
    exp: epochSec(daysAgo(-30)),
    status: 'ACTIVE',
    compiler_model: 'e2e',
  }
}

/** Two buyers, each with a device, a wallet, an agent and a mandate — the chain R-BUY-6 joins over. */
async function seedWorld(tx: Tx): Promise<void> {
  await cleanup(tx)

  await tx.insert(users).values([
    {
      id: USER,
      persona: 'BUYER',
      display_name: 'E2E buyer 1',
      email: 'e2e-buyer-1@example.test',
      country: 'US',
    },
    {
      id: USER_B,
      persona: 'BUYER',
      display_name: 'E2E buyer 2',
      email: 'e2e-buyer-2@example.test',
      country: 'US',
    },
    {
      id: MERCHANT_USER,
      persona: 'MERCHANT',
      display_name: 'E2E merchant',
      email: 'e2e-merchant@example.test',
      country: 'US',
    },
  ])
  await tx.insert(merchants).values({
    id: MERCHANT,
    owner_user_id: MERCHANT_USER,
    display_name: 'E2E merchant',
    paypal_merchant_id: 'mrc_e2e',
  })
  await tx.insert(devices).values([
    { id: DEVICE, user_id: USER, public_jwk: {}, jkt: `jkt-${P}1`, label: 'e2e device 1' },
    { id: DEVICE_B, user_id: USER_B, public_jwk: {}, jkt: `jkt-${P}2`, label: 'e2e device 2' },
  ])
  await tx.insert(paypalWallets).values([
    {
      id: WALLET,
      user_id: USER,
      payment_token_id: `vault-${P}1`,
      payer_id: `payer-${P}1`,
      payer_email: 'e2e-1@example.test',
    },
    {
      id: WALLET_B,
      user_id: USER_B,
      payment_token_id: `vault-${P}2`,
      payer_id: `payer-${P}2`,
      payer_email: 'e2e-2@example.test',
    },
  ])
  await tx.insert(agents).values([
    {
      id: AGENT,
      user_id: USER,
      name: 'e2e agent 1',
      public_jwk: {},
      kid: `kid-${P}1`,
      enc_private_key: Buffer.from('ciphertext'),
    },
    {
      id: AGENT_B,
      user_id: USER_B,
      name: 'e2e agent 2',
      public_jwk: {},
      kid: `kid-${P}2`,
      enc_private_key: Buffer.from('ciphertext'),
    },
  ])
  await tx
    .insert(mandates)
    .values([
      mandateValues(MANDATE, '1', USER, DEVICE, AGENT, WALLET),
      mandateValues(MANDATE_B, '2', USER_B, DEVICE_B, AGENT_B, WALLET_B),
    ])
  await tx.insert(checkoutSessions).values({
    id: SESSION,
    merchant_id: 'mrc_e2e',
    cart: { lines: [] },
    subtotal_minor: 1_000n,
    shipping_minor: 0n,
    total_minor: 1_000n,
    currency: 'USD',
    checkout_jwt: 'co.e2e',
    checkout_hash: 'h'.repeat(43),
    price_lock_exp: new Date(NOW.getTime() + 3_600_000),
  })
}

afterAll(async () => {
  if (!hasDatabase) return
  await withTx(cleanup)
  await closeDb()
})

describe.skipIf(!hasDatabase)(
  'EC-BUY-6: the serial-disputer count is per wallet and per window',
  () => {
    it("EC-BUY-6: counts a wallet's disputes in the window, and only that wallet's", async () => {
      const built = await inTx(async (tx) => {
        await seedWorld(tx)

        // Wallet A: three disputes — 10, 40 and 100 days old. Wallet B: one, 5 days old.
        const history = [
          { mandate: MANDATE, agent: AGENT, n: 1, at: daysAgo(10) },
          { mandate: MANDATE, agent: AGENT, n: 2, at: daysAgo(40) },
          { mandate: MANDATE, agent: AGENT, n: 3, at: daysAgo(100) },
          { mandate: MANDATE_B, agent: AGENT_B, n: 4, at: daysAgo(5) },
        ]
        for (const h of history) {
          const attempt = id('att', h.n)
          const order = id('ord', h.n)
          await tx.insert(checkoutAttempts).values({
            id: attempt,
            mandate_id: h.mandate,
            agent_id: h.agent,
            checkout_session_id: SESSION,
            l3a: `l3a.e2e.${h.n}`,
            l3b: `l3b.e2e.${h.n}`,
            l3_jti: `jti-${P}${h.n}`,
            idempotency_key: `idem-${P}${h.n}`,
            amount_minor: 1_000n,
            currency: 'USD',
            payee: 'mrc_e2e',
          })
          await tx.insert(orders).values({
            id: order,
            attempt_id: attempt,
            merchant_id: MERCHANT,
            paypal_order_id: `PP-ORDER-${P}${h.n}`,
            intent: 'CAPTURE',
            custom_id: `cs1:${'A'.repeat(43)}`,
            invoice_id: `INV-${P}${h.n}`,
            status: 'CAPTURED',
            amount_minor: 1_000n,
            currency: 'USD',
          })
          await tx.insert(disputes).values({
            id: id('dsp', h.n),
            paypal_dispute_id: `PP-D-E2E-${h.n}`,
            order_id: order,
            reason: 'UNAUTHORISED',
            stage: 'CHARGEBACK',
            status: 'WAITING_FOR_SELLER_RESPONSE',
            amount_minor: 1_000n,
            currency: 'USD',
            created_at: h.at,
            updated_at: h.at,
          })
        }

        return {
          wallet90: unwrap(
            await countDisputesForWalletSince(WALLET, daysAgo(90), tx),
            'count failed',
          ),
          wallet30: unwrap(
            await countDisputesForWalletSince(WALLET, daysAgo(30), tx),
            'count failed',
          ),
          walletAll: unwrap(
            await countDisputesForWalletSince(WALLET, daysAgo(365), tx),
            'count failed',
          ),
          otherWallet: unwrap(
            await countDisputesForWalletSince(WALLET_B, daysAgo(90), tx),
            'count failed',
          ),
          stranger: unwrap(
            await countDisputesForWalletSince(id('wal', 99), daysAgo(90), tx),
            'count failed',
          ),
        }
      })

      // The 90-day window drops the 100-day-old dispute: 2, not 3.
      expect(built.wallet90).toBe(2)
      // The 30-day window drops the 40-day one too: 1.
      expect(built.wallet30).toBe(1)
      // Everything inside a year: 3 — which is ≥3, the figure the S-17 flag reads.
      expect(built.walletAll).toBe(3)
      // **Per wallet, not global**: the other buyer's dispute is not counted here.
      expect(built.otherWallet).toBe(1)
      // A wallet with no disputes has no rows and therefore 0 — not an error, not a null.
      expect(built.stranger).toBe(0)
    })
  },
)

describe.skipIf(!hasDatabase)(
  'EC-AGT-4: rotation retains the old key row and records the chain',
  () => {
    it('EC-AGT-4: marks the predecessor REVOKED instead of deleting it, and links the new key to it', async () => {
      const r = await inTx(async (tx) => {
        await cleanup(tx)
        await tx.insert(users).values({
          id: USER,
          persona: 'BUYER',
          display_name: 'E2E buyer',
          email: 'e2e-rotate@example.test',
          country: 'US',
        })

        const oldId = AGENT as AgentId
        const newId = id('agt', 2) as AgentId
        const created = unwrap(
          await createAgent(
            { id: oldId, user_id: USER, name: 'e2e agent', public_jwk: {}, kid: `kid-${P}old` },
            Buffer.from('ciphertext-old'),
            tx,
          ),
          'createAgent failed',
        )
        expect(created.status).toBe('ACTIVE')

        const next = unwrap(
          await rotateAgentKey(
            oldId,
            {
              id: newId,
              user_id: USER,
              name: 'e2e agent (rotated)',
              public_jwk: {},
              kid: `kid-${P}new`,
            },
            Buffer.from('ciphertext-new'),
            NOW,
            tx,
          ),
          'rotateAgentKey failed',
        )

        return {
          next,
          predecessor: unwrap(await findAgentById(oldId, tx), 'findAgentById failed'),
          byKid: unwrap(await findAgentByKid(`kid-${P}new`, tx), 'findAgentByKid failed'),
        }
      })

      // The new key is ACTIVE and names its predecessor, so the rotation chain can be walked.
      expect(r.next.status).toBe('ACTIVE')
      expect(r.next.rotated_from).toBe(AGENT)
      expect(r.next.kid).toBe(`kid-${P}new`)

      // **The old row is retained, not deleted**, because past L3s signed by that `kid` must stay
      // resolvable: an evidence packet whose agent row had vanished would be unverifiable, which is the
      // opposite of what this project is for. It is REVOKED, so the old key cannot sign anything new.
      expect(r.predecessor).toBeDefined()
      expect(r.predecessor?.status).toBe('REVOKED')
      expect(r.predecessor?.updated_at.getTime()).toBe(NOW.getTime())

      // The Gate resolves an L3 by `kid`, and the new key is the one that answers.
      expect(r.byKid?.id).toBe(id('agt', 2))

      /**
       * **Not asserted, deliberately:** the spec's row says *"old mandates keep the old key until
       * expiry"*. Gate check 2 (`packages/gate/src/checks.ts:513`) refuses any agent whose status is not
       * `ACTIVE`, and this function has just set the predecessor to `REVOKED` — so a mandate still bound
       * to the old key cannot be spent. That conflict between the spec sentence and the implementation is
       * recorded in `docs/contract-issues.md` rather than papered over with a test that guesses.
       */
    })
  },
)

describe.skipIf(!hasDatabase)('the money readers execute and return BigInts', () => {
  it('sumEntriesByKind → computeFromEntries survives a real reservation, and the totals are BigInts', async () => {
    const out = await inTx(async (tx) => {
      await seedWorld(tx)
      await tx.insert(budgetEntries).values({
        id: id('bge', 1),
        mandate_id: MANDATE,
        kind: 'RESERVE',
        amount_minor: 1_000n,
        at: daysAgo(1),
        currency: 'USD',
      })

      const store = drizzleStore(tx)
      const totals = await store.sumEntriesByKind(MANDATE as MandateId)
      return {
        totals,
        computed: computeFromEntries(totals),
        spend: await store.walletSpendInPeriod(WALLET as WalletId, 'USD', 'DAY', NOW),
        commits: unwrap(
          await countCommitsSince(MANDATE as MandateId, daysAgo(30), tx),
          'countCommitsSince',
        ),
        updated: unwrap(await findDisputesUpdatedSince(daysAgo(1), tx), 'findDisputesUpdatedSince'),
        captured: unwrap(
          await sumCapturedForAuthorization('auth_e2e_none', tx),
          'sumCapturedForAuthorization',
        ),
      }
    })

    // The aggregate came back as a BigInt for every kind, and the reservation is exactly $10.00.
    expect(out.totals).toEqual({ RESERVE: 1_000n, RELEASE: 0n, COMMIT: 0n, REVERSE: 0n })
    expect(typeof out.totals.RESERVE).toBe('bigint')
    // `computeFromEntries` compares against `0n`, so a number here is a `TypeError`, not a rounding
    // error — which is what a string from the driver produced before this fix.
    expect(out.computed).toEqual({ reserved: 1_000n, spent: 0n })

    // Gate check 9's wallet spend is the same reservation, as a BigInt.
    expect(out.spend).toBe(1_000n)
    expect(typeof out.spend).toBe('bigint')
    // Gate check 11's recurrence count: no COMMITs, so zero — and a number, which is its contract.
    expect(out.commits).toBe(0)
    expect(out.updated).toEqual([])
    expect(out.captured).toBe(0n)
  })

  it('the empty-database answers still have the right types', async () => {
    const out = await inTx(async (tx) => {
      await seedWorld(tx)
      const store = drizzleStore(tx)
      return {
        spend: await store.walletSpendInPeriod(WALLET as WalletId, 'USD', 'DAY', NOW),
        commits: unwrap(
          await countCommitsSince(MANDATE as MandateId, daysAgo(30), tx),
          'countCommitsSince',
        ),
      }
    })
    expect(out.spend).toBe(0n)
    expect(out.commits).toBe(0)
  })
})
