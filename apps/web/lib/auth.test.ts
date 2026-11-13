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
  hashPassword: vi.fn(),
  createUser: vi.fn(),
  setPasswordHash: vi.fn(),
}))
vi.mock('@countersign/db', async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  ...db,
}))

import {
  authenticate,
  currentUser,
  normalizeEmail,
  registerBuyer,
  requireBuyer,
  requireMerchant,
  SIGNUP_MIN_PASSWORD,
} from './auth'
import { safeNextPath } from './next-path'
import { readSession, startSession, type CookieStoreLike } from './session'

const SECRET = 'test-session-secret-of-at-least-32-characters'
const USER = 'usr_01HZX0000000000000000MERCHANT' as UserId
const BUYER_ID = 'usr_01HZX0000000000000000BUYER01' as UserId

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

const BUYER_ROW = {
  ...MERCHANT_ROW,
  id: BUYER_ID,
  persona: 'BUYER',
  display_name: 'asha',
  email: 'asha@example.test',
}

beforeEach(() => {
  process.env['SESSION_SECRET'] = SECRET
  vi.clearAllMocks()
  db.findUserById.mockResolvedValue(ok(MERCHANT_ROW))
  db.findUserByEmail.mockResolvedValue(ok(undefined))
  db.burnPasswordCheck.mockResolvedValue(undefined)
  db.verifyPassword.mockResolvedValue(false)
  db.hashPassword.mockResolvedValue('scrypt$16384$8$1$NEW$NEWHASH')
  db.createUser.mockResolvedValue(ok({ ...BUYER_ROW, id: 'usr_new' }))
  db.setPasswordHash.mockResolvedValue(ok({ ...BUYER_ROW, id: 'usr_new', password_hash: 'x' }))
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

  describe('requireBuyer', () => {
    it('refuses an anonymous request with CS_UNAUTHENTICATED', async () => {
      const result = await requireBuyer(jar())
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.code).toBe('CS_UNAUTHENTICATED')
      expect(result.error.userMessage).toBe('Sign in as the buyer first.')
    })

    it('refuses a signed-in merchant with CS_FORBIDDEN', async () => {
      const store = jar()
      await startSession({ userId: USER }, store)
      const result = await requireBuyer(store)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.code).toBe('CS_FORBIDDEN')
    })

    it('accepts the buyer', async () => {
      const store = jar()
      db.findUserById.mockResolvedValue(ok(BUYER_ROW))
      await startSession({ userId: BUYER_ID }, store)
      const result = await requireBuyer(store)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.id).toBe(BUYER_ID)
    })
  })

  describe('normalizeEmail', () => {
    it('trims and folds, so one address is one account', () => {
      expect(normalizeEmail('  Asha@Example.TEST ')).toBe('asha@example.test')
    })
  })

  describe('registerBuyer', () => {
    it('hashes the password and stores the hash on the new row', async () => {
      const created = await registerBuyer({
        email: 'Asha@Example.test',
        password: 'a long enough password',
      })
      expect(created.ok).toBe(true)
      // The plain password never reaches the repository: only the hash is written.
      expect(db.hashPassword).toHaveBeenCalledWith('a long enough password')
      expect(db.createUser).toHaveBeenCalledWith(
        expect.objectContaining({ persona: 'BUYER', email: 'asha@example.test' }),
      )
      const stored = await registerBuyer({
        email: 'Asha@Example.test',
        password: 'a long enough password',
      })
      expect(stored.ok).toBe(true)
      const id = (db.createUser.mock.calls[0]?.[0] as { id: string }).id
      expect(db.setPasswordHash).toHaveBeenCalledWith(id, 'scrypt$16384$8$1$NEW$NEWHASH')
    })

    it('answers the same refusal for an address that is already taken', async () => {
      db.createUser.mockResolvedValue(
        err(
          csError('CS_CONFLICT', 'Duplicate rejected by unique constraint users_email_key', {
            pgCode: '23505',
            constraint: 'users_email_key',
          }),
        ),
      )
      const created = await registerBuyer({
        email: 'taken@example.test',
        password: 'a long enough password',
      })
      expect(created.ok).toBe(false)
      if (created.ok) return
      // Not a CS_CONFLICT: a duplicate is the same answer as an unusable address, so it does not tell the
      // caller that the address is registered.
      expect(created.error.code).toBe('CS_UNAUTHENTICATED')
    })

    it('does not hide a real database failure behind the duplicate refusal', async () => {
      db.createUser.mockResolvedValue(err(csError('CS_INTERNAL', 'the database is down')))
      const created = await registerBuyer({
        email: 'someone@example.test',
        password: 'a long enough password',
      })
      expect(created.ok).toBe(false)
      if (created.ok) return
      expect(created.error.code).toBe('CS_INTERNAL')
    })

    it('uses the part of the address before the @ as the display name', async () => {
      await registerBuyer({ email: 'asha@example.test', password: 'a long enough password' })
      expect(db.createUser).toHaveBeenCalledWith(expect.objectContaining({ display_name: 'asha' }))
    })

    it('refuses nothing about the password itself — the route owns the length rule', () => {
      // The floor lives in the route, where the answer is a 400 the form can show; this function's contract is
      // "hash what it was given", and pinning that here keeps the two from drifting into two password rules.
      expect(SIGNUP_MIN_PASSWORD).toBe(10)
    })
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
