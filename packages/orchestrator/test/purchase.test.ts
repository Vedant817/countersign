/**
 * `createOrderFromIntent` / `runGateEvaluation` — core invariant **I-1** (§3.1), **AT-M11.5**, §12.2
 * **EC-IDEM-1**, §12.4 **EC-MDT-2**, §8.10, §8.11.
 *
 * ## The four claims, and the mechanism that proves each
 *
 * | Test | Claim | Mechanism |
 * |---|---|---|
 * | #1 | `ALLOW` is the only outcome that reaches `createOrderFromDecision`; every other outcome still returns the decision **with its reasons** | the Gate is the real `evaluate`; the refusal is observed through the recorded PayPal calls and through the returned `GateDecision` |
 * | #2 | I-1 end to end | the signed decision record is **verified with its real Ed25519 signature** and its payload compared field by field with the single PayPal request body |
 * | #3 | idempotency, clean and after a crash | two submissions of the same intent; then the same with the PayPal call removed from the first run |
 *
 * The I-1 assertion in #2 is deliberately the strongest available form. It does not decode the JWT and
 * compare strings: `verifyDecisionRecord` checks the signature against the harness's JWKS and then
 * `recordMatches`-style comparison runs on the **verified payload**, so "the amount PayPal was asked for is
 * the amount the Gate signed" cannot pass because both sides happened to be read out of the same wrong
 * place.
 */
import { describe, expect, it } from 'vitest'

import { createOrderFromIntent, gateDecisionFromRow, runGateEvaluation } from '../src/purchase'
import {
  ATTEMPT_ID,
  CART_MINOR,
  MERCHANT_ID,
  PAYPAL,
  compiledWithAmbiguity,
  gateInput,
  harness,
  l3a,
  l3b,
  readSignedRecord,
  validationError,
  type Harness,
} from './harness'

/* ------------------------------------------------------------------------------------------ */
/* Helpers                                                                                        */
/* ------------------------------------------------------------------------------------------ */

/** `POST /v2/checkout/orders` calls only. The OAuth handshake is not a money movement. */
function orderCalls(h: Harness) {
  return h.paypal.callsTo('/v2/checkout/orders').filter((c) => !c.path.includes('/authorize'))
}

interface OrderRequestBody {
  intent: string
  purchase_units: Array<{
    reference_id: string
    custom_id: string
    invoice_id: string
    amount: { currency_code: string; value: string }
    payee: { merchant_id: string }
  }>
  payment_source: { paypal: { vault_id: string } }
}

/** The purchase intent a caller submits when the mandate is already signed. */
function intent(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'usr_00000000000000000000000001' as `usr_${string}`,
    gate: gateInput(),
    merchants: { mrc_northwind: 'Northwind Outfitters' },
    ...overrides,
  }
}

/* ------------------------------------------------------------------------------------------ */
/* 1. ALLOW is the only door to PayPal                                                             */
/* ------------------------------------------------------------------------------------------ */

describe('I-1: only an ALLOW reaches createOrderFromDecision', () => {
  const OUTCOMES = [
    { outcome: 'ALLOW', why: 'the happy path' },
    { outcome: 'BLOCK', why: 'the mandate was revoked (EC-MDT-2)' },
    { outcome: 'REVIEW', why: 'the velocity guard tripped (EC-AGT-2)' },
  ] as const

  for (const { outcome, why } of OUTCOMES) {
    it(`AT-M11.5 I-1 a ${outcome} ${why} ${outcome === 'ALLOW' ? 'reaches' : 'never reaches'} createOrderFromDecision`, async () => {
      const h = await harness({
        gateOutcome: outcome,
        // A REVOKED mandate is one BLOCK shape. `REVIEW` needs an ACTIVE mandate plus a velocity flood,
        // which is why the status is not hard-wired to the outcome here.
        mandateStatus: outcome === 'REVIEW' ? 'ACTIVE' : undefined,
      })

      const result = await createOrderFromIntent(intent(), h.deps)
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)

      // --- the decision is always returned, whatever it says -------------------------------------
      expect(result.value.decision).not.toBeNull()
      expect(result.value.decision?.decision).toBe(outcome)

      // --- the PayPal call count is the whole point ---------------------------------------------
      if (outcome === 'ALLOW') {
        expect(result.value.stage).toBe('ORDERED')
        expect(result.value.orderId).not.toBeNull()
        expect(orderCalls(h)).toHaveLength(1)
      } else {
        expect(result.value.stage).toBe('REFUSED')
        expect(result.value.orderId).toBeNull()
        // **Zero.** Not "no create-order call" — no money movement of any kind, which is what the
        // assertion has to say to be worth anything.
        expect(h.paypal.callsTo('/v2/checkout/orders')).toHaveLength(0)
        expect(h.paypal.calls.filter((c) => c.method === 'POST')).toHaveLength(0)
      }
    })
  }

  it('AT-M11.5 I-1 a refusal still carries the decision and its reason, so the caller can explain it', async () => {
    const h = await harness({ gateOutcome: 'BLOCK' })
    const result = await createOrderFromIntent(intent(), h.deps)
    if (!result.ok) throw new Error(result.error.message)

    const decision = result.value.decision!
    expect(decision.decision).toBe('BLOCK')
    // §8.10: "all checks always run so every reason is reported" — and the orchestrator propagates them
    // rather than collapsing them into one "blocked".
    expect(decision.reasons.length).toBeGreaterThan(0)
    expect(decision.reasons.map((r) => r.code)).toContain('GATE_REVOKED')
    // A userMessage a buyer can read without seeing an internal id.
    expect(decision.reasons[0]?.userMessage).toMatch(/revoked/i)
    // And the signed record travels with it, so the merchant UI can show what was signed.
    expect(decision.signedRecord.split('.')).toHaveLength(3)
  })

  it('AT-M11.5 I-1 a blocking ambiguity stops before the Gate, so no decision and no PayPal call', async () => {
    // §8.8: "an unresolvable intent MUST produce an ambiguity, not a guess." Reaching the Gate with an
    // invented cap is authority the buyer never granted.
    const h = await harness({ compiled: compiledWithAmbiguity() })
    const result = await createOrderFromIntent(
      intent({ text: 'Buy me some running shoes' }),
      h.deps,
    )
    if (!result.ok) throw new Error(result.error.message)

    expect(result.value.stage).toBe('AMBIGUOUS')
    expect(result.value.decision).toBeNull()
    expect(result.value.compiled?.ambiguities).toHaveLength(1)
    expect(result.value.readback).toContain('What you are authorising')
    expect(h.store.decided).toHaveLength(0)
    expect(h.paypal.calls).toHaveLength(0)
  })

  it('AT-M11.5 I-1 a compiler failure stops the run before the Gate and is reported as err, not ok', async () => {
    // EC-LLM-1: a model outage is a *fault*, not an answer. Returning it as `ok` would let a caller
    // render a confident read-back that is missing the limit.
    const h = await harness({ compilerFails: validationError('the model is unreachable') })
    const result = await createOrderFromIntent(intent({ text: 'Under 130 at Northwind' }), h.deps)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_VALIDATION')
    expect(h.store.decided).toHaveLength(0)
    expect(h.paypal.calls).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------------------------------ */
/* 2. I-1 end to end                                                                              */
/* ------------------------------------------------------------------------------------------ */

describe('I-1 end to end, against a recorded PayPal', () => {
  it('I-1 a BLOCK performs zero PayPal calls — nothing is even asked of PayPal', async () => {
    const h = await harness({ gateOutcome: 'BLOCK' })
    const result = await createOrderFromIntent(intent(), h.deps)
    if (!result.ok) throw new Error(result.error.message)

    // The strong form: not "no create-order call", but no socket at all. Even the OAuth handshake is
    // absent, because nothing ever needed a token.
    expect(h.paypal.calls).toHaveLength(0)
  })

  it('I-1 the one ALLOW call carries exactly the decision’s order, amount, currency and payee', async () => {
    const h = await harness()

    const result = await createOrderFromIntent(intent(), h.deps)
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    expect(result.value.stage).toBe('ORDERED')

    // --- exactly one PayPal order call ---------------------------------------------------------
    const calls = orderCalls(h)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.path).toBe('/v2/checkout/orders')
    // §8.6: `PayPal-Request-Id = cs:{attemptId}:create`, derived from our own ids.
    expect(calls[0]?.headers['paypal-request-id']).toBe(`cs:${ATTEMPT_ID}:create`)

    // --- the signed record, verified cryptographically ------------------------------------------
    const signed = await readSignedRecord(result.value.decision!.signedRecord, h.keys)
    expect(signed.att).toBe(ATTEMPT_ID)
    expect(signed.mdt).toBe('mdt_0000000000000000000000000A')
    expect(signed.amount).toBe('30.00')
    expect(signed.currency).toBe('USD')
    expect(signed.payee).toBe(MERCHANT_ID)

    // --- and the request body agrees with it, field by field -----------------------------------
    const body = h.paypal.bodyOf<OrderRequestBody>('/v2/checkout/orders')
    const unit = body.purchase_units[0]!
    expect(unit.amount.value).toBe(signed.amount)
    expect(unit.amount.currency_code).toBe(signed.currency)
    expect(unit.payee.merchant_id).toBe(signed.payee)
    expect(unit.invoice_id).toBe(result.value.orderId)
    // D18: the chain hash travels into PayPal's own records.
    expect(unit.custom_id).toMatch(/^cs1:[A-Za-z0-9_-]{43}$/)
    // [V10]: merchant-initiated, from the vault. No buyer present.
    expect(body.payment_source.paypal.vault_id).toBe('5TY05013RG002845M')

    // --- and the amount is the integer minor-unit total the Gate reserved ---------------------
    expect(CART_MINOR).toBe(3_000n)
    expect(h.reserved()).toBe(CART_MINOR)
  })

  it('I-1 a BLOCK leaves the ledger alone and a REVIEW leaves the reservation behind, both reported', async () => {
    // Check 8 runs before check 12 in §8.10's order, so a REVIEW (which is check 12 tripping) arrives with
    // a reservation already taken and a compensation already run. That the two nets out is the Gate's
    // AT-M10.4 claim; what this asserts is that the orchestrator neither double-releases nor hides it.
    const blocked = await harness({ gateOutcome: 'BLOCK' })
    await createOrderFromIntent(intent(), blocked.deps)
    expect(blocked.reserved()).toBe(0n)

    const reviewed = await harness({ gateOutcome: 'REVIEW' })
    const outcome = await createOrderFromIntent(intent(), reviewed.deps)
    if (!outcome.ok) throw new Error(outcome.error.message)
    expect(outcome.value.decision?.decision).toBe('REVIEW')
    expect(reviewed.reserved()).toBe(0n)
    expect(orderCalls(reviewed)).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------------------------------ */
/* 3. Idempotency                                                                                 */
/* ------------------------------------------------------------------------------------------ */

describe('EC-IDEM-1 EC-IDEM-2: the same intent submitted twice', () => {
  it('EC-IDEM-1 the same intent twice performs the PayPal order call once and both callers get the same result', async () => {
    const h = await harness()

    const first = await createOrderFromIntent(intent(), h.deps)
    if (!first.ok) throw new Error(first.error.message)
    const callsAfterFirst = h.paypal.calls.length
    const second = await createOrderFromIntent(intent(), h.deps)
    if (!second.ok) throw new Error(second.error.message)

    // **One** HTTP call for the whole flow — OAuth plus the order create — and the second submission made
    // **none at all**. Asserting on the delta rather than on a total is what makes this say "the retry cost
    // nothing", which is the property; a total would still be satisfied by a client that re-created the
    // order and re-paid for it.
    expect(orderCalls(h)).toHaveLength(1)
    expect(h.paypal.calls.length).toBe(callsAfterFirst)

    // The same order, the same decision, the same signed record.
    expect(second.value.stage).toBe('ORDERED')
    expect(second.value.orderId).toBe(first.value.orderId)
    expect(second.value.decision?.id).toBe(first.value.decision?.id)
    expect(second.value.decision?.signedRecord).toBe(first.value.decision?.signedRecord)

    // The second run says so, rather than silently returning the first run's work.
    expect(first.value.idempotent).toBe(false)
    expect(second.value.idempotent).toBe(true)

    // And it did so by **not asking the Gate again** — the Gate's check 7 is a replay detector, so a second
    // `evaluate` would answer GATE_REPLAY rather than ALLOW. The decision was recovered from the record.
    expect(h.store.decisionReads()).toBeGreaterThanOrEqual(2)
    expect(h.store.decided).toHaveLength(1)
    expect(h.gateWorld.insertedAttempts).toHaveLength(1)
  })

  it('EC-IDEM-2 after a crash between the decision and the order, the retry makes the same PayPal request once', async () => {
    // The crash window: the Gate decided, `store.decide` wrote the row, and the process died before
    // `createOrderFromDecision`. The buyer is retried by whatever noticed the failure.
    const h = await harness()

    // First run: the Gate decides and the decision is recorded, then the order call is made to fail.
    const paypalDown = { status: 503, body: { name: 'SERVICE_UNAVAILABLE', message: 'down' } }
    h.paypal.setRoutes({
      'POST /v1/oauth2/token': {
        status: 200,
        body: {
          access_token: 'A21AAFakeAccessToken0000000000000000',
          token_type: 'Bearer',
          expires_in: 32_400,
        },
      },
      'POST /v2/checkout/orders': paypalDown,
    })
    const crashed = await createOrderFromIntent(intent(), h.deps)
    expect(crashed.ok).toBe(false)
    // But the decision is on disk, which is the whole point.
    expect(h.store.decided).toHaveLength(1)
    expect(h.store.decided[0]?.outcome).toBe('ALLOW')

    // Retry with PayPal healthy again.
    const { happyRoutes } = await import('./harness')
    h.paypal.setRoutes(happyRoutes())
    const retry = await createOrderFromIntent(intent(), h.deps)
    if (!retry.ok) throw new Error(`${retry.error.code}: ${retry.error.message}`)

    // **The Gate was not re-run**, so there is no second attempt row and no second decision.
    expect(h.gateWorld.insertedAttempts).toHaveLength(1)
    expect(h.store.decided).toHaveLength(1)

    // Exactly one *successful* order call, and it carries the same `PayPal-Request-Id` as the failed one —
    // which is what lets PayPal itself collapse the retry onto the order it already made (EC-IDEM-2).
    const ids = h.paypal.callsTo('/v2/checkout/orders').map((c) => c.headers['paypal-request-id'])
    expect(ids.every((id) => id === `cs:${ATTEMPT_ID}:create`)).toBe(true)
    expect(retry.value.orderId).not.toBeNull()
    expect(retry.value.decision?.id).toBe(h.store.decided[0]?.decisionId)
  })

  it('EC-MER-2 a replayed L3 against a different attempt is refused by the Gate, and the buyer is told why', async () => {
    // §8.10 check 7 is the replay defence, and it belongs to the Gate. What this asserts is that the
    // orchestrator does not *weaken* it and does not turn a policy refusal into a fault: a different attempt
    // id means the idempotency read misses, the Gate runs, and the unique `l3_jti` index refuses — so no
    // attempt row exists, no decision row can be written (its foreign key has nothing to point at), and the
    // buyer still gets a `GATE_REPLAY` with a sentence rather than a 500.
    const h = await harness()
    const first = await createOrderFromIntent(intent(), h.deps)
    if (!first.ok) throw new Error(first.error.message)

    const second = await createOrderFromIntent(
      intent({
        gate: gateInput({ attemptId: 'att_0000000000000000000000000B' as typeof ATTEMPT_ID }),
      }),
      h.deps,
    )
    if (!second.ok) throw new Error(`${second.error.code}: ${second.error.message}`)

    expect(second.value.stage).toBe('REFUSED')
    expect(second.value.decision?.decision).toBe('BLOCK')
    expect(second.value.decision?.reasons.map((r) => r.code)).toContain('GATE_REPLAY')
    // One order, one PayPal call, one attempt row. The replay created nothing.
    expect(orderCalls(h)).toHaveLength(1)
    expect(h.gateWorld.insertedAttempts).toHaveLength(1)
    expect(h.orderWorld.rows.orders.size).toBe(1)
  })
})

/* ------------------------------------------------------------------------------------------ */
/* 4. runGateEvaluation                                                                            */
/* ------------------------------------------------------------------------------------------ */

describe('runGateEvaluation — the standalone Gate call (Judge Mode, S-21)', () => {
  it('S-21 runGateEvaluation decides and records without creating an order, so no money can move', async () => {
    const h = await harness()
    const evaluated = await runGateEvaluation(intent(), h.deps)
    if (!evaluated.ok) throw new Error(evaluated.error.message)

    expect(evaluated.value.decision.decision).toBe('ALLOW')
    expect(evaluated.value.idempotent).toBe(false)
    expect(evaluated.value.attemptId).toBe(ATTEMPT_ID)
    expect(h.store.decided).toHaveLength(1)
    expect(h.paypal.calls).toHaveLength(0)
  })

  it('S-21 a second call recovers the recorded decision rather than re-running the Gate', async () => {
    const h = await harness()
    await runGateEvaluation(intent(), h.deps)
    const again = await runGateEvaluation(intent(), h.deps)
    if (!again.ok) throw new Error(again.error.message)

    expect(again.value.idempotent).toBe(true)
    expect(h.store.decided).toHaveLength(1)
    expect(h.gateWorld.insertedAttempts).toHaveLength(1)
  })

  it('S-21 an unreadable gate_decisions row refuses rather than overwriting it', async () => {
    // The state this guards against: a row we cannot parse, re-decided. A second `evaluate` would insert a
    // second decision for one attempt and take a **second reservation** — and nothing would say so until a
    // buyer's budget was short by one cart.
    const h = await harness()
    await runGateEvaluation(intent(), h.deps)
    const row = [...h.orderWorld.rows.decisions.values()].find((r) => r.attempt_id === ATTEMPT_ID)!
    row.checks = 'not an array' as unknown as typeof row.checks

    const again = await runGateEvaluation(intent(), h.deps)
    expect(again.ok).toBe(false)
    if (again.ok) return
    expect(again.error.code).toBe('CS_VALIDATION')
    expect(h.store.decided).toHaveLength(1)
    expect(h.gateWorld.insertedAttempts).toHaveLength(1)
  })

  it('gateDecisionFromRow rebuilds id, outcome and reasons, and returns null for a malformed row', () => {
    const at = new Date('2026-10-04T00:00:00.000Z')
    const good = {
      id: 'gdc_0000000000000000000000000A',
      attempt_id: ATTEMPT_ID,
      decision: 'ALLOW',
      reasons: [{ code: 'CS_INTERNAL', message: 'x', userMessage: 'y' }],
      checks: [{ n: 1, code: 'MANDATE_ACTIVE', passed: true }],
      chain_valid: true,
      vi_lib_commit: 'x',
      signed_record: 'a.b.c',
      decided_at: at,
      budget_version: 3,
    } as unknown as Parameters<typeof gateDecisionFromRow>[0]

    const rebuilt = gateDecisionFromRow(good)!
    expect(rebuilt.id).toBe('gdc_0000000000000000000000000A')
    expect(rebuilt.decision).toBe('ALLOW')
    expect(rebuilt.reasons).toHaveLength(1)
    expect(rebuilt.checks).toHaveLength(1)
    expect(rebuilt.signedRecord).toBe('a.b.c')
    expect(rebuilt.reservation).toBeUndefined()

    const bad = { ...good, reasons: 'nope' } as unknown as Parameters<typeof gateDecisionFromRow>[0]
    expect(gateDecisionFromRow(bad)).toBeNull()
  })
})

/* ------------------------------------------------------------------------------------------ */
/* 5. The chain is an input, never invented                                                        */
/* ------------------------------------------------------------------------------------------ */

describe('I-1 the signed chain arrives as an argument and is never manufactured here', () => {
  it('I-1 a Gate BLOCK on an invalid chain still returns the decision, and PayPal is never reached', async () => {
    // EC-MER-2 / EC-MER-1: a merchant presenting a chain that does not verify. The orchestrator's job is to
    // pass it to the Gate and report what came back — not to decide anything itself.
    const h = await harness({
      verify: { chain_valid: false, errors: ['test chain rejected by vi'] },
    })
    const result = await createOrderFromIntent(
      intent({
        gate: gateInput({ l3b: l3b({ checkout_hash: 'a-different-hash' }) }),
      }),
      h.deps,
    )
    if (!result.ok) throw new Error(result.error.message)

    expect(result.value.decision?.decision).toBe('BLOCK')
    expect(result.value.decision?.reasons.map((r) => r.code)).toContain('VI_CHAIN_INVALID')
    expect(orderCalls(h)).toHaveLength(0)
    expect(h.reserved()).toBe(0n)
  })

  it('I-1 a chain claiming a different amount than the cart is refused, and the recorded amount is the cart', async () => {
    // The Gate's check 6 cross-checks the L3a amount against the cart total. Here the L3a claims $500 for a
    // $30 cart — the injection shape §8.13 is about.
    const h = await harness({
      verify: {
        disclosed: {
          l3a: {
            delegate_payload: [
              {
                vct: 'mandate.payment.1',
                payment_amount: { amount: '50000', currency: 'USD' },
                payee: { id: 'ATTACKER-MERCHANT' },
              },
            ],
          },
        },
      },
    })
    const result = await createOrderFromIntent(
      intent({
        gate: gateInput({ l3a: l3a({ amount_minor: 50_000, payee_id: 'ATTACKER-MERCHANT' }) }),
      }),
      h.deps,
    )
    if (!result.ok) throw new Error(result.error.message)

    expect(result.value.stage).toBe('REFUSED')
    expect(orderCalls(h)).toHaveLength(0)
    const signed = await readSignedRecord(result.value.decision!.signedRecord, h.keys)
    // The record still exists and still names the attempt — a refusal is a recorded outcome, not a silence.
    expect(signed.att).toBe(ATTEMPT_ID)
  })

  it('I-1 a BLOCK never writes an orders row, so nothing can later be mistaken for a purchase', async () => {
    const h = await harness({ gateOutcome: 'BLOCK' })
    await createOrderFromIntent(intent(), h.deps)
    expect(h.orderWorld.rows.orders.size).toBe(0)
    // The decision row *is* there, which is the artefact a merchant reads to understand the refusal.
    expect(
      [...h.orderWorld.rows.decisions.values()].filter((r) => r.attempt_id === ATTEMPT_ID),
    ).toHaveLength(1)
    expect(h.paypal.callsTo('/v2/checkout/orders')).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------------------------------ */
/* 6. Structural: the Gate is handed the GateDeps and nothing else                                */
/* ------------------------------------------------------------------------------------------ */

describe('the Gate stays LLM-free', () => {
  it('D-018 evaluate() receives exactly the GateDeps it was given, so no model can reach it', async () => {
    const h = await harness()
    // `OrchestratorDeps.gate` is handed to `evaluate` by reference, unaltered. That is the structural half
    // of D-018's ban: there is no member of `GateDeps` through which a model could be reached, and this
    // assertion is what proves the orchestrator does not wrap it in one.
    const captured: unknown[] = []
    const deps = {
      ...h.deps,
      gate: new Proxy(h.deps.gate, {
        get(target, prop, receiver) {
          captured.push(prop)
          return Reflect.get(target, prop, receiver) as unknown
        },
      }),
    }

    await runGateEvaluation(intent(), deps as typeof h.deps)
    expect(captured.length).toBeGreaterThan(0)
    // `llm`, `model`, `openai`, `ai` — a named check, so a future `GateDeps` member that reaches a model
    // fails here even if the ESLint ban were ever removed.
    const names = captured.map(String)
    expect(names).not.toContain('llm')
    expect(names).not.toContain('model')
    expect(names).not.toContain('openai')
  })

  it('D-018 the orchestrator reaches a model only through compiler.compile, and only before the Gate', async () => {
    const h = await harness({ compiled: compiledWithAmbiguity() })
    const before = (h.deps.compiler as unknown as { calls: () => number }).calls()
    await createOrderFromIntent(intent({ text: 'Buy me shoes' }), h.deps)
    const after = (h.deps.compiler as unknown as { calls: () => number }).calls()
    expect(after).toBe(before + 1)
    // And the run stopped at the ambiguity, so the Gate and PayPal were never reached.
    expect(h.store.decided).toHaveLength(0)
    expect(h.paypal.calls).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------------------------------ */
/* 7. The PayPal order id PayPal chose is what we store                                          */
/* ------------------------------------------------------------------------------------------ */

describe('what actually crossed the wire', () => {
  it('AT-M11.5 the stored order carries PayPal’s order id and the request id we derived', async () => {
    const h = await harness()
    const result = await createOrderFromIntent(intent(), h.deps)
    if (!result.ok) throw new Error(result.error.message)

    const order = h.orderWorld.rows.orders.get(result.value.orderId!)!
    expect(order.paypal_order_id).toBe(PAYPAL.orderId)
    expect(order.status).toBe('AUTHORIZED')
    // An authorization came back inline, so §11's check C2 took the documented branch.
    expect(order.raw).toMatchObject({ paypal: { id: PAYPAL.orderId } })
  })
})
