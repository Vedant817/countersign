/**
 * PayPal error → `CsErrorCode` mapping — spec §8.6 "Error mapping", §8.1 registry, [B12] [B15] [B16].
 *
 * Every code asserted here must exist in `CS_ERROR_CODES` in `@countersign/core`; the registry is the
 * one place an error code is defined (AGENTS.md engineering rule 2), so a code that is not there
 * would break every consumer that switches on it.
 */
import { describe, expect, it } from 'vitest'

import { isCsErrorCode } from '@countersign/core'

import {
  NAME_TO_CODE,
  extractDebugId,
  firstIssue,
  headerValue,
  isAmbiguousStatus,
  issueTokens,
  mapPayPalError,
  networkError,
  paypalName,
} from '../src/errors'
import { oauthErrorResponse, unauthorizedResponse } from './fixtures/transport-double'

const base = { method: 'POST', path: '/v2/checkout/orders' } as const

describe('the mapping table (§8.6)', () => {
  it('maps the five names the spec names explicitly', () => {
    expect(NAME_TO_CODE['UNPROCESSABLE_ENTITY']).toBe('PP_UNPROCESSABLE')
    expect(NAME_TO_CODE['INSTRUMENT_DECLINED']).toBe('PP_INSTRUMENT_DECLINED')
    expect(NAME_TO_CODE['PAYER_ACTION_REQUIRED']).toBe('PP_PAYER_ACTION_REQUIRED')
    expect(NAME_TO_CODE['AUTHORIZATION_EXPIRED']).toBe('PP_AUTH_EXPIRED')
    expect(NAME_TO_CODE['RATE_LIMIT_REACHED']).toBe('PP_RATE_LIMITED')
  })

  it('only produces codes that exist in the core registry', () => {
    for (const [name, code] of Object.entries(NAME_TO_CODE)) {
      expect(isCsErrorCode(code), `${name} -> ${code}`).toBe(true)
    }
  })
})

describe('mapPayPalError', () => {
  it('UNPROCESSABLE_ENTITY → PP_UNPROCESSABLE and keeps the issue', () => {
    const e = mapPayPalError({
      ...base,
      status: 422,
      body: {
        name: 'UNPROCESSABLE_ENTITY',
        message: 'The requested action could not be performed.',
        debug_id: 'DEBUG-1',
        // An issue with no more specific mapping: the generic name decides, and the issue is kept.
        details: [{ issue: 'INVALID_PARAMETER_VALUE', description: 'Amount is required' }],
      },
    })
    expect(e.code).toBe('PP_UNPROCESSABLE')
    expect(e.details?.['issue']).toBe('INVALID_PARAMETER_VALUE')
    expect(e.retryable).toBe(false)
    expect(e.details?.['paypal_debug_id']).toBe('DEBUG-1')
  })

  it('prefers a specific issue over the generic name', () => {
    // This is the shape PayPal actually returns on a declined card: the name is generic and the
    // actionable signal is in details[].issue. Mapping on `name` alone would report every decline as
    // PP_UNPROCESSABLE and the "PayPal needs you to approve something" branch would never fire.
    const e = mapPayPalError({
      ...base,
      status: 422,
      body: {
        name: 'UNPROCESSABLE_ENTITY',
        details: [{ issue: 'INSTRUMENT_DECLINED' }],
      },
    })
    expect(e.code).toBe('PP_INSTRUMENT_DECLINED')
    expect(e.details?.['matched_token']).toBe('INSTRUMENT_DECLINED')
  })

  it('PAYER_ACTION_REQUIRED → PP_PAYER_ACTION_REQUIRED', () => {
    const e = mapPayPalError({ ...base, status: 422, body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'PAYER_ACTION_REQUIRED' }] } })
    expect(e.code).toBe('PP_PAYER_ACTION_REQUIRED')
    // The Gate branches on this to tell the buyer PayPal needs an approval click.
    expect(e.userMessage).toBe('PayPal needs you to approve something before this can complete.')
  })

  it('AUTHORIZATION_EXPIRED → PP_AUTH_EXPIRED (spec EC-TIME-5)', () => {
    const e = mapPayPalError({
      method: 'POST',
      path: '/v2/payments/authorizations/8AB/capture',
      status: 422,
      body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'AUTHORIZATION_EXPIRED' }] },
    })
    expect(e.code).toBe('PP_AUTH_EXPIRED')
  })

  it('RATE_LIMIT_REACHED / 429 → PP_RATE_LIMITED, retryable', () => {
    const e = mapPayPalError({ ...base, status: 429, body: { name: 'RATE_LIMIT_REACHED' }, retryAfterHeader: '2' })
    expect(e.code).toBe('PP_RATE_LIMITED')
    expect(e.retryable).toBe(true)
    expect(e.details?.['ambiguous']).toBe(true)
    // Kept verbatim for the retry loop; the header is PayPal's own instruction, not our guess.
    expect(e.details?.['retry_after']).toBe('2')
  })

  it('401 → PP_AUTH, not retryable (the client decides to refresh instead)', () => {
    const e = mapPayPalError({ ...base, status: 401, body: { name: 'AUTHENTICATION_FAILURE' } })
    expect(e.code).toBe('PP_AUTH')
    expect(e.retryable).toBe(false)
    expect(e.details?.['status']).toBe(401)
  })

  it('5xx → PP_UNAVAILABLE, retryable, and flagged ambiguous', () => {
    for (const status of [500, 502, 503]) {
      const e = mapPayPalError({ ...base, status })
      expect(e.code).toBe('PP_UNAVAILABLE')
      expect(e.retryable).toBe(true)
      expect(e.details?.['ambiguous']).toBe(true)
    }
  })

  it('404 / RESOURCE_NOT_FOUND → PP_NOT_FOUND', () => {
    expect(mapPayPalError({ ...base, status: 404, body: { name: 'RESOURCE_NOT_FOUND' } }).code).toBe('PP_NOT_FOUND')
    // A 404 with no body at all still lands on the right code from the status.
    expect(mapPayPalError({ ...base, status: 404 }).code).toBe('PP_NOT_FOUND')
  })

  it('403 → CS_FORBIDDEN, not a PP code: our credentials lack the capability', () => {
    expect(mapPayPalError({ ...base, status: 403, body: { name: 'PERMISSION_DENIED' } }).code).toBe('CS_FORBIDDEN')
  })

  it('DUPLICATE_INVOICE_ID → PP_DUPLICATE', () => {
    const e = mapPayPalError({ ...base, status: 400, body: { name: 'DUPLICATE_INVOICE_ID' } })
    expect(e.code).toBe('PP_DUPLICATE')
  })

  it('falls back to the status for an unmapped name and records it, rather than guessing', () => {
    const e = mapPayPalError({ ...base, status: 400, body: { name: 'SOMETHING_NEW_IN_2027' } })
    expect(e.code).toBe('PP_UNPROCESSABLE')
    // The unknown name is surfaced so a PayPal addition shows up in a log instead of vanishing.
    expect(e.details?.['unmapped_name']).toBe('SOMETHING_NEW_IN_2027')
  })

  it('reads the OAuth error shape (error / error_description, not name / message)', () => {
    const e = mapPayPalError({
      method: 'POST',
      path: '/v1/oauth2/token',
      status: 401,
      body: { error: 'invalid_client', error_description: 'Client Authentication failed' },
    })
    expect(e.code).toBe('PP_AUTH')
    expect(e.message).toContain('Client Authentication failed')
    expect(paypalName({ error: 'invalid_client' })).toBe('invalid_client')
  })

  it('maps OAuth invalid_request to PP_UNPROCESSABLE', () => {
    const e = mapPayPalError({
      method: 'POST',
      path: '/v1/oauth2/token',
      status: 400,
      body: { error: 'invalid_request', error_description: 'Missing grant_type' },
    })
    expect(e.code).toBe('PP_UNPROCESSABLE')
  })

  it('tolerates an HTML body from the edge instead of crashing', () => {
    // PayPal's edge sometimes answers with an HTML error page. The mapping must still be usable.
    const e = mapPayPalError({ ...base, status: 503, body: undefined })
    expect(e.code).toBe('PP_UNAVAILABLE')
    expect(e.retryable).toBe(true)
  })

  it('never leaks a body value into the userMessage', () => {
    const e = mapPayPalError({
      ...base,
      status: 422,
      body: { name: 'UNPROCESSABLE_ENTITY', message: 'card 4111111111111111 declined for buyer@example.com', details: [] },
    })
    expect(e.userMessage).not.toContain('4111')
    expect(e.userMessage).not.toContain('example.com')
  })
})

describe('isAmbiguousStatus', () => {
  it('is true exactly for the failures where we cannot tell whether PayPal executed the call', () => {
    expect(isAmbiguousStatus(408)).toBe(true)
    expect(isAmbiguousStatus(429)).toBe(true)
    expect(isAmbiguousStatus(500)).toBe(true)
    expect(isAmbiguousStatus(503)).toBe(true)
    expect(isAmbiguousStatus(400)).toBe(false)
    expect(isAmbiguousStatus(422)).toBe(false)
    expect(isAmbiguousStatus(200)).toBe(false)
  })
})

describe('networkError', () => {
  it('is always PP_UNAVAILABLE, retryable and ambiguous', () => {
    const e = networkError({
      method: 'POST',
      path: '/v2/checkout/orders',
      cause: new TypeError('fetch failed'),
      requestId: 'cs:att_1:create',
      timedOut: true,
    })
    expect(e.code).toBe('PP_UNAVAILABLE')
    expect(e.retryable).toBe(true)
    expect(e.details?.['ambiguous']).toBe(true)
    expect(e.details?.['timed_out']).toBe(true)
    expect(e.message).toContain('timeout')
  })

  it('keeps the cause for logs', () => {
    const cause = new Error('ECONNRESET')
    const e = networkError({ method: 'GET', path: '/v2/checkout/orders/x', cause })
    expect(e.cause).toBe(cause)
  })
})

describe('header helpers', () => {
  it('reads a Headers object', () => {
    const h = new Headers({ 'PayPal-Debug-Id': 'DEBUG-X' })
    expect(extractDebugId(h)).toBe('DEBUG-X')
  })

  it('reads a plain object case-insensitively', () => {
    // A hand-written fake often spells it differently; case-insensitivity keeps the "always log
    // paypal-debug-id" requirement from quietly evaporating.
    expect(extractDebugId({ 'PayPal-Debug-Id': 'DEBUG-Y' })).toBe('DEBUG-Y')
    expect(extractDebugId({ 'PAYPAL-DEBUG-ID': 'DEBUG-Z' })).toBe('DEBUG-Z')
  })

  it('reads the first value of a repeated header', () => {
    expect(headerValue({ 'retry-after': ['3', '9'] }, 'Retry-After')).toBe('3')
  })

  it('returns undefined for a missing header bag or missing key', () => {
    expect(extractDebugId(undefined)).toBeUndefined()
    expect(headerValue({}, 'retry-after')).toBeUndefined()
  })
})

describe('body helpers', () => {
  it('lists issue tokens from both `issue` and `issue_type`, de-duplicated', () => {
    const body = {
      name: 'UNPROCESSABLE_ENTITY',
      details: [{ issue: 'A' }, { issue: 'A' }, { issue_type: 'B' }, {}],
    }
    expect(issueTokens(body)).toEqual(['A', 'B'])
  })

  it('takes the first detail as the issue the spec asks us to keep', () => {
    expect(firstIssue({ details: [{ issue: 'FIRST' }, { issue: 'SECOND' }] })?.issue).toBe('FIRST')
    expect(firstIssue(undefined)).toBeUndefined()
  })
})

describe('the fake error bodies in the fixtures match these shapes', () => {
  it('the 401 fixture carries no `details`, so the status alone must decide', () => {
    const spec = unauthorizedResponse()
    const e = mapPayPalError({
      ...base,
      status: spec.status ?? 401,
      body: spec.body as Record<string, never>,
    })
    expect(e.code).toBe('PP_AUTH')
  })

  it('the OAuth fixture round-trips through the mapper', () => {
    const spec = oauthErrorResponse('invalid_client', 'Client Authentication failed')
    const e = mapPayPalError({
      method: 'POST',
      path: '/v1/oauth2/token',
      status: spec.status ?? 401,
      body: spec.body as Record<string, never>,
    })
    expect(e.code).toBe('PP_AUTH')
  })
})