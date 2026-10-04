# `@countersign/defender`

The Dispute Defender's two deterministic halves — spec **§8.15 (M15)** and **§8.16**, work packages
**WP-15a** (the liability router) and **WP-15b** (the evidence planner). Edge cases **EC-DSP-1…12**,
**EC-MER-1…4**, **EC-BUY-1**, **EC-AGT-2**, **EC-REF-5**.

```bash
pnpm --filter @countersign/defender typecheck
pnpm --filter @countersign/defender lint
pnpm --filter @countersign/defender test     # 294 tests, no database, no network, no credentials
pnpm --filter @countersign/defender eval     # AT-M15.1: 40/40 exact, evidence 40/40
```

---

## What this package is

```ts
const decision = route(context) // WP-15a — PURE. No LLM, no clock, no I/O.
const plan = planEvidence(context, decision) // WP-15b — PURE. Proposes what to attach.
```

`route()` decides **whether to contest**. `planEvidence()` decides **what to attach if we are contesting**.
WP-15c's drafter writes the prose; WP-16's strategist proposes the next action. Only those two may use a
model, and neither can change a posture.

### The claim this package has to make honestly

Spec **§18 question 20** asks what stops us filing a bogus dispute against a good customer. The answer is
the _absence of a model_ in the first function, not a prompt:

| Question                                 | Answered by                                                   | Where                        |
| ---------------------------------------- | ------------------------------------------------------------- | ---------------------------- |
| May we contest at all?                   | a 22-row rule table, first match wins                         | `route()`                    |
| Must we never contest without a mandate? | `R-NOCHAIN-1` and `R-CHAIN-BAD`, neither of which can contest | `rules.ts`                   |
| May we claim a document?                 | `evidenceSourceAvailable` — is the source actually there?     | `rules.ts`                   |
| Can we defend the sentence?              | deterministic notes over citable facts                        | `planner.ts`, `rationale.ts` |
| What does the human read?                | `rationale`, `reasons`, `facts` — composed, never generated   | `rationale.ts`               |

Two of those are enforced rather than asserted:

- **`CONTEST` implies fillable evidence.** A property test over 2,000 generated contexts — not over the 40
  cases — asserts that `posture === 'CONTEST'` implies a non-empty `evidenceRequired` whose every member is
  a real PayPal `evidence_type`. `test/eval.test.ts`.
- **No unverified chain ever files.** The same property asserts that a context whose chain does not verify
  can never reach `CONTEST` or `APPEAL`, whatever the reason and whatever the merchant configured.

### Why it is pure

No model, no clock, no database, no network, no `Date.now()`, no randomness. `nowSec` arrives in the context
as **data**. Three consequences, all of them the point:

1. The 40-case eval measures the table rather than a model's mood, and needs no key (`docs/HUMAN_TODO.md`
   H-02 is open).
2. "Re-run the router after gathering a document" is a safe operation, and gives a different answer.
3. A test can assert a rationale **verbatim**, because the same input produces the same bytes.

`test/rules.test.ts` reads this package's own source and fails if `Date.now()`, a model import, or
`@countersign/db/client` appears in `src/`.

---

## The rules table

Twenty-two rules: **fourteen from spec §8.15 verbatim**, eight documented extensions. Evaluation order is
`RULE_ORDER` in `rules.ts`, which is the order below — first match wins.

| #   | Rule              | One-line condition                                                                                         | Liability          | Posture                                                        | Evidence                                              |
| --- | ----------------- | ---------------------------------------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------- | ----------------------------------------------------- |
| 1   | `R-REF-1`         | Σ **completed** refunds on the capture ≥ disputed amount                                                   | `ALREADY_REFUNDED` | `ACCEPT_CLAIM`                                                 | `PROOF_OF_REFUND`                                     |
| 2   | `R-APPEAL-1`      | we lost **and** PayPal offers the `appeal` link **and** new evidence arrived **and** the capture is mapped | `USER_AUTHORISED`  | `APPEAL`                                                       | `DETAILS_OF_PURCHASE`, `PROOF_OF_FULFILLMENT`         |
| 3   | `R-CHAIN-BAD`     | `verifyAtCapture.chain_valid=false` and a re-verification did not recover it                               | `UNPROVABLE`       | `ACCEPT_CLAIM`                                                 | —                                                     |
| 4   | `R-NOCHAIN-1`     | no order, no capture, no mandate, or a chain nobody ever verified                                          | `UNPROVABLE`       | `REVIEW` (default) / `ACCEPT_CLAIM` under the merchant's limit | —                                                     |
| 5   | `R-INR-1`         | not received, and no shipment carries tracking for the disputed line                                       | `MERCHANT_FAULT`   | `REFUND`                                                       | —                                                     |
| 6   | `R-INR-3`         | not received, tracking registered with PayPal and the parcel still moving                                  | `USER_AUTHORISED`  | `MESSAGE_ONLY`                                                 | —                                                     |
| 7   | `R-INR-2`         | not received, with tracking for the disputed line                                                          | `USER_AUTHORISED`  | `CONTEST`                                                      | `PROOF_OF_FULFILLMENT`, `ONLINE_TRACKING_INFORMATION` |
| 8   | `R-SNAD-AGENT`    | SNAD, shipment = checkout, and a **read-back-silent** attribute conflict                                   | `AGENT_FAULT`      | `REFUND`                                                       | —                                                     |
| 9   | `R-SNAD-MERCH`    | SNAD and the shipment lines ≠ the merchant-signed checkout lines                                           | `MERCHANT_FAULT`   | `REFUND`                                                       | —                                                     |
| 10  | `R-SNAD-THIN`     | SNAD, shipment = checkout, mandate permits it, **no quality document**                                     | `USER_AUTHORISED`  | `OFFER`                                                        | —                                                     |
| 11  | `R-SNAD-OK`       | SNAD, shipment = checkout, mandate permits it, quality document on file                                    | `USER_AUTHORISED`  | `CONTEST`                                                      | `ITEM_DESCRIPTION`, `ORDER_DETAILS`                   |
| 12  | `R-UNAUTH-2`      | unauthorised, chain valid, device reported LOST **before** the mandate `iat`                               | `UNPROVABLE`       | `ACCEPT_CLAIM`                                                 | —                                                     |
| 13  | `R-UNAUTH-3`      | unauthorised, chain valid, **no** passkey user-verification at signing                                     | `UNPROVABLE`       | `REVIEW` (default) / `ACCEPT_CLAIM` under the weak-case limit  | —                                                     |
| 14  | `R-UNAUTH-1`      | unauthorised, chain valid, device key **and** passkey at signing                                           | `USER_AUTHORISED`  | `CONTEST`                                                      | `DETAILS_OF_PURCHASE`, `ORDER_DETAILS`                |
| 15  | `R-AMT-1`         | incorrect amount or duplicate transaction, captures total = order, one capture per shipment                | `USER_AUTHORISED`  | `CONTEST`                                                      | `PROOF_OF_RECEIPT_COPY`                               |
| 16  | `R-AMT-2`         | two captures on one shipment                                                                               | `MERCHANT_FAULT`   | `REFUND`                                                       | —                                                     |
| 17  | `R-CNP-1`         | credit not processed and a completed refund exists                                                         | `ALREADY_REFUNDED` | `ACCEPT_CLAIM`                                                 | `PROOF_OF_REFUND`                                     |
| 18  | `R-OTHER-REFUND`  | one of PayPal's four reasons §8.15 never assigns, on a verified chain                                      | `MERCHANT_FAULT`   | `REFUND`                                                       | —                                                     |
| 19  | `R-DEADLINE-1`    | a filing posture, inside 48 h, and the evidence is not in hand                                             | (unchanged)        | `REFUND`                                                       | —                                                     |
| 20  | `R-NO-EVIDENCE`   | a filing posture whose required evidence has no source                                                     | (unchanged)        | `REFUND` under the limit, else `REVIEW`                        | —                                                     |
| 21  | `R-STAGE-INQUIRY` | a filing posture, at `INQUIRY`, and PayPal has not asked for a response                                    | (unchanged)        | `MESSAGE_ONLY`                                                 | —                                                     |
| 22  | `R-DEFAULT`       | nothing matched                                                                                            | `UNPROVABLE`       | `REVIEW`                                                       | —                                                     |

`RULE_ORIGIN` records which rows are the spec's and which are this package's, and the packet prints it.

### The eight extensions, and why each exists

| Extension         | Why                                                                                                                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `R-APPEAL-1`      | EC-DSP-6 needs a rule. §8.15 has no appeal row, but §8.16's strategist can only appeal if the router says the case is appealable. Gated on `isAppealable()` — the HATEOAS link, not `dispute_state`. |
| `R-INR-3`         | A parcel in transit is not a delivery dispute yet. Filing spends one of the merchant's response attempts; a message costs nothing.                                                                   |
| `R-SNAD-THIN`     | EC-BUY-1: offer a return instead of fighting, because fighting costs ~$82 [V13]. A shipping photo is not proof the item was good.                                                                    |
| `R-UNAUTH-3`      | EC-BUY-3's weak `UNAUTHORISED` case (chain valid, no passkey) has **no row in §8.15 at all**, so it would fall to `R-DEFAULT` and sit in review forever.                                             |
| `R-OTHER-REFUND`  | PayPal has four reasons §8.15 never assigns. See below.                                                                                                                                              |
| `R-DEADLINE-1`    | EC-DSP-7's downgrade needs an id of its own. See "One rule id, one posture".                                                                                                                         |
| `R-NO-EVIDENCE`   | Without it, `CONTEST` with an unfillable evidence list is reachable — a filing PayPal rejects, which costs a response and can escalate the dispute.                                                  |
| `R-STAGE-INQUIRY` | EC-DSP-3: no filing until `status = WAITING_FOR_SELLER_RESPONSE`. See below.                                                                                                                         |

### Three orderings that differ from the spec's table, and what each one changes

The spec lists its rows in an order that cannot work. Each fix changes a real dispute's answer, so each is
pinned by an end-to-end test in `test/router.test.ts`:

1. **`R-CHAIN-BAD` before `R-NOCHAIN-1`.** Both are "we have no proof", and only one of them is honestly
   sayable. Telling a merchant "no mandate on this payment" when a mandate exists and merely failed to
   verify would be false. Both are handled in one branch (`decideNoProof`) for exactly that reason.
2. **`R-UNAUTH-2` and `R-UNAUTH-3` before `R-UNAUTH-1`.** R-UNAUTH-1's stated condition — "a valid chain
   with device and webauthn at signing" — is **also true when the device was stolen and the attacker used
   the passkey**. §18 question 8 and EC-BUY-3 require the lost device to win, so in the spec's row order
   R-UNAUTH-2 could never fire.
3. **The three adjustments after the fact.** `R-STAGE-INQUIRY`, `R-DEADLINE-1` and `R-NO-EVIDENCE` adjust a
   chosen posture rather than competing for one, so they cannot be table rows. `selectRule` skips them
   explicitly and says why.

### The three adjustments, and the order they run in

All three can only **subtract** authority to file, never add it. The order is by how basic each fact is:

| #   | Adjustment        | Fact                                                  | Posture                                 |
| --- | ----------------- | ----------------------------------------------------- | --------------------------------------- |
| 1   | `R-STAGE-INQUIRY` | no filing window is open                              | `MESSAGE_ONLY`                          |
| 2   | `R-DEADLINE-1`    | the window is closing and the evidence is not in hand | `REFUND`                                |
| 3   | `R-NO-EVIDENCE`   | the evidence does not exist at all                    | `REFUND` under the limit, else `REVIEW` |

`R-STAGE-INQUIRY` matters most of the three and is the one that would be easiest to leave out: an `INQUIRY`
dispute usually carries **no `seller_response_due_date` at all**, so `R-DEADLINE-1` cannot catch a premature
filing — the deadline half of the guard simply does not exist yet. The stage does, and it outranks the reason:
a fully evidenced `MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED` contest is still not filed while PayPal has not
asked for a response. EC-DSP-3 says this, and the underlying rule is preserved in `supersedes` so a merchant
reading it sees the reasoning is staged rather than evasive.

`R-AMT-1` before `R-AMT-2` is the spec's order and is safe **only** because R-AMT-1's "a single capture per
shipment" conjunct excludes the duplicate case; `test/rules.test.ts` asserts that exclusion.

### One rule id, one posture

A deadline-driven downgrade gets `R-DEADLINE-1`, an evidence-driven downgrade gets `R-NO-EVIDENCE`, and a
premature-stage downgrade gets `R-STAGE-INQUIRY`, with the replaced rule in `decision.supersedes` and quoted
in the rationale. They could have borrowed the rule they replaced, but then the packet would show `R-INR-2`
next to a `REFUND` — **a rule id that does not explain the posture beside it**, which is the failure a judge
reads the packet to check for.

### Aliases, for names the spec and the brief use differently

`RULE_ALIASES` resolves read-only; the decision always reports the canonical id.

| Alias                                      | Canonical                                                               |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| `R-SNAD-CUST` (the customer's own misuse)  | `R-SNAD-OK`, and `R-SNAD-THIN` when the quality proof is thin           |
| `R-DLNG`, `R-UNREC` (delivery, unreceived) | `R-INR-1`, `R-INR-2`, `R-INR-3` — PayPal has one reason for all three   |
| `R-QUAL` (quality not as described)        | the four `R-SNAD-*` rules                                               |
| `R-OTHER` (anything else)                  | `R-OTHER-REFUND` for PayPal's four unassigned reasons, else `R-DEFAULT` |

---

## The three decisions that took actual thought

### `R-SNAD-AGENT`'s higher bar, implemented

**The bar.** Contesting an _agent_ purchase needs two witnesses where contesting a human purchase needs one.
For a human purchase, a valid chain plus an item matching the signed checkout settles it: the buyer pressed
the button. For an agent purchase the chain proves something weaker — the agent stayed inside a signed
envelope (within budget, at an allowed merchant, on a mandate the device key signed). That is _authority to
spend_, not _instruction about what to buy_. The user delegated a judgement, and the chain says nothing
about the variant they judged on.

**Why the second witness is the signed read-back.** §8.8's `preferences` are **not signed** — the compiler's
own read-back says so in as many words ("These are not signed and do not bound what the agent may buy"). An
unsigned preference cannot be the sole basis for blaming a buyer, because the buyer could have been told
anything about it. So `attributeConflicts` requires **both**:

1. the user's stated preference and the shipped attribute disagree, **and**
2. the **signed read-back does not already show the shipped variant.**

If the read-back said "size 10" and size 10 arrived, the user saw it and approved it, and the preference
saying "9" is a compiler inference we will not act on. That case falls through to `R-SNAD-OK`, which
contests — correctly, because a valid chain plus a read-back showing the variant is exactly the proof a
contest needs.

**The signature is in the L2/L3, as the brief says.** Concretely: `agentAuthorityExceeded` requires
`mandatePresent` **and** `chainVerifiedNow`, which is the verified L1 → L2 → L3 chain, with the L3 signed by
the key bound in the L2's `cnf`. Without a verified chain the rule cannot fire at all — we do not blame an
agent for a failure we cannot prove happened.

**`preferences` is router-only input.** It is a `DisputeContext` field, never looked for in the chain, and
never a VI constraint. EC-AGT-2's corpus reaches the rule only through `EvidenceCorpus`, which says what
documents exist.

**The label read-back.** `readbackAttribute` parses `**size** "9"` out of the signed string using
`READBACK_LABELS`. That is a deliberate coupling to `packages/compiler/src/readback.ts`'s
`PREFERENCE_LABELS`, and its failure direction is chosen: if a label is renamed the parse returns
`undefined`, which makes the conflict **survive** — no, which makes the _shipped variant unverifiable from
the read-back_, so the rule still fires. `test/rules.test.ts` pins the labels so the drift is a test
failure rather than a silent behaviour change.

### `R-NO-EVIDENCE`'s choice of downgrade

**Which rule loses authority to file.** `evidenceSourceAvailable(type, ctx)` answers honestly per type:

| Type                                | Available when                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| `PROOF_OF_REFUND`                   | a `COMPLETED` refund exists — its id and date go in `evidence_info.refund_ids`                    |
| `ONLINE_TRACKING_INFORMATION`       | a shipment has a non-blank tracking number                                                        |
| `PROOF_OF_FULFILLMENT`              | a carrier document exists, **or** the tracker is registered with PayPal so PayPal holds the scans |
| `DETAILS_OF_PURCHASE`               | the chain verifies — the signed bundle is what this type _is_                                     |
| `ORDER_DETAILS`, `ITEM_DESCRIPTION` | the merchant-signed checkout lines exist                                                          |
| `PROOF_OF_RECEIPT_COPY`             | the buyer's receipt copy exists. **We will not synthesise a copy of a receipt we never gave.**    |
| `PROOF_OF_RETURN`, `OTHER`          | always — both are ours to write                                                                   |

The `PROOF_OF_FULFILLMENT` row is **EC-MER-4 made operational**. A tracking number a merchant typed into
their own dashboard is an assertion; a tracker PayPal holds, or a carrier document, is a record. When we
have only the assertion, a packet would be claiming something we cannot show.

**Which way it falls.**

- **At or below `policy.autoAcceptThresholdMinor` → `REFUND`.** Small by the merchant's own stated policy,
  nobody is woken up, and that is the entire cost of the mistake.
- **Above it → `REVIEW` with a `blockingReason`.** "File a packet we cannot fill, or absorb the loss?" is a
  money decision with no honest default, so it belongs to a person.

`blockingReason` is set **only** on `REVIEW`, and **never for a deadline** — EC-DSP-8 is a
`DEF_DEADLINE_PASSED` raised by the filer. A timeout is a fact about the clock, and rendering it as
"waiting on a person" would make the UI claim a human is needed for a case no human can unblock. The
`PASSED` state still rides on `decision.deadline` so the UI can show the two facts separately, and a test
asserts no `blockingReason` **text** mentions the clock.

**The guard only ever subtracts.** `applyEvidenceGuard` can remove authority to file; it cannot turn a
refund into a contest. Pinned by a test.

### `R-DEADLINE-1`'s 48 hours, and why it is not 24

EC-DSP-7 alerts at 24 h and refuses auto-file inside 1 h. Those are the spec's numbers and this package
keeps both: `deadlineState` returns `PRESSURE` at 48 h, `CRITICAL` at 1 h, `PASSED` after. The **downgrade**
uses the same 48 hours deliberately: _we cannot file what we do not have, and there is less than two days in
which to get it._ A merchant who wants to contest anyway gathers the document and re-runs `route()`, which
is free and gives a different answer — the rationale says exactly that, because a merchant reading "we
settled because of the clock" deserves to know the clock was not the real constraint.

---

## The rationale strings

Every rationale is composed in `rationale.ts` — no model, ever — and always ends with its rule id in
brackets, so the packet's `rule` field and its prose cannot disagree. Each is snapshot-tested verbatim in
`test/router.test.ts`. Rendered for the fixtures in that file:

| Rule                         | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `R-NOCHAIN-1` (REVIEW)       | No mandate on this payment. Countersign can't help here. PayPal raised a not received claim for $89.00. There is no Countersign order, mandate or signed chain attached to this capture, so there is nothing to file and no argument we could make. Settling it or writing it off is a money decision, and an unconfigured merchant has not delegated that to us, so a person decides. [R-NOCHAIN-1]                                                                                                                                                                                                                                                                                                 |
| `R-NOCHAIN-1` (ACCEPT_CLAIM) | No mandate on this payment. Countersign can't help here. PayPal raised a not received claim for $9.00. At $9.00 it is at or under the auto-accept limit this merchant set, so we settle it ourselves instead of filing something we cannot support. [R-NOCHAIN-1]                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `R-CHAIN-BAD`                | There is a mandate on this payment and its chain does not verify. It failed with: l2_expired. Every argument we could make would rest on that chain, so a packet built on it would collapse on inspection. We do not contest with a broken chain — we accept the claim. [R-CHAIN-BAD]                                                                                                                                                                                                                                                                                                                                                                                                                |
| `R-INR-1`                    | The buyer says SKU-TRAIL-42 never arrived, and no shipment carries tracking for that line. There is no delivery record to file, so there is no case to make: the parcel was ours and it is not accounted for. Refund. [R-INR-1]                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `R-INR-2`                    | Tracking exists for the disputed line: BlueDart BD1 and PayPal's tracker says DELIVERED. The parcel left the warehouse, which is the fact the buyer is disputing, and it is ours to prove. [R-INR-2]                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `R-INR-3`                    | Tracking (BlueDart BD1) is registered with PayPal and the parcel is still moving. Nothing has gone wrong yet and the cheapest thing that can still be true is that it arrives, so we write to the buyer instead of spending one of our response attempts on a parcel that has not landed. [R-INR-3]                                                                                                                                                                                                                                                                                                                                                                                                  |
| `R-SNAD-AGENT`               | Our own agent made this purchase. The user asked for size 10; size 9 is what arrived. The read-back the user approved does not mention this variant at all. The chain is valid, so the agent stayed inside the budget and the merchant list the user signed — it read the request wrong. Blaming the buyer for a software misreading is not something we will file, so we refund. [R-SNAD-AGENT]                                                                                                                                                                                                                                                                                                     |
| `R-SNAD-MERCH`               | What shipped is not what the merchant signed at checkout. We sent [SKU-COTTAGE-3:1] and the signed order says [SKU-TRAIL-42:1]. Our own evidence would be evidence against our own customer, so we refund rather than file it. [R-SNAD-MERCH]                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `R-SNAD-THIN`                | The item matches the signed checkout and the user's own mandate permits it, so the purchase was authorised. What we do not have is anything that shows the goods were as described — the only photographs we hold are of a packed box, and a photograph of a box is not evidence about what was in it. Contesting on that would spend a response on a packet with nothing in it. A refund in exchange for the item settles the same money with none of the handling cost. [R-SNAD-THIN]                                                                                                                                                                                                              |
| `R-SNAD-OK`                  | What arrived is exactly what the merchant signed at checkout, and the signed mandate permits it. The buyer is right that the goods differ from what they expected; the signed read-back says nothing was promised about that, and the item description and the order are both on file. That is a case we can actually argue. [R-SNAD-OK]                                                                                                                                                                                                                                                                                                                                                             |
| `R-UNAUTH-1`                 | This mandate was signed by the user's own device key with a passkey user-verification at Mon 21 Sep, 7:43 PM IST, and the L3 that authorised this purchase was signed by the agent key bound inside that same mandate. The spend was inside the budget, at an allowed merchant, inside the expiry. A valid chain and a passkey is an authorised purchase, and the packet carries the whole chain so anyone can re-verify it. [R-UNAUTH-1]                                                                                                                                                                                                                                                            |
| `R-UNAUTH-2`                 | The device that signed this mandate was already reported lost — on Fri 19 Sep, 7:33 PM IST — and the mandate was signed at Sun 20 Sep, 7:43 PM IST, after that. A key on a lost device still verifies, and that is all the chain can prove here. We cannot show the person who signed was the account holder, so we accept. [R-UNAUTH-2]                                                                                                                                                                                                                                                                                                                                                             |
| `R-UNAUTH-3`                 | The chain verifies, so this came through Countersign — but no passkey user-verification was recorded when the mandate was signed, so we cannot show that a person authorised it rather than something holding the device key. At $42,000 there is no configured limit below which we may settle this, so the decision to absorb it or to fight a case without a passkey is a person's. [R-UNAUTH-3]                                                                                                                                                                                                                                                                                                  |
| `R-AMT-1`                    | The captures on this order total $89.00, which is exactly what the signed checkout authorised (order INV-1), and there is one capture per shipment — no duplicate. The amount is right and the receipt shows it. [R-AMT-1]                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `R-AMT-2`                    | We captured this order more than once for the same shipment (shp_1), at $89.00 each time. We took the money twice for one delivery. That is a correction, not a defence: refund the duplicate. [R-AMT-2]                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `R-REF-1`                    | We already refunded $89.00 on Thu 17 Sep, 5:00 AM IST, and this claim is for $89.00 of the same payment. That is one refund being claimed twice, not a second loss, so the refund receipt is the answer and there is nothing to contest. [R-REF-1]                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `R-CNP-1`                    | The buyer says a credit never arrived. We refunded $20.00 on Wed 16 Sep, 11:20 AM IST, with a PayPal refund id, and that id is the proof. This is a receipt question, not a dispute about the purchase. [R-CNP-1]                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `R-OTHER-REFUND`             | The buyer is claiming a paid by other means claim on a payment whose chain verifies and whose capture matches the order, so there is no signed fact that answers it. Refunding costs $89.00 once. Contesting a case with no evidence behind it costs the same money plus the ~$82 handling cost of a lost first-party dispute [V13], escalates the case, and teaches merchants that this packet argues everything — which is how a packet stops being believed when it matters. This rule is one line to change if a merchant disagrees. [R-OTHER-REFUND]                                                                                                                                            |
| `R-DEFAULT`                  | Nothing in the signed record answers a "A_BRAND_NEW_REASON" claim. no order is linked to this capture; a mandate is linked; no completed refund on the capture. The router will not guess at a case it cannot support, so this one goes to a person with the evidence plan attached. [R-DEFAULT]                                                                                                                                                                                                                                                                                                                                                                                                     |
| `R-NO-EVIDENCE`              | The captures on this order total $89.00, which is exactly what the signed checkout authorised (order INV-1), and there is one capture per shipment — no duplicate. The amount is right and the receipt shows it. But the evidence that case needs does not exist. Filing anyway would spend one of our responses on a packet PayPal would reject or ignore, and a rejected response can move the dispute up a stage. Without the missing evidence this would have been R-AMT-1. At $89.00 there is no configured limit below which we may settle this, so whether to absorb it or file an empty packet is a person's decision. [R-NO-EVIDENCE]                                                       |
| `R-DEADLINE-1`               | The captures on this order total $89.00, which is exactly what the signed checkout authorised (order INV-1), and there is one capture per shipment — no duplicate. The amount is right and the receipt shows it. PayPal's response deadline is 1d 16h, and the evidence that case needs is not in hand: we cannot file what we do not have, so we settle rather than lose on a packet that never got sent. Without the clock this would have been R-AMT-1. Gather the document and re-run the analysis — the decision is deterministic, so a second run with the document attached gives a different answer. [R-DEADLINE-1]                                                                          |
| `R-STAGE-INQUIRY`            | What arrived is exactly what the merchant signed at checkout, and the signed mandate permits it. The buyer is right that the goods differ from what they expected; the signed read-back says nothing was promised about that, and the item description and the order are both on file. That is a case we can actually argue. But this is still an inquiry: PayPal has not asked us for a response, so no filing window is open and there is usually no deadline to miss. Writing to the buyer costs nothing, and a packet filed now would spend one of our responses on a claim that may still be withdrawn. The moment PayPal asks for a response the analysis re-runs and files. [R-STAGE-INQUIRY] |
| `R-APPEAL-1`                 | We lost this case and PayPal is still offering an appeal, and something material arrived since the decision — a carrier response or a tracking update that landed late. The appeal carries the original signed packet plus the new fact. Without that new fact the appeal would only repeat a packet that already lost. [R-APPEAL-1]                                                                                                                                                                                                                                                                                                                                                                 |

### The deadline clauses

Appended to the base sentence for every state except `COMFORTABLE` and `UNKNOWN`:

| State      | Clause                                                                                                                                                               |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PASSED`   | PayPal's response deadline has already passed, so nothing can be filed for this dispute now.                                                                         |
| `CRITICAL` | PayPal's response deadline is **{countdown}** away, inside the hour where we refuse to upload automatically: a packet that only half uploads has spent the response. |
| `PRESSURE` | PayPal's response deadline is **{countdown}** away, so there is no room for evidence we have not gathered yet.                                                       |

`R-DEADLINE-1` suppresses the `PRESSURE` clause, because its own sentence already names the countdown —
the downgrade _is_ the clock, and saying it twice reads as a stutter.

---

## The evidence planner (WP-15b)

```ts
const plan = planEvidence(ctx, route(ctx))
plan.items // PayPal `evidences[]`, with `evidence_info`, `notes` and documents per item
plan.shipmentShares // EC-REF-5: the disputed amount split across the shipment lines
plan.warnings // anything unsatisfiable, oversized or empty — never thrown
toProvideEvidenceInput(plan) // the exact body PayPalClient.provideEvidence takes
```

**`notes` is a string of at most 2000 characters** (spec D-012 corrected `string[]`; `@countersign/paypal`'s
`provideEvidenceInputSchema` enforces `min(1).max(2000)`). Every note names its rule **exactly once**, in a
prefix applied by the caller, so a rule id cannot appear twice or not at all. `clampNotes` drops whole
trailing sentences rather than truncating mid-claim — a note ending in a fragment is still a sentence; one
ending mid-claim is not, and it would be quoted back to us.

**Every `evidence_type` comes from `@countersign/paypal`'s corrected enum.** The first pass of this project
listed seven values PayPal does not have (`CHECKOUT_PAGE`, `REFUND_POLICY`, `TERMS_OF_SERVICE`, …), and every
one would have failed live. `test/planner.test.ts` asserts membership for both tables _and_ asserts the seven
removed names are absent.

**EC-DSP-12: nothing this file proposes could be rejected before the bytes move.** Every limit is imported
from `@countersign/paypal` rather than restated, so the check cannot drift from the one guarding the upload.
The strongest assertion needs no sandbox: the test builds the payload and hands it to that package's own zod
schema, `provideEvidenceInputSchema`.

**EC-REF-5: the rounding remainder comes out of the shipment lines.** `shipmentShares` allocates the
disputed amount across the shipment lines by line quantity with `allocateWithRemainderLast` — the spec's
largest-remainder rule with the **exact remainder on the last line** — so the parts always sum to the
disputed amount and nothing is invented or lost. It never allocates against the order total, which already
reconciles against the captures (R-AMT-1 checks that) and would either gain or lose minor units.

---

## The 40-case eval — AT-M15.1

```bash
pnpm --filter @countersign/defender eval
# the router decides the labelled cases > AT-M15.1 scores 40/40 exact (100.0%), evidence 40/40
```

**Scored on exact match of `ruleId` and `posture`.** `evidenceTypes` is checked too and reported separately,
because the planner is a different module and a mismatch there is a different bug.

Coverage, all asserted by `test/eval.test.ts`:

| Property                           | Result                              |
| ---------------------------------- | ----------------------------------- |
| cases                              | 40, ids unique                      |
| every rule in `RULE_ORDER` covered | 22/22                               |
| `R-NOCHAIN-1` both directions      | `REVIEW` + `ACCEPT_CLAIM`           |
| `R-NO-EVIDENCE` both directions    | `REFUND` + `REVIEW`                 |
| deadline-forced downgrades         | 3, over 2 distinct superseded rules |
| scoring disagreements              | **0 / 40**                          |
| evidence-type disagreements        | **0 / 40**                          |

### Why 100% is the honest bar and what would make it dishonest

There is no model in the loop, the router is a pure function of a literal context, and the cases are
hand-written to enumerate its branches. A score below 100% therefore means either the table has a hole or a
label is wrong — both worth more than a green tick.

**Nothing in `eval/router-cases.ts` writes to `router-cases.jsonl`.** A case that had to be relabelled
carries a `_note` saying **why the first label was wrong**, which is the half of a correction a reviewer
needs and the half that is easy to leave out. Four labels were corrected during development, all of them
the case's fault rather than the table's, and all four notes are in the file:

- `r-appeal-1-not-lost-so-no-appeal` — tracking had never been registered with PayPal and no carrier
  document existed, so `PROOF_OF_FULFILLMENT` had no source and `R-NO-EVIDENCE` correctly removed the
  contest. The tracker is now registered.
- `r-cnp-1-credit-not-processed` — a refund equal to the claim is `R-REF-1` (EC-DSP-1), evaluated first by
  design. `R-CNP-1` is reached on a **partial** refund, which is what the spec row describes.
- `r-default-01-no-rule-matched` — the case omitted the order, making it `R-NOCHAIN-1` (EC-DSP-9) rather
  than `R-DEFAULT`.
- `r-default-02-merchant-not-in-chain` — a 100,000-minor-unit auto-accept limit made accepting a 4,200 claim
  correct, so the `REVIEW` label was the wrong one.
- `r-appeal-1-not-lost-so-no-appeal` — **corrected twice.** First the data was wrong, as above. Then the
  label was wrong, because `R-STAGE-INQUIRY` was added while the case's stage was `INQUIRY` with status
  `OPEN`. The table changed, not the facts, and the case's stage is now `CHARGEBACK` /
  `WAITING_FOR_SELLER_RESPONSE` so it tests what it was written to test: the appeal rule requires
  `previouslyLost`.

The `_note` field is not decoration. A relabelled case that does not say **why the first label was wrong** is
the case most likely to be relabelled again for the wrong reason.

---

## The tests

294 tests, in four files:

| File                        | What it holds the package to                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `test/rules.test.ts` (129)  | each predicate fires on its own condition and stays quiet on its neighbours'; the structural checks that keep the table from rotting |
| `test/router.test.ts` (80)  | every rationale **verbatim**; both directions of both adjustments; the three ordering fixes end to end; purity                       |
| `test/planner.test.ts` (61) | EC-DSP-12, `notes` as a bounded string, EC-REF-5's allocation, the payload against PayPal's own schema                               |
| `test/eval.test.ts` (24)    | the 40-case set's integrity, its coverage, the score, and the **property tests** over generated contexts                             |

### Edge cases closed

Every test name carries the EC id it closes, so `pnpm test:ec` counts them.

| EC                                     | Where                                                                                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| EC-DSP-1 chargeback after refund       | `R-REF-1` predicates, rationale, eval cases                                                                                                                              |
| EC-DSP-2 partial refund, full claim    | `R-REF-1` "does not fire on a partial refund"; `R-AMT-1` contesting the remainder                                                                                        |
| EC-DSP-3 inquiry stage                 | `R-STAGE-INQUIRY`: no filing until `WAITING_FOR_SELLER_RESPONSE`, and the underlying rule is kept in `supersedes`                                                        |
| EC-DSP-4 escalated to chargeback       | re-runs `route()` — pure, so a second run is the re-analysis; `R-APPEAL-1` on a lost case                                                                                |
| EC-DSP-5 pre-arbitration / arbitration | `R-APPEAL-1` refuses an appeal with no new evidence, which is what keeps packet versions from contradicting. The stage transitions themselves are `repos/disputes.ts`'s. |
| EC-DSP-6 appeal after a loss           | `R-APPEAL-1`, gated on the HATEOAS link                                                                                                                                  |
| EC-DSP-7 deadline about to pass        | `deadlineState` bands, `R-DEADLINE-1`, the `CRITICAL` clause                                                                                                             |
| EC-DSP-8 deadline missed               | `PASSED` state, `blockingReason` never set for it, three eval cases                                                                                                      |
| EC-DSP-9 unmappable dispute            | `R-NOCHAIN-1` produces a sentence, not a crash; `ruleSentence` covers a reason PayPal has not invented                                                                   |
| EC-DSP-10 two disputes, one capture    | `siblingCaptures` is per-order, so both disputes see the same captures                                                                                                   |
| EC-DSP-11 buyer cancels                | outside this package — `repos/disputes.ts` closes it `CLOSED_WON`                                                                                                        |
| EC-DSP-12 evidence upload fails        | `validateEvidencePlan` plus the payload against `provideEvidenceInputSchema`                                                                                             |
| EC-MER-1 fabricated mandate            | outside this package; the router sees only `verifyAtCaptureChainValid`, so a forged mandate fails as `R-CHAIN-BAD`                                                       |
| EC-MER-2 reused L3 / duplicate capture | `duplicateShipmentCaptures` → `R-AMT-2`                                                                                                                                  |
| EC-MER-3 shipped something different   | `R-SNAD-MERCH`, with the reason in its comment and its rationale                                                                                                         |
| EC-MER-4 faked tracking                | `evidenceSourceAvailable('PROOF_OF_FULFILLMENT')` needs a document or a PayPal-held tracker; the notes label tracking as merchant-asserted                               |
| EC-BUY-1 buyer remorse                 | `R-SNAD-OK` contests, `R-SNAD-THIN` offers `REFUND_WITH_RETURN`                                                                                                          |
| EC-AGT-2 compromised agent             | `agentAuthorityExceeded` requires a verified chain, which is what the L2-bound agent key proves                                                                          |
| EC-REF-5 rounding remainder            | `shipmentShares`, four tests                                                                                                                                             |

---

## Money, time and errors

- **Money is integer minor units, everywhere.** No float appears in `src/`, and
  `scripts/check-money-discipline.mjs` scans `packages/defender/src` (the root was already listed; nothing
  needed adding). The module's own proof is a test that greps the source for `parseFloat`, `parseInt(` and
  `.toFixed(`, and the shared scan is the one CI runs.
- **Time is UTC epoch seconds, injected.** `nowSec` is an argument. `deadlineState(nowSec, dueSec)` is a pure
  function of the two. `formatIstHuman` and `formatCountdown` come from `@countersign/core`; IST appears in a
  rationale exactly as §0 rule 10 intends.
- **Nothing throws across the module boundary.** `route` and `planEvidence` return a value, never a
  `Result`, because they cannot fail: an unmapped dispute produces a `REVIEW` decision (EC-DSP-9) rather
  than an error. The one throw in `route` is unreachable by construction — it fires only if `R-DEFAULT` is
  deleted from the table, where falling through to a contest would be the wrong failure — and it is better
  than a decision with no posture.

---

## Verify these before a judge does

The field names and enum in `@countersign/paypal` were re-checked against PayPal's published OpenAPI on
**2026-10-04**, and this package uses that corrected set. What follows is what is **not** settled.

1. **Whether the `evidence_type` → reason pairing is what PayPal's adjudicators expect.** The types are real
   PayPal values; which one moves which decision is a weight question PayPal does not publish. A sandbox
   `adjudicate SELLER_FAVOR` run (H-01) is the only thing that would say.
2. **Whether EC-DSP-3's `INQUIRY` rule is right, or merely defensible.** The spec says prefer
   `send-message`/`make-offer` and file only at `WAITING_FOR_SELLER_RESPONSE`, and that is what
   `R-STAGE-INQUIRY` implements — but §8.16 gives the _next action_ to a model (WP-16), and a `MESSAGE_ONLY`
   posture pre-empts that choice. It is the right default and it is one line to change.
3. **Whether `R-NO-EVIDENCE`'s availability table matches adjudication.** We require a PayPal-held tracker for
   `PROOF_OF_FULFILLMENT`. If PayPal accepts a merchant-asserted tracking number as fulfilment, we are
   refusing to contest some winnable cases. That direction costs the merchant money, so it is deliberately
   conservative — and it is one predicate.
4. **The read-back label coupling.** `READBACK_LABELS` mirrors `packages/compiler`'s `PREFERENCE_LABELS`. A
   rename there is caught by a test here, but the two files have to change together.
5. **`merchantPolicy` thresholds.** Nothing in the spec names them; `autoAcceptThresholdMinor` and
   `weakUnauthorisedThresholdMinor` are this package's shape for what §8.15 and EC-BUY-3 describe as a
   merchant setting. **Both default to zero**, so an unconfigured merchant is never auto-accepted.
6. **Every money comparison is exact but unexercised against a live dispute.** The arithmetic is
   `bigint` throughout and property-tested; no live dispute has been routed.

---

## Contract gaps found in other packages (reported, not fixed)

Per AGENTS.md rule 8, none of these was touched.

1. **`packages/db` `devices` has no `lost_at` column**, but spec §18 question 8 and `R-UNAUTH-2` need the
   _ordering_ of "device reported lost" against the mandate `iat`. `DisputeContext.chain.deviceLostAtSec` is
   read from the audit trail by WP-15e; a `devices.lost_at` column would make the lookup a single indexed read.
2. **No ESLint rule bans `ai` / `@ai-sdk/*` in `packages/defender`**, the way `GATE_LLM_BAN` does for
   `packages/gate` (D-018). The check lives in `test/rules.test.ts` instead, which catches it in CI but not
   in an editor. Adding `DEFENDER_LLM_BAN` to `eslint.config.mjs` would be one commit.
3. **`packages/paypal`'s `isAppealable` takes `Pick<Dispute, 'links' | 'dispute_state'>`.** `R-APPEAL-1` needs
   the answer as a boolean input and gets it through `DisputeContext.dispute.appealLinkPresent`; a caller
   passing the wrong thing would not be caught. Not a bug — the planner boundary is the right place for it.
4. **§8.15's `RouterInput` has `captures: CaptureRow[]`; this package has `capture` plus
   `siblingCaptures`.** One capture per shipment (D17) means a partially shipped order has several, and
   `R-AMT-2` cannot see a duplicate that is not in the array. Splitting it was the only way to detect a
   duplicate at all.
5. **`disputes.liability` is `null` until the router runs** (`packages/db`), which is right. But nothing yet
   validates that a stored `liability` matches the rule that produced it — worth a check when WP-15e writes
   it.
