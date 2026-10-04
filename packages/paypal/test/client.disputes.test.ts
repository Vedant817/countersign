/**
 * Customer Disputes v1 — spec §10.2 #13–17, [V3] [B16], §12.11, §8.16.
 *
 * The fields asserted here are the ones the Defender routes on: `dispute_state`,
 * `dispute_life_cycle_stage`, `status`, `dispute_reason`, `seller_response_due_date`,
 * `adjudication_outcome` and `require_evidence.action`.
 */
import { describe, expect, it } from 'vitest'

import { createLogger } from '@countersign/core'

import { PayPalClient } from '../src/client'
import { DISPUTE_STATES, DISPUTE_STATUSES } from '../src/types'
import {
  capturingLogger,
  disputeListResponse,
  disputeResponse,
  fakeFetch,
  headerOf,
  jsonBody,
  linksResponse,
  paypalErrorResponse,
  ppMoney,
  rateLimitedResponse,
  recordingSleep,
  testClock,
  tokenResponse,
  verifyWebhookResponse,
} from './fixtures/transport-double'
import type { RecordedCall, Stub } from './fixtures/transport-double'

const BASE_URL = 'https://api-m.sandbox.paypal.com'
const DISPUTE_ID = 'PP-D-2781AB12CD34'
const CAPTURE_ID = '3C679366HH908993F'
const WEBHOOK_ID = '1AB23456CD789012E'

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

describe('listDisputes (§10.2 #13)', () => {
  it('GETs the list with the query string the reconciler uses', async () => {
    const { client, fetchImpl } = makeClient((call) =>
      isToken(call) ? tokenResponse() : disputeListResponse(2),
    )
    const result = await client.listDisputes({
      start_time: '2026-10-04T00:00:00Z',
      dispute_state: 'WAITING_FOR_SELLER_RESPONSE',
      page_size: 25,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.items).toHaveLength(2)

    const call = callTo(fetchImpl.calls, '/v1/customer/disputes')
    expect(call.url).toContain('start_time=2026-10-04T00%3A00%3A00Z')
    expect(call.url).toContain('dispute_state=WAITING_FOR_SELLER_RESPONSE')
    expect(call.url).toContain('page_size=25')
  })

  it('defaults items to an empty array so the 2-minute reconciler never crashes', async () => {
    const { client } = makeClient((call) =>
      isToken(call) ? tokenResponse() : { status: 200, body: { total_pages: 0 } },
    )
    const result = await client.listDisputes({})
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.items).toEqual([])
  })

  it('parses each dispute into the fields the router reads', async () => {
    const { client } = makeClient((call) => (isToken(call) ? tokenResponse() : disputeListResponse(1)))
    const result = await client.listDisputes({})
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const d = result.value.items[0]
    expect(d?.dispute_id).toBeDefined()
    expect(d?.dispute_reason).toBe('UNAUTHORISED')
    expect(d?.dispute_life_cycle_stage).toBe('CHARGEBACK')
    expect(d?.seller_transaction_id).toBe(CAPTURE_ID)
    expect(d?.seller_response_due_date).toBe('2026-10-11T09:59:59Z')
    expect(d?.dispute_amount?.value).toBe('48.00')
  })

  it('RATE_LIMIT_REACHED → PP_RATE_LIMITED, retryable', async () => {
    const { client } = makeClient((call) =>
      isToken(call) ? tokenResponse() : rateLimitedResponse(1),
    )
    const result = await client.listDisputes({})
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('PP_RATE_LIMITED')
    expect(result.error.retryable).toBe(true)
    // EC-PP-2: the reconciler throttles itself from this, so the header must survive.
    expect(result.error.details?.['retry_after']).toBe('1')
  })
})

describe('getDispute', () => {
  it('returns the deadline as the RFC 3339 string it arrived as', async () => {
    // EC-TIME-6: stored UTC, rendered IST at the edge. Converting here would move the deadline.
    const { client } = makeClient((call) =>
      isToken(call) ? tokenResponse() : disputeResponse({ dueDate: '2026-10-11T09:59:59Z' }),
    )
    const result = await client.getDispute(DISPUTE_ID)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.seller_response_due_date).toBe('2026-10-11T09:59:59Z')
    expect(result.value.require_evidence?.action).toBe('SELLER_EVIDENCE')
  })

  it('accepts an unknown dispute_state instead of failing the whole read', async () => {
    // A zod enum here would turn a PayPal-side addition into a dead reconciler.
    const { client } = makeClient((call) =>
      isToken(call) ? tokenResponse() : disputeResponse({ state: 'SOMETHING_NEW' }),
    )
    const result = await client.getDispute(DISPUTE_ID)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.dispute_state).toBe('SOMETHING_NEW')
  })

  it('404 → PP_NOT_FOUND (EC-DSP-9 / EC-WH-6: a foreign transaction)', async () => {
    const { client } = makeClient((call) =>
      isToken(call) ? tokenResponse() : { status: 404, body: { name: 'RESOURCE_NOT_FOUND' } },
    )
    const result = await client.getDispute(DISPUTE_ID)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('PP_NOT_FOUND')
  })

  it('exports the known state and status sets it branches on', () => {
    // §8.15 filing guard: `status === 'WAITING_FOR_SELLER_RESPONSE'`.
    expect(DISPUTE_STATUSES).toContain('WAITING_FOR_SELLER_RESPONSE')
    // §8.16: appeal only when `dispute_state === 'APPEALABLE'` [B16].
    expect(DISPUTE_STATES).toContain('APPEALABLE')
    expect(DISPUTE_STATES).toContain('WAITING_FOR_SELLER_RESPONSE')
  })
})

describe('acceptClaim (§10.2 #15)', () => {
  it('POSTs accept_claim_type', async () => {
    const { client, fetchImpl } = makeClient((call) => (isToken(call) ? tokenResponse() : linksResponse()))
    const result = await client.acceptClaim(DISPUTE_ID, { accept_claim_type: 'REFUND_NO_RETURN' })
    expect(result.ok).toBe(true)
    const call = callTo(fetchImpl.calls, '/accept-claim')
    expect(jsonBody<Record<string, unknown>>(call)).toEqual({ accept_claim_type: 'REFUND_NO_RETURN' })
  })

  it('defaults links to [] when the endpoint answers with no body', async () => {
    // TODO(verify against docs): these endpoints answer 204. Either way the caller gets a Links.
    const { client } = makeClient((call) => (isToken(call) ? tokenResponse() : { status: 204 }))
    const result = await client.acceptClaim(DISPUTE_ID, { accept_claim_type: 'REFUND' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.links).toEqual([])
  })

  it('refuses a claim with no type', async () => {
    const { client, fetchImpl } = makeClient(tokenResponse())
    const result = await client.acceptClaim(DISPUTE_ID, {} as { accept_claim_type: string })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_VALIDATION')
    expect(fetchImpl.calls).toHaveLength(0)
  })
})

describe('makeOffer (§10.2 #15, EC-BUY-1)', () => {
  it('POSTs the offer amount as a decimal string', async () => {
    const { client, fetchImpl } = makeClient((call) => (isToken(call) ? tokenResponse() : linksResponse()))
    const result = await client.makeOffer(DISPUTE_ID, {
      offer_amount: ppMoney('35.66'),
      // EC-BUY-1: a return costs the merchant less than an $82 MRC fee.
      offer_type: 'REFUND_WITH_RETURN',
      terms: 'Return the item within 14 days for a full refund.',
      note: 'We can offer a partial refund with a return.',
    })
    expect(result.ok).toBe(true)
    const call = callTo(fetchImpl.calls, '/make-offer')
    expect(jsonBody<Record<string, unknown>>(call)).toEqual({
      offer_amount: { currency_code: 'USD', value: '35.66' },
      offer_type: 'REFUND_WITH_RETURN',
      terms: 'Return the item within 14 days for a full refund.',
      note: 'We can offer a partial refund with a return.',
    })
  })

  it('refuses an offer with no amount or no type', async () => {
    const { client, fetchImpl } = makeClient(tokenResponse())
    const noAmount = await client.makeOffer(
      DISPUTE_ID,
      // @ts-expect-error offer_amount is required by the API.
      { offer_type: 'REFUND_WITH_RETURN' },
    )
    const noType = await client.makeOffer(
      DISPUTE_ID,
      // @ts-expect-error offer_type is required by the API.
      { offer_amount: ppMoney('1.00') },
    )
    expect(noAmount.ok).toBe(false)
    expect(noType.ok).toBe(false)
    expect(fetchImpl.calls).toHaveLength(0)
  })

  it('refuses a float offer amount', async () => {
    const { client } = makeClient(tokenResponse())
    const result = await client.makeOffer(DISPUTE_ID, {
      // @ts-expect-error money is a decimal string, never a JS number.
      offer_amount: { currency_code: 'USD', value: 35.66 },
      offer_type: 'REFUND_WITH_RETURN',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_VALIDATION')
  })
})

describe('sendMessage, acknowledgeReturnItem, escalate (§10.2 #16)', () => {
  it('sendMessage posts the message', async () => {
    const { client, fetchImpl } = makeClient((call) => (isToken(call) ? tokenResponse() : linksResponse()))
    const result = await client.sendMessage(DISPUTE_ID, 'We have shipped; tracking is inside.')
    expect(result.ok).toBe(true)
    const call = callTo(fetchImpl.calls, '/send-message')
    expect(jsonBody<Record<string, unknown>>(call)).toEqual({ message: 'We have shipped; tracking is inside.' })
    expect(headerOf(call, 'content-type')).toBe('application/json')
  })

  it('sendMessage refuses an empty message rather than posting a blank', async () => {
    const { client, fetchImpl } = makeClient(tokenResponse())
    const result = await client.sendMessage(DISPUTE_ID, '   ')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_VALIDATION')
    expect(fetchImpl.calls).toHaveLength(0)
  })

  it('acknowledgeReturnItem posts the note', async () => {
    const { client, fetchImpl } = makeClient((call) => (isToken(call) ? tokenResponse() : linksResponse()))
    const result = await client.acknowledgeReturnItem(DISPUTE_ID, { note: 'Return received, refunding today.' })
    expect(result.ok).toBe(true)
    expect(jsonBody<Record<string, unknown>>(callTo(fetchImpl.calls, '/acknowledge-return-item'))).toEqual({
      note: 'Return received, refunding today.',
    })
  })

  it('escalate posts the note', async () => {
    const { client, fetchImpl } = makeClient((call) => (isToken(call) ? tokenResponse() : linksResponse()))
    const result = await client.escalate(DISPUTE_ID, 'Escalating: tracking confirms delivery on 1 Oct.')
    expect(result.ok).toBe(true)
    expect(jsonBody<Record<string, unknown>>(callTo(fetchImpl.calls, '/escalate'))).toEqual({
      note: 'Escalating: tracking confirms delivery on 1 Oct.',
    })
  })

  it('escalate refuses an empty note', async () => {
    const { client } = makeClient(tokenResponse())
    const result = await client.escalate(DISPUTE_ID, '')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_VALIDATION')
  })
})

describe('provideSupportingInfo (§10.2 #16)', () => {
  it('posts the notes as the multipart input part', async () => {
    const { client, fetchImpl } = makeClient((call) => (isToken(call) ? tokenResponse() : linksResponse()))
    const result = await client.provideSupportingInfo(DISPUTE_ID, 'Carrier scan attached.', [])
    expect(result.ok).toBe(true)
    const call = callTo(fetchImpl.calls, '/provide-supporting-info')
    expect(call.body).toBeInstanceOf(FormData)
    expect(headerOf(call, 'content-type')).toBeUndefined()
  })

  it('refuses empty notes', async () => {
    const { client, fetchImpl } = makeClient(tokenResponse())
    const result = await client.provideSupportingInfo(DISPUTE_ID, '', [])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_VALIDATION')
    expect(fetchImpl.calls).toHaveLength(0)
  })
})

describe('wrong-state handling', () => {
  it('a PayPal "not allowed in this state" is PP_UNPROCESSABLE, and the Defender decides', async () => {
    // §8.15 DEF_WRONG_STATE is a *local* decision (M15); M6's job is to surface PayPal's rejection
    // faithfully rather than invent a state machine of its own.
    const { client } = makeClient((call) =>
      isToken(call)
        ? tokenResponse()
        : paypalErrorResponse('DISPUTE_STATE_NOT_ALLOWED', 'DISPUTE_STATE_NOT_ALLOWED', 422),
    )
    const result = await client.provideEvidence(DISPUTE_ID, { evidence_type: 'PROOF_OF_FULFILLMENT', notes: [] }, [])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('PP_UNPROCESSABLE')
    expect(result.error.details?.['issue']).toBe('DISPUTE_STATE_NOT_ALLOWED')
    expect(result.error.retryable).toBe(false)
  })
})

describe('verifyWebhookSignature (§10.2 #12, [V14], EC-WH-4)', () => {
  const headers = {
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-cert-url': 'https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42',
    'paypal-transmission-id': 'b1c2d3e4-0000-1111-2222-333344445555',
    'paypal-transmission-sig': 'abcDEF123==',
    'paypal-transmission-time': '2026-10-04T12:00:00Z',
  }
  const event = {
    id: 'WH-1',
    event_type: 'PAYMENT.CAPTURE.COMPLETED',
    resource: { id: CAPTURE_ID },
  }

  it('SUCCESS for a verified event', async () => {
    const { client } = makeClient((call) =>
      isToken(call) ? tokenResponse() : verifyWebhookResponse('SUCCESS'),
    )
    const result = await client.verifyWebhookSignature(headers, WEBHOOK_ID, event)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe('SUCCESS')
  })

  it('FAILURE for a forged event', async () => {
    const { client } = makeClient((call) =>
      isToken(call) ? tokenResponse() : verifyWebhookResponse('FAILURE'),
    )
    const result = await client.verifyWebhookSignature(headers, WEBHOOK_ID, event)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe('FAILURE')
  })

  it('fails closed on a status we have never seen', async () => {
    // A permissive default for an unknown value would make this a no-op rather than a check.
    const { client } = makeClient((call) =>
      isToken(call) ? tokenResponse() : verifyWebhookResponse('SOMETHING_NEW'),
    )
    const result = await client.verifyWebhookSignature(headers, WEBHOOK_ID, event)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe('FAILURE')
  })

  it('sends the transmission headers under their documented field names', async () => {
    const { client, fetchImpl } = makeClient((call) =>
      isToken(call) ? tokenResponse() : verifyWebhookResponse('SUCCESS'),
    )
    await client.verifyWebhookSignature(headers, WEBHOOK_ID, event)
    const body = jsonBody<Record<string, unknown>>(callTo(fetchImpl.calls, 'verify-webhook-signature'))
    expect(body['auth_algo']).toBe('SHA256withRSA')
    expect(body['cert_url']).toBe(headers['paypal-cert-url'])
    expect(body['transmission_id']).toBe(headers['paypal-transmission-id'])
    expect(body['transmission_sig']).toBe(headers['paypal-transmission-sig'])
    expect(body['transmission_time']).toBe(headers['paypal-transmission-time'])
    expect(body['webhook_id']).toBe(WEBHOOK_ID)
    expect(body['webhook_event']).toEqual(event)
  })

  it('accepts the raw request body as a string, since the route reads it raw (§8.12)', async () => {
    const { client, fetchImpl } = makeClient((call) =>
      isToken(call) ? tokenResponse() : verifyWebhookResponse('SUCCESS'),
    )
    const result = await client.verifyWebhookSignature(headers, WEBHOOK_ID, JSON.stringify(event))
    expect(result.ok).toBe(true)
    const body = jsonBody<Record<string, unknown>>(callTo(fetchImpl.calls, 'verify-webhook-signature'))
    expect(body['webhook_event']).toEqual(event)
  })

  it('refuses a body that is not JSON rather than sending garbage', async () => {
    const { client, fetchImpl } = makeClient(tokenResponse())
    const result = await client.verifyWebhookSignature(headers, WEBHOOK_ID, '{not json')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_VALIDATION')
    expect(fetchImpl.calls).toHaveLength(0)
  })

  it('refuses a missing webhook id', async () => {
    const { client } = makeClient(tokenResponse())
    const result = await client.verifyWebhookSignature(headers, '', event)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_VALIDATION')
  })
})