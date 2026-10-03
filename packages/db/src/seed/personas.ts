/**
 * Seeded personas — spec **§8.2 AT-M2.2** ("`pnpm db:seed` creates the personas, the Northwind
 * merchant, 24 products …"), §7.2 (`users`), demo §19.
 *
 * The three people in the demo:
 *
 * | Persona | Who | Why they exist |
 * |---|---|---|
 * | `BUYER` | Asha | Signs mandates with her device key (S-02 → S-04). Her `mandates`, `budget_accounts` and `wallet_caps` are what the whole demo is about. |
 * | `MERCHANT` | Northwind Outfitters | The "Northwind" PayPal sandbox app from §10.1. `products.merchant_id` and every checkout `payee` refer to her merchant account. |
 * | `JUDGE` | the judge | Drives Judge Mode (S-21 / §8.20). A persona so the logins are distinct and the run is attributable. |
 *
 * ## Everything here is fixed, not random
 *
 * Ids are **stable literals**, not `newId()`. A seed that mints fresh ULIDs on every run would insert
 * a second copy of Asha each time, and AT-M2.2 ("seed is idempotent") would fail in the most annoying
 * possible way: it would pass on the first run and quietly accumulate duplicates forever after. Stable
 * ids plus `onConflictDoUpdate` make "run it twice" literally the same database.
 *
 * The bodies are valid Crockford base32 (no `I`, `L`, `O` or `U`), so `idCreatedAtMs` still parses and
 * sorting by id still reflects creation order — the ULID alphabet is respected even though the
 * timestamps are pinned.
 *
 * ## What this file deliberately does NOT seed
 *
 * No devices, agents, wallets, L1s, mandates or budget accounts. Those are created by the real flows
 * (S-02 onboarding, S-04 mandate signing) with **real key material and real signatures**, and a seed
 * that fabricated an `l2_serialized` would be a fake signed artefact sitting in the evidence chain —
 * the single worst thing this codebase could contain. `SEED_WALLET_ID` below exists only so the wallet
 * cap has a row to hang off; see the note there.
 */
import type { DeviceId, UserId, WalletId } from '@countersign/core'

/**
 * The demo's three personas. Plain strings rather than a pg enum: a persona is a label on the landing
 * page, not a state machine, and the picker may gain one without a migration.
 */
export const PERSONAS = ['BUYER', 'MERCHANT', 'JUDGE'] as const
export type Persona = (typeof PERSONAS)[number]

/** PayPal's Northwind sandbox merchant account (§10.1). `orders.payee` and `checkout_sessions.merchant_id`. */
export const NORTHWIND_MERCHANT_ID = 'MERCHANT_NORTHWIND'

export interface PersonaSeed {
  /** Stable, so the seed is idempotent. */
  readonly id: UserId
  readonly persona: Persona
  readonly displayName: string
  readonly email: string
  /** ISO 3166-1 alpha-2. Drives the flat shipping fee (§8.9) and the DPDP notice. */
  readonly country: string
}

/** Asha — the buyer. Email matches `PAYPAL_BUYER_EMAIL`'s sandbox personal account. */
export const BUYER: PersonaSeed = {
  id: 'usr_0123456789ABCDEFGHJKMNPQRS' as UserId,
  persona: 'BUYER',
  displayName: 'Asha',
  email: 'buyer.countersign@example.com',
  country: 'IN',
}

/** Northwind Outfitters — the merchant. */
export const MERCHANT: PersonaSeed = {
  id: 'usr_223456789ABCDEFGHJKMNPQRST' as UserId,
  persona: 'MERCHANT',
  displayName: 'Northwind Outfitters',
  email: 'merchant.northwind@example.com',
  country: 'US',
}

/** The judge who runs S-21 / §8.20. */
export const JUDGE: PersonaSeed = {
  id: 'usr_323456789ABCDEFGHJKMNPQRST' as UserId,
  persona: 'JUDGE',
  displayName: 'Demo Judge',
  email: 'judge.countersign@example.com',
  country: 'IN',
}

/** Seeded in this order so the summary reads buyer → merchant → judge. */
export const SEED_PERSONAS: readonly PersonaSeed[] = [BUYER, MERCHANT, JUDGE]

/**
 * The placeholder wallet row for Asha, so `wallet_caps` has a foreign key to point at.
 *
 * ### Why a placeholder exists at all
 *
 * `wallet_caps.wallet_id` references `paypal_wallets.id`, and a wallet cannot exist before S-02 saves
 * a real PayPal payment token. Seeding a placeholder lets `pnpm db:seed` deliver the wallet caps the
 * spec asks for on a fresh database, so Gate check 9 / EC-MA-1 has something to enforce from the
 * first run.
 *
 * ### Why it is safe
 *
 * `payment_token_id` is `SEED_PLACEHOLDER_VAULT_TOKEN`, which is not a PayPal id. Any order create with
 * it fails at PayPal — correctly, because the wallet has not been enrolled. The row is *not* a claim
 * that a vault exists.
 *
 * **After onboarding (S-02), WP-07 must update this row in place** rather than insert a second wallet:
 * `update paypal_wallets set payment_token_id = $1 where id = SEED_WALLET_ID`. Inserting a fresh wallet
 * would leave the wallet cap attached to the placeholder, and the wallet-level limit would silently
 * stop applying to the wallet Asha actually uses. `seed/run.ts` prints this warning.
 */
export const SEED_WALLET_ID = 'wal_423456789ABCDEFGHJKMNPQRST' as WalletId
export const SEED_PLACEHOLDER_VAULT_TOKEN = 'SEED_PLACEHOLDER_VAULT_TOKEN'
export const SEED_PLACEHOLDER_PAYER_ID = 'SEED_PLACEHOLDER_PAYER_ID'

/**
 * Asha's device row, seeded so the settings screen (S-02) has something to show before enrolment.
 *
 * `public_jwk` is a **labelled placeholder**, not a key: a fabricated JWK would be a fake key in a
 * table whose entire purpose is proving which key signed what. WP-05 must replace it with a real
 * WebCrypto key pair during enrolment. It is exported so WP-05 can find the row to replace.
 */
export const SEED_DEVICE_ID = 'dev_523456789ABCDEFGHJKMNPQRST' as DeviceId
export const SEED_DEVICE_JKT = 'SEED_PLACEHOLDER_JKT'
export const SEED_DEVICE_LABEL = "Asha's laptop"
