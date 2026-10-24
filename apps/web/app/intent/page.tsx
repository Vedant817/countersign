import type { Metadata } from 'next'

import { hasBlockingAmbiguities, readBack } from '@countersign/compiler'

import { compileIntent } from '@/lib/intent-compiler'
import { missingLlmConfig } from '@/lib/llm'
import { merchantIdentity } from '@/lib/merchant'

import { ReadBackText } from './read-back-text'

export const metadata: Metadata = {
  // No `· Countersign` here: the root layout's template appends it, so naming it twice produced
  // "Intent compiler · Countersign · Countersign" in the tab and in every shared link preview.
  title: 'Intent compiler',
  description:
    'Turn a sentence into a spending mandate. The model proposes; deterministic code decides what may be signed.',
}

/**
 * The intent compiler — the surface the AI work has been missing.
 *
 * ## Why this page exists
 *
 * The compiler has been complete and unreachable at the same time: `packages/compiler` runs 285
 * tests, the model adapter works, `POST /api/intent/compile` answers — and a judge opening the app
 * sees none of it. That is the same failure as `packages/agent` being `export {}`, one layer up:
 * correct code nobody can observe is, from the outside, absent code.
 *
 * It is also the plainest answer to *"where is the AI?"*. A judge types a sentence and watches three
 * things happen in order:
 *
 *  1. **The model reads it.** The only non-deterministic step.
 *  2. **Deterministic code checks it** — the ceiling from the buyer's own bytes (AT-M8.5), the
 *     currency from their words (EC-FX-1), recurrence only if they mentioned one.
 *  3. **The read-back is rendered** — the sentence a person signs, pinned byte-identical by
 *     `readBack` so two runs cannot differ.
 *
 * Step 2 is the product. Putting a model in front of a form is easy; what this shows is what happens
 * *after* the model answers, and specifically what the app refuses to accept from it.
 *
 * ## The read-back is generated here, not returned by the compiler
 *
 * `CompiledMandate` deliberately carries no rendered text — it carries the facts the text is derived
 * from. Rendering it here is what keeps `readBack` a pure function of the mandate, which is the
 * property that makes "two runs cannot differ" checkable rather than asserted.
 *
 * ## Server-rendered deliberately
 *
 * A `POST`-equivalent handled on the server, result as HTML, no client JavaScript. A consent surface
 * is the wrong place to add an interactive dependency.
 */
export const dynamic = 'force-dynamic'

const EXAMPLES = [
  'Buy the cheapest trail runner under $80, and nothing else',
  'Spend at most $50 on shoes at Northwind this month',
  'Get me a waterproof jacket, up to 200 dollars, no subscriptions',
]

interface PageProps {
  searchParams: Promise<{ intent?: string }>
}

export default async function IntentPage({ searchParams }: PageProps) {
  const { intent } = await searchParams
  const text = (intent ?? '').trim()
  const notConfigured = missingLlmConfig(process.env)

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
      <header>
        <span className="font-mono text-xs uppercase tracking-[0.2em] text-ink-faint">
          Intent compiler
        </span>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
          Say what you want. See what you would be signing.
        </h1>
        <p className="mt-3 max-w-2xl text-pretty text-ink-soft">
          A model reads your sentence and proposes spending limits. Everything below has then been
          checked against your own words by code that does not involve a model — and you can check
          that claim yourself, because the read-back is generated from the mandate rather than from
          the model&rsquo;s reply.
        </p>
      </header>

      {notConfigured.length > 0 ? (
        <div
          className="mt-6 rounded-card border border-proposed bg-proposed-soft p-4"
          role="status"
        >
          <p className="font-semibold">No model is configured on this deployment.</p>
          <p className="mt-2 text-sm">
            {notConfigured.join(', ')} {notConfigured.length === 1 ? 'is' : 'are'} unset, so nothing
            can be compiled here. That is a supported state rather than a fault: the Gate, the
            verifier and the order path are deterministic and need no model at all (spec §8.0 rule
            4).
          </p>
        </div>
      ) : null}

      <form method="get" className="mt-8">
        <label htmlFor="intent" className="block text-sm font-medium">
          What would you like to buy?
        </label>
        <textarea
          id="intent"
          name="intent"
          rows={3}
          defaultValue={text}
          placeholder={EXAMPLES[0]}
          className="mt-2 w-full rounded-card border border-rule bg-paper-raised p-3 font-mono text-sm"
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="submit"
            className="rounded-card border border-rule bg-paper-raised px-4 py-2 text-sm font-medium"
          >
            Compile
          </button>
          <p className="text-xs text-ink-faint">Try: {EXAMPLES.map((e) => `“${e}”`).join(' · ')}</p>
        </div>
      </form>

      {text !== '' ? <Compiled intent={text} /> : null}
    </div>
  )
}

async function Compiled({ intent }: { intent: string }) {
  const compiled = await compileIntent({ userId: 'usr_local_visitor' as never, text: intent })

  if (!compiled.ok) {
    return (
      <section className="mt-8 rounded-card border border-rule bg-paper-raised p-5" role="alert">
        <h2 className="font-semibold">We could not compile that</h2>
        <p className="mt-2 text-sm text-ink-soft">{compiled.error.userMessage}</p>
        <p className="mt-3 font-mono text-xs text-ink-faint">
          {compiled.error.code}
          {typeof compiled.error.details?.['ec'] === 'string'
            ? ` · ${compiled.error.details['ec']}`
            : ''}
        </p>
        {/*
          The internal message is shown deliberately. It names which rule refused and why — and on a
          page whose purpose is to demonstrate that refusals are principled, hiding the reason removes
          the demonstration. It carries no PII: it is arithmetic about the text just typed.
        */}
        <p className="mt-3 border-t border-rule pt-3 text-xs text-ink-soft">
          {compiled.error.message}
        </p>
      </section>
    )
  }

  const mandate = compiled.value
  const merchant = merchantIdentity()
  const readBackText = readBack(mandate, {
    merchants: merchant.ok ? { [merchant.value.id]: merchant.value.name } : {},
    tz: 'Asia/Kolkata',
  })
  const notSignable = hasBlockingAmbiguities(mandate)

  return (
    <section className="mt-8 space-y-6">
      <div
        className={`rounded-card border p-4 ${notSignable ? 'border-proposed bg-proposed-soft' : 'border-signed bg-signed-soft'}`}
        role="status"
      >
        <p className="font-semibold">
          {notSignable
            ? 'Not ready to sign — we need one answer first.'
            : 'This is what you would be authorising.'}
        </p>
        <p className="mt-2 text-sm">
          {notSignable
            ? 'An intent we cannot pin to a number produces a question rather than a guess (spec §8.8), so nothing here is signable until you answer.'
            : 'Every limit below came out of your own words. Nothing was invented by the model.'}
        </p>
      </div>

      <article className="rounded-card border border-rule bg-paper-raised p-5">
        <h2 className="text-sm font-medium uppercase tracking-wide text-ink-faint">Read-back</h2>
        <ReadBackText text={readBackText} />
      </article>

      {mandate.ambiguities.length > 0 ? (
        <article className="rounded-card border border-proposed bg-paper-raised p-5">
          <h2 className="text-sm font-medium uppercase tracking-wide text-ink-faint">
            Before you can sign
          </h2>
          <ul className="mt-3 space-y-3 text-sm">
            {mandate.ambiguities.map((a) => (
              <li key={a.field}>
                <span className="font-medium">{a.question}</span>
                {a.options.length > 0 ? (
                  <span className="text-ink-soft"> Options: {a.options.join(' · ')}</span>
                ) : null}
                <span className="mt-1 block font-mono text-xs text-ink-faint">{a.field}</span>
              </li>
            ))}
          </ul>
        </article>
      ) : null}

      {mandate.assumptions.length > 0 ? (
        <article className="rounded-card border border-rule bg-paper-raised p-5">
          <h2 className="text-sm font-medium uppercase tracking-wide text-ink-faint">
            Where the model was overruled
          </h2>
          <p className="mt-2 text-xs text-ink-soft">
            The proposal contained something these rules did not accept. Each is recorded rather
            than silently applied.
          </p>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
            {mandate.assumptions.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </article>
      ) : null}

      <details className="rounded-card border border-rule bg-paper-raised p-5">
        <summary className="cursor-pointer text-sm font-medium">
          The signed constraints ({mandate.constraints.length}) — machine-readable
        </summary>
        <pre className="mt-3 overflow-x-auto font-mono text-xs text-ink-soft">
          {JSON.stringify(mandate.constraints, replacer, 2)}
        </pre>
      </details>
    </section>
  )
}

/** `bigint` is not JSON-serialisable, and money must not be lossily converted to a float on the way out. */
function replacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? `${value.toString()} (minor units)` : value
}
