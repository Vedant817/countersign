import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { epochSecFrom, money, type CheckoutId } from '@countersign/core'
import { displayMoney } from '@/lib/display-money'
import { DELIVERY_COUNTRIES } from '@/lib/delivery'

import { shopCatalog } from '../../catalog'
import { PriceLockCountdown } from './countdown'

export const metadata: Metadata = {
  title: 'Checkout',
}

export const dynamic = 'force-dynamic'

export default async function CheckoutPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ country?: string | string[] }>
}) {
  const { id } = await params
  const result = await shopCatalog.requireCheckoutSession(id as CheckoutId)

  if (!result.ok || result.value === undefined) notFound()

  const session = result.value
  const requoteSku = session.cart.lines[0]?.sku
  const query = await searchParams
  const requestedCountry =
    typeof query.country === 'string' && DELIVERY_COUNTRIES.includes(query.country)
      ? query.country
      : ''
  const requoteQuery = new URLSearchParams({
    qty: String(session.cart.lines[0]?.qty ?? 1),
    country: requestedCountry,
  })
  const requoteHref =
    requoteSku === undefined ? '/shop' : `/shop/${encodeURIComponent(requoteSku)}?${requoteQuery}`

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:py-16">
      <header>
        <span className="font-mono text-xs uppercase tracking-[0.2em] text-ink-faint">
          Signed price quote
        </span>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
          Review your quote
        </h1>
      </header>

      <div className="mt-6 rounded-card border border-proposed bg-proposed-soft p-4" role="status">
        <p className="font-semibold">No order has been placed. No money has moved.</p>
        <p className="mt-2 text-sm">
          This quote locks the merchant’s price. It does not select a mandate, approve a payment or
          reserve stock. Completing a purchase requires the buyer’s approval and a connected PayPal
          sandbox flow.
        </p>
      </div>

      <ul className="mt-8 divide-y divide-rule rounded-card border border-rule bg-paper-raised">
        {session.cart.lines.map((line) => (
          <li key={line.sku} className="flex items-baseline justify-between gap-4 p-5">
            <div>
              <p className="font-medium">{line.title}</p>
              <p className="mt-1 font-mono text-xs text-ink-faint">
                {line.sku} · Qty {line.qty}
              </p>
            </div>
            <p className="font-mono text-sm">
              {displayMoney(money(line.unit_minor * BigInt(line.qty), session.currency))}
            </p>
          </li>
        ))}
      </ul>

      <dl className="mt-6 space-y-2 text-sm">
        <div className="flex justify-between">
          <dt className="text-ink-soft">Subtotal</dt>
          <dd className="font-mono">
            {displayMoney(money(session.subtotal_minor, session.currency))}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-ink-soft">Tax</dt>
          <dd className="font-mono">{displayMoney(money(session.tax_minor, session.currency))}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-ink-soft">Shipping</dt>
          <dd className="font-mono">
            {displayMoney(money(session.shipping_minor, session.currency))}
          </dd>
        </div>
        <div className="flex justify-between border-t border-rule pt-2 text-base font-semibold">
          <dt>Quoted total</dt>
          <dd className="font-mono">
            {displayMoney(money(session.total_minor, session.currency))}
          </dd>
        </div>
      </dl>

      <PriceLockCountdown
        expiresAt={epochSecFrom(session.price_lock_exp)}
        requoteHref={requoteHref}
      />

      <p className="mt-6 text-sm text-ink-soft">
        Charge currency: {session.currency}. Delivery country does not convert the amount. To
        inspect how a buyer signs an approval,{' '}
        <Link href="/lab/device-sign" className="text-signed underline underline-offset-4">
          open the signing lab
        </Link>
        .
      </p>

      <Link
        href="/shop"
        className="mt-10 inline-block font-mono text-xs uppercase tracking-[0.2em] text-ink-faint underline underline-offset-4"
      >
        ← Back to the storefront
      </Link>
    </div>
  )
}
