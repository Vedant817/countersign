/**
 * Shared helpers for the sandbox suites.
 *
 * Everything here is opt-in infrastructure for `*.sandbox.test.ts`. It is **not** a PayPal mock: it
 * reads real credentials, calls the real sandbox, and fails loudly. If a credential is missing the
 * suite skips — it must never fake a success.
 */
import { systemClock } from '@countersign/core'

import { PayPalClient } from '../../src/client'
import { ppMoney } from './transport-double'

/** Where these tests talk to. Defaults to the sandbox host; a live host is refused at boot (EC-ENV-1). */
export const SANDBOX_BASE_URL = process.env['PAYPAL_API_BASE'] ?? 'https://api-m.sandbox.paypal.com'

export const HAS_CREDENTIALS = Boolean(process.env['PAYPAL_CLIENT_ID'] && process.env['PAYPAL_CLIENT_SECRET'])

/** A vault (payment-token) id, so an order can be merchant-initiated with no buyer present (C2). */
export const VAULT_ID = process.env['PAYPAL_TEST_VAULT_ID'] ?? ''

/** The sandbox buyer personal account (`PAYPAL_BUYER_EMAIL`, §6). */
export const BUYER_EMAIL = process.env['PAYPAL_BUYER_EMAIL'] ?? ''

/** The exact instruction printed when a suite cannot run. */
export const SKIP_REASON =
  'PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are absent (docs/HUMAN_TODO.md H-01 is open). ' +
  'Set them in packages/paypal/.env and run: pnpm --filter @countersign/paypal test:sandbox'

/** A real client against the real sandbox. Credentials come from the environment only (spec §6). */
export function liveClient(): PayPalClient {
  const clientId = process.env['PAYPAL_CLIENT_ID']
  const clientSecret = process.env['PAYPAL_CLIENT_SECRET']
  if (!clientId || !clientSecret) throw new Error(SKIP_REASON)
  return new PayPalClient({
    baseUrl: SANDBOX_BASE_URL,
    clientId,
    clientSecret,
    // Real time here: the sandbox issues real expiry times and the sleeps are real backoffs.
    clock: systemClock,
    env: { PAYPAL_ENV: process.env['PAYPAL_ENV'] ?? 'sandbox', PAYPAL_API_BASE: SANDBOX_BASE_URL },
  })
}

/** `await new Promise(r => setTimeout(r, ms))` — polling the sandbox, not the client backoff. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Poll until `check` returns a value, or give up.
 *
 * §10.3 step 3 says a simulated dispute must be polled for: PayPal creates it asynchronously, and a
 * test that assumes it is there immediately fails for a reason that has nothing to do with the code.
 */
export async function pollUntil<T>(
  check: () => Promise<T | undefined>,
  opts: { attempts?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 20
  const intervalMs = opts.intervalMs ?? 3_000
  let last: T | undefined
  for (let i = 0; i < attempts; i++) {
    last = await check()
    if (last !== undefined) return last
    if (i < attempts - 1) await delay(intervalMs)
  }
  throw new Error(`pollUntil gave up after ${attempts} attempts${opts.label ? ` (${opts.label})` : ''}`)
}

export { ppMoney }