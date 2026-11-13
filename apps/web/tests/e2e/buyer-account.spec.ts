/**
 * The buyer account — D-060, and audit §4's "scoped to the signed-in buyer".
 *
 * Before this, `/api/agent/session` minted a fresh `usr_…` for a request with no cookie: a browser held an
 * identity nobody had authenticated for, and `/api/agent/run` took both `user_id` and `mandate_id` from the
 * request body, so a caller who guessed another buyer's mandate id could spend that buyer's budget. These
 * tests pin the replacement:
 *
 *  1. **The whole account flow, in a browser:** sign up → land on the agent surface → create a mandate →
 *     sign out → the surface is closed again.
 *  2. **Two mandates in one account are the same buyer** — and still two mandates.
 *  3. **A second account cannot use the first one's address** (the generic `401`, not a directory).
 *  4. **Buyer B cannot name buyer A's user id** (403) **or buyer A's mandate** (404).
 *  5. **An anonymous caller gets 401**, not a mandate.
 *
 * They drive the real routes through the browser's own cookie jar (`page.request`), so a cookie that is set
 * but not sent — or sent but not read — fails here rather than in production.
 */
import { expect, test, type APIRequestContext } from '@playwright/test'

import { buyerEmail, signInBuyer, signUpBuyer } from './buyer-session'

interface SessionResponse {
  user_id: string
  mandate_id: string
  agent_id: string
}

async function createMandate(
  request: APIRequestContext,
  capMinor: number,
  intent = 'Buy the cheapest trail shoes you can find, under 150',
): Promise<SessionResponse> {
  const response = await request.post('/api/agent/session', {
    data: { intent, cap_minor: String(capMinor) },
  })
  expect(response.status(), await response.text()).toBe(200)
  return (await response.json()) as SessionResponse
}

test.describe('the buyer account', () => {
  test('signs up, signs in, creates a mandate and signs out again', async ({ page }) => {
    // Anonymous: the surface is closed and the login page says where it will return to.
    await page.goto('/agent')
    await expect(page).toHaveURL(/\/buyer-login\?next=%2Fagent/)

    // The form is the real one: it posts to /api/auth/signup and the session cookie is set on that response.
    await page.getByRole('link', { name: 'Create one' }).click()
    await expect(page).toHaveURL(/\/signup\?next=%2Fagent/)

    const email = buyerEmail('flow')
    await page.getByLabel('Email').fill(email)
    await page.getByLabel(/Display name/).fill('Asha')
    await page.getByLabel('Password').fill('a long enough password')
    await page.getByRole('button', { name: 'Create account' }).click()

    // The sign-up is also a sign-in, so the buyer lands on the surface they asked for with their own name in
    // the header — the session is visible rather than assumed.
    await expect(page).toHaveURL(/\/agent/)
    await expect(page.getByText(`Asha · ${email}`)).toBeVisible()

    // A mandate for this account: the chip names the buyer's own device, and the cap is the signed cap.
    await page.getByRole('button', { name: 'Create mandate' }).click()
    const chip = page.getByTestId('mandate-chip')
    await expect(chip).toBeVisible({ timeout: 90_000 })
    await expect(chip).toContainText('signed by your device')

    // Signing out closes the surface: the next request to /agent is anonymous again.
    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page).toHaveURL(/\/buyer-login/)
    await page.goto('/agent')
    await expect(page).toHaveURL(/\/buyer-login\?next=%2Fagent/)
  })

  test('one account keeps one buyer across two mandates', async ({ page }) => {
    await signUpBuyer(page.request)
    const first = await createMandate(page.request, 5000)
    const second = await createMandate(page.request, 15000)

    expect(second.user_id).toBe(first.user_id)
    // Reusing the buyer must not mean reusing the mandate: a second run gets its own cap and its own budget.
    expect(second.mandate_id).not.toBe(first.mandate_id)
    expect(second.agent_id).not.toBe(first.agent_id)
  })

  test('a second account cannot use the same address, and is not told that it exists', async ({
    page,
  }) => {
    const email = await signUpBuyer(page.request)
    // The second attempt is answered like a failed login, so the form is not a directory of accounts.
    const duplicate = await page.request.post('/api/auth/signup', {
      data: { email, password: 'a different password entirely', displayName: 'Impostor' },
    })
    expect(duplicate.status()).toBe(401)
    expect(await duplicate.text()).toContain('cannot be used')
  })

  test("buyer B cannot act as buyer A, or reach buyer A's mandate", async ({ browser }) => {
    const victimContext = await browser.newContext()
    const attackerContext = await browser.newContext()
    try {
      await signUpBuyer(victimContext.request)
      const victim = await createMandate(victimContext.request, 15000)

      await signUpBuyer(attackerContext.request)
      const attacker = await createMandate(attackerContext.request, 5000)
      expect(attacker.user_id).not.toBe(victim.user_id)

      // 1. Naming the victim's user id: the run belongs to the signed-in buyer, so this is a 403 before any
      //    mandate is read.
      const asVictim = await attackerContext.request.post('/api/agent/run', {
        data: {
          user_id: victim.user_id,
          mandate_id: victim.mandate_id,
          agent_id: attacker.agent_id,
          message: 'buy the cheapest trail shoes you can find, under 150',
          mode: 'scripted',
        },
      })
      expect(asVictim.status()).toBe(403)
      expect(await asVictim.text()).toContain('does not belong to this browser')

      // 2. Naming their own user id but the victim's mandate: the mandate is what holds the money, so it is
      //    checked against the attacker's own rows. The answer is 404 — the same as an id that never existed,
      //    because a 403 would confirm that the victim's mandate is real.
      const withVictimMandate = await attackerContext.request.post('/api/agent/run', {
        data: {
          user_id: attacker.user_id,
          mandate_id: victim.mandate_id,
          agent_id: attacker.agent_id,
          message: 'buy the cheapest trail shoes you can find, under 150',
          mode: 'scripted',
        },
      })
      expect(withVictimMandate.status()).toBe(404)
      expect(await withVictimMandate.text()).toContain('does not belong to this account')

      // The attacker's own mandate still runs: the guard is ownership, not a blanket refusal.
      const mine = await attackerContext.request.post('/api/agent/run', {
        data: {
          user_id: attacker.user_id,
          mandate_id: attacker.mandate_id,
          agent_id: attacker.agent_id,
          message: 'buy the cheapest trail shoes you can find, under 150',
          mode: 'scripted',
        },
      })
      expect(mine.status()).toBe(200)
    } finally {
      await victimContext.close()
      await attackerContext.close()
    }
  })

  test('an anonymous caller cannot create a mandate or start a run', async ({ browser }) => {
    const context = await browser.newContext()
    try {
      const session = await context.request.post('/api/agent/session', {
        data: { intent: 'Buy shoes', cap_minor: '5000' },
      })
      expect(session.status()).toBe(401)

      const run = await context.request.post('/api/agent/run', {
        data: {
          user_id: 'usr_anyone',
          mandate_id: 'mdt_anything',
          agent_id: 'agt_anything',
          message: 'buy shoes',
          mode: 'scripted',
        },
      })
      expect(run.status()).toBe(401)
    } finally {
      await context.close()
    }
  })

  test('a merchant session is refused on the buyer surface', async ({ page }) => {
    // The credential check is the same for everyone; the *surface* is what the persona gates (D-060). The
    // merchant password is written by the suite the same way the disputes suites write it, because the seed
    // only writes one when MERCHANT_PASSWORD is configured and the Playwright webServer carries no secret.
    const { ensureMerchantPassword, MERCHANT_EMAIL, MERCHANT_PASSWORD } = await import(
      './merchant-session'
    )
    await ensureMerchantPassword()

    await page.goto('/login')
    await page.getByLabel('Email').fill(MERCHANT_EMAIL)
    await page.getByLabel('Password').fill(MERCHANT_PASSWORD)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page).toHaveURL(/\/disputes/)

    // Signed in, but not as a buyer: /agent answers 403 rather than provisioning a mandate for a merchant.
    const forbidden = await page.goto('/agent')
    expect(forbidden?.status()).toBe(403)
    await expect(page.getByText('This page belongs to another account')).toBeVisible()
    const session = await page.request.post('/api/agent/session', {
      data: { intent: 'Buy shoes', cap_minor: '5000' },
    })
    expect(session.status()).toBe(403)
  })
})

test.describe('buyer sign-in form', () => {
  test('signs an existing buyer in and returns them to the page they asked for', async ({
    page,
  }) => {
    const email = await signUpBuyer(page.request)
    // Sign out first: signing up leaves a cookie, and this test is about the form, not the redirect.
    await page.request.post('/api/auth/logout', { data: {} })

    await signInBuyer(page, email)
    await expect(page.getByText(new RegExp(email))).toBeVisible()
  })
})
