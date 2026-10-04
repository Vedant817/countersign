# `@countersign/orders` — the order orchestrator

Spec **§8.11 (M11, WP-11)**, decisions **D17**, **D18**, **D19**, **D21**, data model **§7.2/§7.3**,
**§10.2**, acceptance tests **AT-M11.1–6**, edge cases **EC-CAP-1…5**, **EC-REF-1…5**, **EC-IDEM-2/5/6**,
**EC-SPLIT-1/2**, **EC-STOCK-1/2/3**, **EC-MDT-2/3/4/5**, **EC-FX-4**, **EC-TIME-5**.

The only place in this repository that turns a Gate `ALLOW` into a PayPal money movement, and the only place
that turns one back into the buyer's ledger. It sits on the **PayPal side** of §3.1's boundary: the Gate
decides on the merchant side, so nothing here re-decides whether a purchase is allowed. It executes a
decision that already exists, and it re-reads the two facts that could have changed while that decision was
in flight — the mandate's status (**EC-MDT-2**) and the budget's balance.

> ### ⚠️ Nothing here has run against PayPal yet
>
> `docs/HUMAN_TODO.md` **H-01** is open, so there are no credentials. Every test in `test/*.test.ts` drives
> the **real** `PayPalClient` over an injected `fetchImpl` — the socket is the only thing replaced — so
> request building, header assembly, the retry loop, the backoff and the zod validation all execute, against
> response bodies written from PayPal's published docs. The live half of AT-M11 lives in
> `test/orchestrator.sandbox.test.ts` and **skips with its reason in each test name** until credentials
> land. It never fails, and it never reports success without having called PayPal.

---

## Using it

```ts
import {
  captureShipment,
  createOrderFromDecision,
  refund,
  reauthorizeIfNeeded,
  voidRemainder,
} from '@countersign/orders'

// One order per attempt. The request id is `cs:{attemptId}:create`, so a retry is deduplicated by PayPal
// rather than charged twice (EC-IDEM-2), and `orders_attempt_id_key` refuses a second row regardless.
const order = await createOrderFromDecision(decision, deps)
if (!order.ok) throw order.error // a CsError from the one registry in @countersign/core

// One shipment → one capture, drawn from the authorization. `final_capture` is derived, not passed:
// it is true exactly when this shipment exhausts the authorization (EC-CAP-1/2).
const capture = await captureShipment(
  order.value.id,
  {
    lines: [{ sku: 'NW-001', qty: 1 }],
    carrier: 'UPS',
    tracking: '1Z999AA10123456784',
  },
  deps,
)

// Nothing more will ship: release what is still authorized.
await voidRemainder(order.value.id, 'OUT_OF_STOCK', deps)

// Money already taken back: a refund. `'FULL'` resolves to the exact remainder **before** the request.
await refund(capture.value.capture.paypal_capture_id, 'FULL', 'RETURN', actor, deps, {
  idempotencyKey,
})

// The day-3 cron primitive.
await reauthorizeIfNeeded(authorizationRowId, deps)
```

All five return `Result<T, CsError>` (AGENTS.md rule 3). **None of them throws across the module boundary**,
and none of them makes a decision that is not already in the database.

`createOrderFromDecision` keeps §8.11's signature verbatim — `(decision, deps) -> Result<OrderRow>` — and
reads the rest of the draft from the database keyed on `GateDecision.id`. Where an operator or a caller
needs more than the row, use `createOrderFromDecisionDetailed`, which returns `CreateOrderReport`: the
request id, the PayPal authorization/capture id, and **which authorization branch ran** (see C2 below).

---

## What is in here

| File              | Contents                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| `types.ts`        | `OrdersDeps`, `OrderStore`, `BudgetHooks`, `Notifier`, and the vocabulary (§8.11's argument shapes).                 |
| `deps.ts`         | the port → `@countersign/db` repository map, the budget-hook wiring, deterministic ids, and the in-memory row world. |
| `create.ts`       | `createOrderFromDecision`, D18's `custom_id` hash, and the C2 inline/fallback decision.                              |
| `capture.ts`      | `captureShipment`, the money allocation, `final_capture`, EC-CAP-3/4/5, EC-SPLIT-1/2, EC-FX-4.                       |
| `tracking.ts`     | `POST /v2/checkout/orders/{id}/track`, and EC-CAP-4's "ship nothing while pending".                                  |
| `void.ts`         | `voidRemainder`, EC-STOCK-1's release, EC-MDT-3/4.                                                                   |
| `refund.ts`       | `refund`, EC-REF-1…5, EC-IDEM-5/6, and why it moves no ledger entry.                                                 |
| `reauthorize.ts`  | `reauthorizeIfNeeded`, EC-TIME-5's two clocks.                                                                       |
| `budget-hooks.ts` | the four §8.11 ledger sentences, and the reasoning for the three that move money.                                    |

---

## The four money invariants

Money is integer minor units plus an ISO-4217 currency code, everywhere, with no float and no rounding
(AGENTS.md rule 9). `scripts/check-money-discipline.mjs` scans `src/` for the usual offenders; the four
invariants below are the ones it cannot check for you.

### 1. `Σ captures == authorized`, exactly

`capture.ts` delegates to `allocate()` in `@countersign/core` (largest-remainder over `bigint`) rather than
rounding a running total, so the last shipment absorbs the remainder and the sum lands on the authorization
to the cent. Proven as a property, not just for the fixtures: `test/capture.test.ts` asserts that **any
partition of a cart's units into shipments** sums to the order total.

### 2. Shipping is allocated **per unit**, not per line

A per-line split gives a line the whole shipping fee, so shipping one unit of a two-unit line would exceed
the authorization and the second unit could never ship. Per unit, each unit carries its own share, and
`Σ shares == shipping_minor` exactly. This is what makes invariant 1 hold for _every_ split rather than only
the splits the fixtures happened to use.

### 3. `final_capture = (remaining == 0)` — derived, not passed

`captureShipment` computes it, so a caller cannot ship the last of the goods and leave a dead authorization
behind. The one override is explicit and named: `finalCapture: true` on a partial shipment, which is
EC-STOCK-1's "1 item unavailable, you were charged only $60.00".

### 4. An over-capture or over-refund is refused **before** any HTTP request

Both guards are arithmetic over `bigint` (`capture.ts` for EC-CAP-3, `refund.ts` for EC-REF-2), and both are
backed by a guarded `UPDATE` in `repos/orders.ts` so a race between two concurrent attempts cannot both
pass. The local refusal is what gives the user an exact "Only 5000 remains refundable." instead of a PayPal
error page — and it is why `AT-M11.3`/`AT-M11.4` can assert **no request was made**.

---

## D18: what `custom_id` commits to

```
custom_id = "cs1:" + base64url(sha256(JCS(bundle)))
```

4 + 43 = 47 characters, inside PayPal's 1–255 ([V11]). It is the only string that ties a PayPal transaction
to the signed chain **inside PayPal's own records**, which is what makes the claim checkable by a judge who
has the PayPal dashboard and nothing else.

The hashed members are the nine of §7.3's bundle, exported as `EVIDENCE_BUNDLE_HASHED_MEMBERS`:

```
v, l1, l2, l3a, l3b, checkout_jwt, gate_decision, webauthn, vi_lib_commit
```

`paypal` and `shipments` are **excluded**, exported as `EVIDENCE_BUNDLE_EXCLUDED_MEMBERS`: §7.3 says they are
only knowable after the order exists, so including them would make the hash depend on the very thing it is
stamped onto. A verifier needs the member list exactly, and a list that lives only in a comment is a list
that drifts — so the array is exported and `test/create.test.ts` recomputes the hash **from the stored rows**
rather than from the value the code produced.

---

## The budget hooks are asymmetric on purpose

§8.11 lists four outcomes, and they do not all move money:

| Outcome                 | Hook                    | Why                                                            |
| ----------------------- | ----------------------- | -------------------------------------------------------------- |
| capture `COMPLETED`     | **COMMIT**              | the money moved and stays moved                                |
| void / decline / expiry | **RELEASE**             | authority ends: the buyer may spend that amount again tomorrow |
| **refund**              | **nothing**             | a refund does not return **authority** — see below             |
| chargeback reversal     | **REVERSE**, audit-only | the money went to the buyer by PayPal's decision, not ours     |

The refund row is the one that reads like a bug, so the reasoning is written out in `budget-hooks.ts` and
asserted negatively in `test/refund.test.ts`: `reserved`/`spent` model _authority_, not wealth. A refund
that gave the money back would let "charge $40, refund $40, charge $40" run free inside a cap the user
believes bounds the total — the §12.10 abuse. The test asserts the ledger is **byte-identical** before and
after a full refund, over three consecutive cycles, because that is the assertion most likely to be broken
by accident later.

---

## C2: which branch authorized the order

Spec **U2** calls it unverified: does a merchant-initiated `AUTHORIZE` order against a vault come back with
the authorization **inline**, or does the order need a second `POST /authorize` call? Both branches are
implemented, in this order:

1. `purchase_units[].payments.authorizations[]` — present in the OpenAPI schema (`payment_collection`) and
   in the `vault_id` + `AUTHORIZE` 201 example (audit §17).
2. `POST /v2/checkout/orders/{id}/authorize` — documented, and the route the interactive flow uses.

**Which one ran is recorded** on `orders.raw.countersign.authorizationPath` (`INLINE` /
`AUTHORIZE_ENDPOINT` / `NONE`) and logged with the PayPal order id, rather than left to be inferred from a
branch that happens to work. That is not bookkeeping for its own sake: C2's answer has to come from evidence
the nightly sandbox run collects. `test/create.test.ts` exercises **both** branches and says which each test
took; `test/orchestrator.sandbox.test.ts` prints the real answer as `[C2] authorizationPath=…`.

The record lives inside `raw` rather than in a column of its own because the reconciler replaces `raw` from a
`GET`, and a separate file would be lost on the first fetch.

---

## Testing without credentials

AGENTS.md rule 5 says _"never fake PayPal behaviour. No mocking of PayPal outside
`packages/paypal/test/fixtures`."_ The position this package takes:

- **The socket is the only thing replaced.** Every offline test injects `fetchImpl` into the production
  `PayPalClient`, which is the seam `PayPalClientOpts` already declares. Request building, the
  `PayPal-Request-Id` header, the retry loop, the backoff, the circuit breaker and the zod parsing all run.
  The _responses_ are doc-derived stubs — the same seam `packages/paypal/test/fixtures/transport-double.ts`
  uses. No test asserts PayPal behaviour from those bodies.
- **The budget is not faked at all.** It is `createInMemoryBudgetStore` from `@countersign/gate`, driven
  through the real `commitIn`/`releaseIn`/`reverseIn` from `@countersign/db`, so the ledger arithmetic under
  test is the arithmetic that ships.
- **Our own rows are in-memory, and deliberately careful about the parts that _are_ the defences.** The
  unique indexes (`orders_attempt_id_key` is AT-M11.5's backstop), `applyRefundToCapture`'s guarded
  `UPDATE`, `ROLLBACK` undoing writes rather than merely releasing locks, and `FOR UPDATE` on the mandate
  re-read are all modelled. A double that is easier than the real thing turns every assertion into a
  measurement of the double.
- **One fixed instant.** `NOW_SEC` and an injected clock mean no assertion is ever about "roughly now"
  (AGENTS.md rule 10).

| Command                                          | What it runs                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `pnpm --filter @countersign/orders test`         | the four offline suites (99 tests). No network.                                    |
| `pnpm --filter @countersign/orders test:sandbox` | the live half of AT-M11 + the C2 question. Skips with a printed reason until H-01. |

---

## Contract issues

Reported rather than worked around, per AGENTS.md rule 8. Each is a member of `OrderRepoHandles` that the
orchestrator needs and `@countersign/db` does not have, so they are **caller-supplied handles** in
`deps.ts`. `orderStoreFromRepos` is a pure rename-and-forward, so a port member without a repository behind
it is a compile-time fact rather than a runtime surprise.

| Handle                      | What is missing                                                               | Why the orchestrator needs it                                                                                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lockMandateForUpdate`      | `repos/mandates.ts` has no `SELECT … FOR UPDATE`                              | **EC-MDT-2** requires the second mandate read inside the insert transaction. `packages/gate` hit the same wall for its own `lockMandate`.                                             |
| `findL1Credential`          | there is no `repos/l1_credentials.ts`                                         | §7.3's `l1` bundle member, which D18's hash covers.                                                                                                                                   |
| `findRefundById`            | `repos/orders.ts` looks refunds up by capture and by PayPal id, not by row id | EC-REF-3's retry has to read the **FAILED** row it is retrying.                                                                                                                       |
| `findOpenDisputeForCapture` | `repos/disputes.ts` has no by-capture lookup                                  | **EC-REF-4**'s detection. Note the join: `disputes.capture_id` is a foreign key to `captures.id`, **not** to PayPal's capture id, so the lookup must resolve through the capture row. |
| `findShipmentByTracking`    | no by-tracking lookup                                                         | the shipment insert's idempotency key needs one (`shipments_tracking_number_key`).                                                                                                    |

**And one gap inside an existing function:**

- `authorizations.expiration_time` cannot be restamped after a reauthorization. `repos/orders.ts::
setAuthorizationStatus` takes only a status, and PayPal's response is the authority on the new expiry — the
  extension is geography-dependent (up to 115% in the US). Until a writer exists, the row keeps PayPal's
  **original** expiry, which is **conservative in the safe direction**: `honourWindowOpen` reports `expired`
  at the old date, so the worst outcome is that the day-28/29 cron expires a row that could still have been
  captured — rather than that we keep waiting on an authorization PayPal has already dropped. The gap is
  logged on every reauthorization (`expiryRestamped: false`) rather than left silent.

---

## Verify these before a judge does

1. **C2 — inline or `/authorize`?** Spec U2, unverified. `test/orchestrator.sandbox.test.ts` prints the
   answer; `README.md` above says what each answer means.
2. **Does a `PayPal-Request-Id` actually deduplicate?** EC-IDEM-2's premise. `packages/paypal` has the same
   open question, and one sandbox run answers both.
3. **Does an unsigned-on-purpose replayed authorization id behave as the docs say?** [V15]'s reauthorization
   window is the one that would surprise us if it were narrower than "days four to 29".
4. **Does a partial capture against a vault behave as documented?** Our arithmetic is exact; PayPal's
   tolerance for a sub-dollar remainder is not something this repository has evidence about.
