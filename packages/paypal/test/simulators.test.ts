/**
 * The sandbox-only simulator bodies, asserted field by field.
 *
 * These four calls are the ones the PayPal API audit (`docs/verification/paypal-api-2026-10-04.md`)
 * found **fabricated**: every field name in them was invented, so all four would have failed live in a
 * judge's demo while every unit test still passed. They had no unit coverage at all before — only the
 * credential-gated `*.sandbox.test.ts` suite reached them, and that suite cannot run yet (H-01).
 *
 * So the shape of each request is pinned here against the documented request, and the assertions are
 * named after the fields the audit listed. The live behaviour of the simulators is still UNVERIFIED
 * and stays that way until the probe runs; what is verified here is only that we send what PayPal
 * documents.
 */
import { describe, expect, it } from 'vitest'

import { createLogger } from '@countersign/core'

import { PayPalClient } from '../src/client'
import { EVIDENCE_INPUT_FIELD } from '../src/multipart'
import { parseUnsignedAuthAssertion } from '../src/sandbox'
import {
  capturingLogger,
  chargebackResponse,
  fakeFetch,
  formParts,
  headerOf,
  jsonBody,
  linksResponse,
  partText,
  ppMoney,
  recordingSleep,
  testClock,
  tokenResponse,
} from './fixtures/transport-double'
import type { RecordedCall, Stub } from './fixtures/transport-double'

const BASE_URL = 'https://api-m.sandbox.paypal.com'
const BUYER_EMAIL = 'buyer-4829137365@sandbox.paypal.com'
const DISPUTE_ID = 'PP-D-2781AB12CD34'
const CAPTURE_ID = '3C679366HH908993F'
const MERCHANT_ID = '9KX436DUC84BN'

function makeClient(responder: Stub) {
  const fetchImpl = fakeFetch(responder)
  const client = new PayPalClient({
    baseUrl: BASE_URL,
    clientId: 'AY_FAKE_SANDBOX_CLIENT_ID_00000000',
    clientSecret: 'EL_FAKE_SANDBOX_SECRET_00000000',
    clock: testClock(),
    fetchImpl,
    sleep: recordingSleep().sleep,
    logger: createLogger({ level: 'error', sink: capturingLogger().sink }),
    env: { PAYPAL_ENV: 'sandbox', PAYPAL_API_BASE: BASE_URL },
  })
  return { client, fetchImpl }
}

const isToken = (c: RecordedCall) => c.url.endsWith('/v1/oauth2/token')
const callTo = (calls: readonly RecordedCall[], fragment: string) =>
  calls.find((c) => c.url.includes(fragment)) as RecordedCall

describe('createBuyerDispute (§10.2 #18, report §1/#1)', () => {
  it('POSTs multipart/form-data with one `input` part — not a JSON body', async () => {
    // `transaction_id` / `dispute_reason` as JSON were both wrong: the endpoint is
    // `multipart/form-data` and is not in `SPEC-D` at all. `TGL` is the only source.
    const { client, fetchImpl } = makeClient((call) => (isToken(call) ? tokenResponse() : linksResponse()))
    const result = await client.sandbox.createBuyerDispute(BUYER_EMAIL, {
      disputed_transactions: [{ buyer_transaction_id: CAPTURE_ID }],
      reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      dispute_amount: ppMoney('20.00'),
    })
    expect(result.ok).toBe(true)

    const call = callTo(fetchImpl.calls, '/v1/customer/disputes')
    expect(call.method).toBe('POST')
    expect(call.body).toBeInstanceOf(FormData)
    // No hand-written boundary: the runtime derives it from the FormData.
    expect(headerOf(call, 'content-type')).toBeUndefined()

    const parts = formParts(call)
    expect(parts.map((p) => p.name)).toEqual([EVIDENCE_INPUT_FIELD])
    const wire = JSON.parse(await partText(parts[0]!.value)) as Record<string, unknown>
    expect(wire).toEqual({
      disputed_transactions: [{ buyer_transaction_id: CAPTURE_ID }],
      reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      dispute_amount: { currency_code: 'USD', value: '20.00' },
    })
  })

  it('never sends the invented `transaction_id` or `dispute_reason` names', async () => {
    const { client, fetchImpl } = makeClient((call) => (isToken(call) ? tokenResponse() : linksResponse()))
    await client.sandbox.createBuyerDispute(BUYER_EMAIL, {
      disputed_transactions: [{ buyer_transaction_id: CAPTURE_ID }],
      reason: 'UNAUTHORISED',
    })
    const call = callTo(fetchImpl.calls, '/v1/customer/disputes')
    const text = JSON.stringify(formParts(call).map((p) => p.name))
    expect(text).not.toContain('transaction_id')
    const input = JSON.parse(await partText(formParts(call)[0]!.value)) as Record<string, unknown>
    expect(input['transaction_id']).toBeUndefined()
    expect(input['dispute_reason']).toBeUndefined()
    expect(input['reason']).toBe('UNAUTHORISED')
  })

  it('carries `extensions` when the caller supplies it', async () => {
    const { client, fetchImpl } = makeClient((call) => (isToken(call) ? tokenResponse() : linksResponse()))
    await client.sandbox.createBuyerDispute(BUYER_EMAIL, {
      disputed_transactions: [{ buyer_transaction_id: CAPTURE_ID }],
      reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      extensions: {
        merchant_contacted: true,
        merchant_contacted_outcome: 'NO_RESPONSE',
        merchandise_dispute_properties: { issue_type: 'PRODUCT' },
      },
    })
    const input = JSON.parse(await partText(formParts(callTo(fetchImpl.calls, '/v1/customer/disputes'))[0]!.value))
    expect(input.extensions).toEqual({
      merchant_contacted: true,
      merchant_contacted_outcome: 'NO_RESPONSE',
      merchandise_dispute_properties: { issue_type: 'PRODUCT' },
    })
  })

  it('sends the unsigned PayPal-Auth-Assertion, header included in `typ: JWT`', async () => {
    const { client, fetchImpl } = makeClient((call) => (isToken(call) ? tokenResponse() : linksResponse()))
    await client.sandbox.createBuyerDispute(BUYER_EMAIL, {
      disputed_transactions: [{ buyer_transaction_id: CAPTURE_ID }],
      reason: 'UNAUTHORISED',
    })
    const assertion = headerOf(callTo(fetchImpl.calls, '/v1/customer/disputes'), 'paypal-auth-assertion')
    expect(assertion).toBeDefined()
    const parsed = parseUnsignedAuthAssertion(assertion ?? '')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.alg).toBe('none')
    expect(parsed.value.typ).toBe('JWT')
    expect(parsed.value.email).toBe(BUYER_EMAIL)
    expect(parsed.value.signature).toBe('')
  })

  it('refuses a body with no disputed transaction, before any HTTP call', async () => {
    const { client, fetchImpl } = makeClient(tokenResponse())
    // @ts-expect-error `disputed_transactions` is required by the documented `input` part.
    const result = await client.sandbox.createBuyerDispute(BUYER_EMAIL, { reason: 'UNAUTHORISED' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_VALIDATION')
    expect(fetchImpl.calls).toHaveLength(0)
  })
})

describe('processChargeback (§10.2 #18, report §27/#2)', () => {
  const chargeback = () => ({
    sellerTransactionId: CAPTURE_ID,
    merchantId: MERCHANT_ID,
    amount: ppMoney('20.00'),
    reason: 'UNAUTHORISED',
    reasonCode: '1330',
    cardBrand: 'VISA',
    creditCardTransactionId: '2347289342893472',
    receiveDate: '2026-10-04T12:05:22.544Z',
  })

  it('carries every field the documented request lists', async () => {
    // The old body was `{transaction_id, reason}` — not one of these names appears in PayPal's
    // contract, so the call would have been rejected before it created anything.
    const { client, fetchImpl } = makeClient((call) =>
      isToken(call) ? tokenResponse() : chargebackResponse({ disputeId: 'PP-CB-2781AB12CD34' }),
    )
    const result = await client.sandbox.processChargeback(chargeback())
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const body = jsonBody<Record<string, unknown>>(callTo(fetchImpl.calls, '/process-chargeback'))
    // The six documented top-level keys, with PayPal's own values.
    expect(body['adjacency']).toBe('PAYPAL')
    expect(body['file_layout']).toBe('ATCK_CB')
    expect(body['merchant_id']).toBe(MERCHANT_ID)
    expect(body['financial_institution']).toEqual({ processor: 'FDMS' })

    const transaction = body['transaction'] as Record<string, unknown>
    expect(transaction['id_enc']).toBe(CAPTURE_ID)
    expect(transaction['amount']).toEqual({ currency_code: 'USD', value: '20.00' })

    const instrument = body['instrument'] as Record<string, unknown>
    expect(instrument['instrument_type']).toBe('CARD')
    expect(instrument['card_brand']).toBe('VISA')

    const dispute = body['dispute'] as Record<string, unknown>
    expect(dispute['stage']).toBe('CHARGEBACK')
    expect(dispute['receive_date']).toBe('2026-10-04T12:05:22.544Z')
    expect(dispute['money_movement_date']).toBe('2026-10-04T12:05:22.544Z')
    expect(dispute['event_code']).toBe('CHARGEBACK_INITIATED')
    expect(dispute['processor_info']).toMatchObject({ reason_code: '1330', notes: 'UNAUTHORISED' })

    // And none of the invented names.
    expect(body['transaction_id']).toBeUndefined()
    expect(body['reason']).toBeUndefined()
  })

  it('reads the 201 body instead of discarding it', async () => {
    // The call answers `201 Created` with a dispute id; `schema: null` threw it away, which is how a
    // chargeback simulator would leave the caller unable to find what it just created.
    const { client } = makeClient((call) =>
      isToken(call) ? tokenResponse() : chargebackResponse({ disputeId: 'PP-CB-7788FFEE0011' }),
    )
    const result = await client.sandbox.processChargeback(chargeback())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.dispute_id).toBe('PP-CB-7788FFEE0011')
    expect(result.value.links?.[0]?.rel).toBe('self')
  })

  it('refuses to build a body with no merchant id, amount or seller transaction', async () => {
    const { client, fetchImpl } = makeClient(tokenResponse())
    const noMerchant = await client.sandbox.processChargeback({ ...chargeback(), merchantId: '  ' })
    const noTxn = await client.sandbox.processChargeback({ ...chargeback(), sellerTransactionId: '' })
    const noAmount = await client.sandbox.processChargeback({
      ...chargeback(),
      // @ts-expect-error amount is required: PayPal documents transaction.amount.
      amount: undefined,
    })
    for (const r of [noMerchant, noTxn, noAmount]) {
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.code).toBe('CS_VALIDATION')
    }
    expect(fetchImpl.calls).toHaveLength(0)
  })

  it('refuses a float amount, because money is never a float here either', async () => {
    const { client } = makeClient(tokenResponse())
    const result = await client.sandbox.processChargeback({
      ...chargeback(),
      // @ts-expect-error money is a decimal string.
      amount: { currency_code: 'USD', value: 20 },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_VALIDATION')
  })
})

describe('changeReason (§10.2 #18, report §30/#13)', () => {
  it('sends {reason, note, item_info[]} in an `input` part, not a bare JSON body', async () => {
    const { client, fetchImpl } = makeClient((call) => (isToken(call) ? tokenResponse() : linksResponse()))
    const result = await client.sandbox.changeReason(DISPUTE_ID, {
      reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
      note: 'Product is not as advertised',
      item_info: [
        {
          item_name: 'Trail Runner, size 9',
          item_quantity: '1',
          reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
          item_type: 'PRODUCT',
          product_details: { sub_reason: 'NOT_AS_DESCRIBED', category: 'PRODUCT' },
          expected_refund: ppMoney('10.00'),
        },
      ],
    })
    expect(result.ok).toBe(true)

    const call = callTo(fetchImpl.calls, '/change-reason')
    expect(call.body).toBeInstanceOf(FormData)
    expect(headerOf(call, 'content-type')).toBeUndefined()
    const parts = formParts(call)
    expect(parts.map((p) => p.name)).toEqual([EVIDENCE_INPUT_FIELD])
    const input = JSON.parse(await partText(parts[0]!.value)) as Record<string, unknown>
    expect(input['reason']).toBe('MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED')
    expect(input['note']).toBe('Product is not as advertised')
    expect((input['item_info'] as unknown[])[0]).toMatchObject({
      item_name: 'Trail Runner, size 9',
      expected_refund: { currency_code: 'USD', value: '10.00' },
    })
  })

  it('refuses a change with no reason', async () => {
    const { client, fetchImpl } = makeClient(tokenResponse())
    // @ts-expect-error `reason` is required by the documented `input` part.
    const result = await client.sandbox.changeReason(DISPUTE_ID, { note: 'no reason given' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_VALIDATION')
    expect(fetchImpl.calls).toHaveLength(0)
  })
})

describe('acceptOffer / denyOffer (report §30/#12)', () => {
  it('sends {note}, never the invented {payer_note}', async () => {
    const { client, fetchImpl } = makeClient((call) => (isToken(call) ? tokenResponse() : linksResponse()))
    const result = await client.sandbox.acceptOffer(DISPUTE_ID, 'I am ok with the refund offered.')
    expect(result.ok).toBe(true)
    const body = jsonBody<Record<string, unknown>>(callTo(fetchImpl.calls, '/accept-offer'))
    expect(body).toEqual({ note: 'I am ok with the refund offered.' })
    expect(body['payer_note']).toBeUndefined()
  })

  it('treats 202 Accepted as success, because the money movement may be delayed', async () => {
    // PayPal documents `200 OK`, or **`202 Accepted`** "if the offer's money movement is delayed".
    // Reporting that as a failure would make the Defender re-accept an offer the buyer already took.
    const { client } = makeClient((call) =>
      isToken(call) ? tokenResponse() : { status: 202, body: { links: [] } },
    )
    const result = await client.sandbox.acceptOffer(DISPUTE_ID, 'Accepted')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.links).toEqual([])
  })

  it('treats a body-less 202 as success too', async () => {
    const { client } = makeClient((call) => (isToken(call) ? tokenResponse() : { status: 202 }))
    const result = await client.sandbox.acceptOffer(DISPUTE_ID)
    expect(result.ok).toBe(true)
  })

  it('denyOffer still sends {note}, which was already correct', async () => {
    const { client, fetchImpl } = makeClient((call) => (isToken(call) ? tokenResponse() : linksResponse()))
    const result = await client.sandbox.denyOffer(DISPUTE_ID, 'refund offer is very low.')
    expect(result.ok).toBe(true)
    expect(jsonBody<Record<string, unknown>>(callTo(fetchImpl.calls, '/deny-offer'))).toEqual({
      note: 'refund offer is very low.',
    })
  })
})

describe('requireEvidence and adjudicate (§10.2 #18, report §28/§29)', () => {
  it('requireEvidence sends {action} and adjudicate {adjudication_outcome}', async () => {
    // Verified against SPEC-D and TGL: `action` is BUYER_EVIDENCE | SELLER_EVIDENCE and
    // `adjudication_outcome` is BUYER_FAVOR | SELLER_FAVOR, both plain JSON bodies.
    const { client, fetchImpl } = makeClient((call) => (isToken(call) ? tokenResponse() : linksResponse()))
    expect((await client.sandbox.requireEvidence(DISPUTE_ID, 'SELLER_EVIDENCE')).ok).toBe(true)
    expect((await client.sandbox.adjudicate(DISPUTE_ID, 'SELLER_FAVOR')).ok).toBe(true)
    expect(jsonBody(callTo(fetchImpl.calls, '/require-evidence'))).toEqual({ action: 'SELLER_EVIDENCE' })
    expect(jsonBody(callTo(fetchImpl.calls, '/adjudicate'))).toEqual({ adjudication_outcome: 'SELLER_FAVOR' })
  })

  it('refuses an action or outcome outside the documented enums', async () => {
    const { client, fetchImpl } = makeClient(tokenResponse())
    expect((await client.sandbox.requireEvidence(DISPUTE_ID, 'NOPE' as 'SELLER_EVIDENCE')).ok).toBe(false)
    expect((await client.sandbox.adjudicate(DISPUTE_ID, 'NOPE' as 'SELLER_FAVOR')).ok).toBe(false)
    expect(fetchImpl.calls).toHaveLength(0)
  })
})
