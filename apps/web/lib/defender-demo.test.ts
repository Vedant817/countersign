/**
 * `/disputes` — the fixture view must render as text, never as an object.
 *
 * The regression these tests exist for: `citation.artefact` is a `ClaimArtefact` **object**
 * (`{ id, kind, description }`, `packages/defender/src/citation-check.ts`), and the page used to render
 * it directly. React cannot render an object, so `apps/web/lib/defender-demo.ts` flattened it with
 * `String(c.artefact)` → `"[object Object]"`, and a judge (and a PayPal adjudicator) read
 * `“…the purchase was authorised” ← [object Object]` fifteen times on the packet's own page.
 *
 * So the assertion is on the *shape of the view*, not on a snapshot: every cited artefact must carry a
 * usable, non-empty `id` that names the §7.3 bundle member, and serialising the whole view must never
 * contain the string `[object Object]`. The second assertion is the one that would have failed before
 * the fix, whatever object got smuggled into the view next.
 */
import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'
import type { LanguageModel as AiLanguageModel } from 'ai'

import {
  buildVerifierReport,
  defineVerifierDeps,
  loadVerifierPacket,
  type VerifierStore,
} from '@countersign/verifier'
import type { DisputeRow, EvidencePacketRow } from '@countersign/db'
import { logger, ok, systemClock } from '@countersign/core'

import {
  DEMO_PACKET_IDS,
  defenderDraftPort,
  demoCasePdf,
  demoCases,
  demoVerifierRows,
} from './defender-demo'

const PUBLIC_BASE_URL = 'https://merchant.example.test'

describe('the dispute demo view', () => {
  it('renders every citation artefact as an id a reader can act on (no [object Object])', async () => {
    const cases = await demoCases(PUBLIC_BASE_URL)

    // The page a judge reads. Every case, not just the one that happens to be first.
    expect(cases.map((c) => c.id)).toEqual(['unauthorised', 'agent-fault'])

    const contested = cases.find((c) => c.draft !== null)
    expect(contested?.draft).not.toBeNull()

    for (const c of cases) {
      for (const citation of c.draft?.citations ?? []) {
        expect(citation.artefact.kind.length).toBeGreaterThan(0)
        expect(citation.artefact.description.length).toBeGreaterThan(0)
        // §7.3's bundle ids: `l1` | `l2` | `l3` | `gate:<id>` | `tracking:<id>` | `capture:<id>` |
        // `refund:<id>` | `checkout:<id>`. A bare object string would not match any of these.
        expect(citation.artefact.id).toMatch(
          /^(l1|l2|l3|gate:.+|tracking:.+|capture:.+|refund:.+|checkout:.+)$/,
        )
      }
    }

    // The exact failure mode: an object reaching a renderer. Serialised, it is unambiguous.
    expect(JSON.stringify(cases)).not.toContain('[object Object]')
  })

  it('shows the disputed amount once, with the currency symbol (no $$128.00)', async () => {
    const cases = await demoCases(PUBLIC_BASE_URL)

    for (const c of cases) {
      expect(c.dispute.amount).toMatch(/^\$[\d,]+\.\d{2}$/)
      expect(c.dispute.amount.startsWith('$$')).toBe(false)
    }
  })
})

describe('the render cache', () => {
  it('serves one render per case, so the page and the download route cannot disagree', async () => {
    // Two reads, one pipeline. The second call must not recompute: a recompute would produce a *different*
    // PDF (the clock moved), and the digest the page printed would no longer be the digest of the bytes the
    // download route serves — which is exactly what the QR on the packet verifies.
    const [first] = await demoCases(PUBLIC_BASE_URL)
    const [again] = await demoCases(PUBLIC_BASE_URL)
    expect(first).toBeDefined()
    expect(again).toBe(first)

    const pdf = await demoCasePdf('unauthorised', PUBLIC_BASE_URL)
    expect(pdf).not.toBeNull()
    expect(first?.pdf).not.toBeNull()

    // The property stated as a digest, not as object identity: what the page reports is what the route
    // serves, byte for byte.
    const served = createHash('sha256').update(pdf!).digest('hex')
    expect(served).toBe(first?.pdf?.sha256)
  })

  it('holds one render per origin, because the QR payload carries the origin (8.3)', async () => {
    // The render bakes `publicBaseUrl` into the PDF's QR payload, so a cache keyed by case id alone would
    // hand a reader on host B a packet whose QR points at host A. Two origins, two renders, two QR payloads.
    const here = await demoCases('https://here.example')
    const there = await demoCases('https://there.example')

    expect(here[0]).not.toBe(there[0])
    expect(here[0]?.pdf?.qrPayload).toContain('https://here.example')
    expect(there[0]?.pdf?.qrPayload).toContain('https://there.example')
    expect(here[0]?.pdf?.qrPayload).not.toBe(there[0]?.pdf?.qrPayload)
  })

  it('reads the packet row for the origin the page is served from (8.3)', async () => {
    // `demoVerifierRows` used to ignore its caller and render against `PUBLIC_BASE_URL ?? localhost:3000`,
    // so on a cold process the packet a judge scanned was rendered for a different host than the one that
    // served it. The row carries the PDF digest, which pins which render it came from: read at one origin,
    // it must equal the PDF that origin is served.
    const origin = 'https://row.example'
    const rows = await demoVerifierRows(DEMO_PACKET_IDS.unauthorised, origin)
    expect(rows).not.toBeNull()

    const pdf = await demoCasePdf('unauthorised', origin)
    expect(pdf).not.toBeNull()
    const digest = createHash('sha256').update(pdf!).digest('hex')
    expect(rows!.packet['pdf_sha256']).toBe(digest)
  })
})

/**
 * A verifier store over one demo packet.
 *
 * `jwks` is empty on purpose — the fixture chain artefacts are not signatures, so the signature rows must
 * report exactly that rather than a verdict about key material that does not exist.
 */
function storeFor(packet: unknown, dispute: unknown): VerifierStore {
  return {
    packets: { findById: async () => ok(packet as EvidencePacketRow) },
    disputes: { findById: async () => ok(dispute as DisputeRow) },
    jwks: { listAll: async () => ok([]) },
  }
}

async function reportFor(packet: Record<string, unknown>, dispute: Record<string, unknown>) {
  const deps = defineVerifierDeps({
    clock: systemClock,
    store: storeFor(packet, dispute),
    vi: {
      publicVerify: () => {
        throw new Error('no live verification in a unit test')
      },
    },
    publicBaseUrl: PUBLIC_BASE_URL,
    logger: logger.child({ module: 'defender-demo-test' }),
  })
  const loaded = await loadVerifierPacket(deps, packet['id'] as never)
  if (!loaded.ok) throw new Error(`loadVerifierPacket: ${loaded.error.message}`)
  if (loaded.value === undefined) throw new Error('the packet row did not load')
  return await buildVerifierReport(loaded.value, deps)
}

describe('the packet digest the verifier reads', () => {
  it('is the digest captured at render time, so a tampered bundle fails the check', async () => {
    // `demoVerifierRows` names a case by its **packet id** (that is the URL a QR encodes).
    const rows = await demoVerifierRows(DEMO_PACKET_IDS.unauthorised, PUBLIC_BASE_URL)
    expect(rows).not.toBeNull()

    const clean = await reportFor(rows!.packet, rows!.dispute)
    const cleanHash = clean.checks.find((c) => c.id === 'bundle_hash')
    expect(cleanHash?.status, 'an untouched bundle must pass its own digest check').toBe('PASS')

    // The check is only worth showing if it can fail. Re-serving the same packet with one bundle member
    // changed is what an edited packet looks like to the reader.
    const bundle = rows!.bundle as unknown as Record<string, unknown>
    const tampered = {
      ...rows!.packet,
      bundle: { ...bundle, l1: 'l1.eyJhbGciOiJFUzI1NiJ9.dGFtcGVyZWQ.dGVhbGVk' },
    }
    const tamperedReport = await reportFor(tampered, rows!.dispute)
    const tamperedHash = tamperedReport.checks.find((c) => c.id === 'bundle_hash')

    expect(tamperedHash?.status, 'a changed bundle must not pass the digest check').toBe('FAIL')
    expect(tamperedHash?.detail).not.toBe(cleanHash?.detail)
  })

  it('reads a digest the render recorded, not one recomputed from the same read', async () => {
    const rows = await demoVerifierRows(DEMO_PACKET_IDS.unauthorised, PUBLIC_BASE_URL)
    expect(rows).not.toBeNull()
    // `bundle_hash` is a stored field on the row (as `evidence_packets.bundle_hash` is in the database).
    // The render is what writes it; the verifier only ever compares.
    expect(typeof rows!.packet['bundle_hash']).toBe('string')
    expect((rows!.packet['bundle_hash'] as string).length).toBe(64)
    expect(rows!.packet['bundle_hash'] as string).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('the drafter model adapter', () => {
  it('aborts a model call that never answers, instead of hanging the page (§8.6)', async () => {
    // The property under test: the port hands the AI SDK a deadline, and the SDK hands the provider's
    // `doGenerate` the signal. A port that omitted `abortSignal` would leave this promise pending forever
    // and the test would fail on vitest's own timeout — which is the same failure a real reader would see
    // as a page that never renders.
    let sawSignal = false
    const hanging = {
      specificationVersion: 'v3',
      provider: 'test',
      modelId: 'never-answers',
      supportedUrls: {},
      doGenerate: async (options: { abortSignal?: AbortSignal }) => {
        sawSignal = options.abortSignal !== undefined
        return await new Promise<never>((_resolve, reject) => {
          options.abortSignal?.addEventListener('abort', () =>
            reject(new Error('aborted by the drafter deadline')),
          )
        })
      },
    } as unknown as AiLanguageModel

    const port = defenderDraftPort(hanging, 25)
    const startedAt = Date.now()
    await expect(port.generateText({ system: 's', prompt: 'p' })).rejects.toThrow(/aborted/)
    const elapsedMs = Date.now() - startedAt

    expect(sawSignal, 'the provider was never given an AbortSignal').toBe(true)
    expect(elapsedMs).toBeGreaterThanOrEqual(20)
    // Not "eventually": a deadline that fires in the next hour is not a deadline for a page request.
    expect(elapsedMs).toBeLessThan(2_000)
  })
})
