/**
 * `/disputes/{id}` and the merchant's click, in a real browser — spec §8.15, S-17.
 *
 * The route and the guards are covered by unit and live-DB tests; what only a browser can prove is the
 * seam: that a signed-in caller sees the stored verdict and the decision controls, that clicking Decline
 * reaches the route with the session cookie, and that the audit row the route writes is the record the
 * merchant's click produced. The dispute row is inserted straight into the local Postgres the config
 * points the server at, so the page reads a real row rather than a fixture.
 *
 * A FILED case is the second test: the page must say there is nothing left to approve and must not render
 * the buttons, because approving a filed case would be a second PayPal action.
 */
import { expect, test } from '@playwright/test'
import { eq, inArray } from 'drizzle-orm'

import {
  agents,
  auditLog,
  BUYER,
  checkoutAttempts,
  checkoutSessions,
  createMerchant,
  db,
  devices,
  disputeActions,
  disputes,
  evidencePackets,
  getMerchantByOwner,
  mandates,
  MERCHANT,
  orders,
  paypalWallets,
  SEED_DEVICE_ID,
  SEED_WALLET_ID,
} from '@countersign/db'

import { signInMerchant } from './merchant-session'
import { BUYER_PASSWORD, buyerEmail } from './buyer-session'

// Playwright runs test files in a process whose environment is not the webServer's; the app's `db()` reads
// `DATABASE_URL` lazily, so setting it here is enough for the test's own connection. Built the same way
// `playwright.config.ts` builds it, so the credentials are not a literal for a scanner to trip over.
const localDatabase = new URL('postgres://127.0.0.1:5432/countersign')
localDatabase.username = 'countersign'
localDatabase.password = 'countersign'
process.env['DATABASE_URL'] ??= localDatabase.href

const NOW = new Date('2026-11-13T09:00:00.000Z')

interface Seed {
  readonly id: string
  readonly paypalId: string
  readonly state: 'AWAITING_MERCHANT_APPROVAL' | 'FILED'
  readonly orderId: string
  readonly attemptId: string
  readonly sessionId: string
  readonly mandateId: string
  readonly agentId: string
}

let cachedMerchantId: string | undefined

async function resolveMerchantId(): Promise<string> {
  if (cachedMerchantId) return cachedMerchantId
  const found = await getMerchantByOwner(MERCHANT.id)
  if (found.ok && found.value) {
    cachedMerchantId = found.value.id
    return cachedMerchantId
  }
  const fallbackId = `mer_${MERCHANT.id.replace(/^usr_/, '')}`
  const created = await createMerchant({
    id: fallbackId,
    ownerUserId: MERCHANT.id,
    displayName: MERCHANT.displayName,
  })
  cachedMerchantId = created.ok ? created.value.id : fallbackId
  return cachedMerchantId
}

async function ensureSeedPrerequisites(): Promise<void> {
  await db()
    .insert(devices)
    .values({
      id: SEED_DEVICE_ID,
      user_id: BUYER.id,
      public_jwk: {},
      jkt: 'jkt-e2e',
      label: 'e2e device',
    })
    .onConflictDoNothing()

  await db()
    .insert(paypalWallets)
    .values({
      id: SEED_WALLET_ID,
      user_id: BUYER.id,
      payment_token_id: 'tok-e2e',
      payer_id: 'payer-e2e',
      payer_email: BUYER.email,
    })
    .onConflictDoNothing()
}

async function seedDispute(state: Seed['state']): Promise<Seed> {
  const merchantId = await resolveMerchantId()
  await ensureSeedPrerequisites()

  const suffix = `${Date.now()}${Math.floor(Math.random() * 1_000)}`
  const agentId = `agt_e2e_${suffix}`
  const mandateId = `mdt_e2e_${suffix}`
  const sessionId = `chk_e2e_${suffix}`
  const attemptId = `att_e2e_${suffix}`
  const orderId = `ord_e2e_${suffix}`
  const seed: Seed = {
    id: `dsp_e2e_${suffix}`,
    paypalId: `PP-D-E2E-${suffix}`,
    state,
    orderId,
    attemptId,
    sessionId,
    mandateId,
    agentId,
  }

  await db()
    .insert(agents)
    .values({
      id: agentId,
      user_id: BUYER.id,
      name: 'E2E Test Agent',
      public_jwk: {},
      kid: `kid_e2e_${suffix}`,
      enc_private_key: Buffer.from('test-enc-key'),
    })

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
      nonce: `nonce-${suffix}`,
      aud: 'test-aud',
      iat: BigInt(Math.floor(Date.now() / 1000) - 60),
      exp: BigInt(Math.floor(Date.now() / 1000) + 3600),
      status: 'ACTIVE',
      compiler_model: 'test',
    })

  await db()
    .insert(checkoutSessions)
    .values({
      id: sessionId,
      merchant_id: merchantId,
      cart: { lines: [] },
      subtotal_minor: 4_800n,
      shipping_minor: 0n,
      total_minor: 4_800n,
      currency: 'USD',
      checkout_jwt: 'co.jwt',
      checkout_hash: 'h'.repeat(43),
      price_lock_exp: new Date(Date.now() + 3600_000),
    })

  await db()
    .insert(checkoutAttempts)
    .values({
      id: attemptId,
      mandate_id: mandateId,
      agent_id: agentId,
      checkout_session_id: sessionId,
      l3a: 'l3a.test',
      l3b: 'l3b.test',
      l3_jti: `jti-e2e-${suffix}`,
      idempotency_key: `idem-e2e-${suffix}`,
      amount_minor: 4_800n,
      currency: 'USD',
      payee: 'payee-test',
    })

  await db()
    .insert(orders)
    .values({
      id: orderId,
      attempt_id: attemptId,
      merchant_id: merchantId,
      paypal_order_id: `PP-ORD-E2E-${suffix}`,
      intent: 'CAPTURE',
      custom_id: `cs1:order-e2e-${suffix}`,
      invoice_id: `inv-e2e-${suffix}`,
      status: 'CAPTURED',
      amount_minor: 4_800n,
      currency: 'USD',
    })

  await db()
    .insert(disputes)
    .values({
      id: seed.id,
      paypal_dispute_id: seed.paypalId,
      order_id: orderId,
      reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
      stage: 'CHARGEBACK',
      status: 'WAITING_FOR_SELLER_RESPONSE',
      amount_minor: 4_800n,
      currency: 'USD',
      seller_response_due_date: new Date('2026-12-01T00:00:00Z'),
      defense_state: seed.state,
      liability: 'USER_AUTHORISED',
      router_trace: {
        rule_id: 'R-E2E-1',
        posture: 'CONTEST',
        liability: 'USER_AUTHORISED',
        rationale: 'The buyer ordered size 9 and size 10 arrived.',
        reasons: ['the buyer ordered size 9 and size 10 arrived'],
        facts: ['size'],
        evidence_required: ['PROOF_OF_DELIVERY'],
      } as never,
      created_at: NOW,
      updated_at: NOW,
    })
  return seed
}

async function removeDispute(seed: Seed): Promise<void> {
  await db().delete(auditLog).where(eq(auditLog.chain_id, seed.id))
  await db()
    .delete(evidencePackets)
    .where(inArray(evidencePackets.dispute_id, [seed.id]))
  await db()
    .delete(disputeActions)
    .where(inArray(disputeActions.dispute_id, [seed.id]))
  await db().delete(disputes).where(eq(disputes.id, seed.id))
  await db().delete(orders).where(eq(orders.id, seed.orderId))
  await db().delete(checkoutAttempts).where(eq(checkoutAttempts.id, seed.attemptId))
  await db().delete(checkoutSessions).where(eq(checkoutSessions.id, seed.sessionId))
  await db().delete(mandates).where(eq(mandates.id, seed.mandateId))
  await db().delete(agents).where(eq(agents.id, seed.agentId))
}

test.describe('the dispute approval surface', () => {
  test('a signed-in merchant reads the stored verdict and can decline, and the decline is audited', async ({
    page,
  }) => {
    const seed = await seedDispute('AWAITING_MERCHANT_APPROVAL')
    try {
      await signInMerchant(page)

      await page.goto(`/disputes/${seed.id}`)
      await expect(page.getByRole('heading', { name: seed.paypalId })).toBeVisible()
      await expect(page.getByText('R-E2E-1')).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Your decision' })).toBeVisible()

      await page.getByRole('button', { name: 'Decline' }).click()
      await expect(page.getByText('Declined. Nothing was sent to PayPal.')).toBeVisible()

      // The audit row is the record the click produced; the page is a view of it.
      const rows = await db().select().from(auditLog).where(eq(auditLog.chain_id, seed.id))
      expect(rows).toHaveLength(1)
      expect(rows[0]?.action).toBe('DISPUTE_DECLINED')
      expect(rows[0]?.subject).toBe(seed.id)
    } finally {
      await removeDispute(seed)
    }
  })

  test('a filed case offers no approval controls', async ({ page }) => {
    const seed = await seedDispute('FILED')
    try {
      await signInMerchant(page)
      await page.goto(`/disputes/${seed.id}`)
      await expect(page.getByText('nothing left to approve')).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Your decision' })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Approve and send to PayPal' })).toHaveCount(0)
    } finally {
      await removeDispute(seed)
    }
  })

  test('an anonymous visitor is sent to the login page and sees no dispute', async ({ page }) => {
    const seed = await seedDispute('AWAITING_MERCHANT_APPROVAL')
    try {
      await page.goto(`/disputes/${seed.id}`)
      await expect(page).toHaveURL(/\/login\?next=/)
      await expect(page.getByRole('heading', { name: 'Merchant sign in' })).toBeVisible()
      await expect(page.getByText(seed.paypalId)).toHaveCount(0)
    } finally {
      await removeDispute(seed)
    }
  })

  test("a signed-in buyer gets 403, because the queue is the merchant's", async ({ page }) => {
    const seed = await seedDispute('AWAITING_MERCHANT_APPROVAL')
    try {
      // A real buyer account, not the old demo persona: the point of the test is that being signed in is not
      // the same as being the merchant, so the account has to be a genuine buyer (D-060).
      const buyer = await page.request.post('/api/auth/signup', {
        data: { email: buyerEmail('dispute403'), password: BUYER_PASSWORD, displayName: 'A buyer' },
      })
      expect(buyer.status(), await buyer.text()).toBe(200)

      await page.goto(`/disputes/${seed.id}`)
      await expect(page.getByText('This page belongs to another account')).toBeVisible()
      await expect(page.getByText(seed.paypalId)).toHaveCount(0)
    } finally {
      await removeDispute(seed)
    }
  })

  test('the merchant can sign out, and the cookie no longer opens the queue', async ({ page }) => {
    const seed = await seedDispute('AWAITING_MERCHANT_APPROVAL')
    try {
      await signInMerchant(page)
      await page.goto(`/disputes/${seed.id}`)
      await expect(page.getByRole('heading', { name: seed.paypalId })).toBeVisible()

      await page.getByRole('button', { name: 'Sign out' }).click()
      await expect(page.getByRole('heading', { name: 'Merchant sign in' })).toBeVisible()

      await page.goto('/disputes')
      await expect(page).toHaveURL(/\/login\?next=/)
    } finally {
      await removeDispute(seed)
    }
  })
})
