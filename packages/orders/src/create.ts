/**
 * Order creation — spec **§8.11** (`createOrderFromDecision`), **D17**, **D18**, §7.3, §10.2 rows 5–6,
 * §12 **EC-MDT-2**, **EC-IDEM-2**, and week-1 check **C2** (spec U2).
 *
 * ## Three decisions this file makes, and why each one is a decision
 *
 * ### 1. `intent` comes from the cart, not from the caller (D17)
 *
 * `AUTHORIZE` for physical goods, `CAPTURE` for digital ones, and a mixed cart is `AUTHORIZE`. The rule
 * is in {@link intentForLines} and it is the reason D17 was chosen: with `AUTHORIZE`, a line that goes
 * out of stock mid-fulfilment becomes a **void** of the remainder (EC-STOCK-1), which PayPal supports and
 * which leaves an honest trail. With `CAPTURE` the same event becomes a **refund** (EC-STOCK-2), which is
 * worse for the buyer and worse for the evidence.
 *
 * ### 2. The authorization may arrive inline, and which way it arrived is recorded (C2)
 *
 * The audit (`docs/verification/paypal-api-2026-10-04.md` §17, spec U2) found that
 * `POST /v2/checkout/orders` with `payment_source.paypal.vault_id` and `intent: AUTHORIZE` answers `201`
 * with the authorization **inline** at `purchase_units[].payments.authorizations[]` — single-shot, no buyer
 * present. The spec still says to fall back to `POST /v2/checkout/orders/{id}/authorize` if it is absent,
 * and PayPal documents both routes without ever stating the exclusivity rule.
 *
 * So both branches are implemented, in that order, and **which one ran is written into `orders.raw` and
 * logged** ({@link AuthorizationPath}). That is not bookkeeping for its own sake: C2's open question is
 * exactly this, and the answer has to come from evidence the nightly sandbox run collects rather than from
 * an assumption baked into one branch.
 *
 * ### 3. `custom_id` is a hash of the evidence bundle, and the bundle is canonical (D18)
 *
 * ```
 * custom_id = "cs1:" + base64url(sha256(JCS(bundle without paypal/shipments)))
 * ```
 *
 * 4 + 43 = 47 characters, inside PayPal's 1–255 ([V11]), and it is the only string that ties a PayPal
 * transaction to the signed chain **inside PayPal's own records** — which is what makes the claim checkable
 * by a judge who has the PayPal dashboard and nothing else.
 *
 * Two members are excluded, and §7.3 says why: `paypal` and `shipments` are only knowable *after* the
 * order exists, so including them would make the hash depend on the very thing it is stamped onto. Every
 * other member is in, which is why {@link EVIDENCE_BUNDLE_HASHED_MEMBERS} is exported: a verifier needs the
 * member list exactly, and a list that lives only in a comment is a list that drifts.
 *
 * ## EC-MDT-2, and the transaction that is not a transaction
 *
 * The spec requires the orchestrator to "re-read mandate status in the same tx as order creation" and abort
 * with the reservation released. There are **two** such reads here, and the second is the one that matters:
 *
 *  1. Before the PayPal call — a revoked mandate means nothing is sent at all.
 *  2. After the PayPal call, inside the transaction that inserts the order row — a mandate revoked
 *     *during* the network round trip must still abort, and by then an authorization may exist at PayPal
 *     that has to be voided and a reservation that has to be released.
 *
 * A transaction is not held open across the HTTP call (that is how a pool deadlock happens), so the
 * guarantee comes from the deterministic `PayPal-Request-Id` (`cs:{attemptId}:create`, §8.6): a retry after
 * the abort re-sends the identical request, so no second PayPal order can appear (EC-IDEM-2), and
 * `orders_attempt_id_key` makes the insert itself the backstop (AT-M11.5).
 */

import { createHash } from 'node:crypto'

import {
  attemptSync,
  csError,
  err,
  fromPayPalValue,
  ok,
  schemas,
  toPayPalValue,
  VI_LIB_COMMIT,
  type AttemptId,
  type CheckoutId,
  type CsError,
  type Currency,
  type GateDecisionId,
  type MandateId,
  type Money,
  type OrderId,
  type Result,
  type WalletId,
} from '@countersign/core'
import type { GateDecision } from '@countersign/gate'
import { canonicalJson, type CaptureRow, type OrderRow } from '@countersign/db'
import { orderCreateRequestId } from '@countersign/paypal'
import type { CreateOrderReq, Order } from '@countersign/paypal'

import { applyCaptureOutcome, outcomeFor } from './budget-hooks'
import { deterministicIds, toJsonValue, withTxOrAbort } from './deps'
import { intentForLines } from './types'
import type {
  AuthorizationPath,
  CapturePath,
  CreateOrderReport,
  OrderDraft,
  OrdersDeps,
  OrderTx,
} from './types'

/* ------------------------------------------------------------------------------------------ */
/* D18: the evidence bundle and the custom_id                                                       */
/* ------------------------------------------------------------------------------------------ */

/**
 * §7.3's evidence bundle, minus `paypal` and `shipments`.
 *
 * This is the exact object the `custom_id` hash covers. The type is closed on purpose: a tenth member would
 * change every hash ever issued, and the whole point of D18 is that a packet filed months ago still
 * recomputes.
 */
export interface EvidenceBundleCore {
  /** `cs1` — the version tag. Bumping it invalidates every verifier, so it is a constant. */
  readonly v: 'cs1'
  /** `l1_credentials.sd_jwt`, byte for byte. `null` when the world has no L1 row. */
  readonly l1: string | null
  /** `mandates.l2_serialized` — never a re-serialisation of `l2_payload`. */
  readonly l2: string
  /** `checkout_attempts.l3a`. */
  readonly l3a: string
  /** `checkout_attempts.l3b` — the L3 that binds `checkout_hash`. */
  readonly l3b: string
  /** `checkout_sessions.checkout_jwt`, signed by the merchant key. */
  readonly checkout_jwt: string
  /** The Gate's signed record (JWS). §8.10's nine-field payload. */
  readonly gate_decision: string
  /** Whether a WebAuthn assertion backed the mandate, and when. */
  readonly webauthn: { readonly present: boolean; readonly at?: number }
  /** The pinned Verifiable Intent commit, so an old packet verifies against the code that ran. */
  readonly vi_lib_commit: string
}

/**
 * The members the hash covers, in §7.3's order.
 *
 * Exported so a verifier — and the public-view code — can state the preimage without copying a comment.
 * `paypal` and `shipments` are absent **by design** (§7.3: "Shipments and PayPal IDs are added after order
 * creation, so they are excluded from the hash"), and this array is where that is written down in a form a
 * program can read.
 */
export const EVIDENCE_BUNDLE_HASHED_MEMBERS = Object.freeze([
  'v',
  'l1',
  'l2',
  'l3a',
  'l3b',
  'checkout_jwt',
  'gate_decision',
  'webauthn',
  'vi_lib_commit',
] as const)

/** The members of the full §7.3 bundle that are **not** hashed, and why. */
export const EVIDENCE_BUNDLE_EXCLUDED_MEMBERS = Object.freeze(['paypal', 'shipments'] as const)

/** Build the hashed bundle from a resolved draft. */
export function evidenceBundleCore(draft: OrderDraft): EvidenceBundleCore {
  return {
    v: 'cs1',
    l1: draft.l1Serialized,
    l2: draft.mandate.l2Serialized,
    l3a: draft.attempt.l3a,
    l3b: draft.attempt.l3b,
    checkout_jwt: draft.session.checkoutJwt,
    gate_decision: draft.decision.signedRecord,
    // `at` is omitted rather than sent as `null` when there was no assertion: `canonicalJson` drops
    // `undefined`, and "no assertion" must not hash the same as "an assertion at the epoch zero".
    webauthn: draft.webauthn.present
      ? { present: true, at: draft.webauthn.at }
      : { present: false },
    vi_lib_commit: draft.decision.viLibCommit,
  }
}

/**
 * `"cs1:" + base64url(sha256(JCS(bundle)))` — D18, 47 characters.
 *
 * Unpadded base64url of 32 bytes is exactly 43 characters, which is what `schemas.customIdSchema` asserts
 * (`/^cs1:[A-Za-z0-9_-]{43}$/`). The digest is taken over the **UTF-8 bytes** of the canonical form, so a
 * verifier needs nothing but `sha256` and `base64url`.
 *
 * @throws `CS_INTERNAL` if the result is not the shape `customIdSchema` demands. That would be a bug in
 * the input, not a PayPal problem, and it must never reach the wire as a malformed `custom_id`.
 */
export function customIdForBundle(bundle: EvidenceBundleCore): string {
  const digest = createHash('sha256').update(canonicalJson(bundle), 'utf8').digest()
  const customId = `cs1:${digest.toString('base64url')}`
  const parsed = schemas.customIdSchema.safeParse(customId)
  if (!parsed.success) {
    throw csError(
      'CS_INTERNAL',
      `Derived custom_id is ${customId.length} characters; the schema requires cs1: + 43 base64url characters`,
      { customId },
    )
  }
  return customId
}

/** The draft's `custom_id`, which is the only D18 value that reaches PayPal. */
export function evidenceCustomId(draft: OrderDraft): string {
  return customIdForBundle(evidenceBundleCore(draft))
}

/** Non-throwing {@link evidenceCustomId}, for a call site that must return a `Result`. */
export function evidenceCustomIdResult(draft: OrderDraft): Result<string, CsError> {
  return attemptSync(() => evidenceCustomId(draft), 'CS_INTERNAL')
}

/* ------------------------------------------------------------------------------------------ */
/* The PayPal request                                                                             */
/* ------------------------------------------------------------------------------------------ */

/**
 * `cs:{attemptId}:authorize` — the follow-up on the C2 fallback.
 *
 * §8.6 fixes four request-id formats (create, capture, refund, dispute action) and does not name one for
 * this call. The convention applied is the rule behind all four: **derived from our own ids**, `cs:`
 * prefixed, and header-safe. It is recorded here rather than invented at the call site so a future §8.6
 * amendment has one place to change.
 */
export function orderAuthorizeRequestId(attemptId: AttemptId): string {
  return `cs:${attemptId}:authorize`
}

/** `cs:{attemptId}:capture` — the D17 `CAPTURE`-intent follow-up. Same gap, same convention. */
export function orderCaptureRequestId(attemptId: AttemptId): string {
  return `cs:${attemptId}:capture`
}

/**
 * `cs:{authId}:abort-void` — the authorization void of an EC-MDT-2 abort.
 *
 * Keyed on the **authorization**, not the attempt, because the property that matters here is "one void per
 * authorization": a retried abort — a queue retry, a double-clicked revoke — must be the same void at
 * PayPal, or the second would answer `PP_NOT_FOUND` on an already-void authorization and look like a
 * failure. Same reasoning as {@link void.ts}'s `voidRequestId`, which this deliberately mirrors.
 */
export function abortVoidRequestId(authorizationId: string): string {
  return `cs:${authorizationId}:abort-void`
}

/**
 * `purchase_units[0]` for a merchant-initiated order.
 *
 * Every field is load-bearing:
 *
 * | Field | Why |
 * |---|---|
 * | `custom_id` | D18. The chain hash, inside PayPal's own records. |
 * | `invoice_id` | D18. Our `ord_…`, so PayPal's dashboard and our row join on one string. |
 * | `payee.merchant_id` | the payee the L3 signed for (§8.11; [V11] rejects a mismatch). |
 * | `amount.breakdown` | `item_total` + `shipping` (+ `tax_total`), summing to `amount` exactly — `checkout_sessions` has a CHECK for that and this function preserves it. |
 * | `items[]` | required by Orders v2 whenever `breakdown` is present, and what makes the order reviewable in the PayPal UI. |
 *
 * **What is deliberately absent:** `description`/`listing_html` from the catalog, and any
 * `application_context`. Three seeded products carry prompt-injection payloads in `listing_html` (§8.13,
 * AT-M13.2); copying merchant-authored text into a PayPal order would put an attacker's string into a
 * payment record that a PayPal agent may later read. The product **title** is included because Orders v2
 * requires a name per item and the seed keeps titles clean.
 */
export function purchaseUnitFor(
  draft: OrderDraft,
  orderId: OrderId,
  customId: string,
): CreateOrderReq['purchase_units'][number] {
  const { currency } = draft.session.total
  const amount = (minor: bigint) => ({
    currency_code: currency,
    value: toPayPalValue({ minor, currency }),
  })

  return {
    reference_id: 'default',
    custom_id: customId,
    invoice_id: orderId,
    description: 'Countersign agent purchase',
    amount: {
      currency_code: currency,
      value: toPayPalValue(draft.session.total),
      breakdown: {
        item_total: amount(draft.session.subtotal.minor),
        shipping: amount(draft.session.shipping.minor),
        ...(draft.session.tax.minor > 0n ? { tax_total: amount(draft.session.tax.minor) } : {}),
      },
    },
    items: draft.session.lines.map((line) => ({
      name: line.title,
      quantity: String(line.qty),
      unit_amount: amount(line.unitMinor),
      sku: line.sku,
    })),
    payee: { merchant_id: draft.attempt.payee },
  }
}

/** The whole `POST /v2/checkout/orders` body. */
export function createOrderRequestFor(
  draft: OrderDraft,
  orderId: OrderId,
  customId: string,
): CreateOrderReq {
  return {
    intent: intentForLines(draft.session.lines),
    purchase_units: [purchaseUnitFor(draft, orderId, customId)],
    // [V10]: the vault id is what makes this merchant-initiated — no buyer present, no redirect, no
    // `user_action`. `account_id` is deliberately **not** sent: it is documented on the response, and the
    // audit labels "carries the same value as payer_id" an ASSUMPTION a sandbox probe has yet to settle.
    payment_source: { paypal: { vault_id: draft.wallet.vaultId } },
  }
}

/* ------------------------------------------------------------------------------------------ */
/* createOrderFromDecision                                                                        */
/* ------------------------------------------------------------------------------------------ */

/**
 * §8.11's signature, verbatim: create the PayPal order a Gate `ALLOW` approved, and return our row.
 *
 * The row is what the receipt, the dispute router and the webhooks all want, so it is the return value.
 * {@link createOrderFromDecisionDetailed} returns the same row plus the C2 path record and the request id,
 * for the nightly sandbox run that has to answer "did PayPal authorize inline?" with evidence.
 */
export async function createOrderFromDecision(
  d: GateDecision,
  deps: OrdersDeps,
): Promise<Result<OrderRow, CsError>> {
  const detailed = await createOrderFromDecisionDetailed(d, deps)
  if (!detailed.ok) return detailed
  return ok(detailed.value.order)
}

/** `createOrderFromDecision`, with the report. @see createOrderFromDecision */
export async function createOrderFromDecisionDetailed(
  d: GateDecision,
  deps: OrdersDeps,
): Promise<Result<CreateOrderReport, CsError>> {
  // A Gate that did not ALLOW must not produce a money movement. §3.1 I-1 in one line, and the reasons are
  // carried so the buyer sees which check stopped it rather than a generic failure.
  if (d.decision !== 'ALLOW') {
    return err(
      csError(
        'GATE_BLOCKED',
        `Gate decision ${d.id} is ${d.decision}; no PayPal order may be created for it`,
        {
          gateDecisionId: d.id,
          decision: d.decision,
          reasons: d.reasons.map((r) => ({ code: r.code, message: r.message })),
        },
        { userMessage: d.reasons[0]?.userMessage ?? 'The Gate blocked this purchase.' },
      ),
    )
  }

  const at = new Date(deps.clock.nowMs())
  const nowSec = deps.clock.nowSec()

  // 1. Resolve the draft, re-reading the mandate **inside one transaction** (EC-MDT-2, first read).
  const resolved = await withTxOrAbort(deps.store, (tx) => loadOrderDraft(deps, d.id, tx, nowSec))
  if (!resolved.ok) return resolved
  const draft = resolved.value

  // 2. AT-M11.5 / EC-IDEM-1: an attempt has at most one order (`orders_attempt_id_key`). A duplicate call
  //    returns the existing row and makes **no** PayPal request — which is also what makes a double-clicked
  //    "Buy" free.
  const orderId = deterministicIds.order(draft.attempt.id) as OrderId
  const requestId = orderCreateRequestId(draft.attempt.id)
  const existing = await deps.store.orders.findByAttempt(draft.attempt.id)
  if (!existing.ok) return existing
  if (existing.value) {
    return ok({
      order: existing.value,
      authorizationId: await firstAuthorizationId(deps, existing.value),
      captureId: await firstCaptureId(deps, existing.value),
      authorizationPath: 'NONE',
      capturePath: 'NONE',
      idempotent: true,
      requestId,
    })
  }

  const customId = evidenceCustomIdResult(draft)
  if (!customId.ok) return customId
  const body = createOrderRequestFor(draft, orderId, customId.value)

  // 3. The one side effect. `POST /v2/checkout/orders`, one attempt, one request id.
  const created = await deps.paypal.createOrder(body, { requestId })
  if (!created.ok) {
    return err(await compensateCreateFailure(deps, draft, created.error, at))
  }
  const paypalOrder = created.value
  if (typeof paypalOrder.id !== 'string' || paypalOrder.id.trim() === '') {
    return err(
      csError('PP_UNPROCESSABLE', 'PayPal answered a create with no order id', {
        paypalOrderStatus: paypalOrder.status,
      }),
    )
  }

  // 4. The authorization (or the up-front capture) may already be inline. §8.11 + audit §17.
  const resolvedPayment = await resolvePayment(deps, draft, paypalOrder, requestId)
  if (!resolvedPayment.ok) {
    return err(await compensateCreateFailure(deps, draft, resolvedPayment.error, at))
  }

  // 5. Persist — in one transaction that re-reads the mandate (EC-MDT-2, second read).
  const persisted = await withTxOrAbort(deps.store, async (tx) => {
    const locked = await deps.store.lockMandate(draft.mandate.id, tx)
    if (!locked.ok) return locked
    if (!locked.value || locked.value.status !== 'ACTIVE') {
      return err(revokedDuringCreate(draft.mandate.id, locked.value?.status ?? 'MISSING'))
    }
    const inserted = await deps.store.orders.insert(
      {
        id: orderId,
        merchant_id: draft.merchantId,
        attempt_id: draft.attempt.id,
        paypal_order_id: paypalOrder.id,
        intent: body.intent,
        custom_id: customId.value,
        invoice_id: orderId,
        status: orderStatusFor(body.intent, resolvedPayment.value),
        amount_minor: draft.attempt.amount.minor,
        currency: draft.attempt.amount.currency,
        // §7.1's `raw` mirror, plus the C2 record. Keeping the countersign block **inside** `raw` rather
        // than in a column it does not have is deliberate: `orders` is immutable to everyone else, and the
        // reconciler replaces `raw` from a GET, so a separate file would be lost on the first fetch.
        raw: toJsonValue({
          paypal: paypalOrder,
          countersign: {
            ...pathRecord(resolvedPayment.value),
            evidenceVersion: 'cs1',
            evidenceCustomId: customId.value,
          },
        }),
        fetched_at: at,
        created_at: at,
        updated_at: at,
      },
      tx,
    )
    if (!inserted.ok) return inserted

    const authorization = await insertAuthorization(
      deps,
      draft,
      orderId,
      resolvedPayment.value,
      at,
      tx,
    )
    if (!authorization.ok) return authorization

    const capture = await insertInlineCapture(deps, draft, orderId, resolvedPayment.value, at, tx)
    if (!capture.ok) return capture

    await deps.store.attempts.setState(
      draft.attempt.id,
      capture.value ? 'CAPTURED' : 'AUTHORIZED',
      at,
      tx,
    )
    return ok({
      order: inserted.value,
      authorizationId: authorization.value?.id ?? null,
      captureId: capture.value?.id ?? null,
      capture: capture.value,
    })
  })

  if (!persisted.ok) {
    // EC-MDT-2's abort. The order row is gone (the transaction rolled back); the PayPal order and
    // possibly its authorization are not, so both are undone here, outside the transaction.
    await compensateAbortedCreate(deps, draft, paypalOrder, resolvedPayment.value, at)
    return persisted
  }

  // 6. An inline capture on the D17 `CAPTURE` path is money already out of the budget, so its hook runs
  //    here — including the `PENDING` and `DECLINED` cases, which is why the outcome is read back from the
  //    row rather than assumed.
  if (persisted.value.capture) {
    const outcome = outcomeFor(persisted.value.capture.status)
    if (outcome) {
      const applied = await applyCaptureOutcome({
        deps,
        order: persisted.value.order,
        authorization: null,
        capture: persisted.value.capture,
        outcome,
        at,
      })
      if (!applied.ok) return applied
    }
  }

  return ok({
    order: persisted.value.order,
    authorizationId: persisted.value.authorizationId,
    captureId: persisted.value.captureId,
    authorizationPath: resolvedPayment.value.authorizationPath,
    capturePath: resolvedPayment.value.capturePath,
    idempotent: false,
    requestId,
  })
}

/* ------------------------------------------------------------------------------------------ */
/* Draft resolution                                                                               */
/* ------------------------------------------------------------------------------------------ */

/**
 * Resolve everything the request needs, and refuse anything that would break §3.1 I-1.
 *
 * The three refusals are the point of this function:
 *
 *  - the mandate must still be `ACTIVE` **and** unexpired (EC-MDT-2, EC-MDT-1);
 *  - the wallet must be `ACTIVE` — a deleted vault token suspends every mandate under it (EC-MDT-6);
 *  - `attempt.amount_minor` must equal `checkout_sessions.total_minor`, in the same currency, because that
 *    equality is what makes the signed record describe *this* order. If they ever disagree, the order about
 *    to be created is not the order the user signed for, and the right answer is to stop.
 */
async function loadOrderDraft(
  deps: OrdersDeps,
  decisionId: GateDecisionId,
  tx: OrderTx,
  nowSec: number,
): Promise<Result<OrderDraft, CsError>> {
  const decision = await deps.store.gateDecision(decisionId, tx)
  if (!decision.ok) return decision
  if (!decision.value) return err(notFound('gate_decisions', decisionId))
  const decisionRow = decision.value

  // The foreign-key columns are `text` in §7.2, so the branded id types are recovered here rather than by
  // the row types. A `text` column that referenced the wrong table would be a foreign-key violation, so
  // the cast cannot paper over a real inconsistency.
  const attemptId = decisionRow.attempt_id as AttemptId
  const attempt = await deps.store.attempt(attemptId, tx)
  if (!attempt.ok) return attempt
  if (!attempt.value) return err(notFound('checkout_attempts', attemptId))
  const attemptRow = attempt.value

  const mandateId = attemptRow.mandate_id as MandateId
  // The **locking** read, inside the caller's transaction. A plain read would be a snapshot, and a
  // revocation landing one statement later would be invisible (EC-MDT-2).
  const mandate = await deps.store.lockMandate(mandateId, tx)
  if (!mandate.ok) return mandate
  if (!mandate.value) return err(notFound('mandates', mandateId))
  const mandateRow = mandate.value
  if (mandateRow.status !== 'ACTIVE') {
    return err(revokedDuringCreate(mandateRow.id, mandateRow.status))
  }
  if (mandateRow.exp <= BigInt(nowSec)) {
    return err(
      csError(
        'VI_EXPIRED',
        `Mandate ${mandateRow.id} expired at ${mandateRow.exp.toString()}; now is ${nowSec}`,
        { table: 'mandates', mandateId: mandateRow.id, exp: mandateRow.exp.toString(), nowSec },
      ),
    )
  }

  const walletId = mandateRow.wallet_id as WalletId
  const wallet = await deps.store.wallet(walletId, tx)
  if (!wallet.ok) return wallet
  if (!wallet.value) return err(notFound('paypal_wallets', walletId))
  if (wallet.value.status !== 'ACTIVE') {
    // EC-MDT-6. The buyer removed the token in PayPal's settings; the Gate would block the *next* attempt,
    // but this one got there first.
    return err(
      csError(
        'CS_FORBIDDEN',
        `Wallet ${wallet.value.id} is ${wallet.value.status}: the PayPal connection was removed`,
        {
          table: 'paypal_wallets',
          walletId: wallet.value.id,
          status: wallet.value.status,
          ec: 'EC-MDT-6',
        },
        { userMessage: 'Your PayPal connection was removed. Reconnect to continue.' },
      ),
    )
  }

  const sessionId = attemptRow.checkout_session_id as CheckoutId
  const session = await deps.store.checkoutSession(sessionId, tx)
  if (!session.ok) return session
  if (!session.value) return err(notFound('checkout_sessions', sessionId))
  const sessionRow = session.value

  const merchant = await deps.store.merchantByPaypalId(attemptRow.payee, tx)
  if (!merchant.ok) return merchant
  if (!merchant.value) {
    return err(
      csError(
        'CS_VALIDATION',
        `No registered merchant receives payments for payee ${attemptRow.payee}`,
        { table: 'merchants', payee: attemptRow.payee },
        {
          userMessage: 'This store is not set up to take payments yet. Nothing was charged.',
          retryable: false,
        },
      ),
    )
  }
  const merchantRow = merchant.value

  if (sessionRow.currency !== attemptRow.currency) {
    return err(
      csError(
        'CS_CURRENCY_MISMATCH',
        `Attempt ${attemptRow.id} is ${attemptRow.currency} but its cart is ${sessionRow.currency}`,
        {
          table: 'checkout_attempts',
          attemptId: attemptRow.id,
          attemptCurrency: attemptRow.currency,
          sessionCurrency: sessionRow.currency,
        },
      ),
    )
  }
  if (sessionRow.total_minor !== attemptRow.amount_minor) {
    // §3.1 I-1: the signed amount and the charged amount must be the same number of minor units.
    return err(
      csError(
        'CS_VALIDATION',
        `Cart total ${sessionRow.total_minor.toString()} does not equal the Gate-approved amount ` +
          `${attemptRow.amount_minor.toString()}`,
        {
          table: 'checkout_attempts',
          attemptId: attemptRow.id,
          sessionTotalMinor: sessionRow.total_minor.toString(),
          approvedMinor: attemptRow.amount_minor.toString(),
          currency: attemptRow.currency,
        },
        {
          userMessage:
            'The cart changed after you approved it. Nothing was charged; the agent needs to re-quote.',
        },
      ),
    )
  }

  let lines: CartLine[]
  try {
    lines = cartLinesOf(sessionRow.cart)
  } catch (cause) {
    return err(
      typeof cause === 'object' && cause !== null && 'code' in cause
        ? (cause as CsError)
        : csError('CS_VALIDATION', 'Unreadable cart', { table: 'checkout_sessions' }),
    )
  }

  const products = await deps.store.products(
    lines.map((l) => l.sku),
    tx,
  )
  if (!products.ok) return products
  const bySku = new Map(products.value.map((p) => [p.sku, p]))
  const missing = lines.map((l) => l.sku).filter((sku) => !bySku.has(sku))
  if (missing.length > 0) {
    return err(
      csError(
        'CS_VALIDATION',
        `Cart references products that do not exist: ${missing.join(', ')}`,
        {
          skus: missing,
        },
      ),
    )
  }

  const l1 = await deps.store.l1Credential(mandateRow.device_id, walletId, tx)
  if (!l1.ok) return l1

  const currency: Currency = attemptRow.currency
  const money = (minor: bigint): Money => ({ minor, currency })

  return ok({
    merchantId: merchantRow.id,
    decision: {
      id: decisionRow.id,
      attemptId: attemptRow.id,
      signedRecord: decisionRow.signed_record,
      // `VI_LIB_COMMIT` is the fallback, and it is a *deliberate* one: a decision row written before the
      // column existed must still hash to something a verifier can recompute.
      viLibCommit: decisionRow.vi_lib_commit || VI_LIB_COMMIT,
      decidedAt: decisionRow.decided_at,
    },
    attempt: {
      id: attemptRow.id,
      mandateId,
      checkoutSessionId: sessionId,
      amount: money(attemptRow.amount_minor),
      payee: attemptRow.payee,
      l3a: attemptRow.l3a,
      l3b: attemptRow.l3b,
    },
    mandate: {
      id: mandateRow.id,
      userId: mandateRow.user_id,
      walletId,
      status: mandateRow.status,
      expSec: mandateRow.exp,
      l2Serialized: mandateRow.l2_serialized,
    },
    wallet: {
      id: wallet.value.id,
      vaultId: wallet.value.payment_token_id,
      status: wallet.value.status,
      payerId: wallet.value.payer_id,
      payerEmail: wallet.value.payer_email,
    },
    session: {
      id: sessionRow.id,
      merchantId: sessionRow.merchant_id,
      checkoutJwt: sessionRow.checkout_jwt,
      checkoutHash: sessionRow.checkout_hash,
      lines: lines.map((l) => ({
        sku: l.sku,
        qty: l.qty,
        unitMinor: l.unit_minor,
        title: bySku.get(l.sku)?.title ?? l.sku,
        // §8.9/D17: `digital` is the intent selector, so a missing product row cannot silently change it.
        digital: bySku.get(l.sku)?.digital ?? false,
      })),
      subtotal: money(sessionRow.subtotal_minor),
      tax: money(sessionRow.tax_minor),
      shipping: money(sessionRow.shipping_minor),
      total: money(sessionRow.total_minor),
    },
    l1Serialized: l1.value?.sd_jwt ?? null,
    webauthn: {
      // `mandates.webauthn_assertion` is a jsonb column whose presence *is* the record; there is no
      // separate timestamp, so the attempt's instant is the honest answer to "when was this asserted".
      present:
        mandateRow.webauthn_assertion !== null && mandateRow.webauthn_assertion !== undefined,
      at: Math.floor(attemptRow.created_at.getTime() / 1000),
    },
  })
}

/** One locked-cart line. `unit_minor` is what makes this the allocation basis (EC-FX-4). */
interface CartLine {
  readonly sku: string
  readonly qty: number
  readonly unit_minor: bigint
}

/** `{lines: [{sku, qty, unit_minor}]}` out of `checkout_sessions.cart`, refusing anything else. */
function cartLinesOf(cart: unknown): CartLine[] {
  const lines =
    typeof cart === 'object' && cart !== null && 'lines' in cart
      ? (cart as { lines?: unknown }).lines
      : undefined
  if (!Array.isArray(lines) || lines.length === 0) {
    throw csError('CS_VALIDATION', 'checkout_sessions.cart has no lines; the cart is unreadable', {
      table: 'checkout_sessions',
    })
  }
  return lines.map((raw) => {
    const line = raw as { sku?: unknown; qty?: unknown; unit_minor?: unknown }
    const unitMinor =
      typeof line.unit_minor === 'bigint'
        ? line.unit_minor
        : typeof line.unit_minor === 'string' && /^\d+$/.test(line.unit_minor)
          ? BigInt(line.unit_minor)
          : null
    const qty = typeof line.qty === 'number' && Number.isInteger(line.qty) ? line.qty : null
    if (typeof line.sku !== 'string' || unitMinor === null || qty === null || qty <= 0) {
      throw csError('CS_VALIDATION', `Cart line is unreadable: ${JSON.stringify(raw)}`, {
        table: 'checkout_sessions',
      })
    }
    return { sku: line.sku, qty, unit_minor: unitMinor }
  })
}

/* ------------------------------------------------------------------------------------------ */
/* Inline vs follow-up (C2)                                                                       */
/* ------------------------------------------------------------------------------------------ */

/** What a create response yielded, whichever route it came from. */
interface ResolvedPayment {
  readonly authorization: InlineAuthorization | null
  readonly capture: InlineCapture | null
  readonly authorizationPath: AuthorizationPath
  readonly capturePath: CapturePath
}

/** The inline authorization object, narrowed to the fields we store. The schema is loose, so read defensively. */
interface InlineAuthorization {
  readonly id: string
  readonly status?: string
  readonly expirationTime?: string
  readonly amount?: { currency_code?: string; value?: string }
}

/** The inline capture object on the D17 `CAPTURE` path. */
interface InlineCapture {
  readonly id: string
  readonly status?: string
  readonly amount?: { currency_code?: string; value?: string }
}

/** The C2 record written into `orders.raw.countersign`. */
function pathRecord(payment: ResolvedPayment): Record<string, unknown> {
  return {
    authorizationPath: payment.authorizationPath,
    capturePath: payment.capturePath,
    paypalAuthorizationId: payment.authorization?.id ?? null,
    paypalCaptureId: payment.capture?.id ?? null,
  }
}

/**
 * Read the inline `payments` block, and fall back only if it is absent.
 *
 * The order of operations is the whole of week-1 check C2:
 *
 *  1. `purchase_units[].payments.authorizations[]` — present in the OpenAPI **schema**
 *     (`payment_collection`) and in the `vault_id` + `AUTHORIZE` 201 example (audit §17).
 *  2. `POST /v2/checkout/orders/{id}/authorize` — documented, and the route the interactive flow uses.
 *
 * The log line names which one ran, with the PayPal order id: a nightly run that always logs `INLINE` has
 * answered C2 for `AUTHORIZE`; one that logs `AUTHORIZE_ENDPOINT` has found the documented example to be
 * wrong. Both outcomes are useful. Assuming either is not.
 */
async function resolvePayment(
  deps: OrdersDeps,
  draft: OrderDraft,
  paypalOrder: Order,
  createRequestId: string,
): Promise<Result<ResolvedPayment, CsError>> {
  if (draft.session.lines.length === 0) {
    return err(
      csError('CS_VALIDATION', 'Cannot create an order for an empty cart', {
        checkoutSessionId: draft.session.id,
      }),
    )
  }

  const unit = paypalOrder.purchase_units?.[0]
  const payments = unit?.payments
  const inlineAuth = readInlineAuthorization(payments?.authorizations?.[0])
  const inlineCapture = readInlineCapture(payments?.captures?.[0])

  if (intentForLines(draft.session.lines) === 'AUTHORIZE') {
    if (inlineAuth) {
      deps.logger?.info('paypal AUTHORIZE resolved from the inline payments block', {
        paypalOrderId: paypalOrder.id,
        paypalAuthorizationId: inlineAuth.id,
        path: 'INLINE',
        ec: 'C2',
      })
      return ok({
        authorization: inlineAuth,
        capture: null,
        authorizationPath: 'INLINE',
        capturePath: 'NONE',
      })
    }
    const followed = await deps.paypal.authorizeOrder(paypalOrder.id, {
      requestId: orderAuthorizeRequestId(draft.attempt.id),
    })
    if (!followed.ok) return followed
    const authorized = readInlineAuthorization(
      followed.value.purchase_units?.[0]?.payments?.authorizations?.[0],
    )
    deps.logger?.warn('paypal AUTHORIZE needed the /authorize fallback', {
      paypalOrderId: paypalOrder.id,
      createRequestId,
      paypalAuthorizationId: authorized?.id ?? null,
      path: 'AUTHORIZE_ENDPOINT',
      ec: 'C2',
    })
    if (!authorized) {
      return err(
        csError(
          'PP_UNPROCESSABLE',
          `Neither the inline block nor /authorize returned an authorization for order ${paypalOrder.id}`,
          { paypalOrderId: paypalOrder.id, paypalOrderStatus: paypalOrder.status },
        ),
      )
    }
    return ok({
      authorization: authorized,
      capture: null,
      authorizationPath: 'AUTHORIZE_ENDPOINT',
      capturePath: 'NONE',
    })
  }

  // D17's digital path: the capture is supposed to be inline for the same single-shot reason. If it is not,
  // `/capture` is the documented way to complete it — and skipping that would leave an order created and
  // never paid, which is the worst possible state for an `intent: CAPTURE` order.
  if (inlineCapture) {
    deps.logger?.info('paypal CAPTURE resolved from the inline payments block', {
      paypalOrderId: paypalOrder.id,
      paypalCaptureId: inlineCapture.id,
      path: 'INLINE',
    })
    return ok({
      authorization: null,
      capture: inlineCapture,
      authorizationPath: 'NONE',
      capturePath: 'INLINE',
    })
  }
  const captured = await deps.paypal.captureOrder(paypalOrder.id, {
    requestId: orderCaptureRequestId(draft.attempt.id),
  })
  if (!captured.ok) return captured
  const completed = readInlineCapture(captured.value.purchase_units?.[0]?.payments?.captures?.[0])
  deps.logger?.warn('paypal CAPTURE needed the /capture fallback', {
    paypalOrderId: paypalOrder.id,
    createRequestId,
    paypalCaptureId: completed?.id ?? null,
    path: 'CAPTURE_ENDPOINT',
  })
  if (!completed) {
    return err(
      csError(
        'PP_UNPROCESSABLE',
        `Neither the inline block nor /capture returned a capture for order ${paypalOrder.id}`,
        { paypalOrderId: paypalOrder.id, paypalOrderStatus: paypalOrder.status },
      ),
    )
  }
  return ok({
    authorization: null,
    capture: completed,
    authorizationPath: 'NONE',
    capturePath: 'CAPTURE_ENDPOINT',
  })
}

function readInlineAuthorization(raw: { id?: string } | undefined): InlineAuthorization | null {
  if (!raw || typeof raw.id !== 'string' || raw.id === '') return null
  const o = raw as Record<string, unknown>
  const amount = o['amount'] as { currency_code?: unknown; value?: unknown } | undefined
  const expiration = o['expiration_time']
  return {
    id: raw.id,
    status: typeof o['status'] === 'string' ? o['status'] : undefined,
    expirationTime: typeof expiration === 'string' ? expiration : undefined,
    amount:
      amount && typeof amount.value === 'string'
        ? {
            currency_code:
              typeof amount.currency_code === 'string' ? amount.currency_code : undefined,
            value: amount.value,
          }
        : undefined,
  }
}

function readInlineCapture(raw: { id?: string } | undefined): InlineCapture | null {
  if (!raw || typeof raw.id !== 'string' || raw.id === '') return null
  const o = raw as Record<string, unknown>
  const amount = o['amount'] as { currency_code?: unknown; value?: unknown } | undefined
  return {
    id: raw.id,
    status: typeof o['status'] === 'string' ? o['status'] : undefined,
    amount:
      amount && typeof amount.value === 'string'
        ? {
            currency_code:
              typeof amount.currency_code === 'string' ? amount.currency_code : undefined,
            value: amount.value,
          }
        : undefined,
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Persisting what PayPal gave us                                                                  */
/* ------------------------------------------------------------------------------------------ */

function orderStatusFor(
  intent: 'AUTHORIZE' | 'CAPTURE',
  payment: ResolvedPayment,
): 'ORDER_CREATED' | 'AUTHORIZED' | 'CAPTURED' {
  if (payment.capture) return 'CAPTURED'
  if (intent === 'AUTHORIZE' && payment.authorization) return 'AUTHORIZED'
  return 'ORDER_CREATED'
}

/** 29 days: what the audit's §14 prose ("days four to 29") documents as an authorization's life. */
const AUTHORIZATION_LIFETIME_MS = 29 * 86_400_000
/** 3 days: PayPal's honour period [V15] — the window `reauthorizeIfNeeded` runs inside. */
const AUTHORIZATION_HONOUR_MS = 3 * 86_400_000

async function insertAuthorization(
  deps: OrdersDeps,
  draft: OrderDraft,
  orderId: OrderId,
  payment: ResolvedPayment,
  at: Date,
  tx: OrderTx,
): Promise<Result<{ id: string } | null, CsError>> {
  const auth = payment.authorization
  if (!auth) return ok(null)
  const createdMs = at.getTime()
  // Both columns are NOT NULL, so both are computed even when PayPal sent no `expiration_time`. Storing a
  // wrong-but-present value would be worse than storing the documented default, because the reconciler
  // compares against it (EC-TIME-5).
  const stated = auth.expirationTime ? Date.parse(auth.expirationTime) : Number.NaN
  const expiration = Number.isNaN(stated)
    ? new Date(createdMs + AUTHORIZATION_LIFETIME_MS)
    : new Date(stated)
  const row = await deps.store.authorizations.insert(
    {
      id: deterministicIds.authorization(orderId, auth.id),
      order_id: orderId,
      paypal_authorization_id: auth.id,
      amount_minor: draft.attempt.amount.minor,
      currency: draft.attempt.amount.currency,
      status: auth.status === 'PENDING' ? 'PENDING' : 'CREATED',
      expiration_time: expiration,
      honor_expires_at: new Date(createdMs + AUTHORIZATION_HONOUR_MS),
      raw: toJsonValue(auth),
      fetched_at: at,
      created_at: at,
      updated_at: at,
    },
    tx,
  )
  if (!row.ok) return row
  return ok({ id: row.value.id })
}

async function insertInlineCapture(
  deps: OrdersDeps,
  draft: OrderDraft,
  orderId: OrderId,
  payment: ResolvedPayment,
  at: Date,
  tx: OrderTx,
): Promise<Result<CaptureRow | null, CsError>> {
  const capture = payment.capture
  if (!capture) return ok(null)
  // No shipment and no authorization, so the id is keyed on the PayPal capture id itself: one PayPal
  // capture, one row, and a retried create finds the same id instead of writing a second.
  const syntheticShipment = deterministicIds.shipment(orderId, 'INLINE', capture.id, [])
  const amount = inlineAmount(capture.amount, draft.attempt.amount)
  const row = await deps.store.captures.insert(
    {
      id: deterministicIds.capture(orderId, '', syntheticShipment),
      order_id: orderId,
      authorization_id: null,
      paypal_capture_id: capture.id,
      amount_minor: amount.minor,
      currency: amount.currency,
      // There is nothing further to capture against a `CAPTURE`-intent order, so its single capture is
      // necessarily the final one. It is `true` here for the truth of the record, not as a request to
      // PayPal — the flag on a capture *request* is what releases a remainder, and there is none.
      final_capture: true,
      status:
        capture.status === 'PENDING'
          ? 'PENDING'
          : capture.status === 'DECLINED'
            ? 'DECLINED'
            : 'COMPLETED',
      raw: toJsonValue(capture),
      fetched_at: at,
      created_at: at,
      updated_at: at,
    },
    tx,
  )
  if (!row.ok) return row
  return ok(row.value)
}

/**
 * The amount of an inline capture.
 *
 * PayPal's own value wins when it parses; the Gate-approved total is the fallback so a body without an
 * `amount` still records a defensible number. The parse goes through `fromPayPalValue`, so a
 * `"1.005"` USD value is a `CS_ROUNDING` refusal rather than a silently rounded cent.
 */
function inlineAmount(
  amount: { currency_code?: string; value?: string } | undefined,
  fallback: Money,
): Money {
  if (!amount || typeof amount.value !== 'string') return fallback
  return fromPayPalValue(amount.value, fallback.currency)
}

/* ------------------------------------------------------------------------------------------ */
/* Compensation                                                                                   */
/* ------------------------------------------------------------------------------------------ */

/**
 * A definitive create failure: give the reservation straight back.
 *
 * A **retryable** failure (`PP_RATE_LIMITED`, `PP_UNAVAILABLE`) releases nothing, because the request may
 * yet succeed and the queue will retry it with the same `PayPal-Request-Id`. A **definitive** one
 * (`PP_UNPROCESSABLE`, a decline, a revoked token) will never succeed on a retry, so holding the buyer's
 * budget until the 30-minute sweep would be a bug the buyer experiences as "my money is stuck".
 *
 * EC-STOCK-3's precedent: the Gate releases on a block, and this is the same compensation one layer later.
 */
async function compensateCreateFailure(
  deps: OrdersDeps,
  draft: OrderDraft,
  error: CsError,
  at: Date,
): Promise<CsError> {
  if (error.retryable) return error
  await releaseAttemptReservation(deps, draft, 'ORDER_CREATE_FAILED', at)
  return error
}

/**
 * EC-MDT-2's abort, after PayPal has already answered.
 *
 * Three things have to be undone, in this order, and the order matters:
 *
 *  1. **Void the authorization** if one was created. It would hold the buyer's money for 29 days otherwise,
 *    and §8.11's `voidRemainder` exists for exactly this shape (EC-MDT-3 does the same from the revoke
 *    handler's side).
 *  2. **Release the reservation.** The spec's words for EC-MDT-2: "Abort; RELEASE the reservation."
 *  3. **Tell the buyer**: "Revoked, nothing was charged."
 *
 * A void that fails is logged rather than propagated: the order row is already rolled back, so there is
 * nothing left to fail, and the 30-minute sweep plus the reconciler are the backstop for the authorization.
 */
async function compensateAbortedCreate(
  deps: OrdersDeps,
  draft: OrderDraft,
  paypalOrder: Order,
  payment: ResolvedPayment,
  at: Date,
): Promise<void> {
  if (payment.authorization) {
    const voided = await deps.paypal.voidAuthorization(payment.authorization.id, {
      requestId: abortVoidRequestId(payment.authorization.id),
    })
    if (!voided.ok) {
      deps.logger?.error('could not void the authorization of an aborted order', {
        paypalOrderId: paypalOrder.id,
        paypalAuthorizationId: payment.authorization.id,
        code: voided.error.code,
      })
    }
  }
  const released = await releaseAttemptReservation(deps, draft, 'REVOKED', at)
  if (released === 0n) return
  await deps.notify.notify({
    kind: 'REMAINDER_RELEASED',
    orderId: deterministicIds.order(draft.attempt.id) as OrderId,
    userId: draft.mandate.userId,
    amount: { minor: released, currency: draft.attempt.amount.currency },
    at: Math.floor(at.getTime() / 1000),
    userMessage: 'Revoked, nothing was charged.',
    detail: { reason: 'MANDATE_REVOKED_DURING_ORDER_CREATE', ec: 'EC-MDT-2' },
  })
}

/**
 * RELEASE the reservation for an attempt.
 *
 * The amount is the order total, not "whatever is left": the Gate reserved exactly the order total and
 * nothing has been committed yet on this path. `releaseIn` clamps at the current `reserved`, so a release
 * racing the 30-minute sweep credits nothing that was never reserved.
 */
async function releaseAttemptReservation(
  deps: OrdersDeps,
  draft: OrderDraft,
  reason: string,
  at: Date,
): Promise<bigint> {
  const outcome = await deps.budget.release({
    mandateId: draft.mandate.id,
    attemptId: draft.attempt.id,
    captureId: null,
    amount: draft.attempt.amount,
    at,
    reason,
  })
  if (!outcome.ok) {
    deps.logger?.error('could not release a reservation', {
      attemptId: draft.attempt.id,
      reason,
      code: outcome.error.code,
    })
    return 0n
  }
  return outcome.value.moved ? draft.attempt.amount.minor : 0n
}

function revokedDuringCreate(mandateId: string, status: string): CsError {
  return csError(
    'GATE_REVOKED',
    `Mandate ${mandateId} became ${status} while the order was being created`,
    { table: 'mandates', mandateId, status, recheck: 'in_transaction', ec: 'EC-MDT-2' },
    { userMessage: 'Revoked, nothing was charged.' },
  )
}

function notFound(table: string, id: string): CsError {
  return csError('CS_NOT_FOUND', `No ${table} row for ${id}`, { table, id })
}

/* ------------------------------------------------------------------------------------------ */
/* Small helpers                                                                                  */
/* ------------------------------------------------------------------------------------------ */

async function firstAuthorizationId(deps: OrdersDeps, order: OrderRow): Promise<string | null> {
  const rows = await deps.store.authorizations.findByOrder(order.id)
  if (!rows.ok || rows.value.length === 0) return null
  return rows.value[0]?.id ?? null
}

async function firstCaptureId(deps: OrdersDeps, order: OrderRow): Promise<string | null> {
  const rows = await deps.store.captures.findByOrder(order.id)
  if (!rows.ok || rows.value.length === 0) return null
  return rows.value[0]?.id ?? null
}
