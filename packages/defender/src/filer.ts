/**
 * The Dispute Defender filer — spec **§8.15**, **§8.16**, **§12.11**, **§7.2**, **§10.2**, work package
 * **WP-15e**. Acceptance **AT-M15.1…6**.
 *
 * ```ts
 * const r = await fileDispute(disputeId, deps, { approval: { by: 'usr_merchant' } })
 * if (!r.ok) return r
 * // r.value.disposition, r.value.filed, r.value.packet, r.value.actionRow
 * ```
 *
 * ## The guarantee, and the mechanism that enforces it
 *
 * Spec **§18 question 20** — *"what stops the AI from filing a bogus dispute against a good customer?"* — and
 * spec **§18 question 24** — *"what if the Defender is wrong?"*. WP-15a answered the first half: `route()` is a
 * pure rules table, so a model cannot choose a posture. This file is the second half.
 *
 * | Question | Answer | Mechanism, not convention |
 * |---|---|---|
 * | can a model make us file? | no | {@link EvidenceUploadPermit} + {@link uploadPermitFor}: the only three call sites, none reachable without a permit |
 * | can a model make us file *more*? | no | the permit carries `evidenceTypes`, taken from the router and **pinned per permit kind** |
 * | can a merchant read why, overrule it, and see it recorded? | yes | one `dispute_actions` row per run — rule id, rationale, packet hash, PayPal response, and the refusal |
 *
 * ### The posture gate is a *type*, not a check
 *
 * The naive filer is a `switch (decision.posture)` with a `provideEvidence` call in the `CONTEST` branch and
 * an `if` somewhere that a future edit could move. This one has no such branch:
 *
 * ```ts
 * const permit = uploadPermitFor({ kind, decision, … })   // null for anything that may not upload
 * if (permit === null) → record the refusal, call nothing
 * // permit.posture is the *literal* type 'CONTEST' | 'APPEAL' | 'ACCEPT_CLAIM'
 * ```
 *
 * Three independent layers, each of which fails on its own:
 *
 * 1. **The permit's `posture` is a literal union, not `Posture`.** A permit minted for `REFUND_PROOF` cannot
 *    be handed to the `CONTEST` branch: `tsc` rejects it and `pnpm typecheck` is a gate.
 * 2. **`uploadPermitFor` is the only mint site, and it returns `null`** for anything outside
 *    {@link UPLOAD_PERMIT_KINDS}. There is no other way to obtain a permit.
 * 3. **The evidence list is inside the permit**, so a permit is not "an upload is allowed" but "an upload of
 *    *exactly this* is allowed". A `REFUND_PROOF` permit can only ever carry `PROOF_OF_REFUND` — an id and a
 *    date we already hold — so it cannot assert anything about the buyer.
 *
 * `test/filer.test.ts` pins all three, plus a **source scan** asserting `provideEvidence(` occurs exactly once
 * in `src/filer.ts`, in `dispatchUpload`, and that `uploadPermitFor` is called from exactly one place. A
 * structural guarantee that exists only as a runtime check is one refactor away from being a convention.
 *
 * ### Why `REFUND_PROOF` is a third permit kind rather than a widening
 *
 * EC-DSP-1 / §18 question 18: *"the router sees the refund and files `PROOF_OF_REFUND`"*. `route()` maps
 * R-REF-1 and R-CNP-1 to posture **`ACCEPT_CLAIM`** with `evidenceRequired: ['PROOF_OF_REFUND']`, and §8.15's own
 * row names that recommendation `PROVIDE_REFUND_PROOF`. So a spec-mandated upload genuinely happens on a
 * non-`CONTEST` posture, and two things follow:
 *
 * - **It is not a widening.** It uploads *one* evidence type whose entire content is refund ids we already
 *    hold, while a `CONTEST` uploads a whole packet of arguments. It strictly **reduces** what can be said to
 *    PayPal relative to a contest, so §18 question 20 is if anything strengthened by it.
 * - **Forbidding it entirely would be worse than a rule conflict, and so would `accept-claim`.**
 *    `accept-claim` on R-REF-1 asks PayPal to refund money that has *already* returned — the double-refund
 *    bug EC-DSP-1 exists to prevent — while refusing the upload loses a case the merchant already paid for.
 *    The gate has to admit this one case or it is not correct.
 *
 * The gate is keyed on `liability === 'ALREADY_REFUNDED'` — the router's own words for "the money already went
 * back" — **and** on every required type being `PROOF_OF_REFUND`. Both come from `route()`, and neither is
 * reachable by a model.
 *
 * ## EC-DSP-7's refusal, which is the reason this file refuses at all
 *
 * Spec EC-DSP-7: *"at < 1 h auto-file is disabled (risk of a partial upload) and the merchant is told to file
 * manually in the PayPal UI"*. Spec EC-DSP-8: past the deadline, `DEF_DEADLINE_PASSED`.
 *
 * Both are refused at step 3, **before** the draft, **before** the PDF, and therefore before any HTTP request
 * exists. That last part is the whole point: `provide-evidence` is a multipart upload, a partial one has
 * already spent the merchant's single response, and a spent response is unrecoverable. `refusal.manual` tells
 * the UI to render "upload it from PayPal now, where you can watch it fail".
 *
 * ## EC-DSP-10: filing the same dispute twice issues one PayPal call
 *
 * Three layers, all keyed on the same two facts:
 *
 * 1. **The packet is content-addressed.** `evidence_packets.bundle_hash` is sha256 over the JCS encoding of
 *    the bundle, so "the same filing" is a decidable question rather than a guess. A packet with this hash
 *    already filed → reuse it, upload nothing.
 * 2. **The action row is keyed on the same string as the PayPal header.**
 *    `disputeActionRequestId(disputeId, 'file', version)` is *both* the `PayPal-Request-Id` **and** the
 *    `dispute_actions.idempotency_key`, and that column is `UNIQUE`. The local uniqueness check and PayPal's
 *    own deduplication therefore cannot disagree about what "already done" means.
 * 3. **The bundle hash is computed before the version is chosen**, which is what makes layer 1 work at all:
 *    a naive `version = latest + 1` would mint a *different* id on the second run and file twice.
 *
 * A **refusal** row uses the key with a `:nofile` suffix, because the bare key means "this filing was sent"
 * and a blocked attempt must not consume it — otherwise the retry after a merchant fixes the note would find
 * the key taken and refuse forever.
 *
 * ## EC-DSP-11: a withdrawn dispute is never filed
 *
 * Checked at step 1b from the mirrored `raw`, via `buyerWithdrew`. A case the buyer took back has no response
 * window to spend and nothing to defend. `ingestDisputeToDefender` has already set `CLOSED_WON`; this file
 * adds the refusal so a caller cannot file it by passing the right id.
 *
 * ## §8.15's approval rule
 *
 * *"A merchant approval click is required unless 'auto-file' is on for the CONTEST + USER_AUTHORISED +
 * chain-valid case."* Implemented literally: {@link AUTO_FILE_EXEMPT_POSTURE} plus
 * {@link autoFileEligible}, and nothing else is exempt. **A refund is a money movement and is never
 * auto-filed**, which is why the REFUND case in `test/filer.test.ts` passes an explicit approval.
 *
 * ## Every run writes a `dispute_actions` row
 *
 * §18 question 24: *"A merchant can read why, overrule it, and see it was recorded. Nothing is filed
 * silently."* So the row is written on the success path **and** on every refusal, and it carries the rule id,
 * the rationale, the packet hash and the PayPal response in `request` / `response` — the two `jsonb` columns
 * §7.2 provides for exactly that.
 *
 * `dispute_actions.action` has **no `REFUND` member** (§7.2's enum is `FILE|OFFER|ACCEPT|MESSAGE|APPEAL|
 * ACK_RETURN|SUPPORTING_INFO|ESCALATE`), so a `REFUND` disposition records `ACCEPT` — the claim stood, we did
 * not fight it — with `request.paypal_call = 'acceptClaim'`, `disposition = 'REFUND'` and
 * `response.paypal_refund_id` carrying the id. Adding a `REFUND` member is a `packages/db` change and
 * therefore not this work package's to make (AGENTS.md rule 8); it is recorded in `README-FILER.md`.
 *
 * The one disposition with **no** row is `REVIEW`: there was no PayPal dispute action to take or refuse, and
 * `dispute_actions` is documented as "every PayPal dispute API call we made". Inventing a member to log "we
 * did nothing" would put a false record in an audit table. The `REVIEW` decision lives on
 * `disputes.router_trace` and `disputes.defense_state`, which are the right columns for it.
 */

import { createHash } from 'node:crypto'

import {
  csError,
  err,
  ok,
  type CsError,
  type CsErrorCode,
  type DisputeActionId,
  type DisputeId,
  type Logger,
  type Money,
  type PacketId,
  type Result,
} from '@countersign/core'
import type {
  DisputeActionRow,
  DisputeRow,
  EvidencePacketRow,
  JsonValue,
  NewDisputeAction,
} from '@countersign/db'
import {
  disputeActionRequestId,
  evidenceFileSizes,
  type DisputeActionToken,
  type EvidenceFile,
  type ProvideEvidenceInput,
} from '@countersign/paypal'

import {
  checkCitations,
  claimSourcesFor,
  publicPacketUrl,
  truncateNotes,
  type Citation,
  type CitationVerdict,
  type ClaimSource,
} from './citation-check'
import {
  buildDisputeContext,
  bundleHashFor,
  buyerWithdrew,
  derivedPacketId,
  toJsonValue,
  type DefenderDeps,
  type DefenderTx,
  type EvidenceBundle,
} from './ingest'
import { planEvidence, toProvideEvidenceInput } from './planner'
import { DEADLINE_CRITICAL_SECONDS } from './rules'
import { route } from './router'
import { proposeStrategy, type StrategistProposal } from './strategist'
import {
  citationFailed,
  draft,
  templateNote,
  type Draft,
  type DraftInput,
  type DraftSource,
  type LanguageModel,
} from './drafter'
import { renderPacketPdf, type PacketError, type PacketView } from './evidence-doc'
import type {
  DisputeActionName,
  DisputeContext,
  EvidencePlan,
  LiabilityDecision,
  Posture,
} from './types'

// ---------------------------------------------------------------------------
// 1. The posture gate
// ---------------------------------------------------------------------------

/**
 * What a permit authorises, in the merchant's language. Three values.
 *
 * Each maps to exactly one `PayPalClient` method — see {@link UPLOAD_PERMIT_KINDS}, which is the whole
 * guarantee expressed as eight lines of data.
 */
export type UploadKind = 'CONTEST' | 'APPEAL' | 'REFUND_PROOF'

/**
 * The permit kinds and the single client method each may call.
 *
 * **`provideEvidence` appears twice and `appeal` once; nothing else is in this record.** `fileDispute` picks a
 * kind, and the only way to learn whether a kind is allowed for a given decision is
 * {@link uploadPermitFor} returning non-`null`.
 */
export const UPLOAD_PERMIT_KINDS: Readonly<Record<UploadKind, 'provideEvidence' | 'appeal'>> =
  Object.freeze({
    CONTEST: 'provideEvidence',
    APPEAL: 'appeal',
    REFUND_PROOF: 'provideEvidence',
  })

/** The `PayPal-Request-Id` token for each kind, from `@countersign/paypal`'s closed `DISPUTE_ACTIONS` set. */
export const UPLOAD_PERMIT_TOKENS: Readonly<Record<UploadKind, DisputeActionToken>> = Object.freeze(
  {
    CONTEST: 'file',
    APPEAL: 'appeal',
    REFUND_PROOF: 'file',
  },
)

/**
 * The permits, as a **discriminated union on literal kinds**.
 *
 * `posture` is a **literal**, never `Posture`. That is the compile-time half of the posture gate: a
 * `REFUND_PROOF` permit has `posture: 'ACCEPT_CLAIM'` and therefore cannot be passed where a `CONTEST` one is
 * required. `test/filer.test.ts` pins it with a `@ts-expect-error`, so the assertion is enforced by
 * `pnpm typecheck` rather than by a comment.
 *
 * `evidenceTypes` is **inside** the permit and pinned by {@link evidenceTypesFor}: a permit is not "an upload
 * is allowed" but "an upload of *exactly these* is allowed".
 */
export type EvidenceUploadPermit =
  | {
      readonly kind: 'CONTEST'
      readonly posture: 'CONTEST'
      readonly ruleId: LiabilityDecision['ruleId']
      readonly evidenceTypes: readonly string[]
      readonly packetId: PacketId
      readonly packetVersion: number
      readonly bundleHash: string
      readonly requestId: string
    }
  | {
      readonly kind: 'APPEAL'
      readonly posture: 'APPEAL'
      readonly ruleId: LiabilityDecision['ruleId']
      readonly evidenceTypes: readonly string[]
      readonly packetId: PacketId
      readonly packetVersion: number
      readonly bundleHash: string
      readonly requestId: string
    }
  | {
      readonly kind: 'REFUND_PROOF'
      /** EC-DSP-1's proof rides on R-REF-1 / R-CNP-1, both of which `route()` calls `ACCEPT_CLAIM`. */
      readonly posture: 'ACCEPT_CLAIM'
      readonly ruleId: LiabilityDecision['ruleId']
      /** Pinned to the single element. Enforced in the mint condition and asserted in the tests. */
      readonly evidenceTypes: readonly ['PROOF_OF_REFUND']
      readonly packetId: PacketId
      readonly packetVersion: number
      readonly bundleHash: string
      readonly requestId: string
    }

/**
 * `POST /v1/customer/disputes/{id}/{action}` per disposition, and `null` where there is no PayPal call.
 *
 * This is the table §18 question 31 asks about, in the form the filer consumes: **a posture routes to its own
 * endpoint or to none.** `REFUND` resolves the case through `accept-claim`, with the exact claim reserved
 * and accounted for by `packages/orders`. EC-REF-4 continues to block direct capture refunds.
 */
export const POSTURE_DISPOSITION: Readonly<
  Record<Posture, { readonly action: DisputeActionName | null; readonly endpoint: string | null }>
> = Object.freeze({
  CONTEST: { action: 'FILE', endpoint: '/v1/customer/disputes/{id}/provide-evidence' },
  APPEAL: { action: 'APPEAL', endpoint: '/v1/customer/disputes/{id}/appeal' },
  ACCEPT_CLAIM: { action: 'ACCEPT', endpoint: '/v1/customer/disputes/{id}/accept-claim' },
  MESSAGE_ONLY: { action: 'MESSAGE', endpoint: '/v1/customer/disputes/{id}/send-message' },
  OFFER: { action: 'OFFER', endpoint: '/v1/customer/disputes/{id}/make-offer' },
  REFUND: { action: 'ACCEPT', endpoint: '/v1/customer/disputes/{id}/accept-claim' },
  REVIEW: { action: null, endpoint: null },
})

/**
 * §8.15's auto-file exception, literally.
 *
 * *"A merchant approval click is required unless 'auto-file' is on for the CONTEST + USER_AUTHORISED +
 * chain-valid case."* Every condition is named in one place so {@link autoFileEligible} cannot grow a clause
 * by accident, and **`REFUND` is deliberately absent** — a refund moves the merchant's money, and no
 * configuration flag should make that automatic.
 */
export const AUTO_FILE_EXEMPT_POSTURE: Posture = 'CONTEST'

/** Is §8.15's auto-file exception satisfied for this decision? */
export function autoFileEligible(ctx: DisputeContext, decision: LiabilityDecision): boolean {
  return (
    decision.posture === AUTO_FILE_EXEMPT_POSTURE &&
    decision.liability === 'USER_AUTHORISED' &&
    (ctx.chain?.verifyAtCaptureChainValid === true || ctx.chain?.verifyNowChainValid === true)
  )
}

/**
 * The evidence types a permit of this kind may carry.
 *
 * **`REFUND_PROOF` carries exactly `['PROOF_OF_REFUND']`, and nothing else can widen it.** This is the whole
 * point of EC-DSP-1's split: R-REF-1's decision is `ACCEPT_CLAIM`, so the planner will happily assemble the
 * reason-derived extras for an `UNAUTHORISED` claim (`DETAILS_OF_PURCHASE`, `ORDER_DETAILS`,
 * `PROOF_OF_RECEIPT_COPY`), and a contest packet attached to an accept-the-money posture is exactly the
 * escalation §18 question 20 forbids. The permit is therefore narrower than the plan, and `dispatchUpload`
 * **narrows the plan to the permit** before anything is rendered or sent — so the pin is a bound on the wire,
 * not a comment. `uploadPermitFor` additionally refuses to mint the permit at all unless the router's own list
 * is exactly `['PROOF_OF_REFUND']`, so the pin is enforced twice: in the value and in the mint condition.
 *
 * `CONTEST` and `APPEAL` carry the router's `evidenceRequired` **plus whatever the planner adds for the
 * reason**, because on those postures more evidence is a stronger case rather than a different one. Passing
 * `plannedTypes` keeps the permit equal to the upload: a permit names what may go out, and if it named less
 * than the body did the gate would be decorative.
 */
export function evidenceTypesFor(
  kind: UploadKind,
  decision: LiabilityDecision,
  plannedTypes: readonly string[] = [],
): readonly string[] {
  if (kind === 'REFUND_PROOF') return ['PROOF_OF_REFUND']
  const out: string[] = []
  for (const t of [...decision.evidenceRequired, ...plannedTypes]) {
    if (!out.includes(t)) out.push(t)
  }
  return out
}

/**
 * Mint an upload permit, or return `null`.
 *
 * **The only constructor of an {@link EvidenceUploadPermit} in the repository.** `null` means "this decision
 * may not attach evidence", and `fileDispute` treats `null` as terminal for the step.
 *
 * Conditions, in the order they are tested:
 *
 * 1. `CONTEST` requires `decision.posture === 'CONTEST'`.
 * 2. `APPEAL` requires `decision.posture === 'APPEAL'`.
 * 3. `REFUND_PROOF` requires `decision.liability === 'ALREADY_REFUNDED'` **and** every member of
 *    `evidenceRequired` to be `PROOF_OF_REFUND`. `ALREADY_REFUNDED` is R-REF-1 and R-CNP-1 and nothing else.
 * 4. An unknown `kind` yields `null`. **There is deliberately no `default: throw`**: a permit that cannot be
 *    minted is a refusal, and a refusal is a recorded outcome rather than an exception inside a dispute job.
 */
export function uploadPermitFor(input: {
  readonly kind: UploadKind
  readonly decision: LiabilityDecision
  /** The planner's evidence types, so the permit names the upload rather than a subset of it. */
  readonly plannedTypes?: readonly string[]
  readonly disputeId: DisputeId
  readonly packetId: PacketId
  readonly packetVersion: number
  readonly bundleHash: string
}): EvidenceUploadPermit | null {
  const { kind, decision, disputeId, packetId, packetVersion, bundleHash } = input
  const base = {
    ruleId: decision.ruleId,
    evidenceTypes: evidenceTypesFor(kind, decision, input.plannedTypes ?? []),
    packetId,
    packetVersion,
    bundleHash,
    // §8.15: `cs:{disputeId}:file:{version}`. Derived from *our* ids, never PayPal's and never a clock
    // (spec §0 rule 6), which is what makes a retry of this job a read of the first attempt.
    requestId: disputeActionRequestId(disputeId, UPLOAD_PERMIT_TOKENS[kind], packetVersion),
  }

  switch (kind) {
    case 'CONTEST':
      return decision.posture === 'CONTEST' ? { ...base, kind, posture: 'CONTEST' } : null
    case 'APPEAL':
      return decision.posture === 'APPEAL' ? { ...base, kind, posture: 'APPEAL' } : null
    case 'REFUND_PROOF': {
      const onlyRefundProof =
        decision.liability === 'ALREADY_REFUNDED' &&
        decision.evidenceRequired.length > 0 &&
        decision.evidenceRequired.every((t) => t === 'PROOF_OF_REFUND')
      return onlyRefundProof
        ? { ...base, kind, posture: 'ACCEPT_CLAIM', evidenceTypes: ['PROOF_OF_REFUND'] as const }
        : null
    }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// 2. Filing guards
// ---------------------------------------------------------------------------

/** Why a filing was refused, in the terms S-18 renders. */
export interface FileRefusal {
  /** A §8.1 registry code: `DEF_DEADLINE_PASSED` for the clock, `DEF_WRONG_STATE` for everything else. */
  readonly code: CsErrorCode
  /** One quotable sentence naming the band or the status, so the UI can render it verbatim. */
  readonly reason: string
  /** Which deadline band refused it. `undefined` for a non-clock refusal. */
  readonly band?: 'CRITICAL' | 'PASSED' | 'UNKNOWN'
  /**
   * `true` when the correct next step is a human at PayPal's own UI. EC-DSP-7's user-facing column:
   * "the merchant is told to file manually in the PayPal UI".
   */
  readonly manual: boolean
  /** §6's `userMessage`, safe to show a merchant. */
  readonly userMessage: string
}

/**
 * Dispositions gated on `status = WAITING_FOR_SELLER_RESPONSE` — §8.15's first filing guard, AT-M15.5.
 *
 * **Keyed on the disposition, not on `POSTURE_DISPOSITION[posture].action`.** That is not a style preference: a
 * `REFUND` posture records `action: 'ACCEPT'` (the enum has no `REFUND` member, §7.2), so a guard keyed on the
 * action name would gate a refund on a *dispute response window* it has nothing to do with — and the first
 * version of this file did exactly that, refusing every refund with `DEF_WRONG_STATE`.
 *
 * `APPEAL` is deliberately absent, and that is a finding about PayPal. An appealable dispute's `status` is
 * `RESOLVED` and its `dispute_state` is `APPEALABLE` (report §11), so a status gate would refuse **every**
 * appeal — precisely the cases EC-DSP-6 exists to catch. PayPal gates the appeal on the `appeal` HATEOAS link
 * instead, and `PayPalClient.appeal` re-reads the dispute to check it.
 */
const STATUS_GATED: ReadonlySet<Disposition> = new Set<Disposition>(['FILE', 'ACCEPT', 'OFFER'])

/**
 * Dispositions gated on the clock — EC-DSP-7's one-hour refusal and EC-DSP-8's `DEF_DEADLINE_PASSED`.
 *
 * `APPEAL` **is** here despite being absent from {@link STATUS_GATED}: it is a multipart upload, so a partial
 * one costs exactly what a partial evidence upload costs, and PayPal does carry `seller_response_due_date`
 * through the appeal window. **The two sets differ on purpose, and that difference is why they are two sets.**
 *
 * `MESSAGE` is exempt. EC-DSP-3 is the reason: it prefers `send-message` at `INQUIRY`, where there is no window
 * at all and usually no deadline, so gating the cheapest action on a filing window would make it the least
 * available one. `REFUND` is exempt because it is **our** money movement, not a PayPal response — the deadline
 * governs PayPal's patience with us, not our right to pay our own customer back.
 */
const DEADLINE_GATED: ReadonlySet<Disposition> = new Set<Disposition>([
  'FILE',
  'APPEAL',
  'ACCEPT',
  'OFFER',
])

/**
 * §8.15's filing guards, as one pure function. `null` means the window is open. AT-M15.5 and EC-DSP-7/8.
 *
 * **The deadline is read from `row.seller_response_due_date`, not from `decision.deadline`.** The decision's
 * band is the router's view of the clock at the moment it ran; the row is the stored authority, and EC-DSP-4
 * says a re-fetched dispute's deadline supersedes the old one. Reading the row also makes this function testable
 * against a deadline the router never saw — which is what "re-read the clock before spending a response" means.
 */
export function responseWindowRefusal(
  row: DisputeRow,
  decision: LiabilityDecision,
  nowSec: number,
  disposition: Disposition = dispositionFor(decision),
): FileRefusal | null {
  if (STATUS_GATED.has(disposition) && row.status !== 'WAITING_FOR_SELLER_RESPONSE') {
    return {
      code: 'DEF_WRONG_STATE',
      reason:
        `This dispute is ${row.status}, not WAITING_FOR_SELLER_RESPONSE, so PayPal has not opened a ` +
        `response window for ${disposition} and nothing was sent (AT-M15.5).`,
      manual: false,
      userMessage: 'PayPal is not asking the seller for a response on this dispute yet.',
    }
  }
  if (!DEADLINE_GATED.has(disposition)) return null

  const due = row.seller_response_due_date
  if (due === null || due === undefined) {
    return {
      code: 'DEF_DEADLINE_PASSED',
      reason:
        'PayPal sent no seller_response_due_date on this dispute, so there is no window to file into and ' +
        'nothing was uploaded (EC-DSP-7).',
      band: 'UNKNOWN',
      manual: true,
      userMessage:
        'PayPal did not give us a response deadline for this dispute. Open it in PayPal and respond there.',
    }
  }

  const secondsLeft = Math.trunc(due.getTime() / 1000) - nowSec
  if (secondsLeft <= 0) {
    return {
      code: 'DEF_DEADLINE_PASSED',
      reason:
        `PayPal's response deadline passed ${Math.abs(secondsLeft)}s ago, so a filing now could not be ` +
        'received. Nothing was uploaded (EC-DSP-8).',
      band: 'PASSED',
      manual: true,
      userMessage: 'PayPal’s response deadline has passed for this dispute.',
    }
  }
  if (secondsLeft <= DEADLINE_CRITICAL_SECONDS) {
    // **EC-DSP-7's refusal, and the reason this file refuses at all.** A multipart upload that fails halfway
    // has already spent the merchant's one response. The refusal is deliberately not `retryable` — retrying is
    // the very thing that would half-upload.
    return {
      code: 'DEF_DEADLINE_PASSED',
      reason:
        `Only ${secondsLeft}s of PayPal's response window remain, and a packet that only half uploads has ` +
        'spent the response. Auto-upload is disabled inside the last hour (EC-DSP-7), so nothing was sent.',
      band: 'CRITICAL',
      manual: true,
      userMessage:
        'Less than an hour left on PayPal’s deadline. Upload it from PayPal now, where you can watch it fail.',
    }
  }
  return null
}

/** EC-DSP-11, as a refusal. */
export function withdrawalRefusal(verdict: {
  readonly withdrew: boolean
  readonly reason: string
}): FileRefusal | null {
  if (!verdict.withdrew) return null
  return {
    code: 'DEF_WRONG_STATE',
    reason: `${verdict.reason} There is nothing left to defend and nothing to file, so no PayPal call was made.`,
    manual: false,
    userMessage: 'The buyer withdrew this dispute, so there is nothing to respond to.',
  }
}

/** `CsError` → `FileRefusal`, so a PayPal failure reaches S-18 in the same shape as a local one. */
export function refusalFromError(error: CsError): FileRefusal {
  return {
    code: error.code,
    reason: error.message,
    manual: false,
    userMessage: error.userMessage,
  }
}

// ---------------------------------------------------------------------------
// 3. The outcome
// ---------------------------------------------------------------------------

/** What the filer set out to do, and which endpoint that means. */
export type Disposition = 'FILE' | 'APPEAL' | 'ACCEPT' | 'MESSAGE' | 'REFUND' | 'OFFER' | 'NONE'

/** The packet we wrote, and everything §7.2 stores about it. */
export interface FiledPacket {
  readonly id: PacketId
  readonly version: number
  /** §7.2's `bundle_hash`: sha256 over the JCS encoding of the bundle. EC-DSP-10's content address. */
  readonly bundleHash: string
  readonly pdfSha256: string
  readonly byteLength: number
  /** The filed text, citation markers included — §8.15 requires the markers to travel. */
  readonly notes: string
  readonly noteSource: DraftSource
  readonly citations: readonly Citation[]
  readonly verdict: CitationVerdict
  /** Which evidence types were sent, in order. */
  readonly evidenceTypes: readonly string[]
  /** The `PayPal-Request-Id` sent: `cs:{disputeId}:file:{version}` per §8.15. */
  readonly requestId: string
}

export interface FileOutcome {
  readonly disputeId: DisputeId
  readonly paypalDisputeId: string
  /** Always present, even on a refusal — the merchant is told what the router decided either way. */
  readonly decision: LiabilityDecision
  readonly disposition: Disposition
  /** `true` only when PayPal accepted an evidence upload. */
  readonly filed: boolean
  /** `true` when this call made no PayPal request because an identical one was already recorded. EC-DSP-10. */
  readonly alreadyFiled: boolean
  readonly packet?: FiledPacket
  /** The `REFUND` disposition's result, straight off `DefenderRefunds`. */
  readonly refund?: {
    readonly refundId: string
    readonly paypalRefundId?: string
    readonly amount: Money
    readonly status?: 'PENDING' | 'COMPLETED'
    readonly requestId?: string
  }
  /** EC-DSP-1's `refund_ids`, whether or not a proof packet went out. */
  readonly proofOfRefund?: {
    readonly refundIds: readonly string[]
    readonly uploaded: boolean
    readonly note: string
  }
  /** The `MESSAGE_ONLY` text, composed, never generated. */
  readonly message?: { readonly sent: boolean; readonly text: string }
  /** The `OFFER` disposition's strategist proposal. `fileDispute` never calls `make-offer` itself. */
  readonly proposal?: StrategistProposal
  readonly refusal?: FileRefusal
  /** EC-MER-5's quotable lines, when the citation checker refused the note. */
  readonly blocked?: readonly string[]
  readonly awaitingApproval: boolean
  readonly awaitingHuman: boolean
  /** The `dispute_actions` row this run wrote. Absent only for `REVIEW`, which has no enum member. */
  readonly actionRow?: {
    readonly id: DisputeActionId
    readonly action: DisputeActionName
    readonly idempotencyKey: string
  }
  /**
   * Every PayPal method name this run called, in order.
   *
   * Exposed rather than kept private because it is the assertion Judge Mode and the tests both want:
   * *"the only PayPal call is the refund"* is not checkable without a list. It is **derived from real calls**,
   * not asserted by hand, so it cannot drift from what actually happened.
   */
  readonly paypalCalls: readonly string[]
  readonly warnings: readonly string[]
}

/** Who authorised a filing. §8.15's "merchant approval click". */
export interface FilingApproval {
  /** `dispute_actions.actor`: `MERCHANT`, `DEFENDER` (auto-file), or a user id. */
  readonly by: string
  /** Why the merchant said yes. Shown in the S-17 timeline beside the action. */
  readonly note?: string
}

/** One document the merchant is attaching. EC-DSP-12's limits are enforced inside `@countersign/paypal`. */
export interface FilingAttachment {
  readonly fileName: string
  readonly contentType?: string
  readonly content: Uint8Array | ArrayBuffer | Blob | string
}

export interface FileOptions {
  /**
   * The merchant's click. Absent means **nothing that touches PayPal is sent**, and the outcome comes back
   * `awaitingApproval: true` — except for §8.15's auto-file case, which needs {@link FileOptions.autoFile}.
   */
  readonly approval?: FilingApproval
  /** §8.15's "unless 'auto-file' is on". Consulted only for {@link AUTO_FILE_EXEMPT_POSTURE}. */
  readonly autoFile?: boolean
  /** Carrier confirmations, receipts, specification sheets. EC-DSP-12 checks each one. */
  readonly attachments?: readonly FilingAttachment[]
  /** Overrides the clock for this call, so a test can pin the CRITICAL window exactly. */
  readonly nowSec?: number
}

export interface FileDeps extends DefenderDeps {
  /**
   * The drafter's model port. **Optional, and that is a feature rather than a convenience.**
   *
   * §18 question 35 / EC-LLM-1: with no model the filer composes the note from `templateNote()`, which
   * `checkCitations` passes **by construction**. So a filing is possible with no key at all, and the note that
   * gets filed has the same shape as the one a model would have been allowed to file.
   * `docs/HUMAN_TODO.md` H-02 (no OpenAI key) therefore cannot affect a single test in this package.
   */
  readonly llm?: LanguageModel
  /**
   * `renderPacketPdf`, injectable so a test can prove the **filer's** guard ordering rather than the
   * renderer's redaction. Defaults to the real renderer.
   */
  readonly renderPdf?: (
    view: PacketView,
    deps: { readonly clock: Logger extends never ? never : ClockLike },
  ) => Promise<Result<RenderedLike, CsError>>
}

/** The clock shape `renderPacketPdf` needs, re-declared structurally so `FileDeps` needs no clock import. */
interface ClockLike {
  nowMs(): number
  nowSec(): number
}

/** The renderer output the filer reads, so the port is not tied to WP-15d's exact return type. */
interface RenderedLike {
  readonly bytes: Uint8Array
  readonly sha256: string
  readonly byteLength: number
}

// ---------------------------------------------------------------------------
// 4. fileDispute
// ---------------------------------------------------------------------------

/** Everything one run carries between steps. A single object, so nothing is threaded by hand. */
interface Run {
  readonly row: DisputeRow
  readonly ctx: DisputeContext
  readonly decision: LiabilityDecision
  readonly deps: FileDeps
  readonly options: FileOptions
  readonly at: Date
  readonly nowSec: number
  /**
   * This run's request-id token, computed once at step 3 from the disposition.
   *
   * On the `Run` rather than passed to each dispatcher because **the refusal branches need it too** — a
   * `dispute_actions` row's `idempotency_key` is part of what makes a refusal reviewable, so a branch that never
   * reaches a PayPal call still has to name the key it would have used.
   */
  readonly token?: DisputeActionToken
  /** Real PayPal method calls, appended at the call site. `FileOutcome.paypalCalls` is a copy of this. */
  readonly paypalCalls: string[]
  readonly warnings: string[]
}

/**
 * Decide, draft, render and file — or record why not.
 *
 * ```ts
 * const r = await fileDispute(disputeId, deps, { approval: { by: 'usr_merchant' } })
 * ```
 *
 * The order, and **each step's failure is terminal for that step** while the `dispute_actions` row is written
 * regardless (§18 question 24):
 *
 * | # | Step | Terminal outcome |
 * |---|---|---|
 * | 0 | load the row | `CS_NOT_FOUND` |
 * | 1 | `route(ctx)` — the router decides | `err` (it should be unreachable; §8.0 rule 3) |
 * | 1b | EC-DSP-11 withdrawal | refusal, no PayPal call |
 * | 2 | **store `liability` + `router_trace`; log rule id and rationale** | `err` |
 * | 3 | filing guards — status, then the clock | `FileRefusal`, **no PayPal call** |
 * | 4 | approval (§8.15) | `awaitingApproval`, no PayPal call |
 * | 5 | posture dispatch | see below |
 *
 * **Step 2 is before step 5 by requirement, not by taste.** "Log and store the rule id and rationale before
 * acting" is the difference between a case file that explains itself and one that has to be reconstructed
 * afterwards — which is exactly what §18 question 24 asks about.
 *
 * @param disputeId our `dsp_…` id, never PayPal's. §0 rule 6: request ids are derived from our own ids.
 * @returns **A refusal is `ok`, not `err`.** A refused filing is a successful run of the filer that produced
 *   a recorded outcome, and collapsing the two would make the S-17 timeline lose every refusal in the
 *   product — which is the opposite of what EC-MER-7 and §18 q24 need.
 */
export async function fileDispute(
  disputeId: string,
  deps: FileDeps,
  options: FileOptions = {},
): Promise<Result<FileOutcome, CsError>> {
  // --- 0. the row ---------------------------------------------------------------------------------
  const found = await deps.store.disputes.findById(disputeId as DisputeId)
  if (!found.ok) return found
  const row = found.value
  if (row === undefined) {
    return err(
      csError(
        'CS_NOT_FOUND',
        `No disputes row for ${disputeId}, so there is nothing to file. Ingest the dispute first.`,
        { dispute_id: disputeId },
        { userMessage: 'We could not find that dispute.' },
      ),
    )
  }

  // --- 1. the router decides -----------------------------------------------------------------------
  const ctx = await buildDisputeContext(row, undefined, deps)
  if (!ctx.ok) return ctx
  const decision = route(ctx.value)

  const at = new Date(deps.clock.nowMs())
  const nowSec = options.nowSec ?? deps.clock.nowSec()
  const disposition = dispositionFor(decision)
  const dispositionToken = tokenFor(disposition)
  const run: Run = {
    row,
    ctx: ctx.value,
    decision,
    deps,
    options,
    at,
    nowSec,
    ...(dispositionToken === undefined ? {} : { token: dispositionToken }),
    paypalCalls: [],
    warnings: [],
  }

  // A durable intent is checked for EVERY posture: a changed body may change the router's posture.
  const claimed = await deps.store.actions.findByIdempotencyKey(refundClaimKey(row.id))
  if (!claimed.ok) return claimed
  if (claimed.value) {
    const request = claimed.value.request as Record<string, unknown> | null
    const changed =
      request?.['refund_amount_minor'] !== row.amount_minor.toString() ||
      request?.['refund_currency'] !== row.currency ||
      request?.['capture_id'] !== row.capture_id ||
      request?.['paypal_dispute_id'] !== row.paypal_dispute_id
    return finish(run, {
      disposition: 'REFUND',
      filed: false,
      alreadyFiled: true,
      awaitingApproval: false,
      awaitingHuman: changed || row.defense_state !== 'CLOSED_REFUNDED',
      ...(changed || row.defense_state !== 'CLOSED_REFUNDED'
        ? {
            refusal: {
              code: 'DEF_WRONG_STATE' as const,
              reason: changed
                ? 'This dispute refund is bound to a different claim payload; no second payment is permitted.'
                : 'This dispute refund was already reserved. Reconcile its result before taking further action.',
              manual: true,
              userMessage: 'A refund was already submitted for this dispute. Review its status.',
            },
          }
        : {}),
      logLine: 'EC-IDEM-4: existing dispute refund intent; no money call',
    })
  }

  // --- 1b. EC-DSP-11 ------------------------------------------------------------------------------
  const withdrawal = withdrawalRefusal(buyerWithdrew(row.raw))
  if (withdrawal !== null) {
    return finish(run, {
      disposition: 'NONE',
      filed: false,
      alreadyFiled: false,
      awaitingApproval: false,
      awaitingHuman: true,
      refusal: withdrawal,
      logLine: 'EC-DSP-11: the buyer withdrew this dispute; nothing filed',
    })
  }

  // --- 2. store the verdict BEFORE acting -----------------------------------------------------------
  const stored = await deps.store.disputes.setLiability(
    row.id,
    decision.liability,
    routerTraceOf(decision, ctx.value),
    at,
  )
  if (!stored.ok) return stored
  deps.logger?.info('defender.file: router decided', {
    dispute_id: row.id,
    rule_id: decision.ruleId,
    posture: decision.posture,
    liability: decision.liability,
    rationale: decision.rationale,
    deadline_band: decision.deadline.state,
  })

  // --- 3. filing guards ---------------------------------------------------------------------------
  // The disposition and its request-id token were computed when the `Run` was built, so the guard, the approval
  // branch and the dispatch all agree on which key this run's row will carry.
  const token = run.token
  const guarded = responseWindowRefusal(stored.value, decision, nowSec, disposition)
  if (guarded !== null) {
    return finish(run, {
      disposition,
      filed: false,
      alreadyFiled: false,
      awaitingApproval: false,
      awaitingHuman: guarded.band !== undefined,
      token,
      refusal: guarded,
      logLine: `refused before any PayPal call: ${guarded.code}${guarded.band === undefined ? '' : `/${guarded.band}`}`,
    })
  }

  // --- 4. approval (§8.15) ------------------------------------------------------------------------
  const actor =
    options.approval?.by ??
    (options.autoFile === true && autoFileEligible(ctx.value, decision) ? 'DEFENDER' : null)
  if (actor === null) {
    return finish(run, {
      disposition,
      filed: false,
      alreadyFiled: false,
      awaitingApproval: true,
      awaitingHuman: false,
      token,
      refusal: {
        code: 'DEF_WRONG_STATE',
        reason:
          `§8.15 requires a merchant approval click before ` +
          `${POSTURE_DISPOSITION[decision.posture].action ?? 'any PayPal action'} on a ` +
          `${decision.posture} posture (rule ${decision.ruleId}). Nothing was sent.`,
        manual: false,
        userMessage: 'This action needs your approval before we send anything to PayPal.',
      },
      logLine: 'awaiting the merchant approval §8.15 requires; no PayPal call',
    })
  }

  // --- 5. posture dispatch ------------------------------------------------------------------------
  switch (decision.posture) {
    case 'REVIEW':
      return finish(run, {
        disposition: 'NONE',
        filed: false,
        alreadyFiled: false,
        awaitingApproval: false,
        awaitingHuman: true,
        refusal: {
          code: 'DEF_WRONG_STATE',
          reason: `${
            decision.blockingReason ?? `Rule ${decision.ruleId} sent this to a person.`
          } The router's answer is not ours to override, so no PayPal call was made.`,
          manual: false,
          userMessage: 'A person needs to decide what happens on this dispute.',
        },
        logLine: 'REVIEW: a human decides; no PayPal call',
      })

    case 'MESSAGE_ONLY':
      return dispatchMessage(run, actor)

    case 'OFFER': {
      // The amount of a partial refund is a money decision, so `fileDispute` **proposes** and
      // `strategist-actions.ts` sends after the click. §8.16: "every action needs a merchant click".
      const proposal = await proposeStrategy(run.ctx, run.decision, { priorOffers: [] })
      if (!proposal.ok) return proposal
      return finish(run, {
        disposition: 'OFFER',
        filed: false,
        alreadyFiled: false,
        awaitingApproval: true,
        awaitingHuman: false,
        proposal: proposal.value,
        refusal: {
          code: 'DEF_WRONG_STATE',
          reason:
            `Rule ${decision.ruleId} chose ${decision.posture}. The offer amount is a money decision, so a ` +
            'proposal was recorded with its expected cost and no PayPal call was made.',
          manual: false,
          userMessage: 'Review the proposed offer, then approve it to send it to PayPal.',
        },
        logLine: 'OFFER: proposal recorded; awaiting the click that sends it',
      })
    }

    case 'REFUND':
      return dispatchRefund(run, actor)

    case 'ACCEPT_CLAIM':
      // EC-DSP-1's split: `ALREADY_REFUNDED` must upload the refund proof, because `accept-claim` would ask
      // PayPal to refund money that has already been returned. See the file header.
      return decision.liability === 'ALREADY_REFUNDED'
        ? dispatchUpload(run, 'REFUND_PROOF', actor)
        : dispatchAcceptClaim(run, actor)

    case 'CONTEST':
      return dispatchUpload(run, 'CONTEST', actor)

    case 'APPEAL':
      return dispatchUpload(run, 'APPEAL', actor)
  }
}

/** Which disposition a posture means. Derived from {@link POSTURE_DISPOSITION} so there is one table. */
function refundClaimKey(disputeId: string): string {
  return `cs:${disputeId}:refund:claim`
}

function dispositionFor(decision: LiabilityDecision): Disposition {
  switch (decision.posture) {
    case 'CONTEST':
      return 'FILE'
    case 'APPEAL':
      return 'APPEAL'
    case 'ACCEPT_CLAIM':
      return 'ACCEPT'
    case 'MESSAGE_ONLY':
      return 'MESSAGE'
    case 'OFFER':
      return 'OFFER'
    case 'REFUND':
      return 'REFUND'
    case 'REVIEW':
      return 'NONE'
  }
}

/**
 * The `PayPal-Request-Id` token for a disposition, from §8.6's closed `DISPUTE_ACTIONS` set.
 *
 * **One table, so the guard branch, the approval branch and the dispatch cannot disagree about the key a run's
 * row carries.** A refusal's key is this token plus `:nofile`, which is why the token has to be computable
 * before anything is sent.
 */
export function tokenFor(disposition: Disposition): DisputeActionToken | undefined {
  switch (disposition) {
    case 'FILE':
      return 'file'
    case 'APPEAL':
      return 'appeal'
    case 'ACCEPT':
      return 'claim'
    case 'MESSAGE':
      return 'msg'
    // A refund's own key belongs to `packages/orders` (`cs:{captureId}:ref:{refundId}`) and is written on the
    // `refunds` row. This key identifies *this dispute disposition*, so it stays in the dispute's own id space
    // and cannot collide with an orders refund key.
    case 'REFUND':
      return 'offer'
    case 'OFFER':
      return 'offer'
    case 'NONE':
      return undefined
  }
}

// ---------------------------------------------------------------------------
// 5. The dispatchers
// ---------------------------------------------------------------------------

interface Done {
  readonly disposition: Disposition
  readonly filed: boolean
  readonly alreadyFiled: boolean
  readonly awaitingApproval: boolean
  readonly awaitingHuman: boolean
  readonly actor?: string
  readonly refusal?: FileRefusal
  readonly blocked?: readonly string[]
  readonly packet?: FiledPacket
  readonly refund?: FileOutcome['refund']
  readonly proofOfRefund?: FileOutcome['proofOfRefund']
  readonly message?: FileOutcome['message']
  readonly proposal?: StrategistProposal
  readonly token?: DisputeActionToken
  readonly version?: number
  readonly logLine?: string
  readonly errors?: readonly PacketError[]
}

/**
 * `MESSAGE_ONLY`: write to the buyer.
 *
 * The text is **composed** from the router's own rationale and the facts it read. §18 question 4 puts the model
 * on "proposing a strategy", not on narrating a decision the router already made, and a message that
 * paraphrases the rationale is a second claim about the same facts. It is clamped to PayPal's 2000 characters
 * by the same `truncateNotes` the note path uses, and it names the rule id, because the buyer deserves to know
 * a deterministic table decided this rather than a machine having an opinion.
 *
 * EC-DSP-3 makes this the preferred action at `INQUIRY`, which is why it is not gated on the response window
 * (see {@link RESPONSE_SPENDING}).
 */
async function dispatchMessage(run: Run, actor: string): Promise<Result<FileOutcome, CsError>> {
  const token = run.token
  const text = buyerMessageFor(run.decision)
  const sent = await run.deps.paypal.sendMessage(run.row.paypal_dispute_id, text, {
    requestId: disputeActionRequestId(run.row.id, 'msg', 1),
  })
  if (sent.ok) run.paypalCalls.push('sendMessage')
  if (sent.ok) {
    const defense = await run.deps.store.disputes.setDefenseState(run.row.id, 'ACCEPTED', run.at)
    if (!defense.ok) return defense
  }
  return finish(run, {
    disposition: 'MESSAGE',
    filed: false,
    alreadyFiled: false,
    awaitingApproval: false,
    awaitingHuman: false,
    actor,
    token,
    message: { sent: sent.ok, text },
    ...(sent.ok ? {} : { refusal: refusalFromError(sent.error) }),
    logLine: sent.ok ? 'MESSAGE sent' : `MESSAGE refused: ${sent.error.code}`,
  })
}

/**
 * The buyer-facing message, composed from the decision.
 *
 * Three sentences, each of which is a claim we can support: the rule that decided, what it compared, and what
 * happens next. **No claim about delivery, notification or carrier verification** — those are the three
 * sentences a merchant most wants to write, which is why the citation checker's `FORBIDDEN_DERIVATION` rules
 * exist at all.
 */
export function buyerMessageFor(decision: LiabilityDecision): string {
  return truncateNotes(
    [
      decision.rationale,
      'Our analysis of a dispute is a set of deterministic rules over our own records, and the rule that ' +
        'decided your case is named above. You can ask us for any of those records.',
      'Nothing further is needed from you right now. If you have something that changes the picture — a ' +
        'carrier confirmation, or a conversation with us — reply here and we will read it.',
    ].join(' '),
  ).notes
}

/**
 * `REFUND`: pay the buyer, through `packages/orders`.
 *
 * **No amount arithmetic here.** The amount is the disputed amount, already an exact `Money` read off the row,
 * and the over-refund guard belongs to `orders` — see `DefenderRefunds` in `ingest.ts` for why the money
 * movement is a port and what breaks if it is wired to something that skips the `refunds` row.
 *
 * The result's `paypalRefundId` goes into `dispute_actions`, which is both what §18 question 24 needs and what
 * lets EC-DSP-1's *next* run see the refund through `refundedTotal(ctx)`.
 */
async function dispatchRefund(run: Run, actor: string): Promise<Result<FileOutcome, CsError>> {
  const token = run.token
  const captureId = run.ctx.capture?.id ?? run.row.capture_id
  if (captureId === undefined || captureId === null) {
    return finish(run, {
      disposition: 'REFUND',
      filed: false,
      alreadyFiled: false,
      awaitingApproval: false,
      awaitingHuman: true,
      actor,
      token,
      refusal: {
        code: 'DEF_NO_CHAIN',
        reason:
          `Rule ${run.decision.ruleId} decided REFUND, but this dispute has no capture of ours to refund ` +
          'against, so no money moved. A chargeback with no capture is EC-DSP-9.',
        manual: true,
        userMessage:
          'We could not find the payment this dispute is about, so nothing was refunded.',
      },
      logLine: 'REFUND refused: no capture to refund',
    })
  }

  const amount: Money = { minor: run.row.amount_minor, currency: run.row.currency }
  const idempotencyKey = `cs:${run.row.id}:refund:${amount.minor}:${amount.currency}`
  // UNIQUE dispute-only claim key closes concurrent jobs and changed-body retries BEFORE the port.
  const claimed = await run.deps.store.actions.record({
    id: derivedActionId(refundClaimKey(run.row.id)),
    dispute_id: run.row.id,
    action: 'ACCEPT',
    request: {
      disposition: 'REFUND',
      refund_amount_minor: amount.minor.toString(),
      refund_currency: amount.currency,
      capture_id: run.row.capture_id,
      paypal_dispute_id: run.row.paypal_dispute_id,
      refund_idempotency_key: idempotencyKey,
    },
    response: { refund_reserved: true, paypal_call: 'unknown' },
    actor,
    idempotency_key: refundClaimKey(run.row.id),
    at: run.at,
  })
  if (!claimed.ok) return claimed
  const result = await run.deps.refunds.refund({
    captureId,
    amount,
    reason: `Dispute ${run.row.paypal_dispute_id}: rule ${run.decision.ruleId} decided ${run.decision.posture}.`,
    actor,
    disputeId: run.row.id,
    paypalDisputeId: run.row.paypal_dispute_id,
    idempotencyKey,
    ruleId: run.decision.ruleId,
  })
  if (!result.ok) {
    return finish(run, {
      disposition: 'REFUND',
      filed: false,
      alreadyFiled: false,
      awaitingApproval: false,
      awaitingHuman: true,
      actor,
      token,
      refusal: { ...refusalFromError(result.error), manual: true },
      logLine: `REFUND refused: ${result.error.code}`,
    })
  }
  if (result.value.paypalCall) run.paypalCalls.push(result.value.paypalCall)
  else if (result.value.status === undefined) run.paypalCalls.push('acceptClaim')

  const completed = result.value.status !== 'PENDING' && result.value.paypalRefundId !== undefined
  const defense = await run.deps.store.disputes.setDefenseState(
    run.row.id,
    completed ? 'CLOSED_REFUNDED' : run.row.defense_state,
    run.at,
  )
  if (!defense.ok) return defense

  return finish(run, {
    disposition: 'REFUND',
    filed: false,
    alreadyFiled: false,
    awaitingApproval: false,
    awaitingHuman: !completed,
    actor,
    token,
    refund: {
      refundId: result.value.refundId,
      ...(result.value.paypalRefundId === undefined
        ? {}
        : { paypalRefundId: result.value.paypalRefundId }),
      ...(result.value.status === undefined ? {} : { status: result.value.status }),
      ...(result.value.requestId === undefined ? {} : { requestId: result.value.requestId }),
      amount: result.value.amount,
    },
    logLine: completed
      ? `REFUND completed: PayPal refund ${result.value.paypalRefundId}`
      : 'Dispute refund accepted; refund read-back pending reconciliation',
  })
}

/**
 * `ACCEPT_CLAIM` on the paths that are not EC-DSP-1's.
 *
 * `accept-claim` is the spec's own `ACCEPT_CLAIM` recommendation for R-CHAIN-BAD, R-NOCHAIN-1 below the
 * merchant's threshold, R-UNAUTH-2 and R-UNAUTH-3 below the threshold — none of which has a completed refund,
 * so none of them can double-refund. The note is the router's own rationale, clamped, so a merchant reading
 * PayPal's thread sees the rule rather than a sentence a model wrote.
 */
async function dispatchAcceptClaim(run: Run, actor: string): Promise<Result<FileOutcome, CsError>> {
  const token = run.token
  const note = truncateNotes(run.decision.rationale).notes
  const sent = await run.deps.paypal.acceptClaim(
    run.row.paypal_dispute_id,
    { accept_claim_type: 'REFUND', note },
    { requestId: disputeActionRequestId(run.row.id, 'claim', 1) },
  )
  if (sent.ok) run.paypalCalls.push('acceptClaim')
  if (sent.ok) {
    const defense = await run.deps.store.disputes.setDefenseState(run.row.id, 'ACCEPTED', run.at)
    if (!defense.ok) return defense
  }
  return finish(run, {
    disposition: 'ACCEPT',
    filed: false,
    alreadyFiled: false,
    awaitingApproval: false,
    awaitingHuman: false,
    actor,
    token,
    ...(sent.ok ? {} : { refusal: refusalFromError(sent.error) }),
    logLine: sent.ok ? 'ACCEPT sent' : `ACCEPT refused: ${sent.error.code}`,
  })
}

/**
 * The upload path: `CONTEST`, `APPEAL`, and EC-DSP-1's `REFUND_PROOF`.
 *
 * The order is the spec's, and each step's failure is terminal for that step:
 *
 * 1. **Build the bundle and hash it.** `bundle_hash` is the content address that makes EC-DSP-10 decidable.
 * 2. **Resolve the packet.** An existing packet with this hash, already filed → **return, zero PayPal calls**.
 *    An existing *unfilled* packet with this hash → resume it at its own version and id. Otherwise → a new
 *    packet at `max(version) + 1`, which is EC-DSP-4's "new packet version".
 * 3. **Mint the permit.** `null` → nothing is uploaded and the reason is recorded.
 * 4. **Check the action row for the request id.** A row whose `paypal_call` is `sent` → return, zero calls.
 * 5. **Draft, then check the final text.** EC-MER-5. A blocked note is not filed.
 * 6. **Render the PDF** from the §7.3 bundle, with the artefact inventory and the mandated read-back.
 * 7. **Size-check the attachments** through `@countersign/paypal`'s own `evidenceFileSizes`, so an EC-DSP-12
 *    refusal names the file **before any bytes move**. The limits are not re-implemented here; the client
 *    checks them again inside `buildEvidenceForm`, which is the belt to this braces.
 * 8. **Persist the packet, then upload.** The packet row is written *before* the call so a timeout still
 *    leaves a case file, and `markPacketFiled` writes PayPal's answer onto it afterwards.
 */
async function dispatchUpload(
  run: Run,
  kind: UploadKind,
  actor: string,
): Promise<Result<FileOutcome, CsError>> {
  const { row, decision, deps, ctx } = run
  const disposition: Disposition = kind === 'APPEAL' ? 'APPEAL' : 'FILE'
  // `kind` is `APPEAL` only when the posture is `APPEAL`, and `CONTEST`/`REFUND_PROOF` both mean `file`, so
  // this is the same value `tokenFor(disposition)` computed at step 3 — restated here so the permit's key and the
  // row's key are read off the same two words rather than off two independently maintained tables.
  const token = UPLOAD_PERMIT_TOKENS[kind]

  // --- 1. the bundle ---------------------------------------------------------------------------------
  if (row.order_id === null || row.order_id === undefined) {
    return finish(run, {
      disposition,
      filed: false,
      alreadyFiled: false,
      awaitingApproval: false,
      awaitingHuman: true,
      actor,
      token,
      refusal: {
        code: 'DEF_NO_CHAIN',
        reason:
          `Rule ${decision.ruleId} reached ${decision.posture}, but this dispute is not linked to an order, so ` +
          'there is no bundle to file. EC-DSP-9.',
        manual: true,
        userMessage:
          'This dispute is not linked to a Countersign order, so there is nothing to file.',
      },
      logLine: 'upload refused: no order link, so no §7.3 bundle',
    })
  }
  const bundle = await deps.store.evidence.bundle(row.order_id)
  if (!bundle.ok) return bundle
  const bundleHash = bundleHashFor(bundle.value as unknown as Record<string, unknown>)

  // --- 2. EC-DSP-10: which packet? ---------------------------------------------------------------------
  const existing = await deps.store.packets.forDispute(row.id)
  if (!existing.ok) return existing
  const same = existing.value.find((p) => p.bundle_hash === bundleHash)
  if (same !== undefined && same.filed_at !== null) {
    run.warnings.push(
      `A packet with bundle_hash ${bundleHash} was already filed as ${same.id} v${same.version}. Nothing was ` +
        'uploaded (EC-DSP-10).',
    )
    return finish(run, {
      disposition,
      filed: false,
      alreadyFiled: true,
      awaitingApproval: false,
      awaitingHuman: false,
      actor,
      token,
      version: same.version,
      packet: packetReportOf(same),
      logLine: 'EC-DSP-10: an identical packet is already filed; no PayPal call',
    })
  }
  const version = same !== undefined ? same.version : nextPacketVersion(existing.value)
  const packetId = same?.id ?? derivedPacketId(row.id, version)

  // --- 3. the permit ----------------------------------------------------------------------------------
  // The plan is derived here rather than at step 5 because **the permit has to name the upload**: it is the
  // gate, and a gate that names less than the body is decorative. `planEvidence` is pure, so calling it twice
  // would be wasted work; it is computed once and carried.
  const plan = planEvidence(ctx, decision)
  const permit = uploadPermitFor({
    kind,
    decision,
    plannedTypes: plan.items.map((i) => i.evidenceType),
    disputeId: row.id,
    packetId,
    packetVersion: version,
    bundleHash,
  })
  if (permit === null) {
    return finish(run, {
      disposition,
      filed: false,
      alreadyFiled: false,
      awaitingApproval: false,
      awaitingHuman: false,
      actor,
      token,
      version,
      refusal: {
        code: 'DEF_WRONG_STATE',
        reason:
          `No upload permit exists for kind ${kind} on rule ${decision.ruleId} with posture ` +
          `${decision.posture}. Nothing was sent to PayPal.`,
        manual: false,
        userMessage: 'This decision is not one we file.',
      },
      logLine: `no upload permit for ${kind} (posture ${decision.posture})`,
    })
  }

  // --- 4. EC-DSP-10: has this exact filing already gone out? ---------------------------------------------
  const prior = await deps.store.actions.findByIdempotencyKey(permit.requestId)
  if (!prior.ok) return prior
  if (prior.value !== undefined && responseSentPaypalCall(prior.value.response)) {
    run.warnings.push(
      `dispute_actions already records ${permit.requestId} as sent. Nothing was uploaded (EC-DSP-10).`,
    )
    return finish(run, {
      disposition,
      filed: false,
      alreadyFiled: true,
      awaitingApproval: false,
      awaitingHuman: false,
      actor,
      token,
      version,
      logLine: `EC-DSP-10: ${permit.requestId} is already recorded as sent; no PayPal call`,
    })
  }

  // --- 5. draft, then check the FINAL text --------------------------------------------------------------
  const claims: readonly ClaimSource[] = claimSourcesFor(ctx, decision)
  const draftInput: DraftInput = {
    ctx,
    decision,
    plan,
    packetId,
    publicBaseUrl: deps.publicBaseUrl,
    claims,
  }
  const allowedUrl = publicPacketUrl(deps.publicBaseUrl, packetId)
  const noted = await draftNote(draftInput, deps, allowedUrl, claims)
  if (!noted.ok) {
    return finish(run, {
      disposition,
      filed: false,
      alreadyFiled: false,
      awaitingApproval: false,
      awaitingHuman: false,
      actor,
      token,
      version,
      // **EC-MER-5's quotable lines.** `citationFailed` puts them in `details.problems`, one formatted line
      // each, which is exactly what S-18 renders beside the offending sentence.
      ...(Array.isArray(noted.error.details?.['problems'])
        ? { blocked: (noted.error.details['problems'] as string[]).map(String) }
        : {}),
      refusal: refusalFromError(noted.error),
      logLine: `EC-MER-5 blocked: ${noted.error.code}`,
    })
  }

  // --- 6. the PDF -------------------------------------------------------------------------------------
  const render =
    deps.renderPdf ?? (renderPacketPdf as unknown as NonNullable<FileDeps['renderPdf']>)
  const rendered = await render(
    packetViewFor(run, { packetId, version, bundle: bundle.value, noted: noted.value }),
    {
      clock: deps.clock,
    },
  )
  if (!rendered.ok) {
    return finish(run, {
      disposition,
      filed: false,
      alreadyFiled: false,
      awaitingApproval: false,
      awaitingHuman: false,
      actor,
      token,
      version,
      refusal: refusalFromError(rendered.error),
      logLine: `PDF render refused: ${rendered.error.code}`,
    })
  }

  // --- 7. EC-DSP-12, through packages/paypal's own reader -------------------------------------------------
  const files: EvidenceFile[] = [
    {
      fileName: `packet-${packetId}.pdf`,
      contentType: 'application/pdf',
      content: rendered.value.bytes,
    },
    ...(run.options.attachments ?? []).map((a, i) => ({
      fileName: a.fileName,
      ...(a.contentType === undefined ? {} : { contentType: a.contentType }),
      content: a.content,
      fieldName: `file${i + 2}`,
    })),
  ]
  const sized = await evidenceFileSizes(files)
  if (!sized.ok) {
    return finish(run, {
      disposition,
      filed: false,
      alreadyFiled: false,
      awaitingApproval: false,
      awaitingHuman: false,
      actor,
      token,
      version,
      refusal: refusalFromError(sized.error),
      logLine: `EC-DSP-12 local refusal: ${sized.error.code}`,
    })
  }

  // **The permit is the last word on the body.** `narrowPlanToPermit` drops every planned item the permit does
  // not name, so a `REFUND_PROOF` permit cannot smuggle a contest's `DETAILS_OF_PURCHASE` out on the same
  // call, and a permit that names evidence the plan cannot produce is a refusal rather than a partial upload.
  const permitted = narrowPlanToPermit(plan, permit.evidenceTypes)
  if (!permitted.ok) {
    return finish(run, {
      disposition,
      filed: false,
      alreadyFiled: false,
      awaitingApproval: false,
      awaitingHuman: false,
      actor,
      token,
      version,
      refusal: {
        code: 'DEF_WRONG_STATE',
        reason: permitted.reason,
        manual: false,
        userMessage: 'There is no evidence to file for this decision.',
      },
      logLine: 'the permitted evidence is not in the plan; nothing to upload',
    })
  }

  const planned = toProvideEvidenceInput(permitted.value)
  if (planned === null) {
    return finish(run, {
      disposition,
      filed: false,
      alreadyFiled: false,
      awaitingApproval: false,
      awaitingHuman: false,
      actor,
      token,
      version,
      refusal: {
        code: 'DEF_WRONG_STATE',
        reason:
          `Rule ${decision.ruleId} chose ${decision.posture}, and the ${permit.kind} permit left no evidence to ` +
          'send, so nothing was sent.',
        manual: false,
        userMessage: 'There is no evidence to file for this decision.',
      },
      logLine: 'the permitted evidence plan is empty; nothing to upload',
    })
  }
  const body = withCheckedNotes(planned, noted.value.notes)

  // --- 8. persist, then upload ---------------------------------------------------------------------------
  const stored = await persistPacket(run, {
    packetId,
    version,
    bundle: bundle.value,
    bundleHash,
    noted: noted.value,
    bytes: rendered.value.bytes,
    sha256: rendered.value.sha256,
  })
  if (!stored.ok) return stored

  const method = UPLOAD_PERMIT_KINDS[permit.kind]
  const result =
    permit.kind === 'APPEAL'
      ? await deps.paypal.appeal(row.paypal_dispute_id, body, files, {
          requestId: permit.requestId,
        })
      : await deps.paypal.provideEvidence(row.paypal_dispute_id, body, files, {
          requestId: permit.requestId,
        })
  if (result.ok) run.paypalCalls.push(method)

  if (!result.ok) {
    return finish(run, {
      disposition,
      filed: false,
      alreadyFiled: false,
      awaitingApproval: false,
      awaitingHuman: false,
      actor,
      token,
      version,
      packet: packetReportOf(stored.value),
      refusal: refusalFromError(result.error),
      errors: [toPacketError(result.error)],
      logLine: `${method} refused: ${result.error.code}`,
    })
  }

  const marked = await deps.store.packets.markFiled(packetId, toJsonValue(result.value), run.at)
  if (!marked.ok) return marked
  const defense = await deps.store.disputes.setDefenseState(row.id, 'FILED', run.at)
  if (!defense.ok) return defense

  const refundIds = completedRefundIdsFor(run)
  return finish(run, {
    disposition,
    filed: true,
    alreadyFiled: false,
    awaitingApproval: false,
    awaitingHuman: false,
    actor,
    token,
    version,
    packet: packetReportOf(marked.value, {
      notes: noted.value.notes,
      noteSource: noted.value.source,
      citations: noted.value.verdict.citations,
      verdict: noted.value.verdict,
      evidenceTypes: body.evidences.map((e) => e.evidence_type),
      requestId: permit.requestId,
    }),
    ...(kind === 'REFUND_PROOF'
      ? {
          proofOfRefund: {
            refundIds,
            uploaded: true,
            note:
              `Filed PROOF_OF_REFUND with refund id(s) ${refundIds.join(', ')}. Rule ${decision.ruleId}; the ` +
              'money was returned before this chargeback arrived.',
          },
        }
      : {}),
    logLine: `${method} sent with ${permit.requestId}`,
  })
}

/** EC-DSP-1's `evidence_info.refund_ids`, from the context the router already read. */
function completedRefundIdsFor(run: Run): readonly string[] {
  return (run.ctx.refunds ?? [])
    .filter((r) => r.status === 'COMPLETED')
    .map((r) => r.paypalRefundId)
}

// ---------------------------------------------------------------------------
// 6. finish(): the one place a `dispute_actions` row is written
// ---------------------------------------------------------------------------

/**
 * Write the `dispute_actions` row and build the {@link FileOutcome}.
 *
 * **Every run goes through here**, which is what makes §18 question 24 true rather than aspirational: there is
 * no exit from `fileDispute` that does not produce a row (the single exception is `REVIEW`, documented above).
 *
 * ### The row's contents
 *
 * - `action` — from {@link POSTURE_DISPOSITION}, for `done.token`-bearing dispositions.
 * - `request` — the rule id, the posture, the liability, the rationale, the deadline band, the packet hash and
 *   the evidence types. **This is the "read why" half.**
 * - `response` — `paypal_call` (`sent` / `none`), the disposition, the refusal, the blocked lines, the refund
 *   id, and the names of every PayPal method called. **This is the "see it was recorded" half.**
 * - `idempotency_key` — §8.15's `cs:{disputeId}:file:{version}`, or the `:nofile` variant when nothing was
 *   sent, so a blocked attempt does not consume the key a successful retry needs.
 */
async function finish(run: Run, done: Done): Promise<Result<FileOutcome, CsError>> {
  const { row, decision, deps, at, paypalCalls, warnings } = run
  if (done.logLine !== undefined) {
    deps.logger?.info(`defender.file: ${done.logLine}`, {
      dispute_id: row.id,
      disposition: done.disposition,
      filed: done.filed,
      already_filed: done.alreadyFiled,
    })
  }

  const actionName = actionNameFor(done)
  let actionRow: FileOutcome['actionRow']

  if (actionName !== null && done.token !== undefined) {
    const baseKey =
      done.refund?.requestId ?? disputeActionRequestId(row.id, done.token, done.version ?? 1)
    const sent = done.filed || paypalCalls.length > 0
    const key = sent ? baseKey : `${baseKey}:nofile`
    const recorded = await deps.store.actions.record({
      id: derivedActionId(key),
      dispute_id: row.id,
      action: actionName,
      request: toJsonValue(requestBodyOf(done, decision, paypalCalls)),
      response: toJsonValue(responseBodyOf(done, decision, sent, paypalCalls)),
      actor: done.actor ?? 'DEFENDER',
      idempotency_key: key,
      at,
    } as NewDisputeAction)
    if (!recorded.ok) return recorded
    actionRow = {
      id: recorded.value.id,
      action: recorded.value.action,
      idempotencyKey: recorded.value.idempotency_key,
    }
  }

  return ok({
    disputeId: row.id,
    paypalDisputeId: row.paypal_dispute_id,
    decision,
    disposition: done.disposition,
    filed: done.filed,
    alreadyFiled: done.alreadyFiled,
    ...(done.packet === undefined ? {} : { packet: done.packet }),
    ...(done.refund === undefined ? {} : { refund: done.refund }),
    ...(done.proofOfRefund === undefined ? {} : { proofOfRefund: done.proofOfRefund }),
    ...(done.message === undefined ? {} : { message: done.message }),
    ...(done.proposal === undefined ? {} : { proposal: done.proposal }),
    ...(done.refusal === undefined ? {} : { refusal: done.refusal }),
    ...(done.blocked === undefined ? {} : { blocked: done.blocked }),
    awaitingApproval: done.awaitingApproval,
    awaitingHuman: done.awaitingHuman,
    ...(actionRow === undefined ? {} : { actionRow }),
    paypalCalls: [...paypalCalls],
    warnings: [...warnings],
  })
}

/** `dispute_actions.action` for a disposition, from {@link POSTURE_DISPOSITION}. */
function actionNameFor(done: Done): DisputeActionName | null {
  switch (done.disposition) {
    case 'NONE':
      return null
    case 'FILE':
      return 'FILE'
    case 'APPEAL':
      return 'APPEAL'
    case 'ACCEPT':
      return 'ACCEPT'
    case 'MESSAGE':
      return 'MESSAGE'
    case 'REFUND':
      return 'ACCEPT'
    case 'OFFER':
      return 'OFFER'
  }
}

/**
 * `dac_…` derived from the idempotency key.
 *
 * `dispute_actions.id` is the primary key and §7.2 says the key is "deterministic per (dispute, action,
 * attempt) so a retry does not double-file". Deriving the id from that same key makes a concurrent double
 * record hit the primary key rather than writing two timeline rows for one attempt.
 */
export function derivedActionId(idempotencyKey: string): DisputeActionId {
  const digest = createHash('sha256').update(idempotencyKey, 'utf8').digest('hex')
  return `dac_${digest.slice(0, 26)}` as DisputeActionId
}

function requestBodyOf(
  done: Done,
  decision: LiabilityDecision,
  paypalCalls: readonly string[],
): Record<string, unknown> {
  return {
    disposition: done.disposition,
    rule_id: decision.ruleId,
    posture: decision.posture,
    liability: decision.liability,
    rationale: decision.rationale,
    reasons: decision.reasons,
    deadline_band: decision.deadline.state,
    ...(decision.deadline.secondsLeft === null
      ? {}
      : { seconds_left: decision.deadline.secondsLeft }),
    ...(decision.supersedes === undefined ? {} : { supersedes: decision.supersedes }),
    ...(done.packet === undefined
      ? {}
      : {
          packet_id: done.packet.id,
          packet_version: done.packet.version,
          bundle_hash: done.packet.bundleHash,
          pdf_sha256: done.packet.pdfSha256,
          evidence_types: done.packet.evidenceTypes,
          note_source: done.packet.noteSource,
          citations: done.packet.citations.map((c) => ({
            claim_id: c.claimId,
            artefact: c.artefact.id,
            support: c.support,
          })),
        }),
    ...(done.refund === undefined
      ? {}
      : {
          paypal_call: paypalCalls[0] ?? 'none',
          refund_amount_minor: done.refund.amount.minor.toString(),
          refund_currency: done.refund.amount.currency,
        }),
    ...(done.proposal === undefined
      ? {}
      : {
          proposal_action: done.proposal.action,
          proposal_refund_minor: done.proposal.cost.refundMinor.toString(),
        }),
    ...(done.message === undefined ? {} : { message_chars: done.message.text.length }),
    ...(done.actor === undefined ? {} : { approved_by: done.actor }),
    paypal_calls: paypalCalls,
  }
}

function responseBodyOf(
  done: Done,
  decision: LiabilityDecision,
  sent: boolean,
  paypalCalls: readonly string[],
): Record<string, unknown> {
  return {
    disposition: done.disposition,
    filed: done.filed,
    already_filed: done.alreadyFiled,
    paypal_call: sent ? 'sent' : 'none',
    ...(done.alreadyFiled ? { idempotent_skip: true, ec: 'EC-DSP-10' } : {}),
    ...(done.refusal === undefined
      ? {}
      : {
          refusal_code: done.refusal.code,
          refusal: done.refusal.reason,
          ...(done.refusal.band === undefined ? {} : { band: done.refusal.band }),
          manual: done.refusal.manual,
        }),
    ...(done.blocked === undefined ? {} : { blocked: done.blocked }),
    ...(done.refund === undefined
      ? {}
      : { refund_id: done.refund.refundId, paypal_refund_id: done.refund.paypalRefundId }),
    ...(done.proofOfRefund === undefined
      ? {}
      : { refund_ids: done.proofOfRefund.refundIds, proof_uploaded: done.proofOfRefund.uploaded }),
    ...(done.message === undefined ? {} : { message_sent: done.message.sent }),
    ...(done.errors === undefined ? {} : { upstream_errors: done.errors.map((e) => e.code) }),
    rule_id: decision.ruleId,
    paypal_calls: paypalCalls,
  }
}

function toPacketError(error: CsError): PacketError {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    ...(error.details === undefined ? {} : { details: error.details }),
  }
}

// ---------------------------------------------------------------------------
// 7. Drafting, rendering, persisting
// ---------------------------------------------------------------------------

interface NotedDraft {
  readonly notes: string
  readonly source: DraftSource
  readonly citations: readonly Citation[]
  readonly verdict: CitationVerdict
  readonly draft: Draft
}

/**
 * Draft the note, or compose it — then **check the final text** and refuse a blocked one.
 *
 * Three paths, in order of preference:
 *
 * 1. `deps.llm` present and `draft()` succeeded → its text, **re-checked here**.
 * 2. No `llm`, or the model failed → **`templateNote`**, which `checkCitations` passes **by construction**.
 *    §18 question 35 / EC-LLM-1: a model outage must not stop a filing, and this is how.
 * 3. The check refused → **`DEF_CITATION_FAILED`**, EC-MER-5, and **nothing is filed**.
 *
 * `templateNote` is therefore not merely a fallback in this file: it is the reason **no test in this package
 * needs an OpenAI key**, and using it when no model is supplied is a feature rather than a degradation.
 */
async function draftNote(
  input: DraftInput,
  deps: FileDeps,
  allowedUrl: string,
  claims: readonly ClaimSource[],
): Promise<Result<NotedDraft, CsError>> {
  if (deps.llm !== undefined) {
    const drafted = await draft(input, {
      llm: deps.llm,
      clock: deps.clock,
      ...(deps.logger === undefined ? {} : { onLog: (line: string) => deps.logger?.info(line) }),
    })
    if (!drafted.ok) return drafted
    // EC-MER-5: "the citation checker runs on the **final** text at file time". `draft()` already checked, but
    // re-checking here is what makes the guarantee local to the filer rather than a property of a function two
    // files away — and it is where a merchant's hand edit would be caught.
    const verdict = checkCitations({ notes: drafted.value.notes }, claims, { allowedUrl })
    if (!verdict.ok) {
      return err(
        citationFailed(verdict, { ruleId: input.decision.ruleId, packetId: input.packetId }),
      )
    }
    return ok({
      notes: drafted.value.notes,
      source: drafted.value.source,
      citations: verdict.citations,
      verdict,
      draft: drafted.value,
    })
  }

  const template = templateNote(input, claims, allowedUrl)
  const verdict = checkCitations({ notes: template }, claims, { allowedUrl })
  if (!verdict.ok) {
    return err(citationFailed(verdict, { ruleId: input.decision.ruleId, packetId: input.packetId }))
  }
  return ok({
    notes: template,
    source: 'template',
    citations: verdict.citations,
    verdict,
    draft: {
      notes: template,
      citations: verdict.citations,
      source: 'template',
      verdict,
      modelCalls: 0,
    },
  })
}

/** §8.18's packet view, assembled from the run and the bundle. */
function packetViewFor(
  run: Run,
  input: {
    readonly packetId: PacketId
    readonly version: number
    readonly bundle: EvidenceBundle
    readonly noted: NotedDraft
  },
): PacketView {
  const a = run.deps.artefacts
  return {
    packetId: input.packetId,
    disputeId: run.row.id,
    paypalDisputeId: run.row.paypal_dispute_id,
    version: input.version,
    decision: run.decision,
    draft: input.noted.draft,
    facts: run.decision.facts,
    claims: claimSourcesFor(run.ctx, run.decision),
    bundle: input.bundle as unknown as Readonly<Record<string, unknown>>,
    readback: readbackFor(run.deps, run.ctx),
    chain: {
      ...(a?.l1 === undefined ? {} : { l1: a.l1 }),
      ...(a?.l2 === undefined ? {} : { l2: a.l2 }),
      ...(a?.l3a === undefined ? {} : { l3a: a.l3a }),
      ...(a?.l3b === undefined ? {} : { l3b: a.l3b }),
      ...(a?.checkoutJwt === undefined ? {} : { checkoutJwt: a.checkoutJwt }),
      ...(a?.gateDecision === undefined ? {} : { gateDecision: a.gateDecision }),
      ...(a?.deviceJkt === undefined ? {} : { deviceJkt: a.deviceJkt }),
      ...(a?.agentKid === undefined ? {} : { agentKid: a.agentKid }),
      ...(a?.viLibCommit === undefined ? {} : { viLibCommit: a.viLibCommit }),
    },
    publicBaseUrl: run.deps.publicBaseUrl,
    ...(a?.payerEmail === undefined ? {} : { payerEmail: a.payerEmail }),
    ...(a?.payerId === undefined ? {} : { payerId: a.payerId }),
    ...(a?.payerCountry === undefined ? {} : { payerCountry: a.payerCountry }),
    ...(a?.payerCity === undefined ? {} : { payerCity: a.payerCity }),
  }
}

/**
 * §8.18 / EC-MER-6: the read-back is a **required** field of the packet schema.
 *
 * It lives inside the signed mandate, so omitting it changes the mandate hash and the public verifier shows the
 * difference — which is the point: a merchant who hid the sentence their customer approved cannot produce a
 * packet that verifies. When we hold no read-back at all, a fixed sentence saying so is drawn instead of an
 * empty section, because a renderer that silently omits a mandated section is how EC-MER-6 happens.
 */
export function readbackFor(deps: FileDeps, ctx: DisputeContext): string {
  const supplied = deps.artefacts?.readback
  if (supplied !== undefined && supplied.trim().length > 0) return supplied
  const chain = ctx.chain
  return (
    'No signed read-back is recorded for this payment, so there is nothing to print here.\n' +
    `The router recorded mandatePresent=${String(chain?.mandatePresent)}, ` +
    `chain verified at capture=${String(chain?.verifyAtCaptureChainValid)}, ` +
    `passkey user-verification=${String(chain?.webauthnPresent)}.`
  )
}

/**
 * **EC-MER-5's entry point: check arbitrary text before it is filed.**
 *
 * Spec EC-MER-5 is *"Merchant edits the LLM notes to add unsupported claims"* -> *"The citation checker runs on
 * the **final** text at file time"* -> *"Uncited claims -> filing blocked; the merchant can only file with
 * checker-clean notes or template notes"*. So the gate is a **function of the text**, callable on anything:
 *
 * - `draftNote` calls it on whatever `draft()` produced, so a hostile model's text never reaches PayPal even
 *   though `draft()` substitutes the template after two failures;
 * - WP-17e's S-18 calls it on a merchant's hand-edited note **as they type**, so the UI can say "these two
 *   sentences lack a source" rather than discovering it at file time, which is the spec's own user-facing text;
 * - and `fileDispute` calls it one last time on the bytes it is about to send, which is what makes the guarantee
 *   local to the filer rather than a property of a function two files away.
 *
 * Exported rather than folded into `draftNote` because the two moments are different questions: "should this
 * exist" and "may these exact bytes go to PayPal".
 */
export function checkForFilingAtFileTime(
  notes: string,
  claims: readonly ClaimSource[],
  allowedUrl: string,
): CitationVerdict {
  return checkCitations({ notes }, claims, { allowedUrl })
}

/**
 * Every evidence item carries the **same** citation-checked note.
 *
 * ### Why, and it is not laziness
 *
 * EC-MER-5's guarantee is "the citation checker runs on the final text at file time", which is only worth
 * anything if **100% of the text PayPal receives has been through the checker**. PayPal's `evidence[].notes`
 * is per-item; the planner's per-type notes are composed rather than drafted and carry no `[[claim]]` markers,
 * so filing them would put unchecked prose in front of an adjudicator while the checked note sat in a
 * neighbouring field. One checked note on every item means **every word at PayPal passed the checker**, at
 * the cost of the same paragraph appearing under each evidence type in PayPal's own UI.
 *
 * The per-type detail is not lost: it is sections 3 and 4 of the packet PDF, and it is in
 * `evidence_packets.notes`. This is exported so a test can assert the property, and so a future
 * per-type-deterministic-note design has one function to change.
 */
export function withCheckedNotes(input: ProvideEvidenceInput, notes: string): ProvideEvidenceInput {
  return { ...input, evidences: input.evidences.map((e) => ({ ...e, notes })) }
}

/** The version a genuinely new packet takes: `max(version) + 1`. EC-DSP-4's "new packet version". */
export function nextPacketVersion(existing: readonly EvidencePacketRow[]): number {
  return existing.reduce((max, p) => (p.version > max ? p.version : max), 0) + 1
}

/**
 * Cut the plan down to what the permit names, and refuse if it names something the plan cannot supply.
 *
 * Two directions, and **both** matter:
 *
 * - **Extras are dropped.** `planEvidence` merges the router's `evidenceRequired` with
 *   `EVIDENCE_BY_REASON[reason]`, so an `UNAUTHORISED` contest plans four types. On a `REFUND_PROOF` permit the
 *   other three are a contest's worth of evidence attached to an accept-the-money decision — EC-DSP-1's exact
 *   failure mode, and §18 question 20's forbidden escalation, arriving through the evidence list rather than
 *   through the posture. Dropping them here is what makes the permit's one-element tuple a bound rather than an
 *   annotation.
 * - **A missing required type is a refusal.** If the permit names a type the plan does not contain, filing the
 *   remainder would file an incomplete case and record it as complete. `uploadPermitFor` already refuses to mint
 *   a `REFUND_PROOF` permit unless `PROOF_OF_REFUND` is required, and the planner always emits a required type,
 *   so this is a defence against a future planner change rather than a reachable path — which is the right way
 *   round for a check whose failure would be invisible.
 */
export function narrowPlanToPermit(
  plan: EvidencePlan,
  permitted: readonly string[],
):
  | { readonly ok: true; readonly value: EvidencePlan }
  | { readonly ok: false; readonly reason: string } {
  const missing = permitted.filter((t) => !plan.items.some((i) => i.evidenceType === t))
  if (missing.length > 0) {
    return {
      ok: false,
      reason:
        `The upload permit names evidence this case cannot produce (${missing.join(', ')}). ` +
        'Filing the remainder would file an incomplete packet and record it as complete, so nothing was sent.',
    }
  }
  const items = plan.items.filter((i) => permitted.includes(i.evidenceType))
  if (items.length === 0) {
    return {
      ok: false,
      reason: `The upload permit names no evidence the plan contains (${permitted.join(', ')}), so nothing was sent.`,
    }
  }
  const dropped = plan.items.length - items.length
  return {
    ok: true,
    value: {
      ...plan,
      items,
      warnings:
        dropped === 0
          ? plan.warnings
          : [
              ...plan.warnings,
              `${dropped} planned evidence item(s) were not named by the upload permit and were not filed.`,
            ],
    },
  }
}

/** Did this action row record a PayPal call that actually went out? EC-DSP-10's second layer. */
export function responseSentPaypalCall(response: unknown): boolean {
  return (
    response !== null &&
    typeof response === 'object' &&
    (response as Record<string, unknown>)['paypal_call'] === 'sent'
  )
}

/** A packet row as a {@link FiledPacket}, with whatever §7.2 stored. */
export function packetReportOf(
  row: EvidencePacketRow,
  extra?: Omit<FiledPacket, 'id' | 'version' | 'bundleHash' | 'pdfSha256' | 'byteLength'>,
): FiledPacket {
  return {
    id: row.id,
    version: row.version,
    bundleHash: row.bundle_hash,
    pdfSha256: row.pdf_sha256 ?? '',
    byteLength: row.pdf_bytes === null ? 0 : row.pdf_bytes.byteLength,
    ...(extra ?? {
      notes: row.notes ?? '',
      noteSource: 'template' as DraftSource,
      citations: [],
      verdict: { ok: true, problems: [], citations: [], citedClaimIds: [], unusedClaimIds: [] },
      evidenceTypes: [],
      requestId: '',
    }),
  }
}

async function persistPacket(
  run: Run,
  input: {
    readonly packetId: PacketId
    readonly version: number
    readonly bundle: EvidenceBundle
    readonly bundleHash: string
    readonly noted: NotedDraft
    readonly bytes: Uint8Array
    readonly sha256: string
  },
): Promise<Result<EvidencePacketRow, CsError>> {
  const { row, deps, at } = run
  const existing = await deps.store.packets.findById(input.packetId)
  if (!existing.ok) return existing
  if (existing.value !== undefined) return ok(existing.value)

  const inserted = await deps.store.packets.insert({
    id: input.packetId,
    dispute_id: row.id,
    version: input.version,
    bundle: toJsonValue(input.bundle),
    bundle_hash: input.bundleHash,
    pdf_bytes: Buffer.from(input.bytes),
    pdf_sha256: input.sha256,
    notes: input.noted.notes,
    citations: toJsonValue(input.noted.verdict.citations),
    citation_check: toJsonValue(input.noted.verdict),
    created_at: at,
    updated_at: at,
  })
  if (!inserted.ok) return inserted
  return ok(inserted.value)
}

/** `disputes.router_trace` — §8.15's "why the router decided what it did". */
export function routerTraceOf(decision: LiabilityDecision, ctx: DisputeContext): JsonValue {
  return toJsonValue({
    rule_id: decision.ruleId,
    posture: decision.posture,
    liability: decision.liability,
    rationale: decision.rationale,
    reasons: decision.reasons,
    facts: decision.facts,
    blocking_reason: decision.blockingReason ?? null,
    supersedes: decision.supersedes ?? null,
    evidence_required: decision.evidenceRequired,
    deadline: decision.deadline,
    user_alert: decision.userAlert ?? null,
    now_sec: ctx.nowSec,
  })
}

/** Re-exported so `strategist-actions.ts` needs one import for the row vocabulary. */
export type { DisputeActionRow, DefenderTx, Logger }
