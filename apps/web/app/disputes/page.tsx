/**
 * `/disputes` — the merchant's dispute queue, read from the database.
 *
 * ## Two branches, and why the demo one is behind a flag
 *
 * This page used to be the demo only: two fixture disputes rendered through the production Defender
 * pipeline, with a SIMULATED banner. That was honest about the fixtures and wrong for a merchant, who
 * would read the same layout as "these are my disputes". So the branches are now explicit:
 *
 *  - `COUNTERSIGN_AGENT_DEMO=1` **and** `NODE_ENV !== 'production'` → `demo-view.tsx` (unchanged).
 *  - otherwise → {@link loadDisputeQueue}, which returns **only rows in `disputes`**.
 *
 * In the second branch an empty table is the expected state on a fresh deployment, and it is rendered as
 * a sentence rather than as an error: a dispute can only exist after a capture, and nothing captures
 * until a vaulted buyer exists (HUMAN_TODO 1a). Saying that is more useful than a zero-state graphic.
 *
 * ## What a row can and cannot claim
 *
 * `liability` and `router_trace` are the **stored** verdict (`packages/defender/src/ingest.ts` writes
 * them when the router runs). A row with `liability === null` has not been assessed, and this page says
 * "not assessed" rather than deriving a verdict of its own — a second §8.15 implementation is exactly
 * what the single-writer rule exists to prevent.
 */
import type { Metadata } from 'next'
import Link from 'next/link'
import { headers } from 'next/headers'
import { forbidden } from 'next/navigation'

import { formatIstHuman, formatMoney, money } from '@countersign/core'

import { requireMerchantPage } from '@/lib/auth-page'
import { merchantIdFor } from '@/lib/merchant-context'
import {
  DISPUTE_QUEUE_LIMIT,
  disputesUseDemoView,
  loadDisputeQueue,
  type DisputeQueueRow,
} from '@/lib/dispute-queue'

import { DemoDisputesView } from './demo-view'
import { LogoutButton } from './logout-button'

export const metadata: Metadata = {
  title: 'Disputes',
  description:
    'Every PayPal dispute this deployment has ingested, with the router’s stored verdict.',
}

export const dynamic = 'force-dynamic'

/** The base URL the QR and the one permitted note URL name — the host actually serving this page. */
async function publicBaseUrl(): Promise<string> {
  const h = await headers()
  const host = h.get('x-forwarded-host') ?? h.get('host')
  if (host !== null && host !== '') {
    const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https')
    return `${proto}://${host}`
  }
  return process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000'
}

/** The state chip's colour. Terminal states are not "bad"; they are finished. */
function stateTone(state: string): string {
  if (state.startsWith('CLOSED_')) return 'bg-paper text-ink-soft border-rule'
  if (state === 'FILED' || state === 'OFFERED') return 'bg-signed-soft text-signed border-signed'
  if (state === 'AWAITING_MERCHANT_APPROVAL') return 'bg-blocked-soft text-blocked border-blocked'
  return 'bg-paper-raised text-ink border-rule'
}

function QueueRow({ row }: { row: DisputeQueueRow }) {
  const amount = formatMoney(money(row.amountMinor, row.currency))
  const due = row.sellerResponseDueAt

  return (
    <li className="rounded-card border border-rule bg-paper-raised p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="font-mono text-sm font-semibold">
          <Link className="underline" href={`/disputes/${row.id}`}>
            {row.paypalDisputeId}
          </Link>
        </h2>
        <span
          className={`rounded-card border px-3 py-1 font-mono text-xs font-bold uppercase tracking-widest ${stateTone(row.defenseState)}`}
        >
          {row.defenseState}
        </span>
      </div>

      <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div className="flex gap-2">
          <dt className="w-40 shrink-0 text-ink-soft">reason</dt>
          <dd className="font-mono">{row.reason}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-40 shrink-0 text-ink-soft">stage / status</dt>
          <dd className="font-mono">
            {row.stage} / {row.status}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-40 shrink-0 text-ink-soft">amount</dt>
          <dd className="font-mono">{amount}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-40 shrink-0 text-ink-soft">response due</dt>
          <dd className="font-mono">
            {due === null ? 'not set by PayPal' : formatIstHuman(Math.floor(due.getTime() / 1000))}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-40 shrink-0 text-ink-soft">our order</dt>
          <dd className="font-mono">
            {row.orderId === null ? (
              <span className="text-ink-soft">unlinked — not a Countersign payment</span>
            ) : (
              <>
                {row.orderId}
                {row.orderStatus !== null ? ` · ${row.orderStatus}` : ''}
              </>
            )}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-40 shrink-0 text-ink-soft">packet</dt>
          <dd className="font-mono">
            {row.packetId === null ? (
              <span className="text-ink-soft">none filed</span>
            ) : (
              <a className="underline" href={`/v/${row.packetId}`}>
                {row.packetId}
              </a>
            )}
          </dd>
        </div>
      </dl>

      <p className="mt-3 text-sm">
        <span className="font-mono text-xs uppercase tracking-widest text-ink-faint">
          router verdict
        </span>
        <br />
        {row.liability === null ? (
          <span className="text-ink-soft">
            not assessed yet — the router has not run on this row (it runs on ingest and on each
            re-fetch).
          </span>
        ) : (
          <>
            <span className="font-mono font-semibold">{row.liability}</span>
            {row.ruleId !== null ? (
              <span className="text-ink-soft"> — rule {row.ruleId}</span>
            ) : null}
          </>
        )}
      </p>

      <p className="mt-2 text-xs text-ink-faint">
        {row.actions} recorded action{row.actions === 1 ? '' : 's'} · row{' '}
        <span className="font-mono">{row.id}</span>
      </p>
    </li>
  )
}

export default async function DisputesPage() {
  // The queue is the merchant's. This runs before either branch — the demo branch is a view of the same
  // page, and a public path to it would be a public path to the fixtures too.
  const merchant = await requireMerchantPage('/disputes')
  const merchantIdRes = await merchantIdFor(merchant)
  if (!merchantIdRes.ok) {
    if (merchantIdRes.error.code === 'CS_FORBIDDEN') {
      forbidden()
    }
    throw new Error(
      `the merchant profile could not be read: ${merchantIdRes.error.code} ${merchantIdRes.error.message}`,
    )
  }
  const merchantId = merchantIdRes.value

  const demo = disputesUseDemoView()
  const base = demo ? await publicBaseUrl() : null

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-4">
        <p className="font-mono text-xs uppercase tracking-widest text-ink-faint">
          {merchant.displayName} · {merchant.email}
        </p>
        <Link
          className="font-mono text-xs uppercase tracking-widest underline hover:text-ink-soft"
          href="/merchant/settings"
        >
          Settings
        </Link>
      </div>
      <LogoutButton />
    </div>
  )

  if (demo && base !== null) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-10 sm:py-16">
        {header}
        <p className="mt-6 font-mono text-xs uppercase tracking-widest text-blocked">
          SIMULATED DISPUTES
        </p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight">The Dispute Defender</h1>
        <p className="mt-4 text-lg text-ink-soft">
          When a PayPal dispute arrives, a rule table — not a model — decides whether we contest.
          The model only ever writes the prose, and a deterministic checker decides whether that
          prose may be filed. Here are both directions at once.
        </p>
        <DemoDisputesView base={base} />
      </div>
    )
  }

  const queued = await loadDisputeQueue(merchantId, DISPUTE_QUEUE_LIMIT)
  if (!queued.ok) {
    // A queue that cannot be read is a fault, not an empty table: rendering "no disputes" here would be
    // the one answer that hides a broken database (the same rule the webhook route states).
    throw new Error(
      `the dispute queue could not be read: ${queued.error.code} ${queued.error.message}`,
    )
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:py-16">
      {header}
      <h1 className="mt-6 text-4xl font-semibold tracking-tight">Disputes</h1>
      <p className="mt-4 text-lg text-ink-soft">
        Every PayPal dispute this deployment has ingested, most recently updated first. The verdict
        is the one the router stored when it ran; nothing on this page is re-derived from the row.
      </p>

      {queued.value.length === 0 ? (
        <div className="mt-8 rounded-card border border-rule bg-paper-raised p-6">
          <h2 className="text-xl font-semibold tracking-tight">
            No disputes have been ingested yet
          </h2>
          <p className="mt-3 text-sm text-ink-soft">
            A dispute row appears here when PayPal sends{' '}
            <span className="font-mono">CUSTOMER.DISPUTE.CREATED</span> to{' '}
            <span className="font-mono">/api/webhooks/paypal</span>, or when the two-minute dispute
            sweep re-fetches one. Both need a captured payment to dispute, and nothing captures
            until a vaulted buyer exists, so an empty table is the honest state of a fresh
            deployment rather than a failure.
          </p>
          <p className="mt-2 text-sm text-ink-soft">
            Dispute ingest itself is configured and running: the route stores the exact bytes,
            verifies with PayPal when <span className="font-mono">PAYPAL_WEBHOOK_ID</span> is set,
            and the worker re-fetches state rather than trusting payload order.
          </p>
        </div>
      ) : (
        <ul className="mt-8 flex flex-col gap-4">
          {queued.value.map((row) => (
            <QueueRow key={row.id} row={row} />
          ))}
        </ul>
      )}
    </div>
  )
}
