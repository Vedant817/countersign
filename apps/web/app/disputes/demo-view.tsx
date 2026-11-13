/**
 * The SIMULATED branch of `/disputes` — the demo cases, unchanged, and only reachable behind
 * `COUNTERSIGN_AGENT_DEMO=1` outside production.
 *
 * Extracted from `page.tsx` so the page can branch on the flag without the demo code sitting on the
 * path a merchant takes. The honesty of this branch is the banner at the top and the per-case notes: it
 * says which parts are fixtures (the dispute, the PayPal ids, the capture) and which are the shipping
 * pipeline (router, planner, drafter, citation checker, packet renderer).
 */
import { demoCases, type DefenderCaseView } from '@/lib/defender-demo'

function VerdictBadge({ posture }: { posture: string }) {
  const contest = posture === 'CONTEST'
  return (
    <span
      className={`rounded-card px-3 py-1 font-mono text-xs font-bold uppercase tracking-widest ${
        contest ? 'bg-signed-soft text-signed' : 'bg-blocked-soft text-blocked'
      }`}
    >
      {posture}
    </span>
  )
}

function CaseCard({ caseView }: { caseView: DefenderCaseView }) {
  return (
    <section
      aria-labelledby={`case-${caseView.id}`}
      className="rounded-card border border-rule bg-paper-raised p-6"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id={`case-${caseView.id}`} className="text-2xl font-semibold tracking-tight">
          {caseView.title}
        </h2>
        <VerdictBadge posture={caseView.rule.posture} />
      </div>

      <dl className="mt-4 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div className="flex gap-2">
          <dt className="w-36 shrink-0 text-ink-soft">PayPal dispute</dt>
          <dd className="font-mono">{caseView.dispute.paypalDisputeId}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-36 shrink-0 text-ink-soft">reason</dt>
          <dd className="font-mono">{caseView.dispute.reason}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-36 shrink-0 text-ink-soft">amount</dt>
          <dd className="font-mono">{caseView.dispute.amount}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-36 shrink-0 text-ink-soft">response due</dt>
          <dd className="font-mono">{caseView.dispute.responseDue.slice(0, 10)}</dd>
        </div>
      </dl>

      <div
        className={`mt-5 rounded-card border-l-4 p-4 ${
          caseView.rule.posture === 'CONTEST'
            ? 'border-signed bg-signed-soft'
            : 'border-blocked bg-blocked-soft'
        }`}
      >
        <p className="font-mono text-xs uppercase tracking-widest text-ink-faint">
          {caseView.rule.ruleId} · liability {caseView.rule.liability}
          {caseView.rule.action !== null ? ` · action ${caseView.rule.action}` : ''}
        </p>
        <p className="mt-2">{caseView.rule.rationale}</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-soft">
          {caseView.rule.reasons.map((reason) => (
            <li key={reason.slice(0, 48)}>{reason}</li>
          ))}
        </ul>
      </div>

      {caseView.plan.length > 0 ? (
        <div className="mt-5">
          <p className="font-mono text-xs uppercase tracking-widest text-ink-faint">
            Evidence plan
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {caseView.plan.map((item) => (
              <li key={item.evidenceType} className="flex gap-2">
                <span className="font-mono font-semibold">{item.evidenceType}</span>
                <span className="text-ink-soft">{item.note}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {caseView.draft !== null ? (
        <div className="mt-5">
          <p className="font-mono text-xs uppercase tracking-widest text-ink-faint">
            Drafted note —{' '}
            {caseView.draft.source === 'template'
              ? 'deterministic template'
              : caseView.draft.source}
          </p>
          <p className="mt-2 whitespace-pre-wrap rounded-card border border-rule bg-paper p-4 text-sm">
            {caseView.draft.notes}
          </p>
          <ul className="mt-3 space-y-1 text-sm">
            {caseView.draft.citations.map((citation) => (
              <li key={citation.claimId} className="flex gap-2">
                <span className="font-mono text-xs text-signed">{citation.claimId}</span>
                <span className="text-ink-soft">
                  “{citation.sentence.slice(0, 110)}
                  {citation.sentence.length > 110 ? '…' : ''}” ←{' '}
                  <span className="font-mono" title={citation.artefact.description}>
                    {citation.artefact.id}
                  </span>
                  <span className="text-ink-faint"> — {citation.artefact.description}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {caseView.buyerMessage !== null ? (
        <p className="mt-5 rounded-card border border-rule bg-paper p-4 text-sm">
          <span className="font-semibold">Buyer sees: </span>
          {caseView.buyerMessage}
        </p>
      ) : null}

      {caseView.pdf !== null ? (
        <div className="mt-5 rounded-card border border-rule p-4">
          <p className="font-mono text-xs uppercase tracking-widest text-ink-faint">
            Evidence packet — downloadable
          </p>
          <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            <div className="flex gap-2">
              <dt className="w-28 shrink-0 text-ink-soft">packet</dt>
              <dd className="font-mono">{caseView.pdf.packetId}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-28 shrink-0 text-ink-soft">sha256</dt>
              <dd className="break-all font-mono text-xs">{caseView.pdf.sha256.slice(0, 32)}…</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-28 shrink-0 text-ink-soft">pages</dt>
              <dd className="font-mono">{caseView.pdf.pageCount}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-28 shrink-0 text-ink-soft">QR target</dt>
              <dd className="break-all font-mono text-xs">{caseView.pdf.qrPayload}</dd>
            </div>
          </dl>
          <a
            href={`/api/disputes/demo/pdf?case=${caseView.id}`}
            className="mt-3 inline-block rounded-card bg-ink px-4 py-2 text-sm font-semibold text-paper-raised"
          >
            Download the packet PDF
          </a>
          <p className="mt-2 text-xs text-ink-soft">
            The QR inside points at <span className="font-mono">{caseView.pdf.qrPayload}</span> —
            the public verifier. A packet from a SIMULATED dispute verifies honestly there: the
            chain checks report exactly what they can and cannot prove.
          </p>
        </div>
      ) : null}

      {caseView.notes.map((note) => (
        <p key={note.slice(0, 48)} className="mt-4 text-xs text-ink-faint">
          {note}
        </p>
      ))}
    </section>
  )
}

export async function DemoDisputesView({ base }: { base: string }) {
  const cases = await demoCases(base)

  return (
    <>
      <p className="mt-3 rounded-card border border-blocked bg-blocked-soft px-4 py-3 text-sm">
        <span className="font-semibold">SIMULATED:</span> the two disputes, their PayPal ids and the
        capture are fixtures — a real dispute can only exist against a captured payment, and this
        demo never captures (there is no vaulted buyer). Everything <em>downstream</em> of the
        dispute is the production pipeline: the router, the planner, the drafter, the citation
        checker and the packet renderer are the code that ships.
      </p>

      <div className="mt-8 flex flex-col gap-8">
        {cases.map((caseView) => (
          <CaseCard key={caseView.id} caseView={caseView} />
        ))}
      </div>

      <p className="mt-10 text-sm text-ink-soft">
        Base URL for this render: <span className="font-mono">{base}</span>
      </p>
    </>
  )
}
