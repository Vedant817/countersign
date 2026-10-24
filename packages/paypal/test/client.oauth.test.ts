/**
 * OAuth, single-flight, the 401 refresh, debug-id logging and the EC-ENV-1 boot guard —
 * spec §8.6 "auth", §10.2 #1/#2, AT-M6.4, AT-M6.7, EC-PP-3.
 *
 * Nothing here touches the network. The `fetch` double is a transport substitute only; see
 * `fixtures/README.md`.
 */
import { describe, expect, it } from 'vitest'

import { createLogger } from '@countersign/core'

import { ENDPOINT_POLICIES, PayPalClient } from '../src/client'
import type { CallOpts } from '../src/client'
import {
  capturingLogger,
  fakeFetch,
  headerOf,
  jsonBody,
  oauthErrorResponse,
  orderResponse,
  rateLimitedResponse,
  recordingSleep,
  testClock,
  tokenResponse,
  unauthorizedResponse,
} from './fixtures/transport-double'
import type { RecordedCall, Stub } from './fixtures/transport-double'

const BASE_URL = 'https://api-m.sandbox.paypal.com'
const CLIENT_ID = 'AY_FAKE_SANDBOX_CLIENT_ID_00000000'
const CLIENT_SECRET = 'EL_FAKE_SANDBOX_SECRET_00000000'

interface ClientHarness {
  readonly client: PayPalClient
  readonly fetchImpl: ReturnType<typeof fakeFetch>
  readonly clock: ReturnType<typeof testClock>
  readonly log: ReturnType<typeof capturingLogger>
  /** Every delay the client asked for. Zero real milliseconds ever pass in this file. */
  readonly sleeps: readonly number[]
}

/**
 * A client wired to a transport double, a pinned clock, a recording sleep and a capturing logger.
 *
 * The sleep is always injected: a test that really waited out a backoff would be slow and, worse,
 * would still not be asserting the *duration* — only that eventually something happened.
 */
function makeClient(
  responder: Stub,
  overrides: {
    maxRetries?: number
    env?: { PAYPAL_ENV?: string | undefined; PAYPAL_API_BASE?: string | undefined }
    clock?: ReturnType<typeof testClock>
  } = {},
): ClientHarness {
  const clock = overrides.clock ?? testClock()
  const log = capturingLogger()
  const recorder = recordingSleep(clock)
  const fetchImpl = fakeFetch(responder)
  const client = new PayPalClient({
    baseUrl: BASE_URL,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    clock,
    fetchImpl,
    sleep: recorder.sleep,
    logger: createLogger({ level: log.level, sink: log.sink, secrets: [CLIENT_SECRET] }),
    env: overrides.env ?? { PAYPAL_ENV: 'sandbox', PAYPAL_API_BASE: BASE_URL },
    ...(overrides.maxRetries !== undefined ? { maxRetries: overrides.maxRetries } : {}),
  })
  return { client, fetchImpl, clock, log, sleeps: recorder.delays }
}

/** A client built directly, for the cases the harness cannot express (deferred responders). */
function makeRawClient(
  fetchImpl: ReturnType<typeof fakeFetch>,
  overrides: { clock?: ReturnType<typeof testClock> } = {},
) {
  return new PayPalClient({
    baseUrl: BASE_URL,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    clock: overrides.clock ?? testClock(),
    fetchImpl,
    sleep: async () => undefined,
    env: { PAYPAL_ENV: 'sandbox', PAYPAL_API_BASE: BASE_URL },
  })
}

const tokenCalls = (calls: readonly RecordedCall[]) =>
  calls.filter((c) => c.url.endsWith('/v1/oauth2/token'))
const orderCalls = (calls: readonly RecordedCall[]) =>
  calls.filter((c) => c.url.includes('/v2/checkout/orders'))

describe('PayPalClient construction', () => {
  it('requires the base url, credentials and a clock', () => {
    expect(
      () =>
        new PayPalClient({
          baseUrl: '',
          clientId: 'x',
          clientSecret: 'y',
          clock: testClock(),
          env: { PAYPAL_ENV: 'sandbox', PAYPAL_API_BASE: BASE_URL },
        }),
    ).toThrow()
  })

  it('rejects a baseUrl that will not parse', () => {
    expect(
      () =>
        new PayPalClient({
          baseUrl: 'not-a-url',
          clientId: 'x',
          clientSecret: 'y',
          clock: testClock(),
          env: { PAYPAL_ENV: 'sandbox', PAYPAL_API_BASE: BASE_URL },
        }),
    ).toThrow(/baseUrl/)
  })

  it('AT-M6.7 / EC-ENV-1: PAYPAL_ENV=live is a boot failure', () => {
    expect(
      () =>
        new PayPalClient({
          baseUrl: BASE_URL,
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          clock: testClock(),
          fetchImpl: fakeFetch(tokenResponse()),
          env: { PAYPAL_ENV: 'live', PAYPAL_API_BASE: BASE_URL },
        }),
    ).toThrow(/EC-ENV-1/)
  })

  it('EC-ENV-1: a live API host is refused even when PAYPAL_ENV is unset', () => {
    // The host is what actually decides whose money we touch, so it is checked unconditionally.
    expect(
      () =>
        new PayPalClient({
          baseUrl: 'https://api-m.paypal.com',
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          clock: testClock(),
          fetchImpl: fakeFetch(tokenResponse()),
          env: {},
        }),
    ).toThrow(/EC-ENV-1/)
  })

  it('accepts a sandbox host and a localhost mock', () => {
    expect(
      () =>
        new PayPalClient({
          baseUrl: 'https://api-m.sandbox.paypal.com',
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          clock: testClock(),
          fetchImpl: fakeFetch(tokenResponse()),
          env: { PAYPAL_ENV: 'sandbox' },
        }),
    ).not.toThrow()
    expect(
      () =>
        new PayPalClient({
          baseUrl: 'http://127.0.0.1:8787',
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          clock: testClock(),
          fetchImpl: fakeFetch(tokenResponse()),
          env: { PAYPAL_ENV: 'sandbox' },
        }),
    ).not.toThrow()
  })

  it('throws before it can take money, rather than on the first call', () => {
    // A client that boots and only then discovers it is pointed at live would already be a problem.
    expect(
      () =>
        new PayPalClient({
          baseUrl: 'https://api-m.paypal.com',
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          clock: testClock(),
          env: {},
        }),
    ).toThrow()
  })
})

describe('getAccessToken (§10.2 #1)', () => {
  it('posts client_credentials as form-encoded with Basic auth', async () => {
    const { client, fetchImpl } = makeClient([tokenResponse()])
    await client.getAccessToken()

    const call = tokenCalls(fetchImpl.calls)[0] as RecordedCall
    expect(call.method).toBe('POST')
    expect(call.body).toBe('grant_type=client_credentials')
    expect(headerOf(call, 'content-type')).toBe('application/x-www-form-urlencoded')

    const auth = headerOf(call, 'authorization') ?? ''
    expect(auth).toMatch(/^Basic /)
    // Basic auth is base64(clientId:clientSecret); decoding must give the credentials back.
    expect(Buffer.from(auth.slice(6), 'base64').toString('utf8')).toBe(
      `${CLIENT_ID}:${CLIENT_SECRET}`,
    )
  })

  it('sends no PayPal-Request-Id on the token call', async () => {
    const { client, fetchImpl } = makeClient([tokenResponse()])
    await client.getAccessToken()
    expect(
      headerOf(tokenCalls(fetchImpl.calls)[0] as RecordedCall, 'paypal-request-id'),
    ).toBeUndefined()
  })

  it('caches the token and reuses it until expires_in minus 60 s', async () => {
    const clock = testClock()
    const { client, fetchImpl } = makeClient([tokenResponse({ expiresIn: 3_600 })], { clock })

    expect(await client.getAccessToken()).toBe('A21AAFakeAccessToken0000000000000000')
    // 3600 s lifetime, 60 s of skew → still cached at +3539 s.
    clock.advance(3_539)
    expect(await client.getAccessToken()).toBe('A21AAFakeAccessToken0000000000000000')
    expect(tokenCalls(fetchImpl.calls)).toHaveLength(1)

    // One second later the cached token is past `expires_in - 60`, so it is refreshed.
    clock.advance(1)
    await client.getAccessToken()
    expect(tokenCalls(fetchImpl.calls)).toHaveLength(2)
  })

  it('AT-M6.4: 50 concurrent calls produce exactly 1 token request', async () => {
    const { client, fetchImpl } = makeClient([tokenResponse()])

    const tokens = await Promise.all(Array.from({ length: 50 }, () => client.getAccessToken()))

    expect(tokenCalls(fetchImpl.calls)).toHaveLength(1)
    expect(new Set(tokens).size).toBe(1)
    expect(tokens[0]).toBe('A21AAFakeAccessToken0000000000000000')
  })

  it('AT-M6.4: the in-flight promise is shared, not queued — 50 callers, 1 socket, no serialisation', async () => {
    // A mutex would make caller N wait for N-1; a shared promise makes them all wait for the same
    // fetch. The gate below stays shut until every caller has been registered, which only resolves
    // if they are all waiting on one in-flight request.
    let openGate: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      openGate = resolve
    })
    const fetchImpl = fakeFetch(async (call) => {
      await gate
      return call.url.endsWith('/v1/oauth2/token') ? tokenResponse() : orderResponse()
    })
    const client = makeRawClient(fetchImpl)

    let settled = 0
    const inflight = Array.from({ length: 50 }, () =>
      client.getAccessToken().then((t) => {
        settled += 1
        return t
      }),
    )

    // All 50 are parked on the same request; opening the gate settles them together.
    expect(tokenCalls(fetchImpl.calls)).toHaveLength(1)
    expect(settled).toBe(0)
    openGate?.()

    const tokens = await Promise.all(inflight)
    expect(settled).toBe(50)
    expect(new Set(tokens).size).toBe(1)
    expect(tokenCalls(fetchImpl.calls)).toHaveLength(1)
  })

  it('clears the in-flight slot after a failure so the next call can try again', async () => {
    // A stuck in-flight promise would turn one blip into a permanent outage for every caller.
    const { client, fetchImpl } = makeClient([
      oauthErrorResponse('invalid_client', 'nope'),
      tokenResponse(),
    ])

    await expect(client.getAccessToken()).rejects.toThrow()
    expect(tokenCalls(fetchImpl.calls)).toHaveLength(1)
    expect(await client.getAccessToken()).toBe('A21AAFakeAccessToken0000000000000000')
    expect(tokenCalls(fetchImpl.calls)).toHaveLength(2)
  })

  it('throws a CsError on failure, because the spec types this one as Promise<string>', async () => {
    const { client } = makeClient([
      oauthErrorResponse('invalid_client', 'Client Authentication failed'),
    ])
    await expect(client.getAccessToken()).rejects.toMatchObject({ code: 'PP_AUTH' })
  })

  it('surfaces an unavailable token endpoint as PP_UNAVAILABLE, and still backs off', async () => {
    const { client, sleeps } = makeClient(() => ({ status: 503, text: '<html>503</html>' }))
    await expect(client.getAccessToken()).rejects.toMatchObject({
      code: 'PP_UNAVAILABLE',
      retryable: true,
    })
    // Four attempts means three backoffs.
    expect(sleeps).toHaveLength(3)
  })

  it('a failed token fetch becomes a Result error on a normal call, not a throw', async () => {
    const { client } = makeClient([oauthErrorResponse('invalid_client', 'bad creds')])
    const result = await client.getOrder('5O190127TN364715T')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('PP_AUTH')
  })
})

describe('getClientToken (§10.2 #2, [V9])', () => {
  it('sends response_type=client_token and Basic auth, never a bearer token', async () => {
    const { client, fetchImpl } = makeClient([tokenResponse({ token: 'CLIENT-TOKEN-FOR-BROWSER' })])
    expect(await client.getClientToken()).toBe('CLIENT-TOKEN-FOR-BROWSER')

    const call = tokenCalls(fetchImpl.calls)[0] as RecordedCall
    expect(call.body).toContain('response_type=client_token')
    expect(call.body).toContain('grant_type=client_credentials')
    expect(headerOf(call, 'authorization')).toMatch(/^Basic /)
  })

  it('is not cached: a client token is single-use and the popup must get a fresh one', async () => {
    const { client, fetchImpl } = makeClient([tokenResponse()])
    await client.getClientToken()
    await client.getClientToken()
    expect(tokenCalls(fetchImpl.calls)).toHaveLength(2)
  })

  it('does not populate the access-token cache', async () => {
    const { client, fetchImpl } = makeClient([tokenResponse(), tokenResponse(), orderResponse()])
    await client.getClientToken()
    // The next normal call still needs a real client-credentials token.
    await client.getOrder('5O190127TN364715T')
    expect(tokenCalls(fetchImpl.calls)).toHaveLength(2)
  })
})

describe('EC-PP-3: a 401 refreshes the token once', () => {
  const callOpts: CallOpts & { requestId: string } = { requestId: 'cs:att_1:create' }
  const orderBody = {
    intent: 'CAPTURE' as const,
    purchase_units: [{ amount: { currency_code: 'USD' as const, value: '48.00' } }],
  }

  it('EC-PP-3: refreshes once and replays the request', async () => {
    const fetchImpl = fakeFetch((call) => {
      if (call.url.endsWith('/v1/oauth2/token')) return tokenResponse()
      return orderCalls(fetchImpl.calls).length === 1 ? unauthorizedResponse() : orderResponse()
    })
    const client = makeRawClient(fetchImpl)

    const result = await client.createOrder(orderBody, callOpts)
    expect(result.ok).toBe(true)
    // One token, one 401, a refreshed token, then the replayed order call.
    expect(tokenCalls(fetchImpl.calls)).toHaveLength(2)
    expect(orderCalls(fetchImpl.calls)).toHaveLength(2)
  })

  it('refreshes at most once: a second 401 is a real PP_AUTH, not a loop', async () => {
    const fetchImpl = fakeFetch((call) =>
      call.url.endsWith('/v1/oauth2/token') ? tokenResponse() : unauthorizedResponse(),
    )
    const client = makeRawClient(fetchImpl)

    const result = await client.createOrder(orderBody, callOpts)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('PP_AUTH')
      expect(result.error.retryable).toBe(false)
    }
    expect(tokenCalls(fetchImpl.calls)).toHaveLength(2)
    expect(orderCalls(fetchImpl.calls)).toHaveLength(2)
  })

  it('does not count the refresh against the retry budget', async () => {
    const fetchImpl = fakeFetch((call) =>
      call.url.endsWith('/v1/oauth2/token') ? tokenResponse() : unauthorizedResponse(),
    )
    const client = new PayPalClient({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      clock: testClock(),
      fetchImpl,
      sleep: async () => undefined,
      env: { PAYPAL_ENV: 'sandbox', PAYPAL_API_BASE: BASE_URL },
      maxRetries: 1,
    })
    await client.createOrder(orderBody, callOpts)
    // One attempt per token generation, but the 401 replay still happens.
    expect(orderCalls(fetchImpl.calls)).toHaveLength(2)
  })
})

describe('logging (spec §8.6 "Always log paypal-debug-id")', () => {
  it('records a debug id on every response, successes included', async () => {
    const { client, fetchImpl, log } = makeClient((call) =>
      call.url.endsWith('/v1/oauth2/token') ? tokenResponse() : orderResponse(),
    )
    await client.getOrder('5O190127TN364715T')

    const ids = log.fieldsWith('paypal_debug_id').map((l) => l['paypal_debug_id'])
    // One per HTTP response: the token fetch and the order fetch.
    expect(ids).toHaveLength(fetchImpl.calls.length)
    expect(ids.every((id) => typeof id === 'string' && id.startsWith('DEBUG-'))).toBe(true)
  })

  it('records a debug id on a failed response too', async () => {
    const { client, log } = makeClient([tokenResponse(), rateLimitedResponse()], { maxRetries: 1 })
    await client.getOrder('5O190127TN364715T')
    const rejected = log.logs.filter((l) => l.msg === 'paypal response rejected')
    expect(rejected.length).toBeGreaterThan(0)
    expect(rejected[0]?.['paypal_debug_id']).toBe('DEBUG-RATE-LIMITED')
  })

  it('never writes the client secret or the access token into a log line', async () => {
    const { client, log } = makeClient([tokenResponse(), orderResponse()])
    await client.getOrder('5O190127TN364715T')
    expect(log.logs.length).toBeGreaterThan(0)
    for (const line of log.logs) {
      const text = JSON.stringify(line)
      expect(text).not.toContain(CLIENT_SECRET)
      expect(text).not.toContain('A21AAFakeAccessToken0000000000000000')
    }
  })
})

describe('endpoint policy table', () => {
  const REQUIRED_KEYS = [
    'POST /v1/oauth2/token',
    'POST /v2/checkout/orders',
    'GET /v2/checkout/orders/{id}',
    'POST /v2/checkout/orders/{id}/authorize',
    'POST /v2/checkout/orders/{id}/capture',
    'POST /v2/checkout/orders/{id}/track',
    'POST /v2/payments/authorizations/{id}/capture',
    'POST /v2/payments/authorizations/{id}/reauthorize',
    'POST /v2/payments/authorizations/{id}/void',
    'GET /v2/payments/authorizations/{id}',
    'GET /v2/payments/captures/{id}',
    'POST /v2/payments/captures/{id}/refund',
    'GET /v2/payments/refunds/{id}',
    'POST /v3/vault/setup-tokens',
    'POST /v3/vault/payment-tokens',
    'GET /v3/vault/payment-tokens/{id}',
    'DELETE /v3/vault/payment-tokens/{id}',
    'GET /v1/customer/disputes',
    'GET /v1/customer/disputes/{id}',
    'POST /v1/customer/disputes/{id}/provide-evidence',
    'POST /v1/customer/disputes/{id}/accept-claim',
    'POST /v1/customer/disputes/{id}/make-offer',
    'POST /v1/customer/disputes/{id}/send-message',
    'POST /v1/customer/disputes/{id}/appeal',
    'POST /v1/customer/disputes/{id}/acknowledge-return-item',
    'POST /v1/customer/disputes/{id}/provide-supporting-info',
    'POST /v1/customer/disputes/{id}/escalate',
    'POST /v1/notifications/verify-webhook-signature',
    'POST /v1/customer/disputes',
    'POST /v2/customer-support/process-chargeback',
    'POST /v1/customer/disputes/{id}/require-evidence',
    'POST /v1/customer/disputes/{id}/adjudicate',
    'POST /v1/customer/disputes/{id}/change-reason',
    'POST /v1/customer/disputes/{id}/accept-offer',
    'POST /v1/customer/disputes/{id}/deny-offer',
  ]

  it('has a policy for every endpoint the client can reach, and nothing else', () => {
    // `policyFor` falls back to the fail-closed default, which is safe but silent. Asserting exact
    // equality means a new endpoint cannot be added to the client without a decision here.
    expect(Object.keys(ENDPOINT_POLICIES).sort()).toEqual([...REQUIRED_KEYS].sort())
  })

  it('sends a request id only where the header belongs', () => {
    expect(ENDPOINT_POLICIES['POST /v2/checkout/orders']?.sendRequestId).toBe(true)
    expect(ENDPOINT_POLICIES['POST /v2/payments/captures/{id}/refund']?.sendRequestId).toBe(true)
    // Disputes still send the key §8.15 mandates; what is unverified is whether PayPal honours it,
    // which is why their retry policy is `re-read-required`.
    expect(
      ENDPOINT_POLICIES['POST /v1/customer/disputes/{id}/provide-evidence']?.sendRequestId,
    ).toBe(true)
    expect(ENDPOINT_POLICIES['GET /v2/checkout/orders/{id}']?.sendRequestId).toBe(false)
    expect(ENDPOINT_POLICIES['POST /v3/vault/payment-tokens']?.sendRequestId).toBe(false)
  })

  it('auto-retries only where idempotency is documented [B14]', () => {
    const auto = Object.entries(ENDPOINT_POLICIES)
      .filter(([, p]) => p.retry === 'same-request-id')
      .map(([k]) => k)
    // Everything in this list is a GET, the token endpoint, or an Orders v2 / Payments v2 call.
    const undocumented = auto.filter(
      (key) =>
        !key.includes('/v2/checkout/orders') &&
        !key.includes('/v2/payments/') &&
        !key.includes('/v3/vault/payment-tokens/{id}') &&
        !key.includes('/v1/customer/disputes') &&
        key !== 'POST /v1/oauth2/token' &&
        !key.includes('verify-webhook-signature'),
    )
    expect(undocumented).toEqual([])
  })
})

describe('result shape', () => {
  it('never throws across the module boundary', async () => {
    const { client } = makeClient(() => {
      throw new Error('the fake exploded')
    })
    const result = await client.getOrder('5O190127TN364715T')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('PP_UNAVAILABLE')
  })
})

describe('jsonBody helper contract', () => {
  it('refuses a body-less call rather than returning undefined silently', async () => {
    const { client, fetchImpl } = makeClient([tokenResponse(), orderResponse()])
    await client.getOrder('5O190127TN364715T')
    const call = orderCalls(fetchImpl.calls)[0] as RecordedCall
    expect(() => jsonBody(call)).toThrow(/Expected a JSON body/)
  })
})
