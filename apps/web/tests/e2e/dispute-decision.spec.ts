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
import { eq } from 'drizzle-orm'

import { auditLog, db } from '@countersign/db'

import { signInMerchant } from './merchant-session'
import { BUYER_PASSWORD, buyerEmail } from './buyer-session'
import { removeDispute, seedDispute } from './seed-merchant-dispute'

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
