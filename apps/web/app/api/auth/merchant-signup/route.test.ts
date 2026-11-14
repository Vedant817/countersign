/**
 * `POST /api/auth/merchant-signup` — the HTTP boundary.
 *
 * The decision is `lib/auth.ts`'s subject (`registerMerchant`). This file proves the HTTP transport:
 * same-origin before anything else, the schema validation and password floor as a `400`, the limiter
 * before the hash, the single generic refusal for a duplicate address, and that the session is started
 * on 201 success.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { err, ok } from '@countersign/core'
import type * as DbModule from '@countersign/db'
import type * as RateLimitModule from '@/lib/rate-limit'

const auth = vi.hoisted(() => ({
  registerMerchant: vi.fn(),
  startSession: vi.fn(),
  SIGNUP_MIN_PASSWORD: 10,
  normalizeEmail: (email: string) => email.trim().toLowerCase(),
}))
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

const URL = 'http://localhost/api/auth/merchant-signup'
const MERCHANT_USER = {
  id: 'usr_merchant',
  persona: 'MERCHANT',
  displayName: 'Acme Corp',
  email: 'merchant@example.test',
}
const MERCHANT_ID = 'mer_01HZX000000000000000000000'

const PASSWORD = 'a long enough password'

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
    merchantId?: string
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
  auth.registerMerchant.mockResolvedValue(ok({ user: MERCHANT_USER, merchantId: MERCHANT_ID }))
  auth.startSession.mockResolvedValue(ok({}))
  dbMock.appendAudit.mockResolvedValue(ok({}))
})

describe('POST /api/auth/merchant-signup', () => {
  it('creates the account, signs the merchant in and returns 201 with merchantId and next', async () => {
    const response = await POST(
      req({
        email: MERCHANT_USER.email,
        password: PASSWORD,
        businessName: 'Acme Corp',
        next: '/disputes',
      }),
    )
    const { status, body } = await read(response)
    expect(status).toBe(201)
    expect(body.ok).toBe(true)
    expect(body.merchantId).toBe(MERCHANT_ID)
    expect(body.next).toBe('/disputes')
    expect(auth.registerMerchant).toHaveBeenCalledWith(
      expect.objectContaining({
        email: MERCHANT_USER.email,
        password: PASSWORD,
        businessName: 'Acme Corp',
      }),
    )
    expect(auth.startSession).toHaveBeenCalledWith({ userId: 'usr_merchant' })
    expect(dbMock.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'merchant.signup',
        actor: 'usr_merchant',
        subject: MERCHANT_ID,
      }),
    )
  })

  it('refuses a cross-origin POST before the body is read', async () => {
    const response = await POST(
      req(
        { email: MERCHANT_USER.email, password: PASSWORD, businessName: 'Acme Corp' },
        { origin: 'https://attacker.test' },
      ),
    )
    const { status, body } = await read(response)
    expect(status).toBe(403)
    expect((body.error as { code: string })?.code).toBe('CS_FORBIDDEN')
    expect(auth.registerMerchant).not.toHaveBeenCalled()
  })

  it('refuses missing businessName with 400 validation error', async () => {
    const response = await POST(req({ email: MERCHANT_USER.email, password: PASSWORD }))
    const { status, body } = await read(response)
    expect(status).toBe(400)
    expect(body.error?.code).toBe('CS_VALIDATION')
    expect(auth.registerMerchant).not.toHaveBeenCalled()
  })

  it('refuses a short password with 400 before calling registerMerchant', async () => {
    const response = await POST(
      req({ email: MERCHANT_USER.email, password: 'short', businessName: 'Acme Corp' }),
    )
    const { status, body } = await read(response)
    expect(status).toBe(400)
    expect(body.error?.code).toBe('CS_VALIDATION')
    expect(body.error?.userMessage).toMatch(/10 characters/)
    expect(auth.registerMerchant).not.toHaveBeenCalled()
  })

  it('refuses a duplicate address with 401 generic refusal', async () => {
    auth.registerMerchant.mockResolvedValue(
      err({
        code: 'CS_UNAUTHENTICATED',
        message: 'That email address cannot be used to create an account on this deployment.',
        retryable: false,
      }),
    )
    const response = await POST(
      req({ email: 'taken@example.test', password: PASSWORD, businessName: 'Acme Corp' }),
    )
    const { status, body } = await read(response)
    expect(status).toBe(401)
    expect(body.error?.code).toBe('CS_UNAUTHENTICATED')
    expect(auth.startSession).not.toHaveBeenCalled()
  })

  it('refuses with 429 when rate limiter says not allowed', async () => {
    rateLimit.checkLoginRateLimit.mockResolvedValueOnce({ allowed: false, retryAfterSec: 900 })
    const response = await POST(
      req({ email: MERCHANT_USER.email, password: PASSWORD, businessName: 'Acme Corp' }),
    )
    const { status, body } = await read(response)
    expect(status).toBe(429)
    expect(body.error?.code).toBe('CS_RATE_LIMITED')
    expect(response.headers.get('retry-after')).toMatch(/^\d+$/)
    expect(auth.registerMerchant).not.toHaveBeenCalled()
  })

  it('answers 503 when the rate limit check throws and calls neither registerMerchant nor startSession', async () => {
    rateLimit.checkLoginRateLimit.mockRejectedValue(new Error('Postgres connection lost'))
    const response = await POST(
      req({ email: MERCHANT_USER.email, password: PASSWORD, businessName: 'Acme Corp' }),
    )
    const { status, body } = await read(response)
    expect(status).toBe(503)
    expect(body.error?.code).toBe('CS_INTERNAL')
    expect(auth.registerMerchant).not.toHaveBeenCalled()
    expect(auth.startSession).not.toHaveBeenCalled()
  })
})
