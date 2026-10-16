/**
 * Wiring for the orchestrator — spec **§8.11**, **D17**, **D18**, **D19**, §7.2.
 *
 * Three things live here, and none of them is the orchestrator's logic:
 *
 * 1. **`orderStoreFromRepos`** — the port-to-repository map. Every member of `OrderStore` names the
 *    `@countersign/db` repository that satisfies it in production, and this function *is* that map, so
 *    adding a port member without a repo behind it is a `tsc` error rather than a runtime surprise.
 *    Four members have no repository and are documented as contract issues in `README.md`; they are
 *    function handles the caller supplies, exactly as `packages/gate`'s `lockMandateForUpdate` is.
 * 2. **`budgetHooksFromStore`** — the three §8.11 ledger movements on top of `BudgetStore`. Not one
 *    line of cap arithmetic: that is `commitIn`/`releaseIn`/`reverseIn` from `@countersign/db`, behind
 *    `SELECT … FOR UPDATE`. A second `reserved += amount` anywhere is the one budget hazard this
 *    repository names (D19), and this file is written so that it cannot be introduced here.
 * 3. **`createInMemoryOrderWorld`** — an in-memory `OrderStore` for the tests and for Judge Mode.
 *
 * ## Rule 5, and what this file is allowed to fake
 *
 * AGENTS.md rule 5: *"Never fake PayPal behaviour. No mocking of PayPal outside
 * `packages/paypal/test/fixtures`."*
 *
 * The in-memory world here replaces **our own rows and only our own rows**. PayPal is always the real
 * `PayPalClient` — a test injects `fetchImpl` (the seam `PayPalClientOpts` already has) and the client
 * under test does its real request building, header assembly, retry loop, backoff and zod validation.
 * Nothing in this file, and nothing the tests derive from it, decides what PayPal would have answered;
 * the *responses* are doc-derived stubs over a replaced `fetch`, which is the same seam
 * `packages/paypal/test/fixtures/transport-double.ts` uses.
 *
 * ## What the in-memory world models carefully rather than trivially
 *
 * A double that is easier than the real thing turns every assertion into a measurement of the double:
 *
 *  - **The unique indexes that *are* the idempotency defences.** `orders_attempt_id_key` returning
 *    `CS_CONFLICT` is what AT-M11.5 is made of; `orders_paypal_order_id_key` and
 *    `captures_paypal_capture_id_key` are the same kind of thing.
 *  - **`applyRefundToCapture`'s guarded `UPDATE`**, i.e. EC-REF-2's "rejected locally, no PayPal
 *    call" — a guard expressed as arithmetic rather than as a boolean the double is handed.
 *  - **`ROLLBACK` undoing writes**, not merely releasing locks. EC-MDT-2's assertion is that an
 *    aborted order create leaves *no order row*, which a lock-releasing double would let pass while the
 *    real `withTx` rolled back.
 *  - **`FOR UPDATE` on the mandate re-read**, as a live row the test can mutate between reads.
 */

import { createHash } from 'node:crypto'

import {
  csError,
  err,
  newId,
  ok,
  type Result as CoreResult,
  type AttemptId,
  type CsError,
  type MandateId,
  type Money,
  type Result,
  type ShipmentId,
} from '@countersign/core'
import { canonicalJson, commitIn, releaseIn, reverseIn, type JsonValue } from '@countersign/db'
import type {
  AuthorizationRow,
  AuthorizationStatus,
  BudgetStore,
  CaptureRow,
  CaptureStatus,
  CheckoutAttemptRow,
  CheckoutSessionRow,
  DisputeRow,
  Exec,
  GateDecisionRow,
  L1Row,
  MandateRow,
  NewAuthorization,
  NewCapture,
  NewOrder,
  NewRefund,
  NewShipment,
  OrderRow,
  OrderStatus,
  ProductRow,
  RefundRow,
  RefundStatus,
  ShipmentRow,
  WalletRow,
} from '@countersign/db'
import { ledgerEntryId, releaseEntryId } from '@countersign/ledger'

import type {
  AttemptStateName,
  BudgetHookInput,
  BudgetHookOutcome,
  BudgetHooks,
  BudgetReleaseInput,
  Notifier,
  OrderNotification,
  OrderStore,
  OrderTx,
} from './types'

/* ============================================================================================ */
/* 1. Port → repository                                                                            */
/* ============================================================================================ */

/**
 * The `@countersign/db` handles `orderStoreFromRepos` needs.
 *
 * Function references rather than repository objects, because every repo in `@countersign/db` is a free
 * function taking an optional executor as its last argument — the shape WP-02 fixed. Re-wrapping them
 * into a second abstraction here would create a place where the `FOR UPDATE` and the guarded `UPDATE`
 * could be forgotten.
 *
 * **Four members have no repository behind them.** They are not implemented by reaching past the repos
 * into Drizzle (that would be a second data-access layer in the wrong package, AGENTS.md rule 8) and not
 * by editing `@countersign/db` from here. They are handles the caller supplies, and `README.md` →
 * "Contract issues" records what is missing and why each one is needed:
 *
 * | Handle | Why it does not exist yet |
 * |---|---|
 * | `lockMandateForUpdate` | `repos/mandates.ts` has no `SELECT … FOR UPDATE`. **EC-MDT-2 needs it.** `packages/gate` hit the same wall for its own `lockMandate`. |
 * | `findL1Credential` | there is no `repos/l1_credentials.ts`; §7.3's `l1` bundle member needs it. |
 * | `findOpenDisputeForCapture` | `repos/disputes.ts` has no by-capture lookup; **EC-REF-4's detection** needs it. |
 * | `findShipmentByTracking` | no by-tracking lookup; the shipment insert's idempotency key needs one. |
 */
export interface OrderRepoHandles {
  /** `client.withTx` from `@countersign/db`. Commits unless `fn` throws. */
  readonly withTx: <T>(fn: (tx: Exec) => Promise<T>) => Promise<Result<T, CsError>>

  /** `repos/gate.ts::findGateDecisionById`. */
  readonly findGateDecisionById: (
    id: string,
    exec?: Exec,
  ) => Promise<Result<GateDecisionRow | undefined, CsError>>
  /** `repos/attempts.ts::findAttemptById`. */
  readonly findAttemptById: (
    id: AttemptId,
    exec?: Exec,
  ) => Promise<Result<CheckoutAttemptRow | undefined, CsError>>
  /** `repos/mandates.ts::findMandateById`. */
  readonly findMandateById: (
    id: MandateId,
    exec?: Exec,
  ) => Promise<Result<MandateRow | undefined, CsError>>
  /** `SELECT … FROM mandates WHERE id = $1 FOR UPDATE`, on a transaction handle. */
  readonly lockMandateForUpdate: (
    id: MandateId,
    exec: Exec,
  ) => Promise<Result<MandateRow | undefined, CsError>>
  /** `repos/wallets.ts::findWalletById`. */
  readonly findWalletById: (
    id: string,
    exec?: Exec,
  ) => Promise<Result<WalletRow | undefined, CsError>>
  /** `repos/checkout.ts::findCheckoutSessionById`. */
  readonly findCheckoutSessionById: (
    id: string,
    exec?: Exec,
  ) => Promise<Result<CheckoutSessionRow | undefined, CsError>>
  /** `l1_credentials` by (device, wallet) — no repo file exists; see the table above. */
  readonly findL1Credential: (
    deviceId: string,
    walletId: string,
    exec?: Exec,
  ) => Promise<Result<L1Row | undefined, CsError>>
  /** `repos/products.ts::findProductsBySku`. */
  readonly findProductsBySku: (
    skus: readonly string[],
    exec?: Exec,
  ) => Promise<Result<ProductRow[], CsError>>

  /** `repos/orders.ts::findOrderByAttempt`. */
  readonly findOrderByAttempt: (
    attemptId: AttemptId,
    exec?: Exec,
  ) => Promise<Result<OrderRow | undefined, CsError>>
  /** `repos/orders.ts::findOrderById`. */
  readonly findOrderById: (
    id: string,
    exec?: Exec,
  ) => Promise<Result<OrderRow | undefined, CsError>>
  /** `repos/orders.ts::createOrder`. */
  readonly createOrder: (input: NewOrder, exec?: Exec) => Promise<Result<OrderRow, CsError>>
  /** `repos/orders.ts::setOrderStatus`. */
  readonly setOrderStatus: (
    id: string,
    status: OrderStatus,
    at: Date,
    exec?: Exec,
  ) => Promise<Result<OrderRow, CsError>>
  /** `repos/orders.ts::recordFetchedOrder`. */
  readonly recordFetchedOrder: (
    id: string,
    raw: OrderRow['raw'],
    at: Date,
    exec?: Exec,
  ) => Promise<Result<OrderRow, CsError>>

  /** `repos/orders.ts::findAuthorizationsByOrder`. */
  readonly findAuthorizationsByOrder: (
    orderId: string,
    exec?: Exec,
  ) => Promise<Result<AuthorizationRow[], CsError>>
  /** `repos/orders.ts::findAuthorizationById`. */
  readonly findAuthorizationById: (
    id: string,
    exec?: Exec,
  ) => Promise<Result<AuthorizationRow | undefined, CsError>>
  /** `repos/orders.ts::createAuthorization`. */
  readonly createAuthorization: (
    input: NewAuthorization,
    exec?: Exec,
  ) => Promise<Result<AuthorizationRow, CsError>>
  /** `repos/orders.ts::setAuthorizationStatus`. */
  readonly setAuthorizationStatus: (
    id: string,
    status: AuthorizationStatus,
    at: Date,
    exec?: Exec,
  ) => Promise<Result<AuthorizationRow, CsError>>

  /** `repos/orders.ts::findCapturesByOrder`. */
  readonly findCapturesByOrder: (
    orderId: string,
    exec?: Exec,
  ) => Promise<Result<CaptureRow[], CsError>>
  /** `repos/orders.ts::findCaptureById`. */
  readonly findCaptureById: (
    id: string,
    exec?: Exec,
  ) => Promise<Result<CaptureRow | undefined, CsError>>
  /** `repos/orders.ts::findCaptureByPaypalId`. */
  readonly findCaptureByPaypalId: (
    paypalCaptureId: string,
    exec?: Exec,
  ) => Promise<Result<CaptureRow | undefined, CsError>>
  /** `repos/orders.ts::createCapture`. */
  readonly createCapture: (input: NewCapture, exec?: Exec) => Promise<Result<CaptureRow, CsError>>
  /** `repos/orders.ts::setCaptureStatus`. */
  readonly setCaptureStatus: (
    id: string,
    status: CaptureStatus,
    at: Date,
    raw?: CaptureRow['raw'],
    exec?: Exec,
  ) => Promise<Result<CaptureRow, CsError>>
  /** `repos/orders.ts::linkCaptureToShipment`. */
  readonly linkCaptureToShipment: (
    id: string,
    shipmentId: ShipmentId,
    at: Date,
    exec?: Exec,
  ) => Promise<Result<CaptureRow, CsError>>
  /** `repos/orders.ts::sumCapturedForAuthorization`. */
  readonly sumCapturedForAuthorization: (
    authorizationId: string,
    exec?: Exec,
  ) => Promise<Result<bigint, CsError>>

  /** `repos/orders.ts::findRefundsByCapture`. */
  readonly findRefundsByCapture: (
    captureId: string,
    exec?: Exec,
  ) => Promise<Result<RefundRow[], CsError>>
  /** `repos/orders.ts::findRefundByPaypalId`. */
  readonly findRefundByPaypalId: (
    paypalRefundId: string,
    exec?: Exec,
  ) => Promise<Result<RefundRow | undefined, CsError>>
  /** By row id — EC-REF-3's retry reads the FAILED row. No repo function; see the table above. */
  readonly findRefundById: (
    id: string,
    exec?: Exec,
  ) => Promise<Result<RefundRow | undefined, CsError>>
  /** `repos/orders.ts::createRefund`. */
  readonly createRefund: (input: NewRefund, exec?: Exec) => Promise<Result<RefundRow, CsError>>
  /** `repos/orders.ts::setRefundStatus`. */
  readonly setRefundStatus: (
    id: string,
    status: RefundStatus,
    paypalRefundId: string,
    raw?: RefundRow['raw'],
    exec?: Exec,
  ) => Promise<Result<RefundRow, CsError>>
  /** `repos/orders.ts::applyRefundToCapture` — the guarded `UPDATE` behind EC-REF-2. */
  readonly applyRefundToCapture: (
    captureId: string,
    amount: Money,
    at: Date,
    exec: Exec,
  ) => Promise<Result<CaptureRow, CsError>>

  /** `repos/orders.ts::findShipmentsByOrder`. */
  readonly findShipmentsByOrder: (
    orderId: string,
    exec?: Exec,
  ) => Promise<Result<ShipmentRow[], CsError>>
  /** `repos/orders.ts::createShipment`. */
  readonly createShipment: (
    input: NewShipment,
    exec?: Exec,
  ) => Promise<Result<ShipmentRow, CsError>>
  /** `repos/orders.ts::setShipmentTracker`. */
  readonly setShipmentTracker: (
    id: ShipmentId,
    paypalTrackerId: string,
    at: Date,
    exec?: Exec,
  ) => Promise<Result<ShipmentRow, CsError>>
  /** By `tracking_number` — no repo function; see the table above. */
  readonly findShipmentByTracking: (
    trackingNumber: string,
    exec?: Exec,
  ) => Promise<Result<ShipmentRow | undefined, CsError>>

  /** Open dispute for a capture — no repo function; EC-REF-4's detection. */
  readonly findOpenDisputeForCapture: (
    paypalCaptureId: string,
    exec?: Exec,
  ) => Promise<Result<DisputeRow | undefined, CsError>>

  /** `repos/attempts.ts::setAttemptState`. */
  readonly setAttemptState: (
    id: AttemptId,
    state: AttemptStateName,
    at: Date,
    exec?: Exec,
  ) => Promise<Result<CheckoutAttemptRow, CsError>>
}

/**
 * Build an `OrderStore` from `@countersign/db`'s repositories.
 *
 * Purely a rename-and-forward: every method body is a call to a repository function with the caller's
 * executor handed straight through. There is no SQL, no arithmetic and no policy here, which is the
 * point — a port whose adapter contained logic would be a second implementation of it.
 */
export function orderStoreFromRepos(handles: OrderRepoHandles): OrderStore {
  return {
    transaction: <T>(fn: (tx: OrderTx) => Promise<T>) => handles.withTx(fn),

    gateDecision: (id, tx) => handles.findGateDecisionById(id, tx),
    attempt: (id, tx) => handles.findAttemptById(id, tx),
    mandate: (id, tx) => handles.findMandateById(id, tx),
    lockMandate: (id, tx) => handles.lockMandateForUpdate(id, tx),
    wallet: (id, tx) => handles.findWalletById(id, tx),
    checkoutSession: (id, tx) => handles.findCheckoutSessionById(id, tx),
    l1Credential: (deviceId, walletId, tx) => handles.findL1Credential(deviceId, walletId, tx),
    products: (skus, tx) => handles.findProductsBySku(skus, tx),

    orders: {
      findByAttempt: (attemptId, tx) => handles.findOrderByAttempt(attemptId, tx),
      findById: (id, tx) => handles.findOrderById(id, tx),
      insert: (input, tx) => handles.createOrder(input, tx),
      setStatus: (id, status, at, tx) => handles.setOrderStatus(id, status, at, tx),
      recordFetched: (id, raw, at, tx) => handles.recordFetchedOrder(id, raw, at, tx),
    },

    authorizations: {
      findByOrder: (orderId, tx) => handles.findAuthorizationsByOrder(orderId, tx),
      findById: (id, tx) => handles.findAuthorizationById(id, tx),
      insert: (input, tx) => handles.createAuthorization(input, tx),
      setStatus: (id, status, at, tx) => handles.setAuthorizationStatus(id, status, at, tx),
    },

    captures: {
      findByOrder: (orderId, tx) => handles.findCapturesByOrder(orderId, tx),
      findById: (id, tx) => handles.findCaptureById(id, tx),
      findByPaypalId: (paypalCaptureId, tx) => handles.findCaptureByPaypalId(paypalCaptureId, tx),
      insert: (input, tx) => handles.createCapture(input, tx),
      setStatus: (id, status, at, raw, tx) => handles.setCaptureStatus(id, status, at, raw, tx),
      linkShipment: (id, shipmentId, at, tx) =>
        handles.linkCaptureToShipment(id, shipmentId, at, tx),
      sumForAuthorization: (authorizationId, tx) =>
        handles.sumCapturedForAuthorization(authorizationId, tx),
    },

    refunds: {
      findByCapture: (captureId, tx) => handles.findRefundsByCapture(captureId, tx),
      findById: (id, tx) => handles.findRefundById(id, tx),
      findByPaypalId: (paypalRefundId, tx) => handles.findRefundByPaypalId(paypalRefundId, tx),
      insert: (input, tx) => handles.createRefund(input, tx),
      setStatus: (id, status, paypalRefundId, raw, tx) =>
        handles.setRefundStatus(id, status, paypalRefundId, raw, tx),
      // The repository demands an executor, and the guarded `UPDATE` is the whole point of the method, so
      // the adapter runs it in **its own** transaction. A read-then-write outside one would reintroduce
      // exactly the race the `WHERE` clause exists to close.
      applyToCapture: async (captureId, amount, at, tx) => {
        if (tx) return handles.applyRefundToCapture(captureId, amount, at, tx)
        // `withTx`'s `T` is the inner `Result`, so a business refusal arrives as `ok(ok(false))`. Flattening
        // it here is what keeps the port's contract `Result<CaptureRow, CsError>` rather than a nested
        // envelope every caller would have to unwrap.
        const outer = await handles.withTx((tx) =>
          handles.applyRefundToCapture(captureId, amount, at, tx),
        )
        if (!outer.ok) return outer
        return outer.value
      },
    },

    shipments: {
      findByOrder: (orderId, tx) => handles.findShipmentsByOrder(orderId, tx),
      insert: (input, tx) => handles.createShipment(input, tx),
      setTracker: (id, paypalTrackerId, at, tx) =>
        handles.setShipmentTracker(id, paypalTrackerId, at, tx),
    },

    disputes: {
      openForCapture: (paypalCaptureId, tx) =>
        handles.findOpenDisputeForCapture(paypalCaptureId, tx),
    },

    attempts: {
      setState: (id, state, at, tx) => handles.setAttemptState(id, state, at, tx),
    },
  }
}

/**
 * Run `fn` in a transaction and **abort it on a returned `err`**.
 *
 * `@countersign/db`'s `withTx` commits unless `fn` throws — which is right for a repository and wrong
 * for this: EC-MDT-2's whole mechanism is that the aborted order create leaves nothing behind, and a
 * returned `err(GATE_REVOKED)` would commit an order row for a mandate that is no longer spendable.
 *
 * So the business failure is re-thrown as the `CsError` it already is. `withTx` catches it and maps it
 * through `toRepoError`, which passes a `CsError`-shaped cause through unchanged — the code survives
 * the round trip, and the rollback is explicit rather than a coincidence.
 */
export async function withTxOrAbort<T>(
  store: OrderStore,
  fn: (tx: OrderTx) => Promise<Result<T, CsError>>,
): Promise<Result<T, CsError>> {
  const outer = await store.transaction<CoreResult<T, CsError>>(async (tx) => {
    const inner = await fn(tx)
    // Thrown, not returned: a `ROLLBACK` is what a business refusal needs here, and `withTx` aborts on a
    // throw. `transaction`'s own `Result` therefore arrives as `ok(inner)`, one envelope to unwrap.
    if (!inner.ok) throw inner.error
    return inner
  })
  if (!outer.ok) return outer
  // `outer.value` is the callback's `Result<T, CsError>` — the inner envelope.
  return outer.value
}

/* ============================================================================================ */
/* 2. The budget hooks                                                                             */
/* ============================================================================================ */

/**
 * The three §8.11 ledger movements, on top of `BudgetStore`.
 *
 * Every entry id is **derived from our own ids** (AGENTS.md rule 6, §8.0 rule 6), which is what makes
 * each hook idempotent:
 *
 *  - `COMMIT`/`REVERSE` are keyed by the capture, so re-running the hook for one capture hits the
 *    `budget_entries` primary key instead of spending the buyer's budget twice.
 *  - `RELEASE` is keyed by the attempt — the same id `packages/gate`'s compensation and
 *    `@countersign/ledger`'s 30-minute sweep use, so a void that races the sweep writes one entry
 *    rather than two.
 *
 * The consequence is that "already settled" is a **normal outcome, not an error**. A hook that returned
 * an error there would make a retried job look failed, and the queue would retry it forever.
 */
export function budgetHooksFromStore(budget: BudgetStore): BudgetHooks {
  async function run(
    kind: BudgetHookOutcome['kind'],
    input: BudgetHookInput,
    entryId: string,
  ): Promise<Result<BudgetHookOutcome, CsError>> {
    const result =
      kind === 'COMMIT'
        ? await commitIn(budget, input.mandateId, {
            captureId: input.captureId ?? '',
            amount: input.amount,
            at: input.at,
            entryId,
          })
        : kind === 'REVERSE'
          ? await reverseIn(budget, input.mandateId, {
              captureId: input.captureId ?? '',
              amount: input.amount,
              at: input.at,
              entryId,
            })
          : // `RELEASE` is typed by its own input, so this branch narrows it.
            await releaseIn(
              budget,
              input.mandateId,
              input as BudgetReleaseInput & { entryId: string },
            )

    if (result.ok) {
      return ok({ kind, moved: true, alreadySettled: false, balance: result.value })
    }
    // A unique violation on `budget_entries.id` means this movement already happened. That is the
    // deterministic-id contract working, not a fault.
    if (result.error.code === 'CS_CONFLICT') {
      return ok({ kind, moved: false, alreadySettled: true, balance: null, error: result.error })
    }
    return err(result.error)
  }

  return {
    commit(input) {
      return run(
        'COMMIT',
        input,
        ledgerEntryId({
          kind: 'COMMIT',
          mandateId: input.mandateId,
          captureId: input.captureId,
        }),
      )
    },
    reverse(input) {
      return run(
        'REVERSE',
        input,
        ledgerEntryId({
          kind: 'REVERSE',
          mandateId: input.mandateId,
          captureId: input.captureId,
        }),
      )
    },
    release(input) {
      return run('RELEASE', input, releaseEntryId(input.attemptId, input.mandateId))
    },
  }
}

/* ============================================================================================ */
/* 3. Notifiers                                                                                    */
/* ============================================================================================ */

/** Records every notification. What the EC-CAP-5 tests assert on. */
export interface RecordingNotifier extends Notifier {
  readonly events: OrderNotification[]
  /** Events of one kind, in order. */
  ofKind(kind: OrderNotification['kind']): OrderNotification[]
  clear(): void
}

export function recordingNotifier(): RecordingNotifier {
  const events: OrderNotification[] = []
  return {
    events,
    ofKind: (kind) => events.filter((e) => e.kind === kind),
    clear: () => {
      events.length = 0
    },
    notify(event) {
      events.push(event)
    },
  }
}

/**
 * A notifier that drops everything.
 *
 * The default for a script and for a cron. **Never the default for the web app**: EC-CAP-5 requires the
 * buyer to be told, so the app must pass a real one and the fact that it can be forgotten here is
 * recorded rather than designed around.
 */
export const nullNotifier: Notifier = {
  notify() {
    /* deliberately silent */
  },
}

/* ============================================================================================ */
/* 4. The in-memory OrderStore                                                                     */
/* ============================================================================================ */

/** What {@link createInMemoryOrderWorld} seeds. Every row is a partial: the defaults fill the rest. */
export interface InMemoryOrderWorldSeed {
  readonly nowSec?: number
  readonly decision?: Partial<GateDecisionRow>
  readonly attempt?: Partial<CheckoutAttemptRow>
  readonly mandate?: Partial<MandateRow>
  readonly wallet?: Partial<WalletRow>
  readonly session?: Partial<CheckoutSessionRow>
  readonly products?: readonly Partial<ProductRow>[]
  readonly l1?: Partial<L1Row>
  /** Disputes that are open against a PayPal capture id — EC-REF-4's detection. */
  readonly openDisputes?: readonly Partial<DisputeRow>[]
}

export interface InMemoryOrderWorld {
  readonly store: OrderStore
  /** The live rows, for assertions and for mutation between reads (EC-MDT-2, EC-CAP-5). */
  readonly rows: {
    decisions: Map<string, GateDecisionRow>
    attempts: Map<string, CheckoutAttemptRow>
    mandates: Map<string, MandateRow>
    wallets: Map<string, WalletRow>
    sessions: Map<string, CheckoutSessionRow>
    products: Map<string, ProductRow>
    l1: Map<string, L1Row>
    orders: Map<string, OrderRow>
    authorizations: Map<string, AuthorizationRow>
    captures: Map<string, CaptureRow>
    refunds: Map<string, RefundRow>
    shipments: Map<string, ShipmentRow>
    disputes: Map<string, DisputeRow>
  }
  /** Every insert and update, in order — the cheap way to assert "no row was written". */
  readonly writes: Array<{ table: string; op: 'insert' | 'update'; id: string }>
  /** Rows written inside a transaction that was later rolled back. Always `0` in a correct run. */
  rolledBackWrites(): number
  /** The order row for an attempt, or `undefined`. */
  orderForAttempt(attemptId: AttemptId): OrderRow | undefined
  /** `Σ captures.amount_minor` for an authorization, **excluding** DECLINED and REVERSED. */
  capturedMinor(authorizationId: string): bigint
  /** Flip the seeded mandate. A test uses it between the Gate's read and the orchestrator's re-read. */
  setMandateStatus(status: MandateRow['status']): void
  clearWrites(): void
}

/**
 * `disputes.status` values that mean the case is closed.
 *
 * `RESOLVED` is PayPal's own terminal state. **`CANCELED` is not in our enum** — `dispute_status` has six
 * values (`OPEN`, `WAITING_FOR_BUYER_RESPONSE`, `WAITING_FOR_SELLER_RESPONSE`, `UNDER_REVIEW`, `RESOLVED`,
 * `OTHER`) and PayPal's `CANCELED` is folded into `OTHER` by the ingest path, which is why EC-REF-4's
 * "an open dispute" test has to treat `OTHER` as terminal too. A direct refund against a cancelled case is
 * exactly what EC-REF-4 exists to prevent, so failing closed here is the right direction even if the
 * mapping is lossy.
 */
const TERMINAL_DISPUTE_STATUSES: ReadonlySet<DisputeRow['status']> = new Set<DisputeRow['status']>([
  'RESOLVED',
  'OTHER',
])

/**
 * A PayPal body as a `jsonb` value.
 *
 * `JSON.parse(JSON.stringify(x))` is the honest conversion for a body that arrived as JSON, and it is also
 * the step that would fail loudly if PayPal ever sent something a `jsonb` column cannot hold. It lives here
 * rather than in `create.ts` because three modules write `raw` and it must be one definition.
 */
export function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

/** A deterministic 26-character body from a canonical-JSON preimage. */
function derivedId(prefix: string, preimage: unknown): string {
  const digest = createHash('sha256').update(canonicalJson(preimage), 'utf8').digest('hex')
  return `${prefix}_${digest.slice(0, 26)}`
}

/**
 * An in-memory `OrderStore`.
 *
 * Exists so AT-M11.1 through AT-M11.6 — a split capture, a void, three refunds, an over-refund refused
 * before any HTTP request, an idempotent create, a decline — run on every commit with **no Postgres and
 * no PayPal credentials**. The money arithmetic those tests are about is integer `bigint` work; making it
 * depend on a running database would make it rarer, not stronger.
 *
 * What it models, and why each one is load-bearing, is in the module header. What it deliberately does
 * **not** model: `FOR UPDATE` on the budget (that is `createInMemoryBudgetStore` from
 * `@countersign/gate`, used through {@link budgetHooksFromStore} so the real `commitIn`/`releaseIn`
 * arithmetic runs), and anything about PayPal.
 */
export function createInMemoryOrderWorld(seed: InMemoryOrderWorldSeed = {}): InMemoryOrderWorld {
  const nowSec = seed.nowSec ?? 1_760_000_000
  const at = new Date(nowSec * 1000)

  const attemptId = (seed.attempt?.id ?? 'att_00000000000000000000000001') as AttemptId
  const mandateId = (seed.mandate?.id ?? 'mdt_00000000000000000000000001') as MandateId
  const walletId = (seed.wallet?.id ?? 'wal_00000000000000000000000001') as
    | `wal_${string}`
    | undefined
  const sessionId = (seed.session?.id ?? 'chk_00000000000000000000000001') as
    | `chk_${string}`
    | undefined
  const decisionId = (seed.decision?.id ?? 'gdc_00000000000000000000000001') as
    | `gdc_${string}`
    | undefined
  const deviceId = (seed.mandate?.device_id ?? 'dev_00000000000000000000000001') as string
  const resolvedWalletId = (walletId ?? 'wal_00000000000000000000000001') as `wal_${string}`
  const resolvedSessionId = (sessionId ?? 'chk_00000000000000000000000001') as `chk_${string}`
  const resolvedDecisionId = (decisionId ?? 'gdc_00000000000000000000000001') as `gdc_${string}`

  const products = new Map<string, ProductRow>(
    (
      seed.products ?? [
        { sku: 'NW-001', title: 'Trail Runner', price_minor: 6_000n, digital: false },
      ]
    ).map((p) => {
      const row: ProductRow = {
        sku: p.sku ?? 'NW-001',
        title: p.title ?? 'Trail Runner',
        description: p.description ?? 'A shoe.',
        price_minor: p.price_minor ?? 6_000n,
        currency: p.currency ?? 'USD',
        stock: p.stock ?? 10,
        ships_in_days: p.ships_in_days ?? 2,
        digital: p.digital ?? false,
        listing_html: p.listing_html ?? '<p>A shoe.</p>',
        created_at: at,
        updated_at: at,
      }
      return [row.sku, row]
    }),
  )

  // The cart is the allocation basis, so the default session is built from the seeded products: one line
  // per product, quantity 1, plus a flat shipping fee. A test that wants a two-shipment split says so
  // with `session.cart`.
  const defaultLines = [...products.values()].map((p) => ({
    sku: p.sku,
    qty: 1,
    unit_minor: p.price_minor,
  }))
  const cartLines =
    (seed.session?.cart as { lines?: typeof defaultLines } | undefined)?.lines ?? defaultLines
  const subtotal = cartLines.reduce((acc, l) => acc + l.unit_minor * BigInt(l.qty), 0n)
  const shipping = seed.session?.shipping_minor ?? 500n
  const tax = seed.session?.tax_minor ?? 0n

  const session: CheckoutSessionRow = {
    id: resolvedSessionId,
    merchant_id: 'MERCHANT_NORTHWIND',
    cart: { lines: cartLines },
    subtotal_minor: seed.session?.subtotal_minor ?? subtotal,
    tax_minor: tax,
    shipping_minor: shipping,
    total_minor: seed.session?.total_minor ?? subtotal + tax + shipping,
    currency: seed.session?.currency ?? 'USD',
    checkout_jwt: seed.session?.checkout_jwt ?? 'eyJhbGciOiJFZERTQSJ9.eyJzdW0iOjEwfQ.sig',
    checkout_hash: seed.session?.checkout_hash ?? 'checkout-hash-1',
    price_lock_exp: seed.session?.price_lock_exp ?? new Date((nowSec + 900) * 1000),
    status: 'SUBMITTED',
    created_at: at,
    updated_at: at,
    ...seed.session,
  } as CheckoutSessionRow

  const mandate: MandateRow = {
    id: mandateId,
    user_id: 'usr_00000000000000000000000001',
    device_id: deviceId,
    agent_id: 'agt_00000000000000000000000001',
    wallet_id: resolvedWalletId,
    l2_serialized: 'l2-serialized-sd-jwt',
    l2_payload: {},
    nl_intent: 'Buy running shoes up to $130.00 at Northwind',
    readback: 'Spend at most $130.00 at Northwind Outfitters',
    constraints: [],
    nonce: 'nonce-1',
    aud: 'https://merchant.example',
    iat: BigInt(nowSec - 3_600),
    exp: BigInt(nowSec + 86_400),
    status: 'ACTIVE',
    revoked_at: null,
    revoked_reason: null,
    webauthn_assertion: null,
    compiler_model: 'gpt-6.1-sol',
    compiler_trace_id: null,
    created_at: at,
    updated_at: at,
    ...seed.mandate,
  } as MandateRow

  const wallet: WalletRow = {
    id: resolvedWalletId,
    user_id: mandate.user_id,
    payment_token_id: '5TY05013RG002845M',
    payer_id: 'PAYER9DX42987Y',
    payer_email: 'buyer@example.com',
    status: 'ACTIVE',
    customer_id: 'CUSTOMER-9WB781254L9893217',
    raw: null,
    fetched_at: null,
    created_at: at,
    updated_at: at,
    ...seed.wallet,
  } as WalletRow

  const attempt: CheckoutAttemptRow = {
    id: attemptId,
    mandate_id: mandateId,
    agent_id: mandate.agent_id,
    checkout_session_id: resolvedSessionId,
    l3a: 'eyJhbGciOiJFZERTQSJ9.eyJqdGkiOiJhdHRfMSJ9.sig',
    l3b: 'eyJhbGciOiJFZERTQSJ9.eyJjaGVja291dF9oYXNoIjoiMSJ9.sig',
    l3_jti: 'jti-attempt-1',
    idempotency_key: 'idem-attempt-1',
    amount_minor: seed.attempt?.amount_minor ?? session.total_minor,
    currency: seed.attempt?.currency ?? session.currency,
    payee: seed.attempt?.payee ?? '9KX436DUC84BN',
    state: 'GATED_ALLOW',
    gate_decision_id: resolvedDecisionId,
    created_at: at,
    updated_at: at,
    ...seed.attempt,
  } as CheckoutAttemptRow

  const decision: GateDecisionRow = {
    id: resolvedDecisionId,
    attempt_id: attemptId,
    decision: 'ALLOW',
    reasons: [],
    checks: [],
    chain_valid: true,
    vi_lib_commit: '356c29635f1c44df7de02edb58699ca9f29bece6',
    signed_record: 'eyJhbGciOiJFZERTQSJ9.eyJna2MiOiJnZGMiLCJhdHQiOiJhdHRfMSJ9.sig',
    decided_at: at,
    budget_version: 1,
    created_at: at,
    updated_at: at,
    ...seed.decision,
  } as GateDecisionRow

  const l1: L1Row = {
    id: 'l1_00000000000000000000000001',
    user_id: mandate.user_id,
    device_id: deviceId,
    wallet_id: resolvedWalletId,
    sd_jwt: 'l1-sd-jwt-serialized',
    issuer_kid: 'vi-issuer-1',
    iat: BigInt(nowSec - 7_200),
    exp: BigInt(nowSec + 86_400),
    status: 'ACTIVE',
    created_at: at,
    updated_at: at,
    ...seed.l1,
  } as L1Row

  const rows: InMemoryOrderWorld['rows'] = {
    decisions: new Map([[decision.id, decision]]),
    attempts: new Map([[attempt.id, attempt]]),
    mandates: new Map([[mandate.id, mandate]]),
    wallets: new Map([[wallet.id, wallet]]),
    sessions: new Map([[session.id, session]]),
    products,
    l1: new Map([[l1.id, l1]]),
    orders: new Map(),
    authorizations: new Map(),
    captures: new Map(),
    refunds: new Map(),
    shipments: new Map(),
    disputes: new Map(
      (seed.openDisputes ?? []).map((d, i) => {
        const row = {
          id: `dsp_0000000000000000000000000${i + 1}`,
          paypal_dispute_id: 'PP-D-2781AB12CD34',
          order_id: null,
          capture_id: null,
          status: 'WAITING_FOR_SELLER_RESPONSE',
          defense_state: 'NEEDS_EVIDENCE',
          liability: null,
          seller_response_due_date: new Date((nowSec + 604_800) * 1000),
          buyer_response_due_date: new Date((nowSec + 1_209_600) * 1000),
          raw: null,
          router_trace: {},
          ...d,
        } as unknown as DisputeRow
        return [row.id, row]
      }),
    ),
  }

  const writes: Array<{ table: string; op: 'insert' | 'update'; id: string }> = []
  /** Written inside the transaction that is currently open; cleared by a rollback. */
  let pendingWrites: Array<{ table: string; op: 'insert' | 'update'; id: string }> = []

  function record(table: string, op: 'insert' | 'update', id: string): void {
    writes.push({ table, op, id })
    pendingWrites.push({ table, op, id })
  }

  function uniqueViolation(constraint: string, id: string, table: string): CsError {
    return csError('CS_CONFLICT', `Duplicate rejected by unique constraint ${constraint}`, {
      table,
      id,
      pgCode: '23505',
      constraint,
    })
  }

  function notFound(table: string, id: string): CsError {
    return csError('CS_NOT_FOUND', `No ${table} row for ${id}`, { table, id })
  }

  /**
   * A copy of every mutable table, for a transaction stand-in's `ROLLBACK`.
   *
   * Shallow copies of the rows, which is enough: a row's fields are primitives, a `Date`, a `bigint` or
   * a `jsonb` blob that is only ever **replaced**, never mutated in place. So `{...row}` is a snapshot
   * that no later write can reach through.
   */
  function snapshot(): Map<string, unknown>[] {
    return [
      rows.orders,
      rows.authorizations,
      rows.captures,
      rows.refunds,
      rows.shipments,
      rows.attempts,
    ].map((map) => new Map([...map].map(([k, v]) => [k, { ...v }])))
  }

  function restore(saved: Map<string, unknown>[]): void {
    const maps = [
      rows.orders,
      rows.authorizations,
      rows.captures,
      rows.refunds,
      rows.shipments,
      rows.attempts,
    ]
    maps.forEach((map, i) => {
      map.clear()
      for (const [k, v] of saved[i] ?? []) map.set(k, v as never)
    })
  }

  let transactionTail: Promise<void> = Promise.resolve()
  const store: OrderStore = {
    async transaction<T>(fn: (tx: OrderTx) => Promise<T>): Promise<Result<T, CsError>> {
      const previous = transactionTail
      let release: () => void = () => {}
      transactionTail = new Promise<void>((resolve) => {
        release = resolve
      })
      await previous
      const saved = snapshot()
      const savedWrites = writes.length
      pendingWrites = []
      try {
        const value = await fn({} as OrderTx)
        return ok(value)
      } catch (cause) {
        // ROLLBACK undoes the writes, not merely the locks — and the write log is corrected to match,
        // so `rolledBackWrites()` and the log a test reads agree with what a database would hold.
        const discarded = pendingWrites.length
        rolledBackTotal += discarded
        writes.length = savedWrites
        restore(saved)
        return err(
          typeof cause === 'object' && cause !== null && 'code' in cause && 'message' in cause
            ? (cause as CsError)
            : csError('CS_INTERNAL', 'transaction aborted', { cause: String(cause) }),
        )
      } finally {
        release()
        pendingWrites = []
      }
    },

    async gateDecision(id) {
      return ok(rows.decisions.get(id))
    },
    async attempt(id) {
      return ok(rows.attempts.get(id))
    },
    async mandate(id) {
      return ok(rows.mandates.get(id))
    },
    async lockMandate(id) {
      // The row is returned live, not a copy: EC-MDT-2's test flips `status` between the Gate's read and
      // this one, and a copy taken at seed time would make the whole scenario untestable.
      return ok(rows.mandates.get(id))
    },
    async wallet(id) {
      return ok(rows.wallets.get(id))
    },
    async checkoutSession(id) {
      return ok(rows.sessions.get(id))
    },
    async l1Credential(deviceId, walletId) {
      for (const row of rows.l1.values()) {
        if (row.device_id === deviceId && row.wallet_id === walletId) return ok(row)
      }
      return ok(undefined)
    },
    async products(skus) {
      return ok([...rows.products.values()].filter((p) => skus.includes(p.sku)))
    },

    orders: {
      async findByAttempt(attemptId) {
        for (const row of rows.orders.values()) {
          if (row.attempt_id === attemptId) return ok(row)
        }
        return ok(undefined)
      },
      async findById(id) {
        return ok(rows.orders.get(id))
      },
      async insert(input) {
        if (rows.orders.has(input.id)) {
          return err(uniqueViolation('orders_pkey', input.id, 'orders'))
        }
        for (const row of rows.orders.values()) {
          // `orders_attempt_id_key` is AT-M11.5's idempotency backstop: a duplicate create is refused
          // by the database, not by a read-then-write check with a window in it.
          if (row.attempt_id === input.attempt_id) {
            return err(uniqueViolation('orders_attempt_id_key', input.id, 'orders'))
          }
          if (row.paypal_order_id === input.paypal_order_id) {
            return err(uniqueViolation('orders_paypal_order_id_key', input.id, 'orders'))
          }
        }
        const row = { ...input } as unknown as OrderRow
        rows.orders.set(row.id, row)
        record('orders', 'insert', row.id)
        return ok(row)
      },
      async setStatus(id, status, at2) {
        const row = rows.orders.get(id)
        if (!row) return err(notFound('orders', id))
        const next = { ...row, status, updated_at: at2 }
        rows.orders.set(id, next)
        record('orders', 'update', id)
        return ok(next)
      },
      async recordFetched(id, raw, at2) {
        const row = rows.orders.get(id)
        if (!row) return err(notFound('orders', id))
        const next = { ...row, raw, fetched_at: at2, updated_at: at2 }
        rows.orders.set(id, next)
        record('orders', 'update', id)
        return ok(next)
      },
    },

    authorizations: {
      async findByOrder(orderId) {
        return ok([...rows.authorizations.values()].filter((r) => r.order_id === orderId))
      },
      async findById(id) {
        return ok(rows.authorizations.get(id))
      },
      async insert(input) {
        if (rows.authorizations.has(input.id)) {
          return err(uniqueViolation('authorizations_pkey', input.id, 'authorizations'))
        }
        const row = { ...input } as unknown as AuthorizationRow
        rows.authorizations.set(row.id, row)
        record('authorizations', 'insert', row.id)
        return ok(row)
      },
      async setStatus(id, status, at2) {
        const row = rows.authorizations.get(id)
        if (!row) return err(notFound('authorizations', id))
        const next = { ...row, status, updated_at: at2 }
        rows.authorizations.set(id, next)
        record('authorizations', 'update', id)
        return ok(next)
      },
    },

    captures: {
      async findByOrder(orderId) {
        return ok(
          [...rows.captures.values()]
            .filter((r) => r.order_id === orderId)
            .sort((a, b) => a.created_at.getTime() - b.created_at.getTime()),
        )
      },
      async findById(id) {
        return ok(rows.captures.get(id))
      },
      async findByPaypalId(paypalCaptureId) {
        for (const row of rows.captures.values()) {
          if (row.paypal_capture_id === paypalCaptureId) return ok(row)
        }
        return ok(undefined)
      },
      async insert(input) {
        if (rows.captures.has(input.id)) {
          return err(uniqueViolation('captures_pkey', input.id, 'captures'))
        }
        for (const row of rows.captures.values()) {
          if (row.paypal_capture_id === input.paypal_capture_id) {
            return err(uniqueViolation('captures_paypal_capture_id_key', input.id, 'captures'))
          }
        }
        const row = {
          refunded_minor: 0n,
          reversed: false,
          raw: null,
          fetched_at: null,
          ...input,
        } as unknown as CaptureRow
        rows.captures.set(row.id, row)
        record('captures', 'insert', row.id)
        return ok(row)
      },
      async setStatus(id, status, at2, raw) {
        const row = rows.captures.get(id)
        if (!row) return err(notFound('captures', id))
        const next = {
          ...row,
          status,
          updated_at: at2,
          ...(raw !== undefined ? { raw, fetched_at: at2 } : {}),
        }
        rows.captures.set(id, next)
        record('captures', 'update', id)
        return ok(next)
      },
      async linkShipment(id, shipmentId, at2) {
        const row = rows.captures.get(id)
        if (!row) return err(notFound('captures', id))
        const next = { ...row, shipment_id: shipmentId, updated_at: at2 }
        rows.captures.set(id, next)
        record('captures', 'update', id)
        return ok(next)
      },
      async sumForAuthorization(authorizationId) {
        let total = 0n
        for (const row of rows.captures.values()) {
          if (row.authorization_id === authorizationId) total += row.amount_minor
        }
        return ok(total)
      },
    },

    refunds: {
      async findByCapture(captureId) {
        return ok(
          [...rows.refunds.values()]
            .filter((r) => r.capture_id === captureId)
            .sort((a, b) => a.created_at.getTime() - b.created_at.getTime()),
        )
      },
      async findById(id) {
        return ok(rows.refunds.get(id))
      },
      async findByPaypalId(paypalRefundId) {
        for (const row of rows.refunds.values()) {
          if (row.paypal_refund_id === paypalRefundId) return ok(row)
        }
        return ok(undefined)
      },
      async insert(input) {
        if (rows.refunds.has(input.id)) {
          return err(uniqueViolation('refunds_pkey', input.id, 'refunds'))
        }
        const row = { ...input } as unknown as RefundRow
        rows.refunds.set(row.id, row)
        record('refunds', 'insert', row.id)
        return ok(row)
      },
      async setStatus(id, status, paypalRefundId, raw) {
        const row = rows.refunds.get(id)
        if (!row) return err(notFound('refunds', id))
        const next = {
          ...row,
          status,
          paypal_refund_id: paypalRefundId,
          updated_at: at,
          ...(raw !== undefined ? { raw, fetched_at: at } : {}),
        }
        rows.refunds.set(id, next)
        record('refunds', 'update', id)
        return ok(next)
      },
      async applyToCapture(captureId, amount, at2) {
        const row = rows.captures.get(captureId)
        if (!row) return err(notFound('captures', captureId))
        // The guard clause, not a boolean: `refunded_minor + amount <= amount_minor` is the same
        // predicate as the SQL `WHERE`, so a race between two refunds is refused by arithmetic.
        if (row.refunded_minor + amount.minor > row.amount_minor) {
          const remaining = row.amount_minor - row.refunded_minor
          return err(
            csError(
              'CS_VALIDATION',
              `Refund of ${amount.minor} exceeds the refundable remainder of capture ${captureId}`,
              {
                table: 'captures',
                captureId,
                requestedMinor: amount.minor.toString(),
                remainingMinor: (remaining < 0n ? 0n : remaining).toString(),
              },
              { userMessage: `Only ${remaining} remains refundable.` },
            ),
          )
        }
        const next = {
          ...row,
          refunded_minor: row.refunded_minor + amount.minor,
          updated_at: at2,
        }
        rows.captures.set(captureId, next)
        record('captures', 'update', captureId)
        return ok(next)
      },
    },

    shipments: {
      async findByOrder(orderId) {
        return ok(
          [...rows.shipments.values()]
            .filter((r) => r.order_id === orderId)
            .sort((a, b) => a.created_at.getTime() - b.created_at.getTime()),
        )
      },
      async insert(input) {
        for (const row of rows.shipments.values()) {
          if (row.tracking_number === input.tracking_number) {
            return err(uniqueViolation('shipments_tracking_number_key', input.id, 'shipments'))
          }
        }
        const row = {
          paypal_tracker_id: null,
          raw: null,
          fetched_at: null,
          ...input,
        } as unknown as ShipmentRow
        rows.shipments.set(row.id, row)
        record('shipments', 'insert', row.id)
        return ok(row)
      },
      async setTracker(id, paypalTrackerId, at2) {
        const row = rows.shipments.get(id)
        if (!row) return err(notFound('shipments', id))
        const next = {
          ...row,
          paypal_tracker_id: paypalTrackerId,
          fetched_at: at2,
          updated_at: at2,
        }
        rows.shipments.set(id, next)
        record('shipments', 'update', id)
        return ok(next)
      },
    },

    disputes: {
      async openForCapture(paypalCaptureId) {
        // `disputes.capture_id` is a foreign key to **`captures.id`** (`schema.ts`: `.references(() =>
        // captures.id)`) — our `cap_…` row id, not PayPal's `3C679366HH908993F`. So the PayPal id the port is
        // asked about has to be resolved through the capture row first. Comparing the two directly would
        // return "no dispute" for **every** capture, which is the exact failure EC-REF-4 exists to prevent:
        // a refund would go straight out while a case is open, and the merchant would lose the adjudication
        // they had a chance at. The production handle `findOpenDisputeForCapture` must join the same way.
        const capture = [...rows.captures.values()].find(
          (c) => c.paypal_capture_id === paypalCaptureId,
        )
        if (!capture) return ok(undefined)
        for (const row of rows.disputes.values()) {
          if (TERMINAL_DISPUTE_STATUSES.has(row.status)) continue
          if (row.capture_id === capture.id) return ok(row)
        }
        return ok(undefined)
      },
    },

    attempts: {
      async setState(id, state, at2) {
        const row = rows.attempts.get(id)
        if (!row) return err(notFound('checkout_attempts', id))
        const next = { ...row, state, updated_at: at2 }
        rows.attempts.set(id, next)
        record('checkout_attempts', 'update', id)
        return ok(next)
      },
    },
  }

  let rolledBackTotal = 0

  const world: InMemoryOrderWorld = {
    store,
    rows,
    writes,
    rolledBackWrites: () => rolledBackTotal,
    orderForAttempt: (id) => {
      for (const row of rows.orders.values()) {
        if (row.attempt_id === id) return row
      }
      return undefined
    },
    capturedMinor: (authorizationId) => {
      let total = 0n
      for (const row of rows.captures.values()) {
        if (row.authorization_id !== authorizationId) continue
        // DECLINED and REVERSED took no money, so they are not part of the sum. See `capture.ts`.
        if (row.status === 'DECLINED' || row.status === 'REVERSED') continue
        total += row.amount_minor
      }
      return total
    },
    setMandateStatus: (status) => {
      mandate.status = status
    },
    clearWrites: () => {
      writes.length = 0
      rolledBackTotal = 0
    },
  }
  return world
}

/**
 * Deterministic ids for the rows the orchestrator creates before or during a PayPal call.
 *
 * Every one is `sha256(canonicalJson(scope))` truncated to 26 characters, which is the same construction
 * `@countersign/ledger` uses for `budget_entries.id`. The property that matters is **idempotency**: a
 * retried `createOrderFromDecision` / `captureShipment` / `refund` derives the identical id, so the
 * insert hits the primary key and the `PayPal-Request-Id` is byte-identical to the first attempt's
 * ([B14], EC-IDEM-2). A random id would make every retry a second row.
 */
export const deterministicIds = {
  /** `ord_…` for an attempt. One order per attempt — `orders_attempt_id_key` says so too. */
  order: (attemptId: AttemptId): string => derivedId('ord', { kind: 'order', attemptId }),
  /**
   * `aut_…` for an order's authorization. Keyed by the **PayPal** authorization id, because a PayPal
   * authorization id identifies exactly one authorization and a second row for it would be a mirror bug.
   */
  authorization: (orderId: string, paypalAuthorizationId: string): string =>
    derivedId('aut', { kind: 'authorization', orderId, paypalAuthorizationId }),
  /** `shp_…` for one shipment of one order. Content-addressed, so a retry is the same shipment. */
  shipment: (orderId: string, carrier: string, tracking: string, lines: unknown): string =>
    derivedId('shp', { kind: 'shipment', orderId, carrier, tracking, lines }),
  /** `cap_…` for the capture of one shipment against one authorization. */
  capture: (orderId: string, authorizationId: string, shipmentId: string): string =>
    derivedId('cap', { kind: 'capture', orderId, authorizationId, shipmentId }),
  /**
   * `ref_…` for one refund **request**.
   *
   * Keyed by the caller's idempotency key when there is one (EC-IDEM-5's "form nonce": a double-clicked
   * Refund button is one refund), and by a fresh ULID when there is not — because two legitimate
   * identical partial refunds must both be allowed (EC-IDEM-6), and no function of
   * (capture, amount) could tell those apart from a double-click.
   */
  refund: (idempotencyKey: string | undefined, nowMs: number): string =>
    idempotencyKey === undefined
      ? newId('ref', nowMs)
      : derivedId('ref', { kind: 'refund', idempotencyKey }),
  /**
   * `ref_…` for EC-REF-3's retry of a FAILED refund.
   *
   * Keyed by the **failed refund's id**, which is the rule the spec states in one sentence: "retry once
   * after 1 h with a **new** refund ID, never reuse a failed refund's request ID with a different body."
   * Deterministic, so retrying the retry is still one retry; and necessarily different from the
   * parent's, so `cs:{capture}:ref:{id}` differs.
   */
  refundRetry: (captureId: string, failedRefundId: string): string =>
    derivedId('ref', { kind: 'refund-retry', captureId, failedRefundId }),
} as const

/** Re-exported so a caller building a `Notifier` needs one import. */
export type { OrderNotification }
