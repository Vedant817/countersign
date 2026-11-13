# `@countersign/db`

The data model — spec **§7**, work package **WP-02** (§8.2, M2).

The Drizzle schema, the connection, one repository per aggregate, and an idempotent seed. This package
is the only place in the repository that knows what a row looks like; everything else goes through a
repository here.

```bash
pnpm db:migrate   # drizzle-kit migrate  (idempotent: re-running is a no-op)
pnpm db:seed      # personas, wallet cap, 24 products  (idempotent: re-running changes nothing)
pnpm --filter @countersign/db test    # no DATABASE_URL required
```

## Merchant password (D-059)

`users.password_hash` holds a `scrypt` hash (`hashPassword` / `verifyPassword` in `src/password.ts`),
or `null` for an account that cannot sign in. `pnpm db:seed` sets the Northwind merchant's hash from
`MERCHANT_PASSWORD` when that variable is present, and leaves the column untouched when it is not — a
re-seed with the variable unset does not sign the merchant out. `findUserByEmail` and `setPasswordHash`
are the only repository surface the login route needs; the plaintext is never stored or logged.

---

## What this package owns

| Surface      | Import                   | Contents                                                          |
| ------------ | ------------------------ | ----------------------------------------------------------------- |
| Schema       | `@countersign/db/schema` | 26 tables, 27 pg enums, all CHECK/unique/index definitions        |
| Connection   | `@countersign/db/client` | `db()`, `withTx(fn)`, `closeDb()`                                 |
| Repositories | `@countersign/db/repos`  | one function set per aggregate, all `Result<T, CsError>`          |
| Seed data    | `@countersign/db` (root) | `SEED_PERSONAS`, `SEED_PRODUCTS`, `INJECTION_PAYLOADS`, `runSeed` |

## The tables (§7.2)

| Group           | Tables                                                                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| People and keys | `users`, `devices`, `l1_credentials`, `agents`, `paypal_wallets`                                                                       |
| Authority       | `mandates`                                                                                                                             |
| Money           | `budget_accounts`, `budget_entries`, `wallet_caps`                                                                                     |
| Commerce        | `products`, `checkout_sessions`, `checkout_attempts`, `gate_decisions`, `orders`, `authorizations`, `captures`, `refunds`, `shipments` |
| Disputes        | `disputes`, `evidence_packets`, `dispute_actions`                                                                                      |
| Platform        | `webhook_events`, `audit_log`, `privacy_requests`, `jwks_keys`, `jobs` (pg-boss)                                                       |

### Two places §7.2 is abbreviated, and what this package does about it

Both are §7.1 rules that §7.2's "key columns" column does not repeat.

1. **`paypal_id` is named per table.** §7.1 says every PayPal-mirrored row stores a unique `paypal_id`;
   §7.2 gives each table its own name for it (`paypal_order_id`, `paypal_capture_id`,
   `paypal_refund_id`, `paypal_authorization_id`, `paypal_dispute_id`, `paypal_event_id`,
   `paypal_tracker_id`, and `payment_token_id` + `payer_id` for a wallet). The **rule** is identical
   everywhere: unique, mirrored, never a place we compute from. The **names** follow §7.2 so other
   work packages find what the spec says they will find. Every mirrored table also carries
   `raw jsonb` + `fetched_at timestamptz`.
2. **`authorizations`, `captures` and `refunds` gained a `currency` column.** §7.1 requires a currency
   beside every money column; §7.2 lists only the amount for these three. An amount without a currency
   is not a `Money`, and a receipt that infers its currency is a bug someone finds at reconciliation.

### `jobs` and pg-boss

`jobs` mirrors pg-boss's own job table, including its camelCase column names, because pg-boss reads and
writes them by name. Construct pg-boss with:

```ts
new PgBoss({ connectionString: env.DATABASE_URL, schema: 'public', tableName: 'jobs' })
```

Two notes that look like mistakes and are not:

- **`createdOn`/`completedOn` are `timestamp without time zone`**, not `timestamptz`. pg-boss declares
  them that way and compares them with `now()` inside its own status index. `schema.test.ts` asserts
  the exemption so nobody "fixes" it.
- **`startAfter` is `text`**, because pg-boss compares it against `now()::text` in a partial index
  predicate.
- pg-boss also owns `pgboss.archive` and `pgboss.schedule`; it creates those itself on first connect.
  They are queue plumbing, not Countersign data, so they are not in the schema.

---

## Money

> Money is always **integer minor units plus an ISO-4217 currency code**. Floats are never used.
> — spec §0

```ts
// In the database
amount_minor bigint      -- 13000n, not 130.0
currency     char(3)     -- 'USD'
```

- Every money column is `bigint({ mode: 'bigint' })`. Never `doublePrecision`, `numeric` or `real`.
- `test/schema.test.ts` walks **every column of every table** and fails if a float type appears, so the
  rule is structural rather than a review comment. It also asserts the _generated DDL_ has no float
  type — that is the version that would actually reach Postgres.
- **Defaults are `sql\`0\`, not `0n`.** `drizzle-kit` serialises the schema snapshot with
  `JSON.stringify`, and a BigInt default throws `TypeError: Do not know how to serialize a BigInt`,
  which makes `drizzle-kit generate` fail outright. The emitted DDL is identical.
- Time: business timestamps are `timestamptz`; the JWT claim mirrors (`mandates.iat/exp`,
  `l1_credentials.iat/exp`) are **epoch-seconds `bigint`**, because that is the unit of the signed
  token and comparing a claim to `clock.nowSec()` must not involve a `Date` round trip.

## Invariants: SQL vs. application code

**Enforced in SQL**, so a bug or a bypass still cannot break them:

| Invariant                                 | Mechanism                                                     |
| ----------------------------------------- | ------------------------------------------------------------- |
| `reserved + spent ≤ cap` (AT-M2.3)        | `CHECK budget_accounts_reserved_plus_spent_le_cap`            |
| No negative reserve / spend / cap         | `CHECK budget_accounts_non_negative`, `…_cap_non_negative`    |
| No replay (EC-IDEM-1)                     | `UNIQUE (l3_jti)` on `checkout_attempts`                      |
| No double-submit                          | `UNIQUE (idempotency_key)` on `checkout_attempts`             |
| No double event (EC-WH-2)                 | `UNIQUE (paypal_event_id)` on `webhook_events`                |
| One order per attempt / per PayPal order  | `UNIQUE (attempt_id)`, `UNIQUE (paypal_order_id)` on `orders` |
| One device key per user                   | `UNIQUE (user_id, jkt)` on `devices`                          |
| One L1 per device×wallet                  | `UNIQUE (device_id, wallet_id)` on `l1_credentials`           |
| One device action per attempt             | `UNIQUE (idempotency_key)` on `dispute_actions`               |
| `mandate.exp > mandate.iat`               | `CHECK mandates_exp_gt_iat`                                   |
| Stock never negative (EC-STOCK-3)         | `CHECK products_stock_non_negative`                           |
| Refunds never exceed a capture (EC-REF-2) | `CHECK captures_refunded_lte_amount`                          |
| Notes ≤ 2000 chars (§8.15, [V8])          | `CHECK evidence_packets_notes_le_2000`                        |
| Checkout total = its own breakdown        | `CHECK checkout_sessions_total_matches_parts`                 |
| `legal_hold_reason` nullable              | column definition                                             |

**Enforced in application code**, because they span rows or tables:

| Invariant                                          | Where                                                      | Why not SQL                                             |
| -------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------- |
| Budget mutations are serialised (D19)              | `SELECT … FOR UPDATE` in `repos/budget.ts`                 | a CHECK cannot make a read-modify-write atomic          |
| `mandate.exp ≤ L1.exp` (§7.2)                      | `assertMandateWithinL1`, called by `createMandateWithinL1` | a CHECK sees one row; the L1 expiry is in another table |
| Mandate terminal states are never left (§3.3)      | `setMandateStatus`'s `WHERE` clause                        | a CHECK cannot enforce a transition graph               |
| Σ captures ≤ authorized (EC-CAP-3)                 | `assertCaptureWithinAuthorization`, under a lock           | it is a sum over rows                                   |
| Capture status never regresses (EC-WH-3)           | `CAPTURE_STATUS_RANK` + `upsertCaptureStatusFromFetch`     | it is a comparison against PayPal's ordering            |
| Dispute state only advances from a re-fetch (§3.3) | `STAGE_RANK` + `isDisputeRegression`                       | it depends on a fetched `update_time`                   |
| Wallet cap across mandates (EC-MA-1)               | `walletCapCheck` under `FOR UPDATE` on `wallet_caps`       | it aggregates over mandates                             |
| Audit hash chain                                   | `prev_hash` / `this_hash` + `computeAuditHash`             | the digest is computed over the canonical JSON          |

---

## No package may bypass a repository to write a money column

If another package runs `db().update(captures).set({ refunded_minor: … })` directly, it skips:

- the **currency check** (an amount without a currency is not a `Money`),
- the **`FOR UPDATE` lock**, so a concurrent write can produce a balance that never existed,
- the **ledger entry**, so `reconcile` will report drift and the nightly check becomes noise,
- the **error mapping**, so a unique violation escapes as a raw Postgres error instead of
  `CS_CONFLICT`.

Repositories are the boundary. The budget ledger is the extreme case: `repos/budget.ts` is the only
writer of `budget_accounts` and `budget_entries`, and its header explains why every mutation locks.

### Error mapping

Every repository returns `Result<T, CsError>` and never throws across the boundary. `repos/index.ts`
maps the SQLSTATEs that carry meaning:

| SQLSTATE                                                | `CsError.code`                   |
| ------------------------------------------------------- | -------------------------------- |
| `23505` on `checkout_attempts_l3_jti_key`               | `GATE_REPLAY`                    |
| `23505` on `webhook_events_paypal_event_id_key`         | `WH_DUPLICATE`                   |
| `23505` (any other unique)                              | `CS_CONFLICT`                    |
| `23514` on `budget_accounts_reserved_plus_spent_le_cap` | `GATE_BUDGET_EXCEEDED`           |
| `23514` (any other check)                               | `CS_VALIDATION`                  |
| `23503`                                                 | `CS_VALIDATION`                  |
| `40001` / `40P01`                                       | `CS_CONFLICT`, `retryable: true` |
| `23502`                                                 | `CS_VALIDATION`                  |

---

## Budget repository — the contract other packages call

Every function takes an optional executor as its **last** argument. Pass `withTx`'s handle to make
several repos atomic; omit it and the function uses the pool.

```ts
function openBudget(input: {
  mandateId: MandateId
  cap: Money
  exec?: Exec
  at?: Date
}): Promise<Result<BudgetAccountRow, CsError>>

function reserve(
  mandateId: MandateId,
  attemptId: AttemptId,
  amount: Money,
  exec?: Exec,
): Promise<Result<ReserveResult, CsError>>
function release(
  mandateId: MandateId,
  attemptId: AttemptId,
  amount: Money,
  reason: string,
  exec?: Exec,
): Promise<Result<BudgetBalance, CsError>>
function commit(
  mandateId: MandateId,
  amount: Money,
  captureId: string,
  exec?: Exec,
): Promise<Result<BudgetBalance, CsError>>
function reverse(
  mandateId: MandateId,
  amount: Money,
  captureId: string,
  exec?: Exec,
): Promise<Result<BudgetBalance, CsError>>
function balance(mandateId: MandateId, exec?: Exec): Promise<Result<BudgetBalance, CsError>>

function walletCapCheck(
  walletId: WalletId,
  period: 'DAY' | 'MONTH',
  amount: Money,
  exec?: Exec,
  at?: Date,
): Promise<Result<WalletCapRow, CsError>>
function setWalletCap(
  walletId: WalletId,
  period: 'DAY' | 'MONTH',
  cap: Money,
  exec?: Exec,
): Promise<Result<WalletCapRow, CsError>>

function reconcile(mandateId: MandateId, exec?: Exec): Promise<Result<ReconcileReport, CsError>>
function listEntries(mandateId: MandateId, exec?: Exec): Promise<Result<BudgetEntryRow[], CsError>>
function countCommitsSince(
  mandateId: MandateId,
  since: Date,
  exec?: Exec,
): Promise<Result<number, CsError>>
```

Each also has an `…In(store, …)` twin that takes a `BudgetStore` — a six-method port naming the exact
statements the budget needs. That is what makes "an over-cap reservation writes nothing" provable in a
unit test with no Postgres, and it is why `FOR UPDATE` cannot be forgotten: the lock is inside
`lockBudgetAccount`, not an option the caller can drop.

`reserve` returns `{ balance, entry }`, where `balance.version` is the `budgetVersion` Gate check 8
hands back in its decision record.

**`reverse` does not restore budget** (§8.11). Neither does a refund. Authority was granted and spent;
a chargeback is a dispute outcome, not a permission.

---

## Migrations

`drizzle.config.ts` points at `src/schema.ts` and writes to `drizzle/`. Generate and commit:

```bash
pnpm --filter @countersign/db migrate:generate   # writes packages/db/drizzle/<n>_<name>.sql
pnpm db:migrate                                  # applies them; re-running is a no-op
```

`generate` needs no database. `migrate` reads `DATABASE_URL` and fails loudly without it.

## Seed

Idempotency is **structural**: every write is an `onConflictDoUpdate` against a stable natural key
(`users.id`, `products.sku`, `wallet_caps.wallet_id`, `paypal_wallets.id`). Nothing calls `newId()` or
reads a clock for an identity, because a seed that mints fresh ids can never be idempotent.

The 24 products contain exactly what AT-M2.2 asks for, and the composition is asserted in
`test/seed.test.ts`:

- **3 with injection payloads** — `NW-011` (the literal spec string), `NW-017` (hidden
  `display:none` div), `NW-022` (a plausible fake "price updated" note). The three strings live in
  `INJECTION_PAYLOADS`, which `packages/agent`'s tests import, so the seed and the agent's assertions
  cannot drift apart.
- **2 with `stock = 1`** — `NW-014`, `NW-019` (EC-STOCK-3's last-unit race).
- **1 JPY item** — `NW-021` (EC-FX-3).
- **1 digital item** — `NW-024`, which D17 captures up front instead of authorising.
- A `$50.00` **DAY wallet cap** for Asha, deliberately different from a mandate cap so the demo can show
  Gate check 8 passing while check 9 blocks.

**Not seeded, by design:** `l1_credentials`, `mandates`, `budget_accounts`, `budget_entries`,
`attempts`, `orders`, `disputes`. Those need real key material and real signatures; a seeded
`l2_serialized` would be a fabricated signed artefact inside the evidence chain. They appear when the
buyer actually enrols (S-02) and signs (S-04).

**One thing a human must do:** the seed creates Asha's wallet row with a placeholder vault token
(`SEED_PLACEHOLDER_VAULT_TOKEN`) so `wallet_caps` has something to reference. After S-02 onboarding,
WP-07 must update that row **in place** rather than insert a second wallet:

```sql
UPDATE paypal_wallets SET payment_token_id = $1 WHERE id = 'wal_423456789ABCDEFGHJKMNPQRST';
```

Inserting a fresh wallet would leave the cap on the placeholder and the wallet-level limit would
silently stop applying.

---

## Tests

`pnpm --filter @countersign/db test` — 64 tests, **no database required**. They read the Drizzle table
objects directly, which is the right level for a structural property.

| File                  | Covers                                                                                                                                                                                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/schema.test.ts` | table inventory, the no-float rule, every CHECK/unique index, error mapping, connection laziness, EC-IDEM-1, EC-MA-1's lock target, AT-M2.3, AT-M2.4                                                                                                                    |
| `test/seed.test.ts`   | the 24-item composition, price round-trips, persona stability, and the whole budget ledger against a `BudgetStore` fake: over-cap writes nothing, AT-M10.2's bound of 3, the `FOR UPDATE` discipline, RELEASE/COMMIT/REVERSE, wallet-cap serialisation, and `reconcile` |

**No PayPal is mocked anywhere.** AGENTS.md rule 5 is about PayPal; the fakes here stand in for our
own database, which is the only way to assert "this transaction leaves no row" without a server.

### Edge cases

| ID                                                       | Status here                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **EC-MA-1**                                              | The wallet-cap serialisation is asserted against the `BudgetStore` port: the lock is on the wallet row, spend is summed across mandates, and a released reservation frees the wallet again. The **20-way concurrent race itself needs Postgres** and belongs to WP-10's integration suite (AT-M10.2). |
| **EC-IDEM-1**                                            | `UNIQUE (l3_jti)` and `UNIQUE (idempotency_key)` are asserted in the schema; the mapping to `GATE_REPLAY` / `CS_CONFLICT` is asserted in `toRepoError`. "The same checkout returns the existing attempt" needs a database and is WP-10/WP-11's.                                                       |
| EC-STOCK-3, EC-FX-1, EC-FX-3, EC-REF-2, EC-WH-2, EC-WH-3 | schema-level parts only                                                                                                                                                                                                                                                                               |
| EC-ENV-1                                                 | core's, not this package's                                                                                                                                                                                                                                                                            |

## Known gaps

- **Committed migration SQL is not in this work package.** `pnpm --filter @countersign/db
migrate:generate` has been verified to produce a correct, complete `CREATE TABLE` file for all 26
  tables (including the budget CHECK and every unique index, and with no float type anywhere), but the
  generated `drizzle/` directory was outside the files this WP was scoped to create. **Run the command
  above and commit `packages/db/drizzle/` before merging.**
- **`@countersign/db/seed` is declared in `package.json` but `src/seed/index.ts` does not exist.** That
  export path is broken; import seed data from the package root (`@countersign/db`) or from
  `seed/products` / `seed/personas` directly. `package.json` was outside this WP's scope.
- **`reserve`/`release`/`commit`/`reverse` require a ledger `entryId`** on their `…In` forms so a retry
  can reuse it; the convenience wrappers mint one with `newId('ben')`.
