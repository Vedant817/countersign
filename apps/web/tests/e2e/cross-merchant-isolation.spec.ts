/**
 * Cross-merchant isolation E2E test — Priority C, Part 8.
 *
 * Proves that:
 * 1. Merchant B cannot see Merchant A's dispute on /disputes.
 * 2. Merchant B cannot access Merchant A's dispute detail page (/disputes/[id]) -> 404 not found,
 *    and no dispute details (amount, order id, buyer) are rendered.
 * 3. Merchant B cannot decide Merchant A's dispute via POST /api/disputes/[id]/decision ->
 *    returns 403 or 404, leaves the dispute row in the database completely unchanged, and creates no audit rows.
 * 4. Merchant A signing in CAN see their dispute on the dispute detail page (/disputes/[id]),
 *    proving the dispute was not simply invisible to everyone.
 * 5. Full cleanup of seeded dispute, order, attempt, session, mandate, agent, and merchant B's user/merchant rows.
 */
import { expect, test } from '@playwright/test'
import { eq } from 'drizzle-orm'

import { auditLog, db, disputes, merchants, users } from '@countersign/db'

import { signInMerchant } from './merchant-session'
import { removeDispute, seedDispute } from './seed-merchant-dispute'

test.describe('cross-merchant isolation', () => {
  test("one merchant cannot see, access, or decide another merchant's dispute", async ({
    page,
  }) => {
    // 3a. Seed merchant A with an order and an OPEN dispute linked to it
    const seed = await seedDispute('AWAITING_MERCHANT_APPROVAL')

    const initialRows = await db().select().from(disputes).where(eq(disputes.id, seed.id))
    expect(initialRows).toHaveLength(1)
    const initialDispute = initialRows[0]!
    expect(initialDispute.status).toBe('WAITING_FOR_SELLER_RESPONSE')
    expect(initialDispute.defense_state).toBe('AWAITING_MERCHANT_APPROVAL')

    const random = Math.random().toString(36).slice(2, 8)
    const emailB = `merchant-b-${Date.now()}-${random}@example.test`
    const passwordB = 'a long enough password'
    const businessNameB = 'Merchant B Isolation Test'

    try {
      // 3b. Sign up a fresh merchant B through the UI (unique email)
      await page.goto('/merchant-signup')
      await page.getByLabel('Email').fill(emailB)
      await page.getByLabel(/Business name/).fill(businessNameB)
      await page.getByLabel('Password').fill(passwordB)
      await page.getByRole('button', { name: 'Create account' }).click()

      await expect(page).toHaveURL(/\/disputes/)
      await expect(page.getByText(emailB)).toBeVisible()
      await expect(page.getByRole('heading', { name: /Merchant sign in/i })).toHaveCount(0)

      // 3c. As B: open /disputes -> A's dispute id and A's order id must NOT appear anywhere on the page
      await page.goto('/disputes')
      await expect(page.getByText(seed.id)).toHaveCount(0)
      await expect(page.getByText(seed.paypalId)).toHaveCount(0)
      await expect(page.getByText(seed.orderId)).toHaveCount(0)
      const queuePageContent = await page.content()
      expect(queuePageContent).not.toContain(seed.id)
      expect(queuePageContent).not.toContain(seed.paypalId)
      expect(queuePageContent).not.toContain(seed.orderId)

      // 3d. As B: open the dispute detail page for A's dispute (use the same URL pattern the disputes list links to)
      // -> must show not-found / no access, and must NOT show A's dispute details (amount, order id, buyer)
      const detailResponse = await page.goto(`/disputes/${seed.id}`)
      expect(detailResponse?.status()).toBe(404)
      await expect(page.getByText(seed.paypalId)).toHaveCount(0)
      await expect(page.getByText(seed.id)).toHaveCount(0)
      await expect(page.getByText(seed.orderId)).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Decline' })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Approve and send to PayPal' })).toHaveCount(0)
      const detailPageContent = await page.content()
      expect(detailPageContent).not.toContain(seed.paypalId)
      expect(detailPageContent).not.toContain(seed.orderId)
      expect(detailPageContent).not.toContain('$48.00')

      // 3e. As B: POST to /api/disputes/<A's dispute id>/decision using the browser's request context
      // (same-origin, B's cookies) with a valid body exactly as dispute-decision.spec.ts sends
      // -> status must be 403 or 404 (not 2xx), and re-reading the dispute from the DB must show it UNCHANGED
      const decisionRes = await page.request.post(`/api/disputes/${seed.id}/decision`, {
        data: { decision: 'decline' },
      })
      expect([403, 404]).toContain(decisionRes.status())
      expect(decisionRes.ok()).toBe(false)

      const [afterDispute] = await db().select().from(disputes).where(eq(disputes.id, seed.id))
      expect(afterDispute).toBeDefined()
      expect(afterDispute?.status).toBe(initialDispute.status)
      expect(afterDispute?.defense_state).toBe(initialDispute.defense_state)
      expect(afterDispute?.updated_at.getTime()).toBe(initialDispute.updated_at.getTime())

      const auditRows = await db().select().from(auditLog).where(eq(auditLog.chain_id, seed.id))
      expect(auditRows).toHaveLength(0)

      // 3f. As A (sign in as the seeded merchant the way dispute-decision.spec.ts does):
      // A still sees the dispute in /disputes (proves the test is not passing just because the dispute is invisible to everyone)
      await signInMerchant(page)
      await page.goto(`/disputes/${seed.id}`)
      await expect(page.getByRole('heading', { name: seed.paypalId })).toBeVisible()
      await expect(page.getByText('R-E2E-1')).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Your decision' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Decline' })).toBeVisible()
    } finally {
      // 3g. Clean up everything you seeded (including merchant B's rows if the other specs clean theirs; follow their pattern)
      await removeDispute(seed)

      const userBRows = await db().select().from(users).where(eq(users.email, emailB))
      if (userBRows.length > 0 && userBRows[0]) {
        const userBId = userBRows[0].id
        await db().delete(merchants).where(eq(merchants.owner_user_id, userBId))
        await db().delete(users).where(eq(users.id, userBId))
      }
    }
  })
})
