/**
 * `@countersign/db` — spec **§7** (data model), **§8.2 (M2)**, work package **WP-02**.
 *
 * The public surface of the package is three things and nothing else:
 *
 *  - **the schema** (`schema.ts`) — all 27 tables from §7.2 plus the pg-boss `jobs` table,
 *  - **a lazily-created connection** (`client.ts`) — `db()`, `withTx(fn)`, `closeDb()`,
 *  - **one repository per aggregate** (`repos/`) — every function returning `Result<T, CsError>` and
 *    taking an optional transaction handle as its last argument.
 *
 * The subpath exports match `package.json`: `@countersign/db/schema`, `@countersign/db/client`,
 * `@countersign/db/repos`. Import from those rather than from deep paths, so the file layout stays an
 * implementation detail.
 *
 * Two rules travel with this package and are worth restating at the top of every file that uses it:
 *
 *  1. **Money is integer minor units (`bigint`) plus a `char(3)` currency.** No float, no `numeric`,
 *     no `doublePrecision`. `test/schema.test.ts` fails the build if a float type reaches the schema.
 *  2. **No package bypasses a repository to write a money column.** A direct `db().update(orders)` from
 *     another work package can skip the currency check, the lock, or the ledger entry that makes the
 *     write defensible later.
 */
export * from './client'
export * from './schema'
export * from './repos'

export {
  INJECTION_PAYLOADS,
  INJECTION_SKUS,
  JPY_SKU,
  DIGITAL_SKU,
  LAST_UNIT_SKUS,
  SEED_PRODUCTS,
  catalogCurrencies,
  injectionCount,
  lastUnitCount,
  type ProductSeed,
} from './seed/products'
export {
  BUYER,
  JUDGE,
  MERCHANT,
  NORTHWIND_MERCHANT_ID,
  PERSONAS,
  SEED_DEVICE_ID,
  SEED_DEVICE_JKT,
  SEED_PERSONAS,
  SEED_PLACEHOLDER_PAYER_ID,
  SEED_PLACEHOLDER_VAULT_TOKEN,
  SEED_WALLET_ID,
  type Persona,
  type PersonaSeed,
} from './seed/personas'
export { SEED_WALLET_CAP, renderSummary, runSeed, type SeedSummary } from './seed/run'
