import type { Metadata } from 'next'
import Link from 'next/link'

import { formatMoney } from '@countersign/core'
import { searchProducts } from '@countersign/gate'

import { shopCatalog } from './catalog'

export const metadata: Metadata = {
  title: 'Shop',
}

export const dynamic = 'force-dynamic'

function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? ''
  return value ?? ''
}

export default async function ShopPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>
}) {
  const params = await searchParams
  const query = firstValue(params.q)
  const result = await searchProducts({ catalog: shopCatalog }, { query })

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:py-16">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <span className="font-mono text-xs uppercase tracking-[0.2em] text-[--color-ink-faint]">
            Storefront · S-11
          </span>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
            Northwind Outfitters
          </h1>
        </div>
        <Link
          href="/status"
          className="font-mono text-xs text-[--color-ink-faint] underline underline-offset-4"
        >
          /status
        </Link>
      </header>

      <form action="/shop" method="get" className="mt-8 flex flex-wrap items-center gap-3">
        <label className="sr-only" htmlFor="q">
          Search products
        </label>
        <input
          id="q"
          name="q"
          type="search"
          defaultValue={query}
          placeholder="Search titles, SKUs and listings"
          className="w-full max-w-sm rounded-[--radius-card] border border-[--color-rule] bg-[--color-paper-raised] px-4 py-2"
        />
        <button
          type="submit"
          className="rounded-[--radius-card] bg-[--color-ink] px-4 py-2 font-medium text-[--color-paper-raised]"
        >
          Search
        </button>
      </form>

      {!result.ok ? (
        <p role="alert" className="mt-8 text-[--color-blocked]">
          {result.error.userMessage}
        </p>
      ) : result.value.items.length === 0 ? (
        <p className="mt-8 text-[--color-ink-soft]">
          No items match “{query}”.{' '}
          <Link href="/shop" className="underline underline-offset-4">
            Show all
          </Link>
        </p>
      ) : (
        <ul className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {result.value.items.map((product) => (
            <li
              key={product.sku}
              className="flex flex-col rounded-[--radius-card] border border-[--color-rule] bg-[--color-paper-raised] p-5"
            >
              <Link
                href={`/shop/${encodeURIComponent(product.sku)}`}
                className="font-semibold underline-offset-4 hover:underline"
              >
                {product.title}
              </Link>
              <p className="mt-1 font-mono text-xs uppercase tracking-wider text-[--color-ink-faint]">
                {product.sku}
              </p>
              <p className="mt-4 text-lg font-semibold">{formatMoney(product.price)}</p>
              <p className="mt-1 text-sm text-[--color-ink-soft]">
                {product.stock > 0 ? `In stock: ${product.stock}` : 'Sold out'}
              </p>
              <p className="mt-auto pt-3 font-mono text-xs text-[--color-ink-faint]">
                {product.digital ? 'Instant delivery' : `Ships in ${product.shipsInDays} days`}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
