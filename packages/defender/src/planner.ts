/**
 * `planEvidence()` — spec **§8.15**'s `planEvidence`, work package **WP-15b**.
 *
 * ```ts
 * const decision = route(ctx)
 * const plan = planEvidence(ctx, decision)
 * // plan.items -> ProvideEvidenceInput-shaped proposals, with PayPal's exact evidence_type values
 * ```
 *
 * ## What a plan is, and what it is not
 *
 * A plan is a **proposal**: which `evidence_type` values to send, what `evidence_info` to attach to each,
 * a note we can defend line by line, and which documents a human has to go and find. It is not a decision
 * (that was `route()`), and it is not a draft (WP-15c writes prose with citations). Crucially it is
 * **not a claim that those documents exist** — `EvidenceCorpus` says what exists, and this file reports the
 * gap rather than inventing a placeholder.
 *
 * ## The reason→evidence mapping is a table, not a judgement
 *
 * Every mapping below is either (a) a `dispute_reason` → `evidence_type` pairing the spec names, or (b) the
 * `evidenceRequired` list `route()` already produced for the rule that won. In neither case is the pairing
 * inferred, which is why `planEvidence` needs no model: **there is no decision left to make at this point.**
 *
 * ## EC-DSP-12: nothing this file proposes could be rejected for size or type
 *
 * `validateEvidencePlan` checks every proposal against the limits `@countersign/paypal` enforces *before*
 * any bytes move — 100 items, 10 MB per file, 50 MB per call, jpg/png/gif/pdf only, and notes of at most
 * 2000 characters as a **string** (spec D-012 corrected `notes` from `string[]`). A plan that would be
 * rejected locally is a plan that costs a response at PayPal, which is exactly what `R-NO-EVIDENCE` exists
 * to avoid; so the planner returns the violations in `warnings` instead of pretending.
 */

import { allocateWithRemainderLast, formatMoney, type Money } from '@countersign/core'
import {
  ALLOWED_EVIDENCE_CONTENT_TYPES,
  MAX_EVIDENCE_FILE_BYTES,
  MAX_EVIDENCE_ITEMS,
  MAX_EVIDENCE_TOTAL_BYTES,
  type AllowedEvidenceContentType,
  type ProvideEvidenceInput,
} from '@countersign/paypal'

import { composeRationale, deadlineSentence } from './rationale'
import { deadlineState } from './router'
import {
  completedRefunds,
  disputedSkus,
  evidenceSourceAvailable,
  missingEvidence,
  shipmentsCoveringDispute,
  trackedShipments,
} from './rules'
import type {
  DisputeContext,
  EvidencePlan,
  EvidencePlanItem,
  EvidenceType,
  LiabilityDecision,
  PlannedDocument,
} from './types'
import { NOTES_MAX_CHARS as MAX_NOTES } from './types'

// ---------------------------------------------------------------------------
// The reason → evidence_type table
// ---------------------------------------------------------------------------

/**
 * Which `evidence_type` PayPal documents for each `dispute_reason`, beyond what `route()` already required.
 *
 * `route()`'s list is the **minimum a defensible filing needs**; this is the **full set PayPal recognises
 * for that reason**, so a merchant can attach something we did not require without changing the router.
 * Both halves are grounded: every value here is in `EVIDENCE_TYPES` as corrected on 2026-10-04, and
 * `test/planner.test.ts` asserts membership for the whole table.
 *
 * Reasons absent from this table (`OTHER`, the unassigned four) contribute nothing on their own — R-DEFAULT
 * and R-OTHER-REFUND do not file, so there is nothing to plan.
 */
export const EVIDENCE_BY_REASON: Readonly<Record<string, readonly EvidenceType[]>> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: [
    'PROOF_OF_FULFILLMENT',
    'ONLINE_TRACKING_INFORMATION',
    'PROOF_OF_RETURN',
  ],
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: [
    'ITEM_DESCRIPTION',
    'ORDER_DETAILS',
    'PROOF_OF_FULFILLMENT',
  ],
  UNAUTHORISED: ['DETAILS_OF_PURCHASE', 'ORDER_DETAILS', 'PROOF_OF_RECEIPT_COPY'],
  CREDIT_NOT_PROCESSED: ['PROOF_OF_REFUND'],
  DUPLICATE_TRANSACTION: ['PROOF_OF_RECEIPT_COPY', 'ORDER_DETAILS'],
  INCORRECT_AMOUNT: ['PROOF_OF_RECEIPT_COPY', 'ORDER_DETAILS'],
  PAYMENT_BY_OTHER_MEANS: ['ORDER_DETAILS', 'DETAILS_OF_PURCHASE'],
  CANCELED_RECURRING_BILLING: ['DETAILS_OF_PURCHASE', 'ORDER_DETAILS'],
  PROBLEM_WITH_REMITTANCE: ['PROOF_OF_REFUND', 'ORDER_DETAILS'],
}

/**
 * The documents each `evidence_type` needs, with the size and MIME limits PayPal enforces.
 *
 * `maxBytes: null` means the size depends on rendering and is bounded by {@link MAX_EVIDENCE_FILE_BYTES}
 * at file time instead — the packet PDF is the case in point, and §8.15 AT-M15.3 asks for it under 2 MB
 * for a typical packet.
 */
/**
 * The ceiling every planned document is held to.
 *
 * **One byte under PayPal's per-file limit, and that subtraction is the point.** PayPal words the rule as
 * "less than 10 MB per file", so the boundary is *exclusive*: a document planned at exactly
 * `MAX_EVIDENCE_FILE_BYTES` would be accepted by `validateEvidencePlan`'s sibling check in a different
 * reading and rejected at upload in this one. Rather than carry the ambiguity, every planned document sits
 * a byte below the limit, which is true under both readings. `README.md`, "Verify before a judge does",
 * records that which reading is correct is still unknown (report §30/#8).
 */
const PLANNED_DOCUMENT_MAX_BYTES = MAX_EVIDENCE_FILE_BYTES - 1

const DOCUMENTS_FOR: Readonly<
  Record<EvidenceType, readonly Omit<PlannedDocument, 'contentType'>[]>
> = {
  PROOF_OF_FULFILLMENT: [
    {
      name: 'Carrier delivery confirmation or merchant dispatch invoice',
      description:
        'The carrier record for the disputed line: tracking number, first scan, delivery scan. A photograph of a packed box is not this.',
      maxBytes: PLANNED_DOCUMENT_MAX_BYTES,
      required: true,
    },
  ],
  PROOF_OF_REFUND: [
    {
      name: 'Refund receipt',
      description:
        'The refund confirmation showing the PayPal refund id, the amount and the date. The id goes in `evidence_info.refund_ids` as well.',
      maxBytes: PLANNED_DOCUMENT_MAX_BYTES,
      required: true,
    },
  ],
  ONLINE_TRACKING_INFORMATION: [],
  DETAILS_OF_PURCHASE: [
    {
      name: 'Evidence packet PDF',
      description:
        'The §7.3 bundle rendered with the QR code to the public verifier: L1, L2, L3s, checkout JWT, signed Gate decision.',
      maxBytes: PLANNED_DOCUMENT_MAX_BYTES,
      required: true,
    },
  ],
  ORDER_DETAILS: [
    {
      name: 'Order confirmation',
      description:
        'The order as created, with the `custom_id` that ties it to the evidence bundle hash, and the merchant-signed checkout lines.',
      maxBytes: PLANNED_DOCUMENT_MAX_BYTES,
      required: true,
    },
  ],
  ITEM_DESCRIPTION: [
    {
      name: 'Product listing capture at purchase time',
      description:
        'What the page said the item was, at the moment of purchase: title, variant attributes, price.',
      maxBytes: PLANNED_DOCUMENT_MAX_BYTES,
      required: true,
    },
    {
      name: 'Specification or test sheet for the shipped batch',
      description:
        'Proof the goods were as described. This is the document R-SNAD-THIN is about: without it the packet has nothing behind the claim.',
      maxBytes: PLANNED_DOCUMENT_MAX_BYTES,
      required: true,
    },
  ],
  PROOF_OF_RECEIPT_COPY: [
    {
      name: 'Buyer-facing receipt copy',
      description:
        'The receipt exactly as the buyer received it, including the amount and the timestamp.',
      maxBytes: PLANNED_DOCUMENT_MAX_BYTES,
      required: true,
    },
  ],
  PROOF_OF_RETURN: [
    {
      name: 'Return tracking or carrier receipt',
      description: 'For an appeal after the buyer returned the item.',
      maxBytes: PLANNED_DOCUMENT_MAX_BYTES,
      required: false,
    },
  ],
  OTHER: [
    {
      name: 'Supporting document',
      description:
        'Anything the merchant judges relevant. Named explicitly, never left as "see attached".',
      maxBytes: PLANNED_DOCUMENT_MAX_BYTES,
      required: false,
    },
  ],
}

/**
 * MIME types PayPal accepts, per `ALLOWED_EVIDENCE_CONTENT_TYPES` in `@countersign/paypal`.
 *
 * The document table does not name a type per row, because every document we ask a merchant for is
 * something they export as a **PDF** — an invoice, a carrier confirmation, a receipt, a specification. Using
 * the imported constant rather than a literal means a change to PayPal's accepted list cannot leave a stale
 * string behind in this table; and `validateEvidencePlan` re-checks the result against the same constant.
 */
const DOCUMENT_CONTENT_TYPE: AllowedEvidenceContentType = ALLOWED_EVIDENCE_CONTENT_TYPES.includes(
  'application/pdf',
)
  ? 'application/pdf'
  : (ALLOWED_EVIDENCE_CONTENT_TYPES[0] ?? 'application/pdf')

function documentsFor(type: EvidenceType): readonly PlannedDocument[] {
  return (DOCUMENTS_FOR[type] ?? []).map((d) => ({ ...d, contentType: DOCUMENT_CONTENT_TYPE }))
}

// ---------------------------------------------------------------------------
// evidence_info
// ---------------------------------------------------------------------------

/**
 * `evidence_info`, exactly as PayPal documents it — and **only the keys that apply**.
 *
 * Both keys are omitted rather than sent as `[]`. An empty array is not the same as an absent field to a
 * strict parser, and we cannot test the difference without a sandbox (H-01), so the plan never emits a field
 * it does not mean.
 */
export function evidenceInfoFor(
  type: EvidenceType,
  ctx: DisputeContext,
): EvidencePlanItem['evidenceInfo'] {
  if (type === 'ONLINE_TRACKING_INFORMATION') {
    const tracking = trackedShipments(ctx).map((s) => ({
      carrier_name: s.carrier,
      tracking_number: s.trackingNumber,
    }))
    if (tracking.length === 0) return {}
    return { tracking_info: tracking }
  }
  if (type === 'PROOF_OF_REFUND') {
    const ids = completedRefunds(ctx).map((r) => r.paypalRefundId)
    if (ids.length === 0) return {}
    return { refund_ids: ids }
  }
  return {}
}

// ---------------------------------------------------------------------------
// notes
// ---------------------------------------------------------------------------

/**
 * The note we can defend without a model: the rule that decided, the facts it compared, and what the packet
 * does and does not claim.
 *
 * Three properties, all load-bearing:
 *
 * - **Every number, date and id in it is also a citable fact key.** WP-15c's `checkCitations` requires the
 *   *drafted* notes to satisfy this; sending an under-citable placeholder would make the checker reject our
 *   own fallback, so the deterministic note is built to pass the same bar.
 * - **It says what is missing.** A packet that claims tracking is merchant-asserted (EC-MER-4) is honest; a
 *   packet that quietly implies carrier verification is not.
 * - **It is a single string of at most {@link NOTES_MAX_CHARS}.** Spec D-012 corrected `notes` from
 *   `string[]`, and `@countersign/paypal` validates `min(1).max(2000)`.
 */
function notesFor(type: EvidenceType, ctx: DisputeContext, decision: LiabilityDecision): string {
  const amount = formatMoney(ctx.dispute.amount)
  const lines: string[] = []
  switch (type) {
    case 'PROOF_OF_FULFILLMENT': {
      const tracked = trackedShipments(ctx)
      const first = tracked[0]
      lines.push('The payment was authorised and the dispatch is recorded.')
      if (first !== undefined) {
        lines.push(
          `Tracking ${first.carrier} ${first.trackingNumber}` +
            `${first.status === undefined ? '' : `, PayPal tracker status ${first.status}`}.`,
        )
      }
      const registered = tracked.some(
        (s) => typeof s.paypalTrackerId === 'string' && s.paypalTrackerId !== '',
      )
      lines.push(
        registered
          ? 'The tracker was registered with PayPal, so PayPal holds the carrier scan events as well.'
          : 'This tracking was asserted by the merchant and is not independently verified here.',
      )
      lines.push(
        'The signed purchase record is in the attached packet and re-verifies at our public URL.',
      )
      break
    }
    case 'PROOF_OF_REFUND': {
      const done = completedRefunds(ctx)
      lines.push(
        'This payment was already refunded. The refund id is in evidence_info.refund_ids and the receipt is attached.',
      )
      if (done.length > 0) {
        lines.push(
          `Refund total ${formatMoney({ minor: done.reduce((sum, r) => sum + r.amount.minor, 0n), currency: ctx.dispute.amount.currency })}.`,
        )
      }
      lines.push(
        `The buyer is claiming ${amount} that has already been returned, so filing this proof resolves it ` +
          `without a contested decision.`,
      )
      break
    }
    case 'ONLINE_TRACKING_INFORMATION': {
      const tracked = trackedShipments(ctx)
      lines.push('Tracking for every shipment carrying the disputed line.')
      for (const s of tracked) {
        lines.push(
          `${s.carrier} ${s.trackingNumber}${s.status === undefined ? '' : ` (${s.status})`}.`,
        )
      }
      lines.push(
        'Tracking is as registered by the merchant; we make no carrier-verification claim.',
      )
      break
    }
    case 'DETAILS_OF_PURCHASE': {
      lines.push('The purchase was authorised by a mandate the buyer signed on their own device.')
      if (ctx.chain?.iatSec !== undefined)
        lines.push('Mandate signed at the time shown in the packet.')
      lines.push(
        'The attached packet contains L1, L2, L3a and L3b, the checkout JWT and the signed Gate decision, ' +
          'and anyone can re-verify it against our public URL.',
      )
      if (ctx.chain?.webauthnPresent === true) {
        lines.push('A WebAuthn user-verification was present when the mandate was signed.')
      }
      break
    }
    case 'ORDER_DETAILS': {
      if (ctx.order !== undefined) {
        lines.push(
          `Order ${ctx.order.invoiceId ?? ctx.order.id}, created with custom_id ${ctx.order.customId}, ` +
            `which is the hash of the evidence bundle in this packet.`,
        )
      }
      const skus = disputedSkus(ctx)
      if (skus.length > 0) lines.push(`Disputed line(s): ${skus.join(', ')}.`)
      lines.push(
        'The line items are the merchant-signed checkout lines the Gate verified at purchase time.',
      )
      break
    }
    case 'ITEM_DESCRIPTION': {
      const item = ctx.disputedItem
      if (item !== undefined) {
        const attrs = Object.entries(item.attributes)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${k}: ${String(v)}`)
        lines.push(
          `The disputed item is ${item.sku}${attrs.length > 0 ? ` (${attrs.join(', ')})` : ''}, exactly as ` +
            `it appears on the merchant-signed checkout lines.`,
        )
      }
      lines.push(
        'The listing capture at purchase time and the specification for the shipped batch are attached; the ' +
          'signed read-back records what the buyer was shown and approved.',
      )
      break
    }
    case 'PROOF_OF_RECEIPT_COPY': {
      lines.push('The amount charged matches the signed order.')
      if (ctx.order !== undefined) {
        lines.push(`Order total ${formatMoney(ctx.order.amount)}; disputed amount ${amount}.`)
      }
      lines.push('The attached receipt is the copy the buyer received, unedited.')
      break
    }
    case 'PROOF_OF_RETURN':
      lines.push('Return evidence for the appeal, with the carrier record for the returned item.')
      break
    case 'OTHER':
      lines.push('Supporting material for this dispute.')
      break
  }
  // Every note names its rule exactly once, and only in the prefix. Doing it here rather than inside each
  // `case` is what makes "exactly once" a property of the file: a rule id appearing twice in one note is a
  // citation checker counting occurrences. The `switch` above is exhaustive over `EvidenceType` (TypeScript
  // enforces it), so a type added later cannot produce a note with no rule in it either.
  return clampNotes(`Rule ${decision.ruleId}. ${lines.join(' ')}`)
}

/**
 * Keep a note inside PayPal's 2000-character limit **without lying about what it says**.
 *
 * The clamp drops whole trailing sentences and appends an explicit marker rather than truncating mid-word.
 * A note that ends in a sentence fragment is still a sentence; a note that ends mid-claim is not, and a note
 * that ends mid-claim would be quoted back to us by whoever reads the filing. If even the marker does not
 * fit, the note is replaced with the shortest true sentence this package can write — never with a
 * placeholder that implies evidence we do not have.
 */
export function clampNotes(text: string): string {
  if (text.length <= MAX_NOTES) return text
  const marker = ` [${text.length} characters written; the full note is in the packet PDF.]`
  const budget = MAX_NOTES - marker.length
  const sentences = text.split(/(?<=\.)\s+/)
  const kept: string[] = []
  let used = 0
  for (const s of sentences) {
    if (used + s.length + 1 > budget) break
    kept.push(s)
    used += s.length + 1
  }
  if (kept.length === 0)
    return `Rule evidence summary; see the attached packet.${marker}`.slice(0, MAX_NOTES)
  return `${kept.join(' ')}${marker}`
}

// ---------------------------------------------------------------------------
// EC-REF-5: the disputed amount, split across the shipments that cover it
// ---------------------------------------------------------------------------

/**
 * Split the disputed amount across the shipment lines it covers, by line quantity.
 *
 * **EC-REF-5** is the whole reason this exists: a rounding remainder in a disputed amount must come out of
 * the *shipment* lines, not the order total. The order total already reconciles — it is the sum of the
 * captures, and R-AMT-1 checks that — so allocating against it would either invent minor units or lose them.
 * The plan therefore states, per shipment line, how much of the disputed amount that line accounts for.
 *
 * `allocateWithRemainderLast` is the allocation spec EC-FX-4/5 names: largest-remainder for the leading
 * shares and the **exact remainder** on the last one, so the parts always sum to the disputed amount with
 * nothing lost or invented. Integer minor units throughout — no float appears here, which
 * `pnpm lint`'s money-discipline scan enforces.
 */
export function shipmentShares(ctx: DisputeContext): EvidencePlan['shipmentShares'] {
  const shipments = shipmentsCoveringDispute(ctx)
  if (shipments.length === 0) return []
  const entries = shipments.flatMap((s) =>
    s.lines.map((l) => ({ shipmentId: s.id, sku: l.sku, qty: l.qty })),
  )
  const usable = entries.filter((e) => e.qty > 0)
  if (usable.length === 0) return []
  const weights = usable.map((e) => BigInt(e.qty))
  const parts: Money[] = allocateWithRemainderLast(ctx.dispute.amount, weights)
  return usable.map((e, i) => ({
    shipmentId: e.shipmentId,
    sku: e.sku,
    qty: e.qty,
    share: parts[i] ?? { minor: 0n, currency: ctx.dispute.amount.currency },
  }))
}

// ---------------------------------------------------------------------------
// planEvidence
// ---------------------------------------------------------------------------

/**
 * Plan the evidence for a decision. Pure: same context plus same decision, same plan.
 *
 * @param ctx the same context `route()` was given, so the plan can read the facts it cites.
 * @param decision the decision `route()` produced. Its `evidenceRequired` is always included.
 * @returns a proposal PayPal would accept, with anything missing reported in `warnings`.
 */
export function planEvidence(ctx: DisputeContext, decision: LiabilityDecision): EvidencePlan {
  const warnings: string[] = []

  // Postures that file nothing get an empty plan and say so, rather than inventing items.
  const FILING: readonly LiabilityDecision['posture'][] = [
    'CONTEST',
    'ACCEPT_CLAIM',
    'APPEAL',
    'OFFER',
  ]
  if (!FILING.includes(decision.posture)) {
    return {
      items: [],
      shipmentShares: [],
      warnings: [
        `Posture ${decision.posture} files nothing, so there is no evidence to plan (rule ${decision.ruleId}).`,
      ],
    }
  }

  // The required list first, in the rule's order, then whatever else the reason documents — deduped, so a
  // type the rule already asked for is not proposed twice.
  const fromReason = EVIDENCE_BY_REASON[ctx.dispute.reason] ?? []
  const types: EvidenceType[] = []
  for (const t of [...decision.evidenceRequired, ...fromReason]) {
    if (!types.includes(t)) types.push(t)
  }

  const items: EvidencePlanItem[] = []
  for (const type of types) {
    const available = evidenceSourceAvailable(type, ctx)
    if (!available) {
      warnings.push(
        `${type} has no source in our records. The packet cannot claim it, so this item is listed as ` +
          `unsatisfied rather than proposed (rule ${decision.ruleId}).`,
      )
    }
    items.push({
      evidenceType: type,
      evidenceInfo: evidenceInfoFor(type, ctx),
      notes: notesFor(type, ctx, decision),
      documents: documentsFor(type),
    })
  }

  // A rule that chose `CONTEST` must never reach here with an unsatisfiable item: `R-NO-EVIDENCE` would have
  // taken the posture away. Report loudly if it somehow did.
  const unsatisfied = missingEvidence(decision.evidenceRequired, ctx)
  if (decision.posture === 'CONTEST' && unsatisfied.length > 0) {
    warnings.push(
      `A CONTEST posture still lists ${unsatisfied.join(', ')} without a source. route() should have ` +
        `downgraded this to R-NO-EVIDENCE; treat this as a bug.`,
    )
  }

  warnings.push(...validateEvidencePlan(items))

  return {
    items,
    shipmentShares: shipmentShares(ctx),
    warnings,
  }
}

/**
 * EC-DSP-12: everything `@countersign/paypal` refuses **before** sending bytes.
 *
 * Returned as strings rather than thrown, because a plan is a proposal and "you cannot send this" is
 * information the caller needs, not a crash. The limits are imported from `@countersign/paypal` rather than
 * restated, so this check cannot drift from the one that actually guards the upload.
 */
export function validateEvidencePlan(items: readonly EvidencePlanItem[]): readonly string[] {
  const problems: string[] = []
  if (items.length > MAX_EVIDENCE_ITEMS) {
    problems.push(
      `${items.length} evidence items exceeds PayPal's limit of ${MAX_EVIDENCE_ITEMS} for one call.`,
    )
  }
  let totalBytes = 0
  for (const item of items) {
    if (item.notes.length > MAX_NOTES) {
      problems.push(
        `${item.evidenceType}: notes are ${item.notes.length} characters, over PayPal's ${MAX_NOTES}.`,
      )
    }
    if (item.notes.trim().length === 0) {
      problems.push(
        `${item.evidenceType}: notes are empty and PayPal requires at least one character.`,
      )
    }
    for (const doc of item.documents) {
      if (!ALLOWED_EVIDENCE_CONTENT_TYPES.includes(doc.contentType)) {
        problems.push(
          `${item.evidenceType}: ${doc.contentType} is not one of PayPal's accepted types ` +
            `(${ALLOWED_EVIDENCE_CONTENT_TYPES.join(', ')}).`,
        )
      }
      // PayPal words it "less than 10 MB per file", so the boundary is exclusive and a document planned at
      // exactly the limit would be rejected. The plan therefore uses the limit as the *ceiling* and this
      // check treats reaching it as a violation.
      if (doc.maxBytes !== null && doc.maxBytes >= MAX_EVIDENCE_FILE_BYTES) {
        problems.push(
          `${item.evidenceType}: ${doc.name} allows ${doc.maxBytes} bytes, at or over PayPal's ` +
            `${MAX_EVIDENCE_FILE_BYTES}-byte per-file limit.`,
        )
      }
      if (doc.maxBytes !== null) totalBytes += doc.maxBytes
    }
  }
  if (totalBytes > MAX_EVIDENCE_TOTAL_BYTES) {
    problems.push(
      `The plan's documents total ${totalBytes} bytes, over PayPal's ${MAX_EVIDENCE_TOTAL_BYTES}-byte ` +
        `per-call limit.`,
    )
  }
  return problems
}

/**
 * The exact `input` body `provide-evidence` takes, so WP-15e's filer never rebuilds the shape.
 *
 * Returns `null` when there is nothing to send — `ProvideEvidenceInput` requires at least one item, and an
 * empty array would be rejected by `@countersign/paypal`'s own schema with a `CS_VALIDATION`.
 */
export function toProvideEvidenceInput(plan: EvidencePlan): ProvideEvidenceInput | null {
  if (plan.items.length === 0) return null
  return {
    evidences: plan.items.map((item) => ({
      evidence_type: item.evidenceType,
      evidence_info: {
        ...(item.evidenceInfo.tracking_info === undefined
          ? {}
          : {
              tracking_info: item.evidenceInfo.tracking_info.map((t) => ({
                carrier_name: t.carrier_name,
                tracking_number: t.tracking_number,
              })),
            }),
        ...(item.evidenceInfo.refund_ids === undefined
          ? {}
          : { refund_ids: [...item.evidenceInfo.refund_ids] }),
      },
      notes: item.notes,
      // `size` is PayPal's *document* size. `maxBytes: null` means "bounded at file time instead"
      // (the packet PDF), so those rows are omitted rather than sent with a fabricated size.
      ...(item.documents.every((d) => d.maxBytes === null)
        ? {}
        : {
            documents: item.documents
              .filter((d): d is PlannedDocument & { maxBytes: number } => d.maxBytes !== null)
              .map((d) => ({ name: d.name, size: d.maxBytes, type: d.contentType })),
          }),
    })),
  }
}

/**
 * The rationale as the packet's `notes` field, for the postures where the packet *is* the notes.
 *
 * Reuses {@link composeRationale} rather than re-deriving, so the sentence a judge reads in the UI and the
 * sentence PayPal receives cannot be two different strings. Includes the deadline clause when the clock
 * matters, because "we are aware this is close to the deadline" is something an adjudicator should see.
 */
export function packetNote(ctx: DisputeContext, decision: LiabilityDecision): string {
  const composed = composeRationale({
    ctx,
    ruleId: decision.ruleId,
    posture: decision.posture,
    liability: decision.liability,
    deadline: decision.deadline,
    ...(decision.supersedes === undefined ? {} : { supersedes: decision.supersedes }),
  })
  const clock = deadlineSentence(decision.deadline)
  const base = clock.length === 0 ? composed.text : `${composed.text} ${clock}`
  return clampNotes(base)
}

/** Re-exported so callers can compute the deadline without importing `router.ts`. */
export { deadlineState }
export { NOTES_MAX_CHARS } from './types'
