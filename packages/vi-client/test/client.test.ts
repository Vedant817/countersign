/**
 * Transport behaviour — spec §8.4 (M4), plus the §12 rows this package can be responsible for.
 *
 * Everything here runs against an injected `fetch`, so **no test in this file opens a socket** and the
 * suite is identical on a laptop and in CI with no vi-service anywhere.
 *
 * The four things worth checking, in order of how badly they would hurt if they broke:
 *
 *  1. **A `VI_SIGNATURE_MISMATCH` from `l2/finalize` arrives as `VI_SIGNATURE_MISMATCH`** (spec §8.5,
 *     EC-KEY-1). The browser UI branches on that code.
 *  2. **`chain_valid: false` is a success, not an error.** An invalid chain is a verdict; the Gate reads
 *     `errors`, `constraints.skipped` and `disclosed` to make its decision, and an `err` would discard all
 *     of it.
 *  3. **4xx is not retried, 5xx is.** See `retry.test.ts` for the policy table; this file proves the
 *     policy is actually wired to the loop.
 *  4. **A hung service cannot hang a Gate decision.** The 5 s timeout is real, on real timers.
 */
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_MAX_RETRIES,
  ViClient,
  jsonSafeBody,
  mapViError,
  normaliseBaseUrl,
} from '../src/client'
import { pendingNetworkEnforcement } from '../src/types'
import type { L2PrepareRequest } from '../src/types'
import { isCsErrorCode } from '@countersign/core'
import {
  csErrorBody,
  fakeFetch,
  headerOf,
  jsonBody,
  l1Response,
  prepareResponse,
  publicJwk,
  recordingSleep,
  testClock,
  verifyResponse,
  viUnhandledError,
} from './fixtures/vi-transport-double'
import type {
  FetchDouble,
  FakeResponseSpec,
  RecordedCall,
  Stub,
} from './fixtures/vi-transport-double'

const BASE_URL = 'http://vi:8000'
const TOKEN = 'test-service-token-do-not-use-in-prod'

const MERCHANT = {
  id: 'mrc_northwind',
  name: 'Northwind Outfitters',
  website: 'https://northwind.test',
}
const ITEM = { id: 'SKU-TRAIL-42', title: 'Trail Runner' }

interface Harness {
  readonly client: ViClient
  readonly fetchImpl: FetchDouble
  readonly sleeps: readonly number[]
}

/** A client wired to a `fetch` double, a recording sleep and a frozen clock. */
function makeClient(
  responder: Stub,
  overrides: { maxRetries?: number; timeoutMs?: number; token?: string } = {},
): Harness {
  const recorder = recordingSleep()
  const fetchImpl = fakeFetch(responder)
  const client = new ViClient({
    baseUrl: BASE_URL,
    token: overrides.token ?? TOKEN,
    clock: testClock(),
    fetchImpl,
    sleep: recorder.sleep,
    ...(overrides.maxRetries !== undefined ? { maxRetries: overrides.maxRetries } : {}),
    ...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
  })
  return { client, fetchImpl, sleeps: recorder.delays }
}

/** Every `CsErrorCode` `apps/vi` can put on the wire, with the status `errors.py::_STATUS` gives it. */
const SERVICE_ERRORS: readonly { code: string; status: number; why: string }[] = [
  {
    code: 'CS_VALIDATION',
    status: 400,
    why: 'FastAPI request validation, converted by `_validation_error`',
  },
  { code: 'CS_ROUNDING', status: 400, why: 'an amount with more decimals than the currency has' },
  {
    code: 'CS_CURRENCY_MISMATCH',
    status: 400,
    why: 'a USD cap against an INR purchase; we never convert',
  },
  { code: 'CS_UNAUTHENTICATED', status: 401, why: 'a missing or wrong bearer token' },
  { code: 'CS_FORBIDDEN', status: 403, why: 'reserved by `_STATUS`' },
  { code: 'CS_NOT_FOUND', status: 404, why: 'an expired prepare_id, and an unknown path' },
  { code: 'CS_CONFLICT', status: 409, why: 'reserved by `_STATUS`' },
  { code: 'CS_CONFLICT', status: 429, why: "the public routes' 30/min/IP limit, with Retry-After" },
  {
    code: 'VI_SIGNATURE_MISMATCH',
    status: 400,
    why: 'l2/finalize with the wrong device key — spec §8.5, EC-KEY-1',
  },
  { code: 'VI_CHAIN_INVALID', status: 422, why: 'reserved by `_STATUS`' },
  { code: 'VI_EXPIRED', status: 422, why: 'reserved by `_STATUS`' },
  { code: 'VI_NOT_YET_VALID', status: 422, why: 'reserved by `_STATUS`' },
  {
    code: 'VI_CONSTRAINT_VIOLATION',
    status: 422,
    why: 'a constraint vi refuses, or l3/create out of mandate',
  },
]

// ---------------------------------------------------------------------------
// Auth — spec §8.3
// ---------------------------------------------------------------------------

describe('bearer authentication', () => {
  it('sends the bearer token on every route except the three public ones', async () => {
    const { client, fetchImpl } = makeClient(({ url }) => ({
      status: 200,
      body: statusBodyFor(url),
    }))
    await client.jwks()
    await client.status()
    await client.mintAgentKey({ agent_id: 'agt_test' })

    const jwks = fetchImpl.callsTo('/v1/jwks')[0] as RecordedCall
    expect(headerOf(jwks, 'authorization')).toBeUndefined()

    const status = fetchImpl.callsTo('/v1/status')[0] as RecordedCall
    expect(headerOf(status, 'authorization')).toBeUndefined()

    const keys = fetchImpl.callsTo('/v1/keys/agent')[0] as RecordedCall
    expect(headerOf(keys, 'authorization')).toBe(`Bearer ${TOKEN}`)
  })

  it('does not send the token on POST /v1/public/verify, which is public and rate-limited', async () => {
    const { client, fetchImpl } = makeClient({
      status: 200,
      body: { ...verifyResponse(), bundle_hash: 'a'.repeat(43) },
    })
    await client.publicVerify({ bundle: { l1: 'a.b.c~', l2: 'a.b.c~d~' } })
    expect(headerOf(fetchImpl.calls[0] as RecordedCall, 'authorization')).toBeUndefined()
  })

  it('maps a 401 on a private route to CS_UNAUTHENTICATED without retrying', async () => {
    const { client, fetchImpl } = makeClient({
      status: 401,
      body: csErrorBody('CS_UNAUTHENTICATED', 'Invalid bearer token for this route.'),
    })
    const r = await client.mintAgentKey({ agent_id: 'agt_test' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('CS_UNAUTHENTICATED')
    expect(r.error.details?.['http_status']).toBe(401)
    // A wrong token is a wrong token on the second attempt too.
    expect(fetchImpl.calls).toHaveLength(1)
  })
})

/** `vi_service.models.StatusResponse`. */
function statusResponseBody(): unknown {
  return {
    ok: true,
    app_env: 'test',
    issuer_kid: 'issuer-key-1',
    merchant_kid: 'merchant-key-1',
    clock_skew_seconds: 300,
  }
}

/** Minimal valid bodies so `status()` / `mintAgentKey()` can share one responder. */
function statusBodyFor(url: string): unknown {
  if (url.endsWith('/v1/status')) return statusResponseBody()
  return { kid: 'agt_k_1', public_jwk: publicJwk(), enc_private_key_b64: 'Y2lwaGVydGV4dA==' }
}

// ---------------------------------------------------------------------------
// Error mapping — spec §8.0 rule 3, §8.5
// ---------------------------------------------------------------------------

describe('error-body mapping', () => {
  it.each(SERVICE_ERRORS)(
    'maps $code at $status without alteration ($why)',
    async ({ code, status }) => {
      const { client } = makeClient({
        status,
        body: csErrorBody(code, `vi says ${code}`, { retryable: false }),
      })
      const r = await client.mintAgentKey({ agent_id: 'agt_test' })
      expect(r.ok).toBe(false)
      if (r.ok) return
      // The service's code survives verbatim — that is the whole contract (spec §8.0 rule 3).
      expect(r.error.code).toBe(code)
      expect(isCsErrorCode(r.error.code)).toBe(true)
      expect(r.error.message).toContain(`vi says ${code}`)
      expect(r.error.details?.['http_status']).toBe(status)
      expect(r.error.details?.['vi_code']).toBe(code)
    },
  )

  /**
   * EC-KEY-1's UI hinges on this one. A user cleared their browser, a new device key was enrolled, the old
   * mandate is gone; `l2/finalize` answers `VI_SIGNATURE_MISMATCH` and the browser must show "this device
   * is new" rather than a generic failure. Flattening that to `CS_INTERNAL` sends the user to the wrong page.
   */
  it('returns VI_SIGNATURE_MISMATCH from l2/finalize as VI_SIGNATURE_MISMATCH, once, with the service copy', async () => {
    const { client, fetchImpl } = makeClient({
      status: 400,
      body: csErrorBody(
        'VI_SIGNATURE_MISMATCH',
        'The signature does not verify against the L1 device key.',
        {
          userMessage: 'The signature did not match the key in the mandate, so we stopped.',
        },
      ),
    })
    const r = await client.finalizeL2({ prepare_id: 'prep_1', signature_b64url: 'AAAA' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('VI_SIGNATURE_MISMATCH')
    expect(r.error.userMessage).toBe(
      'The signature did not match the key in the mandate, so we stopped.',
    )
    expect(r.error.retryable).toBe(false)
    // Not retried: a second attempt signs the same wrong bytes and reaches the same verdict.
    expect(fetchImpl.calls).toHaveLength(1)
  })

  it('carries the service details through, so a Gate reason can quote them', async () => {
    const { client } = makeClient({
      status: 422,
      body: csErrorBody('VI_CONSTRAINT_VIOLATION', 'Amount exceeds maximum', {
        details: {
          side: 'payment',
          amount_minor: 25_000,
          violations: ['Amount exceeds maximum: 25000 > 20000 USD'],
        },
      }),
    })
    const r = await client.createL3({
      agent_kid: 'agt_k_1',
      enc_private_key_b64: 'Y2lwaGVy',
      l2: 'a.b.c~d~',
      checkout_jwt: 'a.b.c',
      payment: { amount_minor: 25_000, currency: 'USD', payee_id: 'mrc_northwind' },
      aud: 'https://network.test',
      nonce: 'n1',
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('VI_CONSTRAINT_VIOLATION')
    const details = r.error.details?.['service_details'] as Record<string, unknown>
    expect(details['amount_minor']).toBe(25_000)
    expect((details['violations'] as string[])[0]).toContain('25000 > 20000 USD')
  })

  it('keeps the 429 rate-limit verdict retryable, because the caller decides when to come back', async () => {
    const { client, fetchImpl } = makeClient({
      status: 429,
      headers: { 'retry-after': '30' },
      body: csErrorBody('CS_CONFLICT', 'Rate limit exceeded.', { retryable: true }),
    })
    const r = await client.jwks()
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('CS_CONFLICT')
    expect(r.error.retryable).toBe(true)
    // But the client itself does not retry it: on a 30/min window an immediate retry can extend the block.
    expect(fetchImpl.calls).toHaveLength(1)
  })

  /**
   * `apps/vi`'s catch-all handler answers a 500 with `CS_VALIDATION` because its registry mirror predates
   * `CS_INTERNAL` (DECISIONS D-007). The client keeps the code — rewriting it would hide a real divergence
   * between the two error registries — but overrides `retryable`, because a 500 is not the caller's fault.
   */
  it('reports vi’s 500-as-CS_VALIDATION as retryable, and keeps the mislabelled code visible', async () => {
    const { client, fetchImpl } = makeClient(viUnhandledError())
    const r = await client.mintAgentKey({ agent_id: 'agt_test' })
    expect(fetchImpl.calls).toHaveLength(DEFAULT_MAX_RETRIES + 1)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('CS_VALIDATION')
    expect(r.error.retryable).toBe(true)
    expect(r.error.details?.['http_status']).toBe(500)
  })

  it('falls back to a status-derived code when the body is not a CsErrorBody', () => {
    // apps/vi wraps everything, so this means a proxy or a load balancer answered.
    for (const [status, expected] of [
      [401, 'CS_UNAUTHENTICATED'],
      [403, 'CS_FORBIDDEN'],
      [404, 'CS_NOT_FOUND'],
      [409, 'CS_CONFLICT'],
      [422, 'CS_VALIDATION'],
      [503, 'CS_INTERNAL'],
    ] as const) {
      expect(
        mapViError({ status, body: '<html>502</html>', method: 'GET', path: '/v1/status' }).code,
      ).toBe(expected)
    }
  })

  it('names an unrecognised service code in details rather than absorbing it', () => {
    const e = mapViError({
      status: 400,
      body: {
        error: {
          code: 'VI_SOMETHING_NEW',
          message: 'a code core has never heard of',
          retryable: false,
        },
      },
      method: 'POST',
      path: '/v1/l3/create',
    })
    expect(e.code).toBe('CS_VALIDATION')
    expect(e.details?.['vi_code']).toBe('VI_SOMETHING_NEW')
  })

  it('survives a response body that is not JSON at all', async () => {
    const { client } = makeClient({
      status: 502,
      text: '<html><body>502 Bad Gateway</body></html>',
    })
    const r = await client.status()
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('CS_INTERNAL')
    expect(r.error.message).toContain('no CsErrorBody')
  })
})

// ---------------------------------------------------------------------------
// /v1/verify — an invalid chain is a result
// ---------------------------------------------------------------------------

describe('POST /v1/verify', () => {
  it('returns an invalid chain as ok(), with the reasons readable', async () => {
    const { client, fetchImpl } = makeClient({
      status: 200,
      body: verifyResponse({
        chainValid: false,
        errors: ['L2 signature verification failed', 'L3a issuer is not the key bound in the L2'],
        satisfied: false,
        violations: ['Amount exceeds maximum: 25000 > 20000 USD'],
      }),
    })
    const r = await client.verify({ l1: 'a.b.c~', l2: 'a.b.c~d~' })
    // The Gate needs `errors` to write a decision, and `skipped` to know what it still owes (spec D19).
    // An `err` here would discard both.
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.chain_valid).toBe(false)
    expect(r.value.errors).toHaveLength(2)
    expect(r.value.constraints.satisfied).toBe(false)
    expect(r.value.constraints.violations[0]).toContain('25000 > 20000 USD')
    // Spec D19: `skipped` says what the Gate still owes, and its entries are annotated — hence the helper
    // rather than `includes`, which would always be false.
    expect(pendingNetworkEnforcement(r.value.constraints.skipped)).toContain(
      'mandate.payment.budget',
    )
    expect(r.value.disclosed).toEqual({ l1: {}, l2: {}, l3a: {}, l3b: {} })
    expect(r.value.keys.issuer_kid).toBe('issuer-key-1')
    // A 200 is a 200: not retried, one call.
    expect(fetchImpl.calls).toHaveLength(1)
  })

  it('returns a valid chain as ok() too, and defaults strict to true on the wire', async () => {
    const { client, fetchImpl } = makeClient({ status: 200, body: verifyResponse() })
    const r = await client.verify({ l1: 'a.b.c~', l2: 'a.b.c~d~' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.chain_valid).toBe(true)
    expect(jsonBody(fetchImpl.calls[0] as RecordedCall)).toMatchObject({ strict: true })
  })

  it('returns err() only for a bad *request* or a transport failure, never for a bad chain', async () => {
    const { client } = makeClient({
      status: 400,
      body: csErrorBody('CS_VALIDATION', 'Request body failed validation'),
    })
    const r = await client.verify({ l1: '', l2: 'a.b.c~d~' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('CS_VALIDATION')
  })

  it('publicVerify returns the same verdict plus bundle_hash, and an invalid chain is still ok()', async () => {
    const { client } = makeClient({
      status: 200,
      body: {
        ...verifyResponse({ chainValid: false, errors: ['L2 signature verification failed'] }),
        bundle_hash: 'B'.repeat(43),
      },
    })
    const r = await client.publicVerify({ bundle: { v: 'cs1', l1: 'a.b.c~', l2: 'a.b.c~d~' } })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.chain_valid).toBe(false)
    expect(r.value.bundle_hash).toHaveLength(43)
  })
})

// ---------------------------------------------------------------------------
// Retry wiring
// ---------------------------------------------------------------------------

describe('retry wiring', () => {
  it('retries a 5xx the configured number of times and returns the last error', async () => {
    const { client, fetchImpl, sleeps } = makeClient({ status: 503, text: 'Service Unavailable' })
    const r = await client.mintAgentKey({ agent_id: 'agt_test' })
    expect(fetchImpl.calls).toHaveLength(DEFAULT_MAX_RETRIES + 1)
    expect(sleeps).toHaveLength(DEFAULT_MAX_RETRIES)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('CS_INTERNAL')
  })

  it('retries and then succeeds', async () => {
    const { client, fetchImpl } = makeClient([
      { status: 503, body: csErrorBody('CS_VALIDATION', 'transient') },
      { status: 503, body: csErrorBody('CS_VALIDATION', 'transient') },
      { status: 200, body: statusBodyFor('http://vi:8000/v1/keys/agent') },
    ])
    const r = await client.mintAgentKey({ agent_id: 'agt_test' })
    expect(fetchImpl.calls).toHaveLength(3)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.kid).toBe('agt_k_1')
  })

  it('retries l2/prepare on a 5xx, because repeating it is safe (spec §8.4)', async () => {
    const { client, fetchImpl } = makeClient([
      { status: 500, body: csErrorBody('CS_VALIDATION', 'transient') },
      { status: 200, body: prepareResponse() },
    ])
    const r = await client.prepareL2(prepareRequest())
    expect(fetchImpl.calls).toHaveLength(2)
    expect(r.ok).toBe(true)
  })

  it('retries a connection reset', async () => {
    const { client, fetchImpl } = makeClient([
      { throws: Object.assign(new Error('ECONNRESET'), { name: 'Error' }) },
      { status: 200, body: statusBodyFor('http://vi:8000/v1/keys/agent') },
    ])
    const r = await client.mintAgentKey({ agent_id: 'agt_test' })
    expect(fetchImpl.calls).toHaveLength(2)
    expect(r.ok).toBe(true)
  })

  it('gives up on a connection error once the budget is spent and says how many attempts it made', async () => {
    const { client, fetchImpl } = makeClient({ throws: new Error('ECONNREFUSED') })
    const r = await client.mintAgentKey({ agent_id: 'agt_test' })
    expect(fetchImpl.calls).toHaveLength(DEFAULT_MAX_RETRIES + 1)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('CS_INTERNAL')
    expect(r.error.retryable).toBe(true)
    expect(r.error.details?.['attempts']).toBe(DEFAULT_MAX_RETRIES + 1)
    expect(r.error.details?.['ambiguous']).toBe(true)
  })

  it('never retries a 4xx, however many attempts the budget allows', async () => {
    for (const status of [400, 401, 403, 404, 409, 422, 429]) {
      const { client, fetchImpl } = makeClient({
        status,
        body: csErrorBody('CS_VALIDATION', 'nope'),
      })
      await client.mintAgentKey({ agent_id: 'agt_test' })
      expect(fetchImpl.calls, `status ${status}`).toHaveLength(1)
    }
  })

  it('honours a maxRetries of zero', async () => {
    const { client, fetchImpl } = makeClient({ status: 503 }, { maxRetries: 0 })
    await client.mintAgentKey({ agent_id: 'agt_test' })
    expect(fetchImpl.calls).toHaveLength(1)
  })

  it('does not retry a 2xx whose body it does not recognise, because a 2xx will be a 2xx again', async () => {
    const { client, fetchImpl } = makeClient({
      status: 200,
      body: { kid: 'agt_k_1', surprise: true },
    })
    const r = await client.mintAgentKey({ agent_id: 'agt_test' })
    expect(fetchImpl.calls).toHaveLength(1)
    expect(r.ok).toBe(false)
    if (r.ok) return
    // Not CS_VALIDATION: the request was fine, the response shape changed under us.
    expect(r.error.code).toBe('CS_INTERNAL')
    expect(r.error.message).toMatch(/does not recognise/)
  })

  it('sends a signal on every request, so a hung service can always be cut loose', async () => {
    const { client, fetchImpl } = makeClient({
      status: 200,
      body: statusBodyFor('http://vi:8000/v1/status'),
    })
    await client.status()
    const signal = (fetchImpl.calls[0] as RecordedCall).init?.signal
    expect(signal).toBeInstanceOf(AbortSignal)
  })
})

// ---------------------------------------------------------------------------
// The 5 s timeout
// ---------------------------------------------------------------------------

describe('the per-attempt timeout', () => {
  it('gives up on a hung service and says it timed out', async () => {
    // Real timers, 20 ms instead of 5 000 ms: the mechanism under test is `AbortSignal.timeout`, and a
    // fake timer would not exercise it. Three attempts of 20 ms is still milliseconds of wall clock.
    const { client, fetchImpl } = makeClient({ hangUntilAbort: true }, { timeoutMs: 20 })
    const r = await client.mintAgentKey({ agent_id: 'agt_test' })
    expect(fetchImpl.calls).toHaveLength(DEFAULT_MAX_RETRIES + 1)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('CS_INTERNAL')
    expect(r.error.details?.['timed_out']).toBe(true)
    expect(r.error.message).toMatch(/timeout after 20 ms/)
    expect(r.error.retryable).toBe(true)
  })

  it('does not report a plain connection reset as a timeout', async () => {
    const { client } = makeClient({ throws: new Error('ECONNREFUSED') }, { timeoutMs: 20 })
    const r = await client.mintAgentKey({ agent_id: 'agt_test' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.details?.['timed_out']).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Request construction and money on the wire
// ---------------------------------------------------------------------------

describe('request construction', () => {
  it('validates the request before the first fetch, so a float never reaches the wire', async () => {
    const { client, fetchImpl } = makeClient({ status: 200, body: {} })
    const r = await client.createCheckoutJwt({
      merchant: MERCHANT,
      // EC-FX-6: `13000.0` is a float and vi would reject it; we refuse it first, with a better message.
      lines: [{ sku: ITEM.id, title: ITEM.title, qty: 1, unit_minor: 13_000.5 }],
      currency: 'USD',
    })
    expect(fetchImpl.calls).toHaveLength(0)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('CS_VALIDATION')
    expect(r.error.message).toMatch(/checkout-jwt request failed validation/)
  })

  it('serialises bigint money as a JSON integer, never a float and never a string', async () => {
    const { client, fetchImpl } = makeClient({
      status: 200,
      body: {
        checkout_jwt: 'a.b.c',
        checkout_hash: 'h',
        exp: 1,
        total_minor: 13_300,
        currency: 'USD',
        kid: 'm1',
      },
    })
    const r = await client.createCheckoutJwt({
      merchant: MERCHANT,
      lines: [{ sku: ITEM.id, title: ITEM.title, qty: 2, unit_minor: 13_000 }],
      shipping_minor: 500,
      tax_minor: 800,
      currency: 'USD',
    })
    expect(r.ok).toBe(true)
    // The literal text matters: `13000` not `13000.0`, and not `"13000"`.
    const raw = String((fetchImpl.calls[0] as RecordedCall).body)
    expect(raw).toContain('"unit_minor":13000')
    expect(raw).toContain('"shipping_minor":500')
    expect(raw).not.toContain('13000.0')
    expect(jsonBody(fetchImpl.calls[0] as RecordedCall)).toMatchObject({
      tax_minor: 800,
      currency: 'USD',
    })
  })

  it('sends content-type: application/json and accepts JSON', async () => {
    const { client, fetchImpl } = makeClient({
      status: 200,
      body: statusBodyFor('http://vi:8000/v1/status'),
    })
    await client.status()
    const call = fetchImpl.calls[0] as RecordedCall
    expect(headerOf(call, 'accept')).toBe('application/json')
    // A GET has no body, so it must not claim to have one.
    expect(headerOf(call, 'content-type')).toBeUndefined()

    const { client: c2, fetchImpl: f2 } = makeClient({
      status: 200,
      body: statusBodyFor('http://vi:8000/v1/keys/agent'),
    })
    await c2.mintAgentKey({ agent_id: 'agt_test' })
    expect(headerOf(f2.calls[0] as RecordedCall, 'content-type')).toBe('application/json')
  })

  it('reproduces vi’s own defaults in the body it sends', async () => {
    const { client, fetchImpl } = makeClient({ status: 200, body: l1Response() })
    await client.issueL1({
      user_id: 'usr_test_user',
      wallet: { payer_id: 'PAYER123', payer_email: 'b@c.test', payment_token_id: 'tok' },
      device_public_jwk: publicJwk(),
    })
    expect(jsonBody(fetchImpl.calls[0] as RecordedCall)).toMatchObject({
      device_kid: 'device-key-1',
      ttl_days: 365,
      pan_last_four: '0000',
      scheme: 'PayPal',
    })
  })

  it('passes signing_input through byte for byte and never re-encodes it', async () => {
    const body = prepareResponse()
    const { client } = makeClient({ status: 200, body })
    const r = await client.prepareL2(prepareRequest())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // This is the string the browser must sign. Any re-serialisation here would produce a signature that
    // verifies against the wrong bytes and surfaces as VI_SIGNATURE_MISMATCH.
    expect(r.value.signing_input).toBe(body['signing_input'])
    expect(r.value.signing_input.split('.')).toHaveLength(2)
  })

  it('refuses a prepare response whose signing_input violates the two-segment invariant', async () => {
    const body = prepareResponse()
    const { client } = makeClient({
      status: 200,
      body: { ...body, signing_input: `${String(body['signing_input'])}.` },
    })
    const r = await client.prepareL2(prepareRequest())
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('CS_INTERNAL')
    expect(JSON.stringify(r.error.details?.['issues'])).toMatch(/signing_input/)
  })

  it('URL-encodes the checkout JWT on the diagnostic route', async () => {
    const { client, fetchImpl } = makeClient({
      status: 200,
      body: { valid: true, reason: 'ok', checked_at: 1_790_000_000 },
    })
    const r = await client.verifyCheckoutJwt('a.b.c~d~e')
    expect(r.ok).toBe(true)
    const url = (fetchImpl.calls[0] as RecordedCall).url
    expect(url).toBe(`${BASE_URL}/v1/checkout-jwt/verify?checkout_jwt=a.b.c~d~e`)
    // The JWT is a query parameter, so it must never reach the log as a bare path.
    expect((fetchImpl.calls[0] as RecordedCall).method).toBe('GET')
  })

  it('rejects an empty checkout JWT without a round trip', async () => {
    const { client, fetchImpl } = makeClient({ status: 200, body: {} })
    const r = await client.verifyCheckoutJwt('   ')
    expect(fetchImpl.calls).toHaveLength(0)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('CS_VALIDATION')
  })

  it('never sends a request body on a GET route', async () => {
    const { client, fetchImpl } = makeClient({
      status: 200,
      body: statusBodyFor('http://vi:8000/v1/status'),
    })
    await client.status()
    expect((fetchImpl.calls[0] as RecordedCall).body).toBeUndefined()
  })
})

describe('every route returns a parsed value', () => {
  it('covers all twelve methods against one responder', async () => {
    const bodies: Record<string, unknown> = {
      '/v1/keys/agent': {
        kid: 'agt_k_1',
        public_jwk: publicJwk(),
        enc_private_key_b64: 'Y2lwaGVy',
      },
      '/v1/keys/rotate': { new_kid: 'issuer-key-2', role: 'ISSUER', retired_kid: 'issuer-key-1' },
      '/v1/jwks': { keys: [{ kid: 'issuer-key-1', role: 'ISSUER', status: 'ACTIVE' }] },
      '/v1/l1/issue': l1Response(),
      '/v1/l2/prepare': prepareResponse(),
      '/v1/l2/finalize': {
        l2: 'a.b.c~d~',
        iat: 1_790_000_000,
        exp: 1_790_086_400,
        agent_kid: 'agt_k_1',
      },
      '/v1/checkout-jwt': {
        checkout_jwt: 'a.b.c',
        checkout_hash: 'h',
        exp: 1,
        total_minor: 13_300,
        currency: 'USD',
        kid: 'm1',
      },
      '/v1/l3/create': {
        l3a: 'a.b.c',
        l3b: 'd.e.f',
        jti: 'j'.repeat(43),
        iat: 1,
        exp: 2,
        checkout_hash: 'h',
        payment_presentation: 'a.b.c~d~e~',
        checkout_presentation: 'a.b.c~f~g~',
      },
      '/v1/verify': verifyResponse(),
      '/v1/public/verify': { ...verifyResponse(), bundle_hash: 'b'.repeat(43) },
      '/v1/status': statusResponseBody(),
      '/v1/checkout-jwt/verify': { valid: true, reason: 'ok', checked_at: 1 },
    }
    const responder = (call: RecordedCall): FakeResponseSpec => {
      const path = call.url.replace(BASE_URL, '').split('?')[0] as string
      return { status: 200, body: bodies[path] }
    }
    const { client } = makeClient(responder)

    expect((await client.mintAgentKey({ agent_id: 'a' })).ok).toBe(true)
    expect((await client.rotateKey({ role: 'ISSUER' })).ok).toBe(true)
    expect((await client.jwks()).ok).toBe(true)
    expect((await client.issueL1(l1Request())).ok).toBe(true)
    expect((await client.prepareL2(prepareRequest())).ok).toBe(true)
    expect((await client.finalizeL2({ prepare_id: 'prep_1', signature_b64url: 'AAAA' })).ok).toBe(
      true,
    )
    expect((await client.createCheckoutJwt(checkoutRequest())).ok).toBe(true)
    expect((await client.createL3(l3Request())).ok).toBe(true)
    expect((await client.verify({ l1: 'a.b.c~', l2: 'a.b.c~d~' })).ok).toBe(true)
    expect((await client.publicVerify({ bundle: { l1: 'a.b.c~', l2: 'a.b.c~d~' } })).ok).toBe(true)
    expect((await client.status()).ok).toBe(true)
    expect((await client.verifyCheckoutJwt('a.b.c')).ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe('normaliseBaseUrl', () => {
  it('strips trailing slashes so a joined path never doubles up', () => {
    expect(normaliseBaseUrl('http://vi:8000/')).toBe('http://vi:8000')
    expect(normaliseBaseUrl('http://vi:8000///')).toBe('http://vi:8000')
    expect(normaliseBaseUrl('http://vi:8000')).toBe('http://vi:8000')
  })
})

describe('jsonSafeBody', () => {
  it('converts bigint to a JSON-safe integer', () => {
    expect(jsonSafeBody({ amount_minor: 13_000n })).toEqual({ amount_minor: 13_000 })
    expect(JSON.stringify(jsonSafeBody({ a: [1n, { b: 2n }] }))).toBe('{"a":[1,{"b":2}]}')
  })

  it('leaves undefined alone so JSON.stringify can drop an absent optional field', () => {
    expect(jsonSafeBody({ a: 1, b: undefined })).toEqual({ a: 1, b: undefined })
  })

  it('passes strings, booleans and null through untouched', () => {
    expect(jsonSafeBody({ a: 'x', b: true, c: null })).toEqual({ a: 'x', b: true, c: null })
  })

  it('refuses a bigint beyond the safe range rather than sending a precision-lost amount', () => {
    // `JSON.stringify` would happily emit 9007199254740993 as 9007199254740992. Refusing is the only
    // honest answer: the amount on the wire would be a different amount.
    expect(() => jsonSafeBody({ amount_minor: BigInt(Number.MAX_SAFE_INTEGER) + 2n })).toThrow(
      /safe integer/,
    )
    try {
      jsonSafeBody({ payment: { amount_minor: BigInt(Number.MAX_SAFE_INTEGER) + 2n } })
    } catch (e) {
      expect((e as Error).message).toContain('$.payment.amount_minor')
    }
  })
})

// --- request fixtures ------------------------------------------------------------------------------

function l1Request() {
  return {
    user_id: 'usr_test_user',
    wallet: { payer_id: 'PAYER123', payer_email: 'b@c.test', payment_token_id: 'tok' },
    device_public_jwk: publicJwk(),
  }
}

/**
 * Annotated with `L2PrepareRequest` rather than left to inference: the constraint arrays are a
 * discriminated union, so an inferred `type: string` would widen and stop the literal tags being checked
 * at all. The annotation makes the compiler verify that this payload names real registered constraint types.
 */
function prepareRequest(): L2PrepareRequest {
  return {
    l1: 'eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJ9.sig~',
    device_kid: 'dev_key_test_1',
    agent_public_jwk: publicJwk(),
    agent_kid: 'agt_k_1',
    merchants: [MERCHANT],
    acceptable_items: [ITEM],
    payment_instrument: {
      type: 'paypal_vault',
      id: 'card-id-hash',
      description: 'PayPal ···· 1234',
    },
    nonce: 'nonce-test-1',
    aud: 'https://agent.countersign.test',
    payment_constraints: [
      { type: 'mandate.payment.amount_range', currency: 'USD', min: 0, max: 20_000 },
      { type: 'mandate.payment.budget', currency: 'USD', max: 20_000 },
    ],
    checkout_constraints: [{ type: 'mandate.checkout.allowed_merchants', allowed: [MERCHANT] }],
  }
}

function checkoutRequest() {
  return {
    merchant: MERCHANT,
    lines: [{ sku: ITEM.id, title: ITEM.title, qty: 1, unit_minor: 13_000 }],
    currency: 'USD' as const,
  }
}

function l3Request() {
  return {
    agent_kid: 'agt_k_1',
    enc_private_key_b64: 'Y2lwaGVy',
    l2: 'eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJ9.sig~d~e~',
    checkout_jwt: 'eyJhbGciOiJFUzI1NiJ9.eyJhIjoxfQ.sig',
    payment: { amount_minor: 13_300, currency: 'USD' as const, payee_id: 'mrc_northwind' },
    aud: 'https://network.countersign.test',
    nonce: 'nonce-test-1',
    agent_id: 'agt_test_agent',
  }
}
