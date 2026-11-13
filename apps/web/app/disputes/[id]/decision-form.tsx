'use client'

/**
 * The approve/decline controls on one dispute — spec §8.15, S-17.
 *
 * ## Why a client component, and why it is this small
 *
 * The write is a `POST` to `/api/disputes/{id}/decision` (see that route's header for why it is a route
 * and not an action). This component owns three things and nothing else:
 *
 * 1. **The click is disabled while it is in flight.** §8.15's approval is one action, and a double click is
 *    two — the server refuses the second one by idempotency key, but a button that visibly refuses to be
 *    pressed twice is the cheaper half of the same guarantee.
 * 2. **The refusal is read, not swallowed.** A refused filing is a recorded outcome; the merchant needs the
 *    sentence, and a `200` that silently did nothing would be the worst possible answer here.
 * 3. **The page re-reads from the database afterwards.** `router.refresh()` re-runs the server component,
 *    so what the merchant sees is the row the filer wrote — not a client-side guess about it.
 *
 * ## What it deliberately does not do
 *
 * It does not decide whether the click is allowed. That is the server's answer, every time: this component
 * is a keyboard, not a gate.
 */
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

/** What the decision endpoint answers on success. Mirrors `DecisionOutcome`. */
interface DecisionResponse {
  readonly decision: 'approve' | 'decline'
  readonly applied: boolean
  readonly awaitingHuman: boolean
  readonly disposition: string | null
  readonly filed: boolean
  readonly ruleId: string | null
  readonly refusal: { readonly code: string; readonly reason: string } | null
  readonly paypalCalls: readonly string[]
}

/** The error body every route in this app returns. `code` is always present; the rest may not be. */
interface ErrorBody {
  readonly error: {
    readonly code: string
    readonly message: string
    readonly userMessage?: string
  }
}

export function DecisionForm(input: {
  readonly disputeId: string
  readonly paypalDisputeId: string
  readonly liability: string | null
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [busy, setBusy] = useState<'approve' | 'decline' | null>(null)
  const [note, setNote] = useState('')
  const [outcome, setOutcome] = useState<DecisionResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function decide(decision: 'approve' | 'decline') {
    setBusy(decision)
    setError(null)
    setOutcome(null)
    try {
      const response = await fetch(
        `/api/disputes/${encodeURIComponent(input.disputeId)}/decision`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(note.trim() === '' ? { decision } : { decision, note: note.trim() }),
        },
      )
      const body: unknown = await response.json().catch(() => null)
      if (!response.ok) {
        const parsed = body as ErrorBody | null
        setError(
          parsed?.error?.userMessage ??
            parsed?.error?.message ??
            `The decision could not be recorded (HTTP ${response.status}).`,
        )
        return
      }
      const applied = body as DecisionResponse
      setOutcome(applied)
      // Re-read the case from the database so the merchant sees the row the filer actually wrote.
      startTransition(() => router.refresh())
    } catch (cause) {
      setError(
        cause instanceof Error
          ? `The decision could not be sent: ${cause.message}`
          : 'The decision could not be sent.',
      )
    } finally {
      setBusy(null)
    }
  }

  const disabled = pending || busy !== null

  return (
    <section
      aria-labelledby="decision-heading"
      className="mt-6 rounded-card border border-rule bg-paper-raised p-5"
    >
      <h2 id="decision-heading" className="text-lg font-semibold tracking-tight">
        Your decision
      </h2>
      <p className="mt-2 text-sm text-ink-soft">
        Approving sends this case to PayPal exactly as the router decided
        {input.liability === null ? '' : ` (${input.liability})`}. Declining records that you said
        no and sends nothing — the case stays open and you can approve it later.
      </p>

      <label className="mt-4 block text-sm">
        <span className="text-ink-soft">Note (optional, recorded with your decision)</span>
        <textarea
          className="mt-1 w-full rounded-card border border-rule bg-paper p-2 font-mono text-sm"
          rows={2}
          maxLength={500}
          value={note}
          disabled={disabled}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>

      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          className="rounded-card border border-signed bg-signed-soft px-4 py-2 text-sm font-semibold text-signed disabled:opacity-50"
          disabled={disabled}
          aria-busy={busy === 'approve'}
          onClick={() => void decide('approve')}
        >
          {busy === 'approve' ? 'Approving…' : 'Approve and send to PayPal'}
        </button>
        <button
          type="button"
          className="rounded-card border border-rule bg-paper px-4 py-2 text-sm font-semibold text-ink disabled:opacity-50"
          disabled={disabled}
          aria-busy={busy === 'decline'}
          onClick={() => void decide('decline')}
        >
          {busy === 'decline' ? 'Declining…' : 'Decline'}
        </button>
      </div>

      {error === null ? null : (
        <p
          role="alert"
          className="mt-4 rounded-card border border-blocked bg-blocked-soft p-3 text-sm text-blocked"
        >
          {error}
        </p>
      )}

      {outcome === null ? null : (
        <div className="mt-4 rounded-card border border-rule bg-paper p-3 text-sm">
          <p className="font-semibold">
            {outcome.decision === 'decline'
              ? 'Declined. Nothing was sent to PayPal.'
              : outcome.filed
                ? 'Filed with PayPal.'
                : outcome.paypalCalls.length > 0
                  ? `Sent to PayPal (${outcome.paypalCalls.join(', ')}).`
                  : outcome.refusal === null
                    ? 'Recorded; no PayPal action was needed.'
                    : 'Recorded, but nothing was sent.'}
          </p>
          {outcome.ruleId === null ? null : (
            <p className="mt-1 text-ink-soft">
              Rule <span className="font-mono">{outcome.ruleId}</span>
              {outcome.disposition === null ? '' : ` · ${outcome.disposition}`}
              {outcome.awaitingHuman ? ' · a person still has to decide' : ''}
            </p>
          )}
          {outcome.refusal === null ? null : (
            <p className="mt-1 text-ink-soft">{outcome.refusal.reason}</p>
          )}
        </div>
      )}

      {pending ? <p className="mt-2 text-xs text-ink-faint">Refreshing the case file…</p> : null}

      <p className="mt-4 text-xs text-ink-faint">
        Case <span className="font-mono">{input.disputeId}</span> · PayPal{' '}
        <span className="font-mono">{input.paypalDisputeId}</span> · every decision is written to
        the audit chain for this case.
      </p>
    </section>
  )
}
