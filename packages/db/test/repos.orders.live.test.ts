/**
 * Live database test for `orders` repository and schema constraints.
 *
 * Invariant: orders must belong to a merchant.
 * Inserting an order with `merchant_id` NULL is rejected by Postgres (not-null violation 23502).
 */
import { like } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { closeDb, db, withTx, type Tx } from '../src/client'
import {
  createCapture,
  createOrder,
  findCaptureForMerchant,
  findOrderForMerchant,
  pgErrorCode,
  PG,
} from '../src/repos'
import {
  agents,
  captures,
  checkoutAttempts,
  checkoutSessions,
  devices,
  mandates,
  merchants,
  orders,
  paypalWallets,
  refunds,
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

/**
 * Two merchants, each owning one order, for the isolation assertions.
 *
 * `owner_user_id` is UNIQUE on `merchants`, so the two merchant profiles need two distinct owner users —
 * which is the shape production has anyway: a merchant is a profile a user administers, not the user.
 */
const OWNER_A = id('usr', 2)
const OWNER_B = id('usr', 3)
const MERCHANT_A = `mer_${P}A`
const MERCHANT_B = `mer_${P}B`
const ORDER_A = id('ord', 3)
const ORDER_B = id('ord', 4)
const CAPTURE_A = id('cap', 1)

async function inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const outer = await withTx(fn)
  if (!outer.ok) throw new Error(`transaction failed: ${outer.error.code} ${outer.error.message}`)
  return outer.value
}

async function cleanup(tx: Tx): Promise<void> {
  // Children first: `refunds` and `captures` reference an order, and an order references a merchant.
  await tx.delete(refunds).where(like(refunds.id, `%${P}%`))
  await tx.delete(captures).where(like(captures.id, `%${P}%`))
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

  // --- two merchants, one order each: the shape the merchant-scoped finders exist for -----------------
  for (const [ownerId, merchantId, name] of [
    [OWNER_A, MERCHANT_A, 'Northwind Traders'] as const,
    [OWNER_B, MERCHANT_B, 'Southwind Traders'] as const,
  ]) {
    await tx.insert(users).values({
      id: ownerId,
      persona: 'MERCHANT',
      display_name: name,
      email: `${merchantId}@example.test`,
      country: 'US',
    })
    await tx.insert(merchants).values({
      id: merchantId,
      owner_user_id: ownerId,
      display_name: name,
      status: 'ACTIVE',
    })
  }

  // `orders_attempt_id_key` is UNIQUE — one order per attempt — so each merchant's order needs its own
  // attempt row, which in turn reuses the mandate, agent and session seeded above.
  const attempts: readonly { id: string; n: string }[] = [
    { id: id('att', 2), n: 'A' },
    { id: id('att', 3), n: 'B' },
  ]
  for (const a of attempts) {
    await tx.insert(checkoutAttempts).values({
      id: a.id,
      mandate_id: MANDATE,
      agent_id: AGENT,
      checkout_session_id: SESSION,
      l3a: `l3a.order.${a.n}`,
      l3b: `l3b.order.${a.n}`,
      l3_jti: `jti-${P}${a.n}`,
      idempotency_key: `idem-${P}${a.n}`,
      amount_minor: 2_500n,
      currency: 'USD',
      payee: 'mrc_ord_test',
    })
  }

  for (const [a, merchantId, paypalOrderId] of [
    [attempts[0], MERCHANT_A, `PP-ORD-${P}A`] as const,
    [attempts[1], MERCHANT_B, `PP-ORD-${P}B`] as const,
  ]) {
    if (!a) throw new Error('seedWorld: an attempt is missing')
    await tx.insert(orders).values({
      id: a.n === 'A' ? ORDER_A : ORDER_B,
      attempt_id: a.id,
      merchant_id: merchantId,
      paypal_order_id: paypalOrderId,
      intent: 'AUTHORIZE',
      custom_id: `cs1:${a.n.repeat(43)}`,
      invoice_id: `INV-${P}${a.n}`,
      status: 'ORDER_CREATED',
      amount_minor: 2_500n,
      currency: 'USD',
    })
  }

  // One captured payment on merchant A's order, so the capture finder has something to scope.
  await createCapture(
    {
      id: CAPTURE_A,
      order_id: ORDER_A,
      paypal_capture_id: `PP-CAP-${P}A`,
      amount_minor: 2_500n,
      currency: 'USD',
      final_capture: true,
      status: 'COMPLETED',
      created_at: NOW,
      updated_at: NOW,
    },
    tx,
  )
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

/**
 * The two merchant-scoped finders — §7.2 / D-059's "every merchant action operates on rows scoped to a
 * merchant profile".
 *
 * A route on the open internet takes an id from the URL, so these finders are the only thing standing
 * between a merchant and another merchant's takings. They are asserted against the **real** join in
 * Postgres rather than a stub, because the property that matters is a join predicate — `orders.merchant_id
 * = $1` — and a stub can only assert that someone wrote one.
 */
describe.skipIf(!hasDatabase)('merchant-scoped order and capture finders (live database)', () => {
  it("returns merchant A's order for A and nothing for B, so the predicate is the merchant id", async () => {
    const own = await findOrderForMerchant(ORDER_A, MERCHANT_A)
    expect(own.ok).toBe(true)
    if (!own.ok) return
    expect(own.value?.id).toBe(ORDER_A)
    expect(own.value?.merchant_id).toBe(MERCHANT_A)

    // Same id, other merchant: `undefined`, not a row and not an error.
    const other = await findOrderForMerchant(ORDER_A, MERCHANT_B)
    expect(other.ok).toBe(true)
    if (!other.ok) return
    expect(other.value).toBeUndefined()
  })

  it('answers undefined for an id that names no row, rather than an error', async () => {
    const missing = await findOrderForMerchant(id('ord', 999), MERCHANT_A)
    expect(missing.ok).toBe(true)
    if (!missing.ok) return
    expect(missing.value).toBeUndefined()
  })

  it('finds a capture only through its own order, and never for the other merchant', async () => {
    const own = await findCaptureForMerchant(CAPTURE_A, MERCHANT_A)
    expect(own.ok).toBe(true)
    if (!own.ok) return
    expect(own.value?.id).toBe(CAPTURE_A)
    expect(own.value?.paypal_capture_id).toBe(`PP-CAP-${P}A`)
    expect(own.value?.order_id).toBe(ORDER_A)

    const other = await findCaptureForMerchant(CAPTURE_A, MERCHANT_B)
    expect(other.ok).toBe(true)
    if (!other.ok) return
    expect(other.value).toBeUndefined()
  })

  it('the capture on merchant B’s order is not visible to A, even by its exact capture id', async () => {
    // The hole this closes: `refund()` looks a capture up by PayPal id across the whole table. A merchant
    // route resolves through `findCaptureForMerchant` first, so "I know the id" stops being enough.
    await createCapture(
      {
        id: id('cap', 2),
        order_id: ORDER_B,
        paypal_capture_id: `PP-CAP-${P}B`,
        amount_minor: 1_000n,
        currency: 'USD',
        status: 'COMPLETED',
      },
      db(),
    )
    const stolen = await findCaptureForMerchant(id('cap', 2), MERCHANT_A)
    expect(stolen.ok).toBe(true)
    if (!stolen.ok) return
    expect(stolen.value).toBeUndefined()

    const own = await findCaptureForMerchant(id('cap', 2), MERCHANT_B)
    expect(own.ok).toBe(true)
    if (!own.ok) return
    expect(own.value?.id).toBe(id('cap', 2))
  })
})
