/**
 * `POST /api/auth/buyer-login` — the HTTP boundary, D-060.
 *
 * The credential decision is `lib/auth.test.ts`'s subject. What this file pins is the transport contract and
 * the two places it must match the merchant login exactly: the guard order, and the shared rate-limit budget
 * (one bucket per (email, address) across both front doors — an attacker spraying one address gets one
 * budget, not two).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { err, ok } from '@countersign/core'
import type * as DbModule from '@countersign/db'
import type * as RateLimitModule from '@/lib/rate-limit'

const auth = vi.hoisted(() => ({ authenticate: vi.fn(), startSession: vi.fn() }))
vi.mock('@/lib/auth', () => auth)

const rateLimit = vi.hoisted(() => ({
  checkLoginRateLimit: vi.fn(),
  resetLoginRateLimit: vi.fn(),
}))
vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof RateLimitModule>()),
  ...rateLimit,
}))

const dbMock = vi.hoisted(() => ({
  appendAudit: vi.fn(),
}))
vi.mock('@countersign/db', async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  ...dbMock,
}))

import { POST } from './route'
import { resetLoginRateLimit } from '@/lib/rate-limit'

const URL = 'http://localhost/api/auth/buyer-login'
const MERCHANT_URL = 'http://localhost/api/auth/login'
const EMAIL = 'asha@example.test'
const PASSWORD = 'a long enough password'
const BUYER = { id: 'usr_buyer', persona: 'BUYER', displayName: 'asha', email: EMAIL }

function req(body: unknown, headers: Record<string, string> = {}, url = URL): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

type ResponseError =
  | { code?: string; message?: string; userMessage?: string }
  | (string & { code?: never; message?: never; userMessage?: never })

async function read(response: Response): Promise<{
  status: number
  body: {
    ok?: boolean
    next?: string
    error?: ResponseError
  }
}> {
  return { status: response.status, body: (await response.json()) as never }
}

beforeEach(async () => {
  vi.clearAllMocks()
  rateLimit.checkLoginRateLimit.mockResolvedValue({ allowed: true, retryAfterSec: 0 })
  rateLimit.resetLoginRateLimit.mockResolvedValue(undefined)
  await resetLoginRateLimit()
  auth.authenticate.mockResolvedValue(ok(BUYER))
  auth.startSession.mockResolvedValue(ok({}))
  dbMock.appendAudit.mockResolvedValue(ok({}))
})

describe('POST /api/auth/buyer-login', () => {
  it('signs the buyer in, rotates the session and lands on the agent surface', async () => {
    const response = await POST(req({ email: EMAIL, password: PASSWORD, next: '/agent' }))
    const { status, body } = await read(response)
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.next).toBe('/agent')
    expect(auth.authenticate).toHaveBeenCalledWith(EMAIL, PASSWORD)
    expect(auth.startSession).toHaveBeenCalledWith({ userId: 'usr_buyer' })
    expect(dbMock.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'AUTH_LOGIN', actor: 'usr_buyer' }),
    )
  })

  it('defaults the landing page to the agent surface', async () => {
    const response = await POST(req({ email: EMAIL, password: PASSWORD }))
    const { body } = await read(response)
    expect(body.next).toBe('/agent')
  })

  it('answers one generic refusal for a wrong password', async () => {
    auth.authenticate.mockResolvedValue(
      err({
        code: 'CS_UNAUTHENTICATED',
        message: 'Email or password is incorrect.',
        retryable: false,
      }),
    )
    const response = await POST(req({ email: EMAIL, password: 'wrong' }))
    const { status, body } = await read(response)
    expect(status).toBe(401)
    expect(body.error?.code).toBe('CS_UNAUTHENTICATED')
    expect(auth.startSession).not.toHaveBeenCalled()
  })

  it('counts attempts against the merchant login budget too, so the two front doors share one bucket', async () => {
    // An attacker who knows the address sprays /api/auth/login; a buyer login afterwards must not restart the
    // budget at zero.
    auth.authenticate.mockResolvedValue(
      err({ code: 'CS_UNAUTHENTICATED', message: 'refused', retryable: false }),
    )
    const { POST: merchantPost } = await import('../login/route')
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await merchantPost(req({ email: EMAIL, password: 'x' }, {}, MERCHANT_URL))
      expect((await read(response)).status, `merchant attempt ${attempt}`).toBe(401)
    }
    // Two more attempts on the buyer door exhaust the shared budget.
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const response = await POST(req({ email: EMAIL, password: 'x' }))
      expect((await read(response)).status, `buyer attempt ${attempt}`).toBe(401)
    }
    rateLimit.checkLoginRateLimit.mockResolvedValueOnce({ allowed: false, retryAfterSec: 900 })
    const blocked = await POST(req({ email: EMAIL, password: 'x' }))
    const { status, body } = await read(blocked)
    expect(status).toBe(429)
    expect(body.error?.code).toBe('CS_RATE_LIMITED')
    expect(blocked.headers.get('retry-after')).toMatch(/^\d+$/)
  })

  it('answers 503 when the rate limit check fails closed', async () => {
    rateLimit.checkLoginRateLimit.mockRejectedValue(new Error('Postgres connection lost'))
    const response = await POST(req({ email: EMAIL, password: PASSWORD }))
    const { status, body } = await read(response)
    expect(status).toBe(503)
    expect(body).toEqual({ error: 'Sign-in is temporarily unavailable. Try again shortly.' })
    expect(auth.authenticate).not.toHaveBeenCalled()
    expect(auth.startSession).not.toHaveBeenCalled()
  })

  it('refuses a cross-origin POST before reading the body or the password', async () => {
    const response = await POST(
      req({ email: EMAIL, password: PASSWORD }, { origin: 'https://attacker.test' }),
    )
    const { status, body } = await read(response)
    expect(status).toBe(403)
    expect(body.error?.code).toBe('CS_FORBIDDEN')
    expect(auth.authenticate).not.toHaveBeenCalled()
  })

  it('refuses a body that is not the expected shape with 400', async () => {
    const response = await POST(req({ email: EMAIL }))
    const { status, body } = await read(response)
    expect(status).toBe(400)
    expect(body.error?.code).toBe('CS_VALIDATION')
    expect(auth.authenticate).not.toHaveBeenCalled()
  })

  it('refuses an extra field rather than silently dropping it', async () => {
    const response = await POST(req({ email: EMAIL, password: PASSWORD, persona: 'BUYER' }))
    expect((await read(response)).status).toBe(400)
  })
})
