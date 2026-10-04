# DECISIONS

Every deviation from `docs/spec/countersign-blueprint.md`, every fallback taken because reality
contradicted the spec, and every judgement call that a judge could reasonably challenge.

Format: date, decision, reason, evidence (links or command output). Newest at the bottom.

---

## D-000 — Repo layout follows spec §5 exactly

**Date:** 2026-10-04
**Decision:** Adopt the spec's tree verbatim (`apps/web`, `apps/worker`, `apps/vi`,
`packages/{core,db,paypal,vi-client,gate,orders,ledger,webhooks,agent,compiler,defender,evidence-pdf,privacy,evals}`).
**Reason:** The blueprint's module contracts (§8) and work plan (§15) reference these paths by name.
**Evidence:** `docs/spec/countersign-blueprint.md` §5.

## D-001 — Spec is committed under `docs/spec/`, not the repo root

**Date:** 2026-10-04
**Decision:** Moved `countersign-blueprint.md` / `.pdf` to `docs/spec/`.
**Reason:** The spec's own §5 tree lists `docs/` for documentation; keeping the root clean avoids
two 155 KB/2.5 MB files sitting next to `package.json`.
**Evidence:** AGENTS.md links the new path.

## D-002 — pnpm `minimumReleaseAge` exemption for four hand-verified pins

**Date:** 2026-10-04
**Decision:** Keep pnpm 12's default supply-chain policy (`minimumReleaseAge: 1440`, one day) but
exempt `pg-boss`, `next`, `zod` and `vitest` in `pnpm-workspace.yaml`.
**Reason:** pnpm 12 refuses to install a version published within the last day. `pg-boss@12.36.0`
(D12, §4) was published `2026-10-02T20:39Z`, 41 minutes inside this repo's cutoff window, so a plain
`pnpm install` failed with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`. Those versions were verified by
hand (D-003), so the policy is relaxed for exactly the pins the spec requires and left in force for
everything else.
**Evidence:**

```
$ pnpm install
 ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION
 ╰─▶ 1 lockfile entries failed verification: pg-boss@12.36.0 was published at
    2026-10-02T20:39:00.000Z, within the minimumReleaseAge cutoff
```

## D-003 — Every pinned version in spec §4 re-verified against the registry (2026-10-04)

**Date:** 2026-10-04
**Decision:** Re-ran `npm view <pkg>@<pinned>` for all 26 npm pins and hit PyPI's JSON API for the 6
Python pins rather than trusting the spec's §22.1 ledger. All resolved to the exact pinned version.
The pinned Verifiable Intent commit was confirmed via the GitHub API.
**Reason:** The brief requires that PayPal endpoints, package names and API fields be verified rather
than invented. Package availability is the same class of claim.
**Evidence:**

```
next@16.3.8 => 16.3.8        ai@7.0.127 => 7.0.127          zod@4.6.5 => 4.6.5
react@19.3.0 => 19.3.0      @ai-sdk/openai@4.0.83 => 4.0.83 @ai-sdk/mcp@2.0.66 => 2.0.66
mcp-handler@2.2.0 => 2.2.0  @modelcontextprotocol/server@2.3.0 => 2.3.0
drizzle-orm@0.45.3 => 0.45.3  drizzle-kit@0.31.11 => 0.31.11  postgres@3.4.9 => 3.4.9
pg-boss@12.36.0 => 12.36.0  iron-session@9.0.1 => 9.0.1      jose@6.2.12 => 6.2.12
@react-pdf/renderer@4.9.0 => 4.9.0  qrcode@1.5.4 => 1.5.4    vitest@5.0.3 => 5.0.3
@playwright/test@1.63.0 => 1.63.0  pnpm@12.8.1 => 12.8.1    typescript@5.9.3 => 5.9.3
fastapi 0.142.2 present=True   uvicorn 0.54.0 present=True    pydantic 2.13.5 present=True
pytest  9.1.1   present=True   httpx   0.28.1 present=True   cryptography 50.0.2 present=True

$ GET api.github.com/repos/agent-intent/verifiable-intent/commits/356c29635f1c44df7de02edb58699ca9f29bece6
sha=356c29635f1c44df7de02edb58699ca9f29bece6  date=2026-04-20  msg="Merge pull request #23 from agent-intent/fix/field-alignment-v2"
```

https://github.com/agent-intent/verifiable-intent

## D-004 — Monorepo TypeScript uses `moduleResolution: Bundler`, not `NodeNext`

**Date:** 2026-10-04
**Decision:** `tsconfig.base.json` uses `module: ESNext` + `moduleResolution: Bundler`.
**Reason:** Every package here is consumed as TypeScript **source** by the tool that runs it (vitest,
Next, tsx), so extensionless relative imports are correct. `NodeNext` requires `./errors.js` in every
relative import, and — more damaging — silently degrades any specifier it cannot resolve to `any`
instead of erroring. That turned every money helper into `any` in `packages/core` until it was
caught. Packages now emit declarations only (`emitDeclarationOnly`), so there is no emitted-import
problem.
**Evidence:** with `NodeNext`, `pnpm --filter @countersign/core typecheck` reported no errors while
`allocate()` was returning `any`; after switching to `Bundler` the same command surfaced 5 genuine
type errors (`verbatimModuleSyntax` violations, a `zod` v4 `errorMap` change, and a `ppAmountSchema`
refine that hardcoded USD instead of reading `currency_code` — a real bug, since `"500.00"` is valid
USD and invalid JPY).

## D-005 — `csError` takes `details` as its third parameter, not merged options

**Date:** 2026-10-04
**Decision:** `csError(code, message, details?, options?)`.
**Reason:** With a single merged options object typed `{ userMessage?, retryable?, details?, cause? }`,
every natural call site (`csError('CS_ROUNDING', '…', { value: v })`) compiles, throws the right code,
and **silently loses the details** — because `value` is not `details`. This happened during WP-01 and
was caught only because a test asserted on `e.details.value`. Splitting the parameters makes the
mistake impossible to express.
**Evidence:** `packages/core/test/core.test.ts` → "AT-M1.2 … → expected undefined to be '1.005'".

## D-006 — Name redaction in logs is field-based, and the README says so

**Date:** 2026-10-04
**Decision:** The logger redacts credential-looking keys and PII keys (`display_name`, `payer_email`,
`address`, …) plus emails/card numbers/phone numbers/JWTs **by value in free text**. It does **not**
attempt to detect a person's name inside a `msg` string, and the README and tests state that limit.
**Reason:** Spec AT-M19.2 asks for "logs contain no email or full name (regex test)". Emails are
genuinely catchable by shape. A person's name is not catchable by any honest pattern — a regex that
claimed to would produce false confidence in a privacy control. The enforceable rule is "names go in
a named field, never in the message string", and `PII_KEYS` enforces that half.
**Evidence:** `packages/core/src/logger.ts` docstring; test
"EC-PRIV-3 AT-M19.2 regex test: no logged field value contains an email".

## D-007 — Two error codes added to the §8.1 registry, and `attempt` now defaults to `CS_INTERNAL`

**Date:** 2026-10-04 · **Raised by:** WP-03 building `apps/vi`
**Decision:** Add `CS_RATE_LIMITED` and `CS_INTERNAL` to `CS_ERROR_CODES`. Change `toCsError` and
`attempt`'s fallback code from `CS_VALIDATION` to `CS_INTERNAL`.
**Reason:** §8.0 rule 3 says every code must come from the §8.1 registry, but the registry has no code
for two situations the system genuinely hits:

1. **Our own rate limiter.** `apps/vi` must rate-limit `GET /v1/jwks` and `POST /v1/public/verify` to
   30 req/min/IP (§8.3). The agent's first choice was `PP_RATE_LIMITED`, which is **actively
   misleading**: that code's user-facing copy says "PayPal is asking us to slow down", and it would
   tell a buyer that PayPal is throttling us when the constraint is entirely ours. Reusing a payment
   rail's error code for a local control is exactly the kind of thing a judge reading the code would
   flag, and rightly.
2. **An unhandled fault.** With no code for "this is our bug", a 500 was being reported to users as
   `CS_VALIDATION` — "some of that information is not valid, please check and try again". That sends
   a buyer off to fix input that was never wrong, and it makes real incidents invisible in metrics
   because they are counted as user errors.

`CS_RATE_LIMITED` is `retryable: true` (a client that backs off will succeed);
`CS_INTERNAL` is `retryable: false` (a blind retry of a 500 usually reproduces it).
**Evidence:** `packages/core/src/errors.ts`; tests `D-007 …`.
This is a deliberate, recorded deviation from a spec-owned registry (AGENTS.md: never diverge silently).

## D-008 — `toBody` scrub list widened; `_` is a word character

**Date:** 2026-10-04 · **Raised by:** WP-03, which ran a stricter superset than core
**Decision:** Widen `NEVER_SERIALISE` in `packages/core/src/errors.ts` to also drop `key`, `kid`,
`client_id`, `session_id` anywhere in a `details` key.
**Reason:** Two separate bugs, one root cause. `_` is a **word character** in JavaScript regex, so
`\btoken\b` does not match `access_token` and `\bkey\b` does not match `signing_key`. An earlier
version of the file used word boundaries on both sides and silently passed `access_token` and
`signing_key` straight through to the HTTP response. The correct shape is **unanchored on the left,
`\b`-terminated on the right**, which catches compound names while still not matching `keyword`.
Adopted a deliberately stricter rule than core had, because a client cannot depend on a field being
present in an error body.
**Evidence:** two tests, `toBody strips a cause or stack…` and `D-008 toBody also drops api_key…`.
The second exists purely because the first fix was wrong in exactly the same way.

## D-009 — `verify_chain` has no clock override, so `at_time` is reported as not honoured

**Date:** 2026-10-04 · **Raised by:** WP-03 · **Spec item:** §8.3 `at_time`, EC-TIME-3
**Decision:** `/v1/verify` accepts `at_time` but returns the verdict it **actually performed at `now`**,
plus `at_time_not_honoured: true`, the verbatim reason, and an `at_time_check` block containing our
own iat/exp window evaluation clearly labelled _advisory_.
**Reason:** `verification/chain.py` at the pinned commit hardcodes `now = int(time.time())` with no
parameter to override it (verified in the installed source before writing any code). So an honest
as-of-capture-time verification is **impossible**, not merely unimplemented.
The alternative — computing a plausible as-of verdict ourselves and returning it — would put an
unverifiable claim into an evidence packet that a merchant files with PayPal and a judge re-verifies
publicly. A fabricated answer in that position is far worse than a flagged gap. Returning the real
verdict plus an explicit, machine-readable flag means the Gate and the Defender can decide what to do
with it, and a reader can see the limitation.
**Evidence:** `apps/vi/.venv/…/verification/chain.py:166` — `now = int(time.time())`.
**Consequence:** EC-TIME-3 cannot be fully closed in sandbox. Recorded in `docs/edge-cases.json`
with `status: blocked` and the reason. Raised for upstream in `docs/HUMAN_TODO.md` H-08.

## D-010 — Three places the pinned VI library's real behaviour differs from spec §8.3

**Date:** 2026-10-04 · **Raised by:** WP-03 · **Pinned commit:** `356c29635f1c44df7de02edb58699ca9f29bece6`
**Decision:** adapt to the library, and document each divergence in code comments and in the
vi-service README.

1. **`/v1/l2/finalize` must return the finished SD-JWT, not `header.payload.signature`.**
   In autonomous mode the two open mandates _are_ SD disclosures. Returning only three segments makes
   `verify_chain` fail with _"L2 delegate_payload resolved zero mandate disclosures"_. The spec's
   route table `{l2}` is correct only when read as the complete SD-JWT.
2. **`UserMandate.prompt_summary` is silently dropped.** The field exists on the model, but
   `create_layer2_autonomous` never reads it, so it reaches neither the payload nor the disclosures.
   §8.3 lists it in the `l2/prepare` request. The service accepts it and must **not** present it to a
   user as signed content. A test asserts this so the day upstream fixes it, the test fails loudly
   rather than the UI quietly starting to over-promise.
3. **`check_constraints` lists `budget` / `recurrence` / `agent_recurrence` in `checked` while
   evaluating none of them** (its own comment says "Network-enforced constraints"). Passing that
   through would tell the Gate its job is done. The service moves them to `skipped` with that exact
   reason, so the Gate knows what it still owes — which is the whole point of spec D19.

Two smaller ones, handled inline: `resolve_disclosures` does **not** resolve the standalone
merchant/item disclosures, so constraint SD-refs must be resolved explicitly or `allowed_payees`
degrades to a pass on an unchecked constraint; and `es256_verify` returns `False` rather than raising
on a wrong-length signature, so the 64-byte length is enforced explicitly.
**Evidence:** all read from the installed source at the pinned commit; see the docstrings in
`apps/vi/src/vi_service/{l2,l3,verify,checkout_jwt}.py` and `tests/test_constraints_fixture.py`.

## D-011 — `l3_jti` is derived, not read from the L3

**Date:** 2026-10-04 · **Raised by:** WP-03 · **Spec item:** §7.2 `checkout_attempts.l3_jti` UNIQUE
**Decision:** `jti` = base64url SHA-256 of the L3a issuer JWT.
**Reason:** The L3 payload the library produces has **no `jti` claim**, but §7.2 requires a unique
`l3_jti` and §8.10 check 7 uses it as the replay defence (EC-IDEM-1, EC-MER-2). Deriving it from the
signed token gives the two properties that matter: it is content-bound (a mutated L3 has a different
replay id) and it is **deterministic** (a retried request produces the same id, so an idempotent
retry cannot consume its own replay protection). A random `jti` per attempt would have the opposite
behaviour.
**Evidence:** `apps/vi/src/vi_service/l3.py`.

---

## PayPal API verification (WP-06) — D-012 … D-016

Everything below was found by auditing `packages/paypal` against PayPal's **published OpenAPI
specs** and `developer.paypal.com`, not against prose memory. The audit is 33 questions with 31
concrete corrections, kept verbatim at `docs/verification/paypal-api-2026-10-04.md`.

### D-012 — Four sandbox-simulator request bodies were fabricated; corrected from the test-go-live page

**Date:** 2026-10-04
**Decision:** Rewrite the simulator bodies to match PayPal's documented forms. Specifically:

- `POST /v1/customer/disputes` is **not in the OpenAPI at all**. Per the test-go-live page it is
  `multipart/form-data` with one `input` JSON part holding
  `disputed_transactions[{buyer_transaction_id}]`, `reason`, `dispute_amount`, `extensions`. The code
  sent `transaction_id` / `dispute_reason` as JSON — **neither field exists**.
- `POST /v2/customer-support/process-chargeback` needs `adjacency:"PAYPAL"`, `file_layout:"ATCK_CB"`,
  `merchant_id`, `financial_institution.processor:"FDMS"`, `transaction.{id_enc,amount}`,
  `instrument.instrument_type:"CARD"`, `dispute{}`. It returns **201 with a body**.
- `accept-offer` takes `{note}`, not `{payer_note}` — and **202 Accepted is a success**, because the
  refund's money movement is deliberately delayed.
- `change-reason` is `multipart/related` with an `input` part `{reason, note, item_info[]}`.

**Reason:** These calls only run in sandbox during a judge's demo. A fabricated field name there
produces a bare 400 in the middle of Judge Mode scenario J3, which is the single most important
moment of the submission. This is precisely the failure the brief's "never invent a PayPal endpoint,
package name, or API field" rule exists to prevent, and it happened anyway because the first pass
trusted a secondary source. The audit read the machine-readable specs from
`raw.githubusercontent.com/paypal/paypal-rest-api-specifications` (Disputes 1.12, Payments 2.12,
Orders 2.32, Vault 3.4, Notifications 1.11) rather than the rendered docs.

**Where PayPal's own documentation is incomplete, the choice made was the conservative one:**

- `change-reason` is sent as `multipart/form-data`, not `multipart/related`, because `fetch` +
  `FormData` cannot produce `multipart/related` without hand-writing the boundary — and a guessed
  boundary is a bare 400. Identical part name and payload. Recorded as an open probe item.
- `accept_claim_type` is described in prose but **absent from the OpenAPI request body**. Kept, marked
  as the one item only a sandbox probe can settle.
  **Evidence:** `docs/verification/paypal-api-2026-10-04.md` items 1, 27, 30, 12.

### D-013 — The dispute→capture join key is `disputed_transactions[].seller_transaction_id`

**Date:** 2026-10-04
**Decision:** `packages/paypal` exposes `disputeCaptureId(d)`, reading
`disputed_transactions[0].seller_transaction_id`. The Defender's ingest must use it.
**Reason:** The code read `seller_transaction_id` from the **top level** of the dispute resource.
PayPal sends it only inside `disputed_transactions[]`. This is not cosmetic: that id is the join key
from a dispute back to the capture we authorized (spec §7.2, R-REF-1 / R-DSP-\*). Reading the wrong
path returns `undefined`, and a Defender that maps a dispute to no capture lands on R-NOCHAIN-1 and
tells the merchant "No mandate on this payment. Countersign can't help here" — a **false and
business-damaging** answer, on exactly the case the product exists to win.
Also renamed in the response schema: `dispute_reason` → `reason`, `disputed_amount` →
`dispute_amount`, `messages[].sender` → `messages[].posted_by`.
**Evidence:** audit item 5; test `joins a dispute to our capture through disputed_transactions[0].seller_transaction_id`.

### D-014 — Appeal eligibility is gated on a HATEOAS link, not on `dispute_state`

**Date:** 2026-10-04
**Decision:** `isAppealable(d)` checks for the **`appeal` link** in the dispute's HATEOAS `links`,
with `dispute_state === 'APPEALABLE'` kept as a secondary signal only.
**Reason:** Spec §8.16 / §12.11 EC-DSP-6 gate the appeal on `dispute_state = APPEALABLE`. The value
is real, but PayPal states twice, in both the API reference and the disputes guide, that _eligibility
is signalled by the presence of the `appeal` link_: "If this link does not appear, you cannot appeal
the dispute." So `APPEALABLE` alone can be true while an appeal would be rejected. Gating on the
authoritative signal costs one extra `GET` and prevents filing an appeal PayPal refuses.
**Evidence:** audit item 17; `https://developer.paypal.com/platforms/disputes/handle-disputes/use-disputes-api`.

### D-015 — Two §8.6 sandbox method signatures changed to options objects

**Date:** 2026-10-04 · **Deviation from the spec's §8.6 class listing**
**Decision:**

```
sandbox.processChargeback(sellerTxnId, reason)  ->  sandbox.processChargeback(opts: ProcessChargebackOpts)
sandbox.changeReason(id, reason)                 ->  sandbox.changeReason(id, body: ChangeReasonBody)
```

**Reason:** PayPal's documented bodies require facts that do not fit two positional arguments:
`merchant_id` (our Business account), `transaction.amount`, `financial_institution.processor`, and
`item_info[]`. Neither value can be inferred by the client, and inventing defaults for them would be
the same fabrication D-012 is about. The old signatures cannot express the real contract, so the
contract wins and the deviation is recorded here.
Also: `usage_pattern: 'SUBSCRIPTIONS'` was an invented value — the real values are
`SUBSCRIPTION_PREPAID` / `SUBSCRIPTION_POSTPAID`. The code now sends `IMMEDIATE`, which is what
PayPal's own one-shot vault example uses for spec D17's capture.

### D-016 — Two webhook events do not exist, which changes the reconciler's design

**Date:** 2026-10-04 · **Spec item:** §8.12 subscribed events, EC-WH-1, EC-TIME-5
**Decision:**

1. **`PAYMENT.REFUND.COMPLETED` does not exist.** Refund completion is `PAYMENT.CAPTURE.REFUNDED`.
   Removed from the event list; `PAYMENT.CAPTURE.DENIED` (documented, and PayPal-recommended for the
   checkout flow) added.
2. **There is no `PAYMENT.AUTHORIZATION.EXPIRED` event.** Therefore EC-TIME-5's authorisation-expiry
   alerting **cannot be webhook-driven** and must poll `GET /v2/payments/authorizations/{id}` and
   compare `expiration_time`.

**Reason:** Spec §8.12 lists `PAYMENT.REFUND.PENDING/FAILED` and `CHECKOUT.PAYMENT-APPROVAL.REVERSED`
among the subscribed events; neither exists under those names. A subscription to a non-existent event
silently never fires, and spec §8.12's own doctrine is that **state comes from re-fetching PayPal,
never from the payload** — so the reconciler is the real safety net and the event list is only a
latency optimisation. Knowing which events are fictional changes what the reconciler must cover, and
a cron that assumes a webhook will tell an expired authorisation to a buyer is a wrong statement
about money.
**Evidence:** audit items 14 and 26; `components/event_names` in the PayPal OpenAPI specs.

## D-017 — How `docs/EDGE_CASES.md` decides what "covered" means

**Date:** 2026-10-04
**Decision:** Three statuses, enforced by `scripts/ec-coverage.mjs`:

| Status    | Meaning                                                                                   | Gate                             |
| --------- | ----------------------------------------------------------------------------------------- | -------------------------------- |
| `done`    | handling exists **and** a test exercises it **and** nothing else is owed                  | counts as covered                |
| `wip`     | a real test exists for the part that is built, but the owning work package has not landed | not covered; reported separately |
| `blocked` | cannot be done in sandbox; `blockedReason` is **required**                                | allowed to be uncovered          |

Anything else uncovered fails CI. Two supporting decisions matter more than the table:

1. **An EC reference only counts if it appears inside a test body** — between one test declaration and
   the next. An earlier version credited a 2-line lookbehind, which meant an EC id mentioned in a
   file header or an import block counted as coverage. A ledger that overstates itself is worse than
   no ledger, because §14's SLOs and the README's eval table are meant to be checkable by a judge.
2. **`gen-edge-cases.mjs --check` compares only the spec-derived fields**, not `status`/`notes`/
   `blockedReason`. Those three are hand-maintained, so a whole-file comparison would make the
   staleness gate fail forever the moment a human did the job the file exists for — which trains
   people to ignore the gate. The check now asks the only question that matters: _does the spec still
   say what the catalogue says it says?_ Verified by temporarily editing the spec and confirming the
   check fires on exactly the changed row.

**Current state:** 38 of 109 cases have a referencing test — 24 `done`, 15 `wip`, 1 `blocked`
(EC-TIME-3, see D-009). The other 71 are unclaimed. Every `wip` note names the work package that owes
the rest, so the ledger doubles as the queue for WP-21.

## D-018 — The Gate LLM ban is an ESLint rule, not a convention

**Date:** 2026-10-04
**Decision:** `eslint.config.mjs` applies `no-restricted-imports` to `packages/gate/**/*.ts`, banning
`ai`, `@ai-sdk/*`, `openai` and `@anthropic-ai/*`, with a message pointing at spec §8.10.
**Reason:** Core invariant I-1 (§3.1) is that no money moves without a Gate `ALLOW`, and §8.10 says
"**No LLM** anywhere in M10". That is the project central claim, and a line in a README is not a
control — the first well-meaning refactor that reaches for a model to "make the Gate smarter" would
silently make the product core claim false. A lint error makes that impossible to merge.
**Honest limit:** this is a _direct-import_ control. An LLM reached by reflection, or through a
package that wraps one, would not be caught. The mitigation is that `packages/gate` dependency list
is reviewed alongside this rule, and that `jose` — the only crypto dependency — has no transitive
runtime dependency that could pull in a model client.
**Evidence:** `eslint.config.mjs` `GATE_LLM_BAN`. The rule is active in `pnpm lint` today; the Gate
package is still a stub, so the ban gets its first real exercise in WP-10 — which is exactly why the
WP-10 reviewer should check it rather than assume it.

## D-019 — `constraints.skipped` is `{type, reason}[]`, because a string array silently disarms spec D19

**Date:** 2026-10-04 · **Raised by:** WP-04 building the vi-client · **Spec item:** D19, §8.10 check 8
**Decision:** `/v1/verify` returns `constraints.skipped` as a list of `{type, reason}` objects rather
than a list of strings. `packages/vi-client` accepts either wire shape but **transforms to the
object**.

**Reason — this is the most dangerous shape bug found so far, and it was found by the consumer
rather than the producer.** The library appends `budget`, `recurrence` and `agent_recurrence` to
`checked` while evaluating none of them (its own source comment calls them "Network-enforced"), so
vi-service moved them into `skipped`. But it appended a _reason_ to each entry:

```
"mandate.payment.budget — Network-enforced constraints. Not evaluated by verifiable_intent; …"
```

A Gate implementing check 8 naturally writes:

```ts
if (!verify.constraints.skipped.includes('mandate.payment.budget')) {
  /* nothing to enforce */
}
```

That expression is **`false` while a user-signed budget cap sits unevaluated**, so the Gate concludes
it owes nothing and allows the purchase. Spec **D19** exists precisely because the reference library
does not check budgets; that one array shape would have undone the single most important
deterministic check in the product, and it would have failed **open** — in favour of spending.

**Why the fix is split across wire and type.** The schema accepts both shapes so that parsing a
vi-service which has not been redeployed does not _throw_ — a throw there fails the Gate's verify
step, which is worse than a missing field. But the schema ends in `.transform()`, and that is the
load-bearing part: a plain `z.union` types the element as `string | {…}`, and `(string | Obj)[]
.includes(string)` **still compiles**. The transform makes the output type `{type, reason}`, so the
mistaken `includes` becomes a **type error**. The claim that a union alone would prevent the bug was
wrong, was written into a comment, and was caught by making the test actually exercise it — the test
now carries `@ts-expect-error`, which fails to compile if the transform is ever removed.

**Evidence:** `apps/vi/src/vi_service/models.py::SkippedConstraint`,
`apps/vi/tests/test_verify.py::test_skipped_entries_are_objects_not_strings`,
`packages/vi-client/test/types.test.ts` → "makes `includes` a compile error".

**Consequence for WP-10:** the Gate must call `pendingNetworkEnforcement(skipped)` from
`@countersign/vi-client` and treat a non-empty result as an obligation, not as information. It must
never read `constraints.satisfied` as covering a network-enforced constraint.

## D-020 — M9's logic ships inside `packages/gate`, because splitting it creates a dependency cycle

**Date:** 2026-10-04 · **Raised by:** WP-09 and WP-10 built together · **Spec item:** §5, §8.9, §8.10
**Decision:** The **logic** of spec §8.9 (catalog, cart arithmetic, price lock, checkout session, stock,
MCP tool schemas) lives in `packages/gate/src/merchant/`. The **HTTP surface** — `apps/web/api/checkout`
and the MCP route — stays in `apps/web`, as §5 says it should, and each handler is a few lines over these
functions. Nothing in `apps/web` is written yet; WP-17's UI and WP-14's MCP route consume these exports.

**Reason — two things forced it, and the second is the one that matters.**

1. **The price lock is a shared value, not a shared idea.** Gate check 5 binds the L3b to
   `checkout_sessions.checkout_hash` and check 6 compares `price_lock_exp` against the one
   `clock.nowSec()`. Those two checks and the `create_checkout` that _produces_ both values cannot live
   in different packages without one importing the other, because the Gate must verify a value the
   catalog produced and neither can own a private copy of it. A cycle between the policy engine and the
   catalog that prices its inputs is not a layering, it is a knot — and a knot in a payments path is
   exactly where §8.0 rule 8 says to stop behind an interface instead.
2. **The parts with bugs in them are not the parts that need Next.** The price-lock arithmetic, the
   `untrusted_text` wrapper and the last-unit stock race have no HTTP in them. Shipping them inside a
   route handler would have meant testing them through a Next server; §5's tree is a placement of _routes_,
   not a statement that price-lock arithmetic belongs in a React app.

**Honest limit:** §5's tree is now not literally true for M9's logic, and this is a deviation from the
blueprint rather than a reading of it. What is preserved is the property §5 was expressing — the merchant
catalog is not part of the decision engine — by keeping every §8.9 operation behind the
`MerchantCatalogStore` / `MerchantCheckoutStore` ports, so `apps/web` can implement them over Postgres
without this package ever knowing about a table it does not own. `packages/ledger` stayed a separate
package (D-000's tree is kept for it) because it has no cycle risk: it depends on `packages/db` only.

**Evidence:** `packages/gate/src/merchant/index.ts` (module header states both reasons);
`packages/gate/test/merchant.test.ts` — AT-M9.1–AT-M9.4, 34 tests, no Next and no database;
`packages/gate/src/checks.ts` checks 5 and 6 read the values `merchant/` writes;
`packages/gate/README.md` §"§8.9".

**Also recorded here, because it is the kind of thing that gets lost:** while building check 9, a real
off-by-one was found in `walletCapCheckIn` (`packages/db/repos/budget.ts`, WP-02) — it adds the current
attempt's RESERVE entry into the spend it compares against, so the effective wallet cap is `cap − cart`.
Per AGENTS.md rule 8 this package does not edit that file; `packages/gate/test/budget.test.ts` pins the
observed behaviour next to the intended value, so WP-02's fix shows up as exactly one failing assertion.
