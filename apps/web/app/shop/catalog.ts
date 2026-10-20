import 'server-only'

import { csError, err, ok, type CheckoutId, type CsError, type Result } from '@countersign/core'
import { INJECTION_SKUS, SEED_PRODUCTS, type ProductSeed } from '@countersign/db'
import { untrusted, type MerchantCatalogStore, type MerchantProduct } from '@countersign/gate'

type NewSessionRow = Parameters<MerchantCatalogStore['createCheckoutSession']>[0]
type RequireSessionResult = Awaited<ReturnType<MerchantCatalogStore['requireCheckoutSession']>>
type StoredSession = NonNullable<Extract<RequireSessionResult, { ok: true }>['value']>

interface ShopState {
  readonly stock: Map<string, number>
  readonly sessions: Map<string, StoredSession>
}

const globalStore = globalThis as typeof globalThis & {
  __countersignShopState?: ShopState
}

const state: ShopState = (globalStore.__countersignShopState ??= {
  stock: new Map<string, number>(
    SEED_PRODUCTS.map((product) => [product.sku, product.stock] as const),
  ),
  sessions: new Map<string, StoredSession>(),
})

function unknownSku(sku: string): CsError {
  return csError('CS_NOT_FOUND', `Unknown sku: ${sku}`, { sku })
}

function outOfStock(sku: string): CsError {
  return csError('GATE_OUT_OF_STOCK', `Not enough stock for: ${sku}`, { sku })
}

function toShopProduct(seed: ProductSeed): MerchantProduct {
  return {
    sku: seed.sku,
    title: seed.title,
    listing: untrusted(seed.description),
    price: seed.price,
    currency: seed.price.currency,
    stock: state.stock.get(seed.sku) ?? seed.stock,
    shipsInDays: seed.shipsInDays,
    digital: seed.digital,
    listingHtml: untrusted(seed.listingHtml, 'listing_html'),
  }
}

export function isInjectionSku(sku: string): boolean {
  return (INJECTION_SKUS as readonly string[]).includes(sku)
}

export const shopCatalog: MerchantCatalogStore = {
  listProducts(): Promise<Result<readonly MerchantProduct[], CsError>> {
    return Promise.resolve(ok(SEED_PRODUCTS.map(toShopProduct)))
  },
  findProductBySku(sku: string): Promise<Result<MerchantProduct | undefined, CsError>> {
    const seed = SEED_PRODUCTS.find((product) => product.sku === sku)
    return Promise.resolve(ok(seed === undefined ? undefined : toShopProduct(seed)))
  },
  lockStock(_tx: unknown, sku: string): Promise<Result<number, CsError>> {
    const stock = state.stock.get(sku)
    if (stock === undefined) return Promise.resolve(err(unknownSku(sku)))
    if (stock <= 0) return Promise.resolve(err(outOfStock(sku)))
    return Promise.resolve(ok(stock))
  },
  decrementStock(_tx: unknown, sku: string, qty: number): Promise<Result<number, CsError>> {
    const stock = state.stock.get(sku)
    if (stock === undefined) return Promise.resolve(err(unknownSku(sku)))
    if (qty > stock) return Promise.resolve(err(outOfStock(sku)))
    const remaining = stock - qty
    state.stock.set(sku, remaining)
    return Promise.resolve(ok(remaining))
  },
  restoreStock(_tx: unknown, sku: string, qty: number): Promise<Result<number, CsError>> {
    const restored = (state.stock.get(sku) ?? 0) + qty
    state.stock.set(sku, restored)
    return Promise.resolve(ok(restored))
  },
  createCheckoutSession(row: NewSessionRow): Promise<Result<{ id: string }, CsError>> {
    state.sessions.set(row.id, { ...row, status: 'OPEN' })
    return Promise.resolve(ok({ id: row.id }))
  },
  requireCheckoutSession(id: CheckoutId): Promise<Result<StoredSession | undefined, CsError>> {
    return Promise.resolve(ok(state.sessions.get(id)))
  },
}
