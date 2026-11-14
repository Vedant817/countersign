/**
 * The seed — spec **§8.2 AT-M2.2** ("Seed is idempotent"), §7.2.
 *
 * ```bash
 * pnpm db:seed        # or: pnpm --filter @countersign/db seed
 * ```
 *
 * ## Idempotency is structural, not best-effort
 *
 * Every write goes through `onConflictDoUpdate` (or `onConflictDoNothing`) against a **stable natural
 * key** — `users.id`, `products.sku`, `wallet_caps.wallet_id`, `paypal_wallets.id`. Nothing here calls
 * `newId()` or reads a clock for an identity. That is the whole trick: a seed that mints fresh ids
 * cannot be idempotent, and a seed that is only *usually* idempotent is a demo that works on day one
 * and is broken by day two.
 *
 * ## What it writes
 *
 * | Rows | Natural key | Notes |
 * |---|---|---|
 * | 3 `users` | `users.id` | Asha, Northwind Outfitters, the judge |
 * | 1 `devices` row | `devices.id` | Placeholder JWK — WP-05 replaces it at enrolment |
 * | 1 `paypal_wallets` row | `paypal_wallets.id` | Placeholder vault token; see `personas.ts` |
 * | 1 `wallet_caps` row | `wallet_caps.wallet_id` | Asha's DAY cap (EC-MA-1 / Gate check 9) |
 * | 24 `products` | `products.sku` | 3 injections, 2 last-unit, 1 JPY, 1 digital |
 *
 * ## What it deliberately does not write
 *
 * `mandates`, `l1_credentials`, `budget_accounts`, `budget_entries`, `orders`, `attempts`, `disputes`.
 * Those need real key material and real signatures. A seeded `l2_serialized` would be a fabricated
 * signed artefact sitting in the middle of the evidence chain — the one thing this project must never
 * contain. They appear when the buyer actually enrols and signs (S-02 → S-04).
 *
 * ## Running it without a database
 *
 * `pnpm --filter @countersign/db test` never runs this file: the tests import `personas.ts` and
 * `products.ts` directly and assert on the data, so the PR gate passes with no Postgres (AT-M2.2's
 * "seed is idempotent" is proven by {@link runSeed} being written only in terms of upserts, plus the
 * upsert-shaped unit tests in `test/seed.test.ts`).
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { and, eq, isNull } from 'drizzle-orm'

import { formatMoney } from '@countersign/core'

import { closeDb, db, withTx, type Exec } from '../client'
import { devices, merchants, paypalWallets, users, walletCaps, type JsonValue } from '../schema'
import { setPasswordHash } from '../repos/users'
import { upsertProduct } from '../repos/products'
import { hashPassword } from '../password'
import { repo } from '../repos'

import {
  BUYER,
  MERCHANT,
  SEED_DEVICE_ID,
  SEED_DEVICE_JKT,
  SEED_DEVICE_LABEL,
  SEED_PERSONAS,
  SEED_PLACEHOLDER_PAYER_ID,
  SEED_PLACEHOLDER_VAULT_TOKEN,
  SEED_WALLET_ID,
} from './personas'
import { SEED_PRODUCTS, catalogCurrencies } from './products'

/** The public JWK placeholder shape. Deliberately obviously not a key. */
const PLACEHOLDER_JWK: JsonValue = {
  kty: 'EC',
  crv: 'P-256',
  x: 'SEED_PLACEHOLDER_NOT_A_REAL_KEY',
  y: 'SEED_PLACEHOLDER_NOT_A_REAL_KEY',
  kid: 'SEED_PLACEHOLDER',
}

const PLACEHOLDER_WALLET_RAW: JsonValue = {
  _placeholder: true,
  note: 'Not a PayPal response. Replace during S-02 onboarding before creating any order.',
}

/**
 * Asha's wallet cap. A $50/day cap against a $130 mandate cap is deliberate: the two limits exercise
 * different code paths, so the demo can show Gate check 8 passing while check 9 blocks, and the reverse.
 */
export const SEED_WALLET_CAP = Object.freeze({
  period: 'DAY' as const,
  capMinor: 5000n,
  currency: 'USD' as const,
})

/** Counts of what the run wrote, for the summary. */
export interface SeedSummary {
  readonly users: number
  readonly devices: number
  readonly wallets: number
  readonly walletCaps: number
  readonly products: number
  readonly currencies: readonly string[]
  readonly injections: number
  readonly lastUnits: number
  readonly digital: number
  /** Whether `MERCHANT_PASSWORD` was set, so the merchant has a password login (D-059). */
  readonly merchantPasswordSet: boolean
}

/**
 * Run the whole seed. Idempotent: safe to run any number of times, in any order relative to itself.
 *
 * @param exec pass `client.withTx`'s handle to make the whole seed one transaction, or omit it to let
 * each step commit on its own. All-at-once is nicer for a fresh database; per-step is safer for a
 * partially-seeded one, because one bad row cannot roll back the personas.
 */
export async function runSeed(exec?: Exec): Promise<SeedSummary> {
  const e = exec ?? db()

  for (const persona of SEED_PERSONAS) {
    const written = await repo(
      async () => {
        await e
          .insert(users)
          .values({
            id: persona.id,
            persona: persona.persona,
            display_name: persona.displayName,
            email: persona.email,
            country: persona.country,
          })
          .onConflictDoUpdate({
            target: users.id,
            set: {
              persona: persona.persona,
              display_name: persona.displayName,
              email: persona.email,
              country: persona.country,
              updated_at: new Date(),
            },
          })
      },
      { table: 'users', id: persona.id },
    )
    if (!written.ok) throw written.error
  }

  const rawPaypalMerchantId =
    process.env['MERCHANT_ID']?.trim() || process.env['PAYPAL_MERCHANT_ID']?.trim()
  const paypalMerchantId =
    rawPaypalMerchantId && rawPaypalMerchantId.length > 0 ? rawPaypalMerchantId : null
  const merchantId = `mer_${MERCHANT.id.replace(/^usr_/, '')}`

  const seededMerchant = await repo(
    async () => {
      await e
        .insert(merchants)
        .values({
          id: merchantId,
          owner_user_id: MERCHANT.id,
          display_name: MERCHANT.displayName,
          paypal_merchant_id: paypalMerchantId,
        })
        .onConflictDoNothing({
          target: merchants.owner_user_id,
        })
      if (paypalMerchantId) {
        await e
          .update(merchants)
          .set({ paypal_merchant_id: paypalMerchantId, updated_at: new Date() })
          .where(and(eq(merchants.id, merchantId), isNull(merchants.paypal_merchant_id)))
      }
    },
    { table: 'merchants', id: merchantId },
  )
  if (!seededMerchant.ok) throw seededMerchant.error

  // D-059: the merchant is the only persona with a password, and only when the operator supplied one.
  // An unset `MERCHANT_PASSWORD` deliberately leaves `password_hash` alone: clearing it on a re-run
  // would sign the merchant out of their own deployment because a shell variable was forgotten.
  const merchantPassword = process.env['MERCHANT_PASSWORD']?.trim() ?? ''
  const merchantPasswordSet = merchantPassword.length > 0
  if (merchantPasswordSet) {
    const hashed = await hashPassword(merchantPassword)
    const stored = await setPasswordHash(MERCHANT.id, hashed, e)
    if (!stored.ok) throw stored.error
  }

  const device = await repo(
    async () => {
      await e
        .insert(devices)
        .values({
          id: SEED_DEVICE_ID,
          user_id: BUYER.id,
          public_jwk: PLACEHOLDER_JWK,
          jkt: SEED_DEVICE_JKT,
          label: SEED_DEVICE_LABEL,
        })
        .onConflictDoUpdate({
          target: devices.id,
          set: { label: SEED_DEVICE_LABEL, updated_at: new Date() },
        })
    },
    { table: 'devices', id: SEED_DEVICE_ID },
  )
  if (!device.ok) throw device.error

  const wallet = await repo(
    async () => {
      await e
        .insert(paypalWallets)
        .values({
          id: SEED_WALLET_ID,
          user_id: BUYER.id,
          payment_token_id: SEED_PLACEHOLDER_VAULT_TOKEN,
          payer_id: SEED_PLACEHOLDER_PAYER_ID,
          payer_email: BUYER.email,
          status: 'ACTIVE',
          customer_id: null,
          raw: PLACEHOLDER_WALLET_RAW,
        })
        .onConflictDoUpdate({
          // Keyed on `id`, **not** on `payment_token_id`. Upserting on the token would insert a second
          // wallet the moment Asha enrols with a real vault token, orphaning the wallet cap below.
          target: paypalWallets.id,
          set: { updated_at: new Date() },
        })
    },
    { table: 'paypal_wallets', id: SEED_WALLET_ID },
  )
  if (!wallet.ok) throw wallet.error

  const cap = await repo(
    async () => {
      await e
        .insert(walletCaps)
        .values({
          wallet_id: SEED_WALLET_ID,
          period: SEED_WALLET_CAP.period,
          cap_minor: SEED_WALLET_CAP.capMinor,
          currency: SEED_WALLET_CAP.currency,
        })
        .onConflictDoUpdate({
          target: walletCaps.wallet_id,
          set: {
            period: SEED_WALLET_CAP.period,
            cap_minor: SEED_WALLET_CAP.capMinor,
            currency: SEED_WALLET_CAP.currency,
            updated_at: new Date(),
          },
        })
    },
    { table: 'wallet_caps', walletId: SEED_WALLET_ID },
  )
  if (!cap.ok) throw cap.error

  for (const product of SEED_PRODUCTS) {
    const written = await upsertProduct(
      {
        sku: product.sku,
        title: product.title,
        description: product.description,
        price_minor: product.price.minor,
        currency: product.price.currency,
        stock: product.stock,
        ships_in_days: product.shipsInDays,
        digital: product.digital,
        listing_html: product.listingHtml,
      },
      e,
    )
    if (!written.ok) throw written.error
  }

  return {
    users: SEED_PERSONAS.length,
    devices: 1,
    wallets: 1,
    walletCaps: 1,
    products: SEED_PRODUCTS.length,
    currencies: catalogCurrencies(),
    injections: SEED_PRODUCTS.filter(
      (p) => p.listingHtml.includes('SYSTEM:') || p.listingHtml.includes('Price updated'),
    ).length,
    lastUnits: SEED_PRODUCTS.filter((p) => p.stock === 1).length,
    digital: SEED_PRODUCTS.filter((p) => p.digital).length,
    merchantPasswordSet,
  }
}

/**
 * The operator-facing summary.
 *
 * Includes the two warnings that matter, because a seeded database that *looks* ready and is not is the
 * failure mode a demo invites: the placeholder wallet is not an enrolled PayPal vault, and no mandate
 * exists until the buyer signs one.
 */
export function renderSummary(s: SeedSummary): string {
  const money = formatMoney({ minor: SEED_WALLET_CAP.capMinor, currency: SEED_WALLET_CAP.currency })
  return [
    'db:seed complete (idempotent — running it again changes nothing)',
    '',
    `  users        ${s.users}  (${SEED_PERSONAS.map((p) => `${p.displayName} [${p.persona}]`).join(', ')})`,
    `  merchant     ${s.merchantPasswordSet ? 'password sign-in configured' : 'NO password - set MERCHANT_PASSWORD and re-run to enable /login'}`,
    `  devices      ${s.devices}  (placeholder JWK - WP-05 replaces it at enrolment)`,
    `  wallets      ${s.wallets}  (placeholder vault token — S-02 onboarding replaces it)`,
    `  wallet_caps  ${s.walletCaps}  (${SEED_WALLET_CAP.period} cap ${money} on ${SEED_WALLET_ID})`,
    `  products     ${s.products}  currencies: ${s.currencies.join(', ')}`,
    `               ${s.injections} with injection payloads, ${s.lastUnits} with stock=1, ${s.digital} digital`,
    '',
    '  Not seeded, by design: l1_credentials, mandates, budget_accounts, budget_entries,',
    '  attempts, orders, disputes. Those need real keys and real signatures — they appear when',
    '  Asha enrols (S-02) and signs a mandate (S-04).',
    '',
    `  NEXT: after onboarding, UPDATE paypal_wallets SET payment_token_id = $1 WHERE id = '${SEED_WALLET_ID}'`,
    '  so the wallet cap above keeps applying to the wallet Asha actually uses.',
  ].join('\n')
}

/** CLI entry point. `pnpm db:seed` calls this. */
async function main(): Promise<void> {
  try {
    // One transaction: a half-seeded database is worse than a failed seed, because the next person to
    // run `db:seed` cannot tell which half landed.
    const result = await withTx(async (tx) => runSeed(tx))
    if (!result.ok) {
      console.error(`db:seed failed: ${result.error.code}: ${result.error.message}`)
      process.exitCode = 1
      return
    }
    console.info(renderSummary(result.value))
  } catch (cause) {
    console.error(`db:seed failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    process.exitCode = 1
  } finally {
    await closeDb()
  }
}

// Only run when invoked as a program, so importing this module from a test (or from the package
// barrel, which re-exports `runSeed`) never seeds anything. The check compares the *resolved* entry
// file against this module's own URL — a substring test on `process.argv[1]` would fire for any test
// runner or script whose path happened to contain "run".
const invokedDirectly = (() => {
  const entry = process.argv[1]
  if (entry === undefined) return false
  return import.meta.url === pathToFileURL(resolve(entry)).href
})()

if (invokedDirectly) {
  void main()
}

export { MERCHANT, SEED_PRODUCTS }
