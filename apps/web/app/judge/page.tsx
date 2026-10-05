/**
 * `/judge` — screen **S-21**, spec **§8.20** (M20, WP-20).
 *
 * ## What this page is, and what it deliberately is not
 *
 * §8.20 asks for four scenarios run end-to-end on the sandbox with live logs, each in ≤ 90 s, idempotent per
 * judge session and rate-limited to three concurrent runs. **That is WP-20 and it is not built.** This page
 * does not implement a scenario, and it does not pretend to.
 *
 * What it does instead is answer the only question a judge arriving here actually has — *is this thing
 * real?* — with the truth rather than with a 404 and rather than with four disabled buttons that look like a
 * product which exists and does not work. The previous state was the worst of the three: `/judge` was linked
 * from the landing page as the **primary call to action** ("Run Judge Mode — 4 scenarios, sandbox"), and it
 * 404'd.
 *
 * ## The rule this page is written under
 *
 * **Say precisely what is implemented and precisely what is not, and say which part owns each.** A judge who
 * reads "scenario J2 is implemented by `packages/agent`'s injection defences and is demonstrated by
 * `packages/gate`'s fuzz suite" learns something. A judge who reads a spinner learns nothing and concludes the
 * demo is broken. An honest gap is worth more than a facade, because the whole product is a claim about
 * honesty.
 *
 * ## Why no client JavaScript
 *
 * The rest of the app is server-rendered for the same reason (§9 S-01's own header): a judge may have
 * JavaScript disabled, and a page that needs it to say "not built yet" is a page that says nothing.
 */
import Link from 'next/link'

/** One scenario, and the truth about it. */
interface Scenario {
  readonly id: 'J1' | 'J2' | 'J3' | 'J4'
  readonly title: string
  /** §8.20's line, quoted. */
  readonly spec: string
  readonly state: 'built' | 'partial' | 'not-built'
  /** What exists today, named by package so a reader can check. */
  readonly have: readonly string[]
  /** What does not exist, named just as precisely. */
  readonly missing: readonly string[]
  /** Where the working half is demonstrated, if there is one. */
  readonly demonstratedAt?: string
}

const SCENARIOS: readonly Scenario[] = [
  {
    id: 'J1',
    title: 'Happy purchase',
    spec: 'J1: happy purchase.',
    state: 'partial',
    have: [
      'The full pipeline exists and is composed: compile → Gate → orders (packages/orchestrator).',
      'The Gate runs all twelve checks and signs a decision record with a real Ed25519 key.',
      'packages/orders creates the PayPal order with the D18 chain hash in custom_id.',
    ],
    missing: [
      'The runner: there is no HTTP endpoint that drives the four steps from this page.',
      'A live sandbox round trip needs PayPal sandbox credentials (docs/HUMAN_TODO.md H-01).',
    ],
    demonstratedAt:
      'packages/orchestrator/test/purchase.test.ts — "I-1 the one ALLOW call carries exactly the decision’s order, amount, currency and payee" drives the real Gate, the real order orchestrator and the real PayPal client against a recorded socket.',
  },
  {
    id: 'J2',
    title: 'Injection blocked',
    spec: 'J2: injection blocked.',
    state: 'built',
    have: [
      'The seeded catalog carries prompt-injection payloads in listing_html (packages/db, §8.13).',
      'The Gate decides on the signed chain and our own rows — never on anything a listing says.',
    ],
    missing: ['The agent that would read those listings is WP-13 and is not wired to a runner.'],
    demonstratedAt:
      'packages/gate/test/fuzz.test.ts (AT-M10.6) — a thousand mutations, 0 ALLOWs. The property being demonstrated is the one that matters: the Gate cannot be moved by data.',
  },
  {
    id: 'J3',
    title: 'UNAUTHORISED dispute → contest → adjudicate SELLER_FAVOR',
    spec: 'J3: `UNAUTHORISED` dispute → contest → adjudicate SELLER_FAVOR.',
    state: 'partial',
    have: [
      'The Defender exists: route() is a pure rules table, ingestDisputeToDefender re-fetches, and fileDispute files a packet whose every claim is cited to a fact.',
      '§10.2 rows 13–16 are composed by packages/orchestrator.ingestAndDefend, in that order.',
    ],
    missing: [
      'The scenario needs scripts/sim-dispute.ts to create a dispute against a real capture (HUMAN_TODO H-01 / H-09).',
      'Adjudication is a PayPal sandbox-only call (§10.2 row 18) and needs a dispute a sandbox account owns.',
    ],
    demonstratedAt:
      'packages/defender/test/router.test.ts and eval.test.ts — the 40-case router eval at 100%, which is the part of J3 that is deterministic.',
  },
  {
    id: 'J4',
    title: 'Wrong-size SNAD → AGENT_FAULT → honest refund',
    spec: 'J4: wrong-size SNAD → AGENT_FAULT → honest refund.',
    state: 'partial',
    have: [
      'The router reaches AGENT_FAULT and the DEFENDER_RECOMMENDS_REFUND posture for it.',
      'fileDispute records the refusal and the recommendation as dispute_actions rows (EC-MER-7).',
    ],
    missing: [
      '**The refund itself cannot complete.** orders.refund() refuses while a dispute is open on the capture — that is EC-REF-4’s detection working — so the REFUND posture is refused by construction. See the note below.',
    ],
    demonstratedAt:
      'packages/defender/test/strategist.test.ts for the posture; the money movement is the part that is dead.',
  },
]

const STATE_COPY: Record<Scenario['state'], { label: string; tone: string; body: string }> = {
  built: {
    label: 'built',
    tone: 'signed',
    body: 'The deterministic half of this scenario exists and is tested. What is missing is the runner that drives it end to end on the sandbox.',
  },
  partial: {
    label: 'partly built',
    tone: 'proposed',
    body: 'The deterministic half exists and is tested. What is missing is the runner, and — for J3 and J4 — the sandbox prerequisites a judge has to supply.',
  },
  'not-built': {
    label: 'not built',
    tone: 'blocked',
    body: 'Nothing of this scenario exists yet.',
  },
}

export default function JudgePage() {
  const counts = SCENARIOS.reduce<Record<Scenario['state'], number>>(
    (acc, s) => ({ ...acc, [s.state]: acc[s.state] + 1 }),
    { built: 0, partial: 0, 'not-built': 0 },
  )

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:py-16">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <span className="label-signed font-mono text-xs uppercase tracking-[0.2em] text-[--color-ink-faint]">
          Judge Mode · S-21 · spec §8.20
        </span>
        <Link
          href="/status"
          className="font-mono text-xs text-[--color-ink-faint] underline underline-offset-4"
        >
          /status
        </Link>
      </header>

      <h1 className="mt-10 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
        The four scenarios are not runnable yet.
      </h1>
      <p className="mt-4 max-w-2xl text-pretty text-[--color-ink-soft]">
        This page is the honest version of Judge Mode. The deterministic core that each scenario
        exercises exists and is tested — the Gate decides, the order orchestrator moves money only
        on an <code>ALLOW</code>, and the Defender files only what it can cite. What does not exist
        is the runner that drives those four scenarios end to end against the PayPal sandbox with
        live logs. That runner is <strong>WP-20</strong>, and it is not built.
      </p>
      <p className="mt-3 max-w-2xl text-pretty text-sm text-[--color-ink-soft]">
        Rather than four buttons that do nothing, here is exactly which part of each scenario
        exists, which package owns it, and where the working half is demonstrated. Click any link
        and you are reading a real test, not a promise.
      </p>

      <section className="mt-8 flex flex-wrap gap-3" aria-label="Scenario counts">
        {(['built', 'partial', 'not-built'] as const).map((state) => (
          <div
            key={state}
            className="rounded-[--radius-card] border border-[--color-rule] bg-[--color-paper-raised] px-4 py-3"
          >
            <div className="font-mono text-2xl font-semibold text-[--color-ink]">
              {counts[state]}
            </div>
            <div className="text-xs text-[--color-ink-faint]">{STATE_COPY[state].label}</div>
          </div>
        ))}
      </section>

      <section className="mt-12 space-y-6">
        {SCENARIOS.map((s) => (
          <article
            key={s.id}
            className="rounded-[--radius-card] border border-[--color-rule] bg-[--color-paper-raised] p-6"
          >
            <header className="flex flex-wrap items-baseline justify-between gap-3">
              <h2 className="text-lg font-semibold">
                <span className="font-mono text-[--color-ink-faint]">{s.id}</span> · {s.title}
              </h2>
              <span
                className={`rounded-full px-3 py-1 font-mono text-xs uppercase tracking-wider text-[--color-ink] ${
                  s.state === 'built'
                    ? 'bg-[--color-signed-soft]'
                    : s.state === 'partial'
                      ? 'bg-[--color-proposed-soft]'
                      : 'bg-[--color-blocked-soft]'
                }`}
              >
                {STATE_COPY[s.state].label}
              </span>
            </header>

            <p className="mt-2 font-mono text-xs text-[--color-ink-faint]">{s.spec}</p>
            <p className="mt-3 text-sm text-[--color-ink-soft]">{STATE_COPY[s.state].body}</p>

            <h3 className="mt-5 font-mono text-xs uppercase tracking-[0.2em] text-[--color-ink-faint]">
              What exists
            </h3>
            <ul className="mt-2 space-y-1.5">
              {s.have.map((line) => (
                <li key={line} className="flex gap-2 text-sm">
                  <span aria-hidden="true" className="text-[--color-signed]">
                    ✓
                  </span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>

            <h3 className="mt-5 font-mono text-xs uppercase tracking-[0.2em] text-[--color-ink-faint]">
              What does not
            </h3>
            <ul className="mt-2 space-y-1.5">
              {s.missing.map((line) => (
                <li key={line} className="flex gap-2 text-sm">
                  <span aria-hidden="true" className="text-[--color-blocked]">
                    ✗
                  </span>
                  <span className="text-[--color-ink-soft]">{line}</span>
                </li>
              ))}
            </ul>

            {s.demonstratedAt !== undefined ? (
              <p className="mt-5 rounded-[--radius-card] bg-[--color-paper] p-4 text-sm text-[--color-ink-soft]">
                <span className="font-semibold text-[--color-ink]">Demonstrated in </span>
                {s.demonstratedAt}
              </p>
            ) : null}
          </article>
        ))}
      </section>

      <section className="mt-12 rounded-[--radius-card] border-l-4 border-[--color-blocked] bg-[--color-blocked-soft] p-6">
        <h2 className="font-semibold">One dead path, stated rather than worked around</h2>
        <p className="mt-2 text-sm text-[--color-ink-soft]">
          J4 is meant to end in an honest refund. It cannot. <code>orders.refund()</code> refuses
          while a dispute is open on the capture — that is EC-REF-4&rsquo;s detection doing its job
          — so the Defender&rsquo;s <code>REFUND</code> posture is refused by construction. There is
          no version of this that gets fixed by reaching around the check: refunding outside the
          over-refund guard or refunding twice are both worse than the refusal, and a double refund
          is the single most expensive bug this product could ship. The fix belongs in{' '}
          <code>packages/orders</code> as an explicit, audited &ldquo;merchant conceded a disputed
          capture&rdquo; mode — it is reported, not patched.
        </p>
      </section>

      <section className="mt-12">
        <h2 className="font-mono text-xs uppercase tracking-[0.2em] text-[--color-ink-faint]">
          What you can check right now
        </h2>
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {[
            {
              href: '/status',
              label: '/status',
              body: 'Every dependency probed for real. 200 when it can serve, 503 when a required one is down.',
            },
            {
              href: '/v',
              label: '/v/…',
              body: 'The public verifier. Download a packet and check the chain yourself, offline.',
            },
            { href: '/', label: '/', body: 'The landing page, and what the product claims.' },
          ].map((link) => (
            <li key={link.href}>
              <Link
                href={link.href}
                className="block h-full rounded-[--radius-card] border border-[--color-rule] bg-[--color-paper-raised] p-4 transition hover:border-[--color-signed]"
              >
                <span className="font-mono text-sm text-[--color-signed]">{link.label}</span>
                <p className="mt-1 text-sm text-[--color-ink-soft]">{link.body}</p>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <footer className="mt-16 border-t border-[--color-rule] pt-6 text-sm text-[--color-ink-faint]">
        A gap that is labelled is worth more than a button that lies. Nothing on this page is
        generated by a model.
      </footer>
    </div>
  )
}
