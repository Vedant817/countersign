/**
 * Customer Disputes v1 — spec §10.2 #13–17, [V3] [B16], §12.11, §8.16.
 *
 * The fields asserted here are the ones the Defender routes on: `dispute_state`,
 * `dispute_life_cycle_stage`, `status`, `reason`, `seller_response_due_date`,
 * `adjudication_outcome` and `require_evidence.action`.
 *
 * Field names follow the verified OpenAPI (verification report §11), not the pre-audit guesses:
 * `reason` (not `dispute_reason`), `dispute_amount` (not `disputed_amount`),
 * `disputed_transactions[]` for the capture join (not top-level `seller_transaction_id`),
 * `evidences[]` (not `evidence`) and `messages[].posted_by` (not `.sender`).
 */
import { describe, expect, it } from 'vitest'

import { createLogger } from '@countersign/core'

import { PayPalClient } from '../src/client'
import {
  DISPUTE_REASONS,
  DISPUTE_STATES,
  DISPUTE_STATUSES,
  EVIDENCE_TYPES,
  OFFER_TYPES,
  WEBHOOK_EVENT_NAMES,
  disputeCaptureId,
  isAppealable,
} from '../src/types'
import type { PaypalLink } from '../src/types'
import {
  capturingLogger,
  disputeListResponse,
  disputeResponse,
  fakeFetch,
  headerOf,
  jsonBody,
  linksResponse,
  paypalErrorResponse,
  ppMoney,
  rateLimitedResponse,
  recordingSleep,
  testClock,
  tokenResponse,
  verifyWebhookResponse,
} from './fixtures/transport-double'
import type { RecordedCall, Stub } from './fixtures/transport-double'

const BASE_URL = 'https://api-m.sandbox.paypal.com'
const DISPUTE_ID = 'PP-D-2781AB12CD34'
const CAPTURE_ID = '3C679366HH908993F'
const WEBHOOK_ID = '1AB23456CD789012E'

function makeClient(responder: Stub) {
  const fetchImpl = fakeFetch(responder)
  const client = new PayPalClient({
    baseUrl: BASE_URL,
    clientId: 'AY_FAKE_SANDBOX_CLIENT_ID_00000000',
    clientSecret: 'EL_FAKE_SANDBOX_SECRET_00000000',
    clock: testClock(),
    fetchImpl,
    sleep: recordingSleep().sleep,
    logger: createLogger({ level: 'error', sink: capturingLogger().sink }),
    env: { PAYPAL_ENV: 'sandbox', PAYPAL_API_BASE: BASE_URL },
  })
  return { client, fetchImpl }
}

const isToken = (c: RecordedCall) => c.url.endsWith('/v1/oauth2/token')
const callTo = (calls: readonly RecordedCall[], fragment: string) =>
  calls.find((c) => c.url.includes(fragment)) as RecordedCall

describe('listDisputes (§10.2 #13)', () => {
  it('GETs the list with the query string the reconciler uses', async () => {
    const { client, fetchImpl } = makeClient((call) =>
      isToken(call) ? tokenResponse() : disputeListResponse(2),
    )
    const result = await client.listDisputes({
      start_time: '2026-10-04T00:00:00Z',
      dispute_state: 'REQUIRED_ACTION',
      page_size: 25,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.items).toHaveLength(2)

    const call = callTo(fetchImpl.calls, '/v1/customer/disputes')
    expect(call.url).toContain('start_time=2026-10-04T00%3A00%3A00Z')
    expect(call.url).toContain('dispute_state=REQUIRED_ACTION')
    expect(call.url).toContain('page_size=25')
  })

  it('forwards the three parameters the audit added and never sends `page`', async () => {
    // Report §10: `disputed_transaction_id` / `update_time_before` / `update_time_after` are real;
    // `page` is not a PayPal parameter at all and was silently ignored.
    const { client, fetchImpl } = makeClient((call) =>
      isToken(call) ? tokenResponse() : disputeListResponse(1),
    )
    const result = await client.listDisputes({
      disputed_transaction_id: '3C679366HH908993F',
      update_time_after: '2026-09-04T00:00:00Z',
      update_time_before: '2026-10-04T00:00:00Z',
    })
    expect(result.ok).toBe(true)
    const call = callTo(fetchImpl.calls, '/v1/customer/disputes')
    expect(call.url).toContain('disputed_transaction_id=3C679366HH908993F')
    expect(call.url).toContain('update_time_after=')
    expect(call.url).toContain('update_time_before=')
    expect(call.url).not.toContain('page=')
  })

  it('refuses a page_size PayPal would reject (its documented maximum is 50)', async () => {
    // Report §10/#9: the old cap of 500 let 51-500 through, which is a likely 400 from PayPal.
    const { client, fetchImpl } = makeClient(tokenResponse())
    const refused = await client.listDisputes({ page_size: 51 })
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error.code).toBe('CS_VALIDATION')
    expect((await client.listDisputes({ page_size: 50 })).ok).toBe(true)
    expect(fetchImpl.calls.filter((c) => c.url.includes('page_size=50'))).toHaveLength(1)
  })

  it('defaults items to an empty array so the 2-minute reconciler never crashes', async () => {
    const { client } = makeClient((call) =>
      isToken(call) ? tokenResponse() : { status: 200, body: {} },
    )
    const result = await client.listDisputes({})
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.items).toEqual([])
  })

  it('parses each dispute into the fields the router reads', async () => {
    const { client } = makeClient((call) =>
      isToken(call) ? tokenResponse() : disputeListResponse(1),
    )
    const result = await client.listDisputes({})
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const d = result.value.items[0]
    expect(d?.dispute_id).toBeDefined()
    // The field is `reason`; `dispute_reason` never existed on a Dispute (report §11).
    expect(d?.reason).toBe('UNAUTHORISED')
    expect(d?.dispute_life_cycle_stage).toBe('CHARGEBACK')
    expect(d?.seller_response_due_date).toBe('2026-10-11T09:59:59Z')
    expect(d?.dispute_amount?.value).toBe('48.00')
  })

  it('joins a dispute to our capture through disputed_transactions[0].seller_transaction_id', async () => {
    // The mapping the Dispute Defender depends on (report §5/#5): PayPal puts both transaction ids
    // INSIDE `disputed_transactions[]`, so a top-level read can never succeed against a real
    // response and the join was silently always `undefined`.
    const { client } = makeClient((call) =>
      isToken(call) ? tokenResponse() : disputeListResponse(1),
    )
    const result = await client.listDisputes({})
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const disputes = result.value.items.filter((d) => disputeCaptureId(d) === CAPTURE_ID)
    expect(disputes).toHaveLength(1)
    const matched = disputes[0]
    expect(matched?.disputed_transactions?.[0]?.buyer_transaction_id).toBe('7XQ12345AB6789123')
    expect(matched?.['seller_transaction_id']).toBeUndefined()
  })

  it('RATE_LIMIT_REACHED → PP_RATE_LIMITED, retryable', async () => {
    const { client } = makeClient((call) =>
      isToken(call) ? tokenResponse() : rateLimitedResponse(1),
    )
    const result = await client.listDisputes({})
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('PP_RATE_LIMITED')
    expect(result.error.retryable).toBe(true)
    // EC-PP-2: the reconciler throttles itself from this, so the header must survive.
    expect(result.error.details?.['retry_after']).toBe('1')
  })
})

describe('getDispute', () => {
  it('returns the deadline as the RFC 3339 string it arrived as', async () => {
    // EC-TIME-6: stored UTC, rendered IST at the edge. Converting here would move the deadline.
    const { client } = makeClient((call) =>
      isToken(call) ? tokenResponse() : disputeResponse({ dueDate: '2026-10-11T09:59:59Z' }),
    )
    const result = await client.getDispute(DISPUTE_ID)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.seller_response_due_date).toBe('2026-10-11T09:59:59Z')
    expect(result.value.require_evidence?.action).toBe('SELLER_EVIDENCE')
  })

  it('accepts an unknown dispute_state instead of failing the whole read', async () => {
    // A zod enum here would turn a PayPal-side addition into a dead reconciler.
    const { client } = makeClient((call) =>
      isToken(call) ? tokenResponse() : disputeResponse({ state: 'SOMETHING_NEW' }),
    )
    const result = await client.getDispute(DISPUTE_ID)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.dispute_state).toBe('SOMETHING_NEW')
  })

  it('reads `evidences` (plural) with string notes, and `messages[].posted_by`', async () => {
    // Report §4/#4 and §5/#5: `evidence` was never the field and `notes` was never an array; the
    // message author field is `posted_by`, not `sender`.
    const { client } = makeClient((call) =>
      isToken(call) ? tokenResponse() : disputeResponse({ notes: 'Tracking attached.' }),
    )
    const result = await client.getDispute(DISPUTE_ID)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value['evidence']).toBeUndefined()
    const evidence = result.value.evidences?.[0]
    expect(evidence?.evidence_type).toBe('PROOF_OF_FULFILLMENT')
    expect(evidence?.notes).toBe('Tracking attached.')
    expect(evidence?.evidence_info).toMatchObject({
      tracking_info: [{ carrier_name: 'UPS', tracking_number: '1Z999AA10123456784' }],
    })
    expect(result.value.messages?.[0]?.posted_by).toBe('SELLER')
    expect(result.value.messages?.[0]?.['sender']).toBeUndefined()
  })

  it('exposes the allowed_response_options that decide which actions are offered', async () => {
    // Report §11: this is the discovery endpoint for accept-claim / make-offer /
    // acknowledge-return-item, so a caller never has to guess which acknowledgement types apply.
    const { client } = makeClient((call) => (isToken(call) ? tokenResponse() : disputeResponse()))
    const result = await client.getDispute(DISPUTE_ID)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(
      result.value.allowed_response_options?.acknowledge_return_item?.acknowledgement_types,
    ).toContain('ITEM_RECEIVED')
    expect(result.value.allowed_response_options?.accept_claim?.accept_claim_types).toContain(
      'PARTIAL_REFUND',
    )
    expect(result.value.allowed_response_options?.make_offer?.offer_types).toContain(
      'REFUND_WITH_RETURN',
    )
  })

  it('404 → PP_NOT_FOUND (EC-DSP-9 / EC-WH-6: a foreign transaction)', async () => {
    const { client } = makeClient((call) =>
      isToken(call) ? tokenResponse() : { status: 404, body: { name: 'RESOURCE_NOT_FOUND' } },
    )
    const result = await client.getDispute(DISPUTE_ID)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('PP_NOT_FOUND')
  })

  it('exports the known state and status sets it branches on', () => {
    // §8.15 filing guard: `status === 'WAITING_FOR_SELLER_RESPONSE'` — that is a **status**, not a
    // dispute_state, which is why the two lists must not be merged.
    expect(DISPUTE_STATUSES).toContain('WAITING_FOR_SELLER_RESPONSE')
    expect(DISPUTE_STATES).not.toContain('WAITING_FOR_SELLER_RESPONSE')
    // §8.16: APPEALABLE is a real dispute_state. Eligibility, though, is the HATEOAS link.
    expect(DISPUTE_STATES).toContain('APPEALABLE')
  })

  it("DISPUTE_STATES is exactly PayPal's six documented values", () => {
    // Report §6/#6: five of the previous ten could never match a real `dispute_state`, because they
    // were `status` values or invented.
    expect([...DISPUTE_STATES].sort()).toEqual(
      [
        'APPEALABLE',
        'OPEN_INQUIRIES',
        'REQUIRED_ACTION',
        'REQUIRED_OTHER_PARTY_ACTION',
        'RESOLVED',
        'UNDER_PAYPAL_REVIEW',
      ].sort(),
    )
  })

  it("DISPUTE_REASONS is exactly PayPal's ten documented values", () => {
    // Report §7/#7: drop the five that do not exist, add the two that were missing.
    expect([...DISPUTE_REASONS].sort()).toEqual(
      [
        'CANCELED_RECURRING_BILLING',
        'CREDIT_NOT_PROCESSED',
        'DUPLICATE_TRANSACTION',
        'INCORRECT_AMOUNT',
        'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
        'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
        'OTHER',
        'PAYMENT_BY_OTHER_MEANS',
        'PROBLEM_WITH_REMITTANCE',
        'UNAUTHORISED',
      ].sort(),
    )
    for (const invented of [
      'MERCHANDISE_OR_SERVICE_NOT_RECEIVED_2',
      'REFUND_NOT_AS_DESCRIBED',
      'PAYOUT_DECLINED',
      'ACCOUNT_COMPROMISED',
      'UNPAID_AMOUNT',
    ]) {
      expect(DISPUTE_REASONS as readonly string[]).not.toContain(invented)
    }
    // The two the audit found missing — both are real PayPal values.
    expect(DISPUTE_REASONS).toContain('PAYMENT_BY_OTHER_MEANS')
    expect(DISPUTE_REASONS).toContain('PROBLEM_WITH_REMITTANCE')
  })

  it('EVIDENCE_TYPES contains only real evidence_type values', () => {
    // Report §8/#8: seven of the previous values are not in PayPal's 76-value enum.
    expect([...EVIDENCE_TYPES].sort()).toEqual(
      [
        'DETAILS_OF_PURCHASE',
        'ITEM_DESCRIPTION',
        'ONLINE_TRACKING_INFORMATION',
        'ORDER_DETAILS',
        'OTHER',
        'PROOF_OF_FULFILLMENT',
        'PROOF_OF_RECEIPT_COPY',
        'PROOF_OF_REFUND',
        'PROOF_OF_RETURN',
      ].sort(),
    )
    for (const invented of [
      'CHECKOUT_PAGE',
      'CANCELLED_RECURING_BILLING_AGREEMENT',
      'CUSTOMER_COMMUNICATION',
      'FULFILLMENT_DOCUMENTATION',
      'REFUND_POLICY',
      'TERMS_OF_SERVICE',
      'UNCONTROLLED_WEB_CONTENT',
    ]) {
      expect(EVIDENCE_TYPES as readonly string[]).not.toContain(invented)
    }
  })

  it('every value spec §8.15 relies on is in EVIDENCE_TYPES', () => {
    // The seven the evidence plan names; all confirmed against the real 76-value enum.
    for (const required of [
      'PROOF_OF_FULFILLMENT',
      'PROOF_OF_REFUND',
      'DETAILS_OF_PURCHASE',
      'ONLINE_TRACKING_INFORMATION',
      'ORDER_DETAILS',
      'ITEM_DESCRIPTION',
      'PROOF_OF_RECEIPT_COPY',
    ]) {
      expect(EVIDENCE_TYPES as readonly string[]).toContain(required)
    }
  })
})

describe('appeal eligibility is the HATEOAS link, not dispute_state (§8.16, report §9/#17)', () => {
  it('is appealable when PayPal offers the `appeal` link', () => {
    const spec = disputeResponse({ state: 'APPEALABLE' }).body as { links: PaypalLink[] }
    expect(isAppealable({ links: spec.links, dispute_state: 'APPEALABLE' })).toBe(true)
  })

  it('is NOT appealable without the link, even when dispute_state says APPEALABLE', () => {
    // The reason the gate changed: `SPEC-D` says "If this link does not appear, you cannot appeal
    // the dispute", so a state-only check would offer an appeal PayPal refuses.
    expect(isAppealable({ links: [{ href: 'x', rel: 'self' }], dispute_state: 'APPEALABLE' })).toBe(
      false,
    )
  })

  it('refuses the appeal before posting when the link is absent', async () => {
    const { client, fetchImpl } = makeClient((call) =>
      isToken(call) ? tokenResponse() : disputeResponse({ state: 'APPEALABLE', appealable: false }),
    )
    const result = await client.appeal(
      DISPUTE_ID,
      { evidences: [{ evidence_type: 'PROOF_OF_FULFILLMENT' }] },
      [],
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_VALIDATION')
    expect(result.error.message).toContain('appeal')
    // The appeal POST never happened: only the token call and the GET that produced the link list.
    expect(fetchImpl.calls.filter((c) => c.url.includes('/appeal'))).toHaveLength(0)
  })

  it('posts the appeal once the link is present', async () => {
    const { client, fetchImpl } = makeClient((call) =>
      isToken(call)
        ? tokenResponse()
        : call.url.includes('/appeal')
          ? linksResponse()
          : disputeResponse(),
    )
    const result = await client.appeal(
      DISPUTE_ID,
      { evidences: [{ evidence_type: 'PROOF_OF_FULFILLMENT', notes: 'Label attached.' }] },
      [],
      { requestId: `cs:${DISPUTE_ID}:appeal:1` },
    )
    expect(result.ok).toBe(true)
    expect(
      fetchImpl.calls.filter((c) => c.url.includes('/appeal') && c.method === 'POST'),
    ).toHaveLength(1)
  })
})

describe('acceptClaim (§10.2 #15)', () => {
  it('POSTs accept_claim_type', async () => {
    const { client, fetchImpl } = makeClient((call) =>
      isToken(call) ? tokenResponse() : linksResponse(),
    )
    // A real value from SPEC-D's `accept_claim_type`: REFUND / REFUND_WITH_RETURN / PARTIAL_REFUND /
    // REFUND_WITH_RETURN_SHIPMENT_LABEL. The old test used `REFUND_NO_RETURN`, which is a make-offer
    // value that does not exist anywhere (report §3/#10).
    const result = await client.acceptClaim(DISPUTE_ID, { accept_claim_type: 'PARTIAL_REFUND' })
    expect(result.ok).toBe(true)
    const call = callTo(fetchImpl.calls, '/accept-claim')
    expect(jsonBody<Record<string, unknown>>(call)).toEqual({ accept_claim_type: 'PARTIAL_REFUND' })
  })

  it('still returns a Links when the endpoint answers 204 with no body', async () => {
    // Report §3: every documented dispute action answers 200-with-links; the 204 tolerance stays
    // only because `void` and the payment-token DELETE genuinely answer 204.
    const { client } = makeClient((call) => (isToken(call) ? tokenResponse() : { status: 204 }))
    const result = await client.acceptClaim(DISPUTE_ID, { accept_claim_type: 'REFUND' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.links).toEqual([])
  })

  it('refuses a claim with no type', async () => {
    const { client, fetchImpl } = makeClient(tokenResponse())
    const result = await client.acceptClaim(DISPUTE_ID, {} as { accept_claim_type: string })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_VALIDATION')
    expect(fetchImpl.calls).toHaveLength(0)
  })
})

describe('makeOffer (§10.2 #15, EC-BUY-1)', () => {
  it('POSTs the offer amount as a decimal string, with the now-required note', async () => {
    const { client, fetchImpl } = makeClient((call) =>
      isToken(call) ? tokenResponse() : linksResponse(),
    )
    const result = await client.makeOffer(DISPUTE_ID, {
      offer_amount: ppMoney('35.66'),
      // EC-BUY-1: a return costs the merchant less than an $82 MRC fee.
      offer_type: 'REFUND_WITH_RETURN',
      // PayPal requires this for REFUND_WITH_RETURN (report §4/#10).
      return_shipping_address: { line1: '12 Leary Lane', city: 'Cambridge', country_code: 'US' },
      terms: 'Return the item within 14 days for a full refund.',
      note: 'We can offer a partial refund with a return.',
    })
    expect(result.ok).toBe(true)
    const call = callTo(fetchImpl.calls, '/make-offer')
    expect(jsonBody<Record<string, unknown>>(call)).toEqual({
      offer_amount: { currency_code: 'USD', value: '35.66' },
      offer_type: 'REFUND_WITH_RETURN',
      return_shipping_address: { line1: '12 Leary Lane', city: 'Cambridge', country_code: 'US' },
      terms: 'Return the item within 14 days for a full refund.',
      note: 'We can offer a partial refund with a return.',
    })
  })

  it('accepts a REPLACEMENT_WITHOUT_REFUND offer with no amount at all', async () => {
    // Report §4/#10: `offer_amount` is NOT required by PayPal — omit it for a replacement.
    const { client, fetchImpl } = makeClient((call) =>
      isToken(call) ? tokenResponse() : linksResponse(),
    )
    const result = await client.makeOffer(DISPUTE_ID, {
      offer_type: 'REPLACEMENT_WITHOUT_REFUND',
      note: 'We will ship a replacement pair at no charge.',
    })
    expect(result.ok).toBe(true)
    const body = jsonBody<Record<string, unknown>>(callTo(fetchImpl.calls, '/make-offer'))
    expect(body['offer_amount']).toBeUndefined()
    expect(body['offer_type']).toBe('REPLACEMENT_WITHOUT_REFUND')
  })

  it('refuses an offer with no note or no type', async () => {
    const { client, fetchImpl } = makeClient(tokenResponse())
    const noNote = await client.makeOffer(
      DISPUTE_ID,
      // @ts-expect-error note is required by PayPal (1-2000 chars).
      { offer_type: 'REFUND_WITH_RETURN', offer_amount: ppMoney('1.00') },
    )
    const noType = await client.makeOffer(
      DISPUTE_ID,
      // @ts-expect-error offer_type is required by the API.
      { note: 'sorry', offer_amount: ppMoney('1.00') },
    )
    expect(noNote.ok).toBe(false)
    expect(noType.ok).toBe(false)
    expect(fetchImpl.calls).toHaveLength(0)
  })

  it('refuses a float offer amount', async () => {
    const { client } = makeClient(tokenResponse())
    const result = await client.makeOffer(DISPUTE_ID, {
      // @ts-expect-error money is a decimal string, never a JS number.
      offer_amount: { currency_code: 'USD', value: 35.66 },
      offer_type: 'REFUND_WITH_RETURN',
      note: 'partial refund',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_VALIDATION')
  })

  it('never sends REFUND_NO_RETURN, which is not a PayPal offer_type', () => {
    // The comment in `types.ts` used to advertise this value; the enum has four members and it is
    // not one of them.
    expect(OFFER_TYPES).toContain('REFUND_WITH_RETURN')
    expect(OFFER_TYPES).toContain('REPLACEMENT_WITHOUT_REFUND')
    expect(OFFER_TYPES as readonly string[]).not.toContain('REFUND_NO_RETURN')
    expect([...OFFER_TYPES].sort()).toEqual(
      [
        'REFUND',
        'REFUND_WITH_REPLACEMENT',
        'REFUND_WITH_RETURN',
        'REPLACEMENT_WITHOUT_REFUND',
      ].sort(),
    )
  })
})

describe('sendMessage, acknowledgeReturnItem, escalate (§10.2 #16)', () => {
  it('sendMessage posts the message', async () => {
    const { client, fetchImpl } = makeClient((call) =>
      isToken(call) ? tokenResponse() : linksResponse(),
    )
    const result = await client.sendMessage(DISPUTE_ID, 'We have shipped; tracking is inside.')
    expect(result.ok).toBe(true)
    const call = callTo(fetchImpl.calls, '/send-message')
    expect(jsonBody<Record<string, unknown>>(call)).toEqual({
      message: 'We have shipped; tracking is inside.',
    })
    expect(headerOf(call, 'content-type')).toBe('application/json')
  })

  it('sendMessage refuses an empty message rather than posting a blank', async () => {
    const { client, fetchImpl } = makeClient(tokenResponse())
    const result = await client.sendMessage(DISPUTE_ID, '   ')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_VALIDATION')
    expect(fetchImpl.calls).toHaveLength(0)
  })

  it('acknowledgeReturnItem posts {note, acknowledgement_type}, not a shipping address', async () => {
    // Report §6/#11: `return_shipping_address` is a make-offer field; this body is
    // `{note, acknowledgement_type}`.
    const { client, fetchImpl } = makeClient((call) =>
      isToken(call) ? tokenResponse() : linksResponse(),
    )
    const result = await client.acknowledgeReturnItem(DISPUTE_ID, {
      note: 'Return received, refunding today.',
      acknowledgement_type: 'ITEM_RECEIVED',
    })
    expect(result.ok).toBe(true)
    const body = jsonBody<Record<string, unknown>>(
      callTo(fetchImpl.calls, '/acknowledge-return-item'),
    )
    expect(body).toEqual({
      note: 'Return received, refunding today.',
      acknowledgement_type: 'ITEM_RECEIVED',
    })
    expect(body['return_shipping_address']).toBeUndefined()
  })

  it('acknowledgeReturnItem refuses a body with no acknowledgement_type', async () => {
    const { client, fetchImpl } = makeClient(tokenResponse())
    const result = await client.acknowledgeReturnItem(DISPUTE_ID, { note: 'got it' } as unknown as {
      acknowledgement_type: string
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_VALIDATION')
    expect(fetchImpl.calls).toHaveLength(0)
  })

  it('escalate posts the note', async () => {
    const { client, fetchImpl } = makeClient((call) =>
      isToken(call) ? tokenResponse() : linksResponse(),
    )
    const result = await client.escalate(
      DISPUTE_ID,
      'Escalating: tracking confirms delivery on 1 Oct.',
    )
    expect(result.ok).toBe(true)
    expect(jsonBody<Record<string, unknown>>(callTo(fetchImpl.calls, '/escalate'))).toEqual({
      note: 'Escalating: tracking confirms delivery on 1 Oct.',
    })
  })

  it('escalate refuses an empty note', async () => {
    const { client } = makeClient(tokenResponse())
    const result = await client.escalate(DISPUTE_ID, '')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_VALIDATION')
  })
})

describe('provideSupportingInfo (§10.2 #16)', () => {
  it('posts the notes as the multipart input part', async () => {
    const { client, fetchImpl } = makeClient((call) =>
      isToken(call) ? tokenResponse() : linksResponse(),
    )
    const result = await client.provideSupportingInfo(DISPUTE_ID, 'Carrier scan attached.', [])
    expect(result.ok).toBe(true)
    const call = callTo(fetchImpl.calls, '/provide-supporting-info')
    expect(call.body).toBeInstanceOf(FormData)
    expect(headerOf(call, 'content-type')).toBeUndefined()
  })

  it('refuses empty notes', async () => {
    const { client, fetchImpl } = makeClient(tokenResponse())
    const result = await client.provideSupportingInfo(DISPUTE_ID, '', [])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_VALIDATION')
    expect(fetchImpl.calls).toHaveLength(0)
  })
})

describe('wrong-state handling', () => {
  it('a PayPal "not allowed in this state" is PP_UNPROCESSABLE, and the Defender decides', async () => {
    // §8.15 DEF_WRONG_STATE is a *local* decision (M15); M6's job is to surface PayPal's rejection
    // faithfully rather than invent a state machine of its own.
    const { client } = makeClient((call) =>
      isToken(call)
        ? tokenResponse()
        : paypalErrorResponse('DISPUTE_STATE_NOT_ALLOWED', 'DISPUTE_STATE_NOT_ALLOWED', 422),
    )
    const result = await client.provideEvidence(
      DISPUTE_ID,
      {
        evidences: [{ evidence_type: 'PROOF_OF_FULFILLMENT', notes: 'Tracking attached.' }],
      },
      [],
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('PP_UNPROCESSABLE')
    expect(result.error.details?.['issue']).toBe('DISPUTE_STATE_NOT_ALLOWED')
    expect(result.error.retryable).toBe(false)
  })
})

describe('webhook event names (report §26/#14)', () => {
  it('never names PAYMENT.REFUND.COMPLETED, because no such event exists', () => {
    // The refund set is `PAYMENT.REFUND.{PENDING, FAILED}`; refund *completion* is
    // `PAYMENT.CAPTURE.REFUNDED`. A subscription for the invented name never fires.
    expect(WEBHOOK_EVENT_NAMES as readonly string[]).not.toContain('PAYMENT.REFUND.COMPLETED')
    expect(WEBHOOK_EVENT_NAMES).toContain('PAYMENT.CAPTURE.REFUNDED')
    expect(WEBHOOK_EVENT_NAMES).toContain('PAYMENT.REFUND.PENDING')
    expect(WEBHOOK_EVENT_NAMES).toContain('PAYMENT.REFUND.FAILED')
  })

  it('subscribes PAYMENT.CAPTURE.DENIED, which is a real event distinct from DECLINED', () => {
    // PayPal recommends it for the checkout flow: "Listen for this webhook and then cancel
    // fulfilling the order."
    expect(WEBHOOK_EVENT_NAMES).toContain('PAYMENT.CAPTURE.DENIED')
    expect(WEBHOOK_EVENT_NAMES).toContain('PAYMENT.CAPTURE.DECLINED')
  })

  it('holds no PAYMENT.AUTHORIZATION.EXPIRED, so EC-TIME-5 cannot be webhook-driven', () => {
    // There is no such event. Authorization-expiry alerting has to poll
    // `GET /v2/payments/authorizations/{id}` and compare `expiration_time`.
    expect(WEBHOOK_EVENT_NAMES as readonly string[]).not.toContain('PAYMENT.AUTHORIZATION.EXPIRED')
    expect(WEBHOOK_EVENT_NAMES).toContain('PAYMENT.AUTHORIZATION.CREATED')
    expect(WEBHOOK_EVENT_NAMES).toContain('PAYMENT.AUTHORIZATION.VOIDED')
  })
})

describe('verifyWebhookSignature (§10.2 #12, [V14], EC-WH-4)', () => {
  const headers = {
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-cert-url': 'https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42',
    'paypal-transmission-id': 'b1c2d3e4-0000-1111-2222-333344445555',
    'paypal-transmission-sig': 'abcDEF123==',
    'paypal-transmission-time': '2026-10-04T12:00:00Z',
  }
  const event = {
    id: 'WH-1',
    event_type: 'PAYMENT.CAPTURE.COMPLETED',
    resource: { id: CAPTURE_ID },
  }

  it('SUCCESS for a verified event', async () => {
    const { client } = makeClient((call) =>
      isToken(call) ? tokenResponse() : verifyWebhookResponse('SUCCESS'),
    )
    const result = await client.verifyWebhookSignature(headers, WEBHOOK_ID, event)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe('SUCCESS')
  })

  it('FAILURE for a forged event', async () => {
    const { client } = makeClient((call) =>
      isToken(call) ? tokenResponse() : verifyWebhookResponse('FAILURE'),
    )
    const result = await client.verifyWebhookSignature(headers, WEBHOOK_ID, event)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe('FAILURE')
  })

  it('fails closed on a status we have never seen', async () => {
    // A permissive default for an unknown value would make this a no-op rather than a check.
    const { client } = makeClient((call) =>
      isToken(call) ? tokenResponse() : verifyWebhookResponse('SOMETHING_NEW'),
    )
    const result = await client.verifyWebhookSignature(headers, WEBHOOK_ID, event)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe('FAILURE')
  })

  it('sends the transmission headers under their documented field names', async () => {
    const { client, fetchImpl } = makeClient((call) =>
      isToken(call) ? tokenResponse() : verifyWebhookResponse('SUCCESS'),
    )
    await client.verifyWebhookSignature(headers, WEBHOOK_ID, event)
    const body = jsonBody<Record<string, unknown>>(
      callTo(fetchImpl.calls, 'verify-webhook-signature'),
    )
    expect(body['auth_algo']).toBe('SHA256withRSA')
    expect(body['cert_url']).toBe(headers['paypal-cert-url'])
    expect(body['transmission_id']).toBe(headers['paypal-transmission-id'])
    expect(body['transmission_sig']).toBe(headers['paypal-transmission-sig'])
    expect(body['transmission_time']).toBe(headers['paypal-transmission-time'])
    expect(body['webhook_id']).toBe(WEBHOOK_ID)
    expect(body['webhook_event']).toEqual(event)
  })

  it('accepts the raw request body as a string, since the route reads it raw (§8.12)', async () => {
    const { client, fetchImpl } = makeClient((call) =>
      isToken(call) ? tokenResponse() : verifyWebhookResponse('SUCCESS'),
    )
    const result = await client.verifyWebhookSignature(headers, WEBHOOK_ID, JSON.stringify(event))
    expect(result.ok).toBe(true)
    const body = jsonBody<Record<string, unknown>>(
      callTo(fetchImpl.calls, 'verify-webhook-signature'),
    )
    expect(body['webhook_event']).toEqual(event)
  })

  it('refuses a body that is not JSON rather than sending garbage', async () => {
    const { client, fetchImpl } = makeClient(tokenResponse())
    const result = await client.verifyWebhookSignature(headers, WEBHOOK_ID, '{not json')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_VALIDATION')
    expect(fetchImpl.calls).toHaveLength(0)
  })

  it('refuses a missing webhook id', async () => {
    const { client } = makeClient(tokenResponse())
    const result = await client.verifyWebhookSignature(headers, '', event)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_VALIDATION')
  })
})
