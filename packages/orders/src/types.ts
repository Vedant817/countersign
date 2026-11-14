/**
 * `@countersign/orders` types — spec **§8.11 (M11, WP-11)**, **D17**, **D18**, §7.2, §12.1, §12.7.
 *
 * ## What this package is
 *
 * The order orchestrator: the only place in the repository that turns a Gate `ALLOW` into a PayPal
 * money movement, and the only place that turns a PayPal money movement back into the buyer's ledger.
 * Everything it needs is behind one closed list — {@link OrdersDeps} — for the same reason
 * `packages/gate` has one (§3.1 invariant **I-1**: *no PayPal money movement happens unless a Gate
 * `ALLOW` decision record exists for exactly that order, amount, currency and payee*):
 *
 * | Capability | Why it is a member and not a convenience |
 * |---|---|
 * | {@link OrdersDeps.clock} | EC-MDT-5 and EC-TIME-5 are pure timestamp claims; a wall clock makes them untestable. |
 * | {@link OrdersDeps.paypal} | The four side-effecting calls, so a test can inject `fetchImpl` and still exercise the real `PayPalClient`. |
 * | {@link OrdersDeps.store} | Our own rows. **Not** PayPal's — see the rule-5 note on `createInMemoryOrderWorld` in `deps.ts`. |
 * | {@link OrdersDeps.budget} | The asymmetric ledger hooks of §8.11, behind a three-method port. |
 * | {@link OrdersDeps.notify} | EC-CAP-5's "notify the user" on a decline. |
 *
 * ## The three things a reviewer should check first
 *
 * 1. **The allocation in `capture.ts` is `allocate()` from `@countersign/core`** (largest-remainder), so
 *    `Σ captures == authorized` exactly, with no float anywhere (EC-FX-4, §0).
 * 2. **`final_capture` is a function of what is left**, not of the shipment: `remaining == 0` by
 *    default, and `true` when the merchant says the order is done (EC-CAP-2, EC-STOCK-1, [B12]).
 * 3. **The budget hooks are asymmetric, deliberately.** commit on a completed capture, release on
 *    void/decline/expiry, **no restore on a refund**, audit-only reverse on a chargeback. The refund
 *    rule looks like a bug and is not; the reasoning is in `budget-hooks.ts`.
 *
 * ## A note on `Result` at the boundary
 *
 * Nothing here throws across a module boundary (AGENTS.md rule 3). Every port member returns
 * `Result<T, CsError>` with a `code` from the §8.1 registry, and the pure helpers here
 * ({@link allocationForShipment} lives in `capture.ts`) throw only where a throw is converted at the
 * edge.
 */

import type {
  AttemptId,
  CheckoutId,
  Clock,
  CsError,
  Currency,
  GateDecisionId,
  Logger,
  MandateId,
  Money,
  OrderId,
  Result,
  ShipmentId,
  WalletId,
} from '@countersign/core'

import type {
  AuthorizationRow,
  AuthorizationStatus,
  CaptureRow,
  CaptureStatus,
  CheckoutAttemptRow,
  CheckoutSessionRow,
  DisputeRow,
  Exec,
  GateDecisionRow,
  L1Row,
  MandateRow,
  MerchantRow,
  NewAuthorization,
  NewCapture,
  NewOrder,
  NewRefund,
  NewShipment,
  OrderIntent,
  OrderRow,
  OrderStatus,
  ProductRow,
  RefundInitiatedBy,
  RefundRow,
  RefundStatus,
  ShipmentRow,
  ShipmentStatus,
  WalletRow,
} from '@countersign/db'

import type { PayPalClient } from '@countersign/paypal'
import type { BudgetBalance } from '@countersign/ledger'

/**
 * The status enums are **imported from `@countersign/db`, never redeclared**.
 *
 * They are the pg enums of §7.2, and a second copy in this file would be a second thing that can
 * drift: a value added to `capture_status` would typecheck here against the old union while the
 * database accepted it, and the difference would surface as a `tsc` error in whichever package
 * updated last.
 */
export type {
  AuthorizationStatus,
  CaptureStatus,
  OrderIntent,
  OrderStatus,
  RefundInitiatedBy,
  RefundStatus,
  ShipmentStatus,
}

/* ------------------------------------------------------------------------------------------ */
/* The PayPal surface                                                                             */
/* ------------------------------------------------------------------------------------------ */

/**
 * The PayPal calls the orchestrator makes — §10.2 rows 5 to 11.
 *
 * A `Pick<PayPalClient, …>` rather than a hand-written interface, and that is deliberate: the real
 * client satisfies it structurally, so a test can inject `fetchImpl` and drive the **real** request
 * building, header assembly, retry loop and zod validation (AGENTS.md rule 5 forbids mocking PayPal's
 * behaviour, and it is also why these are `Pick`ed rather than re-declared — a second declaration of
 * `captureAuthorization`'s shape would be a second thing to keep correct).
 */
export type OrderPayPal = Pick<
  PayPalClient,
  | 'createOrder'
  | 'authorizeOrder'
  | 'captureOrder'
  | 'addTracking'
  | 'captureAuthorization'
  | 'voidAuthorization'
  | 'reauthorize'
  | 'refundCapture'
  | 'getOrder'
  | 'getAuthorization'
  | 'getCapture'
  | 'getRefund'
>

/* ------------------------------------------------------------------------------------------ */
/* Our own rows: the store port                                                                   */
/* ------------------------------------------------------------------------------------------ */

/**
 * The transaction handle every store method takes as its last argument.
 *
 * Typed as `@countersign/db`'s `Exec` so the production adapter can hand a Drizzle transaction
 * straight to the repository functions without a cast, and so **EC-MDT-2** is expressible: the
 * mandate re-read and the order insert take the same handle, so they commit or roll back together.
 *
 * It is opaque to the orchestrator: nothing outside `deps.ts` looks inside it, and no store method is
 * called with a handle from a different transaction.
 */
export type OrderTx = Exec

/**
 * Every row the orchestrator reads or writes.
 *
 * Narrow by design and named per statement, so the in-memory world in `deps.ts` is a plain object
 * rather than a database. **Every member names the `@countersign/db` repository that satisfies it in
 * production** — `orderStoreFromRepos` in `deps.ts` is the map, and it is a `tsc` error for a port
 * member to have no repo behind it.
 *
 * Note the two reads that exist only because a *different* package's repository cannot express them:
 *
 *  - `attempts.lockMandate` is a `SELECT … FOR UPDATE`, and `repos/mandates.ts` exposes no locking
 *    read. Same gap `packages/gate` documented for its own `lockMandate`; adding it there would mean
 *    editing another work package's files (AGENTS.md rule 8), so it is a port member here instead.
 *  - `disputes.openForCapture` needs "is there an open dispute against this capture?", and
 *    `repos/disputes.ts` has no by-capture lookup. See `README.md` → "Contract issues".
 */
export interface OrderStore {
  /**
   * Run `fn` as one unit, committing unless `fn` throws.
   *
   * Two properties the orchestrator depends on, therefore part of the port rather than assumed:
   *
   *  - **A returned `err(...)` commits.** Postgres does not roll back because a function said "no", and
   *    pretending otherwise would be a lie about the transaction. So the one place that must abandon
   *    writes — EC-MDT-2's aborted order create — throws a `CsError`, and the orchestrator goes through
   *    `withTxOrAbort` in `deps.ts`, which turns a returned `err` into a throw rather than relying on
   *    every call site remembering to.
   *  - `fn` receives the handle it must pass back to every store call that joins this transaction.
   */
  transaction<T>(fn: (tx: OrderTx) => Promise<T>): Promise<Result<T, CsError>>

  /** `repos/gate.ts::findGateDecisionById` — the decision row behind `GateDecision.id`. */
  gateDecision(
    id: GateDecisionId,
    tx?: OrderTx,
  ): Promise<Result<GateDecisionRow | undefined, CsError>>

  /** `repos/attempts.ts::requireAttempt` / `findAttemptById`. */
  attempt(id: AttemptId, tx?: OrderTx): Promise<Result<CheckoutAttemptRow | undefined, CsError>>

  /** `repos/mandates.ts::requireMandate` / `findMandateById`. */
  mandate(id: MandateId, tx?: OrderTx): Promise<Result<MandateRow | undefined, CsError>>

  /**
   * `SELECT … FROM mandates WHERE id = $1 FOR UPDATE`, inside the caller's transaction.
   *
   * **This member is EC-MDT-2.** The Gate's `ALLOW` is a snapshot; a mandate revoked between the
   * Gate and the order create would otherwise still be charged. Re-reading it under a row lock in the
   * *same* transaction as the order insert makes "revoked" and "an order exists" mutually exclusive.
   */
  lockMandate(id: MandateId, tx: OrderTx): Promise<Result<MandateRow | undefined, CsError>>

  /** `repos/wallets.ts::findWalletById` — the vault id for `payment_source.paypal.vault_id` [V10]. */
  wallet(id: WalletId, tx?: OrderTx): Promise<Result<WalletRow | undefined, CsError>>

  /** `repos/checkout.ts::requireCheckoutSession` — the locked cart that is the allocation basis. */
  checkoutSession(
    id: CheckoutId,
    tx?: OrderTx,
  ): Promise<Result<CheckoutSessionRow | undefined, CsError>>

  /** `repos/l1_credentials.ts` — the SD-JWT for §7.3's `l1` member of the evidence bundle. */
  l1Credential(
    deviceId: string,
    walletId: WalletId,
    tx?: OrderTx,
  ): Promise<Result<L1Row | undefined, CsError>>

  /** `repos/products.ts::findProductsBySku` — item names for `purchase_units[].items[]`. */
  products(skus: readonly string[], tx?: OrderTx): Promise<Result<ProductRow[], CsError>>

  /** `repos/merchants.ts::getMerchantByPaypalMerchantId`. */
  merchantByPaypalId(
    paypalMerchantId: string,
    tx?: OrderTx,
  ): Promise<Result<MerchantRow | undefined, CsError>>

  orders: {
    /** `repos/orders.ts::findOrderByAttempt` — **the** AT-M11.5 / EC-IDEM-1 lookup. */
    findByAttempt(
      attemptId: AttemptId,
      tx?: OrderTx,
    ): Promise<Result<OrderRow | undefined, CsError>>
    /** `repos/orders.ts::requireOrder` / `findOrderById`. */
    findById(id: OrderId, tx?: OrderTx): Promise<Result<OrderRow | undefined, CsError>>
    /** `repos/orders.ts::createOrder`. `orders_attempt_id_key` is the idempotency backstop. */
    insert(input: NewOrder, tx?: OrderTx): Promise<Result<OrderRow, CsError>>
    /** `repos/orders.ts::setOrderStatus`. */
    setStatus(
      id: OrderId,
      status: OrderStatus,
      at: Date,
      tx?: OrderTx,
    ): Promise<Result<OrderRow, CsError>>
    /** `repos/orders.ts::recordFetchedOrder` — the §7.1 `raw` mirror. */
    recordFetched(
      id: OrderId,
      raw: OrderRow['raw'],
      at: Date,
      tx?: OrderTx,
    ): Promise<Result<OrderRow, CsError>>
  }

  authorizations: {
    /** `repos/orders.ts::findAuthorizationsByOrder`. */
    findByOrder(orderId: OrderId, tx?: OrderTx): Promise<Result<AuthorizationRow[], CsError>>
    /** `repos/orders.ts::findAuthorizationById`. */
    findById(id: string, tx?: OrderTx): Promise<Result<AuthorizationRow | undefined, CsError>>
    /** `repos/orders.ts::createAuthorization`. */
    insert(input: NewAuthorization, tx?: OrderTx): Promise<Result<AuthorizationRow, CsError>>
    /** `repos/orders.ts::setAuthorizationStatus`. */
    setStatus(
      id: string,
      status: AuthorizationStatus,
      at: Date,
      tx?: OrderTx,
    ): Promise<Result<AuthorizationRow, CsError>>
  }

  captures: {
    /** `repos/orders.ts::findCapturesByOrder` — the orchestrator's Σ. */
    findByOrder(orderId: OrderId, tx?: OrderTx): Promise<Result<CaptureRow[], CsError>>
    /** `repos/orders.ts::findCaptureById`. */
    findById(id: string, tx?: OrderTx): Promise<Result<CaptureRow | undefined, CsError>>
    /** `repos/orders.ts::findCaptureByPaypalId` — the webhook/reconciler's join. */
    findByPaypalId(
      paypalCaptureId: string,
      tx?: OrderTx,
    ): Promise<Result<CaptureRow | undefined, CsError>>
    /** `repos/orders.ts::createCapture`. */
    insert(input: NewCapture, tx?: OrderTx): Promise<Result<CaptureRow, CsError>>
    /** `repos/orders.ts::setCaptureStatus` / `upsertCaptureStatusFromFetch` (monotonic rank). */
    setStatus(
      id: string,
      status: CaptureStatus,
      at: Date,
      raw?: CaptureRow['raw'],
      tx?: OrderTx,
    ): Promise<Result<CaptureRow, CsError>>
    /** `repos/orders.ts::linkCaptureToShipment`. */
    linkShipment(
      id: string,
      shipmentId: ShipmentId,
      at: Date,
      tx?: OrderTx,
    ): Promise<Result<CaptureRow, CsError>>
    /**
     * `repos/orders.ts::sumCapturedForAuthorization`.
     *
     * Used by the budget tools and by nothing in the capture path, because it counts **DECLINED and
     * REVERSED** rows as if they held money. `capture.ts` sums the rows itself for that reason; see
     * `capturedMinor` there and the contract issue in `README.md`.
     */
    sumForAuthorization(authorizationId: string, tx?: OrderTx): Promise<Result<bigint, CsError>>
  }

  refunds: {
    /** `repos/orders.ts::findRefundsByCapture`. */
    findByCapture(captureId: string, tx?: OrderTx): Promise<Result<RefundRow[], CsError>>
    /** One refund row by its id. EC-REF-3's retry needs to read the FAILED row it is replacing. */
    findById(id: string, tx?: OrderTx): Promise<Result<RefundRow | undefined, CsError>>
    /** `repos/orders.ts::findRefundByPaypalId`. */
    findByPaypalId(
      paypalRefundId: string,
      tx?: OrderTx,
    ): Promise<Result<RefundRow | undefined, CsError>>
    /** `repos/orders.ts::createRefund`. */
    insert(input: NewRefund, tx?: OrderTx): Promise<Result<RefundRow, CsError>>
    /** `repos/orders.ts::setRefundStatus` — also the only writer of `paypal_refund_id`. */
    setStatus(
      id: string,
      status: RefundStatus,
      paypalRefundId: string,
      raw?: RefundRow['raw'],
      tx?: OrderTx,
    ): Promise<Result<RefundRow, CsError>>
    /**
     * `repos/orders.ts::applyRefundToCapture` — bumps `refunded_minor` under the capture row.
     *
     * Its `WHERE refunded_minor + amount <= amount_minor` guard is the **local** half of EC-REF-2: the
     * half that makes AT-M11.4's "an over-refund is rejected with no PayPal call" structural rather
     * than a check that could be forgotten.
     *
     * Pass `tx` when applying a dispute refund together with its row status. Otherwise the adapter creates
     * a transaction for the guarded update. See `orderStoreFromRepos`.
     */
    applyToCapture(
      captureId: string,
      amount: Money,
      at: Date,
      tx?: OrderTx,
    ): Promise<Result<CaptureRow, CsError>>
  }

  shipments: {
    /** `repos/orders.ts::findShipmentsByOrder`. */
    findByOrder(orderId: OrderId, tx?: OrderTx): Promise<Result<ShipmentRow[], CsError>>
    /** Insert by `tracking_number` — no dedicated repo function; see `README.md` → "Contract issues". */
    insert(input: NewShipment, tx?: OrderTx): Promise<Result<ShipmentRow, CsError>>
    /** `repos/orders.ts::setShipmentTracker`. */
    setTracker(
      id: ShipmentId,
      paypalTrackerId: string,
      at: Date,
      tx?: OrderTx,
    ): Promise<Result<ShipmentRow, CsError>>
  }

  disputes: {
    /**
     * An **open** dispute against a capture, or `undefined`. EC-REF-4's detection.
     *
     * "Open" means not `RESOLVED` and not `CANCELED`, because either of those means PayPal has closed
     * the case and a refund is no longer routed through it.
     */
    openForCapture(
      paypalCaptureId: string,
      tx?: OrderTx,
    ): Promise<Result<DisputeRow | undefined, CsError>>
  }

  attempts: {
    /** `repos/attempts.ts::setAttemptState` — §3.3's attempt state machine, kept in step with the order. */
    setState(
      id: AttemptId,
      state: AttemptStateName,
      at: Date,
      tx?: OrderTx,
    ): Promise<Result<CheckoutAttemptRow, CsError>>
  }
}

/** `checkout_attempts.state` — spec §3.3, mirrored from the schema's pg enum. */
export type AttemptStateName =
  | 'CREATED'
  | 'GATED_ALLOW'
  | 'GATED_BLOCK'
  | 'ORDER_CREATED'
  | 'AUTHORIZED'
  | 'PARTIALLY_CAPTURED'
  | 'CAPTURED'
  | 'VOIDED'
  | 'AUTH_EXPIRED'
  | 'DECLINED'
  | 'PENDING_REVIEW'

/* ------------------------------------------------------------------------------------------ */
/* The budget ledger hooks (asymmetric on purpose)                                                 */
/* ------------------------------------------------------------------------------------------ */

/**
 * The three ledger movements §8.11 allows, and nothing else.
 *
 * **There is no fourth method**, and that is the point. §8.11's four bullets are asymmetric by design:
 *
 * | Event | Movement |
 * |---|---|
 * | capture `COMPLETED` | **commit** |
 * | void / decline / expiry | **release** |
 * | refund | **nothing** |
 * | chargeback reversal | **reverse**, audit only |
 *
 * A port with a `restore` or a `refund` method would make the missing fourth row a thing someone
 * could add without noticing that the spec says it must not exist. The reasoning ("a refund does not
 * return authority") is written out in `budget-hooks.ts` where the next reader will actually be.
 */
export interface BudgetHooks {
  /** capture `COMPLETED` → `reserved → spent`. Idempotent per capture. */
  commit(input: BudgetHookInput): Promise<Result<BudgetHookOutcome, CsError>>
  /** void / decline / expiry → give the reservation back. Idempotent per attempt. */
  release(input: BudgetReleaseInput): Promise<Result<BudgetHookOutcome, CsError>>
  /** chargeback reversal → a `REVERSE` entry for the audit. **No balance change.** */
  reverse(input: BudgetHookInput): Promise<Result<BudgetHookOutcome, CsError>>
}

export interface BudgetHookInput {
  readonly mandateId: MandateId
  /** The capture this movement belongs to. `budget_entries.capture_id`; `null` for a release. */
  readonly captureId: string | null
  readonly amount: Money
  readonly at: Date
}

export interface BudgetReleaseInput extends BudgetHookInput {
  readonly attemptId: AttemptId
  /** One of `RELEASE_REASONS`, or `voidRemainder`'s reason. Recorded verbatim in the entry. */
  readonly reason: string
}

/**
 * What a hook actually did.
 *
 * `moved: false` with `alreadySettled: true` is a **success**, not a failure: the entry ids are
 * derived from our own ids (§8.0 rule 6), so re-running a void finds the release already written and
 * must say so rather than either double-releasing or reporting an error the caller would then have to
 * interpret.
 */
export interface BudgetHookOutcome {
  readonly kind: 'COMMIT' | 'RELEASE' | 'REVERSE'
  readonly moved: boolean
  readonly alreadySettled: boolean
  readonly balance: BudgetBalance | null
  readonly error?: CsError
}

/* ------------------------------------------------------------------------------------------ */
/* Notifications                                                                                  */
/* ------------------------------------------------------------------------------------------ */

/**
 * EC-CAP-5's "notify the user", as data.
 *
 * A port rather than a call to a mail/SMS client because the *content* is the spec's requirement: the
 * buyer's copy for a decline is fixed prose ("PayPal declined the payment. Nothing was charged.
 * Update PayPal and retry."), and the demo UI renders the same string. Which transport delivers it is
 * WP-16/WP-18's business.
 */
export interface OrderNotification {
  readonly kind:
    | 'CAPTURE_DECLINED'
    | 'CAPTURE_PENDING'
    | 'ORDER_COMPLETED'
    | 'REMAINDER_RELEASED'
    | 'ORDER_PAYMENT_FAILED'
    | 'REFUND_COMPLETED'
    | 'REFUND_FAILED'
  readonly orderId: OrderId
  /** `mandates.user_id`, so a notifier can address the buyer without a second lookup. */
  readonly userId: string
  readonly captureId?: string
  readonly refundId?: string
  readonly amount?: Money
  /** Buyer-safe copy. Never an internal message (AGENTS.md rule 3). */
  readonly userMessage: string
  /** Epoch seconds, from the injected clock. */
  readonly at: number
  /** Free-form context for the transport (which template, which channel). Never secrets. */
  readonly detail?: Record<string, unknown>
}

export interface Notifier {
  notify(event: OrderNotification): Promise<void> | void
}

/* ------------------------------------------------------------------------------------------ */
/* The resolved order draft                                                                       */
/* ------------------------------------------------------------------------------------------ */

/** One line of the locked cart. `unitMinor` is what makes this the allocation basis (EC-FX-4). */
export interface DraftCartLine {
  readonly sku: string
  readonly qty: number
  readonly unitMinor: bigint
  /** `products.title`. Merchant-authored; §8.13 territory, see `create.ts` for what is *not* sent. */
  readonly title: string
  /** `products.digital` — D17's `intent` selector. */
  readonly digital: boolean
}

/**
 * Everything `createOrderFromDecision` needs, resolved from our own rows.
 *
 * Resolved **in one transaction** so that the mandate row it carries is the same snapshot the order
 * insert sees (EC-MDT-2). A draft built from two reads at different instants is exactly the bug the
 * spec's "re-reads mandate status in the same tx" exists to prevent.
 */
export interface OrderDraft {
  readonly merchantId: string
  readonly decision: {
    readonly id: GateDecisionId
    readonly attemptId: AttemptId
    /** The signed JWS — §7.3's `gate_decision` member and D18's binding to the chain. */
    readonly signedRecord: string
    readonly viLibCommit: string
    readonly decidedAt: Date
  }
  readonly attempt: {
    readonly id: AttemptId
    readonly mandateId: MandateId
    readonly checkoutSessionId: CheckoutId
    /** §3.1 I-1: the amount the signed record approved. */
    readonly amount: Money
    /** The allowed payee — §8.11's `payee.merchant_id`. */
    readonly payee: string
    readonly l3a: string
    readonly l3b: string
  }
  readonly mandate: {
    readonly id: MandateId
    readonly userId: string
    readonly walletId: WalletId
    readonly status: string
    /** `mandates.exp` (epoch seconds, `bigint`). */
    readonly expSec: bigint
    /** §7.3's `l2` member, byte for byte: `l2_serialized`, never a re-serialisation. */
    readonly l2Serialized: string
  }
  readonly wallet: {
    readonly id: WalletId
    /** `paypal_wallets.payment_token_id` — `payment_source.paypal.vault_id` [V10]. */
    readonly vaultId: string
    readonly status: string
    readonly payerId: string
    readonly payerEmail: string
  }
  readonly session: {
    readonly id: CheckoutId
    readonly merchantId: string
    /** §7.3's `checkout_jwt` member, verbatim. */
    readonly checkoutJwt: string
    readonly checkoutHash: string
    readonly lines: readonly DraftCartLine[]
    readonly subtotal: Money
    readonly tax: Money
    readonly shipping: Money
    readonly total: Money
  }
  /** §7.3's `l1` member. The SD-JWT exactly as the browser sent it. */
  readonly l1Serialized: string | null
  /** §7.3's `webauthn` member: `{present, at}`. `at` is the attempt's instant when asserted. */
  readonly webauthn: { readonly present: boolean; readonly at: number }
}

/**
 * D17: `AUTHORIZE` for physical goods, `CAPTURE` for digital ones.
 *
 * The rule, stated once here so the create path and the tests cannot disagree: **an order is `AUTHORIZE` if
 * any line ships, and `CAPTURE` only if every line is digital.** A mixed cart is `AUTHORIZE` — capturing up
 * front would take money for goods that cannot be delivered yet, and the whole point of D17 is that
 * out-of-stock then becomes a void rather than a refund.
 *
 * An **empty** cart is `AUTHORIZE`, and `create.ts` refuses it separately with a better message: there is
 * nothing to buy, and "you have digital goods" would be a confusing way to say so.
 */
export const INTENT_RULE =
  'D17: intent = CAPTURE only when every cart line is digital; any physical line (or an empty cart) means AUTHORIZE.'

export function intentForLines(lines: readonly DraftCartLine[]): OrderIntent {
  return lines.length > 0 && lines.every((l) => l.digital) ? 'CAPTURE' : 'AUTHORIZE'
}

/* ------------------------------------------------------------------------------------------ */
/* Shipment, void and refund inputs                                                                */
/* ------------------------------------------------------------------------------------------ */

/** §8.11's `shipment` argument, verbatim, plus the one flag D17 needs. */
export interface ShipmentInput {
  readonly lines: readonly { readonly sku: string; readonly qty: number }[]
  readonly carrier: string
  readonly tracking: string
  /**
   * Force `final_capture`.
   *
   * `undefined` (the default) derives it: `final_capture = (remaining == 0)`. Pass `true` when the
   * merchant is done with the authorization while money remains unallocated — EC-STOCK-1's "line went
   * out of stock after authorisation": PayPal releases the uncaptured remainder ([B12], EC-CAP-2).
   * Pass `false` to keep the authorization open even when the arithmetic says nothing is left, which
   * exists so a test can prove the derivation is a derivation.
   */
  readonly finalCapture?: boolean
  /** `note_to_payer` on the capture (0–255 chars, [B12]). */
  readonly noteToPayer?: string
}

/** §8.11's `reason` argument, verbatim. */
export type VoidReason = 'OUT_OF_STOCK' | 'REVOKED' | 'CANCELLED' | 'EXPIRED'

/**
 * Why a refund happened. Ours, not PayPal's.
 *
 * PayPal's refund request carries no reason field at all — only `note_to_payer` (audit §15) — so
 * `refunds.reason_code` stores **our** vocabulary for the receipt and the evidence packet. Naming that
 * here is what stops the next reader from looking for a PayPal enum that does not exist.
 */
export const REFUND_REASONS = [
  'DUPLICATE',
  'MERCHANT_REQUEST',
  'RETURN',
  'OUT_OF_STOCK',
  'NOT_RECEIVED',
  'FRAUD_SUSPECTED',
  'DISPUTE_RESOLUTION',
  'OTHER',
] as const
export type RefundReason = (typeof REFUND_REASONS)[number]

/** §8.11's `initiatedBy`, with the free-text actor the column pair stores alongside it. */
export interface Actor {
  /** `refunds.initiated_by` — the enum. */
  readonly initiatedBy: RefundInitiatedBy
  /** `refunds.actor`: the user id, agent id, `defender` or the dispute id. */
  readonly actor?: string
  /** `refunds.note` — the justification a merchant typed, stored with the refund. */
  readonly note?: string
}

/* ------------------------------------------------------------------------------------------ */
/* Results the orchestrator hands back                                                             */
/* ------------------------------------------------------------------------------------------ */

/**
 * How the AUTHORIZE order got its authorization.
 *
 * Recorded per order because **week-1 check C2's open question is exactly this** (spec U2, audit §17):
 * with `payment_source.paypal.vault_id` and `intent: AUTHORIZE`, the documented 201 example contains
 * the authorization inline at `purchase_units[].payments.authorizations[]`, and the spec still says
 * to fall back to `POST /v2/checkout/orders/{id}/authorize` if it is absent. Both branches are
 * implemented; this is which one ran, stored in `orders.raw` and logged, so the nightly sandbox run
 * answers C2 with evidence instead of an assumption.
 */
export type AuthorizationPath = 'INLINE' | 'AUTHORIZE_ENDPOINT' | 'NONE'

/** The same question for the `CAPTURE` intent's up-front capture (D17's digital path). */
export type CapturePath = 'INLINE' | 'CAPTURE_ENDPOINT' | 'NONE'

/** What `createOrderFromDecision` did, beyond the row itself. */
export interface CreateOrderReport {
  readonly order: OrderRow
  readonly authorizationId: string | null
  readonly captureId: string | null
  readonly authorizationPath: AuthorizationPath
  readonly capturePath: CapturePath
  /** `true` when an existing order for this attempt was returned (AT-M11.5). */
  readonly idempotent: boolean
  readonly requestId: string
}

/** What `captureShipment` decided about the money, so a caller can render a receipt without re-deriving it. */
export interface CaptureReport {
  readonly capture: CaptureRow
  readonly shipment: ShipmentRow | null
  readonly amount: Money
  readonly finalCapture: boolean
  /** `authorized − Σ captures` **after** this capture. `0n` when the authorization is closed. */
  readonly remainingAfter: bigint
  /** `true` when PayPal answered `PENDING`: EC-CAP-4, ship nothing. */
  readonly pending: boolean
  /** EC-SPLIT-2 / the C2 fallback: tracking against a capture that already existed. */
  readonly trackingOnly: boolean
  readonly requestId: string
  /** The authorization the capture drew on, or `null` on the CAPTURE-intent path. */
  readonly authorizationId: string | null
}

/** What `voidRemainder` released. */
export interface VoidReport {
  readonly released: Money
  readonly orderStatus: OrderStatus
  /** `true` when the authorization had not been captured at all, so PayPal's `/void` was used. */
  readonly viaAuthorizationVoid: boolean
  /** `true` when there was nothing left to release (already void, or fully captured). */
  readonly alreadySettled: boolean
}

/** What `refund` did. */
export interface RefundReport {
  readonly refund: RefundRow
  readonly capture: CaptureRow
  /** The refundable remainder **after** this refund. `0n` ⇒ the capture is fully refunded. */
  readonly refundableAfter: bigint
  readonly requestId: string
  /** EC-REF-4: the open dispute that blocked a direct refund, when one blocked it. */
  readonly blockedByDispute?: { readonly disputeId: string; readonly routes: readonly string[] }
}

/** What `reauthorizeIfNeeded` decided. Spec §8.11: "only inside the 3-day honor window logic". */
export type ReauthorizeOutcome =
  /** `now < honor window opens`: PayPal allows reauthorizing from day 4, and doing it earlier is a no-op. */
  | 'TOO_EARLY'
  /** Past `expiration_time`: released, order `AUTH_EXPIRED` (EC-TIME-5). */
  | 'EXPIRED'
  /** Already captured, voided or denied: nothing to do. */
  | 'SETTLED'
  /** Reauthorized. `honour window opens` is PayPal's, not ours. */
  | 'REAUTHORIZED'

export interface ReauthorizeReport {
  readonly outcome: ReauthorizeOutcome
  readonly authorizationId: string
  readonly requestId: string | null
  /** The remaining uncaptured amount, when it was released. */
  readonly released: Money | null
}

/* ------------------------------------------------------------------------------------------ */
/* Dependencies                                                                                   */
/* ------------------------------------------------------------------------------------------ */

/**
 * The orchestrator's entire world.
 *
 * Closed, so "the order path can reach an LLM" is a question about this interface rather than about
 * the codebase — and there is no member through which it could answer yes (§8.0 rule 4, and the same
 * reasoning as `GateDeps` in D-018).
 */
export interface OrdersDeps {
  /** The only time source (AGENTS.md rule 10). */
  readonly clock: Clock
  /** §10.2 rows 5–11. The real `PayPalClient`, with an injected `fetchImpl` in tests. */
  readonly paypal: OrderPayPal
  /** Our rows. */
  readonly store: OrderStore
  /** The three §8.11 ledger movements. */
  readonly budget: BudgetHooks
  /** EC-CAP-5's "notify the user". */
  readonly notify: Notifier
  /**
   * Put stock back for the lines a voided order never shipped. §8.9, EC-STOCK-1.
   *
   * **Optional**, and `voidRemainder` works without it — it just does not restock, and logs that it did
   * not. The port exists because stock lives in `@countersign/gate`'s merchant module (M9, `packages/gate`
   * exports `restoreStockOnVoid` and it is WP-11's job to call it), and because a **void that fails on a
   * stock row would leave the buyer's money released and the order still open**, which is worse than a
   * stale count.
   */
  readonly stock?: (
    lines: readonly { sku: string; qty: number }[],
    at: Date,
  ) => Promise<Result<unknown, CsError>>
  /** Optional. Used for the C2-path record and for money-free context. */
  readonly logger?: Logger
}

/** Type-check a complete `OrdersDeps` and refuse to build one with a hole in it. */
export function defineOrderDeps(deps: OrdersDeps): OrdersDeps {
  return deps
}

/** Currency re-export, so a caller passing `Money` needs one import for the vocabulary. */
export type { CsError, Currency, Money, Result }
