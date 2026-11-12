/**
 * EC-ENV-1's sandbox base URL — **one** default, shared by every reader.
 *
 * ## Why this is a module and not a constant inside the order path
 *
 * `apps/web/lib/demo-order.ts` defaulted `PAYPAL_API_BASE` to `https://api-m.sandbox.paypal.com` when the
 * operator left it unset, while `apps/web/app/status/route.ts` treated an **unset** `PAYPAL_API_BASE` as
 * "PayPal is not configured" and answered `paypalConfigured: false`. So the order path could create a real
 * sandbox order on a deployment whose own health page said PayPal was absent — the "two readers that can
 * disagree, where one of them is inside a money call" failure this repo documents as D-040, and the same
 * defect class as the `.env.local` disk fallback that `demo-order.ts` carried until 2026-11-13.
 *
 * A default has to live somewhere. Making it a named export means the health check and the money path
 * resolve the same base URL, so they cannot drift.
 *
 * ## Why the value is a sandbox host and not a live one
 *
 * `parseEnv` (spec §6) and `assertSandbox` (EC-ENV-1) both refuse anything that is not
 * `*.sandbox.paypal.com` (or localhost). A default that pointed at PayPal's live host would make "left it
 * unset" a way to reach production money, which is exactly what EC-ENV-1 exists to make impossible. This
 * constant therefore cannot be the thing that turns a demo into a live charge: if it ever were edited to a
 * live host, `PayPalClient`'s `assertSandbox` refuses the first call.
 */
export const DEFAULT_PAYPAL_BASE = 'https://api-m.sandbox.paypal.com'

/**
 * True when a base URL is one this project is allowed to call.
 *
 * The same host rule `assertSandbox` and `parseEnv` enforce, expressed as a predicate so a status page can
 * say *why* PayPal is unconfigured ("`PAYPAL_API_BASE` is a live host") instead of just "not configured".
 */
export function isAllowedPaypalBase(base: string): boolean {
  let host: string
  try {
    host = new URL(base).hostname
  } catch {
    return false
  }
  return /(^|\.)sandbox\.paypal\.com$/.test(host) || host === 'localhost' || host === '127.0.0.1'
}

/**
 * The base URL every PayPal call from this app uses: the operator's `PAYPAL_API_BASE`, or
 * {@link DEFAULT_PAYPAL_BASE} when they left it unset.
 */
export function resolvePaypalBase(env: Record<string, string | undefined> = process.env): string {
  const configured = env['PAYPAL_API_BASE']?.trim()
  return configured !== undefined && configured !== '' ? configured : DEFAULT_PAYPAL_BASE
}
