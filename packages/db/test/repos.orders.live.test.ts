/**
 * Live database test for `orders` repository and schema constraints.
 *
 * Invariant: orders must belong to a merchant.
 * Inserting an order with `merchant_id` NULL is rejected by Postgres (not-null violation 23502).
 */
import { like } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { closeDb, db, withTx, type Tx } from '../src/client'
import { createOrder, pgErrorCode, PG } from '../src/repos'
import {
  agents,
  checkoutAttempts,
  checkoutSessions,
  devices,
  mandates,
  orders,
  paypalWallets,
  users,
} from '../src/schema'

const hasDatabase = (process.env['DATABASE_URL'] ?? '').trim() !== ''

const P = 'live_ord_'
const id = (kind: string, n: number): string => `${kind}_${P}${String(n).padStart(28, '0')}`

const NOW = new Date('2026-11-14T00:00:00Z')
const epochSec = (d: Date): bigint => BigInt(Math.floor(d.getTime() / 1000))

const USER = id('usr', 1)
const DEVICE = id('dev', 1)
const WALLET = id('wal', 1)
const AGENT = id('agt', 1)
const MANDATE = id('mdt', 1)
const SESSION = id('chk', 1)
const ATTEMPT = id('att', 1)

async function inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const outer = await withTx(fn)
  if (!outer.ok) throw new Error(`transaction failed: ${outer.error.code} ${outer.error.message}`)
  return outer.value
}

async function cleanup(tx: Tx): Promise<void> {
  await tx.delete(orders).where(like(orders.id, `%${P}%`))
  await tx.delete(checkoutAttempts).where(like(checkoutAttempts.id, `%${P}%`))
  await tx.delete(checkoutSessions).where(like(checkoutSessions.id, `%${P}%`))
  await tx.delete(mandates).where(like(mandates.id, `%${P}%`))
  await tx.delete(agents).where(like(agents.id, `%${P}%`))
  await tx.delete(paypalWallets).where(like(paypalWallets.id, `%${P}%`))
  await tx.delete(devices).where(like(devices.id, `%${P}%`))
  await tx.delete(users).where(like(users.id, `%${P}%`))
}

async function seedWorld(tx: Tx): Promise<void> {
  await cleanup(tx)

  await tx.insert(users).values({
    id: USER,
    persona: 'BUYER',
    display_name: 'Order Constraint Live Buyer',
    email: 'ord-constraint-buyer@example.test',
    country: 'US',
  })
  await tx.insert(devices).values({
    id: DEVICE,
    user_id: USER,
    public_jwk: {},
    jkt: `jkt-${P}1`,
    label: 'order test device',
  })
  await tx.insert(paypalWallets).values({
    id: WALLET,
    user_id: USER,
    payment_token_id: `vault-${P}1`,
    payer_id: `payer-${P}1`,
    payer_email: 'ord-constraint@example.test',
  })
  await tx.insert(agents).values({
    id: AGENT,
    user_id: USER,
    name: 'order test agent',
    public_jwk: {},
    kid: `kid-${P}1`,
    enc_private_key: Buffer.from('ciphertext'),
  })
  await tx.insert(mandates).values({
    id: MANDATE,
    user_id: USER,
    device_id: DEVICE,
    agent_id: AGENT,
    wallet_id: WALLET,
    l2_serialized: 'l2.order.test',
    l2_payload: {},
    nl_intent: 'order constraint test mandate',
    readback: '**What you are authorising**',
    constraints: {},
    nonce: `nonce-${P}1`,
    aud: 'mrc_ord_test',
    iat: epochSec(NOW),
    exp: epochSec(new Date(NOW.getTime() + 86_400_000)),
    status: 'ACTIVE',
    compiler_model: 'e2e',
  })
  await tx.insert(checkoutSessions).values({
    id: SESSION,
    merchant_id: 'mrc_ord_test',
    cart: { lines: [] },
    subtotal_minor: 1_000n,
    shipping_minor: 0n,
    total_minor: 1_000n,
    currency: 'USD',
    checkout_jwt: 'co.order.test',
    checkout_hash: 'h'.repeat(43),
    price_lock_exp: new Date(NOW.getTime() + 3_600_000),
  })
  await tx.insert(checkoutAttempts).values({
    id: ATTEMPT,
    mandate_id: MANDATE,
    agent_id: AGENT,
    checkout_session_id: SESSION,
    l3a: 'l3a.order.test',
    l3b: 'l3b.order.test',
    l3_jti: `jti-${P}1`,
    idempotency_key: `idem-${P}1`,
    amount_minor: 1_000n,
    currency: 'USD',
    payee: 'mrc_ord_test',
  })
}

beforeAll(async () => {
  if (!hasDatabase) return
  await inTx(seedWorld)
})

afterAll(async () => {
  if (!hasDatabase) return
  await withTx(cleanup)
  await closeDb()
})

describe.skipIf(!hasDatabase)('orders repository and schema constraints (live database)', () => {
  it('inserting an order with merchant_id NULL is rejected by Postgres (not-null violation 23502)', async () => {
    // 1. Through createOrder repository wrapper
    const repoResult = await createOrder({
      id: id('ord', 1),
      attempt_id: ATTEMPT,
      merchant_id: null as unknown as string,
      paypal_order_id: `PP-ORD-${P}1`,
      intent: 'CAPTURE',
      custom_id: `cs1:${'A'.repeat(43)}`,
      invoice_id: `INV-${P}1`,
      status: 'ORDER_CREATED',
      amount_minor: 1_000n,
      currency: 'USD',
    })

    expect(repoResult.ok).toBe(false)
    if (!repoResult.ok) {
      expect(repoResult.error.code).toBe('CS_VALIDATION')
      expect(repoResult.error.details?.['pgCode']).toBe(PG.NOT_NULL_VIOLATION)
      expect(repoResult.error.details?.['pgCode']).toBe('23502')
    }

    // 2. Direct statement rejected by driver
    let directError: unknown
    try {
      await db()
        .insert(orders)
        .values({
          id: id('ord', 2),
          attempt_id: ATTEMPT,
          merchant_id: null as unknown as string,
          paypal_order_id: `PP-ORD-${P}2`,
          intent: 'CAPTURE',
          custom_id: `cs1:${'B'.repeat(43)}`,
          invoice_id: `INV-${P}2`,
          status: 'ORDER_CREATED',
          amount_minor: 1_000n,
          currency: 'USD',
        })
    } catch (e) {
      directError = e
    }
    expect(pgErrorCode(directError)).toBe('23502')
  })
})
