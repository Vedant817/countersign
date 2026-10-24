/**
 * `disputes`, `evidence_packets` and `dispute_actions` — spec §7.2, §8.15/§8.16 (M15/M16, WP-15/16).
 *
 * The governing rule for this whole file comes from spec §3.3:
 *
 * > Transitions are driven **only** by re-fetching `GET /v1/customer/disputes/{id}`, never by webhook
 * > payload order (EC-WH-3).
 *
 * That is why {@link upsertDisputeFromFetch} takes the *fetched* row plus its `update_time` and
 * refuses to move anything backwards, while `setDefenseState` — our own internal machine, not
 * PayPal's — is a plain write. Conflating the two is the bug this separation prevents: a merchant
 * action taken at 10:02 must not be undone because a stale webhook payload arrived at 10:03.
 *
 * `defense_state` is ours alone (spec §3.3's nine values) and never mirrors a PayPal field, because
 * PayPal has no idea whether our router has analysed a case. `liability` is assigned by the
 * deterministic router in §8.15 and is `null` until it has run — a case with no liability has not been
 * assessed, which is different from having been assessed as `UNPROVABLE`.
 */
import { and, asc, desc, eq, lte, sql } from 'drizzle-orm'

import type { CsError, DisputeId, Money, PacketId, Result } from '@countersign/core'

import { db, type Exec } from '../client'
import {
  checkoutAttempts,
  disputeActions,
  disputes,
  evidencePackets,
  mandates,
  orders,
  type DisputeActionRow,
  type DisputeRow,
  type EvidencePacketRow,
  type NewDispute,
  type NewDisputeAction,
  type NewEvidencePacket,
} from '../schema'
import { err, repo } from './index'

export type DisputeStage = 'INQUIRY' | 'CHARGEBACK' | 'PRE_ARBITRATION' | 'ARBITRATION'
export type DisputeStatus =
  | 'OPEN'
  | 'WAITING_FOR_BUYER_RESPONSE'
  | 'WAITING_FOR_SELLER_RESPONSE'
  | 'UNDER_REVIEW'
  | 'RESOLVED'
  | 'OTHER'
export type DisputeDefenseState =
  | 'NEW'
  | 'ANALYSED'
  | 'AWAITING_MERCHANT_APPROVAL'
  | 'FILED'
  | 'OFFERED'
  | 'ACCEPTED'
  | 'CLOSED_WON'
  | 'CLOSED_LOST'
  | 'CLOSED_REFUNDED'
/** Spec §8.15 `Liability`. */
export type DisputeLiability =
  | 'USER_AUTHORISED'
  | 'AGENT_FAULT'
  | 'MERCHANT_FAULT'
  | 'UNPROVABLE'
  | 'ALREADY_REFUNDED'
export type DisputeAction =
  | 'FILE'
  | 'OFFER'
  | 'ACCEPT'
  | 'MESSAGE'
  | 'APPEAL'
  | 'ACK_RETURN'
  | 'SUPPORTING_INFO'
  | 'ESCALATE'

/* ------------------------------------------------------------------------------------------ */
/* disputes                                                                                        */
/* ------------------------------------------------------------------------------------------ */

export function createDispute(
  input: NewDispute,
  exec?: Exec,
): Promise<Result<DisputeRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db()).insert(disputes).values(input).returning()
      const row = rows[0]
      if (!row) throw new Error('INSERT ... RETURNING produced no disputes row')
      return row as DisputeRow
    },
    { table: 'disputes', id: input.id, paypalDisputeId: input.paypal_dispute_id },
  )
}

export function findDisputeById(
  id: DisputeId,
  exec?: Exec,
): Promise<Result<DisputeRow | undefined, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db()).select().from(disputes).where(eq(disputes.id, id)).limit(1)
      return rows[0] as DisputeRow | undefined
    },
    { table: 'disputes', id },
  )
}

export async function requireDispute(
  id: DisputeId,
  exec?: Exec,
): Promise<Result<DisputeRow, CsError>> {
  const found = await findDisputeById(id, exec)
  if (!found.ok) return found
  const dispute = found.value
  if (!dispute) {
    return err({
      code: 'CS_NOT_FOUND',
      message: `No disputes row for ${id}`,
      userMessage: 'We could not find that dispute.',
      retryable: false,
      details: { table: 'disputes', id },
    })
  }
  return { ok: true, value: dispute }
}

export function findDisputeByPaypalId(
  paypalDisputeId: string,
  exec?: Exec,
): Promise<Result<DisputeRow | undefined, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(disputes)
        .where(eq(disputes.paypal_dispute_id, paypalDisputeId))
        .limit(1)
      return rows[0] as DisputeRow | undefined
    },
    { table: 'disputes', paypalDisputeId },
  )
}

/** §8.12's 2-minute dispute sweep: `listDisputes(start_time = last_seen − 1h)` returns ids. */
export function findDisputesUpdatedSince(
  since: Date,
  exec?: Exec,
): Promise<Result<DisputeRow[], CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(disputes)
        .where(sql`${disputes.updated_at} >= ${since.toISOString()}`)
        .orderBy(desc(disputes.updated_at))
      return rows as DisputeRow[]
    },
    { table: 'disputes', op: 'find_updated_since' },
  )
}

/**
 * The Defender's work queue: `defense_state` not yet terminal. Spec §8.15's router runs on these.
 */
export function findDisputesByDefenseState(
  states: readonly DisputeDefenseState[],
  exec?: Exec,
): Promise<Result<DisputeRow[], CsError>> {
  return repo(
    async () => {
      if (states.length === 0) return []
      const rows = await (exec ?? db())
        .select()
        .from(disputes)
        .where(
          sql`${disputes.defense_state} in (${states.map((s) => sql`${s}`).reduce((a, b, i) => (i === 0 ? b : sql`${a}, ${b}`))})`,
        )
        .orderBy(asc(disputes.seller_response_due_date))
      return rows as DisputeRow[]
    },
    { table: 'disputes', states },
  )
}

/**
 * EC-WH-3 for disputes: apply a **fetched** state, never one from a payload.
 *
 * PayPal's ordering is `(stage order, status, update_time)` (§8.12). `stageRank` is the primary key
 * of that comparison because a dispute can move *backwards* in `status` while advancing in `stage` —
 * an INQUIRY that becomes a CHARGEBACK has `status: OPEN` again, and a naive status comparison would
 * call that a regression and refuse the update, stranding the case.
 */
export const STAGE_RANK: Readonly<Record<DisputeStage, number>> = Object.freeze({
  INQUIRY: 1,
  CHARGEBACK: 2,
  PRE_ARBITRATION: 3,
  ARBITRATION: 4,
})

export function isDisputeRegression(
  current: DisputeRow,
  next: { stage: DisputeStage; updatedAt: Date },
): boolean {
  if (STAGE_RANK[next.stage] < STAGE_RANK[current.stage]) return true
  if (STAGE_RANK[next.stage] > STAGE_RANK[current.stage]) return false
  // Same stage: compare `update_time`. A row that has never been fetched (`fetched_at IS NULL`) has
  // nothing to compare against, so it is treated as fresh rather than as a regression.
  const stored = current.fetched_at
  return stored !== null && next.updatedAt.getTime() < stored.getTime()
}

/**
 * Upsert from `GET /v1/customer/disputes/{id}`. Returns the row unchanged when the fetch is older
 * than what we already stored, which is the reconciler's "skip stale" rule from §8.12.
 */
export async function upsertDisputeFromFetch(
  fetched: {
    paypalDisputeId: string
    id: DisputeId
    stage: DisputeStage
    status: DisputeStatus
    reason: string
    amount: Money
    sellerResponseDueDate: Date | null
    buyerResponseDueDate: Date | null
    raw: DisputeRow['raw']
    updatedAt: Date
  },
  exec?: Exec,
): Promise<Result<DisputeRow, CsError>> {
  return repo(
    async () => {
      const existing = await (exec ?? db())
        .select()
        .from(disputes)
        .where(eq(disputes.paypal_dispute_id, fetched.paypalDisputeId))
        .limit(1)
      const current = existing[0] as DisputeRow | undefined
      const values = {
        order_id: current?.order_id ?? null,
        capture_id: current?.capture_id ?? null,
        reason: fetched.reason,
        stage: fetched.stage,
        status: fetched.status,
        amount_minor: fetched.amount.minor,
        currency: fetched.amount.currency,
        seller_response_due_date: fetched.sellerResponseDueDate,
        buyer_response_due_date: fetched.buyerResponseDueDate,
        raw: fetched.raw,
        fetched_at: fetched.updatedAt,
        updated_at: fetched.updatedAt,
      }
      if (current) {
        if (isDisputeRegression(current, { stage: fetched.stage, updatedAt: fetched.updatedAt }))
          return current
        const rows = await (exec ?? db())
          .update(disputes)
          .set(values)
          .where(eq(disputes.id, current.id))
          .returning()
        const row = rows[0]
        if (!row) throw new Error(`No disputes row for ${current.id}`)
        return row as DisputeRow
      }
      const rows = await (exec ?? db())
        .insert(disputes)
        .values({ id: fetched.id, paypal_dispute_id: fetched.paypalDisputeId, ...values })
        .returning()
      const row = rows[0]
      if (!row) throw new Error('INSERT ... RETURNING produced no disputes row')
      return row as DisputeRow
    },
    { table: 'disputes', paypalDisputeId: fetched.paypalDisputeId },
  )
}

/**
 * Link a dispute to the Countersign order behind it.
 *
 * R-NOCHAIN-1 turns on this being `null`: if a chargeback lands on a transaction with no mandate, the
 * honest answer is `UNPROVABLE` and Countersign must not pretend otherwise.
 */
export function linkDisputeToOrder(
  id: DisputeId,
  link: { orderId: string | null; captureId: string | null },
  at: Date,
  exec?: Exec,
): Promise<Result<DisputeRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .update(disputes)
        .set({ order_id: link.orderId, capture_id: link.captureId, updated_at: at })
        .where(eq(disputes.id, id))
        .returning()
      const row = rows[0]
      if (!row) throw new Error(`No disputes row for ${id}`)
      return row as DisputeRow
    },
    { table: 'disputes', id },
  )
}

/** Our own machine. Never called from a webhook handler — only from a deliberate, audited step. */
export function setDefenseState(
  id: DisputeId,
  state: DisputeDefenseState,
  at: Date,
  exec?: Exec,
): Promise<Result<DisputeRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .update(disputes)
        .set({ defense_state: state, updated_at: at })
        .where(eq(disputes.id, id))
        .returning()
      const row = rows[0]
      if (!row) throw new Error(`No disputes row for ${id}`)
      return row as DisputeRow
    },
    { table: 'disputes', id, state },
  )
}

/** §8.15: the router writes its verdict plus the trace of which rule fired and on what facts. */
export function setLiability(
  id: DisputeId,
  liability: DisputeLiability,
  routerTrace: DisputeRow['router_trace'],
  at: Date,
  exec?: Exec,
): Promise<Result<DisputeRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .update(disputes)
        .set({ liability, router_trace: routerTrace, updated_at: at })
        .where(eq(disputes.id, id))
        .returning()
      const row = rows[0]
      if (!row) throw new Error(`No disputes row for ${id}`)
      return row as DisputeRow
    },
    { table: 'disputes', id, liability },
  )
}

/**
 * §8.15's filing guard, as a data question: is there still time to file?
 *
 * Two separate conditions, both in the spec: `status = WAITING_FOR_SELLER_RESPONSE` **and**
 * `now < seller_response_due_date − 1 h`. The one-hour margin is the buffer that stops a filing that
 * starts at 5:29 PM from arriving at 5:30.
 */
export function assertFilingWindowOpen(
  dispute: DisputeRow,
  now: Date,
  marginMs = 60 * 60_000,
): Result<true, CsError> {
  if (dispute.status !== 'WAITING_FOR_SELLER_RESPONSE') {
    return err({
      code: 'DEF_WRONG_STATE',
      message: `Dispute ${dispute.id} is ${dispute.status}, not WAITING_FOR_SELLER_RESPONSE`,
      userMessage: 'This dispute is not in a state where that action is allowed.',
      retryable: false,
      details: { table: 'disputes', id: dispute.id, status: dispute.status },
    })
  }
  const due = dispute.seller_response_due_date
  if (!due) {
    return err({
      code: 'DEF_DEADLINE_PASSED',
      message: `Dispute ${dispute.id} has no seller_response_due_date`,
      userMessage: 'PayPal’s response deadline has passed.',
      retryable: false,
      details: { table: 'disputes', id: dispute.id },
    })
  }
  if (now.getTime() + marginMs >= due.getTime()) {
    return err({
      code: 'DEF_DEADLINE_PASSED',
      message: `Filing window for ${dispute.id} closes at ${due.toISOString()}`,
      userMessage: 'PayPal’s response deadline has passed.',
      retryable: false,
      details: { table: 'disputes', id: dispute.id, due: due.toISOString() },
    })
  }
  return { ok: true, value: true }
}

/** EC-TIME-6: the S-17 deadline timeline. Ordered by the seller deadline, soonest first. */
export function findDisputesByDeadline(exec?: Exec): Promise<Result<DisputeRow[], CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(disputes)
        .where(sql`${disputes.seller_response_due_date} is not null`)
        .orderBy(asc(disputes.seller_response_due_date))
      return rows as DisputeRow[]
    },
    { table: 'disputes', op: 'find_by_deadline' },
  )
}

export function findDisputesBeforeDeadline(
  cutoff: Date,
  exec?: Exec,
): Promise<Result<DisputeRow[], CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(disputes)
        .where(lte(disputes.seller_response_due_date, cutoff))
        .orderBy(asc(disputes.seller_response_due_date))
      return rows as DisputeRow[]
    },
    { table: 'disputes', op: 'find_before_deadline' },
  )
}

/* ------------------------------------------------------------------------------------------ */
/* evidence_packets                                                                                */
/* ------------------------------------------------------------------------------------------ */

export function createEvidencePacket(
  input: NewEvidencePacket,
  exec?: Exec,
): Promise<Result<EvidencePacketRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db()).insert(evidencePackets).values(input).returning()
      const row = rows[0]
      if (!row) throw new Error('INSERT ... RETURNING produced no evidence_packets row')
      return row as EvidencePacketRow
    },
    { table: 'evidence_packets', id: input.id, disputeId: input.dispute_id },
  )
}

/**
 * The public verifier (`/v/[packetId]`, §8.18) serves the **latest** packet for a dispute; earlier
 * versions stay in the case file. A re-file is a new row with `version + 1`, so nothing that was
 * already filed with PayPal is ever edited.
 */
export function findLatestPacketForDispute(
  disputeId: DisputeId,
  exec?: Exec,
): Promise<Result<EvidencePacketRow | undefined, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(evidencePackets)
        .where(eq(evidencePackets.dispute_id, disputeId))
        .orderBy(desc(evidencePackets.version))
        .limit(1)
      return rows[0] as EvidencePacketRow | undefined
    },
    { table: 'evidence_packets', disputeId },
  )
}

export function findPacketById(
  id: PacketId,
  exec?: Exec,
): Promise<Result<EvidencePacketRow | undefined, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(evidencePackets)
        .where(eq(evidencePackets.id, id))
        .limit(1)
      return rows[0] as EvidencePacketRow | undefined
    },
    { table: 'evidence_packets', id },
  )
}

/** §8.18 verifies `bundle_hash` against the canonical JSON, so the hash is stored beside the bundle. */
export function findPacketByBundleHash(
  bundleHash: string,
  exec?: Exec,
): Promise<Result<EvidencePacketRow | undefined, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(evidencePackets)
        .where(eq(evidencePackets.bundle_hash, bundleHash))
        .limit(1)
      return rows[0] as EvidencePacketRow | undefined
    },
    { table: 'evidence_packets', bundleHash },
  )
}

export function attachPdf(
  id: PacketId,
  pdfBytes: Buffer,
  pdfSha256: string,
  at: Date,
  exec?: Exec,
): Promise<Result<EvidencePacketRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .update(evidencePackets)
        .set({ pdf_bytes: pdfBytes, pdf_sha256: pdfSha256, updated_at: at })
        .where(eq(evidencePackets.id, id))
        .returning()
      const row = rows[0]
      if (!row) throw new Error(`No evidence_packets row for ${id}`)
      return row as EvidencePacketRow
    },
    { table: 'evidence_packets', id },
  )
}

/** Marks the packet as accepted by PayPal. The idempotency key was `cs:{disputeId}:file:{version}`. */
export function markPacketFiled(
  id: PacketId,
  paypalResponse: EvidencePacketRow['paypal_response'],
  at: Date,
  exec?: Exec,
): Promise<Result<EvidencePacketRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .update(evidencePackets)
        .set({ filed_at: at, paypal_response: paypalResponse, updated_at: at })
        .where(eq(evidencePackets.id, id))
        .returning()
      const row = rows[0]
      if (!row) throw new Error(`No evidence_packets row for ${id}`)
      return row as EvidencePacketRow
    },
    { table: 'evidence_packets', id },
  )
}

/* ------------------------------------------------------------------------------------------ */
/* dispute_actions                                                                                 */
/* ------------------------------------------------------------------------------------------ */

/**
 * Append-only record of every PayPal dispute call we made.
 *
 * `idempotency_key` is unique: §8.15's `cs:{disputeId}:file:{version}` and the equivalent keys for
 * every other action mean a retried job cannot file twice. The S-17 timeline is this table, in `at`
 * order, so it has to contain the failures too.
 */
export function recordDisputeAction(
  input: NewDisputeAction,
  exec?: Exec,
): Promise<Result<DisputeActionRow, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db()).insert(disputeActions).values(input).returning()
      const row = rows[0]
      if (!row) throw new Error('INSERT ... RETURNING produced no dispute_actions row')
      return row as DisputeActionRow
    },
    { table: 'dispute_actions', id: input.id, idempotencyKey: input.idempotency_key },
  )
}

export function findDisputeActionByIdempotencyKey(
  idempotencyKey: string,
  exec?: Exec,
): Promise<Result<DisputeActionRow | undefined, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(disputeActions)
        .where(eq(disputeActions.idempotency_key, idempotencyKey))
        .limit(1)
      return rows[0] as DisputeActionRow | undefined
    },
    { table: 'dispute_actions', idempotencyKey },
  )
}

/** The S-17 Bryntum timeline: every action on this dispute, oldest first. */
export function listDisputeActions(
  disputeId: DisputeId,
  exec?: Exec,
): Promise<Result<DisputeActionRow[], CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select()
        .from(disputeActions)
        .where(eq(disputeActions.dispute_id, disputeId))
        .orderBy(asc(disputeActions.at))
      return rows as DisputeActionRow[]
    },
    { table: 'dispute_actions', disputeId },
  )
}

/**
 * EC-BUY-6: "serial disputer (≥3 disputes in 90 days), count per wallet".
 *
 * The join is four hops — `disputes → orders → checkout_attempts → mandates → wallet` — because a
 * dispute row only ever points at an order, and the wallet lives on the mandate. It is spelled out
 * here rather than left to a caller so that "count per wallet" has exactly one answer; a wallet
 * without disputes has no rows, which is the answer the router wants.
 */
export function countDisputesForWalletSince(
  walletId: string,
  since: Date,
  exec?: Exec,
): Promise<Result<number, CsError>> {
  return repo(
    async () => {
      const rows = await (exec ?? db())
        .select({ id: disputes.id })
        .from(disputes)
        .innerJoin(orders, eq(disputes.order_id, orders.id))
        .innerJoin(checkoutAttempts, eq(orders.attempt_id, checkoutAttempts.id))
        .innerJoin(mandates, eq(checkoutAttempts.mandate_id, mandates.id))
        .where(
          and(
            eq(mandates.wallet_id, walletId),
            sql`${disputes.created_at} >= ${since.toISOString()}`,
          ),
        )
      return rows.length
    },
    { table: 'disputes', walletId, since },
  )
}
