# WP-15e / WP-16 — the filer, the ingest, and the strategist

Spec **§8.15**'s filing path, **§8.16 (M16)**, **§12.11**, **§7.2**, **§7.3**, decisions **D-013**, **D-018**.
Extends [`../README.md`](../README.md) (WP-15a the router, WP-15b the planner) and
[`./README-DRAFTER.md`](./README-DRAFTER.md) (WP-15c/15d the drafter, the checker, the PDF).

```bash
pnpm --filter @countersign/defender typecheck
pnpm --filter @countersign/defender lint
pnpm --filter @countersign/defender test   # 644 tests, no network, no credentials, no key
pnpm --filter @countersign/defender eval
```

Sandbox-only, **not** in the PR gate (see [Live coverage](#live-coverage-at-m154--at-m163)):

```bash
cd packages/defender && npx vitest run --config vitest.sandbox.config.ts
```

---

## The claim these files have to make honestly

The router decided the posture. **The claim of this work package is that nothing after the router can change it,
and that every attempt to file something is recorded.**

> §18 question 20 — _"Merchant games the evidence?"_ — has three answers in this package, and the third is the
> one that matters:

| #   | Question                             | Answer                                    | Where the mechanism lives                |
| --- | ------------------------------------ | ----------------------------------------- | ---------------------------------------- |
| 1   | What gets filed?                     | `route()` — a rules table, no model in it | `router.ts`                              |
| 2   | What may be **attached** to it?      | **A type.** `EvidenceUploadPermit`        | `filer.ts`                               |
| 3   | What may the strategist **propose**? | **A type.** `StrategistPayPalMethod`      | `strategist.ts`, `strategist-actions.ts` |

2 and 3 are types, not checks. A `REFUND_PROOF` permit has `posture: 'ACCEPT_CLAIM'` as a **literal**, so it
cannot be passed where a `CONTEST` permit is required. `StrategistPayPalMethod` **does not contain
`provideEvidence`**, so no proposal this package can express — whatever a model returns, however malformed — has a
path to an evidence upload. Both are enforced by `pnpm typecheck`, and both are asserted from four directions in
[`test/filer.test.ts`](test/filer.test.ts) and [`test/strategist.test.ts`](test/strategist.test.ts).

And every run writes a `dispute_actions` row — success or refusal — except the one case documented below where no
PayPal call happened at all (§18 question 24).

---

## `ingest.ts` — which order is this dispute about, and what does the router see?

### D-013: the join key is `disputed_transactions[0].seller_transaction_id`

`seller_transaction_id` is **not** a top-level property of a PayPal dispute. It lives in an _array_ (`SPEC-D`
`$ref transaction_info_list`). Reading it from the top level — which the first version of this package did — can
never succeed against a real response, so the join returned `undefined` for every dispute and every case fell
through to R-NOCHAIN-1. **A Defender that always answers "not a Countersign order" is worse than no Defender,
because it looks like a finding.**

`joinDisputeToOrder` has three answers and never throws:

| Outcome                     | Meaning                              | What happens                                                               |
| --------------------------- | ------------------------------------ | -------------------------------------------------------------------------- |
| `LINKED`                    | PayPal's capture id is one of ours   | `disputes.capture_id` / `order_id` written; the router sees the whole case |
| `NOT_A_COUNTERSIGN_PAYMENT` | PayPal named a capture, we have none | row still stored, `PP_NOT_FOUND` as **data**, R-NOCHAIN-1                  |
| `NO_CAPTURE_ON_DISPUTE`     | PayPal named no transaction          | row still stored, `PP_NOT_FOUND`, R-NOCHAIN-1                              |

`PP_NOT_FOUND` appears as a **value** on the two failure branches rather than being thrown, because EC-DSP-9
needs a stored row and a _sentence_. Throwing it would also be a lie in the other direction: PayPal found the
dispute perfectly well; **we** found no capture.

> **The regression test for the original bug is a negative one.**
> `test/ingest.test.ts` feeds a dispute carrying `seller_transaction_id` **only at the top level** and asserts it
> does _not_ join. If someone re-introduces the top-level read to "be tolerant", that test fails — and the
> tolerance would be the bug.

### Two port members no repository can produce

`DefenderStore` is a closed port, and two members exist because **no repository computes them**. Saying so here is
the alternative to quietly inventing a value:

- `evidence.corpus(orderId)` — `EvidenceCorpus` is _which documents exist_. Return `{}`, **never**
  `{ fulfilmentDocument: true }`: the booleans mean "we can put a real document behind this claim", so `true`
  without a document is the direction that files a packet we cannot support.
- `evidence.bundle(orderId)` — §7.3's bundle spans five tables, so it has no single-row getter.

### `undefined`, not `false`

**A fact we could not read is absent, never false.** `webauthnPresent: undefined` makes R-UNAUTH-1 not fire _and_
R-UNAUTH-3 fire, and R-UNAUTH-3's outcome is `REVIEW` or `ACCEPT_CLAIM` — never a contest. That asymmetry is the
§18 question 20 bias, and it is why `buildChain` returns `undefined` rather than `false` for a row it could not
load.

`deviceLostAtSec` is the clearest case: **`devices` has no `lost_at` column** (a §18 question 8 gap), so the
instant comes from `audit.listBySubject(deviceId)` — the earliest matching timestamp, because R-UNAUTH-2 compares
_order_ against the mandate's `iat`. "Lost before signing" and "lost at some point afterwards" are different
claims.

### §7.3's bundle hash, and D-018

`bundleHashFor` is `sha256(canonicalJson(bundle))` — RFC 8785 JCS from `@countersign/db`, the same function
`packages/orders`' D-018 `custom_id` derivation uses. Two implementations of JCS would be two values for one
document, and the whole point of the hash is that a third party recomputes it.

**It covers the whole bundle**, including the two members `custom_id` _excludes_ (`paypal` and `shipments`, which
are added after order creation). That is deliberate: if it excluded `shipments`, a second parcel registered
against the same order would produce the same hash and EC-DSP-10 would treat a genuinely new packet as a
duplicate.

`customIdAgreement` is a **consistency check between two stored values**, not a recomputation —
`packages/orders` owns `customIdForBundle` and is not a dependency here, so a second implementation would be
silent drift in the one value that ties a packet to a PayPal transaction.

---

## `filer.ts` — decide, draft, render, file, or record why not

```ts
const r = await fileDispute(disputeId, deps, { approval: { by: 'usr_merchant' } })
```

**A refusal is `ok`, not `err`.** A refused filing is a _successful run of the filer_ that produced a recorded
outcome, and collapsing the two would make the S-17 timeline lose every refusal in the product — the opposite of
what EC-MER-7 and §18 q24 need.

### The order, and what each step's failure means

| #   | Step                                   | Terminal outcome                       |
| --- | -------------------------------------- | -------------------------------------- |
| 0   | load the row                           | `CS_NOT_FOUND`                         |
| 1   | `route(ctx)` — the router decides      | `err` (unreachable; §8.0 rule 3)       |
| 1b  | EC-DSP-11 withdrawal                   | refusal, **no** PayPal call            |
| 2   | **store `liability` + `router_trace`** | `err`                                  |
| 3   | filing guards — status, then the clock | refusal, **no** PayPal call            |
| 4   | approval (§8.15)                       | `awaitingApproval`, **no** PayPal call |
| 5   | posture dispatch                       | see below                              |

**Step 2 is before step 5 by requirement, not by taste.** "Log and store the rule id and rationale before acting"
is the difference between a case file that explains itself and one that has to be reconstructed afterwards.

### The two guard tables, and why they differ

`STATUS_GATED` is `{ FILE, ACCEPT, OFFER }`; `DEADLINE_GATED` is `{ FILE, APPEAL, ACCEPT, OFFER }`.

Two findings are baked in, and both were bugs before they were design:

- **The tables are keyed on `Disposition`, not on `POSTURE_DISPOSITION[posture].action`.** A `REFUND` posture
  records `action: 'ACCEPT'` (§7.2's enum has no `REFUND` member), so a guard keyed on the action name gated a
  refund on a _dispute response window_ it has nothing to do with — and the first version of this file refused
  every refund with `DEF_WRONG_STATE`.
- **`APPEAL` is absent from the status gate on purpose.** An appealable dispute's `status` is `RESOLVED` and its
  `dispute_state` is `APPEALABLE` (report §11), so a status gate would refuse **every** appeal — precisely the
  cases EC-DSP-6 exists to catch. PayPal gates the appeal on the `appeal` HATEOAS link instead, and
  `PayPalClient.appeal` re-reads the dispute to check it.
- **`MESSAGE` is exempt from both.** EC-DSP-3 prefers `send-message` at `INQUIRY`, where there is no window at
  all, so gating the cheapest action on a filing window would make it the least available one.
- The deadline is read from **`row.seller_response_due_date`**, not `decision.deadline`, because the row is what
  the fetch wrote.

### The upload path, and where the permit binds

`CONTEST`, `APPEAL`, and EC-DSP-1's `REFUND_PROOF`, in the order the spec gives:

1. Build the §7.3 bundle and **hash it** — the content address that makes EC-DSP-10 decidable.
2. Resolve the packet. Same hash already **filed** → return, zero PayPal calls. Same hash **unfilled** → resume it
   at its own id and version. Otherwise `max(version) + 1`, which is EC-DSP-4's "new packet version".
3. **Mint the permit.** `null` → nothing is uploaded and the reason is recorded.
4. Check `dispute_actions` for the request id. Recorded `sent` → return, zero calls.
5. Draft, then check the **final** text. EC-MER-5. A blocked note is not filed.
6. Render the packet PDF from the bundle, with the §7.3 artefact inventory.
7. Size-check the attachments through `@countersign/paypal`'s own `evidenceFileSizes`, so an EC-DSP-12 refusal
   names the file **before any bytes move**.
8. **Persist the packet, then upload.** The packet row is written _before_ the call so a timeout still leaves a
   case file; `markPacketFiled` writes PayPal's answer afterwards.

`narrowPlanToPermit` runs between (2) and (3)'s consequence: it drops every planned item the permit does not name,
and refuses if the permit names something the plan cannot produce. Without it the pin would be an annotation —
`planEvidence` merges the router's `evidenceRequired` with `EVIDENCE_BY_REASON[reason]`, so an `UNAUTHORISED`
contest plans four types, and three of them on a `REFUND_PROOF` permit are **a contest's worth of evidence
attached to an accept-the-money decision**. That is EC-DSP-1's exact failure mode arriving through the evidence
list rather than through the posture.

### EC-DSP-1: three permit kinds, not two

> **This is a deliberate deviation from the work-package brief, and the reason is a money bug.**

The brief said a `REFUND_PROOF` permit rides on `CONTEST` or `APPEAL`. EC-DSP-1 requires R-REF-1 / R-CNP-1 — both
`posture: 'ACCEPT_CLAIM'`, `liability: 'ALREADY_REFUNDED'` — to upload `PROOF_OF_REFUND` with the refund id in
`evidence_info.refund_ids`. Calling `accept-claim` there would ask PayPal to refund money that has already been
returned; the only other endpoint that carries `refund_ids` is `provide-evidence`. So there are **three** permit
kinds, and `REFUND_PROOF`'s `posture` is the literal `'ACCEPT_CLAIM'`, which is what stops it being passed as a
`CONTEST` permit.

`R-REF-1 → CONTEST` escalation is impossible in three independent ways, all asserted:

| Mechanism                                                  | Where                                 |
| ---------------------------------------------------------- | ------------------------------------- |
| the permit's `posture` is a **literal**, not `Posture`     | `EvidenceUploadPermit` union          |
| the permit is only minted when the posture already matches | `uploadPermitFor`                     |
| the request id is derived from **our** ids, never a model  | `disputeActionRequestId` + `tokenFor` |

### EC-DSP-10 in three layers

| Layer       | Mechanism                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| **content** | `bundle_hash` over the §7.3 bundle, computed **before** the version is chosen                           |
| **key**     | `disputeActionRequestId` used as **both** the `PayPal-Request-Id` and `dispute_actions.idempotency_key` |
| **refusal** | a `:nofile` suffix, so a blocked attempt does not consume the key a successful retry needs              |

The two key uses are the **same string**, so the local check and PayPal's own deduplication cannot disagree about
what "already done" means.

### Refunds are a port, not a client call

`DefenderRefunds` exists because `PayPalClient.refundCapture` would be a genuine money bug, not a style
preference:

1. `packages/orders` is **not** a dependency of this package, and adding one is a `package.json` change this work
   package does not own.
2. `orders.refund()` already owns the over-refund guard, the `refunds` row, `captures.refunded_minor` and the
   asymmetric §8.11 ledger hooks. Duplicating any of it would put **two writers on one money column**.
3. **A refund with no row breaks the next router run.** R-REF-1 reads `refundedTotal(ctx)`, which sums `refunds`
   rows. A refund made without one leaves `refunded_minor` at zero, so a later chargeback-after-refund would file a
   packet arguing that money we already returned was never returned — the most expensive bug this product could
   have.

`refunds.refund({ captureId, amount, reason, actor, disputeId, ruleId })` must therefore be wired to
`orders.refund(...)`. **A wrong wiring here is a money bug rather than a crash**, which is why the contract says
"the row too" in the type's own documentation, and why the filer records the returned `paypalRefundId` in
`dispute_actions` where a merchant can see it went missing.

### EC-MER-5, honestly

**A hostile model does not block a filing.** `draft()` substitutes `templateNote()` after one repair turn, which is
§8.15's stated behaviour and the reason a filing survives a model outage. So the guarantees EC-MER-5 actually buys
are two, and `test/filer.test.ts` asserts both:

1. the forged text is **discarded** — `packet.noteSource === 'template'` and none of the forged sentences are on
   the wire;
2. `checkForFilingAtFileTime` **refuses hand-edited text** — which is the rung a merchant can reach from S-18.

`templateNote()` means **no test in this package needs an OpenAI key** (`docs/HUMAN_TODO.md` H-02): the filer
composes the note itself when no `llm` is supplied, and `checkCitations` passes it **by construction**.

---

## `strategist.ts` — the model proposes, the posture disposes

```ts
const r = await proposeStrategy(ctx, decision, { priorOffers: [], llm })
```

§8.16: _"The LLM proposes the next action for non-filing states… Every proposal shows its expected cost, and every
action needs a merchant click."_

### The posture table

| Posture        | Permitted                                           | Why these                                                            |
| -------------- | --------------------------------------------------- | -------------------------------------------------------------------- |
| `REFUND`       | _none_                                              | the money movement is decided; the strategist must not relitigate it |
| `ACCEPT_CLAIM` | `MESSAGE_BUYER`                                     | we conceded; the only thing left is to say so                        |
| `CONTEST`      | `PROVIDE_SUPPORTING_INFO`, `ESCALATE`               | post-file moves. **EC-DSP-5**: never re-file                         |
| `OFFER`        | `MAKE_OFFER`, `MESSAGE_BUYER`                       | the offer itself, and talking while the buyer decides                |
| `MESSAGE_ONLY` | `MESSAGE_BUYER`, `MAKE_OFFER`, `ACKNOWLEDGE_RETURN` | EC-DSP-3: these cost nothing and spend no response                   |
| `APPEAL`       | `PROVIDE_SUPPORTING_INFO`, `APPEAL`                 | EC-DSP-6: the appeal, plus the facts that go with it                 |
| `REVIEW`       | `REVIEW_WITH_HUMAN`                                 | a human decides; the strategist's only product is the summary        |

**Nothing files evidence in any row, and the strategist cannot lower a posture either.** `permittedActionsFor`
then filters by what _this case_ can do: `APPEAL` needs the posture, `MAKE_OFFER` needs money left, and
`ACKNOWLEDGE_RETURN` needs a shipment.

The **model's only power is a ranked candidate list**: zod-validated, filtered through the table, and then
**re-ranked by our table rather than by the model's order**. A candidate naming `PROVIDE_EVIDENCE`, `FILE` or
`REFUND` is dropped and named in `warnings`. A model that is down, returns garbage, or does not exist leaves the
deterministic proposal standing.

### The offer arithmetic, and why it is `allocate()`

- `offerBudget` subtracts `completedRefunds(ctx)` — **the same reader R-REF-1 used**, so the strategist's ceiling and
  the router's threshold cannot drift — and every prior offer. `remaining` floors at zero.
- `partialOfferAmount` expresses "a share of what is left" as **two integer weights**, never a float and never a
  percentage string: `allocate(remaining, [n, d − n])[0]`. The complement takes the exact remainder, so the two
  parts sum to `remaining` with nothing invented or lost (EC-FX-4, §18 q22).

On `USD 129.99`, half is **6500 / 6499**. Which half gets the odd cent is a choice; that they sum to 12999 exactly
is not. Computing `remaining × n / d` would give 6499 and 6499 — one cent unaccounted for.

**A `remaining` of zero, or a share that rounds to zero, is refused rather than clamped.** A `$0.00` offer is a
rejection, and a clamped amount is a number the merchant never agreed to.

### The cost, and the label that travels with it

`CostBreakdown` carries MRC's average handling cost (`8_200n`) **and** the label, and the label is a **literal
type**: `handlingCostIsIndustryAverage: true`. As a `boolean` it would be deletable in a refactor without a type
error. An $82 figure presented as Countersign's own measurement would be a fabricated statistic in a product whose
entire claim is that it does not fabricate.

`requiresApproval: true` is a literal for the same reason: §8.16's "every action needs a merchant click" cannot be
dropped by a refactor.

---

## `strategist-actions.ts` — one endpoint per arm, and four re-checks

```ts
const out = await executeStrategy(proposal, decision, ctx, deps, { approvedBy: 'usr_merchant' })
```

`approvedBy` is a **required** option. That is the whole enforcement of the merchant click: a TypeScript caller
cannot forget it, and there is no default actor anywhere in the file.

The four re-checks are not redundant with `strategist.ts`, because between proposing and clicking a proposal can be
stale, edited, or come from somewhere else:

| Re-check     | Refusal code               | What it prevents                                                                    |
| ------------ | -------------------------- | ----------------------------------------------------------------------------------- |
| `approvedBy` | `CS_VALIDATION`            | "sent with a default actor"                                                         |
| posture      | `CS_FORBIDDEN`             | a stale proposal executed outside its own posture                                   |
| money        | `CS_VALIDATION` (recorded) | `Σ offers + prior refunds ≤ capture` at the **boundary**, not only at proposal time |
| bodies       | `CS_VALIDATION` (recorded) | an `offer_type` outside PayPal's set, an `APPEAL` with no evidence body             |

The `Money` re-check takes `ctx` threaded in separately from the proposal, because the `priorOffers` a caller
passes **at the click** may be newer than the ones the proposal was computed from.

`resolveOfferType` keeps `offer_type` and its required companion together: PayPal **requires
`return_shipping_address` whenever `offer_type` is `REFUND_WITH_RETURN`** (`SPEC-D`, report §4/#10), so
`REFUND_WITH_RETURN` is returned only when an address was supplied. Hard-coding it would be a 400 on every offer
from a merchant with no returns desk; hard-coding `REFUND` would quietly drop the return that makes the offer
attractive.

**The path carries PayPal's id, not ours.** `ctx.dispute.paypalDisputeId`, while the _request id_ carries ours —
§0 rule 6 is about request ids. Passing `dsp_…` into `/v1/customer/disputes/{id}` produced a 404 on every strategy
action, and because a refused action is `ok` with `sent: false` rather than an `err`, it looked like a refusal
policy rather than a wrong id.

---

## The `dispute_actions` row

**Every run writes one, except the two documented absences.**

| Case                | `action`     | Row?   | Why                                                                                                                 |
| ------------------- | ------------ | ------ | ------------------------------------------------------------------------------------------------------------------- |
| `FILE`              | `FILE`       | yes    |                                                                                                                     |
| `REFUND`            | **`ACCEPT`** | yes    | §7.2's enum has no `REFUND` member, so the row carries `disposition: 'REFUND'` and `paypal_refund_id` in `response` |
| `MESSAGE`           | `MESSAGE`    | yes    |                                                                                                                     |
| `OFFER`             | `OFFER`      | yes    | `fileDispute` only _proposes_; `executeStrategy` sends                                                              |
| `REVIEW`            | `null`       | **no** | no PayPal call happened; `router_trace` + `defense_state` are the record                                            |
| `REVIEW_WITH_HUMAN` | `null`       | **no** | same reasoning                                                                                                      |

`request` carries the rule id, the posture, the liability, the rationale, the deadline band, the packet hash, the
evidence types and — for a strategy — the cost comparison **with its label**, so a UI renders it without
recomputing. `response` carries `paypal_call` (`sent` / `none`), the disposition, the refusal, the blocked lines,
the refund id and the names of every PayPal method called.

`paypal_call` is the key EC-DSP-10's dedupe reads (`responseSentPaypalCall`), so any row written by a caller has
to use it — writing only `sent` made idempotency work by accident and loudly (`CS_CONFLICT` from the UNIQUE
constraint on the second run).

---

## Bugs found in other packages

Reported, not fixed (AGENTS.md rule 8 — another work package's files):

1. **`packages/webhooks/src/jobs.ts:699`** casts `dispute_life_cycle_stage` without checking it. A stage PayPal
   adds next year produces a Postgres **`22P02`** _inside_ the store call, after the row is already open.
   `ingest.ts`'s `disputeStageFor` refuses instead, which is why its doc comment names this line.
2. **`refunds` has no `completed_at` column**, so "when did this refund finish" has no home. `RefundFacts.atSec`
   is derived from `created_at`, which is the best available and is **not** the same thing for a refund PayPal
   completed days later. §8.16's timeline wants the real instant.
3. **`dispute_actions.action` has no `REFUND` member** (§7.2). A refund therefore records as `ACCEPT`, which is
   correct but lossy: a query for "disputes we settled" cannot distinguish "we paid the buyer" from "we accepted
   the buyer's claim". The `disposition` member in `response` carries the distinction, so nothing is lost — but
   anything that reads `action` alone is reading a lie.

---

## Live coverage: AT-M15.4, AT-M16.3

`vitest.sandbox.config.ts` and `test/filer.sandbox.test.ts` / `test/strategist.sandbox.test.ts` are **excluded
from `pnpm test`** by the shared base config. Run them with:

```bash
cd packages/defender && npx vitest run --config vitest.sandbox.config.ts
```

They need real credentials (`docs/HUMAN_TODO.md` **H-01**) and a sandbox dispute id. Without them every test
**skips with the reason in its own name**, so a green run against no sandbox can never be mistaken for a green run
against one. They cover the four things a `fetchImpl` double cannot:

1. whether PayPal **accepts the multipart body** (§10.2 #14) — our reader proves we build it, not that the server
   parses it;
2. what PayPal does with a **repeated `PayPal-Request-Id`** — EC-DSP-10's claim is "one call"; offline we can only
   assert that _we_ made one;
3. whether an offer is **recorded at the amount we sent** (EC-FX-4);
4. whether a packet over 10 MB is refused **by the server** and not only by our local copy of its limit
   (EC-DSP-12).

**There is no `test:sandbox` script in `package.json`** — that file is not in this work package's owned set. The
command above is the whole thing; adding `"test:sandbox": "vitest run --config vitest.sandbox.config.ts"` is a
one-line follow-up.

---

## What `index.ts` does not re-export

`src/index.ts` is not in this work package's owned set, so the four new modules are **not** re-exported from the
package barrel. WP-17e and WP-20 need these lines:

```ts
export { fileDispute, narrowPlanToPermit, uploadPermitFor, withCheckedNotes } from './filer'
export { buildDisputeContext, ingestDisputeToDefender, joinDisputeToOrder } from './ingest'
export { proposeStrategy, proposeStrategyDeterministic } from './strategist'
export { executeStrategy } from './strategist-actions'
```

Full surfaces are in each file's header; the tests import from `'../src/<module>'` rather than from the barrel for
exactly this reason.

---

## Contract gaps

| Gap                                      | Effect                                                                                                                                                      | Who fixes it                  |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `devices` has no `lost_at`               | `deviceLostAtSec` comes from `audit_log`, or R-UNAUTH-2 cannot fire                                                                                         | WP-16a schema                 |
| `refunds` has no `completed_at`          | `RefundFacts.atSec` is `created_at`, not the completion instant                                                                                             | WP-16a schema                 |
| `dispute_actions.action` has no `REFUND` | a refund records as `ACCEPT`; the real disposition is in `response`                                                                                         | WP-01 (`packages/core` types) |
| `EvidenceCorpus` has no repository       | a caller that cannot answer must return `{}`                                                                                                                | WP-17a                        |
| `§8.8`'s `preferences` are unsigned      | R-SNAD-AGENT needs a _second_ witness, which needs `DisputedItem.attributes` — and PayPal does not send them, so **the rule is unreachable from real data** | spec / PayPal                 |
