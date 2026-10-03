/**
 * Countersign landing page — spec §9 S-01.
 *
 * S-01: "One-line pitch, 3 persona buttons, **Run Judge Mode**, 'How it works' diagram".
 *
 * This page is deliberately server-rendered with zero client JS. Judge Mode is the primary call to
 * action: a judge who cannot log in can still run all four scenarios (§8.20).
 */
import Link from 'next/link'

const PERSONAS = [
  {
    href: '/wallet/onboarding',
    title: 'Asha — the buyer',
    body: 'Save PayPal, create a device key, compile an intent, sign it with a passkey.',
    cta: 'Start onboarding',
  },
  {
    href: '/agent',
    title: 'Asha — the agent chat',
    body: 'Tell the agent what to buy. Watch the Gate allow in-mandate carts and block the rest.',
    cta: 'Open the agent',
  },
  {
    href: '/merchant',
    title: 'Northwind Outfitters — the merchant',
    body: 'The Gate log, order ops, and the Dispute Defender workspace.',
    cta: 'Open the merchant',
  },
] as const

const STEPS = [
  {
    n: '1',
    title: 'Plain English becomes a signed mandate',
    body: 'The intent compiler turns "trail shoes, size 10, under $130, Northwind only" into typed constraints. A deterministic template reads them back. The user signs L2 with a non-extractable WebCrypto key behind a passkey.',
  },
  {
    n: '2',
    title: 'The agent shops over MCP',
    body: 'The shopping agent calls the merchant’s MCP server: search, compare, cart. A product listing may contain a prompt injection. It is wrapped as untrusted data and it changes nothing.',
  },
  {
    n: '3',
    title: 'The Gate decides before PayPal sees anything',
    body: 'Twelve deterministic checks re-verify the chain, the constraints, the price lock, the stock, and the cumulative budget ledger. ALLOW writes a signed decision record. There is no LLM in this path.',
  },
  {
    n: '4',
    title: 'A week later, someone disputes it',
    body: 'The Dispute Defender re-verifies the chain at capture time, routes liability with a deterministic rule, drafts notes where every claim is cited to a fact, renders a PDF with a QR code, and files it. If the agent was at fault, it says refund.',
  },
] as const

export default function LandingPage() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:py-16">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <span className="label-signed font-mono text-xs uppercase tracking-[0.2em] text-[--color-ink-faint]">
          PayPal AI Hackathon 2026
        </span>
        <Link
          href="/status"
          className="font-mono text-xs text-[--color-ink-faint] underline underline-offset-4"
        >
          /status
        </Link>
      </header>

      <h1 className="mt-10 text-balance text-4xl font-semibold tracking-tight sm:text-6xl">
        Agent payments that hold up afterwards.
      </h1>
      <p className="mt-5 max-w-2xl text-pretty text-lg text-[--color-ink-soft]">
        Others make agents that can pay. Countersign makes agent payments that survive a dispute — for
        the user, the merchant and PayPal. A signed{' '}
        <a
          className="underline underline-offset-4"
          href="https://github.com/agent-intent/verifiable-intent"
          rel="noreferrer noopener"
          target="_blank"
        >
          Verifiable Intent
        </a>{' '}
        mandate is checked by a deterministic Gate before any PayPal order exists, and the same signed
        chain becomes the evidence packet if the buyer later claims they never authorised it.
      </p>

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <Link
          href="/judge"
          className="rounded-[--radius-card] bg-[--color-ink] px-5 py-3 font-medium text-[--color-paper-raised]"
        >
          Run Judge Mode — 4 scenarios, sandbox
        </Link>
        <Link
          href="/v"
          className="rounded-[--radius-card] border border-[--color-rule] px-5 py-3 font-medium"
        >
          Public verifier
        </Link>
      </div>

      <section className="mt-16">
        <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-[--color-ink-faint]">
          Pick a persona
        </h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          {PERSONAS.map((p) => (
            <Link
              key={p.href}
              href={p.href}
              className="rounded-[--radius-card] border border-[--color-rule] bg-[--color-paper-raised] p-5 transition hover:border-[--color-signed]"
            >
              <h3 className="font-semibold">{p.title}</h3>
              <p className="mt-2 text-sm text-[--color-ink-soft]">{p.body}</p>
              <span className="mt-4 inline-block text-sm font-medium text-[--color-signed]">
                {p.cta} →
              </span>
            </Link>
          ))}
        </div>
      </section>

      <section className="mt-16" aria-labelledby="how-it-works">
        <h2 id="how-it-works" className="font-mono text-xs uppercase tracking-[0.2em] text-[--color-ink-faint]">
          How it works
        </h2>
        <ol className="mt-6 space-y-6">
          {STEPS.map((s) => (
            <li key={s.n} className="grid gap-2 border-l-2 border-[--color-rule] pl-5 sm:grid-cols-[2rem_1fr]">
              <span className="font-mono text-sm text-[--color-signed]">{s.n}</span>
              <div>
                <h3 className="font-semibold">{s.title}</h3>
                <p className="mt-1 text-pretty text-[--color-ink-soft]">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-16 rounded-[--radius-card] border border-[--color-rule] bg-[--color-paper-raised] p-6">
        <h2 className="font-semibold">The core invariant</h2>
        <p className="mt-2 font-mono text-sm leading-relaxed text-[--color-ink-soft]">
          I-1 — no PayPal money movement happens unless a Gate <code>ALLOW</code> decision record
          exists for exactly that order, amount, currency and payee.
        </p>
        <p className="mt-3 text-sm text-[--color-ink-soft]">
          The LLM can propose. Only signed credentials plus deterministic code can authorise.
        </p>
      </section>

      <footer className="mt-16 border-t border-[--color-rule] pt-6 text-sm text-[--color-ink-faint]">
        Built on the PayPal sandbox · Verifiable Intent (Apache-2.0) · Apache-2.0. Sandbox only — see{' '}
        <Link href="/status" className="underline underline-offset-4">
          status
        </Link>{' '}
        and the README for honest limits.
      </footer>
    </div>
  )
}