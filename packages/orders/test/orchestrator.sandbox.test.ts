/**
 * The live half of AT-M11 — the part that can only be answered by a real PayPal sandbox.
 *
 * **Opt-in.** Excluded from `pnpm test`; run with:
 *
 * ```
 * pnpm --filter @countersign/orders test:sandbox
 * ```
 *
 * Requires real sandbox credentials and a vault id (`docs/HUMAN_TODO.md` **H-01** is open). Without them
 * every test below **skips**, carrying its reason in the test name — it never fails, and it never reports
 * success without having called PayPal.
 *
 * ## What is real here and what is not
 *
 * **Real:** the socket, the credentials, the OAuth handshake, and every PayPal answer. The `PayPalClient`
 * is the production one with **no `fetchImpl` override**, so `PayPal-Request-Id`, the retry loop, the
 * backoff and the zod validation run against PayPal's actual responses rather than doc-derived stubs. This
 * is the same seam `packages/paypal/test/fixtures/sandbox-env.ts` uses, for the same reason.
 *
 * **Not real:** our rows. They live in `createInMemoryOrderWorld`, because there is no Postgres credential
 * in this repository's `.env.example` either, and the question this file answers is *"did PayPal agree with
 * the amounts we computed?"* — answered by the money, not by the storage engine. The offline suite covers
 * row semantics against the port contract; this covers the wire.
 *
 * ## Why it exists, given the offline suite passes
 *
 * Two things are unverifiable offline and both are load-bearing:
 *
 *  1. **Whether PayPal returns an authorization inline** for a merchant-initiated `AUTHORIZE` order against
 *     a vault. Spec U2 calls this unverified; §11 week-1 check **C2** is the question. This file asks it and
 *     prints the answer rather than assuming it.
 *  2. **Whether our arithmetic is the amount PayPal charges.** A split capture off by a cent passes every
 *     offline test and fails here.
 */
import { describe, expect, it } from 'vitest'

import { money, systemClock, type OrderId } from '@countersign/core'
import { PayPalClient } from '@countersign/paypal'

import {
  captureShipment,
  createOrderFromDecisionDetailed,
  refund,
  voidRemainder,
  type Actor,
} from '../src'
import { allowDecision, harness, type Harness } from './harness'

/* ------------------------------------------------------------------------------------------ */
/* Credentials                                                                                    */
/* ------------------------------------------------------------------------------------------ */

/** Where these tests talk. EC-ENV-1: a live host is refused by the client, so this cannot be real money. */
const SANDBOX_BASE_URL = process.env['PAYPAL_API_BASE'] ?? 'https://api-m.sandbox.paypal.com'

const CLIENT_ID = process.env['PAYPAL_CLIENT_ID'] ?? ''
const CLIENT_SECRET = process.env['PAYPAL_CLIENT_SECRET'] ?? ''
/** A vault (payment-token) id from one §8.7 onboarding run, so an order needs no buyer present (C2). */
const VAULT_ID = process.env['PAYPAL_TEST_VAULT_ID'] ?? ''

const CREDENTIALS_REASON =
  'PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are absent (docs/HUMAN_TODO.md H-01 is open). ' +
  'Set them in packages/orders/.env and run: pnpm --filter @countersign/orders test:sandbox'
const VAULT_REASON =
  'PAYPAL_TEST_VAULT_ID is absent: run the §8.7 onboarding once against sandbox and export the payment-token id.'
const ENV_REASON = `PAYPAL_ENV must be "sandbox" for these tests; it is "${process.env['PAYPAL_ENV'] ?? '(unset)'}".`

const HAS_CREDENTIALS = CLIENT_ID !== '' && CLIENT_SECRET !== ''
const ENV_IS_SANDBOX = (process.env['PAYPAL_ENV'] ?? 'sandbox') === 'sandbox'
const canRun = HAS_CREDENTIALS && VAULT_ID !== '' && ENV_IS_SANDBOX

/**
 * The production `PayPalClient`: real credentials, real clock, real socket, no stub of any kind.
 *
 * `maxRetries` is left at the client's own default because in the sandbox a genuine 5xx is worth retrying
 * and a flaky test is worse than a slow one.
 */
function liveClient(): PayPalClient {
  if (!HAS_CREDENTIALS) throw new Error(CREDENTIALS_REASON)
  return new PayPalClient({
    baseUrl: SANDBOX_BASE_URL,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    clock: systemClock,
    env: { PAYPAL_ENV: 'sandbox', PAYPAL_API_BASE: SANDBOX_BASE_URL },
  })
}

/**
 * Every world, budget and row helper from the offline harness, with the real client swapped in.
 *
 * Two units of `NW-001` ($45.00 each) plus a flat $5.00 shipping fee is a $95.00 authorization that splits
 * into two $47.50 captures — $45.00 of goods and $2.50 of shipping each, because `shippingShares` allocates
 * **per unit** (EC-FX-4). Those figures are the point: the assertions below check that PayPal charged the
 * halves we asked for.
 */
function liveHarness(): Harness {
  return harness({ lines: [{ sku: 'NW-001', qty: 2 }], client: liveClient() })
}

const MERCHANT: Actor = {
  initiatedBy: 'MERCHANT',
  actor: 'usr_00000000000000000000000002',
  note: 'sandbox run',
}

/* ------------------------------------------------------------------------------------------ */
/* Prerequisite suite                                                                            */
/* ------------------------------------------------------------------------------------------ */

/**
 * The "can we run at all?" suite. Its skipped tests carry the reason in the **name**, so a green run here
 * can never be mistaken for a run that really called PayPal.
 */
describe('AT-M11 live prerequisites', () => {
  it.skipIf(!HAS_CREDENTIALS)(`SKIPPED — ${CREDENTIALS_REASON}`, () => {
    expect(HAS_CREDENTIALS).toBe(true)
  })

  it.skipIf(VAULT_ID === '')(`SKIPPED — ${VAULT_REASON}`, () => {
    expect(VAULT_ID).not.toBe('')
  })

  it.skipIf(ENV_IS_SANDBOX)(`SKIPPED — ${ENV_REASON}`, () => {
    expect(ENV_IS_SANDBOX).toBe(true)
  })

  it.skipIf(!canRun)('SKIPPED — the live suite did not run', () => {
    expect(canRun).toBe(true)
  })
})

/* ------------------------------------------------------------------------------------------ */
/* The live suite                                                                                */
/* ------------------------------------------------------------------------------------------ */

describe.skipIf(!canRun)(`AT-M11 live sandbox (${SANDBOX_BASE_URL})`, () => {
  /**
   * §11 week-1 check **C2**: does a merchant-initiated `AUTHORIZE` order come back with the authorization
   * **inline**, or must a second `/authorize` call be made?
   *
   * `resolvePayment` takes the inline branch when PayPal puts an authorization in the create response and
   * the `/authorize` fallback otherwise, and records which on `orders.raw.countersign.authorizationPath`. So
   * this test asserts that one of the two ran and produced a live handle on the buyer's money, and **prints**
   * which — the log line *is* the C2 evidence, and it is the only reason to keep the assertion loose.
   */
  it('C2: creates an order against the vault and reports which authorization branch PayPal took', async () => {
    const h = liveHarness()
    const created = await createOrderFromDecisionDetailed(allowDecision(), h.deps)
    expect(created.ok, describeErr(created)).toBe(true)
    if (!created.ok) return

    expect(['INLINE', 'AUTHORIZE_ENDPOINT']).toContain(created.value.authorizationPath)
    const record = (
      created.value.order.raw as { countersign?: { authorizationPath?: string } } | null
    )?.countersign
    // The branch is recorded on the row, not merely returned, so the nightly log and the row agree.
    expect(record?.authorizationPath).toBe(created.value.authorizationPath)

    // A live handle on the money must exist on either branch: `INLINE` puts the authorization in the create
    // response, `AUTHORIZE_ENDPOINT` gets it from the second call. Both land in `authorizations`.
    expect([...h.world.rows.authorizations.values()]).toHaveLength(1)
    const auth = [...h.world.rows.authorizations.values()][0]
    expect(auth?.paypal_authorization_id).toBeTruthy()
    expect(auth?.status).toBe('CREATED')
    // $95.00 authorized, and our own amount is what was sent.
    expect(created.value.order.amount_minor).toBe(9_500n)

    // Deliberately visible: this line is the C2 answer for the nightly run.
    console.info(
      `[C2] authorizationPath=${created.value.authorizationPath} ` +
        `capturePath=${created.value.capturePath} authorizationId=${auth?.paypal_authorization_id ?? 'none'}`,
    )
  })

  it('AT-M11.5: the same decision twice is one order and one PayPal order, on one request id', async () => {
    const h = liveHarness()
    const first = await createOrderFromDecisionDetailed(allowDecision(), h.deps)
    expect(first.ok, describeErr(first)).toBe(true)
    if (!first.ok) return
    const second = await createOrderFromDecisionDetailed(allowDecision(), h.deps)
    expect(second.ok, describeErr(second)).toBe(true)
    if (!second.ok) return

    // One order row, one PayPal order, and the same `cs:{attemptId}:create` header both times — which is
    // what makes the second call a **read** of the first rather than a second charge.
    expect(second.value.order.id).toBe(first.value.order.id)
    expect(second.value.order.paypal_order_id).toBe(first.value.order.paypal_order_id)
    expect(second.value.requestId).toBe(first.value.requestId)
    expect(h.world.rows.orders.size).toBe(1)
  })

  it('AT-M11.1: two partial captures sum to the authorized amount, to the cent', async () => {
    const h = liveHarness()
    const order = await createOrderFromDecisionDetailed(allowDecision(), h.deps)
    expect(order.ok, describeErr(order)).toBe(true)
    if (!order.ok) return
    const orderId = order.value.order.id as OrderId

    const first = await captureShipment(
      orderId,
      { lines: [{ sku: 'NW-001', qty: 1 }], carrier: 'UPS', tracking: '1Z-SBX-000001' },
      h.deps,
    )
    expect(first.ok, describeErr(first)).toBe(true)
    if (!first.ok) return
    expect(first.value.amount.minor).toBe(4_750n)
    expect(first.value.finalCapture).toBe(false)

    const second = await captureShipment(
      orderId,
      { lines: [{ sku: 'NW-001', qty: 1 }], carrier: 'UPS', tracking: '1Z-SBX-000002' },
      h.deps,
    )
    expect(second.ok, describeErr(second)).toBe(true)
    if (!second.ok) return
    expect(second.value.amount.minor).toBe(4_750n)
    expect(second.value.finalCapture).toBe(true)

    // The invariant AT-M11.1 is named for, asserted against the amount PayPal actually charged.
    expect(first.value.amount.minor + second.value.amount.minor).toBe(
      order.value.order.amount_minor,
    )
    expect(second.value.remainingAfter).toBe(0n)
  })

  it('AT-M11.2: a void after the first shipment releases the remainder and no more', async () => {
    const h = liveHarness()
    const order = await createOrderFromDecisionDetailed(allowDecision(), h.deps)
    expect(order.ok, describeErr(order)).toBe(true)
    if (!order.ok) return
    const orderId = order.value.order.id as OrderId

    const first = await captureShipment(
      orderId,
      { lines: [{ sku: 'NW-001', qty: 1 }], carrier: 'UPS', tracking: '1Z-SBX-000003' },
      h.deps,
    )
    expect(first.ok, describeErr(first)).toBe(true)
    if (!first.ok) return

    const voided = await voidRemainder(orderId, 'OUT_OF_STOCK', h.deps)
    expect(voided.ok, describeErr(voided)).toBe(true)
    if (!voided.ok) return
    // Whatever we asked for, PayPal released; our side must equal `authorized − Σ money-holding captures`
    // and never the whole authorization — a void that also released the captured half loses the buyer twice.
    expect(voided.value.released.minor).toBe(
      order.value.order.amount_minor - first.value.amount.minor,
    )
    expect(voided.value.viaAuthorizationVoid).toBe(true)
    expect(h.reserved()).toBe(0n)
  })

  it('AT-M11.3 / AT-M11.4: refunds land on the exact remainder, and the over-refund never leaves the process', async () => {
    const h = liveHarness()
    const order = await createOrderFromDecisionDetailed(allowDecision(), h.deps)
    expect(order.ok, describeErr(order)).toBe(true)
    if (!order.ok) return
    const orderId = order.value.order.id as OrderId

    const captured = await captureShipment(
      orderId,
      { lines: [{ sku: 'NW-001', qty: 1 }], carrier: 'UPS', tracking: '1Z-SBX-000004' },
      h.deps,
    )
    expect(captured.ok, describeErr(captured)).toBe(true)
    if (!captured.ok) return
    const captureId = captured.value.capture.paypal_capture_id
    const total = captured.value.amount.minor

    // A partial refund, then the exact remainder. `'FULL'` resolves to a number **before** the request goes
    // out, so PayPal is asked for $23.75 and not for "the rest of it, roughly".
    const half = await refund(
      captureId,
      money(total / 2n, 'USD'),
      'MERCHANT_REQUEST',
      MERCHANT,
      h.deps,
      {
        idempotencyKey: `sandbox-half-${total}`,
      },
    )
    expect(half.ok, describeErr(half)).toBe(true)
    if (!half.ok) return
    expect(half.value.refundableAfter).toBe(total - total / 2n)

    const rest = await refund(captureId, 'FULL', 'RETURN', MERCHANT, h.deps, {
      idempotencyKey: `sandbox-rest-${total}`,
    })
    expect(rest.ok, describeErr(rest)).toBe(true)
    if (!rest.ok) return
    expect(rest.value.refundableAfter).toBe(0n)
    expect(rest.value.capture.status).toBe('REFUNDED')

    // AT-M11.4: refused locally. The strong claim is that **no request was made**, and the way to show that
    // on a live client is to reuse the same `PayPal-Request-Id` twice and see the sandbox dedupe it — so this
    // asserts only the refusal, and the no-call half stays in the offline suite where it is countable.
    const over = await refund(captureId, money(1n, 'USD'), 'RETURN', MERCHANT, h.deps)
    expect(over.ok).toBe(false)
    expect(over.ok === false && over.error.code).toBe('CS_VALIDATION')
  })

  it.skip(
    'AT-M11.6 (SKIPPED — needs a declining instrument: forcing a decline requires a sandbox account setup this repository does not own; the EC-CAP-5 logic is covered offline)',
  )

  it.skip(
    'EC-REF-4 (SKIPPED — needs a live dispute: PayPal only creates disputes for a buyer-initiated flow, so this needs a buyer persona and a wait)',
  )
})

function describeErr(r: { ok: boolean; error?: { code: string; message: string } }): string {
  return r.ok ? '' : `${r.error?.code}: ${r.error?.message}`
}
