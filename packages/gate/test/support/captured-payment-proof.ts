/** The untouched committed /v1/verify response driving evaluate, with in-memory repository ports. */
/* eslint-disable no-console */
import { readFileSync } from 'node:fs'
import { ok } from '@countersign/core'
import { verifyResponseSchema } from '@countersign/vi-client'
import { evaluate } from '../../src/evaluate'
import { input, makeWorld, withDeps } from '../fixtures'

export async function capturedPaymentProof(): Promise<void> {
  const capture = JSON.parse(
    readFileSync(new URL('../fixtures/vi-verify-budget-capture.json', import.meta.url), 'utf8'),
  ) as {
    verify_response: unknown
    verify_request: { l3a: string }
  }
  const response = verifyResponseSchema.parse(capture.verify_response)
  const checkoutHash = (
    response.disclosed.l3b['delegate_payload'] as Record<string, unknown>[]
  )[0]!['checkout_hash'] as string
  const agentKid = response.keys['agent_kid']
  if (typeof agentKid !== 'string') throw new Error('capture has no agent_kid')
  const world = await makeWorld({
    cartMinor: 13_300n,
    agent: { kid: agentKid },
    session: { merchant_id: 'mrc_northwind', checkout_hash: checkoutHash },
  })
  const result = await evaluate(
    input({ l3a: capture.verify_request.l3a }),
    withDeps(world, { verify: async () => ok(response) }),
  )
  if (!result.ok) throw new Error(result.error.message)
  console.log(
    'CAPTURE PROOF — untouched response; in-memory repositories; no fresh crypto verification',
  )
  console.log(`decision: ${result.value.decision}`)
  for (const n of [5, 6, 7, 8, 9]) {
    const check = result.value.checks.find((c) => c.n === n)!
    console.log(
      `check ${n}: ${check.notApplicable ? 'n/a' : check.passed ? 'PASS' : 'FAIL'} ${check.detail}`,
    )
    if (check.detail?.includes('no amount resolved'))
      throw new Error(`check ${n} still has no amount`)
    if (n === 6 && !check.passed) throw new Error('captured payment did not match the locked total')
    if (n === 7 && !check.passed) throw new Error('captured L3a replay id was not inserted')
  }
  if (!result.value.reasons.some((r) => r.code === 'GATE_BUDGET_EXCEEDED')) {
    throw new Error('the captured $130.00 signed budget did not block the $133.00 cart')
  }
  console.log(
    'CAPTURE PROOF: PASS — decision is BLOCK for the signed $130.00 budget versus $133.00 cart',
  )
}
