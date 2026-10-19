/**
 * Countersign landing page — spec §9 S-01.
 *
 * S-01: "One-line pitch, 3 persona buttons, **Run Judge Mode**, 'How it works' diagram".
 *
 * This page is deliberately server-rendered with zero client JS. Judge Mode is the primary call to
 * action: a judge who cannot log in can still read, for each of the four scenarios of §8.20, exactly
 * which half is built and which half is missing. (It cannot *run* them — that runner is WP-20 and is
 * not built — so the button below does not claim otherwise.)
 *
 * ## Why the persona cards are not buttons, and why the verifier is not a link
 *
 * S-01 asked for three persona **buttons**. They were buttons, and every one of them 404'd —
 * `/wallet/onboarding`, `/agent` and `/merchant` are not routes, because no screen for any of the three
 * personas has been built. A button that 404s teaches a judge that the demo is broken, which is the one
 * thing this page cannot afford, because its whole claim is that agent payments survive scrutiny.
 *
 * So the honest form of S-01 is what is here instead: **three cards, no click**, each naming what exists
 * for that persona, what does not, and which package owns the part that does. That is a deviation from
 * S-01's wording, taken for the same reason `/judge` stopped being the primary call to action before it
 * was built — see that page's header comment, which sets the standard this file is written under.
 *
 * Two specific honesty notes, because both are easy to get wrong:
 *
 * - **The agent chat does not exist.** `packages/agent/src/index.ts` is two lines long and the second
 *   is `export {}`. It is a scaffold with a package name on it. The *defences* an agent would need exist
 *   and are fuzz-tested in `packages/gate`, but nothing reads a listing yet (that is WP-13). Describing
 *   it as an "agent chat you can open" would be false, so it is described as what it is.
 * - **`/v` needs a packet id.** The public verifier is real and `/v/<packet-id>` serves it, but it is
 *   addressed per evidence packet and validates `pkt_` + ULID before any read (§8.18). There is no
 *   `/v` route to link to, and no query anywhere for "the most recent packet" — every read of
 *   `evidence_packets` in `packages/db` requires an identifier first. See the note in the markup below.
 */
import Link from 'next/link'

/**
 * One persona, and — because there is no screen to link to — the truth about it.
 *
 * `state` reuses Judge Mode's own vocabulary (`/judge`'s `Scenario['state']`) rather than inventing a
 * second set of words, so `partly built` means the same thing on both pages.
 */
interface Persona {
  readonly title: string
  readonly body: string
  readonly state: 'partial' | 'not-built'
  /** What is real today, named by package so a reader can check it. */
  readonly have: readonly string[]
  /** What is not real, named just as precisely. */
  readonly missing: readonly string[]
}

const PERSONA_STATE_COPY: Record<Persona['state'], { label: string; tone: string }> = {
  partial: { label: 'partly built', tone: 'proposed' },
  'not-built': { label: 'not built', tone: 'blocked' },
}

const PERSONAS: readonly Persona[] = [
  {
    title: 'Asha — the buyer',
    body: 'Saves PayPal, creates a device key, compiles an intent, signs it with a passkey.',
    state: 'partial',
    have: [
      'compile → Gate → orders is composed and run end to end (packages/orchestrator).',
      'The Gate runs twelve checks and signs a decision record with a real Ed25519 key.',
    ],
    missing: [
      'The onboarding screen. There is no route for it, so there is no button here.',
      'A live sandbox round trip needs PayPal sandbox credentials (docs/HUMAN_TODO.md H-01).',
    ],
  },
  {
    title: 'Asha — the agent chat',
    body: 'Would tell the agent what to buy, and watch the Gate allow in-mandate carts and block the rest.',
    state: 'not-built',
    have: [
      'The Gate’s injection defences are real and fuzz-tested: 1,000 mutations, 0 ALLOWs (packages/gate).',
    ],
    missing: [
      'packages/agent is an empty scaffold — an `export {}` and nothing else. No agent reads a listing yet (WP-13).',
      'There is no chat screen and nothing to drive one from.',
    ],
  },
  {
    title: 'Northwind Outfitters — the merchant',
    body: 'Would get the Gate log, order ops, and the Dispute Defender workspace.',
    state: 'partial',
    have: [
      'The Defender is built: route() is a pure rules table, and fileDispute files a packet whose every claim is cited to a fact.',
      'The liability router’s 40-case evaluation passes at 100% (packages/defender).',
    ],
    missing: [
      'The workspace screen. The backend is composed; there is no route that draws it.',
      'A dispute to adjudicate still needs a sandbox capture and dispute scopes (HUMAN_TODO H-01 / H-09).',
    ],
  },
]

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
        Others make agents that can pay. Countersign makes agent payments that survive a dispute —
        for the user, the merchant and PayPal. A signed{' '}
        <a
          className="underline underline-offset-4"
          href="https://github.com/agent-intent/verifiable-intent"
          rel="noreferrer noopener"
          target="_blank"
        >
          Verifiable Intent
        </a>{' '}
        mandate is checked by a deterministic Gate before any PayPal order exists, and the same
        signed chain becomes the evidence packet if the buyer later claims they never authorised it.
      </p>

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <Link
          href="/judge"
          className="rounded-[--radius-card] bg-[--color-ink] px-5 py-3 font-medium text-[--color-paper-raised]"
        >
          Judge Mode — what is built, scenario by scenario
        </Link>
        {/*
          The verifier, not as a link. `/v/[packetId]` is real and it serves a real report, but it is
          addressed per packet: `packetId` comes out of the URL and is checked against `pkt_` + ULID
          before a single row is read (§8.18). `/v` on its own is not a route, and every read of
          `evidence_packets` in `packages/db` needs an identifier before it can return one — so there is
          no honest way to discover an id at render time here, only to invent one and ship a 404 that
          looks like a verifier. The address a judge can actually get is named below.
        */}
        <div className="max-w-md rounded-[--radius-card] border border-dashed border-[--color-rule] px-5 py-3">
          <p className="font-medium">
            Public verifier <span className="font-mono text-sm">/v/&lt;packet-id&gt;</span>
          </p>
          <p className="mt-1 text-sm text-[--color-ink-soft]">
            No link, because it has no id to link to. It needs a real packet id — and one appears as
            a QR code on the evidence PDF the Defender files, which needs a live sandbox dispute
            first (H-01).
          </p>
        </div>
      </div>

      <section className="mt-16">
        <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-[--color-ink-faint]">
          The three personas
        </h2>
        {/*
          The heading used to be "Pick a persona", over three buttons. "Pick" was the promise, and there
          is nothing to pick yet — so the heading now states the count and the cards below carry the
          truth about each one.
        */}
        <p className="mt-3 max-w-2xl text-pretty text-[--color-ink-soft]">
          Every screen behind these three personas is unbuilt, so none of them is a link. What each
          card gives you instead is the part that is real, the part that is not, and the package
          that owns it. Judge Mode has the scenario-by-scenario version.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          {PERSONAS.map((p) => (
            <article
              key={p.title}
              className="rounded-[--radius-card] border border-[--color-rule] bg-[--color-paper-raised] p-5"
            >
              <header className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-semibold">{p.title}</h3>
                <span
                  className={`rounded-full px-3 py-1 font-mono text-xs uppercase tracking-wider text-[--color-ink] ${
                    PERSONA_STATE_COPY[p.state].tone === 'blocked'
                      ? 'bg-[--color-blocked-soft]'
                      : 'bg-[--color-proposed-soft]'
                  }`}
                >
                  {PERSONA_STATE_COPY[p.state].label}
                </span>
              </header>
              <p className="mt-2 text-sm text-[--color-ink-soft]">{p.body}</p>

              <h4 className="mt-5 font-mono text-xs uppercase tracking-[0.2em] text-[--color-ink-faint]">
                What exists
              </h4>
              <ul className="mt-2 space-y-1.5">
                {p.have.map((line) => (
                  <li key={line} className="flex gap-2 text-sm">
                    <span aria-hidden="true" className="text-[--color-signed]">
                      ✓
                    </span>
                    <span>{line}</span>
                  </li>
                ))}
              </ul>

              <h4 className="mt-5 font-mono text-xs uppercase tracking-[0.2em] text-[--color-ink-faint]">
                What does not
              </h4>
              <ul className="mt-2 space-y-1.5">
                {p.missing.map((line) => (
                  <li key={line} className="flex gap-2 text-sm">
                    <span aria-hidden="true" className="text-[--color-blocked]">
                      ✗
                    </span>
                    <span className="text-[--color-ink-soft]">{line}</span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section className="mt-16" aria-labelledby="how-it-works">
        <h2
          id="how-it-works"
          className="font-mono text-xs uppercase tracking-[0.2em] text-[--color-ink-faint]"
        >
          How it works
        </h2>
        <ol className="mt-6 space-y-6">
          {STEPS.map((s) => (
            <li
              key={s.n}
              className="grid gap-2 border-l-2 border-[--color-rule] pl-5 sm:grid-cols-[2rem_1fr]"
            >
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
        Built on the PayPal sandbox · Verifiable Intent (Apache-2.0) · Apache-2.0. Sandbox only —
        see{' '}
        <Link href="/status" className="underline underline-offset-4">
          status
        </Link>{' '}
        and the README for honest limits.
      </footer>
    </div>
  )
}
