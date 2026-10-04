/**
 * Deterministic `PayPal-Request-Id` formats — spec §8.6 "Request IDs", [B14], EC-IDEM-2, spec U5.
 *
 * These are wire-visible strings. A test that pins their exact shape is what stops a well-meaning
 * "let me add a timestamp for uniqueness" from silently breaking every retry.
 */
import { describe, expect, it } from 'vitest'

import { newId } from '@countersign/core'
import type { AttemptId, DisputeId, RefundRowId, ShipmentId } from '@countersign/core'

import {
  DISPUTE_ACTIONS,
  PAYPAL_DOCUMENTED_REQUEST_ID_MAX_CHARS,
  PAYPAL_OPENAPI_REQUEST_ID_MAX_CHARS,
  REQUEST_ID_MAX_CHARS,
  REQUEST_ID_PREFIX,
  captureRequestId,
  disputeActionRequestId,
  isOurPrefixedId,
  measureRequestId,
  observedRequestIdLengths,
  orderCreateRequestId,
  refundRequestId,
  validateRequestId,
} from '../src/idempotency'

// Minted by core rather than typed by hand: the 26-char Crockford body is easy to get wrong, and a
// hand-written id that our own ULID rules reject would make these tests prove nothing.
const AT = 1_760_000_000_000
const attemptId = newId('att', AT) as AttemptId
const shipmentId = newId('shp', AT) as ShipmentId
const otherShipmentId = newId('shp', AT + 1) as ShipmentId
const refundId = newId('ref', AT) as RefundRowId
const disputeId = newId('dsp', AT) as DisputeId
const paypalAuthId = '8AB12345AB6789123'

describe('the four formats from §8.6', () => {
  it('cs:{attemptId}:create', () => {
    expect(orderCreateRequestId(attemptId)).toBe(`cs:${attemptId}:create`)
  })

  it('cs:{authId}:cap:{shipmentId}', () => {
    expect(captureRequestId(paypalAuthId, shipmentId)).toBe(`cs:${paypalAuthId}:cap:${shipmentId}`)
  })

  it('cs:{captureId}:ref:{refundId}', () => {
    expect(refundRequestId('3C679366HH908993F', refundId)).toBe(
      `cs:3C679366HH908993F:ref:${refundId}`,
    )
  })

  it('cs:{disputeId}:{action}:{packetVersion}', () => {
    expect(disputeActionRequestId(disputeId, 'file', 2)).toBe(`cs:${disputeId}:file:2`)
    expect(disputeActionRequestId(disputeId, 'offer', 3)).toBe(`cs:${disputeId}:offer:3`)
  })

  it('namespaces everything under `cs:` so a PayPal-side log is greppable', () => {
    expect(REQUEST_ID_PREFIX).toBe('cs:')
    for (const id of [
      orderCreateRequestId(attemptId),
      captureRequestId(paypalAuthId, shipmentId),
      refundRequestId('3C679366HH908993F', refundId),
      disputeActionRequestId(disputeId, 'file', 1),
    ]) {
      expect(id.startsWith('cs:')).toBe(true)
    }
  })
})

describe('determinism', () => {
  it('the same inputs always produce the same id — that is the whole mechanism', () => {
    // EC-IDEM-2: a retry of a timed-out create must be deduplicated against the first attempt.
    expect(orderCreateRequestId(attemptId)).toBe(orderCreateRequestId(attemptId))
    expect(captureRequestId(paypalAuthId, shipmentId)).toBe(
      captureRequestId(paypalAuthId, shipmentId),
    )
    expect(refundRequestId('3C679366HH908993F', refundId)).toBe(
      refundRequestId('3C679366HH908993F', refundId),
    )
    expect(disputeActionRequestId(disputeId, 'file', 2)).toBe(
      disputeActionRequestId(disputeId, 'file', 2),
    )
  })

  it('different inputs produce different ids, so payments never collide', () => {
    const ids = new Set([
      orderCreateRequestId(attemptId),
      orderCreateRequestId(newId('att', AT + 1) as AttemptId),
      captureRequestId(paypalAuthId, shipmentId),
      captureRequestId('1AB12345AB6789123', shipmentId),
      captureRequestId(paypalAuthId, otherShipmentId),
      refundRequestId('3C679366HH908993F', refundId),
      refundRequestId('3C679366HH908993G', refundId),
      disputeActionRequestId(disputeId, 'file', 1),
      disputeActionRequestId(disputeId, 'file', 2),
    ])
    expect(ids.size).toBe(9)
  })

  it('a new packet version is a new id; the same version is the same id', () => {
    // §8.15/§8.16: re-filing v2 must not be deduplicated against v1, and re-sending v2 after a timeout
    // must be.
    expect(disputeActionRequestId(disputeId, 'file', 2)).not.toBe(
      disputeActionRequestId(disputeId, 'file', 1),
    )
    expect(disputeActionRequestId(disputeId, 'file', 2)).toBe(
      disputeActionRequestId(disputeId, 'file', 2),
    )
  })

  it('accepts a string packet version as well as a number', () => {
    expect(disputeActionRequestId(disputeId, 'appeal', 'v3')).toBe(`cs:${disputeId}:appeal:v3`)
  })

  it('rejects a packet version that is not a safe id token', () => {
    expect(() => disputeActionRequestId(disputeId, 'file', 'has space')).toThrow()
    expect(() => disputeActionRequestId(disputeId, 'file', -1)).toThrow()
    expect(() => disputeActionRequestId(disputeId, 'file', 1.5)).toThrow()
    expect(() => disputeActionRequestId(disputeId, 'file', '')).toThrow()
  })
})

describe('DISPUTE_ACTIONS', () => {
  it('covers one token per dispute method, including the `file` the spec names', () => {
    // §8.15 filing guards: "Idempotency key cs:{disputeId}:file:{version}".
    expect(DISPUTE_ACTIONS).toContain('file')
    expect([...DISPUTE_ACTIONS].sort()).toEqual(
      ['appeal', 'claim', 'escalate', 'file', 'msg', 'offer', 'return', 'support'].sort(),
    )
  })

  it('is a closed set: an unknown action is a type error before it is a wire change', () => {
    // @ts-expect-error 'nope' is not a DisputeActionToken.
    expect(() => disputeActionRequestId(disputeId, 'nope', 1)).toThrow()
  })
})

describe('validateRequestId', () => {
  it('accepts every generated format', () => {
    for (const id of Object.values(observedRequestIdLengths())) {
      const result = validateRequestId(id.value)
      expect(result.ok).toBe(true)
    }
  })

  it('refuses anything that is not a header-safe token', () => {
    for (const bad of [
      '',
      'has space',
      'has\ttab',
      'has\nnewline',
      'quote"me',
      'comma,separated',
      'semi;colon',
      'emoji😀',
      'slash/es',
      'brace{}',
    ]) {
      const result = validateRequestId(bad)
      expect(result.ok, `expected ${JSON.stringify(bad)} to be refused`).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('CS_VALIDATION')
    }
  })

  it('refuses a non-string', () => {
    for (const bad of [undefined, null, 42, {}, ['cs:x']]) {
      const result = validateRequestId(bad)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('CS_VALIDATION')
    }
  })

  it('refuses an id over our length budget', () => {
    const tooLong = `cs:${'0'.repeat(REQUEST_ID_MAX_CHARS)}`
    const result = validateRequestId(tooLong)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.details?.['budget']).toBe(REQUEST_ID_MAX_CHARS)
  })

  it('never mentions a PayPal limit it has not measured (spec U5)', () => {
    // The budget is ours; the message must not imply it came from PayPal's documentation.
    const tooLong = `cs:${'0'.repeat(REQUEST_ID_MAX_CHARS)}`
    const result = validateRequestId(tooLong)
    if (result.ok) throw new Error('expected refusal')
    expect(result.error.message).toContain('UNVERIFIED')
    expect(result.error.message).toContain('IDEMPOTENCY.md')
  })
})

describe('measureRequestId / observedRequestIdLengths', () => {
  it('measures the real formats rather than assuming a maximum (spec U5 evidence)', () => {
    const report = observedRequestIdLengths()
    const lengths = Object.values(report).map((r) => r.length)
    expect(lengths.length).toBeGreaterThanOrEqual(4)
    for (const r of Object.values(report)) expect(r.withinBudget).toBe(true)
    // The longest of the four formats, measured from the formats themselves.
    expect(Math.max(...lengths)).toBeLessThanOrEqual(REQUEST_ID_MAX_CHARS)
    // Sanity: `cs:` + 30-char id + `:create` = 40.
    expect(report['cs:{attemptId}:create']?.length).toBe(3 + 30 + 7)
  })

  it('a PayPal dispute id is usable in the dispute slot too', () => {
    // The sandbox simulator and the API both use ids like `PP-D-2781XXXX`, which contain a hyphen.
    const result = measureRequestId(
      disputeActionRequestId('PP-D-2781AB12CD34' as DisputeId, 'file', 1),
    )
    expect(result.ok).toBe(true)
  })

  it("records that PayPal's two length figures contradict each other", () => {
    // Report §32/#21: the OpenAPI declares `maxLength: 10000` while the idempotency prose recommends
    // a UUID "because it meets the 38 single-byte character limit". Both are kept as named values so
    // the C-probe has something to measure against; neither is enforced.
    expect(PAYPAL_DOCUMENTED_REQUEST_ID_MAX_CHARS).toBe(38)
    expect(PAYPAL_OPENAPI_REQUEST_ID_MAX_CHARS).toBe(10_000)
    expect(REQUEST_ID_MAX_CHARS).toBe(255)
  })

  it('flags captureRequestId as the format that breaks first if the 38-character limit is real', () => {
    // Our worst case is 55, so the budget of 255 does not protect us against the prose figure. The
    // capture format is the one to look at: its 17-char `authId` slot is PayPal's own and is not
    // compressible the way our ULID slots are.
    const report = observedRequestIdLengths()
    const capture = report['cs:{authId}:cap:{shipmentId}']
    expect(capture?.length).toBe(55)
    expect(capture?.length ?? 0).toBeGreaterThan(PAYPAL_DOCUMENTED_REQUEST_ID_MAX_CHARS)
    // It is tied with the refund format for longest, and in fact **four of the five** measured formats
    // exceed PayPal's prose figure — the only one that fits is the short PayPal-dispute-id form. That
    // is the size of the exposure, stated as a number.
    const longest = Math.max(...Object.values(report).map((r) => r.length))
    expect(longest).toBe(55)
    expect(
      Object.values(report).filter((r) => r.length > PAYPAL_DOCUMENTED_REQUEST_ID_MAX_CHARS),
    ).toHaveLength(4)
    expect(report['cs:{paypalDisputeId}:file:1']?.length).toBeLessThanOrEqual(
      PAYPAL_DOCUMENTED_REQUEST_ID_MAX_CHARS,
    )
    // Still inside our own budget, which is why nothing is rejected today.
    expect(capture?.withinBudget).toBe(true)
  })
})

describe('isOurPrefixedId', () => {
  it('recognises our prefixed ULIDs and rejects PayPal ids', () => {
    expect(isOurPrefixedId(attemptId)).toBe(true)
    expect(isOurPrefixedId(newId('cap', AT))).toBe(true)
    expect(isOurPrefixedId(paypalAuthId)).toBe(false)
    expect(isOurPrefixedId('PP-D-2781AB12CD34')).toBe(false)
  })

  it('rejects a body containing a character the ULID alphabet excludes (I, L, O, U)', () => {
    // Crockford base32 has no I/L/O/U, so `newId` can never produce one. An id carrying one did not
    // come from us, which is exactly what this helper is for telling.
    const body = attemptId.slice(4)
    expect(isOurPrefixedId(`att_${'L'.repeat(26)}`)).toBe(false)
    expect(isOurPrefixedId(`att_${body.slice(0, 25)}L`)).toBe(false)
    expect(isOurPrefixedId(`att_${body.slice(0, 25)}I`)).toBe(false)
  })

  it('rejects a body that is the wrong length', () => {
    expect(isOurPrefixedId(`att_${attemptId.slice(4, 29)}`)).toBe(false)
    expect(isOurPrefixedId(`att_${attemptId.slice(4)}8`)).toBe(false)
  })
})
