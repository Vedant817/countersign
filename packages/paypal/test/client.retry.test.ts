/**
 * Retry behaviour — spec §8.6 "Retries", [B14] [B15], AT-M6.2, AT-M6.3, EC-IDEM-2, EC-IDEM-3, EC-PP-2.
 *
 * Every wait in this file is a *recording*: `deps.sleep` captures the requested delay and advances the
 * fake clock, so a test can assert that the client waited at least 2 s without the suite taking 2 s.
 */
import { describe, expect, it } from 'vitest'

import { createLogger } from '@countersign/core'

import { PayPalClient } from '../src/client'
import type { CallOpts } from '../src/client'
import {
  capturingLogger,
  captureResponse,
  createOrderTestDouble,
  fakeFetch,
  headerOf,
  orderResponse,
  paypalErrorResponse,
  rateLimitedResponse,
  recordingSleep,
  serviceUnavailableResponse,
  testClock,
  tokenResponse,
  unauthorizedResponse,
} from './fixtures/transport-double'
import type { RecordedCall, Stub } from './fixtures/transport-double'

const BASE_URL = 'https://api-m.sandbox.paypal.com'
const CLIENT_ID = 'AY_FAKE_SANDBOX_CLIENT_ID_00000000'
const CLIENT_SECRET = 'EL_FAKE_SANDBOX_SECRET_00000000'

const REQUEST_ID = 'cs:att_01JC0Z9P7YQ8V2N3M4K5K6R7ST8:create'
const ORDER_BODY = createOrderTestDouble()
const CALL_OPTS: CallOpts & { requestId: string } = { requestId: REQUEST_ID }

const isToken = (c: RecordedCall) => c.url.endsWith('/v1/oauth2/token')
const orderCalls = (calls: readonly RecordedCall[]) => calls.filter((c) => c.url.includes('/v2/checkout/orders'))
const evidenceCalls = (calls: readonly RecordedCall[]) => calls.filter((c) => c.url.includes('provide-evidence'))

interface Harness {
  readonly client: PayPalClient
  readonly fetchImpl: ReturnType<typeof fakeFetch>
  /** Every delay the client asked for. */
  readonly sleeps: readonly number[]
  readonly log: ReturnType<typeof capturingLogger>
  readonly clock: ReturnType<typeof testClock>
}

function makeClient(responder: Stub, overrides: { maxRetries?: number } = {}): Harness {
  const clock = testClock()
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
    env: { PAYPAL_ENV: 'sandbox', PAYPAL_API_BASE: BASE_URL },
    ...(overrides.maxRetries !== undefined ? { maxRetries: overrides.maxRetries } : {}),
  })
  return { client, fetchImpl, sleeps: recorder.delays, log, clock }
}

describe('AT-M6.2: 503, 503, 200 succeeds and reuses the same request id', () => {
  it('makes three attempts, all carrying the identical PayPal-Request-Id', async () => {
    const { client, fetchImpl } = makeClient((call) => {
      if (isToken(call)) return tokenResponse()
      return orderCalls(fetchImpl.calls).length <= 2 ? serviceUnavailableResponse() : orderResponse()
    })

    const result = await client.createOrder(ORDER_BODY, CALL_OPTS)
    expect(result.ok).toBe(true)

    const attempts = orderCalls(fetchImpl.calls)
    expect(attempts).toHaveLength(3)
    // [B14]: this id is what makes the third call a *retry* rather than a second order.
    expect(attempts.map((c) => headerOf(c, 'paypal-request-id'))).toEqual([
      REQUEST_ID,
      REQUEST_ID,
      REQUEST_ID,
    ])
  })

  it('backs off between attempts and never before the first', async () => {
    let attempts = 0
    const { client, sleeps } = makeClient((call) => {
      if (isToken(call)) return tokenResponse()
      attempts += 1
      return attempts <= 2 ? serviceUnavailableResponse() : orderResponse()
    })
    await client.createOrder(ORDER_BODY, CALL_OPTS)
    // Two retries, two waits.
    expect(sleeps).toHaveLength(2)
    for (const ms of sleeps) {
      expect(ms).toBeGreaterThanOrEqual(0)
      expect(ms).toBeLessThanOrEqual(20_000)
    }
  })

  it('the retried body is byte-identical, so PayPal sees the same order', async () => {
    const { client, fetchImpl } = makeClient((call) => {
      if (isToken(call)) return tokenResponse()
      return orderCalls(fetchImpl.calls).length <= 2 ? serviceUnavailableResponse() : orderResponse()
    })
    await client.createOrder(ORDER_BODY, CALL_OPTS)
    expect(new Set(orderCalls(fetchImpl.calls).map((c) => c.body)).size).toBe(1)
  })

  it('retries a network error, which is the EC-IDEM-2 case', async () => {
    const { client, fetchImpl } = makeClient((call) => {
      if (isToken(call)) return tokenResponse()
      return orderCalls(fetchImpl.calls).length === 1 ? { throws: new TypeError('fetch failed') } : orderResponse()
    })
    const result = await client.createOrder(ORDER_BODY, CALL_OPTS)
    expect(result.ok).toBe(true)
    expect(orderCalls(fetchImpl.calls).map((c) => headerOf(c, 'paypal-request-id'))).toEqual([
      REQUEST_ID,
      REQUEST_ID,
    ])
  })

  it('retries a 500 as well as a 503', async () => {
    const { client, fetchImpl } = makeClient((call) => {
      if (isToken(call)) return tokenResponse()
      return orderCalls(fetchImpl.calls).length === 1
        ? { status: 500, body: { name: 'INTERNAL_SERVER_ERROR' } }
        : orderResponse()
    })
    expect((await client.createOrder(ORDER_BODY, CALL_OPTS)).ok).toBe(true)
    expect(orderCalls(fetchImpl.calls)).toHaveLength(2)
  })
})

describe('the retry budget', () => {
  it('stops after the budget and returns the last error', async () => {
    const { client, fetchImpl, sleeps } = makeClient((call) =>
      isToken(call) ? tokenResponse() : serviceUnavailableResponse(),
    )
    const result = await client.createOrder(ORDER_BODY, CALL_OPTS)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('PP_UNAVAILABLE')
      expect(result.error.retryable).toBe(true)
    }
    // Spec default: 4 attempts, so 3 waits.
    expect(orderCalls(fetchImpl.calls)).toHaveLength(4)
    expect(sleeps).toHaveLength(3)
  })

  it('maxRetries is a total attempt count, not extra retries', async () => {
    const { client, fetchImpl } = makeClient(
      (call) => (isToken(call) ? tokenResponse() : serviceUnavailableResponse()),
      { maxRetries: 1 },
    )
    await client.createOrder(ORDER_BODY, CALL_OPTS)
    expect(orderCalls(fetchImpl.calls)).toHaveLength(1)
  })

  it('never retries a non-retryable code', async () => {
    // A 422 fails identically forever; retrying it is how one bad amount becomes a rate limit.
    const { client, fetchImpl, sleeps } = makeClient((call) =>
      isToken(call)
        ? tokenResponse()
        : paypalErrorResponse('UNPROCESSABLE_ENTITY', 'INVALID_PARAMETER_VALUE', 422),
    )
    const result = await client.createOrder(ORDER_BODY, CALL_OPTS)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('PP_UNPROCESSABLE')
    expect(orderCalls(fetchImpl.calls)).toHaveLength(1)
    expect(sleeps).toHaveLength(0)
  })
})

describe('AT-M6.3 / EC-PP-2: a 429 with Retry-After: 2 waits at least 2 s', () => {
  it('waits ≥ 2000 ms before retrying, measured by the injected sleep', async () => {
    const { client, fetchImpl, sleeps, clock } = makeClient((call) => {
      if (isToken(call)) return tokenResponse()
      return orderCalls(fetchImpl.calls).length === 1 ? rateLimitedResponse(2) : orderResponse()
    })

    const before = clock.nowMs()
    const result = await client.createOrder(ORDER_BODY, CALL_OPTS)

    expect(result.ok).toBe(true)
    expect(sleeps).toHaveLength(1)
    // The requirement, stated as a number.
    expect(sleeps[0]).toBeGreaterThanOrEqual(2_000)
    // And the fake clock really advanced, so a later cache check sees the new time.
    expect(clock.nowMs() - before).toBeGreaterThanOrEqual(2_000)
  })

  it('honours a longer Retry-After', async () => {
    const { client, sleeps } = makeClient((call) =>
      isToken(call) ? tokenResponse() : rateLimitedResponse(30),
    )
    await client.createOrder(ORDER_BODY, CALL_OPTS)
    expect(sleeps[0]).toBeGreaterThanOrEqual(30_000)
  })

  it('falls back to jitter when no Retry-After is present', async () => {
    const { client, sleeps } = makeClient((call) =>
      isToken(call) ? tokenResponse() : { status: 429, body: { name: 'RATE_LIMIT_REACHED' } },
    )
    await client.createOrder(ORDER_BODY, CALL_OPTS)
    expect(sleeps.length).toBeGreaterThan(0)
    // The first ceiling is base × factor⁰ = 500 ms, and full jitter is below it.
    expect(sleeps[0]).toBeLessThanOrEqual(500)
  })

  it('a 429 does not count toward the circuit-breaker outage budget', async () => {
    // PayPal is up and asking us to slow down. Treating that as "unavailable" would open the breaker
    // on a rate limit and then fail fast the very requests that would have succeeded after a pause.
    const { client } = makeClient((call) => (isToken(call) ? tokenResponse() : rateLimitedResponse(0)))
    await client.createOrder(ORDER_BODY, CALL_OPTS)
    expect(client.breakerState()).toBe('closed')
  })

  it('a 429 keeps the same request id across the retry', async () => {
    const { client, fetchImpl } = makeClient((call) => {
      if (isToken(call)) return tokenResponse()
      return rateLimitedResponse(0)
    })
    await client.createOrder(ORDER_BODY, CALL_OPTS)
    const ids = new Set(orderCalls(fetchImpl.calls).map((c) => headerOf(c, 'paypal-request-id')))
    expect(ids).toEqual(new Set([REQUEST_ID]))
  })
})

describe('EC-PP-1: repeated unavailability opens the breaker, then calls fail fast', () => {
  it('opens after five exhausted budgets and stops calling PayPal', async () => {
    const { client, fetchImpl } = makeClient((call) =>
      isToken(call) ? tokenResponse() : serviceUnavailableResponse(),
    )

    // Five calls, each burning the full attempt budget.
    for (let i = 0; i < 5; i++) await client.createOrder(ORDER_BODY, CALL_OPTS)
    expect(client.breakerState()).toBe('open')

    const callsBefore = fetchImpl.calls.length
    const result = await client.createOrder(ORDER_BODY, CALL_OPTS)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('PP_UNAVAILABLE')
      // retryable:true is what lets the queue retry it (EC-PP-1: "we'll retry for 15 min").
      expect(result.error.retryable).toBe(true)
      expect(result.error.details?.['host']).toBe('api-m.sandbox.paypal.com')
    }
    // Fail fast: not one more HTTP call.
    expect(fetchImpl.calls.length).toBe(callsBefore)
  })

  it('a recovered host closes the breaker through the half-open probe', async () => {
    let failing = true
    const { client, clock } = makeClient((call) =>
      isToken(call) ? tokenResponse() : failing ? serviceUnavailableResponse() : orderResponse(),
    )

    for (let i = 0; i < 5; i++) await client.createOrder(ORDER_BODY, CALL_OPTS)
    expect(client.breakerState()).toBe('open')

    failing = false
    clock.advance(31)
    expect((await client.createOrder(ORDER_BODY, CALL_OPTS)).ok).toBe(true)
    expect(client.breakerState()).toBe('closed')
  })

  it('is resettable', async () => {
    const { client } = makeClient((call) =>
      isToken(call) ? tokenResponse() : serviceUnavailableResponse(),
    )
    for (let i = 0; i < 5; i++) await client.createOrder(ORDER_BODY, CALL_OPTS)
    expect(client.breakerState()).toBe('open')
    client.resetCircuit()
    expect(client.breakerState()).toBe('closed')
  })

  it('a 422 does not open the breaker — the host answered', async () => {
    const { client } = makeClient((call) =>
      isToken(call)
        ? tokenResponse()
        : paypalErrorResponse('UNPROCESSABLE_ENTITY', 'INVALID_PARAMETER_VALUE', 422),
    )
    for (let i = 0; i < 8; i++) await client.createOrder(ORDER_BODY, CALL_OPTS)
    expect(client.breakerState()).toBe('closed')
  })
})

describe('EC-IDEM-3: an ambiguous failure on an unverified endpoint is not blind-retried', () => {
  const evidence = { evidences: [{ evidence_type: 'PROOF_OF_FULFILLMENT', notes: 'Tracked on 1 Oct.' }] }

  it('returns a retryable-but-ambiguous error and makes exactly one attempt', async () => {
    // Disputes v1 idempotency support is UNVERIFIED (spec U5), so a 5xx there might have created a
    // second filing. The client refuses to retry; the caller re-reads the dispute first.
    const { client, fetchImpl, sleeps } = makeClient((call) =>
      isToken(call) ? tokenResponse() : serviceUnavailableResponse(),
    )

    const result = await client.provideEvidence('PP-D-2781AB12CD34', evidence, [])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('PP_UNAVAILABLE')
      expect(result.error.retryable).toBe(true)
      expect(result.error.details?.['ambiguous']).toBe(true)
    }
    expect(sleeps).toHaveLength(0)
    expect(evidenceCalls(fetchImpl.calls)).toHaveLength(1)
  })

  it('still retries a 429 there: the request was refused, not executed', async () => {
    const { client, fetchImpl } = makeClient((call) =>
      isToken(call) ? tokenResponse() : rateLimitedResponse(0),
    )
    await client.provideEvidence('PP-D-2781AB12CD34', evidence, [])
    expect(evidenceCalls(fetchImpl.calls)).toHaveLength(4)
  })

  it('retries a documented-idempotent endpoint on a 5xx', async () => {
    const { client, fetchImpl } = makeClient((call) => {
      if (isToken(call)) return tokenResponse()
      return orderCalls(fetchImpl.calls).length === 1 ? serviceUnavailableResponse() : orderResponse()
    })
    expect((await client.createOrder(ORDER_BODY, CALL_OPTS)).ok).toBe(true)
    expect(orderCalls(fetchImpl.calls)).toHaveLength(2)
  })

  it('retries a GET freely, because a GET has no side effect to duplicate', async () => {
    let gets = 0
    const { client, fetchImpl } = makeClient((call) => {
      if (isToken(call)) return tokenResponse()
      gets += 1
      return gets <= 2 ? serviceUnavailableResponse() : captureResponse()
    })
    expect((await client.getCapture('3C679366HH908993F')).ok).toBe(true)
    expect(fetchImpl.calls.filter((c) => c.url.includes('/captures/'))).toHaveLength(3)
  })
})

describe('request-id handling', () => {
  it('refuses a side-effecting call with no request id, before any HTTP call', async () => {
    const { client, fetchImpl } = makeClient([tokenResponse()])
    const result = await client.createOrder(ORDER_BODY, {} as CallOpts & { requestId: string })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('CS_VALIDATION')
      expect(result.error.message).toContain('deterministic requestId')
    }
    // Refused before any HTTP call: not even a token request.
    expect(fetchImpl.calls).toHaveLength(0)
  })

  it('refuses a request id that is not header-safe, before any HTTP call', async () => {
    const { client, fetchImpl } = makeClient([tokenResponse()])
    const result = await client.createOrder(ORDER_BODY, { requestId: 'cs:has space:create' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('CS_VALIDATION')
    expect(fetchImpl.calls).toHaveLength(0)
  })

  it('drops the request id on endpoints that do not take one, and says so in the log', async () => {
    const { client, fetchImpl, log } = makeClient((call) =>
      isToken(call) ? tokenResponse() : { status: 201, body: { id: '5TY05013RG002845M', status: 'ACTIVE' } },
    )
    await client.createPaymentToken('8CM364183LM392832', { requestId: REQUEST_ID })
    const call = fetchImpl.calls.find((c) => c.url.includes('/v3/vault/payment-tokens')) as RecordedCall
    expect(headerOf(call, 'paypal-request-id')).toBeUndefined()
    expect(log.logs.some((l) => String(l.msg).includes('does not get a PayPal-Request-Id'))).toBe(true)
  })

  it('sends Prefer verbatim when asked', async () => {
    const { client, fetchImpl } = makeClient((call) => (isToken(call) ? tokenResponse() : captureResponse()))
    await client.captureAuthorization(
      '8AB12345AB6789123',
      { final_capture: true },
      { requestId: REQUEST_ID, prefer: 'return=minimal' },
    )
    const call = fetchImpl.calls.find((c) => c.url.includes('/capture')) as RecordedCall
    expect(headerOf(call, 'prefer')).toBe('return=minimal')
  })

  it('carries the request id through to a payments-v2 call', async () => {
    const { client, fetchImpl } = makeClient((call) => (isToken(call) ? tokenResponse() : captureResponse()))
    await client.captureAuthorization('8AB12345AB6789123', { final_capture: false }, CALL_OPTS)
    const call = fetchImpl.calls.find((c) => c.url.includes('/capture')) as RecordedCall
    expect(headerOf(call, 'paypal-request-id')).toBe(REQUEST_ID)
  })
})

describe('a 401 inside a retry budget', () => {
  it('refreshes once and does not loop', async () => {
    const fetchImpl = fakeFetch((call) => (isToken(call) ? tokenResponse() : unauthorizedResponse()))
    const client = new PayPalClient({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      clock: testClock(),
      fetchImpl,
      sleep: async () => undefined,
      env: { PAYPAL_ENV: 'sandbox', PAYPAL_API_BASE: BASE_URL },
    })
    const result = await client.createOrder(ORDER_BODY, CALL_OPTS)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('PP_AUTH')
    // The 401 is not retryable, so exactly one attempt plus one post-refresh attempt.
    expect(orderCalls(fetchImpl.calls)).toHaveLength(2)
  })
})