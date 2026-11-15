/**
 * `POST /api/agent/mandate/prepare` — the buyer-scoped HTTP boundary for phase 1.
 *
 * The pipeline is `lib/agent-session.test.ts`'s subject. What this file is about is the four things a
 * boundary can get wrong, in the order the route decides them:
 *
 *  1. **Where the request came from.** A state-changing `POST` is same-origin only (S-17), before the body
 *     is even read.
 *  2. **Whose mandate it is.** The cookie decides, and the body gets no vote (D-060). An anonymous caller
 *     is 401, a merchant is 403, and a `user_id` in the body changes nothing.
 *  3. **Whether the device key is the one it claims to be.** `deviceKid` must be
 *     `dev_<thumbprint of the key it arrived with>`; a mismatch is a 400 the buyer can fix by reloading,
 *     and it is refused before vi is called.
 *  4. **Whether there is a demo gate.** There is not: the route works with `COUNTERSIGN_AGENT_DEMO` unset,
 *     because a signed-in buyer with no demo flag is exactly the caller it exists for.
 *
 * `prepareAgentSession` and `requireBuyer` are doubles: the subject here is the boundary, and neither vi's
 * HTTP nor Postgres is needed to see it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { err, ok } from '@countersign/core'

const agent = vi.hoisted(() => ({ prepareAgentSession: vi.fn() }))
vi.mock('@/lib/agent-session', () => agent)

const auth = vi.hoisted(() => ({ requireBuyer: vi.fn() }))
vi.mock('@/lib/auth', () => auth)

// A fixed thumbprint: the route's job is to compare `deviceKid` with `dev_<jkt>`, not to compute a
// thumbprint (that is `device-thumbprint.test.ts`'s subject).
const thumb = vi.hoisted(() => ({ deviceThumbprint: vi.fn() }))
vi.mock('@/lib/device-thumbprint', () => thumb)

import { POST } from './route'

const URL = 'http://localhost/api/agent/mandate/prepare'
const JKT = 'f83e1f7c1e0e5b2a9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e'
const DEVICE_KID = `dev_${JKT}`
const BUYER = { id: 'usr_buyer', persona: 'BUYER', displayName: 'asha', email: 'asha@example.test' }

const DEVICE_JWK = {
  kty: 'EC',
  crv: 'P-256',
  // A real P-256 point: the coordinates must be 43-character base64url (32 bytes) or
  // `publicJwkSchema` refuses them before the route ever sees them.
  x: 'O4FtJe276NHEecbpaZH18gKk9elqvIWCVIskodeuvRU',
  y: 'Ub3ywThuUxNRzlQ_KlC8tmSATIC6CymFmdoVWTNvLVk',
}

function req(body: unknown = {}, headers: Record<string, string> = {}): Request {
  return new Request(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intent: 'Buy running shoes under $50',
    cap_minor: 5000,
    deviceKid: DEVICE_KID,
    devicePublicJwk: DEVICE_JWK,
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
  thumb.deviceThumbprint.mockResolvedValue(JKT)
  auth.requireBuyer.mockResolvedValue(ok(BUYER))
  agent.prepareAgentSession.mockResolvedValue(
    ok({
      prepareId: 'prepare_1',
      signingInput: 'header.payload',
      pending: 'pending-token',
      readback: '**What you are authorising**\n\nA $50 cap.',
      expiresAtEpochSec: 1_800_000_000,
    }),
  )
})

afterEach(() => {
  delete process.env.COUNTERSIGN_AGENT_DEMO
})

describe('POST /api/agent/mandate/prepare', () => {
  it('prepares the mandate for the buyer the session names and the device key the request carries', async () => {
    const response = await POST(req(validBody()))
    const { status, body } = await read(response)
    expect(status).toBe(200)
    expect(body['prepareId']).toBe('prepare_1')
    expect(body['signingInput']).toBe('header.payload')
    expect(body['readback']).toBe('**What you are authorising**\n\nA $50 cap.')
    expect(body['readback_summary']).toBe('A $50 cap.')
    expect(body['cap_display']).toBe('$50.00')
    expect(body['expires_at_epoch_sec']).toBe(1_800_000_000)
    expect(body['pending']).toBe('pending-token')
    expect(agent.prepareAgentSession).toHaveBeenCalledWith({
      userId: BUYER.id,
      intent: 'Buy running shoes under $50',
      capMinor: 5000n,
      devicePublicJwk: DEVICE_JWK,
      deviceKid: DEVICE_KID,
    })
  })

  it('works with COUNTERSIGN_AGENT_DEMO unset', async () => {
    expect(process.env.COUNTERSIGN_AGENT_DEMO).toBeUndefined()
    const response = await POST(req(validBody()))
    const { status } = await read(response)
    expect(status).toBe(200)
  })

  it('ignores a user_id in the body and uses the cookie buyer', async () => {
    const response = await POST(
      req(validBody({ user_id: 'usr_someone_else', intent: 'Buy shoes under $20' })),
    )
    const { status } = await read(response)
    expect(status).toBe(200)
    expect(agent.prepareAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ userId: BUYER.id }),
    )
    // The body's sentence still counts — only its claim about identity is dropped.
    expect(agent.prepareAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ intent: 'Buy shoes under $20' }),
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
    expect(agent.prepareAgentSession).not.toHaveBeenCalled()
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
    expect(agent.prepareAgentSession).not.toHaveBeenCalled()
  })

  it('refuses a cross-origin request with 403 before reading the body', async () => {
    const response = await POST(req(validBody(), { origin: 'https://attacker.test' }))
    const { status, body } = await read(response)
    expect(status).toBe(403)
    expect(body.error?.code).toBe('CS_FORBIDDEN')
    expect(auth.requireBuyer).not.toHaveBeenCalled()
    expect(agent.prepareAgentSession).not.toHaveBeenCalled()
  })

  it('refuses a malformed body with 400', async () => {
    for (const body of [
      {},
      { intent: 'Buy shoes', cap_minor: 5000, deviceKid: DEVICE_KID },
      { intent: '   ', cap_minor: 5000, deviceKid: DEVICE_KID, devicePublicJwk: DEVICE_JWK },
      { intent: 'Buy shoes', cap_minor: 0, deviceKid: DEVICE_KID, devicePublicJwk: DEVICE_JWK },
      { intent: 'Buy shoes', cap_minor: 1.5, deviceKid: DEVICE_KID, devicePublicJwk: DEVICE_JWK },
      {
        intent: 'Buy shoes',
        cap_minor: 5000,
        deviceKid: DEVICE_KID,
        devicePublicJwk: { kty: 'RSA' },
      },
    ]) {
      const response = await POST(req(body))
      const { status, body: read_ } = await read(response)
      expect(status).toBe(400)
      expect(read_.error?.code).toBe('CS_VALIDATION')
    }
    expect(agent.prepareAgentSession).not.toHaveBeenCalled()
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
  })

  it('refuses a deviceKid that is not the thumbprint of the key it arrived with', async () => {
    const response = await POST(req(validBody({ deviceKid: 'dev_not_the_same_key' })))
    const { status, body } = await read(response)
    expect(status).toBe(400)
    expect(body.error?.code).toBe('CS_VALIDATION')
    expect(body.error?.userMessage).toBe(
      'The device key does not match its id. Refresh the page and try again.',
    )
    expect(agent.prepareAgentSession).not.toHaveBeenCalled()
  })

  it('answers 404 when the cookie names a row that is gone', async () => {
    agent.prepareAgentSession.mockResolvedValue(
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

  it('answers 409 when the buyer has no saved PayPal wallet', async () => {
    agent.prepareAgentSession.mockResolvedValue(
      err({
        code: 'CS_CONFLICT',
        message: 'The buyer has no saved PayPal payment method.',
        retryable: false,
      }),
    )
    const response = await POST(req(validBody()))
    const { status, body } = await read(response)
    expect(status).toBe(409)
    expect(body.error?.code).toBe('CS_CONFLICT')
  })

  it('answers 400 with the compiler question when the intent is ambiguous', async () => {
    // The gate in `lib/agent-intent.ts` refuses an intent with an open question before any vi call or
    // write; the route's job is only to surface that as a 400 the buyer can fix by rephrasing.
    agent.prepareAgentSession.mockResolvedValue(
      err({
        code: 'CS_VALIDATION',
        message: 'The intent is not ready to sign: the compiler still needs an answer.',
        userMessage: 'What is the most you would like to spend?',
        retryable: false,
      }),
    )
    const response = await POST(req(validBody({ intent: 'something warm for the trip' })))
    const { status, body } = await read(response)
    expect(status).toBe(400)
    expect(body.error?.code).toBe('CS_VALIDATION')
    expect(body.error?.userMessage).toBe('What is the most you would like to spend?')
  })

  it('answers 503 when the deployment has no vi-service', async () => {
    agent.prepareAgentSession.mockResolvedValue(
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
