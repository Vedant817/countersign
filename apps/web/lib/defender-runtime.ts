import 'server-only'

/**
 * The Defender composition root for the merchant approval surface — spec **§8.15**, **§18 q24**.
 *
 * ## Why this file exists
 *
 * §8.15 requires a merchant approval click before any PayPal dispute write, and the click happens in
 * `apps/web`. `fileDispute` therefore has to run **in the web process**, synchronously, inside the
 * request that carries the click — so the merchant reads the outcome of the filing they authorised
 * rather than a "queued" message they have to come back for. That means the web tier needs the same
 * `FileDeps` the worker builds, and this is where it is built.
 *
 * ## The three things it wires that the worker's defend tick does not
 *
 * | Member | Worker (unapproved tick) | This file (approved click) |
 * |---|---|---|
 * | `refunds` | `refundsRefusedLoudly()` | `orders.defenderRefundsFromOrders(...)` — the real EC-REF-4 path |
 * | `renderPdf` | omitted → the real `renderPacketPdf` | omitted → the same real renderer |
 * | `llm` | omitted → `templateNote()` | omitted → the same composed note |
 *
 * The last two rows are not omissions. `FileDeps` marks both optional **by design**: with no model the
 * note is composed and passes the citation checker by construction (EC-LLM-1), and `fileDispute`
 * defaults `renderPdf` to the production renderer. A key behind an absent credential must not stand
 * between a merchant's click and PayPal.
 *
 * ## What this file refuses to do
 *
 * It does not decide anything. No posture, no amount, no eligibility rule: the router in
 * `packages/defender` decides, the filer's guards enforce, and `packages/orders` moves the money. A
 * second policy here is the drift AGENTS.md rule 8 exists to prevent — and on a money path it would be
 * the expensive kind.
 */
import { csError, err, ok, systemClock, type CsError, type Result } from '@countersign/core'
import { dbDefenderStore } from '@countersign/defender'
import { defenderRefundsFromOrders } from '@countersign/orders'
import type { FileDeps } from '@countersign/orchestrator'
import type { PayPalClient } from '@countersign/paypal'

import { ordersRuntime, paypalClient } from './orders-runtime'

/**
 * Build the filer's dependencies, or say exactly what is missing.
 *
 * Async-free and cheap: `dbDefenderStore` opens no connection (`db()` is lazy) and the PayPal client is a
 * value object, so a request that only *reads* the queue never pays for this.
 *
 * @param env read once per call rather than at import, so a test can set a variable without a module reset
 *   — the same reason `lib/session.ts` reads `SESSION_SECRET` per call (D-053's lesson).
 */
export function defenderFileDeps(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Result<FileDeps, CsError> {
  const paypal = paypalClient(env)
  if (!paypal.ok) return paypal

  const baseUrl = publicBaseUrl(env)
  if (!baseUrl.ok) return baseUrl

  const client: PayPalClient = paypal.value
  return ok(fileDepsFor(client, baseUrl.value))
}

/**
 * The `FileDeps` object itself, over an already-built client.
 *
 * Split out from {@link defenderFileDeps} so a test can hand in a stub client without touching the
 * environment — the same seam `apps/worker/src/index.ts::defendDepsFor` uses.
 */
export function fileDepsFor(client: PayPalClient, publicBaseUrl: string): FileDeps {
  return {
    clock: systemClock,
    store: dbDefenderStore(),
    paypal: client,
    // EC-REF-4's only correct refund path: through the case, with a durable reservation and a live
    // read-back. `ordersRuntime` binds the reservation store to the same repositories the filer writes
    // its `dispute_actions` row to, so the two halves of a refund cannot disagree about the capture.
    refunds: defenderRefundsFromOrders(ordersRuntime(client), client),
    publicBaseUrl,
  }
}

/**
 * §6's `PUBLIC_BASE_URL` — the only host a filed note or a packet QR may name.
 *
 * A refusal rather than a default, and that is the point: a `PUBLIC_BASE_URL` guessed here would be a
 * URL written into PayPal's own case file that the deployment does not serve. `env.ts` requires the
 * variable at boot for exactly this reason; this is the per-request check that says so in a sentence a
 * merchant can read.
 */
function publicBaseUrl(env: Readonly<Record<string, string | undefined>>): Result<string, CsError> {
  const configured = env['PUBLIC_BASE_URL']?.trim() ?? ''
  if (configured !== '') return ok(configured.replace(/\/+$/, ''))
  return err(
    csError(
      'CS_INTERNAL',
      'PUBLIC_BASE_URL is not set; a dispute filing may not be sent without the host its evidence names.',
      { env: 'PUBLIC_BASE_URL' },
      {
        userMessage:
          'This deployment has no public address configured, so a filing cannot be prepared. Please tell ' +
          'the operator.',
        retryable: false,
      },
    ),
  )
}
