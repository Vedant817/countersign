/**
 * Live database tests for merchant-scoped dispute queries:
 *  - listDisputesForMerchant
 *  - findDisputeForMerchant
 *
 * Verifies that disputes are strictly isolated by merchant via the dispute -> order -> merchant relationship.
 */
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'

import type {
  AttemptId,
  CheckoutId,
  DeviceId,
  DisputeId,
  MandateId,
  OrderId,
  UserId,
  WalletId,
} from '@countersign/core'

import { closeDb, db } from '../client'
import { createOrder } from './orders'
import { createMerchant } from './merchants'
import { createDispute, findDisputeForMerchant, listDisputesForMerchant } from './disputes'
import {
  agents,
  checkoutAttempts,
  checkoutSessions,
  devices,
  disputes,
  mandates,
  merchants,
  orders,
  paypalWallets,
  users,
} from '../schema'

const hasDatabase = (process.env['DATABASE_URL'] ?? '').trim() !== ''

const createdDisputeIds: DisputeId[] = []
const createdOrderIds: string[] = []
const createdAttemptIds: string[] = []
const createdSessionIds: string[] = []
const createdMandateIds: string[] = []
const createdAgentIds: string[] = []
const createdWalletIds: string[] = []
const createdDeviceIds: string[] = []
const createdMerchantIds: string[] = []
const createdUserIds: string[] = []

function uid(): string {
  return randomUUID().replace(/-/g, '').slice(0, 16)
}

afterAll(async () => {
  if (!hasDatabase) return

  // Clean up in reverse foreign key order
  for (const id of createdDisputeIds) {
    await db().delete(disputes).where(eq(disputes.id, id))
  }
  for (const id of createdOrderIds) {
    await db().delete(orders).where(eq(orders.id, id))
  }
  for (const id of createdAttemptIds) {
    await db().delete(checkoutAttempts).where(eq(checkoutAttempts.id, id))
  }
  for (const id of createdSessionIds) {
    await db().delete(checkoutSessions).where(eq(checkoutSessions.id, id))
  }
  for (const id of createdMandateIds) {
    await db().delete(mandates).where(eq(mandates.id, id))
  }
  for (const id of createdAgentIds) {
    await db().delete(agents).where(eq(agents.id, id))
  }
  for (const id of createdWalletIds) {
    await db().delete(paypalWallets).where(eq(paypalWallets.id, id))
  }
  for (const id of createdDeviceIds) {
    await db().delete(devices).where(eq(devices.id, id))
  }
  for (const id of createdMerchantIds) {
    await db().delete(merchants).where(eq(merchants.id, id))
  }
  for (const id of createdUserIds) {
    await db().delete(users).where(eq(users.id, id))
  }

  await closeDb()
})

describe.skipIf(!hasDatabase)('disputes merchant scope isolation (live database)', () => {
  it('isolates disputes between merchants and handles orphan disputes', async () => {
    // 1. Create two merchant owner users and their merchants
    const userAId = `usr_live_mrc_a_${uid()}` as UserId
    const userBId = `usr_live_mrc_b_${uid()}` as UserId
    createdUserIds.push(userAId, userBId)

    await db()
      .insert(users)
      .values([
        {
          id: userAId,
          persona: 'MERCHANT',
          display_name: 'Merchant Owner A',
          email: `mrc-a-${uid()}@example.test`,
          country: 'US',
        },
        {
          id: userBId,
          persona: 'MERCHANT',
          display_name: 'Merchant Owner B',
          email: `mrc-b-${uid()}@example.test`,
          country: 'US',
        },
      ])

    const merchantAResult = await createMerchant({
      ownerUserId: userAId,
      displayName: 'Merchant A',
    })
    expect(merchantAResult.ok).toBe(true)
    if (!merchantAResult.ok) return
    const merchantA = merchantAResult.value
    createdMerchantIds.push(merchantA.id)

    const merchantBResult = await createMerchant({
      ownerUserId: userBId,
      displayName: 'Merchant B',
    })
    expect(merchantBResult.ok).toBe(true)
    if (!merchantBResult.ok) return
    const merchantB = merchantBResult.value
    createdMerchantIds.push(merchantB.id)

    // 2. Create common buyer chain for orders
    const buyerId = `usr_live_buyer_${uid()}` as UserId
    createdUserIds.push(buyerId)
    await db()
      .insert(users)
      .values({
        id: buyerId,
        persona: 'BUYER',
        display_name: 'Dispute Buyer',
        email: `buyer-${uid()}@example.test`,
        country: 'US',
      })

    const deviceId = `dev_live_${uid()}` as DeviceId
    createdDeviceIds.push(deviceId)
    await db()
      .insert(devices)
      .values({
        id: deviceId,
        user_id: buyerId,
        public_jwk: {},
        jkt: `jkt-${uid()}`,
        label: 'test device',
      })

    const walletId = `wal_live_${uid()}` as WalletId
    createdWalletIds.push(walletId)
    await db()
      .insert(paypalWallets)
      .values({
        id: walletId,
        user_id: buyerId,
        payment_token_id: `tok-${uid()}`,
        payer_id: `payer-${uid()}`,
        payer_email: `payer-${uid()}@example.test`,
      })

    const agentId = `agt_live_${uid()}` as string
    createdAgentIds.push(agentId)
    await db()
      .insert(agents)
      .values({
        id: agentId,
        user_id: buyerId,
        name: 'test agent',
        public_jwk: {},
        kid: `kid-${uid()}`,
        enc_private_key: Buffer.from('enc-key'),
      })

    const mandateId = `mdt_live_${uid()}` as MandateId
    createdMandateIds.push(mandateId)
    await db()
      .insert(mandates)
      .values({
        id: mandateId,
        user_id: buyerId,
        device_id: deviceId,
        agent_id: agentId,
        wallet_id: walletId,
        l2_serialized: 'l2.test',
        l2_payload: {},
        nl_intent: 'test dispute mandate',
        readback: 'test dispute readback',
        constraints: {},
        nonce: `nonce-${uid()}`,
        aud: 'test-aud',
        iat: BigInt(Math.floor(Date.now() / 1000) - 60),
        exp: BigInt(Math.floor(Date.now() / 1000) + 3600),
        status: 'ACTIVE',
        compiler_model: 'test',
      })

    const sessionId = `chk_live_${uid()}` as CheckoutId
    createdSessionIds.push(sessionId)
    await db()
      .insert(checkoutSessions)
      .values({
        id: sessionId,
        merchant_id: 'mrc_test',
        cart: { lines: [] },
        subtotal_minor: 1000n,
        shipping_minor: 0n,
        total_minor: 1000n,
        currency: 'USD',
        checkout_jwt: 'co.jwt',
        checkout_hash: 'h'.repeat(43),
        price_lock_exp: new Date(Date.now() + 3600_000),
      })

    const attemptIdA = `att_live_${uid()}` as AttemptId
    const attemptIdB = `att_live_${uid()}` as AttemptId
    createdAttemptIds.push(attemptIdA, attemptIdB)
    await db()
      .insert(checkoutAttempts)
      .values([
        {
          id: attemptIdA,
          mandate_id: mandateId,
          agent_id: agentId,
          checkout_session_id: sessionId,
          l3a: 'l3a.a',
          l3b: 'l3b.a',
          l3_jti: `jti-${uid()}`,
          idempotency_key: `idem-${uid()}`,
          amount_minor: 1000n,
          currency: 'USD',
          payee: 'payee-a',
        },
        {
          id: attemptIdB,
          mandate_id: mandateId,
          agent_id: agentId,
          checkout_session_id: sessionId,
          l3a: 'l3a.b',
          l3b: 'l3b.b',
          l3_jti: `jti-${uid()}`,
          idempotency_key: `idem-${uid()}`,
          amount_minor: 2000n,
          currency: 'USD',
          payee: 'payee-b',
        },
      ])

    // 3. Create order A (merchant A) and order B (merchant B)
    const orderIdA = `ord_live_${uid()}` as OrderId
    const orderIdB = `ord_live_${uid()}` as OrderId
    createdOrderIds.push(orderIdA, orderIdB)

    const orderAResult = await createOrder({
      id: orderIdA,
      attempt_id: attemptIdA,
      merchant_id: merchantA.id,
      paypal_order_id: `pp-order-${uid()}`,
      intent: 'CAPTURE',
      custom_id: `cs1:order-a-${uid()}`,
      invoice_id: `inv-${uid()}`,
      amount_minor: 1000n,
      currency: 'USD',
    })
    expect(orderAResult.ok).toBe(true)

    const orderBResult = await createOrder({
      id: orderIdB,
      attempt_id: attemptIdB,
      merchant_id: merchantB.id,
      paypal_order_id: `pp-order-${uid()}`,
      intent: 'CAPTURE',
      custom_id: `cs1:order-b-${uid()}`,
      invoice_id: `inv-${uid()}`,
      amount_minor: 2000n,
      currency: 'USD',
    })
    expect(orderBResult.ok).toBe(true)

    // 4. Create disputes:
    // Dispute A on Order A
    // Dispute B on Order B
    // Orphan dispute with order_id = null
    const disputeIdA = `dsp_live_${uid()}` as DisputeId
    const disputeIdB = `dsp_live_${uid()}` as DisputeId
    const disputeIdOrphan = `dsp_live_${uid()}` as DisputeId
    createdDisputeIds.push(disputeIdA, disputeIdB, disputeIdOrphan)

    const disputeAResult = await createDispute({
      id: disputeIdA,
      paypal_dispute_id: `pp-dsp-${uid()}`,
      order_id: orderIdA,
      reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      stage: 'CHARGEBACK',
      status: 'WAITING_FOR_SELLER_RESPONSE',
      amount_minor: 1000n,
      currency: 'USD',
    })
    expect(disputeAResult.ok).toBe(true)

    const disputeBResult = await createDispute({
      id: disputeIdB,
      paypal_dispute_id: `pp-dsp-${uid()}`,
      order_id: orderIdB,
      reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      stage: 'CHARGEBACK',
      status: 'WAITING_FOR_SELLER_RESPONSE',
      amount_minor: 2000n,
      currency: 'USD',
    })
    expect(disputeBResult.ok).toBe(true)

    const disputeOrphanResult = await createDispute({
      id: disputeIdOrphan,
      paypal_dispute_id: `pp-dsp-${uid()}`,
      order_id: null,
      reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      stage: 'CHARGEBACK',
      status: 'WAITING_FOR_SELLER_RESPONSE',
      amount_minor: 3000n,
      currency: 'USD',
    })
    expect(disputeOrphanResult.ok).toBe(true)

    // 5. Assertions:
    // listDisputesForMerchant(A) contains A's dispute and NOT B's and NOT the orphan
    const listA = await listDisputesForMerchant(merchantA.id, 50)
    expect(listA.ok).toBe(true)
    if (!listA.ok) return
    const idsA = listA.value.map((d) => d.id)
    expect(idsA).toContain(disputeIdA)
    expect(idsA).not.toContain(disputeIdB)
    expect(idsA).not.toContain(disputeIdOrphan)

    // listDisputesForMerchant(B) contains B's dispute and NOT A's and NOT the orphan
    const listB = await listDisputesForMerchant(merchantB.id, 50)
    expect(listB.ok).toBe(true)
    if (!listB.ok) return
    const idsB = listB.value.map((d) => d.id)
    expect(idsB).toContain(disputeIdB)
    expect(idsB).not.toContain(disputeIdA)
    expect(idsB).not.toContain(disputeIdOrphan)

    // findDisputeForMerchant(A's dispute, A) returns it
    const findAonA = await findDisputeForMerchant(disputeIdA, merchantA.id)
    expect(findAonA.ok).toBe(true)
    if (!findAonA.ok) return
    expect(findAonA.value?.id).toBe(disputeIdA)

    // findDisputeForMerchant(A's dispute, B) returns undefined
    const findAonB = await findDisputeForMerchant(disputeIdA, merchantB.id)
    expect(findAonB.ok).toBe(true)
    if (!findAonB.ok) return
    expect(findAonB.value).toBeUndefined()

    // findDisputeForMerchant(orphan, A) returns undefined
    const findOrphanOnA = await findDisputeForMerchant(disputeIdOrphan, merchantA.id)
    expect(findOrphanOnA.ok).toBe(true)
    if (!findOrphanOnA.ok) return
    expect(findOrphanOnA.value).toBeUndefined()
  })
})
