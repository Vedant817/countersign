/**
 * The seeded Northwind catalog, in the compiler's vocabulary — for the **offline** eval runs.
 *
 * The corpus in `corpus/compiler.jsonl` is scored against the store the app actually seeds
 * (`packages/db/src/seed/products.ts`: 24 items, `NW-001`..`NW-024`). Reading that array rather than
 * copying it means a corpus case cannot drift from the catalog it is asserted against: renaming a product
 * in the seed changes the lexicon, and the eval fails (or passes) for the same reason the app would.
 *
 * The merchant id is the one `MERCHANT_ID` is set to in `scripts/dev-local.mjs` — `mrc_northwind` — so
 * the offline run and the live run constrain the same store.
 */
import type { Currency } from '@countersign/core'
import { SEED_PRODUCTS } from '@countersign/db'

import type { CatalogMerchant, CatalogProjection } from '@countersign/compiler'

/** The one store this deployment sells as. Matches `MERCHANT_ID` in the local dev environment. */
export const NORTHWIND: CatalogMerchant = {
  id: 'mrc_northwind',
  name: 'Northwind Outfitters',
  website: 'https://northwind.countersign.test',
}

/**
 * The catalog projection the compiler reads. Built fresh per call (it is cheap, and a shared mutable
 * object would be one more thing a test could accidentally change under another test).
 */
export function northwindCatalog(): CatalogProjection {
  return {
    merchants: [NORTHWIND],
    skus: SEED_PRODUCTS.map((product) => ({
      id: product.sku,
      title: product.title,
      merchantId: NORTHWIND.id,
      priceMinor: product.price.minor,
      currency: product.price.currency as Currency,
      inStock: product.stock > 0,
    })),
  }
}

/** Merchant id → display name, for the read-back the offline runner renders. */
export const MERCHANT_NAMES: Readonly<Record<string, string>> = {
  [NORTHWIND.id]: NORTHWIND.name,
}
