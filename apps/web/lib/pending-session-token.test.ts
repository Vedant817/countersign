/**
 * The pending-session token (`lib/pending-session-token.ts`).
 *
 * This token is what lets provisioning be split across a browser round trip: `prepareAgentSession`
 * seals its state into one, the buyer's browser signs the L2, and `finalizeAgentSession` opens it.
 * The four properties that make that safe, and that these tests pin:
 *
 *  1. **It round-trips.** What `sign` sealed is exactly what `verify` opens — every field, in order.
 *  2. **Tampered bytes are refused.** The MAC covers the payload, so a token with one payload's
 *     body and another token's signature fails with `CS_VALIDATION` — never a throw, and never a
 *     value the server treats as its own state.
 *  3. **Expired tokens are refused.** `exp` is checked after the signature verifies, so a prepared
 *     session that sat unsigned past its ten minutes cannot be finalised later.
 *  4. **A token is usable only by the buyer it was issued to.** A valid, live token naming another
 *     user id is `CS_FORBIDDEN` — the token is fine, this caller is not the one it belongs to.
 *  5. **A token is usable only for the prepare record it was sealed for.** `prepareAgentSession`
 *     puts vi's `prepare_id` inside the token, and `finalizeAgentSession` refuses a call whose
 *     `prepareId` is a different one — before vi or the database is touched. Without that check a
 *     token from one prepare could be spent against another run's prepare record.
 *
 * The secret comes from `SESSION_SECRET` exactly as `lib/session.ts` reads it, set per test so the
 * module's per-call read is what is under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as DbModule from '@countersign/db'
import type * as ViModule from '../app/lab/device-sign/vi'

/**
 * `finalizeAgentSession`'s two side-effecting dependencies are doubles: what these tests are about is
 * which of them a refused request reaches, and neither vi's HTTP nor Postgres is needed to see that.
 */
const db = vi.hoisted(() => ({
  createMandate: vi.fn(),
  openBudget: vi.fn(),
  setWalletCap: vi.fn(),
}))
vi.mock('@countersign/db', async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  ...db,
}))

const viStub = vi.hoisted(() => ({ finalizeL2: vi.fn() }))
vi.mock('../app/lab/device-sign/vi', async (importOriginal) => ({
  ...(await importOriginal<typeof ViModule>()),
  createViClient: () => viStub,
}))

import { finalizeAgentSession } from './agent-session'
import {
  PENDING_SESSION_TTL_SECONDS,
  signPendingSessionToken,
  verifyPendingSessionToken,
  type PendingAgentSession,
} from './pending-session-token'

const SECRET = 'test-session-secret-of-at-least-32-characters'
const USER = 'usr_pending_token_test' as never

/** A payload whose `exp` is always fresh, so a test never fails because the clock moved. */
function payload(overrides: Partial<PendingAgentSession> = {}): PendingAgentSession {
  const nowSec = Math.floor(Date.now() / 1000)
  return {
    prepareId: 'prepare_pending_test',
    mandateId: 'mdt_pending_test' as never,
    userId: USER,
    deviceId: 'dev_pending_test' as never,
    agentId: 'agt_pending_test' as never,
    agentKid: 'agent-key-1',
    walletId: 'wal_pending_test' as never,
    l2Payload: { aud: 'https://agent.countersign.test', cap: 5000 },
    intent: 'Buy running shoes under $50',
    readback: '**What you are authorising**\n\nA $50 cap.',
    constraints: [{ type: 'mandate.payment.amount_range', currency: 'USD', max: 5000 }],
    nonce: 'nonce-1',
    aud: 'https://agent.countersign.test',
    capMinor: '5000',
    compilerModel: 'test-compiler-model',
    expiresAtEpochSec: nowSec + 24 * 60 * 60,
    exp: nowSec + PENDING_SESSION_TTL_SECONDS,
    ...overrides,
  }
}

beforeEach(() => {
  process.env['SESSION_SECRET'] = SECRET
})

afterEach(() => {
  delete process.env['SESSION_SECRET']
})

describe('the pending session token', () => {
  it('round-trips every field the finalize phase needs', async () => {
    const sealed = payload()
    const signed = await signPendingSessionToken(sealed)
    expect(signed.ok).toBe(true)
    if (!signed.ok) return
    // Two segments, and the plaintext is not readable in the token: a space or a `$` can never
    // appear in base64url output, so the buyer's intent must be encoded, not embedded.
    expect(signed.value.split('.')).toHaveLength(2)
    expect(signed.value).not.toContain('Buy running shoes under $50')

    const verified = await verifyPendingSessionToken(signed.value, { userId: USER })
    expect(verified.ok).toBe(true)
    if (!verified.ok) return
    expect(verified.value).toEqual(sealed)
  })

  it('refuses a token whose payload and signature do not match', async () => {
    const first = await signPendingSessionToken(payload())
    expect(first.ok).toBe(true)
    if (!first.ok) return
    // A second, honest token provides a *valid* signature over *different* bytes: splicing the two
    // is exactly what an attacker who can read one token and hold another would produce.
    const second = await signPendingSessionToken(payload({ nonce: 'nonce-2' }))
    expect(second.ok).toBe(true)
    if (!second.ok) return

    const forged = `${first.value.split('.')[0]}.${second.value.split('.')[1]}`
    const verified = await verifyPendingSessionToken(forged, { userId: USER })
    expect(verified.ok).toBe(false)
    if (verified.ok) return
    expect(verified.error.code).toBe('CS_VALIDATION')
  })

  it('refuses an expired token even with a valid signature', async () => {
    const nowSec = Math.floor(Date.now() / 1000)
    const signed = await signPendingSessionToken(payload({ exp: nowSec - 1 }))
    expect(signed.ok).toBe(true)
    if (!signed.ok) return

    const verified = await verifyPendingSessionToken(signed.value, { userId: USER })
    expect(verified.ok).toBe(false)
    if (verified.ok) return
    expect(verified.error.code).toBe('CS_VALIDATION')
  })

  it('refuses a valid token presented by another buyer', async () => {
    const signed = await signPendingSessionToken(payload())
    expect(signed.ok).toBe(true)
    if (!signed.ok) return

    const verified = await verifyPendingSessionToken(signed.value, {
      userId: 'usr_someone_else' as never,
    })
    expect(verified.ok).toBe(false)
    if (verified.ok) return
    expect(verified.error.code).toBe('CS_FORBIDDEN')
  })
})

describe('finalizeAgentSession and the prepare id in the token', () => {
  beforeEach(() => {
    process.env['SESSION_SECRET'] = SECRET
    process.env['COUNTERSIGN_AGENT_DEMO'] = '1'
    process.env['VI_SERVICE_URL'] = 'https://vi.test'
    process.env['VI_SERVICE_TOKEN'] = 'test-token'
    viStub.finalizeL2.mockResolvedValue({
      ok: true,
      value: { iat: 1_700_000_000, exp: 1_700_003_600, l2: 'l2-serialized' },
    })
    db.createMandate.mockResolvedValue({ ok: true, value: { id: 'mdt_pending_test' } })
    db.openBudget.mockResolvedValue({ ok: true, value: {} })
    db.setWalletCap.mockResolvedValue({ ok: true, value: {} })
  })

  afterEach(() => {
    viStub.finalizeL2.mockReset()
    db.createMandate.mockReset()
    db.openBudget.mockReset()
    db.setWalletCap.mockReset()
    delete process.env['SESSION_SECRET']
    delete process.env['COUNTERSIGN_AGENT_DEMO']
    delete process.env['VI_SERVICE_URL']
    delete process.env['VI_SERVICE_TOKEN']
  })

  it('refuses a token given a prepare id it was not sealed for, before vi or the database is touched', async () => {
    const signed = await signPendingSessionToken(payload({ prepareId: 'prepare-A' }))
    expect(signed.ok).toBe(true)
    if (!signed.ok) return

    const result = await finalizeAgentSession({
      userId: USER,
      pending: signed.value,
      prepareId: 'prepare-B',
      signatureB64Url: 'c2lnbmF0dXJl',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_FORBIDDEN')
    // The refusal happens after the token is verified but before anything is spent: no vi call, no row.
    expect(viStub.finalizeL2).not.toHaveBeenCalled()
    expect(db.createMandate).not.toHaveBeenCalled()
  })

  it('finalises when the prepare id is the one the token names', async () => {
    const signed = await signPendingSessionToken(payload({ prepareId: 'prepare-A' }))
    expect(signed.ok).toBe(true)
    if (!signed.ok) return

    const result = await finalizeAgentSession({
      userId: USER,
      pending: signed.value,
      prepareId: 'prepare-A',
      signatureB64Url: 'c2lnbmF0dXJl',
    })

    expect(result.ok).toBe(true)
    expect(viStub.finalizeL2).toHaveBeenCalledWith({
      prepare_id: 'prepare-A',
      signature_b64url: 'c2lnbmF0dXJl',
    })
    expect(db.createMandate).toHaveBeenCalledTimes(1)
  })
})
