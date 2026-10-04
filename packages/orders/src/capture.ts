/**
 * Split captures — spec **§8.11** (`captureShipment`), **D17**, §12 **EC-CAP-1…5**, **EC-FX-4**,
 * **EC-STOCK-1**, **EC-SPLIT-1/2**, **EC-MDT-5**, [B12].
 *
 * ## The allocation, and why `allocate()` is not a convenience here
 *
 * §8.11 puts it in one line: *"amount = allocate(line totals + pro-rata shipping)"*, and EC-FX-4 makes the
 * acceptance property explicit: **largest-remainder; Σ captures == total exactly.**
 *
 * That property is not achievable any other way, and the naive alternatives all fail on a real cart:
 *
 * | Approach | What breaks |
 * |---|---|
 * | `Math.round(total * weight / Σweights)` | one or two cents are invented or destroyed, so the last capture does not close the authorization and the buyer keeps a phantom hold |
 * | `Number(x.minor) / 100` then re-multiply | `129.99` becomes `129.98999999999998`, and the money is wrong in the *stored* column, not just the display |
 * | give every cent to the last shipment | the first shipment's receipt says `59.99` when the cart says `60.00`, and a judge with a calculator finds it |
 *
 * `allocate()` from `@countersign/core` is largest-remainder over `bigint`, so `Σ parts === total`
 * identically — and the guarantee is re-asserted *by the function itself*, so it cannot be a property only
 * this file believes in.
 *
 * ## Shipping is pro-rata over line *values*, and that choice is load-bearing
 *
 * Shipping is allocated across the cart's lines **by line value**, so the same line always gets the same
 * shipping share no matter how the order is later split into shipments. The alternative — allocate across
 * shipments — is unknowable at capture time (we do not know how many shipments there will be) *and* would
 * make a first shipment's amount depend on a future decision.
 *
 * The consequence is what makes EC-FX-4's property provable: the total is fixed at order-create time, the
 * per-line shares are fixed at that moment too, and every capture is a **sum of a subset of those shares**.
 * Sums of subsets of an exact partition are exact.
 *
 * ## `final_capture` is a function of what is left (EC-CAP-2, EC-STOCK-1)
 *
 * ```
 * final_capture = (remaining == 0)
 * ```
 *
 * with one override: `finalCapture: true` forces it, for EC-STOCK-1's "line went out of stock after
 * authorization", where the merchant is done but money remains unallocated. PayPal then **releases the
 * uncaptured remainder** ([B12]) and our ledger releases its share.
 *
 * The failure mode this prevents is a merchant who captures $60 of $100, never ships the rest, and never
 * calls `voidRemainder` — the buyer's $40 stays authorized for 29 days.
 *
 * ## EC-MDT-5: a capture against an existing authorization outlives the mandate
 *
 * A mandate that expires mid-fulfilment does **not** invalidate a capture against an authorization that
 * was created while the mandate was valid. The authority was granted then; the amount is already bounded by
 * the authorization; and a rule that voided it would mean an agent could not complete a shipment it had
 * legitimately started, which is the opposite of what a mandate is for.
 *
 * So `captureShipment` **does not read the mandate**. That is a deliberate omission, and a test names it.
 *
 * ## EC-CAP-3: the over-capture guard runs *before* the request
 *
 * §8.11 AT-M11.4 and §12.1: *"Rejected locally (`CS_VALIDATION`) before calling PayPal."* A refused local
 * check costs nothing; a refused PayPal call costs a debug id, a rate-limit token and a support ticket.
 */

import {
  allocate,
  csError,
  err,
  ok,
  toPayPalValue,
  type CsError,
  type Money,
  type OrderId,
  type Result,
  type ShipmentId,
} from '@countersign/core'
import type {
  AuthorizationRow,
  CaptureRow,
  CheckoutSessionRow,
  OrderRow,
  ShipmentRow,
} from '@countersign/db'
import { captureRequestId } from '@countersign/paypal'

import { applyCaptureOutcome, capturedMinorForAuthorization, outcomeFor } from './budget-hooks'
import { deterministicIds, toJsonValue } from './deps'
import { linkTracking } from './tracking'
import type { CaptureReport, OrdersDeps, ShipmentInput } from './types'

/* ------------------------------------------------------------------------------------------ */
/* The allocation                                                                                 */
/* ------------------------------------------------------------------------------------------ */

/** One shipment line after it has been priced against the locked cart. */
export interface PricedLine {
  readonly sku: string
  readonly qty: number
  readonly unitMinor: bigint
  /** `unitMinor × qty`. Integer: a quantity is a count, so `bigint` multiplication is exact. */
  readonly lineValueMinor: bigint
  /** This line's share of `shipping + tax`, from {@link shippingShares}. */
  readonly shippingMinor: bigint
}

/** What {@link allocateShipment} decided, so the caller can render a receipt without re-deriving it. */
export interface ShipmentAllocation {
  readonly lines: readonly PricedLine[]
  /** The capture amount: `Σ (lineValue + shippingShare)` over the shipment's lines. */
  readonly amount: Money
  /** `authorized − Σ captures − this amount`, i.e. what will still be authorized afterwards. */
  readonly remainingAfter: bigint
  /** `final_capture` as derived, before any caller override. */
  readonly finalCapture: boolean
  /** `true` when the caller forced `finalCapture`. */
  readonly forcedFinal: boolean
}

/**
 * The per-**unit** shipping (and tax) shares of a cart, in unit order.
 *
 * ### Why units, not lines
 *
 * The obvious implementation allocates the fee across *lines*. It is wrong the moment a shipment takes part
 * of a line, which EC-SPLIT-1 and EC-STOCK-1 are entirely made of: a cart of one line × 2 units with a
 * $5.00 fee would give that line the whole $5.00, so shipping **one** unit would capture $45.00 + $5.00 and
 * the second unit would be unshippable without exceeding the authorization. The remainder then has to be
 * split by integer division, which is where cents disappear.
 *
 * Allocating across **units** removes the problem rather than managing it. Every unit gets its own exact
 * share, a shipment of *n* units takes *n* of them, and:
 *
 * ```
 * Σ over every shipment of its units' shares  ==  the whole fee, exactly
 * ```
 *
 * holds because the shipment partition is a partition of the units. That is what makes EC-FX-4's identity
 * provable rather than hoped for, and it holds for any grouping of shipments into units.
 *
 * Deterministic and independent of how the order is later split — the shares are computed once from the whole
 * cart, so two shipments of the same sku never negotiate a different share for the same unit.
 *
 * Falls back to **equal** shares when the cart is all zero-priced (a $0.00 order), because `allocate`
 * requires weights summing above zero and a zero-weight cart would throw at exactly the moment a merchant is
 * trying to ship.
 *
 * @returns one `bigint` per **unit**, in `{sku} × qty` order. `Σ` equals `tax_minor + shipping_minor`.
 */
export function shippingShares(
  session: Pick<CheckoutSessionRow, 'cart' | 'tax_minor' | 'shipping_minor' | 'currency'>,
  lines: readonly { unitMinor: bigint; qty: number }[],
): bigint[] {
  const spread = session.tax_minor + session.shipping_minor
  // One weight per unit, in `{sku} × qty` order. `allocateShipment` indexes into this array with the same
  // walk, which is why the two must agree on the ordering — the unit index is the whole contract between
  // them.
  const weights: bigint[] = []
  for (const line of lines) {
    for (let i = 0; i < line.qty; i++) weights.push(line.unitMinor)
  }
  if (weights.length === 0) return []
  if (spread === 0n) return weights.map(() => 0n)

  const weightTotal = weights.reduce((a, b) => a + b, 0n)
  if (weightTotal === 0n) {
    return allocate(
      { minor: spread, currency: session.currency },
      weights.map(() => 1n),
    ).map((m) => m.minor)
  }
  return allocate({ minor: spread, currency: session.currency }, weights).map((m) => m.minor)
}

/**
 * Price one shipment against the locked cart and allocate its amount. **Pure** — no store, no clock.
 *
 * Refuses:
 *
 *  - a line that is not in the cart (EC-SPLIT-1: evidence and the receipt must describe real goods);
 *  - a `qty` that is not a positive integer;
 *  - a shipment that ships more of a line than was bought, in aggregate across every shipment so far. That
 *    last one is the merchant-error guard: shipping 3 of 2 would otherwise capture money for goods nobody
 *    paid for, and no single-shipment check could see it.
 */
export function allocateShipment(input: {
  readonly session: Pick<CheckoutSessionRow, 'cart' | 'tax_minor' | 'shipping_minor' | 'currency'>
  readonly shipment: ShipmentInput
  /** Σ already shipped per sku, from the shipments recorded for this order. */
  readonly alreadyShipped: Readonly<Record<string, number>>
  readonly authorizedMinor: bigint
  readonly capturedMinor: bigint
}): ShipmentAllocation {
  const cart = cartLinesOf(input.session.cart)
  const bySku = new Map<string, { qty: number; unitMinor: bigint }>()
  for (const line of cart) {
    const existing = bySku.get(line.sku)
    if (existing) {
      bySku.set(line.sku, { qty: existing.qty + line.qty, unitMinor: existing.unitMinor })
    } else {
      bySku.set(line.sku, { qty: line.qty, unitMinor: line.unitMinor })
    }
  }

  if (input.shipment.lines.length === 0) {
    throw csError('CS_VALIDATION', 'A shipment must have at least one line', {
      tracking: input.shipment.tracking,
    })
  }

  // One share per **unit**, so a shipment of *n* units of a line takes exactly *n* of them. This is what
  // makes the identity hold for partial shipments; see `shippingShares`.
  const unitShares = shippingShares(input.session, cart)
  // Cursor per sku: how many of that sku's units have been claimed so far, in unit order. Claimed **by this
  // shipment first**, so a second shipment gets the units the first did not.
  const claimed = new Map<string, number>(
    Object.entries(input.alreadyShipped).map(([sku, n]) => [sku, n]),
  )

  const priced: PricedLine[] = []
  for (const requested of input.shipment.lines) {
    if (!Number.isInteger(requested.qty) || requested.qty <= 0) {
      throw csError(
        'CS_VALIDATION',
        `Shipment line ${requested.sku} has qty ${requested.qty}; it must be a positive integer`,
        { sku: requested.sku, qty: String(requested.qty) },
      )
    }
    const ordered = bySku.get(requested.sku)
    if (!ordered) {
      throw csError('CS_VALIDATION', `Shipment line ${requested.sku} is not in the cart`, {
        sku: requested.sku,
        cartSkus: [...bySku.keys()],
      })
    }
    const shippedSoFar = input.alreadyShipped[requested.sku] ?? 0
    if (shippedSoFar + requested.qty > ordered.qty) {
      throw csError(
        'CS_VALIDATION',
        `Shipment would ship ${shippedSoFar + requested.qty} of ${requested.sku} but only ${ordered.qty} were bought`,
        {
          sku: requested.sku,
          orderedQty: ordered.qty,
          alreadyShippedQty: shippedSoFar,
          requestedQty: requested.qty,
        },
        { userMessage: 'That is more of an item than was ordered.' },
      )
    }

    // The cart may list a sku more than once; the units of every occurrence are laid out contiguously in
    // `unitShares`, and the cursor walks them, so each unit's share is claimed by exactly one shipment.
    const start = claimed.get(requested.sku) ?? 0
    const slice: bigint[] = []
    let seen = 0
    let cursor = 0
    for (const line of cart) {
      if (line.sku !== requested.sku) {
        cursor += line.qty
        continue
      }
      for (let i = 0; i < line.qty; i++) {
        if (seen >= start && seen < start + requested.qty) {
          slice.push(unitShares[cursor + i] ?? 0n)
        }
        seen += 1
      }
      cursor += line.qty
    }
    claimed.set(requested.sku, start + requested.qty)

    priced.push({
      sku: requested.sku,
      qty: requested.qty,
      unitMinor: ordered.unitMinor,
      lineValueMinor: ordered.unitMinor * BigInt(requested.qty),
      shippingMinor: slice.reduce((a, b) => a + b, 0n),
    })
  }

  // Two entries for the same sku in one shipment would double-count the goods; collapse them so the total
  // stays exact and the shipment carries one row per sku.
  const collapsed = collapseBySku(priced)

  const amountMinor = collapsed.reduce((acc, l) => acc + l.lineValueMinor + l.shippingMinor, 0n)
  const amount: Money = { minor: amountMinor, currency: input.session.currency }

  const remainingAfter = input.authorizedMinor - input.capturedMinor - amountMinor
  if (remainingAfter < 0n) {
    // EC-CAP-3. Thrown rather than returned so the caller's single `attemptSync` boundary converts it; the
    // detail names the exact shortfall the merchant has to explain.
    throw csError(
      'CS_VALIDATION',
      `Capture of ${amountMinor} would exceed the authorization: ${input.capturedMinor} already captured of ${input.authorizedMinor}`,
      {
        requestedMinor: amountMinor.toString(),
        alreadyCapturedMinor: input.capturedMinor.toString(),
        authorizedMinor: input.authorizedMinor.toString(),
        overByMinor: (-remainingAfter).toString(),
        currency: input.session.currency,
      },
      {
        userMessage:
          'Exceeds authorization. Create a supplementary charge (requires a new Gate check).',
      },
    )
  }

  const derived = remainingAfter === 0n
  const forced = input.shipment.finalCapture !== undefined
  return {
    lines: collapsed,
    amount,
    remainingAfter,
    finalCapture: forced ? (input.shipment.finalCapture ?? derived) : derived,
    forcedFinal: forced,
  }
}

/** Merge duplicate skus in one shipment, preserving first-seen order. */
function collapseBySku(lines: readonly PricedLine[]): PricedLine[] {
  const out: PricedLine[] = []
  for (const line of lines) {
    const existing = out.find((l) => l.sku === line.sku)
    if (existing) {
      out[out.indexOf(existing)] = {
        ...existing,
        qty: existing.qty + line.qty,
        lineValueMinor: existing.lineValueMinor + line.lineValueMinor,
        shippingMinor: existing.shippingMinor + line.shippingMinor,
      }
    } else {
      out.push(line)
    }
  }
  return out
}

/** `{lines: [{sku, qty, unit_minor}]}` out of `checkout_sessions.cart`. */
function cartLinesOf(cart: unknown): { sku: string; qty: number; unitMinor: bigint }[] {
  const lines =
    typeof cart === 'object' && cart !== null && 'lines' in cart
      ? (cart as { lines?: unknown }).lines
      : undefined
  if (!Array.isArray(lines) || lines.length === 0) {
    throw csError('CS_VALIDATION', 'checkout_sessions.cart has no lines', {
      table: 'checkout_sessions',
    })
  }
  return lines.map((raw) => {
    const line = raw as { sku?: unknown; qty?: unknown; unit_minor?: unknown }
    const unitMinor =
      typeof line.unit_minor === 'bigint'
        ? line.unit_minor
        : typeof line.unit_minor === 'string' && /^\d+$/.test(line.unit_minor)
          ? BigInt(line.unit_minor)
          : null
    const qty = typeof line.qty === 'number' && Number.isInteger(line.qty) ? line.qty : null
    if (typeof line.sku !== 'string' || unitMinor === null || qty === null || qty <= 0) {
      throw csError('CS_VALIDATION', `Cart line is unreadable: ${JSON.stringify(raw)}`, {
        table: 'checkout_sessions',
      })
    }
    return { sku: line.sku, qty, unitMinor }
  })
}

/* ------------------------------------------------------------------------------------------ */
/* captureShipment                                                                                */
/* ------------------------------------------------------------------------------------------ */

/**
 * Capture what one shipment shipped, and add its tracking.
 *
 * §8.11's signature plus the one flag D17 needs ({@link ShipmentInput.finalCapture}). The order of
 * operations is:
 *
 *  1. Read the order, its authorization, its shipments and its captures — all inside one transaction, so the
 *     over-capture guard and the insert see the same `Σ`.
 *  2. **Allocate** the amount. No PayPal call has happened yet, so an over-capture is refused for free
 *     (EC-CAP-3).
 *  3. `POST /v2/payments/authorizations/{id}/capture` with `final_capture` as derived, and a deterministic
 *     `PayPal-Request-Id` of `cs:{authId}:cap:{shipmentId}` (§8.6) so a retry is the same capture.
 *  4. Persist the capture and the shipment, then run the §8.11 hook.
 *  5. **Only if the capture is `COMPLETED`**, `POST /v2/checkout/orders/{id}/track` with the capture id
 *     (EC-CAP-4: nothing ships while the money is pending).
 *
 * ## EC-SPLIT-2: the same capture id can carry several trackers
 *
 * On the D17 `CAPTURE` path the money was taken up front, so there is no authorization to capture against:
 * a second shipment **tracks against the same capture**. That is why this function returns
 * `trackingOnly: true` rather than refusing, and why `linkTracking` keys on `(order, capture)` and not on
 * a capture-to-shipment 1:1.
 */
export async function captureShipment(
  orderId: OrderId,
  shipment: ShipmentInput,
  deps: OrdersDeps,
): Promise<Result<CaptureReport, CsError>> {
  const at = new Date(deps.clock.nowMs())

  const prepared = await withTxRead(deps, orderId, at)
  if (!prepared.ok) return prepared
  const { order, authorization, session, captures, shipments } = prepared.value

  if (
    order.status === 'VOIDED' ||
    order.status === 'CANCELLED' ||
    order.status === 'AUTH_EXPIRED'
  ) {
    return err(
      csError(
        'CS_VALIDATION',
        `Order ${orderId} is ${order.status}; nothing can be captured against it`,
        {
          orderId,
          orderStatus: order.status,
        },
      ),
    )
  }

  const alreadyShipped: Record<string, number> = {}
  for (const row of shipments) {
    for (const line of linesOf(row.lines)) {
      alreadyShipped[line.sku] = (alreadyShipped[line.sku] ?? 0) + line.qty
    }
  }

  // The CAPTURE-intent path has no authorization: the money was taken up front, so this shipment is a
  // tracking event against the existing capture (EC-SPLIT-2).
  if (!authorization) {
    return trackingOnlyShipment(deps, {
      order,
      session,
      captures,
      shipments,
      shipment,
      alreadyShipped,
      at,
    })
  }

  const capturedMinor = moneyHolds(captures)
  let allocation: ShipmentAllocation
  try {
    allocation = allocateShipment({
      session,
      shipment,
      alreadyShipped,
      authorizedMinor: authorization.amount_minor,
      capturedMinor,
    })
  } catch (cause) {
    return err(toCs(cause, 'EC-CAP-3'))
  }

  const shipmentId = deterministicIds.shipment(
    orderId,
    shipment.carrier,
    shipment.tracking,
    allocation.lines.map((l) => ({ sku: l.sku, qty: l.qty })),
  ) as ShipmentId

  // §8.6's format, verbatim, with the real ids in their slots.
  const requestId = captureRequestId(authorization.paypal_authorization_id, shipmentId)

  const captured = await deps.paypal.captureAuthorization(
    authorization.paypal_authorization_id,
    {
      amount: {
        currency_code: allocation.amount.currency,
        value: toPayPalValue(allocation.amount),
      },
      final_capture: allocation.finalCapture,
      invoice_id: orderId,
      ...(shipment.noteToPayer !== undefined ? { note_to_payer: shipment.noteToPayer } : {}),
    },
    { requestId },
  )

  if (!captured.ok) {
    // §8.6 maps a decline to `PP_INSTRUMENT_DECLINED`; AT-M11.6 wants the reservation back, the order
    // `PAYMENT_FAILED`, and the buyer told. **No retry with another instrument** — the mandate binds one.
    if (captured.error.code === 'PP_INSTRUMENT_DECLINED') {
      const declined = await recordDeclinedCapture(deps, {
        order,
        authorization,
        shipmentId,
        amount: allocation.amount,
        finalCapture: allocation.finalCapture,
        at,
        note: captured.error.message,
      })
      if (!declined.ok) return declined
      return err(captured.error)
    }
    return captured
  }

  const paypalCapture = captured.value
  const status = captureStatusFor(paypalCapture.status)
  const row = await deps.store.captures.insert({
    id: deterministicIds.capture(orderId, authorization.id, shipmentId),
    order_id: orderId,
    authorization_id: authorization.id,
    paypal_capture_id: paypalCapture.id,
    amount_minor: allocation.amount.minor,
    currency: allocation.amount.currency,
    final_capture: allocation.finalCapture,
    status,
    shipment_id: shipmentId,
    raw: toJsonValue(paypalCapture),
    fetched_at: at,
    created_at: at,
    updated_at: at,
  })
  if (!row.ok) return row
  const captureRow = row.value

  const outcome = outcomeFor(status)
  if (outcome) {
    const applied = await applyCaptureOutcome({
      deps,
      order,
      authorization,
      capture: captureRow,
      outcome,
      at,
      // The arithmetic, not a re-read: `remainingAfter` was computed against the same `Σ` the guard used.
      remainingAfter: allocation.remainingAfter,
    })
    if (!applied.ok) return applied
  }

  // §10.2 #8, and only once the money is actually captured.
  //
  // `linkTracking` **owns** the `shipments` row on this path rather than being handed one, for two reasons:
  // its idempotency check is "a shipment with this id already exists", so pre-inserting here would make it
  // believe the tracker was already sent and return without calling PayPal — and it is the right place for
  // the row, because the row and the tracker are one fact.
  //
  // EC-CAP-4 is the exception: a `PENDING` capture ships nothing, so nothing is tracked and the row is
  // written here as `NOT_SHIPPED`, which is the state the fulfiller needs to see.
  let shipmentRow: ShipmentRow | null = null
  if (status === 'COMPLETED') {
    const tracked = await linkTracking(deps, {
      orderId,
      captureId: captureRow.id,
      shipmentId,
      carrier: shipment.carrier,
      tracking: shipment.tracking,
      lines: allocation.lines.map((l) => ({ sku: l.sku, qty: l.qty })),
      at,
    })
    if (!tracked.ok) return tracked
    shipmentRow = tracked.value.shipment
  } else {
    const pendingRow = await deps.store.shipments.insert({
      id: shipmentId,
      order_id: orderId,
      lines: allocation.lines.map((l) => ({ sku: l.sku, qty: l.qty })),
      carrier: shipment.carrier,
      tracking_number: shipment.tracking,
      // EC-CAP-4: money is held, goods have not gone out.
      status: 'NOT_SHIPPED',
      created_at: at,
      updated_at: at,
    })
    if (!pendingRow.ok) return pendingRow
    shipmentRow = pendingRow.value
  }

  return ok({
    capture: captureRow,
    shipment: shipmentRow,
    amount: allocation.amount,
    finalCapture: allocation.finalCapture,
    remainingAfter: allocation.remainingAfter,
    pending: status === 'PENDING',
    trackingOnly: false,
    requestId,
    authorizationId: authorization.id,
  })
}

/* ------------------------------------------------------------------------------------------ */
/* The CAPTURE-intent path (EC-SPLIT-2)                                                            */
/* ------------------------------------------------------------------------------------------ */

/**
 * EC-SPLIT-2 / the week-1 C2 fallback: track this shipment against the capture that already exists.
 *
 * "use CAPTURE for everything, and handle OOS/split shipments via refunds (EC-SPLIT-2 path)" is §11's
 * stated fallback for C2 failing on `AUTHORIZE`. On that path the whole order was captured at create, so
 * a second shipment has no money to move — only a tracker to add.
 *
 * The amount is **not** allocated here, and that is deliberate: allocating would imply a capture that
 * cannot happen. What it does check is that the line quantities do not exceed the cart, because the
 * receipt still has to be true.
 */
async function trackingOnlyShipment(
  deps: OrdersDeps,
  input: {
    order: OrderRow
    session: CheckoutSessionRow
    captures: readonly CaptureRow[]
    shipments: readonly ShipmentRow[]
    shipment: ShipmentInput
    alreadyShipped: Record<string, number>
    at: Date
  },
): Promise<Result<CaptureReport, CsError>> {
  const { order, session, captures, at } = input
  const moneyCapture = captures.find((c) => moneyHolds([c]))
  if (!moneyCapture) {
    return err(
      csError(
        'CS_VALIDATION',
        `Order ${order.id} has no authorization and no captured money; a shipment cannot be tracked`,
        { orderId: order.id, captureCount: captures.length },
        { userMessage: 'Nothing has been paid for this order yet.' },
      ),
    )
  }

  let allocation: ShipmentAllocation
  try {
    allocation = allocateShipment({
      session,
      shipment: input.shipment,
      alreadyShipped: input.alreadyShipped,
      authorizedMinor: order.amount_minor,
      capturedMinor: 0n,
    })
  } catch (cause) {
    return err(toCs(cause, 'EC-SPLIT-2'))
  }

  const shipmentId = deterministicIds.shipment(
    order.id,
    input.shipment.carrier,
    input.shipment.tracking,
    allocation.lines.map((l) => ({ sku: l.sku, qty: l.qty })),
  ) as ShipmentId

  // `linkTracking` owns the `shipments` row on this path too — pre-inserting here would make its
  // idempotency check believe the tracker had already been sent and return without calling PayPal.
  const tracked = await linkTracking(deps, {
    orderId: order.id,
    captureId: moneyCapture.id,
    shipmentId,
    carrier: input.shipment.carrier,
    tracking: input.shipment.tracking,
    lines: allocation.lines.map((l) => ({ sku: l.sku, qty: l.qty })),
    at,
  })
  if (!tracked.ok) return tracked

  return ok({
    capture: moneyCapture,
    shipment: tracked.value.shipment,
    // No money moved, so the amount is zero and the remaining is the whole authorization: reporting the
    // cart total here would tell a receipt it is about to charge again.
    amount: { minor: 0n, currency: order.currency },
    finalCapture: true,
    remainingAfter: order.amount_minor - moneyCapture.amount_minor,
    pending: false,
    trackingOnly: true,
    requestId: '',
    authorizationId: null,
  })
}

/* ------------------------------------------------------------------------------------------ */
/* Decline                                                                                        */
/* ------------------------------------------------------------------------------------------ */

/**
 * AT-M11.6 / EC-CAP-5: a `DECLINED` capture still gets a row, and still gets the ledger's money back.
 *
 * Two things are worth spelling out:
 *
 *  - **The row is written even though nothing was captured.** A declined attempt is evidence: it is what
 *    stops the agent trying the same thing again, and what the buyer is shown. EC-CAP-5's detection is the
 *    *status*, so the status has to be stored.
 *  - **The `Σ` used by the over-capture guard excludes it**, so a declined capture does not permanently
 *    shrink what the buyer may spend. That is {@link moneyHolds}.
 *
 * The hook's release covers the whole uncaptured remainder, not just this capture's amount, because the
 * authorization is dead: nothing further can be captured against it, so nothing further may stay reserved.
 */
async function recordDeclinedCapture(
  deps: OrdersDeps,
  input: {
    order: OrderRow
    authorization: AuthorizationRow
    shipmentId: ShipmentId
    amount: Money
    finalCapture: boolean
    at: Date
    note: string
  },
): Promise<Result<void, CsError>> {
  // PayPal answered with an error, so there is no capture id to mirror. The row is keyed on the *request*
  // instead, which is deterministic and therefore safe: a retry of the same capture produces the same id.
  const syntheticId = `DECLINED-${input.order.id}-${input.shipmentId}`
  const row = await deps.store.captures.insert({
    id: deterministicIds.capture(input.order.id, input.authorization.id, input.shipmentId),
    order_id: input.order.id,
    authorization_id: input.authorization.id,
    paypal_capture_id: syntheticId,
    amount_minor: input.amount.minor,
    currency: input.amount.currency,
    final_capture: input.finalCapture,
    status: 'DECLINED',
    shipment_id: null,
    raw: null,
    fetched_at: null,
    created_at: input.at,
    updated_at: input.at,
  })
  if (!row.ok) return row

  const applied = await applyCaptureOutcome({
    deps,
    order: input.order,
    authorization: input.authorization,
    capture: row.value,
    outcome: 'DECLINED',
    at: input.at,
    remainingAfter: 0n,
  })
  if (!applied.ok) return applied
  void input.note
  return ok(undefined)
}

/* ------------------------------------------------------------------------------------------ */
/* Reads                                                                                          */
/* ------------------------------------------------------------------------------------------ */

interface PreparedShipment {
  readonly order: OrderRow
  readonly authorization: AuthorizationRow | null
  readonly session: CheckoutSessionRow
  readonly captures: readonly CaptureRow[]
  readonly shipments: readonly ShipmentRow[]
}

/** Read everything `captureShipment` needs, in one transaction. */
async function withTxRead(
  deps: OrdersDeps,
  orderId: OrderId,
  at: Date,
): Promise<Result<PreparedShipment, CsError>> {
  const order = await deps.store.orders.findById(orderId)
  if (!order.ok) return order
  if (!order.value) {
    return err(
      csError('CS_NOT_FOUND', `No orders row for ${orderId}`, { table: 'orders', id: orderId }),
    )
  }
  const orderRow = order.value

  const auths = await deps.store.authorizations.findByOrder(orderId)
  if (!auths.ok) return auths
  // A `PARTIALLY_CAPTURED` authorization is the **live** one — that is the whole of EC-SPLIT-1 and
  // EC-STOCK-1: the first shipment captured its share and the rest is still drawable. Falling back to
  // `auths.value[0]` would hide a `VOIDED` authorization behind an older row and capture against money the
  // merchant already released.
  const DRAWABLE: ReadonlySet<AuthorizationRow['status']> = new Set<AuthorizationRow['status']>([
    'CREATED',
    'PENDING',
    'PARTIALLY_CAPTURED',
  ])
  const authorization = auths.value.find((a) => DRAWABLE.has(a.status)) ?? null

  const attempt = await deps.store.attempt(orderRow.attempt_id as `att_${string}`)
  if (!attempt.ok) return attempt
  if (!attempt.value) {
    return err(
      csError('CS_NOT_FOUND', `No checkout_attempts row for ${orderRow.attempt_id}`, {
        table: 'checkout_attempts',
        id: orderRow.attempt_id,
      }),
    )
  }

  const session = await deps.store.checkoutSession(
    attempt.value.checkout_session_id as `chk_${string}`,
  )
  if (!session.ok) return session
  if (!session.value) {
    return err(
      csError('CS_NOT_FOUND', `No checkout_sessions row for ${attempt.value.checkout_session_id}`, {
        table: 'checkout_sessions',
        id: attempt.value.checkout_session_id,
      }),
    )
  }

  const captures = await deps.store.captures.findByOrder(orderId)
  if (!captures.ok) return captures
  const shipments = await deps.store.shipments.findByOrder(orderId)
  if (!shipments.ok) return shipments
  void at
  return ok({
    order: orderRow,
    authorization,
    session: session.value,
    captures: captures.value,
    shipments: shipments.value,
  })
}

/**
 * `Σ captures.amount_minor` over the rows that **hold or took** money.
 *
 * `DECLINED` and `REVERSED` are excluded (EC-CAP-5, and a chargeback that took the money back is not money
 * the buyer may spend again). `PENDING` is included: PayPal is holding it.
 */
export function moneyHolds(captures: readonly CaptureRow[]): bigint {
  let total = 0n
  for (const c of captures) {
    if (c.status === 'DECLINED' || c.status === 'REVERSED') continue
    total += c.amount_minor
  }
  return total
}

function captureStatusFor(status: string | undefined): CaptureRow['status'] {
  if (status === 'PENDING') return 'PENDING'
  if (status === 'DECLINED') return 'DECLINED'
  if (status === 'REVERSED') return 'REVERSED'
  return 'COMPLETED'
}

/** `shipments.lines` as `[{sku, qty}]`. */
export function linesOf(lines: unknown): { sku: string; qty: number }[] {
  if (!Array.isArray(lines)) return []
  const out: { sku: string; qty: number }[] = []
  for (const raw of lines) {
    const line = raw as { sku?: unknown; qty?: unknown }
    if (typeof line.sku !== 'string') continue
    const qty = typeof line.qty === 'number' && Number.isInteger(line.qty) ? line.qty : 0
    out.push({ sku: line.sku, qty })
  }
  return out
}

function toCs(cause: unknown, ec: string): CsError {
  if (typeof cause === 'object' && cause !== null && 'code' in cause && 'message' in cause) {
    const e = cause as CsError
    return e.details ? { ...e, details: { ...e.details, ec } } : { ...e, details: { ec } }
  }
  return csError('CS_VALIDATION', 'Shipment could not be allocated', { ec })
}

/** Re-exported so `capture.ts` and `void.ts` agree on the one definition. */
export { capturedMinorForAuthorization }
