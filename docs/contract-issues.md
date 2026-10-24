# Contract issues found by WP-11 (order orchestrator binder)

Per AGENTS.md rule 8, these are reported rather than worked around. Each item names the port, the
missing production piece, the file:line where the obligation is written, and what the binder does
in the meantime. WP-11 owns `packages/orchestrator/src/deps.ts` only; adapters belong to the
package that declares the port.

| #   | Gap                                                                                                                                          | Effect                                                            | Who fixes it                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------ |
| 1   | No production `DefenderStore` adapter; defender exports only in-memory                                                                       | `defenderDepsFromRepos` cannot be built from `@countersign/db`    | defender / db owner                        |
| 2   | No production `Notifier`; only `nullNotifier`                                                                                                | `OrdersDeps.notify` is legal but silent in production             | orders owner                               |
| 3   | Four `OrderRepoHandles` members have no repository                                                                                           | `orderStoreFromRepos` cannot be called in production today        | orders / db owner                          |
| 4   | No production `MerchantCatalogStore`                                                                                                         | `OrdersDeps.stock` stays undefined; void does not restore stock   | gate owner                                 |
| 5   | `walletCapPeriod` has no database reader                                                                                                     | `ok(undefined)` is contract-legal but disables wallet-period caps | gate / db owner                            |
| 6   | `setAuthorizationStatus` cannot restamp `expiration_time`                                                                                    | reauthorize reports `expiryRestamped: false`                      | orders owner                               |
| 7   | `findRefundById` is repo-less but outside the four-handle enumeration                                                                        | refund-by-id paths cannot be wired from repositories              | orders / db owner                          |
| 8   | `@countersign/vi-client` missing from `packages/orchestrator/package.json`                                                                   | binder must accept an injected `vi` until the dependency lands    | WP-01 / orchestrator                       |
| 9   | Orchestrator README cross-references the wrong defender export surface                                                                       | implementer follows a README sentence that tsc contradicts        | docs owner                                 |
| 10  | Spec EC-AGT-4 says old mandates survive a key rotation; the Gate refuses a REVOKED agent, and `rotateAgentKey` marks the predecessor REVOKED | rotation silently un-spends every mandate bound to the old key    | gate / db owner (needs a product decision) |

## 1. `DefenderStore` has no production adapter

`DefenderStore` is a closed port (`packages/defender/src/ingest.ts:252`); its doc comment says every
member names the `@countersign/db` repository that satisfies it, so a member with no repository
would be a `tsc` error "at the adapter" (`ingest.ts:240-241`). No such adapter exists:
`packages/defender/src` has no `deps.ts`, and the only implementation is
`createInMemoryDefenderWorld` (`ingest.ts:1580`). `packages/db/src/repos/disputes.ts` exists and its
`:162` comment refers to the Defender work queue, but nothing composes the repos into the port, and
there is no `defenderDepsFromRepos`.

**Effect on the binder:** `DefenderSeam` is `{ ingest: ingestDisputeToDefender, file: fileDispute }`
(`packages/orchestrator/src/types.ts:186-191`) and both take `DefenderDeps`
(`ingest.ts:549-562`). The seam functions can be wired, but `store`/`refunds` have no production
source, so the binder accepts a caller-supplied `DefenderDeps` (or leaves `defender` undefined,
which `OrchestratorDeps` permits) and does not fabricate one.

**Note:** `refunds` is not a gap — `defenderRefundsFromOrders` exists at
`packages/orders/src/dispute-refund.ts:232` and is exported from the orders barrel
(`packages/orders/src/index.ts:158`). It takes `(OrdersDeps, Pick<PayPalClient, 'getDispute' |
'acceptClaim'>)` and translates our capture id to PayPal's.

## 2. No production `Notifier`

`Notifier` is declared at `packages/orders/src/types.ts:483` and `OrdersDeps.notify` is required by
contract (EC-CAP-5: tell the user). A grep across `packages` finds only the test doubles
`RecordingNotifier`/`recordingNotifier` (`orders/src/deps.ts:536`, `:543`) and the silent
`nullNotifier` (`orders/src/deps.ts:564`). There is no email, push, or webhook notifier.

`OrderNotification` (`orders/src/types.ts:470-481`) carries buyer-safe copy in `userMessage`, never
an internal message (AGENTS.md rule 3), and `detail` must never carry secrets. The binder passes
`nullNotifier` so capture/refund paths stay total, and records this item; a silent production
notifier is a product gap, not a binder bug.

## 3. Four repo-less `OrderRepoHandles`

`packages/orders/src/deps.ts:104-123` tabulates four members that no repository computes:

- `lockMandateForUpdate` — `repos/mandates.ts` has no `SELECT ... FOR UPDATE`; EC-MDT-2. The gate
  hit the same wall for its own `lockMandate`.
- `findL1Credential` — no `repos/l1_credentials.ts`; §7.3. Candidate resolver
  `findL1ForDeviceWallet` at `packages/gate/src/devices.ts:269`.
- `findOpenDisputeForCapture` — `repos/disputes.ts` has no by-capture lookup; EC-REF-4 detection.
- `findShipmentByTracking` — no by-tracking lookup; shipment-insert idempotency key.

`orderStoreFromRepos` (`orders/src/deps.ts:336`) therefore cannot be called in production until
these land. The binder accepts a caller-built `OrderStore`.

## 4. No production `MerchantCatalogStore`

`OrdersDeps.stock` (`orders/src/types.ts:744-755`) is optional and documents that stock lives in the
gate's merchant module, which exports `restoreStockOnVoid` for WP-11 to call. `MerchantDeps.catalog`
is an interface (`packages/gate/src/merchant/index.ts:339`, `:415-433`) with no production
implementation: grep finds only test construction (`packages/gate/test/merchant.test.ts:282`), while
`packages/db/src/repos/products.ts` exposes the raw `lockStock` (`:152`) and `restoreStock` (`:219`)
halves separately. There is also no builder that supplies the merchant world's `withTx`
(`merchant/index.ts:430-433`).

**Effect on the binder:** `stock` is left undefined. The `voidRemainder` path then logs a
non-restock, which the port explicitly tolerates ("a void that fails on a stock row would leave the
buyer's money released and the order still open", worse than a stale count). Wiring it later is a
one-line wrap: `stock: (lines, at) => withTx(tx => restoreStockOnVoid({ catalog, withTx }, tx, lines, at))`.

## 5. `walletCapPeriod` has no database reader

`GateRepoHandles.walletCapPeriod` (`packages/gate/src/deps.ts:196-200`) is optional because no
repository reads `wallet_caps.period` (`packages/db/src/repos/wallets.ts` has the row but no period
reader). Returning `ok(undefined)` is contract-legal and simply disables period-scoped caps; the
binder does that rather than inventing a cadence.

## 6. `setAuthorizationStatus` cannot restamp `expiration_time`

Documented at `packages/orders/README.md:235-241`: the repository update does not include
`expiration_time`, so `reauthorize` reports `expiryRestamped: false`. The order still moves to the
new authorization id; only the recorded expiry is stale. The binder cannot fix this from outside the
port and must not write Drizzle directly (AGENTS.md rule 8).

## 7. `findRefundById` is repo-less but outside the enumeration

`findRefundById` is declared at `packages/orders/src/deps.ts:269` and forwarded at `:378`, but the
`| Handle | Why it does not exist yet |` table (`:104-123`) lists only four members and does not
include it. Either the repository exists under another name or the table is incomplete; the binder
treats it as unavailable, like the four.

## 8. `@countersign/vi-client` is missing from the orchestrator manifest

`packages/orchestrator/package.json` lists compiler, core, db, defender, gate, ledger, orders,
paypal and webhooks, but not `vi-client`; `packages/gate/src/deps.ts:60-77` already imports
vi-client symbols. The binder's `GateRepoHandles` needs
`vi: Pick<ViClient, 'verify' | 'jwks'>`, so until the dependency is added the binder accepts an
injected `vi` and never imports the package. Adding the dependency is a WP-01 (central manifest)
change, not WP-11's.

## 9. Orchestrator README cross-references

The orchestrator README points at symbols that live elsewhere or have moved: `createInMemoryDefenderWorld`
is not exported from the defender barrel (`packages/defender/src/index.ts`, which exports the ingest
and filer functions but not the world), `FileDeps`/`FileOptions`/`FileOutcome` are recovered through
`DefenderSeam`'s `Parameters`/`ReturnType` because they are not re-exported, the "orders refund mode
for disputed captures" sentence is superseded by `defenderRefundsFromOrders`
(`orders/src/dispute-refund.ts:232`), and the `gate_decisions.pending_network_enforcement` column
plus the `packages/db` JS `Date` binding note (drizzle-orm 0.45.3) are project-wide idiosyncrasies
that belong in the db README, not the orchestrator's. Code follows the packages; the README sentences
are corrected separately so the next implementer does not chase them.

## 10. EC-AGT-4's rotation semantics contradict the Gate

The spec's §12.9 row says a key rotation leaves existing mandates usable: _"New key → user re-signs
new L2s … old mandates keep the old key until expiry"_. `rotateAgentKey`
(`packages/db/src/repos/agents.ts:136`) instead marks the predecessor `REVOKED`; the Gate's check 2
(`packages/gate/src/checks.ts:501-534`) resolves the agent by the mandate's `agent_id` and refuses any
row whose status is not `ACTIVE` (`GATE_AGENT_SUSPENDED`). So a rotation today stops every mandate
still bound to the old key, which is the opposite of the row's sentence.

Retention itself is deliberate and correct — the old row must stay for past L3s to verify — so the
question is only whether the predecessor should be `REVOKED` (rotation also revokes) or stay `ACTIVE`
until the last mandate expires (rotation only issues). That is a product/security decision, not a
code-style one, so no work around is stubbed here.

**Evidence:** `packages/db/test/repos.edge-cases.live.test.ts` executes the rotation against a real
Postgres and asserts the retention/`rotated_from` half; it deliberately does not assert either reading
of the spec sentence.

---

## 11. Date parameters inside Drizzle `sql` templates throw `ERR_INVALID_ARG_TYPE` (found 2026-10-25, by P0-4 and P0-6; fixes converged)

**Where:** `packages/db/src/repos/{attempts,budget,disputes,orders,webhooks}.ts` � every
`sql\`${column} >= ${someDate}\`` comparison (10 sites).

**Symptom:** the query fails with

```
Failed query: select "id" from "checkout_attempts" where ("mandate_id" = $1 and "created_at" >= $2)
params: mdt_�,Sun Oct 25 2026 02:42:58 GMT+0530 (India Standard Time)
  inner: ERR_INVALID_ARG_TYPE The "string" argument must be of type string or an instance of Buffer or
         ArrayBuffer. Received an instance of Date
```

**Why it matters:** `countRecentAttempts` is Gate check 12 and `budget.ts`'s `since` filters are Gate
check 8/9's reads. On Node 24.13.1 with drizzle-orm 0.45.3 / postgres 3.4.9 the comparison throws, so
**every Gate evaluation blocks with `CS_INTERNAL`** before anything is reserved � the velocity guard
reports "check threw" and the budget check cannot complete. A plain `eq()` on text works, and
`postgres.js` handles a `Date` parameter correctly on its own: it is Drizzle's `sql` template that
mangles the value. Passing `.toISOString()` fixes it.

**Fix applied:** every comparison now uses Drizzle's own operator — `gte(column, date)` / `lt(column, date)`
— which routes the value through the timestamp column's encoder. Two independent fixes landed for this
fault (P0-4 on `budget`/`disputes`/`orders`, P0-6 on the rest); this entry records the convergence rather
than the history, because two fixes for one fault is how a third one gets written.

**Evidence:** `scripts/db-debug.mts` (the failing call through `@countersign/db`) and
`docs/verification/P0-6.md`.

---

## 12. `sum(bigint)` arrives as a string, and the code typed it `bigint` (found 2026-10-25, by P0-4 and P0-6)

**Where:** `packages/db/src/repos/{budget,orders}.ts` — every `sql<bigint>` that wraps `sum(...)`.

**Why it matters:** Postgres `sum(bigint)` is `numeric`, and postgres.js returns a `numeric` as a **string**
so a value past `Number.MAX_SAFE_INTEGER` is not silently rounded. `Record<BudgetEntryKind, bigint>` filled
with `"13300"` makes `computeFromEntries` subtract strings, and Gate check 9's `claimed + amount.minor`
throws _"Cannot mix BigInt and other types"_ — again, **every** purchase blocked with `CS_INTERNAL`, and
again only a real database can show it, because every unit test injects a store that already returns
BigInts.

**Fix applied:** `BigInt(...)` at each aggregate boundary, with the reason written down beside it.

**Evidence:** `docs/verification/P0-6.md`, and the acceptance run that turns `CS_INTERNAL` into `ALLOWED`.
