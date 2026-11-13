/**
 * `POST /api/auth/login` — the HTTP boundary, D-059.
 *
 * The credentials themselves are `lib/auth.test.ts`'s subject; this file proves the shape around them:
 * the guard order (origin, body, rate limit, credentials), the single generic refusal, the `429` and its
 * `Retry-After`, and that a successful login rotates the session rather than reusing whatever was there.
 *
 * `authenticate`, `startSession` and `appendAudit` are doubles: a transport test that needed scrypt and a
 * database would be testing three things at once.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { err, ok } from '@countersign/core'
import type * as DbModule from '@countersign/db'

const auth = vi.hoisted(() => ({ authenticate: vi.fn(), startSession: vi.fn() }))
vi.mock('@/lib/auth', () => auth)

const dbMock = vi.hoisted(() => ({
  appendAudit: vi.fn(),
  consumeLoginAttempt: vi.fn(),
  resetLoginAttempts: vi.fn(),
}))
vi.mock('@countersign/db', async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  ...dbMock,
}))

import { POST } from './route'
import { resetLoginRateLimit } from '@/lib/rate-limit'

const URL = 'http://localhost/api/auth/login'
const MERCHANT = {
  id: 'usr_merchant',
  persona: 'MERCHANT',
  displayName: 'Northwind Outfitters',
  email: 'merchant.northwind@example.com',
}

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(URL, {
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
  dbMock.consumeLoginAttempt.mockResolvedValue({ allowed: true, retryAfterSec: 0 })
  dbMock.resetLoginAttempts.mockResolvedValue(undefined)
  await resetLoginRateLimit()
  auth.authenticate.mockResolvedValue(ok(MERCHANT))
  auth.startSession.mockResolvedValue(ok({}))
  dbMock.appendAudit.mockResolvedValue(ok({}))
})

describe('POST /api/auth/login', () => {
  it('signs the merchant in, rotates the session and names where to go next', async () => {
    const response = await POST(
      req({ email: MERCHANT.email, password: 'a password', next: '/disputes' }),
    )
    const { status, body } = await read(response)
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.next).toBe('/disputes')
    expect(auth.startSession).toHaveBeenCalledWith({ userId: 'usr_merchant' })
    expect(dbMock.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'AUTH_LOGIN', actor: 'usr_merchant' }),
    )
  })

  it('answers one generic refusal for a wrong password', async () => {
    auth.authenticate.mockResolvedValue(
      err({
        code: 'CS_UNAUTHENTICATED',
        message: 'Email or password is incorrect.',
        retryable: false,
      }),
    )
    const response = await POST(req({ email: MERCHANT.email, password: 'wrong' }))
    const { status, body } = await read(response)
    expect(status).toBe(401)
    expect(body.error?.code).toBe('CS_UNAUTHENTICATED')
    expect(body.error?.message).toBe('Email or password is incorrect.')
    expect(auth.startSession).not.toHaveBeenCalled()
  })

  it('counts an attempt and refuses the sixth with 429 and Retry-After', async () => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await POST(req({ email: MERCHANT.email, password: 'a password' }))
      expect((await read(response)).status, `attempt ${attempt}`).toBe(200)
    }
    dbMock.consumeLoginAttempt.mockResolvedValueOnce({ allowed: false, retryAfterSec: 900 })
    const response = await POST(req({ email: MERCHANT.email, password: 'a password' }))
    const { status, body } = await read(response)
    expect(status).toBe(429)
    expect(body.error?.code).toBe('CS_RATE_LIMITED')
    expect(response.headers.get('retry-after')).toMatch(/^\d+$/)
    expect(auth.authenticate).toHaveBeenCalledTimes(5)
  })

  it('answers 503 when the rate limit check fails closed', async () => {
    dbMock.consumeLoginAttempt.mockRejectedValue(new Error('Postgres connection lost'))
    const response = await POST(req({ email: MERCHANT.email, password: 'a password' }))
    const { status, body } = await read(response)
    expect(status).toBe(503)
    expect(body).toEqual({ error: 'Sign-in is temporarily unavailable. Try again shortly.' })
    expect(auth.authenticate).not.toHaveBeenCalled()
    expect(auth.startSession).not.toHaveBeenCalled()
  })

  it('refuses a cross-origin POST before reading the body or the password', async () => {
    const response = await POST(
      req({ email: MERCHANT.email, password: 'a password' }, { origin: 'https://attacker.test' }),
    )
    const { status, body } = await read(response)
    expect(status).toBe(403)
    expect(body.error?.code).toBe('CS_FORBIDDEN')
    expect(auth.authenticate).not.toHaveBeenCalled()
  })

  it('refuses a body that is not the expected shape with 400', async () => {
    const response = await POST(req({ email: MERCHANT.email }))
    const { status, body } = await read(response)
    expect(status).toBe(400)
    expect(body.error?.code).toBe('CS_VALIDATION')
    expect(auth.authenticate).not.toHaveBeenCalled()
  })

  it('refuses an extra field rather than silently dropping it', async () => {
    const response = await POST(
      req({ email: MERCHANT.email, password: 'a password', actorUserId: 'usr_someone_else' }),
    )
    expect((await read(response)).status).toBe(400)
  })

  it('sends a protocol-relative next to the queue, not to another host', async () => {
    const response = await POST(
      req({ email: MERCHANT.email, password: 'a password', next: '//attacker.test' }),
    )
    const { body } = await read(response)
    expect(body.next).toBe('/disputes')
  })
})
