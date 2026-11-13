import 'server-only'

/**
 * The orders composition root — the call site `packages/orders` has never had in `apps/web`.
 *
 * ## Why this file exists
 *
 * `defenderRefundsFromOrders(orders, paypal)` is the **only** correct refund adapter for a `REFUND`
 * posture: EC-REF-4 says a dispute refund goes through the case (`accept-claim`), never through
 * `/captures/{id}/refund`, and `refundViaDispute` owns the parts that make that correct — the durable
 * reservation, the live read-back, the `refunds` row and the `captures.refunded_minor` bump. §8.15 makes
 * the click a merchant act on the web tier, so the web process is where that adapter has to be built.
 *
 * It takes a full {@link OrdersDeps}, which is why this file is a rename-and-forward over
 * `orderStoreFromRepos` rather than a hand-built object: the port's ~40 members are all repositories, and
 * a second map over them is exactly the drift AGENTS.md rule 8 forbids.
 *
 * ## What it deliberately does not decide
 *
 * Nothing. There is no policy here — no refund amount, no eligibility rule, no status transition. The
 * decisions live in `packages/orders` and the guards live in SQL. This file's whole job is to hand the
 * package the repositories it names and one clock.
 *
 * ## The three members that are not repositories
 *
 * - **`notify`** is `nullNotifier`. `packages/orders` ships it as the documented default for exactly this
 *   gap (`docs/contract-issues.md`, gap #2): there is no production notifier, and EC-CAP-5 requires the
 *   web app to pass a real one. A refund is a money movement, not a notification, so `refundViaDispute`
 *   never reads it — but the port is closed, so a member has to be there and this is the honest one.
 * - **`budget`** is `budgetHooksFromStore(drizzleStore())`. `refundViaDispute` does **not** move the
 *   ledger (a refund does not return authority, §8.11), so these hooks are wired for completeness rather
 *   than for this call path — and they are the same implementation the Gate's budget store uses.
 * - **`clock`** is `systemClock`. §8.0 rule 10: one clock, everywhere, and never `Date.now()` at a call
 *   site.
 */
import { csError, err, ok, systemClock, type CsError, type Result } from '@countersign/core'
import * as repository from '@countersign/db'
import { drizzleStore, withTx } from '@countersign/db'
import {
  budgetHooksFromStore,
  defineOrderDeps,
  nullNotifier,
  orderStoreFromRepos,
  type OrderRepoHandles,
  type OrdersDeps,
} from '@countersign/orders'
import { PayPalClient } from '@countersign/paypal'

import { resolvePaypalBase } from './paypal-base'

/** The PayPal calls `packages/orders` makes. The real client satisfies it structurally. */
export type OrdersPayPal = OrdersDeps['paypal']

/**
 * Bind `packages/orders` to `@countersign/db`'s repositories.
 *
 * `paypal` is passed in rather than constructed, so the orders half and the dispute half of a request
 * share one token cache and one throttle domain — the same reason `apps/worker` builds one client per
 * process.
 */
export function ordersRuntime(paypal: OrdersPayPal): OrdersDeps {
  return defineOrderDeps({
    clock: systemClock,
    paypal,
    store: orderStoreFromRepos(orderRepoHandles()),
    budget: budgetHooksFromStore(drizzleStore()),
    // No production notifier exists (contract issue, gap #2). `refundViaDispute` never reads it; a real
    // one is EC-CAP-5's job and belongs to whoever owns notification copy.
    notify: nullNotifier,
  })
}

/**
 * The `@countersign/db` handles `orderStoreFromRepos` names.
 *
 * Every member is a direct reference to a repository function — no wrappers, no `async` arrows — so the
 * executor each one takes is the executor the caller passed, all the way down to the `FOR UPDATE` that
 * makes the reservation safe. Wrapping them would be where a forgotten `tx` hides.
 */
function orderRepoHandles(): OrderRepoHandles {
  // Several repositories narrow their id to a branded type (`ord_…`, `wal_…`) while the port is handed a
  // plain `string` — the same boundary `dbDefenderStore` crosses with the same cast. The cast is safe
  // because the id reaches the repository from a row that was written with that prefix; a `string` that
  // is not one simply matches no row, which is the answer the port wants.
  return {
    withTx,

    findGateDecisionById: (id, exec) =>
      repository.findGateDecisionById(id as `gdc_${string}`, exec),
    findAttemptById: repository.findAttemptById,
    findMandateById: repository.findMandateById,
    lockMandateForUpdate: repository.lockMandateForUpdate,
    findWalletById: (id, exec) => repository.findWalletById(id as `wal_${string}`, exec),
    findCheckoutSessionById: (id, exec) =>
      repository.findCheckoutSessionById(id as `chk_${string}`, exec),
    findL1Credential: repository.findL1ForDeviceWallet,
    findProductsBySku: repository.findProductsBySku,

    findOrderByAttempt: repository.findOrderByAttempt,
    findOrderById: (id, exec) => repository.findOrderById(id as `ord_${string}`, exec),
    createOrder: repository.createOrder,
    setOrderStatus: (id, status, at, exec) =>
      repository.setOrderStatus(id as `ord_${string}`, status, at, exec),
    recordFetchedOrder: (id, raw, at, exec) =>
      repository.recordFetchedOrder(id as `ord_${string}`, raw, at, exec),

    findAuthorizationsByOrder: (orderId, exec) =>
      repository.findAuthorizationsByOrder(orderId as `ord_${string}`, exec),
    findAuthorizationById: repository.findAuthorizationById,
    createAuthorization: repository.createAuthorization,
    setAuthorizationStatus: repository.setAuthorizationStatus,

    findCapturesByOrder: (orderId, exec) =>
      repository.findCapturesByOrder(orderId as `ord_${string}`, exec),
    findCaptureById: repository.findCaptureById,
    findCaptureByPaypalId: repository.findCaptureByPaypalId,
    createCapture: repository.createCapture,
    setCaptureStatus: repository.setCaptureStatus,
    linkCaptureToShipment: repository.linkCaptureToShipment,
    sumCapturedForAuthorization: repository.sumCapturedForAuthorization,

    findRefundsByCapture: repository.findRefundsByCapture,
    findRefundByPaypalId: repository.findRefundByPaypalId,
    findRefundById: repository.findRefundById,
    createRefund: repository.createRefund,
    setRefundStatus: repository.setRefundStatus,
    applyRefundToCapture: repository.applyRefundToCapture,

    findShipmentsByOrder: (orderId, exec) =>
      repository.findShipmentsByOrder(orderId as `ord_${string}`, exec),
    createShipment: repository.createShipment,
    setShipmentTracker: repository.setShipmentTracker,
    findShipmentByTracking: repository.findShipmentByTracking,

    findOpenDisputeForCapture: repository.findOpenDisputeForCapture,

    setAttemptState: repository.setAttemptState,
  }
}

/**
 * The one PayPal client the web tier uses for money and disputes.
 *
 * Built from `lib/paypal-base.ts`'s resolver rather than an ad hoc `process.env` read, so the health page
 * and the money path agree about whether PayPal is configured (the D-040 defect class), and a missing
 * client id is one `CsError` naming the variable instead of an opaque 401 from PayPal at the first refund.
 */
export function paypalClient(
  env: Record<string, string | undefined> = process.env,
): Result<PayPalClient, CsError> {
  const id = env['PAYPAL_CLIENT_ID']?.trim() ?? ''
  const secret = env['PAYPAL_CLIENT_SECRET']?.trim() ?? ''
  const missing = [
    ...(id === '' ? ['PAYPAL_CLIENT_ID'] : []),
    ...(secret === '' ? ['PAYPAL_CLIENT_SECRET'] : []),
  ]
  if (missing.length > 0) {
    return err(
      csError(
        'CS_INTERNAL',
        `PayPal is not configured: ${missing.join(', ')} unset`,
        { missing },
        {
          userMessage:
            'Filing or refunding a dispute needs PayPal credentials, and this deployment has none.',
          retryable: false,
        },
      ),
    )
  }
  return ok(
    new PayPalClient({
      baseUrl: resolvePaypalBase(env),
      clientId: id,
      clientSecret: secret,
      clock: systemClock,
    }),
  )
}
