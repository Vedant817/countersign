/**
 * The 40-case router eval — spec **§8.16 AT-M15.1**.
 *
 * ```bash
 * pnpm --filter @countersign/defender eval
 * ```
 *
 * ## What it measures
 *
 * > "Router table tests: ≥ 2 fixtures per rule, plus a 40-case labelled eval with 100% expected-label
 * > accuracy (the rules are deterministic, so 100% is the bar)." — §8.16
 *
 * **Exact match on `ruleId` and `posture`.** Not similarity, not a majority vote, not "the right
 * neighbourhood": a case is right when the rule id is the one we wrote down and the posture is the one we
 * wrote down. `evidenceTypes` is checked too, but it is reported separately — it is the planner's output,
 * and a router that picks the right rule and then proposes the wrong document is a different bug from a
 * router that picks the wrong rule.
 *
 * ## Why 100% is achievable and why that matters
 *
 * There is no model in the loop. The router is a pure function of a literal context, and the cases are
 * hand-written to enumerate its branches. A score below 100% therefore means one of two things: the table
 * has a hole, or a case's label is wrong. Both are worth more than a green tick — which is why this runner
 * **fails loudly on every mismatch** rather than reporting a percentage and moving on.
 *
 * ## Why a tuned-to-green eval is worse than an honest 90%
 *
 * The tempting failure mode is to edit a case's `expect` until the runner passes. That produces a number
 * that measures nothing, and in a product whose claim is "the router decides, not the model" a number that
 * was fitted is worse than no number at all. **Nothing in this file writes to `router-cases.jsonl`.** The
 * cases are inputs, edited deliberately in a diff a reviewer can see.
 *
 * ## Coverage the cases are built to guarantee
 *
 * `test/eval.test.ts` checks the data before it checks the router:
 *
 * - every one of the 21 rule ids in `RULE_ORDER` appears, so a new rule cannot ship uncovered;
 * - `R-UNAUTH-2`, `R-UNAUTH-3` and `R-CHAIN-BAD` each have a case that a *different* rule could plausibly
 *   claim, which is how ordering bugs are caught (the spec's row order has three of them);
 * - three cases where the deadline changes the answer, since that is the one modifier rather than a rule;
 * - the no-evidence downgrade, in both directions (`REFUND` and `REVIEW`).
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { isCurrency, money, type Currency } from '@countersign/core'

import type {
  CaptureFacts,
  ChainFacts,
  DisputeContext,
  Posture,
  RefundFacts,
  RuleId,
  ShipmentFacts,
} from '../src/index'

// ---------------------------------------------------------------------------
// The case shape
// ---------------------------------------------------------------------------

/**
 * One labelled case.
 *
 * `dispute`, `chain` and `capture` are the three groups the router's input splits into — the dispute row,
 * the signed chain, and the money. They are kept separate in the data because they are separate in the
 * database too, and a case that had to name fifteen top-level fields would be unreadable.
 */
export interface RouterCase {
  readonly id: string
  /** One line describing the situation. Prose, for the human reading the diff. */
  readonly text: string
  readonly dispute: CaseDispute
  readonly chain: CaseChain
  readonly capture: CaseCapture
  readonly expect: {
    readonly ruleId: RuleId
    readonly posture: Posture
    /** Informational: checked, and reported, but not part of the score. See the file header. */
    readonly evidenceTypes: readonly string[]
  }
  /** The edge cases this case exists for, so `pnpm test:ec` can credit them. */
  readonly ec?: readonly string[]
  /**
   * Documentation, ignored by the runner.
   *
   * Used when a label has to be corrected: the note says **why the first label was wrong**, which is the
   * half of a correction a reviewer needs and the half that is easy to leave out. A case with no note says
   * its label was right first time. This mirrors the `_comment` convention in
   * `packages/compiler/eval/golden.jsonl`.
   */
  readonly _note?: string
}

/**
 * `dispute` facts, in the eval's compact JSON form. Integer minor units — `BigInt`, never a float
 * (spec §0 rule 9, and `pnpm lint`'s money-discipline scan).
 */
export interface CaseDispute {
  readonly reason: string
  readonly stage?: string
  readonly status?: string
  readonly amountMinor: number
  readonly currency: string
  readonly defenseState?: string
  /** `seller_response_due_date` in epoch **seconds** (spec §0 rule 10). Omitted = no deadline sent. */
  readonly sellerResponseDueSec?: number
  readonly appealLinkPresent?: boolean
  readonly previouslyLost?: boolean
  readonly newEvidenceSinceLoss?: boolean
  readonly autoAcceptThresholdMinor?: number
  readonly weakUnauthorisedThresholdMinor?: number
  readonly nowSec: number
}

export interface CaseChain {
  readonly mandatePresent?: boolean
  readonly readback?: string
  readonly iatSec?: number
  readonly webauthnPresent?: boolean
  readonly verifyAtCaptureChainValid?: boolean
  readonly verifyNowChainValid?: boolean
  readonly verifyErrors?: readonly string[]
  readonly deviceStatus?: string
  readonly deviceLostAtSec?: number
  readonly preferences?: {
    readonly size?: string
    readonly color?: string
    readonly model?: string
  }
  readonly corpus?: {
    readonly fulfilmentDocument?: boolean
    readonly qualityDocument?: boolean
    readonly receiptCopy?: boolean
  }
}

export interface CaseCapture {
  readonly amountMinor: number
  readonly refundedMinor?: number
  readonly shipmentId?: string
  readonly orderAmountMinor?: number
  readonly refunds?: readonly {
    readonly id: string
    readonly paypalRefundId: string
    readonly amountMinor: number
    readonly status: string
    readonly atSec: number
  }[]
  readonly siblings?: readonly {
    readonly id: string
    readonly amountMinor: number
    readonly shipmentId?: string
  }[]
  readonly shipments?: readonly {
    readonly id: string
    readonly carrier: string
    readonly trackingNumber: string
    readonly paypalTrackerId?: string
    readonly status?: string
    readonly lines?: readonly { readonly sku: string; readonly qty: number }[]
  }[]
  readonly checkoutLines?: readonly { readonly sku: string; readonly qty: number }[]
  readonly disputedItem?: {
    readonly sku: string
    readonly attributes?: {
      readonly size?: string
      readonly color?: string
      readonly model?: string
    }
  }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Parse JSONL, skipping blanks and `//` comment lines, with the line number in any error. */
export function parseJsonl<T>(text: string, label: string): T[] {
  const out: T[] = []
  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('//')) return
    try {
      out.push(JSON.parse(trimmed) as T)
    } catch (cause) {
      throw new Error(`${label}:${index + 1} is not valid JSON: ${(cause as Error).message}`)
    }
  })
  return out
}

const evalDir = fileURLToPath(new URL('.', import.meta.url))

/** The 40 cases. Read once per process; nothing here is ever written back. */
export function loadRouterCases(): RouterCase[] {
  return parseJsonl<RouterCase>(
    readFileSync(`${evalDir}router-cases.jsonl`, 'utf8'),
    'router-cases.jsonl',
  )
}

// ---------------------------------------------------------------------------
// The adapter: case data → `DisputeContext`
// ---------------------------------------------------------------------------

/**
 * Turn one case's compact JSON into a {@link DisputeContext}.
 *
 * Money is converted with `BigInt`, never `Number`: the JSON number is the boundary and a price that lost
 * precision on the way in would be a wrong price in a router decision (`packages/compiler/eval/runner.ts`
 * makes the same choice, for the same reason).
 *
 * **Nothing is defaulted that a case could state.** The only defaulting is for fields a case legitimately
 * omits — no `refunds` key means no refunds. `nowSec` is required, because a deadline assertion without a
 * clock is not an assertion.
 */
export function contextFromCase(c: RouterCase): DisputeContext {
  const currency = isCurrency(c.dispute.currency)
    ? c.dispute.currency
    : assertCurrency(c.dispute.currency)
  const cap = c.capture

  const order =
    cap.orderAmountMinor === undefined
      ? undefined
      : {
          id: `ord_${c.id}`,
          customId: `cs1:${'0'.repeat(43)}`,
          invoiceId: `INV-${c.id}`,
          amount: money(BigInt(cap.orderAmountMinor), currency),
        }

  const capture: CaptureFacts = {
    id: `cap_${c.id}`,
    paypalCaptureId: `PAY-${c.id.toUpperCase()}`,
    amount: money(BigInt(cap.amountMinor), currency),
    ...(cap.shipmentId === undefined ? {} : { shipmentId: cap.shipmentId }),
  }

  const shipments: ShipmentFacts[] = (cap.shipments ?? []).map((s, i) => ({
    id: s.id,
    carrier: s.carrier,
    trackingNumber: s.trackingNumber,
    ...(s.paypalTrackerId === undefined ? {} : { paypalTrackerId: s.paypalTrackerId }),
    ...(s.status === undefined ? {} : { status: s.status }),
    lines: (s.lines ?? []).map((l) => ({ sku: l.sku, qty: l.qty })),
    ...(i === 0 ? {} : {}),
  }))

  const refunds: RefundFacts[] = (cap.refunds ?? []).map((r) => ({
    id: r.id,
    paypalRefundId: r.paypalRefundId,
    amount: money(BigInt(r.amountMinor), currency),
    status: r.status,
    atSec: r.atSec,
  }))

  const siblingCaptures: CaptureFacts[] = (cap.siblings ?? []).map((s) => ({
    id: s.id,
    paypalCaptureId: `PAY-${s.id.toUpperCase()}`,
    amount: money(BigInt(s.amountMinor), currency),
    ...(s.shipmentId === undefined ? {} : { shipmentId: s.shipmentId }),
  }))

  const chain: ChainFacts = {
    ...(c.chain.mandatePresent === undefined ? {} : { mandatePresent: c.chain.mandatePresent }),
    ...(c.chain.readback === undefined ? {} : { readback: c.chain.readback }),
    ...(c.chain.iatSec === undefined ? {} : { iatSec: c.chain.iatSec }),
    ...(c.chain.webauthnPresent === undefined ? {} : { webauthnPresent: c.chain.webauthnPresent }),
    ...(c.chain.verifyAtCaptureChainValid === undefined
      ? {}
      : { verifyAtCaptureChainValid: c.chain.verifyAtCaptureChainValid }),
    ...(c.chain.verifyNowChainValid === undefined
      ? {}
      : { verifyNowChainValid: c.chain.verifyNowChainValid }),
    ...(c.chain.verifyErrors === undefined ? {} : { verifyErrors: c.chain.verifyErrors }),
    ...(c.chain.deviceStatus === undefined ? {} : { deviceStatus: c.chain.deviceStatus }),
    ...(c.chain.deviceLostAtSec === undefined ? {} : { deviceLostAtSec: c.chain.deviceLostAtSec }),
  }

  const context: DisputeContext = {
    nowSec: c.dispute.nowSec,
    dispute: {
      id: `dsp_${c.id}`,
      paypalDisputeId: `PP-DSP-${c.id.toUpperCase()}`,
      reason: c.dispute.reason,
      stage: c.dispute.stage ?? 'CHARGEBACK',
      status: c.dispute.status ?? 'WAITING_FOR_SELLER_RESPONSE',
      amount: money(BigInt(c.dispute.amountMinor), currency),
      ...(c.dispute.defenseState === undefined ? {} : { defenseState: c.dispute.defenseState }),
      captureId: capture.id,
      ...(order === undefined ? {} : { orderId: order.id }),
      ...(c.dispute.sellerResponseDueSec === undefined
        ? { sellerResponseDueSec: null }
        : { sellerResponseDueSec: c.dispute.sellerResponseDueSec }),
      ...(c.dispute.appealLinkPresent === undefined
        ? {}
        : { appealLinkPresent: c.dispute.appealLinkPresent }),
      ...(c.dispute.previouslyLost === undefined
        ? {}
        : { previouslyLost: c.dispute.previouslyLost }),
      ...(c.dispute.newEvidenceSinceLoss === undefined
        ? {}
        : { newEvidenceSinceLoss: c.dispute.newEvidenceSinceLoss }),
    },
    capture,
    ...(order === undefined ? {} : { order }),
    ...(refunds.length === 0 ? {} : { refunds }),
    ...(shipments.length === 0 ? {} : { shipments }),
    ...(siblingCaptures.length === 0 ? {} : { siblingCaptures }),
    chain,
    ...(cap.checkoutLines === undefined
      ? {}
      : { checkoutLines: cap.checkoutLines.map((l) => ({ sku: l.sku, qty: l.qty })) }),
    ...(cap.disputedItem === undefined
      ? {}
      : {
          disputedItem: {
            sku: cap.disputedItem.sku,
            attributes: cap.disputedItem.attributes ?? {},
          },
        }),
    ...(c.chain.preferences === undefined ? {} : { preferences: c.chain.preferences }),
    ...(c.chain.corpus === undefined ? {} : { corpus: c.chain.corpus }),
    policy: {
      ...(c.dispute.autoAcceptThresholdMinor === undefined
        ? {}
        : { autoAcceptThresholdMinor: BigInt(c.dispute.autoAcceptThresholdMinor) }),
      ...(c.dispute.weakUnauthorisedThresholdMinor === undefined
        ? {}
        : { weakUnauthorisedThresholdMinor: BigInt(c.dispute.weakUnauthorisedThresholdMinor) }),
    },
  }
  return context
}

function assertCurrency(value: string): Currency {
  throw new Error(`router-cases: ${value} is not a supported ISO-4217 currency`)
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface CaseResult {
  readonly id: string
  readonly text: string
  readonly expectedRule: RuleId
  readonly expectedPosture: Posture
  readonly actualRule: RuleId
  readonly actualPosture: Posture
  readonly expectedEvidence: readonly string[]
  readonly actualEvidence: readonly string[]
  /** AT-M15.1 scores these two. `evidenceOk` is reported, not scored — see the file header. */
  readonly pass: boolean
  readonly evidenceOk: boolean
}

export interface EvalReport {
  readonly total: number
  readonly passed: number
  readonly accuracy: number
  readonly evidenceAgreed: number
  readonly results: readonly CaseResult[]
  /** Rule id → cases that got it right, so a weak spot is visible as a count. */
  readonly byRule: ReadonlyMap<string, { total: number; passed: number }>
}

export type RouterFn = (c: RouterCase) => {
  ruleId: RuleId
  posture: Posture
  evidenceRequired: readonly string[]
}

/**
 * Score one case. **Exact match on `ruleId` and `posture`**, nothing else.
 *
 * The router is injected rather than imported so this runner stays a pure function of (cases, router) and
 * can be pointed at a modified router to see which cases change — which is how you check a table edit
 * against the cases instead of against your memory of them.
 */
export function scoreCase(router: RouterFn, c: RouterCase): CaseResult {
  const actual = router(c)
  const expectedEvidence = [...c.expect.evidenceTypes].sort()
  const actualEvidence = [...actual.evidenceRequired].sort()
  return {
    id: c.id,
    text: c.text,
    expectedRule: c.expect.ruleId,
    expectedPosture: c.expect.posture,
    actualRule: actual.ruleId,
    actualPosture: actual.posture,
    expectedEvidence,
    actualEvidence,
    pass: actual.ruleId === c.expect.ruleId && actual.posture === c.expect.posture,
    evidenceOk:
      expectedEvidence.length === actualEvidence.length &&
      expectedEvidence.every((t, i) => t === actualEvidence[i]),
  }
}

export function runEval(cases: readonly RouterCase[], router: RouterFn): EvalReport {
  const results = cases.map((c) => scoreCase(router, c))
  const byRule = new Map<string, { total: number; passed: number }>()
  for (const r of results) {
    const row = byRule.get(r.expectedRule) ?? { total: 0, passed: 0 }
    row.total += 1
    if (r.pass) row.passed += 1
    byRule.set(r.expectedRule, row)
  }
  const passed = results.filter((r) => r.pass).length
  return {
    total: results.length,
    passed,
    accuracy: results.length === 0 ? 0 : passed / results.length,
    evidenceAgreed: results.filter((r) => r.evidenceOk).length,
    results,
    byRule,
  }
}

/** One line per failure. Called from a test, so it prints rather than throws. */
export function formatFailures(report: EvalReport): string {
  return report.results
    .filter((r) => !r.pass || !r.evidenceOk)
    .map((r) => {
      const verdict = r.pass ? (r.evidenceOk ? '' : ' (evidence mismatch)') : ' (scored)'
      return [
        `  ${r.id}${verdict}`,
        `    ${r.text}`,
        `    expected ${r.expectedRule}/${r.expectedPosture} evidence=[${r.expectedEvidence.join(', ')}]`,
        `    actual   ${r.actualRule}/${r.actualPosture} evidence=[${r.actualEvidence.join(', ')}]`,
      ].join('\n')
    })
    .join('\n')
}

/** A one-line summary for the test name, so a green run says what it measured. */
export function summarise(report: EvalReport): string {
  return `${report.passed}/${report.total} exact (${(report.accuracy * 100).toFixed(1)}%), evidence ${report.evidenceAgreed}/${report.total}`
}
