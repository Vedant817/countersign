/**
 * The merchant session the dispute e2e suites need — D-059.
 *
 * The web server reads `users.password_hash`; the seed only writes one when `MERCHANT_PASSWORD` is in its
 * environment, and the Playwright webServer deliberately does not carry a production secret. So the test
 * writes the hash on the seeded merchant row itself — the real `hashPassword`, the real repository — and
 * then signs in through the real login route. The login still verifies a scrypt hash and mints the real
 * cookie; nothing about the route is bypassed.
 */
import { expect, type Page } from '@playwright/test'

import { db, hashPassword, MERCHANT, resetLoginAttempts, setPasswordHash } from '@countersign/db'

export const MERCHANT_EMAIL = 'merchant.northwind@example.com'
export const MERCHANT_PASSWORD = 'e2e-merchant-password'

export async function ensureMerchantPassword(): Promise<void> {
  await resetLoginAttempts(db())
  await setPasswordHash(MERCHANT.id, await hashPassword(MERCHANT_PASSWORD))
}

export async function signInMerchant(page: Page): Promise<void> {
  await ensureMerchantPassword()
  const response = await page.request.post('/api/auth/login', {
    data: { email: MERCHANT_EMAIL, password: MERCHANT_PASSWORD, next: '/disputes' },
  })
  expect(response.status(), await response.text()).toBe(200)
}
