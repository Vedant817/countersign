# `@countersign/gate`

The deterministic Gate — spec **§8.10** (M10, WP-10) — and the merchant catalog it prices against,
spec **§8.9** (M9, WP-09). Spec **D19**.

```bash
pnpm --filter @countersign/gate typecheck
pnpm --filter @countersign/gate lint
pnpm --filter @countersign/gate test     # 241 tests, no database, no network, no credentials
```

## What this package is

§3.1 invariant **I-1**: _no PayPal money movement happens unless a Gate `ALLOW` decision record exists
for exactly that order, amount, currency and payee._ `evaluate(input, deps)` is the only thing in the
repository that produces such a record, and the whole package is arranged so that producing one means
nothing more than arithmetic.

```ts
const decided = await evaluate({ attemptId, mandateId, checkoutId, l3a, l3b, agentId }, deps)
if (!decided.ok) return decided                 // CS_INTERNAL: nothing was charged
if (decided.value.decision !== 'ALLOW') { … }   // reasons[] explains every failure, not just the first
await orders.create(decided.value)              // signedRecord is the artefact I-1 requires
```

Two properties of the package as a whole are load-bearing, and both are enforced rather than promised:

1. **It cannot reach a model.** §8.10: "**No LLM** anywhere in M10, enforced by a lint rule banning
   imports from `ai`/`@ai-sdk/*` in `packages/gate`." `eslint.config.mjs` (`GATE_LLM_BAN`, D-018) is that
   rule, and `GateDeps` is a _closed_ list of capabilities, so "no LLM" is a statement about a type.
2. **Every check always runs.** §8.10: "all checks always run so every reason is reported; the decision
   is ALLOW only if all pass." There is no early return anywhere in `evaluate`. Short-circuiting would be
   faster and would lose the one thing a buyer needs — every reason their agent has to change.

## The twelve checks, in order

`CHECK_ORDER` in `checks.ts` is the single list; `evaluate` iterates it and a decision always has twelve
rows (`hasEveryCheck` says so).

| #   | Check                                                                                 | Data it reads                                                            | Fails with                                         |
| --- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------- |
| 1   | Mandate `ACTIVE`, not revoked, `exp > now − skew`                                     | `mandates`                                                               | `GATE_REVOKED` / `VI_EXPIRED`                      |
| 2   | Agent `ACTIVE`, L3 key == the L2-bound key                                            | `agents` + the L3a `kid`                                                 | `GATE_AGENT_SUSPENDED`                             |
| 3   | Device `ACTIVE` (not `LOST`/`REVOKED`)                                                | `devices`                                                                | `GATE_REVOKED`                                     |
| 4   | vi `/v1/verify` **strict**: `chain_valid` and `constraints.satisfied`                 | `ViClient.verify`                                                        | `VI_CHAIN_INVALID` / `VI_CONSTRAINT_VIOLATION`     |
| 5   | Checkout JWT hash == L3b `checkout_hash`, signed by a current-or-retired merchant kid | `checkout_sessions` + the merchant JWKS                                  | `VI_CHAIN_INVALID`                                 |
| 6   | `price_lock_exp > now`, totals == L3a amount, currency equal                          | `checkout_sessions` + L3a claims                                         | `GATE_PRICE_LOCK_EXPIRED` / `CS_CURRENCY_MISMATCH` |
| 7   | L3 `jti` unused — unique insert, not a `SELECT`                                       | the `checkout_attempts` insert                                           | `GATE_REPLAY`                                      |
| 8   | Budget: `FOR UPDATE`, `reserved + spent + amount ≤ min(signed L2 ceiling, cap)`       | `BudgetStore` + the verified chain                                       | `GATE_BUDGET_EXCEEDED` / `VI_CONSTRAINT_VIOLATION` |
| 9   | Wallet cap for the period, across **all** mandates                                    | `wallet_caps` + `budget_entries`                                         | `GATE_WALLET_CAP`                                  |
| 10  | Stock for every line                                                                  | `products`                                                               | `GATE_OUT_OF_STOCK`                                |
| 11  | Recurrence / `agent_recurrence` windows, if present                                   | `budget_entries` + the verified chain + the `mandates.constraints` cache | `VI_CONSTRAINT_VIOLATION`                          |
| 12  | Velocity: > 5 attempts / 10 min, or > 3 BLOCKs in a row → `REVIEW` + `SUSPENDED`      | `checkout_attempts`                                                      | `GATE_BLOCKED`                                     |

The order is the spec's, and the spec's order is cheap-first and side-effect-last: 1–7 are reads or one
unique insert, so the only check that takes a lock and writes (8) comes after everything that can rule an
attempt out without touching the database.

## Seven things that are not obvious

### 1. Checks 8 and 9 run in **one transaction**, and the transaction can refuse to commit

`deps.transaction` takes a handle, not a bare callback:

```ts
await deps.transaction(async (tx) => {
  const budget = await check8Budget(ctx)
  const walletCap = await check9WalletCap(ctx)
  if ([...budget.reasons, ...walletCap.reasons].length > 0) tx.rollback('check 8/9 refused')
  return [budget, walletCap]
})
```

Check 9 must see check 8's **uncommitted** reservation, or two agents on one wallet (EC-MA-1) would both
pass a cap only one of them can spend. And when check 9 refuses, the rollback takes check 8's RESERVE
insert with it — so AT-M10.4's "no leaked reservation" is a property of the transaction, not of a
compensation path that has to remember to run.

Compensation still exists for failures _after_ the transaction (checks 10, 11, 12), and is deliberately a
second, independent mechanism: the transaction is a database property a misconfigured `deps.transaction`
could turn into a no-op, while the release is in our code and testable without a database.

### 2. `FOR UPDATE` cannot be forgotten, because this package cannot express anything else

Check 8 is `reserveForAttempt(deps.budget, …)` from `@countersign/ledger`, which is `reserveIn` from
`@countersign/db`, and `reserveIn`'s _first statement_ is
`SELECT … FROM budget_accounts WHERE mandate_id = $1 FOR UPDATE`. There is no second implementation of
the cap arithmetic in the repository, and no way to write one here: the only thing `budget-guard.ts` can
reach is the port, and `lockBudgetAccount` **is** the locking statement. A refactor that wanted the
optimistic `UPDATE … SET reserved = reserved + $1` path — the hazard `packages/db/repos/budget.ts` names
in its own header — would have to write that SQL itself, in a review, in this package.

AT-M10.2 is the proof and it is not a tuning parameter: 20 concurrent attempts, a $100.00 cap, $30.00
carts → **exactly 3 ALLOW** = `floor(10000 / 3000)`. Without the lock all twenty read `reserved = 0`,
all twenty see `3000 ≤ 10000`, all twenty write `reserved = 3000`, and a $100 budget authorises $600.
`createInMemoryBudgetStore` models the lock with a per-mandate promise chain, so the test measures the
Gate and not the absence of a database. `test/budget.test.ts` runs the same race with
`serialiseLocks: false` and asserts the opposite outcome — a fake that has no lock must fail the race
test, or the test proves nothing.

### 3. `notApplicable` is `passed: false`, never `passed: true` — and an obligation that cannot be read is not `notApplicable` at all

Spec **D19**: the pinned Verifiable Intent library lists `mandate.payment.budget`, `.recurrence` and
`.agent_recurrence` as _network-enforced and not evaluated_. `apps/vi` reports them in
`constraints.skipped`, and checks 8, 9 and 11 here are the entire reason a buyer's budget and recurrence
limits are real.

The obligation is read with `pendingNetworkEnforcement(verify.constraints.skipped)` from
`@countersign/vi-client`, and a non-empty result is an **obligation**, never information. See D-019 for
why `skipped.includes('mandate.payment.budget')` is a silent `false` and why that fails **open**.

A check with nothing to enforce is recorded as `passed: false, notApplicable: true` — it does not block,
and it does **not** claim to have passed. The one thing this package must never do is manufacture a
`passed: true` it did not earn, which is why the "skipped" shape is a compile error and
`notApplicable` is a distinct field rather than a convention. `test/d19.test.ts` pins it.

### 4. The signed constraint is authoritative, and our columns cannot loosen it

`notApplicable` being non-blocking is exactly why the last two bugs were so bad. Both were the same
mistake — reading **our own columns** where the buyer's signature was required:

|               | What was read                       | What the buyer signed                           | Decision                                                                           |
| ------------- | ----------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| **QA-gate-1** | `budget_accounts.cap_minor` = 20000 | `mandate.payment.budget.max` = **2000**         | `ALLOW` a 3000 cart                                                                |
| **QA-gate-2** | `mandates.constraints` (empty)      | `recurrence MNTH number:1`, 2 commits in window | `ALLOW`, and check 11 claimed _"the signed L2 discloses no recurrence constraint"_ |

The signed values are read from **`VerifyResponse.disclosed.l2`** — the payload vi decoded out of the
`sd-jwt+kb` the buyer's device key signed, during the `verify_chain` call check 4 had **already made**.
There is no extra network call: it is a field on the response in hand. If a change ever needed a round
trip to learn the buyer's ceiling, it would be reading the wrong source.

| Source           | What it is                                     | Standing                        |
| ---------------- | ---------------------------------------------- | ------------------------------- |
| `signed_l2`      | `disclosed.l2.delegate_payload[*].constraints` | **the token; authoritative**    |
| `mandate_column` | `mandates.constraints`, our JSONB cache        | a cache, and still a real limit |
| `account_cap`    | `budget_accounts.cap_minor`, the locked row    | a cache, and still a real limit |

The enforceable limit is **`min` of all of them**, not "prefer the token". Each is a limit the buyer is
bound by, and a Gate that enforced the looser of two real limits is the only one a buyer could call _"you
spent more than I agreed to"_. A tie is credited to the signature, so the detail names the source with the
most authority, and every candidate appears in the message — a dispute asks which number stopped it, not
merely that some limit did.

The signed comparison runs against the balance `reserveIn` computed **inside** its own `FOR UPDATE`. That
is the only place the numbers are race-free, and it is why there is still no second implementation of the
cap arithmetic in this package: `budget-guard.ts` never re-derives `reserved + spent + amount ≤ cap_minor`,
it asks whether the balance that already exists survives a ceiling the signature states. The cost is that
the RESERVE row briefly exists inside the transaction, and `evaluate` rolls it back.

**An obligation that cannot be discharged is a `BLOCK`, never an `ALLOW`.** If vi reported
`mandate.payment.budget` as network-enforced and the ceiling cannot be read from the chain — malformed
constraint, two currencies, a disclosure that never arrived — then nobody enforced the buyer's limit, and
the only remaining outcomes are refusing or spending without it. `obligationUnmet` returns
`VI_CONSTRAINT_VIOLATION` and check 8 (or 11) refuses **before writing anything**. `REVIEW` was considered
and rejected: §8.10's table gives no `REVIEW` for an unenforceable signed budget, and a check that can be
waved through is a check that eventually will be.

`test/signed-budget.test.ts` is the file. It opens with the QA repro verbatim, and ends with a property
test: **1,000 random (signed ceiling, cart) pairs, and the Gate never allows a purchase larger than the
ceiling the buyer signed** — with the account cap generated to be always looser, so a `BLOCK` can only be
attributed to the signature.

#### The path is asserted against a real response, not against our own idea of one

`test/signed-budget.test.ts` builds its fixtures by hand, and a hand-built fixture **cannot** tell a
reader that matches real vi-service output from one that matches the author's imagination of it. That is
the whole risk in a `strictObject` schema reading a foreign wire format, so the path is pinned against a
**committed real capture** instead.

`test/fixtures/vi-verify-budget-capture.json` is the body `POST /v1/verify` actually returned, produced by
driving `apps/vi`'s real routes (`/v1/l1/issue` → `/v1/l2/prepare` → `/v1/l2/finalize` →
`/v1/checkout-jwt` → `/v1/l3/create` → `POST /v1/verify`) through `fastapi.testclient` with a fixed clock —
no sockets, no PayPal, no credentials. Every token in it was signed by `verifiable_intent` at
`356c29635f1c44df7de02edb58699ca9f29bece6`, and the same mechanism WP-18 used for
`packages/verifier/test/fixtures/chain.json`.

The signed ceiling lives at **`verify_response.disclosed.l2.delegate_payload[1].constraints[2]`**, quoted
verbatim from the capture:

```json
{ "currency": "USD", "max": 13000, "type": "mandate.payment.budget" }
```

Three facts about that object are load-bearing, and each is asserted:

- **`min` is absent, not `null`.** `PaymentBudgetConstraint.to_dict()` _omits_ an unset optional rather
  than emitting null, so `budgetConstraintSchema`'s `.default(null)` is what makes the omission legal. A
  fixture that quietly grew `"min": null` would stop exercising that path.
- **No constraint entry in the response is an SD-hash reference.** `create_layer2_autonomous` substitutes
  `{"...": hash}` for _merchant and item values_ — entries of an `allowed` / `acceptable_items` array —
  and never for a whole constraint. That is why the inline walk in `disclosedConstraints` is sufficient
  rather than merely convenient, and it is asserted rather than assumed. If it were ever otherwise,
  `readSignedBudget` reports `found: false` and the obligation guard BLOCKs.
- **`pendingNetworkEnforcement` reports all three network-enforced types** from that same response, so the
  obligation the reader discharges and the numbers it reads come from one response, not two.

`test/real-vi-capture.test.ts` runs the reader against it, and then drives `evaluate` with it: a $30.00
cart against the signed $130.00 ceiling and a $200.00 account cap **ALLOWs** with check 8 naming the
signature as the binding cap, and the same capture with a $140.00 cart **BLOCKs** with
`GATE_BUDGET_EXCEEDED`. The account cap is deliberately looser than the signature in the passing case, so
an ALLOW cannot be attributed to the cache.

`recurrence` and `agent_recurrence` are pinned in the same file, with the exact key names the library
emits: `frequency` / `start_date` / `end_date` / **`number`** for `recurrence`, and
`frequency` / `start_date` / `end_date` / **`max_occurrences`** for `agent_recurrence`. The two differ on
precisely the occurrence key, and reading the wrong one leaves `max_occurrences` `null` — which
`evaluateRecurrence` treats as "the date window is the whole limit", the loosest possible reading of a
signed cap. There is a test for exactly that confusion.

### 5. One clock read, taken once

`deps.clock.nowSec()` is called exactly once, before check 1, and every expiry comparison in the decision
uses that value (§12.5 EC-TIME-4). With a per-check `now`, a price lock could expire between check 6 and
check 12 and produce a decision that was true at no single instant — and this decision goes into an
evidence packet filed with PayPal. `evaluate` has exactly one call site for `deps.clock`; a second one
would be a test failure.

### 6. Check 12 runs last, and runs anyway

It is the only check with a **side effect** (it moves the mandate to `SUSPENDED`) and the only one that
must run even when an earlier check already failed — because the pattern it exists to detect is a flood
of BLOCKs. A Gate that stopped after check 1 could never see the fourth consecutive BLOCK, so the
suspension EC-AGT-2 promises would never happen and a compromised agent (§18 Q7: the attacker owns the
agent loop entirely) would keep trying forever, unpunished.

| Rule                                  | Off-by-one              |
| ------------------------------------- | ----------------------- |
| `> 5` attempts per mandate per 10 min | 5 passes, the 6th trips |
| `> 3` BLOCKs in a row                 | 3 passes, the 4th trips |

Getting this lenient lets an agent hammer a mandate; getting it strict suspends a buyer who made five
purchases in ten minutes, which is a normal human shopping pattern. `VELOCITY` in `types.ts` is the
named, asserted source of both numbers.

### 7. The signed record is a **nine-field** JWS over a projection of the twelve

```
{ gdc, att, mdt, amount, currency, payee, checks_hash, chain_valid, vi_commit, iat }
```

That is §8.10's payload list, exactly, and `REQUIRED_FIELDS` asserts it — not ten fields, not eight.
`amount` is PayPal's decimal string (the boundary where money becomes text), every other field is ours.
`checks_hash = sha256(canonicalJson(projection))` over a fixed projection of the twelve rows, so the
signature attests to the **working** and not merely the verdict: two decisions that both say `BLOCK` for
different reasons do not share a hash.

Signing is **EdDSA (Ed25519)**, and verification is local — `gateJwks()` is served at
`/.well-known/jwks.json` and `verifyDecisionRecord` needs no network. A record that cannot be signed is
not a decision: `evaluate` throws `CS_INTERNAL` rather than returning an unsigned `ALLOW`, because the
record is the artefact I-1 is about.

## Proving it against a live vi-service

`test/support/live-vi-proof.ts` is the companion to the unit tests, and it exists because the defect above
was invisible to every one of them. Run it with:

```
pnpm --filter @countersign/gate exec tsx test/support/live-vi-proof.ts
```

It starts `apps/vi`'s real FastAPI app under uvicorn on `127.0.0.1:0`, drives **every signing route** over
HTTP (`/v1/keys/agent` → `/v1/l1/issue` → `/v1/l2/prepare` → `/v1/l2/finalize` → `/v1/checkout-jwt` →
`/v1/l3/create` → `POST /v1/verify`) through `test/support/live-vi-chain.py`, then runs the **production**
`deps.ts::gateDepsFromRepos` binding — not `createInMemoryGateWorld` — through `evaluate`. So `deps.verify`,
`deps.findL1ForDeviceWallet` and `deps.merchantKeys` are the real bindings over a real `ViClient`, and the
only in-memory pieces are the Postgres repositories and the `BudgetStore`, because there is no database in
a proof run.

`fastapi.testclient` is deliberately not used: `TestClient` never listens, so a real `ViClient` cannot
reach it, and the whole point is that the client's bytes leave the process. The harness counts fetches
**per path**, because a single total cannot answer "did `/v1/verify` go out?" — and check 5 legitimately
calls `GET /v1/jwks`.

It exits non-zero on any failed assertion and prints an `OUTSTANDING` section naming every check still
failing, so a green run cannot be read as "the whole Gate is healthy".

## Verified disclosed payment and checkout binding (D-034, D-038)

Check 4 retains `VerifyResponse.disclosed.l3a` and `VerifyResponse.disclosed.l3b`, the token payloads vi
resolved while verifying the chain, alongside the signed L2 constraints. A missing or unreadable payment
or checkout disclosure blocks; neither is ever `notApplicable`.

- **Check 5 (Checkout Binding):** `src/signed-checkout.ts::readSignedCheckout` reads `checkout_hash` from
  `verify.disclosed.l3b.delegate_payload[*]` where `vct: mandate.checkout.1`. It returns
  `{ found: true, checkoutHash }` or `{ found: false, why }`. If absent or unreadable, check 5 returns a
  blocking fail (D-035: not `notApplicable`). When present, it verifies the merchant key and signature
  on the session's `checkout_jwt` and binds `checkoutHash` against the session.
- **Check 6 (Price Lock):** `src/signed-payment.ts::readSignedPayment` requires exactly one
  `delegate_payload[*]` with `vct: mandate.payment.1` in `disclosed.l3a`. It compares
  `payment_amount.amount` / `currency` and `payee.id` against the session's `total_minor` / `currency` /
  `merchant_id`, retaining price-lock expiry and refusing currency conversion.
- **Check 7 (Replay):** As recorded in D-034, `verifiable_intent` does not emit a `jti` claim in L3a.
  The deterministic token identity is derived by `src/replay-id.ts::deriveL3ReplayId(l3a)` as
  `base64url(sha256(issuer_jwt))` (the ASCII bytes before the first `~`), matching `apps/vi`'s
  `L3CreateResponse.jti` identically. The unique constraint on `checkout_attempts_l3_jti_key` ensures
  atomic replay rejection with `GATE_REPLAY` without a separate race-prone SELECT.

Run the captured and fresh live proofs together:

```sh
pnpm --filter @countersign/gate exec tsx test/support/live-vi-proof.ts
```

The live proof reuses `live-vi-chain.py` and the production `gateDepsFromRepos`/`ViClient` binding,
with in-memory repository and budget ports. Pass 1 of the live proof now achieves an end-to-end **`ALLOW`**
verdict with all 12 checks evaluated, 0 outstanding failures, and the signed decision record verified.

## A finding in `packages/db`, pinned rather than fixed

`walletCapCheckIn` in `packages/db/src/repos/budget.ts` compares `walletSpendInPeriod(...) + amount > cap`,
and `walletSpendInPeriod` sums `budget_entries` **including the RESERVE check 8 just inserted in the same
transaction**. The current attempt is therefore charged twice against the wallet cap, and the effective
cap is `cap − cart`: with a $150.00 wallet cap and $30.00 carts the intended answer is 5 reservations
and the observed answer is 4.

The file belongs to WP-02, so this package does not edit it (AGENTS.md rule 8). `test/budget.test.ts`
pins the **observed** behaviour with the intent spelled out beside it — `expect(allowed).toHaveLength(4)`
and `expect(floor(15000 / 3000)).toBe(5)` in the same test. It is green today and becomes **exactly one
failing assertion** the moment `packages/db` is fixed, which is the shape a cross-package finding should
have: no silent workaround, and no test that has to be rewritten to acknowledge the fix.
