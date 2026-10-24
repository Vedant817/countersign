import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { CHECKOUT_PRICE_LOCK_SECONDS, getProduct } from '@countersign/gate'
import { COUNTRY_LABELS, DELIVERY_COUNTRIES, SHIPPING_CURRENCY } from '@/lib/delivery'
import { displayMoney } from '@/lib/display-money'

import { isInjectionSku, shopCatalog } from '../catalog'

export const metadata: Metadata = {
  title: 'Product',
}

export const dynamic = 'force-dynamic'

function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? ''
  return value ?? ''
}

export default async function ProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ sku: string }>
  searchParams: Promise<{
    error?: string | string[]
    qty?: string | string[]
    country?: string | string[]
  }>
}) {
  const { sku } = await params
  const query = await searchParams
  const errorMessage = firstValue(query.error)
  const result = await getProduct({ catalog: shopCatalog }, sku)

  if (!result.ok) notFound()

  const product = result.value
  const inStock = product.stock > 0
  const canQuote = product.digital || product.price.currency === SHIPPING_CURRENCY
  const requestedQty = Number(firstValue(query.qty))
  const initialQty =
    Number.isInteger(requestedQty) &&
    requestedQty > 0 &&
    requestedQty <= Math.min(product.stock, 1000)
      ? requestedQty
      : 1
  const requestedCountry = firstValue(query.country)
  const initialCountry = DELIVERY_COUNTRIES.includes(requestedCountry) ? requestedCountry : ''
  const listingHtml = (product.listingHtml ?? product.listing).untrusted_text
  const lockMinutes = Math.round(CHECKOUT_PRICE_LOCK_SECONDS / 60)

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:py-16">
      <Link
        href="/shop"
        className="font-mono text-xs uppercase tracking-[0.2em] text-ink-faint underline underline-offset-4"
      >
        ← All items
      </Link>

      <header className="mt-8">
        <span className="font-mono text-xs uppercase tracking-[0.2em] text-ink-faint">
          Sandbox product
        </span>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">{product.title}</h1>
        <p className="mt-2 font-mono text-xs uppercase tracking-wider text-ink-faint">
          {product.sku}
        </p>
      </header>

      <p className="mt-6 text-2xl font-semibold">{displayMoney(product.price)}</p>
      <p className="mt-1 text-sm text-ink-soft">
        {inStock ? `In stock: ${product.stock}` : 'Sold out'}
      </p>
      <p className="mt-1 font-mono text-xs text-ink-faint">
        {product.digital ? 'Instant delivery' : `Ships in ${product.shipsInDays} days`}
      </p>

      {isInjectionSku(product.sku) ? (
        <p className="mt-6 inline-flex rounded-card border border-proposed bg-proposed-soft px-4 py-2 font-mono text-xs text-proposed">
          demo: contains hidden instructions
        </p>
      ) : null}

      <div
        className="mt-6 leading-relaxed text-ink-soft"
        dangerouslySetInnerHTML={{ __html: listingHtml }}
      />

      {errorMessage ? (
        <p role="alert" className="mt-8 text-blocked">
          {errorMessage}
        </p>
      ) : null}

      {inStock && canQuote ? (
        <form
          action="/shop/checkout"
          method="post"
          className="mt-10 rounded-card border border-rule bg-paper-raised p-5"
        >
          <input type="hidden" name="sku" value={product.sku} />
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <label htmlFor="quantity" className="block text-sm font-medium">
                Quantity
              </label>
              <input
                id="quantity"
                name="qty"
                type="number"
                min={1}
                max={Math.min(product.stock, 1000)}
                defaultValue={initialQty}
                required
                className="mt-1 w-24 rounded-card border border-rule bg-paper px-3 py-2"
              />
            </div>
            {product.digital ? (
              <input type="hidden" name="shipToCountry" value="ZZ" />
            ) : (
              <div>
                <label htmlFor="shipToCountry" className="block text-sm font-medium">
                  Ship to
                </label>
                <select
                  id="shipToCountry"
                  name="shipToCountry"
                  defaultValue={initialCountry}
                  required
                  className="mt-1 rounded-card border border-rule bg-paper px-3 py-2"
                >
                  <option value="" disabled>
                    Select a destination
                  </option>
                  {DELIVERY_COUNTRIES.map((code) => (
                    <option key={code} value={code}>
                      {COUNTRY_LABELS[code] ?? code}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <button
              type="submit"
              className="rounded-card bg-ink px-4 py-2 font-medium text-paper-raised"
            >
              Lock price
            </button>
          </div>
          <p className="mt-4 text-sm text-ink-soft">
            The price is locked for {lockMinutes} minutes once you continue.
          </p>
          <p className="mt-2 text-sm text-ink-soft">
            {product.digital
              ? 'Digital delivery. No physical shipping fee or address.'
              : `The charge remains in ${product.price.currency}; destination changes shipping, not currency.`}{' '}
            This creates a quote, not a paid order.
          </p>
        </form>
      ) : (
        <p className="mt-10 text-ink-soft">
          {inStock ? (
            <>
              Checkout is unavailable for this item: this store has no physical shipping rate in{' '}
              {product.price.currency}.{' '}
              <Link href="/regions" className="text-signed underline">
                See currency coverage
              </Link>
              .
            </>
          ) : (
            'Sold out. This item is not available right now.'
          )}
        </p>
      )}
    </div>
  )
}
