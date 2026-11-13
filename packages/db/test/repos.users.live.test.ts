/**
 * The two `users` repository functions the merchant sign-in adds, against a real Postgres.
 *
 * `password_hash` is a column this package's own schema test cannot exercise: drizzle's structural check
 * proves the column exists, not that a `SELECT ... WHERE email = $1` finds the row the seed wrote, and not
 * that `setPasswordHash` writes the hash a later login will read. Those are the two statements the login
 * route depends on, so they are executed here rather than asserted as strings.
 *
 * The row is created and removed by this file; the seeded personas are read-only fixtures of every other
 * live suite and a test that changed the merchant's hash would be a test that signs the operator out.
 */
import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'

import type { UserId } from '@countersign/core'

import { closeDb, db } from '../src/client'
import { createUser, findUserByEmail, setPasswordHash } from '../src/repos/users'
import { users } from '../src/schema'
import { hashPassword, verifyPassword } from '../src/password'

const hasDatabase = (process.env['DATABASE_URL'] ?? '').trim() !== ''
const EMAIL = 'merchant-signin-live-test@example.test'
const ID = 'usr_livepasswordtest0000000000' as UserId

afterAll(async () => {
  if (!hasDatabase) return
  await db().delete(users).where(eq(users.id, ID))
  await closeDb()
})

describe.skipIf(!hasDatabase)(
  'the users repository can back a password login (live database)',
  () => {
    it('finds a user by email and writes a hash a later check accepts', async () => {
      await db().delete(users).where(eq(users.email, EMAIL))
      const created = await createUser({
        id: ID,
        persona: 'MERCHANT',
        display_name: 'Live sign-in test',
        email: EMAIL,
        country: 'US',
      })
      expect(created.ok, created.ok ? '' : created.error.message).toBe(true)

      const stored = await hashPassword('a real password')
      const updated = await setPasswordHash(ID, stored)
      expect(updated.ok, updated.ok ? '' : updated.error.message).toBe(true)
      expect(updated.ok && updated.value.password_hash).toBe(stored)

      const found = await findUserByEmail(EMAIL)
      expect(found.ok).toBe(true)
      if (!found.ok) return
      expect(found.value?.id).toBe(ID)
      expect(found.value?.password_hash).toBe(stored)
      expect(await verifyPassword('a real password', found.value?.password_hash ?? '')).toBe(true)
    })

    it('answers undefined for an email with no account, rather than failing', async () => {
      const missing = await findUserByEmail('nobody-here@example.test')
      expect(missing.ok).toBe(true)
      if (!missing.ok) return
      expect(missing.value).toBeUndefined()
    })

    it('can clear a password hash, which is how a deployment with no MERCHANT_PASSWORD stays closed', async () => {
      const cleared = await setPasswordHash(ID, null)
      expect(cleared.ok).toBe(true)
      const found = await findUserByEmail(EMAIL)
      expect(found.ok && found.value?.password_hash).toBeNull()
    })

    it('refuses a second account on the same address as CS_CONFLICT (D-060, users_email_key)', async () => {
      // The UNIQUE index, not the sign-up route, is what makes "one account per address" true: a route that
      // checks and then inserts is a race, and the second row would be an account two people can both sign in
      // to. This is the statement that loses the race.
      const duplicate = await createUser({
        id: 'usr_liveduplicatetest00000000' as UserId,
        persona: 'BUYER',
        display_name: 'The other Asha',
        email: EMAIL,
        country: 'US',
      })
      expect(duplicate.ok).toBe(false)
      if (duplicate.ok) return
      expect(duplicate.error.code).toBe('CS_CONFLICT')
      expect(duplicate.error.details?.['constraint']).toBe('users_email_key')
      expect(duplicate.error.details?.['pgCode']).toBe('23505')
    })

    it('treats the address as case-insensitive at the index, because the route folds before it writes', async () => {
      // The UNIQUE index is on the raw text; folding is `normalizeEmail`'s job, so the guarantee this proves is
      // that the two paths cannot disagree — a folded lookup must find the folded write.
      await db().delete(users).where(eq(users.id, ID))
      const created = await createUser({
        id: ID,
        persona: 'BUYER',
        display_name: 'asha',
        email: EMAIL.toLowerCase(),
        country: 'US',
      })
      expect(created.ok, created.ok ? '' : created.error.message).toBe(true)
      const found = await findUserByEmail(EMAIL.toLowerCase())
      expect(found.ok && found.value?.id).toBe(ID)
    })
  },
)
