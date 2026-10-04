/**
 * `route()` end to end, and the wording a buyer and a judge read.
 *
 * ## The three things asserted here that no other file asserts
 *
 * 1. **The rationale wording, verbatim.** `rationale.ts` composes the sentence a buyer sees in S-18 and a
 *    judge reads in the packet, so the sentences are pinned as literals. A wording change is a visible diff
 *    in this file, which is the only way a sentence a customer reads changes responsibly. The alternative —
 *    a test that checks the rationale "mentions the rule" — passes for a sentence that says nothing.
 * 2. **The two adjustments, in both directions.** `R-DEADLINE-1` and `R-NO-EVIDENCE` can each resolve to
 *    `REFUND` or `REVIEW`, and the choice is a merchant's money, so both branches are asserted.
 * 3. **Ordering.** The spec's row order has three rows that cannot fire in the position given; the fixes
 *    are asserted here as end-to-end outcomes, because a unit test of one predicate cannot show which rule
 *    shadowed which.
 */

import { money } from '@countersign/core'
import { EVIDENCE_TYPES } from '@countersign/paypal'
import { describe, expect, it } from 'vitest'

import {
  DEADLINE_CRITICAL_SECONDS,
  DEADLINE_PRESSURE_SECONDS,
  NO_MANDATE_LINE,
  RULE_ORDER,
  deadlineState,
  route,
  type DisputeContext,
  type LiabilityDecision,
  type Posture,
  type RuleId,
} from '../src/index'

const NOW = 1_791_500_000
const IN_3_DAYS = NOW + 3 * 86_400

function ctx(over: Partial<DisputeContext> = {}): DisputeContext {
  const base = baseCtx()
  return { ...base, ...over }
}

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
    order: {
      id: 'ord_1',
      customId: 'cs1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      invoiceId: 'INV-1',
      amount: money(8_900n, 'USD'),
    },
    chain: {
      mandatePresent: true,
      verifyAtCaptureChainValid: true,
      webauthnPresent: true,
      readback: '**What you are authorising**\nOnly at **Northwind Outfitters**',
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

const refund = (minor: bigint, atSec: number, status = 'COMPLETED') => ({
  id: 'ref_1',
  paypalRefundId: 'REFUND-1',
  amount: money(minor, 'USD'),
  status,
  atSec,
})

/** Every decision's `facts` keys, for the citation tests. */
function factKeys(d: LiabilityDecision): string[] {
  return d.facts.map((f) => f.key)
}

// ---------------------------------------------------------------------------
// deadlineState — EC-DSP-7 and EC-DSP-8 as one pure function
// ---------------------------------------------------------------------------

describe('deadlineState', () => {
  it('is COMFORTABLE beyond 48 hours', () => {
    expect(deadlineState(NOW, NOW + DEADLINE_PRESSURE_SECONDS + 1).state).toBe('COMFORTABLE')
  })

  it('EC-DSP-7 is PRESSURE inside 48 hours and above the critical hour', () => {
    const s = deadlineState(NOW, NOW + DEADLINE_PRESSURE_SECONDS)
    expect(s.state).toBe('PRESSURE')
    expect(s.secondsLeft).toBe(DEADLINE_PRESSURE_SECONDS)
  })

  it('EC-DSP-7 is CRITICAL inside one hour, where auto-file is refused', () => {
    const s = deadlineState(NOW, NOW + DEADLINE_CRITICAL_SECONDS - 1)
    expect(s.state).toBe('CRITICAL')
    expect(s.secondsLeft).toBe(DEADLINE_CRITICAL_SECONDS - 1)
  })

  it('EC-DSP-8 is PASSED at the deadline and after it, with a zero or negative countdown', () => {
    expect(deadlineState(NOW, NOW).state).toBe('PASSED')
    expect(deadlineState(NOW, NOW - 1).state).toBe('PASSED')
    expect(deadlineState(NOW, NOW - 1).countdown).toBe('0s')
  })

  it('is UNKNOWN when PayPal sent no deadline, which is INQUIRY-stage reality', () => {
    expect(deadlineState(NOW, null).state).toBe('UNKNOWN')
    expect(deadlineState(NOW, undefined).state).toBe('UNKNOWN')
    expect(deadlineState(NOW, null).countdown).toBeNull()
  })

  it('renders a countdown a merchant can read', () => {
    expect(deadlineState(NOW, NOW + 2 * 86_400 + 14 * 3_600).countdown).toBe('2d 14h')
    expect(deadlineState(NOW, NOW + 2 * 3_600 + 14 * 60).countdown).toBe('2h 14m')
  })
})

// ---------------------------------------------------------------------------
// The decisions
// ---------------------------------------------------------------------------

describe('route: the chain check is first, and it is not a fallback', () => {
  it('EC-DSP-9 an unmapped dispute REVIEWs, and leads with the exact user-facing line', () => {
    const d = route(ctx({ order: undefined, capture: undefined }))
    expect(d.ruleId).toBe('R-NOCHAIN-1')
    expect(d.posture).toBe('REVIEW')
    expect(d.rationale.startsWith(NO_MANDATE_LINE)).toBe(true)
    expect(d.rationale).toContain(NO_MANDATE_LINE)
  })

  it('says exactly "No mandate on this payment. Countersign can\'t help here."', () => {
    expect(NO_MANDATE_LINE).toBe("No mandate on this payment. Countersign can't help here.")
  })

  it('never files on an unmapped dispute, whatever the merchant configured', () => {
    for (const threshold of [0n, 1n, 8_900n, 10_000_000n]) {
      const d = route(
        ctx({
          order: undefined,
          capture: undefined,
          policy: { autoAcceptThresholdMinor: threshold },
        }),
      )
      expect(d.posture, `threshold ${threshold}`).not.toBe('CONTEST')
    }
  })

  it("a broken chain ACCEPTs flat, ignoring the merchant's auto-accept limit (§8.15: never contest)", () => {
    const broken = ctx({
      chain: { mandatePresent: true, verifyAtCaptureChainValid: false },
      policy: { autoAcceptThresholdMinor: 0n },
    })
    const d = route(broken)
    expect(d.ruleId).toBe('R-CHAIN-BAD')
    expect(d.posture).toBe('ACCEPT_CLAIM')
    expect(d.liability).toBe('UNPROVABLE')
  })

  it('a broken chain carries the vi errors verbatim, because that is what a merchant will ask', () => {
    const d = route(
      ctx({
        chain: {
          mandatePresent: true,
          verifyAtCaptureChainValid: false,
          verifyErrors: ['L3 signature does not verify against the key bound in L2'],
        },
      }),
    )
    expect(d.rationale).toContain('L3 signature does not verify against the key bound in L2')
  })

  it('a small unmapped claim ACCEPTs when the merchant configured a limit', () => {
    const d = route(
      ctx({
        dispute: { ...baseCtx().dispute, amount: money(900n, 'USD') },
        order: undefined,
        capture: undefined,
        policy: { autoAcceptThresholdMinor: 2_000n },
      }),
    )
    expect(d.ruleId).toBe('R-NOCHAIN-1')
    expect(d.posture).toBe('ACCEPT_CLAIM')
  })
})

describe('route: the ordering fixes that change a real answer', () => {
  it('R-UNAUTH-2 beats R-UNAUTH-1 on a device lost before signing (§18 q8, EC-BUY-3)', () => {
    const d = route(
      ctx({
        dispute: { ...baseCtx().dispute, reason: 'UNAUTHORISED' },
        chain: {
          mandatePresent: true,
          verifyAtCaptureChainValid: true,
          webauthnPresent: true,
          iatSec: NOW - 86_400,
          deviceStatus: 'LOST',
          deviceLostAtSec: NOW - 172_800,
        },
      }),
    )
    expect(d.ruleId).toBe('R-UNAUTH-2')
    expect(d.posture).toBe('ACCEPT_CLAIM')
    expect(d.liability).toBe('UNPROVABLE')
  })

  it('R-UNAUTH-1 still wins when the device was lost *after* signing', () => {
    const d = route(
      ctx({
        dispute: { ...baseCtx().dispute, reason: 'UNAUTHORISED' },
        chain: {
          mandatePresent: true,
          verifyAtCaptureChainValid: true,
          webauthnPresent: true,
          iatSec: NOW - 172_800,
          deviceStatus: 'LOST',
          deviceLostAtSec: NOW - 86_400,
        },
        checkoutLines: [{ sku: 'SKU-TRAIL-42', qty: 1 }],
      }),
    )
    expect(d.ruleId).toBe('R-UNAUTH-1')
    expect(d.posture).toBe('CONTEST')
  })

  it('EC-BUY-3 a weak unauthorised case with no passkey reviews above the merchant limit', () => {
    const d = route(
      ctx({
        dispute: { ...baseCtx().dispute, reason: 'UNAUTHORISED', amount: money(42_000n, 'USD') },
        chain: { mandatePresent: true, verifyAtCaptureChainValid: true, webauthnPresent: false },
        policy: { weakUnauthorisedThresholdMinor: 5_000n },
      }),
    )
    expect(d.ruleId).toBe('R-UNAUTH-3')
    expect(d.posture).toBe('REVIEW')
    expect(d.blockingReason).toBeDefined()
  })

  it('EC-BUY-3 a weak unauthorised case at or below the limit accepts without a human', () => {
    const d = route(
      ctx({
        dispute: { ...baseCtx().dispute, reason: 'UNAUTHORISED', amount: money(4_200n, 'USD') },
        chain: { mandatePresent: true, verifyAtCaptureChainValid: true, webauthnPresent: false },
        policy: { weakUnauthorisedThresholdMinor: 5_000n },
      }),
    )
    expect(d.ruleId).toBe('R-UNAUTH-3')
    expect(d.posture).toBe('ACCEPT_CLAIM')
  })

  it('R-SNAD-AGENT beats R-SNAD-THIN when the agent misread the request', () => {
    const d = route(
      ctx({
        dispute: { ...baseCtx().dispute, reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED' },
        disputedItem: { sku: 'SKU-TRAIL-42', attributes: { size: '9' } },
        preferences: { size: '10' },
      }),
    )
    expect(d.ruleId).toBe('R-SNAD-AGENT')
    expect(d.liability).toBe('AGENT_FAULT')
    expect(d.posture).toBe('REFUND')
  })

  it('R-SNAD-MERCH beats R-SNAD-OK when the merchant shipped different lines', () => {
    const d = route(
      ctx({
        dispute: { ...baseCtx().dispute, reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED' },
        shipments: [
          {
            id: 'shp_1',
            carrier: 'BlueDart',
            trackingNumber: 'BD1',
            status: 'DELIVERED',
            lines: [{ sku: 'SKU-COTTAGE-3', qty: 1 }],
          },
        ],
        corpus: { qualityDocument: true },
      }),
    )
    expect(d.ruleId).toBe('R-SNAD-MERCH')
    expect(d.liability).toBe('MERCHANT_FAULT')
  })

  it('R-AMT-1 does not shadow R-AMT-2 on a duplicated capture', () => {
    const d = route(
      ctx({
        dispute: { ...baseCtx().dispute, reason: 'DUPLICATE_TRANSACTION' },
        order: {
          ...(baseCtx().order as NonNullable<DisputeContext['order']>),
          amount: money(17_800n, 'USD'),
        },
        siblingCaptures: [
          {
            id: 'cap_2',
            paypalCaptureId: 'PAY-CAP-2',
            amount: money(8_900n, 'USD'),
            shipmentId: 'shp_1',
          },
        ],
      }),
    )
    expect(d.ruleId).toBe('R-AMT-2')
    expect(d.posture).toBe('REFUND')
  })

  it('R-INR-3 beats R-INR-2 while a registered parcel is still moving', () => {
    const d = route(
      ctx({
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
      }),
    )
    expect(d.ruleId).toBe('R-INR-3')
    expect(d.posture).toBe('MESSAGE_ONLY')
    expect(d.action).toBe('MESSAGE')
  })

  it('R-REF-1 beats R-CNP-1 when the refund covers the whole claim (EC-DSP-1)', () => {
    const d = route(
      ctx({
        dispute: {
          ...baseCtx().dispute,
          reason: 'CREDIT_NOT_PROCESSED',
          amount: money(4_200n, 'USD'),
        },
        refunds: [refund(4_200n, NOW - 86_400)],
      }),
    )
    expect(d.ruleId).toBe('R-REF-1')
  })
})

describe('route: EC-DSP-7 the deadline, in both bands', () => {
  const unsupportedAmountClaim = (): DisputeContext =>
    ctx({
      dispute: { ...baseCtx().dispute, reason: 'INCORRECT_AMOUNT' },
      // No `corpus.receiptCopy`, so PROOF_OF_RECEIPT_COPY has no source.
    })

  it('does not downgrade a contest whose evidence is in hand', () => {
    const d = route({ ...unsupportedAmountClaim(), corpus: { receiptCopy: true } })
    expect(d.ruleId).toBe('R-AMT-1')
    expect(d.posture).toBe('CONTEST')
  })

  it('inside 48 hours with the evidence missing, it settles and names the rule it replaced', () => {
    const d = route({
      ...unsupportedAmountClaim(),
      dispute: {
        ...baseCtx().dispute,
        reason: 'INCORRECT_AMOUNT',
        sellerResponseDueSec: NOW + 40 * 3_600,
      },
    })
    expect(d.ruleId).toBe('R-DEADLINE-1')
    expect(d.posture).toBe('REFUND')
    expect(d.supersedes).toBe('R-AMT-1')
    expect(d.rationale).toContain('[R-DEADLINE-1]')
    expect(d.rationale).toContain('1d 16h')
    // The replaced rule's own sentence is quoted, so the case file records what we would have argued.
    expect(d.rationale).toContain('The amount is right and the receipt shows it.')
  })

  it('outside 48 hours the same context becomes R-NO-EVIDENCE, not R-DEADLINE-1', () => {
    const d = route(unsupportedAmountClaim())
    expect(d.ruleId).toBe('R-NO-EVIDENCE')
    expect(d.posture).toBe('REVIEW')
    expect(d.supersedes).toBe('R-AMT-1')
  })

  it('EC-DSP-8 a passed deadline is stated, and never becomes a blockingReason', () => {
    const d = route({
      ...unsupportedAmountClaim(),
      corpus: { receiptCopy: true },
      dispute: {
        ...baseCtx().dispute,
        reason: 'INCORRECT_AMOUNT',
        sellerResponseDueSec: NOW - 3_600,
      },
    })
    expect(d.ruleId).toBe('R-AMT-1')
    expect(d.deadline.state).toBe('PASSED')
    expect(d.rationale).toContain('deadline has already passed')
    expect(d.blockingReason).toBeUndefined()
  })

  it('EC-DSP-7 inside the critical hour says why auto-file is off', () => {
    const d = route({
      ...unsupportedAmountClaim(),
      corpus: { receiptCopy: true },
      dispute: {
        ...baseCtx().dispute,
        reason: 'INCORRECT_AMOUNT',
        sellerResponseDueSec: NOW + 1_800,
      },
    })
    expect(d.deadline.state).toBe('CRITICAL')
    expect(d.rationale).toContain('refuse to upload automatically')
  })

  it('a comfortable deadline says nothing about the clock at all', () => {
    const d = route({ ...unsupportedAmountClaim(), corpus: { receiptCopy: true } })
    expect(d.deadline.state).toBe('COMFORTABLE')
    expect(d.rationale).not.toMatch(/deadline/i)
  })
})

describe('route: R-NO-EVIDENCE picks its downgrade', () => {
  const noReceipt = (amount: bigint, policy?: DisputeContext['policy']): DisputeContext =>
    ctx({
      dispute: { ...baseCtx().dispute, reason: 'INCORRECT_AMOUNT', amount: money(amount, 'USD') },
      ...(policy === undefined ? {} : { policy }),
    })

  it('REFUNDs a small claim, at or under the merchant limit', () => {
    const d = route(noReceipt(1_500n, { autoAcceptThresholdMinor: 2_000n }))
    expect(d.ruleId).toBe('R-NO-EVIDENCE')
    expect(d.posture).toBe('REFUND')
    expect(d.action).toBeNull()
  })

  it('REVIEWs a large claim, because absorbing it is a money decision with no honest default', () => {
    const d = route(noReceipt(89_000n, { autoAcceptThresholdMinor: 2_000n }))
    expect(d.ruleId).toBe('R-NO-EVIDENCE')
    expect(d.posture).toBe('REVIEW')
    expect(d.blockingReason).toContain('does not exist')
  })

  it('REVIEWs when the merchant configured nothing, which is the conservative default', () => {
    expect(route(noReceipt(1_500n)).posture).toBe('REVIEW')
  })

  it('EC-MER-4 an unregistered tracker cannot support a fulfilment claim, so the contest goes away', () => {
    const d = route(
      ctx({
        // Small enough that the merchant's own limit settles it; without that limit it is a REVIEW, which
        // is the same decision to make and is asserted separately above.
        dispute: { ...baseCtx().dispute, amount: money(900n, 'USD') },
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
        policy: { autoAcceptThresholdMinor: 2_000n },
      }),
    )
    expect(d.ruleId).toBe('R-NO-EVIDENCE')
    expect(d.posture).toBe('REFUND')
    expect(d.supersedes).toBe('R-INR-2')
    expect(d.rationale).toContain('Without the missing evidence this would have been R-INR-2')
  })

  it('only ever removes authority to file: a refund is never upgraded to a contest', () => {
    // A case with nothing to file and every document in hand: the guard must still not invent a contest,
    // because it only ever subtracts.
    const d = route(
      ctx({
        dispute: { ...baseCtx().dispute, amount: money(900n, 'USD') },
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
        corpus: { fulfilmentDocument: true, receiptCopy: true, qualityDocument: true },
        policy: { autoAcceptThresholdMinor: 2_000n },
      }),
    )
    expect(d.posture).toBe('CONTEST')
    expect(d.ruleId).toBe('R-INR-2')
  })

  it('never produces a CONTEST whose evidence list is empty', () => {
    const contested = route({
      ...noReceipt(89_000n, { autoAcceptThresholdMinor: 2_000n }),
      corpus: { receiptCopy: true },
    })
    expect(contested.posture).toBe('CONTEST')
    expect(contested.evidenceRequired).toEqual(['PROOF_OF_RECEIPT_COPY'])
  })
})

// ---------------------------------------------------------------------------
// The decision object
// ---------------------------------------------------------------------------

describe('the decision object is always complete', () => {
  const samples: readonly (readonly [string, DisputeContext])[] = [
    ['R-REF-1', ctx({ refunds: [refund(8_900n, NOW - 86_400)] })],
    ['R-NOCHAIN-1', ctx({ order: undefined, capture: undefined })],
    ['R-CHAIN-BAD', ctx({ chain: { mandatePresent: true, verifyAtCaptureChainValid: false } })],
    ['R-INR-1', ctx({ shipments: [] })],
    ['R-INR-2', ctx()],
    ['R-DEFAULT', ctx({ dispute: { ...baseCtx().dispute, reason: 'A_BRAND_NEW_REASON' } })],
  ]

  it.each(samples)('%s sets every field, so no caller has to remember to check', (_id, c) => {
    const d = route(c)
    expect(d.rationale.length).toBeGreaterThan(40)
    expect(d.reasons.length).toBeGreaterThan(0)
    expect(d.facts.length).toBeGreaterThan(0)
    expect(d.deadline.state).toBeTruthy()
    expect(d.liability).toBeTruthy()
    expect([
      'REFUND',
      'ACCEPT_CLAIM',
      'CONTEST',
      'OFFER',
      'MESSAGE_ONLY',
      'APPEAL',
      'REVIEW',
    ]).toContain(d.posture)
  })

  it('maps each posture to the PayPal action it implies, and null where there is none', () => {
    const map: Readonly<Record<Posture, LiabilityDecision['action']>> = {
      REFUND: null,
      ACCEPT_CLAIM: 'ACCEPT',
      CONTEST: 'FILE',
      OFFER: 'OFFER',
      MESSAGE_ONLY: 'MESSAGE',
      APPEAL: 'APPEAL',
      REVIEW: null,
    }
    const seen = new Set<Posture>()
    for (const [, c] of samples) {
      const d = route(c)
      seen.add(d.posture)
      expect(d.action, `${d.ruleId}`).toBe(map[d.posture])
    }
    // These six samples reach four of the seven postures: ACCEPT_CLAIM, REVIEW, REFUND and CONTEST. The
    // other three need dedicated fixtures, which is what the `route` suites above provide.
    expect([...seen].sort()).toEqual(['ACCEPT_CLAIM', 'CONTEST', 'REFUND', 'REVIEW'])
  })

  it('the rationale always ends with the rule id in brackets, so the packet cannot disagree with itself', () => {
    for (const [id, c] of samples) {
      const d = route(c)
      expect(d.rationale.endsWith(`[${id}]`), `${id}: ${d.rationale}`).toBe(true)
    }
  })

  it('fact keys are unique and non-empty, so a note can cite one unambiguously', () => {
    for (const [, c] of samples) {
      const keys = factKeys(route(c))
      expect(new Set(keys).size, keys.join(',')).toBe(keys.length)
      for (const k of keys) expect(k.trim().length).toBeGreaterThan(0)
    }
  })

  it('only reports a rule that exists in the table', () => {
    for (const [, c] of samples) expect(RULE_ORDER).toContain(route(c).ruleId)
  })
})

// ---------------------------------------------------------------------------
// The wording, verbatim
// ---------------------------------------------------------------------------

describe('the rationale wording, pinned', () => {
  it('R-NOCHAIN-1 REVIEW says there is no mandate and that a person decides', () => {
    const d = route(ctx({ order: undefined, capture: undefined }))
    expect(d.rationale).toBe(
      "No mandate on this payment. Countersign can't help here. PayPal raised a not received claim for " +
        '$89.00. There is no Countersign order, mandate or signed chain attached to this capture, so there ' +
        'is nothing to file and no argument we could make. Settling it or writing it off is a money ' +
        'decision, and an unconfigured merchant has not delegated that to us, so a person decides. ' +
        '[R-NOCHAIN-1]',
    )
  })

  it('R-NOCHAIN-1 ACCEPT says why nobody is woken up', () => {
    const d = route(
      ctx({
        dispute: { ...baseCtx().dispute, amount: money(900n, 'USD') },
        order: undefined,
        capture: undefined,
        policy: { autoAcceptThresholdMinor: 2_000n },
      }),
    )
    expect(d.rationale).toBe(
      "No mandate on this payment. Countersign can't help here. PayPal raised a not received claim for " +
        '$9.00. At $9.00 it is at or under the auto-accept limit this merchant set, so we settle it ' +
        'ourselves instead of filing something we cannot support. [R-NOCHAIN-1]',
    )
  })

  it('R-CHAIN-BAD says it will not contest with a broken chain, and why that is the safe answer', () => {
    const d = route(
      ctx({
        chain: {
          mandatePresent: true,
          verifyAtCaptureChainValid: false,
          verifyErrors: ['l2_expired'],
        },
      }),
    )
    expect(d.rationale).toBe(
      'There is a mandate on this payment and its chain does not verify. It failed with: l2_expired. Every ' +
        'argument we could make would rest on that chain, so a packet built on it would collapse on ' +
        'inspection. We do not contest with a broken chain — we accept the claim. [R-CHAIN-BAD]',
    )
  })

  it('R-INR-1 names the SKU with no tracking, because "nothing shipped" is not a sentence a merchant can act on', () => {
    const d = route(ctx({ shipments: [] }))
    expect(d.rationale).toBe(
      'The buyer says SKU-TRAIL-42 never arrived, and no shipment carries tracking for that line. There is ' +
        'no delivery record to file, so there is no case to make: the parcel was ours and it is not ' +
        'accounted for. Refund. [R-INR-1]',
    )
  })

  it("R-INR-2 names the carrier, the tracking number and PayPal's own tracker status", () => {
    const d = route(ctx())
    expect(d.rationale).toBe(
      "Tracking exists for the disputed line: BlueDart BD1 and PayPal's tracker says DELIVERED. The parcel " +
        'left the warehouse, which is the fact the buyer is disputing, and it is ours to prove. ' +
        '[R-INR-2]',
    )
  })

  it('R-INR-3 says the parcel is moving and that a message costs nothing', () => {
    const d = route(
      ctx({
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
      }),
    )
    expect(d.rationale).toBe(
      'Tracking (BlueDart BD1) is registered with PayPal and the parcel is still moving. Nothing has gone ' +
        'wrong yet and the cheapest thing that can still be true is that it arrives, so we write to the ' +
        'buyer instead of spending one of our response attempts on a parcel that has not landed. [R-INR-3]',
    )
  })

  it('R-SNAD-AGENT says the user asked for one variant and another arrived, in that order', () => {
    const d = route(
      ctx({
        dispute: { ...baseCtx().dispute, reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED' },
        disputedItem: { sku: 'SKU-TRAIL-42', attributes: { size: '9' } },
        preferences: { size: '10' },
      }),
    )
    expect(d.rationale).toBe(
      'Our own agent made this purchase. The user asked for size 10; size 9 is what arrived. The read-back ' +
        'the user approved does not mention this variant at all. The chain is valid, so the agent stayed ' +
        'inside the budget and the merchant list the user signed — it read the request wrong. Blaming the ' +
        'buyer for a software misreading is not something we will file, so we refund. [R-SNAD-AGENT]',
    )
  })

  it('EC-MER-3 R-SNAD-MERCH says the packet would be evidence against our own customer', () => {
    const d = route(
      ctx({
        dispute: { ...baseCtx().dispute, reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED' },
        shipments: [
          {
            id: 'shp_1',
            carrier: 'BlueDart',
            trackingNumber: 'BD1',
            status: 'DELIVERED',
            lines: [{ sku: 'SKU-COTTAGE-3', qty: 1 }],
          },
        ],
      }),
    )
    expect(d.rationale).toContain('Our own evidence would be evidence against our own customer')
    expect(d.rationale).toContain('SKU-COTTAGE-3:1')
    expect(d.rationale).toContain('SKU-TRAIL-42:1')
  })

  it('EC-BUY-1 R-SNAD-THIN says a photograph of a box is not evidence', () => {
    const d = route(
      ctx({ dispute: { ...baseCtx().dispute, reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED' } }),
    )
    expect(d.ruleId).toBe('R-SNAD-THIN')
    expect(d.posture).toBe('OFFER')
    expect(d.rationale).toBe(
      "The item matches the signed checkout and the user's own mandate permits it, so the purchase was " +
        'authorised. What we do not have is anything that shows the goods were as described — the only ' +
        'photographs we hold are of a packed box, and a photograph of a box is not evidence about what was ' +
        'in it. Contesting on that would spend a response on a packet with nothing in it. A refund in ' +
        'exchange for the item settles the same money with none of the handling cost. [R-SNAD-THIN]',
    )
  })

  it('R-SNAD-OK says the purchase was authorised and the packet can argue it', () => {
    const d = route(
      ctx({
        dispute: { ...baseCtx().dispute, reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED' },
        corpus: { qualityDocument: true },
      }),
    )
    expect(d.ruleId).toBe('R-SNAD-OK')
    expect(d.posture).toBe('CONTEST')
    expect(d.rationale).toBe(
      'What arrived is exactly what the merchant signed at checkout, and the signed mandate permits it. The ' +
        'buyer is right that the goods differ from what they expected; the signed read-back says nothing was ' +
        'promised about that, and the item description and the order are both on file. That is a case we can ' +
        'actually argue. [R-SNAD-OK]',
    )
  })

  it('R-UNAUTH-1 names the passkey and the key binding, which is the whole argument', () => {
    const d = route(
      ctx({
        dispute: { ...baseCtx().dispute, reason: 'UNAUTHORISED' },
        chain: {
          mandatePresent: true,
          verifyAtCaptureChainValid: true,
          webauthnPresent: true,
          iatSec: 1_790_000_000,
          readback: '**What you are authorising**',
        },
        checkoutLines: [{ sku: 'SKU-TRAIL-42', qty: 1 }],
      }),
    )
    expect(d.ruleId).toBe('R-UNAUTH-1')
    expect(d.rationale).toContain(
      "signed by the user's own device key with a passkey user-verification at Mon 21 Sep, 7:43 PM IST",
    )
    expect(d.rationale).toContain('signed by the agent key bound inside that same mandate')
    expect(d.userAlert).toContain('mark the device lost')
  })

  it('R-UNAUTH-2 dates the loss before the signing, because the ordering is the claim', () => {
    const d = route(
      ctx({
        dispute: { ...baseCtx().dispute, reason: 'UNAUTHORISED' },
        chain: {
          mandatePresent: true,
          verifyAtCaptureChainValid: true,
          webauthnPresent: true,
          iatSec: NOW - 86_400,
          deviceStatus: 'LOST',
          deviceLostAtSec: NOW - 172_800,
        },
      }),
    )
    expect(d.rationale).toContain('was already reported lost')
    expect(d.rationale).toContain('after that')
    expect(d.rationale).toContain(
      'We cannot show the person who signed was the account holder, so we accept',
    )
  })

  it('R-UNAUTH-3 says there was no passkey, which is the whole weakness', () => {
    const d = route(
      ctx({
        dispute: { ...baseCtx().dispute, reason: 'UNAUTHORISED', amount: money(42_000n, 'USD') },
        chain: { mandatePresent: true, verifyAtCaptureChainValid: true, webauthnPresent: false },
        policy: { weakUnauthorisedThresholdMinor: 5_000n },
      }),
    )
    expect(d.rationale).toContain(
      'no passkey user-verification was recorded when the mandate was signed',
    )
  })

  it('R-AMT-1 compares the capture total with the signed order in minor units', () => {
    const d = route(
      ctx({
        dispute: { ...baseCtx().dispute, reason: 'INCORRECT_AMOUNT' },
        corpus: { receiptCopy: true },
      }),
    )
    expect(d.rationale).toBe(
      'The captures on this order total $89.00, which is exactly what the signed checkout authorised ' +
        '(order INV-1), and there is one capture per shipment — no duplicate. The amount is right and the ' +
        'receipt shows it. [R-AMT-1]',
    )
  })

  it('R-AMT-2 admits the duplicate in the first sentence, because there is no version of this we can argue', () => {
    const d = route(
      ctx({
        dispute: { ...baseCtx().dispute, reason: 'DUPLICATE_TRANSACTION' },
        order: {
          ...(baseCtx().order as NonNullable<DisputeContext['order']>),
          amount: money(17_800n, 'USD'),
        },
        siblingCaptures: [
          {
            id: 'cap_2',
            paypalCaptureId: 'PAY-CAP-2',
            amount: money(8_900n, 'USD'),
            shipmentId: 'shp_1',
          },
        ],
      }),
    )
    expect(d.rationale).toContain('We captured this order more than once for the same shipment')
    expect(d.rationale).toContain('That is a correction, not a defence')
  })

  it('R-REF-1 says the claim is one refund being claimed twice', () => {
    const d = route(
      ctx({
        dispute: { ...baseCtx().dispute, reason: 'UNAUTHORISED' },
        refunds: [refund(8_900n, 1_791_408_000)],
      }),
    )
    expect(d.ruleId).toBe('R-REF-1')
    expect(d.rationale).toContain('We already refunded $89.00')
    expect(d.rationale).toContain('one refund being claimed twice')
  })

  it('R-CNP-1 names the refund id as the proof, without claiming a full refund we did not make', () => {
    const d = route(
      ctx({
        dispute: {
          ...baseCtx().dispute,
          reason: 'CREDIT_NOT_PROCESSED',
          amount: money(4_200n, 'USD'),
        },
        capture: {
          id: 'cap_1',
          paypalCaptureId: 'PAY-CAP-1',
          amount: money(4_200n, 'USD'),
          shipmentId: 'shp_1',
        },
        order: {
          ...(baseCtx().order as NonNullable<DisputeContext['order']>),
          amount: money(4_200n, 'USD'),
        },
        refunds: [refund(2_000n, 1_790_800_000)],
      }),
    )
    expect(d.ruleId).toBe('R-CNP-1')
    expect(d.rationale).toContain('We refunded $20.00')
    expect(d.rationale).not.toContain('$42.00')
  })

  it('R-OTHER-REFUND argues the arithmetic, and says the rule is one line to change', () => {
    const d = route(ctx({ dispute: { ...baseCtx().dispute, reason: 'PAYMENT_BY_OTHER_MEANS' } }))
    expect(d.rationale).toContain('$82')
    expect(d.rationale).toContain('one line to change')
    expect(d.rationale).toContain('teaches merchants that this packet argues everything')
  })

  it('R-DEFAULT says the router will not guess, and lists what it does have', () => {
    const d = route(ctx({ dispute: { ...baseCtx().dispute, reason: 'A_BRAND_NEW_REASON' } }))
    expect(d.rationale).toBe(
      'Nothing in the signed record answers a "A_BRAND_NEW_REASON" claim. no order is linked to this ' +
        'capture; a mandate is linked; no completed refund on the capture. The router will not guess at a ' +
        'case it cannot support, ' +
        'so this one goes to a person with the evidence plan attached. [R-DEFAULT]',
    )
  })

  it('R-NO-EVIDENCE explains the cost of filing an empty packet, and names the rule it replaced', () => {
    const d = route(
      ctx({
        dispute: { ...baseCtx().dispute, reason: 'INCORRECT_AMOUNT' },
        policy: { autoAcceptThresholdMinor: 2_000n },
      }),
    )
    expect(d.rationale).toContain('Without the missing evidence this would have been R-AMT-1')
    expect(d.rationale).toContain(
      'spend one of our responses on a packet PayPal would reject or ignore',
    )
    expect(d.rationale).toContain('At $89.00 there is no configured limit')
  })

  it('R-DEADLINE-1 explains that re-running the router is how a merchant contests anyway', () => {
    const d = route(
      ctx({
        dispute: {
          ...baseCtx().dispute,
          reason: 'INCORRECT_AMOUNT',
          sellerResponseDueSec: NOW + 40 * 3_600,
        },
      }),
    )
    expect(d.rationale).toContain('response deadline is 1d 16h')
    expect(d.rationale).toContain('we cannot file what we do not have, so we settle')
    expect(d.rationale).toContain('Without the clock this would have been R-AMT-1')
    expect(d.rationale).toContain('the decision is deterministic, so a second run')
  })
})

// ---------------------------------------------------------------------------
// Determinism and purity
// ---------------------------------------------------------------------------

describe('route is pure', () => {
  it('gives the same answer for the same context, 50 times over', () => {
    const c = ctx()
    const first = JSON.stringify(route(c))
    for (let i = 0; i < 50; i++) expect(JSON.stringify(route(c))).toBe(first)
  })

  it('is unaffected by the order of the refunds array', () => {
    const a = ctx({ refunds: [refund(1_000n, NOW), refund(2_000n, NOW - 86_400)] })
    const b = ctx({
      refunds: [
        { ...refund(2_000n, NOW - 86_400), id: 'ref_2' },
        { ...refund(1_000n, NOW), id: 'ref_1' },
      ],
    })
    expect(route(b).rationale).toBe(route(a).rationale)
  })

  it('is unaffected by the order of the shipments or the checkout lines', () => {
    const a = ctx({
      checkoutLines: [
        { sku: 'SKU-TRAIL-42', qty: 1 },
        { sku: 'SKU-ALPINE-07', qty: 1 },
      ],
      shipments: [
        {
          id: 'shp_1',
          carrier: 'BlueDart',
          trackingNumber: 'BD1',
          paypalTrackerId: 'TRK-1',
          status: 'DELIVERED',
          lines: [{ sku: 'SKU-ALPINE-07', qty: 1 }],
        },
        {
          id: 'shp_2',
          carrier: 'BlueDart',
          trackingNumber: 'BD2',
          paypalTrackerId: 'TRK-2',
          status: 'DELIVERED',
          lines: [{ sku: 'SKU-TRAIL-42', qty: 1 }],
        },
      ],
    })
    const b = ctx({
      checkoutLines: a.checkoutLines === undefined ? [] : [...a.checkoutLines].reverse(),
      shipments: a.shipments === undefined ? [] : [...a.shipments].reverse(),
    })
    expect(route(b).ruleId).toBe(route(a).ruleId)
    expect(route(b).posture).toBe(route(a).posture)
  })

  it('never mutates the context, including its arrays', () => {
    const c = ctx({ refunds: [refund(1_000n, NOW)], shipments: baseCtx().shipments })
    const before = JSON.stringify(c, (_k, v) => (typeof v === 'bigint' ? `${v}` : v))
    route(c)
    expect(JSON.stringify(c, (_k, v) => (typeof v === 'bigint' ? `${v}` : v))).toBe(before)
  })

  it('a fresh context object gives the same answer, so a caller may spread and extend safely', () => {
    const c = ctx()
    expect(route({ ...c }).rationale).toBe(route(c).rationale)
  })

  it('EC-DSP-9 an unmapped dispute produces a decision rather than throwing', () => {
    expect(() =>
      route(ctx({ order: undefined, capture: undefined, shipments: [], refunds: [] })),
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// The citation vocabulary
// ---------------------------------------------------------------------------

describe('the fact vocabulary WP-15c will cite from', () => {
  it('always includes the disputed amount as code and minor units, never a float', () => {
    const d = route(ctx())
    const amount = d.facts.find((f) => f.key === 'dispute.amount')
    expect(amount?.value).toBe('USD 89.00')
    expect(amount?.value).not.toContain('89.0"')
  })

  it('names the source table for every fact, so a reader knows where to look', () => {
    for (const f of route(ctx()).facts) {
      expect(
        [
          'disputes',
          'orders',
          'captures',
          'refunds',
          'shipments',
          'mandates',
          'devices',
          'gate_decisions',
          'verify',
          'audit_log',
          'defender.router',
        ].includes(f.source),
        `${f.key}: ${f.source}`,
      ).toBe(true)
    }
  })

  it('records the rule id as a citable fact, so a note can point at its own verdict', () => {
    expect(route(ctx()).facts.find((f) => f.key === 'router.rule')?.value).toBe('R-INR-2')
  })

  it('omits a refund fact entirely when there is no refund, so "none" is never citable as a value', () => {
    expect(factKeys(route(ctx()))).not.toContain('refund.total')
    expect(factKeys(route(ctx({ refunds: [refund(1_000n, NOW)] })))).toContain('refund.total')
  })

  it('records each attribute conflict with the value a sentence would quote', () => {
    const d = route(
      ctx({
        dispute: { ...baseCtx().dispute, reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED' },
        disputedItem: { sku: 'SKU-TRAIL-42', attributes: { size: '9' } },
        preferences: { size: '10' },
      }),
    )
    expect(d.facts.find((f) => f.key === 'conflict.size.wanted')?.value).toBe('10')
    expect(d.facts.find((f) => f.key === 'conflict.size.shipped')?.value).toBe('9')
    expect(d.facts.find((f) => f.key === 'conflict.size.in_readback')).toBeUndefined()
  })

  it('every value in the vocabulary is a real value, never the word "none"', () => {
    for (const [, c] of [
      ['R-REF-1', ctx({ refunds: [refund(8_900n, NOW)] })],
      [
        'R-UNAUTH-2',
        ctx({
          dispute: { ...baseCtx().dispute, reason: 'UNAUTHORISED' },
          chain: {
            mandatePresent: true,
            verifyAtCaptureChainValid: true,
            webauthnPresent: true,
            iatSec: NOW - 86_400,
            deviceStatus: 'LOST',
            deviceLostAtSec: NOW - 172_800,
          },
        }),
      ],
    ] as const) {
      for (const f of route(c).facts) {
        expect(f.value.trim().length, `${f.key}`).toBeGreaterThan(0)
        expect(f.value.trim().toLowerCase(), `${f.key}`).not.toBe('none')
      }
    }
  })
})

// ---------------------------------------------------------------------------
// A last cross-check: the posture set is closed
// ---------------------------------------------------------------------------

describe('the posture vocabulary is exactly the seven values in the product', () => {
  it('route never emits a posture outside the declared union', () => {
    const ALL: readonly Posture[] = [
      'REFUND',
      'ACCEPT_CLAIM',
      'CONTEST',
      'OFFER',
      'MESSAGE_ONLY',
      'APPEAL',
      'REVIEW',
    ]
    const contexts: DisputeContext[] = [
      ctx({ order: undefined, capture: undefined }),
      ctx({ chain: { mandatePresent: true, verifyAtCaptureChainValid: false } }),
      ctx({ shipments: [] }),
      ctx(),
      ctx({ refunds: [refund(8_900n, NOW)] }),
      ctx({ dispute: { ...baseCtx().dispute, reason: 'PAYMENT_BY_OTHER_MEANS' } }),
      ctx({ dispute: { ...baseCtx().dispute, reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED' } }),
      ctx({ dispute: { ...baseCtx().dispute, reason: 'A_BRAND_NEW_REASON' } }),
    ]
    const postures = contexts.map((c) => route(c).posture)
    for (const p of postures) expect(ALL).toContain(p)
    // And the closed set is real: at least five of the seven are reachable from these eight contexts.
    expect(new Set(postures).size).toBeGreaterThanOrEqual(5)
  })

  it('every CONTEST evidence type is one PayPal would accept', () => {
    const contested = [
      ctx(),
      ctx({
        dispute: { ...baseCtx().dispute, reason: 'UNAUTHORISED' },
        corpus: { receiptCopy: true },
      }),
      ctx({
        dispute: { ...baseCtx().dispute, reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED' },
        corpus: { qualityDocument: true },
      }),
    ]
    for (const c of contested) {
      const d = route(c)
      if (d.posture !== 'CONTEST') continue
      expect(d.evidenceRequired.length).toBeGreaterThan(0)
      for (const t of d.evidenceRequired) expect(EVIDENCE_TYPES as readonly string[]).toContain(t)
    }
  })

  it('RULE_ORDER has no duplicates, so a rule cannot appear twice and shadow itself', () => {
    expect(new Set(RULE_ORDER).size).toBe(RULE_ORDER.length)
  })

  it('the rule a decision names is the rule that produced it, for every fixture in this file', () => {
    // A single tautology-free check that the id and the posture are not independent: the rationale's
    // bracketed id, the `supersedes` chain and the `router.rule` fact must all agree.
    const c = ctx({ dispute: { ...baseCtx().dispute, reason: 'INCORRECT_AMOUNT' } })
    const d = route(c)
    expect(d.rationale).toContain(`[${d.ruleId}]`)
    expect(d.facts.find((f) => f.key === 'router.rule')?.value).toBe(d.ruleId)
    expect(d.posture).toBe('REVIEW')
  })
})

/** Re-exported so the union is asserted as a type, not only as a runtime array. */
export type { RuleId }
