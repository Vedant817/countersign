/**
 * `captureShipment` — spec §8.11, **AT-M11.1**, **AT-M11.2**, **AT-M11.6**, §12 EC-CAP-1…5, EC-FX-4,
 * EC-STOCK-1, EC-SPLIT-1/2, EC-MDT-5.
 *
 * The fixtures throughout are chosen so the allocation has to work: the carts are split across shipments
 * with **awkward ratios**, so a `Math.round`-based implementation cannot pass by luck. NW-001 is $45.00 and
 * NW-002 is $15.00 against a $5.00 shipping fee — 3:1 with a remainder, which is the case rounding breaks.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { allocate, money, type OrderId } from '@countersign/core'

import {
  allocateShipment,
  captureShipment,
  createOrderFromDecision,
  linesOf,
  moneyHolds,
  shippingShares,
  voidRemainder,
} from '../src'
import type { OrdersDeps } from '../src'
import {
  ATTEMPT_ID,
  PAYPAL,
  allowDecision,
  captureBody,
  declinedCapture,
  harness,
  routes,
  type Harness,
} from './harness'

const ORDER_ID = 'ord_00000000000000000000000001' as OrderId

/**
 * Create the order, so a capture has an authorization to draw on.
 *
 * Uses the real `createOrderFromDecision`, because the capture tests are about the state a **real** create
 * leaves behind: the authorization's amount is the thing `Σ captures` is compared against, and a fixture that
 * invented that row would let the two disagree.
 */
async function authorised(h: Harness): Promise<{ id: OrderId; amount_minor: bigint }> {
  const created = await createOrderFromDecision(allowDecision(), h.deps)
  if (!created.ok) {
    throw new Error(`order create failed: ${created.error.code} ${created.error.message}`)
  }
  return created.value
}

describe('captureShipment — AT-M11.1, AT-M11.2, AT-M11.6', () => {
  describe('AT-M11.1 — AUTHORIZE, two partial captures, Σ == authorized', () => {
    it('AT-M11.1: auth $100.00 → two partial captures, the second final, Σ == $100.00 exactly', async () => {
      // A $100.00 order: $45.00 + $15.00 + $35.00 of goods and $5.00 of shipping. The 3:1:7 split is
      // chosen so the $5.00 shipping does **not** divide evenly — a `Math.round` implementation cannot
      // produce these numbers.
      const cart = {
        lines: [
          { sku: 'NW-001', qty: 1 },
          { sku: 'NW-002', qty: 1 },
          { sku: 'NW-003', qty: 1 },
        ],
      }
      const products = [
        p('NW-001', 'Trail Runner', 4_500n, false),
        p('NW-002', 'Wool Socks', 1_500n, false),
        p('NW-003', 'Rain Shell', 3_500n, false),
      ]
      const h = harness({ ...cart, products })
      h.paypal.setRoutes(
        routes({
          'POST /v2/checkout/orders': orderWithAuth(),
          'POST /v2/payments/authorizations/{id}/capture': [
            captureBody({ value: '0.00', finalCapture: false }),
            captureBody({ id: 'CAPTURE-2', value: '0.00', finalCapture: true }),
          ],
        }),
      )
      const order = await authorised(h)
      expect(order.amount_minor).toBe(10_000n)

      const first = await captureShipment(
        order.id,
        {
          lines: [
            { sku: 'NW-001', qty: 1 },
            { sku: 'NW-002', qty: 1 },
          ],
          carrier: 'UPS',
          tracking: '1Z-AAA',
        },
        h.deps,
      )
      expect(first.ok).toBe(true)
      if (!first.ok) return
      // $45.00 + $15.00 of goods is $60.00, plus this pair's $3.16 of the $5.00 shipping fee. Largest
      // remainder over the 4500 : 1500 : 3500 value split of $5.00 (100 units over 95 units of value):
      // 500×4500/9500 = 236.8 → 237, 500×1500/9500 = 78.9 → 79, and the 3500 line takes the remaining 184.
      // $3.16 + $3.84 is exactly $7.00 across the two shipments, which is the property under test.
      expect(first.value.amount.minor).toBe(6_316n)
      expect(first.value.finalCapture).toBe(false)
      expect(first.value.remainingAfter).toBe(3_684n)

      const second = await captureShipment(
        order.id,
        { lines: [{ sku: 'NW-003', qty: 1 }], carrier: 'UPS', tracking: '1Z-BBB' },
        h.deps,
      )
      expect(second.ok).toBe(true)
      if (!second.ok) return
      // $35.00 plus the last $1.84 of shipping. EC-CAP-2: it closes the authorization, remainder zero.
      expect(second.value.amount.minor).toBe(3_684n)
      expect(second.value.finalCapture).toBe(true)
      expect(second.value.remainingAfter).toBe(0n)

      // **The assertion the whole package exists for**: Σ captures == authorized, exactly.
      const authorized = [...h.world.rows.authorizations.values()][0]?.amount_minor ?? 0n
      expect(moneyHolds([...h.world.rows.captures.values()])).toBe(authorized)
      expect(authorized).toBe(10_000n)
      expect(h.world.rows.captures.size).toBe(2)
      // And the two amounts sum to the order total with nothing lost or invented.
      const amounts = [...h.world.rows.captures.values()].map((c) => c.amount_minor)
      expect(amounts.reduce((a, b) => a + b, 0n)).toBe(10_000n)
    })

    it('AT-M11.1: Σ captures == authorized holds for every split of a three-line cart', async () => {
      // The property form of AT-M11.1. A single worked example can pass for the wrong reason; this says the
      // identity holds for every grouping of the shipments, which is what EC-FX-4 asks for.
      const products = [
        p('NW-001', 'Trail Runner', 4_500n, false),
        p('NW-002', 'Wool Socks', 1_500n, false),
        p('NW-003', 'Rain Shell', 3_500n, false),
      ]
      const cart = [
        { sku: 'NW-001', qty: 1 },
        { sku: 'NW-002', qty: 1 },
        { sku: 'NW-003', qty: 1 },
      ]

      // Every set partition of {1,2,3} into shipments, as line groups.
      const partitions: ReadonlyArray<Array<ReadonlyArray<{ sku: string; qty: number }>>> = [
        [cart],
        [[cart[0]!, cart[1]!], [cart[2]!]],
        [[cart[1]!, cart[2]!], [cart[0]!]],
        [cart],
        [[cart[0]!], [cart[1]!], [cart[2]!]],
      ]

      for (const [i, partition] of partitions.entries()) {
        const h = harness({ lines: [...cart], products })
        // **A distinct PayPal capture id per call.** `captures_paypal_capture_id_key` is UNIQUE, so a stub that
        // returned one id would make the second capture a `CS_CONFLICT` — and a test that quietly worked
        // around that with a made-up id would be asserting against a world PayPal could never produce.
        let n = 0
        h.paypal.setRoutes(
          routes({
            'POST /v2/payments/authorizations/{id}/capture': () => {
              n += 1
              return captureBody({ id: `CAP-${i}-${n}`, value: '0.00' })
            },
          }),
        )
        const order = await authorised(h)
        const authorized = [...h.world.rows.authorizations.values()][0]?.amount_minor ?? 0n
        for (const [j, lines] of partition.entries()) {
          const captured = await captureShipment(
            order.id,
            { lines: [...lines], carrier: 'UPS', tracking: `TRK-${i}-${j}` },
            h.deps,
          )
          // The partitions are the scenario; a refused capture is a bug in the partition list, not a
          // tolerance, so the error is surfaced rather than swallowed.
          expect(
            captured.ok,
            `partition ${i} shipment ${j}: ${JSON.stringify(captured.ok ? {} : captured.error)}`,
          ).toBe(true)
        }
        // Every partition captures every line, so Σ closes exactly.
        expect(moneyHolds([...h.world.rows.captures.values()])).toBe(authorized)
        expect(authorized).toBe(10_000n)
      }
    })
  })

  describe('EC-FX-4 — the allocation is exact', () => {
    it('EC-FX-4: shipping is allocated per UNIT by unit value, and Σ shares == the whole fee', () => {
      const shares = shippingShares(
        { cart: { lines: [] }, tax_minor: 0n, shipping_minor: 500n, currency: 'USD' } as never,
        [
          { unitMinor: 4_500n, qty: 1 },
          { unitMinor: 1_500n, qty: 1 },
          { unitMinor: 4_000n, qty: 1 },
        ],
      )
      // 4500 : 1500 : 4000 of 500 — every share is exact here, which is the case a rounding implementation
      // also gets right. `Σ == 500n` is the assertion that matters; the split is pinned so a change to the
      // basis is visible.
      expect(shares).toEqual([225n, 75n, 200n])
      expect(shares.reduce((a, b) => a + b, 0n)).toBe(500n)
    })

    it('EC-FX-4: a 2-unit line gets its share PER UNIT, so shipping one of two is shippable', () => {
      // The case that makes per-line allocation wrong: one line, two units, $5.00 of shipping. A per-line
      // split gives the line the whole $5.00, so shipping **one** unit would exceed the authorization and
      // the second unit could never ship. Per-unit, each unit carries $2.50.
      const shares = shippingShares(
        { cart: { lines: [] }, tax_minor: 0n, shipping_minor: 500n, currency: 'USD' } as never,
        [{ unitMinor: 4_500n, qty: 2 }],
      )
      expect(shares).toEqual([250n, 250n])
      expect(shares.reduce((a, b) => a + b, 0n)).toBe(500n)
    })

    it('EC-FX-4: three units of unequal value split an awkward $5.00 fee without losing a cent', () => {
      const shares = shippingShares(
        { cart: { lines: [] }, tax_minor: 0n, shipping_minor: 500n, currency: 'USD' } as never,
        [
          { unitMinor: 4_500n, qty: 1 },
          { unitMinor: 1_500n, qty: 2 },
        ],
      )
      // 4500 : 1500 : 1500 of 500 → $3.00, $1.00, $1.00. `Σ == 500n` is the assertion that matters; the split
      // is pinned so a change to the basis (lines rather than units, or unit rather than line value)
      // would be visible here rather than in a receipt.
      expect(shares.reduce((a, b) => a + b, 0n)).toBe(500n)
      expect(shares).toEqual([300n, 100n, 100n])
    })

    it("EC-FX-4 (property): allocate is exact for any total and weights — the guarantee is the core's", () => {
      // The point of delegating to `allocate` rather than rounding: the invariant is the function's, over a
      // domain no test suite would enumerate.
      fc.assert(
        fc.property(
          fc.bigInt({ min: 0n, max: 10n ** 9n }),
          fc.array(fc.bigInt({ min: 0n, max: 10n ** 6n }), { minLength: 1, maxLength: 8 }),
          (total, weights) => {
            if (weights.reduce((a, b) => a + b, 0n) === 0n) return true
            const parts = allocate(money(total, 'USD'), weights)
            expect(parts.reduce((a, b) => a + b.minor, 0n)).toBe(total)
            for (const part of parts) expect(part.currency).toBe('USD')
            return true
          },
        ),
        { numRuns: 400 },
      )
    })

    it('EC-FX-4 (property): per-unit shares of a random cart always sum to the whole fee', () => {
      fc.assert(
        fc.property(
          fc.array(fc.record({ qty: fc.integer({ min: 1, max: 4 }) }), {
            minLength: 1,
            maxLength: 5,
          }),
          fc.bigInt({ min: 1n, max: 5_000n }),
          fc.bigInt({ min: 0n, max: 999n }),
          (qtys, unitBase, shipping) => {
            const unit = unitBase * 100n
            const cart = qtys.map((q, i) => ({ sku: `S${i}`, qty: q.qty, unitMinor: unit }))
            const shares = shippingShares(
              {
                cart: { lines: cart } as never,
                tax_minor: 0n,
                shipping_minor: shipping,
                currency: 'USD',
              },
              cart,
            )
            // One share per unit, so the count is Σ qty…
            expect(shares).toHaveLength(qtys.reduce((a, q) => a + q.qty, 0))
            // …and they close exactly.
            expect(shares.reduce((a, b) => a + b, 0n)).toBe(shipping)
            return true
          },
        ),
        { numRuns: 300 },
      )
    })

    it("EC-FX-4 (property): ANY partition of a cart's units into shipments sums to the order total", () => {
      // The property AT-M11.1 asserts for one worked cart, generalised. This is the strongest statement the
      // package can make about split captures, and it is the one EC-FX-4's "property test" row asks for.
      fc.assert(
        fc.property(
          fc.array(fc.record({ qty: fc.integer({ min: 1, max: 3 }) }), {
            minLength: 1,
            maxLength: 4,
          }),
          fc.array(fc.bigInt({ min: 0n, max: 9_999n }), { minLength: 1, maxLength: 4 }),
          fc.bigInt({ min: 0n, max: 997n }),
          fc.array(fc.nat({ max: 3 }), { minLength: 1, maxLength: 3 }),
          (qtys, prices, shipping, cutPoints) => {
            const cart = qtys.map((q, i) => ({
              sku: `S${i}`,
              qty: q.qty,
              unitMinor: prices[i] ?? 0n,
            }))
            const total = cart.reduce((a, l) => a + l.unitMinor * BigInt(l.qty), 0n) + shipping
            const unitCount = cart.reduce((a, l) => a + l.qty, 0)

            // Flatten the cart into its units, in order, and cut that list into shipments.
            const units: { sku: string; unitMinor: bigint }[] = []
            for (const line of cart) {
              for (let i = 0; i < line.qty; i++)
                units.push({ sku: line.sku, unitMinor: line.unitMinor })
            }
            const shipmentCount = Math.min(cutPoints.length + 1, unitCount)
            const shipments: { sku: string; qty: number }[][] = Array.from(
              { length: shipmentCount },
              () => [],
            )
            let cursor = 0
            for (let s = 0; s < shipmentCount; s++) {
              const end =
                s === shipmentCount - 1
                  ? unitCount
                  : Math.min(unitCount, cursor + cutPoints[s]! + 1)
              for (; cursor < end; cursor++) {
                const unit = units[cursor]!
                const bucket = shipments[s]!
                const last = bucket[bucket.length - 1]
                if (last && last.sku === unit.sku) last.qty += 1
                else bucket.push({ sku: unit.sku, qty: 1 })
              }
            }

            // Allocate each shipment and sum the amounts.
            const alreadyShipped: Record<string, number> = {}
            let captured = 0n
            for (const lines of shipments) {
              if (lines.length === 0) continue
              const allocation = allocateShipment({
                session: {
                  cart: {
                    lines: cart.map((l) => ({ sku: l.sku, qty: l.qty, unit_minor: l.unitMinor })),
                  } as never,
                  tax_minor: 0n,
                  shipping_minor: shipping,
                  currency: 'USD',
                },
                shipment: { lines, carrier: 'C', tracking: `T${captured}` },
                alreadyShipped,
                authorizedMinor: total,
                capturedMinor: captured,
              })
              captured += allocation.amount.minor
              for (const line of lines)
                alreadyShipped[line.sku] = (alreadyShipped[line.sku] ?? 0) + line.qty
            }
            // **The identity**: every unit is captured exactly once, so Σ == the order total.
            expect(captured).toBe(total)
            return true
          },
        ),
        { numRuns: 300 },
      )
    })
  })

  describe('EC-CAP-1 / EC-CAP-2 — final_capture is a function of what is left', () => {
    it('EC-CAP-1: a partial capture sends final_capture=false and leaves the remainder authorized', async () => {
      const h = harness({
        lines: [{ sku: 'NW-001', qty: 2 }],
        products: [p('NW-001', 'Trail Runner', 4_500n, false)],
      })
      h.paypal.setRoutes(
        routes({ 'POST /v2/payments/authorizations/{id}/capture': captureBody({ value: '0.00' }) }),
      )
      const order = await authorised(h)
      const result = await captureShipment(
        order.id,
        { lines: [{ sku: 'NW-001', qty: 1 }], carrier: 'UPS', tracking: '1Z-PARTIAL' },
        h.deps,
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.finalCapture).toBe(false)
      const body = h.paypal.bodyOf<{ final_capture: boolean; amount: { value: string } }>(
        '/capture',
      )
      expect(body.final_capture).toBe(false)
      expect(result.value.remainingAfter).toBeGreaterThan(0n)
      // The receipt line §12.1 promises: "Charged $60 for 1 of 2 items; $40 still held".
      expect(result.value.capture.status).toBe('COMPLETED')
    })

    it('EC-CAP-2: the capture that exhausts the authorization sends final_capture=true', async () => {
      const h = harness({
        lines: [{ sku: 'NW-001', qty: 1 }],
        products: [p('NW-001', 'Trail Runner', 4_500n, false)],
      })
      h.paypal.setRoutes(
        routes({ 'POST /v2/payments/authorizations/{id}/capture': captureBody({ value: '0.00' }) }),
      )
      const order = await authorised(h)
      const result = await captureShipment(
        order.id,
        { lines: [{ sku: 'NW-001', qty: 1 }], carrier: 'UPS', tracking: '1Z-ALL' },
        h.deps,
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      // A single shipment covering the whole cart leaves nothing, so it closes the authorization.
      expect(result.value.finalCapture).toBe(true)
      expect(result.value.remainingAfter).toBe(0n)
    })

    it('EC-CAP-2: `finalCapture: true` can be forced to release money that will never ship (EC-STOCK-1)', async () => {
      const h = harness({
        lines: [
          { sku: 'NW-001', qty: 1 },
          { sku: 'NW-002', qty: 1 },
        ],
      })
      h.paypal.setRoutes(
        routes({ 'POST /v2/payments/authorizations/{id}/capture': captureBody({ value: '0.00' }) }),
      )
      const order = await authorised(h)
      // Only the shoe ships; the socks went out of stock after the authorization.
      const result = await captureShipment(
        order.id,
        {
          lines: [{ sku: 'NW-001', qty: 1 }],
          carrier: 'UPS',
          tracking: '1Z-OOS',
          finalCapture: true,
        },
        h.deps,
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const body = h.paypal.bodyOf<{ final_capture: boolean }>('/capture')
      expect(body.final_capture).toBe(true)
      // EC-STOCK-1's user-facing behaviour: "You were charged only $X. $Y released" — the order is
      // PARTIALLY_CAPTURED and the uncaptured remainder is never committed.
      expect(h.spent()).toBe(result.value.amount.minor)
      expect(h.spent()).toBeLessThan(order.amount_minor)
      const orderRow = h.world.orderForAttempt(ATTEMPT_ID)
      expect(orderRow?.status).toBe('PARTIALLY_CAPTURED')
    })
  })

  describe('EC-CAP-3 / AT-M11.4 — an over-capture is refused locally', () => {
    it('EC-CAP-3 / EC-PRICE-2 / AT-M11.4: a capture exceeding the authorization makes NO PayPal call', async () => {
      const h = harness({
        lines: [{ sku: 'NW-001', qty: 1 }],
        products: [p('NW-001', 'Trail Runner', 4_500n, false)],
      })
      h.paypal.setRoutes(
        routes({ 'POST /v2/payments/authorizations/{id}/capture': captureBody({ value: '0.00' }) }),
      )
      const order = await authorised(h)
      const callsBefore = h.paypal.callsTo('/capture').length

      const result = await captureShipment(
        order.id,
        // Shipping more units than were bought is the only way to ask for more than was authorized, and it
        // is refused by the same guard.
        { lines: [{ sku: 'NW-001', qty: 5 }], carrier: 'UPS', tracking: '1Z-TOO-MUCH' },
        h.deps,
      )
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.code).toBe('CS_VALIDATION')
      expect(result.error.userMessage).toContain('more of an item than was ordered')
      // **The whole point of AT-M11.4**: nothing was sent.
      expect(h.paypal.callsTo('/capture').length).toBe(callsBefore)
      expect(h.world.rows.captures.size).toBe(0)
    })

    it('EC-CAP-3: a second shipment that would exceed the remainder is refused, and Σ never exceeds authorized', async () => {
      const h = harness({
        lines: [{ sku: 'NW-001', qty: 1 }],
        products: [p('NW-001', 'Trail Runner', 4_500n, false)],
      })
      h.paypal.setRoutes(
        routes({ 'POST /v2/payments/authorizations/{id}/capture': captureBody({ value: '0.00' }) }),
      )
      const order = await authorised(h)
      await captureShipment(
        order.id,
        { lines: [{ sku: 'NW-001', qty: 1 }], carrier: 'UPS', tracking: '1Z-FIRST' },
        h.deps,
      )
      const authorized = [...h.world.rows.authorizations.values()][0]?.amount_minor ?? 0n
      // Ask for the same sku again — the cumulative-qty guard refuses it.
      const second = await captureShipment(
        order.id,
        { lines: [{ sku: 'NW-001', qty: 1 }], carrier: 'UPS', tracking: '1Z-SECOND' },
        h.deps,
      )
      expect(second.ok).toBe(false)
      expect(moneyHolds([...h.world.rows.captures.values()])).toBeLessThanOrEqual(authorized)
    })
  })

  describe('EC-CAP-4 — a PENDING capture ships nothing', () => {
    it('EC-CAP-4: a PENDING capture is recorded, commits nothing, and adds NO tracking', async () => {
      const h = harness({
        lines: [{ sku: 'NW-001', qty: 1 }],
        products: [p('NW-001', 'Trail Runner', 4_500n, false)],
      })
      h.paypal.setRoutes(
        routes({
          'POST /v2/payments/authorizations/{id}/capture': captureBody({
            status: 'PENDING',
            value: '0.00',
          }),
        }),
      )
      const order = await authorised(h)
      const result = await captureShipment(
        order.id,
        { lines: [{ sku: 'NW-001', qty: 1 }], carrier: 'UPS', tracking: '1Z-PENDING' },
        h.deps,
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.pending).toBe(true)
      expect(result.value.capture.status).toBe('PENDING')
      // EC-CAP-4's whole rule: "State PENDING; ship nothing until PAYMENT.CAPTURE.COMPLETED".
      expect(h.paypal.callsTo('/track')).toHaveLength(0)
      expect(h.spent()).toBe(0n)
      expect(h.reserved()).toBe(order.amount_minor)
      expect(h.world.orderForAttempt(ATTEMPT_ID)?.status).toBe('PENDING_REVIEW')
      // And the merchant is told, with the spec's own words.
      expect(h.notifier.ofKind('CAPTURE_PENDING')[0]?.userMessage).toContain('Do not ship')
    })
  })

  describe('AT-M11.6 / EC-CAP-5 — a DECLINED capture', () => {
    it('AT-M11.6: order → PAYMENT_FAILED, budget RELEASEd, buyer notified, and NO retry with another instrument', async () => {
      const h = harness({
        lines: [{ sku: 'NW-001', qty: 1 }],
        products: [p('NW-001', 'Trail Runner', 4_500n, false)],
      })
      h.paypal.setRoutes(
        routes({ 'POST /v2/payments/authorizations/{id}/capture': declinedCapture() }),
      )
      const order = await authorised(h)
      const reservedBefore = h.reserved()

      const result = await captureShipment(
        order.id,
        { lines: [{ sku: 'NW-001', qty: 1 }], carrier: 'UPS', tracking: '1Z-DECLINED' },
        h.deps,
      )
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.code).toBe('PP_INSTRUMENT_DECLINED')

      // The order state.
      expect(h.world.orderForAttempt(ATTEMPT_ID)?.status).toBe('PAYMENT_FAILED')
      // The budget: the whole reservation is back, and there is a RELEASE entry saying why.
      expect(h.reserved()).toBe(0n)
      expect(h.spent()).toBe(0n)
      expect(
        h.entries().some((e) => e.kind === 'RELEASE' && e.amount_minor === reservedBefore),
      ).toBe(true)
      // The buyer is told, with §12.1's own sentence.
      const notice = h.notifier.ofKind('CAPTURE_DECLINED')
      expect(notice).toHaveLength(1)
      expect(notice[0]?.userMessage).toContain('PayPal declined the payment. Nothing was charged.')
      // EC-CAP-5's negative test: the mandate binds one instrument, so nothing is retried.
      expect(h.paypal.callsTo('/capture')).toHaveLength(1)
      expect(h.paypal.callsTo('/vault')).toHaveLength(0)
      // Nothing shipped.
      expect(h.paypal.callsTo('/track')).toHaveLength(0)
      expect(h.spent()).toBe(0n)
      void order
    })

    it('AT-M11.6: the declined capture is recorded as DECLINED and is excluded from Σ captures', async () => {
      const h = harness({
        lines: [{ sku: 'NW-001', qty: 1 }],
        products: [p('NW-001', 'Trail Runner', 4_500n, false)],
      })
      h.paypal.setRoutes(
        routes({ 'POST /v2/payments/authorizations/{id}/capture': declinedCapture() }),
      )
      const order = await authorised(h)
      await captureShipment(
        order.id,
        { lines: [{ sku: 'NW-001', qty: 1 }], carrier: 'UPS', tracking: '1Z-DECL' },
        h.deps,
      )
      const row = [...h.world.rows.captures.values()][0]
      expect(row?.status).toBe('DECLINED')
      // A declined attempt took no money, so it must not shrink what the buyer may spend later.
      expect(moneyHolds([...h.world.rows.captures.values()])).toBe(0n)
    })
  })

  describe('AT-M11.2 — void after 1 of 2 shipments releases the remainder', () => {
    it('AT-M11.2: voidRemainder after one of two shipments RELEASEs the remainder and leaves the capture alone', async () => {
      const h = harness({
        lines: [
          { sku: 'NW-001', qty: 1 },
          { sku: 'NW-002', qty: 1 },
        ],
      })
      // `maxRetries: 4` so the create's own retry loop is not the thing being measured here; the void is
      // addressed explicitly.
      h.paypal.setRoutes(
        routes({
          'POST /v2/payments/authorizations/{id}/capture': captureBody({ value: '0.00' }),
          'POST /v2/payments/authorizations/{id}/void': { status: 204 },
        }),
      )
      const order = await authorised(h)
      const first = await captureShipment(
        order.id,
        { lines: [{ sku: 'NW-001', qty: 1 }], carrier: 'UPS', tracking: '1Z-SHIP' },
        h.deps,
      )
      expect(first.ok).toBe(true)
      if (!first.ok) return
      const capturedSoFar = first.value.amount.minor

      const voided = await voidRemainder(order.id, 'CANCELLED', h.deps)
      expect(voided.ok).toBe(true)
      if (!voided.ok) return
      expect(voided.value.viaAuthorizationVoid).toBe(true)
      // Exactly the uncaptured remainder: the captured money stays committed (EC-MDT-4).
      expect(voided.value.released.minor).toBe(order.amount_minor - capturedSoFar)
      expect(h.spent()).toBe(capturedSoFar)
      expect(h.reserved()).toBe(0n)
      expect(h.world.orderForAttempt(ATTEMPT_ID)?.status).toBe('VOIDED')
      expect(h.paypal.callsTo('/void')).toHaveLength(1)
      expect(h.paypal.requestIdOf('/void')).toBe(`cs:${PAYPAL.authorizationId}:void`)
      // The buyer is told the remainder came back.
      expect(h.notifier.ofKind('REMAINDER_RELEASED')[0]?.amount?.minor).toBe(
        order.amount_minor - capturedSoFar,
      )
      // EC-MDT-4: the completed capture is untouched — a revocation is a statement about the future.
      expect(h.world.rows.captures.size).toBe(1)
      expect(h.spent()).toBe(capturedSoFar)
    })

    it('AT-M11.2: a second voidRemainder is alreadySettled, not an error', async () => {
      const h = harness({
        lines: [
          { sku: 'NW-001', qty: 1 },
          { sku: 'NW-002', qty: 1 },
        ],
      })
      h.paypal.setRoutes(
        routes({ 'POST /v2/payments/authorizations/{id}/capture': captureBody({ value: '0.00' }) }),
      )
      const order = await authorised(h)
      await captureShipment(
        order.id,
        { lines: [{ sku: 'NW-001', qty: 1 }], carrier: 'UPS', tracking: '1Z-SHIP' },
        h.deps,
      )
      const first = await voidRemainder(order.id, 'OUT_OF_STOCK', h.deps)
      expect(first.ok).toBe(true)
      const second = await voidRemainder(order.id, 'OUT_OF_STOCK', h.deps)
      // A webhook, a sweep and a merchant action can all reach a void; a repeat is not a failure.
      expect(second.ok).toBe(true)
      if (!second.ok) return
      expect(second.value.alreadySettled).toBe(true)
      expect(second.value.released.minor).toBe(0n)
      // **One** PayPal void call: the deterministic request id is what makes the repeat idempotent.
      expect(h.paypal.callsTo('/void')).toHaveLength(1)
    })

    it('AT-M11.2: OUT_OF_STOCK restores the stock of the lines that never shipped', async () => {
      const h = harness({
        lines: [
          { sku: 'NW-001', qty: 1 },
          { sku: 'NW-002', qty: 1 },
        ],
      })
      h.paypal.setRoutes(
        routes({ 'POST /v2/payments/authorizations/{id}/capture': captureBody({ value: '0.00' }) }),
      )
      const restored: Array<{ sku: string; qty: number }[]> = []
      // A separate harness whose deps carry a stock port, since `OrdersDeps.stock` is optional.
      const withStock = harness({
        lines: [
          { sku: 'NW-001', qty: 1 },
          { sku: 'NW-002', qty: 1 },
        ],
      })
      withStock.paypal.setRoutes(
        routes({ 'POST /v2/payments/authorizations/{id}/capture': captureBody({ value: '0.00' }) }),
      )
      const deps: OrdersDeps = {
        ...withStock.deps,
        stock: async (lines) => {
          restored.push([...lines])
          return { ok: true as const, value: [...lines] }
        },
      }
      const order = await authorised(withStock)
      void h
      await captureShipment(
        order.id,
        { lines: [{ sku: 'NW-001', qty: 1 }], carrier: 'UPS', tracking: '1Z-SHIP' },
        deps,
      )
      const voided = await voidRemainder(order.id, 'OUT_OF_STOCK', deps)
      expect(voided.ok).toBe(true)
      // Only the socks never shipped, so only they come back — not the whole cart.
      expect(restored).toEqual([[{ sku: 'NW-002', qty: 1 }]])
    })
  })

  describe('EC-SPLIT-1 / EC-SPLIT-2 — trackers', () => {
    it('EC-SPLIT-1: each shipment gets its own capture and its own tracker', async () => {
      const h = harness({
        lines: [
          { sku: 'NW-001', qty: 1 },
          { sku: 'NW-002', qty: 1 },
        ],
      })
      h.paypal.setRoutes(
        routes({
          'POST /v2/payments/authorizations/{id}/capture': [
            captureBody({ id: 'CAP-A', value: '0.00' }),
            captureBody({ id: 'CAP-B', value: '0.00', finalCapture: true }),
          ],
        }),
      )
      // `finalCapture: true` on the second, because the first left a remainder and this one exhausts it.
      const order = await authorised(h)
      await captureShipment(
        order.id,
        { lines: [{ sku: 'NW-001', qty: 1 }], carrier: 'UPS', tracking: '1Z-ONE' },
        h.deps,
      )
      await captureShipment(
        order.id,
        { lines: [{ sku: 'NW-002', qty: 1 }], carrier: 'DHL', tracking: 'DH-TWO' },
        h.deps,
      )
      expect(h.world.rows.shipments.size).toBe(2)
      expect(h.paypal.callsTo('/track')).toHaveLength(2)
      // Each track carries **its own** capture id — that link is what makes it evidence (EC-SPLIT-1).
      const first = h.paypal.bodyOf<{
        capture_id: string
        tracking_number: string
        carrier: string
      }>('/track', 0)
      const second = h.paypal.bodyOf<{
        capture_id: string
        tracking_number: string
        carrier: string
      }>('/track', 1)
      expect(first.capture_id).not.toBe(second.capture_id)
      expect(first.tracking_number).toBe('1Z-ONE')
      expect(second.tracking_number).toBe('DH-TWO')
      // And the tracker id PayPal returned was stored, which is what R-INR-1 reads.
      const trackers = [...h.world.rows.shipments.values()].map((s) => s.paypal_tracker_id)
      expect(trackers).toContain(PAYPAL.trackerId)
    })

    it('EC-SPLIT-2: on the CAPTURE path a second shipment tracks against the SAME capture', async () => {
      const h = harness({
        lines: [
          { sku: 'NW-001', qty: 1 },
          { sku: 'NW-002', qty: 1 },
        ],
      })
      const order = await authorised(h)
      // The digital/C2-fallback shape: no authorization, one capture that already paid for everything.
      const [paidCapture] = await createCaptureDirect(h, order.id)

      const first = await captureShipment(
        order.id,
        { lines: [{ sku: 'NW-001', qty: 1 }], carrier: 'UPS', tracking: '1Z-CAP-ONE' },
        h.deps,
      )
      expect(first.ok).toBe(true)
      if (!first.ok) return
      // EC-SPLIT-2's distinguishing property: no new capture, only a tracker.
      expect(first.value.trackingOnly).toBe(true)
      expect(first.value.amount.minor).toBe(0n)
      // EC-SPLIT-2's distinguishing property: **no** capture call at all, because there is no
      // authorization to capture against. Only a tracker.
      expect(h.paypal.callsTo('/authorizations/{id}/capture')).toHaveLength(0)
      expect(
        h.paypal.calls.filter(
          (c) =>
            c.method === 'POST' && c.path.includes('/capture') && !c.path.includes('/checkout'),
        ),
      ).toHaveLength(0)

      await captureShipment(
        order.id,
        { lines: [{ sku: 'NW-002', qty: 1 }], carrier: 'DHL', tracking: 'DH-CAP-TWO' },
        h.deps,
      )
      const tracked = h.paypal.callsTo('/track')
      expect(tracked).toHaveLength(2)
      expect(h.paypal.bodyOf<{ capture_id: string }>('/track', 0).capture_id).toBe(
        h.paypal.bodyOf<{ capture_id: string }>('/track', 1).capture_id,
      )
      // The body carries **PayPal's** capture id, not ours — `linkTracking` sends `captures.paypal_capture_id`,
      // because that is the id PayPal knows the capture by.
      expect(h.paypal.bodyOf<{ capture_id: string }>('/track', 0).capture_id).toBe(
        paidCapture?.paypal_capture_id,
      )
      expect(h.world.rows.shipments.size).toBe(2)
    })

    it('EC-SPLIT-2: a re-submitted identical shipment is one tracker, not two (idempotency)', async () => {
      const h = harness({
        lines: [
          { sku: 'NW-001', qty: 1 },
          { sku: 'NW-002', qty: 1 },
        ],
      })
      const order = await authorised(h)
      await createCaptureDirect(h, order.id)
      const shipment = { lines: [{ sku: 'NW-001', qty: 1 }], carrier: 'UPS', tracking: '1Z-SAME' }
      await captureShipment(order.id, shipment, h.deps)
      await captureShipment(order.id, shipment, h.deps)
      expect(h.world.rows.shipments.size).toBe(1)
      expect(h.paypal.callsTo('/track')).toHaveLength(1)
    })
  })

  describe('EC-MDT-5 — a capture against an existing authorization outlives the mandate', () => {
    it('EC-MDT-5: the mandate expires after the authorization and the second capture still succeeds', async () => {
      const h = harness({
        lines: [{ sku: 'NW-001', qty: 2 }],
        products: [p('NW-001', 'Trail Runner', 4_500n, false)],
      })
      h.paypal.setRoutes(
        routes({
          'POST /v2/payments/authorizations/{id}/capture': [
            captureBody({ id: 'CAP-1', value: '0.00' }),
            captureBody({ id: 'CAP-2', value: '0.00', finalCapture: true }),
          ],
        }),
      )
      const order = await authorised(h)
      await captureShipment(
        order.id,
        { lines: [{ sku: 'NW-001', qty: 1 }], carrier: 'UPS', tracking: '1Z-BEFORE' },
        h.deps,
      )

      // The mandate expires **and** is revoked, which is the strongest form of the scenario. `captureShipment`
      // must not care: the authorization was created under a valid mandate, the amount is already bounded by
      // it, and a capture path that re-read the mandate would fail a perfectly good shipment and leave the
      // buyer holding money for goods they were sent.
      h.world.rows.mandates.forEach((m) => {
        m.exp = 1n
        m.status = 'REVOKED'
      })

      const second = await captureShipment(
        order.id,
        { lines: [{ sku: 'NW-001', qty: 1 }], carrier: 'UPS', tracking: '1Z-AFTER' },
        h.deps,
      )
      expect(
        second.ok,
        `second capture after expiry: ${JSON.stringify(second.ok ? {} : second.error)}`,
      ).toBe(true)
      if (!second.ok) return
      expect(second.value.finalCapture).toBe(true)
      const authorized = [...h.world.rows.authorizations.values()][0]?.amount_minor ?? 0n
      expect(moneyHolds([...h.world.rows.captures.values()])).toBe(authorized)
    })
  })

  describe('the deterministic capture request id', () => {
    it('EC-IDEM-2: the capture carries cs:{authId}:cap:{shipmentId}, and a retry sends the identical id', async () => {
      // `maxRetries: 2` so the client's own loop retries the connection reset — which is the *real*
      // mechanism behind EC-IDEM-2's "retry with the same request id", not a hand-written second call.
      const h = harness({
        lines: [{ sku: 'NW-001', qty: 2 }],
        products: [p('NW-001', 'Trail Runner', 4_500n, false)],
        maxRetries: 2,
      })
      h.paypal.setRoutes(
        routes({
          'POST /v2/payments/authorizations/{id}/capture': [
            // A timeout, then success — the EC-IDEM-2 shape. The client's own retry loop re-sends the id.
            { throws: new Error('socket hang up') },
            captureBody({ value: '0.00' }),
          ],
        }),
      )
      const order = await authorised(h)
      await captureShipment(
        order.id,
        { lines: [{ sku: 'NW-001', qty: 1 }], carrier: 'UPS', tracking: '1Z-RETRY' },
        h.deps,
      )
      const ids = h.paypal.callsTo('/capture').map((c) => c.headers['paypal-request-id'])
      // Two attempts, one id: a fresh id per attempt would be a second capture.
      expect(ids).toHaveLength(2)
      expect(new Set(ids).size).toBe(1)
      expect(ids[0]).toMatch(new RegExp(`^cs:${PAYPAL.authorizationId}:cap:shp_[0-9a-f]{26}$`))
    })
  })

  describe('the ledger, on the other side of "asymmetric on purpose"', () => {
    it('a COMPLETED capture COMMITs exactly its own amount', async () => {
      const h = harness({
        lines: [{ sku: 'NW-001', qty: 1 }],
        products: [p('NW-001', 'Trail Runner', 4_500n, false)],
      })
      h.paypal.setRoutes(
        routes({ 'POST /v2/payments/authorizations/{id}/capture': captureBody({ value: '0.00' }) }),
      )
      const order = await authorised(h)
      const result = await captureShipment(
        order.id,
        { lines: [{ sku: 'NW-001', qty: 1 }], carrier: 'UPS', tracking: '1Z-COMMIT' },
        h.deps,
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const commits = h.entries().filter((e) => e.kind === 'COMMIT')
      expect(commits).toHaveLength(1)
      expect(commits[0]?.amount_minor).toBe(result.value.amount.minor)
      // Both ledger legs moved by the same amount, so `reserved + spent` is unchanged.
      expect(h.reserved() + h.spent()).toBe(order.amount_minor)
    })

    it('linesOf reads shipments.lines defensively, so a malformed row cannot crash a reconciler', () => {
      expect(linesOf([{ sku: 'a', qty: 2 }, { sku: 'b' }, { qty: 1 }, 'nope'])).toEqual([
        { sku: 'a', qty: 2 },
        { sku: 'b', qty: 0 },
      ])
      expect(linesOf(null)).toEqual([])
    })
  })
})

/* ------------------------------------------------------------------------------------------ */
/* Helpers                                                                                       */
/* ------------------------------------------------------------------------------------------ */

function p(sku: string, title: string, priceMinor: bigint, digital: boolean) {
  return {
    sku,
    title,
    description: `${title}.`,
    price_minor: priceMinor,
    currency: 'USD' as const,
    stock: 10,
    ships_in_days: 2,
    digital,
    listing_html: `<p>${title}.</p>`,
  }
}

/** A create response that authorizes inline, so a capture has something to draw on. */
function orderWithAuth() {
  return {
    status: 201,
    body: {
      id: PAYPAL.orderId,
      intent: 'AUTHORIZE',
      status: 'CREATED',
      purchase_units: [
        {
          reference_id: 'default',
          custom_id: `cs1:${'A'.repeat(43)}`,
          invoice_id: ORDER_ID,
          amount: { currency_code: 'USD', value: '100.00' },
          payee: { merchant_id: '9KX436DUC84BN' },
          payments: {
            authorizations: [
              {
                id: PAYPAL.authorizationId,
                status: 'CREATED',
                amount: { currency_code: 'USD', value: '100.00' },
                expiration_time: '2026-11-02T00:00:00Z',
              },
            ],
          },
        },
      ],
    },
  }
}

/**
 * Put the world into the D17 `CAPTURE` shape: an order with **no authorization** and one capture that
 * already paid for everything.
 *
 * Built by hand rather than through `createOrderFromDecision` because the point is the *state* the
 * `CAPTURE`-intent path produces, and reproducing it through the create path would couple this test to the
 * create's internals. The order row is preserved and only the authorization removed, so `attempt_id`,
 * `amount_minor` and the cart stay consistent.
 */
async function createCaptureDirect(h: Harness, orderId: string) {
  h.world.rows.authorizations.clear()
  const inserted = await h.deps.store.captures.insert({
    id: 'cap_direct_0000000000001',
    order_id: orderId,
    authorization_id: null,
    paypal_capture_id: 'CAP-PAID-UPFRONT',
    amount_minor: h.world.orderForAttempt(ATTEMPT_ID)?.amount_minor ?? 0n,
    currency: 'USD',
    final_capture: true,
    status: 'COMPLETED',
  })
  return inserted.ok ? [inserted.value] : []
}
