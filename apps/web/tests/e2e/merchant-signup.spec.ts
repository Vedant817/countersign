/**
 * Merchant sign-up E2E tests — D-059, D-060.
 *
 * Verifies the merchant account flow:
 * 1. Sign up through /merchant-signup -> land on /disputes signed in (disputes page renders, not login page).
 * 2. Attempting to register the same address again shows the generic refusal.
 * 3. A buyer account visiting /disputes is refused with 403 (forbidden page).
 */
import { expect, test } from '@playwright/test'

import { signUpBuyer } from './buyer-session'

test.describe('the merchant account', () => {
  test('signs up through /merchant-signup, lands on /disputes signed in, refuses duplicate, and refuses buyer access', async ({
    page,
    browser,
  }) => {
    // 1. Visit /merchant-signup
    await page.goto('/merchant-signup')

    const random = Math.random().toString(36).slice(2, 8)
    const email = `merchant-${Date.now()}-${random}@example.test`

    await page.getByLabel('Email').fill(email)
    await page.getByLabel(/Business name/).fill('Acme Corp')
    await page.getByLabel('Password').fill('a long enough password')
    await page.getByRole('button', { name: 'Create account' }).click()

    // 2. Expect to land on /disputes signed in (the disputes page renders, not the login page)
    await expect(page).toHaveURL(/\/disputes/)
    await expect(page.getByText(email)).toBeVisible()
    await expect(page.getByRole('heading', { name: /Merchant sign in/i })).toHaveCount(0)

    // Sign out to test duplicate registration
    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page).toHaveURL(/\/login/)

    // 3. The same email again shows the generic refusal
    await page.goto('/merchant-signup')
    await page.getByLabel('Email').fill(email)
    await page.getByLabel(/Business name/).fill('Acme Corp')
    await page.getByLabel('Password').fill('a long enough password')
    await page.getByRole('button', { name: 'Create account' }).click()

    await expect(page.locator('p[role="alert"]')).toBeVisible()
    await expect(page.locator('p[role="alert"]')).toContainText('cannot be used')
    await expect(page).toHaveURL(/\/merchant-signup/)

    const duplicate = await page.request.post('/api/auth/merchant-signup', {
      data: {
        email,
        password: 'a long enough password',
        businessName: 'Acme Corp',
      },
    })
    expect(duplicate.status()).toBe(401)
    expect(await duplicate.text()).toContain('cannot be used')

    // 4. A buyer account visiting /disputes is refused (403/forbidden page)
    const buyerContext = await browser.newContext()
    try {
      await signUpBuyer(buyerContext.request)
      const buyerPage = await buyerContext.newPage()
      const forbidden = await buyerPage.goto('/disputes')
      expect(forbidden?.status()).toBe(403)
      await expect(buyerPage.getByText('This page belongs to another account')).toBeVisible()
    } finally {
      await buyerContext.close()
    }
  })

  test('navigates between /login and /merchant-signup via links', async ({ page }) => {
    await page.goto('/login')
    await page.getByRole('link', { name: /create an account/i }).click()
    await expect(page).toHaveURL(/\/merchant-signup/)

    await page.getByRole('link', { name: /sign in/i }).click()
    await expect(page).toHaveURL(/\/login/)
  })
})
