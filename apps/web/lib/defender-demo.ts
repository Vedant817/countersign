import 'server-only'

/**
 * `/disputes` — the Dispute Defender demo (Beat 7 of the demo script).
 *
 * ## What is real here, and what is not — stated once, rendered twice
 *
 * **Real:** everything the Defender does. The router (`route`) is the production rule table; the
 * evidence planner (`planEvidence`) is the production planner; the draft is produced by the
 * production drafter (`draft`) — the configured model, then the §8.15 citation checker, which
 * rejects any sentence no record supports, with the deterministic template as the fallback when no
 * provider is configured; the PDF is the production renderer (`renderPacketPdf`) with the QR. None
 * of this is re-implemented for the demo.
 *
 * **Simulated:** the dispute itself. PayPal's Disputes API only returns disputes that exist against
 * a *captured* payment, and this deployment cannot capture (no vaulted buyer — HUMAN_TODO 1a). So
 * the dispute, its PayPal ids and its capture are fixtures shaped exactly like the API's response,
 * the page carries a **SIMULATED** banner, and the PDF footer names it too. The fixture rows are
 * `createInMemoryDefenderWorld`'s — the same construction the package's own sandbox tests use.
 *
 * The two cases:
 *
 *  - **unauthorised** — "I didn't authorise this", the buyer's records prove the opposite: device
 *    attested, mandate signed, chain verified → `R-UNAUTH-1` → **CONTEST** → evidence packet PDF.
 *  - **agent-fault** — the item the agent checked out does not match the size the mandate recorded
 *    → `R-SNAD-AGENT` → **REFUND**: no packet, no fight, pay the buyer.
 *
 * The agent-fault context needs one override, and it is worth saying why: PayPal's Disputes API item
 * objects carry no product attributes (`ingest.disputedItemOf` always yields `{}` — the API has no
 * size/colour field today), so `attributeConflicts` can never fire from ingest alone. The demo
 * supplies the buyer's complaint ("I ordered size 10; the agent checked out a size 9") as the
 * attribute record the API would need — the same stand-in `test/router.test.ts` uses.
 */

import { formatMoney, money, systemClock, type Clock } from '@countersign/core'
import {
  buildDisputeContext,
  checkCitations,
  claimSourcesFor,
  createInMemoryDefenderWorld,
  draft,
  derivedDisputeId,
  planEvidence,
  publicPacketUrl,
  renderPacketPdf,
  route,
  templateNote,
  plainNotes,
  type Draft,
  type DraftSource,
  type LanguageModel as DrafterModel,
  type EvidenceBundle,
  type LiabilityDecision,
  type PacketView,
  type RenderedPacket,
} from '@countersign/defender'
import type {
  AuditLogRow,
  CaptureRow,
  CheckoutAttemptRow,
  CheckoutSessionRow,
  DeviceRow,
  DisputeRow,
  GateDecisionRow,
  MandateRow,
  OrderRow,
  ShipmentRow,
} from '@countersign/db'
import { generateText, type LanguageModel as AiLanguageModel } from 'ai'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { bundleHashHex, customIdForBundle } from '@countersign/verifier'

import { languageModel } from './llm'

/* ------------------------------------------------------------------------------------------ */
/* The fixture world — one order, one capture, one shipment, one signed mandate                 */
/* ------------------------------------------------------------------------------------------ */

const MERCHANT_PAYPAL_ID = 'FYQ3WRFW7KQTL'
const ORDER_ID = 'ord_0000000000000000000000de'
const ATTEMPT_ID = 'att_0000000000000000000000de'
const SESSION_ID = 'chk_0000000000000000000000de'
const CAPTURE_ID = 'cap_0000000000000000000000de'
const SHIPMENT_ID = 'shp_0000000000000000000000de'
const MANDATE_ID = 'mdt_0000000000000000000000de'
const DEVICE_ID = 'dev_0000000000000000000000de'
const USER_ID = 'usr_0000000000000000000000de'
const WALLET_ID = 'wal_0000000000000000000000de'
const AGENT_ID = 'agt_0000000000000000000000de'
const AMOUNT_MINOR = 12_800n
const CURRENCY = 'USD'
/** PayPal order/capture ids are 17 characters `[A-Z0-9]`; `DEMO`-prefixed ids cannot be real. */
const PP_ORDER_ID = 'DEMO00000000000001'
const PP_CAPTURE_ID = 'DEMO00000000000002'
const CUSTOM_ID = `cs1:${'D'.repeat(43)}`
/** RFC 7638-style device thumbprint fixture — the shape the packet inventories. */
const DEVICE_JKT = 'kDEMO000000000000000000000000000000000000'

/**
 * Fixture chain artefacts. Each is shaped like the real artefact (an SD-JWT / compact JWS) but the
 * payload decodes to `demo_chain_fixture`, so no verifier can mistake them for real signatures — and
 * the page says the same thing in prose.
 */
const BUNDLE: EvidenceBundle = {
  v: 'cs1',
  l1: 'l1.eyJhbGciOiJFUzI1NiJ9.ZGVtb19jaGFpbl9maXh0dXJl.ZDE',
  l2: 'l2.eyJhbGciOiJFUzI1NiJ9.ZGVtb19jaGFpbl9maXh0dXJl.ZDI',
  l3a: 'l3a.eyJhbGciOiJFUzI1NiJ9.ZGVtb19jaGFpbl9maXh0dXJl.ZDM',
  l3b: 'l3b.eyJhbGciOiJFUzI1NiJ9.ZGVtb19jaGFpbl9maXh0dXJl.ZDQ',
  checkout_jwt: 'co.eyJhbGciOiJFUzI1NiJ9.ZGVtb19jaGFpbl9maXh0dXJl.ZDU',
  gate_decision: 'gd.eyJhbGciOiJFUzI1NiJ9.ZGVtb19jaGFpbl9maXh0dXJl.ZDY',
  webauthn: { present: true, at: 0 }, // overwritten per case with a real relative time
  vi_lib_commit: '356c29635f1c44df7de02edb58699ca9f29bece6',
  paypal: {
    order_id: PP_ORDER_ID,
    capture_ids: [PP_CAPTURE_ID],
    custom_id: CUSTOM_ID,
  },
  shipments: [{ carrier: 'DHL', tracking: 'JD0002000031', lines: [{ sku: 'NW-001', qty: 1 }] }],
}

const READBACK =
  '**What you are authorising**\nOnly at **Northwind Outfitters**\n' +
  'Buy the cheapest trail shoes you can find, at most **$150.00**\n' +
  'One order, placed today'

const NL_INTENT = 'Buy the cheapest trail shoes you can find, under $150'

/**
 * Fixture packet ids, shaped to pass the public verifier's own id check.
 *
 * `/v/[packetId]` 404s anything that is not `pkt_` + 26 characters of the Crockford-style set the
 * verifier's regex allows (no I, L, O or U — so the obvious "DEMO" prefix is out). The tags below
 * spell the case in the letters that set allows; the zeros pad to exactly 26.
 */
const fixturePacketId = (tag: string): string => `pkt_${(tag + '0'.repeat(26)).slice(0, 26)}`

/** Which case a `/v/pkt_…` URL names, or `null` when the id is not one of the demo fixtures. */
export function demoCaseForPacketId(packetId: string): DefenderCaseId | null {
  if (packetId === fixturePacketId('F1RSTCASE1')) return 'unauthorised'
  if (packetId === fixturePacketId('AGNTFXT01')) return 'agent-fault'
  return null
}

/** The two fixture packet ids, keyed by case — the QR payloads the PDF and the demo page print. */
export const DEMO_PACKET_IDS: Record<DefenderCaseId, string> = {
  unauthorised: fixturePacketId('F1RSTCASE1'),
  'agent-fault': fixturePacketId('AGNTFXT01'),
}

/* ------------------------------------------------------------------------------------------ */
/* The two demo cases                                                                          */
/* ------------------------------------------------------------------------------------------ */

export type DefenderCaseId = 'unauthorised' | 'agent-fault'

export interface DefenderCaseView {
  readonly id: DefenderCaseId
  readonly title: string
  readonly dispute: {
    readonly paypalDisputeId: string
    readonly reason: string
    readonly stage: string
    readonly status: string
    readonly amount: string
    readonly opened: string
    readonly responseDue: string
  }
  readonly rule: {
    readonly ruleId: string
    readonly liability: string
    readonly posture: string
    readonly action: string | null
    readonly rationale: string
    readonly reasons: readonly string[]
    readonly facts: readonly { readonly key: string; readonly value: string }[]
  }
  readonly plan: readonly { readonly evidenceType: string; readonly note: string }[]
  readonly draft: {
    readonly source: DraftSource
    readonly notes: string
    readonly citations: readonly {
      readonly claimId: string
      readonly sentence: string
      /** The §7.3 bundle id the sentence cites (`l1`, `gate:<id>`, `capture:<id>`, …). */
      readonly artefact: {
        readonly id: string
        readonly kind: string
        readonly description: string
      }
    }[]
  } | null
  readonly pdf: {
    readonly packetId: string
    readonly sha256: string
    readonly byteLength: number
    readonly pageCount: number
    readonly qrPayload: string
  } | null
  readonly buyerMessage: string | null
  readonly notes: readonly string[]
}

interface CaseWorld {
  readonly world: ReturnType<typeof createInMemoryDefenderWorld>
  readonly disputeId: string
  readonly dueSec: number
  readonly openedSec: number
  /** The §7.3 bundle this case renders and the verifier re-hashes — one object, one digest. */
  readonly bundle: EvidenceBundle
  readonly customId: string
}

/** The dispute row + world for one case, at one fixed point in time. */
function caseWorld(id: DefenderCaseId, nowSec: number): CaseWorld {
  const openedSec = nowSec - 2 * 86_400
  const dueSec = nowSec + 10 * 86_400
  // The `custom_id` the verifier recomputes (§7.3, D18): cs1: + base64url(sha256) over the NINE core
  // members, which exclude `paypal` and `shipments` — so computing it before setting the field is not
  // circular. The same value goes into the bundle and the order row, which is what `customIdAgreement`
  // (and the verifier's custom_id row) check.
  const bundleCore: EvidenceBundle = {
    ...BUNDLE,
    webauthn: { present: true, at: nowSec - 3 * 86_400 },
    paypal: { ...BUNDLE.paypal!, custom_id: '' },
  }
  const customId =
    customIdForBundle(bundleCore as unknown as Readonly<Record<string, unknown>>) ?? CUSTOM_ID
  const bundle: EvidenceBundle = {
    ...bundleCore,
    paypal: { ...bundleCore.paypal!, custom_id: customId },
  }
  const at = (sec: number) => new Date(sec * 1000)

  const paypalDisputeId = id === 'unauthorised' ? 'PP-D-DEMO28701UNAUTH' : 'PP-D-DEMO28702SNAD'
  const reason = id === 'unauthorised' ? 'UNAUTHORISED' : 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED'

  const disputeRow = {
    id: derivedDisputeId(paypalDisputeId),
    paypal_dispute_id: paypalDisputeId,
    order_id: ORDER_ID,
    capture_id: CAPTURE_ID,
    reason,
    stage: 'CHARGEBACK',
    status: 'WAITING_FOR_SELLER_RESPONSE',
    amount_minor: AMOUNT_MINOR,
    currency: CURRENCY,
    seller_response_due_date: at(dueSec),
    defense_state: 'NEW',
    liability: null,
    router_trace: null,
    raw: {
      dispute_id: paypalDisputeId,
      reason,
      status: 'WAITING_FOR_SELLER_RESPONSE',
      dispute_state: 'REQUIRED_ACTION',
      disputed_transactions: [
        {
          seller_transaction_id: PP_CAPTURE_ID,
          item_id: 'NW-001',
          item_quantity: '1',
          item_title: 'Ridgeline Trail Shoes',
        },
      ],
      ...(id === 'agent-fault'
        ? {
            // The buyer's complaint, in the field the Disputes API has no slot for: which attribute
            // was wrong. `disputedItemOf` cannot read attributes from the API today, so the demo
            // supplies the one the buyer stated — see this file's header.
            buyer_complaint: 'Ordered size 10; the agent checked out a size 9.',
          }
        : {}),
      messages: [],
      evidences: [],
    },
    created_at: at(openedSec),
    updated_at: at(nowSec),
    fetched_at: at(nowSec),
  } as unknown as DisputeRow

  const rows = {
    orders: [
      {
        id: ORDER_ID,
        attempt_id: ATTEMPT_ID,
        paypal_order_id: PP_ORDER_ID,
        intent: 'AUTHORIZE',
        custom_id: customId,
        invoice_id: `cs:${ATTEMPT_ID}`,
        status: 'CAPTURED',
        amount_minor: AMOUNT_MINOR,
        currency: CURRENCY,
        raw: {},
        created_at: at(openedSec),
        updated_at: at(openedSec + 3_600),
        fetched_at: at(nowSec),
      } as unknown as OrderRow,
    ],
    attempts: [
      {
        id: ATTEMPT_ID,
        mandate_id: MANDATE_ID,
        agent_id: AGENT_ID,
        checkout_session_id: SESSION_ID,
        l3a: BUNDLE.l3a,
        l3b: BUNDLE.l3b,
        state: 'CAPTURED',
      } as unknown as CheckoutAttemptRow,
    ],
    checkoutSessions: [
      {
        id: SESSION_ID,
        merchant_id: MERCHANT_PAYPAL_ID,
        cart: { lines: [{ sku: 'NW-001', qty: 1, unit_minor: 12_800 }] },
        subtotal_minor: 12_800,
        tax_minor: 0,
        shipping_minor: 0,
        total_minor: 12_800,
        currency: CURRENCY,
        checkout_jwt: BUNDLE.checkout_jwt,
        checkout_hash: 'd'.repeat(43),
      } as unknown as CheckoutSessionRow,
    ],
    captures: [
      {
        id: CAPTURE_ID,
        order_id: ORDER_ID,
        paypal_capture_id: PP_CAPTURE_ID,
        amount_minor: AMOUNT_MINOR,
        currency: CURRENCY,
        final_capture: true,
        status: 'COMPLETED',
        shipment_id: SHIPMENT_ID,
        refunded_minor: 0n,
        reversed: false,
        created_at: at(openedSec + 3_600),
        updated_at: at(openedSec + 3_600),
        fetched_at: at(nowSec),
      } as unknown as CaptureRow,
    ],
    shipments: [
      {
        id: SHIPMENT_ID,
        order_id: ORDER_ID,
        lines: [{ sku: 'NW-001', qty: 1 }],
        carrier: 'DHL',
        tracking_number: 'JD0002000031',
        paypal_tracker_id: 'TRACKER-DEMO0000000000000001',
        status: 'DELIVERED',
        created_at: at(openedSec + 7_200),
        updated_at: at(openedSec + 86_400),
        fetched_at: at(nowSec),
      } as unknown as ShipmentRow,
    ],
    mandates: [
      {
        id: MANDATE_ID,
        user_id: USER_ID,
        device_id: DEVICE_ID,
        agent_id: AGENT_ID,
        wallet_id: WALLET_ID,
        l2_serialized: BUNDLE.l2,
        l2_payload: {},
        nl_intent: NL_INTENT,
        readback: READBACK,
        constraints: { preferences: { size: '10' } },
        nonce: 'n-demo',
        aud: MERCHANT_PAYPAL_ID,
        iat: BigInt(nowSec - 3 * 86_400),
        exp: BigInt(nowSec + 7 * 86_400),
        status: 'ACTIVE',
        webauthn_assertion: { id: 'cred-demo' },
        compiler_model: 'deterministic-parser',
        created_at: at(nowSec - 3 * 86_400),
        updated_at: at(nowSec - 3 * 86_400),
      } as unknown as MandateRow,
    ],
    gateDecisions: [
      {
        id: 'gdc_0000000000000000000000de',
        attempt_id: ATTEMPT_ID,
        decision: 'ALLOW',
        reasons: [],
        checks: [],
        chain_valid: true,
        vi_lib_commit: BUNDLE.vi_lib_commit,
        signed_record: BUNDLE.gate_decision,
        decided_at: at(openedSec + 3_540),
        created_at: at(openedSec + 3_540),
        updated_at: at(openedSec + 3_540),
      } as unknown as GateDecisionRow,
    ],
    devices: [
      {
        id: DEVICE_ID,
        user_id: USER_ID,
        public_jwk: { kty: 'EC', crv: 'P-256', x: 'demo', y: 'demo' },
        jkt: DEVICE_JKT,
        label: "Asha's laptop",
        status: 'ACTIVE',
        created_at: at(nowSec - 30 * 86_400),
        updated_at: at(nowSec - 30 * 86_400),
      } as unknown as DeviceRow,
    ],
    audit: [] as AuditLogRow[],
    disputes: [disputeRow],
    bundles: { [ORDER_ID]: bundle },
    corpora: { [ORDER_ID]: { fulfilmentDocument: true, receiptCopy: true } },
    policies: { [MERCHANT_PAYPAL_ID]: {} },
    l1Credentials: { [`${DEVICE_ID}:${WALLET_ID}`]: { sdJwt: BUNDLE.l1! } },
  }

  return {
    world: createInMemoryDefenderWorld(rows),
    disputeId: derivedDisputeId(paypalDisputeId),
    dueSec,
    openedSec,
    bundle,
    customId,
  }
}

/** The DefenderDeps for a demo run: the store is real, PayPal is a stub that refuses loudly. */
function demoDeps(world: CaseWorld['world'], publicBaseUrl: string, nowSec: number) {
  const never = (name: string) => () => {
    throw new Error(`The demo never calls PayPal.${name} — no dispute is filed from this page.`)
  }
  return {
    clock: { nowSec: () => nowSec, nowMs: () => nowSec * 1000 } satisfies Clock,
    store: world.store,
    paypal: {
      provideEvidence: never('provideEvidence'),
      appeal: never('appeal'),
      acceptClaim: never('acceptClaim'),
      makeOffer: never('makeOffer'),
      sendMessage: never('sendMessage'),
      acknowledgeReturnItem: never('acknowledgeReturnItem'),
      provideSupportingInfo: never('provideSupportingInfo'),
      escalate: never('escalate'),
      getDispute: never('getDispute'),
    },
    refunds: {
      refund: never('refund'),
    },
    publicBaseUrl,
    artefacts: {
      readback: READBACK,
      l1: BUNDLE.l1,
      l2: BUNDLE.l2,
      l3a: BUNDLE.l3a,
      l3b: BUNDLE.l3b,
      checkoutJwt: BUNDLE.checkout_jwt,
      gateDecision: BUNDLE.gate_decision,
      deviceJkt: DEVICE_JKT,
      agentKid: AGENT_ID,
      viLibCommit: BUNDLE.vi_lib_commit,
      payerEmail: 'asha.rane@example.com',
      payerId: 'DEMOBUYER0000001',
      payerCountry: 'US',
      payerCity: 'Bengaluru',
    },
  }
}

/* ------------------------------------------------------------------------------------------ */
/* The pipeline                                                                                */
/* ------------------------------------------------------------------------------------------ */

/**
 * One rendered case.
 *
 * Not a plain `{ view, pdf, ... }` record: the object is cached (see below) and the page, the download
 * route and the verifier all read the *same* instance, so the draft and the digest the QR verifies are
 * one object rather than two computations that could disagree.
 */
interface RenderedCase {
  readonly view: DefenderCaseView
  readonly pdf?: Uint8Array
  /** The packet id this case rendered, and the exact bundle + dispute row the verifier re-checks. */
  readonly packetId: string
  readonly bundle: EvidenceBundle
  readonly disputeRow: DisputeRow
}

/**
 * How long a rendered case may be served before it is recomputed, in seconds.
 *
 * A render bakes the clock into three places: the response-due date on the page, the `filed_at`/`created_at`
 * on the packet row, and the bytes of the PDF itself (and therefore its digest). A process that rendered once
 * and cached forever would show a response-due date from the day it booted, and a digest of a PDF that no
 * longer matches what it would print now - the exact defect in `docs/PROD_AUDIT.md` §8.2.
 *
 * One hour is long enough that the page and the download route still agree - they must, because the QR
 * verifies the digest the page printed - and short enough that a week-long process does not serve last
 * week's dates. When a case is stale it is recomputed, and a reader never sees a mixed pair.
 */
const CACHE_TTL_SEC = 60 * 60

interface CacheEntry {
  /** When this entry was rendered, in the same clock the view's dates come from. */
  readonly atSec: number
  readonly rendered: RenderedCase
}

const cache = new Map<DefenderCaseId, CacheEntry>()

/**
 * One render per case at a time.
 *
 * Two readers arriving together - the page and a judge's QR scan - share the work instead of each running
 * the pipeline (and, when a model is configured, each calling the provider). It also means a provider that
 * hangs is awaited once, not once per request.
 */
const inflight = new Map<DefenderCaseId, Promise<RenderedCase>>()

/** The live entry for a case, or `null` when it is absent or older than {@link CACHE_TTL_SEC}. */
function cachedCase(id: DefenderCaseId, nowSec: number): RenderedCase | null {
  const entry = cache.get(id)
  if (entry === undefined) return null
  if (nowSec - entry.atSec >= CACHE_TTL_SEC) {
    // Dropped rather than refreshed in place: a reader holding the old object must not be able to keep
    // serving it, and the next caller recomputes.
    cache.delete(id)
    return null
  }
  return entry.rendered
}

/**
 * The packet font, read from the defender package's assets.
 *
 * `renderPacketPdf` defaults to reading its own `import.meta.url`-relative font path, which Turbopack
 * rewrites when it bundles the package into the app server — the read then fails with a URL-shaped
 * `path` error. `RenderDeps.fontBytes` is the designed injection point for exactly this, so the demo
 * resolves the file itself. Development runs with `apps/web` as the working directory; a couple of
 * candidates cover root and filter runs. No candidate is found → the page says so, loudly.
 */
function packetFontBytes(): Uint8Array {
  const candidates = [
    '../../packages/defender/assets/fonts/Roboto-Regular.ttf',
    '../packages/defender/assets/fonts/Roboto-Regular.ttf',
    'packages/defender/assets/fonts/Roboto-Regular.ttf',
  ]
  for (const relative of candidates) {
    try {
      return new Uint8Array(
        readFileSync(new URL(`file://${resolve(process.cwd(), relative).replaceAll('\\', '/')}`)),
      )
    } catch {
      // try the next candidate
    }
  }
  throw new Error(
    `Roboto-Regular.ttf was not found next to the web app (tried ${candidates.join('; ')} from ${process.cwd()})`,
  )
}

/**
 * How long one model call for a dispute note may take, in milliseconds.
 *
 * §8.6: `/disputes` is a server-rendered page, and a provider that accepts the connection and then never
 * answers would hold the request open until the platform's own timeout - which reads as a broken app rather
 * than a slow model. `draft()` already treats any error from the port as `LLM_UNAVAILABLE` and falls back to
 * the deterministic template (EC-LLM-1), so a deadline here costs the page the wait and nothing else: the
 * reader still gets a packet, and the transcript says which author wrote the note.
 *
 * 15 s per call, and the drafter makes at most two (one repair turn), so the worst case before the template
 * takes over is bounded at twice this.
 */
export const DEFENDER_DRAFT_TIMEOUT_MS = 15_000

/**
 * The adapter from the AI SDK's model to the port `draft()` asks for.
 *
 * Exported, with the deadline as a defaulted parameter, so a test can drive a model that never answers and
 * assert the request was **aborted** rather than merely hoped about. "We pass an AbortSignal" is not evidence
 * that the provider honours it; a test that watches the promise settle is.
 */
export function defenderDraftPort(
  model: AiLanguageModel,
  timeoutMs: number = DEFENDER_DRAFT_TIMEOUT_MS,
): DrafterModel {
  return {
    generateText: async (request) => {
      const out = await generateText({
        model,
        system: request.system,
        prompt: request.prompt,
        // A fresh signal per attempt: the repair turn is a second call and gets the whole budget, not
        // whatever is left of the first one's.
        abortSignal: AbortSignal.timeout(timeoutMs),
      })
      return { text: out.text }
    },
  }
}

/**
 * Compute the whole pipeline for one case, or return the cached render while it is fresh.
 *
 * Exported for the PDF route; the page uses `demoCases`. The clock is read **before** the cache check,
 * because freshness is a question about now.
 */
export async function renderDefenderCase(
  id: DefenderCaseId,
  publicBaseUrl: string,
): Promise<RenderedCase> {
  const nowSec = systemClock.nowSec()
  const cached = cachedCase(id, nowSec)
  if (cached !== null) return cached

  const running = inflight.get(id)
  if (running !== undefined) return running

  const pending = renderUncached(id, publicBaseUrl, nowSec).finally(() => {
    inflight.delete(id)
  })
  inflight.set(id, pending)
  return pending
}

/** The pipeline itself. Called through {@link renderDefenderCase}, which owns the clock and the cache. */
async function renderUncached(
  id: DefenderCaseId,
  publicBaseUrl: string,
  nowSec: number,
): Promise<RenderedCase> {
  const world = caseWorld(id, nowSec)
  const deps = demoDeps(world.world, publicBaseUrl, nowSec)
  const row = world.world.rows.disputes.get(world.disputeId)
  if (row === undefined) throw new Error(`demo dispute ${world.disputeId} is not in the world`)

  const ctxResult = await buildDisputeContext(row, undefined, deps)
  if (!ctxResult.ok)
    throw new Error(`buildDisputeContext: ${ctxResult.error.code} ${ctxResult.error.message}`)
  const ctx = { ...ctxResult.value }

  // The agent-fault override: see this file's header. Everything else in the context is what the
  // real ingest produced from the fixture rows.
  if (id === 'agent-fault') {
    ;(ctx as { disputedItem?: { sku: string; attributes: Record<string, string> } }).disputedItem =
      {
        sku: 'NW-001',
        attributes: { size: '9' },
      }
  }

  const decision: LiabilityDecision = route(ctx)
  const plan = planEvidence(ctx, decision)

  const base = {
    id,
    title: id === 'unauthorised' ? '“I didn’t authorise this”' : '“This isn’t what I asked for”',
    dispute: {
      paypalDisputeId: row.paypal_dispute_id,
      reason: row.reason,
      stage: row.stage,
      status: row.status,
      amount: formatMoney(money(AMOUNT_MINOR, CURRENCY)),
      opened: new Date(world.openedSec * 1000).toISOString(),
      responseDue: new Date(world.dueSec * 1000).toISOString(),
    },
  }

  if (decision.posture !== 'CONTEST') {
    // A posture that files nothing never reaches the model (§8.15). The recommendation is the answer.
    const view: DefenderCaseView = {
      ...base,
      rule: decisionView(decision),
      plan: plan.items.map((item) => ({ evidenceType: item.evidenceType, note: item.notes })),
      draft: null,
      pdf: null,
      buyerMessage: buyerSentence(decision),
      notes: [
        'No evidence packet is drafted: nothing is filed against a refund. The model is never asked to argue against our own finding (§8.15).',
      ],
    }
    const out: RenderedCase = {
      view,
      packetId: fixturePacketId('AGNTFXT01'),
      bundle: world.bundle,
      disputeRow: row,
    }
    cache.set(id, { atSec: nowSec, rendered: out })
    return out
  }

  // CONTEST: plan → draft (model, then the deterministic template if no provider) → packet PDF.
  const packetId =
    id === 'unauthorised' ? fixturePacketId('F1RSTCASE1') : fixturePacketId('AGNTFXT01')
  const claims = claimSourcesFor(ctx, decision)
  const draftInput = {
    ctx,
    decision,
    plan,
    packetId,
    publicBaseUrl,
    claims,
  }

  let result: Draft | null = null
  const llm = languageModel()
  if (llm.ok) {
    const attempt = await draft(draftInput, {
      llm: defenderDraftPort(llm.value),
      onLog: (line) => console.info(`[defender-demo/drafter] ${line}`),
    })
    if (attempt.ok) {
      result = attempt.value
    } else {
      console.warn(
        `[defender-demo] the model draft did not pass: ${attempt.error.code} ${attempt.error.message.slice(0, 200)} — using the deterministic template (EC-LLM-1)`,
      )
    }
  } else {
    console.warn(
      '[defender-demo] no model provider configured — using the deterministic template (EC-LLM-1)',
    )
  }

  let finalDraft: Draft
  if (result !== null) {
    finalDraft = result
  } else {
    // EC-LLM-1: the deterministic template is the fallback, and it passes the same checker.
    const url = publicPacketUrl(publicBaseUrl, packetId)
    const template = templateNote(draftInput, claims, url)
    const verdict = checkCitations({ notes: template }, claims, { allowedUrl: url })
    if (!verdict.ok) {
      throw new Error(
        `even the template failed the citation checker: ${JSON.stringify(verdict.problems?.[0] ?? {})}`,
      )
    }
    finalDraft = {
      notes: plainNotes(template),
      citations: verdict.citations,
      source: 'template',
      verdict,
      modelCalls: 0,
    }
  }
  const { notes, source, citations } = finalDraft

  // The bundle is the case world's one bundle object: the PDF inventories it, and the verifier page
  // re-hashes exactly the same bytes — one object, one digest.
  const bundle = world.bundle

  const view: PacketView = {
    packetId,
    disputeId: world.disputeId,
    paypalDisputeId: row.paypal_dispute_id,
    version: 1,
    decision,
    draft: finalDraft,
    facts: decision.facts,
    claims,
    bundle: bundle as unknown as Readonly<Record<string, unknown>>,
    readback: READBACK,
    chain: {
      l1: BUNDLE.l1,
      l2: BUNDLE.l2,
      l3a: BUNDLE.l3a,
      l3b: BUNDLE.l3b,
      checkoutJwt: BUNDLE.checkout_jwt,
      gateDecision: BUNDLE.gate_decision,
      deviceJkt: DEVICE_JKT,
      agentKid: AGENT_ID,
      viLibCommit: BUNDLE.vi_lib_commit,
    },
    publicBaseUrl,
    payerEmail: 'asha.rane@example.com',
    payerId: 'DEMOBUYER0000001',
    payerCountry: 'US',
    payerCity: 'Bengaluru',
  }

  const pdfResult = await renderPacketPdf(view, {
    clock: { nowSec: () => nowSec, nowMs: () => nowSec * 1000 },
    fontBytes: packetFontBytes(),
  })
  if (!pdfResult.ok)
    throw new Error(`renderPacketPdf: ${pdfResult.error.code} ${pdfResult.error.message}`)
  const pdf: RenderedPacket = pdfResult.value

  const out: RenderedCase = {
    view: {
      ...base,
      rule: decisionView(decision),
      plan: plan.items.map((item) => ({ evidenceType: item.evidenceType, note: item.notes })),
      draft: {
        source,
        notes,
        citations: citations.map((c) => ({
          claimId: c.claimId,
          sentence: c.sentence,
          artefact: {
            id: c.artefact.id,
            kind: c.artefact.kind,
            description: c.artefact.description,
          },
        })),
      },
      pdf: {
        packetId,
        sha256: pdf.sha256,
        byteLength: pdf.byteLength,
        pageCount: pdf.pageCount,
        qrPayload: pdf.qrPayload,
      },
      buyerMessage: null,
      notes: [
        `Drafted by ${source === 'template' ? 'the deterministic template (no model provider configured)' : `the configured model, then checked by the citation checker (${citations.length} sentences backed by records)`}.`,
      ],
    },
    pdf: pdf.bytes,
    packetId,
    bundle,
    disputeRow: row,
  }
  cache.set(id, { atSec: nowSec, rendered: out })
  return out
}

/**
 * The fixture rows `/v/[packetId]` verifies a demo packet against.
 *
 * The packet row and the dispute row come from the same rendered case the `/disputes` page showed —
 * same bundle, same digest — so what the QR verifies is what the PDF printed. `storedBundleHash` is
 * the hex digest the verifier's offline check compares against. The JWKS stay empty on purpose: the
 * fixture chain artefacts are not real signatures, and a real deployment would hold the Gate's key.
 */
export async function demoVerifierRows(packetId: string): Promise<{
  packet: Record<string, unknown>
  dispute: Record<string, unknown>
  bundle: EvidenceBundle
} | null> {
  const caseId = demoCaseForPacketId(packetId)
  if (caseId === null) return null
  const nowSec = systemClock.nowSec()
  // Rendering is idempotent and cached; awaiting it here guarantees the rows exist even when a judge
  // scans the QR before ever opening /disputes. The lookup goes through the same freshness rule as the
  // render, so a stale entry cannot be half-served: one clock reading, one entry.
  await renderDefenderCase(caseId, process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000')
  const rendered = cachedCase(caseId, systemClock.nowSec())
  if (rendered === null) return null
  const at = (sec: number) => new Date(sec * 1000)
  const bundleHash = bundleHashHex(rendered.bundle as unknown as Readonly<Record<string, unknown>>)
  return {
    packet: {
      id: rendered.packetId,
      dispute_id: rendered.disputeRow.id,
      version: 1,
      bundle: rendered.bundle,
      bundle_hash: bundleHash,
      pdf_sha256: rendered.view.pdf?.sha256 ?? null,
      notes: rendered.view.draft?.notes ?? null,
      citations: rendered.view.draft?.citations ?? null,
      filed_at: at(nowSec),
      paypal_response: null,
      created_at: at(nowSec),
      updated_at: at(nowSec),
    },
    dispute: rendered.disputeRow,
    bundle: rendered.bundle,
  }
}

function decisionView(decision: LiabilityDecision) {
  return {
    ruleId: decision.ruleId,
    liability: decision.liability,
    posture: decision.posture,
    action: decision.action,
    rationale: decision.rationale,
    reasons: decision.reasons,
    facts: decision.facts.map((f) => ({ key: f.key, value: String(f.value) })),
  }
}

/** The one sentence the buyer reads (§8.17's S-18 uses the same composer). */
function buyerSentence(decision: LiabilityDecision): string {
  if (decision.posture === 'REFUND')
    return 'We will refund you — the records show the mistake was ours to fix.'
  return decision.rationale
}

/** Both cases, page-ready. Cached per process, so the PDF route serves the same draft. */
export async function demoCases(publicBaseUrl: string): Promise<readonly DefenderCaseView[]> {
  const [a, b] = await Promise.all([
    renderDefenderCase('unauthorised', publicBaseUrl),
    renderDefenderCase('agent-fault', publicBaseUrl),
  ])
  return [a.view, b.view]
}

/** The cached PDF for one case, for the download route. */
export async function demoCasePdf(
  id: DefenderCaseId,
  publicBaseUrl: string,
): Promise<Uint8Array | null> {
  const rendered = await renderDefenderCase(id, publicBaseUrl)
  return rendered.pdf ?? null
}
