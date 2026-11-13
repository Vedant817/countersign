/**
 * `/disputes/{id}` — one case, everything the merchant needs in order to say yes or no.
 *
 * ## Why this page exists at all
 *
 * §8.15 requires a merchant approval click, and a click is only consent if the person clicking knows what
 * they are consenting to. The queue (`/disputes`) shows a verdict chip and a rule id; that is enough to
 * triage and nowhere near enough to approve. So this page shows, in the order a reader needs them:
 *
 * 1. **What PayPal says** — reason, stage, status, amount, and the deadline that is actually running.
 * 2. **What the router decided** — liability, rule id, the rationale sentence, the fact sentences, the
 *    facts it compared, and the evidence types the filing will send.
 * 3. **What will be filed** — the packet version, its bundle hash and PDF digest, and the note text.
 * 4. **What has already happened** — every recorded PayPal action and every audit entry, in one order.
 *
 * ## The honesty rules this page keeps
 *
 * - **A row with no verdict says "not assessed", not a guess.** `liability === null` means the router has
 *   not run; rendering it as anything else would put a verdict in front of a merchant that was never made.
 * - **A `REVIEW` outcome is not a failure.** It means a person has to decide, and the page says so in the
 *   same words the filer used.
 * - **An unlinked dispute is unlinked.** No order means no mandate, which means R-NOCHAIN-1's answer is
 *   `UNPROVABLE` and the packet cannot prove what it would need to prove. The page shows `unlinked` rather
 *   than implying a chain exists.
 * - **Nothing here is a second implementation.** Every value is read from the column the pipeline wrote;
 *   the verdict is never re-derived.
 */
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { formatIstHuman, formatMoney, money } from '@countersign/core'

import { loadDisputeDetail, type DisputeDetail } from '@/lib/dispute-detail'

import { DecisionForm } from './decision-form'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Dispute',
  description: 'One dispute, its stored verdict, and the evidence that would be filed.',
}

/** The context shape Next 16 hands a page. `params` is a promise; `await context` would read `undefined`. */
interface DisputePageContext {
  readonly params: Promise<{ id: string }>
}

/** The state chip's colour. Terminal states are finished, not "bad". */
function stateTone(state: string): string {
  if (state.startsWith('CLOSED_')) return 'bg-paper text-ink-soft border-rule'
  if (state === 'FILED' || state === 'OFFERED') return 'bg-signed-soft text-signed border-signed'
  if (state === 'AWAITING_MERCHANT_APPROVAL') return 'bg-blocked-soft text-blocked border-blocked'
  return 'bg-paper-raised text-ink border-rule'
}

/** Whether the approval controls are meaningful for this row. */
function awaitingDecision(detail: DisputeDetail): boolean {
  return (
    detail.defenseState === 'AWAITING_MERCHANT_APPROVAL' ||
    detail.defenseState === 'ANALYSED' ||
    detail.defenseState === 'NEW'
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-44 shrink-0 text-ink-soft">{label}</dt>
      <dd className="min-w-0 font-mono text-sm">{children}</dd>
    </div>
  )
}

export default async function DisputeDetailPage({ params }: DisputePageContext) {
  const { id } = await params
  const loaded = await loadDisputeDetail(id)
  // A read that failed is a fault, not an empty case: rendering "no such dispute" over a broken database
  // is the one answer that hides the outage (the same rule `/disputes` states for its queue).
  if (!loaded.ok && loaded.error.code !== 'CS_NOT_FOUND') {
    throw new Error(
      `the dispute ${id} could not be read: ${loaded.error.code} ${loaded.error.message}`,
    )
  }
  if (!loaded.ok) notFound()

  const d = loaded.value
  const amount = formatMoney(money(d.amountMinor, d.currency))
  const due = d.sellerResponseDueAt

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:py-16">
      <Link className="text-sm text-ink-soft underline" href="/disputes">
        ← All disputes
      </Link>

      <div className="mt-4 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="font-mono text-2xl font-semibold tracking-tight">{d.paypalDisputeId}</h1>
        <span
          className={`rounded-card border px-3 py-1 font-mono text-xs font-bold uppercase tracking-widest ${stateTone(d.defenseState)}`}
        >
          {d.defenseState}
        </span>
      </div>
      <p className="mt-2 text-sm text-ink-faint">
        Our row <span className="font-mono">{d.id}</span> · opened{' '}
        {formatIstHuman(Math.floor(d.createdAt.getTime() / 1000))} IST
      </p>

      {/* 1. What PayPal says */}
      <section className="mt-8 rounded-card border border-rule bg-paper-raised p-5">
        <h2 className="text-lg font-semibold tracking-tight">What PayPal says</h2>
        <dl className="mt-3 grid gap-y-1 text-sm">
          <Row label="reason">{d.reason}</Row>
          <Row label="stage / status">
            {d.stage} / {d.status}
          </Row>
          <Row label="amount">{amount}</Row>
          <Row label="seller response due">
            {due === null ? (
              <span className="text-ink-soft">PayPal set no deadline</span>
            ) : (
              <>
                {formatIstHuman(Math.floor(due.getTime() / 1000))} IST
                <span className="text-ink-soft"> — never hard-coded, read from PayPal</span>
              </>
            )}
          </Row>
          <Row label="our order">
            {d.orderId === null ? (
              <span className="text-ink-soft">
                unlinked — not a Countersign payment, so R-NOCHAIN-1 applies and nothing can be
                proven from our side
              </span>
            ) : (
              <>
                {d.orderId}
                {d.captureId === null ? '' : ` · capture ${d.captureId}`}
              </>
            )}
          </Row>
        </dl>
      </section>

      {/* 2. What the router decided */}
      <section className="mt-4 rounded-card border border-rule bg-paper-raised p-5">
        <h2 className="text-lg font-semibold tracking-tight">What the router decided</h2>
        {d.liability === null ? (
          <p className="mt-3 text-sm text-ink-soft">
            Not assessed yet — the router has not run on this row. It runs on ingest and on each
            re-fetch, and it stores its verdict before it acts on it.
          </p>
        ) : (
          <>
            <dl className="mt-3 grid gap-y-1 text-sm">
              <Row label="liability">
                <span className="font-semibold">{d.liability}</span>
              </Row>
              <Row label="rule">
                {d.verdict.ruleId ?? <span className="text-ink-soft">not recorded</span>}
              </Row>
              <Row label="posture">
                {d.verdict.posture ?? <span className="text-ink-soft">not recorded</span>}
              </Row>
              {d.verdict.supersedes === null ? null : (
                <Row label="supersedes">{d.verdict.supersedes}</Row>
              )}
              <Row label="evidence PayPal accepts">
                {d.verdict.evidenceRequired.length === 0 ? (
                  <span className="text-ink-soft">none named by the rule</span>
                ) : (
                  d.verdict.evidenceRequired.join(', ')
                )}
              </Row>
            </dl>

            {d.verdict.rationale === null ? null : (
              <blockquote className="mt-4 border-l-4 border-rule pl-4 text-sm">
                {d.verdict.rationale}
              </blockquote>
            )}

            {d.verdict.reasons.length === 0 ? null : (
              <>
                <h3 className="mt-4 font-mono text-xs uppercase tracking-widest text-ink-faint">
                  The facts it compared
                </h3>
                <ul className="mt-2 list-disc pl-5 text-sm text-ink-soft">
                  {d.verdict.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </>
            )}

            {d.verdict.facts.length === 0 ? null : (
              <p className="mt-3 font-mono text-xs text-ink-faint">
                fact keys: {d.verdict.facts.join(', ')}
              </p>
            )}

            {d.verdict.blockingReason === null ? null : (
              <p className="mt-4 rounded-card border border-blocked bg-blocked-soft p-3 text-sm text-blocked">
                <strong>A person has to decide:</strong> {d.verdict.blockingReason}
              </p>
            )}

            {d.verdict.userAlert === null ? null : (
              <p className="mt-4 rounded-card border border-blocked bg-blocked-soft p-3 text-sm text-blocked">
                {d.verdict.userAlert}
              </p>
            )}
          </>
        )}
      </section>

      {/* 3. What will be filed */}
      <section className="mt-4 rounded-card border border-rule bg-paper-raised p-5">
        <h2 className="text-lg font-semibold tracking-tight">What would be filed</h2>
        {d.packet === null ? (
          <p className="mt-3 text-sm text-ink-soft">
            No evidence packet exists yet. The packet is written when the router has decided and the
            citation checker has passed the note — a packet that does not exist is not evidence.
          </p>
        ) : (
          <>
            <dl className="mt-3 grid gap-y-1 text-sm">
              <Row label="packet">
                <Link className="underline" href={`/v/${d.packet.id}`}>
                  {d.packet.id}
                </Link>{' '}
                v{d.packet.version}
              </Row>
              <Row label="bundle hash">{d.packet.bundleHash}</Row>
              <Row label="pdf sha256">
                {d.packet.pdfSha256 ?? <span className="text-ink-soft">not rendered yet</span>}
              </Row>
              <Row label="filed">
                {d.packet.filedAt === null ? (
                  <span className="text-ink-soft">not filed</span>
                ) : (
                  <>{formatIstHuman(Math.floor(d.packet.filedAt.getTime() / 1000))} IST</>
                )}
              </Row>
            </dl>
            {d.packet.notes === null ? null : (
              <>
                <h3 className="mt-4 font-mono text-xs uppercase tracking-widest text-ink-faint">
                  The note
                </h3>
                <p className="mt-2 whitespace-pre-wrap text-sm">{d.packet.notes}</p>
              </>
            )}
          </>
        )}
      </section>

      {/* 4. What has already happened */}
      <section className="mt-4 rounded-card border border-rule bg-paper-raised p-5">
        <h2 className="text-lg font-semibold tracking-tight">What has already happened</h2>
        {d.actions.length === 0 ? (
          <p className="mt-3 text-sm text-ink-soft">
            Nothing has been recorded against this case yet — no PayPal action and no decision.
          </p>
        ) : (
          <ol className="mt-3 flex flex-col gap-2 text-sm">
            {d.actions.map((entry, index) => (
              <li
                key={`${entry.kind}-${entry.label}-${index}`}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-rule pb-2 last:border-b-0"
              >
                <span className="font-mono text-xs text-ink-faint">
                  {formatIstHuman(Math.floor(entry.at.getTime() / 1000))}
                </span>
                <span className="font-mono text-xs font-bold uppercase tracking-widest">
                  {entry.label}
                </span>
                <span className="text-ink-soft">{entry.summary}</span>
                <span className="font-mono text-xs text-ink-faint">by {entry.actor}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* 5. The click */}
      {awaitingDecision(d) ? (
        <DecisionForm
          disputeId={d.id}
          paypalDisputeId={d.paypalDisputeId}
          liability={d.liability}
        />
      ) : (
        <p className="mt-6 rounded-card border border-rule bg-paper p-4 text-sm text-ink-soft">
          This case is <span className="font-mono">{d.defenseState}</span>, so there is nothing left
          to approve. Approving a filed or settled case would be a second PayPal action.
        </p>
      )}
    </div>
  )
}
