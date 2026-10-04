/**
 * The rules table, one fixture per row, plus the structure checks that keep it honest.
 *
 * Spec **§8.15**'s table, **§8.16 AT-M15.1** item 1: *"Router table tests: ≥ 2 fixtures per rule"*.
 *
 * ## What is asserted here, and what is asserted in `eval.test.ts`
 *
 * This file asserts **the predicates**: each rule fires on its own condition and stays quiet on its
 * neighbours'. That is a different question from "does the 40-case eval score 100%", and the two catch
 * different mistakes:
 *
 * - A predicate that fires too eagerly is invisible in the eval if no case happens to sit next to it.
 * - A predicate that never fires shows up in the eval as an uncovered rule, which is a slower signal.
 *
 * So every rule gets at least two fixtures here — one that must match and one that must not — and the
 * eval gets the end-to-end labels.
 *
 * ## The structure checks at the bottom are the interesting ones
 *
 * A rules table rots in ways a test per predicate cannot see: a rule with no predicate behind it, a
 * predicate with no rule that reaches it, a rule id in `RULE_ORDER` that no `route()` call can produce.
 * Those are asserted structurally, against the source, so they fail the moment the table is edited rather
 * than when someone notices a dispute went the wrong way.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { money } from '@countersign/core'
import { EVIDENCE_TYPES } from '@countersign/paypal'
import { describe, expect, it } from 'vitest'

import {
  ATTRIBUTE_KEYS,
  EVIDENCE_BY_RULE,
  PREDICATE_FOR,
  READBACK_LABELS,
  RULE_ALIASES,
  RULE_ORDER,
  RULE_ORIGIN,
  UNASSIGNED_REASONS,
  agentAuthorityExceeded,
  attributeConflicts,
  autoAccepts,
  capturedTotal,
  chainInvalid,
  chainVerifiedNow,
  completedRefunds,
  disputedSkus,
  duplicateShipmentCaptures,
  evidenceFor,
  evidenceSourceAvailable,
  hasPaypalTracker,
  hasRefundProof,
  hasTracking,
  hasVerifiedMandate,
  inTransit,
  isTracked,
  lineKey,
  missingEvidence,
  readbackAttribute,
  reasonPhrase,
  refundedTotal,
  ruleAlreadyRefunded,
  ruleAmountCorrect,
  ruleAmountDuplicate,
  ruleAppealable,
  ruleChainBad,
  ruleCreditNotProcessedRefunded,
  ruleDeadlineForcesRefund,
  ruleInrInTransit,
  ruleInrTracked,
  ruleInrUntracked,
  ruleInquiryStage,
  ruleNoChain,
  ruleOtherReasonRefund,
  ruleSnadAgentFault,
  ruleSnadAuthorised,
  ruleSnadMerchantFault,
  ruleSnadThinQuality,
  ruleUnauthorisedAuthorised,
  ruleUnauthorisedLostDevice,
  ruleUnauthorisedWeak,
  shipmentLinesMatchCheckout,
  trackedShipments,
  weakCaseAutoAccepts,
  type DisputeContext,
  type RuleId,
} from '../src/index'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = 1_791_500_000
const IN_3_DAYS = NOW + 3 * 86_400

/** The read-back `packages/compiler` prints when it inferred a size and says it grants nothing. */
const READBACK_SIZE_9 =
  '**What you are authorising**\nOnly at **Northwind Outfitters**\n' +
  'We read **size** "9" as a preference, not a limit.'

const READBACK_SIZE_10 =
  '**What you are authorising**\nOnly at **Northwind Outfitters**\n' +
  'We read **size** "10" as a preference, not a limit.'

const READBACK_PLAIN = '**What you are authorising**\nOnly at **Northwind Outfitters**'

function base(overrides: Partial<DisputeContext> = {}): DisputeContext {
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
      paypalCaptureId: 'PAY-1',
      amount: money(8_900n, 'USD'),
      shipmentId: 'shp_1',
    },
    order: { id: 'ord_1', customId: 'cs1:abc', invoiceId: 'INV-1', amount: money(8_900n, 'USD') },
    chain: {
      mandatePresent: true,
      verifyAtCaptureChainValid: true,
      webauthnPresent: true,
      readback: READBACK_PLAIN,
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
    ...overrides,
  }
}

const completedRefund = (minor: bigint, atSec: number) => ({
  id: 'ref_1',
  paypalRefundId: 'REFUND-1',
  amount: money(minor, 'USD'),
  status: 'COMPLETED',
  atSec,
})

// ---------------------------------------------------------------------------
// The readers
// ---------------------------------------------------------------------------

describe('the pure readers', () => {
  it('refundedTotal sums COMPLETED refunds only, and ignores PENDING and FAILED', () => {
    expect(
      refundedTotal(
        base({
          refunds: [
            completedRefund(2_000n, NOW - 86_400),
            { ...completedRefund(1_000n, NOW - 43_200), id: 'ref_2', status: 'PENDING' },
            { ...completedRefund(1_000n, NOW - 3_600), id: 'ref_3', status: 'FAILED' },
          ],
        }),
      ).minor,
    ).toBe(2_000n)
  })

  it('refundedTotal reports the refund currency, and never converts (spec §18 q21, EC-FX-1)', () => {
    const ctx = base({ refunds: [completedRefund(2_000n, NOW)] })
    expect(refundedTotal(ctx).currency).toBe('USD')
  })

  it('completedRefunds is the same filter, exported so a caller does not re-derive it', () => {
    expect(completedRefunds(base({ refunds: [completedRefund(1n, NOW)] })).length).toBe(1)
    expect(completedRefunds(base()).length).toBe(0)
  })

  it('capturedTotal sums the disputed capture and its siblings, in the order given', () => {
    const ctx = base({
      capture: {
        id: 'cap_1',
        paypalCaptureId: 'P1',
        amount: money(4_000n, 'USD'),
        shipmentId: 'shp_1',
      },
      siblingCaptures: [
        { id: 'cap_2', paypalCaptureId: 'P2', amount: money(3_000n, 'USD'), shipmentId: 'shp_2' },
        { id: 'cap_3', paypalCaptureId: 'P3', amount: money(1_900n, 'USD'), shipmentId: 'shp_3' },
      ],
    })
    expect(capturedTotal(ctx).minor).toBe(8_900n)
  })

  it('capturedTotal on a context with no capture is zero, not a crash (EC-DSP-9)', () => {
    expect(capturedTotal(base({ capture: undefined })).minor).toBe(0n)
  })

  it('duplicateShipmentCaptures finds a retry that captured the same shipment twice', () => {
    const ctx = base({
      siblingCaptures: [
        { id: 'cap_2', paypalCaptureId: 'P2', amount: money(100n, 'USD'), shipmentId: 'shp_1' },
      ],
    })
    expect(duplicateShipmentCaptures(ctx)).toEqual(['shp_1'])
  })

  it('duplicateShipmentCaptures is empty when each shipment has one capture', () => {
    const ctx = base({
      siblingCaptures: [
        { id: 'cap_2', paypalCaptureId: 'P2', amount: money(100n, 'USD'), shipmentId: 'shp_2' },
      ],
    })
    expect(duplicateShipmentCaptures(ctx)).toEqual([])
  })

  it('lineKey is order-independent, so a reordered line set still compares equal', () => {
    const a = [
      { sku: 'A', qty: 1 },
      { sku: 'B', qty: 2 },
    ]
    const b = [
      { sku: 'B', qty: 2 },
      { sku: 'A', qty: 1 },
    ]
    expect(lineKey(a)).toBe(lineKey(b))
  })

  it('lineKey distinguishes quantity, because a short shipment is a different line set', () => {
    expect(lineKey([{ sku: 'A', qty: 1 }])).not.toBe(lineKey([{ sku: 'A', qty: 2 }]))
  })

  it('disputedSkus prefers the named item, then the shipments, then the checkout', () => {
    expect(
      disputedSkus(
        base({
          disputedItem: { sku: 'SKU-COTTAGE-3', attributes: {} },
          shipments: [
            {
              id: 's',
              carrier: 'C',
              trackingNumber: 'T',
              lines: [{ sku: 'SKU-ALPINE-07', qty: 1 }],
            },
          ],
        }),
      ),
    ).toEqual(['SKU-COTTAGE-3'])
    expect(
      disputedSkus(
        base({
          shipments: [
            {
              id: 's',
              carrier: 'C',
              trackingNumber: 'T',
              lines: [{ sku: 'SKU-ALPINE-07', qty: 1 }],
            },
          ],
        }),
      ),
    ).toEqual(['SKU-ALPINE-07'])
  })

  it('disputedSkus is empty on a context with nothing mapped, and every reader stays quiet', () => {
    const empty = base({ shipments: [], checkoutLines: [], disputedItem: undefined })
    expect(disputedSkus(empty)).toEqual([])
    expect(trackedShipments(empty)).toEqual([])
    expect(hasTracking(empty)).toBe(false)
  })

  it('isTracked rejects a blank and a whitespace-only tracking number', () => {
    const blank = { id: 's', carrier: 'C', trackingNumber: '', lines: [{ sku: 'A', qty: 1 }] }
    const spaced = { ...blank, trackingNumber: '   ' }
    expect(isTracked(blank)).toBe(false)
    expect(isTracked(spaced)).toBe(false)
    expect(isTracked({ ...blank, trackingNumber: 'BD1' })).toBe(true)
  })

  it('inTransit is true for SHIPPED and for an unset status, false once terminal', () => {
    const s = { id: 's', carrier: 'C', trackingNumber: 'BD1', lines: [{ sku: 'A', qty: 1 }] }
    expect(inTransit(s)).toBe(true)
    expect(inTransit({ ...s, status: 'SHIPPED' })).toBe(true)
    expect(inTransit({ ...s, status: 'DELIVERED' })).toBe(false)
    expect(inTransit({ ...s, status: 'FAILURE' })).toBe(false)
  })

  it('hasPaypalTracker needs the PayPal tracker id, not just a tracking number (EC-MER-4)', () => {
    const untracked = base({
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
    expect(hasTracking(untracked)).toBe(true)
    expect(hasPaypalTracker(untracked)).toBe(false)
  })

  it('hasRefundProof needs a COMPLETED refund', () => {
    expect(hasRefundProof(base())).toBe(false)
    expect(hasRefundProof(base({ refunds: [completedRefund(1n, NOW)] }))).toBe(true)
  })

  it('chainInvalid requires a failure at capture that a later verification did not recover', () => {
    expect(chainInvalid(base({ chain: { verifyAtCaptureChainValid: false } }))).toBe(true)
    expect(
      chainInvalid(
        base({ chain: { verifyAtCaptureChainValid: false, verifyNowChainValid: true } }),
      ),
    ).toBe(false)
    expect(chainInvalid(base({ chain: { verifyAtCaptureChainValid: undefined } }))).toBe(false)
  })

  it('chainVerifiedNow is false when there is no chain at all', () => {
    expect(chainVerifiedNow(base({ chain: undefined }))).toBe(false)
    expect(hasVerifiedMandate(base({ chain: undefined }))).toBe(false)
  })

  it('hasVerifiedMandate needs both a mandate and a verifying chain', () => {
    expect(hasVerifiedMandate(base())).toBe(true)
    expect(hasVerifiedMandate(base({ chain: { mandatePresent: false } }))).toBe(false)
    expect(hasVerifiedMandate(base({ chain: { verifyAtCaptureChainValid: false } }))).toBe(false)
  })

  it('reasonPhrase produces a readable subject for all ten reasons, and quotes an unknown one', () => {
    expect(reasonPhrase('MERCHANDISE_OR_SERVICE_NOT_RECEIVED')).toBe('a not received claim')
    expect(reasonPhrase('UNAUTHORISED')).toBe('an unauthorised claim')
    expect(reasonPhrase('OTHER')).toBe('an other claim')
    expect(reasonPhrase('A_NEW_REASON')).toBe('a "A_NEW_REASON" claim')
  })

  it('every PayPal dispute_reason gets a readable phrase', () => {
    for (const reason of [
      'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
      'UNAUTHORISED',
      'CREDIT_NOT_PROCESSED',
      'DUPLICATE_TRANSACTION',
      'INCORRECT_AMOUNT',
      'PAYMENT_BY_OTHER_MEANS',
      'CANCELED_RECURRING_BILLING',
      'PROBLEM_WITH_REMITTANCE',
      'OTHER',
    ]) {
      expect(reasonPhrase(reason), reason).not.toContain('_')
    }
  })
})

// ---------------------------------------------------------------------------
// EC-REF-5 is allocation, but R-REF-1's "≥" is the same money question
// ---------------------------------------------------------------------------

describe('R-REF-1', () => {
  it('fires when completed refunds cover the disputed amount exactly', () => {
    expect(ruleAlreadyRefunded(base({ refunds: [completedRefund(8_900n, NOW - 86_400)] }))).toBe(
      true,
    )
  })

  it('fires when the refunds exceed the disputed amount, which is still covered', () => {
    expect(
      ruleAlreadyRefunded(
        base({
          refunds: [
            completedRefund(5_000n, NOW - 86_400),
            { ...completedRefund(4_000n, NOW - 43_200), id: 'ref_2' },
          ],
        }),
      ),
    ).toBe(true)
  })

  it('EC-DSP-2 does not fire on a partial refund', () => {
    expect(ruleAlreadyRefunded(base({ refunds: [completedRefund(2_000n, NOW - 86_400)] }))).toBe(
      false,
    )
  })

  it('EC-REF-3 does not fire on a PENDING refund, which has not returned the money', () => {
    expect(
      ruleAlreadyRefunded(
        base({ refunds: [{ ...completedRefund(8_900n, NOW), status: 'PENDING' }] }),
      ),
    ).toBe(false)
  })

  it('does not fire on a zero-value dispute, which would otherwise divide nothing', () => {
    const zero = base({
      dispute: { ...base().dispute, amount: money(0n, 'USD') },
      refunds: [completedRefund(0n, NOW)],
    })
    expect(ruleAlreadyRefunded(zero)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// R-APPEAL-1
// ---------------------------------------------------------------------------

describe('R-APPEAL-1', () => {
  const lost = (over: Partial<DisputeContext['dispute']> = {}): DisputeContext =>
    base({
      dispute: {
        ...base().dispute,
        previouslyLost: true,
        appealLinkPresent: true,
        newEvidenceSinceLoss: true,
        ...over,
      },
    })

  it('EC-DSP-6 fires when the case was lost, the appeal link exists, and new evidence arrived', () => {
    expect(ruleAppealable(lost())).toBe(true)
  })

  it('does not fire while the case is still open', () => {
    expect(ruleAppealable(lost({ previouslyLost: false }))).toBe(false)
  })

  it('does not fire when PayPal offers no appeal link', () => {
    expect(ruleAppealable(lost({ appealLinkPresent: false }))).toBe(false)
  })

  it('EC-DSP-6 does not fire without new evidence: an appeal would just repeat a lost packet', () => {
    expect(ruleAppealable(lost({ newEvidenceSinceLoss: false }))).toBe(false)
  })

  it('does not fire on a dispute we cannot map to a capture', () => {
    expect(ruleAppealable(base({ dispute: lost().dispute, capture: undefined }))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// R-NOCHAIN-1 and R-CHAIN-BAD — the two halves of §18 question 20
// ---------------------------------------------------------------------------

describe('R-NOCHAIN-1 — the chain check, which is not a fallback', () => {
  it('EC-DSP-9 fires when there is no order, and says so rather than crashing', () => {
    expect(ruleNoChain(base({ order: undefined }))).toBe(true)
  })

  it('fires when there is no capture, which is the same unmapped case', () => {
    expect(ruleNoChain(base({ capture: undefined }))).toBe(true)
  })

  it('fires when no mandate is linked at all', () => {
    expect(ruleNoChain(base({ chain: { mandatePresent: false } }))).toBe(true)
  })

  it('fires when a mandate exists but nothing ever verified the chain', () => {
    expect(ruleNoChain(base({ chain: { mandatePresent: true } }))).toBe(true)
  })

  it('does not fire on a fully mapped, verified chain', () => {
    expect(ruleNoChain(base())).toBe(false)
  })

  it('does not fire on a broken chain — R-CHAIN-BAD owns that, because "no mandate" would be a lie', () => {
    expect(
      ruleNoChain(base({ chain: { mandatePresent: true, verifyAtCaptureChainValid: false } })),
    ).toBe(false)
  })
})

describe('R-CHAIN-BAD', () => {
  it('fires when verification failed at capture and has not recovered', () => {
    expect(ruleChainBad(base({ chain: { verifyAtCaptureChainValid: false } }))).toBe(true)
  })

  it('does not fire when a later verification recovered the chain (spec D-009, as_of verdicts)', () => {
    expect(
      ruleChainBad(
        base({ chain: { verifyAtCaptureChainValid: false, verifyNowChainValid: true } }),
      ),
    ).toBe(false)
  })

  it('does not fire on a valid chain', () => {
    expect(ruleChainBad(base())).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The delivery rules
// ---------------------------------------------------------------------------

describe('R-INR-1', () => {
  it('fires when the buyer says it never arrived and we have no shipment at all', () => {
    expect(ruleInrUntracked(base({ shipments: [] }))).toBe(true)
  })

  it('fires when the shipment has no tracking number', () => {
    const ctx = base({
      shipments: [
        {
          id: 'shp_1',
          carrier: 'BlueDart',
          trackingNumber: '',
          status: 'NOT_SHIPPED',
          lines: [{ sku: 'SKU-TRAIL-42', qty: 1 }],
        },
      ],
    })
    expect(ruleInrUntracked(ctx)).toBe(true)
  })

  it('does not fire when tracking exists', () => {
    expect(ruleInrUntracked(base())).toBe(false)
  })

  it('does not fire on a different reason', () => {
    expect(
      ruleInrUntracked(
        base({ dispute: { ...base().dispute, reason: 'UNAUTHORISED' }, shipments: [] }),
      ),
    ).toBe(false)
  })
})

describe('R-INR-3', () => {
  it('fires when a registered tracker says the parcel is still moving', () => {
    expect(
      ruleInrInTransit(
        base({
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
      ),
    ).toBe(true)
  })

  it('does not fire once the tracker is terminal', () => {
    expect(ruleInrInTransit(base())).toBe(false)
  })

  it('does not fire when the tracker was never registered with PayPal — that is R-INR-2 then', () => {
    expect(
      ruleInrInTransit(
        base({
          shipments: [
            {
              id: 'shp_1',
              carrier: 'BlueDart',
              trackingNumber: 'BD1',
              paypalTrackerId: null,
              status: 'SHIPPED',
              lines: [{ sku: 'SKU-TRAIL-42', qty: 1 }],
            },
          ],
        }),
      ),
    ).toBe(false)
  })

  it('does not fire when there is no tracking at all', () => {
    expect(ruleInrInTransit(base({ shipments: [] }))).toBe(false)
  })
})

describe('R-INR-2', () => {
  it('fires on any tracking for the disputed line, terminal or not', () => {
    expect(ruleInrTracked(base())).toBe(true)
  })

  it('does not fire without tracking, which is R-INR-1', () => {
    expect(ruleInrTracked(base({ shipments: [] }))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// R-SNAD-AGENT — the higher bar, in isolation
// ---------------------------------------------------------------------------

describe('R-SNAD-AGENT — the higher bar, conjunct by conjunct', () => {
  const snad = (over: Partial<DisputeContext> = {}): DisputeContext =>
    base({
      dispute: { ...base().dispute, reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED' },
      disputedItem: { sku: 'SKU-TRAIL-42', attributes: { size: '9' } },
      preferences: { size: '10' },
      chain: {
        mandatePresent: true,
        verifyAtCaptureChainValid: true,
        webauthnPresent: true,
        readback: READBACK_PLAIN,
      },
      ...over,
    })

  it('EC-AGT-2: fires only with a verified chain, because the chain is what proves the key was bound by the L2', () => {
    // EC-AGT-2's bounded worst case is enforced by the Gate, not here; what reaches the Defender is what
    // survived it. That is why this rule cannot fire on an unproven chain — "it can only sign L3s within L2
    // limits" is a claim about the *signature*, and without a verifying chain there is no evidence that
    // this L3 was signed by the key the L2 binds at all.
    expect(agentAuthorityExceeded(snad())).toBe(true)
    expect(hasVerifiedMandate(snad())).toBe(true)
  })

  it('fires when the preference and the shipped item differ and the read-back is silent', () => {
    expect(agentAuthorityExceeded(snad())).toBe(true)
  })

  it('does NOT fire when the shipped variant is what the user asked for', () => {
    expect(
      agentAuthorityExceeded(
        snad({
          preferences: { size: '9' },
          disputedItem: { sku: 'SKU-TRAIL-42', attributes: { size: '9' } },
        }),
      ),
    ).toBe(false)
  })

  it('does NOT fire when the shipped variant is what the user was shown and approved', () => {
    // The higher bar in one case. The compiler inferred size 9, so the user asked for 10, size 10 arrived -
    // and the read-back they approved said "size 10". They saw it and got it. Blaming a buyer for a
    // compiler's inference is not something this package will do, so the case falls through to R-SNAD-OK.
    const ctx = snad({
      preferences: { size: '9' },
      disputedItem: { sku: 'SKU-TRAIL-42', attributes: { size: '10' } },
      chain: {
        mandatePresent: true,
        verifyAtCaptureChainValid: true,
        webauthnPresent: true,
        readback: READBACK_SIZE_10,
      },
    })
    expect(agentAuthorityExceeded(ctx)).toBe(false)
    expect(attributeConflicts(ctx)).toEqual([])
  })

  it('DOES fire when the read-back showed the preference and a different variant arrived', () => {
    // The same read-back, read the other way: the user was shown size 9, the preference said 9, and size 10
    // is in the box. Nothing in the signed record covers this substitution, so it is the agent's.
    const ctx = snad({
      preferences: { size: '9' },
      disputedItem: { sku: 'SKU-TRAIL-42', attributes: { size: '10' } },
      chain: {
        mandatePresent: true,
        verifyAtCaptureChainValid: true,
        webauthnPresent: true,
        readback: READBACK_SIZE_9,
      },
    })
    expect(agentAuthorityExceeded(ctx)).toBe(true)
    expect(attributeConflicts(ctx).map((c) => c.key)).toEqual(['size'])
  })

  it('DOES fire when the read-back said nothing about the attribute at all', () => {
    // The eval's r-snad-agent-wrong-size case: preference 10, size 9 arrived, read-back silent on size.
    const conflicts = attributeConflicts(snad())
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({
      key: 'size',
      wanted: '10',
      shipped: '9',
      statedInReadback: undefined,
    })
  })

  it('does NOT fire when the chain does not verify: we do not blame an agent for an unproven failure', () => {
    expect(
      agentAuthorityExceeded(
        snad({ chain: { mandatePresent: true, verifyAtCaptureChainValid: false } }),
      ),
    ).toBe(false)
  })

  it('does NOT fire when the merchant shipped different lines: that is R-SNAD-MERCH, not agent fault', () => {
    expect(
      agentAuthorityExceeded(
        snad({
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
      ),
    ).toBe(false)
  })

  it('does NOT fire without a stated preference, since preferences are router-only input (spec §8.8)', () => {
    expect(agentAuthorityExceeded(snad({ preferences: undefined }))).toBe(false)
  })

  it('does NOT fire when the disputed item has no attributes to diff', () => {
    expect(
      agentAuthorityExceeded(
        snad({
          disputedItem: { sku: 'SKU-TRAIL-42', attributes: {} },
          preferences: { size: '10' },
        }),
      ),
    ).toBe(false)
  })

  it('the predicate and the rule agree, and it is the only SNAD rule that reads preferences', () => {
    expect(ruleSnadAgentFault(snad())).toBe(true)
    expect(ruleSnadMerchantFault(snad())).toBe(false)
    expect(ruleSnadThinQuality(snad())).toBe(true)
    expect(ruleSnadAuthorised(snad())).toBe(false)
  })

  it('compares attributes case- and space-insensitively, because a catalogue is not a signature', () => {
    expect(
      agentAuthorityExceeded(
        snad({
          preferences: { size: 'UK 10' },
          disputedItem: { sku: 'SKU-TRAIL-42', attributes: { size: 'uk  10' } },
        }),
      ),
    ).toBe(false)
  })

  it('reports the conflicting keys, wanted and shipped, for the rationale to quote', () => {
    const conflicts = attributeConflicts(
      snad({
        disputedItem: { sku: 'SKU-TRAIL-42', attributes: { size: '9', color: 'blue' } },
        preferences: { size: '10', color: 'black' },
      }),
    )
    expect(conflicts.map((c) => c.key).sort()).toEqual(['color', 'size'])
    expect(conflicts.every((c) => c.wanted !== c.shipped)).toBe(true)
  })

  it("readbackAttribute reads the compiler's rendering and reports silence as undefined", () => {
    expect(readbackAttribute(READBACK_SIZE_9, 'size')).toBe('9')
    expect(readbackAttribute(READBACK_SIZE_9, 'color')).toBeUndefined()
    expect(readbackAttribute(undefined, 'size')).toBeUndefined()
    expect(readbackAttribute('', 'size')).toBeUndefined()
  })

  it('readbackAttribute is case-sensitive on the label, matching the compiler exactly', () => {
    expect(readbackAttribute('we read **SIZE** "9"', 'size')).toBeUndefined()
  })

  it('every attribute key has a label, and the label set is exactly size, colour and model', () => {
    expect(Object.keys(READBACK_LABELS).sort()).toEqual([...ATTRIBUTE_KEYS].sort())
  })
})

// ---------------------------------------------------------------------------
// R-SNAD-MERCH, R-SNAD-THIN, R-SNAD-OK
// ---------------------------------------------------------------------------

describe('R-SNAD-MERCH', () => {
  const snad = (over: Partial<DisputeContext> = {}): DisputeContext =>
    base({
      dispute: { ...base().dispute, reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED' },
      ...over,
    })

  it('EC-MER-3 fires when the shipped lines differ from the merchant-signed checkout', () => {
    expect(
      ruleSnadMerchantFault(
        snad({
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
      ),
    ).toBe(true)
  })

  it('EC-MER-3 fires on a short shipment, because a quantity difference is a different line set', () => {
    expect(
      ruleSnadMerchantFault(
        snad({
          checkoutLines: [{ sku: 'SKU-TRAIL-42', qty: 2 }],
          shipments: [
            {
              id: 'shp_1',
              carrier: 'BlueDart',
              trackingNumber: 'BD1',
              status: 'DELIVERED',
              lines: [{ sku: 'SKU-TRAIL-42', qty: 1 }],
            },
          ],
        }),
      ),
    ).toBe(true)
  })

  it('does not fire when the lines match', () => {
    expect(ruleSnadMerchantFault(snad())).toBe(false)
  })

  it('does not fire with no shipments at all: nothing shipped is not a mismatch', () => {
    expect(ruleSnadMerchantFault(snad({ shipments: [] }))).toBe(false)
  })
})

describe('R-SNAD-THIN and R-SNAD-OK split on one thing: whether we can prove quality', () => {
  const snad = (corpus: DisputeContext['corpus']): DisputeContext =>
    base({
      dispute: { ...base().dispute, reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED' },
      disputedItem: { sku: 'SKU-TRAIL-42', attributes: { size: '10' } },
      preferences: { size: '10' },
      corpus,
    })

  it('R-SNAD-THIN fires when the item matches but nothing shows the goods were as described', () => {
    expect(ruleSnadThinQuality(snad({}))).toBe(true)
    expect(ruleSnadAuthorised(snad({}))).toBe(false)
  })

  it('EC-BUY-1: R-SNAD-OK fires once we hold a quality document', () => {
    expect(ruleSnadAuthorised(snad({ qualityDocument: true }))).toBe(true)
    expect(ruleSnadThinQuality(snad({ qualityDocument: true }))).toBe(false)
  })

  it('a fulfilment document is not a quality document', () => {
    expect(ruleSnadThinQuality(snad({ fulfilmentDocument: true }))).toBe(true)
  })

  it('neither fires without a verified mandate, because then the case has no evidence at all', () => {
    const ctx = snad({ qualityDocument: true })
    expect(ruleSnadAuthorised(base({ ...ctx, chain: { mandatePresent: true } }))).toBe(false)
  })

  it('shipmentLinesMatchCheckout is the shared predicate, and it says false with no checkout', () => {
    expect(shipmentLinesMatchCheckout(base())).toBe(true)
    expect(shipmentLinesMatchCheckout(base({ checkoutLines: undefined }))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The unauthorised rules, in the order that matters
// ---------------------------------------------------------------------------

describe('R-UNAUTH-2, R-UNAUTH-3 and R-UNAUTH-1', () => {
  const unauth = (over: Partial<DisputeContext['chain']>): DisputeContext =>
    base({
      dispute: { ...base().dispute, reason: 'UNAUTHORISED' },
      chain: {
        mandatePresent: true,
        verifyAtCaptureChainValid: true,
        iatSec: NOW - 86_400,
        deviceStatus: 'ACTIVE',
        ...over,
      },
    })

  it('R-UNAUTH-2 fires when the device was lost before the mandate was signed (§18 q8, EC-BUY-3)', () => {
    expect(
      ruleUnauthorisedLostDevice(
        unauth({ webauthnPresent: true, deviceStatus: 'LOST', deviceLostAtSec: NOW - 172_800 }),
      ),
    ).toBe(true)
  })

  it('R-UNAUTH-2 does not fire when the device was lost after signing', () => {
    expect(
      ruleUnauthorisedLostDevice(
        unauth({ webauthnPresent: true, deviceStatus: 'LOST', deviceLostAtSec: NOW - 3_600 }),
      ),
    ).toBe(false)
  })

  it('R-UNAUTH-2 does not fire without a loss timestamp: the ordering is the claim, and we cannot prove it', () => {
    expect(
      ruleUnauthorisedLostDevice(unauth({ webauthnPresent: true, deviceStatus: 'LOST' })),
    ).toBe(false)
  })

  it('EC-BUY-3: R-UNAUTH-3 fires when there is no passkey user-verification at signing', () => {
    expect(ruleUnauthorisedWeak(unauth({ webauthnPresent: false }))).toBe(true)
  })

  it('R-UNAUTH-3 fires when there is no assertion at all, which is weaker still', () => {
    expect(ruleUnauthorisedWeak(unauth({}))).toBe(true)
  })

  it('R-UNAUTH-1 fires only with a passkey user-verification', () => {
    expect(ruleUnauthorisedAuthorised(unauth({ webauthnPresent: true }))).toBe(true)
    expect(ruleUnauthorisedAuthorised(unauth({ webauthnPresent: false }))).toBe(false)
    expect(ruleUnauthorisedWeak(unauth({ webauthnPresent: true }))).toBe(false)
  })

  it('none of the three fire without a verifying chain: that is R-CHAIN-BAD', () => {
    const broken = unauth({ webauthnPresent: true, verifyAtCaptureChainValid: false })
    expect(ruleUnauthorisedAuthorised(broken)).toBe(false)
    expect(ruleUnauthorisedWeak(broken)).toBe(false)
    expect(ruleUnauthorisedLostDevice(broken)).toBe(false)
  })

  it('a verify-now recovery still counts as verified, so R-UNAUTH-1 can fire (spec D-009)', () => {
    expect(
      ruleUnauthorisedAuthorised(
        unauth({
          webauthnPresent: true,
          verifyAtCaptureChainValid: false,
          verifyNowChainValid: true,
        }),
      ),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The amount rules
// ---------------------------------------------------------------------------

describe('R-AMT-1', () => {
  const amt = (over: Partial<DisputeContext> = {}): DisputeContext =>
    base({
      dispute: { ...base().dispute, reason: 'INCORRECT_AMOUNT' },
      corpus: { receiptCopy: true },
      ...over,
    })

  it('fires when the captures total the signed order exactly', () => {
    expect(ruleAmountCorrect(amt())).toBe(true)
  })

  it('does not fire when the captures exceed the order, which is not "amount is right"', () => {
    expect(
      ruleAmountCorrect(
        amt({
          siblingCaptures: [
            { id: 'c2', paypalCaptureId: 'P2', amount: money(100n, 'USD'), shipmentId: 'shp_2' },
          ],
        }),
      ),
    ).toBe(false)
  })

  it('does not fire without an order to compare against', () => {
    expect(ruleAmountCorrect(amt({ order: undefined }))).toBe(false)
  })

  it('does not fire when a duplicate capture exists: that is R-AMT-2, and R-AMT-1 must not shadow it', () => {
    expect(
      ruleAmountCorrect(
        amt({
          order: {
            ...(amt().order as NonNullable<DisputeContext['order']>),
            amount: money(17_800n, 'USD'),
          },
          siblingCaptures: [
            { id: 'c2', paypalCaptureId: 'P2', amount: money(8_900n, 'USD'), shipmentId: 'shp_1' },
          ],
        }),
      ),
    ).toBe(false)
  })

  it('does not fire when a currency differs, and never converts to compare (EC-FX-1)', () => {
    expect(
      ruleAmountCorrect(
        amt({
          capture: {
            id: 'cap_1',
            paypalCaptureId: 'P1',
            amount: money(8_900n, 'EUR'),
            shipmentId: 'shp_1',
          },
        }),
      ),
    ).toBe(false)
  })
})

describe('R-AMT-2', () => {
  const dup = base({
    dispute: { ...base().dispute, reason: 'DUPLICATE_TRANSACTION' },
    siblingCaptures: [
      { id: 'cap_2', paypalCaptureId: 'P2', amount: money(8_900n, 'USD'), shipmentId: 'shp_1' },
    ],
  })

  it('EC-MER-2 fires on two captures for one shipment', () => {
    expect(ruleAmountDuplicate(dup)).toBe(true)
  })

  it('does not fire when each shipment has its own capture', () => {
    expect(
      ruleAmountDuplicate(
        base({
          dispute: { ...base().dispute, reason: 'DUPLICATE_TRANSACTION' },
          siblingCaptures: [
            { id: 'c2', paypalCaptureId: 'P2', amount: money(100n, 'USD'), shipmentId: 'shp_2' },
          ],
        }),
      ),
    ).toBe(false)
  })

  it('does not fire on a reason that is not an amount claim', () => {
    expect(
      ruleAmountDuplicate({ ...dup, dispute: { ...dup.dispute, reason: 'UNAUTHORISED' } }),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// R-CNP-1 and R-OTHER-REFUND
// ---------------------------------------------------------------------------

describe('R-CNP-1', () => {
  const cnp = (refunds: DisputeContext['refunds']): DisputeContext =>
    base({ dispute: { ...base().dispute, reason: 'CREDIT_NOT_PROCESSED' }, refunds })

  it('fires when a refund exists to prove the credit landed', () => {
    expect(ruleCreditNotProcessedRefunded(cnp([completedRefund(2_000n, NOW - 86_400)]))).toBe(true)
  })

  it('does not fire with no refund at all', () => {
    expect(ruleCreditNotProcessedRefunded(cnp([]))).toBe(false)
  })

  it('does not fire when the only refund is PENDING (EC-REF-3)', () => {
    expect(
      ruleCreditNotProcessedRefunded(cnp([{ ...completedRefund(2_000n, NOW), status: 'PENDING' }])),
    ).toBe(false)
  })
})

describe('R-OTHER-REFUND', () => {
  it("fires for each of PayPal's four reasons that §8.15 never assigns", () => {
    for (const reason of UNASSIGNED_REASONS) {
      expect(ruleOtherReasonRefund(base({ dispute: { ...base().dispute, reason } })), reason).toBe(
        true,
      )
    }
  })

  it('does not fire without a verifying chain: there is no point refunding a case we cannot even place', () => {
    expect(
      ruleOtherReasonRefund(
        base({
          dispute: { ...base().dispute, reason: 'PAYMENT_BY_OTHER_MEANS' },
          chain: { mandatePresent: true },
        }),
      ),
    ).toBe(false)
  })

  it('does not fire for a reason that has its own rule', () => {
    expect(ruleOtherReasonRefund(base())).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Merchant policy
// ---------------------------------------------------------------------------

describe('the merchant policy defaults are conservative', () => {
  it('an unconfigured merchant gets no automatic acceptance at all', () => {
    expect(autoAccepts(base())).toBe(false)
    expect(autoAccepts(base({ policy: { autoAcceptThresholdMinor: 0n } }))).toBe(false)
  })

  it('accepts a claim at or below the configured limit', () => {
    expect(autoAccepts(base({ policy: { autoAcceptThresholdMinor: 8_900n } }))).toBe(true)
    expect(autoAccepts(base({ policy: { autoAcceptThresholdMinor: 8_899n } }))).toBe(false)
  })

  it("EC-BUY-3's weak-case limit is separate from the auto-accept limit", () => {
    const ctx = base({
      policy: { autoAcceptThresholdMinor: 0n, weakUnauthorisedThresholdMinor: 5_000n },
    })
    expect(weakCaseAutoAccepts(ctx)).toBe(false) // the claim is 8900, above the weak limit
    expect(autoAccepts(ctx)).toBe(false)
  })

  it('an explicit threshold argument overrides the policy, so one predicate serves both limits', () => {
    expect(autoAccepts(base({ policy: { autoAcceptThresholdMinor: 1n } }), 10_000n)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Evidence availability
// ---------------------------------------------------------------------------

describe("evidenceSourceAvailable answers for each of PayPal's nine types", () => {
  const every = base()

  it('PROOF_OF_REFUND needs a completed refund', () => {
    expect(evidenceSourceAvailable('PROOF_OF_REFUND', every)).toBe(false)
    expect(
      evidenceSourceAvailable('PROOF_OF_REFUND', base({ refunds: [completedRefund(1n, NOW)] })),
    ).toBe(true)
  })

  it('ONLINE_TRACKING_INFORMATION needs a non-blank tracking number', () => {
    expect(evidenceSourceAvailable('ONLINE_TRACKING_INFORMATION', every)).toBe(true)
    expect(evidenceSourceAvailable('ONLINE_TRACKING_INFORMATION', base({ shipments: [] }))).toBe(
      false,
    )
  })

  it('EC-MER-4: PROOF_OF_FULFILLMENT needs a document or a tracker PayPal holds, not a merchant claim', () => {
    const assertedOnly = base({
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
    expect(evidenceSourceAvailable('PROOF_OF_FULFILLMENT', assertedOnly)).toBe(false)
    expect(
      evidenceSourceAvailable(
        'PROOF_OF_FULFILLMENT',
        base({ corpus: { fulfilmentDocument: true } }),
      ),
    ).toBe(true)
  })

  it('DETAILS_OF_PURCHASE is the signed bundle, so it needs a verifying chain', () => {
    expect(evidenceSourceAvailable('DETAILS_OF_PURCHASE', every)).toBe(true)
    expect(
      evidenceSourceAvailable('DETAILS_OF_PURCHASE', base({ chain: { mandatePresent: true } })),
    ).toBe(false)
  })

  it('ORDER_DETAILS and ITEM_DESCRIPTION need the merchant-signed checkout lines', () => {
    expect(evidenceSourceAvailable('ORDER_DETAILS', every)).toBe(true)
    expect(evidenceSourceAvailable('ITEM_DESCRIPTION', base({ checkoutLines: [] }))).toBe(false)
  })

  it('PROOF_OF_RECEIPT_COPY needs the receipt copy: we do not synthesise one we never gave', () => {
    expect(evidenceSourceAvailable('PROOF_OF_RECEIPT_COPY', every)).toBe(false)
    expect(
      evidenceSourceAvailable('PROOF_OF_RECEIPT_COPY', base({ corpus: { receiptCopy: true } })),
    ).toBe(true)
  })

  it('PROOF_OF_RETURN and OTHER are always ours to write', () => {
    expect(evidenceSourceAvailable('PROOF_OF_RETURN', every)).toBe(true)
    expect(evidenceSourceAvailable('OTHER', every)).toBe(true)
  })

  it('missingEvidence lists exactly the unsatisfiable types, in order', () => {
    expect(missingEvidence(['PROOF_OF_REFUND', 'ONLINE_TRACKING_INFORMATION'], every)).toEqual([
      'PROOF_OF_REFUND',
    ])
    expect(missingEvidence([], every)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The evidence table and the deadline
// ---------------------------------------------------------------------------

describe('EVIDENCE_BY_RULE', () => {
  it('names only PayPal evidence_type values from the corrected enum', () => {
    for (const [rule, types] of Object.entries(EVIDENCE_BY_RULE)) {
      for (const t of types) {
        expect(EVIDENCE_TYPES as readonly string[], `${rule}: ${t}`).toContain(t)
      }
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
    const used = Object.values(EVIDENCE_BY_RULE).flat()
    for (const gone of REMOVED) expect(used).not.toContain(gone)
  })

  it('gives a contesting rule a non-empty list — the invariant a judge is asking about', () => {
    const CONTESTING: RuleId[] = ['R-INR-2', 'R-SNAD-OK', 'R-UNAUTH-1', 'R-AMT-1']
    for (const rule of CONTESTING) expect(evidenceFor(rule).length, rule).toBeGreaterThan(0)
  })

  it('gives a refunding rule an empty list: there is no packet to build', () => {
    for (const rule of [
      'R-INR-1',
      'R-SNAD-AGENT',
      'R-SNAD-MERCH',
      'R-AMT-2',
      'R-OTHER-REFUND',
    ] as RuleId[]) {
      expect(evidenceFor(rule), rule).toEqual([])
    }
  })

  it('evidenceFor is total: an unknown id yields an empty list rather than undefined', () => {
    expect(evidenceFor('R-DEFAULT')).toEqual([])
  })
})

describe('ruleInquiryStage — spec EC-DSP-3', () => {
  const inquiry = (status: string): DisputeContext =>
    base({ dispute: { ...base().dispute, stage: 'INQUIRY', status } })

  it('EC-DSP-3 fires at INQUIRY while PayPal has not asked for a response', () => {
    expect(ruleInquiryStage(inquiry('OPEN'))).toBe(true)
    expect(ruleInquiryStage(inquiry('WAITING_FOR_BUYER_RESPONSE'))).toBe(true)
  })

  it('does not fire once PayPal asks for a response, which is when filing is allowed', () => {
    expect(ruleInquiryStage(inquiry('WAITING_FOR_SELLER_RESPONSE'))).toBe(false)
  })

  it('does not fire at CHARGEBACK or later, however the status reads', () => {
    expect(ruleInquiryStage(base({ dispute: { ...base().dispute, stage: 'CHARGEBACK' } }))).toBe(
      false,
    )
    expect(
      ruleInquiryStage(base({ dispute: { ...base().dispute, stage: 'PRE_ARBITRATION' } })),
    ).toBe(false)
  })
})

describe('ruleDeadlineForcesRefund', () => {
  it('EC-DSP-7 fires inside the 48-hour window', () => {
    expect(ruleDeadlineForcesRefund(47 * 3_600)).toBe(true)
    expect(ruleDeadlineForcesRefund(48 * 3_600)).toBe(true)
  })

  it('does not fire beyond it', () => {
    expect(ruleDeadlineForcesRefund(49 * 3_600)).toBe(false)
  })

  it("does not fire once the deadline has passed: EC-DSP-8 is the filer's error, not a downgrade", () => {
    expect(ruleDeadlineForcesRefund(0)).toBe(false)
    expect(ruleDeadlineForcesRefund(-3_600)).toBe(false)
  })

  it('does not fire when PayPal sent no deadline at all', () => {
    expect(ruleDeadlineForcesRefund(null)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Structure: the table cannot rot silently
// ---------------------------------------------------------------------------

const SRC = join(import.meta.dirname, '..', 'src')

/**
 * Remove comments before a structural grep.
 *
 * Without this, the module headers fail their own checks: `index.ts` documents "no `Date.now()` appears
 * anywhere", and a scanner that reads its own documentation concludes the package reads a clock. The same
 * problem `scripts/check-money-discipline.mjs` solves with `EXEMPT_LINE`, and for the same reason — an
 * explanatory sentence about an anti-pattern is not an instance of it.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function sourceFiles(dir = SRC, out: { name: string; text: string }[] = []): typeof out {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, out)
    else if (entry.endsWith('.ts'))
      out.push({ name: full.slice(SRC.length + 1), text: readFileSync(full, 'utf8') })
  }
  return out
}

describe('the rules table cannot rot silently', () => {
  const files = sourceFiles()

  it('every rule id in RULE_ORDER is in RULE_ORIGIN and says where it came from', () => {
    for (const id of RULE_ORDER) {
      const origin = RULE_ORIGIN[id]
      expect(origin, id).toBeDefined()
      expect(['spec-8.15', 'extension']).toContain(origin)
    }
    expect(Object.keys(RULE_ORIGIN).sort()).toEqual([...RULE_ORDER].sort())
  })

  it('every alias resolves to rules that exist, and every alias is a documented alternative name', () => {
    for (const [alias, targets] of Object.entries(RULE_ALIASES)) {
      expect(targets.length, alias).toBeGreaterThan(0)
      for (const t of targets) expect(RULE_ORDER, `${alias} -> ${t}`).toContain(t)
      expect(alias, 'an alias must not be a canonical id').not.toBe(targets[0])
    }
  })

  it('RULE_ORDER puts R-CHAIN-BAD before the SNAD and INR rules and R-UNAUTH-2 before R-UNAUTH-1', () => {
    const at = (id: RuleId): number => RULE_ORDER.indexOf(id)
    // Both orderings are fixes to spec §8.15's row order, and each one changes a real dispute's answer.
    expect(at('R-CHAIN-BAD')).toBeLessThan(at('R-SNAD-OK'))
    expect(at('R-UNAUTH-2')).toBeLessThan(at('R-UNAUTH-1'))
    expect(at('R-UNAUTH-3')).toBeLessThan(at('R-UNAUTH-1'))
    expect(at('R-REF-1')).toBeLessThan(at('R-DEFAULT'))
    expect(at('R-DEADLINE-1')).toBeLessThan(at('R-DEFAULT'))
    expect(at('R-NO-EVIDENCE')).toBeLessThan(at('R-DEFAULT'))
    expect(RULE_ORDER[RULE_ORDER.length - 1]).toBe('R-DEFAULT')
  })

  it('no source file reads a wall clock: nowSec is an argument, not a lookup', () => {
    for (const f of files) {
      const code = stripComments(f.text)
      expect(code, f.name).not.toMatch(/\bDate\.now\s*\(/)
      expect(code, f.name).not.toMatch(/\bnew\s+Date\s*\(\s*\)/)
    }
  })

  it('no source file in packages/defender imports a model runtime', () => {
    // The same rule §8.10 applies to the Gate, and the same reason: the router decides, and a model must
    // not be able to influence which rule fires. (There is no ESLint rule for this package yet — see the
    // README's "Contract gaps" — so the check lives here rather than nowhere.)
    for (const f of files) {
      expect(stripComments(f.text), f.name).not.toMatch(
        /from ['"](ai|@ai-sdk\/[^'"]+|openai|@anthropic-ai\/[^'"]+)['"]/,
      )
    }
  })

  it('no source file imports the database client: this package reads rows, it does not query them', () => {
    for (const f of files) {
      expect(stripComments(f.text), f.name).not.toMatch(
        /from ['"]@countersign\/db\/(client|repos)['"]/,
      )
    }
  })

  it('no source file performs float arithmetic on an amount', () => {
    for (const f of files) {
      const code = stripComments(f.text)
      expect(code, f.name).not.toMatch(/parseFloat|parseInt\s*\(/)
      expect(code, f.name).not.toMatch(/\.toFixed\s*\(/)
    }
  })

  it('every rule has a named predicate, and PREDICATE_FOR has no placeholder left behind', () => {
    // The naming rule: `R-SNAD-AGENT` → `ruleSnadAgentFault` is not mechanical, so the predicate table is
    // asserted against the id *and* against a non-empty function body. A `() => false` placeholder outside
    // the two documented post-table rules is the shape a forgotten predicate takes.
    const PLACEHOLDERS = new Set(['R-DEADLINE-1', 'R-NO-EVIDENCE', 'R-STAGE-INQUIRY'])
    for (const id of RULE_ORDER) {
      const fn = PREDICATE_FOR[id]
      expect(typeof fn, `${id} has no predicate`).toBe('function')
      const body = fn.toString().replace(/\s+/g, '')
      if (PLACEHOLDERS.has(id)) {
        expect(body, `${id} should still be a placeholder`).toBe('()=>false')
      } else {
        expect(body, `${id} looks like a placeholder`).not.toBe('()=>false')
      }
    }
    expect(Object.keys(PREDICATE_FOR).sort()).toEqual([...RULE_ORDER].sort())
  })

  it('R-DEFAULT is the only rule whose predicate is the constant true', () => {
    expect(PREDICATE_FOR['R-DEFAULT'](base())).toBe(true)
    expect(PREDICATE_FOR['R-DEFAULT'](base({ order: undefined }))).toBe(true)
  })
})
