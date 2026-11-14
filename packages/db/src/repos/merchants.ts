/**
 * `merchants` repository — spec §7.2, D-059.
 *
 * Links an owning user account to their seller profile and PayPal merchant identifier.
 * Exactly one merchant profile per owner account.
 */
import { eq } from 'drizzle-orm'

import { ulid, type CsError, type Result } from '@countersign/core'

import { db, type Exec } from '../client'
import { merchants, type MerchantRow } from '../schema'
import { repo } from './index'

export interface CreateMerchantInput {
  readonly ownerUserId: string
  readonly displayName: string
  readonly id?: string
  readonly paypalMerchantId?: string | null
  readonly status?: 'ACTIVE' | 'SUSPENDED'
}

/**
 * Create a merchant. `id` is generated with `mer_${ulid()}` unless supplied by the caller.
 * Duplicate owner_user_id or paypal_merchant_id maps to CS_CONFLICT via `toRepoError`.
 */
export function createMerchant(
  input: CreateMerchantInput,
  exec?: Exec,
): Promise<Result<MerchantRow, CsError>> {
  const id = input.id ?? `mer_${ulid()}`
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .insert(merchants)
        .values({
          id,
          owner_user_id: input.ownerUserId,
          display_name: input.displayName,
          paypal_merchant_id: input.paypalMerchantId ?? null,
          status: input.status ?? 'ACTIVE',
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error('INSERT ... RETURNING produced no merchants row')
      return row as MerchantRow
    },
    { table: 'merchants', id, ownerUserId: input.ownerUserId },
  )
}

/** Lookup a merchant by primary key ID. */
export function getMerchantById(
  id: string,
  exec?: Exec,
): Promise<Result<MerchantRow | undefined, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(merchants)
        .where(eq(merchants.id, id))
        .limit(1)
      return rows[0] as MerchantRow | undefined
    },
    { table: 'merchants', id },
  )
}

/** Lookup a merchant by the owner's user ID. */
export function getMerchantByOwner(
  ownerUserId: string,
  exec?: Exec,
): Promise<Result<MerchantRow | undefined, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(merchants)
        .where(eq(merchants.owner_user_id, ownerUserId))
        .limit(1)
      return rows[0] as MerchantRow | undefined
    },
    { table: 'merchants', ownerUserId },
  )
}

/**
 * Record or clear the merchant's PayPal merchant/payer ID.
 * A duplicate PayPal merchant ID on another merchant row maps to CS_CONFLICT.
 */
export function setPaypalMerchantId(
  id: string,
  paypalMerchantId: string | null,
  exec?: Exec,
): Promise<Result<MerchantRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .update(merchants)
        .set({ paypal_merchant_id: paypalMerchantId, updated_at: new Date() })
        .where(eq(merchants.id, id))
        .returning()
      const row = rows[0]
      if (!row) throw new Error(`No merchants row for ${id}`)
      return row as MerchantRow
    },
    { table: 'merchants', id },
  )
}

export const findMerchantById = getMerchantById
export const findMerchantByOwner = getMerchantByOwner

/** Lookup a merchant by their PayPal merchant ID. */
export function getMerchantByPaypalMerchantId(
  paypalMerchantId: string,
  exec?: Exec,
): Promise<Result<MerchantRow | undefined, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(merchants)
        .where(eq(merchants.paypal_merchant_id, paypalMerchantId))
        .limit(1)
      return rows[0] as MerchantRow | undefined
    },
    { table: 'merchants', paypalMerchantId },
  )
}

export const findMerchantByPaypalMerchantId = getMerchantByPaypalMerchantId
