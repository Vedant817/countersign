/**
 * `lib/agent-intent.ts` — the gate that refuses to sign an ambiguous intent.
 *
 * Two subjects, one file:
 *
 *  1. **The pure gate.** `assertNoAmbiguities` takes the compiled mandate and returns `ok` only when the
 *     compiler has no open question. An ambiguous value is a `CS_VALIDATION` whose buyer-facing sentence is
 *     the compiler's own `question`, verbatim (spec §8.8 — a paraphrase would be a promise the buyer did
 *     not make).
 *  2. **The ordering guarantee.** `prepareAgentSession` calls the gate *before* it mirrors vi's keys,
 *     resolves a wallet, mints an agent key, issues an L1 or calls `l2/prepare`. So a refusal here reaches
 *     no vi client and writes no row — which is the defect this commit removes: an intent with no stated
 *     limit used to be signed at the client's default cap.
 *
 * The integration test mocks the three side-effecting dependencies the prepare path touches before the
 * gate (`findUserById`, `merchantIdentity`, `compileIntent`) and the vi client, then asserts the refusal
 * stops the pipeline before any vi call or write.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ok } from '@countersign/core'
import type { CompiledMandate, VIConstraint } from '@countersign/compiler'

import { assertNoAmbiguities } from './agent-intent'
import { applyCap } from './apply-cap'
import type { MerchantIdentity } from './merchant'

const MERCHANT: MerchantIdentity = {
  id: 'mer_northwind',
  name: 'Northwind Outfitters',
  website: 'https://shop.test',
}

const AMOUNT_RANGE: VIConstraint = {
  type: 'mandate.payment.amount_range',
  currency: 'USD',
  max: 5000n,
}
const BUDGET: VIConstraint = { type: 'mandate.payment.budget', currency: 'USD', max: 5000n }

function compiled(ambiguities: CompiledMandate['ambiguities'] = []): CompiledMandate {
  return {
    currency: 'USD',
    constraints: [AMOUNT_RANGE, BUDGET],
    ttlSeconds: 604800,
    expiresAtEpochSec: 1_800_000_000,
    preferences: {},
    assumptions: [],
    ambiguities,
  }
}

describe('assertNoAmbiguities', () => {
  it('passes a mandate with no open question', () => {
    const result = assertNoAmbiguities(compiled())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The gate is the identity on a ready mandate: it does not rewrite the value it clears.
    expect(result.value.constraints).toHaveLength(2)
  })

  it('refuses a mandate with one question, naming it as the buyer-facing sentence', () => {
    const result = assertNoAmbiguities(
      compiled([
        {
          field: 'amount_range.max',
          question: 'What is the most you would like to spend?',
          options: ['$50', '$80', '$120'],
        },
      ]),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_VALIDATION')
    // The userMessage is the compiler's own question, verbatim — not a paraphrase.
    expect(result.error.userMessage).toBe('What is the most you would like to spend?')
    // The operator-facing message still names the field being asked about.
    expect(result.error.message).toContain('amount_range.max')
  })

  it('refuses with the first question when there are several', () => {
    const result = assertNoAmbiguities(
      compiled([
        {
          field: 'amount_range.max',
          question: 'What is your ceiling?',
          options: [],
        },
        {
          field: 'merchant',
          question: 'Which store should I buy from?',
          options: [],
        },
      ]),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.userMessage).toBe('What is your ceiling?')
  })
})

describe('the compiled cap is a ceiling, never the only limit (applyCap after the gate)', () => {
  it('clamps a compiled max above the cap down to the cap', () => {
    const withHighMax: VIConstraint[] = [
      { type: 'mandate.payment.amount_range', currency: 'USD', max: 8000n },
      { type: 'mandate.payment.budget', currency: 'USD', max: 8000n },
    ]
    const result = applyCap(withHighMax, 5000n, MERCHANT)
    const amountRange = result.find((c) => c.type === 'mandate.payment.amount_range')
    const budget = result.find((c) => c.type === 'mandate.payment.budget')
    expect(amountRange?.type === 'mandate.payment.amount_range' && amountRange.max).toBe(5000n)
    expect(budget?.type === 'mandate.payment.budget' && budget.max).toBe(5000n)
  })

  it('keeps a compiled max below the cap (the buyer stated a tighter limit)', () => {
    const withLowMax: VIConstraint[] = [
      { type: 'mandate.payment.amount_range', currency: 'USD', max: 4000n },
      { type: 'mandate.payment.budget', currency: 'USD', max: 4000n },
    ]
    const result = applyCap(withLowMax, 5000n, MERCHANT)
    const amountRange = result.find((c) => c.type === 'mandate.payment.amount_range')
    expect(amountRange?.type === 'mandate.payment.amount_range' && amountRange.max).toBe(4000n)
  })
})

// ---------------------------------------------------------------------------------------------
// The ordering guarantee: the gate runs before any vi call or DB write.
// ---------------------------------------------------------------------------------------------

type DbModule = typeof import('@countersign/db')
type ViModule = typeof import('../app/lab/device-sign/vi')
type IntentModule = typeof import('./intent-compiler')
type MerchantModule = typeof import('./merchant')

const db = vi.hoisted(() => ({
  findUserById: vi.fn(),
  listWalletsForUser: vi.fn(),
  createDevice: vi.fn(),
  createAgent: vi.fn(),
  upsertL1Credential: vi.fn(),
  createMandate: vi.fn(),
  openBudget: vi.fn(),
  setWalletCap: vi.fn(),
}))
vi.mock('@countersign/db', async (importOriginal) => ({
  ...(await importOriginal<DbModule>()),
  ...db,
}))

const viClient = vi.hoisted(() => ({
  mintAgentKey: vi.fn(),
  issueL1: vi.fn(),
  prepareL2: vi.fn(),
  finalizeL2: vi.fn(),
  jwks: vi.fn(),
}))
vi.mock('../app/lab/device-sign/vi', async (importOriginal) => ({
  ...(await importOriginal<ViModule>()),
  createViClient: () => viClient,
}))

const intent = vi.hoisted(() => ({ compileIntent: vi.fn() }))
vi.mock('./intent-compiler', async (importOriginal) => ({
  ...(await importOriginal<IntentModule>()),
  ...intent,
}))

const merchant = vi.hoisted(() => ({ merchantIdentity: vi.fn() }))
vi.mock('./merchant', async (importOriginal) => ({
  ...(await importOriginal<MerchantModule>()),
  ...merchant,
}))

import { prepareAgentSession } from './agent-session'

const DEVICE_JWK: JsonWebKey = {
  kty: 'EC',
  crv: 'P-256',
  x: 'f83e1f7c1e0e5b2a9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e',
  y: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
}
// `deviceThumbprint` is real; the kid is `dev_<jkt>`. We do not need a real key here because the gate
// refuses before the device is resolved — but the input still has to be well-shaped.
const DEVICE_KID = 'dev_not_reached'

const BASE_ENV = {
  COUNTERSIGN_AGENT_DEMO: '1',
  NODE_ENV: 'test',
  VI_SERVICE_URL: 'https://vi.test',
  VI_SERVICE_TOKEN: 'test-token',
}

describe('prepareAgentSession refuses an ambiguous intent before any vi call or DB write', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(process.env, BASE_ENV)
    db.findUserById.mockResolvedValue(ok({ id: 'usr_buyer', persona: 'BUYER' }))
    merchant.merchantIdentity.mockReturnValue(ok(MERCHANT))
  })

  it('returns the compiler question as CS_VALIDATION and touches neither vi nor the database', async () => {
    intent.compileIntent.mockResolvedValue(
      ok(
        compiled([
          {
            field: 'amount_range.max',
            question: 'What is the most you would like to spend?',
            options: ['$50', '$80'],
          },
        ]),
      ),
    )

    const result = await prepareAgentSession({
      userId: 'usr_buyer' as never,
      intent: 'something warm for the trip',
      capMinor: 5000n,
      devicePublicJwk: DEVICE_JWK,
      deviceKid: DEVICE_KID,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_VALIDATION')
    expect(result.error.userMessage).toBe('What is the most you would like to spend?')

    // No vi call: the key mirror, the agent key, the L1 and the L2 prepare are all downstream of the gate.
    expect(viClient.jwks).not.toHaveBeenCalled()
    expect(viClient.mintAgentKey).not.toHaveBeenCalled()
    expect(viClient.issueL1).not.toHaveBeenCalled()
    expect(viClient.prepareL2).not.toHaveBeenCalled()
    // No write: the mandate, budget and wallet cap are written by finalize, and nothing else was written.
    expect(db.createDevice).not.toHaveBeenCalled()
    expect(db.createAgent).not.toHaveBeenCalled()
    expect(db.upsertL1Credential).not.toHaveBeenCalled()
    expect(db.createMandate).not.toHaveBeenCalled()
    expect(db.openBudget).not.toHaveBeenCalled()
    expect(db.setWalletCap).not.toHaveBeenCalled()
  })

  it('lets a mandate with a stated limit through the gate (a non-ambiguous intent proceeds)', async () => {
    intent.compileIntent.mockResolvedValue(ok(compiled()))
    // The key sync runs first (no keys yet), then the wallet lookup. We give it no wallet so the pipeline
    // stops at the wallet check with CS_CONFLICT — proof it got past the gate rather than being refused
    // there. What matters is the code it returns: never the gate's CS_VALIDATION.
    viClient.jwks.mockResolvedValue(ok({ keys: [] }))
    db.listWalletsForUser.mockResolvedValue(ok([]))

    const result = await prepareAgentSession({
      userId: 'usr_buyer' as never,
      intent: 'Buy running shoes under $50',
      capMinor: 5000n,
      devicePublicJwk: DEVICE_JWK,
      deviceKid: DEVICE_KID,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    // The gate cleared: the refusal is the wallet, not the intent.
    expect(result.error.code).toBe('CS_CONFLICT')
    // And the key sync — the first vi call after the gate — ran, which only happens past the gate.
    expect(viClient.jwks).toHaveBeenCalled()
  })
})
