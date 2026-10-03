/**
 * The Countersign data model — spec **§7**, work package **WP-02**.
 *
 * Every table in §7.2 is here, with the §7.1 rules enforced *in the database* rather than only in
 * TypeScript:
 *
 *  1. **Money is `bigint` minor units + `char(3)` currency.** Never `doublePrecision`, `numeric` or
 *     `real`. `test/schema.test.ts` walks every column of every table and fails if a float type
 *     appears, so the §0 money rule is enforced structurally rather than by review.
 *  2. **Every PayPal-mirrored row carries `paypal_id` (unique), `raw jsonb` and `fetched_at`.** The
 *     last body we fetched from PayPal is kept so evidence packets and the reconciler can be run
 *     without trusting an LLM or re-deriving state from a webhook payload (spec §8.12: "never trust
 *     payload state").
 *  3. **Every table has `created_at` and `updated_at`**, both `timestamptz` with `now()` defaults.
 *     Soft-delete happens only through `packages/privacy` (spec §7.1).
 *
 * Time. Business timestamps are `timestamptz` (AGENTS.md rule 10). The one exception is a JWT
 * claim mirror — `mandates.iat`/`exp` and `l1_credentials.iat`/`exp` — which is stored as **epoch
 * seconds `bigint`** because that is literally the unit of the signed token. Comparing a token claim
 * to `clock.nowSec()` must never involve a `Date` round trip, and a float there would be a precision
 * bug of exactly the kind this schema exists to prevent.
 *
 * Invariants, and where each one lives:
 *
 * | Invariant | Where | Test |
 * |---|---|---|
 * | `reserved + spent <= cap` (AT-M2.3) | SQL CHECK on `budget_accounts` | `schema.test.ts` |
 * | unique `l3_jti` = replay defence (EC-IDEM-1) | unique index on `checkout_attempts` | `schema.test.ts` |
 * | unique `idempotency_key` | unique index on `checkout_attempts` | `schema.test.ts` |
 * | unique `paypal_event_id` (EC-WH-2) | unique index on `webhook_events` | `schema.test.ts` |
 * | unique `paypal_order_id`, unique `attempt_id` | unique indexes on `orders` | `schema.test.ts` |
 * | `mandate.exp > mandate.iat` | SQL CHECK on `mandates` | `schema.test.ts` |
 * | `mandate.exp <= L1.exp` | **application code** — spans two tables, so no single CHECK can see both | documented below |
 * | budget mutation is serialised | `SELECT … FOR UPDATE` in `repos/budget.ts` | `schema.test.ts` (statement shape) |
 * | audit hash chain | `prev_hash` + `this_hash` columns, SHA-256 in `repos/audit.ts` | `schema.test.ts` |
 *
 * `mandate.exp <= l1_credentials.exp` is the one headline invariant that **cannot** be a SQL CHECK:
 * a CHECK constraint may only reference columns of its own row, and the L1 expiry lives in a
 * different table. `repos/mandates.ts` therefore validates it inside the same transaction that writes
 * the mandate, and `docs/DECISIONS.md` records the choice.
 *
 * Not one `money` column in this file is reachable by anything other than a repository in
 * `src/repos/`. See README.md, "No package bypasses a repo".
 */
import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  char,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import type {
  AgentId,
  AttemptId,
  AuditLogId,
  BudgetEntryId,
  CaptureRowId,
  CheckoutId,
  DisputeActionId,
  DisputeId,
  GateDecisionId,
  Id,
  L1Id,
  MandateId,
  OrderId,
  PacketId,
  PrivacyRequestId,
  RefundRowId,
  ShipmentId,
  UserId,
  WalletId,
  DeviceId,
} from '@countersign/core'
import { CURRENCIES, type Currency } from '@countersign/core'

/* ------------------------------------------------------------------------------------------ */
/* Column helpers                                                                                 */
/* ------------------------------------------------------------------------------------------ */

/**
 * PostgreSQL `bytea`. Drizzle's pg-core has no first-class bytea column, and spec §7.2 needs one
 * (`agents.enc_private_key`, `evidence_packets.pdf_bytes`). The `postgres` driver already exchanges
 * `bytea` as a `Buffer`, so the mapping is the identity — but it is declared here rather than
 * smuggled in as `any`.
 */
const byteaColumn = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
})

/**
 * Money in **integer minor units**. `mode: 'bigint'` is what makes the round trip lossless: the
 * driver hands back a `bigint` parsed from the decimal string Postgres stores, never a JS double.
 */
function minor(name: string) {
  return bigint(name, { mode: 'bigint' })
}

/**
 * ISO-4217 alphabetic code as `char(3)`. The `enum` option narrows the TypeScript type to
 * `Currency` from `@countersign/core`, so a typo'd currency is a compile error and not a `char(3)`
 * that silently reads back as `'US '`.
 */
function currency(name = 'currency') {
  return char(name, { length: 3, enum: CURRENCIES })
}

/** Business timestamp: UTC instant, `timestamptz`, materialised as a JS `Date`. */
function ts(name: string) {
  return timestamp(name, { withTimezone: true, mode: 'date' })
}

/** Every table has both, per spec §7.1. */
function createdAt() {
  return ts('created_at').notNull().defaultNow()
}

function updatedAt() {
  return ts('updated_at').notNull().defaultNow()
}

/**
 * The three columns every PayPal-mirrored row carries (spec §7.1).
 *
 * `paypal_id` is *not* included here because §7.2 gives each table its own name for it
 * (`paypal_order_id`, `paypal_capture_id`, `paypal_refund_id`, `paypal_dispute_id`,
 * `paypal_authorization_id`, `paypal_event_id`, `payment_token_id` + `payer_id` for a wallet). The
 * column **name** follows §7.2 so the other work packages find what the spec says they will find;
 * the *rule* (unique, mirrors PayPal, never used for lookups we can avoid) is the same everywhere.
 */
function paypalMirror() {
  return { raw: jsonb('raw').$type<JsonValue>(), fetched_at: ts('fetched_at') }
}

/** A JSON column body. Deliberately permissive: `jsonb` is validated at the boundary, not here. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

/* ------------------------------------------------------------------------------------------ */
/* Enums — closed sets from spec §3.3 and §7.2                                                                                                                  */
/* ------------------------------------------------------------------------------------------ */

export const walletStatusEnum = pgEnum('wallet_status', ['ACTIVE', 'DELETED'])
export const deviceStatusEnum = pgEnum('device_status', ['ACTIVE', 'LOST', 'REVOKED'])
export const l1StatusEnum = pgEnum('l1_status', ['ACTIVE', 'EXPIRED', 'REVOKED'])
export const agentStatusEnum = pgEnum('agent_status', ['ACTIVE', 'SUSPENDED', 'REVOKED'])

/** Spec §3.3 "Mandate". `SUSPENDED` is reachable from `ACTIVE` and returns to `ACTIVE`. */
export const mandateStatusEnum = pgEnum('mandate_status', [
  'DRAFT',
  'PENDING_SIGNATURE',
  'ACTIVE',
  'SUSPENDED',
  'EXHAUSTED',
  'EXPIRED',
  'REVOKED',
])

export const budgetEntryKindEnum = pgEnum('budget_entry_kind', [
  'RESERVE',
  'RELEASE',
  'COMMIT',
  'REVERSE',
])
export const walletCapPeriodEnum = pgEnum('wallet_cap_period', ['DAY', 'MONTH'])

export const checkoutSessionStatusEnum = pgEnum('checkout_session_status', [
  'CREATED',
  'SUBMITTED',
  'COMPLETED',
  'EXPIRED',
  'ABANDONED',
])

/** Spec §3.3 "Checkout attempt" — exactly those values, plus the `CAPTURE`-intent branch. */
export const checkoutAttemptStateEnum = pgEnum('checkout_attempt_state', [
  'CREATED',
  'GATED_ALLOW',
  'GATED_BLOCK',
  'ORDER_CREATED',
  'AUTHORIZED',
  'PARTIALLY_CAPTURED',
  'CAPTURED',
  'VOIDED',
  'AUTH_EXPIRED',
  'DECLINED',
  'PENDING_REVIEW',
])

export const gateDecisionEnum = pgEnum('gate_decision', ['ALLOW', 'BLOCK', 'REVIEW'])

/** D17: physical goods authorise first; digital goods capture up front. */
export const orderIntentEnum = pgEnum('order_intent', ['AUTHORIZE', 'CAPTURE'])

export const orderStatusEnum = pgEnum('order_status', [
  'ORDER_CREATED',
  'AUTHORIZED',
  'PARTIALLY_CAPTURED',
  'CAPTURED',
  'VOIDED',
  'CANCELLED',
  'DECLINED',
  'PENDING_REVIEW',
  'PAYMENT_FAILED',
  'AUTH_EXPIRED',
])

/** Mirrors the PayPal authorization lifecycle (spec §7.2, `expiration_time` 29 d / honour 3 d [V15]). */
export const authorizationStatusEnum = pgEnum('authorization_status', [
  'CREATED',
  'PENDING',
  'CAPTURED',
  'PARTIALLY_CAPTURED',
  'VOIDED',
  'DENIED',
  'EXPIRED',
])

/** Spec §3.3 "Capture" and the §8.12 status rank: PENDING(1) < COMPLETED(2) < PARTIALLY_REFUNDED(3) < REFUNDED(4). */
export const captureStatusEnum = pgEnum('capture_status', [
  'PENDING',
  'COMPLETED',
  'DECLINED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'REVERSED',
])

/** EC-REF-3: a FAILED refund must be retried with a *new* refund id, never by reusing the request id. */
export const refundStatusEnum = pgEnum('refund_status', ['PENDING', 'COMPLETED', 'FAILED'])
export const refundInitiatedByEnum = pgEnum('refund_initiated_by', [
  'USER',
  'MERCHANT',
  'DEFENDER',
  'DISPUTE',
])

/** PayPal tracker statuses [V11] for `POST /v1/shipping/trackers-batch`. */
export const shipmentStatusEnum = pgEnum('shipment_status', [
  'SHIPPED',
  'DELIVERED',
  'NOT_SHIPPED',
  'VOIDED',
  'FAILURE',
])

/**
 * Three states, not a boolean. EC-WH-7 requires storing an event whose verify-signature call was
 * unavailable ("don't act, retry later"), and a `bool` cannot distinguish "not checked yet" from
 * "checked and rejected" — and those two rows must be handled by completely different code.
 */
export const webhookVerifiedEnum = pgEnum('webhook_verified', ['PENDING', 'VERIFIED', 'FAILED'])

/** Spec §3.3 "Dispute" — stage/status mirror PayPal [B16]; transitions only via re-fetch. */
export const disputeStageEnum = pgEnum('dispute_stage', [
  'INQUIRY',
  'CHARGEBACK',
  'PRE_ARBITRATION',
  'ARBITRATION',
])

export const disputeStatusEnum = pgEnum('dispute_status', [
  'OPEN',
  'WAITING_FOR_BUYER_RESPONSE',
  'WAITING_FOR_SELLER_RESPONSE',
  'UNDER_REVIEW',
  'RESOLVED',
  'OTHER',
])

/** Our internal lifecycle; never a value PayPal sends. */
export const disputeDefenseStateEnum = pgEnum('dispute_defense_state', [
  'NEW',
  'ANALYSED',
  'AWAITING_MERCHANT_APPROVAL',
  'FILED',
  'OFFERED',
  'ACCEPTED',
  'CLOSED_WON',
  'CLOSED_LOST',
  'CLOSED_REFUNDED',
])

/** Spec §8.15 `Liability`. */
export const disputeLiabilityEnum = pgEnum('dispute_liability', [
  'USER_AUTHORISED',
  'AGENT_FAULT',
  'MERCHANT_FAULT',
  'UNPROVABLE',
  'ALREADY_REFUNDED',
])

export const disputeActionEnum = pgEnum('dispute_action', [
  'FILE',
  'OFFER',
  'ACCEPT',
  'MESSAGE',
  'APPEAL',
  'ACK_RETURN',
  'SUPPORTING_INFO',
  'ESCALATE',
])

export const privacyRequestKindEnum = pgEnum('privacy_request_kind', ['EXPORT', 'ERASE'])

/** `BLOCKED_LEGAL_HOLD` is EC-PRIV-1: an open dispute or the 540-day evidence window holds erasure. */
export const privacyRequestStatusEnum = pgEnum('privacy_request_status', [
  'RECEIVED',
  'IN_PROGRESS',
  'BLOCKED_LEGAL_HOLD',
  'SCHEDULED',
  'COMPLETED',
  'REJECTED',
])

export const jwksKeyRoleEnum = pgEnum('jwks_key_role', ['ISSUER', 'MERCHANT', 'GATE', 'AGENT'])

/** Retired keys are kept verify-only until the retention end (spec §12.9 EC-KEY-2/3). */
export const jwksKeyStatusEnum = pgEnum('jwks_key_status', ['ACTIVE', 'RETIRED', 'COMPROMISED'])

/* ------------------------------------------------------------------------------------------ */
/* 1. users                                                                                        */
/* ------------------------------------------------------------------------------------------ */

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  /**
   * Which demo persona this row is (`BUYER` / `MERCHANT` / `JUDGE`). Plain text, not an enum: a
   * persona is a label on the landing page, not a state machine, and the demo picker is allowed to
   * grow one without a migration.
   */
  persona: text('persona').notNull(),
  display_name: text('display_name').notNull(),
  email: text('email').notNull(),
  /** ISO 3166-1 alpha-2. Drives the flat shipping fee (spec §8.9) and the DPDP notice. */
  country: char('country', { length: 2 }).notNull(),
  /** §12.13 DPDP/GDPR notice acknowledgement; null means not yet shown. */
  dpdp_notice_ack_at: ts('dpdp_notice_ack_at'),
  created_at: createdAt(),
  updated_at: updatedAt(),
})

/* ------------------------------------------------------------------------------------------ */
/* 2. paypal_wallets                                                                               */
/* ------------------------------------------------------------------------------------------ */

/**
 * §7.2 calls the vault identifier `payment_token_id` (unique) — that is the exact value
 * `payment_source.paypal.vault_id` needs in `POST /v2/checkout/orders` [V10], so the name is kept
 * verbatim even though the generic §7.1 rule is called `paypal_id`. It is unique for the same
 * reason `paypal_id` is unique everywhere else: it is our mirror of a PayPal object.
 */
export const paypalWallets = pgTable(
  'paypal_wallets',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id),
    /** PayPal vault (payment-token) id — the `vault_id` on every order create. */
    payment_token_id: text('payment_token_id').notNull(),
    payer_id: text('payer_id').notNull(),
    payer_email: text('payer_email').notNull(),
    status: walletStatusEnum('status').notNull().default('ACTIVE'),
    /** PayPal customer id, used by the dispute/refund APIs that address a buyer. */
    customer_id: text('customer_id'),
    ...paypalMirror(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    // Order create looks the wallet up by vault id; a duplicate would mean two rows for one token.
    uniqueIndex('paypal_wallets_payment_token_id_key').on(t.payment_token_id),
    // "Every mandate/attempt under this wallet" — Gate check 9 and the wallet page both scan here.
    index('paypal_wallets_user_id_idx').on(t.user_id),
  ],
)

/* ------------------------------------------------------------------------------------------ */
/* 3. devices                                                                                      */
/* ------------------------------------------------------------------------------------------ */

export const devices = pgTable(
  'devices',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id),
    /** Device public key. The device signs L2 payloads; the private half never leaves the browser. */
    public_jwk: jsonb('public_jwk').$type<JsonValue>().notNull(),
    /** RFC 7638 thumbprint. Bound inside the L1, so this is a lookup key and a dedupe key. */
    jkt: text('jkt').notNull(),
    label: text('label').notNull(),
    webauthn_credential_id: text('webauthn_credential_id'),
    status: deviceStatusEnum('status').notNull().default('ACTIVE'),
    last_used_at: ts('last_used_at'),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    // §7.2: "Unique (user_id, jkt)". One device key per user, enforced rather than hoped for.
    uniqueIndex('devices_user_id_jkt_key').on(t.user_id, t.jkt),
    // Gate check 3 loads the device behind a mandate by user + thumbprint.
    index('devices_user_id_status_idx').on(t.user_id, t.status),
  ],
)

/* ------------------------------------------------------------------------------------------ */
/* 4. l1_credentials                                                                               */
/* ------------------------------------------------------------------------------------------ */

export const l1Credentials = pgTable(
  'l1_credentials',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id),
    device_id: text('device_id')
      .notNull()
      .references(() => devices.id),
    wallet_id: text('wallet_id')
      .notNull()
      .references(() => paypalWallets.id),
    /** The SD-JWT itself; selective disclosure is a privacy feature, not a redaction (EC-PRIV-3). */
    sd_jwt: text('sd_jwt').notNull(),
    issuer_kid: text('issuer_kid').notNull(),
    /** Epoch seconds, mirroring the JWT claims exactly — see the file header. */
    iat: bigint('iat', { mode: 'bigint' }).notNull(),
    exp: bigint('exp', { mode: 'bigint' }).notNull(),
    status: l1StatusEnum('status').notNull().default('ACTIVE'),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    // §7.2: "One per device×wallet" — re-onboarding the same pair must not mint a second L1.
    uniqueIndex('l1_credentials_device_id_wallet_id_key').on(t.device_id, t.wallet_id),
    // Every mandate resolves its L1 by device; the Gate's chain check reads it on every request.
    index('l1_credentials_user_id_status_idx').on(t.user_id, t.status),
    check('l1_credentials_exp_gt_iat', sql`${t.exp} > ${t.iat}`),
  ],
)

/* ------------------------------------------------------------------------------------------ */
/* 5. agents                                                                                       */
/* ------------------------------------------------------------------------------------------ */

export const agents = pgTable(
  'agents',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    public_jwk: jsonb('public_jwk').$type<JsonValue>().notNull(),
    /** JWS `kid`. Bound by the L2, so the Gate can prove an L3 came from this agent. */
    kid: text('kid').notNull(),
    /** AES-256-GCM ciphertext under `VI_KEK`. Never plaintext, never in a log. */
    enc_private_key: byteaColumn('enc_private_key').notNull(),
    status: agentStatusEnum('status').notNull().default('ACTIVE'),
    /** Previous agent id on rotation (EC-AGT-4); null on first enrolment. */
    rotated_from: text('rotated_from'),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    // Mandate editor lists a user's agents; Gate check 2 loads one by id.
    index('agents_user_id_status_idx').on(t.user_id, t.status),
    // `kid` is what an incoming L3 header carries.
    uniqueIndex('agents_kid_key').on(t.kid),
  ],
)

/* ------------------------------------------------------------------------------------------ */
/* 6. mandates                                                                                     */
/* ------------------------------------------------------------------------------------------ */

export const mandates = pgTable(
  'mandates',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id),
    device_id: text('device_id')
      .notNull()
      .references(() => devices.id),
    agent_id: text('agent_id')
      .notNull()
      .references(() => agents.id),
    wallet_id: text('wallet_id')
      .notNull()
      .references(() => paypalWallets.id),
    /** The signed `sd-jwt+kb` exactly as the browser sent it. Byte-for-byte is the evidence. */
    l2_serialized: text('l2_serialized').notNull(),
    /** Decoded L2, kept so the defender can show the buyer what was signed (spec §12.8). */
    l2_payload: jsonb('l2_payload').$type<JsonValue>().notNull(),
    /** The plain-English sentence the user typed; the attribute diff in R-SNAD-AGENT reads it. */
    nl_intent: text('nl_intent').notNull(),
    /** The deterministic read-back the user actually approved. Quoted verbatim in evidence. */
    readback: text('readback').notNull(),
    constraints: jsonb('constraints').$type<JsonValue>().notNull(),
    nonce: text('nonce').notNull(),
    aud: text('aud').notNull(),
    /** Epoch seconds, mirroring the JWT claims — see the file header. */
    iat: bigint('iat', { mode: 'bigint' }).notNull(),
    exp: bigint('exp', { mode: 'bigint' }).notNull(),
    status: mandateStatusEnum('status').notNull().default('DRAFT'),
    revoked_at: ts('revoked_at'),
    revoked_reason: text('revoked_reason'),
    /** WebAuthn assertion present at signing (D4); drives the R-UNAUTH-1 / R-UNAUTH-2 split. */
    webauthn_assertion: jsonb('webauthn_assertion').$type<JsonValue>(),
    /** Which model compiled the intent, recorded so a bad compile can be attributed (AGENTS.md rule 4). */
    compiler_model: text('compiler_model').notNull(),
    compiler_trace_id: text('compiler_trace_id'),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    check('mandates_exp_gt_iat', sql`${t.exp} > ${t.iat}`),
    // §7.2: "exp ≤ L1 exp" is checked in `repos/mandates.ts`, because a CHECK cannot span two tables.
    // The wallet is the natural lookup: the wallet page and Gate check 9 group mandates per wallet.
    index('mandates_wallet_id_status_idx').on(t.wallet_id, t.status),
    // Gate check 1 loads one mandate; the mandate list loads by user.
    index('mandates_user_id_status_idx').on(t.user_id, t.status),
    // Rotation (EC-AGT-4) has to find the old agent's mandates.
    index('mandates_agent_id_status_idx').on(t.agent_id, t.status),
  ],
)

/* ------------------------------------------------------------------------------------------ */
/* 7. budget_accounts                                                                              */
/* ------------------------------------------------------------------------------------------ */

export const budgetAccounts = pgTable(
  'budget_accounts',
  {
    /** PK is the mandate: one budget per mandate, so EC-MA-1's cross-mandate cap lives in wallet_caps. */
    mandate_id: text('mandate_id')
      .primaryKey()
      .references(() => mandates.id),
    currency: currency().notNull(),
    cap_minor: minor('cap_minor').notNull(),
    /**
     * Defaulted with `sql\`0\`` rather than `0n`. `drizzle-kit` serialises the schema snapshot with
     * `JSON.stringify`, and a BigInt throws `TypeError: Do not know how to serialize a BigInt` — so a
     * `.default(0n)` here would make `drizzle-kit generate` fail outright and leave the repository with
     * no migrations at all. The emitted DDL is identical.
     */
    reserved_minor: minor('reserved_minor')
      .notNull()
      .default(sql`0`),
    spent_minor: minor('spent_minor')
      .notNull()
      .default(sql`0`),
    /**
     * Optimistic-concurrency token handed to the Gate (§8.10 check 8 returns `budgetVersion`).
     * Bumped on every mutation so a decision record pins the exact balance it approved.
     */
    version: integer('version').notNull().default(0),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    /**
     * AT-M2.3. `reserved + spent <= cap` is a CHECK so a buggy or bypassed code path still cannot
     * over-commit a buyer's signed limit. It is the backstop *behind* the `SELECT … FOR UPDATE`
     * check in `repos/budget.ts`; the lock makes the read-modify-write correct, the CHECK makes the
     * invariant true even if something else writes the row.
     */
    check(
      'budget_accounts_reserved_plus_spent_le_cap',
      sql`${t.reserved_minor} + ${t.spent_minor} <= ${t.cap_minor}`,
    ),
    check('budget_accounts_non_negative', sql`${t.reserved_minor} >= 0 AND ${t.spent_minor} >= 0`),
    check('budget_accounts_cap_non_negative', sql`${t.cap_minor} >= 0`),
  ],
)

/* ------------------------------------------------------------------------------------------ */
/* 8. wallet_caps                                                                                  */
/* ------------------------------------------------------------------------------------------ */

export const walletCaps = pgTable(
  'wallet_caps',
  {
    /** PK is the wallet: one cap per wallet, shared by every mandate and agent under it (EC-MA-1). */
    wallet_id: text('wallet_id')
      .primaryKey()
      .references(() => paypalWallets.id),
    period: walletCapPeriodEnum('period').notNull(),
    cap_minor: minor('cap_minor').notNull(),
    currency: currency().notNull(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [check('wallet_caps_cap_non_negative', sql`${t.cap_minor} >= 0`)],
)

/* ------------------------------------------------------------------------------------------ */
/* 9. budget_entries                                                                               */
/* ------------------------------------------------------------------------------------------ */

/**
 * Append-only. `budget_accounts` is a cache of `SUM(amount_minor)` grouped by kind, and
 * `repos/budget.ts::reconcile` recomputes it from here — spec §7.2: "balances must equal the sum of
 * entries (nightly check)". Nothing in this codebase issues an UPDATE or DELETE against this table.
 */
export const budgetEntries = pgTable(
  'budget_entries',
  {
    id: text('id').primaryKey(),
    mandate_id: text('mandate_id')
      .notNull()
      .references(() => mandates.id),
    attempt_id: text('attempt_id'),
    kind: budgetEntryKindEnum('kind').notNull(),
    amount_minor: minor('amount_minor').notNull(),
    /** §7.1: `timestamptz` in the database. Displayed in IST only at the edge. */
    at: ts('at').notNull().defaultNow(),
    /** Set on RELEASE/COMMIT/REVERSE so a drift report can name the cause. */
    reason: text('reason'),
    /** Capture this entry settled or reversed (COMMIT/REVERSE); null for RESERVE/RELEASE. */
    capture_id: text('capture_id'),
    currency: currency().notNull(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    // The nightly reconcile sums by mandate; the receipt timeline reads one attempt's entries in order.
    index('budget_entries_mandate_id_at_idx').on(t.mandate_id, t.at),
    index('budget_entries_attempt_id_idx').on(t.attempt_id),
    // Gate check 11 counts COMMITs inside a recurrence window.
    index('budget_entries_mandate_id_kind_at_idx').on(t.mandate_id, t.kind, t.at),
    check('budget_entries_amount_non_negative', sql`${t.amount_minor} >= 0`),
  ],
)

/* ------------------------------------------------------------------------------------------ */
/* 10. products                                                                                    */
/* ------------------------------------------------------------------------------------------ */

export const products = pgTable(
  'products',
  {
    /** SKU is the natural key: it is what `search_products` filters on and what a cart line holds. */
    sku: text('sku').primaryKey(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    price_minor: minor('price_minor').notNull(),
    currency: currency().notNull(),
    stock: integer('stock').notNull(),
    ships_in_days: integer('ships_in_days').notNull(),
    /** D17: a digital item is captured up front instead of authorised-then-captured. */
    digital: boolean('digital').notNull().default(false),
    /**
     * Untrusted merchant text. §8.9 returns it inside a `untrusted_text` wrapper, and §8.13/AT-M13.2
     * relies on the three seeded injection payloads here. Never render it as trusted markup.
     */
    listing_html: text('listing_html').notNull(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    check('products_price_minor_non_negative', sql`${t.price_minor} >= 0`),
    // EC-STOCK-3: the last-unit race decrements under a row lock, so stock may never go negative.
    check('products_stock_non_negative', sql`${t.stock} >= 0`),
    // `search_products {query, max_price_minor?}` compares against this.
    index('products_price_idx').on(t.price_minor),
  ],
)

/* ------------------------------------------------------------------------------------------ */
/* 11. checkout_sessions                                                                           */
/* ------------------------------------------------------------------------------------------ */

export const checkoutSessions = pgTable(
  'checkout_sessions',
  {
    id: text('id').primaryKey(),
    /** PayPal merchant account id (the payee on every unit). */
    merchant_id: text('merchant_id').notNull(),
    /** `{lines:[{sku, qty, unit_minor}]}` — the allocation basis for split captures (EC-FX-4). */
    cart: jsonb('cart').$type<JsonValue>().notNull(),
    subtotal_minor: minor('subtotal_minor').notNull(),
    /** Tax is 0 in the demo (stated in the README, §8.9) — kept as a column so that is a config, not a schema. */
    // `sql`0`` not `0n` — drizzle-kit serialises snapshots with JSON.stringify and a BigInt throws
    // "Do not know how to serialize a BigInt", which would make `drizzle-kit generate` fail outright.
    tax_minor: minor('tax_minor')
      .notNull()
      .default(sql`0`),
    /** Flat fee per destination country (§8.9). */
    shipping_minor: minor('shipping_minor').notNull(),
    total_minor: minor('total_minor').notNull(),
    currency: currency().notNull(),
    /** JWS signed by the merchant key. Gate check 5 verifies its hash against the L3b. */
    checkout_jwt: text('checkout_jwt').notNull(),
    checkout_hash: text('checkout_hash').notNull(),
    price_lock_exp: ts('price_lock_exp').notNull(),
    status: checkoutSessionStatusEnum('status').notNull().default('CREATED'),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    // Gate check 6 compares the locked total against the L3a amount, so sessions load by id fast.
    index('checkout_sessions_status_price_lock_exp_idx').on(t.status, t.price_lock_exp),
    check(
      'checkout_sessions_total_matches_parts',
      sql`${t.total_minor} = ${t.subtotal_minor} + ${t.tax_minor} + ${t.shipping_minor}`,
    ),
  ],
)

/* ------------------------------------------------------------------------------------------ */
/* 12. checkout_attempts                                                                           */
/* ------------------------------------------------------------------------------------------ */

/**
 * One row per agent submission. This is the replay boundary: `l3_jti` is unique, so a retried LLM
 * turn cannot produce a second purchase (EC-IDEM-1). `idempotency_key` is unique for the same reason
 * on the HTTP path, and both map a Postgres 23505 to `CS_CONFLICT` (AT-M2.4).
 */
export const checkoutAttempts = pgTable(
  'checkout_attempts',
  {
    id: text('id').primaryKey(),
    mandate_id: text('mandate_id')
      .notNull()
      .references(() => mandates.id),
    agent_id: text('agent_id')
      .notNull()
      .references(() => agents.id),
    checkout_session_id: text('checkout_session_id')
      .notNull()
      .references(() => checkoutSessions.id),
    /** Key-bound JWT over the payment. */
    l3a: text('l3a').notNull(),
    /** Checkout JWT re-signed by the agent key, binding `checkout_hash`. */
    l3b: text('l3b').notNull(),
    /**
     * The L3 `jti`. UNIQUE — this index *is* the replay defence (spec §7.2, Gate check 7). The
     * violation is what turns a replay into `GATE_REPLAY` rather than a second charge.
     */
    l3_jti: text('l3_jti').notNull(),
    /** Deterministic caller-supplied key; UNIQUE so a double-clicked submit is one row. */
    idempotency_key: text('idempotency_key').notNull(),
    amount_minor: minor('amount_minor').notNull(),
    currency: currency().notNull(),
    payee: text('payee').notNull(),
    /** Spec §3.3 "Checkout attempt". */
    state: checkoutAttemptStateEnum('state').notNull().default('CREATED'),
    /**
     * Set after the Gate decides. Intentionally **not** a foreign key: `gate_decisions.attempt_id`
     * points back here, and a CHECK/FK pair between two tables that reference each other cannot be
     * created in one pass. `repos/gate.ts` writes the decision first and links it after.
     */
    gate_decision_id: text('gate_decision_id'),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    uniqueIndex('checkout_attempts_l3_jti_key').on(t.l3_jti),
    uniqueIndex('checkout_attempts_idempotency_key_key').on(t.idempotency_key),
    // Gate check 7 and the replay-lookup "is this checkout already in flight?" both scan by mandate.
    index('checkout_attempts_mandate_id_idx').on(t.mandate_id),
    // A cart maps to at most one live attempt; EC-IDEM-1's second half.
    index('checkout_attempts_checkout_session_id_idx').on(t.checkout_session_id),
    // Gate check 12 velocity guard: "attempts per mandate in the last 10 minutes".
    index('checkout_attempts_mandate_id_created_at_idx').on(t.mandate_id, t.created_at),
  ],
)

/* ------------------------------------------------------------------------------------------ */
/* 13. gate_decisions                                                                              */
/* ------------------------------------------------------------------------------------------ */

/** Immutable (spec §7.2). A re-run writes a new row; nothing ever updates this table. */
export const gateDecisions = pgTable(
  'gate_decisions',
  {
    id: text('id').primaryKey(),
    attempt_id: text('attempt_id')
      .notNull()
      .references(() => checkoutAttempts.id),
    decision: gateDecisionEnum('decision').notNull(),
    /** `[{code, message, path}]` — shown to the agent and the buyer (spec §8.10). */
    reasons: jsonb('reasons').$type<JsonValue>().notNull(),
    /** One entry per Gate check 1..12, so a BLOCK can be read as "which check, and why". */
    checks: jsonb('checks').$type<JsonValue>().notNull(),
    chain_valid: boolean('chain_valid').notNull(),
    /** Pinned Verifiable Intent commit so old evidence verifies against the code that ran. */
    vi_lib_commit: text('vi_lib_commit').notNull(),
    /** JWS by `GATE_KID`; payload `{gdc, att, mdt, amount, currency, payee, checks_hash, …}`. */
    signed_record: text('signed_record').notNull(),
    decided_at: ts('decided_at').notNull().defaultNow(),
    /** Budget version approved by check 8, so a decision pins the exact balance it reserved against. */
    budget_version: integer('budget_version'),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    index('gate_decisions_attempt_id_idx').on(t.attempt_id),
    // The merchant UI filters the decision log by outcome.
    index('gate_decisions_decision_decided_at_idx').on(t.decision, t.decided_at),
  ],
)

/* ------------------------------------------------------------------------------------------ */
/* 14. orders                                                                                       */
/* ------------------------------------------------------------------------------------------ */

export const orders = pgTable(
  'orders',
  {
    id: text('id').primaryKey(),
    /** UNIQUE — one order per attempt. The 23505 here is the idempotency backstop for M11 AT-M11.5. */
    attempt_id: text('attempt_id')
      .notNull()
      .references(() => checkoutAttempts.id),
    /** UNIQUE — mirrors the PayPal order id. */
    paypal_order_id: text('paypal_order_id').notNull(),
    intent: orderIntentEnum('intent').notNull(),
    /**
     * `"cs1:" + base64url(sha256(JCS(bundle without paypal/shipments)))` [V11]. The only string
     * that ties an evidence packet to a PayPal transaction, so it is indexed for the dispute router.
     */
    custom_id: text('custom_id').notNull(),
    invoice_id: text('invoice_id').notNull(),
    status: orderStatusEnum('status').notNull().default('ORDER_CREATED'),
    /** Order total; the receipt, the defender and R-AMT-1/2 all compare against it. */
    amount_minor: minor('amount_minor').notNull(),
    currency: currency().notNull(),
    ...paypalMirror(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    uniqueIndex('orders_paypal_order_id_key').on(t.paypal_order_id),
    uniqueIndex('orders_attempt_id_key').on(t.attempt_id),
    // `custom_id` is how the webhook handler and the public verifier find the order from PayPal.
    index('orders_custom_id_idx').on(t.custom_id),
    // Nightly reconciler: "non-terminal orders updated in the last 30 days" (§8.12).
    index('orders_status_updated_at_idx').on(t.status, t.updated_at),
  ],
)

/* ------------------------------------------------------------------------------------------ */
/* 15. authorizations                                                                              */
/* ------------------------------------------------------------------------------------------ */

export const authorizations = pgTable(
  'authorizations',
  {
    id: text('id').primaryKey(),
    order_id: text('order_id')
      .notNull()
      .references(() => orders.id),
    paypal_authorization_id: text('paypal_authorization_id').notNull(),
    amount_minor: minor('amount_minor').notNull(),
    /**
     * §7.1 requires a currency beside every money column; §7.2 abbreviates it here because the
     * currency is implied by the order. It is stored anyway — an amount without a currency is not a
     * `Money`, and a receipt that guesses its currency is a bug someone finds at reconciliation.
     */
    currency: currency().notNull(),
    status: authorizationStatusEnum('status').notNull().default('CREATED'),
    /** PayPal's own 29-day expiry [V15]. */
    expiration_time: ts('expiration_time').notNull(),
    /** 3 days after expiry; `reauthorizeIfNeeded` runs inside this window (EC-TIME-5). */
    honor_expires_at: ts('honor_expires_at').notNull(),
    ...paypalMirror(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    uniqueIndex('authorizations_paypal_authorization_id_key').on(t.paypal_authorization_id),
    // Σ captures ≤ authorized is checked by loading the auth's captures per order.
    index('authorizations_order_id_idx').on(t.order_id),
    // The EC-TIME-5 cron: "authorizations expiring within 3 days".
    index('authorizations_status_expiration_time_idx').on(t.status, t.expiration_time),
  ],
)

/* ------------------------------------------------------------------------------------------ */
/* 16. captures                                                                                    */
/* ------------------------------------------------------------------------------------------ */

export const captures = pgTable(
  'captures',
  {
    id: text('id').primaryKey(),
    order_id: text('order_id')
      .notNull()
      .references(() => orders.id),
    /** Null on the CAPTURE-intent path, where capture follows the order directly. */
    authorization_id: text('authorization_id').references(() => authorizations.id),
    paypal_capture_id: text('paypal_capture_id').notNull(),
    amount_minor: minor('amount_minor').notNull(),
    currency: currency().notNull(),
    /** True on the capture that closes the authorization; PayPal releases the rest [B12] (EC-CAP-2). */
    final_capture: boolean('final_capture').notNull().default(false),
    status: captureStatusEnum('status').notNull().default('PENDING'),
    /** Denormalised for the evidence packet's shipment list; `shipments.order_id` is the query index. */
    shipment_id: text('shipment_id'),
    /** Running refund total, so an over-refund is rejected locally before calling PayPal (EC-REF-2). */
    // `sql`0`` not `0n` — see the note on `budget_accounts.reserved_minor` about drizzle-kit snapshots.
    refunded_minor: minor('refunded_minor')
      .notNull()
      .default(sql`0`),
    /** Chargeback (EC-REF-3 / "chargeback reversal → REVERSE entry for the audit only"). */
    reversed: boolean('reversed').notNull().default(false),
    ...paypalMirror(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    uniqueIndex('captures_paypal_capture_id_key').on(t.paypal_capture_id),
    index('captures_order_id_idx').on(t.order_id),
    // §8.12 reconciler: "captures not terminal and updated in the last 30 days".
    index('captures_status_updated_at_idx').on(t.status, t.updated_at),
    check('captures_amount_minor_non_negative', sql`${t.amount_minor} >= 0`),
    // A refund can never exceed what was captured; checked in-repo against this column.
    check('captures_refunded_lte_amount', sql`${t.refunded_minor} <= ${t.amount_minor}`),
  ],
)

/* ------------------------------------------------------------------------------------------ */
/* 17. refunds                                                                                     */
/* ------------------------------------------------------------------------------------------ */

export const refunds = pgTable(
  'refunds',
  {
    id: text('id').primaryKey(),
    capture_id: text('capture_id')
      .notNull()
      .references(() => captures.id),
    paypal_refund_id: text('paypal_refund_id').notNull(),
    amount_minor: minor('amount_minor').notNull(),
    currency: currency().notNull(),
    status: refundStatusEnum('status').notNull().default('PENDING'),
    /** PayPal refund `reason_code`, kept for the case file. */
    reason_code: text('reason_code'),
    initiated_by: refundInitiatedByEnum('initiated_by').notNull(),
    /** EC-PRIV/§12.13 provenance; also the actor shown in the merchant timeline. */
    actor: text('actor'),
    /** Free-text justification stored with the refund; the router/notes reference it. */
    note: text('note'),
    ...paypalMirror(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    uniqueIndex('refunds_paypal_refund_id_key').on(t.paypal_refund_id),
    index('refunds_capture_id_idx').on(t.capture_id),
    // The buyer-facing "refund processing" timeline.
    index('refunds_status_created_at_idx').on(t.status, t.created_at),
    check('refunds_amount_minor_non_negative', sql`${t.amount_minor} >= 0`),
  ],
)

/* ------------------------------------------------------------------------------------------ */
/* 18. shipments                                                                                   */
/* ------------------------------------------------------------------------------------------ */

export const shipments = pgTable(
  'shipments',
  {
    id: text('id').primaryKey(),
    order_id: text('order_id')
      .notNull()
      .references(() => orders.id),
    /** `[{sku, qty}]` — the subset this shipment covers (EC-CAP-1, EC-SPLIT-1). */
    lines: jsonb('lines').$type<JsonValue>().notNull(),
    carrier: text('carrier').notNull(),
    tracking_number: text('tracking_number').notNull(),
    /** PayPal tracker id from `POST /v1/shipping/trackers-batch` [V11]. */
    paypal_tracker_id: text('paypal_tracker_id'),
    status: shipmentStatusEnum('status').notNull().default('SHIPPED'),
    ...paypalMirror(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    // R-INR-1/R-INR-2: "is there a shipment with tracking for the disputed lines?" keys off order.
    index('shipments_order_id_idx').on(t.order_id),
    uniqueIndex('shipments_paypal_tracker_id_key').on(t.paypal_tracker_id),
    index('shipments_tracking_number_idx').on(t.tracking_number),
  ],
)

/* ------------------------------------------------------------------------------------------ */
/* 19. webhook_events                                                                              */
/* ------------------------------------------------------------------------------------------ */

export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: text('id').primaryKey(),
    /**
     * UNIQUE — the dedupe key (spec §7.2, EC-WH-2). PayPal retries the same event up to 25 times
     * over 3 days [V14]; §8.12 step 3 is `INSERT … ON CONFLICT (paypal_event_id) DO NOTHING` and
     * an unconditional 200.
     */
    paypal_event_id: text('paypal_event_id').notNull(),
    event_type: text('event_type').notNull(),
    resource_type: text('resource_type').notNull(),
    resource_id: text('resource_id').notNull(),
    /** PayPal's own `create_time`, used to skip stale payloads (EC-WH-3). */
    create_time: ts('create_time').notNull(),
    /** PENDING | VERIFIED | FAILED — see `webhookVerifiedEnum`. */
    verified: webhookVerifiedEnum('verified').notNull().default('PENDING'),
    verified_at: ts('verified_at'),
    raw: jsonb('raw').$type<JsonValue>().notNull(),
    received_at: ts('received_at').notNull().defaultNow(),
    processed_at: ts('processed_at'),
    /** Processing attempts so the worker can back off instead of hot-looping. */
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    uniqueIndex('webhook_events_paypal_event_id_key').on(t.paypal_event_id),
    // §8.12 step 4: the job's singleton key is `resource_id`, and the reconciler sweeps by it too.
    index('webhook_events_resource_id_idx').on(t.resource_id),
    // The unprocessed queue, oldest first.
    index('webhook_events_processed_at_received_at_idx').on(t.processed_at, t.received_at),
  ],
)

/* ------------------------------------------------------------------------------------------ */
/* 20. disputes                                                                                    */
/* ------------------------------------------------------------------------------------------ */

export const disputes = pgTable(
  'disputes',
  {
    id: text('id').primaryKey(),
    paypal_dispute_id: text('paypal_dispute_id').notNull(),
    /** Null until a Countersign order is matched via `custom_id` (R-NOCHAIN-1). */
    order_id: text('order_id').references(() => orders.id),
    capture_id: text('capture_id').references(() => captures.id),
    reason: text('reason').notNull(),
    stage: disputeStageEnum('stage').notNull(),
    status: disputeStatusEnum('status').notNull(),
    amount_minor: minor('amount_minor').notNull(),
    currency: currency().notNull(),
    /** RFC 3339 → `timestamptz` (EC-TIME-6); displayed in IST only at the edge. */
    seller_response_due_date: ts('seller_response_due_date'),
    buyer_response_due_date: ts('buyer_response_due_date'),
    ...paypalMirror(),
    defense_state: disputeDefenseStateEnum('defense_state').notNull().default('NEW'),
    /** Assigned by the deterministic router (spec §8.15); null until it has run. */
    liability: disputeLiabilityEnum('liability'),
    /** Why the router decided what it did: rule id + the facts it compared (spec §8.15 `R-…`). */
    router_trace: jsonb('router_trace').$type<JsonValue>(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    uniqueIndex('disputes_paypal_dispute_id_key').on(t.paypal_dispute_id),
    // The Defender's work queue: "everything not yet closed", keyed by our own stage machine.
    index('disputes_defense_state_idx').on(t.defense_state),
    // §8.15 filing guards and the S-17 deadline timeline both order by the seller deadline.
    index('disputes_seller_response_due_date_idx').on(t.seller_response_due_date),
    index('disputes_status_updated_at_idx').on(t.status, t.updated_at),
    index('disputes_order_id_idx').on(t.order_id),
  ],
)

/* ------------------------------------------------------------------------------------------ */
/* 21. evidence_packets                                                                            */
/* ------------------------------------------------------------------------------------------ */

/**
 * Immutable once `filed_at` is set: re-filing creates a new row with `version + 1` (the PayPal
 * idempotency key is `cs:{disputeId}:file:{version}`, spec §8.15).
 */
export const evidencePackets = pgTable(
  'evidence_packets',
  {
    id: text('id').primaryKey(),
    dispute_id: text('dispute_id')
      .notNull()
      .references(() => disputes.id),
    version: integer('version').notNull().default(1),
    /** The §7.3 canonical-JSON bundle. Public view = the redacted subset. */
    bundle: jsonb('bundle').$type<JsonValue>().notNull(),
    /** sha256 over the RFC 8785 JCS encoding of `bundle`; equals the `custom_id` payload. */
    bundle_hash: text('bundle_hash').notNull(),
    /** The rendered PDF. ≤ 10 MB [V8]; stored as `bytea`, never in the bundle. */
    pdf_bytes: byteaColumn('pdf_bytes'),
    pdf_sha256: text('pdf_sha256'),
    /** Spec §7.2 / §8.15: notes are ≤ 2000 chars. Enforced by CHECK, not by convention. */
    notes: text('notes'),
    citations: jsonb('citations').$type<JsonValue>(),
    citation_check: jsonb('citation_check').$type<JsonValue>(),
    filed_at: ts('filed_at'),
    paypal_response: jsonb('paypal_response').$type<JsonValue>(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    // The public verifier serves the newest packet per dispute; history stays for the case file.
    index('evidence_packets_dispute_id_idx').on(t.dispute_id),
    uniqueIndex('evidence_packets_dispute_id_version_key').on(t.dispute_id, t.version),
    check(
      'evidence_packets_notes_le_2000',
      sql`${t.notes} IS NULL OR char_length(${t.notes}) <= 2000`,
    ),
    check('evidence_packets_version_positive', sql`${t.version} >= 1`),
  ],
)

/* ------------------------------------------------------------------------------------------ */
/* 22. dispute_actions                                                                             */
/* ------------------------------------------------------------------------------------------ */

/** Every PayPal dispute API call we made, in order: what was sent, what came back, by whom. */
export const disputeActions = pgTable(
  'dispute_actions',
  {
    id: text('id').primaryKey(),
    dispute_id: text('dispute_id')
      .notNull()
      .references(() => disputes.id),
    action: disputeActionEnum('action').notNull(),
    request: jsonb('request').$type<JsonValue>().notNull(),
    response: jsonb('response').$type<JsonValue>(),
    /** USER | MERCHANT | DEFENDER | STRATEGIST — who triggered it. */
    actor: text('actor').notNull(),
    /** Deterministic per (dispute, action, attempt) so a retry does not double-file. */
    idempotency_key: text('idempotency_key').notNull(),
    at: ts('at').notNull().defaultNow(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    uniqueIndex('dispute_actions_idempotency_key_key').on(t.idempotency_key),
    // The S-17 Bryntum timeline is "every action on this dispute, in order".
    index('dispute_actions_dispute_id_at_idx').on(t.dispute_id, t.at),
  ],
)

/* ------------------------------------------------------------------------------------------ */
/* 23. audit_log                                                                                   */
/* ------------------------------------------------------------------------------------------ */

/**
 * Append-only **and hash-chained** (spec §7.2). `this_hash = sha256(canonicalJson(entry ‖ prev_hash))`,
 * computed by `repos/audit.ts::computeAuditHash`. Deleting or editing any row breaks the chain from
 * that point on, which is what makes the log evidence rather than a log line.
 *
 * `prev_hash` is null only for the first row in a chain; chains are per `chain_id` so one tenant's
 * gap does not invalidate another's.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    chain_id: text('chain_id').notNull(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    /** What was acted on — a prefixed id (`mdt_…`, `ord_…`, `prv_…`). */
    subject: text('subject').notNull(),
    at: ts('at').notNull().defaultNow(),
    /** sha256 of the client IP. Never the raw address: EC-PRIV-2/§12.13 want hashes, not PII. */
    ip_hash: text('ip_hash'),
    details: jsonb('details').$type<JsonValue>(),
    prev_hash: text('prev_hash'),
    this_hash: text('this_hash').notNull(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    // The chain walk: "next row in this chain, in insertion order".
    index('audit_log_chain_id_at_idx').on(t.chain_id, t.at),
    // Privacy export and the dispute timeline both read by subject.
    index('audit_log_subject_idx').on(t.subject),
    uniqueIndex('audit_log_chain_id_this_hash_key').on(t.chain_id, t.this_hash),
  ],
)

/* ------------------------------------------------------------------------------------------ */
/* 24. privacy_requests                                                                            */
/* ------------------------------------------------------------------------------------------ */

/** §12.13 GDPR Art. 17 / DPDP. `legal_hold_reason` is nullable: null means no hold is in force. */
export const privacyRequests = pgTable(
  'privacy_requests',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id),
    kind: privacyRequestKindEnum('kind').notNull(),
    status: privacyRequestStatusEnum('status').notNull().default('RECEIVED'),
    /**
     * Why erasure is being held: `"open dispute dsp_…"`, `"evidence window until 2027-05-27"`.
     * Null ⇒ proceed. Non-null ⇒ `packages/privacy` returns `PRIVACY_LEGAL_HOLD` and schedules.
     */
    legal_hold_reason: text('legal_hold_reason'),
    /** DPDP Rule 8(2): the earliest date the purge may run (48 h after the request). */
    scheduled_for: ts('scheduled_for'),
    completed_at: ts('completed_at'),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    // The subject's own requests, newest first (settings screen + privacy export).
    index('privacy_requests_user_id_created_at_idx').on(t.user_id, t.created_at),
    // The nightly sweep for held/expired requests.
    index('privacy_requests_status_scheduled_for_idx').on(t.status, t.scheduled_for),
  ],
)

/* ------------------------------------------------------------------------------------------ */
/* 25. jwks_keys                                                                                   */
/* ------------------------------------------------------------------------------------------ */

/**
 * `/.well-known/jwks.json` is rendered from this table (spec §8.10 AT-M10.5). Retired keys stay
 * verify-only until `not_after`, because an evidence packet filed months ago must still verify
 * against the key that signed it (EC-KEY-2/3).
 */
export const jwksKeys = pgTable(
  'jwks_keys',
  {
    kid: text('kid').primaryKey(),
    role: jwksKeyRoleEnum('role').notNull(),
    public_jwk: jsonb('public_jwk').$type<JsonValue>().notNull(),
    status: jwksKeyStatusEnum('status').notNull().default('ACTIVE'),
    not_before: ts('not_before').notNull(),
    not_after: ts('not_after'),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    index('jwks_keys_role_status_idx').on(t.role, t.status),
    check(
      'jwks_keys_not_after_gt_not_before',
      sql`${t.not_after} IS NULL OR ${t.not_after} > ${t.not_before}`,
    ),
  ],
)

/* ------------------------------------------------------------------------------------------ */
/* 26. jobs (pg-boss)                                                                              */
/* ------------------------------------------------------------------------------------------ */

/**
 * The pg-boss queue table (spec §7.2 "jobs — pg-boss schema").
 *
 * Column names are pg-boss's own camelCase, quoted, because pg-boss reads and writes them by name
 * and nothing in this repo re-implements its SQL. Construct pg-boss with
 * `{ schema: 'public', tableName: 'jobs' }` (see README). `created_at`/`updated_at` are added
 * because §7.1 requires them on every table; both have defaults, so pg-boss's explicit-column
 * INSERTs are unaffected.
 *
 * pg-boss also owns an `archive` and a `schedule` table, which it creates itself on first connect.
 * They are queue plumbing rather than Countersign data, so they are not listed here.
 */
export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull().default('job'),
    priority: smallint('priority').notNull().default(0),
    data: jsonb('data').$type<JsonValue>().notNull().default({}),
    // camelCase, spelled **without** embedded quotes: drizzle already quotes every identifier it
    // emits, and pre-quoting makes drizzle-kit render `""retryLimit""` — a column whose name literally
    // contains quote characters, which pg-boss would never find.
    retryLimit: smallint('retryLimit').notNull().default(2),
    retryDelay: integer('retryDelay').notNull().default(0),
    retryBackoff: boolean('retryBackoff').notNull().default(false),
    /**
     * pg-boss stores this as **text**, not a timestamp — a lexicographically sortable ISO instant —
     * because it compares against `now()::text` inside a partial index predicate. Changing the type
     * would break pg-boss's own status index.
     */
    startAfter: text('startAfter')
      .notNull()
      .default(sql`now()::text`),
    singletonOn: text('singletonOn'),
    singletonKey: text('singletonKey'),
    /** pg-boss declares these as `timestamp without time zone`; see README for why that is kept. */
    createdOn: timestamp('createdOn', { withTimezone: false, mode: 'string' })
      .notNull()
      .defaultNow(),
    completedOn: timestamp('completedOn', { withTimezone: false, mode: 'string' }),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    index('jobs_name_start_after_idx').on(t.name, t.startAfter),
    // §8.12 step 4 uses `resource_id` as the singleton key so one resource is processed serially.
    index('jobs_singleton_key_idx').on(t.singletonKey),
  ],
)

/* ------------------------------------------------------------------------------------------ */
/* Row types                                                                                       */
/* ------------------------------------------------------------------------------------------ */

/**
 * Re-type one column of a Drizzle row. The database cannot enforce a `mdt_` prefix on a `text`
 * primary key, so the prefix is carried in the TypeScript type (spec §8.1 `Id<P>`) — a `MandateId`
 * cannot be assigned a `UserId` without a compile error.
 */
type Recast<T, K extends keyof T, V> = Omit<T, K> & { [P in K]: V }

export type UserRow = Recast<typeof users.$inferSelect, 'id', UserId>
export type WalletRow = Recast<typeof paypalWallets.$inferSelect, 'id', WalletId>
export type DeviceRow = Recast<typeof devices.$inferSelect, 'id', DeviceId>
export type L1Row = Recast<typeof l1Credentials.$inferSelect, 'id', L1Id>
export type AgentRow = Recast<typeof agents.$inferSelect, 'id', AgentId>
export type MandateRow = Recast<typeof mandates.$inferSelect, 'id', MandateId>
export type BudgetAccountRow = Recast<typeof budgetAccounts.$inferSelect, 'mandate_id', MandateId>
export type WalletCapRow = Recast<typeof walletCaps.$inferSelect, 'wallet_id', WalletId>
export type BudgetEntryRow = Recast<typeof budgetEntries.$inferSelect, 'id', BudgetEntryId>
export type ProductRow = typeof products.$inferSelect
export type CheckoutSessionRow = Recast<typeof checkoutSessions.$inferSelect, 'id', CheckoutId>
export type CheckoutAttemptRow = Recast<typeof checkoutAttempts.$inferSelect, 'id', AttemptId>
export type GateDecisionRow = Recast<typeof gateDecisions.$inferSelect, 'id', GateDecisionId>
export type OrderRow = Recast<typeof orders.$inferSelect, 'id', OrderId>
export type AuthorizationRow = Recast<typeof authorizations.$inferSelect, 'id', Id<'aut'>>
export type CaptureRow = Recast<typeof captures.$inferSelect, 'id', CaptureRowId>
export type RefundRow = Recast<typeof refunds.$inferSelect, 'id', RefundRowId>
export type ShipmentRow = Recast<typeof shipments.$inferSelect, 'id', ShipmentId>
export type WebhookEventRow = Recast<typeof webhookEvents.$inferSelect, 'id', Id<'whe'>>
export type DisputeRow = Recast<typeof disputes.$inferSelect, 'id', DisputeId>
export type EvidencePacketRow = Recast<typeof evidencePackets.$inferSelect, 'id', PacketId>
export type DisputeActionRow = Recast<typeof disputeActions.$inferSelect, 'id', DisputeActionId>
export type AuditLogRow = Recast<typeof auditLog.$inferSelect, 'id', AuditLogId>
export type PrivacyRequestRow = Recast<typeof privacyRequests.$inferSelect, 'id', PrivacyRequestId>
export type JwksKeyRow = typeof jwksKeys.$inferSelect
export type JobRow = typeof jobs.$inferSelect

/** Insert shapes, for `repos/*.ts`. */
export type NewUser = typeof users.$inferInsert
export type NewWallet = typeof paypalWallets.$inferInsert
export type NewDevice = typeof devices.$inferInsert
export type NewL1 = typeof l1Credentials.$inferInsert
export type NewAgent = typeof agents.$inferInsert
export type NewMandate = typeof mandates.$inferInsert
export type NewBudgetAccount = typeof budgetAccounts.$inferInsert
export type NewWalletCap = typeof walletCaps.$inferInsert
export type NewBudgetEntry = typeof budgetEntries.$inferInsert
export type NewProduct = typeof products.$inferInsert
export type NewCheckoutSession = typeof checkoutSessions.$inferInsert
export type NewCheckoutAttempt = typeof checkoutAttempts.$inferInsert
export type NewGateDecision = typeof gateDecisions.$inferInsert
export type NewOrder = typeof orders.$inferInsert
export type NewAuthorization = typeof authorizations.$inferInsert
export type NewCapture = typeof captures.$inferInsert
export type NewRefund = typeof refunds.$inferInsert
export type NewShipment = typeof shipments.$inferInsert
export type NewWebhookEvent = typeof webhookEvents.$inferInsert
export type NewDispute = typeof disputes.$inferInsert
export type NewEvidencePacket = typeof evidencePackets.$inferInsert
export type NewDisputeAction = typeof disputeActions.$inferInsert
export type NewAuditEntry = typeof auditLog.$inferInsert
export type NewPrivacyRequest = typeof privacyRequests.$inferInsert
export type NewJwksKey = typeof jwksKeys.$inferInsert

/**
 * Every table, keyed by its §7.2 name. Used to pass a schema to `drizzle()` and by
 * `test/schema.test.ts` to walk every column looking for a float type.
 */
export const schema = {
  users,
  paypalWallets,
  devices,
  l1Credentials,
  agents,
  mandates,
  budgetAccounts,
  walletCaps,
  budgetEntries,
  products,
  checkoutSessions,
  checkoutAttempts,
  gateDecisions,
  orders,
  authorizations,
  captures,
  refunds,
  shipments,
  webhookEvents,
  disputes,
  evidencePackets,
  disputeActions,
  auditLog,
  privacyRequests,
  jwksKeys,
  jobs,
} as const

/** §7.2 table names, in the order the spec lists them. */
export const TABLE_NAMES = [
  'users',
  'paypal_wallets',
  'devices',
  'l1_credentials',
  'agents',
  'mandates',
  'budget_accounts',
  'wallet_caps',
  'budget_entries',
  'products',
  'checkout_sessions',
  'checkout_attempts',
  'gate_decisions',
  'orders',
  'authorizations',
  'captures',
  'refunds',
  'shipments',
  'webhook_events',
  'disputes',
  'evidence_packets',
  'dispute_actions',
  'audit_log',
  'privacy_requests',
  'jwks_keys',
  'jobs',
] as const satisfies readonly string[]

export type TableName = (typeof TABLE_NAMES)[number]

/** Compile-time reminder that `currency()` narrows to core's `Currency`. */
export type _CurrencyIsNarrowed = Currency
