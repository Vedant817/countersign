/**
 * Shipment tracking — spec **§8.11** (the `POST /v2/checkout/orders/{id}/track` step), §10.2 row 8, [V11],
 * §12 **EC-SPLIT-1/2**, **EC-CAP-4**.
 *
 * ## Why this is its own file and not three lines inside `captureShipment`
 *
 * Because on the D17 `CAPTURE` path there is **no capture call at all** — the money was taken up front, and
 * a second shipment is a *tracker* on an existing capture (EC-SPLIT-2, and §11's stated fallback when
 * `AUTHORIZE` fails: *"use CAPTURE for everything, and handle OOS/split shipments via refunds"*). So tracking
 * has to be reachable independently of capturing, and the operation has to be honest about the two cases
 * differing.
 *
 * ## `capture_id` is what makes tracking evidence
 *
 * §10.2 #8's body is `{capture_id, tracking_number, carrier, items}`, and the spec ties them together
 * deliberately: the tracker is attached to **the capture it proves**. A tracker without a capture id would
 * be a parcel scan, not evidence — and "is there a shipment with tracking for the disputed lines?" (the
 * EC-SPLIT-1 / R-INR-1 question the Defender asks) is unanswerable without the link.
 *
 * ## EC-CAP-4: nothing is tracked while the money is pending
 *
 * Tracking a shipment tells PayPal — and later, a PayPal agent reading the dispute — that the goods went
 * out. If the capture is `PENDING` that claim is not yet true. So `captureShipment` calls this only after a
 * `COMPLETED`, and {@link linkTracking} refuses a capture that does not hold money if asked directly.
 *
 * ## `addTracking` sends no `PayPal-Request-Id`, and that is correct
 *
 * `SPEC-O` declares no `paypal_request_id` parameter on this endpoint; its idempotency is the
 * `capture_id` + `tracking_number` pair in the body (see `packages/paypal/IDEMPOTENCY.md` and the
 * `ENDPOINT_POLICIES` table). So the request id is still **derived** from our own ids — it is what makes
 * this function's own double-submit check work — but the client drops the header rather than inventing
 * idempotency the endpoint does not claim.
 */

import {
  csError,
  err,
  ok,
  type CsError,
  type OrderId,
  type Result,
  type ShipmentId,
} from '@countersign/core'
import type { ShipmentRow } from '@countersign/db'

import type { OrdersDeps } from './types'

/** What {@link linkTracking} needs. Deliberately explicit rather than a positional tuple. */
export interface TrackingInput {
  readonly orderId: OrderId
  /** The capture this tracking proves. §10.2 #8's `capture_id`. */
  readonly captureId: string
  readonly shipmentId: ShipmentId
  readonly carrier: string
  readonly tracking: string
  readonly lines: readonly { readonly sku: string; readonly qty: number }[]
  readonly at: Date
}

export interface TrackingReport {
  readonly shipment: ShipmentRow | null
  /** PayPal's tracker id, when the endpoint returned one. */
  readonly paypalTrackerId: string | null
  /** `true` when this (capture, tracking) pair had already been recorded. */
  readonly alreadyTracked: boolean
  readonly requestId: string
}

/** `cs:{orderId}:track:{captureId}` — derived, header-safe, and unique per (capture, tracking) pair. */
export function trackingRequestId(orderId: OrderId, captureId: string, tracking: string): string {
  return `cs:${orderId}:track:${captureId}:${tracking}`
}

/**
 * Add tracking for one shipment against the capture that paid for it.
 *
 * **Idempotent on `(capture_id, tracking_number)`** — which is exactly the pair `SPEC-O` says PayPal
 * deduplicates on. The shipment id is content-addressed from `(order, carrier, tracking, lines)`
 * ({@link deterministicIds.shipment}), so a resubmitted identical shipment produces the identical row and
 * the check below reports `alreadyTracked` instead of writing a second one.
 */
export async function linkTracking(
  deps: OrdersDeps,
  input: TrackingInput,
): Promise<Result<TrackingReport, CsError>> {
  if (input.lines.length === 0) {
    return err(
      csError('CS_VALIDATION', 'Tracking requires at least one line', {
        orderId: input.orderId,
        tracking: input.tracking,
      }),
    )
  }
  if (input.tracking.trim() === '') {
    return err(
      csError('CS_VALIDATION', 'Tracking requires a tracking number', { orderId: input.orderId }),
    )
  }

  const requestId = trackingRequestId(input.orderId, input.captureId, input.tracking)

  // EC-CAP-4's guard, at the point of the claim. A tracker asserts the goods went out; asserting it while
  // the money is pending asserts something not yet true.
  const capture = await deps.store.captures.findById(input.captureId)
  if (!capture.ok) return capture
  if (!capture.value) {
    return err(
      csError('CS_NOT_FOUND', `No captures row for ${input.captureId}`, {
        table: 'captures',
        id: input.captureId,
      }),
    )
  }
  if (capture.value.status === 'PENDING') {
    return err(
      csError(
        'CS_VALIDATION',
        `Capture ${input.captureId} is PENDING; do not ship until it completes (EC-CAP-4)`,
        { table: 'captures', id: input.captureId, status: capture.value.status, ec: 'EC-CAP-4' },
        { userMessage: 'Payment pending at PayPal. Do not ship until it completes.' },
      ),
    )
  }
  if (capture.value.status === 'DECLINED') {
    return err(
      csError('CS_VALIDATION', `Capture ${input.captureId} was DECLINED; nothing may be shipped`, {
        table: 'captures',
        id: input.captureId,
        status: capture.value.status,
        ec: 'EC-CAP-5',
      }),
    )
  }

  const existing = await deps.store.shipments.findByOrder(input.orderId)
  if (!existing.ok) return existing
  const already = existing.value.find(
    (s) =>
      s.id === input.shipmentId || (s.tracking_number === input.tracking && s.status !== 'VOIDED'),
  )
  if (already) {
    return ok({
      shipment: already,
      paypalTrackerId: already.paypal_tracker_id,
      alreadyTracked: true,
      requestId,
    })
  }

  const shipment = await deps.store.shipments.insert({
    id: input.shipmentId,
    order_id: input.orderId,
    lines: input.lines.map((l) => ({ sku: l.sku, qty: l.qty })),
    carrier: input.carrier,
    tracking_number: input.tracking,
    status: 'SHIPPED',
    created_at: input.at,
    updated_at: input.at,
  })
  if (!shipment.ok) return shipment

  const tracked = await deps.paypal.addTracking(
    input.orderId,
    {
      capture_id: capture.value.paypal_capture_id,
      tracking_number: input.tracking,
      carrier: input.carrier,
      items: input.lines.map((l) => ({ sku: l.sku, quantity: String(l.qty) })),
    },
    { requestId },
  )
  if (!tracked.ok) return tracked

  // PayPal's response carries `links` with a `rel: "track"` entry; the tracker id is the last path segment.
  const trackerId = trackerIdFrom(tracked.value)
  if (trackerId) {
    const stamped = await deps.store.shipments.setTracker(input.shipmentId, trackerId, input.at)
    if (!stamped.ok) return stamped
    return ok({
      shipment: stamped.value,
      paypalTrackerId: trackerId,
      alreadyTracked: false,
      requestId,
    })
  }

  return ok({ shipment: shipment.value, paypalTrackerId: null, alreadyTracked: false, requestId })
}

/** The tracker id out of an `addTracking` response, or `null` when PayPal returned no `track` link. */
export function trackerIdFrom(response: {
  links?: { href?: string; rel?: string }[]
}): string | null {
  const link = (response.links ?? []).find((l) => l.rel === 'track' && typeof l.href === 'string')
  const href = link?.href
  if (!href) return null
  const segment = href.split('/').filter(Boolean).pop()
  return segment && segment !== '' ? segment : null
}
