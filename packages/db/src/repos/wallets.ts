/**
 * `paypal_wallets` repository — spec §7.2, §8.7 (Vault onboarding, WP-07).
 *
 * A wallet row is the link between a Countersign user and a PayPal vault (payment) token. It is the
 * only place `payment_token_id` — the value sent as `payment_source.paypal.vault_id` on every order
 * create [V10] — is read from, so a wrong row means a wrong instrument, not a wrong display value.
 *
 * EC-MDT-6: when PayPal reports the vault token deleted, the wallet becomes `DELETED` (never removed)
 * and the Gate blocks every mandate under it. Keeping the row preserves the audit trail.
 */
import { and, eq } from 'drizzle-orm'

import type { CsError, Result, WalletId } from '@countersign/core'

import { db, type Exec } from '../client'
import { paypalWallets, type NewWallet, type WalletRow } from '../schema'
import { repo } from './index'

export function createWallet(input: NewWallet, exec?: Exec): Promise<Result<WalletRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db()).insert(paypalWallets).values(input).returning()
      const row = rows[0]
      if (!row) throw new Error('INSERT ... RETURNING produced no paypal_wallets row')
      return row as WalletRow
    },
    { table: 'paypal_wallets', id: input.id },
  )
}

/**
 * Upsert on the natural key `payment_token_id`.
 *
 * Re-running onboarding must converge on one row instead of accumulating duplicates that each look
 * like a valid instrument (AGENTS.md rule 6: retrying anything must be safe).
 */
export function upsertWalletByToken(
  input: NewWallet,
  exec?: Exec,
): Promise<Result<WalletRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .insert(paypalWallets)
        .values(input)
        .onConflictDoUpdate({
          target: paypalWallets.payment_token_id,
          set: {
            payer_id: input.payer_id,
            payer_email: input.payer_email,
            status: input.status ?? 'ACTIVE',
            customer_id: input.customer_id,
            raw: input.raw,
            fetched_at: input.fetched_at,
            updated_at: new Date(),
          },
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error('UPSERT ... RETURNING produced no paypal_wallets row')
      return row as WalletRow
    },
    { table: 'paypal_wallets', paymentTokenId: input.payment_token_id },
  )
}

/** The order-creation path: given a vault id, which wallet is it? */
export function findWalletByPaymentToken(
  paymentTokenId: string,
  exec?: Exec,
): Promise<Result<WalletRow | undefined, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(paypalWallets)
        .where(eq(paypalWallets.payment_token_id, paymentTokenId))
        .limit(1)
      return rows[0] as WalletRow | undefined
    },
    { table: 'paypal_wallets', paymentTokenId },
  )
}

export function findWalletById(
  id: WalletId,
  exec?: Exec,
): Promise<Result<WalletRow | undefined, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(paypalWallets)
        .where(eq(paypalWallets.id, id))
        .limit(1)
      return rows[0] as WalletRow | undefined
    },
    { table: 'paypal_wallets', id },
  )
}

export function findWalletsByUser(
  userId: string,
  exec?: Exec,
): Promise<Result<WalletRow[], CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(paypalWallets)
        .where(eq(paypalWallets.user_id, userId))
      return rows as WalletRow[]
    },
    { table: 'paypal_wallets', userId },
  )
}

/**
 * Mark the wallet deleted (EC-MDT-6, `VAULT.PAYMENT-TOKEN.DELETED`).
 *
 * Deliberately an UPDATE and not a DELETE: the vault id has to remain resolvable for the audit log
 * and for any dispute already filed against a capture made with it. Spec §7.1 — "soft-delete is
 * only via the privacy module" — so nothing here removes data.
 */
export function markWalletDeleted(
  id: WalletId,
  at: Date,
  exec?: Exec,
): Promise<Result<WalletRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .update(paypalWallets)
        .set({ status: 'DELETED', updated_at: at })
        .where(eq(paypalWallets.id, id))
        .returning()
      const row = rows[0]
      if (!row) throw new Error(`No paypal_wallets row for ${id}`)
      return row as WalletRow
    },
    { table: 'paypal_wallets', id },
  )
}

/**
 * Record the latest `GET /v3/vault/payment-tokens/{id}` body (§7.1: `raw` + `fetched_at`).
 *
 * Only `ACTIVE` wallets are refreshed; a deleted token's last known body is left alone so the record
 * of *when* we last saw it valid is not overwritten by a 404-shaped error.
 */
export function recordFetchedWallet(
  id: WalletId,
  raw: WalletRow['raw'],
  at: Date,
  exec?: Exec,
): Promise<Result<WalletRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .update(paypalWallets)
        .set({ raw, fetched_at: at, updated_at: at })
        .where(and(eq(paypalWallets.id, id), eq(paypalWallets.status, 'ACTIVE')))
        .returning()
      const row = rows[0]
      if (!row) throw new Error(`No ACTIVE paypal_wallets row for ${id}`)
      return row as WalletRow
    },
    { table: 'paypal_wallets', id },
  )
}
