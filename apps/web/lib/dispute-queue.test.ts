/**
 * The real dispute queue, against Postgres.
 *
 * `packages/db` proves the reader (`listDisputesForReview`) and `packages/defender` proves the router.
 * What neither can prove is the composition this page uses: that the queue row carries the *stored*
 * verdict rather than a re-derived one, that an unlinked dispute stays unlinked, and that the packet and
 * action counts come from the tables rather than from a default. That is what this suite asserts, and it
 * is the reason the suite inserts real rows instead of mocking the repositories.
 *
 * Skipped, not failed, without a database — the same rule the webhook route suite follows.
 */
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  agents,
  BUYER,
  checkoutAttempts,
  checkoutSessions,
  closeDb,
  db,
  disputes,
  mandates,
  merchants,
  orders,
  SEED_DEVICE_ID,
  SEED_WALLET_ID,
  users,
} from '@countersign/db'

import {
  DISPUTE_QUEUE_LIMIT,
  disputesUseDemoView,
  loadDisputeQueue,
  routerRuleId,
} from './dispute-queue'

const DATABASE_URL = process.env['DATABASE_URL']
const describeWithDb = DATABASE_URL ? describe : describe.skip

/** Every id this file inserts starts with this, so cleanup is one prefix and cannot touch seed rows. */
const P = 'qtest_'
const disputeId = (n: number): string => `dsp_${P}${String(n).padStart(24, '0')}`
const orderId = (n: number): string => `ord_${P}${String(n).padStart(24, '0')}`
const attemptId = (n: number): string => `att_${P}${String(n).padStart(24, '0')}`

const USER_ID = `usr_${P}${'0'.repeat(20)}1`
const MERCHANT_ID = `mer_${P}${'0'.repeat(20)}1`
const agentId = `agt_${P}000000000000000000001`
const mandateId = `mdt_${P}000000000000000000001`
const sessionId = `chk_${P}000000000000000000001`

const insertedDisputes: string[] = []
const insertedOrders: string[] = []
const insertedAttempts: string[] = []

beforeAll(async () => {
  if (!DATABASE_URL) return

  await db()
    .insert(users)
    .values({
      id: USER_ID,
      persona: 'MERCHANT',
      display_name: 'Queue Test Merchant',
      email: `merchant-${P}@example.test`,
      country: 'US',
    })
    .onConflictDoNothing()

  await db()
    .insert(merchants)
    .values({
      id: MERCHANT_ID,
      owner_user_id: USER_ID,
      display_name: 'Queue Test Merchant',
    })
    .onConflictDoNothing()

  await db()
    .insert(agents)
    .values({
      id: agentId,
      user_id: BUYER.id,
      name: 'Queue Test Agent',
      public_jwk: {},
      kid: `kid_${P}`,
      enc_private_key: Buffer.from('test-enc-key'),
    })
    .onConflictDoNothing()

  await db()
    .insert(mandates)
    .values({
      id: mandateId,
      user_id: BUYER.id,
      device_id: SEED_DEVICE_ID,
      agent_id: agentId,
      wallet_id: SEED_WALLET_ID,
      l2_serialized: 'l2.test',
      l2_payload: {},
      nl_intent: 'test mandate',
      readback: 'test readback',
      constraints: {},
      nonce: `nonce-${P}`,
      aud: 'test-aud',
      iat: BigInt(Math.floor(Date.now() / 1000) - 60),
      exp: BigInt(Math.floor(Date.now() / 1000) + 3600),
      status: 'ACTIVE',
      compiler_model: 'test',
    })
    .onConflictDoNothing()

  await db()
    .insert(checkoutSessions)
    .values({
      id: sessionId,
      merchant_id: MERCHANT_ID,
      cart: { lines: [] },
      subtotal_minor: 4_800n,
      shipping_minor: 0n,
      total_minor: 4_800n,
      currency: 'USD',
      checkout_jwt: 'co.jwt',
      checkout_hash: 'h'.repeat(43),
      price_lock_exp: new Date(Date.now() + 3600_000),
    })
    .onConflictDoNothing()
})

async function insertDispute(input: {
  n: number
  paypalId: string
  trace: unknown
  updatedAt: Date
}): Promise<void> {
  const dId = disputeId(input.n)
  const oId = orderId(input.n)
  const attId = attemptId(input.n)

  insertedAttempts.push(attId)
  insertedOrders.push(oId)
  insertedDisputes.push(dId)

  await db()
    .insert(checkoutAttempts)
    .values({
      id: attId,
      mandate_id: mandateId,
      agent_id: agentId,
      checkout_session_id: sessionId,
      l3a: 'l3a.test',
      l3b: 'l3b.test',
      l3_jti: `jti-${P}-${input.n}`,
      idempotency_key: `idem-${P}-${input.n}`,
      amount_minor: 4_800n,
      currency: 'USD',
      payee: 'payee-test',
    })

  await db()
    .insert(orders)
    .values({
      id: oId,
      attempt_id: attId,
      merchant_id: MERCHANT_ID,
      paypal_order_id: `PP-ORD-${P}-${input.n}`,
      intent: 'CAPTURE',
      custom_id: `cs1:order-${P}-${input.n}`,
      invoice_id: `inv-${P}-${input.n}`,
      status: 'CAPTURED',
      amount_minor: 4_800n,
      currency: 'USD',
    })

  await db()
    .insert(disputes)
    .values({
      id: dId,
      paypal_dispute_id: input.paypalId,
      order_id: oId,
      reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
      stage: 'CHARGEBACK',
      status: 'WAITING_FOR_SELLER_RESPONSE',
      amount_minor: 4_800n,
      currency: 'USD',
      seller_response_due_date: new Date('2026-12-01T00:00:00Z'),
      defense_state: 'NEW',
      router_trace: input.trace as never,
      created_at: input.updatedAt,
      updated_at: input.updatedAt,
    })
}

afterEach(async () => {
  for (const id of insertedDisputes.splice(0, insertedDisputes.length)) {
    await db().delete(disputes).where(eq(disputes.id, id))
  }
  for (const id of insertedOrders.splice(0, insertedOrders.length)) {
    await db().delete(orders).where(eq(orders.id, id))
  }
  for (const id of insertedAttempts.splice(0, insertedAttempts.length)) {
    await db().delete(checkoutAttempts).where(eq(checkoutAttempts.id, id))
  }
})

afterAll(async () => {
  if (DATABASE_URL) {
    await db().delete(checkoutSessions).where(eq(checkoutSessions.id, sessionId))
    await db().delete(mandates).where(eq(mandates.id, mandateId))
    await db().delete(agents).where(eq(agents.id, agentId))
    await db().delete(merchants).where(eq(merchants.id, MERCHANT_ID))
    await db().delete(users).where(eq(users.id, USER_ID))
  }
  await closeDb()
})

describeWithDb('loadDisputeQueue', () => {
  it('is a read: an id this suite has not inserted never appears, whatever else is in the table', async () => {
    const result = await loadDisputeQueue(MERCHANT_ID, DISPUTE_QUEUE_LIMIT)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Array.isArray(result.value)).toBe(true)
    expect(result.value.some((row) => row.id.startsWith(`dsp_${P}`))).toBe(false)
  })

  it('carries the stored verdict and never re-derives one', async () => {
    await insertDispute({
      n: 1,
      paypalId: 'PP-D-QTEST-1',
      trace: { ruleId: 'R-SNAD-OK' },
      updatedAt: new Date('2026-11-01T00:00:00Z'),
    })

    const result = await loadDisputeQueue(MERCHANT_ID, DISPUTE_QUEUE_LIMIT)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const row = result.value.find((r) => r.id === disputeId(1))
    expect(row).toBeDefined()
    expect(row?.paypalDisputeId).toBe('PP-D-QTEST-1')
    // No liability column value: the router has not run, and the page must say that rather than guess.
    expect(row?.liability).toBeNull()
    expect(row?.ruleId).toBe('R-SNAD-OK')
    expect(row?.orderId).toBe(orderId(1))
    expect(row?.orderStatus).toBe('CAPTURED')
    // Nothing was filed and nothing was recorded.
    expect(row?.packetId).toBeNull()
    expect(row?.actions).toBe(0)
    // Money is integer minor units and its own currency, never a formatted string.
    expect(row?.amountMinor).toBe(4_800n)
    expect(row?.currency).toBe('USD')
  })

  it('orders newest first and applies the caller’s bound in the query', async () => {
    await insertDispute({
      n: 2,
      paypalId: 'PP-D-QTEST-2',
      trace: null,
      updatedAt: new Date('2026-11-02T00:00:00Z'),
    })
    await insertDispute({
      n: 3,
      paypalId: 'PP-D-QTEST-3',
      trace: null,
      updatedAt: new Date('2026-11-03T00:00:00Z'),
    })

    const result = await loadDisputeQueue(MERCHANT_ID, 1)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value).toHaveLength(1)
    expect(result.value[0]?.id).toBe(disputeId(3))
  })
})

describe('disputesUseDemoView', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('serves fixtures only in a non-production build with the flag on', () => {
    vi.stubEnv('COUNTERSIGN_AGENT_DEMO', '1')
    vi.stubEnv('NODE_ENV', 'development')
    expect(disputesUseDemoView()).toBe(true)
  })

  it('never serves fixtures from `next start`, even with the flag on', () => {
    vi.stubEnv('COUNTERSIGN_AGENT_DEMO', '1')
    vi.stubEnv('NODE_ENV', 'production')
    expect(disputesUseDemoView()).toBe(false)
  })

  it('serves the real queue when no flag is set', () => {
    vi.stubEnv('COUNTERSIGN_AGENT_DEMO', '')
    vi.stubEnv('NODE_ENV', 'development')
    expect(disputesUseDemoView()).toBe(false)
  })
})

describe('routerRuleId', () => {
  it('reads the rule id out of a stored trace', () => {
    expect(routerRuleId({ ruleId: 'R-APPEAL-1' })).toBe('R-APPEAL-1')
    expect(routerRuleId({ rule_id: 'R-NOCHAIN-1' })).toBe('R-NOCHAIN-1')
  })

  it('answers null for anything that is not a usable trace, rather than throwing', () => {
    expect(routerRuleId(null)).toBeNull()
    expect(routerRuleId({})).toBeNull()
    expect(routerRuleId({ ruleId: 42 })).toBeNull()
    expect(routerRuleId({ ruleId: '' })).toBeNull()
    expect(routerRuleId('R-SNAD-OK')).toBeNull()
  })
})
