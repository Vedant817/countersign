/**
 * A platform passkey for headless Chromium — the browser's own virtual authenticator, over CDP.
 *
 * ## Why this exists at all
 *
 * `/agent` no longer asks the server to mint the device key: `signMandate`
 * (`apps/web/app/agent/mandate-sign.tsx`) prepares on the server, runs a real passkey ceremony
 * (`stepUp`, `apps/web/lib/webauthn.ts:22` — `navigator.credentials.create` with
 * `authenticatorAttachment: 'platform'` and `userVerification: 'required'`), signs the exact
 * `signingInput` in the page, and finalizes. A cancelled or unavailable ceremony signs **nothing**,
 * so a browser test that clicks "Create mandate" needs a platform authenticator in the browser.
 *
 * `WebAuthn.addVirtualAuthenticator` is the browser's supported way to provide one: a ctap2,
 * internal-transport authenticator that verifies the user, so the ceremony executes the same code
 * path a real passkey would. There is deliberately **no app-side bypass** — the route and the client
 * both still require the assertion.
 *
 * ## Why it is shared, and why CI needs it
 *
 * A laptop with Windows Hello has a platform authenticator even in headless Chromium, so this looks
 * optional locally and is not: `ubuntu-latest` has none, and the ceremony rejects with
 * `NotAllowedError`, which `handleCeremonyError` turns into `null` — "cancelled" — so the mandate chip
 * never renders and the spec times out. That is exactly how `buyer-account.spec.ts` first went red in
 * CI while passing on the laptop (commit 3b moved the mandate into the browser and armed a virtual
 * authenticator in `agent-chat.spec.ts` only). Any spec that drives the "Create mandate" button must
 * call this **before** the click, so it belongs here rather than in one spec file.
 */
import type { Page } from '@playwright/test'

export async function armVirtualPasskey(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      // `residentKey: 'preferred'` (the app's choice, `webauthn.ts:58`) needs an authenticator that
      // can store a discoverable credential.
      residentKey: 'supported',
    },
  })
}
