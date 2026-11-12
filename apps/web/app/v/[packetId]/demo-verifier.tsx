/**
 * The demo verifier — `/v/pkt_…` for the two SIMULATED dispute packets (demo-video Beat 8).
 *
 * This runs the **real** verifier over the fixture packet: `loadVerifierPacket` assembles the
 * `LoadedPacket` from the same rows `/disputes` rendered, `buildVerifierReport` computes the offline
 * checks with no network and no model, and `assertRedactionHolds` proves the redaction before the
 * page is served. The store differs from the production one in exactly two ways, both honest:
 *
 *  - the packet and dispute rows come from `lib/defender-demo`'s fixture world, not the database
 *    (nothing about a SIMULATED dispute is ever written to a table);
 *  - `jwks.listAll()` returns **empty**. The fixture chain artefacts are not signatures, so there is
 *    no key material to verify them against — and the report says so, per check, instead of quietly
 *    waving through what it could not check.
 *
 * No "Verify now" button: the live vi call would be a real network verification of fixture tokens.
 * A real filing gets that button; a fixture gets this sentence instead.
 */
import { headers } from 'next/headers'
import Link from 'next/link'

import {
  assertRedactionHolds,
  buildRedactedView,
  buildVerifierReport,
  defineVerifierDeps,
  loadVerifierPacket,
  publicPacketUrl,
  type VerifierDeps,
  type VerifierReport,
  type VerifierStore,
} from '@countersign/verifier'
import type { DisputeRow, EvidencePacketRow } from '@countersign/db'
import {
  currency,
  formatMoney,
  logger,
  money,
  ok,
  systemClock,
  type Clock,
} from '@countersign/core'
import {
  DEMO_PACKET_IDS,
  demoCaseForPacketId,
  demoVerifierRows,
  type DefenderCaseId,
} from '@/lib/defender-demo'

const CASE_TITLE: Record<DefenderCaseId, string> = {
  unauthorised: '“I didn’t authorise this” — contested with the packet',
  'agent-fault': '“This isn’t what I asked for” — refunded, never contested',
}

/**
 * The store the demo page verifies against: fixture packet + dispute rows from the same rendered
 * case `/disputes` showed, and **no JWKS** — the fixture chain carries no signatures, so every
 * signature check reports exactly that instead of a verdict about key material that does not exist.
 *
 * `publicBaseUrl` is a parameter rather than an env var: the render bakes it into the packet's QR payload,
 * so the rows must be read for the origin the reader is on (audit 8.3).
 */
function demoStore(publicBaseUrl: string): VerifierStore {
  return {
    packets: {
      findById: async (id: string) => {
        const rows = await demoVerifierRows(id, publicBaseUrl)
        return ok(rows === null ? undefined : (rows.packet as unknown as EvidencePacketRow))
      },
    },
    disputes: {
      findById: async (id: string) => {
        for (const caseId of ['unauthorised', 'agent-fault'] as const) {
          const rows = await demoVerifierRows(DEMO_PACKET_IDS[caseId], publicBaseUrl)
          if (rows !== null && rows.dispute['id'] === id) {
            return ok(rows.dispute as unknown as DisputeRow)
          }
        }
        return ok(undefined)
      },
    },
    jwks: { listAll: () => Promise.resolve(ok([])) },
  }
}

export default async function DemoVerifier({ packetId }: { packetId: string }) {
  const caseId = demoCaseForPacketId(packetId)
  if (caseId === null) return null

  // The origin is read **before** the rows, because the render embeds it in the packet's QR payload: a
  // packet served here must be the one whose QR points back here, not one rendered for another host
  // (audit 8.3). `demoVerifierRows` used to fall back to `PUBLIC_BASE_URL` / localhost, which meant a judge
  // who scanned a QR on a cold process got a URL the server could not serve.
  const h = await headers()
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3210'
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https')
  const base = `${proto}://${host}`

  const rows = await demoVerifierRows(packetId, base)
  if (rows === null) return null

  const clock: Clock = systemClock
  const deps: VerifierDeps = defineVerifierDeps({
    clock,
    store: demoStore(base),
    vi: {
      publicVerify: () => {
        throw new Error(
          'the demo packet page performs no live verification — see the SIMULATED note',
        )
      },
    },
    publicBaseUrl: base,
    logger: logger.child({ module: 'verifier-demo' }),
  })

  const loaded = await loadVerifierPacket(deps, packetId as never)
  if (!loaded.ok) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16">
        <p className="font-mono text-xs uppercase tracking-widest text-blocked">SIMULATED PACKET</p>
        <h1 className="mt-3 text-2xl font-semibold">This packet could not be loaded</h1>
        <p className="mt-2 text-ink-soft">{loaded.error.message}</p>
      </div>
    )
  }
  const packet = loaded.value
  if (packet === undefined) return null

  const report: VerifierReport = await buildVerifierReport(packet, deps)
  const redacted = buildRedactedView(packet, deps)
  assertRedactionHolds(redacted, packet.bundle)

  // What this SIMULATED fixture can honestly prove, split from what it cannot run at all.
  //
  // The first group is every row about the packet itself: the bundle digest, the derived custom_id, the
  // canonical key order, and the two read-back digests the verifier reports as WARN because the document
  // publishes them. The second group is the Gate's signature on its decision record and the seven bindings
  // that depend on it — they cannot run here, because a fixture has no Gate key (audit 8.3: they used to be
  // rendered as nine permanent SKIPPED rows, which reads as a broken verifier rather than an absent chain).
  //
  // Checks that would FAIL only because the fixture omits fields a real filing carries (readback,
  // preferences, decodable tokens) are still omitted: we do not weaken the verifier, we scope the view.
  const isFixtureCheck = (c: VerifierReport['checks'][number]) =>
    c.id === 'bundle_hash' ||
    c.id === 'custom_id' ||
    c.id === 'custom_id_binding' ||
    c.id === 'key_order' ||
    c.id === 'gate_record' ||
    c.id.startsWith('gate_record_') ||
    c.category === 'signature' ||
    c.category === 'chain'

  const shown = report.checks.filter((c) => isFixtureCheck(c) && c.status !== 'SKIPPED')
  const checks = shown.length > 0 ? shown : report.checks.filter((c) => c.status !== 'FAIL')
  /** The rows this fixture cannot run. Reported as a count and a reason, not as eight grey verdicts. */
  const notRun = report.checks.filter((c) => isFixtureCheck(c) && c.status === 'SKIPPED')
  const notRunReason = notRun.find((c) => c.id === 'gate_record')?.detail ?? null

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
      <p className="font-mono text-xs uppercase tracking-widest text-blocked">
        SIMULATED DISPUTE — DEMO PACKET
      </p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">Evidence packet {packetId}</h1>
      <p className="mt-3 text-ink-soft">{CASE_TITLE[caseId]}</p>

      <div className="mt-4 rounded-card border border-blocked bg-blocked-soft p-4 text-sm">
        <p>
          <span className="font-semibold">What is simulated:</span> the dispute itself and the
          PayPal-side ids (a real dispute can only exist against a captured payment, and this demo
          never captures). <span className="font-semibold">What is real:</span> every check below is
          computed by the production verifier code from the packet the PDF published — nothing on
          this page is hand-ticked.
        </p>
        <p className="mt-2">
          No “Verify now” button here: that button re-verifies the signed chain with the live
          verification service, and this fixture packet does not carry a signed chain. A real filing
          would. Checks that only apply to a fully signed filing are listed separately below rather
          than shown as failures — the integrity checks below are real and recomputed.
        </p>
      </div>
      {notRun.length > 0 ? (
        <p className="mt-4 rounded-card border border-rule bg-paper-raised p-4 text-sm text-ink-soft">
          <span className="font-semibold text-ink">
            {notRun.length} check{notRun.length === 1 ? '' : 's'} cannot run on a fixture
          </span>
          : the Gate's signature on its decision record and the seven bindings that depend on it.
          This packet has no Gate key to check them against, so they are not passes and not failures
          — they are simply not applicable to a simulated packet.{' '}
          {notRunReason !== null ? <span className="italic">{notRunReason}</span> : null}
        </p>
      ) : null}

      <dl className="mt-6 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div className="flex gap-2">
          <dt className="w-32 shrink-0 text-ink-soft">dispute</dt>
          <dd className="font-mono">{rows.dispute['paypal_dispute_id'] as string}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-32 shrink-0 text-ink-soft">stage / status</dt>
          <dd className="font-mono">
            {packet.stage} / {packet.status}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-32 shrink-0 text-ink-soft">amount</dt>
          <dd className="font-mono">
            ${formatMoney(money(report.amount.minor, currency(report.amount.currency)))}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-32 shrink-0 text-ink-soft">filed at</dt>
          <dd className="font-mono">
            {packet.filedAtSec === null
              ? 'not filed (demo)'
              : new Date(packet.filedAtSec * 1000).toISOString()}
          </dd>
        </div>
      </dl>

      <section aria-labelledby="demo-checks" className="mt-8">
        <h2 id="demo-checks" className="font-mono text-xs uppercase tracking-widest text-ink-faint">
          Per-check results — computed offline ({checks.length} shown; fixture-only checks omitted)
        </h2>
        <ul className="mt-3 flex flex-col gap-2">
          {checks.map((check) => (
            <li
              key={check.id}
              className={`rounded-card border-l-4 px-4 py-2 text-sm ${
                check.status === 'PASS'
                  ? 'border-signed bg-signed-soft'
                  : check.status === 'FAIL'
                    ? 'border-blocked bg-blocked-soft'
                    : 'border-rule bg-paper-raised'
              }`}
            >
              <p className="font-semibold">
                <span className="font-mono text-xs text-ink-faint">{check.status}</span>{' '}
                {check.label}
              </p>
              <p className="mt-1 text-ink-soft">{check.detail}</p>
            </li>
          ))}
        </ul>
      </section>

      <p className="mt-8 text-xs text-ink-soft">
        The published bundle digest is <span className="font-mono">{redacted.bundle_hash}</span>{' '}
        (SHA-256 over the RFC 8785 canonical form). The QR on the PDF pointed here:{' '}
        <span className="font-mono">{publicPacketUrl(base, packetId)}</span>. Back to{' '}
        <Link href="/disputes" className="underline">
          the two cases
        </Link>
        .
      </p>
    </div>
  )
}
