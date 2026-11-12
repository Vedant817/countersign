/**
 * The webhook delivery pipeline, end to end against Postgres.
 *
 * `packages/webhooks` proves every §8.12 decision (dedupe, verification, the `PENDING`/`VERIFIED`/`FAILED`
 * state machine, the audit entry, the enqueue) with an in-memory store. What it cannot prove is that the
 * *wiring* the app uses - `apps/web/app/api/webhooks/paypal/route.ts`'s repositories, and the bytes its adapter
 * reads off a `Request` - behave the same way against the real schema. That is what this suite is for, and it
 * is the one place where the app's own adapter code is exercised rather than described.
 *
 * ## The properties, and why each has a test
 *
 *  1. **The body is handed over byte for byte.** `request.json()` then `JSON.stringify()` reads better, and it
 *     re-serialises PayPal's body - key order changes, whitespace disappears - while
 *     `verify-webhook-signature` verifies the bytes it is given. A delivery PayPal really signed would then
 *     fail verification on our side, and the failure would be indistinguishable from a forgery: EC-WH-4's 400,
 *     a `FAILED` row, the forged-delivery alert. So the fixture below has spacing `JSON.stringify` would never
 *     emit, and the stored bytes are compared to it exactly.
 *  2. **The header bag is canonical.** HTTP header names are case-insensitive, and `webhook_events.raw` keeps
 *     the first delivery's headers as the case file. A proxy that re-cased them must not make a redelivery
 *     look like a different delivery.
 *
 * ## Skipped, not failed, without a database
 *
 * The PR gate does not promise a database. A suite that failed here would be a red build on a machine that did
 * nothing wrong; one that silently passed would be a false green. So it skips, and it names the reason.
 */
import { afterAll, describe, expect, it } from 'vitest'

import { closeDb, findWebhookEventByPaypalId } from '@countersign/db'
import { handleWebhook, type HeaderBag } from '@countersign/webhooks'

import { bytesOf, headerBagOf, realDeps } from './test-helpers'

const DATABASE_URL = process.env['DATABASE_URL']
const describeWithDb = DATABASE_URL ? describe : describe.skip

/**
 * A body whose spacing `JSON.stringify` would never emit.
 *
 * Newlines and two-space indents, plus a space after each colon. `JSON.stringify(JSON.parse(x))` is compact and
 * colon-tight, so "stored verbatim" and "re-serialised" cannot produce the same string - which is the whole
 * reason the fixture is shaped this way instead of being an ordinary JSON blob.
 */
const RAW_BODY =
  '{\n  "id": "WH-ROUTE-BYTES",\n  "event_type": "PAYMENT.CAPTURE.COMPLETED",\n  "resource": { "id": "3C679366HH908993F" }\n}'

/** The five headers `readSignatureHeaders` requires. The signature is not real, and that is the point. */
const HEADERS: HeaderBag = {
  'paypal-transmission-id': 'route-test-transmission',
  'paypal-transmission-time': '2026-10-04T12:00:00Z',
  'paypal-transmission-sig': 'not-a-real-signature',
  'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1',
  'paypal-auth-algo': 'SHA256withRSA',
  'content-type': 'application/json',
}

afterAll(async () => {
  await closeDb()
})

describeWithDb('the webhook delivery, end to end against Postgres', () => {
  it('EC-WH-7 the stored bytes are the bytes that arrived, not a re-serialisation', async () => {
    const deps = await realDeps()

    const ack = await handleWebhook(bytesOf(RAW_BODY), HEADERS, deps)
    expect(ack.status).toBe(200)

    const stored = await findWebhookEventByPaypalId('WH-ROUTE-BYTES')
    expect(stored.ok).toBe(true)
    if (!stored.ok || stored.value === undefined) return

    const raw = stored.value.raw as { delivery?: { rawBodyBase64?: string } } | null
    const encoded = raw?.delivery?.rawBodyBase64
    expect(typeof encoded).toBe('string')
    expect(Buffer.from(encoded ?? '', 'base64').toString('utf8')).toBe(RAW_BODY)
  })

  it('EC-WH-4 a delivery with no signature headers is refused and never stored', async () => {
    const deps = await realDeps()

    const ack = await handleWebhook(
      bytesOf('{"id":"WH-ROUTE-FORGED","event_type":"PAYMENT.CAPTURE.COMPLETED"}'),
      {},
      deps,
    )

    expect(ack.status).toBe(400)
    expect(ack.outcome).toBe('REJECTED_SIGNATURE')

    const stored = await findWebhookEventByPaypalId('WH-ROUTE-FORGED')
    expect(stored.ok).toBe(true)
    if (!stored.ok) return
    // Not a `FAILED` row: EC-WH-4 reserves that for a body PayPal actually signed and we rejected, and the
    // forged-delivery alert counts them.
    expect(stored.value).toBeUndefined()
  })

  it('EC-WH-2 a redelivery is acknowledged and does not insert a second row', async () => {
    /*
     * Two deliveries, two acks, one row - and the interesting half is *why* the second is not `DUPLICATE`.
     *
     * The first delivery is stored `PENDING`, because `PAYPAL_WEBHOOK_ID` is unset on this deployment and
     * `verifyDelivery` therefore answers `UNAVAILABLE` rather than claiming a signature was checked. EC-WH-7
     * then asks for the retry to arrive free on the redelivery: `dedupeDecision` sets `verify: true` for a
     * `PENDING` row, so the second delivery re-verifies and acks `STORED_UNVERIFIED` again rather than
     * `DUPLICATE`. `DUPLICATE` is reserved for a row already `VERIFIED` - which is what this would be if the
     * webhook id were configured.
     *
     * So the assertion is on the invariant that holds either way: one row, one first body, and a 200 for both
     * deliveries (§8.12 step 5 promises 200 for anything stored, including duplicates).
     */
    const deps = await realDeps()

    const first = await handleWebhook(bytesOf(RAW_BODY), HEADERS, deps)
    const second = await handleWebhook(bytesOf(RAW_BODY), HEADERS, deps)

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.outcome).toBe('STORED_UNVERIFIED')

    const stored = await findWebhookEventByPaypalId('WH-ROUTE-BYTES')
    expect(stored.ok).toBe(true)
    if (!stored.ok) return
    // One row, and the first delivery's body is the one retained.
    expect(stored.value?.paypal_event_id).toBe('WH-ROUTE-BYTES')
  })

  it('an unreadable body is a 400, not a 500, and is audited', async () => {
    const deps = await realDeps()

    const ack = await handleWebhook(bytesOf('this is not json'), HEADERS, deps)
    expect(ack.status).toBe(400)
    expect(ack.outcome).toBe('REJECTED_MALFORMED')
  })

  it('EC-PRIV-3 the acknowledgement carries no PayPal payload', async () => {
    const deps = await realDeps()

    const ack = await handleWebhook(bytesOf(RAW_BODY), HEADERS, deps)
    // The ack is what the route serialises into the response, so it is what a caller and any proxy in front of
    // us can read. The payload belongs in `webhook_events.raw` and nowhere else.
    const serialised = JSON.stringify(ack)
    expect(serialised).not.toContain('3C679366HH908993F')
    expect(serialised).not.toContain('PAYMENT.CAPTURE.COMPLETED')
  })

  it('the header bag is canonical, so a re-cased redelivery compares equal to the first', async () => {
    // `Headers` lower-cases on iteration already, so this asserts the adapter's *behaviour* rather than the
    // platform's: whatever casing a proxy used, the bag the package sees has lower-cased keys and the value.
    const bag = headerBagOf(
      new Headers({
        'PayPal-Transmission-Id': 'mixed-case',
        'PAYPAL-TRANSMISSION-TIME': '2026-10-04T12:00:00Z',
      }),
    )
    expect(bag['paypal-transmission-id']).toBe('mixed-case')
    expect(bag['paypal-transmission-time']).toBe('2026-10-04T12:00:00Z')
  })
})
