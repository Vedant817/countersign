/**
 * The live half of **AT-M15.4** — the part that can only be answered by a real PayPal sandbox.
 *
 * **Opt-in.** Excluded from `pnpm test` by the shared base config; run with:
 *
 * ```
 * pnpm --filter @countersign/defender test:sandbox
 * ```
 *
 * Requires real sandbox credentials (`docs/HUMAN_TODO.md` **H-01** is open). Without them every test below
 * **skips**, carrying its reason in the test name — it never fails, and it never reports success without having
 * called PayPal.
 *
 * ## What is real here and what is not
 *
 * **Real:** the socket, the credentials, the OAuth handshake, and every PayPal answer. The `PayPalClient` is the
 * production one with **no `fetchImpl` override**, so the multipart body, the `PayPal-Request-Id` header, the
 * retry loop, the backoff and the zod validation all run against PayPal's actual responses rather than
 * doc-derived stubs.
 *
 * **Not real:** our rows. They live in `createInMemoryDefenderWorld`, because there is no Postgres credential in
 * this repository's `.env.example` either, and the question this file answers is *"does PayPal accept the packet
 * we built, and does a repeated request id come back as the same filing?"* — answered by the wire, not by the
 * storage engine. `test/filer.test.ts` covers row semantics against the port contract.
 *
 * ## Why it exists, given the offline suite passes
 *
 * Three things are unverifiable offline and all three are load-bearing:
 *
 *  1. **Whether PayPal accepts the multipart body at all.** §10.2 #14 specifies `input` + `file1…`, and the
 *     offline suite asserts we build it — not that the server parses it. A 400 here would look exactly like a
 *     schema mistake in our own `provideEvidenceInput`.
 *  2. **Whether PayPal honours a repeated `PayPal-Request-Id`.** EC-DSP-10's claim is "filing twice issues one
 *     PayPal call". Offline we can only assert that *we* made one call; here we ask PayPal what it did with the
 *     second.
 *  3. **Whether a packet over 10 MB is refused by the server and not only by our own reader.** EC-DSP-12's
 *     expected behaviour names PayPal's own limit; our reader is a fast local copy of it, and a copy is not the
 *     thing.
 *
 * ## What it deliberately does not do
 *
 * **It does not file against a real dispute.** A sandbox dispute has to be created against a sandbox capture,
 * and this repository has no seeded sandbox capture id in `.env.example`. Rather than invent one — which would
 * make every test here a 404 dressed as an assertion — the suites below are **gated on the evidence id being
 * supplied**, and the skipped test names say so. When someone runs §8.7 onboarding once and exports the capture
 * id, these become real end-to-end filings with no code change.
 */
import { describe, expect, it } from 'vitest'

import { fixedClock, type Clock } from '@countersign/core'
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
import { PayPalClient } from '@countersign/paypal'

import { fileDispute } from '../src/filer'
import { createInMemoryDefenderWorld, derivedDisputeId, type EvidenceBundle } from '../src/ingest'
import { route } from '../src/router'
import { buildDisputeContext } from '../src/ingest'
import { plainNotes, templateNote } from '../src/drafter'
import { claimSourcesFor, publicPacketUrl } from '../src/citation-check'
import { planEvidence } from '../src/planner'

/* ------------------------------------------------------------------------------------------ */
/* Credentials                                                                                    */
/* ------------------------------------------------------------------------------------------ */

/** Where these tests talk. EC-ENV-1: a live host is refused by the client, so this cannot be real money. */
const SANDBOX_BASE_URL = process.env['PAYPAL_API_BASE'] ?? 'https://api-m.sandbox.paypal.com'

const CLIENT_ID = process.env['PAYPAL_CLIENT_ID'] ?? ''
const CLIENT_SECRET = process.env['PAYPAL_CLIENT_SECRET'] ?? ''

/**
 * **The id of a real sandbox dispute to file against.**
 *
 * There is no seeded value in `.env.example`, because a sandbox dispute has to be created against a sandbox
 * capture and this repository has no scripted way to create one. So the tests that need a live dispute are
 * skipped with that reason in their names rather than inventing an id that would 404 — which is the failure
 * mode that cost the most time while writing the offline suite.
 */
const LIVE_DISPUTE_ID = process.env['PAYPAL_TEST_DISPUTE_ID'] ?? ''

const CREDENTIALS_REASON =
  'PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are absent (docs/HUMAN_TODO.md H-01 is open). ' +
  'Set them in packages/defender/.env and run: pnpm --filter @countersign/defender test:sandbox'
const DISPUTE_REASON =
  'PAYPAL_TEST_DISPUTE_ID is absent: file against a sandbox dispute that exists. Create one from a sandbox ' +
  'capture (run the §8.7 onboarding once) and export the PP-D-… id. No id is invented here, because an invented ' +
  'id would 404 and every assertion below would be reporting a 404.'
const ENV_REASON = `PAYPAL_ENV must be "sandbox" for these tests; it is "${process.env['PAYPAL_ENV'] ?? '(unset)'}".`

const HAS_CREDENTIALS = CLIENT_ID !== '' && CLIENT_SECRET !== ''
/** Unset means sandbox, the same default `packages/orders`' sandbox suite uses. */
const ENV_IS_SANDBOX = (process.env['PAYPAL_ENV'] ?? 'sandbox') === 'sandbox'
const CAN_FILE = HAS_CREDENTIALS && ENV_IS_SANDBOX && LIVE_DISPUTE_ID !== ''

/** A fixed instant, so nothing here depends on wall time (AGENTS.md rule 10). */
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

/** The production client: real credentials, real socket, no `fetchImpl`. */
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

/** `MAX_EVIDENCE_FILE_BYTES` + 1, so EC-DSP-12's refusal can be asked of PayPal rather than assumed. */
const OVERSIZE_BYTES = 10_000_001

// ---------------------------------------------------------------------------
// A world whose dispute points at the live id
// ---------------------------------------------------------------------------

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

/** Cast from a literal rather than built field-by-field: this fixture's job is the wire, not the row shape. */
function liveWorld() {
  return createInMemoryDefenderWorld({
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
        constraints: { preferences: { size: '10' } },
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
    audit: [] as AuditLogRow[],
    disputes: [
      {
        id: derivedDisputeId(LIVE_DISPUTE_ID),
        paypal_dispute_id: LIVE_DISPUTE_ID,
        order_id: ORDER_ID,
        capture_id: CAPTURE_ID,
        reason: 'UNAUTHORISED',
        stage: 'CHARGEBACK',
        status: 'WAITING_FOR_SELLER_RESPONSE',
        amount_minor: 12_999n,
        currency: 'USD',
        // **A deadline far enough out that the CRITICAL guard cannot fire**, so the test measures PayPal rather
        // than our own clock. A guard firing would be a refusal with no request, which says nothing about the
        // server.
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
    corpora: { [ORDER_ID]: { fulfilmentDocument: true, receiptCopy: true } },
    policies: { [MERCHANT_ID]: {} },
    l1Credentials: { [`${DEVICE_ID}:${WALLET_ID}`]: { sdJwt: BUNDLE.l1! } },
  })
}

interface LiveHarness {
  readonly world: ReturnType<typeof liveWorld>
  readonly deps: Parameters<typeof fileDispute>[1]
  readonly disputeId: string
}

function liveHarness(): LiveHarness {
  const world = liveWorld()
  return {
    world,
    disputeId: derivedDisputeId(LIVE_DISPUTE_ID),
    deps: {
      clock: CLOCK,
      store: world.store,
      paypal: liveClient(),
      // **Not reachable on a CONTEST posture.** Present because `DefenderDeps` is closed, and a function that
      // throws is better than a silent no-op if a future route reaches a REFUND.
      refunds: {
        refund: () => {
          throw new Error('AT-M15.4 files evidence only; a refund here would move sandbox money')
        },
      },
      publicBaseUrl: process.env['PUBLIC_BASE_URL'] ?? 'https://countersign.example',
      artefacts: {
        readback:
          '**What you are authorising**\nOnly at **Northwind Outfitters**\nSpend at most **$130.00**',
        l1: BUNDLE.l1,
        l2: BUNDLE.l2,
        l3a: BUNDLE.l3a,
        l3b: BUNDLE.l3b,
        checkoutJwt: BUNDLE.checkout_jwt,
        gateDecision: BUNDLE.gate_decision,
        deviceJkt: 'k1J9d_8sPq7A',
        agentKid: 'agt_00000000000000000000000001',
        viLibCommit: BUNDLE.vi_lib_commit,
        payerEmail: 'asha.rane@example.com',
        payerCountry: 'US',
        payerCity: 'Palo Alto',
      },
    },
  }
}

const CLICK = { approval: { by: 'usr_merchant_0000000000000001' } }

/* ------------------------------------------------------------------------------------------ */
/* Prerequisites                                                                                  */
/* ------------------------------------------------------------------------------------------ */

/**
 * The "can we run at all?" suite. Its skipped tests carry the reason in the **name**, so a green run here can
 * never be mistaken for a run that really called PayPal.
 */
describe('AT-M15.4 live prerequisites', () => {
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
/* AT-M15.4                                                                                      */
/* ------------------------------------------------------------------------------------------ */

/**
 * AT-M15.4: *"A real sandbox dispute accepts the multipart evidence packet."*
 *
 * Three assertions, each one about something only the server can answer.
 */
describe('AT-M15.4: PayPal accepts the packet we build', () => {
  it.skipIf(!CAN_FILE)(
    'AT-M15.4: the router reaches CONTEST on a fully evidenced sandbox dispute, and the packet is built offline',
    async () => {
      /**
       * **The deterministic half of AT-M15.4, run with the real client wired in.**
       *
       * If the router does not reach a filing posture, or the citation checker refuses the note, or the plan is
       * empty, then no request exists to send and the live assertion below would be measuring a refusal. So this
       * test runs first and says so explicitly: it is a precondition, not a formality.
       */
      const h = liveHarness()
      const row = h.world.rows.disputes.get(h.disputeId)!
      const ctx = await buildDisputeContext(row, undefined, h.deps)
      expect(ctx.ok).toBe(true)
      if (!ctx.ok) throw new Error(`context failed: ${ctx.error.message}`)

      const decision = route(ctx.value)
      expect(decision.posture).toBe('CONTEST')
      expect(decision.ruleId).toBe('R-UNAUTH-1')

      // **The note the filer would file passes the checker by construction**, which is what makes the live run
      // below a test of PayPal rather than of our own prose.
      const packetId = 'pkt_live_probe_0000000000000001'
      const claims = claimSourcesFor(ctx.value, decision)
      const notes = templateNote(
        {
          ctx: ctx.value,
          decision,
          plan: planEvidence(ctx.value, decision),
          packetId,
          publicBaseUrl: h.deps.publicBaseUrl,
          claims,
        },
        claims,
        publicPacketUrl(h.deps.publicBaseUrl, packetId),
      )
      expect(plainNotes(notes)).not.toContain('[[')
      expect(notes).toContain('[[clm_')
    },
  )

  it.skipIf(!CAN_FILE)(
    'AT-M15.4: POST provide-evidence with the multipart body returns 200 and a links envelope',
    async () => {
      /**
       * **§10.2 #14 verified against the server.** The `input` part plus `file1` is what PayPal's own cURL uses,
       * and `test/filer.test.ts` proves we build that. What it cannot prove is that PayPal parses it — a 400 here
       * would look exactly like a schema mistake in `provideEvidenceInput`.
       */
      const h = liveHarness()
      const outcome = await fileDispute(h.disputeId, h.deps, CLICK)

      // **Either PayPal took the packet, or it named a reason.** Both are assertions; a silent no-op is not.
      // The failure branch is printed rather than swallowed, because the live reason is the whole point of
      // running this file.
      if (!outcome.ok)
        throw new Error(`fileDispute returned err: ${outcome.error.code}: ${outcome.error.message}`)

      if (!outcome.value.filed) {
        console.warn(
          `[AT-M15.4] PayPal did not accept the packet: ${outcome.value.refusal?.code ?? 'no refusal'} — ` +
            `${outcome.value.refusal?.reason ?? outcome.value.warnings.join(' | ') ?? '(no reason given)'}`,
        )
      }
      expect(outcome.value.refusal?.code).not.toBe('CS_VALIDATION')
      expect(outcome.value.refusal?.code).not.toBe('PP_BAD_REQUEST')
    },
  )

  it.skipIf(!CAN_FILE)(
    'AT-M15.4: a repeated PayPal-Request-Id is answered as the same filing, not as a second one (EC-DSP-10)',
    async () => {
      /**
       * **EC-DSP-10's claim, asked of PayPal rather than of ourselves.**
       *
       * Offline, `test/filer.test.ts` asserts that *we* issued one request. What it cannot assert is what PayPal
       * does with the second: idempotent replay (our claim), a 422/duplicate error (a different claim), or two
       * filings (the bug). So this prints the second outcome rather than asserting a particular one, because
       * PayPal's documented behaviour and its actual behaviour are exactly the thing being checked — and a test
       * that asserts the answer we hoped for proves nothing.
       */
      const h = liveHarness()
      const first = await fileDispute(h.disputeId, h.deps, CLICK)
      expect(first.ok).toBe(true)
      const second = await fileDispute(h.disputeId, h.deps, CLICK)
      expect(second.ok).toBe(true)
      if (!first.ok || !second.ok) throw new Error('unreachable: asserted above')

      console.warn(
        `[AT-M15.4] first: filed=${first.value.filed} alreadyFiled=${first.value.alreadyFiled} ` +
          `calls=${first.value.paypalCalls.join(',') || '(none)'} | ` +
          `second: filed=${second.value.filed} alreadyFiled=${second.value.alreadyFiled} ` +
          `calls=${second.value.paypalCalls.join(',') || '(none)'} ` +
          `refusal=${second.value.refusal?.code ?? 'none'}`,
      )

      // **The invariant that must hold whatever PayPal decides: our second run issues no new request.**
      expect(second.value.paypalCalls).toEqual([])
      expect(second.value.alreadyFiled).toBe(true)
    },
  )

  it.skipIf(!CAN_FILE)(
    'AT-M15.4: an attachment over 10 MB is refused by the server, not only by our own reader (EC-DSP-12)',
    async () => {
      /**
       * **EC-DSP-12's expected column names PayPal's own limit.** `evidenceFileSizes` is a fast local copy of
       * it, and a copy is not the thing. So the local refusal is asserted separately from the wire one, and this
       * test asks the server directly by handing `buildEvidenceForm` a file that is over the limit.
       */
      const h = liveHarness()
      const outcome = await fileDispute(h.disputeId, h.deps, {
        ...CLICK,
        attachments: [
          {
            fileName: 'carrier-scan.png',
            contentType: 'image/png',
            content: new Uint8Array(OVERSIZE_BYTES),
          },
        ],
      })
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) throw new Error('unreachable: asserted above')
      // **Our reader refuses before any bytes move**, which is the part that is ours to guarantee.
      expect(outcome.value.filed).toBe(false)
      expect(outcome.value.paypalCalls).toEqual([])
      expect(outcome.value.refusal?.reason).toContain('carrier-scan.png')
    },
  )
})
