/**
 * Dispute ingest and the row→context bridge — spec **§8.16 (M16)**, **§12.11**, **§7.2**, **§7.3**,
 * **§8.12**, work package **WP-15e**. Decisions **D-013**, **D-018**.
 *
 * ```ts
 * const result = await ingestDisputeToDefender(rawDispute, deps)
 * // result.value.context -> route(result.value.context)
 * ```
 *
 * ## What this file is responsible for, and what it is not
 *
 * | Question | Answered by | Where |
 * |---|---|---|
 * | which order is this dispute about? | {@link joinDisputeToOrder} | this file |
 * | what does the router need to see? | {@link buildDisputeContext} | this file |
 * | is it worth contesting? | `route()` | `router.ts` |
 * | do we file it? | `fileDispute` | `filer.ts` |
 *
 * **§8.12's staleness ranking is not re-implemented here.** `packages/webhooks`' `ingestDispute` owns
 * `(stage order, status, update_time)` and refuses to move a row backwards; this function calls the same
 * store primitive (`upsertDisputeFromFetch`), so that rule is applied once — inside `packages/db` — rather
 * than twice. What this file adds is the **join**, and the join is the part that was silently broken for most
 * of this project's life, which is why the next section is three paragraphs long.
 *
 * ## D-013: the join key is `disputed_transactions[0].seller_transaction_id`
 *
 * `seller_transaction_id` is **not** a top-level property of a PayPal dispute. It lives in an *array*
 * (`SPEC-D` `$ref transaction_info_list`), and reading it from the top level — which is what the first
 * version of this package did — can never succeed against a real response, so the "which capture is this
 * dispute about?" join returned `undefined` for every dispute and every case fell through to R-NOCHAIN-1.
 * A Defender that always answers "not a Countersign order" is worse than no Defender, because it looks like
 * a finding.
 *
 * {@link disputeCaptureId} from `@countersign/paypal` is the one reader, and it is the *only* one used here.
 * Three outcomes, and the second is the important one:
 *
 * | Outcome | Meaning | What happens |
 * |---|---|---|
 * | `LINKED` | PayPal's capture id is one of ours | `disputes.capture_id` / `order_id` written |
 * | `NOT_A_COUNTERSIGN_PAYMENT` | PayPal named a capture, we have no such row | stored unlinked, `PP_NOT_FOUND` reported as **data**, R-NOCHAIN-1 |
 * | `NO_CAPTURE_ON_DISPUTE` | PayPal named no capture at all | stored unlinked, `PP_NOT_FOUND`, R-NOCHAIN-1 |
 *
 * ### "never a crash", and what that does *not* mean
 *
 * EC-DSP-9 ("Dispute can't be mapped to an order") and §18 question 20 need the unmapped case to produce a
 * **sentence and a stored row**, not an exception. So a disagreement between PayPal's capture id and ours is
 * reported as a {@link JoinOutcome} carrying `code: 'PP_NOT_FOUND'` — the §8.1 registry's code for exactly
 * this — and the row is still written, because a chargeback no human can see is the worst outcome available.
 * It is a *value*, not an exception: the caller decides whether to surface it, and the router decides what
 * it means.
 *
 * Throwing `PP_NOT_FOUND` would also be a lie in the other direction. PayPal found the dispute perfectly
 * well; **we** found no capture. The code names whose lookup failed.
 *
 * ## EC-DSP-11: a withdrawn dispute is closed, not filed
 *
 * {@link buyerWithdrew} reads `dispute_outcome.outcome_code` and `status`. A dispute the buyer withdrew has
 * nothing to defend and nothing to refund, and — the reason this is a *guard* rather than a tidy-up —
 * filing against it spends one of the merchant's response attempts on a case PayPal has already closed. The
 * filer refuses on it, and the ingest sets `defense_state = CLOSED_WON`, which is what §12.11's handling
 * column says a cancelled case is.
 *
 * ## The two things this file cannot read for itself
 *
 * {@link DefenderStore} is a closed port, and two of its members exist because **no repository can produce
 * them**. Saying so here is the alternative to quietly inventing a value:
 *
 * - `evidence.corpus(orderId)` — `EvidenceCorpus` is *which documents exist*. There is no column and no
 *   repo function computes it. A caller that cannot answer must return `{}`, never
 *   `{fulfilmentDocument: true}`: the booleans mean "we can put a real document behind this claim", so
 *   `true` without a document is the direction that files a packet we cannot support.
 * - `evidence.bundle(orderId)` — §7.3's bundle spans five tables (`l1_credentials`, `mandates`,
 *   `checkout_attempts`, `checkout_sessions`, `gate_decisions`), so it has no single-row getter.
 *
 * Both are also where a judge's question 20 lands: *"what stops the AI from filing a bogus dispute?"* — the
 * router cannot contest without a verified chain **and** an evidence type whose source exists, and those
 * sources are these booleans.
 *
 * ## Nothing here calls a model
 *
 * `ingest.ts` sits on the same side of the line as `rules.ts` / `router.ts` / `rationale.ts`: it reads rows
 * and composes a {@link DisputeContext}. The model gets no vote on what a dispute is about, and there is no
 * `DefenderDeps` member through which it could be asked.
 */

import { createHash } from 'node:crypto'

import {
  csError,
  err,
  fromPayPalValue,
  ok,
  toCsError,
  type Clock,
  type CsError,
  type Currency,
  type DisputeActionId,
  type DisputeId,
  type Logger,
  type Money,
  type PacketId,
  type Result,
} from '@countersign/core'
import {
  canonicalJson,
  type AuditLogRow,
  type CaptureRow,
  type CheckoutAttemptRow,
  type CheckoutSessionRow,
  type DeviceRow,
  type DisputeActionRow,
  type DisputeDefenseState,
  type DisputeRow,
  type DisputeStage,
  type DisputeStatus,
  type EvidencePacketRow,
  type Exec,
  type GateDecisionRow,
  type JsonValue,
  type MandateRow,
  type NewDispute,
  type NewDisputeAction,
  type NewEvidencePacket,
  type OrderRow,
  type RefundRow,
  type ShipmentRow,
} from '@countersign/db'
import {
  DISPUTE_LIFE_CYCLE_STAGES,
  disputeCaptureId,
  isAppealable,
  type Dispute,
  type PayPalClient,
} from '@countersign/paypal'

import type {
  CaptureFacts,
  ChainFacts,
  DisputeContext,
  DisputeFacts,
  EvidenceCorpus,
  LineFact,
  MerchantPolicy,
  OrderFacts,
  RefundFacts,
  RouterPreferences,
  ShipmentFacts,
} from './types'

export type { DisputeDefenseState, DisputeStage, DisputeStatus }
export type { DisputeActionId, PacketId, DisputeId, Money, Currency, CsError, Result }

/** The transaction handle every store member takes. Opaque to everything outside `deps.ts`. */
export type DefenderTx = Exec

// ---------------------------------------------------------------------------
// §7.3's bundle
// ---------------------------------------------------------------------------

/**
 * §7.3's evidence bundle, in §7.3's order.
 *
 * `paypal` and `shipments` are the two members **excluded from `custom_id`** (they are added after order
 * creation), so the hashed core is required here and the rest is the case file's.
 */
export interface EvidenceBundle {
  readonly v: 'cs1'
  readonly l1?: string
  readonly l2: string
  readonly l3a: string
  readonly l3b: string
  readonly checkout_jwt: string
  readonly gate_decision: string
  readonly webauthn: { readonly present: boolean; readonly at?: number }
  readonly vi_lib_commit: string
  readonly paypal?: {
    readonly order_id: string
    readonly capture_ids: readonly string[]
    readonly custom_id: string
  }
  readonly shipments?: readonly {
    readonly carrier: string
    readonly tracking: string
    readonly lines: readonly LineFact[]
  }[]
}

/**
 * `evidence_packets.bundle_hash` — sha256 over the RFC 8785 JCS encoding of the bundle (§7.2, §7.3).
 *
 * **`canonicalJson` comes from `@countersign/db`**, which is where `packages/orders`' D18 `custom_id`
 * derivation gets it from too. Two implementations of JCS would be two values for the same document, and the
 * entire point of the hash is that a third party recomputes it.
 *
 * **The `custom_id` hash is deliberately not recomputed here.** `packages/orders` owns `customIdForBundle`,
 * this package cannot import it (it is not a dependency of `packages/defender`), and a second implementation
 * would be silent-drift risk in the one value that ties a packet to a PayPal transaction. See
 * {@link customIdAgreement} for what this file does instead.
 */
export function bundleHashFor(bundle: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(canonicalJson(bundle), 'utf8').digest('hex')
}

/**
 * D-018, as a **consistency check between two stored values** rather than a recomputation.
 *
 * `orders.custom_id` and the `paypal.custom_id` member of the bundle are written at order time from the same
 * computation. If they disagree, the bundle we are about to file is not the bundle the order was created
 * with — which is worth knowing *before* a 50 MB upload rather than after.
 *
 * @returns `null` when they agree, or when the bundle carries no `paypal` member at all.
 */
export function customIdAgreement(
  bundle: EvidenceBundle,
  orderCustomId: string,
): { readonly agreed: boolean; readonly message: string } | null {
  const inBundle = bundle.paypal?.custom_id
  if (inBundle === undefined) return null
  if (inBundle === orderCustomId) {
    return {
      agreed: true,
      message: `The bundle's custom_id matches orders.custom_id (${orderCustomId}).`,
    }
  }
  return {
    agreed: false,
    message:
      `The bundle's custom_id (${inBundle}) does not match orders.custom_id (${orderCustomId}), so this ` +
      'packet is not the bundle the order was created with. Nothing was filed.',
  }
}

// ---------------------------------------------------------------------------
// The store port
// ---------------------------------------------------------------------------

/**
 * Every row the Defender reads or writes.
 *
 * Narrow, and **every member names the `@countersign/db` repository that satisfies it in production**, so a
 * port member with no repository behind it is a `tsc` error at the adapter rather than a runtime surprise.
 *
 * Two structural properties are worth naming, because they are the EC-DSP-10 defence:
 *
 * - `actions.findByIdempotencyKey` reads the column `dispute_actions_idempotency_key_key` makes unique. The
 *   uniqueness check and the deterministic `PayPal-Request-Id` are the **same string**, so the local check
 *   and PayPal's own deduplication agree on what "already done" means.
 * - `packets.forDispute` returns **every** version, newest first, not just the latest. EC-DSP-10's
 *   idempotency check is "is there already a packet with *this* bundle hash", which the latest packet alone
 *   cannot answer.
 */
export interface DefenderStore {
  /**
   * Run `fn` as one unit.
   *
   * **A returned `err(...)` commits** — Postgres does not roll back because a function said "no". The one
   * place that must abandon writes throws a `CsError` and the adapter turns it into a rollback, exactly as
   * `packages/orders`' `withTxOrAbort` does.
   */
  transaction<T>(fn: (tx: DefenderTx) => Promise<T>): Promise<Result<T, CsError>>

  disputes: {
    findById(id: DisputeId, tx?: DefenderTx): Promise<Result<DisputeRow | undefined, CsError>>
    findByPaypalId(
      paypalDisputeId: string,
      tx?: DefenderTx,
    ): Promise<Result<DisputeRow | undefined, CsError>>
    /**
     * `repos/disputes.ts::upsertDisputeFromFetch` — §8.12's rank check lives **inside** it, so this file
     * does not re-implement "never move a row backwards".
     */
    upsertFromFetch(
      input: UpsertDisputeInput,
      tx?: DefenderTx,
    ): Promise<Result<DisputeRow, CsError>>
    insert(input: NewDispute, tx?: DefenderTx): Promise<Result<DisputeRow, CsError>>
    linkToOrder(
      id: DisputeId,
      link: { orderId: string | null; captureId: string | null },
      at: Date,
      tx?: DefenderTx,
    ): Promise<Result<DisputeRow, CsError>>
    /** `repos/disputes.ts::setLiability` — §8.15's verdict plus which rule fired and on what facts. */
    setLiability(
      id: DisputeId,
      liability: string,
      routerTrace: DisputeRow['router_trace'],
      at: Date,
      tx?: DefenderTx,
    ): Promise<Result<DisputeRow, CsError>>
    setDefenseState(
      id: DisputeId,
      state: DisputeDefenseState,
      at: Date,
      tx?: DefenderTx,
    ): Promise<Result<DisputeRow, CsError>>
  }

  orders: {
    findById(id: string, tx?: DefenderTx): Promise<Result<OrderRow | undefined, CsError>>
    findByCustomId(
      customId: string,
      tx?: DefenderTx,
    ): Promise<Result<OrderRow | undefined, CsError>>
    findByAttempt(
      attemptId: string,
      tx?: DefenderTx,
    ): Promise<Result<OrderRow | undefined, CsError>>
  }

  captures: {
    findById(id: string, tx?: DefenderTx): Promise<Result<CaptureRow | undefined, CsError>>
    /** `repos/orders.ts::findCaptureByPaypalId` — **the D-013 join**. */
    findByPaypalId(
      paypalCaptureId: string,
      tx?: DefenderTx,
    ): Promise<Result<CaptureRow | undefined, CsError>>
    /** `repos/orders.ts::findCapturesByOrder` — the siblings R-AMT-1 and R-AMT-2 compare. */
    findByOrder(orderId: string, tx?: DefenderTx): Promise<Result<CaptureRow[], CsError>>
  }

  refunds: {
    /** `repos/orders.ts::findRefundsByCapture` — EC-DSP-1's `Σ refunds ≥ disputed amount`. */
    findByCapture(captureId: string, tx?: DefenderTx): Promise<Result<RefundRow[], CsError>>
  }

  shipments: {
    findByOrder(orderId: string, tx?: DefenderTx): Promise<Result<ShipmentRow[], CsError>>
  }

  attempts: {
    findById(id: string, tx?: DefenderTx): Promise<Result<CheckoutAttemptRow | undefined, CsError>>
  }

  mandates: {
    findById(id: string, tx?: DefenderTx): Promise<Result<MandateRow | undefined, CsError>>
  }

  checkoutSessions: {
    findById(id: string, tx?: DefenderTx): Promise<Result<CheckoutSessionRow | undefined, CsError>>
  }

  gate: {
    /** `repos/gate.ts::findLatestDecisionForAttempt` — §8.10's signed record. */
    findForAttempt(
      attemptId: string,
      tx?: DefenderTx,
    ): Promise<Result<GateDecisionRow | undefined, CsError>>
  }

  devices: {
    findById(id: string, tx?: DefenderTx): Promise<Result<DeviceRow | undefined, CsError>>
  }

  audit: {
    /**
     * `repos/audit.ts::listBySubject`.
     *
     * **This is where `deviceLostAtSec` comes from.** `devices` has **no `lost_at` column** — a gap
     * `types.ts` documents and §18 question 8 needs — so the timeline of "when was this device reported
     * lost" is the audit trail or it is nothing. R-UNAUTH-2 depends on the *order* of that timestamp and
     * the mandate's `iat`, so an absent entry means the rule cannot fire, which is the safe direction.
     */
    listBySubject(subject: string, tx?: DefenderTx): Promise<Result<AuditLogRow[], CsError>>
  }

  evidence: {
    /**
     * Which documents exist for this order, as {@link EvidenceCorpus} booleans.
     *
     * **No repository computes this.** Return `{}` when the answer is unknown — see the file header.
     */
    corpus(orderId: string, tx?: DefenderTx): Promise<Result<EvidenceCorpus, CsError>>
    /** §8.8 / §12.10's merchant thresholds. Return `{}` when unknown; the defaults are conservative. */
    policy(merchantId: string, tx?: DefenderTx): Promise<Result<MerchantPolicy, CsError>>
    /** §7.3's bundle for this order, assembled from five tables. No single-row getter exists. */
    bundle(orderId: string, tx?: DefenderTx): Promise<Result<EvidenceBundle, CsError>>
    /** §7.3's `l1`, for the packet PDF's artefact inventory. */
    l1Credential(
      deviceId: string,
      walletId: string,
      tx?: DefenderTx,
    ): Promise<Result<{ readonly sdJwt: string } | undefined, CsError>>
  }

  packets: {
    findById(id: PacketId, tx?: DefenderTx): Promise<Result<EvidencePacketRow | undefined, CsError>>
    /** `repos/disputes.ts::findLatestPacketForDispute`. */
    latestForDispute(
      disputeId: DisputeId,
      tx?: DefenderTx,
    ): Promise<Result<EvidencePacketRow | undefined, CsError>>
    /** **Every** version, newest first. EC-DSP-10 needs the whole history, not the head. */
    forDispute(disputeId: DisputeId, tx?: DefenderTx): Promise<Result<EvidencePacketRow[], CsError>>
    insert(input: NewEvidencePacket, tx?: DefenderTx): Promise<Result<EvidencePacketRow, CsError>>
    attachPdf(
      id: PacketId,
      pdfBytes: Buffer,
      pdfSha256: string,
      at: Date,
      tx?: DefenderTx,
    ): Promise<Result<EvidencePacketRow, CsError>>
    /** `repos/disputes.ts::markPacketFiled`. */
    markFiled(
      id: PacketId,
      paypalResponse: EvidencePacketRow['paypal_response'],
      at: Date,
      tx?: DefenderTx,
    ): Promise<Result<EvidencePacketRow, CsError>>
  }

  actions: {
    /** `repos/disputes.ts::findDisputeActionByIdempotencyKey`. EC-DSP-10's local half. */
    findByIdempotencyKey(
      idempotencyKey: string,
      tx?: DefenderTx,
    ): Promise<Result<DisputeActionRow | undefined, CsError>>
    record(input: NewDisputeAction, tx?: DefenderTx): Promise<Result<DisputeActionRow, CsError>>
    /** `repos/disputes.ts::listDisputeActions` — the S-17 timeline, failures included. */
    listForDispute(
      disputeId: DisputeId,
      tx?: DefenderTx,
    ): Promise<Result<DisputeActionRow[], CsError>>
  }
}

/** The one `upsertDisputeFromFetch` argument, named so the port member reads as a sentence. */
export interface UpsertDisputeInput {
  readonly paypalDisputeId: string
  readonly id: DisputeId
  readonly stage: DisputeStage
  readonly status: DisputeStatus
  readonly reason: string
  readonly amount: Money
  readonly sellerResponseDueDate: Date | null
  readonly buyerResponseDueDate: Date | null
  readonly raw: DisputeRow['raw']
  readonly updatedAt: Date
}

// ---------------------------------------------------------------------------
// The PayPal port and the refund port
// ---------------------------------------------------------------------------

/**
 * The PayPal calls the Defender makes, as a `Pick` of the real client.
 *
 * **`Pick`, not a re-declaration**, for the reason `packages/orders` documents: the real `PayPalClient`
 * satisfies this structurally, so a test injects `fetchImpl` and drives the real request building, header
 * assembly, retry loop, backoff and zod validation. AGENTS.md rule 5 forbids faking PayPal's behaviour, and
 * this is the seam that makes that possible without a mock.
 *
 * `getDispute` is here for the appeal path: `PayPalClient.appeal` re-reads the dispute to gate on the
 * `appeal` HATEOAS link, and the filer needs the same read for `dispute_state` before choosing a posture.
 */
export type DefenderPayPal = Pick<
  PayPalClient,
  | 'provideEvidence'
  | 'appeal'
  | 'acceptClaim'
  | 'makeOffer'
  | 'sendMessage'
  | 'acknowledgeReturnItem'
  | 'provideSupportingInfo'
  | 'escalate'
  | 'getDispute'
>

/** What one refund actually did, as the filer needs it for `dispute_actions`. */
export interface RefundOutcome {
  /** Our `ref_…` row id, so the case file can link to it. */
  readonly refundId: string
  /** PayPal's own refund id — the string EC-DSP-1's `evidence_info.refund_ids` needs. */
  readonly paypalRefundId?: string
  readonly amount: Money
  readonly status?: 'PENDING' | 'COMPLETED'
  readonly paypalCall?: 'acceptClaim'
  readonly requestId?: string
}

/**
 * A refund, **including its `refunds` row and its `captures.refunded_minor` bump**.
 *
 * ### Why this is a port and not a `PayPalClient.refundCapture` call
 *
 * `fileDispute` acts on a `REFUND` posture, so it must move money — and moving money from this package
 * would be a genuine bug, not a style question:
 *
 * 1. `packages/orders` is **not** a dependency of `packages/defender`, and adding one is a `package.json`
 *    change this work package does not own.
 * 2. `orders.refund()` already owns the parts that make a refund correct: the over-refund guard
 *    (`captures_refunded_lte_amount`), the `refunds` row, `captures.refunded_minor`, and the asymmetric
 *    §8.11 ledger hooks. Duplicating any of it here would put two writers on one money column.
 * 3. **A refund with no row breaks the next router run.** `R-REF-1` reads `refundedTotal(ctx)`, which sums
 *    `refunds` rows. A refund made without a row leaves `refunded_minor` at zero, so a later
 *    chargeback-after-refund (EC-DSP-1) would fall through to R-INR-2 or R-UNAUTH-1 and file a packet
 *    arguing that money we already returned was never returned — the single most expensive bug this product
 *    could have.
 *
 * Wire this to `orders.defenderRefundsFromOrders(...)`: its `refundViaDispute` uses accept-claim
 * for the exact claim, with a durable reservation and live refund read-back. Direct `orders.refund`
 * remains blocked by EC-REF-4. PENDING has no invented PayPal refund id and must not close the case.
 * A wrong wiring here is a money bug rather than a crash, which is
 * why the contract says "the row too" in the type's own documentation, and why `fileDispute` records the
 * returned `paypalRefundId` in `dispute_actions` where a merchant can see it went missing.
 */
export interface DefenderRefunds {
  refund(input: {
    readonly captureId: string
    readonly amount: Money
    /** `refunds.reason_code`, and the line the merchant sees on the refund. */
    readonly reason: string
    /** `refunds.actor` / `initiated_by = MERCHANT`. */
    readonly actor: string
    readonly disputeId: string
    readonly paypalDisputeId: string
    /** Stable identity of the dispute, disputed minor units and ISO currency; never a job ULID. */
    readonly idempotencyKey: string
    readonly ruleId: string
  }): Promise<Result<RefundOutcome, CsError>>
}

/** The signed artefacts and buyer identifiers §8.18's packet prints an inventory of. */
export interface PacketArtefacts {
  readonly l1?: string
  readonly l2?: string
  readonly l3a?: string
  readonly l3b?: string
  readonly checkoutJwt?: string
  readonly gateDecision?: string
  readonly deviceJkt?: string
  readonly agentKid?: string
  readonly viLibCommit?: string
  readonly payerEmail?: string
  readonly payerId?: string
  readonly payerCountry?: string
  readonly payerCity?: string
  /** §8.18 / EC-MER-6: **required by the packet schema**. The renderer must not draw a packet without it. */
  readonly readback: string
}

/**
 * The Defender's entire world.
 *
 * Closed on purpose: "can the Defender reach a model?" is then a question about this interface, and the
 * answer is **no** — there is no language-model member. The two model-adjacent ports live on `FileDeps`
 * (`drafter`) and `StrategistDeps` (`llm`), and they are the only ones that can talk to one.
 */
export interface DefenderDeps {
  /** The only time source (AGENTS.md rule 10). */
  readonly clock: Clock
  readonly store: DefenderStore
  readonly paypal: DefenderPayPal
  /** Only reachable on a `REFUND` posture. See {@link DefenderRefunds} before wiring it. */
  readonly refunds: DefenderRefunds
  /** §6's `PUBLIC_BASE_URL`. The only host a note or a QR may name. */
  readonly publicBaseUrl: string
  /** Bundle artefacts the packet PDF inventories. Optional: the PDF names what it was given. */
  readonly artefacts?: PacketArtefacts
  /** Optional. Never for content — everything the Defender records is a composed value. */
  readonly logger?: Logger
}

/** Type-check a complete `DefenderDeps` and refuse to build one with a hole in it. */
export function defineDefenderDeps(deps: DefenderDeps): DefenderDeps {
  return deps
}

// ---------------------------------------------------------------------------
// EC-DSP-11: has the buyer withdrawn?
// ---------------------------------------------------------------------------

/** What {@link buyerWithdrew} found, and on what evidence. */
export interface WithdrawalVerdict {
  readonly withdrew: boolean
  /** The raw `dispute_outcome.outcome_code` that decided it, when one did. */
  readonly outcomeCode?: string
  /** PayPal's `status`, when we read one. */
  readonly status?: string
  /** One quotable line for the UI and for `dispute_actions`. */
  readonly reason: string
}

/**
 * PayPal's outcome codes that mean **the buyer took the claim back**.
 *
 * Both spellings are listed because PayPal has used both (`CANCELLED` and `CANCELED`), and a case filed
 * because we misspelled a code is the worst possible outcome for this predicate.
 *
 * **`RESOLVED_BUYER_FAVOUR` is deliberately absent.** That is a *loss*, not a withdrawal: the buyer kept
 * the money and the case continued, which is EC-DSP-6's appeal path rather than EC-DSP-11's clean close.
 * Conflating the two would close appealable cases and silently drop revenue.
 */
const WITHDRAWAL_OUTCOME_CODES: ReadonlySet<string> = new Set([
  'CANCELED_BY_BUYER',
  'CANCELLED_BY_BUYER',
  'CANCELED',
  'CANCELLED',
])

/** `status` values that mean PayPal closed the case as a cancellation. */
const CLOSED_STATUSES: ReadonlySet<string> = new Set(['CANCELED', 'CANCELLED'])

/**
 * EC-DSP-11: **has the buyer withdrawn this dispute?**
 *
 * Reads the mirrored `raw` jsonb, so it works on a row that has never been re-fetched. Takes `unknown`
 * rather than `Dispute` because `raw` is a jsonb mirror, not a validated response.
 *
 * Two signals, in order of how much they prove:
 *
 * 1. `dispute_outcome.outcome_code` in {@link WITHDRAWAL_OUTCOME_CODES} — PayPal saying so outright.
 * 2. `status` in {@link CLOSED_STATUSES} — the case is closed as a cancellation.
 *
 * `adjudication_outcome` is **not** consulted. A lost chargeback is not a withdrawal, and treating one as
 * the other would close exactly the cases EC-DSP-6 wants appealed.
 *
 * Returns `withdrew: false` for an unrecognisable `raw` rather than throwing: a mirror we cannot read is a
 * mirror we have no opinion about, and the filer's other guards are what stand between that and a filing.
 */
export function buyerWithdrew(raw: unknown): WithdrawalVerdict {
  const body = asRecord(raw)
  const status = asString(body['status'])
  const outcome = asRecord(body['dispute_outcome'])
  const outcomeCode = asString(outcome['outcome_code']) ?? asString(body['outcome_code'])
  const base = {
    ...(outcomeCode === undefined ? {} : { outcomeCode }),
    ...(status === undefined ? {} : { status }),
  }

  if (outcomeCode !== undefined && WITHDRAWAL_OUTCOME_CODES.has(outcomeCode)) {
    return {
      ...base,
      withdrew: true,
      reason: `The buyer withdrew this dispute; PayPal recorded outcome_code=${outcomeCode}.`,
    }
  }
  if (status !== undefined && CLOSED_STATUSES.has(status)) {
    return {
      ...base,
      withdrew: true,
      reason: `PayPal closed this dispute with status=${status}, which is a cancellation rather than a decision.`,
    }
  }
  return {
    ...base,
    withdrew: false,
    reason:
      outcomeCode === undefined
        ? `PayPal has not recorded an outcome code, and status=${status ?? 'unknown'} is not a cancellation.`
        : `PayPal recorded outcome_code=${outcomeCode}, which is a decision rather than a withdrawal.`,
  }
}

// ---------------------------------------------------------------------------
// D-013: the join
// ---------------------------------------------------------------------------

/**
 * How a PayPal dispute maps onto our rows. **Three answers, and the second is the important one.**
 *
 * `PP_NOT_FOUND` appears as a **value** on the two failure branches rather than being thrown, because
 * EC-DSP-9 needs a stored row and a sentence out of the unmapped case.
 */
export type JoinOutcome =
  | {
      readonly kind: 'LINKED'
      readonly orderId: string
      readonly captureId: string
      readonly paypalCaptureId: string
    }
  | {
      readonly kind: 'NOT_A_COUNTERSIGN_PAYMENT'
      readonly code: 'PP_NOT_FOUND'
      /** PayPal's own capture id — the string a merchant can search PayPal's dashboard for. */
      readonly paypalCaptureId: string
      readonly reason: string
    }
  | {
      readonly kind: 'NO_CAPTURE_ON_DISPUTE'
      readonly code: 'PP_NOT_FOUND'
      readonly reason: string
    }

/**
 * D-013, in one function: {@link disputeCaptureId} → `captures.paypal_capture_id` → `captures.order_id`.
 *
 * **Never throws.** Every failure is a {@link JoinOutcome} branch, so the caller writes the row either way.
 */
export async function joinDisputeToOrder(
  raw: Dispute,
  deps: Pick<DefenderDeps, 'store' | 'clock'>,
): Promise<Result<JoinOutcome, CsError>> {
  const paypalCaptureId = disputeCaptureId(raw)
  if (paypalCaptureId === undefined) {
    return ok({
      kind: 'NO_CAPTURE_ON_DISPUTE',
      code: 'PP_NOT_FOUND',
      reason:
        'PayPal sent no disputed_transactions[].seller_transaction_id on this dispute, so there is no ' +
        'transaction to join on. R-NOCHAIN-1 will decide it and the merchant is told this is not a ' +
        'Countersign order.',
    })
  }

  const capture = await deps.store.captures.findByPaypalId(paypalCaptureId)
  if (!capture.ok) return capture
  const row = capture.value
  if (row === undefined) {
    return ok({
      kind: 'NOT_A_COUNTERSIGN_PAYMENT',
      code: 'PP_NOT_FOUND',
      paypalCaptureId,
      reason:
        `PayPal raised this dispute against capture ${paypalCaptureId}, which is not one of our captures. ` +
        'The payment did not come through Countersign, so there is no mandate, no signed chain and ' +
        'nothing this package could file. R-NOCHAIN-1 will decide it.',
    })
  }
  return ok({
    kind: 'LINKED',
    orderId: row.order_id,
    captureId: row.id,
    paypalCaptureId,
  })
}

// ---------------------------------------------------------------------------
// PayPal → our enums
// ---------------------------------------------------------------------------

/**
 * PayPal's `dispute_life_cycle_stage` → `disputes.stage`, **fail closed**.
 *
 * ```ts
 * disputeStageFor('CHARGEBACK')     // ok('CHARGEBACK')
 * disputeStageFor(undefined)        // ok('INQUIRY')
 * disputeStageFor('SOMETHING_NEW')  // err(CS_VALIDATION)
 * ```
 *
 * ### Why this refuses rather than guessing
 *
 * `dispute_stage` has **four** values and no catch-all, so a stage PayPal adds next year cannot be stored
 * honestly. Both other answers are worse than refusing:
 *
 * - `?? 'INQUIRY'` treats a chargeback as an inquiry, which sends `R-STAGE-INQUIRY` and no filing.
 * - casting the string (`as DisputeStage`) is what `packages/webhooks/src/jobs.ts` line 699 does, and it
 *   produces a Postgres `22P02` **inside** the store call, after the row was already open. Reported in
 *   `README-FILER.md`; not fixed here, because `packages/webhooks` is another work package's file
 *   (AGENTS.md rule 8).
 *
 * `undefined` maps to `INQUIRY` because an absent stage on a freshly created dispute genuinely *is* the
 * first stage. That is a fact, not a guess, which is why it is the one case where a default is honest.
 */
export function disputeStageFor(paypalStage: string | undefined): Result<DisputeStage, CsError> {
  if (paypalStage === undefined) return ok('INQUIRY')
  if ((DISPUTE_LIFE_CYCLE_STAGES as readonly string[]).includes(paypalStage)) {
    return ok(paypalStage as DisputeStage)
  }
  return err(
    csError(
      'CS_VALIDATION',
      `PayPal sent dispute_life_cycle_stage="${paypalStage}", which is not one of ` +
        `${DISPUTE_LIFE_CYCLE_STAGES.join(', ')}. Nothing was written: a stage we cannot rank is a stage ` +
        'we must not store, and guessing one would either hide a chargeback as an inquiry or fail inside ' +
        'the database with an enum error.',
      { paypal_stage: paypalStage, known: [...DISPUTE_LIFE_CYCLE_STAGES] },
      {
        userMessage:
          'PayPal reported a dispute stage we do not recognise yet. A person will look at it.',
      },
    ),
  )
}

/**
 * PayPal's `status` → `disputes.status`.
 *
 * **Everything we do not recognise becomes `OTHER`, and `OTHER` is terminal.** That fold is the one
 * `packages/orders` already depends on: its `TERMINAL_DISPUTE_STATUSES` treats `RESOLVED` **and** `OTHER` as
 * closed, because EC-REF-4's "an open dispute" must not treat PayPal's `CANCELED`, `ACCEPTED`, `REFUNDED`
 * or `PENDING` as open. Our enum has `OTHER` precisely for that, and PayPal has nine statuses to our six, so
 * the mapping is lossy by design — with the lossy end being the closed end.
 */
export function disputeStatusFor(paypalStatus: string | undefined): DisputeStatus {
  switch (paypalStatus) {
    case 'OPEN':
    case 'WAITING_FOR_BUYER_RESPONSE':
    case 'WAITING_FOR_SELLER_RESPONSE':
    case 'UNDER_REVIEW':
    case 'RESOLVED':
      return paypalStatus
    default:
      return 'OTHER'
  }
}

/**
 * RFC 3339 → `Date`, or `null`.
 *
 * `seller_response_due_date` is the clock EC-DSP-7 and EC-DSP-8 are about, so an **unparseable** value
 * becomes `null` rather than "epoch zero" or `new Date()`. `null` makes `deadlineState` return `UNKNOWN`,
 * which the filer then refuses on with `DEF_DEADLINE_PASSED` and a quotable reason. An invented instant
 * would be worse than an absent one, because an absent one produces a human.
 */
export function rfc3339ToDate(value: unknown): Date | null {
  const text = asString(value)
  if (text === undefined) return null
  const parsed = new Date(text)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/** `timestamptz` → UTC epoch seconds, the unit every `DisputeContext` deadline uses (§0 rule 10). */
export function toEpochSeconds(value: Date | null): number | null {
  return value === null ? null : Math.trunc(value.getTime() / 1000)
}

// ---------------------------------------------------------------------------
// buildDisputeContext
// ---------------------------------------------------------------------------

/** Everything the chain readers found, including the rows the filer needs for the packet. */
interface ChainResolution {
  readonly facts: ChainFacts
  readonly mandate: MandateRow | undefined
  readonly gateDecision: GateDecisionRow | undefined
  readonly device: DeviceRow | undefined
  readonly attempt: CheckoutAttemptRow | undefined
}

/**
 * Assemble the {@link DisputeContext} the router takes, from our rows.
 *
 * **Read-only, and it makes no HTTP request.** The `raw` dispute it is given is the mirror and every other
 * fact is a row. That matters because `route()` is pure and re-running it is supposed to be free — a
 * context that reached the network would make "the same context, the same decision" false, and the 40-case
 * eval would be measuring the network.
 *
 * | Read | Rules that consume it |
 * |---|---|
 * | `orders.custom_id`, `orders.amount_minor` | R-NOCHAIN-1, R-AMT-1, R-AMT-2 |
 * | `captures.refunded_minor` + `refunds[]` | R-REF-1, R-CNP-1, EC-DSP-1, EC-DSP-2 |
 * | `captures` siblings, by order | R-AMT-1's Σ, R-AMT-2's duplicate-per-shipment (EC-MER-2) |
 * | `shipments` by order, with lines | R-INR-1/2/3, R-SNAD-*, EC-MER-4 |
 * | `mandates` + `devices` + `gate_decisions` + `audit` | R-CHAIN-BAD, R-NOCHAIN-1, R-UNAUTH-1/2/3, EC-BUY-3 |
 * | `checkout_sessions.cart` | `checkoutLines` — the signed lines R-SNAD-MERCH compares |
 * | `evidence.corpus` / `evidence.policy` | R-NO-EVIDENCE, R-SNAD-THIN/OK, R-NOCHAIN-1, R-UNAUTH-3 |
 *
 * ### The chain, and what "verified" means here
 *
 * `verifyAtCaptureChainValid` comes from `gate_decisions.chain_valid` — the verdict recorded when the money
 * moved. **`verifyNowChainValid` is deliberately not set here.** "Verify now" is an HTTP call to `apps/vi`
 * (§8.18), it needs the raw tokens, and a context builder that silently performed a verification would make
 * `route()`'s purity a lie. A caller that has run it sets the field before calling `route()`; D-009's whole
 * point is that the two verdicts can legitimately differ, and only the caller knows which one it holds.
 *
 * ### `deviceLostAtSec`, from the audit trail
 *
 * `devices` has no `lost_at` column — a documented gap §18 question 8 needs. So the instant comes from
 * `audit.listBySubject(deviceId)`. **Absent means `undefined`**, and R-UNAUTH-2 then cannot fire, which is
 * the safe direction: it means "we cannot show the device was lost before signing", not "it was not".
 */
export async function buildDisputeContext(
  row: DisputeRow,
  raw: Dispute | undefined,
  deps: DefenderDeps,
  tx?: DefenderTx,
): Promise<Result<DisputeContext, CsError>> {
  const nowSec = deps.clock.nowSec()
  const paypal: Dispute = raw ?? (asRecord(row.raw) as Dispute)

  // --- the join, as the router sees it -------------------------------------------------------------
  const join = await joinDisputeToOrder(paypal, deps)
  if (!join.ok) return join
  const orderId = join.value.kind === 'LINKED' ? join.value.orderId : (row.order_id ?? undefined)
  const captureId =
    join.value.kind === 'LINKED' ? join.value.captureId : (row.capture_id ?? undefined)

  const order =
    orderId === undefined ? ok(undefined) : await deps.store.orders.findById(orderId, tx)
  if (!order.ok) return order
  const orderRow = order.value

  const allCaptures =
    orderRow === undefined ? ok([]) : await deps.store.captures.findByOrder(orderRow.id, tx)
  if (!allCaptures.ok) return allCaptures

  const capture =
    captureId === undefined ? ok(undefined) : await deps.store.captures.findById(captureId, tx)
  if (!capture.ok) return capture
  const captureRow = capture.value

  const refunds =
    captureRow === undefined ? ok([]) : await deps.store.refunds.findByCapture(captureRow.id, tx)
  if (!refunds.ok) return refunds

  const shipments =
    orderRow === undefined ? ok([]) : await deps.store.shipments.findByOrder(orderRow.id, tx)
  if (!shipments.ok) return shipments

  const session = await loadCheckoutSession(deps, orderRow, tx)
  if (!session.ok) return session
  const sessionRow = session.value

  const chain = await buildChain(deps, orderRow, tx)
  if (!chain.ok) return chain

  const corpus =
    orderRow === undefined
      ? ok<EvidenceCorpus>({})
      : await deps.store.evidence.corpus(orderRow.id, tx)
  if (!corpus.ok) return corpus

  const policy =
    sessionRow === undefined
      ? ok<MerchantPolicy>({})
      : await deps.store.evidence.policy(sessionRow.merchant_id, tx)
  if (!policy.ok) return policy

  const disputeFacts: DisputeFacts = {
    id: row.id,
    paypalDisputeId: row.paypal_dispute_id,
    reason: row.reason,
    stage: row.stage,
    status: row.status,
    amount: { minor: row.amount_minor, currency: row.currency },
    defenseState: row.defense_state,
    ...(captureId === undefined ? {} : { captureId }),
    ...(orderId === undefined ? {} : { orderId }),
    sellerResponseDueSec: toEpochSeconds(row.seller_response_due_date),
    // `isAppealable` reads the HATEOAS link, not `dispute_state` (report §9/#17). EC-DSP-6 and R-APPEAL-1
    // both key on this, so a state-only gate here would offer appeals PayPal refuses and miss ones it
    // allows — and the misses are the expensive direction.
    appealLinkPresent: isAppealable(paypal),
    previouslyLost: previouslyLost(paypal, row),
    newEvidenceSinceLoss: newEvidenceSinceLoss(paypal, row),
  }

  const checkoutLines = checkoutLinesOf(sessionRow)
  const disputedItem = disputedItemOf(paypal)
  const preferences = preferencesFrom(chain.value.mandate?.constraints)

  const ctx: DisputeContext = {
    nowSec,
    dispute: disputeFacts,
    ...(captureRow === undefined ? {} : { capture: captureFactsOf(captureRow) }),
    ...(orderRow === undefined ? {} : { order: orderFactsOf(orderRow) }),
    refunds: refunds.value.map(refundFactsOf),
    shipments: shipments.value.map(shipmentFactsOf),
    siblingCaptures: allCaptures.value.filter((c) => c.id !== captureRow?.id).map(captureFactsOf),
    chain: chain.value.facts,
    ...(checkoutLines.length === 0 ? {} : { checkoutLines }),
    ...(disputedItem === undefined ? {} : { disputedItem }),
    ...(preferences === undefined ? {} : { preferences }),
    corpus: corpus.value,
    policy: policy.value,
  }

  return ok(ctx)
}

// ---------------------------------------------------------------------------
// The individual readers
// ---------------------------------------------------------------------------

/**
 * The merchant-signed checkout lines, from `checkout_sessions.cart` = `{lines: [{sku, qty, unit_minor}]}`.
 *
 * §7.2's column is the **only** place the signed line set exists outside the JWT payload, and R-SNAD-MERCH's
 * whole condition is "shipment lines ≠ checkout lines" — so this must be the signed set and nothing
 * re-derived from the catalogue.
 *
 * `undefined` when there is no session, and `shipmentLinesMatchCheckout` then returns `false`. That is the
 * direction that makes R-SNAD-MERCH **refund** rather than contest, which is §18 question 20's bias again
 * and is intended: "we cannot prove the shipment matched" must never read as "we proved it did not match, so
 * we can fight it".
 */
function checkoutLinesOf(session: CheckoutSessionRow | undefined): readonly LineFact[] {
  const cart = asRecord(session?.cart)
  const lines = Array.isArray(cart['lines']) ? cart['lines'] : []
  const out: LineFact[] = []
  for (const entry of lines) {
    const line = asRecord(entry)
    const sku = asString(line['sku'])
    const qty = asInteger(line['qty'])
    if (sku === undefined || qty === undefined || qty <= 0) continue
    out.push({ sku, qty })
  }
  return out
}

async function loadCheckoutSession(
  deps: DefenderDeps,
  order: OrderRow | undefined,
  tx: DefenderTx | undefined,
): Promise<Result<CheckoutSessionRow | undefined, CsError>> {
  if (order === undefined) return ok(undefined)
  const attempt = await deps.store.attempts.findById(order.attempt_id, tx)
  if (!attempt.ok) return attempt
  const sessionId = attempt.value?.checkout_session_id
  if (sessionId === undefined || sessionId === null) return ok(undefined)
  return deps.store.checkoutSessions.findById(String(sessionId), tx)
}

/**
 * `mandates` + `devices` + `gate_decisions` + the audit trail, merged into {@link ChainFacts}.
 *
 * The one rule worth stating: **a fact we could not read is absent, never false.** `webauthnPresent:
 * undefined` makes R-UNAUTH-1 not fire (it tests `=== true`) *and* R-UNAUTH-3 fire (it tests `!== true`),
 * and R-UNAUTH-3's outcome is `REVIEW` or `ACCEPT_CLAIM` — never a contest. That asymmetry is deliberate in
 * `rules.ts`: an assertion we cannot read is a case we cannot argue, and it is why this reader returns
 * `undefined` rather than `false` for a row it could not load.
 */
async function buildChain(
  deps: DefenderDeps,
  order: OrderRow | undefined,
  tx: DefenderTx | undefined,
): Promise<Result<ChainResolution, CsError>> {
  const attempt =
    order === undefined ? ok(undefined) : await deps.store.attempts.findById(order.attempt_id, tx)
  if (!attempt.ok) return attempt
  const attemptRow = attempt.value

  const mandate =
    attemptRow === undefined
      ? ok(undefined)
      : await deps.store.mandates.findById(String(attemptRow.mandate_id), tx)
  if (!mandate.ok) return mandate
  const mandateRow = mandate.value

  const gate =
    order === undefined ? ok(undefined) : await deps.store.gate.findForAttempt(order.attempt_id, tx)
  if (!gate.ok) return gate
  const gateRow = gate.value

  const device =
    mandateRow === undefined
      ? ok(undefined)
      : await deps.store.devices.findById(String(mandateRow.device_id), tx)
  if (!device.ok) return device
  const deviceRow = device.value

  const lostAt =
    deviceRow === undefined ? ok(undefined) : await deviceLostAtSec(deps, deviceRow, tx)
  if (!lostAt.ok) return lostAt

  const facts: ChainFacts = {
    ...(mandateRow === undefined ? {} : { mandatePresent: true, readback: mandateRow.readback }),
    ...(mandateRow === undefined ? {} : { nlIntent: mandateRow.nl_intent }),
    ...(mandateRow === undefined ? {} : { iatSec: epochSecondsOf(mandateRow.iat) }),
    ...(mandateRow === undefined ? {} : { mandateStatus: mandateRow.status }),
    // `webauthn_assertion` is `jsonb, nullable` (§7.2): present means an assertion was recorded.
    ...(mandateRow === undefined
      ? {}
      : { webauthnPresent: mandateRow.webauthn_assertion !== null }),
    ...(gateRow === undefined ? {} : { verifyAtCaptureChainValid: gateRow.chain_valid }),
    ...(gateRow === undefined ? {} : { gateDecision: gateRow.decision }),
    ...(deviceRow === undefined ? {} : { deviceStatus: deviceRow.status }),
    ...(lostAt.value === undefined ? {} : { deviceLostAtSec: lostAt.value }),
  }

  return ok({
    facts,
    mandate: mandateRow,
    gateDecision: gateRow,
    device: deviceRow,
    attempt: attemptRow,
  })
}

/**
 * When was this device reported lost? **`devices` has no `lost_at` column**, so it is the audit trail.
 *
 * Takes the **earliest** matching timestamp, not the latest: R-UNAUTH-2 compares it against the mandate's
 * `iat`, and "the device was lost at some point afterwards" is a different claim from "the device was lost
 * before the mandate was signed".
 *
 * The action match is loose (`/lost/i` against `audit_log.action`) because `repos/devices.ts::markDeviceLost`
 * and the audit entries describing it are written by different work packages and this one cannot see the
 * other's vocabulary. A missed match yields `undefined`, which disables R-UNAUTH-2 — the safe direction, and
 * the reason `ChainFacts` documents the value as audit-derived.
 */
async function deviceLostAtSec(
  deps: DefenderDeps,
  device: DeviceRow,
  tx: DefenderTx | undefined,
): Promise<Result<number | undefined, CsError>> {
  const entries = await deps.store.audit.listBySubject(device.id, tx)
  if (!entries.ok) return entries
  let earliest: number | undefined
  for (const entry of entries.value) {
    const action = asString(entry.action)
    if (action === undefined || !/lost/i.test(action)) continue
    const at = dateToEpochSeconds(entry.at)
    if (at === undefined) continue
    if (earliest === undefined || at < earliest) earliest = at
  }
  return ok(earliest)
}

/**
 * §8.8's `preferences`, read defensively out of `mandates.constraints`.
 *
 * `preferences` is **not a VI constraint and is not signed** — §8.8's own read-back says so, and that is
 * exactly why R-SNAD-AGENT needs a *second* witness before it blames our own agent. It lives inside the
 * `constraints` jsonb because that is the column §7.2 has.
 *
 * **A malformed or absent block yields `undefined`**, which disables R-SNAD-AGENT. That is the correct
 * direction and not an accident: `rules.ts` says blaming our own agent on a guess would be the dishonest
 * outcome, and an unsigned hint we cannot read *is* a guess.
 */
export function preferencesFrom(constraints: unknown): RouterPreferences | undefined {
  const prefs = asRecord(asRecord(constraints)['preferences'])
  const out: Record<string, string> = {}
  for (const key of ['size', 'color', 'model', 'notes'] as const) {
    const value = asString(prefs[key])
    if (value !== undefined && value.length > 0) out[key] = value
  }
  if (Object.keys(out).length === 0) return undefined
  return out as unknown as RouterPreferences
}

/**
 * The item the buyer says is wrong, as `DisputedItem`.
 *
 * `SPEC-D`'s `dispute.items[]` carries `item_id` and `item_type`, and `item_id` is what a merchant's own
 * catalogue puts there. **Attributes are deliberately left `{}`.** PayPal does not send them and we hold no
 * signed record of what the buyer physically received, so any attribute here would be invented — and R-SNAD-AGENT's entire argument is a comparison between what arrived and what was signed. With `attributes: {}`, `attributeConflicts` returns `[]`, R-SNAD-AGENT cannot fire, and the case falls to R-SNAD-OK or R-SNAD-THIN, which is where an "it wasn't as described" claim honestly belongs when we cannot show what it was.
 */
function disputedItemOf(
  paypal: Dispute,
): { sku: string; attributes: Record<string, never> } | undefined {
  const items = Array.isArray(paypal.items) ? paypal.items : []
  for (const entry of items) {
    const sku = asString(asRecord(entry)['item_id'])
    if (sku !== undefined && sku.length > 0) return { sku, attributes: {} }
  }
  return undefined
}

/** EC-DSP-6: we filed, PayPal ruled against us, and the case is past its first decision. */
function previouslyLost(paypal: Dispute, row: DisputeRow): boolean {
  if (row.defense_state === 'CLOSED_LOST') return true
  const outcome = asString(paypal.adjudication_outcome)
  if (outcome !== undefined && /BUYER|AGAINST|FAVOR|FAVOUR/i.test(outcome)) return true
  return asString(paypal.dispute_state) === 'APPEALABLE'
}

/**
 * EC-DSP-6's "new evidence since the loss" — **strictly, something material**.
 *
 * Two things count: a `messages[]` entry posted by somebody other than us (the carrier answered, or the
 * buyer did), and an `evidences[]` entry dated **after** the decision. Our own evidence entry is the packet
 * that already lost, and re-appealing with it is EC-DSP-5's "re-file contradictory notes".
 *
 * The decision's own timestamp is unavailable on the `Dispute` type — PayPal documents no
 * `adjudication_time` — so `disputes.updated_at` stands in. It is the last moment we re-fetched, which is
 * an *upper* bound on the decision, and an upper bound makes this test stricter rather than looser.
 */
function newEvidenceSinceLoss(paypal: Dispute, row: DisputeRow): boolean {
  const messages = Array.isArray(paypal.messages) ? paypal.messages : []
  if (messages.some((m) => asString(asRecord(m)['posted_by']) !== 'SELLER')) return true
  const decidedAt = dateToEpochSeconds(row.updated_at)
  if (decidedAt === undefined) return false
  for (const entry of Array.isArray(paypal.evidences) ? paypal.evidences : []) {
    const at = rfc3339ToDate(asRecord(entry)['date'])
    if (at === null) continue
    if (Math.trunc(at.getTime() / 1000) > decidedAt) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Row → facts
// ---------------------------------------------------------------------------

function captureFactsOf(c: CaptureRow): CaptureFacts {
  return {
    id: c.id,
    paypalCaptureId: c.paypal_capture_id,
    amount: { minor: c.amount_minor, currency: c.currency },
    refundedMinor: c.refunded_minor,
    ...(c.shipment_id === null ? {} : { shipmentId: c.shipment_id }),
    status: c.status,
  }
}

function orderFactsOf(o: OrderRow): OrderFacts {
  return {
    id: o.id,
    customId: o.custom_id,
    invoiceId: o.invoice_id,
    amount: { minor: o.amount_minor, currency: o.currency },
  }
}

/**
 * `refunds[]` → {@link RefundFacts}.
 *
 * `atSec` comes from `created_at`, because **`refunds` has no `completed_at` column** (§7.2) and `atSec`
 * feeds exactly one thing: the "we refunded on `<date>`" sentence. `created_at` is when we recorded the
 * row, which for a `COMPLETED` refund is within a moment of when the money moved. The alternative was a
 * `new Date()` inside an evidence packet, which is a fact we would be inventing.
 *
 * An unusable `created_at` yields `0`, and the only consequence is a rendered "1 Jan 1970" in a sentence a
 * buyer reads. That is worse than the fix, so it is documented in `README-FILER.md` as a contract issue
 * instead: `refunds` needs a `completed_at`.
 */
function refundFactsOf(r: RefundRow): RefundFacts {
  return {
    id: r.id,
    paypalRefundId: r.paypal_refund_id,
    amount: { minor: r.amount_minor, currency: r.currency },
    status: r.status,
    atSec: dateToEpochSeconds(r.created_at) ?? 0,
  }
}

function shipmentFactsOf(s: ShipmentRow): ShipmentFacts {
  const lines: LineFact[] = []
  for (const entry of Array.isArray(s.lines) ? s.lines : []) {
    const line = asRecord(entry)
    const sku = asString(line['sku'])
    const qty = asInteger(line['qty'])
    if (sku !== undefined && qty !== undefined && qty > 0) lines.push({ sku, qty })
  }
  return {
    id: s.id,
    carrier: s.carrier,
    trackingNumber: s.tracking_number,
    paypalTrackerId: s.paypal_tracker_id,
    status: s.status,
    lines,
  }
}

// ---------------------------------------------------------------------------
// ingestDisputeToDefender
// ---------------------------------------------------------------------------

/**
 * What one ingest did.
 *
 * **`context` is present whenever the row was written, including on the unlinked paths** — because the
 * router is supposed to run on those rows and produce R-NOCHAIN-1's sentence. A caller that skipped them
 * would leave EC-DSP-9's "Not a Countersign order" unsaid, which is the answer §18 question 20 depends on.
 */
export interface IngestResult {
  /** The stored `disputes` row, after the link was applied. */
  readonly dispute: DisputeRow
  /** How the PayPal dispute mapped onto our rows. */
  readonly join: JoinOutcome
  /** True when `capture_id` and `order_id` are both set. */
  readonly linked: boolean
  /** Whether this call created the row (`true`) or updated an existing one. */
  readonly created: boolean
  /** Ready for `route()`. */
  readonly context: DisputeContext
  /** EC-DSP-11, evaluated against the mirrored `raw`. */
  readonly withdrawal: WithdrawalVerdict
  /** Anything the caller should surface: the unmapped reason, a bundle/`custom_id` disagreement. */
  readonly warnings: readonly string[]
  readonly disputeId: DisputeId
}

/**
 * Ingest one PayPal dispute into the Defender's world.
 *
 * ```ts
 * const fetched = await deps.paypal.getDispute(paypalDisputeId)
 * if (!fetched.ok) return fetched
 * const result = await ingestDisputeToDefender(fetched.value, deps)
 * ```
 *
 * Runs in this order, and **every step's failure is terminal for that step** while leaving previous steps'
 * writes in place. An exception would be worse than a partial ingest, because the buyer's chargeback would
 * then have no row at all:
 *
 * 1. **Validate.** A `Dispute` with no `dispute_id` is `CS_VALIDATION` and nothing is written.
 * 2. **Rank.** {@link disputeStageFor} / {@link disputeStatusFor}. An unrankable stage is `CS_VALIDATION`
 *    and nothing is written — see that function for why guessing is worse.
 * 3. **Join.** {@link joinDisputeToOrder}. **Never fatal**: the two failure branches are values, so the row
 *    is still stored and the router still gets to answer.
 * 4. **Store.** `upsertFromFetch`, so §8.12's "never move a row backwards" is applied inside `packages/db`
 *    rather than a second time here. `created` reports whether this call inserted the row.
 * 5. **Link.** `linkToOrder` when the join succeeded, and only then.
 * 6. **Close a withdrawal.** EC-DSP-11 sets `defense_state = CLOSED_WON`, which is §12.11's handling column
 *    for a cancelled case and which makes the filer refuse.
 * 7. **Build the context.** {@link buildDisputeContext}.
 *
 * @param raw the **fetched** dispute, never a webhook payload — §3.3's rule, and the reason
 *   `packages/webhooks` exports its own `ingestDispute` for the webhook path.
 */
export async function ingestDisputeToDefender(
  raw: Dispute,
  deps: DefenderDeps,
): Promise<Result<IngestResult, CsError>> {
  const paypalDisputeId = typeof raw.dispute_id === 'string' ? raw.dispute_id.trim() : ''
  if (paypalDisputeId === '') {
    return err(
      csError(
        'CS_VALIDATION',
        'The dispute has no dispute_id, so there is nothing to store or key on. Nothing was written.',
        { received: typeof raw.dispute_id },
      ),
    )
  }

  const staged = disputeStageFor(raw.dispute_life_cycle_stage)
  if (!staged.ok) return staged

  const at = new Date(deps.clock.nowMs())
  const join = await joinDisputeToOrder(raw, deps)
  if (!join.ok) return join

  const existing = await deps.store.disputes.findByPaypalId(paypalDisputeId)
  if (!existing.ok) return existing

  const stored = await deps.store.disputes.upsertFromFetch({
    paypalDisputeId,
    id: derivedDisputeId(paypalDisputeId),
    stage: staged.value,
    status: disputeStatusFor(raw.status),
    reason: asString(raw.reason) ?? 'UNSPECIFIED',
    amount: disputeAmountOf(raw),
    // Both deadlines come from **this fetch**, never from a stored value: EC-DSP-4 says the deadline is
    // recalculated from the API when a dispute escalates, and §3.3 says the fetch is the truth.
    sellerResponseDueDate: rfc3339ToDate(raw.seller_response_due_date),
    buyerResponseDueDate: rfc3339ToDate(raw.buyer_response_due_date),
    raw: toJsonValue(raw),
    updatedAt: rfc3339ToDate(raw.update_time) ?? at,
  })
  if (!stored.ok) return stored
  const created = existing.value === undefined

  const linked =
    join.value.kind === 'LINKED'
      ? await deps.store.disputes.linkToOrder(
          stored.value.id,
          { orderId: join.value.orderId, captureId: join.value.captureId },
          at,
        )
      : ok(stored.value)
  if (!linked.ok) return linked

  const withdrawal = buyerWithdrew(linked.value.raw)
  let dispute = linked.value
  if (withdrawal.withdrew && linked.value.defense_state !== 'CLOSED_WON') {
    const closed = await deps.store.disputes.setDefenseState(dispute.id, 'CLOSED_WON', at)
    if (!closed.ok) return closed
    dispute = closed.value
  }

  const context = await buildDisputeContext(dispute, raw, deps)
  if (!context.ok) return context

  const warnings: string[] = []
  if (join.value.kind !== 'LINKED') warnings.push(join.value.reason)
  if (dispute.order_id !== null && dispute.order_id !== undefined) {
    const bundle = await deps.store.evidence.bundle(dispute.order_id)
    if (!bundle.ok) return bundle
    const agreement = customIdAgreement(bundle.value, context.value.order?.customId ?? '')
    if (agreement !== null && !agreement.agreed) warnings.push(agreement.message)
  }

  deps.logger?.info('defender.ingest: dispute stored', {
    paypal_dispute_id: paypalDisputeId,
    dispute_id: dispute.id,
    stage: dispute.stage,
    status: dispute.status,
    linked: join.value.kind === 'LINKED',
    created,
    withdrew: withdrawal.withdrew,
  })

  return ok({
    dispute,
    join: join.value,
    linked: join.value.kind === 'LINKED',
    created,
    context: context.value,
    withdrawal,
    warnings,
    disputeId: dispute.id,
  })
}

// ---------------------------------------------------------------------------
// Deterministic ids, jsonb conversion, and the small readers
// ---------------------------------------------------------------------------

/**
 * `dsp_…` for a PayPal dispute id that has no row yet.
 *
 * `sha256(canonicalJson(scope))` truncated to 26 characters — the same construction `packages/orders` uses,
 * for the same reason. **Idempotency**: two workers ingesting the same new dispute derive the identical id,
 * so the second hits the primary key instead of writing a second case row. A chargeback defence that creates
 * two cases for one chargeback would file two packets, which is the bug this id exists to prevent.
 */
export function derivedDisputeId(paypalDisputeId: string): DisputeId {
  const digest = createHash('sha256')
    .update(canonicalJson({ kind: 'dispute', paypalDisputeId }), 'utf8')
    .digest('hex')
  return `dsp_${digest.slice(0, 26)}` as DisputeId
}

/**
 * `pkt_…` for `(disputeId, version)`, derived rather than random.
 *
 * `evidence_packets.id` is the primary key **and** the QR payload (§8.18's `/v/{packetId}`), so a
 * deterministic id is what makes "re-running the filer produced the same packet" *observable* rather than
 * merely likely. Same construction and same reason as {@link derivedDisputeId}.
 */
export function derivedPacketId(disputeId: string, version: number): PacketId {
  const digest = createHash('sha256')
    .update(canonicalJson({ kind: 'packet', disputeId, version }), 'utf8')
    .digest('hex')
  return `pkt_${digest.slice(0, 26)}` as PacketId
}

/**
 * A PayPal body as a `jsonb` value.
 *
 * `JSON.parse(JSON.stringify(x))` is the honest conversion for a body that arrived as JSON, and it is also
 * the step that would fail loudly if PayPal ever sent something a `jsonb` column cannot hold — which is
 * exactly what a `raw` mirror should do. `bigint` is stringified in the replacer rather than thrown on,
 * because this package's own contexts hold `bigint` amounts and a mirror is allowed to record them.
 */
export function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(
    JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v)),
  ) as JsonValue
}

/**
 * The disputed amount as integer minor units.
 *
 * **`fromPayPalValue` from `@countersign/core`, never `parseFloat`** — spec §0 rule 9, and the
 * money-discipline gate, which scans `packages/defender/src`.
 *
 * An unreadable amount becomes **zero in the dispute's own currency when we know it, else USD**.
 * Deliberate: `disputes.amount_minor` is `notNull`, and a chargeback with an unreadable amount still has to
 * be stored so a human sees it. The alternative — refusing the upsert — leaves the buyer with no notice of a
 * dispute at all, which is the far worse failure. `raw` keeps whatever PayPal sent.
 */
function disputeAmountOf(paypal: Dispute): Money {
  const response = paypal.dispute_amount
  const currency = asString(paypal.dispute_currency) ?? asString(response?.currency_code)
  const value = asString(response?.value)
  if (value === undefined || currency === undefined || !isCurrencyCode(currency)) {
    return { minor: 0n, currency: 'USD' }
  }
  try {
    return fromPayPalValue(value, currency)
  } catch {
    return { minor: 0n, currency: 'USD' }
  }
}

/** Narrow `unknown` to a `Currency` without importing the whole vocabulary for one comparison. */
function isCurrencyCode(value: string): value is Currency {
  return /^[A-Z]{3}$/.test(value)
}

/**
 * jsonb readers. All take `unknown`, because every caller is reading a `jsonb` mirror rather than a
 * validated response, and a reader that throws on an unexpected shape turns a mirrored bug into a dead job.
 */
export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

/** `bigint` epoch seconds or millis → seconds, or `undefined`. Time is never a float here either. */
function epochSecondsOf(value: bigint | undefined): number | undefined {
  if (value === undefined) return undefined
  // `mandates.iat` is epoch **seconds**; the threshold catches a millis value without importing anything.
  return value > 10_000_000_000n ? Number(value / 1000n) : Number(value)
}

function dateToEpochSeconds(value: Date | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return undefined
  return Math.trunc(value.getTime() / 1000)
}

/* ------------------------------------------------------------------------------------------ */
/* An in-memory DefenderStore                                                                   */
/* ------------------------------------------------------------------------------------------ */

/**
 * Seed rows. Everything the {@link DefenderStore} port needs, and nothing else.
 *
 * Ids are ours (`ord_…`, `cap_…`, `shp_…`, `dsp_…`) so a reader can tell them from PayPal's
 * (`5O…`, `3C…`, `PP-D-…`) at a glance, and every one is derived from a `kind` + discriminator so two seeds
 * never collide by accident.
 */
export interface DefenderWorldSeed {
  readonly orders?: readonly OrderRow[]
  readonly attempts?: readonly CheckoutAttemptRow[]
  readonly captures?: readonly CaptureRow[]
  readonly refunds?: readonly RefundRow[]
  readonly shipments?: readonly ShipmentRow[]
  readonly mandates?: readonly MandateRow[]
  readonly checkoutSessions?: readonly CheckoutSessionRow[]
  readonly gateDecisions?: readonly GateDecisionRow[]
  readonly devices?: readonly DeviceRow[]
  readonly audit?: readonly AuditLogRow[]
  readonly disputes?: readonly DisputeRow[]
  readonly packets?: readonly EvidencePacketRow[]
  readonly actions?: readonly DisputeActionRow[]
  /** The §7.3 bundle, per order id. No repository assembles this, so a seed supplies it whole. */
  readonly bundles?: Readonly<Record<string, EvidenceBundle>>
  /** `EvidenceCorpus` per order id. **A missing order gets `{}`**, never a `true`. */
  readonly corpora?: Readonly<Record<string, EvidenceCorpus>>
  /** `MerchantPolicy` per merchant id. A missing merchant gets `{}`, the conservative default. */
  readonly policies?: Readonly<Record<string, MerchantPolicy>>
  readonly l1Credentials?: Readonly<Record<string, { readonly sdJwt: string }>>
}

export interface InMemoryDefenderWorld {
  readonly store: DefenderStore
  /**
   * Every row, by table. A test asserts on these; the store is the port, not the record.
   *
   * Keyed by `string` rather than by each row's branded id, because the port's readers take plain `string`s
   * (they have to: a caller holding a `Dispute['order_id']` has no way to satisfy `ord_…` without a cast).
   */
  readonly rows: {
    readonly orders: Map<string, OrderRow>
    readonly attempts: Map<string, CheckoutAttemptRow>
    readonly captures: Map<string, CaptureRow>
    readonly refunds: Map<string, RefundRow>
    readonly shipments: Map<string, ShipmentRow>
    readonly mandates: Map<string, MandateRow>
    readonly checkoutSessions: Map<string, CheckoutSessionRow>
    readonly gateDecisions: GateDecisionRow[]
    readonly devices: Map<string, DeviceRow>
    readonly audit: AuditLogRow[]
    readonly disputes: Map<string, DisputeRow>
    readonly packets: Map<string, EvidencePacketRow>
    readonly actions: Map<string, DisputeActionRow>
  }
}

/**
 * An in-memory {@link DefenderStore}.
 *
 * Exists — in `src/`, not in `test/` — for the reason `packages/orders` puts
 * `createInMemoryOrderWorld` in `src/deps.ts`: **EC-DSP-10, the CRITICAL-window refusal, the posture gate and
 * the offer arithmetic are the claims under test, and none of them needs Postgres.** Making them depend on a
 * running database would make them rarer, not stronger.
 *
 * ### What it models that a plain object would not
 *
 * The three things that *are* the idempotency defences, so a test can rely on them rather than on a comment:
 *
 * 1. **`dispute_actions_idempotency_key_key` is UNIQUE.** {@link createInMemoryDefenderWorld} returns
 *    `CS_CONFLICT` for a duplicate key, exactly as `repos/audit.ts`'s `isUniqueViolation` path does. EC-DSP-10
 *    depends on that constraint being real.
 * 2. **`evidence_packets_dispute_id_version_key` is UNIQUE**, so two filings of the same version collide.
 * 3. **`disputes_paypal_dispute_id_key` is UNIQUE**, so two ingests of one PayPal dispute collide — which is
 *    what makes {@link derivedDisputeId} load-bearing.
 *
 * ### What it deliberately does not model
 *
 * **The §8.12 stage/status rank.** `upsertFromFetch` here overwrites, and the test that cares about ordering
 * asserts it against `packages/db`'s `isDisputeRegression`, which is a pure function and is tested there. A
 * second implementation of the rank in this file would be a second opinion about a rule another package owns.
 */
export function createInMemoryDefenderWorld(seed: DefenderWorldSeed = {}): InMemoryDefenderWorld {
  // Explicit `Map<string, Row>` on every line: `new Map(rows.map(r => [r.id, r]))` infers the *branded* id as
  // the key type from the tuple, and the port's readers take plain `string`s.
  const orders = new Map<string, OrderRow>((seed.orders ?? []).map((r) => [r.id, r]))
  const attempts = new Map<string, CheckoutAttemptRow>((seed.attempts ?? []).map((r) => [r.id, r]))
  const captures = new Map<string, CaptureRow>((seed.captures ?? []).map((r) => [r.id, r]))
  const refunds = new Map<string, RefundRow>((seed.refunds ?? []).map((r) => [r.id, r]))
  const shipments = new Map<string, ShipmentRow>((seed.shipments ?? []).map((r) => [r.id, r]))
  const mandates = new Map<string, MandateRow>((seed.mandates ?? []).map((r) => [r.id, r]))
  const sessions = new Map<string, CheckoutSessionRow>(
    (seed.checkoutSessions ?? []).map((r) => [r.id, r]),
  )
  const gateDecisions = [...(seed.gateDecisions ?? [])]
  const devices = new Map<string, DeviceRow>((seed.devices ?? []).map((r) => [r.id, r]))
  const audit = [...(seed.audit ?? [])]
  const disputes = new Map<string, DisputeRow>((seed.disputes ?? []).map((r) => [r.id, r]))
  const packets = new Map<string, EvidencePacketRow>((seed.packets ?? []).map((r) => [r.id, r]))
  const actions = new Map<string, DisputeActionRow>(
    (seed.actions ?? []).map((r) => [r.idempotency_key, r]),
  )

  const wrap = <T>(value: T): Promise<Result<T, CsError>> => Promise.resolve(ok(value))

  const store: DefenderStore = {
    async transaction<T>(fn: (tx: DefenderTx) => Promise<T>): Promise<Result<T, CsError>> {
      try {
        return ok(await fn(undefined as unknown as DefenderTx))
      } catch (cause) {
        return err(toCsError(cause, 'CS_INTERNAL'))
      }
    },

    disputes: {
      findById: (id) => wrap(disputes.get(id)),
      findByPaypalId: (paypalDisputeId) =>
        wrap([...disputes.values()].find((d) => d.paypal_dispute_id === paypalDisputeId)),
      async upsertFromFetch(input) {
        const current = [...disputes.values()].find(
          (d) => d.paypal_dispute_id === input.paypalDisputeId,
        )
        const values = {
          // §7.2's mirrors, and the join columns this file does not own: preserved, never clobbered.
          order_id: current?.order_id ?? null,
          capture_id: current?.capture_id ?? null,
          reason: input.reason,
          stage: input.stage,
          status: input.status,
          amount_minor: input.amount.minor,
          currency: input.amount.currency,
          seller_response_due_date: input.sellerResponseDueDate,
          buyer_response_due_date: input.buyerResponseDueDate,
          raw: input.raw,
          fetched_at: input.updatedAt,
          updated_at: input.updatedAt,
        }
        if (current === undefined) {
          const row = {
            id: input.id,
            paypal_dispute_id: input.paypalDisputeId,
            defense_state: 'NEW',
            liability: null,
            router_trace: null,
            created_at: input.updatedAt,
            ...values,
          } as unknown as DisputeRow
          disputes.set(row.id, row)
          return ok(row)
        }
        const row = { ...current, ...values } as DisputeRow
        disputes.set(row.id, row)
        return ok(row)
      },
      async insert(input) {
        const row = input as unknown as DisputeRow
        if (
          disputes.has(row.id) ||
          [...disputes.values()].some((d) => d.paypal_dispute_id === row.paypal_dispute_id)
        ) {
          return err(uniqueViolation('disputes', row.id))
        }
        disputes.set(row.id, row)
        return ok(row)
      },
      async linkToOrder(id, link, at) {
        const current = disputes.get(id)
        if (current === undefined) return err(notFound('disputes', id))
        const row = {
          ...current,
          order_id: link.orderId,
          capture_id: link.captureId,
          updated_at: at,
        } as DisputeRow
        disputes.set(id, row)
        return ok(row)
      },
      async setLiability(id, liability, routerTrace, at) {
        const current = disputes.get(id)
        if (current === undefined) return err(notFound('disputes', id))
        const row = {
          ...current,
          liability,
          router_trace: routerTrace,
          updated_at: at,
        } as DisputeRow
        disputes.set(id, row)
        return ok(row)
      },
      async setDefenseState(id, state, at) {
        const current = disputes.get(id)
        if (current === undefined) return err(notFound('disputes', id))
        const row = { ...current, defense_state: state, updated_at: at } as DisputeRow
        disputes.set(id, row)
        return ok(row)
      },
    },

    orders: {
      findById: (id) => wrap(orders.get(id)),
      findByCustomId: (customId) =>
        wrap([...orders.values()].find((o) => o.custom_id === customId)),
      findByAttempt: (attemptId) =>
        wrap([...orders.values()].find((o) => o.attempt_id === attemptId)),
    },

    captures: {
      findById: (id) => wrap(captures.get(id)),
      // **The D-013 join.** Indexed by PayPal's id, exactly as `captures_paypal_capture_id_key` is.
      findByPaypalId: (paypalCaptureId) =>
        wrap([...captures.values()].find((c) => c.paypal_capture_id === paypalCaptureId)),
      findByOrder: (orderId) => wrap([...captures.values()].filter((c) => c.order_id === orderId)),
    },

    refunds: {
      findByCapture: (captureId) =>
        wrap([...refunds.values()].filter((r) => r.capture_id === captureId)),
    },

    shipments: {
      findByOrder: (orderId) => wrap([...shipments.values()].filter((s) => s.order_id === orderId)),
    },

    attempts: {
      findById: (id) => wrap(attempts.get(id)),
    },

    mandates: {
      findById: (id) => wrap(mandates.get(id)),
    },

    checkoutSessions: {
      findById: (id) => wrap(sessions.get(id)),
    },

    gate: {
      findForAttempt: (attemptId) =>
        wrap(
          gateDecisions
            .filter((g) => g.attempt_id === attemptId)
            .sort((a, b) => b.decided_at.getTime() - a.decided_at.getTime())[0],
        ),
    },

    devices: {
      findById: (id) => wrap(devices.get(id)),
    },

    audit: {
      listBySubject: (subject) =>
        wrap(
          audit
            .filter((a) => a.subject === subject)
            .sort((a, b) => a.at.getTime() - b.at.getTime()),
        ),
    },

    evidence: {
      // **`{}` for an unknown order, never a `true`.** See the file header: these booleans are "we can put a
      // real document behind this claim", so a default of `true` is the direction that files an unsupported
      // packet.
      corpus: (orderId) => wrap(seed.corpora?.[orderId] ?? {}),
      policy: (merchantId) => wrap(seed.policies?.[merchantId] ?? {}),
      bundle: async (orderId) => {
        const bundle = seed.bundles?.[orderId]
        return bundle === undefined ? err(notFound('evidence bundle', orderId)) : ok(bundle)
      },
      l1Credential: (deviceId, walletId) => wrap(seed.l1Credentials?.[`${deviceId}:${walletId}`]),
    },

    packets: {
      findById: (id) => wrap(packets.get(id)),
      latestForDispute: (disputeId) =>
        wrap(
          [...packets.values()].filter((p) => p.dispute_id === disputeId).sort(byVersionDesc)[0],
        ),
      // **Newest first**, and *every* version: EC-DSP-10's content-address check needs the whole history.
      forDispute: (disputeId) =>
        wrap([...packets.values()].filter((p) => p.dispute_id === disputeId).sort(byVersionDesc)),
      async insert(input) {
        const row = input as unknown as EvidencePacketRow
        if (packets.has(row.id)) return err(uniqueViolation('evidence_packets', row.id))
        const clash = [...packets.values()].find(
          (p) => p.dispute_id === row.dispute_id && p.version === row.version,
        )
        if (clash !== undefined)
          return err(uniqueViolation('evidence_packets_dispute_id_version_key', row.id))
        packets.set(row.id, row)
        return ok(row)
      },
      async attachPdf(id, pdfBytes, pdfSha256, at) {
        const current = packets.get(id)
        if (current === undefined) return err(notFound('evidence_packets', id))
        const row = { ...current, pdf_bytes: pdfBytes, pdf_sha256: pdfSha256, updated_at: at }
        packets.set(id, row)
        return ok(row)
      },
      async markFiled(id, paypalResponse, at) {
        const current = packets.get(id)
        if (current === undefined) return err(notFound('evidence_packets', id))
        const row = { ...current, filed_at: at, paypal_response: paypalResponse, updated_at: at }
        packets.set(id, row)
        return ok(row)
      },
    },

    actions: {
      // **The UNIQUE constraint `dispute_actions_idempotency_key_key`.** EC-DSP-10's local half is this index;
      // a test that asserted only "we checked first" would pass on an implementation with no constraint, and
      // this is the constraint.
      findByIdempotencyKey: (idempotencyKey) => wrap(actions.get(idempotencyKey)),
      async record(input) {
        const row = input as unknown as DisputeActionRow
        if (actions.has(row.idempotency_key)) {
          return err(uniqueViolation('dispute_actions_idempotency_key_key', row.id))
        }
        actions.set(row.idempotency_key, row)
        return ok(row)
      },
      listForDispute: (disputeId) =>
        wrap(
          [...actions.values()]
            .filter((a) => a.dispute_id === disputeId)
            .sort((a, b) => a.at.getTime() - b.at.getTime()),
        ),
    },
  }

  return {
    store,
    rows: {
      orders,
      attempts,
      captures,
      refunds,
      shipments,
      mandates,
      checkoutSessions: sessions,
      gateDecisions,
      devices,
      audit,
      disputes,
      packets,
      actions,
    },
  }
}

function byVersionDesc(a: EvidencePacketRow, b: EvidencePacketRow): number {
  return b.version - a.version
}

function notFound(table: string, id: string): CsError {
  return csError('CS_NOT_FOUND', `No ${table} row for ${id}`, { table, id })
}

/** `23505`, the way `packages/db`'s `isUniqueViolation` path reports it. */
function uniqueViolation(constraint: string, id: string): CsError {
  return csError(
    'CS_CONFLICT',
    `A row with this key already exists (${constraint}), so nothing was written twice.`,
    { constraint, id },
  )
}
