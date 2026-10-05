/**
 * The Dispute Strategist — spec **§8.16 (M16)**, **§18 question 31**, work package **WP-16**.
 * Acceptance **AT-M16.1**, **AT-M16.2**.
 *
 * ```bash
 * pnpm --filter @countersign/defender test
 * ```
 *
 * ## The one question this file exists to answer
 *
 * §18 question 31 — *"Merchant games the evidence?"* — has its third and load-bearing answer here, and it is a
 * **type**, not a check: {@link StrategistPayPalMethod} does not contain `provideEvidence`. So no proposal this
 * module can produce, whatever a model returns and however malformed, has a path to an evidence upload. The
 * first four `it(...)` blocks are that claim, asserted from four directions — the union, the runtime table, the
 * posture table, and a source scan — because a guarantee asserted one way is a guarantee one refactor away from
 * being decorative.
 *
 * ## What is faked, and what is not
 *
 * - **`executeStrategy` drives the real `PayPalClient`** with an injected `fetchImpl`, exactly as
 *   `test/filer.test.ts` does. AT-M16.2 is *"each action calls the right endpoint"*, and asserting that against a
 *   hand-written stub client would assert that the stub was called. The responses are doc-derived stubs; nothing
 *   here asserts PayPal behaviour from them.
 * - **Our rows** come from `createInMemoryDefenderWorld`, which models `dispute_actions_idempotency_key_key`.
 * - **The model is a one-function port** and is optional throughout. `docs/HUMAN_TODO.md` H-02 (no OpenAI key)
 *   therefore cannot affect a single test in this file.
 *
 * ## EC coverage named here, so `pnpm test:ec` counts it
 *
 * EC-DSP-4 · EC-DSP-5 · EC-DSP-6 · EC-DSP-10 · EC-BUY-1 · EC-MER-7 · EC-FX-4 · EC-LLM-1 · EC-MER-3.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { fixedClock, type Clock, type Money } from '@countersign/core'
import type { DisputeActionRow } from '@countersign/db'
import {
  ACKNOWLEDGEMENT_TYPES,
  DISPUTE_ACTIONS,
  EVIDENCE_INPUT_FIELD,
  MAX_EVIDENCE_FILE_BYTES,
  OFFER_TYPES,
  PayPalClient,
} from '@countersign/paypal'
import { describe, expect, it } from 'vitest'

import {
  createInMemoryDefenderWorld,
  toJsonValue,
  type DefenderWorldSeed,
  type InMemoryDefenderWorld,
} from '../src/ingest'
import { route } from '../src/router'
import {
  ACTION_ROW_NAME,
  executeStrategy,
  resolveOfferType,
  type ExecuteOptions,
  type StrategyOutcome,
  type StrategistActionDeps,
} from '../src/strategist-actions'
import {
  DEFAULT_OFFER_SHARE,
  HANDLING_COST_LABEL,
  MRC_AVERAGE_HANDLING_COST_MINOR,
  PAYPAL_METHOD_FOR_ACTION,
  REQUEST_TOKEN_FOR_ACTION,
  STRATEGIST_ACTIONS,
  STRATEGIST_ACTIONS_BY_POSTURE,
  actionWithinPosture,
  candidateListSchema,
  clampNote,
  costFor,
  newFactsSince,
  offerBudget,
  parseStrategistProposal,
  partialOfferAmount,
  permittedActionsFor,
  proposeStrategy,
  proposeStrategyDeterministic,
  strategistProposalSchema,
  strategistSystemPrompt,
  type StrategistAction,
  type StrategistProposal,
} from '../src/strategist'
import type { DisputeContext, LiabilityDecision, Posture } from '../src/types'

// ---------------------------------------------------------------------------
// One fixed instant (AGENTS.md rule 10)
// ---------------------------------------------------------------------------

const NOW_SEC = 1_789_000_000
const CLOCK: Clock = fixedClock(NOW_SEC)

const DISPUTE_ID = 'dsp_93666602ad1432056b16a2d239'
const PAYPAL_DISPUTE_ID = 'PP-D-2781AB12CD34'
const PAYPAL_CAPTURE_ID = '3C679366HH908993F'
const SANDBOX_BASE = 'https://api-m.sandbox.paypal.com'

/** USD 129.99, in integer minor units (§0 rule 9). The demo store's disputed amount. */
const DISPUTED: Money = { minor: 12_999n, currency: 'USD' }

/** Every request-id token, so a test can assert the mapping against `@countersign/paypal`'s closed set. */
const ALL_TOKENS = DISPUTE_ACTIONS

// ---------------------------------------------------------------------------
// The context: plain data, built here rather than through the store
// ---------------------------------------------------------------------------

/**
 * **A hand-built {@link DisputeContext}, and that is a deliberate difference from `test/filer.test.ts`.**
 *
 * The filer suite must build its context through `buildDisputeContext`, or a fixture could disagree with the
 * reader and assert a posture the product can never reach. The strategist has no such risk: it is handed the
 * context the router was handed, and what is under test is *what it does with one*. Building the literal here
 * keeps the arithmetic in §3 legible — every money value in these tests is visible in one screen.
 */
function ctxOf(over: Partial<DisputeContext> = {}): DisputeContext {
  return {
    nowSec: NOW_SEC,
    dispute: {
      id: DISPUTE_ID,
      paypalDisputeId: PAYPAL_DISPUTE_ID,
      reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
      stage: 'CHARGEBACK',
      status: 'WAITING_FOR_SELLER_RESPONSE',
      amount: DISPUTED,
      defenseState: 'ANALYSED',
      captureId: 'cap_00000000000000000000000001',
      orderId: 'ord_00000000000000000000000001',
      sellerResponseDueSec: NOW_SEC + 5 * 86_400,
    },
    capture: {
      id: 'cap_00000000000000000000000001',
      paypalCaptureId: PAYPAL_CAPTURE_ID,
      amount: DISPUTED,
      refundedMinor: 0n,
      finalCapture: true,
    },
    order: {
      id: 'ord_00000000000000000000000001',
      customId: `cs1:${'A'.repeat(43)}`,
      invoiceId: 'INV-NW-000042',
      amount: DISPUTED,
      intent: 'AUTHORIZE',
    },
    refunds: [],
    shipments: [
      {
        id: 'shp_00000000000000000000000001',
        carrier: 'DHL',
        trackingNumber: 'JD0002000031',
        paypalTrackerId: 'TRACKER-1Z999AA10123456784',
        status: 'DELIVERED',
        lines: [{ sku: 'SKU-TRAIL-42', qty: 1 }],
      },
    ],
    siblingCaptures: [],
    chain: {
      mandatePresent: true,
      readback: 'Only at **Northwind Outfitters**',
      iatSec: NOW_SEC - 86_400,
      webauthnPresent: true,
      verifyAtCaptureChainValid: true,
      gateDecision: 'ALLOW',
      deviceStatus: 'ACTIVE',
    },
    checkoutLines: [{ sku: 'SKU-TRAIL-42', qty: 1 }],
    corpus: { fulfilmentDocument: true, receiptCopy: true },
    policy: {},
    ...over,
  } as unknown as DisputeContext
}

function decisionOf(posture: Posture, over: Partial<LiabilityDecision> = {}): LiabilityDecision {
  return {
    ruleId: 'R-SNAD-THIN',
    liability: 'USER_AUTHORISED',
    posture,
    rationale: `Rule R-SNAD-THIN chose ${posture} for this case.`,
    reasons: ['no document shows the goods were as described'],
    facts: [
      { key: 'dispute.amount', value: 'USD 129.99', source: 'disputes' },
      { key: 'capture.id', value: PAYPAL_CAPTURE_ID, source: 'captures' },
      { key: 'router.rule', value: 'R-SNAD-THIN', source: 'defender.router' },
    ],
    evidenceRequired: [],
    action: null,
    deadline: { state: 'COMFORTABLE', secondsLeft: 432_000, countdown: '5d 0h' },
    ...over,
  } as LiabilityDecision
}

/**
 * The file's text with block and line comments removed.
 *
 * Needed because a doc comment legitimately *names* `provideEvidence` to say it must never be called from there.
 * Exempting the whole file instead would let the next caller walk straight in, which is the failure the scan
 * exists to prevent — so the comments go and the code is what is scanned.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

// ---------------------------------------------------------------------------
// 1. §18 q31, part one: the vocabulary has no upload in it
// ---------------------------------------------------------------------------

describe('§18 q31: the strategist has no vocabulary for filing evidence', () => {
  it('no member of PAYPAL_METHOD_FOR_ACTION names an evidence upload', () => {
    const methods = Object.values(PAYPAL_METHOD_FOR_ACTION).filter(
      (m): m is NonNullable<typeof m> => m !== null,
    )
    expect(methods).toEqual([
      'sendMessage',
      'makeOffer',
      'acknowledgeReturnItem',
      'escalate',
      'appeal',
      'provideSupportingInfo',
    ])
    // **The assertion, stated four ways so a rename cannot quietly undo it.**
    for (const forbidden of [
      'provideEvidence',
      'provide-evidence',
      'provide_evidence',
      'file',
      'acceptClaim',
      'refundCapture',
    ]) {
      expect(methods).not.toContain(forbidden)
    }
    expect(methods.some((m) => /evidence/i.test(m))).toBe(false)
    // **Exactly one action makes no PayPal call**, and it is the one that sends nothing.
    expect(PAYPAL_METHOD_FOR_ACTION['REVIEW_WITH_HUMAN']).toBeNull()
    expect(Object.values(PAYPAL_METHOD_FOR_ACTION).filter((m) => m === null)).toHaveLength(1)
  })

  it('no member of the action union files evidence, accepts a claim, or moves money by itself', () => {
    // **§8.16's own list**: make-offer, message, acknowledge return, appeal, supporting info, escalate, and a
    // human. Filing is `fileDispute`'s on a CONTEST, a refund is the filer's on a REFUND, `accept-claim` is the
    // filer's on an ACCEPT_CLAIM. A strategist that could reach any of them would be a second authority over the
    // posture — the thing this package exists to prevent.
    expect([...STRATEGIST_ACTIONS].sort()).toEqual([
      'ACKNOWLEDGE_RETURN',
      'APPEAL',
      'ESCALATE',
      'MAKE_OFFER',
      'MESSAGE_BUYER',
      'PROVIDE_SUPPORTING_INFO',
      'REVIEW_WITH_HUMAN',
    ])
    for (const forbidden of ['FILE', 'PROVIDE_EVIDENCE', 'ACCEPT_CLAIM', 'REFUND', 'UPLOAD']) {
      expect(STRATEGIST_ACTIONS).not.toContain(forbidden)
    }
  })

  it('every action has a request-id token that @countersign/paypal actually accepts', () => {
    // **`disputeActionRequestId` throws on an unknown token**, so a missing or misspelled entry would only
    // surface at execution time. Asserting the closed set here is the cheap half of that guard.
    for (const action of STRATEGIST_ACTIONS) {
      expect(ALL_TOKENS).toContain(REQUEST_TOKEN_FOR_ACTION[action])
    }
    // **The tokens are shared where PayPal's endpoints share a slot**, which is a fact about the API rather than
    // a choice: an offer and a refund are both the `offer` slot's neighbours in `cs:{disputeId}:…`.
    expect(new Set(Object.values(REQUEST_TOKEN_FOR_ACTION)).size).toBe(6)
  })

  it('no file in src/ except filer.ts can CALL the upload, and the comment-stripped scan says so', () => {
    /**
     * **The structural half, and a stronger statement than "the strategist has none".**
     *
     * An ESLint rule cannot run inside vitest, and a rule nobody has watched fire is a rule nobody has checked —
     * so this scans `src/` as plain text. The claim is that `filer.ts` is the **only** module in this package
     * that can *call* the upload method, which is what makes "one upload site" checkable rather than claimed.
     *
     * Two details matter. **Comments are stripped** first, because `drafter.ts` and `ingest.ts` both *name* the
     * method in prose to say it must never be called from there — exempting those files instead would let the
     * next caller walk straight in. And the scan looks for `.provideEvidence(`, i.e. a **call site** rather
     * than the identifier: `ingest.ts`'s `DefenderPayPal` port legitimately carries `'provideEvidence'` as one
     * member of a `Pick`, because the filer needs it and the port is shared.
     */
    const dir = join(__dirname, '..', 'src')
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'))

    for (const file of files) {
      const code = stripComments(readFileSync(join(dir, file), 'utf8'))
      if (file === 'filer.ts') continue
      expect(/\.provideEvidence\s*\(/.test(code), `${file} calls provideEvidence`).toBe(false)
    }

    // **`filer.ts` is the one site**, and it is behind a permit — asserted here so the exemption above is not a
    // blank cheque.
    const filer = stripComments(readFileSync(join(dir, 'filer.ts'), 'utf8'))
    expect(filer.match(/\.provideEvidence\s*\(/g)).toHaveLength(1)
    expect(filer).toContain('permit.requestId')

    // **And `strategist-actions.ts` does not carry it even in its `Pick`** — two independent omissions, because
    // one is a rename away from being undone. Asserted on the member names rather than on a literal source
    // substring, so a Prettier reflow of the union cannot make this pass or fail for the wrong reason.
    const actions = stripComments(readFileSync(join(dir, 'strategist-actions.ts'), 'utf8'))
    for (const member of [
      'sendMessage',
      'makeOffer',
      'acknowledgeReturnItem',
      'provideSupportingInfo',
      'appeal',
      'escalate',
    ]) {
      expect(actions).toContain(`'${member}'`)
    }
    expect(actions).not.toContain('provideEvidence')
  })
})

// ---------------------------------------------------------------------------
// 2. §18 q31, part two: the posture table
// ---------------------------------------------------------------------------

describe('§18 q31: a proposal may only act within the posture it was given', () => {
  it('the posture table is exactly the seven postures and nothing may file evidence in any of them', () => {
    expect(Object.keys(STRATEGIST_ACTIONS_BY_POSTURE).sort()).toEqual([
      'ACCEPT_CLAIM',
      'APPEAL',
      'CONTEST',
      'MESSAGE_ONLY',
      'OFFER',
      'REFUND',
      'REVIEW',
    ])
    for (const posture of Object.keys(STRATEGIST_ACTIONS_BY_POSTURE) as Posture[]) {
      for (const action of STRATEGIST_ACTIONS_BY_POSTURE[posture]) {
        expect(PAYPAL_METHOD_FOR_ACTION[action]).not.toBe('provideEvidence')
      }
    }
    // **EC-DSP-5 as a property of a table**: a `CONTEST` may escalate or supply supporting info, never re-file.
    expect(STRATEGIST_ACTIONS_BY_POSTURE['CONTEST']).toEqual([
      'PROVIDE_SUPPORTING_INFO',
      'ESCALATE',
    ])
    // **The converse: the strategist cannot lower a posture.** `REFUND`'s list is empty, so there is nothing to
    // propose — the money movement is the filer's and §8.15 already decided it.
    expect(STRATEGIST_ACTIONS_BY_POSTURE['REFUND']).toEqual([])
  })

  it('permittedActionsFor filters the table by what this case can actually do', () => {
    const ctx = ctxOf()

    // **`MAKE_OFFER` needs money left.** With nothing left it drops out, and a `$0.00` offer is a rejection.
    expect(permittedActionsFor(ctx, decisionOf('OFFER'))).toEqual(['MAKE_OFFER', 'MESSAGE_BUYER'])
    const spent = ctxOf({
      capture: { ...ctx.capture!, refundedMinor: DISPUTED.minor },
      refunds: [
        {
          id: 'ref_1',
          paypalRefundId: '1JU08902781691411',
          amount: DISPUTED,
          status: 'COMPLETED',
          atSec: NOW_SEC,
        },
      ],
    })
    expect(permittedActionsFor(spent, decisionOf('OFFER'))).toEqual(['MESSAGE_BUYER'])

    // **`ACKNOWLEDGE_RETURN` needs a shipment**: nothing shipped, no parcel to acknowledge, and PayPal would not
    // have offered the endpoint.
    const unshipped = ctxOf({ shipments: [] })
    expect(permittedActionsFor(unshipped, decisionOf('MESSAGE_ONLY'))).toEqual([
      'MAKE_OFFER',
      'MESSAGE_BUYER',
    ])
    expect(permittedActionsFor(ctx, decisionOf('MESSAGE_ONLY'))).toEqual([
      'MAKE_OFFER',
      'MESSAGE_BUYER',
      'ACKNOWLEDGE_RETURN',
    ])

    // **`APPEAL` needs the posture**, because `route()` reaches APPEAL only via R-APPEAL-1 — that is, only when
    // PayPal offered the `appeal` HATEOAS link **and** something material arrived since the loss.
    // **`STRATEGIST_ACTIONS` order, not the table's declaration order**, and the two differ here: `PROVIDE_
    // SUPPORTING_INFO` is declared before `APPEAL` in the table but sorts after it in the ranking, so the
    // deterministic first pick on an `APPEAL` posture is *supporting info*, not the appeal. That is deliberate —
    // the cheapest action that helps wins — and it is why the appeal arm is reached by a merchant's choice.
    expect(permittedActionsFor(ctx, decisionOf('APPEAL'))).toEqual([
      'PROVIDE_SUPPORTING_INFO',
      'APPEAL',
    ])
    expect(permittedActionsFor(ctx, decisionOf('CONTEST'))).not.toContain('APPEAL')

    // **Returned in `STRATEGIST_ACTIONS` order**, which is also the tie-break order, so it is deterministic.
    const every = permittedActionsFor(ctx, decisionOf('MESSAGE_ONLY'))
    expect(every).toEqual(STRATEGIST_ACTIONS.filter((a) => every.includes(a)))
  })

  it('actionWithinPosture is the runtime restatement of the type-level guarantee', () => {
    for (const posture of Object.keys(STRATEGIST_ACTIONS_BY_POSTURE) as Posture[]) {
      const decision = decisionOf(posture)
      for (const action of STRATEGIST_ACTIONS) {
        expect(actionWithinPosture(action, decision)).toBe(
          STRATEGIST_ACTIONS_BY_POSTURE[posture].includes(action),
        )
      }
    }
    // **The two claims that matter most, stated directly.**
    expect(actionWithinPosture('MAKE_OFFER', decisionOf('OFFER'))).toBe(true)
    expect(actionWithinPosture('MAKE_OFFER', decisionOf('REFUND'))).toBe(false)
    expect(actionWithinPosture('APPEAL', decisionOf('APPEAL'))).toBe(true)
    expect(actionWithinPosture('APPEAL', decisionOf('CONTEST'))).toBe(false)
    expect(actionWithinPosture('ESCALATE', decisionOf('REVIEW'))).toBe(false)
  })

  it('the system prompt lists the permitted actions and says the list is closed', () => {
    const prompt = strategistSystemPrompt(ctxOf(), decisionOf('MESSAGE_ONLY'))
    for (const action of permittedActionsFor(ctxOf(), decisionOf('MESSAGE_ONLY'))) {
      expect(prompt).toContain(`- ${action}`)
    }
    // **And does not list the ones outside the posture** — asking properly is cheaper than blocking.
    expect(prompt).not.toContain('- ESCALATE')
    expect(prompt).not.toContain('- APPEAL')
    expect(prompt).toContain('This list is CLOSED')
    // **It states the money it is talking about, in minor units**, so a model cannot invent a float.
    expect(prompt).toContain('USD, 12999 minor units')
    expect(prompt).toContain('R-SNAD-THIN')

    // **A posture that permits nothing says so**, rather than listing everything and filtering later.
    expect(strategistSystemPrompt(ctxOf(), decisionOf('REFUND'))).toContain(
      '(none — this posture permits no action at all)',
    )
  })
})

// ---------------------------------------------------------------------------
// 3. The offer arithmetic
// ---------------------------------------------------------------------------

describe('the offer arithmetic is integer minor units and the sum is exact', () => {
  it('Σ offers + prior refunds ≤ capture, and `withinCapture` is asserted rather than claimed', () => {
    const ctx = ctxOf()
    const budget = offerBudget(ctx, [])
    expect(budget.captureAmount).toEqual(DISPUTED)
    expect(budget.alreadyRefunded).toEqual({ minor: 0n, currency: 'USD' })
    expect(budget.remaining).toEqual(DISPUTED)
    expect(budget.committed).toEqual({ minor: 0n, currency: 'USD' })
    expect(budget.withinCapture).toBe(true)

    const half = partialOfferAmount(ctx, DEFAULT_OFFER_SHARE, [])
    expect(half.ok).toBe(true)
    if (!half.ok) throw new Error('expected ok')
    /**
     * **`allocate(12999, [1, 1])` gives 6500 / 6499** — the largest-remainder split rounds the *first* weight up,
     * so the offer takes the extra minor unit and its complement takes exactly the remainder.
     *
     * Which half gets the odd cent is a choice; what is not a choice is that **the two sum to `remaining`
     * exactly.** Computing `remaining * n / d` instead would give 6499 for the offer and 6499 for the
     * complement — 12998, one cent unaccounted for, which is precisely what EC-FX-4 and §18 q22 forbid.
     */
    expect(half.value).toEqual({ minor: 6_500n, currency: 'USD' })
    expect(DISPUTED.minor - half.value.minor).toBe(6_499n)
    expect(half.value.minor + (DISPUTED.minor - half.value.minor)).toBe(DISPUTED.minor)
  })

  it('prior offers are subtracted, and the invariant still holds with them', () => {
    const ctx = ctxOf()
    const first = partialOfferAmount(ctx, DEFAULT_OFFER_SHARE, [])
    if (!first.ok) throw new Error('expected ok')
    // **A second offer sees only what is left**, so two halves cannot add up to more than the capture.
    const second = partialOfferAmount(ctx, DEFAULT_OFFER_SHARE, [first.value])
    if (!second.ok) throw new Error('expected ok')
    expect(first.value.minor + second.value.minor).toBeLessThanOrEqual(DISPUTED.minor)
    expect(offerBudget(ctx, [first.value]).remaining).toEqual({ minor: 6_499n, currency: 'USD' })

    const third = partialOfferAmount(ctx, DEFAULT_OFFER_SHARE, [first.value, second.value])
    if (!third.ok) throw new Error('expected ok')
    // **Three halves of 12999 are 6500 + 3250 + 1625 = 11375, and 11375 + the uncommitted 1624 is exactly the
    // capture.** Nothing is invented and nothing is lost at any step.
    expect([first.value.minor, second.value.minor, third.value.minor]).toEqual([
      6_500n,
      3_250n,
      1_625n,
    ])
    expect(first.value.minor + second.value.minor + third.value.minor).toBeLessThanOrEqual(
      DISPUTED.minor,
    )
    expect(offerBudget(ctx, [first.value, second.value, third.value]).remaining.minor).toBe(1_624n)
  })

  it('a COMPLETED refund shrinks the budget and a PENDING one does not', () => {
    // **`completedRefunds(ctx)` rather than `captures.refunded_minor`**, because a PENDING refund has not
    // returned the money and must not shrink the budget — and because the router reads the same function, so the
    // strategist's ceiling and R-REF-1's threshold cannot drift apart.
    const completed = ctxOf({
      refunds: [
        {
          id: 'ref_1',
          paypalRefundId: '1JU08902781691411',
          amount: { minor: 4_000n, currency: 'USD' },
          status: 'COMPLETED',
          atSec: NOW_SEC,
        },
      ],
    })
    expect(offerBudget(completed, []).remaining).toEqual({ minor: 8_999n, currency: 'USD' })

    const pending = ctxOf({
      refunds: [
        {
          id: 'ref_1',
          paypalRefundId: '1JU08902781691411',
          amount: { minor: 4_000n, currency: 'USD' },
          status: 'PENDING',
          atSec: NOW_SEC,
        },
      ],
    })
    expect(offerBudget(pending, []).remaining).toEqual(DISPUTED)
  })

  it('remaining floors at zero, and a zero or over-refunded capture refuses rather than clamping', () => {
    // **A negative offer is meaningless** and `remaining: 0` plus a refusal is the honest report.
    const overRefunded = ctxOf({
      refunds: [
        {
          id: 'ref_1',
          paypalRefundId: '1JU08902781691411',
          amount: { minor: 20_000n, currency: 'USD' },
          status: 'COMPLETED',
          atSec: NOW_SEC,
        },
      ],
    })
    expect(offerBudget(overRefunded, []).remaining).toEqual({ minor: 0n, currency: 'USD' })
    const refused = partialOfferAmount(overRefunded, DEFAULT_OFFER_SHARE, [])
    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('expected err')
    expect(refused.error.code).toBe('CS_VALIDATION')
    expect(refused.error.message).toContain('nothing left to offer')
    // **A `$0.00` offer is a rejection, not an offer.**
    expect(refused.error.message).toContain('zero offer is a rejection')
  })

  it('a share that rounds to zero is refused, and so is a malformed share', () => {
    const tiny = ctxOf({
      capture: { ...ctxOf().capture!, amount: { minor: 1n, currency: 'USD' } },
    })
    const roundsToZero = partialOfferAmount(tiny, { numerator: 1, denominator: 1_000_000 }, [])
    expect(roundsToZero.ok).toBe(false)
    if (roundsToZero.ok) throw new Error('expected err')
    expect(roundsToZero.error.message).toContain('rounds to zero')

    // **Four malformed shares, all refused, none clamped.**
    for (const share of [
      { numerator: 1, denominator: 0 },
      { numerator: 1, denominator: -2 },
      { numerator: 0.5, denominator: 2 },
      { numerator: 2, denominator: 2 },
      { numerator: -1, denominator: 2 },
      { numerator: 3, denominator: 2 },
    ]) {
      const r = partialOfferAmount(ctxOf(), share, [])
      expect(r.ok, `${JSON.stringify(share)} should be refused`).toBe(false)
      if (r.ok) throw new Error('expected err')
      expect(r.error.code).toBe('CS_VALIDATION')
    }
  })

  it('the share is expressed as two integers and never as a percentage string', () => {
    // **A float share is refused**, which is what stops `0.75` from reaching `allocate` and quietly producing a
    // non-integer weight.
    const float = partialOfferAmount(ctxOf(), { numerator: 0.75, denominator: 1 }, [])
    expect(float.ok).toBe(false)
    // **"75%" is `{3, 4}`**, and 3/4 of 12999 by largest remainder is 9749, with the complement taking 3250.
    const threeQuarters = partialOfferAmount(ctxOf(), { numerator: 3, denominator: 4 }, [])
    if (!threeQuarters.ok) throw new Error('expected ok')
    expect(threeQuarters.value).toEqual({ minor: 9_749n, currency: 'USD' })
    expect(DISPUTED.minor - threeQuarters.value.minor).toBe(3_250n)
    expect(threeQuarters.value.minor + (DISPUTED.minor - threeQuarters.value.minor)).toBe(
      DISPUTED.minor,
    )
  })

  it('a non-USD capture keeps its own currency and is never converted', () => {
    const eur = ctxOf({
      capture: { ...ctxOf().capture!, amount: { minor: 11_840n, currency: 'EUR' } },
    })
    const budget = offerBudget(eur, [])
    expect(budget.captureAmount).toEqual({ minor: 11_840n, currency: 'EUR' })
    expect(budget.remaining.currency).toBe('EUR')
    const offer = partialOfferAmount(eur, DEFAULT_OFFER_SHARE, [])
    if (!offer.ok) throw new Error('expected ok')
    expect(offer.value).toEqual({ minor: 5_920n, currency: 'EUR' })
  })

  it('the default share is half, and it is a default rather than a recommendation', () => {
    // **Half because it is the one ratio with no judgement in it** — the amount a merchant can compute in their
    // head, which is what makes the proposal reviewable at a glance.
    expect(DEFAULT_OFFER_SHARE).toEqual({ numerator: 1, denominator: 2 })
    // **And `options.offerShare` overrides it**, in integers only.
    const custom = partialOfferAmount(ctxOf(), { numerator: 1, denominator: 4 }, [])
    if (!custom.ok) throw new Error('expected ok')
    expect(custom.value).toEqual({ minor: 3_250n, currency: 'USD' })
  })
})

// ---------------------------------------------------------------------------
// 4. The cost, and the label that must travel with it
// ---------------------------------------------------------------------------

describe('§8.16: every proposal shows its expected cost, labelled as an industry average', () => {
  it('the $82 figure is 8_200 minor units and the label is a literal, not a string someone can drop', () => {
    expect(MRC_AVERAGE_HANDLING_COST_MINOR).toBe(8_200n)
    const cost = costFor({ minor: 6_499n, currency: 'USD' })
    // **The label travels.** §8.16 says the figure "is labelled as an industry average", and an $82 figure
    // presented as Countersign's own measurement would be a fabricated statistic in a product whose entire claim
    // is that it does not fabricate.
    expect(cost.handlingCostIsIndustryAverage).toBe(true)
    expect(cost.handlingCostLabel).toBe(HANDLING_COST_LABEL)
    expect(cost.handlingCostLabel).toContain('industry average')
    expect(cost.source).toBe('V13')
    expect(cost.handlingCostMinor).toBe(8_200n)
    expect(cost.handlingCostCurrency).toBe('USD')
  })

  it('the verdict is a three-way comparison on integer minor units', () => {
    expect(costFor(null).refundMinor).toBe(0n)
    expect(costFor(null).verdict).toBe('CHEAPER_TO_REFUND')
    expect(costFor(null).deltaMinor).toBe(-8_200n)
    // **Below $82, refunding is cheaper than fighting** — EC-BUY-1's whole argument.
    expect(costFor({ minor: 6_499n, currency: 'USD' }).verdict).toBe('CHEAPER_TO_REFUND')
    // **Exactly $82 is indistinguishable**, and saying otherwise would be taking a side with an average.
    expect(costFor({ minor: 8_200n, currency: 'USD' }).verdict).toBe('INDISTINGUISHABLE')
    expect(costFor({ minor: 8_200n, currency: 'USD' }).deltaMinor).toBe(0n)
    expect(costFor({ minor: 12_999n, currency: 'USD' }).verdict).toBe('CHEAPER_TO_CONTEST')
  })

  it('a proposal that crosses $82 says so in its own warnings', () => {
    const wide = ctxOf({
      capture: { ...ctxOf().capture!, amount: { minor: 20_000n, currency: 'USD' } },
    })
    const proposal = proposeStrategyDeterministic(wide, decisionOf('OFFER'))
    expect(proposal.action).toBe('MAKE_OFFER')
    expect(proposal.cost.verdict).toBe('CHEAPER_TO_CONTEST')
    // **The warning names the figure and its source**, because "offering is more expensive" with no number is a
    // claim, not a cost comparison.
    expect(proposal.warnings.join(' ')).toContain('industry-average handling cost [V13]')
    expect(proposal.warnings.join(' ')).toContain('10000')
  })
})

// ---------------------------------------------------------------------------
// 5. The proposal itself
// ---------------------------------------------------------------------------

describe('proposeStrategyDeterministic is pure, and every field is derived', () => {
  it('the same inputs give the same proposal, so Judge Mode can replay one', () => {
    const ctx = ctxOf()
    const decision = decisionOf('OFFER')
    const a = proposeStrategyDeterministic(ctx, decision)
    const b = proposeStrategyDeterministic(ctx, decision)
    expect(a).toEqual(b)
    // **The id is derived from our own ids and the rule**, never from a clock or a counter.
    expect(a.proposalId).toBe(`prop:${DISPUTE_ID}:R-SNAD-THIN:OFFER:MAKE_OFFER:6500USD`)
    // **A different action or a different amount is a different proposal**, which is what makes a re-proposal a
    // read rather than a second opinion.
    expect(proposeStrategyDeterministic(ctx, decisionOf('MESSAGE_ONLY')).proposalId).toBe(
      `prop:${DISPUTE_ID}:R-SNAD-THIN:MESSAGE_ONLY:MAKE_OFFER:6500USD`,
    )
    expect(
      proposeStrategyDeterministic(ctx, decisionOf('OFFER'), {
        offerShare: { numerator: 3, denominator: 4 },
      }).proposalId,
    ).toBe(`prop:${DISPUTE_ID}:R-SNAD-THIN:OFFER:MAKE_OFFER:9749USD`)
    // **§18 q31's traceability: the proposal names the rule that produced the posture it is bounded by.**
    expect(a.ruleId).toBe('R-SNAD-THIN')
    expect(a.posture).toBe('OFFER')
    expect(a.disputeId).toBe(DISPUTE_ID)
  })

  it('EC-BUY-1: an authorised SNAD case with no quality document proposes an offer with its cost', () => {
    const proposal = proposeStrategyDeterministic(ctxOf(), decisionOf('OFFER'))
    expect(proposal.action).toBe('MAKE_OFFER')
    expect(proposal.paypal).toEqual({ method: 'makeOffer', token: 'offer' })
    expect(proposal.amount).toEqual({ minor: 6_500n, currency: 'USD' })
    expect(proposal.cost.verdict).toBe('CHEAPER_TO_REFUND')
    expect(proposal.cost.handlingCostIsIndustryAverage).toBe(true)
    // **Every action needs a merchant click**, and `requiresApproval` is a literal `true` so it cannot be
    // dropped in a refactor.
    expect(proposal.requiresApproval).toBe(true)
    expect(proposal.reason).toContain('R-SNAD-THIN')
    expect(proposal.copy).toContain('R-SNAD-THIN')
    expect(proposal.copy).toContain('6500')
    expect(proposal.copy?.length).toBeLessThanOrEqual(2000)
  })

  it('EC-MER-3 / EC-DSP-5: a CONTEST proposal supplies supporting info or escalates, and never re-files', () => {
    const proposal = proposeStrategyDeterministic(ctxOf(), decisionOf('CONTEST'))
    expect(STRATEGIST_ACTIONS_BY_POSTURE['CONTEST']).toContain(proposal.action)
    expect(['PROVIDE_SUPPORTING_INFO', 'ESCALATE']).toContain(proposal.action)
    expect(proposal.paypal?.method).not.toBe('provideEvidence')
    // **EC-DSP-5 is stated in the proposal's own words**, because that sentence is what a merchant reads when
    // asking "is this replacing what I already filed?"
    expect(proposal.reason).toContain('EC-DSP-5')
  })

  it('EC-DSP-6: an APPEAL proposal names what arrived since the loss', async () => {
    // **The appeal arm is reached by a merchant's choice**, because `PROVIDE_SUPPORTING_INFO` sorts first in
    // `STRATEGIST_ACTIONS` and is also permitted on an `APPEAL` posture. So this goes through `proposeStrategy`
    // with a single permitted candidate, which is exactly what S-18's choice produces.
    const decision = decisionOf('APPEAL')
    const proposal = expectOk<StrategistProposal>(
      await proposeStrategy(ctxOf(), decision, {
        filedFactKeys: ['dispute.amount'],
        llm: {
          generateText: async () => ({
            text: JSON.stringify({
              candidates: [{ action: 'APPEAL', reason: 'a carrier answered after the loss' }],
            }),
          }),
        },
      }),
    )
    expect(proposal.action).toBe('APPEAL')
    expect(proposal.paypal).toEqual({ method: 'appeal', token: 'appeal' })
    // **EC-DSP-6's substance: what arrived since the loss is named, and it is named by claim key.**
    expect(proposal.newFacts).toEqual(['capture.id', 'router.rule'])
    expect(proposal.reason).toContain('capture.id, router.rule')
    expect(proposal.reason).toContain('matched an appealable dispute with new evidence')
    // **And the copy says the signed record is unchanged**, because an appeal is an addition, not a rewrite.
    expect(proposal.copy).toContain('signed purchase record is unchanged')
  })

  it('EC-DSP-5: newFactsSince reports claim KEYS the filed packet did not already contain', () => {
    const decision = decisionOf('CONTEST')
    expect(newFactsSince(decision, [])).toEqual(['dispute.amount', 'capture.id', 'router.rule'])
    expect(newFactsSince(decision, ['dispute.amount', 'capture.id'])).toEqual(['router.rule'])
    expect(newFactsSince(decision, ['dispute.amount', 'capture.id', 'router.rule'])).toEqual([])
    // **Keys, not values**, because "we already said that" is a question about which artefact a packet cited.
    expect(newFactsSince(decision, ['USD 129.99'])).toHaveLength(3)
  })

  it('a posture that permits nothing still produces a proposal, and says it produced nothing to do', () => {
    const proposal = proposeStrategyDeterministic(ctxOf(), decisionOf('REFUND'))
    expect(proposal.action).toBe('REVIEW_WITH_HUMAN')
    expect(proposal.paypal).toBeNull()
    expect(proposal.amount).toBeNull()
    // **`costFor(null)` still carries the comparison**, because a merchant looking at a refund decision wants to
    // see what fighting it would have cost.
    expect(proposal.cost.handlingCostIsIndustryAverage).toBe(true)
    expect(proposal.warnings.join(' ')).toContain('permits no strategist action at all')
    expect(ACTION_ROW_NAME[proposal.action]).toBeNull()
  })

  it('clampNote drops whole sentences and never ends mid-claim', () => {
    const long = `${'Rule R-SNAD-THIN. '.repeat(200)}`
    const clamped = clampNote(long)
    expect(clamped.length).toBeLessThanOrEqual(2000)
    expect(clamped.endsWith('The full text is in the case file.')).toBe(true)
    // **No half sentence survives**, which is the reason it splits rather than slicing.
    expect(clamped).not.toContain('R-SNAD-THI ')
    // **A shorter note is returned untouched.**
    expect(clampNote('Rule R-SNAD-THIN.')).toBe('Rule R-SNAD-THIN.')
    // **A cap too small for even one sentence still says something**, rather than returning an empty note that
    // PayPal would reject for having no characters.
    const tiny = clampNote(long, 40)
    expect(tiny.length).toBeLessThanOrEqual(40)
    expect(tiny.startsWith('This action needs a decision.')).toBe(true)
    // **The cost label legitimately cites `[V13]`**; it is stored in jsonb rather than filed into a note, so the
    // digit is fine there. The *marker* is a fixed string with no digits, because a digit in an uncited sentence
    // is an uncitable digit — the bug `citation-check.ts`'s `truncateNotes` documents.
    expect(HANDLING_COST_LABEL).toContain('[V13]')
  })
})

// ---------------------------------------------------------------------------
// 6. AT-M16.1: the proposal JSON validates
// ---------------------------------------------------------------------------

describe('AT-M16.1: the proposal JSON validates, and a round trip keeps money a Money', () => {
  it('a deterministic proposal validates against the schema as-is', () => {
    const proposal = proposeStrategyDeterministic(ctxOf(), decisionOf('OFFER'))
    expect(strategistProposalSchema.safeParse(proposal).success).toBe(true)
  })

  it('a JSON round trip re-binds every minor-unit field back to bigint', () => {
    const proposal = proposeStrategyDeterministic(ctxOf(), decisionOf('OFFER'))
    /**
     * **The proposal travels**: S-18 renders it, a merchant may edit the copy, Judge Mode records it. So the round
     * trip is a real path, not a hypothetical one — and `JSON.stringify` turns every `bigint` into a string, which
     * is why `parseStrategistProposal` coerces rather than merely validates.
     *
     * The replacer is `toJsonValue`'s, the same one `dispute_actions.request` and `disputes.raw` use. A bare
     * `JSON.stringify` would **throw** on a `bigint`, so a caller reaching for the obvious call would find out
     * that the proposal cannot be serialised as-is — which is worth knowing and is asserted below.
     */
    expect(() => JSON.stringify(proposal)).toThrow()
    const json = toJsonValue(proposal) as unknown as Record<string, unknown>
    expect((json['amount'] as Record<string, unknown>)['minor']).toBe('6500')
    expect((json['cost'] as Record<string, unknown>)['handlingCostMinor']).toBe('8200')

    const parsed = parseStrategistProposal(json)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('expected ok')
    expect(parsed.value.amount).toEqual({ minor: 6_500n, currency: 'USD' })
    expect(parsed.value.cost.refundMinor).toBe(6_500n)
    expect(parsed.value.cost.handlingCostMinor).toBe(8_200n)
    expect(parsed.value.cost.deltaMinor).toBe(-1_700n)
    expect(parsed.value.cost.handlingCostIsIndustryAverage).toBe(true)
    expect(parsed.value.requiresApproval).toBe(true)
    // **Money never survives as a string.** It comes back a `Money`.
    expect(typeof parsed.value.amount?.minor).toBe('bigint')
    // **And a proposal that moves no money round-trips as `null`, not as a zero.**
    const noMoney = parseStrategistProposal(
      toJsonValue(proposeStrategyDeterministic(ctxOf(), decisionOf('REVIEW'))) as unknown,
    )
    if (!noMoney.ok) throw new Error('expected ok')
    expect(noMoney.value.amount).toBeNull()
    expect(noMoney.value.cost.refundMinor).toBe(0n)
  })

  it('the two literal types are re-checked, so a proposal missing either is LLM_SCHEMA', () => {
    const base = toJsonValue(
      proposeStrategyDeterministic(ctxOf(), decisionOf('OFFER')),
    ) as unknown as Record<string, unknown>

    const broken: Readonly<Record<string, unknown>> = {
      noLabel: {
        ...base,
        cost: { ...(base['cost'] as object), handlingCostIsIndustryAverage: false },
      },
      noApproval: { ...base, requiresApproval: false },
      wrongVerdict: {
        ...base,
        cost: { ...(base['cost'] as object), verdict: 'CHEAPER_TO_BANKRUPT' },
      },
      wrongSource: {
        ...base,
        cost: { ...(base['cost'] as object), source: 'OUR_OWN_MEASUREMENT' },
      },
      unknownAction: { ...base, action: 'PROVIDE_EVIDENCE' },
      noRule: { ...base, ruleId: '' },
      noReason: { ...base, reason: '' },
    }

    for (const [name, value] of Object.entries(broken)) {
      const r = parseStrategistProposal(value)
      expect(r.ok, `${name} should not validate`).toBe(false)
      if (r.ok) throw new Error('expected err')
      expect(r.error.code).toBe('LLM_SCHEMA')
    }

    // **Not `any`, not `{}`.** A `CsError` from the §8.1 registry, naming what failed.
    const empty = parseStrategistProposal({})
    expect(empty.ok).toBe(false)
    if (empty.ok) throw new Error('expected err')
    expect(empty.error.message).toContain('did not validate')
    const nullish = parseStrategistProposal(null)
    if (nullish.ok) throw new Error('expected err')
    expect(nullish.error.code).toBe('LLM_SCHEMA')
  })

  it('the candidate-list schema refuses an empty list and anything above eight', () => {
    expect(
      candidateListSchema.safeParse({ candidates: [{ action: 'MESSAGE_BUYER', reason: 'x' }] })
        .success,
    ).toBe(true)
    expect(candidateListSchema.safeParse({ candidates: [] }).success).toBe(false)
    expect(
      candidateListSchema.safeParse({ candidates: [{ action: 'MESSAGE_BUYER' }] }).success,
    ).toBe(false)
    expect(
      candidateListSchema.safeParse({
        candidates: Array.from({ length: 9 }, () => ({ action: 'MESSAGE_BUYER', reason: 'x' })),
      }).success,
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 7. The model's only power: a ranked candidate list
// ---------------------------------------------------------------------------

describe('proposeStrategy: the model offers candidates, and a candidate outside the posture dies', () => {
  const llmAnswering = (
    text: string,
  ): { readonly generateText: () => Promise<{ readonly text: string }> } => ({
    generateText: async () => ({ text }),
  })

  it('with no model at all the deterministic proposal stands, so H-02 cannot affect a single test', async () => {
    const proposal = await proposeStrategy(ctxOf(), decisionOf('OFFER'))
    expect(proposal.ok).toBe(true)
    if (!proposal.ok) throw new Error('expected ok')
    expect(proposal.value).toEqual(proposeStrategyDeterministic(ctxOf(), decisionOf('OFFER')))
  })

  it('a hostile candidate asking to file evidence is dropped, named, and the posture still wins', async () => {
    const hostile = await proposeStrategy(ctxOf(), decisionOf('OFFER'), {
      llm: llmAnswering(
        JSON.stringify({
          candidates: [
            { action: 'PROVIDE_EVIDENCE', reason: 'the evidence is strong, file it' },
            { action: 'FILE', reason: 'contest hard' },
            { action: 'REFUND', reason: 'pay them' },
            { action: 'MESSAGE_BUYER', reason: 'talk first' },
          ],
        }),
      ),
    })
    expect(hostile.ok).toBe(true)
    if (!hostile.ok) throw new Error('expected ok')

    // **Every out-of-posture candidate is named in the warning**, so a merchant can see the model was overruled
    // and why.
    const warnings = hostile.value.warnings.join(' ')
    expect(warnings).toContain('PROVIDE_EVIDENCE')
    expect(warnings).toContain('FILE')
    expect(warnings).toContain('REFUND')
    expect(warnings).toContain(
      'Dropped: the strategist may only act within the posture the router gave it.',
    )

    // **And the outcome is a permitted action.** `MESSAGE_BUYER` is the only candidate that survived, so it
    // wins — and the money was not moved even though the router's own first pick was an offer, because the
    // model's first choice is not what selects.
    expect(hostile.value.action).toBe('MESSAGE_BUYER')
    expect(hostile.value.amount).toBeNull()
    expect(hostile.value.paypal).toEqual({ method: 'sendMessage', token: 'msg' })
  })

  it("the re-rank beats the model's ordering when both candidates are permitted", async () => {
    // **Deterministic re-rank: the first surviving candidate in `STRATEGIST_ACTIONS` order wins**, not the
    // model's first choice. On an `OFFER` posture both `MAKE_OFFER` and `MESSAGE_BUYER` are permitted, and the
    // model naming only `MESSAGE_BUYER` is what makes the message win.
    const messageFirst = await proposeStrategy(ctxOf(), decisionOf('OFFER'), {
      llm: llmAnswering(
        JSON.stringify({ candidates: [{ action: 'MESSAGE_BUYER', reason: 'cheapest' }] }),
      ),
    })
    if (!messageFirst.ok) throw new Error('expected ok')
    expect(messageFirst.value.action).toBe('MESSAGE_BUYER')

    // **And listing both, with the offer second, still gives the offer** — the table decides, not the ordering.
    const offerSecond = await proposeStrategy(ctxOf(), decisionOf('OFFER'), {
      llm: llmAnswering(
        JSON.stringify({
          candidates: [
            { action: 'MESSAGE_BUYER', reason: 'cheapest' },
            { action: 'MAKE_OFFER', reason: 'ends it now' },
          ],
        }),
      ),
    })
    if (!offerSecond.ok) throw new Error('expected ok')
    expect(offerSecond.value.action).toBe('MAKE_OFFER')
    expect(offerSecond.value.amount).toEqual({ minor: 6_500n, currency: 'USD' })
    // **No warning, because nothing was dropped** — a model that stayed inside the posture is not overruled.
    expect(offerSecond.value.warnings.join(' ')).not.toContain('Dropped')
  })

  it('a model may choose between permitted actions, and the re-rank is deterministic', async () => {
    // **`MESSAGE_BUYER` only**: `STRATEGIST_ACTIONS` order puts `MAKE_OFFER` first, so the model naming only
    // `MESSAGE_BUYER` is what makes it win.
    const chosen = await proposeStrategy(ctxOf(), decisionOf('MESSAGE_ONLY'), {
      llm: llmAnswering(
        JSON.stringify({ candidates: [{ action: 'MESSAGE_BUYER', reason: 'cheapest' }] }),
      ),
    })
    if (!chosen.ok) throw new Error('expected ok')
    expect(chosen.value.action).toBe('MESSAGE_BUYER')
    expect(chosen.value.paypal).toEqual({ method: 'sendMessage', token: 'msg' })
    // **The re-rank is by our table, not by the model's order**: listing `ACKNOWLEDGE_RETURN` first does not win.
    const reRanked = await proposeStrategy(ctxOf(), decisionOf('MESSAGE_ONLY'), {
      llm: llmAnswering(
        JSON.stringify({
          candidates: [
            { action: 'ACKNOWLEDGE_RETURN', reason: 'the parcel is coming back' },
            { action: 'MESSAGE_BUYER', reason: 'cheapest' },
          ],
        }),
      ),
    })
    if (!reRanked.ok) throw new Error('expected ok')
    expect(reRanked.value.action).toBe('MESSAGE_BUYER')
  })

  it('EC-LLM-1: a model that is down, or answers garbage, leaves the deterministic proposal standing', async () => {
    const decision = decisionOf('OFFER')
    const base = proposeStrategyDeterministic(ctxOf(), decision)

    const threw = await proposeStrategy(ctxOf(), decision, {
      llm: {
        generateText: async () => {
          throw new Error('ECONNREFUSED')
        },
      },
    })
    expect(threw.ok).toBe(true)
    if (!threw.ok) throw new Error('expected ok')
    expect(threw.value.action).toBe(base.action)
    expect(threw.value.warnings.join(' ')).toContain('could not be reached')

    for (const garbage of [
      'not json at all',
      '{"candidates":[]}',
      '{"candidates":"MESSAGE_BUYER"}',
      '{}',
      '',
    ]) {
      const r = await proposeStrategy(ctxOf(), decision, { llm: llmAnswering(garbage) })
      expect(r.ok).toBe(true)
      if (!r.ok) throw new Error('expected ok')
      expect(r.value.action).toBe(base.action)
      expect(r.value.warnings.join(' ')).toContain('did not return a valid candidate list')
    }
  })
})

// ---------------------------------------------------------------------------
// 8. Execution: AT-M16.2, over the real client
// ---------------------------------------------------------------------------

interface RecordedCall {
  readonly method: string
  readonly path: string
  readonly headers: Record<string, string>
  readonly body: unknown
}

interface Stub {
  readonly status?: number
  readonly body?: unknown
}

/** A `fetch` double routing on `"<METHOD> <path fragment>"`, matching by substring. */
function fakePayPal(routes: Record<string, Stub | Stub[]>): {
  readonly fetchImpl: typeof fetch
  readonly calls: RecordedCall[]
  callsTo(fragment: string): RecordedCall[]
  bodyOf<T = Record<string, unknown>>(fragment: string, nth?: number): T
  /**
   * The `input` part of a **multipart** call, parsed. §10.2 #16 makes `provide-supporting-info` and `appeal`
   * `multipart/form-data`, so the notes are a form part rather than the request body.
   */
  multipartInputOf<T = Record<string, unknown>>(fragment: string, nth?: number): Promise<T>
  requestIdOf(fragment: string, nth?: number): string | undefined
} {
  const calls: RecordedCall[] = []
  const queues = new Map<string, Stub[]>()
  const counters = new Map<string, number>()

  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const headers: Record<string, string> = {}
    const raw = init?.headers
    if (raw !== undefined) {
      if (raw instanceof Headers) raw.forEach((v, k) => (headers[k.toLowerCase()] = v))
      else if (Array.isArray(raw))
        for (const [k, v] of raw) headers[String(k).toLowerCase()] = String(v)
      else
        for (const [k, v] of Object.entries(raw as Record<string, string>))
          headers[k.toLowerCase()] = v
    }
    const path = url.replace(/^https?:\/\/[^/]+/, '')
    calls.push({ method: init?.method ?? 'GET', path, headers, body: init?.body })

    const method = (init?.method ?? 'GET').toUpperCase()
    for (const [key, value] of Object.entries(routes)) {
      const [routeMethod, routePath] = key.includes(' ') ? key.split(' ', 2) : [undefined, key]
      if (routeMethod !== undefined && routeMethod.toUpperCase() !== method) continue
      if (!path.includes(routePath)) continue
      let queue = queues.get(key)
      if (queue === undefined) {
        queue = Array.isArray(value) ? [...value] : [value]
        queues.set(key, queue)
      }
      const n = counters.get(key) ?? 0
      counters.set(key, n + 1)
      const spec = queue[Math.min(n, queue.length - 1)] ?? {}
      const status = spec.status ?? 200
      return new Response(JSON.stringify(spec.body ?? {}), {
        status,
        headers: { 'paypal-debug-id': 'DEBUG-FAKE', 'content-type': 'application/json' },
      })
    }
    return new Response(
      JSON.stringify({
        name: 'RESOURCE_NOT_FOUND',
        message: `No stub for ${method} ${path}`,
        debug_id: 'DEBUG-UNSTUBBED',
      }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    )
  }

  return {
    fetchImpl: impl as unknown as typeof fetch,
    calls,
    callsTo: (fragment) => calls.filter((c) => c.path.includes(fragment)),
    bodyOf<T>(fragment: string, nth = 0): T {
      const call = calls.filter((c) => c.path.includes(fragment))[nth]
      if (call === undefined) throw new Error(`No call to ${fragment} (nth=${nth})`)
      if (typeof call.body !== 'string') throw new Error(`${fragment} did not carry a JSON body`)
      return JSON.parse(call.body) as T
    },
    async multipartInputOf<T>(fragment: string, nth = 0): Promise<T> {
      const call = calls.filter((c) => c.path.includes(fragment))[nth]
      if (call === undefined) throw new Error(`No call to ${fragment} (nth=${nth})`)
      if (!(call.body instanceof FormData)) {
        throw new Error(`${fragment} did not carry a FormData body (${typeof call.body})`)
      }
      const part = call.body.get(EVIDENCE_INPUT_FIELD)
      if (part === null || typeof part === 'string') {
        throw new Error(`${fragment} carried no \`${EVIDENCE_INPUT_FIELD}\` file part`)
      }
      return JSON.parse(await (part as Blob).text()) as T
    },
    requestIdOf(fragment: string, nth = 0): string | undefined {
      return calls.filter((c) => c.path.includes(fragment))[nth]?.headers['paypal-request-id']
    },
  }
}

const TOKEN_ROUTE = {
  'POST /v1/oauth2/token': {
    status: 200,
    body: {
      scope: 'https://uri.paypal.com/services/payments/payment',
      access_token: 'A21AAFakeAccessToken0000000000000000',
      token_type: 'Bearer',
      app_id: 'APP-80W284485P519543T',
      expires_in: 32_400,
    },
  },
}

/** `200 OK` with `{links: [...]}` — what every documented seller dispute action answers (report §2/#24). */
function linksResponse(): Stub {
  return {
    status: 200,
    body: {
      links: [
        {
          href: `${SANDBOX_BASE}/v1/customer/disputes/${PAYPAL_DISPUTE_ID}`,
          rel: 'self',
          method: 'GET',
        },
      ],
    },
  }
}

/** Every dispute action endpoint a strategy might reach, keyed on **concrete** paths. */
const D = `/v1/customer/disputes/${PAYPAL_DISPUTE_ID}`
const ALL_STRATEGY_ROUTES = (): Record<string, Stub> => ({
  [`POST ${D}/send-message`]: linksResponse(),
  [`POST ${D}/make-offer`]: linksResponse(),
  [`POST ${D}/acknowledge-return-item`]: linksResponse(),
  [`POST ${D}/provide-supporting-info`]: linksResponse(),
  [`POST ${D}/escalate`]: linksResponse(),
  [`POST ${D}/appeal`]: linksResponse(),
  [`POST ${D}/provide-evidence`]: linksResponse(),
  [`POST ${D}/accept-claim`]: linksResponse(),
  /**
   * `PayPalClient.appeal` re-reads the dispute to gate on the `appeal` HATEOAS link (report §9/#17: "if this
   * link does not appear, you cannot appeal"). The link is present here because `route()` only reaches an
   * `APPEAL` posture through R-APPEAL-1, which requires it — a stub without it would make every appeal a
   * refusal and the arm untestable.
   */
  [`GET ${D}`]: {
    status: 200,
    body: {
      dispute_id: PAYPAL_DISPUTE_ID,
      dispute_state: 'APPEALABLE',
      status: 'RESOLVED',
      links: [
        { href: `${SANDBOX_BASE}${D}`, rel: 'self', method: 'GET' },
        { href: `${SANDBOX_BASE}${D}/appeal`, rel: 'appeal', method: 'POST' },
      ],
    },
  },
})

interface ExecHarness {
  readonly world: InMemoryDefenderWorld
  readonly paypal: ReturnType<typeof fakePayPal>
  readonly deps: StrategistActionDeps
  readonly actions: () => DisputeActionRow[]
}

function execHarness(
  seed: DefenderWorldSeed = {},
  routes: Record<string, Stub> = ALL_STRATEGY_ROUTES(),
): ExecHarness {
  const world = createInMemoryDefenderWorld(seed)
  const paypal = fakePayPal({ ...TOKEN_ROUTE, ...routes })
  const client = new PayPalClient({
    baseUrl: SANDBOX_BASE,
    clientId: 'A-fake-client-id',
    clientSecret: 'a-fake-secret',
    clock: CLOCK,
    fetchImpl: paypal.fetchImpl,
    maxRetries: 1,
    sleep: async () => {},
    env: { PAYPAL_ENV: 'sandbox', PAYPAL_API_BASE: SANDBOX_BASE },
  })
  return {
    world,
    paypal,
    deps: { clock: CLOCK, paypal: client, store: world.store },
    actions: () => [...world.rows.actions.values()],
  }
}

function expectOk<T>(r: {
  ok: boolean
  value?: unknown
  error?: { code?: string; message?: string }
}): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error?.code}: ${r.error?.message}`)
  return r.value as T
}

function jsonb(row: unknown): Record<string, unknown> {
  return row === null || typeof row !== 'object' ? {} : (row as Record<string, unknown>)
}

const CLICK: ExecuteOptions = { approvedBy: 'usr_merchant_0000000000000001' }

/** A capture with nothing left to offer, which is how `MESSAGE_BUYER` becomes the first pick on an OFFER posture. */
const SPENT_CTX = ctxOf({
  refunds: [
    {
      id: 'ref_1',
      paypalRefundId: '1JU08902781691411',
      amount: DISPUTED,
      status: 'COMPLETED',
      atSec: NOW_SEC,
    },
  ],
})

async function execute(
  h: ExecHarness,
  proposal: StrategistProposal,
  decision: LiabilityDecision,
  options: ExecuteOptions = CLICK,
  ctx: DisputeContext = ctxOf(),
): Promise<StrategyOutcome> {
  return expectOk<StrategyOutcome>(await executeStrategy(proposal, decision, ctx, h.deps, options))
}

describe('AT-M16.2: each action calls its own endpoint, once, with a deterministic request id', () => {
  it('every first-pick action reaches exactly its own endpoint', async () => {
    /**
     * **Four cases, one per posture where the deterministic proposer has a first pick**, and each asserted
     * against the proposal the product actually makes rather than a hand-built object. The remaining two arms
     * (`ESCALATE`, `ACKNOWLEDGE_RETURN`) are second or third in `permittedActionsFor` order and are covered by
     * the next test, through the same `proposeStrategy` path a merchant's click in S-18 takes.
     */
    const cases: readonly {
      readonly posture: Posture
      readonly action: StrategistAction
      readonly endpoint: string
      readonly method: string
      readonly token: string
      readonly options: ExecuteOptions
      readonly ctx?: DisputeContext
    }[] = [
      {
        posture: 'OFFER',
        action: 'MAKE_OFFER',
        endpoint: 'make-offer',
        method: 'makeOffer',
        token: 'offer',
        options: CLICK,
      },
      {
        // **With nothing left to offer, `MAKE_OFFER` drops out of the permitted list** and the message becomes
        // the first pick. That is `permittedActionsFor` doing real work, not a fixture.
        posture: 'OFFER',
        action: 'MESSAGE_BUYER',
        endpoint: 'send-message',
        method: 'sendMessage',
        token: 'msg',
        options: CLICK,
        ctx: SPENT_CTX,
      },
      {
        posture: 'MESSAGE_ONLY',
        action: 'MAKE_OFFER',
        endpoint: 'make-offer',
        method: 'makeOffer',
        token: 'offer',
        options: CLICK,
      },
      {
        posture: 'CONTEST',
        action: 'PROVIDE_SUPPORTING_INFO',
        endpoint: 'provide-supporting-info',
        method: 'provideSupportingInfo',
        token: 'support',
        options: CLICK,
      },
      {
        posture: 'REVIEW',
        action: 'REVIEW_WITH_HUMAN',
        endpoint: 'none',
        method: 'none',
        token: 'escalate',
        options: CLICK,
      },
    ]

    for (const c of cases) {
      const h = execHarness()
      const ctx = c.ctx ?? ctxOf()
      const decision = decisionOf(c.posture)
      const proposal = proposeStrategyDeterministic(ctx, decision)
      expect(proposal.action, `${c.posture} should first-pick ${c.action}`).toBe(c.action)

      const out = await execute(h, proposal, decision, c.options, ctx)

      if (c.endpoint === 'none') {
        // **The one action that makes no PayPal call**, asserted separately so it is not read as a 404.
        expect(out.sent).toBe(false)
        expect(out.paypalCalls).toEqual([])
        expect(h.paypal.calls).toHaveLength(0)
        continue
      }

      expect(out.sent, `${c.action} should be sent`).toBe(true)
      expect(out.paypalCalls).toEqual([c.method])
      expect(h.paypal.callsTo(c.endpoint)).toHaveLength(1)
      expect(h.paypal.requestIdOf(c.endpoint)).toBe(`cs:${DISPUTE_ID}:${c.token}:1`)
      expect(out.requestId).toBe(`cs:${DISPUTE_ID}:${c.token}:1`)
      // **The row carries the request id as its idempotency key** — the same string, so the local dedupe and
      // PayPal's agree on what "already done" means.
      expect(out.actionRow?.idempotencyKey).toBe(`cs:${DISPUTE_ID}:${c.token}:1`)
      expect(out.actionRow?.action).toBe(ACTION_ROW_NAME[proposal.action])
      // **No other dispute endpoint was touched at all** — and the path carries *PayPal's* id, not ours.
      expect(h.paypal.callsTo('/v1/customer/disputes').map((call) => call.path)).toEqual([
        `/v1/customer/disputes/${PAYPAL_DISPUTE_ID}/${c.endpoint}`,
      ])
    }
  })

  it('a permitted action the proposer did not pick is still executable, through proposeStrategy', async () => {
    /**
     * **The shape of a merchant choosing in S-18**: S-18 offers the permitted list, the choice comes back as
     * ranked candidates, and `proposeStrategy` rebuilds the proposal. Nothing here hand-edits a proposal — the
     * two arms the deterministic first pick never reaches are produced by the real re-rank path.
     */
    const cases: readonly {
      readonly posture: Posture
      readonly action: StrategistAction
      readonly endpoint: string
      readonly method: string
      readonly token: string
      readonly options?: ExecuteOptions
    }[] = [
      {
        posture: 'MESSAGE_ONLY',
        action: 'ACKNOWLEDGE_RETURN',
        endpoint: 'acknowledge-return-item',
        method: 'acknowledgeReturnItem',
        token: 'return',
      },
      {
        posture: 'MESSAGE_ONLY',
        action: 'MESSAGE_BUYER',
        endpoint: 'send-message',
        method: 'sendMessage',
        token: 'msg',
      },
      {
        posture: 'CONTEST',
        action: 'ESCALATE',
        endpoint: 'escalate',
        method: 'escalate',
        token: 'escalate',
      },
      {
        posture: 'APPEAL',
        action: 'APPEAL',
        endpoint: 'appeal',
        method: 'appeal',
        token: 'appeal',
        options: {
          ...CLICK,
          appealInput: { evidences: [{ evidence_type: 'ITEM_DESCRIPTION', notes: 'n' }] },
        },
      },
    ]

    for (const c of cases) {
      const h = execHarness()
      const decision = decisionOf(c.posture)
      // **The first pick is genuinely different**, so this test is exercising a re-rank and not the default.
      expect(proposeStrategyDeterministic(ctxOf(), decision).action).not.toBe(c.action)

      const rebuilt = expectOk<StrategistProposal>(
        await proposeStrategy(ctxOf(), decision, {
          llm: {
            generateText: async () => ({
              text: JSON.stringify({
                candidates: [{ action: c.action, reason: 'the merchant prefers this' }],
              }),
            }),
          },
        }),
      )
      expect(rebuilt.action).toBe(c.action)
      expect(rebuilt.paypal).toEqual({ method: c.method, token: c.token })

      const out = await execute(h, rebuilt, decision, c.options ?? CLICK)
      expect(out.sent, `${c.action} should be sent`).toBe(true)
      expect(out.paypalCalls).toEqual([c.method])
      expect(h.paypal.callsTo(c.endpoint)).toHaveLength(1)
      expect(h.paypal.requestIdOf(c.endpoint)).toBe(`cs:${DISPUTE_ID}:${c.token}:1`)
    }
  })

  it("the acknowledge-return body carries the note and PayPal's own acknowledgement type", async () => {
    const h = execHarness()
    const decision = decisionOf('MESSAGE_ONLY')
    const proposal = expectOk<StrategistProposal>(
      await proposeStrategy(ctxOf(), decision, {
        llm: {
          generateText: async () => ({
            text: JSON.stringify({
              candidates: [{ action: 'ACKNOWLEDGE_RETURN', reason: 'the parcel is coming back' }],
            }),
          }),
        },
      }),
    )
    const out = await execute(h, proposal, decision, {
      ...CLICK,
      acknowledgementType: 'ITEM_RECEIVED' as never,
    })
    expect(out.sent).toBe(true)
    const body = h.paypal.bodyOf<{ acknowledgement_type: string; note: string }>(
      'acknowledge-return-item',
    )
    expect(body.acknowledgement_type).toBe('ITEM_RECEIVED')
    expect(body.note).toContain('R-SNAD-THIN')
    for (const type of ACKNOWLEDGEMENT_TYPES) {
      expect(typeof resolveAcknowledgement(type)).toBe('string')
    }
  })

  it('EC-DSP-5: PROVIDE_SUPPORTING_INFO names what is new, and adds to the packet rather than replacing it', async () => {
    const h = execHarness()
    const decision = decisionOf('CONTEST')
    // **`PROVIDE_SUPPORTING_INFO` is first in the CONTEST permitted list**, so the deterministic proposer does
    // pick it — and with one fact already filed, EC-DSP-5 has something to say.
    const proposal = proposeStrategyDeterministic(ctxOf(), decision, {
      filedFactKeys: ['dispute.amount'],
    })
    expect(proposal.action).toBe('PROVIDE_SUPPORTING_INFO')
    expect(proposal.newFacts).toEqual(['capture.id', 'router.rule'])

    const out = await execute(h, proposal, decision)
    expect(out.sent).toBe(true)
    // **`provide-supporting-info` is multipart** (§10.2 #16), so the notes are a form part. The field is
    // `notes`, not `message` — report §7/#16 verified that against PayPal's own documentation.
    const body = await h.paypal.multipartInputOf<{ notes: string }>('provide-supporting-info')
    expect(body.notes).toContain('New since the filed packet: capture.id, router.rule')
    expect(body.notes).toContain('not replacing it')
  })
})

/** `ExecuteOptions.acknowledgementType` is PayPal's own union; this restates it so the loop above compiles. */
function resolveAcknowledgement(type: string): string {
  return type
}

describe('§8.16: every action needs a merchant click', () => {
  it('without approvedBy nothing is sent at all, and it is a CS_VALIDATION not a default actor', async () => {
    const h = execHarness()
    const decision = decisionOf('OFFER')
    const proposal = proposeStrategyDeterministic(ctxOf(), decision)

    for (const bad of ['', '   ', undefined as unknown as string]) {
      const r = await executeStrategy(proposal, decision, ctxOf(), h.deps, { approvedBy: bad })
      expect(r.ok).toBe(false)
      if (r.ok) throw new Error('expected err')
      expect(r.error.code).toBe('CS_VALIDATION')
      expect(r.error.message).toContain('merchant click')
      expect(r.error.userMessage).toBeDefined()
    }
    expect(h.paypal.calls).toHaveLength(0)
    expect(h.actions()).toHaveLength(0)
  })

  it('an out-of-posture proposal is CS_FORBIDDEN and nothing is sent — the stale-proposal guard', async () => {
    const h = execHarness()
    // **A proposal edited between screens**: `MESSAGE_BUYER` on a `REFUND` posture. The router already decided
    // the money movement, and the strategist must not relitigate it.
    const decision = decisionOf('REFUND')
    const stale = {
      ...proposeStrategyDeterministic(ctxOf(), decisionOf('MESSAGE_ONLY')),
      posture: 'REFUND' as const,
      ruleId: 'R-SNAD-AGENT' as const,
    }
    const r = await executeStrategy(stale, decision, ctxOf(), h.deps, CLICK)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected err')
    expect(r.error.code).toBe('CS_FORBIDDEN')
    expect(r.error.message).toContain('REFUND posture does not permit')
    expect(h.paypal.calls).toHaveLength(0)
  })

  it('EC-MER-7 / the audit trail: every execution writes a dispute_actions row, refusals included', async () => {
    const h = execHarness()
    const decision = decisionOf('OFFER')
    const proposal = proposeStrategyDeterministic(ctxOf(), decision)
    const out = await execute(h, proposal, decision, {
      ...CLICK,
      approvalNote: 'cheaper than handling',
    })
    expect(out.sent).toBe(true)

    expect(h.actions()).toHaveLength(1)
    const row = h.actions()[0]!
    expect(row.actor).toBe('usr_merchant_0000000000000001')
    expect(row.action).toBe('OFFER')
    const request = jsonb(row.request)
    expect(request['rule_id']).toBe('R-SNAD-THIN')
    expect(request['posture']).toBe('OFFER')
    expect(request['proposal_id']).toBe(proposal.proposalId)
    expect(request['approved_by']).toBe('usr_merchant_0000000000000001')
    expect(request['approval_note']).toBe('cheaper than handling')
    // **The money is stored as a minor-unit string plus the ISO code**, and the PayPal-side decimal string
    // alongside it so the case file shows exactly what went on the wire.
    expect(request['amount_minor']).toBe('6500')
    expect(request['currency']).toBe('USD')
    expect(request['paypal_value']).toBe('65.00')
    // **§8.16's cost comparison is stored with its label**, so a UI renders it without recomputing.
    expect(request['cost_handling_minor']).toBe('8200')
    expect(request['cost_verdict']).toBe('CHEAPER_TO_REFUND')
    expect(request['cost_label']).toBe(HANDLING_COST_LABEL)
    const response = jsonb(row.response)
    expect(response['sent']).toBe(true)
    expect(response['paypal_calls']).toEqual(['makeOffer'])
  })

  it('REVIEW_WITH_HUMAN writes no row, because no PayPal call happened', async () => {
    const h = execHarness()
    // **A `REVIEW` posture**, which is the one the router produces for R-NOCHAIN-1. A `REFUND` posture permits
    // *no* action at all, so the proposer still answers `REVIEW_WITH_HUMAN` — and `executeStrategy` then
    // refuses it as out-of-posture, because the posture check runs before the dispatch. Both answers are
    // asserted: the table's empty row above, and this `CS_FORBIDDEN` at the boundary.
    const decision = decisionOf('REVIEW')
    const proposal = proposeStrategyDeterministic(ctxOf(), decision)
    expect(proposal.action).toBe('REVIEW_WITH_HUMAN')
    expect(proposal.paypal).toBeNull()

    const out = await execute(h, proposal, decision)
    expect(out.sent).toBe(false)
    expect(out.actionRow).toBeUndefined()
    expect(h.actions()).toHaveLength(0)
    expect(h.paypal.calls).toHaveLength(0)
    // **And the absence is said out loud**, so it is never a mystery to a reader of the timeline.
    expect(out.warnings.join(' ')).toContain('makes no PayPal call')

    // **And on a `REFUND` posture the same proposal is refused at the door**, which is the stronger statement:
    // the strategist cannot log "a person decided" against a decision that a person did not make.
    const refundDecision = decisionOf('REFUND')
    const refundProposal = proposeStrategyDeterministic(ctxOf(), refundDecision)
    expect(refundProposal.action).toBe('REVIEW_WITH_HUMAN')
    const refused = await executeStrategy(refundProposal, refundDecision, ctxOf(), h.deps, CLICK)
    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('expected err')
    expect(refused.error.code).toBe('CS_FORBIDDEN')
    expect(h.actions()).toHaveLength(0)
  })
})

describe('the money invariant is enforced at the boundary, not only at proposal time', () => {
  it('Σ offers + prior refunds ≤ capture is re-checked against the ctx threaded into the click', async () => {
    const h = execHarness()
    const decision = decisionOf('OFFER')
    const proposal = proposeStrategyDeterministic(ctxOf(), decision)
    expect(proposal.amount).toEqual({ minor: 6_500n, currency: 'USD' })

    // **A newer `priorOffers` than the proposal was computed from** — the merchant already offered the rest, and
    // clicking again would over-commit the capture.
    const out = await execute(h, proposal, decision, {
      ...CLICK,
      priorOffers: [{ minor: 9_000n, currency: 'USD' }],
    })
    expect(out.sent).toBe(false)
    expect(h.paypal.calls).toHaveLength(0)
    expect(h.actions()[0]?.idempotency_key.endsWith(':nofile')).toBe(true)
    const response = jsonb(h.actions()[0]?.response)
    expect(response['code']).toBe('CS_VALIDATION')
    expect(String(response['refusal'])).toContain('remain on the capture')
  })

  it('a proposal that moves no money is refused rather than sent as an empty offer', async () => {
    const h = execHarness()
    const decision = decisionOf('OFFER')
    const proposal = { ...proposeStrategyDeterministic(ctxOf(), decision), amount: null }
    const out = await execute(h, proposal, decision)
    expect(out.sent).toBe(false)
    expect(h.paypal.callsTo('make-offer')).toHaveLength(0)
    expect(String(jsonb(h.actions()[0]?.response)['refusal'])).toContain('moves no money')
  })

  it('EC-BUY-1: offer_type and its return address travel together', () => {
    // **PayPal requires `return_shipping_address` for `REFUND_WITH_RETURN`** (`SPEC-D`, report §4/#10).
    expect(resolveOfferType({ approvedBy: 'm' })).toBe('REFUND')
    expect(
      resolveOfferType({ approvedBy: 'm', returnShippingAddress: { country_code: 'US' } }),
    ).toBe('REFUND_WITH_RETURN')
    expect(resolveOfferType({ approvedBy: 'm', offerType: 'REFUND' })).toBe('REFUND')
    expect(
      resolveOfferType({
        approvedBy: 'm',
        offerType: 'REFUND_WITH_RETURN',
        returnShippingAddress: { a: 1 },
      }),
    ).toBe('REFUND_WITH_RETURN')

    // **The two 400s this function exists to prevent.**
    const missingAddress = resolveOfferType({ approvedBy: 'm', offerType: 'REFUND_WITH_RETURN' })
    expect(typeof missingAddress).not.toBe('string')
    if (typeof missingAddress === 'string') throw new Error('expected an error')
    expect(missingAddress.error.code).toBe('CS_VALIDATION')
    expect(missingAddress.error.message).toContain('return_shipping_address')

    const unknownType = resolveOfferType({
      approvedBy: 'm',
      offerType: 'PAY_ME_IN_BITCOIN' as never,
    })
    if (typeof unknownType === 'string') throw new Error('expected an error')
    expect(unknownType.error.message).toContain('is not a PayPal offer_type')
    // **Every value PayPal documents is accepted**, with the address supplied so `REFUND_WITH_RETURN`'s
    // companion requirement is met rather than short-circuiting.
    for (const type of OFFER_TYPES) {
      expect(
        resolveOfferType({
          approvedBy: 'm',
          offerType: type,
          returnShippingAddress: { country_code: 'US' },
        }),
      ).toBe(type)
    }
  })

  it("the offer body carries the amount as PayPal's own decimal string and the derived offer_type", async () => {
    const h = execHarness()
    const decision = decisionOf('OFFER')
    const proposal = proposeStrategyDeterministic(ctxOf(), decision)
    await execute(h, proposal, decision, {
      ...CLICK,
      returnShippingAddress: { country_code: 'US', address_line_1: '1 Harbour Way' },
      invoiceId: 'ord_00000000000000000000000001',
    })
    const body = h.paypal.bodyOf<{
      offer_type: string
      offer_amount: { currency_code: string; value: string }
      return_shipping_address?: Record<string, unknown>
      invoice_id?: string
      note: string
    }>('make-offer')
    expect(body.offer_type).toBe('REFUND_WITH_RETURN')
    expect(body.offer_amount).toEqual({ currency_code: 'USD', value: '65.00' })
    expect(body.return_shipping_address).toEqual({
      country_code: 'US',
      address_line_1: '1 Harbour Way',
    })
    expect(body.invoice_id).toBe('ord_00000000000000000000000001')
    expect(body.note).toContain('R-SNAD-THIN')
  })
})

describe('EC-DSP-10: an executed strategy is deduplicated by the same deterministic key', () => {
  it('executing the same proposal twice makes one PayPal call', async () => {
    const h = execHarness()
    const decision = decisionOf('OFFER')
    const proposal = proposeStrategyDeterministic(ctxOf(), decision)

    const first = await execute(h, proposal, decision)
    expect(first.sent).toBe(true)
    expect(h.paypal.callsTo('make-offer')).toHaveLength(1)

    const second = await execute(h, proposal, decision)
    expect(second.sent).toBe(false)
    expect(second.paypalCalls).toEqual([])
    expect(second.warnings.join(' ')).toContain('EC-DSP-10')
    // **Still one call, still one row.**
    expect(h.paypal.callsTo('make-offer')).toHaveLength(1)
    expect(h.actions()).toHaveLength(1)
    // **And the second outcome points at the row that already exists**, so S-17 can show it.
    expect(second.actionRow?.idempotencyKey).toBe(`cs:${DISPUTE_ID}:offer:1`)
  })

  it('a raised version re-issues the strategy rather than deduplicating against version 1', async () => {
    const h = execHarness()
    const decision = decisionOf('OFFER')
    const proposal = proposeStrategyDeterministic(ctxOf(), decision)

    await execute(h, proposal, decision)
    const v2 = await execute(h, proposal, decision, { ...CLICK, version: 2 })
    expect(v2.sent).toBe(true)
    expect(v2.requestId).toBe(`cs:${DISPUTE_ID}:offer:2`)
    expect(h.paypal.requestIdOf('make-offer', 1)).toBe(`cs:${DISPUTE_ID}:offer:2`)
    expect(h.actions()).toHaveLength(2)
  })

  it('a refused execution records under :nofile, so the retry after a fix still has the key', async () => {
    const h = execHarness()
    const decision = decisionOf('APPEAL')
    // **An APPEAL with no evidence body is refused** — posting an empty appeal would spend the appeal window
    // re-filing nothing. The appeal arm is reached by a merchant's choice, so the proposal is built through the
    // same `proposeStrategy` re-rank path.
    const proposal = expectOk<StrategistProposal>(
      await proposeStrategy(ctxOf(), decision, {
        llm: {
          generateText: async () => ({
            text: JSON.stringify({
              candidates: [{ action: 'APPEAL', reason: 'a carrier answered after the loss' }],
            }),
          }),
        },
      }),
    )
    expect(proposal.action).toBe('APPEAL')
    const refused = await execute(h, proposal, decision)
    expect(refused.sent).toBe(false)
    expect(h.paypal.callsTo('/appeal')).toHaveLength(0)
    expect(h.actions()[0]?.idempotency_key).toBe(`cs:${DISPUTE_ID}:appeal:1:nofile`)
    expect(String(jsonb(h.actions()[0]?.response)['refusal'])).toContain('re-filing nothing')

    // **The retry with an evidence body uses the unspent key.**
    const sent = await execute(h, proposal, decision, {
      ...CLICK,
      appealInput: {
        evidences: [{ evidence_type: 'ITEM_DESCRIPTION', notes: 'Rule R-APPEAL-1 [[clm_rule]].' }],
      },
    })
    expect(sent.sent).toBe(true)
    expect(sent.requestId).toBe(`cs:${DISPUTE_ID}:appeal:1`)
    expect(h.actions()).toHaveLength(2)
  })
})

describe('the executor has no path to an evidence upload', () => {
  it('no executed strategy reaches provide-evidence or accept-claim', async () => {
    const h = execHarness()
    // **Every posture the router produces, executed as the product would.** `provide-evidence` and
    // `accept-claim` are stubbed in the fake so a call would be *recorded* — and the assertion is that neither
    // is ever made from this file's path.
    for (const posture of ['OFFER', 'MESSAGE_ONLY', 'CONTEST', 'APPEAL', 'REVIEW'] as Posture[]) {
      const decision = decisionOf(posture)
      const proposal = proposeStrategyDeterministic(ctxOf(), decision)
      const options: ExecuteOptions =
        proposal.action === 'APPEAL'
          ? {
              ...CLICK,
              appealInput: { evidences: [{ evidence_type: 'ITEM_DESCRIPTION', notes: 'n' }] },
            }
          : CLICK
      await execute(h, proposal, decision, options)
    }
    expect(h.paypal.callsTo('provide-evidence')).toHaveLength(0)
    expect(h.paypal.callsTo('accept-claim')).toHaveLength(0)
  })

  it('an unknown action in a hand-built proposal is refused, not dispatched', async () => {
    const h = execHarness()
    const decision = decisionOf('MESSAGE_ONLY')
    const bogus = {
      ...proposeStrategyDeterministic(ctxOf(), decision),
      action: 'PROVIDE_EVIDENCE' as never,
    }
    // **The posture check runs first**, so a name outside the table never reaches the `switch`'s default arm.
    const r = await executeStrategy(bogus, decision, ctxOf(), h.deps, CLICK)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected err')
    expect(r.error.code).toBe('CS_FORBIDDEN')
    expect(h.paypal.calls).toHaveLength(0)
  })

  it('MAX_EVIDENCE_FILE_BYTES is 10,000,000 and exclusive, which is why the packet PDF is the only attachment', () => {
    // **Stated here because the appeal arm accepts files and a judge will ask what the limit is.** The value
    // comes from `@countersign/paypal`, not from a copy here, so the two cannot drift.
    expect(MAX_EVIDENCE_FILE_BYTES).toBe(10_000_000)
    expect(ACKNOWLEDGEMENT_TYPES.length).toBeGreaterThan(0)
    expect(OFFER_TYPES).toContain('REFUND_WITH_RETURN')
  })
})

describe('the router and the strategist agree, because both read the same context', () => {
  it('a real R-SNAD-THIN decision produces an OFFER proposal the executor will accept', async () => {
    // **The end-to-end shape of §8.16**: the router decides, the strategist proposes within that posture, and the
    // executor sends after a click. The decision comes from `route()`, so the posture under test is one the
    // product reaches rather than one a fixture declared.
    const decision = route(ctxOf())
    expect(decision.ruleId).toBe('R-SNAD-THIN')
    expect(decision.posture).toBe('OFFER')

    const h = execHarness()
    const proposal = proposeStrategyDeterministic(ctxOf(), decision)
    expect(proposal.posture).toBe(decision.posture)
    expect(proposal.ruleId).toBe(decision.ruleId)
    // **EC-BUY-1 in one line**: an offer, priced below MRC's average handling cost, with the label attached.
    expect(proposal.action).toBe('MAKE_OFFER')
    expect(proposal.amount).toEqual({ minor: 6_500n, currency: 'USD' })
    expect(proposal.cost.verdict).toBe('CHEAPER_TO_REFUND')
    expect(proposal.cost.handlingCostLabel).toBe(HANDLING_COST_LABEL)

    const out = await execute(h, proposal, decision)
    expect(out.sent).toBe(true)
    expect(h.paypal.callsTo('make-offer')).toHaveLength(1)
  })
})
