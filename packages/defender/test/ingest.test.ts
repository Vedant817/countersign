/**
 * Ingest and the row→context bridge — spec **§8.16 (M16)**, **§12.11**, **§7.2**, **§7.3**, decisions
 * **D-013**, **D-018**. Work package **WP-15e**.
 *
 * ```bash
 * pnpm --filter @countersign/defender test
 * ```
 *
 * ## What this file is for
 *
 * `filer.test.ts` proves *what gets filed*. This file proves **what the filer is given to decide with**,
 * because every one of the filer's guarantees is downstream of two facts:
 *
 * 1. **the join found our capture** (D-013), and
 * 2. **the context said `undefined` rather than `false` for anything we could not read** (EC-DSP-9, EC-BUY-3).
 *
 * Both were wrong at some point in this product's life — the join could never succeed against a real PayPal
 * response because `seller_transaction_id` lives in an array — and both failures look identical from the
 * outside: a Defender that answers "not a Countersign order" about everything and looks like it found
 * something. So both are pinned here, including the **negative** case that reproduces the original bug.
 *
 * ## What is faked, and what is not
 *
 * **No HTTP happens in this file at all.** `ingestDisputeToDefender` takes a *fetched* `Dispute` (§3.3: never
 * a webhook payload), so there is no `PayPalClient` here and no `fetchImpl` seam to inject. What is replaced is
 * the database, by `createInMemoryDefenderWorld`, which lives in `src/` for the reason its own doc comment
 * gives: EC-DSP-10's idempotency claims and the router's inputs are the claims under test, and neither needs
 * Postgres.
 *
 * ## EC coverage named here, so `pnpm test:ec` counts it
 *
 * EC-DSP-9 · EC-DSP-11 · EC-DSP-4 · EC-DSP-10 · EC-BUY-3 · EC-MER-2 · EC-MER-7 · EC-REF-1 · EC-REF-5.
 */

import { fixedClock, type Clock } from '@countersign/core'
import type {
  AuditLogRow,
  CaptureRow,
  CheckoutAttemptRow,
  CheckoutSessionRow,
  DeviceRow,
  DisputeActionRow,
  DisputeRow,
  EvidencePacketRow,
  GateDecisionRow,
  MandateRow,
  NewDisputeAction,
  NewEvidencePacket,
  OrderRow,
  RefundRow,
  ShipmentRow,
} from '@countersign/db'
import { DISPUTE_LIFE_CYCLE_STAGES, type Dispute } from '@countersign/paypal'
import { describe, expect, it } from 'vitest'

import {
  bundleHashFor,
  buyerWithdrew,
  createInMemoryDefenderWorld,
  customIdAgreement,
  derivedDisputeId,
  derivedPacketId,
  disputeStageFor,
  disputeStatusFor,
  ingestDisputeToDefender,
  joinDisputeToOrder,
  preferencesFrom,
  toJsonValue,
  type DefenderDeps,
  type DefenderWorldSeed,
  type EvidenceBundle,
  type IngestResult,
  type InMemoryDefenderWorld,
  type JoinOutcome,
} from '../src/ingest'
import { route } from '../src/router'

// ---------------------------------------------------------------------------
// One fixed instant (AGENTS.md rule 10)
// ---------------------------------------------------------------------------

const NOW_SEC = 1_789_000_000
const CLOCK: Clock = fixedClock(NOW_SEC)
const AT = new Date(NOW_SEC * 1000)
const DAY = 86_400

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const ORDER_ID = 'ord_00000000000000000000000001'
const ATTEMPT_ID = 'att_00000000000000000000000001'
const SESSION_ID = 'chk_00000000000000000000000001'
const CAPTURE_ID = 'cap_00000000000000000000000001'
const SHIPMENT_ID = 'shp_00000000000000000000000001'
const MANDATE_ID = 'mdt_00000000000000000000000001'
const DEVICE_ID = 'dev_00000000000000000000000001'
const GATE_ID = 'gdc_00000000000000000000000001'
const MERCHANT_ID = '9KX436DUC84BN'
const USER_ID = 'usr_00000000000000000000000001'
const WALLET_ID = 'wal_00000000000000000000000001'

const PAYPAL = {
  disputeId: 'PP-D-2781AB12CD34',
  captureId: '3C679366HH908993F',
  orderId: '5O190127TN364715T',
  refundId: '1JU08902781691411',
  trackerId: 'TRACKER-1Z999AA10123456784',
} as const

const CUSTOM_ID = `cs1:${'A'.repeat(43)}`
const READBACK =
  '**What you are authorising**\nOnly at **Northwind Outfitters**\nSpend at most **$130.00**'

function orderRow(over: Partial<OrderRow> = {}): OrderRow {
  return {
    id: ORDER_ID,
    attempt_id: ATTEMPT_ID,
    paypal_order_id: PAYPAL.orderId,
    intent: 'AUTHORIZE',
    custom_id: CUSTOM_ID,
    invoice_id: 'INV-NW-000042',
    status: 'CAPTURED',
    amount_minor: 12_999n,
    currency: 'USD',
    raw: {},
    created_at: AT,
    updated_at: AT,
    fetched_at: AT,
    ...over,
  } as unknown as OrderRow
}

function attemptRow(over: Partial<CheckoutAttemptRow> = {}): CheckoutAttemptRow {
  return {
    id: ATTEMPT_ID,
    mandate_id: MANDATE_ID,
    agent_id: 'agt_00000000000000000000000001',
    checkout_session_id: SESSION_ID,
    l3a: 'l3a.eyJhbGciOiJFUzI1NiJ9.abc',
    l3b: 'l3b.eyJhbGciOiJFUzI1NiJ9.def',
    state: 'CAPTURED',
    ...over,
  } as unknown as CheckoutAttemptRow
}

function sessionRow(over: Partial<CheckoutSessionRow> = {}): CheckoutSessionRow {
  return {
    id: SESSION_ID,
    merchant_id: MERCHANT_ID,
    cart: { lines: [{ sku: 'SKU-TRAIL-42', qty: 1, unit_minor: 12_999 }] },
    subtotal_minor: 12_999,
    tax_minor: 0,
    shipping_minor: 0,
    total_minor: 12_999,
    currency: 'USD',
    checkout_jwt: 'co.eyJhbGciOiJFUzI1NiJ9.ghi',
    checkout_hash: 'c'.repeat(43),
    ...over,
  } as unknown as CheckoutSessionRow
}

function captureRow(over: Partial<CaptureRow> = {}): CaptureRow {
  return {
    id: CAPTURE_ID,
    order_id: ORDER_ID,
    paypal_capture_id: PAYPAL.captureId,
    amount_minor: 12_999n,
    currency: 'USD',
    final_capture: true,
    status: 'COMPLETED',
    shipment_id: SHIPMENT_ID,
    refunded_minor: 0n,
    reversed: false,
    created_at: AT,
    updated_at: AT,
    fetched_at: AT,
    ...over,
  } as unknown as CaptureRow
}

function refundRow(over: Partial<RefundRow> = {}): RefundRow {
  return {
    id: 'ref_00000000000000000000000001',
    capture_id: CAPTURE_ID,
    paypal_refund_id: PAYPAL.refundId,
    amount_minor: 12_999n,
    currency: 'USD',
    status: 'COMPLETED',
    reason_code: 'MERCHANT_REQUEST',
    initiated_by: 'MERCHANT',
    created_at: AT,
    updated_at: AT,
    fetched_at: AT,
    ...over,
  } as unknown as RefundRow
}

function shipmentRow(over: Partial<ShipmentRow> = {}): ShipmentRow {
  return {
    id: SHIPMENT_ID,
    order_id: ORDER_ID,
    lines: [{ sku: 'SKU-TRAIL-42', qty: 1 }],
    carrier: 'DHL',
    tracking_number: 'JD0002000031',
    paypal_tracker_id: PAYPAL.trackerId,
    status: 'DELIVERED',
    created_at: AT,
    updated_at: AT,
    fetched_at: AT,
    ...over,
  } as unknown as ShipmentRow
}

function mandateRow(over: Partial<MandateRow> = {}): MandateRow {
  return {
    id: MANDATE_ID,
    user_id: USER_ID,
    device_id: DEVICE_ID,
    agent_id: 'agt_00000000000000000000000001',
    wallet_id: WALLET_ID,
    l2_serialized: 'l2.eyJhbGciOiJFUzI1NiJ9.jkl',
    l2_payload: {},
    nl_intent: 'Order me trail running shoes, size 10, under $130.',
    readback: READBACK,
    constraints: { preferences: { size: '10' } },
    nonce: 'n-1',
    aud: MERCHANT_ID,
    iat: BigInt(NOW_SEC - DAY),
    exp: BigInt(NOW_SEC + 7 * DAY),
    status: 'ACTIVE',
    webauthn_assertion: { id: 'cred-1' },
    compiler_model: 'gpt-6.1-sol',
    created_at: AT,
    updated_at: AT,
    ...over,
  } as unknown as MandateRow
}

function gateRow(over: Partial<GateDecisionRow> = {}): GateDecisionRow {
  return {
    id: GATE_ID,
    attempt_id: ATTEMPT_ID,
    decision: 'ALLOW',
    reasons: [],
    checks: [],
    chain_valid: true,
    vi_lib_commit: '356c29635f1c44df7de02edb58699ca9f29bece6',
    signed_record: 'gd.eyJhbGciOiJFUzI1NiJ9.mno',
    decided_at: AT,
    created_at: AT,
    updated_at: AT,
    ...over,
  } as unknown as GateDecisionRow
}

function deviceRow(over: Partial<DeviceRow> = {}): DeviceRow {
  return {
    id: DEVICE_ID,
    user_id: USER_ID,
    public_jwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
    jkt: 'k1J9d_8sPq7A',
    label: "Asha's laptop",
    status: 'ACTIVE',
    created_at: AT,
    updated_at: AT,
    ...over,
  } as unknown as DeviceRow
}

/** One `DEVICE_REPORTED_LOST` audit entry — the only place a "lost at" instant exists (§18 question 8). */
function auditLost(atSec: number, subject = DEVICE_ID): AuditLogRow {
  return {
    id: `aud_${String(atSec)}`,
    actor: 'USER',
    action: 'DEVICE_REPORTED_LOST',
    subject,
    chain_id: `chain_${DEVICE_ID}`,
    at: new Date(atSec * 1000),
    ip_hash: null,
    details: {},
    prev_hash: null,
    this_hash: 'h'.repeat(64),
    created_at: AT,
    updated_at: AT,
  } as unknown as AuditLogRow
}

const BUNDLE: EvidenceBundle = {
  v: 'cs1',
  l1: 'l1.eyJhbGciOiJFUzI1NiJ9.pqr',
  l2: 'l2.eyJhbGciOiJFUzI1NiJ9.jkl',
  l3a: 'l3a.eyJhbGciOiJFUzI1NiJ9.abc',
  l3b: 'l3b.eyJhbGciOiJFUzI1NiJ9.def',
  checkout_jwt: 'co.eyJhbGciOiJFUzI1NiJ9.ghi',
  gate_decision: 'gd.eyJhbGciOiJFUzI1NiJ9.mno',
  webauthn: { present: true, at: NOW_SEC - DAY },
  vi_lib_commit: '356c29635f1c44df7de02edb58699ca9f29bece6',
  paypal: {
    order_id: PAYPAL.orderId,
    capture_ids: [PAYPAL.captureId],
    custom_id: CUSTOM_ID,
  },
  shipments: [
    { carrier: 'DHL', tracking: 'JD0002000031', lines: [{ sku: 'SKU-TRAIL-42', qty: 1 }] },
  ],
}

function baseSeed(over: Partial<DefenderWorldSeed> = {}): DefenderWorldSeed {
  return {
    orders: [orderRow()],
    attempts: [attemptRow()],
    captures: [captureRow()],
    refunds: [],
    shipments: [shipmentRow()],
    mandates: [mandateRow()],
    checkoutSessions: [sessionRow()],
    gateDecisions: [gateRow()],
    devices: [deviceRow()],
    audit: [],
    bundles: { [ORDER_ID]: BUNDLE },
    corpora: { [ORDER_ID]: { fulfilmentDocument: true, receiptCopy: true } },
    policies: { [MERCHANT_ID]: {} },
    l1Credentials: { [`${DEVICE_ID}:${WALLET_ID}`]: { sdJwt: 'l1.eyJhbGciOiJFUzI1NiJ9.pqr' } },
    ...over,
  }
}

// ---------------------------------------------------------------------------
// deps
// ---------------------------------------------------------------------------

interface Harness {
  readonly world: InMemoryDefenderWorld
  readonly deps: DefenderDeps
}

function harness(seed: DefenderWorldSeed = baseSeed()): Harness {
  const world = createInMemoryDefenderWorld(seed)
  // The PayPal and refund ports are **not** reached by anything in this file — ingest and the context builder
  // make no HTTP call and move no money. They are stubbed with functions that throw rather than with silent
  // no-ops, so a future edit that starts calling one fails loudly instead of passing a test.
  const unreachable = (name: string) => (): never => {
    throw new Error(`ingest must not call ${name}`)
  }
  const deps = {
    clock: CLOCK,
    store: world.store,
    paypal: {
      provideEvidence: unreachable('paypal.provideEvidence'),
      appeal: unreachable('paypal.appeal'),
      acceptClaim: unreachable('paypal.acceptClaim'),
      makeOffer: unreachable('paypal.makeOffer'),
      sendMessage: unreachable('paypal.sendMessage'),
      acknowledgeReturnItem: unreachable('paypal.acknowledgeReturnItem'),
      provideSupportingInfo: unreachable('paypal.provideSupportingInfo'),
      escalate: unreachable('paypal.escalate'),
      getDispute: unreachable('paypal.getDispute'),
    },
    refunds: { refund: unreachable('refunds.refund') },
    publicBaseUrl: 'https://countersign.example',
  } as unknown as DefenderDeps
  return { world, deps }
}

function expectOk<T>(r: {
  ok: boolean
  value?: unknown
  error?: { code?: string; message?: string }
}): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error?.code}: ${r.error?.message}`)
  return r.value as T
}

/**
 * `expectOk<IngestResult>(…)` in one call.
 *
 * The generic is spelled out at every call site rather than inferred, because `Result<T, CsError>` narrows to
 * `never` after the `ok` check — so an inferred `T` on a narrowed value is a compile error, not a convenience.
 */
function ingested(r: Parameters<typeof expectOk>[0]): IngestResult {
  return expectOk<IngestResult>(r)
}

function joined(r: Parameters<typeof expectOk>[0]): JoinOutcome {
  return expectOk<JoinOutcome>(r)
}

/**
 * A fetched `Dispute`, shaped like `packages/paypal/test/fixtures/transport-double.ts`'s.
 *
 * `disputed_transactions` is where the join key lives, and it is an **array** — see the D-013 section below
 * for the test that pins why that matters.
 */
function paypalDispute(over: Partial<Dispute> = {}): Dispute {
  return {
    dispute_id: PAYPAL.disputeId,
    dispute_state: 'REQUIRED_ACTION',
    status: 'WAITING_FOR_SELLER_RESPONSE',
    dispute_life_cycle_stage: 'CHARGEBACK',
    reason: 'UNAUTHORISED',
    disputed_transactions: [{ seller_transaction_id: PAYPAL.captureId }],
    dispute_amount: { currency_code: 'USD', value: '129.99' },
    dispute_currency: 'USD',
    seller_response_due_date: '2026-10-09T18:29:59Z',
    buyer_response_due_date: '2026-10-16T18:29:59Z',
    update_time: '2026-10-04T12:00:00Z',
    links: [
      {
        href: 'https://api-m.sandbox.paypal.com/v1/customer/disputes/x',
        rel: 'self',
        method: 'GET',
      },
    ],
    ...over,
  } as unknown as Dispute
}

/** Every disputed dispute, or the one under test by its derived id. */
function disputeRow(h: Harness): DisputeRow {
  const row = [...h.world.rows.disputes.values()][0]
  if (row === undefined) throw new Error('no dispute row was written')
  return row
}

// ---------------------------------------------------------------------------
// 1. D-013: the join
// ---------------------------------------------------------------------------

describe('D-013: the join reads disputed_transactions[0].seller_transaction_id, and has three answers', () => {
  it('LINKED: our capture id resolves to our capture row and our order', async () => {
    const h = harness()
    const join = joined(await joinDisputeToOrder(paypalDispute(), h.deps))
    expect(join.kind).toBe('LINKED')
    if (join.kind !== 'LINKED') throw new Error('expected LINKED')
    expect(join.orderId).toBe(ORDER_ID)
    expect(join.captureId).toBe(CAPTURE_ID)
    expect(join.paypalCaptureId).toBe(PAYPAL.captureId)

    // **And the ingest writes the link onto the row**, because a joined-but-unlinked row is R-NOCHAIN-1.
    const result = ingested(await ingestDisputeToDefender(paypalDispute(), h.deps))
    expect(result.linked).toBe(true)
    expect(result.join.kind).toBe('LINKED')
    expect(result.warnings).toEqual([])
    const row = disputeRow(h)
    expect(row.order_id).toBe(ORDER_ID)
    expect(row.capture_id).toBe(CAPTURE_ID)
    expect(row.stage).toBe('CHARGEBACK')
    expect(row.status).toBe('WAITING_FOR_SELLER_RESPONSE')
    // §0 rule 10: epoch seconds in the context, a real `timestamptz` on the row.
    expect(row.amount_minor).toBe(12_999n)
    expect(row.seller_response_due_date?.toISOString()).toBe('2026-10-09T18:29:59.000Z')
  })

  it('NOT_A_COUNTERSIGN_PAYMENT: PayPal named a capture we have no row for, and the row is still written', async () => {
    const h = harness()
    const foreign = paypalDispute({
      disputed_transactions: [{ seller_transaction_id: '9XX99999XX99999X' }],
    })
    const result = ingested(await ingestDisputeToDefender(foreign, h.deps))

    // **Not a crash.** EC-DSP-9 needs a stored row and a sentence, and §18 question 20 depends on both.
    expect(result.linked).toBe(false)
    if (result.join.kind !== 'NOT_A_COUNTERSIGN_PAYMENT')
      throw new Error('expected NOT_A_COUNTERSIGN_PAYMENT')
    expect(result.join.code).toBe('PP_NOT_FOUND')
    expect(result.join.paypalCaptureId).toBe('9XX99999XX99999X')
    expect(result.warnings.join(' ')).toContain('9XX99999XX99999X')

    const row = disputeRow(h)
    expect(row.paypal_dispute_id).toBe(PAYPAL.disputeId)
    expect(row.order_id).toBeNull()
    expect(row.capture_id).toBeNull()

    // **And the router answers with a sentence rather than an exception** — the whole point of the branch.
    const decision = route(result.context)
    expect(decision.ruleId).toBe('R-NOCHAIN-1')
    expect(decision.posture).toBe('REVIEW')
    expect(decision.rationale).toContain('R-NOCHAIN-1')
  })

  it('NO_CAPTURE_ON_DISPUTE: PayPal named no transaction at all, and the row is still written', async () => {
    const h = harness()
    const result = ingested(
      await ingestDisputeToDefender(paypalDispute({ disputed_transactions: undefined }), h.deps),
    )
    expect(result.linked).toBe(false)
    expect(result.join.kind).toBe('NO_CAPTURE_ON_DISPUTE')
    expect(result.warnings.join(' ')).toContain('no disputed_transactions')
    expect(disputeRow(h).capture_id).toBeNull()
    expect(route(result.context).ruleId).toBe('R-NOCHAIN-1')
  })

  it('the original bug, pinned as a negative: a TOP-LEVEL seller_transaction_id does not join', async () => {
    /**
     * **This is the regression test for the defect that made the Defender useless.**
     *
     * `seller_transaction_id` is **not** a top-level property of a PayPal dispute — it lives in the
     * `disputed_transactions[]` array (`SPEC-D` `$ref transaction_info_list`). The first version of this package
     * read it from the top level, which can never succeed against a real response, so the join returned
     * `undefined` for every dispute and every case fell through to R-NOCHAIN-1. A Defender that always answers
     * "not a Countersign order" is worse than no Defender, because it looks like a finding.
     *
     * So: a dispute carrying the id **only** at the top level must **not** link. If someone re-introduces the
     * top-level read to "be tolerant", this fails — and the tolerance would be the bug.
     */
    const h = harness()
    const wrongShape = {
      dispute_id: PAYPAL.disputeId,
      seller_transaction_id: PAYPAL.captureId,
      dispute_life_cycle_stage: 'CHARGEBACK',
      status: 'WAITING_FOR_SELLER_RESPONSE',
    } as unknown as Dispute

    const result = ingested(await ingestDisputeToDefender(wrongShape, h.deps))
    expect(result.join.kind).toBe('NO_CAPTURE_ON_DISPUTE')
    expect(result.linked).toBe(false)
    expect(disputeRow(h).capture_id).toBeNull()
  })

  it('the first non-empty seller_transaction_id wins, because PayPal sends an array', async () => {
    const h = harness()
    const join = joined(
      await joinDisputeToOrder(
        paypalDispute({
          disputed_transactions: [
            { seller_transaction_id: '' },
            { seller_transaction_id: PAYPAL.captureId },
          ],
        }),
        h.deps,
      ),
    )
    expect(join.kind).toBe('LINKED')
  })
})

// ---------------------------------------------------------------------------
// 2. Ingest: validate, rank, store
// ---------------------------------------------------------------------------

describe('ingest validates and ranks before it writes anything', () => {
  it('a dispute with no dispute_id is CS_VALIDATION and nothing is written', async () => {
    const h = harness()
    const r = await ingestDisputeToDefender({} as Dispute, h.deps)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected err')
    expect(r.error.code).toBe('CS_VALIDATION')
    expect(h.world.rows.disputes.size).toBe(0)
  })

  it('disputeStageFor fails closed on a stage PayPal has not used yet', () => {
    // **Every documented stage passes through unchanged.** The table is the same one `DISPUTE_LIFE_CYCLE_STAGES`
    // holds, so a new PayPal stage cannot be stored without a schema change.
    for (const stage of DISPUTE_LIFE_CYCLE_STAGES) {
      expect(disputeStageFor(stage)).toEqual({ ok: true, value: stage })
    }
    // **Absent is `INQUIRY`**, which is a fact about a newly created dispute rather than a guess.
    expect(disputeStageFor(undefined)).toEqual({ ok: true, value: 'INQUIRY' })
    // **An unknown stage is refused rather than guessed.** `?? 'INQUIRY'` would hide a chargeback as an
    // inquiry; `as DisputeStage` is what `packages/webhooks/src/jobs.ts:699` does, and it fails inside Postgres
    // with `22P02` after the row is already open.
    const unknown = disputeStageFor('ARBITRATION_2027')
    expect(unknown.ok).toBe(false)
    if (unknown.ok) throw new Error('expected err')
    expect(unknown.error.code).toBe('CS_VALIDATION')
    expect(unknown.error.message).toContain('ARBITRATION_2027')
    expect(unknown.error.userMessage).toBeDefined()
  })

  it('an unrankable stage aborts the ingest before any row exists', async () => {
    const h = harness()
    const r = await ingestDisputeToDefender(
      paypalDispute({ dispute_life_cycle_stage: 'ARBITRATION_2027' as never }),
      h.deps,
    )
    expect(r.ok).toBe(false)
    expect(h.world.rows.disputes.size).toBe(0)
  })

  it('disputeStatusFor folds everything unrecognised to OTHER, and OTHER is the closed end', () => {
    for (const status of [
      'OPEN',
      'WAITING_FOR_BUYER_RESPONSE',
      'WAITING_FOR_SELLER_RESPONSE',
      'UNDER_REVIEW',
      'RESOLVED',
    ] as const) {
      expect(disputeStatusFor(status)).toBe(status)
    }
    // **PayPal has nine statuses and we have six.** The lossy end is deliberately the closed end: EC-REF-4's
    // "an open dispute" must not treat `CANCELED`, `ACCEPTED`, `REFUNDED` or `PENDING` as open, because
    // `packages/orders`' `TERMINAL_DISPUTE_STATUSES` counts `OTHER` as closed.
    for (const closed of [
      'CANCELED',
      'ACCEPTED',
      'REFUNDED',
      'PENDING',
      'undefined-stage',
      undefined,
    ]) {
      expect(disputeStatusFor(closed)).toBe('OTHER')
    }
  })

  it('a second ingest of the same dispute updates the row rather than creating a second one', async () => {
    const h = harness()
    const first = ingested(await ingestDisputeToDefender(paypalDispute(), h.deps))
    expect(first.created).toBe(true)

    // **A later fetch at a later stage**, which is EC-DSP-4's "escalates to a new stage".
    const second = ingested(
      await ingestDisputeToDefender(
        paypalDispute({ dispute_life_cycle_stage: 'PRE_ARBITRATION', status: 'UNDER_REVIEW' }),
        h.deps,
      ),
    )
    expect(second.created).toBe(false)
    // **The same id, because `derivedDisputeId` is a function of the PayPal id.** Two case rows for one
    // chargeback would file two packets.
    expect(second.disputeId).toBe(first.disputeId)
    expect(h.world.rows.disputes.size).toBe(1)
    expect(disputeRow(h).stage).toBe('PRE_ARBITRATION')
    // **The join columns are preserved, not clobbered**: `upsertFromFetch` mirrors PayPal's fields only.
    expect(disputeRow(h).capture_id).toBe(CAPTURE_ID)
  })

  it('derivedDisputeId and derivedPacketId are functions of their inputs, and of nothing else', () => {
    expect(derivedDisputeId(PAYPAL.disputeId)).toBe(derivedDisputeId(PAYPAL.disputeId))
    expect(derivedDisputeId(PAYPAL.disputeId)).not.toBe(derivedDisputeId('PP-D-OTHER'))
    expect(derivedDisputeId(PAYPAL.disputeId)).toMatch(/^dsp_[0-9a-f]{26}$/)

    expect(derivedPacketId('dsp_x', 1)).toBe(derivedPacketId('dsp_x', 1))
    // **A new version is a new packet id**, which is what makes the QR in §8.18 unique per filing.
    expect(derivedPacketId('dsp_x', 2)).not.toBe(derivedPacketId('dsp_x', 1))
    expect(derivedPacketId('dsp_x', 1)).toMatch(/^pkt_[0-9a-f]{26}$/)
  })

  it('money arrives as integer minor units, and an unreadable amount still stores a row', async () => {
    const h = harness()
    const ok = ingested(await ingestDisputeToDefender(paypalDispute(), h.deps))
    expect(ok.dispute.amount_minor).toBe(12_999n)
    expect(ok.context.dispute.amount).toEqual({ minor: 12_999n, currency: 'USD' })

    // **A second currency is carried, never converted.** §0 rule 9.
    const eur = harness()
    const inEur = ingested(
      await ingestDisputeToDefender(
        paypalDispute({
          dispute_amount: { currency_code: 'EUR', value: '118.40' },
          dispute_currency: 'EUR',
        }),
        eur.deps,
      ),
    )
    expect(inEur.dispute.currency).toBe('EUR')
    expect(inEur.dispute.amount_minor).toBe(11_840n)

    // **An unreadable amount is zero in the dispute's own currency, and the row is still written.** The column
    // is `notNull`; refusing the upsert would leave the buyer with no notice of the dispute at all.
    const broken = harness()
    const unreadable = ingested(
      await ingestDisputeToDefender(
        paypalDispute({ dispute_amount: { currency_code: 'ZZZ', value: 'not-a-number' } }),
        broken.deps,
      ),
    )
    expect(unreadable.dispute.amount_minor).toBe(0n)
    expect(unreadable.dispute.currency).toBe('USD')
    expect(broken.world.rows.disputes.size).toBe(1)
    // **And `raw` keeps what PayPal actually said**, so a human can see the unreadable amount.
    expect(JSON.stringify(unreadable.dispute.raw)).toContain('not-a-number')
  })
})

// ---------------------------------------------------------------------------
// 3. EC-DSP-11: a withdrawn dispute is closed, not filed
// ---------------------------------------------------------------------------

describe('EC-DSP-11: a dispute the buyer withdrew is closed at ingest', () => {
  it('a withdrawn dispute is stored and marked CLOSED_WON, with the outcome code quoted', async () => {
    const h = harness()
    const result = ingested(
      await ingestDisputeToDefender(
        paypalDispute({
          status: 'RESOLVED',
          dispute_state: 'RESOLVED',
          dispute_outcome: { outcome_code: 'CANCELED_BY_BUYER' },
        } as Partial<Dispute>),
        h.deps,
      ),
    )
    expect(result.withdrawal.withdrew).toBe(true)
    expect(result.withdrawal.outcomeCode).toBe('CANCELED_BY_BUYER')
    expect(result.withdrawal.reason).toContain('CANCELED_BY_BUYER')
    // **§12.11's handling column for a cancelled case.** The filer refuses on it, and it is `CLOSED_WON`
    // rather than `CLOSED_LOST` because the merchant did not spend a response to find that out.
    expect(result.dispute.defense_state).toBe('CLOSED_WON')
  })

  it('both spellings of the code count, and a LOSS is not a withdrawal', () => {
    // PayPal has used both spellings; a case filed because we misspelled one is the worst outcome for this
    // predicate.
    for (const code of ['CANCELED_BY_BUYER', 'CANCELLED_BY_BUYER', 'CANCELED', 'CANCELLED']) {
      expect(buyerWithdrew({ dispute_outcome: { outcome_code: code } }).withdrew).toBe(true)
    }
    // **A loss is not a withdrawal.** Conflating the two would close exactly the appealable cases EC-DSP-6
    // wants appealed, and silently drop revenue.
    for (const code of ['RESOLVED_BUYER_FAVOUR', 'RESOLVED_SELLER_FAVOUR', 'CANCELED_BY_SELLER']) {
      const verdict = buyerWithdrew({ dispute_outcome: { outcome_code: code } })
      expect(verdict.withdrew).toBe(false)
      expect(verdict.reason).toContain(code)
    }
    // **`adjudication_outcome` is not consulted** — a lost chargeback is not a withdrawal.
    expect(
      buyerWithdrew({ adjudication_outcome: 'RESOLVED_BUYER_FAVOUR', status: 'RESOLVED' }).withdrew,
    ).toBe(false)
    // A mirror we cannot read is a mirror we have no opinion about, not a crash.
    expect(buyerWithdrew(undefined).withdrew).toBe(false)
    expect(buyerWithdrew('nonsense').withdrew).toBe(false)
    expect(buyerWithdrew(42).withdrew).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 4. buildDisputeContext: the facts the router reads
// ---------------------------------------------------------------------------

describe('buildDisputeContext composes the chain from four tables and one audit trail', () => {
  async function contextOf(seed = baseSeed(), over: Partial<Dispute> = {}) {
    const h = harness(seed)
    const result = ingested(await ingestDisputeToDefender(paypalDispute(over), h.deps))
    return { h, ctx: result.context }
  }

  it('every chain fact comes from the row it is named after', async () => {
    const { ctx } = await contextOf()
    expect(ctx.chain).toMatchObject({
      mandatePresent: true,
      readback: READBACK,
      iatSec: NOW_SEC - DAY,
      mandateStatus: 'ACTIVE',
      webauthnPresent: true,
      verifyAtCaptureChainValid: true,
      gateDecision: 'ALLOW',
      deviceStatus: 'ACTIVE',
    })
    expect(ctx.chain?.nlIntent).toContain('size 10')
    expect(ctx.chain?.verifyNowChainValid).toBeUndefined()
  })

  it('a null webauthn_assertion reads as false, and a missing mandate row reads as absent', async () => {
    // **`false`, not absent.** `webauthnPresent: undefined` makes R-UNAUTH-1 not fire *and* R-UNAUTH-3 fire,
    // so the two are different claims: "we recorded no assertion" and "we have no row to read".
    const noAssertion = await contextOf(
      baseSeed({ mandates: [mandateRow({ webauthn_assertion: null })] }),
    )
    expect(noAssertion.ctx.chain?.webauthnPresent).toBe(false)
    // **R-UNAUTH-1 tests `=== true`, so a false cannot contest.** The bias is §18 question 20's bias.
    expect(route(noAssertion.ctx).ruleId).not.toBe('R-UNAUTH-1')

    // **Absent means every *mandate-derived* fact is absent** — a fact we could not read is never `false`. The
    // Gate and the device are different tables, so they are still read.
    const noMandate = await contextOf(baseSeed({ mandates: [] }))
    expect(noMandate.ctx.chain?.mandatePresent).toBeUndefined()
    expect(noMandate.ctx.chain?.webauthnPresent).toBeUndefined()
    expect(noMandate.ctx.chain?.iatSec).toBeUndefined()
    expect(noMandate.ctx.chain?.readback).toBeUndefined()
    // **And a missing mandate takes the case to R-NOCHAIN-1**, which is `UNPROVABLE` and never a contest.
    expect(noMandate.ctx.chain?.verifyAtCaptureChainValid).toBe(true)
    const decided = route(noMandate.ctx)
    expect(decided.ruleId).toBe('R-NOCHAIN-1')
    expect(decided.liability).toBe('UNPROVABLE')
    expect(decided.posture).toBe('REVIEW')
  })

  it('EC-BUY-3: the "lost at" instant comes from the audit trail, and the EARLIEST one wins', async () => {
    // **`devices` has no `lost_at` column** — a §18 question 8 gap. So the instant is the audit trail or it is
    // nothing, and R-UNAUTH-2 compares its *order* against the mandate's `iat`. It also needs the device to
    // *be* LOST, so both halves are asserted: an audit entry alone proves nothing.
    const beforeSigning = await contextOf(
      baseSeed({
        devices: [deviceRow({ status: 'LOST' })],
        audit: [auditLost(NOW_SEC - 2 * DAY), auditLost(NOW_SEC - 5 * DAY)],
      }),
    )
    expect(beforeSigning.ctx.chain?.deviceLostAtSec).toBe(NOW_SEC - 5 * DAY)
    expect(route(beforeSigning.ctx).ruleId).toBe('R-UNAUTH-2')
    expect(route(beforeSigning.ctx).posture).toBe('ACCEPT_CLAIM')

    // **After signing is not before signing**, and the rule must not fire.
    const afterSigning = await contextOf(
      baseSeed({ devices: [deviceRow({ status: 'LOST' })], audit: [auditLost(NOW_SEC - DAY / 2)] }),
    )
    expect(afterSigning.ctx.chain?.deviceLostAtSec).toBe(NOW_SEC - DAY / 2)
    expect(route(afterSigning.ctx).ruleId).not.toBe('R-UNAUTH-2')

    // **An audit entry with an ACTIVE device is not a lost device** — the rule needs both halves, and taking
    // either one alone would accept claims on a device nobody reported losing.
    const activeDevice = await contextOf(baseSeed({ audit: [auditLost(NOW_SEC - 5 * DAY)] }))
    expect(activeDevice.ctx.chain?.deviceLostAtSec).toBe(NOW_SEC - 5 * DAY)
    expect(activeDevice.ctx.chain?.deviceStatus).toBe('ACTIVE')
    expect(route(activeDevice.ctx).ruleId).not.toBe('R-UNAUTH-2')

    // **No audit entry means `undefined`, which disables R-UNAUTH-2** — the safe direction, because it means
    // "we cannot show the device was lost before signing", not "it was not".
    const none = await contextOf()
    expect(none.ctx.chain?.deviceLostAtSec).toBeUndefined()
    expect(route(none.ctx).ruleId).toBe('R-UNAUTH-1')

    // **A LOST device with no timestamp still produces the claim we do have.**
    const lostNoTime = await contextOf(
      baseSeed({ devices: [deviceRow({ status: 'LOST' })], audit: [] }),
    )
    expect(lostNoTime.ctx.chain?.deviceStatus).toBe('LOST')
  })

  it('the disputed amount, capture, order and siblings are the rows the router compares', async () => {
    const h = harness(
      baseSeed({
        refunds: [refundRow()],
        captures: [captureRow(), captureRow({ id: 'cap_00000000000000000000000002' as never })],
      }),
    )
    const result = ingested(await ingestDisputeToDefender(paypalDispute(), h.deps))
    const ctx = result.context

    expect(ctx.dispute.amount).toEqual({ minor: 12_999n, currency: 'USD' })
    expect(ctx.dispute.sellerResponseDueSec).toBe(
      Math.trunc(Date.parse('2026-10-09T18:29:59Z') / 1000),
    )
    expect(ctx.capture?.paypalCaptureId).toBe(PAYPAL.captureId)
    expect(ctx.capture?.amount).toEqual({ minor: 12_999n, currency: 'USD' })
    expect(ctx.order?.customId).toBe(CUSTOM_ID)

    // **EC-REF-1 / EC-DSP-1: refunds are read by the capture, so the router can see a completed one.**
    expect(ctx.refunds).toHaveLength(1)
    expect(ctx.refunds?.[0]?.paypalRefundId).toBe(PAYPAL.refundId)
    expect(ctx.refunds?.[0]?.amount).toEqual({ minor: 12_999n, currency: 'USD' })
    expect(route(ctx).ruleId).toBe('R-REF-1')

    // **`siblingCaptures` excludes the capture under dispute** — R-AMT-2's duplicate is by definition not
    // this one, so including it would make EC-MER-2 undetectable.
    expect(ctx.siblingCaptures).toHaveLength(1)
    expect(ctx.siblingCaptures?.[0]?.id).toBe('cap_00000000000000000000000002')
  })

  it('EC-SPLIT-3: a dispute on one shipment reaches the router with that capture, never the order total', async () => {
    /**
     * The spec's row: *"Dispute on only one shipment's items → the router evaluates only the disputed
     * capture/lines"*, detected by *"dispute amount < order total"*.
     *
     * The world below is that shape: two shipments, two captures ($129.99 first, $70.00 second), and a
     * chargeback that names the first capture only. The assertions are that the context carries the
     * **disputed** figures — so the second shipment's money is not treated as part of the claim — and
     * that nothing in the decision mistakes the remainder for an over-claim or a duplicate.
     */
    const secondCapture = 'cap_00000000000000000000000002' as never
    const secondShipment = 'shp_00000000000000000000000002' as never
    const { ctx } = await contextOf(
      baseSeed({
        orders: [orderRow({ amount_minor: 19_999n })],
        checkoutSessions: [sessionRow({ total_minor: 19_999n })],
        captures: [
          captureRow(),
          captureRow({
            id: secondCapture,
            paypal_capture_id: '5C679366HH908993Z',
            amount_minor: 7_000n,
            shipment_id: secondShipment,
          }),
        ],
        shipments: [
          shipmentRow(),
          shipmentRow({ id: secondShipment, tracking_number: 'JD0002000032' }),
        ],
      }),
    )

    // The order is $199.99; the dispute is $129.99 and is decided on the capture it names.
    expect(ctx.order?.amount).toEqual({ minor: 19_999n, currency: 'USD' })
    expect(ctx.dispute.amount).toEqual({ minor: 12_999n, currency: 'USD' })
    expect(ctx.capture?.id).toBe(CAPTURE_ID)
    expect(ctx.capture?.amount).toEqual({ minor: 12_999n, currency: 'USD' })

    // The second shipment is a sibling — visible to R-AMT-2 — and is not the disputed capture.
    expect(ctx.siblingCaptures?.map((c) => c.id)).toEqual([secondCapture])

    // The case is contested on its own merits: no amount rule fires off the order total.
    const decided = route(ctx)
    expect(decided.ruleId).toBe('R-UNAUTH-1')
    expect(decided.ruleId).not.toBe('R-AMT-1')
    expect(decided.ruleId).not.toBe('R-AMT-2')
  })

  it('EC-MER-2: the signed checkout lines are read from the session cart, and nothing re-derives them', async () => {
    const { ctx } = await contextOf()
    expect(ctx.checkoutLines).toEqual([{ sku: 'SKU-TRAIL-42', qty: 1 }])
    // **No session means no lines**, which makes `shipmentLinesMatchCheckout` return `false` — and that is the
    // direction that makes R-SNAD-MERCH *refund* rather than contest.
    const noSession = await contextOf(baseSeed({ checkoutSessions: [] }))
    expect(noSession.ctx.checkoutLines).toBeUndefined()

    // **A malformed cart yields no lines rather than a crash**, because `cart` is a jsonb mirror.
    const badCart = await contextOf(
      baseSeed({ checkoutSessions: [sessionRow({ cart: { lines: 'nope' } } as never)] }),
    )
    expect(badCart.ctx.checkoutLines).toBeUndefined()
    // `qty: 0` and a non-integer `qty` are both dropped rather than turned into a zero-value line.
    const zeroQty = await contextOf(
      baseSeed({
        checkoutSessions: [
          sessionRow({
            cart: {
              lines: [
                { sku: 'SKU-TRAIL-42', qty: 0 },
                { sku: 'SKU-X', qty: 1.5 },
              ],
            },
          } as never),
        ],
      }),
    )
    expect(zeroQty.ctx.checkoutLines).toBeUndefined()
  })

  it('the appeal gate reads the HATEOAS link, not dispute_state (report §9/#17)', async () => {
    // **`APPEALABLE` with no link is not appealable**: SPEC-D says "If this link does not appear, you cannot
    // appeal the dispute", and no source says the link is derived from the state.
    const stateOnly = await contextOf()
    const { ctx: noLink } = await (async () => {
      const h = harness()
      const r = ingested(
        await ingestDisputeToDefender(paypalDispute({ dispute_state: 'APPEALABLE' }), h.deps),
      )
      return { ctx: r.context }
    })()
    expect(noLink.dispute.appealLinkPresent).toBe(false)
    expect(stateOnly.ctx.dispute.appealLinkPresent).toBe(false)

    const h = harness()
    const withLink = ingested(
      await ingestDisputeToDefender(
        paypalDispute({
          links: [
            {
              href: 'https://api-m.sandbox.paypal.com/v1/customer/disputes/x',
              rel: 'appeal',
              method: 'POST',
            },
          ],
        }),
        h.deps,
      ),
    )
    expect(withLink.context.dispute.appealLinkPresent).toBe(true)
  })

  it('preferencesFrom reads §8.8 defensively, and an unreadable block yields undefined', () => {
    expect(preferencesFrom({ preferences: { size: '10', color: 'blue' } })).toEqual({
      size: '10',
      color: 'blue',
    })
    // **An unsigned hint we cannot read is a guess, and a guess must not blame our own agent.**
    expect(preferencesFrom(undefined)).toBeUndefined()
    expect(preferencesFrom({})).toBeUndefined()
    expect(preferencesFrom({ preferences: 'nope' })).toBeUndefined()
    expect(preferencesFrom({ preferences: { size: 42 } })).toBeUndefined()
    expect(preferencesFrom({ preferences: { size: '' } })).toBeUndefined()
    // **Only the four documented keys.** An arbitrary jsonb key is not a preference.
    expect(preferencesFrom({ preferences: { sku: 'X', price: '130' } })).toBeUndefined()
  })

  it('an unknown order gets {} for the corpus and {} for the policy, never a true', async () => {
    /**
     * **`EvidenceCorpus` booleans mean "we can put a real document behind this claim"**, so `true` without a
     * document is the direction that files a packet we cannot support.
     */
    const h = harness(baseSeed({ corpora: {}, policies: {} }))
    const result = ingested(
      await ingestDisputeToDefender(
        paypalDispute({ reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED' }),
        h.deps,
      ),
    )
    expect(result.context.corpus).toEqual({})
    // **No quality document means R-SNAD-THIN** — an offer, EC-BUY-1 — rather than a contest we cannot support.
    expect(result.context.policy).toEqual({})
    expect(result.context.policy?.autoAcceptThresholdMinor).toBeUndefined()
    expect(route(result.context).ruleId).toBe('R-SNAD-THIN')

    // **And an unconfigured merchant gets no automatic acceptance.** The default threshold is zero, so
    // `autoAccepts` is false and a case we cannot prove goes to a person rather than being paid out. The two
    // worlds differ only in the policy, so the policy is demonstrably the cause. `mandates: []` is what reaches
    // R-NOCHAIN-1 while keeping the order linked — the policy is read through `checkout_sessions`, so an
    // unlinked dispute would report `{}` for a different reason and prove nothing.
    const unconfigured = await contextOf(baseSeed({ mandates: [], policies: {} }))
    expect(unconfigured.ctx.policy).toEqual({})
    const open = route(unconfigured.ctx)
    expect(open.ruleId).toBe('R-NOCHAIN-1')
    expect(open.posture).toBe('REVIEW')

    const configured = await contextOf(
      baseSeed({
        mandates: [],
        policies: { [MERCHANT_ID]: { autoAcceptThresholdMinor: 12_999n } },
      }),
    )
    expect(configured.ctx.policy?.autoAcceptThresholdMinor).toBe(12_999n)
    const settled = route(configured.ctx)
    expect(settled.ruleId).toBe('R-NOCHAIN-1')
    expect(settled.posture).toBe('ACCEPT_CLAIM')
  })

  it('a corpus with a quality document is what moves the SNAD case off THIN and onto OK', async () => {
    const snad = (qualityDocument: boolean) =>
      contextOf(
        baseSeed({ corpora: { [ORDER_ID]: { fulfilmentDocument: true, qualityDocument } } }),
        { reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED' },
      )

    const withDoc = await snad(true)
    const decided = route(withDoc.ctx)
    expect(decided.posture).toBe('CONTEST')
    expect(decided.ruleId).toBe('R-SNAD-OK')
    const noDoc = await snad(false)
    expect(route(noDoc.ctx).ruleId).toBe('R-SNAD-THIN')
  })
})

// ---------------------------------------------------------------------------
// 5. EC-DSP-9: an unmapped dispute still gets a row and a sentence
// ---------------------------------------------------------------------------

describe('EC-DSP-9: a dispute we cannot map to an order produces a row and a sentence, never a crash', () => {
  it('an unlinked row routes to R-NOCHAIN-1 and a person, and the router says why in words', async () => {
    const h = harness()
    const result = ingested(
      await ingestDisputeToDefender(paypalDispute({ disputed_transactions: [] }), h.deps),
    )

    // **A context is still built**, because the router is supposed to run on these rows and produce the
    // sentence. Skipping them would leave EC-DSP-9's "Not a Countersign order" unsaid.
    expect(result.context.dispute.id).toBe(result.disputeId)
    expect(result.context.capture).toBeUndefined()
    expect(result.context.order).toBeUndefined()

    const decided = route(result.context)
    expect(decided.ruleId).toBe('R-NOCHAIN-1')
    expect(decided.liability).toBe('UNPROVABLE')
    expect(decided.posture).toBe('REVIEW')
    expect(decided.rationale.length).toBeGreaterThan(0)
    expect(decided.facts.some((f) => f.source === 'disputes')).toBe(true)
    // **EC-MER-7's "it cannot be hidden": the reasons are enumerable, not a bare refusal.**
    expect(decided.reasons.length).toBeGreaterThan(0)
  })

  it('EC-MER-2 / EC-BUY-3: a broken chain is stated as a broken chain, not as a missing one', async () => {
    // **R-CHAIN-BAD is decided inside the R-NOCHAIN-1 branch**, because both are "we have no proof" and only
    // one can be honestly stated: "we have a mandate and it does not verify" and "there is no mandate here"
    // are different facts.
    const h = harness(baseSeed({ gateDecisions: [gateRow({ chain_valid: false })] }))
    const result = ingested(await ingestDisputeToDefender(paypalDispute(), h.deps))
    expect(result.context.chain?.verifyAtCaptureChainValid).toBe(false)
    const decided = route(result.context)
    expect(decided.ruleId).toBe('R-CHAIN-BAD')
    expect(decided.liability).toBe('UNPROVABLE')
    // **Never a contest on a broken chain** — §8.15's most load-bearing sentence.
    expect(decided.posture).not.toBe('CONTEST')
    expect(decided.rationale).not.toContain('no mandate')
  })
})

// ---------------------------------------------------------------------------
// 6. §7.3 / D-018: the bundle hash and the custom_id agreement
// ---------------------------------------------------------------------------

describe('§7.3: bundleHashFor is a content address, and it excludes what is added after order creation', () => {
  it('the same bundle gives the same hash regardless of key order', () => {
    const reordered = {
      shipments: BUNDLE.shipments,
      paypal: BUNDLE.paypal,
      webauthn: BUNDLE.webauthn,
      vi_lib_commit: BUNDLE.vi_lib_commit,
      gate_decision: BUNDLE.gate_decision,
      checkout_jwt: BUNDLE.checkout_jwt,
      l3b: BUNDLE.l3b,
      l3a: BUNDLE.l3a,
      l2: BUNDLE.l2,
      l1: BUNDLE.l1,
      v: BUNDLE.v,
    } as unknown as EvidenceBundle
    // **RFC 8785 JCS sorts keys**, which is what lets a third party recompute the hash and get our value.
    expect(bundleHashFor(reordered as unknown as Record<string, unknown>)).toBe(
      bundleHashFor(BUNDLE as unknown as Record<string, unknown>),
    )
    expect(bundleHashFor(BUNDLE as unknown as Record<string, unknown>)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('the hash covers the WHOLE bundle, including the members custom_id excludes', () => {
    /**
     * **A distinction worth stating because it is easy to get backwards.**
     *
     * §7.3's `custom_id` is computed at order time, and `paypal` and `shipments` are the two members **excluded
     * from that hash** because they are added after the order is created. `bundle_hash` is a different value with
     * a different job: it is the **content address of the case file we are about to upload**, so it covers
     * everything in the bundle. If it excluded `shipments`, a second parcel registered against the same order
     * would produce the same hash and EC-DSP-10 would treat a genuinely new packet as a duplicate.
     */
    const base = bundleHashFor(BUNDLE as unknown as Record<string, unknown>)
    expect(
      bundleHashFor({
        ...BUNDLE,
        shipments: [
          ...(BUNDLE.shipments ?? []),
          { carrier: 'DHL', tracking: 'JD0002000032', lines: [{ sku: 'SKU-SOCK-07', qty: 2 }] },
        ],
      } as unknown as Record<string, unknown>),
    ).not.toBe(base)
    expect(
      bundleHashFor({
        ...BUNDLE,
        paypal: {
          ...BUNDLE.paypal!,
          capture_ids: [...(BUNDLE.paypal?.capture_ids ?? []), '3COTHER'],
        },
      } as unknown as Record<string, unknown>),
    ).not.toBe(base)
  })

  it('EC-DSP-4: a different signed core is a different hash, which is what makes a second packet a new packet', () => {
    const base = bundleHashFor(BUNDLE as unknown as Record<string, unknown>)
    expect(
      bundleHashFor({ ...BUNDLE, l2: 'l2.tampered' } as unknown as Record<string, unknown>),
    ).not.toBe(base)
    expect(
      bundleHashFor({ ...BUNDLE, gate_decision: 'gd.tampered' } as unknown as Record<
        string,
        unknown
      >),
    ).not.toBe(base)
    expect(
      bundleHashFor({ ...BUNDLE, webauthn: { present: false } } as unknown as Record<
        string,
        unknown
      >),
    ).not.toBe(base)
  })

  it('D-018: custom_id agreement is a consistency check between two stored values, not a recomputation', () => {
    // **`packages/orders` owns `customIdForBundle`** and is not a dependency here, so a second implementation
    // would be silent drift in the one value that ties a packet to a PayPal transaction. Comparing two stored
    // values catches the drift without owning it.
    expect(customIdAgreement(BUNDLE, CUSTOM_ID)?.agreed).toBe(true)
    const disagree = customIdAgreement(BUNDLE, `cs1:${'B'.repeat(43)}`)
    expect(disagree?.agreed).toBe(false)
    expect(disagree?.message).toContain('not the bundle the order was created with')
    // **No `paypal` member means nothing to compare**, which is `null` rather than a false agreement.
    expect(customIdAgreement({ ...BUNDLE, paypal: undefined }, CUSTOM_ID)).toBeNull()
  })

  it('a custom_id disagreement surfaces as an ingest warning, before any 50 MB upload', async () => {
    const h = harness(
      baseSeed({
        bundles: {
          [ORDER_ID]: {
            ...BUNDLE,
            paypal: { ...BUNDLE.paypal!, custom_id: `cs1:${'B'.repeat(43)}` },
          },
        },
      }),
    )
    const result = ingested(await ingestDisputeToDefender(paypalDispute(), h.deps))
    expect(result.warnings.join(' ')).toContain('custom_id')
  })
})

// ---------------------------------------------------------------------------
// 7. The in-memory world is not a plain object
// ---------------------------------------------------------------------------

describe('the in-memory world models the three UNIQUE constraints that ARE the idempotency defences', () => {
  it('dispute_actions_idempotency_key_key is unique, and names the constraint', async () => {
    const h = harness()
    const base = {
      dispute_id: 'dsp_x',
      action: 'FILE',
      idempotency_key: 'cs:dsp_x:file:1',
      at: AT,
      request: {},
      response: {},
    } as unknown as NewDisputeAction

    const first = expectOk<DisputeActionRow>(await h.world.store.actions.record(base))
    expect(first.idempotency_key).toBe('cs:dsp_x:file:1')

    const second = await h.world.store.actions.record(base)
    expect(second.ok).toBe(false)
    if (second.ok) throw new Error('expected CS_CONFLICT')
    expect(second.error.code).toBe('CS_CONFLICT')
    expect(second.error.message).toContain('dispute_actions_idempotency_key_key')
    expect(h.world.rows.actions.size).toBe(1)

    // **And the reader finds it**, which is EC-DSP-10's local half.
    expect(
      expectOk<DisputeActionRow | undefined>(
        await h.world.store.actions.findByIdempotencyKey('cs:dsp_x:file:1'),
      ),
    ).toBeDefined()
    expect(
      expectOk<DisputeActionRow | undefined>(
        await h.world.store.actions.findByIdempotencyKey('cs:dsp_x:file:2'),
      ),
    ).toBeUndefined()
  })

  it('evidence_packets_dispute_id_version_key is unique, so two filings of one version collide', async () => {
    const h = harness()
    const packet = (over: Record<string, unknown> = {}) =>
      ({
        id: 'pkt_00000000000000000000000001',
        dispute_id: 'dsp_x',
        version: 1,
        bundle_hash: 'a'.repeat(64),
        pdf_sha256: null,
        pdf_bytes: null,
        notes: null,
        citations: null,
        citation_check: null,
        filed_at: null,
        paypal_response: null,
        created_at: AT,
        updated_at: AT,
        ...over,
      }) as unknown as NewEvidencePacket

    expectOk(await h.world.store.packets.insert(packet()))
    const clash = await h.world.store.packets.insert(
      packet({ id: 'pkt_00000000000000000000000002' }),
    )
    expect(clash.ok).toBe(false)
    if (clash.ok) throw new Error('expected CS_CONFLICT')
    expect(clash.error.message).toContain('evidence_packets_dispute_id_version_key')
    // **Version 2 is fine**, which is what makes EC-DSP-4's "new packet version" possible.
    expectOk(
      await h.world.store.packets.insert(
        packet({ id: 'pkt_00000000000000000000000003', version: 2 }),
      ),
    )
    expect(h.world.rows.packets.size).toBe(2)
  })

  it('packets.forDispute returns every version, newest first — EC-DSP-10 needs the whole history', async () => {
    const h = harness()
    for (const version of [1, 2, 3]) {
      expectOk(
        await h.world.store.packets.insert({
          id: `pkt_0000000000000000000000000${version}`,
          dispute_id: 'dsp_x',
          version,
          bundle_hash: 'a'.repeat(64),
          pdf_sha256: null,
          pdf_bytes: null,
          notes: null,
          citations: null,
          citation_check: null,
          filed_at: null,
          paypal_response: null,
          created_at: AT,
          updated_at: AT,
        } as unknown as NewEvidencePacket),
      )
    }
    const all = expectOk<EvidencePacketRow[]>(
      await h.world.store.packets.forDispute('dsp_x' as never),
    )
    expect(all.map((p) => p.version)).toEqual([3, 2, 1])
    expect(
      expectOk<EvidencePacketRow | undefined>(
        await h.world.store.packets.latestForDispute('dsp_x' as never),
      )?.version,
    ).toBe(3)
    expect(
      expectOk<EvidencePacketRow[]>(await h.world.store.packets.forDispute('dsp_other' as never)),
    ).toEqual([])
  })

  it('disputes_paypal_dispute_id_key is unique, which is what makes derivedDisputeId load-bearing', async () => {
    const h = harness()
    const row = {
      id: derivedDisputeId(PAYPAL.disputeId),
      paypal_dispute_id: PAYPAL.disputeId,
      order_id: null,
      capture_id: null,
      reason: 'UNAUTHORISED',
      stage: 'CHARGEBACK',
      status: 'WAITING_FOR_SELLER_RESPONSE',
      amount_minor: 12_999n,
      currency: 'USD',
      seller_response_due_date: null,
      buyer_response_due_date: null,
      defense_state: 'NEW',
      liability: null,
      router_trace: null,
      raw: {},
      created_at: AT,
      updated_at: AT,
      fetched_at: AT,
    } as unknown as Parameters<typeof h.world.store.disputes.insert>[0]

    expectOk(await h.world.store.disputes.insert(row))
    const dupe = await h.world.store.disputes.insert(row)
    expect(dupe.ok).toBe(false)
    if (dupe.ok) throw new Error('expected CS_CONFLICT')
    expect(dupe.error.message).toContain('disputes')
    expect(h.world.rows.disputes.size).toBe(1)
  })

  it('a missing row is CS_NOT_FOUND rather than undefined, and a thrown error becomes a CsError', async () => {
    const h = harness()
    const missing = await h.world.store.disputes.setLiability(
      'dsp_nope' as never,
      'UNPROVABLE',
      {},
      AT,
    )
    expect(missing.ok).toBe(false)
    if (missing.ok) throw new Error('expected err')
    expect(missing.error.code).toBe('CS_NOT_FOUND')

    // **A returned `err(...)` commits; only a throw rolls back.** This is the one contract `transaction` has,
    // and it is asserted rather than assumed.
    const committed = await h.world.store.transaction(async () => 'value')
    expect(committed.ok).toBe(true)

    const rolledBack = await h.world.store.transaction(async () => {
      throw new Error('abort')
    })
    expect(rolledBack.ok).toBe(false)
    if (rolledBack.ok) throw new Error('expected err')
    expect(rolledBack.error.code).toBe('CS_INTERNAL')
  })

  it('a bundle for an unknown order is CS_NOT_FOUND, because no repository assembles one', async () => {
    const h = harness(baseSeed({ bundles: {} }))
    const bundle = await h.world.store.evidence.bundle(ORDER_ID)
    expect(bundle.ok).toBe(false)
    if (bundle.ok) throw new Error('expected err')
    expect(bundle.error.code).toBe('CS_NOT_FOUND')
  })
})

// ---------------------------------------------------------------------------
// 8. jsonb conversion
// ---------------------------------------------------------------------------

describe('toJsonValue stringifies bigint rather than throwing on it', () => {
  it("a bigint amount survives the mirror, because this package's own contexts hold bigint", () => {
    const mirrored = toJsonValue({ amount: { minor: 12_999n }, nested: [{ n: 1n }] })
    expect(mirrored).toEqual({ amount: { minor: '12999' }, nested: [{ n: '1' }] })
    expect(toJsonValue(null)).toBeNull()
    expect(toJsonValue({ when: new Date(NOW_SEC * 1000) })).toEqual({
      when: new Date(NOW_SEC * 1000).toISOString(),
    })
  })

  it('a value jsonb cannot hold fails loudly rather than mirroring "undefined"', () => {
    // **The step is the check.** `JSON.parse(JSON.stringify(undefined))` throws, which is the right outcome for a
    // mirror: a `raw` column that quietly stored nothing would make every later reader believe PayPal said
    // nothing, and the router would have no evidence to refuse on.
    expect(() => toJsonValue(undefined)).toThrow()
  })
})
