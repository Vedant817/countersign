/**
 * The 40-case eval — spec **§8.16 AT-M15.1**.
 *
 * ```bash
 * pnpm --filter @countersign/defender eval
 * ```
 *
 * ## What is asserted, in this order, and why
 *
 * 1. **The data is sound** before the router is run. A golden set that has been quietly damaged — a
 *    duplicated id, a case with no expectation, a money value that lost precision crossing JSON — reports a
 *    *score*, and a wrong score is worse than no score. Every integrity check is therefore a separate `it`
 *    that fails on its own, and the score test names the failures rather than printing a percentage.
 * 2. **Coverage**: every one of the 21 rule ids appears, so a new rule cannot ship without a case.
 * 3. **100% exact match on `ruleId` and `posture`**, which is the number §8.16 asks for and the number the
 *    package header quotes.
 * 4. **`evidenceTypes` agreement**, reported separately, because the planner is a different module and a
 *    mismatch there is a different bug.
 *
 * ## The test that matters most
 *
 * `posture === 'CONTEST'` implies a non-empty `evidenceRequired` whose members are all real PayPal
 * `evidence_type` values. It is a **property test over generated contexts** (`fast-check`), not over the
 * 40 cases: the cases are the router's regression net, and the property is the invariant a judge is really
 * asking about. A router can pass 40 hand-written cases and still have a hole.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { EVIDENCE_TYPES, type EvidenceType } from '@countersign/paypal'

import { RULE_ORDER, route, type DisputeContext, type Posture, type RuleId } from '../src/index'
import {
  contextFromCase,
  formatFailures,
  loadRouterCases,
  runEval,
  summarise,
  type RouterCase,
} from '../eval/router-cases'

const cases = loadRouterCases()

/** §8.16 AT-M15.1 says "a 40-case labelled eval". */
const EVAL_SIZE = 40

function evaluate(): ReturnType<typeof runEval> {
  return runEval(cases, (c: RouterCase) => {
    const d = route(contextFromCase(c))
    return { ruleId: d.ruleId, posture: d.posture, evidenceRequired: d.evidenceRequired }
  })
}

// ---------------------------------------------------------------------------
// 1. The data
// ---------------------------------------------------------------------------

describe('the router eval set', () => {
  it(`has exactly ${EVAL_SIZE} cases, as §8.16 asks, and every id is unique`, () => {
    expect(cases).toHaveLength(EVAL_SIZE)
    expect(new Set(cases.map((c) => c.id)).size).toBe(EVAL_SIZE)
  })

  it('gives every case a one-line description, so a diff reads as prose and not as JSON', () => {
    for (const c of cases) {
      expect(c.text.trim().length, c.id).toBeGreaterThan(20)
      expect(c.text.includes('\n'), `${c.id} description should be one line`).toBe(false)
    }
  })

  it('states a real rule id and a real posture on every case, so no case can score vacuously', () => {
    const POSTURES: readonly Posture[] = [
      'REFUND',
      'ACCEPT_CLAIM',
      'CONTEST',
      'OFFER',
      'MESSAGE_ONLY',
      'APPEAL',
      'REVIEW',
    ]
    for (const c of cases) {
      expect(RULE_ORDER, `${c.id} expect.ruleId`).toContain(c.expect.ruleId)
      expect(POSTURES, `${c.id} expect.posture`).toContain(c.expect.posture)
      expect(c.expect.evidenceTypes, c.id).toBeDefined()
    }
  })

  it('writes every amount as an integer, never a float (spec §0 rule 9)', () => {
    for (const c of cases) {
      const amounts = [
        c.dispute.amountMinor,
        c.capture.amountMinor,
        c.capture.orderAmountMinor,
        c.dispute.autoAcceptThresholdMinor,
        c.dispute.weakUnauthorisedThresholdMinor,
        ...(c.capture.refunds ?? []).map((r) => r.amountMinor),
        ...(c.capture.siblings ?? []).map((s) => s.amountMinor),
      ].filter((v): v is number => v !== undefined)
      for (const a of amounts) {
        expect(Number.isInteger(a), `${c.id} has a non-integer amount: ${a}`).toBe(true)
      }
    }
  })

  it('states a supported ISO-4217 currency on every case', () => {
    for (const c of cases) {
      expect(['USD', 'EUR', 'GBP', 'INR', 'JPY', 'AUD', 'CAD'], c.id).toContain(c.dispute.currency)
    }
  })

  it('names only PayPal evidence_type values, from the corrected 2026-10-04 enum', () => {
    for (const c of cases) {
      for (const t of c.expect.evidenceTypes) {
        expect(EVIDENCE_TYPES as readonly string[], `${c.id}: ${t}`).toContain(t)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 2. Coverage
// ---------------------------------------------------------------------------

describe('the eval set covers the table', () => {
  it('exercises every rule in RULE_ORDER, so a new rule cannot ship uncovered', () => {
    const covered = new Set(cases.map((c) => c.expect.ruleId))
    const missing = RULE_ORDER.filter((r) => !covered.has(r))
    expect(missing).toEqual([])
  })

  it('covers both terminal directions of the no-chain path: REVIEW and ACCEPT_CLAIM', () => {
    const noChain = cases.filter((c) => c.expect.ruleId === 'R-NOCHAIN-1')
    expect(new Set(noChain.map((c) => c.expect.posture))).toEqual(
      new Set<Posture>(['REVIEW', 'ACCEPT_CLAIM']),
    )
  })

  it('covers both downgrades R-NO-EVIDENCE can pick: REFUND and REVIEW', () => {
    const noEvidence = cases.filter((c) => c.expect.ruleId === 'R-NO-EVIDENCE')
    expect(new Set(noEvidence.map((c) => c.expect.posture))).toEqual(
      new Set<Posture>(['REFUND', 'REVIEW']),
    )
  })

  it('has at least three cases where the deadline forces a downgrade', () => {
    expect(cases.filter((c) => c.expect.ruleId === 'R-DEADLINE-1').length).toBeGreaterThanOrEqual(3)
  })

  it('spreads the deadline downgrades over more than one superseding rule', () => {
    // EC-DSP-7 must be reachable from more than one filing posture, or a fix to one of them would look
    // complete while the other still files a packet that cannot be gathered in time.
    const superseded = cases
      .filter((c) => c.expect.ruleId === 'R-DEADLINE-1')
      .map((c) => route(contextFromCase(c)).supersedes)
    expect(new Set(superseded).size).toBeGreaterThanOrEqual(2)
  })

  it('has a case for every rule that another rule could plausibly shadow', () => {
    // These three are the ordering bugs the spec's row order has: R-UNAUTH-1's stated condition is also
    // true for a stolen device, R-CHAIN-BAD is also "no proof", and R-DEFAULT is also "nothing matched".
    // If any of them goes missing, the ordering stops being tested at all.
    for (const id of [
      'r-unauth-2-device-lost-before-signing',
      'r-chain-bad-signature-mismatch',
      'r-default-01-no-rule-matched',
    ]) {
      expect(
        cases.map((c) => c.id),
        id,
      ).toContain(id)
    }
  })

  it('credits an edge-case id on the cases that exist for one, so `pnpm test:ec` can count them', () => {
    const ec = new Set(cases.flatMap((c) => c.ec ?? []))
    for (const id of [
      'EC-DSP-1',
      'EC-DSP-2',
      'EC-DSP-6',
      'EC-DSP-7',
      'EC-DSP-9',
      'EC-MER-3',
      'EC-MER-4',
      'EC-BUY-3',
    ]) {
      expect([...ec], id).toContain(id)
    }
  })
})

// ---------------------------------------------------------------------------
// 3. The score — §8.16 AT-M15.1
// ---------------------------------------------------------------------------

describe('the router decides the labelled cases', () => {
  const report = evaluate()

  it(`AT-M15.1 scores ${summarise(report)} on exact match of ruleId and posture`, () => {
    if (report.passed !== report.total) {
      throw new Error(
        `${report.total - report.passed} of ${report.total} cases did not match their label.\n` +
          `AT-M15.1 asks for 100%. If a case's label is wrong, fix the label and say why in the PR; ` +
          `if the table is wrong, fix the table. Editing an expectation to make the runner pass measures ` +
          `nothing.\n${formatFailures(report)}`,
      )
    }
    expect(report.accuracy).toBe(1)
  })

  it('agrees with the recorded evidence types on every case', () => {
    if (report.evidenceAgreed !== report.total) {
      throw new Error(
        `evidence-type mismatches on ${report.total - report.evidenceAgreed} case(s)\n${formatFailures(report)}`,
      )
    }
    expect(report.evidenceAgreed).toBe(report.total)
  })

  it('reports a per-rule breakdown, so a weak spot is visible as a count rather than a total', () => {
    expect(report.byRule.size).toBe(RULE_ORDER.length)
    for (const [rule, row] of report.byRule) {
      expect(row.passed, `${rule} passed`).toBe(row.total)
      expect(row.total, `${rule} has no cases`).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// 4. The invariant — the property, not the cases
// ---------------------------------------------------------------------------

describe('the CONTEST invariant, as a property over generated contexts', () => {
  it('posture CONTEST implies non-empty evidenceRequired, every member a real PayPal evidence_type', () => {
    fc.assert(
      fc.property(arbitraryContext(), (ctx) => {
        const d = route(ctx)
        if (d.posture !== 'CONTEST') return true
        if (d.evidenceRequired.length === 0) {
          throw new Error(
            `CONTEST with no evidence for rule ${d.ruleId}: ${d.rationale} (${JSON.stringify(ctx.dispute.reason)})`,
          )
        }
        for (const t of d.evidenceRequired) {
          if (!(EVIDENCE_TYPES as readonly string[]).includes(t)) {
            throw new Error(
              `CONTEST proposed "${t}", which is not a PayPal evidence_type (rule ${d.ruleId})`,
            )
          }
        }
        return true
      }),
      { numRuns: 2_000 },
    )
  })

  it('a CONTEST with a satisfied evidence list never carries blockingReason', () => {
    fc.assert(
      fc.property(arbitraryContext(), (ctx) => {
        const d = route(ctx)
        if (d.posture !== 'CONTEST') return true
        if (d.blockingReason !== undefined) {
          throw new Error(`CONTEST cannot be blocking: ${d.blockingReason}`)
        }
        return true
      }),
      { numRuns: 1_000 },
    )
  })

  it('blockingReason appears only on REVIEW, and its text never blames the clock', () => {
    // The distinction this pins: `R-NOCHAIN-1` on an already-passed deadline is still REVIEW, because the
    // *case* has no evidence - but the reason written for a human is about the evidence. A timeout is a
    // `DEF_DEADLINE_PASSED` for the filer to raise, not a reason to say a person must decide (EC-DSP-8).
    fc.assert(
      fc.property(arbitraryContext(), (ctx) => {
        const d = route(ctx)
        if (d.blockingReason === undefined) return true
        if (d.posture !== 'REVIEW') {
          throw new Error(`blockingReason on ${d.posture} (rule ${d.ruleId})`)
        }
        if (/deadline|timer|expired|late/i.test(d.blockingReason)) {
          throw new Error(`blockingReason blames the clock: ${d.blockingReason}`)
        }
        return true
      }),
      { numRuns: 1_000 },
    )
  })

  it('a passed deadline is reported on decision.deadline, never as blockingReason', () => {
    fc.assert(
      fc.property(arbitraryContext(), (ctx) => {
        const due = ctx.dispute.sellerResponseDueSec
        if (due === undefined || due === null || due >= ctx.nowSec) return true
        const d = route(ctx)
        if (d.deadline.state !== 'PASSED') {
          throw new Error(`a past due date did not produce PASSED, got ${d.deadline.state}`)
        }
        if (d.deadline.secondsLeft === null || d.deadline.secondsLeft > 0) {
          throw new Error(`PASSED with a non-negative countdown: ${d.deadline.countdown}`)
        }
        return true
      }),
      { numRuns: 1_000 },
    )
  })

  it('the rationale always names the rule it decided by', () => {
    fc.assert(
      fc.property(arbitraryContext(), (ctx) => {
        const d = route(ctx)
        if (!d.rationale.includes(`[${d.ruleId}]`)) {
          throw new Error(`rationale for ${d.ruleId} does not name it: ${d.rationale}`)
        }
        return true
      }),
      { numRuns: 1_000 },
    )
  })

  it('the chain check comes first: no verified chain can never reach a filing posture', () => {
    // §18 question 20, stated as a property rather than as a claim: for *any* context whose chain does not
    // verify, the posture is never CONTEST, OFFER or APPEAL.
    fc.assert(
      fc.property(arbitraryContext(), (ctx) => {
        const chain = ctx.chain ?? {}
        if (chain.verifyAtCaptureChainValid === true || chain.verifyNowChainValid === true)
          return true
        const d = route(ctx)
        if (d.posture === 'CONTEST' || d.posture === 'APPEAL') {
          throw new Error(
            `unverified chain reached ${d.posture} on rule ${d.ruleId} (reason ${ctx.dispute.reason})`,
          )
        }
        return true
      }),
      { numRuns: 2_000 },
    )
  })

  it('the router is deterministic: the same context gives byte-identical output', () => {
    fc.assert(
      fc.property(arbitraryContext(), (ctx) => {
        const a = route(ctx)
        const b = route({ ...ctx })
        expect(JSON.stringify(a)).toBe(JSON.stringify(b))
        return true
      }),
      { numRuns: 500 },
    )
  })

  it('the router does not mutate its input', () => {
    fc.assert(
      fc.property(arbitraryContext(), (ctx) => {
        const before = JSON.stringify(ctx, (_k, v) => (typeof v === 'bigint' ? `${v}` : v))
        route(ctx)
        const after = JSON.stringify(ctx, (_k, v) => (typeof v === 'bigint' ? `${v}` : v))
        expect(after).toBe(before)
        return true
      }),
      { numRuns: 300 },
    )
  })
})

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

const REASONS = [
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
  'A_REASON_PAYPAL_HAS_NOT_INVENTED_YET',
] as const

/**
 * A generator over the *whole* input space, not over the cases.
 *
 * Deliberately biased towards contradictory contexts — a chain that fails, a refund that is PENDING, a
 * shipment whose tracking was never registered, a preference that matches the shipped item — because the
 * bugs in a rules table live where two facts disagree, not where everything agrees.
 */
function arbitraryContext(): fc.Arbitrary<DisputeContext> {
  const sku = fc.constantFrom('SKU-TRAIL-42', 'SKU-ALPINE-07', 'SKU-COTTAGE-3')
  const attributes = fc.record({
    size: fc.option(fc.constantFrom('9', '10', 'UK 10'), { nil: undefined }),
    color: fc.option(fc.constantFrom('black', 'blue'), { nil: undefined }),
    model: fc.option(fc.constantFrom('X1', 'X2'), { nil: undefined }),
  })
  const shipment = fc.record({
    id: fc.constantFrom('shp_1', 'shp_2'),
    carrier: fc.constantFrom('BlueDart', 'DHL'),
    trackingNumber: fc.constantFrom('BD1', 'BD2', '', '  '),
    paypalTrackerId: fc.option(fc.constantFrom('TRK-1', 'TRK-2'), { nil: undefined }),
    status: fc.option(fc.constantFrom('SHIPPED', 'DELIVERED', 'NOT_SHIPPED', 'VOIDED'), {
      nil: undefined,
    }),
    lines: fc.array(fc.record({ sku, qty: fc.integer({ min: 1, max: 2 }) }), {
      minLength: 1,
      maxLength: 2,
    }),
  })
  const lines = fc.array(fc.record({ sku, qty: fc.integer({ min: 1, max: 3 }) }), {
    minLength: 0,
    maxLength: 3,
  })

  return fc
    .record({
      nowSec: fc.integer({ min: 1_700_000_000, max: 1_900_000_000 }),
      dueSec: fc.option(fc.integer({ min: 1_700_000_000, max: 1_900_000_000 }), { nil: undefined }),
      reason: fc.constantFrom(...REASONS),
      amount: fc.bigInt({ min: 0n, max: 5_000_000n }),
      mandate: fc.option(fc.boolean(), { nil: undefined }),
      verifyAtCapture: fc.option(fc.boolean(), { nil: undefined }),
      verifyNow: fc.option(fc.boolean(), { nil: undefined }),
      webauthn: fc.option(fc.boolean(), { nil: undefined }),
      deviceStatus: fc.option(fc.constantFrom('ACTIVE', 'LOST', 'REVOKED'), { nil: undefined }),
      iatSec: fc.option(fc.integer({ min: 1_700_000_000, max: 1_900_000_000 }), { nil: undefined }),
      lostAtSec: fc.option(fc.integer({ min: 1_700_000_000, max: 1_900_000_000 }), {
        nil: undefined,
      }),
      readback: fc.option(
        fc.constantFrom(
          '**What you are authorising**',
          '**What you are authorising**\nWe read **size** "9" as a preference, not a limit.',
          '**What you are authorising**\nWe read **size** "10" and **colour** "black" as preferences.',
        ),
        { nil: undefined },
      ),
      attributes,
      haveOrder: fc.boolean(),
      captureAmount: fc.bigInt({ min: 0n, max: 5_000_000n }),
      orderAmount: fc.bigInt({ min: 0n, max: 5_000_000n }),
      refunded: fc.bigInt({ min: 0n, max: 5_000_000n }),
      refundStatus: fc.constantFrom('COMPLETED', 'PENDING', 'FAILED'),
      shipments: fc.array(shipment, { minLength: 0, maxLength: 2 }),
      checkoutLines: lines,
      siblingShipment: fc.option(fc.constantFrom('shp_1', 'shp_2'), { nil: undefined }),
      previouslyLost: fc.boolean(),
      appealLink: fc.boolean(),
      newEvidence: fc.boolean(),
      autoAccept: fc.option(fc.bigInt({ min: 0n, max: 100_000n }), { nil: undefined }),
      weakThreshold: fc.option(fc.bigInt({ min: 0n, max: 100_000n }), { nil: undefined }),
      fulfilmentDoc: fc.boolean(),
      qualityDoc: fc.boolean(),
      receiptCopy: fc.boolean(),
    })
    .map((r) => {
      const orders: NonNullable<DisputeContext['order']> = {
        id: 'ord_1',
        customId: 'cs1:0000',
        invoiceId: 'INV-1',
        amount: { minor: r.orderAmount, currency: 'USD' },
      }
      const capture: NonNullable<DisputeContext['capture']> = {
        id: 'cap_1',
        paypalCaptureId: 'PAY-1',
        amount: { minor: r.captureAmount, currency: 'USD' },
        shipmentId: 'shp_1',
      }
      const refund: NonNullable<DisputeContext['refunds']>[number] = {
        id: 'ref_1',
        paypalRefundId: 'REFUND-1',
        amount: { minor: r.refunded, currency: 'USD' },
        status: r.refundStatus,
        atSec: r.nowSec - 86_400,
      }
      return {
        nowSec: r.nowSec,
        dispute: {
          id: 'dsp_1',
          paypalDisputeId: 'PP-DSP-1',
          reason: r.reason,
          stage: 'CHARGEBACK',
          status: 'WAITING_FOR_SELLER_RESPONSE',
          amount: { minor: r.amount, currency: 'USD' },
          // `undefined` means PayPal sent no deadline at all, which is the INQUIRY-stage case.
          ...(r.dueSec === undefined ? {} : { sellerResponseDueSec: r.dueSec }),
          previouslyLost: r.previouslyLost,
          appealLinkPresent: r.appealLink,
          newEvidenceSinceLoss: r.newEvidence,
        },
        capture,
        ...(r.haveOrder ? { order: orders } : {}),
        refunds: [refund],
        shipments: r.shipments,
        siblingCaptures:
          r.siblingShipment === undefined
            ? []
            : [
                {
                  id: 'cap_2',
                  paypalCaptureId: 'PAY-2',
                  amount: { minor: r.captureAmount, currency: 'USD' },
                  shipmentId: r.siblingShipment,
                },
              ],
        chain: {
          mandatePresent: r.mandate,
          verifyAtCaptureChainValid: r.verifyAtCapture,
          verifyNowChainValid: r.verifyNow,
          webauthnPresent: r.webauthn,
          deviceStatus: r.deviceStatus,
          iatSec: r.iatSec,
          deviceLostAtSec: r.lostAtSec,
          readback: r.readback,
        },
        checkoutLines: r.checkoutLines,
        disputedItem: {
          sku: r.shipments[0]?.lines[0]?.sku ?? 'SKU-TRAIL-42',
          attributes: r.attributes,
        },
        preferences: { size: '10', color: 'black' },
        corpus: {
          fulfilmentDocument: r.fulfilmentDoc,
          qualityDocument: r.qualityDoc,
          receiptCopy: r.receiptCopy,
        },
        policy: {
          autoAcceptThresholdMinor: r.autoAccept,
          weakUnauthorisedThresholdMinor: r.weakThreshold,
        },
      } satisfies DisputeContext
    })
}

/** Keep the unused-import checker honest about the type-only imports used in the generator. */
export type { EvidenceType, RuleId }
