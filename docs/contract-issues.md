# Contract issues found by WP-11 (order orchestrator binder)

Per AGENTS.md rule 8, these are reported rather than worked around. Each item names the port, the
missing production piece, the file:line where the obligation is written, and what the binder does
in the meantime. WP-11 owns `packages/orchestrator/src/deps.ts` only; adapters belong to the
package that declares the port.

| #   | Gap                                                                        | Effect                                                            | Who fixes it         |
| --- | -------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------- |
| 1   | No production `DefenderStore` adapter; defender exports only in-memory     | `defenderDepsFromRepos` cannot be built from `@countersign/db`    | defender / db owner  |
| 2   | No production `Notifier`; only `nullNotifier`                              | `OrdersDeps.notify` is legal but silent in production             | orders owner         |
| 3   | Four `OrderRepoHandles` members have no repository                         | `orderStoreFromRepos` cannot be called in production today        | orders / db owner    |
| 4   | No production `MerchantCatalogStore`                                       | `OrdersDeps.stock` stays undefined; void does not restore stock   | gate owner           |
| 5   | `walletCapPeriod` has no database reader                                   | `ok(undefined)` is contract-legal but disables wallet-period caps | gate / db owner      |
| 6   | `setAuthorizationStatus` cannot restamp `expiration_time`                  | reauthorize reports `expiryRestamped: false`                      | orders owner         |
| 7   | `findRefundById` is repo-less but outside the four-handle enumeration      | refund-by-id paths cannot be wired from repositories              | orders / db owner    |
| 8   | `@countersign/vi-client` missing from `packages/orchestrator/package.json` | binder must accept an injected `vi` until the dependency lands    | WP-01 / orchestrator |
| 9   | Orchestrator README cross-references the wrong defender export surface     | implementer follows a README sentence that tsc contradicts        | docs owner           |

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
