/**
 * AT-M6.5 — sandbox integration: create order → authorize → partial capture → partial refund →
 * get refund (spec §8.6, D21 "nightly").
 *
 * **Opt-in.** Excluded from `pnpm test`; run with:
 *
 * ```
 * pnpm --filter @countersign/paypal test:sandbox
 * ```
 *
 * Requires real sandbox credentials (`docs/HUMAN_TODO.md` H-01) and a vault id from a completed
 * onboarding run (`PAYPAL_TEST_VAULT_ID`). Without them every test below **skips** with the reason in
 * its name — it never fails, and it never passes without having called PayPal.
 *
 * ## What this suite is honest about
 *
 * Whether a merchant-initiated `AUTHORIZE` order produces an authorization without buyer action is
 * **spec U2** — unverified, and the subject of week-1 check C2. So this test does not assume it: it
 * tries `AUTHORIZE`, and if PayPal demands payer action it records that fact and falls back to
 * `CAPTURE`, exactly as §11 C2 prescribes. What it does assert is the part we own: the partial
 * capture, the partial refund and the refund read-back agree on ids and amounts.
 */
import { describe, expect, it } from 'vitest'

import { newId } from '@countersign/core'
import type { Order } from '../src/types'

import { captureRequestId, orderCreateRequestId, refundRequestId } from '../src/idempotency'
import { HAS_CREDENTIALS, SANDBOX_BASE_URL, SKIP_REASON, VAULT_ID, liveClient, ppMoney } from './fixtures/sandbox-env'

const NEEDS_VAULT =
  'PAYPAL_TEST_VAULT_ID is absent: run the §8.7 onboarding once against sandbox and export the payment-token id.'
const canRun = HAS_CREDENTIALS && VAULT_ID !== ''

/** `purchase_units[].payments.authorizations[].id` — where an AUTHORIZE order puts it. */
function authorizationIdOf(order: Order): string | undefined {
  for (const unit of order.purchase_units ?? []) {
    const id = unit.payments?.authorizations?.[0]?.id
    if (id) return id
  }
  return undefined
}

/** `purchase_units[].payments.captures[].id` — where a CAPTURE order puts it. */
function captureIdOf(order: Order): string | undefined {
  for (const unit of order.purchase_units ?? []) {
    const id = unit.payments?.captures?.[0]?.id
    if (id) return id
  }
  return undefined
}

async function refundAndReadBack(
  client: ReturnType<typeof liveClient>,
  captureId: string,
  amount: string,
): Promise<void> {
  const refundId = newId('ref')
  const refunded = await client.refundCapture(
    captureId,
    { amount: ppMoney(amount), note_to_payer: 'Sandbox partial refund (AT-M6.5).' },
    { requestId: refundRequestId(captureId, refundId) },
  )
  expect(refunded.ok, refunded.ok ? '' : refunded.error.message).toBe(true)
  if (!refunded.ok) return
  expect(refunded.value.amount?.value).toBe(amount)

  const fetched = await client.getRefund(refunded.value.id)
  expect(fetched.ok, fetched.ok ? '' : fetched.error.message).toBe(true)
  if (!fetched.ok) return
  // The read-back is what the receipt and the budget ledger both trust.
  expect(fetched.value.id).toBe(refunded.value.id)
  expect(fetched.value.amount?.value).toBe(amount)
  expect(['PENDING', 'COMPLETED']).toContain(fetched.value.status)
}

/**
 * The "can we run at all?" suite. A single skipped test carrying its reason in the name, so a green run
 * here can never be mistaken for a run that really called PayPal.
 */
describe('AT-M6.5 prerequisites', () => {
  it.skipIf(!HAS_CREDENTIALS)(`SKIPPED — ${SKIP_REASON}`, () => {
    expect(HAS_CREDENTIALS).toBe(true)
  })

  it.skipIf(!VAULT_ID)(`SKIPPED — ${NEEDS_VAULT}`, () => {
    expect(VAULT_ID).not.toBe('')
  })
})

describe.skipIf(!canRun)(`AT-M6.5 live sandbox (${SANDBOX_BASE_URL})`, () => {
  const EVIDENCE_HASH = `cs1:${'A'.repeat(43)}`

  const purchaseUnit = (value: string, orderId: string) => ({
    reference_id: 'default',
    // D18: the chain hash and our own order id, inside PayPal's own records.
    custom_id: EVIDENCE_HASH,
    invoice_id: orderId,
    amount: ppMoney(value),
  })

  it('create order → authorize → partial capture → partial refund → get refund', async () => {
    expect(VAULT_ID, NEEDS_VAULT).not.toBe('')
    const client = liveClient()

    const orderId = newId('ord')
    // --- 1. create the order, AUTHORIZE intent (D17: physical goods) ---
    const created = await client.createOrder(
      {
        intent: 'AUTHORIZE',
        purchase_units: [purchaseUnit('48.00', orderId)],
        payment_source: { paypal: { vault_id: VAULT_ID } },
      },
      { requestId: orderCreateRequestId(newId('att')) },
    )
    expect(created.ok, created.ok ? '' : `${created.error.code}: ${created.error.message}`).toBe(true)
    if (!created.ok) return

    // --- 2. an inline authorization, or one from /authorize (spec U2) ---
    let authorizationId = authorizationIdOf(created.value)

    if (!authorizationId) {
      const authorized = await client.authorizeOrder(created.value.id, {
        requestId: orderCreateRequestId(newId('att')),
      })
      if (authorized.ok) {
        authorizationId = authorizationIdOf(authorized.value)
        expect(
          authorizationId,
          'sandbox produced neither an inline nor an /authorize authorization — record this for U2/C2',
        ).toBeTruthy()
      } else {
        // The documented fallback (§11 C2): CAPTURE instead of AUTHORIZE, then refund.
        expect(
          ['PP_PAYER_ACTION_REQUIRED', 'PP_UNPROCESSABLE'],
          `unexpected error from /authorize: ${authorized.error.code} ${authorized.error.message}`,
        ).toContain(authorized.error.code)
        const captured = await client.createOrder(
          {
            intent: 'CAPTURE',
            purchase_units: [purchaseUnit('48.00', orderId)],
            payment_source: { paypal: { vault_id: VAULT_ID } },
          },
          { requestId: orderCreateRequestId(newId('att')) },
        )
        expect(captured.ok, captured.ok ? '' : `${captured.error.code}: ${captured.error.message}`).toBe(true)
        if (!captured.ok) return
        const captureId = captureIdOf(captured.value)
        expect(captureId, 'a CAPTURE order produced no capture').toBeTruthy()
        if (!captureId) return
        await refundAndReadBack(client, captureId, '5.00')
        return
      }
    }

    // --- 3. partial capture (EC-SPLIT-1) ---
    expect(authorizationId).toBeTruthy()
    if (!authorizationId) return
    const shipmentId = newId('shp')
    const capture = await client.captureAuthorization(
      authorizationId,
      { amount: ppMoney('20.00'), final_capture: false, invoice_id: orderId },
      { requestId: captureRequestId(authorizationId, shipmentId) },
    )
    expect(capture.ok, capture.ok ? '' : `${capture.error.code}: ${capture.error.message}`).toBe(true)
    if (!capture.ok) return
    expect(capture.value.amount?.value).toBe('20.00')
    expect(capture.value.final_capture).toBe(false)
    expect(capture.value.invoice_id).toBe(orderId)

    // --- 4. partial refund, then read it back (§12.1) ---
    await refundAndReadBack(client, capture.value.id, '5.00')
  })

  it('re-sending the same create request id returns the same order, not a second one (EC-IDEM-2)', async () => {
    // This is the claim [B14] makes for Orders v2, and the probe that settles the Orders v2 row of
    // IDEMPOTENCY.md. It lives here, not in the unit suite, because a fake fetch cannot answer it.
    expect(VAULT_ID, NEEDS_VAULT).not.toBe('')
    const client = liveClient()

    const requestId = orderCreateRequestId(newId('att'))
    const orderId = newId('ord')
    const body = {
      intent: 'CAPTURE' as const,
      purchase_units: [
        {
          reference_id: 'default',
          custom_id: `cs1:${'A'.repeat(43)}`,
          invoice_id: orderId,
          amount: ppMoney('48.00'),
        },
      ],
      payment_source: { paypal: { vault_id: VAULT_ID } },
    }

    const first = await client.createOrder(body, { requestId })
    expect(first.ok, first.ok ? '' : `${first.error.code}: ${first.error.message}`).toBe(true)
    if (!first.ok) return

    const second = await client.createOrder(body, { requestId })
    if (!second.ok) {
      // PayPal may reject the replay outright rather than deduplicating it. Either way the Orders v2
      // row of IDEMPOTENCY.md now has a measured answer; this message is how it gets recorded.
      throw new Error(
        `PayPal did not accept the replayed request id: ${second.error.code} ${second.error.message}. ` +
          'Update IDEMPOTENCY.md with the observed behaviour and which HTTP status it produced.',
      )
    }
    expect(second.value.id).toBe(first.value.id)
  })

  it('the sandbox base URL is never a live host (EC-ENV-1)', () => {
    expect(SANDBOX_BASE_URL).toMatch(/sandbox\.paypal\.com$/)
  })
})