/**
 * Orders v2 — spec §10.2 #5–8, D17, D18, EC-STOCK-1, EC-SPLIT-1/2.
 *
 * The field names asserted here (`purchase_units[].custom_id`, `invoice_id`, `amount.value`,
 * `capture_id`, `tracking_number`) are the ones D18 and §12.7 depend on.
 */
import { describe, expect, it } from 'vitest'

import { createLogger } from '@countersign/core'

import { PayPalClient } from '../src/client'
import type { CallOpts } from '../src/client'
import { ppResponseAmountToMoney } from '../src/types'
import {
  capturingLogger,
  createOrderTestDouble,
  fakeFetch,
  headerOf,
  jsonBody,
  orderResponse,
  paypalErrorResponse,
  recordingSleep,
  testClock,
  tokenResponse,
} from './fixtures/transport-double'
import type { RecordedCall, Stub } from './fixtures/transport-double'

const BASE_URL = 'https://api-m.sandbox.paypal.com'
const REQUEST_ID = 'cs:att_01JC0Z9P7YQ8V2N3M4K5K6R7ST8:create'
const CALL_OPTS: CallOpts & { requestId: string } = { requestId: REQUEST_ID }
const ORDER_ID = '5O190127TN364715T'
const EVIDENCE_HASH = `cs1:${'B'.repeat(43)}`

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

describe('createOrder (§10.2 #5, D18)', () => {
  it('POSTs the intent, purchase units and vault payment source', async () => {
    const { client, fetchImpl } = makeClient((call) =>
      isToken(call) ? tokenResponse() : orderResponse({ customId: EVIDENCE_HASH }),
    )

    const body = createOrderTestDouble({ intent: 'CAPTURE', customId: EVIDENCE_HASH, value: '129.99' })
    const result = await client.createOrder(body, CALL_OPTS)
    expect(result.ok).toBe(true)

    const call = fetchImpl.calls.find((c) => c.url.endsWith('/v2/checkout/orders')) as RecordedCall
    expect(call.method).toBe('POST')
    expect(headerOf(call, 'content-type')).toBe('application/json')
    expect(headerOf(call, 'paypal-request-id')).toBe(REQUEST_ID)
    expect(headerOf(call, 'authorization')).toMatch(/^Bearer /)

    const sent = jsonBody<typeof body>(call)
    expect(sent.intent).toBe('CAPTURE')
    // D18: the signed chain's hash and our order id live inside PayPal's own records.
    expect(sent.purchase_units[0]?.custom_id).toBe(EVIDENCE_HASH)
    expect(sent.purchase_units[0]?.invoice_id).toBe('ord_01JC0Z9P7YQ8V2N3M4K5K6R7ST8')
    // Money as a decimal string, never a float (§0).
    expect(sent.purchase_units[0]?.amount.value).toBe('129.99')
    expect(typeof sent.purchase_units[0]?.amount.value).toBe('string')
    expect(sent.payment_source.paypal?.vault_id).toBe('5TY05013RG002845M')
  })

  it('returns the parsed order with its status and purchase units', async () => {
    const { client } = makeClient((call) =>
      isToken(call) ? tokenResponse() : orderResponse({ status: 'CREATED', customId: EVIDENCE_HASH }),
    )
    const result = await client.createOrder(createOrderTestDouble({ customId: EVIDENCE_HASH }), CALL_OPTS)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.id).toBe(ORDER_ID)
    expect(result.value.status).toBe('CREATED')
    expect(result.value.intent).toBe('CAPTURE')
    expect(result.value.purchase_units?.[0]?.custom_id).toBe(EVIDENCE_HASH)
    expect(result.value.purchase_units?.[0]?.amount?.value).toBe('48.00')
  })

  it('converts a returned amount into integer minor units without a float', async () => {
    // EC-FX-5: a boundary that accepts a float is how a cent disappears.
    const money = ppResponseAmountToMoney({ currency_code: 'USD', value: '129.99' })
    expect(money.ok).toBe(true)
    if (!money.ok) return
    expect(money.value.minor).toBe(12999n)
    expect(typeof money.value.minor).toBe('bigint')
  })

  it('refuses a JPY amount with cents rather than rounding it', () => {
    const money = ppResponseAmountToMoney({ currency_code: 'JPY', value: '500.00' })
    expect(money.ok).toBe(false)
    if (money.ok) return
    expect(money.error.code).toBe('CS_ROUNDING')
  })

  it('refuses a currency we cannot represent, without crashing', () => {
    // `currency()` in core rejects a code outside the supported list, so the code here is the one the
    // registry already owns rather than a translation invented in this package.
    const money = ppResponseAmountToMoney({ currency_code: 'SEK', value: '48.00' })
    expect(money.ok).toBe(false)
    if (money.ok) return
    expect(money.error.code).toBe('CS_VALIDATION')
    expect(money.error.details?.['supported']).toBeDefined()
  })

  it('UNPROCESSABLE_ENTITY → PP_UNPROCESSABLE, keeping the issue', async () => {
    const { client } = makeClient((call) =>
      isToken(call)
        ? tokenResponse()
        : paypalErrorResponse('UNPROCESSABLE_ENTITY', 'INVALID_PARAMETER_VALUE', 422),
    )
    const result = await client.createOrder(createOrderTestDouble(), CALL_OPTS)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('PP_UNPROCESSABLE')
    expect(result.error.details?.['issue']).toBe('INVALID_PARAMETER_VALUE')
    expect(result.error.retryable).toBe(false)
  })

  it('refuses a body PayPal would reject anyway, before spending a request id', async () => {
    const { client, fetchImpl } = makeClient(tokenResponse())
    const result = await client.createOrder(
      // @ts-expect-error an intent outside the enum and no purchase units: refused at the boundary.
      { intent: 'SOMETHING_ELSE', purchase_units: [] },
      CALL_OPTS,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_VALIDATION')
    // Nothing was sent: not even the token request.
    expect(fetchImpl.calls).toHaveLength(0)
  })

  it('refuses a float amount in a request body (spec §0 / EC-FX-5)', async () => {
    const { client, fetchImpl } = makeClient(tokenResponse())
    const result = await client.createOrder(
      {
        intent: 'CAPTURE',
        // @ts-expect-error a number here is the bug the boundary exists to catch.
        purchase_units: [{ amount: { currency_code: 'USD', value: 48.5 } }],
      },
      CALL_OPTS,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_VALIDATION')
    expect(fetchImpl.calls).toHaveLength(0)
  })

  it('a 2xx body missing `id` is CS_INTERNAL, not a validation error the caller can fix', async () => {
    const { client } = makeClient((call) => (isToken(call) ? tokenResponse() : { status: 201, body: { status: 'CREATED' } }))
    const result = await client.createOrder(createOrderTestDouble(), CALL_OPTS)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_INTERNAL')
    expect(result.error.details?.['body_keys']).toContain('status')
  })

  it('tolerates unknown fields PayPal adds later', async () => {
    const { client } = makeClient((call) => {
      if (isToken(call)) return tokenResponse()
      const spec = orderResponse()
      return { ...spec, body: { ...(spec.body as object), some_2027_field: { nested: true } } }
    })
    const result = await client.createOrder(createOrderTestDouble(), CALL_OPTS)
    expect(result.ok).toBe(true)
  })
})

describe('getOrder', () => {
  it('GETs the order and sends no request id', async () => {
    const { client, fetchImpl } = makeClient((call) => (isToken(call) ? tokenResponse() : orderResponse()))
    const result = await client.getOrder(ORDER_ID)
    expect(result.ok).toBe(true)
    const call = fetchImpl.calls.find((c) => c.url.includes(`/orders/${ORDER_ID}`)) as RecordedCall
    expect(call.method).toBe('GET')
    expect(call.body).toBeUndefined()
    expect(headerOf(call, 'paypal-request-id')).toBeUndefined()
  })

  it('404 → PP_NOT_FOUND', async () => {
    const { client } = makeClient((call) =>
      isToken(call) ? tokenResponse() : { status: 404, body: { name: 'RESOURCE_NOT_FOUND' } },
    )
    const result = await client.getOrder(ORDER_ID)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('PP_NOT_FOUND')
  })

  it('refuses an empty id without calling PayPal', async () => {
    const { client, fetchImpl } = makeClient(tokenResponse())
    const result = await client.getOrder('')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_VALIDATION')
    expect(fetchImpl.calls).toHaveLength(0)
  })

  it('url-encodes the id so a path segment cannot be injected', async () => {
    const { client, fetchImpl } = makeClient((call) => (isToken(call) ? tokenResponse() : orderResponse()))
    await client.getOrder('a/../b?x=1')
    const call = fetchImpl.calls.find((c) => c.url.includes('/orders/')) as RecordedCall
    expect(call.url).toContain('a%2F..%2Fb%3Fx%3D1')
  })
})

describe('authorizeOrder / captureOrder (§10.2 #6)', () => {
  it('POSTs /authorize with the request id and no body', async () => {
    const { client, fetchImpl } = makeClient((call) =>
      isToken(call) ? tokenResponse() : orderResponse({ status: 'COMPLETED', intent: 'AUTHORIZE' }),
    )
    const result = await client.authorizeOrder(ORDER_ID, CALL_OPTS)
    expect(result.ok).toBe(true)
    const call = fetchImpl.calls.find((c) => c.url.includes('/authorize')) as RecordedCall
    expect(call.method).toBe('POST')
    expect(headerOf(call, 'paypal-request-id')).toBe(REQUEST_ID)
  })

  it('POSTs /capture with the request id', async () => {
    const { client, fetchImpl } = makeClient((call) =>
      isToken(call) ? tokenResponse() : orderResponse({ status: 'COMPLETED' }),
    )
    const result = await client.captureOrder(ORDER_ID, CALL_OPTS)
    expect(result.ok).toBe(true)
    const call = fetchImpl.calls.find((c) => c.url.includes('/capture')) as RecordedCall
    expect(call.url).toContain(`/v2/checkout/orders/${ORDER_ID}/capture`)
    expect(headerOf(call, 'paypal-request-id')).toBe(REQUEST_ID)
  })

  it('PAYER_ACTION_REQUIRED maps to the code the Gate branches on', async () => {
    const { client } = makeClient((call) =>
      isToken(call)
        ? tokenResponse()
        : paypalErrorResponse('UNPROCESSABLE_ENTITY', 'PAYER_ACTION_REQUIRED', 422),
    )
    const result = await client.authorizeOrder(ORDER_ID, CALL_OPTS)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('PP_PAYER_ACTION_REQUIRED')
    expect(result.error.userMessage).toMatch(/approve/i)
  })

  it('requires a request id on both', async () => {
    const { client, fetchImpl } = makeClient(tokenResponse())
    const a = await client.authorizeOrder(ORDER_ID, {} as CallOpts & { requestId: string })
    const b = await client.captureOrder(ORDER_ID, {} as CallOpts & { requestId: string })
    expect(a.ok).toBe(false)
    expect(b.ok).toBe(false)
    expect(fetchImpl.calls).toHaveLength(0)
  })
})

describe('addTracking (§10.2 #8, EC-SPLIT-1/2)', () => {
  it('sends capture_id, tracking_number and carrier', async () => {
    const { client, fetchImpl } = makeClient((call) =>
      isToken(call) ? tokenResponse() : orderResponse({ status: 'COMPLETED' }),
    )
    const result = await client.addTracking(
      ORDER_ID,
      { capture_id: '3C679366HH908993F', tracking_number: '1Z999AA10123456784', carrier: 'UPS' },
      CALL_OPTS,
    )
    expect(result.ok).toBe(true)

    const call = fetchImpl.calls.find((c) => c.url.includes('/track')) as RecordedCall
    expect(jsonBody<Record<string, unknown>>(call)).toEqual({
      capture_id: '3C679366HH908993F',
      tracking_number: '1Z999AA10123456784',
      carrier: 'UPS',
    })
  })

  it('supports tracking twice against the same capture (EC-SPLIT-2)', async () => {
    const { client, fetchImpl } = makeClient((call) =>
      isToken(call) ? tokenResponse() : orderResponse({ status: 'COMPLETED' }),
    )
    const track = { capture_id: '3C679366HH908993F', tracking_number: '1Z999AA10123456784' }
    await client.addTracking(ORDER_ID, track, CALL_OPTS)
    await client.addTracking(ORDER_ID, { ...track, tracking_number: '1Z999AA10123456785' }, {
      requestId: 'cs:att_01JC0Z9P7YQ8V2N3M4K5K6R7ST9:create',
    })
    expect(fetchImpl.calls.filter((c) => c.url.includes('/track'))).toHaveLength(2)
  })

  it('refuses tracking without a capture id', async () => {
    const { client, fetchImpl } = makeClient(tokenResponse())
    const result = await client.addTracking(
      ORDER_ID,
      // @ts-expect-error capture_id is required: tracking must point at the capture it proves.
      { tracking_number: 'x' },
      CALL_OPTS,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_VALIDATION')
    expect(fetchImpl.calls).toHaveLength(0)
  })
})