/**
 * One assessed dispute, read for the merchant who has to approve or decline it — spec **§8.15**, S-17.
 *
 * ## Why this is a separate file from `dispute-queue.ts`
 *
 * The queue answers "which disputes are waiting for me?" with one row each. The approval surface has to
 * answer a different and much harder question: **"what exactly am I being asked to authorise?"** A
 * merchant who cannot see the rule, the facts it compared, the rationale, the deadline band and the
 * evidence PayPal will receive cannot give informed consent — and an uninformed click is the failure mode
 * §8.15's approval requirement exists to prevent.
 *
 * So this file reads the **stored** decision and nothing else. It never re-runs the router: `liability`
 * and `router_trace` are what `fileDispute` wrote when it last ran, and a page that re-derived a verdict
 * would be a second §8.15 implementation — the two would drift the first time a rule changed, and the
 * merchant would be shown a verdict that was never the one that will be acted on.
 *
 * ## What it deliberately does not decide
 *
 * Whether the click is allowed. That is `lib/dispute-approval.ts`'s job, and it re-checks the row it acts
 * on rather than trusting anything rendered here: a page is a view, and a view is not an authorisation.
 */
import type { Currency, Result } from '@countersign/core'
import {
  findDisputeBuyerUserId,
  findDisputeById,
  findLatestPacketForDispute,
  listBySubject,
  listDisputeActions,
  type DisputeActionRow,
  type DisputeRow,
  type EvidencePacketRow,
} from '@countersign/db'
import type { CsError, DisputeId } from '@countersign/core'

/** What the router decided, as `fileDispute` stored it in `disputes.router_trace`. */
export interface RouterVerdict {
  readonly ruleId: string | null
  readonly posture: string | null
  readonly liability: string | null
  /** The sentence a buyer reads in S-18 and a judge reads in the packet. */
  readonly rationale: string | null
  /** The same facts as prose sentences, one per line, for the UI's "why" list. */
  readonly reasons: readonly string[]
  /** The fact keys the router compared, in the order it compared them. */
  readonly facts: readonly string[]
  /** Set only on `REVIEW`, and only when a human is the thing that is missing. */
  readonly blockingReason: string | null
  /** The rule whose posture this one replaced (`R-DEADLINE-1`, `R-NO-EVIDENCE`). */
  readonly supersedes: string | null
  /** `evidence_type` values PayPal accepts, i.e. what the filing will actually send. */
  readonly evidenceRequired: readonly string[]
  /** §8.15 R-UNAUTH-1's "possible compromised device", when the router raised it. */
  readonly userAlert: string | null
  /** The clock as the router saw it, epoch seconds. */
  readonly nowSec: number | null
}

/** The packet the merchant is being asked to file, when one exists. */
export interface PacketSummary {
  readonly id: string
  readonly version: number
  readonly bundleHash: string
  readonly pdfSha256: string | null
  readonly notes: string | null
  /** `null` until PayPal has accepted an upload. */
  readonly filedAt: Date | null
}

/** One row of the case timeline. */
export interface TimelineEntry {
  readonly kind: 'ACTION' | 'AUDIT'
  readonly at: Date
  /** `dispute_actions.action`, or the audit action string. */
  readonly label: string
  readonly actor: string
  /** The one-line human summary the UI shows; never a raw JSON blob. */
  readonly summary: string
  readonly detail: string | null
}

/** Everything one page needs, and nothing it cannot source from a column. */
export interface DisputeDetail {
  readonly id: string
  readonly paypalDisputeId: string
  readonly reason: string
  readonly stage: string
  readonly status: string
  readonly amountMinor: bigint
  readonly currency: Currency
  readonly sellerResponseDueAt: Date | null
  readonly buyerResponseDueAt: Date | null
  readonly defenseState: string
  /** `null` until the router has run — which is not the same as "assessed and fine". */
  readonly liability: string | null
  readonly verdict: RouterVerdict
  readonly orderId: string | null
  readonly captureId: string | null
  readonly packet: PacketSummary | null
  readonly actions: readonly TimelineEntry[]
  /** The user id of the buyer on the disputed order, or `null` when there is no chain to read. */
  readonly buyerUserId: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** The "no trace" verdict: every field present, every value `null`, so a caller cannot forget a branch. */
const EMPTY_VERDICT: RouterVerdict = {
  ruleId: null,
  posture: null,
  liability: null,
  rationale: null,
  reasons: [],
  facts: [],
  blockingReason: null,
  supersedes: null,
  evidenceRequired: [],
  userAlert: null,
  nowSec: null,
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string')
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Read `disputes.router_trace` into the shape the page renders.
 *
 * Defensive by necessity, not by taste: the column is `jsonb` and its writer is `routerTraceOf`, but a
 * trace written by an older build (or a hand-edited one) must not make the approval page 500 — a merchant
 * who cannot read the case cannot act on it, and a page that crashes hides the case entirely. Every
 * member is therefore read independently and anything unexpected becomes "absent".
 */
export function routerVerdictOf(trace: DisputeRow['router_trace']): RouterVerdict {
  if (trace === null || typeof trace !== 'object' || Array.isArray(trace))
    return { ...EMPTY_VERDICT }
  const record = trace as Record<string, unknown>
  return {
    ruleId: stringOrNull(record['rule_id']) ?? stringOrNull(record['ruleId']),
    posture: stringOrNull(record['posture']),
    liability: stringOrNull(record['liability']),
    rationale: stringOrNull(record['rationale']),
    reasons: stringList(record['reasons']),
    facts: stringList(record['facts']),
    blockingReason: stringOrNull(record['blocking_reason']),
    supersedes: stringOrNull(record['supersedes']),
    evidenceRequired: stringList(record['evidence_required']),
    userAlert: stringOrNull(record['user_alert']),
    nowSec: numberOrNull(record['now_sec']),
  }
}

/**
 * The one line a merchant reads for a recorded PayPal action.
 *
 * `dispute_actions.request` is the "read why" half and `response` is the "see it was recorded" half
 * (`filer.ts::finish`). Both are free-form `jsonb`, so this reads the members the filer writes and falls
 * back to the action name rather than printing a JSON object at a person.
 */
export function actionSummaryOf(row: DisputeActionRow): string {
  const request =
    row.request !== null && typeof row.request === 'object' && !Array.isArray(row.request)
      ? (row.request as Record<string, unknown>)
      : {}
  const response =
    row.response !== null && typeof row.response === 'object' && !Array.isArray(row.response)
      ? (row.response as Record<string, unknown>)
      : {}

  const rule = stringOrNull(request['rule_id'])
  const disposition = stringOrNull(request['disposition']) ?? row.action
  const paypalCall = response['paypal_call']
  const sent = paypalCall === 'sent'
  const refusal =
    response['refusal'] !== null && typeof response['refusal'] === 'object'
      ? stringOrNull((response['refusal'] as Record<string, unknown>)['message'])
      : null

  const parts = [disposition]
  if (rule !== null) parts.push(`rule ${rule}`)
  parts.push(sent ? 'sent to PayPal' : 'no PayPal call')
  if (refusal !== null) parts.push(`refused: ${refusal}`)
  return parts.join(' · ')
}

/** One dispute, with everything the approval page renders. */
export async function loadDisputeDetail(
  disputeId: string,
): Promise<Result<DisputeDetail, CsError>> {
  const found = await findDisputeById(disputeId as DisputeId)
  if (!found.ok) return found
  const row = found.value
  if (row === undefined) {
    return {
      ok: false,
      error: {
        code: 'CS_NOT_FOUND',
        message: `No disputes row for ${disputeId}.`,
        userMessage: 'That dispute is not in this deployment’s records.',
        retryable: false,
      },
    }
  }

  const [packet, actions, audit, buyer] = await Promise.all([
    findLatestPacketForDispute(row.id as DisputeId),
    listDisputeActions(row.id as DisputeId),
    listBySubject(row.id),
    findDisputeBuyerUserId(row.id as DisputeId),
  ])
  // A per-row read that fails is a page that cannot state the case honestly. Propagate it rather than
  // rendering a timeline with an invented action or a silently missing audit entry.
  if (!packet.ok) return packet
  if (!actions.ok) return actions
  if (!audit.ok) return audit
  if (!buyer.ok) return buyer

  return {
    ok: true,
    value: {
      id: row.id,
      paypalDisputeId: row.paypal_dispute_id,
      reason: row.reason,
      stage: row.stage,
      status: row.status,
      amountMinor: row.amount_minor,
      currency: row.currency as Currency,
      sellerResponseDueAt: row.seller_response_due_date,
      buyerResponseDueAt: row.buyer_response_due_date,
      defenseState: row.defense_state,
      liability: row.liability,
      verdict: routerVerdictOf(row.router_trace),
      orderId: row.order_id,
      captureId: row.capture_id,
      packet: packetSummaryOf(packet.value),
      actions: timelineOf(actions.value, audit.value),
      buyerUserId: buyer.value ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
  }
}

function packetSummaryOf(row: EvidencePacketRow | undefined): PacketSummary | null {
  if (row === undefined) return null
  return {
    id: row.id,
    version: row.version,
    bundleHash: row.bundle_hash,
    pdfSha256: row.pdf_sha256,
    notes: row.notes,
    filedAt: row.filed_at,
  }
}

/**
 * The case timeline: every recorded PayPal action, then every audit entry, in one order.
 *
 * Two sources, one list, because a merchant reading "what happened to this case" should not have to know
 * that PayPal writes are in one table and the human decisions are in another. The audit rows are the ones
 * that name who clicked, which is exactly what the actions cannot carry.
 */
function timelineOf(
  actions: readonly DisputeActionRow[],
  audit: readonly { at: Date; action: string; actor: string; details: unknown }[],
): TimelineEntry[] {
  const fromActions: TimelineEntry[] = actions.map((row) => ({
    kind: 'ACTION',
    at: row.at,
    label: row.action,
    actor: row.actor,
    summary: actionSummaryOf(row),
    detail: stringOrNull(row.idempotency_key),
  }))
  const fromAudit: TimelineEntry[] = audit.map((row) => ({
    kind: 'AUDIT',
    at: row.at,
    label: row.action,
    actor: row.actor,
    summary: auditSummaryOf(row.details),
    detail: null,
  }))
  return [...fromActions, ...fromAudit].sort((a, b) => a.at.getTime() - b.at.getTime())
}

/** The audit entry's own words, when it has a `message`; otherwise the action name is the summary. */
function auditSummaryOf(details: unknown): string {
  if (details !== null && typeof details === 'object' && !Array.isArray(details)) {
    const message = (details as Record<string, unknown>)['message']
    if (typeof message === 'string' && message !== '') return message
  }
  return 'recorded'
}
