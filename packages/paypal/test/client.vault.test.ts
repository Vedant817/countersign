/**
 * Vault v3 — spec §10.2 #3, #4, #17; §8.7; [V9] [V10].
 *
 * The wallet flow is where a mistake is most expensive to find late: a bad setup-token body fails in
 * the buyer's popup, not in our logs. So these tests pin the request bodies as well as the ids.
 */
import { describe, expect, it } from 'vitest'

import { createLogger } from '@countersign/core'

import { PayPalClient } from '../src/client'
import { paymentTokenPayer, paymentTokenPayerId, paymentTokenSchema } from '../src/types'
import { VAULT_CUSTOMER_TYPES, VAULT_USAGE_PATTERNS, VAULT_USAGE_TYPES } from '../src/types'
import {
  capturingLogger,
  fakeFetch,
  headerOf,
  jsonBody,
  paypalErrorResponse,
  paymentTokenResponse,
  recordingSleep,
  serviceUnavailableResponse,
  setupTokenResponse,
  testClock,
  tokenResponse,
} from './fixtures/transport-double'
import type { RecordedCall, Stub } from './fixtures/transport-double'

const BASE_URL = 'https://api-m.sandbox.paypal.com'
const SETUP_TOKEN_ID = '8CM364183LM392832'
const PAYMENT_TOKEN_ID = '5TY05013RG002845M'

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

describe('createSetupToken (§8.7 step 3, [V9])', () => {
  it('POSTs to /v3/vault/setup-tokens and returns the id the popup confirms', async () => {
    const { client, fetchImpl } = makeClient((call) =>
      isToken(call) ? tokenResponse() : setupTokenResponse({ id: SETUP_TOKEN_ID }),
    )
    const result = await client.createSetupToken({
      // U6: copy these verbatim from the doc at build time. The shape is asserted here so a change is
      // a deliberate diff rather than a silent one.
      //
      // They live under `payment_source.paypal` (report §21/#15): `SPEC-V.setup_token_request` has
      // exactly two top-level properties, `customer` and `payment_source`, so a top-level
      // `usage_type` / `experience_context` would have been dropped or rejected. `IMMEDIATE` is the
      // real `usage_pattern` for a one-shot merchant-initiated charge (spec D17).
      payment_source: {
        paypal: {
          usage_type: 'MERCHANT',
          usage_pattern: 'IMMEDIATE',
          customer_type: 'CONSUMER',
          experience_context: {
            return_url: 'https://countersign.onrender.com/wallet/onboarding?step=confirm',
            cancel_url: 'https://countersign.onrender.com/wallet/onboarding?step=cancelled',
          },
        },
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.id).toBe(SETUP_TOKEN_ID)

    const call = callTo(fetchImpl.calls, '/v3/vault/setup-tokens')
    expect(call.method).toBe('POST')
    expect(headerOf(call, 'content-type')).toBe('application/json')
    const sent = jsonBody<Record<string, unknown>>(call)
    // Every key except `customer` sits under `payment_source.paypal`.
    expect(Object.keys(sent).sort()).toEqual(['payment_source'])
    expect(sent['payment_source']).toEqual({
      paypal: {
        usage_type: 'MERCHANT',
        usage_pattern: 'IMMEDIATE',
        customer_type: 'CONSUMER',
        experience_context: {
          return_url: 'https://countersign.onrender.com/wallet/onboarding?step=confirm',
          cancel_url: 'https://countersign.onrender.com/wallet/onboarding?step=cancelled',
        },
      },
    })
  })

  it('documents the three vault enums, and accepts a value outside them at runtime', async () => {
    // The wire schema is deliberately `z.string()` for every enum in this package: a zod enum would
    // break onboarding the day PayPal adds a `usage_type`. The documented values are exported so the
    // compiler suggests them and a test can assert the list has not drifted (report §21/#15).
    expect([...VAULT_USAGE_TYPES].sort()).toEqual(['MERCHANT', 'PLATFORM'])
    expect([...VAULT_CUSTOMER_TYPES].sort()).toEqual(['BUSINESS', 'CONSUMER'])
    expect(VAULT_USAGE_PATTERNS).toContain('IMMEDIATE')
    expect(VAULT_USAGE_PATTERNS).toHaveLength(12)

    const { client, fetchImpl } = makeClient((call) => (isToken(call) ? tokenResponse() : setupTokenResponse()))
    const result = await client.createSetupToken({
      payment_source: { paypal: { usage_type: 'MERCHANT', usage_pattern: 'IMMEDIATE' } },
    })
    expect(result.ok).toBe(true)
    expect(fetchImpl.calls.filter((c) => c.url.includes('setup-tokens'))).toHaveLength(1)
  })

  it('refuses a `payment_source.paypal` that is not an object', async () => {
    const { client, fetchImpl } = makeClient(tokenResponse())
    const result = await client.createSetupToken({
      // @ts-expect-error payment_source.paypal is an object; a string must be refused at the boundary.
      payment_source: { paypal: 'not-an-object' },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_VALIDATION')
    expect(fetchImpl.calls).toHaveLength(0)
  })

  it('exposes the approve link the browser JS SDK needs', async () => {
    const { client } = makeClient((call) => (isToken(call) ? tokenResponse() : setupTokenResponse()))
    const result = await client.createSetupToken({})
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.links?.some((l) => l.rel === 'approve')).toBe(true)
  })

  it('an invalid setup-token body fails locally, not in the buyer popup', async () => {
    const { client, fetchImpl } = makeClient(tokenResponse())
    const result = await client.createSetupToken({
      // @ts-expect-error payment_source.paypal is an object; a string must be refused at the boundary.
      payment_source: { paypal: 'not-an-object' },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_VALIDATION')
    expect(fetchImpl.calls).toHaveLength(0)
  })

  it('EC-IDEM-3: an ambiguous failure is not blind-retried here — idempotency is unverified (U5)', async () => {
    const { client, fetchImpl } = makeClient((call) =>
      isToken(call) ? tokenResponse() : serviceUnavailableResponse(),
    )
    const result = await client.createSetupToken({})
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('PP_UNAVAILABLE')
    expect(result.error.details?.['ambiguous']).toBe(true)
    expect(fetchImpl.calls.filter((c) => c.url.includes('setup-tokens'))).toHaveLength(1)
  })
})

describe('createPaymentToken (§8.7 step 4, [V9])', () => {
  it('POSTs payment_source.token with the SETUP_TOKEN type and returns the vault id', async () => {
    const { client, fetchImpl } = makeClient((call) =>
      isToken(call) ? tokenResponse() : paymentTokenResponse({ id: PAYMENT_TOKEN_ID }),
    )
    const result = await client.createPaymentToken(SETUP_TOKEN_ID)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const call = callTo(fetchImpl.calls, '/v3/vault/payment-tokens')
    expect(jsonBody<Record<string, unknown>>(call)).toEqual({
      payment_source: { token: { id: SETUP_TOKEN_ID, type: 'SETUP_TOKEN' } },
    })
    // The vault id is what `payment_source.paypal.vault_id` refers to on an order (§10.2 #5).
    expect(result.value.id).toBe(PAYMENT_TOKEN_ID)
    expect(result.value.status).toBe('ACTIVE')
  })

  it('exposes the customer and payer fields §8.7 step 5 stores', async () => {
    const { client } = makeClient((call) =>
      isToken(call) ? tokenResponse() : paymentTokenResponse({ email: 'buyer-4879@example.com' }),
    )
    const result = await client.createPaymentToken(SETUP_TOKEN_ID)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.customer?.id).toBeDefined()
    // The payer lives under `payment_source.paypal`; `payment_token_response` has **no** top-level
    // `payer` (report §16/#16), so reading one would always return undefined.
    expect(result.value['payer']).toBeUndefined()
    expect(paymentTokenPayer(result.value)?.email_address).toBe('buyer-4879@example.com')
    expect(paymentTokenPayerId(result.value)).toBe('PAYER9DX42987Y')
  })

  it('falls back to `account_id` for the payer id, because PayPal publishes only that', async () => {
    // Report §22: `payer_id` is schema-declared but absent from every published example; the
    // documented `customer_vault_payment_tokens_response` carries `account_id` only. A `payer_id`-only
    // read would find nothing in production.
    const { client } = makeClient((call) =>
      isToken(call) ? tokenResponse() : paymentTokenResponse({ payerId: false, accountId: 'VYYFH3WJ4JPJQ' }),
    )
    const result = await client.createPaymentToken(SETUP_TOKEN_ID)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.payment_source?.paypal?.['payer_id']).toBeUndefined()
    expect(paymentTokenPayerId(result.value)).toBe('VYYFH3WJ4JPJQ')
  })

  it('reports no payer id when PayPal sent neither', () => {
    const parsed = paymentTokenSchema.safeParse({ id: PAYMENT_TOKEN_ID })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(paymentTokenPayerId(parsed.data)).toBeUndefined()
    expect(paymentTokenPayer(parsed.data)).toBeUndefined()
  })

  it('refuses an empty setup token id', async () => {
    const { client, fetchImpl } = makeClient(tokenResponse())
    const result = await client.createPaymentToken('  ')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_VALIDATION')
    expect(fetchImpl.calls).toHaveLength(0)
  })

  it('maps a PayPal error on token creation without leaking the body', async () => {
    const { client } = makeClient((call) =>
      isToken(call) ? tokenResponse() : paypalErrorResponse('INVALID_REQUEST', 'INVALID_PARAMETER_VALUE', 400),
    )
    const result = await client.createPaymentToken(SETUP_TOKEN_ID)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('PP_UNPROCESSABLE')
    expect(result.error.userMessage).not.toContain(SETUP_TOKEN_ID)
  })
})

describe('getPaymentToken', () => {
  it('GETs the token', async () => {
    const { client, fetchImpl } = makeClient((call) =>
      isToken(call) ? tokenResponse() : paymentTokenResponse({ id: PAYMENT_TOKEN_ID }),
    )
    const result = await client.getPaymentToken(PAYMENT_TOKEN_ID)
    expect(result.ok).toBe(true)
    expect(callTo(fetchImpl.calls, `/v3/vault/payment-tokens/${PAYMENT_TOKEN_ID}`).method).toBe('GET')
  })

  it('EC-MDT-6: a deleted token comes back PP_NOT_FOUND so the wallet can be marked DELETED', async () => {
    const { client } = makeClient((call) =>
      isToken(call) ? tokenResponse() : { status: 404, body: { name: 'RESOURCE_NOT_FOUND' } },
    )
    const result = await client.getPaymentToken(PAYMENT_TOKEN_ID)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('PP_NOT_FOUND')
  })
})

describe('deletePaymentToken (§10.2 #17, revoke wallet)', () => {
  it('DELETEs and accepts a 204', async () => {
    const { client, fetchImpl } = makeClient((call) => (isToken(call) ? tokenResponse() : { status: 204 }))
    const result = await client.deletePaymentToken(PAYMENT_TOKEN_ID)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBeUndefined()

    const call = callTo(fetchImpl.calls, `/v3/vault/payment-tokens/${PAYMENT_TOKEN_ID}`)
    expect(call.method).toBe('DELETE')
    expect(call.body).toBeUndefined()
  })

  it('sends no request id, because DELETE takes none', async () => {
    const { client, fetchImpl } = makeClient((call) => (isToken(call) ? tokenResponse() : { status: 204 }))
    await client.deletePaymentToken(PAYMENT_TOKEN_ID)
    expect(headerOf(callTo(fetchImpl.calls, `/v3/vault/payment-tokens/${PAYMENT_TOKEN_ID}`), 'paypal-request-id')).toBeUndefined()
  })

  it('is safe to repeat: a second delete is a 404, never a second deletion', async () => {
    let deletes = 0
    const { client } = makeClient((call) => {
      if (isToken(call)) return tokenResponse()
      deletes += 1
      return deletes === 1 ? { status: 204 } : { status: 404, body: { name: 'RESOURCE_NOT_FOUND' } }
    })
    expect((await client.deletePaymentToken(PAYMENT_TOKEN_ID)).ok).toBe(true)
    const second = await client.deletePaymentToken(PAYMENT_TOKEN_ID)
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error.code).toBe('PP_NOT_FOUND')
    expect(deletes).toBe(2)
  })
})