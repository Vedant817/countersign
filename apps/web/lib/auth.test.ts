/**
 * The auth decision (`lib/auth.ts`) and the `?next=` rule.
 *
 * `currentUser`, `authenticate` and `requireMerchant` are the three answers every protected route needs.
 * The database is a double here — these tests are about the decision, not SQL — and the cookie is the real
 * `session.ts` code over a fake store, so a session minted by `startSession` is the same session
 * `currentUser` reads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { csError, err, ok, type UserId } from '@countersign/core'
import type * as DbModule from '@countersign/db'

const db = vi.hoisted(() => ({
  findUserByEmail: vi.fn(),
  findUserById: vi.fn(),
  burnPasswordCheck: vi.fn(),
  verifyPassword: vi.fn(),
}))
vi.mock('@countersign/db', async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  ...db,
}))

import { authenticate, currentUser, requireMerchant } from './auth'
import { safeNextPath } from './next-path'
import { readSession, startSession, type CookieStoreLike } from './session'

const SECRET = 'test-session-secret-of-at-least-32-characters'
const USER = 'usr_01HZX0000000000000000MERCHANT' as UserId

function jar(): CookieStoreLike {
  const raw = new Map<string, string>()
  return {
    get: (name: string) => {
      const value = raw.get(name)
      return value === undefined ? undefined : { name, value }
    },
    set: (name: string, value: string) => {
      raw.set(name, value)
      return undefined
    },
  }
}

const MERCHANT_ROW = {
  id: USER,
  persona: 'MERCHANT',
  display_name: 'Northwind Outfitters',
  email: 'merchant.northwind@example.com',
  country: 'US',
  password_hash: 'scrypt$16384$8$1$AAAA$BBBB',
  dpdp_notice_ack_at: null,
  created_at: new Date(0),
  updated_at: new Date(0),
}

beforeEach(() => {
  process.env['SESSION_SECRET'] = SECRET
  vi.clearAllMocks()
  db.findUserById.mockResolvedValue(ok(MERCHANT_ROW))
  db.findUserByEmail.mockResolvedValue(ok(undefined))
  db.burnPasswordCheck.mockResolvedValue(undefined)
  db.verifyPassword.mockResolvedValue(false)
})

afterEach(() => {
  delete process.env['SESSION_SECRET']
})

describe('currentUser', () => {
  it('reads the row a session names', async () => {
    const store = jar()
    await startSession({ userId: USER }, store)
    const user = await currentUser(store)
    expect(user.ok).toBe(true)
    if (!user.ok) return
    expect(user.value?.persona).toBe('MERCHANT')
    expect(user.value?.displayName).toBe('Northwind Outfitters')
  })

  it('answers anonymous for an absent cookie', async () => {
    const user = await currentUser(jar())
    expect(user.ok && user.value).toBeUndefined()
  })

  it('fails closed for a cookie with no login anchor', async () => {
    const store = jar()
    // A pre-D-059 cookie is a user id and nothing else. It is not a sign-in, and the anchor is what tells
    // the two apart; the seal itself is valid because this test has the secret.
    const written = await readSession(store)
    expect(written.ok).toBe(true)
    if (!written.ok) return
    written.value.userId = USER
    await written.value.save()
    const user = await currentUser(store)
    expect(user.ok && user.value).toBeUndefined()
  })

  it('ignores a session whose row no longer exists', async () => {
    const store = jar()
    await startSession({ userId: USER }, store)
    db.findUserById.mockResolvedValue(ok(undefined))
    const user = await currentUser(store)
    expect(user.ok && user.value).toBeUndefined()
  })

  it('ignores a session older than the absolute lifetime', async () => {
    const store = jar()
    await startSession({ userId: USER }, store)
    const read = await readSession(store)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    // Rewrite the seal with a login anchor from two days ago. The secret is ours in this test, so this is a
    // legitimate way to age a session without waiting twelve hours.
    read.value.loginAtSec = Math.floor(Date.now() / 1000) - 60 * 60 * 48
    await read.value.save()
    const user = await currentUser(store)
    expect(user.ok && user.value).toBeUndefined()
  })
})

describe('authenticate', () => {
  it('accepts the right password', async () => {
    db.findUserByEmail.mockResolvedValue(ok(MERCHANT_ROW))
    db.verifyPassword.mockResolvedValue(true)
    const user = await authenticate('merchant.northwind@example.com', 'a password')
    expect(user.ok).toBe(true)
    if (!user.ok) return
    expect(user.value.persona).toBe('MERCHANT')
  })

  it('gives one refusal for an unknown account, a missing password and a wrong password', async () => {
    db.verifyPassword.mockResolvedValue(false)
    const unknown = await authenticate('nobody@example.test', 'a password')
    db.findUserByEmail.mockResolvedValue(ok({ ...MERCHANT_ROW, password_hash: null }))
    const noPassword = await authenticate('merchant.northwind@example.com', 'a password')
    db.findUserByEmail.mockResolvedValue(ok(MERCHANT_ROW))
    const wrong = await authenticate('merchant.northwind@example.com', 'wrong')

    const sentences = [unknown, noPassword, wrong].map((result) => {
      expect(result.ok).toBe(false)
      return result.ok ? '' : result.error.message
    })
    expect(new Set(sentences).size).toBe(1)
    expect(unknown.ok ? '' : unknown.error.code).toBe('CS_UNAUTHENTICATED')
  })

  it('spends a hash for an unknown account, so the two answers cost the same', async () => {
    await authenticate('nobody@example.test', 'a password')
    expect(db.burnPasswordCheck).toHaveBeenCalledWith('a password')
  })

  it('does not dress a database failure up as a wrong password', async () => {
    db.findUserByEmail.mockResolvedValue(
      err(csError('CS_INTERNAL', 'the users table is unreachable')),
    )
    const result = await authenticate('nobody@example.test', 'a password')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_INTERNAL')
    expect(db.burnPasswordCheck).not.toHaveBeenCalled()
  })
})

describe('requireMerchant', () => {
  it('refuses an anonymous request with CS_UNAUTHENTICATED', async () => {
    const result = await requireMerchant(jar())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_UNAUTHENTICATED')
  })

  it('refuses a signed-in buyer with CS_FORBIDDEN', async () => {
    const store = jar()
    await startSession({ userId: USER }, store)
    db.findUserById.mockResolvedValue(ok({ ...MERCHANT_ROW, persona: 'BUYER' }))
    const result = await requireMerchant(store)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_FORBIDDEN')
  })

  it('accepts the merchant', async () => {
    const store = jar()
    await startSession({ userId: USER }, store)
    const result = await requireMerchant(store)
    expect(result.ok).toBe(true)
  })
})

describe('safeNextPath', () => {
  it.each([
    ['/disputes/dsp_1', '/disputes/dsp_1'],
    ['/disputes?filter=NEW', '/disputes?filter=NEW'],
  ])('keeps %s', (input, expected) => {
    expect(safeNextPath(input)).toBe(expected)
  })

  it.each([
    ['https://attacker.test/login', '/disputes'],
    ['//attacker.test', '/disputes'],
    ['\\\\attacker.test', '/disputes'],
    ['disputes', '/disputes'],
    ['', '/disputes'],
    [undefined, '/disputes'],
    ['/disputes\nX-Evil: 1', '/disputes'],
  ])('refuses %s', (input, expected) => {
    expect(safeNextPath(input)).toBe(expected)
  })
})
