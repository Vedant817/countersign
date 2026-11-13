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
  },
)
