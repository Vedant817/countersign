import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ok, type AttemptId } from '@countersign/core'
import { verifyResponseSchema } from '@countersign/vi-client'
import { decodeL3, merchantKeySetFromJwks } from '../src/decision-record'
import { evaluate } from '../src/evaluate'
import { deriveL3ReplayId } from '../src/replay-id'
import { readSignedCheckout } from '../src/signed-checkout'
import type { GateDecision, GateInput } from '../src/types'
import {
  fakeL3a,
  fakeL3b,
  input,
  makeWorld,
  resolvedTestL3b,
  signL3a,
  signL3b,
  testKeys,
  viSkipsBudget,
  withDeps,
} from './fixtures'

// Captured through real HTTP routes; never reconstruct the service's jti in this fixture.
const capture = z
  .object({
    verify_request: z.object({ l3a: z.string(), l3b: z.string(), checkout_jwt: z.string() }),
    verify_response: verifyResponseSchema,
    l3_create_response: z.object({
      l3a: z.string(),
      l3b: z.string(),
      jti: z.string(),
      checkout_hash: z.string(),
    }),
    jwks: z.object({ keys: z.array(z.record(z.string(), z.unknown())) }),
  })
  .parse(
    JSON.parse(
      readFileSync(new URL('./fixtures/vi-binding-replay-capture.json', import.meta.url), 'utf8'),
    ),
  )
const response = capture.verify_response
const l3 = capture.l3_create_response
const realInput = input({ l3a: l3.l3a, l3b: l3.l3b })

async function realWorld() {
  return makeWorld({
    agent: { kid: response.keys['agent_kid'] as string },
    session: {
      checkout_hash: l3.checkout_hash,
      checkout_jwt: capture.verify_request.checkout_jwt,
      merchant_id: 'mrc_northwind',
    },
    merchantKeys: merchantKeySetFromJwks(capture.jwks.keys),
  })
}

async function decide(
  world: Awaited<ReturnType<typeof realWorld>>,
  l3b: unknown = response.disclosed.l3b,
  request: GateInput = realInput,
): Promise<GateDecision> {
  const result = await evaluate(
    request,
    withDeps(world, {
      verify: async () =>
        ok({
          ...response,
          disclosed: { ...response.disclosed, l3b: l3b as Record<string, unknown> },
        }),
    }),
  )
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

function row(decision: GateDecision, n: number) {
  return decision.checks.find((c) => c.n === n)!
}

function checkout(hash: unknown): Record<string, unknown> {
  return { delegate_payload: [{ vct: 'mandate.checkout.1', checkout_hash: hash }] }
}

it('EC-PRICE-1: real disclosed L3b binding passes merchant key and signature checks', async () => {
  const world = await realWorld()
  const decision = await decide(world)
  expect(readSignedCheckout(response.disclosed.l3b)).toEqual({
    found: true,
    checkoutHash: l3.checkout_hash,
  })
  expect(row(decision, 5).passed).toBe(true)
  expect(row(decision, 5).detail).toContain('merchant kid merchant-key-1')
  expect(decision.decision).toBe('ALLOW')
  // Keeping the real disclosure while removing the accepted key or changing the merchant signature blocks.
  const untrusted = await realWorld()
  untrusted.deps.merchantKeys = async () => ok({ currentKid: 'other', acceptedKids: [], jwks: {} })
  expect(row(await decide(untrusted), 5).detail).toContain('neither the current')
  const badSignature = await realWorld()
  const session = await badSignature.deps.checkout(realInput.checkoutId)
  if (!session.ok || !session.value) throw new Error('missing test session')
  const parts = capture.verify_request.checkout_jwt.split('.')
  const signature = Buffer.from(parts[2]!, 'base64url')
  signature[0] = signature[0]! ^ 1
  const forged = {
    ...session.value,
    checkout_jwt: `${parts[0]}.${parts[1]}.${signature.toString('base64url')}`,
  }
  badSignature.deps.checkout = async () => ok(forged)
  expect(row(await decide(badSignature), 5).detail).toContain('signature')
})

it('EC-PRICE-1: disclosed checkout mismatch BLOCKs and names both opaque hashes without a token', async () => {
  const decision = await decide(await realWorld(), checkout('other-cart-hash'))
  expect(decision.decision).toBe('BLOCK')
  expect(row(decision, 5).passed).toBe(false)
  expect(row(decision, 5).detail).toContain('other-cart-hash')
  expect(row(decision, 5).detail).toContain(l3.checkout_hash)
  expect(row(decision, 5).detail).not.toContain(l3.l3b)
  expect(row(decision, 5).detail).not.toContain(capture.verify_request.checkout_jwt)
})

it('EC-PRICE-1: absent checkout disclosure blocks and never reports notApplicable', async () => {
  for (const absent of [
    null,
    {},
    { delegate_payload: [{ '...': 'unresolved' }] },
    checkout(''),
    checkout(17),
  ]) {
    const decision = await decide(await realWorld(), absent)
    expect(decision.decision).toBe('BLOCK')
    expect(row(decision, 5).passed).toBe(false)
    expect(row(decision, 5).notApplicable).not.toBe(true)
    expect(row(decision, 5).detail).toContain('verify.disclosed.l3b')
    expect(row(decision, 5).detail).toContain(l3.checkout_hash)
    expect(decision.reasons.map((r) => r.code)).toContain('GATE_CHECK_UNSATISFIABLE')
  }
})

it('EC-IDEM-1: Gate replay id equals real vi l3/create jti for the same signed L3a', async () => {
  expect(l3.l3a).toBe(capture.verify_request.l3a)
  expect(deriveL3ReplayId(l3.l3a)).toEqual(ok(l3.jti))
  // Disclosures are presentation bytes, outside the issuer signature and outside vi's replay id.
  expect(deriveL3ReplayId(l3.l3a.split('~')[0])).toEqual(ok(l3.jti))
  expect(deriveL3ReplayId(`${l3.l3a.split('~')[0]}~a-different-presentation~`)).toEqual(ok(l3.jti))
  const world = await realWorld()
  expect(row(await decide(world), 7).passed).toBe(true)
  expect(world.insertedAttempts[0]?.l3_jti).toBe(l3.jti)
})

it('EC-IDEM-1: the same real L3a twice returns GATE_REPLAY and never a second reservation', async () => {
  const world = await realWorld()
  expect((await decide(world)).decision).toBe('ALLOW')
  const version = world.snapshot().version
  const replay = await decide(world, response.disclosed.l3b, {
    ...realInput,
    attemptId: 'att_replay0000000000000000001' as AttemptId,
  })
  expect(replay.decision).toBe('BLOCK')
  expect(replay.reasons.map((r) => r.code)).toContain('GATE_REPLAY')
  expect(row(replay, 7).passed).toBe(false)
  expect(replay.reservation).toBeUndefined()
  expect(world.insertedAttempts).toHaveLength(1)
  expect(world.reservations).toHaveLength(1)
  expect(world.releases).toHaveLength(0)
  expect(world.snapshot().reserved).toBe(3_000n)
  expect(world.snapshot().version).toBe(version)
})

it('EC-MER-2: simultaneous identical real L3a submissions admit one atomic insert and one reservation', async () => {
  const world = await realWorld()
  const decisions = await Promise.all(
    [0, 1].map((i) =>
      decide(world, response.disclosed.l3b, {
        ...realInput,
        attemptId: `att_parallel${i}` as AttemptId,
      }),
    ),
  )
  expect(decisions.map((d) => d.decision).sort()).toEqual(['ALLOW', 'BLOCK'])
  expect(decisions.filter((d) => d.reasons.some((r) => r.code === 'GATE_REPLAY'))).toHaveLength(1)
  expect(world.insertedAttempts).toHaveLength(1)
  expect(world.reservations).toHaveLength(1)
})

it('EC-IDEM-1: malformed or non-ASCII issuer bytes fail closed before an attempt insert', async () => {
  for (const invalid of [null, '', ' ', 'a.b', 'a.b.', 'é.b.c', ` ${l3.l3a}`]) {
    expect(deriveL3ReplayId(invalid).ok).toBe(false)
  }
  const world = await realWorld()
  const decision = await decide(world, response.disclosed.l3b, { ...realInput, l3a: 'é.b.c' })
  expect(decision.decision).toBe('BLOCK')
  expect(row(decision, 7).passed).toBe(false)
  expect(world.insertedAttempts).toHaveLength(0)
})

it('EC-MA-1: QA-gate-1 regression: signed $20.00 budget with $30.00 cart BLOCKs', async () => {
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

it('EC-IDEM-1: fixtures match the real dependency for checkout disclosure and absent jti claims', async () => {
  const realA = decodeL3(l3.l3a)
  const realB = decodeL3(l3.l3b)
  if (!realA.ok || !realB.ok) throw new Error('invalid capture')
  expect(realA.claims).not.toHaveProperty('jti')
  expect(realB.claims).not.toHaveProperty('checkout_hash')
  const keys = await testKeys()
  for (const token of [fakeL3a(), await signL3a(keys.agent.key)]) {
    const decoded = decodeL3(token)
    if (!decoded.ok) throw new Error(decoded.error)
    expect(Object.hasOwn(decoded.claims, 'jti')).toBe(Object.hasOwn(realA.claims, 'jti'))
  }
  for (const token of [
    fakeL3b(l3.checkout_hash),
    await signL3b(keys.agent.key, l3.checkout_hash),
  ]) {
    const decoded = decodeL3(token)
    if (!decoded.ok) throw new Error(decoded.error)
    expect(Object.hasOwn(decoded.claims, 'checkout_hash')).toBe(
      Object.hasOwn(realB.claims, 'checkout_hash'),
    )
    expect(readSignedCheckout(resolvedTestL3b(token))).toEqual(
      readSignedCheckout(response.disclosed.l3b),
    )
    expect(decoded.claims['delegate_payload']).toEqual(
      expect.arrayContaining([expect.objectContaining({ '...': expect.any(String) })]),
    )
  }
})

describe('EC-PRICE-1: checkout reader refuses ambiguity and preserves opaque values', () => {
  it('EC-PRICE-1: duplicate mandates are unreadable; opaque strings are not normalised', () => {
    expect(
      readSignedCheckout({
        delegate_payload: [checkout('a')['delegate_payload'], checkout('b')['delegate_payload']],
      }).found,
    ).toBe(false)
    expect(
      readSignedCheckout({
        delegate_payload: [
          { vct: 'mandate.checkout.1', checkout_hash: 'a' },
          { vct: 'mandate.checkout.1', checkout_hash: 'b' },
        ],
      }).found,
    ).toBe(false)
    expect(readSignedCheckout(checkout(' opaque '))).toEqual({
      found: true,
      checkoutHash: ' opaque ',
    })
  })
})
