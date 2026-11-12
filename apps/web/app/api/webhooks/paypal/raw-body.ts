/**
 * The two things a webhook route handler has to do before it can call `handleWebhook`, kept out of `route.ts`.
 *
 * ## Why this file exists
 *
 * Next route files may export only HTTP handlers and route-segment config. A non-handler export from
 * `route.ts` (a helper a test wants to call directly, say) is rejected by `next build`, and moving the helper
 * here is the supported shape: `route.ts` imports it, and the test imports it from the same module. One
 * implementation, both sides of the boundary.
 *
 * The two functions are the adapter's irreducible job, and both exist to preserve a property the package
 * relies on:
 *
 *  - `readRawBody` hands over the **exact bytes** that arrived. `request.json()` then `JSON.stringify()` would
 *    re-serialise PayPal's body - key order changes, whitespace disappears - and `verify-webhook-signature`
 *    verifies the bytes it is given, so a delivery PayPal really signed would fail verification on our side and
 *    look exactly like a forgery (EC-WH-4, EC-WH-7).
 *  - `headerBag` canonicalises header names to lower case. HTTP names are case-insensitive and a proxy may
 *    re-case them; `webhook_events.raw` keeps the first delivery's headers as the case file, so a redelivery
 *    must produce the same keys to compare equal.
 */
import type { HeaderBag } from '@countersign/webhooks'

/**
 * The raw request bytes, read once.
 *
 * A `Request` body is a single-use stream, and `handleWebhook` needs both the bytes (to verify) and the parsed
 * body (to store). Reading them here keeps "read it once, exactly" from depending on the framework not to
 * double-read.
 */
export async function readRawBody(request: Request): Promise<Uint8Array> {
  return new Uint8Array(await request.arrayBuffer())
}

/**
 * Every header, lower-cased, first value wins.
 *
 * `handleWebhook` looks headers up case-insensitively already; this canonical form is for the copy stored in
 * `webhook_events.raw`, so a redelivery through a proxy that changed the casing still compares equal to the
 * first delivery's headers.
 */
export function headerBag(headers: Headers): HeaderBag {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    if (out[key] === undefined) out[key] = value
  })
  return out
}
