/**
 * The production `DefenderStore` adapter over `@countersign/db` — spec **§8.15/§8.16**, **§7.2/§7.3**.
 *
 * ## Why this file exists
 *
 * Nothing called `orchestrator.ingestAndDefend` in production, so real disputes were stored and ranked
 * by the 2-minute sweep and then sat there: `liability` stayed `null` for ever and `/disputes` showed
 * "not assessed yet" for a case PayPal had been waiting on for weeks. The orchestrator's function was
 * finished, tested and exported — this adapter is the last wiring it was missing.
 *
 * ## The rule this file obeys: no logic, only naming
 *
 * Every member is a **rename and forward** to the `packages/db` repository its doc comment names — the
 * same rule `adapters.ts` states for the webhook store. The rank decision, the router, the filing
 * guards and the idempotency checks all live in `packages/defender`; a second implementation of any of
 * them here would be a bug waiting for the first drift.
 *
 * The three members that are *not* pure forwards:
 *
 * - **`transaction`** is `client.withTx`, whose contract is exactly the port's: a thrown `CsError`
 *   rolls back, a returned `err(...)` commits (§8.12's "a business refusal is data, not a fault").
 * - **`evidence.corpus` / `evidence.policy`** return `{}` — the port's own documented "unknown"
 *   answer, whose conservative defaults are the safe direction (a corpus we cannot read never reads
 *   as "we proved the documents exist"). No repository computes either yet; when one does, these
 *   become forwards.
 * - **`evidence.bundle`** assembles §7.3's bundle from five tables — `orders` → `checkout_attempts`
 *   → `mandates` / `checkout_sessions` / `gate_decisions`, plus `l1_credentials`, `captures` and
 *   `shipments` for the members PayPal added after order creation. No single-row getter exists, and
 *   every field it reads is a `notNull` column, so a missing row here is broken data and answers
 *   `CS_NOT_FOUND` rather than a fabricated default.
 *
 * ## Nothing connects at import time
 *
 * Same rule as `adapters.ts` (WORKER-3): `db()` resolves its pool lazily, so importing `apps/worker`
 * from `apps/web`'s webhook route still opens no socket.
 */
import { err, csError, ok, type CsError, type Result } from '@countersign/core'
import type {
  AttemptId,
  CheckoutId,
  DeviceId,
  DisputeId,
  MandateId,
  OrderId,
  PacketId,
} from '@countersign/core'
import type {
  DefenderRefunds,
  DefenderStore,
  DefenderTx,
  EvidenceBundle,
  LineFact,
  UpsertDisputeInput,
} from '@countersign/defender'
import {
  createDispute,
  createEvidencePacket,
  findAttemptById,
  findCaptureById,
  findCaptureByPaypalId,
  findCapturesByOrder,
  findCheckoutSessionById,
  findDeviceById,
  findDisputeActionByIdempotencyKey,
  findDisputeById,
  findDisputeByPaypalId,
  findL1ForDeviceWallet,
  findLatestDecisionForAttempt,
  findLatestPacketForDispute,
  findMandateById,
  findOrderByAttempt,
  findOrderByCustomId,
  findOrderById,
  findPacketById,
  findRefundsByCapture,
  findShipmentsByOrder,
  listBySubject,
  listDisputeActions,
  listEvidencePacketsForDispute,
  linkDisputeToOrder,
  markPacketFiled,
  attachPdf,
  recordDisputeAction,
  setDefenseState,
  setLiability,
  upsertDisputeFromFetch,
  withTx,
  type DisputeLiability,
  type NewDispute,
  type NewDisputeAction,
  type NewEvidencePacket,
  type OrderRow,
  type CheckoutAttemptRow,
  type MandateRow,
  type CheckoutSessionRow,
  type GateDecisionRow,
  type L1Row,
  type ShipmentRow,
  type CaptureRow,
} from '@countersign/db'

/* ============================================================================================ */
/* 1. The store                                                                                       */
/* ============================================================================================ */

/**
 * The production `DefenderStore`.
 *
 * `ingestDisputeToDefender` re-fetches through its own PayPal port and reads everything else through
 * this interface, so this object plus `webhooks.paypal` is the whole of what a real dispute needs.
 */
export function dbDefenderStore(): DefenderStore {
  return {
    transaction: <T>(fn: (tx: DefenderTx) => Promise<T>) => withTx(fn),

    disputes: {
      findById: (id, tx) => findDisputeById(id as DisputeId, tx),
      findByPaypalId: (paypalDisputeId, tx) => findDisputeByPaypalId(paypalDisputeId, tx),
      upsertFromFetch: (input: UpsertDisputeInput, tx) => upsertDisputeFromFetch(input, tx),
      insert: (input: NewDispute, tx) => createDispute(input, tx),
      linkToOrder: (id, link, at, tx) => linkDisputeToOrder(id as DisputeId, link, at, tx),
      setLiability: (id, liability, routerTrace, at, tx) =>
        setLiability(id as DisputeId, liability as DisputeLiability, routerTrace, at, tx),
      setDefenseState: (id, state, at, tx) => setDefenseState(id as DisputeId, state, at, tx),
    },

    orders: {
      findById: (id, tx) => findOrderById(id as OrderId, tx),
      findByCustomId: (customId, tx) => findOrderByCustomId(customId, tx),
      findByAttempt: (attemptId, tx) => findOrderByAttempt(attemptId, tx),
    },

    captures: {
      findById: (id, tx) => findCaptureById(id, tx),
      findByPaypalId: (paypalCaptureId, tx) => findCaptureByPaypalId(paypalCaptureId, tx),
      findByOrder: (orderId, tx) => findCapturesByOrder(orderId as OrderId, tx),
    },

    refunds: {
      findByCapture: (captureId, tx) => findRefundsByCapture(captureId, tx),
    },

    shipments: {
      findByOrder: (orderId, tx) => findShipmentsByOrder(orderId as OrderId, tx),
    },

    attempts: {
      findById: (id, tx) => findAttemptById(id as AttemptId, tx),
    },

    mandates: {
      findById: (id, tx) => findMandateById(id as MandateId, tx),
    },

    checkoutSessions: {
      findById: (id, tx) => findCheckoutSessionById(id as CheckoutId, tx),
    },

    gate: {
      findForAttempt: (attemptId, tx) => findLatestDecisionForAttempt(attemptId as AttemptId, tx),
    },

    devices: {
      findById: (id, tx) => findDeviceById(id as DeviceId, tx),
    },

    audit: {
      listBySubject: (subject, tx) => listBySubject(subject, tx),
    },

    evidence: {
      corpus: () => Promise.resolve(ok({})),
      policy: () => Promise.resolve(ok({})),
      bundle: (orderId, tx) => evidenceBundleFor(orderId as OrderId, tx),
      l1Credential: async (deviceId, walletId, tx) => {
        const found = await findL1ForDeviceWallet(deviceId, walletId, tx)
        if (!found.ok) return found
        const row: L1Row | undefined = found.value
        return row === undefined ? ok(undefined) : ok({ sdJwt: row.sd_jwt })
      },
    },

    packets: {
      findById: (id: PacketId, tx) => findPacketById(id, tx),
      latestForDispute: (disputeId, tx) => findLatestPacketForDispute(disputeId as DisputeId, tx),
      forDispute: (disputeId, tx) => listEvidencePacketsForDispute(disputeId as DisputeId, tx),
      insert: (input: NewEvidencePacket, tx) => createEvidencePacket(input, tx),
      attachPdf: (id: PacketId, pdfBytes, pdfSha256, at, tx) =>
        attachPdf(id, pdfBytes, pdfSha256, at, tx),
      markFiled: (id: PacketId, paypalResponse, at, tx) =>
        markPacketFiled(id, paypalResponse, at, tx),
    },

    actions: {
      findByIdempotencyKey: (idempotencyKey, tx) =>
        findDisputeActionByIdempotencyKey(idempotencyKey, tx),
      record: (input: NewDisputeAction, tx) => recordDisputeAction(input, tx),
      listForDispute: (disputeId, tx) => listDisputeActions(disputeId as DisputeId, tx),
    },
  }
}

/* ============================================================================================ */
/* 2. The §7.3 bundle, assembled                                                                      */
/* ============================================================================================ */

/** The row every hop of the bundle's chain needs, or `CS_NOT_FOUND` naming the broken link. */
async function requireRow<T>(
  found: Promise<Result<T | undefined, CsError>>,
  what: string,
  id: string,
): Promise<Result<T, CsError>> {
  const got = await found
  if (!got.ok) return got
  if (got.value === undefined)
    return err(csError('CS_NOT_FOUND', `No ${what} row for ${id} — the evidence chain is broken`))
  return { ok: true, value: got.value }
}

/**
 * §7.3's evidence bundle for one order, read back out of the tables it was written to.
 *
 * `paypal` (order id, capture ids, `custom_id`) and `shipments` are the two members that were added
 * *after* `customIdForBundle` hashed the rest at order time, which is why they are optional there and
 * unconditioned here: a captured order has captures, and a shipment exists only when the merchant
 * sent one.
 */
async function evidenceBundleFor(
  orderId: string,
  tx: DefenderTx | undefined,
): Promise<Result<EvidenceBundle, CsError>> {
  const order = await requireRow(findOrderById(orderId as OrderId, tx), 'orders', orderId)
  if (!order.ok) return order
  const orderRow: OrderRow = order.value

  const attempt = await requireRow(
    findAttemptById(orderRow.attempt_id as AttemptId, tx),
    'checkout_attempts',
    String(orderRow.attempt_id),
  )
  if (!attempt.ok) return attempt
  const attemptRow: CheckoutAttemptRow = attempt.value

  const mandate = await requireRow(
    findMandateById(attemptRow.mandate_id as MandateId, tx),
    'mandates',
    String(attemptRow.mandate_id),
  )
  if (!mandate.ok) return mandate
  const mandateRow: MandateRow = mandate.value

  const session = await requireRow(
    findCheckoutSessionById(attemptRow.checkout_session_id as CheckoutId, tx),
    'checkout_sessions',
    String(attemptRow.checkout_session_id),
  )
  if (!session.ok) return session
  const sessionRow: CheckoutSessionRow = session.value

  const decision = await requireRow(
    findLatestDecisionForAttempt(orderRow.attempt_id as AttemptId, tx),
    'gate_decisions',
    String(orderRow.attempt_id),
  )
  if (!decision.ok) return decision
  const decisionRow: GateDecisionRow = decision.value

  const captures = await findCapturesByOrder(orderId as OrderId, tx)
  if (!captures.ok) return captures
  const captureIds: readonly string[] = (captures.value as readonly CaptureRow[]).flatMap((c) =>
    typeof c.paypal_capture_id === 'string' ? [c.paypal_capture_id] : [],
  )

  const shipments = await findShipmentsByOrder(orderId as OrderId, tx)
  if (!shipments.ok) return shipments

  const l1 = await findL1ForDeviceWallet(
    String(mandateRow.device_id),
    String(mandateRow.wallet_id),
    tx,
  )
  if (!l1.ok) return l1
  const l1Row: L1Row | undefined = l1.value

  const bundle: EvidenceBundle = {
    v: 'cs1',
    ...(l1Row === undefined ? {} : { l1: l1Row.sd_jwt }),
    l2: mandateRow.l2_serialized,
    l3a: attemptRow.l3a,
    l3b: attemptRow.l3b,
    checkout_jwt: sessionRow.checkout_jwt,
    gate_decision: decisionRow.signed_record,
    webauthn: { present: mandateRow.webauthn_assertion !== null },
    vi_lib_commit: decisionRow.vi_lib_commit,
    paypal: {
      order_id: orderRow.paypal_order_id,
      capture_ids: captureIds,
      custom_id: orderRow.custom_id,
    },
    ...(shipments.value.length === 0
      ? {}
      : { shipments: (shipments.value as readonly ShipmentRow[]).map(shipmentOf) }),
  }
  return ok(bundle)
}

/** One shipment's §7.3 shape — the tracked subset of lines, carrier and tracking number. */
function shipmentOf(s: ShipmentRow): { carrier: string; tracking: string; lines: LineFact[] } {
  const lines: LineFact[] = []
  for (const entry of Array.isArray(s.lines) ? s.lines : []) {
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      const sku = (entry as Record<string, unknown>)['sku']
      const qty = (entry as Record<string, unknown>)['qty']
      if (typeof sku === 'string' && typeof qty === 'number' && Number.isInteger(qty) && qty > 0) {
        lines.push({ sku, qty })
      }
    }
  }
  return { carrier: s.carrier, tracking: s.tracking_number, lines }
}

/* ============================================================================================ */
/* 3. The refund port, and why it refuses                                                             */
/* ============================================================================================ */

/**
 * The `DefenderRefunds` port this wiring supplies — a **loud refusal**, reachable by construction.
 *
 * ### Why not the real refund path
 *
 * §8.15 makes a refund (like every PayPal write) unreachable without a merchant approval click:
 * `fileDispute` returns `awaitingApproval: true` at its approval gate — *before* the posture
 * dispatch — whenever no `approval` was passed and auto-file did not apply, and this wiring never
 * passes an approval. The REFUND branch at `filer.ts`'s dispatch is therefore dead code on this path,
 * and wiring `orders.defenderRefundsFromOrders` here would mean composing a full `OrdersDeps`
 * (`budget` hooks, `notify`, the reservation store) for a port no call can reach.
 *
 * A silent `{}` would be the wrong way to say that: the day someone adds an approval path and forgets
 * this port, a REFUND posture would "succeed" at doing nothing, and a refund that never happened is
 * the single most expensive lie a dispute case file can carry. So this fails loudly, names the
 * wiring to add, and the dispute keeps its case open — which is what a human sees.
 */
export function refundsRefusedLoudly(): DefenderRefunds {
  return {
    async refund() {
      return err(
        csError(
          'DEF_WRONG_STATE',
          'A REFUND posture was reached without a wired refund port. §8.15 makes this unreachable ' +
            'without a merchant approval, and this wiring passes none — so the wiring changed ' +
            'without its refund path. Nothing was refunded and no PayPal call was made. Wire ' +
            'orders.defenderRefundsFromOrders(...) here before restoring approval.',
        ),
      )
    },
  }
}
