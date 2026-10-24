import type { Metadata } from 'next'
import Link from 'next/link'
import { COUNTRY_LABELS, DELIVERY_COUNTRIES, SHIPPING_CURRENCY } from '@/lib/delivery'

export const metadata: Metadata = { title: 'Currencies and coverage' }

export default function CoveragePage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:py-16">
      <p className="font-mono text-xs uppercase tracking-widest text-signed">
        Cross-border clarity
      </p>
      <h1 className="mt-4 text-4xl font-semibold tracking-tight">
        Know the currency. Check the coverage.
      </h1>
      <p className="mt-5 text-lg text-ink-soft">
        A delivery destination, a charge currency and a merchant’s payment eligibility are three
        different things.
      </p>
      <section className="mt-10 rounded-card border border-rule bg-paper-raised p-6">
        <h2 className="text-xl font-semibold">What this storefront quotes</h2>
        <p className="mt-3 text-ink-soft">
          Physical shipping rates are quoted in {SHIPPING_CURRENCY}. Every price and total names its
          charge currency. Choosing another country never converts the amount. Physical items in
          another currency cannot be checked out until a matching shipping rate exists.
        </p>
        <p className="mt-3 text-ink-soft">
          Digital-only orders do not require a delivery address or physical shipping. These are
          sandbox catalog rates, not a promise of real-world fulfillment.
        </p>
        <h3 className="mt-6 font-semibold">Configured destinations for physical quotes</h3>
        <ul className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
          {DELIVERY_COUNTRIES.map((code) => (
            <li key={code}>
              {COUNTRY_LABELS[code] ?? code}{' '}
              <span className="font-mono text-ink-soft">({code})</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="mt-8 space-y-4" aria-labelledby="payment-region-title">
        <h2 id="payment-region-title" className="text-xl font-semibold">
          PayPal availability is account- and country-specific
        </h2>
        <p className="text-ink-soft">
          The demonstration uses the PayPal sandbox. A shipping option does not establish that a
          merchant may accept a payment, save a wallet or make unattended charges in that region.
          Those features need a supported merchant account and the relevant PayPal approvals.
        </p>
        <p className="text-ink-soft">
          For example, PayPal’s India guidance distinguishes international receipts from domestic
          receipts. Eligibility to enter a hackathon does not establish eligibility for a particular
          payment feature.
        </p>
        <div className="flex flex-wrap gap-4 text-sm text-signed">
          <a
            className="underline underline-offset-4"
            href="https://developer.paypal.com/api/payment-tokens/save-without-purchase/paypal/"
            target="_blank"
            rel="noreferrer noopener"
          >
            PayPal wallet-saving requirements ↗
          </a>
          <a
            className="underline underline-offset-4"
            href="https://www.paypal.com/in/cshelp/article/can-i-use-paypal-to-receive-payments-from-indian-customers-help1049"
            target="_blank"
            rel="noreferrer noopener"
          >
            PayPal India receipts guidance ↗
          </a>
        </div>
      </section>
      <section className="mt-8 rounded-card bg-signed-soft p-6">
        <h2 className="font-semibold">No silent currency conversion</h2>
        <p className="mt-2 text-ink-soft">
          Approval and checkout amounts must use the same currency. A mismatch is refused. Any
          future conversion needs an explicit rate, fee and renewed buyer approval.
        </p>
      </section>
      <Link
        href="/shop"
        className="mt-8 inline-block rounded-card bg-ink px-5 py-3 font-semibold text-paper-raised"
      >
        Explore the storefront
      </Link>
    </div>
  )
}
