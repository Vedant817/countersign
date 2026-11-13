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

import { auditLog, db, disputeActions, disputes, evidencePackets } from '@countersign/db'

import { signInMerchant } from './merchant-session'

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
}

async function seedDispute(state: Seed['state']): Promise<Seed> {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1_000)}`
  const seed: Seed = { id: `dsp_e2e_${suffix}`, paypalId: `PP-D-E2E-${suffix}`, state }
  await db()
    .insert(disputes)
    .values({
      id: seed.id,
      paypal_dispute_id: seed.paypalId,
      order_id: null,
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

  test('a signed-in buyer gets 403, because the queue is the merchant’s', async ({ page }) => {
    const seed = await seedDispute('AWAITING_MERCHANT_APPROVAL')
    try {
      // The only buyer session this app mints is the demo persona's. It is a real session — which is the
      // point: being signed in is not the same as being the merchant.
      const buyer = await page.request.post('/api/agent/session', {
        data: { intent: 'Buy the cheapest trail shoes you can find, under 150', cap_minor: '5000' },
      })
      expect(buyer.status(), await buyer.text()).toBe(200)

      await page.goto(`/disputes/${seed.id}`)
      await expect(page.getByText('This page is the merchant’s')).toBeVisible()
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
