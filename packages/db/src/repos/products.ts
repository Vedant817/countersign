/**
 * `products` repository — spec §7.2, §8.9 (merchant catalog, WP-09).
 *
 * `sku` is the natural key and the primary key, which is what makes the seed idempotent: re-running
 * `pnpm db:seed` upserts on `sku` and never invents a second identity for the same item (AT-M2.2).
 *
 * **`listing_html` is untrusted input.** Spec §8.9 returns it to the agent inside a
 * `{"untrusted_text": …}` wrapper, and spec §8.13's injection defences depend on the three seeded
 * payloads being present. This repo returns the raw string and does no sanitising: sanitising here
 * would hide the payloads from the agent test and make the seed and the defence drift apart.
 */
import { and, eq, lte, sql } from 'drizzle-orm'

import type { CsError, Money, Result } from '@countersign/core'
import { currency, toPayPalValue } from '@countersign/core'

import { db, type Exec } from '../client'
import { products, type NewProduct, type ProductRow } from '../schema'
import { err, repo } from './index'

export function createProduct(
  input: NewProduct,
  exec?: Exec,
): Promise<Result<ProductRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db()).insert(products).values(input).returning()
      const row = rows[0]
      if (!row) throw new Error('INSERT ... RETURNING produced no products row')
      return row as ProductRow
    },
    { table: 'products', sku: input.sku },
  )
}

/**
 * Insert-or-update by `sku`. This is the seed's only write path, which is what makes AT-M2.2
 * ("seed is idempotent") true by construction rather than by convention.
 *
 * `listing_html` is updated on conflict on purpose: it is merchant-controlled content, and a seed that
 * froze it would make an edited demo listing impossible to fix without dropping the table.
 */
export function upsertProduct(
  input: NewProduct,
  exec?: Exec,
): Promise<Result<ProductRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .insert(products)
        .values(input)
        .onConflictDoUpdate({
          target: products.sku,
          set: {
            title: input.title,
            description: input.description,
            price_minor: input.price_minor,
            currency: input.currency,
            stock: input.stock,
            ships_in_days: input.ships_in_days,
            digital: input.digital,
            listing_html: input.listing_html,
            updated_at: new Date(),
          },
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error('UPSERT ... RETURNING produced no products row')
      return row as ProductRow
    },
    { table: 'products', sku: input.sku },
  )
}

export function findProductBySku(
  sku: string,
  exec?: Exec,
): Promise<Result<ProductRow | undefined, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(products)
        .where(eq(products.sku, sku))
        .limit(1)
      return rows[0] as ProductRow | undefined
    },
    { table: 'products', sku },
  )
}

export function findProductsBySku(
  skus: readonly string[],
  exec?: Exec,
): Promise<Result<ProductRow[], CsError>> {
  return repo(
    async () => {
      if (skus.length === 0) return []
      const rows = await (exec ?? db())
        .select()
        .from(products)
        .where(sql`${products.sku} in ${skus.map((s) => sql`${s}`)}`)
      return rows as ProductRow[]
    },
    { table: 'products', skus },
  )
}

/** `search_products {query, max_price_minor?}` (§8.9). `max_price_minor` is integer minor units. */
export function searchProducts(
  query: {
    text?: string
    maxPriceMinor?: bigint
    currency?: Money['currency']
    inStockOnly?: boolean
  },
  exec?: Exec,
): Promise<Result<ProductRow[], CsError>> {
  return repo(
    async () => {
      const clauses = []
      if (query.text !== undefined && query.text !== '') {
        const pattern = `%${query.text}%`
        clauses.push(
          sql`(${products.title} ilike ${pattern} or ${products.description} ilike ${pattern} or ${products.sku} ilike ${pattern})`,
        )
      }
      if (query.maxPriceMinor !== undefined)
        clauses.push(lte(products.price_minor, query.maxPriceMinor))
      if (query.currency !== undefined)
        clauses.push(eq(products.currency, currency(query.currency)))
      if (query.inStockOnly === true) clauses.push(sql`${products.stock} > 0`)
      const where = clauses.length === 0 ? undefined : sql`${sql.join(clauses, sql` and `)}`
      const rows = await (exec ?? db()).select().from(products).where(where).orderBy(products.sku)
      return rows as ProductRow[]
    },
    { table: 'products', query },
  )
}

/**
 * Take `qty` units off the shelf. **Gate/M11 must call this inside a transaction with a row lock.**
 *
 * EC-STOCK-3 (last-unit race): the caller does
 * `SELECT … FROM products WHERE sku = $1 FOR UPDATE`, reads `stock`, and only then writes. This repo
 * exposes the two halves separately (`lockStock`/`readStock` then `decrementStock`) rather than a
 * single atomic `UPDATE … WHERE stock >= qty`, because the Gate also has to read `shipping`/`digital`
 * in the same locked snapshot to pick the `AUTHORIZE` vs `CAPTURE` intent (D17).
 *
 * `products_stock_non_negative` is the backstop CHECK; the row lock is the mechanism.
 */
export function lockStock(sku: string, exec: Exec): Promise<Result<number, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select({ stock: products.stock })
        .from(products)
        .where(eq(products.sku, sku))
        .for('update')
      const row = rows[0]
      if (!row) {
        return err({
          code: 'CS_NOT_FOUND',
          message: `No products row for sku ${sku}`,
          userMessage: 'That item is no longer in the store.',
          retryable: false,
          details: { table: 'products', sku },
        })
      }
      return row.stock
    },
    { table: 'products', sku, op: 'lock_stock' },
  )
}

/**
 * Decrement stock. Refuses with `GATE_OUT_OF_STOCK` rather than writing a negative number, so the
 * buyer is told the item just sold out (EC-STOCK-3's user-facing behaviour) instead of getting a 500.
 */
export function decrementStock(
  sku: string,
  qty: number,
  at: Date,
  exec: Exec,
): Promise<Result<ProductRow, CsError>> {
  return repo(
    async () => {
      if (qty <= 0) {
        return err({
          code: 'CS_VALIDATION',
          message: `decrementStock needs qty > 0; got ${qty}`,
          userMessage: 'That cart does not add up. Refresh and try again.',
          retryable: false,
          details: { table: 'products', sku, qty },
        })
      }
      const rows = await (exec ?? db())
        .update(products)
        .set({ stock: sql`${products.stock} - ${qty}`, updated_at: at })
        .where(and(eq(products.sku, sku), sql`${products.stock} >= ${qty}`))
        .returning()
      const row = rows[0]
      if (!row) {
        return err({
          code: 'GATE_OUT_OF_STOCK',
          message: `Not enough stock for ${sku} (requested ${qty})`,
          userMessage: 'That item just sold out.',
          retryable: false,
          details: { table: 'products', sku, qty },
        })
      }
      return row as ProductRow
    },
    { table: 'products', sku, qty },
  )
}

/** EC-STOCK-1: a void or an out-of-stock line puts the units back. */
export function restoreStock(
  sku: string,
  qty: number,
  at: Date,
  exec?: Exec,
): Promise<Result<ProductRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .update(products)
        .set({ stock: sql`${products.stock} + ${qty}`, updated_at: at })
        .where(eq(products.sku, sku))
        .returning()
      const row = rows[0]
      if (!row) throw new Error(`No products row for sku ${sku}`)
      return row as ProductRow
    },
    { table: 'products', sku, qty },
  )
}

/** The exact decimal string PayPal expects, straight from a stored row. Never a float. */
export function priceOf(row: ProductRow): Money {
  return { minor: row.price_minor, currency: row.currency }
}

export { toPayPalValue }

export function listProducts(exec?: Exec): Promise<Result<ProductRow[], CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db()).select().from(products).orderBy(products.sku)
      return rows as ProductRow[]
    },
    { table: 'products' },
  )
}
