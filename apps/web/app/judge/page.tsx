import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = { title: 'Demo guide' }

export default function JudgePage() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:py-16">
      <p className="font-mono text-xs uppercase tracking-widest text-signed">
        A guided look at authorization
      </p>
      <h1 className="mt-4 text-4xl font-semibold tracking-tight">
        Try it. Inspect what it proves.
      </h1>
      <p className="mt-5 max-w-3xl text-lg text-ink-soft">
        Start with the buyer’s signature, then inspect a merchant’s price quote. Then run the agent:
        its Gate decision creates a real PayPal sandbox order, shown with PayPal’s own order id and
        status.
      </p>
      <ol className="mt-10 grid gap-6 md:grid-cols-2">
        <li className="rounded-card border border-rule bg-paper-raised p-6">
          <p className="font-mono text-sm text-signed">1 · Buyer approval</p>
          <h2 className="mt-3 text-xl font-semibold">Sign a sample mandate</h2>
          <p className="mt-3 text-ink-soft">
            Create a device key, review the sample constraints and approve with a passkey. Inspect
            the resulting signed token. Use a browser that supports WebCrypto, IndexedDB and
            passkeys.
          </p>
          <Link
            href="/lab/device-sign"
            className="mt-6 inline-block rounded-card bg-ink px-5 py-3 font-semibold text-paper-raised"
          >
            Open the signing lab
          </Link>
          <p className="mt-4 text-sm text-ink-soft">
            Proves: a real device signature. It does not connect or charge a PayPal wallet.
          </p>
        </li>
        <li className="rounded-card border border-rule bg-paper-raised p-6">
          <p className="font-mono text-sm text-signed">2 · Merchant quote</p>
          <h2 className="mt-3 text-xl font-semibold">Lock a quoted total</h2>
          <p className="mt-3 text-ink-soft">
            Choose a product, quantity and supported destination. Review its original currency,
            shipping and signed price lock. Sample listings also demonstrate untrusted instructions.
          </p>
          <Link
            href="/shop"
            className="mt-6 inline-block rounded-card bg-ink px-5 py-3 font-semibold text-paper-raised"
          >
            Open the storefront
          </Link>
          <p className="mt-4 text-sm text-ink-soft">
            Proves: a merchant-signed quote. It does not prove payment approval or reserve stock.
          </p>
        </li>
      </ol>
      <section
        className="mt-10 rounded-card border border-rule p-6"
        aria-labelledby="readiness-title"
      >
        <h2 id="readiness-title" className="text-xl font-semibold">
          What still needs a complete sandbox integration
        </h2>
        <ul className="mt-4 list-disc space-y-3 pl-5 text-ink-soft">
          <li>
            A purchase linked to a buyer’s real sandbox wallet. Today the Gate creates a real
            sandbox order (no payment source) and re-reads it from PayPal; capture needs a vaulted
            buyer.
          </li>
          <li>Persisted permission and budget checks connected to order creation.</li>
          <li>
            Merchant order operations, webhooks and chargebacks, and an evidence workspace connected
            to actual sandbox disputes. The dispute screens run on fixtures; the pipeline is
            production code.
          </li>
          <li>
            An automated scenario runner for purchase, blocked deviation, dispute evidence and
            honest refund.
          </li>
        </ul>
        <p className="mt-5 text-sm text-ink-soft">
          The backend includes a dedicated disputed-refund path. Its availability here depends on
          the remaining app integration and sandbox permissions. Evidence supports a response;
          PayPal decides the dispute outcome.
        </p>
        <Link
          href="/status"
          className="mt-5 inline-block font-semibold text-signed underline underline-offset-4"
        >
          Check the running services
        </Link>
      </section>
      <section className="mt-10">
        <h2 className="text-xl font-semibold">Verify an evidence packet</h2>
        <p className="mt-3 max-w-3xl text-ink-soft">
          The QR code on a generated evidence PDF opens its public verification page. A genuine
          packet identifier is required; these demonstrations do not invent a packet or a dispute.
        </p>
        <Link
          href="/regions"
          className="mt-4 inline-block text-signed underline underline-offset-4"
        >
          Understand currencies and regional limits
        </Link>
      </section>
    </div>
  )
}
