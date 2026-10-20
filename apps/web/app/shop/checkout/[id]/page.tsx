import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { epochSecFrom, formatMoney, money, type CheckoutId } from '@countersign/core'

import { shopCatalog } from '../../catalog'
import { PriceLockCountdown } from './countdown'

export const metadata: Metadata = {
  title: 'Checkout',
}

export const dynamic = 'force-dynamic'

export default async function CheckoutPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const result = await shopCatalog.requireCheckoutSession(id as CheckoutId)

  if (!result.ok || result.value === undefined) notFound()

  const session = result.value
  const requoteSku = session.cart.lines[0]?.sku
  const requoteHref = requoteSku === undefined ? '/shop' : `/shop/${encodeURIComponent(requoteSku)}`

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:py-16">
      <header>
        <span className="font-mono text-xs uppercase tracking-[0.2em] text-[--color-ink-faint]">
          Checkout · S-13
        </span>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
          Review your order
        </h1>
      </header>

      <ul className="mt-8 divide-y divide-[--color-rule] rounded-[--radius-card] border border-[--color-rule] bg-[--color-paper-raised]">
        {session.cart.lines.map((line) => (
          <li key={line.sku} className="flex items-baseline justify-between gap-4 p-5">
            <div>
              <p className="font-medium">{line.title}</p>
              <p className="mt-1 font-mono text-xs text-[--color-ink-faint]">
                {line.sku} · Qty {line.qty}
              </p>
            </div>
            <p className="font-mono text-sm">
              {formatMoney(money(line.unit_minor * BigInt(line.qty), session.currency))}
            </p>
          </li>
        ))}
      </ul>

      <dl className="mt-6 space-y-2 text-sm">
        <div className="flex justify-between">
          <dt className="text-[--color-ink-soft]">Subtotal</dt>
          <dd className="font-mono">
            {formatMoney(money(session.subtotal_minor, session.currency))}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-[--color-ink-soft]">Tax</dt>
          <dd className="font-mono">{formatMoney(money(session.tax_minor, session.currency))}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-[--color-ink-soft]">Shipping</dt>
          <dd className="font-mono">
            {formatMoney(money(session.shipping_minor, session.currency))}
          </dd>
        </div>
        <div className="flex justify-between border-t border-[--color-rule] pt-2 text-base font-semibold">
          <dt>Total</dt>
          <dd className="font-mono">{formatMoney(money(session.total_minor, session.currency))}</dd>
        </div>
      </dl>

      <PriceLockCountdown
        expiresAt={epochSecFrom(session.price_lock_exp)}
        requoteHref={requoteHref}
      />

      <p className="mt-6 text-sm text-[--color-ink-soft]">
        Paying with: agent under mandate — the mandate is checked when the agent pays.
      </p>

      <Link
        href="/shop"
        className="mt-10 inline-block font-mono text-xs uppercase tracking-[0.2em] text-[--color-ink-faint] underline underline-offset-4"
      >
        ← Back to the storefront
      </Link>
    </div>
  )
}
