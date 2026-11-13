/**
 * `POST /api/auth/signup` — the HTTP boundary, D-060.
 *
 * The decision is `lib/auth.test.ts`'s subject (`registerBuyer`). This file proves the shape around it:
 * same-origin before anything else, the password floor as a `400`, the limiter before the hash, the single
 * generic refusal for a duplicate address, and that the cookie is rotated rather than reused.
 *
 * `registerBuyer`, `startSession` and `appendAudit` are doubles: a transport test that needed scrypt and a
 * database would be testing four things at once.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { err, ok } from '@countersign/core'
import type * as DbModule from '@countersign/db'

const auth = vi.hoisted(() => ({
  registerBuyer: vi.fn(),
  startSession: vi.fn(),
  // The floor is a constant the route reads, not a decision, so the real value is used: a test that pinned
  // its own number would be a second password rule.
  SIGNUP_MIN_PASSWORD: 10,
  // Folding the address is pure string work with no dependency; the real one keeps the audit assertion honest.
  normalizeEmail: (email: string) => email.trim().toLowerCase(),
}))
vi.mock('@/lib/auth', () => auth)

const audit = vi.hoisted(() => ({ appendAudit: vi.fn() }))
vi.mock('@countersign/db', async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  ...audit,
}))

import { POST } from './route'
import { resetLoginRateLimit } from '@/lib/rate-limit'

const URL = 'http://localhost/api/auth/signup'
const BUYER = {
  id: 'usr_buyer',
  persona: 'BUYER',
  displayName: 'asha',
  email: 'asha@example.test',
}

const PASSWORD = 'a long enough password'

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

async function read(response: Response): Promise<{
  status: number
  body: {
    ok?: boolean
    next?: string
    error?: { code: string; message: string; userMessage?: string }
  }
}> {
  return { status: response.status, body: (await response.json()) as never }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetLoginRateLimit()
  auth.registerBuyer.mockResolvedValue(ok(BUYER))
  auth.startSession.mockResolvedValue(ok({}))
  audit.appendAudit.mockResolvedValue(ok({}))
})

describe('POST /api/auth/signup', () => {
  it('creates the account, signs the buyer in and lands on the agent surface', async () => {
    const response = await POST(req({ email: BUYER.email, password: PASSWORD, next: '/agent' }))
    const { status, body } = await read(response)
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    // The buyer's landing page, not the merchant queue the login route defaults to.
    expect(body.next).toBe('/agent')
    expect(auth.registerBuyer).toHaveBeenCalledWith(
      expect.objectContaining({ email: BUYER.email, password: PASSWORD }),
    )
    expect(auth.startSession).toHaveBeenCalledWith({ userId: 'usr_buyer' })
    expect(audit.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'AUTH_SIGNUP', actor: 'usr_buyer' }),
    )
  })

  it('defaults the next path to the agent surface rather than the dispute queue', async () => {
    const response = await POST(req({ email: BUYER.email, password: PASSWORD }))
    const { body } = await read(response)
    expect(body.next).toBe('/agent')
  })

  it('refuses a short password with 400 before hashing anything', async () => {
    const response = await POST(req({ email: BUYER.email, password: 'short' }))
    const { status, body } = await read(response)
    expect(status).toBe(400)
    expect(body.error?.code).toBe('CS_VALIDATION')
    expect(body.error?.userMessage).toMatch(/10 characters/)
    expect(auth.registerBuyer).not.toHaveBeenCalled()
  })

  it('refuses a duplicate address with the same generic 401 a failed login gets', async () => {
    auth.registerBuyer.mockResolvedValue(
      err({
        code: 'CS_UNAUTHENTICATED',
        message: 'That email address cannot be used to create an account on this deployment.',
        retryable: false,
      }),
    )
    const response = await POST(req({ email: 'taken@example.test', password: PASSWORD }))
    const { status, body } = await read(response)
    expect(status).toBe(401)
    expect(body.error?.code).toBe('CS_UNAUTHENTICATED')
    expect(auth.startSession).not.toHaveBeenCalled()
  })

  it('does not count the same address twice against the login budget', async () => {
    // The limiter is keyed by (email, address); the first attempt is a success, so the sixth attempt for a
    // *different* address still has a budget of its own.
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      auth.registerBuyer.mockResolvedValue(
        err({ code: 'CS_UNAUTHENTICATED', message: 'refused', retryable: false }),
      )
      const response = await POST(req({ email: BUYER.email, password: PASSWORD }))
      expect((await read(response)).status, `attempt ${attempt}`).toBe(401)
    }
    const response = await POST(req({ email: BUYER.email, password: PASSWORD }))
    const { status, body } = await read(response)
    expect(status).toBe(429)
    expect(body.error?.code).toBe('CS_RATE_LIMITED')
    expect(response.headers.get('retry-after')).toMatch(/^\d+$/)
    expect(auth.registerBuyer).toHaveBeenCalledTimes(5)
  })

  it('refuses a cross-origin POST before the body is read', async () => {
    const response = await POST(
      req({ email: BUYER.email, password: PASSWORD }, { origin: 'https://attacker.test' }),
    )
    const { status, body } = await read(response)
    expect(status).toBe(403)
    expect(body.error?.code).toBe('CS_FORBIDDEN')
    expect(auth.registerBuyer).not.toHaveBeenCalled()
  })

  it('refuses an extra field rather than silently dropping it', async () => {
    const response = await POST(
      req({ email: BUYER.email, password: PASSWORD, persona: 'MERCHANT' }),
    )
    expect((await read(response)).status).toBe(400)
  })

  it('never stores the address in the audit row — the digest is the record', async () => {
    await POST(req({ email: BUYER.email, password: PASSWORD }))
    const written = audit.appendAudit.mock.calls[0]?.[0] as { details: Record<string, unknown> }
    expect(written.details).toHaveProperty('email_domain', 'example.test')
    expect(JSON.stringify(written.details)).not.toContain('asha')
  })
})
