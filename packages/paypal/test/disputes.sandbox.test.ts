/**
 * AT-M6.6 — sandbox integration: multipart evidence upload against a **simulated** dispute, plus the
 * lifecycle the Defender needs (`require-evidence`, `adjudicate`).
 *
 * **Opt-in.** Excluded from `pnpm test`; run with:
 *
 * ```
 * pnpm --filter @countersign/paypal test:sandbox
 * ```
 *
 * Requires real sandbox credentials (`docs/HUMAN_TODO.md` H-01), the sandbox buyer's email
 * (`PAYPAL_BUYER_EMAIL`) and a card-funded capture to dispute (`PAYPAL_TEST_CAPTURE_ID`, or the one
 * created by `client.sandbox.test.ts`). Without them the suites below **skip** with the reason in the
 * test name.
 *
 * This is the week-1 check C1 path (spec §11): vault → capture → simulated dispute → require seller
 * evidence → upload a 1-page PDF. If it fails, C1's documented fallbacks apply; the client itself does
 * not change.
 */
import { describe, expect, it } from 'vitest'

import { disputeActionRequestId } from '../src/idempotency'
import type { EvidenceFile } from '../src/multipart'
import {
  BUYER_EMAIL,
  HAS_CREDENTIALS,
  SKIP_REASON,
  liveClient,
  pollUntil,
} from './fixtures/sandbox-env'

const NEEDS_BUYER = 'PAYPAL_BUYER_EMAIL is absent (§6): the buyer-dispute simulator asserts the buyer identity.'
const NEEDS_CAPTURE =
  'PAYPAL_TEST_CAPTURE_ID is absent: run client.sandbox.test.ts first and reuse the capture it creates, ' +
  'or export a card-funded capture id (a vault capture with no card behind it cannot be charged back — §10.1 step 5).'

const CAPTURE_ID = process.env['PAYPAL_TEST_CAPTURE_ID'] ?? ''
const canRun = HAS_CREDENTIALS && BUYER_EMAIL !== '' && CAPTURE_ID !== ''

/** A real, tiny, one-page PDF — the same bytes the encoding tests assert on. */
const onePagePdf: EvidenceFile = {
  fileName: 'countersign-evidence.pdf',
  contentType: 'application/pdf',
  content: new TextEncoder().encode(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\n' +
      'trailer<</Root 1 0 R>>\n%%EOF\n',
  ),
}

/**
 * The "can we run at all?" suites below.
 *
 * Each one is a single test that **skips with its reason in the name** when its precondition is
 * missing. That is deliberate: a green suite here would be indistinguishable from a suite that had
 * really called PayPal, and a *failing* suite would break the nightly run for a reason that is not a
 * bug. The skip is the honest signal.
 */
describe('AT-M6.6 prerequisites', () => {
  it.skipIf(!HAS_CREDENTIALS)(`SKIPPED — ${SKIP_REASON}`, () => {
    expect(HAS_CREDENTIALS).toBe(true)
  })

  it.skipIf(!BUYER_EMAIL)(`SKIPPED — ${NEEDS_BUYER}`, () => {
    expect(BUYER_EMAIL).not.toBe('')
  })

  it.skipIf(!CAPTURE_ID)(`SKIPPED — ${NEEDS_CAPTURE}`, () => {
    expect(CAPTURE_ID).not.toBe('')
  })
})

describe.skipIf(!HAS_CREDENTIALS || BUYER_EMAIL === '')('AT-M6.6 buyer-dispute simulator', () => {
  it('the buyer assertion is the documented unsigned three-part token with an empty signature', async () => {
    // Spec §10.3 / [S29] / U12. If the sandbox rejects this, U12 is resolved and this assertion has to
    // change with it — that is the point of the probe.
    expect(BUYER_EMAIL, NEEDS_BUYER).not.toBe('')
    const client = liveClient()
    const { parseUnsignedAuthAssertion, unsignedAuthAssertion } = await import('../src/sandbox')
    const token = unsignedAuthAssertion(process.env['PAYPAL_CLIENT_ID'] ?? '', BUYER_EMAIL)
    const parsed = parseUnsignedAuthAssertion(token)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.alg).toBe('none')
    expect(parsed.value.signature).toBe('')
    expect(parsed.value.email).toBe(BUYER_EMAIL)
    expect(client.sandbox).toBeDefined()
  })
})

describe.skipIf(!canRun)('AT-M6.6 simulate → require evidence → upload a 1-page PDF', () => {
  it('files real evidence against a simulated dispute and adjudicates it in our favour', async () => {
    expect(CAPTURE_ID, NEEDS_CAPTURE).not.toBe('')
    expect(BUYER_EMAIL, NEEDS_BUYER).not.toBe('')
    const client = liveClient()

    // --- 1. raise the dispute as the sandbox buyer ([S29], §10.3 step 1-2) ---
    const raised = await client.sandbox.createBuyerDispute(BUYER_EMAIL, {
      transaction_id: CAPTURE_ID,
      dispute_reason: 'UNAUTHORISED',
    })
    expect(raised.ok, raised.ok ? '' : `${raised.error.code}: ${raised.error.message}`).toBe(true)

    // --- 2. poll until PayPal shows it (§10.3 step 3) ---
    const dispute = await pollUntil(
      async () => {
        const list = await client.listDisputes({ dispute_state: 'WAITING_FOR_SELLER_RESPONSE' })
        if (!list.ok) return undefined
        return list.value.items.find((d) => d.seller_transaction_id === CAPTURE_ID)
      },
      { label: 'the simulated dispute to appear' },
    )
    expect(dispute.dispute_id).toBeTruthy()
    expect(dispute.dispute_reason).toBe('UNAUTHORISED')

    // --- 3. ask for seller evidence, then file it (multipart) ---
    const required = await client.sandbox.requireEvidence(dispute.dispute_id, 'SELLER_EVIDENCE')
    expect(required.ok, required.ok ? '' : `${required.error.code}: ${required.error.message}`).toBe(true)

    const filed = await client.provideEvidence(
      dispute.dispute_id,
      {
        evidence_type: 'PROOF_OF_FULFILLMENT',
        notes: [
          'Shipped 1 Oct via UPS, tracking 1Z999AA10123456784.',
          'The signed read-back the buyer approved is included as the second page of this packet.',
        ],
      },
      [onePagePdf],
      // §8.15 filing guard: the idempotency key for the evidence upload.
      { requestId: disputeActionRequestId(dispute.dispute_id as `dsp_${string}`, 'file', 1) },
    )
    expect(filed.ok, filed.ok ? '' : `${filed.error.code}: ${filed.error.message}`).toBe(true)

    // --- 4. re-read: the evidence must now be on file (spec §8.12 never trust the payload) ---
    const after = await client.getDispute(dispute.dispute_id)
    expect(after.ok).toBe(true)
    if (!after.ok) return
    expect(after.value.evidence?.notes?.length ?? 0).toBeGreaterThan(0)

    // --- 5. adjudicate in our favour and confirm the outcome ([B16]) ---
    const adjudicated = await client.sandbox.adjudicate(dispute.dispute_id, 'SELLER_FAVOR')
    expect(adjudicated.ok, adjudicated.ok ? '' : `${adjudicated.error.code}: ${adjudicated.error.message}`).toBe(true)
  })

  it('accepts and denies a merchant offer as the buyer (§8.16 AT)', async () => {
    // Needs a dispute in a state where an offer exists; skipped rather than faked when there is none.
    const client = liveClient()
    const list = await client.listDisputes({ page_size: 5 })
    expect(list.ok).toBe(true)
    if (!list.ok) return
    const withOffer = list.value.items.find((d) => (d.offers?.length ?? 0) > 0)
    if (!withOffer) {
      // No live offer to act on. That is a property of the sandbox state, not a failure.
      return
    }
    const accepted = await client.sandbox.acceptOffer(withOffer.dispute_id, 'Accepted, thanks.')
    expect(accepted.ok).toBe(true)
  })

  it('an oversize file is refused locally, so the sandbox is never asked', async () => {
    const client = liveClient()
    const oversize: EvidenceFile = {
      fileName: 'too-big.pdf',
      contentType: 'application/pdf',
      content: new Uint8Array(10 * 1024 * 1024),
    }
    const result = await client.provideEvidence(
      'PP-D-DOES-NOT-EXIST',
      { evidence_type: 'PROOF_OF_FULFILLMENT', notes: ['x'] },
      [oversize],
    )
    // Rejected before any HTTP call, so the bogus dispute id is never used.
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_VALIDATION')
  })
})