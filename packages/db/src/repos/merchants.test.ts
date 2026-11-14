/**
 * Live database tests for `merchants` repository and `orders.merchant_id` foreign key.
 *
 * Exercises the repository against a live Postgres instance:
 *  - create a merchant and read back with getMerchantById and getMerchantByOwner
 *  - second merchant for the same owner rejected with CS_CONFLICT (merchants_owner_user_id_key)
 *  - two different users can each have their own merchant
 *  - setPaypalMerchantId updates field, duplicate rejected with CS_CONFLICT (merchants_paypal_merchant_id_key)
 *  - order with valid merchant_id succeeds; order with invalid merchant_id rejected by FK
 */
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'

import type {
  AttemptId,
  CheckoutId,
  DeviceId,
  MandateId,
  OrderId,
  UserId,
  WalletId,
} from '@countersign/core'

import { closeDb, db } from '../client'
import { createOrder } from './orders'
import {
  createMerchant,
  getMerchantById,
  getMerchantByOwner,
  getMerchantByPaypalMerchantId,
  setPaypalMerchantId,
} from './merchants'
import {
  agents,
  checkoutAttempts,
  checkoutSessions,
  devices,
  mandates,
  merchants,
  orders,
  paypalWallets,
  users,
} from '../schema'

const hasDatabase = (process.env['DATABASE_URL'] ?? '').trim() !== ''

const createdUserIds: string[] = []
const createdMerchantIds: string[] = []
const createdDeviceIds: string[] = []
const createdWalletIds: string[] = []
const createdAgentIds: string[] = []
const createdMandateIds: string[] = []
const createdSessionIds: string[] = []
const createdAttemptIds: string[] = []
const createdOrderIds: string[] = []

function uid(): string {
  return randomUUID().replace(/-/g, '').slice(0, 16)
}

afterAll(async () => {
  if (!hasDatabase) return

  // Clean up in reverse foreign key order
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

describe.skipIf(!hasDatabase)('merchants repository (live database)', () => {
  it('creates a merchant and reads it back by id and by owner', async () => {
    const userId = `usr_live_mrc_${uid()}` as UserId
    createdUserIds.push(userId)

    const userRows = await db()
      .insert(users)
      .values({
        id: userId,
        persona: 'MERCHANT',
        display_name: 'Merchant Owner 1',
        email: `merchant1-${uid()}@example.test`,
        country: 'US',
      })
      .returning()
    expect(userRows[0]).toBeDefined()

    const created = await createMerchant({
      ownerUserId: userId,
      displayName: 'Acme Supplies',
    })
    expect(created.ok, created.ok ? '' : created.error.message).toBe(true)
    if (!created.ok) return
    createdMerchantIds.push(created.value.id)

    expect(created.value.id.startsWith('mer_')).toBe(true)
    expect(created.value.owner_user_id).toBe(userId)
    expect(created.value.display_name).toBe('Acme Supplies')
    expect(created.value.status).toBe('ACTIVE')
    expect(created.value.paypal_merchant_id).toBeNull()

    const byId = await getMerchantById(created.value.id)
    expect(byId.ok).toBe(true)
    if (byId.ok) {
      expect(byId.value).toBeDefined()
      expect(byId.value?.id).toBe(created.value.id)
      expect(byId.value?.owner_user_id).toBe(userId)
      expect(byId.value?.display_name).toBe('Acme Supplies')
    }

    const byOwner = await getMerchantByOwner(userId)
    expect(byOwner.ok).toBe(true)
    if (byOwner.ok) {
      expect(byOwner.value).toBeDefined()
      expect(byOwner.value?.id).toBe(created.value.id)
      expect(byOwner.value?.owner_user_id).toBe(userId)
      expect(byOwner.value?.display_name).toBe('Acme Supplies')
    }
  })

  it('rejects a second merchant for the same owner with CS_CONFLICT (merchants_owner_user_id_key)', async () => {
    const userId = `usr_live_mrc_${uid()}` as UserId
    createdUserIds.push(userId)

    await db()
      .insert(users)
      .values({
        id: userId,
        persona: 'MERCHANT',
        display_name: 'Merchant Single Owner',
        email: `single-owner-${uid()}@example.test`,
        country: 'US',
      })

    const first = await createMerchant({
      ownerUserId: userId,
      displayName: 'First Store',
    })
    expect(first.ok).toBe(true)
    if (first.ok) createdMerchantIds.push(first.value.id)

    const duplicate = await createMerchant({
      ownerUserId: userId,
      displayName: 'Second Store Attempt',
    })
    expect(duplicate.ok).toBe(false)
    if (duplicate.ok) return

    expect(duplicate.error.code).toBe('CS_CONFLICT')
    expect(duplicate.error.details?.['constraint']).toBe('merchants_owner_user_id_key')
    expect(duplicate.error.details?.['pgCode']).toBe('23505')
  })

  it('allows two different users to each have their own merchant', async () => {
    const userA = `usr_live_mrc_${uid()}` as UserId
    const userB = `usr_live_mrc_${uid()}` as UserId
    createdUserIds.push(userA, userB)

    await db()
      .insert(users)
      .values([
        {
          id: userA,
          persona: 'MERCHANT',
          display_name: 'Owner A',
          email: `owner-a-${uid()}@example.test`,
          country: 'US',
        },
        {
          id: userB,
          persona: 'MERCHANT',
          display_name: 'Owner B',
          email: `owner-b-${uid()}@example.test`,
          country: 'US',
        },
      ])

    const merchantA = await createMerchant({
      ownerUserId: userA,
      displayName: 'Store A',
    })
    const merchantB = await createMerchant({
      ownerUserId: userB,
      displayName: 'Store B',
    })

    expect(merchantA.ok).toBe(true)
    expect(merchantB.ok).toBe(true)
    if (!merchantA.ok || !merchantB.ok) return

    createdMerchantIds.push(merchantA.value.id, merchantB.value.id)
    expect(merchantA.value.id).not.toBe(merchantB.value.id)

    const foundA = await getMerchantByOwner(userA)
    const foundB = await getMerchantByOwner(userB)
    expect(foundA.ok && foundA.value?.id).toBe(merchantA.value.id)
    expect(foundB.ok && foundB.value?.id).toBe(merchantB.value.id)
  })

  it('updates paypal_merchant_id and rejects duplicates with CS_CONFLICT', async () => {
    const user1 = `usr_live_mrc_${uid()}` as UserId
    const user2 = `usr_live_mrc_${uid()}` as UserId
    createdUserIds.push(user1, user2)

    await db()
      .insert(users)
      .values([
        {
          id: user1,
          persona: 'MERCHANT',
          display_name: 'PayPal Test User 1',
          email: `paypal-1-${uid()}@example.test`,
          country: 'US',
        },
        {
          id: user2,
          persona: 'MERCHANT',
          display_name: 'PayPal Test User 2',
          email: `paypal-2-${uid()}@example.test`,
          country: 'US',
        },
      ])

    const m1 = await createMerchant({ ownerUserId: user1, displayName: 'PayPal Store 1' })
    const m2 = await createMerchant({ ownerUserId: user2, displayName: 'PayPal Store 2' })
    expect(m1.ok && m2.ok).toBe(true)
    if (!m1.ok || !m2.ok) return
    createdMerchantIds.push(m1.value.id, m2.value.id)

    const paypalId = `PPMID_${uid().toUpperCase()}`
    const updated = await setPaypalMerchantId(m1.value.id, paypalId)
    expect(updated.ok).toBe(true)
    if (updated.ok) {
      expect(updated.value.paypal_merchant_id).toBe(paypalId)
    }

    const fetched = await getMerchantById(m1.value.id)
    expect(fetched.ok && fetched.value?.paypal_merchant_id).toBe(paypalId)

    // Attempting to set the same paypalMerchantId on another merchant must fail with CS_CONFLICT
    const duplicate = await setPaypalMerchantId(m2.value.id, paypalId)
    expect(duplicate.ok).toBe(false)
    if (duplicate.ok) return

    expect(duplicate.error.code).toBe('CS_CONFLICT')
    expect(duplicate.error.details?.['constraint']).toBe('merchants_paypal_merchant_id_key')
    expect(duplicate.error.details?.['pgCode']).toBe('23505')
  })

  it('looks up a merchant by PayPal merchant id', async () => {
    const userId = `usr_live_mrc_${uid()}` as UserId
    createdUserIds.push(userId)

    await db()
      .insert(users)
      .values({
        id: userId,
        persona: 'MERCHANT',
        display_name: 'PayPal Lookup Owner',
        email: `paypal-lookup-${uid()}@example.test`,
        country: 'US',
      })

    const paypalId = `PPMID_${uid().toUpperCase()}`
    const created = await createMerchant({
      ownerUserId: userId,
      displayName: 'PayPal Lookup Store',
      paypalMerchantId: paypalId,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    createdMerchantIds.push(created.value.id)

    const found = await getMerchantByPaypalMerchantId(paypalId)
    expect(found.ok).toBe(true)
    if (found.ok) {
      expect(found.value).toBeDefined()
      expect(found.value?.id).toBe(created.value.id)
      expect(found.value?.paypal_merchant_id).toBe(paypalId)
    }

    const missing = await getMerchantByPaypalMerchantId(`NON_EXISTENT_${uid()}`)
    expect(missing.ok).toBe(true)
    if (missing.ok) {
      expect(missing.value).toBeUndefined()
    }
  })

  it('links order row with merchant_id cleanly and rejects invalid merchant_id by FK constraint', async () => {
    const ownerId = `usr_live_mrc_${uid()}` as UserId
    createdUserIds.push(ownerId)

    await db()
      .insert(users)
      .values({
        id: ownerId,
        persona: 'MERCHANT',
        display_name: 'Order Merchant Owner',
        email: `ord-owner-${uid()}@example.test`,
        country: 'US',
      })

    const m = await createMerchant({ ownerUserId: ownerId, displayName: 'Order Store' })
    expect(m.ok).toBe(true)
    if (!m.ok) return
    createdMerchantIds.push(m.value.id)

    // Build the prerequisite chain for checkout attempts
    const buyerId = `usr_live_byr_${uid()}` as UserId
    createdUserIds.push(buyerId)
    await db()
      .insert(users)
      .values({
        id: buyerId,
        persona: 'BUYER',
        display_name: 'Order Buyer',
        email: `ord-buyer-${uid()}@example.test`,
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
        nl_intent: 'test order mandate',
        readback: 'test order readback',
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

    const attemptId1 = `att_live_${uid()}` as AttemptId
    const attemptId2 = `att_live_${uid()}` as AttemptId
    createdAttemptIds.push(attemptId1, attemptId2)

    await db()
      .insert(checkoutAttempts)
      .values([
        {
          id: attemptId1,
          mandate_id: mandateId,
          agent_id: agentId,
          checkout_session_id: sessionId,
          l3a: 'l3a.1',
          l3b: 'l3b.1',
          l3_jti: `jti-${uid()}`,
          idempotency_key: `idem-${uid()}`,
          amount_minor: 1000n,
          currency: 'USD',
          payee: 'payee-1',
        },
        {
          id: attemptId2,
          mandate_id: mandateId,
          agent_id: agentId,
          checkout_session_id: sessionId,
          l3a: 'l3a.2',
          l3b: 'l3b.2',
          l3_jti: `jti-${uid()}`,
          idempotency_key: `idem-${uid()}`,
          amount_minor: 1000n,
          currency: 'USD',
          payee: 'payee-2',
        },
      ])

    // Valid merchant_id succeeds
    const orderId1 = `ord_live_${uid()}` as OrderId
    createdOrderIds.push(orderId1)
    const validOrder = await createOrder({
      id: orderId1,
      attempt_id: attemptId1,
      merchant_id: m.value.id,
      paypal_order_id: `pp-order-${uid()}`,
      intent: 'AUTHORIZE',
      custom_id: `cs1:test-${uid()}`,
      invoice_id: `inv-${uid()}`,
      amount_minor: 1000n,
      currency: 'USD',
    })

    expect(validOrder.ok, validOrder.ok ? '' : validOrder.error.message).toBe(true)
    if (validOrder.ok) {
      expect(validOrder.value.merchant_id).toBe(m.value.id)
    }

    // Invalid merchant_id fails with foreign key violation
    const orderId2 = `ord_live_${uid()}` as OrderId
    const invalidMerchantId = `mer_invalid_${uid()}`
    const invalidOrder = await createOrder({
      id: orderId2,
      attempt_id: attemptId2,
      merchant_id: invalidMerchantId,
      paypal_order_id: `pp-order-${uid()}`,
      intent: 'AUTHORIZE',
      custom_id: `cs1:test-${uid()}`,
      invoice_id: `inv-${uid()}`,
      amount_minor: 1000n,
      currency: 'USD',
    })

    expect(invalidOrder.ok).toBe(false)
    if (invalidOrder.ok) return

    expect(invalidOrder.error.details?.['pgCode']).toBe('23503')
    expect(invalidOrder.error.details?.['constraint']).toBe('orders_merchant_id_merchants_id_fk')
  })
})
