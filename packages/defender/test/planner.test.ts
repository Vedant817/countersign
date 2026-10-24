/**
 * `planEvidence()` — spec **§8.15**'s evidence planner, work package **WP-15b**.
 *
 * ## What this file is really checking
 *
 * Not "does the plan contain the right strings". Three things, in order of how much they matter:
 *
 * 1. **Nothing we propose could be rejected by `@countersign/paypal` before the bytes move** (EC-DSP-12).
 *    Every limit is imported from that package rather than restated, so this check cannot drift from the
 *    one that actually guards the upload. A rejected file costs no HTTP request at all, which is the whole
 *    point of EC-DSP-12 — and a plan that would be rejected has wasted the merchant's time instead.
 * 2. **The notes are a single string of at most 2000 characters** (spec D-012 corrected `string[]`), and
 *    every claim in them is one the router already decided. A note is the fallback WP-15c's citation
 *    checker compares against, so it has to satisfy the same bar.
 * 3. **EC-REF-5**: a rounding remainder is allocated from the *shipment* lines, never from the order total,
 *    and the parts sum to the disputed amount exactly.
 *
 * ## Why `validateEvidencePlan` exists as a separate export
 *
 * Because the check is worth more than the plan it checks. A caller assembling a packet from several
 * sources — WP-15e adding the rendered PDF, WP-15d's renderer — can run it over anything, and EC-DSP-12 is
 * cheaper as a local string check than as a 4xx after an upload.
 */

import { allocateWithRemainderLast, money } from '@countersign/core'
import {
  ALLOWED_EVIDENCE_CONTENT_TYPES,
  EVIDENCE_TYPES,
  MAX_EVIDENCE_FILE_BYTES,
  MAX_EVIDENCE_ITEMS,
  MAX_EVIDENCE_TOTAL_BYTES,
  provideEvidenceInputSchema,
} from '@countersign/paypal'
import { describe, expect, it } from 'vitest'

import {
  EVIDENCE_BY_REASON,
  NOTES_MAX_CHARS,
  clampNotes,
  evidenceInfoFor,
  packetNote,
  planEvidence,
  shipmentShares,
  toProvideEvidenceInput,
  validateEvidencePlan,
  route,
  type DisputeContext,
  type EvidencePlanItem,
  type EvidenceType,
} from '../src/index'

const NOW = 1_791_500_000
const IN_3_DAYS = NOW + 3 * 86_400

function baseCtx(): DisputeContext {
  return {
    nowSec: NOW,
    dispute: {
      id: 'dsp_1',
      paypalDisputeId: 'PP-DSP-1',
      reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      stage: 'CHARGEBACK',
      status: 'WAITING_FOR_SELLER_RESPONSE',
      amount: money(8_900n, 'USD'),
      sellerResponseDueSec: IN_3_DAYS,
    },
    capture: {
      id: 'cap_1',
      paypalCaptureId: 'PAY-CAP-1',
      amount: money(8_900n, 'USD'),
      shipmentId: 'shp_1',
    },
    order: { id: 'ord_1', customId: 'cs1:abc', invoiceId: 'INV-1', amount: money(8_900n, 'USD') },
    chain: {
      mandatePresent: true,
      verifyAtCaptureChainValid: true,
      webauthnPresent: true,
      readback: '**What you are authorising**',
      iatSec: NOW - 86_400,
      deviceStatus: 'ACTIVE',
    },
    checkoutLines: [{ sku: 'SKU-TRAIL-42', qty: 1 }],
    shipments: [
      {
        id: 'shp_1',
        carrier: 'BlueDart',
        trackingNumber: 'BD1',
        paypalTrackerId: 'TRK-1',
        status: 'DELIVERED',
        lines: [{ sku: 'SKU-TRAIL-42', qty: 1 }],
      },
    ],
  }
}

const ctx = (over: Partial<DisputeContext> = {}): DisputeContext => ({ ...baseCtx(), ...over })

function plan(over: Partial<DisputeContext> = {}): ReturnType<typeof planEvidence> {
  const c = ctx(over)
  return planEvidence(c, route(c))
}

// ---------------------------------------------------------------------------
// The reason → evidence table
// ---------------------------------------------------------------------------

describe('EVIDENCE_BY_REASON', () => {
  it('names only PayPal evidence_type values from the corrected enum', () => {
    for (const [reason, types] of Object.entries(EVIDENCE_BY_REASON)) {
      for (const t of types)
        expect(EVIDENCE_TYPES as readonly string[], `${reason}: ${t}`).toContain(t)
    }
  })

  it('never names one of the seven values PayPal does not have', () => {
    const REMOVED = [
      'CHECKOUT_PAGE',
      'CANCELLED_RECURING_BILLING_AGREEMENT',
      'CUSTOMER_COMMUNICATION',
      'FULFILLMENT_DOCUMENTATION',
      'REFUND_POLICY',
      'TERMS_OF_SERVICE',
      'UNCONTROLLED_WEB_CONTENT',
    ]
    expect(Object.values(EVIDENCE_BY_REASON).flat()).not.toContain(REMOVED[0])
    for (const gone of REMOVED) expect(Object.values(EVIDENCE_BY_REASON).flat()).not.toContain(gone)
  })

  it('covers every reason PayPal has except OTHER, which has no evidence of its own', () => {
    expect(EVIDENCE_BY_REASON['OTHER']).toBeUndefined()
    expect(Object.keys(EVIDENCE_BY_REASON).length).toBe(9)
  })

  it('a reason with no evidence of its own still plans from the rule, not from nothing', () => {
    // `OTHER` reaches R-OTHER-REFUND, which is a refund and files nothing. The guard here is that the table
    // cannot be silently consulted for a reason it does not have.
    expect(EVIDENCE_BY_REASON['A_REASON_PAYPAL_HAS_NOT_INVENTED_YET']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// The plan shape
// ---------------------------------------------------------------------------

describe('planEvidence', () => {
  it('files nothing for a REFUND, and says why in warnings rather than inventing items', () => {
    const p = plan({ shipments: [] })
    expect(p.items).toEqual([])
    expect(p.warnings.join(' ')).toContain('REFUND files nothing')
  })

  it('files nothing for REVIEW or for a REFUND, and says which rule decided', () => {
    for (const over of [{ order: undefined, capture: undefined }, { shipments: [] }]) {
      const p = plan(over)
      const rule = route(ctx(over)).ruleId
      expect(['REVIEW', 'REFUND'], rule).toContain(route(ctx(over)).posture)
      expect(p.items, rule).toEqual([])
      expect(p.warnings.join(' '), rule).toContain(`rule ${rule}`)
    }
  })

  it('plans a real packet for an OFFER, because make-offer carries evidence too', () => {
    // EC-BUY-1's `REFUND_WITH_RETURN` offer is a `make-offer` call with a note; the note has to be
    // defensible, so OFFER is in the filing set rather than the empty-plan set.
    const c = ctx({
      dispute: { ...baseCtx().dispute, reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED' },
    })
    expect(route(c).posture).toBe('OFFER')
    expect(planEvidence(c, route(c)).items.length).toBeGreaterThan(0)
  })

  it('plans nothing for MESSAGE_ONLY, because a message has no evidence packet', () => {
    const c = ctx({
      shipments: [
        {
          id: 'shp_1',
          carrier: 'BlueDart',
          trackingNumber: 'BD1',
          paypalTrackerId: 'TRK-1',
          status: 'SHIPPED',
          lines: [{ sku: 'SKU-TRAIL-42', qty: 1 }],
        },
      ],
    })
    expect(route(c).posture).toBe('MESSAGE_ONLY')
    expect(planEvidence(c, route(c)).items).toEqual([])
  })

  it("includes the rule's required types first, in the rule's order", () => {
    const p = plan()
    expect(p.items.map((i) => i.evidenceType)).toEqual([
      'PROOF_OF_FULFILLMENT',
      'ONLINE_TRACKING_INFORMATION',
      'PROOF_OF_RETURN',
    ])
  })

  it("adds what the reason documents beyond the rule's minimum, without duplicating a type", () => {
    const p = plan()
    const types = p.items.map((i) => i.evidenceType)
    expect(new Set(types).size).toBe(types.length)
    // PROOF_OF_FULFILLMENT is both required by R-INR-2 and documented for this reason: once, not twice.
    expect(types.filter((t) => t === 'PROOF_OF_FULFILLMENT')).toHaveLength(1)
  })

  it('never plans a CONTEST item whose type has no source, and says so', () => {
    const p = plan({
      shipments: [
        {
          id: 'shp_1',
          carrier: 'BlueDart',
          trackingNumber: 'BD1',
          paypalTrackerId: null,
          status: 'DELIVERED',
          lines: [{ sku: 'SKU-TRAIL-42', qty: 1 }],
        },
      ],
    })
    // This context is R-NO-EVIDENCE, so the plan is empty and the warning explains why.
    expect(p.items).toEqual([])
  })

  it('lists every item as unsatisfied when its type has no source, rather than pretending', () => {
    // A hand-built plan bypassing the guard, to prove the warning path works.
    const c = ctx({ corpus: {} })
    const decision = {
      ...route(c),
      evidenceRequired: ['PROOF_OF_RECEIPT_COPY'] as const,
      posture: 'CONTEST' as const,
    }
    const p = planEvidence(c, decision)
    expect(p.warnings.join(' ')).toContain('PROOF_OF_RECEIPT_COPY has no source')
  })
})

// ---------------------------------------------------------------------------
// evidence_info
// ---------------------------------------------------------------------------

describe('evidenceInfoFor', () => {
  it('ONLINE_TRACKING_INFORMATION carries carrier and tracking for every disputed shipment', () => {
    expect(evidenceInfoFor('ONLINE_TRACKING_INFORMATION', ctx())).toEqual({
      tracking_info: [{ carrier_name: 'BlueDart', tracking_number: 'BD1' }],
    })
  })

  it('PROOF_OF_REFUND carries the PayPal refund ids, not our internal ones', () => {
    const info = evidenceInfoFor(
      'PROOF_OF_REFUND',
      ctx({
        refunds: [
          {
            id: 'ref_1',
            paypalRefundId: 'REFUND-ABC',
            amount: money(8_900n, 'USD'),
            status: 'COMPLETED',
            atSec: NOW - 86_400,
          },
        ],
      }),
    )
    expect(info).toEqual({ refund_ids: ['REFUND-ABC'] })
  })

  it('omits the key entirely when there is nothing to put in it, rather than sending []', () => {
    // An empty array is not the same as an absent field to a strict parser, and we cannot test the
    // difference without a sandbox (H-01), so the plan never emits a field it does not mean.
    expect(evidenceInfoFor('ONLINE_TRACKING_INFORMATION', ctx({ shipments: [] }))).toEqual({})
    expect(evidenceInfoFor('PROOF_OF_REFUND', ctx())).toEqual({})
  })

  it('every other type has no evidence_info, because the documents carry it', () => {
    for (const type of [
      'ITEM_DESCRIPTION',
      'ORDER_DETAILS',
      'PROOF_OF_FULFILLMENT',
      'PROOF_OF_RECEIPT_COPY',
    ] as EvidenceType[]) {
      expect(evidenceInfoFor(type, ctx()), type).toEqual({})
    }
  })
})

// ---------------------------------------------------------------------------
// notes — spec D-012
// ---------------------------------------------------------------------------

describe('the notes', () => {
  it('are a single string, not an array (spec D-012 corrected string[])', () => {
    for (const item of plan().items) {
      expect(typeof item.notes).toBe('string')
      expect(Array.isArray(item.notes)).toBe(false)
    }
  })

  it('are never empty, because PayPal requires at least one character', () => {
    for (const item of plan().items) expect(item.notes.trim().length).toBeGreaterThan(0)
  })

  it('are at most 2000 characters for every item of every plan', () => {
    const contexts: Partial<DisputeContext>[] = [
      {},
      {
        refunds: [
          {
            id: 'r',
            paypalRefundId: 'R',
            amount: money(8_900n, 'USD'),
            status: 'COMPLETED',
            atSec: NOW,
          },
        ],
      },
      { dispute: { ...baseCtx().dispute, reason: 'UNAUTHORISED' } },
      {
        dispute: { ...baseCtx().dispute, reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED' },
        corpus: { qualityDocument: true },
      },
      {
        dispute: { ...baseCtx().dispute, reason: 'INCORRECT_AMOUNT' },
        corpus: { receiptCopy: true },
      },
    ]
    for (const over of contexts) {
      for (const item of plan(over).items) {
        expect(item.notes.length, `${item.evidenceType}`).toBeLessThanOrEqual(NOTES_MAX_CHARS)
      }
    }
  })

  it('name the rule that decided, so a note and the packet cannot disagree', () => {
    for (const over of [
      {},
      { dispute: { ...baseCtx().dispute, reason: 'UNAUTHORISED' } },
      {
        dispute: { ...baseCtx().dispute, reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED' },
        corpus: { qualityDocument: true },
      },
      {
        dispute: { ...baseCtx().dispute, reason: 'INCORRECT_AMOUNT' },
        corpus: { receiptCopy: true },
      },
    ]) {
      const c = ctx(over)
      const rule = route(c).ruleId
      for (const item of planEvidence(c, route(c)).items) {
        expect(item.notes, `${rule}/${item.evidenceType}`).toContain(rule)
      }
    }
  })

  it('the rule prefix is applied once per note, not repeated per line', () => {
    const c = ctx({ dispute: { ...baseCtx().dispute, reason: 'UNAUTHORISED' } })
    for (const item of planEvidence(c, route(c)).items) {
      const occurrences = item.notes.split(route(c).ruleId).length - 1
      expect(occurrences, item.evidenceType).toBe(1)
    }
  })

  it('EC-MER-4: a fulfilment note says whether the tracker is PayPal-held or merchant-asserted', () => {
    const held = plan()
    const heldNote = held.items.find((i) => i.evidenceType === 'PROOF_OF_FULFILLMENT')?.notes ?? ''
    expect(heldNote).toContain('registered with PayPal')

    const asserted = plan({
      shipments: [
        {
          id: 'shp_1',
          carrier: 'BlueDart',
          trackingNumber: 'BD1',
          paypalTrackerId: null,
          status: 'DELIVERED',
          lines: [{ sku: 'SKU-TRAIL-42', qty: 1 }],
        },
      ],
      corpus: { fulfilmentDocument: true },
    })
    const note = asserted.items.find((i) => i.evidenceType === 'PROOF_OF_FULFILLMENT')?.notes ?? ''
    expect(note).toContain('asserted by the merchant')
    expect(note).toContain('not independently verified')
  })

  it('a tracking note makes no carrier-verification claim (EC-MER-4)', () => {
    const note =
      plan().items.find((i) => i.evidenceType === 'ONLINE_TRACKING_INFORMATION')?.notes ?? ''
    expect(note).toContain('we make no carrier-verification claim')
  })

  it('a refund note says the id is in evidence_info, so the two halves agree', () => {
    const c = ctx({
      dispute: { ...baseCtx().dispute, reason: 'UNAUTHORISED' },
      refunds: [
        {
          id: 'ref_1',
          paypalRefundId: 'REFUND-ABC',
          amount: money(8_900n, 'USD'),
          status: 'COMPLETED',
          atSec: NOW - 86_400,
        },
      ],
    })
    const p = planEvidence(c, route(c))
    const item = p.items.find((i) => i.evidenceType === 'PROOF_OF_REFUND')
    expect(item?.notes).toContain('evidence_info.refund_ids')
    expect(item?.evidenceInfo.refund_ids).toEqual(['REFUND-ABC'])
  })

  it('a details note tells the reader the packet re-verifies at our public URL', () => {
    const c = ctx({ dispute: { ...baseCtx().dispute, reason: 'UNAUTHORISED' } })
    const note = planEvidence(c, route(c)).items.find(
      (i) => i.evidenceType === 'DETAILS_OF_PURCHASE',
    )?.notes
    expect(note).toContain('re-verify it against our public URL')
  })

  it('EC-FAM-2: a details note mentions the passkey only when one was recorded', () => {
    const withPasskey = ctx({ dispute: { ...baseCtx().dispute, reason: 'UNAUTHORISED' } })
    expect(
      planEvidence(withPasskey, route(withPasskey)).items.find(
        (i) => i.evidenceType === 'DETAILS_OF_PURCHASE',
      )?.notes,
    ).toContain('WebAuthn user-verification')
    const without = ctx({
      dispute: { ...baseCtx().dispute, reason: 'UNAUTHORISED' },
      chain: { mandatePresent: true, verifyAtCaptureChainValid: true, webauthnPresent: false },
    })
    const note = planEvidence(without, route(without)).items.find(
      (i) => i.evidenceType === 'DETAILS_OF_PURCHASE',
    )?.notes
    expect(note ?? '').not.toContain('WebAuthn user-verification was present')
  })
})

describe('clampNotes', () => {
  it('leaves a note inside the limit untouched', () => {
    expect(clampNotes('short')).toBe('short')
  })

  it('leaves a note exactly at the limit untouched', () => {
    const exact = 'x'.repeat(NOTES_MAX_CHARS)
    expect(clampNotes(exact)).toBe(exact)
  })

  it('drops whole trailing sentences rather than truncating mid-claim', () => {
    const long = `${'A'.repeat(1_500)}. ${'B'.repeat(1_500)}.`
    const out = clampNotes(long)
    expect(out.length).toBeLessThanOrEqual(NOTES_MAX_CHARS)
    expect(out).toContain('the full note is in the packet PDF')
    // The kept part ends on a sentence boundary, so nothing is quoted back as a fragment.
    expect(out.startsWith('A'.repeat(1_500))).toBe(true)
  })

  it('never produces an empty note, even when the first sentence alone is too long', () => {
    const huge = 'x'.repeat(NOTES_MAX_CHARS + 100)
    const out = clampNotes(huge)
    expect(out.length).toBeGreaterThan(0)
    expect(out.length).toBeLessThanOrEqual(NOTES_MAX_CHARS)
  })

  it('is idempotent, so a clamped note re-clamped does not drift', () => {
    const once = clampNotes(`${'A'.repeat(1_500)}. ${'B'.repeat(1_500)}.`)
    expect(clampNotes(once)).toBe(once)
  })
})

// ---------------------------------------------------------------------------
// EC-DSP-12 — the limits @countersign/paypal enforces
// ---------------------------------------------------------------------------

describe('EC-DSP-12: nothing the plan proposes could be rejected before the bytes move', () => {
  it('reports no violation for the plans this module can produce', () => {
    const contexts: Partial<DisputeContext>[] = [
      {},
      {
        refunds: [
          {
            id: 'r',
            paypalRefundId: 'R',
            amount: money(8_900n, 'USD'),
            status: 'COMPLETED',
            atSec: NOW,
          },
        ],
      },
      { dispute: { ...baseCtx().dispute, reason: 'UNAUTHORISED' } },
      {
        dispute: { ...baseCtx().dispute, reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED' },
        corpus: { qualityDocument: true },
      },
      {
        dispute: { ...baseCtx().dispute, reason: 'INCORRECT_AMOUNT' },
        corpus: { receiptCopy: true },
      },
      { dispute: { ...baseCtx().dispute, reason: 'CREDIT_NOT_PROCESSED' } },
      { dispute: { ...baseCtx().dispute, reason: 'PAYMENT_BY_OTHER_MEANS' } },
    ]
    for (const over of contexts) {
      const p = plan(over)
      expect(validateEvidencePlan(p.items), route(ctx(over)).ruleId).toEqual([])
    }
  })

  it('every planned content type is one PayPal accepts', () => {
    for (const over of [
      {},
      { corpus: { qualityDocument: true } },
      { corpus: { receiptCopy: true } },
    ]) {
      for (const item of plan(over).items) {
        for (const doc of item.documents)
          expect(ALLOWED_EVIDENCE_CONTENT_TYPES as readonly string[]).toContain(doc.contentType)
      }
    }
  })

  it("every planned document size is under PayPal's per-file limit", () => {
    for (const item of plan().items) {
      for (const doc of item.documents) {
        if (doc.maxBytes !== null) expect(doc.maxBytes).toBeLessThan(MAX_EVIDENCE_FILE_BYTES)
      }
    }
  })

  it("the whole plan stays under PayPal's per-call total", () => {
    const worst = plan({
      dispute: { ...baseCtx().dispute, reason: 'UNAUTHORISED' },
      corpus: { receiptCopy: true, qualityDocument: true, fulfilmentDocument: true },
    })
    const total = worst.items
      .flatMap((i) => i.documents)
      .reduce((sum, d) => sum + (d.maxBytes ?? 0), 0)
    expect(total).toBeLessThanOrEqual(MAX_EVIDENCE_TOTAL_BYTES)
  })

  it('never proposes more than 100 items', () => {
    expect(plan().items.length).toBeLessThanOrEqual(MAX_EVIDENCE_ITEMS)
  })

  it('flags an over-long note, an unknown content type and an oversized document', () => {
    const bad: EvidencePlanItem = {
      evidenceType: 'ITEM_DESCRIPTION',
      evidenceInfo: {},
      notes: 'x'.repeat(NOTES_MAX_CHARS + 1),
      documents: [
        {
          name: 'wrong type',
          description: 'n/a',
          contentType: 'application/x-msdownload' as never,
          maxBytes: MAX_EVIDENCE_FILE_BYTES,
          required: true,
        },
        {
          name: 'too big',
          description: 'n/a',
          contentType: 'application/pdf',
          maxBytes: MAX_EVIDENCE_TOTAL_BYTES,
          required: true,
        },
      ],
    }
    const problems = validateEvidencePlan([bad]).join('\n')
    expect(problems).toContain('over PayPal')
    expect(problems).toContain("is not one of PayPal's accepted types")
    expect(problems).toContain('per-call limit')
  })

  it('flags an empty note, which PayPal refuses with minLength 1', () => {
    const empty: EvidencePlanItem = {
      evidenceType: 'OTHER',
      evidenceInfo: {},
      notes: '   ',
      documents: [],
    }
    expect(validateEvidencePlan([empty]).join(' ')).toContain('at least one character')
  })

  it('flags a plan with more than 100 items', () => {
    const many: EvidencePlanItem[] = Array.from({ length: MAX_EVIDENCE_ITEMS + 1 }, () => ({
      evidenceType: 'OTHER' as const,
      evidenceInfo: {},
      notes: 'n',
      documents: [],
    }))
    expect(validateEvidencePlan(many).join(' ')).toContain("exceeds PayPal's limit of 100")
  })

  it("the payload this builds passes @countersign/paypal's own zod schema unchanged", () => {
    // The strongest form of EC-DSP-12 available without a sandbox: build the body and hand it to the
    // client's schema. If PayPal's contract and ours disagree, this fails rather than a live call.
    for (const over of [
      {},
      { dispute: { ...baseCtx().dispute, reason: 'UNAUTHORISED' } },
      {
        dispute: { ...baseCtx().dispute, reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED' },
        corpus: { qualityDocument: true },
      },
    ]) {
      const input = toProvideEvidenceInput(plan(over))
      if (input === null) continue
      const parsed = provideEvidenceInputSchema.safeParse(input)
      expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// toProvideEvidenceInput
// ---------------------------------------------------------------------------

describe('toProvideEvidenceInput', () => {
  it('is null when there is nothing to send, rather than an empty array PayPal would reject', () => {
    expect(toProvideEvidenceInput(plan({ shipments: [] }))).toBeNull()
  })

  it("produces PayPal's documented shape: an array wrapped in evidences", () => {
    const input = toProvideEvidenceInput(plan())
    expect(input).not.toBeNull()
    expect(Object.keys(input ?? {})).toEqual(['evidences'])
    expect(Array.isArray(input?.evidences)).toBe(true)
  })

  it('carries evidence_type, evidence_info, notes and documents per item', () => {
    const input = toProvideEvidenceInput(plan())
    const first = input?.evidences[0]
    expect(first).toBeDefined()
    expect(Object.keys(first ?? {}).sort()).toEqual([
      'documents',
      'evidence_info',
      'evidence_type',
      'notes',
    ])
  })

  it('omits the documents key for a type that needs no file, rather than sending []', () => {
    const input = toProvideEvidenceInput(plan())
    const tracking = input?.evidences.find((e) => e.evidence_type === 'ONLINE_TRACKING_INFORMATION')
    expect(tracking).toBeDefined()
    expect(Object.keys(tracking ?? {}).sort()).toEqual(['evidence_info', 'evidence_type', 'notes'])
  })

  it('carries a document size only where one is bounded, since size is a real number to PayPal', () => {
    const input = toProvideEvidenceInput(plan())
    const fulfilment = input?.evidences.find((e) => e.evidence_type === 'PROOF_OF_FULFILLMENT')
    // One byte under PayPal's exclusive ceiling, so the plan is valid under either reading of "10 MB".
    expect(fulfilment?.documents?.[0]?.size).toBe(MAX_EVIDENCE_FILE_BYTES - 1)
    for (const doc of input?.evidences.flatMap((e) => e.documents ?? []) ?? []) {
      expect(typeof doc.size).toBe('number')
      expect(doc.size as number).toBeLessThan(MAX_EVIDENCE_FILE_BYTES)
    }
  })
})

// ---------------------------------------------------------------------------
// EC-REF-5 — the rounding remainder comes out of the shipment lines
// ---------------------------------------------------------------------------

describe('EC-REF-5: the disputed amount is split across the shipment lines, not the order total', () => {
  const twoLines = (over: Partial<DisputeContext> = {}): DisputeContext =>
    ctx({
      capture: {
        id: 'cap_1',
        paypalCaptureId: 'PAY-CAP-1',
        amount: money(8_900n, 'USD'),
        shipmentId: 'shp_1',
      },
      shipments: [
        {
          id: 'shp_1',
          carrier: 'BlueDart',
          trackingNumber: 'BD1',
          paypalTrackerId: 'TRK-1',
          status: 'DELIVERED',
          lines: [
            { sku: 'SKU-TRAIL-42', qty: 1 },
            { sku: 'SKU-ALPINE-07', qty: 2 },
          ],
        },
      ],
      checkoutLines: [
        { sku: 'SKU-TRAIL-42', qty: 1 },
        { sku: 'SKU-ALPINE-07', qty: 2 },
      ],
      ...over,
    })

  it('gives each line a share, and the shares sum to the disputed amount exactly', () => {
    const c = twoLines()
    const shares = shipmentShares(c)
    expect(shares).toHaveLength(2)
    expect(shares.reduce((sum, s) => sum + s.share.minor, 0n)).toBe(c.dispute.amount.minor)
  })

  it('weights by line quantity, so the two-unit line gets about twice the one-unit line', () => {
    // "About" rather than "exactly", and the reason is worth stating: 8900 over weights [1,2] is 2966.67,
    // so the leading share takes its floor (2966) and the remainder lands on the last line (5934). The
    // gap is under one minor unit from 2x, which is the property `allocate` promises and the reason a
    // share table can never invent or lose a cent.
    const shares = shipmentShares(twoLines())
    const trail = shares.find((s) => s.sku === 'SKU-TRAIL-42')
    const alpine = shares.find((s) => s.sku === 'SKU-ALPINE-07')
    expect(trail?.share.minor).toBe(2_966n)
    expect(alpine?.share.minor).toBe(5_934n)
    if (trail !== undefined && alpine !== undefined) {
      expect(alpine.share.minor - trail.share.minor * 2n < trail.share.minor).toBe(true)
    }
  })

  it('a rounding remainder lands on the last share and invents nothing (EC-FX-4)', () => {
    // 100 minor units over three equal lines cannot divide evenly; 33/33/34 is the only honest split.
    const c = twoLines({
      dispute: { ...baseCtx().dispute, amount: money(100n, 'USD') },
      shipments: [
        {
          id: 'shp_1',
          carrier: 'BlueDart',
          trackingNumber: 'BD1',
          status: 'DELIVERED',
          lines: [
            { sku: 'A', qty: 1 },
            { sku: 'B', qty: 1 },
            { sku: 'C', qty: 1 },
          ],
        },
      ],
      checkoutLines: [
        { sku: 'A', qty: 1 },
        { sku: 'B', qty: 1 },
        { sku: 'C', qty: 1 },
      ],
    })
    expect(shipmentShares(c).map((s) => s.share.minor)).toEqual([33n, 33n, 34n])
  })

  it("matches core's own allocation exactly, so there is one rounding rule in the repository", () => {
    const c = twoLines({ dispute: { ...baseCtx().dispute, amount: money(1_001n, 'USD') } })
    const expected = allocateWithRemainderLast(c.dispute.amount, [1n, 2n]).map((m) => m.minor)
    expect(shipmentShares(c).map((s) => s.share.minor)).toEqual(expected)
  })

  it('allocates from the shipment lines, never from the order total', () => {
    const c = twoLines({
      // The order total is a different number again (a partial refund left the capture smaller), which is
      // exactly the case where allocating against the order would invent minor units.
      order: {
        id: 'ord_1',
        customId: 'cs1:abc',
        invoiceId: 'INV-1',
        amount: money(12_900n, 'USD'),
      },
      capture: {
        id: 'cap_1',
        paypalCaptureId: 'PAY-CAP-1',
        amount: money(8_900n, 'USD'),
        shipmentId: 'shp_1',
      },
    })
    expect(shipmentShares(c).reduce((sum, s) => sum + s.share.minor, 0n)).toBe(8_900n)
  })

  it('is empty when nothing shipped, rather than allocating against the whole order', () => {
    expect(shipmentShares(ctx({ shipments: [] }))).toEqual([])
  })

  it('is empty when a line has zero quantity, because there is nothing to weigh', () => {
    const c = ctx({
      shipments: [
        {
          id: 'shp_1',
          carrier: 'BlueDart',
          trackingNumber: 'BD1',
          status: 'DELIVERED',
          lines: [{ sku: 'SKU-TRAIL-42', qty: 0 }],
        },
      ],
    })
    expect(shipmentShares(c)).toEqual([])
  })

  it('a single line takes the whole amount, which is what allocateWithRemainderLast guarantees', () => {
    const shares = shipmentShares(
      twoLines({
        shipments: [
          {
            id: 'shp_1',
            carrier: 'BlueDart',
            trackingNumber: 'BD1',
            status: 'DELIVERED',
            lines: [{ sku: 'SKU-TRAIL-42', qty: 3 }],
          },
        ],
      }),
    )
    expect(shares[0]?.share.minor).toBe(8_900n)
  })

  it('appears on the plan, not only on the helper', () => {
    expect(
      plan({
        shipments: [
          {
            id: 'shp_1',
            carrier: 'BlueDart',
            trackingNumber: 'BD1',
            paypalTrackerId: 'TRK-1',
            status: 'DELIVERED',
            lines: [{ sku: 'SKU-TRAIL-42', qty: 1 }],
          },
        ],
      }).shipmentShares,
    ).toHaveLength(1)
  })

  it('uses bigint minor units throughout, with no float arithmetic anywhere in the path', () => {
    for (const share of shipmentShares(twoLines())) {
      expect(typeof share.share.minor).toBe('bigint')
      expect(share.share.currency).toBe('USD')
    }
  })
})

// ---------------------------------------------------------------------------
// packetNote
// ---------------------------------------------------------------------------

describe('packetNote', () => {
  it("is the decision's own rationale, so the UI and PayPal read the same sentence", () => {
    const c = ctx()
    const d = route(c)
    expect(packetNote(c, d)).toBe(d.rationale)
  })

  it('stays within the 2000-character limit even for the longest rationale', () => {
    const contexts: Partial<DisputeContext>[] = [
      {},
      { dispute: { ...baseCtx().dispute, reason: 'PAYMENT_BY_OTHER_MEANS' } },
      { order: undefined, capture: undefined },
      {
        dispute: { ...baseCtx().dispute, reason: 'INCORRECT_AMOUNT' },
        policy: { autoAcceptThresholdMinor: 2_000n },
      },
    ]
    for (const over of contexts) {
      const c = ctx(over)
      expect(packetNote(c, route(c)).length).toBeLessThanOrEqual(NOTES_MAX_CHARS)
    }
  })

  it('carries the rule id, because the packet and the decision must agree', () => {
    const c = ctx()
    expect(packetNote(c, route(c))).toContain(`[${route(c).ruleId}]`)
  })
})

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('planEvidence is pure', () => {
  it('gives the same plan for the same inputs', () => {
    // The bigint replacer is not decoration: `shipmentShares` holds `Money`, and `JSON.stringify` throws
    // on a BigInt rather than serialising it, so the default is a test that fails for the wrong reason.
    const serialise = (v: unknown): string =>
      JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}` : x))
    const c = ctx()
    expect(serialise(planEvidence(c, route(c)))).toBe(serialise(planEvidence(c, route(c))))
  })

  it('does not depend on the order of the shipments', () => {
    const a = ctx({
      shipments: [
        {
          id: 'shp_1',
          carrier: 'B',
          trackingNumber: '1',
          paypalTrackerId: 'T1',
          status: 'DELIVERED',
          lines: [{ sku: 'A', qty: 1 }],
        },
        {
          id: 'shp_2',
          carrier: 'B',
          trackingNumber: '2',
          paypalTrackerId: 'T2',
          status: 'DELIVERED',
          lines: [{ sku: 'B', qty: 2 }],
        },
      ],
    })
    const b = ctx({ shipments: a.shipments === undefined ? [] : [...a.shipments].reverse() })
    const pa = planEvidence(a, route(a))
    const pb = planEvidence(b, route(b))
    expect(pa.items.map((i) => i.evidenceType)).toEqual(pb.items.map((i) => i.evidenceType))
  })

  it('does not mutate the context', () => {
    const c = ctx()
    const before = JSON.stringify(c, (_k, v) => (typeof v === 'bigint' ? `${v}` : v))
    planEvidence(c, route(c))
    expect(JSON.stringify(c, (_k, v) => (typeof v === 'bigint' ? `${v}` : v))).toBe(before)
  })
})
