import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { csError, err, ok, type CheckoutId } from '@countersign/core'
import type { CheckoutSessionRow, NewCheckoutSession, ProductRow } from '@countersign/db'
import type * as DatabaseModule from '@countersign/db'

const repos = vi.hoisted(() => ({
  listProducts: vi.fn(),
  findProductBySku: vi.fn(),
  createCheckoutSession: vi.fn(),
  findCheckoutSessionById: vi.fn(),
  findOrderByAttempt: vi.fn(),
  lockStock: vi.fn(),
  decrementStock: vi.fn(),
  restoreStock: vi.fn(),
  withTx: vi.fn(),
}))
vi.mock('@countersign/db', async (original) => ({
  ...(await original<typeof DatabaseModule>()),
  ...repos,
}))

const id: CheckoutId = 'chk_persistence'
const input = {
  id,
  merchant_id: 'merchant_actual',
  cart: {
    lines: [{ sku: 'actual', title: 'Actual DB item', qty: 2, unit_minor: 9007199254740993n }],
  },
  subtotal_minor: 18014398509481986n,
  tax_minor: 0n,
  shipping_minor: 500n,
  total_minor: 18014398509482486n,
  currency: 'USD' as const,
  checkout_jwt: 'stored-signed-value',
  checkout_hash: 'stored-hash',
  price_lock_exp: new Date('2026-10-24T10:00:00Z'),
}
const product: ProductRow = {
  sku: 'actual',
  title: 'Actual DB item',
  description: 'merchant description',
  price_minor: 12345n,
  currency: 'USD',
  stock: 7,
  ships_in_days: 8,
  digital: false,
  listing_html: '<p>merchant listing</p>',
  created_at: new Date(),
  updated_at: new Date(),
}
let persisted: CheckoutSessionRow | undefined

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.stubEnv('DATABASE_URL', 'postgres://test.invalid/not-connected')
  vi.stubEnv('COUNTERSIGN_DEMO_CATALOG', '')
  persisted = undefined
  repos.listProducts.mockResolvedValue(ok([product]))
  repos.findProductBySku.mockResolvedValue(ok(product))
  repos.createCheckoutSession.mockImplementation(async (row: NewCheckoutSession) => {
    persisted = {
      ...row,
      cart: JSON.parse(JSON.stringify(row.cart)),
      status: 'CREATED',
      created_at: new Date(),
      updated_at: new Date(),
    } as CheckoutSessionRow
    return ok(persisted)
  })
  repos.findCheckoutSessionById.mockImplementation(async () => ok(persisted))
})
afterEach(() => vi.unstubAllEnvs())

describe('persistent merchant catalog', () => {
  it('uses authoritative DB price, stock and listing instead of seed rows', async () => {
    const { shopCatalog } = await import('./catalog')
    expect(await shopCatalog.findProductBySku('actual')).toEqual(
      ok({
        sku: 'actual',
        title: product.title,
        listing: { untrusted_text: product.description },
        listingHtml: { untrusted_text: product.listing_html },
        price: { minor: 12345n, currency: 'USD' },
        currency: 'USD',
        stock: 7,
        shipsInDays: 8,
        digital: false,
      }),
    )
    const list = await shopCatalog.listProducts()
    expect(list.ok && list.value.map((p) => p.sku)).toEqual(['actual'])
  })
  it('round-trips decimal string JSON and reloads after losing all process state', async () => {
    let catalog = (await import('./catalog')).shopCatalog
    expect(await catalog.createCheckoutSession(input)).toEqual(ok({ id }))
    // A fresh process has no global store or module instance. The repository survives independently.
    Reflect.deleteProperty(globalThis, '__countersignShopState')
    vi.resetModules()
    catalog = (await import('./catalog')).shopCatalog
    expect(await catalog.requireCheckoutSession(id)).toEqual(ok({ ...input, status: 'OPEN' }))
    expect(persisted?.cart).toEqual({
      lines: [{ ...input.cart.lines[0], unit_minor: '9007199254740993' }],
    })
  })
  it('does not overwrite duplicate checkouts or hide repository failures', async () => {
    const { shopCatalog } = await import('./catalog')
    const failure = err(csError('CS_CONFLICT', 'duplicate session'))
    repos.createCheckoutSession.mockResolvedValue(failure)
    expect(await shopCatalog.createCheckoutSession(input)).toEqual(failure)
    repos.listProducts.mockResolvedValue(failure)
    expect(await shopCatalog.listProducts()).toEqual(failure)
  })
  it('fails closed without DB configuration including checkout persistence', async () => {
    vi.stubEnv('DATABASE_URL', '')
    const { shopCatalog } = await import('./catalog')
    expect((await shopCatalog.listProducts()).ok).toBe(false)
    expect((await shopCatalog.createCheckoutSession(input)).ok).toBe(false)
    expect((await shopCatalog.requireCheckoutSession(id)).ok).toBe(false)
    expect(repos.createCheckoutSession).not.toHaveBeenCalled()
  })
  it('rejects fabricated transaction handles and invalid stock quantities', async () => {
    const { shopCatalog } = await import('./catalog')
    expect((await shopCatalog.lockStock({}, 'actual')).ok).toBe(false)
    expect((await shopCatalog.decrementStock({}, 'actual', -2)).ok).toBe(false)
    expect((await shopCatalog.restoreStock({}, 'actual', 0.5)).ok).toBe(false)
    expect(repos.lockStock).not.toHaveBeenCalled()
    expect(repos.decrementStock).not.toHaveBeenCalled()
    expect(repos.restoreStock).not.toHaveBeenCalled()
  })
})

describe('merchant boundary validation', () => {
  it.each([
    null,
    {},
    { lines: [] },
    { lines: [{ sku: 'actual', title: 'Actual DB item', qty: 2, unit_minor: 42 }] },
    { lines: [{ sku: 'actual', title: 'Actual DB item', qty: 2, unit_minor: '-1' }] },
    { lines: [{ sku: 'actual', title: 'Actual DB item', qty: 0.5, unit_minor: '1' }] },
    { lines: [{ sku: 'actual', qty: 2, unit_minor: '9007199254740993' }] },
    { lines: [{ sku: 'actual', title: 'Actual DB item', qty: 2, unit_minor: '1e3' }] },
  ])('rejects invalid persisted cart %j', async (cart) => {
    const { shopCatalog } = await import('./catalog')
    await shopCatalog.createCheckoutSession(input)
    repos.findCheckoutSessionById.mockResolvedValue(ok({ ...persisted, cart }))
    expect((await shopCatalog.requireCheckoutSession(id)).ok).toBe(false)
  })
  it('rejects inconsistent totals, invalid dates, IDs and unknown statuses', async () => {
    const { shopCatalog } = await import('./catalog')
    await shopCatalog.createCheckoutSession(input)
    for (const patch of [
      { total_minor: 1n },
      { subtotal_minor: 1n },
      { price_lock_exp: new Date(NaN) },
      { id: 'chk_other' },
      { status: 'UNKNOWN' },
    ]) {
      repos.findCheckoutSessionById.mockResolvedValue(ok({ ...persisted, ...patch }))
      expect((await shopCatalog.requireCheckoutSession(id)).ok).toBe(false)
    }
    repos.createCheckoutSession.mockClear()
    expect((await shopCatalog.createCheckoutSession({ ...input, total_minor: 1n })).ok).toBe(false)
    expect(repos.createCheckoutSession).not.toHaveBeenCalled()
  })
  it('returns missing rows and preserves expired and completed sessions without reopening', async () => {
    const { shopCatalog } = await import('./catalog')
    expect(await shopCatalog.requireCheckoutSession(id)).toEqual(ok(undefined))
    await shopCatalog.createCheckoutSession(input)
    for (const status of ['EXPIRED', 'COMPLETED', 'SUBMITTED', 'ABANDONED']) {
      repos.findCheckoutSessionById.mockResolvedValue(ok({ ...persisted, status }))
      const result = await shopCatalog.requireCheckoutSession(id)
      expect(result.ok && result.value?.status).toBe(status)
    }
  })
  it('allows explicit demo browsing while refusing purchase authority and production fallback', async () => {
    vi.stubEnv('DATABASE_URL', '')
    vi.stubEnv('COUNTERSIGN_DEMO_CATALOG', '1')
    const { shopCatalog, shopCatalogMode, isInjectionSku } = await import('./catalog')
    expect(shopCatalogMode()).toBe('demo-browse-only')
    const rows = await shopCatalog.listProducts()
    expect(rows.ok && rows.value.length).toBe(24)
    expect(rows.ok && rows.value.some((p) => isInjectionSku(p.sku))).toBe(true)
    expect((await shopCatalog.findProductBySku('SKU-TRAIL-42')).ok).toBe(false)
    expect((await shopCatalog.createCheckoutSession(input)).ok).toBe(false)
    vi.stubEnv('NODE_ENV', 'production')
    expect(shopCatalogMode()).toBe('unavailable')
    expect((await shopCatalog.listProducts()).ok).toBe(false)
  })
  it('passes active transaction handles and rejects them once closed', async () => {
    const handle = {}
    repos.withTx.mockImplementation(async (fn) => ok(await fn(handle)))
    repos.lockStock.mockResolvedValue(ok(7))
    repos.decrementStock.mockResolvedValue(ok({ ...product, stock: 5 }))
    const { shopCatalog, withShopTransaction } = await import('./catalog')
    expect(
      await withShopTransaction(async (tx) => {
        expect(await shopCatalog.lockStock(tx, 'actual')).toEqual(ok(7))
        expect(await shopCatalog.decrementStock(tx, 'actual', 2)).toEqual(ok(5))
        expect((await shopCatalog.restoreStock(tx, 'actual', -1)).ok).toBe(false)
        return shopCatalog.createCheckoutSession(input, tx)
      }),
    ).toEqual(ok({ id }))
    expect(repos.lockStock).toHaveBeenCalledWith('actual', handle)
    expect(repos.createCheckoutSession.mock.calls[0]?.[1]).toBe(handle)
    expect((await shopCatalog.lockStock(handle, 'actual')).ok).toBe(false)
  })
  it('throws failed Results inside the DB transaction for rollback', async () => {
    const failure = csError('GATE_OUT_OF_STOCK', 'sold out')
    repos.withTx.mockImplementation(async (fn) => {
      try {
        return ok(await fn({}))
      } catch (error) {
        return err(error as typeof failure)
      }
    })
    const { withShopTransaction } = await import('./catalog')
    expect(await withShopTransaction(async () => err(failure))).toEqual(err(failure))
  })
})

describe('merchant order lookup', () => {
  it('uses the actual order repository and maps the stored amount', async () => {
    repos.findOrderByAttempt.mockResolvedValue(
      ok({
        id: 'ord_actual',
        status: 'AUTHORIZED',
        amount_minor: 9007199254740993n,
        currency: 'USD',
      }),
    )
    const { shopCheckout } = await import('./checkout-store')
    expect(await shopCheckout.findOrderByAttempt('att_actual')).toEqual(
      ok({
        id: 'ord_actual',
        status: 'AUTHORIZED',
        amountMinor: 9007199254740993n,
        currency: 'USD',
      }),
    )
    expect(repos.findOrderByAttempt).toHaveBeenCalledWith('att_actual')
    repos.findOrderByAttempt.mockResolvedValue(ok(undefined))
    expect(await shopCheckout.findOrderByAttempt('att_missing')).toEqual(ok(undefined))
    const failure = err(csError('CS_INTERNAL', 'unavailable'))
    repos.findOrderByAttempt.mockResolvedValue(failure)
    expect(await shopCheckout.findOrderByAttempt('att_actual')).toEqual(failure)
  })
  it('does not claim missing orders or issue checkout tokens without persistence', async () => {
    vi.stubEnv('DATABASE_URL', '')
    const { shopCheckout } = await import('./checkout-store')
    expect((await shopCheckout.findOrderByAttempt('att_actual')).ok).toBe(false)
    expect(
      (
        await shopCheckout.createCheckoutJwt({
          merchant: { id: 'm', name: 'M', website: 'https://example.test' },
          lines: [],
          shipping_minor: 0n,
          tax_minor: 0n,
          currency: 'USD',
          ttl_seconds: 900,
          checkout_id: id,
        })
      ).ok,
    ).toBe(false)
    expect(repos.findOrderByAttempt).not.toHaveBeenCalled()
  })
})
