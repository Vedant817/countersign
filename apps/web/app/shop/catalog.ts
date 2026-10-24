import 'server-only'

import { z } from 'zod'
import { CURRENCIES, csError, err, ok, type CsError, type Result } from '@countersign/core'
import * as repository from '@countersign/db'
import { untrusted, type MerchantCatalogStore, type MerchantProduct } from '@countersign/gate'

type NewSession = Parameters<MerchantCatalogStore['createCheckoutSession']>[0]
type Session = NonNullable<
  Extract<
    Awaited<ReturnType<MerchantCatalogStore['requireCheckoutSession']>>,
    { ok: true }
  >['value']
>

/** Only an explicit, non-production opt-in permits seed browsing. It never permits purchases. */
export function shopCatalogMode(): 'database' | 'demo-browse-only' | 'unavailable' {
  if (process.env['DATABASE_URL']?.trim()) return 'database'
  return process.env['NODE_ENV'] !== 'production' && process.env['COUNTERSIGN_DEMO_CATALOG'] === '1'
    ? 'demo-browse-only'
    : 'unavailable'
}

export function shopPersistenceError(): CsError {
  return csError('CS_INTERNAL', 'Merchant persistence requires DATABASE_URL.', undefined, {
    userMessage: 'The merchant database is unavailable. Checkout is disabled.',
  })
}

const minor = z.bigint().nonnegative()
const quantity = z.number().int().positive().max(2147483647)
const cart = z.object({
  lines: z
    .array(
      z.object({
        sku: z.string().min(1),
        title: z.string().min(1),
        qty: quantity,
        unit_minor: minor,
      }),
    )
    .min(1),
})
const session = z
  .object({
    id: z.custom<NewSession['id']>((v) => typeof v === 'string' && v.startsWith('chk_')),
    merchant_id: z.string().min(1),
    cart,
    subtotal_minor: minor,
    tax_minor: minor,
    shipping_minor: minor,
    total_minor: minor,
    currency: z.enum(CURRENCIES),
    checkout_jwt: z.string().min(1),
    checkout_hash: z.string().min(1),
    price_lock_exp: z.date(),
  })
  .refine(
    (row) =>
      row.total_minor === row.subtotal_minor + row.tax_minor + row.shipping_minor &&
      row.subtotal_minor ===
        row.cart.lines.reduce((sum, line) => sum + BigInt(line.qty) * line.unit_minor, 0n),
  )
const storedCart = z.object({
  lines: z
    .array(
      z.object({
        sku: z.string().min(1),
        title: z.string().min(1),
        qty: quantity,
        // Numbers have already lost precision before decoding. Accept canonical decimal strings only.
        unit_minor: z
          .string()
          .regex(/^(0|[1-9][0-9]*)$/)
          .transform((v) => BigInt(v)),
      }),
    )
    .min(1),
})

function invalidSession() {
  return err(csError('CS_VALIDATION', 'Invalid persisted merchant checkout session.'))
}

function toProduct(row: repository.ProductRow): MerchantProduct {
  return {
    sku: row.sku,
    title: row.title,
    listing: untrusted(row.description),
    price: { minor: row.price_minor, currency: row.currency },
    currency: row.currency,
    stock: row.stock,
    shipsInDays: row.ships_in_days,
    digital: row.digital,
    listingHtml: untrusted(row.listing_html, 'listing_html'),
  }
}

function demoProducts(): MerchantProduct[] {
  return repository.SEED_PRODUCTS.map((seed) => ({
    sku: seed.sku,
    title: seed.title,
    listing: untrusted(seed.description),
    price: seed.price,
    currency: seed.price.currency,
    stock: seed.stock,
    shipsInDays: seed.shipsInDays,
    digital: seed.digital,
    listingHtml: untrusted(seed.listingHtml, 'listing_html'),
  }))
}

export function isInjectionSku(sku: string): boolean {
  return (repository.INJECTION_SKUS as readonly string[]).includes(sku)
}

// The opaque merchant port accepts unknown, but a plausible object is not proof of an active DB tx.
const activeTransactions = new WeakMap<object, repository.Tx>()
function transaction(value: unknown): repository.Tx | undefined {
  return typeof value === 'object' && value !== null ? activeTransactions.get(value) : undefined
}
function transactionError() {
  return err(
    csError(
      'CS_VALIDATION',
      'Merchant stock operations require an active withShopTransaction handle.',
    ),
  )
}

/** Genuine DB transaction; business errors throw internally so partial writes roll back. */
export async function withShopTransaction<T>(
  fn: (tx: unknown) => Promise<Result<T, CsError>>,
): Promise<Result<T, CsError>> {
  if (shopCatalogMode() !== 'database') return err(shopPersistenceError())
  const result = await repository.withTx(async (tx) => {
    activeTransactions.set(tx, tx)
    try {
      const value = await fn(tx)
      if (!value.ok) throw value.error
      return value.value
    } finally {
      activeTransactions.delete(tx)
    }
  })
  return result
}

export const shopCatalog: MerchantCatalogStore = {
  async listProducts() {
    const mode = shopCatalogMode()
    if (mode === 'demo-browse-only') return ok(demoProducts())
    if (mode !== 'database') return err(shopPersistenceError())
    const rows = await repository.listProducts()
    return rows.ok ? ok(rows.value.map(toProduct)) : rows
  },
  async findProductBySku(sku) {
    // Used by create_checkout: demonstration listings are never price/stock authority.
    if (shopCatalogMode() !== 'database') return err(shopPersistenceError())
    const row = await repository.findProductBySku(sku)
    return row.ok ? ok(row.value === undefined ? undefined : toProduct(row.value)) : row
  },
  async lockStock(handle, sku) {
    if (shopCatalogMode() !== 'database') return err(shopPersistenceError())
    const tx = transaction(handle)
    return tx === undefined ? transactionError() : repository.lockStock(sku, tx)
  },
  async decrementStock(handle, sku, qty) {
    if (shopCatalogMode() !== 'database') return err(shopPersistenceError())
    const tx = transaction(handle)
    if (tx === undefined) return transactionError()
    if (!quantity.safeParse(qty).success)
      return err(csError('CS_VALIDATION', 'Invalid stock quantity.'))
    const row = await repository.decrementStock(sku, qty, new Date(), tx)
    return row.ok ? ok(row.value.stock) : row
  },
  async restoreStock(handle, sku, qty) {
    if (shopCatalogMode() !== 'database') return err(shopPersistenceError())
    const tx = transaction(handle)
    if (tx === undefined) return transactionError()
    if (!quantity.safeParse(qty).success)
      return err(csError('CS_VALIDATION', 'Invalid stock quantity.'))
    const row = await repository.restoreStock(sku, qty, new Date(), tx)
    return row.ok ? ok(row.value.stock) : row
  },
  async createCheckoutSession(input, handle) {
    if (shopCatalogMode() !== 'database') return err(shopPersistenceError())
    const tx = transaction(handle)
    if (handle !== undefined && tx === undefined) return transactionError()
    const parsed = session.safeParse(input)
    if (!parsed.success) return invalidSession()
    const row = parsed.data
    const created = await repository.createCheckoutSession(
      {
        ...row,
        status: 'CREATED',
        cart: {
          lines: row.cart.lines.map((line) => ({
            ...line,
            unit_minor: line.unit_minor.toString(),
          })),
        },
      },
      tx,
    )
    return created.ok ? ok({ id: created.value.id }) : created
  },
  async requireCheckoutSession(id, handle) {
    if (shopCatalogMode() !== 'database') return err(shopPersistenceError())
    const tx = transaction(handle)
    if (handle !== undefined && tx === undefined) return transactionError()
    const found = await repository.findCheckoutSessionById(id, tx)
    if (!found.ok) return found
    if (found.value === undefined) return ok(undefined)
    const row = found.value
    const decoded = storedCart.safeParse(row.cart)
    if (!decoded.success) return invalidSession()
    const parsed = session.safeParse({ ...row, cart: decoded.data })
    if (!parsed.success || parsed.data.id !== id) return invalidSession()
    const statuses = {
      CREATED: 'OPEN',
      SUBMITTED: 'SUBMITTED',
      COMPLETED: 'COMPLETED',
      EXPIRED: 'EXPIRED',
      ABANDONED: 'ABANDONED',
    } as const
    const storedStatus = z
      .enum(repository.checkoutSessionStatusEnum.enumValues)
      .safeParse(row.status)
    if (!storedStatus.success) return invalidSession()
    const status = statuses[storedStatus.data]
    const value: Session = { ...parsed.data, status }
    return ok(value)
  },
}
