/**
 * QA3-GATE-1 (`critical`, confirmed by execution): the Gate signed an `ALLOW` for a checkout session
 * that does not exist.
 *
 * `loadSession` returned `null`, checks 5 through 10 each returned `notApplicable`,
 * `resolveOutcome` treated `notApplicable` as non-blocking, and the signed record carried
 * `amount: "0.00"`, `payee: ""`, `chain_valid: true`, no price lock and no reservation.
 *
 * No money moved, because `packages/orders::loadOrderDraft` re-reads the session and refuses. That is
 * a second line of defence catching the first line's failure, and it is not a design anyone would
 * choose — the signature is load-bearing. That `gate_decisions` row is the evidentiary spine of a
 * dispute packet, so a signed record asserting a valid chain over a nonexistent cart propagates into
 * evidence an adjudicator is told is cryptographically sound.
 *
 * The distinction these tests pin: **`notApplicable` means "nothing to enforce", never "could not
 * enforce".** A missing subject is a blocking `fail`.
 */
import { describe, expect, it } from 'vitest'

import { REQUIRED_FIELDS } from '../src/decision-record'
import { evaluate } from '../src/evaluate'
import { input, makeWorld } from './fixtures'

/** `evaluate` for the ghost cart, asserted to be a BLOCK, with the decision returned. */
async function ghostCart() {
  const world = await makeWorld()
  const result = await evaluate(input({ checkoutId: 'chk_nonexistent_ghost' }), world.deps)
  if (!result.ok) {
    throw new Error(`evaluate() failed unexpectedly: ${result.error.code}: ${result.error.message}`)
  }
  return result.value
}

describe('EC-MER-9: a missing checkout session cannot produce an ALLOW', () => {
  it('blocks, and names check 5 as the first failure', async () => {
    const decision = await ghostCart()

    expect(decision.decision).not.toBe('ALLOW')
    expect(decision.decision).toBe('BLOCK')

    // Check 5 is the root: every other cart check hangs off it.
    const five = decision.checks.find((c) => c.n === 5)
    expect(five?.passed).toBe(false)
    expect(five?.notApplicable).not.toBe(true)
    expect(five?.detail).toContain('checkout session')
  })

  it('signs no reservation over a cart that was never priced', async () => {
    const decision = await ghostCart()
    // The auditor observed a record with `amount: "0.00"` and `payee: ""` and `chain_valid: true`.
    // A BLOCK is the outcome; this asserts the other observable symptom is gone too.
    //
    // `undefined` rather than `null`: `evaluate` leaves `reservation` unset when nothing was
    // reserved, and asserting `null` here would be asserting a shape it never had.
    expect(decision.reservation ?? null).toBeNull()
  })

  it('signs absent values as null, never as a fabricated amount, currency or payee', async () => {
    // The world's default `signRecord` is a stub that does not emit a compact JWS, so this one runs with
    // a real key: the payload being asserted on is one an actual Ed25519 signature covers, not a string
    // a fake signer shaped for the occasion.
    const world = await makeWorld({ signWithRealKey: true })
    const result = await evaluate(input({ checkoutId: 'chk_nonexistent_ghost' }), world.deps)
    if (!result.ok) {
      throw new Error(
        `evaluate() failed unexpectedly: ${result.error.code}: ${result.error.message}`,
      )
    }
    const decision = result.value

    // The other half of this file's defect, which the header above names and the tests beside it did not
    // pin: the run correctly BLOCKS, but the signed record still asserted `amount: "0.00"`, `currency:
    // "USD"` and `payee: ""`. Those are not placeholders the verifier could recognise — `readRecordAmount`
    // parsed `"0.00"` as money and the public page printed a real `$0.00 USD` purchase to an empty payee,
    // and `verifyDecisionRecord` rejected only `undefined`, so the empty payee passed as valid evidence.
    //
    // A ghost cart has no amount, no currency and no payee. The only honest record says so.
    const payload = JSON.parse(
      Buffer.from(decision.signedRecord.split('.')[1]!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>

    expect(payload['amount']).toBeNull()
    expect(payload['currency']).toBeNull()
    expect(payload['payee']).toBeNull()

    // `null` must not become a *hole*. All nine §8.10 fields are still present, so the payload is still
    // structurally the decision record a dispute packet expects — it just no longer lies about the cart.
    for (const field of REQUIRED_FIELDS) {
      expect(payload[field], `${field} missing from the signed payload`).toBeDefined()
    }
  })

  it('every cart check that declines does so as a blocking fail, never notApplicable', async () => {
    const decision = await ghostCart()

    // This is the regression that matters. If any of 5-10 comes back `notApplicable` again the
    // fail-open is back, whatever the decision happens to be today.
    for (const n of [5, 6, 7, 8, 9, 10]) {
      const c = decision.checks.find((k) => k.n === n)
      expect(c, `check ${n} missing from the record`).toBeDefined()
      expect(c?.notApplicable, `check ${n} declined non-blockingly`).not.toBe(true)
    }
  })

  it('the refusal says "we could not check this", not "you spent too much"', async () => {
    const decision = await ghostCart()

    expect(decision.reasons.map((r) => r.code)).toContain('GATE_CHECK_UNSATISFIABLE')

    // A buyer must not be told they exceeded a limit when the real problem is that we could not look
    // at their cart. Conflating the two is how a support queue ends up arguing about money.
    const five = decision.checks.find((c) => c.n === 5)
    expect(five?.detail).not.toMatch(/exceed|budget|cap/i)
  })

  it('the same code path still ALLOWs a real cart', async () => {
    // A suite that only proves the attack would be useless, and a fix that blocked everything would
    // be a different bug.
    const world = await makeWorld()
    const result = await evaluate(input(), world.deps)
    if (!result.ok) throw new Error(`evaluate() failed: ${result.error.message}`)

    expect(result.value.decision).toBe('ALLOW')
    expect(result.value.reasons.map((r) => r.code)).not.toContain('GATE_CHECK_UNSATISFIABLE')

    const realFive = result.value.checks.find((c) => c.n === 5)
    expect(realFive?.passed).toBe(true)
    expect(realFive?.notApplicable).not.toBe(true)
  })

  it('a genuine "nothing to enforce" is still notApplicable, not a failure', async () => {
    // The legitimate case must survive. `input()` seeds no wallet cap row, so check 9 has nothing
    // to enforce — that is honest bookkeeping, and the fix must not turn it into a BLOCK.
    const world = await makeWorld()
    const result = await evaluate(input(), world.deps)
    if (!result.ok) throw new Error(`evaluate() failed: ${result.error.message}`)

    const nine = result.value.checks.find((c) => c.n === 9)
    expect(nine?.notApplicable).toBe(true)
    expect(nine?.passed).toBe(false)
  })
})

describe('the two "missing subject" helpers cannot drift apart', () => {
  it('checks 8 and 9 use the same code as checks 5-7 and 10', async () => {
    // `unsatisfiableBudget` in budget-guard.ts duplicates `missing()` in checks.ts, because checks.ts
    // imports budget-guard for checks 8 and 9 and an import back would be a cycle. A duplicate that
    // produces a different record would be a silent inconsistency in the signed decision, so the two
    // are asserted equal here rather than left to a comment.
    const decision = await ghostCart()

    const codes = new Set(
      decision.reasons.filter((r) => r.code === 'GATE_CHECK_UNSATISFIABLE').map((r) => r.code),
    )
    expect(codes.size).toBe(1)

    // Each check keeps its OWN code (5 is CHECKOUT_BINDING, 8 is BUDGET) — what must be identical is
    // the *reason* code, since that is what a reader of the signed record acts on.
    const blocking = decision.checks.filter(
      (c) => [5, 6, 7, 8, 9, 10].includes(c.n) && !c.passed && c.notApplicable !== true,
    )
    expect(blocking.length).toBeGreaterThan(0)
    expect(new Set(blocking.map((c) => c.code)).size).toBeGreaterThan(1)
    expect(decision.reasons.every((r) => r.code === 'GATE_CHECK_UNSATISFIABLE')).toBe(true)
  })
})
