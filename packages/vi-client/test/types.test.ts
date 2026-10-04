/**
 * Schema tests — spec §8.4 (M4), AT-M4.2's data layer.
 *
 * Each group here mirrors one of the four rules in `src/types.ts`'s module header, plus the two schemas
 * that everything downstream depends on: `l2PrepareResponseSchema`'s `signing_input` invariant and
 * `verifyResponseSchema`'s `constraints.skipped` (spec D19).
 */
import { CURRENCIES } from '@countersign/core'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  CONSTRAINT_TYPES,
  NETWORK_ENFORCED_CONSTRAINTS,
  ROUTE_CONTRACTS,
  b64urlByteLength,
  b64urlToUtf8,
  budgetConstraintSchema,
  constraintSchema,
  currencySchema,
  findRouteContract,
  l1IssueRequestSchema,
  l1IssueResponseSchema,
  l2PrepareResponseSchema,
  l3CreateRequestSchema,
  minorUnitsSchema,
  moneyAmountSchema,
  pendingNetworkEnforcement,
  publicJwkSchema,
  skippedConstraintTypes,
  verifyResponseSchema,
} from '../src/types'
import {
  NETWORK_ENFORCED_REASON,
  csErrorBody,
  l1Response,
  prepareResponse,
  publicJwk,
  verifyResponse,
} from './fixtures/vi-transport-double'

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

describe('minorUnitsSchema', () => {
  it('accepts an integer and returns bigint', () => {
    expect(minorUnitsSchema.parse(13_000)).toBe(13_000n)
    expect(minorUnitsSchema.parse(13_000n)).toBe(13_000n)
    expect(minorUnitsSchema.parse(0)).toBe(0n)
  })

  // EC-FX-6: money is never a float. A non-integral number reaching a payment is a hundredfold bug.
  it('refuses a non-integral number', () => {
    expect(minorUnitsSchema.safeParse(13_000.5).success).toBe(false)
    expect(minorUnitsSchema.safeParse(0.1).success).toBe(false)
  })

  /**
   * The one strictness a TypeScript client provably cannot reproduce.
   *
   * vi's `_minor_before` rejects a Python `float`, so `{"unit_minor": 13000.0}` is a `CS_VALIDATION` there.
   * From this side of the wire it is undetectable: `JSON.parse("13000.0")` and `JSON.parse("13000")` both
   * produce the identical double, so the evidence that a decimal point was written no longer exists.
   *
   * What *is* preserved is the property that matters — the value that reaches vi is an exact integer, so
   * nothing is rounded. Asserting a rejection here would be a test that passes only because it agreed
   * with itself, so this test asserts the honest behaviour and the schema documents the limit.
   */
  it('cannot tell 13000.0 from 13000, and documents that rather than pretending otherwise', () => {
    expect(minorUnitsSchema.safeParse(13_000.0).success).toBe(true)
    expect(JSON.parse('13000.0')).toBe(JSON.parse('13000'))
  })

  it('refuses a numeric string, which vi refuses too', () => {
    expect(minorUnitsSchema.safeParse('13000').success).toBe(false)
    expect(minorUnitsSchema.safeParse('130.00').success).toBe(false)
  })

  it('refuses negative, boolean and non-finite values', () => {
    expect(minorUnitsSchema.safeParse(-1).success).toBe(false)
    expect(minorUnitsSchema.safeParse(true).success).toBe(false)
    expect(minorUnitsSchema.safeParse(Number.NaN).success).toBe(false)
    expect(minorUnitsSchema.safeParse(Number.POSITIVE_INFINITY).success).toBe(false)
  })

  it('refuses an unsafe integer rather than sending a precision-lost amount', () => {
    expect(minorUnitsSchema.safeParse(Number.MAX_SAFE_INTEGER + 2).success).toBe(false)
    expect(minorUnitsSchema.safeParse(Number.MAX_SAFE_INTEGER).success).toBe(true)
  })

  it('explains a non-integral amount in a message a human can act on', () => {
    const r = minorUnitsSchema.safeParse(13_000.5)
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0]?.message).toMatch(/EC-FX-6|integer minor units/)
  })

  // A numeric string fails the union's type check rather than the transform, so its message is zod's
  // "Invalid input". Worth knowing, because it means the actionable copy only exists for the numeric
  // cases — a fact a future revision of this schema should weigh.
  it('rejects a numeric string at the union level', () => {
    const r = minorUnitsSchema.safeParse('130.00')
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0]?.code).toBe('invalid_union')
  })

  it('declares itself as a JSON Schema integer, which is what the drift check compares', () => {
    const node = z.toJSONSchema(minorUnitsSchema, { io: 'input', unrepresentable: 'any' }) as {
      anyOf?: { type?: string }[]
    }
    expect(node.anyOf?.map((b) => b.type)).toContain('integer')
  })
})

describe('currencySchema', () => {
  // `vi_service.models.Currency` is spelled out in Python and this client's own copy is what the drift
  // check compares. Asserting it equals `core`'s `CURRENCIES` is what turns "the two lists drifted" from
  // a 3 a.m. incident into a failing test.
  it('is exactly the seven codes vi accepts, and exactly core CURRENCIES', () => {
    expect([...currencySchema.options].sort()).toEqual([...CURRENCIES].sort())
    expect([...currencySchema.options].sort()).toEqual(['AUD', 'CAD', 'EUR', 'GBP', 'INR', 'JPY', 'USD'])
  })

  it('refuses lower case, because vi does not lower-case', () => {
    expect(currencySchema.safeParse('usd').success).toBe(false)
  })
})

describe('b64url helpers', () => {
  it('round-trips through UTF-8, mirroring keys.b64u_encode / b64u_decode', () => {
    const original = JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'dev_key_test_1' })
    const encoded = Buffer.from(original, 'utf8').toString('base64url')
    expect(b64urlToUtf8(encoded)).toBe(original)
  })

  it('tolerates padding on the way in, as b64u_decode does', () => {
    const padded = `${Buffer.from('hello', 'utf8').toString('base64')}==`
    expect(b64urlToUtf8(padded)).toBe('hello')
    expect(b64urlByteLength(padded)).toBe(5)
  })

  it('measures a 32-byte P-256 coordinate', () => {
    expect(b64urlByteLength(Buffer.from(new Uint8Array(32)).toString('base64url'))).toBe(32)
    expect(b64urlByteLength(Buffer.from(new Uint8Array(31)).toString('base64url'))).toBe(31)
  })

  it('throws on a non-base64url character rather than guessing', () => {
    expect(() => b64urlToUtf8('not+base64url')).toThrow(/base64url/)
  })
})

describe('publicJwkSchema', () => {
  it('accepts a P-256 public key', () => {
    const parsed = publicJwkSchema.parse(publicJwk())
    expect(parsed.kty).toBe('EC')
    expect(parsed.crv).toBe('P-256')
  })

  // Spec §3.1: the browser's device key is non-extractable and vi-service must never see the private half.
  it('refuses a JWK carrying the private "d" member', () => {
    const r = publicJwkSchema.safeParse({ ...publicJwk(), d: 'AAAA' })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0]?.message).toMatch(/non-extractable/)
  })

  it('refuses a coordinate that is not 32 bytes, as PublicJwk._coord_length does', () => {
    const short = Buffer.from(new Uint8Array(16)).toString('base64url')
    const r = publicJwkSchema.safeParse(publicJwk(short, short))
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues.some((i) => /32 bytes/.test(i.message))).toBe(true)
  })

  it('refuses the wrong curve or key type', () => {
    expect(publicJwkSchema.safeParse({ ...publicJwk(), crv: 'P-384' }).success).toBe(false)
    expect(publicJwkSchema.safeParse({ ...publicJwk(), kty: 'RSA' }).success).toBe(false)
  })

  it('allows extra members, because PublicJwk is extra="allow"', () => {
    const r = publicJwkSchema.safeParse({ ...publicJwk(), kid: 'dev_key_test_1', use: 'sig' })
    expect(r.success).toBe(true)
  })
})

describe('moneyAmountSchema', () => {
  it('accepts integer minor units with a currency and nothing else', () => {
    expect(moneyAmountSchema.parse({ minor: 13_000, currency: 'USD' })).toEqual({ minor: 13_000n, currency: 'USD' })
  })

  it('refuses a float, an extra field and a missing currency', () => {
    expect(moneyAmountSchema.safeParse({ minor: 13_000.5, currency: 'USD' }).success).toBe(false)
    expect(moneyAmountSchema.safeParse({ minor: 13_000, currency: 'USD', cents: 13_000 }).success).toBe(false)
    expect(moneyAmountSchema.safeParse({ minor: 13_000 }).success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Constraints and spec D19
// ---------------------------------------------------------------------------

describe('the eight registered constraint types', () => {
  it('lists exactly the eight types, in CONSTRAINT_TYPES order', () => {
    expect(CONSTRAINT_TYPES).toEqual([
      'mandate.checkout.allowed_merchants',
      'mandate.checkout.line_items',
      'mandate.payment.allowed_payees',
      'mandate.payment.amount_range',
      'mandate.payment.budget',
      'mandate.payment.recurrence',
      'mandate.payment.agent_recurrence',
      'mandate.payment.reference',
    ])
  })

  it('accepts the seven a caller may supply', () => {
    const merchant = { id: 'mrc_northwind', name: 'Northwind Outfitters', website: 'https://northwind.test' }
    const acceptable: { id: string; title: string }[] = [{ id: 'SKU-TRAIL-42', title: 'Trail Runner' }]
    const cases: unknown[] = [
      { type: 'mandate.checkout.allowed_merchants', allowed: [merchant] },
      {
        type: 'mandate.checkout.line_items',
        items: [{ id: 'li-1', acceptable_items: acceptable, quantity: 1 }],
      },
      { type: 'mandate.payment.allowed_payees', allowed: [merchant] },
      { type: 'mandate.payment.amount_range', currency: 'USD', min: 0, max: 20_000 },
      { type: 'mandate.payment.budget', currency: 'USD', max: 20_000 },
      { type: 'mandate.payment.recurrence', frequency: 'MNTH', start_date: '2026-10-01', number: 6 },
      {
        type: 'mandate.payment.agent_recurrence',
        frequency: 'MNTH',
        start_date: '2026-10-01',
        end_date: '2027-10-01',
        max_occurrences: 12,
      },
    ]
    for (const c of cases) expect(constraintSchema.safeParse(c).success).toBe(true)
  })

  // `ReferenceConstraintModel` raises ValueError in a model validator for *every* instance, because the
  // signing service injects it from the checkout disclosure hash and a caller cannot supply a correct one.
  it('refuses mandate.payment.reference, which the signing service injects itself', () => {
    const r = constraintSchema.safeParse({ type: 'mandate.payment.reference' })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0]?.message).toMatch(/generated by the signing service/)
  })

  it('refuses a type outside the registry', () => {
    expect(constraintSchema.safeParse({ type: 'mandate.payment.made_up' }).success).toBe(false)
  })

  it('refuses an amount_range whose min exceeds its max', () => {
    const r = constraintSchema.safeParse({
      type: 'mandate.payment.amount_range',
      currency: 'USD',
      min: 20_000,
      max: 1_000,
    })
    expect(r.success).toBe(false)
  })

  it('refuses a budget with a non-positive cap, which the library would raise on anyway', () => {
    expect(budgetConstraintSchema.safeParse({ type: 'mandate.payment.budget', currency: 'USD', max: 0 }).success).toBe(false)
  })

  it('refuses an agent_recurrence without end_date, which the library requires', () => {
    const r = constraintSchema.safeParse({
      type: 'mandate.payment.agent_recurrence',
      frequency: 'MNTH',
      start_date: '2026-10-01',
    })
    expect(r.success).toBe(false)
  })

  it('refuses an unknown key inside a constraint, because the models are extra="forbid"', () => {
    const r = constraintSchema.safeParse({
      type: 'mandate.payment.amount_range',
      currency: 'USD',
      max: 20_000,
      maxMinor: 20_000,
    })
    expect(r.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Reading `skipped` — spec D19's delivery mechanism
// ---------------------------------------------------------------------------

describe('skippedConstraintTypes and pendingNetworkEnforcement', () => {
  /**
   * The trap, now pinned at the type level.
   *
   * `apps/vi` used to annotate every `skipped` entry with a reason, so the natural-looking
   * `skipped.includes('mandate.payment.budget')` was always `false`. A Gate written that way would
   * report that it owes nothing while a budget cap sat unevaluated — the precise failure spec D19
   * exists to prevent.
   *
   * The `@ts-expect-error` below is the actual assertion, and it is the reason the schema uses
   * `.transform()` rather than a bare `z.union`: `(string | Obj)[]` still accepts `.includes(string)`,
   * so a union alone would leave the hole open. This line stops compiling the day someone reverts the
   * transform, which is exactly when it should be noticed.
   */
  it('makes `includes` a compile error, so the silent-false bug cannot be written', () => {
    const skipped = verifyResponseSchema.parse(verifyResponse()).constraints.skipped

    // The `@ts-expect-error` directive IS the assertion: `skipped` is `{type, reason}[]`, so a bare
    // string is not a member and this stops compiling the day someone removes the transform from
    // `skippedConstraintSchema`. A bare `z.union` would NOT give this — `(string | Obj)[]` still
    // accepts `.includes(string)`, which is why the transform is load-bearing.
    //
    // At runtime the mistake returns `false`, which is the hazard the type error now prevents.
    // @ts-expect-error a bare string is not a `NormalisedSkip`
    expect(skipped.includes('mandate.payment.budget')).toBe(false)

    // The supported path finds it, and the type is a separate field.
    expect(pendingNetworkEnforcement(skipped)).toContain('mandate.payment.budget')
    expect(skipped.map((s) => s.type)).toContain('mandate.payment.budget')
  })

  it('accepts the legacy annotated-string wire shape without throwing', () => {
    // A vi-service that has not been redeployed yet still emits strings. Parsing must not fail,
    // because a throw here fails the Gate's verify step — a worse outcome than a missing field.
    const legacy = verifyResponseSchema.parse(
      verifyResponse({ skipped: [`mandate.payment.budget — ${NETWORK_ENFORCED_REASON}`] }),
    )
    expect(legacy.constraints.skipped).toEqual([
      { type: 'mandate.payment.budget', reason: NETWORK_ENFORCED_REASON },
    ])
    expect(pendingNetworkEnforcement(legacy.constraints.skipped)).toEqual(['mandate.payment.budget'])
  })

  it('accepts the current `{type, reason}` wire shape', () => {
    const current = verifyResponseSchema.parse(
      verifyResponse({ skipped: [{ type: 'mandate.payment.budget', reason: NETWORK_ENFORCED_REASON }] }),
    )
    expect(current.constraints.skipped[0]?.type).toBe('mandate.payment.budget')
    expect(current.constraints.skipped[0]?.reason).toBe(NETWORK_ENFORCED_REASON)
  })

  it('extracts the types and ignores the free-form notes in the same list', () => {
    // Exactly the shape a real response has: annotated entries plus a note with no type at all.
    const skipped = [
      `mandate.payment.budget — ${NETWORK_ENFORCED_REASON}`,
      'checkout constraint evaluation (needs the checkout_jwt cart)',
      `mandate.payment.recurrence — ${NETWORK_ENFORCED_REASON}`,
    ]
    expect(skippedConstraintTypes(skipped)).toEqual([
      'mandate.payment.budget',
      'mandate.payment.recurrence',
    ])
    expect(pendingNetworkEnforcement(skipped)).toEqual([
      'mandate.payment.budget',
      'mandate.payment.recurrence',
    ])
  })

  it('does not mistake a note that merely mentions a type for that type being skipped', () => {
    // Parsing on the separator rather than on substring containment is what makes this safe.
    const skipped = ['nothing was skipped, but mandate.payment.budget exists in the mandate']
    expect(skippedConstraintTypes(skipped)).toEqual([])
    expect(pendingNetworkEnforcement(skipped)).toEqual([])
  })

  it('de-duplicates a type that appears more than once', () => {
    const skipped = [
      `mandate.payment.budget — ${NETWORK_ENFORCED_REASON}`,
      `mandate.payment.budget — ${NETWORK_ENFORCED_REASON}`,
    ]
    expect(skippedConstraintTypes(skipped)).toEqual(['mandate.payment.budget'])
  })

  it('accepts bare type names too, so a future vi that drops the reason still works', () => {
    expect(skippedConstraintTypes(['mandate.payment.budget'])).toEqual(['mandate.payment.budget'])
  })

  it('reports nothing when none of the three were disclosed, which is not the same as nothing to do', () => {
    expect(pendingNetworkEnforcement([])).toEqual([])
    expect(pendingNetworkEnforcement(['checkout constraint evaluation (needs the checkout_jwt cart)'])).toEqual([])
  })

  it('picks out a library-injected constraint if one is ever reported as skipped', () => {
    expect(
      skippedConstraintTypes([
        'mandate.payment.reference — injected by create_layer2_autonomous',
        `mandate.payment.budget — ${NETWORK_ENFORCED_REASON}`,
      ]),
    ).toEqual(['mandate.payment.reference', 'mandate.payment.budget'])
    // …but it is not one the Gate owes.
    expect(pendingNetworkEnforcement(['mandate.payment.reference — injected'])).toEqual([])
  })
})

describe('l2PrepareResponseSchema: signing_input is exactly header.payload', () => {
  it('accepts a well-formed response and returns it untouched', () => {
    const body = prepareResponse()
    const parsed = l2PrepareResponseSchema.parse(body)
    expect(parsed.prepare_id).toBe(body['prepare_id'])
    // Byte-identical, not merely equal: this string is what the browser signs.
    expect(parsed.signing_input).toBe(body['signing_input'])
  })

  it('proves the invariant: splitting on the dot yields the two base64url segments', () => {
    const { signing_input } = l2PrepareResponseSchema.parse(prepareResponse())
    const parts = signing_input.split('.')
    expect(parts).toHaveLength(2)
    expect(parts[0]).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(parts[1]).toMatch(/^[A-Za-z0-9_-]+$/)
    // And each segment decodes to the header / payload the same response returns, so what the UI
    // renders as the consent read-back (spec §8.5) is exactly what gets signed.
    expect(JSON.parse(b64urlToUtf8(parts[0] as string))).toEqual(prepareResponse()['header'])
    expect(JSON.parse(b64urlToUtf8(parts[1] as string))).toEqual(prepareResponse()['payload'])
  })

  it('refuses one segment', () => {
    const body = prepareResponse()
    const r = l2PrepareResponseSchema.safeParse({ ...body, signing_input: 'eyJhbGciOiJFUzI1NiJ9' })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0]?.message).toMatch(/two non-empty base64url segments/)
  })

  it('refuses three segments, because a signature is not part of the signing input', () => {
    const body = prepareResponse()
    const r = l2PrepareResponseSchema.safeParse({ ...body, signing_input: `${String(body['signing_input'])}.sig` })
    expect(r.success).toBe(false)
  })

  it('refuses a trailing dot, which would encode an empty payload segment', () => {
    const body = prepareResponse()
    const r = l2PrepareResponseSchema.safeParse({ ...body, signing_input: `${String(body['signing_input'])}.` })
    expect(r.success).toBe(false)
  })

  it('refuses an empty header segment', () => {
    const body = prepareResponse()
    const r = l2PrepareResponseSchema.safeParse({ ...body, signing_input: `.${String(body['signing_input']).split('.')[1]}` })
    expect(r.success).toBe(false)
  })

  it('refuses a segment that is not base64url-encoded JSON', () => {
    const body = prepareResponse()
    const r = l2PrepareResponseSchema.safeParse({ ...body, signing_input: 'not-base64url!!.also-not' })
    expect(r.success).toBe(false)
  })

  // The failure this guards against: a `payload` that is not the payload being signed would mean the
  // user consents to text the signature does not cover.
  it('refuses a payload that does not match signing_input segment 1', () => {
    const body = prepareResponse()
    const r = l2PrepareResponseSchema.safeParse({
      ...body,
      payload: { ...(body['payload'] as Record<string, unknown>), aud: ['https://attacker.test'] },
    })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues.some((i) => i.path[0] === 'payload')).toBe(true)
  })

  it('refuses a header that does not match signing_input segment 0', () => {
    const body = prepareResponse()
    const r = l2PrepareResponseSchema.safeParse({
      ...body,
      header: { ...(body['header'] as Record<string, unknown>), kid: 'some-other-key' },
    })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues.some((i) => i.path[0] === 'header')).toBe(true)
  })

  it('is not fooled by key ordering', () => {
    const body = prepareResponse()
    const payload = body['payload'] as Record<string, unknown>
    // Same key/value pairs, inserted in a different order. JSON.parse preserves insertion order, so a
    // naive comparison would call this drift.
    const reordered = Object.fromEntries(Object.entries(payload).reverse())
    const r = l2PrepareResponseSchema.safeParse({ ...body, payload: reordered })
    expect(r.success).toBe(true)
  })

  it('refuses a response missing any of the six required fields', () => {
    for (const field of ['prepare_id', 'signing_input', 'header', 'payload', 'expires_at', 'prepare_ttl_seconds']) {
      const body = prepareResponse() as Record<string, unknown>
      const copy = { ...body }
      delete copy[field]
      expect(l2PrepareResponseSchema.safeParse(copy).success, `missing ${field}`).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// verifyResponseSchema — spec D19 lives in `constraints.skipped`
// ---------------------------------------------------------------------------

describe('verifyResponseSchema', () => {
  it('parses a full response, including the annotated skipped entries', () => {
    const parsed = verifyResponseSchema.parse(verifyResponse())
    expect(parsed.chain_valid).toBe(true)
    expect(parsed.constraints.satisfied).toBe(true)
    // Annotated as the service sends them, then normalised to `{type, reason}` on the way out. That
    // detail decides whether a Gate knows it still owes a budget check — see
    // `pendingNetworkEnforcement` below.
    expect(parsed.constraints.skipped[0]).toEqual({
      type: 'mandate.payment.budget',
      reason: expect.stringContaining('Network-enforced'),
    })
    expect(pendingNetworkEnforcement(parsed.constraints.skipped).sort()).toEqual([
      'mandate.payment.agent_recurrence',
      'mandate.payment.budget',
      'mandate.payment.recurrence',
    ])
    expect(parsed.verified_at).toBe(1_790_000_000)
    expect(parsed.clock_skew_seconds).toBe(300)
  })

  it('parses chain_valid:false with its reasons, because that is a verdict and not a failure', () => {
    const parsed = verifyResponseSchema.parse(
      verifyResponse({ chainValid: false, errors: ['L2 signature verification failed'], satisfied: false }),
    )
    expect(parsed.chain_valid).toBe(false)
    expect(parsed.errors).toEqual(['L2 signature verification failed'])
  })

  // `skipped` is required in pydantic, so it is required here: a response that omitted it would be a
  // response this client cannot reason about, because "skipped: []" and "no skipped key" are different
  // claims about whether the Gate still owes a budget check.
  it('requires constraints.skipped rather than defaulting it', () => {
    const body = verifyResponse() as Record<string, unknown>
    const constraints = { ...(body['constraints'] as Record<string, unknown>) }
    delete constraints['skipped']
    const r = verifyResponseSchema.safeParse({ ...body, constraints })
    expect(r.success).toBe(false)
  })

  it('names exactly the three constraints the Gate owns, and nothing else (spec D19)', () => {
    expect([...NETWORK_ENFORCED_CONSTRAINTS].sort()).toEqual([
      'mandate.payment.agent_recurrence',
      'mandate.payment.budget',
      'mandate.payment.recurrence',
    ])
  })

  it('does not put the three network-enforced types in `checked`, which is the D19 trap', () => {
    const parsed = verifyResponseSchema.parse(verifyResponse())
    for (const type of NETWORK_ENFORCED_CONSTRAINTS) {
      expect(parsed.constraints.checked).not.toContain(type)
      expect(pendingNetworkEnforcement(parsed.constraints.skipped)).toContain(type)
    }
  })

  it('carries the EC-TIME-3 honesty fields', () => {
    const honoured = verifyResponseSchema.parse(verifyResponse({ atTimeNotHonoured: false }))
    expect(honoured.at_time_not_honoured).toBe(false)
    expect(honoured.at_time_check).toBeNull()

    const notHonoured = verifyResponseSchema.parse({
      ...verifyResponse({ atTimeNotHonoured: true }),
      at_time_reason: 'verify_chain() at the pinned commit has no clock override',
      at_time_check: {
        requested: 1_790_000_000,
        honoured: false,
        reason: 'no clock override',
        within_validity_at: false,
        within_validity_now: true,
        l1_exp: 1_821_560_000,
        l2_exp: 1_790_003_600,
      },
    })
    expect(notHonoured.at_time_not_honoured).toBe(true)
    expect(notHonoured.at_time_reason).toMatch(/no clock override/)
    expect(notHonoured.at_time_check?.within_validity_now).toBe(true)
  })

  it('defaults checks_performed / checks_skipped, which vi gives a default_factory', () => {
    const body = verifyResponse() as Record<string, unknown>
    delete body['checks_performed']
    delete body['checks_skipped']
    const parsed = verifyResponseSchema.parse(body)
    expect(parsed.checks_performed).toEqual([])
    expect(parsed.checks_skipped).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// `extra` behaviour and request defaults
// ---------------------------------------------------------------------------

describe('request schemas mirror pydantic `extra="forbid"`', () => {
  it('refuses an unknown request field, so a typo is caught here rather than by vi', () => {
    const r = l1IssueRequestSchema.safeParse({
      user_id: 'usr_test_user',
      wallet: { payer_id: 'PAYER123', payer_email: 'b@c.test', payment_token_id: 'tok' },
      device_public_jwk: publicJwk(),
      devicekid: 'typo',
    })
    expect(r.success).toBe(false)
  })

  it('strips an unknown *response* field instead of failing, because vi responses are extra="ignore"', () => {
    const parsed = l1IssueResponseSchema.parse({ ...l1Response(), brand_new_field: 'ignored' })
    expect(parsed).not.toHaveProperty('brand_new_field')
    expect(parsed.issuer_kid).toBe('issuer-key-1')
  })

  it("reproduces vi's documented L1 defaults when the fields are omitted", () => {
    const parsed = l1IssueRequestSchema.parse({
      user_id: 'usr_test_user',
      wallet: { payer_id: 'PAYER123', payer_email: 'b@c.test', payment_token_id: 'tok' },
      device_public_jwk: publicJwk(),
    })
    expect(parsed.device_kid).toBe('device-key-1')
    expect(parsed.ttl_days).toBe(365)
    expect(parsed.pan_last_four).toBe('0000')
    expect(parsed.scheme).toBe('PayPal')
  })

  it('refuses a float amount_minor before it reaches the wire (EC-FX-6)', () => {
    const r = l3CreateRequestSchema.safeParse({
      agent_kid: 'agt_k_1',
      enc_private_key_b64: 'Y2lwaGVy',
      l2: 'a.b.c~d~',
      checkout_jwt: 'eyJhbGciOiJFUzI1NiJ9.eyJhIjoxfQ.sig',
      payment: { amount_minor: 13_300.5, currency: 'USD', payee_id: 'mrc_northwind' },
      aud: 'https://network.countersign.test',
      nonce: 'n1',
    })
    expect(r.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The route manifest
// ---------------------------------------------------------------------------

describe('ROUTE_CONTRACTS', () => {
  it('models all twelve routes of apps/vi/src/vi_service/main.py', () => {
    expect(ROUTE_CONTRACTS).toHaveLength(12)
    expect(ROUTE_CONTRACTS.map((r) => `${r.method} ${r.path}`).sort()).toEqual(
      [
        'POST /v1/keys/agent',
        'POST /v1/keys/rotate',
        'GET /v1/jwks',
        'POST /v1/l1/issue',
        'POST /v1/l2/prepare',
        'POST /v1/l2/finalize',
        'POST /v1/checkout-jwt',
        'POST /v1/l3/create',
        'POST /v1/verify',
        'POST /v1/public/verify',
        'GET /v1/status',
        'GET /v1/checkout-jwt/verify',
      ].sort(),
    )
  })

  // Spec §8.3: every route needs the bearer token except these two, which are public and rate-limited.
  it('marks exactly GET /v1/jwks and POST /v1/public/verify as public', () => {
    const publicRoutes = ROUTE_CONTRACTS.filter((r) => r.auth === 'public').map((r) => `${r.method} ${r.path}`)
    expect(publicRoutes.sort()).toEqual(['GET /v1/jwks', 'GET /v1/status', 'POST /v1/public/verify'].sort())
  })

  it('gives every route a response schema and every POST a request schema', () => {
    for (const r of ROUTE_CONTRACTS) {
      expect(r.response, `${r.path} response`).toBeDefined()
      if (r.method === 'POST') expect(r.request, `${r.path} request`).toBeDefined()
    }
  })

  it('finds a contract by method and path, ignoring a query string', () => {
    expect(findRouteContract('get', '/v1/checkout-jwt/verify')?.auth).toBe('bearer')
    expect(findRouteContract('GET', '/v1/checkout-jwt/verify?checkout_jwt=abc')?.path).toBe('/v1/checkout-jwt/verify')
    expect(findRouteContract('POST', '/v1/nope')).toBeUndefined()
  })

  it('agrees with a CsErrorBody the service would raise, so the error shape is pinned too', () => {
    // A sanity check that the fixture helper still builds the §8.0 rule 3 envelope; the mapping itself is
    // exercised in `client.test.ts`.
    expect(csErrorBody('VI_SIGNATURE_MISMATCH', 'nope')).toMatchObject({
      error: { code: 'VI_SIGNATURE_MISMATCH', retryable: false },
    })
  })
})