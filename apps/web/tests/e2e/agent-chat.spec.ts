/**
 * S-10 — the agent chat, in a browser.
 *
 * Spec §9 S-10 and WP-17b's acceptance ("E2E"). The two things worth a browser test here are the two the
 * judge panel said never appeared:
 *
 *  1. **A live run happens at all** — the mandate chip fills in, the tool stream fills in, and a Gate
 *     verdict lands inline.
 *  2. **A BLOCK is readable** — "Your limits held. Here is what it tried." with the Gate's own sentence,
 *     not a status code.
 *
 * ## Why the flow is driven rather than asserted on internals
 *
 * The run is real: it provisions a mandate through vi-service, signs an L2 with a P-256 key, opens the
 * merchant MCP, and lets the Gate decide. So the test depends on the local stack
 * (`playwright.config.ts` starts it, or reuses a running one). Both runs are `scripted`, so the result is
 * deterministic — no model key, nothing beyond loopback.
 *
 * ## The two scenarios need different caps, and that is the point
 *
 * The purchase scenario buys the cheapest **trail shoe** the catalogue has, which costs $128.00: a $50.00
 * mandate cannot buy it, so the test sets the cap to $150.00 first. The blocked scenario keeps the
 * default $50.00 cap and tries the $138.00 rucksack. A test that used one cap for both would either never
 * reach a Gate decision or never reach a Block.
 *
 * ## What it deliberately does not assert
 *
 * No order id and no capture. `submit_checkout` answers `order_pending: true` on this deployment because
 * the order path needs a vaulted buyer (`docs/HUMAN_TODO.md` item 1a), and a test that demanded an order
 * id would be a test that lies about the deployment.
 */
import { expect, test, type Page } from '@playwright/test'

import { giveBuyerSavedWallet, signUpBuyer } from './buyer-session'

/**
 * A platform passkey for headless Chromium, over CDP.
 *
 * `stepUp` (`apps/web/lib/webauthn.ts:22`) requires a real ceremony — `navigator.credentials.create`
 * with `authenticatorAttachment: 'platform'` and `userVerification: 'required'` — and CI has no
 * fingerprint reader. `WebAuthn.addVirtualAuthenticator` is the browser's own supported way to run one:
 * a ctap2, internal-transport authenticator that verifies the user, so the ceremony executes the same
 * code path a real passkey would. There is deliberately **no app-side bypass**: the route and the
 * client both still require the assertion.
 */
async function enableVirtualPasskey(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      // `residentKey: 'preferred'` (the app's choice) needs an authenticator that can store one.
      residentKey: 'supported',
    },
  })
}

test.describe('S-10 agent chat', () => {
  // A mandate belongs to an account, and the surface is closed without one (D-060). Each test gets its own
  // address because `users.email` is UNIQUE and these run against one database.
  test.beforeEach(async ({ page }) => {
    const email = await signUpBuyer(page.request)
    await giveBuyerSavedWallet(email)
    // The mandate is now signed by a key held in this browser (prepare -> passkey step-up -> sign ->
    // finalize), so the browser needs a platform passkey before "Create mandate" is clicked.
    await enableVirtualPasskey(page)
    // The session cookie is set by the sign-up response; the page is a fresh navigation, not a client
    // transition, so its server components read the cookie the way a returning buyer's would.
    await page.goto('/agent')
  })

  test('creates a mandate and reaches a Gate ALLOW on an in-mandate cart', async ({ page }) => {
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      'Ask the agent to buy something',
    )

    // $150.00, because the cheapest trail shoe is $128.00 and this assertion is about reaching the Gate.
    await page.getByLabel('Signed cap').selectOption('15000')
    // The mandate sentence and the agent's instruction are the same thing here, so both fields agree: the
    // read-back names the items this sentence authorises, and the agent shops inside them.
    const sentence = 'Buy the cheapest trail shoes you can find, under 150'
    await page.getByLabel('What the buyer asks for').fill(sentence)
    await page.getByRole('button', { name: 'Create mandate' }).click()

    const chip = page.getByTestId('mandate-chip')
    await expect(chip).toBeVisible({ timeout: 90_000 })
    await expect(chip).toContainText('signed by your device')
    // The read-back is the compiler's template, so it names a real limit rather than a placeholder.
    await expect(chip).toContainText('$150.00')

    await page.getByLabel('Message the agent').fill(sentence)
    await page.getByRole('button', { name: 'Send' }).click()

    // A verdict is the run's terminal event, so waiting for it proves the whole loop ran.
    const verdict = page.getByTestId('gate-result').first()
    await expect(verdict).toBeVisible({ timeout: 120_000 })
    await expect(verdict).toContainText('Gate: ALLOWED')
  })

  test('a blocked purchase tells the buyer their limits held, with the reason', async ({
    page,
  }) => {
    await page.goto('/agent')

    await page.getByRole('button', { name: 'Create mandate' }).click()
    await expect(page.getByTestId('mandate-chip')).toBeVisible({ timeout: 90_000 })

    await page.getByRole('button', { name: /Try the injected listing/ }).click()

    const panel = page.getByTestId('limits-held')
    await expect(panel).toBeVisible({ timeout: 120_000 })
    await expect(panel).toContainText('Your limits held. Here is what it tried.')

    // The reason is the Gate's own registry sentence, never a bare code. (The `GATE_*` code is rendered
    // beside it, which is why this asserts on the sentence and not on the element's whole text.)
    await expect(panel).toContainText(/Nothing was charged|was blocked/i)
    await expect(panel).toContainText('The Gate refused before any payment')

    // And the listing that carried the injection is labelled as such.
    await expect(page.getByTestId('injection-badge').first()).toContainText('Suspected injection')
  })

  test('signs the mandate in the browser: prepare, passkey, sign, finalize', async ({ page }) => {
    // The round trip is observable from the network: the browser must call prepare and finalize itself,
    // and no request may go to the old provisioning route. The chat must then show the signed mandate.
    const requested: string[] = []
    page.on('request', (request) => {
      if (request.method() === 'POST') {
        requested.push(new URL(request.url()).pathname)
      }
    })

    await page.getByRole('button', { name: 'Create mandate' }).click()

    const chip = page.getByTestId('mandate-chip')
    await expect(chip).toBeVisible({ timeout: 90_000 })
    await expect(chip).toContainText('signed by your device')

    // Both halves of the browser-signed flow happened, in order, from the page itself.
    const prepareAt = requested.indexOf('/api/agent/mandate/prepare')
    const finalizeAt = requested.indexOf('/api/agent/mandate/finalize')
    expect(prepareAt).toBeGreaterThanOrEqual(0)
    expect(finalizeAt).toBeGreaterThan(prepareAt)
    // The server-minted demo key path is no longer how a mandate is created.
    expect(requested).not.toContain('/api/agent/session')
  })
})
