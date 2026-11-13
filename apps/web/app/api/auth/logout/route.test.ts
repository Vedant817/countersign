/**
 * `POST /api/auth/logout` — the HTTP boundary, D-059.
 *
 * The route's whole job is two lines (clear the cookie, record who left), so the tests are about the two
 * ways it can be wrong: a cross-site page must not be able to end a merchant's session, and a logout must
 * still answer 200 when there was no session to end — a signed-out visitor clicking "sign out" is not an
 * error.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ok } from '@countersign/core'
import type * as DbModule from '@countersign/db'

const session = vi.hoisted(() => ({ currentUserId: vi.fn(), forgetUser: vi.fn() }))
vi.mock('@/lib/session', () => session)

const audit = vi.hoisted(() => ({ appendAudit: vi.fn() }))
vi.mock('@countersign/db', async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  ...audit,
}))

import { POST } from './route'

const URL = 'http://localhost/api/auth/logout'

function req(headers: Record<string, string> = {}): Request {
  return new Request(URL, { method: 'POST', headers })
}

beforeEach(() => {
  vi.clearAllMocks()
  session.currentUserId.mockResolvedValue(ok('usr_merchant'))
  session.forgetUser.mockResolvedValue(ok(true))
  audit.appendAudit.mockResolvedValue(ok({}))
})

describe('POST /api/auth/logout', () => {
  it('clears the session and records who signed out', async () => {
    const response = await POST(req())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(session.forgetUser).toHaveBeenCalled()
    expect(audit.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'AUTH_LOGOUT', actor: 'usr_merchant' }),
    )
  })

  it('refuses a cross-origin POST, so a third-party page cannot sign the merchant out', async () => {
    const response = await POST(req({ origin: 'https://attacker.test' }))
    expect(response.status).toBe(403)
    expect(session.forgetUser).not.toHaveBeenCalled()
  })

  it('answers 200 when no one was signed in', async () => {
    session.currentUserId.mockResolvedValue(ok(undefined))
    const response = await POST(req())
    expect(response.status).toBe(200)
    expect(session.forgetUser).toHaveBeenCalled()
    expect(audit.appendAudit).not.toHaveBeenCalled()
  })
})
