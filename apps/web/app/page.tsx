import Link from 'next/link'

export default function LandingPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:py-16">
      <section className="grid items-center gap-10 lg:grid-cols-[1.2fr_1fr]">
        <div>
          <p className="font-mono text-xs uppercase tracking-widest text-signed">
            Permission before payment
          </p>
          <h1 className="mt-5 max-w-2xl text-balance text-4xl font-semibold leading-tight tracking-tight sm:text-6xl">
            Agent purchases.
            <br />
            Human limits.
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink-soft">
            Give a shopping agent a signed spending limit. Help the merchant check what was
            authorized—and keep the evidence if the purchase is disputed.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/shop"
              className="rounded-card bg-ink px-5 py-3 font-semibold text-paper-raised"
            >
              Explore the storefront
            </Link>
            <Link
              href="/lab/device-sign"
              className="rounded-card border border-rule bg-paper-raised px-5 py-3 font-semibold"
            >
              Try signing an approval
            </Link>
          </div>
          <p className="mt-4 text-sm text-ink-soft">
            These are sandbox demonstrations. Checkout creates a price quote, not a paid order.
          </p>
        </div>
        <aside
          className="rounded-card border border-rule bg-paper-raised p-6 sm:p-8"
          aria-labelledby="example-title"
        >
          <p className="font-mono text-xs uppercase tracking-widest text-ink-faint">
            Example approval · not a transaction
          </p>
          <h2 id="example-title" className="mt-5 text-2xl font-semibold">
            Trail shoes, within my limits.
          </h2>
          <dl className="mt-6 divide-y divide-rule text-sm">
            {[
              ['Maximum total', 'USD 130.00'],
              ['Merchant', 'Northwind Outfitters'],
              ['Delivery country', 'Chosen by the buyer'],
              ['Price change', 'Needs a new check'],
              ['Authority', 'Signed by the buyer'],
            ].map(([label, value]) => (
              <div key={label} className="flex flex-wrap justify-between gap-2 py-3">
                <dt className="text-ink-soft">{label}</dt>
                <dd className="font-medium">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-5 border-l-2 border-signed pl-4 text-sm text-ink-soft">
            A product listing cannot grant the agent a larger budget.
          </p>
        </aside>
      </section>
      <section className="mt-16 border-t border-rule pt-10" aria-labelledby="journey-title">
        <h2 id="journey-title" className="text-2xl font-semibold">
          A purchase you can explain afterwards.
        </h2>
        <ol className="mt-6 grid gap-6 md:grid-cols-3">
          {[
            [
              'Approve',
              'The buyer reviews the amount, currency and merchant, then signs on their own device.',
            ],
            [
              'Check',
              'Deterministic checks compare the proposed purchase with the signed limits before payment.',
            ],
            [
              'Explain',
              'A merchant reviews the authorization trail and transaction facts when deciding how to respond to a dispute.',
            ],
          ].map(([title, body], index) => (
            <li key={title} className="rounded-card border border-rule bg-paper-raised p-6">
              <span className="font-mono text-sm text-signed">{index + 1}</span>
              <h3 className="mt-3 text-lg font-semibold">{title}</h3>
              <p className="mt-2 leading-relaxed text-ink-soft">{body}</p>
            </li>
          ))}
        </ol>
      </section>
      <section className="mt-12 flex flex-wrap items-center justify-between gap-5 rounded-card bg-signed-soft p-6 sm:p-8">
        <div className="max-w-2xl">
          <h2 className="text-xl font-semibold">See the proof. Know its limits.</h2>
          <p className="mt-2 text-ink-soft">
            Try the working signing and quote flows, see what each proves, and check the remaining
            requirements for a PayPal sandbox purchase.
          </p>
        </div>
        <Link
          href="/judge"
          className="rounded-card bg-ink px-5 py-3 font-semibold text-paper-raised"
        >
          Open the demo guide
        </Link>
      </section>
      <p className="mt-8 max-w-3xl text-sm leading-relaxed text-ink-soft">
        Built for verifiable agent commerce on PayPal. Signed evidence helps explain authorization;
        it does not guarantee a dispute outcome or replace PayPal’s policies.{' '}
        <Link href="/regions" className="underline underline-offset-4">
          Check regional and currency coverage.
        </Link>
      </p>
    </div>
  )
}
