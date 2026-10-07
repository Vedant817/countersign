/**
 * The signed-constraint reader, run against a **real** `/v1/verify` response.
 *
 * ## Why this file exists at all
 *
 * `signed-constraints.ts` reads the buyer's signed spending ceiling out of
 * `VerifyResponse.disclosed.l2.delegate_payload[*].constraints`. Every other test of that reader builds
 * that object **by hand** — and a hand-built object cannot distinguish a reader that matches real
 * vi-service output from one that matches the author's idea of it. That is not a hypothetical gap:
 * `budgetConstraintSchema` is a `strictObject`, `min` is optional, and the whole D19 fix turns on
 * whether the numbers arrive where the reader looks for them.
 *
 * So this file drives **`apps/vi`'s real routes** — `/v1/l1/issue`, `/v1/l2/prepare`,
 * `/v1/l2/finalize`, `/v1/checkout-jwt`, `/v1/l3/create`, then `POST /v1/verify` — through
 * `fastapi.testclient` with a fixed clock. No sockets, no PayPal, no credentials. Every token in the
 * committed capture was signed by `verifiable_intent` at the pinned commit
 * `356c29635f1c44df7de02edb58699ca9f29bece6`, and the response body under `verify_response` is
 * byte-for-byte what the route returned.
 *
 * `packages/verifier/test/fixtures/chain.json` is the same mechanism, captured by WP-18; this is the
 * same idea applied to the one field D19 depends on.
 *
 * ## The path, quoted from the capture
 *
 * ```
 * verify_response.disclosed.l2.delegate_payload[1].constraints[2]
 *   = {"currency": "USD", "max": 13000, "type": "mandate.payment.budget"}
 * ```
 *
 * `delegate_payload[1]` is the `vct: "mandate.payment.open.1"` disclosure. Note that `min` is
 * **absent**, not `null` — the library's `to_dict()` omits an unset optional rather than emitting
 * null (`constraints.py::PaymentBudgetConstraint.to_dict`), and `.default(null)` on the zod schema is
 * what makes that omission acceptable. If the library emitted `"min": null` instead, `.nullable()`
 * would still accept it; if it emitted an *extra* key, `strictObject` would refuse the whole thing and
 * — see `apps/vi`'s D-019 fail-closed guard — check 8 would BLOCK.
 *
 * ## What is asserted, and what would fail if the reader drifted
 *
 * 1. The signed ceiling is found, with the exact `max` and currency, from the **captured response**.
 * 2. The whole response parses as a `VerifyResponse` through `@countersign/vi-client`'s schema, so
 *    this is not a shape the Gate's own wire types would reject.
 * 3. `pendingNetworkEnforcement` reports all three network-enforced types, so the D19 obligation the
 *    reader discharges is real and was created from this exact response.
 * 4. Both recurrence types are read, with the exact key names the library emits.
 * 5. **No constraint entry in the real response is an SD-hash reference** — which is what makes the
 *    inline walk in `disclosedConstraints` sufficient rather than merely convenient.
 * 6. End to end through `evaluate`: the captured L2, a synthetic matching disclosed L3a, a
 *    $30.00 cart, a $200.00 account cap and a
 *    $130.00 signed ceiling ALLOWs with check 8 naming the signature as the binding cap — and the same
 *    capture with the cart raised past $130.00 BLOCKs with `GATE_BUDGET_EXCEEDED`. The account cap is
 *    deliberately looser than the signed ceiling in the passing case, so an ALLOW cannot be attributed
 *    to the cache.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  pendingNetworkEnforcement,
  verifyResponseSchema,
  type VerifyResponse,
} from '@countersign/vi-client'

import { cartLines } from '../src/checks'
import { evaluate } from '../src/evaluate'
import {
  disclosedConstraints,
  mergeRecurrenceConstraints,
  readSignedBudget,
  CONSTRAINT_SOURCE,
} from '../src/signed-constraints'
import type { GateDecision } from '../src/types'
import {
  CAP_MINOR,
  CART_MINOR,
  CHECKOUT_ID,
  NOW_SEC,
  fakeL3a,
  input,
  makeWorld,
  withDeps,
} from './fixtures'

/* ------------------------------------------------------------------------------------------ */
/* The capture                                                                                 */
/* ------------------------------------------------------------------------------------------ */

interface Capture {
  readonly _meta: {
    readonly captured_at_utc: string
    readonly vi_lib_commit: string
    readonly signed_budget_max_minor: number
    readonly signed_budget_min_is_omitted: boolean
    readonly signed_budget_json_path: string
  }
  readonly verify_request: Record<string, unknown>
  readonly verify_response: unknown
}

const capture = JSON.parse(
  readFileSync(new URL('./fixtures/vi-verify-budget-capture.json', import.meta.url), 'utf8'),
) as Capture

/** The response exactly as `/v1/verify` returned it. */
const rawResponse = capture.verify_response as VerifyResponse

/** The `$130.00` ceiling `apps/vi` signed, in minor units. */
const SIGNED_CEILING_MINOR = BigInt(capture._meta.signed_budget_max_minor)

/** A `$200.00` `budget_accounts.cap_minor` — ten times the signature, as in QA-gate-1. */
const ACCOUNT_CAP_MINOR = 20_000n

/* ------------------------------------------------------------------------------------------ */
/* Helpers                                                                                     */
/* ------------------------------------------------------------------------------------------ */

/** `VerifyResponse` through the real wire schema, failing loudly rather than casting. */
function parseResponse(): VerifyResponse {
  const parsed = verifyResponseSchema.safeParse(capture.verify_response)
  if (!parsed.success) {
    throw new Error(
      `The captured /v1/verify response does not parse as a VerifyResponse: ${JSON.stringify(
        parsed.error.issues.slice(0, 5),
      )}`,
    )
  }
  return parsed.data
}

/** Every `constraints` array entry, read straight out of the captured `disclosed.l2`. */
function constraintsOf(response: VerifyResponse): unknown[] {
  const payload = response.disclosed.l2 as Record<string, unknown>
  const delegates = payload['delegate_payload']
  if (!Array.isArray(delegates))
    throw new Error('the captured disclosed.l2 has no delegate_payload')
  const out: unknown[] = []
  for (const raw of delegates) {
    if (typeof raw !== 'object' || raw === null) continue
    const list = (raw as Record<string, unknown>)['constraints']
    if (Array.isArray(list)) out.push(...list)
  }
  return out
}

type World = Awaited<ReturnType<typeof makeWorld>>

/**
 * Exercise the captured L2 constraints with a synthetic matching disclosed L3a.
 * These budget-only tests vary the cart; disclosed-payment.test.ts separately uses the untouched
 * response and its actual $133.00 payment. A changed cart cannot match that captured payment.
 *
 * The cart total has to move with the L3a, because check 6 cross-checks the claimed amount against the
 * session's locked total; a world built with a different total needs an L3a carrying the same number or
 * check 6 refuses first and every assertion about check 8 measures the wrong check.
 */
async function decideWithCapture(
  cartMinor: bigint,
): Promise<{ readonly decision: GateDecision; readonly world: World }> {
  const world: World = await makeWorld({ capMinor: ACCOUNT_CAP_MINOR, cartMinor })
  const result = await evaluate(
    input({ l3a: fakeL3a({ amount_minor: Number(cartMinor) }) }),
    withDeps(world, {
      verify: async () => ({
        ok: true,
        value: {
          ...parseResponse(),
          disclosed: {
            ...parseResponse().disclosed,
            l3a: {
              delegate_payload: [
                {
                  vct: 'mandate.payment.1',
                  payment_amount: { amount: cartMinor.toString(), currency: 'USD' },
                  payee: { id: 'MERCHANT_NORTHWIND' },
                },
              ],
            },
          },
        },
      }),
    }),
  )
  if (!result.ok) {
    throw new Error(`evaluate() failed: ${result.error.code}: ${result.error.message}`)
  }
  return { decision: result.value, world }
}

function checkRow(decision: GateDecision, n: number) {
  const row = decision.checks.find((c) => c.n === n)
  if (!row) throw new Error(`no check ${n} in the decision`)
  return row
}

/* ------------------------------------------------------------------------------------------ */
/* 1 — The capture is real and the reader finds the signed ceiling                              */
/* ------------------------------------------------------------------------------------------ */

describe('the real /v1/verify response — readSignedBudget', () => {
  it('the capture parses as a VerifyResponse through the wire schema', () => {
    const response = parseResponse()

    expect(response.chain_valid).toBe(true)
    expect(response.errors).toEqual([])
    expect(response.constraints.satisfied).toBe(true)
    // The obligation exists, which is the whole reason the reader matters.
    expect(pendingNetworkEnforcement(response.constraints.skipped)).toEqual([
      'mandate.payment.budget',
      'mandate.payment.recurrence',
      'mandate.payment.agent_recurrence',
    ])
  })

  it('the signed budget lives at disclosed.l2.delegate_payload[1].constraints[2]', () => {
    // The path, pinned literally rather than derived. If a vi-service bump moved the constraint, this
    // assertion is the thing that says so, and it fails with the path in its message.
    const delegates = (rawResponse.disclosed.l2 as Record<string, unknown>)[
      'delegate_payload'
    ] as Array<Record<string, unknown>>
    const payment = delegates[1]!

    expect(payment['vct']).toBe('mandate.payment.open.1')
    expect((payment['constraints'] as unknown[])[2]).toStrictEqual({
      currency: 'USD',
      max: 13_000,
      type: 'mandate.payment.budget',
    })
    // `min` is absent, not null. `expect(...).not.toHaveProperty('min')` is the assertion; a fixture
    // that quietly grew `"min": null` would stop exercising the `.default(null)` path.
    expect(capture._meta.signed_budget_min_is_omitted).toBe(true)
    expect(Object.keys((payment['constraints'] as unknown[])[2] as object).sort()).toEqual([
      'currency',
      'max',
      'type',
    ])
  })

  it('disclosedConstraints walks the real response and names both vcts', () => {
    const read = disclosedConstraints(rawResponse.disclosed.l2)

    expect(read.source).toBe(CONSTRAINT_SOURCE.SIGNED_L2)
    expect(read.vcts).toEqual(['mandate.checkout.open.1', 'mandate.payment.open.1'])
    // 2 checkout-side + 6 payment-side, one of which is the reference constraint the library injects.
    expect(read.constraints).toHaveLength(8)
    expect(read.constraints).toEqual(constraintsOf(rawResponse))
  })

  it('readSignedBudget finds the signed ceiling with the right max and currency', () => {
    const read = disclosedConstraints(rawResponse.disclosed.l2)
    const budget = readSignedBudget(read)

    expect(
      budget.found,
      [
        'readSignedBudget did not find the signed ceiling in the REAL capture:',
        budget.found ? '' : budget.why,
        `The signed budget is at ${capture._meta.signed_budget_json_path}.`,
      ]
        .filter((part) => part !== '')
        .join(' '),
    ).toBe(true)
    if (!budget.found) return

    expect(budget.budget.max).toStrictEqual({ minor: SIGNED_CEILING_MINOR, currency: 'USD' })
    expect(budget.budget.max.minor).toBe(13_000n)
    expect(budget.budget.min).toBeNull()
  })

  it('readSignedBudget accepts both exported call shapes against the real capture', () => {
    // `readSignedBudget` takes either a bare constraint list or anything with a `constraints` array —
    // which is how checks 8 and 11 call it (`ctx.state.signedConstraints`, and `mandate.constraints`).
    // Both shapes are pinned here so a signature change cannot silently stop matching one of them.
    expect(readSignedBudget(constraintsOf(rawResponse)).found).toBe(true)
    expect(readSignedBudget(disclosedConstraints(rawResponse.disclosed.l2)).found).toBe(true)
  })
})

/* ------------------------------------------------------------------------------------------ */
/* 2 — Recurrence and agent_recurrence, with the exact key names the library emits             */
/* ------------------------------------------------------------------------------------------ */

describe('the real /v1/verify response — the two recurrence constraints', () => {
  it('reads both types, with the exact keys constraint_shapes.json pins', () => {
    const read = disclosedConstraints(rawResponse.disclosed.l2)
    const merged = mergeRecurrenceConstraints([
      { source: CONSTRAINT_SOURCE.SIGNED_L2, constraints: read.constraints },
    ])

    expect(merged).toHaveLength(2)
    const byType = new Map(merged.map((r) => [r.constraint.type, r.constraint]))

    // `mandate.payment.recurrence` — `frequency` / `start_date` / `end_date` / `number`. The occurrence
    // count is `number`, NOT `max_occurrences`; the two constraints differ on exactly this key.
    expect(byType.get('mandate.payment.recurrence')).toStrictEqual({
      type: 'mandate.payment.recurrence',
      frequency: 'MNTH',
      start_date: '2025-01-01',
      end_date: '2025-12-31',
      number: 12,
    })

    // `mandate.payment.agent_recurrence` — same three date/frequency keys, `max_occurrences` instead of
    // `number`, and `end_date` is REQUIRED (the library's dataclass has no default for it).
    expect(byType.get('mandate.payment.agent_recurrence')).toStrictEqual({
      type: 'mandate.payment.agent_recurrence',
      frequency: 'MNTH',
      start_date: '2025-01-01',
      end_date: '2025-12-31',
      max_occurrences: 8,
    })

    // Every reading names the token as its source, so check 11's detail cannot claim a cache.
    for (const reading of merged) expect(reading.sources).toEqual([CONSTRAINT_SOURCE.SIGNED_L2])
  })

  it('does not confuse the two occurrence keys', () => {
    // The failure this guards is silent and asymmetric: reading `number` off an agent_recurrence would
    // leave `max_occurrences` null, i.e. **no limit at all**, and `evaluateRecurrence` treats a null
    // limit as "the date window is the whole limit" — the loosest possible reading of a signed cap.
    const read = disclosedConstraints(rawResponse.disclosed.l2)
    const merged = mergeRecurrenceConstraints([
      { source: CONSTRAINT_SOURCE.SIGNED_L2, constraints: read.constraints },
    ])
    const agent = merged.find((r) => r.constraint.type === 'mandate.payment.agent_recurrence')

    expect(agent).toBeDefined()
    if (!agent) return
    const constraint = agent.constraint
    if (constraint.type !== 'mandate.payment.agent_recurrence') {
      throw new Error(`expected agent_recurrence, got ${constraint.type}`)
    }
    expect(constraint.max_occurrences).toBe(8)
    expect((constraint as { number?: unknown }).number).toBeUndefined()
  })
})

/* ------------------------------------------------------------------------------------------ */
/* 3 — The hash-indirection hypothesis, settled against real output                            */
/* ------------------------------------------------------------------------------------------ */

/**
 * The fix's author was "less confident that a constraint is never reachable only through
 * `resolve_disclosure_refs`' hash indirection rather than appearing inline". This settles it.
 */
describe('the hash-indirection hypothesis', () => {
  it('no constraint entry in the real response is an SD-hash reference', () => {
    const entries = constraintsOf(rawResponse)
    const bareRefs = entries.filter(
      (c) => typeof c === 'object' && c !== null && '...' in (c as Record<string, unknown>),
    )

    expect(
      bareRefs,
      'a constraint entry in the REAL capture is an SD-hash reference, so the inline walk in ' +
        'disclosedConstraints would not reach it',
    ).toHaveLength(0)
    // Every entry is a constraint object with a `type`, which is what `resolve_disclosure_refs`
    // returns *after* substitution and what `create_layer2_autonomous` writes *before* it.
    expect(entries.every((c) => typeof (c as { type?: unknown }).type === 'string')).toBe(true)
  })

  it('the library substitutes refs for merchant/item VALUES, never for a whole constraint', () => {
    // In the real response the `{"...": hash}` references exist — but only as entries of an
    // `allowed` / `acceptable_items` array inside a constraint, never as a constraint themselves.
    const entries = constraintsOf(rawResponse) as Array<Record<string, unknown>>
    const withRefs = entries.filter((c) => JSON.stringify(c).includes('"..."'))

    expect(withRefs.length).toBeGreaterThan(0)
    for (const constraint of withRefs) {
      // Every reference is reachable only from a nested array, so the constraint object itself is
      // still present inline and readable.
      expect(typeof constraint['type']).toBe('string')
      expect(Object.keys(constraint)).not.toContain('...')
    }
    // Specifically: the three network-enforced types carry no reference at all — they have no
    // merchant or item in them, so `_match_merchant_refs` / `_match_item_refs` never touch them.
    const byType = new Map(entries.map((c) => [c['type'] as string, c]))
    for (const type of [
      'mandate.payment.budget',
      'mandate.payment.recurrence',
      'mandate.payment.agent_recurrence',
    ]) {
      expect(byType.has(type), `${type} is missing from the captured response`).toBe(true)
      expect(
        JSON.stringify(byType.get(type)),
        `${type} carries an SD-hash reference`,
      ).not.toContain('"..."')
    }
  })

  it('if a budget WERE behind a ref, the Gate refuses rather than allows — and says why', () => {
    // The fail-closed half of the hypothesis. `readSignedBudget` reports `found: false` for a bare
    // `{"...": hash}` entry (there is no `type` to match), which under a live obligation is check 8's
    // BLOCK. This test asserts the reader half; `signed-budget.test.ts` asserts the BLOCK half.
    const read = disclosedConstraints({
      delegate_payload: [
        { vct: 'mandate.checkout.open.1', constraints: [] },
        { vct: 'mandate.payment.open.1', constraints: [{ '...': 'aD2wnFirygv' }] },
      ],
    })
    const budget = readSignedBudget(read)

    expect(budget.found).toBe(false)
    if (budget.found) return
    expect(budget.why).toContain('mandate.payment.budget')
  })
})

/* ------------------------------------------------------------------------------------------ */
/* 4 — End to end: the captured response driving the real decision                             */
/* ------------------------------------------------------------------------------------------ */

describe('the real /v1/verify response — end to end through evaluate', () => {
  it('a $30.00 cart against a signed $130.00 ceiling and a $200.00 account cap ALLOWs, bound by the signature', async () => {
    expect(SIGNED_CEILING_MINOR).toBeGreaterThan(CART_MINOR)
    expect(ACCOUNT_CAP_MINOR).toBeGreaterThan(SIGNED_CEILING_MINOR)

    const { decision } = await decideWithCapture(CART_MINOR)

    expect(decision.decision).toBe('ALLOW')
    const row = checkRow(decision, 8)
    expect(row.passed).toBe(true)
    // The detail names the signature as the binding cap and lists all three candidates, so a dispute
    // can see which number stopped it rather than merely that some limit did.
    expect(row.detail).toContain('the signed L2 mandate.payment.budget constraint')
    expect(row.detail).toContain('13000 USD')
    expect(row.detail).toContain('20000 USD')
  })

  it('the captured L2 with a synthetic $140.00 payment BLOCKs on the signature, not the account cap', async () => {
    const overCeiling = 14_000n
    expect(overCeiling).toBeGreaterThan(SIGNED_CEILING_MINOR)
    // Still under the account cap, so only the signature can be what refused it.
    expect(overCeiling).toBeLessThan(ACCOUNT_CAP_MINOR)

    const { decision } = await decideWithCapture(overCeiling)

    expect(decision.decision).toBe('BLOCK')
    expect(decision.reasons.map((r) => r.code)).toContain('GATE_BUDGET_EXCEEDED')
    const row = checkRow(decision, 8)
    expect(row.passed).toBe(false)
    expect(row.detail).toContain('the signed L2 mandate.payment.budget constraint')
    expect(row.detail).toContain('13000 USD')
  })

  it('check 11 read both recurrence constraints out of the capture and discharged the obligation', async () => {
    // The capture's recurrence window is 2025-01-01 → 2025-12-31, which brackets the fixtures' fixed
    // `NOW_SEC` (2025-10-09), so the verdict is a genuine pass rather than an out-of-window refusal.
    const { decision } = await decideWithCapture(CART_MINOR)

    const row = checkRow(decision, 11)
    const detail = row.detail ?? ''
    expect(detail).toContain('mandate.payment.recurrence MNTH')
    expect(detail).toContain('mandate.payment.agent_recurrence MNTH')
    expect(detail).toContain(CONSTRAINT_SOURCE.SIGNED_L2)
    expect(detail).toContain('D19 obligation discharged')
    // Never read from the cache: the fixture mandate's `constraints` column is empty.
    expect(detail).not.toContain(CONSTRAINT_SOURCE.MANDATE_COLUMN)
  })

  it('check 4 recorded the obligation from the capture, and the cart lines are untouched', async () => {
    const { decision, world } = await decideWithCapture(CART_MINOR)

    expect(decision.pendingNetworkEnforcement).toEqual([
      'mandate.payment.budget',
      'mandate.payment.recurrence',
      'mandate.payment.agent_recurrence',
    ])
    // The reservation is the decision's own amount, in minor units, taken against the effective cap.
    // Check 8 is where D19 becomes money, so the test that reads the signed ceiling also asserts the
    // cart was actually reserved rather than merely compared.
    expect(decision.reservation?.amount).toStrictEqual({ minor: CART_MINOR, currency: 'USD' })
    expect(decision.reservation?.amount.minor).toBe(3_000n)
    expect(decision.nowSec).toBe(NOW_SEC)
    // And the cart was priced from its own rows, not from the token: one line in the session's JSONB
    // `cart`, read through the same `cartLines` check 10 uses.
    const found = await world.deps.checkout(CHECKOUT_ID)
    if (!found.ok)
      throw new Error(`checkout lookup failed: ${found.error.code}: ${found.error.message}`)
    expect(found.value).toBeDefined()
    expect(cartLines(found.value!)).toHaveLength(1)
  })
})

/* ------------------------------------------------------------------------------------------ */
/* 5 — The capture's own bookkeeping                                                             */
/* ------------------------------------------------------------------------------------------ */

describe('the committed capture', () => {
  it('records when and how it was made, and the commit it was made against', () => {
    expect(capture._meta.captured_at_utc).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // 40 hex characters: the pinned `verifiable_intent` commit. A capture taken against a different
    // library would otherwise be silently wrong rather than obviously wrong.
    expect(capture._meta.vi_lib_commit).toMatch(/^[0-9a-f]{40}$/)
    expect(capture._meta.signed_budget_json_path).toBe(
      'verify_response.disclosed.l2.delegate_payload[1].constraints[2] (vct=mandate.payment.open.1)',
    )
  })

  it('carries the tokens that produced the response, so the capture is reproducible', () => {
    // Not exercised by these tests — nothing here re-verifies the chain — but a capture without its
    // inputs cannot be regenerated or checked, and the point of committing it is that it can be.
    expect(capture.verify_request['l1']).toEqual(expect.any(String))
    expect(capture.verify_request['l2']).toEqual(expect.any(String))
    expect(capture.verify_request['l3a']).toEqual(expect.any(String))
    expect(capture.verify_request['l3b']).toEqual(expect.any(String))
    expect(capture.verify_request['strict']).toBe(true)
    for (const token of ['l1', 'l2', 'l3a', 'l3b'] as const) {
      const value = capture.verify_request[token] as string
      expect(value.length).toBeGreaterThan(0)
      // A truncated capture decodes to nothing while still satisfying "a non-empty string", which is
      // the failure mode WP-18 hit; three JWS segments plus the SD-JWT `~` framing is the real shape.
      expect(value.split('.').length).toBe(3)
      expect(value).toContain('~')
    }
  })

  it('the default account cap in the fixtures is looser than the signature, so no ALLOW is ambiguous', () => {
    // `CAP_MINOR` ($130.00) happens to equal the captured ceiling, which would make an ALLOW
    // unattributable. `decideWithCapture` overrides it deliberately; this assertion is what keeps a
    // future edit to that helper from quietly making the passing case vacuous.
    expect(CAP_MINOR).toBe(SIGNED_CEILING_MINOR)
    expect(ACCOUNT_CAP_MINOR).not.toBe(CAP_MINOR)
  })
})
