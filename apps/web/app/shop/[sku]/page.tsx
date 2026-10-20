import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { formatMoney } from '@countersign/core'
import { CHECKOUT_PRICE_LOCK_SECONDS, FLAT_SHIPPING_MINOR, getProduct } from '@countersign/gate'

import { isInjectionSku, shopCatalog } from '../catalog'

export const metadata: Metadata = {
  title: 'Product',
}

export const dynamic = 'force-dynamic'

const COUNTRY_LABELS: Readonly<Record<string, string>> = {
  US: 'United States',
  CA: 'Canada',
  GB: 'United Kingdom',
  IE: 'Ireland',
  DE: 'Germany',
  FR: 'France',
  NL: 'Netherlands',
  ES: 'Spain',
  IT: 'Italy',
  IN: 'India',
  JP: 'Japan',
  AU: 'Australia',
  SG: 'Singapore',
  BR: 'Brazil',
  MX: 'Mexico',
}

function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? ''
  return value ?? ''
}

export default async function ProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ sku: string }>
  searchParams: Promise<{ error?: string | string[] }>
}) {
  const { sku } = await params
  const query = await searchParams
  const errorMessage = firstValue(query.error)
  const result = await getProduct({ catalog: shopCatalog }, sku)

  if (!result.ok) notFound()

  const product = result.value
  const inStock = product.stock > 0
  const listingHtml = (product.listingHtml ?? product.listing).untrusted_text
  const lockMinutes = Math.round(CHECKOUT_PRICE_LOCK_SECONDS / 60)

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:py-16">
      <Link
        href="/shop"
        className="font-mono text-xs uppercase tracking-[0.2em] text-[--color-ink-faint] underline underline-offset-4"
      >
        ← All items
      </Link>

      <header className="mt-8">
        <span className="font-mono text-xs uppercase tracking-[0.2em] text-[--color-ink-faint]">
          Storefront · S-12
        </span>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">{product.title}</h1>
        <p className="mt-2 font-mono text-xs uppercase tracking-wider text-[--color-ink-faint]">
          {product.sku}
        </p>
      </header>

      <p className="mt-6 text-2xl font-semibold">{formatMoney(product.price)}</p>
      <p className="mt-1 text-sm text-[--color-ink-soft]">
        {inStock ? `In stock: ${product.stock}` : 'Sold out'}
      </p>
      <p className="mt-1 font-mono text-xs text-[--color-ink-faint]">
        {product.digital ? 'Instant delivery' : `Ships in ${product.shipsInDays} days`}
      </p>

      {isInjectionSku(product.sku) ? (
        <p className="mt-6 inline-flex rounded-[--radius-card] border border-[--color-proposed] bg-[--color-proposed-soft] px-4 py-2 font-mono text-xs text-[--color-proposed]">
          demo: contains hidden instructions
        </p>
      ) : null}

      <div
        className="mt-6 leading-relaxed text-[--color-ink-soft]"
        dangerouslySetInnerHTML={{ __html: listingHtml }}
      />

      {errorMessage ? (
        <p role="alert" className="mt-8 text-[--color-blocked]">
          {errorMessage}
        </p>
      ) : null}

      {inStock ? (
        <form
          action="/shop/checkout"
          method="post"
          className="mt-10 rounded-[--radius-card] border border-[--color-rule] bg-[--color-paper-raised] p-5"
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
                max={product.stock}
                defaultValue={1}
                className="mt-1 w-24 rounded-[--radius-card] border border-[--color-rule] bg-[--color-paper] px-3 py-2"
              />
            </div>
            <div>
              <label htmlFor="shipToCountry" className="block text-sm font-medium">
                Ship to
              </label>
              <select
                id="shipToCountry"
                name="shipToCountry"
                defaultValue="US"
                className="mt-1 rounded-[--radius-card] border border-[--color-rule] bg-[--color-paper] px-3 py-2"
              >
                {Object.keys(FLAT_SHIPPING_MINOR).map((code) => (
                  <option key={code} value={code}>
                    {COUNTRY_LABELS[code] ?? code}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              className="rounded-[--radius-card] bg-[--color-ink] px-4 py-2 font-medium text-[--color-paper-raised]"
            >
              Lock price
            </button>
          </div>
          <p className="mt-4 text-sm text-[--color-ink-soft]">
            The price is locked for {lockMinutes} minutes once you continue.
          </p>
        </form>
      ) : (
        <p className="mt-10 text-[--color-ink-soft]">
          Sold out. This item is not available right now.
        </p>
      )}
    </div>
  )
}
