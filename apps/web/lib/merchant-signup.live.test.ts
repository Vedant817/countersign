/**
 * Live database test for merchant sign-up — D-059.
 *
 * Proves that `registerMerchant`:
 *  - creates a user row (persona MERCHANT, password_hash not null) and a merchants row owned by it atomically;
 *  - refuses duplicate emails with the generic CS_UNAUTHENTICATED refusal and creates no extra merchant profile;
 *  - allows the new merchant to authenticate with the password they set.
 *
 * Skipped when DATABASE_URL is not set.
 */
import { eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

import { closeDb, db, merchants, users } from '@countersign/db'

import { authenticate, registerMerchant } from './auth'

const insertedUsers: string[] = []
const insertedMerchants: string[] = []

afterEach(async () => {
  const mIds = insertedMerchants.splice(0, insertedMerchants.length)
  if (mIds.length > 0) {
    await db().delete(merchants).where(inArray(merchants.id, mIds))
  }
  const uIds = insertedUsers.splice(0, insertedUsers.length)
  if (uIds.length > 0) {
    await db().delete(users).where(inArray(users.id, uIds))
  }
})

afterAll(async () => {
  await closeDb()
})

describe.skipIf(!process.env.DATABASE_URL?.trim())('registerMerchant against Postgres', () => {
  it('creates a merchant user and merchant profile atomically, refuses duplicates, and allows authentication', async () => {
    const randomSuffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const email = `merchant_${randomSuffix}@example.test`
    const password = 'aStrongPassword123'
    const businessName = 'Acme Merchant Supply'

    // 1. registerMerchant creates exactly one users row and one merchants row
    const result = await registerMerchant({
      email,
      password,
      businessName,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const userId = result.value.user.id
    const merchantId = result.value.merchantId
    insertedUsers.push(userId)
    insertedMerchants.push(merchantId)

    expect(result.value.user.persona).toBe('MERCHANT')
    expect(result.value.user.displayName).toBe(businessName)
    expect(result.value.user.email).toBe(email)

    // Verify DB state for users row
    const userRows = await db().select().from(users).where(eq(users.id, userId))
    expect(userRows).toHaveLength(1)
    expect(userRows[0]?.persona).toBe('MERCHANT')
    expect(userRows[0]?.password_hash).not.toBeNull()
    expect(typeof userRows[0]?.password_hash).toBe('string')
    expect(userRows[0]?.display_name).toBe(businessName)
    expect(userRows[0]?.email).toBe(email)

    // Verify DB state for merchants row
    const merchantRows = await db().select().from(merchants).where(eq(merchants.id, merchantId))
    expect(merchantRows).toHaveLength(1)
    expect(merchantRows[0]?.owner_user_id).toBe(userId)
    expect(merchantRows[0]?.display_name).toBe(businessName)
    expect(merchantRows[0]?.status).toBe('ACTIVE')

    // 2. A second call with the same email returns the duplicate refusal and creates no extra merchants row
    const duplicate = await registerMerchant({
      email,
      password: 'differentPassword456',
      businessName: 'Another Store',
    })
    expect(duplicate.ok).toBe(false)
    if (!duplicate.ok) {
      expect(duplicate.error.code).toBe('CS_UNAUTHENTICATED')
    }

    // Verify no extra merchants row was created for this user
    const ownerMerchants = await db()
      .select()
      .from(merchants)
      .where(eq(merchants.owner_user_id, userId))
    expect(ownerMerchants).toHaveLength(1)

    // Verify no merchant row with the second business name was created
    const extraMerchants = await db()
      .select()
      .from(merchants)
      .where(eq(merchants.display_name, 'Another Store'))
    expect(extraMerchants).toHaveLength(0)

    // 3. authenticate(email, password) then succeeds
    const authResult = await authenticate(email, password)
    expect(authResult.ok).toBe(true)
    if (authResult.ok) {
      expect(authResult.value.id).toBe(userId)
      expect(authResult.value.persona).toBe('MERCHANT')
      expect(authResult.value.displayName).toBe(businessName)
      expect(authResult.value.email).toBe(email)
    }
  })
})
