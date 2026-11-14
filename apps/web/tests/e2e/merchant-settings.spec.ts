/**
 * Merchant settings E2E tests — priority c, part 7.
 *
 * Verifies that:
 * 1. A newly signed-up merchant visits /merchant/settings and sees "Not linked".
 * 2. The merchant submits a valid 13-character PayPal merchant ID and sees it displayed after reload.
 * 3. A buyer account visiting /merchant/settings is refused with 403 and does not see the form.
 */
import { expect, test } from '@playwright/test'

import { signUpBuyer } from './buyer-session'

function randomPaypalMerchantId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let id = ''
  for (let i = 0; i < 13; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return id
}

test.describe('the merchant settings', () => {
  test('lets a signed-up merchant link their PayPal merchant ID, and refuses a buyer', async ({
    page,
    browser,
  }) => {
    // 1. Sign up a fresh merchant via the UI
    await page.goto('/merchant-signup')

    const random = Math.random().toString(36).slice(2, 8)
    const email = `merchant-${Date.now()}-${random}@example.test`

    await page.getByLabel('Email').fill(email)
    await page.getByLabel(/Business name/).fill('Acme Corp')
    await page.getByLabel('Password').fill('a long enough password')
    await page.getByRole('button', { name: 'Create account' }).click()

    await expect(page).toHaveURL(/\/disputes/)

    // 2. Open /merchant/settings via the header link
    await page.getByRole('link', { name: /settings/i }).click()
    await expect(page).toHaveURL(/\/merchant\/settings/)

    // 3. See "Not linked"
    await expect(
      page.getByText('Not linked — orders cannot be taken until you link one'),
    ).toBeVisible()

    // 4. Submit a unique random 13-char uppercase id
    const paypalId = randomPaypalMerchantId()
    await page.getByLabel(/PayPal Merchant ID/i).fill(paypalId)
    await page.getByRole('button', { name: /Save PayPal Merchant ID/i }).click()

    // Wait for success feedback
    await expect(page.getByText(/linked successfully/i)).toBeVisible()

    // 5. See it shown after reload
    await page.reload()
    await expect(page.getByText(paypalId)).toBeVisible()
    await expect(
      page.getByText('Not linked — orders cannot be taken until you link one'),
    ).toHaveCount(0)

    // 6. A buyer visiting /merchant/settings does not see the form
    const buyerContext = await browser.newContext()
    try {
      await signUpBuyer(buyerContext.request)
      const buyerPage = await buyerContext.newPage()
      const response = await buyerPage.goto('/merchant/settings')
      expect(response?.status()).toBe(403)
      await expect(buyerPage.getByRole('button', { name: /Save PayPal Merchant ID/i })).toHaveCount(
        0,
      )
      await expect(buyerPage.getByLabel(/PayPal Merchant ID/i)).toHaveCount(0)
    } finally {
      await buyerContext.close()
    }
  })
})
