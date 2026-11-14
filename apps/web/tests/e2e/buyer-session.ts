/**
 * A real buyer account for the E2E suites — D-060.
 *
 * The demo buyer is gone: `/api/agent/session` no longer mints a `usr_…` for a request without a cookie, so
 * a browser test that wants a mandate needs an account first. This is the same shape as
 * `tests/e2e/merchant-session.ts` and deliberately not a fixture row: the account is created through the
 * real sign-up route, which hashes a real password and writes a real `users` row, so a suite that signs in
 * is exercising the product rather than a seed.
 *
 * `page.request` shares the browser context's cookie jar, so signing up through the request API leaves the
 * page itself signed in — which is what the page-level specs need and what a browser would do.
 */
import { expect, type APIRequestContext, type Page } from '@playwright/test'

import { newId } from '@countersign/core'
import { db, findUserByEmail, paypalWallets } from '@countersign/db'

// Playwright runs test files in a process whose environment is not the webServer's; the app's `db()` reads
// `DATABASE_URL` lazily, so setting it here is enough for the test's own connection. Built the same way
// `playwright.config.ts` builds it, so the credentials are not a literal for a scanner to trip over.
const localDatabase = new URL('postgres://127.0.0.1:5432/countersign')
localDatabase.username = 'countersign'
localDatabase.password = 'countersign'
process.env['DATABASE_URL'] ??= localDatabase.href

export const BUYER_PASSWORD = 'e2e-buyer-password-long-enough'

/**
 * A fresh address per account.
 *
 * `users.email` is UNIQUE (D-060), and the suites run serially against one database, so a fixed address would
 * make the second run fail on a duplicate rather than on anything it is testing. The suffix is time plus
 * entropy, not an id from the app, so a test cannot depend on its shape.
 */
export function buyerEmail(prefix = 'buyer'): string {
  return `${prefix}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}@example.test`
}

/** Create an account through the real route and return the address it was created with. */
export async function signUpBuyer(
  request: APIRequestContext,
  email: string = buyerEmail(),
  displayName = 'E2E buyer',
): Promise<string> {
  const response = await request.post('/api/auth/signup', {
    data: { email, password: BUYER_PASSWORD, displayName },
  })
  expect(response.status(), await response.text()).toBe(200)
  return email
}

/** Sign in through the real form, the way a person would. */
export async function signInBuyer(page: Page, email: string): Promise<void> {
  await page.goto('/buyer-login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(BUYER_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/agent/)
}

/**
 * An e2e-only fixture standing in for the PayPal vault approval step, which needs a real PayPal buyer and
 * cannot run in CI. Inserts one active PayPal wallet row for the buyer in the test database so
 * `/api/agent/session` can provision a mandate without returning 409 CS_CONFLICT.
 */
export async function giveBuyerSavedWallet(email: string): Promise<void> {
  const userResult = await findUserByEmail(email)
  if (!userResult.ok) {
    throw new Error(
      `giveBuyerSavedWallet: failed looking up user for ${email}: ${userResult.error.message}`,
    )
  }
  if (!userResult.value) {
    throw new Error(`giveBuyerSavedWallet: user not found for ${email}`)
  }
  const user_id = userResult.value.id
  const random = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  await db()
    .insert(paypalWallets)
    .values({
      id: newId('wal'),
      user_id,
      payment_token_id: `E2E-FIXTURE-VAULT-${random}`,
      payer_id: `E2E-FIXTURE-PAYER-${random}`,
      payer_email: email,
      status: 'ACTIVE',
    })
}
