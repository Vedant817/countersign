/**
 * `GET /api/agent/paypal-order?id=…` — the demo order panel's "Re-read from PayPal" affordance.
 *
 * The UI shows a PayPal sandbox order id after an ALLOW (the demo money path, `lib/demo-order.ts`).
 * A judge watching the video should not have to take our word for what the order says: this route
 * re-reads the order **from PayPal itself** and returns what PayPal returns — status, amount,
 * `custom_id`. If the answer does not match what the UI claimed, the UI is wrong and the judge can
 * see it. That is the entire reason the button exists, and why it is a live call rather than a
 * database read (`lib/mcp-checkout.ts` explains the opposite choice for the merchant's own view;
 * here the point of the affordance is the third party's record, not ours).
 *
 * Guarded by the same demo gate as the order creation: this is a demo-deployment affordance, not a
 * public proxy for arbitrary PayPal reads.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { demoOrderPossible, rereadDemoOrder } from '@/lib/demo-order'

const idSchema = z.string().regex(/^[A-Z0-9]{17}$/, 'A PayPal order id is 17 characters, A–Z0–9.')

export async function GET(request: Request): Promise<NextResponse> {
  if (!demoOrderPossible()) {
    return NextResponse.json(
      {
        error:
          'The demo order path is off here: it needs COUNTERSIGN_AGENT_DEMO=1 and sandbox credentials.',
      },
      { status: 403 },
    )
  }
  const id = new URL(request.url).searchParams.get('id') ?? ''
  const parsed = idSchema.safeParse(id)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Not a PayPal order id.' }, { status: 400 })
  }
  const read = await rereadDemoOrder(parsed.data)
  if (!read.ok) {
    return NextResponse.json({ error: read.reason }, { status: 502 })
  }
  return NextResponse.json(
    {
      order: {
        id: read.value.id,
        status: read.value.status,
        intent: read.value.intent,
        custom_id: read.value.customId,
        amount:
          read.value.amountValue === null
            ? null
            : `${read.value.amountValue} ${read.value.currency ?? ''}`.trim(),
        create_time: read.value.createTime,
      },
      read_at: new Date().toISOString(),
      source: 'GET /v2/checkout/orders/{id} — PayPal sandbox, live',
    },
    // The order is created in this demo flow and re-read here; a short cache would be harmless,
    // but "no cache" is the honest default for something whose point is to show the current record.
    { headers: { 'cache-control': 'no-store' } },
  )
}

export const dynamic = 'force-dynamic'
