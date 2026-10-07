import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { ok } from '@countersign/core'
import { verifyResponseSchema } from '@countersign/vi-client'
import { evaluate } from '../src/evaluate'
import { input, makeWorld, viSkipsBudget, withDeps } from './fixtures'
import { readSignedPayment } from '../src/signed-payment'
import type { GateDecision } from '../src/types'

const capture = JSON.parse(
  readFileSync(new URL('./fixtures/vi-verify-budget-capture.json', import.meta.url), 'utf8'),
) as { verify_response: unknown; verify_request: { l3a: string } }
const response = verifyResponseSchema.parse(capture.verify_response)

async function decide(l3a: unknown): Promise<GateDecision> {
  const world = await makeWorld({ cartMinor: 13_300n, session: { merchant_id: 'mrc_northwind' } })
  const result = await evaluate(
    input(),
    withDeps(world, {
      verify: async () =>
        ok({
          ...response,
          disclosed: { ...response.disclosed, l3a: l3a as Record<string, unknown> },
        }),
    }),
  )
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

function changedPayment(patch: Record<string, unknown>): Record<string, unknown> {
  const l3a = structuredClone(response.disclosed.l3a)
  const delegates = l3a['delegate_payload'] as Record<string, unknown>[]
  delegates[1] = { ...delegates[1], ...patch }
  return l3a
}

function check6(decision: GateDecision) {
  return decision.checks.find((c) => c.n === 6)!
}

it('EC-PRICE-1: captured disclosed $133.00 matches the locked $133.00; checks 7/8/9 have an amount', async () => {
  const world = await makeWorld({ cartMinor: 13_300n, session: { merchant_id: 'mrc_northwind' } })
  const result = await evaluate(
    input({ l3a: capture.verify_request.l3a }),
    withDeps(world, { verify: async () => ok(response) }),
  )
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.error.message)
  expect(result.value.checks.find((c) => c.n === 6)?.passed).toBe(true)
  for (const n of [7, 8, 9]) {
    expect(result.value.checks.find((c) => c.n === n)?.detail).not.toContain('no amount resolved')
  }
  // The unmodified capture signs a $130.00 budget: its $133.00 payment must still BLOCK.
  expect(result.value.decision).toBe('BLOCK')
  expect(result.value.reasons.map((r) => r.code)).toContain('GATE_BUDGET_EXCEEDED')
})

it('EC-PRICE-1: disclosed amount mismatch BLOCKs and names both minor-unit amounts', async () => {
  const decision = await decide(
    changedPayment({ payment_amount: { amount: 13_301, currency: 'USD' } }),
  )
  expect(decision.decision).toBe('BLOCK')
  expect(check6(decision).passed).toBe(false)
  expect(check6(decision).detail).toBe(
    'Session chk_0000000000000000000000000A total 13300 != L3a amount 13301',
  )
})

it('EC-FX-1: disclosed currency mismatch BLOCKs with CS_CURRENCY_MISMATCH and no conversion', async () => {
  const decision = await decide(
    changedPayment({ payment_amount: { amount: 13_300, currency: 'INR' } }),
  )
  expect(decision.decision).toBe('BLOCK')
  expect(check6(decision).passed).toBe(false)
  expect(check6(decision).detail).toContain('USD; L3a amount is INR')
  expect(decision.reasons.map((r) => r.code)).toContain('CS_CURRENCY_MISMATCH')
  expect(decision.reasons.find((r) => r.code === 'CS_CURRENCY_MISMATCH')?.userMessage).toContain(
    'did not convert',
  )
})

it('EC-AGT-2: disclosed payee mismatch BLOCKs and names both merchants', async () => {
  const decision = await decide(changedPayment({ payee: { id: 'mrc_other' } }))
  expect(decision.decision).toBe('BLOCK')
  expect(check6(decision).passed).toBe(false)
  expect(check6(decision).detail).toContain('payee mrc_other')
  expect(check6(decision).detail).toContain('merchant mrc_northwind')
  expect(decision.checks.find((c) => c.n === 5)?.detail).toContain('payee mrc_other')
})

it('EC-AGT-2: absent disclosed.l3a BLOCKs check 4 and check 6, never notApplicable', async () => {
  for (const absent of [undefined, null]) {
    const decision = await decide(absent)
    expect(decision.decision).toBe('BLOCK')
    for (const n of [4, 6]) {
      const check = decision.checks.find((c) => c.n === n)!
      expect(check.passed).toBe(false)
      expect(check.notApplicable).not.toBe(true)
      expect(check.detail).toContain('verify.disclosed.l3a')
    }
  }
})

it('EC-AGT-1: QA-gate-1 signed $20.00 budget with $30.00 cart still BLOCKs', async () => {
  const world = await makeWorld({
    cartMinor: 3_000n,
    capMinor: 20_000n,
    verify: viSkipsBudget(2_000n),
  })
  const result = await evaluate(input(), world.deps)
  if (!result.ok) throw new Error(result.error.message)
  expect(result.value.checks.find((c) => c.n === 6)?.passed).toBe(true)
  expect(result.value.decision).toBe('BLOCK')
  expect(result.value.reasons.map((r) => r.code)).toContain('GATE_BUDGET_EXCEEDED')
  expect(world.snapshot().reserved).toBe(0n)
})

it('EC-FX-5: malformed disclosed amounts, currency and payee fail closed; exact integers stay exact', async () => {
  for (const raw of [
    undefined,
    null,
    13300.5,
    -1,
    Number.MAX_SAFE_INTEGER + 1,
    '133.00',
    'x',
    {},
    true,
  ]) {
    const decision = await decide(
      changedPayment({ payment_amount: { amount: raw, currency: 'USD' } }),
    )
    expect(check6(decision).passed).toBe(false)
    expect(check6(decision).detail).toContain('payment_amount.amount')
    expect(decision.decision).toBe('BLOCK')
  }
  for (const patch of [
    { payment_amount: undefined },
    { payment_amount: { amount: 13_300 } },
    { payment_amount: { amount: 13_300, currency: 'XXX' } },
    { payee: undefined },
    { payee: {} },
    { payee: { id: '' } },
  ]) {
    const decision = await decide(changedPayment(patch))
    expect(check6(decision).passed).toBe(false)
    expect(decision.decision).toBe('BLOCK')
    expect(check6(decision).detail).toMatch(/payment_amount|payee/)
  }
  expect(
    readSignedPayment(
      changedPayment({ payment_amount: { amount: '9007199254740993', currency: 'USD' } }),
    ),
  ).toMatchObject({ found: true, amount: { minor: 9007199254740993n, currency: 'USD' } })
  const exact = await decide(
    changedPayment({ payment_amount: { amount: '13300', currency: 'USD' } }),
  )
  expect(check6(exact).passed).toBe(true)
  // Flat claims and unresolved hash slots never substitute for vi's disclosed payment.
  for (const l3a of [
    { amount_minor: 13300, currency: 'USD', payee_id: 'mrc_northwind' },
    { delegate_payload: [{ '...': 'unresolved' }] },
    { delegate_payload: [{ vct: 'mandate.payment.1' }, { vct: 'mandate.payment.1' }] },
  ]) {
    expect(readSignedPayment(l3a).found).toBe(false)
  }
})
