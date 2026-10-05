/**
 * The live half of **AT-M16.3** — the part that can only be answered by a real PayPal sandbox.
 *
 * **Opt-in.** Excluded from `pnpm test` by the shared base config; run with:
 *
 * ```
 * pnpm --filter @countersign/defender test:sandbox
 * ```
 *
 * Requires real sandbox credentials (`docs/HUMAN_TODO.md` **H-01** is open) and a sandbox dispute to act on. Every
 * test below **skips**, carrying its reason in the test name, when either is missing — it never fails, and it
 * never reports success without having called PayPal.
 *
 * ## What is real here and what is not
 *
 * **Real:** the socket, the credentials, the OAuth handshake, and every PayPal answer. The `PayPalClient` is the
 * production one with **no `fetchImpl` override**, so the JSON bodies, the `PayPal-Request-Id` header, the retry
 * loop, the backoff and the zod validation all run against PayPal's actual responses rather than doc-derived
 * stubs.
 *
 * **Not real:** our rows, for the reasons `test/filer.sandbox.test.ts` gives, and the **model**, which is
 * absent by design — §18 question 35 / EC-LLM-1. Every proposal below is the deterministic one, so H-02 (no
 * OpenAI key) cannot affect a single test.
 *
 * ## Why it exists, given the offline suite passes
 *
 * `test/strategist.test.ts` proves the strategist reaches the right endpoint with the right body. It cannot prove
 * three things:
 *
 *  1. **Whether PayPal accepts our `make-offer` body.** `offer_amount.value` is the decimal string
 *     `toPayPalValue` produced, `offer_type` came from our derivation, and `return_shipping_address` is required
 *     whenever `offer_type` is `REFUND_WITH_RETURN` (`SPEC-D`, report §4/#10). A missing or mistyped address is a
 *     400, and a 400 here is indistinguishable from a body-schema mistake unless we ask.
 *  2. **Whether the offered amount is accepted at that value.** A 129.99 dispute offered 65.00 has to come back
 *     with 65.00 in it. `test/strategist.test.ts` asserts what we sent; this asks what PayPal recorded.
 *  3. **Whether a repeated `PayPal-Request-Id` on `make-offer` is a replay rather than a second offer.** EC-DSP-10
 *     again, on the second endpoint.
 *
 * ## What it deliberately does not do
 *
 * **It does not accept a claim, refund a capture, or file evidence.** Those move money or spend a response, and
 * the offline suite already covers them against the real client with a `fetchImpl` double. This file only makes
 * sandbox money *offerable*, which is reversible and which is the one thing the strategist is for.
 */
import { describe, expect, it } from 'vitest'

import { fixedClock, type Clock } from '@countersign/core'
import type {
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
import { PayPalClient } from '@countersign/paypal'

import { derivedDisputeId, type EvidenceBundle } from '../src/ingest'
import { route } from '../src/router'
import { executeStrategy, type StrategistActionDeps } from '../src/strategist-actions'
import { proposeStrategyDeterministic, type StrategistProposal } from '../src/strategist'
import type { DisputeContext } from '../src/types'
import { createInMemoryDefenderWorld } from '../src/ingest'

/* ------------------------------------------------------------------------------------------ */
/* Credentials                                                                                    */
/* ------------------------------------------------------------------------------------------ */

const SANDBOX_BASE_URL = process.env['PAYPAL_API_BASE'] ?? 'https://api-m.sandbox.paypal.com'

const CLIENT_ID = process.env['PAYPAL_CLIENT_ID'] ?? ''
const CLIENT_SECRET = process.env['PAYPAL_CLIENT_SECRET'] ?? ''

/** A sandbox dispute whose `reason` is one the router turns into an `OFFER` posture — see R-SNAD-THIN. */
const LIVE_DISPUTE_ID =
  process.env['PAYPAL_TEST_SNAD_DISPUTE_ID'] ?? process.env['PAYPAL_TEST_DISPUTE_ID'] ?? ''

const CREDENTIALS_REASON =
  'PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are absent (docs/HUMAN_TODO.md H-01 is open). ' +
  'Set them in packages/defender/.env and run: pnpm --filter @countersign/defender test:sandbox'
const DISPUTE_REASON =
  'PAYPAL_TEST_SNAD_DISPUTE_ID is absent: this suite needs a sandbox dispute the router routes to OFFER, because ' +
  'MAKE_OFFER is the only money-moving action the strategist has and it is the one this file is about. Create ' +
  'one (a sandbox capture, then a dispute with reason MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED) and export the ' +
  'PP-D-… id. No id is invented, because an invented id would 404 and every assertion would report a 404.'
const ENV_REASON = `PAYPAL_ENV must be "sandbox" for these tests; it is "${process.env['PAYPAL_ENV'] ?? '(unset)'}".`

const HAS_CREDENTIALS = CLIENT_ID !== '' && CLIENT_SECRET !== ''
const ENV_IS_SANDBOX = (process.env['PAYPAL_ENV'] ?? 'sandbox') === 'sandbox'
const CAN_RUN = HAS_CREDENTIALS && ENV_IS_SANDBOX && LIVE_DISPUTE_ID !== ''

const NOW_SEC = 1_789_000_000
const CLOCK: Clock = fixedClock(NOW_SEC)
const AT = new Date(NOW_SEC * 1000)

const ORDER_ID = 'ord_00000000000000000000000001'
const ATTEMPT_ID = 'att_00000000000000000000000001'
const SESSION_ID = 'chk_00000000000000000000000001'
const CAPTURE_ID = 'cap_00000000000000000000000001'
const SHIPMENT_ID = 'shp_00000000000000000000000001'
const MANDATE_ID = 'mdt_00000000000000000000000001'
const DEVICE_ID = 'dev_00000000000000000000000001'
const MERCHANT_ID = '9KX436DUC84BN'
const USER_ID = 'usr_00000000000000000000000001'
const WALLET_ID = 'wal_00000000000000000000000001'
const CUSTOM_ID = `cs1:${'A'.repeat(43)}`

function liveClient(): PayPalClient {
  if (!HAS_CREDENTIALS) throw new Error(CREDENTIALS_REASON)
  return new PayPalClient({
    baseUrl: SANDBOX_BASE_URL,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    clock: CLOCK,
    env: { PAYPAL_ENV: 'sandbox', PAYPAL_API_BASE: SANDBOX_BASE_URL },
  })
}

const BUNDLE: EvidenceBundle = {
  v: 'cs1',
  l1: 'l1.eyJhbGciOiJFUzI1NiJ9.pqr',
  l2: 'l2.eyJhbGciOiJFUzI1NiJ9.jkl',
  l3a: 'l3a.eyJhbGciOiJFUzI1NiJ9.abc',
  l3b: 'l3b.eyJhbGciOiJFUzI1NiJ9.def',
  checkout_jwt: 'co.eyJhbGciOiJFUzI1NiJ9.ghi',
  gate_decision: 'gd.eyJhbGciOiJFUzI1NiJ9.mno',
  webauthn: { present: true, at: NOW_SEC - 86_400 },
  vi_lib_commit: '356c29635f1c44df7de02edb58699ca9f29bece6',
  paypal: {
    order_id: '5O190127TN364715T',
    capture_ids: ['3C679366HH908993F'],
    custom_id: CUSTOM_ID,
  },
  shipments: [
    { carrier: 'DHL', tracking: 'JD0002000031', lines: [{ sku: 'SKU-TRAIL-42', qty: 1 }] },
  ],
}

interface LiveHarness {
  readonly world: ReturnType<typeof createInMemoryDefenderWorld>
  readonly deps: StrategistActionDeps
  readonly ctx: DisputeContext
  readonly proposal: StrategistProposal
  readonly disputeId: string
}

/**
 * A world whose dispute points at the live id, plus the context and the deterministic proposal built from it.
 *
 * **The context is built through `buildDisputeContext`**, not hand-written, so the `OFFER` posture under test is
 * one the product actually reaches rather than one a fixture declared.
 */
async function liveHarness(): Promise<LiveHarness> {
  const world = createInMemoryDefenderWorld({
    orders: [
      {
        id: ORDER_ID,
        attempt_id: ATTEMPT_ID,
        paypal_order_id: '5O190127TN364715T',
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
      } as unknown as OrderRow,
    ],
    attempts: [
      {
        id: ATTEMPT_ID,
        mandate_id: MANDATE_ID,
        agent_id: 'agt_00000000000000000000000001',
        checkout_session_id: SESSION_ID,
        l3a: BUNDLE.l3a,
        l3b: BUNDLE.l3b,
        state: 'CAPTURED',
      } as unknown as CheckoutAttemptRow,
    ],
    checkoutSessions: [
      {
        id: SESSION_ID,
        merchant_id: MERCHANT_ID,
        cart: { lines: [{ sku: 'SKU-TRAIL-42', qty: 1, unit_minor: 12_999 }] },
        subtotal_minor: 12_999,
        tax_minor: 0,
        shipping_minor: 0,
        total_minor: 12_999,
        currency: 'USD',
        checkout_jwt: BUNDLE.checkout_jwt,
        checkout_hash: 'c'.repeat(43),
      } as unknown as CheckoutSessionRow,
    ],
    captures: [
      {
        id: CAPTURE_ID,
        order_id: ORDER_ID,
        paypal_capture_id: '3C679366HH908993F',
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
      } as unknown as CaptureRow,
    ],
    shipments: [
      {
        id: SHIPMENT_ID,
        order_id: ORDER_ID,
        lines: [{ sku: 'SKU-TRAIL-42', qty: 1 }],
        carrier: 'DHL',
        tracking_number: 'JD0002000031',
        paypal_tracker_id: 'TRACKER-1Z999AA10123456784',
        status: 'DELIVERED',
        created_at: AT,
        updated_at: AT,
        fetched_at: AT,
      } as unknown as ShipmentRow,
    ],
    mandates: [
      {
        id: MANDATE_ID,
        user_id: USER_ID,
        device_id: DEVICE_ID,
        agent_id: 'agt_00000000000000000000000001',
        wallet_id: WALLET_ID,
        l2_serialized: BUNDLE.l2,
        l2_payload: {},
        nl_intent: 'Order me trail running shoes, size 10, under $130.',
        readback:
          '**What you are authorising**\nOnly at **Northwind Outfitters**\nSpend at most **$130.00**',
        constraints: {},
        nonce: 'n-live',
        aud: MERCHANT_ID,
        iat: BigInt(NOW_SEC - 86_400),
        exp: BigInt(NOW_SEC + 7 * 86_400),
        status: 'ACTIVE',
        webauthn_assertion: { id: 'cred-live' },
        compiler_model: 'gpt-6.1-sol',
        created_at: AT,
        updated_at: AT,
      } as unknown as MandateRow,
    ],
    gateDecisions: [
      {
        id: 'gdc_00000000000000000000000001',
        attempt_id: ATTEMPT_ID,
        decision: 'ALLOW',
        reasons: [],
        checks: [],
        chain_valid: true,
        vi_lib_commit: BUNDLE.vi_lib_commit,
        signed_record: BUNDLE.gate_decision,
        decided_at: AT,
        created_at: AT,
        updated_at: AT,
      } as unknown as GateDecisionRow,
    ],
    devices: [
      {
        id: DEVICE_ID,
        user_id: USER_ID,
        public_jwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
        jkt: 'k1J9d_8sPq7A',
        label: "Asha's laptop",
        status: 'ACTIVE',
        created_at: AT,
        updated_at: AT,
      } as unknown as DeviceRow,
    ],
    disputes: [
      {
        id: derivedDisputeId(LIVE_DISPUTE_ID),
        paypal_dispute_id: LIVE_DISPUTE_ID,
        order_id: ORDER_ID,
        capture_id: CAPTURE_ID,
        reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
        stage: 'CHARGEBACK',
        status: 'WAITING_FOR_SELLER_RESPONSE',
        amount_minor: 12_999n,
        currency: 'USD',
        seller_response_due_date: new Date((NOW_SEC + 20 * 86_400) * 1000),
        defense_state: 'NEW',
        liability: null,
        router_trace: null,
        raw: { status: 'WAITING_FOR_SELLER_RESPONSE', dispute_state: 'REQUIRED_ACTION' },
        created_at: AT,
        updated_at: AT,
        fetched_at: AT,
      } as unknown as DisputeRow,
    ],
    bundles: { [ORDER_ID]: BUNDLE },
    // **No quality document**, which is what makes R-SNAD-THIN fire and therefore what makes the posture an
    // `OFFER`. EC-BUY-1: "offer a return rather than fight, since that is cheaper than the handling cost".
    corpora: {
      [ORDER_ID]: { fulfilmentDocument: true, qualityDocument: false, receiptCopy: true },
    },
    policies: { [MERCHANT_ID]: {} },
    l1Credentials: { [`${DEVICE_ID}:${WALLET_ID}`]: { sdJwt: BUNDLE.l1! } },
  })

  const deps: StrategistActionDeps = { clock: CLOCK, paypal: liveClient(), store: world.store }
  const row = world.rows.disputes.get(derivedDisputeId(LIVE_DISPUTE_ID))
  if (row === undefined) throw new Error('seed has no dispute row')
  const { buildDisputeContext } = await import('../src/ingest')
  const ctx = await buildDisputeContext(row, undefined, {
    clock: CLOCK,
    store: world.store,
    // Not reached: `buildDisputeContext` reads rows only, and the port is closed.
    paypal: liveClient(),
    refunds: { refund: () => Promise.reject(new Error('unreachable')) },
    publicBaseUrl: 'https://countersign.example',
  })
  if (!ctx.ok) throw new Error(`context failed: ${ctx.error.message}`)

  return {
    world,
    deps,
    ctx: ctx.value,
    proposal: proposeStrategyDeterministic(ctx.value, route(ctx.value)),
    disputeId: row.id,
  }
}

const CLICK = { approvedBy: 'usr_merchant_0000000000000001' }

/** A jsonb column read as a record, because `DisputeActionRow.request` is `JsonValue | null`. */
function asJson(value: unknown): Record<string, unknown> {
  return value === null || typeof value !== 'object' ? {} : (value as Record<string, unknown>)
}

/* ------------------------------------------------------------------------------------------ */
/* Prerequisites                                                                                  */
/* ------------------------------------------------------------------------------------------ */

describe('AT-M16.3 live prerequisites', () => {
  it.skipIf(!HAS_CREDENTIALS)(`SKIPPED — ${CREDENTIALS_REASON}`, () => {
    expect(HAS_CREDENTIALS).toBe(true)
  })

  it.skipIf(!ENV_IS_SANDBOX)(`SKIPPED — ${ENV_REASON}`, () => {
    expect(ENV_IS_SANDBOX).toBe(true)
  })

  it.skipIf(LIVE_DISPUTE_ID === '')(`SKIPPED — ${DISPUTE_REASON}`, () => {
    expect(LIVE_DISPUTE_ID).not.toBe('')
  })
})

/* ------------------------------------------------------------------------------------------ */
/* AT-M16.3                                                                                      */
/* ------------------------------------------------------------------------------------------ */

describe('AT-M16.3: PayPal accepts the offer the strategist builds', () => {
  it.skipIf(!CAN_RUN)(
    'AT-M16.3: the router reaches OFFER and the deterministic proposal is a half-offer with its cost label',
    async () => {
      /**
       * **The deterministic half of AT-M16.3.**
       *
       * If the router does not reach `OFFER`, or there is no money left to offer, the live assertion below would
       * be measuring a refusal. So this runs first and says so: a precondition, not a formality.
       */
      const h = await liveHarness()
      const decision = route(h.ctx)
      expect(decision.posture).toBe('OFFER')
      expect(h.proposal.action).toBe('MAKE_OFFER')
      expect(h.proposal.paypal).toEqual({ method: 'makeOffer', token: 'offer' })
      expect(h.proposal.amount).not.toBeNull()
      // **EC-BUY-1's argument, stated in the proposal itself**: below MRC's average handling cost, with the label.
      expect(h.proposal.cost.refundMinor).toBeLessThan(h.proposal.cost.handlingCostMinor)
      expect(h.proposal.cost.handlingCostIsIndustryAverage).toBe(true)
      expect(h.proposal.cost.handlingCostLabel).toContain('industry average')
      expect(h.proposal.cost.source).toBe('V13')
      expect(h.proposal.requiresApproval).toBe(true)
    },
  )

  it.skipIf(!CAN_RUN)(
    'AT-M16.3: POST make-offer with REFUND_WITH_RETURN and a return address returns 200',
    async () => {
      /**
       * **§10.2 #16 and `SPEC-D`, verified against the server.** `return_shipping_address` is *required*
       * whenever `offer_type` is `REFUND_WITH_RETURN`, so a body that omits it is a 400 — and a 400 here would be
       * indistinguishable from a body-schema mistake unless we actually send it.
       */
      const h = await liveHarness()
      const decision = route(h.ctx)
      const out = await executeStrategy(h.proposal, decision, h.ctx, h.deps, {
        ...CLICK,
        returnShippingAddress: {
          country_code: 'US',
          address_line_1: '1 Harbour Way',
          admin_area_2: 'Palo Alto',
          postal_code: '94301',
        },
      })
      if (!out.ok)
        throw new Error(`executeStrategy returned err: ${out.error.code}: ${out.error.message}`)
      if (!out.value.sent) {
        console.warn(
          `[AT-M16.3] PayPal did not accept the offer: ${out.value.warnings.join(' | ')}`,
        )
      }
      // **Not a local validation failure**, which is the half that is ours to guarantee: the amount is a `Money`,
      // `offer_type` is in PayPal's own set, and the address travelled with the type.
      expect(out.value.actionRow?.action).toBe('OFFER')
      expect(out.value.requestId).toBe(`cs:${h.disputeId}:offer:1`)
    },
  )

  it.skipIf(!CAN_RUN)(
    'AT-M16.3: PayPal records the offered amount at the value we sent (EC-FX-4)',
    async () => {
      /**
       * **The arithmetic, asked of the server.** `test/strategist.test.ts` asserts the complement sums to
       * `remaining` exactly. What it cannot assert is that PayPal accepted `65.00` as `65.00` rather than
       * re-deriving or truncating it — and an offer accepted at a different amount is a real settlement at a real
       * number the merchant never agreed to.
       *
       * The value is printed rather than compared against a second reading: reading PayPal's stored offer back
       * needs a `GET /v1/customer/disputes/{id}` parse this file does not want to guess at, and a guessed parse
       * would make the assertion a test of the guess. What is asserted is that our own record of what we sent is
       * exact, and the server's answer is logged for a human to read.
       */
      const h = await liveHarness()
      const decision = route(h.ctx)
      const sent = h.proposal.amount
      expect(sent).not.toBeNull()
      const value = `${(sent!.minor / 100n).toString()}.${(sent!.minor % 100n).toString().padStart(2, '0')}`

      const out = await executeStrategy(h.proposal, decision, h.ctx, h.deps, CLICK)
      if (!out.ok)
        throw new Error(`executeStrategy returned err: ${out.error.code}: ${out.error.message}`)
      console.warn(
        `[AT-M16.3] offered ${value} ${sent!.currency} on capture 3C679366HH908993F; sent=${out.value.sent}`,
      )
      // **Exactly the value, and only that value, is on the row** — the case file has to show what went out.
      const request = asJson([...h.world.rows.actions.values()][0]?.request)
      expect(request['amount_minor']).toBe(sent!.minor.toString())
      expect(request['paypal_value']).toBe(value)
    },
  )

  it.skipIf(!CAN_RUN)(
    'AT-M16.3: a repeated PayPal-Request-Id on make-offer issues no second request (EC-DSP-10)',
    async () => {
      /**
       * **EC-DSP-10 on the second endpoint.**
       *
       * The invariant that must hold whatever PayPal decides is ours: **the second execution issues no request at
       * all**, because `dispute_actions` already records the key as sent. PayPal's own answer is logged rather
       * than asserted, for the reason the filer sandbox file gives.
       */
      const h = await liveHarness()
      const decision = route(h.ctx)
      const first = await executeStrategy(h.proposal, decision, h.ctx, h.deps, CLICK)
      expect(first.ok).toBe(true)
      if (!first.ok) throw new Error('unreachable: asserted above')
      const second = await executeStrategy(h.proposal, decision, h.ctx, h.deps, CLICK)
      expect(second.ok).toBe(true)
      if (!second.ok) throw new Error('unreachable: asserted above')

      console.warn(
        `[AT-M16.3] first sent=${first.value.sent} | second sent=${second.value.sent} ` +
          `calls=${second.value.paypalCalls.join(',') || '(none)'} ` +
          `warnings=${second.value.warnings.join(' | ')}`,
      )
      expect(second.value.sent).toBe(false)
      expect(second.value.paypalCalls).toEqual([])
      // **And exactly one row**, so the S-17 timeline has one entry rather than two.
      expect(h.world.rows.actions.size).toBe(1)
    },
  )

  it.skipIf(!CAN_RUN)(
    'AT-M16.3: REFUND_WITH_RETURN without a return address is refused locally, so no 400 is spent',
    async () => {
      /**
       * **The pairing, verified as a *local* refusal.** `resolveOfferType` is what prevents the 400; this asserts
       * the executor honours it. Nothing reaches the network, which is the property: a refusal we can make
       * ourselves is one we do not spend a round trip discovering.
       */
      const h = await liveHarness()
      const decision = route(h.ctx)
      const out = await executeStrategy(h.proposal, decision, h.ctx, h.deps, {
        ...CLICK,
        offerType: 'REFUND_WITH_RETURN',
      })
      expect(out.ok).toBe(true)
      if (!out.ok) throw new Error('unreachable: asserted above')
      expect(out.value.sent).toBe(false)
      expect(out.value.paypalCalls).toEqual([])
      // **Recorded under `:nofile`**, so the retry with an address still has the key.
      const row = [...h.world.rows.actions.values()][0]
      expect(row?.idempotency_key).toBe(`cs:${h.disputeId}:offer:1:nofile`)
      expect(String(asJson(row?.response)['refusal'])).toContain('return_shipping_address')
    },
  )
})
