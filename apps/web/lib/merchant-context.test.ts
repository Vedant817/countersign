import { beforeEach, describe, expect, it, vi } from 'vitest'

import { csError, err, ok, type UserId } from '@countersign/core'
import type * as DbModule from '@countersign/db'

const db = vi.hoisted(() => ({
  getMerchantByOwner: vi.fn(),
}))

vi.mock('@countersign/db', async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  ...db,
}))

import type { SignedInUser } from './auth'
import { merchantIdFor } from './merchant-context'

const USER: SignedInUser = {
  id: 'usr_01HZX0000000000000000MERCHANT' as UserId,
  persona: 'MERCHANT',
  displayName: 'Northwind',
  email: 'm@example.test',
}

describe('merchantIdFor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the merchant id when a merchants row is found', async () => {
    db.getMerchantByOwner.mockResolvedValue(
      ok({
        id: 'mer_01HZX000000000000000000001',
        owner_user_id: USER.id,
        display_name: 'Northwind Outfitters',
        paypal_merchant_id: null,
        status: 'ACTIVE',
        created_at: new Date(),
        updated_at: new Date(),
      }),
    )

    const result = await merchantIdFor(USER)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBe('mer_01HZX000000000000000000001')
    expect(db.getMerchantByOwner).toHaveBeenCalledWith(USER.id)
  })

  it('returns CS_FORBIDDEN when no merchants row exists for the user', async () => {
    db.getMerchantByOwner.mockResolvedValue(ok(undefined))

    const result = await merchantIdFor(USER)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_FORBIDDEN')
    expect(result.error.message).toBe(`Merchant user ${USER.id} has no merchants row.`)
    expect(result.error.userMessage).toBe('This account has no merchant profile yet.')
  })

  it('passes through database errors', async () => {
    db.getMerchantByOwner.mockResolvedValue(
      err(csError('CS_INTERNAL', 'the database is unreachable')),
    )

    const result = await merchantIdFor(USER)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_INTERNAL')
    expect(result.error.message).toBe('the database is unreachable')
  })
})
