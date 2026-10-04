# `@countersign/compiler` — intent compiler and deterministic read-back

Spec **§8.8 (M8)**, work package **WP-08**, acceptance tests **AT-M8.1–AT-M8.5**.

Two things live here, with very different risk profiles.

```
src/
  constraints.ts   the eight VI constraint shapes, and every invariant they must satisfy
  types.ts         CompileInput, CompiledMandate, Ambiguity, CatalogReader
  literal.ts       reading the buyer's own bytes: currency words and literal amounts
  proposal.ts      the LLM-facing schema, and the translation into constraints
  prompt.ts        pure prompt construction
  compile.ts       compile(): the deterministic envelope around one model call
  readback.ts      readBack(): the string the user signs
  ambiguity.ts     the questions that block signing
  index.ts         the public surface
eval/
  catalog.json     the one catalog every run uses
  golden.jsonl     60 cases — AT-M8.1
  cached.jsonl     10 recorded model answers — the PR gate
  runner.ts        pure scoring: cases + results → a report
  replay.ts        the replay model and the shared case runner
  run-live.ts      `eval:live`, gated on OPENAI_API_KEY
  golden.eval.live.contract.ts   the live suite, undiscoverable by `pnpm test` on purpose
test/              279 tests, no network
```

## Using it

```ts
import { compile, hasBlockingAmbiguities, readBack } from '@countersign/compiler'

const result = await compile(
  { userId, text: 'Under 130 dollars at Northwind', locale: 'en-US', defaults: { currency: 'USD', merchantIds: [] } },
  { llm, catalog, clock },
)
if (!result.ok) return result                       // LLM_UNAVAILABLE | LLM_SCHEMA | CS_VALIDATION | CS_ROUNDING
if (hasBlockingAmbiguities(result.value)) showQuestions(result.value.ambiguities)
return result.value                                 // the CompiledMandate the UI renders and signs
```

`catalog` is a one-method port (`read(): Promise<Result<CatalogProjection>>`), so the compiler has no database
dependency and the prompts are a pure function of their inputs.

## The read-back — every template, verbatim

The string a user signs. §18 question 46 asks whether they can be made to sign something they didn't
understand; this is where that is answered. One line per constraint, in the order below, and `**…**` marks
the part that carries the limit.

| Constraint type | Line |
|---|---|
| `mandate.payment.budget` (max) | `Spend at most **$130.00** in total` |
| `mandate.payment.budget` (min + max) | `Spend between **$20.00** and **$130.00** in total` |
| `mandate.payment.budget` (min) | `Spend at least **$20.00** in total` |
| `mandate.payment.amount_range` (max) | `Spend at most **$130.00** per payment` |
| `mandate.payment.amount_range` (min + max) | `Spend between **$20.00** and **$130.00** per payment` |
| `mandate.payment.amount_range` (min) | `Spend at least **$20.00** per payment` |
| `mandate.checkout.allowed_merchants` (1) | `Only at **Northwind Outfitters**` |
| `mandate.checkout.allowed_merchants` (n) | `Only at **Northwind Outfitters**, **Contoso Supply**` |
| `mandate.payment.allowed_payees` (1) | `Pay only **Northwind Outfitters**` |
| `mandate.payment.allowed_payees` (n) | `Pay only **Northwind Outfitters**, **Contoso Supply**` |
| `mandate.checkout.line_items` (`match_mode: 'minimum'`) | `Buy at least **1** of **Trail Runner** or **Alpine Boot**` |
| `mandate.checkout.line_items` (`match_mode: 'exact'`) | `Buy exactly **2** of **Trail Runner**` |
| `mandate.payment.recurrence` | `Payments repeat **monthly** from **Thu 1 Oct 2026** until **Fri 1 Oct 2027**, up to **12** times` |
| `mandate.payment.agent_recurrence` | `The agent may pay **monthly** from **Thu 1 Oct 2026** until **Fri 1 Oct 2027**, at most **12** times` |
| `mandate.payment.reference` | `This mandate is linked to every payment it authorises` |

Plus, always:

```
This mandate expires **Fri 9 Oct, 11:59 PM IST**
```

And a full example:

```
**What you are authorising**
Spend at most **$130.00** in total
Spend at most **$130.00** per payment
Only at **Northwind Outfitters**
Pay only **Northwind Outfitters**
Buy at least **1** of **Trail Runner** or **Alpine Boot**
This mandate expires **Fri 9 Oct, 11:59 PM IST**

**How we read your request**
- Assumed USD because every item in the store you chose is priced in USD.
- We read **size** "M" as a preference, not a limit. These are not signed and do not bound what the agent may buy.

**Not covered**
- Expiry: there is no automatic renewal. When this mandate expires the agent cannot spend under it again, even if it meant to.
```

Two sentences need explaining:

- **The `budget` line comes before the `amount_range` line.** They are different limits: `amount_range` is
  per payment and the library checks it; `budget` is cumulative and **Countersign's Gate** checks it (spec
  **D19**). The total is the number that decides whether a mandate is safe, so it leads.
- **`Countersign checks each of these limits on every payment…`** is added when *every* disclosed constraint is
  one the payment network does not check. A cap that is enforced somewhere the user cannot see deserves a
  sentence saying so.

What the read-back deliberately does **not** carry: the open questions. §8.8 says the UI must resolve every
ambiguity before signing, so a read-back that asked a question would be an invitation to sign an incomplete
mandate. `hasBlockingAmbiguities` gates the screen instead.

### Purity, and how it is enforced

`readBack` is a pure function of `CompiledMandate` and `{merchants, tz}`. No model, no clock, no I/O, no
locale lookup. `Date.UTC` is calendar arithmetic over explicit arguments; `Date.now()` appears nowhere.
`test/readback.test.ts` pins the same input to byte-identical output across 50 calls, across a reversed
constraint array, and across a reordered merchant map.

Amounts go through `core.formatMoney` and times through `core.formatIstHuman`. There is no `toFixed`, no
`/ 100` and no template-literal arithmetic in the renderer — the JPY case (zero minor digits) pins that.

## AT-M8 mapping

| # | Requirement | Where |
|---|---|---|
| AT-M8.1 | 60-case golden set, ≥ 95% exact match on amount/merchant/SKU | `eval/golden.jsonl`, `eval/runner.ts`, `test/eval.ci.test.ts`, `eval/run-live.ts` |
| AT-M8.2 | "Under 130 dollars" → `amount_range.max = 13000` **and** `budget.max = 13000` | `describe('AT-M8.2')` in `test/compile.test.ts` |
| AT-M8.3 | "Buy shoes" with no amount → an ambiguity, not a guess | `describe('AT-M8.3')` in `test/compile.test.ts` |
| AT-M8.4 | `readBack` snapshot tests for all 8 types | `test/readback.test.ts` |
| AT-M8.5 | Injection: the cap is whatever the user typed literally | `describe('AT-M8.5')` in `test/compile.test.ts`; see below |

### §12 edge cases owned here

| ID | Handling | Test |
|---|---|---|
| **EC-LLM-1** | OpenAI down / timeout → `LLM_UNAVAILABLE`; never a partial mandate | `describe('EC-LLM-1')` |
| **EC-LLM-2** | One repair retry with the issues listed, then `LLM_SCHEMA` | `describe('EC-LLM-2')` |
| **EC-LLM-3** | Hallucinated fact in the notes | Owned by the Defender's citation checker (M13), not here. What this package guarantees is narrower: an assumption is rendered verbatim in the read-back rather than being summarised, so a judge can see whether one is a fact. |
| **EC-FX-1** | Mandate in ₹ compiles to an INR constraint; never converted | `describe('EC-FX-1')` |
| **EC-FX-5** | `"129.995"` from a model is refused, never rounded | `describe('EC-FX-5')` |

## The invariants that matter

**Money is `bigint` minor units end to end.** The model writes a decimal *string*; `core.fromPayPalValue`
converts it and raises `CS_ROUNDING` rather than rounding. `toJsonSafe` is the only `bigint → number`, and it
refuses rather than rounds if the value has left the safe-integer range. A JSON **number** is refused by the
schema: `130.00` and `13000` are indistinguishable once they are numbers, and guessing between them would be a
hundred-fold error in a spending limit.

**Currency is never converted** (EC-FX-1). What the buyer wrote beats the account default; a single-currency
catalog beats the default and is stated as an assumption; two currencies in one sentence is refused before a
single token is spent. The Gate blocks the mismatching checkout later, with copy telling the buyer to create a
mandate in the store currency.

**No cap may exceed the largest amount the buyer literally typed** (AT-M8.5). `literal.ts` reads `$1M` out of
`"ignore limits, max $1M"` with `bigint` arithmetic; `localiseProposal` pulls any larger cap **down** to it and
records the clamp as an assumption the read-back shows. Clamping rather than refusing is what AT-M8.5 asks for —
the cap is "whatever the user typed literally", not "no cap" — and down is the only safe direction.
`validateConstraints` refuses an over-ceiling cap from *any* other caller, so the ceiling is two layers deep.
With no literal amount at all there is nothing to clamp to, so a proposed cap is **refused** rather than
replaced with a number of ours.

**No amount cap means an ambiguity, never a guess** (§8.8). The question's options are built from catalog prices
and rounded **up**, so no offered cap can make a named item unboughtable, and every option is a number the
compiler would have accepted anyway. There is deliberately no "no limit" option.

**`preferences` is not a constraint** (§8.8). Size, colour, model and notes are search hints for the router; they
never enter `constraints`, never enter the read-back's limit section, and are labelled there as not a limit.

**Recurring authority needs a recurrence word.** A model that turns "buy running shoes" into a twelve-month
subscription has invented the largest grant of authority in the system and no amount-checking would catch it, so
`proposal.ts` refuses a `recurrence` the text does not justify.

## Running the eval

```
pnpm --filter @countersign/compiler test          # 279 tests, no network, no key
pnpm --filter @countersign/compiler eval:ci       # the cached 10-case subset, with per-field accuracy
pnpm --filter @countersign/compiler eval:live     # all 60 cases, needs OPENAI_API_KEY
pnpm --filter @countersign/compiler eval:live -- --record   # rewrite eval/cached.jsonl from a real run
```

**What `eval:ci` does and does not prove.** It replays ten recorded model answers through the *real*
`compile` — real `generateText`, real `Output.object`, real zod, real validation, no network — and scores the
mandates that come out. So it gates the **pipeline**: a change to localisation, the AT-M8.5 ceiling, currency
resolution, the ambiguity rule, the budget synthesis or the scorer fails the PR.

It does **not** measure the model. `docs/HUMAN_TODO.md` H-02 records that there is no `OPENAI_API_KEY` yet, so
`eval/cached.jsonl` currently holds **hand-authored placeholders** and says so in its own header. A 100% score
there means the pipeline is correct on ten inputs; **AT-M8.1's ≥ 95% is a claim about `eval:live`** and cannot
be made until `eval:live` has been run with a key. `--record` is the step that makes the cached gate real, and
it is opt-in so a nightly job cannot quietly replace a file with a different provenance.

The live suite is guarded three times over, and the order matters. The guard that actually holds is its
**filename** — `eval/golden.eval.live.contract.ts` cannot be matched by any discovery rule in this repository,
the same trick `packages/vi-client` uses for `contract/at-m4.contract.ts`. The `exclude` in
`packages/compiler/vitest.config.ts` and the suite's own `describe.skipIf` without a key are the second and
third. The exclude alone is **not** enough, and that was measured rather than assumed: with the suite named
`*.test.ts`, `pnpm test` at the root collected it *despite* the exclude, because `vitest.workspace.ts` does its
own discovery with its own defaults. Three guards because the failure mode of losing one is a bill rather than a
broken build.

Both runners print per-field accuracy and the exact-match rate plus every failing case with its text and what
came back. A gate that reports one number tells you nothing about *which* limit moved.

## Verification

```
pnpm --filter @countersign/compiler typecheck
pnpm --filter @countersign/compiler lint
pnpm --filter @countersign/compiler test
node scripts/check-money-discipline.mjs
```

## Deviations from §8.8, and why

| Deviation | Reason |
|---|---|
| `CompiledMandate.expiresAtEpochSec` and `.currency` are not in §8.8's listing | The read-back example is "Expires **Fri 9 Oct, 11:59 PM IST**", and a date cannot be rendered from a duration without reading a clock. Putting the instant on the compiled value is what lets `readBack` stay pure. `currency` is EC-FX-1's subject; leaving it implicit in a constraint the caller must go looking for would be worse. |
| Constraint money is `bigint`, not `number` | §8.8 writes `min?: number` because the Python library emits JSON integers. In this process a `bigint` makes `max / 100` a compile error, which is EC-FX-6's guarantee rather than a convention. `toJsonSafe` converts at the boundary. |
| `budget.max` is synthesised from `amount_range.max` when the model gives only a per-payment cap | §8.8 AT-M8.2 requires it. `amount_range` is per payment and library-checked; `budget` is cumulative and Gate-checked. Without the synthesis, "under 130 dollars" would authorise $130 ten times. The synthesis only ever *reduces* authority. |
| `llmProposalSchema` is flat, not the eight-type union | The model picks ids and decimal strings; `localiseProposal` builds the constraints. A model that cannot spell `mandate.payment.agent_recurrence` correctly should fail at a schema it can satisfy, with a repair turn, rather than at `l2/prepare` behind a consent screen. The flat shape is also exactly what AT-M8.1 scores. |
| Optional constraint fields are `.optional()`, not `.default(null)` | The fixture is `to_dict()` output, and `to_dict()` omits an unset optional field — `mandate.payment.budget` has no `min` key. A default would add a key the library never emits and break the field-for-field drift test. |
| TTL over 30 days is clamped with a stated assumption, not refused | §8.8's 30 days is a ceiling on what may be *signed*. Clamping downward only reduces authority; refusing sends a buyer who said "six months" to a form. The note means it is never silent. |
| A missing `recurrence.end_date` becomes `start_date + 24 months` | The library requires `end_date` on `agent_recurrence`, so omitting it would be a 422. The maximum horizon is the safe default — never a year, which would be a grant nobody asked for. |

Each of these belongs in `docs/DECISIONS.md`, which WP-08 was not permitted to write.
