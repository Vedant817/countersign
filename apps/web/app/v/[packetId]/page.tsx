/**
 * S-20 — the public verifier at `/v/[packetId]`, spec §8.18 (M18), WP-18.
 *
 * Every evidence packet's PDF carries a QR code pointing here (§8.18), so this page is read by a PayPal
 * adjudicator or a chargeback analyst **who does not trust us**. That single sentence decides every choice
 * below.
 *
 * ## Three properties, and the code that enforces each
 *
 * 1. **A reader who does not trust us still gets a true answer.** So the page shows the per-check result with
 *    its reason (`packages/verifier`'s `VerifierReport`), never a single green tick — a reader who cannot see
 *    *which* check failed cannot judge whether the failure matters.
 * 2. **Known limitations are shown, not omitted.** `at_time_not_honoured` (D-009) and every
 *    `constraints.skipped` entry (D19) are rendered prominently, because a verifier that quietly drops a known
 *    limitation lends false confidence to exactly the reader it exists to reassure.
 * 3. **The redaction is applied to what is *served*.** `buildRedactedView` produces a different document from
 *    the download, and `assertRedactionHolds` re-scans it before it is rendered. If the raw L1/L2/L3 ever
 *    reached this page's JSON, view-source would print the buyer's email — EC-PRIV-3's exact failure.
 *
 * ## Accessibility, because this page is read by people debugging a payment dispute
 *
 * - Server-rendered, **zero client JS**. "Verify now" is a plain link to a route handler, so the page works
 *   with JavaScript disabled, on a slow phone, and through a screen reader.
 * - **The status is text, not colour and not an icon.** `<li>[PASS] …</li>` — "the card is green" conveys
 *   nothing to a reader who cannot see it, and §8.18 asks for the per-check result rather than a verdict.
 * - `<table>` with real `<th scope>` headers for the check list, so a screen reader can navigate it.
 * - The banner and every failure are text in the document flow; nothing depends on hover.
 *
 * ## What is *not* here
 *
 * No private key, no API key, no user id, no order id, no internal counter. The only identifier on the page is
 * `packetId` — a `pkt_` ULID that is also the QR payload, so anyone holding the PDF can already derive it.
 */
import { notFound } from 'next/navigation'
import Link from 'next/link'

import { eq } from 'drizzle-orm'

import {
  csError,
  currency,
  formatIstHuman,
  formatMoney,
  logger,
  money,
  systemClock,
  type Money,
  type PacketId,
} from '@countersign/core'
import {
  db,
  disputes,
  evidencePackets,
  jwksKeys,
  repo,
  type DisputeRow,
  type EvidencePacketRow,
  type JwksKeyRow,
} from '@countersign/db'
import { ViClient } from '@countersign/vi-client'
import {
  assertRedactionHolds,
  buildVerifierReport,
  buildRedactedView,
  defineVerifierDeps,
  loadVerifierPacket,
  publicPacketUrl,
  rawBundleUrl,
  verifyScriptUrl,
  type VerifierCheck,
  type VerifierDeps,
  type VerifierReport,
  type VerifierStore,
} from '@countersign/verifier'

export const dynamic = 'force-dynamic'

// ---------------------------------------------------------------------------
// Wiring
//
// **Duplicated across this file and the two route handlers, deliberately.** A shared `lib/verifier-deps.ts`
// would be the tidier shape, but this work package owns three files under `/v/[packetId]/` and nothing else
// (AGENTS.md rule 8), so a shared module is not mine to create. The three copies are the same function and a
// test in `packages/verifier` asserts the *behaviour* they all rely on; the drift risk is that the three routes
// read different rows, which `loadVerifierPacket`'s single store port makes impossible — they all call it.
//
// A function rather than a module-level constant: `requiredEnv` throws on a missing variable, and a
// module-level call would throw at *import* time, which in Next means at build time — turning a configuration
// error into a build failure for a page that may never be requested.
// ---------------------------------------------------------------------------

/** §6's required configuration, or a `csError` naming what is missing. */
function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') {
    throw csError(
      'CS_INTERNAL',
      `${name} is not set; /v/{packetId} cannot be served without it`,
      { env: name },
      { userMessage: 'This page is temporarily unavailable. Please tell the operator.' },
    )
  }
  return value.trim()
}

/**
 * The store: three reads, no writes.
 *
 * **Hand-written because `packages/db` has no repository for either table** — `evidence_packets` has only the
 * *port* member in `packages/defender`, which documents which repository should satisfy it, and `jwks_keys` has
 * none at all. Reported as a contract issue (`packages/verifier/README.md`) rather than worked around silently,
 * and wrapped in the same `repo()` every other repository uses so the error typing is identical. It is
 * read-only by construction: three `select`s and no write path.
 */
function store(): VerifierStore {
  return {
    packets: {
      findById: (id) =>
        repo(
          async () => {
            const rows = await db()
              .select()
              .from(evidencePackets)
              .where(eq(evidencePackets.id, id))
              .limit(1)
            return rows[0] as EvidencePacketRow | undefined
          },
          { table: 'evidence_packets', id },
        ),
    },
    disputes: {
      findById: (id) =>
        repo(
          async () => {
            const rows = await db().select().from(disputes).where(eq(disputes.id, id)).limit(1)
            return rows[0] as DisputeRow | undefined
          },
          { table: 'disputes', id },
        ),
    },
    jwks: {
      listAll: () =>
        repo(
          async () => {
            const rows = await db().select().from(jwksKeys)
            return rows as JwksKeyRow[]
          },
          { table: 'jwks_keys' },
        ),
    },
  }
}

/**
 * Build the deps.
 *
 * The vi client is real but its **bearer token never reaches the browser**: `POST /v1/public/verify` is public
 * by design (§8.3) and `ViClient.publicVerify` sends no `Authorization` header. The token is still required by
 * the constructor because the same client serves the Gate's authenticated routes.
 */
function verifierDeps(): VerifierDeps {
  return defineVerifierDeps({
    clock: systemClock,
    store: store(),
    vi: {
      publicVerify: (req) =>
        new ViClient({
          baseUrl: requiredEnv('VI_SERVICE_URL'),
          token: requiredEnv('VI_SERVICE_TOKEN'),
          clock: systemClock,
          logger: logger.child({ module: 'verifier' }),
        }).publicVerify(req),
    },
    publicBaseUrl: requiredEnv('PUBLIC_BASE_URL'),
    logger: logger.child({ module: 'verifier' }),
  })
}

/** Not indexed separately from the packet it describes; the QR is the entry point. */
export async function generateMetadata({ params }: PageProps) {
  const { packetId } = await params
  return {
    title: `Evidence packet ${packetId}`,
    description:
      'A public re-verification page for one Countersign evidence packet: the redacted bundle, the per-check ' +
      'results, and an offline script that needs no Countersign server.',
    // A packet is a record of a specific dispute, not a page to be found by searching.
    robots: { index: false, follow: true },
  }
}

interface PageProps {
  params: Promise<{ packetId: string }>
}

export default async function VerifierPage({ params }: PageProps) {
  const { packetId } = await params
  const deps = verifierDeps()

  // `packetId` arrives as a string from the URL. Narrowed here rather than cast at each use: a `PacketId` is
  // `pkt_` plus a ULID, and `newId` in `packages/core` is the only thing allowed to mint one. A URL that does
  // not match the shape cannot name a packet, so it takes the 404 path with a real id to look for.
  if (!/^pkt_[0-9A-HJKMNP-TV-Z]{26}$/.test(packetId)) notFound()

  const loaded = await loadVerifierPacket(deps, packetId as PacketId)
  if (!loaded.ok) {
    // A store fault is not a missing packet. Saying "no such packet" for an outage would tell a reader the
    // evidence was withdrawn — so this is a 500 with a sentence, and it is logged.
    deps.logger?.error(`verifier: loading ${packetId} failed: ${loaded.error.message}`)
    throw new Error(loaded.error.message)
  }
  // EC-DSP-9's buyer-side path: an unknown packetId is a 404 that says so, never a stack trace. This URL is
  // printed on a PDF a stranger will scan, so "no such packet" must be a sentence, not an exception.
  if (loaded.value === undefined) notFound()

  const packet = loaded.value
  const report = await buildVerifierReport(packet, deps)
  const redacted = buildRedactedView(packet, deps)

  // EC-PRIV-3, enforced rather than assumed. A redaction failure refuses to render at all — the alternative
  // is publishing a buyer's email address, and "we checked" is not worth more than the address.
  const guard = assertRedactionHolds(redacted, packet.bundle)
  if (!guard.ok) {
    deps.logger?.error(`verifier: refusing to render ${packetId}: ${guard.error.message}`)
    throw new Error(guard.error.message)
  }

  const failures = report.checks.filter((c) => c.status === 'FAIL')
  const warnings = report.checks.filter((c) => c.status === 'WARN' || c.status === 'SKIPPED')

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:py-14">
      <header>
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-ink-faint">
          Countersign public verifier
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
          Evidence packet {packet.packetId}
        </h1>
        <p className="mt-3 max-w-2xl text-pretty text-ink-soft">
          This page re-checks one payment’s evidence chain. Everything below is either computed here
          or returned by a service whose answer is named. You do not need to trust Countersign to
          use it — and you do not need a Countersign server at all if you{' '}
          <a
            className="underline underline-offset-4"
            href={verifyScriptUrl(deps.publicBaseUrl, packetId)}
          >
            download the offline script
          </a>
          .
        </p>
      </header>

      <VerdictBanner failures={failures} warnings={warnings} />

      <SummaryCard report={report} />

      <section className="mt-10" aria-labelledby="checks">
        <h2 id="checks" className="text-xl font-semibold">
          Per-check results
        </h2>
        <p className="mt-2 text-sm text-ink-soft">
          Every check names itself, its verdict and its reason in words. A check that could not run
          says so — it is never reported as a pass.
        </p>
        <CheckTable checks={report.checks} />
      </section>

      {report.skippedByVerifier.length > 0 ? <SkippedPanel report={report} /> : null}

      <RedactedViewSection redacted={redacted} />

      <VerifyNowSection baseUrl={deps.publicBaseUrl} packetId={packetId} />

      <CanonicalisationSection report={report} />

      <footer className="mt-16 border-t border-rule pt-6 text-sm text-ink-faint">
        <p>
          This page shows a <strong>redacted</strong> document.{' '}
          <a
            className="underline underline-offset-4"
            href={rawBundleUrl(deps.publicBaseUrl, packetId)}
          >
            Download the full bundle
          </a>{' '}
          for the raw tokens. They are two different documents; nothing here is hidden behind
          styling.
        </p>
        <p className="mt-3">
          Spec §8.18 · screen S-20 · EDGE CASES EC-MER-6, EC-PRIV-3, EC-DSP-9 · acceptance AT-M18.1,
          AT-M18.2. Canonicalisation is RFC 8785 (JCS) plus SHA-256.
        </p>
      </footer>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/**
 * The one-glance answer, and **what it does not say**.
 *
 * Three states, and the middle one matters most: a page can have no failures and still carry warnings that a
 * reader must see. "Everything passed" over a page with an unevaluated budget constraint would be a lie, so
 * this component renders warnings as prominently as failures and never collapses them into the green case.
 */
function VerdictBanner({
  failures,
  warnings,
}: {
  readonly failures: readonly VerifierCheck[]
  readonly warnings: readonly VerifierCheck[]
}) {
  if (failures.length > 0) {
    return (
      <section
        aria-labelledby="verdict"
        className="mt-8 rounded-card border-2 border-danger bg-paper-raised p-5"
      >
        <h2 id="verdict" className="text-lg font-semibold text-danger">
          {failures.length} of {failures.length + warnings.length} checks did not pass
        </h2>
        <p className="mt-2 text-ink-soft">
          Something about this evidence does not match what was published. Read the failing checks
          below before relying on it — and note that a failure here is a statement about the
          document, not about the payment.
        </p>
        <ul className="mt-4 space-y-2">
          {failures.map((c) => (
            <li key={c.id} className="text-sm">
              <span className="font-mono font-semibold text-danger">[FAIL]</span>{' '}
              <span className="font-medium">{c.label}</span> — {c.detail}
            </li>
          ))}
        </ul>
      </section>
    )
  }
  if (warnings.length > 0) {
    return (
      <section
        aria-labelledby="verdict"
        className="mt-8 rounded-card border border-caution bg-paper-raised p-5"
      >
        <h2 id="verdict" className="text-lg font-semibold">
          No check failed, and {warnings.length} could not be conclusive
        </h2>
        <p className="mt-2 text-ink-soft">
          That distinction is the point of this page. A check that could not run is listed below
          rather than folded into a pass.
        </p>
        <ul className="mt-4 space-y-2">
          {warnings.map((c) => (
            <li key={c.id} className="text-sm">
              <span className="font-mono font-semibold">[{c.status}]</span>{' '}
              <span className="font-medium">{c.label}</span> — {c.detail}
            </li>
          ))}
        </ul>
      </section>
    )
  }
  return (
    <section
      aria-labelledby="verdict"
      className="mt-8 rounded-card border border-signed bg-paper-raised p-5"
    >
      <h2 id="verdict" className="text-lg font-semibold text-signed">
        Every check on this page passed
      </h2>
      <p className="mt-2 text-ink-soft">
        The digests reproduce, the consent read-back matches its published hash, the agent’s
        authorisation commits to exactly this price lock, and Countersign’s own signature on the
        Gate decision record verifies. None of that requires a Countersign server.
      </p>
    </section>
  )
}

function SummaryCard({ report }: { readonly report: VerifierReport }) {
  // `currency()` rather than a cast: the report carries the ISO code as a string, because it came out of a
  // jsonb column that nothing validated. `money()` is the function that can *refuse* an unknown code, and a
  // page that rendered `$NaN` because of an unchecked cast would be a poor advertisement for a verifier.
  const amount: Money = money(report.amount.minor, currency(report.amount.currency))
  return (
    <section className="mt-8 rounded-card border border-rule bg-paper-raised p-5">
      <dl className="grid gap-4 sm:grid-cols-2">
        <Field label="Packet" value={report.packetId} mono />
        <Field label="Dispute" value={report.disputeId} mono />
        <Field label="Version" value={String(report.version)} />
        <Field label="Disputed amount" value={formatMoney(amount)} />
        <Field label="Stage" value={report.stage} />
        <Field label="Status" value={report.status} />
        <Field
          label="Filed"
          // IST in the UI only (AGENTS.md rule 10); the bundle and the tokens carry UTC epoch seconds.
          value={report.filedAtSec === null ? 'not filed yet' : formatIstHuman(report.filedAtSec)}
        />
        <Field label="Checks run on this page" value={String(report.checks.length)} />
      </dl>
    </section>
  )
}

function Field({
  label,
  value,
  mono = false,
}: {
  readonly label: string
  readonly value: string
  readonly mono?: boolean
}) {
  return (
    <div>
      <dt className="font-mono text-xs uppercase tracking-wider text-ink-faint">{label}</dt>
      <dd className={mono ? 'mt-1 font-mono text-sm break-all' : 'mt-1 text-sm break-words'}>
        {value}
      </dd>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The check table
// ---------------------------------------------------------------------------

/**
 * One row per check, as a real table.
 *
 * **The status column is the word, not a colour.** `PASS`/`FAIL`/`WARN`/`SKIPPED` in text, because a colour is
 * invisible to a screen reader and to a colourblind reader, and this page is read by somebody who may be
 * either. The row also carries `id`, which is what lets a judge link to one specific check.
 */
function CheckTable({ checks }: { readonly checks: readonly VerifierCheck[] }) {
  return (
    <div className="mt-5 overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">
          Every check this page performed, with its verdict and the reason for it
        </caption>
        <thead>
          <tr className="border-b border-rule">
            <th scope="col" className="py-2 pr-3 font-mono text-xs uppercase tracking-wider">
              Verdict
            </th>
            <th scope="col" className="py-2 pr-3 font-mono text-xs uppercase tracking-wider">
              Check
            </th>
            <th scope="col" className="py-2 pr-3 font-mono text-xs uppercase tracking-wider">
              What it found
            </th>
            <th scope="col" className="py-2 font-mono text-xs uppercase tracking-wider">
              Requirement
            </th>
          </tr>
        </thead>
        <tbody>
          {checks.map((c) => (
            <tr key={c.id} className="border-b border-rule align-top">
              <td className="py-3 pr-3 font-mono font-semibold whitespace-nowrap">{c.status}</td>
              <td className="py-3 pr-3">
                <span className="font-medium">{c.label}</span>
                <span className="mt-1 block font-mono text-xs text-ink-faint">
                  {c.id} · {c.source === 'local' ? 'computed here' : 'asked of vi-service'}
                </span>
              </td>
              <td className="py-3 pr-3 text-ink-soft">{c.detail}</td>
              <td className="py-3 font-mono text-xs text-ink-faint">{c.authority ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * D19's "nobody checked this", as its own panel.
 *
 * Separate from the check table because it is a different kind of statement: not "a check failed" but "a
 * constraint was disclosed and evaluated by **no one**". `packages/verifier`'s `skippedByVerifier` supplies
 * the reasons vi-service returned.
 */
function SkippedPanel({ report }: { readonly report: VerifierReport }) {
  return (
    <section className="mt-10" aria-labelledby="skipped">
      <h2 id="skipped" className="text-xl font-semibold">
        Not evaluated by anyone
      </h2>
      <p className="mt-2 max-w-2xl text-sm text-ink-soft">
        These constraints were disclosed in the chain and the Verifiable Intent library evaluates{' '}
        <em>none</em> of them — its own source calls them network-enforced. Countersign’s Gate
        enforces them (spec D19), so a satisfied verdict from the library says nothing either way.
        Read this as “nobody has told you”, not “nothing to worry about”.
      </p>
      <ul className="mt-4 space-y-2">
        {report.skippedByVerifier.map((entry) => (
          <li key={entry} className="text-sm">
            • {entry}
          </li>
        ))}
      </ul>
    </section>
  )
}

// ---------------------------------------------------------------------------
// The redacted view
// ---------------------------------------------------------------------------

function RedactedViewSection({
  redacted,
}: {
  readonly redacted: ReturnType<typeof buildRedactedView>
}) {
  return (
    <section className="mt-10" aria-labelledby="redacted">
      <h2 id="redacted" className="text-xl font-semibold">
        The redacted bundle
      </h2>
      <p className="mt-2 max-w-2xl text-sm text-ink-soft">{redacted.redacted.note}</p>

      <dl className="mt-5 grid gap-4 sm:grid-cols-2">
        <Field label="Buyer email" value={redacted.buyer.payer_email_masked} mono />
        <Field
          label="PayPal payer id"
          value={redacted.buyer.payer_id_masked ?? 'not in this packet'}
          mono
        />
        <Field
          label="City / country"
          value={
            [redacted.buyer.city, redacted.buyer.country].filter(Boolean).join(', ') ||
            'not in this packet'
          }
        />
        <Field label="Custom id (D18)" value={redacted.paypal?.custom_id ?? 'none'} mono />
      </dl>

      <h3 className="mt-8 text-base font-semibold">Signed artefacts</h3>
      <p className="mt-1 text-sm text-ink-soft">
        Lengths and SHA-256 digests, so you can confirm this page describes the file you downloaded.
      </p>
      <ul className="mt-3 space-y-2">
        {redacted.artefacts.map((a) => (
          <li key={a.name} className="text-sm">
            <span className="font-mono font-semibold">{a.name}</span>{' '}
            <span className="text-ink-soft">{a.role}</span>
            <span className="mt-1 block font-mono text-xs break-all text-ink-faint">
              {a.present ? `${a.bytes} bytes · sha256 ${a.sha256}` : 'not in this packet'}
            </span>
          </li>
        ))}
      </ul>

      {redacted.consent.readback !== null ? (
        <>
          <h3 className="mt-8 text-base font-semibold">What the buyer signed, in plain English</h3>
          <p className="mt-2 text-sm text-pretty text-ink-soft">{redacted.consent.readback}</p>
          <p className="mt-2 font-mono text-xs break-all text-ink-faint">
            sha256 {redacted.consent.readback_sha256}
          </p>
          {redacted.consent.preferences !== null ? (
            <p className="mt-3 text-sm">
              Preferences on the record:{' '}
              {Object.entries(redacted.consent.preferences)
                .map(([k, v]) => `${k} ${v}`)
                .join(', ')}{' '}
              <span className="font-mono text-xs text-ink-faint">
                (sha256 {redacted.consent.preferences_sha256})
              </span>
            </p>
          ) : null}
        </>
      ) : (
        <p className="mt-8 text-sm text-danger">
          This packet carries no consent read-back. Spec EC-MER-6 makes it a required field, so the
          omission is itself a finding.
        </p>
      )}

      <h3 className="mt-8 text-base font-semibold">What this page withheld</h3>
      <ul className="mt-3 space-y-2">
        {redacted.redacted.withheld.map((w) => (
          <li key={w} className="text-sm">
            • {w}
          </li>
        ))}
      </ul>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Verify now / offline
// ---------------------------------------------------------------------------

/**
 * The two ways to re-verify, as links.
 *
 * **No client JS**, so "Verify now" is a `GET` to a route handler rather than a `fetch` from a component.
 * Three reasons that is better here than the obvious alternative:
 *
 * 1. It works with JavaScript disabled — which a sceptical reader testing our claims may well do.
 * 2. It cannot be confused with a client-side "it says valid!" that never asked anyone.
 * 3. It gives the rate limiter (§8.3's 30/min/IP) somewhere to sit, and a `GET` can be reloaded.
 */
function VerifyNowSection({
  baseUrl,
  packetId,
}: {
  readonly baseUrl: string
  readonly packetId: string
}) {
  return (
    <section className="mt-10" aria-labelledby="verify-now">
      <h2 id="verify-now" className="text-xl font-semibold">
        Re-verify it yourself
      </h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="rounded-card border border-rule bg-paper-raised p-5">
          <h3 className="font-semibold">Verify now</h3>
          <p className="mt-2 text-sm text-ink-soft">
            Asks our vi-service to re-verify the chain with the pinned Verifiable Intent library,
            and shows every check it performed and every check it skipped. Rate-limited to 30
            requests a minute per IP.
          </p>
          <Link
            className="mt-4 inline-block rounded-card border border-rule px-4 py-2 font-medium"
            href={`/v/${packetId}/verify-now`}
          >
            Re-verify now
          </Link>
        </div>
        <div className="rounded-card border border-rule bg-paper-raised p-5">
          <h3 className="font-semibold">Verify offline</h3>
          <p className="mt-2 text-sm text-ink-soft">
            A real Python file with this packet’s digests baked in. It uses no network at all, so it
            works with no Countersign server running — which is the only way to check us without our
            help.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <a
              className="inline-block rounded-card border border-rule px-4 py-2 font-medium"
              href={verifyScriptUrl(baseUrl, packetId)}
              download
            >
              Download verify.py
            </a>
            <a
              className="inline-block rounded-card px-4 py-2 underline underline-offset-4"
              href={rawBundleUrl(baseUrl, packetId)}
              download
            >
              Download bundle.json
            </a>
          </div>
          <p className="mt-3 font-mono text-xs text-ink-faint">
            uv run python verify.py bundle.json
          </p>
        </div>
      </div>
      <p className="mt-4 text-sm text-ink-soft">
        This page is at{' '}
        <span className="font-mono break-all">{publicPacketUrl(baseUrl, packetId)}</span>, which is
        the address encoded in the QR code on the filed PDF.
      </p>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Canonicalisation
// ---------------------------------------------------------------------------

function CanonicalisationSection({ report }: { readonly report: VerifierReport }) {
  const c = report.canonicalisation
  return (
    <section className="mt-10" aria-labelledby="canonicalisation">
      <h2 id="canonicalisation" className="text-xl font-semibold">
        How the hashes are computed
      </h2>
      <p className="mt-2 text-sm text-ink-soft">
        Stated here so you can recompute any digest on this page with <code>sha256</code> and
        nothing else of ours. {c.note}
      </p>
      <dl className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Canonicalisation" value={c.spec} />
        <Field label="Digest" value={c.algorithm} />
        <Field label="Members the custom_id hash covers" value={c.hashedMembers.join(', ')} mono />
        <Field label="Members it excludes" value={c.excludedFromCustomId.join(', ')} mono />
      </dl>
    </section>
  )
}
