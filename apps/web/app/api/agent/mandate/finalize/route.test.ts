/**
 * `POST /api/agent/mandate/finalize` — the buyer-scoped HTTP boundary for phase 2.
 *
 * `finalizeAgentSession` and the pending-session token are the subjects of `lib/pending-session-token.test.ts`.
 * What this file is about is the four things a boundary can get wrong, in the order the route decides them:
 *
 *  1. **Where the request came from.** A state-changing `POST` is same-origin only (S-17), before the body
 *     is even read.
 *  2. **Whose mandate it is.** The cookie decides, and the body gets no vote (D-060). An anonymous caller is
 *     401, a merchant is 403, and a `user_id` in the body changes nothing.
 *  3. **Whether the body is even a signature.** The three fields are checked for shape — a `signatureB64Url`
 *     with a character outside base64url is a 400 the client can fix, not a vi call.
 *  4. **What a refusal from the session function looks like on the wire.** Expired / malformed token is a
 *     400, a token minted for another buyer or another prepare record is a 403, and a missing mandate row is
 *     a 404 — the same map `prepare/route.ts` uses.
 *
 * `finalizeAgentSession` and `requireBuyer` are doubles: the subject here is the boundary, and neither vi's
 * HTTP nor Postgres is needed to see it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { err, ok } from '@countersign/core'

const agent = vi.hoisted(() => ({ finalizeAgentSession: vi.fn() }))
vi.mock('@/lib/agent-session', () => agent)

const auth = vi.hoisted(() => ({ requireBuyer: vi.fn() }))
vi.mock('@/lib/auth', () => auth)

import { POST } from './route'

const URL = 'http://localhost/api/agent/mandate/finalize'
const BUYER = { id: 'usr_buyer', persona: 'BUYER', displayName: 'asha', email: 'asha@example.test' }

/** A raw 64-byte P1363 signature, base64url — the shape the browser actually sends. */
const SIGNATURE = 'A'.repeat(86)

function req(body: unknown = {}, headers: Record<string, string> = {}): Request {
  return new Request(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pending: 'pending-token',
    prepareId: 'prepare_1',
    signatureB64Url: SIGNATURE,
    ...overrides,
  }
}

async function read(response: Response): Promise<{
  status: number
  body: Record<string, unknown> & { error?: { code: string; userMessage?: string } }
}> {
  return { status: response.status, body: (await response.json()) as never }
}

beforeEach(() => {
  vi.clearAllMocks()
  // The whole point of this route: no demo flag is read. The variable is removed rather than set to '0'
  // so a reader of the environment cannot accidentally satisfy a gate that must not exist.
  delete process.env.COUNTERSIGN_AGENT_DEMO
  auth.requireBuyer.mockResolvedValue(ok(BUYER))
  agent.finalizeAgentSession.mockResolvedValue(
    ok({
      userId: 'usr_buyer',
      walletId: 'wal_1',
      deviceId: 'dev_1',
      agentId: 'agt_1',
      mandateId: 'mdt_1',
      readback: '**What you are authorising**\n\nA $50 cap.',
      agentKid: 'agent-key-1',
      expiresAtEpochSec: 1_800_000_000,
      createdAtEpochSec: 1_799_996_400,
    }),
  )
})

afterEach(() => {
  delete process.env.COUNTERSIGN_AGENT_DEMO
})

describe('POST /api/agent/mandate/finalize', () => {
  it('finalises the mandate for the buyer the session names and the signature the request carries', async () => {
    const response = await POST(req(validBody()))
    const { status, body } = await read(response)
    expect(status).toBe(200)
    expect(body['user_id']).toBe('usr_buyer')
    expect(body['mandate_id']).toBe('mdt_1')
    expect(body['agent_id']).toBe('agt_1')
    expect(body['agent_kid']).toBe('agent-key-1')
    expect(body['readback']).toBe('**What you are authorising**\n\nA $50 cap.')
    expect(body['readback_summary']).toBe('A $50 cap.')
    expect(body['expires_at_epoch_sec']).toBe(1_800_000_000)
    expect(agent.finalizeAgentSession).toHaveBeenCalledWith({
      userId: BUYER.id,
      pending: 'pending-token',
      prepareId: 'prepare_1',
      signatureB64Url: SIGNATURE,
    })
  })

  it('works with COUNTERSIGN_AGENT_DEMO unset', async () => {
    expect(process.env.COUNTERSIGN_AGENT_DEMO).toBeUndefined()
    const response = await POST(req(validBody()))
    const { status } = await read(response)
    expect(status).toBe(200)
  })

  it('never echoes the pending token back, and never carries a secret field', async () => {
    const response = await POST(req(validBody()))
    const { status, body } = await read(response)
    expect(status).toBe(200)
    expect(body).not.toHaveProperty('pending')
    expect(body).not.toHaveProperty('pending_token')
    expect(body).not.toHaveProperty('signature')
    expect(body).not.toHaveProperty('l2')
    expect(body).not.toHaveProperty('enc_private_key')
  })

  it('ignores a user_id in the body and uses the cookie buyer', async () => {
    const response = await POST(
      req(validBody({ user_id: 'usr_someone_else', mandate_id: 'mdt_someone_else' })),
    )
    const { status } = await read(response)
    expect(status).toBe(200)
    expect(agent.finalizeAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ userId: BUYER.id }),
    )
    // The token and signature still count — only the claim about identity is dropped.
    expect(agent.finalizeAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ pending: 'pending-token', prepareId: 'prepare_1' }),
    )
  })

  it('refuses an anonymous request with 401 and calls nothing', async () => {
    auth.requireBuyer.mockResolvedValue(
      err({
        code: 'CS_UNAUTHENTICATED',
        message: 'A buyer sign-in is required for this route.',
        retryable: false,
      }),
    )
    const response = await POST(req(validBody()))
    const { status, body } = await read(response)
    expect(status).toBe(401)
    expect(body.error?.code).toBe('CS_UNAUTHENTICATED')
    expect(agent.finalizeAgentSession).not.toHaveBeenCalled()
  })

  it('refuses a merchant session with 403', async () => {
    auth.requireBuyer.mockResolvedValue(
      err({
        code: 'CS_FORBIDDEN',
        message: 'The signed-in account is a MERCHANT.',
        retryable: false,
      }),
    )
    const response = await POST(req(validBody()))
    const { status, body } = await read(response)
    expect(status).toBe(403)
    expect(body.error?.code).toBe('CS_FORBIDDEN')
    expect(agent.finalizeAgentSession).not.toHaveBeenCalled()
  })

  it('refuses a cross-origin request with 403 before reading the body', async () => {
    const response = await POST(req(validBody(), { origin: 'https://attacker.test' }))
    const { status, body } = await read(response)
    expect(status).toBe(403)
    expect(body.error?.code).toBe('CS_FORBIDDEN')
    expect(auth.requireBuyer).not.toHaveBeenCalled()
    expect(agent.finalizeAgentSession).not.toHaveBeenCalled()
  })

  it('refuses a body that is not JSON at all with 400', async () => {
    const response = await POST(
      new Request(URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'nope',
      }),
    )
    const { status, body } = await read(response)
    expect(status).toBe(400)
    expect(body.error?.code).toBe('CS_VALIDATION')
    expect(agent.finalizeAgentSession).not.toHaveBeenCalled()
  })

  it('refuses a malformed body with 400', async () => {
    for (const body of [
      {},
      { pending: 'pending-token', prepareId: 'prepare_1' },
      { pending: '   ', prepareId: 'prepare_1', signatureB64Url: SIGNATURE },
      { pending: 'pending-token', prepareId: '', signatureB64Url: SIGNATURE },
      { pending: 'pending-token', prepareId: 'prepare_1', signatureB64Url: '' },
    ]) {
      const response = await POST(req(body))
      const { status, body: read_ } = await read(response)
      expect(status).toBe(400)
      expect(read_.error?.code).toBe('CS_VALIDATION')
    }
    expect(agent.finalizeAgentSession).not.toHaveBeenCalled()
  })

  it('refuses a signature that is not base64url with 400, before vi is called', async () => {
    for (const signatureB64Url of [
      // Standard base64 alphabet: `+` and `/` are not base64url, and a browser never sends them.
      'abc+def/=',
      'abc$def',
      'a'.repeat(513),
    ]) {
      const response = await POST(req(validBody({ signatureB64Url })))
      const { status, body } = await read(response)
      expect(status).toBe(400)
      expect(body.error?.code).toBe('CS_VALIDATION')
    }
    expect(agent.finalizeAgentSession).not.toHaveBeenCalled()
  })

  it('answers 403 when the token was minted for a different buyer', async () => {
    // `finalizeAgentSession` refuses this against the cookie's buyer id, inside the token verification
    // (`lib/pending-session-token.ts:222`). The route's job is only to surface it as 403.
    agent.finalizeAgentSession.mockResolvedValue(
      err({
        code: 'CS_FORBIDDEN',
        message: 'The pending session belongs to usr_other, not to usr_buyer.',
        userMessage: 'That pending session does not belong to this browser.',
        retryable: false,
      }),
    )
    const response = await POST(req(validBody()))
    const { status, body } = await read(response)
    expect(status).toBe(403)
    expect(body.error?.code).toBe('CS_FORBIDDEN')
    expect(body.error?.userMessage).toBe('That pending session does not belong to this browser.')
  })

  it('answers 403 when the body prepareId is not the one the token names', async () => {
    agent.finalizeAgentSession.mockResolvedValue(
      err({
        code: 'CS_FORBIDDEN',
        message:
          'The pending session token names a different prepare record than the one this request finalises.',
        userMessage:
          'That pending session does not match this request. Start again from the beginning.',
        retryable: false,
      }),
    )
    const response = await POST(req(validBody({ prepareId: 'prepare_other' })))
    const { status, body } = await read(response)
    expect(status).toBe(403)
    expect(body.error?.code).toBe('CS_FORBIDDEN')
  })

  it('answers 400 when the token is expired', async () => {
    agent.finalizeAgentSession.mockResolvedValue(
      err({
        code: 'CS_VALIDATION',
        message: 'The pending session token expired at 1; now 2.',
        userMessage: 'The pending session expired. Start again from the beginning.',
        retryable: false,
      }),
    )
    const response = await POST(req(validBody()))
    const { status, body } = await read(response)
    expect(status).toBe(400)
    expect(body.error?.code).toBe('CS_VALIDATION')
    expect(body.error?.userMessage).toBe(
      'The pending session expired. Start again from the beginning.',
    )
  })

  it('answers 400 when the token is malformed', async () => {
    agent.finalizeAgentSession.mockResolvedValue(
      err({
        code: 'CS_VALIDATION',
        message: 'The pending session token is malformed: expected "<payload>.<signature>".',
        retryable: false,
      }),
    )
    const response = await POST(req(validBody({ pending: 'not-a-token' })))
    const { status, body } = await read(response)
    expect(status).toBe(400)
    expect(body.error?.code).toBe('CS_VALIDATION')
  })

  it('answers 404 when the mandate row cannot be written because its buyer is gone', async () => {
    agent.finalizeAgentSession.mockResolvedValue(
      err({
        code: 'CS_NOT_FOUND',
        message: 'This session names a buyer that does not exist.',
        retryable: false,
      }),
    )
    const response = await POST(req(validBody()))
    const { status } = await read(response)
    expect(status).toBe(404)
  })

  it('answers 400 when vi reports the signature does not match', async () => {
    // vi's own verdict, surfaced unchanged: a signature that does not verify against its prepare record is
    // a client error (packages/core/src/errors.ts:139), and the browser's remedy is a fresh prepare.
    agent.finalizeAgentSession.mockResolvedValue(
      err({
        code: 'VI_SIGNATURE_MISMATCH',
        message: 'The signature did not verify against the prepare record.',
        retryable: false,
      }),
    )
    const response = await POST(req(validBody({ signatureB64Url: 'A'.repeat(86) })))
    const { status, body } = await read(response)
    expect(status).toBe(400)
    expect(body.error?.code).toBe('VI_SIGNATURE_MISMATCH')
  })

  it('answers 503 when the deployment has no vi-service', async () => {
    agent.finalizeAgentSession.mockResolvedValue(
      err({
        code: 'CS_INTERNAL',
        message: 'VI_SERVICE_URL and VI_SERVICE_TOKEN must be set.',
        retryable: false,
      }),
    )
    const response = await POST(req(validBody()))
    const { status } = await read(response)
    expect(status).toBe(503)
  })
})
