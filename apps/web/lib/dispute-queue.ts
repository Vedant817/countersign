/**
 * The real dispute queue behind `/disputes`: rows this process ingested, and nothing else.
 *
 * ## Why this file exists
 *
 * `/disputes` used to render two **fixture** disputes from `lib/defender-demo.ts` — PayPal ids,
 * captures and all — with a SIMULATED banner, because the Defender pipeline could not be shown without
 * a captured payment. That is the right answer for a demo and the wrong answer for a page a merchant
 * opens: a fixture is indistinguishable from a finding unless the reader trusts a banner, and the day a
 * real dispute *is* ingested the page would still show the fixtures above it.
 *
 * So the page now has two branches, and this file is the honest one:
 *
 *  1. `COUNTERSIGN_AGENT_DEMO=1` and not production → the demo cases (unchanged, still labelled).
 *  2. otherwise → **only rows in `disputes`**, read here, with the router's own verdict where the
 *     router has run and `null` where it has not.
 *
 * ## What it deliberately does not do
 *
 * It does not re-run the router. `disputes.liability` and `disputes.router_trace` are the *stored*
 * decision (`packages/defender/src/ingest.ts` writes them); a page that re-derived a verdict from the
 * row would be a second implementation of §8.15 and the two would drift the first time a rule changed.
 * A row with `liability === null` says "not assessed yet", which is the truth and is rendered as such.
 *
 * It does not fabricate an order either: a dispute PayPal could not be joined to one of our captures
 * (EC-DSP-9, `order_id === null`) is shown as unlinked, because that is what it is.
 *
 * ## The bound
 *
 * `limit` is required. An unbounded read of a table that grows with every PayPal dispute is fine on day
 * one and an outage in year two.
 */
import type { CsError, Currency, OrderId, Result } from '@countersign/core'
import {
  findLatestPacketForDispute,
  findOrderById,
  listDisputeActions,
  listDisputesForMerchant,
  type DisputeRow,
} from '@countersign/db'

/** How many disputes one page shows. The page states it, so the query and the copy cannot disagree. */
export const DISPUTE_QUEUE_LIMIT = 25

/**
 * Which branch `/disputes` renders: the fixture demo, or the rows in `disputes`.
 *
 * The rule is `agentDemoAllowed()`'s — `COUNTERSIGN_AGENT_DEMO=1` **and** `NODE_ENV !== 'production'` —
 * restated here as a named decision so a test can pin it. It matters more than it looks: a fixture
 * dispute rendered on a merchant's page is a lie the layout tells well, and `next start` sets
 * `NODE_ENV=production`, so the demo branch cannot be reached in a deployed build even with the flag on.
 */
export function disputesUseDemoView(): boolean {
  return process.env.COUNTERSIGN_AGENT_DEMO === '1' && process.env.NODE_ENV !== 'production'
}

/** What the page needs to say about one dispute, and nothing it cannot source from a column. */
export interface DisputeQueueRow {
  readonly id: string
  readonly paypalDisputeId: string
  readonly reason: string
  readonly stage: string
  readonly status: string
  readonly amountMinor: bigint
  readonly currency: Currency
  /** RFC 3339 → `Date`; `null` when PayPal gave us no deadline. Rendered in IST at the edge. */
  readonly sellerResponseDueAt: Date | null
  readonly defenseState: string
  readonly liability: string | null
  /** The rule id from `router_trace`, read out of the stored trace rather than re-derived. */
  readonly ruleId: string | null
  readonly orderId: OrderId | null
  readonly orderStatus: string | null
  readonly packetId: string | null
  readonly actions: number
}

/**
 * The rule id inside a stored `router_trace`, or `null`.
 *
 * §8.15 stores "rule id + the facts it compared", and the shape is the router's rather than a column's,
 * so this reads the one member the page shows and treats anything unexpected as "no trace" instead of
 * throwing: a page that 500s because a trace gained a member is worse than a page that omits a line.
 */
export function routerRuleId(trace: DisputeRow['router_trace']): string | null {
  if (trace === null || typeof trace !== 'object') return null
  const record = trace as Record<string, unknown>
  const rule = record['ruleId'] ?? record['rule_id'] ?? record['rule']
  return typeof rule === 'string' && rule !== '' ? rule : null
}

/**
 * Read the merchant's dispute queue.
 *
 * Sequential per row on purpose: the list query is one round trip, and the two per-row reads are the
 * packet and the action count. At {@link DISPUTE_QUEUE_LIMIT} that is 51 queries worst case, which is a
 * page load; batching them would mean three `in (...)` queries and a join in JavaScript, which is more
 * code than the bound saves. The bound is what keeps it a page load.
 */
export async function loadDisputeQueue(
  merchantId: string,
  limit: number = DISPUTE_QUEUE_LIMIT,
): Promise<Result<DisputeQueueRow[], CsError>> {
  const listed = await listDisputesForMerchant(merchantId, limit)
  if (!listed.ok) return listed

  const rows: DisputeQueueRow[] = []
  for (const dispute of listed.value) {
    // The column is `text` and the id is branded: the same cast `packages/defender` makes at its own
    // boundaries. `order_id` is written only from a matched order row, so a non-null value is an order.
    const orderId = dispute.order_id === null ? null : (dispute.order_id as OrderId)
    const [packet, actions, order] = await Promise.all([
      findLatestPacketForDispute(dispute.id),
      listDisputeActions(dispute.id),
      orderId === null
        ? Promise.resolve({ ok: true as const, value: undefined })
        : findOrderById(orderId),
    ])

    // A per-row read that fails is a page that cannot state the row honestly. Propagate it rather than
    // rendering a row with an invented packet id or a zeroed action count.
    if (!packet.ok) return packet
    if (!actions.ok) return actions
    if (!order.ok) return order

    rows.push({
      id: dispute.id,
      paypalDisputeId: dispute.paypal_dispute_id,
      reason: dispute.reason,
      stage: dispute.stage,
      status: dispute.status,
      amountMinor: dispute.amount_minor,
      currency: dispute.currency as Currency,
      sellerResponseDueAt: dispute.seller_response_due_date,
      defenseState: dispute.defense_state,
      liability: dispute.liability,
      ruleId: routerRuleId(dispute.router_trace),
      orderId,
      orderStatus: order.value?.status ?? null,
      packetId: packet.value?.id ?? null,
      actions: actions.value.length,
    })
  }

  return { ok: true, value: rows }
}
